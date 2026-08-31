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
import { Grid } from "../../src/grid/grid";
import { GridSettings } from "../../src/grid/grid_settings";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getFootprintCellsForAnchor } from "../../src/grid/grid_math";
import type { XY } from "../../src/utils/math";
import {
    GRID_SIZE,
    MAX_X,
    MAX_Y,
    MIN_X,
    MIN_Y,
    MOVEMENT_DELTA,
    UNIT_SIZE_DELTA,
    UPDATE_DOWN_LEFT,
    UPDATE_DOWN_RIGHT,
    UPDATE_UP_LEFT,
    UPDATE_UP_RIGHT,
} from "../../src/grid/grid_constants";

// Rectangular footprints (1x2, 2x1, WxH) on the occupancy grid. Two things are under test and they pull in
// opposite directions: the aggro ring must become footprint-generic (a 1x2 used to stamp NOTHING, because the
// legacy corner-mask branch only fired when the body was wider than one cell in BOTH axes), and it must stay
// bit-identical for the two shipped shapes, whose boards every baked AI weight was trained against.

const TEAM = PBTypes.TeamVals.LEFT;
const ATTACK_RANGE = 1;
const BASELINE = 1;

const newGridSettings = (): GridSettings =>
    new GridSettings(GRID_SIZE, MAX_Y, MIN_Y, MAX_X, MIN_X, MOVEMENT_DELTA, UNIT_SIZE_DELTA);

const newGrid = (): Grid => new Grid(newGridSettings(), PBTypes.GridVals.NORMAL);

const key = (cell: XY): string => `${cell.x},${cell.y}`;

/** Cells whose aggro exceeds the baseline, i.e. what path_helper reads as threatened. Board is [x][y]. */
const threatenedCells = (board: number[][]): Map<string, number> => {
    const threatened = new Map<string, number>();
    for (let x = 0; x < GRID_SIZE; x++) {
        for (let y = 0; y < GRID_SIZE; y++) {
            if (board[x][y] !== BASELINE) {
                threatened.set(key({ x, y }), board[x][y]);
            }
        }
    }
    return threatened;
};

/** The cells a body of `cells` touches without standing on, clipped to the board — the ring we expect. */
const expectedRing = (cells: XY[]): string[] => {
    const body = new Set(cells.map(key));
    const ring = new Set<string>();
    for (const cell of cells) {
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const around = { x: cell.x + dx, y: cell.y + dy };
                if (around.x < 0 || around.y < 0 || around.x >= GRID_SIZE || around.y >= GRID_SIZE) {
                    continue;
                }
                if (!body.has(key(around))) {
                    ring.add(key(around));
                }
            }
        }
    }
    return [...ring].sort();
};

const occupiedBoard = (cells: XY[]): number[][] => {
    const grid = newGrid();
    expect(grid.occupyCells(cells, "unit", TEAM, ATTACK_RANGE, false, false)).toBe(true);
    return grid.getAggrMatrixByTeam(TEAM)!;
};

/**
 * The pre-footprint stamping algorithm, replayed straight through the grid's own mask machinery rather than
 * transcribed: a single cell went in unmasked, and a large unit went in as four masked corner calls over its
 * bounding box, guarded by "wider than one cell in both axes". Reaching for the private method is the point —
 * it is the reference the generic ring has to reproduce, so the comparison must not be able to drift from it.
 */
type LegacyAggrStamper = {
    updateAggrGrid: (cell: XY, range: number, updBy: number, aggrGrid?: number[][], mask?: number) => void;
};

const legacyBoard = (cells: XY[]): number[][] => {
    const grid = newGrid();
    const board = grid.getAggrMatrixByTeam(TEAM)!;
    const stamper = grid as unknown as LegacyAggrStamper;

    if (cells.length === 1) {
        stamper.updateAggrGrid(cells[0], ATTACK_RANGE, 1, board);
        return board;
    }

    let xMin = Number.MAX_SAFE_INTEGER;
    let xMax = Number.MIN_SAFE_INTEGER;
    let yMin = Number.MAX_SAFE_INTEGER;
    let yMax = Number.MIN_SAFE_INTEGER;
    for (const cell of cells) {
        xMin = Math.min(xMin, cell.x);
        xMax = Math.max(xMax, cell.x);
        yMin = Math.min(yMin, cell.y);
        yMax = Math.max(yMax, cell.y);
    }
    if (xMin !== xMax && yMin !== yMax) {
        stamper.updateAggrGrid({ x: xMin, y: yMin }, ATTACK_RANGE, 1, board, UPDATE_DOWN_LEFT);
        stamper.updateAggrGrid({ x: xMin, y: yMax }, ATTACK_RANGE, 1, board, UPDATE_UP_LEFT);
        stamper.updateAggrGrid({ x: xMax, y: yMin }, ATTACK_RANGE, 1, board, UPDATE_DOWN_RIGHT);
        stamper.updateAggrGrid({ x: xMax, y: yMax }, ATTACK_RANGE, 1, board, UPDATE_UP_RIGHT);
    }
    return board;
};

const expectBoardsEqual = (actual: number[][], expected: number[][], label: string): void => {
    for (let x = 0; x < GRID_SIZE; x++) {
        for (let y = 0; y < GRID_SIZE; y++) {
            if (actual[x][y] !== expected[x][y]) {
                throw new Error(
                    `${label}: aggro differs at (${x}, ${y}) — footprint ring ${actual[x][y]}, legacy ${expected[x][y]}`,
                );
            }
        }
    }
};

const expectBaselineEverywhere = (board: number[][], label: string): void => {
    for (let x = 0; x < GRID_SIZE; x++) {
        for (let y = 0; y < GRID_SIZE; y++) {
            if (board[x][y] !== BASELINE) {
                throw new Error(`${label}: aggro left at ${board[x][y]} on (${x}, ${y}), expected ${BASELINE}`);
            }
        }
    }
};

describe("footprint occupancy — aggro parity for the shipped shapes", () => {
    it("stamps a 1x1 exactly where the legacy unmasked call did, from every cell on the board", () => {
        for (let x = 0; x < GRID_SIZE; x++) {
            for (let y = 0; y < GRID_SIZE; y++) {
                const cells = getFootprintCellsForAnchor({ x, y }, 1, 1);
                expectBoardsEqual(occupiedBoard(cells), legacyBoard(cells), `1x1 at (${x}, ${y})`);
            }
        }
    });

    it("stamps a 2x2 exactly where the legacy four corner masks did, from every anchor on the board", () => {
        for (let x = 1; x < GRID_SIZE; x++) {
            for (let y = 1; y < GRID_SIZE; y++) {
                const cells = getFootprintCellsForAnchor({ x, y }, 2, 2);
                expectBoardsEqual(occupiedBoard(cells), legacyBoard(cells), `2x2 anchored at (${x}, ${y})`);
            }
        }
    });

    // Guards the parity sweep against passing on two all-baseline boards: the legacy reference really does
    // put the documented 8- and 12-cell rings on the board, so the sweep above compares something.
    it("the legacy reference is the 8-cell ring of a 1x1 and the 12-cell ring of a 2x2", () => {
        expect(
            [...threatenedCells(legacyBoard(getFootprintCellsForAnchor({ x: 8, y: 8 }, 1, 1))).keys()].sort(),
        ).toEqual(expectedRing(getFootprintCellsForAnchor({ x: 8, y: 8 }, 1, 1)));
        expect(
            [...threatenedCells(legacyBoard(getFootprintCellsForAnchor({ x: 8, y: 8 }, 2, 2))).keys()].sort(),
        ).toEqual(expectedRing(getFootprintCellsForAnchor({ x: 8, y: 8 }, 2, 2)));
        expect(expectedRing(getFootprintCellsForAnchor({ x: 8, y: 8 }, 1, 1))).toHaveLength(8);
        expect(expectedRing(getFootprintCellsForAnchor({ x: 8, y: 8 }, 2, 2))).toHaveLength(12);
    });

    it("rebuildAggrBoards reproduces the occupancy stamp for both shipped shapes", () => {
        for (const [width, height, anchor] of [
            [1, 1, { x: 8, y: 8 }],
            [2, 2, { x: 8, y: 8 }],
            [1, 1, { x: 0, y: 0 }],
            [2, 2, { x: 15, y: 15 }],
        ] as [number, number, XY][]) {
            const cells = getFootprintCellsForAnchor(anchor, width, height);
            const grid = newGrid();
            expect(grid.occupyCells(cells, "unit", TEAM, ATTACK_RANGE, false, false)).toBe(true);
            const stamped = grid.getAggrMatrixByTeam(TEAM)!.map((row) => [...row]);
            grid.rebuildAggrBoards(new Map([["unit", ATTACK_RANGE]]));
            expectBoardsEqual(grid.getAggrMatrixByTeam(TEAM)!, stamped, `${width}x${height} rebuild`);
        }
    });
});

describe("footprint occupancy — rectangular bodies", () => {
    it("the scalar footprint probe is exactly equivalent to the array occupancy oracle", () => {
        const grid = newGrid();
        expect(
            grid.occupyCells(
                [
                    { x: 7, y: 7 },
                    { x: 8, y: 7 },
                ],
                "unit",
                TEAM,
                ATTACK_RANGE,
                false,
                false,
            ),
        ).toBe(true);
        grid.occupyByHole({ x: 9, y: 9 });
        expect(grid.occupyCell({ x: 10, y: 10 }, "L", TEAM, 0, false, false)).toBe(true);
        expect(grid.occupyCell({ x: 11, y: 11 }, "W", TEAM, 0, false, false)).toBe(true);

        for (const [width, height] of [
            [1, 1],
            [2, 2],
            [1, 2],
            [2, 1],
            [3, 2],
        ]) {
            for (let x = -1; x <= GRID_SIZE; x++) {
                for (let y = -1; y <= GRID_SIZE; y++) {
                    const anchor = { x, y };
                    const cells = getFootprintCellsForAnchor(anchor, width, height);
                    for (const [canOccupyLava, canOccupyWater, ownUnitId] of [
                        [false, false, undefined],
                        [true, false, undefined],
                        [false, true, undefined],
                        [true, true, "unit"],
                    ] as const) {
                        expect(
                            grid.canOccupyFootprintAt(anchor, width, height, canOccupyLava, canOccupyWater, ownUnitId),
                        ).toBe(grid.canOccupyCells(cells, canOccupyLava, canOccupyWater, ownUnitId));
                    }
                }
            }
        }
    });

    it("a 1x2 occupies both its cells, slides over its own footprint and vacates cleanly", () => {
        const grid = newGrid();
        const cells = getFootprintCellsForAnchor({ x: 5, y: 6 }, 1, 2);

        expect(grid.canOccupyCells(cells, false, false)).toBe(true);
        expect(grid.occupyCells(cells, "tall", TEAM, ATTACK_RANGE, false, false)).toBe(true);
        expect(grid.getOccupantUnitId({ x: 5, y: 6 })).toBe("tall");
        expect(grid.getOccupantUnitId({ x: 5, y: 5 })).toBe("tall");
        expect(grid.getRegisteredCells("tall")).toEqual(cells);

        // The body blocks a stranger on either cell, but may shear over itself by one cell.
        expect(grid.canOccupyCells([{ x: 5, y: 5 }], false, false)).toBe(false);
        const slid = getFootprintCellsForAnchor({ x: 5, y: 7 }, 1, 2);
        expect(grid.canOccupyCells(slid, false, false)).toBe(false);
        expect(grid.canOccupyCells(slid, false, false, "tall")).toBe(true);

        expect(grid.occupyCells(slid, "tall", TEAM, ATTACK_RANGE, false, false)).toBe(true);
        expect(Boolean(grid.getOccupantUnitId({ x: 5, y: 5 }))).toBe(false);
        expect(grid.getOccupantUnitId({ x: 5, y: 6 })).toBe("tall");
        expect(grid.getOccupantUnitId({ x: 5, y: 7 })).toBe("tall");
        expect([...threatenedCells(grid.getAggrMatrixByTeam(TEAM)!).keys()].sort()).toEqual(expectedRing(slid));

        grid.cleanupAll("tall", ATTACK_RANGE, false);
        expect(grid.getRegisteredCells("tall")).toEqual([]);
        expect(Boolean(grid.getOccupantUnitId({ x: 5, y: 7 }))).toBe(false);
        expect(Boolean(grid.getOccupantUnitId({ x: 5, y: 6 }))).toBe(false);
        expectBaselineEverywhere(grid.getAggrMatrixByTeam(TEAM)!, "1x2 after cleanupAll");
    });

    it("a 2x1 occupies both its cells, slides over its own footprint and vacates cleanly", () => {
        const grid = newGrid();
        const cells = getFootprintCellsForAnchor({ x: 6, y: 9 }, 2, 1);

        expect(grid.occupyCells(cells, "wide", TEAM, ATTACK_RANGE, false, false)).toBe(true);
        expect(grid.getOccupantUnitId({ x: 6, y: 9 })).toBe("wide");
        expect(grid.getOccupantUnitId({ x: 5, y: 9 })).toBe("wide");

        const slid = getFootprintCellsForAnchor({ x: 7, y: 9 }, 2, 1);
        expect(grid.canOccupyCells(slid, false, false, "wide")).toBe(true);
        expect(grid.occupyCells(slid, "wide", TEAM, ATTACK_RANGE, false, false)).toBe(true);
        expect(Boolean(grid.getOccupantUnitId({ x: 5, y: 9 }))).toBe(false);
        expect([...threatenedCells(grid.getAggrMatrixByTeam(TEAM)!).keys()].sort()).toEqual(expectedRing(slid));

        grid.cleanupAll("wide", ATTACK_RANGE, false);
        expectBaselineEverywhere(grid.getAggrMatrixByTeam(TEAM)!, "2x1 after cleanupAll");
    });

    it("occupyCells still refuses a footprint that leaves the board or changes size under the unit", () => {
        const grid = newGrid();
        const cells = getFootprintCellsForAnchor({ x: 5, y: 6 }, 1, 2);
        expect(grid.occupyCells(cells, "tall", TEAM, ATTACK_RANGE, false, false)).toBe(true);

        expect(grid.occupyCells(getFootprintCellsForAnchor({ x: 5, y: 8 }, 1, 3), "tall", TEAM, 1, false, false)).toBe(
            false,
        );
        expect(grid.occupyCells(getFootprintCellsForAnchor({ x: 0, y: 3 }, 2, 1), "edge", TEAM, 1, false, false)).toBe(
            false,
        );
        expect(grid.canOccupyCells([], false, false)).toBe(false);
        expect(grid.canOccupyCells(getFootprintCellsForAnchor({ x: 0, y: 3 }, 2, 1), false, false)).toBe(false);
        // The registration the refusals left behind is still the original one, untouched.
        expect(grid.getRegisteredCells("tall")).toEqual(cells);
    });

    it("accepts a WxH rectangle wider than the two shipped shapes", () => {
        const grid = newGrid();
        const cells = getFootprintCellsForAnchor({ x: 9, y: 4 }, 3, 2);

        expect(grid.canOccupyCells(cells, false, false)).toBe(true);
        expect(grid.occupyCells(cells, "hexa", TEAM, ATTACK_RANGE, false, false)).toBe(true);
        for (const cell of cells) {
            expect(grid.getOccupantUnitId(cell)).toBe("hexa");
        }
        expect([...threatenedCells(grid.getAggrMatrixByTeam(TEAM)!).keys()].sort()).toEqual(expectedRing(cells));
    });
});

describe("footprint occupancy — the aggro ring of every shape, edges included", () => {
    // The rectangles are the regression: the guard the corner masks sat behind is FALSE for a body one cell
    // wide in either axis, so a 1x2 or 2x1 used to leave the board at baseline and the AI pathed straight
    // through its zone of control.
    const placements: [string, number, number, XY][] = [
        ["1x1 mid-board", 1, 1, { x: 8, y: 8 }],
        ["1x1 corner", 1, 1, { x: 0, y: 0 }],
        ["1x1 far corner", 1, 1, { x: 15, y: 15 }],
        ["2x2 mid-board", 2, 2, { x: 8, y: 8 }],
        ["2x2 bottom-left corner", 2, 2, { x: 1, y: 1 }],
        ["2x2 top-right corner", 2, 2, { x: 15, y: 15 }],
        ["1x2 mid-board", 1, 2, { x: 8, y: 8 }],
        ["1x2 on the left edge", 1, 2, { x: 0, y: 5 }],
        ["1x2 in the bottom-left corner", 1, 2, { x: 0, y: 1 }],
        ["1x2 against the top edge", 1, 2, { x: 7, y: 15 }],
        ["2x1 mid-board", 2, 1, { x: 8, y: 8 }],
        ["2x1 on the bottom edge", 2, 1, { x: 5, y: 0 }],
        ["2x1 in the top-right corner", 2, 1, { x: 15, y: 15 }],
        ["2x1 against the right edge", 2, 1, { x: 15, y: 7 }],
    ];

    for (const [label, width, height, anchor] of placements) {
        it(`threatens exactly the ring around a ${label}`, () => {
            const cells = getFootprintCellsForAnchor(anchor, width, height);
            const grid = newGrid();
            expect(grid.occupyCells(cells, "unit", TEAM, ATTACK_RANGE, false, false)).toBe(true);

            const threatened = threatenedCells(grid.getAggrMatrixByTeam(TEAM)!);
            expect([...threatened.keys()].sort()).toEqual(expectedRing(cells));
            // Every ring cell is threatened exactly once — an overlapping stamp would read as a second unit.
            for (const value of threatened.values()) {
                expect(value).toBe(BASELINE + 1);
            }

            grid.cleanupAll("unit", ATTACK_RANGE, width === 1 && height === 1);
            expectBaselineEverywhere(grid.getAggrMatrixByTeam(TEAM)!, `${label} after cleanupAll`);
        });
    }
});
