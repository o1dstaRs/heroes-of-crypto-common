import { expect, test } from "bun:test";
import { fitContextualDraftRidge } from "../../src/simulation/contextual_draft_training";
import {
    CONTEXTUAL_DRAFT_FEATURE_NAMES,
    CONTEXTUAL_DRAFT_BASE_FEATURES,
} from "../../src/simulation/contextual_draft_research";

test("CPU ridge reproduces an independent closed-form two-feature solution", () => {
    const points = [-1, -0.5, 0.5, 1];
    const rows = points.map((x, board) => {
        const features = new Array<number>(CONTEXTUAL_DRAFT_FEATURE_NAMES.length).fill(0);
        features[0] = 1;
        features[10] = x;
        return { board, seed: board + 100, features, gain: 0.3 + 0.2 * x };
    });
    const fitted = fitContextualDraftRidge(rows, 4, "full", 0.02);
    expect(fitted.weights[0]).toBeCloseTo((0.3 * 4) / 8, 14);
    expect(fitted.weights[10]).toBeCloseTo((0.2 * 2.5) / 6.5, 14);
    expect(fitted.weights.filter((_, index) => index !== 0 && index !== 10).every((weight) => weight === 0)).toBe(true);
    expect(fitted.productionPromotion).toBe(false);
});

test("the context ablation is refitted with contextual columns absent", () => {
    const features = new Array<number>(CONTEXTUAL_DRAFT_FEATURE_NAMES.length).fill(1);
    const rows = [{ board: 0, seed: 3, features, gain: 0.5 }];
    const model = fitContextualDraftRidge(rows, 4, "without-map-synergies", 0.05);
    expect(model.weights.slice(CONTEXTUAL_DRAFT_BASE_FEATURES.length).every((weight) => weight === 0)).toBe(true);
    expect(model.weights[0]).toBeCloseTo(0.5 / (CONTEXTUAL_DRAFT_BASE_FEATURES.length + 4), 14);
    expect(() => fitContextualDraftRidge([{ ...rows[0], gain: NaN }], 4, "full", 0.05)).toThrow();
});
