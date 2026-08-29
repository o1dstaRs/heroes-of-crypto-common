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

import { NUMBER_OF_LAPS_FIRST_ARMAGEDDON, NUMBER_OF_LAPS_TILL_NARROWING_NORMAL } from "../../src/constants";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import {
    captureFinishPressureState,
    finishPressureForSide,
    finishPressureProximity,
} from "../../src/simulation/v0_7_finish_pressure";
import { V07_ARCHETYPE_TAXONOMY, V07_ARCHETYPE_TEMPLATES } from "../../src/simulation/v0_7_archetype_battery";
import type { Unit } from "../../src/units/unit";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;
const RANGE = PBTypes.AttackVals.RANGE;

function damage(unit: Unit, hp: number): void {
    unit.applyDamage(hp, 0, new SceneLogMock());
}

describe("v0.7 finish pressure", () => {
    it("is composition-ineligible for every non-ranged target cohort", () => {
        const rangedNames = new Set(V07_ARCHETYPE_TAXONOMY.ranged);
        const eligibility = Object.fromEntries(
            V07_ARCHETYPE_TEMPLATES.map((template) => [
                template.name,
                template.roster.some(({ creatureName }) => rangedNames.has(creatureName)),
            ]),
        );

        expect(eligibility).toEqual({
            mage_frontline: false,
            mage_fireline: true,
            melee_magic_utility: false,
            melee_magic_brawler: false,
            aura_support: false,
            aura_offense: false,
            ranged_precision: true,
            ranged_control: true,
        });
    });

    it("is zero on a melee board and on ranged boards through lap 3", () => {
        const melee = createCombatTestContext();
        const meleeLeft = createTestUnit({ team: LEFT, maxHp: 100 });
        const meleeRight = createTestUnit({ team: RIGHT, maxHp: 100 });
        placeUnit(melee.grid, melee.unitsHolder, meleeLeft, { x: 3, y: 3 });
        placeUnit(melee.grid, melee.unitsHolder, meleeRight, { x: 3, y: 10 });
        const meleeState = captureFinishPressureState(melee.unitsHolder);
        damage(meleeRight, 50);

        expect(meleeState.initialBoardRangedness).toBe(0);
        expect(finishPressureForSide(meleeState, melee.unitsHolder, LEFT, NUMBER_OF_LAPS_FIRST_ARMAGEDDON)).toBe(0);

        const ranged = createCombatTestContext();
        const rangedLeft = createTestUnit({ team: LEFT, attackType: RANGE, maxHp: 100 });
        const rangedRight = createTestUnit({ team: RIGHT, attackType: RANGE, maxHp: 100 });
        placeUnit(ranged.grid, ranged.unitsHolder, rangedLeft, { x: 3, y: 3 });
        placeUnit(ranged.grid, ranged.unitsHolder, rangedRight, { x: 3, y: 10 });
        const rangedState = captureFinishPressureState(ranged.unitsHolder);
        damage(rangedRight, 50);

        expect(finishPressureProximity(NUMBER_OF_LAPS_TILL_NARROWING_NORMAL)).toBe(0);
        expect(finishPressureForSide(rangedState, ranged.unitsHolder, LEFT, NUMBER_OF_LAPS_TILL_NARROWING_NORMAL)).toBe(
            0,
        );
    });

    it("is positive, linear, and bounded late on a damaged ranged board", () => {
        const combat = createCombatTestContext();
        const left = createTestUnit({ team: LEFT, maxHp: 100 });
        const right = createTestUnit({ team: RIGHT, attackType: RANGE, maxHp: 100 });
        placeUnit(combat.grid, combat.unitsHolder, left, { x: 3, y: 3 });
        placeUnit(combat.grid, combat.unitsHolder, right, { x: 3, y: 10 });
        const state = captureFinishPressureState(combat.unitsHolder);
        damage(right, 50);

        const midpointLap = (NUMBER_OF_LAPS_TILL_NARROWING_NORMAL + NUMBER_OF_LAPS_FIRST_ARMAGEDDON) / 2;
        const midpoint = finishPressureForSide(state, combat.unitsHolder, LEFT, midpointLap);
        const armageddon = finishPressureForSide(state, combat.unitsHolder, LEFT, NUMBER_OF_LAPS_FIRST_ARMAGEDDON);

        expect(state.initialBoardRangedness).toBe(0.5);
        expect(midpoint).toBeCloseTo(0.125, 12);
        expect(armageddon).toBeCloseTo(0.25, 12);
        expect(armageddon).toBeGreaterThan(0);
        expect(armageddon).toBeLessThanOrEqual(1);
        expect(finishPressureProximity(Number.POSITIVE_INFINITY)).toBe(1);
    });

    it("ignores units summoned after the initial state was captured", () => {
        const combat = createCombatTestContext();
        const left = createTestUnit({ team: LEFT, attackType: RANGE, maxHp: 100 });
        const right = createTestUnit({ team: RIGHT, maxHp: 100 });
        placeUnit(combat.grid, combat.unitsHolder, left, { x: 3, y: 3 });
        placeUnit(combat.grid, combat.unitsHolder, right, { x: 3, y: 10 });
        const state = captureFinishPressureState(combat.unitsHolder);
        damage(right, 50);
        const beforeSummon = finishPressureForSide(state, combat.unitsHolder, LEFT, NUMBER_OF_LAPS_FIRST_ARMAGEDDON);

        const summoned = createTestUnit({
            team: RIGHT,
            attackType: RANGE,
            maxHp: 1_000,
            amountAlive: 10,
            summoned: true,
        });
        placeUnit(combat.grid, combat.unitsHolder, summoned, { x: 5, y: 10 });

        expect(state.originalUnits.map((unit) => unit.id)).not.toContain(summoned.getId());
        expect(finishPressureForSide(state, combat.unitsHolder, LEFT, NUMBER_OF_LAPS_FIRST_ARMAGEDDON)).toBeCloseTo(
            beforeSummon,
            12,
        );
    });

    it("excludes summoned stacks already present when the initial state is captured", () => {
        const combat = createCombatTestContext();
        const left = createTestUnit({ team: LEFT, maxHp: 100 });
        const right = createTestUnit({ team: RIGHT, maxHp: 100 });
        const summoned = createTestUnit({
            team: LEFT,
            attackType: RANGE,
            maxHp: 1_000,
            amountAlive: 10,
            summoned: true,
        });
        placeUnit(combat.grid, combat.unitsHolder, left, { x: 3, y: 3 });
        placeUnit(combat.grid, combat.unitsHolder, right, { x: 3, y: 10 });
        placeUnit(combat.grid, combat.unitsHolder, summoned, { x: 5, y: 3 });

        const state = captureFinishPressureState(combat.unitsHolder);

        expect(state.originalUnits.map((unit) => unit.id)).not.toContain(summoned.getId());
        expect(state.initialBoardRangedness).toBe(0);
    });

    it("counts dead and missing original units as zero remaining HP", () => {
        const combat = createCombatTestContext();
        const left = createTestUnit({ team: LEFT, attackType: RANGE, maxHp: 200 });
        const deadRight = createTestUnit({ team: RIGHT, maxHp: 100 });
        const missingRight = createTestUnit({ team: RIGHT, maxHp: 100 });
        placeUnit(combat.grid, combat.unitsHolder, left, { x: 3, y: 3 });
        placeUnit(combat.grid, combat.unitsHolder, deadRight, { x: 3, y: 10 });
        placeUnit(combat.grid, combat.unitsHolder, missingRight, { x: 5, y: 10 });
        const state = captureFinishPressureState(combat.unitsHolder);

        damage(deadRight, deadRight.getCumulativeHp());
        combat.unitsHolder.deleteUnitById(missingRight.getId());

        expect(deadRight.isDead()).toBe(true);
        expect(finishPressureForSide(state, combat.unitsHolder, LEFT, NUMBER_OF_LAPS_FIRST_ARMAGEDDON)).toBeCloseTo(
            0.5,
            12,
        );
    });

    it("is symmetric when the two sides are swapped", () => {
        const first = createCombatTestContext();
        const firstLeft = createTestUnit({ team: LEFT, attackType: RANGE, maxHp: 120 });
        const firstRight = createTestUnit({ team: RIGHT, maxHp: 80 });
        placeUnit(first.grid, first.unitsHolder, firstLeft, { x: 3, y: 3 });
        placeUnit(first.grid, first.unitsHolder, firstRight, { x: 3, y: 10 });
        const firstState = captureFinishPressureState(first.unitsHolder);
        damage(firstRight, 20);

        const swapped = createCombatTestContext();
        const swappedRight = createTestUnit({ team: RIGHT, attackType: RANGE, maxHp: 120 });
        const swappedLeft = createTestUnit({ team: LEFT, maxHp: 80 });
        placeUnit(swapped.grid, swapped.unitsHolder, swappedLeft, { x: 3, y: 3 });
        placeUnit(swapped.grid, swapped.unitsHolder, swappedRight, { x: 3, y: 10 });
        const swappedState = captureFinishPressureState(swapped.unitsHolder);
        damage(swappedLeft, 20);

        expect(finishPressureForSide(firstState, first.unitsHolder, LEFT, 9)).toBeCloseTo(
            finishPressureForSide(swappedState, swapped.unitsHolder, RIGHT, 9),
            12,
        );
    });
});
