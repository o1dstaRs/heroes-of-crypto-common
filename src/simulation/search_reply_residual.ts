/* Offline A19 reply-residual features and inference. No production registration or environment hooks. */
import type { IDecisionContext } from "../ai/ai_strategy";
import type { IEnumeratedCandidate } from "../ai/candidates";
import type { Unit } from "../units/unit";
import { CONTINUATION_FEATURE_NAMES, continuationFeatures } from "./measure_search_continuation";

export const REPLY_RESIDUAL_FEATURE_NAMES: readonly string[] = Object.freeze([
    ...CONTINUATION_FEATURE_NAMES,
    "nativeMean",
    "nativeIncumbentMean",
    "nativeGap",
    "nativeVariance",
    "nativeIncumbentVariance",
    "nativeMaterial",
    "nativeMaterialGap",
    "leafValue",
    "hasLeafValue",
    "nativeZeroFraction",
    "nativeOneFraction",
    "nativeValueUncertainty",
    "nativeRankFraction",
    "nativeBestGap",
]);

export interface IReplyNativeEvidence {
    means: readonly number[];
    materials: readonly number[];
    samples: readonly (readonly number[])[];
    leafScores?: ReadonlyMap<string, number>;
}

/** Public root features plus completed native R4 evidence; no searched-policy values or chosen indices. */
export function replyResidualFeatures(
    unit: Unit,
    context: IDecisionContext,
    candidates: readonly IEnumeratedCandidate[],
    evidence: IReplyNativeEvidence,
): number[][] {
    if (
        candidates.length < 2 ||
        evidence.means.length !== candidates.length ||
        evidence.materials.length !== candidates.length ||
        evidence.samples.length !== candidates.length
    )
        throw new Error("Reply residual requires a complete native shortlist");
    const variances = evidence.samples.map((values, i) => {
        if (
            values.length !== 4 ||
            values.some((v) => !Number.isFinite(v) || v < 0 || v > 1) ||
            !Number.isFinite(evidence.materials[i]) ||
            Math.abs(values.reduce((sum, v) => sum + v, 0) / 4 - evidence.means[i]) > 1e-12
        )
            throw new Error("Reply residual requires four complete native samples");
        return values.reduce((sum, v) => sum + (v - evidence.means[i]) ** 2, 0) / 3;
    });
    const publicFeatures = continuationFeatures(unit, context, candidates),
        best = Math.max(...evidence.means);
    return candidates.map((candidate, i) => {
        const q = evidence.means[i],
            values = evidence.samples[i];
        const leaf = evidence.leafScores?.get(JSON.stringify(candidate.actions));
        const row = [
            ...publicFeatures[i],
            q,
            evidence.means[0],
            q - evidence.means[0],
            variances[i],
            variances[0],
            evidence.materials[i],
            evidence.materials[i] - evidence.materials[0],
            leaf ?? 0.5,
            leaf === undefined ? 0 : 1,
            values.filter((v) => v === 0).length / 4,
            values.filter((v) => v === 1).length / 4,
            q * (1 - q),
            evidence.means.filter((v) => v > q).length / (candidates.length - 1),
            best - q,
        ];
        if (row.length !== REPLY_RESIDUAL_FEATURE_NAMES.length || row.some((v) => !Number.isFinite(v)))
            throw new Error("Invalid reply residual feature vector");
        return row;
    });
}

export interface IReplyResidualModel {
    schema: "hoc.a19-reply-residual-model.v1";
    sourceCommit: string;
    featureNames: readonly string[];
    normalization: { offsets: readonly number[]; scales: readonly number[]; clip: number };
    layers: readonly {
        inputSize: number;
        outputSize: number;
        weights: readonly number[];
        biases: readonly number[];
        activation: "linear" | "relu";
    }[];
    alpha: number;
}

export function validateReplyResidualModel(model: IReplyResidualModel): void {
    const width = REPLY_RESIDUAL_FEATURE_NAMES.length;
    const finite = (xs: readonly number[]) => Array.isArray(xs) && xs.every(Number.isFinite);
    if (
        model?.schema !== "hoc.a19-reply-residual-model.v1" ||
        !/^[a-f0-9]{40}$/.test(model.sourceCommit) ||
        JSON.stringify(model.featureNames) !== JSON.stringify(REPLY_RESIDUAL_FEATURE_NAMES) ||
        !model.normalization ||
        model.normalization.offsets?.length !== width ||
        model.normalization.scales?.length !== width ||
        !finite(model.normalization.offsets) ||
        !finite(model.normalization.scales) ||
        model.normalization.scales.some((s) => s <= 0) ||
        model.normalization.clip !== 8 ||
        !Number.isFinite(model.alpha) ||
        model.alpha < 0 ||
        model.alpha > 1 ||
        !Array.isArray(model.layers) ||
        model.layers.length < 1 ||
        model.layers.length > 2
    )
        throw new Error("Invalid reply residual model metadata");
    let input = width;
    for (const [i, layer] of model.layers.entries()) {
        const last = i === model.layers.length - 1;
        if (
            layer.inputSize !== input ||
            !Number.isSafeInteger(layer.outputSize) ||
            layer.outputSize < 1 ||
            layer.outputSize > 32 ||
            (last && (layer.outputSize !== 1 || layer.activation !== "linear")) ||
            (!last && layer.activation !== "relu") ||
            layer.weights?.length !== input * layer.outputSize ||
            layer.biases?.length !== layer.outputSize ||
            !finite(layer.weights) ||
            !finite(layer.biases)
        )
            throw new Error("Invalid reply residual model layer");
        input = layer.outputSize;
    }
}

/** Validate once at load. Scores stay in the leaf's unit interval; this is a learned estimate, not a bound. */
export function predictReplyResidual(
    model: IReplyResidualModel,
    features: readonly (readonly number[])[],
    nativeMeans: readonly number[],
): number[] {
    if (features.length !== nativeMeans.length) throw new Error("Reply residual row count mismatch");
    return features.map((row, i) => {
        if (
            row.length !== model.featureNames.length ||
            row.some((v) => !Number.isFinite(v)) ||
            !Number.isFinite(nativeMeans[i]) ||
            nativeMeans[i] < 0 ||
            nativeMeans[i] > 1
        )
            throw new Error("Invalid reply residual inference row");
        let input = row.map((v, j) =>
            Math.max(-8, Math.min(8, (v - model.normalization.offsets[j]) * model.normalization.scales[j])),
        );
        for (const layer of model.layers) {
            const next = Array.from({ length: layer.outputSize }, (_, o) => {
                let value = layer.biases[o];
                for (let k = 0; k < input.length; k++) value += input[k] * layer.weights[o * input.length + k];
                return layer.activation === "relu" ? Math.max(0, value) : value;
            });
            input = next;
        }
        if (!Number.isFinite(input[0])) throw new Error("Non-finite reply residual prediction");
        return Math.max(0, Math.min(1, nativeMeans[i] + model.alpha * input[0]));
    });
}
