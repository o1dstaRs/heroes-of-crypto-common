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

import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
    buildV09AuditedActorPhysicalCorePolicy,
    buildV09CampaignManifest,
    buildV09Checkpoint,
    buildV09SeedLedger,
    initializeV09Campaign,
    readV09Checkpoint,
    v09CampaignRunFingerprint,
    writeV09Checkpoint,
    V09_ACTOR_LANE_EVIDENCE_FILE,
    V09_DEFAULT_SEED_COUNTS,
    V09_RTX5090_GPU_UUID,
    type IV09CampaignManifest,
    type IV09SeedLedger,
    type V09CampaignStage,
} from "./campaign";
import {
    validateV09ActorLaneBenchmarkReceipt,
    type IV09ActorLaneBenchmarkReceipt,
} from "./actor_lane_benchmark_receipt";
import { discoverV09ActorCpuTopology, type IV09ActorCpuTopology } from "./actor_cpu_topology";
import { fingerprintV09 } from "./protocol";
import { verifyV09SourceIdentity, writeV09SourceIdentity, type IV09SourceIdentityReceipt } from "./source_identity";

export const V09_SUPERVISOR_SCHEMA = "hoc.ai.v0_9_supervisor.v1" as const;
export const V09_V08_PROTECTION_SCHEMA = "hoc.ai.v0_9_v08_protection.v1" as const;
export const V09_ARCHITECTURE_CANDIDATES = Object.freeze([
    Object.freeze([64, 32]),
    Object.freeze([96, 48]),
    Object.freeze([128, 64, 32]),
] as const);
export const V09_GPU_EVIDENCE_POLICY = Object.freeze({
    sampleIntervalSeconds: 2,
    minimumSamples: 12,
    minimumSteadySamples: 9,
    minimumMeanUtilization: 1,
    minimumP95Utilization: 10,
    minimumPeakUtilization: 20,
    activeUtilizationThreshold: 10,
    minimumActiveSampleFraction: 0.05,
    minimumPeakMemoryMiB: 128,
    minimumThroughputSamples: 5,
    minimumMedianToP95ThroughputRatio: 0.1,
    minimumLatestToMedianThroughputRatio: 0.1,
} as const);

export interface IV09GpuTelemetrySample {
    at: string;
    utilization: number;
    memoryMiB: number;
    temperatureC: number;
}

export interface IV09LearnerHardwareEvidence {
    gpuUuid: typeof V09_RTX5090_GPU_UUID;
    policy: typeof V09_GPU_EVIDENCE_POLICY;
    samples: number;
    discardedWarmupAndTeardownSamples: number;
    steadySamples: number;
    meanUtilization: number;
    medianUtilization: number;
    p95Utilization: number;
    peakUtilization: number;
    activeSampleFraction: number;
    peakMemoryMiB: number;
    peakTemperatureC: number;
    examplesPerSecond: {
        samples: number;
        mean: number;
        median: number;
        p95: number;
        latest: number;
        medianToP95Ratio: number;
        latestToMedianRatio: number;
    };
    failures: string[];
    satisfied: boolean;
}

export interface IV09V08ProtectionReceipt {
    schema: typeof V09_V08_PROTECTION_SCHEMA;
    runFingerprint: string;
    manifestSha256: string;
    protectedRoots: string[];
    policy: "v0.9_gpu_host_paths_isolated_v0.8_runs_on_separate_cpu_hosts";
    receiptSha256: string;
}

export interface IV09LearnerLaunch {
    executable: string;
    argv: string[];
    environment: {
        CUDA_VISIBLE_DEVICES: string;
        PYTHONDONTWRITEBYTECODE: "1";
        PYTHONUNBUFFERED: "1";
        V09_RUN_FINGERPRINT: string;
    };
}

export const V09_PYTHON_ENVIRONMENT = Object.freeze({
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONUNBUFFERED: "1",
} as const);

const stageExpectedUnits = (stage: V09CampaignStage): number => {
    switch (stage) {
        case "wide_teacher":
            return V09_DEFAULT_SEED_COUNTS.wide_teacher_train + V09_DEFAULT_SEED_COUNTS.wide_teacher_validation;
        case "dagger_1":
            return V09_DEFAULT_SEED_COUNTS.dagger_1_train + V09_DEFAULT_SEED_COUNTS.dagger_1_validation;
        case "dagger_2":
            return V09_DEFAULT_SEED_COUNTS.dagger_2_train + V09_DEFAULT_SEED_COUNTS.dagger_2_validation;
        case "confirmation":
            return V09_DEFAULT_SEED_COUNTS.confirmation;
        case "qualification":
            return V09_DEFAULT_SEED_COUNTS.qualification;
        default:
            return 1;
    }
};

/**
 * Resolve every existing path component through the filesystem while retaining a not-yet-created suffix.
 *
 * `path.resolve()` is only lexical. On its own, an intermediate symlink could make a seemingly isolated
 * campaign path land inside a protected v0.8 directory.
 */
export function canonicalV09PathThroughExistingAncestor(path: string): string {
    let existing = resolve(path);
    const missing: string[] = [];
    while (lstatSync(existing, { throwIfNoEntry: false }) === undefined) {
        const parent = dirname(existing);
        if (parent === existing) throw new Error(`v0.9 path has no existing ancestor: ${path}`);
        missing.unshift(basename(existing));
        existing = parent;
    }
    // Unlike existsSync, lstat sees a dangling link. realpath then rejects it instead of treating the link as a
    // safe missing suffix whose target could appear after validation.
    return missing.reduce((parent, segment) => resolve(parent, segment), realpathSync(existing));
}

export function assertV09OutputIsolation(outputDirectory: string, v08Roots: readonly string[]): string {
    const output = canonicalV09PathThroughExistingAncestor(outputDirectory);
    for (const rawRoot of v08Roots) {
        const root = canonicalV09PathThroughExistingAncestor(rawRoot);
        const fromRoot = relative(root, output);
        const fromOutput = relative(output, root);
        if (
            output === root ||
            (!fromRoot.startsWith("..") && !isAbsolute(fromRoot)) ||
            (!fromOutput.startsWith("..") && !isAbsolute(fromOutput))
        ) {
            throw new Error(`v0.9 output ${output} overlaps protected v0.8 root ${root}`);
        }
    }
    return output;
}

const quantile = (values: readonly number[], percentile: number): number => {
    if (!values.length) return 0;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor((sorted.length - 1) * percentile)]!;
};

/**
 * The v0.9 ranker is intentionally tiny, so nvidia-smi observes short bursts separated by JSONL input work.
 * This gate proves the pinned device did real work and that end-to-end learner throughput remained useful and
 * stable; it deliberately does not claim that a 5090 should sustain datacenter-style 50% median utilization.
 */
export function assessV09LearnerHardwareEvidence(
    rawSamples: readonly IV09GpuTelemetrySample[],
    rawExamplesPerSecond: readonly number[],
): IV09LearnerHardwareEvidence {
    const samples = rawSamples.filter(
        (sample) =>
            typeof sample.at === "string" &&
            Number.isFinite(sample.utilization) &&
            sample.utilization >= 0 &&
            sample.utilization <= 100 &&
            Number.isFinite(sample.memoryMiB) &&
            sample.memoryMiB >= 0 &&
            Number.isFinite(sample.temperatureC),
    );
    const throughput = rawExamplesPerSecond.filter((value) => Number.isFinite(value) && value > 0);
    const steady = samples.length >= 4 ? samples.slice(2, -1) : samples;
    const utilization = steady.map((sample) => sample.utilization);
    const meanUtilization = utilization.reduce((sum, value) => sum + value, 0) / Math.max(1, utilization.length);
    const medianThroughput = quantile(throughput, 0.5);
    const p95Throughput = quantile(throughput, 0.95);
    const latestThroughput = throughput.at(-1) ?? 0;
    const summary: Omit<IV09LearnerHardwareEvidence, "failures" | "satisfied"> = {
        gpuUuid: V09_RTX5090_GPU_UUID,
        policy: V09_GPU_EVIDENCE_POLICY,
        samples: samples.length,
        discardedWarmupAndTeardownSamples: samples.length - steady.length,
        steadySamples: steady.length,
        meanUtilization,
        medianUtilization: quantile(utilization, 0.5),
        p95Utilization: quantile(utilization, 0.95),
        peakUtilization: utilization.length ? Math.max(...utilization) : 0,
        activeSampleFraction:
            utilization.filter((value) => value >= V09_GPU_EVIDENCE_POLICY.activeUtilizationThreshold).length /
            Math.max(1, utilization.length),
        peakMemoryMiB: steady.length ? Math.max(...steady.map((sample) => sample.memoryMiB)) : 0,
        peakTemperatureC: steady.length ? Math.max(...steady.map((sample) => sample.temperatureC)) : 0,
        examplesPerSecond: {
            samples: throughput.length,
            mean: throughput.reduce((sum, value) => sum + value, 0) / Math.max(1, throughput.length),
            median: medianThroughput,
            p95: p95Throughput,
            latest: latestThroughput,
            medianToP95Ratio: medianThroughput / Math.max(Number.EPSILON, p95Throughput),
            latestToMedianRatio: latestThroughput / Math.max(Number.EPSILON, medianThroughput),
        },
    };
    const failures: string[] = [];
    if (summary.samples < V09_GPU_EVIDENCE_POLICY.minimumSamples) failures.push("insufficient GPU telemetry samples");
    if (summary.steadySamples < V09_GPU_EVIDENCE_POLICY.minimumSteadySamples) {
        failures.push("insufficient steady-state GPU telemetry samples");
    }
    if (summary.meanUtilization < V09_GPU_EVIDENCE_POLICY.minimumMeanUtilization) {
        failures.push("mean GPU activity is below the bursty-ranker floor");
    }
    if (summary.p95Utilization < V09_GPU_EVIDENCE_POLICY.minimumP95Utilization) {
        failures.push("p95 GPU activity is below the bursty-ranker floor");
    }
    if (summary.peakUtilization < V09_GPU_EVIDENCE_POLICY.minimumPeakUtilization) {
        failures.push("peak GPU activity is below the bursty-ranker floor");
    }
    if (summary.activeSampleFraction < V09_GPU_EVIDENCE_POLICY.minimumActiveSampleFraction) {
        failures.push("GPU active-sample fraction is below the bursty-ranker floor");
    }
    if (summary.peakMemoryMiB < V09_GPU_EVIDENCE_POLICY.minimumPeakMemoryMiB) {
        failures.push("GPU memory evidence is below the learner floor");
    }
    if (summary.examplesPerSecond.samples < V09_GPU_EVIDENCE_POLICY.minimumThroughputSamples) {
        failures.push("insufficient learner throughput samples");
    }
    if (summary.examplesPerSecond.medianToP95Ratio < V09_GPU_EVIDENCE_POLICY.minimumMedianToP95ThroughputRatio) {
        failures.push("median learner throughput collapsed relative to p95");
    }
    if (summary.examplesPerSecond.latestToMedianRatio < V09_GPU_EVIDENCE_POLICY.minimumLatestToMedianThroughputRatio) {
        failures.push("latest learner throughput collapsed relative to its median");
    }
    return { ...summary, failures, satisfied: failures.length === 0 };
}

function normalizedProtectedV08Roots(rawRoots: readonly string[]): string[] {
    const requestedRoots = [...new Set(rawRoots.map((root) => resolve(root)))].sort();
    if (!requestedRoots.length) {
        throw new Error("v0.9 initialization requires at least one --protect-v08-root");
    }
    for (const root of requestedRoots) {
        if (!existsSync(root)) throw new Error(`protected v0.8 root does not exist: ${root}`);
        const stat = lstatSync(root);
        if (stat.isSymbolicLink()) throw new Error(`protected v0.8 root must not be a symlink: ${root}`);
        if (!stat.isDirectory()) throw new Error(`protected v0.8 root is not a directory: ${root}`);
    }
    return [...new Set(requestedRoots.map((root) => realpathSync(root)))].sort();
}

function validateV09V08ProtectionReceipt(
    campaignDirectory: string,
    manifest: IV09CampaignManifest,
    value: unknown,
): IV09V08ProtectionReceipt {
    if (!value || typeof value !== "object" || !Array.isArray((value as IV09V08ProtectionReceipt).protectedRoots)) {
        throw new Error("v0.9 protected-root receipt is malformed");
    }
    const receipt = value as IV09V08ProtectionReceipt;
    const { receiptSha256, ...unsigned } = receipt;
    if (
        receipt.schema !== V09_V08_PROTECTION_SCHEMA ||
        receipt.runFingerprint !== manifest.runFingerprint ||
        receipt.manifestSha256 !== manifest.manifestSha256 ||
        receipt.policy !== "v0.9_gpu_host_paths_isolated_v0.8_runs_on_separate_cpu_hosts" ||
        fingerprintV09(unsigned) !== receiptSha256
    ) {
        throw new Error("v0.9 protected-root receipt identity mismatch");
    }
    const normalized = normalizedProtectedV08Roots(receipt.protectedRoots);
    if (normalized.join("\n") !== receipt.protectedRoots.join("\n")) {
        throw new Error("v0.9 protected-root receipt is not normalized and unique");
    }
    assertV09OutputIsolation(campaignDirectory, normalized);
    return receipt;
}

export function writeV09V08ProtectionReceipt(
    campaignDirectory: string,
    manifest: IV09CampaignManifest,
    rawRoots: readonly string[],
): IV09V08ProtectionReceipt {
    const protectedRoots = normalizedProtectedV08Roots(rawRoots);
    assertV09OutputIsolation(campaignDirectory, protectedRoots);
    const unsigned = {
        schema: V09_V08_PROTECTION_SCHEMA,
        runFingerprint: manifest.runFingerprint,
        manifestSha256: manifest.manifestSha256,
        protectedRoots,
        policy: "v0.9_gpu_host_paths_isolated_v0.8_runs_on_separate_cpu_hosts" as const,
    };
    const receipt = { ...unsigned, receiptSha256: fingerprintV09(unsigned) };
    const path = resolve(campaignDirectory, "v08-protection.json");
    const acceptExactExisting = (): IV09V08ProtectionReceipt => {
        const existing = validateV09V08ProtectionReceipt(
            campaignDirectory,
            manifest,
            JSON.parse(readFileSync(path, "utf8")) as unknown,
        );
        if (fingerprintV09(existing) !== fingerprintV09(receipt)) {
            throw new Error("existing v0.9 protected-root receipt is not the exact requested protection");
        }
        return existing;
    };
    if (existsSync(path)) return acceptExactExisting();
    try {
        writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, {
            encoding: "utf8",
            flag: "wx",
        });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return acceptExactExisting();
        throw error;
    }
    return receipt;
}

export function bindV09ActorLaneBenchmarkToCampaign(
    value: unknown,
    sourceReceipt: IV09SourceIdentityReceipt,
    gpuUuid: string,
    topology: IV09ActorCpuTopology = discoverV09ActorCpuTopology(),
): {
    receipt: IV09ActorLaneBenchmarkReceipt;
    actorPhysicalCores: ReturnType<typeof buildV09AuditedActorPhysicalCorePolicy>;
} {
    const receipt = validateV09ActorLaneBenchmarkReceipt(value);
    if (!receipt.eligibleForCampaign || receipt.mode !== "production") {
        throw new Error("campaign initialization requires an eligible production actor-lane benchmark");
    }
    if (
        receipt.source.receiptSha256 !== sourceReceipt.receiptSha256 ||
        receipt.source.sourceCommit !== sourceReceipt.sourceCommit ||
        receipt.source.sourceStatusSha256 !== sourceReceipt.sourceStatusSha256 ||
        receipt.source.rulesFingerprint !== sourceReceipt.rulesFingerprint
    ) {
        throw new Error("actor-lane benchmark source identity does not match campaign source");
    }
    if (receipt.host.gpuUuid !== gpuUuid) {
        throw new Error("actor-lane benchmark GPU identity does not match campaign GPU");
    }
    if (
        receipt.host.topologySha256 !== topology.topologySha256 ||
        receipt.host.allowedLogicalCpuIds.join(",") !== topology.allowedLogicalCpuIds.join(",") ||
        receipt.host.physicalCpuIds.join(",") !== topology.physicalCpuIds.join(",") ||
        receipt.selection.selectedPhysicalCpuIds.some((cpu) => !topology.physicalCpuIds.includes(cpu))
    ) {
        throw new Error("actor-lane benchmark CPU topology does not match the current affinity");
    }
    return {
        receipt,
        actorPhysicalCores: buildV09AuditedActorPhysicalCorePolicy({
            benchmarkReceiptSha256: receipt.receiptSha256,
            benchmarkSourceReceiptSha256: receipt.source.receiptSha256,
            topologySha256: receipt.host.topologySha256,
            benchmarkPhysicalCoreCount: receipt.host.physicalCpuIds.length,
            selectedWorkers: receipt.selection.selectedWorkers,
            selectedPhysicalCpuIds: receipt.selection.selectedPhysicalCpuIds,
        }),
    };
}

export function writeV09ActorLaneBenchmarkEvidence(
    campaignDirectory: string,
    receipt: IV09ActorLaneBenchmarkReceipt,
): string {
    const validated = validateV09ActorLaneBenchmarkReceipt(receipt);
    if (!validated.eligibleForCampaign) {
        throw new Error("refusing to copy ineligible actor-lane benchmark evidence");
    }
    const path = resolve(campaignDirectory, V09_ACTOR_LANE_EVIDENCE_FILE);
    const acceptExactExisting = (): string => {
        const existing = validateV09ActorLaneBenchmarkReceipt(JSON.parse(readFileSync(path, "utf8")) as unknown);
        if (fingerprintV09(existing) !== fingerprintV09(validated)) {
            throw new Error("refusing incompatible actor-lane benchmark evidence resume");
        }
        return path;
    };
    if (existsSync(path)) return acceptExactExisting();
    try {
        writeFileSync(path, `${JSON.stringify(validated, null, 2)}\n`, {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
        });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return acceptExactExisting();
        throw error;
    }
    return path;
}

export function verifyV09V08ProtectionReceipt(
    campaignDirectory: string,
    manifest: IV09CampaignManifest,
): IV09V08ProtectionReceipt {
    return validateV09V08ProtectionReceipt(
        campaignDirectory,
        manifest,
        JSON.parse(readFileSync(resolve(campaignDirectory, "v08-protection.json"), "utf8")) as unknown,
    );
}

export function buildV09LearnerLaunch(
    manifest: IV09CampaignManifest,
    repositoryRoot: string,
    dataGlobs: readonly string[],
    options: {
        epochs?: number;
        qatEpochs?: number;
        batchSize?: number;
        workers?: number;
        hidden?: readonly number[];
        resume?: boolean;
        modelTag?: string;
        allowPartialCorpus?: boolean;
        minimumQatFixedAgreement?: number;
        maximumFixedAccuracyDrop?: number;
    } = {},
): IV09LearnerLaunch {
    if (!dataGlobs.length) throw new Error("v0.9 learner requires at least one IL-v4 data glob");
    const hidden = options.hidden ?? V09_ARCHITECTURE_CANDIDATES[0];
    if (!hidden.length || hidden.some((width) => !Number.isSafeInteger(width) || width < 1)) {
        throw new Error("v0.9 learner hidden widths must be positive integers");
    }
    const architectureId = hidden.join("x");
    const modelTag = options.modelTag ?? "initial";
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(modelTag)) throw new Error("v0.9 learner modelTag is invalid");
    const minimumQatFixedAgreement = options.minimumQatFixedAgreement ?? 0.99;
    const maximumFixedAccuracyDrop = options.maximumFixedAccuracyDrop ?? 0.01;
    if (
        !Number.isFinite(minimumQatFixedAgreement) ||
        minimumQatFixedAgreement < 0 ||
        minimumQatFixedAgreement > 1 ||
        !Number.isFinite(maximumFixedAccuracyDrop) ||
        maximumFixedAccuracyDrop < 0 ||
        maximumFixedAccuracyDrop > 1
    ) {
        throw new Error("v0.9 learner fixed-point gates must be finite ratios in [0, 1]");
    }
    const output = manifest.outputDirectory;
    const script = resolve(repositoryRoot, "src/simulation/v0_9/python/learner.py");
    const argv = [
        script,
        ...dataGlobs.flatMap((path) => ["--data", resolve(path)]),
        "--feature-contract",
        resolve(output, "feature-contract.json"),
        "--campaign-manifest",
        resolve(output, "manifest.json"),
        "--out",
        resolve(output, `models/v0.9-research-${modelTag}-h${architectureId}.json`),
        "--checkpoint",
        resolve(output, `checkpoints/learner-${modelTag}-h${architectureId}.pt`),
        "--epochs",
        String(options.epochs ?? 30),
        "--qat-epochs",
        String(options.qatEpochs ?? 5),
        "--batch-size",
        String(options.batchSize ?? 1024),
        "--workers",
        String(options.workers ?? 8),
        "--hidden",
        hidden.join(","),
        "--minimum-qat-fixed-agreement",
        String(minimumQatFixedAgreement),
        "--maximum-fixed-accuracy-drop",
        String(maximumFixedAccuracyDrop),
    ];
    if (options.resume) argv.push("--resume");
    if (options.allowPartialCorpus) argv.push("--allow-partial-corpus");
    return {
        executable: resolve(output, "venv/bin/python"),
        argv,
        environment: {
            CUDA_VISIBLE_DEVICES: manifest.identity.gpuUuid,
            ...V09_PYTHON_ENVIRONMENT,
            V09_RUN_FINGERPRINT: manifest.runFingerprint,
        },
    };
}

export interface IV09QualificationMetrics {
    combinedGames: number;
    confirmationGames: number;
    qualificationGames: number;
    combinedScore: number;
    confirmationScore: number;
    qualificationScore: number;
    lower95: number;
    minimumCellScore: number;
    /** Fraction of v0.9 head-to-head games that reached an Armageddon lap. */
    armageddonRate: number;
    /** Fraction of paired v0.8+a13 control games that reached an Armageddon lap. */
    v08ArmageddonRate: number;
    invalidActions: number;
    avoidablePassiveActions: number;
    p99ModelMs: number;
    p99TurnMs: number;
    rssIncreaseMiB: number;
}

export function validateV09QualificationMetrics(metrics: IV09QualificationMetrics): void {
    if (!metrics || typeof metrics !== "object") throw new Error("v0.9 qualification metrics are missing");
    const counts = [
        ["combinedGames", metrics.combinedGames],
        ["confirmationGames", metrics.confirmationGames],
        ["qualificationGames", metrics.qualificationGames],
        ["invalidActions", metrics.invalidActions],
        ["avoidablePassiveActions", metrics.avoidablePassiveActions],
    ] as const;
    for (const [name, value] of counts) {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new Error(`v0.9 qualification metric ${name} must be a non-negative integer`);
        }
    }
    if (metrics.combinedGames !== metrics.confirmationGames + metrics.qualificationGames) {
        throw new Error("v0.9 qualification game counts do not add up");
    }
    const rates = [
        ["combinedScore", metrics.combinedScore],
        ["confirmationScore", metrics.confirmationScore],
        ["qualificationScore", metrics.qualificationScore],
        ["lower95", metrics.lower95],
        ["minimumCellScore", metrics.minimumCellScore],
        ["armageddonRate", metrics.armageddonRate],
        ["v08ArmageddonRate", metrics.v08ArmageddonRate],
    ] as const;
    for (const [name, value] of rates) {
        if (!Number.isFinite(value) || value < 0 || value > 1) {
            throw new Error(`v0.9 qualification metric ${name} must be finite and within [0,1]`);
        }
    }
    for (const [name, value] of [
        ["p99ModelMs", metrics.p99ModelMs],
        ["p99TurnMs", metrics.p99TurnMs],
        ["rssIncreaseMiB", metrics.rssIncreaseMiB],
    ] as const) {
        if (!Number.isFinite(value) || value < 0) {
            throw new Error(`v0.9 qualification metric ${name} must be finite and non-negative`);
        }
    }
}

export function v09QualificationFailures(metrics: IV09QualificationMetrics): string[] {
    try {
        validateV09QualificationMetrics(metrics);
    } catch {
        return ["qualification metrics are missing, malformed, or internally inconsistent"];
    }
    const failures: string[] = [];
    if (metrics.combinedGames < 96_000) failures.push("combined qualification requires 96,000 games");
    if (metrics.confirmationGames < 48_000) failures.push("confirmation requires 48,000 games");
    if (metrics.qualificationGames < 48_000) failures.push("final qualification requires 48,000 games");
    if (metrics.combinedScore < 0.55) failures.push("combined score is below 55%");
    if (metrics.confirmationScore < 0.545) failures.push("confirmation score is below 54.5%");
    if (metrics.qualificationScore < 0.545) failures.push("qualification score is below 54.5%");
    if (metrics.lower95 <= 0.545) failures.push("combined 95% lower bound is not above 54.5%");
    if (metrics.minimumCellScore < 0.48) failures.push("a preregistered cell is below 48%");
    if (metrics.armageddonRate > 0.0005 || metrics.armageddonRate > metrics.v08ArmageddonRate) {
        failures.push("Armageddon non-inferiority failed");
    }
    if (metrics.invalidActions !== 0) failures.push("invalid/rejected action count is non-zero");
    if (metrics.avoidablePassiveActions !== 0) failures.push("avoidable passive action count is non-zero");
    // Node-local latency is informational here. The merged qualification layer applies the actual production
    // circuit-breaker headroom gate only to a production_cpu shard (p99 turn latency must be strictly <20ms).
    if (metrics.rssIncreaseMiB >= 64) failures.push("RSS increase is not below 64MiB");
    return failures;
}

function manifestAt(output: string): IV09CampaignManifest {
    return JSON.parse(readFileSync(resolve(output, "manifest.json"), "utf8")) as IV09CampaignManifest;
}

function ledgerAt(output: string): IV09SeedLedger {
    return JSON.parse(readFileSync(resolve(output, "seed-ledger.json"), "utf8")) as IV09SeedLedger;
}

function main(): void {
    const { positionals, values } = parseArgs({
        args: Bun.argv.slice(2),
        allowPositionals: true,
        options: {
            out: { type: "string" },
            stage: { type: "string" },
            completed: { type: "string" },
            artifact: { type: "string", multiple: true },
            data: { type: "string", multiple: true },
            hidden: { type: "string" },
            resume: { type: "boolean", default: false },
            "gpu-uuid": { type: "string" },
            "source-receipt": { type: "string" },
            "actor-lane-receipt": { type: "string" },
            repository: { type: "string", default: process.cwd() },
            "reserved-seeds": { type: "string" },
            "protect-v08-root": { type: "string", multiple: true },
        },
        strict: true,
    });
    const command = positionals[0];
    if (!command || !values.out) {
        throw new Error("usage: bun supervisor.ts <init|status|checkpoint|learner-command> --out <campaign>");
    }
    if (command === "init") {
        if (!values["gpu-uuid"] || !values["source-receipt"] || !values["actor-lane-receipt"]) {
            throw new Error(
                "init requires --gpu-uuid, a verified --source-receipt, and an eligible --actor-lane-receipt",
            );
        }
        const protectedRoots = normalizedProtectedV08Roots(values["protect-v08-root"] ?? []);
        const sourceReceipt = verifyV09SourceIdentity(
            JSON.parse(readFileSync(values["source-receipt"], "utf8")) as IV09SourceIdentityReceipt,
            values.repository,
        );
        const output = assertV09OutputIsolation(values.out, protectedRoots);
        const actorLane = bindV09ActorLaneBenchmarkToCampaign(
            JSON.parse(readFileSync(values["actor-lane-receipt"], "utf8")) as unknown,
            sourceReceipt,
            values["gpu-uuid"],
        );
        const identity = {
            sourceCommit: sourceReceipt.sourceCommit,
            sourceStatusSha256: sourceReceipt.sourceStatusSha256,
            sourceDirty: false as const,
            rulesFingerprint: sourceReceipt.rulesFingerprint,
            rosterFingerprint: sourceReceipt.rosterFingerprint,
            anchorVersion: "v0.8" as const,
            anchorFingerprint: sourceReceipt.anchorFingerprint,
            gpuUuid: values["gpu-uuid"],
        };
        const reserved = values["reserved-seeds"]
            ? (JSON.parse(readFileSync(values["reserved-seeds"], "utf8")) as number[])
            : [];
        if (!Array.isArray(reserved)) throw new Error("--reserved-seeds must be a JSON array of uint32 seeds");
        const ledger = buildV09SeedLedger(v09CampaignRunFingerprint(identity), reserved);
        const manifest = buildV09CampaignManifest(identity, output, ledger, actorLane.actorPhysicalCores);
        initializeV09Campaign(output, manifest, ledger);
        writeV09ActorLaneBenchmarkEvidence(output, actorLane.receipt);
        const sourceIdentityPath = resolve(output, "source-identity.json");
        if (existsSync(sourceIdentityPath)) {
            const existing = JSON.parse(readFileSync(sourceIdentityPath, "utf8")) as IV09SourceIdentityReceipt;
            if (fingerprintV09(existing) !== fingerprintV09(sourceReceipt)) {
                throw new Error("refusing incompatible v0.9 source-identity resume");
            }
        } else {
            writeV09SourceIdentity(sourceIdentityPath, sourceReceipt);
        }
        writeV09V08ProtectionReceipt(output, manifest, protectedRoots);
        const checkpointPath = resolve(output, "checkpoint.json");
        const existingCheckpoint = readV09Checkpoint(checkpointPath, manifest);
        if (existingCheckpoint) {
            const expectedCheckpoint = buildV09Checkpoint(
                manifest,
                "preflight",
                0,
                1,
                {},
                existingCheckpoint.updatedAt,
            );
            if (fingerprintV09(existingCheckpoint) !== fingerprintV09(expectedCheckpoint)) {
                throw new Error("refusing to reset a progressed v0.9 campaign during init resume");
            }
        } else {
            writeV09Checkpoint(checkpointPath, buildV09Checkpoint(manifest, "preflight", 0, 1));
        }
        process.stdout.write(
            `${JSON.stringify({ output, runFingerprint: manifest.runFingerprint, manifestSha256: manifest.manifestSha256 })}\n`,
        );
        return;
    }
    const manifest = manifestAt(values.out);
    const ledger = ledgerAt(values.out);
    if (ledger.runFingerprint !== manifest.runFingerprint || ledger.ledgerSha256 !== manifest.seedLedgerSha256) {
        throw new Error("v0.9 campaign manifest and seed ledger disagree");
    }
    const checkpointPath = resolve(values.out, "checkpoint.json");
    if (command === "status") {
        process.stdout.write(
            `${JSON.stringify({ manifest, checkpoint: readV09Checkpoint(checkpointPath, manifest) })}\n`,
        );
        return;
    }
    if (command === "checkpoint") {
        const stage = values.stage as V09CampaignStage | undefined;
        if (!stage) throw new Error("checkpoint requires --stage");
        const completed = Number(values.completed ?? stageExpectedUnits(stage));
        const artifacts = Object.fromEntries(
            (values.artifact ?? []).map((entry) => {
                const split = entry.indexOf("=");
                if (split <= 0) throw new Error("--artifact must use name=sha256");
                return [entry.slice(0, split), entry.slice(split + 1)];
            }),
        );
        const checkpoint = buildV09Checkpoint(manifest, stage, completed, stageExpectedUnits(stage), artifacts);
        writeV09Checkpoint(checkpointPath, checkpoint);
        process.stdout.write(`${JSON.stringify(checkpoint)}\n`);
        return;
    }
    if (command === "learner-command") {
        const launch = buildV09LearnerLaunch(manifest, process.cwd(), values.data ?? [], {
            hidden: values.hidden?.split(",").map(Number),
            resume: values.resume,
        });
        process.stdout.write(`${JSON.stringify(launch)}\n`);
        return;
    }
    throw new Error(`unknown v0.9 supervisor command ${command}`);
}

if (import.meta.main) main();
