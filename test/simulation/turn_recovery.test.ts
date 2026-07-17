/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, test } from "bun:test";

import { canUnitLandAt } from "../../src/ai/ai";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { advanceTowardEnemyAction } from "../../src/simulation/turn_recovery";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

describe("turn recovery movement", () => {
    test("crosses lava without selecting an engine-illegal recovery endpoint", () => {
        const combat = createCombatTestContext(PBTypes.GridVals.LAVA_CENTER);
        const flyer = createTestUnit({
            team: PBTypes.TeamVals.LOWER,
            movementType: PBTypes.MovementVals.FLY,
            speed: 6,
        });
        const enemy = createTestUnit({ team: PBTypes.TeamVals.UPPER });
        placeUnit(combat.grid, combat.unitsHolder, flyer, { x: 5, y: 7 });
        placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 11, y: 7 });

        const action = advanceTowardEnemyAction(
            flyer,
            combat.grid,
            combat.unitsHolder,
            new PathHelper(testGridSettings),
        );

        expect(action?.type).toBe("move_unit");
        if (!action || action.type !== "move_unit") throw new Error("expected recovery move");
        expect(action.hasLavaCell).toBe(true);
        expect(action.path?.some((cell) => combat.grid.getOccupantUnitId(cell) === "L")).toBe(true);
        expect(canUnitLandAt(flyer, combat.grid, action.path![action.path!.length - 1])).toBe(true);
    });
});
