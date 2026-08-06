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

import { AbilityFactory } from "../../src/abilities/ability_factory";
import type { IDecisionContext } from "../../src/ai";
import { StrategyV0_7 } from "../../src/ai/versions/v0_7";
import { StrategyV0_8 } from "../../src/ai/versions/v0_8";
import { StrategyV0_8S } from "../../src/ai/versions/v0_8s";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Unit } from "../../src/units/unit";
import {
    createCombatTestContext,
    createTestUnit,
    placeUnit,
    testGridSettings,
    type CombatTestContext,
} from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const MELEE = PBTypes.AttackVals.MELEE;

function makeTrent(): Unit {
    const effectFactory = new EffectFactory();
    const trent = Unit.createUnit(
        getCreatureConfig(LOWER, "Nature", "Trent", "", 100),
        testGridSettings,
        LOWER,
        PBTypes.UnitVals.CREATURE,
        new AbilityFactory(effectFactory),
        effectFactory,
        false,
    );
    trent.setStackPower(5);
    return trent;
}

function contextFor(combat: CombatTestContext): IDecisionContext {
    return {
        grid: combat.grid,
        matrix: combat.grid.getMatrix(),
        unitsHolder: combat.unitsHolder,
        pathHelper: new PathHelper(testGridSettings),
        attackHandler: combat.attackHandler,
        fightProperties: FightStateManager.getInstance().getFightProperties(),
    };
}

function castAction(actions: readonly GameAction[]): Extract<GameAction, { type: "cast_spell" }> | undefined {
    return actions.find(
        (action): action is Extract<GameAction, { type: "cast_spell" }> => action.type === "cast_spell",
    );
}

function startEngine(combat: CombatTestContext, active: Unit, context: IDecisionContext): GameActionEngine {
    const fightProperties = context.fightProperties!;
    fightProperties.startFight();
    fightProperties.setTeamUnitsAlive(LOWER, combat.unitsHolder.getAllAllies(LOWER).length);
    fightProperties.setTeamUnitsAlive(UPPER, combat.unitsHolder.getAllAllies(UPPER).length);
    fightProperties.startTurn(active.getTeam(), 1_000);
    return new GameActionEngine({
        fightProperties,
        grid: combat.grid,
        unitsHolder: combat.unitsHolder,
        moveHandler: new MoveHandler(testGridSettings, combat.grid, combat.unitsHolder),
        sceneLog: new SceneLogMock(),
        attackHandler: combat.attackHandler,
        getCurrentActiveUnitId: () => active.getId(),
        getCurrentEnemiesCellsWithinMovementRange: () => [],
    });
}

describe("v0.8 Vine Throw policy", () => {
    it("originates and executes Vine Throw instead of a pure advance in both production aliases", () => {
        const combat = createCombatTestContext();
        const trent = makeTrent();
        const target = createTestUnit({
            team: UPPER,
            name: "Distant threat",
            attackType: MELEE,
            speed: 6,
            damageMax: 20,
            amountAlive: 5,
            magicResist: 0,
        });
        placeUnit(combat.grid, combat.unitsHolder, trent, { x: 7, y: 3 });
        placeUnit(combat.grid, combat.unitsHolder, target, { x: 7, y: 12 });
        const context = contextFor(combat);

        expect(new StrategyV0_7().decideTurn(trent, context).some((action) => action.type === "move_unit")).toBe(true);
        const production = castAction(new StrategyV0_8().decideTurn(trent, context));
        const trainingAlias = castAction(new StrategyV0_8S().decideTurn(trent, context));
        expect(production).toMatchObject({ spellName: "Vine Throw", targetId: target.getId() });
        expect(trainingAlias).toMatchObject({ spellName: "Vine Throw", targetId: target.getId() });

        const charge = trent.getSpells().find((spell) => spell.getName() === "Vine Throw");
        expect(charge?.getAmount()).toBe(1);
        const result = startEngine(combat, trent, context).apply(production!);
        expect(result.completed).toBe(true);
        expect(charge?.getAmount()).toBe(0);
        expect(target.hasDebuffActive("Vine Throw")).toBe(true);
        expect(context.fightProperties!.getVines().size()).toBeGreaterThan(0);
    });

    it("targets the highest mobility-weighted live stack output", () => {
        const combat = createCombatTestContext();
        const trent = makeTrent();
        const weak = createTestUnit({
            team: UPPER,
            name: "Weak scout",
            attackType: MELEE,
            speed: 1,
            damageMax: 1,
            amountAlive: 1,
        });
        const dangerous = createTestUnit({
            team: UPPER,
            name: "Fast threat",
            attackType: MELEE,
            speed: 7,
            damageMax: 30,
            amountAlive: 10,
        });
        placeUnit(combat.grid, combat.unitsHolder, trent, { x: 2, y: 2 });
        placeUnit(combat.grid, combat.unitsHolder, weak, { x: 2, y: 12 });
        placeUnit(combat.grid, combat.unitsHolder, dangerous, { x: 12, y: 2 });

        expect(castAction(new StrategyV0_8().decideTurn(trent, contextFor(combat)))).toMatchObject({
            spellName: "Vine Throw",
            targetId: dangerous.getId(),
        });
    });

    it("preserves immediate melee and never proposes a blocked throw", () => {
        const adjacentCombat = createCombatTestContext();
        const adjacentTrent = makeTrent();
        const adjacent = createTestUnit({ team: UPPER, name: "Reachable enemy", attackType: MELEE });
        placeUnit(adjacentCombat.grid, adjacentCombat.unitsHolder, adjacentTrent, { x: 7, y: 3 });
        // One cell closer than the original fixture: Trent's 3.9 steps no longer round up to 4 (the
        // pure-fractional owner call), and this test is about PREFERRING melee when it is genuinely
        // reachable — three straight cells to (7,6), then the swing.
        placeUnit(adjacentCombat.grid, adjacentCombat.unitsHolder, adjacent, { x: 7, y: 7 });
        const immediate = new StrategyV0_8().decideTurn(adjacentTrent, contextFor(adjacentCombat));
        expect(castAction(immediate)).toBeUndefined();
        expect(immediate.some((action) => action.type === "melee_attack")).toBe(true);

        const blockedCombat = createCombatTestContext();
        const blockedTrent = makeTrent();
        const blocker = createTestUnit({ team: LOWER, name: "Friendly blocker", attackType: MELEE });
        const blockedTarget = createTestUnit({ team: UPPER, name: "Blocked enemy", attackType: MELEE });
        placeUnit(blockedCombat.grid, blockedCombat.unitsHolder, blockedTrent, { x: 7, y: 3 });
        placeUnit(blockedCombat.grid, blockedCombat.unitsHolder, blocker, { x: 7, y: 6 });
        placeUnit(blockedCombat.grid, blockedCombat.unitsHolder, blockedTarget, { x: 7, y: 12 });
        expect(castAction(new StrategyV0_8().decideTurn(blockedTrent, contextFor(blockedCombat)))).toBeUndefined();
    });
});
