/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";

import { V08_ALIGNED_96H_V1_VERSION_PROFILE } from "../../src/simulation/optimizer/aligned_96h_version_profile";
import {
    buildV07AlignedV2ProductionCandidateCatalog,
    buildV07AlignedV2ProductionIncumbentGenome,
} from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_catalog";
import {
    createV07AlignedV2OrchestratorDefinition,
    validateV07AlignedV2OrchestratorDefinition,
} from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_orchestrator";
import {
    V07_ALIGNED_V2_EVALUATOR_CELLS,
    bindV07AlignedV2Candidate,
    bindV07AlignedV2SeedPlan,
    canonicalV07AlignedV2Json,
    type IV07AlignedV2InjectedSeedPlan,
    type V07AlignedV2PanelPurpose,
} from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_protocol";
import {
    V08_ALIGNED_V1_PRODUCTION_CATALOG_SHA256,
    assertV08AlignedV1ProductionCatalogInput,
    buildV08AlignedV1ProductionCandidateCatalog,
    buildV08AlignedV1ProductionCatalogIdentity,
    buildV08AlignedV1ProductionIncumbentGenome,
} from "../../src/simulation/optimizer/v0_8_aligned_96h_v1_catalog";
import {
    V08_ALIGNED_96H_V1_CELLS,
    V08_ALIGNED_96H_V1_SEATS,
    V08_ALIGNED_V1_GAME_BUDGET,
    V08_ALIGNED_V1_PRODUCTION_CANDIDATE_COUNT,
    V08_ALIGNED_V1_TRAIN_SCENARIOS_PER_CELL,
    assessV08AlignedV1Final,
    defaultV08AlignedV1DryRunConfig,
    validateV08AlignedV1DryRunConfig,
} from "../../src/simulation/optimizer/v0_8_aligned_96h_v1_core";
import {
    V08_ALIGNED_V1_EVALUATOR_CELLS,
    bindV08AlignedV1Candidate,
    fingerprintV08AlignedV1CandidateGenome,
    fingerprintV08AlignedV1SeedPlan,
    flattenV08AlignedV1SeedPlan,
    validateV08AlignedV1CandidateBinding,
    validateV08AlignedV1SeedPlan,
    type IV08AlignedV1InjectedSeedPlan,
} from "../../src/simulation/optimizer/v0_8_aligned_96h_v1_protocol";
import {
    V08_ALIGNED_V1_NONFIGHT_BINDING,
    V08_ALIGNED_V1_NONFIGHT_BINDING_SHA256,
} from "../../src/simulation/optimizer/v0_8_aligned_96h_v1_nonfight";

function syntheticSeedPlan(): IV08AlignedV1InjectedSeedPlan {
    let nextSeed = 10_000;
    const allocate = (): number => nextSeed++;
    return {
        schemaVersion: 1,
        artifactKind: "v0_8_aligned_96h_v1_seed_plan",
        versionProfile: { ...V08_ALIGNED_96H_V1_VERSION_PROFILE },
        panelId: "v0.8-aligned-v1-contract-train",
        purpose: "train",
        scenariosPerCell: 1,
        denysetSha256: "a".repeat(64),
        pairs: V08_ALIGNED_V1_EVALUATOR_CELLS.map((cell) => {
            if (cell.distribution === "fixed_template") {
                const setupSeed = allocate();
                const combatSeed = allocate();
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
            return {
                cellId: cell.id,
                scenarioOrdinal: 0,
                scenarioId: "scenario-0",
                seats: {
                    candidate_green: {
                        setupSeeds: Array.from({ length: 128 }, allocate),
                        combatSeed: allocate(),
                    },
                    candidate_red: {
                        setupSeeds: Array.from({ length: 128 }, allocate),
                        combatSeed: allocate(),
                    },
                },
            };
        }),
    };
}

function legacySequentialSeedPlan(
    purpose: V07AlignedV2PanelPurpose,
    panelId: string,
    take: () => number,
): IV07AlignedV2InjectedSeedPlan {
    return {
        schemaVersion: 1,
        panelId,
        purpose,
        scenariosPerCell: 1,
        denysetSha256: "d".repeat(64),
        pairs: V07_ALIGNED_V2_EVALUATOR_CELLS.map((cell) => {
            if (cell.distribution === "fixed_template") {
                const setupSeeds = [take()];
                const combatSeed = take();
                return {
                    cellId: cell.id,
                    scenarioOrdinal: 0,
                    scenarioId: "scenario-0",
                    seats: {
                        candidate_green: { setupSeeds: [...setupSeeds], combatSeed },
                        candidate_red: { setupSeeds: [...setupSeeds], combatSeed },
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

describe("v0.8 aligned 96-hour v1 contract", () => {
    it("keeps omitted-profile v0.7 definition bytes exactly unchanged", () => {
        let nextSeed = 1;
        const take = (): number => nextSeed++;
        const trainSeedPlan = legacySequentialSeedPlan("train", "train", take);
        const confirmSeedPlan = legacySequentialSeedPlan("confirm", "confirm", take);
        const finalSeedPlan = legacySequentialSeedPlan("final", "final", take);
        const definition = createV07AlignedV2OrchestratorDefinition({
            mode: "synthetic_dry_run",
            runId: "byte-check",
            createdAtMs: 0,
            composedSealSha256: "a".repeat(64),
            candidateLimit: 1,
            schedule: {
                startAtMs: 1,
                trainDeadlineAtMs: 60 * 60 * 1000,
                confirmDeadlineAtMs: 2 * 60 * 60 * 1000,
                finalDeadlineAtMs: 96 * 60 * 60 * 1000 + 1,
            },
            candidateGenomes: [buildV07AlignedV2ProductionCandidateCatalog()[0]],
            incumbentGenome: buildV07AlignedV2ProductionIncumbentGenome(),
            trainSeedPlan,
            confirmSeedPlan,
            finalPanelCommitment: bindV07AlignedV2SeedPlan(finalSeedPlan),
            seedCommitment: {
                path: "seed/commitment.json",
                bytesSha256: "b".repeat(64),
                artifactSha256: "c".repeat(64),
            },
        });
        const bytes = canonicalV07AlignedV2Json(definition);
        const bytesSha256 = createHash("sha256").update(bytes).digest("hex");
        expect(definition.definitionSha256).toBe("d279afd6e644a3ac688422e653a36750c2bf96bee260fe45e3f7a901744d23be");
        expect(bytesSha256).toBe("f917ac884eb6668c737b7eb5c557a02972dad116728728ae4cc8c5aa5350888c");
        expect(Buffer.byteLength(bytes)).toBe(6074);
        expect("nonfightBinding" in definition).toBe(false);
        expect(definition.candidates.every((binding) => !("nonfightBindingSha256" in binding))).toBe(true);
    });

    it("preserves the exact aligned production geometry and 390,912-game budget", () => {
        expect(V08_ALIGNED_96H_V1_CELLS).toHaveLength(12);
        expect(V08_ALIGNED_96H_V1_SEATS).toEqual(["candidate_green", "candidate_red"]);
        expect(V08_ALIGNED_V1_EVALUATOR_CELLS.filter((cell) => cell.distribution === "ranked_taxonomy")).toHaveLength(
            4,
        );
        expect(V08_ALIGNED_V1_EVALUATOR_CELLS.filter((cell) => cell.distribution === "fixed_template")).toHaveLength(8);
        expect(V08_ALIGNED_V1_GAME_BUDGET).toEqual({
            train: 294_912,
            confirm: 48_000,
            final: 48_000,
            total: 390_912,
        });
        expect(defaultV08AlignedV1DryRunConfig()).toMatchObject({
            versionProfile: V08_ALIGNED_96H_V1_VERSION_PROFILE,
            candidateCount: 48,
            compute: { totalHours: 96, finalReserveHours: 36, workers: 40 },
            panels: {
                trainScenariosPerCell: 256,
                confirmScenariosPerCellSeat: 1000,
                finalGamesPerCellSeat: 2000,
            },
        });
    });

    it("rejects candidate bindings replayed under the other definition profile", () => {
        const plans = (firstSeed: number) => {
            let nextSeed = firstSeed;
            const take = (): number => nextSeed++;
            const train = legacySequentialSeedPlan("train", `train-${firstSeed}`, take);
            const confirm = legacySequentialSeedPlan("confirm", `confirm-${firstSeed}`, take);
            const final = legacySequentialSeedPlan("final", `final-${firstSeed}`, take);
            return { train, confirm, final };
        };
        const schedule = {
            startAtMs: 1,
            trainDeadlineAtMs: 60 * 60 * 1000,
            confirmDeadlineAtMs: 2 * 60 * 60 * 1000,
            finalDeadlineAtMs: 96 * 60 * 60 * 1000 + 1,
        };
        const seedCommitment = {
            path: "seed/commitment.json",
            bytesSha256: "b".repeat(64),
            artifactSha256: "c".repeat(64),
        };
        const v08Plans = plans(20_000);
        const v08CandidateGenome = buildV08AlignedV1ProductionCandidateCatalog()[0];
        const v08Definition = createV07AlignedV2OrchestratorDefinition({
            versionProfile: V08_ALIGNED_96H_V1_VERSION_PROFILE,
            mode: "synthetic_dry_run",
            runId: "v08-cross-profile",
            createdAtMs: 0,
            composedSealSha256: "a".repeat(64),
            candidateLimit: 1,
            schedule,
            candidateGenomes: [v08CandidateGenome],
            incumbentGenome: buildV08AlignedV1ProductionIncumbentGenome(),
            trainSeedPlan: v08Plans.train,
            confirmSeedPlan: v08Plans.confirm,
            finalPanelCommitment: bindV07AlignedV2SeedPlan(v08Plans.final),
            seedCommitment,
        });
        expect(validateV07AlignedV2OrchestratorDefinition(v08Definition)).toEqual(v08Definition);
        expect(v08Definition).toMatchObject({
            artifactKind: "v0_8_aligned_96h_v1_orchestrator_definition",
            versionProfile: V08_ALIGNED_96H_V1_VERSION_PROFILE,
            nonfightBinding: V08_ALIGNED_V1_NONFIGHT_BINDING,
        });
        const v08WithV07Binding = structuredClone(v08Definition);
        v08WithV07Binding.candidates[0] = bindV07AlignedV2Candidate(v08CandidateGenome);
        expect(() => validateV07AlignedV2OrchestratorDefinition(v08WithV07Binding)).toThrow("version profile");

        const v07Plans = plans(40_000);
        const v07CandidateGenome = buildV07AlignedV2ProductionCandidateCatalog()[0];
        const v07Definition = createV07AlignedV2OrchestratorDefinition({
            mode: "synthetic_dry_run",
            runId: "v07-cross-profile",
            createdAtMs: 0,
            composedSealSha256: "a".repeat(64),
            candidateLimit: 1,
            schedule,
            candidateGenomes: [v07CandidateGenome],
            incumbentGenome: buildV07AlignedV2ProductionIncumbentGenome(),
            trainSeedPlan: v07Plans.train,
            confirmSeedPlan: v07Plans.confirm,
            finalPanelCommitment: bindV07AlignedV2SeedPlan(v07Plans.final),
            seedCommitment,
        });
        const v07WithV08Binding = structuredClone(v07Definition);
        v07WithV08Binding.candidates[0] = bindV08AlignedV1Candidate(v07CandidateGenome);
        expect(() => validateV07AlignedV2OrchestratorDefinition(v07WithV08Binding)).toThrow(
            "canonical genome and search profile",
        );
    });

    it("rejects cross-profile dry runs and terminals identify v0.8s versus v0.7", () => {
        const config = defaultV08AlignedV1DryRunConfig();
        expect(validateV08AlignedV1DryRunConfig(config)).toEqual(config);
        const wrongProfile = structuredClone(config);
        (wrongProfile.versionProfile as { candidate: string }).candidate = "v0.7s";
        expect(() => validateV08AlignedV1DryRunConfig(wrongProfile)).toThrow("v0.8s/v0.8 versus v0.7");

        expect(assessV08AlignedV1Final([])).toMatchObject({
            artifactKind: "v0_8_aligned_96h_v1_research_terminal",
            versionProfile: V08_ALIGNED_96H_V1_VERSION_PROFILE,
            candidate: "v0.8s",
            opponent: "v0.7",
            automaticBake: false,
            automaticDeploy: false,
            verdict: "FAIL",
        });
    });

    it("binds every candidate-only environment scope to v0.8s", () => {
        const genome = buildV08AlignedV1ProductionCandidateCatalog()[0];
        const binding = bindV08AlignedV1Candidate(genome);
        expect(validateV08AlignedV1CandidateBinding(binding)).toEqual(binding);
        expect(binding).toMatchObject({
            schemaVersion: 3,
            artifactKind: "v0_8_aligned_96h_v1_candidate_binding",
            versionProfile: V08_ALIGNED_96H_V1_VERSION_PROFILE,
            candidate: "v0.8s",
            candidateBase: "v0.8",
            opponent: "v0.7",
            nonfightBindingSha256: V08_ALIGNED_V1_NONFIGHT_BINDING_SHA256,
        });
        expect(binding.behaviorEnvironment).toMatchObject({
            SEARCH_VERSIONS: "v0.8s",
            SEARCH_INCLUDE_MOVES: "1",
            SEARCH_MAX_MOVES: "1",
            V07_PLACEMENT_REVEAL_VERSIONS: "v0.8s",
            V07_DENSE_MM_SALVAGE_ISOLATION_VERSIONS: "v0.8s",
            V07_AURA_CASTER_ROUTER_VERSIONS: "v0.8s",
        });
        const tampered = structuredClone(binding);
        tampered.opponent = "v0.6" as "v0.7";
        expect(() => validateV08AlignedV1CandidateBinding(tampered)).toThrow("canonical genome and version profile");
    });

    it("keeps seed plans and execution tasks version-bound", () => {
        const plan = syntheticSeedPlan();
        expect(() => validateV08AlignedV1SeedPlan(plan)).not.toThrow();
        expect(fingerprintV08AlignedV1SeedPlan(plan)).toMatch(/^[0-9a-f]{64}$/);
        const tasks = flattenV08AlignedV1SeedPlan(plan);
        expect(tasks).toHaveLength(24);
        expect(tasks.slice(0, 2).map((task) => task.candidateSeat)).toEqual(["candidate_green", "candidate_red"]);
        expect(tasks.every((task) => task.versionProfile.candidate === "v0.8s")).toBe(true);

        const wrongProfile = structuredClone(plan);
        (wrongProfile.versionProfile as { opponent: string }).opponent = "v0.6";
        expect(() => validateV08AlignedV1SeedPlan(wrongProfile)).toThrow("v0.8s/v0.8 versus v0.7");
    });

    it("freezes the exact 48-arm catalog under a v0.8-specific identity", () => {
        const candidates = buildV08AlignedV1ProductionCandidateCatalog();
        const incumbent = buildV08AlignedV1ProductionIncumbentGenome();
        const identity = buildV08AlignedV1ProductionCatalogIdentity();
        const hashes = candidates.map(fingerprintV08AlignedV1CandidateGenome);
        expect(candidates).toHaveLength(V08_ALIGNED_V1_PRODUCTION_CANDIDATE_COUNT);
        expect(new Set(hashes)).toHaveLength(V08_ALIGNED_V1_PRODUCTION_CANDIDATE_COUNT);
        expect(identity).toMatchObject({
            versionProfile: V08_ALIGNED_96H_V1_VERSION_PROFILE,
            candidateCount: 48,
            candidateLimit: 48,
            trainScenariosPerCell: 256,
            catalogSha256: V08_ALIGNED_V1_PRODUCTION_CATALOG_SHA256,
        });
        expect(V08_ALIGNED_V1_PRODUCTION_CATALOG_SHA256).toBe(
            "61d969139f574bf886820a5f0bd0b5c76677cda905b30a24e1fb0010c17eb64e",
        );
        expect(identity.orderedCandidateGenomeSha256).toEqual(hashes);
        expect(identity.incumbentGenomeSha256).toBe(fingerprintV08AlignedV1CandidateGenome(incumbent));
        expect(hashes).not.toContain(identity.incumbentGenomeSha256);
        expect(incumbent).toEqual(buildV07AlignedV2ProductionIncumbentGenome());
        expect(incumbent.search.includeMoves).toBe(false);
        expect(buildV07AlignedV2ProductionCandidateCatalog().every((genome) => !genome.search.includeMoves)).toBe(true);

        expect(candidates.every((genome) => genome.search.includeMoves)).toBe(true);
        expect(
            candidates.every((genome) => {
                const environment = bindV08AlignedV1Candidate(genome).behaviorEnvironment;
                return (
                    environment.SEARCH_VERSIONS === "v0.8s" &&
                    environment.SEARCH_INCLUDE_MOVES === "1" &&
                    environment.SEARCH_MAX_MOVES === "1"
                );
            }),
        ).toBe(true);
        expect(
            Object.fromEntries(
                [1, 2, 3].map((rollouts) => [
                    rollouts,
                    candidates.filter((genome) => genome.search.rollouts === rollouts).length,
                ]),
            ),
        ).toEqual({ 1: 14, 2: 19, 3: 15 });
        expect(
            Object.fromEntries(
                [125, 150, 175].map((deadline) => [
                    deadline,
                    candidates.filter((genome) => genome.controls.decisionDeadlineMs === deadline).length,
                ]),
            ),
        ).toEqual({ 125: 10, 150: 20, 175: 18 });
        expect(
            candidates.reduce<Record<string, number>>((census, genome) => {
                const key = `r${genome.search.rollouts}-d${genome.controls.decisionDeadlineMs}`;
                census[key] = (census[key] ?? 0) + 1;
                return census;
            }, {}),
        ).toEqual({ "r1-d125": 10, "r1-d150": 4, "r2-d150": 16, "r2-d175": 3, "r3-d175": 15 });
        expect(
            candidates
                .filter((genome) => genome.search.horizon === 12)
                .every((genome) => genome.search.rollouts <= 2 && genome.controls.decisionDeadlineMs >= 150),
        ).toBe(true);
        expect(candidates.every((genome) => genome.controls.decisionDeadlineMs < 275)).toBe(true);

        const labels = candidates.map((genome) => genome.search.label ?? "");
        for (const coverage of ["core-committed", "core-multicohort", "core-b9ce", "core-midpoint"]) {
            expect(labels.some((label) => label.includes(coverage))).toBe(true);
        }
        expect(
            candidates.some(
                (genome) => genome.controls.lateRangedFinishWeight > 0 || genome.controls.pureRangedTerminalWeight > 0,
            ),
        ).toBe(true);
        expect(
            candidates.some(
                (genome) => genome.controls.denseMeleeMagicIsolation || genome.controls.meleeRangedTargetWeight > 0,
            ),
        ).toBe(true);
        expect(new Set(candidates.map((genome) => genome.controls.auraCasterMode))).toEqual(
            new Set(["off", "windflow", "resurrection_windflow"]),
        );
        expect(new Set(candidates.map((genome) => genome.controls.placementReveal))).toEqual(new Set([false, true]));
        expect(candidates.some((genome) => !genome.controls.activeChallengers)).toBe(true);
        expect(() =>
            assertV08AlignedV1ProductionCatalogInput({
                versionProfile: { ...V08_ALIGNED_96H_V1_VERSION_PROFILE },
                candidateLimit: V08_ALIGNED_V1_PRODUCTION_CANDIDATE_COUNT,
                candidateGenomes: candidates,
                incumbentGenome: incumbent,
                trainScenariosPerCell: V08_ALIGNED_V1_TRAIN_SCENARIOS_PER_CELL,
            }),
        ).not.toThrow();
    });
});
