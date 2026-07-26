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

import { isVineCrossableCell, type IVineGrid } from "../../src/spells/vines";

// isVineCrossableCell is the CONTRACT between the engine's vineThrowCast and the client's aim preview: the
// preview highlights a lane only when every cell short of the target passes this, and the engine refuses the
// throw on exactly the same test. If the two ever disagree the player gets a highlight for a cast that is
// then rejected, so the rules live here rather than being restated at either call site.
describe("isVineCrossableCell", () => {
    const gridWith = (occupants: Record<string, string>): IVineGrid => ({
        getOccupantUnitId: (cell) => occupants[`${cell.x},${cell.y}`],
    });

    it("creeps over empty ground and over lava and water", () => {
        const grid = gridWith({ "1,0": "L", "2,0": "W" });
        expect(isVineCrossableCell(grid, true, { x: 0, y: 0 })).toBe(true);
        expect(isVineCrossableCell(grid, true, { x: 1, y: 0 })).toBe(true);
        expect(isVineCrossableCell(grid, true, { x: 2, y: 0 })).toBe(true);
    });

    it("is stopped by a body, the centre mountain, and a narrowed cell", () => {
        const grid = gridWith({ "0,0": "some-unit-id", "1,0": "B", "2,0": "H" });
        expect(isVineCrossableCell(grid, true, { x: 0, y: 0 })).toBe(false);
        expect(isVineCrossableCell(grid, true, { x: 1, y: 0 })).toBe(false);
        expect(isVineCrossableCell(grid, true, { x: 2, y: 0 })).toBe(false);
    });

    it("refuses anything off the board even when the cell itself is empty", () => {
        // The caller decides what "within grid" means; an empty cell outside it is still not crossable.
        expect(isVineCrossableCell(gridWith({}), false, { x: 99, y: 99 })).toBe(false);
    });
});
