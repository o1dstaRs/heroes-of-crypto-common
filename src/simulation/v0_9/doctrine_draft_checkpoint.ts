import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import savedModel from "./checkpoints/doctrine_draft_v3_20261104/model.json";
import evidence from "./checkpoints/doctrine_draft_v3_20261104/evidence.json";
import savedOverallConfirmation from "./checkpoints/doctrine_draft_v3_20261104/overall_confirmation_20261105.json";
import savedNativeQualification from "./checkpoints/doctrine_draft_v3_20261104/native_qualification_20261105.json";
import { predictDoctrineDraftGain, type IDoctrineDraftModel } from "./doctrine_draft_model";
import { createDoctrineDraftResearchChoices, type IDoctrineDraftResearchPolicyOptions } from "./doctrine_draft_policy";
import { fingerprintV09 } from "./protocol";

export const LOCKED_DOCTRINE_DRAFT_CHECKPOINT_ID = "doctrine-draft-v3-20261104";
export const LOCKED_DOCTRINE_DRAFT_MODEL_SHA256 = "2736ce8d7917e12c5078b8cae0b51f49c2e20496b2ce181bf9995e04ef65ec7a";
export const LOCKED_DOCTRINE_DRAFT_CONFIRMATION_SHA256 =
    "4f23800c0742df4785b412cfc402f5ae6a39391e8dfb58bd9ed7f42786c9f354";
export const LOCKED_DOCTRINE_DRAFT_NATIVE_QUALIFICATION_SHA256 =
    "abb44c3e8b0dc9b15bec73586495c44d1ac6557a6cc368398369a0b32b97ba22";

/** Immutable research benchmark; its original scouting-specific promotion gate did not pass. */
export function lockedDoctrineDraftModel(): IDoctrineDraftModel {
    if (
        evidence.id !== LOCKED_DOCTRINE_DRAFT_CHECKPOINT_ID ||
        evidence.modelSha256 !== LOCKED_DOCTRINE_DRAFT_MODEL_SHA256 ||
        fingerprintV09(savedModel) !== LOCKED_DOCTRINE_DRAFT_MODEL_SHA256 ||
        evidence.productionPromotion !== false
    )
        throw new Error("Locked doctrine draft checkpoint changed");
    const model = savedModel as IDoctrineDraftModel;
    predictDoctrineDraftGain(model, new Array<number>(model.features.length).fill(0));
    Object.freeze(model.features);
    Object.freeze(model.weights);
    Object.freeze(model.scales);
    return Object.freeze(model);
}

export function createLockedDoctrineDraftResearchChoices(options: IDoctrineDraftResearchPolicyOptions) {
    return createDoctrineDraftResearchChoices(lockedDoctrineDraftModel(), options);
}

/** Separate fresh overall-strength evidence; the original scouting study remains unchanged. */
export function lockedDoctrineDraftOverallConfirmation() {
    const { sha256, ...body } = savedOverallConfirmation;
    if (
        sha256 !== LOCKED_DOCTRINE_DRAFT_CONFIRMATION_SHA256 ||
        fingerprintV09(body) !== sha256 ||
        body.checkpointId !== LOCKED_DOCTRINE_DRAFT_CHECKPOINT_ID ||
        body.result.modelSha256 !== LOCKED_DOCTRINE_DRAFT_MODEL_SHA256 ||
        !body.result.passed ||
        !body.independentVerification.verified ||
        body.productionPromotion !== false
    )
        throw new Error("Locked doctrine draft overall confirmation changed");
    return structuredClone(savedOverallConfirmation);
}

/** Native-profile qualification and explicit draft activation leave the original studies immutable. */
export function lockedDoctrineDraftNativeQualification() {
    const { sha256, ...body } = savedNativeQualification;
    if (
        sha256 !== LOCKED_DOCTRINE_DRAFT_NATIVE_QUALIFICATION_SHA256 ||
        fingerprintV09(body) !== sha256 ||
        body.checkpointId !== LOCKED_DOCTRINE_DRAFT_CHECKPOINT_ID ||
        body.result.modelSha256 !== LOCKED_DOCTRINE_DRAFT_MODEL_SHA256 ||
        body.defaultDraftVersion !== "v0.9" ||
        !body.result.passed ||
        !body.independentVerification.verified ||
        body.combatArtifactPromotion !== false
    )
        throw new Error("Locked doctrine draft native qualification changed");
    return structuredClone(savedNativeQualification);
}

if (import.meta.main) {
    const args = parseArgs({ options: { out: { type: "string" } } }).values;
    const model = lockedDoctrineDraftModel();
    const confirmation = lockedDoctrineDraftOverallConfirmation();
    const native = lockedDoctrineDraftNativeQualification();
    if (args.out) writeFileSync(args.out, JSON.stringify(model) + "\n", { flag: "wx" });
    console.log(
        JSON.stringify({
            checkpoint: LOCKED_DOCTRINE_DRAFT_CHECKPOINT_ID,
            modelSha256: LOCKED_DOCTRINE_DRAFT_MODEL_SHA256,
            status: "default-v0.9-draft-qualified",
            originalStudyStatus: evidence.status,
            originalDevelopmentComparisons: evidence.development.comparisons,
            originalScoutingConfirmationOpened: false,
            overallStrengthConfirmation: confirmation.result,
            confirmationEvidenceSha256: confirmation.sha256,
            measuredProfile: confirmation.profile,
            nativeProfileQualification: {
                profile: native.result.profile,
                boards: native.result.boards,
                battlesPerCondition: native.result.battlesPerCondition,
                passed: native.result.passed,
                overall: native.result.comparisons.current.pooled,
                earlyInformation: native.result.comparisons.masked.pooled,
                evidenceSha256: native.sha256,
            },
            draftDefaultVersion: native.defaultDraftVersion,
            combatArtifactPromotion: false,
            ...(args.out ? { exportedTo: args.out } : {}),
        }),
    );
}
