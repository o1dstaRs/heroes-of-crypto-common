/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { V07_COMPOSED_SEED_SCAN_POLICY } from "../../src/simulation/v0_7_composed_seed_scan";
import {
    commitV07AlignedV2SeedAllocation,
    deriveV07AlignedV2SeedCandidate,
    expandV07AlignedV2CommittedManifest,
    ingestV07AlignedV2SeedCorpus,
    resolveV07AlignedV2SeedPlanByBinding,
    resolveV07AlignedV2SeedPlans,
    revealV07AlignedV2FinalSeedPlan,
    runV07AlignedV2SyntheticSeedAllocationDryRun,
    validateV07AlignedV2FinalSeedReveal,
    validateV07AlignedV2ProductionManifestCensus,
    validateV07AlignedV2SeedAllocationCommitment,
    V07_ALIGNED_V2_PRODUCTION_MANIFEST_CENSUS,
    V07_ALIGNED_V2_PRODUCTION_MANIFEST_CORPUS_SHA256,
    V07_ALIGNED_V2_SEED_ALLOCATION_DOMAIN,
    type IV07AlignedV2CandidateFreezeBinding,
    type IV07AlignedV2CommittedManifestInput,
    type IV07AlignedV2SeedAllocationRequest,
    type IV07AlignedV2SeedCorpus,
    type IV07AlignedV2SeedCorpusAttestation,
    type IV07AlignedV2SeedScanReplayInput,
} from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_seed_allocator";
import {
    fingerprintV07AlignedV2,
    fingerprintV07AlignedV2SeedPlan,
} from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_protocol";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const scan = (
    site: "local" | "zinc",
    seeds: readonly number[],
    overrides: {
        cutoff?: string;
        replaySummary?: string;
        replaySeedSet?: string;
        seedSet?: string;
        uniqueSeeds?: number;
    } = {},
): IV07AlignedV2SeedScanReplayInput => {
    const canonical = [...new Set(seeds)].sort((left, right) => left - right);
    const seedSet = overrides.seedSet ?? (canonical.length ? `${canonical.join("\n")}\n` : "");
    const summary = `${JSON.stringify({
        schemaVersion: 1,
        scanPolicy: V07_COMPOSED_SEED_SCAN_POLICY,
        cutoff: overrides.cutoff ?? "2026-07-16T09:18:00Z",
        uniqueSeeds: overrides.uniqueSeeds ?? canonical.length,
        corpusFileSnapshotSha256: sha256(`${site}-snapshot`),
        corpusSeedSetSha256: sha256(seedSet),
    })}\n`;
    return {
        site,
        first: { summaryBytes: summary, seedSetBytes: seedSet },
        replay: {
            summaryBytes: overrides.replaySummary ?? summary,
            seedSetBytes: overrides.replaySeedSet ?? seedSet,
        },
    };
};

const request = (
    mode: "production" | "synthetic_dry_run" = "synthetic_dry_run",
): IV07AlignedV2SeedAllocationRequest => ({
    schemaVersion: 1,
    mode,
    allocationId: "test-aligned-v2-seeds",
    domain: V07_ALIGNED_V2_SEED_ALLOCATION_DOMAIN,
    panels: {
        train: { panelId: "test-train", scenariosPerCell: 1 },
        confirm: { panelId: "test-confirm", scenariosPerCell: mode === "production" ? 1_000 : 1 },
        final: { panelId: "test-final", scenariosPerCell: mode === "production" ? 2_000 : 1 },
    },
    maxCandidatesPerSlot: 64,
});

const secret = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);

const corpus = (
    options: {
        local?: number[];
        zinc?: number[];
        manifests?: IV07AlignedV2CommittedManifestInput[];
    } = {},
): IV07AlignedV2SeedCorpus =>
    ingestV07AlignedV2SeedCorpus({
        scans: [scan("local", options.local ?? [0, 1]), scan("zinc", options.zinc ?? [2, 0xffffffff])],
        committedManifests: options.manifests ?? [],
    });

const freeze = (commitmentSha256: string): IV07AlignedV2CandidateFreezeBinding => ({
    schemaVersion: 1,
    kind: "v0.7_aligned_v2_candidate_freeze_binding",
    commitmentSha256,
    frozenCandidateSha256: "c".repeat(64),
    freezeArtifactSha256: "f".repeat(64),
});

const compactComposedManifest = (overrides: Record<string, number> = {}): unknown => ({
    schemaVersion: 1,
    manifestId: "synthetic-composed-affine",
    seedPermutation: {
        domain: "synthetic-composed-affine",
        nonce: 0,
        construction: "sha256_parameterized_affine_uint32_bijection_with_collision_remaps",
        offset: 100,
        oddStep: 3,
    },
    cells: [
        {
            id: "fixed",
            scenarioProtocol: "fixed_physical_side_swap",
            pairScenarios: 1,
            baseSeed: 100,
        },
    ],
    seedAudit: {
        plannedPairScenarios: 1,
        reservedDerivedSeedTokens: 3,
        internalCollisions: 0,
        ordinalOverrides: overrides,
    },
});

describe("v0.7 aligned 96-hour v2 seed allocator", () => {
    it("derives deterministic uint32 candidates with semantic domain separation", () => {
        const allocationRequestSha256 = fingerprintV07AlignedV2(request());
        const base = {
            secret,
            allocationId: "test-aligned-v2-seeds",
            allocationRequestSha256,
            coordinates: {
                purpose: "train" as const,
                panelId: "test-train",
                cellId: "ranked_mage" as const,
                scenarioOrdinal: 0,
                candidateSeat: "candidate_green" as const,
                stream: "setup" as const,
                streamOrdinal: 0,
            },
            attempt: 0,
        };
        const first = deriveV07AlignedV2SeedCandidate(base);
        expect(deriveV07AlignedV2SeedCandidate(base)).toBe(first);
        expect(first).toBeGreaterThanOrEqual(0);
        expect(first).toBeLessThanOrEqual(0xffffffff);
        expect(deriveV07AlignedV2SeedCandidate({ ...base, attempt: 1 })).not.toBe(first);
        expect(
            deriveV07AlignedV2SeedCandidate({
                ...base,
                coordinates: { ...base.coordinates, purpose: "confirm", panelId: "test-confirm" },
            }),
        ).not.toBe(first);
        expect(
            deriveV07AlignedV2SeedCandidate({
                ...base,
                coordinates: { ...base.coordinates, stream: "combat" },
            }),
        ).not.toBe(first);
    });

    it("ingests complete uint32 sets and exact byte-identical same-cutoff replays", () => {
        const ingested = corpus({ local: [0, 5, 99], zinc: [5, 100, 0xffffffff] });
        expect(ingested.attestation).toMatchObject({
            cutoff: "2026-07-16T09:18:00Z",
            denysetUniqueSeeds: 5,
            scans: {
                local: { uniqueSeeds: 3, byteIdenticalReplay: true },
                zinc: { uniqueSeeds: 3, byteIdenticalReplay: true },
            },
        });
        expect(ingested.attestation.attestationSha256).toHaveLength(64);

        expect(() =>
            ingestV07AlignedV2SeedCorpus({
                scans: [scan("local", [1], { replaySeedSet: "2\n" }), scan("zinc", [3])],
                committedManifests: [],
            }),
        ).toThrow("byte-identical same-cutoff replay");
        expect(() =>
            ingestV07AlignedV2SeedCorpus({
                scans: [scan("local", [1]), scan("zinc", [3], { cutoff: "2026-07-16T09:19:00Z" })],
                committedManifests: [],
            }),
        ).toThrow("exact same cutoff");
        expect(() =>
            ingestV07AlignedV2SeedCorpus({
                scans: [scan("local", [1], { seedSet: "0000001\n" }), scan("zinc", [3])],
                committedManifests: [],
            }),
        ).toThrow("noncanonical uint32 line");
        expect(() =>
            ingestV07AlignedV2SeedCorpus({
                scans: [scan("local", [1], { seedSet: "1\n1\n", uniqueSeeds: 2 }), scan("zinc", [3])],
                committedManifests: [],
            }),
        ).toThrow("strictly increasing and duplicate-free");
    });

    it("requires the exact reviewed repository manifest census for production", () => {
        const onDiskPaths = readdirSync(resolve("src/simulation/manifests"))
            .filter((name) => name.endsWith(".json"))
            .map((name) => `src/simulation/manifests/${name}`)
            .sort((left, right) => left.localeCompare(right));
        expect(V07_ALIGNED_V2_PRODUCTION_MANIFEST_CENSUS.map(({ path }) => path)).toEqual(onDiskPaths);
        const productionManifests = V07_ALIGNED_V2_PRODUCTION_MANIFEST_CENSUS.map(({ path }) => ({
            path,
            bytes: readFileSync(path),
        }));
        const complete = corpus({ manifests: productionManifests });
        expect(validateV07AlignedV2ProductionManifestCensus(complete.attestation).manifestCorpusSha256).toBe(
            V07_ALIGNED_V2_PRODUCTION_MANIFEST_CORPUS_SHA256,
        );
        expect(fingerprintV07AlignedV2(V07_ALIGNED_V2_PRODUCTION_MANIFEST_CENSUS)).toBe(
            V07_ALIGNED_V2_PRODUCTION_MANIFEST_CORPUS_SHA256,
        );

        const mutateAttestation = (
            mutate: (manifests: IV07AlignedV2SeedCorpusAttestation["manifests"]) => void,
        ): IV07AlignedV2SeedCorpusAttestation => {
            const changed = structuredClone(complete.attestation);
            mutate(changed.manifests);
            changed.manifestCorpusSha256 = fingerprintV07AlignedV2(changed.manifests);
            const unsigned = Object.fromEntries(Object.entries(changed).filter(([key]) => key !== "attestationSha256"));
            changed.attestationSha256 = fingerprintV07AlignedV2(unsigned);
            return changed;
        };
        const expectMismatch = (attestation: IV07AlignedV2SeedCorpusAttestation): void => {
            expect(() => validateV07AlignedV2ProductionManifestCensus(attestation)).toThrow(
                "production committed manifest census mismatch",
            );
        };

        expectMismatch(
            mutateAttestation((manifests) => {
                manifests.splice(
                    manifests.findIndex((entry) => entry.path.includes("composed_ranked_ladder")),
                    1,
                );
            }),
        );
        expectMismatch(
            mutateAttestation((manifests) => {
                manifests.splice(
                    manifests.findIndex((entry) => entry.path.includes("aligned_96h_v2_dry_run")),
                    1,
                );
            }),
        );
        expectMismatch(
            mutateAttestation((manifests) => {
                manifests[0]!.path = `renamed/${manifests[0]!.path}`;
            }),
        );
        expectMismatch(
            mutateAttestation((manifests) => {
                manifests[0]!.sha256 = "f".repeat(64);
            }),
        );
        expectMismatch(
            mutateAttestation((manifests) => {
                manifests.push({
                    path: "src/simulation/manifests/v0_7_unreviewed.json",
                    sha256: "f".repeat(64),
                    shape: "no_seed_reservation",
                    expandedUniqueSeeds: 0,
                    expandedSeedSetSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                });
                manifests.sort((left, right) => left.path.localeCompare(right.path));
            }),
        );
        expect(() => commitV07AlignedV2SeedAllocation(request("production"), corpus(), secret)).toThrow(
            "production committed manifest census mismatch",
        );
        const wrongCorpusCommitment = structuredClone(commitV07AlignedV2SeedAllocation(request(), corpus(), secret));
        wrongCorpusCommitment.request = request("production");
        wrongCorpusCommitment.allocationRequestSha256 = fingerprintV07AlignedV2(wrongCorpusCommitment.request);
        expect(() => validateV07AlignedV2SeedAllocationCommitment(wrongCorpusCommitment)).toThrow(
            "production committed manifest census mismatch",
        );
    });

    it("expands every committed manifest shape, including the compact composed affine envelope", () => {
        const manifestRoot = resolve("src/simulation/manifests");
        const expectedSeedBearing = new Set([
            "v0_7_96h_run_d68490a_seeds.json",
            "v0_7_96h_smoke_d68490a_fast_seeds.json",
            "v0_7_96h_smoke_d68490a_seeds.json",
            "v0_7_acceptance_archetype_final.json",
            "v0_7_acceptance_archetype_final_v2.json",
            "v0_7_archetype_battery_v1.json",
            "v0_7_archetype_battery_v2.json",
            "v0_7_archetype_battery_v3.json",
            "v0_7_archetype_battery_v4.json",
            "v0_7_composed_ranked_ladder_20260716.json",
            "v0_7_cross_archetype_v1.json",
            "v0_7_prior_zinc_seed_denylist.json",
            "v0_7_pure_ranged_terminal_20260716.json",
            "v0_7_wait_v2_powered_20260715.json",
            "v0_7_wait_v3_stage_a_20260716.json",
        ]);
        const observedShapes = new Set<string>();
        for (const name of readdirSync(manifestRoot)
            .filter((entry) => entry.endsWith(".json"))
            .sort()) {
            const expansion = expandV07AlignedV2CommittedManifest(
                JSON.parse(readFileSync(join(manifestRoot, name), "utf8")),
            );
            observedShapes.add(expansion.shape);
            if (expectedSeedBearing.has(name)) expect(expansion.seeds.length, name).toBeGreaterThan(0);
            else expect(expansion.shape, name).toBe("no_seed_reservation");
            if (name === "v0_7_composed_ranked_ladder_20260716.json") {
                expect(expansion.seeds).toHaveLength(1_081_000);
                expect(new Set(expansion.seeds).size).toBe(1_081_000);
            }
        }
        expect(observedShapes).toEqual(
            new Set([
                "v0_7_96h_prior",
                "wait_v2_cells",
                "wait_v3_cohorts",
                "pure_ranged_terminal",
                "composed_affine_reservation",
                "no_seed_reservation",
            ]),
        );
        const compact = expandV07AlignedV2CommittedManifest(compactComposedManifest());
        expect(compact).toEqual({ shape: "composed_affine_reservation", seeds: [100, 103, 106] });
    });

    it("fails closed on unsupported structured reservations and malformed affine overrides", () => {
        expect(() =>
            expandV07AlignedV2CommittedManifest({
                schemaVersion: 1,
                seedReservation: { baseSeed: 123 },
            }),
        ).toThrow("unrecognized structured numeric seed reservation");
        expect(() =>
            expandV07AlignedV2CommittedManifest({
                schemaVersion: 1,
                seedReservation: { combatSeed: "0xffffffff" },
            }),
        ).toThrow("unrecognized structured numeric seed reservation");
        expect(() => expandV07AlignedV2CommittedManifest(compactComposedManifest({ "fixed/0/unknown": 50 }))).toThrow(
            "unknown logical slot",
        );
        expect(() =>
            expandV07AlignedV2CommittedManifest(compactComposedManifest({ "fixed/0/combat/shared": 1 })),
        ).toThrow("inside the main logical envelope");
    });

    it("rejects collisions against local, zinc, committed manifests, and the growing plan", () => {
        const allocationRequest = request();
        const allocationRequestSha256 = fingerprintV07AlignedV2(allocationRequest);
        const firstCandidate = deriveV07AlignedV2SeedCandidate({
            secret,
            allocationId: allocationRequest.allocationId,
            allocationRequestSha256,
            coordinates: {
                purpose: "train",
                panelId: allocationRequest.panels.train.panelId,
                cellId: "ranked_mage",
                scenarioOrdinal: 0,
                candidateSeat: "candidate_green",
                stream: "setup",
                streamOrdinal: 0,
            },
            attempt: 0,
        });
        const manifest = {
            schemaVersion: 1,
            pairSeedStep: 0x9e3779b1,
            expectedDerivedScenarioSeeds: 1,
            seedSeries: [
                { id: "forced-collision", baseSeed: firstCandidate, streams: 1, streamStride: 0, gamesPerStream: 2 },
            ],
        };
        const ingested = corpus({
            local: [firstCandidate],
            zinc: [firstCandidate],
            manifests: [{ path: "synthetic/forced-collision.json", bytes: JSON.stringify(manifest) }],
        });
        const commitment = commitV07AlignedV2SeedAllocation(allocationRequest, ingested, secret);
        expect(commitment.trainPlan.pairs[0]!.seats.candidate_green.setupSeeds[0]).not.toBe(firstCandidate);
        expect(commitment.collisionAudit.train).toMatchObject({
            rejectedCandidates: 1,
            localDenysetHits: 1,
            zincDenysetHits: 1,
            committedManifestHits: 1,
        });
        expect(commitment.collisionAudit.total.candidatesExamined).toBe(
            commitment.collisionAudit.total.acceptedSeeds + commitment.collisionAudit.total.rejectedCandidates,
        );

        const accepted = commitment.trainPlan.pairs[0]!.seats.candidate_green.setupSeeds[0]!;
        const allocated = new Set<number>();
        for (const plan of [commitment.trainPlan, commitment.confirmPlan]) {
            for (const pair of plan.pairs) {
                for (const seat of ["candidate_green", "candidate_red"] as const) {
                    for (const seed of [...pair.seats[seat].setupSeeds, pair.seats[seat].combatSeed]) {
                        if (allocated.has(seed)) {
                            const other = pair.seats[seat === "candidate_green" ? "candidate_red" : "candidate_green"];
                            expect(pair.seats.candidate_green.combatSeed).toBe(other.combatSeed);
                        }
                        allocated.add(seed);
                    }
                }
            }
        }
        expect(allocated.has(accepted)).toBe(true);
    });

    it("rejects a deterministic birthday collision within the three-plan allocation", () => {
        const collisionRequest: IV07AlignedV2SeedAllocationRequest = {
            ...request(),
            allocationId: "collision-fixture",
            panels: {
                train: { panelId: "t", scenariosPerCell: 8 },
                confirm: { panelId: "c", scenariosPerCell: 8 },
                final: { panelId: "f", scenariosPerCell: 8 },
            },
        };
        const collisionSecret = Uint8Array.from({ length: 32 }, (_, index) => (index + 14) & 0xff);
        const commitment = commitV07AlignedV2SeedAllocation(
            collisionRequest,
            corpus({ local: [0], zinc: [1] }),
            collisionSecret,
        );
        expect(commitment.collisionAudit.total.withinPlanHits).toBe(1);
        expect(commitment.collisionAudit.total.rejectedCandidates).toBeGreaterThanOrEqual(1);
        expect(commitment.collisionAudit.total.candidatesExamined).toBe(
            commitment.collisionAudit.total.acceptedSeeds + commitment.collisionAudit.total.rejectedCandidates,
        );
    });

    it("commits deterministically without exposing final seeds and reveals only against a freeze", () => {
        const ingested = corpus();
        const allocationRequest = request();
        const first = commitV07AlignedV2SeedAllocation(allocationRequest, ingested, secret);
        const second = commitV07AlignedV2SeedAllocation(allocationRequest, ingested, secret);
        expect(second).toEqual(first);
        expect("finalPlan" in first).toBe(false);
        expect(first.finalPlanSha256).toHaveLength(64);
        expect(first.finalTasksSha256).toHaveLength(64);
        expect(first.finalTaskCount).toBe(24);
        expect("finalPlan" in first).toBe(false);
        expect(() =>
            revealV07AlignedV2FinalSeedPlan({
                commitment: first,
                corpus: ingested,
                secret,
                freeze: { ...freeze(first.commitmentSha256), commitmentSha256: "0".repeat(64) },
            }),
        ).toThrow("missing or belongs to another allocation commitment");
        expect(() =>
            revealV07AlignedV2FinalSeedPlan({
                commitment: first,
                corpus: ingested,
                secret: new Uint8Array(32),
                freeze: freeze(first.commitmentSha256),
            }),
        ).toThrow("does not open the commitment");

        const frozen = freeze(first.commitmentSha256);
        const reveal = revealV07AlignedV2FinalSeedPlan({
            commitment: first,
            corpus: ingested,
            secret,
            freeze: frozen,
        });
        const proof = {
            genomeSha256: frozen.frozenCandidateSha256,
            freezeArtifactSha256: frozen.freezeArtifactSha256,
        };
        expect(reveal.finalPlanSha256).toBe(first.finalPlanSha256);
        expect(resolveV07AlignedV2SeedPlans(first, reveal, proof).final).toEqual(reveal.finalPlan);
        expect(
            resolveV07AlignedV2SeedPlanByBinding(first, reveal, proof, {
                panelId: first.confirmPlan.panelId,
                panelFingerprint: fingerprintV07AlignedV2SeedPlan(first.confirmPlan),
            }),
        ).toEqual(first.confirmPlan);
        expect(() =>
            validateV07AlignedV2FinalSeedReveal(reveal, first, {
                ...proof,
                genomeSha256: "d".repeat(64),
            }),
        ).toThrow("does not bind the supplied immutable candidate freeze");
    });

    it("detects commitment and reveal tampering before restart resolution", () => {
        const ingested = corpus();
        const commitment = commitV07AlignedV2SeedAllocation(request(), ingested, secret);
        const frozen = freeze(commitment.commitmentSha256);
        const reveal = revealV07AlignedV2FinalSeedPlan({ commitment, corpus: ingested, secret, freeze: frozen });

        const changedCommitment = structuredClone(commitment);
        changedCommitment.trainPlan.pairs[0]!.seats.candidate_green.setupSeeds[0] ^= 1;
        expect(() => validateV07AlignedV2SeedAllocationCommitment(changedCommitment)).toThrow();

        const changedReveal = structuredClone(reveal);
        changedReveal.finalPlan.pairs[0]!.seats.candidate_green.setupSeeds[0] ^= 1;
        expect(() =>
            validateV07AlignedV2FinalSeedReveal(changedReveal, commitment, {
                genomeSha256: frozen.frozenCandidateSha256,
                freezeArtifactSha256: frozen.freezeArtifactSha256,
            }),
        ).toThrow();
    });

    it("keeps production confirmation and final sizes fixed", () => {
        const malformed = request("production");
        malformed.panels.confirm.scenariosPerCell = 999;
        expect(() => commitV07AlignedV2SeedAllocation(malformed, corpus(), secret)).toThrow(
            "exactly 1000/2000 scenarios per cell",
        );
    });

    it("runs the seedless-environment synthetic allocation dry-run reproducibly", () => {
        const first = runV07AlignedV2SyntheticSeedAllocationDryRun();
        const second = runV07AlignedV2SyntheticSeedAllocationDryRun();
        expect(second).toEqual(first);
        expect(first).toMatchObject({
            verdict: "PASS",
            seedMaterial: "synthetic_only",
            resolvedPanels: 3,
            crossPlanDisjoint: true,
        });
    });
});
