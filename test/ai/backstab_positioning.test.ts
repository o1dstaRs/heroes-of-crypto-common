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

import { AIActionType, findTarget } from "../../src/ai/ai";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const MELEE = PBTypes.AttackVals.MELEE;

const pathHelper = new PathHelper(testGridSettings);

describe("Backstab (Scavenger) AI positioning", () => {
    it("reroutes a LOWER-team Scavenger to strike from below the target (higher y)", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        // Scavenger is adjacent to the enemy on the NON-backstab side (above it, lower y). For a LOWER
        // attacker the bonus needs y > target.y, so it should circle to a cell below the enemy.
        const scavenger = createTestUnit({
            name: "Scavenger",
            team: LOWER,
            attackType: MELEE,
            abilities: ["Backstab"],
        });
        const enemy = createTestUnit({ name: "Prey", team: UPPER, attackType: MELEE });
        placeUnit(grid, unitsHolder, scavenger, { x: 6, y: 4 });
        placeUnit(grid, unitsHolder, enemy, { x: 5, y: 5 });

        const action = findTarget(scavenger, grid, grid.getMatrix(), unitsHolder, pathHelper);
        expect(action).toBeDefined();
        expect(action?.actionType()).toBe(AIActionType.MOVE_AND_MELEE_ATTACK);
        expect(action?.cellToAttack()).toEqual({ x: 5, y: 5 });
        // Stand cell is on the backstab side: below the target (y > 5).
        expect(action!.cellToMove()!.y).toBeGreaterThan(5);
    });

    it("reroutes an UPPER-team Scavenger to strike from above the target (lower y)", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const scavenger = createTestUnit({
            name: "Scavenger",
            team: UPPER,
            attackType: MELEE,
            abilities: ["Backstab"],
        });
        const enemy = createTestUnit({ name: "Prey", team: LOWER, attackType: MELEE });
        // Adjacent on the non-backstab side (below the enemy). UPPER needs y < target.y → circle above.
        placeUnit(grid, unitsHolder, scavenger, { x: 6, y: 6 });
        placeUnit(grid, unitsHolder, enemy, { x: 5, y: 5 });

        const action = findTarget(scavenger, grid, grid.getMatrix(), unitsHolder, pathHelper);
        expect(action?.actionType()).toBe(AIActionType.MOVE_AND_MELEE_ATTACK);
        expect(action!.cellToMove()!.y).toBeLessThan(5);
    });

    it("does not reroute a unit without Backstab", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const plain = createTestUnit({ name: "Grunt", team: LOWER, attackType: MELEE });
        const enemy = createTestUnit({ name: "Prey", team: UPPER, attackType: MELEE });
        placeUnit(grid, unitsHolder, plain, { x: 6, y: 4 });
        placeUnit(grid, unitsHolder, enemy, { x: 5, y: 5 });

        const action = findTarget(plain, grid, grid.getMatrix(), unitsHolder, pathHelper);
        // Already adjacent → it just melees in place from its current (non-backstab) cell.
        expect(action?.actionType()).toBe(AIActionType.MELEE_ATTACK);
        expect(action?.cellToMove()).toEqual({ x: 6, y: 4 });
    });

    it("keeps striking in place when already on the backstab side", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const scavenger = createTestUnit({
            name: "Scavenger",
            team: LOWER,
            attackType: MELEE,
            abilities: ["Backstab"],
        });
        const enemy = createTestUnit({ name: "Prey", team: UPPER, attackType: MELEE });
        // Already below the enemy (y=6 > 5) → backstab already satisfied, no repositioning.
        placeUnit(grid, unitsHolder, scavenger, { x: 5, y: 6 });
        placeUnit(grid, unitsHolder, enemy, { x: 5, y: 5 });

        const action = findTarget(scavenger, grid, grid.getMatrix(), unitsHolder, pathHelper);
        expect(action?.actionType()).toBe(AIActionType.MELEE_ATTACK);
        expect(action?.cellToMove()).toEqual({ x: 5, y: 6 });
    });
});
