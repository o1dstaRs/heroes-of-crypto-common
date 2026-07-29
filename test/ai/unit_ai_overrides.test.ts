/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import { aiVersionForUnit } from "../../src/ai/unit_ai_overrides";

describe("per-unit AI overrides", () => {
    it("pins every active AI-Driven carrier to v0.1 regardless of its team strategy", () => {
        for (const creature of ["Berserker", "Frenzied Boar"]) {
            const unit = {
                hasAbilityActive: (abilityName: string): boolean => abilityName === "AI Driven",
            };

            expect(aiVersionForUnit(unit, "v0.8"), creature).toBe("v0.1");
            expect(aiVersionForUnit(unit, "a13"), creature).toBe("v0.1");
        }
    });

    it("returns control to the team strategy when AI Driven is stolen or disabled by Break", () => {
        for (const inactiveState of ["stolen", "broken"]) {
            const unit = {
                hasAbilityActive: (): boolean => false,
            };

            expect(aiVersionForUnit(unit, "v0.8"), inactiveState).toBe("v0.8");
        }
    });
});
