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

import { AbilityFactory } from "../../src/abilities/ability_factory";
import { getAIStrategy, type IDecisionContext } from "../../src/ai";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameAction } from "../../src/engine/actions";
import { TurnEngine } from "../../src/engine/turn_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { TeamType } from "../../src/generated/protobuf/v1/types_gen";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import type { ILookaheadDeps } from "../../src/simulation/lookahead";
import type { ISearchBudgetedDecision, ISearchDecisionBudget, SearchDriver } from "../../src/simulation/search_driver";
import {
    createV08A19DeepFitSearchDriver,
    V08_A19_DEEP_FIT,
    V08A19DeepFitSearchDriver,
} from "../../src/simulation/v0_8_a19_deep_fit";
import { createV08A19SearchDriver } from "../../src/simulation/v0_8_a19_search";
import { Unit } from "../../src/units/unit";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, placeUnit, testGridSettings } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT,
    RIGHT = PBTypes.TeamVals.RIGHT;
const MATCH = { greenVersion: "v0.8", redVersion: "v0.8", seed: 20261121, offlineDeterministicWork: true };

function fixture() {
    const combat = createCombatTestContext();
    const effects = new EffectFactory();
    const add = (team: TeamType, faction: string, name: string, amount: number, cell: XY) => {
        const unit = Unit.createUnit(
            getCreatureConfig(team, faction, name, "", amount),
            testGridSettings,
            team,
            PBTypes.UnitVals.CREATURE,
            new AbilityFactory(effects),
            effects,
            false,
        );
        placeUnit(combat.grid, combat.unitsHolder, unit, cell);
        return unit;
    };
    const griffin = add(LEFT, "Life", "Griffin", 9, { x: 2, y: 7 });
    const ownWolf = add(LEFT, "Nature", "Wolf", 8, { x: 2, y: 10 });
    const enemyWolf = add(RIGHT, "Nature", "Wolf", 8, { x: 12, y: 7 });
    const enemyGriffin = add(RIGHT, "Life", "Griffin", 9, { x: 13, y: 10 });
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setSideOrientedPlacement(true);
    let active = griffin.getId();
    const engineContext = {
        ...combat,
        fightProperties,
        moveHandler: new MoveHandler(testGridSettings, combat.grid, combat.unitsHolder),
        sceneLog: new SceneLogMock(),
        getCurrentActiveUnitId: () => active,
    };
    const engine = new GameActionEngine(engineContext);
    const context: IDecisionContext = {
        ...combat,
        matrix: combat.grid.getMatrix(),
        pathHelper: new PathHelper(testGridSettings),
        fightProperties,
        decisionOrigin: "root",
    };
    const deps = {
        ...combat,
        engine,
        fightProperties,
        pathHelper: context.pathHelper,
        turnEngine: new TurnEngine(engineContext),
        getActiveUnitId: () => active,
        setActiveUnitId: (id: string) => {
            active = id;
        },
        strategyForTeam: () => getAIStrategy("v0.8"),
        damageDealtThisLap: () => false,
        captureDamageStats: () => [...combat.damageStatisticHolder.get()],
        restoreDamageStats: (rows: ReturnType<typeof combat.damageStatisticHolder.get>) => {
            combat.damageStatisticHolder.clear();
            for (const row of rows) combat.damageStatisticHolder.add(row);
        },
    } as unknown as ILookaheadDeps;
    expect(engine.apply({ type: "start_fight" }).completed).toBe(true);
    fightProperties.startTurn(LEFT, 1_000);
    for (const unit of [griffin, ownWolf, enemyWolf, enemyGriffin]) unit.setStackPower(5);
    context.matrix = combat.grid.getMatrix();
    const board = () =>
        JSON.stringify(
            [...combat.unitsHolder.getAllUnits().values()].map((unit) => [
                unit.getId(),
                unit.getBaseCell(),
                unit.getAmountAlive(),
                unit.getCumulativeHp(),
            ]),
        );
    const incumbent = () => getAIStrategy("v0.8").decideTurn(griffin, context);
    const driver = () => {
        const created = createV08A19SearchDriver(deps, MATCH);
        created.onFightReady();
        return created;
    };
    return { griffin, context, deps, board, incumbent, driver };
}

describe("SearchDriver.chooseDecisionWithinBudget", () => {
    test("without limits it decides exactly as chooseDecision and reports the rollout turns it simulated", () => {
        const f = fixture();
        const plain = f.driver().chooseDecision(f.griffin, "v0.8", f.incumbent(), f.context);
        const budgeted = f.driver().chooseDecisionWithinBudget(f.griffin, "v0.8", f.incumbent(), f.context, {});
        expect(budgeted.actions).toEqual(plain);
        expect(budgeted.withinBudget).toBe(true);
        expect(budgeted.rolloutTurns).toBeGreaterThan(1);
    });

    test("a limit of exactly the search's work completes it; one turn less ends it and leaves the battle as it was", () => {
        const f = fixture();
        const full = f.driver().chooseDecisionWithinBudget(f.griffin, "v0.8", f.incumbent(), f.context, {});
        const exact = f
            .driver()
            .chooseDecisionWithinBudget(f.griffin, "v0.8", f.incumbent(), f.context, {
                rolloutTurns: full.rolloutTurns,
            });
        expect(exact).toEqual(full);
        const before = f.board();
        const cut = f.driver().chooseDecisionWithinBudget(f.griffin, "v0.8", f.incumbent(), f.context, {
            rolloutTurns: full.rolloutTurns - 1,
        });
        expect(cut.withinBudget).toBe(false);
        expect(cut.rolloutTurns).toBeLessThanOrEqual(full.rolloutTurns);
        expect(f.board()).toBe(before);
        const after = f.driver().chooseDecisionWithinBudget(f.griffin, "v0.8", f.incumbent(), f.context, {});
        expect(after).toEqual(full);
    });

    test("rejects malformed budgets", () => {
        const f = fixture();
        const driver = f.driver();
        for (const budget of [
            { rolloutTurns: -1 },
            { rolloutTurns: 1.5 },
            { deadlineMs: 0 },
            { deadlineMs: Number.NaN },
        ])
            expect(() =>
                driver.chooseDecisionWithinBudget(f.griffin, "v0.8", f.incumbent(), f.context, budget),
            ).toThrow();
    });
});

type Scripted = { result: Omit<ISearchBudgetedDecision, "actions">; actions: GameAction[] };
function stub(scripted: Scripted, calls: ISearchDecisionBudget[], onCall = () => {}) {
    return {
        chooseDecisionWithinBudget: (
            _unit: Unit,
            _version: string,
            _incumbent: GameAction[],
            _context: IDecisionContext | undefined,
            budget: ISearchDecisionBudget,
        ): ISearchBudgetedDecision => {
            calls.push(budget);
            onCall();
            return { ...scripted.result, actions: scripted.actions };
        },
        onFightReady: () => {},
        onMatchEnd: () => {},
    } as unknown as SearchDriver;
}

describe("V08A19DeepFitSearchDriver", () => {
    const unit = {} as Unit;
    const STOCK: GameAction[] = [{ type: "wait_turn", unitId: "stock" }];
    const DEEP: GameAction[] = [{ type: "defend_turn", unitId: "deep" }];
    const run = (
        stockTurns: number,
        deep: { withinBudget: boolean; rolloutTurns: number },
        offline = true,
        elapsedMs = 0,
    ) => {
        const stockCalls: ISearchDecisionBudget[] = [];
        const deepCalls: ISearchDecisionBudget[] = [];
        let clock = 0;
        const driver = new V08A19DeepFitSearchDriver(
            stub({ result: { withinBudget: true, rolloutTurns: stockTurns }, actions: STOCK }, stockCalls, () => {
                clock += elapsedMs;
            }),
            stub({ result: deep, actions: DEEP }, deepCalls),
            offline,
            () => clock,
        );
        const chosen = driver.chooseDecision(unit, "v0.8", [], undefined);
        return { chosen, stockCalls, deepCalls, statistics: driver.statistics };
    };

    test("keeps the stock choice when the stock work predicts the deep search cannot fit", () => {
        const stockTurns =
            Math.floor(V08_A19_DEEP_FIT.rolloutTurnBudget / (1 + V08_A19_DEEP_FIT.predictedDeepToStockRatio)) + 1;
        const r = run(stockTurns, { withinBudget: true, rolloutTurns: 1 });
        expect(r.chosen).toBe(STOCK);
        expect(r.deepCalls).toHaveLength(0);
        expect(r.statistics).toEqual({ decisions: 1, attempted: 0, played: 0, overran: 0 });
    });

    test("gives the deep search the turns the stock search left and plays it when it completes within them", () => {
        const r = run(200, { withinBudget: true, rolloutTurns: 900 });
        expect(r.stockCalls).toEqual([{}]);
        expect(r.deepCalls).toEqual([{ rolloutTurns: V08_A19_DEEP_FIT.rolloutTurnBudget - 200 }]);
        expect(r.chosen).toBe(DEEP);
        expect(r.statistics).toEqual({ decisions: 1, attempted: 1, played: 1, overran: 0 });
    });

    test("falls back to the stock choice when the deep search does not complete within its budget", () => {
        const r = run(200, { withinBudget: false, rolloutTurns: 1200 });
        expect(r.chosen).toBe(STOCK);
        expect(r.statistics).toEqual({ decisions: 1, attempted: 1, played: 0, overran: 1 });
    });

    test("under live timing the deep search gets the think time left and is skipped when none is left", () => {
        const live = run(100, { withinBudget: true, rolloutTurns: 300 }, false, 350);
        expect(live.deepCalls).toEqual([
            { rolloutTurns: V08_A19_DEEP_FIT.rolloutTurnBudget - 100, deadlineMs: V08_A19_DEEP_FIT.thinkMs - 350 },
        ]);
        expect(live.chosen).toBe(DEEP);
        const late = run(100, { withinBudget: true, rolloutTurns: 300 }, false, V08_A19_DEEP_FIT.thinkMs);
        expect(late.deepCalls).toHaveLength(0);
        expect(late.chosen).toBe(STOCK);
    });

    test("builds the unchanged stock driver and a deep driver with the deep budget and the think deadline", () => {
        const f = fixture();
        const composite = createV08A19DeepFitSearchDriver(f.deps, MATCH) as unknown as {
            stock: Record<string, unknown>;
            deep: Record<string, unknown>;
        };
        const stock = createV08A19SearchDriver(f.deps, MATCH) as unknown as Record<string, unknown>;
        for (const key of ["rollouts", "shortlist", "caps", "horizon", "decisionDeadlineMs", "circuitBreakerMs"])
            expect(composite.stock[key]).toEqual(stock[key]);
        expect(composite.deep).toMatchObject({
            rollouts: 8,
            shortlist: 10,
            caps: { ...(stock.caps as object), maxMeleePairs: 16 },
            horizon: stock.horizon,
            decisionDeadlineMs: V08_A19_DEEP_FIT.thinkMs,
            circuitBreakerMs: V08_A19_DEEP_FIT.thinkMs * 30,
        });
    });
});
