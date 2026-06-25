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

import { describe, it, expect } from "bun:test";

import {
    AIActionType,
    BasicAIAction,
    findTarget,
    getCellsForAttacker,
    isLineBlockedByObstacle,
    countMeleeThreatsToCell,
    analyzeEngagement,
    findSaferMoveCell,
    type ITeamEngagement,
} from "../../src/ai/ai";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { AttackType, TeamType } from "../../src/generated/protobuf/v1/types_gen";
import { Grid } from "../../src/grid/grid";
import * as HoCMath from "../../src/utils/math";
import { PathHelper } from "../../src/grid/path_helper";
import { GridSettings } from "../../src/grid/grid_settings";
import { UnitsHolder } from "../../src/units/units_holder";
import { IUnitAIRepr } from "../../src/units/unit";

import { GRID_SIZE, MAX_Y, MIN_Y, MAX_X, MIN_X, MOVEMENT_DELTA, UNIT_SIZE_DELTA } from "../../src/grid/grid_constants";

/**
 * The Unit tests for AI
 *
 * X goes from 0 on left to N on right
 * Y goes from 0 on bottom to N on top
 *
 */
const gridSettings = new GridSettings(GRID_SIZE, MAX_Y, MIN_Y, MAX_X, MIN_X, MOVEMENT_DELTA, UNIT_SIZE_DELTA);

const generateUnits = (
    grid: Grid,
    steps: number,
    isSmallUnit: boolean,
    baseCellFrom: HoCMath.XY,
    baseCellTo: HoCMath.XY,
    anotherUnitCell?: HoCMath.XY,
): UnitRepr => {
    const unitFrom = isSmallUnit
        ? stubSmallUnit(PBTypes.TeamVals.UPPER, steps, baseCellFrom)
        : stubBigUnit(PBTypes.TeamVals.UPPER, steps, baseCellFrom);
    const unitTo = stubSmallUnit(PBTypes.TeamVals.LOWER, steps, baseCellTo);
    grid.occupyCell(
        baseCellFrom,
        unitFrom.getId(),
        unitFrom.getTeam(),
        unitFrom.getAttackRange(),
        unitFrom.hasAbilityActive("Made of Fire"),
        unitFrom.hasAbilityActive("Made of Water"),
    );
    grid.occupyCell(
        baseCellTo,
        unitTo.getId(),
        unitTo.getTeam(),
        unitTo.getAttackRange(),
        unitTo.hasAbilityActive("Made of Fire"),
        unitTo.hasAbilityActive("Made of Water"),
    );
    if (anotherUnitCell) {
        const unitEnemy = stubSmallUnit(PBTypes.TeamVals.LOWER, steps /* steps */, anotherUnitCell);
        grid.occupyCell(
            anotherUnitCell,
            unitEnemy.getId(),
            unitEnemy.getTeam(),
            unitEnemy.getAttackRange(),
            unitEnemy.hasAbilityActive("Made of Fire"),
            unitEnemy.hasAbilityActive("Made of Water"),
        );
    }

    return unitFrom;
};

describe("SmallUnit", () => {
    const pathHelper = new PathHelper(gridSettings);
    (describe("Move", () => {
        (it("From right bottom diagonally", () => {
            /**
            Sample matrix
            [2, 0, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 1, 0],
            [0, 0, 0, .],
            */
            const baseCellFrom = { x: 3, y: 0 };
            const baseCellTo = { x: 0, y: 3 };
            const grid = new Grid(gridSettings, PBTypes.GridVals.NORMAL);
            const unitFrom = generateUnits(grid, 2, true, baseCellFrom, baseCellTo);
            const closestTarget = findTarget(unitFrom, grid, grid.getMatrix(), new UnitsHolder(grid), pathHelper);
            expect(closestTarget?.cellToMove()).toEqual({ x: 2, y: 1 });
            expect(closestTarget?.cellToAttack()).toBeUndefined();
            expect(closestTarget?.actionType()).toEqual(AIActionType.MOVE);
        }),
            it("From bottom", () => {
                /**
                Sample matrix
                [0, 2, 0, 0],
                [0, 0, 0, 0],
                [0, 0, 1, 0],
                [0, 0, ., 0],
                */
                const baseCellFrom = { x: 2, y: 0 };
                const baseCellTo = { x: 1, y: 3 };
                const grid = new Grid(gridSettings, PBTypes.GridVals.NORMAL);
                const unitFrom = generateUnits(grid, 1, true, baseCellFrom, baseCellTo);
                const closestTarget = findTarget(unitFrom, grid, grid.getMatrix(), new UnitsHolder(grid), pathHelper);
                expect(closestTarget?.cellToMove()).toEqual({ x: 2, y: 1 });
                expect(closestTarget?.cellToAttack()).toBeUndefined();
                expect(closestTarget?.actionType()).toEqual(AIActionType.MOVE);
            }),
            it("From right", () => {
                /**
               Sample matrix
               [0, 0, 0, 0],
               [2, 0, 0, 0],
               [0, 0, 1, .],
               [0, 0, 0, 0],
               */
                const baseCellFrom = { x: 3, y: 1 };
                const baseCellTo = { x: 0, y: 2 };
                const grid = new Grid(gridSettings, PBTypes.GridVals.NORMAL);
                const unitFrom = generateUnits(grid, 1, true, baseCellFrom, baseCellTo);
                const closestTarget = findTarget(unitFrom, grid, grid.getMatrix(), new UnitsHolder(grid), pathHelper);
                expect(closestTarget?.cellToMove()).toEqual({ x: 2, y: 1 });
                expect(closestTarget?.cellToAttack()).toBeUndefined();
                expect(closestTarget?.actionType()).toEqual(AIActionType.MOVE);
            }),
            it("Should go around if cannot fly over lava obstacle", () => {
                /**
               Sample matrix
               [0, 0, 0, 0],
               [2, 0, 0, 0],
               [0, 0, 1, 0],
               [0, 0, 0, 0],
               */
                const baseCellFrom = { x: 5, y: 5 };
                const baseCellTo = { x: 10, y: 10 };
                const grid = new Grid(gridSettings, PBTypes.GridVals.LAVA_CENTER);
                const unitFrom = generateUnits(grid, 4 /* steps */, true, baseCellFrom, baseCellTo);
                // grid.print(unitFrom.getId(), false);
                const closestTarget = findTarget(unitFrom, grid, grid.getMatrix(), new UnitsHolder(grid), pathHelper);
                expect(closestTarget?.cellToMove()).toEqual({ x: 9, y: 5 });
                expect(closestTarget?.cellToAttack()).toBeUndefined();
                expect(closestTarget?.actionType()).toEqual(AIActionType.MOVE);
            }));
    }),
        describe("MoveAndAttack", () => {
            (it("From bottom closest one", () => {
                /**
                Sample matrix:
                [0, 2, 0, 0],
                [0, 2, 0, 0],
                [0, 0, 1, 0],
                [0, 0, ., 0],
                */
                const baseCellFrom = { x: 2, y: 0 };
                const baseCellTo = { x: 1, y: 2 };
                const anotherEnemyCell = { x: 1, y: 3 };
                const grid = new Grid(gridSettings, PBTypes.GridVals.NORMAL);
                const unitFrom = generateUnits(grid, 10, true, baseCellFrom, baseCellTo, anotherEnemyCell);
                const closestTarget = findTarget(unitFrom, grid, grid.getMatrix(), new UnitsHolder(grid), pathHelper);
                expect(closestTarget?.cellToMove()).toEqual({ x: 2, y: 1 });
                // expect(closestTarget?.cellToMove()).toEqual({ x: 1, y: 1 });
                expect(closestTarget?.cellToAttack()).toEqual({ x: 1, y: 2 });
                expect(closestTarget?.actionType()).toEqual(AIActionType.MOVE_AND_MELEE_ATTACK);
            }),
                it("From bottom", () => {
                    /**
                    Sample matrix:
                    [0, 2, 0, 0],
                    [0, 0, 1, 0],
                    [0, 0, 0, 0],
                    [0, 0, ., 0],
                    */
                    const baseCellFrom = { x: 2, y: 0 };
                    const baseCellTo = { x: 1, y: 3 };
                    const grid = new Grid(gridSettings, PBTypes.GridVals.NORMAL);
                    const unitFrom = generateUnits(grid, 2, true, baseCellFrom, baseCellTo);
                    const closestTarget = findTarget(
                        unitFrom,
                        grid,
                        grid.getMatrix(),
                        new UnitsHolder(grid),
                        pathHelper,
                    );
                    expect(closestTarget?.cellToAttack()).toEqual({ x: 1, y: 3 });
                    expect(closestTarget?.cellToMove()).toEqual({ x: 2, y: 2 });
                    expect(closestTarget?.actionType()).toEqual(AIActionType.MOVE_AND_MELEE_ATTACK);
                }),
                it("From right bottom diagonally", () => {
                    /**
                    Sample matrix
                    [2, 0, 0, 0],
                    [0, 1, 0, 0],
                    [0, 0, 0, 0],
                    [0, 0, 0, .],
                    */
                    const baseCellFrom = { x: 3, y: 0 };
                    const baseCellTo = { x: 0, y: 3 };
                    const grid = new Grid(gridSettings, PBTypes.GridVals.NORMAL);
                    const unitFrom = generateUnits(grid, 3, true, baseCellFrom, baseCellTo);
                    const closestTarget = findTarget(
                        unitFrom,
                        grid,
                        grid.getMatrix(),
                        new UnitsHolder(grid),
                        pathHelper,
                    );
                    expect(closestTarget?.cellToMove()).toEqual({ x: 1, y: 2 });
                    expect(closestTarget?.cellToAttack()).toEqual({ x: 0, y: 3 });
                    expect(closestTarget?.actionType()).toEqual(AIActionType.MOVE_AND_MELEE_ATTACK);
                }));
        }));

    // todo does not work because moves straig first and then by diagonal
    //
    // it('should go close to target if cannot attack 3', () => {
    //     const matrix: number[][] = [
    //         [0, 0, 0, 0],
    //         [0, 0, 0, 1],
    //         [0, 0, 0, 0],
    //         [2, 0, 0, 0],
    //     ];
    //     /**
    //      * End matrix
    //      * const matrix: number[][] = [
    //         [0, 0, 0, 0],
    //         [0, 0, 0, 0],
    //         [0, 0, 1, 0],
    //         [2, 0, 0, 0],
    //     ];
    //      */
    //     const unit = new UnitRepr(TeamType.UPPER, 2, 1, 1, false, true, { x: 3, y: 1 },
    //         getUnitConfig(TeamType.UPPER, "Life", "Peasant", 2)
    //     );
    //     const closestTarget = findTarget(unit, new Grid(4), matrix, pathHelper);
    //     expect(closestTarget?.cellToMove()).toEqual({ x: 2, y: 2 });
    //     expect(closestTarget?.cellToAttack()).toBeUndefined();
    //     expect(closestTarget?.actionType()).toEqual(AIActionType.MOVE);
    // });

    // it("Should do range attack if possible", () => {
    //     const matrix: number[][] = [
    //         [0, 0, 1, 0],
    //         [0, 0, 0, 0],
    //         [0, 0, 0, 0],
    //         [0, 2, 0, 0],
    //     ];
    //     const unit = new UnitRepr(
    //         "id",
    //         TeamType.UPPER,
    //         2,
    //         1,
    //         1,
    //         false,
    //         true,
    //         { x: 2, y: 0 },
    //         getUnitConfig(TeamType.UPPER, "Life", "Arbalester", 2),
    //     );
    //     const closestTarget = findTarget(unit, new Grid(4), matrix, pathHelper);
    //     expect(closestTarget?.cellToAttack()).toEqual({ x: 1, y: 3 });
    //     expect(closestTarget?.actionType()).toEqual(AIActionType.R_ATTACK);
    // });

    //     it("Should return null if no targets are reachable", () => {
    //         const matrix: number[][] = [
    //             [1, 1, 1],
    //             [1, 1, 1],
    //             [1, 1, 1],
    //         ];
    //         const unit = new UnitRepr("id", TeamType.UPPER, 1, 1, 1, false, true, { x: 1, y: 0 });
    //         const closestTarget = findTarget(unit, new Grid(3), matrix, pathHelper);
    //         expect(closestTarget?.cellToMove()).toBeUndefined();
    //     });
});

// describe("GetCallsForAttackerReturnExpectedPositions", () => {
//     it("Should return near cells for small unit and small attacker", () => {
//         /**
//             [0, 0, 0, 0, 1],
//             [0, 0, 0, 0, 0],
//             [x, x, x, 0, 0],
//             [x, 2, x, 0, 0],
//             [x, x, x, 0, 0],
//          */
//         const cellsForAttacker = getCellsForAttacker({ x: 1, y: 3 }, 5);
//         expect(cellsForAttacker.length).toEqual(8);
//         expect(cellsForAttacker).toContainEqual({ x: 0, y: 2 });
//         expect(cellsForAttacker).toContainEqual({ x: 0, y: 3 });
//         expect(cellsForAttacker).toContainEqual({ x: 0, y: 4 });
//         expect(cellsForAttacker).toContainEqual({ x: 1, y: 2 });
//         expect(cellsForAttacker).toContainEqual({ x: 1, y: 4 });
//         expect(cellsForAttacker).toContainEqual({ x: 2, y: 2 });
//         expect(cellsForAttacker).toContainEqual({ x: 2, y: 3 });
//         expect(cellsForAttacker).toContainEqual({ x: 2, y: 4 });
//     });

//     it("Should return proper cells for small unit and big attacker", () => {
//         /**
//             [0, 0, 0, 0, 1],
//             [0, 0, 0, 0, 0],
//             [0, x, x, x, 0],
//             [0, 2, 0, x, 0],
//             [0, 0, 0, x, 0],
//          */
//         const cellsForAttacker = getCellsForAttacker({ x: 1, y: 3 }, 5, true, false);
//         expect(cellsForAttacker.length).toEqual(5);
//         expect(cellsForAttacker).toContainEqual({ x: 1, y: 2 });
//         expect(cellsForAttacker).toContainEqual({ x: 2, y: 2 });
//         expect(cellsForAttacker).toContainEqual({ x: 3, y: 2 });
//         expect(cellsForAttacker).toContainEqual({ x: 3, y: 3 });
//         expect(cellsForAttacker).toContainEqual({ x: 3, y: 4 });
//     });

//     it("Should return near cells for big unit and small attacker", () => {
//         /**
//             [0, 0, 0, 0, 1],
//             [x, x, x, x, 0],
//             [x, -, -, x, 0],
//             [x, -, 2, x, 0],
//             [x, x, x, x, 0],
//          */
//         const cellsForAttacker = getCellsForAttacker({ x: 2, y: 3 }, 5, false);
//         // console.log(cellsForAttacker);
//         expect(cellsForAttacker.length).toEqual(12);
//         expect(cellsForAttacker).toContainEqual({ x: 0, y: 1 });
//         expect(cellsForAttacker).toContainEqual({ x: 1, y: 1 });
//         expect(cellsForAttacker).toContainEqual({ x: 2, y: 1 });
//         expect(cellsForAttacker).toContainEqual({ x: 3, y: 1 });
//         expect(cellsForAttacker).toContainEqual({ x: 3, y: 2 });
//         expect(cellsForAttacker).toContainEqual({ x: 3, y: 3 });
//         expect(cellsForAttacker).toContainEqual({ x: 3, y: 4 });
//         expect(cellsForAttacker).toContainEqual({ x: 2, y: 4 });
//         expect(cellsForAttacker).toContainEqual({ x: 1, y: 4 });
//         expect(cellsForAttacker).toContainEqual({ x: 0, y: 4 });
//         expect(cellsForAttacker).toContainEqual({ x: 0, y: 3 });
//         expect(cellsForAttacker).toContainEqual({ x: 0, y: 2 });
//     });

//     it("Should return near cells for big unit and big attacker", () => {
//         /**
//             [0, 0, 0, 0, 1, 0],
//             [0, x, x, x, x, 0],
//             [0, -, -, 0, x, 0],
//             [0, -, 2, 0, x, 0],
//             [0, 0, 0, 0, x, 0],
//             [0, x, x, x, x, 0],
//          */
//         const cellsForAttacker = getCellsForAttacker({ x: 2, y: 3 }, 6, false, false);
//         // console.log(cellsForAttacker);
//         expect(cellsForAttacker.length).toEqual(11);
//         expect(cellsForAttacker).toContainEqual({ x: 1, y: 1 });
//         expect(cellsForAttacker).toContainEqual({ x: 2, y: 1 });
//         expect(cellsForAttacker).toContainEqual({ x: 3, y: 1 });
//         expect(cellsForAttacker).toContainEqual({ x: 4, y: 1 });
//         expect(cellsForAttacker).toContainEqual({ x: 4, y: 2 });
//         expect(cellsForAttacker).toContainEqual({ x: 4, y: 3 });
//         expect(cellsForAttacker).toContainEqual({ x: 4, y: 4 });
//         expect(cellsForAttacker).toContainEqual({ x: 4, y: 5 });
//         expect(cellsForAttacker).toContainEqual({ x: 3, y: 5 });
//         expect(cellsForAttacker).toContainEqual({ x: 2, y: 5 });
//         expect(cellsForAttacker).toContainEqual({ x: 1, y: 5 });
//     });
// });

const pathHelper = new PathHelper(gridSettings);

describe("BigUnit", () => {
    (describe("Move", () => {
        it("From Right", () => {
            /**
            Sample matrix
            [2, 0, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 1, .],
            [0, 0, 0, 0],
            */
            const baseCellFrom = { x: 3, y: 1 };
            const baseCellTo = { x: 0, y: 3 };
            const grid = new Grid(gridSettings, PBTypes.GridVals.LAVA_CENTER);
            const unitFrom = generateUnits(grid, 1 /* steps */, false, baseCellFrom, baseCellTo);
            const closestTarget = findTarget(unitFrom, grid, grid.getMatrix(), new UnitsHolder(grid), pathHelper);
            expect(closestTarget?.cellToMove()).toEqual({ x: 2, y: 1 });
            expect(closestTarget?.cellToAttack()).toBeUndefined();
            expect(closestTarget?.actionType()).toEqual(AIActionType.MOVE);
        });

        it("From Left", () => {
            /**
            Sample matrix
            [0, 0, 0, 2],
            [0, 0, 0, 0],
            [., 1, 0, 0],
            [0, 0, 0, 0],
            */
            const baseCellFrom = { x: 0, y: 1 };
            const baseCellTo = { x: 3, y: 3 };
            const grid = new Grid(gridSettings, PBTypes.GridVals.LAVA_CENTER);
            const unitFrom = generateUnits(grid, 1 /* steps */, false, baseCellFrom, baseCellTo);
            const closestTarget = findTarget(unitFrom, grid, grid.getMatrix(), new UnitsHolder(grid), pathHelper);
            expect(closestTarget?.cellToMove()).toEqual({ x: 1, y: 1 });
            expect(closestTarget?.cellToAttack()).toBeUndefined();
            expect(closestTarget?.actionType()).toEqual(AIActionType.MOVE);
        });
    }),
        describe("MoveAndAttack", () => {
            (it("From right bottom diagonally", () => {
                /**
                Sample matrix
                [2, 0, 0, 0],
                [0, 0, 1, 0],
                [0, 0, 0, .],
                [0, 0, 0, 0],
                */
                const baseCellFrom = { x: 3, y: 1 };
                const baseCellTo = { x: 0, y: 3 };
                const grid = new Grid(gridSettings, PBTypes.GridVals.LAVA_CENTER);
                const unitFrom = generateUnits(grid, 2 /* steps */, false, baseCellFrom, baseCellTo);
                const closestTarget = findTarget(unitFrom, grid, grid.getMatrix(), new UnitsHolder(grid), pathHelper);
                expect(closestTarget?.cellToMove()).toEqual({ x: 2, y: 2 });
                // expect(closestTarget?.cellToMove()).toEqual({ x: 0, y: 2 });
                expect(closestTarget?.cellToAttack()).toEqual({ x: 0, y: 3 });
                expect(closestTarget?.actionType()).toEqual(AIActionType.MOVE_AND_MELEE_ATTACK);
            }),
                it("From bottom", () => {
                    /**
                    Sample matrix
                    [0, 2, 0, 0],
                    [0, 1, 0, 0],
                    [0, ., 0, 0],
                    [0, 0, 0, 0],
                    */
                    const baseCellFrom = { x: 1, y: 1 };
                    const baseCellTo = { x: 1, y: 3 };
                    const grid = new Grid(gridSettings, PBTypes.GridVals.LAVA_CENTER);
                    const unitFrom = generateUnits(grid, 1 /* steps */, false, baseCellFrom, baseCellTo);
                    const closestTarget = findTarget(
                        unitFrom,
                        grid,
                        grid.getMatrix(),
                        new UnitsHolder(grid),
                        pathHelper,
                    );
                    expect(closestTarget?.cellToMove()).toEqual({ x: 1, y: 2 });
                    expect(closestTarget?.cellToAttack()).toEqual({ x: 1, y: 3 });
                    expect(closestTarget?.actionType()).toEqual(AIActionType.MOVE_AND_MELEE_ATTACK);
                }));
        }),
        describe("Attack", () => {
            it("From right bottom diagonally", () => {
                /**
                Sample matrix
                [2, 0, 0, 0],
                [0, 0, 1, 0],
                [0, 0, 0, 0],
                [0, 0, 0, 0],
                */
                const baseCellFrom = { x: 2, y: 2 };
                const baseCellTo = { x: 0, y: 3 };
                const grid = new Grid(gridSettings, PBTypes.GridVals.LAVA_CENTER);
                const unitFrom = generateUnits(grid, 1 /* steps */, false, baseCellFrom, baseCellTo);
                const closestTarget = findTarget(unitFrom, grid, grid.getMatrix(), new UnitsHolder(grid), pathHelper);
                expect(closestTarget?.cellToMove()).toEqual({ x: 2, y: 2 });
                expect(closestTarget?.cellToAttack()).toEqual({ x: 0, y: 3 });
                expect(closestTarget?.actionType()).toEqual(AIActionType.MELEE_ATTACK);
            });
        }));
});

const placeEnemy = (grid: Grid, cell: HoCMath.XY): void => {
    const enemy = stubSmallUnit(PBTypes.TeamVals.LOWER, 1, cell);
    grid.occupyCell(
        cell,
        enemy.getId(),
        enemy.getTeam(),
        enemy.getAttackRange(),
        enemy.hasAbilityActive("Made of Fire"),
        enemy.hasAbilityActive("Made of Water"),
    );
};

describe("RangeAttack", () => {
    describe("Cyclops (Large Caliber)", () => {
        it("Returns RANGE_ATTACK when target is in range", () => {
            const grid = new Grid(gridSettings, PBTypes.GridVals.NORMAL);
            const attacker = stubRangeUnit(PBTypes.TeamVals.UPPER, 3, { x: 5, y: 5 }, 8, 6.5, ["Large Caliber"], true);
            grid.occupyCell(
                { x: 5, y: 5 },
                attacker.getId(),
                attacker.getTeam(),
                attacker.getAttackRange(),
                false,
                false,
            );
            placeEnemy(grid, { x: 8, y: 5 });

            const action = findTarget(attacker, grid, grid.getMatrix(), new UnitsHolder(grid), pathHelper);
            expect(action?.actionType()).toEqual(AIActionType.RANGE_ATTACK);
            expect(action?.cellToAttack()).toEqual({ x: 8, y: 5 });
            expect(action?.cellToMove()).toBeUndefined();
        });

        it("Prefers clustered target over isolated one (Large Caliber AOE)", () => {
            const grid = new Grid(gridSettings, PBTypes.GridVals.NORMAL);
            const attacker = stubRangeUnit(PBTypes.TeamVals.UPPER, 3, { x: 5, y: 5 }, 8, 6.5, ["Large Caliber"], true);
            grid.occupyCell(
                { x: 5, y: 5 },
                attacker.getId(),
                attacker.getTeam(),
                attacker.getAttackRange(),
                false,
                false,
            );
            // Isolated enemy at equal distance
            placeEnemy(grid, { x: 8, y: 5 });
            // Clustered enemies: target at (5,8) has two adjacent allies
            placeEnemy(grid, { x: 5, y: 8 });
            placeEnemy(grid, { x: 5, y: 9 });
            placeEnemy(grid, { x: 6, y: 8 });

            const action = findTarget(attacker, grid, grid.getMatrix(), new UnitsHolder(grid), pathHelper);
            expect(action?.actionType()).toEqual(AIActionType.RANGE_ATTACK);
            expect(action?.cellToAttack()).toEqual({ x: 5, y: 8 });
        });
    });

    describe("Tsar Cannon (Through Shot)", () => {
        it("Prefers target with more enemies lined up beyond it", () => {
            const grid = new Grid(gridSettings, PBTypes.GridVals.NORMAL);
            const attacker = stubRangeUnit(
                PBTypes.TeamVals.UPPER,
                3,
                { x: 1, y: 8 },
                4,
                8,
                ["Through Shot", "No Melee", "Mechanism"],
                true,
            );
            grid.occupyCell(
                { x: 1, y: 8 },
                attacker.getId(),
                attacker.getTeam(),
                attacker.getAttackRange(),
                false,
                false,
            );
            // Lone enemy in range, off the line
            placeEnemy(grid, { x: 4, y: 11 });
            // Three enemies lined up beyond (4,8) on the row y=8
            placeEnemy(grid, { x: 4, y: 8 });
            placeEnemy(grid, { x: 7, y: 8 });
            placeEnemy(grid, { x: 10, y: 8 });

            const action = findTarget(attacker, grid, grid.getMatrix(), new UnitsHolder(grid), pathHelper);
            expect(action?.actionType()).toEqual(AIActionType.RANGE_ATTACK);
            expect(action?.cellToAttack()).toEqual({ x: 4, y: 8 });
        });
    });

    describe("Gargantuan (Double Shot + Area Throw)", () => {
        it("Prefers clustered target (Double Shot + Area Throw combo)", () => {
            const grid = new Grid(gridSettings, PBTypes.GridVals.NORMAL);
            const attacker = stubRangeUnit(
                PBTypes.TeamVals.UPPER,
                3,
                { x: 3, y: 3 },
                14,
                5,
                ["Double Shot", "Area Throw"],
                false,
            );
            // Big unit occupies 4 cells around (3,3)
            for (const c of attacker.getCells()) {
                grid.occupyCell(c, attacker.getId(), attacker.getTeam(), attacker.getAttackRange(), false, false);
            }
            // Isolated enemy at equal distance
            placeEnemy(grid, { x: 6, y: 3 });
            // Clustered enemies
            placeEnemy(grid, { x: 3, y: 6 });
            placeEnemy(grid, { x: 3, y: 7 });
            placeEnemy(grid, { x: 4, y: 6 });

            const action = findTarget(attacker, grid, grid.getMatrix(), new UnitsHolder(grid), pathHelper);
            expect(action?.actionType()).toEqual(AIActionType.RANGE_ATTACK);
            expect(action?.cellToAttack()).toEqual({ x: 3, y: 6 });
        });
    });

    describe("OutOfRange", () => {
        it("Falls back to MOVE when no target is in range", () => {
            const grid = new Grid(gridSettings, PBTypes.GridVals.NORMAL);
            // Sniper-shot_distance of 1 with 1 shot: max range = 4 cells
            const attacker = stubRangeUnit(PBTypes.TeamVals.UPPER, 3, { x: 1, y: 1 }, 1, 1, [], true);
            grid.occupyCell(
                { x: 1, y: 1 },
                attacker.getId(),
                attacker.getTeam(),
                attacker.getAttackRange(),
                false,
                false,
            );
            // Enemy at distance > maxRangeCells (4)
            placeEnemy(grid, { x: 14, y: 14 });

            const action = findTarget(attacker, grid, grid.getMatrix(), new UnitsHolder(grid), pathHelper);
            // No range attack possible; with range attack the unit can't melee-attack,
            // so the AI either falls back to doFindTarget movement or returns undefined.
            expect(action === undefined || action.actionType() === AIActionType.MOVE).toBe(true);
        });
    });
});

describe("AI attack-cell helpers", () => {
    it("exposes the active known paths carried by an action", () => {
        const knownPaths = new Map([[33, []]]);
        const action = new BasicAIAction(AIActionType.MOVE, { x: 1, y: 2 }, undefined, knownPaths);

        expect(action.currentActiveKnownPaths()).toBe(knownPaths);
    });

    it("returns adjacent free cells for a small attacker around a small target", () => {
        const attacker = stubSmallUnit(PBTypes.TeamVals.UPPER, 3, { x: 1, y: 1 });
        const matrix = Array.from({ length: 6 }, () => new Array(6).fill(0));

        const cells = getCellsForAttacker({ x: 3, y: 3 }, matrix, attacker, true, true);

        expect(cells).toContainEqual({ x: 2, y: 2 });
        expect(cells).toContainEqual({ x: 4, y: 4 });
        expect(cells).toHaveLength(8);
    });

    it("expands legal attack cells for large targets and large attackers", () => {
        const matrix = Array.from({ length: 8 }, () => new Array(8).fill(0));
        const smallAttacker = stubSmallUnit(PBTypes.TeamVals.UPPER, 3, { x: 1, y: 1 });

        const cellsForLargeTarget = getCellsForAttacker({ x: 3, y: 3 }, matrix, smallAttacker, true, false);

        expect(cellsForLargeTarget).toContainEqual({ x: 5, y: 2 });
        expect(cellsForLargeTarget).toContainEqual({ x: 5, y: 5 });
        expect(cellsForLargeTarget).toContainEqual({ x: 2, y: 5 });

        const bigAttacker = stubBigUnit(PBTypes.TeamVals.UPPER, 3, { x: 2, y: 2 });
        const cellsForBigAttacker = getCellsForAttacker({ x: 4, y: 4 }, matrix, bigAttacker, false, true);

        expect(cellsForBigAttacker.length).toBeGreaterThan(0);
        expect(cellsForBigAttacker.every((cell) => cell.x >= 0 && cell.y >= 0)).toBe(true);
    });
});

// Unit tests for AI helper functions.

describe("isLineBlockedByObstacle", () => {
    const EMPTY = [
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0],
    ];

    it("returns false for adjacent cells (nothing between them)", () => {
        expect(isLineBlockedByObstacle({ x: 0, y: 0 }, { x: 1, y: 0 }, EMPTY)).toBe(false);
        expect(isLineBlockedByObstacle({ x: 2, y: 2 }, { x: 3, y: 2 }, EMPTY)).toBe(false);
    });

    it("returns false for a clear line on an empty grid", () => {
        expect(isLineBlockedByObstacle({ x: 0, y: 0 }, { x: 4, y: 0 }, EMPTY)).toBe(false);
        expect(isLineBlockedByObstacle({ x: 0, y: 0 }, { x: 4, y: 4 }, EMPTY)).toBe(false);
    });

    it("returns true when a mountain (-1) is between the two cells", () => {
        const matrix = [
            [0, 0, 0, 0, 0],
            [0, 0, -1, 0, 0],
            [0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0],
        ];
        expect(isLineBlockedByObstacle({ x: 0, y: 1 }, { x: 4, y: 1 }, matrix)).toBe(true);
    });

    it("returns false when the mountain is NOT on the line", () => {
        const matrix = [
            [0, 0, 0, 0, 0],
            [0, 0, -1, 0, 0],
            [0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0],
        ];
        expect(isLineBlockedByObstacle({ x: 0, y: 0 }, { x: 4, y: 0 }, matrix)).toBe(false);
    });

    it("does not count the endpoints as blocking", () => {
        const matrix = [
            [0, 0, 0, 0, 0],
            [-1, 0, 0, 0, -1],
            [0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0],
        ];
        // From cell at the mountain to a far cell; the starting cell's obstacle does not block.
        expect(isLineBlockedByObstacle({ x: 0, y: 1 }, { x: 3, y: 1 }, matrix)).toBe(false);
    });
});

describe("countMeleeThreatsToCell", () => {
    it("returns 0 on an empty grid", () => {
        const matrix = [
            [0, 0, 0],
            [0, 0, 0],
            [0, 0, 0],
        ];
        expect(countMeleeThreatsToCell({ x: 1, y: 1 }, matrix, 1)).toBe(0);
    });

    it("counts adjacent enemies (all 8 directions)", () => {
        const matrix = [
            [1, 1, 0],
            [1, 0, 0],
            [0, 0, 1],
        ];
        expect(countMeleeThreatsToCell({ x: 1, y: 1 }, matrix, 1)).toBe(4);
    });

    it("does not count the cell itself", () => {
        const matrix = [
            [0, 0, 0],
            [0, 1, 0],
            [0, 0, 0],
        ];
        expect(countMeleeThreatsToCell({ x: 1, y: 1 }, matrix, 1)).toBe(0);
    });

    it("only counts the specified team", () => {
        const matrix = [
            [2, 2, 0],
            [1, 0, 0],
            [0, 0, 0],
        ];
        expect(countMeleeThreatsToCell({ x: 1, y: 1 }, matrix, 1)).toBe(1);
        expect(countMeleeThreatsToCell({ x: 1, y: 1 }, matrix, 2)).toBe(2);
    });
});

describe("analyzeEngagement", () => {
    it("returns zeros when no allies exist", () => {
        const grid = new Grid(gridSettings, PBTypes.GridVals.NORMAL);
        const unit = stubSmallUnit(PBTypes.TeamVals.UPPER, 3, { x: 5, y: 5 });
        const holder = new UnitsHolder(grid);
        const result = analyzeEngagement(unit, grid.getMatrix(), holder);
        expect(result.totalAllies).toBe(0);
        expect(result.totalMeleeAllies).toBe(0);
        expect(result.totalRangedAllies).toBe(0);
        expect(result.engagedMeleeAllies).toBe(0);
        expect(result.enemiesPressing).toBe(false);
        expect(result.allyMeleeCenter).toBeUndefined();
    });

    it("counts melee and ranged allies correctly", () => {
        const grid = new Grid(gridSettings, PBTypes.GridVals.NORMAL);
        const holder = new UnitsHolder(grid);
        const main = stubSmallUnit(PBTypes.TeamVals.UPPER, 3, { x: 5, y: 5 });
        const melee1 = stubSmallUnit(PBTypes.TeamVals.UPPER, 3, { x: 6, y: 5 });
        const ranged1 = stubRangeUnit(PBTypes.TeamVals.UPPER, 3, { x: 7, y: 5 }, 3, 6);
        holder.addUnit(main);
        holder.addUnit(melee1);
        holder.addUnit(ranged1);
        const result = analyzeEngagement(main, grid.getMatrix(), holder);
        expect(result.totalMeleeAllies).toBe(1);
        expect(result.totalRangedAllies).toBe(1);
    });

    it("detects enemies pressing when an enemy is within 3 cells of an ally", () => {
        const grid = new Grid(gridSettings, PBTypes.GridVals.NORMAL);
        const holder = new UnitsHolder(grid);
        const main = stubSmallUnit(PBTypes.TeamVals.UPPER, 3, { x: 5, y: 5 });
        const ally = stubSmallUnit(PBTypes.TeamVals.UPPER, 3, { x: 7, y: 7 });
        const enemy = stubSmallUnit(PBTypes.TeamVals.LOWER, 3, { x: 8, y: 7 });
        grid.occupyCell({ x: 5, y: 5 }, main.getId(), main.getTeam(), 1, false, false);
        grid.occupyCell({ x: 7, y: 7 }, ally.getId(), ally.getTeam(), 1, false, false);
        grid.occupyCell({ x: 8, y: 7 }, enemy.getId(), enemy.getTeam(), 1, false, false);
        holder.addUnit(main);
        holder.addUnit(ally);
        holder.addUnit(enemy);
        const result = analyzeEngagement(main, grid.getMatrix(), holder);
        expect(result.enemiesPressing).toBe(true);
    });

    it("reports no pressing when enemies are far away", () => {
        const grid = new Grid(gridSettings, PBTypes.GridVals.NORMAL);
        const holder = new UnitsHolder(grid);
        const main = stubSmallUnit(PBTypes.TeamVals.UPPER, 3, { x: 1, y: 1 });
        const enemy = stubSmallUnit(PBTypes.TeamVals.LOWER, 3, { x: 14, y: 14 });
        holder.addUnit(main);
        holder.addUnit(enemy);
        const result = analyzeEngagement(main, grid.getMatrix(), holder);
        expect(result.enemiesPressing).toBe(false);
    });

    it("computes ally melee center", () => {
        const grid = new Grid(gridSettings, PBTypes.GridVals.NORMAL);
        const holder = new UnitsHolder(grid);
        const main = stubSmallUnit(PBTypes.TeamVals.UPPER, 3, { x: 5, y: 5 });
        const ally1 = stubSmallUnit(PBTypes.TeamVals.UPPER, 3, { x: 7, y: 5 });
        const ally2 = stubSmallUnit(PBTypes.TeamVals.UPPER, 3, { x: 5, y: 7 });
        holder.addUnit(main);
        holder.addUnit(ally1);
        holder.addUnit(ally2);
        const result = analyzeEngagement(main, grid.getMatrix(), holder);
        expect(result.allyMeleeCenter).toEqual({ x: 6, y: 6 });
    });
});

describe("findSaferMoveCell", () => {
    const ENEMY_TEAM = 1;

    it("returns the preferred cell if it has no melee threats", () => {
        const matrix = [
            [0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0],
        ];
        const knownPaths = new Map([
            [0x23, []],
            [0x34, []],
        ]);
        const result = findSaferMoveCell({ x: 3, y: 2 }, knownPaths, matrix, ENEMY_TEAM, true);
        expect(result).toEqual({ x: 3, y: 2 });
    });

    it("returns the preferred cell when isRangedUnit is false", () => {
        const matrix = [
            [0, 0, 0],
            [0, 0, 0],
            [0, 0, 1],
        ];
        const knownPaths = new Map([[0x11, []]]);
        const result = findSaferMoveCell({ x: 1, y: 1 }, knownPaths, matrix, ENEMY_TEAM, false);
        expect(result).toEqual({ x: 1, y: 1 });
    });

    it("finds a safer cell when the preferred one is adjacent to an enemy", () => {
        const matrix = [
            [0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0],
            [0, 0, 0, 1, 0],
            [0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0],
        ];
        // Preferred cell is adjacent to an enemy; safer alternatives should be considered.
        const m2 = [
            [0, 0, 0, 0, 0],
            [0, 0, 1, 0, 0],
            [0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0],
        ];
        const knownPaths = new Map([
            [(0 << 4) | 0, []],
            [(1 << 4) | 2, []], // safe cell (1,2)
            [(2 << 4) | 1, []],
        ]);
        const preferred = { x: 1, y: 2 };
        const result = findSaferMoveCell(preferred, knownPaths, m2, ENEMY_TEAM, true);
        expect(result).toBeDefined();
        // The safer cell should have 0 threats
        if (result) {
            expect(countMeleeThreatsToCell(result, m2, ENEMY_TEAM)).toBe(0);
        }
    });

    it("returns undefined-safe (preferred) when knownPaths is empty", () => {
        const result = findSaferMoveCell({ x: 1, y: 1 }, new Map(), [], 1, true);
        expect(result).toEqual({ x: 1, y: 1 });
    });
});

describe("AI Strategy: ranged-heavy defense", () => {
    it("melee unit holds position when team is ranged-heavy and enemies are far", () => {
        const grid = new Grid(gridSettings, PBTypes.GridVals.NORMAL);
        const holder = new UnitsHolder(grid);
        // One melee unit (the AI unit)
        const melee = stubSmallUnit(PBTypes.TeamVals.UPPER, 5, { x: 5, y: 5 });
        // Two ranged allies
        const r1 = stubRangeUnit(PBTypes.TeamVals.UPPER, 3, { x: 3, y: 3 }, 3, 8);
        const r2 = stubRangeUnit(PBTypes.TeamVals.UPPER, 3, { x: 3, y: 7 }, 3, 8);
        // Enemy far away
        const enemy = stubSmallUnit(PBTypes.TeamVals.LOWER, 3, { x: 14, y: 14 });
        grid.occupyCell({ x: 5, y: 5 }, melee.getId(), melee.getTeam(), 1, false, false);
        grid.occupyCell({ x: 3, y: 3 }, r1.getId(), r1.getTeam(), 1, false, false);
        grid.occupyCell({ x: 3, y: 7 }, r2.getId(), r2.getTeam(), 1, false, false);
        grid.occupyCell({ x: 14, y: 14 }, enemy.getId(), enemy.getTeam(), 1, false, false);
        holder.addUnit(melee);
        holder.addUnit(r1);
        holder.addUnit(r2);
        holder.addUnit(enemy);

        const action = findTarget(melee, grid, grid.getMatrix(), holder, pathHelper);
        // Should return undefined (hold) because team is ranged-heavy and enemies are not pressing
        expect(action).toBeUndefined();
    });

    it("melee unit advances when enemies are pressing even in ranged-heavy team", () => {
        const grid = new Grid(gridSettings, PBTypes.GridVals.NORMAL);
        const holder = new UnitsHolder(grid);
        const melee = stubSmallUnit(PBTypes.TeamVals.UPPER, 5, { x: 5, y: 5 });
        const r1 = stubRangeUnit(PBTypes.TeamVals.UPPER, 3, { x: 3, y: 3 }, 3, 8);
        const enemy = stubSmallUnit(PBTypes.TeamVals.LOWER, 3, { x: 7, y: 5 });
        grid.occupyCell({ x: 5, y: 5 }, melee.getId(), melee.getTeam(), 1, false, false);
        grid.occupyCell({ x: 3, y: 3 }, r1.getId(), r1.getTeam(), 1, false, false);
        grid.occupyCell({ x: 7, y: 5 }, enemy.getId(), enemy.getTeam(), 1, false, false);
        holder.addUnit(melee);
        holder.addUnit(r1);
        holder.addUnit(enemy);

        const action = findTarget(melee, grid, grid.getMatrix(), holder, pathHelper);
        // Enemy is within 3 cells, so the melee unit should not hold.
        expect(action).toBeDefined();
    });
});

describe("AI Strategy: ranged units avoid melee range", () => {
    it("ranged unit does not move to a cell adjacent to an enemy", () => {
        const grid = new Grid(gridSettings, PBTypes.GridVals.NORMAL);
        const holder = new UnitsHolder(grid);
        const ranged = stubRangeUnit(PBTypes.TeamVals.UPPER, 3, { x: 1, y: 1 }, 1, 1, [], true);
        const enemy = stubSmallUnit(PBTypes.TeamVals.LOWER, 3, { x: 10, y: 10 });
        grid.occupyCell({ x: 1, y: 1 }, ranged.getId(), ranged.getTeam(), 1, false, false);
        grid.occupyCell({ x: 10, y: 10 }, enemy.getId(), enemy.getTeam(), 1, false, false);
        holder.addUnit(ranged);
        holder.addUnit(enemy);

        const action = findTarget(ranged, grid, grid.getMatrix(), holder, pathHelper);
        // Out of range, so falls to MOVE. Check that destination is NOT adjacent to enemy.
        if (action && action.cellToMove()) {
            const dest = action.cellToMove()!;
            const threats = countMeleeThreatsToCell(dest, grid.getMatrix(), PBTypes.TeamVals.LOWER);
            expect(threats).toBe(0);
        }
    });
});

describe("AI Strategy: group coordination", () => {
    it("isolated melee unit moves toward ally group center when no enemies pressing", () => {
        const grid = new Grid(gridSettings, PBTypes.GridVals.NORMAL);
        const holder = new UnitsHolder(grid);
        const lone = stubSmallUnit(PBTypes.TeamVals.UPPER, 5, { x: 1, y: 1 });
        const ally1 = stubSmallUnit(PBTypes.TeamVals.UPPER, 3, { x: 10, y: 10 });
        const ally2 = stubSmallUnit(PBTypes.TeamVals.UPPER, 3, { x: 12, y: 10 });
        const enemy = stubSmallUnit(PBTypes.TeamVals.LOWER, 3, { x: 14, y: 14 });
        grid.occupyCell({ x: 1, y: 1 }, lone.getId(), lone.getTeam(), 1, false, false);
        grid.occupyCell({ x: 10, y: 10 }, ally1.getId(), ally1.getTeam(), 1, false, false);
        grid.occupyCell({ x: 12, y: 10 }, ally2.getId(), ally2.getTeam(), 1, false, false);
        grid.occupyCell({ x: 14, y: 14 }, enemy.getId(), enemy.getTeam(), 1, false, false);
        holder.addUnit(lone);
        holder.addUnit(ally1);
        holder.addUnit(ally2);
        holder.addUnit(enemy);

        const action = findTarget(lone, grid, grid.getMatrix(), holder, pathHelper);
        expect(action).toBeDefined();
        // The unit should be moving toward allies (right/up), not just toward the enemy.
        if (action?.cellToMove()) {
            const dest = action.cellToMove()!;
            // Should have moved closer to ally center (~11,10), i.e. x should increase from 1
            expect(dest.x).toBeGreaterThan(1);
        }
    });
});

describe("AI: AOE units ignore mountain LOS", () => {
    it("Cyclops with Large Caliber targets units behind a mountain", () => {
        const grid = new Grid(gridSettings, PBTypes.GridVals.BLOCK_CENTER);
        const holder = new UnitsHolder(grid);
        // Cyclops is a large unit with Large Caliber
        const cyclops = stubRangeUnit(
            PBTypes.TeamVals.UPPER,
            3,
            { x: 3, y: 3 },
            3,
            8,
            ["Large Caliber"],
            false, // big unit
        );
        // Enemy on the other side of the mountain (center)
        const enemy = stubSmallUnit(PBTypes.TeamVals.LOWER, 3, { x: 11, y: 11 });
        grid.occupyCell({ x: 3, y: 3 }, cyclops.getId(), cyclops.getTeam(), 1, false, false);
        grid.occupyCell({ x: 11, y: 11 }, enemy.getId(), enemy.getTeam(), 1, false, false);
        holder.addUnit(cyclops);
        holder.addUnit(enemy);

        const matrix = grid.getMatrix();
        const action = findTarget(cyclops, grid, matrix, holder, pathHelper);
        // Should fire RANGE_ATTACK despite the mountain being in the way (AOE ignores it)
        expect(action).toBeDefined();
        expect(action!.actionType()).toBe(AIActionType.RANGE_ATTACK);
    });
});

function stubSmallUnit(teamType: TeamType, steps: number, baseCell: HoCMath.XY): UnitRepr {
    return new UnitRepr(
        crypto.randomUUID(),
        teamType,
        steps,
        1,
        1,
        true,
        true,
        baseCell,
        [baseCell],
        PBTypes.AttackVals.MELEE,
        "",
        0,
        0,
        new Set<string>(),
    );
}

function stubBigUnit(teamType: TeamType, steps: number, baseCell: HoCMath.XY): UnitRepr {
    return new UnitRepr(
        crypto.randomUUID(),
        teamType,
        steps,
        1,
        1,
        true,
        false,
        baseCell,
        [
            baseCell,
            { x: baseCell.x - 1, y: baseCell.y },
            { x: baseCell.x - 1, y: baseCell.y - 1 },
            { x: baseCell.x, y: baseCell.y - 1 },
        ],
        PBTypes.AttackVals.MELEE,
        "",
        0,
        0,
        new Set<string>(),
    );
}

function stubRangeUnit(
    teamType: TeamType,
    steps: number,
    baseCell: HoCMath.XY,
    rangeShots: number,
    shotDistance: number,
    abilities: string[] = [],
    isSmall = true,
): UnitRepr {
    const cells = isSmall
        ? [baseCell]
        : [
              baseCell,
              { x: baseCell.x - 1, y: baseCell.y },
              { x: baseCell.x - 1, y: baseCell.y - 1 },
              { x: baseCell.x, y: baseCell.y - 1 },
          ];
    return new UnitRepr(
        crypto.randomUUID(),
        teamType,
        steps,
        1,
        1,
        true,
        isSmall,
        baseCell,
        cells,
        PBTypes.AttackVals.RANGE,
        "",
        rangeShots,
        shotDistance,
        new Set<string>(abilities),
    );
}

class UnitRepr implements IUnitAIRepr {
    public constructor(
        public id: string,
        public team: TeamType,
        public steps: number, // distance the unit can travel
        public speed: number, // inititive
        public size: number,
        public isFlying: boolean,
        public isSmall: boolean,
        public baseCell: HoCMath.XY,
        public cells: HoCMath.XY[],
        public attackType: AttackType,
        public target: string,
        public rangeShots: number,
        public rangeShotDistance: number,
        public abilities: Set<string>,
    ) {
        // public movePath?: IMovePath, // the IMovePath that is returned from PathHelper.getMovePath if provided
    }

    public getId(): string {
        return this.id;
    }

    public getTeam(): TeamType {
        return this.team;
    }

    public getSteps(): number {
        return this.steps;
    }

    public getSpeed(): number {
        return this.speed;
    }

    public getSize(): number {
        return this.size;
    }

    public canFly(): boolean {
        return this.isFlying;
    }

    public isSmallSize(): boolean {
        return this.isSmall;
    }

    public getBaseCell(): HoCMath.XY {
        return this.baseCell;
    }

    public getCells(): HoCMath.XY[] {
        return this.cells;
    }

    public getAttackType(): AttackType {
        return this.attackType;
    }

    public canMove(): boolean {
        return true;
    }

    public getTarget(): string {
        return this.target;
    }

    public getAttackRange(): number {
        return 1;
    }

    public hasAbilityActive(abilityName: string): boolean {
        return this.abilities.has(abilityName);
    }

    public getRangeShots(): number {
        return this.rangeShots;
    }

    public getRangeShotDistance(): number {
        return this.rangeShotDistance;
    }

    public isDead(): boolean {
        return false;
    }
}
