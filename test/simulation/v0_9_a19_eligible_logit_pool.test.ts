import { expect, test } from "bun:test";
import { meanA19Policy } from "../../src/simulation/a19_neural_model";
import { selectV09A19Correction } from "../../src/simulation/v0_9/a19_correction";
import {
    expandV09A19MeanLogits,
    predictV09A19EligibleMeanLogits,
    V09_A19_ELIGIBLE_LOGIT_POOL,
} from "../../src/simulation/v0_9/a19_eligible_logit_pool";
import type { IV09A19Prediction } from "../../src/simulation/v0_9/a19_inference";
import type { IV09A19Observation } from "../../src/simulation/v0_9/a19_observation";

const prediction = (policy: number[]): IV09A19Prediction => ({ policy, primary: policy.map(() => 0), valueLogit: 0 });
const choose = (policy: number[]) =>
    selectV09A19Correction({
        candidates: policy.map(() => ({ actions: [] })),
        means: [1, 1, 0],
        completed: [2, 2, 2],
        selected: 0,
        policy,
        minimumLogitGain: 1,
        actionFamily: "all",
    });

test("an excluded high logit can affect the existing arithmetic pool; the research logit difference is invariant", () => {
    const left = prediction([8, 0, 0]);
    const right = prediction([0, 2, 0]);
    expect(choose(meanA19Policy([left, right]).policy)).toBe(0);
    expect(choose(meanA19Policy([prediction([8, 0, 100]), right]).policy)).toBe(1);
    const pooled = expandV09A19MeanLogits([prediction([8, 0]), prediction([0, 2])], [0, 1], 3);
    expect(pooled.policy).toEqual([4, 1, 0]);
    expect(choose(pooled.policy)).toBe(0);
    expect(V09_A19_ELIGIBLE_LOGIT_POOL.promotionAllowed).toBe(false);
});

test("research pooling uses exactly the supplied subset and preserves its original catalog positions", () => {
    const calls: IV09A19Observation[] = [];
    const model = {
        predict(observation: IV09A19Observation) {
            calls.push(observation);
            return prediction(observation.candidates.map((candidate) => candidate.features[0]));
        },
    };
    const observation = {
        globals: [7],
        entities: [[9]],
        terrain: [3],
        actorIndex: 0,
        candidates: [0, 1, 2, 3].map((index) => ({ features: [index * 2], targetIndex: -1 })),
    } as IV09A19Observation;
    const before = structuredClone(observation);
    const result = predictV09A19EligibleMeanLogits([model, model], observation, [3, 1]);
    expect(result.policy).toEqual([0, 2, 0, 6]);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
        expect(call.candidates).toEqual([observation.candidates[3], observation.candidates[1]]);
        expect(call.globals).toBe(observation.globals);
        expect(call.entities).toBe(observation.entities);
        expect(call.terrain).toBe(observation.terrain);
    }
    expect(observation).toEqual(before);
});

test("per-member constant shifts preserve correction differences and the margin boundary", () => {
    const original = expandV09A19MeanLogits([prediction([0, 2]), prediction([0, 0])], [0, 1], 3);
    const shifted = expandV09A19MeanLogits([prediction([30, 32]), prediction([-4, -4])], [0, 1], 3);
    expect(choose(original.policy)).toBe(1);
    expect(choose(shifted.policy)).toBe(1);
    expect(shifted.policy[1] - shifted.policy[0]).toBe(original.policy[1] - original.policy[0]);
    expect(choose(expandV09A19MeanLogits([prediction([0, 1.999]), prediction([0, 0])], [0, 1], 3).policy)).toBe(0);
});

test("invalid and ambiguous subset metadata fails before invoking either model", () => {
    let calls = 0;
    const model = {
        predict: () => {
            calls++;
            return prediction([0]);
        },
    };
    const observation = { candidates: [{}, {}, {}] } as IV09A19Observation;
    for (const indices of [[], [0, 0], [-1], [3], [NaN], [0.5]])
        expect(() => predictV09A19EligibleMeanLogits([model, model], observation, indices)).toThrow();
    expect(calls).toBe(0);
    expect(() => predictV09A19EligibleMeanLogits([model], observation, [0])).toThrow();
    expect(() => expandV09A19MeanLogits([prediction([0]), prediction([NaN])], [0], 1)).toThrow();
    expect(() => expandV09A19MeanLogits([prediction([0]), prediction([1, 2])], [0], 1)).toThrow();
});
