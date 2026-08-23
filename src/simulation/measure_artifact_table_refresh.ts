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

import { creatureInfo, scoreCreature } from "../ai/setup/creature_score";
import { LEAGUE_ROUND3_DRAFT_SPEC, parseDraftGenome, projectDraftGenomeForShipping } from "../ai/setup/draft_ship";
import { SETUP_POLICY_V0 } from "../ai/setup/setup_v0";
import { Tier1Artifact, Tier2Artifact } from "../artifacts/artifact_properties";
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
    type PickBundle,
    type PickRandomInt,
    type PickTeam,
} from "../picks/pick_sim";
import { creaturesByLevel, makeRng, resolveStackAmount, DEFAULT_AMOUNT_BY_LEVEL, type IArmyUnitSpec } from "./army";
import { runMatch, type IMatchResult } from "./battle_engine";
import { creatureIdForName } from "./draft";
import { pickLeagueBundle, pickLeagueCreature, type ILeagueGenome } from "./league_genome";
import { LIVETWIN_PRESET } from "./livetwin";

/**
 * BLIND T1/T2 ARTIFACT TABLE REFRESH — full-game A/B bake (setup/measurement lane, post artifact-seeding
 * bugfix b4b8b7e).
 *
 * `setup_strategy.ts`'s TIER1_ARTIFACT_WINRATE / TIER2_ARTIFACT_WINRATE (afe1e9a, "v0.5 self-play, 50k
 * games") predate LIVETWIN entirely (measured without augments) and, even if re-measured naively today,
 * would have hit the artifact-seeding bug whenever augments were present. Both are now stale: post-fix
 * remeasurement under the live config reranks several artifacts hard (see
 * scratchpad `w8_t2/preregistration.md`). This harness A/B-tests plugging the REFRESHED tables into the
 * SAME `setup_v0` argmax logic (pickBundle's additive T1 term, pickArtifactT2's direct T2 argmax) against
 * the CURRENT shipped tables, in complete pick->fight games — mirrors the peer's
 * `measure_setup_conditional.ts` harness shape (real pick_sim structure, paired seat-swap, v0.7 LiveTwin
 * fights) but the two arms differ ONLY in which artifact table the setup policy consults, not in any
 * roster-conditional rule.
 *
 * Draft distributions: `heuristic` (setup-v0 scoreCreature argmax, the live untrained draft daemon — the
 * ONLY distribution whose bundle pick actually runs through TIER1_ARTIFACT_WINRATE) and `league` (the
 * committed ship-path genome; its bundle pick uses its own trained tier-1 weights, so the refresh only
 * moves its T2 pick — which, like the live `pick_decider`, is unconditionally `SETUP_POLICY_V0.pickArtifactT2`
 * regardless of draft distribution). `ranged`/`random` are a non-regression cohort battery (not pooled into
 * the headline gate), matching "always test melee-heavy/range-heavy/random" practice.
 */

export type TableArmDist = "heuristic" | "league" | "ranged" | "random";
export const TABLE_ARM_DIST_NAMES: readonly TableArmDist[] = ["heuristic", "league", "ranged", "random"];

/** The Step-A measured candidate tables (20,000 games/tier, v0.7, LIVETWIN=1, seeds 84000710/84001710). */
export const REFRESHED_TIER1_ARTIFACT_WINRATE: Record<number, number> = {
    [Tier1Artifact.CURSED_WARD]: 79.8,
    [Tier1Artifact.WOUNDING_CHARM]: 51.5,
    [Tier1Artifact.IRON_PLATE]: 51.4,
    [Tier1Artifact.KEEN_BLADE]: 49.7,
    [Tier1Artifact.VETERAN_HELM]: 49.3,
    [Tier1Artifact.DUAL_STRIKE_CHARM]: 47.2,
    [Tier1Artifact.SWIFT_BOOTS]: 46.6,
    [Tier1Artifact.HELM_OF_FOCUS]: 46.1,
    [Tier1Artifact.AMULET_OF_RESOLVE]: 45.4,
    [Tier1Artifact.HUNTERS_LONGBOW]: 45.0,
    [Tier1Artifact.WINGED_BOOTS]: 44.5,
    [Tier1Artifact.BROKEN_AEGIS]: 42.8,
};

export const REFRESHED_TIER2_ARTIFACT_WINRATE: Record<number, number> = {
    [Tier2Artifact.TOME_OF_AMPLIFICATION]: 68.8,
    [Tier2Artifact.TITAN_PLATE]: 63.9,
    [Tier2Artifact.WARLORDS_EDGE]: 63.7,
    [Tier2Artifact.CLOVER_OF_FORTUNE]: 62.2,
    [Tier2Artifact.FARSIGHT_QUIVER]: 47.1,
    [Tier2Artifact.RIME_CHARM]: 46.3,
    [Tier2Artifact.HOLY_CROSS]: 46.1,
    [Tier2Artifact.LAVA_STRIDERS]: 45.4,
    [Tier2Artifact.GIANTS_MAUL]: 45.3,
    [Tier2Artifact.PENDANT_OF_VITALITY]: 41.5,
    [Tier2Artifact.BERSERKERS_BOND]: 40.2,
    [Tier2Artifact.CROWN_OF_COMMAND]: 29.7,
};

export interface ITableArmCell {
    id: string;
    draft: TableArmDist;
    /** Control: BOTH arms use the CURRENT shipped table — a fairness/determinism check, must be 50.00%. */
    control: boolean;
}

export function defaultCells(): ITableArmCell[] {
    const cells: ITableArmCell[] = [];
    for (const draft of TABLE_ARM_DIST_NAMES) {
        cells.push({ id: `${draft}__control`, draft, control: true });
        cells.push({ id: `${draft}__refreshed`, draft, control: false });
    }
    return cells;
}

// ---------------------------------------------------------------------------------------------------------
// Draft policies (identical on both seats within a cell — the arm only changes which artifact table the
// setup layer consults, never which creatures get offered/picked)
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

const isRanged = (creatureId: number): boolean => !!creatureInfo(creatureId)?.ranged;
const rangedFirstScore = (id: number): number => (isRanged(id) ? 1_000_000 : 0) + scoreCreature(id);

/** pickBundle re-implemented with an injectable T1 table (byte-identical formula to setup_v0.pickBundle). */
function bundleScoreWithTable(bundles: readonly PickBundle[], t1Table: Readonly<Record<number, number>>): number {
    let bestIdx = 0;
    let bestScore = -Infinity;
    bundles.forEach(([l1, l2, t1], idx) => {
        const score = scoreCreature(l1) + scoreCreature(l2) + (t1Table[t1] ?? 50);
        if (score > bestScore) {
            bestScore = score;
            bestIdx = idx;
        }
    });
    return bestIdx;
}

/** pickArtifactT2 re-implemented with an injectable T2 table (byte-identical formula to setup_v0). */
function artifactT2WithTable(offered: readonly number[], t2Table: Readonly<Record<number, number>>): number {
    return argmaxId(offered, (id) => t2Table[id] ?? 0);
}

function chooseBundle(
    state: IPickSimState,
    team: PickTeam,
    draft: TableArmDist,
    refreshed: boolean,
    rng: PickRandomInt,
    genome?: ILeagueGenome,
): number {
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
    if (draft === "random") {
        return Math.floor(rng(own.bundles.length));
    }
    // heuristic: the only distribution whose bundle pick actually runs through the T1 table.
    return refreshed
        ? bundleScoreWithTable(own.bundles, REFRESHED_TIER1_ARTIFACT_WINRATE)
        : SETUP_POLICY_V0.pickBundle(own.bundles);
}

function chooseCreature(
    state: IPickSimState,
    team: PickTeam,
    draft: TableArmDist,
    rng: PickRandomInt,
    genome?: ILeagueGenome,
): number {
    if (draft === "league") {
        return pickLeagueCreature(state, team, genome!);
    }
    const choices = getVisibleCreatureChoices(state, team);
    if (!choices.length) {
        throw new Error("No visible creature choices for the draft policy");
    }
    if (draft === "random") {
        return choices[Math.floor(rng(choices.length))];
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

export interface ITableArmArmy {
    roster: IArmyUnitSpec[];
    perk: number;
    augments: ReturnType<typeof SETUP_POLICY_V0.pickAugments>;
    synergies: ReturnType<typeof SETUP_POLICY_V0.pickSynergies>;
    tier1Artifact: number;
    tier2Artifact: number;
    t1Overridden: boolean;
    t2Overridden: boolean;
}

export function runTableArmPickGame(
    seed: number,
    draft: TableArmDist,
    refreshedTeam: PickTeam | undefined,
    genome?: ILeagueGenome,
): { lower: ITableArmArmy; upper: ITableArmArmy } {
    const rng = makeRng(seed >>> 0);
    const rngInt: PickRandomInt = (maxExclusive) => Math.floor(rng() * maxExclusive);
    let state = createPickSimState(rngInt);
    const t2Outcome = new Map<PickTeam, { artifactId: number; overridden: boolean }>();
    const t1Outcome = new Map<PickTeam, boolean>();

    const teamState = (team: PickTeam): IPickTeamState => (team === LOWER ? state.lower : state.upper);
    const accept = (action: Parameters<typeof transitionPickSim>[1]): void => {
        const transition = transitionPickSim(state, action, rngInt);
        if (transition.status !== "accepted") {
            throw new Error(`Table-refresh pick driver: non-accepted ${action.type} (${transition.reason})`);
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
                    const refreshed = team === refreshedTeam;
                    const bundleIndex = chooseBundle(state, team, draft, refreshed, rngInt, genome);
                    if (draft === "heuristic") {
                        const staticIndex = SETUP_POLICY_V0.pickBundle(teamState(team).bundles);
                        t1Outcome.set(team, refreshed && bundleIndex !== staticIndex);
                    } else {
                        t1Outcome.set(team, false);
                    }
                    accept({ type: "select_bundle", team, bundleIndex });
                }
            }
        } else if (phase.phase === PBTypes.PickPhaseVals.PICK) {
            const team = phase.actors[0];
            const creatureId = chooseCreature(state, team, draft, rngInt, genome);
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
                const refreshed = team === refreshedTeam;
                const artifactId = refreshed
                    ? artifactT2WithTable(own.tier2Offers, REFRESHED_TIER2_ARTIFACT_WINRATE)
                    : staticPick;
                t2Outcome.set(team, { artifactId, overridden: refreshed && artifactId !== staticPick });
                accept({ type: "select_tier2", team, artifactId });
            }
        } else {
            throw new Error(`Pick driver reached unexpected phase ${phase.phase}`);
        }
    }

    const materialize = (team: PickTeam): ITableArmArmy => {
        const own = teamState(team);
        const t2 = t2Outcome.get(team);
        if (own.creatures.length !== 6 || own.tier1Artifact === undefined || !t2) {
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
        return {
            roster,
            perk: own.perk,
            augments: SETUP_POLICY_V0.pickAugments(budget),
            synergies: SETUP_POLICY_V0.pickSynergies(own.creatures),
            tier1Artifact: own.tier1Artifact,
            tier2Artifact: t2.artifactId,
            t1Overridden: t1Outcome.get(team) ?? false,
            t2Overridden: t2.overridden,
        };
    };

    return { lower: materialize(LOWER), upper: materialize(UPPER) };
}

// ---------------------------------------------------------------------------------------------------------
// Game runner
// ---------------------------------------------------------------------------------------------------------

export interface ITableArmOptions {
    gamesPerCell: number;
    baseSeed: number;
    fightVersion: string;
    leagueGenomeSpec: string;
}

export interface ITableArmRecord {
    cellId: string;
    game: number;
    seed: number;
    aIsLower: boolean;
    winnerSlot: "a" | "b" | "draw";
    laps: number;
    endReason: IMatchResult["endReason"];
    aT1Overridden: boolean;
    aT2Overridden: boolean;
}

let leagueGenomeCache: { spec: string; genome: ILeagueGenome } | undefined;

export function shippedLeagueGenome(spec: string): ILeagueGenome {
    if (!leagueGenomeCache || leagueGenomeCache.spec !== spec) {
        leagueGenomeCache = { spec, genome: projectDraftGenomeForShipping(parseDraftGenome(spec)) };
    }
    return leagueGenomeCache.genome;
}

export function cellBaseSeed(baseSeed: number, cellIndex: number): number {
    let h = (baseSeed >>> 0) ^ 0x71337abc;
    h = Math.imul(h ^ (cellIndex + 0x2545), 0x85ebca6b) >>> 0;
    h ^= h >>> 15;
    h = Math.imul(h, 0x27d4eb2f) >>> 0;
    return (h ^ (h >>> 13)) >>> 0;
}

export function playTableArmGame(cell: ITableArmCell, options: ITableArmOptions, game: number): ITableArmRecord {
    if (!Number.isSafeInteger(game) || game < 0 || game >= options.gamesPerCell) {
        throw new Error(`game must be in [0, ${options.gamesPerCell}); got ${game}`);
    }
    const pairIndex = Math.floor(game / 2);
    const seed = ((options.baseSeed >>> 0) + pairIndex * 0x9e3779b1) >>> 0;
    const aIsLower = game % 2 === 0;
    const refreshedTeam = cell.control ? undefined : aIsLower ? LOWER : UPPER;
    const genome = cell.draft === "league" ? shippedLeagueGenome(options.leagueGenomeSpec) : undefined;
    const { lower, upper } = runTableArmPickGame(seed, cell.draft, refreshedTeam, genome);
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
    const winnerSlot = result.winner === "draw" ? "draw" : (result.winner === "green") === aIsLower ? "a" : "b";
    return {
        cellId: cell.id,
        game,
        seed,
        aIsLower,
        winnerSlot,
        laps: result.laps,
        endReason: result.endReason,
        aT1Overridden: a.t1Overridden,
        aT2Overridden: a.t2Overridden,
    };
}

// ---------------------------------------------------------------------------------------------------------
// Aggregation + gate
// ---------------------------------------------------------------------------------------------------------

export const TABLE_ARM_PAIR_CLUSTER_SIZE = 2;

export interface ITableArmCellSummary {
    id: string;
    draft: TableArmDist;
    control: boolean;
    games: number;
    decisive: number;
    draws: number;
    winRateA: number;
    clusteredSePp: number;
    gainPp: number;
    avgLaps: number;
    t1OverrideRate: number;
    t2OverrideRate: number;
}

export interface ICellTally {
    cell: ITableArmCell;
    baseSeed: number;
    games: number;
    winsA: number;
    winsB: number;
    draws: number;
    laps: number;
    t1Overrides: number;
    t2Overrides: number;
}

export function emptyTally(cell: ITableArmCell, baseSeed: number): ICellTally {
    return { cell, baseSeed, games: 0, winsA: 0, winsB: 0, draws: 0, laps: 0, t1Overrides: 0, t2Overrides: 0 };
}

export function tallyRecord(tally: ICellTally, record: ITableArmRecord): void {
    tally.games += 1;
    if (record.winnerSlot === "a") tally.winsA += 1;
    else if (record.winnerSlot === "b") tally.winsB += 1;
    else tally.draws += 1;
    tally.laps += record.laps;
    tally.t1Overrides += Number(record.aT1Overridden);
    tally.t2Overrides += Number(record.aT2Overridden);
}

export function summarizeTally(tally: ICellTally): ITableArmCellSummary {
    const decisive = tally.winsA + tally.winsB;
    const rate = decisive ? tally.winsA / decisive : 0.5;
    const games = Math.max(1, tally.games);
    const binomialSePp = decisive ? 100 * Math.sqrt((rate * (1 - rate)) / decisive) : Number.POSITIVE_INFINITY;
    return {
        id: tally.cell.id,
        draft: tally.cell.draft,
        control: tally.cell.control,
        games: tally.games,
        decisive,
        draws: tally.draws,
        winRateA: rate,
        clusteredSePp: Math.sqrt(TABLE_ARM_PAIR_CLUSTER_SIZE) * binomialSePp,
        gainPp: (rate - 0.5) * 100,
        avgLaps: tally.laps / games,
        t1OverrideRate: tally.t1Overrides / games,
        t2OverrideRate: tally.t2Overrides / games,
    };
}

export const TABLE_REFRESH_GATE = {
    pooledMinPp: 1,
    cellFloorPp: -0.5,
    headlineCells: ["heuristic__refreshed", "league__refreshed"] as readonly string[],
    cohortCells: ["ranged__refreshed", "random__refreshed"] as readonly string[],
} as const;

export interface ITableRefreshGateVerdict {
    thresholds: typeof TABLE_REFRESH_GATE;
    pooledGainPp: number;
    pooledSePp: number;
    worstHeadlineCell: { id: string; gainPp: number } | null;
    worstCohortCell: { id: string; gainPp: number } | null;
    controlsOk: boolean;
    verdict: "PASS" | "FAIL";
    reason: string;
}

/** Pools multiple cell-summary arrays (e.g. several seeded batteries) by id before gating. */
export function poolCellSummaries(batteries: readonly ITableArmCellSummary[][]): ITableArmCellSummary[] {
    const byId = new Map<string, { cell: ITableArmCellSummary[]; winsA: number; decisive: number }>();
    for (const battery of batteries) {
        for (const cell of battery) {
            const entry = byId.get(cell.id) ?? { cell: [], winsA: 0, decisive: 0 };
            entry.cell.push(cell);
            entry.winsA += cell.winRateA * cell.decisive;
            entry.decisive += cell.decisive;
            byId.set(cell.id, entry);
        }
    }
    return [...byId.entries()].map(([id, entry]) => {
        const first = entry.cell[0];
        const games = entry.cell.reduce((s, c) => s + c.games, 0);
        const draws = entry.cell.reduce((s, c) => s + c.draws, 0);
        const laps = entry.cell.reduce((s, c) => s + c.avgLaps * c.games, 0);
        const t1o = entry.cell.reduce((s, c) => s + c.t1OverrideRate * c.games, 0);
        const t2o = entry.cell.reduce((s, c) => s + c.t2OverrideRate * c.games, 0);
        const rate = entry.decisive ? entry.winsA / entry.decisive : 0.5;
        const binomialSePp = entry.decisive
            ? 100 * Math.sqrt((rate * (1 - rate)) / entry.decisive)
            : Number.POSITIVE_INFINITY;
        return {
            id,
            draft: first.draft,
            control: first.control,
            games,
            decisive: entry.decisive,
            draws,
            winRateA: rate,
            clusteredSePp: Math.sqrt(TABLE_ARM_PAIR_CLUSTER_SIZE) * binomialSePp,
            gainPp: (rate - 0.5) * 100,
            avgLaps: games ? laps / games : 0,
            t1OverrideRate: games ? t1o / games : 0,
            t2OverrideRate: games ? t2o / games : 0,
        };
    });
}

export function evaluateGate(pooledCells: readonly ITableArmCellSummary[]): ITableRefreshGateVerdict {
    const byId = new Map(pooledCells.map((cell) => [cell.id, cell]));
    const headline = TABLE_REFRESH_GATE.headlineCells
        .map((id) => byId.get(id))
        .filter((cell): cell is ITableArmCellSummary => !!cell);
    let wins = 0;
    let decisive = 0;
    for (const cell of headline) {
        wins += cell.winRateA * cell.decisive;
        decisive += cell.decisive;
    }
    const pooledRate = decisive ? wins / decisive : 0.5;
    const pooledGainPp = (pooledRate - 0.5) * 100;
    const pooledSePp = decisive
        ? Math.sqrt(TABLE_ARM_PAIR_CLUSTER_SIZE) * 100 * Math.sqrt((pooledRate * (1 - pooledRate)) / decisive)
        : Number.POSITIVE_INFINITY;
    const worstHeadlineCell = headline.length
        ? headline.reduce((worst, cell) => (cell.gainPp < worst.gainPp ? cell : worst))
        : null;
    const cohort = TABLE_REFRESH_GATE.cohortCells
        .map((id) => byId.get(id))
        .filter((cell): cell is ITableArmCellSummary => !!cell);
    const worstCohortCell = cohort.length
        ? cohort.reduce((worst, cell) => (cell.gainPp < worst.gainPp ? cell : worst))
        : null;
    const controls = pooledCells.filter((cell) => cell.control);
    const controlsOk = controls.length > 0 && controls.every((cell) => Math.abs(cell.gainPp) < 1e-9);
    const pass =
        headline.length === TABLE_REFRESH_GATE.headlineCells.length &&
        pooledGainPp >= TABLE_REFRESH_GATE.pooledMinPp &&
        (worstHeadlineCell?.gainPp ?? -Infinity) >= TABLE_REFRESH_GATE.cellFloorPp &&
        (worstCohortCell?.gainPp ?? -Infinity) >= TABLE_REFRESH_GATE.cellFloorPp &&
        controlsOk;
    return {
        thresholds: TABLE_REFRESH_GATE,
        pooledGainPp,
        pooledSePp,
        worstHeadlineCell: worstHeadlineCell ? { id: worstHeadlineCell.id, gainPp: worstHeadlineCell.gainPp } : null,
        worstCohortCell: worstCohortCell ? { id: worstCohortCell.id, gainPp: worstCohortCell.gainPp } : null,
        controlsOk,
        verdict: pass ? "PASS" : "FAIL",
        reason: pass
            ? `Pooled +${pooledGainPp.toFixed(2)}pp >= +${TABLE_REFRESH_GATE.pooledMinPp}pp across heuristic+league, ` +
              `no headline/cohort cell below ${TABLE_REFRESH_GATE.cellFloorPp}pp, controls exact 50.00%.`
            : `Bar: pooled >= +${TABLE_REFRESH_GATE.pooledMinPp}pp (got ${pooledGainPp.toFixed(2)}), headline floor ` +
              `${TABLE_REFRESH_GATE.cellFloorPp}pp (worst ${worstHeadlineCell ? `${worstHeadlineCell.id} ${worstHeadlineCell.gainPp.toFixed(2)}` : "n/a"}), ` +
              `cohort floor (worst ${worstCohortCell ? `${worstCohortCell.id} ${worstCohortCell.gainPp.toFixed(2)}` : "n/a"}), ` +
              `controlsOk=${controlsOk}.`,
    };
}

// ---------------------------------------------------------------------------------------------------------
// Worker pool (this file spawns itself as the worker)
// ---------------------------------------------------------------------------------------------------------

interface IJob {
    cell: ITableArmCell;
    baseSeed: number;
    game: number;
}

type WorkerReply = { type: "ready" } | { type: "result"; record: ITableArmRecord } | { type: "error"; error: string };

async function runJobsConcurrent(
    jobs: readonly IJob[],
    options: ITableArmOptions,
    tallies: Map<string, ICellTally>,
    concurrency: number,
    onRecord?: (completed: number, total: number) => void,
): Promise<void> {
    const total = jobs.length;
    const poolSize = Math.max(1, Math.min(Math.floor(concurrency) || 1, total));
    if (poolSize <= 1) {
        let completed = 0;
        for (const job of jobs) {
            const record = playTableArmGame(job.cell, { ...options, baseSeed: job.baseSeed }, job.game);
            tallyRecord(tallies.get(job.cell.id)!, record);
            completed += 1;
            onRecord?.(completed, total);
        }
        return;
    }
    const plainOptions: ITableArmOptions = {
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
                    workerData: { tableArm: true, options: plainOptions },
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

if (!isMainThread && parentPort && (workerData as { tableArm?: boolean } | undefined)?.tableArm) {
    const port = parentPort;
    const workerOptions = (workerData as { options: ITableArmOptions }).options;
    port.on("message", (message: { type: "game"; job: IJob } | { type: "stop" }) => {
        if (message.type === "stop") {
            port.close();
            return;
        }
        try {
            const { job } = message;
            const record = playTableArmGame(job.cell, { ...workerOptions, baseSeed: job.baseSeed }, job.game);
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

export interface IMeasureTableArmSummary {
    schemaVersion: 1;
    kind: "artifact_table_refresh_ab";
    fightVersion: string;
    startedAt: string;
    wallSeconds: number;
    config: {
        liveTwinEnv: string;
        gamesPerCell: number;
        baseSeed: number;
        concurrency: number;
        totalGames: number;
    };
    cells: ITableArmCellSummary[];
}

export interface IMeasureTableArmOptions extends ITableArmOptions {
    concurrency: number;
    cells?: ITableArmCell[];
    onProgress?: (completed: number, total: number) => void;
}

export async function runMeasureTableArm(options: IMeasureTableArmOptions): Promise<IMeasureTableArmSummary> {
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
        kind: "artifact_table_refresh_ab",
        fightVersion: options.fightVersion,
        startedAt,
        wallSeconds,
        config: {
            liveTwinEnv: process.env.LIVETWIN ?? "",
            gamesPerCell: options.gamesPerCell,
            baseSeed: options.baseSeed,
            concurrency: options.concurrency,
            totalGames: jobs.length,
        },
        cells: summaries,
    };
}

function positiveInteger(value: string, flag: string): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error(`${flag} must be a positive integer; got ${value}`);
    }
    return parsed;
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
            cells: { type: "string", default: "all" }, // "all" | "primary" (heuristic+league) | "cohort" (ranged+random)
            output: { type: "string" },
            help: { type: "boolean", short: "h", default: false },
        },
        strict: true,
        allowPositionals: false,
    });
    if (values.help) {
        console.log(
            "usage: bun src/simulation/measure_artifact_table_refresh.ts [--games 4000] [--seed 1] " +
                "[--concurrency 8] [--fight v0.7] [--cells all|primary|cohort] [--output path.json]",
        );
        return;
    }
    process.env.LIVETWIN = "1"; // live-faithful config for this process and every worker it spawns
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
    const allCells = defaultCells();
    const cells =
        values.cells === "primary"
            ? allCells.filter((c) => c.draft === "heuristic" || c.draft === "league")
            : values.cells === "cohort"
              ? allCells.filter((c) => c.draft === "ranged" || c.draft === "random")
              : allCells;
    const total = cells.length * gamesPerCell;
    console.error(
        `ARTIFACT TABLE REFRESH A/B: ${cells.length} cells x ${gamesPerCell} = ${total} games (seed ${baseSeed}, ` +
            `concurrency ${concurrency}, LIVETWIN=1, fight ${values.fight} both sides)`,
    );
    const started = Date.now();
    let lastLogged = 0;
    const summary = await runMeasureTableArm({
        gamesPerCell,
        baseSeed,
        concurrency,
        fightVersion: values.fight,
        leagueGenomeSpec,
        cells,
        onProgress: (completed, totalJobs) => {
            if (completed - lastLogged >= Math.max(500, Math.floor(totalJobs / 25)) || completed === totalJobs) {
                lastLogged = completed;
                const rate = (completed / (Date.now() - started)) * 1000;
                console.error(`  ${completed}/${totalJobs} games (${rate.toFixed(1)} games/s)`);
            }
        },
    });
    const json = `${JSON.stringify(summary, null, 2)}\n`;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const output = values.output ?? join(process.cwd(), "sim-out", `artifact_table_refresh_${stamp}.summary.json`);
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
                `(${cell.decisive} decisive/${cell.games}), t1 override ${(cell.t1OverrideRate * 100).toFixed(1)}%, ` +
                `t2 override ${(cell.t2OverrideRate * 100).toFixed(1)}%`,
        );
    }
    if (values.cells === "all" || values.cells === "primary") {
        const gate = evaluateGate(summary.cells);
        console.error(
            `GATE (single battery, informational only — real gate pools batteries): ${gate.verdict} — ${gate.reason}`,
        );
    }
}

if (isMainThread && (import.meta as unknown as { main?: boolean }).main) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
