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

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { IDecisionContext } from "../../src/ai/ai_strategy";
import { createDecisionPathCatalog } from "../../src/ai/decision_path_catalog";
import { A19_ENGINE_REACHABLE_ROUTES_ENV, StrategyV0_1 } from "../../src/ai/versions/v0_1";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import type { IWeightedRoute } from "../../src/grid/path_definitions";
import type { Unit } from "../../src/units/unit";
import { captureDeterministicRandomState } from "../../src/utils/lib";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;
const SWITCHES = [`${A19_ENGINE_REACHABLE_ROUTES_ENV}_LEFT`, `${A19_ENGINE_REACHABLE_ROUTES_ENV}_RIGHT`];

const cellOf = (key: number): XY => ({ x: key >> 4, y: key & 15 });

// The live case: a mindless Berserker (exact v0.1) planned its approach from findTarget's wider search, through an
// enemy's zone of control, and lost its turn to two invalid_move refusals. The engine accepts only a destination in
// its own step-limited known paths, which stop at a zone of control.
function zoneFixture() {
    const combat = createCombatTestContext();
    const walker = createTestUnit({ team: LEFT, attackType: PBTypes.AttackVals.MELEE, initiative: 5 });
    const enemy = createTestUnit({ team: RIGHT, attackType: PBTypes.AttackVals.MELEE, amountAlive: 50 });
    placeUnit(combat.grid, combat.unitsHolder, walker, { x: 4, y: 6 });
    placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 6, y: 6 });
    combat.grid.rebuildAggrBoards(
        new Map([
            [walker.getId(), walker.getAttackRange()],
            [enemy.getId(), enemy.getAttackRange()],
        ]),
    );
    const matrix = combat.grid.getMatrix();
    const pathHelper = new PathHelper(testGridSettings);
    const context: IDecisionContext = {
        grid: combat.grid,
        matrix,
        unitsHolder: combat.unitsHolder,
        pathHelper,
        decisionPathCatalog: createDecisionPathCatalog(combat.grid, pathHelper, walker, matrix),
        attackHandler: combat.attackHandler,
    };
    const paths = (aggr: number[][] | undefined) =>
        pathHelper.getMovePath(
            walker.getBaseCell(),
            matrix,
            walker.getSteps(),
            aggr,
            walker.canFly(),
            walker.isSmallSize(),
            walker.canTraverseLava(),
            walker.hasAbilityActive("In Its Own World"),
            walker.getFootprintWidth(),
            walker.getFootprintHeight(),
        ).knownPaths;
    return {
        walker,
        context,
        free: paths(undefined),
        engine: paths(combat.grid.getAggrMatrixByTeam(RIGHT)),
    };
}

const legal = (unit: Unit, context: IDecisionContext, cell: XY, route: IWeightedRoute): boolean =>
    (
        new StrategyV0_1() as unknown as {
            isLegalMoveRoute(unit: Unit, context: IDecisionContext, cell: XY, route: IWeightedRoute): boolean;
        }
    ).isLegalMoveRoute(unit, context, cell, route);

describe("a19 engine-reachable routes (v0.1 isLegalMoveRoute)", () => {
    let saved: (string | undefined)[] = [];
    beforeEach(() => {
        saved = SWITCHES.map((name) => process.env[name]);
        for (const name of SWITCHES) delete process.env[name];
    });
    afterEach(() => {
        SWITCHES.forEach((name, index) => {
            if (saved[index] === undefined) delete process.env[name];
            else process.env[name] = saved[index];
        });
    });

    it("refuses a route through a zone of control that the engine's known paths do not reach", () => {
        const { walker, context, free, engine } = zoneFixture();
        const beyond = [...free.keys()].filter((key) => !engine.has(key));
        expect(beyond.length).toBeGreaterThan(0);
        let refused = 0;
        for (const key of beyond) {
            const route = free.get(key)?.[0];
            if (!route) continue;
            process.env[`${A19_ENGINE_REACHABLE_ROUTES_ENV}_LEFT`] = "0";
            const before = legal(walker, context, cellOf(key), route);
            delete process.env[`${A19_ENGINE_REACHABLE_ROUTES_ENV}_LEFT`];
            if (!before) continue;
            expect(legal(walker, context, cellOf(key), route)).toBe(false);
            refused += 1;
        }
        // Without the check these routes passed every other gate; that is the refusal the engine then issued.
        expect(refused).toBeGreaterThan(0);
    });

    it("still accepts every destination the engine reaches", () => {
        const { walker, context, engine } = zoneFixture();
        let accepted = 0;
        for (const [key, routes] of engine) {
            const route = routes[0];
            if (!route) continue;
            process.env[`${A19_ENGINE_REACHABLE_ROUTES_ENV}_LEFT`] = "0";
            const before = legal(walker, context, cellOf(key), route);
            delete process.env[`${A19_ENGINE_REACHABLE_ROUTES_ENV}_LEFT`];
            expect(legal(walker, context, cellOf(key), route)).toBe(before);
            accepted += before ? 1 : 0;
        }
        expect(accepted).toBeGreaterThan(0);
    });

    it("is a per-seat switch and leaves the deterministic random stream where it was", () => {
        const { walker, context, free, engine } = zoneFixture();
        process.env[`${A19_ENGINE_REACHABLE_ROUTES_ENV}_LEFT`] = "0";
        const key = [...free.keys()].find(
            (candidate) => !engine.has(candidate) && legal(walker, context, cellOf(candidate), free.get(candidate)![0]),
        );
        expect(key).toBeDefined();
        const route = free.get(key!)![0];
        delete process.env[`${A19_ENGINE_REACHABLE_ROUTES_ENV}_LEFT`];
        // Switching the other seat off does not reach this LEFT unit, which keeps the check.
        process.env[`${A19_ENGINE_REACHABLE_ROUTES_ENV}_RIGHT`] = "0";
        const state = captureDeterministicRandomState();
        expect(legal(walker, context, cellOf(key!), route)).toBe(false);
        expect(captureDeterministicRandomState()).toEqual(state);
    });
});
