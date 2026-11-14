import { createHash } from "node:crypto";
import { validateEmpowerSetupModel, type IEmpowerSetupModel } from "../ai/setup/empower_setup";
import fit from "./checkpoints/empower_setup_20261114/fit.json";

export const LOCKED_EMPOWER_SETUP_MODEL_SHA256 = "308dbc27429a16696778b4543d4130507f9246e0403b47411acd49a1b11c0c15";
export const LOCKED_EMPOWER_SETUP_REGISTRATION_SHA256 =
    "c8a266a496d392ad7d9ead559df6a4ba3a4d61eb3dbc058c96a4f51ad077902b";

/** A reproducible research fit; this loader does not activate a runtime policy. */
export function lockedEmpowerSetupResearchModel(): IEmpowerSetupModel {
    if (createHash("sha256").update(JSON.stringify(fit.model)).digest("hex") !== LOCKED_EMPOWER_SETUP_MODEL_SHA256)
        throw new Error("Locked Empower setup model changed");
    const model = structuredClone(fit.model) as IEmpowerSetupModel;
    validateEmpowerSetupModel(model);
    return model;
}
