/** Research-only pooling. Importing this module never changes the registered A19 policy. */
import type { IV09A19Prediction, V09A19CpuModel } from "./a19_inference";
import type { IV09A19Observation } from "./a19_observation";

export const V09_A19_ELIGIBLE_LOGIT_POOL = Object.freeze({
    id: "a19-eligible-mean-logit-research-v1",
    minimumLogitGain: 1,
    actionFamily: "all" as const,
    promotionAllowed: false,
});

function validateIndices(indices: readonly number[], catalogLength: number): void {
    if (
        !Number.isInteger(catalogLength) ||
        catalogLength < 1 ||
        !indices.length ||
        new Set(indices).size !== indices.length ||
        indices.some((index) => !Number.isInteger(index) || index < 0 || index >= catalogLength)
    )
        throw new Error("Invalid research pooling eligibility");
}

/**
 * Average raw logits on a declared eligible set. Differences equal log-probability
 * differences of a geometric probability pool, without needing a full-catalog
 * partition function. This is a different policy from A19's arithmetic pool.
 *
 * The caller must retain the exact scored-primary-tie restriction. Zero entries
 * outside the evaluated set are bookkeeping, never inferred action preferences.
 */
export function expandV09A19MeanLogits(
    predictions: readonly IV09A19Prediction[],
    indices: readonly number[],
    catalogLength: number,
): IV09A19Prediction {
    validateIndices(indices, catalogLength);
    if (
        predictions.length !== 2 ||
        predictions.some(
            (prediction) =>
                prediction.policy.length !== indices.length ||
                prediction.primary.length !== indices.length ||
                ![prediction.valueLogit, ...prediction.policy, ...prediction.primary].every(Number.isFinite),
        )
    )
        throw new Error("Invalid research pooling predictions");
    const policy = Array<number>(catalogLength).fill(0);
    const primary = Array<number>(catalogLength).fill(0);
    indices.forEach((index, offset) => {
        policy[index] = predictions[0].policy[offset] / 2 + predictions[1].policy[offset] / 2;
        primary[index] = predictions[0].primary[offset] / 2 + predictions[1].primary[offset] / 2;
    });
    return {
        policy,
        primary,
        valueLogit: predictions[0].valueLogit / 2 + predictions[1].valueLogit / 2,
    };
}

/**
 * The current dense model scores each candidate independently after encoding the
 * board. Keep globals/entities/terrain intact and preserve the caller's index
 * order. Full-versus-subset prediction parity is an admission requirement.
 */
export function predictV09A19EligibleMeanLogits(
    models: readonly Pick<V09A19CpuModel, "predict">[],
    observation: IV09A19Observation,
    indices: readonly number[],
): IV09A19Prediction {
    validateIndices(indices, observation.candidates.length);
    if (models.length !== 2) throw new Error("Research pooling requires the same two model members");
    const subset = { ...observation, candidates: indices.map((index) => observation.candidates[index]) };
    return expandV09A19MeanLogits(
        models.map((model) => model.predict(subset)),
        indices,
        observation.candidates.length,
    );
}
