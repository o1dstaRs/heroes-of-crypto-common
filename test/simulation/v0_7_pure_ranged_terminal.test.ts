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

import { NUMBER_OF_LAPS_FIRST_ARMAGEDDON } from "../../src/constants";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import {
    capturePureRangedTerminalState,
    pureRangedAttackOpportunitiesToArmageddon,
    pureRangedTerminalAdvantage,
    pureRangedTerminalValue,
} from "../../src/simulation/v0_7_pure_ranged_terminal";
import type { Unit } from "../../src/units/unit";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const RANGE = PBTypes.AttackVals.RANGE;

function board(lower: readonly Unit[], upper: readonly Unit[]) {
    const combat = createCombatTestContext();
    lower.forEach((unit, index) => placeUnit(combat.grid, combat.unitsHolder, unit, { x: 2 + index * 2, y: 2 }));
    upper.forEach((unit, index) => placeUnit(combat.grid, combat.unitsHolder, unit, { x: 2 + index * 2, y: 12 }));
    return combat;
}

function ranged(team: typeof LOWER | typeof UPPER, patch: Parameters<typeof createTestUnit>[0] = {}): Unit {
    return createTestUnit({
        team,
        attackType: RANGE,
        rangeShots: 4,
        damageMin: 10,
        damageMax: 10,
        maxHp: 20,
        ...patch,
    });
}

describe("v0.7 pure-ranged terminal value", () => {
    it("uses the remaining pre-Armageddon laps as a finite nonnegative horizon", () => {
        expect(pureRangedAttackOpportunitiesToArmageddon(1)).toBe(NUMBER_OF_LAPS_FIRST_ARMAGEDDON - 1);
        expect(pureRangedAttackOpportunitiesToArmageddon(NUMBER_OF_LAPS_FIRST_ARMAGEDDON - 2)).toBe(2);
        expect(pureRangedAttackOpportunitiesToArmageddon(NUMBER_OF_LAPS_FIRST_ARMAGEDDON)).toBe(0);
        expect(pureRangedAttackOpportunitiesToArmageddon(Number.POSITIVE_INFINITY)).toBe(0);
    });

    it("combines capped ammo, half-damage dry turns, and the No Melee HP barrier exactly", () => {
        const ordinary = ranged(LOWER, { rangeShots: 1, damageMax: 10, amountAlive: 2, maxHp: 30 });
        const noMelee = ranged(UPPER, {
            rangeShots: 1,
            damageMax: 10,
            amountAlive: 2,
            maxHp: 30,
            abilities: ["No Melee"],
        });

        // H=3: one 20-damage shot, then two 10-damage melee turns.
        expect(pureRangedTerminalValue(ordinary, 3)).toBe(40);
        // No Melee has no dry-turn damage and adds its 60 current cumulative HP as a barrier.
        expect(pureRangedTerminalValue(noMelee, 3)).toBe(80);
        expect(pureRangedTerminalValue(noMelee, 0)).toBe(60);
    });

    it("uses full post-ammo melee damage for Handyman's explicit penalty exemption", () => {
        const handyman = ranged(LOWER, {
            rangeShots: 1,
            damageMax: 10,
            amountAlive: 2,
            abilities: ["Handyman"],
        });

        // H=3: one 20-damage shot, then two full 20-damage Handyman melee turns.
        expect(pureRangedTerminalValue(handyman, 3)).toBe(60);
    });

    it("caps Endless Quiver's reported 99 shots, and even non-finite ammo, at H", () => {
        const endless = ranged(LOWER, { rangeShots: 1, damageMax: 7, amountAlive: 3, abilities: ["Endless Quiver"] });
        endless.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);
        expect(endless.getRangeShots()).toBe(99);
        expect(pureRangedTerminalValue(endless, 2)).toBe(42);

        const originalGetRangeShots = endless.getRangeShots.bind(endless);
        endless.getRangeShots = () => Number.POSITIVE_INFINITY;
        expect(pureRangedTerminalValue(endless, 2)).toBe(42);
        endless.getRangeShots = originalGetRangeShots;
    });

    it("requires nonempty all-RANGE original armies and is exactly zero for mage, melee-mage, aura, and mixed", () => {
        const cases = [
            {
                name: "mage",
                lower: [createTestUnit({ team: LOWER, attackType: PBTypes.AttackVals.MAGIC })],
            },
            {
                name: "melee-mage",
                lower: [createTestUnit({ team: LOWER, attackType: PBTypes.AttackVals.MELEE_MAGIC })],
            },
            {
                name: "aura",
                lower: [createTestUnit({ team: LOWER, abilities: ["Luck Aura"] })],
            },
            {
                name: "mixed",
                lower: [ranged(LOWER), createTestUnit({ team: LOWER, attackType: PBTypes.AttackVals.MELEE })],
            },
        ] as const;

        for (const testCase of cases) {
            const combat = board(testCase.lower, [ranged(UPPER)]);
            const state = capturePureRangedTerminalState(combat.unitsHolder, 1);
            expect(state.eligible, testCase.name).toBe(false);
            expect(pureRangedTerminalAdvantage(state, combat.unitsHolder, LOWER, 10), testCase.name).toBe(0);
            expect(pureRangedTerminalAdvantage(state, combat.unitsHolder, UPPER, 10), testCase.name).toBe(0);
        }
    });

    it("ignores summoned non-ranged units in eligibility and terminal accounting", () => {
        const lower = ranged(LOWER);
        const upper = ranged(UPPER);
        const summon = createTestUnit({ team: LOWER, summoned: true, attackType: PBTypes.AttackVals.MAGIC });
        const combat = board([lower, summon], [upper]);
        const state = capturePureRangedTerminalState(combat.unitsHolder, 1);

        expect(state.eligible).toBe(true);
        expect(state.originalUnits.map(({ id }) => id)).not.toContain(summon.getId());
        expect(pureRangedTerminalAdvantage(state, combat.unitsHolder, LOWER, 10)).toBe(0);
    });

    it("captures fight-ready active ability names by value for later intrinsic-card checks", () => {
        const lower = ranged(LOWER, { abilities: ["Through Shot"] });
        const upper = ranged(UPPER, { abilities: ["No Melee"] });
        const combat = board([lower], [upper]);
        const state = capturePureRangedTerminalState(combat.unitsHolder, 1);

        lower.deleteAbility("Through Shot");
        lower.grantStolenAbility("Large Caliber");
        upper.deleteAbility("No Melee");

        expect(state.originalUnits.find(({ id }) => id === lower.getId())?.activeAbilityNames).toEqual([
            "Through Shot",
        ]);
        expect(state.originalUnits.find(({ id }) => id === upper.getId())?.activeAbilityNames).toEqual(["No Melee"]);
    });

    it("normalizes by the average initial army budget and is perspective-antisymmetric and bounded", () => {
        const lower = ranged(LOWER, { rangeShots: 4, damageMax: 12 });
        const upper = ranged(UPPER, { rangeShots: 4, damageMax: 8 });
        const combat = board([lower], [upper]);
        const initialHorizon = pureRangedAttackOpportunitiesToArmageddon(1);
        const lowerInitial = pureRangedTerminalValue(lower, initialHorizon);
        const upperInitial = pureRangedTerminalValue(upper, initialHorizon);
        const state = capturePureRangedTerminalState(combat.unitsHolder, 1);

        expect(state.eligible).toBe(true);
        expect(state.initialScale).toBe((lowerInitial + upperInitial) / 2);
        const lowerAdvantage = pureRangedTerminalAdvantage(state, combat.unitsHolder, LOWER, 10);
        const upperAdvantage = pureRangedTerminalAdvantage(state, combat.unitsHolder, UPPER, 10);
        expect(lowerAdvantage).toBeGreaterThan(0);
        expect(upperAdvantage).toBe(-lowerAdvantage);
        expect(Math.abs(lowerAdvantage)).toBeLessThanOrEqual(1);

        upper.getRangeShots = () => 0;
        lower.getRangeShots = () => Number.MAX_SAFE_INTEGER;
        expect(pureRangedTerminalAdvantage(state, combat.unitsHolder, LOWER, 1)).toBeLessThanOrEqual(1);
    });
});
