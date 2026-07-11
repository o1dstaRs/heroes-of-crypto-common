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
import CREATURES_JSON from "../configuration/creatures.json";
import { FightStateManager } from "../fights/fight_state_manager";
import { PBTypes } from "../generated/protobuf/v1/types";
import { DEFAULT_ROSTER_COMPOSITION, STACK_EXPERIENCE_BUDGET } from "./army";
import { runMatch, type IDecisionObservation, type IMatchConfig, type IMatchResult, type Side } from "./battle_engine";
import { liveTwinSetup } from "./livetwin";
import {
    PAIRED_SCENARIO_SEED_STEP,
    V07_ARCHETYPE_TAXONOMY,
    V07_ARCHETYPE_TEMPLATES,
    rosterSignature,
    v07ArchetypeTemplate,
    type IActionTelemetry,
    type V07ArchetypeTemplateName,
} from "./v0_7_archetype_battery";
import { readRevisionProvenance, type IClusterMoments, type IRevisionProvenance } from "./v0_7_acceptance";

export const V07_CROSS_ARCHETYPE_MATCHUPS = [
    "mage_frontline_vs_mage_fireline",
    "melee_magic_utility_vs_melee_magic_brawler",
    "aura_support_vs_mage_frontline",
    "ranged_precision_vs_ranged_control",
] as const;
export type V07CrossArchetypeMatchup = (typeof V07_CROSS_ARCHETYPE_MATCHUPS)[number];

export interface IV07CrossArchetypeMatchupDefinition {
    name: V07CrossArchetypeMatchup;
    templateA: V07ArchetypeTemplateName;
    templateB: V07ArchetypeTemplateName;
    purpose: string;
}

export const V07_CROSS_ARCHETYPE_MATCHUP_DEFINITIONS: Readonly<
    Record<V07CrossArchetypeMatchup, IV07CrossArchetypeMatchupDefinition>
> = Object.freeze({
    mage_frontline_vs_mage_fireline: Object.freeze({
        name: "mage_frontline_vs_mage_fireline",
        templateA: "mage_frontline",
        templateB: "mage_fireline",
        purpose: "Mage frontline versus all-ranged mage fireline.",
    }),
    melee_magic_utility_vs_melee_magic_brawler: Object.freeze({
        name: "melee_magic_utility_vs_melee_magic_brawler",
        templateA: "melee_magic_utility",
        templateB: "melee_magic_brawler",
        purpose: "Melee-magic salvage utility versus anchored brawler policy.",
    }),
    aura_support_vs_mage_frontline: Object.freeze({
        name: "aura_support_vs_mage_frontline",
        templateA: "aura_support",
        templateB: "mage_frontline",
        purpose: "Aura anchor versus a non-aura mage composition.",
    }),
    ranged_precision_vs_ranged_control: Object.freeze({
        name: "ranged_precision_vs_ranged_control",
        templateA: "ranged_precision",
        templateB: "ranged_control",
        purpose: "Large Caliber precision roster versus Area Throw control roster.",
    }),
});

/**
 * This panel is preregistered in code before its seed manifest exists. The pooled gate estimates the
 * equal-games average over these four fixed matchup cells; it is not a claim about arbitrary roster mixes.
 */
export const V07_CROSS_ARCHETYPE_PROTOCOL = {
    schemaVersion: 1,
    candidate: "v0.7",
    opponent: "v0.6",
    gamesPerCell: 3000,
    clusterSize: 4,
    cellMinWinRate: 0.5,
    cellConfidenceFloor: 0.48,
    pooledConfidenceFloor: 0.5,
    candidateRejectionLimit: 0,
    confidenceLevel: 0.95,
    pooledEstimand: "equal-games pooled decisive win rate over the four fixed matchup cells",
} as const;

export const QUARTET_SCENARIO_SEED_STEP = PAIRED_SCENARIO_SEED_STEP;
export type V07CrossRosterSlot = "A" | "B";

export interface IV07CrossAssignment {
    candidateSide: Side;
    candidateRosterSlot: V07CrossRosterSlot;
    greenRosterSlot: V07CrossRosterSlot;
    redRosterSlot: V07CrossRosterSlot;
}

/** Candidate sequence: A-green, B-red, B-green, A-red; the v0.6 assignment is opposite. */
export const V07_CROSS_QUARTET_ASSIGNMENTS: readonly IV07CrossAssignment[] = Object.freeze([
    Object.freeze({ candidateSide: "green", candidateRosterSlot: "A", greenRosterSlot: "A", redRosterSlot: "B" }),
    Object.freeze({ candidateSide: "red", candidateRosterSlot: "B", greenRosterSlot: "A", redRosterSlot: "B" }),
    Object.freeze({ candidateSide: "green", candidateRosterSlot: "B", greenRosterSlot: "B", redRosterSlot: "A" }),
    Object.freeze({ candidateSide: "red", candidateRosterSlot: "A", greenRosterSlot: "B", redRosterSlot: "A" }),
]);

export interface IV07CrossArchetypeSeedManifest {
    schemaVersion: 1;
    manifestId: string;
    createdAt: string;
    candidate: string;
    opponent: string;
    gamesPerCell: number;
    cells: Record<V07CrossArchetypeMatchup, number>;
    freshSeedsDeclared: boolean;
    declaration: string;
}

export interface IV07CrossArchetypeManifestProvenance {
    manifestId: string;
    createdAt: string;
    sourcePath: string;
    sha256: string;
    declaration: string;
}

export interface IV07CrossArchetypeOptions {
    candidate: string;
    opponent: string;
    gamesPerCell: number;
    seeds: Readonly<Record<V07CrossArchetypeMatchup, number>>;
    concurrency: number;
    seedsDeclaredFresh: boolean;
    seedManifest: IV07CrossArchetypeManifestProvenance | null;
}

export interface IV07CrossArchetypeCliOptions extends IV07CrossArchetypeOptions {
    outputPath: string;
    checkpointDir: string;
}

export interface IV07CrossArchetypeCellSpec {
    matchup: V07CrossArchetypeMatchup;
    templateA: V07ArchetypeTemplateName;
    templateB: V07ArchetypeTemplateName;
    candidate: string;
    opponent: string;
    baseSeed: number;
    games: number;
}

export interface IV07CrossArchetypeGameRecord {
    matchup: V07CrossArchetypeMatchup;
    game: number;
    seed: number;
    candidateIsGreen: boolean;
    candidateTemplate: V07ArchetypeTemplateName;
    opponentTemplate: V07ArchetypeTemplateName;
    greenVersion: string;
    redVersion: string;
    greenTemplate: V07ArchetypeTemplateName;
    redTemplate: V07ArchetypeTemplateName;
    greenRoster: string;
    redRoster: string;
    winner: Side | "draw";
    laps: number;
    endReason: IMatchResult["endReason"];
    decidedByArmageddon: boolean;
    rejectedGreen?: number;
    rejectedRed?: number;
    candidateTelemetry: IActionTelemetry;
    opponentTelemetry: IActionTelemetry;
}

export interface IV07QuartetClusterStats {
    method: "four-game side-and-roster-balanced cluster sandwich";
    confidenceLevel: 0.95;
    games: number;
    quartetClusters: number;
    decisiveGames: number;
    candidateWins: number;
    opponentWins: number;
    draws: number;
    candidateWinRate: number;
    deltaFromParityPp: number;
    standardErrorPp: number | null;
    confidence95: { low: number; high: number } | null;
    moments: IClusterMoments;
}

export interface IV07CrossIntegrity {
    games: number;
    draws: number;
    armageddonDecided: number;
    drawOrArmageddon: number;
    drawOrArmageddonRate: number;
    candidateRejections: number;
    opponentRejections: number;
    recordsMissingRejectionCounts: number;
    candidateGamesAsGreen: number;
    candidateGamesAsRed: number;
    candidateGamesWithTemplateA: number;
    candidateGamesWithTemplateB: number;
    candidateAssignmentMatrix: Record<"A-green" | "A-red" | "B-green" | "B-red", number>;
    candidateWinsAsGreen: number;
    candidateWinsAsRed: number;
    candidateWinsWithTemplateA: number;
    candidateWinsWithTemplateB: number;
    endReasons: Record<string, number>;
}

export interface IV07ExpectedBranchExposures {
    policy: "EXPECTED_FROM_VALIDATED_FIXED_ROSTERS_NOT_RUNTIME_BRANCH_INSTRUMENTATION";
    auraAnchorGames: number;
    meleeMagicAnchorGames: number;
    meleeMagicSalvageGames: number;
    rangedVsAreaThrowGames: number;
    basis: readonly string[];
}

export interface IV07CrossArchetypeCellReport {
    spec: IV07CrossArchetypeCellSpec;
    outcomes: IV07QuartetClusterStats;
    integrity: IV07CrossIntegrity;
    telemetry: { candidate: IActionTelemetry; opponent: IActionTelemetry };
    expectedBranchExposures: IV07ExpectedBranchExposures;
}

export interface IV07CrossArchetypeAggregate {
    cells: number;
    outcomes: IV07QuartetClusterStats;
    integrity: IV07CrossIntegrity;
    telemetry: { candidate: IActionTelemetry; opponent: IActionTelemetry };
    expectedBranchExposures: IV07ExpectedBranchExposures;
}

function emptyTelemetry(): IActionTelemetry {
    return { decisions: 0, actionTypes: {}, spells: {}, creatures: {}, creatureActions: {} };
}

function increment(counts: Record<string, number>, key: string, amount = 1): void {
    counts[key] = (counts[key] ?? 0) + amount;
}

function addTelemetry(target: IActionTelemetry, source: IActionTelemetry): void {
    target.decisions += source.decisions;
    for (const key of ["actionTypes", "spells", "creatures", "creatureActions"] as const) {
        for (const [name, count] of Object.entries(source[key])) increment(target[key], name, count);
    }
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

function matchupDefinition(matchup: V07CrossArchetypeMatchup): IV07CrossArchetypeMatchupDefinition {
    const definition = V07_CROSS_ARCHETYPE_MATCHUP_DEFINITIONS[matchup];
    if (!definition) throw new Error(`Unknown v0.7 cross-archetype matchup ${matchup}`);
    return definition;
}

function templateForSlot(spec: IV07CrossArchetypeCellSpec, slot: V07CrossRosterSlot): V07ArchetypeTemplateName {
    return slot === "A" ? spec.templateA : spec.templateB;
}

function assignmentForGame(game: number): IV07CrossAssignment {
    return V07_CROSS_QUARTET_ASSIGNMENTS[game % V07_CROSS_ARCHETYPE_PROTOCOL.clusterSize];
}

export interface IV07CrossGameDependencies {
    matchRunner?: (config: IMatchConfig) => IMatchResult;
}

export function playV07CrossArchetypeGame(
    spec: IV07CrossArchetypeCellSpec,
    game: number,
    dependencies: IV07CrossGameDependencies = {},
): IV07CrossArchetypeGameRecord {
    if (!Number.isSafeInteger(game) || game < 0 || game >= spec.games) {
        throw new Error(`game must be in [0, ${spec.games}); got ${game}`);
    }
    const definition = matchupDefinition(spec.matchup);
    if (definition.templateA !== spec.templateA || definition.templateB !== spec.templateB) {
        throw new Error(`${spec.matchup} must use ${definition.templateA} as A and ${definition.templateB} as B`);
    }
    const assignment = assignmentForGame(game);
    const quartet = Math.floor(game / V07_CROSS_ARCHETYPE_PROTOCOL.clusterSize);
    const seed = (spec.baseSeed + quartet * QUARTET_SCENARIO_SEED_STEP) >>> 0;
    const candidateIsGreen = assignment.candidateSide === "green";
    const greenVersion = candidateIsGreen ? spec.candidate : spec.opponent;
    const redVersion = candidateIsGreen ? spec.opponent : spec.candidate;
    const greenTemplate = templateForSlot(spec, assignment.greenRosterSlot);
    const redTemplate = templateForSlot(spec, assignment.redRosterSlot);
    const candidateTemplate = templateForSlot(spec, assignment.candidateRosterSlot);
    const opponentTemplate = candidateTemplate === spec.templateA ? spec.templateB : spec.templateA;
    const greenRoster = v07ArchetypeTemplate(greenTemplate).roster.map((unit) => ({ ...unit }));
    const redRoster = v07ArchetypeTemplate(redTemplate).roster.map((unit) => ({ ...unit }));
    const candidateTelemetry = emptyTelemetry();
    const opponentTelemetry = emptyTelemetry();
    const setup = liveTwinSetup();
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
        roster: greenRoster,
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
        matchup: spec.matchup,
        game,
        seed,
        candidateIsGreen,
        candidateTemplate,
        opponentTemplate,
        greenVersion,
        redVersion,
        greenTemplate,
        redTemplate,
        greenRoster: rosterSignature(greenRoster),
        redRoster: rosterSignature(redRoster),
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

function emptyIntegrity(): IV07CrossIntegrity {
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
        candidateGamesWithTemplateA: 0,
        candidateGamesWithTemplateB: 0,
        candidateAssignmentMatrix: { "A-green": 0, "A-red": 0, "B-green": 0, "B-red": 0 },
        candidateWinsAsGreen: 0,
        candidateWinsAsRed: 0,
        candidateWinsWithTemplateA: 0,
        candidateWinsWithTemplateB: 0,
        endReasons: {},
    };
}

function addIntegrity(target: IV07CrossIntegrity, source: IV07CrossIntegrity): void {
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
        "candidateGamesWithTemplateA",
        "candidateGamesWithTemplateB",
        "candidateWinsAsGreen",
        "candidateWinsAsRed",
        "candidateWinsWithTemplateA",
        "candidateWinsWithTemplateB",
    ] as const) {
        target[key] += source[key];
    }
    for (const key of Object.keys(target.candidateAssignmentMatrix) as Array<
        keyof IV07CrossIntegrity["candidateAssignmentMatrix"]
    >) {
        target.candidateAssignmentMatrix[key] += source.candidateAssignmentMatrix[key];
    }
    for (const [reason, count] of Object.entries(source.endReasons)) increment(target.endReasons, reason, count);
}

function quartetStats(
    candidateWins: number,
    opponentWins: number,
    draws: number,
    moments: IClusterMoments,
): IV07QuartetClusterStats {
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
        method: "four-game side-and-roster-balanced cluster sandwich",
        confidenceLevel: 0.95,
        games,
        quartetClusters: moments.clusters,
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

interface IRawCreatureConfig {
    abilities?: string[];
}

function creatureAbilities(): ReadonlyMap<string, readonly string[]> {
    const configs = new Map<string, readonly string[]>();
    for (const group of Object.values(CREATURES_JSON as unknown as Record<string, unknown>)) {
        if (!group || typeof group !== "object") continue;
        for (const [name, config] of Object.entries(group as Record<string, IRawCreatureConfig>)) {
            configs.set(name, config.abilities ?? []);
        }
    }
    return configs;
}

const CREATURE_ABILITIES = creatureAbilities();

function templateIsAuraSaturated(template: V07ArchetypeTemplateName): boolean {
    return v07ArchetypeTemplate(template).roster.every((unit) =>
        V07_ARCHETYPE_TAXONOMY.aura.includes(unit.creatureName),
    );
}

function templateIsPureRanged(template: V07ArchetypeTemplateName): boolean {
    return v07ArchetypeTemplate(template).roster.every((unit) =>
        V07_ARCHETYPE_TAXONOMY.ranged.includes(unit.creatureName),
    );
}

function templateHasAbility(template: V07ArchetypeTemplateName, ability: string): boolean {
    return v07ArchetypeTemplate(template).roster.some((unit) =>
        (CREATURE_ABILITIES.get(unit.creatureName) ?? []).includes(ability),
    );
}

function emptyExpectedBranchExposures(): IV07ExpectedBranchExposures {
    return {
        policy: "EXPECTED_FROM_VALIDATED_FIXED_ROSTERS_NOT_RUNTIME_BRANCH_INSTRUMENTATION",
        auraAnchorGames: 0,
        meleeMagicAnchorGames: 0,
        meleeMagicSalvageGames: 0,
        rangedVsAreaThrowGames: 0,
        basis: [],
    };
}

function expectedBranchExposures(records: readonly IV07CrossArchetypeGameRecord[]): IV07ExpectedBranchExposures {
    const diagnostic = emptyExpectedBranchExposures();
    const basis = new Set<string>();
    for (const record of records) {
        if (templateIsAuraSaturated(record.candidateTemplate)) {
            diagnostic.auraAnchorGames += 1;
            basis.add("aura-anchor: every candidate stack belongs to the enabled aura taxonomy");
        }
        const candidateDefinition = v07ArchetypeTemplate(record.candidateTemplate);
        if (candidateDefinition.archetype === "meleeMage") {
            const hasSalvage =
                templateHasAbility(record.candidateTemplate, "Resurrection") ||
                templateHasAbility(record.candidateTemplate, "Wind Flow");
            if (hasSalvage) {
                diagnostic.meleeMagicSalvageGames += 1;
                basis.add("melee-magic-salvage: candidate fixed roster contains Resurrection or Wind Flow");
            } else {
                diagnostic.meleeMagicAnchorGames += 1;
                basis.add("melee-magic-anchor: candidate fixed roster has no supported salvage spell");
            }
        }
        if (
            templateIsPureRanged(record.candidateTemplate) &&
            templateHasAbility(record.opponentTemplate, "Area Throw")
        ) {
            diagnostic.rangedVsAreaThrowGames += 1;
            basis.add("ranged-vs-AreaThrow: candidate roster is pure ranged and opponent fixed roster has Area Throw");
        }
    }
    diagnostic.basis = [...basis].sort();
    return diagnostic;
}

function addExpectedBranchExposures(target: IV07ExpectedBranchExposures, source: IV07ExpectedBranchExposures): void {
    target.auraAnchorGames += source.auraAnchorGames;
    target.meleeMagicAnchorGames += source.meleeMagicAnchorGames;
    target.meleeMagicSalvageGames += source.meleeMagicSalvageGames;
    target.rangedVsAreaThrowGames += source.rangedVsAreaThrowGames;
    target.basis = [...new Set([...target.basis, ...source.basis])].sort();
}

function validateGames(games: number): void {
    if (!Number.isSafeInteger(games) || games < V07_CROSS_ARCHETYPE_PROTOCOL.clusterSize || games % 4 !== 0) {
        throw new Error("gamesPerCell must be an integer >= 4 and divisible by 4 for complete quartet clusters");
    }
}

export function summarizeV07CrossArchetypeCell(
    spec: IV07CrossArchetypeCellSpec,
    records: readonly IV07CrossArchetypeGameRecord[],
): IV07CrossArchetypeCellReport {
    validateGames(spec.games);
    const definition = matchupDefinition(spec.matchup);
    if (spec.templateA !== definition.templateA || spec.templateB !== definition.templateB) {
        throw new Error(`${spec.matchup}: cell spec violates fixed matchup definition`);
    }
    const byGame = new Map<number, IV07CrossArchetypeGameRecord>();
    for (const record of records) {
        if (!Number.isSafeInteger(record.game) || record.game < 0 || record.game >= spec.games) {
            throw new Error(`${spec.matchup}: out-of-range game ${record.game}`);
        }
        if (byGame.has(record.game)) throw new Error(`${spec.matchup}: duplicate game ${record.game}`);
        byGame.set(record.game, record);
    }
    if (byGame.size !== spec.games) throw new Error(`${spec.matchup}: collected ${byGame.size}/${spec.games} records`);

    let candidateWins = 0;
    let opponentWins = 0;
    let draws = 0;
    const moments: IClusterMoments = {
        clusters: spec.games / 4,
        sumWinSquared: 0,
        sumWinDecisive: 0,
        sumDecisiveSquared: 0,
    };
    const integrity = emptyIntegrity();
    const candidateTelemetry = emptyTelemetry();
    const opponentTelemetry = emptyTelemetry();
    const validatedRecords: IV07CrossArchetypeGameRecord[] = [];

    for (let quartet = 0; quartet < spec.games / 4; quartet += 1) {
        const expectedSeed = (spec.baseSeed + quartet * QUARTET_SCENARIO_SEED_STEP) >>> 0;
        let clusterWins = 0;
        let clusterDecisive = 0;
        for (let offset = 0; offset < 4; offset += 1) {
            const game = quartet * 4 + offset;
            const record = byGame.get(game)!;
            const assignment = assignmentForGame(game);
            const candidateIsGreen = assignment.candidateSide === "green";
            const candidateTemplate = templateForSlot(spec, assignment.candidateRosterSlot);
            const opponentTemplate = candidateTemplate === spec.templateA ? spec.templateB : spec.templateA;
            const greenTemplate = templateForSlot(spec, assignment.greenRosterSlot);
            const redTemplate = templateForSlot(spec, assignment.redRosterSlot);
            if (
                record.matchup !== spec.matchup ||
                record.seed !== expectedSeed ||
                record.candidateIsGreen !== candidateIsGreen ||
                record.candidateTemplate !== candidateTemplate ||
                record.opponentTemplate !== opponentTemplate ||
                record.greenVersion !== (candidateIsGreen ? spec.candidate : spec.opponent) ||
                record.redVersion !== (candidateIsGreen ? spec.opponent : spec.candidate) ||
                record.greenTemplate !== greenTemplate ||
                record.redTemplate !== redTemplate ||
                record.greenRoster !== rosterSignature(v07ArchetypeTemplate(greenTemplate).roster) ||
                record.redRoster !== rosterSignature(v07ArchetypeTemplate(redTemplate).roster)
            ) {
                throw new Error(`${spec.matchup}: game ${game} violates fixed quartet side/roster assignment`);
            }
            validatedRecords.push(record);
            integrity.games += 1;
            const candidateSlot: V07CrossRosterSlot = candidateTemplate === spec.templateA ? "A" : "B";
            const assignmentKey = `${candidateSlot}-${candidateIsGreen ? "green" : "red"}` as const;
            integrity.candidateAssignmentMatrix[assignmentKey] += 1;
            if (candidateIsGreen) integrity.candidateGamesAsGreen += 1;
            else integrity.candidateGamesAsRed += 1;
            if (candidateSlot === "A") integrity.candidateGamesWithTemplateA += 1;
            else integrity.candidateGamesWithTemplateB += 1;
            if (record.winner === "draw") {
                draws += 1;
                integrity.draws += 1;
            } else {
                clusterDecisive += 1;
                const candidateWon = record.winner === (candidateIsGreen ? "green" : "red");
                if (candidateWon) {
                    candidateWins += 1;
                    clusterWins += 1;
                    if (candidateIsGreen) integrity.candidateWinsAsGreen += 1;
                    else integrity.candidateWinsAsRed += 1;
                    if (candidateSlot === "A") integrity.candidateWinsWithTemplateA += 1;
                    else integrity.candidateWinsWithTemplateB += 1;
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
        moments.sumWinSquared += clusterWins * clusterWins;
        moments.sumWinDecisive += clusterWins * clusterDecisive;
        moments.sumDecisiveSquared += clusterDecisive * clusterDecisive;
    }
    integrity.drawOrArmageddonRate = integrity.games ? integrity.drawOrArmageddon / integrity.games : 0;
    return {
        spec,
        outcomes: quartetStats(candidateWins, opponentWins, draws, moments),
        integrity,
        telemetry: { candidate: candidateTelemetry, opponent: opponentTelemetry },
        expectedBranchExposures: expectedBranchExposures(validatedRecords),
    };
}

export function aggregateV07CrossArchetypeCells(
    cells: readonly IV07CrossArchetypeCellReport[],
): IV07CrossArchetypeAggregate {
    let candidateWins = 0;
    let opponentWins = 0;
    let draws = 0;
    const moments: IClusterMoments = { clusters: 0, sumWinSquared: 0, sumWinDecisive: 0, sumDecisiveSquared: 0 };
    const integrity = emptyIntegrity();
    const candidateTelemetry = emptyTelemetry();
    const opponentTelemetry = emptyTelemetry();
    const branchExposures = emptyExpectedBranchExposures();
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
        addExpectedBranchExposures(branchExposures, cell.expectedBranchExposures);
    }
    integrity.drawOrArmageddonRate = integrity.games ? integrity.drawOrArmageddon / integrity.games : 0;
    return {
        cells: cells.length,
        outcomes: quartetStats(candidateWins, opponentWins, draws, moments),
        integrity,
        telemetry: { candidate: candidateTelemetry, opponent: opponentTelemetry },
        expectedBranchExposures: branchExposures,
    };
}

function validateUint32(name: string, value: number): void {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
        throw new Error(`${name} must be an integer in [0, 2^32-1]; got ${value}`);
    }
}

function sameMembers(actual: readonly string[], expected: readonly string[]): boolean {
    return actual.length === expected.length && expected.every((value) => actual.includes(value));
}

export function validateV07CrossArchetypeSeedStreams(options: IV07CrossArchetypeOptions): void {
    const seen = new Map<number, string>();
    for (const matchup of V07_CROSS_ARCHETYPE_MATCHUPS) {
        const baseSeed = options.seeds[matchup];
        validateUint32(`${matchup} seed`, baseSeed);
        for (let quartet = 0; quartet < options.gamesPerCell / 4; quartet += 1) {
            const derived = (baseSeed + quartet * QUARTET_SCENARIO_SEED_STEP) >>> 0;
            const previous = seen.get(derived);
            if (previous) {
                throw new Error(
                    `Seed streams overlap at derived seed ${derived}: ${previous} and ${matchup}; ` +
                        "every cross-archetype cell requires disjoint quartet scenarios",
                );
            }
            seen.set(derived, matchup);
        }
    }
}

export function validateV07CrossArchetypeOptions(options: IV07CrossArchetypeOptions): void {
    if (!AI_VERSIONS.includes(options.candidate)) throw new Error(`Unknown candidate version ${options.candidate}`);
    if (!AI_VERSIONS.includes(options.opponent)) throw new Error(`Unknown opponent version ${options.opponent}`);
    if (options.candidate === options.opponent) throw new Error("Candidate cannot be its own opponent");
    if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
        throw new Error("concurrency must be a positive integer");
    }
    validateGames(options.gamesPerCell);
    for (const matchup of V07_CROSS_ARCHETYPE_MATCHUPS) {
        if (options.seeds[matchup] === undefined) throw new Error(`Missing preregistered seed for ${matchup}`);
    }
    if (!sameMembers(Object.keys(options.seeds), V07_CROSS_ARCHETYPE_MATCHUPS)) {
        throw new Error("seeds must define exactly the four fixed cross-archetype matchup cells");
    }
    validateV07CrossArchetypeSeedStreams(options);
}

export function buildV07CrossArchetypeCellSpecs(options: IV07CrossArchetypeOptions): IV07CrossArchetypeCellSpec[] {
    return V07_CROSS_ARCHETYPE_MATCHUPS.map((matchup) => {
        const definition = matchupDefinition(matchup);
        return {
            matchup,
            templateA: definition.templateA,
            templateB: definition.templateB,
            candidate: options.candidate,
            opponent: options.opponent,
            baseSeed: options.seeds[matchup],
            games: options.gamesPerCell,
        };
    });
}

export function runV07CrossArchetypeCellSequential(
    spec: IV07CrossArchetypeCellSpec,
    dependencies: IV07CrossGameDependencies = {},
): IV07CrossArchetypeCellReport {
    const records = Array.from({ length: spec.games }, (_, game) =>
        playV07CrossArchetypeGame(spec, game, dependencies),
    );
    return summarizeV07CrossArchetypeCell(spec, records);
}

export async function runV07CrossArchetypeCell(
    spec: IV07CrossArchetypeCellSpec,
    concurrency: number,
): Promise<IV07CrossArchetypeCellReport> {
    const poolSize = Math.max(1, Math.min(Math.floor(concurrency) || 1, spec.games));
    if (poolSize <= 1) return runV07CrossArchetypeCellSequential(spec);
    return new Promise<IV07CrossArchetypeCellReport>((resolvePromise, rejectPromise) => {
        const records: IV07CrossArchetypeGameRecord[] = [];
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
        const workerUrl = new URL("./v0_7_cross_archetype_worker.ts", import.meta.url);
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
                        | { type: "result"; record: IV07CrossArchetypeGameRecord }
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
                            resolvePromise(summarizeV07CrossArchetypeCell(spec, records));
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

interface IV07CrossCheckpoint {
    schemaVersion: 1;
    runFingerprint: string;
    cellSha256: string;
    cell: IV07CrossArchetypeCellReport;
}

function safeCellName(spec: IV07CrossArchetypeCellSpec): string {
    return `${spec.matchup}_${spec.opponent}_seed${spec.baseSeed}`.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function loadV07CrossArchetypeCheckpoint(
    checkpointDir: string,
    spec: IV07CrossArchetypeCellSpec,
    expectedFingerprint: string,
): IV07CrossArchetypeCellReport | undefined {
    const path = join(checkpointDir, `${safeCellName(spec)}.json`);
    if (!existsSync(path)) return undefined;
    const checkpoint = JSON.parse(readFileSync(path, "utf8")) as IV07CrossCheckpoint;
    if (checkpoint.schemaVersion !== 1 || checkpoint.runFingerprint !== expectedFingerprint) return undefined;
    if (sha256(JSON.stringify(checkpoint.cell)) !== checkpoint.cellSha256) {
        throw new Error(`Corrupt v0.7 cross-archetype checkpoint: ${path}`);
    }
    if (JSON.stringify(checkpoint.cell.spec) !== JSON.stringify(spec)) return undefined;
    return checkpoint.cell;
}

export function saveV07CrossArchetypeCheckpoint(
    checkpointDir: string,
    cell: IV07CrossArchetypeCellReport,
    fingerprint: string,
): void {
    mkdirSync(checkpointDir, { recursive: true });
    const path = join(checkpointDir, `${safeCellName(cell.spec)}.json`);
    const temporary = `${path}.tmp-${process.pid}`;
    const encoded = JSON.stringify(cell);
    const checkpoint: IV07CrossCheckpoint = {
        schemaVersion: 1,
        runFingerprint: fingerprint,
        cellSha256: sha256(encoded),
        cell,
    };
    writeFileSync(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`);
    renameSync(temporary, path);
}

export function v07CrossArchetypeRunFingerprint(
    options: IV07CrossArchetypeOptions,
    revision: IRevisionProvenance,
): string {
    return sha256(
        JSON.stringify({
            protocol: V07_CROSS_ARCHETYPE_PROTOCOL,
            candidate: options.candidate,
            opponent: options.opponent,
            gamesPerCell: options.gamesPerCell,
            seeds: options.seeds,
            seedManifestSha256: options.seedManifest?.sha256 ?? null,
            matchups: V07_CROSS_ARCHETYPE_MATCHUPS.map((name) => {
                const definition = matchupDefinition(name);
                return {
                    ...definition,
                    rosterA: rosterSignature(v07ArchetypeTemplate(definition.templateA).roster),
                    rosterB: rosterSignature(v07ArchetypeTemplate(definition.templateB).roster),
                };
            }),
            quartetAssignments: V07_CROSS_QUARTET_ASSIGNMENTS,
            revision: {
                commit: revision.commit,
                branch: revision.branch,
                trackedClean: revision.trackedClean,
                trackedDiffSha256: revision.trackedDiffSha256,
            },
            effective: {
                amountMode: "expBudget",
                stackExperienceBudget: STACK_EXPERIENCE_BUDGET,
                setup: liveTwinSetup(),
                map: "NORMAL",
                independentFixedRosters: true,
            },
        }),
    );
}

export interface IV07CrossArchetypeGate {
    name: string;
    threshold: string;
    observed: string;
    passed: boolean;
}

export type V07CrossArchetypeEvidenceVerdict = "INCONCLUSIVE" | "PASS" | "FAIL";

export interface IV07CrossArchetypeAssessment {
    evidenceVerdict: V07CrossArchetypeEvidenceVerdict;
    protocolPowered: boolean;
    protocolCompletenessReasons: string[];
    gates: IV07CrossArchetypeGate[];
    branchExposurePolicy: "DIAGNOSTIC_ONLY_EXPECTED_NOT_RUNTIME_OBSERVED";
    bakeDecision: "NOT_EVALUATED";
    ownerSignOff: "NOT_EVALUATED";
    releaseInstruction: "NO_BAKE_FROM_THIS_REPORT";
}

function percent(value: number): string {
    return `${(value * 100).toFixed(3)}%`;
}

export function assessV07CrossArchetypeEvidence(
    options: IV07CrossArchetypeOptions,
    revision: IRevisionProvenance,
    cells: readonly IV07CrossArchetypeCellReport[],
    revisionStable = true,
): IV07CrossArchetypeAssessment {
    const reasons: string[] = [];
    if (options.candidate !== V07_CROSS_ARCHETYPE_PROTOCOL.candidate) {
        reasons.push(`candidate is ${options.candidate}; protocol requires ${V07_CROSS_ARCHETYPE_PROTOCOL.candidate}`);
    }
    if (options.opponent !== V07_CROSS_ARCHETYPE_PROTOCOL.opponent) {
        reasons.push(`opponent is ${options.opponent}; protocol requires ${V07_CROSS_ARCHETYPE_PROTOCOL.opponent}`);
    }
    if (options.gamesPerCell !== V07_CROSS_ARCHETYPE_PROTOCOL.gamesPerCell) {
        reasons.push(
            `games/cell is ${options.gamesPerCell}; protocol requires ${V07_CROSS_ARCHETYPE_PROTOCOL.gamesPerCell}`,
        );
    }
    if (!options.seedsDeclaredFresh) reasons.push("seed freshness was not declared by the caller");
    if (!options.seedManifest) reasons.push("seed panel was not loaded from a persisted preregistration manifest");
    if (revision.branch !== "main") reasons.push(`Git branch is ${revision.branch}; powered evidence requires main`);
    if (!revision.trackedClean) reasons.push("tracked working tree was dirty at evaluation time");
    if (!revisionStable) reasons.push("Git revision or tracked diff changed while evaluation was running");
    if (cells.length !== V07_CROSS_ARCHETYPE_MATCHUPS.length) {
        reasons.push(`collected ${cells.length}/${V07_CROSS_ARCHETYPE_MATCHUPS.length} required cells`);
    }
    const expectedSpecs = buildV07CrossArchetypeCellSpecs(options);
    for (const expected of expectedSpecs) {
        const matches = cells.filter((cell) => cell.spec.matchup === expected.matchup);
        if (matches.length !== 1 || JSON.stringify(matches[0].spec) !== JSON.stringify(expected)) {
            reasons.push(`${expected.matchup} does not have exactly one cell with the preregistered spec`);
        }
    }

    const gates: IV07CrossArchetypeGate[] = [];
    for (const matchup of V07_CROSS_ARCHETYPE_MATCHUPS) {
        const cell = cells.find((candidate) => candidate.spec.matchup === matchup);
        const low = cell?.outcomes.confidence95?.low ?? null;
        gates.push({
            name: `non-regression-${matchup}`,
            threshold: ">=50.00% decisive; 95% quartet-cluster lower bound >=48.00%",
            observed: cell
                ? `${percent(cell.outcomes.candidateWinRate)}; low=${low === null ? "missing" : percent(low)}`
                : "missing",
            passed:
                !!cell &&
                cell.outcomes.candidateWinRate >= V07_CROSS_ARCHETYPE_PROTOCOL.cellMinWinRate &&
                low !== null &&
                low >= V07_CROSS_ARCHETYPE_PROTOCOL.cellConfidenceFloor,
        });
    }
    const aggregate = aggregateV07CrossArchetypeCells(cells);
    const aggregateLow = aggregate.outcomes.confidence95?.low ?? null;
    gates.push({
        name: "pooled-cross-archetype-confidence",
        threshold: "95% quartet-cluster lower bound >50.00% for the preregistered equal-games four-cell panel",
        observed: aggregateLow === null ? "missing" : percent(aggregateLow),
        passed:
            cells.length === V07_CROSS_ARCHETYPE_MATCHUPS.length &&
            aggregateLow !== null &&
            aggregateLow > V07_CROSS_ARCHETYPE_PROTOCOL.pooledConfidenceFloor,
    });
    const complete =
        cells.length === V07_CROSS_ARCHETYPE_MATCHUPS.length &&
        V07_CROSS_ARCHETYPE_MATCHUPS.every((matchup) => {
            const cell = cells.find((candidate) => candidate.spec.matchup === matchup);
            const expected = expectedSpecs.find((candidate) => candidate.matchup === matchup);
            if (!cell) return false;
            const quarter = options.gamesPerCell / 4;
            return (
                !!expected &&
                JSON.stringify(cell.spec) === JSON.stringify(expected) &&
                cell.outcomes.games === options.gamesPerCell &&
                cell.outcomes.quartetClusters === quarter &&
                cell.integrity.games === options.gamesPerCell &&
                cell.integrity.candidateGamesAsGreen === options.gamesPerCell / 2 &&
                cell.integrity.candidateGamesAsRed === options.gamesPerCell / 2 &&
                cell.integrity.candidateGamesWithTemplateA === options.gamesPerCell / 2 &&
                cell.integrity.candidateGamesWithTemplateB === options.gamesPerCell / 2 &&
                Object.values(cell.integrity.candidateAssignmentMatrix).every((count) => count === quarter)
            );
        });
    gates.push({
        name: "quartet-record-completeness",
        threshold: "all four cells complete; every side x candidate-roster assignment occurs once per quartet",
        observed: `${cells.length}/${V07_CROSS_ARCHETYPE_MATCHUPS.length} cells; ${complete ? "complete" : "incomplete"}`,
        passed: complete,
    });
    const expectedHalfCell = options.gamesPerCell / 2;
    gates.push({
        name: "expected-archetype-branch-exposure",
        threshold:
            "expected fixed-roster exposure in half a cell each for aura anchor, melee-magic anchor, " +
            "melee-magic salvage, and ranged-vs-AreaThrow",
        observed:
            `aura=${aggregate.expectedBranchExposures.auraAnchorGames}; ` +
            `meleeMagicAnchor=${aggregate.expectedBranchExposures.meleeMagicAnchorGames}; ` +
            `meleeMagicSalvage=${aggregate.expectedBranchExposures.meleeMagicSalvageGames}; ` +
            `rangedAreaThrow=${aggregate.expectedBranchExposures.rangedVsAreaThrowGames}`,
        passed:
            aggregate.expectedBranchExposures.auraAnchorGames === expectedHalfCell &&
            aggregate.expectedBranchExposures.meleeMagicAnchorGames === expectedHalfCell &&
            aggregate.expectedBranchExposures.meleeMagicSalvageGames === expectedHalfCell &&
            aggregate.expectedBranchExposures.rangedVsAreaThrowGames === expectedHalfCell,
    });
    const mageCell = cells.find((cell) => cell.spec.matchup === "mage_frontline_vs_mage_fireline");
    const meleeMagicCell = cells.find((cell) => cell.spec.matchup === "melee_magic_utility_vs_melee_magic_brawler");
    const rangedCell = cells.find((cell) => cell.spec.matchup === "ranged_precision_vs_ranged_control");
    const mageCasts = mageCell?.telemetry.candidate.actionTypes.cast_spell ?? 0;
    const salvageCasts =
        (meleeMagicCell?.telemetry.candidate.spells.Resurrection ?? 0) +
        (meleeMagicCell?.telemetry.candidate.spells["Wind Flow"] ?? 0);
    const rangedAttacks = rangedCell?.telemetry.candidate.actionTypes.range_attack ?? 0;
    gates.push({
        name: "archetype-action-coverage",
        threshold: "candidate records at least one mage cast, one Resurrection/Wind Flow cast, and one ranged attack",
        observed: `mageCasts=${mageCasts}; salvageCasts=${salvageCasts}; rangedAttacks=${rangedAttacks}`,
        passed: mageCasts > 0 && salvageCasts > 0 && rangedAttacks > 0,
    });
    const candidateRejections = cells.reduce((sum, cell) => sum + cell.integrity.candidateRejections, 0);
    const missingRejections = cells.reduce((sum, cell) => sum + cell.integrity.recordsMissingRejectionCounts, 0);
    gates.push({
        name: "candidate-engine-rejections",
        threshold: "0 candidate rejections; counts present in every game",
        observed: `${candidateRejections} rejections; ${missingRejections} records missing counts`,
        passed: candidateRejections <= V07_CROSS_ARCHETYPE_PROTOCOL.candidateRejectionLimit && missingRejections === 0,
    });
    const protocolPowered = reasons.length === 0;
    return {
        evidenceVerdict: protocolPowered ? (gates.every((gate) => gate.passed) ? "PASS" : "FAIL") : "INCONCLUSIVE",
        protocolPowered,
        protocolCompletenessReasons: reasons,
        gates,
        branchExposurePolicy: "DIAGNOSTIC_ONLY_EXPECTED_NOT_RUNTIME_OBSERVED",
        bakeDecision: "NOT_EVALUATED",
        ownerSignOff: "NOT_EVALUATED",
        releaseInstruction: "NO_BAKE_FROM_THIS_REPORT",
    };
}

export interface IV07CrossArchetypeReport {
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
    protocol: typeof V07_CROSS_ARCHETYPE_PROTOCOL;
    requested: IV07CrossArchetypeOptions;
    effectiveConfig: {
        preset: "LiveTwin fight/setup";
        amountMode: "expBudget";
        stackExperienceBudget: number;
        composition: typeof DEFAULT_ROSTER_COMPOSITION;
        setup: ReturnType<typeof liveTwinSetup> & { noVision: true };
        map: "NORMAL";
        independentFixedRosters: true;
        quartetSideAndRosterBalance: true;
        assignments: readonly IV07CrossAssignment[];
        environmentPolicy: "committed-defaults-only";
        branchExposurePolicy: "diagnostic expected counts from validated rosters; not runtime instrumentation";
        matchups: readonly IV07CrossArchetypeMatchupDefinition[];
        templates: typeof V07_ARCHETYPE_TEMPLATES;
    };
    cells: IV07CrossArchetypeCellReport[];
    aggregate: IV07CrossArchetypeAggregate;
    assessment: IV07CrossArchetypeAssessment;
}

export interface IV07CrossArchetypeDependencies {
    runCell: (spec: IV07CrossArchetypeCellSpec, concurrency: number) => Promise<IV07CrossArchetypeCellReport>;
    now: () => Date;
    revision: () => IRevisionProvenance;
    command: () => string[];
    cwd: () => string;
    loadCheckpoint: (
        spec: IV07CrossArchetypeCellSpec,
        runFingerprint: string,
    ) => IV07CrossArchetypeCellReport | undefined;
    saveCheckpoint: (cell: IV07CrossArchetypeCellReport, runFingerprint: string) => void;
    onCellComplete: (cell: IV07CrossArchetypeCellReport, completed: number, total: number, resumed: boolean) => void;
}

const DEFAULT_DEPENDENCIES: IV07CrossArchetypeDependencies = {
    runCell: runV07CrossArchetypeCell,
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

export async function runV07CrossArchetypeEvidence(
    options: IV07CrossArchetypeOptions,
    dependencies: Partial<IV07CrossArchetypeDependencies> = {},
): Promise<IV07CrossArchetypeReport> {
    validateV07CrossArchetypeOptions(options);
    const ambient = behaviorEnvironment();
    if (ambient.length) {
        throw new Error(
            `Refusing cross-archetype evidence under behavior-changing environment: ${ambient.join(", ")}. ` +
                "Unset these variables; the harness evaluates committed defaults only.",
        );
    }
    const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
    const revision = deps.revision();
    const fingerprint = v07CrossArchetypeRunFingerprint(options, revision);
    const started = deps.now();
    const specs = buildV07CrossArchetypeCellSpecs(options);
    const cells: IV07CrossArchetypeCellReport[] = [];
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
        revision.branch === revisionAtCompletion.branch &&
        revision.trackedClean === revisionAtCompletion.trackedClean &&
        revision.trackedDiffSha256 === revisionAtCompletion.trackedDiffSha256;
    const completed = deps.now();
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
        protocol: V07_CROSS_ARCHETYPE_PROTOCOL,
        requested: options,
        effectiveConfig: {
            preset: "LiveTwin fight/setup",
            amountMode: "expBudget",
            stackExperienceBudget: STACK_EXPERIENCE_BUDGET,
            composition: DEFAULT_ROSTER_COMPOSITION,
            setup: { ...setup, noVision: true },
            map: "NORMAL",
            independentFixedRosters: true,
            quartetSideAndRosterBalance: true,
            assignments: V07_CROSS_QUARTET_ASSIGNMENTS,
            environmentPolicy: "committed-defaults-only",
            branchExposurePolicy: "diagnostic expected counts from validated rosters; not runtime instrumentation",
            matchups: V07_CROSS_ARCHETYPE_MATCHUPS.map(matchupDefinition),
            templates: V07_ARCHETYPE_TEMPLATES,
        },
        cells,
        aggregate: aggregateV07CrossArchetypeCells(cells),
        assessment: assessV07CrossArchetypeEvidence(options, revision, cells, revisionStable),
    };
}

export function readV07CrossArchetypeSeedManifest(manifestPath: string): {
    manifest: IV07CrossArchetypeSeedManifest;
    provenance: IV07CrossArchetypeManifestProvenance;
} {
    const sourcePath = resolve(manifestPath);
    const raw = readFileSync(sourcePath, "utf8");
    const manifest = JSON.parse(raw) as IV07CrossArchetypeSeedManifest;
    if (manifest.schemaVersion !== 1) throw new Error(`Unsupported cross-archetype manifest schema in ${sourcePath}`);
    if (!manifest.manifestId?.trim()) throw new Error(`Manifest ${sourcePath} requires a non-empty manifestId`);
    if (!manifest.createdAt || !Number.isFinite(Date.parse(manifest.createdAt))) {
        throw new Error(`Manifest ${sourcePath} requires an ISO createdAt timestamp`);
    }
    if (!manifest.declaration?.trim()) throw new Error(`Manifest ${sourcePath} requires a freshness declaration`);
    if (
        manifest.candidate !== V07_CROSS_ARCHETYPE_PROTOCOL.candidate ||
        manifest.opponent !== V07_CROSS_ARCHETYPE_PROTOCOL.opponent ||
        manifest.gamesPerCell !== V07_CROSS_ARCHETYPE_PROTOCOL.gamesPerCell
    ) {
        throw new Error(
            `Manifest ${sourcePath} must preregister v0.7 vs v0.6 at ` +
                `${V07_CROSS_ARCHETYPE_PROTOCOL.gamesPerCell} games/cell`,
        );
    }
    if (!manifest.cells || !sameMembers(Object.keys(manifest.cells), V07_CROSS_ARCHETYPE_MATCHUPS)) {
        throw new Error(`Manifest ${sourcePath} must define exactly the four fixed cross-archetype cells`);
    }
    const options: IV07CrossArchetypeOptions = {
        candidate: manifest.candidate,
        opponent: manifest.opponent,
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
    validateV07CrossArchetypeOptions(options);
    return { manifest, provenance: options.seedManifest! };
}

export function parseV07CrossArchetypeArgs(argv: string[], cwd = process.cwd()): IV07CrossArchetypeCliOptions {
    const parsed = parseArgs({
        args: argv,
        allowPositionals: false,
        strict: true,
        options: {
            manifest: { type: "string" },
            concurrency: { type: "string", default: String(Math.min(12, Math.max(1, availableParallelism()))) },
            output: { type: "string" },
            "checkpoint-dir": { type: "string" },
            help: { type: "boolean", short: "h", default: false },
        },
    });
    if (parsed.values.help) {
        throw new Error(
            "usage: bun src/simulation/v0_7_cross_archetype.ts --manifest=panel.json " +
                "[--concurrency=12] [--checkpoint-dir=dir] [--output=report.json]",
        );
    }
    if (!parsed.values.manifest) throw new Error("--manifest is required; powered evidence must be preregistered");
    const loaded = readV07CrossArchetypeSeedManifest(resolve(cwd, parsed.values.manifest));
    const outputPath = resolve(
        cwd,
        parsed.values.output ?? join("sim-out", "v0_7_cross_archetype", `${loaded.manifest.manifestId}.json`),
    );
    const options: IV07CrossArchetypeCliOptions = {
        candidate: loaded.manifest.candidate,
        opponent: loaded.manifest.opponent,
        gamesPerCell: loaded.manifest.gamesPerCell,
        seeds: loaded.manifest.cells,
        concurrency: Number(parsed.values.concurrency),
        seedsDeclaredFresh: loaded.manifest.freshSeedsDeclared,
        seedManifest: loaded.provenance,
        outputPath,
        checkpointDir: resolve(cwd, parsed.values["checkpoint-dir"] ?? `${outputPath}.cells`),
    };
    validateV07CrossArchetypeOptions(options);
    return options;
}

export function writeV07CrossArchetypeReport(report: IV07CrossArchetypeReport, outputPath: string): void {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(
        `${outputPath}.gates.json`,
        `${JSON.stringify(
            {
                schemaVersion: 1,
                candidate: report.requested.candidate,
                opponent: report.requested.opponent,
                revision: report.provenance.revision.commit,
                revisionAtCompletion: report.provenance.revisionAtCompletion.commit,
                revisionStable: report.provenance.revisionStable,
                runFingerprint: report.provenance.runFingerprint,
                evidenceVerdict: report.assessment.evidenceVerdict,
                protocolPowered: report.assessment.protocolPowered,
                protocolCompletenessReasons: report.assessment.protocolCompletenessReasons,
                gates: report.assessment.gates,
                expectedBranchExposures: report.aggregate.expectedBranchExposures,
                branchExposurePolicy: report.assessment.branchExposurePolicy,
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
    const cli = parseV07CrossArchetypeArgs(argv);
    const { outputPath, checkpointDir, ...options } = cli;
    console.log(
        `v0.7 cross-archetype evidence: ${V07_CROSS_ARCHETYPE_MATCHUPS.length} cells x ` +
            `${options.gamesPerCell} games; ${options.candidate} vs ${options.opponent}`,
    );
    const report = await runV07CrossArchetypeEvidence(options, {
        loadCheckpoint: (spec, fingerprint) => loadV07CrossArchetypeCheckpoint(checkpointDir, spec, fingerprint),
        saveCheckpoint: (cell, fingerprint) => saveV07CrossArchetypeCheckpoint(checkpointDir, cell, fingerprint),
        onCellComplete: (cell, completed, total, resumed) => {
            console.log(
                `[${completed}/${total}]${resumed ? " [resumed]" : ""} ${cell.spec.matchup} ` +
                    `seed=${cell.spec.baseSeed} ${percent(cell.outcomes.candidateWinRate)}`,
            );
        },
    });
    writeV07CrossArchetypeReport(report, outputPath);
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
