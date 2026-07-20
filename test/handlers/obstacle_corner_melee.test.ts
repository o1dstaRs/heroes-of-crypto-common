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

import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getPositionForCell } from "../../src/grid/grid_math";
import { MoveHandler } from "../../src/handlers/move_handler";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const MELEE = PBTypes.AttackVals.MELEE;

// 16-grid BLOCK_CENTER: left mountain cells x∈{5,6}, right x∈{9,10}, both y∈{7,8}.
const LEFT_MOUNTAIN_CELL: XY = { x: 5, y: 7 };

const worldCenterOf = (cell: XY): XY =>
    getPositionForCell(cell, testGridSettings.getMinX(), testGridSettings.getStep(), testGridSettings.getHalfStep());

function strikeFrom(standCell: XY, targetCell: XY = LEFT_MOUNTAIN_CELL): boolean {
    const ctx = createCombatTestContext(PBTypes.GridVals.BLOCK_CENTER);
    const fp = FightStateManager.getInstance().getFightProperties();
    fp.setGridType(PBTypes.GridVals.BLOCK_CENTER);

    const unit = createTestUnit({ team: LOWER, attackType: MELEE, name: "Knight" });
    placeUnit(ctx.grid, ctx.unitsHolder, unit, standCell);

    const hitsBefore = fp.getObstacleHitsLeft();
    const moveHandler = new MoveHandler(testGridSettings, ctx.grid, ctx.unitsHolder);
    // Stationary melee strike: attackFrom is the unit's own cell, no movement paths needed.
    const result = ctx.attackHandler.handleObstacleAttack(
        worldCenterOf(targetCell),
        ctx.unitsHolder,
        moveHandler,
        unit,
        standCell,
        undefined,
    );
    return result.completed !== false && fp.getObstacleHitsLeft() < hitsBefore;
}

describe("melee obstacle attack adjacency (BLOCK_CENTER mountains)", () => {
    it("lands from an orthogonally adjacent cell (control)", () => {
        expect(strikeFrom({ x: 4, y: 7 })).toBe(true);
    });

    it("lands from the four diagonal corner cells of the left mountain", () => {
        // Corners diagonal to the left mountain's cells (5..6, 7..8).
        expect(strikeFrom({ x: 4, y: 6 })).toBe(true); // below-left corner
        expect(strikeFrom({ x: 4, y: 9 })).toBe(true); // above-left corner
        expect(strikeFrom({ x: 7, y: 6 }, { x: 6, y: 7 })).toBe(true); // below-right corner
        expect(strikeFrom({ x: 7, y: 9 }, { x: 6, y: 8 })).toBe(true); // above-right corner
    });
});
