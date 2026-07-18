/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 * -----------------------------------------------------------------------------
 */

import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
    chmodSync,
    closeSync,
    fsyncSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    readlinkSync,
    readdirSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
    deriveV07AlignedV2OrchestratorState,
    validateV07AlignedV2OrchestratorDefinition,
    type IV07AlignedV2OrchestratorDefinition,
    type IV07AlignedV2OrchestratorEvent,
    type IV07AlignedV2OrchestratorReplayResolvers,
    type IV07AlignedV2OrchestratorTerminal,
    type IV07AlignedV2SeedArtifactRef,
} from "./v0_7_aligned_96h_v2_orchestrator";
import { createV07AlignedV2FilesystemReplayResolvers } from "./v0_7_aligned_96h_v2_filesystem_resolvers";
import { canonicalV07AlignedV2Json, fingerprintV07AlignedV2 } from "./v0_7_aligned_96h_v2_protocol";
import {
    validateV07AlignedV2RunnerConfig,
    validateV07AlignedV2RunnerBudget,
    validateV07AlignedV2RunnerHeartbeat,
    validateV07AlignedV2ThroughputAttestation,
    type IV07AlignedV2RunnerBudgetReport,
    type IV07AlignedV2RunnerConfig,
    type IV07AlignedV2RunnerHeartbeat,
    type IV07AlignedV2ThroughputAttestation,
} from "./v0_7_aligned_96h_v2_runner";

const HOUR_MS = 3_600_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LINUX_BOOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LINUX_PID_NAMESPACE_PATTERN = /^pid:\[[1-9][0-9]*\]$/;
const DECIMAL_TICKS_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const ALIGNED_ENTRY_BASENAME = "v0_7_aligned_96h_v2_runner.ts";
const EXPECTED_ORIGIN = "github.com/o1dstars/heroes-of-crypto-common";

export type V07AlignedV2SupervisorStop = "terminal" | "deadline" | "signal" | "busy" | "invalid" | "quarantined";

export interface IV07AlignedV2LinuxProcessIdentity {
    platform: "linux";
    bootId: string;
    pidNamespace: string;
    pid: number;
    startTimeTicks: string;
    pgid: number;
    sid: number;
}

export type V07AlignedV2ProcessGroupProbe = "alive" | "absent" | "ambiguous";

export interface IV07AlignedV2SupervisorProvenance {
    schemaVersion: 1;
    commit: string;
    branch: "main";
    originMain: string;
    liveOriginMain: string;
    originUrl: string;
    originIdentity: string;
    cleanIncludingUntracked: true;
    statusPorcelainSha256: string;
    sourceTreeSha256: string;
    bunVersion: string;
    bunRevision: string;
    bunExecutableSha256: string;
    dependencyPackages: number;
    dependencyManifestSha256: string;
    lockfileSha256: string | null;
    provenanceSha256: string;
}

export interface IV07AlignedV2ComposedSealAttestation {
    manifestId: string;
    qualificationVerdict: "PASS" | "FAIL";
    sealedAt: string;
    sha256: string;
}

export interface IV07AlignedV2SupervisorConfig {
    outputDirectory: string;
    repositoryRoot: string;
    definitionPath: string;
    definitionSha256: string;
    composedSealPath: string;
    composedSealSha256: string;
    composedSealAttestation: IV07AlignedV2ComposedSealAttestation;
    runFingerprint: string;
    startAtMs: number;
    deadlineAtMs: number;
    optimizerEntry: string;
    optimizerEntrySha256: string;
    optimizerArgs: readonly string[];
    runnerConfigPath: string;
    runnerConfigSha256: string;
    runnerConfigBytesSha256: string;
    rateAttestationPath: string;
    rateAttestationSha256: string;
    rateAttestationBytesSha256: string;
    preparedBundlePath: string;
    preparedBundleSha256: string;
    preparedBundleBytesSha256: string;
    heartbeatIntervalMs: number;
    runnerStartupWatchdogMs: number;
    runnerProgressWatchdogMs: number;
    hostProbeIntervalMs: number;
    watchdogMs: number;
    hostProbeTimeoutMs: number;
    restartBaseMs: number;
    restartMaxMs: number;
    maxRestarts: number;
    stopGraceMs: number;
    minimumIdleCpus: number;
    niceLevel: number;
    provenance: IV07AlignedV2SupervisorProvenance;
}

export interface IV07AlignedV2HostAssessment {
    schemaVersion: 1;
    ok: boolean;
    reasons: string[];
    minimumIdleCpus: number;
    cpuCount?: number;
    idleCpus?: number;
    blockers?: unknown[];
    detail?: string;
}

export interface IV07AlignedV2OptimizerPoll {
    alive: boolean;
    exitCode: number | null;
}

export interface IV07AlignedV2OptimizerHandle {
    pid: number;
    pgid: number;
    activate(ownerToken: string): Promise<void> | void;
    poll(): Promise<IV07AlignedV2OptimizerPoll>;
    signalGroup(signal: NodeJS.Signals): Promise<void> | void;
}

export interface IV07AlignedV2SupervisorClock {
    nowMs(): number;
    sleep(milliseconds: number): Promise<void>;
    requestedSignal(): "SIGHUP" | "SIGINT" | "SIGTERM" | null;
}

export interface IV07AlignedV2SupervisorDependencies {
    clock: IV07AlignedV2SupervisorClock;
    processId: number;
    readProcessIdentity(pid: number): IV07AlignedV2LinuxProcessIdentity | null;
    probeProcessGroup(pgid: number): V07AlignedV2ProcessGroupProbe;
    captureProvenance(): Promise<IV07AlignedV2SupervisorProvenance> | IV07AlignedV2SupervisorProvenance;
    verifyImmutableInputs(): Promise<void> | void;
    probeHost(context: {
        attempt: number;
        childPgid: number | null;
        resetBaseline: boolean;
    }): Promise<IV07AlignedV2HostAssessment>;
    spawnOptimizer(attempt: number, ownerToken: string): Promise<IV07AlignedV2OptimizerHandle>;
    validateTerminal(onReplayProgress: () => void): IV07AlignedV2OrchestratorTerminal | null;
    readRunnerHeartbeat(): IV07AlignedV2RunnerHeartbeat | null;
    log(message: string): void;
}

export interface IV07AlignedV2SupervisorOutcome {
    stop: V07AlignedV2SupervisorStop;
    attempts: number;
    detail: string;
}

export interface IV07AlignedV2DurabilityFaultInjector {
    afterDurableStep(step: "file-fsync" | "rename" | "directory-fsync"): void;
}

interface ISelfHashedMarker {
    schemaVersion: 1;
    artifactKind: string;
    status: "research_only_no_bake";
    automaticBake: false;
    automaticDeploy: false;
    runFingerprint: string;
    atMs: number;
    reason: string;
    detail: string;
    markerSha256: string;
}

interface IArmedMarker {
    schemaVersion: 2;
    artifactKind: "v0_7_aligned_96h_v2_supervisor_armed";
    runFingerprint: string;
    ownerToken: string;
    supervisorPid: number;
    supervisorIdentity: IV07AlignedV2LinuxProcessIdentity | null;
    attempt: number;
    activationState: "pre_activation" | "activated";
    childPid: number | null;
    childPgid: number | null;
    childIdentity: IV07AlignedV2LinuxProcessIdentity | null;
    armedAtMs: number;
    armedSha256: string;
}

interface IOptimizerPidRecord {
    schemaVersion: 2;
    artifactKind: "v0_7_aligned_96h_v2_optimizer_pid";
    runFingerprint: string;
    attempt: number;
    pid: number;
    pgid: number;
    identity: IV07AlignedV2LinuxProcessIdentity | null;
    ownerToken: string;
    startedAtMs: number;
    pidRecordSha256: string;
}

interface ISupervisorRecoveryAudit {
    schemaVersion: 1;
    artifactKind: "v0_7_aligned_96h_v2_supervisor_recovery";
    status: "research_only_no_bake";
    automaticBake: false;
    automaticDeploy: false;
    runFingerprint: string;
    ownerToken: string;
    restoredAttempt: number;
    armedSha256: string;
    pidRecordSha256: string | null;
    observation: "different_boot" | "same_boot_absent";
    recoveredAtMs: number;
    recoverySha256: string;
}

interface ISupervisorRun {
    schemaVersion: 1;
    artifactKind: "v0_7_aligned_96h_v2_supervisor_run";
    status: "research_only_no_bake";
    automaticBake: false;
    automaticDeploy: false;
    runFingerprint: string;
    orchestratorDirectory: string;
    definition: { path: string; sha256: string };
    preparedBundle: { path: string; sha256: string; bytesSha256: string };
    composedSeal: {
        path: string;
        sha256: string;
        manifestId: string;
        qualificationVerdict: "PASS" | "FAIL";
        sealedAt: string;
    };
    schedule: { startAtMs: number; deadlineAtMs: number; durationHours: 96 };
    optimizer: {
        entry: string;
        sha256: string;
        args: readonly string[];
        runnerConfig: { path: string; sha256: string; bytesSha256: string };
        rateAttestation: { path: string; sha256: string; bytesSha256: string };
    };
    lifecycle: {
        heartbeatIntervalMs: number;
        runnerStartupWatchdogMs: number;
        runnerProgressWatchdogMs: number;
        hostProbeIntervalMs: number;
        watchdogMs: number;
        hostProbeTimeoutMs: number;
        restartBaseMs: number;
        restartMaxMs: number;
        maxRestarts: number;
        stopGraceMs: number;
        minimumIdleCpus: number;
        niceLevel: number;
    };
    provenance: IV07AlignedV2SupervisorProvenance;
    runSha256: string;
}

function sha256(value: string | Buffer): string {
    return createHash("sha256").update(value).digest("hex");
}

function immutableProvenance(
    value: IV07AlignedV2SupervisorProvenance,
): Omit<IV07AlignedV2SupervisorProvenance, "liveOriginMain" | "provenanceSha256"> {
    const immutable: Partial<IV07AlignedV2SupervisorProvenance> = { ...value };
    delete immutable.liveOriginMain;
    delete immutable.provenanceSha256;
    return immutable as Omit<IV07AlignedV2SupervisorProvenance, "liveOriginMain" | "provenanceSha256">;
}

function decodeUtf8(value: Buffer, label: string): string {
    try {
        return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value);
    } catch {
        throw new Error(`${label} is not valid UTF-8`);
    }
}

function readUtf8(path: string, label: string): string {
    return decodeUtf8(readFileSync(path), label);
}

function pathEntryExists(path: string): boolean {
    try {
        lstatSync(path);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

function requireInteger(value: unknown, label: string, minimum = 0): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) {
        throw new Error(`${label} must be an integer >= ${minimum}`);
    }
}

function requireSha256(value: unknown, label: string): asserts value is string {
    if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
        throw new Error(`${label} must be a lowercase SHA-256`);
    }
}

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    return canonicalV07AlignedV2Json(Object.keys(value).sort()) === canonicalV07AlignedV2Json([...expected].sort());
}

function fsyncDirectory(path: string): void {
    const descriptor = openSync(path, "r");
    try {
        fsyncSync(descriptor);
    } finally {
        closeSync(descriptor);
    }
}

function ensureDurableDirectory(path: string): void {
    if (pathEntryExists(path)) {
        const stat = lstatSync(path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new Error(`required durable directory is not a regular directory: ${path}`);
        }
        return;
    }
    const parent = dirname(path);
    if (parent === path) throw new Error(`cannot create durable filesystem root: ${path}`);
    ensureDurableDirectory(parent);
    mkdirSync(path, { mode: 0o750 });
    fsyncDirectory(path);
    fsyncDirectory(parent);
}

export function durableAtomicV07AlignedV2Text(
    destination: string,
    contents: string,
    fault?: IV07AlignedV2DurabilityFaultInjector,
): void {
    ensureDurableDirectory(dirname(destination));
    const temporary = `${destination}.tmp.${process.pid}.${randomUUID()}`;
    let descriptor: number | null = null;
    let renamed = false;
    try {
        descriptor = openSync(temporary, "wx", 0o640);
        writeFileSync(descriptor, contents);
        fsyncSync(descriptor);
        fault?.afterDurableStep("file-fsync");
        closeSync(descriptor);
        descriptor = null;
        renameSync(temporary, destination);
        renamed = true;
        fault?.afterDurableStep("rename");
        fsyncDirectory(dirname(destination));
        fault?.afterDurableStep("directory-fsync");
    } catch (error) {
        if (descriptor !== null) closeSync(descriptor);
        if (!renamed) rmSync(temporary, { force: true });
        throw error;
    }
}

function durableRemove(path: string): void {
    if (!pathEntryExists(path)) return;
    rmSync(path);
    fsyncDirectory(dirname(path));
}

function canonicalFile(value: unknown): string {
    return `${canonicalV07AlignedV2Json(value)}\n`;
}

function parseCanonicalJsonBytes(value: Buffer, label: string): unknown {
    const contents = decodeUtf8(value, label);
    if (!contents.endsWith("\n")) throw new Error(`${label} lacks a terminal newline`);
    const parsed = JSON.parse(contents) as unknown;
    if (canonicalFile(parsed) !== contents) throw new Error(`${label} is not canonical JSON`);
    return parsed;
}

function readCanonicalRegularJson(path: string, label: string): unknown {
    if (!pathEntryExists(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
        throw new Error(`${label} must be a regular non-symlink file`);
    }
    return parseCanonicalJsonBytes(readFileSync(path), label);
}

export interface IV07AlignedV2PreparedBundleLaunchExpectation {
    bundlePath: string;
    definitionPath: string;
    runFingerprint: string;
    definitionSha256: string;
    definitionBytesSha256: string;
    composedSealBytesSha256: string;
    runnerConfigSha256: string;
    runnerConfigBytesSha256: string;
    rateAttestationSha256: string;
    rateAttestationBytesSha256: string;
    seedCommitment: IV07AlignedV2SeedArtifactRef;
    budget: IV07AlignedV2RunnerBudgetReport;
}

export interface IV07AlignedV2PreparedBundleLaunchAttestation {
    bundleDirectory: string;
    bundlePath: string;
    bundleSha256: string;
    bundleBytesSha256: string;
    commitmentPath: string;
    commitmentSha256: string;
    commitmentBytesSha256: string;
}

/** Replays the immutable bootstrap bundle and binds every launch input before any worker can start. */
export function validateV07AlignedV2PreparedBundleLaunch(
    expected: IV07AlignedV2PreparedBundleLaunchExpectation,
): IV07AlignedV2PreparedBundleLaunchAttestation {
    if (
        !isAbsolute(expected.bundlePath) ||
        !pathEntryExists(expected.bundlePath) ||
        lstatSync(expected.bundlePath).isSymbolicLink() ||
        !lstatSync(expected.bundlePath).isFile()
    ) {
        throw new Error("aligned v2 prepared bundle must be an absolute regular non-symlink file");
    }
    const requestedDirectory = dirname(expected.bundlePath);
    if (lstatSync(requestedDirectory).isSymbolicLink() || !lstatSync(requestedDirectory).isDirectory()) {
        throw new Error("aligned v2 prepared bundle directory must be a regular non-symlink directory");
    }
    const bundlePath = realpathSync(expected.bundlePath);
    const bundleDirectory = realpathSync(requestedDirectory);
    if (basename(bundlePath) !== "bundle.json" || dirname(bundlePath) !== bundleDirectory) {
        throw new Error("aligned v2 prepared bundle path must name bundle.json in its bundle directory");
    }
    if (
        canonicalV07AlignedV2Json(readdirSync(bundleDirectory).sort()) !==
        canonicalV07AlignedV2Json(["bundle.json", "definition.json", "seed-allocation"])
    ) {
        throw new Error("aligned v2 prepared bundle root inventory is not exact");
    }
    const seedDirectory = join(bundleDirectory, "seed-allocation");
    if (
        lstatSync(seedDirectory).isSymbolicLink() ||
        !lstatSync(seedDirectory).isDirectory() ||
        canonicalV07AlignedV2Json(readdirSync(seedDirectory).sort()) !== canonicalV07AlignedV2Json(["commitment.json"])
    ) {
        throw new Error("aligned v2 prepared bundle seed-allocation inventory is not exact");
    }
    const definitionPath = join(bundleDirectory, "definition.json");
    const commitmentPath = join(seedDirectory, "commitment.json");
    for (const [path, label] of [
        [definitionPath, "definition"],
        [commitmentPath, "commitment"],
    ] as const) {
        if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
            throw new Error(`aligned v2 prepared bundle ${label} must be a regular non-symlink file`);
        }
    }
    if (realpathSync(definitionPath) !== expected.definitionPath) {
        throw new Error("aligned v2 launch definition is not the definition inside the prepared bundle");
    }

    const bundleBytes = readFileSync(bundlePath);
    const value = parseCanonicalJsonBytes(bundleBytes, "aligned v2 prepared bundle");
    if (
        !isObject(value) ||
        !exactKeys(value, [
            "schemaVersion",
            "artifactKind",
            "status",
            "automaticBake",
            "automaticDeploy",
            "runFingerprint",
            "configSha256",
            "configBytesSha256",
            "requestSha256",
            "commitmentPath",
            "commitmentSha256",
            "commitmentBytesSha256",
            "definitionPath",
            "definitionSha256",
            "definitionBytesSha256",
            "composedSealBytesSha256",
            "rateAttestationSha256",
            "rateAttestationBytesSha256",
            "budget",
            "gamesExecuted",
            "workersStarted",
            "bundleSha256",
        ]) ||
        value.schemaVersion !== 1 ||
        value.artifactKind !== "v0_7_aligned_96h_v2_prepared_definition_bundle" ||
        value.status !== "research_only_no_bake" ||
        value.automaticBake !== false ||
        value.automaticDeploy !== false ||
        value.commitmentPath !== "seed-allocation/commitment.json" ||
        value.definitionPath !== "definition.json" ||
        value.gamesExecuted !== 0 ||
        value.workersStarted !== 0 ||
        !isObject(value.budget)
    ) {
        throw new Error("aligned v2 prepared bundle header or fields are invalid");
    }
    for (const key of [
        "runFingerprint",
        "configSha256",
        "configBytesSha256",
        "requestSha256",
        "commitmentSha256",
        "commitmentBytesSha256",
        "definitionSha256",
        "definitionBytesSha256",
        "composedSealBytesSha256",
        "rateAttestationSha256",
        "rateAttestationBytesSha256",
        "bundleSha256",
    ] as const) {
        requireSha256(value[key], `prepared bundle ${key}`);
    }
    const { bundleSha256, ...unsigned } = value;
    if (bundleSha256 !== fingerprintV07AlignedV2(unsigned)) {
        throw new Error("aligned v2 prepared bundle self-hash mismatch");
    }
    const definitionBytes = readFileSync(definitionPath);
    const commitmentBytes = readFileSync(commitmentPath);
    const commitment = parseCanonicalJsonBytes(commitmentBytes, "aligned v2 prepared seed commitment");
    if (!isObject(commitment) || commitment.commitmentSha256 !== value.commitmentSha256) {
        throw new Error("aligned v2 prepared commitment semantic identity is invalid");
    }
    if (
        value.runFingerprint !== expected.runFingerprint ||
        value.definitionSha256 !== expected.definitionSha256 ||
        value.definitionBytesSha256 !== expected.definitionBytesSha256 ||
        sha256(definitionBytes) !== expected.definitionBytesSha256 ||
        value.composedSealBytesSha256 !== expected.composedSealBytesSha256 ||
        value.configSha256 !== expected.runnerConfigSha256 ||
        value.configBytesSha256 !== expected.runnerConfigBytesSha256 ||
        value.rateAttestationSha256 !== expected.rateAttestationSha256 ||
        value.rateAttestationBytesSha256 !== expected.rateAttestationBytesSha256 ||
        value.commitmentPath !== expected.seedCommitment.path ||
        value.commitmentSha256 !== expected.seedCommitment.artifactSha256 ||
        value.commitmentBytesSha256 !== expected.seedCommitment.bytesSha256 ||
        sha256(commitmentBytes) !== expected.seedCommitment.bytesSha256 ||
        canonicalV07AlignedV2Json(value.budget) !== canonicalV07AlignedV2Json(expected.budget)
    ) {
        throw new Error("aligned v2 prepared bundle does not bind the exact launch inputs");
    }
    return {
        bundleDirectory,
        bundlePath,
        bundleSha256: bundleSha256 as string,
        bundleBytesSha256: sha256(bundleBytes),
        commitmentPath,
        commitmentSha256: value.commitmentSha256 as string,
        commitmentBytesSha256: value.commitmentBytesSha256 as string,
    };
}

function writeImmutable(path: string, value: unknown): void {
    const contents = canonicalFile(value);
    if (pathEntryExists(path)) {
        if (lstatSync(path).isSymbolicLink() || readUtf8(path, "immutable supervisor artifact") !== contents) {
            throw new Error(`immutable supervisor artifact conflicts: ${path}`);
        }
        return;
    }
    durableAtomicV07AlignedV2Text(path, contents);
    chmodSync(path, 0o440);
    const descriptor = openSync(path, "r");
    try {
        fsyncSync(descriptor);
    } finally {
        closeSync(descriptor);
    }
    fsyncDirectory(dirname(path));
}

function writeSelfHashed<T extends Record<string, unknown>>(
    path: string,
    unsigned: T,
    hashField: string,
): T & Record<string, string> {
    const value = { ...unsigned, [hashField]: fingerprintV07AlignedV2(unsigned) } as T & Record<string, string>;
    durableAtomicV07AlignedV2Text(path, canonicalFile(value));
    return value;
}

function markerPath(config: IV07AlignedV2SupervisorConfig, name: string): string {
    return join(config.outputDirectory, name);
}

function markerUnsigned(
    config: IV07AlignedV2SupervisorConfig,
    artifactKind: string,
    atMs: number,
    reason: string,
    detail: string,
): Omit<ISelfHashedMarker, "markerSha256"> {
    return {
        schemaVersion: 1,
        artifactKind,
        status: "research_only_no_bake",
        automaticBake: false,
        automaticDeploy: false,
        runFingerprint: config.runFingerprint,
        atMs,
        reason,
        detail: detail.replace(/[\r\n]+/g, " ").slice(0, 4000),
    };
}

function writePermanentMarker(
    config: IV07AlignedV2SupervisorConfig,
    filename: string,
    artifactKind: string,
    atMs: number,
    reason: string,
    detail: string,
): void {
    const path = markerPath(config, filename);
    if (pathEntryExists(path)) {
        validatePermanentMarker(path, config.runFingerprint);
        return;
    }
    const unsigned = markerUnsigned(config, artifactKind, atMs, reason, detail);
    const value = { ...unsigned, markerSha256: fingerprintV07AlignedV2(unsigned) };
    writeImmutable(path, value);
}

function validatePermanentMarker(path: string, expectedRun: string): ISelfHashedMarker {
    const value = readCanonicalRegularJson(path, "supervisor marker");
    if (
        !isObject(value) ||
        !exactKeys(value, [
            "schemaVersion",
            "artifactKind",
            "status",
            "automaticBake",
            "automaticDeploy",
            "runFingerprint",
            "atMs",
            "reason",
            "detail",
            "markerSha256",
        ])
    )
        throw new Error(`invalid supervisor marker fields: ${path}`);
    const { markerSha256, ...unsigned } = value;
    if (
        value.schemaVersion !== 1 ||
        value.status !== "research_only_no_bake" ||
        value.automaticBake !== false ||
        value.automaticDeploy !== false ||
        value.runFingerprint !== expectedRun ||
        typeof markerSha256 !== "string" ||
        markerSha256 !== fingerprintV07AlignedV2(unsigned)
    )
        throw new Error(`invalid supervisor marker binding: ${path}`);
    return value as unknown as ISelfHashedMarker;
}

function validateConfig(config: IV07AlignedV2SupervisorConfig): void {
    requireSha256(config.runFingerprint, "runFingerprint");
    requireSha256(config.definitionSha256, "definitionSha256");
    requireSha256(config.composedSealSha256, "composedSealSha256");
    if (
        config.composedSealAttestation.sha256 !== config.composedSealSha256 ||
        !config.composedSealAttestation.manifestId.trim() ||
        !(["PASS", "FAIL"] as const).includes(config.composedSealAttestation.qualificationVerdict) ||
        !Number.isFinite(Date.parse(config.composedSealAttestation.sealedAt))
    )
        throw new Error("composed seal attestation does not match the immutable predecessor handoff");
    requireSha256(config.optimizerEntrySha256, "optimizerEntrySha256");
    requireSha256(config.runnerConfigSha256, "runnerConfigSha256");
    requireSha256(config.runnerConfigBytesSha256, "runnerConfigBytesSha256");
    requireSha256(config.rateAttestationSha256, "rateAttestationSha256");
    requireSha256(config.rateAttestationBytesSha256, "rateAttestationBytesSha256");
    requireSha256(config.preparedBundleSha256, "preparedBundleSha256");
    requireSha256(config.preparedBundleBytesSha256, "preparedBundleBytesSha256");
    for (const [label, value, minimum] of [
        ["startAtMs", config.startAtMs, 0],
        ["deadlineAtMs", config.deadlineAtMs, 1],
        ["heartbeatIntervalMs", config.heartbeatIntervalMs, 100],
        ["runnerStartupWatchdogMs", config.runnerStartupWatchdogMs, 1000],
        ["runnerProgressWatchdogMs", config.runnerProgressWatchdogMs, 1000],
        ["hostProbeIntervalMs", config.hostProbeIntervalMs, 100],
        ["watchdogMs", config.watchdogMs, 1000],
        ["hostProbeTimeoutMs", config.hostProbeTimeoutMs, 100],
        ["restartBaseMs", config.restartBaseMs, 100],
        ["restartMaxMs", config.restartMaxMs, 100],
        ["maxRestarts", config.maxRestarts, 1],
        ["stopGraceMs", config.stopGraceMs, 100],
        ["minimumIdleCpus", config.minimumIdleCpus, 1],
        ["niceLevel", config.niceLevel, 0],
    ] as const)
        requireInteger(value, label, minimum);
    if (config.deadlineAtMs - config.startAtMs !== 96 * HOUR_MS) {
        throw new Error("aligned v2 supervisor requires the immutable orchestrator 96-hour deadline");
    }
    if (config.watchdogMs <= config.heartbeatIntervalMs || config.watchdogMs <= config.hostProbeTimeoutMs) {
        throw new Error("watchdogMs must exceed heartbeatIntervalMs and hostProbeTimeoutMs");
    }
    if (
        config.heartbeatIntervalMs > 60_000 ||
        config.runnerStartupWatchdogMs > 900_000 ||
        config.runnerProgressWatchdogMs > 3_600_000 ||
        config.hostProbeIntervalMs > 300_000 ||
        config.watchdogMs > 600_000 ||
        config.hostProbeTimeoutMs > 60_000 ||
        config.restartBaseMs > 60_000 ||
        config.restartMaxMs > 900_000 ||
        config.maxRestarts > 8 ||
        config.stopGraceMs > 120_000 ||
        config.minimumIdleCpus > 1024 ||
        config.niceLevel > 19 ||
        config.watchdogMs < 3 * config.heartbeatIntervalMs ||
        config.runnerStartupWatchdogMs < 3 * config.heartbeatIntervalMs ||
        config.runnerProgressWatchdogMs < config.runnerStartupWatchdogMs
    )
        throw new Error("aligned v2 supervisor lifecycle bounds are outside the fail-closed envelope");
    if (config.restartMaxMs < config.restartBaseMs) throw new Error("restartMaxMs must be >= restartBaseMs");
    if (
        !isAbsolute(config.outputDirectory) ||
        !isAbsolute(config.repositoryRoot) ||
        !isAbsolute(config.definitionPath) ||
        !isAbsolute(config.composedSealPath) ||
        !isAbsolute(config.optimizerEntry) ||
        !isAbsolute(config.runnerConfigPath) ||
        !isAbsolute(config.rateAttestationPath) ||
        !isAbsolute(config.preparedBundlePath)
    ) {
        throw new Error("supervisor repository, input, entry, and output paths must be absolute");
    }
    const outputFromRepository = relative(config.repositoryRoot, config.outputDirectory);
    if (!outputFromRepository || (!outputFromRepository.startsWith(`..${sep}`) && outputFromRepository !== "..")) {
        throw new Error("aligned v2 supervisor output must be outside the source repository");
    }
    if (basename(config.optimizerEntry) !== ALIGNED_ENTRY_BASENAME) {
        throw new Error(`aligned v2 supervisor requires exact optimizer entry ${ALIGNED_ENTRY_BASENAME}`);
    }
    const expectedMode = config.optimizerArgs.includes("--preflight") ? "--preflight" : "--run";
    if (
        config.optimizerArgs.length !== 2 ||
        !config.optimizerArgs.includes(expectedMode) ||
        config.optimizerArgs.includes(expectedMode === "--run" ? "--preflight" : "--run") ||
        !config.optimizerArgs.includes(`--config=${config.runnerConfigPath}`)
    ) {
        throw new Error("aligned v2 supervisor optimizer arguments must bind one mode and the exact runner config");
    }
}

function buildRun(config: IV07AlignedV2SupervisorConfig): ISupervisorRun {
    const unsigned = {
        schemaVersion: 1 as const,
        artifactKind: "v0_7_aligned_96h_v2_supervisor_run" as const,
        status: "research_only_no_bake" as const,
        automaticBake: false as const,
        automaticDeploy: false as const,
        runFingerprint: config.runFingerprint,
        orchestratorDirectory: join(config.outputDirectory, "orchestrator"),
        definition: { path: config.definitionPath, sha256: config.definitionSha256 },
        preparedBundle: {
            path: config.preparedBundlePath,
            sha256: config.preparedBundleSha256,
            bytesSha256: config.preparedBundleBytesSha256,
        },
        composedSeal: {
            path: config.composedSealPath,
            sha256: config.composedSealSha256,
            manifestId: config.composedSealAttestation.manifestId,
            qualificationVerdict: config.composedSealAttestation.qualificationVerdict,
            sealedAt: config.composedSealAttestation.sealedAt,
        },
        schedule: { startAtMs: config.startAtMs, deadlineAtMs: config.deadlineAtMs, durationHours: 96 as const },
        optimizer: {
            entry: config.optimizerEntry,
            sha256: config.optimizerEntrySha256,
            args: [...config.optimizerArgs],
            runnerConfig: {
                path: config.runnerConfigPath,
                sha256: config.runnerConfigSha256,
                bytesSha256: config.runnerConfigBytesSha256,
            },
            rateAttestation: {
                path: config.rateAttestationPath,
                sha256: config.rateAttestationSha256,
                bytesSha256: config.rateAttestationBytesSha256,
            },
        },
        lifecycle: {
            heartbeatIntervalMs: config.heartbeatIntervalMs,
            runnerStartupWatchdogMs: config.runnerStartupWatchdogMs,
            runnerProgressWatchdogMs: config.runnerProgressWatchdogMs,
            hostProbeIntervalMs: config.hostProbeIntervalMs,
            watchdogMs: config.watchdogMs,
            hostProbeTimeoutMs: config.hostProbeTimeoutMs,
            restartBaseMs: config.restartBaseMs,
            restartMaxMs: config.restartMaxMs,
            maxRestarts: config.maxRestarts,
            stopGraceMs: config.stopGraceMs,
            minimumIdleCpus: config.minimumIdleCpus,
            niceLevel: config.niceLevel,
        },
        provenance: config.provenance,
    };
    return { ...unsigned, runSha256: fingerprintV07AlignedV2(unsigned) };
}

function readV07AlignedV2SupervisorRun(path: string): ISupervisorRun {
    const value = readCanonicalRegularJson(path, "aligned v2 supervisor run");
    if (
        !isObject(value) ||
        !exactKeys(value, [
            "schemaVersion",
            "artifactKind",
            "status",
            "automaticBake",
            "automaticDeploy",
            "runFingerprint",
            "orchestratorDirectory",
            "definition",
            "preparedBundle",
            "composedSeal",
            "schedule",
            "optimizer",
            "lifecycle",
            "provenance",
            "runSha256",
        ]) ||
        value.schemaVersion !== 1 ||
        value.artifactKind !== "v0_7_aligned_96h_v2_supervisor_run" ||
        value.status !== "research_only_no_bake" ||
        value.automaticBake !== false ||
        value.automaticDeploy !== false ||
        !isObject(value.provenance)
    ) {
        throw new Error("aligned v2 supervisor run fields are invalid");
    }
    const { runSha256, ...unsigned } = value;
    const { provenanceSha256, ...unsignedProvenance } = value.provenance;
    if (
        typeof runSha256 !== "string" ||
        runSha256 !== fingerprintV07AlignedV2(unsigned) ||
        typeof provenanceSha256 !== "string" ||
        provenanceSha256 !== fingerprintV07AlignedV2(unsignedProvenance) ||
        typeof value.provenance.liveOriginMain !== "string" ||
        !COMMIT_PATTERN.test(value.provenance.liveOriginMain)
    ) {
        throw new Error("aligned v2 supervisor run binding is invalid");
    }
    return value as unknown as ISupervisorRun;
}

function initializeRun(config: IV07AlignedV2SupervisorConfig): void {
    ensureDurableDirectory(config.outputDirectory);
    const runPath = markerPath(config, "supervisor-run.json");
    if (!pathEntryExists(runPath)) {
        const unexpected = readdirSync(config.outputDirectory).filter((name) => name !== "supervisor.lock");
        const lockPath = markerPath(config, "supervisor.lock");
        if (
            unexpected.length > 0 ||
            (pathEntryExists(lockPath) && (lstatSync(lockPath).isSymbolicLink() || !lstatSync(lockPath).isFile()))
        ) {
            throw new Error(
                `refusing to adopt preexisting unsupervised output: ${unexpected.sort().join(",") || "invalid lock"}`,
            );
        }
    }
    writeImmutable(runPath, buildRun(config));
}

function heartbeatSequence(path: string, runFingerprint: string): number {
    if (!pathEntryExists(path)) return 0;
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
        throw new Error(`existing heartbeat must be a regular non-symlink file: ${path}`);
    }
    const contents = readUtf8(path, "existing heartbeat");
    const value = JSON.parse(contents) as unknown;
    const expectedKeys = [
        "schemaVersion",
        "artifactKind",
        "runFingerprint",
        "sequence",
        "supervisorPid",
        "childPid",
        "attempt",
        "state",
        "deadlineAtMs",
        "updatedAtMs",
        "heartbeatSha256",
    ];
    if (
        !isObject(value) ||
        !exactKeys(value, expectedKeys) ||
        contents !== canonicalFile(value) ||
        value.schemaVersion !== 1 ||
        value.artifactKind !== "v0_7_aligned_96h_v2_supervisor_heartbeat" ||
        value.runFingerprint !== runFingerprint ||
        typeof value.sequence !== "number" ||
        !Number.isSafeInteger(value.sequence) ||
        value.sequence < 0 ||
        value.sequence === Number.MAX_SAFE_INTEGER
    ) {
        throw new Error(`existing heartbeat is malformed or belongs to another run: ${path}`);
    }
    const { heartbeatSha256, ...unsigned } = value;
    if (heartbeatSha256 !== fingerprintV07AlignedV2(unsigned)) {
        throw new Error(`existing heartbeat self-hash mismatch: ${path}`);
    }
    return value.sequence + 1;
}

function writeHeartbeat<T extends Record<string, unknown>>(path: string, unsigned: T): void {
    writeSelfHashed(path, unsigned, "heartbeatSha256");
}

function validateLinuxProcessIdentity(value: unknown, label: string): IV07AlignedV2LinuxProcessIdentity {
    if (
        !isObject(value) ||
        !exactKeys(value, ["platform", "bootId", "pidNamespace", "pid", "startTimeTicks", "pgid", "sid"]) ||
        value.platform !== "linux" ||
        typeof value.bootId !== "string" ||
        !LINUX_BOOT_ID_PATTERN.test(value.bootId) ||
        typeof value.pidNamespace !== "string" ||
        !LINUX_PID_NAMESPACE_PATTERN.test(value.pidNamespace) ||
        typeof value.startTimeTicks !== "string" ||
        !DECIMAL_TICKS_PATTERN.test(value.startTimeTicks)
    ) {
        throw new Error(`${label} is not an exact Linux process birth identity`);
    }
    requireInteger(value.pid, `${label}.pid`, 1);
    requireInteger(value.pgid, `${label}.pgid`, 1);
    requireInteger(value.sid, `${label}.sid`, 1);
    return value as unknown as IV07AlignedV2LinuxProcessIdentity;
}

function validateOptionalProcessIdentity(value: unknown, label: string): IV07AlignedV2LinuxProcessIdentity | null {
    return value === null ? null : validateLinuxProcessIdentity(value, label);
}

function validateArmedMarker(path: string, runFingerprint: string): IArmedMarker {
    const value = readCanonicalRegularJson(path, "supervisor armed ownership record");
    if (
        !isObject(value) ||
        !exactKeys(value, [
            "schemaVersion",
            "artifactKind",
            "runFingerprint",
            "ownerToken",
            "supervisorPid",
            "supervisorIdentity",
            "attempt",
            "activationState",
            "childPid",
            "childPgid",
            "childIdentity",
            "armedAtMs",
            "armedSha256",
        ])
    ) {
        throw new Error("supervisor armed ownership record fields are not exact");
    }
    const { armedSha256, ...unsigned } = value;
    if (
        value.schemaVersion !== 2 ||
        value.artifactKind !== "v0_7_aligned_96h_v2_supervisor_armed" ||
        value.runFingerprint !== runFingerprint ||
        typeof value.ownerToken !== "string" ||
        !UUID_PATTERN.test(value.ownerToken) ||
        (value.activationState !== "pre_activation" && value.activationState !== "activated") ||
        typeof armedSha256 !== "string" ||
        armedSha256 !== fingerprintV07AlignedV2(unsigned)
    ) {
        throw new Error("supervisor armed ownership record binding is invalid");
    }
    requireInteger(value.supervisorPid, "armed supervisorPid", 1);
    requireInteger(value.attempt, "armed attempt", 1);
    requireInteger(value.armedAtMs, "armed armedAtMs");
    const supervisorIdentity = validateOptionalProcessIdentity(value.supervisorIdentity, "armed supervisorIdentity");
    if (supervisorIdentity !== null && supervisorIdentity.pid !== value.supervisorPid) {
        throw new Error("armed supervisor identity does not match supervisorPid");
    }
    const childIdentity = validateOptionalProcessIdentity(value.childIdentity, "armed childIdentity");
    if (value.childPid === null || value.childPgid === null) {
        if (
            value.childPid !== null ||
            value.childPgid !== null ||
            childIdentity !== null ||
            value.activationState !== "pre_activation"
        ) {
            throw new Error("armed child ownership must be entirely null or entirely populated");
        }
    } else {
        requireInteger(value.childPid, "armed childPid", 1);
        requireInteger(value.childPgid, "armed childPgid", 1);
        if (
            childIdentity !== null &&
            (childIdentity.pid !== value.childPid ||
                childIdentity.pgid !== value.childPgid ||
                childIdentity.sid !== value.childPgid ||
                value.childPid !== value.childPgid)
        ) {
            throw new Error("armed child identity is not the recorded setsid process-group leader");
        }
    }
    return value as unknown as IArmedMarker;
}

function validateOptimizerPidRecord(path: string, runFingerprint: string): IOptimizerPidRecord {
    const value = readCanonicalRegularJson(path, "optimizer ownership record");
    if (
        !isObject(value) ||
        !exactKeys(value, [
            "schemaVersion",
            "artifactKind",
            "runFingerprint",
            "attempt",
            "pid",
            "pgid",
            "identity",
            "ownerToken",
            "startedAtMs",
            "pidRecordSha256",
        ])
    ) {
        throw new Error("optimizer ownership record fields are not exact");
    }
    const { pidRecordSha256, ...unsigned } = value;
    if (
        value.schemaVersion !== 2 ||
        value.artifactKind !== "v0_7_aligned_96h_v2_optimizer_pid" ||
        value.runFingerprint !== runFingerprint ||
        typeof value.ownerToken !== "string" ||
        !UUID_PATTERN.test(value.ownerToken) ||
        typeof pidRecordSha256 !== "string" ||
        pidRecordSha256 !== fingerprintV07AlignedV2(unsigned)
    ) {
        throw new Error("optimizer ownership record binding is invalid");
    }
    requireInteger(value.attempt, "optimizer ownership attempt", 1);
    requireInteger(value.pid, "optimizer ownership pid", 1);
    requireInteger(value.pgid, "optimizer ownership pgid", 1);
    requireInteger(value.startedAtMs, "optimizer ownership startedAtMs");
    const identity = validateOptionalProcessIdentity(value.identity, "optimizer ownership identity");
    if (
        identity !== null &&
        (identity.pid !== value.pid ||
            identity.pgid !== value.pgid ||
            identity.sid !== value.pgid ||
            value.pid !== value.pgid)
    ) {
        throw new Error("optimizer ownership identity is not the recorded setsid process-group leader");
    }
    return value as unknown as IOptimizerPidRecord;
}

function recoveryAuditPath(config: IV07AlignedV2SupervisorConfig, armedSha256: string): string {
    requireSha256(armedSha256, "recovery armedSha256");
    return join(config.outputDirectory, "supervisor-recoveries", `${armedSha256}.json`);
}

function validateRecoveryAudit(path: string, runFingerprint: string, armedSha256: string): ISupervisorRecoveryAudit {
    const value = readCanonicalRegularJson(path, "supervisor recovery audit");
    if (
        !isObject(value) ||
        !exactKeys(value, [
            "schemaVersion",
            "artifactKind",
            "status",
            "automaticBake",
            "automaticDeploy",
            "runFingerprint",
            "ownerToken",
            "restoredAttempt",
            "armedSha256",
            "pidRecordSha256",
            "observation",
            "recoveredAtMs",
            "recoverySha256",
        ])
    ) {
        throw new Error("supervisor recovery audit fields are not exact");
    }
    const { recoverySha256, ...unsigned } = value;
    if (
        value.schemaVersion !== 1 ||
        value.artifactKind !== "v0_7_aligned_96h_v2_supervisor_recovery" ||
        value.status !== "research_only_no_bake" ||
        value.automaticBake !== false ||
        value.automaticDeploy !== false ||
        value.runFingerprint !== runFingerprint ||
        value.armedSha256 !== armedSha256 ||
        typeof value.ownerToken !== "string" ||
        !UUID_PATTERN.test(value.ownerToken) ||
        (value.pidRecordSha256 !== null &&
            (typeof value.pidRecordSha256 !== "string" || !SHA256_PATTERN.test(value.pidRecordSha256))) ||
        (value.observation !== "different_boot" && value.observation !== "same_boot_absent") ||
        typeof recoverySha256 !== "string" ||
        recoverySha256 !== fingerprintV07AlignedV2(unsigned)
    ) {
        throw new Error("supervisor recovery audit binding is invalid");
    }
    requireInteger(value.restoredAttempt, "recovery restoredAttempt", 1);
    requireInteger(value.recoveredAtMs, "recovery recoveredAtMs");
    return value as unknown as ISupervisorRecoveryAudit;
}

function sameProcessIdentity(
    left: IV07AlignedV2LinuxProcessIdentity,
    right: IV07AlignedV2LinuxProcessIdentity,
): boolean {
    return canonicalV07AlignedV2Json(left) === canonicalV07AlignedV2Json(right);
}

function writeArmed(config: IV07AlignedV2SupervisorConfig, value: Omit<IArmedMarker, "armedSha256">): void {
    writeSelfHashed(markerPath(config, "SUPERVISOR_ARMED.json"), value, "armedSha256");
}

function backoff(config: IV07AlignedV2SupervisorConfig, attempt: number): number {
    return Math.min(config.restartMaxMs, config.restartBaseMs * 2 ** Math.max(0, attempt - 1));
}

async function stopOptimizer(
    child: IV07AlignedV2OptimizerHandle,
    config: IV07AlignedV2SupervisorConfig,
    clock: IV07AlignedV2SupervisorClock,
): Promise<boolean> {
    let poll = await child.poll();
    if (!poll.alive) return true;
    await child.signalGroup("SIGTERM");
    const termDeadline = clock.nowMs() + config.stopGraceMs;
    while ((poll = await child.poll()).alive && clock.nowMs() < termDeadline) {
        await clock.sleep(Math.min(250, termDeadline - clock.nowMs()));
    }
    if (!poll.alive) return true;
    await child.signalGroup("SIGKILL");
    const killDeadline = clock.nowMs() + config.stopGraceMs;
    while ((poll = await child.poll()).alive && clock.nowMs() < killDeadline) {
        await clock.sleep(Math.min(250, killDeadline - clock.nowMs()));
    }
    return !poll.alive;
}

function assessmentDetail(assessment: IV07AlignedV2HostAssessment): string {
    return canonicalV07AlignedV2Json(assessment).slice(0, 4000);
}

function assertHealthyAssessment(assessment: IV07AlignedV2HostAssessment, minimumIdleCpus: number): void {
    if (
        !isObject(assessment) ||
        !exactKeys(assessment, [
            "schemaVersion",
            "ok",
            "reasons",
            "minimumIdleCpus",
            "cpuCount",
            "idleCpus",
            "blockers",
        ]) ||
        assessment.schemaVersion !== 1 ||
        assessment.ok !== true ||
        assessment.minimumIdleCpus !== minimumIdleCpus ||
        !Array.isArray(assessment.reasons) ||
        assessment.reasons.length !== 0 ||
        !Array.isArray(assessment.blockers) ||
        assessment.blockers.length !== 0 ||
        !Number.isSafeInteger(assessment.cpuCount) ||
        (assessment.cpuCount as number) < minimumIdleCpus ||
        !Number.isFinite(assessment.idleCpus) ||
        (assessment.idleCpus as number) < minimumIdleCpus
    )
        throw new Error(`host contention assessment failed: ${assessmentDetail(assessment)}`);
}

export async function runV07AlignedV2Supervisor(
    configInput: IV07AlignedV2SupervisorConfig,
    dependencyInput: IV07AlignedV2SupervisorDependencies,
): Promise<IV07AlignedV2SupervisorOutcome> {
    const config: IV07AlignedV2SupervisorConfig = {
        ...configInput,
        optimizerArgs: Object.freeze([...configInput.optimizerArgs]),
        provenance: Object.freeze({ ...configInput.provenance }),
        composedSealAttestation: Object.freeze({ ...configInput.composedSealAttestation }),
    };
    const dependencies: IV07AlignedV2SupervisorDependencies = { ...dependencyInput };
    validateConfig(config);
    initializeRun(config);

    const armedPath = markerPath(config, "SUPERVISOR_ARMED.json");
    const quarantinePath = markerPath(config, "SUPERVISOR_QUARANTINED.json");
    const invalidPath = markerPath(config, "SUPERVISOR_INVALID.json");
    const deadlinePath = markerPath(config, "SUPERVISOR_DEADLINE.json");
    const supervisorHeartbeatPath = markerPath(config, "supervisor.heartbeat.json");
    const optimizerPidPath = markerPath(config, "optimizer.pid.json");
    let supervisorSequence = heartbeatSequence(supervisorHeartbeatPath, config.runFingerprint);
    let lastSupervisorHeartbeatAtMs = dependencies.clock.nowMs();
    let attempt = 0;
    let child: IV07AlignedV2OptimizerHandle | null = null;
    let ownerToken = "";
    const supervisorIdentity = dependencies.readProcessIdentity(dependencies.processId);
    if (supervisorIdentity !== null && supervisorIdentity.pid !== dependencies.processId) {
        throw new Error("supervisor process identity does not match its processId");
    }

    const outcome = (stop: V07AlignedV2SupervisorStop, detail: string): IV07AlignedV2SupervisorOutcome => ({
        stop,
        attempts: attempt,
        detail,
    });
    const heartbeat = (state: string): void => {
        const updatedAtMs = dependencies.clock.nowMs();
        writeHeartbeat(supervisorHeartbeatPath, {
            schemaVersion: 1,
            artifactKind: "v0_7_aligned_96h_v2_supervisor_heartbeat",
            runFingerprint: config.runFingerprint,
            sequence: supervisorSequence++,
            supervisorPid: dependencies.processId,
            childPid: child?.pid ?? null,
            attempt,
            state,
            deadlineAtMs: config.deadlineAtMs,
            updatedAtMs,
        });
        lastSupervisorHeartbeatAtMs = updatedAtMs;
    };
    const permanent = (): IV07AlignedV2SupervisorOutcome | null => {
        if (pathEntryExists(quarantinePath)) {
            validatePermanentMarker(quarantinePath, config.runFingerprint);
            return outcome("quarantined", "permanent quarantine marker exists");
        }
        if (pathEntryExists(invalidPath)) {
            validatePermanentMarker(invalidPath, config.runFingerprint);
            return outcome("invalid", "permanent invalid marker exists");
        }
        if (pathEntryExists(deadlinePath)) {
            const marker = validatePermanentMarker(deadlinePath, config.runFingerprint);
            if (marker.atMs < config.deadlineAtMs) throw new Error("deadline marker predates immutable deadline");
            return outcome("deadline", "immutable deadline marker exists");
        }
        return null;
    };
    const mark = (
        stop: "invalid" | "quarantined" | "deadline",
        reason: string,
        detail: string,
    ): IV07AlignedV2SupervisorOutcome => {
        const names = {
            invalid: ["SUPERVISOR_INVALID.json", "v0_7_aligned_96h_v2_supervisor_invalid"],
            quarantined: ["SUPERVISOR_QUARANTINED.json", "v0_7_aligned_96h_v2_supervisor_quarantined"],
            deadline: ["SUPERVISOR_DEADLINE.json", "v0_7_aligned_96h_v2_supervisor_deadline"],
        } as const;
        writePermanentMarker(config, names[stop][0], names[stop][1], dependencies.clock.nowMs(), reason, detail);
        heartbeat(stop);
        return outcome(stop, `${reason}: ${detail}`);
    };
    const controlledStop = async (reason: string): Promise<boolean> => {
        if (!child) {
            durableRemove(armedPath);
            durableRemove(optimizerPidPath);
            return true;
        }
        dependencies.log(`stopping optimizer process group ${child.pgid}: ${reason}`);
        const stopped = await stopOptimizer(child, config, dependencies.clock);
        if (!stopped) return false;
        child = null;
        durableRemove(optimizerPidPath);
        durableRemove(armedPath);
        return true;
    };
    const stableInputs = async (): Promise<void> => {
        await dependencies.verifyImmutableInputs();
        const current = await dependencies.captureProvenance();
        if (
            canonicalV07AlignedV2Json(immutableProvenance(current)) !==
            canonicalV07AlignedV2Json(immutableProvenance(config.provenance))
        ) {
            throw new Error("pinned-main/Bun/dependency provenance changed during the supervised run");
        }
    };
    const terminal = (): IV07AlignedV2OrchestratorTerminal | null =>
        dependencies.validateTerminal(() => {
            const nowMs = dependencies.clock.nowMs();
            if (nowMs - lastSupervisorHeartbeatAtMs >= config.heartbeatIntervalMs) {
                heartbeat("terminal-replay");
            }
        });
    const acceptReplayValidTerminal = async (): Promise<IV07AlignedV2SupervisorOutcome | null> => {
        try {
            const foundTerminal = terminal();
            if (!foundTerminal) return null;
            await stableInputs();
            if (!(await controlledStop("validated research-only terminal"))) {
                return mark("quarantined", "process-group-survived-terminal", "optimizer group survived TERM and KILL");
            }
            heartbeat("terminal");
            return outcome("terminal", `validated ${foundTerminal.verdict} terminal`);
        } catch (error) {
            const invalid = mark("invalid", "terminal-validation-failed", String(error));
            if (!(await controlledStop("invalid terminal"))) {
                return mark("quarantined", "process-group-survived-invalid", "optimizer group survived TERM and KILL");
            }
            return invalid;
        }
    };
    const stopAtImmutableDeadline = async (detail: string): Promise<IV07AlignedV2SupervisorOutcome> => {
        const acceptedTerminal = await acceptReplayValidTerminal();
        if (acceptedTerminal) return acceptedTerminal;
        const deadline = mark("deadline", "immutable-wall-clock-deadline", detail);
        if (!(await controlledStop("immutable deadline"))) {
            return mark("quarantined", "process-group-survived-deadline", "optimizer group survived TERM and KILL");
        }
        return deadline;
    };

    interface IRunnerProgressState {
        baseline: IV07AlignedV2RunnerHeartbeat | null;
        adopted: boolean;
        sequence: number;
        heartbeatSha256: string | null;
        completedShards: number;
        completedGames: number;
        updatedAtMs: number;
        observedAtMs: number;
        spawnedAtMs: number;
    }
    const runnerHeartbeat = (): IV07AlignedV2RunnerHeartbeat | null => {
        const value = dependencies.readRunnerHeartbeat();
        return value === null
            ? null
            : validateV07AlignedV2RunnerHeartbeat(value, config.runFingerprint, "supervisor runner heartbeat");
    };
    const runnerProgressState = (spawnedAtMs: number): IRunnerProgressState => {
        const baseline = runnerHeartbeat();
        return {
            baseline,
            adopted: false,
            sequence: baseline?.sequence ?? -1,
            heartbeatSha256: baseline?.heartbeatSha256 ?? null,
            completedShards: baseline?.completedShards ?? 0,
            completedGames: baseline?.completedGames ?? 0,
            updatedAtMs: baseline?.updatedAtMs ?? -1,
            observedAtMs: spawnedAtMs,
            spawnedAtMs,
        };
    };
    const inspectRunnerProgress = (
        state: IRunnerProgressState,
        now: number,
    ): { stop: "invalid" | "quarantined"; reason: string; detail: string } | null => {
        let current: IV07AlignedV2RunnerHeartbeat | null;
        try {
            current = runnerHeartbeat();
        } catch (error) {
            return { stop: "invalid", reason: "runner-heartbeat-invalid", detail: String(error) };
        }
        if (!current) {
            if (state.baseline || state.adopted) {
                return {
                    stop: "invalid",
                    reason: "runner-heartbeat-disappeared",
                    detail: "runner heartbeat disappeared after it became authoritative",
                };
            }
            if (now - state.spawnedAtMs > config.runnerStartupWatchdogMs) {
                return {
                    stop: "quarantined",
                    reason: "runner-heartbeat-startup-timeout",
                    detail: `runner did not publish its first heartbeat within ${config.runnerStartupWatchdogMs}ms`,
                };
            }
            return null;
        }
        if (current.updatedAtMs > now + config.heartbeatIntervalMs) {
            return {
                stop: "invalid",
                reason: "runner-heartbeat-future-time",
                detail: `runner heartbeat time ${current.updatedAtMs} is ahead of supervisor time ${now}`,
            };
        }
        if (!state.adopted) {
            if (current.sequence < state.sequence) {
                return {
                    stop: "invalid",
                    reason: "runner-heartbeat-sequence-regressed",
                    detail: `runner heartbeat sequence regressed from ${state.sequence} to ${current.sequence}`,
                };
            }
            if (current.sequence === state.sequence) {
                if (current.heartbeatSha256 !== state.heartbeatSha256) {
                    return {
                        stop: "invalid",
                        reason: "runner-heartbeat-sequence-reused",
                        detail: "runner heartbeat bytes changed without advancing sequence",
                    };
                }
                if (now - state.spawnedAtMs > config.runnerStartupWatchdogMs) {
                    return {
                        stop: "quarantined",
                        reason: "runner-heartbeat-startup-stale",
                        detail: "replacement runner did not advance the prior heartbeat after spawn",
                    };
                }
                return null;
            }
            state.adopted = true;
        } else if (current.sequence < state.sequence) {
            return {
                stop: "invalid",
                reason: "runner-heartbeat-sequence-regressed",
                detail: `runner heartbeat sequence regressed from ${state.sequence} to ${current.sequence}`,
            };
        }
        if (
            current.completedShards < state.completedShards ||
            current.completedGames < state.completedGames ||
            current.updatedAtMs < state.updatedAtMs
        ) {
            return {
                stop: "invalid",
                reason: "runner-heartbeat-progress-regressed",
                detail: "runner heartbeat counters or timestamp regressed",
            };
        }
        if (current.sequence === state.sequence) {
            if (current.heartbeatSha256 !== state.heartbeatSha256) {
                return {
                    stop: "invalid",
                    reason: "runner-heartbeat-sequence-reused",
                    detail: "runner heartbeat bytes changed without advancing sequence",
                };
            }
            if (now - state.observedAtMs > config.runnerProgressWatchdogMs) {
                return {
                    stop: "quarantined",
                    reason: "runner-heartbeat-progress-timeout",
                    detail: `runner made no durable progress for ${now - state.observedAtMs}ms`,
                };
            }
            return null;
        }
        state.sequence = current.sequence;
        state.heartbeatSha256 = current.heartbeatSha256;
        state.completedShards = current.completedShards;
        state.completedGames = current.completedGames;
        state.updatedAtMs = current.updatedAtMs;
        state.observedAtMs = now;
        return null;
    };

    const ownershipQuarantine = (reason: string, detail: string): IV07AlignedV2SupervisorOutcome => {
        writePermanentMarker(
            config,
            "SUPERVISOR_QUARANTINED.json",
            "v0_7_aligned_96h_v2_supervisor_quarantined",
            dependencies.clock.nowMs(),
            reason,
            detail,
        );
        return outcome("quarantined", `${reason}: ${detail}`);
    };
    const recoverStaleOwnership = async (): Promise<IV07AlignedV2SupervisorOutcome | null> => {
        if (!pathEntryExists(armedPath)) {
            return pathEntryExists(optimizerPidPath)
                ? ownershipQuarantine(
                      "orphan-optimizer-pid-record",
                      "optimizer ownership record exists without its armed continuity sentinel",
                  )
                : null;
        }

        let armed: IArmedMarker;
        try {
            armed = validateArmedMarker(armedPath, config.runFingerprint);
        } catch (error) {
            return ownershipQuarantine("stale-ownership-invalid", String(error));
        }
        attempt = armed.attempt;
        const auditPath = recoveryAuditPath(config, armed.armedSha256);
        let priorAudit: ISupervisorRecoveryAudit | null = null;
        if (pathEntryExists(auditPath)) {
            try {
                priorAudit = validateRecoveryAudit(auditPath, config.runFingerprint, armed.armedSha256);
            } catch (error) {
                return ownershipQuarantine("stale-recovery-audit-invalid", String(error));
            }
        }

        let pidRecord: IOptimizerPidRecord | null = null;
        if (pathEntryExists(optimizerPidPath)) {
            try {
                pidRecord = validateOptimizerPidRecord(optimizerPidPath, config.runFingerprint);
            } catch (error) {
                return ownershipQuarantine("stale-optimizer-ownership-invalid", String(error));
            }
        }
        if (armed.childPid === null) {
            if (pidRecord !== null || priorAudit?.pidRecordSha256) {
                return ownershipQuarantine(
                    "stale-ownership-mismatch",
                    "pre-activation armed record unexpectedly has optimizer ownership",
                );
            }
        } else {
            if (
                armed.activationState === "activated" &&
                pidRecord === null &&
                (priorAudit === null || priorAudit.pidRecordSha256 === null)
            ) {
                return ownershipQuarantine(
                    "stale-ownership-mismatch",
                    "activated armed record has no matching optimizer ownership or recovery audit",
                );
            }
            if (
                pidRecord !== null &&
                (pidRecord.ownerToken !== armed.ownerToken ||
                    pidRecord.attempt !== armed.attempt ||
                    pidRecord.pid !== armed.childPid ||
                    pidRecord.pgid !== armed.childPgid ||
                    pidRecord.startedAtMs !== armed.armedAtMs ||
                    canonicalV07AlignedV2Json(pidRecord.identity) !== canonicalV07AlignedV2Json(armed.childIdentity))
            ) {
                return ownershipQuarantine(
                    "stale-ownership-mismatch",
                    "armed and optimizer ownership records do not bind the same process",
                );
            }
        }
        if (
            priorAudit !== null &&
            (priorAudit.ownerToken !== armed.ownerToken ||
                priorAudit.restoredAttempt !== armed.attempt ||
                (pidRecord !== null && priorAudit.pidRecordSha256 !== pidRecord.pidRecordSha256))
        ) {
            return ownershipQuarantine(
                "stale-recovery-audit-mismatch",
                "recovery audit does not bind the stale ownership records",
            );
        }
        if (supervisorIdentity === null || armed.supervisorIdentity === null) {
            return ownershipQuarantine(
                "stale-ownership-unprovable",
                "automatic ownership recovery requires Linux process birth identities",
            );
        }
        if (
            armed.childIdentity !== null &&
            (armed.childIdentity.bootId !== armed.supervisorIdentity.bootId ||
                armed.childIdentity.pidNamespace !== armed.supervisorIdentity.pidNamespace)
        ) {
            return ownershipQuarantine(
                "stale-ownership-mismatch",
                "supervisor and child ownership identities do not share one Linux boot and PID namespace",
            );
        }

        let observation: ISupervisorRecoveryAudit["observation"];
        if (supervisorIdentity.bootId !== armed.supervisorIdentity.bootId) {
            observation = "different_boot";
        } else {
            if (supervisorIdentity.pidNamespace !== armed.supervisorIdentity.pidNamespace) {
                return ownershipQuarantine(
                    "stale-ownership-unprovable",
                    "Linux PID namespace changed without a host reboot",
                );
            }
            let currentOwner: IV07AlignedV2LinuxProcessIdentity | null;
            try {
                currentOwner = dependencies.readProcessIdentity(armed.supervisorPid);
            } catch (error) {
                return ownershipQuarantine("stale-owner-probe-ambiguous", String(error));
            }
            if (currentOwner !== null) {
                return sameProcessIdentity(currentOwner, armed.supervisorIdentity)
                    ? outcome("busy", "recorded supervisor owner is still alive")
                    : ownershipQuarantine(
                          "stale-supervisor-pid-reused",
                          "recorded supervisor PID now belongs to a different process identity",
                      );
            }

            if (armed.childPid !== null) {
                if (
                    armed.childIdentity === null ||
                    armed.childIdentity.bootId !== armed.supervisorIdentity.bootId ||
                    armed.childIdentity.pidNamespace !== armed.supervisorIdentity.pidNamespace
                ) {
                    return ownershipQuarantine(
                        "stale-child-ownership-unprovable",
                        "recorded child lacks a matching Linux boot and PID namespace identity",
                    );
                }
                const cleanupDeadline = Math.min(config.deadlineAtMs, dependencies.clock.nowMs() + config.stopGraceMs);
                while (true) {
                    let currentChild: IV07AlignedV2LinuxProcessIdentity | null;
                    let group: V07AlignedV2ProcessGroupProbe;
                    try {
                        currentChild = dependencies.readProcessIdentity(armed.childPid);
                        group = dependencies.probeProcessGroup(armed.childPgid!);
                    } catch (error) {
                        return ownershipQuarantine("stale-child-probe-ambiguous", String(error));
                    }
                    if (currentChild !== null && !sameProcessIdentity(currentChild, armed.childIdentity)) {
                        return ownershipQuarantine(
                            "stale-child-pid-reused",
                            "recorded child PID now belongs to a different process identity",
                        );
                    }
                    if (group === "ambiguous") {
                        return ownershipQuarantine(
                            "stale-child-group-ambiguous",
                            "recorded optimizer process-group liveness is ambiguous",
                        );
                    }
                    if (currentChild === null && group === "absent") break;
                    if (currentChild !== null && group === "absent") {
                        return ownershipQuarantine(
                            "stale-child-group-inconsistent",
                            "recorded child identity is live but its process group is absent",
                        );
                    }
                    if (dependencies.clock.requestedSignal()) {
                        return outcome("signal", "signal while waiting for stale child guard cleanup");
                    }
                    const now = dependencies.clock.nowMs();
                    if (now >= cleanupDeadline) {
                        return outcome("busy", "recorded optimizer process group is still cleaning up");
                    }
                    await dependencies.clock.sleep(Math.min(250, cleanupDeadline - now));
                }
            }
            observation = "same_boot_absent";
        }

        const pidRecordSha256 = pidRecord?.pidRecordSha256 ?? priorAudit?.pidRecordSha256 ?? null;
        if (priorAudit === null) {
            const unsigned = {
                schemaVersion: 1 as const,
                artifactKind: "v0_7_aligned_96h_v2_supervisor_recovery" as const,
                status: "research_only_no_bake" as const,
                automaticBake: false as const,
                automaticDeploy: false as const,
                runFingerprint: config.runFingerprint,
                ownerToken: armed.ownerToken,
                restoredAttempt: armed.attempt,
                armedSha256: armed.armedSha256,
                pidRecordSha256,
                observation,
                recoveredAtMs: dependencies.clock.nowMs(),
            };
            writeImmutable(auditPath, {
                ...unsigned,
                recoverySha256: fingerprintV07AlignedV2(unsigned),
            });
        } else if (priorAudit.observation !== observation || priorAudit.pidRecordSha256 !== pidRecordSha256) {
            return ownershipQuarantine(
                "stale-recovery-audit-mismatch",
                "existing recovery audit does not match the conclusive ownership observation",
            );
        }
        durableRemove(optimizerPidPath);
        durableRemove(armedPath);
        dependencies.log(`reclaimed conclusively dead supervisor ownership from attempt=${armed.attempt}`);
        return null;
    };

    const priorPermanent = permanent();
    if (priorPermanent) return priorPermanent;
    const recoveryStop = await recoverStaleOwnership();
    if (recoveryStop) return recoveryStop;
    try {
        await stableInputs();
        const existingTerminal = terminal();
        if (existingTerminal) {
            await stableInputs();
            heartbeat("terminal");
            return outcome("terminal", `validated ${existingTerminal.verdict} terminal`);
        }
    } catch (error) {
        return mark("invalid", "startup-validation-failed", String(error));
    }

    while (dependencies.clock.nowMs() < config.startAtMs) {
        if (dependencies.clock.requestedSignal()) return outcome("signal", "signal before immutable start");
        heartbeat("awaiting-start");
        await dependencies.clock.sleep(
            Math.min(config.heartbeatIntervalMs, config.startAtMs - dependencies.clock.nowMs()),
        );
    }

    while (true) {
        const foundPermanent = permanent();
        if (foundPermanent) return foundPermanent;
        if (dependencies.clock.nowMs() >= config.deadlineAtMs) {
            return stopAtImmutableDeadline("96-hour outer deadline reached");
        }
        if (dependencies.clock.requestedSignal()) {
            heartbeat("signal-stop");
            if (!(await controlledStop("supervisor signal"))) {
                return mark("quarantined", "process-group-survived-signal", "optimizer group survived TERM and KILL");
            }
            return outcome("signal", "controlled signal cleanup completed");
        }
        try {
            await stableInputs();
        } catch (error) {
            const invalid = mark("invalid", "provenance-drift", String(error));
            if (!(await controlledStop("provenance drift"))) {
                return mark("quarantined", "process-group-survived-invalid", "optimizer group survived TERM and KILL");
            }
            return invalid;
        }

        if (attempt >= config.maxRestarts) {
            return mark(
                "invalid",
                "restart-limit-after-recovery",
                `durable ownership already records ${attempt} attempts`,
            );
        }
        attempt += 1;
        ownerToken = randomUUID();
        writeArmed(config, {
            schemaVersion: 2,
            artifactKind: "v0_7_aligned_96h_v2_supervisor_armed",
            runFingerprint: config.runFingerprint,
            ownerToken,
            supervisorPid: dependencies.processId,
            supervisorIdentity,
            attempt,
            activationState: "pre_activation",
            childPid: null,
            childPgid: null,
            childIdentity: null,
            armedAtMs: dependencies.clock.nowMs(),
        });
        try {
            assertHealthyAssessment(
                await dependencies.probeHost({ attempt, childPgid: null, resetBaseline: true }),
                config.minimumIdleCpus,
            );
        } catch (error) {
            if (dependencies.clock.nowMs() >= config.deadlineAtMs) {
                return stopAtImmutableDeadline("deadline reached during host preflight");
            }
            if (dependencies.clock.requestedSignal()) {
                durableRemove(armedPath);
                return outcome("signal", "signal during host preflight");
            }
            const quarantined = mark("quarantined", "host-preflight-failed", String(error));
            durableRemove(armedPath);
            return quarantined;
        }
        if (dependencies.clock.nowMs() >= config.deadlineAtMs) {
            return stopAtImmutableDeadline("deadline reached during host preflight");
        }
        if (dependencies.clock.requestedSignal()) {
            durableRemove(armedPath);
            return outcome("signal", "signal during host preflight");
        }
        try {
            await stableInputs();
        } catch (error) {
            durableRemove(armedPath);
            if (dependencies.clock.nowMs() >= config.deadlineAtMs) {
                return stopAtImmutableDeadline("deadline reached before optimizer spawn");
            }
            if (dependencies.clock.requestedSignal()) return outcome("signal", "signal before optimizer spawn");
            return mark("invalid", "pre-spawn-provenance-drift", String(error));
        }
        if (dependencies.clock.nowMs() >= config.deadlineAtMs) {
            return stopAtImmutableDeadline("deadline reached before optimizer spawn");
        }
        if (dependencies.clock.requestedSignal()) {
            durableRemove(armedPath);
            return outcome("signal", "signal before optimizer spawn");
        }
        let runnerProgress: IRunnerProgressState;
        try {
            runnerProgress = runnerProgressState(dependencies.clock.nowMs());
        } catch (error) {
            durableRemove(armedPath);
            return mark("invalid", "runner-heartbeat-baseline-invalid", String(error));
        }
        heartbeat("optimizer-spawning");
        try {
            child = await dependencies.spawnOptimizer(attempt, ownerToken);
        } catch (error) {
            if (dependencies.clock.nowMs() >= config.deadlineAtMs) {
                return stopAtImmutableDeadline("deadline reached during optimizer spawn");
            }
            durableRemove(armedPath);
            if (dependencies.clock.requestedSignal()) return outcome("signal", "signal during optimizer spawn");
            if (attempt >= config.maxRestarts) {
                return mark("invalid", "spawn-restart-limit", String(error));
            }
            const delay = backoff(config, attempt);
            dependencies.log(`optimizer spawn failed attempt=${attempt}; restart backoff=${delay}ms: ${String(error)}`);
            let remaining = delay;
            while (remaining > 0) {
                if (dependencies.clock.requestedSignal()) return outcome("signal", "signal during spawn backoff");
                if (dependencies.clock.nowMs() >= config.deadlineAtMs) break;
                const step = Math.min(
                    config.heartbeatIntervalMs,
                    remaining,
                    config.deadlineAtMs - dependencies.clock.nowMs(),
                );
                heartbeat("spawn-restart-backoff");
                await dependencies.clock.sleep(step);
                remaining -= step;
            }
            continue;
        }
        try {
            const identityDeadline = Math.min(
                config.deadlineAtMs,
                dependencies.clock.nowMs() + Math.min(config.stopGraceMs, 5_000),
            );
            let childIdentity: IV07AlignedV2LinuxProcessIdentity | null;
            while (true) {
                childIdentity = dependencies.readProcessIdentity(child.pid);
                if (
                    childIdentity !== null &&
                    childIdentity.pid === child.pid &&
                    childIdentity.pgid === child.pgid &&
                    childIdentity.sid === child.pgid &&
                    child.pid === child.pgid
                ) {
                    break;
                }
                if (supervisorIdentity === null && childIdentity === null) break;
                const identityNow = dependencies.clock.nowMs();
                if (identityNow >= identityDeadline) {
                    throw new Error("spawned child did not become the setsid process-group leader");
                }
                await dependencies.clock.sleep(Math.min(10, identityDeadline - identityNow));
            }
            const startedAtMs = dependencies.clock.nowMs();
            const childOwnership = {
                schemaVersion: 2,
                artifactKind: "v0_7_aligned_96h_v2_supervisor_armed",
                runFingerprint: config.runFingerprint,
                ownerToken,
                supervisorPid: dependencies.processId,
                supervisorIdentity,
                attempt,
                armedAtMs: startedAtMs,
                childPid: child.pid,
                childPgid: child.pgid,
                childIdentity,
            } as const;
            writeArmed(config, { ...childOwnership, activationState: "pre_activation" });
            writeSelfHashed(
                optimizerPidPath,
                {
                    schemaVersion: 2,
                    artifactKind: "v0_7_aligned_96h_v2_optimizer_pid",
                    runFingerprint: config.runFingerprint,
                    attempt,
                    pid: child.pid,
                    pgid: child.pgid,
                    identity: childIdentity,
                    ownerToken,
                    startedAtMs,
                },
                "pidRecordSha256",
            );
            writeArmed(config, { ...childOwnership, activationState: "activated" });
            await child.activate(ownerToken);
        } catch (error) {
            if (!(await controlledStop("optimizer activation failed"))) {
                return mark(
                    "quarantined",
                    "process-group-survived-activation-failure",
                    "optimizer guard group survived activation cleanup",
                );
            }
            return mark("invalid", "optimizer-activation-failed", String(error));
        }
        dependencies.log(`optimizer attempt=${attempt} pid=${child.pid} pgid=${child.pgid}`);

        let lastTickMs = dependencies.clock.nowMs();
        let lastProbeMs = lastTickMs;
        let restartStatus: number | null = null;
        while (child) {
            const now = dependencies.clock.nowMs();
            if (dependencies.clock.requestedSignal()) {
                heartbeat("signal-stop");
                if (!(await controlledStop("supervisor signal"))) {
                    return mark(
                        "quarantined",
                        "process-group-survived-signal",
                        "optimizer group survived TERM and KILL",
                    );
                }
                return outcome("signal", "controlled signal cleanup completed");
            }
            if (now >= config.deadlineAtMs) {
                return stopAtImmutableDeadline("96-hour outer deadline reached");
            }
            if (now - lastTickMs > config.watchdogMs) {
                const quarantined = mark(
                    "quarantined",
                    "supervisor-watchdog-lapse",
                    `heartbeat loop lapsed ${now - lastTickMs}ms (limit ${config.watchdogMs}ms)`,
                );
                if (!(await controlledStop("watchdog lapse"))) {
                    return mark(
                        "quarantined",
                        "process-group-survived-watchdog",
                        "optimizer group survived TERM and KILL",
                    );
                }
                return quarantined;
            }
            lastTickMs = now;
            try {
                const foundTerminal = terminal();
                if (foundTerminal) {
                    await stableInputs();
                    if (!(await controlledStop("validated research-only terminal"))) {
                        return mark(
                            "quarantined",
                            "process-group-survived-terminal",
                            "optimizer group survived TERM and KILL",
                        );
                    }
                    heartbeat("terminal");
                    return outcome("terminal", `validated ${foundTerminal.verdict} terminal`);
                }
            } catch (error) {
                const invalid = mark("invalid", "terminal-validation-failed", String(error));
                if (!(await controlledStop("invalid terminal"))) {
                    return mark(
                        "quarantined",
                        "process-group-survived-invalid",
                        "optimizer group survived TERM and KILL",
                    );
                }
                return invalid;
            }
            const progressFailure = inspectRunnerProgress(runnerProgress, now);
            if (progressFailure) {
                const stopped = mark(progressFailure.stop, progressFailure.reason, progressFailure.detail);
                if (!(await controlledStop(progressFailure.reason))) {
                    return mark(
                        "quarantined",
                        "process-group-survived-runner-watchdog",
                        "optimizer group survived runner progress watchdog cleanup",
                    );
                }
                return stopped;
            }
            if (now - lastProbeMs >= config.hostProbeIntervalMs) {
                try {
                    assertHealthyAssessment(
                        await dependencies.probeHost({ attempt, childPgid: child.pgid, resetBaseline: false }),
                        config.minimumIdleCpus,
                    );
                    lastProbeMs = dependencies.clock.nowMs();
                } catch (error) {
                    if (dependencies.clock.requestedSignal()) {
                        if (!(await controlledStop("supervisor signal"))) {
                            return mark(
                                "quarantined",
                                "process-group-survived-signal",
                                "optimizer group survived TERM and KILL",
                            );
                        }
                        return outcome("signal", "signal during ongoing host probe");
                    }
                    if (dependencies.clock.nowMs() >= config.deadlineAtMs) {
                        return stopAtImmutableDeadline("deadline reached during ongoing host probe");
                    }
                    const quarantined = mark("quarantined", "host-ongoing-failed", String(error));
                    if (!(await controlledStop("host contention quarantine"))) {
                        return mark(
                            "quarantined",
                            "process-group-survived-quarantine",
                            "optimizer group survived TERM and KILL",
                        );
                    }
                    return quarantined;
                }
            }
            const poll = await child.poll();
            heartbeat("optimizer-running");
            if (!poll.alive) {
                restartStatus = poll.exitCode ?? 1;
                const exited = child;
                child = null;
                durableRemove(optimizerPidPath);
                try {
                    assertHealthyAssessment(
                        await dependencies.probeHost({ attempt, childPgid: exited.pgid, resetBaseline: false }),
                        config.minimumIdleCpus,
                    );
                } catch (error) {
                    if (dependencies.clock.requestedSignal()) {
                        durableRemove(armedPath);
                        return outcome("signal", "signal during post-exit host probe");
                    }
                    if (dependencies.clock.nowMs() >= config.deadlineAtMs) {
                        return stopAtImmutableDeadline("deadline reached during post-exit host probe");
                    }
                    const quarantined = mark("quarantined", "host-post-exit-failed", String(error));
                    durableRemove(armedPath);
                    return quarantined;
                }
                durableRemove(armedPath);
                break;
            }
            await dependencies.clock.sleep(config.heartbeatIntervalMs);
        }

        try {
            const foundTerminal = terminal();
            if (foundTerminal) {
                await stableInputs();
                heartbeat("terminal");
                return outcome("terminal", `validated ${foundTerminal.verdict} terminal`);
            }
        } catch (error) {
            return mark("invalid", "terminal-validation-failed", String(error));
        }
        if (dependencies.clock.nowMs() >= config.deadlineAtMs) {
            return stopAtImmutableDeadline("deadline reached after optimizer exit");
        }
        if (restartStatus === 0) {
            return mark("invalid", "zero-exit-without-terminal", "optimizer exited successfully without TERMINAL.json");
        }
        if (restartStatus === 97 || restartStatus === 121 || restartStatus === 128) {
            return mark(
                "quarantined",
                "independent-watchdog-stop",
                `optimizer session guard exited with reserved watchdog/guard-signal status ${restartStatus}`,
            );
        }
        if (restartStatus === 120) {
            return mark(
                "deadline",
                "independent-deadline-stop",
                "optimizer session guard reached the immutable deadline",
            );
        }
        if (attempt >= config.maxRestarts) {
            return mark("invalid", "restart-limit", `optimizer failed ${attempt} times; last status ${restartStatus}`);
        }
        const delay = backoff(config, attempt);
        dependencies.log(`optimizer exited status=${restartStatus}; restart backoff=${delay}ms`);
        let remaining = delay;
        while (remaining > 0) {
            if (dependencies.clock.requestedSignal()) return outcome("signal", "signal during restart backoff");
            if (dependencies.clock.nowMs() >= config.deadlineAtMs) break;
            const step = Math.min(
                config.heartbeatIntervalMs,
                remaining,
                config.deadlineAtMs - dependencies.clock.nowMs(),
            );
            heartbeat("restart-backoff");
            await dependencies.clock.sleep(step);
            remaining -= step;
        }
    }
}

function git(root: string, args: readonly string[]): string {
    return execFileSync("git", [...args], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        timeout: 30_000,
        killSignal: "SIGKILL",
    }).trim();
}

function normalizeOrigin(value: string): string {
    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/^git@/, "")
        .replace(/^https?:\/\//, "")
        .replace(":", "/")
        .replace(/\.git$/, "")
        .replace(/\/+$/, "");
    return normalized;
}

function sourceTreeSha256(root: string): string {
    const names = decodeUtf8(execFileSync("git", ["ls-files", "-z"], { cwd: root }), "git tracked path list")
        .split("\0")
        .filter(Boolean)
        .sort();
    const hash = createHash("sha256");
    for (const name of names)
        hash.update(name)
            .update("\0")
            .update(readFileSync(join(root, name)))
            .update("\0");
    return hash.digest("hex");
}

export interface IV07AlignedV2DependencyManifest {
    packages: number;
    files: number;
    directories: number;
    links: number;
    sha256: string;
}

/** Bind the complete installed dependency tree, not only package metadata. */
export function captureV07AlignedV2DependencyManifest(root: string): IV07AlignedV2DependencyManifest {
    const repositoryRoot = realpathSync(root);
    const nodeModules = join(repositoryRoot, "node_modules");
    if (!pathEntryExists(nodeModules)) throw new Error("node_modules is missing");
    const nodeModulesStats = lstatSync(nodeModules);
    if (nodeModulesStats.isSymbolicLink() || !nodeModulesStats.isDirectory()) {
        throw new Error("node_modules must be a regular non-symlink directory");
    }
    const treeHash = createHash("sha256").update("hoc/v0.7/aligned-96h-v2/dependency-tree/v1\0");
    let files = 0;
    let directories = 0;
    let links = 0;
    const canonicalPath = (path: string): string => relative(repositoryRoot, path).split(sep).join("/");
    const mode = (value: number): string => (value & 0o7777).toString(8).padStart(4, "0");
    const recordHeader = (type: "directory" | "file" | "link", path: string, entryMode: number): void => {
        treeHash
            .update(type)
            .update("\0")
            .update(canonicalPath(path))
            .update("\0")
            .update(mode(entryMode))
            .update("\0");
    };
    const visitTree = (path: string): void => {
        const stats = lstatSync(path);
        if (stats.isDirectory()) {
            directories += 1;
            recordHeader("directory", path, stats.mode);
            const entries = readdirSync(path).sort((left, right) => (left === right ? 0 : left < right ? -1 : 1));
            for (const entry of entries) visitTree(join(path, entry));
            return;
        }
        if (stats.isFile()) {
            const raw = readFileSync(path);
            if (raw.byteLength !== stats.size) {
                throw new Error(`installed dependency changed while hashing: ${canonicalPath(path)}`);
            }
            files += 1;
            recordHeader("file", path, stats.mode);
            treeHash.update(String(raw.byteLength)).update("\0").update(raw).update("\0");
            return;
        }
        if (stats.isSymbolicLink()) {
            const relativeToNodeModules = relative(nodeModules, path).split(sep);
            if (relativeToNodeModules.length !== 2 || relativeToNodeModules[0] !== ".bin") {
                throw new Error(`installed dependency contains an unsafe symlink: ${canonicalPath(path)}`);
            }
            const target = readlinkSync(path);
            const resolvedTarget = resolve(dirname(path), target);
            const realTarget = realpathSync(resolvedTarget);
            const targetStats = lstatSync(realTarget);
            if (
                !realTarget.startsWith(`${nodeModules}${sep}`) ||
                targetStats.isSymbolicLink() ||
                !targetStats.isFile()
            ) {
                throw new Error(
                    `installed dependency executable link escapes its regular file tree: ${canonicalPath(path)}`,
                );
            }
            links += 1;
            recordHeader("link", path, stats.mode);
            treeHash.update(target).update("\0");
            return;
        }
        throw new Error(`installed dependency contains a nonregular entry: ${canonicalPath(path)}`);
    };
    visitTree(nodeModules);

    const packages: { location: string; name: string; version: string; packageJsonSha256: string }[] = [];
    const visitPackage = (directory: string): void => {
        const packagePath = join(directory, "package.json");
        if (!pathEntryExists(packagePath)) throw new Error(`installed dependency lacks package.json: ${directory}`);
        const raw = readFileSync(packagePath);
        const parsed = JSON.parse(decodeUtf8(raw, `dependency package ${packagePath}`)) as {
            name?: unknown;
            version?: unknown;
        };
        if (typeof parsed.name !== "string" || typeof parsed.version !== "string") {
            throw new Error(`installed dependency lacks name/version: ${packagePath}`);
        }
        packages.push({
            location: relative(repositoryRoot, directory),
            name: parsed.name,
            version: parsed.version,
            packageJsonSha256: sha256(raw),
        });
        const nested = join(directory, "node_modules");
        if (pathEntryExists(nested)) visitNodeModules(nested);
    };
    const visitNodeModules = (directory: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
            a.name.localeCompare(b.name),
        )) {
            if (entry.name.startsWith(".") || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
            const entryPath = join(directory, entry.name);
            if (entry.name.startsWith("@")) {
                for (const scoped of readdirSync(entryPath, { withFileTypes: true }).sort((a, b) =>
                    a.name.localeCompare(b.name),
                )) {
                    if (scoped.isDirectory() || scoped.isSymbolicLink()) visitPackage(join(entryPath, scoped.name));
                }
            } else visitPackage(entryPath);
        }
    };
    visitNodeModules(nodeModules);
    packages.sort((left, right) => left.location.localeCompare(right.location));
    const unsigned = {
        schemaVersion: 1 as const,
        algorithm: "canonical_path_mode_type_and_raw_bytes_v1" as const,
        packages: packages.length,
        files,
        directories,
        links,
        treeSha256: treeHash.digest("hex"),
    };
    return { packages: packages.length, files, directories, links, sha256: fingerprintV07AlignedV2(unsigned) };
}

interface IComposedSealArtifact {
    path: string;
    sha256: string;
}

interface IComposedSealLedgerEntry extends IComposedSealArtifact {
    sequence: number;
    phase: string;
    checkedAt: string;
    snapshotSha256: string;
}

interface IComposedSealCellEvidence {
    cellId: string;
    completion: IComposedSealArtifact;
    raw: IComposedSealArtifact;
    audits: IComposedSealArtifact[];
}

function readPrettyRegularJson(path: string, label: string): { raw: Buffer; value: unknown } {
    if (!pathEntryExists(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
        throw new Error(`${label} must be a regular non-symlink file`);
    }
    const raw = readFileSync(path);
    const text = decodeUtf8(raw, label);
    if (!text.endsWith("\n")) throw new Error(`${label} lacks a terminal newline`);
    const value = JSON.parse(text) as unknown;
    if (`${JSON.stringify(value, null, 2)}\n` !== text) throw new Error(`${label} is not exact pretty JSON`);
    return { raw, value };
}

function readRegularJson(path: string, label: string): unknown {
    if (!pathEntryExists(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
        throw new Error(`${label} must be a regular non-symlink file`);
    }
    return JSON.parse(readUtf8(path, label)) as unknown;
}

function sealedEvidenceFile(root: string, relativePath: unknown, label: string): string {
    if (typeof relativePath !== "string" || !relativePath || isAbsolute(relativePath)) {
        throw new Error(`${label} must be a nonempty relative path`);
    }
    const lexical = resolve(root, relativePath);
    const fromRoot = relative(root, lexical);
    if (!fromRoot || fromRoot.startsWith(`..${sep}`) || fromRoot === "..") {
        throw new Error(`${label} escapes the composed seal root`);
    }
    if (!pathEntryExists(lexical) || lstatSync(lexical).isSymbolicLink() || !lstatSync(lexical).isFile()) {
        throw new Error(`${label} must resolve to a regular non-symlink file`);
    }
    const actual = realpathSync(lexical);
    if (!actual.startsWith(`${root}${sep}`)) throw new Error(`${label} traverses outside the composed seal root`);
    return actual;
}

function verifySealedArtifact(root: string, artifact: unknown, label: string): void {
    if (!isObject(artifact) || !exactKeys(artifact, ["path", "sha256"])) {
        throw new Error(`${label} descriptor fields are not exact`);
    }
    requireSha256(artifact.sha256, `${label}.sha256`);
    const path = sealedEvidenceFile(root, artifact.path, `${label}.path`);
    if (sha256(readFileSync(path)) !== artifact.sha256) throw new Error(`${label} bytes changed after composed seal`);
}

export function validateV07AlignedV2ComposedSeal(
    path: string,
    expectedSha256: string,
): IV07AlignedV2ComposedSealAttestation {
    requireSha256(expectedSha256, "expected composed seal SHA-256");
    if (basename(path) !== "sealed-run.json") throw new Error("composed predecessor must be named sealed-run.json");
    const root = realpathSync(dirname(path));
    const loaded = readPrettyRegularJson(path, "composed sealed-run.json");
    if (sha256(loaded.raw) !== expectedSha256) throw new Error("composed sealed-run raw SHA-256 mismatch");
    if (
        !isObject(loaded.value) ||
        !exactKeys(loaded.value, [
            "schemaVersion",
            "manifestId",
            "manifestPath",
            "manifestSha256",
            "guardContractPath",
            "guardContractSha256",
            "initialSnapshotPath",
            "initialSnapshotSha256",
            "prelaunchCheckpointPath",
            "prelaunchCheckpointSha256",
            "prelaunchLedgerPath",
            "prelaunchLedgerSha256",
            "prelaunchEntries",
            "prelaunchFirstCapturedAt",
            "prelaunchLastCapturedAt",
            "guardIntervalMs",
            "maxGuardGapMs",
            "guardLedger",
            "guardLedgerSha256",
            "finalReportPath",
            "finalReportSha256",
            "cellEvidence",
            "cellEvidenceSha256",
            "qualificationVerdict",
            "sealedAt",
            "guardPassed",
        ])
    )
        throw new Error("composed sealed-run fields are not exact");
    const seal = loaded.value;
    if (
        seal.schemaVersion !== 1 ||
        seal.guardPassed !== true ||
        seal.guardIntervalMs !== 60_000 ||
        seal.maxGuardGapMs !== 90_000 ||
        typeof seal.manifestId !== "string" ||
        !seal.manifestId.trim() ||
        basename(root) !== seal.manifestId ||
        !(["PASS", "FAIL"] as const).includes(seal.qualificationVerdict as "PASS" | "FAIL") ||
        !Number.isSafeInteger(seal.prelaunchEntries) ||
        (seal.prelaunchEntries as number) < 2 ||
        !Number.isFinite(Date.parse(String(seal.prelaunchFirstCapturedAt))) ||
        !Number.isFinite(Date.parse(String(seal.prelaunchLastCapturedAt))) ||
        Date.parse(String(seal.prelaunchFirstCapturedAt)) > Date.parse(String(seal.prelaunchLastCapturedAt)) ||
        !Number.isFinite(Date.parse(String(seal.sealedAt)))
    )
        throw new Error("composed sealed-run header, verdict, or timing policy is invalid");
    const maxGuardGapMs = seal.maxGuardGapMs as number;
    const fixedArtifacts = [
        [seal.manifestPath, seal.manifestSha256, "manifest.json", "manifest"],
        [seal.guardContractPath, seal.guardContractSha256, "zinc-guard/contract.json", "guard contract"],
        [seal.initialSnapshotPath, seal.initialSnapshotSha256, "zinc-guard/initial-source.json", "initial snapshot"],
        [
            seal.prelaunchCheckpointPath,
            seal.prelaunchCheckpointSha256,
            "zinc-guard/prelaunch/checkpoint.json",
            "prelaunch checkpoint",
        ],
        [
            seal.prelaunchLedgerPath,
            seal.prelaunchLedgerSha256,
            "zinc-guard/prelaunch/ledger-source.json",
            "prelaunch ledger",
        ],
        [seal.finalReportPath, seal.finalReportSha256, "final-report.json", "final report"],
    ] as const;
    for (const [artifactPath, artifactSha256, expectedPath, label] of fixedArtifacts) {
        if (artifactPath !== expectedPath) throw new Error(`composed ${label} path is not exact`);
        verifySealedArtifact(root, { path: artifactPath, sha256: artifactSha256 }, `composed ${label}`);
    }
    const prelaunchEntries = seal.prelaunchEntries as number;
    if (!Array.isArray(seal.guardLedger) || seal.guardLedger.length <= prelaunchEntries) {
        throw new Error("composed guard ledger is incomplete relative to prelaunch evidence");
    }
    requireSha256(seal.guardLedgerSha256, "composed guardLedgerSha256");
    const guardLedger = seal.guardLedger as IComposedSealLedgerEntry[];
    const guardLedgerBytes = `${JSON.stringify(guardLedger, null, 2)}\n`;
    if (sha256(guardLedgerBytes) !== seal.guardLedgerSha256) {
        throw new Error("composed guard ledger aggregate hash mismatch");
    }
    const persistedGuardLedger = sealedEvidenceFile(root, "zinc-guard/ledger.json", "guard ledger publication");
    if (readUtf8(persistedGuardLedger, "composed guard ledger publication") !== guardLedgerBytes) {
        throw new Error("composed guard ledger publication differs from sealed-run.json");
    }
    let priorCheckedAt = -1;
    let priorLogText: string | null = null;
    let firstGuardSnapshot: unknown;
    const guardPaths = new Set<string>();
    const postPhases = new Set(["pre", "periodic", "post-cell", "post-combat", "post-assembly"]);
    guardLedger.forEach((entry, index) => {
        if (
            !isObject(entry) ||
            !exactKeys(entry, ["sequence", "phase", "path", "sha256", "checkedAt", "snapshotSha256"]) ||
            entry.sequence !== index ||
            typeof entry.phase !== "string" ||
            !entry.phase ||
            typeof entry.checkedAt !== "string" ||
            !Number.isFinite(Date.parse(entry.checkedAt))
        ) {
            throw new Error(`composed guard ledger entry ${index} is malformed or non-contiguous`);
        }
        requireSha256(entry.sha256, `guard ledger ${index}.sha256`);
        requireSha256(entry.snapshotSha256, `guard ledger ${index}.snapshotSha256`);
        const expectedPhase = index < prelaunchEntries ? (index === 0 ? "initial" : "periodic") : entry.phase;
        if (entry.phase !== expectedPhase || (index >= prelaunchEntries && !postPhases.has(entry.phase))) {
            throw new Error(`composed guard ledger entry ${index} has an invalid phase`);
        }
        const expectedPath =
            index < prelaunchEntries
                ? `zinc-guard/prelaunch/artifacts/${String(index).padStart(4, "0")}-${entry.phase}.json`
                : `zinc-guard/${String(index).padStart(4, "0")}-${entry.phase}.json`;
        if (entry.path !== expectedPath) throw new Error(`composed guard ledger entry ${index} path is not exact`);
        if (guardPaths.has(entry.path)) throw new Error(`composed guard ledger repeats path ${entry.path}`);
        guardPaths.add(entry.path);
        const checkedAt = Date.parse(entry.checkedAt);
        if (priorCheckedAt > checkedAt || (priorCheckedAt >= 0 && checkedAt - priorCheckedAt > maxGuardGapMs)) {
            throw new Error("composed guard ledger has a regression or excessive observation gap");
        }
        priorCheckedAt = checkedAt;
        verifySealedArtifact(root, { path: entry.path, sha256: entry.sha256 }, `guard ledger ${index}`);
        const artifact = readPrettyRegularJson(
            sealedEvidenceFile(root, entry.path, `guard ledger ${index}`),
            `guard ledger ${index} artifact`,
        ).value;
        if (!isObject(artifact) || !exactKeys(artifact, ["phase", "result", "snapshot"])) {
            throw new Error(`composed guard ledger artifact ${index} fields are not exact`);
        }
        if (!isObject(artifact.result) || !isObject(artifact.snapshot)) {
            throw new Error(`composed guard ledger artifact ${index} payload is malformed`);
        }
        const snapshotBytes = `${JSON.stringify(artifact.snapshot, null, 2)}\n`;
        if (
            artifact.phase !== entry.phase ||
            artifact.result.passed !== true ||
            artifact.result.checkedAt !== entry.checkedAt ||
            artifact.result.snapshotSha256 !== entry.snapshotSha256 ||
            artifact.snapshot.capturedAt !== entry.checkedAt ||
            sha256(snapshotBytes) !== entry.snapshotSha256 ||
            typeof artifact.snapshot.logText !== "string" ||
            (priorLogText !== null && !artifact.snapshot.logText.startsWith(priorLogText))
        ) {
            throw new Error(`composed guard ledger artifact ${index} does not bind its observation`);
        }
        firstGuardSnapshot ??= artifact.snapshot;
        priorLogText = artifact.snapshot.logText;
    });
    if (
        guardLedger[0].checkedAt !== seal.prelaunchFirstCapturedAt ||
        guardLedger[prelaunchEntries - 1].checkedAt !== seal.prelaunchLastCapturedAt ||
        guardLedger[prelaunchEntries].phase !== "pre" ||
        guardLedger.at(-1)?.phase !== "post-assembly"
    ) {
        throw new Error("composed guard ledger does not bind its prelaunch range and final phases");
    }
    const initialArtifact = readRegularJson(
        sealedEvidenceFile(root, seal.initialSnapshotPath, "initial snapshot"),
        "composed initial snapshot",
    );
    const initialSnapshot =
        isObject(initialArtifact) && "snapshot" in initialArtifact ? initialArtifact.snapshot : initialArtifact;
    if (JSON.stringify(initialSnapshot) !== JSON.stringify(firstGuardSnapshot)) {
        throw new Error("composed initial snapshot differs from the first guard observation");
    }
    const prelaunchLedger = readRegularJson(
        sealedEvidenceFile(root, seal.prelaunchLedgerPath, "prelaunch ledger"),
        "composed prelaunch ledger",
    );
    if (
        !isObject(prelaunchLedger) ||
        prelaunchLedger.schemaVersion !== 1 ||
        prelaunchLedger.guardIntervalMs !== seal.guardIntervalMs ||
        prelaunchLedger.maxGuardGapMs !== seal.maxGuardGapMs ||
        prelaunchLedger.startedAt !== seal.prelaunchFirstCapturedAt ||
        prelaunchLedger.updatedAt !== seal.prelaunchLastCapturedAt ||
        !(prelaunchLedger.status === "monitoring" || prelaunchLedger.status === "stopped") ||
        !Array.isArray(prelaunchLedger.entries) ||
        prelaunchLedger.entries.length !== prelaunchEntries
    ) {
        throw new Error("composed prelaunch ledger does not bind the sealed prelaunch range");
    }
    prelaunchLedger.entries.forEach((sourceEntry, index) => {
        const sealedEntry = guardLedger[index];
        if (
            !isObject(sourceEntry) ||
            !exactKeys(sourceEntry, ["sequence", "phase", "path", "sha256", "checkedAt", "snapshotSha256"]) ||
            sourceEntry.sequence !== sealedEntry.sequence ||
            sourceEntry.phase !== sealedEntry.phase ||
            `zinc-guard/prelaunch/${String(sourceEntry.path)}` !== sealedEntry.path ||
            sourceEntry.sha256 !== sealedEntry.sha256 ||
            sourceEntry.checkedAt !== sealedEntry.checkedAt ||
            sourceEntry.snapshotSha256 !== sealedEntry.snapshotSha256
        ) {
            throw new Error(`composed prelaunch ledger entry ${index} differs from the sealed guard ledger`);
        }
    });
    const checkpoint = readRegularJson(
        sealedEvidenceFile(root, seal.prelaunchCheckpointPath, "prelaunch checkpoint"),
        "composed prelaunch checkpoint",
    );
    if (
        !isObject(checkpoint) ||
        checkpoint.schemaVersion !== 1 ||
        checkpoint.guardIntervalMs !== seal.guardIntervalMs ||
        checkpoint.maxGuardGapMs !== seal.maxGuardGapMs ||
        !Array.isArray(checkpoint.entries) ||
        checkpoint.entries.length < 2 ||
        checkpoint.entries.length > prelaunchEntries ||
        JSON.stringify(checkpoint.entries) !==
            JSON.stringify(prelaunchLedger.entries.slice(0, checkpoint.entries.length))
    ) {
        throw new Error("composed prelaunch checkpoint is not an exact prefix of the sealed guard ledger");
    }
    const sealedAtMs = Date.parse(String(seal.sealedAt));
    if (priorCheckedAt < 0 || sealedAtMs < priorCheckedAt || sealedAtMs - priorCheckedAt > maxGuardGapMs) {
        throw new Error("composed sealed-run was not published inside the final guard window");
    }
    const contract = JSON.parse(
        readUtf8(sealedEvidenceFile(root, seal.guardContractPath, "guard contract"), "composed guard contract"),
    ) as {
        sealBefore?: unknown;
    };
    if (
        typeof contract.sealBefore !== "string" ||
        !Number.isFinite(Date.parse(contract.sealBefore)) ||
        sealedAtMs > Date.parse(contract.sealBefore)
    ) {
        throw new Error("composed sealed-run exceeds its guard contract seal deadline");
    }
    if (!Array.isArray(seal.cellEvidence) || seal.cellEvidence.length === 0) {
        throw new Error("composed sealed-run has no cell evidence");
    }
    requireSha256(seal.cellEvidenceSha256, "composed cellEvidenceSha256");
    const cellEvidence = seal.cellEvidence as IComposedSealCellEvidence[];
    if (sha256(`${JSON.stringify(cellEvidence, null, 2)}\n`) !== seal.cellEvidenceSha256) {
        throw new Error("composed cell evidence aggregate hash mismatch");
    }
    const manifest = JSON.parse(
        readUtf8(sealedEvidenceFile(root, seal.manifestPath, "manifest"), "composed manifest"),
    ) as unknown;
    if (!isObject(manifest) || manifest.manifestId !== seal.manifestId || !Array.isArray(manifest.cells)) {
        throw new Error("composed manifest identity or cell inventory is malformed");
    }
    const manifestCellIds = manifest.cells.map((cell, index) => {
        if (!isObject(cell) || typeof cell.id !== "string" || !cell.id) {
            throw new Error(`composed manifest cell ${index} has no valid id`);
        }
        return cell.id;
    });
    const cellIds = new Set<string>();
    const completionEvidenceHash = createHash("sha256");
    cellEvidence.forEach((cell, index) => {
        if (
            !isObject(cell) ||
            !exactKeys(cell, ["cellId", "completion", "raw", "audits"]) ||
            typeof cell.cellId !== "string" ||
            !cell.cellId ||
            cellIds.has(cell.cellId) ||
            !Array.isArray(cell.audits) ||
            cell.audits.length === 0
        )
            throw new Error(`composed cell evidence ${index} is malformed or duplicated`);
        cellIds.add(cell.cellId);
        if ((cell.completion as IComposedSealArtifact).path !== `cells/${cell.cellId}/complete.json`) {
            throw new Error(`composed cell ${cell.cellId} completion path is not exact`);
        }
        if ((cell.raw as IComposedSealArtifact).path !== `cells/${cell.cellId}/raw.jsonl`) {
            throw new Error(`composed cell ${cell.cellId} raw path is not exact`);
        }
        verifySealedArtifact(root, cell.completion, `cell ${cell.cellId} completion`);
        verifySealedArtifact(root, cell.raw, `cell ${cell.cellId} raw`);
        const auditPaths = new Set<string>();
        cell.audits.forEach((audit, auditIndex) => {
            if (
                !isObject(audit) ||
                typeof audit.path !== "string" ||
                !audit.path.startsWith(`cells/${cell.cellId}/audit/`) ||
                auditPaths.has(audit.path)
            ) {
                throw new Error(`composed cell ${cell.cellId} audit ${auditIndex} path is invalid or duplicated`);
            }
            auditPaths.add(audit.path);
            verifySealedArtifact(root, audit, `cell ${cell.cellId} audit ${auditIndex}`);
        });
        const completionPath = sealedEvidenceFile(root, cell.completion.path, `cell ${cell.cellId} completion`);
        const completionBytes = readFileSync(completionPath);
        const completion = JSON.parse(decodeUtf8(completionBytes, `cell ${cell.cellId} completion`)) as unknown;
        if (
            !isObject(completion) ||
            completion.cellId !== cell.cellId ||
            !isObject(completion.raw) ||
            completion.raw.path !== cell.raw.path ||
            completion.raw.sha256 !== cell.raw.sha256 ||
            !Array.isArray(completion.audits) ||
            completion.audits.length !== cell.audits.length ||
            completion.audits.some(
                (audit, auditIndex) =>
                    !isObject(audit) ||
                    audit.path !== cell.audits[auditIndex].path ||
                    audit.sha256 !== cell.audits[auditIndex].sha256,
            )
        ) {
            throw new Error(`composed cell ${cell.cellId} completion does not bind its sealed raw/audit evidence`);
        }
        completionEvidenceHash.update(cell.completion.path).update("\0").update(completionBytes).update("\0");
    });
    if (JSON.stringify(manifestCellIds) !== JSON.stringify(cellEvidence.map((cell) => cell.cellId))) {
        throw new Error("composed sealed cell evidence is not complete in manifest order");
    }
    const finalReport = JSON.parse(
        readUtf8(sealedEvidenceFile(root, seal.finalReportPath, "final report"), "composed final report"),
    ) as unknown;
    if (
        !isObject(finalReport) ||
        finalReport.schemaVersion !== 1 ||
        finalReport.manifestId !== seal.manifestId ||
        finalReport.manifestSha256 !== seal.manifestSha256 ||
        finalReport.authority !== "UNSEALED_NON_AUTHORITATIVE_UNTIL_GUARD_SEAL" ||
        finalReport.allCellsComplete !== true ||
        finalReport.releaseInstruction !== "NO_AUTOMATIC_BAKE_OR_DEPLOY" ||
        !isObject(finalReport.completionEvidence) ||
        finalReport.completionEvidence.derivation !== "sha256_manifest_ordered_completion_marker_paths_and_bytes" ||
        finalReport.completionEvidence.markers !== cellEvidence.length ||
        finalReport.completionEvidence.sha256 !== completionEvidenceHash.digest("hex") ||
        !isObject(finalReport.qualification) ||
        finalReport.qualification.verdict !== seal.qualificationVerdict
    ) {
        throw new Error("composed final report does not bind the sealed manifest, completions, and verdict");
    }
    return {
        manifestId: seal.manifestId,
        qualificationVerdict: seal.qualificationVerdict as "PASS" | "FAIL",
        sealedAt: seal.sealedAt as string,
        sha256: expectedSha256,
    };
}

export function captureV07AlignedV2SupervisorProvenance(
    root: string,
    pinnedLiveOriginMain?: string,
): IV07AlignedV2SupervisorProvenance {
    const commit = git(root, ["rev-parse", "HEAD"]);
    const branch = git(root, ["branch", "--show-current"]);
    const originMain = git(root, ["rev-parse", "origin/main"]);
    let liveOriginMain: string;
    if (pinnedLiveOriginMain === undefined) {
        const remoteRows = git(root, ["ls-remote", "--exit-code", "origin", "refs/heads/main"])
            .split(/\r?\n/)
            .filter(Boolean);
        if (remoteRows.length !== 1) throw new Error("expected exactly one live origin/main row");
        liveOriginMain = remoteRows[0].split(/\s+/, 1)[0];
    } else {
        if (!COMMIT_PATTERN.test(pinnedLiveOriginMain)) {
            throw new Error("pinned live origin/main provenance must be a commit hash");
        }
        liveOriginMain = pinnedLiveOriginMain;
    }
    const originUrl = git(root, ["remote", "get-url", "origin"]);
    const originIdentity = normalizeOrigin(originUrl);
    const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (
        !COMMIT_PATTERN.test(commit) ||
        branch !== "main" ||
        originMain !== commit ||
        originIdentity !== EXPECTED_ORIGIN ||
        status !== ""
    ) {
        throw new Error("aligned v2 supervisor requires a clean pushed main checkout of heroes-of-crypto-common");
    }
    const dependencies = captureV07AlignedV2DependencyManifest(root);
    const lockfile = ["bun.lock", "bun.lockb"].map((name) => join(root, name)).find(pathEntryExists);
    const unsigned = {
        schemaVersion: 1 as const,
        commit,
        branch: "main" as const,
        originMain,
        liveOriginMain,
        originUrl,
        originIdentity,
        cleanIncludingUntracked: true as const,
        statusPorcelainSha256: sha256(status),
        sourceTreeSha256: sourceTreeSha256(root),
        bunVersion: execFileSync(process.execPath, ["--version"], { encoding: "utf8" }).trim(),
        bunRevision: execFileSync(process.execPath, ["--revision"], { encoding: "utf8" }).trim(),
        bunExecutableSha256: sha256(readFileSync(process.execPath)),
        dependencyPackages: dependencies.packages,
        dependencyManifestSha256: dependencies.sha256,
        lockfileSha256: lockfile ? sha256(readFileSync(lockfile)) : null,
    };
    return { ...unsigned, provenanceSha256: fingerprintV07AlignedV2(unsigned) };
}

function validateTerminalShape(value: unknown, expectedRun: string): IV07AlignedV2OrchestratorTerminal {
    if (
        !isObject(value) ||
        !exactKeys(value, [
            "schemaVersion",
            "status",
            "automaticBake",
            "automaticDeploy",
            "runFingerprint",
            "frozenCandidateSha256",
            "reason",
            "verdict",
            "promotion",
            "final",
            "terminalSha256",
        ])
    )
        throw new Error("aligned v2 TERMINAL.json has non-exact fields");
    const { terminalSha256, ...unsigned } = value;
    if (
        value.schemaVersion !== 1 ||
        value.status !== "research_only_no_bake" ||
        value.automaticBake !== false ||
        value.automaticDeploy !== false ||
        value.runFingerprint !== expectedRun ||
        typeof terminalSha256 !== "string" ||
        terminalSha256 !== fingerprintV07AlignedV2(unsigned)
    )
        throw new Error("aligned v2 TERMINAL.json failed research-only/run/self-hash validation");
    return value as unknown as IV07AlignedV2OrchestratorTerminal;
}

export function validateV07AlignedV2TerminalReplay(
    outputDirectory: string,
    definition: IV07AlignedV2OrchestratorDefinition,
    resolvers: IV07AlignedV2OrchestratorReplayResolvers,
): IV07AlignedV2OrchestratorTerminal | null {
    const terminalPath = join(outputDirectory, "TERMINAL.json");
    if (!pathEntryExists(terminalPath)) return null;
    const rootEntries = readdirSync(outputDirectory).sort();
    if (
        canonicalV07AlignedV2Json(rootEntries) !==
        canonicalV07AlignedV2Json(["CURRENT", "TERMINAL.json", "quarantine", "run.json", "transitions"])
    )
        throw new Error("terminal orchestration root inventory is not exact");
    const persistedDefinition = readCanonicalRegularJson(join(outputDirectory, "run.json"), "run.json");
    if (canonicalV07AlignedV2Json(persistedDefinition) !== canonicalV07AlignedV2Json(definition)) {
        throw new Error("orchestration run.json differs from the immutable supervisor definition");
    }
    const terminal = validateTerminalShape(
        readCanonicalRegularJson(terminalPath, "TERMINAL.json"),
        definition.definitionSha256,
    );
    const transitionsDirectory = join(outputDirectory, "transitions");
    if (
        !pathEntryExists(transitionsDirectory) ||
        lstatSync(transitionsDirectory).isSymbolicLink() ||
        !statSync(transitionsDirectory).isDirectory()
    ) {
        throw new Error("TERMINAL.json exists without durable transition directory");
    }
    const quarantineDirectory = join(outputDirectory, "quarantine");
    if (
        !pathEntryExists(quarantineDirectory) ||
        lstatSync(quarantineDirectory).isSymbolicLink() ||
        !statSync(quarantineDirectory).isDirectory()
    )
        throw new Error("terminal orchestration root has no regular quarantine directory");
    const names = readdirSync(transitionsDirectory).sort();
    const events = names.map((name, index) => {
        const match = name.match(/^(\d{6})-([0-9a-f]{64})\.json$/);
        if (!match || Number(match[1]) !== index) throw new Error(`transition filename is non-canonical: ${name}`);
        const event = readCanonicalRegularJson(
            join(transitionsDirectory, name),
            `transition ${index}`,
        ) as IV07AlignedV2OrchestratorEvent;
        if (event.eventSha256 !== match[2]) throw new Error(`transition filename/hash mismatch: ${name}`);
        return event;
    });
    if (!resolvers.seedCommitment || !resolvers.seedPlans || !resolvers.evidence) {
        throw new Error(
            "terminal replay requires exact seed-commitment, final-reveal, and filesystem evidence resolvers",
        );
    }
    const state = deriveV07AlignedV2OrchestratorState(definition, events, resolvers);
    if (
        !state.terminal ||
        state.phase !== "terminal" ||
        canonicalV07AlignedV2Json(state.terminal) !== canonicalV07AlignedV2Json(terminal)
    ) {
        throw new Error("TERMINAL.json does not equal the replayed terminal transition");
    }
    const current = readCanonicalRegularJson(join(outputDirectory, "CURRENT"), "CURRENT");
    if (
        !isObject(current) ||
        !exactKeys(current, [
            "schemaVersion",
            "artifactKind",
            "runFingerprint",
            "nextSequence",
            "eventHeadSha256",
            "lastNowMs",
            "terminalSha256",
            "currentSha256",
        ])
    )
        throw new Error("CURRENT is noncanonical or has non-exact fields");
    const { currentSha256, ...currentUnsigned } = current;
    const finalEvent = events.at(-1);
    if (
        current.schemaVersion !== 1 ||
        current.artifactKind !== "v0_7_aligned_96h_v2_orchestrator_current" ||
        current.runFingerprint !== definition.definitionSha256 ||
        current.nextSequence !== events.length ||
        current.eventHeadSha256 !== (finalEvent?.eventSha256 ?? null) ||
        current.lastNowMs !== (finalEvent?.nowMs ?? definition.schedule.startAtMs) ||
        current.terminalSha256 !== terminal.terminalSha256 ||
        currentSha256 !== fingerprintV07AlignedV2(currentUnsigned)
    )
        throw new Error("CURRENT does not bind the complete replayed terminal chain");
    return terminal;
}

class RealClock implements IV07AlignedV2SupervisorClock {
    private signal: "SIGHUP" | "SIGINT" | "SIGTERM" | null = null;
    private wake: (() => void) | null = null;
    public constructor() {
        process.once("SIGINT", () => this.request("SIGINT"));
        process.once("SIGTERM", () => this.request("SIGTERM"));
        process.once("SIGHUP", () => this.request("SIGHUP"));
    }
    public nowMs(): number {
        return Date.now();
    }
    public requestedSignal(): "SIGHUP" | "SIGINT" | "SIGTERM" | null {
        return this.signal;
    }
    public sleep(milliseconds: number): Promise<void> {
        return new Promise((resolveSleep) => {
            const timer = setTimeout(
                () => {
                    this.wake = null;
                    resolveSleep();
                },
                Math.max(0, milliseconds),
            );
            this.wake = () => {
                clearTimeout(timer);
                this.wake = null;
                resolveSleep();
            };
        });
    }
    private request(signal: "SIGHUP" | "SIGINT" | "SIGTERM"): void {
        this.signal ??= signal;
        this.wake?.();
    }
}

function readLinuxProcessIdentity(pid: number): IV07AlignedV2LinuxProcessIdentity | null {
    requireInteger(pid, "process identity pid", 1);
    if (process.platform !== "linux") return null;
    const bootId = readUtf8("/proc/sys/kernel/random/boot_id", "Linux boot identity").trim().toLowerCase();
    if (!LINUX_BOOT_ID_PATTERN.test(bootId)) throw new Error("Linux boot identity is invalid");
    try {
        const pidNamespace = readlinkSync(`/proc/${pid}/ns/pid`);
        const stat = readUtf8(`/proc/${pid}/stat`, `Linux process ${pid} stat`).trim();
        const close = stat.lastIndexOf(")");
        if (!stat.startsWith(`${pid} (`) || close < `${pid} (`.length) {
            throw new Error(`Linux process ${pid} stat has an invalid comm field`);
        }
        const fields = stat
            .slice(close + 1)
            .trim()
            .split(/\s+/);
        const pgid = Number(fields[2]);
        const sid = Number(fields[3]);
        const startTimeTicks = fields[19];
        if (
            !LINUX_PID_NAMESPACE_PATTERN.test(pidNamespace) ||
            !Number.isSafeInteger(pgid) ||
            pgid < 1 ||
            !Number.isSafeInteger(sid) ||
            sid < 1 ||
            !DECIMAL_TICKS_PATTERN.test(startTimeTicks ?? "")
        ) {
            throw new Error(`Linux process ${pid} identity fields are invalid`);
        }
        return { platform: "linux", bootId, pidNamespace, pid, startTimeTicks, pgid, sid };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH") {
            return null;
        }
        throw error;
    }
}

function probeRealProcessGroup(pgid: number): V07AlignedV2ProcessGroupProbe {
    requireInteger(pgid, "process group probe pgid", 1);
    try {
        process.kill(-pgid, 0);
        return "alive";
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return code === "ESRCH" ? "absent" : "ambiguous";
    }
}

class RealOptimizerHandle implements IV07AlignedV2OptimizerHandle {
    public readonly pid: number;
    public readonly pgid: number;
    private exitCode: number | null = null;
    private activated = false;
    public constructor(private readonly child: ChildProcess) {
        if (!child.pid) throw new Error("setsid optimizer child has no pid");
        this.pid = child.pid;
        this.pgid = child.pid;
        this.exitCode = child.exitCode ?? (child.signalCode ? 128 : null);
        child.once("exit", (code, signal) => {
            this.exitCode = code ?? (signal ? 128 : 1);
        });
    }
    public async activate(ownerToken: string): Promise<void> {
        if (this.activated) throw new Error("optimizer guard was already activated");
        if (!UUID_PATTERN.test(ownerToken) || !this.child.stdin) {
            throw new Error("optimizer guard activation channel is unavailable");
        }
        await new Promise<void>((resolveActivation, rejectActivation) => {
            this.child.stdin!.write(`activate:${ownerToken}\n`, (error) => {
                if (error) rejectActivation(error);
                else resolveActivation();
            });
        });
        this.activated = true;
    }
    public async poll(): Promise<IV07AlignedV2OptimizerPoll> {
        try {
            process.kill(-this.pgid, 0);
            return { alive: true, exitCode: this.exitCode };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EPERM") return { alive: true, exitCode: this.exitCode };
            return {
                alive: false,
                exitCode: this.exitCode ?? this.child.exitCode ?? (this.child.signalCode ? 128 : null),
            };
        }
    }
    public signalGroup(signal: NodeJS.Signals): void {
        try {
            process.kill(-this.pgid, signal);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
    }
}

function execFileAssessment(
    command: string,
    args: readonly string[],
    timeoutMs: number,
): Promise<{ status: number; output: string }> {
    return new Promise((resolveAssessment) => {
        execFile(
            command,
            [...args],
            { encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
            (error, stdout, stderr) =>
                resolveAssessment({
                    status:
                        typeof (error as NodeJS.ErrnoException | null)?.code === "number"
                            ? (error as unknown as { code: number }).code
                            : error
                              ? 70
                              : 0,
                    output: `${stdout}${stderr}`.trim(),
                }),
        );
    });
}

interface ICliOptions {
    out: string;
    definition: string;
    preparedBundle: string;
    composedSeal: string;
    runnerConfig: string;
    minimumIdleCpus: number;
    optimizerEntry: string;
    optimizerArgs: string[];
}

function parseCli(args: readonly string[]): ICliOptions {
    const values = new Map<string, string>();
    const separator = args.indexOf("--");
    const optionArgs = separator < 0 ? args : args.slice(0, separator);
    for (const argument of optionArgs) {
        const match = argument.match(/^--([a-z-]+)=(.+)$/);
        if (!match || values.has(match[1])) throw new Error(`invalid or duplicate supervisor option: ${argument}`);
        values.set(match[1], match[2]);
    }
    for (const required of [
        "out",
        "definition",
        "prepared-bundle",
        "composed-seal",
        "runner-config",
        "minimum-idle-cpus",
        "optimizer-entry",
    ]) {
        if (!values.has(required)) throw new Error(`--${required}=... is required`);
    }
    const allowed = new Set([
        "out",
        "definition",
        "prepared-bundle",
        "composed-seal",
        "runner-config",
        "minimum-idle-cpus",
        "optimizer-entry",
    ]);
    for (const name of values.keys()) if (!allowed.has(name)) throw new Error(`unknown supervisor option: --${name}`);
    const minimumIdleCpus = Number(values.get("minimum-idle-cpus"));
    requireInteger(minimumIdleCpus, "--minimum-idle-cpus", 1);
    return {
        out: values.get("out")!,
        definition: values.get("definition")!,
        preparedBundle: values.get("prepared-bundle")!,
        composedSeal: values.get("composed-seal")!,
        runnerConfig: values.get("runner-config")!,
        minimumIdleCpus,
        optimizerEntry: values.get("optimizer-entry")!,
        optimizerArgs: separator < 0 ? [] : [...args.slice(separator + 1)],
    };
}

export function validateV07AlignedV2SupervisorThroughputAttestation(
    value: unknown,
    runnerConfig: Pick<IV07AlignedV2RunnerConfig, "mode" | "throughput" | "versionProfile">,
    runnerConfigRoot: string,
): IV07AlignedV2ThroughputAttestation {
    return validateV07AlignedV2ThroughputAttestation(value, runnerConfig.throughput, {
        mode: runnerConfig.mode,
        configRoot: runnerConfigRoot,
        versionProfile: runnerConfig.versionProfile,
    });
}

function envInteger(name: string, fallback: number, minimum: number): number {
    const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
    requireInteger(value, name, minimum);
    return value;
}

function inspectInitialLaunchWindow(argument: string): void {
    const match = argument.match(/^--inspect-launch-window=(.+)$/);
    if (!match) throw new Error("--inspect-launch-window requires one definition path");
    const repositoryRoot = realpathSync(resolve(import.meta.dir, "../../.."));
    const requestedDefinition = resolve(repositoryRoot, match[1]);
    if (lstatSync(requestedDefinition).isSymbolicLink() || !lstatSync(requestedDefinition).isFile()) {
        throw new Error("launch-window definition must be a regular non-symlink file");
    }
    const definitionPath = realpathSync(requestedDefinition);
    const definition = validateV07AlignedV2OrchestratorDefinition(
        parseCanonicalJsonBytes(
            readFileSync(definitionPath),
            "aligned orchestrator launch-window definition",
        ) as IV07AlignedV2OrchestratorDefinition,
    );
    const nowMs = Date.now();
    const state = nowMs < definition.schedule.startAtMs ? "open" : "closed";
    process.stdout.write(
        `${canonicalV07AlignedV2Json({
            artifactKind: "v0_7_aligned_96h_v2_initial_launch_window",
            definitionPath,
            definitionSha256: definition.definitionSha256,
            startAtMs: definition.schedule.startAtMs,
            finalDeadlineAtMs: definition.schedule.finalDeadlineAtMs,
            nowMs,
            state,
        })}\n`,
    );
    if (state === "closed") process.exitCode = 78;
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0].startsWith("--inspect-launch-window=")) {
        inspectInitialLaunchWindow(args[0]);
        return;
    }
    const parsed = parseCli(args);
    const repositoryRoot = realpathSync(resolve(import.meta.dir, "../../.."));
    const requestedOutput = resolve(repositoryRoot, parsed.out);
    mkdirSync(requestedOutput, { recursive: true, mode: 0o750 });
    const outputDirectory = realpathSync(requestedOutput);
    const persistedRunPath = join(outputDirectory, "supervisor-run.json");
    const persistedRun = pathEntryExists(persistedRunPath) ? readV07AlignedV2SupervisorRun(persistedRunPath) : null;
    const requestedDefinition = resolve(repositoryRoot, parsed.definition);
    const requestedComposedSeal = resolve(repositoryRoot, parsed.composedSeal);
    if (
        lstatSync(requestedDefinition).isSymbolicLink() ||
        !lstatSync(requestedDefinition).isFile() ||
        lstatSync(requestedComposedSeal).isSymbolicLink() ||
        !lstatSync(requestedComposedSeal).isFile()
    )
        throw new Error("definition and composed seal must be regular non-symlink files");
    const definitionPath = realpathSync(requestedDefinition);
    const composedSealPath = realpathSync(requestedComposedSeal);
    if (outputDirectory === repositoryRoot || outputDirectory === sep) throw new Error("unsafe supervisor output path");
    const definitionRaw = readFileSync(definitionPath);
    const definition = validateV07AlignedV2OrchestratorDefinition(
        parseCanonicalJsonBytes(
            definitionRaw,
            "aligned orchestrator definition",
        ) as IV07AlignedV2OrchestratorDefinition,
    );
    if (Date.now() >= definition.schedule.startAtMs && persistedRun === null) {
        throw new Error("aligned v2 supervisor must be launched before the immutable start time");
    }
    const sealRawSha256 = sha256(readFileSync(composedSealPath));
    if (sealRawSha256 !== definition.composedSealSha256) {
        throw new Error("composed seal raw SHA-256 does not match the orchestrator definition commitment");
    }
    const composedSealAttestation = validateV07AlignedV2ComposedSeal(composedSealPath, sealRawSha256);
    const requestedRunnerConfig = resolve(repositoryRoot, parsed.runnerConfig);
    if (lstatSync(requestedRunnerConfig).isSymbolicLink() || !lstatSync(requestedRunnerConfig).isFile()) {
        throw new Error("runner config must be a non-symlink regular file");
    }
    const runnerConfigPath = realpathSync(requestedRunnerConfig);
    const runnerConfigRaw = readFileSync(runnerConfigPath);
    const runnerConfig = validateV07AlignedV2RunnerConfig(
        parseCanonicalJsonBytes(runnerConfigRaw, "aligned v2 runner config"),
    );
    const runnerConfigRoot = dirname(runnerConfigPath);
    const requestedRateAttestation = resolve(runnerConfigRoot, runnerConfig.throughput.rateAttestationPath);
    const rateRelative = relative(runnerConfigRoot, requestedRateAttestation);
    if (
        !rateRelative ||
        rateRelative === ".." ||
        rateRelative.startsWith(`..${sep}`) ||
        isAbsolute(rateRelative) ||
        lstatSync(requestedRateAttestation).isSymbolicLink() ||
        !lstatSync(requestedRateAttestation).isFile()
    ) {
        throw new Error("throughput attestation must be a regular file below the runner-config directory");
    }
    const rateAttestationPath = realpathSync(requestedRateAttestation);
    const rateAttestationRaw = readFileSync(rateAttestationPath);
    if (sha256(rateAttestationRaw) !== runnerConfig.throughput.rateAttestationBytesSha256) {
        throw new Error("throughput attestation raw SHA-256 does not match the runner config");
    }
    const rateAttestation = validateV07AlignedV2SupervisorThroughputAttestation(
        parseCanonicalJsonBytes(rateAttestationRaw, "aligned v2 throughput attestation"),
        runnerConfig,
        runnerConfigRoot,
    );
    const requestedPreparedBundle = resolve(repositoryRoot, parsed.preparedBundle);
    const budget = validateV07AlignedV2RunnerBudget(runnerConfig, definition);
    const preparedBundle = validateV07AlignedV2PreparedBundleLaunch({
        bundlePath: requestedPreparedBundle,
        definitionPath,
        runFingerprint: definition.definitionSha256,
        definitionSha256: definition.definitionSha256,
        definitionBytesSha256: sha256(definitionRaw),
        composedSealBytesSha256: sealRawSha256,
        runnerConfigSha256: runnerConfig.configSha256,
        runnerConfigBytesSha256: sha256(runnerConfigRaw),
        rateAttestationSha256: rateAttestation.attestationSha256,
        rateAttestationBytesSha256: sha256(rateAttestationRaw),
        seedCommitment: definition.seedCommitment,
        budget,
    });
    const runnerModeFlag = definition.mode === "formal" ? "--run" : "--preflight";
    const expectedOptimizerArgs = [runnerModeFlag, `--config=${runnerConfigPath}`];
    if (
        (definition.mode === "formal" && runnerConfig.mode !== "production") ||
        (definition.mode === "synthetic_dry_run" && runnerConfig.mode !== "synthetic_preflight") ||
        canonicalV07AlignedV2Json(parsed.optimizerArgs) !== canonicalV07AlignedV2Json(expectedOptimizerArgs)
    ) {
        throw new Error("definition, runner config, and exact optimizer arguments do not share one mode");
    }
    const requestedOptimizerEntry = resolve(repositoryRoot, parsed.optimizerEntry);
    if (lstatSync(requestedOptimizerEntry).isSymbolicLink() || !lstatSync(requestedOptimizerEntry).isFile()) {
        throw new Error("optimizer entry must be a non-symlink regular file");
    }
    const optimizerEntry = realpathSync(requestedOptimizerEntry);
    const optimizerRoot = join(repositoryRoot, "src", "simulation", "optimizer") + sep;
    if (!optimizerEntry.startsWith(optimizerRoot) || basename(optimizerEntry) !== ALIGNED_ENTRY_BASENAME) {
        throw new Error(
            `optimizer entry must be the tracked ${ALIGNED_ENTRY_BASENAME} source under src/simulation/optimizer`,
        );
    }
    git(repositoryRoot, ["ls-files", "--error-unmatch", relative(repositoryRoot, optimizerEntry)]);
    const provenance = captureV07AlignedV2SupervisorProvenance(repositoryRoot, persistedRun?.provenance.liveOriginMain);
    if (persistedRun === null && provenance.liveOriginMain !== provenance.commit) {
        throw new Error("aligned v2 launch requires HEAD to equal the live origin/main revision");
    }
    if (
        rateAttestation.commit !== provenance.commit ||
        rateAttestation.sourceTreeSha256 !== provenance.sourceTreeSha256 ||
        rateAttestation.bunVersion !== provenance.bunVersion ||
        rateAttestation.bunRevision !== provenance.bunRevision ||
        rateAttestation.bunExecutableSha256 !== provenance.bunExecutableSha256 ||
        rateAttestation.dependencyManifestSha256 !== provenance.dependencyManifestSha256 ||
        rateAttestation.lockfileSha256 !== provenance.lockfileSha256
    ) {
        throw new Error("throughput attestation does not bind the exact launch revision, runtime, and dependencies");
    }
    const config: IV07AlignedV2SupervisorConfig = {
        outputDirectory,
        repositoryRoot,
        definitionPath,
        definitionSha256: sha256(definitionRaw),
        composedSealPath,
        composedSealSha256: sealRawSha256,
        composedSealAttestation,
        runFingerprint: definition.definitionSha256,
        startAtMs: definition.schedule.startAtMs,
        deadlineAtMs: definition.schedule.finalDeadlineAtMs,
        optimizerEntry,
        optimizerEntrySha256: sha256(readFileSync(optimizerEntry)),
        optimizerArgs: parsed.optimizerArgs,
        runnerConfigPath,
        runnerConfigSha256: runnerConfig.configSha256,
        runnerConfigBytesSha256: sha256(runnerConfigRaw),
        rateAttestationPath,
        rateAttestationSha256: rateAttestation.attestationSha256,
        rateAttestationBytesSha256: sha256(rateAttestationRaw),
        preparedBundlePath: preparedBundle.bundlePath,
        preparedBundleSha256: preparedBundle.bundleSha256,
        preparedBundleBytesSha256: preparedBundle.bundleBytesSha256,
        heartbeatIntervalMs: envInteger("V07_ALIGNED_V2_HEARTBEAT_MS", 30_000, 100),
        runnerStartupWatchdogMs: envInteger("V07_ALIGNED_V2_RUNNER_STARTUP_WATCHDOG_MS", 300_000, 1000),
        runnerProgressWatchdogMs: envInteger("V07_ALIGNED_V2_RUNNER_PROGRESS_WATCHDOG_MS", 300_000, 1000),
        hostProbeIntervalMs: envInteger("V07_ALIGNED_V2_HOST_PROBE_MS", 60_000, 100),
        watchdogMs: envInteger("V07_ALIGNED_V2_WATCHDOG_MS", 300_000, 1000),
        hostProbeTimeoutMs: envInteger("V07_ALIGNED_V2_HOST_PROBE_TIMEOUT_MS", 30_000, 100),
        restartBaseMs: envInteger("V07_ALIGNED_V2_RESTART_BASE_MS", 15_000, 100),
        restartMaxMs: envInteger("V07_ALIGNED_V2_RESTART_MAX_MS", 900_000, 100),
        maxRestarts: envInteger("V07_ALIGNED_V2_MAX_RESTARTS", 8, 1),
        stopGraceMs: envInteger("V07_ALIGNED_V2_STOP_GRACE_MS", 30_000, 100),
        minimumIdleCpus: parsed.minimumIdleCpus,
        niceLevel: envInteger("V07_ALIGNED_V2_NICE", 10, 0),
        provenance,
    };
    const clock = new RealClock();
    const helper = join(repositoryRoot, "scripts", "v0_7_host_contention_guard.mjs");
    const childGuard = join(repositoryRoot, "scripts", "v0_7_aligned_96h_v2_child_guard.sh");
    const baseline = join(outputDirectory, "supervisor.host_guard.cpu_baseline.json");
    const optimizerLog = join(outputDirectory, "optimizer.log");
    const orchestratorDirectory = join(outputDirectory, "orchestrator");
    const optimizerHome = join(outputDirectory, ".optimizer-home");
    let reportTerminalReplayProgress = (): void => undefined;
    const replayResolvers = createV07AlignedV2FilesystemReplayResolvers({
        artifactRoot: outputDirectory,
        definition,
        onEvidenceShardVerified: () => reportTerminalReplayProgress(),
    });
    const verifyImmutableInputs = (): void => {
        const currentDefinitionRaw = readFileSync(definitionPath);
        const currentDefinition = validateV07AlignedV2OrchestratorDefinition(
            parseCanonicalJsonBytes(
                currentDefinitionRaw,
                "current aligned v2 orchestrator definition",
            ) as IV07AlignedV2OrchestratorDefinition,
        );
        const currentSealRaw = readFileSync(composedSealPath);
        const currentSealAttestation = validateV07AlignedV2ComposedSeal(composedSealPath, config.composedSealSha256);
        const currentRunnerConfigRaw = readFileSync(runnerConfigPath);
        const currentRunnerConfig = validateV07AlignedV2RunnerConfig(
            parseCanonicalJsonBytes(currentRunnerConfigRaw, "current aligned v2 runner config"),
        );
        const currentRateAttestationRaw = readFileSync(rateAttestationPath);
        const currentRateAttestation = validateV07AlignedV2SupervisorThroughputAttestation(
            parseCanonicalJsonBytes(currentRateAttestationRaw, "current aligned v2 throughput attestation"),
            currentRunnerConfig,
            runnerConfigRoot,
        );
        const currentBudget = validateV07AlignedV2RunnerBudget(currentRunnerConfig, currentDefinition);
        const currentPreparedBundle = validateV07AlignedV2PreparedBundleLaunch({
            bundlePath: config.preparedBundlePath,
            definitionPath,
            runFingerprint: currentDefinition.definitionSha256,
            definitionSha256: currentDefinition.definitionSha256,
            definitionBytesSha256: sha256(currentDefinitionRaw),
            composedSealBytesSha256: sha256(currentSealRaw),
            runnerConfigSha256: currentRunnerConfig.configSha256,
            runnerConfigBytesSha256: sha256(currentRunnerConfigRaw),
            rateAttestationSha256: currentRateAttestation.attestationSha256,
            rateAttestationBytesSha256: sha256(currentRateAttestationRaw),
            seedCommitment: currentDefinition.seedCommitment,
            budget: currentBudget,
        });
        if (
            sha256(currentDefinitionRaw) !== config.definitionSha256 ||
            sha256(currentSealRaw) !== config.composedSealSha256 ||
            sha256(readFileSync(optimizerEntry)) !== config.optimizerEntrySha256 ||
            sha256(currentRunnerConfigRaw) !== config.runnerConfigBytesSha256 ||
            sha256(currentRateAttestationRaw) !== config.rateAttestationBytesSha256 ||
            currentPreparedBundle.bundleSha256 !== config.preparedBundleSha256 ||
            currentPreparedBundle.bundleBytesSha256 !== config.preparedBundleBytesSha256 ||
            canonicalV07AlignedV2Json(currentSealAttestation) !==
                canonicalV07AlignedV2Json(config.composedSealAttestation) ||
            currentRunnerConfig.configSha256 !== config.runnerConfigSha256 ||
            currentRateAttestation.attestationSha256 !== config.rateAttestationSha256 ||
            currentRateAttestation.commit !== config.provenance.commit ||
            currentRateAttestation.sourceTreeSha256 !== config.provenance.sourceTreeSha256 ||
            currentRateAttestation.bunVersion !== config.provenance.bunVersion ||
            currentRateAttestation.bunRevision !== config.provenance.bunRevision ||
            currentRateAttestation.bunExecutableSha256 !== config.provenance.bunExecutableSha256 ||
            currentRateAttestation.dependencyManifestSha256 !== config.provenance.dependencyManifestSha256 ||
            currentRateAttestation.lockfileSha256 !== config.provenance.lockfileSha256
        ) {
            throw new Error(
                "definition, composed evidence, runner inputs, or launch provenance changed after initialization",
            );
        }
    };
    const dependencies: IV07AlignedV2SupervisorDependencies = {
        clock,
        processId: process.pid,
        readProcessIdentity: readLinuxProcessIdentity,
        probeProcessGroup: probeRealProcessGroup,
        captureProvenance: () =>
            captureV07AlignedV2SupervisorProvenance(repositoryRoot, config.provenance.liveOriginMain),
        verifyImmutableInputs,
        probeHost: async ({ childPgid, resetBaseline }) => {
            const args = [
                helper,
                `--min-idle-cpus=${config.minimumIdleCpus}`,
                "--sample-ms=1000",
                `--cpu-baseline=${baseline}`,
                `--reset-baseline=${resetBaseline ? 1 : 0}`,
                `--exclude-pid=${process.pid}`,
            ];
            if (childPgid !== null) args.push(`--exclude-pgid=${childPgid}`);
            const result = await execFileAssessment(process.execPath, args, config.hostProbeTimeoutMs);
            let assessment: IV07AlignedV2HostAssessment;
            try {
                assessment = JSON.parse(result.output) as IV07AlignedV2HostAssessment;
            } catch {
                throw new Error(`host probe emitted malformed JSON (status ${result.status}): ${result.output}`);
            }
            if (result.status !== 0 || !assessment.ok)
                throw new Error(`host probe status ${result.status}: ${result.output}`);
            return assessment;
        },
        spawnOptimizer: async (_attempt, ownerToken) => {
            ensureDurableDirectory(outputDirectory);
            ensureDurableDirectory(optimizerHome);
            if (
                pathEntryExists(optimizerLog) &&
                (lstatSync(optimizerLog).isSymbolicLink() || !lstatSync(optimizerLog).isFile())
            ) {
                throw new Error("optimizer log must remain a regular non-symlink file");
            }
            const logDescriptor = openSync(optimizerLog, "a", 0o640);
            const environment: NodeJS.ProcessEnv = {};
            for (const key of ["PATH", "USER", "TMPDIR", "TEMP", "LANG", "LC_ALL", "BUN_INSTALL", "NO_COLOR"]) {
                if (process.env[key] !== undefined) environment[key] = process.env[key];
            }
            Object.assign(environment, {
                HOME: optimizerHome,
                V07_ALIGNED_V2_OUT: orchestratorDirectory,
                V07_ALIGNED_V2_DEFINITION: definitionPath,
                V07_ALIGNED_V2_DEADLINE_EPOCH: String(Math.floor(config.deadlineAtMs / 1000)),
                V07_ALIGNED_V2_DEADLINE_MS: String(config.deadlineAtMs),
                V07_ALIGNED_V2_RESEARCH_ONLY: "1",
                V07_ALIGNED_V2_NO_BAKE: "1",
                V07_ALIGNED_V2_NO_DEPLOY: "1",
                V07_ALIGNED_V2_RUNNER_CONFIG_SHA256: config.runnerConfigSha256,
                V07_ALIGNED_V2_RUNNER_CONFIG_BYTES_SHA256: config.runnerConfigBytesSha256,
                V07_ALIGNED_V2_RATE_ATTESTATION_SHA256: config.rateAttestationSha256,
                BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
            });
            try {
                const spawned = spawn(
                    "setsid",
                    [
                        "nice",
                        "-n",
                        String(config.niceLevel),
                        childGuard,
                        `--supervisor-heartbeat=${join(outputDirectory, "supervisor.heartbeat.json")}`,
                        `--deadline-epoch=${Math.ceil(config.deadlineAtMs / 1000)}`,
                        `--watchdog-seconds=${Math.ceil(config.watchdogMs / 1000)}`,
                        `--stop-grace-seconds=${Math.ceil(config.stopGraceMs / 1000)}`,
                        `--owner-token=${ownerToken}`,
                        "--",
                        process.execPath,
                        optimizerEntry,
                        ...config.optimizerArgs,
                    ],
                    {
                        cwd: repositoryRoot,
                        env: environment,
                        stdio: ["pipe", logDescriptor, logDescriptor],
                    },
                );
                await new Promise<void>((resolveSpawn, rejectSpawn) => {
                    spawned.once("spawn", resolveSpawn);
                    spawned.once("error", rejectSpawn);
                });
                return new RealOptimizerHandle(spawned);
            } finally {
                closeSync(logDescriptor);
            }
        },
        validateTerminal: (onReplayProgress) => {
            reportTerminalReplayProgress = onReplayProgress;
            try {
                return validateV07AlignedV2TerminalReplay(orchestratorDirectory, definition, replayResolvers);
            } finally {
                reportTerminalReplayProgress = (): void => undefined;
            }
        },
        readRunnerHeartbeat: () => {
            const path = join(outputDirectory, "runner.heartbeat.json");
            if (!pathEntryExists(path)) return null;
            return validateV07AlignedV2RunnerHeartbeat(
                readCanonicalRegularJson(path, "runner-owned progress heartbeat"),
                config.runFingerprint,
                path,
            );
        },
        log: (message) => process.stdout.write(`[${new Date().toISOString()}] ${message}\n`),
    };
    const result = await runV07AlignedV2Supervisor(config, dependencies);
    process.stdout.write(`${canonicalV07AlignedV2Json(result)}\n`);
    process.exitCode =
        result.stop === "terminal" || result.stop === "deadline"
            ? 0
            : result.stop === "busy"
              ? 75
              : result.stop === "signal"
                ? 143
                : result.stop === "quarantined"
                  ? 80
                  : 78;
}

if (import.meta.main) {
    main().catch((error) => {
        process.stderr.write(`v0_7_aligned_96h_v2_supervisor: ${String(error)}\n`);
        process.exitCode = 64;
    });
}
