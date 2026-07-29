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

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, type PathLike } from "node:fs";
import { dirname, resolve } from "node:path";

import {
    fingerprintV09,
    V09_FEATURE_FINGERPRINTS,
    V09_FEATURE_SCHEMA,
    V09_FULL_FEATURE_NAMES,
    V09_IL_SCHEMA,
    V09_MODEL_SCHEMA,
    V09_TEACHER_SCHEDULE,
    V09_TEACHER_SCHEDULE_SHA256,
} from "./protocol";

export const V09_CAMPAIGN_SCHEMA = "hoc.ai.v0_9_campaign.v1" as const;
export const V09_SEED_LEDGER_SCHEMA = "hoc.ai.v0_9_seed_ledger.v1" as const;
export const V09_CHECKPOINT_SCHEMA = "hoc.ai.v0_9_campaign_checkpoint.v1" as const;
export const V09_CAMPAIGN_HOURS = 168;
export const V09_RTX5090_GPU_UUID = "GPU-5126d018-ec86-be8b-1bf5-b5ac323d3350" as const;
export const V09_ACTOR_LANE_EVIDENCE_FILE = "actor-lane-benchmark.json" as const;

export const V09_CAMPAIGN_STAGES = [
    "preflight",
    "wide_teacher",
    "initial_fit",
    "dagger_1",
    "dagger_2",
    "quantize",
    "confirmation",
    "qualification",
    "complete",
] as const;

export type V09CampaignStage = (typeof V09_CAMPAIGN_STAGES)[number];

export const V09_DEFAULT_SEED_COUNTS = Object.freeze({
    wide_teacher_train: 21_504,
    wide_teacher_validation: 3_072,
    dagger_1_train: 7_168,
    dagger_1_validation: 1_024,
    dagger_2_train: 7_168,
    dagger_2_validation: 1_024,
    confirmation: 48_000,
    qualification: 48_000,
});

export type V09SeedPurpose = keyof typeof V09_DEFAULT_SEED_COUNTS;

export interface IV09SeedStream {
    purpose: V09SeedPurpose;
    material: string;
    count: number;
    seeds: number[];
    seedsSha256: string;
}

export interface IV09SeedLedger {
    schema: typeof V09_SEED_LEDGER_SCHEMA;
    runFingerprint: string;
    streams: IV09SeedStream[];
    reservedSeedCount: number;
    totalAllocated: number;
    ledgerSha256: string;
}

export interface IV09CampaignIdentity {
    sourceCommit: string;
    sourceStatusSha256: string;
    sourceDirty: false;
    rulesFingerprint: string;
    rosterFingerprint: string;
    anchorVersion: "v0.8";
    anchorFingerprint: string;
    gpuUuid: string;
}

export interface IV09DevelopmentActorLaneSelection {
    kind: "development_fixture";
    benchmarkReceiptSha256: null;
    benchmarkSourceReceiptSha256: null;
    topologySha256: null;
    benchmarkPhysicalCoreCount: 24;
    selectedPhysicalCpuIds: number[];
}

export interface IV09AuditedActorLaneSelection {
    kind: "audited_benchmark";
    benchmarkReceiptSha256: string;
    benchmarkSourceReceiptSha256: string;
    topologySha256: string;
    benchmarkPhysicalCoreCount: number;
    selectedPhysicalCpuIds: number[];
}

export type IV09ActorLaneSelection = IV09DevelopmentActorLaneSelection | IV09AuditedActorLaneSelection;

export interface IV09ActorPhysicalCorePolicy {
    smoke: 4;
    target: number;
    reserveForOsAndLearner: number;
    selection: IV09ActorLaneSelection;
}

export function buildV09DevelopmentActorPhysicalCorePolicy(): IV09ActorPhysicalCorePolicy {
    return {
        smoke: 4,
        target: 20,
        reserveForOsAndLearner: 4,
        selection: {
            kind: "development_fixture",
            benchmarkReceiptSha256: null,
            benchmarkSourceReceiptSha256: null,
            topologySha256: null,
            benchmarkPhysicalCoreCount: 24,
            selectedPhysicalCpuIds: [],
        },
    };
}

export function buildV09AuditedActorPhysicalCorePolicy(binding: {
    benchmarkReceiptSha256: string;
    benchmarkSourceReceiptSha256: string;
    topologySha256: string;
    benchmarkPhysicalCoreCount: number;
    selectedWorkers: number;
    selectedPhysicalCpuIds: readonly number[];
}): IV09ActorPhysicalCorePolicy {
    return {
        smoke: 4,
        target: binding.selectedWorkers,
        reserveForOsAndLearner: binding.benchmarkPhysicalCoreCount - binding.selectedWorkers,
        selection: {
            kind: "audited_benchmark",
            benchmarkReceiptSha256: binding.benchmarkReceiptSha256,
            benchmarkSourceReceiptSha256: binding.benchmarkSourceReceiptSha256,
            topologySha256: binding.topologySha256,
            benchmarkPhysicalCoreCount: binding.benchmarkPhysicalCoreCount,
            selectedPhysicalCpuIds: [...binding.selectedPhysicalCpuIds],
        },
    };
}

export interface IV09CampaignManifest {
    schema: typeof V09_CAMPAIGN_SCHEMA;
    runFingerprint: string;
    promoted: false;
    durationHours: typeof V09_CAMPAIGN_HOURS;
    outputDirectory: string;
    identity: IV09CampaignIdentity;
    schemas: {
        il: typeof V09_IL_SCHEMA;
        features: typeof V09_FEATURE_SCHEMA;
        model: typeof V09_MODEL_SCHEMA;
    };
    featureFingerprints: typeof V09_FEATURE_FINGERPRINTS;
    teacherSchedule: typeof V09_TEACHER_SCHEDULE;
    teacherScheduleSha256: typeof V09_TEACHER_SCHEDULE_SHA256;
    seedLedgerSha256: string;
    resourcePolicy: {
        gpuRole: "learner_only";
        gpuUuid: string;
        v09ActorPhysicalCores: IV09ActorPhysicalCorePolicy;
        v09Nice: 10;
        v08Priority: "unchanged_separate_hosts";
    };
    schedule: ReadonlyArray<{
        stage: V09CampaignStage;
        startsAtHour: number;
        endsAtHour: number;
    }>;
    manifestSha256: string;
}

export interface IV09CampaignCheckpoint {
    schema: typeof V09_CHECKPOINT_SCHEMA;
    runFingerprint: string;
    manifestSha256: string;
    stage: V09CampaignStage;
    completedUnits: number;
    expectedUnits: number;
    artifacts: Record<string, string>;
    updatedAt: string;
    checkpointSha256: string;
}

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_COMMIT = /^[0-9a-f]{7,64}$/;
const GPU_UUID = /^GPU-[0-9a-f-]+$/i;
const V09_AUDITED_ACTOR_TARGETS = [20, 22, 23, 24] as const;

function requireSha(value: string, context: string): string {
    const normalized = value.toLowerCase();
    if (!SHA256.test(normalized)) throw new Error(`${context} must be a lowercase SHA-256`);
    return normalized;
}

function requireGitCommit(value: string, context: string): string {
    const normalized = value.toLowerCase();
    if (!GIT_COMMIT.test(normalized)) throw new Error(`${context} must be a lowercase Git commit`);
    return normalized;
}

function validateV09ActorPhysicalCorePolicy(value: IV09ActorPhysicalCorePolicy): void {
    if (
        !value ||
        typeof value !== "object" ||
        value.smoke !== 4 ||
        !Number.isSafeInteger(value.target) ||
        value.target < value.smoke ||
        !Number.isSafeInteger(value.reserveForOsAndLearner) ||
        value.reserveForOsAndLearner < 0 ||
        !value.selection ||
        typeof value.selection !== "object"
    ) {
        throw new Error("v0.9 actor physical-core policy is malformed");
    }
    const selection = value.selection;
    if (selection.kind === "development_fixture") {
        if (
            value.target !== 20 ||
            value.reserveForOsAndLearner !== 4 ||
            selection.benchmarkReceiptSha256 !== null ||
            selection.benchmarkSourceReceiptSha256 !== null ||
            selection.topologySha256 !== null ||
            selection.benchmarkPhysicalCoreCount !== 24 ||
            !Array.isArray(selection.selectedPhysicalCpuIds) ||
            selection.selectedPhysicalCpuIds.length !== 0
        ) {
            throw new Error("v0.9 development actor policy must use the explicit safe 20+4 fixture");
        }
        return;
    }
    if (selection.kind !== "audited_benchmark") {
        throw new Error("v0.9 actor physical-core selection kind is invalid");
    }
    requireSha(selection.benchmarkReceiptSha256, "actor benchmark receipt");
    requireSha(selection.benchmarkSourceReceiptSha256, "actor benchmark source receipt");
    requireSha(selection.topologySha256, "actor benchmark topology");
    if (
        !(V09_AUDITED_ACTOR_TARGETS as readonly number[]).includes(value.target) ||
        !Number.isSafeInteger(selection.benchmarkPhysicalCoreCount) ||
        selection.benchmarkPhysicalCoreCount < 24 ||
        value.reserveForOsAndLearner !== selection.benchmarkPhysicalCoreCount - value.target ||
        !Array.isArray(selection.selectedPhysicalCpuIds) ||
        selection.selectedPhysicalCpuIds.length !== value.target ||
        selection.selectedPhysicalCpuIds.some((cpu) => !Number.isSafeInteger(cpu) || cpu < 0) ||
        new Set(selection.selectedPhysicalCpuIds).size !== selection.selectedPhysicalCpuIds.length
    ) {
        throw new Error("v0.9 audited actor physical-core policy is inconsistent");
    }
}

function atomicJson(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, path);
}

function uint32(material: string): number {
    const digest = createHash("sha256").update(material).digest();
    return digest.readUInt32LE(0);
}

export function buildV09SeedLedger(
    runFingerprint: string,
    reservedSeeds: Iterable<number> = [],
    counts: Readonly<Record<V09SeedPurpose, number>> = V09_DEFAULT_SEED_COUNTS,
): IV09SeedLedger {
    const fingerprint = requireSha(runFingerprint, "runFingerprint");
    const used = new Set<number>();
    for (const seed of reservedSeeds) {
        if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
            throw new Error(`reserved seed ${seed} is outside uint32`);
        }
        used.add(seed >>> 0);
    }
    const reservedSeedCount = used.size;
    const streams: IV09SeedStream[] = [];
    for (const purpose of Object.keys(V09_DEFAULT_SEED_COUNTS) as V09SeedPurpose[]) {
        const count = counts[purpose];
        if (!Number.isSafeInteger(count) || count < 1) throw new Error(`${purpose} seed count must be positive`);
        const material = `hoc-v0.9|${fingerprint}|${purpose}`;
        const seeds: number[] = [];
        for (let index = 0; index < count; index += 1) {
            let collision = 0;
            let seed = uint32(`${material}|${index}|${collision}`);
            while (used.has(seed)) {
                collision += 1;
                seed = uint32(`${material}|${index}|${collision}`);
            }
            used.add(seed);
            seeds.push(seed);
        }
        streams.push({
            purpose,
            material,
            count,
            seeds,
            seedsSha256: fingerprintV09(seeds),
        });
    }
    const unsigned = {
        schema: V09_SEED_LEDGER_SCHEMA,
        runFingerprint: fingerprint,
        streams,
        reservedSeedCount,
        totalAllocated: streams.reduce((sum, stream) => sum + stream.count, 0),
    };
    return { ...unsigned, ledgerSha256: fingerprintV09(unsigned) };
}

export function validateV09SeedLedger(value: IV09SeedLedger): void {
    const { ledgerSha256, ...unsigned } = value;
    requireSha(value.runFingerprint, "seed ledger runFingerprint");
    if (value.schema !== V09_SEED_LEDGER_SCHEMA || fingerprintV09(unsigned) !== ledgerSha256) {
        throw new Error("v0.9 seed ledger identity mismatch");
    }
    const expectedPurposes = Object.keys(V09_DEFAULT_SEED_COUNTS) as V09SeedPurpose[];
    if (value.streams.length !== expectedPurposes.length) {
        throw new Error("v0.9 seed ledger must contain every purpose exactly once");
    }
    const seen = new Set<number>();
    let total = 0;
    for (const [streamIndex, stream] of value.streams.entries()) {
        const expectedPurpose = expectedPurposes[streamIndex]!;
        if (
            stream.purpose !== expectedPurpose ||
            stream.material !== `hoc-v0.9|${value.runFingerprint}|${expectedPurpose}` ||
            !Number.isSafeInteger(stream.count) ||
            stream.count < 1
        ) {
            throw new Error(`v0.9 seed stream ${streamIndex} purpose/material/count mismatch`);
        }
        if (stream.seeds.length !== stream.count || fingerprintV09(stream.seeds) !== stream.seedsSha256) {
            throw new Error(`v0.9 seed stream ${stream.purpose} failed its fingerprint`);
        }
        for (const seed of stream.seeds) {
            if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff || seen.has(seed)) {
                throw new Error(`v0.9 seed stream ${stream.purpose} contains an invalid or duplicate seed`);
            }
            seen.add(seed);
        }
        total += stream.count;
    }
    if (total !== value.totalAllocated) throw new Error("v0.9 seed ledger total mismatch");
}

const schedule: IV09CampaignManifest["schedule"] = Object.freeze([
    { stage: "preflight", startsAtHour: 0, endsAtHour: 1 },
    { stage: "wide_teacher", startsAtHour: 1, endsAtHour: 24 },
    { stage: "initial_fit", startsAtHour: 24, endsAtHour: 48 },
    { stage: "dagger_1", startsAtHour: 48, endsAtHour: 72 },
    { stage: "dagger_2", startsAtHour: 72, endsAtHour: 96 },
    { stage: "quantize", startsAtHour: 96, endsAtHour: 120 },
    { stage: "confirmation", startsAtHour: 120, endsAtHour: 144 },
    { stage: "qualification", startsAtHour: 144, endsAtHour: 168 },
]);

export function v09CampaignRunFingerprint(identity: IV09CampaignIdentity): string {
    return fingerprintV09({
        schema: V09_CAMPAIGN_SCHEMA,
        identity,
        schemas: {
            il: V09_IL_SCHEMA,
            features: V09_FEATURE_SCHEMA,
            model: V09_MODEL_SCHEMA,
        },
        featureFingerprints: V09_FEATURE_FINGERPRINTS,
        teacherSchedule: V09_TEACHER_SCHEDULE,
        teacherScheduleSha256: V09_TEACHER_SCHEDULE_SHA256,
        durationHours: V09_CAMPAIGN_HOURS as typeof V09_CAMPAIGN_HOURS,
    });
}

export function buildV09CampaignManifest(
    identity: IV09CampaignIdentity,
    outputDirectory: string,
    seedLedger: IV09SeedLedger,
    actorPhysicalCores: IV09ActorPhysicalCorePolicy,
): IV09CampaignManifest {
    validateV09SeedLedger(seedLedger);
    validateV09ActorPhysicalCorePolicy(actorPhysicalCores);
    if (!GPU_UUID.test(identity.gpuUuid) || identity.gpuUuid !== V09_RTX5090_GPU_UUID) {
        throw new Error(`v0.9 campaign GPU must be the approved RTX 5090 UUID ${V09_RTX5090_GPU_UUID}`);
    }
    requireGitCommit(identity.sourceCommit, "identity.sourceCommit");
    for (const [key, value] of Object.entries(identity)) {
        if (key.endsWith("Fingerprint") || key.endsWith("Sha256")) {
            requireSha(value as string, `identity.${key}`);
        }
    }
    const expectedRunFingerprint = v09CampaignRunFingerprint(identity);
    if (expectedRunFingerprint !== seedLedger.runFingerprint) {
        throw new Error("seed ledger must be allocated from v09CampaignRunFingerprint(identity)");
    }
    const unsigned: Omit<IV09CampaignManifest, "manifestSha256"> = {
        schema: V09_CAMPAIGN_SCHEMA,
        runFingerprint: expectedRunFingerprint,
        promoted: false as const,
        durationHours: V09_CAMPAIGN_HOURS,
        outputDirectory: resolve(outputDirectory),
        identity,
        schemas: {
            il: V09_IL_SCHEMA,
            features: V09_FEATURE_SCHEMA,
            model: V09_MODEL_SCHEMA,
        },
        featureFingerprints: V09_FEATURE_FINGERPRINTS,
        teacherSchedule: V09_TEACHER_SCHEDULE,
        teacherScheduleSha256: V09_TEACHER_SCHEDULE_SHA256,
        seedLedgerSha256: seedLedger.ledgerSha256,
        resourcePolicy: {
            gpuRole: "learner_only" as const,
            gpuUuid: identity.gpuUuid,
            v09ActorPhysicalCores: {
                ...actorPhysicalCores,
                selection: {
                    ...actorPhysicalCores.selection,
                    selectedPhysicalCpuIds: [...actorPhysicalCores.selection.selectedPhysicalCpuIds],
                },
            },
            v09Nice: 10 as const,
            v08Priority: "unchanged_separate_hosts" as const,
        },
        schedule,
    };
    return { ...unsigned, manifestSha256: fingerprintV09(unsigned) };
}

export function validateV09CampaignManifest(
    value: IV09CampaignManifest,
    expectedOutputDirectory?: string,
): IV09CampaignManifest {
    if (!value || typeof value !== "object") throw new Error("v0.9 campaign manifest must be an object");
    const { manifestSha256, ...unsigned } = value;
    requireSha(manifestSha256, "campaign manifestSha256");
    if (
        value.schema !== V09_CAMPAIGN_SCHEMA ||
        value.promoted !== false ||
        value.durationHours !== V09_CAMPAIGN_HOURS ||
        fingerprintV09(unsigned) !== manifestSha256
    ) {
        throw new Error("v0.9 campaign manifest identity mismatch");
    }
    if (
        value.schemas.il !== V09_IL_SCHEMA ||
        value.schemas.features !== V09_FEATURE_SCHEMA ||
        value.schemas.model !== V09_MODEL_SCHEMA ||
        fingerprintV09(value.featureFingerprints) !== fingerprintV09(V09_FEATURE_FINGERPRINTS)
    ) {
        throw new Error("v0.9 campaign manifest schema/feature contract mismatch");
    }
    if (
        fingerprintV09(value.teacherSchedule) !== V09_TEACHER_SCHEDULE_SHA256 ||
        value.teacherScheduleSha256 !== V09_TEACHER_SCHEDULE_SHA256
    ) {
        throw new Error("v0.9 campaign teacher schedule mismatch");
    }
    if (
        !GPU_UUID.test(value.identity.gpuUuid) ||
        value.identity.gpuUuid !== V09_RTX5090_GPU_UUID ||
        value.resourcePolicy.gpuUuid !== value.identity.gpuUuid
    ) {
        throw new Error("v0.9 campaign manifest GPU identity mismatch");
    }
    requireGitCommit(value.identity.sourceCommit, "identity.sourceCommit");
    for (const [key, identityValue] of Object.entries(value.identity)) {
        if (key.endsWith("Fingerprint") || key.endsWith("Sha256")) {
            requireSha(identityValue as string, `identity.${key}`);
        }
    }
    requireSha(value.runFingerprint, "campaign runFingerprint");
    requireSha(value.seedLedgerSha256, "campaign seedLedgerSha256");
    if (value.runFingerprint !== v09CampaignRunFingerprint(value.identity)) {
        throw new Error("v0.9 campaign runFingerprint does not match its immutable identity");
    }
    if (fingerprintV09(value.schedule) !== fingerprintV09(schedule)) {
        throw new Error("v0.9 campaign schedule mismatch");
    }
    validateV09ActorPhysicalCorePolicy(value.resourcePolicy.v09ActorPhysicalCores);
    if (
        value.resourcePolicy.gpuRole !== "learner_only" ||
        value.resourcePolicy.v09Nice !== 10 ||
        value.resourcePolicy.v08Priority !== "unchanged_separate_hosts"
    ) {
        throw new Error("v0.9 campaign resource policy mismatch");
    }
    const output = resolve(value.outputDirectory);
    if (output !== value.outputDirectory) throw new Error("v0.9 campaign outputDirectory must be absolute");
    if (expectedOutputDirectory !== undefined && output !== resolve(expectedOutputDirectory)) {
        throw new Error("v0.9 campaign outputDirectory does not match the selected campaign directory");
    }
    return value;
}

/**
 * Initialize immutable campaign provenance. Re-running against the same directory is a resume and accepts only
 * byte-equivalent identities; a conflicting campaign must use a new output directory.
 */
export function initializeV09Campaign(
    outputDirectory: string,
    manifest: IV09CampaignManifest,
    seedLedger: IV09SeedLedger,
): void {
    const root = resolve(outputDirectory);
    validateV09CampaignManifest(manifest, root);
    validateV09SeedLedger(seedLedger);
    if (
        seedLedger.runFingerprint !== manifest.runFingerprint ||
        seedLedger.ledgerSha256 !== manifest.seedLedgerSha256
    ) {
        throw new Error("campaign seed ledger does not match manifest");
    }
    mkdirSync(root, { recursive: true });
    const manifestPath = resolve(root, "manifest.json");
    const ledgerPath = resolve(root, "seed-ledger.json");
    const featureContractPath = resolve(root, "feature-contract.json");
    for (const [path, value] of [
        [manifestPath, manifest],
        [ledgerPath, seedLedger],
        [
            featureContractPath,
            {
                schema: V09_FEATURE_SCHEMA,
                inputFeatureNames: V09_FULL_FEATURE_NAMES,
                featureSchemaSha256: V09_FEATURE_FINGERPRINTS.full,
            },
        ],
    ] as const) {
        if (existsSync(path)) {
            if (fingerprintV09(JSON.parse(readFileSync(path, "utf8"))) !== fingerprintV09(value)) {
                throw new Error(`refusing incompatible v0.9 campaign resume at ${path}`);
            }
        } else {
            atomicJson(path, value);
        }
    }
}

export function nextV09Stage(stage: V09CampaignStage): V09CampaignStage {
    const index = V09_CAMPAIGN_STAGES.indexOf(stage);
    if (index < 0 || index === V09_CAMPAIGN_STAGES.length - 1) return "complete";
    return V09_CAMPAIGN_STAGES[index + 1]!;
}

export function buildV09Checkpoint(
    manifest: IV09CampaignManifest,
    stage: V09CampaignStage,
    completedUnits: number,
    expectedUnits: number,
    artifacts: Record<string, string> = {},
    updatedAt = new Date().toISOString(),
): IV09CampaignCheckpoint {
    if (!Number.isSafeInteger(expectedUnits) || expectedUnits < 0)
        throw new Error("expectedUnits must be non-negative");
    if (!Number.isSafeInteger(completedUnits) || completedUnits < 0 || completedUnits > expectedUnits) {
        throw new Error("completedUnits must be between zero and expectedUnits");
    }
    for (const [name, hash] of Object.entries(artifacts)) requireSha(hash, `artifacts.${name}`);
    const unsigned = {
        schema: V09_CHECKPOINT_SCHEMA,
        runFingerprint: manifest.runFingerprint,
        manifestSha256: manifest.manifestSha256,
        stage,
        completedUnits,
        expectedUnits,
        artifacts,
        updatedAt,
    };
    return { ...unsigned, checkpointSha256: fingerprintV09(unsigned) };
}

export function writeV09Checkpoint(path: string, checkpoint: IV09CampaignCheckpoint): void {
    const { checkpointSha256, ...unsigned } = checkpoint;
    if (checkpoint.schema !== V09_CHECKPOINT_SCHEMA || fingerprintV09(unsigned) !== checkpointSha256) {
        throw new Error("refusing invalid v0.9 checkpoint");
    }
    atomicJson(path, checkpoint);
}

export function readV09Checkpoint(path: PathLike, manifest: IV09CampaignManifest): IV09CampaignCheckpoint | undefined {
    if (!existsSync(path)) return undefined;
    const value = JSON.parse(readFileSync(path, "utf8")) as IV09CampaignCheckpoint;
    const { checkpointSha256, ...unsigned } = value;
    if (
        value.schema !== V09_CHECKPOINT_SCHEMA ||
        value.runFingerprint !== manifest.runFingerprint ||
        value.manifestSha256 !== manifest.manifestSha256 ||
        fingerprintV09(unsigned) !== checkpointSha256
    ) {
        throw new Error("v0.9 checkpoint is incompatible with this campaign");
    }
    return value;
}

export function sha256File(path: PathLike): string {
    if (!statSync(path).isFile()) throw new Error(`${String(path)} is not a file`);
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}
