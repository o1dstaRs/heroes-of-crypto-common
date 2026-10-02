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
import { afterEach, describe, expect, it } from "bun:test";
import { Grid } from "../../src/grid/grid";
import { PathHelper } from "../../src/grid/path_helper";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { simulationGridSettings } from "../../src/simulation/battle_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { VINE_CROSS_PENALTY, VINE_STRIDE_CELL_COST, vinePathCells } from "../../src/spells/vines";

// Vine Throw lays terrain, and terrain is priced in the pathfinder — so the numbers below ARE the feature.
// A vined cell costs a walker one extra step; Trent ("In Its Own World") instead walks it for free, straight
// or diagonal. That extra reach stays on the vine; plain ground uses his normal movement range.
describe("Vine Throw movement costs", () => {
    const settings = simulationGridSettings();
    const START = { x: 8, y: 8 };

    const vines = () => FightStateManager.getInstance().getFightProperties().getVines();

    afterEach(() => {
        vines().clear();
    });

    // Cost of the cheapest route to `cell`, read out of the weighted route the pathfinder kept.
    const costTo = (cell: { x: number; y: number }, hasVineStride: boolean): number | undefined => {
        const grid = new Grid(settings, PBTypes.GridVals.NORMAL);
        const path = new PathHelper(settings).getMovePath(
            START,
            grid.getMatrix(),
            /* maxSteps */ 8,
            /* aggrBoard */ undefined,
            /* canFly */ false,
            /* isSmallUnit */ true,
            /* isMadeOfFire */ false,
            hasVineStride,
        );
        const routes = path.knownPaths.get((cell.x << 4) | cell.y);
        if (!routes?.length) {
            return undefined;
        }
        return Math.min(...routes.map((r) => r.weight));
    };

    it("charges a walker one plain step for a clear cell", () => {
        expect(costTo({ x: 9, y: 8 }, false)).toBeCloseTo(1, 5);
    });

    it("charges a walker an extra step to enter a vined cell", () => {
        vines().add({ x: 9, y: 8 });
        expect(costTo({ x: 9, y: 8 }, false)).toBeCloseTo(1 + VINE_CROSS_PENALTY, 5);
    });

    it("charges a vine strider nothing for the same cell", () => {
        vines().add({ x: 9, y: 8 });
        expect(VINE_STRIDE_CELL_COST).toBe(0);
        expect(costTo({ x: 9, y: 8 }, true)).toBeCloseTo(VINE_STRIDE_CELL_COST, 5);
    });

    // The worked example from the spec: one ordinary cell followed by one vined cell.
    it("prices 'one plain cell then one vined cell' at the plain step alone for the strider", () => {
        vines().add({ x: 10, y: 8 });
        expect(costTo({ x: 10, y: 8 }, true)).toBeCloseTo(1 + VINE_STRIDE_CELL_COST, 5);
        // The same two cells cost a walker the plain step plus the vine toll.
        expect(costTo({ x: 10, y: 8 }, false)).toBeCloseTo(1 + 1 + VINE_CROSS_PENALTY, 5);
    });

    it("drops the diagonal surcharge on a vined cell for the strider only", () => {
        const diagonal = { x: 9, y: 9 };
        // A plain diagonal costs sqrt(2) for everyone.
        expect(costTo(diagonal, false)).toBeCloseTo(PathHelper.DIAGONAL_MOVE_COST, 5);

        vines().add(diagonal);
        // The strider pays nothing, NOT a share of sqrt(2).
        expect(costTo(diagonal, true)).toBeCloseTo(VINE_STRIDE_CELL_COST, 5);
        // The walker still pays the diagonal plus the toll.
        expect(costTo(diagonal, false)).toBeCloseTo(PathHelper.DIAGONAL_MOVE_COST + VINE_CROSS_PENALTY, 5);
    });

    it("walks a bent vine for free without discounting routes to the plain ground beside it", () => {
        const farEnd = { x: 13, y: 10 };
        const road = vinePathCells(START, farEnd);
        // The lane from (8,8) to (13,10) steps diagonally twice on the way; those bends are the point.
        expect(road).toEqual([
            { x: 9, y: 8 },
            { x: 10, y: 9 },
            { x: 11, y: 9 },
            { x: 12, y: 10 },
            { x: 13, y: 10 },
        ]);
        vines().addAll(road);

        for (const cell of road) {
            expect(costTo(cell, true)).toBeCloseTo(0, 5);
        }
        expect(costTo({ x: 14, y: 10 }, true)).toBeCloseTo(4 + 2 * PathHelper.DIAGONAL_MOVE_COST, 5);
        expect(costTo({ x: 14, y: 11 }, true)).toBeCloseTo(3 + 3 * PathHelper.DIAGONAL_MOVE_COST, 5);
        expect(costTo({ x: 11, y: 10 }, true)).toBeCloseTo(1 + 2 * PathHelper.DIAGONAL_MOVE_COST, 5);
        // The walker pays the toll on every one of those cells.
        expect(costTo({ x: 9, y: 8 }, false)).toBeCloseTo(1 + VINE_CROSS_PENALTY, 5);
    });

    it("keeps the far end of a vine within reach of a budget smaller than the vine is long", () => {
        const road = vinePathCells(START, { x: 15, y: 8 });
        expect(road.length).toBe(7);
        vines().addAll(road);
        const grid = new Grid(settings, PBTypes.GridVals.NORMAL);
        const path = new PathHelper(settings).getMovePath(
            START,
            grid.getMatrix(),
            2.9,
            undefined,
            false,
            true,
            false,
            true,
        );
        expect(path.hashes.has((15 << 4) | 8)).toBe(true);
        expect(path.hashes.has((15 << 4) | 9)).toBe(false);
        expect(path.hashes.has((15 << 4) | 10)).toBe(false);
        expect(path.hashes.has((15 << 4) | 11)).toBe(false);
        expect(path.knownPaths.has((15 << 4) | 9)).toBe(false);
        expect(path.knownPaths.has((14 << 4) | 9)).toBe(false);
        expect(path.cells).not.toContainEqual({ x: 15, y: 9 });
        expect(path.hashes.has((8 << 4) | 10)).toBe(true);
        expect(path.knownPaths.get((10 << 4) | 9)?.[0]?.weight).toBeCloseTo(1 + PathHelper.DIAGONAL_MOVE_COST, 5);
        // Without the passive, the same budget does not even clear the second vined cell (1 + 1 + 1 + 1).
        const walker = new PathHelper(settings).getMovePath(
            START,
            grid.getMatrix(),
            2.9,
            undefined,
            false,
            true,
            false,
            false,
        );
        expect(walker.hashes.has((10 << 4) | 8)).toBe(false);
    });

    it("does not bridge a gap beyond the normal movement range to reach a disconnected vine", () => {
        vines().addAll(vinePathCells(START, { x: 15, y: 8 }));
        vines().remove({ x: 11, y: 8 });
        const grid = new Grid(settings, PBTypes.GridVals.NORMAL);
        const path = new PathHelper(settings).getMovePath(
            START,
            grid.getMatrix(),
            2.9,
            undefined,
            false,
            true,
            false,
            true,
        );

        expect(path.hashes.has((10 << 4) | 8)).toBe(true);
        expect(path.hashes.has((11 << 4) | 8)).toBe(false);
        expect(path.hashes.has((12 << 4) | 8)).toBe(false);
        expect(path.knownPaths.has((15 << 4) | 8)).toBe(false);
    });

    it("lets Trent cross vines within his normal range without the ordinary walker toll", () => {
        vines().add({ x: 9, y: 8 });
        const grid = new Grid(settings, PBTypes.GridVals.NORMAL);
        const path = new PathHelper(settings).getMovePath(
            START,
            grid.getMatrix(),
            2.9,
            undefined,
            false,
            true,
            false,
            true,
        );

        expect(path.hashes.has((10 << 4) | 8)).toBe(true);
        expect(path.knownPaths.get((10 << 4) | 8)?.[0]?.weight).toBeCloseTo(2, 5);
        expect(path.hashes.has((11 << 4) | 8)).toBe(false);
    });

    it("lets a flyer step over the vine for free", () => {
        vines().add({ x: 9, y: 8 });
        const grid = new Grid(settings, PBTypes.GridVals.NORMAL);
        const path = new PathHelper(settings).getMovePath(
            START,
            grid.getMatrix(),
            8,
            undefined,
            /* canFly */ true,
            true,
            false,
            false,
        );
        const routes = path.knownPaths.get((9 << 4) | 8);
        expect(Math.min(...routes!.map((r) => r.weight))).toBeCloseTo(1, 5);
    });
});

describe("vinePathCells", () => {
    it("covers the cells between caster and target, excluding the caster's own", () => {
        const cells = vinePathCells({ x: 4, y: 4 }, { x: 7, y: 4 });
        expect(cells).toEqual([
            { x: 5, y: 4 },
            { x: 6, y: 4 },
            { x: 7, y: 4 },
        ]);
    });

    it("walks a diagonal throw and always ends on the target", () => {
        const cells = vinePathCells({ x: 2, y: 2 }, { x: 5, y: 5 });
        expect(cells[0]).not.toEqual({ x: 2, y: 2 });
        expect(cells[cells.length - 1]).toEqual({ x: 5, y: 5 });
    });

    it("returns just the target's cell for an adjacent throw", () => {
        expect(vinePathCells({ x: 3, y: 3 }, { x: 3, y: 4 })).toEqual([{ x: 3, y: 4 }]);
    });
});
