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

import { describe, expect, test } from "bun:test";

import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { createCombatTestContext, createTestUnit } from "../helpers/combat";

/*
 * Pins the Dodge (Scavenger) miss-chance design values so a scaling/regression bug can't silently
 * make ranged shots "always miss". Dodge is 20% base, stack-powered (scales with stack power /5),
 * plus defender luck (clamped ±10) plus the Might ability-power synergy (max +12) — the ceiling is
 * ~42%, never near-certain.
 */
describe("Dodge miss chance (Scavenger)", () => {
    const attacker = () =>
        createTestUnit({ team: PBTypes.TeamVals.LOWER, attackType: PBTypes.AttackVals.RANGE, name: "Archer" });
    const scavenger = (stackPower: number, luck: number) =>
        createTestUnit({
            team: PBTypes.TeamVals.UPPER,
            attackType: PBTypes.AttackVals.MELEE,
            name: "Scavenger",
            abilities: ["Dodge", "Backstab"],
            stackPower,
            luck,
        });

    test("full-power stack at neutral luck dodges ~20%, never more", () => {
        createCombatTestContext();
        const chance = attacker().calculateMissChance(scavenger(5, 0), 0);
        expect(chance).toBeGreaterThanOrEqual(15);
        expect(chance).toBeLessThanOrEqual(20);
    });

    test("worst case (max stack power + max luck + max synergy) stays under 45%", () => {
        createCombatTestContext();
        const chance = attacker().calculateMissChance(scavenger(5, 10), 12);
        expect(chance).toBeLessThanOrEqual(45);
    });

    test("weak stack with bad luck dodges (almost) never", () => {
        createCombatTestContext();
        const chance = attacker().calculateMissChance(scavenger(1, -10), 0);
        expect(chance).toBeLessThanOrEqual(5);
    });

    test("no Dodge ability -> no miss chance at all", () => {
        createCombatTestContext();
        const orc = createTestUnit({ team: PBTypes.TeamVals.UPPER, attackType: PBTypes.AttackVals.MELEE, name: "Orc" });
        expect(attacker().calculateMissChance(orc, 0)).toBe(0);
    });
});
