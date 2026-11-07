import { Doctrine } from "../../doctrines/doctrine_properties";
import type { IDraftScoutingContext } from "../../picks/draft_visibility";
import savedModel from "../../simulation/v0_9/checkpoints/doctrine_draft_v3_20261104/model.json";
import {
    doctrineDraftFeatures,
    predictDoctrineDraftGain,
    type DoctrineDraftModelVersion,
    type IDoctrineDraftChoice,
    type IDoctrineDraftModel,
    type ScoutingDoctrine,
} from "../../simulation/v0_9/doctrine_draft_model";
import type { ArtifactFitVersion } from "./artifact_fit";

export const V09_DEFAULT_DRAFT_MODEL_ID = "doctrine-draft-v3-20261104";
export const V09_DEFAULT_DRAFT_BASE_POLICY_SPEC = "ranked-unit-strength-a19-side-v4-w16-r4";
export const V09_DEFAULT_DRAFT_MODEL_SHA256 = "2736ce8d7917e12c5078b8cae0b51f49c2e20496b2ce181bf9995e04ef65ec7a";

export interface IDoctrineDraftContext {
    readonly ownCreatureIds: readonly number[];
    readonly knownOpponentCreatureIds: readonly number[];
    readonly tier1ArtifactId?: number;
    readonly tier2ArtifactId?: number;
    readonly artifactFitVersion: ArtifactFitVersion;
    readonly scouting: IDraftScoutingContext;
}

export interface IDoctrineDraftCandidate extends IDoctrineDraftChoice {
    readonly id: number;
}

export interface IDoctrineDraftDecisionInput {
    readonly context: IDoctrineDraftContext;
    readonly preferred: IDoctrineDraftCandidate;
    readonly alternative?: IDoctrineDraftCandidate;
    readonly level: number;
    readonly overrideUsed: boolean;
    readonly maskAdvanceInformation?: boolean;
}

export interface IDoctrineDraftDecision {
    readonly choice: number;
    readonly consumeOverride: boolean;
    readonly features?: readonly number[];
}

/** Pure decision: the caller commits consumption together with the accepted pick or collision reveal. */
export function selectDoctrineDraftChoice(
    model: IDoctrineDraftModel,
    doctrine: ScoutingDoctrine,
    input: IDoctrineDraftDecisionInput,
): IDoctrineDraftDecision {
    const version = model.schema.slice("hoc.ai.v0_9.doctrine_draft.".length) as DoctrineDraftModelVersion;
    const lastDecisionLevel = version === "v1" ? 2 : 3;
    if (!input.alternative || input.overrideUsed || input.level > lastDecisionLevel)
        return { choice: input.preferred.id, consumeOverride: false };
    const features = doctrineDraftFeatures(
        doctrine,
        input.context,
        input.preferred,
        input.alternative,
        input.level,
        input.maskAdvanceInformation ?? false,
        version,
    );
    if (!features) return { choice: input.preferred.id, consumeOverride: false };
    if (!Number.isFinite(model.switchMargin)) throw new Error("Invalid doctrine draft switch margin");
    const consumeOverride = predictDoctrineDraftGain(model, features) > model.switchMargin;
    return { choice: consumeOverride ? input.alternative.id : input.preferred.id, consumeOverride, features };
}

const defaultModel = savedModel as IDoctrineDraftModel;
predictDoctrineDraftGain(defaultModel, new Array<number>(defaultModel.features.length).fill(0));
Object.freeze(defaultModel.features);
Object.freeze(defaultModel.weights);
Object.freeze(defaultModel.scales);
Object.freeze(defaultModel);

/** The user's locked v0.9 draft default; its historical model and evidence are never rewritten. */
export function selectV09DoctrineDraftChoice(
    doctrine: number,
    input: IDoctrineDraftDecisionInput,
): IDoctrineDraftDecision {
    const policy =
        doctrine === Doctrine.SEE_ALL ? "see-all" : doctrine === Doctrine.THREE_REVEALS ? "three-reveals" : "see-none";
    return selectDoctrineDraftChoice(defaultModel, policy, input);
}
