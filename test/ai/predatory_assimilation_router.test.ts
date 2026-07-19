/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import type { IDecisionContext } from "../../src/ai";
import { getEnemiesCellsWithinMovementRange } from "../../src/ai/candidates";
import { routeArachnaQueenAssimilation } from "../../src/ai/versions/predatory_assimilation_router";
import { StrategyV0_7 } from "../../src/ai/versions/v0_7";
import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import type { Unit } from "../../src/units/unit";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const MELEE = PBTypes.AttackVals.MELEE;
const RANGE = PBTypes.AttackVals.RANGE;

interface QueenHarness {
    queen: Unit;
    context: IDecisionContext;
    engine: GameActionEngine;
}

function setupQueen(): QueenHarness {
    const combat = createCombatTestContext();
    const queen = createTestUnit({
        name: "Arachna Queen",
        team: LOWER,
        attackType: MELEE,
        shotDistance: 0,
        speed: 6.3,
        amountAlive: 5,
        maxHp: 180,
        stackPower: 5,
        abilities: ["Predatory Assimilation"],
    });
    const ally = createTestUnit({ name: "Ally", team: LOWER, amountAlive: 5 });
    const enemy = createTestUnit({ name: "Enemy", team: UPPER, amountAlive: 50, maxHp: 100 });
    placeUnit(combat.grid, combat.unitsHolder, queen, { x: 3, y: 3 });
    placeUnit(combat.grid, combat.unitsHolder, ally, { x: 5, y: 3 });
    placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 10, y: 10 });

    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(combat.grid.getGridType());
    fightProperties.startFight();
    fightProperties.setTeamUnitsAlive(LOWER, 2);
    fightProperties.setTeamUnitsAlive(UPPER, 1);
    fightProperties.startTurn(LOWER, 1_000);

    const context: IDecisionContext = {
        grid: combat.grid,
        matrix: combat.grid.getMatrix(),
        unitsHolder: combat.unitsHolder,
        pathHelper: new PathHelper(testGridSettings),
        attackHandler: combat.attackHandler,
        fightProperties,
    };
    const engine = new GameActionEngine({
        fightProperties,
        grid: combat.grid,
        unitsHolder: combat.unitsHolder,
        moveHandler: new MoveHandler(testGridSettings, combat.grid, combat.unitsHolder),
        sceneLog: new SceneLogMock(),
        attackHandler: combat.attackHandler,
        getCurrentActiveUnitId: () => queen.getId(),
        getCurrentEnemiesCellsWithinMovementRange: () => getEnemiesCellsWithinMovementRange(queen, context),
    });
    return { queen, context, engine };
}

function refreshRuntimeCapabilities(harness: QueenHarness): void {
    harness.queen.adjustBaseStats(true, 1, 0, 0, 0, 0, 0);
    harness.queen.setStackPower(5);
    harness.queen.refreshPossibleAttackTypes(
        harness.context.attackHandler!.canLandRangeAttack(
            harness.queen,
            harness.context.grid.getEnemyAggrMatrixByUnitId(harness.queen.getId()),
        ),
    );
}

function applyDecision(engine: GameActionEngine, decision: GameAction[]) {
    return decision.map((action) => ({ action, result: engine.apply(action) }));
}

describe("Arachna Queen Predatory Assimilation AI routing", () => {
    it("selects RANGE and completes a shot after stealing Endless Quiver", () => {
        const harness = setupQueen();
        harness.queen.grantStolenAbility("Endless Quiver");
        refreshRuntimeCapabilities(harness);

        expect(harness.queen.getAttackType()).toBe(MELEE);
        expect(harness.queen.isRangeCapable()).toBe(true);
        expect(harness.queen.getPossibleAttackTypes()).toContain(RANGE);

        const decision = new StrategyV0_7().decideTurn(harness.queen, harness.context);
        expect(decision.map((action) => action.type)).toEqual(["select_attack_type", "range_attack"]);
        const executions = applyDecision(harness.engine, decision);

        expect(executions.every(({ result }) => result.completed)).toBe(true);
        expect(executions[0].action).toMatchObject({ type: "select_attack_type", attackType: RANGE });
        expect(executions[1].result.events).toContainEqual(
            expect.objectContaining({ type: "unit_attacked", attackType: "range", attackerId: harness.queen.getId() }),
        );
    });

    it("chooses and completes a legal remaining spellbook cast", () => {
        const harness = setupQueen();
        harness.queen.grantStolenAbility("Forest Spellbook", ["Life:Courage"]);
        refreshRuntimeCapabilities(harness);

        const decision = new StrategyV0_7().decideTurn(harness.queen, harness.context);
        expect(decision).toHaveLength(1);
        expect(decision[0]).toMatchObject({ type: "cast_spell", spellName: "Courage" });
        const [execution] = applyDecision(harness.engine, decision);

        expect(execution.result.completed, execution.result.rejectionReason).toBe(true);
        expect(execution.result.events).toContainEqual(
            expect.objectContaining({ type: "spell_cast", casterId: harness.queen.getId(), spellName: "Courage" }),
        );
        expect(harness.queen.hasSpellRemaining("Courage")).toBe(false);
    });

    it("chooses and completes a legal direct-ability spell cast", () => {
        const harness = setupQueen();
        harness.queen.grantStolenAbility("Battle Roar", [":Battle Roar"]);
        refreshRuntimeCapabilities(harness);

        const decision = new StrategyV0_7().decideTurn(harness.queen, harness.context);
        expect(decision).toEqual([{ type: "cast_spell", casterId: harness.queen.getId(), spellName: "Battle Roar" }]);
        const [execution] = applyDecision(harness.engine, decision);

        expect(execution.result.completed, execution.result.rejectionReason).toBe(true);
        expect(execution.result.events).toContainEqual(
            expect.objectContaining({ type: "spell_cast", casterId: harness.queen.getId(), spellName: "Battle Roar" }),
        );
        expect(harness.queen.hasSpellRemaining("Battle Roar")).toBe(false);
    });

    it("does not fabricate a fresh direct-ability cast when no charge remained to steal", () => {
        const harness = setupQueen();
        harness.queen.grantStolenAbility("Battle Roar", []);
        refreshRuntimeCapabilities(harness);

        expect(harness.queen.hasAbilityActive("Battle Roar")).toBe(true);
        expect(harness.queen.hasSpellRemaining("Battle Roar")).toBe(false);
        expect(new StrategyV0_7().decideTurn(harness.queen, harness.context)).not.toContainEqual(
            expect.objectContaining({ type: "cast_spell", spellName: "Battle Roar" }),
        );
    });

    it("is an exact no-op for native units and a Queen without runtime capabilities", () => {
        const harness = setupQueen();
        refreshRuntimeCapabilities(harness);
        const incumbent: GameAction[] = [{ type: "end_turn", unitId: harness.queen.getId(), reason: "manual" }];

        expect(routeArachnaQueenAssimilation(harness.queen, harness.context, incumbent)).toBe(incumbent);
        const nativeMelee = createTestUnit({ name: "Squire", team: LOWER });
        expect(routeArachnaQueenAssimilation(nativeMelee, harness.context, incumbent)).toBe(incumbent);
    });
});
