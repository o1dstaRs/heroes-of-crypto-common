import savedModel from "./checkpoints/learned_ranged_setup_20261109/model.json";
import { validateLearnedRangedSetupModel, type ILearnedRangedSetupModel } from "./learned_ranged_setup_research";
import { fingerprintV09 } from "./v0_9/protocol";

export const LEARNED_RANGED_SETUP_CHECKPOINT_ID = "public-ranged-setup-effects-d786f4e9-20261109";
export const LEARNED_RANGED_SETUP_MODEL_SHA256 = "d786f4e9d90c321172021b65a81cb5b04f715aba5c203d388580007f93930007";

/** Frozen treatment-effect model; its internal development estimates do not qualify a live policy. */
export function lockedLearnedRangedSetupModel(): ILearnedRangedSetupModel {
    if (fingerprintV09(savedModel) !== LEARNED_RANGED_SETUP_MODEL_SHA256)
        throw new Error("Learned setup checkpoint changed");
    const model = savedModel as ILearnedRangedSetupModel;
    validateLearnedRangedSetupModel(model);
    Object.freeze(model.features);
    Object.freeze(model.freeWeights);
    Object.freeze(model.paidWeights);
    return Object.freeze(model);
}
