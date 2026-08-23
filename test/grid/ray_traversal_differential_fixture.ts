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

export const RAY_TRAVERSAL_DIFFERENTIAL_SHARD_COUNT = 8;

export const RAY_TRAVERSAL_DIFFERENTIAL_SHARD_CENSUSES = [
    { origins: 61, legalShotCases: 124_928, uniqueLegalRays: 60_472, centerCases: 15_616 },
    { origins: 60, legalShotCases: 122_880, uniqueLegalRays: 59_626, centerCases: 15_360 },
    { origins: 60, legalShotCases: 122_880, uniqueLegalRays: 59_702, centerCases: 15_360 },
    { origins: 60, legalShotCases: 122_880, uniqueLegalRays: 59_707, centerCases: 15_360 },
    { origins: 60, legalShotCases: 122_880, uniqueLegalRays: 59_816, centerCases: 15_360 },
    { origins: 60, legalShotCases: 122_880, uniqueLegalRays: 59_843, centerCases: 15_360 },
    { origins: 60, legalShotCases: 122_880, uniqueLegalRays: 59_888, centerCases: 15_360 },
    { origins: 60, legalShotCases: 122_880, uniqueLegalRays: 59_868, centerCases: 15_360 },
] as const;

export const GS = testGridSettings;

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

/**
 * The oracle walk again, but comparing as it goes instead of materialising the expected trace.
 *
 * The exhaustive cases run this ~600k times, and building an array of {cell, position} tuples per ray —
 * two allocations per PIXEL stepped, plus a linear `includes` over the visited keys — cost more than the
 * function under test by a wide margin. Same walk, same `(x << 4) | y` key (so identical collision
 * behaviour for off-board cells), one scratch object, and a reused Set lookup.
 *
 * Returns false on the first divergence; the caller rebuilds the full expected trace only to print a diff.
 */
const oracleScratch = { x: 0, y: 0 };
const oracleSeen = new Set<number>();
function legacyTraceMatches(
    gridSettings: GridSettings,
    start: XY,
    end: XY,
    actual: GridRayCellIntersection[],
): boolean {
    oracleSeen.clear();
    let matched = 0;
    let x0 = Math.round(start.x);
    let y0 = Math.round(start.y);
    const x1 = Math.round(end.x);
    const y1 = Math.round(end.y);
    const deltaX = Math.abs(x1 - x0);
    const deltaY = Math.abs(y1 - y0);
    const directionX = x0 < x1 ? 1 : -1;
    const directionY = y0 < y1 ? 1 : -1;
    let error = deltaX - deltaY;

    for (;;) {
        oracleScratch.x = x0;
        oracleScratch.y = y0;
        const cell = getCellForPosition(gridSettings, oracleScratch);
        const cellKey = (cell.x << 4) | cell.y;
        if (!oracleSeen.has(cellKey)) {
            oracleSeen.add(cellKey);
            const entry = actual[matched];
            if (
                entry === undefined ||
                entry[0].x !== cell.x ||
                entry[0].y !== cell.y ||
                entry[1].x !== x0 ||
                entry[1].y !== y0
            ) {
                return false;
            }
            matched += 1;
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

    return matched === actual.length;
}

export function assertLegacyEquivalent(start: XY, end: XY, gridSettings = GS): void {
    const actual = traceGridRayCells(gridSettings, start, end);
    if (!legacyTraceMatches(gridSettings, start, end, actual)) {
        // Only now is the array oracle worth building — it gives the assertion a readable diff.
        expect(actual).toEqual(legacyPixelTrace(gridSettings, start, end));
    }
}

export const cellCenter = (cell: XY): XY => getPositionForCell(cell, GS.getMinX(), GS.getStep(), GS.getHalfStep());

function forEachOriginInShard(shardIndex: number, visit: (start: XY) => void): number {
    let originIndex = 0;
    let origins = 0;
    const visitIfOwned = (start: XY): void => {
        if (originIndex % RAY_TRAVERSAL_DIFFERENTIAL_SHARD_COUNT === shardIndex) {
            visit(start);
            origins += 1;
        }
        originIndex += 1;
    };

    for (let attackerX = 0; attackerX < GS.getGridSize(); attackerX += 1) {
        for (let attackerY = 0; attackerY < GS.getGridSize(); attackerY += 1) {
            visitIfOwned(cellCenter({ x: attackerX, y: attackerY }));
        }
    }
    for (let attackerX = 1; attackerX < GS.getGridSize(); attackerX += 1) {
        for (let attackerY = 1; attackerY < GS.getGridSize(); attackerY += 1) {
            // Large-unit world positions lie on the vertex shared by their four occupied cells.
            visitIfOwned(cellCenter({ x: attackerX - 0.5, y: attackerY - 0.5 }));
        }
    }

    return origins;
}

function runLegalShotDifferentialShard(shardIndex: number): {
    origins: number;
    legalShotCases: number;
    uniqueLegalRays: number;
} {
    const sideValues = [
        RangeAttackCellSide.LEFT,
        RangeAttackCellSide.RIGHT,
        RangeAttackCellSide.DOWN,
        RangeAttackCellSide.UP,
    ];
    let legalShotCases = 0;
    let uniqueLegalRays = 0;
    const origins = forEachOriginInShard(shardIndex, (start) => {
        // Adjacent target cells share the same physical edge, so their LEFT/RIGHT or UP/DOWN entries
        // produce the exact same rounded ray. Keep enumerating every legal cell+side case (and retain the
        // exact census below), but run the differential oracle once per distinct production input.
        const checkedEndpoints = new Set<string>();
        const assertUniqueRay = (end: XY): void => {
            const key = `${Math.round(end.x)},${Math.round(end.y)}`;
            if (checkedEndpoints.has(key)) return;
            checkedEndpoints.add(key);
            uniqueLegalRays += 1;
            assertLegacyEquivalent(start, end);
        };
        for (let targetX = 0; targetX < GS.getGridSize(); targetX += 1) {
            for (let targetY = 0; targetY < GS.getGridSize(); targetY += 1) {
                const targetCell = { x: targetX, y: targetY };
                for (const side of sideValues) {
                    const end = getRangeAttackSideCenter(GS, targetCell, side, start);
                    assertUniqueRay(end);
                    assertUniqueRay(projectLineToFieldEdge(GS, start.x, start.y, end.x, end.y));
                    legalShotCases += 2;
                }
            }
        }
    });

    return { origins, legalShotCases, uniqueLegalRays };
}

function runCenterDifferentialShard(shardIndex: number): { origins: number; centerCases: number } {
    let centerCases = 0;
    const origins = forEachOriginInShard(shardIndex, (start) => {
        for (let targetX = 0; targetX < GS.getGridSize(); targetX += 1) {
            for (let targetY = 0; targetY < GS.getGridSize(); targetY += 1) {
                assertLegacyEquivalent(start, cellCenter({ x: targetX, y: targetY }));
                centerCases += 1;
            }
        }
    });

    return { origins, centerCases };
}

export function registerRayTraversalDifferentialShard(shardIndex: number): void {
    const expected = RAY_TRAVERSAL_DIFFERENTIAL_SHARD_CENSUSES[shardIndex];
    if (!expected) throw new Error(`Unknown ray-traversal differential shard ${shardIndex}`);

    describe("traceGridRayCells exhaustive differential", () => {
        it(`matches every legal shot side and projected through-shot trajectory in shard ${shardIndex + 1}`, () => {
            expect(runLegalShotDifferentialShard(shardIndex)).toEqual({
                origins: expected.origins,
                legalShotCases: expected.legalShotCases,
                uniqueLegalRays: expected.uniqueLegalRays,
            });
        }, 60_000);

        it(`matches small and large attacker centers to every target center in shard ${shardIndex + 1}`, () => {
            expect(runCenterDifferentialShard(shardIndex)).toEqual({
                origins: expected.origins,
                centerCases: expected.centerCases,
            });
        }, 60_000);
    });
}
