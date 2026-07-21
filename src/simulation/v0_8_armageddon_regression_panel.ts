/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";

import {
    buildV08TestCandidateEnvironment,
    V08_TEST_CANDIDATE_OPERATIONAL_ENVIRONMENT_SHA256,
    V08_TEST_CANDIDATE_OPERATIONAL_POLICY_ID,
    V08_TEST_CANDIDATE_SOURCE_ALIAS_OPERATIONAL_ENVIRONMENT_SHA256,
    V08_TEST_CANDIDATE_SOURCE_AUDIT_PATH,
} from "../ai/versions/v0_8_candidate_profile";
import type { IRecordedAction, Side } from "./battle_engine";
import { makeRng } from "./army";
import { fingerprintV08AlignedV1 } from "./optimizer/v0_8_aligned_96h_v1_protocol";
import { prepareV08CandidateOutputDirectory, verifyV08CandidateOperationalIdentity } from "./run_v0_8_candidate";
import { playGame, type IGameRecord, type ITournamentOptions } from "./tournament";

export const V08_ARMAGEDDON_REGRESSION_SCHEMA = "hoc.v0_8_armageddon_regression_panel.v1" as const;
export const V08_ARMAGEDDON_REGRESSION_BASE_SEED = 8_262_801 as const;
export const V08_ARMAGEDDON_REGRESSION_BASELINE_GAMES = 6_000 as const;
export const V08_ARMAGEDDON_REGRESSION_STABLE = "v0.8" as const;
export const V08_ARMAGEDDON_REGRESSION_EXPERIMENTAL = "v0.8s" as const;
export const V08_ARMAGEDDON_REGRESSION_OPPONENT = "v0.7" as const;
export const V08_ARMAGEDDON_REGRESSION_MAPS = Object.freeze([
    { name: "normal" as const, type: 1 as const },
    { name: "lava" as const, type: 3 as const },
    { name: "block" as const, type: 4 as const },
]);

/** Every game which reached Armageddon in the bounded operational-r1 6000-game baseline. */
export const V08_ARMAGEDDON_BASELINE_INDICES = Object.freeze([
    136, 277, 293, 359, 374, 381, 464, 468, 586, 589, 906, 1018, 1024, 1125, 1176, 1257, 1516, 1530, 1556, 2113, 2160,
    2229, 2235, 2376, 2530, 2578, 2593, 2611, 2793, 2816, 2943, 2980, 3053, 3183, 3577, 3584, 3637, 3746, 3906, 3915,
    4099, 4113, 4358, 4486, 4535, 4565, 4569, 4573, 4685, 4686, 4705, 4820, 5296, 5463, 5494, 5499, 5574, 5660, 5672,
    5678, 5714, 5763, 5774, 5847, 5875, 5878,
]);

/** Cases still reaching Armageddon after the first operational-r1 policy repair replay. */
export const V08_ARMAGEDDON_RESIDUAL_INDICES = Object.freeze([
    468, 586, 906, 1176, 2593, 2793, 3906, 4113, 4573, 4705, 5463, 5494, 5672, 5763,
]);

const BASELINE_INDEX_SET: ReadonlySet<number> = new Set(V08_ARMAGEDDON_BASELINE_INDICES);
const RESIDUAL_INDEX_SET: ReadonlySet<number> = new Set(V08_ARMAGEDDON_RESIDUAL_INDICES);
const MAP_NAME_BY_TYPE = new Map(V08_ARMAGEDDON_REGRESSION_MAPS.map((map) => [map.type, map.name]));
const MAP_TYPES = V08_ARMAGEDDON_REGRESSION_MAPS.map((map) => map.type);
const PANEL_PATH = join(import.meta.dir, "v0_8_armageddon_regression_panel.ts");
const COMPARISON_RECORDS_NAME = "v0.8-armageddon-regression.comparison.jsonl";
const COMPARISON_SUMMARY_NAME = "v0.8-armageddon-regression.summary.json";
const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");

/** Behavior-bearing sources captured for every mutable experimental replay (not an approval/promotion pin). */
export const V08_ARMAGEDDON_REGRESSION_SOURCE_FILES = Object.freeze([
    "src/ai/candidates.ts",
    "src/ai/index.ts",
    "src/ai/versions/v0_1.ts",
    "src/ai/versions/v0_2.ts",
    "src/ai/versions/v0_3.ts",
    "src/ai/versions/v0_4.ts",
    "src/ai/versions/v0_5.ts",
    "src/ai/versions/v0_6.ts",
    "src/ai/versions/v0_7.ts",
    "src/ai/versions/v0_8.ts",
    "src/ai/versions/v0_8_candidate_profile.ts",
    "src/ai/versions/v0_8_dominant_finish.ts",
    "src/ai/versions/v0_8s.ts",
    "src/ai/versions/v0_8s_finish.ts",
    "src/simulation/battle_engine.ts",
    "src/simulation/lookahead.ts",
    "src/simulation/search_driver.ts",
    "src/simulation/tournament.ts",
]);

const INHERITED_OS_ENVIRONMENT_KEYS = [
    "PATH",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
] as const;

export type V08ArmageddonRegressionVariant = "stable" | "experimental";
export type V08ArmageddonRegressionCandidate =
    typeof V08_ARMAGEDDON_REGRESSION_STABLE | typeof V08_ARMAGEDDON_REGRESSION_EXPERIMENTAL;

const candidateForVariant = (variant: V08ArmageddonRegressionVariant): V08ArmageddonRegressionCandidate =>
    variant === "stable" ? V08_ARMAGEDDON_REGRESSION_STABLE : V08_ARMAGEDDON_REGRESSION_EXPERIMENTAL;
const variantArtifactPrefix = (variant: V08ArmageddonRegressionVariant): string =>
    variant === "stable" ? "stable-v0.8" : "experimental-v0.8s";
const searchAuditName = (variant: V08ArmageddonRegressionVariant): string =>
    `${variantArtifactPrefix(variant)}-armageddon-regression.search-audit.jsonl`;
const recordsName = (variant: V08ArmageddonRegressionVariant): string =>
    `${variantArtifactPrefix(variant)}-armageddon-regression.records.jsonl`;
const variantSummaryName = (variant: V08ArmageddonRegressionVariant): string =>
    `${variantArtifactPrefix(variant)}-armageddon-regression.summary.json`;

export interface IV08ArmageddonRegressionPlan {
    game: number;
    pair: number;
    seed: number;
    mapName: "normal" | "lava" | "block";
    mapType: 1 | 3 | 4;
    candidateSide: Side;
    greenEntrant: "a" | "b";
    greenVersion: V08ArmageddonRegressionCandidate | typeof V08_ARMAGEDDON_REGRESSION_OPPONENT;
    redVersion: V08ArmageddonRegressionCandidate | typeof V08_ARMAGEDDON_REGRESSION_OPPONENT;
    residual: boolean;
}

export interface IV08ArmageddonRegressionRecordEvidence {
    game: number;
    greenEntrant: "a" | "b";
    greenVersion: string;
    redVersion: string;
    result: { seed: number; gridType: number };
}

export interface IV08ArmageddonActionSummary {
    recorded: number;
    completed: number;
    rejected: number;
    totalDamage: number;
    stacksKilled: number;
    attemptedByType: Readonly<Record<string, number>>;
    completedByType: Readonly<Record<string, number>>;
    fromLap7AttemptedByType: Readonly<Record<string, number>>;
    fromLap7CompletedByType: Readonly<Record<string, number>>;
    fromLap9AttemptedByType: Readonly<Record<string, number>>;
    fromLap9CompletedByType: Readonly<Record<string, number>>;
    policyCounts: {
        attempted: IV08ArmageddonNamedPolicyCounts;
        completed: IV08ArmageddonNamedPolicyCounts;
    };
}

export interface IV08ArmageddonNamedPolicyCounts {
    mountain: number;
    end: number;
    defend: number;
    wait: number;
}

export interface IV08ArmageddonPanelRecord {
    schema: typeof V08_ARMAGEDDON_REGRESSION_SCHEMA;
    game: number;
    baselineOrdinal: number;
    residual: boolean;
    pair: number;
    seed: number;
    map: { name: "normal" | "lava" | "block"; type: 1 | 3 | 4 };
    candidateSide: Side;
    variant: V08ArmageddonRegressionVariant;
    versions: { candidate: V08ArmageddonRegressionCandidate; opponent: typeof V08_ARMAGEDDON_REGRESSION_OPPONENT };
    winner: "candidate" | "opponent" | "draw";
    laps: number;
    endReason: string;
    armageddon: {
        reached: boolean;
        waves: number;
        decided: boolean;
        unitsKilled: number;
        unitsKilledByNarrowing: number;
    };
    rejections: {
        candidate: number;
        opponent: number;
        details: IGameRecord["result"]["rejectedDetails"];
    };
    actions: { candidate: IV08ArmageddonActionSummary; opponent: IV08ArmageddonActionSummary };
}

export interface IV08ArmageddonRegressionEnvironment {
    environment: NodeJS.ProcessEnv;
    candidateEnvironment: Readonly<Record<string, string>>;
    frozenEnvironmentSha256: string;
    materializedEnvironmentSha256: string;
}

export interface IV08ArmageddonRegressionSourceIdentity {
    sourceFiles: Readonly<Record<string, string>>;
    workingTreeSourceBundleSha256: string;
    sealedR1Pin: { matched: boolean; mismatch: string | null };
}

export interface IV08ArmageddonCohortSummary {
    games: number;
    armageddonReached: number;
    armageddonReachedRate: number;
    armageddonDecided: number;
    candidateWins: number;
    opponentWins: number;
    draws: number;
    rejectedCandidate: number;
    rejectedOpponent: number;
    remainingArmageddonIndices: number[];
    resolvedIndices: number[];
}

function requirePanelGameIndex(game: number): number {
    if (!Number.isSafeInteger(game) || game < 0 || game >= V08_ARMAGEDDON_REGRESSION_BASELINE_GAMES) {
        throw new Error(
            `Armageddon regression game index ${game} is outside [0, ${V08_ARMAGEDDON_REGRESSION_BASELINE_GAMES})`,
        );
    }
    return game;
}

/** Reproduce tournament.playGame's exact pair seed, map draw, and physical candidate seat. */
export function planV08ArmageddonRegressionGame(
    game: number,
    candidate: V08ArmageddonRegressionCandidate = V08_ARMAGEDDON_REGRESSION_EXPERIMENTAL,
): IV08ArmageddonRegressionPlan {
    requirePanelGameIndex(game);
    const pair = Math.floor(game / 2);
    const seed = (V08_ARMAGEDDON_REGRESSION_BASE_SEED + pair * 0x9e3779b1) >>> 0;
    const mapType = MAP_TYPES[
        Math.floor(makeRng((seed ^ 0xc2b2ae35) >>> 0)() * MAP_TYPES.length)
    ] as IV08ArmageddonRegressionPlan["mapType"];
    const candidateIsGreen = game % 2 === 0;
    return {
        game,
        pair,
        seed,
        mapName: MAP_NAME_BY_TYPE.get(mapType)!,
        mapType,
        candidateSide: candidateIsGreen ? "green" : "red",
        greenEntrant: candidateIsGreen ? "a" : "b",
        greenVersion: candidateIsGreen ? candidate : V08_ARMAGEDDON_REGRESSION_OPPONENT,
        redVersion: candidateIsGreen ? V08_ARMAGEDDON_REGRESSION_OPPONENT : candidate,
        residual: RESIDUAL_INDEX_SET.has(game),
    };
}

export function selectedV08ArmageddonRegressionIndices(residualOnly = false): readonly number[] {
    return residualOnly ? V08_ARMAGEDDON_RESIDUAL_INDICES : V08_ARMAGEDDON_BASELINE_INDICES;
}

/** Admit a replay only when index, pair seed, map draw, entrant, and physical versions all match the baseline. */
export function validateV08ArmageddonRegressionRecord(
    record: IV08ArmageddonRegressionRecordEvidence,
    candidate: V08ArmageddonRegressionCandidate = V08_ARMAGEDDON_REGRESSION_EXPERIMENTAL,
): IV08ArmageddonRegressionPlan {
    if (!BASELINE_INDEX_SET.has(record.game)) {
        throw new Error(`Armageddon regression record has unselected game index ${record.game}`);
    }
    const plan = planV08ArmageddonRegressionGame(record.game, candidate);
    if (
        record.greenEntrant !== plan.greenEntrant ||
        record.greenVersion !== plan.greenVersion ||
        record.redVersion !== plan.redVersion
    ) {
        throw new Error(`Armageddon regression game ${record.game} candidate seat/version binding drifted`);
    }
    if (record.result.seed !== plan.seed) {
        throw new Error(`Armageddon regression game ${record.game} seed drifted`);
    }
    if (record.result.gridType !== plan.mapType) {
        throw new Error(`Armageddon regression game ${record.game} map drifted`);
    }
    return plan;
}

const sortedCounts = (counts: Readonly<Record<string, number>>): Readonly<Record<string, number>> =>
    Object.freeze(Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))));

function countActionTypes(actions: readonly IRecordedAction[]): Readonly<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const action of actions) counts[action.actionType] = (counts[action.actionType] ?? 0) + 1;
    return sortedCounts(counts);
}

const namedPolicyCounts = (byType: Readonly<Record<string, number>>): IV08ArmageddonNamedPolicyCounts => ({
    mountain: byType.obstacle_attack ?? 0,
    end: byType.end_turn ?? 0,
    defend: byType.defend_turn ?? 0,
    wait: byType.wait_turn ?? 0,
});

export function summarizeV08ArmageddonActions(
    actions: readonly IRecordedAction[],
    side: Side,
): IV08ArmageddonActionSummary {
    const owned = actions.filter((action) => action.side === side);
    const completed = owned.filter((action) => action.completed);
    const attemptedByType = countActionTypes(owned);
    const completedByType = countActionTypes(completed);
    return {
        recorded: owned.length,
        completed: completed.length,
        rejected: owned.length - completed.length,
        totalDamage: completed.reduce((total, action) => total + (action.damage ?? 0), 0),
        stacksKilled: completed.reduce((total, action) => total + (action.unitIdsDied?.length ?? 0), 0),
        attemptedByType,
        completedByType,
        fromLap7AttemptedByType: countActionTypes(owned.filter((action) => action.lap >= 7)),
        fromLap7CompletedByType: countActionTypes(completed.filter((action) => action.lap >= 7)),
        fromLap9AttemptedByType: countActionTypes(owned.filter((action) => action.lap >= 9)),
        fromLap9CompletedByType: countActionTypes(completed.filter((action) => action.lap >= 9)),
        policyCounts: {
            attempted: namedPolicyCounts(attemptedByType),
            completed: namedPolicyCounts(completedByType),
        },
    };
}

function ownerForWinner(
    winner: IGameRecord["result"]["winner"],
    candidateSide: Side,
): "candidate" | "opponent" | "draw" {
    if (winner === "draw") return "draw";
    return winner === candidateSide ? "candidate" : "opponent";
}

export function summarizeV08ArmageddonRegressionRecord(
    record: IGameRecord,
    variant: V08ArmageddonRegressionVariant,
): IV08ArmageddonPanelRecord {
    const candidate = candidateForVariant(variant);
    const plan = validateV08ArmageddonRegressionRecord(record, candidate);
    const opponentSide: Side = plan.candidateSide === "green" ? "red" : "green";
    const candidateRejected = plan.candidateSide === "green" ? record.result.rejectedGreen : record.result.rejectedRed;
    const opponentRejected = plan.candidateSide === "green" ? record.result.rejectedRed : record.result.rejectedGreen;
    return {
        schema: V08_ARMAGEDDON_REGRESSION_SCHEMA,
        game: record.game,
        baselineOrdinal: V08_ARMAGEDDON_BASELINE_INDICES.indexOf(record.game),
        residual: plan.residual,
        pair: plan.pair,
        seed: plan.seed,
        map: { name: plan.mapName, type: plan.mapType },
        candidateSide: plan.candidateSide,
        variant,
        versions: { candidate, opponent: V08_ARMAGEDDON_REGRESSION_OPPONENT },
        winner: ownerForWinner(record.result.winner, plan.candidateSide),
        laps: record.result.laps,
        endReason: record.result.endReason,
        armageddon: {
            reached: record.result.attrition.reachedArmageddon,
            waves: record.result.attrition.armageddonWaves,
            decided: record.result.attrition.decidedByArmageddon,
            unitsKilled: record.result.attrition.unitsKilledByArmageddon,
            unitsKilledByNarrowing: record.result.attrition.unitsKilledByNarrowing,
        },
        rejections: {
            candidate: candidateRejected ?? 0,
            opponent: opponentRejected ?? 0,
            details: record.result.rejectedDetails ?? [],
        },
        actions: {
            candidate: summarizeV08ArmageddonActions(record.result.actions, plan.candidateSide),
            opponent: summarizeV08ArmageddonActions(record.result.actions, opponentSide),
        },
    };
}

function minimalChildEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    for (const key of INHERITED_OS_ENVIRONMENT_KEYS) {
        if (source[key] !== undefined) environment[key] = source[key];
    }
    environment.BUN_RUNTIME_TRANSPILER_CACHE_PATH = "0";
    return environment;
}

/**
 * Capture mutable experimental provenance while reporting the sealed-r1 check independently. Experimental
 * source edits are allowed; changing this bundle between the two physical replays is not.
 */
export function captureV08ArmageddonRegressionSourceIdentity(
    repositoryRoot: string = REPOSITORY_ROOT,
): IV08ArmageddonRegressionSourceIdentity {
    const sourceFiles = Object.fromEntries(
        V08_ARMAGEDDON_REGRESSION_SOURCE_FILES.map((relativePath) => [
            relativePath,
            createHash("sha256")
                .update(readFileSync(resolve(repositoryRoot, relativePath)))
                .digest("hex"),
        ]),
    );
    let sealedR1Pin: IV08ArmageddonRegressionSourceIdentity["sealedR1Pin"];
    try {
        verifyV08CandidateOperationalIdentity(repositoryRoot);
        sealedR1Pin = { matched: true, mismatch: null };
    } catch (error) {
        sealedR1Pin = { matched: false, mismatch: error instanceof Error ? error.message : String(error) };
    }
    return {
        sourceFiles: Object.freeze(sourceFiles),
        workingTreeSourceBundleSha256: fingerprintV08AlignedV1(sourceFiles),
        sealedR1Pin,
    };
}

/** Build the reviewed bounded alias environment while removing every unrelated inherited behavior knob. */
export function buildV08ArmageddonRegressionEnvironment(
    auditPath: string,
    variant: V08ArmageddonRegressionVariant = "experimental",
    source: NodeJS.ProcessEnv = process.env,
): IV08ArmageddonRegressionEnvironment {
    const candidate = candidateForVariant(variant);
    const frozen = buildV08TestCandidateEnvironment({
        auditPath: V08_TEST_CANDIDATE_SOURCE_AUDIT_PATH,
        timingMode: "operational_bounded",
        candidateVersion: candidate,
    });
    const frozenEnvironmentSha256 = fingerprintV08AlignedV1(frozen);
    const expectedEnvironmentSha256 =
        variant === "stable"
            ? V08_TEST_CANDIDATE_OPERATIONAL_ENVIRONMENT_SHA256
            : V08_TEST_CANDIDATE_SOURCE_ALIAS_OPERATIONAL_ENVIRONMENT_SHA256;
    if (frozenEnvironmentSha256 !== expectedEnvironmentSha256) {
        throw new Error(`${candidate} bounded operational environment drifted; candidate profile repin required`);
    }
    const candidateEnvironment = buildV08TestCandidateEnvironment({
        auditPath,
        timingMode: "operational_bounded",
        candidateVersion: candidate,
    });
    const environment = minimalChildEnvironment(source);
    Object.assign(environment, candidateEnvironment);
    return {
        environment,
        candidateEnvironment,
        frozenEnvironmentSha256,
        materializedEnvironmentSha256: fingerprintV08AlignedV1(candidateEnvironment),
    };
}

function assertChildEnvironment(
    auditPath: string,
    variant: V08ArmageddonRegressionVariant,
): IV08ArmageddonRegressionEnvironment {
    const expected = buildV08ArmageddonRegressionEnvironment(auditPath, variant, {});
    for (const [key, value] of Object.entries(expected.candidateEnvironment)) {
        if (process.env[key] !== value) throw new Error(`Armageddon regression child environment drifted at ${key}`);
    }
    return expected;
}

function tournamentOptions(variant: V08ArmageddonRegressionVariant): ITournamentOptions {
    return {
        versionA: candidateForVariant(variant),
        versionB: V08_ARMAGEDDON_REGRESSION_OPPONENT,
        games: V08_ARMAGEDDON_REGRESSION_BASELINE_GAMES,
        baseSeed: V08_ARMAGEDDON_REGRESSION_BASE_SEED,
        mapTypes: MAP_TYPES,
    };
}

/** Execute only the fixed cases, using the standard tournament worker and arbitrary-index playGame helper. */
export async function replayV08ArmageddonRegressionGames(
    indices: readonly number[],
    variant: V08ArmageddonRegressionVariant,
    concurrency: number,
): Promise<IGameRecord[]> {
    if (!indices.length) throw new Error("Armageddon regression panel requires at least one game");
    if (!Number.isSafeInteger(concurrency) || concurrency <= 0) throw new Error("concurrency must be positive");
    const unique = new Set(indices);
    if (unique.size !== indices.length) throw new Error("Armageddon regression panel contains duplicate indices");
    for (const game of indices) {
        requirePanelGameIndex(game);
        if (!BASELINE_INDEX_SET.has(game)) throw new Error(`Armageddon regression panel has non-baseline game ${game}`);
    }
    const options = tournamentOptions(variant);
    const poolSize = Math.min(concurrency, indices.length);
    if (poolSize === 1) return indices.map((game) => playGame(options, game));

    return new Promise<IGameRecord[]>((resolveRecords, reject) => {
        const workers: Worker[] = [];
        const records: IGameRecord[] = [];
        let cursor = 0;
        let settled = false;
        const cleanup = (): void => {
            for (const worker of workers) void worker.terminate();
        };
        const fail = (error: unknown): void => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error instanceof Error ? error : new Error(String(error)));
        };
        const dispatch = (worker: Worker): void => {
            if (cursor >= indices.length) {
                worker.postMessage({ type: "stop" });
                return;
            }
            worker.postMessage({ type: "game", game: indices[cursor++] });
        };
        const workerUrl = new URL("./tournament_worker.ts", import.meta.url);
        for (let index = 0; index < poolSize; index += 1) {
            let worker: Worker;
            try {
                worker = new Worker(workerUrl, { workerData: { options } });
            } catch (error) {
                fail(error);
                return;
            }
            workers.push(worker);
            worker.on("message", (message: { type: "ready" } | { type: "result"; record: IGameRecord }) => {
                if (settled) return;
                if (message.type === "ready") {
                    dispatch(worker);
                    return;
                }
                records.push(message.record);
                if (records.length === indices.length) {
                    settled = true;
                    cleanup();
                    resolveRecords(records.sort((left, right) => left.game - right.game));
                    return;
                }
                dispatch(worker);
            });
            worker.on("error", fail);
        }
    });
}

export function summarizeV08ArmageddonCohort(
    records: readonly IV08ArmageddonPanelRecord[],
): IV08ArmageddonCohortSummary {
    const remainingArmageddonIndices = records
        .filter((record) => record.armageddon.reached)
        .map((record) => record.game);
    return {
        games: records.length,
        armageddonReached: remainingArmageddonIndices.length,
        armageddonReachedRate: records.length ? remainingArmageddonIndices.length / records.length : 0,
        armageddonDecided: records.filter((record) => record.armageddon.decided).length,
        candidateWins: records.filter((record) => record.winner === "candidate").length,
        opponentWins: records.filter((record) => record.winner === "opponent").length,
        draws: records.filter((record) => record.winner === "draw").length,
        rejectedCandidate: records.reduce((total, record) => total + record.rejections.candidate, 0),
        rejectedOpponent: records.reduce((total, record) => total + record.rejections.opponent, 0),
        remainingArmageddonIndices,
        resolvedIndices: records.filter((record) => !record.armageddon.reached).map((record) => record.game),
    };
}

interface IPanelCliOptions {
    output: string;
    concurrency: number;
    residualOnly: boolean;
    child: boolean;
    variant: V08ArmageddonRegressionVariant | null;
}

function parseCli(argv: readonly string[]): IPanelCliOptions {
    const flags = argv.filter((argument) => argument.startsWith("--"));
    const [outputArg, concurrencyArg] = argv.filter((argument) => !argument.startsWith("--"));
    const variantRaw = flags.find((flag) => flag.startsWith("--variant="))?.slice("--variant=".length);
    if (variantRaw !== undefined && !(variantRaw === "stable" || variantRaw === "experimental")) {
        throw new Error("--variant must be stable or experimental");
    }
    const concurrency = concurrencyArg ? Number(concurrencyArg) : Math.min(12, availableParallelism());
    if (!Number.isSafeInteger(concurrency) || concurrency <= 0) throw new Error("concurrency must be positive");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return {
        output: resolve(outputArg ?? join(process.cwd(), "sim-out", `v0.8-armageddon-panel-${stamp}`)),
        concurrency,
        residualOnly: flags.includes("--residual-only"),
        child: flags.includes("--child"),
        variant: variantRaw ?? null,
    };
}

function runChildProcess(
    options: IPanelCliOptions,
    variant: V08ArmageddonRegressionVariant,
    environment: NodeJS.ProcessEnv,
): Promise<number> {
    const args = [PANEL_PATH, options.output, String(options.concurrency), `--variant=${variant}`, "--child"];
    if (options.residualOnly) args.push("--residual-only");
    return new Promise<number>((resolveCode, reject) => {
        const child = spawn(process.execPath, args, {
            cwd: resolve(import.meta.dir, "../.."),
            env: environment,
            stdio: "inherit",
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            if (signal) reject(new Error(`Armageddon regression child exited on ${signal}`));
            else resolveCode(code ?? 1);
        });
    });
}

async function executeVariant(options: IPanelCliOptions, variant: V08ArmageddonRegressionVariant): Promise<void> {
    const auditName = searchAuditName(variant);
    const auditPath = join(options.output, auditName);
    const environment = assertChildEnvironment(auditPath, variant);
    const sourceIdentity = captureV08ArmageddonRegressionSourceIdentity();
    mkdirSync(options.output, { recursive: true });
    const indices = selectedV08ArmageddonRegressionIndices(options.residualOnly);
    const raw = await replayV08ArmageddonRegressionGames(indices, variant, options.concurrency);
    const records = raw.map((record) => summarizeV08ArmageddonRegressionRecord(record, variant));
    const finalSourceIdentity = captureV08ArmageddonRegressionSourceIdentity();
    if (finalSourceIdentity.workingTreeSourceBundleSha256 !== sourceIdentity.workingTreeSourceBundleSha256) {
        throw new Error(`${variant} Armageddon regression source bundle changed during replay`);
    }
    const residual = records.filter((record) => record.residual);
    const nonResidual = records.filter((record) => !record.residual);
    const summary = {
        schema: V08_ARMAGEDDON_REGRESSION_SCHEMA,
        generatedAt: new Date().toISOString(),
        testOnly: true,
        operationalPolicyId: V08_TEST_CANDIDATE_OPERATIONAL_POLICY_ID,
        sourceIdentity,
        environment: {
            timingMode: "operational_bounded",
            candidateVersion: candidateForVariant(variant),
            frozenEnvironmentSha256: environment.frozenEnvironmentSha256,
            materializedEnvironmentSha256: environment.materializedEnvironmentSha256,
            searchAudit: auditName,
        },
        geometry: {
            baselineGames: V08_ARMAGEDDON_REGRESSION_BASELINE_GAMES,
            baseSeed: V08_ARMAGEDDON_REGRESSION_BASE_SEED,
            maps: V08_ARMAGEDDON_REGRESSION_MAPS,
            selectedIndices: indices,
            baselineArmageddonIndices: V08_ARMAGEDDON_BASELINE_INDICES,
            residualIndices: V08_ARMAGEDDON_RESIDUAL_INDICES,
            residualOnly: options.residualOnly,
        },
        variant,
        versions: { candidate: candidateForVariant(variant), opponent: V08_ARMAGEDDON_REGRESSION_OPPONENT },
        cohorts: {
            selected: summarizeV08ArmageddonCohort(records),
            residual14: summarizeV08ArmageddonCohort(residual),
            originalNonResidual52: summarizeV08ArmageddonCohort(nonResidual),
        },
        artifacts: { records: recordsName(variant), summary: variantSummaryName(variant), searchAudit: auditName },
    };
    writeFileSync(
        join(options.output, recordsName(variant)),
        `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
    writeFileSync(join(options.output, variantSummaryName(variant)), `${JSON.stringify(summary, null, 2)}\n`);
    const selected = summary.cohorts.selected;
    console.log(
        `${variant} Armageddon regression: ${selected.armageddonReached}/${selected.games} still reached; ` +
            `${selected.rejectedCandidate} candidate rejections`,
    );
}

function readPanelRecords(path: string): IV08ArmageddonPanelRecord[] {
    return readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as IV08ArmageddonPanelRecord);
}

export function pairV08ArmageddonRegressionRecords(
    stable: readonly IV08ArmageddonPanelRecord[],
    experimental: readonly IV08ArmageddonPanelRecord[],
): Array<{
    schema: typeof V08_ARMAGEDDON_REGRESSION_SCHEMA;
    game: number;
    residual: boolean;
    pair: number;
    seed: number;
    map: IV08ArmageddonPanelRecord["map"];
    candidateSide: Side;
    stable: IV08ArmageddonPanelRecord;
    experimental: IV08ArmageddonPanelRecord;
}> {
    if (stable.length !== experimental.length) throw new Error("stable/experimental panel sizes differ");
    const experimentalByGame = new Map(experimental.map((record) => [record.game, record]));
    return stable.map((stableRecord) => {
        const experimentalRecord = experimentalByGame.get(stableRecord.game);
        if (!experimentalRecord) throw new Error(`experimental panel is missing game ${stableRecord.game}`);
        for (const key of ["pair", "seed", "candidateSide"] as const) {
            if (stableRecord[key] !== experimentalRecord[key]) {
                throw new Error(`stable/experimental game ${stableRecord.game} ${key} mapping differs`);
            }
        }
        if (
            stableRecord.map.type !== experimentalRecord.map.type ||
            stableRecord.map.name !== experimentalRecord.map.name ||
            stableRecord.residual !== experimentalRecord.residual
        ) {
            throw new Error(`stable/experimental game ${stableRecord.game} map/cohort mapping differs`);
        }
        return {
            schema: V08_ARMAGEDDON_REGRESSION_SCHEMA,
            game: stableRecord.game,
            residual: stableRecord.residual,
            pair: stableRecord.pair,
            seed: stableRecord.seed,
            map: stableRecord.map,
            candidateSide: stableRecord.candidateSide,
            stable: stableRecord,
            experimental: experimentalRecord,
        };
    });
}

function readJson<T>(path: string): T {
    return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeComparison(
    options: IPanelCliOptions,
    expectedSourceIdentity: IV08ArmageddonRegressionSourceIdentity,
): void {
    const stable = readPanelRecords(join(options.output, recordsName("stable")));
    const experimental = readPanelRecords(join(options.output, recordsName("experimental")));
    const stableSummary = readJson<{ sourceIdentity: IV08ArmageddonRegressionSourceIdentity }>(
        join(options.output, variantSummaryName("stable")),
    );
    const experimentalSummary = readJson<{ sourceIdentity: IV08ArmageddonRegressionSourceIdentity }>(
        join(options.output, variantSummaryName("experimental")),
    );
    for (const [label, actual] of [
        ["stable", stableSummary.sourceIdentity],
        ["experimental", experimentalSummary.sourceIdentity],
    ] as const) {
        if (actual.workingTreeSourceBundleSha256 !== expectedSourceIdentity.workingTreeSourceBundleSha256) {
            throw new Error(`${label} replay source bundle changed during the side-by-side panel`);
        }
    }
    const paired = pairV08ArmageddonRegressionRecords(stable, experimental);
    const stableResidual = stable.filter((record) => record.residual);
    const experimentalResidual = experimental.filter((record) => record.residual);
    const summary = {
        schema: V08_ARMAGEDDON_REGRESSION_SCHEMA,
        generatedAt: new Date().toISOString(),
        testOnly: true,
        operationalPolicyId: V08_TEST_CANDIDATE_OPERATIONAL_POLICY_ID,
        sourceIdentity: expectedSourceIdentity,
        geometry: {
            baselineGames: V08_ARMAGEDDON_REGRESSION_BASELINE_GAMES,
            baseSeed: V08_ARMAGEDDON_REGRESSION_BASE_SEED,
            maps: V08_ARMAGEDDON_REGRESSION_MAPS,
            selectedIndices: selectedV08ArmageddonRegressionIndices(options.residualOnly),
            baselineArmageddonIndices: V08_ARMAGEDDON_BASELINE_INDICES,
            residualIndices: V08_ARMAGEDDON_RESIDUAL_INDICES,
            residualOnly: options.residualOnly,
        },
        versions: {
            stable: V08_ARMAGEDDON_REGRESSION_STABLE,
            experimental: V08_ARMAGEDDON_REGRESSION_EXPERIMENTAL,
            opponent: V08_ARMAGEDDON_REGRESSION_OPPONENT,
        },
        cohorts: {
            selected: {
                stable: summarizeV08ArmageddonCohort(stable),
                experimental: summarizeV08ArmageddonCohort(experimental),
            },
            residual14: {
                stable: summarizeV08ArmageddonCohort(stableResidual),
                experimental: summarizeV08ArmageddonCohort(experimentalResidual),
            },
        },
        artifacts: {
            comparisonRecords: COMPARISON_RECORDS_NAME,
            stableRecords: recordsName("stable"),
            experimentalRecords: recordsName("experimental"),
            stableSummary: variantSummaryName("stable"),
            experimentalSummary: variantSummaryName("experimental"),
            stableSearchAudit: searchAuditName("stable"),
            experimentalSearchAudit: searchAuditName("experimental"),
        },
    };
    writeFileSync(
        join(options.output, COMPARISON_RECORDS_NAME),
        `${paired.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
    writeFileSync(join(options.output, COMPARISON_SUMMARY_NAME), `${JSON.stringify(summary, null, 2)}\n`);
    const residual = summary.cohorts.residual14;
    console.log(
        `Residual 14: stable ${residual.stable.armageddonReached}/${residual.stable.games}, ` +
            `experimental ${residual.experimental.armageddonReached}/${residual.experimental.games} reached Armageddon`,
    );
    console.log(`Side-by-side summary -> ${join(options.output, COMPARISON_SUMMARY_NAME)}`);
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    if (argv.includes("--help") || argv.includes("-h")) {
        console.log(
            "Usage: bun src/simulation/v0_8_armageddon_regression_panel.ts [outDir] [concurrency] " +
                "[--residual-only]",
        );
        return;
    }
    const options = parseCli(argv);
    if (options.child) {
        if (!options.variant) throw new Error("internal Armageddon regression child requires --variant");
        await executeVariant(options, options.variant);
        return;
    }
    const sourceIdentity = captureV08ArmageddonRegressionSourceIdentity();
    prepareV08CandidateOutputDirectory(options.output);
    for (const variant of ["stable", "experimental"] as const) {
        const auditPath = join(options.output, searchAuditName(variant));
        const environment = buildV08ArmageddonRegressionEnvironment(auditPath, variant);
        const exitCode = await runChildProcess(options, variant, environment.environment);
        if (exitCode !== 0) throw new Error(`${variant} Armageddon regression child failed with exit code ${exitCode}`);
    }
    const finalSourceIdentity = captureV08ArmageddonRegressionSourceIdentity();
    if (finalSourceIdentity.workingTreeSourceBundleSha256 !== sourceIdentity.workingTreeSourceBundleSha256) {
        throw new Error("Armageddon regression source bundle changed while the side-by-side panel was running");
    }
    writeComparison(options, sourceIdentity);
}

if ((import.meta as unknown as { main?: boolean }).main) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}

export { main };
