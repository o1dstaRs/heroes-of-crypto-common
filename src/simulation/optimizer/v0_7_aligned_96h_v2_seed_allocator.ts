/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 * -----------------------------------------------------------------------------
 */

import { createHash, createHmac } from "node:crypto";

import { V07_COMPOSED_SEED_SCAN_POLICY } from "../v0_7_composed_seed_scan";
import type { V07AlignedV2CandidateSeat, V07AlignedV2CellId } from "./v0_7_aligned_96h_v2_core";
import {
    bindV07AlignedV2SeedPlan,
    canonicalV07AlignedV2Json,
    fingerprintV07AlignedV2,
    fingerprintV07AlignedV2SeedPlan,
    validateV07AlignedV2SeedPlan,
    V07_ALIGNED_V2_EVALUATOR_CELLS,
    type IV07AlignedV2InjectedSeedPlan,
    type IV07AlignedV2ScenarioPair,
    type V07AlignedV2PanelPurpose,
} from "./v0_7_aligned_96h_v2_protocol";
import { expandV0796hPriorSeedManifest } from "./v0_7_96h_core";

export const V07_ALIGNED_V2_SEED_ALLOCATION_DOMAIN = "hoc/v0.7/aligned-96h-v2/seed-allocation/v1" as const;
export const V07_ALIGNED_V2_SEED_CONSTRUCTION = "hmac_sha256_domain_separated_uint32_rejection_v1" as const;

type ByteSource = string | Uint8Array;
type ScanSite = "local" | "zinc";

export interface IV07AlignedV2SeedScanOutputInput {
    summaryBytes: ByteSource;
    seedSetBytes: ByteSource;
}

export interface IV07AlignedV2SeedScanReplayInput {
    site: ScanSite;
    first: IV07AlignedV2SeedScanOutputInput;
    replay: IV07AlignedV2SeedScanOutputInput;
}

export interface IV07AlignedV2CommittedManifestInput {
    path: string;
    bytes: ByteSource;
}

export interface IV07AlignedV2SeedCorpusInput {
    scans: readonly [IV07AlignedV2SeedScanReplayInput, IV07AlignedV2SeedScanReplayInput];
    committedManifests: readonly IV07AlignedV2CommittedManifestInput[];
}

export type V07AlignedV2CommittedManifestShape =
    | "v0_7_96h_prior"
    | "wait_v2_cells"
    | "wait_v3_cohorts"
    | "pure_ranged_terminal"
    | "composed_affine_reservation"
    | "no_seed_reservation";

export interface IV07AlignedV2ManifestExpansion {
    shape: V07AlignedV2CommittedManifestShape;
    seeds: number[];
}

export interface IV07AlignedV2SeedScanAttestation {
    site: ScanSite;
    cutoff: string;
    scanPolicy: typeof V07_COMPOSED_SEED_SCAN_POLICY;
    uniqueSeeds: number;
    corpusSeedSetSha256: string;
    corpusFileSnapshotSha256: string;
    firstSummarySha256: string;
    replaySummarySha256: string;
    firstSeedSetSha256: string;
    replaySeedSetSha256: string;
    summaryBytes: number;
    seedSetBytes: number;
    byteIdenticalReplay: true;
}

export interface IV07AlignedV2ManifestSeedAttestation {
    path: string;
    sha256: string;
    shape: V07AlignedV2CommittedManifestShape;
    expandedUniqueSeeds: number;
    expandedSeedSetSha256: string;
}

/**
 * Reviewed, repository-relative census of every committed simulation manifest.
 * Production allocation is invalid unless the caller supplies these exact bytes.
 */
export const V07_ALIGNED_V2_PRODUCTION_MANIFEST_CENSUS: readonly IV07AlignedV2ManifestSeedAttestation[] = [
    {
        path: "src/simulation/manifests/v0_7_96h_run_d68490a_seeds.json",
        sha256: "634407118ab78e1cccd4f09a6414bfba9d7cfc402ce372fd7baa96afd69aff23",
        shape: "v0_7_96h_prior",
        expandedUniqueSeeds: 147_360,
        expandedSeedSetSha256: "78d5acee81c19d9fdbb7ad7ba97fb48cf89be6aec601c84eac87a1e1a94799eb",
    },
    {
        path: "src/simulation/manifests/v0_7_96h_smoke_d68490a_fast_seeds.json",
        sha256: "d878906fe884092764e137f1b4e52b35c93edec62d3be387efcc31dc0119c0d6",
        shape: "v0_7_96h_prior",
        expandedUniqueSeeds: 72,
        expandedSeedSetSha256: "b180df9dcde960011873d8319d3d935756d6309c12597b5a0e334fc036cca198",
    },
    {
        path: "src/simulation/manifests/v0_7_96h_smoke_d68490a_seeds.json",
        sha256: "7eac42c7ba2810fd3f48e9c0ee0e86b1893d04aea7933a48cd3d17f1512939d0",
        shape: "v0_7_96h_prior",
        expandedUniqueSeeds: 72,
        expandedSeedSetSha256: "9afd56b6685178a9c0c689303c58d2e35902a2cba195edc5cef8a880e710a336",
    },
    {
        path: "src/simulation/manifests/v0_7_acceptance_archetype_final_v2.json",
        sha256: "1ccbb285f00afa07e54c707cf04984465b45ccc2fd6c4a005120ada73c708237",
        shape: "v0_7_96h_prior",
        expandedUniqueSeeds: 18_000,
        expandedSeedSetSha256: "b4844e7166c16e137c5b68c7e3b5e7cdc2c301b86c391b263d92694edd304e45",
    },
    {
        path: "src/simulation/manifests/v0_7_acceptance_archetype_final.json",
        sha256: "777aeb139da54950f4578a08b15159e1a71b97ff74d9a6090b5d4c16c29be000",
        shape: "v0_7_96h_prior",
        expandedUniqueSeeds: 18_000,
        expandedSeedSetSha256: "884346fcaa02bc9951d7dd5a007405016bc1b5d76f2410af4f39db9835f197fc",
    },
    {
        path: "src/simulation/manifests/v0_7_aligned_96h_v2_dry_run.schema.json",
        sha256: "c72677d3e081c868b230809cffc642b5cb0dff71276beb5b0c2d60f0d667efa2",
        shape: "no_seed_reservation",
        expandedUniqueSeeds: 0,
        expandedSeedSetSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    },
    {
        path: "src/simulation/manifests/v0_7_archetype_battery_v1.json",
        sha256: "f3a53e3753c43a4f0b845d510023cd1fd75680d5333170337480ba5ebf7180d2",
        shape: "v0_7_96h_prior",
        expandedUniqueSeeds: 24_000,
        expandedSeedSetSha256: "b6fc42c7823f149030c899030635a1de3dbb7871c84d0404d78f3ee22ca678ed",
    },
    {
        path: "src/simulation/manifests/v0_7_archetype_battery_v2.json",
        sha256: "9216510443d094df3d0f9742655d9f3b996e6be4fcaa1e9eb44e830923ff2bc9",
        shape: "v0_7_96h_prior",
        expandedUniqueSeeds: 24_000,
        expandedSeedSetSha256: "0dfcbb020cb7aacc4fcdbe922c314a3b8299a0ada24365836197352890462a75",
    },
    {
        path: "src/simulation/manifests/v0_7_archetype_battery_v3.json",
        sha256: "0f203545017e88206fcd5446c2867a26df158d1b6c8a48ae17a10dcf9b672298",
        shape: "v0_7_96h_prior",
        expandedUniqueSeeds: 24_000,
        expandedSeedSetSha256: "490410da969bc688f76e9784c83081101b6adba7de8edc4ab6965a9a1e08cd8c",
    },
    {
        path: "src/simulation/manifests/v0_7_archetype_battery_v4.json",
        sha256: "a0f3e71d0ae473699227b4ccc5ee278bae02b38a2461ecc7c13eabc263acc284",
        shape: "v0_7_96h_prior",
        expandedUniqueSeeds: 24_000,
        expandedSeedSetSha256: "b1f2e15517ee8aae2a888af3adac16c75a41004b96431e8e5569cfa5eebb5ce2",
    },
    {
        path: "src/simulation/manifests/v0_7_composed_ranked_ladder_20260716.json",
        sha256: "76c0d770703ab899077f6773d82369a09bb1993d703bf48e0c253ddd24c51e2f",
        shape: "composed_affine_reservation",
        expandedUniqueSeeds: 1_081_000,
        expandedSeedSetSha256: "70f2c42e8f886af3de5761bd18984b6f485f30971417b6008032292a3b6302a5",
    },
    {
        path: "src/simulation/manifests/v0_7_cross_archetype_v1.json",
        sha256: "45eb5666a8deaf6b0de395bf8e6f69db313154f0630dcc8291d62e78a434e657",
        shape: "v0_7_96h_prior",
        expandedUniqueSeeds: 6_000,
        expandedSeedSetSha256: "2ba370a37e15ea8fa42368e3dddf1f0a71eb00b47b50a3af86c901ae91da8f4c",
    },
    {
        path: "src/simulation/manifests/v0_7_prior_zinc_seed_denylist.json",
        sha256: "2ab6ebbe7162edd7a1700f19a91ab6942b6ddbb8e4f16ebd0758e34f9faa1004",
        shape: "v0_7_96h_prior",
        expandedUniqueSeeds: 144_600,
        expandedSeedSetSha256: "47c8b5e2affc5af104b8fdba7a1359241ec6db3f39bac5e811d2ffa02b360f9e",
    },
    {
        path: "src/simulation/manifests/v0_7_pure_ranged_terminal_20260716.json",
        sha256: "42962892d69a24f76493b7e892bdb05a031ce38c6f8dd79651c93009e804c772",
        shape: "pure_ranged_terminal",
        expandedUniqueSeeds: 2_262,
        expandedSeedSetSha256: "df184a88f3e5be064984368557763ab5e28f23a6aab4d59fd77ad5b23d6e5dbe",
    },
    {
        path: "src/simulation/manifests/v0_7_wait_v2_powered_20260715.json",
        sha256: "4adba7ead69ff48b9151a3e0efc74237d911f1061a5e56f1467ad73028869b8d",
        shape: "wait_v2_cells",
        expandedUniqueSeeds: 42_000,
        expandedSeedSetSha256: "e511764fd2c45e26109a3c5171f1ebc1f2aa0586968e11073a8658cca1e38718",
    },
    {
        path: "src/simulation/manifests/v0_7_wait_v3_stage_a_20260716.json",
        sha256: "473250b7179277aa9ffdeb516a4b6c26728cf3125e0178b8f07fe441ea82dbbc",
        shape: "wait_v3_cohorts",
        expandedUniqueSeeds: 6_000,
        expandedSeedSetSha256: "2f27393f0e146f887ef94eb72c3a0926e02206200c6bbea1f0a0d585c4976e8a",
    },
];

export const V07_ALIGNED_V2_PRODUCTION_MANIFEST_CORPUS_SHA256 = fingerprintV07AlignedV2(
    V07_ALIGNED_V2_PRODUCTION_MANIFEST_CENSUS,
);

export interface IV07AlignedV2SeedCorpusAttestationUnsigned {
    schemaVersion: 1;
    kind: "v0.7_aligned_v2_seed_corpus_attestation";
    cutoff: string;
    scanPolicy: typeof V07_COMPOSED_SEED_SCAN_POLICY;
    scans: Record<ScanSite, IV07AlignedV2SeedScanAttestation>;
    manifests: IV07AlignedV2ManifestSeedAttestation[];
    manifestCorpusSha256: string;
    denysetUniqueSeeds: number;
    denysetSha256: string;
}

export interface IV07AlignedV2SeedCorpusAttestation extends IV07AlignedV2SeedCorpusAttestationUnsigned {
    attestationSha256: string;
}

export interface IV07AlignedV2SeedCorpus {
    readonly attestation: IV07AlignedV2SeedCorpusAttestation;
}

interface ICorpusMaterial {
    local: Uint32Array;
    zinc: Uint32Array;
    manifests: Uint32Array;
    attestationSha256: string;
}

const CORPUS_MATERIAL = new WeakMap<IV07AlignedV2SeedCorpus, ICorpusMaterial>();

export interface IV07AlignedV2PanelAllocationSpec {
    panelId: string;
    scenariosPerCell: number;
}

export interface IV07AlignedV2SeedAllocationRequest {
    schemaVersion: 1;
    mode: "production" | "synthetic_dry_run";
    allocationId: string;
    domain: typeof V07_ALIGNED_V2_SEED_ALLOCATION_DOMAIN;
    panels: Record<V07AlignedV2PanelPurpose, IV07AlignedV2PanelAllocationSpec>;
    maxCandidatesPerSlot: number;
}

export interface IV07AlignedV2SeedCollisionAudit {
    candidatesExamined: number;
    acceptedSeeds: number;
    rejectedCandidates: number;
    localDenysetHits: number;
    zincDenysetHits: number;
    committedManifestHits: number;
    withinPlanHits: number;
    maxAttempt: number;
}

export interface IV07AlignedV2SeedAllocationCollisionAudit {
    train: IV07AlignedV2SeedCollisionAudit;
    confirm: IV07AlignedV2SeedCollisionAudit;
    final: IV07AlignedV2SeedCollisionAudit;
    total: IV07AlignedV2SeedCollisionAudit;
    allocationTranscriptSha256: string;
}

export interface IV07AlignedV2FinalPlanDescriptor {
    panelId: string;
    purpose: "final";
    scenariosPerCell: number;
}

export interface IV07AlignedV2SeedAllocationCommitmentUnsigned {
    schemaVersion: 1;
    kind: "v0.7_aligned_v2_seed_allocation_commitment";
    construction: typeof V07_ALIGNED_V2_SEED_CONSTRUCTION;
    request: IV07AlignedV2SeedAllocationRequest;
    allocationRequestSha256: string;
    corpusAttestation: IV07AlignedV2SeedCorpusAttestation;
    corpusAttestationSha256: string;
    denysetSha256: string;
    secretCommitmentSha256: string;
    trainPlan: IV07AlignedV2InjectedSeedPlan;
    trainPlanSha256: string;
    confirmPlan: IV07AlignedV2InjectedSeedPlan;
    confirmPlanSha256: string;
    finalPlanDescriptor: IV07AlignedV2FinalPlanDescriptor;
    finalPlanSha256: string;
    finalTaskCount: number;
    finalTasksSha256: string;
    allPlanCommitmentsSha256: string;
    collisionAudit: IV07AlignedV2SeedAllocationCollisionAudit;
}

export interface IV07AlignedV2SeedAllocationCommitment extends IV07AlignedV2SeedAllocationCommitmentUnsigned {
    commitmentSha256: string;
}

export interface IV07AlignedV2CandidateFreezeBinding {
    schemaVersion: 1;
    kind: "v0.7_aligned_v2_candidate_freeze_binding";
    commitmentSha256: string;
    frozenCandidateSha256: string;
    freezeArtifactSha256: string;
}

export interface IV07AlignedV2FrozenCandidateProof {
    genomeSha256: string;
    freezeArtifactSha256: string;
}

export interface IV07AlignedV2FinalSeedRevealUnsigned {
    schemaVersion: 1;
    kind: "v0.7_aligned_v2_final_seed_reveal";
    allocationId: string;
    commitmentSha256: string;
    frozenCandidateSha256: string;
    freezeArtifactSha256: string;
    finalPlan: IV07AlignedV2InjectedSeedPlan;
    finalPlanSha256: string;
}

export interface IV07AlignedV2FinalSeedReveal extends IV07AlignedV2FinalSeedRevealUnsigned {
    finalPlanRevealSha256: string;
}

export interface IV07AlignedV2ResolvedSeedPlans {
    train: IV07AlignedV2InjectedSeedPlan;
    confirm: IV07AlignedV2InjectedSeedPlan;
    final: IV07AlignedV2InjectedSeedPlan;
}

export interface IV07AlignedV2SeedPlanBinding {
    panelId: string;
    panelFingerprint: string;
}

export interface IV07AlignedV2SeedCandidateCoordinates {
    purpose: V07AlignedV2PanelPurpose;
    panelId: string;
    cellId: V07AlignedV2CellId;
    scenarioOrdinal: number;
    candidateSeat: V07AlignedV2CandidateSeat | "shared";
    stream: "setup" | "combat";
    streamOrdinal: number;
}

export interface IV07AlignedV2SeedCandidateInput {
    secret: Uint8Array;
    allocationId: string;
    allocationRequestSha256: string;
    coordinates: IV07AlignedV2SeedCandidateCoordinates;
    attempt: number;
}

export interface IV07AlignedV2SyntheticSeedDryRunReport {
    schemaVersion: 1;
    kind: "v0.7_aligned_v2_synthetic_seed_dry_run";
    verdict: "PASS";
    seedMaterial: "synthetic_only";
    corpusAttestationSha256: string;
    denysetUniqueSeeds: number;
    commitmentSha256: string;
    trainPlanSha256: string;
    confirmPlanSha256: string;
    finalPlanSha256: string;
    finalPlanRevealSha256: string;
    resolvedPanels: number;
    crossPlanDisjoint: true;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function bytes(value: ByteSource): Uint8Array {
    return typeof value === "string" ? textEncoder.encode(value) : value;
}

function sha256(value: ByteSource): string {
    return createHash("sha256").update(bytes(value)).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (!isRecord(value)) throw new Error(`${label} must be an object`);
    return value;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    const actual = Object.keys(value).sort();
    const sortedExpected = [...expected].sort();
    return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function isLowerHexSha256(value: unknown): value is string {
    if (typeof value !== "string" || value.length !== 64) return false;
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (!((code >= 48 && code <= 57) || (code >= 97 && code <= 102))) return false;
    }
    return true;
}

function requireSha256(value: unknown, label: string): string {
    if (!isLowerHexSha256(value)) throw new Error(`${label} must be a lowercase SHA-256`);
    return value;
}

function requireUint32(value: unknown, label: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 0xffffffff) {
        throw new Error(`${label} must be a uint32`);
    }
    return value as number;
}

function requirePositiveInteger(value: unknown, label: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 1) {
        throw new Error(`${label} must be a positive integer`);
    }
    return value as number;
}

function requireEvenGames(value: unknown, label: string): number {
    const games = requirePositiveInteger(value, label);
    if (games < 2 || games % 2 !== 0) throw new Error(`${label} must be an even integer >= 2`);
    return games;
}

function canonicalCutoff(value: unknown, label: string): string {
    if (typeof value !== "string") throw new Error(`${label} must be a canonical ISO-8601 instant`);
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString().replace(".000Z", "Z") !== value) {
        throw new Error(`${label} must be a canonical ISO-8601 instant`);
    }
    return value;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
    if (left.byteLength !== right.byteLength) return false;
    return (
        Buffer.compare(
            Buffer.from(left.buffer, left.byteOffset, left.byteLength),
            Buffer.from(right.buffer, right.byteOffset, right.byteLength),
        ) === 0
    );
}

function parseJsonBytes(source: Uint8Array, label: string): unknown {
    try {
        return JSON.parse(textDecoder.decode(source));
    } catch (error) {
        throw new Error(`${label} is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function parseCanonicalSeedSet(source: Uint8Array, expectedCount: number, label: string): Uint32Array {
    if (expectedCount === 0) {
        if (source.byteLength !== 0) throw new Error(`${label} must be empty when uniqueSeeds is zero`);
        return new Uint32Array();
    }
    if (source.byteLength === 0 || source[source.byteLength - 1] !== 10) {
        throw new Error(`${label} must be newline-terminated canonical uint32 text`);
    }
    if (expectedCount > Math.floor(source.byteLength / 2)) {
        throw new Error(`${label} cannot contain summary.uniqueSeeds rows in its declared byte length`);
    }
    const result = new Uint32Array(expectedCount);
    let count = 0;
    let value = 0;
    let digits = 0;
    let firstDigit = -1;
    let previous = -1;
    for (let index = 0; index < source.byteLength; index += 1) {
        const code = source[index]!;
        if (code === 10) {
            if (digits === 0 || (digits > 1 && firstDigit === 48) || value > 0xffffffff) {
                throw new Error(`${label} contains a noncanonical uint32 line`);
            }
            if (value <= previous) throw new Error(`${label} must be strictly increasing and duplicate-free`);
            if (count >= expectedCount) throw new Error(`${label} contains more rows than summary.uniqueSeeds`);
            result[count] = value;
            count += 1;
            previous = value;
            value = 0;
            digits = 0;
            firstDigit = -1;
            continue;
        }
        if (code < 48 || code > 57) throw new Error(`${label} contains a non-decimal seed token`);
        if (digits === 0) firstDigit = code;
        value = value * 10 + (code - 48);
        digits += 1;
        if (digits > 10 || value > 0xffffffff) throw new Error(`${label} contains a value outside uint32`);
    }
    if (digits !== 0 || count !== expectedCount) {
        throw new Error(`${label} row count does not match summary.uniqueSeeds`);
    }
    return result;
}

function parseScanReplay(input: IV07AlignedV2SeedScanReplayInput): {
    seeds: Uint32Array;
    attestation: IV07AlignedV2SeedScanAttestation;
} {
    const firstSummaryBytes = bytes(input.first.summaryBytes);
    const replaySummaryBytes = bytes(input.replay.summaryBytes);
    const firstSeedSetBytes = bytes(input.first.seedSetBytes);
    const replaySeedSetBytes = bytes(input.replay.seedSetBytes);
    if (!bytesEqual(firstSummaryBytes, replaySummaryBytes) || !bytesEqual(firstSeedSetBytes, replaySeedSetBytes)) {
        throw new Error(`${input.site} seed scan is not a byte-identical same-cutoff replay`);
    }
    const summary = requireRecord(parseJsonBytes(firstSummaryBytes, `${input.site} scan summary`), "scan summary");
    if (summary.schemaVersion !== 1 || summary.scanPolicy !== V07_COMPOSED_SEED_SCAN_POLICY) {
        throw new Error(`${input.site} seed scan policy or schema is not the accepted v9d-compatible scanner`);
    }
    const cutoff = canonicalCutoff(summary.cutoff, `${input.site} summary.cutoff`);
    const uniqueSeeds = requirePositiveInteger(summary.uniqueSeeds, `${input.site} summary.uniqueSeeds`);
    const declaredSetSha256 = requireSha256(summary.corpusSeedSetSha256, `${input.site} summary.corpusSeedSetSha256`);
    const actualSetSha256 = sha256(firstSeedSetBytes);
    if (actualSetSha256 !== declaredSetSha256) {
        throw new Error(`${input.site} canonical seed set does not match summary.corpusSeedSetSha256`);
    }
    const corpusFileSnapshotSha256 = requireSha256(
        summary.corpusFileSnapshotSha256,
        `${input.site} summary.corpusFileSnapshotSha256`,
    );
    return {
        seeds: parseCanonicalSeedSet(firstSeedSetBytes, uniqueSeeds, `${input.site} canonical seed set`),
        attestation: {
            site: input.site,
            cutoff,
            scanPolicy: V07_COMPOSED_SEED_SCAN_POLICY,
            uniqueSeeds,
            corpusSeedSetSha256: actualSetSha256,
            corpusFileSnapshotSha256,
            firstSummarySha256: sha256(firstSummaryBytes),
            replaySummarySha256: sha256(replaySummaryBytes),
            firstSeedSetSha256: actualSetSha256,
            replaySeedSetSha256: sha256(replaySeedSetBytes),
            summaryBytes: firstSummaryBytes.byteLength,
            seedSetBytes: firstSeedSetBytes.byteLength,
            byteIdenticalReplay: true,
        },
    };
}

function sortedUniqueUint32(values: readonly number[]): Uint32Array {
    const sorted = [...values].map((value, index) => requireUint32(value, `seed[${index}]`)).sort((a, b) => a - b);
    const unique: number[] = [];
    for (const value of sorted) {
        if (unique[unique.length - 1] !== value) unique.push(value);
    }
    return Uint32Array.from(unique);
}

function fingerprintSortedSeeds(seeds: Uint32Array): string {
    const hash = createHash("sha256");
    for (const seed of seeds) hash.update(`${seed}\n`);
    return hash.digest("hex");
}

function sortedUnionFingerprint(arrays: readonly Uint32Array[]): { count: number; sha256: string } {
    const indices = arrays.map(() => 0);
    const hash = createHash("sha256");
    let count = 0;
    let previous = -1;
    while (true) {
        let next = Number.POSITIVE_INFINITY;
        for (let index = 0; index < arrays.length; index += 1) {
            const value = arrays[index]![indices[index]!];
            if (value !== undefined && value < next) next = value;
        }
        if (!Number.isFinite(next)) break;
        for (let index = 0; index < arrays.length; index += 1) {
            while (arrays[index]![indices[index]!] === next) indices[index] = indices[index]! + 1;
        }
        if (next !== previous) {
            hash.update(`${next}\n`);
            count += 1;
            previous = next;
        }
    }
    return { count, sha256: hash.digest("hex") };
}

function containsSortedSeed(seeds: Uint32Array, target: number): boolean {
    let low = 0;
    let high = seeds.length - 1;
    while (low <= high) {
        const middle = (low + high) >>> 1;
        const value = seeds[middle]!;
        if (value === target) return true;
        if (value < target) low = middle + 1;
        else high = middle - 1;
    }
    return false;
}

function pairSeedStream(base: unknown, games: unknown, step: unknown, label: string): number[] {
    const canonicalBase = requireUint32(base, `${label}.baseSeed`);
    const canonicalGames = requireEvenGames(games, `${label}.games`);
    const canonicalStep = requireUint32(step, `${label}.pairSeedStep`);
    return Array.from(
        { length: canonicalGames / 2 },
        (_, pair) => (canonicalBase + Math.imul(pair, canonicalStep)) >>> 0,
    );
}

function expandWaitV2Manifest(manifest: Record<string, unknown>): number[] {
    const cells = manifest.cells;
    if (!Array.isArray(cells) || cells.length === 0) throw new Error("wait-v2 cells must be a nonempty array");
    const games = requireEvenGames(manifest.gamesPerArm, "wait-v2 gamesPerArm");
    const step = manifest.pairSeedStep === undefined ? 0x9e3779b1 : manifest.pairSeedStep;
    return cells.flatMap((entry, index) => {
        const cell = requireRecord(entry, `wait-v2 cells[${index}]`);
        return pairSeedStream(cell.baseSeed, games, step, `wait-v2 cells[${index}]`);
    });
}

function expandWaitV3Manifest(manifest: Record<string, unknown>): number[] {
    const cohorts = manifest.cohorts;
    if (!Array.isArray(cohorts) || cohorts.length === 0) throw new Error("wait-v3 cohorts must be a nonempty array");
    const step = requireUint32(manifest.pairSeedStep, "wait-v3 pairSeedStep");
    return cohorts.flatMap((entry, index) => {
        const cohort = requireRecord(entry, `wait-v3 cohorts[${index}]`);
        return pairSeedStream(cohort.baseSeed, cohort.games, step, `wait-v3 cohorts[${index}]`);
    });
}

function expandPureRangedManifest(manifest: Record<string, unknown>): number[] {
    const step = requireUint32(manifest.pairSeedStep, "pure-ranged pairSeedStep");
    const reservation = requireRecord(manifest.scenarioReservation, "pure-ranged scenarioReservation");
    const scout = requireRecord(reservation.scout, "pure-ranged scout");
    const confirmation = requireRecord(reservation.confirmation, "pure-ranged confirmation");
    const stream = (panel: Record<string, unknown>, label: string): number[] => {
        const pairSeeds = requirePositiveInteger(panel.pairSeeds, `${label}.pairSeeds`);
        const gamesPerArm = requirePositiveInteger(panel.gamesPerArm, `${label}.gamesPerArm`);
        if (pairSeeds !== Math.ceil(gamesPerArm / 2)) {
            throw new Error(`${label}.pairSeeds does not match gamesPerArm`);
        }
        const base = requireUint32(panel.baseSeed, `${label}.baseSeed`);
        return Array.from({ length: pairSeeds }, (_, pair) => (base + Math.imul(pair, step)) >>> 0);
    };
    const seeds = [...stream(scout, "pure-ranged scout"), ...stream(confirmation, "pure-ranged confirmation")];
    const identitySeeds = requireRecord(confirmation.identityPairSeeds, "pure-ranged confirmation.identityPairSeeds");
    for (const [template, seed] of Object.entries(identitySeeds).sort(([left], [right]) => left.localeCompare(right))) {
        seeds.push(requireUint32(seed, `pure-ranged identity ${template}`));
    }
    const unique = sortedUniqueUint32(seeds);
    if (reservation.uniqueScenarioSeeds !== unique.length) {
        throw new Error("pure-ranged uniqueScenarioSeeds does not match expanded reservation");
    }
    return [...unique];
}

function expandComposedAffineManifest(manifest: Record<string, unknown>): number[] {
    const permutation = requireRecord(manifest.seedPermutation, "composed seedPermutation");
    if (permutation.construction !== "sha256_parameterized_affine_uint32_bijection_with_collision_remaps") {
        throw new Error("composed affine construction is unsupported");
    }
    if (typeof permutation.domain !== "string" || !permutation.domain.trim()) {
        throw new Error("composed affine domain must not be empty");
    }
    requireUint32(permutation.nonce, "composed permutation nonce");
    const offset = requireUint32(permutation.offset, "composed permutation offset");
    const oddStep = requireUint32(permutation.oddStep, "composed permutation oddStep");
    if ((oddStep & 1) !== 1) throw new Error("composed affine oddStep must be odd");
    const cells = manifest.cells;
    if (!Array.isArray(cells) || cells.length === 0) throw new Error("composed cells must be a nonempty array");
    const parsedCells = cells.map((entry, index) => {
        const cell = requireRecord(entry, `composed cells[${index}]`);
        if (typeof cell.id !== "string" || !cell.id.trim()) throw new Error(`composed cells[${index}].id is empty`);
        if (
            !(["fixed_physical_side_swap", "independent_seat_conditioned"] as const).includes(
                cell.scenarioProtocol as never,
            )
        ) {
            throw new Error(`${cell.id} has an unsupported scenarioProtocol`);
        }
        return {
            id: cell.id,
            protocol: cell.scenarioProtocol as "fixed_physical_side_swap" | "independent_seat_conditioned",
            pairScenarios: requirePositiveInteger(cell.pairScenarios, `${cell.id}.pairScenarios`),
            baseSeed: requireUint32(cell.baseSeed, `${cell.id}.baseSeed`),
        };
    });
    if (new Set(parsedCells.map((cell) => cell.id)).size !== parsedCells.length) {
        throw new Error("composed cell ids must be unique");
    }
    const totalMainOrdinals = parsedCells.reduce(
        (sum, cell) => sum + cell.pairScenarios * (cell.protocol === "independent_seat_conditioned" ? 259 : 3),
        0,
    );
    if (!Number.isSafeInteger(totalMainOrdinals) || totalMainOrdinals > 0xffffffff) {
        throw new Error("composed main logical envelope exceeds uint32");
    }
    const seedAudit = requireRecord(manifest.seedAudit, "composed seedAudit");
    const overrides = requireRecord(seedAudit.ordinalOverrides, "composed seedAudit.ordinalOverrides");
    const overrideValues = new Map<string, number>();
    for (const [label, ordinal] of Object.entries(overrides)) {
        overrideValues.set(label, requireUint32(ordinal, `composed override ${label}`));
    }
    const consumedOverrides = new Set<string>();
    const collisionLedger =
        seedAudit.collisionResolutions === undefined ? undefined : (seedAudit.collisionResolutions as unknown[]);
    if (collisionLedger !== undefined && !Array.isArray(collisionLedger)) {
        throw new Error("composed collisionResolutions must be an array");
    }
    const collisionLedgerByLabel = new Map<string, Record<string, unknown>>();
    for (const [index, entry] of (collisionLedger ?? []).entries()) {
        const record = requireRecord(entry, `composed collisionResolutions[${index}]`);
        if (typeof record.label !== "string" || !record.label.trim() || collisionLedgerByLabel.has(record.label)) {
            throw new Error("composed collisionResolutions labels must be nonempty and unique");
        }
        collisionLedgerByLabel.set(record.label, record);
    }
    if (collisionLedger !== undefined && collisionLedger.length !== overrideValues.size) {
        throw new Error("composed collisionResolutions length must match ordinalOverrides");
    }
    const usedOrdinals = new Set<number>();
    const seeds: number[] = [];
    const envelopeHash = createHash("sha256");
    let mainOrdinal = 0;
    let plannedPairs = 0;
    const register = (label: string, ordinal: number, kind: "protected" | "setup_proposal"): number => {
        const selected = overrideValues.get(label) ?? ordinal;
        if (overrideValues.has(label)) consumedOverrides.add(label);
        if (overrideValues.has(label) && selected === ordinal) {
            throw new Error(`composed override ${label} is a no-op`);
        }
        if (selected !== ordinal && selected < totalMainOrdinals) {
            throw new Error(`composed override ${label} is inside the main logical envelope`);
        }
        if (usedOrdinals.has(selected)) throw new Error(`composed ordinal collision at ${label}`);
        usedOrdinals.add(selected);
        const seed = (offset + Math.imul(selected, oddStep)) >>> 0;
        const ledger = collisionLedgerByLabel.get(label);
        if (overrideValues.has(label) && collisionLedger !== undefined) {
            const originalSeed = (offset + Math.imul(ordinal, oddStep)) >>> 0;
            if (
                !ledger ||
                ledger.kind !== kind ||
                ledger.mainOrdinal !== ordinal ||
                ledger.originalSeed !== originalSeed ||
                ledger.remapOrdinal !== selected ||
                ledger.remappedSeed !== seed ||
                !(
                    (ledger.inLocal === true || ledger.inZinc === true) &&
                    typeof ledger.inLocal === "boolean" &&
                    typeof ledger.inZinc === "boolean"
                )
            ) {
                throw new Error(`composed collision ledger does not match override ${label}`);
            }
            collisionLedgerByLabel.delete(label);
        } else if (ledger) {
            throw new Error(`composed collision ledger contains an unbound entry ${label}`);
        }
        seeds.push(seed);
        envelopeHash.update(`${label}\0${ordinal}\0${selected}\0${seed}\0${kind}\n`);
        return seed;
    };
    for (const cell of parsedCells) {
        const slotsPerScenario = cell.protocol === "independent_seat_conditioned" ? 259 : 3;
        for (let pair = 0; pair < cell.pairScenarios; pair += 1) {
            const root = mainOrdinal + pair * slotsPerScenario;
            const scenarioSeed = register(`${cell.id}/${pair}/scenario_root`, root, "protected");
            if (pair === 0 && scenarioSeed !== cell.baseSeed) {
                throw new Error(`${cell.id}.baseSeed does not match its compact affine reservation`);
            }
            if (cell.protocol === "independent_seat_conditioned") {
                for (const [seat, setupOffset, combatOffset] of [
                    ["candidate_green", 1, 129],
                    ["candidate_red", 130, 258],
                ] as const) {
                    for (let attempt = 0; attempt < 128; attempt += 1) {
                        register(
                            `${cell.id}/${pair}/setup/${seat}/${attempt}`,
                            root + setupOffset + attempt,
                            "setup_proposal",
                        );
                    }
                    register(`${cell.id}/${pair}/combat/${seat}`, root + combatOffset, "protected");
                }
            } else {
                register(`${cell.id}/${pair}/setup/shared/0`, root + 1, "setup_proposal");
                register(`${cell.id}/${pair}/combat/shared`, root + 2, "protected");
            }
        }
        plannedPairs += cell.pairScenarios;
        mainOrdinal += cell.pairScenarios * slotsPerScenario;
    }
    if (consumedOverrides.size !== overrideValues.size) {
        throw new Error("composed ordinalOverrides contains an unknown logical slot");
    }
    if (collisionLedgerByLabel.size !== 0) {
        throw new Error("composed collisionResolutions contains an unknown logical slot");
    }
    if (
        seedAudit.plannedPairScenarios !== plannedPairs ||
        seedAudit.reservedDerivedSeedTokens !== seeds.length ||
        seedAudit.internalCollisions !== 0
    ) {
        throw new Error("composed seed-audit counts do not match compact affine expansion");
    }
    if (seedAudit.reservedEnvelopeSha256 !== undefined) {
        const declared = requireSha256(seedAudit.reservedEnvelopeSha256, "composed reservedEnvelopeSha256");
        if (envelopeHash.digest("hex") !== declared) {
            throw new Error("composed reservedEnvelopeSha256 does not match compact affine expansion");
        }
    }
    return seeds;
}

function isStructuredUint32String(value: string): boolean {
    if (!value.length) return false;
    let radix = 10;
    let start = 0;
    if (value.length > 2 && value[0] === "0" && (value[1] === "x" || value[1] === "X")) {
        radix = 16;
        start = 2;
    }
    if (start === value.length || (radix === 10 && value.length > 1 && value[0] === "0")) return false;
    let parsed = 0;
    for (let index = start; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        const digit =
            code >= 48 && code <= 57
                ? code - 48
                : radix === 16 && code >= 65 && code <= 70
                  ? code - 55
                  : radix === 16 && code >= 97 && code <= 102
                    ? code - 87
                    : -1;
        if (digit < 0 || digit >= radix) return false;
        parsed = parsed * radix + digit;
        if (parsed > 0xffffffff) return false;
    }
    return true;
}

function containsStructuredNumericSeed(value: unknown, seedContext = false): boolean {
    if (typeof value === "number")
        return seedContext && Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff;
    if (typeof value === "string") return seedContext && isStructuredUint32String(value);
    if (value === null || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some((entry) => containsStructuredNumericSeed(entry, seedContext));
    return Object.entries(value as Record<string, unknown>).some(([key, entry]) =>
        containsStructuredNumericSeed(entry, seedContext || key.toLowerCase().includes("seed")),
    );
}

/** Expand supported committed JSON shapes without textual token inference. */
export function expandV07AlignedV2CommittedManifest(manifest: unknown): IV07AlignedV2ManifestExpansion {
    const record = requireRecord(manifest, "committed seed manifest");
    let shape: V07AlignedV2CommittedManifestShape;
    let seeds: number[];
    if (record.seedPermutation !== undefined && record.seedAudit !== undefined && Array.isArray(record.cells)) {
        shape = "composed_affine_reservation";
        seeds = expandComposedAffineManifest(record);
    } else if (record.scenarioReservation !== undefined) {
        shape = "pure_ranged_terminal";
        seeds = expandPureRangedManifest(record);
    } else if (record.gamesPerArm !== undefined && Array.isArray(record.cells)) {
        shape = "wait_v2_cells";
        seeds = expandWaitV2Manifest(record);
    } else if (record.pairSeedStep !== undefined && Array.isArray(record.cohorts)) {
        shape = "wait_v3_cohorts";
        seeds = expandWaitV3Manifest(record);
    } else {
        seeds = expandV0796hPriorSeedManifest(record);
        if (seeds.length > 0) shape = "v0_7_96h_prior";
        else {
            if (containsStructuredNumericSeed(record)) {
                throw new Error("committed manifest contains an unrecognized structured numeric seed reservation");
            }
            shape = "no_seed_reservation";
        }
    }
    return { shape, seeds: [...sortedUniqueUint32(seeds)] };
}

function unsignedAttestation(
    attestation: IV07AlignedV2SeedCorpusAttestation,
): IV07AlignedV2SeedCorpusAttestationUnsigned {
    return Object.fromEntries(
        Object.entries(attestation).filter(([key]) => key !== "attestationSha256"),
    ) as unknown as IV07AlignedV2SeedCorpusAttestationUnsigned;
}

export function validateV07AlignedV2SeedCorpusAttestation(value: unknown): IV07AlignedV2SeedCorpusAttestation {
    const record = requireRecord(value, "seed corpus attestation");
    if (
        !hasExactKeys(record, [
            "schemaVersion",
            "kind",
            "cutoff",
            "scanPolicy",
            "scans",
            "manifests",
            "manifestCorpusSha256",
            "denysetUniqueSeeds",
            "denysetSha256",
            "attestationSha256",
        ]) ||
        record.schemaVersion !== 1 ||
        record.kind !== "v0.7_aligned_v2_seed_corpus_attestation" ||
        record.scanPolicy !== V07_COMPOSED_SEED_SCAN_POLICY
    ) {
        throw new Error("seed corpus attestation envelope is malformed");
    }
    canonicalCutoff(record.cutoff, "seed corpus attestation cutoff");
    requirePositiveInteger(record.denysetUniqueSeeds, "seed corpus denysetUniqueSeeds");
    requireSha256(record.manifestCorpusSha256, "seed corpus manifestCorpusSha256");
    requireSha256(record.denysetSha256, "seed corpus denysetSha256");
    const scans = requireRecord(record.scans, "seed corpus scans");
    if (!hasExactKeys(scans, ["local", "zinc"])) throw new Error("seed corpus scans must contain local and zinc");
    for (const site of ["local", "zinc"] as const) {
        const scan = requireRecord(scans[site], `${site} scan attestation`);
        if (
            !hasExactKeys(scan, [
                "site",
                "cutoff",
                "scanPolicy",
                "uniqueSeeds",
                "corpusSeedSetSha256",
                "corpusFileSnapshotSha256",
                "firstSummarySha256",
                "replaySummarySha256",
                "firstSeedSetSha256",
                "replaySeedSetSha256",
                "summaryBytes",
                "seedSetBytes",
                "byteIdenticalReplay",
            ]) ||
            scan.site !== site ||
            scan.cutoff !== record.cutoff ||
            scan.scanPolicy !== V07_COMPOSED_SEED_SCAN_POLICY ||
            scan.byteIdenticalReplay !== true
        ) {
            throw new Error(`${site} scan attestation is malformed or has a different cutoff`);
        }
        requirePositiveInteger(scan.uniqueSeeds, `${site} uniqueSeeds`);
        requirePositiveInteger(scan.summaryBytes, `${site} summaryBytes`);
        requirePositiveInteger(scan.seedSetBytes, `${site} seedSetBytes`);
        for (const key of [
            "corpusSeedSetSha256",
            "corpusFileSnapshotSha256",
            "firstSummarySha256",
            "replaySummarySha256",
            "firstSeedSetSha256",
            "replaySeedSetSha256",
        ] as const) {
            requireSha256(scan[key], `${site}.${key}`);
        }
        if (
            scan.firstSummarySha256 !== scan.replaySummarySha256 ||
            scan.firstSeedSetSha256 !== scan.replaySeedSetSha256 ||
            scan.corpusSeedSetSha256 !== scan.firstSeedSetSha256
        ) {
            throw new Error(`${site} scan replay hashes are not identical`);
        }
    }
    if (!Array.isArray(record.manifests)) throw new Error("seed corpus manifests must be an array");
    const manifestShapes: readonly V07AlignedV2CommittedManifestShape[] = [
        "v0_7_96h_prior",
        "wait_v2_cells",
        "wait_v3_cohorts",
        "pure_ranged_terminal",
        "composed_affine_reservation",
        "no_seed_reservation",
    ];
    let previousManifestPath = "";
    for (const [index, manifest] of record.manifests.entries()) {
        const entry = requireRecord(manifest, `seed corpus manifests[${index}]`);
        if (
            !hasExactKeys(entry, ["path", "sha256", "shape", "expandedUniqueSeeds", "expandedSeedSetSha256"]) ||
            typeof entry.path !== "string" ||
            !entry.path.trim() ||
            (previousManifestPath !== "" && previousManifestPath.localeCompare(entry.path) >= 0) ||
            !manifestShapes.includes(entry.shape as V07AlignedV2CommittedManifestShape)
        ) {
            throw new Error(`seed corpus manifests[${index}] is malformed`);
        }
        previousManifestPath = entry.path;
        requireSha256(entry.sha256, `seed corpus manifests[${index}].sha256`);
        requireSha256(entry.expandedSeedSetSha256, `seed corpus manifests[${index}].expandedSeedSetSha256`);
        if (!Number.isSafeInteger(entry.expandedUniqueSeeds) || (entry.expandedUniqueSeeds as number) < 0) {
            throw new Error(`seed corpus manifests[${index}].expandedUniqueSeeds is invalid`);
        }
    }
    if (fingerprintV07AlignedV2(record.manifests) !== record.manifestCorpusSha256) {
        throw new Error("seed corpus manifest census fingerprint mismatch");
    }
    const typed = record as unknown as IV07AlignedV2SeedCorpusAttestation;
    const declared = requireSha256(record.attestationSha256, "seed corpus attestationSha256");
    if (fingerprintV07AlignedV2(unsignedAttestation(typed)) !== declared) {
        throw new Error("seed corpus attestation self-hash mismatch");
    }
    return typed;
}

export function validateV07AlignedV2ProductionManifestCensus(value: unknown): IV07AlignedV2SeedCorpusAttestation {
    const attestation = validateV07AlignedV2SeedCorpusAttestation(value);
    if (
        attestation.manifestCorpusSha256 !== V07_ALIGNED_V2_PRODUCTION_MANIFEST_CORPUS_SHA256 ||
        canonicalV07AlignedV2Json(attestation.manifests) !==
            canonicalV07AlignedV2Json(V07_ALIGNED_V2_PRODUCTION_MANIFEST_CENSUS)
    ) {
        throw new Error(
            "production committed manifest census mismatch: every reviewed repository manifest is mandatory",
        );
    }
    return attestation;
}

/** Ingest exact same-cutoff v9d scan replays plus structured committed manifests. */
export function ingestV07AlignedV2SeedCorpus(input: IV07AlignedV2SeedCorpusInput): IV07AlignedV2SeedCorpus {
    if (input.scans.length !== 2 || new Set(input.scans.map((scan) => scan.site)).size !== 2) {
        throw new Error("seed corpus requires exactly one local and one zinc scan replay");
    }
    const parsed = input.scans.map(parseScanReplay);
    const local = parsed.find((entry) => entry.attestation.site === "local")!;
    const zinc = parsed.find((entry) => entry.attestation.site === "zinc")!;
    if (local.attestation.cutoff !== zinc.attestation.cutoff) {
        throw new Error("local and zinc seed scans must use the exact same cutoff");
    }
    const manifestPaths = new Set<string>();
    const manifestSeeds: number[] = [];
    const manifestAttestations = input.committedManifests
        .map((inputManifest): IV07AlignedV2ManifestSeedAttestation => {
            if (!inputManifest.path.trim() || manifestPaths.has(inputManifest.path)) {
                throw new Error("committed manifest paths must be nonempty and unique");
            }
            manifestPaths.add(inputManifest.path);
            const source = bytes(inputManifest.bytes);
            const expansion = expandV07AlignedV2CommittedManifest(
                parseJsonBytes(source, `committed manifest ${inputManifest.path}`),
            );
            for (const seed of expansion.seeds) manifestSeeds.push(seed);
            const unique = sortedUniqueUint32(expansion.seeds);
            return {
                path: inputManifest.path,
                sha256: sha256(source),
                shape: expansion.shape,
                expandedUniqueSeeds: unique.length,
                expandedSeedSetSha256: fingerprintSortedSeeds(unique),
            };
        })
        .sort((left, right) => left.path.localeCompare(right.path));
    const manifestSet = sortedUniqueUint32(manifestSeeds);
    const manifestCorpusSha256 = fingerprintV07AlignedV2(manifestAttestations);
    const denyset = sortedUnionFingerprint([local.seeds, zinc.seeds, manifestSet]);
    const unsigned: IV07AlignedV2SeedCorpusAttestationUnsigned = {
        schemaVersion: 1,
        kind: "v0.7_aligned_v2_seed_corpus_attestation",
        cutoff: local.attestation.cutoff,
        scanPolicy: V07_COMPOSED_SEED_SCAN_POLICY,
        scans: { local: local.attestation, zinc: zinc.attestation },
        manifests: manifestAttestations,
        manifestCorpusSha256,
        denysetUniqueSeeds: denyset.count,
        denysetSha256: denyset.sha256,
    };
    const attestation: IV07AlignedV2SeedCorpusAttestation = {
        ...unsigned,
        attestationSha256: fingerprintV07AlignedV2(unsigned),
    };
    validateV07AlignedV2SeedCorpusAttestation(attestation);
    const corpus: IV07AlignedV2SeedCorpus = Object.freeze({ attestation: structuredClone(attestation) });
    CORPUS_MATERIAL.set(corpus, {
        local: local.seeds,
        zinc: zinc.seeds,
        manifests: manifestSet,
        attestationSha256: attestation.attestationSha256,
    });
    return corpus;
}

function corpusMaterial(corpus: IV07AlignedV2SeedCorpus): ICorpusMaterial {
    const material = CORPUS_MATERIAL.get(corpus);
    if (!material) throw new Error("seed corpus was not created by ingestV07AlignedV2SeedCorpus");
    if (
        validateV07AlignedV2SeedCorpusAttestation(corpus.attestation).attestationSha256 !==
            material.attestationSha256 ||
        fingerprintV07AlignedV2(unsignedAttestation(corpus.attestation)) !== material.attestationSha256
    ) {
        throw new Error("seed corpus attestation changed after ingestion");
    }
    return material;
}

function validatePanelSpec(value: unknown, label: string): IV07AlignedV2PanelAllocationSpec {
    const panel = requireRecord(value, label);
    if (!hasExactKeys(panel, ["panelId", "scenariosPerCell"])) throw new Error(`${label} fields are not exact`);
    if (typeof panel.panelId !== "string" || !panel.panelId.trim())
        throw new Error(`${label}.panelId must not be empty`);
    requirePositiveInteger(panel.scenariosPerCell, `${label}.scenariosPerCell`);
    return panel as unknown as IV07AlignedV2PanelAllocationSpec;
}

export function validateV07AlignedV2SeedAllocationRequest(value: unknown): IV07AlignedV2SeedAllocationRequest {
    const request = requireRecord(value, "seed allocation request");
    if (
        !hasExactKeys(request, ["schemaVersion", "mode", "allocationId", "domain", "panels", "maxCandidatesPerSlot"]) ||
        request.schemaVersion !== 1 ||
        !(request.mode === "production" || request.mode === "synthetic_dry_run") ||
        request.domain !== V07_ALIGNED_V2_SEED_ALLOCATION_DOMAIN ||
        typeof request.allocationId !== "string" ||
        !request.allocationId.trim()
    ) {
        throw new Error("seed allocation request envelope is malformed");
    }
    const panels = requireRecord(request.panels, "seed allocation panels");
    if (!hasExactKeys(panels, ["train", "confirm", "final"])) {
        throw new Error("seed allocation request must contain exactly train, confirm, and final panels");
    }
    const train = validatePanelSpec(panels.train, "train panel");
    const confirm = validatePanelSpec(panels.confirm, "confirm panel");
    const final = validatePanelSpec(panels.final, "final panel");
    if (new Set([train.panelId, confirm.panelId, final.panelId]).size !== 3) {
        throw new Error("train, confirm, and final panel ids must be distinct");
    }
    const maxCandidatesPerSlot = requirePositiveInteger(request.maxCandidatesPerSlot, "maxCandidatesPerSlot");
    if (maxCandidatesPerSlot > 1_000_000) throw new Error("maxCandidatesPerSlot must not exceed 1000000");
    if (request.mode === "production") {
        if (confirm.scenariosPerCell !== 1_000 || final.scenariosPerCell !== 2_000) {
            throw new Error("production confirm/final panels must use exactly 1000/2000 scenarios per cell");
        }
    } else if ([train, confirm, final].some((panel) => panel.scenariosPerCell > 8)) {
        throw new Error("synthetic dry-run panels are capped at eight scenarios per cell");
    }
    return request as unknown as IV07AlignedV2SeedAllocationRequest;
}

function validateSecret(secret: Uint8Array): Uint8Array {
    if (!(secret instanceof Uint8Array) || secret.byteLength !== 32) {
        throw new Error("seed allocation secret must contain exactly 32 bytes");
    }
    return secret;
}

function secretCommitment(secret: Uint8Array): string {
    return createHash("sha256")
        .update(`${V07_ALIGNED_V2_SEED_ALLOCATION_DOMAIN}\0secret-commitment\0`)
        .update(validateSecret(secret))
        .digest("hex");
}

/** Derive one uint32 candidate. Every semantic coordinate and retry attempt is domain-separated. */
export function deriveV07AlignedV2SeedCandidate(input: IV07AlignedV2SeedCandidateInput): number {
    validateSecret(input.secret);
    if (!input.allocationId.trim()) throw new Error("candidate allocationId must not be empty");
    requireSha256(input.allocationRequestSha256, "candidate allocationRequestSha256");
    requireUint32(input.attempt, "candidate attempt");
    requireUint32(input.coordinates.scenarioOrdinal, "candidate scenarioOrdinal");
    requireUint32(input.coordinates.streamOrdinal, "candidate streamOrdinal");
    if (
        !(
            input.coordinates.purpose === "train" ||
            input.coordinates.purpose === "confirm" ||
            input.coordinates.purpose === "final"
        )
    ) {
        throw new Error("candidate purpose is invalid");
    }
    if (!input.coordinates.panelId.trim()) throw new Error("candidate panelId must not be empty");
    const cell = V07_ALIGNED_V2_EVALUATOR_CELLS.find((entry) => entry.id === input.coordinates.cellId);
    if (!cell) throw new Error("candidate cellId is not in the aligned-v2 evaluator registry");
    if (!(input.coordinates.stream === "setup" || input.coordinates.stream === "combat")) {
        throw new Error("candidate stream is invalid");
    }
    if (
        (cell.distribution === "fixed_template" && input.coordinates.candidateSeat !== "shared") ||
        (cell.distribution === "ranked_taxonomy" && input.coordinates.candidateSeat === "shared")
    ) {
        throw new Error("candidate seat domain does not match the cell distribution");
    }
    const maxStreamOrdinal = input.coordinates.stream === "setup" && cell.distribution === "ranked_taxonomy" ? 127 : 0;
    if (input.coordinates.streamOrdinal > maxStreamOrdinal) {
        throw new Error("candidate streamOrdinal is outside its registered stream");
    }
    const digest = createHmac("sha256", input.secret)
        .update(
            canonicalV07AlignedV2Json({
                construction: V07_ALIGNED_V2_SEED_CONSTRUCTION,
                domain: V07_ALIGNED_V2_SEED_ALLOCATION_DOMAIN,
                allocationId: input.allocationId,
                allocationRequestSha256: input.allocationRequestSha256,
                coordinates: input.coordinates,
                attempt: input.attempt,
            }),
        )
        .digest();
    return ((digest[0]! << 24) | (digest[1]! << 16) | (digest[2]! << 8) | digest[3]!) >>> 0;
}

function emptyCollisionAudit(): IV07AlignedV2SeedCollisionAudit {
    return {
        candidatesExamined: 0,
        acceptedSeeds: 0,
        rejectedCandidates: 0,
        localDenysetHits: 0,
        zincDenysetHits: 0,
        committedManifestHits: 0,
        withinPlanHits: 0,
        maxAttempt: 0,
    };
}

function sumCollisionAudits(audits: readonly IV07AlignedV2SeedCollisionAudit[]): IV07AlignedV2SeedCollisionAudit {
    return audits.reduce(
        (sum, audit) => ({
            candidatesExamined: sum.candidatesExamined + audit.candidatesExamined,
            acceptedSeeds: sum.acceptedSeeds + audit.acceptedSeeds,
            rejectedCandidates: sum.rejectedCandidates + audit.rejectedCandidates,
            localDenysetHits: sum.localDenysetHits + audit.localDenysetHits,
            zincDenysetHits: sum.zincDenysetHits + audit.zincDenysetHits,
            committedManifestHits: sum.committedManifestHits + audit.committedManifestHits,
            withinPlanHits: sum.withinPlanHits + audit.withinPlanHits,
            maxAttempt: Math.max(sum.maxAttempt, audit.maxAttempt),
        }),
        emptyCollisionAudit(),
    );
}

interface IInternalAllocation {
    commitment: IV07AlignedV2SeedAllocationCommitment;
    finalPlan: IV07AlignedV2InjectedSeedPlan;
}

function allocateV07AlignedV2SeedPlans(
    rawRequest: IV07AlignedV2SeedAllocationRequest,
    corpus: IV07AlignedV2SeedCorpus,
    rawSecret: Uint8Array,
): IInternalAllocation {
    const request = structuredClone(validateV07AlignedV2SeedAllocationRequest(rawRequest));
    const secret = Uint8Array.from(validateSecret(rawSecret));
    const material = corpusMaterial(corpus);
    const corpusAttestation = structuredClone(validateV07AlignedV2SeedCorpusAttestation(corpus.attestation));
    if (request.mode === "production") validateV07AlignedV2ProductionManifestCensus(corpusAttestation);
    const allocationRequestSha256 = fingerprintV07AlignedV2(request);
    const usedPlanSeeds = new Set<number>();
    const transcript = createHash("sha256");

    const allocatePlan = (
        purpose: V07AlignedV2PanelPurpose,
    ): {
        plan: IV07AlignedV2InjectedSeedPlan;
        audit: IV07AlignedV2SeedCollisionAudit;
    } => {
        const spec = request.panels[purpose];
        const audit = emptyCollisionAudit();
        const take = (coordinates: IV07AlignedV2SeedCandidateCoordinates): number => {
            for (let attempt = 0; attempt < request.maxCandidatesPerSlot; attempt += 1) {
                const candidate = deriveV07AlignedV2SeedCandidate({
                    secret,
                    allocationId: request.allocationId,
                    allocationRequestSha256,
                    coordinates,
                    attempt,
                });
                audit.candidatesExamined += 1;
                const localHit = containsSortedSeed(material.local, candidate);
                const zincHit = containsSortedSeed(material.zinc, candidate);
                const manifestHit = containsSortedSeed(material.manifests, candidate);
                const withinPlanHit = usedPlanSeeds.has(candidate);
                if (localHit || zincHit || manifestHit || withinPlanHit) {
                    audit.rejectedCandidates += 1;
                    audit.localDenysetHits += Number(localHit);
                    audit.zincDenysetHits += Number(zincHit);
                    audit.committedManifestHits += Number(manifestHit);
                    audit.withinPlanHits += Number(withinPlanHit);
                    continue;
                }
                audit.acceptedSeeds += 1;
                audit.maxAttempt = Math.max(audit.maxAttempt, attempt);
                usedPlanSeeds.add(candidate);
                transcript.update(
                    `${purpose}\0${coordinates.panelId}\0${coordinates.cellId}\0${coordinates.scenarioOrdinal}\0${coordinates.candidateSeat}\0${coordinates.stream}\0${coordinates.streamOrdinal}\0${attempt}\0${candidate}\n`,
                );
                return candidate;
            }
            throw new Error(
                `seed allocation exhausted ${request.maxCandidatesPerSlot} candidates for ${canonicalV07AlignedV2Json(coordinates)}`,
            );
        };
        const pairs: IV07AlignedV2ScenarioPair[] = [];
        for (const cell of V07_ALIGNED_V2_EVALUATOR_CELLS) {
            for (let scenarioOrdinal = 0; scenarioOrdinal < spec.scenariosPerCell; scenarioOrdinal += 1) {
                const scenarioId = `scenario-${scenarioOrdinal}`;
                if (cell.distribution === "fixed_template") {
                    const setupSeed = take({
                        purpose,
                        panelId: spec.panelId,
                        cellId: cell.id,
                        scenarioOrdinal,
                        candidateSeat: "shared",
                        stream: "setup",
                        streamOrdinal: 0,
                    });
                    const combatSeed = take({
                        purpose,
                        panelId: spec.panelId,
                        cellId: cell.id,
                        scenarioOrdinal,
                        candidateSeat: "shared",
                        stream: "combat",
                        streamOrdinal: 0,
                    });
                    pairs.push({
                        cellId: cell.id,
                        scenarioOrdinal,
                        scenarioId,
                        seats: {
                            candidate_green: { setupSeeds: [setupSeed], combatSeed },
                            candidate_red: { setupSeeds: [setupSeed], combatSeed },
                        },
                    });
                } else {
                    const stream = (candidateSeat: V07AlignedV2CandidateSeat) => ({
                        setupSeeds: Array.from({ length: 128 }, (_, streamOrdinal) =>
                            take({
                                purpose,
                                panelId: spec.panelId,
                                cellId: cell.id,
                                scenarioOrdinal,
                                candidateSeat,
                                stream: "setup",
                                streamOrdinal,
                            }),
                        ),
                        combatSeed: take({
                            purpose,
                            panelId: spec.panelId,
                            cellId: cell.id,
                            scenarioOrdinal,
                            candidateSeat,
                            stream: "combat",
                            streamOrdinal: 0,
                        }),
                    });
                    pairs.push({
                        cellId: cell.id,
                        scenarioOrdinal,
                        scenarioId,
                        seats: { candidate_green: stream("candidate_green"), candidate_red: stream("candidate_red") },
                    });
                }
            }
        }
        const plan: IV07AlignedV2InjectedSeedPlan = {
            schemaVersion: 1,
            panelId: spec.panelId,
            purpose,
            scenariosPerCell: spec.scenariosPerCell,
            denysetSha256: corpusAttestation.denysetSha256,
            pairs,
        };
        validateV07AlignedV2SeedPlan(plan);
        return { plan, audit };
    };

    const train = allocatePlan("train");
    const confirm = allocatePlan("confirm");
    const final = allocatePlan("final");
    const trainPlanSha256 = fingerprintV07AlignedV2SeedPlan(train.plan);
    const confirmPlanSha256 = fingerprintV07AlignedV2SeedPlan(confirm.plan);
    const finalPlanSha256 = fingerprintV07AlignedV2SeedPlan(final.plan);
    const finalPanelBinding = bindV07AlignedV2SeedPlan(final.plan);
    const allPlanCommitmentsSha256 = fingerprintV07AlignedV2({
        trainPlanSha256,
        confirmPlanSha256,
        finalPlanSha256,
    });
    const total = sumCollisionAudits([train.audit, confirm.audit, final.audit]);
    const collisionAudit: IV07AlignedV2SeedAllocationCollisionAudit = {
        train: train.audit,
        confirm: confirm.audit,
        final: final.audit,
        total,
        allocationTranscriptSha256: transcript.digest("hex"),
    };
    const unsigned: IV07AlignedV2SeedAllocationCommitmentUnsigned = {
        schemaVersion: 1,
        kind: "v0.7_aligned_v2_seed_allocation_commitment",
        construction: V07_ALIGNED_V2_SEED_CONSTRUCTION,
        request,
        allocationRequestSha256,
        corpusAttestation,
        corpusAttestationSha256: corpusAttestation.attestationSha256,
        denysetSha256: corpusAttestation.denysetSha256,
        secretCommitmentSha256: secretCommitment(secret),
        trainPlan: train.plan,
        trainPlanSha256,
        confirmPlan: confirm.plan,
        confirmPlanSha256,
        finalPlanDescriptor: {
            panelId: final.plan.panelId,
            purpose: "final",
            scenariosPerCell: final.plan.scenariosPerCell,
        },
        finalPlanSha256,
        finalTaskCount: finalPanelBinding.taskCount,
        finalTasksSha256: finalPanelBinding.tasksSha256,
        allPlanCommitmentsSha256,
        collisionAudit,
    };
    const commitment: IV07AlignedV2SeedAllocationCommitment = {
        ...unsigned,
        commitmentSha256: fingerprintV07AlignedV2(unsigned),
    };
    validateV07AlignedV2SeedAllocationCommitment(commitment);
    return { commitment, finalPlan: final.plan };
}

/** Commit train/confirm plans and the final plan hash. The final plan itself is deliberately discarded. */
export function commitV07AlignedV2SeedAllocation(
    request: IV07AlignedV2SeedAllocationRequest,
    corpus: IV07AlignedV2SeedCorpus,
    secret: Uint8Array,
): IV07AlignedV2SeedAllocationCommitment {
    return allocateV07AlignedV2SeedPlans(request, corpus, secret).commitment;
}

function* planSeeds(plan: IV07AlignedV2InjectedSeedPlan): Generator<number> {
    for (const pair of plan.pairs) {
        const green = pair.seats.candidate_green;
        const red = pair.seats.candidate_red;
        if (green.combatSeed === red.combatSeed) {
            yield* green.setupSeeds;
            yield green.combatSeed;
        } else {
            yield* green.setupSeeds;
            yield green.combatSeed;
            yield* red.setupSeeds;
            yield red.combatSeed;
        }
    }
}

function assertPlansDisjoint(plans: readonly IV07AlignedV2InjectedSeedPlan[]): void {
    const seen = new Map<number, string>();
    for (const plan of plans) {
        for (const seed of planSeeds(plan)) {
            const prior = seen.get(seed);
            if (prior) throw new Error(`aligned-v2 cross-plan seed collision between ${prior} and ${plan.panelId}`);
            seen.set(seed, plan.panelId);
        }
    }
}

function validateCollisionAudit(value: unknown, label: string): IV07AlignedV2SeedCollisionAudit {
    const audit = requireRecord(value, label);
    if (
        !hasExactKeys(audit, [
            "candidatesExamined",
            "acceptedSeeds",
            "rejectedCandidates",
            "localDenysetHits",
            "zincDenysetHits",
            "committedManifestHits",
            "withinPlanHits",
            "maxAttempt",
        ])
    ) {
        throw new Error(`${label} fields are not exact`);
    }
    for (const [key, entry] of Object.entries(audit)) {
        if (!Number.isSafeInteger(entry) || (entry as number) < 0) throw new Error(`${label}.${key} is invalid`);
    }
    if (audit.candidatesExamined !== (audit.acceptedSeeds as number) + (audit.rejectedCandidates as number)) {
        throw new Error(`${label} candidate counts do not balance`);
    }
    if (
        [audit.localDenysetHits, audit.zincDenysetHits, audit.committedManifestHits, audit.withinPlanHits].some(
            (hits) => (hits as number) > (audit.rejectedCandidates as number),
        )
    ) {
        throw new Error(`${label} collision reason count exceeds rejectedCandidates`);
    }
    return audit as unknown as IV07AlignedV2SeedCollisionAudit;
}

function unsignedCommitment(
    commitment: IV07AlignedV2SeedAllocationCommitment,
): IV07AlignedV2SeedAllocationCommitmentUnsigned {
    return Object.fromEntries(
        Object.entries(commitment).filter(([key]) => key !== "commitmentSha256"),
    ) as unknown as IV07AlignedV2SeedAllocationCommitmentUnsigned;
}

export function validateV07AlignedV2SeedAllocationCommitment(value: unknown): IV07AlignedV2SeedAllocationCommitment {
    const record = requireRecord(value, "seed allocation commitment");
    if (
        !hasExactKeys(record, [
            "schemaVersion",
            "kind",
            "construction",
            "request",
            "allocationRequestSha256",
            "corpusAttestation",
            "corpusAttestationSha256",
            "denysetSha256",
            "secretCommitmentSha256",
            "trainPlan",
            "trainPlanSha256",
            "confirmPlan",
            "confirmPlanSha256",
            "finalPlanDescriptor",
            "finalPlanSha256",
            "finalTaskCount",
            "finalTasksSha256",
            "allPlanCommitmentsSha256",
            "collisionAudit",
            "commitmentSha256",
        ]) ||
        record.schemaVersion !== 1 ||
        record.kind !== "v0.7_aligned_v2_seed_allocation_commitment" ||
        record.construction !== V07_ALIGNED_V2_SEED_CONSTRUCTION
    ) {
        throw new Error("seed allocation commitment envelope is malformed");
    }
    const request = validateV07AlignedV2SeedAllocationRequest(record.request);
    const allocationRequestSha256 = requireSha256(record.allocationRequestSha256, "allocationRequestSha256");
    if (fingerprintV07AlignedV2(request) !== allocationRequestSha256) {
        throw new Error("seed allocation request fingerprint mismatch");
    }
    const corpusAttestation = validateV07AlignedV2SeedCorpusAttestation(record.corpusAttestation);
    if (request.mode === "production") validateV07AlignedV2ProductionManifestCensus(corpusAttestation);
    if (
        record.corpusAttestationSha256 !== corpusAttestation.attestationSha256 ||
        record.denysetSha256 !== corpusAttestation.denysetSha256
    ) {
        throw new Error("seed allocation commitment corpus binding mismatch");
    }
    requireSha256(record.secretCommitmentSha256, "secretCommitmentSha256");
    const trainPlan = record.trainPlan as IV07AlignedV2InjectedSeedPlan;
    const confirmPlan = record.confirmPlan as IV07AlignedV2InjectedSeedPlan;
    validateV07AlignedV2SeedPlan(trainPlan);
    validateV07AlignedV2SeedPlan(confirmPlan);
    if (
        trainPlan.purpose !== "train" ||
        trainPlan.panelId !== request.panels.train.panelId ||
        trainPlan.scenariosPerCell !== request.panels.train.scenariosPerCell ||
        confirmPlan.purpose !== "confirm" ||
        confirmPlan.panelId !== request.panels.confirm.panelId ||
        confirmPlan.scenariosPerCell !== request.panels.confirm.scenariosPerCell ||
        trainPlan.denysetSha256 !== corpusAttestation.denysetSha256 ||
        confirmPlan.denysetSha256 !== corpusAttestation.denysetSha256
    ) {
        throw new Error("committed train/confirm plan metadata does not match the request and denyset");
    }
    const trainPlanSha256 = requireSha256(record.trainPlanSha256, "trainPlanSha256");
    const confirmPlanSha256 = requireSha256(record.confirmPlanSha256, "confirmPlanSha256");
    const finalPlanSha256 = requireSha256(record.finalPlanSha256, "finalPlanSha256");
    requireSha256(record.finalTasksSha256, "finalTasksSha256");
    if (
        fingerprintV07AlignedV2SeedPlan(trainPlan) !== trainPlanSha256 ||
        fingerprintV07AlignedV2SeedPlan(confirmPlan) !== confirmPlanSha256
    ) {
        throw new Error("committed train/confirm plan fingerprint mismatch");
    }
    const descriptor = requireRecord(record.finalPlanDescriptor, "finalPlanDescriptor");
    if (
        !hasExactKeys(descriptor, ["panelId", "purpose", "scenariosPerCell"]) ||
        descriptor.panelId !== request.panels.final.panelId ||
        descriptor.purpose !== "final" ||
        descriptor.scenariosPerCell !== request.panels.final.scenariosPerCell
    ) {
        throw new Error("final plan descriptor does not match the allocation request");
    }
    const allPlanCommitmentsSha256 = requireSha256(record.allPlanCommitmentsSha256, "allPlanCommitmentsSha256");
    if (fingerprintV07AlignedV2({ trainPlanSha256, confirmPlanSha256, finalPlanSha256 }) !== allPlanCommitmentsSha256) {
        throw new Error("three-plan commitment family hash mismatch");
    }
    assertPlansDisjoint([trainPlan, confirmPlan]);
    const collision = requireRecord(record.collisionAudit, "collisionAudit");
    if (!hasExactKeys(collision, ["train", "confirm", "final", "total", "allocationTranscriptSha256"])) {
        throw new Error("collisionAudit fields are not exact");
    }
    const trainAudit = validateCollisionAudit(collision.train, "collisionAudit.train");
    const confirmAudit = validateCollisionAudit(collision.confirm, "collisionAudit.confirm");
    const finalAudit = validateCollisionAudit(collision.final, "collisionAudit.final");
    const totalAudit = validateCollisionAudit(collision.total, "collisionAudit.total");
    if (
        canonicalV07AlignedV2Json(sumCollisionAudits([trainAudit, confirmAudit, finalAudit])) !==
        canonicalV07AlignedV2Json(totalAudit)
    ) {
        throw new Error("collisionAudit total does not equal its three panels");
    }
    const uniqueSeedsPerScenario = V07_ALIGNED_V2_EVALUATOR_CELLS.reduce(
        (sum, cell) => sum + (cell.distribution === "ranked_taxonomy" ? 258 : 2),
        0,
    );
    const expectedAccepted = (scenariosPerCell: number): number => scenariosPerCell * uniqueSeedsPerScenario;
    if (
        trainAudit.acceptedSeeds !== expectedAccepted(trainPlan.scenariosPerCell) ||
        confirmAudit.acceptedSeeds !== expectedAccepted(confirmPlan.scenariosPerCell) ||
        finalAudit.acceptedSeeds !== expectedAccepted(request.panels.final.scenariosPerCell)
    ) {
        throw new Error("collisionAudit accepted counts do not match the exact evaluator panel shapes");
    }
    const expectedFinalTaskCount = V07_ALIGNED_V2_EVALUATOR_CELLS.length * 2 * request.panels.final.scenariosPerCell;
    if (record.finalTaskCount !== expectedFinalTaskCount) {
        throw new Error("finalTaskCount does not match the exact evaluator panel shape");
    }
    if (
        [trainAudit, confirmAudit, finalAudit, totalAudit].some(
            (audit) => audit.maxAttempt >= request.maxCandidatesPerSlot,
        )
    ) {
        throw new Error("collisionAudit maxAttempt exceeds maxCandidatesPerSlot");
    }
    requireSha256(collision.allocationTranscriptSha256, "collisionAudit.allocationTranscriptSha256");
    const typed = record as unknown as IV07AlignedV2SeedAllocationCommitment;
    const commitmentSha256 = requireSha256(record.commitmentSha256, "commitmentSha256");
    if (fingerprintV07AlignedV2(unsignedCommitment(typed)) !== commitmentSha256) {
        throw new Error("seed allocation commitment self-hash mismatch");
    }
    return typed;
}

function validateFreezeBinding(value: unknown, commitmentSha256: string): IV07AlignedV2CandidateFreezeBinding {
    const freeze = requireRecord(value, "candidate freeze binding");
    if (
        !hasExactKeys(freeze, [
            "schemaVersion",
            "kind",
            "commitmentSha256",
            "frozenCandidateSha256",
            "freezeArtifactSha256",
        ]) ||
        freeze.schemaVersion !== 1 ||
        freeze.kind !== "v0.7_aligned_v2_candidate_freeze_binding" ||
        freeze.commitmentSha256 !== commitmentSha256
    ) {
        throw new Error("candidate freeze binding is missing or belongs to another allocation commitment");
    }
    requireSha256(freeze.frozenCandidateSha256, "frozenCandidateSha256");
    requireSha256(freeze.freezeArtifactSha256, "freezeArtifactSha256");
    return freeze as unknown as IV07AlignedV2CandidateFreezeBinding;
}

/** Regenerate and reveal the precommitted final plan only after an immutable candidate freeze is bound. */
export function revealV07AlignedV2FinalSeedPlan(options: {
    commitment: IV07AlignedV2SeedAllocationCommitment;
    corpus: IV07AlignedV2SeedCorpus;
    secret: Uint8Array;
    freeze: IV07AlignedV2CandidateFreezeBinding;
}): IV07AlignedV2FinalSeedReveal {
    const commitment = validateV07AlignedV2SeedAllocationCommitment(options.commitment);
    const freeze = validateFreezeBinding(options.freeze, commitment.commitmentSha256);
    if (secretCommitment(options.secret) !== commitment.secretCommitmentSha256) {
        throw new Error("seed allocation secret does not open the commitment");
    }
    const regenerated = allocateV07AlignedV2SeedPlans(commitment.request, options.corpus, options.secret);
    if (canonicalV07AlignedV2Json(regenerated.commitment) !== canonicalV07AlignedV2Json(commitment)) {
        throw new Error("seed allocation inputs do not reproduce the committed allocation");
    }
    const unsigned: IV07AlignedV2FinalSeedRevealUnsigned = {
        schemaVersion: 1,
        kind: "v0.7_aligned_v2_final_seed_reveal",
        allocationId: commitment.request.allocationId,
        commitmentSha256: commitment.commitmentSha256,
        frozenCandidateSha256: freeze.frozenCandidateSha256,
        freezeArtifactSha256: freeze.freezeArtifactSha256,
        finalPlan: regenerated.finalPlan,
        finalPlanSha256: commitment.finalPlanSha256,
    };
    const reveal: IV07AlignedV2FinalSeedReveal = {
        ...unsigned,
        finalPlanRevealSha256: fingerprintV07AlignedV2(unsigned),
    };
    validateV07AlignedV2FinalSeedReveal(reveal, commitment, {
        genomeSha256: freeze.frozenCandidateSha256,
        freezeArtifactSha256: freeze.freezeArtifactSha256,
    });
    return reveal;
}

function unsignedReveal(reveal: IV07AlignedV2FinalSeedReveal): IV07AlignedV2FinalSeedRevealUnsigned {
    return Object.fromEntries(
        Object.entries(reveal).filter(([key]) => key !== "finalPlanRevealSha256"),
    ) as unknown as IV07AlignedV2FinalSeedRevealUnsigned;
}

export function validateV07AlignedV2FinalSeedReveal(
    value: unknown,
    rawCommitment: IV07AlignedV2SeedAllocationCommitment,
    frozenCandidate: IV07AlignedV2FrozenCandidateProof,
): IV07AlignedV2FinalSeedReveal {
    const commitment = validateV07AlignedV2SeedAllocationCommitment(rawCommitment);
    const record = requireRecord(value, "final seed reveal");
    if (
        !hasExactKeys(record, [
            "schemaVersion",
            "kind",
            "allocationId",
            "commitmentSha256",
            "frozenCandidateSha256",
            "freezeArtifactSha256",
            "finalPlan",
            "finalPlanSha256",
            "finalPlanRevealSha256",
        ]) ||
        record.schemaVersion !== 1 ||
        record.kind !== "v0.7_aligned_v2_final_seed_reveal" ||
        record.allocationId !== commitment.request.allocationId ||
        record.commitmentSha256 !== commitment.commitmentSha256
    ) {
        throw new Error("final seed reveal envelope is malformed or belongs to another commitment");
    }
    requireSha256(record.frozenCandidateSha256, "final reveal frozenCandidateSha256");
    requireSha256(record.freezeArtifactSha256, "final reveal freezeArtifactSha256");
    const frozenProof = requireRecord(frozenCandidate, "frozen candidate proof");
    if (!hasExactKeys(frozenProof, ["genomeSha256", "freezeArtifactSha256"])) {
        throw new Error("frozen candidate proof fields are not exact");
    }
    requireSha256(frozenProof.genomeSha256, "frozen candidate genomeSha256");
    requireSha256(frozenProof.freezeArtifactSha256, "frozen candidate freezeArtifactSha256");
    if (
        record.frozenCandidateSha256 !== frozenProof.genomeSha256 ||
        record.freezeArtifactSha256 !== frozenProof.freezeArtifactSha256
    ) {
        throw new Error("final seed reveal does not bind the supplied immutable candidate freeze");
    }
    const plan = record.finalPlan as IV07AlignedV2InjectedSeedPlan;
    validateV07AlignedV2SeedPlan(plan);
    if (
        plan.purpose !== "final" ||
        plan.panelId !== commitment.finalPlanDescriptor.panelId ||
        plan.scenariosPerCell !== commitment.finalPlanDescriptor.scenariosPerCell ||
        plan.denysetSha256 !== commitment.denysetSha256
    ) {
        throw new Error("revealed final plan metadata does not match its commitment");
    }
    if (
        record.finalPlanSha256 !== commitment.finalPlanSha256 ||
        fingerprintV07AlignedV2SeedPlan(plan) !== commitment.finalPlanSha256 ||
        bindV07AlignedV2SeedPlan(plan).taskCount !== commitment.finalTaskCount ||
        bindV07AlignedV2SeedPlan(plan).tasksSha256 !== commitment.finalTasksSha256
    ) {
        throw new Error("revealed final plan does not open finalPlanSha256");
    }
    assertPlansDisjoint([commitment.trainPlan, commitment.confirmPlan, plan]);
    const typed = record as unknown as IV07AlignedV2FinalSeedReveal;
    const revealSha256 = requireSha256(record.finalPlanRevealSha256, "finalPlanRevealSha256");
    if (fingerprintV07AlignedV2(unsignedReveal(typed)) !== revealSha256) {
        throw new Error("final seed reveal self-hash mismatch");
    }
    return typed;
}

export function resolveV07AlignedV2SeedPlans(
    rawCommitment: IV07AlignedV2SeedAllocationCommitment,
    rawReveal: IV07AlignedV2FinalSeedReveal,
    frozenCandidate: IV07AlignedV2FrozenCandidateProof,
): IV07AlignedV2ResolvedSeedPlans {
    const commitment = validateV07AlignedV2SeedAllocationCommitment(rawCommitment);
    const reveal = validateV07AlignedV2FinalSeedReveal(rawReveal, commitment, frozenCandidate);
    assertPlansDisjoint([commitment.trainPlan, commitment.confirmPlan, reveal.finalPlan]);
    return {
        train: commitment.trainPlan,
        confirm: commitment.confirmPlan,
        final: reveal.finalPlan,
    };
}

export function resolveV07AlignedV2SeedPlanByBinding(
    rawCommitment: IV07AlignedV2SeedAllocationCommitment,
    rawReveal: IV07AlignedV2FinalSeedReveal,
    frozenCandidate: IV07AlignedV2FrozenCandidateProof,
    binding: IV07AlignedV2SeedPlanBinding,
): IV07AlignedV2InjectedSeedPlan {
    if (!binding.panelId.trim()) throw new Error("seed plan binding panelId must not be empty");
    requireSha256(binding.panelFingerprint, "seed plan binding panelFingerprint");
    const plans = Object.values(resolveV07AlignedV2SeedPlans(rawCommitment, rawReveal, frozenCandidate));
    const matches = plans.filter(
        (plan) =>
            plan.panelId === binding.panelId && fingerprintV07AlignedV2SeedPlan(plan) === binding.panelFingerprint,
    );
    if (matches.length !== 1) throw new Error("seed plan binding does not resolve to exactly one committed panel");
    return matches[0]!;
}

function syntheticScan(site: ScanSite, seeds: readonly number[]): IV07AlignedV2SeedScanReplayInput {
    const canonicalSeeds = [...sortedUniqueUint32(seeds)];
    const seedSetBytes = canonicalSeeds.length ? `${canonicalSeeds.join("\n")}\n` : "";
    const summaryBytes = `${JSON.stringify({
        schemaVersion: 1,
        scanPolicy: V07_COMPOSED_SEED_SCAN_POLICY,
        cutoff: "2026-07-16T00:00:00Z",
        uniqueSeeds: canonicalSeeds.length,
        corpusFileSnapshotSha256: fingerprintV07AlignedV2({ site, synthetic: true }),
        corpusSeedSetSha256: sha256(seedSetBytes),
    })}\n`;
    return {
        site,
        first: { summaryBytes, seedSetBytes },
        replay: { summaryBytes, seedSetBytes },
    };
}

/** Exercise the complete commitment/freeze/reveal path with small, explicitly synthetic inputs only. */
export function runV07AlignedV2SyntheticSeedAllocationDryRun(): IV07AlignedV2SyntheticSeedDryRunReport {
    const corpus = ingestV07AlignedV2SeedCorpus({
        scans: [syntheticScan("local", [0, 1, 7, 22]), syntheticScan("zinc", [2, 7, 23, 0xffffffff])],
        committedManifests: [
            {
                path: "synthetic/prior-seed-series.json",
                bytes: `${JSON.stringify({
                    schemaVersion: 1,
                    pairSeedStep: 0x9e3779b1,
                    expectedDerivedScenarioSeeds: 2,
                    seedSeries: [{ id: "synthetic", baseSeed: 3, streams: 1, streamStride: 0, gamesPerStream: 4 }],
                })}\n`,
            },
        ],
    });
    const request: IV07AlignedV2SeedAllocationRequest = {
        schemaVersion: 1,
        mode: "synthetic_dry_run",
        allocationId: "synthetic-dry-run-v1",
        domain: V07_ALIGNED_V2_SEED_ALLOCATION_DOMAIN,
        panels: {
            train: { panelId: "synthetic-train", scenariosPerCell: 1 },
            confirm: { panelId: "synthetic-confirm", scenariosPerCell: 1 },
            final: { panelId: "synthetic-final", scenariosPerCell: 1 },
        },
        maxCandidatesPerSlot: 32,
    };
    const secret = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const commitment = commitV07AlignedV2SeedAllocation(request, corpus, secret);
    const reveal = revealV07AlignedV2FinalSeedPlan({
        commitment,
        corpus,
        secret,
        freeze: {
            schemaVersion: 1,
            kind: "v0.7_aligned_v2_candidate_freeze_binding",
            commitmentSha256: commitment.commitmentSha256,
            frozenCandidateSha256: "c".repeat(64),
            freezeArtifactSha256: "f".repeat(64),
        },
    });
    const resolved = resolveV07AlignedV2SeedPlans(commitment, reveal, {
        genomeSha256: "c".repeat(64),
        freezeArtifactSha256: "f".repeat(64),
    });
    return {
        schemaVersion: 1,
        kind: "v0.7_aligned_v2_synthetic_seed_dry_run",
        verdict: "PASS",
        seedMaterial: "synthetic_only",
        corpusAttestationSha256: corpus.attestation.attestationSha256,
        denysetUniqueSeeds: corpus.attestation.denysetUniqueSeeds,
        commitmentSha256: commitment.commitmentSha256,
        trainPlanSha256: commitment.trainPlanSha256,
        confirmPlanSha256: commitment.confirmPlanSha256,
        finalPlanSha256: commitment.finalPlanSha256,
        finalPlanRevealSha256: reveal.finalPlanRevealSha256,
        resolvedPanels: Object.keys(resolved).length,
        crossPlanDisjoint: true,
    };
}
