/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { arch, availableParallelism, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { parseArgs } from "node:util";

import { AI_VERSIONS } from "../ai";
import ABILITIES_JSON from "../configuration/abilities.json";
import CREATURES_JSON from "../configuration/creatures.json";
import { FightStateManager } from "../fights/fight_state_manager";
import { PBTypes } from "../generated/protobuf/v1/types";
import {
    DEFAULT_AMOUNT_BY_LEVEL,
    DEFAULT_ROSTER_COMPOSITION,
    STACK_EXPERIENCE_BUDGET,
    creaturesByLevel,
    resolveStackAmount,
    type IArmyUnitSpec,
} from "./army";
import { runMatch, type IDecisionObservation, type IMatchConfig, type IMatchResult, type Side } from "./battle_engine";
import { liveTwinSetup } from "./livetwin";
import {
    readRevisionProvenance,
    type IClusterMoments,
    type IIntegrityStats,
    type IPairClusterStats,
    type IRevisionProvenance,
} from "./v0_7_acceptance";

export const V07_ARCHETYPE_PROTOCOL = {
    schemaVersion: 1,
    candidate: "v0.7",
    opponents: ["v0.6", "v0.4"] as const,
    gamesPerCell: 3000,
    champion: "v0.6",
    strongArchetypeWinRate: 0.54,
    transitivityOpponent: "v0.4",
    archetypeConfidenceFloor: 0.5,
    templateMinWinRate: 0.5,
    templateConfidenceFloor: 0.48,
    candidateRejectionLimit: 0,
    confidenceLevel: 0.95,
} as const;

export const V07_ARCHETYPES = ["mage", "meleeMage", "aura", "ranged"] as const;
export type V07Archetype = (typeof V07_ARCHETYPES)[number];

export const V07_ARCHETYPE_TEMPLATE_NAMES = [
    "mage_frontline",
    "mage_fireline",
    "melee_magic_utility",
    "melee_magic_brawler",
    "aura_support",
    "aura_offense",
    "ranged_precision",
    "ranged_control",
] as const;
export type V07ArchetypeTemplateName = (typeof V07_ARCHETYPE_TEMPLATE_NAMES)[number];
export type V07ArchetypeOpponent = (typeof V07_ARCHETYPE_PROTOCOL.opponents)[number];

interface IRawCreatureConfig {
    abilities?: string[];
}

interface IRawAbilityConfig {
    aura_effect?: unknown;
}

export interface IV07ArchetypeTaxonomy {
    mage: readonly string[];
    meleeMage: readonly string[];
    aura: readonly string[];
    ranged: readonly string[];
}

function rawCreatureConfigs(): Map<string, IRawCreatureConfig> {
    const configs = new Map<string, IRawCreatureConfig>();
    const raw = CREATURES_JSON as unknown as Record<string, unknown>;
    for (const group of Object.values(raw)) {
        if (!group || typeof group !== "object") continue;
        for (const [name, config] of Object.entries(group as Record<string, IRawCreatureConfig>)) {
            configs.set(name, config);
        }
    }
    return configs;
}

/**
 * v0.7 preregistration freeze: the archetype battery was preregistered when ANGEL=40 was the last
 * catalog id. Creatures enabled later (Abomination onward) are excluded so the taxonomy — and every
 * historical manifest that pins its sha256 (composed-ladder taxonomySha256) — stays stable.
 */
const V07_CATALOG_MAX_CREATURE_ID: number = PBTypes.CreatureVals.ANGEL;

const creatureEnumId = (creatureName: string): number =>
    (PBTypes.CreatureVals as unknown as Record<string, number>)[creatureName.toUpperCase().replace(/ /g, "_")] ?? 0;

/** Trait sets are derived from the enabled PB-enum catalog, never from unreleased JSON-only creatures. */
export function classifyEnabledV07ArchetypeCreatures(): IV07ArchetypeTaxonomy {
    const enabled = [1, 2, 3, 4]
        .flatMap((level) => creaturesByLevel(level))
        .filter((entry) => creatureEnumId(entry.creatureName) <= V07_CATALOG_MAX_CREATURE_ID);
    const configs = rawCreatureConfigs();
    const abilities = ABILITIES_JSON as unknown as Record<string, IRawAbilityConfig>;
    const names = (predicate: (entry: (typeof enabled)[number]) => boolean): string[] =>
        enabled
            .filter(predicate)
            .map((entry) => entry.creatureName)
            .sort();
    return {
        mage: names((entry) => entry.attackType === "MAGIC"),
        meleeMage: names((entry) => entry.attackType === "MELEE_MAGIC"),
        aura: names((entry) =>
            (configs.get(entry.creatureName)?.abilities ?? []).some(
                (ability) => abilities[ability]?.aura_effect !== null && abilities[ability]?.aura_effect !== undefined,
            ),
        ),
        ranged: names((entry) => entry.attackType === "RANGE"),
    };
}

export const V07_ARCHETYPE_TAXONOMY = classifyEnabledV07ArchetypeCreatures();

interface ITemplateDefinition {
    archetype: V07Archetype;
    creatureNames: readonly [string, string, string, string, string, string];
    purpose: string;
}

const TEMPLATE_DEFINITIONS: Readonly<Record<V07ArchetypeTemplateName, ITemplateDefinition>> = {
    mage_frontline: {
        archetype: "mage",
        creatureNames: ["Squire", "Berserker", "Healer", "Satyr", "Crusader", "Hydra"],
        purpose: "Healer and Satyr behind a durable melee screen.",
    },
    mage_fireline: {
        archetype: "mage",
        creatureNames: ["Arbalester", "Centaur", "Healer", "Satyr", "Cyclops", "Tsar Cannon"],
        purpose: "Healer and Satyr supporting an all-ranged damage line.",
    },
    melee_magic_utility: {
        archetype: "meleeMage",
        creatureNames: ["Peasant", "Wolf Rider", "Harpy", "Valkyrie", "Ogre Mage", "Angel"],
        purpose: "Castling, Wind Flow, Riot, and Resurrection utility pressure.",
    },
    melee_magic_brawler: {
        archetype: "meleeMage",
        creatureNames: ["Squire", "Berserker", "Troll", "Harpy", "Ogre Mage", "Behemoth"],
        purpose: "Wild Regeneration and mass-buff brawling pressure.",
    },
    aura_support: {
        archetype: "aura",
        creatureNames: ["Peasant", "Leprechaun", "White Tiger", "Valkyrie", "Griffin", "Pegasus"],
        purpose: "Defensive, control, and all-army aura coverage.",
    },
    aura_offense: {
        archetype: "aura",
        creatureNames: ["Wolf Rider", "Leprechaun", "White Tiger", "Valkyrie", "Crusader", "Angel"],
        purpose: "Movement, melee-damage, pressure, and ranged-defense auras.",
    },
    ranged_precision: {
        archetype: "ranged",
        creatureNames: ["Arbalester", "Centaur", "Elf", "Medusa", "Cyclops", "Tsar Cannon"],
        purpose: "Precision, multi-shot, control, and siege ranged play.",
    },
    ranged_control: {
        archetype: "ranged",
        creatureNames: ["Orc", "Arbalester", "Beholder", "Elf", "Cyclops", "Gargantuan"],
        purpose: "Control and splash ranged play with a different level-one screen.",
    },
};

export interface IV07ArchetypeTemplate {
    name: V07ArchetypeTemplateName;
    archetype: V07Archetype;
    purpose: string;
    roster: readonly IArmyUnitSpec[];
}

function exactRoster(creatureNames: readonly string[]): IArmyUnitSpec[] {
    const enabled = [1, 2, 3, 4].flatMap((level) => creaturesByLevel(level));
    return creatureNames.map((creatureName) => {
        const creature = enabled.find((entry) => entry.creatureName === creatureName);
        if (!creature) throw new Error(`Fixed v0.7 archetype roster contains disabled creature ${creatureName}`);
        return {
            faction: creature.faction,
            creatureName,
            level: creature.level,
            size: creature.size,
            amount: resolveStackAmount(creatureName, creature.level, DEFAULT_AMOUNT_BY_LEVEL, "expBudget"),
        };
    });
}

export const V07_ARCHETYPE_TEMPLATES: readonly IV07ArchetypeTemplate[] = Object.freeze(
    V07_ARCHETYPE_TEMPLATE_NAMES.map((name) =>
        Object.freeze({
            name,
            archetype: TEMPLATE_DEFINITIONS[name].archetype,
            purpose: TEMPLATE_DEFINITIONS[name].purpose,
            roster: Object.freeze(exactRoster(TEMPLATE_DEFINITIONS[name].creatureNames)),
        }),
    ),
);

export function v07ArchetypeTemplate(name: V07ArchetypeTemplateName): IV07ArchetypeTemplate {
    const template = V07_ARCHETYPE_TEMPLATES.find((candidate) => candidate.name === name);
    if (!template) throw new Error(`Unknown v0.7 archetype template ${name}`);
    return template;
}

export function rosterSignature(roster: readonly IArmyUnitSpec[]): string {
    return roster.map((unit) => `L${unit.level}:${unit.creatureName}x${unit.amount}`).join("|");
}

/** Fail at import time if catalog or balance-data changes silently invalidate the preregistered armies. */
export function validateV07ArchetypeTemplates(): void {
    const expectedLevels = DEFAULT_ROSTER_COMPOSITION.flatMap(({ level, count }) => Array(count).fill(level));
    for (const template of V07_ARCHETYPE_TEMPLATES) {
        if (template.roster.length !== expectedLevels.length) {
            throw new Error(`${template.name} must contain ${expectedLevels.length} stacks`);
        }
        if (new Set(template.roster.map((unit) => unit.creatureName)).size !== template.roster.length) {
            throw new Error(`${template.name} contains a duplicate creature`);
        }
        template.roster.forEach((unit, index) => {
            if (unit.level !== expectedLevels[index]) {
                throw new Error(`${template.name} slot ${index} must be level ${expectedLevels[index]}`);
            }
            const expectedAmount = resolveStackAmount(
                unit.creatureName,
                unit.level,
                DEFAULT_AMOUNT_BY_LEVEL,
                "expBudget",
            );
            if (unit.amount !== expectedAmount) {
                throw new Error(`${template.name} has stale exp-budget amount for ${unit.creatureName}`);
            }
        });
    }
    for (const archetype of V07_ARCHETYPES) {
        const covered = new Set(
            V07_ARCHETYPE_TEMPLATES.filter((template) => template.archetype === archetype).flatMap((template) =>
                template.roster.map((unit) => unit.creatureName),
            ),
        );
        const missing = V07_ARCHETYPE_TAXONOMY[archetype].filter((name) => !covered.has(name));
        if (missing.length) throw new Error(`${archetype} templates omit enabled trait units: ${missing.join(", ")}`);
    }
}

validateV07ArchetypeTemplates();

export interface IV07ArchetypeSeedManifest {
    schemaVersion: 1;
    manifestId: string;
    createdAt: string;
    candidate: string;
    opponents: string[];
    gamesPerCell: number;
    cells: Record<V07ArchetypeTemplateName, Record<V07ArchetypeOpponent, number>>;
    freshSeedsDeclared: boolean;
    declaration: string;
}

export interface IV07ArchetypeManifestProvenance {
    manifestId: string;
    createdAt: string;
    sourcePath: string;
    sha256: string;
    declaration: string;
}

export interface IV07ArchetypeBatteryOptions {
    candidate: string;
    opponents: readonly string[];
    gamesPerCell: number;
    seeds: Readonly<Record<V07ArchetypeTemplateName, Readonly<Record<V07ArchetypeOpponent, number>>>>;
    concurrency: number;
    seedsDeclaredFresh: boolean;
    seedManifest: IV07ArchetypeManifestProvenance | null;
}

export interface IV07ArchetypeCliOptions extends IV07ArchetypeBatteryOptions {
    outputPath: string;
    checkpointDir: string;
}

export interface IV07ArchetypeCellSpec {
    archetype: V07Archetype;
    template: V07ArchetypeTemplateName;
    candidate: string;
    opponent: string;
    baseSeed: number;
    games: number;
}

export interface IActionTelemetry {
    decisions: number;
    actionTypes: Record<string, number>;
    spells: Record<string, number>;
    creatures: Record<string, number>;
    creatureActions: Record<string, number>;
}

export interface IV07ArchetypeGameRecord {
    template: V07ArchetypeTemplateName;
    game: number;
    seed: number;
    candidateIsGreen: boolean;
    greenVersion: string;
    redVersion: string;
    roster: string;
    winner: Side | "draw";
    laps: number;
    endReason: IMatchResult["endReason"];
    decidedByArmageddon: boolean;
    rejectedGreen?: number;
    rejectedRed?: number;
    candidateTelemetry: IActionTelemetry;
    opponentTelemetry: IActionTelemetry;
}

function emptyTelemetry(): IActionTelemetry {
    return { decisions: 0, actionTypes: {}, spells: {}, creatures: {}, creatureActions: {} };
}

function increment(counts: Record<string, number>, key: string, amount = 1): void {
    counts[key] = (counts[key] ?? 0) + amount;
}

function observeDecision(telemetry: IActionTelemetry, observation: IDecisionObservation): void {
    telemetry.decisions += 1;
    const creature = observation.unit.getName();
    increment(telemetry.creatures, creature);
    for (const action of observation.incumbent) {
        increment(telemetry.actionTypes, action.type);
        increment(telemetry.creatureActions, `${creature}:${action.type}`);
        if (action.type === "cast_spell") increment(telemetry.spells, action.spellName);
    }
}

export interface IV07ArchetypeGameDependencies {
    matchRunner?: (config: IMatchConfig) => IMatchResult;
}

/** Games 2k/2k+1 reuse one combat seed and swap which board side the candidate drives. */
export function playV07ArchetypeGame(
    spec: IV07ArchetypeCellSpec,
    game: number,
    dependencies: IV07ArchetypeGameDependencies = {},
): IV07ArchetypeGameRecord {
    if (!Number.isSafeInteger(game) || game < 0 || game >= spec.games) {
        throw new Error(`game must be in [0, ${spec.games}); got ${game}`);
    }
    const template = v07ArchetypeTemplate(spec.template);
    if (template.archetype !== spec.archetype) {
        throw new Error(`${spec.template} belongs to ${template.archetype}, not ${spec.archetype}`);
    }
    const pairIndex = Math.floor(game / 2);
    const seed = (spec.baseSeed + pairIndex * PAIRED_SCENARIO_SEED_STEP) >>> 0;
    const candidateIsGreen = game % 2 === 0;
    const greenVersion = candidateIsGreen ? spec.candidate : spec.opponent;
    const redVersion = candidateIsGreen ? spec.opponent : spec.candidate;
    const candidateTelemetry = emptyTelemetry();
    const opponentTelemetry = emptyTelemetry();
    const setup = liveTwinSetup();
    const roster = template.roster.map((unit) => ({ ...unit }));
    const redRoster = template.roster.map((unit) => ({ ...unit }));
    const decisionObserver = (observation: IDecisionObservation): void => {
        const actorIsGreen = observation.unit.getTeam() === PBTypes.TeamVals.LOWER;
        observeDecision(actorIsGreen === candidateIsGreen ? candidateTelemetry : opponentTelemetry, observation);
    };
    const matchRunner =
        dependencies.matchRunner ??
        ((config: IMatchConfig): IMatchResult => {
            FightStateManager.getInstance();
            return runMatch(config);
        });
    const result = matchRunner({
        greenVersion,
        redVersion,
        roster,
        redRoster,
        seed,
        gridType: PBTypes.GridVals.NORMAL,
        greenPerk: setup.perk,
        redPerk: setup.perk,
        greenAugments: setup.augments,
        redAugments: setup.augments,
        decisionObserver,
    });
    return {
        template: spec.template,
        game,
        seed,
        candidateIsGreen,
        greenVersion,
        redVersion,
        roster: rosterSignature(template.roster),
        winner: result.winner,
        laps: result.laps,
        endReason: result.endReason,
        decidedByArmageddon: result.attrition.decidedByArmageddon,
        rejectedGreen: result.rejectedGreen,
        rejectedRed: result.rejectedRed,
        candidateTelemetry,
        opponentTelemetry,
    };
}

export interface IV07ArchetypeCellReport {
    spec: IV07ArchetypeCellSpec;
    outcomes: IPairClusterStats;
    integrity: IIntegrityStats;
    telemetry: { candidate: IActionTelemetry; opponent: IActionTelemetry };
}

export interface IV07ArchetypeAggregate {
    cells: number;
    outcomes: IPairClusterStats;
    integrity: IIntegrityStats;
    telemetry: { candidate: IActionTelemetry; opponent: IActionTelemetry };
}

function emptyIntegrity(): IIntegrityStats {
    return {
        games: 0,
        draws: 0,
        armageddonDecided: 0,
        drawOrArmageddon: 0,
        drawOrArmageddonRate: 0,
        candidateRejections: 0,
        opponentRejections: 0,
        recordsMissingRejectionCounts: 0,
        candidateGamesAsGreen: 0,
        candidateGamesAsRed: 0,
        candidateWinsAsGreen: 0,
        candidateWinsAsRed: 0,
        endReasons: {},
    };
}

function clusteredStats(
    candidateWins: number,
    opponentWins: number,
    draws: number,
    moments: IClusterMoments,
): IPairClusterStats {
    const decisiveGames = candidateWins + opponentWins;
    const games = decisiveGames + draws;
    const candidateWinRate = decisiveGames ? candidateWins / decisiveGames : 0.5;
    let standardError: number | null = null;
    let confidence95: { low: number; high: number } | null = null;
    if (moments.clusters >= 2 && decisiveGames > 0) {
        const residualSquares =
            moments.sumWinSquared -
            2 * candidateWinRate * moments.sumWinDecisive +
            candidateWinRate * candidateWinRate * moments.sumDecisiveSquared;
        const finiteSample = moments.clusters / (moments.clusters - 1);
        standardError = Math.sqrt(Math.max(0, (finiteSample * residualSquares) / (decisiveGames * decisiveGames)));
        const z = 1.959963984540054;
        confidence95 = {
            low: Math.max(0, candidateWinRate - z * standardError),
            high: Math.min(1, candidateWinRate + z * standardError),
        };
    }
    return {
        method: "paired-side-swap cluster sandwich",
        confidenceLevel: 0.95,
        games,
        pairClusters: moments.clusters,
        decisiveGames,
        candidateWins,
        opponentWins,
        draws,
        candidateWinRate,
        deltaFromParityPp: (candidateWinRate - 0.5) * 100,
        standardErrorPp: standardError === null ? null : standardError * 100,
        confidence95,
        moments,
    };
}

function addTelemetry(target: IActionTelemetry, source: IActionTelemetry): void {
    target.decisions += source.decisions;
    for (const key of ["actionTypes", "spells", "creatures", "creatureActions"] as const) {
        for (const [name, count] of Object.entries(source[key])) increment(target[key], name, count);
    }
}

function addIntegrity(target: IIntegrityStats, source: IIntegrityStats): void {
    for (const key of [
        "games",
        "draws",
        "armageddonDecided",
        "drawOrArmageddon",
        "candidateRejections",
        "opponentRejections",
        "recordsMissingRejectionCounts",
        "candidateGamesAsGreen",
        "candidateGamesAsRed",
        "candidateWinsAsGreen",
        "candidateWinsAsRed",
    ] as const) {
        target[key] += source[key];
    }
    for (const [reason, count] of Object.entries(source.endReasons)) increment(target.endReasons, reason, count);
}

export function summarizeV07ArchetypeCell(
    spec: IV07ArchetypeCellSpec,
    records: readonly IV07ArchetypeGameRecord[],
): IV07ArchetypeCellReport {
    validateGames(spec.games);
    const byGame = new Map<number, IV07ArchetypeGameRecord>();
    for (const record of records) {
        if (!Number.isSafeInteger(record.game) || record.game < 0 || record.game >= spec.games) {
            throw new Error(`${spec.template}/${spec.opponent}: out-of-range game ${record.game}`);
        }
        if (byGame.has(record.game))
            throw new Error(`${spec.template}/${spec.opponent}: duplicate game ${record.game}`);
        byGame.set(record.game, record);
    }
    if (byGame.size !== spec.games) {
        throw new Error(`${spec.template}/${spec.opponent}: collected ${byGame.size}/${spec.games} game records`);
    }

    let candidateWins = 0;
    let opponentWins = 0;
    let draws = 0;
    const moments: IClusterMoments = {
        clusters: spec.games / 2,
        sumWinSquared: 0,
        sumWinDecisive: 0,
        sumDecisiveSquared: 0,
    };
    const integrity = emptyIntegrity();
    const candidateTelemetry = emptyTelemetry();
    const opponentTelemetry = emptyTelemetry();
    const expectedRoster = rosterSignature(v07ArchetypeTemplate(spec.template).roster);

    for (let pair = 0; pair < spec.games / 2; pair += 1) {
        let pairWins = 0;
        let pairDecisive = 0;
        const expectedSeed = (spec.baseSeed + pair * PAIRED_SCENARIO_SEED_STEP) >>> 0;
        for (const game of [pair * 2, pair * 2 + 1]) {
            const record = byGame.get(game)!;
            const candidateIsGreen = game % 2 === 0;
            if (
                record.template !== spec.template ||
                record.seed !== expectedSeed ||
                record.candidateIsGreen !== candidateIsGreen ||
                record.greenVersion !== (candidateIsGreen ? spec.candidate : spec.opponent) ||
                record.redVersion !== (candidateIsGreen ? spec.opponent : spec.candidate) ||
                record.roster !== expectedRoster
            ) {
                throw new Error(
                    `${spec.template}/${spec.opponent}: game ${game} violates fixed-roster side-swap protocol`,
                );
            }
            integrity.games += 1;
            if (candidateIsGreen) integrity.candidateGamesAsGreen += 1;
            else integrity.candidateGamesAsRed += 1;
            if (record.winner === "draw") {
                draws += 1;
                integrity.draws += 1;
            } else {
                pairDecisive += 1;
                const won = record.winner === (candidateIsGreen ? "green" : "red");
                if (won) {
                    candidateWins += 1;
                    pairWins += 1;
                    if (candidateIsGreen) integrity.candidateWinsAsGreen += 1;
                    else integrity.candidateWinsAsRed += 1;
                } else {
                    opponentWins += 1;
                }
            }
            if (record.decidedByArmageddon) integrity.armageddonDecided += 1;
            if (record.decidedByArmageddon || record.winner === "draw") integrity.drawOrArmageddon += 1;
            if (record.rejectedGreen === undefined || record.rejectedRed === undefined) {
                integrity.recordsMissingRejectionCounts += 1;
            } else if (candidateIsGreen) {
                integrity.candidateRejections += record.rejectedGreen;
                integrity.opponentRejections += record.rejectedRed;
            } else {
                integrity.candidateRejections += record.rejectedRed;
                integrity.opponentRejections += record.rejectedGreen;
            }
            increment(integrity.endReasons, record.endReason);
            addTelemetry(candidateTelemetry, record.candidateTelemetry);
            addTelemetry(opponentTelemetry, record.opponentTelemetry);
        }
        moments.sumWinSquared += pairWins * pairWins;
        moments.sumWinDecisive += pairWins * pairDecisive;
        moments.sumDecisiveSquared += pairDecisive * pairDecisive;
    }
    integrity.drawOrArmageddonRate = integrity.games ? integrity.drawOrArmageddon / integrity.games : 0;
    return {
        spec,
        outcomes: clusteredStats(candidateWins, opponentWins, draws, moments),
        integrity,
        telemetry: { candidate: candidateTelemetry, opponent: opponentTelemetry },
    };
}

export function aggregateV07ArchetypeCells(cells: readonly IV07ArchetypeCellReport[]): IV07ArchetypeAggregate {
    let candidateWins = 0;
    let opponentWins = 0;
    let draws = 0;
    const moments: IClusterMoments = {
        clusters: 0,
        sumWinSquared: 0,
        sumWinDecisive: 0,
        sumDecisiveSquared: 0,
    };
    const integrity = emptyIntegrity();
    const candidateTelemetry = emptyTelemetry();
    const opponentTelemetry = emptyTelemetry();
    for (const cell of cells) {
        candidateWins += cell.outcomes.candidateWins;
        opponentWins += cell.outcomes.opponentWins;
        draws += cell.outcomes.draws;
        moments.clusters += cell.outcomes.moments.clusters;
        moments.sumWinSquared += cell.outcomes.moments.sumWinSquared;
        moments.sumWinDecisive += cell.outcomes.moments.sumWinDecisive;
        moments.sumDecisiveSquared += cell.outcomes.moments.sumDecisiveSquared;
        addIntegrity(integrity, cell.integrity);
        addTelemetry(candidateTelemetry, cell.telemetry.candidate);
        addTelemetry(opponentTelemetry, cell.telemetry.opponent);
    }
    integrity.drawOrArmageddonRate = integrity.games ? integrity.drawOrArmageddon / integrity.games : 0;
    return {
        cells: cells.length,
        outcomes: clusteredStats(candidateWins, opponentWins, draws, moments),
        integrity,
        telemetry: { candidate: candidateTelemetry, opponent: opponentTelemetry },
    };
}

export const PAIRED_SCENARIO_SEED_STEP = 0x9e3779b1;

function validateUint32(name: string, value: number): void {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
        throw new Error(`${name} must be an integer in [0, 2^32-1]; got ${value}`);
    }
}

function validateGames(value: number): void {
    if (!Number.isSafeInteger(value) || value < 2 || value % 2 !== 0) {
        throw new Error("gamesPerCell must be an even integer >= 2 so every game has its side-swapped partner");
    }
}

function sameMembers(actual: readonly string[], expected: readonly string[]): boolean {
    return actual.length === expected.length && expected.every((value) => actual.includes(value));
}

/** Reject both obvious base-seed reuse and collision between any derived paired scenario streams. */
export function validateV07ArchetypeSeedStreams(options: IV07ArchetypeBatteryOptions): void {
    const seen = new Map<number, string>();
    for (const template of V07_ARCHETYPE_TEMPLATE_NAMES) {
        for (const opponent of options.opponents) {
            const baseSeed = options.seeds[template]?.[opponent as V07ArchetypeOpponent];
            validateUint32(`${template}/${opponent} seed`, baseSeed);
            for (let pair = 0; pair < options.gamesPerCell / 2; pair += 1) {
                const derived = (baseSeed + pair * PAIRED_SCENARIO_SEED_STEP) >>> 0;
                const label = `${template}/${opponent}`;
                const previous = seen.get(derived);
                if (previous) {
                    throw new Error(
                        `Seed streams overlap at derived seed ${derived}: ${previous} and ${label}; ` +
                            "every template/opponent cell requires disjoint scenarios",
                    );
                }
                seen.set(derived, label);
            }
        }
    }
}

export function validateV07ArchetypeOptions(options: IV07ArchetypeBatteryOptions): void {
    if (!AI_VERSIONS.includes(options.candidate)) {
        throw new Error(`Unknown candidate version ${options.candidate}; known versions: ${AI_VERSIONS.join(", ")}`);
    }
    if (!options.opponents.length || new Set(options.opponents).size !== options.opponents.length) {
        throw new Error("opponents must be a non-empty list of unique registered versions");
    }
    for (const opponent of options.opponents) {
        if (!AI_VERSIONS.includes(opponent)) {
            throw new Error(`Unknown opponent version ${opponent}; known versions: ${AI_VERSIONS.join(", ")}`);
        }
        if (opponent === options.candidate)
            throw new Error(`Candidate ${options.candidate} cannot be its own opponent`);
        for (const template of V07_ARCHETYPE_TEMPLATE_NAMES) {
            if (options.seeds[template]?.[opponent as V07ArchetypeOpponent] === undefined) {
                throw new Error(`Missing preregistered seed for ${template}/${opponent}`);
            }
        }
    }
    if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
        throw new Error("concurrency must be a positive integer");
    }
    validateGames(options.gamesPerCell);
    validateV07ArchetypeSeedStreams(options);
}

export function buildV07ArchetypeCellSpecs(options: IV07ArchetypeBatteryOptions): IV07ArchetypeCellSpec[] {
    return options.opponents.flatMap((opponent) =>
        V07_ARCHETYPE_TEMPLATES.map((template) => ({
            archetype: template.archetype,
            template: template.name,
            candidate: options.candidate,
            opponent,
            baseSeed: options.seeds[template.name][opponent as V07ArchetypeOpponent],
            games: options.gamesPerCell,
        })),
    );
}

export function runV07ArchetypeCellSequential(
    spec: IV07ArchetypeCellSpec,
    dependencies: IV07ArchetypeGameDependencies = {},
): IV07ArchetypeCellReport {
    const records = Array.from({ length: spec.games }, (_, game) => playV07ArchetypeGame(spec, game, dependencies));
    return summarizeV07ArchetypeCell(spec, records);
}

/** One cell per pool, matching the acceptance/checkpoint boundary and the existing payoff worker model. */
export async function runV07ArchetypeCell(
    spec: IV07ArchetypeCellSpec,
    concurrency: number,
): Promise<IV07ArchetypeCellReport> {
    const poolSize = Math.max(1, Math.min(Math.floor(concurrency) || 1, spec.games));
    if (poolSize <= 1) return runV07ArchetypeCellSequential(spec);

    return new Promise<IV07ArchetypeCellReport>((resolvePromise, rejectPromise) => {
        const records: IV07ArchetypeGameRecord[] = [];
        const workers: Worker[] = [];
        let dispatched = 0;
        let completed = 0;
        let settled = false;
        const cleanup = (): void => {
            for (const worker of workers) void worker.terminate();
        };
        const fail = (error: unknown): void => {
            if (settled) return;
            settled = true;
            cleanup();
            rejectPromise(error instanceof Error ? error : new Error(String(error)));
        };
        const dispatchNext = (worker: Worker): void => {
            if (dispatched >= spec.games) {
                worker.postMessage({ type: "stop" });
                return;
            }
            worker.postMessage({ type: "game", game: dispatched });
            dispatched += 1;
        };
        const workerUrl = new URL("./v0_7_archetype_battery_worker.ts", import.meta.url);
        for (let index = 0; index < poolSize; index += 1) {
            let worker: Worker;
            try {
                worker = new Worker(workerUrl, { workerData: { spec } });
            } catch (error) {
                fail(error);
                return;
            }
            workers.push(worker);
            worker.on(
                "message",
                (
                    message:
                        | { type: "ready" }
                        | { type: "result"; record: IV07ArchetypeGameRecord }
                        | { type: "error"; error: string },
                ) => {
                    if (settled) return;
                    if (message.type === "error") {
                        fail(new Error(message.error));
                        return;
                    }
                    if (message.type === "ready") {
                        dispatchNext(worker);
                        return;
                    }
                    records.push(message.record);
                    completed += 1;
                    if (completed >= spec.games) {
                        settled = true;
                        cleanup();
                        try {
                            resolvePromise(summarizeV07ArchetypeCell(spec, records));
                        } catch (error) {
                            rejectPromise(error instanceof Error ? error : new Error(String(error)));
                        }
                        return;
                    }
                    dispatchNext(worker);
                },
            );
            worker.on("error", fail);
        }
    });
}

function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

interface IV07ArchetypeCheckpoint {
    schemaVersion: 1;
    runFingerprint: string;
    cellSha256: string;
    cell: IV07ArchetypeCellReport;
}

function safeCellName(spec: IV07ArchetypeCellSpec): string {
    return `${spec.template}_${spec.opponent}_seed${spec.baseSeed}`.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function loadV07ArchetypeCheckpoint(
    checkpointDir: string,
    spec: IV07ArchetypeCellSpec,
    expectedFingerprint: string,
): IV07ArchetypeCellReport | undefined {
    const path = join(checkpointDir, `${safeCellName(spec)}.json`);
    if (!existsSync(path)) return undefined;
    const checkpoint = JSON.parse(readFileSync(path, "utf8")) as IV07ArchetypeCheckpoint;
    if (checkpoint.schemaVersion !== 1 || checkpoint.runFingerprint !== expectedFingerprint) return undefined;
    if (sha256(JSON.stringify(checkpoint.cell)) !== checkpoint.cellSha256) {
        throw new Error(`Corrupt v0.7 archetype checkpoint: ${path}`);
    }
    if (JSON.stringify(checkpoint.cell.spec) !== JSON.stringify(spec)) return undefined;
    return checkpoint.cell;
}

export function saveV07ArchetypeCheckpoint(
    checkpointDir: string,
    cell: IV07ArchetypeCellReport,
    fingerprint: string,
): void {
    mkdirSync(checkpointDir, { recursive: true });
    const path = join(checkpointDir, `${safeCellName(cell.spec)}.json`);
    const temporary = `${path}.tmp-${process.pid}`;
    const encoded = JSON.stringify(cell);
    const checkpoint: IV07ArchetypeCheckpoint = {
        schemaVersion: 1,
        runFingerprint: fingerprint,
        cellSha256: sha256(encoded),
        cell,
    };
    writeFileSync(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`);
    renameSync(temporary, path);
}

export function v07ArchetypeRunFingerprint(
    options: IV07ArchetypeBatteryOptions,
    revision: IRevisionProvenance,
): string {
    return sha256(
        JSON.stringify({
            protocol: V07_ARCHETYPE_PROTOCOL,
            candidate: options.candidate,
            opponents: options.opponents,
            gamesPerCell: options.gamesPerCell,
            seeds: options.seeds,
            seedManifestSha256: options.seedManifest?.sha256 ?? null,
            templates: V07_ARCHETYPE_TEMPLATES.map((template) => ({
                name: template.name,
                archetype: template.archetype,
                roster: rosterSignature(template.roster),
            })),
            revision: {
                commit: revision.commit,
                trackedClean: revision.trackedClean,
                trackedDiffSha256: revision.trackedDiffSha256,
            },
            effective: {
                amountMode: "expBudget",
                stackExperienceBudget: STACK_EXPERIENCE_BUDGET,
                setup: liveTwinSetup(),
                map: "NORMAL",
                pairedSideSwap: true,
            },
        }),
    );
}

export interface IV07ArchetypeGate {
    name: string;
    threshold: string;
    observed: string;
    passed: boolean;
}

export type V07ArchetypeEvidenceVerdict = "INCONCLUSIVE" | "PASS" | "FAIL";

export interface IV07ArchetypeAssessment {
    evidenceVerdict: V07ArchetypeEvidenceVerdict;
    protocolPowered: boolean;
    protocolCompletenessReasons: string[];
    gates: IV07ArchetypeGate[];
    resolutionDiagnostics: IV07ArchetypeResolutionDiagnostic[];
    bakeDecision: "NOT_EVALUATED";
    ownerSignOff: "NOT_EVALUATED";
    releaseInstruction: "NO_BAKE_FROM_THIS_REPORT";
}

export interface IV07ArchetypeResolutionDiagnostic {
    template: V07ArchetypeTemplateName;
    opponent: string;
    games: number;
    drawRate: number;
    armageddonRate: number;
    drawOrArmageddonRate: number;
    endReasons: Record<string, number>;
    policy: "DIAGNOSTIC_ONLY";
}

function percent(value: number): string {
    return `${(value * 100).toFixed(3)}%`;
}

function confidenceLow(aggregate: IV07ArchetypeAggregate | IV07ArchetypeCellReport): number | null {
    return aggregate.outcomes.confidence95?.low ?? null;
}

export function assessV07ArchetypeBattery(
    options: IV07ArchetypeBatteryOptions,
    revision: IRevisionProvenance,
    cells: readonly IV07ArchetypeCellReport[],
    revisionStable = true,
): IV07ArchetypeAssessment {
    const reasons: string[] = [];
    if (options.candidate !== V07_ARCHETYPE_PROTOCOL.candidate) {
        reasons.push(`candidate is ${options.candidate}; protocol requires ${V07_ARCHETYPE_PROTOCOL.candidate}`);
    }
    if (!sameMembers(options.opponents, V07_ARCHETYPE_PROTOCOL.opponents)) {
        reasons.push(`opponents are ${options.opponents.join(",")}; protocol requires v0.6 and v0.4`);
    }
    if (options.gamesPerCell !== V07_ARCHETYPE_PROTOCOL.gamesPerCell) {
        reasons.push(`games/cell is ${options.gamesPerCell}; protocol requires ${V07_ARCHETYPE_PROTOCOL.gamesPerCell}`);
    }
    if (!options.seedsDeclaredFresh) reasons.push("seed freshness was not declared by the caller");
    if (!options.seedManifest) reasons.push("seed panel was not loaded from a persisted preregistration manifest");
    if (!revision.trackedClean) reasons.push("tracked working tree was dirty at evaluation time");
    if (!revisionStable) reasons.push("Git revision or tracked diff changed while the evaluation was running");
    const expectedCellCount = V07_ARCHETYPE_TEMPLATE_NAMES.length * V07_ARCHETYPE_PROTOCOL.opponents.length;
    if (cells.length !== expectedCellCount)
        reasons.push(`collected ${cells.length}/${expectedCellCount} required cells`);

    const gates: IV07ArchetypeGate[] = [];
    for (const opponent of V07_ARCHETYPE_PROTOCOL.opponents) {
        for (const archetype of V07_ARCHETYPES) {
            const archetypeCells = cells.filter(
                (cell) => cell.spec.opponent === opponent && cell.spec.archetype === archetype,
            );
            const aggregate = aggregateV07ArchetypeCells(archetypeCells);
            const low = confidenceLow(aggregate);
            const strongArchetype = archetype !== "meleeMage";
            const transitivityAnchor = opponent === V07_ARCHETYPE_PROTOCOL.transitivityOpponent && archetype === "aura";
            if (opponent === V07_ARCHETYPE_PROTOCOL.champion && strongArchetype) {
                gates.push({
                    name: `strong-${archetype}-vs-${opponent}`,
                    threshold: ">=54.00% decisive win rate",
                    observed: archetypeCells.length ? percent(aggregate.outcomes.candidateWinRate) : "missing",
                    passed:
                        archetypeCells.length === 2 &&
                        aggregate.outcomes.candidateWinRate >= V07_ARCHETYPE_PROTOCOL.strongArchetypeWinRate,
                });
            }
            gates.push({
                name: `confidence-${archetype}-vs-${opponent}`,
                threshold: transitivityAnchor
                    ? ">=50.00% decisive; 95% paired-cluster lower bound >=48.00%"
                    : "95% paired-cluster lower bound >50.00%",
                observed: low === null ? "missing" : percent(low),
                passed:
                    archetypeCells.length === 2 &&
                    low !== null &&
                    (transitivityAnchor
                        ? aggregate.outcomes.candidateWinRate >= V07_ARCHETYPE_PROTOCOL.templateMinWinRate &&
                          low >= V07_ARCHETYPE_PROTOCOL.templateConfidenceFloor
                        : low > V07_ARCHETYPE_PROTOCOL.archetypeConfidenceFloor),
            });
        }
        for (const template of V07_ARCHETYPE_TEMPLATE_NAMES) {
            const cell = cells.find(
                (candidate) => candidate.spec.opponent === opponent && candidate.spec.template === template,
            );
            const low = cell ? confidenceLow(cell) : null;
            gates.push({
                name: `non-regression-${template}-vs-${opponent}`,
                threshold: ">=50.00% decisive; 95% lower bound >=48.00%",
                observed: cell
                    ? `${percent(cell.outcomes.candidateWinRate)}; low=${low === null ? "missing" : percent(low)}`
                    : "missing",
                passed:
                    !!cell &&
                    cell.outcomes.candidateWinRate >= V07_ARCHETYPE_PROTOCOL.templateMinWinRate &&
                    low !== null &&
                    low >= V07_ARCHETYPE_PROTOCOL.templateConfidenceFloor,
            });
        }
    }

    const completeRecords =
        cells.length === expectedCellCount &&
        cells.every(
            (cell) =>
                cell.outcomes.games === options.gamesPerCell &&
                cell.outcomes.pairClusters === options.gamesPerCell / 2 &&
                cell.integrity.games === options.gamesPerCell &&
                cell.integrity.candidateGamesAsGreen === options.gamesPerCell / 2 &&
                cell.integrity.candidateGamesAsRed === options.gamesPerCell / 2,
        );
    gates.push({
        name: "paired-record-completeness",
        threshold: "all 16 cells complete; every game paired and candidate side-balanced",
        observed: `${cells.length}/${expectedCellCount} cells; ${completeRecords ? "complete" : "incomplete"}`,
        passed: completeRecords,
    });
    const candidateRejections = cells.reduce((sum, cell) => sum + cell.integrity.candidateRejections, 0);
    const missingRejections = cells.reduce((sum, cell) => sum + cell.integrity.recordsMissingRejectionCounts, 0);
    gates.push({
        name: "candidate-engine-rejections",
        threshold: "0 candidate rejections; counts present in every game",
        observed: `${candidateRejections} rejections; ${missingRejections} records missing counts`,
        passed: candidateRejections <= V07_ARCHETYPE_PROTOCOL.candidateRejectionLimit && missingRejections === 0,
    });

    const protocolPowered = reasons.length === 0;
    const resolutionDiagnostics: IV07ArchetypeResolutionDiagnostic[] = cells.map((cell) => ({
        template: cell.spec.template,
        opponent: cell.spec.opponent,
        games: cell.integrity.games,
        drawRate: cell.integrity.games ? cell.integrity.draws / cell.integrity.games : 0,
        armageddonRate: cell.integrity.games ? cell.integrity.armageddonDecided / cell.integrity.games : 0,
        drawOrArmageddonRate: cell.integrity.drawOrArmageddonRate,
        endReasons: cell.integrity.endReasons,
        policy: "DIAGNOSTIC_ONLY",
    }));
    return {
        evidenceVerdict: protocolPowered ? (gates.every((gate) => gate.passed) ? "PASS" : "FAIL") : "INCONCLUSIVE",
        protocolPowered,
        protocolCompletenessReasons: reasons,
        gates,
        resolutionDiagnostics,
        bakeDecision: "NOT_EVALUATED",
        ownerSignOff: "NOT_EVALUATED",
        releaseInstruction: "NO_BAKE_FROM_THIS_REPORT",
    };
}

export interface IV07ArchetypeBatteryReport {
    schemaVersion: 1;
    generatedAt: string;
    completedAt: string;
    elapsedSeconds: number;
    provenance: {
        revision: IRevisionProvenance;
        revisionAtCompletion: IRevisionProvenance;
        revisionStable: boolean;
        command: string[];
        cwd: string;
        runtime: { bun: string | null; node: string; platform: string; release: string; arch: string };
        runFingerprint: string;
        resumedCells: number;
    };
    protocol: typeof V07_ARCHETYPE_PROTOCOL;
    requested: IV07ArchetypeBatteryOptions;
    effectiveConfig: {
        preset: "LiveTwin fight/setup";
        amountMode: "expBudget";
        stackExperienceBudget: number;
        composition: typeof DEFAULT_ROSTER_COMPOSITION;
        setup: ReturnType<typeof liveTwinSetup> & { noVision: true };
        map: "NORMAL";
        identicalRosterBothTeams: true;
        pairedSideSwap: true;
        environmentPolicy: "committed-defaults-only";
        armageddonPolicy: "per-template-diagnostic-only";
        templates: readonly IV07ArchetypeTemplate[];
        taxonomy: IV07ArchetypeTaxonomy;
    };
    cells: IV07ArchetypeCellReport[];
    byOpponent: Record<string, Record<V07Archetype, IV07ArchetypeAggregate>>;
    assessment: IV07ArchetypeAssessment;
}

export interface IV07ArchetypeBatteryDependencies {
    runCell: (spec: IV07ArchetypeCellSpec, concurrency: number) => Promise<IV07ArchetypeCellReport>;
    now: () => Date;
    revision: () => IRevisionProvenance;
    command: () => string[];
    cwd: () => string;
    loadCheckpoint: (spec: IV07ArchetypeCellSpec, runFingerprint: string) => IV07ArchetypeCellReport | undefined;
    saveCheckpoint: (cell: IV07ArchetypeCellReport, runFingerprint: string) => void;
    onCellComplete: (cell: IV07ArchetypeCellReport, completed: number, total: number, resumed: boolean) => void;
}

const DEFAULT_DEPENDENCIES: IV07ArchetypeBatteryDependencies = {
    runCell: runV07ArchetypeCell,
    now: () => new Date(),
    revision: readRevisionProvenance,
    command: () => process.argv.slice(),
    cwd: () => process.cwd(),
    loadCheckpoint: () => undefined,
    saveCheckpoint: () => undefined,
    onCellComplete: () => undefined,
};

const BEHAVIOR_ENV_PREFIXES = ["V04_", "V05_", "V06_", "V07_", "SEARCH_", "Q2_", "CEM_"] as const;
const BEHAVIOR_ENV_EXACT_KEYS = [
    "AUGCA_NOVISION",
    "FIGHT_MELEE_ROSTERS",
    "FORCE_CREATURES",
    "LIVETWIN",
    "ROSTER_RANGED_MAX",
    "ROSTER_RANGED_MIN",
    "VALUE_DATA",
] as const;
const BEHAVIOR_ENV_EXACT = new Set<string>(BEHAVIOR_ENV_EXACT_KEYS);

function behaviorEnvironment(source: NodeJS.ProcessEnv = process.env): string[] {
    return Object.keys(source)
        .filter((key) => BEHAVIOR_ENV_EXACT.has(key) || BEHAVIOR_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)))
        .filter((key) => source[key] !== undefined)
        .sort();
}

export async function runV07ArchetypeBattery(
    options: IV07ArchetypeBatteryOptions,
    dependencies: Partial<IV07ArchetypeBatteryDependencies> = {},
): Promise<IV07ArchetypeBatteryReport> {
    validateV07ArchetypeOptions(options);
    const ambient = behaviorEnvironment();
    if (ambient.length) {
        throw new Error(
            `Refusing archetype evidence under behavior-changing environment: ${ambient.join(", ")}. ` +
                "Unset these variables; the harness evaluates committed defaults only.",
        );
    }
    const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
    const revision = deps.revision();
    const fingerprint = v07ArchetypeRunFingerprint(options, revision);
    const started = deps.now();
    const specs = buildV07ArchetypeCellSpecs(options);
    const cells: IV07ArchetypeCellReport[] = [];
    let resumedCells = 0;
    for (const spec of specs) {
        const checkpoint = deps.loadCheckpoint(spec, fingerprint);
        const resumed = checkpoint !== undefined;
        const cell = checkpoint ?? (await deps.runCell(spec, Math.min(options.concurrency, spec.games)));
        if (resumed) resumedCells += 1;
        else deps.saveCheckpoint(cell, fingerprint);
        cells.push(cell);
        deps.onCellComplete(cell, cells.length, specs.length, resumed);
    }
    const revisionAtCompletion = deps.revision();
    const revisionStable =
        revision.commit === revisionAtCompletion.commit &&
        revision.trackedClean === revisionAtCompletion.trackedClean &&
        revision.trackedDiffSha256 === revisionAtCompletion.trackedDiffSha256;
    const completed = deps.now();
    const byOpponent: Record<string, Record<V07Archetype, IV07ArchetypeAggregate>> = {};
    for (const opponent of options.opponents) {
        byOpponent[opponent] = {} as Record<V07Archetype, IV07ArchetypeAggregate>;
        for (const archetype of V07_ARCHETYPES) {
            byOpponent[opponent][archetype] = aggregateV07ArchetypeCells(
                cells.filter((cell) => cell.spec.opponent === opponent && cell.spec.archetype === archetype),
            );
        }
    }
    const setup = liveTwinSetup();
    return {
        schemaVersion: 1,
        generatedAt: started.toISOString(),
        completedAt: completed.toISOString(),
        elapsedSeconds: Math.max(0, (completed.getTime() - started.getTime()) / 1000),
        provenance: {
            revision,
            revisionAtCompletion,
            revisionStable,
            command: deps.command(),
            cwd: deps.cwd(),
            runtime: {
                bun: process.versions.bun ?? null,
                node: process.version,
                platform: platform(),
                release: release(),
                arch: arch(),
            },
            runFingerprint: fingerprint,
            resumedCells,
        },
        protocol: V07_ARCHETYPE_PROTOCOL,
        requested: options,
        effectiveConfig: {
            preset: "LiveTwin fight/setup",
            amountMode: "expBudget",
            stackExperienceBudget: STACK_EXPERIENCE_BUDGET,
            composition: DEFAULT_ROSTER_COMPOSITION,
            setup: { ...setup, noVision: true },
            map: "NORMAL",
            identicalRosterBothTeams: true,
            pairedSideSwap: true,
            environmentPolicy: "committed-defaults-only",
            armageddonPolicy: "per-template-diagnostic-only",
            templates: V07_ARCHETYPE_TEMPLATES,
            taxonomy: V07_ARCHETYPE_TAXONOMY,
        },
        cells,
        byOpponent,
        assessment: assessV07ArchetypeBattery(options, revision, cells, revisionStable),
    };
}

export function readV07ArchetypeSeedManifest(manifestPath: string): {
    manifest: IV07ArchetypeSeedManifest;
    provenance: IV07ArchetypeManifestProvenance;
} {
    const sourcePath = resolve(manifestPath);
    const raw = readFileSync(sourcePath, "utf8");
    const manifest = JSON.parse(raw) as IV07ArchetypeSeedManifest;
    if (manifest.schemaVersion !== 1) throw new Error(`Unsupported archetype manifest schema in ${sourcePath}`);
    if (!manifest.manifestId?.trim()) throw new Error(`Manifest ${sourcePath} requires a non-empty manifestId`);
    if (!manifest.createdAt || !Number.isFinite(Date.parse(manifest.createdAt))) {
        throw new Error(`Manifest ${sourcePath} requires an ISO createdAt timestamp`);
    }
    if (!manifest.declaration?.trim()) throw new Error(`Manifest ${sourcePath} requires a freshness declaration`);
    if (!manifest.cells || typeof manifest.cells !== "object") {
        throw new Error(`Manifest ${sourcePath} requires fixed template/opponent cells`);
    }
    if (
        manifest.candidate !== V07_ARCHETYPE_PROTOCOL.candidate ||
        !sameMembers(manifest.opponents, V07_ARCHETYPE_PROTOCOL.opponents) ||
        manifest.gamesPerCell !== V07_ARCHETYPE_PROTOCOL.gamesPerCell
    ) {
        throw new Error(
            `Manifest ${sourcePath} must preregister v0.7 vs v0.6/v0.4 at ` +
                `${V07_ARCHETYPE_PROTOCOL.gamesPerCell} games/cell`,
        );
    }
    if (!sameMembers(Object.keys(manifest.cells), V07_ARCHETYPE_TEMPLATE_NAMES)) {
        throw new Error(`Manifest ${sourcePath} must define exactly the eight fixed roster templates`);
    }
    for (const template of V07_ARCHETYPE_TEMPLATE_NAMES) {
        if (!sameMembers(Object.keys(manifest.cells[template] ?? {}), V07_ARCHETYPE_PROTOCOL.opponents)) {
            throw new Error(`Manifest ${sourcePath} must define v0.6 and v0.4 seeds for ${template}`);
        }
    }
    const options: IV07ArchetypeBatteryOptions = {
        candidate: manifest.candidate,
        opponents: manifest.opponents,
        gamesPerCell: manifest.gamesPerCell,
        seeds: manifest.cells,
        concurrency: 1,
        seedsDeclaredFresh: manifest.freshSeedsDeclared,
        seedManifest: {
            manifestId: manifest.manifestId,
            createdAt: manifest.createdAt,
            sourcePath,
            sha256: sha256(raw),
            declaration: manifest.declaration,
        },
    };
    validateV07ArchetypeOptions(options);
    return { manifest, provenance: options.seedManifest! };
}

export function parseV07ArchetypeArgs(argv: string[], cwd = process.cwd()): IV07ArchetypeCliOptions {
    const parsed = parseArgs({
        args: argv,
        allowPositionals: false,
        strict: true,
        options: {
            manifest: { type: "string" },
            concurrency: {
                type: "string",
                default: String(Math.min(12, Math.max(1, availableParallelism()))),
            },
            output: { type: "string" },
            "checkpoint-dir": { type: "string" },
            help: { type: "boolean", short: "h", default: false },
        },
    });
    if (parsed.values.help) {
        throw new Error(
            "usage: bun src/simulation/v0_7_archetype_battery.ts --manifest=panel.json " +
                "[--concurrency=12] [--checkpoint-dir=dir] [--output=report.json]",
        );
    }
    if (!parsed.values.manifest) throw new Error("--manifest is required; powered evidence must be preregistered");
    const loaded = readV07ArchetypeSeedManifest(resolve(cwd, parsed.values.manifest));
    const concurrency = Number(parsed.values.concurrency);
    const outputPath = resolve(
        cwd,
        parsed.values.output ?? join("sim-out", "v0_7_archetype_battery", `${loaded.manifest.manifestId}.json`),
    );
    const options: IV07ArchetypeCliOptions = {
        candidate: loaded.manifest.candidate,
        opponents: loaded.manifest.opponents,
        gamesPerCell: loaded.manifest.gamesPerCell,
        seeds: loaded.manifest.cells,
        concurrency,
        seedsDeclaredFresh: loaded.manifest.freshSeedsDeclared,
        seedManifest: loaded.provenance,
        outputPath,
        checkpointDir: resolve(cwd, parsed.values["checkpoint-dir"] ?? `${outputPath}.cells`),
    };
    validateV07ArchetypeOptions(options);
    return options;
}

export function writeV07ArchetypeReport(report: IV07ArchetypeBatteryReport, outputPath: string): void {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(
        `${outputPath}.gates.json`,
        `${JSON.stringify(
            {
                schemaVersion: 1,
                candidate: report.requested.candidate,
                revision: report.provenance.revision.commit,
                revisionAtCompletion: report.provenance.revisionAtCompletion.commit,
                revisionStable: report.provenance.revisionStable,
                runFingerprint: report.provenance.runFingerprint,
                evidenceVerdict: report.assessment.evidenceVerdict,
                protocolPowered: report.assessment.protocolPowered,
                protocolCompletenessReasons: report.assessment.protocolCompletenessReasons,
                gates: report.assessment.gates,
                resolutionDiagnostics: report.assessment.resolutionDiagnostics,
                bakeDecision: report.assessment.bakeDecision,
                ownerSignOff: report.assessment.ownerSignOff,
                releaseInstruction: report.assessment.releaseInstruction,
            },
            null,
            2,
        )}\n`,
    );
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
    const cli = parseV07ArchetypeArgs(argv);
    const { outputPath, checkpointDir, ...options } = cli;
    const totalCells = V07_ARCHETYPE_TEMPLATE_NAMES.length * options.opponents.length;
    console.log(
        `v0.7 fixed-archetype evidence: ${totalCells} cells x ${options.gamesPerCell} games; ` +
            `${options.candidate} vs ${options.opponents.join("/")}`,
    );
    const report = await runV07ArchetypeBattery(options, {
        loadCheckpoint: (spec, fingerprint) => loadV07ArchetypeCheckpoint(checkpointDir, spec, fingerprint),
        saveCheckpoint: (cell, fingerprint) => saveV07ArchetypeCheckpoint(checkpointDir, cell, fingerprint),
        onCellComplete: (cell, completed, total, resumed) => {
            console.log(
                `[${completed}/${total}]${resumed ? " [resumed]" : ""} ${cell.spec.template} vs ` +
                    `${cell.spec.opponent} seed=${cell.spec.baseSeed} ${percent(cell.outcomes.candidateWinRate)}`,
            );
        },
    });
    writeV07ArchetypeReport(report, outputPath);
    console.log(`evidence=${report.assessment.evidenceVerdict}; bake=${report.assessment.bakeDecision}`);
    console.log(`summary -> ${outputPath}`);
    console.log(`gates -> ${outputPath}.gates.json`);
}

if ((import.meta as unknown as { main?: boolean }).main) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}
