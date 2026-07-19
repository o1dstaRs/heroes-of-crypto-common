/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, availableParallelism, hostname, platform, release, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { describe, expect, it } from "bun:test";

import { V08_ALIGNED_96H_V1_VERSION_PROFILE } from "../../src/simulation/optimizer/aligned_96h_version_profile";
import { V08_ALIGNED_V1_PRODUCTION_CATALOG_SHA256 } from "../../src/simulation/optimizer/v0_8_aligned_96h_v1_catalog";
import { evaluateV07AlignedV2Shard } from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_evaluator";
import {
    loadV07AlignedV2PersistedShard,
    persistV07AlignedV2ShardEvaluation,
    v07AlignedV2ShardArtifactDirectoryName,
} from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_persistence";
import {
    buildAligned96hCheckpointShardSpecs,
    canonicalV07AlignedV2Json,
    fingerprintV07AlignedV2,
    V07_ALIGNED_V2_EVALUATOR_CELLS,
    type IV07AlignedV2InjectedSeedPlan,
} from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_protocol";
import {
    buildV07AlignedV2ThroughputSeedReceipt,
    buildV08AlignedV1ProductionThroughputAttestation,
    buildV08AlignedV1ThroughputBatchPlan,
    buildV08AlignedV1ThroughputCodeLedger,
    buildV08AlignedV1ThroughputRequest,
    buildV08AlignedV1ThroughputSeedReceipt,
    buildV08AlignedV1ThroughputWorstCostGenome,
    replayV08AlignedV1ThroughputEvidence,
    validateV07AlignedV2ProductionThroughputAttestation,
    validateV07AlignedV2ThroughputRequest,
    validateV08AlignedV1ProductionThroughputAttestation,
    validateV08AlignedV1ThroughputRequest,
    validateV08AlignedV1ThroughputSeedReceipt,
    V07_ALIGNED_V2_THROUGHPUT_BATCHES,
    V07_ALIGNED_V2_THROUGHPUT_GAMES,
    V07_ALIGNED_V2_THROUGHPUT_GAMES_PER_BATCH,
    V07_ALIGNED_V2_THROUGHPUT_SCENARIOS_PER_CELL,
    V07_ALIGNED_V2_THROUGHPUT_SOURCE_MANIFEST_BYTES_SHA256,
    V08_ALIGNED_V1_THROUGHPUT_DIAGNOSTIC_PLAN_SHA256,
    V08_ALIGNED_V1_THROUGHPUT_WORST_COST_GENOME_SHA256,
    type IV07AlignedV2ThroughputArtifactRef,
    type IV07AlignedV2ThroughputGeometry,
    type IV07AlignedV2ThroughputProvenance,
    type IV08AlignedV1ThroughputBatchManifest,
    type IV08AlignedV1ThroughputEvidenceManifest,
    type IV08AlignedV1ThroughputReplayDependencies,
} from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_throughput";
import {
    bindV08AlignedV1Candidate,
    fingerprintV08AlignedV1CandidateGenome,
    flattenV08AlignedV1SeedPlan,
    type IV08AlignedV1InjectedSeedPlan,
} from "../../src/simulation/optimizer/v0_8_aligned_96h_v1_protocol";

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

function writeCanonical(path: string, value: unknown): void {
    writeFileSync(path, canonicalFile(value));
}

function artifactRef(path: string, value: unknown): IV07AlignedV2ThroughputArtifactRef {
    const bytes = canonicalFile(value);
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

function geometry(maxScenarioPairsPerShard = 17): IV07AlignedV2ThroughputGeometry {
    return {
        logicalCpus: availableParallelism(),
        reservedCpus: 0,
        workersPerShard: 1,
        concurrentShards: 1,
        maxScenarioPairsPerShard,
        shardTimeoutMinutes: 1,
    };
}

function legacyGeometryPlan(plan: IV08AlignedV1InjectedSeedPlan): IV07AlignedV2InjectedSeedPlan {
    return {
        schemaVersion: plan.schemaVersion,
        panelId: plan.panelId,
        purpose: plan.purpose,
        scenariosPerCell: plan.scenariosPerCell,
        denysetSha256: plan.denysetSha256,
        pairs: structuredClone(plan.pairs),
    };
}

function createReplayFixture(): {
    root: string;
    evidence: IV08AlignedV1ThroughputEvidenceManifest;
    dependencies: IV08AlignedV1ThroughputReplayDependencies;
} {
    const root = mkdtempSync(join(tmpdir(), "hoc-v08-throughput-replay-"));
    const sourceBytes = readFileSync(SOURCE_MANIFEST);
    const { receipt, plan } = buildV08AlignedV1ThroughputSeedReceipt(sourceBytes);
    const request = buildV08AlignedV1ThroughputRequest({
        versionProfile: V08_ALIGNED_96H_V1_VERSION_PROFILE,
        geometry: geometry(),
        provenance: provenance(),
        receipt,
        plan,
    });
    const binding = bindV08AlignedV1Candidate(buildV08AlignedV1ThroughputWorstCostGenome());
    writeFileSync(join(root, "source-manifest.json"), sourceBytes);
    writeCanonical(join(root, "receipt.json"), receipt);
    writeCanonical(join(root, "plan.json"), plan);
    writeCanonical(join(root, "request.json"), request);
    const batchesRoot = join(root, "batches");
    mkdirSync(batchesRoot);
    const batches: IV08AlignedV1ThroughputBatchManifest[] = [];
    for (let batchIndex = 0; batchIndex < V07_ALIGNED_V2_THROUGHPUT_BATCHES; batchIndex += 1) {
        const batchName = `batch-${String(batchIndex).padStart(3, "0")}`;
        const batchDirectory = join(batchesRoot, batchName);
        const shardsDirectory = join(batchDirectory, "shards");
        mkdirSync(batchDirectory);
        mkdirSync(shardsDirectory);
        const batchPlan = buildV08AlignedV1ThroughputBatchPlan(plan, batchIndex);
        writeCanonical(join(batchDirectory, "plan.json"), batchPlan);
        const batchPlanRef = artifactRef(`batches/${batchName}/plan.json`, batchPlan);
        const shards = buildAligned96hCheckpointShardSpecs({
            runFingerprint: request.runFingerprint,
            seedPlan: legacyGeometryPlan(batchPlan),
            binding,
            maxScenarioPairsPerShard: request.geometry.maxScenarioPairsPerShard,
        });
        const shardRefs = shards.map((shard) => {
            const shardName = v07AlignedV2ShardArtifactDirectoryName(shard);
            mkdirSync(join(shardsDirectory, shardName));
            return {
                directory: `batches/${batchName}/shards/${shardName}`,
                manifestSha256: fingerprintV07AlignedV2({ shard: shard.shardSha256, fixture: true }),
                games: (shard.pairEndExclusive - shard.pairStart) * 2,
                workerAttestations: 1,
            };
        });
        const elapsedMs = 1_000 + batchIndex;
        const body = {
            schemaVersion: 1 as const,
            artifactKind: "v0_8_aligned_96h_v1_throughput_batch" as const,
            versionProfile: { ...V08_ALIGNED_96H_V1_VERSION_PROFILE },
            status: "research_only_no_bake" as const,
            automaticBake: false as const,
            automaticDeploy: false as const,
            batchIndex,
            requestSha256: request.requestSha256,
            runFingerprint: request.runFingerprint,
            plan: batchPlanRef,
            startedAtMs: 10_000 + batchIndex * 2_000,
            endedAtMs: 11_000 + batchIndex * 2_000 + batchIndex,
            elapsedMs,
            games: V07_ALIGNED_V2_THROUGHPUT_GAMES_PER_BATCH,
            workerAttestations: shardRefs.length,
            shards: shardRefs,
            gamesPerWorkerHour: V07_ALIGNED_V2_THROUGHPUT_GAMES_PER_BATCH * (HOUR_MS / elapsedMs),
        };
        const batch: IV08AlignedV1ThroughputBatchManifest = {
            ...body,
            batchSha256: fingerprintV07AlignedV2(body),
        };
        writeCanonical(join(batchDirectory, "batch.json"), batch);
        batches.push(batch);
    }
    const evidenceBody = {
        schemaVersion: 1 as const,
        artifactKind: "v0_8_aligned_96h_v1_throughput_evidence" as const,
        versionProfile: { ...V08_ALIGNED_96H_V1_VERSION_PROFILE },
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
        batches: batches.map((batch, index) =>
            artifactRef(`batches/batch-${String(index).padStart(3, "0")}/batch.json`, batch),
        ),
        sampleGames: V07_ALIGNED_V2_THROUGHPUT_GAMES,
        sampleGamesPerCellSeat: V07_ALIGNED_V2_THROUGHPUT_SCENARIOS_PER_CELL,
        totalElapsedMs: batches.reduce((sum, batch) => sum + batch.elapsedMs, 0),
        minimumBatchGamesPerWorkerHour: Math.min(...batches.map((batch) => batch.gamesPerWorkerHour)),
        persistedReplayVerified: true as const,
        workerAttestationsVerified: true as const,
    };
    const evidence: IV08AlignedV1ThroughputEvidenceManifest = {
        ...evidenceBody,
        evidenceSha256: fingerprintV07AlignedV2(evidenceBody),
    };
    writeCanonical(join(root, "evidence.json"), evidence);
    const dependencies: IV08AlignedV1ThroughputReplayDependencies = {
        loadShard: (directory, expectations) => ({
            directory,
            manifestSha256: expectations.manifestSha256!,
            evaluation: {
                binding: expectations.binding,
                records: expectations.shard.tasks.map((task) => ({
                    candidateSeat: task.candidateSeat,
                    greenVersion: task.candidateSeat === "candidate_green" ? "v0.8s" : "v0.7",
                    redVersion: task.candidateSeat === "candidate_green" ? "v0.7" : "v0.8s",
                })),
                attestations: [
                    {
                        artifactKind: "v0_8_aligned_96h_v1_worker_attestation",
                        versionProfile: { ...V08_ALIGNED_96H_V1_VERSION_PROFILE },
                    },
                ],
            },
        }),
    };
    return { root, evidence, dependencies };
}

function oneScenarioLegacyPlan(): IV07AlignedV2InjectedSeedPlan {
    let nextSeed = 800_000;
    const take = (): number => nextSeed++;
    return {
        schemaVersion: 1,
        panelId: "v0.8-throughput-physical-smoke",
        purpose: "train",
        scenariosPerCell: 1,
        denysetSha256: "d".repeat(64),
        pairs: V07_ALIGNED_V2_EVALUATOR_CELLS.map((cell) => {
            if (cell.distribution === "fixed_template") {
                const setupSeed = take();
                const combatSeed = take();
                return {
                    cellId: cell.id,
                    scenarioOrdinal: 0,
                    scenarioId: "scenario-0",
                    seats: {
                        candidate_green: { setupSeeds: [setupSeed], combatSeed },
                        candidate_red: { setupSeeds: [setupSeed], combatSeed },
                    },
                };
            }
            const stream = () => ({
                setupSeeds: Array.from({ length: 128 }, take),
                combatSeed: take(),
            });
            return {
                cellId: cell.id,
                scenarioOrdinal: 0,
                scenarioId: "scenario-0",
                seats: { candidate_green: stream(), candidate_red: stream() },
            };
        }),
    };
}

describe("v0.8 aligned 96-hour v1 throughput profile", () => {
    it("binds the exact profile, catalog, source ledger, replay, and schema-2 attestation", () => {
        const sourceBytes = readFileSync(SOURCE_MANIFEST);
        const { receipt, plan } = buildV08AlignedV1ThroughputSeedReceipt(sourceBytes);
        const request = buildV08AlignedV1ThroughputRequest({
            versionProfile: V08_ALIGNED_96H_V1_VERSION_PROFILE,
            geometry: geometry(),
            provenance: provenance(),
            receipt,
            plan,
        });
        const ledger = buildV08AlignedV1ThroughputCodeLedger();

        expect(receipt).toMatchObject({
            artifactKind: "v0_8_aligned_96h_v1_spent_diagnostic_seed_receipt",
            versionProfile: V08_ALIGNED_96H_V1_VERSION_PROFILE,
            planSha256: V08_ALIGNED_V1_THROUGHPUT_DIAGNOSTIC_PLAN_SHA256,
        });
        expect(flattenV08AlignedV1SeedPlan(plan)).toHaveLength(V07_ALIGNED_V2_THROUGHPUT_GAMES);
        expect(request).toMatchObject({
            artifactKind: "v0_8_aligned_96h_v1_throughput_request",
            versionProfile: V08_ALIGNED_96H_V1_VERSION_PROFILE,
            catalogSha256: V08_ALIGNED_V1_PRODUCTION_CATALOG_SHA256,
            worstCostGenomeSha256: V08_ALIGNED_V1_THROUGHPUT_WORST_COST_GENOME_SHA256,
        });
        expect(new Set(ledger.files.map((file) => file.repositoryPath)).size).toBe(ledger.files.length);
        expect(ledger.files.map((file) => file.repositoryPath)).toContain(
            "src/simulation/optimizer/v0_8_aligned_96h_v1_game_adapter.ts",
        );
        expect(ledger.files.map((file) => file.repositoryPath)).toContain(
            "src/simulation/optimizer/v0_7_aligned_96h_v2_evaluator.ts",
        );
        expect(ledger.files.map((file) => file.repositoryPath)).not.toContain(
            "src/simulation/optimizer/v0_8_aligned_96h_v1_evaluator.ts",
        );
        expect(() => validateV08AlignedV1ThroughputSeedReceipt(receipt, sourceBytes, plan)).not.toThrow();
        expect(() => validateV08AlignedV1ThroughputRequest(request, receipt, plan)).not.toThrow();
        expect(() => validateV07AlignedV2ThroughputRequest(request, receipt as never, plan as never)).toThrow(
            "frozen production diagnostic protocol",
        );
        const legacy = buildV07AlignedV2ThroughputSeedReceipt(sourceBytes);
        expect(() =>
            validateV08AlignedV1ThroughputRequest(request, legacy.receipt as never, legacy.plan as never),
        ).toThrow();

        const fixture = createReplayFixture();
        try {
            const replay = replayV08AlignedV1ThroughputEvidence(
                fixture.root,
                fixture.evidence.evidenceSha256,
                fixture.dependencies,
            );
            const attestation = buildV08AlignedV1ProductionThroughputAttestation({
                replay,
                evidenceRootPath: basename(fixture.root),
            });
            const options = {
                configRoot: dirname(fixture.root),
                expected: {
                    ...replay.request.geometry,
                    gamesPerWorkerHour: replay.evidence.minimumBatchGamesPerWorkerHour,
                },
                expectedAttestationSha256: attestation.attestationSha256,
                replayDependencies: fixture.dependencies,
            };
            expect(
                validateV08AlignedV1ProductionThroughputAttestation(attestation, options).replay.batches,
            ).toHaveLength(V07_ALIGNED_V2_THROUGHPUT_BATCHES);
            expect(() => validateV07AlignedV2ProductionThroughputAttestation(attestation, options as never)).toThrow(
                "header/fields are invalid",
            );
        } finally {
            rmSync(fixture.root, { recursive: true, force: true });
        }
    }, 60_000);

    it("physically executes and persists the worst-cost v0.8s arm against v0.7 in both seats", async () => {
        const root = mkdtempSync(join(tmpdir(), "hoc-v08-throughput-physical-"));
        const seedPlan = oneScenarioLegacyPlan();
        const binding = bindV08AlignedV1Candidate(buildV08AlignedV1ThroughputWorstCostGenome());
        expect(binding.genome).toMatchObject({
            search: { horizon: 12, rollouts: 2, includeMoves: true },
            controls: { shortlist: 3, decisionDeadlineMs: 175 },
        });
        expect(binding.behaviorEnvironment).toMatchObject({
            SEARCH_VERSIONS: "v0.8s",
            SEARCH_ROLLOUTS: "2",
            SEARCH_INCLUDE_MOVES: "1",
            SEARCH_MAX_MOVES: "1",
            SEARCH_DECISION_DEADLINE_MS: "175",
            SEARCH_CIRCUIT_BREAKER_MS: "275",
        });
        const shard = buildAligned96hCheckpointShardSpecs({
            runFingerprint: "e".repeat(64),
            seedPlan,
            binding,
            maxScenarioPairsPerShard: 1,
        }).find((candidate) => candidate.tasks[0]?.cellId === "fixed_mage_frontline")!;
        try {
            const evaluation = await evaluateV07AlignedV2Shard({
                shard,
                seedPlan,
                binding,
                workers: 1,
                auditDirectory: join(root, "audit"),
            });
            const persisted = persistV07AlignedV2ShardEvaluation(join(root, "shards"), evaluation, seedPlan);
            const loaded = loadV07AlignedV2PersistedShard(persisted.directory, {
                shard,
                seedPlan,
                binding,
                manifestSha256: persisted.manifestSha256,
            });

            expect(fingerprintV08AlignedV1CandidateGenome(loaded.evaluation.binding.genome)).toBe(
                V08_ALIGNED_V1_THROUGHPUT_WORST_COST_GENOME_SHA256,
            );
            expect(loaded.evaluation.records.map(({ greenVersion, redVersion }) => [greenVersion, redVersion])).toEqual(
                [
                    ["v0.8s", "v0.7"],
                    ["v0.7", "v0.8s"],
                ],
            );
            expect(loaded.evaluation.records.every((record) => !("artifactKind" in record))).toBe(true);
            expect(loaded.evaluation.attestations).toHaveLength(1);
            expect(loaded.evaluation.attestations[0]).toMatchObject({
                artifactKind: "v0_8_aligned_96h_v1_worker_attestation",
                versionProfile: V08_ALIGNED_96H_V1_VERSION_PROFILE,
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 120_000);
});
