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

import { getAuraCellKeys } from "../../src/effects/effect_helper";
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
                    expect(getAuraCellKeys(testGridSettings, cell, range)).toEqual(
                        legacyGetAuraCellKeys(testGridSettings, cell, range),
                    );
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
});
