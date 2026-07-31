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

import { V09_RTX5090_GPU_UUID } from "./campaign";
import { fingerprintV09 } from "./protocol";

export const V09_ACTOR_LANE_BENCHMARK_SCHEMA = "hoc.ai.v0_9_actor_lane_benchmark.v2" as const;
export const V09_AUDITED_ACTOR_LANE_COUNTS = [20, 22, 23, 24] as const;
export type V09AuditedActorLaneCount = (typeof V09_AUDITED_ACTOR_LANE_COUNTS)[number];
export type V09ActorLaneBenchmarkMode = "production" | "test_fixture";
export type V09ActorLaneThermalTelemetry = "observed" | "unavailable_user_override";

export const V09_ACTOR_LANE_SELECTION_POLICY = Object.freeze({
    requiredPlatform: "linux",
    requiredArchitecture: "x64",
    requiredBunVersion: "1.3.14",
    requiredGpuUuid: V09_RTX5090_GPU_UUID,
    auditedWorkers: V09_AUDITED_ACTOR_LANE_COUNTS,
    minimumProductionPanelGames: 96,
    minimumProductionRepetitions: 2,
    minimumFreeMemoryBytes: 16 * 1024 * 1024 * 1024,
    maximumCoefficientOfVariation: 0.05,
    minimumThroughputGainRatio: 0.03,
    maximumTemperatureC: 90,
} as const);

export interface IV09ActorLaneBenchmarkSource {
    receiptSha256: string;
    sourceCommit: string;
    sourceStatusSha256: string;
    rulesFingerprint: string;
}

export interface IV09ActorLaneBenchmarkHost {
    hostname: string;
    platform: string;
    architecture: string;
    release: string;
    bunVersion: string;
    cpuModel: string;
    logicalCpuCount: number;
    allowedLogicalCpuIds: number[];
    physicalCpuIds: number[];
    topologySha256: string;
    gpuUuid: string;
    temperatureSensorCount: number;
    throttleCounterCount: number;
}

export interface IV09ActorLaneBenchmarkIdleEvidence {
    checkedAt: string;
    loadOne: number;
    maximumLoadOne: number;
    freeMemoryBytes: number;
    conflictingProcesses: string[];
    gpuComputePids: number[];
}

export interface IV09ActorLaneBenchmarkPanel {
    purpose: "wide_teacher_train";
    games: number;
    repetitions: number;
    productionTeacherSearch: true;
    runFingerprint: string;
    seedLedgerSha256: string;
    seedsSha256: string;
}

export interface IV09ActorLaneBenchmarkRun {
    sequence: number;
    repetition: number;
    workers: number;
    physicalCpuIds: number[];
    games: number;
    elapsedSeconds: number;
    gamesPerSecond: number;
    shardSetSha256: string;
    peakTemperatureC: number;
    throttleCountBefore: number;
    throttleCountAfter: number;
}

export interface IV09ActorLaneCandidateSummary {
    workers: number;
    samples: number;
    meanGamesPerSecond: number;
    minimumGamesPerSecond: number;
    maximumGamesPerSecond: number;
    coefficientOfVariation: number;
}

export interface IV09ActorLaneSelection {
    selectedWorkers: number;
    selectedPhysicalCpuIds: number[];
    reservedPhysicalCores: number;
    candidates: IV09ActorLaneCandidateSummary[];
    rationale: string;
}

export interface IV09ActorLaneBenchmarkInput {
    mode: V09ActorLaneBenchmarkMode;
    thermalTelemetry: V09ActorLaneThermalTelemetry;
    source: IV09ActorLaneBenchmarkSource;
    host: IV09ActorLaneBenchmarkHost;
    idle: IV09ActorLaneBenchmarkIdleEvidence;
    panel: IV09ActorLaneBenchmarkPanel;
    runs: IV09ActorLaneBenchmarkRun[];
    startedAt: string;
    completedAt: string;
}

export interface IV09ActorLaneBenchmarkReceipt extends IV09ActorLaneBenchmarkInput {
    schema: typeof V09_ACTOR_LANE_BENCHMARK_SCHEMA;
    policy: typeof V09_ACTOR_LANE_SELECTION_POLICY;
    eligibleForCampaign: boolean;
    selection: IV09ActorLaneSelection;
    receiptSha256: string;
}

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_COMMIT = /^[0-9a-f]{7,64}$/;
const GPU_UUID = /^GPU-[0-9a-f-]+$/i;

function requireRecord(value: unknown, context: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${context} must be an object`);
    }
    return value as Record<string, unknown>;
}

function requireText(value: unknown, context: string): string {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${context} must be a non-empty string`);
    return value;
}

function requireSha(value: unknown, context: string): string {
    const parsed = requireText(value, context);
    if (!SHA256.test(parsed)) throw new Error(`${context} must be a lowercase SHA-256`);
    return parsed;
}

function requireInteger(value: unknown, context: string, minimum = 0): number {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) {
        throw new Error(`${context} must be a safe integer >= ${minimum}`);
    }
    return value as number;
}

function requireFinite(value: unknown, context: string, minimum?: number): number {
    if (typeof value !== "number" || !Number.isFinite(value) || (minimum !== undefined && value < minimum)) {
        throw new Error(`${context} must be a finite number${minimum === undefined ? "" : ` >= ${minimum}`}`);
    }
    return value;
}

function requireTimestamp(value: unknown, context: string): string {
    const parsed = requireText(value, context);
    if (!Number.isFinite(Date.parse(parsed))) throw new Error(`${context} must be an ISO timestamp`);
    return parsed;
}

function requireIntegerArray(value: unknown, context: string, minimumLength = 0): number[] {
    if (!Array.isArray(value) || value.length < minimumLength) {
        throw new Error(`${context} must be an integer array with at least ${minimumLength} entries`);
    }
    const parsed = value.map((entry, index) => requireInteger(entry, `${context}[${index}]`));
    if (new Set(parsed).size !== parsed.length) throw new Error(`${context} must contain unique entries`);
    return parsed;
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertSource(source: IV09ActorLaneBenchmarkSource): void {
    requireSha(source.receiptSha256, "source.receiptSha256");
    const sourceCommit = requireText(source.sourceCommit, "source.sourceCommit");
    if (!GIT_COMMIT.test(sourceCommit)) throw new Error("source.sourceCommit must be a lowercase Git commit");
    requireSha(source.sourceStatusSha256, "source.sourceStatusSha256");
    requireSha(source.rulesFingerprint, "source.rulesFingerprint");
}

function assertHost(host: IV09ActorLaneBenchmarkHost): void {
    requireText(host.hostname, "host.hostname");
    requireText(host.platform, "host.platform");
    requireText(host.architecture, "host.architecture");
    requireText(host.release, "host.release");
    requireText(host.bunVersion, "host.bunVersion");
    requireText(host.cpuModel, "host.cpuModel");
    requireInteger(host.logicalCpuCount, "host.logicalCpuCount", 1);
    const allowed = requireIntegerArray(host.allowedLogicalCpuIds, "host.allowedLogicalCpuIds", 1);
    const physical = requireIntegerArray(host.physicalCpuIds, "host.physicalCpuIds", 1);
    if (physical.some((cpu) => !allowed.includes(cpu))) {
        throw new Error("host.physicalCpuIds must be selected from the process affinity");
    }
    requireSha(host.topologySha256, "host.topologySha256");
    if (!GPU_UUID.test(host.gpuUuid)) throw new Error("host.gpuUuid must be a GPU UUID");
    requireInteger(host.temperatureSensorCount, "host.temperatureSensorCount");
    requireInteger(host.throttleCounterCount, "host.throttleCounterCount");
}

function assertIdle(idle: IV09ActorLaneBenchmarkIdleEvidence): void {
    requireTimestamp(idle.checkedAt, "idle.checkedAt");
    requireFinite(idle.loadOne, "idle.loadOne", 0);
    requireFinite(idle.maximumLoadOne, "idle.maximumLoadOne", 0);
    requireInteger(idle.freeMemoryBytes, "idle.freeMemoryBytes");
    if (
        !Array.isArray(idle.conflictingProcesses) ||
        idle.conflictingProcesses.some((entry) => typeof entry !== "string")
    ) {
        throw new Error("idle.conflictingProcesses must be a string array");
    }
    requireIntegerArray(idle.gpuComputePids, "idle.gpuComputePids");
}

function assertPanel(panel: IV09ActorLaneBenchmarkPanel): void {
    if (panel.purpose !== "wide_teacher_train") throw new Error("panel purpose must be wide_teacher_train");
    requireInteger(panel.games, "panel.games", 1);
    requireInteger(panel.repetitions, "panel.repetitions", 1);
    if (panel.productionTeacherSearch !== true) throw new Error("panel must use production teacher search");
    requireSha(panel.runFingerprint, "panel.runFingerprint");
    requireSha(panel.seedLedgerSha256, "panel.seedLedgerSha256");
    requireSha(panel.seedsSha256, "panel.seedsSha256");
}

function assertRun(run: IV09ActorLaneBenchmarkRun, index: number): void {
    const context = `runs[${index}]`;
    requireInteger(run.sequence, `${context}.sequence`);
    requireInteger(run.repetition, `${context}.repetition`);
    requireInteger(run.workers, `${context}.workers`, 1);
    const cpus = requireIntegerArray(run.physicalCpuIds, `${context}.physicalCpuIds`, 1);
    if (cpus.length !== run.workers) throw new Error(`${context}.physicalCpuIds must match workers`);
    requireInteger(run.games, `${context}.games`, 1);
    requireFinite(run.elapsedSeconds, `${context}.elapsedSeconds`, Number.EPSILON);
    requireFinite(run.gamesPerSecond, `${context}.gamesPerSecond`, Number.EPSILON);
    requireSha(run.shardSetSha256, `${context}.shardSetSha256`);
    requireFinite(run.peakTemperatureC, `${context}.peakTemperatureC`, 0);
    requireInteger(run.throttleCountBefore, `${context}.throttleCountBefore`);
    requireInteger(run.throttleCountAfter, `${context}.throttleCountAfter`);
}

function candidateSummary(workers: number, runs: readonly IV09ActorLaneBenchmarkRun[]): IV09ActorLaneCandidateSummary {
    const throughput = runs.map((run) => run.gamesPerSecond);
    const mean = throughput.reduce((sum, value) => sum + value, 0) / throughput.length;
    const variance = throughput.reduce((sum, value) => sum + (value - mean) ** 2, 0) / throughput.length;
    return {
        workers,
        samples: throughput.length,
        meanGamesPerSecond: mean,
        minimumGamesPerSecond: Math.min(...throughput),
        maximumGamesPerSecond: Math.max(...throughput),
        coefficientOfVariation: Math.sqrt(variance) / mean,
    };
}

function assertBenchmarkInput(input: IV09ActorLaneBenchmarkInput): void {
    if (input.mode !== "production" && input.mode !== "test_fixture") {
        throw new Error("benchmark mode must be production or test_fixture");
    }
    if (input.thermalTelemetry !== "observed" && input.thermalTelemetry !== "unavailable_user_override") {
        throw new Error("benchmark thermal telemetry mode is unsupported");
    }
    assertSource(input.source);
    assertHost(input.host);
    assertIdle(input.idle);
    assertPanel(input.panel);
    requireTimestamp(input.startedAt, "startedAt");
    requireTimestamp(input.completedAt, "completedAt");
    if (Date.parse(input.completedAt) < Date.parse(input.startedAt)) {
        throw new Error("benchmark completedAt precedes startedAt");
    }
    if (!Array.isArray(input.runs) || !input.runs.length) throw new Error("benchmark must contain runs");
    input.runs.forEach(assertRun);
    for (const [index, run] of input.runs.entries()) {
        if (run.sequence !== index) throw new Error("benchmark run sequence must be contiguous");
        if (run.repetition >= input.panel.repetitions) throw new Error(`runs[${index}] repetition is outside panel`);
        if (run.games !== input.panel.games) throw new Error(`runs[${index}] game count differs from panel`);
        const expectedThroughput = run.games / run.elapsedSeconds;
        const tolerance = Math.max(1e-12, expectedThroughput * 1e-9);
        if (Math.abs(run.gamesPerSecond - expectedThroughput) > tolerance) {
            throw new Error(`runs[${index}] throughput does not match games/elapsedSeconds`);
        }
        if (!sameNumbers(run.physicalCpuIds, input.host.physicalCpuIds.slice(0, run.workers))) {
            throw new Error(`runs[${index}] CPU binding is not the topology prefix`);
        }
    }
}

function deriveSelection(input: IV09ActorLaneBenchmarkInput): {
    eligibleForCampaign: boolean;
    selection: IV09ActorLaneSelection;
} {
    assertBenchmarkInput(input);
    const workers = [...new Set(input.runs.map((run) => run.workers))].sort((left, right) => left - right);
    const candidates = workers.map((count) =>
        candidateSummary(
            count,
            input.runs.filter((run) => run.workers === count),
        ),
    );
    for (const summary of candidates) {
        const repetitions = input.runs
            .filter((run) => run.workers === summary.workers)
            .map((run) => run.repetition)
            .sort((left, right) => left - right);
        const expected = Array.from({ length: input.panel.repetitions }, (_, index) => index);
        if (!sameNumbers(repetitions, expected)) {
            throw new Error(`worker candidate ${summary.workers} does not have one run per repetition`);
        }
    }
    const shardHashes = new Set(input.runs.map((run) => run.shardSetSha256));
    if (shardHashes.size !== 1) throw new Error("actor lane candidates did not produce byte-identical shard sets");

    const production = input.mode === "production";
    if (production) {
        if (!sameNumbers(workers, V09_AUDITED_ACTOR_LANE_COUNTS)) {
            throw new Error("production benchmark must contain exactly the audited 20/22/23/24 lane counts");
        }
        for (let repetition = 0; repetition < input.panel.repetitions; repetition += 1) {
            const actual = input.runs.filter((run) => run.repetition === repetition).map((run) => run.workers);
            const expected =
                repetition % 2 === 0
                    ? [...V09_AUDITED_ACTOR_LANE_COUNTS]
                    : [...V09_AUDITED_ACTOR_LANE_COUNTS].reverse();
            if (!sameNumbers(actual, expected)) {
                throw new Error("production benchmark candidates were not counterbalanced");
            }
        }
        if (
            input.host.platform !== V09_ACTOR_LANE_SELECTION_POLICY.requiredPlatform ||
            input.host.architecture !== V09_ACTOR_LANE_SELECTION_POLICY.requiredArchitecture ||
            input.host.bunVersion !== V09_ACTOR_LANE_SELECTION_POLICY.requiredBunVersion ||
            input.host.gpuUuid !== V09_ACTOR_LANE_SELECTION_POLICY.requiredGpuUuid
        ) {
            throw new Error("production benchmark host/runtime/GPU identity is incompatible");
        }
        if (input.host.physicalCpuIds.length < Math.max(...V09_AUDITED_ACTOR_LANE_COUNTS)) {
            throw new Error("production benchmark host does not expose 24 affinity-allowed physical cores");
        }
        if (input.thermalTelemetry === "observed") {
            if (input.host.temperatureSensorCount < 1 || input.host.throttleCounterCount < 1) {
                throw new Error("production benchmark requires temperature and throttle telemetry");
            }
        } else if (input.host.temperatureSensorCount !== 0 || input.host.throttleCounterCount !== 0) {
            throw new Error("thermal telemetry override is only valid when both telemetry sources are unavailable");
        }
        if (
            input.panel.games < V09_ACTOR_LANE_SELECTION_POLICY.minimumProductionPanelGames ||
            input.panel.repetitions < V09_ACTOR_LANE_SELECTION_POLICY.minimumProductionRepetitions
        ) {
            throw new Error("production benchmark panel is too small");
        }
        if (
            input.idle.conflictingProcesses.length ||
            input.idle.gpuComputePids.length ||
            input.idle.loadOne > input.idle.maximumLoadOne ||
            input.idle.freeMemoryBytes < V09_ACTOR_LANE_SELECTION_POLICY.minimumFreeMemoryBytes
        ) {
            throw new Error("production benchmark did not begin on an idle host");
        }
        for (const run of input.runs) {
            if (input.thermalTelemetry === "observed") {
                if (
                    run.peakTemperatureC > V09_ACTOR_LANE_SELECTION_POLICY.maximumTemperatureC ||
                    run.throttleCountAfter !== run.throttleCountBefore
                ) {
                    throw new Error(`worker candidate ${run.workers} failed thermal safety`);
                }
            } else if (run.peakTemperatureC !== 0 || run.throttleCountBefore !== 0 || run.throttleCountAfter !== 0) {
                throw new Error(`worker candidate ${run.workers} recorded telemetry despite the override`);
            }
        }
        if (
            candidates.some(
                (candidate) =>
                    candidate.coefficientOfVariation > V09_ACTOR_LANE_SELECTION_POLICY.maximumCoefficientOfVariation,
            )
        ) {
            throw new Error("production benchmark throughput is not stable enough to select a lane count");
        }
    }

    let selected = candidates[0]!;
    for (const candidate of candidates.slice(1)) {
        if (
            candidate.meanGamesPerSecond >=
            selected.meanGamesPerSecond * (1 + V09_ACTOR_LANE_SELECTION_POLICY.minimumThroughputGainRatio)
        ) {
            selected = candidate;
        }
    }
    return {
        eligibleForCampaign: production,
        selection: {
            selectedWorkers: selected.workers,
            selectedPhysicalCpuIds: input.host.physicalCpuIds.slice(0, selected.workers),
            reservedPhysicalCores: input.host.physicalCpuIds.length - selected.workers,
            candidates,
            rationale:
                `selected ${selected.workers} lanes; a larger candidate must improve mean throughput by at least ` +
                `${V09_ACTOR_LANE_SELECTION_POLICY.minimumThroughputGainRatio * 100}%` +
                (input.thermalTelemetry === "unavailable_user_override"
                    ? "; CPU thermal telemetry was unavailable and explicitly user-overridden"
                    : ""),
        },
    };
}

export function sealV09ActorLaneBenchmarkReceipt(input: IV09ActorLaneBenchmarkInput): IV09ActorLaneBenchmarkReceipt {
    const derived = deriveSelection(input);
    const unsigned = {
        schema: V09_ACTOR_LANE_BENCHMARK_SCHEMA,
        ...input,
        policy: V09_ACTOR_LANE_SELECTION_POLICY,
        ...derived,
    };
    return { ...unsigned, receiptSha256: fingerprintV09(unsigned) };
}

export function validateV09ActorLaneBenchmarkReceipt(value: unknown): IV09ActorLaneBenchmarkReceipt {
    const record = requireRecord(value, "actor lane benchmark receipt");
    const receipt = value as IV09ActorLaneBenchmarkReceipt;
    requireSha(record.receiptSha256, "receiptSha256");
    if (receipt.schema !== V09_ACTOR_LANE_BENCHMARK_SCHEMA) {
        throw new Error("actor lane benchmark receipt schema mismatch");
    }
    const input: IV09ActorLaneBenchmarkInput = {
        mode: receipt.mode,
        thermalTelemetry: receipt.thermalTelemetry,
        source: receipt.source,
        host: receipt.host,
        idle: receipt.idle,
        panel: receipt.panel,
        runs: receipt.runs,
        startedAt: receipt.startedAt,
        completedAt: receipt.completedAt,
    };
    const expected = sealV09ActorLaneBenchmarkReceipt(input);
    if (fingerprintV09(receipt) !== fingerprintV09(expected) || receipt.receiptSha256 !== expected.receiptSha256) {
        throw new Error("actor lane benchmark receipt identity or selection mismatch");
    }
    return receipt;
}
