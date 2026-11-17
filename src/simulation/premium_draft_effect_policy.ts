import { createHash } from "node:crypto";
import type { IDraftMatchupModel } from "../ai/setup/draft_matchup_value";
import type { MatchedDraftView } from "./premium_matched_draft_model";
import {
    createPremiumDraftEffectFeatures,
    PREMIUM_DRAFT_EFFECT_FEATURES,
    PREMIUM_DRAFT_EFFECT_SCHEMA,
} from "./premium_draft_effect_features";

export const PREMIUM_DRAFT_EFFECT_MODEL_SCHEMA = "premium-public-draft-effect-ridge-v1";
export interface IPremiumDraftEffectModel {
    schema: typeof PREMIUM_DRAFT_EFFECT_MODEL_SCHEMA;
    featureSchema: typeof PREMIUM_DRAFT_EFFECT_SCHEMA;
    features: readonly string[];
    weights: readonly number[];
    scales: readonly number[];
    historicalModelCanonicalSha256: string;
    margin: 0.03;
}

/** Unqualified research policy. Compare every legal final pick; do not force the historical top choice. */
export function createPremiumDraftEffectPolicy(historical: IDraftMatchupModel, model: IPremiumDraftEffectModel) {
    const priorSha = createHash("sha256").update(JSON.stringify(historical)).digest("hex");
    if (
        model.schema !== PREMIUM_DRAFT_EFFECT_MODEL_SCHEMA ||
        model.featureSchema !== PREMIUM_DRAFT_EFFECT_SCHEMA ||
        model.historicalModelCanonicalSha256 !== priorSha ||
        model.margin !== 0.03 ||
        JSON.stringify(model.features) !== JSON.stringify(PREMIUM_DRAFT_EFFECT_FEATURES) ||
        model.weights.length !== PREMIUM_DRAFT_EFFECT_FEATURES.length ||
        model.scales.length !== model.weights.length ||
        model.weights.some((v) => !Number.isFinite(v)) ||
        model.scales.some((v) => !Number.isFinite(v) || v <= 0)
    )
        throw new Error("Invalid public draft-effect model");
    const weights = [...model.weights],
        scales = [...model.scales],
        features = createPremiumDraftEffectFeatures(historical);
    return (view: MatchedDraftView, ownTeam: number, incumbent: number) => {
        const candidates: { creatureId: number; predictedGain: number }[] = [];
        let chosen = incumbent,
            gain = 0;
        for (const id of [...view.availableCreatureIds].sort((a, b) => a - b)) {
            const input = features(view, ownTeam, incumbent, id);
            if (!input) return null;
            const predictedGain = input.values.reduce((sum, x, i) => sum + (x * weights[i]) / scales[i], 0);
            if (!Number.isFinite(predictedGain)) return null;
            candidates.push({ creatureId: id, predictedGain });
            if (predictedGain > gain) {
                chosen = id;
                gain = predictedGain;
            }
        }
        if (!candidates.length || !candidates.some((c) => c.creatureId === incumbent)) return null;
        return { incumbent, selectedCreatureId: gain > 0.03 ? chosen : incumbent, predictedGain: gain, candidates };
    };
}
