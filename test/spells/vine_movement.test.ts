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
import { VINE_CROSS_PENALTY, VINE_STRIDE_COST_MULTIPLIER, vinePathCells } from "../../src/spells/vines";

// Vine Throw lays terrain, and terrain is priced in the pathfinder — so the numbers below ARE the feature.
// A vined cell costs a walker one extra step; Trent ("In Its Own World") instead pays half a plain step and
// owes nothing extra for taking it diagonally.
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

    it("charges a vine strider half a plain step for the same cell", () => {
        vines().add({ x: 9, y: 8 });
        expect(costTo({ x: 9, y: 8 }, true)).toBeCloseTo(VINE_STRIDE_COST_MULTIPLIER, 5);
    });

    // The worked example from the spec: one ordinary cell followed by one vined cell.
    it("prices 'one plain cell then one vined cell' at 1.5 for the strider", () => {
        vines().add({ x: 10, y: 8 });
        expect(costTo({ x: 10, y: 8 }, true)).toBeCloseTo(1 + VINE_STRIDE_COST_MULTIPLIER, 5);
        // The same two cells cost a walker the plain step plus the vine toll.
        expect(costTo({ x: 10, y: 8 }, false)).toBeCloseTo(1 + 1 + VINE_CROSS_PENALTY, 5);
    });

    it("drops the diagonal surcharge on a vined cell for the strider only", () => {
        const diagonal = { x: 9, y: 9 };
        // A plain diagonal costs sqrt(2) for everyone.
        expect(costTo(diagonal, false)).toBeCloseTo(PathHelper.DIAGONAL_MOVE_COST, 5);

        vines().add(diagonal);
        // The strider pays a half step, NOT half of sqrt(2).
        expect(costTo(diagonal, true)).toBeCloseTo(VINE_STRIDE_COST_MULTIPLIER, 5);
        // The walker still pays the diagonal plus the toll.
        expect(costTo(diagonal, false)).toBeCloseTo(PathHelper.DIAGONAL_MOVE_COST + VINE_CROSS_PENALTY, 5);
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
