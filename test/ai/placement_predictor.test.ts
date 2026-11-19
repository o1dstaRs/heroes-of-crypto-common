import { expect, test } from "bun:test";

import {
    chooseCandidate,
    compilePlacementPredictor,
    encode,
    predict,
    type PlacementModel,
} from "../../src/ai/placement/layout";
import { getPlacementModel, getPlacementRelationModel } from "../../src/ai/placement/model";
import { relationFeatures } from "../../src/ai/placement/relations";
import fixture from "./fixtures/a19_final_placement.json";
import relationFixture from "./fixtures/a19_final_placement_v2.json";

test("compiled packed models preserve exact scores on recorded public formations", () => {
    const model = getPlacementModel();
    const score = compilePlacementPredictor(model);
    for (const sample of fixture.cases)
        for (const points of [sample.baseline, sample.positions]) {
            const features = encode(sample.input, points);
            expect(score(features)).toBe(predict(model, features));
        }
    const relationModel = getPlacementRelationModel();
    const relationScore = compilePlacementPredictor(relationModel);
    for (const sample of relationFixture.cases)
        for (const points of [sample.baseline, sample.referencePositions, sample.positions]) {
            const features = relationFeatures(sample.input, points, sample.referencePositions);
            expect(relationScore(features)).toBe(predict(relationModel, features));
        }
});

test("the strict 0.03 margin retains binary64 input precision", () => {
    const model: PlacementModel = {
        id: "margin",
        minimumGain: 0.03,
        layers: [
            {
                weight: [
                    [1, 0],
                    [0, 1],
                ],
                bias: [0, 0],
            },
            { weight: [[0, 1]], bias: [0] },
        ],
    };
    const score = compilePlacementPredictor(model);
    const baseline = score([0, 0]);
    expect(chooseCandidate([baseline, score([0, 0.03])], 0.03)).toBe(0);
    const above = 0.03 + Number.EPSILON / 64;
    expect(Math.fround(above)).toBe(Math.fround(0.03));
    expect(chooseCandidate([baseline, score([0, above])], 0.03)).toBe(1);
    expect(score([0, above])).toBe(predict(model, [0, above]));
});

test("nonzero products retain their original order around zero columns", () => {
    const model: PlacementModel = {
        id: "order",
        minimumGain: 0.03,
        layers: [
            { weight: [[1e16, 2, 1, -1e16]], bias: [0] },
            { weight: [[1]], bias: [0] },
        ],
    };
    expect(compilePlacementPredictor(model)([1, 0, 1, 1])).toBe(0);
    expect(compilePlacementPredictor(model)([1, 0, 1, 1])).toBe(predict(model, [1, 0, 1, 1]));
});

test("signed zero, subnormal products and finite overflow match the dense evaluator", () => {
    const linear: PlacementModel = {
        id: "signed-zero-output",
        minimumGain: 0.03,
        layers: [{ weight: [[-1]], bias: [-0] }],
    };
    expect(Object.is(predict(linear, [0]), -0)).toBe(true);
    expect(Object.is(compilePlacementPredictor(linear)([0]), -0)).toBe(true);
    const special = [0, -0, Number.MIN_VALUE, -Number.MIN_VALUE, 1, -1, Number.MAX_VALUE, -Number.MAX_VALUE];
    for (let seed = 0; seed < 64; seed++) {
        const depth = (seed % 3) + 1;
        const model: PlacementModel = {
            id: "edge",
            minimumGain: 0.03,
            layers: Array.from({ length: depth }, (_, l) => ({
                weight: Array.from({ length: l === depth - 1 ? 1 : 4 }, (_, i) =>
                    Array.from(
                        { length: l === 0 ? 8 : 4 },
                        (_, j) => special[(seed + i * 5 + j * 3 + l) % special.length],
                    ),
                ),
                bias: Array.from({ length: l === depth - 1 ? 1 : 4 }, (_, i) => special[(seed + i) % special.length]),
            })),
        };
        const features = Array.from({ length: 8 }, (_, j) => special[(seed + j) % special.length]);
        expect(compilePlacementPredictor(model)(features)).toBe(predict(model, features));
    }
});

test("compiled tensor snapshots and frozen inputs retain no mutable match state", () => {
    const model: PlacementModel = {
        id: "snapshot",
        minimumGain: 0.03,
        layers: [
            { weight: [[2, 0]], bias: [1] },
            { weight: [[3]], bias: [0] },
        ],
    };
    const score = compilePlacementPredictor(model);
    const features = [1, 0];
    Object.freeze(features);
    expect(score(features)).toBe(9);
    model.layers[0].weight[0][0] = 100;
    model.layers[1].bias[0] = 100;
    expect(score(features)).toBe(9);
    expect(score([0, 1])).toBe(3);
    expect(score(features)).toBe(9);
    expect(features).toEqual([1, 0]);
});

test("nonfinite zero-column weights cannot be silently skipped", () => {
    for (const invalid of [NaN, Infinity, -Infinity])
        expect(() =>
            compilePlacementPredictor({
                id: "invalid",
                minimumGain: 0.03,
                layers: [
                    { weight: [[1, invalid]], bias: [0] },
                    { weight: [[1]], bias: [0] },
                ],
            }),
        ).toThrow();
    const score = compilePlacementPredictor(getPlacementModel());
    expect(() => score([1])).toThrow();
});
