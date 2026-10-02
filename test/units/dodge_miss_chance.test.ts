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
        createTestUnit({ team: PBTypes.TeamVals.LEFT, attackType: PBTypes.AttackVals.RANGE, name: "Archer" });
    const scavenger = (stackPower: number, luck: number) =>
        createTestUnit({
            team: PBTypes.TeamVals.RIGHT,
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
        const orc = createTestUnit({ team: PBTypes.TeamVals.RIGHT, attackType: PBTypes.AttackVals.MELEE, name: "Orc" });
        expect(attacker().calculateMissChance(orc, 0)).toBe(0);
    });
});

/*
 * Small Specie dodges LEVEL-4 attackers only — the 2x2 giants. The old "not small" gate also caught the
 * 2x1/1x2 rectangles, letting a Small Specie holder dodge bodies the ability was never meant to blur past.
 * Owner call (1 Oct): level 4 is the gate, and every level 4 is a 2x2, so the two readings coincide.
 */
describe("Small Specie dodges level 4 (2x2) attackers only", () => {
    const holder = () =>
        createTestUnit({
            team: PBTypes.TeamVals.RIGHT,
            attackType: PBTypes.AttackVals.MELEE,
            name: "Halfling",
            abilities: ["Small Specie"],
            stackPower: 5,
        });

    test("a level 4 attacker can be dodged (50% at full stack, no luck)", () => {
        createCombatTestContext();
        const giant = createTestUnit({
            team: PBTypes.TeamVals.LEFT,
            attackType: PBTypes.AttackVals.MELEE,
            name: "Giant",
            level: PBTypes.UnitLevelVals.FOURTH,
            size: PBTypes.UnitSizeVals.LARGE,
        });
        expect(giant.calculateMissChance(holder(), 0)).toBe(50);
    });

    test("a small level 1 attacker is never dodged", () => {
        createCombatTestContext();
        const imp = createTestUnit({
            team: PBTypes.TeamVals.LEFT,
            attackType: PBTypes.AttackVals.MELEE,
            name: "Imp",
        });
        expect(imp.calculateMissChance(holder(), 0)).toBe(0);
    });

    test("a 2x1 rectangle attacker is NOT dodged — large-ish is not a level 4 giant", () => {
        createCombatTestContext();
        const serpent = createTestUnit({
            team: PBTypes.TeamVals.LEFT,
            attackType: PBTypes.AttackVals.MELEE,
            name: "Serpent",
            footprintWidth: 2,
            footprintHeight: 1,
        });
        // Not small, so the OLD gate dodged it; the level gate must not.
        expect(serpent.isSmallSize()).toBe(false);
        expect(serpent.calculateMissChance(holder(), 0)).toBe(0);
    });

    test("a mid-level 2x2 attacker is not dodged either — the gate is the level, not the footprint", () => {
        createCombatTestContext();
        const ogre = createTestUnit({
            team: PBTypes.TeamVals.LEFT,
            attackType: PBTypes.AttackVals.MELEE,
            name: "Ogre",
            level: PBTypes.UnitLevelVals.THIRD,
            size: PBTypes.UnitSizeVals.LARGE,
        });
        expect(ogre.calculateMissChance(holder(), 0)).toBe(0);
    });
});
