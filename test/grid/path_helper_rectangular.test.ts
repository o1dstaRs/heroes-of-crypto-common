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

import { describe, expect, test } from "bun:test";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { getFootprintCellsForAnchor } from "../../src/grid/grid_math";
import { GridSettings } from "../../src/grid/grid_settings";
import { PathHelper } from "../../src/grid/path_helper";
import { ObstacleType } from "../../src/obstacles/obstacle_type";
import type { XY } from "../../src/utils/math";

/**
 * getMovePath for RECTANGULAR bodies (2x1, 1x2, 1x3, ...). The square shapes ride hand-written legacy
 * branches that the differential suites already pin; every other footprint takes the generic offset-driven
 * walk, and until this file nothing exercised that walk at all. Three angles that need no engine:
 *
 * - an empty board has a closed-form king-move distance, so reachability is checked against an oracle that
 *   shares no code with the pather (the square shapes run through the same oracle as controls);
 * - on randomized obstacle boards every returned route must be BODY-legal at every step — footprint
 *   in-grid, no covered obstacle, no diagonal shearing through a blocked cell — and its weight must be the
 *   plain sum of its step costs within the caller's budget;
 * - the pather has no preferred axis, so transposing the board must transpose the result exactly. This is
 *   the axis-swap bug class: a W/H mixup produces self-consistent, plausible paths that this symmetry
 *   breaks loudly.
 */

const GRID_SIZE = 16;
const makeGridSettings = (): GridSettings => new GridSettings(GRID_SIZE, 2048, 0, 1024, -1024, 5, 0.06);
const DIAG = PathHelper.DIAGONAL_MOVE_COST;
const EPS = 1e-9;

// The battle matrix is indexed matrix[y][x] (see matrixElementOrDefault).
const emptyMatrix = (): number[][] => Array.from({ length: GRID_SIZE }, () => new Array(GRID_SIZE).fill(0));

const mulberry32 = (seed: number): (() => number) => {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), a | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

const keyToCell = (key: number): XY => ({ x: key >> 4, y: key & 0xf });

const minRouteWeight = (routes: { weight: number }[]): number => Math.min(...routes.map((r) => r.weight));

/** Closed-form cheapest king-move cost between anchors, valid only on an unobstructed board. */
const kingDistance = (from: XY, to: XY): number => {
    const dx = Math.abs(to.x - from.x);
    const dy = Math.abs(to.y - from.y);
    return DIAG * Math.min(dx, dy) + Math.abs(dx - dy);
};

const FOOTPRINTS: [number, number][] = [
    [1, 1],
    [2, 2],
    [2, 1],
    [1, 2],
    [1, 3],
    [3, 1],
    [2, 3],
    [3, 2],
];

describe("PathHelper rectangular getMovePath", () => {
    test("empty-board reachability matches the closed-form king-move oracle for every body", () => {
        // Touch the singleton before anything else in this file relies on it (vine/fire-wall reads).
        FightStateManager.getInstance().reset();
        const pathHelper = new PathHelper(makeGridSettings());
        for (const [width, height] of FOOTPRINTS) {
            const starts: XY[] = [
                { x: width - 1, y: height - 1 },
                { x: 8, y: 8 },
                { x: GRID_SIZE - 1, y: height - 1 },
                { x: width - 1, y: GRID_SIZE - 1 },
                { x: GRID_SIZE - 1, y: GRID_SIZE - 1 },
            ];
            for (const start of starts) {
                for (const maxSteps of [2, 3.5]) {
                    const result = pathHelper.getMovePath(
                        start,
                        emptyMatrix(),
                        maxSteps,
                        undefined,
                        false,
                        width === 1 && height === 1,
                        false,
                        false,
                        width,
                        height,
                    );
                    const actual = new Set([...result.knownPaths.keys()]);
                    actual.delete((start.x << 4) | start.y);
                    const expected = new Set<number>();
                    for (let x = width - 1; x < GRID_SIZE; x++) {
                        for (let y = height - 1; y < GRID_SIZE; y++) {
                            if (x === start.x && y === start.y) {
                                continue;
                            }
                            if (kingDistance(start, { x, y }) <= maxSteps + EPS) {
                                expected.add((x << 4) | y);
                            }
                        }
                    }
                    expect([...actual].sort((a, b) => a - b)).toEqual([...expected].sort((a, b) => a - b));
                    for (const key of actual) {
                        const routes = result.knownPaths.get(key)!;
                        expect(minRouteWeight(routes)).toBeCloseTo(kingDistance(start, keyToCell(key)), 9);
                    }
                }
            }
        }
    });

    test("randomized obstacle boards: every returned route is body-legal, continuous, and priced", () => {
        FightStateManager.getInstance().reset();
        const pathHelper = new PathHelper(makeGridSettings());
        const obstacleValues = [ObstacleType.BLOCK, ObstacleType.HOLE, ObstacleType.LAVA, ObstacleType.WATER, 777];
        const rectangles: [number, number][] = [
            [2, 1],
            [1, 2],
            [1, 3],
            [3, 1],
            [2, 3],
        ];
        let routesChecked = 0;
        for (const [width, height] of rectangles) {
            for (let round = 0; round < 24; round++) {
                const rand = mulberry32(width * 1_000_003 + height * 7919 + round * 104_729 + 5);
                const canFly = round % 3 === 2;
                const matrix = emptyMatrix();
                for (let y = 0; y < GRID_SIZE; y++) {
                    for (let x = 0; x < GRID_SIZE; x++) {
                        if (rand() < 0.16) {
                            matrix[y][x] = obstacleValues[Math.floor(rand() * obstacleValues.length)];
                        }
                    }
                }
                const start = {
                    x: width - 1 + Math.floor(rand() * (GRID_SIZE - width + 1)),
                    y: height - 1 + Math.floor(rand() * (GRID_SIZE - height + 1)),
                };
                // The mover stands on its own start cells; keep them clear like a real board does.
                for (const cell of getFootprintCellsForAnchor(start, width, height)) {
                    matrix[cell.y][cell.x] = 0;
                }
                const maxSteps = [2, 3.5, 4.9][round % 3];
                const result = pathHelper.getMovePath(
                    start,
                    matrix,
                    maxSteps,
                    undefined,
                    canFly,
                    false,
                    false,
                    false,
                    width,
                    height,
                );
                const blocksBody = (el: number): boolean =>
                    canFly ? !!el && el !== ObstacleType.LAVA && el !== ObstacleType.WATER : !!el;
                const bodyLegal = (anchor: XY): boolean => {
                    if (
                        anchor.x < width - 1 ||
                        anchor.x >= GRID_SIZE ||
                        anchor.y < height - 1 ||
                        anchor.y >= GRID_SIZE
                    ) {
                        return false;
                    }
                    return getFootprintCellsForAnchor(anchor, width, height).every(
                        (cell) => !blocksBody(matrix[cell.y][cell.x]),
                    );
                };
                const covered = (anchor: XY, x: number, y: number): boolean =>
                    x <= anchor.x && x > anchor.x - width && y <= anchor.y && y > anchor.y - height;
                for (const [key, routes] of result.knownPaths) {
                    const destination = keyToCell(key);
                    expect(bodyLegal(destination)).toBe(true);
                    for (const weightedRoute of routes) {
                        const route = weightedRoute.route;
                        expect(route[0]).toEqual(start);
                        expect(route[route.length - 1]).toEqual(destination);
                        let priced = 0;
                        for (let i = 1; i < route.length; i++) {
                            const previous = route[i - 1];
                            const cell = route[i];
                            const stepX = cell.x - previous.x;
                            const stepY = cell.y - previous.y;
                            expect(Math.max(Math.abs(stepX), Math.abs(stepY))).toBe(1);
                            expect(bodyLegal(cell)).toBe(true);
                            priced += stepX !== 0 && stepY !== 0 ? DIAG : 1;
                            if (stepX !== 0 && stepY !== 0 && !canFly) {
                                // A walking body cannot shear across the diagonal: one of the two L routes
                                // must sweep only free cells (ignoring cells the body starts or ends on).
                                const shears = (viaX: number, viaY: number): boolean =>
                                    getFootprintCellsForAnchor({ x: viaX, y: viaY }, width, height).some(
                                        (swept) =>
                                            !covered(previous, swept.x, swept.y) &&
                                            !covered(cell, swept.x, swept.y) &&
                                            !!(matrix[swept.y] ?? [])[swept.x],
                                    );
                                expect(shears(cell.x, previous.y) && shears(previous.x, cell.y)).toBe(false);
                            }
                        }
                        expect(priced).toBeCloseTo(weightedRoute.weight, 9);
                        expect(weightedRoute.weight).toBeLessThanOrEqual(maxSteps + EPS);
                        routesChecked++;
                    }
                }
            }
        }
        expect(routesChecked).toBeGreaterThan(2_000);
    });

    test("transposing the board transposes the move set: no preferred axis", () => {
        FightStateManager.getInstance().reset();
        const pathHelper = new PathHelper(makeGridSettings());
        const pairs: [number, number][] = [
            [2, 1],
            [1, 3],
            [2, 3],
        ];
        for (const [width, height] of pairs) {
            for (let round = 0; round < 12; round++) {
                const rand = mulberry32(width * 31 + height * 131 + round * 65_537 + 977);
                const matrix = emptyMatrix();
                for (let y = 0; y < GRID_SIZE; y++) {
                    for (let x = 0; x < GRID_SIZE; x++) {
                        if (rand() < 0.14) {
                            matrix[y][x] = ObstacleType.BLOCK;
                        }
                    }
                }
                const start = {
                    x: width - 1 + Math.floor(rand() * (GRID_SIZE - width + 1)),
                    y: height - 1 + Math.floor(rand() * (GRID_SIZE - height + 1)),
                };
                for (const cell of getFootprintCellsForAnchor(start, width, height)) {
                    matrix[cell.y][cell.x] = 0;
                }
                // Cell (x, y) of the transposed board is cell (y, x) of the original; with the [y][x]
                // indexing that is a plain array transpose.
                const transposed = emptyMatrix();
                for (let y = 0; y < GRID_SIZE; y++) {
                    for (let x = 0; x < GRID_SIZE; x++) {
                        transposed[y][x] = matrix[x][y];
                    }
                }
                const original = pathHelper.getMovePath(
                    start,
                    matrix,
                    3.5,
                    undefined,
                    false,
                    false,
                    false,
                    false,
                    width,
                    height,
                );
                const mirrored = pathHelper.getMovePath(
                    { x: start.y, y: start.x },
                    transposed,
                    3.5,
                    undefined,
                    false,
                    false,
                    false,
                    false,
                    height,
                    width,
                );
                const originalKeys = [...original.knownPaths.keys()].sort((a, b) => a - b);
                const mirroredKeysTransposedBack = [...mirrored.knownPaths.keys()]
                    .map((key) => (((key & 0xf) << 4) | (key >> 4)) as number)
                    .sort((a, b) => a - b);
                expect(mirroredKeysTransposedBack).toEqual(originalKeys);
                for (const key of original.knownPaths.keys()) {
                    const mirroredKey = (((key & 0xf) << 4) | (key >> 4)) as number;
                    expect(minRouteWeight(mirrored.knownPaths.get(mirroredKey)!)).toBeCloseTo(
                        minRouteWeight(original.knownPaths.get(key)!),
                        9,
                    );
                }
            }
        }
    });
});
