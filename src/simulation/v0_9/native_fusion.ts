/** Research-only native model composition. Importing does not activate or install a policy. */
// Initialize Unit prototypes before the feature/model import cycle, including for compiled consumers.
import "../../ai/decision_path_catalog";

import { validateV09ModelArtifact, type IV09DenseLayer, type IV09ModelArtifact } from "../../ai/versions/v0_9_model";
import { verifyV09ResearchArtifact } from "./parity";

export interface IV09NativeFusionOptions {
    readonly trainingRunId: string;
    readonly minOverrideMargin: number;
}

export interface IV09NativeFusionResult {
    /** Unsealed: use the canonical research sealer before any evaluation. */
    readonly artifact: IV09ModelArtifact;
    readonly provenance: {
        readonly method: "native-dense-pre-rounding-mean.v1";
        readonly parentModelSha256: readonly string[];
        readonly hiddenActivationsExact: true;
        /** One final rounding, rather than averaging already-rounded parent outputs. */
        readonly finalRounding: "half-away-after-mean";
        readonly maximumDifferenceFromMeanParentScores: 1;
    };
}

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

/**
 * Concatenate compatible native experts into one ordinary fixed-point artifact. Shared normalization and
 * hidden-layer shifts are mandatory: hidden activations are copied exactly, with zero cross-expert weights.
 * The final head averages unrounded parent accumulators, using a power-of-two shift and one final rounding.
 * This needs no search, GPU, retraining, weight requantization or new inference format. It remains research.
 */
export function fuseV09NativeResearchModels(
    inputs: readonly IV09ModelArtifact[],
    options: IV09NativeFusionOptions,
): IV09NativeFusionResult {
    if (inputs.length !== 2 && inputs.length !== 4) throw new Error("native fusion requires two or four experts");
    if (!/^[0-9a-f]{64}$/.test(options.trainingRunId)) {
        throw new Error("native fusion requires an immutable registration SHA");
    }
    if (
        !Number.isInteger(options.minOverrideMargin) ||
        options.minOverrideMargin < 0 ||
        options.minOverrideMargin > 0x7fffffff
    ) {
        throw new Error("native fusion requires a nonnegative int32 override margin");
    }
    // Copy first, so neither parent mutation nor a caller changing the result can alter another artifact.
    const parents = inputs.map((parent) => structuredClone(parent));
    for (const parent of parents) {
        verifyV09ResearchArtifact(parent);
        if (parent.qualification !== null) throw new Error("native fusion accepts unqualified research parents");
    }
    const first = parents[0]!;
    const depth = first.layers.length;
    if (depth < 2) throw new Error("native fusion requires at least one hidden layer");
    for (const parent of parents.slice(1)) {
        if (
            !same(parent.features, first.features) ||
            !same(parent.normalization, first.normalization) ||
            !same(parent.fixedPoint, first.fixedPoint)
        ) {
            throw new Error("native fusion requires identical feature, normalization and fixed-point contracts");
        }
        if (
            parent.source.commonCommit !== first.source.commonCommit ||
            parent.source.rulesSha256 !== first.source.rulesSha256 ||
            parent.source.rosterSha256 !== first.source.rosterSha256
        ) {
            throw new Error("native fusion cannot combine different engine or roster identities");
        }
        if (parent.layers.length !== depth) throw new Error("native fusion requires matching layer depth");
        for (let index = 0; index < depth; index += 1) {
            if (
                parent.layers[index]!.scaleShift !== first.layers[index]!.scaleShift ||
                parent.layers[index]!.activation !== first.layers[index]!.activation
            ) {
                throw new Error("native fusion requires matching layer scales and activations");
            }
        }
    }

    const layers: IV09DenseLayer[] = [];
    for (let index = 0; index < depth - 1; index += 1) {
        const members = parents.map((parent) => parent.layers[index]!);
        const inputSize =
            index === 0 ? first.architecture.inputSize : members.reduce((n, layer) => n + layer.inputSize, 0);
        const outputSize = members.reduce((n, layer) => n + layer.outputSize, 0);
        const weights = Array<number>(inputSize * outputSize).fill(0);
        const biases: number[] = [];
        let firstRow = 0;
        let firstColumn = 0;
        for (const member of members) {
            for (let row = 0; row < member.outputSize; row += 1) {
                const start = (firstRow + row) * inputSize + firstColumn;
                for (let column = 0; column < member.inputSize; column += 1) {
                    weights[start + column] = member.weights[row * member.inputSize + column]!;
                }
                biases.push(member.biases[row]!);
            }
            firstRow += member.outputSize;
            if (index !== 0) firstColumn += member.inputSize;
        }
        layers.push({ inputSize, outputSize, activation: "relu", scaleShift: members[0]!.scaleShift, weights, biases });
    }
    const heads = parents.map((parent) => parent.layers[depth - 1]!);
    layers.push({
        inputSize: heads.reduce((n, layer) => n + layer.inputSize, 0),
        outputSize: 1,
        activation: "linear",
        scaleShift: heads[0]!.scaleShift + Math.log2(parents.length),
        weights: heads.flatMap((layer) => [...layer.weights]),
        biases: [heads.reduce((sum, layer) => sum + layer.biases[0]!, 0)],
    });
    const parentModelSha256 = parents.map((parent) => parent.modelSha256!);
    const artifact: IV09ModelArtifact = {
        ...first,
        status: "trained",
        promoted: false,
        modelId: "v0.9-native-fusion-unsealed",
        modelSha256: null,
        qualification: null,
        source: { ...first.source, trainingRunId: options.trainingRunId },
        minOverrideMargin: options.minOverrideMargin,
        architecture: {
            kind: "dense_candidate_ranker",
            inputSize: first.architecture.inputSize,
            hiddenSizes: layers.slice(0, -1).map((layer) => layer.outputSize),
            outputSize: 1,
        },
        layers,
        notes: `UNPROMOTED native expert fusion, pre-rounding arithmetic mean. Parents: ${parentModelSha256.join(",")}`,
    };
    // The wider output head must independently satisfy the original signed-int32 envelope. Averages do not
    // excuse overflowing before the rescale. Never clip, silently rescale or requantize an unsafe sum.
    const errors = validateV09ModelArtifact({ ...artifact, modelSha256: "0".repeat(64) });
    if (errors.length) throw new Error(`unsafe native fusion: ${errors.join("; ")}`);
    return {
        artifact,
        provenance: {
            method: "native-dense-pre-rounding-mean.v1",
            parentModelSha256,
            hiddenActivationsExact: true,
            finalRounding: "half-away-after-mean",
            maximumDifferenceFromMeanParentScores: 1,
        },
    };
}
