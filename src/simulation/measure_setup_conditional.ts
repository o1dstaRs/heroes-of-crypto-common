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
 * seat luck cancels; the pair is one statistical cluster (conservative x sqrt(2) design effect, same as
 * measure_picksim_oracle). Control cells run static-vs-static and must land EXACTLY 50.00% decisive.
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
                const artifactId =
                    team === conditionalTeam
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
        refs.sort((a, b) => a.ref.level - b.ref.level || a.index - b.index);
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
        const augments = team === conditionalTeam ? conditionalAugments(budget, own.creatures, rules) : staticAugments;
        const synergies =
            team === conditionalTeam
                ? conditionalSynergies(own.creatures)
                : SETUP_POLICY_V0.pickSynergies(own.creatures);
        return {
            roster,
            perk: own.perk,
            augments,
            synergies,
            tier1Artifact: own.tier1Artifact,
            tier2Artifact: outcome.tier2Artifact,
            rangedStacks: ownComposition(own.creatures).ranged,
            t2Overridden: team === conditionalTeam && outcome.t2Overridden,
            augmentsOverridden: team === conditionalTeam && JSON.stringify(augments) !== JSON.stringify(staticAugments),
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
    return {
        cellId: cell.id,
        game,
        seed,
        aIsLower,
        winnerSlot,
        laps: result.laps,
        endReason: result.endReason,
        aRangedStacks: a.rangedStacks,
        bRangedStacks: b.rangedStacks,
        aT2Overridden: a.t2Overridden,
        aAugmentsOverridden: a.augmentsOverridden,
    };
}

// ---------------------------------------------------------------------------------------------------------
// Aggregation + gate
// ---------------------------------------------------------------------------------------------------------

/** Same-seed pairs re-draft in swapped seats; the conservative variance bound treats each pair as a cluster. */
export const SETUP_CONDITIONAL_PAIR_CLUSTER_SIZE = 2;

export interface ISetupConditionalCellSummary {
    id: string;
    draft: DraftDistName;
    rules: string;
    control: boolean;
    games: number;
    decisive: number;
    draws: number;
    winRateA: number;
    /** Binomial SE inflated by the sqrt(2) pair-cluster design effect, in percentage points. */
    clusteredSePp: number;
    gainPp: number;
    avgLaps: number;
    endReasons: Record<string, number>;
    aRangedStacksPerGame: number;
    bRangedStacksPerGame: number;
    t2OverrideRate: number;
    augmentsOverrideRate: number;
}

export interface ICellTally {
    cell: ISetupConditionalCell;
    baseSeed: number;
    games: number;
    winsA: number;
    winsB: number;
    draws: number;
    laps: number;
    endReasons: Record<string, number>;
    aRangedStacks: number;
    bRangedStacks: number;
    t2Overrides: number;
    augmentsOverrides: number;
}

export function emptyTally(cell: ISetupConditionalCell, baseSeed: number): ICellTally {
    return {
        cell,
        baseSeed,
        games: 0,
        winsA: 0,
        winsB: 0,
        draws: 0,
        laps: 0,
        endReasons: {},
        aRangedStacks: 0,
        bRangedStacks: 0,
        t2Overrides: 0,
        augmentsOverrides: 0,
    };
}

export function tallyRecord(tally: ICellTally, record: ISetupConditionalRecord): void {
    tally.games += 1;
    if (record.winnerSlot === "a") tally.winsA += 1;
    else if (record.winnerSlot === "b") tally.winsB += 1;
    else tally.draws += 1;
    tally.laps += record.laps;
    tally.endReasons[record.endReason] = (tally.endReasons[record.endReason] ?? 0) + 1;
    tally.aRangedStacks += record.aRangedStacks;
    tally.bRangedStacks += record.bRangedStacks;
    tally.t2Overrides += Number(record.aT2Overridden);
    tally.augmentsOverrides += Number(record.aAugmentsOverridden);
}

export function summarizeTally(tally: ICellTally): ISetupConditionalCellSummary {
    const decisive = tally.winsA + tally.winsB;
    const rate = decisive ? tally.winsA / decisive : 0.5;
    const games = Math.max(1, tally.games);
    const binomialSePp = decisive ? 100 * Math.sqrt((rate * (1 - rate)) / decisive) : Number.POSITIVE_INFINITY;
    return {
        id: tally.cell.id,
        draft: tally.cell.draft,
        rules: tally.cell.rules,
        control: tally.cell.control,
        games: tally.games,
        decisive,
        draws: tally.draws,
        winRateA: rate,
        clusteredSePp: Math.sqrt(SETUP_CONDITIONAL_PAIR_CLUSTER_SIZE) * binomialSePp,
        gainPp: (rate - 0.5) * 100,
        avgLaps: tally.laps / games,
        endReasons: tally.endReasons,
        aRangedStacksPerGame: tally.aRangedStacks / games,
        bRangedStacksPerGame: tally.bRangedStacks / games,
        t2OverrideRate: tally.t2Overrides / games,
        augmentsOverrideRate: tally.augmentsOverrides / games,
    };
}

export const SETUP_CONDITIONAL_GATE = {
    /** Ship bar: pooled full-rule gain across the two live draft distributions. */
    pooledMinPp: 1,
    /** No full-rule cell may sit below this. */
    cellFloorPp: -0.5,
    /** The forced ranged-draft cell must clearly show the Sniper3 effect. */
    rangedCellMinPp: 3,
    headlineCells: ["heuristic__all", "league__all"] as readonly string[],
    rangedCell: "ranged__all",
} as const;

export interface ISetupConditionalGateVerdict {
    thresholds: typeof SETUP_CONDITIONAL_GATE;
    pooledGainPp: number;
    pooledSePp: number;
    worstHeadlineCell: { id: string; gainPp: number } | null;
    rangedGainPp: number | null;
    verdict: "PASS" | "FAIL";
    reason: string;
}

export function evaluateGate(cells: readonly ISetupConditionalCellSummary[]): ISetupConditionalGateVerdict {
    const byId = new Map(cells.map((cell) => [cell.id, cell]));
    const headline = SETUP_CONDITIONAL_GATE.headlineCells
        .map((id) => byId.get(id))
        .filter((cell): cell is ISetupConditionalCellSummary => !!cell);
    let wins = 0;
    let decisive = 0;
    for (const cell of headline) {
        wins += cell.winRateA * cell.decisive;
        decisive += cell.decisive;
    }
    const pooledRate = decisive ? wins / decisive : 0.5;
    const pooledGainPp = (pooledRate - 0.5) * 100;
    const pooledSePp = decisive
        ? Math.sqrt(SETUP_CONDITIONAL_PAIR_CLUSTER_SIZE) * 100 * Math.sqrt((pooledRate * (1 - pooledRate)) / decisive)
        : Number.POSITIVE_INFINITY;
    const worstHeadlineCell = headline.length
        ? headline.reduce((worst, cell) => (cell.gainPp < worst.gainPp ? cell : worst))
        : null;
    const ranged = byId.get(SETUP_CONDITIONAL_GATE.rangedCell);
    const rangedGainPp = ranged ? ranged.gainPp : null;
    const pass =
        headline.length === SETUP_CONDITIONAL_GATE.headlineCells.length &&
        pooledGainPp >= SETUP_CONDITIONAL_GATE.pooledMinPp &&
        (worstHeadlineCell?.gainPp ?? -Infinity) >= SETUP_CONDITIONAL_GATE.cellFloorPp &&
        rangedGainPp !== null &&
        rangedGainPp >= SETUP_CONDITIONAL_GATE.rangedCellMinPp;
    return {
        thresholds: SETUP_CONDITIONAL_GATE,
        pooledGainPp,
        pooledSePp,
        worstHeadlineCell: worstHeadlineCell ? { id: worstHeadlineCell.id, gainPp: worstHeadlineCell.gainPp } : null,
        rangedGainPp,
        verdict: pass ? "PASS" : "FAIL",
        reason: pass
            ? `Pooled +${pooledGainPp.toFixed(2)}pp >= +${SETUP_CONDITIONAL_GATE.pooledMinPp}pp across both live ` +
              `draft distributions, no headline cell below ${SETUP_CONDITIONAL_GATE.cellFloorPp}pp, ranged cell ` +
              `+${(rangedGainPp ?? 0).toFixed(2)}pp >= +${SETUP_CONDITIONAL_GATE.rangedCellMinPp}pp.`
            : `Bar: pooled >= +${SETUP_CONDITIONAL_GATE.pooledMinPp}pp (got ${pooledGainPp.toFixed(2)}), headline ` +
              `floor ${SETUP_CONDITIONAL_GATE.cellFloorPp}pp (worst ${worstHeadlineCell ? `${worstHeadlineCell.id} ` : ""}` +
              `${(worstHeadlineCell?.gainPp ?? NaN).toFixed?.(2) ?? "n/a"}), ranged >= ` +
              `+${SETUP_CONDITIONAL_GATE.rangedCellMinPp}pp (got ${rangedGainPp?.toFixed(2) ?? "n/a"}).`,
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
    schemaVersion: 1;
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

export interface IMeasureSetupConditionalOptions extends ISetupConditionalOptions {
    concurrency: number;
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
    const cells = options.cells ?? defaultCells();
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    const tallies = new Map<string, ICellTally>();
    const jobs: IJob[] = [];
    cells.forEach((cell, cellIndex) => {
        const seed = cellBaseSeed(options.baseSeed, cellIndex);
        tallies.set(cell.id, emptyTally(cell, seed));
        for (let game = 0; game < options.gamesPerCell; game += 1) {
            jobs.push({ cell, baseSeed: seed, game });
        }
    });
    await runJobsConcurrent(jobs, options, tallies, options.concurrency, options.onProgress);
    const wallSeconds = (Date.now() - startMs) / 1000;
    const summaries = cells.map((cell) => summarizeTally(tallies.get(cell.id)!));
    return {
        schemaVersion: 1,
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
            "[--fight v0.7] [--league-genome league-r3-br-52752642] [--output sim-out/setup_conditional.summary.json]",
    );
    console.log("  --games          games per cell; must be even (default 4000)");
    console.log("  --seed           base seed; every cell derives an independent stream (default 1)");
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
    const leagueGenomeSpec = values["league-genome"];
    shippedLeagueGenome(leagueGenomeSpec); // fail fast on a bad spec before spawning workers
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const output = values.output ?? join(process.cwd(), "sim-out", `setup_conditional_${stamp}.summary.json`);
    const cells = defaultCells();
    const total = cells.length * gamesPerCell;
    console.error(
        `CONDITIONAL_SETUP_V1 A/B: ${cells.length} cells x ${gamesPerCell} = ${total} games (seed ${baseSeed}, ` +
            `concurrency ${concurrency}, LIVETWIN=1, fight ${values.fight} both sides, league ${leagueGenomeSpec})`,
    );
    const started = Date.now();
    let lastLogged = 0;
    const summary = await runMeasureSetupConditional({
        gamesPerCell,
        baseSeed,
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
        console.error(
            `  ${cell.id}: A ${(cell.winRateA * 100).toFixed(2)}% +/- ${cell.clusteredSePp.toFixed(2)}pp ` +
                `(${cell.decisive} decisive/${cell.games}), t2 override ${(cell.t2OverrideRate * 100).toFixed(1)}%, ` +
                `augment override ${(cell.augmentsOverrideRate * 100).toFixed(1)}%, ` +
                `rangedStacks A ${cell.aRangedStacksPerGame.toFixed(2)} / B ${cell.bRangedStacksPerGame.toFixed(2)}`,
        );
    }
    console.error(`GATE: ${summary.gate.verdict} — ${summary.gate.reason}`);
}

if (isMainThread && (import.meta as unknown as { main?: boolean }).main) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
