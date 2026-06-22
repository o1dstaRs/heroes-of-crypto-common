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

import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { UPDATE_DOWN, UPDATE_LEFT, UPDATE_RIGHT, UPDATE_UP } from "../../src/grid/grid_constants";
import type { IWeightedRoute } from "../../src/grid/path_definitions";
import { MoveHandler } from "../../src/handlers/move_handler";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

describe("MoveHandler", () => {
    it("returns empty results for empty cells and stale grid occupants", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);

        expect(moveHandler.gridSettings).toBe(testGridSettings);
        expect(moveHandler.moveUnitTowardsCenter({ x: 1, y: 1 }, UPDATE_UP, 0)).toEqual({
            log: "",
            unitIdsDestroyed: [],
            unitIdToNewPosition: new Map(),
        });

        grid.occupyCell({ x: 1, y: 1 }, "missing", PBTypes.TeamVals.LOWER, 1, false, false);

        expect(moveHandler.moveUnitTowardsCenter({ x: 1, y: 1 }, UPDATE_UP, 0)).toEqual({
            log: "",
            unitIdsDestroyed: [],
            unitIdToNewPosition: new Map(),
        });
    });

    it("moves units directly toward the center when the target cell is empty", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
        const unit = createTestUnit({ team: PBTypes.TeamVals.LOWER });

        placeUnit(grid, unitsHolder, unit, { x: 1, y: 1 });

        const result = moveHandler.moveUnitTowardsCenter({ x: 1, y: 1 }, UPDATE_UP, 0);

        expect(result.log).toBe("");
        expect(result.unitIdsDestroyed).toEqual([]);
        expect(result.unitIdToNewPosition.get(unit.getId())).toEqual(unit.getPosition());
        expect(unit.getBaseCell()).toEqual({ x: 1, y: 2 });
    });

    it("shifts blocked system moves sideways before giving up", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
        const unit = createTestUnit({ team: PBTypes.TeamVals.LOWER });
        const blocker = createTestUnit({ team: PBTypes.TeamVals.UPPER });

        placeUnit(grid, unitsHolder, unit, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, blocker, { x: 1, y: 2 });

        const result = moveHandler.moveUnitTowardsCenter({ x: 1, y: 1 }, UPDATE_UP, 0);

        expect(result.unitIdsDestroyed).toEqual([]);
        expect(result.unitIdToNewPosition.get(unit.getId())).toEqual(unit.getPosition());
        expect(unit.getBaseCell()).toEqual({ x: 2, y: 2 });
    });

    it("applies route move modifiers only when a known path exists", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
        const unit = createTestUnit({ team: PBTypes.TeamVals.LOWER });
        const enemy = createTestUnit({ team: PBTypes.TeamVals.UPPER });
        const route: IWeightedRoute = {
            cell: { x: 2, y: 2 },
            route: [
                { x: 1, y: 1 },
                { x: 2, y: 2 },
            ],
            weight: 1,
            firstAggrMet: false,
            hasLavaCell: false,
            hasWaterCell: false,
        };

        placeUnit(grid, unitsHolder, unit, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, enemy, { x: 8, y: 8 });

        expect(moveHandler.applyMoveModifiers({ x: 2, y: 2 }, unit, 0, 0)).toBe(false);
        expect(moveHandler.applyMoveModifiers({ x: 3, y: 3 }, unit, 0, 0, new Map())).toBe(false);
        expect(
            moveHandler.applyMoveModifiers(
                { x: 2, y: 2 },
                unit,
                0,
                0,
                new Map([[(2 << 4) | 2, [route]]]),
            ),
        ).toBe(true);
    });

    it("finishes directed moves with explicit positions and update masks", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
        const up = createTestUnit({ team: PBTypes.TeamVals.LOWER });
        const down = createTestUnit({ team: PBTypes.TeamVals.LOWER });
        const left = createTestUnit({ team: PBTypes.TeamVals.LOWER });
        const right = createTestUnit({ team: PBTypes.TeamVals.LOWER });
        const deleted = createTestUnit({ team: PBTypes.TeamVals.LOWER });

        placeUnit(grid, unitsHolder, up, { x: 2, y: 2 });
        placeUnit(grid, unitsHolder, down, { x: 4, y: 4 });
        placeUnit(grid, unitsHolder, left, { x: 6, y: 6 });
        placeUnit(grid, unitsHolder, right, { x: 8, y: 8 });
        placeUnit(grid, unitsHolder, deleted, { x: 10, y: 10 });

        expect(moveHandler.finishDirectedUnitMove(up, [], undefined, UPDATE_UP)).toEqual({
            log: "",
            deleteUnit: false,
            newPosition: undefined,
        });
        expect(moveHandler.finishDirectedUnitMove(up, [{ x: 2, y: 3 }], undefined, UPDATE_UP).newPosition).toEqual(
            up.getPosition(),
        );
        expect(moveHandler.finishDirectedUnitMove(down, [{ x: 4, y: 3 }], undefined, UPDATE_DOWN).newPosition).toEqual(
            down.getPosition(),
        );
        expect(moveHandler.finishDirectedUnitMove(left, [{ x: 5, y: 6 }], undefined, UPDATE_LEFT).newPosition).toEqual(
            left.getPosition(),
        );
        expect(
            moveHandler.finishDirectedUnitMove(right, [{ x: 9, y: 8 }], undefined, UPDATE_RIGHT).newPosition,
        ).toEqual(right.getPosition());

        const explicitPosition = { x: 12, y: 12 };
        expect(moveHandler.finishDirectedUnitMove(up, [{ x: 3, y: 3 }], explicitPosition).newPosition).toEqual(
            explicitPosition,
        );

        const deletedResult = moveHandler.finishDirectedUnitMove(deleted, [{ x: 10, y: 11 }]);

        expect(deletedResult.deleteUnit).toBe(true);
        expect(deletedResult.newPosition).toBeUndefined();
        expect(deletedResult.log).toBe(`${deleted.getId()} destroyed`);
    });
});
