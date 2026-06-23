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

import { ObstacleType } from "../../src/obstacles/obstacle_type";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import {
    adjustClosestPointSideCenterPoint,
    arePointsConnected,
    getCellForPosition,
    getCellsAroundCell,
    getCellsAroundPosition,
    getClosestCrossingPoint,
    getClosestSideCenter,
    getClosestVH,
    getCrossingPoints,
    getDistanceToFurthestCorner,
    getLargeUnitAttackCells,
    getPositionForCell,
    getPositionForCells,
    getRandomGridCellAroundPosition,
    hasXY,
    isCellWithinGrid,
    isPositionWithinGrid,
    projectLineToFieldEdge,
} from "../../src/grid/grid_math";
import type { IWeightedRoute } from "../../src/grid/path_definitions";
import { testGridSettings } from "../helpers/combat";

describe("grid_math", () => {
    it("converts between cells and positions and validates grid bounds", () => {
        const position = getPositionForCell(
            { x: 3, y: 4 },
            testGridSettings.getMinX(),
            testGridSettings.getStep(),
            testGridSettings.getHalfStep(),
        );

        expect(getCellForPosition(testGridSettings, position)).toEqual({ x: 3, y: 4 });
        expect(isPositionWithinGrid(testGridSettings, position)).toBe(true);
        expect(isPositionWithinGrid(testGridSettings, { x: testGridSettings.getMaxX(), y: position.y })).toBe(false);
        expect(isCellWithinGrid(testGridSettings, { x: 15, y: 15 })).toBe(true);
        expect(isCellWithinGrid(testGridSettings, { x: 16, y: 15 })).toBe(false);
        expect(
            hasXY({ x: 3, y: 4 }, [
                { x: 1, y: 2 },
                { x: 3, y: 4 },
            ]),
        ).toBe(true);
        expect(hasXY({ x: 0, y: 0 })).toBe(false);
        expect(isPositionWithinGrid(testGridSettings, undefined as unknown as { x: number; y: number })).toBe(false);
    });

    it("finds cells around positions, cells, and multi-cell bodies", () => {
        const center = getPositionForCell(
            { x: 5, y: 5 },
            testGridSettings.getMinX(),
            testGridSettings.getStep(),
            testGridSettings.getHalfStep(),
        );

        expect(getCellsAroundPosition(testGridSettings, center)).toEqual([
            { x: 5, y: 6 },
            { x: 6, y: 6 },
            { x: 5, y: 5 },
            { x: 6, y: 5 },
        ]);
        expect(getCellsAroundPosition(testGridSettings, { x: testGridSettings.getMinX(), y: 0 })).toEqual([
            { x: 0, y: 0 },
        ]);
        expect(getCellsAroundCell(testGridSettings, { x: 5, y: 5 })).toHaveLength(8);
        expect(getCellsAroundCell(testGridSettings, undefined as unknown as { x: number; y: number })).toEqual([]);
        expect(getCellsAroundPosition(testGridSettings, undefined as unknown as { x: number; y: number })).toEqual([]);
        expect(getPositionForCells(testGridSettings, [{ x: 5, y: 5 }])).toEqual(center);
        expect(
            getPositionForCells(testGridSettings, [
                { x: 5, y: 5 },
                { x: 6, y: 5 },
                { x: 5, y: 6 },
                { x: 6, y: 6 },
            ]),
        ).toEqual({ x: -256, y: 768 });
        expect(getPositionForCells(testGridSettings, [])).toBeUndefined();
    });

    it("projects lines and calculates crossing helpers", () => {
        expect(projectLineToFieldEdge(testGridSettings, 0, 0, 100, 0)).toEqual({
            x: testGridSettings.getMaxX(),
            y: 0,
        });
        expect(projectLineToFieldEdge(testGridSettings, 0, 0, 0, 100)).toEqual({
            x: 0,
            y: testGridSettings.getMaxY(),
        });
        expect(
            getClosestCrossingPoint({ x: 0, y: 0 }, [
                { x: 10, y: 0 },
                { x: 3, y: 4 },
            ]),
        ).toEqual({ x: 3, y: 4 });
        const vh = getClosestVH(testGridSettings, { x: 0, y: 0 }, { x: 256, y: 256 });
        expect(vh).toHaveLength(4);
        expect(getCrossingPoints({ x: 0, y: 0 }, { x: 256, y: 256 }, vh)).toHaveLength(2);
        const reverseVh = getClosestVH(testGridSettings, { x: 512, y: 512 }, { x: 0, y: 0 });
        expect(reverseVh).toContainEqual({ x: 384, y: testGridSettings.getMinY() });
        expect(reverseVh).toContainEqual({ x: testGridSettings.getMinX(), y: 384 });
        expect(adjustClosestPointSideCenterPoint({ x: 1, y: 1 }, { x: 2, y: 2 })).toEqual({ x: 0, y: 0 });
        expect(getDistanceToFurthestCorner({ x: 0, y: 0 }, testGridSettings)).toBeGreaterThan(0);
    });

    it("finds random adjacent cells only within the grid", () => {
        const matrix = emptyMatrix();
        const lowerCell = getRandomGridCellAroundPosition(
            testGridSettings,
            matrix,
            PBTypes.TeamVals.LOWER,
            getPositionForCell(
                { x: 5, y: 5 },
                testGridSettings.getMinX(),
                testGridSettings.getStep(),
                testGridSettings.getHalfStep(),
            ),
        );
        const upperCell = getRandomGridCellAroundPosition(
            testGridSettings,
            matrix,
            PBTypes.TeamVals.UPPER,
            getPositionForCell(
                { x: 5, y: 5 },
                testGridSettings.getMinX(),
                testGridSettings.getStep(),
                testGridSettings.getHalfStep(),
            ),
        );

        expect(lowerCell?.y).toBe(6);
        expect(upperCell?.y).toBe(4);

        matrix[5][6] = 1;
        matrix[4][6] = 1;
        matrix[6][6] = 1;
        const fallback = getRandomGridCellAroundPosition(
            testGridSettings,
            matrix,
            PBTypes.TeamVals.LOWER,
            getPositionForCell(
                { x: 5, y: 5 },
                testGridSettings.getMinX(),
                testGridSettings.getStep(),
                testGridSettings.getHalfStep(),
            ),
        );
        expect(fallback).toBeDefined();
        expect(isCellWithinGrid(testGridSettings, fallback!)).toBe(true);
    });

    it("uses side preferences and fallback cells for random adjacent cell selection", () => {
        withCryptoWords([0, 1, 0, 1], () => {
            const matrix = emptyMatrix();
            const center = getPositionForCell(
                { x: 5, y: 5 },
                testGridSettings.getMinX(),
                testGridSettings.getStep(),
                testGridSettings.getHalfStep(),
            );

            expect(getRandomGridCellAroundPosition(testGridSettings, matrix, PBTypes.TeamVals.LOWER, center)).toEqual({
                x: 5,
                y: 6,
            });
            expect(getRandomGridCellAroundPosition(testGridSettings, matrix, PBTypes.TeamVals.UPPER, center)).toEqual({
                x: 5,
                y: 4,
            });
        });

        withCryptoWords(
            Array.from({ length: 32 }, () => 0),
            () => {
                const matrix = emptyMatrix();
                const center = getPositionForCell(
                    { x: 5, y: 5 },
                    testGridSettings.getMinX(),
                    testGridSettings.getStep(),
                    testGridSettings.getHalfStep(),
                );
                const onlyOpenFallbackCell = { x: 4, y: 5 };
                for (const cell of [
                    { x: 6, y: 6 },
                    { x: 4, y: 4 },
                    { x: 4, y: 6 },
                    { x: 6, y: 4 },
                    { x: 6, y: 5 },
                    { x: 5, y: 6 },
                    { x: 5, y: 4 },
                ]) {
                    matrix[cell.y][cell.x] = 1;
                }

                expect(
                    getRandomGridCellAroundPosition(testGridSettings, matrix, PBTypes.TeamVals.LOWER, center),
                ).toEqual(onlyOpenFallbackCell);
            },
        );
    });

    it("filters large unit attack cells by path availability and enemy overlap", () => {
        const { knownPaths, pathHashes } = fullKnownPaths();

        const attackCells = getLargeUnitAttackCells(
            testGridSettings,
            { x: 2, y: 2 },
            { x: 2, y: 2 },
            { x: 4, y: 4 },
            knownPaths,
            pathHashes,
        );

        expect(attackCells).toContainEqual({ x: 2, y: 2 });
        expect(getLargeUnitAttackCells(testGridSettings, { x: 2, y: 2 }, { x: 2, y: 2 }, { x: 4, y: 4 })).toEqual([]);
        expect(
            getLargeUnitAttackCells(
                testGridSettings,
                { x: 2, y: 2 },
                { x: 9, y: 9 },
                { x: 4, y: 4 },
                new Map(),
                pathHashes,
            ),
        ).toEqual([]);
        expect(
            getLargeUnitAttackCells(
                testGridSettings,
                { x: 2, y: 2 },
                { x: 2, y: 2 },
                { x: 2, y: 2 },
                knownPaths,
                pathHashes,
            ),
        ).not.toContainEqual({ x: 2, y: 2 });
    });

    it("returns large-unit attack cells for every relative direction", () => {
        const { knownPaths, pathHashes } = fullKnownPaths();

        const cases = [
            [
                { x: 3, y: 3 },
                { x: 5, y: 5 },
            ],
            [
                { x: 5, y: 5 },
                { x: 3, y: 3 },
            ],
            [
                { x: 3, y: 5 },
                { x: 5, y: 3 },
            ],
            [
                { x: 5, y: 3 },
                { x: 3, y: 5 },
            ],
            [
                { x: 3, y: 5 },
                { x: 5, y: 5 },
            ],
            [
                { x: 5, y: 7 },
                { x: 5, y: 5 },
            ],
            [
                { x: 5, y: 3 },
                { x: 5, y: 5 },
            ],
            [
                { x: 7, y: 5 },
                { x: 5, y: 5 },
            ],
        ];

        for (const [attackFromCell, enemyCell] of cases) {
            expect(
                getLargeUnitAttackCells(
                    testGridSettings,
                    attackFromCell,
                    attackFromCell,
                    enemyCell,
                    knownPaths,
                    pathHashes,
                ).length,
            ).toBeGreaterThan(0);
        }
    });

    it("detects connected points and closest observable side centers", () => {
        expect(arePointsConnected(testGridSettings, { x: 0, y: 0 }, { x: 0, y: testGridSettings.getStep() })).toBe(
            true,
        );
        expect(arePointsConnected(testGridSettings, { x: 0, y: 0 }, { x: testGridSettings.getStep(), y: 0 })).toBe(
            true,
        );
        expect(
            arePointsConnected(
                testGridSettings,
                { x: 0, y: 0 },
                { x: testGridSettings.getStep(), y: testGridSettings.getStep() },
            ),
        ).toBe(true);
        expect(arePointsConnected(testGridSettings, { x: 0, y: 0 }, { x: 2048, y: 2048 })).toBe(false);

        const matrix = emptyMatrix();
        const fromPosition = getPositionForCell(
            { x: 1, y: 1 },
            testGridSettings.getMinX(),
            testGridSettings.getStep(),
            testGridSettings.getHalfStep(),
        );
        const toPosition = getPositionForCell(
            { x: 3, y: 1 },
            testGridSettings.getMinX(),
            testGridSettings.getStep(),
            testGridSettings.getHalfStep(),
        );
        const sideCenter = getClosestSideCenter(
            matrix,
            testGridSettings,
            toPosition,
            fromPosition,
            toPosition,
            true,
            true,
            PBTypes.TeamVals.UPPER,
        );

        expect(sideCenter).toBeDefined();

        matrix[2][1] = ObstacleType.BLOCK;
        expect(
            getClosestSideCenter(
                matrix,
                testGridSettings,
                toPosition,
                fromPosition,
                toPosition,
                true,
                true,
                PBTypes.TeamVals.UPPER,
                true,
            ),
        ).toBeDefined();
    });

    it("selects closest side centers across directions and blocked cells", () => {
        const matrix = emptyMatrix();
        const toPosition = getPositionForCell(
            { x: 5, y: 5 },
            testGridSettings.getMinX(),
            testGridSettings.getStep(),
            testGridSettings.getHalfStep(),
        );
        const fromCells = [
            { x: 3, y: 5 },
            { x: 7, y: 5 },
            { x: 5, y: 3 },
            { x: 5, y: 7 },
            { x: 3, y: 3 },
        ];

        for (const fromCell of fromCells) {
            const fromPosition = getPositionForCell(
                fromCell,
                testGridSettings.getMinX(),
                testGridSettings.getStep(),
                testGridSettings.getHalfStep(),
            );
            expect(
                getClosestSideCenter(
                    matrix,
                    testGridSettings,
                    toPosition,
                    fromPosition,
                    toPosition,
                    true,
                    true,
                    PBTypes.TeamVals.UPPER,
                ),
            ).toBeDefined();
        }

        expect(
            getClosestSideCenter(
                matrix,
                testGridSettings,
                toPosition,
                toPosition,
                toPosition,
                true,
                true,
                PBTypes.TeamVals.UPPER,
            ),
        ).toBeUndefined();

        const blockedMatrix = emptyMatrix();
        blockedMatrix[5][4] = ObstacleType.BLOCK;
        blockedMatrix[5][6] = ObstacleType.BLOCK;
        blockedMatrix[4][5] = ObstacleType.BLOCK;
        blockedMatrix[6][5] = ObstacleType.BLOCK;
        expect(
            getClosestSideCenter(
                blockedMatrix,
                testGridSettings,
                toPosition,
                getPositionForCell(
                    { x: 3, y: 3 },
                    testGridSettings.getMinX(),
                    testGridSettings.getStep(),
                    testGridSettings.getHalfStep(),
                ),
                toPosition,
                true,
                true,
                PBTypes.TeamVals.UPPER,
            ),
        ).toBeUndefined();
    });
});

function emptyMatrix(): number[][] {
    return Array.from({ length: testGridSettings.getGridSize() }, () =>
        Array.from({ length: testGridSettings.getGridSize() }, () => 0),
    );
}

function fullKnownPaths(): { knownPaths: Map<number, IWeightedRoute[]>; pathHashes: Set<number> } {
    const knownPaths = new Map<number, IWeightedRoute[]>();
    const pathHashes = new Set<number>();
    for (let x = 0; x < testGridSettings.getGridSize(); x++) {
        for (let y = 0; y < testGridSettings.getGridSize(); y++) {
            const hash = (x << 4) | y;
            knownPaths.set(hash, []);
            pathHashes.add(hash);
        }
    }

    return { knownPaths, pathHashes };
}

function withCryptoWords(words: number[], fn: () => void): void {
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    let index = 0;

    Object.defineProperty(globalThis, "crypto", {
        configurable: true,
        value: {
            getRandomValues<T extends ArrayBufferView>(array: T): T {
                const values = new Uint32Array(
                    array.buffer,
                    array.byteOffset,
                    array.byteLength / Uint32Array.BYTES_PER_ELEMENT,
                );
                for (let i = 0; i < values.length; i++) {
                    values[i] = words[index++] ?? 0;
                }
                return array;
            },
        },
    });

    try {
        fn();
    } finally {
        if (originalDescriptor) {
            Object.defineProperty(globalThis, "crypto", originalDescriptor);
        } else {
            Reflect.deleteProperty(globalThis, "crypto");
        }
    }
}
