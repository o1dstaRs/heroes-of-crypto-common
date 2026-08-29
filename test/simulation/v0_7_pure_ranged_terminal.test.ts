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

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;
const RANGE = PBTypes.AttackVals.RANGE;

function board(left: readonly Unit[], right: readonly Unit[]) {
    const combat = createCombatTestContext();
    left.forEach((unit, index) => placeUnit(combat.grid, combat.unitsHolder, unit, { x: 2 + index * 2, y: 2 }));
    right.forEach((unit, index) => placeUnit(combat.grid, combat.unitsHolder, unit, { x: 2 + index * 2, y: 12 }));
    return combat;
}

function ranged(team: typeof LEFT | typeof RIGHT, patch: Parameters<typeof createTestUnit>[0] = {}): Unit {
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
        const ordinary = ranged(LEFT, { rangeShots: 1, damageMax: 10, amountAlive: 2, maxHp: 30 });
        const noMelee = ranged(RIGHT, {
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
        const handyman = ranged(LEFT, {
            rangeShots: 1,
            damageMax: 10,
            amountAlive: 2,
            abilities: ["Handyman"],
        });

        // H=3: one 20-damage shot, then two full 20-damage Handyman melee turns.
        expect(pureRangedTerminalValue(handyman, 3)).toBe(60);
    });

    it("caps Endless Quiver's reported 99 shots, and even non-finite ammo, at H", () => {
        const endless = ranged(LEFT, { rangeShots: 1, damageMax: 7, amountAlive: 3, abilities: ["Endless Quiver"] });
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
                left: [createTestUnit({ team: LEFT, attackType: PBTypes.AttackVals.MAGIC })],
            },
            {
                name: "melee-mage",
                left: [createTestUnit({ team: LEFT, attackType: PBTypes.AttackVals.MELEE_MAGIC })],
            },
            {
                name: "aura",
                left: [createTestUnit({ team: LEFT, abilities: ["Luck Aura"] })],
            },
            {
                name: "mixed",
                left: [ranged(LEFT), createTestUnit({ team: LEFT, attackType: PBTypes.AttackVals.MELEE })],
            },
        ] as const;

        for (const testCase of cases) {
            const combat = board(testCase.left, [ranged(RIGHT)]);
            const state = capturePureRangedTerminalState(combat.unitsHolder, 1);
            expect(state.eligible, testCase.name).toBe(false);
            expect(pureRangedTerminalAdvantage(state, combat.unitsHolder, LEFT, 10), testCase.name).toBe(0);
            expect(pureRangedTerminalAdvantage(state, combat.unitsHolder, RIGHT, 10), testCase.name).toBe(0);
        }
    });

    it("ignores summoned non-ranged units in eligibility and terminal accounting", () => {
        const left = ranged(LEFT);
        const right = ranged(RIGHT);
        const summon = createTestUnit({ team: LEFT, summoned: true, attackType: PBTypes.AttackVals.MAGIC });
        const combat = board([left, summon], [right]);
        const state = capturePureRangedTerminalState(combat.unitsHolder, 1);

        expect(state.eligible).toBe(true);
        expect(state.originalUnits.map(({ id }) => id)).not.toContain(summon.getId());
        expect(pureRangedTerminalAdvantage(state, combat.unitsHolder, LEFT, 10)).toBe(0);
    });

    it("captures fight-ready active ability names by value for later intrinsic-card checks", () => {
        const left = ranged(LEFT, { abilities: ["Through Shot"] });
        const right = ranged(RIGHT, { abilities: ["No Melee"] });
        const combat = board([left], [right]);
        const state = capturePureRangedTerminalState(combat.unitsHolder, 1);

        left.deleteAbility("Through Shot");
        left.grantStolenAbility("Large Caliber");
        right.deleteAbility("No Melee");

        expect(state.originalUnits.find(({ id }) => id === left.getId())?.activeAbilityNames).toEqual(["Through Shot"]);
        expect(state.originalUnits.find(({ id }) => id === right.getId())?.activeAbilityNames).toEqual(["No Melee"]);
    });

    it("normalizes by the average initial army budget and is perspective-antisymmetric and bounded", () => {
        const left = ranged(LEFT, { rangeShots: 4, damageMax: 12 });
        const right = ranged(RIGHT, { rangeShots: 4, damageMax: 8 });
        const combat = board([left], [right]);
        const initialHorizon = pureRangedAttackOpportunitiesToArmageddon(1);
        const leftInitial = pureRangedTerminalValue(left, initialHorizon);
        const rightInitial = pureRangedTerminalValue(right, initialHorizon);
        const state = capturePureRangedTerminalState(combat.unitsHolder, 1);

        expect(state.eligible).toBe(true);
        expect(state.initialScale).toBe((leftInitial + rightInitial) / 2);
        const leftAdvantage = pureRangedTerminalAdvantage(state, combat.unitsHolder, LEFT, 10);
        const rightAdvantage = pureRangedTerminalAdvantage(state, combat.unitsHolder, RIGHT, 10);
        expect(leftAdvantage).toBeGreaterThan(0);
        expect(rightAdvantage).toBe(-leftAdvantage);
        expect(Math.abs(leftAdvantage)).toBeLessThanOrEqual(1);

        right.getRangeShots = () => 0;
        left.getRangeShots = () => Number.MAX_SAFE_INTEGER;
        expect(pureRangedTerminalAdvantage(state, combat.unitsHolder, LEFT, 1)).toBeLessThanOrEqual(1);
    });
});
