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

import { getAuraCellKeys, getAuraCellKeysView } from "../../src/effects/effect_helper";
import { getCellsAroundCell } from "../../src/grid/grid_math";
import { GridSettings } from "../../src/grid/grid_settings";
import type { XY } from "../../src/utils/math";
import { testGridSettings } from "../helpers/combat";

function legacyGetAuraCellKeys(gridSettings: GridSettings, cell: XY, auraRange: number): number[] {
    const ret: number[] = [];
    let cellsPool: XY[] = [cell];
    const cellsCheckedAura: number[] = [];

    if (auraRange >= 0) {
        ret.push((cell.x << 4) | cell.y);
    }

    while (auraRange > 0) {
        let nextPool: XY[] = [];
        while (cellsPool.length) {
            const cellToCheck = cellsPool.pop();
            if (!cellToCheck) {
                continue;
            }

            const cellToCheckKey = (cellToCheck.x << 4) | cellToCheck.y;
            if (cellsCheckedAura.includes(cellToCheckKey)) {
                continue;
            }

            for (const neighboringCell of getCellsAroundCell(gridSettings, cellToCheck)) {
                nextPool.push(neighboringCell);
                const cellKey = (neighboringCell.x << 4) | neighboringCell.y;
                if (!ret.includes(cellKey)) {
                    ret.push(cellKey);
                }
            }

            cellsCheckedAura.push(cellToCheckKey);
        }
        cellsPool = nextPool;
        auraRange--;
    }

    return ret;
}

describe("aura geometry compatibility oracle", () => {
    it("preserves exact ordered keys for every legal 16x16 source through range four", () => {
        for (let x = 0; x < testGridSettings.getGridSize(); x++) {
            for (let y = 0; y < testGridSettings.getGridSize(); y++) {
                for (const range of [-3, -1, -0, 0, 0.25, 1, 1.5, 2, 3, 4]) {
                    const cell = { x, y };
                    const expected = legacyGetAuraCellKeys(testGridSettings, cell, range);
                    expect(getAuraCellKeys(testGridSettings, cell, range)).toEqual(expected);
                    expect(getAuraCellKeysView(testGridSettings, cell, range)).toEqual(expected);
                }
            }
        }
    });

    it("preserves custom-grid, boundary, fractional, and non-finite finite-loop behavior", () => {
        const customSettings = new GridSettings(7, 700, 0, 700, -700, 0, 0);
        const cells: XY[] = [
            { x: -2, y: -2 },
            { x: -1, y: 0 },
            { x: 0, y: -1 },
            { x: 0, y: 0 },
            { x: 3, y: 3 },
            { x: 6, y: 6 },
            { x: 7, y: 7 },
            { x: 8, y: 2 },
            { x: 1.25, y: 4.75 },
            { x: Number.NaN, y: 2 },
            { x: 2, y: Number.NaN },
            { x: Number.POSITIVE_INFINITY, y: 1 },
            { x: 1, y: Number.NEGATIVE_INFINITY },
        ];

        for (const cell of cells) {
            for (const range of [Number.NaN, Number.NEGATIVE_INFINITY, -2, -0, 0, 0.25, 1, 2.5]) {
                expect(getAuraCellKeys(customSettings, cell, range)).toEqual(
                    legacyGetAuraCellKeys(customSettings, cell, range),
                );
            }
        }
    });

    it("returns caller-owned arrays and never mutates source coordinates", () => {
        const source = { x: 5, y: 6 };
        const sourceBefore = structuredClone(source);
        const first = getAuraCellKeys(testGridSettings, source, 3);
        const expected = legacyGetAuraCellKeys(testGridSettings, source, 3);

        first.reverse();
        first.push(-1);

        const second = getAuraCellKeys(testGridSettings, source, 3);
        expect(second).toEqual(expected);
        expect(second).not.toBe(first);
        expect(source).toEqual(sourceBefore);
    });

    it("exposes one immutable production view without leaking it through the public mutable result", () => {
        const source = { x: 5, y: 6 };
        const firstView = getAuraCellKeysView(testGridSettings, source, 3);
        const secondView = getAuraCellKeysView(testGridSettings, source, 3);
        const mutableResult = getAuraCellKeys(testGridSettings, source, 3);

        expect(firstView).toBe(secondView);
        expect(Object.isFrozen(firstView)).toBe(true);
        expect(firstView).toEqual(legacyGetAuraCellKeys(testGridSettings, source, 3));
        expect(mutableResult).toEqual(firstView);
        expect(mutableResult).not.toBe(firstView);
    });

    it("separates cache entries by grid identity, source cell, and range", () => {
        const firstGrid = new GridSettings(7, 700, 0, 700, -700, 0, 0);
        const secondGrid = new GridSettings(7, 1400, 0, 1400, -1400, 0, 0);
        const first = getAuraCellKeysView(firstGrid, { x: 2, y: 3 }, 1);

        expect(getAuraCellKeysView(firstGrid, { x: 2, y: 3 }, 1)).toBe(first);
        expect(getAuraCellKeysView(firstGrid, { x: 2, y: 4 }, 1)).not.toBe(first);
        expect(getAuraCellKeysView(firstGrid, { x: 2, y: 3 }, 2)).not.toBe(first);
        expect(getAuraCellKeysView(secondGrid, { x: 2, y: 3 }, 1)).not.toBe(first);
    });

    it("fails closed instead of aliasing cache keys for malformed or precision-unsafe grid sizes", () => {
        for (const [gridSize, firstCell, secondCell] of [
            [Number.NaN, { x: 1, y: 1 }, { x: 1, y: 2 }],
            [Number.POSITIVE_INFINITY, { x: 1, y: 1 }, { x: 1, y: 2 }],
            [Number.MAX_SAFE_INTEGER, { x: 2, y: 1 }, { x: 2, y: 2 }],
        ] as const) {
            const grid = new GridSettings(gridSize, 700, 0, 700, -700, 0, 0);
            const first = getAuraCellKeysView(grid, firstCell, 0);
            const second = getAuraCellKeysView(grid, secondCell, 0);

            expect(first).toEqual(legacyGetAuraCellKeys(grid, firstCell, 0));
            expect(second).toEqual(legacyGetAuraCellKeys(grid, secondCell, 0));
            expect(second).not.toBe(first);
            expect(getAuraCellKeys(grid, secondCell, 0)).toEqual(second);
        }
    });
});
