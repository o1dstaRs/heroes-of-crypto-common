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

import { classifyRevealedThreats, type IRevealedThreats } from "../ai/versions/v0_7_placement_reveal";
import { FightStateManager } from "../fights/fight_state_manager";
import { PBTypes } from "../generated/protobuf/v1/types";
import { getKnownOpponentCreatures } from "../picks/pick_sim";
import { creaturesByLevel, makeRng, resolveStackAmount, DEFAULT_AMOUNT_BY_LEVEL, type IArmyUnitSpec } from "./army";
import { runMatch, type IMatchConfig, type IMatchResult, type Side } from "./battle_engine";
import { creatureIdForName } from "./draft";
import { liveTwinSetup } from "./livetwin";
import { buildArmyFromPick, runPickPhase, type PickPolicyName } from "./measure_picksim_oracle";

/**
 * REGISTERED A/B HARNESS — REVEAL-CONDITIONED PLACEMENT (V07_PLACEMENT_REVEAL).
 * The historical run referenced scratchpad w5_placement/preregistration.md (2026-07-15), but that artifact
 * is not tracked. Treat its reported result as diagnostic until preregistration and raw/result hashes land.
 *
 * Question: does v0.7+reveal-conditioned placement beat today's v0.7 placement in FULL games, when the
 * placement may use ONLY what the seat legitimately learned during picks?
 *
 * Design: both seats fight the SAME version (default v0.7). Per pair (games 2k / 2k+1) the armies and
 * the battle seed are IDENTICAL; game 2k hands the GREEN seat its legitimate reveals, game 2k+1 hands
 * them to the RED seat. The control seat receives NO reveals, so its placement is byte-identical
 * baseline v0.7 (the fight RNG is seed-deterministic, so a no-op treatment makes the pair cancel
 * EXACTLY). Metric: treated-seat decisive win rate; delta pp = (rate - 0.5) * 100.
 *
 * Cells:
 *  - drafted_fmr1/fmr05/fmr0 — PICK_SIM-driven drafts (live reducer, SEE_NONE frozen => reveals come
 *    from pick collisions, the live doctrine). The FMR axis maps to the draft policy BOTH seats use:
 *    1 = "champion" (melee co-evo, the live distribution), 0 = "policy_v0" (heuristic, ranged-leaning),
 *    0.5 = per-pair deterministic coin flip between the two.
 *  - mirror cells — FIXED symmetric rosters where the revealed threat exists deterministically; the
 *    treated seat's reveal list is the full opponent roster (models a full-collision/SEE_ALL reveal),
 *    LiveTwin stacks + shipped SEE_NONE setup, no artifacts.
 *
 * ITERATION 1 (seeds 82001710..82005710, reported 18k games, 2026-07-15) — historical verdict FAIL: pooled
 * +1.78pp ±0.38 but the gap-2 wide-dispersion heuristic LOST -14.10pp ±0.89 on the Gargantuan mirror
 * (baked 1-cell gap is already the cohesion optimum); the flyer screen WON +20.76pp ±0.84; drafted
 * cells +0.79/+1.49/+0.44. AMENDMENT 1 (referenced but untracked): the splash heuristic is
 * replaced by a baked-dispersion precedence guard, charger_mirror isolates the corner shift, and
 * garg_null (bar-exempt) proves splash games are now exact no-ops. Fresh seeds 82011710..82016710.
 *
 * DECLARED SHIP BAR: pooled decisive delta over the in-bar cells >= +1.0pp AND no in-bar cell
 * below -0.5pp. PASS does NOT flip the default — that is an owner sign-off item. FAIL = the
 * heuristics stay env-gated experimental and the lever is recorded tapped.
 *
 * Usage:
 *   bun src/simulation/measure_reveal_placement.ts                        # the full registered battery
 *   ... --cell drafted_fmr1 --games 200 --seed 82000710 --gate off       # sanity arm (expect EXACT 50.00)
 *   ... --fight-version v0.7 --concurrency 8 --output sim-out/reveal_placement.json
 */

export const REVEAL_CELL_NAMES = [
    "drafted_fmr1",
    "drafted_fmr05",
    "drafted_fmr0",
    "garg_null",
    "flyer_mirror",
    "charger_mirror",
] as const;
export type RevealCellName = (typeof REVEAL_CELL_NAMES)[number];

export interface IRevealCell {
    name: RevealCellName;
    kind: "drafted" | "mirror";
    /** Preregistered base seed (82xxx710 block) — see preregistration.md. */
    seed: number;
    /** Preregistered game count (paired: game 2k treats green, 2k+1 treats red). */
    games: number;
    /** Drafted cells: the pick policy BOTH seats use ("mix" = per-pair coin flip champion/policy_v0). */
    policy?: "champion" | "policy_v0" | "mix";
    /** Mirror cells: the fixed symmetric roster. */
    roster?: readonly { level: number; creatureName: string }[];
    /** Excluded from the ship bar (null/correctness cells like garg_null, expected EXACT 50.00). */
    barExempt?: boolean;
}

/** Deterministic splash threat (Gargantuan: Area Throw) inside an otherwise ground-melee army. */
export const GARG_MIRROR_ROSTER: readonly { level: number; creatureName: string }[] = [
    { level: 1, creatureName: "Squire" },
    { level: 1, creatureName: "Orc" },
    { level: 2, creatureName: "Pikeman" },
    { level: 2, creatureName: "Hyena" },
    { level: 3, creatureName: "Crusader" },
    { level: 4, creatureName: "Gargantuan" },
];

/** Three flyers (the revealed threat) + two shooters + one ground melee (the screen's guard). */
export const FLYER_MIRROR_ROSTER: readonly { level: number; creatureName: string }[] = [
    { level: 1, creatureName: "Squire" },
    { level: 1, creatureName: "Arbalester" },
    { level: 2, creatureName: "Harpy" },
    { level: 2, creatureName: "Elf" },
    { level: 3, creatureName: "Griffin" },
    { level: 4, creatureName: "Black Dragon" },
];

/** Two Rapid Charge stacks (all the enabled catalog offers), zero flyers/splash — isolates the corner shift. */
export const CHARGER_MIRROR_ROSTER: readonly { level: number; creatureName: string }[] = [
    { level: 1, creatureName: "Wolf Rider" },
    { level: 1, creatureName: "Arbalester" },
    { level: 2, creatureName: "Nomad" },
    { level: 2, creatureName: "Pikeman" },
    { level: 3, creatureName: "Goblin Knight" },
    { level: 4, creatureName: "Hydra" },
];

/** The declared AMENDMENT-1 battery (reported fresh-before-run; timing is not independently verifiable).
 * Iteration 1 (82001710..82005710) is treated as burned despite its missing external record. */
export function revealCells(): IRevealCell[] {
    return [
        { name: "drafted_fmr1", kind: "drafted", seed: 82011710, games: 4000, policy: "champion" },
        { name: "drafted_fmr05", kind: "drafted", seed: 82012710, games: 4000, policy: "mix" },
        { name: "drafted_fmr0", kind: "drafted", seed: 82013710, games: 4000, policy: "policy_v0" },
        { name: "garg_null", kind: "mirror", seed: 82014710, games: 1000, roster: GARG_MIRROR_ROSTER, barExempt: true },
        { name: "flyer_mirror", kind: "mirror", seed: 82015710, games: 3000, roster: FLYER_MIRROR_ROSTER },
        { name: "charger_mirror", kind: "mirror", seed: 82016710, games: 3000, roster: CHARGER_MIRROR_ROSTER },
    ];
}

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const PAIR_SEED_STEP = 0x9e3779b1;
const MIX_POLICY_SALT = 0x51ed270b;

/** Mirror-cell roster spec: catalog lookup + LiveTwin exp-budget stack amounts. */
export function mirrorRoster(names: readonly { level: number; creatureName: string }[]): IArmyUnitSpec[] {
    return names.map(({ level, creatureName }) => {
        const entry = creaturesByLevel(level).find((candidate) => candidate.creatureName === creatureName);
        if (!entry) {
            throw new Error(`Mirror roster creature ${creatureName} (L${level}) is not in the catalog`);
        }
        return {
            faction: entry.faction,
            creatureName: entry.creatureName,
            level: entry.level,
            size: entry.size,
            amount: resolveStackAmount(entry.creatureName, entry.level, DEFAULT_AMOUNT_BY_LEVEL, "expBudget"),
        };
    });
}

/** Drafted-cell pick policy for a pair — "mix" resolves deterministically from the pair seed. */
export function policyForPair(cell: IRevealCell, pairSeed: number): PickPolicyName {
    if (cell.policy === "mix") {
        return makeRng((pairSeed ^ MIX_POLICY_SALT) >>> 0)() < 0.5 ? "champion" : "policy_v0";
    }
    return cell.policy ?? "champion";
}

export interface IRevealGameRecord {
    cellName: RevealCellName;
    game: number;
    pairIndex: number;
    seed: number;
    treatedSide: Side;
    winner: Side | "draw";
    treatedResult: "win" | "loss" | "draw";
    laps: number;
    endReason: IMatchResult["endReason"];
    /** Creature ids the TREATED seat legitimately knew (and was handed) at placement time. */
    treatedRevealCount: number;
    /** Threat classification of the treated seat's reveals (which heuristic family could fire). */
    treatedThreats: IRevealedThreats;
    policy?: PickPolicyName;
}

export interface IRevealGameDependencies {
    matchRunner?: (config: IMatchConfig) => IMatchResult;
}

const defaultMatchRunner = (config: IMatchConfig): IMatchResult => {
    // Prime the lazy singleton outside runMatch's seeded scope (same pattern as measure_picksim_oracle).
    FightStateManager.getInstance();
    return runMatch(config);
};

/**
 * Play one independently addressable game. Games 2k / 2k+1 share the pick outcome (or mirror roster)
 * and the battle seed; only WHICH seat receives its legitimate reveals differs.
 */
export function playRevealGame(
    cell: IRevealCell,
    fightVersion: string,
    game: number,
    dependencies: IRevealGameDependencies = {},
): IRevealGameRecord {
    if (!Number.isSafeInteger(game) || game < 0 || game >= cell.games) {
        throw new Error(`game must be in [0, ${cell.games}); got ${game}`);
    }
    const matchRunner = dependencies.matchRunner ?? defaultMatchRunner;
    const pairIndex = Math.floor(game / 2);
    const seed = ((cell.seed >>> 0) + pairIndex * PAIR_SEED_STEP) >>> 0;
    const treatedSide: Side = game % 2 === 0 ? "green" : "red";

    let config: IMatchConfig;
    let treatedRevealed: number[];
    let policy: PickPolicyName | undefined;
    if (cell.kind === "drafted") {
        policy = policyForPair(cell, seed);
        const outcome = runPickPhase(seed, policy, policy);
        const lowerArmy = buildArmyFromPick(outcome.state.lower);
        const upperArmy = buildArmyFromPick(outcome.state.upper);
        const lowerRevealed = getKnownOpponentCreatures(outcome.state, LOWER);
        const upperRevealed = getKnownOpponentCreatures(outcome.state, UPPER);
        treatedRevealed = treatedSide === "green" ? lowerRevealed : upperRevealed;
        config = {
            greenVersion: fightVersion,
            redVersion: fightVersion,
            roster: lowerArmy.roster,
            redRoster: upperArmy.roster,
            seed,
            gridType: PBTypes.GridVals.NORMAL,
            greenPerk: lowerArmy.perk,
            redPerk: upperArmy.perk,
            greenAugments: lowerArmy.augments,
            redAugments: upperArmy.augments,
            greenArtifactT1: lowerArmy.tier1Artifact,
            redArtifactT1: upperArmy.tier1Artifact,
            greenArtifactT2: lowerArmy.tier2Artifact,
            redArtifactT2: upperArmy.tier2Artifact,
            greenSynergies: lowerArmy.synergies,
            redSynergies: upperArmy.synergies,
            ...(treatedSide === "green"
                ? lowerRevealed.length
                    ? { greenRevealedCreatures: lowerRevealed }
                    : {}
                : upperRevealed.length
                  ? { redRevealedCreatures: upperRevealed }
                  : {}),
        };
    } else {
        const roster = mirrorRoster(cell.roster ?? []);
        const revealed = roster.map((unit) => creatureIdForName(unit.creatureName));
        treatedRevealed = revealed;
        const setup = liveTwinSetup();
        config = {
            greenVersion: fightVersion,
            redVersion: fightVersion,
            roster,
            seed,
            gridType: PBTypes.GridVals.NORMAL,
            greenPerk: setup.perk,
            redPerk: setup.perk,
            greenAugments: setup.augments,
            redAugments: setup.augments,
            ...(treatedSide === "green" ? { greenRevealedCreatures: revealed } : { redRevealedCreatures: revealed }),
        };
    }

    const result = matchRunner(config);
    return {
        cellName: cell.name,
        game,
        pairIndex,
        seed,
        treatedSide,
        winner: result.winner,
        treatedResult: result.winner === "draw" ? "draw" : result.winner === treatedSide ? "win" : "loss",
        laps: result.laps,
        endReason: result.endReason,
        treatedRevealCount: treatedRevealed.length,
        treatedThreats: classifyRevealedThreats(treatedRevealed),
        ...(policy === undefined ? {} : { policy }),
    };
}

// ---------------------------------------------------------------------------------------------------------
// Aggregation + registered ship bar
// ---------------------------------------------------------------------------------------------------------

export interface IRevealCellAggregate {
    cellName: RevealCellName;
    seed: number;
    barExempt: boolean;
    games: number;
    treatedWins: number;
    treatedLosses: number;
    draws: number;
    greenWins: number;
    redWins: number;
    laps: number;
    endReasons: Record<string, number>;
    gamesWithReveals: number;
    gamesWithSplash: number;
    gamesWithFlyers: number;
    gamesWithChargers: number;
    policyGames: Partial<Record<PickPolicyName, number>>;
}

export function emptyRevealAggregate(cell: IRevealCell): IRevealCellAggregate {
    return {
        cellName: cell.name,
        seed: cell.seed,
        barExempt: !!cell.barExempt,
        games: 0,
        treatedWins: 0,
        treatedLosses: 0,
        draws: 0,
        greenWins: 0,
        redWins: 0,
        laps: 0,
        endReasons: {},
        gamesWithReveals: 0,
        gamesWithSplash: 0,
        gamesWithFlyers: 0,
        gamesWithChargers: 0,
        policyGames: {},
    };
}

export function aggregateRevealRecord(aggregate: IRevealCellAggregate, record: IRevealGameRecord): void {
    aggregate.games += 1;
    if (record.treatedResult === "win") aggregate.treatedWins += 1;
    else if (record.treatedResult === "loss") aggregate.treatedLosses += 1;
    else aggregate.draws += 1;
    if (record.winner === "green") aggregate.greenWins += 1;
    else if (record.winner === "red") aggregate.redWins += 1;
    aggregate.laps += record.laps;
    aggregate.endReasons[record.endReason] = (aggregate.endReasons[record.endReason] ?? 0) + 1;
    if (record.treatedRevealCount > 0) aggregate.gamesWithReveals += 1;
    if (record.treatedThreats.splashAoe > 0) aggregate.gamesWithSplash += 1;
    if (record.treatedThreats.flyers > 0) aggregate.gamesWithFlyers += 1;
    if (record.treatedThreats.chargers > 0) aggregate.gamesWithChargers += 1;
    if (record.policy) {
        aggregate.policyGames[record.policy] = (aggregate.policyGames[record.policy] ?? 0) + 1;
    }
}

export interface IRevealCellSummary {
    cellName: RevealCellName;
    seed: number;
    barExempt: boolean;
    games: number;
    decisive: number;
    draws: number;
    treatedWins: number;
    treatedWinRate: number;
    deltaPp: number;
    /** Binomial SE in pp; clusterSePp = sqrt(2) * sePp (conservative same-seed pair design effect). */
    sePp: number;
    clusterSePp: number;
    greenSeatWinRate: number;
    avgLaps: number;
    endReasons: Record<string, number>;
    revealRate: number;
    splashThreatRate: number;
    flyerThreatRate: number;
    chargerThreatRate: number;
    policyGames: Partial<Record<PickPolicyName, number>>;
}

export function summarizeRevealCell(aggregate: IRevealCellAggregate): IRevealCellSummary {
    const decisive = aggregate.treatedWins + aggregate.treatedLosses;
    const rate = decisive ? aggregate.treatedWins / decisive : 0.5;
    const sePp = decisive ? 100 * Math.sqrt((rate * (1 - rate)) / decisive) : Number.POSITIVE_INFINITY;
    const seatDecisive = aggregate.greenWins + aggregate.redWins;
    const games = Math.max(1, aggregate.games);
    return {
        cellName: aggregate.cellName,
        seed: aggregate.seed,
        barExempt: aggregate.barExempt,
        games: aggregate.games,
        decisive,
        draws: aggregate.draws,
        treatedWins: aggregate.treatedWins,
        treatedWinRate: rate,
        deltaPp: (rate - 0.5) * 100,
        sePp,
        clusterSePp: Math.SQRT2 * sePp,
        greenSeatWinRate: seatDecisive ? aggregate.greenWins / seatDecisive : 0.5,
        avgLaps: aggregate.laps / games,
        endReasons: aggregate.endReasons,
        revealRate: aggregate.gamesWithReveals / games,
        splashThreatRate: aggregate.gamesWithSplash / games,
        flyerThreatRate: aggregate.gamesWithFlyers / games,
        chargerThreatRate: aggregate.gamesWithChargers / games,
        policyGames: aggregate.policyGames,
    };
}

/** Preregistered bar: pooled >= +1.0pp AND no cell below -0.5pp (scratchpad w5_placement/preregistration.md). */
export const REVEAL_SHIP_BAR = { pooledMinPp: 1.0, cellFloorPp: -0.5 } as const;

export interface IRevealShipVerdict {
    bar: typeof REVEAL_SHIP_BAR;
    pooledWins: number;
    pooledDecisive: number;
    pooledWinRate: number;
    pooledDeltaPp: number;
    pooledSePp: number;
    pooledClusterSePp: number;
    worstCell: RevealCellName | null;
    worstCellDeltaPp: number;
    verdict: "PASS" | "FAIL";
    reason: string;
}

export function evaluateRevealShipBar(allCells: readonly IRevealCellSummary[]): IRevealShipVerdict {
    const cells = allCells.filter((cell) => !cell.barExempt);
    const pooledWins = cells.reduce((sum, cell) => sum + cell.treatedWins, 0);
    const pooledDecisive = cells.reduce((sum, cell) => sum + cell.decisive, 0);
    const pooledWinRate = pooledDecisive ? pooledWins / pooledDecisive : 0.5;
    const pooledDeltaPp = (pooledWinRate - 0.5) * 100;
    const pooledSePp = pooledDecisive
        ? 100 * Math.sqrt((pooledWinRate * (1 - pooledWinRate)) / pooledDecisive)
        : Number.POSITIVE_INFINITY;
    const worst = cells.length
        ? cells.reduce((left, right) => (right.deltaPp < left.deltaPp ? right : left))
        : undefined;
    const pooledPass = pooledDeltaPp >= REVEAL_SHIP_BAR.pooledMinPp;
    const floorPass = !worst || worst.deltaPp >= REVEAL_SHIP_BAR.cellFloorPp;
    const verdict = pooledPass && floorPass ? "PASS" : "FAIL";
    return {
        bar: REVEAL_SHIP_BAR,
        pooledWins,
        pooledDecisive,
        pooledWinRate,
        pooledDeltaPp,
        pooledSePp,
        pooledClusterSePp: Math.SQRT2 * pooledSePp,
        worstCell: worst?.cellName ?? null,
        worstCellDeltaPp: worst?.deltaPp ?? 0,
        verdict,
        reason: !pooledPass
            ? `pooled ${pooledDeltaPp >= 0 ? "+" : ""}${pooledDeltaPp.toFixed(2)}pp < +${REVEAL_SHIP_BAR.pooledMinPp}pp bar`
            : !floorPass
              ? `cell ${worst?.cellName} at ${worst?.deltaPp.toFixed(2)}pp breaches the ${REVEAL_SHIP_BAR.cellFloorPp}pp floor`
              : `pooled +${pooledDeltaPp.toFixed(2)}pp and every cell >= ${REVEAL_SHIP_BAR.cellFloorPp}pp`,
    };
}

// ---------------------------------------------------------------------------------------------------------
// Worker pool (this file spawns itself, same pattern as measure_picksim_oracle)
// ---------------------------------------------------------------------------------------------------------

interface IRevealJob {
    cell: IRevealCell;
    game: number;
}

type WorkerReply = { type: "ready" } | { type: "result"; record: IRevealGameRecord } | { type: "error"; error: string };

async function runRevealJobs(
    jobs: readonly IRevealJob[],
    aggregates: Map<RevealCellName, IRevealCellAggregate>,
    fightVersion: string,
    concurrency: number,
    onRecord?: (completed: number, total: number) => void,
): Promise<void> {
    const total = jobs.length;
    const poolSize = Math.max(1, Math.min(Math.floor(concurrency) || 1, total));
    if (poolSize <= 1) {
        let completed = 0;
        for (const job of jobs) {
            aggregateRevealRecord(aggregates.get(job.cell.name)!, playRevealGame(job.cell, fightVersion, job.game));
            completed += 1;
            onRecord?.(completed, total);
        }
        return;
    }
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
            const job = jobs[dispatched];
            dispatched += 1;
            worker.postMessage({ type: "game", job });
        };
        for (let workerId = 0; workerId < poolSize; workerId += 1) {
            let worker: Worker;
            try {
                worker = new Worker(new URL(import.meta.url), { workerData: { revealPlacement: true, fightVersion } });
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
                aggregateRevealRecord(aggregates.get(message.record.cellName)!, message.record);
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

if (!isMainThread && parentPort && (workerData as { revealPlacement?: boolean } | undefined)?.revealPlacement) {
    const port = parentPort;
    const fightVersion = (workerData as { fightVersion: string }).fightVersion;
    port.on("message", (message: { type: "game"; job: IRevealJob } | { type: "stop" }) => {
        if (message.type === "stop") {
            port.close();
            return;
        }
        try {
            const record = playRevealGame(message.job.cell, fightVersion, message.job.game);
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

export interface IMeasureRevealSummary {
    schemaVersion: 1;
    kind: "v07_reveal_placement_ab";
    preregistration: "UNVERIFIED: referenced scratchpad w5_placement/preregistration.md is not tracked";
    fightVersion: string;
    gate: "on" | "off";
    startedAt: string;
    wallSeconds: number;
    gamesPerSecond: number;
    totalGames: number;
    cells: IRevealCellSummary[];
    shipBar: IRevealShipVerdict;
}

export interface IMeasureRevealOptions {
    cells: IRevealCell[];
    fightVersion: string;
    concurrency: number;
    gateOff?: boolean;
    onProgress?: (completed: number, total: number) => void;
}

export function validateRevealMeasurementEnvironment(
    gateOff: boolean,
    environment: NodeJS.ProcessEnv = process.env,
): "on" | "off" {
    if (environment.LIVETWIN !== "1") {
        throw new Error("Reveal-placement measurement requires LIVETWIN=1");
    }
    if (gateOff) {
        if (environment.V07_PLACEMENT_REVEAL !== undefined) {
            throw new Error("Reveal-placement gate-off measurement requires V07_PLACEMENT_REVEAL to be unset");
        }
        return "off";
    }
    if (environment.V07_PLACEMENT_REVEAL !== "on") {
        throw new Error("Reveal-placement gate-on measurement requires V07_PLACEMENT_REVEAL=on");
    }
    return "on";
}

export async function runMeasureRevealPlacement(options: IMeasureRevealOptions): Promise<IMeasureRevealSummary> {
    const gate = validateRevealMeasurementEnvironment(options.gateOff === true);
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    const aggregates = new Map<RevealCellName, IRevealCellAggregate>();
    const jobs: IRevealJob[] = [];
    for (const cell of options.cells) {
        if (!Number.isSafeInteger(cell.games) || cell.games < 2 || cell.games % 2) {
            throw new Error(`${cell.name}: games must be a positive even integer; got ${cell.games}`);
        }
        aggregates.set(cell.name, emptyRevealAggregate(cell));
        for (let game = 0; game < cell.games; game += 1) {
            jobs.push({ cell, game });
        }
    }
    await runRevealJobs(jobs, aggregates, options.fightVersion, options.concurrency, options.onProgress);
    const wallSeconds = (Date.now() - startMs) / 1000;
    const cells = options.cells.map((cell) => summarizeRevealCell(aggregates.get(cell.name)!));
    return {
        schemaVersion: 1,
        kind: "v07_reveal_placement_ab",
        preregistration: "UNVERIFIED: referenced scratchpad w5_placement/preregistration.md is not tracked",
        fightVersion: options.fightVersion,
        gate,
        startedAt,
        wallSeconds,
        gamesPerSecond: wallSeconds > 0 ? jobs.length / wallSeconds : 0,
        totalGames: jobs.length,
        cells,
        shipBar: evaluateRevealShipBar(cells),
    };
}

function printUsage(): void {
    console.log(
        "usage: bun src/simulation/measure_reveal_placement.ts [--cell all|<name>] [--games N] [--seed N] " +
            "[--gate on|off] [--fight-version v0.7] [--concurrency 8] [--output path.json]",
    );
    console.log(`  cells: ${REVEAL_CELL_NAMES.join(", ")} (default: the full registered battery)`);
    console.log("  --games/--seed only apply with an explicit single --cell (sanity/smoke overrides)");
    console.log("  --gate off runs the same battery WITHOUT V07_PLACEMENT_REVEAL (plumbing sanity, expect 50.00)");
}

export async function main(): Promise<void> {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            cell: { type: "string", default: "all" },
            games: { type: "string" },
            seed: { type: "string" },
            gate: { type: "string", default: "on" },
            "fight-version": { type: "string", default: "v0.7" },
            concurrency: { type: "string", default: String(Math.min(8, Math.max(1, availableParallelism()))) },
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
    let cells = revealCells();
    if (values.cell !== "all") {
        const cell = cells.find((candidate) => candidate.name === values.cell);
        if (!cell) {
            throw new Error(`Unknown cell ${values.cell}; expected all or one of ${REVEAL_CELL_NAMES.join(", ")}`);
        }
        if (values.games) cell.games = Number(values.games);
        if (values.seed) cell.seed = Number(values.seed) >>> 0;
        cells = [cell];
    } else if (values.games || values.seed) {
        throw new Error("--games/--seed overrides need an explicit single --cell (the battery seeds are registered)");
    }
    const gateOff = values.gate === "off";
    // The registered environment: LiveTwin preset + the placement gate for the TREATED seat (the control
    // seat is isolated by receiving no reveals, not by the env). Workers inherit this process env.
    process.env.LIVETWIN = "1";
    if (gateOff) {
        delete process.env.V07_PLACEMENT_REVEAL;
    } else {
        process.env.V07_PLACEMENT_REVEAL = "on";
    }
    const concurrency = Number(values.concurrency);
    const fightVersion = values["fight-version"];
    const total = cells.reduce((sum, cell) => sum + cell.games, 0);
    console.error(
        `reveal-placement A/B: ${cells.map((cell) => `${cell.name}(${cell.games}@${cell.seed})`).join(" ")} ` +
            `= ${total} games, fight ${fightVersion} both seats, gate ${gateOff ? "OFF (sanity)" : "on"}, ` +
            `concurrency ${concurrency}, LIVETWIN=1`,
    );
    const started = Date.now();
    let lastLogged = 0;
    const summary = await runMeasureRevealPlacement({
        cells,
        fightVersion,
        concurrency,
        gateOff,
        onProgress: (completed, totalJobs) => {
            if (completed - lastLogged >= Math.max(200, Math.floor(totalJobs / 25)) || completed === totalJobs) {
                lastLogged = completed;
                const rate = (completed / (Date.now() - started)) * 1000;
                console.error(`  ${completed}/${totalJobs} games (${rate.toFixed(1)} games/s)`);
            }
        },
    });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const output = values.output ?? join(process.cwd(), "sim-out", `reveal_placement_${stamp}.summary.json`);
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
            `  ${cell.cellName}: treated ${(cell.treatedWinRate * 100).toFixed(2)}% ` +
                `(${cell.deltaPp >= 0 ? "+" : ""}${cell.deltaPp.toFixed(2)}pp +/- ${cell.sePp.toFixed(2)} ` +
                `[x${Math.SQRT2.toFixed(2)} cluster ${cell.clusterSePp.toFixed(2)}], ${cell.decisive} decisive / ` +
                `${cell.games}), reveals ${(cell.revealRate * 100).toFixed(1)}% ` +
                `[splash ${(cell.splashThreatRate * 100).toFixed(1)}% fly ${(cell.flyerThreatRate * 100).toFixed(1)}% ` +
                `charge ${(cell.chargerThreatRate * 100).toFixed(1)}%]`,
        );
    }
    const bar = summary.shipBar;
    console.error(
        `SHIP BAR: ${bar.verdict} — pooled ${bar.pooledDeltaPp >= 0 ? "+" : ""}${bar.pooledDeltaPp.toFixed(2)}pp ` +
            `+/- ${bar.pooledSePp.toFixed(2)} (${bar.pooledDecisive} decisive), worst cell ${bar.worstCell} ` +
            `${bar.worstCellDeltaPp >= 0 ? "+" : ""}${bar.worstCellDeltaPp.toFixed(2)}pp — ${bar.reason}`,
    );
}

if (isMainThread && (import.meta as unknown as { main?: boolean }).main) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
