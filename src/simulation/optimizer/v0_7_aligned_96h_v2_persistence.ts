/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import { createHash } from "node:crypto";
import {
    closeSync,
    existsSync,
    fsyncSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readFileSync,
    readdirSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import type { IV07ComposedAuditRow } from "../v0_7_composed_ranked_ladder";
import { compactV07AlignedV2Observation, type IV07AlignedV2BattleRecord } from "./v0_7_aligned_96h_v2_game_adapter";
import {
    canonicalV07AlignedV2Json,
    buildV07AlignedV2CandidateEnvironment,
    buildV07AlignedV2CheckpointShardSpecs,
    fingerprintV07AlignedV2,
    flattenV07AlignedV2SeedPlan,
    validateV07AlignedV2CandidateBinding,
    validateV07AlignedV2Checkpoint,
    validateV07AlignedV2CheckpointShardSpec,
    v07AlignedV2TaskIdentity,
    v07AlignedV2TaskKey,
    type IV07AlignedV2CandidateBinding,
    type IV07AlignedV2Checkpoint,
    type IV07AlignedV2CheckpointShardSpec,
    type IV07AlignedV2ExecutionTask,
    type IV07AlignedV2InjectedSeedPlan,
} from "./v0_7_aligned_96h_v2_protocol";
import { quarantineV07AlignedV2Path, type V07AlignedV2QuarantineReason } from "./v0_7_aligned_96h_v2_quarantine";
import type {
    IV07AlignedV2ShardEvaluation,
    IV07AlignedV2WorkerAttestation,
    IV07AlignedV2WorkerAuditArtifact,
} from "./v0_7_aligned_96h_v2_evaluator";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_ARTIFACT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export interface IV07AlignedV2ArtifactDescriptor {
    path: string;
    sha256: string;
    bytes: number;
    rows: number;
}

export interface IV07AlignedV2PersistedAuditDescriptor extends IV07AlignedV2ArtifactDescriptor {
    workerIndex: number;
}

export interface IV07AlignedV2ShardArtifactManifest {
    schemaVersion: 1;
    artifactKind: "v0_7_aligned_96h_v2_shard_artifacts";
    status: "research_only_no_bake";
    automaticBake: false;
    automaticDeploy: false;
    runFingerprint: string;
    shardSha256: string;
    panelFingerprint: string;
    genomeSha256: string;
    behaviorEnvironmentSha256: string;
    files: {
        binding: IV07AlignedV2ArtifactDescriptor;
        rawRecords: IV07AlignedV2ArtifactDescriptor;
        attestations: IV07AlignedV2ArtifactDescriptor;
        auditIndex: IV07AlignedV2ArtifactDescriptor;
        checkpoint: IV07AlignedV2ArtifactDescriptor;
    };
    audits: IV07AlignedV2PersistedAuditDescriptor[];
    artifactSetSha256: string;
    manifestSha256: string;
}

export interface IV07AlignedV2PersistedAuditIndexEntry {
    workerIndex: number;
    sourcePath: string;
    persistedPath: string;
    taskKeys: string[];
}

export interface IV07AlignedV2PersistedAuditIndex {
    schemaVersion: 1;
    artifactKind: "v0_7_aligned_96h_v2_audit_index";
    workers: IV07AlignedV2PersistedAuditIndexEntry[];
}

export interface IV07AlignedV2PersistenceFaultInjector {
    afterDurableStep(step: string): void;
}

export interface IV07AlignedV2PersistedShard {
    directory: string;
    manifest: IV07AlignedV2ShardArtifactManifest;
    manifestSha256: string;
    evaluation: IV07AlignedV2ShardEvaluation;
    reused: boolean;
}

export interface IV07AlignedV2ShardLoadExpectations {
    shard: IV07AlignedV2CheckpointShardSpec;
    binding: IV07AlignedV2CandidateBinding;
    seedPlan: IV07AlignedV2InjectedSeedPlan;
    manifestSha256?: string;
}

export interface IV07AlignedV2PanelShardLoadExpectations {
    runFingerprint: string;
    binding: IV07AlignedV2CandidateBinding;
    seedPlan: IV07AlignedV2InjectedSeedPlan;
    manifestSha256: string;
}

interface IArtifactBundle {
    manifest: IV07AlignedV2ShardArtifactManifest;
    contents: Map<string, string>;
}

function sha256Bytes(value: string | Buffer): string {
    return createHash("sha256").update(value).digest("hex");
}

function requireSha256(value: unknown, label: string): asserts value is string {
    if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
        throw new Error(`${label} must be a lowercase SHA-256`);
    }
}

function requireCount(value: unknown, label: string): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new Error(`${label} must be a nonnegative integer`);
    }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    return canonicalV07AlignedV2Json(Object.keys(value).sort()) === canonicalV07AlignedV2Json([...expected].sort());
}

function requireSafeArtifactPath(value: unknown, label: string): asserts value is string {
    if (
        typeof value !== "string" ||
        !SAFE_ARTIFACT_NAME_PATTERN.test(value) ||
        basename(value) !== value ||
        value === "." ||
        value === ".."
    ) {
        throw new Error(`${label} is not a safe artifact filename`);
    }
}

function canonicalJsonFile(value: unknown): string {
    return `${canonicalV07AlignedV2Json(value)}\n`;
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

function readUtf8Exact(path: string, label: string): string {
    return decodeUtf8Exact(readFileSync(path), label);
}

function canonicalJsonLines(rows: readonly unknown[]): string {
    return rows.length ? `${rows.map((row) => canonicalV07AlignedV2Json(row)).join("\n")}\n` : "";
}

function strictJsonLines<T>(contents: string, label: string): T[] {
    if (contents && !contents.endsWith("\n")) throw new Error(`${label} lacks a terminal newline`);
    return contents
        .split("\n")
        .filter(Boolean)
        .map((line, index) => {
            try {
                return JSON.parse(line) as T;
            } catch (error) {
                throw new Error(`${label}:${index + 1} is malformed JSON (${String(error)})`);
            }
        });
}

function descriptor(path: string, contents: string, rows: number): IV07AlignedV2ArtifactDescriptor {
    requireSafeArtifactPath(path, "artifact path");
    requireCount(rows, `${path}.rows`);
    return {
        path,
        sha256: sha256Bytes(contents),
        bytes: Buffer.byteLength(contents),
        rows,
    };
}

function validateDescriptor(value: unknown, label: string): IV07AlignedV2ArtifactDescriptor {
    if (!isObjectRecord(value) || !hasExactKeys(value, ["path", "sha256", "bytes", "rows"])) {
        throw new Error(`${label} fields are not exact`);
    }
    requireSafeArtifactPath(value.path, `${label}.path`);
    requireSha256(value.sha256, `${label}.sha256`);
    requireCount(value.bytes, `${label}.bytes`);
    requireCount(value.rows, `${label}.rows`);
    return value as unknown as IV07AlignedV2ArtifactDescriptor;
}

function validateAuditDescriptor(value: unknown, label: string): IV07AlignedV2PersistedAuditDescriptor {
    if (!isObjectRecord(value) || !hasExactKeys(value, ["workerIndex", "path", "sha256", "bytes", "rows"])) {
        throw new Error(`${label} fields are not exact`);
    }
    requireCount(value.workerIndex, `${label}.workerIndex`);
    validateDescriptor({ path: value.path, sha256: value.sha256, bytes: value.bytes, rows: value.rows }, label);
    return value as unknown as IV07AlignedV2PersistedAuditDescriptor;
}

function validateManifest(value: unknown): IV07AlignedV2ShardArtifactManifest {
    if (
        !isObjectRecord(value) ||
        !hasExactKeys(value, [
            "schemaVersion",
            "artifactKind",
            "status",
            "automaticBake",
            "automaticDeploy",
            "runFingerprint",
            "shardSha256",
            "panelFingerprint",
            "genomeSha256",
            "behaviorEnvironmentSha256",
            "files",
            "audits",
            "artifactSetSha256",
            "manifestSha256",
        ])
    ) {
        throw new Error("aligned v2 shard manifest fields are not exact");
    }
    if (
        value.schemaVersion !== 1 ||
        value.artifactKind !== "v0_7_aligned_96h_v2_shard_artifacts" ||
        value.status !== "research_only_no_bake" ||
        value.automaticBake !== false ||
        value.automaticDeploy !== false
    ) {
        throw new Error("aligned v2 shard manifest header is invalid");
    }
    for (const [label, hash] of Object.entries({
        runFingerprint: value.runFingerprint,
        shardSha256: value.shardSha256,
        panelFingerprint: value.panelFingerprint,
        genomeSha256: value.genomeSha256,
        behaviorEnvironmentSha256: value.behaviorEnvironmentSha256,
        artifactSetSha256: value.artifactSetSha256,
        manifestSha256: value.manifestSha256,
    })) {
        requireSha256(hash, label);
    }
    if (
        !isObjectRecord(value.files) ||
        !hasExactKeys(value.files, ["binding", "rawRecords", "attestations", "auditIndex", "checkpoint"])
    ) {
        throw new Error("aligned v2 shard manifest file ledger fields are not exact");
    }
    const files = {
        binding: validateDescriptor(value.files.binding, "files.binding"),
        rawRecords: validateDescriptor(value.files.rawRecords, "files.rawRecords"),
        attestations: validateDescriptor(value.files.attestations, "files.attestations"),
        auditIndex: validateDescriptor(value.files.auditIndex, "files.auditIndex"),
        checkpoint: validateDescriptor(value.files.checkpoint, "files.checkpoint"),
    };
    if (!Array.isArray(value.audits)) throw new Error("aligned v2 shard manifest audits must be an array");
    const audits = value.audits.map((entry, index) => validateAuditDescriptor(entry, `audits[${index}]`));
    const workerIndices = audits.map((entry) => entry.workerIndex);
    const artifactPaths = [...Object.values(files), ...audits].map((entry) => entry.path);
    if (
        new Set(workerIndices).size !== workerIndices.length ||
        workerIndices.some((entry, index) => entry !== index) ||
        new Set(artifactPaths).size !== artifactPaths.length
    ) {
        throw new Error("aligned v2 shard manifest contains duplicate or noncanonical audit/file entries");
    }
    if (value.artifactSetSha256 !== sha256Bytes(canonicalV07AlignedV2Json({ files, audits }))) {
        throw new Error("aligned v2 shard manifest artifact-set hash mismatch");
    }
    const unsigned = { ...value };
    delete unsigned.manifestSha256;
    if (value.manifestSha256 !== sha256Bytes(canonicalV07AlignedV2Json(unsigned))) {
        throw new Error("aligned v2 shard manifest self-hash mismatch");
    }
    return { ...(value as unknown as IV07AlignedV2ShardArtifactManifest), files, audits };
}

function validateAuditIndex(value: unknown): IV07AlignedV2PersistedAuditIndex {
    if (
        !isObjectRecord(value) ||
        !hasExactKeys(value, ["schemaVersion", "artifactKind", "workers"]) ||
        value.schemaVersion !== 1 ||
        value.artifactKind !== "v0_7_aligned_96h_v2_audit_index" ||
        !Array.isArray(value.workers)
    ) {
        throw new Error("aligned v2 audit index header is invalid");
    }
    const workers = value.workers.map((entry, index): IV07AlignedV2PersistedAuditIndexEntry => {
        if (
            !isObjectRecord(entry) ||
            !hasExactKeys(entry, ["workerIndex", "sourcePath", "persistedPath", "taskKeys"])
        ) {
            throw new Error(`aligned v2 audit index worker ${index} fields are not exact`);
        }
        requireCount(entry.workerIndex, `auditIndex.workers[${index}].workerIndex`);
        if (entry.workerIndex !== index || typeof entry.sourcePath !== "string" || !entry.sourcePath.trim()) {
            throw new Error(`aligned v2 audit index worker ${index} is noncanonical`);
        }
        requireSafeArtifactPath(entry.persistedPath, `auditIndex.workers[${index}].persistedPath`);
        if (
            !Array.isArray(entry.taskKeys) ||
            entry.taskKeys.some((taskKey) => typeof taskKey !== "string" || !taskKey.trim()) ||
            new Set(entry.taskKeys).size !== entry.taskKeys.length
        ) {
            throw new Error(`aligned v2 audit index worker ${index} task keys are malformed`);
        }
        return entry as unknown as IV07AlignedV2PersistedAuditIndexEntry;
    });
    return { schemaVersion: 1, artifactKind: "v0_7_aligned_96h_v2_audit_index", workers };
}

function expectedExecutionTasks(
    shard: IV07AlignedV2CheckpointShardSpec,
    binding: IV07AlignedV2CandidateBinding,
    seedPlan: IV07AlignedV2InjectedSeedPlan,
): IV07AlignedV2ExecutionTask[] {
    validateV07AlignedV2CheckpointShardSpec(shard);
    validateV07AlignedV2CandidateBinding(binding);
    const expectedShards = buildV07AlignedV2CheckpointShardSpecs({
        runFingerprint: shard.runFingerprint,
        seedPlan,
        binding,
        maxScenarioPairsPerShard: shard.maxScenarioPairsPerShard,
    });
    const expectedShard = expectedShards[shard.shardIndex];
    if (!expectedShard || canonicalV07AlignedV2Json(expectedShard) !== canonicalV07AlignedV2Json(shard)) {
        throw new Error("aligned v2 persisted shard is not the exact partition of its injected seed plan");
    }
    return flattenV07AlignedV2SeedPlan(seedPlan).slice(shard.pairStart * 2, shard.pairEndExclusive * 2);
}

function validateRecordAgainstTask(
    record: IV07AlignedV2BattleRecord,
    task: IV07AlignedV2ExecutionTask,
    index: number,
): void {
    const expectedTaskKey = v07AlignedV2TaskKey(task);
    if (
        record.schemaVersion !== 1 ||
        record.taskKey !== expectedTaskKey ||
        record.panelId !== task.panelId ||
        record.cellId !== task.cellId ||
        record.scenarioOrdinal !== task.scenarioOrdinal ||
        record.scenarioId !== task.scenarioId ||
        record.candidateSeat !== task.candidateSeat ||
        record.combatSeed !== task.combatSeed ||
        !Number.isSafeInteger(record.setupAttempt) ||
        record.setupAttempt < 0 ||
        record.setupAttempt >= task.setupSeeds.length ||
        record.setupSeed !== task.setupSeeds[record.setupAttempt] ||
        !SHA256_PATTERN.test(record.physicalSetupSha256) ||
        !SHA256_PATTERN.test(record.resultFingerprint)
    ) {
        throw new Error(`aligned v2 raw record ${index} does not match its exact execution task`);
    }
}

/** Strictly replay a completed shard from raw records and worker audit rows. */
export function validateV07AlignedV2ShardEvidence(
    evaluation: IV07AlignedV2ShardEvaluation,
    seedPlan: IV07AlignedV2InjectedSeedPlan,
): void {
    const tasks = expectedExecutionTasks(evaluation.shard, evaluation.binding, seedPlan);
    validateV07AlignedV2Checkpoint(evaluation.checkpoint, evaluation.shard);
    if (
        evaluation.checkpoint.shard.shardSha256 !== evaluation.shard.shardSha256 ||
        evaluation.shard.genomeSha256 !== evaluation.binding.genomeSha256 ||
        evaluation.shard.behaviorEnvironmentSha256 !== evaluation.binding.behaviorEnvironmentSha256 ||
        evaluation.shard.searchEnabled !== evaluation.binding.searchEnabled ||
        evaluation.records.length !== tasks.length ||
        evaluation.checkpoint.observations.length !== tasks.length
    ) {
        throw new Error("aligned v2 shard evaluation header/count binding is inconsistent");
    }
    const attestations = [...evaluation.attestations].sort((left, right) => left.workerIndex - right.workerIndex);
    const auditArtifacts = [...evaluation.auditArtifacts].sort((left, right) => left.workerIndex - right.workerIndex);
    if (!attestations.length || attestations.length !== auditArtifacts.length) {
        throw new Error("aligned v2 shard evidence must contain matching worker attestations and audits");
    }
    const auditByTask = new Map<string, IV07ComposedAuditRow | undefined>();
    for (const [workerIndex, attestation] of attestations.entries()) {
        const artifact = auditArtifacts[workerIndex];
        const expectedEnvironment = buildV07AlignedV2CandidateEnvironment(
            evaluation.binding.genome,
            artifact.sourcePath,
        );
        const expectedRemovedEnvironmentKeys = Object.keys(expectedEnvironment).sort();
        if (
            attestation.workerIndex !== workerIndex ||
            artifact.workerIndex !== workerIndex ||
            attestation.runFingerprint !== evaluation.shard.runFingerprint ||
            attestation.genomeSha256 !== evaluation.shard.genomeSha256 ||
            attestation.behaviorEnvironmentSha256 !== evaluation.shard.behaviorEnvironmentSha256 ||
            attestation.transpilerCacheDisabled !== "0" ||
            attestation.auditPath !== artifact.sourcePath ||
            attestation.environmentSha256 !== fingerprintV07AlignedV2(expectedEnvironment) ||
            !Array.isArray(attestation.removedEnvironmentKeys) ||
            canonicalV07AlignedV2Json(attestation.removedEnvironmentKeys) !==
                canonicalV07AlignedV2Json(expectedRemovedEnvironmentKeys) ||
            artifact.contentsSha256 !== sha256Bytes(artifact.contents) ||
            artifact.bytes !== Buffer.byteLength(artifact.contents)
        ) {
            throw new Error(`aligned v2 worker ${workerIndex} attestation/audit binding is inconsistent`);
        }
        const rows = strictJsonLines<IV07ComposedAuditRow>(artifact.contents, `worker ${workerIndex} audit`);
        const expectedRows = evaluation.binding.searchEnabled ? artifact.taskKeys.length : 0;
        if (
            !artifact.taskKeys.length ||
            new Set(artifact.taskKeys).size !== artifact.taskKeys.length ||
            artifact.rows !== rows.length ||
            rows.length !== expectedRows
        ) {
            throw new Error(`aligned v2 worker ${workerIndex} audit row/task counts are inconsistent`);
        }
        artifact.taskKeys.forEach((taskKey, taskIndex) => {
            if (auditByTask.has(taskKey)) throw new Error(`aligned v2 audit task ${taskKey} is assigned twice`);
            auditByTask.set(taskKey, rows[taskIndex]);
        });
    }
    const expectedTaskKeys = tasks.map(v07AlignedV2TaskKey);
    if (auditByTask.size !== expectedTaskKeys.length || expectedTaskKeys.some((taskKey) => !auditByTask.has(taskKey))) {
        throw new Error("aligned v2 worker audit index does not cover the exact shard task set");
    }
    tasks.forEach((task, index) => {
        const record = evaluation.records[index];
        validateRecordAgainstTask(record, task, index);
        const observation = compactV07AlignedV2Observation(record, evaluation.binding, auditByTask.get(record.taskKey));
        if (
            canonicalV07AlignedV2Json(observation) !==
                canonicalV07AlignedV2Json(evaluation.checkpoint.observations[index]) ||
            canonicalV07AlignedV2Json(v07AlignedV2TaskIdentity(task)) !==
                canonicalV07AlignedV2Json(evaluation.shard.tasks[index])
        ) {
            throw new Error(`aligned v2 persisted observation ${index} does not replay exactly`);
        }
    });
}

function buildArtifactBundle(
    evaluation: IV07AlignedV2ShardEvaluation,
    seedPlan: IV07AlignedV2InjectedSeedPlan,
): IArtifactBundle {
    validateV07AlignedV2ShardEvidence(evaluation, seedPlan);
    const bindingContents = canonicalJsonFile(evaluation.binding);
    const rawContents = canonicalJsonLines(evaluation.records);
    const attestationContents = canonicalJsonFile(evaluation.attestations);
    const auditArtifacts = [...evaluation.auditArtifacts].sort((left, right) => left.workerIndex - right.workerIndex);
    const audits = auditArtifacts.map((artifact) => ({
        workerIndex: artifact.workerIndex,
        ...descriptor(
            `audit-worker-${String(artifact.workerIndex).padStart(3, "0")}.jsonl`,
            artifact.contents,
            artifact.rows,
        ),
    }));
    const auditIndex: IV07AlignedV2PersistedAuditIndex = {
        schemaVersion: 1,
        artifactKind: "v0_7_aligned_96h_v2_audit_index",
        workers: auditArtifacts.map((artifact, index) => ({
            workerIndex: artifact.workerIndex,
            sourcePath: artifact.sourcePath,
            persistedPath: audits[index].path,
            taskKeys: [...artifact.taskKeys],
        })),
    };
    const auditIndexContents = canonicalJsonFile(auditIndex);
    const checkpointContents = canonicalJsonFile(evaluation.checkpoint);
    const files = {
        binding: descriptor("binding.json", bindingContents, 1),
        rawRecords: descriptor("raw-records.jsonl", rawContents, evaluation.records.length),
        attestations: descriptor("attestations.json", attestationContents, evaluation.attestations.length),
        auditIndex: descriptor("audit-index.json", auditIndexContents, auditArtifacts.length),
        checkpoint: descriptor("checkpoint.json", checkpointContents, 1),
    };
    const unsigned = {
        schemaVersion: 1 as const,
        artifactKind: "v0_7_aligned_96h_v2_shard_artifacts" as const,
        status: "research_only_no_bake" as const,
        automaticBake: false as const,
        automaticDeploy: false as const,
        runFingerprint: evaluation.shard.runFingerprint,
        shardSha256: evaluation.shard.shardSha256,
        panelFingerprint: evaluation.shard.panel.panelFingerprint,
        genomeSha256: evaluation.shard.genomeSha256,
        behaviorEnvironmentSha256: evaluation.shard.behaviorEnvironmentSha256,
        files,
        audits,
        artifactSetSha256: sha256Bytes(canonicalV07AlignedV2Json({ files, audits })),
    };
    const manifest: IV07AlignedV2ShardArtifactManifest = {
        ...unsigned,
        manifestSha256: sha256Bytes(canonicalV07AlignedV2Json(unsigned)),
    };
    const contents = new Map<string, string>([
        [files.binding.path, bindingContents],
        [files.rawRecords.path, rawContents],
        [files.attestations.path, attestationContents],
        [files.auditIndex.path, auditIndexContents],
        [files.checkpoint.path, checkpointContents],
        ...audits.map((entry, index): [string, string] => [entry.path, auditArtifacts[index].contents]),
        ["manifest.json", canonicalJsonFile(manifest)],
    ]);
    return { manifest: validateManifest(manifest), contents };
}

function verifyFile(directory: string, entry: IV07AlignedV2ArtifactDescriptor): string {
    const path = join(directory, entry.path);
    if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
        throw new Error(`missing or unsafe aligned v2 artifact ${entry.path}`);
    }
    const bytes = readFileSync(path);
    const contents = decodeUtf8Exact(bytes, `aligned v2 artifact ${entry.path}`);
    if (bytes.byteLength !== entry.bytes || sha256Bytes(bytes) !== entry.sha256) {
        throw new Error(`aligned v2 artifact ${entry.path} byte/hash mismatch`);
    }
    return contents;
}

function parseCanonicalJsonFile<T>(contents: string, label: string): T {
    if (!contents.endsWith("\n")) throw new Error(`${label} lacks a terminal newline`);
    let parsed: T;
    try {
        parsed = JSON.parse(contents) as T;
    } catch (error) {
        throw new Error(`${label} is malformed JSON (${String(error)})`);
    }
    if (contents !== canonicalJsonFile(parsed)) throw new Error(`${label} is not canonical JSON`);
    return parsed;
}

function expectedInventory(manifest: IV07AlignedV2ShardArtifactManifest): string[] {
    return [
        "manifest.json",
        ...Object.values(manifest.files).map((entry) => entry.path),
        ...manifest.audits.map((entry) => entry.path),
    ].sort();
}

export function loadV07AlignedV2PersistedShard(
    directory: string,
    expectations: IV07AlignedV2ShardLoadExpectations,
): IV07AlignedV2PersistedShard {
    if (!existsSync(directory) || !lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) {
        throw new Error(`aligned v2 persisted shard directory is missing: ${directory}`);
    }
    const manifestPath = join(directory, "manifest.json");
    if (!existsSync(manifestPath)) throw new Error("aligned v2 persisted shard has no commit manifest");
    const manifest = validateManifest(
        parseCanonicalJsonFile<IV07AlignedV2ShardArtifactManifest>(
            readUtf8Exact(manifestPath, "aligned v2 manifest"),
            "aligned v2 manifest",
        ),
    );
    if (expectations.manifestSha256 !== undefined) {
        requireSha256(expectations.manifestSha256, "expected shard manifestSha256");
        if (manifest.manifestSha256 !== expectations.manifestSha256) {
            throw new Error("aligned v2 persisted shard manifest changed from its exact evidence reference");
        }
    }
    if (
        canonicalV07AlignedV2Json(readdirSync(directory).sort()) !==
        canonicalV07AlignedV2Json(expectedInventory(manifest))
    ) {
        throw new Error("aligned v2 persisted shard directory inventory is not exact");
    }
    const bindingContents = verifyFile(directory, manifest.files.binding);
    const rawContents = verifyFile(directory, manifest.files.rawRecords);
    const attestationContents = verifyFile(directory, manifest.files.attestations);
    const auditIndexContents = verifyFile(directory, manifest.files.auditIndex);
    const checkpointContents = verifyFile(directory, manifest.files.checkpoint);
    const binding = parseCanonicalJsonFile<IV07AlignedV2CandidateBinding>(bindingContents, "aligned v2 binding");
    const records = strictJsonLines<IV07AlignedV2BattleRecord>(rawContents, "aligned v2 raw records");
    if (rawContents !== canonicalJsonLines(records)) throw new Error("aligned v2 raw records are not canonical JSONL");
    const attestations = parseCanonicalJsonFile<IV07AlignedV2WorkerAttestation[]>(
        attestationContents,
        "aligned v2 attestations",
    );
    const auditIndex = validateAuditIndex(
        parseCanonicalJsonFile<IV07AlignedV2PersistedAuditIndex>(auditIndexContents, "aligned v2 audit index"),
    );
    const checkpoint = parseCanonicalJsonFile<IV07AlignedV2Checkpoint>(checkpointContents, "aligned v2 checkpoint");
    if (
        manifest.files.binding.rows !== 1 ||
        manifest.files.rawRecords.rows !== records.length ||
        manifest.files.attestations.rows !== attestations.length ||
        manifest.files.auditIndex.rows !== auditIndex.workers.length ||
        manifest.files.checkpoint.rows !== 1 ||
        auditIndex.workers.length !== manifest.audits.length
    ) {
        throw new Error("aligned v2 persisted shard file row ledger is inconsistent");
    }
    const auditArtifacts: IV07AlignedV2WorkerAuditArtifact[] = auditIndex.workers.map((worker, index) => {
        const auditDescriptor = manifest.audits[index];
        if (
            worker.workerIndex !== index ||
            auditDescriptor.workerIndex !== index ||
            worker.persistedPath !== auditDescriptor.path
        ) {
            throw new Error(`aligned v2 persisted audit ${index} index/manifest binding mismatch`);
        }
        const contents = verifyFile(directory, auditDescriptor);
        const rows = strictJsonLines<IV07ComposedAuditRow>(contents, `aligned v2 persisted audit ${index}`);
        if (rows.length !== auditDescriptor.rows) throw new Error(`aligned v2 persisted audit ${index} row mismatch`);
        return {
            workerIndex: index,
            sourcePath: worker.sourcePath,
            taskKeys: [...worker.taskKeys],
            contents,
            contentsSha256: auditDescriptor.sha256,
            bytes: auditDescriptor.bytes,
            rows: auditDescriptor.rows,
        };
    });
    validateV07AlignedV2CandidateBinding(binding);
    if (
        canonicalV07AlignedV2Json(binding) !== canonicalV07AlignedV2Json(expectations.binding) ||
        canonicalV07AlignedV2Json(checkpoint.shard) !== canonicalV07AlignedV2Json(expectations.shard) ||
        manifest.runFingerprint !== expectations.shard.runFingerprint ||
        manifest.shardSha256 !== expectations.shard.shardSha256 ||
        manifest.panelFingerprint !== expectations.shard.panel.panelFingerprint ||
        manifest.genomeSha256 !== expectations.shard.genomeSha256 ||
        manifest.behaviorEnvironmentSha256 !== expectations.shard.behaviorEnvironmentSha256
    ) {
        throw new Error("aligned v2 persisted shard does not match its expected run/panel/genome binding");
    }
    const evaluation: IV07AlignedV2ShardEvaluation = {
        shard: expectations.shard,
        binding,
        checkpoint,
        records,
        attestations,
        auditArtifacts,
    };
    validateV07AlignedV2ShardEvidence(evaluation, expectations.seedPlan);
    return {
        directory,
        manifest,
        manifestSha256: manifest.manifestSha256,
        evaluation,
        reused: true,
    };
}

/** Discover the committed shard spec, then verify it against the exact run, binding, and injected panel. */
export function loadV07AlignedV2PersistedPanelShard(
    directory: string,
    expectations: IV07AlignedV2PanelShardLoadExpectations,
): IV07AlignedV2PersistedShard {
    requireSha256(expectations.runFingerprint, "panel shard runFingerprint");
    requireSha256(expectations.manifestSha256, "panel shard manifestSha256");
    validateV07AlignedV2CandidateBinding(expectations.binding);
    const manifestPath = join(directory, "manifest.json");
    if (!existsSync(manifestPath) || !lstatSync(manifestPath).isFile() || lstatSync(manifestPath).isSymbolicLink()) {
        throw new Error("aligned v2 persisted panel shard has no safe commit manifest");
    }
    const manifest = validateManifest(
        parseCanonicalJsonFile<IV07AlignedV2ShardArtifactManifest>(
            readUtf8Exact(manifestPath, "aligned v2 manifest"),
            "aligned v2 manifest",
        ),
    );
    if (
        manifest.manifestSha256 !== expectations.manifestSha256 ||
        manifest.runFingerprint !== expectations.runFingerprint ||
        manifest.genomeSha256 !== expectations.binding.genomeSha256 ||
        manifest.behaviorEnvironmentSha256 !== expectations.binding.behaviorEnvironmentSha256
    ) {
        throw new Error("aligned v2 persisted panel shard manifest does not match its evidence reference");
    }
    const checkpoint = parseCanonicalJsonFile<IV07AlignedV2Checkpoint>(
        verifyFile(directory, manifest.files.checkpoint),
        "aligned v2 checkpoint",
    );
    return loadV07AlignedV2PersistedShard(directory, {
        shard: checkpoint.shard,
        binding: expectations.binding,
        seedPlan: expectations.seedPlan,
        manifestSha256: expectations.manifestSha256,
    });
}

function fsyncDirectory(path: string): void {
    const fd = openSync(path, "r");
    try {
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
}

function ensureDurableDirectory(path: string): void {
    if (existsSync(path)) {
        if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) {
            throw new Error(`durable directory ${path} is not a regular non-symlink directory`);
        }
        return;
    }
    const parent = dirname(path);
    if (parent === path) throw new Error(`cannot create durable filesystem root ${path}`);
    ensureDurableDirectory(parent);
    mkdirSync(path, { mode: 0o700 });
    fsyncDirectory(path);
    fsyncDirectory(parent);
}

function writeDurableFile(path: string, contents: string): void {
    const fd = openSync(path, "wx", 0o600);
    try {
        writeFileSync(fd, contents, "utf8");
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
}

function quarantinePath(path: string, reason: V07AlignedV2QuarantineReason): string {
    return quarantineV07AlignedV2Path(path, dirname(path), reason);
}

export function v07AlignedV2ShardArtifactDirectoryName(shard: IV07AlignedV2CheckpointShardSpec): string {
    validateV07AlignedV2CheckpointShardSpec(shard);
    return `shard-${String(shard.shardIndex).padStart(5, "0")}-${shard.shardSha256.slice(0, 16)}`;
}

export function persistV07AlignedV2ShardEvaluation(
    rootDirectory: string,
    evaluation: IV07AlignedV2ShardEvaluation,
    seedPlan: IV07AlignedV2InjectedSeedPlan,
    faultInjector?: IV07AlignedV2PersistenceFaultInjector,
): IV07AlignedV2PersistedShard {
    const bundle = buildArtifactBundle(evaluation, seedPlan);
    ensureDurableDirectory(rootDirectory);
    fsyncDirectory(rootDirectory);
    const directoryName = v07AlignedV2ShardArtifactDirectoryName(evaluation.shard);
    const finalDirectory = join(rootDirectory, directoryName);
    const tempPrefix = `.${directoryName}.tmp-`;
    for (const entry of readdirSync(rootDirectory).filter((name) => name.startsWith(tempPrefix))) {
        quarantinePath(join(rootDirectory, entry), "abandoned");
        fsyncDirectory(rootDirectory);
    }
    const expectations = { shard: evaluation.shard, binding: evaluation.binding, seedPlan };
    if (existsSync(finalDirectory)) {
        try {
            const existing = loadV07AlignedV2PersistedShard(finalDirectory, expectations);
            if (existing.manifestSha256 !== bundle.manifest.manifestSha256) {
                throw new Error("aligned v2 immutable shard directory contains different valid evidence");
            }
            return { ...existing, reused: true };
        } catch (error) {
            if (error instanceof Error && error.message.includes("different valid evidence")) throw error;
            quarantinePath(finalDirectory, "corrupt");
            fsyncDirectory(rootDirectory);
        }
    }
    const tempDirectory = mkdtempSync(join(rootDirectory, tempPrefix));
    const orderedPaths = [
        bundle.manifest.files.binding.path,
        bundle.manifest.files.rawRecords.path,
        bundle.manifest.files.attestations.path,
        ...bundle.manifest.audits.map((entry) => entry.path),
        bundle.manifest.files.auditIndex.path,
        bundle.manifest.files.checkpoint.path,
        "manifest.json",
    ];
    for (const path of orderedPaths) {
        writeDurableFile(join(tempDirectory, path), bundle.contents.get(path)!);
        faultInjector?.afterDurableStep(`file:${path}`);
    }
    fsyncDirectory(tempDirectory);
    faultInjector?.afterDurableStep("temp_directory_fsynced");
    renameSync(tempDirectory, finalDirectory);
    faultInjector?.afterDurableStep("directory_published");
    fsyncDirectory(rootDirectory);
    faultInjector?.afterDurableStep("parent_directory_fsynced");
    const loaded = loadV07AlignedV2PersistedShard(finalDirectory, expectations);
    if (loaded.manifestSha256 !== bundle.manifest.manifestSha256) {
        throw new Error("aligned v2 persisted shard changed during atomic publication");
    }
    return { ...loaded, reused: false };
}
