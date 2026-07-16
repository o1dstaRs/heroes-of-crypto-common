/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import { DEFAULT_V06_W, StrategyV0_6 } from "../../src/ai/versions/v0_6";
import { StrategyV0_7S } from "../../src/ai/versions/v0_7s";
import outcome from "../../src/simulation/results/v0_7_96h_d68490a_outcome.json";
import {
    assertV07AlignedV2ProductionCatalogInput,
    buildV07AlignedV2ProductionCandidateCatalog,
    buildV07AlignedV2ProductionCatalogIdentity,
    buildV07AlignedV2ProductionIncumbentGenome,
    V07_ALIGNED_V2_B9CE_SOURCE_GENOME_SHA256,
    V07_ALIGNED_V2_PRODUCTION_CANDIDATE_COUNT,
    V07_ALIGNED_V2_PRODUCTION_CANDIDATE_LIMIT,
    V07_ALIGNED_V2_PRODUCTION_CATALOG_SHA256,
    V07_ALIGNED_V2_PRODUCTION_INCUMBENT_GENOME_SHA256,
    V07_ALIGNED_V2_PRODUCTION_TRAIN_SCENARIOS_PER_CELL,
    type IV07AlignedV2ProductionCatalogInput,
} from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_catalog";
import {
    bindV07AlignedV2Candidate,
    buildV07AlignedV2CandidateEnvironment,
    fingerprintV07AlignedV2CandidateGenome,
    normalizeV07AlignedV2CandidateGenome,
} from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_protocol";
import { fingerprintV0796hGenome, type IV0796hGenome } from "../../src/simulation/optimizer/v0_7_96h_core";

function productionInput(): IV07AlignedV2ProductionCatalogInput {
    return {
        candidateLimit: V07_ALIGNED_V2_PRODUCTION_CANDIDATE_LIMIT,
        candidateGenomes: buildV07AlignedV2ProductionCandidateCatalog(),
        incumbentGenome: buildV07AlignedV2ProductionIncumbentGenome(),
        trainScenariosPerCell: V07_ALIGNED_V2_PRODUCTION_TRAIN_SCENARIOS_PER_CELL,
    };
}

interface IMeleeDimPeek {
    w: number[];
    applyMeleeDims(): void;
}

const meleeDimPeek = (strategy: object): IMeleeDimPeek => strategy as unknown as IMeleeDimPeek;

describe("v0.7 aligned v2 production candidate catalog", () => {
    it("freezes the exact 48-arm behavior catalog and incumbent", () => {
        const candidates = buildV07AlignedV2ProductionCandidateCatalog();
        const incumbent = buildV07AlignedV2ProductionIncumbentGenome();
        const identity = buildV07AlignedV2ProductionCatalogIdentity();
        const hashes = candidates.map(fingerprintV07AlignedV2CandidateGenome);

        expect(candidates).toHaveLength(V07_ALIGNED_V2_PRODUCTION_CANDIDATE_COUNT);
        expect(new Set(hashes).size).toBe(V07_ALIGNED_V2_PRODUCTION_CANDIDATE_COUNT);
        expect(identity).toMatchObject({
            candidateCount: 48,
            candidateLimit: 48,
            trainScenariosPerCell: 256,
            catalogSha256: V07_ALIGNED_V2_PRODUCTION_CATALOG_SHA256,
        });
        expect(identity.orderedCandidateGenomeSha256).toEqual(hashes);
        expect(identity.incumbentGenomeSha256).toBe(V07_ALIGNED_V2_PRODUCTION_INCUMBENT_GENOME_SHA256);
        expect(identity.incumbentGenomeSha256).toBe(fingerprintV07AlignedV2CandidateGenome(incumbent));
        expect(hashes).not.toContain(identity.incumbentGenomeSha256);
        expect(incumbent).toMatchObject({
            search: {
                leafMode: "model",
                gate: 0.01,
                horizon: 12,
                rollouts: 3,
                includeMoves: false,
                maxMelee: 8,
                maxShots: 6,
                maxThrows: 4,
            },
            controls: {
                activeChallengers: false,
                shortlist: null,
                decisionDeadlineMs: 200,
                meleeRangedTargetWeight: 0,
                placementReveal: false,
                denseMeleeMagicIsolation: false,
                auraCasterMode: "off",
            },
        });
        expect(new Set(candidates.map((genome) => genome.controls.decisionDeadlineMs))).toEqual(
            new Set([125, 150, 175]),
        );
        expect(candidates.every((genome) => genome.search.rollouts === 1 && !genome.search.includeMoves)).toBe(true);
    });

    it("derives the b9ce anchor from the committed historical outcome", () => {
        const b9ce = buildV07AlignedV2ProductionCandidateCatalog().find((genome) =>
            genome.search.label?.includes("core-b9ce"),
        );
        expect(b9ce).toBeDefined();
        expect(b9ce!.search.leaf).toEqual(outcome.lateResearchCandidate.genome.leaf);
        expect(fingerprintV0796hGenome(outcome.lateResearchCandidate.genome as IV0796hGenome)).toBe(
            V07_ALIGNED_V2_B9CE_SOURCE_GENOME_SHA256,
        );
    });

    it("ignores labels but fingerprints every aligned behavior control", () => {
        const source = buildV07AlignedV2ProductionCandidateCatalog()[0];
        const sourceHash = fingerprintV07AlignedV2CandidateGenome(source);
        const relabeled = structuredClone(source);
        relabeled.search.label = "diagnostic-only-label";
        expect(fingerprintV07AlignedV2CandidateGenome(relabeled)).toBe(sourceHash);

        const mutations = [
            (genome: typeof source) => (genome.controls.activeChallengers = false),
            (genome: typeof source) => (genome.controls.shortlist = 3),
            (genome: typeof source) => (genome.controls.decisionDeadlineMs = 150),
            (genome: typeof source) => (genome.controls.lateRangedFinishWeight = 2),
            (genome: typeof source) => (genome.controls.meleeRangedTargetWeight = 2),
            (genome: typeof source) => (genome.controls.placementReveal = false),
            (genome: typeof source) => (genome.controls.denseMeleeMagicIsolation = true),
            (genome: typeof source) => (genome.controls.auraCasterMode = "windflow"),
        ];
        for (const mutate of mutations) {
            const changed = structuredClone(source);
            mutate(changed);
            expect(fingerprintV07AlignedV2CandidateGenome(changed)).not.toBe(sourceHash);
        }
        const pureTerminal = structuredClone(source);
        pureTerminal.controls.pureRangedTerminalWeight = 0.5;
        expect(fingerprintV07AlignedV2CandidateGenome(pureTerminal)).not.toBe(sourceHash);
    });

    it("binds explicit search, placement, dense-melee, aura, and ranged controls", () => {
        const genome = buildV07AlignedV2ProductionCandidateCatalog().find(
            (candidate) =>
                candidate.controls.denseMeleeMagicIsolation &&
                candidate.controls.auraCasterMode === "resurrection_windflow",
        );
        expect(genome).toBeDefined();
        const binding = bindV07AlignedV2Candidate(genome!);
        const environment = buildV07AlignedV2CandidateEnvironment(binding.genome, "/tmp/aligned-catalog-audit.jsonl");
        expect(binding).toMatchObject({
            schemaVersion: 3,
            profile: "candidate_scoped_aligned_controls_melee57_fixed_275",
        });
        expect(environment).toMatchObject({
            SEARCH_ACTIVE_CHALLENGERS: "1",
            SEARCH_SHORTLIST: "2",
            SEARCH_DECISION_DEADLINE_MS: "150",
            SEARCH_CIRCUIT_BREAKER_MS: "275",
            SEARCH_LATE_RANGED_FINISH_WEIGHT: "0",
            SEARCH_PURE_RANGED_TERMINAL_WEIGHT: "0",
            V06_MELEE_DIMS: "",
            V06_MELEE_DIMS_VERSIONS: "",
            V07_PLACEMENT_REVEAL: "on",
            V07_DENSE_MM_SALVAGE_ISOLATION: "1",
            V07_AURA_CASTER_ROUTER: "on",
            V07_AURA_CASTER_SPELLS: "resurrection,windflow",
        });
    });

    it("uses exactly two scoped w57 arms and leaves the v0.6 opponent pristine", () => {
        const candidates = buildV07AlignedV2ProductionCandidateCatalog();
        const labels = candidates.map((genome) => genome.search.label);
        const probes = candidates.filter((genome) => genome.controls.meleeRangedTargetWeight === 2);
        expect(probes.map((genome) => genome.search.label)).toEqual([
            "aligned-prod-melee-ranged-target-b9ce-h8",
            "aligned-prod-melee-ranged-target-b9ce-h12",
        ]);
        expect(labels).not.toContain("aligned-prod-placement-off-b9ce-h4");
        expect(labels).not.toContain("aligned-prod-placement-off-midpoint-h8");
        expect(labels.filter((label) => label?.includes("placement-off"))).toEqual([
            "aligned-prod-placement-off-b9ce-h8",
            "aligned-prod-placement-off-b9ce-h12",
        ]);

        for (const [probe, counterpartLabel] of [
            [probes[0], "aligned-prod-core-b9ce-h8-d150"],
            [probes[1], "aligned-prod-depth-b9ce-h12-d150"],
        ] as const) {
            const counterpart = candidates.find((genome) => genome.search.label === counterpartLabel)!;
            const probeSearch = { ...probe.search };
            const counterpartSearch = { ...counterpart.search };
            delete probeSearch.label;
            delete counterpartSearch.label;
            expect(probeSearch).toEqual(counterpartSearch);
            expect(probe.controls).toEqual({ ...counterpart.controls, meleeRangedTargetWeight: 2 });
        }

        const environment = buildV07AlignedV2CandidateEnvironment(probes[0], "/tmp/aligned-w57-audit.jsonl");
        expect(environment).toMatchObject({
            V06_MELEE_DIMS: "0,2",
            V06_MELEE_DIMS_VERSIONS: "v0.7s",
            SEARCH_VERSIONS: "v0.7s",
        });

        const previous = {
            dims: process.env.V06_MELEE_DIMS,
            versions: process.env.V06_MELEE_DIMS_VERSIONS,
            weights: process.env.V06_WEIGHTS,
        };
        process.env.V06_MELEE_DIMS = environment.V06_MELEE_DIMS;
        process.env.V06_MELEE_DIMS_VERSIONS = environment.V06_MELEE_DIMS_VERSIONS;
        delete process.env.V06_WEIGHTS;
        try {
            const candidate = meleeDimPeek(new StrategyV0_7S());
            const opponent = meleeDimPeek(new StrategyV0_6());
            candidate.applyMeleeDims();
            opponent.applyMeleeDims();
            expect(candidate.w[56]).toBe(0);
            expect(candidate.w[57]).toBe(2);
            expect(opponent.w[56]).toBe(DEFAULT_V06_W[56]);
            expect(opponent.w[57]).toBe(DEFAULT_V06_W[57]);
        } finally {
            for (const [key, value] of [
                ["V06_MELEE_DIMS", previous.dims],
                ["V06_MELEE_DIMS_VERSIONS", previous.versions],
                ["V06_WEIGHTS", previous.weights],
            ] as const) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        }
    });

    it("rejects unregistered control values and combined ranged overlays", () => {
        const source = buildV07AlignedV2ProductionCandidateCatalog()[0];
        for (const [key, value] of [
            ["shortlist", 1],
            ["decisionDeadlineMs", 201],
            ["lateRangedFinishWeight", 1],
            ["pureRangedTerminalWeight", 2],
            ["meleeRangedTargetWeight", 1],
            ["auraCasterMode", "all"],
        ] as const) {
            const malformed = structuredClone(source) as unknown as {
                controls: Record<string, unknown>;
            };
            malformed.controls[key] = value;
            expect(() => normalizeV07AlignedV2CandidateGenome(malformed as never)).toThrow(
                "candidate controls are invalid",
            );
        }
        const combined = structuredClone(source);
        combined.controls.lateRangedFinishWeight = 2;
        combined.controls.pureRangedTerminalWeight = 0.5;
        expect(() => normalizeV07AlignedV2CandidateGenome(combined)).toThrow("candidate controls are invalid");
    });

    it("rejects production catalog omission, addition, reorder, incumbent alias, and sample drift", () => {
        expect(() => assertV07AlignedV2ProductionCatalogInput(productionInput())).not.toThrow();

        const omitted = productionInput();
        omitted.candidateGenomes = omitted.candidateGenomes.slice(1);
        expect(() => assertV07AlignedV2ProductionCatalogInput(omitted)).toThrow("exact code-owned production catalog");

        const added = productionInput();
        added.candidateGenomes = [...added.candidateGenomes, structuredClone(added.candidateGenomes[0])];
        expect(() => assertV07AlignedV2ProductionCatalogInput(added)).toThrow("exact code-owned production catalog");

        const reordered = productionInput();
        const swapped = [...reordered.candidateGenomes];
        [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
        reordered.candidateGenomes = swapped;
        expect(() => assertV07AlignedV2ProductionCatalogInput(reordered)).toThrow(
            "exact code-owned production catalog",
        );

        const incumbentAlias = productionInput();
        incumbentAlias.incumbentGenome = structuredClone(incumbentAlias.candidateGenomes[0]);
        expect(() => assertV07AlignedV2ProductionCatalogInput(incumbentAlias)).toThrow(
            "exact code-owned production catalog",
        );

        for (const trainScenariosPerCell of [255, 257]) {
            const sampleDrift = productionInput();
            sampleDrift.trainScenariosPerCell = trainScenariosPerCell;
            expect(() => assertV07AlignedV2ProductionCatalogInput(sampleDrift)).toThrow(
                "exact code-owned production catalog",
            );
        }
    });
});
