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

import { GridSettings } from "../../src/grid/grid_settings";
import {
    getCellForPosition,
    getFootprintAnchorForPosition,
    getFootprintCellsForAnchor,
    getPositionForFootprintAnchor,
    isFootprintWithinGrid,
} from "../../src/grid/grid_math";
import { MAX_VERIFIED_FOOTPRINT_SIDE } from "../../src/configuration/config_provider";

const GRID_SIZE = 16;
const gridSettings = new GridSettings(GRID_SIZE, 2048, 0, 1024, -1024, 5, 0.06);

/** Every legal anchor for a W x H block, for W and H over the given range. */
const eachAnchor = (
    maxSide: number,
    visit: (width: number, height: number, anchor: { x: number; y: number }) => void,
) => {
    for (let width = 1; width <= maxSide; width++) {
        for (let height = 1; height <= maxSide; height++) {
            for (let x = width - 1; x < GRID_SIZE; x++) {
                for (let y = height - 1; y < GRID_SIZE; y++) {
                    const anchor = { x, y };
                    if (!isFootprintWithinGrid(gridSettings, anchor, width, height)) {
                        continue;
                    }
                    visit(width, height, anchor);
                }
            }
        }
    }
};

describe("footprint geometry is general in the side length", () => {
    /**
     * The anchor <-> centre round trip is the load-bearing identity of the whole footprint model: a unit's
     * stored value is its centre POSITION, and every occupancy, path and attack decision converts that back
     * to the anchor CELL. If the conversion is lossy for some shape, that shape's body and the board's idea
     * of it drift apart, which surfaces as an AI proposing moves the engine refuses rather than as a crash.
     *
     * Deliberately swept well past MAX_VERIFIED_FOOTPRINT_SIDE: the geometry is general, and this pins that
     * so a future change cannot quietly narrow it back to the shapes that happen to ship today.
     */
    test("anchor -> centre -> anchor is exact for every side up to 5", () => {
        const failures: string[] = [];
        eachAnchor(5, (width, height, anchor) => {
            const position = getPositionForFootprintAnchor(gridSettings, anchor, width, height);
            const back = getFootprintAnchorForPosition(gridSettings, position, width, height);
            if (back.x !== anchor.x || back.y !== anchor.y) {
                failures.push(`${width}x${height} @ ${anchor.x},${anchor.y} -> ${back.x},${back.y}`);
            }
        });
        expect(failures).toEqual([]);
    });

    test("a footprint always expands to exactly width * height cells, with the anchor top-right", () => {
        const failures: string[] = [];
        eachAnchor(5, (width, height, anchor) => {
            const cells = getFootprintCellsForAnchor(anchor, width, height);
            if (cells.length !== width * height) {
                failures.push(`${width}x${height} @ ${anchor.x},${anchor.y} -> ${cells.length} cells`);
                return;
            }
            const maxX = Math.max(...cells.map((c) => c.x));
            const maxY = Math.max(...cells.map((c) => c.y));
            if (maxX !== anchor.x || maxY !== anchor.y) {
                failures.push(`${width}x${height} @ ${anchor.x},${anchor.y} max=${maxX},${maxY}`);
            }
        });
        expect(failures).toEqual([]);
    });

    /**
     * The trap this whole area kept falling into: `getCellForPosition(unit.getPosition())` reads as "the
     * unit's cell" and IS the anchor for every side up to 2 — 1x1 trivially, 2x2 because the centre sits on
     * the anchor's corner, and 2x1 / 1x2 only because the centre lands exactly on a cell boundary and
     * `floor` breaks the tie towards the anchor. That accident is why the shortcut survived everywhere for
     * so long, and why a rectangle did not expose it.
     */
    test("the legacy centre-to-cell shortcut agrees with the anchor for every side up to 2", () => {
        const disagreements: string[] = [];
        eachAnchor(2, (width, height, anchor) => {
            const position = getPositionForFootprintAnchor(gridSettings, anchor, width, height);
            const shortcut = getCellForPosition(gridSettings, position);
            if (!shortcut || shortcut.x !== anchor.x || shortcut.y !== anchor.y) {
                disagreements.push(`${width}x${height} @ ${anchor.x},${anchor.y} -> ${shortcut?.x},${shortcut?.y}`);
            }
        });
        expect(disagreements).toEqual([]);
    });

    /**
     * And stops agreeing the moment a side is 3, which is the whole reason the shortcut had to go. Pinned
     * with the exact values from the failure it caused: a 1x3 attacker anchored (6,10) reported (6,9) as
     * "its cell", so `stationaryAttack` compared a middle cell against an anchor, decided the unit was
     * trying to move, and the engine refused the strike as attack_not_available.
     */
    test("and stops agreeing as soon as a side is 3", () => {
        const position = getPositionForFootprintAnchor(gridSettings, { x: 6, y: 10 }, 1, 3);
        expect(getFootprintAnchorForPosition(gridSettings, position, 1, 3)).toEqual({ x: 6, y: 10 });
        expect(getCellForPosition(gridSettings, position)).toEqual({ x: 6, y: 9 });
    });

    /**
     * The bound is a claim about what has been MEASURED, not about what the geometry can express. Keeping it
     * inside the range this file sweeps is what makes the sweep evidence for the bound rather than beside it.
     */
    test("the verified-side bound stays within the range this file actually exercises", () => {
        expect(MAX_VERIFIED_FOOTPRINT_SIDE).toBeGreaterThanOrEqual(2);
        expect(MAX_VERIFIED_FOOTPRINT_SIDE).toBeLessThanOrEqual(5);
    });
});
