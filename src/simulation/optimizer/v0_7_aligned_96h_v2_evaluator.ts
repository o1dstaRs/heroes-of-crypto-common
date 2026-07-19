/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import {
    readV07AlignedV2AuditAppend,
    type IAligned96hBattleRecord,
    type IV07AlignedV2BattleRecord,
} from "./v0_7_aligned_96h_v2_game_adapter";
import {
    aggregateV07AlignedV2,
    defaultV07AlignedV2DryRunConfig,
    validateV07AlignedV2DryRunConfig,
    type IV07AlignedV2Aggregate,
    type IV07AlignedV2GameObservation,
} from "./v0_7_aligned_96h_v2_core";
import { buildV07AlignedV2ProductionIncumbentGenome } from "./v0_7_aligned_96h_v2_catalog";
import {
    bindV07AlignedV2Candidate,
    buildAligned96hCheckpointShardSpecs,
    buildV07AlignedV2CandidateEnvironment,
    buildV07AlignedV2CheckpointShardSpecs,
    buildV07AlignedV2SyntheticPreflightShardSpecs,
    canonicalV07AlignedV2Json,
    createV07AlignedV2Checkpoint,
    fingerprintV07AlignedV2,
    flattenV07AlignedV2SeedPlan,
    validateV07AlignedV2CandidateBinding,
    validateV07AlignedV2CheckpointShardSpec,
    v07AlignedV2TaskIdentity,
    v07AlignedV2TaskKey,
    V07_ALIGNED_V2_BEHAVIOR_ENV_EXACT,
    V07_ALIGNED_V2_BEHAVIOR_ENV_PREFIXES,
    V07_ALIGNED_V2_FORBIDDEN_RUNTIME_ENV,
    type IAligned96hCandidateBinding,
    type IV07AlignedV2CandidateBinding,
    type IV07AlignedV2CandidateGenome,
    type IV07AlignedV2Checkpoint,
    type IV07AlignedV2CheckpointShardSpec,
    type IV07AlignedV2ExecutionTask,
    type IV07AlignedV2InjectedSeedPlan,
    type IV07AlignedV2TaskIdentity,
} from "./v0_7_aligned_96h_v2_protocol";
import { V08_ALIGNED_96H_V1_VERSION_PROFILE, assertAligned96hVersionProfile } from "./aligned_96h_version_profile";
import {
    gridTypeV08AlignedV1,
    validateV08AlignedV1GameObservation,
    type IV08AlignedV1GameObservation,
} from "./v0_8_aligned_96h_v1_core";
import type { IV08AlignedV1BattleRecord } from "./v0_8_aligned_96h_v1_game_adapter";
import { V08_ALIGNED_V1_NONFIGHT_BINDING_SHA256 } from "./v0_8_aligned_96h_v1_nonfight";
import {
    buildV08AlignedV1CandidateEnvironment,
    canonicalV08AlignedV1Json,
    fingerprintV08AlignedV1,
    validateV08AlignedV1CandidateBinding,
    type IV08AlignedV1CandidateBinding,
} from "./v0_8_aligned_96h_v1_protocol";

const WORKER_GRACEFUL_STOP_TIMEOUT_MS = 5_000;
const WORKER_SIGTERM_TIMEOUT_MS = 5_000;
const WORKER_EXIT_TIMEOUT_MS = 10_000;
const WORKER_CLEANUP_TIMEOUT_MS = WORKER_GRACEFUL_STOP_TIMEOUT_MS + WORKER_SIGTERM_TIMEOUT_MS + WORKER_EXIT_TIMEOUT_MS;

export interface IV07AlignedV2WorkerAttestation {
    workerIndex: number;
    runFingerprint: string;
    genomeSha256: string;
    behaviorEnvironmentSha256: string;
    environmentSha256: string;
    removedEnvironmentKeys: string[];
    transpilerCacheDisabled: "0";
    auditPath: string;
}

export interface IV08AlignedV1WorkerAttestation extends IV07AlignedV2WorkerAttestation {
    artifactKind: "v0_8_aligned_96h_v1_worker_attestation";
    versionProfile: typeof V08_ALIGNED_96H_V1_VERSION_PROFILE;
    nonfightBindingSha256: typeof V08_ALIGNED_V1_NONFIGHT_BINDING_SHA256;
}

export type Aligned96hCandidateBinding = IV07AlignedV2CandidateBinding | IV08AlignedV1CandidateBinding;

export type Aligned96hWorkerAttestation<Binding extends Aligned96hCandidateBinding> =
    Binding extends IV08AlignedV1CandidateBinding ? IV08AlignedV1WorkerAttestation : IV07AlignedV2WorkerAttestation;

export interface IAligned96hShardEvaluation<Binding extends Aligned96hCandidateBinding> {
    shard: IV07AlignedV2CheckpointShardSpec;
    binding: Binding;
    checkpoint: IV07AlignedV2Checkpoint;
    records: IAligned96hBattleRecord<Binding>[];
    attestations: Aligned96hWorkerAttestation<Binding>[];
    auditArtifacts: IV07AlignedV2WorkerAuditArtifact[];
}

export interface IV07AlignedV2ShardEvaluation extends IAligned96hShardEvaluation<IV07AlignedV2CandidateBinding> {
    records: IV07AlignedV2BattleRecord[];
    attestations: IV07AlignedV2WorkerAttestation[];
}

export type IV08AlignedV1ShardEvaluation = IAligned96hShardEvaluation<IV08AlignedV1CandidateBinding>;

export interface IV07AlignedV2WorkerAuditArtifact {
    workerIndex: number;
    sourcePath: string;
    taskKeys: string[];
    contents: string;
    contentsSha256: string;
    bytes: number;
    rows: number;
}

export interface IAligned96hShardEvaluationOptions<Binding extends Aligned96hCandidateBinding> {
    shard: IV07AlignedV2CheckpointShardSpec;
    seedPlan: IV07AlignedV2InjectedSeedPlan;
    binding: Binding;
    workers: number;
    auditDirectory: string;
    sourceEnvironment?: NodeJS.ProcessEnv;
    deadlineAtMs?: number;
    onWorkerStarted?: () => void;
}

export type IV07AlignedV2ShardEvaluationOptions = IAligned96hShardEvaluationOptions<IV07AlignedV2CandidateBinding>;

export type IV08AlignedV1ShardEvaluationOptions = IAligned96hShardEvaluationOptions<IV08AlignedV1CandidateBinding>;

export function validateAligned96hCandidateBinding(binding: IAligned96hCandidateBinding): Aligned96hCandidateBinding {
    if (binding.candidate === "v0.7s") {
        return validateV07AlignedV2CandidateBinding(binding as IV07AlignedV2CandidateBinding);
    }
    if (binding.candidate === "v0.8s") {
        return validateV08AlignedV1CandidateBinding(binding as IV08AlignedV1CandidateBinding);
    }
    throw new Error(`unsupported aligned candidate binding ${binding.candidate}`);
}

export function aligned96hCandidateVersions(binding: IAligned96hCandidateBinding): {
    candidate: string;
    candidateBase: string;
    opponent: string;
} {
    const validated = validateAligned96hCandidateBinding(binding);
    return {
        candidate: validated.candidate,
        candidateBase: validated.candidateBase,
        opponent: validated.opponent,
    };
}

export function buildAligned96hCandidateEnvironment(
    binding: IAligned96hCandidateBinding,
    auditPath: string,
): Record<string, string> {
    const validated = validateAligned96hCandidateBinding(binding);
    return validated.candidate === "v0.8s"
        ? buildV08AlignedV1CandidateEnvironment(validated.genome, auditPath)
        : buildV07AlignedV2CandidateEnvironment(validated.genome, auditPath);
}

export function aligned96hWorkerMarker(
    binding: IAligned96hCandidateBinding,
): "v0_7_aligned_96h_v2_worker" | "v0_8_aligned_96h_v1_worker" {
    return validateAligned96hCandidateBinding(binding).candidate === "v0.8s"
        ? "v0_8_aligned_96h_v1_worker"
        : "v0_7_aligned_96h_v2_worker";
}

export function canonicalAligned96hJson(binding: Aligned96hCandidateBinding, value: unknown): string {
    return binding.candidate === "v0.8s" ? canonicalV08AlignedV1Json(value) : canonicalV07AlignedV2Json(value);
}

export function fingerprintAligned96h(binding: Aligned96hCandidateBinding, value: unknown): string {
    return binding.candidate === "v0.8s" ? fingerprintV08AlignedV1(value) : fingerprintV07AlignedV2(value);
}

export function validateAligned96hWorkerAttestation<Binding extends Aligned96hCandidateBinding>(
    binding: Binding,
    attestation: IV07AlignedV2WorkerAttestation | IV08AlignedV1WorkerAttestation,
): Aligned96hWorkerAttestation<Binding> {
    const validated = validateAligned96hCandidateBinding(binding);
    const baseKeys = [
        "workerIndex",
        "runFingerprint",
        "genomeSha256",
        "behaviorEnvironmentSha256",
        "environmentSha256",
        "removedEnvironmentKeys",
        "transpilerCacheDisabled",
        "auditPath",
    ];
    const expectedKeys = [
        ...baseKeys,
        ...(validated.candidate === "v0.8s" ? ["artifactKind", "versionProfile", "nonfightBindingSha256"] : []),
    ].sort();
    if (
        !attestation ||
        typeof attestation !== "object" ||
        Array.isArray(attestation) ||
        canonicalAligned96hJson(validated, Object.keys(attestation).sort()) !==
            canonicalAligned96hJson(validated, expectedKeys)
    ) {
        throw new Error("aligned worker attestation fields are not exact for its version profile");
    }
    if (validated.candidate === "v0.7s") {
        if (
            "artifactKind" in attestation ||
            "versionProfile" in attestation ||
            "nonfightBindingSha256" in attestation
        ) {
            throw new Error("v0.7 aligned worker attestation contains a foreign version marker");
        }
        return attestation as Aligned96hWorkerAttestation<Binding>;
    }
    if (
        !("artifactKind" in attestation) ||
        attestation.artifactKind !== "v0_8_aligned_96h_v1_worker_attestation" ||
        !("versionProfile" in attestation) ||
        !("nonfightBindingSha256" in attestation) ||
        attestation.nonfightBindingSha256 !== validated.nonfightBindingSha256
    ) {
        throw new Error("v0.8 aligned worker attestation omits its exact version marker");
    }
    assertAligned96hVersionProfile(attestation.versionProfile, V08_ALIGNED_96H_V1_VERSION_PROFILE);
    return attestation as Aligned96hWorkerAttestation<Binding>;
}

function attestationMatchesAligned96hVersion(
    binding: Aligned96hCandidateBinding,
    attestation: IV07AlignedV2WorkerAttestation | IV08AlignedV1WorkerAttestation,
): boolean {
    try {
        validateAligned96hWorkerAttestation(binding, attestation);
        return true;
    } catch {
        return false;
    }
}

export function validateV08AlignedV1WorkerIpcPayload(
    binding: IV08AlignedV1CandidateBinding,
    record: IV08AlignedV1BattleRecord,
    observation: IV08AlignedV1GameObservation,
): void {
    const validated = validateV08AlignedV1CandidateBinding(binding);
    if (
        record.artifactKind !== "v0_8_aligned_96h_v1_battle_record" ||
        record.nonfightBindingSha256 !== validated.nonfightBindingSha256 ||
        record.gridType !== gridTypeV08AlignedV1(record.scenarioOrdinal) ||
        record.scenarioOrdinal !== observation.scenarioOrdinal ||
        record.gridType !== observation.gridType
    ) {
        throw new Error("v0.8 worker record changed its exact profile, map, or non-fight binding");
    }
    assertAligned96hVersionProfile(record.versionProfile, V08_ALIGNED_96H_V1_VERSION_PROFILE);
    validateV08AlignedV1GameObservation(observation, "v0.8 worker observation");
}

function decodeUtf8Exact(bytes: Buffer, label: string): string {
    let decoded: string;
    try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        throw new Error(`${label} is not valid UTF-8`);
    }
    if (!Buffer.from(decoded, "utf8").equals(bytes)) throw new Error(`${label} is not canonical UTF-8`);
    return decoded;
}

export function alignedV2WorkerBaseEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
    const forbidden = new Set<string>(V07_ALIGNED_V2_FORBIDDEN_RUNTIME_ENV);
    const exact = new Set<string>(V07_ALIGNED_V2_BEHAVIOR_ENV_EXACT);
    const environment = Object.fromEntries(
        Object.entries(source).filter(
            (entry): entry is [string, string] =>
                entry[1] !== undefined &&
                !forbidden.has(entry[0]) &&
                !exact.has(entry[0]) &&
                !entry[0].startsWith("V08_") &&
                !V07_ALIGNED_V2_BEHAVIOR_ENV_PREFIXES.some((prefix) => entry[0].startsWith(prefix)),
        ),
    );
    environment.BUN_RUNTIME_TRANSPILER_CACHE_PATH = "0";
    return environment;
}

function validateShardRequest<Binding extends Aligned96hCandidateBinding>(
    options: IAligned96hShardEvaluationOptions<Binding>,
): IV07AlignedV2ExecutionTask[] {
    validateV07AlignedV2CheckpointShardSpec(options.shard);
    const binding = validateAligned96hCandidateBinding(options.binding);
    if (!Number.isSafeInteger(options.workers) || options.workers < 1) {
        throw new RangeError("aligned v2 shard workers must be a positive integer");
    }
    if (!options.auditDirectory.trim()) throw new Error("aligned v2 auditDirectory must not be empty");
    if (
        options.deadlineAtMs !== undefined &&
        (!Number.isSafeInteger(options.deadlineAtMs) || options.deadlineAtMs < 0)
    ) {
        throw new Error("aligned v2 shard deadlineAtMs must be a nonnegative safe integer");
    }
    const expectedShards =
        binding.candidate === "v0.8s"
            ? buildAligned96hCheckpointShardSpecs({
                  runFingerprint: options.shard.runFingerprint,
                  seedPlan: options.seedPlan,
                  binding,
                  maxScenarioPairsPerShard: options.shard.maxScenarioPairsPerShard,
              })
            : buildV07AlignedV2CheckpointShardSpecs({
                  runFingerprint: options.shard.runFingerprint,
                  seedPlan: options.seedPlan,
                  binding,
                  maxScenarioPairsPerShard: options.shard.maxScenarioPairsPerShard,
              });
    const expectedShard = expectedShards[options.shard.shardIndex];
    if (!expectedShard || canonicalV07AlignedV2Json(expectedShard) !== canonicalV07AlignedV2Json(options.shard)) {
        throw new Error("aligned v2 shard is not the deterministic partition of its exact injected seed plan");
    }
    return flattenV07AlignedV2SeedPlan(options.seedPlan).slice(
        options.shard.pairStart * 2,
        options.shard.pairEndExclusive * 2,
    );
}

export function snapshotV07AlignedV2ShardEvaluationOptions<Binding extends Aligned96hCandidateBinding>(
    options: IAligned96hShardEvaluationOptions<Binding>,
): IAligned96hShardEvaluationOptions<Binding> & { sourceEnvironment: NodeJS.ProcessEnv } {
    const sourceEnvironment = options.sourceEnvironment ?? process.env;
    return {
        shard: structuredClone(options.shard),
        seedPlan: structuredClone(options.seedPlan),
        binding: structuredClone(options.binding),
        workers: options.workers,
        auditDirectory: options.auditDirectory,
        sourceEnvironment: Object.fromEntries(Object.entries(sourceEnvironment)),
        deadlineAtMs: options.deadlineAtMs,
        onWorkerStarted: options.onWorkerStarted,
    };
}

/**
 * Execute one already-preregistered shard. This function never derives seeds and
 * has no CLI entry point; callers must inject the complete validated seed plan.
 */
export async function evaluateV07AlignedV2Shard<Binding extends Aligned96hCandidateBinding>(
    options: IAligned96hShardEvaluationOptions<Binding>,
): Promise<IAligned96hShardEvaluation<Binding>> {
    const input = snapshotV07AlignedV2ShardEvaluationOptions(options);
    const tasks = validateShardRequest(input);
    await mkdir(input.auditDirectory, { recursive: true });
    const workerCount = Math.min(input.workers, tasks.length);
    const workers = new Set<ChildProcess>();
    const records = new Map<string, IAligned96hBattleRecord<Binding>>();
    const observations = new Map<string, IV07AlignedV2GameObservation>();
    const expectedTasks = new Map(tasks.map((task) => [v07AlignedV2TaskKey(task), task]));
    const attestations: Aligned96hWorkerAttestation<Binding>[] = [];
    const workerTaskKeys = new Map<number, string[]>();
    const readyWorkers = new Set<ChildProcess>();
    const stoppingWorkers = new Set<ChildProcess>();
    let cursor = 0;
    let settled = false;
    let poolStarted = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    let cleanupPromise: Promise<void> | null = null;
    let cleanupExitCheck: (() => void) | null = null;

    return new Promise<IAligned96hShardEvaluation<Binding>>((resolvePromise, rejectPromise) => {
        const cleanup = (): Promise<void> => {
            if (cleanupPromise) return cleanupPromise;
            if (deadlineTimer !== null) clearTimeout(deadlineTimer);
            deadlineTimer = null;
            cleanupPromise = new Promise<void>((resolveCleanup, rejectCleanup) => {
                let sigtermTimeout: ReturnType<typeof setTimeout> | null = null;
                let exitTimeout: ReturnType<typeof setTimeout> | null = null;
                const gracefulTimeout = setTimeout(() => {
                    for (const worker of workers) worker.kill("SIGTERM");
                    sigtermTimeout = setTimeout(() => {
                        for (const worker of workers) worker.kill("SIGKILL");
                        exitTimeout = setTimeout(() => {
                            cleanupExitCheck = null;
                            rejectCleanup(
                                new Error(
                                    `aligned v2 worker cleanup exceeded ${WORKER_CLEANUP_TIMEOUT_MS}ms (${workers.size} survivor(s))`,
                                ),
                            );
                        }, WORKER_EXIT_TIMEOUT_MS);
                    }, WORKER_SIGTERM_TIMEOUT_MS);
                }, WORKER_GRACEFUL_STOP_TIMEOUT_MS);
                cleanupExitCheck = () => {
                    if (workers.size > 0) return;
                    clearTimeout(gracefulTimeout);
                    if (sigtermTimeout !== null) clearTimeout(sigtermTimeout);
                    if (exitTimeout !== null) clearTimeout(exitTimeout);
                    cleanupExitCheck = null;
                    resolveCleanup();
                };
                for (const worker of workers) {
                    if (!stoppingWorkers.has(worker)) {
                        stoppingWorkers.add(worker);
                        try {
                            if (worker.connected && worker.send) worker.send({ type: "stop" });
                            else worker.kill("SIGTERM");
                        } catch {
                            worker.kill("SIGTERM");
                        }
                    }
                }
                cleanupExitCheck();
            });
            return cleanupPromise;
        };
        const fail = (error: unknown): void => {
            if (settled) return;
            settled = true;
            const failure = error instanceof Error ? error : new Error(String(error));
            void cleanup().then(
                () => rejectPromise(failure),
                (cleanupError) => rejectPromise(new Error(`${failure.message}; ${String(cleanupError)}`)),
            );
        };
        const dispatch = (worker: ChildProcess): void => {
            if (!worker.connected || !worker.send) {
                fail(new Error("aligned v2 worker IPC channel closed before dispatch"));
                return;
            }
            if (cursor >= tasks.length) {
                stoppingWorkers.add(worker);
                worker.send({ type: "stop" });
                return;
            }
            worker.send({ type: "evaluate", task: tasks[cursor] });
            cursor += 1;
        };
        if (input.deadlineAtMs !== undefined) {
            const remainingMs = input.deadlineAtMs - Date.now();
            if (remainingMs <= 0) {
                fail(new Error("aligned v2 shard reached its immutable phase deadline before worker start"));
                return;
            }
            deadlineTimer = setTimeout(
                () => fail(new Error("aligned v2 shard reached its immutable phase deadline")),
                remainingMs,
            );
        }
        const finish = (): void => {
            if (records.size !== tasks.length || observations.size !== tasks.length || settled) return;
            settled = true;
            try {
                const orderedRecords = tasks.map((task) => records.get(v07AlignedV2TaskKey(task))!);
                const orderedObservations = tasks.map((task) => observations.get(v07AlignedV2TaskKey(task))!);
                const checkpoint = createV07AlignedV2Checkpoint(input.shard, orderedObservations);
                const orderedAttestations = attestations.sort((left, right) => left.workerIndex - right.workerIndex);
                const auditArtifacts = orderedAttestations.map((attestation): IV07AlignedV2WorkerAuditArtifact => {
                    const bytes = readFileSync(attestation.auditPath);
                    const contents = decodeUtf8Exact(bytes, `worker ${attestation.workerIndex} audit`);
                    const parsed = readV07AlignedV2AuditAppend(attestation.auditPath, 0);
                    const taskKeys = [...(workerTaskKeys.get(attestation.workerIndex) ?? [])];
                    const expectedRows = input.binding.searchEnabled ? taskKeys.length : 0;
                    if (parsed.rows.length !== expectedRows) {
                        throw new Error(
                            `aligned v2 worker ${attestation.workerIndex} audit rows ${parsed.rows.length} != assigned tasks ${expectedRows}`,
                        );
                    }
                    return {
                        workerIndex: attestation.workerIndex,
                        sourcePath: attestation.auditPath,
                        taskKeys,
                        contents,
                        contentsSha256: createHash("sha256").update(bytes).digest("hex"),
                        bytes: bytes.byteLength,
                        rows: parsed.rows.length,
                    };
                });
                const result: IAligned96hShardEvaluation<Binding> = {
                    shard: input.shard,
                    binding: input.binding,
                    checkpoint,
                    records: orderedRecords,
                    attestations: orderedAttestations,
                    auditArtifacts,
                };
                void cleanup().then(
                    () => resolvePromise(result),
                    (cleanupError) => rejectPromise(cleanupError),
                );
            } catch (error) {
                const failure = error instanceof Error ? error : new Error(String(error));
                void cleanup().then(
                    () => rejectPromise(failure),
                    (cleanupError) => rejectPromise(new Error(`${failure.message}; ${String(cleanupError)}`)),
                );
            }
        };

        for (let workerIndex = 0; workerIndex < workerCount; workerIndex += 1) {
            const auditPath = resolve(
                input.auditDirectory,
                `shard-${input.shard.shardIndex}-worker-${workerIndex}.jsonl`,
            );
            const validatedBinding = validateAligned96hCandidateBinding(input.binding);
            const behaviorEnvironment = buildAligned96hCandidateEnvironment(validatedBinding, auditPath);
            const environmentSha256 = fingerprintAligned96h(validatedBinding, behaviorEnvironment);
            const expectedRemovedEnvironmentKeys = Object.keys(behaviorEnvironment).sort();
            const environment = {
                ...alignedV2WorkerBaseEnvironment(input.sourceEnvironment),
                ...behaviorEnvironment,
            };
            let worker: ChildProcess;
            try {
                worker = spawn(
                    process.execPath,
                    [fileURLToPath(new URL("./v0_7_aligned_96h_v2_worker.ts", import.meta.url))],
                    {
                        env: environment,
                        detached: false,
                        serialization: "json",
                        stdio: ["ignore", "ignore", "inherit", "ipc"],
                    },
                );
            } catch (error) {
                fail(error);
                return;
            }
            workers.add(worker);
            worker.on(
                "message",
                (message: {
                    type: "ready" | "result" | "error" | "stopped";
                    attestation?: IV07AlignedV2WorkerAttestation | IV08AlignedV1WorkerAttestation;
                    taskKey?: string;
                    record?: IAligned96hBattleRecord<Binding>;
                    observation?: IV07AlignedV2GameObservation;
                    error?: string;
                }) => {
                    if (message.type === "stopped") {
                        if (!stoppingWorkers.has(worker)) {
                            fail(new Error("aligned v2 worker stopped without a parent request"));
                            return;
                        }
                        return;
                    }
                    if (settled) return;
                    if (message.type === "error") {
                        fail(new Error(message.error ?? "aligned v2 worker failed without an error message"));
                        return;
                    }
                    if (message.type === "ready") {
                        if (!message.attestation || readyWorkers.has(worker)) {
                            fail(new Error("aligned v2 worker omitted or duplicated its attestation"));
                            return;
                        }
                        if (
                            message.attestation.workerIndex !== workerIndex ||
                            message.attestation.runFingerprint !== input.shard.runFingerprint ||
                            message.attestation.genomeSha256 !== input.shard.genomeSha256 ||
                            message.attestation.behaviorEnvironmentSha256 !== input.shard.behaviorEnvironmentSha256 ||
                            message.attestation.environmentSha256 !== environmentSha256 ||
                            canonicalAligned96hJson(validatedBinding, message.attestation.removedEnvironmentKeys) !==
                                canonicalAligned96hJson(validatedBinding, expectedRemovedEnvironmentKeys) ||
                            message.attestation.transpilerCacheDisabled !== "0" ||
                            message.attestation.auditPath !== auditPath ||
                            !attestationMatchesAligned96hVersion(validatedBinding, message.attestation)
                        ) {
                            fail(new Error("aligned v2 worker attestation does not match its shard"));
                            return;
                        }
                        attestations.push(message.attestation as Aligned96hWorkerAttestation<Binding>);
                        readyWorkers.add(worker);
                        if (readyWorkers.size === workerCount) {
                            poolStarted = true;
                            for (const readyWorker of readyWorkers) dispatch(readyWorker);
                        }
                        return;
                    }
                    const expectedTask = message.taskKey ? expectedTasks.get(message.taskKey) : undefined;
                    if (input.binding.candidate === "v0.8s" && message.record && message.observation) {
                        try {
                            validateV08AlignedV1WorkerIpcPayload(
                                input.binding as IV08AlignedV1CandidateBinding,
                                message.record as IV08AlignedV1BattleRecord,
                                message.observation as IV08AlignedV1GameObservation,
                            );
                        } catch (error) {
                            fail(error);
                            return;
                        }
                    }
                    if (
                        !poolStarted ||
                        !readyWorkers.has(worker) ||
                        !message.taskKey ||
                        !message.record ||
                        !message.observation ||
                        !expectedTask ||
                        records.has(message.taskKey) ||
                        message.record.taskKey !== message.taskKey ||
                        message.record.panelId !== expectedTask.panelId ||
                        message.record.cellId !== expectedTask.cellId ||
                        message.record.scenarioOrdinal !== expectedTask.scenarioOrdinal ||
                        message.record.scenarioId !== expectedTask.scenarioId ||
                        message.record.candidateSeat !== expectedTask.candidateSeat ||
                        message.record.combatSeed !== expectedTask.combatSeed ||
                        message.observation.cellId !== expectedTask.cellId ||
                        message.observation.scenarioId !== expectedTask.scenarioId ||
                        message.observation.candidateSeat !== expectedTask.candidateSeat ||
                        (input.binding.candidate === "v0.8s" &&
                            ((message.observation as IV08AlignedV1GameObservation).scenarioOrdinal !==
                                expectedTask.scenarioOrdinal ||
                                (message.observation as IV08AlignedV1GameObservation).gridType !==
                                    gridTypeV08AlignedV1(expectedTask.scenarioOrdinal)))
                    ) {
                        fail(new Error("aligned v2 worker returned a missing or duplicate result"));
                        return;
                    }
                    records.set(message.taskKey, message.record);
                    observations.set(message.taskKey, message.observation);
                    const taskKeys = workerTaskKeys.get(workerIndex) ?? [];
                    taskKeys.push(message.taskKey);
                    workerTaskKeys.set(workerIndex, taskKeys);
                    if (records.size === tasks.length) finish();
                    else dispatch(worker);
                },
            );
            worker.on("error", fail);
            worker.on("disconnect", () => {
                if (!settled && !stoppingWorkers.has(worker)) {
                    fail(new Error("aligned v2 worker IPC channel disconnected unexpectedly"));
                }
            });
            worker.on("exit", (code, signal) => {
                workers.delete(worker);
                cleanupExitCheck?.();
                if (!settled && (code !== 0 || signal !== null || !stoppingWorkers.has(worker))) {
                    fail(new Error(`aligned v2 worker exited unexpectedly with code ${code} and signal ${signal}`));
                    return;
                }
                if (!settled && workers.size === 0 && records.size !== tasks.length) {
                    fail(new Error("aligned v2 worker pool exited before completing its deterministic task set"));
                }
            });
            try {
                input.onWorkerStarted?.();
                if (!worker.connected || !worker.send) throw new Error("aligned v2 worker IPC failed to initialize");
                worker.send({
                    type: "initialize",
                    data: {
                        marker: aligned96hWorkerMarker(input.binding),
                        workerIndex,
                        runFingerprint: input.shard.runFingerprint,
                        auditPath,
                        binding: input.binding,
                        environment: behaviorEnvironment,
                        environmentSha256,
                    },
                });
            } catch (error) {
                worker.kill("SIGKILL");
                fail(error);
                return;
            }
        }
    });
}

export interface IV07AlignedV2PreflightReport {
    schemaVersion: 1;
    mode: "synthetic_no_seed_material";
    status: "research_only_no_bake";
    automaticBake: false;
    automaticDeploy: false;
    seedMaterialUsed: false;
    gamesExecuted: 0;
    binding: IV07AlignedV2CandidateBinding;
    dryRunConfigValid: true;
    rowsInjected: 2;
    aggregate: IV07AlignedV2Aggregate;
    checkpoint: IV07AlignedV2Checkpoint;
    checkpointReplayExact: true;
    fullGateExecuted: false;
}

function defaultPreflightGenome(): IV07AlignedV2CandidateGenome {
    return buildV07AlignedV2ProductionIncumbentGenome();
}

function syntheticPreflightRows(): IV07AlignedV2GameObservation[] {
    return (["candidate_green", "candidate_red"] as const).map((candidateSeat, index) => ({
        cellId: "ranked_mage",
        candidateSeat,
        scenarioId: "0",
        outcome: index === 0 ? "candidate_win" : "opponent_win",
        reachedArmageddon: false,
        candidateRejections: 0,
        opponentRejections: 0,
        searchAudit: {
            decisions: 10,
            searchedDecisions: 10,
            deadlineFallbacks: 0,
            illegalIncumbents: 0,
            circuitOpened: false,
            circuitSkippedDecisions: 0,
            msTotal: 1000,
        },
    }));
}

function preflightTasks(rows: readonly IV07AlignedV2GameObservation[], panelId: string): IV07AlignedV2TaskIdentity[] {
    if (rows.length !== 2) throw new Error("aligned v2 preflight accepts exactly two injected rows");
    const ordered = [...rows].sort(
        (left, right) =>
            (["candidate_green", "candidate_red"] as const).indexOf(left.candidateSeat) -
            (["candidate_green", "candidate_red"] as const).indexOf(right.candidateSeat),
    );
    if (
        ordered[0].cellId !== ordered[1].cellId ||
        ordered[0].scenarioId !== ordered[1].scenarioId ||
        ordered[0].candidateSeat !== "candidate_green" ||
        ordered[1].candidateSeat !== "candidate_red"
    ) {
        throw new Error("aligned v2 preflight rows must be both seats of one synthetic scenario");
    }
    return ordered.map((row) => v07AlignedV2TaskIdentity(row, panelId));
}

/** Pure/inert preflight. It executes no match and accepts no seed-bearing structure. */
export function preflightV07AlignedV2(
    options: {
        genome?: IV07AlignedV2CandidateGenome;
        injectedRows?: readonly IV07AlignedV2GameObservation[];
    } = {},
): IV07AlignedV2PreflightReport {
    const dryRunValidation = validateV07AlignedV2DryRunConfig(defaultV07AlignedV2DryRunConfig());
    if (!dryRunValidation.valid)
        throw new Error(`aligned v2 default dry-run config failed: ${dryRunValidation.errors.join("; ")}`);
    const binding = bindV07AlignedV2Candidate(options.genome ?? defaultPreflightGenome());
    if (!binding.searchEnabled) throw new Error("aligned v2 preflight requires a search-enabled candidate genome");
    const rows = [...(options.injectedRows ?? syntheticPreflightRows())];
    const panelId = "synthetic-preflight-no-seeds";
    const tasks = preflightTasks(rows, panelId);
    const runFingerprint = fingerprintV07AlignedV2({
        kind: "v0_7_aligned_96h_v2_preflight",
        binding: binding.behaviorEnvironmentSha256,
        panelId,
        tasks,
    });
    const [shard] = buildV07AlignedV2SyntheticPreflightShardSpecs({
        runFingerprint,
        panelId,
        binding,
        tasks,
        maxScenarioPairsPerShard: 1,
    });
    const orderedRows = shard.tasks.map((task) =>
        rows.find(
            (row) =>
                row.cellId === task.cellId &&
                row.candidateSeat === task.candidateSeat &&
                row.scenarioId === task.scenarioId,
        ),
    );
    if (orderedRows.some((row) => row === undefined)) throw new Error("aligned v2 preflight row/task join failed");
    const checkpoint = createV07AlignedV2Checkpoint(shard, orderedRows as IV07AlignedV2GameObservation[]);
    const aggregate = aggregateV07AlignedV2(rows);
    if (
        canonicalV07AlignedV2Json(createV07AlignedV2Checkpoint(shard, checkpoint.observations)) !==
        canonicalV07AlignedV2Json(checkpoint)
    ) {
        throw new Error("aligned v2 preflight checkpoint replay is not exact");
    }
    return {
        schemaVersion: 1,
        mode: "synthetic_no_seed_material",
        status: "research_only_no_bake",
        automaticBake: false,
        automaticDeploy: false,
        seedMaterialUsed: false,
        gamesExecuted: 0,
        binding,
        dryRunConfigValid: true,
        rowsInjected: 2,
        aggregate,
        checkpoint,
        checkpointReplayExact: true,
        fullGateExecuted: false,
    };
}

export interface IV07AlignedV2PreflightCliOptions {
    dryRun: true;
    injectedRowsPath: string | null;
    genomePath: string | null;
}

export function parseV07AlignedV2PreflightArgs(argv: string[], cwd = process.cwd()): IV07AlignedV2PreflightCliOptions {
    const { values } = parseArgs({
        args: argv,
        strict: true,
        allowPositionals: false,
        options: {
            "dry-run": { type: "boolean", default: false },
            preflight: { type: "boolean", default: false },
            "inject-two-game-rows": { type: "string" },
            genome: { type: "string" },
        },
    });
    if (!values["dry-run"] && !values.preflight) {
        throw new Error("aligned v2 evaluator currently permits only --dry-run or --preflight");
    }
    return {
        dryRun: true,
        injectedRowsPath: values["inject-two-game-rows"] ? resolve(cwd, values["inject-two-game-rows"]) : null,
        genomePath: values.genome ? resolve(cwd, values.genome) : null,
    };
}

export async function mainV07AlignedV2Preflight(argv = process.argv.slice(2)): Promise<void> {
    const options = parseV07AlignedV2PreflightArgs(argv);
    const injectedRows = options.injectedRowsPath
        ? (JSON.parse(
              decodeUtf8Exact(readFileSync(options.injectedRowsPath), "aligned v2 injected rows"),
          ) as IV07AlignedV2GameObservation[])
        : undefined;
    const genome = options.genomePath
        ? (JSON.parse(
              decodeUtf8Exact(readFileSync(options.genomePath), "aligned v2 injected genome"),
          ) as IV07AlignedV2CandidateGenome)
        : undefined;
    const report = preflightV07AlignedV2({ genome, injectedRows });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (import.meta.main) await mainV07AlignedV2Preflight();
