/** Research only. Preserve forecast effects of the original final A19 cast. */
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import checkpoint from "./checkpoints/battle_mage_finish_guard_20261114/checkpoint.json";
import bundle from "./checkpoints/battle_mage_finish_guard_20261114/model_bundle.json";

export const FINISH_GUARD_ID = "battle-mage-finish-guard-v1";
export const BATTLE_MAGE_MONOTONE_MODEL_SHA256 = "37372835db257f9eca9b42f355d05515157f26675d019b9f4cfbb622ef7a61f8";
export const BATTLE_MAGE_FINISH_GUARD_CHECKPOINT_SHA256 =
    "93aaed4e5818bc165066e34a7f96710636682c847ba18aad8df6e43d074fd16e";
export const PROTECTED_EFFECTS = [
    "stacksFinished",
    "unactedFinished",
    "resurrectionChargesFinished",
    "shieldBreaks",
] as const;

export interface GuardDecision {
    choice: number;
    proposedChoice: number;
    valid: boolean;
    blockedBy: string[];
}

interface FrozenModel {
    schema: string;
    featureNames: string[];
    scales: number[];
    weights: number[][];
    margin: number;
    lowerDecile: number;
}

/** Exact original bytes. Preservation does not qualify or activate this model. */
export function lockedBattleMageMonotoneBytes(): Buffer {
    if (bundle.encoding !== "gzip-base64" || bundle.rawSha256 !== BATTLE_MAGE_MONOTONE_MODEL_SHA256)
        throw new Error("Battle Mage model bundle identity changed");
    const bytes = gunzipSync(Buffer.from(bundle.data, "base64"), { maxOutputLength: 128 * 1024 });
    if (
        bytes.byteLength !== bundle.rawBytes ||
        createHash("sha256").update(bytes).digest("hex") !== BATTLE_MAGE_MONOTONE_MODEL_SHA256
    )
        throw new Error("Battle Mage model bytes changed");
    return bytes;
}

export function lockedBattleMageFinishGuardCheckpoint() {
    if (
        createHash("sha256").update(JSON.stringify(checkpoint)).digest("hex") !==
            BATTLE_MAGE_FINISH_GUARD_CHECKPOINT_SHA256 ||
        checkpoint.id !== FINISH_GUARD_ID ||
        checkpoint.productionActivation ||
        checkpoint.freshGuardQualificationPassed ||
        checkpoint.currentServingQualified ||
        checkpoint.originalConfirmation.gate ||
        checkpoint.subsequentExperimentsMayOverwrite
    )
        throw new Error("Battle Mage research qualification metadata changed");
    return structuredClone(checkpoint);
}

/**
 * Caller supplies the original final A19 action first, followed only by admitted fully R2-scored
 * legal casts at the first eligible Mage root. Consume that attempt even when this returns zero;
 * do not rerank, retry another root or expose private/future information in the feature vector.
 */
export function chooseBattleMageFinishGuardResearchCast(
    candidates: readonly { features: readonly number[] }[],
): GuardDecision {
    const model = JSON.parse(lockedBattleMageMonotoneBytes().toString("utf8")) as FrozenModel;
    const invalid = (): GuardDecision => ({ choice: 0, proposedChoice: 0, valid: false, blockedBy: ["invalid-input"] });
    if (
        candidates.length < 2 ||
        candidates.length > 4 ||
        candidates.some(
            (c) => c.features.length !== model.featureNames.length || c.features.some((v) => !Number.isFinite(v)),
        )
    )
        return invalid();
    let choice = 0,
        best = model.margin;
    for (let i = 1; i < candidates.length; i++) {
        const values = candidates[i].features.map((v, j) =>
            Math.max(-4, Math.min(4, (v - candidates[0].features[j]) / model.scales[j])),
        );
        const estimates = model.weights
            .map((weights) => weights.reduce((sum, weight, j) => sum + weight * values[j], 0))
            .sort((a, b) => a - b);
        if (!estimates.every(Number.isFinite)) return invalid();
        const mean = estimates.reduce((sum, value) => sum + value, 0) / estimates.length;
        const lower = estimates[Math.floor(0.1 * (estimates.length - 1))];
        if (mean > best && lower > model.lowerDecile) {
            choice = i;
            best = mean;
        }
    }
    return preservePredictedFinishes(model.featureNames, candidates, choice);
}

export function preservePredictedFinishes(
    featureNames: readonly string[],
    candidates: readonly { features: readonly number[] }[],
    proposedChoice: number,
): GuardDecision {
    const invalid = (): GuardDecision => ({
        choice: 0,
        proposedChoice,
        valid: false,
        blockedBy: ["invalid-input"],
    });
    if (!Number.isInteger(proposedChoice) || proposedChoice < 0 || proposedChoice >= candidates.length)
        return invalid();
    const indices = PROTECTED_EFFECTS.map((name) => featureNames.indexOf(name));
    if (indices.some((index) => index < 0) || new Set(featureNames).size !== featureNames.length) return invalid();
    const baseline = candidates[0]?.features;
    const proposed = candidates[proposedChoice]?.features;
    if (!baseline || !proposed || baseline.length !== featureNames.length || proposed.length !== featureNames.length)
        return invalid();
    if (
        indices.some(
            (index) =>
                !Number.isInteger(baseline[index]) ||
                baseline[index] < 0 ||
                !Number.isInteger(proposed[index]) ||
                proposed[index] < 0,
        )
    )
        return invalid();
    const blockedBy = PROTECTED_EFFECTS.filter((_name, i) => proposed[indices[i]] < baseline[indices[i]]);
    return { choice: blockedBy.length ? 0 : proposedChoice, proposedChoice, valid: true, blockedBy };
}
