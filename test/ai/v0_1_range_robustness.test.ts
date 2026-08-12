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

import { getAIStrategy, type IDecisionContext } from "../../src/ai";
import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

describe("v0.1 ranged-fire robustness", () => {
    test("skips a Terrifying Gaze target even when that unit is the ray's first intersection", () => {
        const combat = createCombatTestContext();
        const shooter = createTestUnit({
            name: "Gaze-aware shooter",
            team: PBTypes.TeamVals.LOWER,
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 5,
            shotDistance: 30,
        });
        const forbidden = createTestUnit({
            name: "Forbidden gazer",
            team: PBTypes.TeamVals.UPPER,
            attackType: PBTypes.AttackVals.MELEE,
        });
        const legal = createTestUnit({
            name: "Legal alternate",
            team: PBTypes.TeamVals.UPPER,
            attackType: PBTypes.AttackVals.MELEE,
        });
        placeUnit(combat.grid, combat.unitsHolder, shooter, { x: 2, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, forbidden, { x: 8, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, legal, { x: 9, y: 8 });
        shooter.setForbiddenTarget(forbidden.getId());
        shooter.refreshPossibleAttackTypes(true);

        const fightProperties = FightStateManager.getInstance().getFightProperties();
        fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LOWER, 1);
        fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.UPPER, 2);
        const context: IDecisionContext = {
            grid: combat.grid,
            matrix: combat.grid.getMatrix(),
            unitsHolder: combat.unitsHolder,
            pathHelper: new PathHelper(testGridSettings),
            attackHandler: combat.attackHandler,
            fightProperties,
        };
        const actions = getAIStrategy("v0.1").decideTurn(shooter, context);
        const shot = actions.find(
            (action): action is Extract<GameAction, { type: "range_attack" }> => action.type === "range_attack",
        );
        expect(shot).toBeDefined();
        expect(shot?.targetId).toBe(legal.getId());

        fightProperties.startFight();
        fightProperties.startTurn(shooter.getTeam(), 1_000);
        const engine = new GameActionEngine({
            fightProperties,
            grid: combat.grid,
            unitsHolder: combat.unitsHolder,
            moveHandler: new MoveHandler(testGridSettings, combat.grid, combat.unitsHolder),
            sceneLog: new SceneLogMock(),
            attackHandler: combat.attackHandler,
            getCurrentActiveUnitId: () => shooter.getId(),
            getCurrentEnemiesCellsWithinMovementRange: () => [],
        });
        expect(actions.map((action) => engine.apply(action).completed)).toEqual(actions.map(() => true));
        expect(forbidden.getCumulativeHp()).toBe(forbidden.getCumulativeMaxHp());
        expect(legal.getCumulativeHp()).toBeLessThan(legal.getCumulativeMaxHp());
    });
});
