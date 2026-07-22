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

import {
    getCellForPosition,
    getPositionForCell,
    getRangeAttackSideCenter,
    projectLineToFieldEdge,
    RangeAttackCellSide,
} from "../../src/grid/grid_math";
import { traceGridRayCells, type GridRayCellIntersection } from "../../src/grid/ray_traversal";
import { GridSettings } from "../../src/grid/grid_settings";
import type { XY } from "../../src/utils/math";
import { testGridSettings } from "../helpers/combat";

const GS = testGridSettings;

/** The removed pixel-by-pixel production implementation, retained here only as a differential oracle. */
function legacyPixelTrace(gridSettings: GridSettings, start: XY, end: XY): GridRayCellIntersection[] {
    const intersections: GridRayCellIntersection[] = [];
    const cellKeys: number[] = [];
    let x0 = Math.round(start.x);
    let y0 = Math.round(start.y);
    const x1 = Math.round(end.x);
    const y1 = Math.round(end.y);
    const deltaX = Math.abs(x1 - x0);
    const deltaY = Math.abs(y1 - y0);
    const directionX = x0 < x1 ? 1 : -1;
    const directionY = y0 < y1 ? 1 : -1;
    let error = deltaX - deltaY;

    while (true) {
        const position = { x: x0, y: y0 };
        const cell = getCellForPosition(gridSettings, position);
        const cellKey = (cell.x << 4) | cell.y;
        if (!cellKeys.includes(cellKey)) {
            intersections.push([cell, position]);
            cellKeys.push(cellKey);
        }
        if (x0 === x1 && y0 === y1) {
            break;
        }
        const doubledError = 2 * error;
        if (doubledError > -deltaY) {
            error -= deltaY;
            x0 += directionX;
        }
        if (doubledError < deltaX) {
            error += deltaX;
            y0 += directionY;
        }
    }

    return intersections;
}

function assertLegacyEquivalent(start: XY, end: XY, gridSettings = GS): void {
    const expected = legacyPixelTrace(gridSettings, start, end);
    const actual = traceGridRayCells(gridSettings, start, end);
    if (
        actual.length !== expected.length ||
        actual.some(
            ([cell, position], index) =>
                cell.x !== expected[index][0].x ||
                cell.y !== expected[index][0].y ||
                position.x !== expected[index][1].x ||
                position.y !== expected[index][1].y,
        )
    ) {
        expect(actual).toEqual(expected);
    }
}

const cellCenter = (cell: XY): XY => getPositionForCell(cell, GS.getMinX(), GS.getStep(), GS.getHalfStep());

describe("traceGridRayCells", () => {
    it("preserves corner ties without adding strict-supercover side cells", () => {
        const intersections = traceGridRayCells(GS, cellCenter({ x: 0, y: 0 }), cellCenter({ x: 3, y: 3 }));
        expect(intersections.map(([cell]) => cell)).toEqual([
            { x: 0, y: 0 },
            { x: 1, y: 1 },
            { x: 2, y: 2 },
            { x: 3, y: 3 },
        ]);
    });

    it("preserves the directional first-pixel asymmetry at cell boundaries", () => {
        const left = cellCenter({ x: 0, y: 4 });
        const right = cellCenter({ x: 3, y: 4 });
        const forward = traceGridRayCells(GS, left, right);
        const reverse = traceGridRayCells(GS, right, left);
        expect(forward[1]).toEqual([
            { x: 1, y: 4 },
            { x: -896, y: 576 },
        ]);
        expect(reverse[1]).toEqual([
            { x: 2, y: 4 },
            { x: -641, y: 576 },
        ]);
    });

    it("preserves the first raster pixel on an exact range-falloff boundary", () => {
        const start = cellCenter({ x: 0, y: 0 });
        const end = getRangeAttackSideCenter(GS, { x: 1, y: 5 }, RangeAttackCellSide.LEFT, start);
        const entry = traceGridRayCells(GS, start, end).find(([cell]) => cell.x === 1 && cell.y === 5);
        expect(entry).toEqual([
            { x: 1, y: 5 },
            { x: -896, y: 700 },
        ]);

        const legacyEntryDistance = Math.hypot(entry![1].x - start.x, entry![1].y - start.y);
        const geometricEntryDistance = Math.hypot(end.x - start.x, end.y - start.y);
        expect(legacyEntryDistance).toBeLessThan(5 * GS.getStep());
        expect(geometricEntryDistance).toBeGreaterThanOrEqual(5 * GS.getStep());
        assertLegacyEquivalent(start, end);
    });

    it("handles zero-length, rounded fractional, boundary, and malformed rays", () => {
        const point = { x: -895.6, y: 64.4 };
        expect(traceGridRayCells(GS, point, point)).toEqual([
            [
                { x: 1, y: 0 },
                { x: -896, y: 64 },
            ],
        ]);
        assertLegacyEquivalent({ x: -2048, y: 0 }, { x: 2048, y: 2048 });
        assertLegacyEquivalent({ x: 2048, y: 2048 }, { x: -2048, y: 0 });
        expect(traceGridRayCells(GS, { x: Number.NaN, y: 0 }, { x: 0, y: 0 })).toEqual([]);
        expect(traceGridRayCells(GS, { x: 0, y: 0 }, { x: Infinity, y: 0 })).toEqual([]);
    });

    it("exhaustively matches every legal shot side and projected through-shot trajectory", () => {
        const sideValues = [
            RangeAttackCellSide.LEFT,
            RangeAttackCellSide.RIGHT,
            RangeAttackCellSide.DOWN,
            RangeAttackCellSide.UP,
        ];
        let cases = 0;
        for (let attackerX = 0; attackerX < GS.getGridSize(); attackerX += 1) {
            for (let attackerY = 0; attackerY < GS.getGridSize(); attackerY += 1) {
                const start = cellCenter({ x: attackerX, y: attackerY });
                for (let targetX = 0; targetX < GS.getGridSize(); targetX += 1) {
                    for (let targetY = 0; targetY < GS.getGridSize(); targetY += 1) {
                        const targetCell = { x: targetX, y: targetY };
                        for (const side of sideValues) {
                            const end = getRangeAttackSideCenter(GS, targetCell, side, start);
                            assertLegacyEquivalent(start, end);
                            assertLegacyEquivalent(start, projectLineToFieldEdge(GS, start.x, start.y, end.x, end.y));
                            cases += 2;
                        }
                    }
                }
            }
        }
        for (let attackerX = 1; attackerX < GS.getGridSize(); attackerX += 1) {
            for (let attackerY = 1; attackerY < GS.getGridSize(); attackerY += 1) {
                const start = cellCenter({ x: attackerX - 0.5, y: attackerY - 0.5 });
                for (let targetX = 0; targetX < GS.getGridSize(); targetX += 1) {
                    for (let targetY = 0; targetY < GS.getGridSize(); targetY += 1) {
                        const targetCell = { x: targetX, y: targetY };
                        for (const side of sideValues) {
                            const end = getRangeAttackSideCenter(GS, targetCell, side, start);
                            assertLegacyEquivalent(start, end);
                            assertLegacyEquivalent(start, projectLineToFieldEdge(GS, start.x, start.y, end.x, end.y));
                            cases += 2;
                        }
                    }
                }
            }
        }
        expect(cases).toBe(985_088);
    }, 60_000);

    it("preserves the legacy large-unit corner alias cell", () => {
        const sideValues = [
            RangeAttackCellSide.LEFT,
            RangeAttackCellSide.RIGHT,
            RangeAttackCellSide.DOWN,
            RangeAttackCellSide.UP,
        ];
        const start = cellCenter({ x: 0.5, y: 0.5 });
        const end = getRangeAttackSideCenter(GS, { x: 2, y: 6 }, sideValues[3], start);
        const cells = traceGridRayCells(GS, start, end).map(([cell]) => cell);
        expect(cells).toContainEqual({ x: 2, y: 4 });
        assertLegacyEquivalent(start, end);
    });

    it("exhaustively matches small and large attacker centers to every target center", () => {
        let cases = 0;
        for (let attackerX = 0; attackerX < GS.getGridSize(); attackerX += 1) {
            for (let attackerY = 0; attackerY < GS.getGridSize(); attackerY += 1) {
                const start = cellCenter({ x: attackerX, y: attackerY });
                for (let targetX = 0; targetX < GS.getGridSize(); targetX += 1) {
                    for (let targetY = 0; targetY < GS.getGridSize(); targetY += 1) {
                        assertLegacyEquivalent(start, cellCenter({ x: targetX, y: targetY }));
                        cases += 1;
                    }
                }
            }
        }
        for (let attackerX = 1; attackerX < GS.getGridSize(); attackerX += 1) {
            for (let attackerY = 1; attackerY < GS.getGridSize(); attackerY += 1) {
                // Large-unit world positions lie on the vertex shared by their four occupied cells.
                const start = cellCenter({ x: attackerX - 0.5, y: attackerY - 0.5 });
                for (let targetX = 0; targetX < GS.getGridSize(); targetX += 1) {
                    for (let targetY = 0; targetY < GS.getGridSize(); targetY += 1) {
                        assertLegacyEquivalent(start, cellCenter({ x: targetX, y: targetY }));
                        cases += 1;
                    }
                }
            }
        }
        expect(cases).toBe(123_136);
    });

    it("preserves the legacy packed-key collision outside the legal grid", () => {
        const actual = traceGridRayCells(GS, { x: -960, y: 2112 }, { x: -832, y: 64 });
        expect(actual).toEqual([
            [
                { x: 0, y: 16 },
                { x: -960, y: 2112 },
            ],
            [
                { x: 0, y: 15 },
                { x: -956, y: 2047 },
            ],
            [
                { x: 0, y: 14 },
                { x: -948, y: 1919 },
            ],
            [
                { x: 0, y: 13 },
                { x: -940, y: 1791 },
            ],
            [
                { x: 0, y: 12 },
                { x: -932, y: 1663 },
            ],
            [
                { x: 0, y: 11 },
                { x: -924, y: 1535 },
            ],
            [
                { x: 0, y: 10 },
                { x: -916, y: 1407 },
            ],
            [
                { x: 0, y: 9 },
                { x: -908, y: 1279 },
            ],
            [
                { x: 0, y: 8 },
                { x: -900, y: 1151 },
            ],
            [
                { x: 1, y: 8 },
                { x: -896, y: 1095 },
            ],
            [
                { x: 1, y: 7 },
                { x: -892, y: 1023 },
            ],
            [
                { x: 1, y: 6 },
                { x: -884, y: 895 },
            ],
            [
                { x: 1, y: 5 },
                { x: -876, y: 767 },
            ],
            [
                { x: 1, y: 4 },
                { x: -868, y: 639 },
            ],
            [
                { x: 1, y: 3 },
                { x: -860, y: 511 },
            ],
            [
                { x: 1, y: 2 },
                { x: -852, y: 383 },
            ],
            [
                { x: 1, y: 1 },
                { x: -844, y: 255 },
            ],
        ]);
        expect(actual.some(([cell]) => cell.x === 1 && cell.y === 0)).toBe(false);
        assertLegacyEquivalent({ x: -960, y: 2112 }, { x: -832, y: 64 });
    });

    it("matches the legacy raster for seeded fractional and out-of-grid endpoints", () => {
        let randomState = 0x51deca11;
        const random = (): number => {
            randomState = (Math.imul(randomState, 1_103_515_245) + 12_345) >>> 0;
            return randomState / 2 ** 32;
        };
        const cases = 10_000;
        for (let index = 0; index < cases; index += 1) {
            const start = {
                x: GS.getMinX() - GS.getStep() + random() * (GS.getMaxX() * 2 + GS.getStep() * 2),
                y: GS.getMinY() - GS.getStep() + random() * (GS.getMaxY() + GS.getStep() * 2),
            };
            const end = {
                x: GS.getMinX() - GS.getStep() + random() * (GS.getMaxX() * 2 + GS.getStep() * 2),
                y: GS.getMinY() - GS.getStep() + random() * (GS.getMaxY() + GS.getStep() * 2),
            };
            assertLegacyEquivalent(start, end);
        }
        expect(cases).toBe(10_000);
    });

    it("matches the legacy raster on seeded fractional custom-grid configurations", () => {
        const settings = [
            new GridSettings(7, 1_000, -50, 500, -500, 1, 1),
            new GridSettings(17, 1_000, 10, 500, -500, 1, 1),
            new GridSettings(16, 2_047, 0, 1_023.5, -1_023.5, 1, 1),
            new GridSettings(31, 997, -300, 498.5, -498.5, 1, 1),
        ];
        let randomState = 0xc311da7a;
        const random = (): number => {
            randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
            return randomState / 2 ** 32;
        };
        let cases = 0;

        for (const gridSettings of settings) {
            const cellSize = gridSettings.getCellSize();
            const minX = -gridSettings.getMaxX() - cellSize;
            const width = gridSettings.getMaxX() * 2 + cellSize * 2;
            const minY = -cellSize;
            const height = gridSettings.getMaxY() + cellSize * 2;
            for (let index = 0; index < 2_500; index += 1) {
                const start = { x: minX + random() * width, y: minY + random() * height };
                const end = { x: minX + random() * width, y: minY + random() * height };
                assertLegacyEquivalent(start, end, gridSettings);
                cases += 1;
            }
        }

        expect(cases).toBe(10_000);
    });
});
