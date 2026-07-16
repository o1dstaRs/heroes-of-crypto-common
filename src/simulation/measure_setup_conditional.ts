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
import { parseArgs } from "node:util";
import { isMainThread, parentPort, workerData, Worker } from "node:worker_threads";

import { scoreCreature } from "../ai/setup/creature_score";
import { LEAGUE_ROUND3_DRAFT_SPEC, parseDraftGenome, projectDraftGenomeForShipping } from "../ai/setup/draft_ship";
import {
    conditionalArtifactT2,
    conditionalAugments,
    conditionalSynergies,
    ownComposition,
    parseConditionalRules,
    type ConditionalSetupRule,
} from "../ai/setup/setup_conditional";
import { SETUP_POLICY_V0 } from "../ai/setup/setup_v0";
import { FightStateManager } from "../fights/fight_state_manager";
import { PBTypes } from "../generated/protobuf/v1/types";
import { getUpgradePoints, Perk } from "../perks/perk_properties";
import {
    createPickSimState,
    getCurrentPickPhase,
    getKnownOpponentCreatures,
    getVisibleCreatureChoices,
    isPickSimComplete,
    transitionPickSim,
    type IPickSimState,
    type IPickTeamState,
    type PickRandomInt,
    type PickTeam,
} from "../picks/pick_sim";
import { creaturesByLevel, makeRng, resolveStackAmount, DEFAULT_AMOUNT_BY_LEVEL, type IArmyUnitSpec } from "./army";
import { runMatch, type IMatchResult, type ISetupAugment, type ISetupSynergy } from "./battle_engine";
import { creatureIdForName } from "./draft";
import { pickLeagueBundle, pickLeagueCreature, type ILeagueGenome } from "./league_genome";
import { LIVETWIN_PRESET } from "./livetwin";

/**
 * CONDITIONAL_SETUP_V1 full-game A/B (v0.7 roadmap "Setup" lane).
 *
 * Question: does the own-roster-conditional setup layer (setup_conditional.ts: Sniper3 pin + per-cohort
 * Tier-2 table) beat the composition-blind setup-v0 in complete pick->fight games? Both sides draft with
 * the SAME policy through the REAL pick structure (picks/pick_sim.ts: auto-bans, bundles, snake order,
 * collision reveals, 3-of-12 T2 offers); the arms differ ONLY in setup choices (T2 pick, augment spend,
 * synergies). Fights run the live default v0.7 on both sides under LiveTwin exp-budget stacks, SEE_NONE.
 *
 * Draft distributions (the preregistered ship bar requires both live-relevant ones):
 *   heuristic — setup-v0's scoreCreature argmax (the live untrained draft daemon);
 *   league    — the fresh-v0.7-accepted league round-3 candidate via the committed ship path
 *               (draft_ship.parseDraftGenome + projectDraftGenomeForShipping);
 *   ranged    — ranged-preferring drafts (the cell where the Sniper3 rule must show).
 *
 * Pairing: games 2k/2k+1 share the offer board + combat seed and swap which pick seat arm A occupies, so
 * seat luck cancels; the pair is one statistical cluster for the ratio-estimator sandwich variance.
 * Control cells run static-vs-static and must land EXACTLY 50.00% decisive.
 */

export type DraftDistName = "heuristic" | "league" | "ranged";
export const DRAFT_DIST_NAMES: readonly DraftDistName[] = ["heuristic", "league", "ranged"];

export interface ISetupConditionalCell {
    id: string;
    draft: DraftDistName;
    /** Rules spec for the conditional arm (parseConditionalRules). Ignored for control cells. */
    rules: string;
    /** Control: BOTH arms static — a determinism/fairness check that must return exactly 50.00%. */
    control: boolean;
}

/** The registered cell list: per draft distribution a control, the full rule set, and per-rule ablations. */
export function defaultCells(): ISetupConditionalCell[] {
    const cells: ISetupConditionalCell[] = [];
    for (const draft of DRAFT_DIST_NAMES) {
        cells.push({ id: `${draft}__control`, draft, rules: "off", control: true });
        cells.push({ id: `${draft}__all`, draft, rules: "all", control: false });
        cells.push({ id: `${draft}__sniper`, draft, rules: "sniper", control: false });
        cells.push({ id: `${draft}__t2`, draft, rules: "t2", control: false });
    }
    return cells;
}

// ---------------------------------------------------------------------------------------------------------
// Draft policies (identical on both seats within a cell)
// ---------------------------------------------------------------------------------------------------------

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;

const argmaxId = (candidates: readonly number[], score: (id: number) => number): number => {
    let best = candidates[0];
    let bestScore = -Infinity;
    for (const id of candidates) {
        const s = score(id);
        if (s > bestScore || (s === bestScore && id < best)) {
            bestScore = s;
            best = id;
        }
    }
    return best;
};

const isRanged = (creatureId: number): boolean => !!ownComposition([creatureId]).ranged;

const rangedFirstScore = (id: number): number => (isRanged(id) ? 1_000_000 : 0) + scoreCreature(id);

function chooseBundle(state: IPickSimState, team: PickTeam, draft: DraftDistName, genome?: ILeagueGenome): number {
    const own = team === LOWER ? state.lower : state.upper;
    if (draft === "league") {
        return pickLeagueBundle(state, team, genome!);
    }
    if (draft === "ranged") {
        let bestIndex = 0;
        let bestScore = -Infinity;
        own.bundles.forEach(([l1, l2], index) => {
            const score = rangedFirstScore(l1) + rangedFirstScore(l2);
            if (score > bestScore) {
                bestScore = score;
                bestIndex = index;
            }
        });
        return bestIndex;
    }
    return SETUP_POLICY_V0.pickBundle(own.bundles);
}

function chooseCreature(state: IPickSimState, team: PickTeam, draft: DraftDistName, genome?: ILeagueGenome): number {
    if (draft === "league") {
        return pickLeagueCreature(state, team, genome!);
    }
    const choices = getVisibleCreatureChoices(state, team);
    if (!choices.length) {
        throw new Error("No visible creature choices for the draft policy");
    }
    return argmaxId(choices, draft === "ranged" ? rangedFirstScore : scoreCreature);
}

// ---------------------------------------------------------------------------------------------------------
// Pick driver + army materialization
// ---------------------------------------------------------------------------------------------------------

interface ICatalogRef {
    faction: string;
    creatureName: string;
    level: number;
    size: number;
}

let catalogByIdCache: Map<number, ICatalogRef> | undefined;

const catalogById = (): Map<number, ICatalogRef> => {
    if (!catalogByIdCache) {
        catalogByIdCache = new Map();
        for (let level = 1; level <= 4; level += 1) {
            for (const entry of creaturesByLevel(level)) {
                catalogByIdCache.set(creatureIdForName(entry.creatureName), {
                    faction: entry.faction,
                    creatureName: entry.creatureName,
                    level: entry.level,
                    size: entry.size,
                });
            }
        }
    }
    return catalogByIdCache;
};

export interface IConditionalArmy {
    /** Persisted creature-id order. Ranked createRoster materializes stacks in this order. */
    creatureIds: number[];
    /** Opponent creatures legitimately revealed during this team's pick. */
    revealedOpponentCreatures: number[];
    roster: IArmyUnitSpec[];
    perk: number;
    augments: ISetupAugment[];
    synergies: ISetupSynergy[];
    tier1Artifact: number;
    tier2Artifact: number;
    rangedStacks: number;
    /** Conditional-arm diagnostics: did each rule actually override the static choice for this army? */
    t2Overridden: boolean;
    augmentsOverridden: boolean;
}

interface ITeamSetupOutcome {
    tier2Artifact: number;
    t2Overridden: boolean;
    creaturesAtT2: number[];
}

interface IConditionalPickDriverOptions {
    conditionalTeams: ReadonlySet<PickTeam>;
    preservePickOrder: boolean;
}

/**
 * Drive one complete pick with a single draft policy on both seats; the per-team setup arm decides the T2
 * pick mid-draft (with the creatures known at that phase, as live) and augments/synergies at the end.
 */
export function runConditionalPickGame(
    seed: number,
    draft: DraftDistName,
    conditionalTeam: PickTeam | undefined,
    rules: ReadonlySet<ConditionalSetupRule>,
    genome?: ILeagueGenome,
): { lower: IConditionalArmy; upper: IConditionalArmy } {
    return runConditionalPickGameWithOptions(seed, draft, rules, genome, {
        conditionalTeams: conditionalTeam === undefined ? new Set() : new Set([conditionalTeam]),
        preservePickOrder: false,
    });
}

/**
 * Ranked-composed pick path: round-1 accepted draft plus CONDITIONAL_SETUP_V1 for both seats. Unlike the
 * historical setup A/B helper above, this preserves the pick service's persisted creature order because the
 * authoritative server's createRoster() iterates that array directly and same-size placement is order-sensitive.
 */
export function runRankedConditionalPickGame(
    seed: number,
    rules: ReadonlySet<ConditionalSetupRule>,
    genome: ILeagueGenome,
): { lower: IConditionalArmy; upper: IConditionalArmy } {
    return runConditionalPickGameWithOptions(seed, "league", rules, genome, {
        conditionalTeams: new Set([LOWER, UPPER]),
        preservePickOrder: true,
    });
}

function runConditionalPickGameWithOptions(
    seed: number,
    draft: DraftDistName,
    rules: ReadonlySet<ConditionalSetupRule>,
    genome: ILeagueGenome | undefined,
    options: IConditionalPickDriverOptions,
): { lower: IConditionalArmy; upper: IConditionalArmy } {
    const rng = makeRng(seed >>> 0);
    const rngInt: PickRandomInt = (maxExclusive) => Math.floor(rng() * maxExclusive);
    let state = createPickSimState(rngInt);
    const setupOutcome = new Map<PickTeam, ITeamSetupOutcome>();

    const teamState = (team: PickTeam): IPickTeamState => (team === LOWER ? state.lower : state.upper);
    const accept = (action: Parameters<typeof transitionPickSim>[1]): void => {
        const transition = transitionPickSim(state, action, rngInt);
        if (transition.status !== "accepted") {
            throw new Error(`Setup-conditional pick driver: non-accepted ${action.type} (${transition.reason})`);
        }
        state = transition.state;
    };

    let guard = 0;
    while (!isPickSimComplete(state)) {
        if ((guard += 1) > 300) {
            throw new Error("Pick phase failed to complete within 300 driver iterations");
        }
        const phase = getCurrentPickPhase(state);
        if (phase.phase === PBTypes.PickPhaseVals.PERK) {
            for (const team of [LOWER, UPPER] as const) {
                if (teamState(team).perk === Perk.NO_PERK) {
                    accept({ type: "select_perk", team, perk: SETUP_POLICY_V0.pickPerk() });
                }
            }
        } else if (phase.phase === PBTypes.PickPhaseVals.INITIAL_PICK) {
            for (const team of [LOWER, UPPER] as const) {
                if (teamState(team).selectedBundleIndex === undefined) {
                    accept({ type: "select_bundle", team, bundleIndex: chooseBundle(state, team, draft, genome) });
                }
            }
        } else if (phase.phase === PBTypes.PickPhaseVals.PICK) {
            const team = phase.actors[0];
            const creatureId = chooseCreature(state, team, draft, genome);
            const transition = transitionPickSim(state, { type: "pick_creature", team, creatureId }, rngInt);
            if (transition.status === "rejected") {
                throw new Error(`Creature pick rejected (${transition.reason})`);
            }
            state = transition.state; // collisions reveal a slot; the next iteration re-picks
        } else if (phase.phase === PBTypes.PickPhaseVals.ARTIFACT_2) {
            for (const team of [LOWER, UPPER] as const) {
                const own = teamState(team);
                if (own.tier2Artifact !== undefined) {
                    continue;
                }
                const staticPick = SETUP_POLICY_V0.pickArtifactT2(own.tier2Offers);
                const artifactId = options.conditionalTeams.has(team)
                    ? conditionalArtifactT2(own.tier2Offers, own.creatures, rules)
                    : staticPick;
                setupOutcome.set(team, {
                    tier2Artifact: artifactId,
                    t2Overridden: artifactId !== staticPick,
                    creaturesAtT2: [...own.creatures],
                });
                accept({ type: "select_tier2", team, artifactId });
            }
        } else {
            throw new Error(`Pick driver reached unexpected phase ${phase.phase}`);
        }
    }

    const materialize = (team: PickTeam): IConditionalArmy => {
        const own = teamState(team);
        const outcome = setupOutcome.get(team);
        if (own.creatures.length !== 6 || own.tier1Artifact === undefined || !outcome) {
            throw new Error("Cannot build an army from an incomplete pick");
        }
        const refs = own.creatures.map((id, index) => {
            const ref = catalogById().get(id);
            if (!ref) {
                throw new Error(`Picked creature id ${id} has no catalog entry`);
            }
            return { id, index, ref };
        });
        if (!options.preservePickOrder) {
            refs.sort((a, b) => a.ref.level - b.ref.level || a.index - b.index);
        }
        const roster = refs.map(({ ref }) => ({
            faction: ref.faction,
            creatureName: ref.creatureName,
            level: ref.level,
            size: ref.size,
            amount: resolveStackAmount(
                ref.creatureName,
                ref.level,
                DEFAULT_AMOUNT_BY_LEVEL,
                LIVETWIN_PRESET.amountMode,
            ),
        }));
        const budget = getUpgradePoints(own.perk);
        const staticAugments = SETUP_POLICY_V0.pickAugments(budget);
        const conditional = options.conditionalTeams.has(team);
        const augments = conditional ? conditionalAugments(budget, own.creatures, rules) : staticAugments;
        const synergies = conditional
            ? conditionalSynergies(own.creatures)
            : SETUP_POLICY_V0.pickSynergies(own.creatures);
        return {
            creatureIds: [...own.creatures],
            revealedOpponentCreatures: getKnownOpponentCreatures(state, team),
            roster,
            perk: own.perk,
            augments,
            synergies,
            tier1Artifact: own.tier1Artifact,
            tier2Artifact: outcome.tier2Artifact,
            rangedStacks: ownComposition(own.creatures).ranged,
            t2Overridden: conditional && outcome.t2Overridden,
            augmentsOverridden: conditional && JSON.stringify(augments) !== JSON.stringify(staticAugments),
        };
    };

    return { lower: materialize(LOWER), upper: materialize(UPPER) };
}

// ---------------------------------------------------------------------------------------------------------
// Game runner
// ---------------------------------------------------------------------------------------------------------

export interface ISetupConditionalOptions {
    gamesPerCell: number;
    baseSeed: number;
    fightVersion: string;
    leagueGenomeSpec: string;
}

export interface ISetupConditionalRecord {
    cellId: string;
    game: number;
    seed: number;
    aIsLower: boolean;
    winnerSlot: "a" | "b" | "draw";
    laps: number;
    endReason: IMatchResult["endReason"];
    decidedByArmageddon: boolean;
    /** Engine-rejected strategy actions attributed after the A/B seat swap. Undefined means instrumentation missing. */
    rejectedA?: number;
    rejectedB?: number;
    aRangedStacks: number;
    bRangedStacks: number;
    aT2Overridden: boolean;
    aAugmentsOverridden: boolean;
}

let leagueGenomeCache: { spec: string; genome: ILeagueGenome } | undefined;

/** The committed ship path: parse the spec/file, then project to the surface the ranked server consumes. */
export function shippedLeagueGenome(spec: string): ILeagueGenome {
    if (!leagueGenomeCache || leagueGenomeCache.spec !== spec) {
        leagueGenomeCache = { spec, genome: projectDraftGenomeForShipping(parseDraftGenome(spec)) };
    }
    return leagueGenomeCache.genome;
}

/** Avalanche-mixed per-cell base seed so every cell's paired seed stream is independent. */
export function cellBaseSeed(baseSeed: number, cellIndex: number): number {
    let h = (baseSeed >>> 0) ^ 0x3c6ef372;
    h = Math.imul(h ^ (cellIndex + 0x2545), 0x85ebca6b) >>> 0;
    h ^= h >>> 15;
    h = Math.imul(h, 0x27d4eb2f) >>> 0;
    return (h ^ (h >>> 13)) >>> 0;
}

export const SETUP_CONDITIONAL_PAIR_CLUSTER_SIZE = 2;

export interface ISetupConditionalSeedStream {
    cellId: string;
    baseSeed: number;
    pairSeeds: number[];
}

/** Bind cell identity to disjoint paired-seed streams before any workers start. */
export function validateSetupConditionalSeedStreams(
    cells: readonly ISetupConditionalCell[],
    gamesPerCell: number,
    baseSeed: number,
): ISetupConditionalSeedStream[] {
    if (!cells.length) {
        throw new Error("Setup-conditional battery must contain at least one cell");
    }
    if (!Number.isSafeInteger(gamesPerCell) || gamesPerCell < 2 || gamesPerCell % 2 !== 0) {
        throw new Error(`gamesPerCell must be a positive even integer >= 2; got ${gamesPerCell}`);
    }
    if (!Number.isSafeInteger(baseSeed)) {
        throw new Error(`baseSeed must be a safe integer; got ${baseSeed}`);
    }
    const ids = new Set<string>();
    const seenSeeds = new Map<number, string>();
    return cells.map((cell, cellIndex) => {
        if (!cell.id.trim()) {
            throw new Error(`Setup-conditional cell ${cellIndex} has an empty id`);
        }
        if (ids.has(cell.id)) {
            throw new Error(`Duplicate setup-conditional cell ${cell.id}`);
        }
        ids.add(cell.id);
        const seed = cellBaseSeed(baseSeed, cellIndex);
        const pairSeeds: number[] = [];
        for (let pair = 0; pair < gamesPerCell / SETUP_CONDITIONAL_PAIR_CLUSTER_SIZE; pair += 1) {
            const derived = ((seed >>> 0) + pair * 0x9e3779b1) >>> 0;
            const previous = seenSeeds.get(derived);
            if (previous) {
                throw new Error(
                    `Setup-conditional seed ${derived} overlaps between ${previous} and ${cell.id} pair ${pair}`,
                );
            }
            seenSeeds.set(derived, `${cell.id} pair ${pair}`);
            pairSeeds.push(derived);
        }
        return { cellId: cell.id, baseSeed: seed, pairSeeds };
    });
}

export function playSetupConditionalGame(
    cell: ISetupConditionalCell,
    options: ISetupConditionalOptions,
    game: number,
): ISetupConditionalRecord {
    if (!Number.isSafeInteger(game) || game < 0 || game >= options.gamesPerCell) {
        throw new Error(`game must be in [0, ${options.gamesPerCell}); got ${game}`);
    }
    const pairIndex = Math.floor(game / 2);
    const seed = ((options.baseSeed >>> 0) + pairIndex * 0x9e3779b1) >>> 0;
    const aIsLower = game % 2 === 0;
    const rules = parseConditionalRules(cell.rules);
    const conditionalTeam = cell.control ? undefined : aIsLower ? LOWER : UPPER;
    const genome = cell.draft === "league" ? shippedLeagueGenome(options.leagueGenomeSpec) : undefined;
    const { lower, upper } = runConditionalPickGame(seed, cell.draft, conditionalTeam, rules, genome);
    // LOWER is the green team (battle_engine GREEN_TEAM = TeamVals.LOWER), matching the live seat mapping.
    FightStateManager.getInstance();
    const result = runMatch({
        greenVersion: options.fightVersion,
        redVersion: options.fightVersion,
        roster: lower.roster,
        redRoster: upper.roster,
        seed,
        gridType: PBTypes.GridVals.NORMAL,
        greenPerk: lower.perk,
        redPerk: upper.perk,
        greenAugments: lower.augments,
        redAugments: upper.augments,
        greenArtifactT1: lower.tier1Artifact,
        redArtifactT1: upper.tier1Artifact,
        greenArtifactT2: lower.tier2Artifact,
        redArtifactT2: upper.tier2Artifact,
        greenSynergies: lower.synergies,
        redSynergies: upper.synergies,
    });
    const a = aIsLower ? lower : upper;
    const b = aIsLower ? upper : lower;
    const winnerSlot = result.winner === "draw" ? "draw" : (result.winner === "green") === aIsLower ? "a" : "b";
    const rejectedA = aIsLower ? result.rejectedGreen : result.rejectedRed;
    const rejectedB = aIsLower ? result.rejectedRed : result.rejectedGreen;
    return {
        cellId: cell.id,
        game,
        seed,
        aIsLower,
        winnerSlot,
        laps: result.laps,
        endReason: result.endReason,
        decidedByArmageddon: result.attrition.decidedByArmageddon,
        rejectedA,
        rejectedB,
        aRangedStacks: a.rangedStacks,
        bRangedStacks: b.rangedStacks,
        aT2Overridden: a.t2Overridden,
        aAugmentsOverridden: a.augmentsOverridden,
    };
}

// ---------------------------------------------------------------------------------------------------------
// Aggregation + gate
// ---------------------------------------------------------------------------------------------------------

/** Same-seed games re-draft in swapped seats, so each pair is the independent variance cluster. */
export const SETUP_CONDITIONAL_CONFIDENCE_Z = 1.959963984540054;

export interface ISetupConditionalPairMoments {
    clusters: number;
    sumWinSquared: number;
    sumWinDecisive: number;
    sumDecisiveSquared: number;
}

export interface ISetupConditionalClusterEstimate {
    winRate: number;
    gainPp: number;
    standardErrorPp: number | null;
    confidence95: { low: number; high: number } | null;
    confidence95LowGainPp: number | null;
}

/** Ratio-estimator sandwich variance over the actual paired side-swap clusters. */
export function pairedClusterEstimate(
    winsA: number,
    winsB: number,
    moments: ISetupConditionalPairMoments,
): ISetupConditionalClusterEstimate {
    const decisive = winsA + winsB;
    const winRate = decisive ? winsA / decisive : 0.5;
    let standardError: number | null = null;
    let confidence95: { low: number; high: number } | null = null;
    if (moments.clusters >= 2 && decisive > 0) {
        const residualSquares =
            moments.sumWinSquared -
            2 * winRate * moments.sumWinDecisive +
            winRate * winRate * moments.sumDecisiveSquared;
        const finiteSample = moments.clusters / (moments.clusters - 1);
        standardError = Math.sqrt(Math.max(0, (finiteSample * residualSquares) / (decisive * decisive)));
        confidence95 = {
            low: Math.max(0, winRate - SETUP_CONDITIONAL_CONFIDENCE_Z * standardError),
            high: Math.min(1, winRate + SETUP_CONDITIONAL_CONFIDENCE_Z * standardError),
        };
    }
    return {
        winRate,
        gainPp: (winRate - 0.5) * 100,
        standardErrorPp: standardError === null ? null : standardError * 100,
        confidence95,
        confidence95LowGainPp: confidence95 === null ? null : (confidence95.low - 0.5) * 100,
    };
}

export interface ISetupConditionalCellSummary {
    id: string;
    draft: DraftDistName;
    rules: string;
    control: boolean;
    baseSeed: number;
    expectedGames: number;
    games: number;
    winsA: number;
    winsB: number;
    decisive: number;
    draws: number;
    winRateA: number;
    /** Actual paired side-swap cluster sandwich SE, in percentage points. */
    clusteredSePp: number | null;
    confidence95: { low: number; high: number } | null;
    confidence95LowGainPp: number | null;
    pairMoments: ISetupConditionalPairMoments;
    gainPp: number;
    avgLaps: number;
    endReasons: Record<string, number>;
    armageddonDecided: number;
    drawOrArmageddon: number;
    drawOrArmageddonRate: number;
    rejectedA: number;
    rejectedB: number;
    recordsMissingRejectionCounts: number;
    aRangedStacksPerGame: number;
    bRangedStacksPerGame: number;
    t2OverrideRate: number;
    augmentsOverrideRate: number;
    controlInvariantPassed: boolean;
}

export interface ICellTally {
    cell: ISetupConditionalCell;
    baseSeed: number;
    expectedGames?: number;
    recordsByGame: Map<number, ISetupConditionalRecord>;
    pairMoments: ISetupConditionalPairMoments;
    controlPairsAudited: number;
    games: number;
    winsA: number;
    winsB: number;
    draws: number;
    laps: number;
    endReasons: Record<string, number>;
    armageddonDecided: number;
    drawOrArmageddon: number;
    rejectedA: number;
    rejectedB: number;
    recordsMissingRejectionCounts: number;
    aRangedStacks: number;
    bRangedStacks: number;
    t2Overrides: number;
    augmentsOverrides: number;
}

export function emptyTally(cell: ISetupConditionalCell, baseSeed: number, expectedGames?: number): ICellTally {
    return {
        cell,
        baseSeed,
        expectedGames,
        recordsByGame: new Map(),
        pairMoments: { clusters: 0, sumWinSquared: 0, sumWinDecisive: 0, sumDecisiveSquared: 0 },
        controlPairsAudited: 0,
        games: 0,
        winsA: 0,
        winsB: 0,
        draws: 0,
        laps: 0,
        endReasons: {},
        armageddonDecided: 0,
        drawOrArmageddon: 0,
        rejectedA: 0,
        rejectedB: 0,
        recordsMissingRejectionCounts: 0,
        aRangedStacks: 0,
        bRangedStacks: 0,
        t2Overrides: 0,
        augmentsOverrides: 0,
    };
}

export function tallyRecord(tally: ICellTally, record: ISetupConditionalRecord): void {
    if (record.cellId !== tally.cell.id) {
        throw new Error(`Record cell ${record.cellId} does not match tally ${tally.cell.id}`);
    }
    if (!Number.isSafeInteger(record.game) || record.game < 0) {
        throw new Error(`${tally.cell.id}: invalid game index ${record.game}`);
    }
    if (tally.expectedGames !== undefined && record.game >= tally.expectedGames) {
        throw new Error(`${tally.cell.id}: game ${record.game} is outside [0, ${tally.expectedGames})`);
    }
    if (tally.recordsByGame.has(record.game)) {
        throw new Error(`${tally.cell.id}: duplicate game ${record.game}`);
    }
    const expectedLower = record.game % 2 === 0;
    if (record.aIsLower !== expectedLower) {
        throw new Error(`${tally.cell.id}: game ${record.game} did not side-swap arm A`);
    }
    const expectedSeed = ((tally.baseSeed >>> 0) + Math.floor(record.game / 2) * 0x9e3779b1) >>> 0;
    if (record.seed !== expectedSeed) {
        throw new Error(`${tally.cell.id}: game ${record.game} seed ${record.seed} does not match ${expectedSeed}`);
    }
    if (tally.cell.control && (record.aT2Overridden || record.aAugmentsOverridden)) {
        throw new Error(`${tally.cell.id}: control game ${record.game} changed setup`);
    }

    tally.recordsByGame.set(record.game, record);
    const mate = tally.recordsByGame.get(record.game ^ 1);
    if (mate) {
        const even = record.game % 2 === 0 ? record : mate;
        const odd = record.game % 2 === 0 ? mate : record;
        if (even.seed !== odd.seed) {
            throw new Error(`${tally.cell.id}: pair ${Math.floor(record.game / 2)} does not share a seed`);
        }
        let pairWins = 0;
        let pairDecisive = 0;
        for (const paired of [even, odd]) {
            if (paired.winnerSlot !== "draw") {
                pairDecisive += 1;
                pairWins += Number(paired.winnerSlot === "a");
            }
        }
        tally.pairMoments.clusters += 1;
        tally.pairMoments.sumWinSquared += pairWins * pairWins;
        tally.pairMoments.sumWinDecisive += pairWins * pairDecisive;
        tally.pairMoments.sumDecisiveSquared += pairDecisive * pairDecisive;

        if (tally.cell.control) {
            const winnerSymmetric =
                (even.winnerSlot === "draw" && odd.winnerSlot === "draw") ||
                (even.winnerSlot !== "draw" && odd.winnerSlot !== "draw" && even.winnerSlot !== odd.winnerSlot);
            const rejectionSymmetric =
                even.rejectedA === undefined ||
                even.rejectedB === undefined ||
                odd.rejectedA === undefined ||
                odd.rejectedB === undefined ||
                (even.rejectedA === odd.rejectedB && even.rejectedB === odd.rejectedA);
            if (
                !winnerSymmetric ||
                even.laps !== odd.laps ||
                even.endReason !== odd.endReason ||
                even.decidedByArmageddon !== odd.decidedByArmageddon ||
                even.aRangedStacks !== odd.bRangedStacks ||
                even.bRangedStacks !== odd.aRangedStacks ||
                !rejectionSymmetric
            ) {
                throw new Error(
                    `${tally.cell.id}: control pair ${Math.floor(record.game / 2)} is not an exact seat swap`,
                );
            }
            tally.controlPairsAudited += 1;
        }
    }

    tally.games += 1;
    if (record.winnerSlot === "a") tally.winsA += 1;
    else if (record.winnerSlot === "b") tally.winsB += 1;
    else tally.draws += 1;
    tally.laps += record.laps;
    tally.endReasons[record.endReason] = (tally.endReasons[record.endReason] ?? 0) + 1;
    tally.armageddonDecided += Number(record.decidedByArmageddon);
    tally.drawOrArmageddon += Number(record.winnerSlot === "draw" || record.decidedByArmageddon);
    if (record.rejectedA === undefined || record.rejectedB === undefined) {
        tally.recordsMissingRejectionCounts += 1;
    }
    tally.rejectedA += record.rejectedA ?? 0;
    tally.rejectedB += record.rejectedB ?? 0;
    tally.aRangedStacks += record.aRangedStacks;
    tally.bRangedStacks += record.bRangedStacks;
    tally.t2Overrides += Number(record.aT2Overridden);
    tally.augmentsOverrides += Number(record.aAugmentsOverridden);
}

export function summarizeTally(tally: ICellTally): ISetupConditionalCellSummary {
    const expectedGames = tally.expectedGames ?? tally.games;
    if (!Number.isSafeInteger(expectedGames) || expectedGames < 2 || expectedGames % 2 !== 0) {
        throw new Error(`${tally.cell.id}: expectedGames must be a positive even integer >= 2`);
    }
    if (tally.games !== expectedGames || tally.recordsByGame.size !== expectedGames) {
        throw new Error(`${tally.cell.id}: collected ${tally.recordsByGame.size}/${expectedGames} unique games`);
    }
    if (tally.pairMoments.clusters !== expectedGames / SETUP_CONDITIONAL_PAIR_CLUSTER_SIZE) {
        throw new Error(
            `${tally.cell.id}: audited ${tally.pairMoments.clusters}/${expectedGames / SETUP_CONDITIONAL_PAIR_CLUSTER_SIZE} pairs`,
        );
    }
    const decisive = tally.winsA + tally.winsB;
    const estimate = pairedClusterEstimate(tally.winsA, tally.winsB, tally.pairMoments);
    const games = tally.games;
    const controlInvariantPassed =
        !tally.cell.control ||
        (decisive > 0 &&
            tally.winsA === tally.winsB &&
            tally.t2Overrides === 0 &&
            tally.augmentsOverrides === 0 &&
            tally.controlPairsAudited === expectedGames / SETUP_CONDITIONAL_PAIR_CLUSTER_SIZE);
    return {
        id: tally.cell.id,
        draft: tally.cell.draft,
        rules: tally.cell.rules,
        control: tally.cell.control,
        baseSeed: tally.baseSeed,
        expectedGames,
        games: tally.games,
        winsA: tally.winsA,
        winsB: tally.winsB,
        decisive,
        draws: tally.draws,
        winRateA: estimate.winRate,
        clusteredSePp: estimate.standardErrorPp,
        confidence95: estimate.confidence95,
        confidence95LowGainPp: estimate.confidence95LowGainPp,
        pairMoments: { ...tally.pairMoments },
        gainPp: estimate.gainPp,
        avgLaps: tally.laps / games,
        endReasons: { ...tally.endReasons },
        armageddonDecided: tally.armageddonDecided,
        drawOrArmageddon: tally.drawOrArmageddon,
        drawOrArmageddonRate: tally.drawOrArmageddon / games,
        rejectedA: tally.rejectedA,
        rejectedB: tally.rejectedB,
        recordsMissingRejectionCounts: tally.recordsMissingRejectionCounts,
        aRangedStacksPerGame: tally.aRangedStacks / games,
        bRangedStacksPerGame: tally.bRangedStacks / games,
        t2OverrideRate: tally.t2Overrides / games,
        augmentsOverrideRate: tally.augmentsOverrides / games,
        controlInvariantPassed,
    };
}

export const SETUP_CONDITIONAL_GATE = {
    /** Acceptance runs use the preregistered powered default. Smaller runs remain useful diagnostics but cannot pass. */
    gamesPerCell: 4000,
    confidenceLevel: 0.95,
    /** Ship bar: pooled full-rule paired-cluster lower bound across the two live draft distributions. */
    pooledMinPp: 1,
    /** No full-rule paired-cluster lower bound may sit below this. */
    cellFloorPp: -0.5,
    /** The forced ranged-draft paired-cluster lower bound must clearly show the Sniper3 effect. */
    rangedCellMinPp: 3,
    /** A setup candidate may not materially worsen attrition relative to its same-draft frozen control. */
    maxMatchedDrawOrArmageddonExcessPp: 1,
    maxRejectionsPerArm: 0,
    headlineCells: ["heuristic__all", "league__all"] as readonly string[],
    rangedCell: "ranged__all",
    controlCells: ["heuristic__control", "league__control", "ranged__control"] as readonly string[],
} as const;

export interface ISetupConditionalGateVerdict {
    thresholds: typeof SETUP_CONDITIONAL_GATE;
    pooledGainPp: number;
    pooledSePp: number | null;
    pooledConfidence95LowGainPp: number | null;
    worstHeadlineCell: { id: string; gainPp: number; confidence95LowGainPp: number | null } | null;
    rangedGainPp: number | null;
    rangedConfidence95LowGainPp: number | null;
    maximumDrawOrArmageddonRate: number;
    maximumMatchedDrawOrArmageddonExcessPp: number | null;
    matchedAttrition: Array<{
        candidateId: string;
        controlId: string;
        candidateRate: number;
        controlRate: number;
        excessPp: number;
    }>;
    rejectedA: number;
    rejectedB: number;
    recordsMissingRejectionCounts: number;
    checks: {
        registeredCellsExact: boolean;
        powered: boolean;
        controlsExact: boolean;
        integrity: boolean;
        confidence: boolean;
    };
    verdict: "PASS" | "FAIL";
    reason: string;
}

export function evaluateGate(cells: readonly ISetupConditionalCellSummary[]): ISetupConditionalGateVerdict {
    const byId = new Map<string, ISetupConditionalCellSummary>();
    for (const cell of cells) {
        if (byId.has(cell.id)) {
            throw new Error(`Duplicate setup-conditional cell ${cell.id}`);
        }
        if (
            !Number.isSafeInteger(cell.games) ||
            !Number.isSafeInteger(cell.winsA) ||
            !Number.isSafeInteger(cell.winsB) ||
            !Number.isSafeInteger(cell.draws) ||
            cell.games < 0 ||
            cell.winsA < 0 ||
            cell.winsB < 0 ||
            cell.draws < 0 ||
            cell.winsA + cell.winsB + cell.draws !== cell.games ||
            cell.decisive !== cell.winsA + cell.winsB ||
            !Number.isSafeInteger(cell.expectedGames) ||
            cell.expectedGames < 2 ||
            cell.expectedGames % 2 !== 0 ||
            !Number.isSafeInteger(cell.armageddonDecided) ||
            !Number.isSafeInteger(cell.drawOrArmageddon) ||
            !Number.isSafeInteger(cell.rejectedA) ||
            !Number.isSafeInteger(cell.rejectedB) ||
            !Number.isSafeInteger(cell.recordsMissingRejectionCounts) ||
            cell.armageddonDecided < 0 ||
            cell.armageddonDecided > cell.games ||
            cell.drawOrArmageddon < cell.draws ||
            cell.drawOrArmageddon < cell.armageddonDecided ||
            cell.drawOrArmageddon > cell.games ||
            cell.rejectedA < 0 ||
            cell.rejectedB < 0 ||
            cell.recordsMissingRejectionCounts < 0 ||
            cell.recordsMissingRejectionCounts > cell.games ||
            cell.drawOrArmageddonRate !== cell.drawOrArmageddon / cell.games ||
            cell.pairMoments.clusters !== cell.games / SETUP_CONDITIONAL_PAIR_CLUSTER_SIZE ||
            !Number.isFinite(cell.pairMoments.sumWinSquared) ||
            !Number.isFinite(cell.pairMoments.sumWinDecisive) ||
            !Number.isFinite(cell.pairMoments.sumDecisiveSquared) ||
            cell.pairMoments.sumWinSquared < 0 ||
            cell.pairMoments.sumWinDecisive < 0 ||
            cell.pairMoments.sumDecisiveSquared < 0
        ) {
            throw new Error(`Malformed setup-conditional counts for ${cell.id}`);
        }
        byId.set(cell.id, cell);
    }
    const expectedCells = defaultCells();
    const registeredCellsExact =
        cells.length === expectedCells.length &&
        expectedCells.every((expected) => {
            const actual = byId.get(expected.id);
            return (
                actual?.draft === expected.draft &&
                actual.rules === expected.rules &&
                actual.control === expected.control
            );
        });
    const headline = SETUP_CONDITIONAL_GATE.headlineCells
        .map((id) => byId.get(id))
        .filter((cell): cell is ISetupConditionalCellSummary => !!cell);
    const estimatesById = new Map(
        cells.map((cell) => [cell.id, pairedClusterEstimate(cell.winsA, cell.winsB, cell.pairMoments)]),
    );
    const pooledMoments = headline.reduce<ISetupConditionalPairMoments>(
        (sum, cell) => ({
            clusters: sum.clusters + cell.pairMoments.clusters,
            sumWinSquared: sum.sumWinSquared + cell.pairMoments.sumWinSquared,
            sumWinDecisive: sum.sumWinDecisive + cell.pairMoments.sumWinDecisive,
            sumDecisiveSquared: sum.sumDecisiveSquared + cell.pairMoments.sumDecisiveSquared,
        }),
        { clusters: 0, sumWinSquared: 0, sumWinDecisive: 0, sumDecisiveSquared: 0 },
    );
    const pooledEstimate = pairedClusterEstimate(
        headline.reduce((sum, cell) => sum + cell.winsA, 0),
        headline.reduce((sum, cell) => sum + cell.winsB, 0),
        pooledMoments,
    );
    const worstHeadlineCell = headline.length
        ? headline.reduce((worst, cell) =>
              (estimatesById.get(cell.id)?.confidence95LowGainPp ?? -Infinity) <
              (estimatesById.get(worst.id)?.confidence95LowGainPp ?? -Infinity)
                  ? cell
                  : worst,
          )
        : null;
    const ranged = byId.get(SETUP_CONDITIONAL_GATE.rangedCell);
    const rangedEstimate = ranged ? estimatesById.get(ranged.id) : undefined;
    const rangedGainPp = rangedEstimate?.gainPp ?? null;
    const worstHeadlineEstimate = worstHeadlineCell ? estimatesById.get(worstHeadlineCell.id) : undefined;
    const controls = SETUP_CONDITIONAL_GATE.controlCells
        .map((id) => byId.get(id))
        .filter((cell): cell is ISetupConditionalCellSummary => !!cell);
    const powered =
        registeredCellsExact &&
        cells.every(
            (cell) =>
                cell.games === SETUP_CONDITIONAL_GATE.gamesPerCell &&
                cell.expectedGames === SETUP_CONDITIONAL_GATE.gamesPerCell,
        );
    const controlsExact =
        controls.length === SETUP_CONDITIONAL_GATE.controlCells.length &&
        controls.every(
            (cell) =>
                cell.controlInvariantPassed &&
                cell.decisive > 0 &&
                cell.winsA === cell.winsB &&
                estimatesById.get(cell.id)?.gainPp === 0 &&
                cell.t2OverrideRate === 0 &&
                cell.augmentsOverrideRate === 0,
        );
    const maximumDrawOrArmageddonRate = cells.reduce(
        (maximum, cell) => Math.max(maximum, cell.drawOrArmageddonRate),
        0,
    );
    const rejectedA = cells.reduce((sum, cell) => sum + cell.rejectedA, 0);
    const rejectedB = cells.reduce((sum, cell) => sum + cell.rejectedB, 0);
    const recordsMissingRejectionCounts = cells.reduce((sum, cell) => sum + cell.recordsMissingRejectionCounts, 0);
    const attritionCandidateIds = [...SETUP_CONDITIONAL_GATE.headlineCells, SETUP_CONDITIONAL_GATE.rangedCell];
    const matchedAttrition = attritionCandidateIds.flatMap((candidateId) => {
        const candidate = byId.get(candidateId);
        if (!candidate) return [];
        const controlId = `${candidate.draft}__control`;
        const control = byId.get(controlId);
        if (!control) return [];
        return [
            {
                candidateId,
                controlId,
                candidateRate: candidate.drawOrArmageddonRate,
                controlRate: control.drawOrArmageddonRate,
                excessPp: (candidate.drawOrArmageddonRate - control.drawOrArmageddonRate) * 100,
            },
        ];
    });
    const maximumMatchedDrawOrArmageddonExcessPp = matchedAttrition.length
        ? Math.max(...matchedAttrition.map((match) => match.excessPp))
        : null;
    const attritionIntegrity =
        matchedAttrition.length === attritionCandidateIds.length &&
        matchedAttrition.every((match) => match.excessPp <= SETUP_CONDITIONAL_GATE.maxMatchedDrawOrArmageddonExcessPp);
    const integrity =
        registeredCellsExact &&
        rejectedA <= SETUP_CONDITIONAL_GATE.maxRejectionsPerArm &&
        rejectedB <= SETUP_CONDITIONAL_GATE.maxRejectionsPerArm &&
        recordsMissingRejectionCounts === 0 &&
        attritionIntegrity;
    const confidence =
        headline.length === SETUP_CONDITIONAL_GATE.headlineCells.length &&
        pooledEstimate.confidence95LowGainPp !== null &&
        pooledEstimate.confidence95LowGainPp >= SETUP_CONDITIONAL_GATE.pooledMinPp &&
        worstHeadlineEstimate?.confidence95LowGainPp !== null &&
        worstHeadlineEstimate?.confidence95LowGainPp !== undefined &&
        worstHeadlineEstimate.confidence95LowGainPp >= SETUP_CONDITIONAL_GATE.cellFloorPp &&
        rangedEstimate?.confidence95LowGainPp !== null &&
        rangedEstimate?.confidence95LowGainPp !== undefined &&
        rangedEstimate.confidence95LowGainPp >= SETUP_CONDITIONAL_GATE.rangedCellMinPp;
    const pass = registeredCellsExact && powered && controlsExact && integrity && confidence;
    const failedChecks = [
        !registeredCellsExact && "registered cells/metadata",
        !powered && `${SETUP_CONDITIONAL_GATE.gamesPerCell} games/cell`,
        !controlsExact && "exact control invariants",
        !integrity && "rejection/draw-or-Armageddon integrity",
        !confidence && "paired-cluster lower-bound bars",
    ].filter((value): value is string => !!value);
    const pooledLowText =
        pooledEstimate.confidence95LowGainPp === null ? "n/a" : `${pooledEstimate.confidence95LowGainPp.toFixed(2)}pp`;
    const rangedLowText =
        rangedEstimate?.confidence95LowGainPp === null || rangedEstimate?.confidence95LowGainPp === undefined
            ? "n/a"
            : `${rangedEstimate.confidence95LowGainPp.toFixed(2)}pp`;
    const matchedExcessText =
        maximumMatchedDrawOrArmageddonExcessPp === null
            ? "n/a"
            : `${maximumMatchedDrawOrArmageddonExcessPp.toFixed(2)}pp`;
    return {
        thresholds: SETUP_CONDITIONAL_GATE,
        pooledGainPp: pooledEstimate.gainPp,
        pooledSePp: pooledEstimate.standardErrorPp,
        pooledConfidence95LowGainPp: pooledEstimate.confidence95LowGainPp,
        worstHeadlineCell: worstHeadlineCell
            ? {
                  id: worstHeadlineCell.id,
                  gainPp: worstHeadlineEstimate!.gainPp,
                  confidence95LowGainPp: worstHeadlineEstimate!.confidence95LowGainPp,
              }
            : null,
        rangedGainPp,
        rangedConfidence95LowGainPp: rangedEstimate?.confidence95LowGainPp ?? null,
        maximumDrawOrArmageddonRate,
        maximumMatchedDrawOrArmageddonExcessPp,
        matchedAttrition,
        rejectedA,
        rejectedB,
        recordsMissingRejectionCounts,
        checks: { registeredCellsExact, powered, controlsExact, integrity, confidence },
        verdict: pass ? "PASS" : "FAIL",
        reason: pass
            ? `Paired 95% lower bounds clear pooled +${SETUP_CONDITIONAL_GATE.pooledMinPp}pp, headline floor ` +
              `${SETUP_CONDITIONAL_GATE.cellFloorPp}pp, and ranged +${SETUP_CONDITIONAL_GATE.rangedCellMinPp}pp; ` +
              `matched attrition excess is at most ${SETUP_CONDITIONAL_GATE.maxMatchedDrawOrArmageddonExcessPp}pp; ` +
              "controls and rejection integrity are exact."
            : `Fail-closed checks: ${failedChecks.join(", ")}. Pooled low ${pooledLowText}; ranged low ` +
              `${rangedLowText}; max draw/Arm ` +
              `${(maximumDrawOrArmageddonRate * 100).toFixed(2)}%; max matched excess ` +
              `${matchedExcessText}; rejections A/B ${rejectedA}/${rejectedB}; ` +
              `missing ${recordsMissingRejectionCounts}.`,
    };
}

// ---------------------------------------------------------------------------------------------------------
// Worker pool (this file spawns itself as the worker)
// ---------------------------------------------------------------------------------------------------------

interface IJob {
    cell: ISetupConditionalCell;
    baseSeed: number;
    game: number;
}

type WorkerReply =
    { type: "ready" } | { type: "result"; record: ISetupConditionalRecord } | { type: "error"; error: string };

async function runJobsConcurrent(
    jobs: readonly IJob[],
    options: ISetupConditionalOptions,
    tallies: Map<string, ICellTally>,
    concurrency: number,
    onRecord?: (completed: number, total: number) => void,
): Promise<void> {
    const total = jobs.length;
    const poolSize = Math.max(1, Math.min(Math.floor(concurrency) || 1, total));
    if (poolSize <= 1) {
        let completed = 0;
        for (const job of jobs) {
            const record = playSetupConditionalGame(job.cell, { ...options, baseSeed: job.baseSeed }, job.game);
            tallyRecord(tallies.get(job.cell.id)!, record);
            completed += 1;
            onRecord?.(completed, total);
        }
        return;
    }
    // workerData must be structured-cloneable: strip functions/extras down to the plain game options.
    const plainOptions: ISetupConditionalOptions = {
        gamesPerCell: options.gamesPerCell,
        baseSeed: options.baseSeed,
        fightVersion: options.fightVersion,
        leagueGenomeSpec: options.leagueGenomeSpec,
    };
    await new Promise<void>((resolvePromise, rejectPromise) => {
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
            worker.postMessage({ type: "game", job: jobs[dispatched] });
            dispatched += 1;
        };
        for (let workerId = 0; workerId < poolSize; workerId += 1) {
            let worker: Worker;
            try {
                worker = new Worker(new URL(import.meta.url), {
                    workerData: { setupConditional: true, options: plainOptions },
                });
            } catch (error) {
                fail(error);
                return;
            }
            workers.push(worker);
            worker.on("message", (message: WorkerReply) => {
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
                onRecord?.(completed, total);
                if (completed >= total) {
                    settled = true;
                    cleanup();
                    resolvePromise();
                    return;
                }
                dispatchNext(worker);
            });
            worker.on("error", fail);
        }
    });
}

if (!isMainThread && parentPort && (workerData as { setupConditional?: boolean } | undefined)?.setupConditional) {
    const port = parentPort;
    const workerOptions = (workerData as { options: ISetupConditionalOptions }).options;
    port.on("message", (message: { type: "game"; job: IJob } | { type: "stop" }) => {
        if (message.type === "stop") {
            port.close();
            return;
        }
        try {
            const { job } = message;
            const record = playSetupConditionalGame(job.cell, { ...workerOptions, baseSeed: job.baseSeed }, job.game);
            port.postMessage({ type: "result", record });
        } catch (error) {
            port.postMessage({
                type: "error",
                error: error instanceof Error ? (error.stack ?? error.message) : String(error),
            });
        }
    });
    port.postMessage({ type: "ready" });
}

// ---------------------------------------------------------------------------------------------------------
// Summary + CLI
// ---------------------------------------------------------------------------------------------------------

export interface IMeasureSetupConditionalSummary {
    schemaVersion: 2;
    kind: "conditional_setup_v1_ab";
    fightVersion: string;
    startedAt: string;
    wallSeconds: number;
    gamesPerSecond: number;
    config: {
        liveTwinEnv: string;
        amountMode: typeof LIVETWIN_PRESET.amountMode;
        grid: "NORMAL";
        leagueGenomeSpec: string;
        gamesPerCell: number;
        baseSeed: number;
        /** Stable identity used to prove that separately persisted panels are independent replications. */
        replicationId: string;
        concurrency: number;
        totalGames: number;
        pairing: {
            clusterSize: typeof SETUP_CONDITIONAL_PAIR_CLUSTER_SIZE;
            sharedOfferAndCombatSeed: true;
            armsSwapPickSeats: true;
        };
    };
    cells: ISetupConditionalCellSummary[];
    gate: ISetupConditionalGateVerdict;
}

/** Reject a relabelled rerun or any shared paired scenario across purportedly independent summaries. */
export function validateIndependentSetupConditionalReplications(
    summaries: readonly IMeasureSetupConditionalSummary[],
): void {
    const replicationIds = new Set<string>();
    const seenSeeds = new Map<number, string>();
    for (const summary of summaries) {
        const replicationId = summary.config.replicationId.trim();
        if (!replicationId) {
            throw new Error("Setup-conditional replication id must not be empty");
        }
        if (replicationIds.has(replicationId)) {
            throw new Error(`Duplicate setup-conditional replication id ${replicationId}`);
        }
        replicationIds.add(replicationId);
        const cellIds = new Set<string>();
        for (const cell of summary.cells) {
            if (cellIds.has(cell.id)) {
                throw new Error(`Duplicate setup-conditional cell ${cell.id} in replication ${replicationId}`);
            }
            cellIds.add(cell.id);
            if (!Number.isSafeInteger(cell.expectedGames) || cell.expectedGames < 2 || cell.expectedGames % 2 !== 0) {
                throw new Error(`${replicationId}/${cell.id}: expectedGames must be a positive even integer >= 2`);
            }
            for (let pair = 0; pair < cell.expectedGames / SETUP_CONDITIONAL_PAIR_CLUSTER_SIZE; pair += 1) {
                const seed = ((cell.baseSeed >>> 0) + pair * 0x9e3779b1) >>> 0;
                const label = `${replicationId}/${cell.id}/pair-${pair}`;
                const previous = seenSeeds.get(seed);
                if (previous) {
                    throw new Error(
                        `Setup-conditional replication seed ${seed} overlaps between ${previous} and ${label}`,
                    );
                }
                seenSeeds.set(seed, label);
            }
        }
    }
}

export interface IMeasureSetupConditionalOptions extends ISetupConditionalOptions {
    concurrency: number;
    replicationId?: string;
    cells?: ISetupConditionalCell[];
    onProgress?: (completed: number, total: number) => void;
}

export async function runMeasureSetupConditional(
    options: IMeasureSetupConditionalOptions,
): Promise<IMeasureSetupConditionalSummary> {
    if (!Number.isSafeInteger(options.gamesPerCell) || options.gamesPerCell < 2 || options.gamesPerCell % 2 !== 0) {
        throw new Error(`gamesPerCell must be a positive even integer >= 2; got ${options.gamesPerCell}`);
    }
    if (!Number.isSafeInteger(options.baseSeed)) {
        throw new Error(`baseSeed must be a safe integer; got ${options.baseSeed}`);
    }
    if (options.replicationId !== undefined && !options.replicationId.trim()) {
        throw new Error("replicationId must not be empty when provided");
    }
    const cells = options.cells ?? defaultCells();
    const replicationId = options.replicationId?.trim() ?? `base-seed-${options.baseSeed >>> 0}`;
    const seedStreams = validateSetupConditionalSeedStreams(cells, options.gamesPerCell, options.baseSeed);
    const seedStreamByCell = new Map(seedStreams.map((stream) => [stream.cellId, stream]));
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    const tallies = new Map<string, ICellTally>();
    const jobs: IJob[] = [];
    cells.forEach((cell) => {
        const seed = seedStreamByCell.get(cell.id)!.baseSeed;
        tallies.set(cell.id, emptyTally(cell, seed, options.gamesPerCell));
        for (let game = 0; game < options.gamesPerCell; game += 1) {
            jobs.push({ cell, baseSeed: seed, game });
        }
    });
    await runJobsConcurrent(jobs, options, tallies, options.concurrency, options.onProgress);
    const wallSeconds = (Date.now() - startMs) / 1000;
    const summaries = cells.map((cell) => summarizeTally(tallies.get(cell.id)!));
    return {
        schemaVersion: 2,
        kind: "conditional_setup_v1_ab",
        fightVersion: options.fightVersion,
        startedAt,
        wallSeconds,
        gamesPerSecond: wallSeconds > 0 ? jobs.length / wallSeconds : 0,
        config: {
            liveTwinEnv: process.env.LIVETWIN ?? "",
            amountMode: LIVETWIN_PRESET.amountMode,
            grid: "NORMAL",
            leagueGenomeSpec: options.leagueGenomeSpec,
            gamesPerCell: options.gamesPerCell,
            baseSeed: options.baseSeed,
            replicationId,
            concurrency: options.concurrency,
            totalGames: jobs.length,
            pairing: {
                clusterSize: SETUP_CONDITIONAL_PAIR_CLUSTER_SIZE,
                sharedOfferAndCombatSeed: true,
                armsSwapPickSeats: true,
            },
        },
        cells: summaries,
        gate: evaluateGate(summaries),
    };
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
        "usage: bun src/simulation/measure_setup_conditional.ts [--games 4000] [--seed 1] [--concurrency 8] " +
            "[--replication-id id] [--fight v0.7] [--league-genome league-r3-br-52752642] " +
            "[--output sim-out/setup_conditional.summary.json]",
    );
    console.log("  --games          games per cell; must be even (default 4000)");
    console.log("  --seed           base seed; every cell derives an independent stream (default 1)");
    console.log("  --replication-id stable independent-panel identity (default base-seed-<seed>)");
    console.log("  --concurrency    worker threads (default min(8, cores))");
    console.log("  --fight          fight AI version on BOTH sides (default v0.7, the live default)");
    console.log("  --league-genome  draft genome spec/path for the league cells (draft_ship.parseDraftGenome)");
    console.log("  --output         summary JSON path; use '-' for stdout");
}

export async function main(): Promise<void> {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            games: { type: "string", default: "4000" },
            seed: { type: "string", default: "1" },
            "replication-id": { type: "string" },
            concurrency: { type: "string", default: String(Math.min(8, Math.max(1, availableParallelism()))) },
            fight: { type: "string", default: "v0.7" },
            "league-genome": { type: "string", default: LEAGUE_ROUND3_DRAFT_SPEC },
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
    // Live-faithful config for this process and every worker it spawns.
    process.env.LIVETWIN = "1";
    const gamesPerCell = positiveInteger(values.games, "--games");
    if (gamesPerCell % 2 !== 0) {
        throw new Error(`--games must be even for paired seat swaps; got ${gamesPerCell}`);
    }
    const baseSeed = Number(values.seed);
    if (!Number.isSafeInteger(baseSeed)) {
        throw new Error(`--seed must be a safe integer; got ${values.seed}`);
    }
    const concurrency = positiveInteger(values.concurrency, "--concurrency");
    const replicationId = values["replication-id"];
    if (replicationId !== undefined && !replicationId.trim()) {
        throw new Error("--replication-id must not be empty");
    }
    const leagueGenomeSpec = values["league-genome"];
    shippedLeagueGenome(leagueGenomeSpec); // fail fast on a bad spec before spawning workers
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const output = values.output ?? join(process.cwd(), "sim-out", `setup_conditional_${stamp}.summary.json`);
    const cells = defaultCells();
    const total = cells.length * gamesPerCell;
    console.error(
        `CONDITIONAL_SETUP_V1 A/B: ${cells.length} cells x ${gamesPerCell} = ${total} games (seed ${baseSeed}, ` +
            `replication ${replicationId ?? `base-seed-${baseSeed >>> 0}`}, concurrency ${concurrency}, LIVETWIN=1, ` +
            `fight ${values.fight} both sides, league ${leagueGenomeSpec})`,
    );
    const started = Date.now();
    let lastLogged = 0;
    const summary = await runMeasureSetupConditional({
        gamesPerCell,
        baseSeed,
        replicationId,
        concurrency,
        fightVersion: values.fight,
        leagueGenomeSpec,
        onProgress: (completed, totalJobs) => {
            if (completed - lastLogged >= Math.max(500, Math.floor(totalJobs / 25)) || completed === totalJobs) {
                lastLogged = completed;
                const rate = (completed / (Date.now() - started)) * 1000;
                console.error(`  ${completed}/${totalJobs} games (${rate.toFixed(1)} games/s)`);
            }
        },
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
    for (const cell of summary.cells) {
        const se = cell.clusteredSePp === null ? "n/a" : `${cell.clusteredSePp.toFixed(2)}pp`;
        const low = cell.confidence95LowGainPp === null ? "n/a" : `${cell.confidence95LowGainPp.toFixed(2)}pp`;
        console.error(
            `  ${cell.id}: A ${(cell.winRateA * 100).toFixed(2)}% +/- ${se} (95% low delta ${low}) ` +
                `(${cell.decisive} decisive/${cell.games}), t2 override ${(cell.t2OverrideRate * 100).toFixed(1)}%, ` +
                `augment override ${(cell.augmentsOverrideRate * 100).toFixed(1)}%, ` +
                `rangedStacks A ${cell.aRangedStacksPerGame.toFixed(2)} / B ${cell.bRangedStacksPerGame.toFixed(2)}`,
        );
    }
    console.error(`GATE: ${summary.gate.verdict} — ${summary.gate.reason}`);
    if (summary.gate.verdict !== "PASS") {
        process.exitCode = 1;
    }
}

if (isMainThread && (import.meta as unknown as { main?: boolean }).main) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
