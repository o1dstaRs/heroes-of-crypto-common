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

import { AIActionType, findTarget, getCellsForAttacker } from "../../src/ai/ai";
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
    describe("Move", () => {
        it("From right bottom diagonally", () => {
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
            });
    }),
        describe("MoveAndAttack", () => {
            it("From bottom closest one", () => {
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
                });
        });

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
    describe("Move", () => {
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
            it("From right bottom diagonally", () => {
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
                });
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
        });
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
            const attacker = stubRangeUnit(
                PBTypes.TeamVals.UPPER,
                3,
                { x: 5, y: 5 },
                8,
                6.5,
                ["Large Caliber"],
                true,
            );
            grid.occupyCell(
                { x: 5, y: 5 },
                attacker.getId(),
                attacker.getTeam(),
                attacker.getAttackRange(),
                false,
                false,
            );
            placeEnemy(grid, { x: 8, y: 5 });

            const action = findTarget(
                attacker,
                grid,
                grid.getMatrix(),
                new UnitsHolder(grid),
                pathHelper,
            );
            expect(action?.actionType()).toEqual(AIActionType.RANGE_ATTACK);
            expect(action?.cellToAttack()).toEqual({ x: 8, y: 5 });
            expect(action?.cellToMove()).toBeUndefined();
        });

        it("Prefers clustered target over isolated one (Large Caliber AOE)", () => {
            const grid = new Grid(gridSettings, PBTypes.GridVals.NORMAL);
            const attacker = stubRangeUnit(
                PBTypes.TeamVals.UPPER,
                3,
                { x: 5, y: 5 },
                8,
                6.5,
                ["Large Caliber"],
                true,
            );
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

            const action = findTarget(
                attacker,
                grid,
                grid.getMatrix(),
                new UnitsHolder(grid),
                pathHelper,
            );
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

            const action = findTarget(
                attacker,
                grid,
                grid.getMatrix(),
                new UnitsHolder(grid),
                pathHelper,
            );
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

            const action = findTarget(
                attacker,
                grid,
                grid.getMatrix(),
                new UnitsHolder(grid),
                pathHelper,
            );
            expect(action?.actionType()).toEqual(AIActionType.RANGE_ATTACK);
            expect(action?.cellToAttack()).toEqual({ x: 3, y: 6 });
        });
    });

    describe("OutOfRange", () => {
        it("Falls back to MOVE when no target is in range", () => {
            const grid = new Grid(gridSettings, PBTypes.GridVals.NORMAL);
            // Sniper-shot_distance of 1 with 1 shot: max range = 4 cells
            const attacker = stubRangeUnit(
                PBTypes.TeamVals.UPPER,
                3,
                { x: 1, y: 1 },
                1,
                1,
                [],
                true,
            );
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

            const action = findTarget(
                attacker,
                grid,
                grid.getMatrix(),
                new UnitsHolder(grid),
                pathHelper,
            );
            // No range attack possible; with range attack the unit can't melee-attack,
            // so the AI either falls back to doFindTarget movement or returns undefined.
            expect(action === undefined || action.actionType() === AIActionType.MOVE).toBe(true);
        });
    });
});

describe("AI attack-cell helpers", () => {
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
}
