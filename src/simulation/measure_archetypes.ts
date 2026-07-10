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
import { isMainThread, parentPort, Worker } from "node:worker_threads";

import {
    ARCHETYPE_DEFINITIONS,
    ARCHETYPE_NAMES,
    buildArchetypeRoster,
    buildSharedArchetypeOffers,
    FROZEN_FIGHT_VERSION,
    playArchetypeGame,
    type ArchetypeName,
    type IArchetypeGameRecord,
    type IArchetypePayoffDependencies,
    type IPayoffCell,
} from "./archetype_payoff";
import { DEFAULT_ROSTER_COMPOSITION, makeRng, type IArmyUnitSpec } from "./army";
import { DEFAULT_OFFER_K } from "./draft";
import { LIVETWIN_PRESET, liveTwinSetup } from "./livetwin";

/**
 * B1 WEEK-ONE KILL TEST (v0.7 roadmap) — the archetype payoff matrix.
 *
 * Runs the FULL ordered 5x5 archetype matrix (25 cells; the 5 diagonal mirrors included — the roadmap judge's
 * melee-mirror control plus four free controls) under the LIVETWIN live-faithful config with the fight vector
 * frozen at shipped v0.6 on both sides, then powers the decisive melee_coevo cells with fresh-seed games and
 * applies the REGISTERED kill gate:
 *
 *   B1 DIES iff no archetype beats melee_coevo >= 55% (decisive) AND the full-information oracle
 *   counter-picker gains < +3pp over the melee_coevo mirror baseline (50%), at 5,000+ games.
 *
 * Game mechanics are inherited from archetype_payoff.ts (offer-conditioned scripted picks, shared per-game
 * offers, paired side-swap seeds, LiveTwin exp-budget stacks + SEE_NONE setup). This file adds: the ordered
 * matrix with independent per-cell seed streams, binomial SEs, transpose-consistency checks, the oracle
 * best-response computation, the kill-gate verdict, and per-archetype roster documentation.
 */

export const KILL_GATE = {
    /** Condition 1: some challenger's decisive win rate vs melee_coevo reaches this. */
    challengerWinRateThreshold: 0.55,
    /** Condition 2: the oracle counter-picker's gain over the melee mirror baseline reaches this (pp). */
    oracleGainThresholdPp: 3,
    /** The oracle estimate must rest on at least this many games (roadmap judge fix). */
    minOracleGames: 5000,
} as const;

export const MELEE_BASELINE: ArchetypeName = "melee_coevo";

/** Seed-stream phases: 1 = the 5x5 matrix, 2 = the oracle powering pass (always fresh seeds). */
export type SeedPhase = 1 | 2;

export interface IOrderedCellSpec extends IPayoffCell {
    index: number;
    row: ArchetypeName;
    col: ArchetypeName;
}

/** All 25 ordered cells. Row plays slot A, column plays slot B; side swaps stay paired within a cell. */
export function orderedCells(): IOrderedCellSpec[] {
    const cells: IOrderedCellSpec[] = [];
    for (const row of ARCHETYPE_NAMES) {
        for (const col of ARCHETYPE_NAMES) {
            cells.push({
                index: cells.length,
                id: `${row}__vs__${col}`,
                archetypeA: row,
                archetypeB: col,
                control: row === col,
                row,
                col,
            });
        }
    }
    return cells;
}

/**
 * Per-cell base seed. playArchetypeGame strides pair seeds by 0x9e3779b1 from the cell base, so cells (and
 * phases) get avalanche-mixed bases to keep every cell's seed stream independent — the transposed cell is a
 * genuine independent replicate, not the mirrored replay of its sibling.
 */
export function cellBaseSeed(baseSeed: number, phase: SeedPhase, cellIndex: number): number {
    let h = (baseSeed >>> 0) ^ 0x6d2b79f5;
    h = Math.imul(h ^ (phase + 0x9e37), 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (cellIndex + 1), 0xc2b2ae35) >>> 0;
    h ^= h >>> 15;
    h = Math.imul(h, 0x27d4eb2f) >>> 0;
    return (h ^ (h >>> 13)) >>> 0;
}

export interface IMatrixJob {
    /** Aggregate key — one tally per key. */
    key: string;
    cell: IPayoffCell;
    baseSeed: number;
    gamesPerCell: number;
    game: number;
}

export function buildCellJobs(key: string, cell: IPayoffCell, baseSeed: number, gamesPerCell: number): IMatrixJob[] {
    const jobs: IMatrixJob[] = [];
    for (let game = 0; game < gamesPerCell; game += 1) {
        jobs.push({ key, cell, baseSeed, gamesPerCell, game });
    }
    return jobs;
}

export interface ICellAggregate {
    key: string;
    cell: IPayoffCell;
    baseSeed: number;
    games: number;
    winsRow: number;
    winsCol: number;
    draws: number;
    greenWins: number;
    redWins: number;
    laps: number;
    armageddonDecided: number;
    hybridRoleFallbacks: number;
    endReasons: Record<string, number>;
}

export function emptyAggregate(key: string, cell: IPayoffCell, baseSeed: number): ICellAggregate {
    return {
        key,
        cell,
        baseSeed,
        games: 0,
        winsRow: 0,
        winsCol: 0,
        draws: 0,
        greenWins: 0,
        redWins: 0,
        laps: 0,
        armageddonDecided: 0,
        hybridRoleFallbacks: 0,
        endReasons: {},
    };
}

export function aggregateRecord(aggregate: ICellAggregate, record: IArchetypeGameRecord): void {
    aggregate.games += 1;
    if (record.winnerSlot === "a") aggregate.winsRow += 1;
    else if (record.winnerSlot === "b") aggregate.winsCol += 1;
    else aggregate.draws += 1;
    if (record.winnerSide === "green") aggregate.greenWins += 1;
    else if (record.winnerSide === "red") aggregate.redWins += 1;
    aggregate.laps += record.laps;
    aggregate.armageddonDecided += Number(record.decidedByArmageddon);
    aggregate.hybridRoleFallbacks += record.hybridRoleFallbacks;
    aggregate.endReasons[record.endReason] = (aggregate.endReasons[record.endReason] ?? 0) + 1;
}

export interface IRateEstimate {
    wins: number;
    decisive: number;
    rate: number;
    /** Binomial standard error, in percentage points. */
    sePp: number;
}

export function rateWithSe(wins: number, decisive: number): IRateEstimate {
    const rate = decisive > 0 ? wins / decisive : 0.5;
    const sePp = decisive > 0 ? 100 * Math.sqrt((rate * (1 - rate)) / decisive) : Number.POSITIVE_INFINITY;
    return { wins, decisive, rate, sePp };
}

/** Run a job list sequentially (tests inject a fake match runner through `dependencies`). */
export function runJobsSequential(
    jobs: readonly IMatrixJob[],
    aggregates: Map<string, ICellAggregate>,
    dependencies: IArchetypePayoffDependencies = {},
    onRecord?: (job: IMatrixJob, record: IArchetypeGameRecord, completed: number, total: number) => void,
): void {
    let completed = 0;
    for (const job of jobs) {
        const record = playArchetypeGame(
            job.cell,
            { gamesPerCell: job.gamesPerCell, baseSeed: job.baseSeed },
            job.game,
            dependencies,
        );
        const aggregate = aggregates.get(job.key);
        if (!aggregate) {
            throw new Error(`No aggregate registered for job key ${job.key}`);
        }
        aggregateRecord(aggregate, record);
        completed += 1;
        onRecord?.(job, record, completed, jobs.length);
    }
}

type WorkerReply =
    | { type: "ready" }
    | { type: "result"; key: string; record: IArchetypeGameRecord }
    | { type: "error"; error: string };

/** Run a job list on a worker pool; this same file is the worker entry (isMainThread === false branch). */
export async function runJobsConcurrent(
    jobs: readonly IMatrixJob[],
    aggregates: Map<string, ICellAggregate>,
    concurrency: number,
    onRecord?: (job: IMatrixJob, record: IArchetypeGameRecord, completed: number, total: number) => void,
): Promise<void> {
    const total = jobs.length;
    const poolSize = Math.max(1, Math.min(Math.floor(concurrency) || 1, total));
    if (poolSize <= 1) {
        runJobsSequential(jobs, aggregates, {}, onRecord);
        return;
    }
    await new Promise<void>((resolvePromise, rejectPromise) => {
        const workers: Worker[] = [];
        const inFlight = new Map<number, IMatrixJob>();
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
        const dispatchNext = (worker: Worker, workerId: number): void => {
            if (dispatched >= total) {
                worker.postMessage({ type: "stop" });
                return;
            }
            const job = jobs[dispatched];
            dispatched += 1;
            inFlight.set(workerId, job);
            worker.postMessage({ type: "game", job });
        };
        for (let workerId = 0; workerId < poolSize; workerId += 1) {
            let worker: Worker;
            try {
                worker = new Worker(new URL(import.meta.url));
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
                    dispatchNext(worker, workerId);
                    return;
                }
                const job = inFlight.get(workerId);
                if (!job || job.key !== message.key) {
                    fail(new Error(`Worker ${workerId} returned a record for an unexpected job key ${message.key}`));
                    return;
                }
                const aggregate = aggregates.get(message.key);
                if (!aggregate) {
                    fail(new Error(`No aggregate registered for job key ${message.key}`));
                    return;
                }
                aggregateRecord(aggregate, message.record);
                completed += 1;
                onRecord?.(job, message.record, completed, total);
                if (completed >= total) {
                    settled = true;
                    cleanup();
                    resolvePromise();
                    return;
                }
                dispatchNext(worker, workerId);
            });
            worker.on("error", fail);
        }
    });
}

export interface IKillGateInput {
    /** Best challenger's pooled decisive win rate vs melee_coevo (highest-information estimate). */
    bestChallenger: Exclude<ArchetypeName, typeof MELEE_BASELINE>;
    bestChallengerRate: number;
    bestChallengerDecisiveGames: number;
    /** Oracle best-response decisive win rate vs melee_coevo. */
    oracleWinRate: number;
    oracleDecisiveGames: number;
    /** Total games (incl. draws) behind the oracle estimate — the 5,000+ powering requirement. */
    oracleGames: number;
}

export interface IKillGateVerdict {
    thresholds: typeof KILL_GATE;
    input: IKillGateInput;
    /** Condition 1 (survival): some archetype beats melee_coevo at or above 55%. */
    challengerAtOrAboveThreshold: boolean;
    /** Condition 2 (survival): oracle counter-pick gain over the 50% mirror baseline, in pp. */
    oracleGainPp: number;
    oracleGainAtOrAboveThreshold: boolean;
    oracleAdequatelyPowered: boolean;
    verdict: "PASS" | "KILL";
    reason: string;
}

/** The registered gate: B1 dies only when BOTH survival conditions fail. */
export function evaluateKillGate(input: IKillGateInput): IKillGateVerdict {
    const challengerAtOrAboveThreshold = input.bestChallengerRate >= KILL_GATE.challengerWinRateThreshold;
    const oracleGainPp = (input.oracleWinRate - 0.5) * 100;
    const oracleGainAtOrAboveThreshold = oracleGainPp >= KILL_GATE.oracleGainThresholdPp;
    const oracleAdequatelyPowered = input.oracleGames >= KILL_GATE.minOracleGames;
    const verdict = challengerAtOrAboveThreshold || oracleGainAtOrAboveThreshold ? "PASS" : "KILL";
    const reason =
        verdict === "PASS"
            ? challengerAtOrAboveThreshold
                ? `${input.bestChallenger} beats melee_coevo at ${(input.bestChallengerRate * 100).toFixed(2)}% ` +
                  `(>= 55% threshold) over ${input.bestChallengerDecisiveGames} decisive games.`
                : `Oracle counter-pick gains +${oracleGainPp.toFixed(2)}pp (>= +3pp threshold) over ` +
                  `${input.oracleDecisiveGames} decisive games.`
            : `No archetype reaches 55% vs melee_coevo (best ${input.bestChallenger} ` +
              `${(input.bestChallengerRate * 100).toFixed(2)}%) and the oracle gains only ` +
              `${oracleGainPp >= 0 ? "+" : ""}${oracleGainPp.toFixed(2)}pp (< +3pp).`;
    return {
        thresholds: KILL_GATE,
        input,
        challengerAtOrAboveThreshold,
        oracleGainPp,
        oracleGainAtOrAboveThreshold,
        oracleAdequatelyPowered,
        verdict,
        reason,
    };
}

type Challenger = Exclude<ArchetypeName, typeof MELEE_BASELINE>;

export const CHALLENGERS: readonly Challenger[] = ARCHETYPE_NAMES.filter(
    (name): name is Challenger => name !== MELEE_BASELINE,
);

export const orderedCellKey = (row: ArchetypeName, col: ArchetypeName): string => `${row}__vs__${col}`;
export const oracleCellKey = (row: ArchetypeName): string => `oracle:${row}__vs__${MELEE_BASELINE}`;

/** Pool one archetype's decisive record vs melee_coevo across every aggregate that contains the matchup. */
export function poolVsMelee(
    aggregates: ReadonlyMap<string, ICellAggregate>,
    archetype: ArchetypeName,
): IRateEstimate & { games: number } {
    let wins = 0;
    let decisive = 0;
    let games = 0;
    const fold = (key: string, archetypeIsRow: boolean): void => {
        const aggregate = aggregates.get(key);
        if (!aggregate) return;
        wins += archetypeIsRow ? aggregate.winsRow : aggregate.winsCol;
        decisive += aggregate.winsRow + aggregate.winsCol;
        games += aggregate.games;
    };
    fold(orderedCellKey(archetype, MELEE_BASELINE), true);
    if (archetype !== MELEE_BASELINE) {
        fold(orderedCellKey(MELEE_BASELINE, archetype), false);
        fold(oracleCellKey(archetype), true);
    } else {
        fold(oracleCellKey(archetype), true);
    }
    return { ...rateWithSe(wins, decisive), games };
}

interface IRosterHistogram {
    /** signature -> count of game-sides fielding it. */
    counts: Map<string, number>;
    sides: number;
}

function foldRoster(histograms: Map<ArchetypeName, IRosterHistogram>, record: IArchetypeGameRecord): void {
    for (const [archetype, signature] of [
        [record.greenArchetype, record.greenRoster],
        [record.redArchetype, record.redRoster],
    ] as const) {
        const histogram = histograms.get(archetype) ?? { counts: new Map<string, number>(), sides: 0 };
        histogram.counts.set(signature, (histogram.counts.get(signature) ?? 0) + 1);
        histogram.sides += 1;
        histograms.set(archetype, histogram);
    }
}

export interface IArchetypeRosterReport {
    draftRule: string;
    setupRule: string;
    setup: { perk: number; augments: { kind: string; value: number }[] };
    /** Deterministic roster the archetype drafts from the offers seeded with `--seed` itself. */
    exampleRosterAtBaseSeed: IArmyUnitSpec[];
    /** Fraction of fielded game-sides that include each creature stack (from the matrix phase). */
    creatureFrequency: Record<string, number>;
    /** The most common full rosters (signature includes exp-budget stack amounts) with their shares. */
    topRosters: { roster: string; share: number }[];
    distinctRosters: number;
}

function rosterReport(
    name: ArchetypeName,
    histogram: IRosterHistogram | undefined,
    exampleSeed: number,
): IArchetypeRosterReport {
    const definition = ARCHETYPE_DEFINITIONS[name];
    const example = buildArchetypeRoster(name, buildSharedArchetypeOffers(makeRng(exampleSeed >>> 0)));
    const creatureCounts = new Map<string, number>();
    const sides = histogram?.sides ?? 0;
    for (const [signature, count] of histogram?.counts ?? []) {
        for (const stack of signature.split("|")) {
            const creature = stack.replace(/x\d+$/, "");
            creatureCounts.set(creature, (creatureCounts.get(creature) ?? 0) + count);
        }
    }
    const creatureFrequency = Object.fromEntries(
        [...creatureCounts.entries()]
            .map(([creature, count]): [string, number] => [creature, sides ? count / sides : 0])
            .sort((a, b) => b[1] - a[1]),
    );
    const topRosters = [...(histogram?.counts.entries() ?? [])]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([roster, count]) => ({ roster, share: sides ? count / sides : 0 }));
    return {
        draftRule: definition.draftRule,
        setupRule: definition.setupRule,
        setup: {
            perk: definition.setup.perk,
            augments: definition.setup.augments.map((augment) => ({ ...augment })),
        },
        exampleRosterAtBaseSeed: example.roster,
        creatureFrequency,
        topRosters,
        distinctRosters: histogram?.counts.size ?? 0,
    };
}

export interface IOrderedMatrixEntry {
    games: number;
    decisive: number;
    draws: number;
    winRateRow: number;
    sePp: number;
    avgLaps: number;
}

export interface IPooledPairEntry {
    a: ArchetypeName;
    b: ArchetypeName;
    games: number;
    decisive: number;
    winsA: number;
    winRateA: number;
    sePp: number;
    /** |ordered(a,b) + ordered(b,a) - 1| in pp — independent-replicate consistency. */
    transposeGapPp: number;
}

export interface IMirrorControl {
    archetype: ArchetypeName;
    games: number;
    decisiveRate: number;
    /** Exactly 0.5 by paired-swap symmetry — a harness invariant, not a measurement. */
    slotAWinRate: number;
    greenSeatWinRate: number;
    avgLaps: number;
}

export interface IOracleReport {
    baseline: {
        archetype: typeof MELEE_BASELINE;
        winRate: 0.5;
        note: string;
    };
    poweredCells: {
        key: string;
        archetype: ArchetypeName;
        freshGames: number;
        freshEstimate: IRateEstimate;
        pooled: IRateEstimate & { games: number };
    }[];
    vsMeleePooled: Record<Challenger, IRateEstimate & { games: number }>;
    bestResponse: { archetype: ArchetypeName; pooled: IRateEstimate & { games: number } };
    /** Archetypes within 1 combined SE of the best response, equal-weighted (robustness view). */
    mixture: { weights: Partial<Record<ArchetypeName, number>>; winRate: number; sePp: number; decisive: number };
    gainPp: number;
    mixtureGainPp: number;
}

export interface IMeasureArchetypesSummary {
    schemaVersion: 1;
    kind: "b1_archetype_kill_test";
    fightVersion: typeof FROZEN_FIGHT_VERSION;
    startedAt: string;
    wallSeconds: number;
    gamesPerSecond: number;
    config: {
        liveTwinEnv: string;
        amountMode: typeof LIVETWIN_PRESET.amountMode;
        perk: number;
        baseAugments: { kind: string; value: number }[];
        grid: "NORMAL";
        pairedSideSwap: true;
        commonOffersAcrossArchetypes: true;
        offerK: number;
        rosterComposition: typeof DEFAULT_ROSTER_COMPOSITION;
        gamesPerCell: number;
        oracleGamesPerCell: number;
        oracleTopK: number;
        baseSeed: number;
        concurrency: number;
        totalGames: number;
    };
    archetypes: Record<ArchetypeName, IArchetypeRosterReport>;
    orderedMatrix: Record<ArchetypeName, Record<ArchetypeName, IOrderedMatrixEntry>>;
    pooledPairs: IPooledPairEntry[];
    maxTransposeGapPp: number;
    mirrors: IMirrorControl[];
    oracle: IOracleReport;
    killGate: IKillGateVerdict;
    cells: ICellAggregate[];
}

export interface IMeasureArchetypesOptions {
    gamesPerCell: number;
    oracleGamesPerCell: number;
    oracleTopK: number;
    baseSeed: number;
    concurrency: number;
    onProgress?: (phase: string, completed: number, total: number) => void;
}

function assertEvenPositive(value: number, flag: string): void {
    if (!Number.isSafeInteger(value) || value < 2 || value % 2 !== 0) {
        throw new Error(`${flag} must be a positive even integer >= 2; got ${value}`);
    }
}

/** Phase 1 (5x5 matrix) + phase 2 (oracle powering) + summary. The long-running entry point. */
export async function runMeasureArchetypes(options: IMeasureArchetypesOptions): Promise<IMeasureArchetypesSummary> {
    assertEvenPositive(options.gamesPerCell, "gamesPerCell");
    assertEvenPositive(options.oracleGamesPerCell, "oracleGamesPerCell");
    if (!Number.isSafeInteger(options.baseSeed)) {
        throw new Error(`baseSeed must be a safe integer; got ${options.baseSeed}`);
    }
    if (
        !Number.isSafeInteger(options.oracleTopK) ||
        options.oracleTopK < 1 ||
        options.oracleTopK > CHALLENGERS.length
    ) {
        throw new Error(`oracleTopK must be in [1, ${CHALLENGERS.length}]; got ${options.oracleTopK}`);
    }
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    const aggregates = new Map<string, ICellAggregate>();
    const histograms = new Map<ArchetypeName, IRosterHistogram>();

    // Phase 1 — the full ordered 5x5 matrix.
    const matrixJobs: IMatrixJob[] = [];
    for (const cell of orderedCells()) {
        const seed = cellBaseSeed(options.baseSeed, 1, cell.index);
        const key = orderedCellKey(cell.row, cell.col);
        aggregates.set(key, emptyAggregate(key, cell, seed));
        matrixJobs.push(...buildCellJobs(key, cell, seed, options.gamesPerCell));
    }
    await runJobsConcurrent(matrixJobs, aggregates, options.concurrency, (_job, record, completed, total) => {
        foldRoster(histograms, record);
        options.onProgress?.("matrix", completed, total);
    });

    // Phase 2 — fresh-seed powering of the decisive melee_coevo cells: top-K challengers + the melee mirror.
    const vsMeleePhase1 = CHALLENGERS.map((challenger) => ({
        challenger,
        pooled: poolVsMelee(aggregates, challenger),
    })).sort((a, b) => b.pooled.rate - a.pooled.rate);
    const poweredArchetypes: ArchetypeName[] = [
        ...vsMeleePhase1.slice(0, options.oracleTopK).map((entry) => entry.challenger),
        MELEE_BASELINE,
    ];
    const oracleJobs: IMatrixJob[] = [];
    poweredArchetypes.forEach((archetype, index) => {
        const key = oracleCellKey(archetype);
        const cell: IPayoffCell = {
            id: key,
            archetypeA: archetype,
            archetypeB: MELEE_BASELINE,
            control: archetype === MELEE_BASELINE,
        };
        const seed = cellBaseSeed(options.baseSeed, 2, index);
        aggregates.set(key, emptyAggregate(key, cell, seed));
        oracleJobs.push(...buildCellJobs(key, cell, seed, options.oracleGamesPerCell));
    });
    await runJobsConcurrent(oracleJobs, aggregates, options.concurrency, (_job, record, completed, total) => {
        foldRoster(histograms, record);
        options.onProgress?.("oracle", completed, total);
    });

    const wallSeconds = (Date.now() - startMs) / 1000;
    const totalGames = matrixJobs.length + oracleJobs.length;

    // Ordered matrix + pooled unordered pairs + mirrors.
    const orderedMatrix = Object.fromEntries(
        ARCHETYPE_NAMES.map((row) => [
            row,
            Object.fromEntries(
                ARCHETYPE_NAMES.map((col) => {
                    const aggregate = aggregates.get(orderedCellKey(row, col))!;
                    const decisive = aggregate.winsRow + aggregate.winsCol;
                    const estimate = rateWithSe(aggregate.winsRow, decisive);
                    const entry: IOrderedMatrixEntry = {
                        games: aggregate.games,
                        decisive,
                        draws: aggregate.draws,
                        winRateRow: estimate.rate,
                        sePp: estimate.sePp,
                        avgLaps: aggregate.games ? aggregate.laps / aggregate.games : 0,
                    };
                    return [col, entry];
                }),
            ),
        ]),
    ) as IMeasureArchetypesSummary["orderedMatrix"];
    const pooledPairs: IPooledPairEntry[] = [];
    for (let i = 0; i < ARCHETYPE_NAMES.length; i += 1) {
        for (let j = i + 1; j < ARCHETYPE_NAMES.length; j += 1) {
            const a = ARCHETYPE_NAMES[i];
            const b = ARCHETYPE_NAMES[j];
            const forward = aggregates.get(orderedCellKey(a, b))!;
            const backward = aggregates.get(orderedCellKey(b, a))!;
            const winsA = forward.winsRow + backward.winsCol;
            const decisive = forward.winsRow + forward.winsCol + backward.winsRow + backward.winsCol;
            const estimate = rateWithSe(winsA, decisive);
            pooledPairs.push({
                a,
                b,
                games: forward.games + backward.games,
                decisive,
                winsA,
                winRateA: estimate.rate,
                sePp: estimate.sePp,
                transposeGapPp: Math.abs(orderedMatrix[a][b].winRateRow + orderedMatrix[b][a].winRateRow - 1) * 100,
            });
        }
    }
    const maxTransposeGapPp = pooledPairs.reduce((max, pair) => Math.max(max, pair.transposeGapPp), 0);
    const mirrors: IMirrorControl[] = ARCHETYPE_NAMES.map((name) => {
        const aggregate = aggregates.get(orderedCellKey(name, name))!;
        const decisive = aggregate.winsRow + aggregate.winsCol;
        const seatDecisive = aggregate.greenWins + aggregate.redWins;
        return {
            archetype: name,
            games: aggregate.games,
            decisiveRate: aggregate.games ? decisive / aggregate.games : 0,
            slotAWinRate: decisive ? aggregate.winsRow / decisive : 0.5,
            greenSeatWinRate: seatDecisive ? aggregate.greenWins / seatDecisive : 0.5,
            avgLaps: aggregate.games ? aggregate.laps / aggregate.games : 0,
        };
    });

    // Oracle best response vs melee_coevo, on the pooled (matrix + powering) evidence.
    const vsMeleePooled = Object.fromEntries(
        CHALLENGERS.map((challenger) => [challenger, poolVsMelee(aggregates, challenger)]),
    ) as IOracleReport["vsMeleePooled"];
    const rankedPooled = CHALLENGERS.map((challenger) => ({
        archetype: challenger as ArchetypeName,
        pooled: vsMeleePooled[challenger],
    })).sort((a, b) => b.pooled.rate - a.pooled.rate);
    // Playing the mirror is always available to the oracle: it never has to accept a < 50% matchup. The
    // pooled mirror rate is exactly 0.5 by paired-swap symmetry, with real decisive counts behind it.
    const best =
        rankedPooled[0].pooled.rate >= 0.5
            ? rankedPooled[0]
            : { archetype: MELEE_BASELINE as ArchetypeName, pooled: poolVsMelee(aggregates, MELEE_BASELINE) };
    const tied = rankedPooled.filter(
        (entry) =>
            entry.pooled.rate >= 0.5 &&
            (entry.pooled.rate >= best.pooled.rate ||
                (best.pooled.rate - entry.pooled.rate) * 100 <= Math.hypot(entry.pooled.sePp, best.pooled.sePp)),
    );
    const mixtureSet = tied.length > 0 ? tied : [best];
    const mixtureWins = mixtureSet.reduce((sum, entry) => sum + entry.pooled.wins, 0);
    const mixtureDecisive = mixtureSet.reduce((sum, entry) => sum + entry.pooled.decisive, 0);
    const mixtureEstimate = rateWithSe(mixtureWins, mixtureDecisive);
    const oracle: IOracleReport = {
        baseline: {
            archetype: MELEE_BASELINE,
            winRate: 0.5,
            note:
                "Melee_coevo mirror decisive win rate is exactly 50% by paired side-swap symmetry; the measured " +
                "mirror control cells validate the harness (see mirrors[]).",
        },
        poweredCells: poweredArchetypes.map((archetype) => {
            const aggregate = aggregates.get(oracleCellKey(archetype))!;
            const decisive = aggregate.winsRow + aggregate.winsCol;
            return {
                key: aggregate.key,
                archetype,
                freshGames: aggregate.games,
                freshEstimate: rateWithSe(aggregate.winsRow, decisive),
                pooled: poolVsMelee(aggregates, archetype),
            };
        }),
        vsMeleePooled,
        bestResponse: best,
        mixture: {
            weights: Object.fromEntries(mixtureSet.map((entry) => [entry.archetype, 1 / mixtureSet.length])),
            winRate: mixtureEstimate.rate,
            sePp: mixtureEstimate.sePp,
            decisive: mixtureDecisive,
        },
        gainPp: (best.pooled.rate - 0.5) * 100,
        mixtureGainPp: (mixtureEstimate.rate - 0.5) * 100,
    };

    const bestChallenger = rankedPooled[0];
    const killGate = evaluateKillGate({
        bestChallenger: bestChallenger.archetype as Challenger,
        bestChallengerRate: bestChallenger.pooled.rate,
        bestChallengerDecisiveGames: bestChallenger.pooled.decisive,
        oracleWinRate: best.pooled.rate,
        oracleDecisiveGames: best.pooled.decisive,
        oracleGames: best.pooled.games,
    });

    const baseSetup = liveTwinSetup();
    return {
        schemaVersion: 1,
        kind: "b1_archetype_kill_test",
        fightVersion: FROZEN_FIGHT_VERSION,
        startedAt,
        wallSeconds,
        gamesPerSecond: wallSeconds > 0 ? totalGames / wallSeconds : 0,
        config: {
            liveTwinEnv: process.env.LIVETWIN ?? "",
            amountMode: LIVETWIN_PRESET.amountMode,
            perk: baseSetup.perk,
            baseAugments: baseSetup.augments,
            grid: "NORMAL",
            pairedSideSwap: true,
            commonOffersAcrossArchetypes: true,
            offerK: DEFAULT_OFFER_K,
            rosterComposition: DEFAULT_ROSTER_COMPOSITION,
            gamesPerCell: options.gamesPerCell,
            oracleGamesPerCell: options.oracleGamesPerCell,
            oracleTopK: options.oracleTopK,
            baseSeed: options.baseSeed,
            concurrency: options.concurrency,
            totalGames,
        },
        archetypes: Object.fromEntries(
            ARCHETYPE_NAMES.map((name) => [name, rosterReport(name, histograms.get(name), options.baseSeed)]),
        ) as IMeasureArchetypesSummary["archetypes"],
        orderedMatrix,
        pooledPairs,
        maxTransposeGapPp,
        mirrors,
        oracle,
        killGate,
        cells: [...aggregates.values()],
    };
}

// ---------------------------------------------------------------------------------------------------------
// Worker entry — this file spawns itself; workers only ever see the message loop below.
// ---------------------------------------------------------------------------------------------------------
if (!isMainThread && parentPort) {
    const port = parentPort;
    port.on("message", (message: { type: "game"; job: IMatrixJob } | { type: "stop" }) => {
        if (message.type === "stop") {
            port.close();
            return;
        }
        try {
            const { job } = message;
            const record = playArchetypeGame(
                job.cell,
                { gamesPerCell: job.gamesPerCell, baseSeed: job.baseSeed },
                job.game,
            );
            port.postMessage({ type: "result", key: job.key, record });
        } catch (error) {
            port.postMessage({
                type: "error",
                error: error instanceof Error ? (error.stack ?? error.message) : String(error),
            });
        }
    });
    port.postMessage({ type: "ready" });
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
        "usage: LIVETWIN=1 bun src/simulation/measure_archetypes.ts [--games 2000] [--oracle-games 6000] " +
            "[--top-k 2] [--seed 1] [--concurrency 12] [--output sim-out/measure_archetypes.summary.json]",
    );
    console.log("  --games         games per ordered 5x5 cell; must be even (default 2000)");
    console.log("  --oracle-games  fresh powering games per decisive cell; must be even (default 6000)");
    console.log("  --top-k         challengers vs melee_coevo to power, best-first (default 2)");
    console.log("  --seed          base seed; every cell derives an independent stream from it (default 1)");
    console.log("  --concurrency   worker threads (default min(12, available cores))");
    console.log("  --output        summary JSON path; use '-' for stdout");
}

export async function main(): Promise<void> {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            games: { type: "string", default: "2000" },
            "oracle-games": { type: "string", default: "6000" },
            "top-k": { type: "string", default: "2" },
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
    // The registered kill test runs on the committed live-faithful preset — force it on for this process
    // and every worker it spawns (run_tournament --livetwin does the same).
    process.env.LIVETWIN = "1";
    const gamesPerCell = positiveInteger(values.games, "--games");
    const oracleGamesPerCell = positiveInteger(values["oracle-games"], "--oracle-games");
    const oracleTopK = positiveInteger(values["top-k"], "--top-k");
    const baseSeed = Number(values.seed);
    if (!Number.isSafeInteger(baseSeed)) {
        throw new Error(`--seed must be a safe integer; got ${values.seed}`);
    }
    const concurrency = positiveInteger(values.concurrency, "--concurrency");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const output = values.output ?? join(process.cwd(), "sim-out", `measure_archetypes_${stamp}.summary.json`);
    const matrixGames = orderedCells().length * gamesPerCell;
    const oracleGames = (oracleTopK + 1) * oracleGamesPerCell;
    console.error(
        `B1 kill test: ${orderedCells().length} ordered cells x ${gamesPerCell} = ${matrixGames} games, ` +
            `then ${oracleTopK}+mirror powered cells x ${oracleGamesPerCell} = ${oracleGames} games ` +
            `(seed ${baseSeed}, concurrency ${concurrency}, LIVETWIN=1, frozen ${FROZEN_FIGHT_VERSION} both sides)`,
    );
    const started = Date.now();
    let lastLogged = 0;
    const summary = await runMeasureArchetypes({
        gamesPerCell,
        oracleGamesPerCell,
        oracleTopK,
        baseSeed,
        concurrency,
        onProgress: (phase, completed, total) => {
            if (completed - lastLogged >= Math.max(500, Math.floor(total / 25)) || completed === total) {
                lastLogged = completed === total ? 0 : completed;
                const rate = ((completed + (phase === "oracle" ? matrixGames : 0)) / (Date.now() - started)) * 1000;
                console.error(`  [${phase}] ${completed}/${total} games (${rate.toFixed(1)} games/s)`);
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
    const gate = summary.killGate;
    console.error(
        `Best challenger vs melee_coevo: ${gate.input.bestChallenger} ` +
            `${(gate.input.bestChallengerRate * 100).toFixed(2)}% +/- ` +
            `${summary.oracle.vsMeleePooled[gate.input.bestChallenger].sePp.toFixed(2)}pp ` +
            `(${gate.input.bestChallengerDecisiveGames} decisive)`,
    );
    console.error(
        `Oracle best response: ${summary.oracle.bestResponse.archetype} -> gain ` +
            `${gate.oracleGainPp >= 0 ? "+" : ""}${gate.oracleGainPp.toFixed(2)}pp over the 50% mirror baseline ` +
            `(${gate.input.oracleDecisiveGames} decisive games${gate.oracleAdequatelyPowered ? "" : " — UNDERPOWERED"})`,
    );
    console.error(`KILL GATE VERDICT: ${gate.verdict} — ${gate.reason}`);
    console.error(
        `Controls: melee mirror decisive ${(summary.mirrors[0].decisiveRate * 100).toFixed(1)}%, ` +
            `slot-A ${(summary.mirrors[0].slotAWinRate * 100).toFixed(1)}% (must be 50.0), ` +
            `max transpose gap ${summary.maxTransposeGapPp.toFixed(2)}pp; ` +
            `${summary.gamesPerSecond.toFixed(1)} games/s over ${summary.wallSeconds.toFixed(0)}s`,
    );
}

if (isMainThread && (import.meta as unknown as { main?: boolean }).main) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
