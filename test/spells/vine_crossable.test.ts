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

import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { Grid } from "../../src/grid/grid";
import { isCellWithinGrid } from "../../src/grid/grid_math";
import { GridSettings } from "../../src/grid/grid_settings";
import { firstTargetedSpellSightBlocker } from "../../src/spells/spell_helper";
import { canVineTakeRoot, isVineCrossableCell, vinePathCells, type IVineGrid } from "../../src/spells/vines";

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

// Owner 2026-08-08: the throw arcs, so only a CREATURE in the lane can intercept it. Terrain that used
// to refuse the cast (the centre mountain, a narrowed hole, off-board cells) no longer does — the vine
// simply does not take root there. These two rules are now distinct, and the pair below pins the split.
describe("canVineTakeRoot", () => {
    const gridWith = (occupants: Record<string, string>): IVineGrid => ({
        getOccupantUnitId: (cell) => occupants[`${cell.x},${cell.y}`],
    });

    it("roots on open ground, lava, water and under a standing creature", () => {
        const grid = gridWith({ "1,0": "L", "2,0": "W", "3,0": "some-unit-id" });
        expect(canVineTakeRoot(grid, true, { x: 0, y: 0 })).toBe(true);
        expect(canVineTakeRoot(grid, true, { x: 1, y: 0 })).toBe(true);
        expect(canVineTakeRoot(grid, true, { x: 2, y: 0 })).toBe(true);
        // The struck creature's own cell has always taken a vine; any body in the lane is the same case.
        expect(canVineTakeRoot(grid, true, { x: 3, y: 0 })).toBe(true);
    });

    it("cannot grip the mountain, a narrowed hole, or anything off-board", () => {
        const grid = gridWith({ "0,0": "B", "1,0": "H" });
        expect(canVineTakeRoot(grid, true, { x: 0, y: 0 })).toBe(false);
        expect(canVineTakeRoot(grid, true, { x: 1, y: 0 })).toBe(false);
        expect(canVineTakeRoot(gridWith({}), false, { x: 99, y: 99 })).toBe(false);
    });
});

describe("Vine Throw interception (creature-only)", () => {
    const within = (cell: { x: number; y: number }) => cell.x >= 0 && cell.x < 16 && cell.y >= 0 && cell.y < 16;
    const gridWith = (occupants: Record<string, string>) => ({
        getOccupantUnitId: (cell: { x: number; y: number }) => occupants[`${cell.x},${cell.y}`],
    });
    const blockerFor = (occupants: Record<string, string>) =>
        firstTargetedSpellSightBlocker("Vine Throw", gridWith(occupants), within, { x: 0, y: 0 }, { x: 4, y: 0 });

    it("is refused only when a creature stands in the lane", () => {
        expect(blockerFor({ "0,0": "caster", "4,0": "target", "2,0": "screen" })?.occupantId).toBe("screen");
        expect(blockerFor({ "0,0": "caster", "4,0": "target" })).toBeUndefined();
    });

    it("arcs over the mountain, holes, lava and water", () => {
        expect(blockerFor({ "0,0": "caster", "4,0": "target", "1,0": "B", "2,0": "H", "3,0": "L" })).toBeUndefined();
    });

    // Every OTHER thrown spell keeps the archer's rule, where terrain intercepts as well.
    it("leaves Fire Strike's terrain blocking untouched", () => {
        const blocked = firstTargetedSpellSightBlocker(
            "Fire Strike",
            gridWith({ "0,0": "caster", "4,0": "target", "2,0": "B" }),
            within,
            { x: 0, y: 0 },
            { x: 4, y: 0 },
        );
        expect(blocked?.occupantId).toBe("B");
    });
});

// The rule against the REAL board rather than a hand-placed marker: a 16-wide BLOCK_CENTER grid puts
// solid rock at (5,7)/(5,8) — a lane straight down x=5 crosses it. This is the exact "behind the
// mountain" case the owner asked to open up, and the same code the ranked server runs.
describe("Vine Throw over the centre mountain (real BLOCK_CENTER board)", () => {
    const gs = new GridSettings(16, 1600, 0, 1600, 0, 0, 0);
    const grid = new Grid(gs, PBTypes.GridVals.BLOCK_CENTER);
    const from = { x: 5, y: 4 };
    const to = { x: 5, y: 12 };
    const within = (cell: { x: number; y: number }) => isCellWithinGrid(gs, cell);

    it("has real rock in the lane", () => {
        expect(grid.getOccupantUnitId({ x: 5, y: 7 })).toBe("B");
        expect(grid.getOccupantUnitId({ x: 5, y: 8 })).toBe("B");
    });

    it("lets the vine arc over it while Fire Strike still stops on it", () => {
        expect(firstTargetedSpellSightBlocker("Vine Throw", grid, within, from, to)).toBeUndefined();
        expect(firstTargetedSpellSightBlocker("Fire Strike", grid, within, from, to)?.occupantId).toBe("B");
    });

    it("roots either side of the rock but never on it", () => {
        const rooted = vinePathCells(from, to).filter((cell) => canVineTakeRoot(grid, within(cell), cell));
        expect(rooted.length).toBeGreaterThan(0);
        expect(rooted.some((cell) => cell.y === 7 || cell.y === 8)).toBe(false);
        expect(rooted.some((cell) => cell.y < 7)).toBe(true);
        expect(rooted.some((cell) => cell.y > 8)).toBe(true);
    });
});
