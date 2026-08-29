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
import { enumerateCandidates, type IEnumeratedCandidate } from "../../src/ai/candidates";
import { prioritizeV08SplashRangedDecision, StrategyV0_8 } from "../../src/ai/versions/v0_8";
import { StrategyV0_7 } from "../../src/ai/versions/v0_7";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getPositionForCells } from "../../src/grid/grid_math";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Unit } from "../../src/units/unit";
import type { XY } from "../../src/utils/math";
import {
    createCombatTestContext,
    createTestUnit,
    placeUnit,
    testGridSettings,
    type CombatTestContext,
} from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;
const MELEE = PBTypes.AttackVals.MELEE;

function contextFor(combat: CombatTestContext): IDecisionContext {
    return {
        grid: combat.grid,
        matrix: combat.grid.getMatrix(),
        unitsHolder: combat.unitsHolder,
        pathHelper: new PathHelper(testGridSettings),
        attackHandler: combat.attackHandler,
    };
}

function makeReal(team: number, faction: string, name: string): Unit {
    const effectFactory = new EffectFactory();
    const abilityFactory = new AbilityFactory(effectFactory);
    return Unit.createUnit(
        getCreatureConfig(team, faction, name, "", 100),
        testGridSettings,
        team,
        PBTypes.UnitVals.CREATURE,
        abilityFactory,
        effectFactory,
        false,
    );
}

function placeLarge(combat: CombatTestContext, unit: Unit, base: XY): void {
    const cells = [
        { x: base.x, y: base.y },
        { x: base.x - 1, y: base.y },
        { x: base.x, y: base.y - 1 },
        { x: base.x - 1, y: base.y - 1 },
    ];
    const position = getPositionForCells(testGridSettings, cells);
    if (!position) {
        throw new Error("Invalid large-unit test placement");
    }
    unit.setPosition(position.x, position.y);
    combat.grid.occupyCells(
        cells,
        unit.getId(),
        unit.getTeam(),
        unit.getAttackRange(),
        unit.hasAbilityActive("Made of Fire"),
        unit.hasAbilityActive("Made of Water"),
    );
    combat.unitsHolder.addUnit(unit);
}

function lastAction(actions: readonly GameAction[]): GameAction {
    const action = actions.at(-1);
    if (!action) {
        throw new Error("Expected at least one action");
    }
    return action;
}

function activateEngine(combat: CombatTestContext, unit: Unit): GameActionEngine {
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(PBTypes.GridVals.NORMAL);
    fightProperties.startFight();
    fightProperties.setTeamUnitsAlive(LEFT, combat.unitsHolder.getAllAllies(LEFT).length);
    fightProperties.setTeamUnitsAlive(RIGHT, combat.unitsHolder.getAllAllies(RIGHT).length);
    fightProperties.startTurn(unit.getTeam(), 1_000);
    return new GameActionEngine({
        fightProperties,
        grid: combat.grid,
        unitsHolder: combat.unitsHolder,
        moveHandler: new MoveHandler(testGridSettings, combat.grid, combat.unitsHolder),
        sceneLog: new SceneLogMock(),
        attackHandler: combat.attackHandler,
        getCurrentActiveUnitId: () => unit.getId(),
    });
}

function expectActionsToApply(engine: GameActionEngine, actions: readonly GameAction[]): void {
    for (const action of actions) {
        const result = engine.apply(action);
        expect(result.completed, `${action.type}: ${result.rejectionReason ?? "rejected"}`).toBe(true);
    }
}

function shots(candidates: readonly IEnumeratedCandidate[]): IEnumeratedCandidate[] {
    return candidates.filter((candidate) => candidate.kind === "shot");
}

function sameRangeAction(left: readonly GameAction[], right: readonly GameAction[]): boolean {
    const leftAction = lastAction(left);
    const rightAction = lastAction(right);
    return (
        leftAction.type === "range_attack" &&
        rightAction.type === "range_attack" &&
        leftAction.targetId === rightAction.targetId &&
        leftAction.aimSide === rightAction.aimSide &&
        leftAction.aimCell?.x === rightAction.aimCell?.x &&
        leftAction.aimCell?.y === rightAction.aimCell?.y
    );
}

function sameAreaThrowAction(left: readonly GameAction[], right: readonly GameAction[]): boolean {
    const leftAction = lastAction(left);
    const rightAction = lastAction(right);
    return (
        leftAction.type === "area_throw_attack" &&
        rightAction.type === "area_throw_attack" &&
        leftAction.targetCell.x === rightAction.targetCell.x &&
        leftAction.targetCell.y === rightAction.targetCell.y
    );
}

describe("v0.8 ranged splash targeting", () => {
    it("upgrades Gargantuan's ordinary shot to the highest-value Area Throw cluster", () => {
        const combat = createCombatTestContext();
        const gargantuan = makeReal(LEFT, "Nature", "Gargantuan");
        const enemyA = createTestUnit({ team: RIGHT, name: "Cluster A", attackType: MELEE, amountAlive: 20 });
        const enemyB = createTestUnit({ team: RIGHT, name: "Cluster B", attackType: MELEE, amountAlive: 20 });
        placeLarge(combat, gargantuan, { x: 3, y: 3 });
        placeUnit(combat.grid, combat.unitsHolder, enemyA, { x: 10, y: 9 });
        placeUnit(combat.grid, combat.unitsHolder, enemyB, { x: 10, y: 11 });
        const context = contextFor(combat);

        expect(lastAction(new StrategyV0_7().decideTurn(gargantuan, context)).type).toBe("range_attack");
        const actions = new StrategyV0_8().decideTurn(gargantuan, context);
        expect(lastAction(actions).type).toBe("area_throw_attack");
        const throws = enumerateCandidates(gargantuan, context, [
            { type: "end_turn", unitId: gargantuan.getId(), reason: "manual" },
        ]).candidates.filter((candidate) => candidate.kind === "area_throw");
        const selected = throws.find((candidate) => sameAreaThrowAction(candidate.actions, actions));
        expect(selected).toBeDefined();
        expect(selected!.features.expectedDamage).toBe(
            Math.max(...throws.map((candidate) => candidate.features.expectedDamage)),
        );
        expectActionsToApply(activateEngine(combat, gargantuan), actions);
    });

    it("retargets Cyclops from an allied splash to the higher-value clean enemy cluster", () => {
        const combat = createCombatTestContext();
        const cyclops = makeReal(LEFT, "Might", "Cyclops");
        const harmfulTarget = createTestUnit({
            team: RIGHT,
            name: "Harmful target",
            attackType: MELEE,
            amountAlive: 20,
        });
        const harmedAlly = createTestUnit({ team: LEFT, name: "Splash ally", attackType: MELEE, amountAlive: 20 });
        const clusterA = createTestUnit({ team: RIGHT, name: "Safe cluster A", attackType: MELEE, amountAlive: 20 });
        const clusterB = createTestUnit({ team: RIGHT, name: "Safe cluster B", attackType: MELEE, amountAlive: 20 });
        placeUnit(combat.grid, combat.unitsHolder, cyclops, { x: 5, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, harmfulTarget, { x: 8, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, harmedAlly, { x: 8, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, clusterA, { x: 5, y: 8 });
        placeUnit(combat.grid, combat.unitsHolder, clusterB, { x: 6, y: 8 });
        cyclops.refreshPossibleAttackTypes(true);
        const context = contextFor(combat);
        const candidates = shots(
            enumerateCandidates(cyclops, context, [{ type: "end_turn", unitId: cyclops.getId(), reason: "manual" }])
                .candidates,
        );
        const harmful = candidates.find(
            (candidate) =>
                candidate.targetId === harmfulTarget.getId() && (candidate.shotFeatures?.friendlyFireDamage ?? 0) > 0,
        );
        expect(harmful).toBeDefined();

        const retargeted = prioritizeV08SplashRangedDecision(cyclops, context, harmful!.actions);
        const selected = candidates.find((candidate) => sameRangeAction(candidate.actions, retargeted));
        expect(selected).toBeDefined();
        expect(selected!.features.expectedDamage).toBeGreaterThan(harmful!.features.expectedDamage);
        expect(selected!.shotFeatures?.enemyDamage).toBeGreaterThan(harmful!.shotFeatures!.enemyDamage);
        expect(selected!.shotFeatures?.friendlyFireDamage).toBe(0);
        expectActionsToApply(activateEngine(combat, cyclops), retargeted);
    });
});
