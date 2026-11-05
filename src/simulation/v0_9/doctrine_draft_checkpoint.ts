import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import savedModel from "./checkpoints/doctrine_draft_v3_20261104/model.json";
import evidence from "./checkpoints/doctrine_draft_v3_20261104/evidence.json";
import { predictDoctrineDraftGain, type IDoctrineDraftModel } from "./doctrine_draft_model";
import { createDoctrineDraftResearchChoices, type IDoctrineDraftResearchPolicyOptions } from "./doctrine_draft_policy";
import { fingerprintV09 } from "./protocol";

export const LOCKED_DOCTRINE_DRAFT_CHECKPOINT_ID = "doctrine-draft-v3-20261104";
export const LOCKED_DOCTRINE_DRAFT_MODEL_SHA256 = "2736ce8d7917e12c5078b8cae0b51f49c2e20496b2ce181bf9995e04ef65ec7a";

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

if (import.meta.main) {
    const args = parseArgs({ options: { out: { type: "string" } } }).values;
    const model = lockedDoctrineDraftModel();
    if (args.out) writeFileSync(args.out, JSON.stringify(model) + "\n", { flag: "wx" });
    console.log(
        JSON.stringify({
            checkpoint: LOCKED_DOCTRINE_DRAFT_CHECKPOINT_ID,
            modelSha256: LOCKED_DOCTRINE_DRAFT_MODEL_SHA256,
            status: evidence.status,
            comparisons: evidence.development.comparisons,
            confirmationOpened: false,
            productionPromotion: false,
            ...(args.out ? { exportedTo: args.out } : {}),
        }),
    );
}
