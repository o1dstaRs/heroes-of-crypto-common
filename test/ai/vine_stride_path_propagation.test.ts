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

import { findTarget } from "../../src/ai/ai";
import { createDecisionPathCatalog } from "../../src/ai/decision_path_catalog";
import { StrategyV0_1 } from "../../src/ai/versions/v0_1";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;

function vineStridePair() {
    const combat = createCombatTestContext();
    const trent = createTestUnit({
        team: LEFT,
        name: "Trent",
        attackType: PBTypes.AttackVals.MELEE,
        initiative: 3.3,
        abilities: ["In Its Own World"],
    });
    const enemy = createTestUnit({
        team: RIGHT,
        name: "Distant enemy",
        attackType: PBTypes.AttackVals.MELEE,
    });
    placeUnit(combat.grid, combat.unitsHolder, trent, { x: 7, y: 3 });
    placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 7, y: 12 });
    return { combat, trent };
}

describe("AI vine-stride path propagation", () => {
    it("keeps Trent's generic target paths canonical instead of silently pricing vines as a normal walker", () => {
        const { combat, trent } = vineStridePair();
        const matrix = combat.grid.getMatrix();
        const pathHelper = new PathHelper(testGridSettings);
        const decisionPathCatalog = createDecisionPathCatalog(combat.grid, pathHelper, trent, matrix, true);

        expect(findTarget(trent, combat.grid, matrix, combat.unitsHolder, decisionPathCatalog)).toBeDefined();
        // The 100-step target-discovery path is intentionally noncanonical. The ordinary movement-budget path
        // must still be the one catalog miss; omitting hasVineStride turns both requests into bypasses.
        expect(decisionPathCatalog.getStats()).toEqual({ requests: 2, hits: 0, misses: 1, bypasses: 1 });
    });

    it("keeps the inherited fallback path canonical for every strategy version that can drive Trent", () => {
        const { combat, trent } = vineStridePair();
        const matrix = combat.grid.getMatrix();
        const pathHelper = new PathHelper(testGridSettings);
        const decisionPathCatalog = createDecisionPathCatalog(combat.grid, pathHelper, trent, matrix, true);
        const context = {
            grid: combat.grid,
            matrix,
            unitsHolder: combat.unitsHolder,
            pathHelper,
            decisionPathCatalog,
            attackHandler: combat.attackHandler,
        };

        const decision = new StrategyV0_1()["fallbackTurn"](trent, context);
        expect(decision.some((action) => action.type === "move_unit")).toBe(true);
        // v0.2-v0.8 inherit this fallback. A false/default hasVineStride would bypass the canonical path and
        // both lose decision-scoped reuse and generate a route with the wrong vine costs.
        expect(decisionPathCatalog.getStats()).toEqual({ requests: 1, hits: 0, misses: 1, bypasses: 0 });
    });
});
