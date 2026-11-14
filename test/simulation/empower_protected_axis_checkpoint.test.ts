import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import checkpoint from "../../src/simulation/checkpoints/empower_protected_axis_20261114/checkpoint.json";
import {
    LOCKED_PROTECTED_AXIS_EMPOWER_MODEL_SHA256,
    LOCKED_PROTECTED_AXIS_EMPOWER_REGISTRATION_SHA256,
    lockedProtectedAxisEmpowerResearchModel,
} from "../../src/simulation/empower_protected_axis_checkpoint";

test("the protected-axis fit keeps immutable funding, disabled higher levels and independent registration", () => {
    expect(checkpoint.modelSha256).toBe(LOCKED_PROTECTED_AXIS_EMPOWER_MODEL_SHA256);
    expect(checkpoint.registrationSha256).toBe(LOCKED_PROTECTED_AXIS_EMPOWER_REGISTRATION_SHA256);
    expect(checkpoint.productionActivation).toBe(false);
    const model = lockedProtectedAxisEmpowerResearchModel();
    for (const head of model.heads.slice(1)) expect([head.b, ...head.w].every((value) => value === 0)).toBe(true);
    model.heads[0].b = 999;
    expect(lockedProtectedAxisEmpowerResearchModel().heads[0].b).not.toBe(999);
    for (const [path, expected] of Object.entries(checkpoint.immutableHelpers))
        expect(
            createHash("sha256")
                .update(readFileSync(new URL(`../../${path}`, import.meta.url)))
                .digest("hex"),
        ).toBe(expected);
});
