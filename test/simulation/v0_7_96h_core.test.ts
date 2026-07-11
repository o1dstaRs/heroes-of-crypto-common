/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import {
    assertV0796hPanelsDisjoint,
    assessV0796hTarget,
    buildV0796hSeedPanel,
    createV0796hDistribution,
    decodeV0796hGenome,
    deriveV0796hSeed,
    encodeV0796hGenome,
    expandV0796hPriorSeedSeries,
    fingerprintV0796hGenome,
    refitV0796hDistribution,
    sampleV0796hPopulation,
    scoreV0796hTrial,
    shouldPromoteV0796h,
    V07_96H_GENOME_DIM,
    V07_96H_TEMPLATES,
    v0796hProbeGenomes,
    type IV0796hPriorSeedSeries,
    type IV0796hTemplateMetric,
} from "../../src/simulation/optimizer/v0_7_96h_core";

const metrics = (rate: number, overrides: Partial<Record<string, number>> = {}): IV0796hTemplateMetric[] =>
    V07_96H_TEMPLATES.map(({ archetype, template }) => ({
        archetype,
        template,
        games: 12_000,
        decisiveWinRate: overrides[template] ?? rate,
        confidence95Low: (overrides[template] ?? rate) - 0.006,
        standardErrorPp: 0.25,
        scoreRate: overrides[template] ?? rate,
        drawOrArmageddonRate: 0.005,
        candidateRejections: 0,
        missingRejectionCounts: 0,
    }));

describe("v0.7 96-hour optimizer core", () => {
    it("derives stable disjoint seed panels", () => {
        expect(deriveV0796hSeed("run-a", "train-0", "mage_frontline")).toBe(
            deriveV0796hSeed("run-a", "train-0", "mage_frontline"),
        );
        expect(deriveV0796hSeed("run-a", "train-0", "mage_frontline")).not.toBe(
            deriveV0796hSeed("run-a", "final", "mage_frontline"),
        );
        const panels = [
            buildV0796hSeedPanel("run-a", "train-0", 64),
            buildV0796hSeedPanel("run-a", "selection-0", 256),
            buildV0796hSeedPanel("run-a", "final", 12_000),
        ];
        expect(() => assertV0796hPanelsDisjoint(panels)).not.toThrow();
        const collision = structuredClone(panels[1]);
        collision.seeds.mage_frontline = panels[0].seeds.mage_frontline;
        expect(() => assertV0796hPanelsDisjoint([panels[0], collision])).toThrow("seed collision");
    });

    it("expands the historical program seed denylist without collisions", () => {
        const manifest = JSON.parse(
            readFileSync(
                new URL("../../src/simulation/manifests/v0_7_prior_zinc_seed_denylist.json", import.meta.url),
                "utf8",
            ),
        ) as { expectedDerivedScenarioSeeds: number; seedSeries: IV0796hPriorSeedSeries[] };
        const historical = expandV0796hPriorSeedSeries(manifest.seedSeries);
        expect(historical).toHaveLength(manifest.expectedDerivedScenarioSeeds);
        expect(historical).toHaveLength(144_600);
        expect(new Set(historical).size).toBe(historical.length);
        expect(() =>
            expandV0796hPriorSeedSeries([
                { id: "left", baseSeed: 1, streams: 1, streamStride: 0, gamesPerStream: 2 },
                { id: "right", baseSeed: 1, streams: 1, streamStride: 0, gamesPerStream: 2 },
            ]),
        ).toThrow("Prior seed series collision");
    });

    it("round-trips bounded model genomes and samples deterministically", () => {
        const anchor = v0796hProbeGenomes().find((genome) => genome.label === "committed-20d")!;
        const vector = encodeV0796hGenome(anchor);
        expect(vector).toHaveLength(V07_96H_GENOME_DIM);
        expect(fingerprintV0796hGenome(decodeV0796hGenome(vector))).toBe(fingerprintV0796hGenome(anchor));
        const distribution = createV0796hDistribution(anchor);
        const left = sampleV0796hPopulation(distribution, 6, 42, 3);
        const right = sampleV0796hPopulation(distribution, 6, 42, 3);
        expect(left).toEqual(right);
        expect(left[1]).not.toEqual(left[0]);
        const refit = refitV0796hDistribution(distribution, left.slice(0, 2));
        expect(refit.mean).toHaveLength(V07_96H_GENOME_DIM);
        expect(refit.sigma.every((value, index) => value >= refit.sigmaFloor[index])).toBe(true);
    });

    it("hard-fails rejection-tainted trials and promotes only max-min improvements", () => {
        const incumbent = metrics(0.82);
        const challenger = metrics(0.84);
        expect(scoreV0796hTrial(challenger).valid).toBe(true);
        expect(shouldPromoteV0796h(challenger, incumbent)).toBe(true);
        challenger[0].decisiveWinRate = 0.8;
        expect(shouldPromoteV0796h(challenger, incumbent)).toBe(false);
        challenger[0].candidateRejections = 1;
        expect(scoreV0796hTrial(challenger)).toMatchObject({ valid: false, fitness: -1 });
    });

    it("distinguishes observed, strict, and simultaneously certified 90 percent", () => {
        const observed = metrics(0.905);
        expect(assessV0796hTarget(observed)).toMatchObject({
            observed90ByCohort: true,
            strictAllTemplates: true,
            certifiedAllTemplates: false,
        });
        const certified = metrics(0.91);
        expect(assessV0796hTarget(certified)).toMatchObject({
            observed90ByCohort: true,
            strictAllTemplates: true,
            certifiedAllTemplates: true,
        });
    });
});
