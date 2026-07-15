import { describe, expect, it } from "bun:test";

import {
    deriveTeacherConfidence,
    groupedSemanticLossAndGradient,
    predictSemanticGroup,
    semanticGroupDistribution,
} from "../../src/simulation/optimizer/il_fit_core.mjs";

describe("IL semantic-group objective", () => {
    it("is duplicate-neutral and optimizes the same groups used for prediction", () => {
        const base = groupedSemanticLossAndGradient([0, 0, 0], ["A", "A", "B"], "A");
        const duplicated = groupedSemanticLossAndGradient([0, 0, 0, 0], ["A", "A", "A", "B"], "A");

        expect(base.loss).toBeCloseTo(Math.log(2), 12);
        expect(duplicated.loss).toBeCloseTo(base.loss, 12);
        expect(base.gradient[0] + base.gradient[1]).toBeCloseTo(-0.5, 12);
        expect(base.gradient[2]).toBeCloseTo(0.5, 12);

        const distribution = semanticGroupDistribution([0, 0, 0], ["A", "A", "B"]);
        expect(distribution.map(({ signature, probability }) => [signature, probability])).toEqual([
            ["A", 0.5],
            ["B", 0.5],
        ]);
        expect(predictSemanticGroup([0, 0, 0.2], ["A", "A", "B"]).signature).toBe("B");
    });

    it("uses the override gate to downweight boundary and forced teacher choices", () => {
        const boundary = deriveTeacherConfidence([0.5, 0.51], ["inc", "attack"], 1, 0.01);
        expect(boundary.margin).toBeCloseTo(0, 12);
        expect(boundary.weight).toBe(0);
        expect(boundary.forced).toBe(false);

        const override = deriveTeacherConfidence([0.5, 0.53], ["inc", "attack"], 1, 0.01);
        expect(override.margin).toBeCloseTo(0.02, 12);
        expect(override.weight).toBe(1);

        const incumbent = deriveTeacherConfidence([0.5, 0.49], ["inc", "attack"], 0, 0.01);
        expect(incumbent.margin).toBeCloseTo(0.02, 12);
        expect(incumbent.weight).toBe(1);

        expect(deriveTeacherConfidence([null, 0.6], ["inc", "attack"], 1, 0.01)).toEqual({
            targetSignature: "attack",
            margin: null,
            weight: 0,
            forced: true,
        });
        expect(() => deriveTeacherConfidence([0.5, 0.7], ["inc", "attack"], 0, 0.01)).toThrow("inconsistent");
    });
});
