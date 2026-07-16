/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import { createHash, randomUUID } from "node:crypto";
import {
    closeSync,
    existsSync,
    fsyncSync,
    linkSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { arch, availableParallelism, hostname, platform, release } from "node:os";
import { fileURLToPath } from "node:url";

import type { IV07ComposedAuditRow } from "../v0_7_composed_ranked_ladder";
import type { V07AlignedV2Outcome } from "./v0_7_aligned_96h_v2_core";
import {
    evaluateV07AlignedV2Shard,
    type IV07AlignedV2ShardEvaluation,
    type IV07AlignedV2ShardEvaluationOptions,
} from "./v0_7_aligned_96h_v2_evaluator";
import {
    createV07AlignedV2FilesystemReplayResolvers,
    type IV07AlignedV2FilesystemResolverOptions,
} from "./v0_7_aligned_96h_v2_filesystem_resolvers";
import { compactV07AlignedV2Observation, type IV07AlignedV2BattleRecord } from "./v0_7_aligned_96h_v2_game_adapter";
import {
    createV07AlignedV2OrchestratorDefinition,
    type IV07AlignedV2OrchestratorCommand,
    type IV07AlignedV2OrchestratorDefinition,
    type IV07AlignedV2OrchestratorSchedule,
    type IV07AlignedV2OrchestratorReplayResolvers,
    type IV07AlignedV2OrchestratorState,
    type IV07AlignedV2PanelEvidenceInput,
    type IV07AlignedV2SeedArtifactRef,
    validateV07AlignedV2OrchestratorDefinition,
} from "./v0_7_aligned_96h_v2_orchestrator";
import {
    applyAndPersistV07AlignedV2OrchestratorCommand,
    initializeV07AlignedV2OrchestratorPersistence,
    loadV07AlignedV2PersistedOrchestrator,
    type IV07AlignedV2PersistedOrchestrator,
} from "./v0_7_aligned_96h_v2_orchestrator_persistence";
import {
    loadV07AlignedV2PersistedShard,
    persistV07AlignedV2ShardEvaluation,
    v07AlignedV2ShardArtifactDirectoryName,
} from "./v0_7_aligned_96h_v2_persistence";
import {
    bindV07AlignedV2SeedPlan,
    buildV07AlignedV2CandidateEnvironment,
    buildV07AlignedV2CheckpointShardSpecs,
    canonicalV07AlignedV2Json,
    createV07AlignedV2Checkpoint,
    fingerprintV07AlignedV2,
    flattenV07AlignedV2SeedPlan,
    v07AlignedV2TaskKey,
    type IV07AlignedV2CandidateBinding,
    type IV07AlignedV2CandidateGenome,
    type IV07AlignedV2CheckpointPanelBinding,
    type IV07AlignedV2CheckpointShardSpec,
    type IV07AlignedV2ExecutionTask,
    type IV07AlignedV2InjectedSeedPlan,
} from "./v0_7_aligned_96h_v2_protocol";
import {
    commitV07AlignedV2SeedAllocation,
    ingestV07AlignedV2SeedCorpus,
    revealV07AlignedV2FinalSeedPlan,
    validateV07AlignedV2SeedAllocationRequest,
    type IV07AlignedV2CommittedManifestInput,
    type IV07AlignedV2FinalSeedReveal,
    type IV07AlignedV2SeedAllocationCommitment,
    type IV07AlignedV2SeedAllocationRequest,
    type IV07AlignedV2SeedCorpus,
    type IV07AlignedV2SeedScanReplayInput,
} from "./v0_7_aligned_96h_v2_seed_allocator";
import {
    validateV07AlignedV2ProductionThroughputAttestation,
    type IV07AlignedV2ProductionThroughputAttestation,
} from "./v0_7_aligned_96h_v2_throughput";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const HOUR_MS = 60 * 60 * 1000;
const COMMITMENT_PATH = "seed-allocation/commitment.json";
const FINAL_REVEAL_PATH = "seed-allocation/final-reveal.json";

type V07AlignedV2RunnerMode = "production" | "synthetic_preflight";

export interface IV07AlignedV2RunnerScanFiles {
    firstSummaryPath: string;
    firstSeedSetPath: string;
    replaySummaryPath: string;
    replaySeedSetPath: string;
}

export interface IV07AlignedV2RunnerCommittedManifestFile {
    path: string;
    sourcePath: string;
}

export interface IV07AlignedV2RunnerSeedInputs {
    secretPath: string;
    local: IV07AlignedV2RunnerScanFiles;
    zinc: IV07AlignedV2RunnerScanFiles;
    committedManifests: IV07AlignedV2RunnerCommittedManifestFile[];
}

export interface IV07AlignedV2RunnerThroughputBudget {
    logicalCpus: number;
    reservedCpus: number;
    workersPerShard: number;
    concurrentShards: number;
    maxScenarioPairsPerShard: number;
    gamesPerWorkerHour: number;
    utilization: number;
    safetyFactor: number;
    panelStartupMinutes: number;
    shardTimeoutMinutes: number;
    rateAttestationPath: string;
    rateAttestationBytesSha256: string;
    rateAttestationSha256: string;
}

export interface IV07AlignedV2SyntheticThroughputAttestation {
    schemaVersion: 1;
    artifactKind: "v0_7_aligned_96h_v2_throughput_attestation";
    status: "research_only_no_bake";
    automaticBake: false;
    automaticDeploy: false;
    measuredAtMs: number;
    commit: string;
    sourceTreeSha256: string;
    bunVersion: string;
    bunRevision: string;
    bunExecutableSha256: string;
    dependencyManifestSha256: string;
    lockfileSha256: string | null;
    hostFingerprintSha256: string;
    logicalCpus: number;
    workersPerShard: number;
    concurrentShards: number;
    sampleProtocol: "all_12_cells_two_seats_persisted_round_robin";
    sampleGamesPerCellSeat: number;
    sampleGames: number;
    elapsedMs: number;
    persistedReplayVerified: true;
    workerAttestationsVerified: true;
    gamesPerWorkerHour: number;
    runnerBytesSha256: string;
    evaluatorBytesSha256: string;
    workerBytesSha256: string;
    gameAdapterBytesSha256: string;
    attestationSha256: string;
}

export type IV07AlignedV2ThroughputAttestation =
    IV07AlignedV2SyntheticThroughputAttestation | IV07AlignedV2ProductionThroughputAttestation;

export interface IV07AlignedV2DefinitionBootstrapRequest {
    schemaVersion: 1;
    artifactKind: "v0_7_aligned_96h_v2_definition_bootstrap_request";
    status: "research_only_no_bake";
    automaticBake: false;
    automaticDeploy: false;
    runId: string;
    createdAtMs: number;
    candidateLimit: number;
    schedule: IV07AlignedV2OrchestratorSchedule;
    candidateGenomes: IV07AlignedV2CandidateGenome[];
    incumbentGenome: IV07AlignedV2CandidateGenome;
    composedSealPath: string;
    composedSealBytesSha256: string;
    requestSha256: string;
}

export interface IV07AlignedV2PreparedDefinitionBundle {
    schemaVersion: 1;
    artifactKind: "v0_7_aligned_96h_v2_prepared_definition_bundle";
    status: "research_only_no_bake";
    automaticBake: false;
    automaticDeploy: false;
    runFingerprint: string;
    configSha256: string;
    configBytesSha256: string;
    requestSha256: string;
    commitmentPath: "seed-allocation/commitment.json";
    commitmentSha256: string;
    commitmentBytesSha256: string;
    definitionPath: "definition.json";
    definitionSha256: string;
    definitionBytesSha256: string;
    composedSealBytesSha256: string;
    rateAttestationSha256: string;
    rateAttestationBytesSha256: string;
    budget: IV07AlignedV2RunnerBudgetReport;
    gamesExecuted: 0;
    workersStarted: 0;
    bundleSha256: string;
}

export interface IV07AlignedV2RunnerHeartbeat {
    schemaVersion: 1;
    artifactKind: "v0_7_aligned_96h_v2_runner_heartbeat";
    runFingerprint: string;
    sequence: number;
    phase: string;
    activePanelFingerprint: string | null;
    activeGenomeSha256: string | null;
    completedShards: number;
    completedGames: number;
    eventHeadSha256: string | null;
    updatedAtMs: number;
    heartbeatSha256: string;
}

export interface IV07AlignedV2RunnerConfig {
    schemaVersion: 1;
    artifactKind: "v0_7_aligned_96h_v2_runner_config";
    status: "research_only_no_bake";
    automaticBake: false;
    automaticDeploy: false;
    mode: V07AlignedV2RunnerMode;
    seedInputs: IV07AlignedV2RunnerSeedInputs;
    allocationRequest: IV07AlignedV2SeedAllocationRequest;
    throughput: IV07AlignedV2RunnerThroughputBudget;
    configSha256: string;
}

export interface IV07AlignedV2RunnerBudgetReport {
    schemaVersion: 1;
    artifactKind: "v0_7_aligned_96h_v2_throughput_budget";
    totalWorkers: number;
    reservedCpus: number;
    trainGames: number;
    confirmGames: number;
    finalGames: number;
    trainWindowHours: number;
    confirmWindowHours: number;
    finalWindowHours: number;
    estimatedTrainHours: number;
    estimatedConfirmHours: number;
    estimatedFinalHours: number;
    finalHoursReserved: number;
    actualLogicalCpus: number;
    maxShardGames: number;
    estimatedMaxShardMinutes: number;
    shardTimeoutMinutes: number;
    rateAttestationSha256: string;
    rateAttestationBytesSha256: string;
    passed: true;
    budgetSha256: string;
}

export interface IV07AlignedV2RemainingCapacityReport {
    schemaVersion: 1;
    artifactKind: "v0_7_aligned_96h_v2_remaining_capacity";
    runFingerprint: string;
    phase: IV07AlignedV2OrchestratorState["phase"];
    measuredAtMs: number;
    remainingTrainGames: number;
    remainingConfirmGames: number;
    remainingFinalGames: number;
    trainHoursAvailable: number;
    confirmHoursAvailable: number;
    finalHoursAvailable: number;
    estimatedTrainHours: number;
    estimatedConfirmHours: number;
    estimatedFinalHours: number;
    passed: true;
    capacitySha256: string;
}

export interface IV07AlignedV2RunnerPreparation {
    config: IV07AlignedV2RunnerConfig;
    configBytesSha256: string;
    throughputAttestation: IV07AlignedV2ThroughputAttestation;
    corpus: IV07AlignedV2SeedCorpus;
    secret: Uint8Array;
    commitment: IV07AlignedV2SeedAllocationCommitment;
    finalPanelCommitment: IV07AlignedV2CheckpointPanelBinding;
    commitmentRef: IV07AlignedV2SeedArtifactRef;
}

export interface IV07AlignedV2RunnerDependencies {
    nowMs(): number;
    evaluateShard(options: IV07AlignedV2ShardEvaluationOptions): Promise<IV07AlignedV2ShardEvaluation>;
}

export interface IV07AlignedV2RunnerInvocation {
    configPath: string;
    definitionPath: string;
    orchestratorDirectory: string;
    preflight: boolean;
    environment: NodeJS.ProcessEnv;
    dependencies?: Partial<IV07AlignedV2RunnerDependencies>;
}

export interface IV07AlignedV2RunnerOutcome {
    schemaVersion: 1;
    artifactKind: "v0_7_aligned_96h_v2_runner_outcome";
    status: "research_only_no_bake";
    automaticBake: false;
    automaticDeploy: false;
    mode: V07AlignedV2RunnerMode;
    runFingerprint: string;
    configSha256: string;
    configBytesSha256: string;
    rateAttestationSha256: string;
    commitmentRef: IV07AlignedV2SeedArtifactRef;
    finalRevealRef: IV07AlignedV2SeedArtifactRef | null;
    budget: IV07AlignedV2RunnerBudgetReport;
    remainingCapacity: IV07AlignedV2RemainingCapacityReport;
    terminalSha256: string;
    invocationGamesExecuted: number;
    invocationWorkersStarted: number;
    persistedGames: number;
    persistedShards: number;
    outcomeSha256: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    return canonicalV07AlignedV2Json(Object.keys(value).sort()) === canonicalV07AlignedV2Json([...expected].sort());
}

function requireInteger(value: unknown, label: string, minimum = 0): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) {
        throw new Error(`${label} must be an integer >= ${minimum}`);
    }
}

function requireFinite(value: unknown, label: string, minimumExclusive: number): asserts value is number {
    if (!Number.isFinite(value) || (value as number) <= minimumExclusive) {
        throw new Error(`${label} must be finite and > ${minimumExclusive}`);
    }
}

function requireSha256(value: unknown, label: string): asserts value is string {
    if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
        throw new Error(`${label} must be a lowercase SHA-256`);
    }
}

function canonicalFile(value: unknown): string {
    return `${canonicalV07AlignedV2Json(value)}\n`;
}

function decodeUtf8Exact(bytes: Buffer, label: string): string {
    let value: string;
    try {
        value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        throw new Error(`${label} is not valid UTF-8`);
    }
    if (!Buffer.from(value, "utf8").equals(bytes)) throw new Error(`${label} is not canonical UTF-8`);
    return value;
}

function parseCanonicalJsonBytes<T>(bytes: Buffer, label: string): T {
    const contents = decodeUtf8Exact(bytes, label);
    if (!contents.endsWith("\n")) throw new Error(`${label} lacks a terminal newline`);
    let parsed: T;
    try {
        parsed = JSON.parse(contents) as T;
    } catch (error) {
        throw new Error(`${label} is malformed JSON (${String(error)})`);
    }
    if (contents !== canonicalFile(parsed)) throw new Error(`${label} is not canonical JSON`);
    return parsed;
}

function readCanonicalJson<T>(path: string, label: string): T {
    if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
        throw new Error(`${label} must be a regular non-symlink file`);
    }
    return parseCanonicalJsonBytes<T>(readFileSync(path), label);
}

function validateRelativePath(value: unknown, label: string): string {
    if (typeof value !== "string") throw new Error(`${label} must be a path string`);
    const segments = value.split("/");
    if (
        !value ||
        isAbsolute(value) ||
        value.includes("\\") ||
        segments.some((segment) => !segment || segment === "." || segment === "..")
    ) {
        throw new Error(`${label} must be a safe relative path`);
    }
    return value;
}

function resolveExistingFile(root: string, relativePath: string, label: string): string {
    validateRelativePath(relativePath, label);
    let cursor = root;
    for (const segment of relativePath.split("/")) {
        cursor = resolve(cursor, segment);
        if (!existsSync(cursor) || lstatSync(cursor).isSymbolicLink()) {
            throw new Error(`${label} must not be missing or traverse a symbolic link`);
        }
    }
    const path = realpathSync(cursor);
    if (!path.startsWith(`${root}${sep}`) || !lstatSync(path).isFile()) {
        throw new Error(`${label} must resolve to a regular file below the runner config directory`);
    }
    return path;
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
    if (existsSync(path)) {
        if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) {
            throw new Error(`durable directory is unsafe: ${path}`);
        }
        return;
    }
    const parent = dirname(path);
    if (parent === path) throw new Error(`cannot create filesystem root: ${path}`);
    ensureDurableDirectory(parent);
    mkdirSync(path, { mode: 0o750 });
    fsyncDirectory(path);
    fsyncDirectory(parent);
}

function publishImmutableArtifact(
    artifactRoot: string,
    relativePath: string,
    value: unknown,
    artifactSha256: string,
): IV07AlignedV2SeedArtifactRef {
    validateRelativePath(relativePath, "artifact path");
    requireSha256(artifactSha256, "artifact semantic hash");
    const destination = join(artifactRoot, ...relativePath.split("/"));
    const parent = dirname(destination);
    ensureDurableDirectory(parent);
    const contents = canonicalFile(value);
    const bytesSha256 = createHash("sha256").update(contents).digest("hex");
    const expected = Buffer.from(contents, "utf8");
    const prefix = `.${basename(destination)}.tmp-`;
    for (const entry of readdirSync(parent).filter((name) => name.startsWith(prefix))) {
        const abandoned = join(parent, entry);
        renameSync(abandoned, `${abandoned}.abandoned-${Date.now()}-${process.pid}-${randomUUID()}`);
        fsyncDirectory(parent);
    }
    if (existsSync(destination)) {
        if (lstatSync(destination).isSymbolicLink() || !lstatSync(destination).isFile()) {
            throw new Error(`immutable artifact path is unsafe: ${relativePath}`);
        }
        if (!readFileSync(destination).equals(expected)) {
            throw new Error(`immutable artifact already contains different bytes: ${relativePath}`);
        }
        return { path: relativePath, bytesSha256, artifactSha256 };
    }
    const temporary = join(parent, `${prefix}${process.pid}-${randomUUID()}`);
    const descriptor = openSync(temporary, "wx", 0o640);
    try {
        writeFileSync(descriptor, expected);
        fsyncSync(descriptor);
    } finally {
        closeSync(descriptor);
    }
    try {
        linkSync(temporary, destination);
        fsyncDirectory(parent);
    } catch (error) {
        if (
            !existsSync(destination) ||
            lstatSync(destination).isSymbolicLink() ||
            !lstatSync(destination).isFile() ||
            !readFileSync(destination).equals(expected)
        ) {
            throw error;
        }
    } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
        fsyncDirectory(parent);
    }
    return { path: relativePath, bytesSha256, artifactSha256 };
}

function writeAtomicReplacement(path: string, contents: string): void {
    const parent = dirname(path);
    ensureDurableDirectory(parent);
    if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile())) {
        throw new Error(`atomic replacement destination is unsafe: ${path}`);
    }
    const prefix = `.${basename(path)}.tmp-`;
    for (const entry of readdirSync(parent).filter((name) => name.startsWith(prefix))) {
        const abandoned = join(parent, entry);
        renameSync(abandoned, `${abandoned}.abandoned-${Date.now()}-${process.pid}-${randomUUID()}`);
        fsyncDirectory(parent);
    }
    const temporary = join(parent, `${prefix}${process.pid}-${randomUUID()}`);
    const descriptor = openSync(temporary, "wx", 0o640);
    try {
        writeFileSync(descriptor, contents, "utf8");
        fsyncSync(descriptor);
    } finally {
        closeSync(descriptor);
    }
    renameSync(temporary, path);
    fsyncDirectory(parent);
}

export function validateV07AlignedV2RunnerHeartbeat(
    value: unknown,
    runFingerprint: string,
    label = "runner heartbeat",
): IV07AlignedV2RunnerHeartbeat {
    if (
        !isObject(value) ||
        !exactKeys(value, [
            "schemaVersion",
            "artifactKind",
            "runFingerprint",
            "sequence",
            "phase",
            "activePanelFingerprint",
            "activeGenomeSha256",
            "completedShards",
            "completedGames",
            "eventHeadSha256",
            "updatedAtMs",
            "heartbeatSha256",
        ]) ||
        value.schemaVersion !== 1 ||
        value.artifactKind !== "v0_7_aligned_96h_v2_runner_heartbeat" ||
        value.runFingerprint !== runFingerprint ||
        typeof value.phase !== "string" ||
        !value.phase
    ) {
        throw new Error(`aligned v2 runner heartbeat header/fields are invalid: ${label}`);
    }
    requireInteger(value.sequence, "runner heartbeat sequence");
    requireInteger(value.completedShards, "runner heartbeat completedShards");
    requireInteger(value.completedGames, "runner heartbeat completedGames");
    requireInteger(value.updatedAtMs, "runner heartbeat updatedAtMs");
    for (const [label, hash] of [
        ["activePanelFingerprint", value.activePanelFingerprint],
        ["activeGenomeSha256", value.activeGenomeSha256],
        ["eventHeadSha256", value.eventHeadSha256],
    ] as const) {
        if (hash !== null) requireSha256(hash, `runner heartbeat ${label}`);
    }
    requireSha256(value.heartbeatSha256, "runner heartbeat heartbeatSha256");
    const { heartbeatSha256, ...unsigned } = value;
    if (heartbeatSha256 !== fingerprintV07AlignedV2(unsigned)) {
        throw new Error(`aligned v2 runner heartbeat self-hash mismatch: ${label}`);
    }
    return value as unknown as IV07AlignedV2RunnerHeartbeat;
}

interface IRunnerHeartbeatUpdate {
    phase: string;
    activePanelFingerprint?: string | null;
    activeGenomeSha256?: string | null;
    eventHeadSha256?: string | null;
}

function persistedShardInventory(
    artifactRoot: string,
    runFingerprint: string,
    countGames: boolean,
): Map<string, number> {
    const evidenceRoot = join(artifactRoot, "evidence");
    const inventory = new Map<string, number>();
    if (!existsSync(evidenceRoot)) return inventory;
    const visit = (directory: string): void => {
        if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) {
            throw new Error(`aligned v2 evidence inventory contains an unsafe directory: ${directory}`);
        }
        for (const entry of readdirSync(directory)) {
            const path = join(directory, entry);
            const stat = lstatSync(path);
            if (stat.isSymbolicLink()) throw new Error(`aligned v2 evidence inventory contains a symlink: ${path}`);
            if (stat.isDirectory()) {
                visit(path);
                continue;
            }
            if (
                !stat.isFile() ||
                entry !== "manifest.json" ||
                !/^shard-[0-9]{5}-[0-9a-f]{16}$/.test(basename(directory))
            )
                continue;
            const manifest = readCanonicalJson<unknown>(path, "aligned v2 persisted shard manifest inventory");
            if (
                !isObject(manifest) ||
                manifest.schemaVersion !== 1 ||
                manifest.artifactKind !== "v0_7_aligned_96h_v2_shard_artifacts" ||
                manifest.runFingerprint !== runFingerprint ||
                typeof manifest.shardSha256 !== "string" ||
                !isObject(manifest.files) ||
                !isObject(manifest.files.rawRecords)
            ) {
                throw new Error(`aligned v2 persisted shard inventory manifest is invalid: ${path}`);
            }
            requireSha256(manifest.shardSha256, "persisted shard inventory shardSha256");
            requireInteger(manifest.files.rawRecords.rows, "persisted shard inventory rawRecords.rows", 1);
            requireSha256(manifest.manifestSha256, "persisted shard inventory manifestSha256");
            const { manifestSha256, ...unsigned } = manifest;
            if (manifestSha256 !== fingerprintV07AlignedV2(unsigned)) {
                throw new Error(`aligned v2 persisted shard inventory manifest self-hash mismatch: ${path}`);
            }
            if (inventory.has(manifest.shardSha256)) {
                throw new Error(`aligned v2 persisted shard inventory duplicated ${manifest.shardSha256}`);
            }
            inventory.set(manifest.shardSha256, countGames ? (manifest.files.rawRecords.rows as number) : 0);
        }
    };
    visit(evidenceRoot);
    return inventory;
}

class V07AlignedV2RunnerHeartbeatWriter {
    private current: IV07AlignedV2RunnerHeartbeat | null = null;
    private readonly completed: Map<string, number>;
    public constructor(
        private readonly path: string,
        private readonly runFingerprint: string,
        artifactRoot: string,
        countGames: boolean,
    ) {
        this.completed = persistedShardInventory(artifactRoot, runFingerprint, countGames);
        if (existsSync(path)) {
            this.current = validateV07AlignedV2RunnerHeartbeat(
                readCanonicalJson<unknown>(path, "aligned v2 runner heartbeat"),
                runFingerprint,
                path,
            );
            const completedGames = [...this.completed.values()].reduce((sum, games) => sum + games, 0);
            if (this.current.completedShards > this.completed.size || this.current.completedGames > completedGames) {
                throw new Error("aligned v2 runner heartbeat progress exceeds the persisted shard inventory");
            }
        }
    }
    public recordPersistedShard(shardSha256: string, games: number): void {
        requireSha256(shardSha256, "runner heartbeat persisted shardSha256");
        requireInteger(games, "runner heartbeat persisted shard games");
        const existing = this.completed.get(shardSha256);
        if (existing !== undefined && existing !== games) {
            throw new Error(`runner heartbeat persisted shard ${shardSha256} changed its game count`);
        }
        this.completed.set(shardSha256, games);
    }
    public persistedProgress(): { persistedGames: number; persistedShards: number } {
        return {
            persistedGames: [...this.completed.values()].reduce((sum, games) => sum + games, 0),
            persistedShards: this.completed.size,
        };
    }
    public write(update: IRunnerHeartbeatUpdate): IV07AlignedV2RunnerHeartbeat {
        const previous = this.current;
        const persistedProgress = this.persistedProgress();
        const activePanelFingerprint = update.activePanelFingerprint ?? null;
        const activeGenomeSha256 = update.activeGenomeSha256 ?? null;
        const eventHeadSha256 = update.eventHeadSha256 ?? null;
        for (const [label, hash] of [
            ["activePanelFingerprint", activePanelFingerprint],
            ["activeGenomeSha256", activeGenomeSha256],
            ["eventHeadSha256", eventHeadSha256],
        ] as const) {
            if (hash !== null) requireSha256(hash, `runner heartbeat ${label}`);
        }
        const unsigned = {
            schemaVersion: 1 as const,
            artifactKind: "v0_7_aligned_96h_v2_runner_heartbeat" as const,
            runFingerprint: this.runFingerprint,
            sequence: (previous?.sequence ?? -1) + 1,
            phase: update.phase,
            activePanelFingerprint,
            activeGenomeSha256,
            completedShards: persistedProgress.persistedShards,
            completedGames: persistedProgress.persistedGames,
            eventHeadSha256,
            updatedAtMs: Math.max(Date.now(), previous?.updatedAtMs ?? 0),
        };
        if (!unsigned.phase) throw new Error("runner heartbeat phase must not be empty");
        const heartbeat: IV07AlignedV2RunnerHeartbeat = {
            ...unsigned,
            heartbeatSha256: fingerprintV07AlignedV2(unsigned),
        };
        writeAtomicReplacement(this.path, canonicalFile(heartbeat));
        this.current = heartbeat;
        return heartbeat;
    }
}

interface IV07AlignedV2RunnerExecutionMetrics {
    invocationGamesExecuted: number;
    invocationWorkersStarted: number;
}

function validateScanFiles(value: unknown, label: string): IV07AlignedV2RunnerScanFiles {
    if (
        !isObject(value) ||
        !exactKeys(value, ["firstSummaryPath", "firstSeedSetPath", "replaySummaryPath", "replaySeedSetPath"])
    ) {
        throw new Error(`${label} fields are not exact`);
    }
    for (const key of ["firstSummaryPath", "firstSeedSetPath", "replaySummaryPath", "replaySeedSetPath"] as const) {
        validateRelativePath(value[key], `${label}.${key}`);
    }
    return value as unknown as IV07AlignedV2RunnerScanFiles;
}

export function validateV07AlignedV2RunnerConfig(value: unknown): IV07AlignedV2RunnerConfig {
    if (
        !isObject(value) ||
        !exactKeys(value, [
            "schemaVersion",
            "artifactKind",
            "status",
            "automaticBake",
            "automaticDeploy",
            "mode",
            "seedInputs",
            "allocationRequest",
            "throughput",
            "configSha256",
        ]) ||
        value.schemaVersion !== 1 ||
        value.artifactKind !== "v0_7_aligned_96h_v2_runner_config" ||
        value.status !== "research_only_no_bake" ||
        value.automaticBake !== false ||
        value.automaticDeploy !== false ||
        !(value.mode === "production" || value.mode === "synthetic_preflight")
    ) {
        throw new Error("aligned v2 runner config header/fields are invalid");
    }
    if (
        !isObject(value.seedInputs) ||
        !exactKeys(value.seedInputs, ["secretPath", "local", "zinc", "committedManifests"])
    ) {
        throw new Error("aligned v2 runner seedInputs fields are not exact");
    }
    validateRelativePath(value.seedInputs.secretPath, "seedInputs.secretPath");
    const local = validateScanFiles(value.seedInputs.local, "seedInputs.local");
    const zinc = validateScanFiles(value.seedInputs.zinc, "seedInputs.zinc");
    if (!Array.isArray(value.seedInputs.committedManifests)) {
        throw new Error("seedInputs.committedManifests must be an array");
    }
    const committedManifests = value.seedInputs.committedManifests.map((entry, index) => {
        if (!isObject(entry) || !exactKeys(entry, ["path", "sourcePath"])) {
            throw new Error(`seedInputs.committedManifests[${index}] fields are not exact`);
        }
        const path = validateRelativePath(entry.path, `seedInputs.committedManifests[${index}].path`);
        const sourcePath = validateRelativePath(entry.sourcePath, `seedInputs.committedManifests[${index}].sourcePath`);
        return { path, sourcePath };
    });
    if (
        new Set(committedManifests.map((entry) => entry.path)).size !== committedManifests.length ||
        canonicalV07AlignedV2Json(committedManifests) !==
            canonicalV07AlignedV2Json(
                [...committedManifests].sort((left, right) => left.path.localeCompare(right.path)),
            )
    ) {
        throw new Error("seedInputs.committedManifests must have unique canonically sorted paths");
    }
    const allocationRequest = validateV07AlignedV2SeedAllocationRequest(value.allocationRequest);
    if (
        (value.mode === "production" && allocationRequest.mode !== "production") ||
        (value.mode === "synthetic_preflight" && allocationRequest.mode !== "synthetic_dry_run")
    ) {
        throw new Error("runner and seed allocation modes do not match");
    }
    if (
        !isObject(value.throughput) ||
        !exactKeys(value.throughput, [
            "logicalCpus",
            "reservedCpus",
            "workersPerShard",
            "concurrentShards",
            "maxScenarioPairsPerShard",
            "gamesPerWorkerHour",
            "utilization",
            "safetyFactor",
            "panelStartupMinutes",
            "shardTimeoutMinutes",
            "rateAttestationPath",
            "rateAttestationBytesSha256",
            "rateAttestationSha256",
        ])
    ) {
        throw new Error("aligned v2 throughput budget fields are not exact");
    }
    requireInteger(value.throughput.logicalCpus, "throughput.logicalCpus", 1);
    requireInteger(value.throughput.reservedCpus, "throughput.reservedCpus");
    requireInteger(value.throughput.workersPerShard, "throughput.workersPerShard", 1);
    requireInteger(value.throughput.concurrentShards, "throughput.concurrentShards", 1);
    requireInteger(value.throughput.maxScenarioPairsPerShard, "throughput.maxScenarioPairsPerShard", 1);
    requireFinite(value.throughput.gamesPerWorkerHour, "throughput.gamesPerWorkerHour", 0);
    requireFinite(value.throughput.utilization, "throughput.utilization", 0);
    requireFinite(value.throughput.safetyFactor, "throughput.safetyFactor", 0);
    if (
        typeof value.throughput.panelStartupMinutes !== "number" ||
        !Number.isFinite(value.throughput.panelStartupMinutes) ||
        value.throughput.panelStartupMinutes < 0
    ) {
        throw new Error("throughput.panelStartupMinutes must be finite and >= 0");
    }
    requireFinite(value.throughput.shardTimeoutMinutes, "throughput.shardTimeoutMinutes", 0);
    validateRelativePath(value.throughput.rateAttestationPath, "throughput.rateAttestationPath");
    requireSha256(value.throughput.rateAttestationBytesSha256, "throughput.rateAttestationBytesSha256");
    requireSha256(value.throughput.rateAttestationSha256, "throughput.rateAttestationSha256");
    if (value.throughput.utilization > 1 || value.throughput.safetyFactor < 1) {
        throw new Error("throughput utilization must be <= 1 and safetyFactor must be >= 1");
    }
    if (value.throughput.shardTimeoutMinutes > 30) {
        throw new Error("throughput shardTimeoutMinutes must be <= 30 to preserve runner heartbeat freshness");
    }
    const totalWorkers = value.throughput.workersPerShard * value.throughput.concurrentShards;
    if (
        value.throughput.reservedCpus >= value.throughput.logicalCpus ||
        totalWorkers > value.throughput.logicalCpus - value.throughput.reservedCpus
    ) {
        throw new Error("throughput worker concurrency exceeds the non-reserved logical CPUs");
    }
    requireSha256(value.configSha256, "configSha256");
    const unsigned = { ...value };
    delete unsigned.configSha256;
    if (value.configSha256 !== fingerprintV07AlignedV2(unsigned)) {
        throw new Error("aligned v2 runner config self-hash mismatch");
    }
    return {
        ...(value as unknown as IV07AlignedV2RunnerConfig),
        seedInputs: {
            secretPath: value.seedInputs.secretPath as string,
            local,
            zinc,
            committedManifests,
        },
        allocationRequest,
    };
}

function validateDefinitionBootstrapRequest(value: unknown): IV07AlignedV2DefinitionBootstrapRequest {
    if (
        !isObject(value) ||
        !exactKeys(value, [
            "schemaVersion",
            "artifactKind",
            "status",
            "automaticBake",
            "automaticDeploy",
            "runId",
            "createdAtMs",
            "candidateLimit",
            "schedule",
            "candidateGenomes",
            "incumbentGenome",
            "composedSealPath",
            "composedSealBytesSha256",
            "requestSha256",
        ]) ||
        value.schemaVersion !== 1 ||
        value.artifactKind !== "v0_7_aligned_96h_v2_definition_bootstrap_request" ||
        value.status !== "research_only_no_bake" ||
        value.automaticBake !== false ||
        value.automaticDeploy !== false ||
        typeof value.runId !== "string" ||
        !value.runId.trim() ||
        !Array.isArray(value.candidateGenomes) ||
        !value.candidateGenomes.length ||
        !isObject(value.incumbentGenome)
    ) {
        throw new Error("aligned v2 definition bootstrap request header/fields are invalid");
    }
    requireInteger(value.createdAtMs, "definition bootstrap createdAtMs");
    requireInteger(value.candidateLimit, "definition bootstrap candidateLimit", 1);
    if (
        !isObject(value.schedule) ||
        !exactKeys(value.schedule, ["startAtMs", "trainDeadlineAtMs", "confirmDeadlineAtMs", "finalDeadlineAtMs"])
    ) {
        throw new Error("aligned v2 definition bootstrap schedule fields are not exact");
    }
    for (const key of ["startAtMs", "trainDeadlineAtMs", "confirmDeadlineAtMs", "finalDeadlineAtMs"] as const) {
        requireInteger(value.schedule[key], `definition bootstrap schedule.${key}`);
    }
    validateRelativePath(value.composedSealPath, "definition bootstrap composedSealPath");
    requireSha256(value.composedSealBytesSha256, "definition bootstrap composedSealBytesSha256");
    requireSha256(value.requestSha256, "definition bootstrap requestSha256");
    const unsigned = { ...value };
    delete unsigned.requestSha256;
    if (value.requestSha256 !== fingerprintV07AlignedV2(unsigned)) {
        throw new Error("aligned v2 definition bootstrap request self-hash mismatch");
    }
    return value as unknown as IV07AlignedV2DefinitionBootstrapRequest;
}

function sourceBytesSha256(fileName: string): string {
    const path = join(dirname(fileURLToPath(import.meta.url)), fileName);
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function currentHostFingerprintSha256(): string {
    return fingerprintV07AlignedV2({
        hostname: hostname(),
        platform: platform(),
        architecture: arch(),
        release: release(),
        logicalCpus: availableParallelism(),
    });
}

export function validateV07AlignedV2ThroughputAttestation(
    value: unknown,
    throughput: IV07AlignedV2RunnerThroughputBudget,
    context?: { mode: V07AlignedV2RunnerMode; configRoot: string },
): IV07AlignedV2ThroughputAttestation {
    if (isObject(value) && value.schemaVersion === 2) {
        if (context?.mode !== "production") {
            throw new Error("replayable production throughput evidence is valid only in production mode");
        }
        return validateV07AlignedV2ProductionThroughputAttestation(value, {
            configRoot: context.configRoot,
            expected: {
                logicalCpus: throughput.logicalCpus,
                reservedCpus: throughput.reservedCpus,
                workersPerShard: throughput.workersPerShard,
                concurrentShards: throughput.concurrentShards,
                maxScenarioPairsPerShard: throughput.maxScenarioPairsPerShard,
                shardTimeoutMinutes: throughput.shardTimeoutMinutes,
                gamesPerWorkerHour: throughput.gamesPerWorkerHour,
            },
            expectedAttestationSha256: throughput.rateAttestationSha256,
        }).attestation;
    }
    if (context?.mode === "production") {
        throw new Error("production mode requires schema-2 replayable throughput evidence");
    }
    if (
        !isObject(value) ||
        !exactKeys(value, [
            "schemaVersion",
            "artifactKind",
            "status",
            "automaticBake",
            "automaticDeploy",
            "measuredAtMs",
            "commit",
            "sourceTreeSha256",
            "bunVersion",
            "bunRevision",
            "bunExecutableSha256",
            "dependencyManifestSha256",
            "lockfileSha256",
            "hostFingerprintSha256",
            "logicalCpus",
            "workersPerShard",
            "concurrentShards",
            "sampleProtocol",
            "sampleGamesPerCellSeat",
            "sampleGames",
            "elapsedMs",
            "persistedReplayVerified",
            "workerAttestationsVerified",
            "gamesPerWorkerHour",
            "runnerBytesSha256",
            "evaluatorBytesSha256",
            "workerBytesSha256",
            "gameAdapterBytesSha256",
            "attestationSha256",
        ]) ||
        value.schemaVersion !== 1 ||
        value.artifactKind !== "v0_7_aligned_96h_v2_throughput_attestation" ||
        value.status !== "research_only_no_bake" ||
        value.automaticBake !== false ||
        value.automaticDeploy !== false ||
        value.sampleProtocol !== "all_12_cells_two_seats_persisted_round_robin" ||
        value.persistedReplayVerified !== true ||
        value.workerAttestationsVerified !== true
    ) {
        throw new Error("aligned v2 throughput attestation header/fields are invalid");
    }
    if (
        typeof value.commit !== "string" ||
        !/^[0-9a-f]{40}$/.test(value.commit) ||
        typeof value.bunVersion !== "string" ||
        !value.bunVersion ||
        typeof value.bunRevision !== "string" ||
        !value.bunRevision
    ) {
        throw new Error("aligned v2 throughput attestation revision/runtime provenance is invalid");
    }
    for (const [label, integer, minimum] of [
        ["measuredAtMs", value.measuredAtMs, 0],
        ["logicalCpus", value.logicalCpus, 1],
        ["workersPerShard", value.workersPerShard, 1],
        ["concurrentShards", value.concurrentShards, 1],
        ["sampleGamesPerCellSeat", value.sampleGamesPerCellSeat, 1],
        ["sampleGames", value.sampleGames, 1],
        ["elapsedMs", value.elapsedMs, 1],
    ] as const) {
        requireInteger(integer, `throughput attestation ${label}`, minimum);
    }
    requireFinite(value.gamesPerWorkerHour, "throughput attestation gamesPerWorkerHour", 0);
    for (const key of [
        "hostFingerprintSha256",
        "sourceTreeSha256",
        "bunExecutableSha256",
        "dependencyManifestSha256",
        "runnerBytesSha256",
        "evaluatorBytesSha256",
        "workerBytesSha256",
        "gameAdapterBytesSha256",
        "attestationSha256",
    ] as const) {
        requireSha256(value[key], `throughput attestation ${key}`);
    }
    if (value.lockfileSha256 !== null) requireSha256(value.lockfileSha256, "throughput attestation lockfileSha256");
    const { attestationSha256, ...unsigned } = value;
    if (
        attestationSha256 !== fingerprintV07AlignedV2(unsigned) ||
        attestationSha256 !== throughput.rateAttestationSha256
    ) {
        throw new Error("aligned v2 throughput attestation semantic hash mismatch");
    }
    const actualLogicalCpus = availableParallelism();
    const expectedRate =
        ((value.sampleGames as number) * HOUR_MS) /
        ((value.elapsedMs as number) * (value.workersPerShard as number) * (value.concurrentShards as number));
    const relativeRateError = Math.abs((value.gamesPerWorkerHour as number) - expectedRate) / expectedRate;
    if (
        value.hostFingerprintSha256 !== currentHostFingerprintSha256() ||
        value.logicalCpus !== actualLogicalCpus ||
        value.logicalCpus !== throughput.logicalCpus ||
        value.workersPerShard !== throughput.workersPerShard ||
        value.concurrentShards !== throughput.concurrentShards ||
        value.gamesPerWorkerHour !== throughput.gamesPerWorkerHour ||
        relativeRateError > 1e-12 ||
        value.sampleGames !== (value.sampleGamesPerCellSeat as number) * 24 ||
        (value.sampleGames as number) < throughput.maxScenarioPairsPerShard * 2 ||
        value.runnerBytesSha256 !== sourceBytesSha256("v0_7_aligned_96h_v2_runner.ts") ||
        value.evaluatorBytesSha256 !== sourceBytesSha256("v0_7_aligned_96h_v2_evaluator.ts") ||
        value.workerBytesSha256 !== sourceBytesSha256("v0_7_aligned_96h_v2_worker.ts") ||
        value.gameAdapterBytesSha256 !== sourceBytesSha256("v0_7_aligned_96h_v2_game_adapter.ts")
    ) {
        throw new Error("aligned v2 throughput attestation does not bind this exact code, host, and shard geometry");
    }
    return value as unknown as IV07AlignedV2SyntheticThroughputAttestation;
}

function loadThroughputAttestation(
    configRoot: string,
    config: IV07AlignedV2RunnerConfig,
): IV07AlignedV2ThroughputAttestation {
    const throughput = config.throughput;
    const path = resolveExistingFile(configRoot, throughput.rateAttestationPath, "throughput rate attestation");
    const bytes = readFileSync(path);
    if (createHash("sha256").update(bytes).digest("hex") !== throughput.rateAttestationBytesSha256) {
        throw new Error("aligned v2 throughput attestation raw bytes changed");
    }
    return validateV07AlignedV2ThroughputAttestation(
        parseCanonicalJsonBytes<unknown>(bytes, "aligned v2 throughput attestation"),
        throughput,
        { mode: config.mode, configRoot },
    );
}

function loadScan(
    root: string,
    site: "local" | "zinc",
    files: IV07AlignedV2RunnerScanFiles,
): IV07AlignedV2SeedScanReplayInput {
    const read = (path: string, label: string): Buffer => readFileSync(resolveExistingFile(root, path, label));
    return {
        site,
        first: {
            summaryBytes: read(files.firstSummaryPath, `${site} first summary`),
            seedSetBytes: read(files.firstSeedSetPath, `${site} first seed set`),
        },
        replay: {
            summaryBytes: read(files.replaySummaryPath, `${site} replay summary`),
            seedSetBytes: read(files.replaySeedSetPath, `${site} replay seed set`),
        },
    };
}

export function prepareV07AlignedV2Runner(configPathInput: string): IV07AlignedV2RunnerPreparation {
    if (
        !existsSync(configPathInput) ||
        lstatSync(configPathInput).isSymbolicLink() ||
        !lstatSync(configPathInput).isFile()
    ) {
        throw new Error("aligned v2 runner config must be a regular non-symlink file");
    }
    const configPath = realpathSync(configPathInput);
    const configRoot = realpathSync(dirname(configPath));
    const configBytes = readFileSync(configPath);
    const configBytesSha256 = createHash("sha256").update(configBytes).digest("hex");
    const config = validateV07AlignedV2RunnerConfig(
        parseCanonicalJsonBytes<unknown>(configBytes, "aligned v2 runner config"),
    );
    const throughputAttestation = loadThroughputAttestation(configRoot, config);
    const secretPath = resolveExistingFile(configRoot, config.seedInputs.secretPath, "seed secret");
    const secretStat = statSync(secretPath);
    if (
        config.mode === "production" &&
        ((typeof process.getuid === "function" && secretStat.uid !== process.getuid()) ||
            (secretStat.mode & 0o077) !== 0 ||
            (secretStat.mode & 0o400) === 0)
    ) {
        throw new Error("aligned v2 production seed secret must be owned by the current uid and private to its owner");
    }
    const secret = new Uint8Array(readFileSync(secretPath));
    if (secret.byteLength !== 32) throw new Error("aligned v2 seed secret must contain exactly 32 raw bytes");
    const committedManifests: IV07AlignedV2CommittedManifestInput[] = config.seedInputs.committedManifests.map(
        (entry) => ({
            path: entry.path,
            bytes: readFileSync(resolveExistingFile(configRoot, entry.sourcePath, `committed manifest ${entry.path}`)),
        }),
    );
    const corpus = ingestV07AlignedV2SeedCorpus({
        scans: [
            loadScan(configRoot, "local", config.seedInputs.local),
            loadScan(configRoot, "zinc", config.seedInputs.zinc),
        ],
        committedManifests,
    });
    const commitment = commitV07AlignedV2SeedAllocation(config.allocationRequest, corpus, secret);
    const finalPanelCommitment: IV07AlignedV2CheckpointPanelBinding = {
        schemaVersion: 1,
        mode: "seed_plan",
        panelId: commitment.finalPlanDescriptor.panelId,
        purpose: "final",
        denysetSha256: commitment.denysetSha256,
        scenariosPerCell: commitment.finalPlanDescriptor.scenariosPerCell,
        panelFingerprint: commitment.finalPlanSha256,
        taskCount: commitment.finalTaskCount,
        tasksSha256: commitment.finalTasksSha256,
    };
    const commitmentBytes = canonicalFile(commitment);
    const commitmentRef = {
        path: COMMITMENT_PATH,
        bytesSha256: createHash("sha256").update(commitmentBytes).digest("hex"),
        artifactSha256: commitment.commitmentSha256,
    };
    return {
        config,
        configBytesSha256,
        throughputAttestation,
        corpus,
        secret,
        commitment,
        finalPanelCommitment,
        commitmentRef,
    };
}

export function validateV07AlignedV2RunnerBudget(
    config: IV07AlignedV2RunnerConfig,
    definition: IV07AlignedV2OrchestratorDefinition,
): IV07AlignedV2RunnerBudgetReport {
    const throughput = config.throughput;
    const totalWorkers = throughput.workersPerShard * throughput.concurrentShards;
    const actualLogicalCpus = availableParallelism();
    if (throughput.logicalCpus !== actualLogicalCpus) {
        throw new Error(
            `aligned v2 throughput budget logicalCpus ${throughput.logicalCpus} != host ${actualLogicalCpus}`,
        );
    }
    const effectiveRate =
        (totalWorkers * throughput.gamesPerWorkerHour * throughput.utilization) / throughput.safetyFactor;
    const perShardEffectiveRate =
        (throughput.workersPerShard * throughput.gamesPerWorkerHour * throughput.utilization) / throughput.safetyFactor;
    const maxShardGames = throughput.maxScenarioPairsPerShard * 2;
    const estimatedMaxShardMinutes = (maxShardGames / perShardEffectiveRate) * 60;
    const overhead = throughput.panelStartupMinutes / 60;
    const trainGames = definition.panels.train.taskCount * definition.candidates.length;
    const confirmGames = definition.panels.confirm.taskCount * 2;
    const finalGames = definition.panels.finalCommitment.taskCount;
    const trainWindowHours = (definition.schedule.trainDeadlineAtMs - definition.schedule.startAtMs) / HOUR_MS;
    const confirmWindowHours =
        (definition.schedule.confirmDeadlineAtMs - definition.schedule.trainDeadlineAtMs) / HOUR_MS;
    const finalWindowHours =
        (definition.schedule.finalDeadlineAtMs - definition.schedule.confirmDeadlineAtMs) / HOUR_MS;
    const estimatedTrainHours = trainGames / effectiveRate + overhead * definition.candidates.length;
    const estimatedConfirmHours = confirmGames / effectiveRate + overhead * 2;
    const estimatedFinalHours = finalGames / effectiveRate + overhead;
    if (
        finalWindowHours < 36 ||
        estimatedMaxShardMinutes > throughput.shardTimeoutMinutes ||
        estimatedTrainHours > trainWindowHours ||
        estimatedConfirmHours > confirmWindowHours ||
        estimatedFinalHours > finalWindowHours
    ) {
        throw new Error(
            `aligned v2 throughput budget is impossible: train ${estimatedTrainHours.toFixed(3)}/${trainWindowHours.toFixed(3)}h, ` +
                `confirm ${estimatedConfirmHours.toFixed(3)}/${confirmWindowHours.toFixed(3)}h, ` +
                `final ${estimatedFinalHours.toFixed(3)}/${finalWindowHours.toFixed(3)}h, ` +
                `max shard ${estimatedMaxShardMinutes.toFixed(3)}/${throughput.shardTimeoutMinutes.toFixed(3)}m`,
        );
    }
    const unsigned = {
        schemaVersion: 1 as const,
        artifactKind: "v0_7_aligned_96h_v2_throughput_budget" as const,
        totalWorkers,
        reservedCpus: throughput.reservedCpus,
        trainGames,
        confirmGames,
        finalGames,
        trainWindowHours,
        confirmWindowHours,
        finalWindowHours,
        estimatedTrainHours,
        estimatedConfirmHours,
        estimatedFinalHours,
        finalHoursReserved: finalWindowHours,
        actualLogicalCpus,
        maxShardGames,
        estimatedMaxShardMinutes,
        shardTimeoutMinutes: throughput.shardTimeoutMinutes,
        rateAttestationSha256: throughput.rateAttestationSha256,
        rateAttestationBytesSha256: throughput.rateAttestationBytesSha256,
        passed: true as const,
    };
    return { ...unsigned, budgetSha256: fingerprintV07AlignedV2(unsigned) };
}

function writeDurableExclusive(path: string, contents: string): void {
    const descriptor = openSync(path, "wx", 0o640);
    try {
        writeFileSync(descriptor, contents, "utf8");
        fsyncSync(descriptor);
    } finally {
        closeSync(descriptor);
    }
}

function validatePreparedBundleBytes(directory: string, expected: ReadonlyMap<string, Buffer>): void {
    if (!existsSync(directory) || lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) {
        throw new Error("aligned v2 prepared definition bundle must be a regular non-symlink directory");
    }
    const rootInventory = readdirSync(directory).sort();
    if (
        canonicalV07AlignedV2Json(rootInventory) !==
        canonicalV07AlignedV2Json(["bundle.json", "definition.json", "seed-allocation"])
    ) {
        throw new Error("aligned v2 prepared definition bundle root inventory is not exact");
    }
    const seedDirectory = join(directory, "seed-allocation");
    if (
        lstatSync(seedDirectory).isSymbolicLink() ||
        !lstatSync(seedDirectory).isDirectory() ||
        canonicalV07AlignedV2Json(readdirSync(seedDirectory).sort()) !== canonicalV07AlignedV2Json(["commitment.json"])
    ) {
        throw new Error("aligned v2 prepared definition seed-allocation inventory is not exact");
    }
    for (const [relativePath, bytes] of expected) {
        const path = join(directory, ...relativePath.split("/"));
        if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
            throw new Error(`aligned v2 prepared definition bundle file is unsafe: ${relativePath}`);
        }
        if (!readFileSync(path).equals(bytes)) {
            throw new Error(`aligned v2 prepared definition bundle file differs: ${relativePath}`);
        }
    }
}

function publishPreparedDefinitionBundle(directoryInput: string, expected: ReadonlyMap<string, Buffer>): void {
    const requested = resolve(directoryInput);
    const parentInput = dirname(requested);
    ensureDurableDirectory(parentInput);
    const parent = realpathSync(parentInput);
    const directory = join(parent, basename(requested));
    if (existsSync(directory)) {
        validatePreparedBundleBytes(directory, expected);
        return;
    }
    const prefix = `.${basename(directory)}.tmp-`;
    for (const entry of readdirSync(parent).filter((name) => name.startsWith(prefix))) {
        const abandoned = join(parent, entry);
        renameSync(abandoned, `${abandoned}.abandoned-${Date.now()}-${process.pid}-${randomUUID()}`);
        fsyncDirectory(parent);
    }
    const temporary = join(parent, `${prefix}${process.pid}-${randomUUID()}`);
    try {
        mkdirSync(temporary, { mode: 0o750 });
        fsyncDirectory(parent);
        const seedDirectory = join(temporary, "seed-allocation");
        mkdirSync(seedDirectory, { mode: 0o750 });
        fsyncDirectory(temporary);
        for (const [relativePath, bytes] of expected) {
            const path = join(temporary, ...relativePath.split("/"));
            writeDurableExclusive(path, bytes.toString("utf8"));
        }
        fsyncDirectory(seedDirectory);
        fsyncDirectory(temporary);
        renameSync(temporary, directory);
        fsyncDirectory(parent);
    } catch (error) {
        if (existsSync(directory)) {
            validatePreparedBundleBytes(directory, expected);
            return;
        }
        throw error;
    } finally {
        if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
    }
}

export interface IV07AlignedV2PrepareDefinitionInvocation {
    configPath: string;
    requestPath: string;
    preparedDirectory: string;
}

export function prepareV07AlignedV2DefinitionBundle(
    invocation: IV07AlignedV2PrepareDefinitionInvocation,
): IV07AlignedV2PreparedDefinitionBundle {
    if (
        !existsSync(invocation.requestPath) ||
        lstatSync(invocation.requestPath).isSymbolicLink() ||
        !lstatSync(invocation.requestPath).isFile()
    ) {
        throw new Error("aligned v2 definition bootstrap request must be a regular non-symlink file");
    }
    const requestPath = realpathSync(invocation.requestPath);
    const requestRoot = realpathSync(dirname(requestPath));
    const request = validateDefinitionBootstrapRequest(
        readCanonicalJson<unknown>(requestPath, "aligned v2 definition bootstrap request"),
    );
    const composedSealPath = resolveExistingFile(
        requestRoot,
        request.composedSealPath,
        "definition bootstrap composed seal",
    );
    const composedSealBytes = readFileSync(composedSealPath);
    const composedSealBytesSha256 = createHash("sha256").update(composedSealBytes).digest("hex");
    if (composedSealBytesSha256 !== request.composedSealBytesSha256) {
        throw new Error("aligned v2 definition bootstrap composed seal bytes changed");
    }
    const preparation = prepareV07AlignedV2Runner(invocation.configPath);
    if (preparation.config.mode === "production" && Date.now() >= request.schedule.startAtMs) {
        throw new Error("aligned v2 production definition must be prepared before its immutable start time");
    }
    const definition = createV07AlignedV2OrchestratorDefinition({
        mode: preparation.config.mode === "production" ? "formal" : "synthetic_dry_run",
        runId: request.runId,
        createdAtMs: request.createdAtMs,
        composedSealSha256: composedSealBytesSha256,
        candidateLimit: request.candidateLimit,
        schedule: request.schedule,
        candidateGenomes: request.candidateGenomes,
        incumbentGenome: request.incumbentGenome,
        trainSeedPlan: preparation.commitment.trainPlan,
        confirmSeedPlan: preparation.commitment.confirmPlan,
        finalPanelCommitment: preparation.finalPanelCommitment,
        seedCommitment: preparation.commitmentRef,
    });
    const budget = validateV07AlignedV2RunnerBudget(preparation.config, definition);
    const commitmentBytes = Buffer.from(canonicalFile(preparation.commitment), "utf8");
    const definitionBytes = Buffer.from(canonicalFile(definition), "utf8");
    const unsigned = {
        schemaVersion: 1 as const,
        artifactKind: "v0_7_aligned_96h_v2_prepared_definition_bundle" as const,
        status: "research_only_no_bake" as const,
        automaticBake: false as const,
        automaticDeploy: false as const,
        runFingerprint: definition.definitionSha256,
        configSha256: preparation.config.configSha256,
        configBytesSha256: preparation.configBytesSha256,
        requestSha256: request.requestSha256,
        commitmentPath: COMMITMENT_PATH as "seed-allocation/commitment.json",
        commitmentSha256: preparation.commitment.commitmentSha256,
        commitmentBytesSha256: createHash("sha256").update(commitmentBytes).digest("hex"),
        definitionPath: "definition.json" as const,
        definitionSha256: definition.definitionSha256,
        definitionBytesSha256: createHash("sha256").update(definitionBytes).digest("hex"),
        composedSealBytesSha256,
        rateAttestationSha256: preparation.throughputAttestation.attestationSha256,
        rateAttestationBytesSha256: preparation.config.throughput.rateAttestationBytesSha256,
        budget,
        gamesExecuted: 0 as const,
        workersStarted: 0 as const,
    };
    const bundle: IV07AlignedV2PreparedDefinitionBundle = {
        ...unsigned,
        bundleSha256: fingerprintV07AlignedV2(unsigned),
    };
    const expected = new Map<string, Buffer>([
        [COMMITMENT_PATH, commitmentBytes],
        ["definition.json", definitionBytes],
        ["bundle.json", Buffer.from(canonicalFile(bundle), "utf8")],
    ]);
    publishPreparedDefinitionBundle(invocation.preparedDirectory, expected);
    return bundle;
}

function validateSupervisorProtocol(
    invocation: IV07AlignedV2RunnerInvocation,
    definition: IV07AlignedV2OrchestratorDefinition,
    preparation?: IV07AlignedV2RunnerPreparation,
): void {
    const environment = invocation.environment;
    const expectedEnvironment: Record<string, string> = {
        V07_ALIGNED_V2_OUT: resolve(invocation.orchestratorDirectory),
        V07_ALIGNED_V2_DEFINITION: realpathSync(invocation.definitionPath),
        V07_ALIGNED_V2_DEADLINE_MS: String(definition.schedule.finalDeadlineAtMs),
        V07_ALIGNED_V2_DEADLINE_EPOCH: String(Math.floor(definition.schedule.finalDeadlineAtMs / 1000)),
        V07_ALIGNED_V2_RESEARCH_ONLY: "1",
        V07_ALIGNED_V2_NO_BAKE: "1",
        V07_ALIGNED_V2_NO_DEPLOY: "1",
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    };
    if (preparation) {
        expectedEnvironment.V07_ALIGNED_V2_RUNNER_CONFIG_SHA256 = preparation.config.configSha256;
        expectedEnvironment.V07_ALIGNED_V2_RUNNER_CONFIG_BYTES_SHA256 = preparation.configBytesSha256;
        expectedEnvironment.V07_ALIGNED_V2_RATE_ATTESTATION_SHA256 =
            preparation.throughputAttestation.attestationSha256;
    }
    for (const [key, expected] of Object.entries(expectedEnvironment)) {
        if (environment[key] !== expected) throw new Error(`aligned v2 runner supervisor protocol mismatch for ${key}`);
    }
}

function sameValue(left: unknown, right: unknown): boolean {
    return canonicalV07AlignedV2Json(left) === canonicalV07AlignedV2Json(right);
}

function validateComposition(
    invocation: IV07AlignedV2RunnerInvocation,
    preparation: IV07AlignedV2RunnerPreparation,
    definition: IV07AlignedV2OrchestratorDefinition,
): IV07AlignedV2RunnerBudgetReport {
    if (
        (invocation.preflight && preparation.config.mode !== "synthetic_preflight") ||
        (!invocation.preflight && preparation.config.mode !== "production") ||
        (invocation.preflight && definition.mode !== "synthetic_dry_run") ||
        (!invocation.preflight && definition.mode !== "formal")
    ) {
        throw new Error("aligned v2 runner/config/definition modes do not match");
    }
    if (
        !sameValue(bindV07AlignedV2SeedPlan(preparation.commitment.trainPlan), definition.panels.train) ||
        !sameValue(bindV07AlignedV2SeedPlan(preparation.commitment.confirmPlan), definition.panels.confirm) ||
        !sameValue(preparation.finalPanelCommitment, definition.panels.finalCommitment) ||
        !sameValue(preparation.commitmentRef, definition.seedCommitment)
    ) {
        throw new Error("aligned v2 recomputed allocation does not match the preregistered definition");
    }
    return validateV07AlignedV2RunnerBudget(preparation.config, definition);
}

function auditRow(record: IV07AlignedV2BattleRecord, binding: IV07AlignedV2CandidateBinding): IV07ComposedAuditRow {
    return {
        t: "game",
        mode: "search",
        seed: record.combatSeed,
        green: record.greenVersion,
        red: record.redVersion,
        winner: record.winner,
        endReason: record.endReason,
        gate: binding.genome.search.gate,
        horizon: binding.genome.search.horizon,
        rollouts: binding.genome.search.rollouts,
        leaf: "learned_v2",
        decisions: 10,
        searched: 10,
        overrides: 1,
        illegalIncumbent: 0,
        shortlist: binding.genome.controls.shortlist,
        decisionDeadlineMs: binding.genome.controls.decisionDeadlineMs,
        deadlineFallbacks: 0,
        lateRangedFinishWeight: binding.genome.controls.lateRangedFinishWeight,
        pureRangedTerminalWeight: binding.genome.controls.pureRangedTerminalWeight,
        msTotal: 100,
        circuitBreakerMs: 275,
        circuitOpened: false,
        circuitSkipped: 0,
    };
}

function syntheticRecord(task: IV07AlignedV2ExecutionTask, outcome: V07AlignedV2Outcome): IV07AlignedV2BattleRecord {
    const candidateIsGreen = task.candidateSeat === "candidate_green";
    const candidateWon = outcome === "candidate_win";
    const winner = outcome === "draw" ? "draw" : candidateWon === candidateIsGreen ? "green" : "red";
    return {
        schemaVersion: 1,
        taskKey: v07AlignedV2TaskKey(task),
        panelId: task.panelId,
        cellId: task.cellId,
        scenarioOrdinal: task.scenarioOrdinal,
        scenarioId: task.scenarioId,
        candidateSeat: task.candidateSeat,
        setupSeed: task.setupSeeds[0],
        setupAttempt: 0,
        combatSeed: task.combatSeed,
        candidateIsGreen,
        greenVersion: candidateIsGreen ? "v0.7s" : "v0.6",
        redVersion: candidateIsGreen ? "v0.6" : "v0.7s",
        physicalSetupSha256: fingerprintV07AlignedV2({ task: v07AlignedV2TaskKey(task), physical: true }),
        lowerRoster: "synthetic-preflight-lower",
        upperRoster: "synthetic-preflight-upper",
        winner,
        winnerSlot: outcome === "draw" ? "draw" : candidateWon ? "candidate" : "opponent",
        laps: 4,
        endReason: outcome === "draw" ? "turn_cap" : "elimination",
        reachedArmageddon: false,
        decidedByArmageddon: false,
        rejectedGreen: 0,
        rejectedRed: 0,
        resultFingerprint: fingerprintV07AlignedV2({ task: v07AlignedV2TaskKey(task), outcome }),
    };
}

function syntheticShardEvaluation(
    shard: IV07AlignedV2CheckpointShardSpec,
    binding: IV07AlignedV2CandidateBinding,
    seedPlan: IV07AlignedV2InjectedSeedPlan,
    auditDirectory: string,
    outcome: V07AlignedV2Outcome,
): IV07AlignedV2ShardEvaluation {
    const tasks = flattenV07AlignedV2SeedPlan(seedPlan).slice(shard.pairStart * 2, shard.pairEndExclusive * 2);
    const records = tasks.map((task) => syntheticRecord(task, outcome));
    const audits = binding.searchEnabled ? records.map((record) => auditRow(record, binding)) : [];
    const observations = records.map((record, index) =>
        compactV07AlignedV2Observation(record, binding, binding.searchEnabled ? audits[index] : undefined),
    );
    const sourcePath = join(auditDirectory, "synthetic-worker-0.jsonl");
    const contents = audits.length ? `${audits.map((row) => canonicalV07AlignedV2Json(row)).join("\n")}\n` : "";
    const environment = buildV07AlignedV2CandidateEnvironment(binding.genome, sourcePath);
    return {
        shard,
        binding,
        checkpoint: createV07AlignedV2Checkpoint(shard, observations),
        records,
        attestations: [
            {
                workerIndex: 0,
                runFingerprint: shard.runFingerprint,
                genomeSha256: binding.genomeSha256,
                behaviorEnvironmentSha256: binding.behaviorEnvironmentSha256,
                environmentSha256: fingerprintV07AlignedV2(environment),
                removedEnvironmentKeys: Object.keys(environment).sort(),
                transpilerCacheDisabled: "0",
                auditPath: sourcePath,
            },
        ],
        auditArtifacts: [
            {
                workerIndex: 0,
                sourcePath,
                taskKeys: records.map((record) => record.taskKey),
                contents,
                contentsSha256: createHash("sha256").update(contents).digest("hex"),
                bytes: Buffer.byteLength(contents),
                rows: audits.length,
            },
        ],
    };
}

async function mapConcurrent<T, R>(
    values: readonly T[],
    concurrency: number,
    operation: (value: T) => Promise<R>,
): Promise<R[]> {
    const results = new Array<R>(values.length);
    let cursor = 0;
    let failure: unknown;
    const lanes = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
        while (failure === undefined && cursor < values.length) {
            const index = cursor++;
            try {
                results[index] = await operation(values[index]);
            } catch (error) {
                failure ??= error;
            }
        }
    });
    await Promise.all(lanes);
    if (failure !== undefined) throw failure;
    return results;
}

interface IPanelEvaluationContext {
    artifactRoot: string;
    definition: IV07AlignedV2OrchestratorDefinition;
    config: IV07AlignedV2RunnerConfig;
    binding: IV07AlignedV2CandidateBinding;
    seedPlan: IV07AlignedV2InjectedSeedPlan;
    preflight: boolean;
    outcome: V07AlignedV2Outcome;
    evaluateShard(options: IV07AlignedV2ShardEvaluationOptions): Promise<IV07AlignedV2ShardEvaluation>;
    deadlineAtMs: number;
    eventHeadSha256: string | null;
    heartbeat: V07AlignedV2RunnerHeartbeatWriter;
    metrics: IV07AlignedV2RunnerExecutionMetrics;
}

async function evaluatePanel(context: IPanelEvaluationContext): Promise<IV07AlignedV2PanelEvidenceInput> {
    const shards = buildV07AlignedV2CheckpointShardSpecs({
        runFingerprint: context.definition.definitionSha256,
        seedPlan: context.seedPlan,
        binding: context.binding,
        maxScenarioPairsPerShard: context.config.throughput.maxScenarioPairsPerShard,
    });
    const panelFingerprint = bindV07AlignedV2SeedPlan(context.seedPlan).panelFingerprint;
    const relativeEvidenceRoot = `evidence/${context.seedPlan.purpose}/${panelFingerprint}/${context.binding.genomeSha256}`;
    const evidenceRoot = join(context.artifactRoot, ...relativeEvidenceRoot.split("/"));
    ensureDurableDirectory(evidenceRoot);
    const persisted = await mapConcurrent(shards, context.config.throughput.concurrentShards, async (shard) => {
        const heartbeatBase = {
            activePanelFingerprint: panelFingerprint,
            activeGenomeSha256: context.binding.genomeSha256,
            eventHeadSha256: context.eventHeadSha256,
        };
        context.heartbeat.write({ phase: `${context.seedPlan.purpose}:shard-open`, ...heartbeatBase });
        const finalDirectory = join(evidenceRoot, v07AlignedV2ShardArtifactDirectoryName(shard));
        if (existsSync(finalDirectory)) {
            const reopened = loadV07AlignedV2PersistedShard(finalDirectory, {
                shard,
                binding: context.binding,
                seedPlan: context.seedPlan,
            });
            context.heartbeat.recordPersistedShard(
                shard.shardSha256,
                context.preflight ? 0 : reopened.evaluation.records.length,
            );
            context.heartbeat.write({ phase: `${context.seedPlan.purpose}:shard-reused`, ...heartbeatBase });
            return reopened;
        }
        const auditDirectory = join(
            context.artifactRoot,
            "audits",
            context.seedPlan.purpose,
            panelFingerprint,
            context.binding.genomeSha256,
            `shard-${String(shard.shardIndex).padStart(5, "0")}-${shard.shardSha256}`,
            `attempt-${Date.now()}-${process.pid}-${randomUUID()}`,
        );
        context.heartbeat.write({ phase: `${context.seedPlan.purpose}:shard-start`, ...heartbeatBase });
        const taskCount = (shard.pairEndExclusive - shard.pairStart) * 2;
        const evaluatorDeadlineAtMs = Math.min(
            context.deadlineAtMs,
            Date.now() + context.config.throughput.shardTimeoutMinutes * 60 * 1000,
        );
        let evaluation: IV07AlignedV2ShardEvaluation;
        if (context.preflight) {
            evaluation = syntheticShardEvaluation(
                shard,
                context.binding,
                context.seedPlan,
                auditDirectory,
                context.outcome,
            );
        } else {
            const pulseIntervalMs = Math.max(
                1_000,
                Math.min(60_000, (context.config.throughput.shardTimeoutMinutes * 60 * 1000) / 3),
            );
            const pulse = setInterval(() => {
                if (Date.now() >= evaluatorDeadlineAtMs) {
                    clearInterval(pulse);
                    return;
                }
                context.heartbeat.write({ phase: `${context.seedPlan.purpose}:shard-running`, ...heartbeatBase });
            }, pulseIntervalMs);
            try {
                evaluation = await context.evaluateShard({
                    shard,
                    seedPlan: context.seedPlan,
                    binding: context.binding,
                    workers: context.config.throughput.workersPerShard,
                    auditDirectory,
                    deadlineAtMs: evaluatorDeadlineAtMs,
                    onWorkerStarted: () => {
                        context.metrics.invocationWorkersStarted += 1;
                        context.heartbeat.write({
                            phase: `${context.seedPlan.purpose}:worker-started`,
                            ...heartbeatBase,
                        });
                    },
                });
            } finally {
                clearInterval(pulse);
            }
        }
        if (!context.preflight) context.metrics.invocationGamesExecuted += taskCount;
        context.heartbeat.write({
            phase: `${context.seedPlan.purpose}:shard-evaluated`,
            ...heartbeatBase,
        });
        const durable = persistV07AlignedV2ShardEvaluation(evidenceRoot, evaluation, context.seedPlan);
        context.heartbeat.recordPersistedShard(shard.shardSha256, context.preflight ? 0 : taskCount);
        context.heartbeat.write({
            phase: `${context.seedPlan.purpose}:shard-persisted`,
            ...heartbeatBase,
        });
        return durable;
    });
    return {
        panel: bindV07AlignedV2SeedPlan(context.seedPlan),
        genomeSha256: context.binding.genomeSha256,
        artifacts: persisted.map((entry) => ({
            directory: relative(context.artifactRoot, entry.directory).split(sep).join("/"),
            manifestSha256: entry.manifestSha256,
        })),
        observations: persisted.flatMap((entry) => entry.evaluation.checkpoint.observations),
    };
}

interface IV07AlignedV2RemainingPanelWork {
    games: number;
    startupPanels: number;
}

function remainingPanelWork(
    artifactRoot: string,
    definition: IV07AlignedV2OrchestratorDefinition,
    config: IV07AlignedV2RunnerConfig,
    binding: IV07AlignedV2CandidateBinding,
    seedPlan: IV07AlignedV2InjectedSeedPlan,
): IV07AlignedV2RemainingPanelWork {
    const shards = buildV07AlignedV2CheckpointShardSpecs({
        runFingerprint: definition.definitionSha256,
        seedPlan,
        binding,
        maxScenarioPairsPerShard: config.throughput.maxScenarioPairsPerShard,
    });
    const panelFingerprint = bindV07AlignedV2SeedPlan(seedPlan).panelFingerprint;
    const evidenceRoot = join(artifactRoot, "evidence", seedPlan.purpose, panelFingerprint, binding.genomeSha256);
    let games = 0;
    for (const shard of shards) {
        const directory = join(evidenceRoot, v07AlignedV2ShardArtifactDirectoryName(shard));
        if (!existsSync(directory)) {
            games += (shard.pairEndExclusive - shard.pairStart) * 2;
            continue;
        }
        loadV07AlignedV2PersistedShard(directory, { shard, binding, seedPlan });
    }
    return { games, startupPanels: games > 0 ? 1 : 0 };
}

function addRemainingWork(target: IV07AlignedV2RemainingPanelWork, addition: IV07AlignedV2RemainingPanelWork): void {
    target.games += addition.games;
    target.startupPanels += addition.startupPanels;
}

function fullRemainingWork(games: number, panels: number): IV07AlignedV2RemainingPanelWork {
    return { games, startupPanels: games > 0 ? panels : 0 };
}

function validateRemainingCapacity(
    artifactRoot: string,
    definition: IV07AlignedV2OrchestratorDefinition,
    preparation: IV07AlignedV2RunnerPreparation,
    ledger: IV07AlignedV2PersistedOrchestrator,
    nowMs: number,
): IV07AlignedV2RemainingCapacityReport {
    const train = fullRemainingWork(0, 0);
    const confirm = fullRemainingWork(0, 0);
    const final = fullRemainingWork(0, 0);
    if (ledger.state.phase === "training") {
        for (const candidate of definition.candidates) {
            if (ledger.state.training.some((entry) => entry.genomeSha256 === candidate.genomeSha256)) continue;
            addRemainingWork(
                train,
                remainingPanelWork(
                    artifactRoot,
                    definition,
                    preparation.config,
                    candidate,
                    preparation.commitment.trainPlan,
                ),
            );
        }
        addRemainingWork(confirm, fullRemainingWork(definition.panels.confirm.taskCount * 2, 2));
        addRemainingWork(final, fullRemainingWork(definition.panels.finalCommitment.taskCount, 1));
    } else if (ledger.state.phase === "confirmation") {
        if (!ledger.state.frozen) throw new Error("aligned v2 confirmation capacity requires a frozen candidate");
        const challenger = definition.candidates.find(
            (candidate) => candidate.genomeSha256 === ledger.state.frozen!.genomeSha256,
        );
        if (!challenger) throw new Error("aligned v2 frozen candidate is absent from the finite catalog");
        addRemainingWork(
            confirm,
            remainingPanelWork(
                artifactRoot,
                definition,
                preparation.config,
                challenger,
                preparation.commitment.confirmPlan,
            ),
        );
        addRemainingWork(
            confirm,
            remainingPanelWork(
                artifactRoot,
                definition,
                preparation.config,
                definition.incumbent,
                preparation.commitment.confirmPlan,
            ),
        );
        addRemainingWork(final, fullRemainingWork(definition.panels.finalCommitment.taskCount, 1));
    } else if (ledger.state.phase === "await_final_plan") {
        addRemainingWork(final, fullRemainingWork(definition.panels.finalCommitment.taskCount, 1));
    } else if (ledger.state.phase === "final") {
        if (!ledger.state.frozen || !ledger.state.revealedSeedArtifacts) {
            throw new Error("aligned v2 final capacity requires frozen candidate and revealed seed artifacts");
        }
        const candidate = definition.candidates.find(
            (entry) => entry.genomeSha256 === ledger.state.frozen!.genomeSha256,
        );
        if (!candidate) throw new Error("aligned v2 final candidate is absent from the finite catalog");
        const reveal = readCanonicalJson<IV07AlignedV2FinalSeedReveal>(
            join(artifactRoot, ...ledger.state.revealedSeedArtifacts.finalReveal.path.split("/")),
            "aligned v2 final seed reveal for remaining capacity",
        );
        addRemainingWork(
            final,
            remainingPanelWork(artifactRoot, definition, preparation.config, candidate, reveal.finalPlan),
        );
    }
    const throughput = preparation.config.throughput;
    const effectiveRate =
        (throughput.workersPerShard *
            throughput.concurrentShards *
            throughput.gamesPerWorkerHour *
            throughput.utilization) /
        throughput.safetyFactor;
    const overheadHours = throughput.panelStartupMinutes / 60;
    const estimatedTrainHours = train.games / effectiveRate + train.startupPanels * overheadHours;
    const estimatedConfirmHours = confirm.games / effectiveRate + confirm.startupPanels * overheadHours;
    const estimatedFinalHours = final.games / effectiveRate + final.startupPanels * overheadHours;
    const effectiveNowMs = Math.max(nowMs, definition.schedule.startAtMs);
    const trainHoursAvailable =
        ledger.state.phase === "training"
            ? Math.max(0, definition.schedule.trainDeadlineAtMs - effectiveNowMs) / HOUR_MS
            : 0;
    const confirmHoursAvailable =
        ledger.state.phase === "training"
            ? (definition.schedule.confirmDeadlineAtMs - definition.schedule.trainDeadlineAtMs) / HOUR_MS
            : ledger.state.phase === "confirmation"
              ? Math.max(0, definition.schedule.confirmDeadlineAtMs - effectiveNowMs) / HOUR_MS
              : 0;
    const finalHoursAvailable =
        ledger.state.phase === "training" || ledger.state.phase === "confirmation"
            ? (definition.schedule.finalDeadlineAtMs - definition.schedule.confirmDeadlineAtMs) / HOUR_MS
            : ledger.state.phase === "await_final_plan" || ledger.state.phase === "final"
              ? Math.max(0, definition.schedule.finalDeadlineAtMs - effectiveNowMs) / HOUR_MS
              : 0;
    if (
        estimatedTrainHours > trainHoursAvailable ||
        estimatedConfirmHours > confirmHoursAvailable ||
        estimatedFinalHours > finalHoursAvailable
    ) {
        throw new Error(
            `aligned v2 remaining capacity is impossible in ${ledger.state.phase}: ` +
                `train ${estimatedTrainHours.toFixed(3)}/${trainHoursAvailable.toFixed(3)}h, ` +
                `confirm ${estimatedConfirmHours.toFixed(3)}/${confirmHoursAvailable.toFixed(3)}h, ` +
                `final ${estimatedFinalHours.toFixed(3)}/${finalHoursAvailable.toFixed(3)}h`,
        );
    }
    const unsigned = {
        schemaVersion: 1 as const,
        artifactKind: "v0_7_aligned_96h_v2_remaining_capacity" as const,
        runFingerprint: definition.definitionSha256,
        phase: ledger.state.phase,
        measuredAtMs: nowMs,
        remainingTrainGames: train.games,
        remainingConfirmGames: confirm.games,
        remainingFinalGames: final.games,
        trainHoursAvailable,
        confirmHoursAvailable,
        finalHoursAvailable,
        estimatedTrainHours,
        estimatedConfirmHours,
        estimatedFinalHours,
        passed: true as const,
    };
    return { ...unsigned, capacitySha256: fingerprintV07AlignedV2(unsigned) };
}

function applyCommand(
    ledger: IV07AlignedV2PersistedOrchestrator,
    definition: IV07AlignedV2OrchestratorDefinition,
    resolvers: IV07AlignedV2OrchestratorReplayResolvers,
    heartbeat: V07AlignedV2RunnerHeartbeatWriter,
    command: IV07AlignedV2OrchestratorCommand,
): IV07AlignedV2PersistedOrchestrator {
    heartbeat.write({
        phase: `${ledger.state.phase}:${command.type}:before`,
        eventHeadSha256: ledger.current.eventHeadSha256,
    });
    const next = applyAndPersistV07AlignedV2OrchestratorCommand(
        ledger.directory,
        definition,
        command,
        resolvers,
    ).orchestration;
    heartbeat.write({
        phase: `${next.state.phase}:${command.type}:after`,
        eventHeadSha256: next.current.eventHeadSha256,
    });
    return next;
}

function commandNow(state: IV07AlignedV2OrchestratorState, nowMs: number): number {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("runner clock returned an invalid time");
    return Math.max(state.lastNowMs, nowMs);
}

function maybeDeadline(
    ledger: IV07AlignedV2PersistedOrchestrator,
    definition: IV07AlignedV2OrchestratorDefinition,
    resolvers: IV07AlignedV2OrchestratorReplayResolvers,
    heartbeat: V07AlignedV2RunnerHeartbeatWriter,
    nowMs: number,
): IV07AlignedV2PersistedOrchestrator {
    const { phase } = ledger.state;
    const deadline =
        phase === "training"
            ? definition.schedule.trainDeadlineAtMs
            : phase === "confirmation"
              ? definition.schedule.confirmDeadlineAtMs
              : phase === "await_final_plan" || phase === "final"
                ? definition.schedule.finalDeadlineAtMs
                : null;
    if (deadline === null || nowMs < deadline) return ledger;
    return applyCommand(ledger, definition, resolvers, heartbeat, {
        type: "tick",
        commandId: `deadline:${phase}`,
        nowMs: commandNow(ledger.state, nowMs),
    });
}

export async function runV07AlignedV2Runner(
    invocation: IV07AlignedV2RunnerInvocation,
): Promise<IV07AlignedV2RunnerOutcome> {
    if (
        !existsSync(invocation.definitionPath) ||
        lstatSync(invocation.definitionPath).isSymbolicLink() ||
        !lstatSync(invocation.definitionPath).isFile()
    ) {
        throw new Error("aligned v2 orchestrator definition must be a regular non-symlink file");
    }
    const definitionPath = realpathSync(invocation.definitionPath);
    const definition = validateV07AlignedV2OrchestratorDefinition(
        readCanonicalJson<IV07AlignedV2OrchestratorDefinition>(definitionPath, "aligned v2 orchestrator definition"),
    );
    validateSupervisorProtocol(invocation, definition);
    const preparation = prepareV07AlignedV2Runner(invocation.configPath);
    validateSupervisorProtocol(invocation, definition, preparation);
    const budget = validateComposition(invocation, preparation, definition);
    const orchestratorDirectory = resolve(invocation.orchestratorDirectory);
    const artifactRoot = dirname(orchestratorDirectory);
    ensureDurableDirectory(artifactRoot);
    const heartbeat = new V07AlignedV2RunnerHeartbeatWriter(
        join(artifactRoot, "runner.heartbeat.json"),
        definition.definitionSha256,
        artifactRoot,
        !invocation.preflight,
    );
    heartbeat.write({ phase: "initializing:commitment", eventHeadSha256: null });
    const commitmentRef = publishImmutableArtifact(
        artifactRoot,
        COMMITMENT_PATH,
        preparation.commitment,
        preparation.commitment.commitmentSha256,
    );
    if (!sameValue(commitmentRef, definition.seedCommitment)) {
        throw new Error("persisted seed commitment reference differs from the preregistered definition");
    }
    heartbeat.write({ phase: "initializing:commitment-persisted", eventHeadSha256: null });
    const resolverOptions: IV07AlignedV2FilesystemResolverOptions = { artifactRoot, definition };
    const resolvers = createV07AlignedV2FilesystemReplayResolvers(resolverOptions);
    let ledger = initializeV07AlignedV2OrchestratorPersistence(orchestratorDirectory, definition, resolvers);
    const dependencies: IV07AlignedV2RunnerDependencies = {
        nowMs: invocation.dependencies?.nowMs ?? (() => Date.now()),
        evaluateShard: invocation.dependencies?.evaluateShard ?? evaluateV07AlignedV2Shard,
    };
    const metrics: IV07AlignedV2RunnerExecutionMetrics = {
        invocationGamesExecuted: 0,
        invocationWorkersStarted: 0,
    };
    heartbeat.write({ phase: `${ledger.state.phase}:initialized`, eventHeadSha256: ledger.current.eventHeadSha256 });
    let finalRevealRef: IV07AlignedV2SeedArtifactRef | null = ledger.state.revealedSeedArtifacts?.finalReveal ?? null;
    let now = commandNow(ledger.state, dependencies.nowMs());
    ledger = maybeDeadline(ledger, definition, resolvers, heartbeat, now);
    let remainingCapacity = validateRemainingCapacity(
        artifactRoot,
        definition,
        preparation,
        ledger,
        commandNow(ledger.state, dependencies.nowMs()),
    );

    while (ledger.state.phase === "training") {
        const next = definition.candidates.find(
            (candidate) => !ledger.state.training.some((entry) => entry.genomeSha256 === candidate.genomeSha256),
        );
        if (!next) {
            now = commandNow(ledger.state, dependencies.nowMs());
            ledger = applyCommand(ledger, definition, resolvers, heartbeat, {
                type: "freeze_candidate",
                commandId: "freeze:finite-catalog",
                nowMs: now,
            });
            break;
        }
        now = commandNow(ledger.state, dependencies.nowMs());
        if (now >= definition.schedule.trainDeadlineAtMs) {
            ledger = maybeDeadline(ledger, definition, resolvers, heartbeat, now);
            break;
        }
        remainingCapacity = validateRemainingCapacity(artifactRoot, definition, preparation, ledger, now);
        const evidence = await evaluatePanel({
            artifactRoot,
            definition,
            config: preparation.config,
            binding: next,
            seedPlan: preparation.commitment.trainPlan,
            preflight: invocation.preflight,
            outcome: "candidate_win",
            evaluateShard: dependencies.evaluateShard,
            deadlineAtMs: definition.schedule.trainDeadlineAtMs,
            eventHeadSha256: ledger.current.eventHeadSha256,
            heartbeat,
            metrics,
        });
        now = commandNow(ledger.state, dependencies.nowMs());
        ledger =
            now >= definition.schedule.trainDeadlineAtMs
                ? maybeDeadline(ledger, definition, resolvers, heartbeat, now)
                : applyCommand(ledger, definition, resolvers, heartbeat, {
                      type: "record_train",
                      commandId: `train:${next.genomeSha256}`,
                      nowMs: now,
                      candidateGenomeSha256: next.genomeSha256,
                      evidence,
                  });
    }

    if (ledger.state.phase === "confirmation" && !ledger.state.finalPlanRevealed && ledger.state.frozen) {
        const reveal = revealV07AlignedV2FinalSeedPlan({
            commitment: preparation.commitment,
            corpus: preparation.corpus,
            secret: preparation.secret,
            freeze: {
                schemaVersion: 1,
                kind: "v0.7_aligned_v2_candidate_freeze_binding",
                commitmentSha256: preparation.commitment.commitmentSha256,
                frozenCandidateSha256: ledger.state.frozen.genomeSha256,
                freezeArtifactSha256: ledger.state.frozen.freezeArtifactSha256,
            },
        });
        finalRevealRef = publishImmutableArtifact(
            artifactRoot,
            FINAL_REVEAL_PATH,
            reveal,
            reveal.finalPlanRevealSha256,
        );
        now = commandNow(ledger.state, dependencies.nowMs());
        ledger =
            now >= definition.schedule.confirmDeadlineAtMs
                ? maybeDeadline(ledger, definition, resolvers, heartbeat, now)
                : applyCommand(ledger, definition, resolvers, heartbeat, {
                      type: "reveal_final_plan",
                      commandId: "reveal:final-after-freeze",
                      nowMs: now,
                      trainSeedPlan: preparation.commitment.trainPlan,
                      confirmSeedPlan: preparation.commitment.confirmPlan,
                      finalSeedPlan: reveal.finalPlan,
                      seedArtifacts: { commitment: commitmentRef, finalReveal: finalRevealRef },
                  });
    }

    if (ledger.state.phase === "confirmation" && ledger.state.frozen) {
        now = commandNow(ledger.state, dependencies.nowMs());
        if (now >= definition.schedule.confirmDeadlineAtMs) {
            ledger = maybeDeadline(ledger, definition, resolvers, heartbeat, now);
        } else {
            remainingCapacity = validateRemainingCapacity(artifactRoot, definition, preparation, ledger, now);
            const challenger = definition.candidates.find(
                (candidate) => candidate.genomeSha256 === ledger.state.frozen!.genomeSha256,
            )!;
            const challengerEvidence = await evaluatePanel({
                artifactRoot,
                definition,
                config: preparation.config,
                binding: challenger,
                seedPlan: preparation.commitment.confirmPlan,
                preflight: invocation.preflight,
                outcome: "candidate_win",
                evaluateShard: dependencies.evaluateShard,
                deadlineAtMs: definition.schedule.confirmDeadlineAtMs,
                eventHeadSha256: ledger.current.eventHeadSha256,
                heartbeat,
                metrics,
            });
            const incumbentEvidence = await evaluatePanel({
                artifactRoot,
                definition,
                config: preparation.config,
                binding: definition.incumbent,
                seedPlan: preparation.commitment.confirmPlan,
                preflight: invocation.preflight,
                outcome: "candidate_win",
                evaluateShard: dependencies.evaluateShard,
                deadlineAtMs: definition.schedule.confirmDeadlineAtMs,
                eventHeadSha256: ledger.current.eventHeadSha256,
                heartbeat,
                metrics,
            });
            now = commandNow(ledger.state, dependencies.nowMs());
            ledger =
                now >= definition.schedule.confirmDeadlineAtMs
                    ? maybeDeadline(ledger, definition, resolvers, heartbeat, now)
                    : applyCommand(ledger, definition, resolvers, heartbeat, {
                          type: "record_confirmation",
                          commandId: "confirm:frozen-vs-incumbent",
                          nowMs: now,
                          challenger: challengerEvidence,
                          incumbent: incumbentEvidence,
                      });
        }
    }

    if (ledger.state.phase === "final" && ledger.state.frozen && ledger.state.revealedSeedArtifacts) {
        const revealPath = join(artifactRoot, ...ledger.state.revealedSeedArtifacts.finalReveal.path.split("/"));
        const reveal = readCanonicalJson<IV07AlignedV2FinalSeedReveal>(revealPath, "aligned v2 final seed reveal");
        const challenger = definition.candidates.find(
            (candidate) => candidate.genomeSha256 === ledger.state.frozen!.genomeSha256,
        )!;
        now = commandNow(ledger.state, dependencies.nowMs());
        if (now >= definition.schedule.finalDeadlineAtMs) {
            ledger = maybeDeadline(ledger, definition, resolvers, heartbeat, now);
        } else {
            remainingCapacity = validateRemainingCapacity(artifactRoot, definition, preparation, ledger, now);
            const evidence = await evaluatePanel({
                artifactRoot,
                definition,
                config: preparation.config,
                binding: challenger,
                seedPlan: reveal.finalPlan,
                preflight: invocation.preflight,
                outcome: "candidate_win",
                evaluateShard: dependencies.evaluateShard,
                deadlineAtMs: definition.schedule.finalDeadlineAtMs,
                eventHeadSha256: ledger.current.eventHeadSha256,
                heartbeat,
                metrics,
            });
            now = commandNow(ledger.state, dependencies.nowMs());
            ledger =
                now >= definition.schedule.finalDeadlineAtMs
                    ? maybeDeadline(ledger, definition, resolvers, heartbeat, now)
                    : applyCommand(ledger, definition, resolvers, heartbeat, {
                          type: "record_final",
                          commandId: "final:frozen-candidate",
                          nowMs: now,
                          evidence,
                      });
        }
    }

    if (ledger.state.phase !== "terminal" || !ledger.state.terminal) {
        ledger = loadV07AlignedV2PersistedOrchestrator(orchestratorDirectory, resolvers, definition);
    }
    if (ledger.state.phase !== "terminal" || !ledger.state.terminal) {
        throw new Error(`aligned v2 runner stopped without a strict terminal in phase ${ledger.state.phase}`);
    }
    remainingCapacity = validateRemainingCapacity(
        artifactRoot,
        definition,
        preparation,
        ledger,
        commandNow(ledger.state, dependencies.nowMs()),
    );
    const persistedProgress = heartbeat.persistedProgress();
    const unsigned = {
        schemaVersion: 1 as const,
        artifactKind: "v0_7_aligned_96h_v2_runner_outcome" as const,
        status: "research_only_no_bake" as const,
        automaticBake: false as const,
        automaticDeploy: false as const,
        mode: preparation.config.mode,
        runFingerprint: definition.definitionSha256,
        configSha256: preparation.config.configSha256,
        configBytesSha256: preparation.configBytesSha256,
        rateAttestationSha256: preparation.throughputAttestation.attestationSha256,
        commitmentRef,
        finalRevealRef,
        budget,
        remainingCapacity,
        terminalSha256: ledger.state.terminal.terminalSha256,
        invocationGamesExecuted: metrics.invocationGamesExecuted,
        invocationWorkersStarted: metrics.invocationWorkersStarted,
        ...persistedProgress,
    };
    heartbeat.write({ phase: "terminal", eventHeadSha256: ledger.current.eventHeadSha256 });
    return { ...unsigned, outcomeSha256: fingerprintV07AlignedV2(unsigned) };
}

export type IV07AlignedV2RunnerCliOptions =
    | {
          command: "run";
          configPath: string;
          preflight: boolean;
      }
    | {
          command: "prepare_definition";
          configPath: string;
          requestPath: string;
          preparedDirectory: string;
      };

export function parseV07AlignedV2RunnerArgs(argv: string[], cwd = process.cwd()): IV07AlignedV2RunnerCliOptions {
    const { values, positionals } = parseArgs({
        args: argv,
        strict: true,
        allowPositionals: true,
        options: {
            config: { type: "string" },
            preflight: { type: "boolean", default: false },
            run: { type: "boolean", default: false },
            "prepare-definition": { type: "boolean", default: false },
            "definition-input": { type: "string" },
            "prepared-dir": { type: "string" },
        },
    });
    const commands = [values.preflight, values.run, values["prepare-definition"]].filter(Boolean).length;
    if (positionals.length || !values.config || commands !== 1) {
        throw new Error(
            "aligned v2 runner requires exactly one of --preflight/--run/--prepare-definition and one --config=<path>",
        );
    }
    const configPath = resolve(cwd, values.config);
    if (values["prepare-definition"]) {
        if (!values["definition-input"] || !values["prepared-dir"]) {
            throw new Error("--prepare-definition requires --definition-input=<path> and --prepared-dir=<path>");
        }
        return {
            command: "prepare_definition",
            configPath,
            requestPath: resolve(cwd, values["definition-input"]),
            preparedDirectory: resolve(cwd, values["prepared-dir"]),
        };
    }
    if (values["definition-input"] || values["prepared-dir"]) {
        throw new Error("--definition-input and --prepared-dir are only valid with --prepare-definition");
    }
    return { command: "run", configPath, preflight: values.preflight };
}

async function main(): Promise<void> {
    const options = parseV07AlignedV2RunnerArgs(process.argv.slice(2));
    if (options.command === "prepare_definition") {
        const bundle = prepareV07AlignedV2DefinitionBundle({
            configPath: options.configPath,
            requestPath: options.requestPath,
            preparedDirectory: options.preparedDirectory,
        });
        process.stdout.write(`${canonicalV07AlignedV2Json(bundle)}\n`);
        return;
    }
    const definitionPath = process.env.V07_ALIGNED_V2_DEFINITION;
    const orchestratorDirectory = process.env.V07_ALIGNED_V2_OUT;
    if (!definitionPath || !orchestratorDirectory) {
        throw new Error("aligned v2 runner requires the supervisor definition and output environment");
    }
    const outcome = await runV07AlignedV2Runner({
        configPath: options.configPath,
        definitionPath,
        orchestratorDirectory,
        preflight: options.preflight,
        environment: process.env,
    });
    process.stdout.write(`${canonicalV07AlignedV2Json(outcome)}\n`);
}

if (import.meta.main) {
    main().catch((error) => {
        process.stderr.write(`v0_7_aligned_96h_v2_runner: ${String(error)}\n`);
        process.exitCode = 64;
    });
}
