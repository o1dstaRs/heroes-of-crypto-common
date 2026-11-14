import { createHash } from "node:crypto";
import { validateEmpowerSetupModel, type IEmpowerSetupModel } from "../ai/setup/empower_setup";
import fit from "./checkpoints/empower_protected_axis_20261114/fit.json";

export const LOCKED_PROTECTED_AXIS_EMPOWER_MODEL_SHA256 =
    "96750442dcf7d489f13db0334b39b9ead3b4e8d16da7c039857aeb7a8dcbd721";
export const LOCKED_PROTECTED_AXIS_EMPOWER_REGISTRATION_SHA256 =
    "209d7c172fbb8cde1256cc5550d25327087060700b21865640040ed3144dd7c7";

/** Separate frozen research fit; importing it never activates a serving policy. */
export function lockedProtectedAxisEmpowerResearchModel(): IEmpowerSetupModel {
    if (
        createHash("sha256").update(JSON.stringify(fit.model)).digest("hex") !==
        LOCKED_PROTECTED_AXIS_EMPOWER_MODEL_SHA256
    )
        throw new Error("Locked protected-axis Empower model changed");
    const model = structuredClone(fit.model) as IEmpowerSetupModel;
    validateEmpowerSetupModel(model);
    if (model.heads.slice(1).some((head) => head.b !== 0 || head.w.some((value) => value !== 0)))
        throw new Error("A disabled Empower level became active");
    return model;
}
