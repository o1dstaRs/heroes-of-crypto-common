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

import { mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { parseArgs } from "node:util";

import { creatureInfo, DEFAULT_DRAFT_W, DRAFT_ANCHOR_W, scoreCreatureWeighted } from "../ai/setup/creature_score";
import { getUpgradePoints } from "../perks/perk_properties";
import { PBTypes } from "../generated/protobuf/v1/types";
import { FightStateManager } from "../fights/fight_state_manager";
import {
    creaturesByLevel,
    DEFAULT_AMOUNT_BY_LEVEL,
    DEFAULT_ROSTER_COMPOSITION,
    makeRng,
    resolveStackAmount,
    type IArmyUnitSpec,
    type IRosterComposition,
} from "./army";
import { runMatch, type IMatchConfig, type IMatchResult, type ISetupAugment, type Side } from "./battle_engine";
import { creatureIdForName, DEFAULT_OFFER_K } from "./draft";
import { LIVETWIN_PRESET, liveTwinSetup } from "./livetwin";

/**
 * B1 week-one falsifier. This deliberately remains an offer-proxy harness: the real pick phase (bans,
 * bundles, snake order, collisions and T2 picks) does not exist in common yet. Do not turn this result into
 * the roadmap's oracle-counter-picker verdict; that verdict needs pick_sim and 5,000 fresh samples.
 */

export const ARCHETYPE_NAMES = ["melee_coevo", "flyer_max", "ranged_max_sniper3", "hybrid", "anchor"] as const;

export type ArchetypeName = (typeof ARCHETYPE_NAMES)[number];
export type Rng = () => number;
export type RngFactory = (seed: number) => Rng;
export type HybridRole = "melee" | "ranged" | "flyer";

export const FROZEN_FIGHT_VERSION = "v0.6";
export const HYBRID_ROLE_CYCLE: readonly HybridRole[] = ["melee", "melee", "ranged", "flyer"];

export interface IArchetypeSetup {
    perk: number;
    augments: ISetupAugment[];
}

export interface IArchetypeDefinition {
    name: ArchetypeName;
    draftRule: string;
    setupRule: string;
    setup: IArchetypeSetup;
    weights?: readonly number[];
}

/** Sniper3 is pinned first; the remaining SEE_NONE budget follows the committed LiveTwin augment order. */
function rangedMaxSetup(): IArchetypeSetup {
    const anchor = liveTwinSetup();
    let remaining = getUpgradePoints(anchor.perk) - 3;
    if (remaining < 0) {
        throw new Error("LiveTwin perk budget cannot fund the ranged_max Sniper3 pin");
    }
    const augments: ISetupAugment[] = [{ kind: "Sniper", value: 3 }];
    for (const augment of anchor.augments) {
        if (remaining <= 0) {
            break;
        }
        if (augment.kind === "Sniper") {
            continue;
        }
        const value = Math.min(augment.value, remaining);
        if (value > 0) {
            augments.push({ kind: augment.kind, value });
            remaining -= value;
        }
    }
    return { perk: anchor.perk, augments };
}

export function setupForArchetype(name: ArchetypeName): IArchetypeSetup {
    const setup = name === "ranged_max_sniper3" ? rangedMaxSetup() : liveTwinSetup();
    return {
        perk: setup.perk,
        augments: setup.augments.map((augment) => ({ ...augment })),
    };
}

export const ARCHETYPE_DEFINITIONS: Readonly<Record<ArchetypeName, IArchetypeDefinition>> = {
    melee_coevo: {
        name: "melee_coevo",
        draftRule: "Rank each common seeded offer by the committed co-evolution draft vector.",
        setupRule: "Committed LiveTwin SEE_NONE + Armor3/Might3/Sniper1.",
        setup: setupForArchetype("melee_coevo"),
        weights: DEFAULT_DRAFT_W,
    },
    flyer_max: {
        name: "flyer_max",
        draftRule: "Lexicographically maximize canFly in each common offer; break ties by anchor score.",
        setupRule: "Committed LiveTwin SEE_NONE + Armor3/Might3/Sniper1.",
        setup: setupForArchetype("flyer_max"),
    },
    ranged_max_sniper3: {
        name: "ranged_max_sniper3",
        draftRule: "Lexicographically maximize ranged stacks in each common offer; break ties by anchor score.",
        setupRule: "SEE_NONE + pinned Sniper3, then LiveTwin order with the remaining budget: Armor3/Might1.",
        setup: setupForArchetype("ranged_max_sniper3"),
    },
    hybrid: {
        name: "hybrid",
        draftRule:
            "Fill the six LiveTwin slots with the repeating M,M,R,F role cycle; use anchor score within a role " +
            "and anchor fallback when that role is absent from the level offer.",
        setupRule: "Committed LiveTwin SEE_NONE + Armor3/Might3/Sniper1.",
        setup: setupForArchetype("hybrid"),
    },
    anchor: {
        name: "anchor",
        draftRule: "Rank each common seeded offer by the pre-training anchor draft vector.",
        setupRule: "Committed LiveTwin SEE_NONE + Armor3/Might3/Sniper1.",
        setup: setupForArchetype("anchor"),
        weights: DRAFT_ANCHOR_W,
    },
};

export interface IArchetypeCandidate {
    id: number;
    faction: string;
    creatureName: string;
    level: number;
    size: number;
    canFly: boolean;
    melee: boolean;
    ranged: boolean;
    anchorScore: number;
}

export interface IArchetypeOffer {
    level: number;
    count: number;
    candidates: IArchetypeCandidate[];
}

export interface IHybridRoleSelection {
    role: HybridRole;
    creatureName: string;
    fallback: boolean;
}

export interface IArchetypeRoster {
    roster: IArmyUnitSpec[];
    hybridRoleFallbacks: number;
    hybridRoleSelections: IHybridRoleSelection[];
}

function randomIndex(rng: Rng, length: number): number {
    const value = rng();
    if (!Number.isFinite(value) || value < 0 || value >= 1) {
        throw new Error(`Injected RNG must return a finite value in [0, 1); got ${value}`);
    }
    return Math.floor(value * length);
}

function sampleOffer<T>(values: readonly T[], count: number, rng: Rng): T[] {
    const sampled = values.slice();
    const n = Math.min(count, sampled.length);
    for (let i = 0; i < n; i += 1) {
        const j = i + randomIndex(rng, sampled.length - i);
        [sampled[i], sampled[j]] = [sampled[j], sampled[i]];
    }
    return sampled.slice(0, n);
}

/** Build the one seeded offer that every archetype in a game ranks. RNG is injected for pick_sim parity work. */
export function buildSharedArchetypeOffers(
    rng: Rng,
    composition: readonly IRosterComposition[] = DEFAULT_ROSTER_COMPOSITION,
    offerK: number = DEFAULT_OFFER_K,
): IArchetypeOffer[] {
    return composition.map(({ level, count }) => {
        const eligible = creaturesByLevel(level).map((creature): IArchetypeCandidate => {
            const id = creatureIdForName(creature.creatureName);
            const info = creatureInfo(id);
            if (!info) {
                throw new Error(`Enabled creature ${creature.creatureName} has no draft metadata`);
            }
            return {
                id,
                faction: creature.faction,
                creatureName: creature.creatureName,
                level: creature.level,
                size: creature.size,
                canFly: info.canFly,
                melee: info.melee,
                ranged: info.ranged,
                anchorScore: scoreCreatureWeighted(id, DRAFT_ANCHOR_W),
            };
        });
        if (eligible.length < count) {
            throw new Error(`Level ${level} has ${eligible.length} eligible creatures for ${count} roster slots`);
        }
        return {
            level,
            count,
            candidates: sampleOffer(eligible, Math.max(offerK, count), rng),
        };
    });
}

const nameTieBreak = (a: IArchetypeCandidate, b: IArchetypeCandidate): number =>
    a.creatureName < b.creatureName ? -1 : a.creatureName > b.creatureName ? 1 : 0;

const byScore =
    (weights: readonly number[]) =>
    (a: IArchetypeCandidate, b: IArchetypeCandidate): number =>
        scoreCreatureWeighted(b.id, weights) - scoreCreatureWeighted(a.id, weights) ||
        b.anchorScore - a.anchorScore ||
        nameTieBreak(a, b);

const byFlyer = (a: IArchetypeCandidate, b: IArchetypeCandidate): number =>
    Number(b.canFly) - Number(a.canFly) || b.anchorScore - a.anchorScore || nameTieBreak(a, b);

const byRanged = (a: IArchetypeCandidate, b: IArchetypeCandidate): number =>
    Number(b.ranged) - Number(a.ranged) || b.anchorScore - a.anchorScore || nameTieBreak(a, b);

const matchesRole = (candidate: IArchetypeCandidate, role: HybridRole): boolean =>
    role === "flyer" ? candidate.canFly : role === "ranged" ? candidate.ranged : candidate.melee;

function scriptedPicks(
    name: ArchetypeName,
    offers: readonly IArchetypeOffer[],
): { picks: IArchetypeCandidate[]; fallbacks: number; roleSelections: IHybridRoleSelection[] } {
    if (name !== "hybrid") {
        const compare =
            name === "melee_coevo"
                ? byScore(DEFAULT_DRAFT_W)
                : name === "anchor"
                  ? byScore(DRAFT_ANCHOR_W)
                  : name === "flyer_max"
                    ? byFlyer
                    : byRanged;
        return {
            picks: offers.flatMap((offer) => offer.candidates.slice().sort(compare).slice(0, offer.count)),
            fallbacks: 0,
            roleSelections: [],
        };
    }

    const picks: IArchetypeCandidate[] = [];
    const roleSelections: IHybridRoleSelection[] = [];
    let fallbacks = 0;
    let slot = 0;
    for (const offer of offers) {
        const remaining = offer.candidates.slice();
        for (let i = 0; i < offer.count; i += 1) {
            const role = HYBRID_ROLE_CYCLE[slot % HYBRID_ROLE_CYCLE.length];
            slot += 1;
            const matching = remaining.filter((candidate) => matchesRole(candidate, role));
            const fallback = matching.length === 0;
            const pool = fallback ? remaining : matching;
            const selected = pool.slice().sort(byScore(DRAFT_ANCHOR_W))[0];
            if (!selected) {
                throw new Error(`Level ${offer.level} offer was exhausted while filling hybrid slot ${slot}`);
            }
            remaining.splice(remaining.indexOf(selected), 1);
            picks.push(selected);
            if (fallback) {
                fallbacks += 1;
            }
            roleSelections.push({ role, creatureName: selected.creatureName, fallback });
        }
    }
    return { picks, fallbacks, roleSelections };
}

export function buildArchetypeRoster(name: ArchetypeName, offers: readonly IArchetypeOffer[]): IArchetypeRoster {
    const { picks, fallbacks, roleSelections } = scriptedPicks(name, offers);
    return {
        roster: picks.map((pick) => ({
            faction: pick.faction,
            creatureName: pick.creatureName,
            level: pick.level,
            size: pick.size,
            amount: resolveStackAmount(
                pick.creatureName,
                pick.level,
                DEFAULT_AMOUNT_BY_LEVEL,
                LIVETWIN_PRESET.amountMode,
            ),
        })),
        hybridRoleFallbacks: fallbacks,
        hybridRoleSelections: roleSelections,
    };
}

export interface IPayoffCell {
    id: string;
    archetypeA: ArchetypeName;
    archetypeB: ArchetypeName;
    control: boolean;
}

function payoffCells(): IPayoffCell[] {
    const cells: IPayoffCell[] = [
        {
            id: "melee_coevo_control",
            archetypeA: "melee_coevo",
            archetypeB: "melee_coevo",
            control: true,
        },
    ];
    for (let i = 0; i < ARCHETYPE_NAMES.length; i += 1) {
        for (let j = i + 1; j < ARCHETYPE_NAMES.length; j += 1) {
            cells.push({
                id: `${ARCHETYPE_NAMES[i]}_vs_${ARCHETYPE_NAMES[j]}`,
                archetypeA: ARCHETYPE_NAMES[i],
                archetypeB: ARCHETYPE_NAMES[j],
                control: false,
            });
        }
    }
    return cells;
}

/** Ten unordered cross-archetype matchups plus the roadmap's explicit melee mirror control. */
export const PAYOFF_CELLS: readonly IPayoffCell[] = payoffCells();

export interface IArchetypePayoffOptions {
    /** Games in every cell, including both sides of each mirrored pair. Must be even. */
    gamesPerCell: number;
    baseSeed: number;
    maxLaps?: number;
}

export interface INormalizedArchetypePayoffOptions extends IArchetypePayoffOptions {
    gamesPerCell: number;
    baseSeed: number;
}

export interface IArchetypeGameRecord {
    cellId: string;
    game: number;
    seed: number;
    greenSlot: "a" | "b";
    greenArchetype: ArchetypeName;
    redArchetype: ArchetypeName;
    greenRoster: string;
    redRoster: string;
    winnerSide: Side | "draw";
    winnerSlot: "a" | "b" | "draw";
    laps: number;
    endReason: IMatchResult["endReason"];
    decidedByArmageddon: boolean;
    hybridRosterBuilds: number;
    hybridRoleFallbacks: number;
}

export interface IArchetypeMatchOutcome {
    winner: Side | "draw";
    laps: number;
    endReason: IMatchResult["endReason"];
    attrition: { decidedByArmageddon: boolean };
}

export interface IArchetypePayoffDependencies {
    rngFactory?: RngFactory;
    matchRunner?: (config: IMatchConfig) => IArchetypeMatchOutcome;
}

function normalizeOptions(options: IArchetypePayoffOptions): INormalizedArchetypePayoffOptions {
    const gamesPerCell = Number(options.gamesPerCell);
    const baseSeed = Number(options.baseSeed);
    if (!Number.isSafeInteger(gamesPerCell) || gamesPerCell < 2 || gamesPerCell % 2 !== 0) {
        throw new Error(`gamesPerCell must be a positive even integer >= 2; got ${options.gamesPerCell}`);
    }
    if (!Number.isSafeInteger(baseSeed)) {
        throw new Error(`baseSeed must be a safe integer; got ${options.baseSeed}`);
    }
    if (options.maxLaps !== undefined && (!Number.isSafeInteger(options.maxLaps) || options.maxLaps < 1)) {
        throw new Error(`maxLaps must be a positive integer; got ${options.maxLaps}`);
    }
    return { gamesPerCell, baseSeed, ...(options.maxLaps === undefined ? {} : { maxLaps: options.maxLaps }) };
}

const rosterSignature = (roster: readonly IArmyUnitSpec[]): string =>
    roster.map((unit) => `L${unit.level}:${unit.creatureName}x${unit.amount}`).join("|");

/** Play one independently addressable game. Games 2k/2k+1 share offers + combat seed and swap A/B sides. */
export function playArchetypeGame(
    cell: IPayoffCell,
    options: IArchetypePayoffOptions,
    game: number,
    dependencies: IArchetypePayoffDependencies = {},
): IArchetypeGameRecord {
    const normalized = normalizeOptions(options);
    if (!Number.isSafeInteger(game) || game < 0 || game >= normalized.gamesPerCell) {
        throw new Error(`game must be in [0, ${normalized.gamesPerCell}); got ${game}`);
    }
    const pairIndex = Math.floor(game / 2);
    const seed = (normalized.baseSeed + pairIndex * 0x9e3779b1) >>> 0;
    const rngFactory = dependencies.rngFactory ?? makeRng;
    const offers = buildSharedArchetypeOffers(rngFactory(seed));
    const rosterA = buildArchetypeRoster(cell.archetypeA, offers);
    const rosterB = buildArchetypeRoster(cell.archetypeB, offers);
    const setupA = setupForArchetype(cell.archetypeA);
    const setupB = setupForArchetype(cell.archetypeB);
    const aIsGreen = game % 2 === 0;
    const greenArchetype = aIsGreen ? cell.archetypeA : cell.archetypeB;
    const redArchetype = aIsGreen ? cell.archetypeB : cell.archetypeA;
    const greenRoster = aIsGreen ? rosterA : rosterB;
    const redRoster = aIsGreen ? rosterB : rosterA;
    const greenSetup = aIsGreen ? setupA : setupB;
    const redSetup = aIsGreen ? setupB : setupA;
    // FightStateManager is lazy. Its constructor creates a FightProperties once before runMatch immediately
    // replaces it; if that first construction happens inside runMatch's seeded scope, only the first game in a
    // worker consumes an extra RNG draw. Prime it outside that scope so results do not depend on worker schedule.
    const matchRunner =
        dependencies.matchRunner ??
        ((config: IMatchConfig): IMatchResult => {
            FightStateManager.getInstance();
            return runMatch(config);
        });
    const result = matchRunner({
        greenVersion: FROZEN_FIGHT_VERSION,
        redVersion: FROZEN_FIGHT_VERSION,
        roster: greenRoster.roster,
        redRoster: redRoster.roster,
        seed,
        gridType: PBTypes.GridVals.NORMAL,
        maxLaps: normalized.maxLaps,
        greenPerk: greenSetup.perk,
        redPerk: redSetup.perk,
        greenAugments: greenSetup.augments,
        redAugments: redSetup.augments,
    });
    const winnerSlot =
        result.winner === "draw" ? "draw" : result.winner === "green" ? (aIsGreen ? "a" : "b") : aIsGreen ? "b" : "a";
    return {
        cellId: cell.id,
        game,
        seed,
        greenSlot: aIsGreen ? "a" : "b",
        greenArchetype,
        redArchetype,
        greenRoster: rosterSignature(greenRoster.roster),
        redRoster: rosterSignature(redRoster.roster),
        winnerSide: result.winner,
        winnerSlot,
        laps: result.laps,
        endReason: result.endReason,
        decidedByArmageddon: result.attrition.decidedByArmageddon,
        hybridRosterBuilds: Number(cell.archetypeA === "hybrid") + Number(cell.archetypeB === "hybrid"),
        hybridRoleFallbacks: rosterA.hybridRoleFallbacks + rosterB.hybridRoleFallbacks,
    };
}

interface ICellTally {
    winsA: number;
    winsB: number;
    draws: number;
    greenWins: number;
    redWins: number;
    laps: number;
    armageddonDecided: number;
    endReasons: Record<string, number>;
    hybridRosterBuilds: number;
    hybridRoleFallbacks: number;
}

export interface IPayoffCellSummary extends IPayoffCell {
    games: number;
    winsA: number;
    winsB: number;
    draws: number;
    decisiveGames: number;
    decisiveRate: number;
    decisiveWinRateA: number;
    greenWins: number;
    redWins: number;
    decisiveGreenWinRate: number;
    avgLaps: number;
    armageddonDecided: number;
    endReasons: Record<string, number>;
    hybridRosterBuilds: number;
    hybridRoleFallbacks: number;
}

export interface IPayoffMatrixEntry {
    cellId: string;
    decisiveWinRate: number;
    decisiveRate: number;
}

export interface IMeleeChallengeSummary {
    threshold: number;
    bestArchetype: Exclude<ArchetypeName, "melee_coevo">;
    bestDecisiveWinRate: number;
    anyAtOrAboveThreshold: boolean;
    rates: Record<Exclude<ArchetypeName, "melee_coevo">, number>;
}

export interface IArchetypePayoffSummary {
    schemaVersion: 1;
    status: "exploratory_offer_proxy";
    fightVersion: typeof FROZEN_FIGHT_VERSION;
    gamesPerCell: number;
    totalGames: number;
    baseSeed: number;
    config: {
        amountMode: typeof LIVETWIN_PRESET.amountMode;
        grid: "NORMAL";
        perk: number;
        baseAugments: ISetupAugment[];
        pairedSideSwap: true;
        commonOffersAcrossArchetypes: true;
        offerK: number;
        rosterComposition: readonly IRosterComposition[];
    };
    definitions: Readonly<Record<ArchetypeName, IArchetypeDefinition>>;
    cells: IPayoffCellSummary[];
    matrix: Record<ArchetypeName, Record<ArchetypeName, IPayoffMatrixEntry | null>>;
    controlCell: IPayoffCellSummary;
    meleeChallenge: IMeleeChallengeSummary;
    provenance: {
        rng: string;
        pairSeed: string;
        hybridRoleCycle: readonly HybridRole[];
        hybridSixSlotPlan: readonly HybridRole[];
        hybridRosterBuilds: number;
        hybridRoleFallbacks: number;
        hybridRoleFallbackRate: number;
    };
    limitations: string[];
}

function emptyTally(): ICellTally {
    return {
        winsA: 0,
        winsB: 0,
        draws: 0,
        greenWins: 0,
        redWins: 0,
        laps: 0,
        armageddonDecided: 0,
        endReasons: {},
        hybridRosterBuilds: 0,
        hybridRoleFallbacks: 0,
    };
}

function tallyRecord(tally: ICellTally, record: IArchetypeGameRecord): void {
    if (record.winnerSlot === "a") tally.winsA += 1;
    else if (record.winnerSlot === "b") tally.winsB += 1;
    else tally.draws += 1;
    if (record.winnerSide === "green") tally.greenWins += 1;
    else if (record.winnerSide === "red") tally.redWins += 1;
    tally.laps += record.laps;
    tally.armageddonDecided += Number(record.decidedByArmageddon);
    tally.endReasons[record.endReason] = (tally.endReasons[record.endReason] ?? 0) + 1;
    tally.hybridRosterBuilds += record.hybridRosterBuilds;
    tally.hybridRoleFallbacks += record.hybridRoleFallbacks;
}

function finalizeCell(cell: IPayoffCell, tally: ICellTally, games: number): IPayoffCellSummary {
    const decisiveGames = tally.winsA + tally.winsB;
    const sideDecisions = tally.greenWins + tally.redWins;
    return {
        ...cell,
        games,
        winsA: tally.winsA,
        winsB: tally.winsB,
        draws: tally.draws,
        decisiveGames,
        decisiveRate: decisiveGames / games,
        decisiveWinRateA: decisiveGames ? tally.winsA / decisiveGames : 0.5,
        greenWins: tally.greenWins,
        redWins: tally.redWins,
        decisiveGreenWinRate: sideDecisions ? tally.greenWins / sideDecisions : 0.5,
        avgLaps: tally.laps / games,
        armageddonDecided: tally.armageddonDecided,
        endReasons: tally.endReasons,
        hybridRosterBuilds: tally.hybridRosterBuilds,
        hybridRoleFallbacks: tally.hybridRoleFallbacks,
    };
}

function buildMatrix(cells: readonly IPayoffCellSummary[]): IArchetypePayoffSummary["matrix"] {
    const matrix = Object.fromEntries(
        ARCHETYPE_NAMES.map((row) => [row, Object.fromEntries(ARCHETYPE_NAMES.map((column) => [column, null]))]),
    ) as IArchetypePayoffSummary["matrix"];
    for (const cell of cells) {
        matrix[cell.archetypeA][cell.archetypeB] = {
            cellId: cell.id,
            decisiveWinRate: cell.decisiveWinRateA,
            decisiveRate: cell.decisiveRate,
        };
        if (cell.archetypeA !== cell.archetypeB) {
            matrix[cell.archetypeB][cell.archetypeA] = {
                cellId: cell.id,
                decisiveWinRate: 1 - cell.decisiveWinRateA,
                decisiveRate: cell.decisiveRate,
            };
        }
    }
    return matrix;
}

function summarizeTallies(
    options: INormalizedArchetypePayoffOptions,
    tallies: ReadonlyMap<string, ICellTally>,
): IArchetypePayoffSummary {
    const cells = PAYOFF_CELLS.map((cell) =>
        finalizeCell(cell, tallies.get(cell.id) ?? emptyTally(), options.gamesPerCell),
    );
    const controlCell = cells.find((cell) => cell.control);
    if (!controlCell) {
        throw new Error("Payoff matrix is missing the melee_coevo control cell");
    }
    const challengers = ARCHETYPE_NAMES.filter(
        (name): name is Exclude<ArchetypeName, "melee_coevo"> => name !== "melee_coevo",
    );
    const rates = Object.fromEntries(
        challengers.map((challenger) => {
            const cell = cells.find(
                (candidate) =>
                    !candidate.control &&
                    ((candidate.archetypeA === "melee_coevo" && candidate.archetypeB === challenger) ||
                        (candidate.archetypeB === "melee_coevo" && candidate.archetypeA === challenger)),
            );
            if (!cell) {
                throw new Error(`Missing melee_coevo matchup for ${challenger}`);
            }
            const rate = cell.archetypeA === challenger ? cell.decisiveWinRateA : 1 - cell.decisiveWinRateA;
            return [challenger, rate];
        }),
    ) as IMeleeChallengeSummary["rates"];
    const bestArchetype = challengers.reduce((best, candidate) => (rates[candidate] > rates[best] ? candidate : best));
    const hybridRosterBuilds = cells.reduce((sum, cell) => sum + cell.hybridRosterBuilds, 0);
    const hybridRoleFallbacks = cells.reduce((sum, cell) => sum + cell.hybridRoleFallbacks, 0);
    const baseSetup = liveTwinSetup();
    return {
        schemaVersion: 1,
        status: "exploratory_offer_proxy",
        fightVersion: FROZEN_FIGHT_VERSION,
        gamesPerCell: options.gamesPerCell,
        totalGames: PAYOFF_CELLS.length * options.gamesPerCell,
        baseSeed: options.baseSeed,
        config: {
            amountMode: LIVETWIN_PRESET.amountMode,
            grid: "NORMAL",
            perk: baseSetup.perk,
            baseAugments: baseSetup.augments,
            pairedSideSwap: true,
            commonOffersAcrossArchetypes: true,
            offerK: DEFAULT_OFFER_K,
            rosterComposition: DEFAULT_ROSTER_COMPOSITION,
        },
        definitions: ARCHETYPE_DEFINITIONS,
        cells,
        matrix: buildMatrix(cells),
        controlCell,
        meleeChallenge: {
            threshold: 0.55,
            bestArchetype,
            bestDecisiveWinRate: rates[bestArchetype],
            anyAtOrAboveThreshold: challengers.some((challenger) => rates[challenger] >= 0.55),
            rates,
        },
        provenance: {
            rng: "Injected RNG factory; CLI uses army.makeRng (mulberry32).",
            pairSeed: "seed=(baseSeed + floor(game/2)*0x9e3779b1)>>>0; both side swaps reuse it.",
            hybridRoleCycle: HYBRID_ROLE_CYCLE,
            hybridSixSlotPlan: ["melee", "melee", "ranged", "flyer", "melee", "melee"],
            hybridRosterBuilds,
            hybridRoleFallbacks,
            hybridRoleFallbackRate: hybridRosterBuilds ? hybridRoleFallbacks / (hybridRosterBuilds * 6) : 0,
        },
        limitations: [
            "Exploratory only: common six-creature-per-level offers proxy the current draft helper, not the live pick phase.",
            "The proxy omits auto-bans, bundles, snake order, exclusive-pool collisions/reveals and T2 3-of-12 picks.",
            "The full-information oracle counter-picker gate is not measured here; it requires pick_sim and 5,000 fresh samples.",
            "A 55% melee challenger alone is not the roadmap kill verdict; both registered kill-test conditions are required.",
        ],
    };
}

export function runArchetypePayoffSequential(
    options: IArchetypePayoffOptions,
    dependencies: IArchetypePayoffDependencies = {},
    onGame?: (record: IArchetypeGameRecord, completed: number, total: number) => void,
): IArchetypePayoffSummary {
    const normalized = normalizeOptions(options);
    const tallies = new Map(PAYOFF_CELLS.map((cell) => [cell.id, emptyTally()]));
    const total = PAYOFF_CELLS.length * normalized.gamesPerCell;
    let completed = 0;
    for (const cell of PAYOFF_CELLS) {
        for (let game = 0; game < normalized.gamesPerCell; game += 1) {
            const record = playArchetypeGame(cell, normalized, game, dependencies);
            tallyRecord(tallies.get(cell.id)!, record);
            completed += 1;
            onGame?.(record, completed, total);
        }
    }
    return summarizeTallies(normalized, tallies);
}

export async function runArchetypePayoff(
    options: IArchetypePayoffOptions,
    concurrency: number,
    onGame?: (record: IArchetypeGameRecord, completed: number, total: number) => void,
): Promise<IArchetypePayoffSummary> {
    const normalized = normalizeOptions(options);
    const total = PAYOFF_CELLS.length * normalized.gamesPerCell;
    const poolSize = Math.max(1, Math.min(Math.floor(concurrency) || 1, total));
    if (poolSize <= 1) {
        return runArchetypePayoffSequential(normalized, {}, onGame);
    }

    return new Promise<IArchetypePayoffSummary>((resolvePromise, rejectPromise) => {
        const tallies = new Map(PAYOFF_CELLS.map((cell) => [cell.id, emptyTally()]));
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
            if (dispatched >= total) {
                worker.postMessage({ type: "stop" });
                return;
            }
            const cellIndex = Math.floor(dispatched / normalized.gamesPerCell);
            const game = dispatched % normalized.gamesPerCell;
            worker.postMessage({ type: "game", cellIndex, game });
            dispatched += 1;
        };
        const workerUrl = new URL("./archetype_payoff_worker.ts", import.meta.url);
        for (let i = 0; i < poolSize; i += 1) {
            let worker: Worker;
            try {
                worker = new Worker(workerUrl, { workerData: { options: normalized } });
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
                        | { type: "result"; record: IArchetypeGameRecord }
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
                    tallyRecord(tallies.get(message.record.cellId)!, message.record);
                    completed += 1;
                    onGame?.(message.record, completed, total);
                    if (completed >= total) {
                        settled = true;
                        const summary = summarizeTallies(normalized, tallies);
                        cleanup();
                        resolvePromise(summary);
                        return;
                    }
                    dispatchNext(worker);
                },
            );
            worker.on("error", fail);
        }
    });
}

function positiveInteger(value: string, flag: string): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error(`${flag} must be a positive integer; got ${value}`);
    }
    return parsed;
}

function printUsage(): void {
    console.log(
        "usage: bun src/simulation/archetype_payoff.ts [--games 2000] [--seed 1] " +
            "[--concurrency 12] [--output sim-out/archetype_payoff.summary.json]",
    );
    console.log("  --games        games per cell; must be even (default 2000)");
    console.log("  --seed         base seed shared across every cell (default 1)");
    console.log("  --concurrency  worker threads (default min(12, available cores))");
    console.log("  --output       summary JSON path; use '-' for stdout");
}

export async function main(): Promise<void> {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            games: { type: "string", default: "2000" },
            seed: { type: "string", default: "1" },
            concurrency: { type: "string", default: String(Math.min(12, Math.max(1, availableParallelism()))) },
            output: { type: "string" },
            help: { type: "boolean", short: "h", default: false },
        },
        strict: true,
        allowPositionals: false,
    });
    if (values.help) {
        printUsage();
        return;
    }
    const gamesPerCell = positiveInteger(values.games, "--games");
    if (gamesPerCell % 2 !== 0) {
        throw new Error(`--games must be even for paired side swaps; got ${gamesPerCell}`);
    }
    const baseSeed = Number(values.seed);
    if (!Number.isSafeInteger(baseSeed)) {
        throw new Error(`--seed must be a safe integer; got ${values.seed}`);
    }
    const concurrency = positiveInteger(values.concurrency, "--concurrency");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const output = values.output ?? join(process.cwd(), "sim-out", `archetype_payoff_${stamp}.summary.json`);
    const total = PAYOFF_CELLS.length * gamesPerCell;
    console.error(
        `Running exploratory B1 payoff proxy: ${PAYOFF_CELLS.length} cells x ${gamesPerCell} = ${total} games ` +
            `(seed ${baseSeed}, concurrency ${concurrency}, LiveTwin expBudget/SEE_NONE, frozen ${FROZEN_FIGHT_VERSION})`,
    );
    const progressEvery = Math.max(100, Math.floor(total / 20));
    const summary = await runArchetypePayoff({ gamesPerCell, baseSeed }, concurrency, (_record, completed) => {
        if (completed % progressEvery === 0 || completed === total) {
            console.error(`  ${completed}/${total} games`);
        }
    });
    const json = `${JSON.stringify(summary, null, 2)}\n`;
    if (output === "-") {
        process.stdout.write(json);
    } else {
        const outputPath = resolve(output);
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, json);
        console.error(`Summary: ${outputPath}`);
    }
    console.error(
        `Best challenger vs melee_coevo: ${summary.meleeChallenge.bestArchetype} ` +
            `${(summary.meleeChallenge.bestDecisiveWinRate * 100).toFixed(1)}% decisive; ` +
            `control decisive ${(summary.controlCell.decisiveRate * 100).toFixed(1)}%.`,
    );
    console.error("Exploratory only: the oracle gate remains blocked on pick_sim.");
}

if ((import.meta as unknown as { main?: boolean }).main) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
