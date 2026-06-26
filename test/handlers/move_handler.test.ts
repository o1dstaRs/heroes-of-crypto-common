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
import { getPositionForCell } from "../../src/grid/grid_math";
import type { IWeightedRoute } from "../../src/grid/path_definitions";
import { MoveHandler } from "../../src/handlers/move_handler";
import { getDistance, type XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

const cellPos = (cell: XY): XY =>
    getPositionForCell(cell, testGridSettings.getMinX(), testGridSettings.getStep(), testGridSettings.getHalfStep());

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
        expect(moveHandler.applyMoveModifiers({ x: 2, y: 2 }, unit, 0, 0, new Map([[(2 << 4) | 2, [route]]]))).toBe(
            true,
        );
    });

    it("gives +3 morale for moving closer to the enemy and -3 for moving away", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
        const unit = createTestUnit({ team: PBTypes.TeamVals.LOWER, morale: 0 });
        const enemy = createTestUnit({ team: PBTypes.TeamVals.UPPER });

        placeUnit(grid, unitsHolder, unit, { x: 4, y: 4 });
        placeUnit(grid, unitsHolder, enemy, { x: 8, y: 8 });

        // Morale changes are written to initialUnitProperties; adjustBaseStats syncs them into
        // unitProperties (as refreshStackPowerForAllUnits does each refresh after a move).
        const syncMorale = (): number => {
            unit.adjustBaseStats(true, 1, 0, 0, 0, 0, 0);
            return unit.getMorale();
        };

        // Closer: destination (5,5) is nearer the enemy (8,8) than the current cell (4,4).
        expect(moveHandler.applyRouteMoveModifiers([{ x: 4, y: 4 }, { x: 5, y: 5 }], unit, 0, 0)).toBe(true);
        expect(syncMorale()).toBe(3);

        // Farther: destination (3,3) is farther from the enemy (8,8) than the current cell (4,4).
        expect(moveHandler.applyRouteMoveModifiers([{ x: 4, y: 4 }, { x: 3, y: 3 }], unit, 0, 0)).toBe(true);
        expect(syncMorale()).toBe(0);
    });

    it("counts travelled cells without the starting cell for route modifiers", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
        const unit = createTestUnit({
            team: PBTypes.TeamVals.LOWER,
            abilities: ["Crusade"],
            attack: 10,
            armor: 10,
            stackPower: 5,
        });
        const enemy = createTestUnit({ team: PBTypes.TeamVals.UPPER });
        const crusade = unit.getAbility("Crusade");
        const attackBefore = unit.getBaseAttack();
        const armorBefore = unit.getBaseArmor();
        const expectedIncrease = crusade ? unit.calculateAbilityCount(crusade, 0) : 0;

        placeUnit(grid, unitsHolder, unit, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, enemy, { x: 8, y: 8 });

        const applied = moveHandler.applyRouteMoveModifiers(
            [
                { x: 1, y: 1 },
                { x: 2, y: 1 },
            ],
            unit,
            0,
            0,
        );
        unit.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);

        expect(applied).toBe(true);
        expect(unit.getBaseAttack()).toBeCloseTo(attackBefore + expectedIncrease);
        expect(unit.getBaseArmor()).toBeCloseTo(armorBefore + expectedIncrease);
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

describe("MoveHandler distance morale", () => {
    const syncMorale = (unit: ReturnType<typeof createTestUnit>, synergyMorale = 0): number => {
        // refreshStackPowerForAllUnits() does this after every move: it syncs the base morale that
        // increase/decreaseMorale wrote into the effective morale that getMorale()/the roll read.
        unit.adjustBaseStats(true, 1, 0, 0, 0, synergyMorale, 0);
        return unit.getMorale();
    };

    it("classifies a move toward the enemy centroid as TOWARD and grants +3", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
        const unit = createTestUnit({ team: PBTypes.TeamVals.LOWER, morale: 0 });
        const enemy = createTestUnit({ team: PBTypes.TeamVals.UPPER });
        placeUnit(grid, unitsHolder, unit, { x: 4, y: 4 });
        placeUnit(grid, unitsHolder, enemy, { x: 8, y: 8 });

        expect(moveHandler.applyDistanceMoraleModifier(unit, cellPos({ x: 4, y: 4 }), cellPos({ x: 5, y: 5 }), 0)).toBe(
            "TOWARD",
        );
        expect(syncMorale(unit)).toBe(3);
    });

    it("classifies a move away from the enemy centroid as AWAY and applies -3", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
        const unit = createTestUnit({ team: PBTypes.TeamVals.LOWER, morale: 0 });
        const enemy = createTestUnit({ team: PBTypes.TeamVals.UPPER });
        placeUnit(grid, unitsHolder, unit, { x: 4, y: 4 });
        placeUnit(grid, unitsHolder, enemy, { x: 8, y: 8 });

        expect(moveHandler.applyDistanceMoraleModifier(unit, cellPos({ x: 4, y: 4 }), cellPos({ x: 3, y: 3 }), 0)).toBe(
            "AWAY",
        );
        expect(syncMorale(unit)).toBe(-3);
    });

    it("classifies an equidistant move as SAME and changes nothing", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
        const unit = createTestUnit({ team: PBTypes.TeamVals.LOWER, morale: 0 });
        const enemy = createTestUnit({ team: PBTypes.TeamVals.UPPER });
        placeUnit(grid, unitsHolder, unit, { x: 5, y: 5 });
        placeUnit(grid, unitsHolder, enemy, { x: 5, y: 9 });

        // Two positions exactly the same distance from the lone enemy (symmetric across its column).
        const enemyPos = enemy.getPosition();
        const from = { x: enemyPos.x - 100, y: enemyPos.y + 300 };
        const to = { x: enemyPos.x + 100, y: enemyPos.y + 300 };
        expect(getDistance(from, enemyPos)).toBeCloseTo(getDistance(to, enemyPos));
        expect(moveHandler.applyDistanceMoraleModifier(unit, from, to, 0)).toBe("SAME");
        expect(syncMorale(unit)).toBe(0);
    });

    it("is not fooled by a lone flanker: advancing into the enemy army still grants +3", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
        const unit = createTestUnit({ team: PBTypes.TeamVals.LOWER, morale: 0 });
        const flanker = createTestUnit({ team: PBTypes.TeamVals.UPPER, name: "Flanker" });
        const army1 = createTestUnit({ team: PBTypes.TeamVals.UPPER, name: "Army1" });
        const army2 = createTestUnit({ team: PBTypes.TeamVals.UPPER, name: "Army2" });
        placeUnit(grid, unitsHolder, unit, { x: 5, y: 5 });
        placeUnit(grid, unitsHolder, flanker, { x: 5, y: 4 }); // right behind the unit
        placeUnit(grid, unitsHolder, army1, { x: 4, y: 9 }); // the bulk of the army, ahead
        placeUnit(grid, unitsHolder, army2, { x: 6, y: 9 });

        const from = cellPos({ x: 5, y: 5 });
        const to = cellPos({ x: 5, y: 7 });

        // The OLD closest-enemy metric would have PENALISED this advance — the nearest enemy (the
        // flanker behind) gets farther — which is exactly the bug this change fixes.
        expect(unitsHolder.getDistanceToClosestEnemy(PBTypes.TeamVals.UPPER, to)).toBeGreaterThan(
            unitsHolder.getDistanceToClosestEnemy(PBTypes.TeamVals.UPPER, from),
        );
        // The centroid metric correctly reads it as advancing into the army.
        expect(moveHandler.applyDistanceMoraleModifier(unit, from, to, 0)).toBe("TOWARD");
        expect(syncMorale(unit)).toBe(3);
    });

    it("applies distance morale to large (footprint-move) units too", () => {
        // action_engine's footprint-only large-unit path calls applyDistanceMoraleModifier directly;
        // before the fix those moves got no morale at all.
        const { grid, unitsHolder } = createCombatTestContext();
        const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
        const large = createTestUnit({ team: PBTypes.TeamVals.LOWER, morale: 0, size: PBTypes.UnitSizeVals.LARGE });
        const enemy = createTestUnit({ team: PBTypes.TeamVals.UPPER });
        placeUnit(grid, unitsHolder, large, { x: 3, y: 3 });
        placeUnit(grid, unitsHolder, enemy, { x: 9, y: 9 });

        expect(large.isSmallSize()).toBe(false);
        expect(
            moveHandler.applyDistanceMoraleModifier(large, cellPos({ x: 3, y: 3 }), cellPos({ x: 5, y: 5 }), 0),
        ).toBe("TOWARD");
        expect(syncMorale(large)).toBe(3);
    });

    it("does nothing when there are no enemies", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
        const unit = createTestUnit({ team: PBTypes.TeamVals.LOWER, morale: 0 });
        placeUnit(grid, unitsHolder, unit, { x: 4, y: 4 });

        expect(moveHandler.applyDistanceMoraleModifier(unit, cellPos({ x: 4, y: 4 }), cellPos({ x: 5, y: 5 }), 0)).toBe(
            "SAME",
        );
        expect(syncMorale(unit)).toBe(0);
    });

    it("clamps morale at +/-20", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
        const enemy = createTestUnit({ team: PBTypes.TeamVals.UPPER });
        placeUnit(grid, unitsHolder, enemy, { x: 8, y: 8 });

        const hot = createTestUnit({ team: PBTypes.TeamVals.LOWER, morale: 19 });
        placeUnit(grid, unitsHolder, hot, { x: 4, y: 4 });
        moveHandler.applyDistanceMoraleModifier(hot, cellPos({ x: 4, y: 4 }), cellPos({ x: 5, y: 5 }), 0);
        expect(syncMorale(hot)).toBe(20);

        const cold = createTestUnit({ team: PBTypes.TeamVals.LOWER, morale: -19 });
        placeUnit(grid, unitsHolder, cold, { x: 4, y: 4 });
        moveHandler.applyDistanceMoraleModifier(cold, cellPos({ x: 4, y: 4 }), cellPos({ x: 3, y: 3 }), 0);
        expect(syncMorale(cold)).toBe(-20);
    });

    it("keeps the full +3 even when the team has a morale synergy bonus", () => {
        // Regression for the earlier synergy bug: moving toward the enemy with a +morale synergy must
        // still net +3 on top of the synergy, not (3 - synergy).
        const { grid, unitsHolder } = createCombatTestContext();
        const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
        const unit = createTestUnit({ team: PBTypes.TeamVals.LOWER, morale: 0 });
        const enemy = createTestUnit({ team: PBTypes.TeamVals.UPPER });
        placeUnit(grid, unitsHolder, unit, { x: 4, y: 4 });
        placeUnit(grid, unitsHolder, enemy, { x: 8, y: 8 });

        const synergyMorale = 2;
        moveHandler.applyDistanceMoraleModifier(unit, cellPos({ x: 4, y: 4 }), cellPos({ x: 5, y: 5 }), synergyMorale);
        // effective morale = base (now +3) + synergy (2) = 5.
        expect(syncMorale(unit, synergyMorale)).toBe(5);
    });

    it("applyRouteMoveModifiers honours an explicit destination override", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
        const unit = createTestUnit({ team: PBTypes.TeamVals.LOWER, morale: 0 });
        const enemy = createTestUnit({ team: PBTypes.TeamVals.UPPER });
        placeUnit(grid, unitsHolder, unit, { x: 4, y: 4 });
        placeUnit(grid, unitsHolder, enemy, { x: 8, y: 8 });

        // The route's last cell (3,3) is AWAY, but the explicit toPosition (5,5) is TOWARD — the
        // override (used by the footprint path) must win for the morale calc.
        const applied = moveHandler.applyRouteMoveModifiers(
            [
                { x: 4, y: 4 },
                { x: 3, y: 3 },
            ],
            unit,
            0,
            0,
            false,
            false,
            cellPos({ x: 4, y: 4 }),
            cellPos({ x: 5, y: 5 }),
        );
        expect(applied).toBe(true);
        expect(syncMorale(unit)).toBe(3);
    });
});
