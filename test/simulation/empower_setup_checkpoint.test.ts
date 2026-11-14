import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import checkpoint from "../../src/simulation/checkpoints/empower_setup_20261114/checkpoint.json";
import {
    LOCKED_EMPOWER_SETUP_MODEL_SHA256,
    LOCKED_EMPOWER_SETUP_REGISTRATION_SHA256,
    lockedEmpowerSetupResearchModel,
} from "../../src/simulation/empower_setup_checkpoint";

test("the frozen Empower fit is valid and callers cannot mutate its retained weights", () => {
    const first = lockedEmpowerSetupResearchModel();
    expect(first.margin).toBe(0.01);
    expect(first.heads).toHaveLength(3);
    first.heads[0].b = 999;
    expect(lockedEmpowerSetupResearchModel().heads[0].b).not.toBe(999);
});

test("Empower source helpers preserve the measured research candidate and its registration", () => {
    expect(checkpoint.registrationSha256).toBe(LOCKED_EMPOWER_SETUP_REGISTRATION_SHA256);
    expect(checkpoint.modelSha256).toBe(LOCKED_EMPOWER_SETUP_MODEL_SHA256);
    expect(checkpoint.productionActivation).toBe(false);
    for (const [path, expected] of Object.entries(checkpoint.immutableHelpers))
        expect(
            createHash("sha256")
                .update(readFileSync(new URL(`../../${path}`, import.meta.url)))
                .digest("hex"),
        ).toBe(expected);
});
