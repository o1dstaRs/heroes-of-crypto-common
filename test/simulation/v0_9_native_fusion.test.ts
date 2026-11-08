import { expect, test } from "bun:test";

import { V09_MODEL_ARTIFACT } from "../../src/ai/versions/v0_9_artifact";
import { scoreV09FixedPoint, type IV09DenseLayer, type IV09ModelArtifact } from "../../src/ai/versions/v0_9_model";
import { fuseV09NativeResearchModels } from "../../src/simulation/v0_9/native_fusion";
import { sealV09ResearchArtifact } from "../../src/simulation/v0_9/seal_artifact";

const options = { trainingRunId: "9".repeat(64), minOverrideMargin: 512 };
const reseal = (model: IV09ModelArtifact, patch: Partial<IV09ModelArtifact>) =>
    sealV09ResearchArtifact({ ...model, ...patch, modelSha256: null });

function expert(seed: number, hidden = [3, 2]): IV09ModelArtifact {
    const widths = [166, ...hidden, 1];
    const layers: IV09DenseLayer[] = widths.slice(1).map((outputSize, index) => {
        const inputSize = widths[index]!;
        return {
            inputSize,
            outputSize,
            activation: index === hidden.length ? "linear" : "relu",
            scaleShift: index === hidden.length ? 3 : 2,
            weights: Array.from({ length: inputSize * outputSize }, (_, i) => ((i * 7 + seed * 11) % 5) - 2),
            biases: Array.from({ length: outputSize }, (_, i) => ((i * 3 + seed) % 31) - 15),
        };
    });
    return sealV09ResearchArtifact({
        ...structuredClone(V09_MODEL_ARTIFACT),
        status: "trained",
        promoted: false,
        modelSha256: null,
        qualification: null,
        source: {
            commonCommit: "1".repeat(40),
            rulesSha256: "2".repeat(64),
            rosterSha256: "3".repeat(64),
            trainingRunId: "4".repeat(64),
        },
        minOverrideMargin: 512,
        architecture: { kind: "dense_candidate_ranker", inputSize: 166, hiddenSizes: hidden, outputSize: 1 },
        layers,
    });
}

const vector = (row: number) => Array.from({ length: 166 }, (_, column) => Math.sin(row * 13 + column * 17) * 20);
const rounded = (value: number) => (value >= 0 ? Math.floor(value + 0.5) : Math.ceil(value - 0.5));
const zero = (value: number) => (value === 0 ? 0 : value);

function rawHead(model: IV09ModelArtifact, features: number[]): number {
    // Reuse the independent canonical scorer; only the final test-only rescale is removed.
    return scoreV09FixedPoint(
        {
            ...model,
            layers: model.layers.map((layer, i) =>
                i === model.layers.length - 1 ? { ...layer, scaleShift: 0 } : layer,
            ),
        },
        features,
    );
}

test("native fusion exactly preserves expert hidden paths and averages raw heads", () => {
    const parents = [expert(1, [2, 3]), expert(2, [4, 2])];
    const fused = sealV09ResearchArtifact(fuseV09NativeResearchModels(parents, options).artifact);
    expect(fused.architecture.hiddenSizes).toEqual([6, 5]);
    for (let row = 0; row < 128; row += 1) {
        const features = vector(row);
        const expected = rounded(parents.reduce((sum, parent) => sum + rawHead(parent, features), 0) / 16);
        expect(zero(scoreV09FixedPoint(fused, features))).toBe(zero(expected));
        const parentMean = parents.reduce((sum, parent) => sum + scoreV09FixedPoint(parent, features), 0) / 2;
        expect(Math.abs(scoreV09FixedPoint(fused, features) - parentMean)).toBeLessThanOrEqual(1);
    }
});

test("duplicated-expert controls reproduce the original policy scores exactly", () => {
    const parent = expert(3);
    for (const members of [
        [parent, parent],
        [parent, parent, parent, parent],
    ]) {
        const fused = sealV09ResearchArtifact(fuseV09NativeResearchModels(members, options).artifact);
        for (let row = 0; row < 64; row += 1) {
            expect(zero(scoreV09FixedPoint(fused, vector(row)))).toBe(zero(scoreV09FixedPoint(parent, vector(row))));
        }
    }
});

test("fusion rounds once after the mean, including signed half boundaries", () => {
    const parent = expert(1, [2]);
    const withHead = (bias: number) =>
        reseal(parent, {
            layers: [parent.layers[0]!, { ...parent.layers[1]!, weights: [0, 0], biases: [bias], scaleShift: 1 }],
        });
    for (const sign of [-1, 1]) {
        const fused = sealV09ResearchArtifact(
            fuseV09NativeResearchModels([withHead(sign), withHead(3 * sign)], options).artifact,
        );
        expect(scoreV09FixedPoint(fused, vector(0))).toBe(sign);
    }
});

test("fusion stays unsealed and unpromoted and never mutates or aliases its parents", () => {
    const parents = [expert(1), expert(2)];
    const before = JSON.stringify(parents);
    const result = fuseV09NativeResearchModels(parents, options);
    expect(result.artifact).toMatchObject({
        status: "trained",
        promoted: false,
        qualification: null,
        modelSha256: null,
    });
    expect(result.artifact.source.trainingRunId).toBe(options.trainingRunId);
    expect(result.provenance.parentModelSha256).toEqual(parents.map((parent) => parent.modelSha256));
    expect(result.provenance.hiddenActivationsExact).toBe(true);
    (result.artifact.layers[0]!.weights as number[])[0] = 127;
    (result.artifact.normalization.offsets as number[])[0] = 7;
    expect(JSON.stringify(parents)).toBe(before);
});

test("incompatible contracts, source, depth and quantization are rejected rather than approximated", () => {
    const parent = expert(1);
    const offsets = [...parent.normalization.offsets];
    offsets[0] = 1;
    const mismatches = [
        reseal(expert(2), { normalization: { ...parent.normalization, offsets } }),
        reseal(expert(2), { source: { ...parent.source, rulesSha256: "8".repeat(64) } }),
        expert(2, [3]),
        reseal(expert(2), {
            layers: expert(2).layers.map((layer, i) => (i === 0 ? { ...layer, scaleShift: 3 } : layer)),
        }),
    ];
    for (const mismatch of mismatches) expect(() => fuseV09NativeResearchModels([parent, mismatch], options)).toThrow();
    expect(() => fuseV09NativeResearchModels([parent, { ...expert(2), promoted: true }], options)).toThrow();
    expect(() =>
        fuseV09NativeResearchModels([parent, { ...expert(2), modelSha256: "0".repeat(64) }], options),
    ).toThrow();
});

test("summed accumulators and increased output shifts must still satisfy the native safety contract", () => {
    const parent = expert(1, [2]);
    const highBias = reseal(parent, {
        layers: [parent.layers[0]!, { ...parent.layers[1]!, weights: [0, 0], biases: [1_500_000_000] }],
    });
    expect(() => fuseV09NativeResearchModels([highBias, highBias], options)).toThrow(/int32/);
    const highShift = reseal(parent, {
        layers: [parent.layers[0]!, { ...parent.layers[1]!, scaleShift: 30 }],
    });
    expect(() => fuseV09NativeResearchModels([highShift, highShift], options)).toThrow(/scaleShift/);
});

test("only declared power-of-two committees and registered margins are accepted", () => {
    const parent = expert(1);
    for (const count of [0, 1, 3, 5]) {
        expect(() => fuseV09NativeResearchModels(Array<IV09ModelArtifact>(count).fill(parent), options)).toThrow();
    }
    expect(() => fuseV09NativeResearchModels([parent, parent], { ...options, trainingRunId: "mutable" })).toThrow();
    expect(() => fuseV09NativeResearchModels([parent, parent], { ...options, minOverrideMargin: -1 })).toThrow();
});
