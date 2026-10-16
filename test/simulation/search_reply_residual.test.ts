import { describe, expect, it } from "bun:test";
import {
    REPLY_RESIDUAL_FEATURE_NAMES,
    predictReplyResidual,
    validateReplyResidualModel,
    type IReplyResidualModel,
} from "../../src/simulation/search_reply_residual";

const width = REPLY_RESIDUAL_FEATURE_NAMES.length;
function model(): IReplyResidualModel {
    return {
        schema: "hoc.a19-reply-residual-model.v1",
        sourceCommit: "0".repeat(40),
        featureNames: REPLY_RESIDUAL_FEATURE_NAMES,
        normalization: { offsets: Array(width).fill(0), scales: Array(width).fill(1), clip: 8 },
        layers: [{ inputSize: width, outputSize: 1, weights: Array(width).fill(0), biases: [0], activation: "linear" }],
        alpha: 1,
    };
}
describe("offline searched-reply correction", () => {
    it("keeps zero corrections and alpha-zero controls exact", () => {
        const m = model(),
            rows = Array.from({ length: 3 }, () => Array(width).fill(0)),
            qs = [0, 0.42, 1];
        validateReplyResidualModel(m);
        expect(predictReplyResidual(m, rows, qs)).toEqual(qs);
        const other = { ...m, alpha: 0, layers: [{ ...m.layers[0], biases: [0.75] }] };
        validateReplyResidualModel(other);
        expect(predictReplyResidual(other, rows, qs)).toEqual(qs);
    });
    it("normalizes, clips, applies output-major layers and bounds learned scores", () => {
        const m = model(),
            weights = Array(width * 2).fill(0);
        weights[0] = 1;
        weights[width] = -1;
        const offsets = Array(width).fill(0),
            scales = Array(width).fill(1);
        offsets[0] = 1;
        scales[0] = 2;
        const x = {
            ...m,
            normalization: { offsets, scales, clip: 8 },
            layers: [
                { inputSize: width, outputSize: 2, weights, biases: [0, 0], activation: "relu" as const },
                { inputSize: 2, outputSize: 1, weights: [0.1, -0.1], biases: [0.05], activation: "linear" as const },
            ],
        };
        validateReplyResidualModel(x);
        const rows = [2, -2, 100, -100].map((v) => {
            const row = Array(width).fill(0);
            row[0] = v;
            return row;
        });
        const result = predictReplyResidual(x, rows, [0.5, 0.5, 0.5, 0.5]);
        expect(result[0]).toBeCloseTo(0.75, 12);
        expect(result[1]).toBe(0);
        expect(result[2]).toBe(1);
        expect(result[3]).toBe(0);
    });
    it("rejects incompatible schemas, features and non-finite weights", () => {
        const m = model();
        expect(() => validateReplyResidualModel({ ...m, featureNames: [...m.featureNames].reverse() })).toThrow();
        expect(() => validateReplyResidualModel({ ...m, alpha: 1.01 })).toThrow();
        expect(() => validateReplyResidualModel({ ...m, layers: [{ ...m.layers[0], biases: [NaN] }] })).toThrow();
        expect(() => predictReplyResidual(m, [Array(width).fill(Infinity)], [0.5])).toThrow();
        expect(() => predictReplyResidual(m, [[]], [0.5])).toThrow();
    });
});
