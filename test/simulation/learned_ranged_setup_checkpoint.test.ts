import { expect, test } from "bun:test";
import { lockedLearnedRangedSetupModel } from "../../src/simulation/learned_ranged_setup_checkpoint";
import { predictLearnedRangedSetup } from "../../src/simulation/learned_ranged_setup_research";

test("the fitted setup heads remain an immutable, unpromoted 165-feature reference", () => {
    const model = lockedLearnedRangedSetupModel();
    expect(model.features.length).toBe(165);
    expect(model.productionPromotion).toBe(false);
    expect(Object.isFrozen(model.freeWeights)).toBe(true);
    const features = new Array<number>(165).fill(0);
    features[0] = 1;
    features[3] = 1;
    features[6] = 1;
    features[37] = 0.5;
    const expected = (weights: readonly number[]): number => weights[0] + weights[3] + weights[6] + weights[37] / 2;
    const result = predictLearnedRangedSetup(model, features);
    expect(result.free).toBeCloseTo(expected(model.freeWeights), 12);
    expect(result.paid).toBeCloseTo(expected(model.paidWeights), 12);
});
