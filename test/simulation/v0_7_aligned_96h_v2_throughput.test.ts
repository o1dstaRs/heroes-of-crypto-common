/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, availableParallelism, hostname, platform, release } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

import { describe, expect, it } from "bun:test";

import {
    buildV07AlignedV2ThroughputBatchPlan,
    buildV07AlignedV2ProductionThroughputAttestation,
    buildV07AlignedV2ThroughputRequest,
    buildV07AlignedV2ThroughputSeedReceipt,
    buildV07AlignedV2ThroughputWorstCostGenome,
    replayV07AlignedV2ThroughputEvidence,
    validateV07AlignedV2ProductionThroughputAttestation,
    validateV07AlignedV2ThroughputSeedReceipt,
    V07_ALIGNED_V2_THROUGHPUT_BATCHES,
    V07_ALIGNED_V2_THROUGHPUT_DIAGNOSTIC_PLAN_SHA256,
    V07_ALIGNED_V2_THROUGHPUT_GAMES,
    V07_ALIGNED_V2_THROUGHPUT_GAMES_PER_BATCH,
    V07_ALIGNED_V2_THROUGHPUT_SCENARIOS_PER_CELL,
    V07_ALIGNED_V2_THROUGHPUT_SELECTED_SEEDS,
    V07_ALIGNED_V2_THROUGHPUT_SOURCE_MANIFEST_BYTES_SHA256,
    V07_ALIGNED_V2_THROUGHPUT_WORST_COST_GENOME_SHA256,
    type IV07AlignedV2ThroughputArtifactRef,
    type IV07AlignedV2ThroughputBatchManifest,
    type IV07AlignedV2ThroughputEvidenceManifest,
    type IV07AlignedV2ThroughputProvenance,
} from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_throughput";
import {
    bindV07AlignedV2Candidate,
    buildV07AlignedV2CheckpointShardSpecs,
    canonicalV07AlignedV2Json,
    fingerprintV07AlignedV2,
    fingerprintV07AlignedV2CandidateGenome,
    flattenV07AlignedV2SeedPlan,
} from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_protocol";
import { v07AlignedV2ShardArtifactDirectoryName } from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_persistence";

const SOURCE_MANIFEST = join(
    import.meta.dir,
    "../../src/simulation/manifests/v0_7_composed_ranked_ladder_20260716.json",
);
const HOUR_MS = 3_600_000;

function sha256(value: string | Buffer): string {
    return createHash("sha256").update(value).digest("hex");
}

function canonicalFile(value: unknown): string {
    return `${canonicalV07AlignedV2Json(value)}\n`;
}

function writeCanonical(path: string, value: unknown): Buffer {
    const bytes = Buffer.from(canonicalFile(value));
    writeFileSync(path, bytes);
    return bytes;
}

function ref(path: string, value: unknown): IV07AlignedV2ThroughputArtifactRef {
    const bytes = Buffer.from(canonicalFile(value));
    return { path, bytesSha256: sha256(bytes), semanticSha256: fingerprintV07AlignedV2(value) };
}

function provenance(): IV07AlignedV2ThroughputProvenance {
    return {
        commit: "a".repeat(40),
        sourceTreeSha256: "b".repeat(64),
        bunVersion: process.versions.bun ?? "test-bun",
        bunRevision: "test-revision",
        bunExecutableSha256: sha256(readFileSync(process.execPath)),
        dependencyManifestSha256: "c".repeat(64),
        lockfileSha256: null,
        hostFingerprintSha256: fingerprintV07AlignedV2({
            hostname: hostname(),
            platform: platform(),
            architecture: arch(),
            release: release(),
            logicalCpus: availableParallelism(),
        }),
    };
}

function createReplayFixture(): {
    root: string;
    evidence: IV07AlignedV2ThroughputEvidenceManifest;
} {
    const root = mkdtempSync(join(tmpdir(), "aligned-v2-throughput-replay-"));
    const sourceBytes = readFileSync(SOURCE_MANIFEST);
    const { receipt, plan } = buildV07AlignedV2ThroughputSeedReceipt(sourceBytes);
    const concurrentShards = Math.min(3, availableParallelism());
    const geometry = {
        logicalCpus: availableParallelism(),
        reservedCpus: 0,
        workersPerShard: 1,
        concurrentShards,
        maxScenarioPairsPerShard: 17,
        shardTimeoutMinutes: 1,
    };
    const request = buildV07AlignedV2ThroughputRequest({ geometry, provenance: provenance(), receipt, plan });
    writeFileSync(join(root, "source-manifest.json"), sourceBytes);
    writeCanonical(join(root, "receipt.json"), receipt);
    writeCanonical(join(root, "plan.json"), plan);
    writeCanonical(join(root, "request.json"), request);
    const batchesRoot = join(root, "batches");
    mkdirSync(batchesRoot);
    const binding = bindV07AlignedV2Candidate(buildV07AlignedV2ThroughputWorstCostGenome());
    const batchManifests: IV07AlignedV2ThroughputBatchManifest[] = [];
    for (let batchIndex = 0; batchIndex < V07_ALIGNED_V2_THROUGHPUT_BATCHES; batchIndex += 1) {
        const name = `batch-${String(batchIndex).padStart(3, "0")}`;
        const directory = join(batchesRoot, name);
        const shardsDirectory = join(directory, "shards");
        mkdirSync(directory);
        mkdirSync(shardsDirectory);
        const batchPlan = buildV07AlignedV2ThroughputBatchPlan(plan, batchIndex);
        writeCanonical(join(directory, "plan.json"), batchPlan);
        const planRef = ref(`batches/${name}/plan.json`, batchPlan);
        const shards = buildV07AlignedV2CheckpointShardSpecs({
            runFingerprint: request.runFingerprint,
            seedPlan: batchPlan,
            binding,
            maxScenarioPairsPerShard: geometry.maxScenarioPairsPerShard,
        });
        const shardRefs = shards.map((shard) => {
            const shardName = v07AlignedV2ShardArtifactDirectoryName(shard);
            mkdirSync(join(shardsDirectory, shardName));
            return {
                directory: `batches/${name}/shards/${shardName}`,
                manifestSha256: fingerprintV07AlignedV2({ shard: shard.shardSha256, fixture: true }),
                games: (shard.pairEndExclusive - shard.pairStart) * 2,
                workerAttestations: 1,
            };
        });
        const elapsedMs = 1_000 + batchIndex;
        const unsigned = {
            schemaVersion: 1 as const,
            artifactKind: "v0_7_aligned_96h_v2_throughput_batch" as const,
            status: "research_only_no_bake" as const,
            automaticBake: false as const,
            automaticDeploy: false as const,
            batchIndex,
            requestSha256: request.requestSha256,
            runFingerprint: request.runFingerprint,
            plan: planRef,
            startedAtMs: 10_000 + batchIndex * 2_000,
            endedAtMs: 11_000 + batchIndex * 2_000,
            elapsedMs,
            games: V07_ALIGNED_V2_THROUGHPUT_GAMES_PER_BATCH,
            workerAttestations: shardRefs.length,
            shards: shardRefs,
            gamesPerWorkerHour:
                (V07_ALIGNED_V2_THROUGHPUT_GAMES_PER_BATCH * HOUR_MS) /
                (elapsedMs * geometry.workersPerShard * geometry.concurrentShards),
        };
        const batch: IV07AlignedV2ThroughputBatchManifest = {
            ...unsigned,
            batchSha256: fingerprintV07AlignedV2(unsigned),
        };
        expect(shardRefs).toHaveLength(23);
        if (concurrentShards > 1) expect(shardRefs.length % concurrentShards).not.toBe(0);
        writeCanonical(join(directory, "batch.json"), batch);
        batchManifests.push(batch);
    }
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
        receipt: ref("receipt.json", receipt),
        plan: ref("plan.json", plan),
        request: ref("request.json", request),
        batches: batchManifests.map((batch, index) =>
            ref(`batches/batch-${String(index).padStart(3, "0")}/batch.json`, batch),
        ),
        sampleGames: V07_ALIGNED_V2_THROUGHPUT_GAMES,
        sampleGamesPerCellSeat: V07_ALIGNED_V2_THROUGHPUT_SCENARIOS_PER_CELL,
        totalElapsedMs: batchManifests.reduce((sum, batch) => sum + batch.elapsedMs, 0),
        minimumBatchGamesPerWorkerHour: Math.min(...batchManifests.map((batch) => batch.gamesPerWorkerHour)),
        persistedReplayVerified: true as const,
        workerAttestationsVerified: true as const,
    };
    const evidence: IV07AlignedV2ThroughputEvidenceManifest = {
        ...unsignedEvidence,
        evidenceSha256: fingerprintV07AlignedV2(unsignedEvidence),
    };
    writeCanonical(join(root, "evidence.json"), evidence);
    return { root, evidence };
}

describe("v0.7 aligned 96-hour v2 throughput evidence", () => {
    it("reconstructs the frozen 268,288-seed diagnostic plan only through the committed affine expander", () => {
        const sourceBytes = readFileSync(SOURCE_MANIFEST);
        const { receipt, plan } = buildV07AlignedV2ThroughputSeedReceipt(sourceBytes);
        const tasks = flattenV07AlignedV2SeedPlan(plan);

        expect(sha256(sourceBytes)).toBe(V07_ALIGNED_V2_THROUGHPUT_SOURCE_MANIFEST_BYTES_SHA256);
        expect(receipt).toMatchObject({
            formalEligibility: "never_formal_preexisting_committed_denyset",
            sourceExpandedSeedCount: 1_081_000,
            selectedSeedCount: V07_ALIGNED_V2_THROUGHPUT_SELECTED_SEEDS,
            planSha256: V07_ALIGNED_V2_THROUGHPUT_DIAGNOSTIC_PLAN_SHA256,
        });
        expect(plan.pairs).toHaveLength(12 * V07_ALIGNED_V2_THROUGHPUT_SCENARIOS_PER_CELL);
        expect(tasks).toHaveLength(V07_ALIGNED_V2_THROUGHPUT_GAMES);
        expect(() => validateV07AlignedV2ThroughputSeedReceipt(receipt, sourceBytes, plan)).not.toThrow();

        const tampered = structuredClone(receipt);
        tampered.selectedSeedCount -= 1;
        expect(() => validateV07AlignedV2ThroughputSeedReceipt(tampered, sourceBytes, plan)).toThrow(
            "does not replay from the frozen committed manifest",
        );
    });

    it("partitions all twelve cells into eight disjoint, balanced 768-game batches", () => {
        const { plan } = buildV07AlignedV2ThroughputSeedReceipt(readFileSync(SOURCE_MANIFEST));
        const selectedSeeds = new Set<number>();
        for (let index = 0; index < V07_ALIGNED_V2_THROUGHPUT_BATCHES; index += 1) {
            const batch = buildV07AlignedV2ThroughputBatchPlan(plan, index);
            expect(batch.pairs).toHaveLength(12 * 32);
            expect(flattenV07AlignedV2SeedPlan(batch)).toHaveLength(V07_ALIGNED_V2_THROUGHPUT_GAMES_PER_BATCH);
            const batchSeeds = new Set(
                flattenV07AlignedV2SeedPlan(batch).flatMap((task) => [...task.setupSeeds, task.combatSeed]),
            );
            expect([...batchSeeds].some((seed) => selectedSeeds.has(seed))).toBe(false);
            batchSeeds.forEach((seed) => selectedSeeds.add(seed));
        }
        expect(selectedSeeds).toHaveLength(V07_ALIGNED_V2_THROUGHPUT_SELECTED_SEEDS);
    });

    it("freezes the designated worst-cost arm in the exact production catalog", () => {
        expect(fingerprintV07AlignedV2CandidateGenome(buildV07AlignedV2ThroughputWorstCostGenome())).toBe(
            V07_ALIGNED_V2_THROUGHPUT_WORST_COST_GENOME_SHA256,
        );
    });

    it("replays every batch/shard reference and derives the attested rate from the slowest complete batch", () => {
        const fixture = createReplayFixture();
        try {
            const loadShard = ((_directory, expectations) => {
                const games = (expectations.shard.pairEndExclusive - expectations.shard.pairStart) * 2;
                return {
                    directory: _directory,
                    manifest: {} as never,
                    manifestSha256: expectations.manifestSha256!,
                    evaluation: {
                        records: Array.from({ length: games }, () => ({})),
                        attestations: [{}],
                    } as never,
                    reused: true,
                };
            }) satisfies NonNullable<Parameters<typeof replayV07AlignedV2ThroughputEvidence>[2]["loadShard"]>;
            const replay = replayV07AlignedV2ThroughputEvidence(fixture.root, fixture.evidence.evidenceSha256, {
                loadShard: (_directory, expectations) => {
                    return loadShard(_directory, expectations);
                },
            });
            expect(replay.batches).toHaveLength(V07_ALIGNED_V2_THROUGHPUT_BATCHES);
            expect(replay.evidence.minimumBatchGamesPerWorkerHour).toBe(
                Math.min(...replay.batches.map((batch) => batch.gamesPerWorkerHour)),
            );
            const configRoot = join(fixture.root, "..");
            const attestation = buildV07AlignedV2ProductionThroughputAttestation({
                replay,
                evidenceRootPath: fixture.root.split("/").at(-1)!,
            });
            expect(
                validateV07AlignedV2ProductionThroughputAttestation(attestation, {
                    configRoot,
                    expected: {
                        ...replay.request.geometry,
                        gamesPerWorkerHour: replay.evidence.minimumBatchGamesPerWorkerHour,
                    },
                    expectedAttestationSha256: attestation.attestationSha256,
                    replayDependencies: { loadShard },
                }).replay.evidence.evidenceSha256,
            ).toBe(fixture.evidence.evidenceSha256);

            writeFileSync(join(fixture.root, "rogue.json"), "{}\n");
            expect(() => replayV07AlignedV2ThroughputEvidence(fixture.root)).toThrow("inventory is not exact");
        } finally {
            rmSync(fixture.root, { recursive: true, force: true });
        }
    });
});
