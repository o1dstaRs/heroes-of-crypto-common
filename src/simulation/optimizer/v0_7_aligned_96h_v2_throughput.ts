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
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { arch, availableParallelism, hostname, platform, release } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
    buildV07AlignedV2ProductionCandidateCatalog,
    V07_ALIGNED_V2_PRODUCTION_CATALOG_SHA256,
} from "./v0_7_aligned_96h_v2_catalog";
import { evaluateV07AlignedV2Shard } from "./v0_7_aligned_96h_v2_evaluator";
import {
    loadV07AlignedV2PersistedShard,
    persistV07AlignedV2ShardEvaluation,
    v07AlignedV2ShardArtifactDirectoryName,
    type IV07AlignedV2PersistedShard,
    type IV07AlignedV2ShardLoadExpectations,
} from "./v0_7_aligned_96h_v2_persistence";
import {
    bindV07AlignedV2Candidate,
    buildV07AlignedV2CheckpointShardSpecs,
    canonicalV07AlignedV2Json,
    fingerprintV07AlignedV2,
    fingerprintV07AlignedV2CandidateGenome,
    flattenV07AlignedV2SeedPlan,
    validateV07AlignedV2SeedPlan,
    V07_ALIGNED_V2_EVALUATOR_CELLS,
    type IV07AlignedV2CandidateBinding,
    type IV07AlignedV2CandidateGenome,
    type IV07AlignedV2CheckpointShardSpec,
    type IV07AlignedV2InjectedSeedPlan,
    type IV07AlignedV2ScenarioPair,
} from "./v0_7_aligned_96h_v2_protocol";
import { expandV07AlignedV2CommittedManifest } from "./v0_7_aligned_96h_v2_seed_allocator";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const HOUR_MS = 3_600_000;

export const V07_ALIGNED_V2_THROUGHPUT_SOURCE_MANIFEST =
    "src/simulation/manifests/v0_7_composed_ranked_ladder_20260716.json" as const;
export const V07_ALIGNED_V2_THROUGHPUT_SOURCE_MANIFEST_BYTES_SHA256 =
    "76c0d770703ab899077f6773d82369a09bb1993d703bf48e0c253ddd24c51e2f" as const;
export const V07_ALIGNED_V2_THROUGHPUT_SOURCE_EXPANDED_SEEDS = 1_081_000 as const;
export const V07_ALIGNED_V2_THROUGHPUT_SOURCE_SEED_SET_SHA256 =
    "70f2c42e8f886af3de5761bd18984b6f485f30971417b6008032292a3b6302a5" as const;
export const V07_ALIGNED_V2_THROUGHPUT_SELECTED_SEEDS = 268_288 as const;
export const V07_ALIGNED_V2_THROUGHPUT_SELECTED_SEED_SET_SHA256 =
    "1c69bc5d6637f3dedd630f7e8319423773b988bcfd9ca339c7732335adaf2eae" as const;
export const V07_ALIGNED_V2_THROUGHPUT_DIAGNOSTIC_PLAN_SHA256 =
    "3fa1ecfbf59cfd74ddbb2db2f7619ea4049e23cfca62a88e4c4ba397c22efc8f" as const;
export const V07_ALIGNED_V2_THROUGHPUT_SCENARIOS_PER_CELL = 256 as const;
export const V07_ALIGNED_V2_THROUGHPUT_BATCHES = 8 as const;
export const V07_ALIGNED_V2_THROUGHPUT_SCENARIOS_PER_CELL_PER_BATCH = 32 as const;
export const V07_ALIGNED_V2_THROUGHPUT_GAMES_PER_BATCH = 768 as const;
export const V07_ALIGNED_V2_THROUGHPUT_GAMES = 6_144 as const;
export const V07_ALIGNED_V2_THROUGHPUT_WORST_COST_LABEL = "aligned-prod-depth-b9ce-h12-d175" as const;
export const V07_ALIGNED_V2_THROUGHPUT_WORST_COST_GENOME_SHA256 =
    "cd016da6a4ffa820df89e57de91f3a01a6f8493145fe17765b74ab51abafb2a7" as const;

const ROOT_INVENTORY = [
    "batches",
    "evidence.json",
    "plan.json",
    "receipt.json",
    "request.json",
    "source-manifest.json",
];

export interface IV07AlignedV2ThroughputGeometry {
    logicalCpus: number;
    reservedCpus: number;
    workersPerShard: number;
    concurrentShards: number;
    maxScenarioPairsPerShard: number;
    shardTimeoutMinutes: number;
}

export interface IV07AlignedV2ThroughputProvenance {
    commit: string;
    sourceTreeSha256: string;
    bunVersion: string;
    bunRevision: string;
    bunExecutableSha256: string;
    dependencyManifestSha256: string;
    lockfileSha256: string | null;
    hostFingerprintSha256: string;
}

export interface IV07AlignedV2ThroughputCodeHashes {
    throughputBytesSha256: string;
    runnerBytesSha256: string;
    evaluatorBytesSha256: string;
    workerBytesSha256: string;
    gameAdapterBytesSha256: string;
    persistenceBytesSha256: string;
    protocolBytesSha256: string;
    seedAllocatorBytesSha256: string;
    catalogBytesSha256: string;
}

export interface IV07AlignedV2ThroughputArtifactRef {
    path: string;
    bytesSha256: string;
    semanticSha256: string;
}

export interface IV07AlignedV2ThroughputSourceRef {
    path: "source-manifest.json";
    bytesSha256: typeof V07_ALIGNED_V2_THROUGHPUT_SOURCE_MANIFEST_BYTES_SHA256;
}

export interface IV07AlignedV2ThroughputSeedReceipt {
    schemaVersion: 1;
    artifactKind: "v0_7_aligned_96h_v2_spent_diagnostic_seed_receipt";
    status: "research_only_no_bake";
    automaticBake: false;
    automaticDeploy: false;
    formalEligibility: "never_formal_preexisting_committed_denyset";
    sourceManifestRepositoryPath: typeof V07_ALIGNED_V2_THROUGHPUT_SOURCE_MANIFEST;
    sourceManifestBytesSha256: typeof V07_ALIGNED_V2_THROUGHPUT_SOURCE_MANIFEST_BYTES_SHA256;
    sourceManifestShape: "composed_affine_reservation";
    sourceExpandedSeedCount: typeof V07_ALIGNED_V2_THROUGHPUT_SOURCE_EXPANDED_SEEDS;
    sourceExpandedSeedSetSha256: typeof V07_ALIGNED_V2_THROUGHPUT_SOURCE_SEED_SET_SHA256;
    selectionRule: "ascending_uint32_prefix_268288";
    selectedSeedCount: typeof V07_ALIGNED_V2_THROUGHPUT_SELECTED_SEEDS;
    selectedSeedSetSha256: typeof V07_ALIGNED_V2_THROUGHPUT_SELECTED_SEED_SET_SHA256;
    planSha256: string;
    receiptSha256: string;
}

export interface IV07AlignedV2ThroughputRequest {
    schemaVersion: 1;
    artifactKind: "v0_7_aligned_96h_v2_throughput_request";
    status: "research_only_no_bake";
    automaticBake: false;
    automaticDeploy: false;
    sampleProtocol: "all_12_cells_two_seats_8_sequential_batches_persisted_replay";
    scenariosPerCell: typeof V07_ALIGNED_V2_THROUGHPUT_SCENARIOS_PER_CELL;
    batches: typeof V07_ALIGNED_V2_THROUGHPUT_BATCHES;
    scenariosPerCellPerBatch: typeof V07_ALIGNED_V2_THROUGHPUT_SCENARIOS_PER_CELL_PER_BATCH;
    gamesPerBatch: typeof V07_ALIGNED_V2_THROUGHPUT_GAMES_PER_BATCH;
    games: typeof V07_ALIGNED_V2_THROUGHPUT_GAMES;
    catalogSha256: typeof V07_ALIGNED_V2_PRODUCTION_CATALOG_SHA256;
    worstCostArmLabel: typeof V07_ALIGNED_V2_THROUGHPUT_WORST_COST_LABEL;
    worstCostGenomeSha256: typeof V07_ALIGNED_V2_THROUGHPUT_WORST_COST_GENOME_SHA256;
    seedReceiptSha256: string;
    seedPlanSha256: string;
    geometry: IV07AlignedV2ThroughputGeometry;
    provenance: IV07AlignedV2ThroughputProvenance;
    code: IV07AlignedV2ThroughputCodeHashes;
    runFingerprint: string;
    requestSha256: string;
}

export interface IV07AlignedV2ThroughputShardRef {
    directory: string;
    manifestSha256: string;
    games: number;
    workerAttestations: number;
}

export interface IV07AlignedV2ThroughputBatchManifest {
    schemaVersion: 1;
    artifactKind: "v0_7_aligned_96h_v2_throughput_batch";
    status: "research_only_no_bake";
    automaticBake: false;
    automaticDeploy: false;
    batchIndex: number;
    requestSha256: string;
    runFingerprint: string;
    plan: IV07AlignedV2ThroughputArtifactRef;
    startedAtMs: number;
    endedAtMs: number;
    elapsedMs: number;
    games: typeof V07_ALIGNED_V2_THROUGHPUT_GAMES_PER_BATCH;
    workerAttestations: number;
    shards: IV07AlignedV2ThroughputShardRef[];
    gamesPerWorkerHour: number;
    batchSha256: string;
}

export interface IV07AlignedV2ThroughputEvidenceManifest {
    schemaVersion: 1;
    artifactKind: "v0_7_aligned_96h_v2_throughput_evidence";
    status: "research_only_no_bake";
    automaticBake: false;
    automaticDeploy: false;
    sourceManifest: IV07AlignedV2ThroughputSourceRef;
    receipt: IV07AlignedV2ThroughputArtifactRef;
    plan: IV07AlignedV2ThroughputArtifactRef;
    request: IV07AlignedV2ThroughputArtifactRef;
    batches: IV07AlignedV2ThroughputArtifactRef[];
    sampleGames: typeof V07_ALIGNED_V2_THROUGHPUT_GAMES;
    sampleGamesPerCellSeat: typeof V07_ALIGNED_V2_THROUGHPUT_SCENARIOS_PER_CELL;
    totalElapsedMs: number;
    minimumBatchGamesPerWorkerHour: number;
    persistedReplayVerified: true;
    workerAttestationsVerified: true;
    evidenceSha256: string;
}

export interface IV07AlignedV2ThroughputReplay {
    rootDirectory: string;
    receipt: IV07AlignedV2ThroughputSeedReceipt;
    plan: IV07AlignedV2InjectedSeedPlan;
    request: IV07AlignedV2ThroughputRequest;
    batches: IV07AlignedV2ThroughputBatchManifest[];
    evidence: IV07AlignedV2ThroughputEvidenceManifest;
}

export interface IV07AlignedV2ThroughputRunOptions {
    rootDirectory: string;
    sourceManifestBytes: Buffer;
    geometry: IV07AlignedV2ThroughputGeometry;
    provenance: IV07AlignedV2ThroughputProvenance;
}

export interface IV07AlignedV2ThroughputReplayDependencies {
    loadShard?: (directory: string, expectations: IV07AlignedV2ShardLoadExpectations) => IV07AlignedV2PersistedShard;
}

export interface IV07AlignedV2ProductionThroughputAttestation {
    schemaVersion: 2;
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
    reservedCpus: number;
    workersPerShard: number;
    concurrentShards: number;
    maxScenarioPairsPerShard: number;
    shardTimeoutMinutes: number;
    sampleProtocol: "all_12_cells_two_seats_8_sequential_batches_persisted_replay";
    sampleGamesPerCellSeat: typeof V07_ALIGNED_V2_THROUGHPUT_SCENARIOS_PER_CELL;
    sampleGames: typeof V07_ALIGNED_V2_THROUGHPUT_GAMES;
    batchCount: typeof V07_ALIGNED_V2_THROUGHPUT_BATCHES;
    totalElapsedMs: number;
    persistedReplayVerified: true;
    workerAttestationsVerified: true;
    gamesPerWorkerHour: number;
    evidenceRootPath: string;
    evidenceManifestBytesSha256: string;
    evidenceManifestSha256: string;
    throughputBytesSha256: string;
    runnerBytesSha256: string;
    evaluatorBytesSha256: string;
    workerBytesSha256: string;
    gameAdapterBytesSha256: string;
    persistenceBytesSha256: string;
    protocolBytesSha256: string;
    seedAllocatorBytesSha256: string;
    catalogBytesSha256: string;
    attestationSha256: string;
}

export interface IV07AlignedV2ProductionThroughputExpectation extends IV07AlignedV2ThroughputGeometry {
    gamesPerWorkerHour: number;
}

function sha256(value: string | Buffer): string {
    return createHash("sha256").update(value).digest("hex");
}

function fingerprintSeedSet(seeds: readonly number[]): string {
    const hash = createHash("sha256");
    seeds.forEach((seed) => hash.update(`${seed}\n`));
    return hash.digest("hex");
}

function canonicalFile(value: unknown): string {
    return `${canonicalV07AlignedV2Json(value)}\n`;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    return canonicalV07AlignedV2Json(Object.keys(value).sort()) === canonicalV07AlignedV2Json([...keys].sort());
}

function requireSha256(value: unknown, label: string): asserts value is string {
    if (typeof value !== "string" || !SHA256_PATTERN.test(value)) throw new Error(`${label} must be a SHA-256`);
}

function requireInteger(value: unknown, label: string, minimum = 0): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) {
        throw new Error(`${label} must be an integer >= ${minimum}`);
    }
}

function requirePositiveFinite(value: unknown, label: string): asserts value is number {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new Error(`${label} must be finite and > 0`);
    }
}

function decodeUtf8Exact(bytes: Buffer, label: string): string {
    let contents: string;
    try {
        contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        throw new Error(`${label} is not valid UTF-8`);
    }
    if (!Buffer.from(contents, "utf8").equals(bytes)) throw new Error(`${label} is not canonical UTF-8`);
    return contents;
}

function parseJsonBytes<T>(bytes: Buffer, label: string): T {
    try {
        return JSON.parse(decodeUtf8Exact(bytes, label)) as T;
    } catch (error) {
        if (error instanceof Error && error.message.startsWith(label)) throw error;
        throw new Error(`${label} is malformed JSON (${String(error)})`);
    }
}

function parseCanonicalBytes<T>(bytes: Buffer, label: string): T {
    const contents = decodeUtf8Exact(bytes, label);
    if (!contents.endsWith("\n")) throw new Error(`${label} lacks a terminal newline`);
    const parsed = parseJsonBytes<T>(bytes, label);
    if (contents !== canonicalFile(parsed)) throw new Error(`${label} is not canonical JSON`);
    return parsed;
}

function unsignedSelfHash<T extends Record<string, unknown>>(value: T, hashKey: keyof T): Record<string, unknown> {
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== hashKey));
}

function requireSelfHash(value: Record<string, unknown>, hashKey: string, label: string): void {
    requireSha256(value[hashKey], `${label}.${hashKey}`);
    if (value[hashKey] !== fingerprintV07AlignedV2(unsignedSelfHash(value, hashKey))) {
        throw new Error(`${label} self-hash mismatch`);
    }
}

function validateSafeRelativePath(value: unknown, label: string): string {
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

function relativeBelow(root: string, target: string, label: string): string {
    const value = relative(root, target).split(sep).join("/");
    validateSafeRelativePath(value, label);
    if (value === ".." || value.startsWith("../")) throw new Error(`${label} must remain below its root`);
    return value;
}

function resolveSafeEntry(root: string, relativePath: string, label: string, kind: "file" | "directory"): string {
    validateSafeRelativePath(relativePath, label);
    let cursor = root;
    for (const segment of relativePath.split("/")) {
        cursor = resolve(cursor, segment);
        if (!existsSync(cursor) || lstatSync(cursor).isSymbolicLink()) {
            throw new Error(`${label} must exist without symbolic-link traversal`);
        }
    }
    const path = realpathSync(cursor);
    const stats = lstatSync(path);
    if (!path.startsWith(`${root}${sep}`) || (kind === "file" ? !stats.isFile() : !stats.isDirectory())) {
        throw new Error(`${label} is not a ${kind} below the evidence root`);
    }
    return path;
}

function readArtifact(root: string, ref: IV07AlignedV2ThroughputArtifactRef, label: string): unknown {
    validateArtifactRef(ref, label);
    const bytes = readFileSync(resolveSafeEntry(root, ref.path, `${label}.path`, "file"));
    if (sha256(bytes) !== ref.bytesSha256) throw new Error(`${label} raw bytes changed`);
    const parsed = parseCanonicalBytes<unknown>(bytes, label);
    if (fingerprintV07AlignedV2(parsed) !== ref.semanticSha256) throw new Error(`${label} semantic hash changed`);
    return parsed;
}

function artifactRef(path: string, value: unknown): IV07AlignedV2ThroughputArtifactRef {
    validateSafeRelativePath(path, "artifact path");
    const contents = canonicalFile(value);
    return { path, bytesSha256: sha256(contents), semanticSha256: fingerprintV07AlignedV2(value) };
}

function validateArtifactRef(value: unknown, label: string): IV07AlignedV2ThroughputArtifactRef {
    if (!isObject(value) || !exactKeys(value, ["path", "bytesSha256", "semanticSha256"])) {
        throw new Error(`${label} fields are not exact`);
    }
    validateSafeRelativePath(value.path, `${label}.path`);
    requireSha256(value.bytesSha256, `${label}.bytesSha256`);
    requireSha256(value.semanticSha256, `${label}.semanticSha256`);
    return value as unknown as IV07AlignedV2ThroughputArtifactRef;
}

function ensureFreshDirectory(path: string): string {
    if (existsSync(path)) throw new Error(`throughput evidence output already exists: ${path}`);
    const parent = realpathSync(dirname(resolve(path)));
    mkdirSync(join(parent, basename(path)), { mode: 0o700 });
    const root = realpathSync(path);
    const parentFd = openSync(parent, "r");
    try {
        fsyncSync(parentFd);
    } finally {
        closeSync(parentFd);
    }
    return root;
}

function ensureDirectory(path: string): void {
    mkdirSync(path, { mode: 0o700 });
}

function writeExclusive(path: string, contents: string | Buffer): void {
    const descriptor = openSync(path, "wx", 0o600);
    try {
        writeFileSync(descriptor, contents);
        fsyncSync(descriptor);
    } finally {
        closeSync(descriptor);
    }
    const parent = openSync(dirname(path), "r");
    try {
        fsyncSync(parent);
    } finally {
        closeSync(parent);
    }
}

function writeCanonical(path: string, value: unknown): void {
    writeExclusive(path, canonicalFile(value));
}

function validateGeometry(value: unknown, requireCurrentHost: boolean): IV07AlignedV2ThroughputGeometry {
    if (
        !isObject(value) ||
        !exactKeys(value, [
            "logicalCpus",
            "reservedCpus",
            "workersPerShard",
            "concurrentShards",
            "maxScenarioPairsPerShard",
            "shardTimeoutMinutes",
        ])
    ) {
        throw new Error("throughput geometry fields are not exact");
    }
    requireInteger(value.logicalCpus, "geometry.logicalCpus", 1);
    requireInteger(value.reservedCpus, "geometry.reservedCpus");
    requireInteger(value.workersPerShard, "geometry.workersPerShard", 1);
    requireInteger(value.concurrentShards, "geometry.concurrentShards", 1);
    requireInteger(value.maxScenarioPairsPerShard, "geometry.maxScenarioPairsPerShard", 1);
    requirePositiveFinite(value.shardTimeoutMinutes, "geometry.shardTimeoutMinutes");
    const totalWorkers = value.workersPerShard * value.concurrentShards;
    if (
        value.reservedCpus >= value.logicalCpus ||
        totalWorkers > value.logicalCpus - value.reservedCpus ||
        value.shardTimeoutMinutes > 30 ||
        (requireCurrentHost && value.logicalCpus !== availableParallelism())
    ) {
        throw new Error("throughput geometry does not fit the current production host");
    }
    return value as unknown as IV07AlignedV2ThroughputGeometry;
}

function selectedSourceSeeds(sourceManifestBytes: Buffer): number[] {
    if (sha256(sourceManifestBytes) !== V07_ALIGNED_V2_THROUGHPUT_SOURCE_MANIFEST_BYTES_SHA256) {
        throw new Error("throughput source manifest raw SHA-256 is not the frozen committed source");
    }
    const expansion = expandV07AlignedV2CommittedManifest(
        parseJsonBytes(sourceManifestBytes, "throughput source manifest"),
    );
    if (
        expansion.shape !== "composed_affine_reservation" ||
        expansion.seeds.length !== V07_ALIGNED_V2_THROUGHPUT_SOURCE_EXPANDED_SEEDS ||
        fingerprintSeedSet(expansion.seeds) !== V07_ALIGNED_V2_THROUGHPUT_SOURCE_SEED_SET_SHA256
    ) {
        throw new Error("throughput source manifest affine expansion drifted from the frozen reservation");
    }
    const selected = expansion.seeds.slice(0, V07_ALIGNED_V2_THROUGHPUT_SELECTED_SEEDS);
    if (
        selected.length !== V07_ALIGNED_V2_THROUGHPUT_SELECTED_SEEDS ||
        fingerprintSeedSet(selected) !== V07_ALIGNED_V2_THROUGHPUT_SELECTED_SEED_SET_SHA256
    ) {
        throw new Error("throughput diagnostic seed selection drifted from the frozen ascending prefix");
    }
    return selected;
}

function diagnosticPlanFromSeeds(seeds: readonly number[]): IV07AlignedV2InjectedSeedPlan {
    let cursor = 0;
    const take = (): number => {
        const value = seeds[cursor++];
        if (value === undefined) throw new Error("throughput diagnostic seed source was exhausted");
        return value;
    };
    const pairs: IV07AlignedV2ScenarioPair[] = [];
    for (const cell of V07_ALIGNED_V2_EVALUATOR_CELLS) {
        for (
            let scenarioOrdinal = 0;
            scenarioOrdinal < V07_ALIGNED_V2_THROUGHPUT_SCENARIOS_PER_CELL;
            scenarioOrdinal += 1
        ) {
            const scenarioId = `throughput-${String(scenarioOrdinal).padStart(3, "0")}`;
            if (cell.scenarioProtocol === "independent_seat_conditioned") {
                const greenSetup = Array.from({ length: 128 }, take);
                const greenCombat = take();
                const redSetup = Array.from({ length: 128 }, take);
                const redCombat = take();
                pairs.push({
                    cellId: cell.id,
                    scenarioOrdinal,
                    scenarioId,
                    seats: {
                        candidate_green: { setupSeeds: greenSetup, combatSeed: greenCombat },
                        candidate_red: { setupSeeds: redSetup, combatSeed: redCombat },
                    },
                });
            } else {
                const setupSeed = take();
                const combatSeed = take();
                pairs.push({
                    cellId: cell.id,
                    scenarioOrdinal,
                    scenarioId,
                    seats: {
                        candidate_green: { setupSeeds: [setupSeed], combatSeed },
                        candidate_red: { setupSeeds: [setupSeed], combatSeed },
                    },
                });
            }
        }
    }
    if (cursor !== V07_ALIGNED_V2_THROUGHPUT_SELECTED_SEEDS || cursor !== seeds.length) {
        throw new Error(`throughput diagnostic plan consumed ${cursor} seeds instead of ${seeds.length}`);
    }
    const plan: IV07AlignedV2InjectedSeedPlan = {
        schemaVersion: 1,
        panelId: "aligned-v2-throughput-diagnostic-6144",
        purpose: "train",
        scenariosPerCell: V07_ALIGNED_V2_THROUGHPUT_SCENARIOS_PER_CELL,
        denysetSha256: V07_ALIGNED_V2_THROUGHPUT_SOURCE_SEED_SET_SHA256,
        pairs,
    };
    validateV07AlignedV2SeedPlan(plan);
    if (fingerprintV07AlignedV2(plan) !== V07_ALIGNED_V2_THROUGHPUT_DIAGNOSTIC_PLAN_SHA256) {
        throw new Error("throughput diagnostic plan drifted from its frozen content address");
    }
    return plan;
}

export function buildV07AlignedV2ThroughputDiagnosticPlan(sourceManifestBytes: Buffer): IV07AlignedV2InjectedSeedPlan {
    return diagnosticPlanFromSeeds(selectedSourceSeeds(sourceManifestBytes));
}

export function buildV07AlignedV2ThroughputSeedReceipt(sourceManifestBytes: Buffer): {
    receipt: IV07AlignedV2ThroughputSeedReceipt;
    plan: IV07AlignedV2InjectedSeedPlan;
} {
    const plan = buildV07AlignedV2ThroughputDiagnosticPlan(sourceManifestBytes);
    const unsigned = {
        schemaVersion: 1 as const,
        artifactKind: "v0_7_aligned_96h_v2_spent_diagnostic_seed_receipt" as const,
        status: "research_only_no_bake" as const,
        automaticBake: false as const,
        automaticDeploy: false as const,
        formalEligibility: "never_formal_preexisting_committed_denyset" as const,
        sourceManifestRepositoryPath: V07_ALIGNED_V2_THROUGHPUT_SOURCE_MANIFEST,
        sourceManifestBytesSha256: V07_ALIGNED_V2_THROUGHPUT_SOURCE_MANIFEST_BYTES_SHA256,
        sourceManifestShape: "composed_affine_reservation" as const,
        sourceExpandedSeedCount: V07_ALIGNED_V2_THROUGHPUT_SOURCE_EXPANDED_SEEDS,
        sourceExpandedSeedSetSha256: V07_ALIGNED_V2_THROUGHPUT_SOURCE_SEED_SET_SHA256,
        selectionRule: "ascending_uint32_prefix_268288" as const,
        selectedSeedCount: V07_ALIGNED_V2_THROUGHPUT_SELECTED_SEEDS,
        selectedSeedSetSha256: V07_ALIGNED_V2_THROUGHPUT_SELECTED_SEED_SET_SHA256,
        planSha256: fingerprintV07AlignedV2(plan),
    };
    return { receipt: { ...unsigned, receiptSha256: fingerprintV07AlignedV2(unsigned) }, plan };
}

export function validateV07AlignedV2ThroughputSeedReceipt(
    value: unknown,
    sourceManifestBytes: Buffer,
    plan: IV07AlignedV2InjectedSeedPlan,
): IV07AlignedV2ThroughputSeedReceipt {
    const expected = buildV07AlignedV2ThroughputSeedReceipt(sourceManifestBytes);
    validateV07AlignedV2SeedPlan(plan);
    if (
        !isObject(value) ||
        !exactKeys(value, Object.keys(expected.receipt)) ||
        canonicalV07AlignedV2Json(value) !== canonicalV07AlignedV2Json(expected.receipt) ||
        canonicalV07AlignedV2Json(plan) !== canonicalV07AlignedV2Json(expected.plan)
    ) {
        throw new Error("throughput seed receipt/plan does not replay from the frozen committed manifest");
    }
    requireSelfHash(value, "receiptSha256", "throughput seed receipt");
    return value as unknown as IV07AlignedV2ThroughputSeedReceipt;
}

export function buildV07AlignedV2ThroughputBatchPlan(
    plan: IV07AlignedV2InjectedSeedPlan,
    batchIndex: number,
): IV07AlignedV2InjectedSeedPlan {
    validateV07AlignedV2SeedPlan(plan);
    requireInteger(batchIndex, "batchIndex");
    if (
        plan.scenariosPerCell !== V07_ALIGNED_V2_THROUGHPUT_SCENARIOS_PER_CELL ||
        batchIndex >= V07_ALIGNED_V2_THROUGHPUT_BATCHES
    ) {
        throw new Error("throughput batch request is outside the exact 256-scenario production diagnostic plan");
    }
    const start = batchIndex * V07_ALIGNED_V2_THROUGHPUT_SCENARIOS_PER_CELL_PER_BATCH;
    const end = start + V07_ALIGNED_V2_THROUGHPUT_SCENARIOS_PER_CELL_PER_BATCH;
    const pairs = plan.pairs
        .filter((pair) => pair.scenarioOrdinal >= start && pair.scenarioOrdinal < end)
        .map((pair) => ({ ...structuredClone(pair), scenarioOrdinal: pair.scenarioOrdinal - start }));
    const batch: IV07AlignedV2InjectedSeedPlan = {
        schemaVersion: 1,
        panelId: `${plan.panelId}-batch-${String(batchIndex).padStart(2, "0")}`,
        purpose: "train",
        scenariosPerCell: V07_ALIGNED_V2_THROUGHPUT_SCENARIOS_PER_CELL_PER_BATCH,
        denysetSha256: plan.denysetSha256,
        pairs,
    };
    validateV07AlignedV2SeedPlan(batch);
    return batch;
}

export function buildV07AlignedV2ThroughputWorstCostGenome(): IV07AlignedV2CandidateGenome {
    const matches = buildV07AlignedV2ProductionCandidateCatalog().filter(
        (genome) => genome.search.label === V07_ALIGNED_V2_THROUGHPUT_WORST_COST_LABEL,
    );
    if (
        matches.length !== 1 ||
        fingerprintV07AlignedV2CandidateGenome(matches[0]) !== V07_ALIGNED_V2_THROUGHPUT_WORST_COST_GENOME_SHA256
    ) {
        throw new Error("throughput worst-cost arm drifted from the frozen production catalog");
    }
    return structuredClone(matches[0]);
}

function validateProvenance(value: unknown): IV07AlignedV2ThroughputProvenance {
    if (
        !isObject(value) ||
        !exactKeys(value, [
            "commit",
            "sourceTreeSha256",
            "bunVersion",
            "bunRevision",
            "bunExecutableSha256",
            "dependencyManifestSha256",
            "lockfileSha256",
            "hostFingerprintSha256",
        ]) ||
        typeof value.commit !== "string" ||
        !COMMIT_PATTERN.test(value.commit) ||
        typeof value.bunVersion !== "string" ||
        !value.bunVersion ||
        typeof value.bunRevision !== "string" ||
        !value.bunRevision
    ) {
        throw new Error("throughput provenance fields are invalid");
    }
    for (const key of [
        "sourceTreeSha256",
        "bunExecutableSha256",
        "dependencyManifestSha256",
        "hostFingerprintSha256",
    ] as const) {
        requireSha256(value[key], `throughput provenance ${key}`);
    }
    if (value.lockfileSha256 !== null) requireSha256(value.lockfileSha256, "throughput provenance lockfileSha256");
    return value as unknown as IV07AlignedV2ThroughputProvenance;
}

function sourceCodeHashes(): IV07AlignedV2ThroughputCodeHashes {
    const root = dirname(fileURLToPath(import.meta.url));
    const hash = (name: string): string => sha256(readFileSync(join(root, name)));
    return {
        throughputBytesSha256: hash("v0_7_aligned_96h_v2_throughput.ts"),
        runnerBytesSha256: hash("v0_7_aligned_96h_v2_runner.ts"),
        evaluatorBytesSha256: hash("v0_7_aligned_96h_v2_evaluator.ts"),
        workerBytesSha256: hash("v0_7_aligned_96h_v2_worker.ts"),
        gameAdapterBytesSha256: hash("v0_7_aligned_96h_v2_game_adapter.ts"),
        persistenceBytesSha256: hash("v0_7_aligned_96h_v2_persistence.ts"),
        protocolBytesSha256: hash("v0_7_aligned_96h_v2_protocol.ts"),
        seedAllocatorBytesSha256: hash("v0_7_aligned_96h_v2_seed_allocator.ts"),
        catalogBytesSha256: hash("v0_7_aligned_96h_v2_catalog.ts"),
    };
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

function validateCodeHashes(value: unknown): IV07AlignedV2ThroughputCodeHashes {
    const expected = sourceCodeHashes();
    if (!isObject(value) || !exactKeys(value, Object.keys(expected))) {
        throw new Error("throughput code hash ledger fields are not exact");
    }
    Object.entries(value).forEach(([key, hash]) => requireSha256(hash, `throughput code ${key}`));
    if (canonicalV07AlignedV2Json(value) !== canonicalV07AlignedV2Json(expected)) {
        throw new Error("throughput evidence does not bind the exact local evaluation source files");
    }
    return value as unknown as IV07AlignedV2ThroughputCodeHashes;
}

export function buildV07AlignedV2ThroughputRequest(options: {
    geometry: IV07AlignedV2ThroughputGeometry;
    provenance: IV07AlignedV2ThroughputProvenance;
    receipt: IV07AlignedV2ThroughputSeedReceipt;
    plan: IV07AlignedV2InjectedSeedPlan;
}): IV07AlignedV2ThroughputRequest {
    const geometry = validateGeometry(options.geometry, true);
    const provenance = validateProvenance(options.provenance);
    const genome = buildV07AlignedV2ThroughputWorstCostGenome();
    if (
        options.receipt.planSha256 !== fingerprintV07AlignedV2(options.plan) ||
        flattenV07AlignedV2SeedPlan(options.plan).length !== V07_ALIGNED_V2_THROUGHPUT_GAMES
    ) {
        throw new Error("throughput request seed receipt does not bind the exact 6,144-game plan");
    }
    const code = sourceCodeHashes();
    const identity = {
        seedReceiptSha256: options.receipt.receiptSha256,
        seedPlanSha256: options.receipt.planSha256,
        catalogSha256: V07_ALIGNED_V2_PRODUCTION_CATALOG_SHA256,
        worstCostGenomeSha256: fingerprintV07AlignedV2CandidateGenome(genome),
        geometry,
        provenance,
        code,
    };
    const unsigned = {
        schemaVersion: 1 as const,
        artifactKind: "v0_7_aligned_96h_v2_throughput_request" as const,
        status: "research_only_no_bake" as const,
        automaticBake: false as const,
        automaticDeploy: false as const,
        sampleProtocol: "all_12_cells_two_seats_8_sequential_batches_persisted_replay" as const,
        scenariosPerCell: V07_ALIGNED_V2_THROUGHPUT_SCENARIOS_PER_CELL,
        batches: V07_ALIGNED_V2_THROUGHPUT_BATCHES,
        scenariosPerCellPerBatch: V07_ALIGNED_V2_THROUGHPUT_SCENARIOS_PER_CELL_PER_BATCH,
        gamesPerBatch: V07_ALIGNED_V2_THROUGHPUT_GAMES_PER_BATCH,
        games: V07_ALIGNED_V2_THROUGHPUT_GAMES,
        catalogSha256: V07_ALIGNED_V2_PRODUCTION_CATALOG_SHA256,
        worstCostArmLabel: V07_ALIGNED_V2_THROUGHPUT_WORST_COST_LABEL,
        worstCostGenomeSha256: V07_ALIGNED_V2_THROUGHPUT_WORST_COST_GENOME_SHA256,
        seedReceiptSha256: options.receipt.receiptSha256,
        seedPlanSha256: options.receipt.planSha256,
        geometry,
        provenance,
        code,
        runFingerprint: fingerprintV07AlignedV2(identity),
    };
    return { ...unsigned, requestSha256: fingerprintV07AlignedV2(unsigned) };
}

export function validateV07AlignedV2ThroughputRequest(
    value: unknown,
    receipt: IV07AlignedV2ThroughputSeedReceipt,
    plan: IV07AlignedV2InjectedSeedPlan,
): IV07AlignedV2ThroughputRequest {
    if (!isObject(value)) throw new Error("throughput request must be an object");
    const expectedKeys = [
        "schemaVersion",
        "artifactKind",
        "status",
        "automaticBake",
        "automaticDeploy",
        "sampleProtocol",
        "scenariosPerCell",
        "batches",
        "scenariosPerCellPerBatch",
        "gamesPerBatch",
        "games",
        "catalogSha256",
        "worstCostArmLabel",
        "worstCostGenomeSha256",
        "seedReceiptSha256",
        "seedPlanSha256",
        "geometry",
        "provenance",
        "code",
        "runFingerprint",
        "requestSha256",
    ];
    if (
        !exactKeys(value, expectedKeys) ||
        value.schemaVersion !== 1 ||
        value.artifactKind !== "v0_7_aligned_96h_v2_throughput_request" ||
        value.status !== "research_only_no_bake" ||
        value.automaticBake !== false ||
        value.automaticDeploy !== false ||
        value.sampleProtocol !== "all_12_cells_two_seats_8_sequential_batches_persisted_replay" ||
        value.scenariosPerCell !== V07_ALIGNED_V2_THROUGHPUT_SCENARIOS_PER_CELL ||
        value.batches !== V07_ALIGNED_V2_THROUGHPUT_BATCHES ||
        value.scenariosPerCellPerBatch !== V07_ALIGNED_V2_THROUGHPUT_SCENARIOS_PER_CELL_PER_BATCH ||
        value.gamesPerBatch !== V07_ALIGNED_V2_THROUGHPUT_GAMES_PER_BATCH ||
        value.games !== V07_ALIGNED_V2_THROUGHPUT_GAMES ||
        value.catalogSha256 !== V07_ALIGNED_V2_PRODUCTION_CATALOG_SHA256 ||
        value.worstCostArmLabel !== V07_ALIGNED_V2_THROUGHPUT_WORST_COST_LABEL ||
        value.worstCostGenomeSha256 !== V07_ALIGNED_V2_THROUGHPUT_WORST_COST_GENOME_SHA256 ||
        value.seedReceiptSha256 !== receipt.receiptSha256 ||
        value.seedPlanSha256 !== fingerprintV07AlignedV2(plan)
    ) {
        throw new Error("throughput request does not bind the frozen production diagnostic protocol");
    }
    validateGeometry(value.geometry, true);
    validateProvenance(value.provenance);
    validateCodeHashes(value.code);
    requireSha256(value.runFingerprint, "throughput request runFingerprint");
    requireSelfHash(value, "requestSha256", "throughput request");
    const rebuilt = buildV07AlignedV2ThroughputRequest({
        geometry: value.geometry as unknown as IV07AlignedV2ThroughputGeometry,
        provenance: value.provenance as unknown as IV07AlignedV2ThroughputProvenance,
        receipt,
        plan,
    });
    if (canonicalV07AlignedV2Json(value) !== canonicalV07AlignedV2Json(rebuilt)) {
        throw new Error("throughput request is not the deterministic request for its exact inputs");
    }
    return value as unknown as IV07AlignedV2ThroughputRequest;
}

function batchDirectoryName(index: number): string {
    return `batch-${String(index).padStart(3, "0")}`;
}

function validateShardRef(value: unknown, label: string): IV07AlignedV2ThroughputShardRef {
    if (!isObject(value) || !exactKeys(value, ["directory", "manifestSha256", "games", "workerAttestations"])) {
        throw new Error(`${label} fields are not exact`);
    }
    validateSafeRelativePath(value.directory, `${label}.directory`);
    requireSha256(value.manifestSha256, `${label}.manifestSha256`);
    requireInteger(value.games, `${label}.games`, 2);
    requireInteger(value.workerAttestations, `${label}.workerAttestations`, 1);
    return value as unknown as IV07AlignedV2ThroughputShardRef;
}

function validateBatchManifest(
    value: unknown,
    request: IV07AlignedV2ThroughputRequest,
    expectedIndex: number,
    planRef: IV07AlignedV2ThroughputArtifactRef,
): IV07AlignedV2ThroughputBatchManifest {
    if (
        !isObject(value) ||
        !exactKeys(value, [
            "schemaVersion",
            "artifactKind",
            "status",
            "automaticBake",
            "automaticDeploy",
            "batchIndex",
            "requestSha256",
            "runFingerprint",
            "plan",
            "startedAtMs",
            "endedAtMs",
            "elapsedMs",
            "games",
            "workerAttestations",
            "shards",
            "gamesPerWorkerHour",
            "batchSha256",
        ]) ||
        value.schemaVersion !== 1 ||
        value.artifactKind !== "v0_7_aligned_96h_v2_throughput_batch" ||
        value.status !== "research_only_no_bake" ||
        value.automaticBake !== false ||
        value.automaticDeploy !== false ||
        value.batchIndex !== expectedIndex ||
        value.requestSha256 !== request.requestSha256 ||
        value.runFingerprint !== request.runFingerprint ||
        canonicalV07AlignedV2Json(value.plan) !== canonicalV07AlignedV2Json(planRef) ||
        value.games !== V07_ALIGNED_V2_THROUGHPUT_GAMES_PER_BATCH ||
        !Array.isArray(value.shards)
    ) {
        throw new Error(`throughput batch ${expectedIndex} header/fields are invalid`);
    }
    requireInteger(value.startedAtMs, `throughput batch ${expectedIndex}.startedAtMs`);
    requireInteger(value.endedAtMs, `throughput batch ${expectedIndex}.endedAtMs`);
    requirePositiveFinite(value.elapsedMs, `throughput batch ${expectedIndex}.elapsedMs`);
    requireInteger(value.workerAttestations, `throughput batch ${expectedIndex}.workerAttestations`, 1);
    requirePositiveFinite(value.gamesPerWorkerHour, `throughput batch ${expectedIndex}.gamesPerWorkerHour`);
    if (value.endedAtMs < value.startedAtMs) throw new Error(`throughput batch ${expectedIndex} wall clock regressed`);
    if (Math.abs(value.endedAtMs - value.startedAtMs - value.elapsedMs) > 5_000) {
        throw new Error(`throughput batch ${expectedIndex} wall and monotonic elapsed intervals diverged`);
    }
    const expectedRate =
        (V07_ALIGNED_V2_THROUGHPUT_GAMES_PER_BATCH * HOUR_MS) /
        (value.elapsedMs * request.geometry.workersPerShard * request.geometry.concurrentShards);
    if (Math.abs(value.gamesPerWorkerHour - expectedRate) / expectedRate > 1e-12) {
        throw new Error(`throughput batch ${expectedIndex} rate is not derived from its complete elapsed interval`);
    }
    const refs = value.shards.map((entry, index) =>
        validateShardRef(entry, `throughput batch ${expectedIndex}.shards[${index}]`),
    );
    if (
        refs.length < request.geometry.concurrentShards ||
        refs.reduce((sum, entry) => sum + entry.games, 0) !== V07_ALIGNED_V2_THROUGHPUT_GAMES_PER_BATCH ||
        refs.reduce((sum, entry) => sum + entry.workerAttestations, 0) !== value.workerAttestations
    ) {
        throw new Error(`throughput batch ${expectedIndex} shard/game/worker census is invalid`);
    }
    requireSelfHash(value, "batchSha256", `throughput batch ${expectedIndex}`);
    return value as unknown as IV07AlignedV2ThroughputBatchManifest;
}

function validateEvidenceManifest(value: unknown): IV07AlignedV2ThroughputEvidenceManifest {
    if (
        !isObject(value) ||
        !exactKeys(value, [
            "schemaVersion",
            "artifactKind",
            "status",
            "automaticBake",
            "automaticDeploy",
            "sourceManifest",
            "receipt",
            "plan",
            "request",
            "batches",
            "sampleGames",
            "sampleGamesPerCellSeat",
            "totalElapsedMs",
            "minimumBatchGamesPerWorkerHour",
            "persistedReplayVerified",
            "workerAttestationsVerified",
            "evidenceSha256",
        ]) ||
        value.schemaVersion !== 1 ||
        value.artifactKind !== "v0_7_aligned_96h_v2_throughput_evidence" ||
        value.status !== "research_only_no_bake" ||
        value.automaticBake !== false ||
        value.automaticDeploy !== false ||
        value.sampleGames !== V07_ALIGNED_V2_THROUGHPUT_GAMES ||
        value.sampleGamesPerCellSeat !== V07_ALIGNED_V2_THROUGHPUT_SCENARIOS_PER_CELL ||
        value.persistedReplayVerified !== true ||
        value.workerAttestationsVerified !== true ||
        !Array.isArray(value.batches) ||
        value.batches.length !== V07_ALIGNED_V2_THROUGHPUT_BATCHES
    ) {
        throw new Error("throughput evidence manifest header/fields are invalid");
    }
    if (
        !isObject(value.sourceManifest) ||
        !exactKeys(value.sourceManifest, ["path", "bytesSha256"]) ||
        value.sourceManifest.path !== "source-manifest.json" ||
        value.sourceManifest.bytesSha256 !== V07_ALIGNED_V2_THROUGHPUT_SOURCE_MANIFEST_BYTES_SHA256
    ) {
        throw new Error("throughput evidence source manifest reference is invalid");
    }
    validateArtifactRef(value.receipt, "throughput evidence receipt");
    validateArtifactRef(value.plan, "throughput evidence plan");
    validateArtifactRef(value.request, "throughput evidence request");
    value.batches.forEach((entry, index) => {
        const ref = validateArtifactRef(entry, `throughput evidence batches[${index}]`);
        if (ref.path !== `batches/${batchDirectoryName(index)}/batch.json`) {
            throw new Error(`throughput evidence batch ${index} path is not canonical`);
        }
    });
    requirePositiveFinite(value.totalElapsedMs, "throughput evidence totalElapsedMs");
    requirePositiveFinite(value.minimumBatchGamesPerWorkerHour, "throughput evidence minimumBatchGamesPerWorkerHour");
    requireSelfHash(value, "evidenceSha256", "throughput evidence");
    return value as unknown as IV07AlignedV2ThroughputEvidenceManifest;
}

function assertExactInventory(directory: string, expected: readonly string[], label: string): void {
    if (canonicalV07AlignedV2Json(readdirSync(directory).sort()) !== canonicalV07AlignedV2Json([...expected].sort())) {
        throw new Error(`${label} inventory is not exact`);
    }
}

function expectedBatchShards(
    request: IV07AlignedV2ThroughputRequest,
    plan: IV07AlignedV2InjectedSeedPlan,
    binding: IV07AlignedV2CandidateBinding,
): IV07AlignedV2CheckpointShardSpec[] {
    return buildV07AlignedV2CheckpointShardSpecs({
        runFingerprint: request.runFingerprint,
        seedPlan: plan,
        binding,
        maxScenarioPairsPerShard: request.geometry.maxScenarioPairsPerShard,
    });
}

export function replayV07AlignedV2ThroughputEvidence(
    requestedRoot: string,
    expectedEvidenceSha256?: string,
    dependencies: IV07AlignedV2ThroughputReplayDependencies = {},
): IV07AlignedV2ThroughputReplay {
    if (
        !existsSync(requestedRoot) ||
        lstatSync(requestedRoot).isSymbolicLink() ||
        !lstatSync(requestedRoot).isDirectory()
    ) {
        throw new Error("throughput evidence root must be a regular non-symlink directory");
    }
    const root = realpathSync(requestedRoot);
    assertExactInventory(root, ROOT_INVENTORY, "throughput evidence root");
    const evidenceBytes = readFileSync(resolveSafeEntry(root, "evidence.json", "throughput evidence manifest", "file"));
    const evidence = validateEvidenceManifest(
        parseCanonicalBytes<unknown>(evidenceBytes, "throughput evidence manifest"),
    );
    if (expectedEvidenceSha256 !== undefined) {
        requireSha256(expectedEvidenceSha256, "expected throughput evidence SHA-256");
        if (evidence.evidenceSha256 !== expectedEvidenceSha256) {
            throw new Error("throughput evidence semantic hash does not match its launch attestation");
        }
    }
    const sourceBytes = readFileSync(
        resolveSafeEntry(root, evidence.sourceManifest.path, "throughput evidence source manifest", "file"),
    );
    if (sha256(sourceBytes) !== evidence.sourceManifest.bytesSha256) {
        throw new Error("throughput evidence source manifest raw bytes changed");
    }
    const plan = readArtifact(root, evidence.plan, "throughput evidence plan") as IV07AlignedV2InjectedSeedPlan;
    const receipt = validateV07AlignedV2ThroughputSeedReceipt(
        readArtifact(root, evidence.receipt, "throughput evidence receipt"),
        sourceBytes,
        plan,
    );
    const request = validateV07AlignedV2ThroughputRequest(
        readArtifact(root, evidence.request, "throughput evidence request"),
        receipt,
        plan,
    );
    const batchesRoot = resolveSafeEntry(root, "batches", "throughput batches", "directory");
    const batchNames = Array.from({ length: V07_ALIGNED_V2_THROUGHPUT_BATCHES }, (_, index) =>
        batchDirectoryName(index),
    );
    assertExactInventory(batchesRoot, batchNames, "throughput batches");
    const binding = bindV07AlignedV2Candidate(buildV07AlignedV2ThroughputWorstCostGenome());
    const loadShard = dependencies.loadShard ?? loadV07AlignedV2PersistedShard;
    const batches = evidence.batches.map((batchRef, batchIndex) => {
        const batchDirectory = resolveSafeEntry(
            root,
            `batches/${batchDirectoryName(batchIndex)}`,
            `throughput batch ${batchIndex}`,
            "directory",
        );
        assertExactInventory(batchDirectory, ["batch.json", "plan.json", "shards"], `throughput batch ${batchIndex}`);
        const batchPlanRef = artifactRef(
            `batches/${batchDirectoryName(batchIndex)}/plan.json`,
            buildV07AlignedV2ThroughputBatchPlan(plan, batchIndex),
        );
        const batchPlan = readArtifact(
            root,
            batchPlanRef,
            `throughput batch ${batchIndex} plan`,
        ) as IV07AlignedV2InjectedSeedPlan;
        const expectedPlan = buildV07AlignedV2ThroughputBatchPlan(plan, batchIndex);
        if (canonicalV07AlignedV2Json(batchPlan) !== canonicalV07AlignedV2Json(expectedPlan)) {
            throw new Error(`throughput batch ${batchIndex} plan is not the balanced deterministic partition`);
        }
        const batch = validateBatchManifest(
            readArtifact(root, batchRef, `throughput batch ${batchIndex} manifest`),
            request,
            batchIndex,
            batchPlanRef,
        );
        const shards = expectedBatchShards(request, batchPlan, binding);
        const shardsRoot = resolveSafeEntry(
            root,
            `batches/${batchDirectoryName(batchIndex)}/shards`,
            `throughput batch ${batchIndex} shards`,
            "directory",
        );
        const expectedDirectories = shards.map(v07AlignedV2ShardArtifactDirectoryName);
        assertExactInventory(shardsRoot, expectedDirectories, `throughput batch ${batchIndex} shards`);
        if (batch.shards.length !== shards.length)
            throw new Error(`throughput batch ${batchIndex} shard census changed`);
        let games = 0;
        let attestations = 0;
        shards.forEach((shard, shardIndex) => {
            const ref = batch.shards[shardIndex];
            const expectedDirectory = `batches/${batchDirectoryName(batchIndex)}/shards/${v07AlignedV2ShardArtifactDirectoryName(shard)}`;
            if (ref.directory !== expectedDirectory)
                throw new Error(`throughput batch ${batchIndex} shard path changed`);
            const persisted = loadShard(
                resolveSafeEntry(root, ref.directory, `throughput shard ${batchIndex}/${shardIndex}`, "directory"),
                {
                    shard,
                    binding,
                    seedPlan: batchPlan,
                    manifestSha256: ref.manifestSha256,
                },
            );
            const shardGames = persisted.evaluation.records.length;
            const shardAttestations = persisted.evaluation.attestations.length;
            const expectedGames = (shard.pairEndExclusive - shard.pairStart) * 2;
            const expectedAttestations = Math.min(request.geometry.workersPerShard, expectedGames);
            if (
                expectedAttestations !== request.geometry.workersPerShard ||
                shardGames !== expectedGames ||
                ref.games !== expectedGames ||
                shardAttestations !== expectedAttestations ||
                ref.workerAttestations !== expectedAttestations ||
                persisted.manifestSha256 !== ref.manifestSha256
            ) {
                throw new Error(`throughput batch ${batchIndex} shard ${shardIndex} evidence census changed`);
            }
            games += shardGames;
            attestations += shardAttestations;
        });
        if (games !== batch.games || attestations !== batch.workerAttestations) {
            throw new Error(`throughput batch ${batchIndex} replay census changed`);
        }
        return batch;
    });
    const totalElapsedMs = batches.reduce((sum, batch) => sum + batch.elapsedMs, 0);
    const minimumRate = Math.min(...batches.map((batch) => batch.gamesPerWorkerHour));
    if (
        batches.some((batch, index) => index > 0 && batch.startedAtMs < batches[index - 1].endedAtMs) ||
        evidence.totalElapsedMs !== totalElapsedMs ||
        evidence.minimumBatchGamesPerWorkerHour !== minimumRate ||
        batches.reduce((sum, batch) => sum + batch.games, 0) !== V07_ALIGNED_V2_THROUGHPUT_GAMES
    ) {
        throw new Error("throughput evidence summary is not the exact minimum of eight complete batches");
    }
    return { rootDirectory: root, receipt, plan, request, batches, evidence };
}

async function mapConcurrentSettled<T, R>(
    values: readonly T[],
    concurrency: number,
    operation: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
    const results = new Array<R>(values.length);
    const failures: unknown[] = [];
    let cursor = 0;
    const lanes = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
        while (cursor < values.length && failures.length === 0) {
            const index = cursor++;
            try {
                results[index] = await operation(values[index], index);
            } catch (error) {
                failures.push(error);
            }
        }
    });
    await Promise.allSettled(lanes);
    if (failures.length > 0) throw failures[0];
    return results;
}

export async function runV07AlignedV2ThroughputEvidence(
    options: IV07AlignedV2ThroughputRunOptions,
): Promise<IV07AlignedV2ThroughputReplay> {
    const geometry = validateGeometry(options.geometry, true);
    const { receipt, plan } = buildV07AlignedV2ThroughputSeedReceipt(options.sourceManifestBytes);
    const request = buildV07AlignedV2ThroughputRequest({ geometry, provenance: options.provenance, receipt, plan });
    const root = ensureFreshDirectory(options.rootDirectory);
    const batchesRoot = join(root, "batches");
    ensureDirectory(batchesRoot);
    writeExclusive(join(root, "source-manifest.json"), options.sourceManifestBytes);
    writeCanonical(join(root, "receipt.json"), receipt);
    writeCanonical(join(root, "plan.json"), plan);
    writeCanonical(join(root, "request.json"), request);
    const binding = bindV07AlignedV2Candidate(buildV07AlignedV2ThroughputWorstCostGenome());
    const monotonicMs = (): number => Number(process.hrtime.bigint()) / 1_000_000;
    const batchManifests: IV07AlignedV2ThroughputBatchManifest[] = [];
    try {
        for (let batchIndex = 0; batchIndex < V07_ALIGNED_V2_THROUGHPUT_BATCHES; batchIndex += 1) {
            const directoryName = batchDirectoryName(batchIndex);
            const batchDirectory = join(batchesRoot, directoryName);
            const shardsDirectory = join(batchDirectory, "shards");
            ensureDirectory(batchDirectory);
            ensureDirectory(shardsDirectory);
            const batchPlan = buildV07AlignedV2ThroughputBatchPlan(plan, batchIndex);
            const batchPlanPath = `batches/${directoryName}/plan.json`;
            const batchPlanRef = artifactRef(batchPlanPath, batchPlan);
            writeCanonical(join(batchDirectory, "plan.json"), batchPlan);
            const shards = expectedBatchShards(request, batchPlan, binding);
            if (shards.length < geometry.concurrentShards) {
                throw new Error(`throughput batch ${batchIndex} has fewer shards than production concurrency`);
            }
            const auditRoot = join(dirname(root), `.aligned-v2-throughput-audits-${process.pid}-${randomUUID()}`);
            ensureFreshDirectory(auditRoot);
            const startedAtMs = Date.now();
            const startedMonotonicMs = monotonicMs();
            let persisted: IV07AlignedV2PersistedShard[];
            try {
                persisted = await mapConcurrentSettled(shards, geometry.concurrentShards, async (shard) => {
                    const auditDirectory = join(auditRoot, `shard-${shard.shardIndex}-${randomUUID()}`);
                    const evaluation = await evaluateV07AlignedV2Shard({
                        shard,
                        seedPlan: batchPlan,
                        binding,
                        workers: geometry.workersPerShard,
                        auditDirectory,
                        sourceEnvironment: process.env,
                        deadlineAtMs: Date.now() + geometry.shardTimeoutMinutes * 60_000,
                    });
                    const durable = persistV07AlignedV2ShardEvaluation(shardsDirectory, evaluation, batchPlan);
                    return loadV07AlignedV2PersistedShard(durable.directory, {
                        shard,
                        binding,
                        seedPlan: batchPlan,
                        manifestSha256: durable.manifestSha256,
                    });
                });
            } finally {
                rmSync(auditRoot, { recursive: true, force: true });
            }
            const elapsedMs = monotonicMs() - startedMonotonicMs;
            const endedAtMs = Date.now();
            requirePositiveFinite(elapsedMs, `throughput batch ${batchIndex} measured elapsedMs`);
            const shardRefs = persisted.map((entry): IV07AlignedV2ThroughputShardRef => ({
                directory: relative(root, entry.directory).split(sep).join("/"),
                manifestSha256: entry.manifestSha256,
                games: entry.evaluation.records.length,
                workerAttestations: entry.evaluation.attestations.length,
            }));
            const workerAttestations = shardRefs.reduce((sum, entry) => sum + entry.workerAttestations, 0);
            const gamesPerWorkerHour =
                (V07_ALIGNED_V2_THROUGHPUT_GAMES_PER_BATCH * HOUR_MS) /
                (elapsedMs * geometry.workersPerShard * geometry.concurrentShards);
            const unsigned = {
                schemaVersion: 1 as const,
                artifactKind: "v0_7_aligned_96h_v2_throughput_batch" as const,
                status: "research_only_no_bake" as const,
                automaticBake: false as const,
                automaticDeploy: false as const,
                batchIndex,
                requestSha256: request.requestSha256,
                runFingerprint: request.runFingerprint,
                plan: batchPlanRef,
                startedAtMs,
                endedAtMs,
                elapsedMs,
                games: V07_ALIGNED_V2_THROUGHPUT_GAMES_PER_BATCH,
                workerAttestations,
                shards: shardRefs,
                gamesPerWorkerHour,
            };
            const batch = { ...unsigned, batchSha256: fingerprintV07AlignedV2(unsigned) };
            validateBatchManifest(batch, request, batchIndex, batchPlanRef);
            writeCanonical(join(batchDirectory, "batch.json"), batch);
            batchManifests.push(batch);
        }
        const batchRefs = batchManifests.map((batch, index) =>
            artifactRef(`batches/${batchDirectoryName(index)}/batch.json`, batch),
        );
        const unsignedEvidence = {
            schemaVersion: 1 as const,
            artifactKind: "v0_7_aligned_96h_v2_throughput_evidence" as const,
            status: "research_only_no_bake" as const,
            automaticBake: false as const,
            automaticDeploy: false as const,
            sourceManifest: {
                path: "source-manifest.json" as const,
                bytesSha256: V07_ALIGNED_V2_THROUGHPUT_SOURCE_MANIFEST_BYTES_SHA256,
            },
            receipt: artifactRef("receipt.json", receipt),
            plan: artifactRef("plan.json", plan),
            request: artifactRef("request.json", request),
            batches: batchRefs,
            sampleGames: V07_ALIGNED_V2_THROUGHPUT_GAMES,
            sampleGamesPerCellSeat: V07_ALIGNED_V2_THROUGHPUT_SCENARIOS_PER_CELL,
            totalElapsedMs: batchManifests.reduce((sum, batch) => sum + batch.elapsedMs, 0),
            minimumBatchGamesPerWorkerHour: Math.min(...batchManifests.map((batch) => batch.gamesPerWorkerHour)),
            persistedReplayVerified: true as const,
            workerAttestationsVerified: true as const,
        };
        const evidence = { ...unsignedEvidence, evidenceSha256: fingerprintV07AlignedV2(unsignedEvidence) };
        validateEvidenceManifest(evidence);
        writeCanonical(join(root, "evidence.json"), evidence);
        return replayV07AlignedV2ThroughputEvidence(root, evidence.evidenceSha256);
    } catch (error) {
        throw new Error(
            `throughput evidence run failed closed with partial artifacts retained at ${root}: ${String(error)}`,
        );
    }
}

export function buildV07AlignedV2ProductionThroughputAttestation(options: {
    replay: IV07AlignedV2ThroughputReplay;
    evidenceRootPath: string;
}): IV07AlignedV2ProductionThroughputAttestation {
    validateSafeRelativePath(options.evidenceRootPath, "throughput attestation evidenceRootPath");
    const { replay } = options;
    const { request, evidence, batches } = replay;
    const evidenceBytes = readFileSync(join(replay.rootDirectory, "evidence.json"));
    if (
        sha256(evidenceBytes) !== sha256(canonicalFile(evidence)) ||
        evidence.evidenceSha256 !==
            fingerprintV07AlignedV2(unsignedSelfHash(evidence as unknown as Record<string, unknown>, "evidenceSha256"))
    ) {
        throw new Error("throughput attestation requires a freshly replayed canonical evidence manifest");
    }
    const provenance = request.provenance;
    const geometry = request.geometry;
    const code = request.code;
    const unsigned = {
        schemaVersion: 2 as const,
        artifactKind: "v0_7_aligned_96h_v2_throughput_attestation" as const,
        status: "research_only_no_bake" as const,
        automaticBake: false as const,
        automaticDeploy: false as const,
        measuredAtMs: Math.max(...batches.map((batch) => batch.endedAtMs)),
        commit: provenance.commit,
        sourceTreeSha256: provenance.sourceTreeSha256,
        bunVersion: provenance.bunVersion,
        bunRevision: provenance.bunRevision,
        bunExecutableSha256: provenance.bunExecutableSha256,
        dependencyManifestSha256: provenance.dependencyManifestSha256,
        lockfileSha256: provenance.lockfileSha256,
        hostFingerprintSha256: provenance.hostFingerprintSha256,
        logicalCpus: geometry.logicalCpus,
        reservedCpus: geometry.reservedCpus,
        workersPerShard: geometry.workersPerShard,
        concurrentShards: geometry.concurrentShards,
        maxScenarioPairsPerShard: geometry.maxScenarioPairsPerShard,
        shardTimeoutMinutes: geometry.shardTimeoutMinutes,
        sampleProtocol: "all_12_cells_two_seats_8_sequential_batches_persisted_replay" as const,
        sampleGamesPerCellSeat: V07_ALIGNED_V2_THROUGHPUT_SCENARIOS_PER_CELL,
        sampleGames: V07_ALIGNED_V2_THROUGHPUT_GAMES,
        batchCount: V07_ALIGNED_V2_THROUGHPUT_BATCHES,
        totalElapsedMs: evidence.totalElapsedMs,
        persistedReplayVerified: true as const,
        workerAttestationsVerified: true as const,
        gamesPerWorkerHour: evidence.minimumBatchGamesPerWorkerHour,
        evidenceRootPath: options.evidenceRootPath,
        evidenceManifestBytesSha256: sha256(evidenceBytes),
        evidenceManifestSha256: evidence.evidenceSha256,
        ...code,
    };
    return { ...unsigned, attestationSha256: fingerprintV07AlignedV2(unsigned) };
}

export function validateV07AlignedV2ProductionThroughputAttestation(
    value: unknown,
    options: {
        configRoot: string;
        expected: IV07AlignedV2ProductionThroughputExpectation;
        expectedAttestationSha256?: string;
        replayDependencies?: IV07AlignedV2ThroughputReplayDependencies;
    },
): { attestation: IV07AlignedV2ProductionThroughputAttestation; replay: IV07AlignedV2ThroughputReplay } {
    if (!isObject(value)) throw new Error("production throughput attestation must be an object");
    const keys = [
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
        "reservedCpus",
        "workersPerShard",
        "concurrentShards",
        "maxScenarioPairsPerShard",
        "shardTimeoutMinutes",
        "sampleProtocol",
        "sampleGamesPerCellSeat",
        "sampleGames",
        "batchCount",
        "totalElapsedMs",
        "persistedReplayVerified",
        "workerAttestationsVerified",
        "gamesPerWorkerHour",
        "evidenceRootPath",
        "evidenceManifestBytesSha256",
        "evidenceManifestSha256",
        "throughputBytesSha256",
        "runnerBytesSha256",
        "evaluatorBytesSha256",
        "workerBytesSha256",
        "gameAdapterBytesSha256",
        "persistenceBytesSha256",
        "protocolBytesSha256",
        "seedAllocatorBytesSha256",
        "catalogBytesSha256",
        "attestationSha256",
    ];
    if (
        !exactKeys(value, keys) ||
        value.schemaVersion !== 2 ||
        value.artifactKind !== "v0_7_aligned_96h_v2_throughput_attestation" ||
        value.status !== "research_only_no_bake" ||
        value.automaticBake !== false ||
        value.automaticDeploy !== false ||
        value.sampleProtocol !== "all_12_cells_two_seats_8_sequential_batches_persisted_replay" ||
        value.sampleGamesPerCellSeat !== V07_ALIGNED_V2_THROUGHPUT_SCENARIOS_PER_CELL ||
        value.sampleGames !== V07_ALIGNED_V2_THROUGHPUT_GAMES ||
        value.batchCount !== V07_ALIGNED_V2_THROUGHPUT_BATCHES ||
        value.persistedReplayVerified !== true ||
        value.workerAttestationsVerified !== true ||
        typeof value.commit !== "string" ||
        !COMMIT_PATTERN.test(value.commit) ||
        typeof value.bunVersion !== "string" ||
        !value.bunVersion ||
        typeof value.bunRevision !== "string" ||
        !value.bunRevision
    ) {
        throw new Error("production throughput attestation header/fields are invalid");
    }
    requireInteger(value.measuredAtMs, "production throughput measuredAtMs");
    requirePositiveFinite(value.totalElapsedMs, "production throughput totalElapsedMs");
    requirePositiveFinite(value.gamesPerWorkerHour, "production throughput gamesPerWorkerHour");
    const geometry = validateGeometry(
        {
            logicalCpus: value.logicalCpus,
            reservedCpus: value.reservedCpus,
            workersPerShard: value.workersPerShard,
            concurrentShards: value.concurrentShards,
            maxScenarioPairsPerShard: value.maxScenarioPairsPerShard,
            shardTimeoutMinutes: value.shardTimeoutMinutes,
        },
        true,
    );
    const expectedGeometry = validateGeometry(
        {
            logicalCpus: options.expected.logicalCpus,
            reservedCpus: options.expected.reservedCpus,
            workersPerShard: options.expected.workersPerShard,
            concurrentShards: options.expected.concurrentShards,
            maxScenarioPairsPerShard: options.expected.maxScenarioPairsPerShard,
            shardTimeoutMinutes: options.expected.shardTimeoutMinutes,
        },
        true,
    );
    requirePositiveFinite(options.expected.gamesPerWorkerHour, "expected throughput gamesPerWorkerHour");
    if (
        canonicalV07AlignedV2Json(geometry) !== canonicalV07AlignedV2Json(expectedGeometry) ||
        value.gamesPerWorkerHour !== options.expected.gamesPerWorkerHour
    ) {
        throw new Error("production throughput attestation does not match the runner's exact geometry and rate");
    }
    for (const key of [
        "sourceTreeSha256",
        "bunExecutableSha256",
        "dependencyManifestSha256",
        "hostFingerprintSha256",
        "evidenceManifestBytesSha256",
        "evidenceManifestSha256",
        "throughputBytesSha256",
        "runnerBytesSha256",
        "evaluatorBytesSha256",
        "workerBytesSha256",
        "gameAdapterBytesSha256",
        "persistenceBytesSha256",
        "protocolBytesSha256",
        "seedAllocatorBytesSha256",
        "catalogBytesSha256",
        "attestationSha256",
    ] as const) {
        requireSha256(value[key], `production throughput ${key}`);
    }
    if (value.lockfileSha256 !== null) requireSha256(value.lockfileSha256, "production throughput lockfileSha256");
    requireSelfHash(value, "attestationSha256", "production throughput attestation");
    if (
        options.expectedAttestationSha256 !== undefined &&
        value.attestationSha256 !== options.expectedAttestationSha256
    ) {
        throw new Error("production throughput attestation semantic hash changed");
    }
    if (value.hostFingerprintSha256 !== currentHostFingerprintSha256()) {
        throw new Error("production throughput attestation was not measured on this exact host");
    }
    const configRoot = realpathSync(options.configRoot);
    const evidenceRoot = resolveSafeEntry(
        configRoot,
        validateSafeRelativePath(value.evidenceRootPath, "production throughput evidenceRootPath"),
        "production throughput evidence root",
        "directory",
    );
    const evidenceBytes = readFileSync(
        resolveSafeEntry(evidenceRoot, "evidence.json", "production throughput evidence", "file"),
    );
    if (sha256(evidenceBytes) !== value.evidenceManifestBytesSha256) {
        throw new Error("production throughput evidence manifest raw bytes changed");
    }
    const replay = replayV07AlignedV2ThroughputEvidence(
        evidenceRoot,
        value.evidenceManifestSha256 as string,
        options.replayDependencies,
    );
    const rebuilt = buildV07AlignedV2ProductionThroughputAttestation({
        replay,
        evidenceRootPath: value.evidenceRootPath as string,
    });
    if (canonicalV07AlignedV2Json(value) !== canonicalV07AlignedV2Json(rebuilt)) {
        throw new Error("production throughput attestation does not exactly summarize its replayed evidence root");
    }
    return {
        attestation: value as unknown as IV07AlignedV2ProductionThroughputAttestation,
        replay,
    };
}

function requiredCliInteger(value: string | undefined, label: string, minimum: number): number {
    if (value === undefined || !/^(?:0|[1-9]\d*)$/.test(value)) throw new Error(`${label} is required as an integer`);
    const parsed = Number(value);
    requireInteger(parsed, label, minimum);
    return parsed;
}

function requiredCliFinite(value: string | undefined, label: string): number {
    if (value === undefined || !value.trim()) throw new Error(`${label} is required`);
    const parsed = Number(value);
    requirePositiveFinite(parsed, label);
    return parsed;
}

export async function mainV07AlignedV2Throughput(argv = process.argv.slice(2)): Promise<void> {
    const { values } = parseArgs({
        args: argv,
        strict: true,
        allowPositionals: false,
        options: {
            out: { type: "string" },
            attestation: { type: "string" },
            "source-manifest": { type: "string" },
            "reserved-cpus": { type: "string" },
            "workers-per-shard": { type: "string" },
            "concurrent-shards": { type: "string" },
            "max-scenario-pairs-per-shard": { type: "string" },
            "shard-timeout-minutes": { type: "string" },
        },
    });
    if (!values.out || !values.attestation) throw new Error("--out and --attestation are required");
    const repositoryRoot = realpathSync(resolve(import.meta.dir, "../../.."));
    const output = resolve(repositoryRoot, values.out);
    const attestationPath = resolve(repositoryRoot, values.attestation);
    const sourceManifestPath = resolve(
        repositoryRoot,
        values["source-manifest"] ?? V07_ALIGNED_V2_THROUGHPUT_SOURCE_MANIFEST,
    );
    const outputRelative = relative(repositoryRoot, output);
    const attestationRelative = relative(repositoryRoot, attestationPath);
    if (
        (!outputRelative.startsWith(`..${sep}`) && outputRelative !== "..") ||
        (!attestationRelative.startsWith(`..${sep}`) && attestationRelative !== "..")
    ) {
        throw new Error("throughput evidence and attestation outputs must be external to the repository");
    }
    if (existsSync(attestationPath)) throw new Error("throughput attestation output must not already exist");
    const configRoot = realpathSync(dirname(attestationPath));
    const evidenceRootPath = relativeBelow(configRoot, output, "throughput evidence root path");
    if (
        !existsSync(sourceManifestPath) ||
        lstatSync(sourceManifestPath).isSymbolicLink() ||
        !lstatSync(sourceManifestPath).isFile()
    ) {
        throw new Error("throughput source manifest must be a regular non-symlink file");
    }
    const supervisor = await import("./v0_7_aligned_96h_v2_supervisor");
    const captured = supervisor.captureV07AlignedV2SupervisorProvenance(repositoryRoot);
    const provenance: IV07AlignedV2ThroughputProvenance = {
        commit: captured.commit,
        sourceTreeSha256: captured.sourceTreeSha256,
        bunVersion: captured.bunVersion,
        bunRevision: captured.bunRevision,
        bunExecutableSha256: captured.bunExecutableSha256,
        dependencyManifestSha256: captured.dependencyManifestSha256,
        lockfileSha256: captured.lockfileSha256,
        hostFingerprintSha256: currentHostFingerprintSha256(),
    };
    const geometry: IV07AlignedV2ThroughputGeometry = {
        logicalCpus: availableParallelism(),
        reservedCpus: requiredCliInteger(values["reserved-cpus"], "--reserved-cpus", 0),
        workersPerShard: requiredCliInteger(values["workers-per-shard"], "--workers-per-shard", 1),
        concurrentShards: requiredCliInteger(values["concurrent-shards"], "--concurrent-shards", 1),
        maxScenarioPairsPerShard: requiredCliInteger(
            values["max-scenario-pairs-per-shard"],
            "--max-scenario-pairs-per-shard",
            1,
        ),
        shardTimeoutMinutes: requiredCliFinite(values["shard-timeout-minutes"], "--shard-timeout-minutes"),
    };
    validateGeometry(geometry, true);
    const replay = await runV07AlignedV2ThroughputEvidence({
        rootDirectory: output,
        sourceManifestBytes: readFileSync(sourceManifestPath),
        geometry,
        provenance,
    });
    const attestation = buildV07AlignedV2ProductionThroughputAttestation({ replay, evidenceRootPath });
    validateV07AlignedV2ProductionThroughputAttestation(attestation, {
        configRoot,
        expected: { ...geometry, gamesPerWorkerHour: attestation.gamesPerWorkerHour },
        expectedAttestationSha256: attestation.attestationSha256,
    });
    writeExclusive(attestationPath, canonicalFile(attestation));
    process.stdout.write(`${canonicalV07AlignedV2Json(attestation)}\n`);
}

if (import.meta.main) await mainV07AlignedV2Throughput();
