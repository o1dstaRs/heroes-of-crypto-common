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

import { getAIStrategy, type IDecisionContext } from "../../src/ai";
import { AIActionType, findTarget, recordAITargetMemory } from "../../src/ai/ai";
import type { IReadonlyWeightedRoute } from "../../src/ai/decision_path_catalog";
import { StrategyV0_1 } from "../../src/ai/versions/v0_1";
import { getSpellConfig } from "../../src/configuration/config_provider";
import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getPositionForCells } from "../../src/grid/grid_math";
import { PathHelper } from "../../src/grid/path_helper";
import type { IWeightedRoute } from "../../src/grid/path_definitions";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Spell } from "../../src/spells/spell";
import type { Unit } from "../../src/units/unit";
import type { XY } from "../../src/utils/math";
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
const MELEE_MAGIC = PBTypes.AttackVals.MELEE_MAGIC;
const MAGIC = PBTypes.AttackVals.MAGIC;
const RANGE = PBTypes.AttackVals.RANGE;

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

function meleeAction(actions: GameAction[]): Extract<GameAction, { type: "melee_attack" }> | undefined {
    return actions.find(
        (action): action is Extract<GameAction, { type: "melee_attack" }> => action.type === "melee_attack",
    );
}

function applyCowardice(unit: Unit): void {
    unit.applyDebuff(new Spell({ spellProperties: getSpellConfig("Order", "Cowardice"), amount: 1 }));
}

function setTeamCensus(combat: CombatTestContext): void {
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setTeamUnitsAlive(LOWER, combat.unitsHolder.getAllAllies(LOWER).length);
    fightProperties.setTeamUnitsAlive(UPPER, combat.unitsHolder.getAllAllies(UPPER).length);
}

class ExposedStrategyV0_1 extends StrategyV0_1 {
    public completeValidatedMove(unit: Unit, context: IDecisionContext, route: IReadonlyWeightedRoute): GameAction[] {
        return this.completeMoveWithAdjacentMelee(unit, context, route);
    }
}

function routeTo(cell: XY, route: XY[]): IWeightedRoute {
    return {
        cell,
        route,
        weight: route.length - 1,
        firstAggrMet: false,
        hasLavaCell: false,
        hasWaterCell: false,
    };
}

function startActionEngine(
    combat: CombatTestContext,
    unit: Unit,
    context: IDecisionContext,
    getCurrentActiveKnownPaths?: () => Map<number, IWeightedRoute[]> | undefined,
): GameActionEngine {
    const fightProperties = context.fightProperties!;
    setTeamCensus(combat);
    fightProperties.startFight();
    fightProperties.startTurn(unit.getTeam(), 1_000);
    return new GameActionEngine({
        fightProperties,
        grid: combat.grid,
        unitsHolder: combat.unitsHolder,
        moveHandler: new MoveHandler(testGridSettings, combat.grid, combat.unitsHolder),
        sceneLog: new SceneLogMock(),
        attackHandler: combat.attackHandler,
        getCurrentActiveUnitId: () => unit.getId(),
        getCurrentActiveKnownPaths,
        getCurrentEnemiesCellsWithinMovementRange: () => [],
    });
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
        throw new Error("invalid large-unit test placement");
    }
    unit.setPosition(position.x, position.y);
    expect(
        combat.grid.occupyCells(
            cells,
            unit.getId(),
            unit.getTeam(),
            unit.getAttackRange(),
            unit.hasAbilityActive("Made of Fire"),
            unit.hasAbilityActive("Made of Water"),
        ),
    ).toBe(true);
    combat.unitsHolder.addUnit(unit);
}

function boxedMindlessBerserker(): { combat: CombatTestContext; attacker: Unit; context: IDecisionContext } {
    const combat = createCombatTestContext();
    const attacker = createTestUnit({
        name: "Berserker",
        team: LOWER,
        attackType: MELEE,
        abilities: ["AI Driven"],
    });
    placeUnit(combat.grid, combat.unitsHolder, attacker, { x: 5, y: 5 });
    for (const [index, cell] of [
        { x: 4, y: 4 },
        { x: 5, y: 4 },
        { x: 6, y: 4 },
        { x: 4, y: 5 },
        { x: 6, y: 5 },
        { x: 4, y: 6 },
        { x: 5, y: 6 },
        { x: 6, y: 6 },
    ].entries()) {
        const ally = createTestUnit({ name: `Ally ${index}`, team: LOWER, attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, ally, cell);
    }
    const enemy = createTestUnit({ name: "Distant Enemy", team: UPPER, attackType: MELEE });
    placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 12, y: 12 });
    setTeamCensus(combat);
    return { combat, attacker, context: contextFor(combat) };
}

describe("v0.1 melee robustness", () => {
    it("hourglasses an ally-boxed AI-Driven Berserker instead of skipping", () => {
        const { attacker, context } = boxedMindlessBerserker();

        const actions = getAIStrategy("v0.1").decideTurn(attacker, context);
        expect(actions).toEqual([{ type: "wait_turn", unitId: attacker.getId() }]);
        expect(actions.some((action) => action.type === "end_turn")).toBe(false);
    });

    it("hourglasses a large ally-boxed Frenzied Boar instead of skipping", () => {
        const combat = createCombatTestContext();
        const boar = createTestUnit({
            name: "Frenzied Boar",
            team: LOWER,
            attackType: MELEE,
            size: PBTypes.UnitSizeVals.LARGE,
            speed: 7,
            abilities: ["AI Driven"],
        });
        placeLarge(combat, boar, { x: 7, y: 13 });
        for (const [index, cell] of [
            { x: 8, y: 12 },
            { x: 5, y: 12 },
            { x: 7, y: 14 },
            { x: 6, y: 11 },
        ].entries()) {
            const ally = createTestUnit({ name: `Blocker ${index}`, team: LOWER, attackType: MELEE });
            placeUnit(combat.grid, combat.unitsHolder, ally, cell);
        }
        const enemy = createTestUnit({
            name: "Distant Large Enemy",
            team: UPPER,
            attackType: MELEE,
            size: PBTypes.UnitSizeVals.LARGE,
        });
        placeLarge(combat, enemy, { x: 7, y: 10 });
        setTeamCensus(combat);

        const actions = getAIStrategy("v0.1").decideTurn(boar, contextFor(combat));
        expect(actions).toEqual([{ type: "wait_turn", unitId: boar.getId() }]);
        expect(actions.some((action) => action.type === "end_turn")).toBe(false);
    });

    it("defends an AI-Driven stack after its hourglass is spent instead of skipping", () => {
        const { attacker, context } = boxedMindlessBerserker();
        context.fightProperties!.restoreAlreadyHourglass([attacker.getId()]);

        const actions = getAIStrategy("v0.1").decideTurn(attacker, context);
        expect(actions).toEqual([{ type: "defend_turn", unitId: attacker.getId() }]);
        expect(actions.some((action) => action.type === "end_turn")).toBe(false);
    });

    it("preserves the non-mindless v0.1 idle fallback", () => {
        const { attacker, context } = boxedMindlessBerserker();
        attacker.deleteAbility("AI Driven");

        expect(getAIStrategy("v0.1").decideTurn(attacker, context)).toEqual([
            { type: "end_turn", unitId: attacker.getId(), reason: "manual" },
        ]);
    });

    it("always prioritizes a live adjacent Aggr target over sticky target memory", () => {
        const combat = createCombatTestContext();
        const attacker = createTestUnit({ name: "Berserker", team: LOWER, attackType: MELEE });
        const remembered = createTestUnit({ name: "Remembered", team: UPPER, attackType: MELEE });
        const forced = createTestUnit({ name: "Forced", team: UPPER, attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, attacker, { x: 5, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, remembered, { x: 5, y: 6 });
        placeUnit(combat.grid, combat.unitsHolder, forced, { x: 6, y: 5 });
        recordAITargetMemory(combat.unitsHolder, attacker.getId(), remembered.getId());
        attacker.setTarget(forced.getId());

        expect(meleeAction(getAIStrategy("v0.1").decideTurn(attacker, contextFor(combat)))?.targetId).toBe(
            forced.getId(),
        );
    });

    it("moves toward a distant live Aggr target instead of attacking an adjacent decoy", () => {
        const combat = createCombatTestContext();
        const attacker = createTestUnit({ name: "Berserker", team: LOWER, attackType: MELEE });
        const decoy = createTestUnit({ name: "Decoy", team: UPPER, attackType: MELEE });
        const forced = createTestUnit({ name: "Forced", team: UPPER, attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, attacker, { x: 4, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, decoy, { x: 4, y: 6 });
        placeUnit(combat.grid, combat.unitsHolder, forced, { x: 11, y: 5 });
        attacker.setTarget(forced.getId());

        const actions = getAIStrategy("v0.1").decideTurn(attacker, contextFor(combat));
        expect(meleeAction(actions)?.targetId).not.toBe(decoy.getId());
        const move = actions.find((action) => action.type === "move_unit");
        expect(move?.type).toBe("move_unit");
        if (move?.type === "move_unit") {
            expect(move.path.at(-1)!.x).toBeGreaterThan(attacker.getBaseCell().x);
        }
    });

    it("keeps a rooted Scavenger's legal adjacent attack stationary", () => {
        const combat = createCombatTestContext();
        const scavenger = createTestUnit({
            name: "Scavenger",
            team: LOWER,
            attackType: MELEE,
            abilities: ["Backstab"],
        });
        const prey = createTestUnit({ name: "Prey", team: UPPER, attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, scavenger, { x: 6, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, prey, { x: 5, y: 5 });
        scavenger.setWebMovementLocked(true);

        const raw = findTarget(
            scavenger,
            combat.grid,
            combat.grid.getMatrix(),
            combat.unitsHolder,
            new PathHelper(testGridSettings),
        );
        expect(raw?.actionType()).toBe(AIActionType.MELEE_ATTACK);
        expect(raw?.cellToMove()).toEqual(scavenger.getBaseCell());

        const strike = meleeAction(getAIStrategy("v0.1").decideTurn(scavenger, contextFor(combat)));
        expect(strike?.targetId).toBe(prey.getId());
        expect(strike?.attackFrom).toEqual(scavenger.getBaseCell());
        expect(strike?.path).toBeUndefined();
    });

    it("never emits a melee against a dead unit left in grid occupancy", () => {
        const combat = createCombatTestContext();
        const attacker = createTestUnit({ name: "Berserker", team: LOWER, attackType: MELEE });
        const stale = createTestUnit({ name: "Stale", team: UPPER, attackType: MELEE });
        const living = createTestUnit({ name: "Living", team: UPPER, attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, attacker, { x: 5, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, stale, { x: 5, y: 6 });
        placeUnit(combat.grid, combat.unitsHolder, living, { x: 11, y: 5 });
        stale.applyDamage(stale.getCumulativeHp(), 0, new SceneLogMock());
        expect(stale.isDead()).toBe(true);
        expect(combat.grid.getOccupantUnitId({ x: 5, y: 6 })).toBe(stale.getId());

        const strike = meleeAction(getAIStrategy("v0.1").decideTurn(attacker, contextFor(combat)));
        expect(strike?.targetId).not.toBe(stale.getId());
    });

    it("obeys Cowardice by choosing an adjacent legal weaker target", () => {
        const combat = createCombatTestContext();
        const attacker = createTestUnit({
            name: "Coward",
            team: LOWER,
            attackType: MELEE,
            amountAlive: 1,
            maxHp: 10,
        });
        const stronger = createTestUnit({
            name: "Stronger",
            team: UPPER,
            attackType: MELEE,
            amountAlive: 3,
            maxHp: 10,
        });
        const weaker = createTestUnit({
            name: "Weaker",
            team: UPPER,
            attackType: MELEE,
            amountAlive: 1,
            maxHp: 5,
        });
        placeUnit(combat.grid, combat.unitsHolder, attacker, { x: 5, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, stronger, { x: 5, y: 6 });
        placeUnit(combat.grid, combat.unitsHolder, weaker, { x: 6, y: 5 });
        applyCowardice(attacker);

        expect(meleeAction(getAIStrategy("v0.1").decideTurn(attacker, contextFor(combat)))?.targetId).toBe(
            weaker.getId(),
        );
    });

    it("never attacks the one enemy forbidden by Terrifying Gaze", () => {
        const combat = createCombatTestContext();
        const attacker = createTestUnit({ name: "Berserker", team: LOWER, attackType: MELEE });
        const manticore = createTestUnit({ name: "Manticore", team: UPPER, attackType: MELEE });
        const legal = createTestUnit({ name: "Legal Bystander", team: UPPER, attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, attacker, { x: 5, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, manticore, { x: 5, y: 6 });
        placeUnit(combat.grid, combat.unitsHolder, legal, { x: 6, y: 5 });
        attacker.setForbiddenTarget(manticore.getId());

        expect(meleeAction(getAIStrategy("v0.1").decideTurn(attacker, contextFor(combat)))?.targetId).toBe(
            legal.getId(),
        );
    });

    it("falls back instead of emitting a rejected melee when Terrifying Gaze forbids the only target", () => {
        const combat = createCombatTestContext();
        const attacker = createTestUnit({ name: "Frenzied Boar", team: LOWER, attackType: MELEE });
        const manticore = createTestUnit({ name: "Manticore", team: UPPER, attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, attacker, { x: 5, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, manticore, { x: 5, y: 6 });
        attacker.setForbiddenTarget(manticore.getId());

        expect(meleeAction(getAIStrategy("v0.1").decideTurn(attacker, contextFor(combat)))).toBeUndefined();
    });

    it("keeps v0.8 late-finish overlays from resurrecting the forbidden Gaze target", () => {
        const combat = createCombatTestContext();
        const attacker = createTestUnit({ name: "Wolf Rider", team: LOWER, attackType: MELEE });
        const manticore = createTestUnit({ name: "Manticore", team: UPPER, attackType: MELEE });
        const legal = createTestUnit({ name: "Legal Bystander", team: UPPER, attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, attacker, { x: 7, y: 10 });
        placeUnit(combat.grid, combat.unitsHolder, manticore, { x: 6, y: 10 });
        placeUnit(combat.grid, combat.unitsHolder, legal, { x: 7, y: 9 });
        attacker.setForbiddenTarget(manticore.getId());
        const fightProperties = FightStateManager.getInstance().getFightProperties();
        while (fightProperties.getCurrentLap() < 4) fightProperties.flipLap();

        expect(meleeAction(getAIStrategy("v0.8").decideTurn(attacker, contextFor(combat)))?.targetId).not.toBe(
            manticore.getId(),
        );
    });

    it("prefers an already-responded target but never overrides a live Aggr target", () => {
        const combat = createCombatTestContext();
        const attacker = createTestUnit({ name: "Berserker", team: LOWER, attackType: MELEE });
        const fresh = createTestUnit({
            name: "Fresh",
            team: UPPER,
            attackType: MELEE,
            amountAlive: 5,
            damageMax: 4,
        });
        const responded = createTestUnit({
            name: "Responded",
            team: UPPER,
            attackType: MELEE,
            amountAlive: 5,
            damageMax: 4,
        });
        placeUnit(combat.grid, combat.unitsHolder, attacker, { x: 5, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, fresh, { x: 5, y: 6 });
        placeUnit(combat.grid, combat.unitsHolder, responded, { x: 6, y: 5 });
        recordAITargetMemory(combat.unitsHolder, attacker.getId(), fresh.getId());
        FightStateManager.getInstance().getFightProperties().addRepliedAttack(responded.getId());

        expect(meleeAction(getAIStrategy("v0.1").decideTurn(attacker, contextFor(combat)))?.targetId).toBe(
            responded.getId(),
        );

        attacker.setTarget(fresh.getId());
        expect(meleeAction(getAIStrategy("v0.1").decideTurn(attacker, contextFor(combat)))?.targetId).toBe(
            fresh.getId(),
        );
    });

    it("honors the authoritative ranked responded flag when local fight state is not hydrated", () => {
        const combat = createCombatTestContext();
        const attacker = createTestUnit({
            name: "Berserker",
            team: LOWER,
            attackType: MELEE,
            abilities: ["AI Driven"],
        });
        const fresh = createTestUnit({
            name: "Fresh",
            team: UPPER,
            attackType: MELEE,
            amountAlive: 5,
            damageMax: 4,
        });
        const responded = createTestUnit({
            name: "Responded in ranked snapshot",
            team: UPPER,
            attackType: MELEE,
            amountAlive: 5,
            damageMax: 4,
        });
        placeUnit(combat.grid, combat.unitsHolder, attacker, { x: 5, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, fresh, { x: 5, y: 6 });
        placeUnit(combat.grid, combat.unitsHolder, responded, { x: 6, y: 5 });
        recordAITargetMemory(combat.unitsHolder, attacker.getId(), fresh.getId());
        responded.setResponded(true);

        const fightProperties = FightStateManager.getInstance().getFightProperties();
        expect(fightProperties.hasAlreadyRepliedAttack(responded.getId())).toBe(false);
        expect(meleeAction(getAIStrategy("v0.1").decideTurn(attacker, contextFor(combat)))?.targetId).toBe(
            responded.getId(),
        );
    });

    it("can retarget a move-and-strike without changing its validated route", () => {
        const combat = createCombatTestContext();
        const attacker = createTestUnit({ name: "Berserker", team: LOWER, attackType: MELEE });
        const fresh = createTestUnit({ name: "Fresh", team: UPPER, attackType: MELEE });
        const responded = createTestUnit({ name: "Responded", team: UPPER, attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, attacker, { x: 4, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, fresh, { x: 7, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, responded, { x: 7, y: 6 });
        FightStateManager.getInstance().getFightProperties().addRepliedAttack(responded.getId());

        const actions = getAIStrategy("v0.1").decideTurn(attacker, contextFor(combat));
        expect(actions.map((action) => action.type)).toEqual(["move_unit", "melee_attack"]);
        const move = actions[0];
        const strike = meleeAction(actions);
        expect(strike?.targetId).toBe(responded.getId());
        expect(strike?.path).toBeUndefined();
        expect(move.type).toBe("move_unit");
        if (move.type === "move_unit") {
            expect(move.path.length).toBeGreaterThan(0);
            expect(move.targetCells).toContainEqual(strike!.attackFrom);
        }
        expect(combat.grid.areCellsAdjacent([strike!.attackFrom], responded.getCells())).toBe(true);
    });

    it("runs a primary move-and-strike through the authoritative Fire Wall and Vine lifecycle", () => {
        const combat = createCombatTestContext();
        const attacker = createTestUnit({
            name: "Primary hazard runner",
            team: LOWER,
            attackType: MELEE,
            amountAlive: 4,
            maxHp: 100,
            speed: 4,
        });
        const target = createTestUnit({ name: "Primary target", team: UPPER, attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, attacker, { x: 5, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, target, { x: 7, y: 5 });
        for (const [index, cell] of [
            { x: 6, y: 4 },
            { x: 7, y: 4 },
            { x: 8, y: 4 },
            { x: 8, y: 5 },
            { x: 8, y: 6 },
            { x: 7, y: 6 },
            { x: 6, y: 6 },
        ].entries()) {
            const blocker = createTestUnit({ name: `Attack-cell blocker ${index}`, team: LOWER, attackType: MELEE });
            placeUnit(combat.grid, combat.unitsHolder, blocker, cell);
        }
        const context = contextFor(combat);
        const destination = { x: 6, y: 5 };
        context.fightProperties!.getFireWalls().add(destination);
        context.fightProperties!.getVines().add(destination, 2, UPPER);

        const actions = getAIStrategy("v0.1").decideTurn(attacker, context);
        expect(actions.map((action) => action.type)).toEqual(["move_unit", "melee_attack"]);
        expect(actions[0]).toMatchObject({ type: "move_unit", targetCells: [destination] });
        expect(meleeAction(actions)).toMatchObject({
            targetId: target.getId(),
            attackFrom: destination,
        });
        expect(meleeAction(actions)?.path).toBeUndefined();

        const engine = startActionEngine(combat, attacker, context);
        const moveResult = engine.apply(actions[0]);
        expect(moveResult.completed).toBe(true);
        expect(moveResult.events.some((event) => event.type === "unit_moved")).toBe(true);
        expect(moveResult.events.some((event) => event.type === "fire_wall_burned")).toBe(true);
        expect(attacker.hasDebuffActive("Vine Throw")).toBe(true);
        expect(engine.apply(actions[1]).completed).toBe(true);
    });

    it("preserves authoritative Rapid Charge distance across an explicit move and stationary strike", () => {
        for (const exposeRankedPostMovePaths of [false, true]) {
            const combat = createCombatTestContext();
            const charger = createTestUnit({
                name: "Wolf Rider",
                team: LOWER,
                attackType: MELEE,
                amountAlive: 10,
                damageMin: 1,
                damageMax: 1,
                abilities: ["Rapid Charge"],
                stackPower: 5,
            });
            const target = createTestUnit({
                name: "Charge target",
                team: UPPER,
                attackType: MELEE,
                amountAlive: 100,
                maxHp: 10,
            });
            placeUnit(combat.grid, combat.unitsHolder, charger, { x: 4, y: 5 });
            placeUnit(combat.grid, combat.unitsHolder, target, { x: 7, y: 5 });
            const context = contextFor(combat);
            const actions = getAIStrategy("v0.1").decideTurn(charger, context);
            const chargeRoute = routeTo({ x: 6, y: 5 }, [
                { x: 4, y: 5 },
                { x: 5, y: 5 },
                { x: 6, y: 5 },
            ]);
            expect(actions.map((action) => action.type)).toEqual(["move_unit", "melee_attack"]);
            expect(actions[0]).toMatchObject({
                type: "move_unit",
                path: chargeRoute.route,
            });
            expect(meleeAction(actions)?.path).toBeUndefined();

            const getRankedPaths = exposeRankedPostMovePaths
                ? (): Map<number, IWeightedRoute[]> => {
                      const beforeMove = charger.getBaseCell().x === 4;
                      const route = beforeMove ? chargeRoute : routeTo({ x: 6, y: 5 }, [{ x: 6, y: 5 }]);
                      return new Map([[(6 << 4) | 5, [route]]]);
                  }
                : undefined;
            const engine = startActionEngine(combat, charger, context, getRankedPaths);
            expect(engine.apply(actions[0]).completed).toBe(true);
            expect(charger.getMovedRouteCellsThisTurn()).toBe(3);
            const targetHpBefore = target.getCumulativeHp();
            expect(engine.apply(actions[1]).completed).toBe(true);
            expect(targetHpBefore - target.getCumulativeHp()).toBe(13);
            expect(charger.getMovedRouteCellsThisTurn()).toBe(0);
        }
    });

    it("keeps Trent's discounted own-vine move-and-strike longer than its plain cell-count budget", () => {
        const combat = createCombatTestContext();
        const trent = createTestUnit({
            name: "Trent",
            team: LOWER,
            attackType: MELEE,
            abilities: ["In Its Own World"],
        });
        const target = createTestUnit({ name: "Vine-road target", team: UPPER, attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, trent, { x: 2, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, target, { x: 9, y: 5 });
        const context = contextFor(combat);
        for (let x = 3; x <= 8; x += 1) {
            context.fightProperties!.getVines().add({ x, y: 5 }, 2, LOWER);
        }

        const actions = getAIStrategy("v0.1").decideTurn(trent, context);
        expect(actions.map((action) => action.type)).toEqual(["move_unit", "melee_attack"]);
        const move = actions[0];
        expect(move.type).toBe("move_unit");
        if (move.type !== "move_unit") {
            throw new Error("expected Trent to move along its own vine road");
        }
        const startsAtOrigin = move.path[0]?.x === trent.getBaseCell().x && move.path[0]?.y === trent.getBaseCell().y;
        const travelledCells = move.path.length - (startsAtOrigin ? 1 : 0);
        expect(travelledCells).toBeGreaterThan(Math.ceil(trent.getSteps()));
        expect(move.targetCells).toContainEqual({ x: 8, y: 5 });
        expect(meleeAction(actions)).toMatchObject({
            targetId: target.getId(),
            attackFrom: { x: 8, y: 5 },
        });
        expect(meleeAction(actions)?.path).toBeUndefined();

        const engine = startActionEngine(combat, trent, context);
        expect(engine.apply(move).completed).toBe(true);
        expect(engine.apply(actions[1]).completed).toBe(true);
    });

    it("runs a completed fallback move through Fire Wall and Vine effects before its stationary melee suffix", () => {
        const combat = createCombatTestContext();
        const attacker = createTestUnit({
            name: "Hazard runner",
            team: LOWER,
            attackType: MELEE,
            amountAlive: 4,
            maxHp: 100,
            speed: 4,
        });
        const target = createTestUnit({
            name: "Adjacent after move",
            team: UPPER,
            attackType: MELEE,
            amountAlive: 20,
            maxHp: 10,
        });
        placeUnit(combat.grid, combat.unitsHolder, attacker, { x: 4, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, target, { x: 7, y: 5 });
        const context = contextFor(combat);
        const destination = { x: 6, y: 5 };
        const route = routeTo(destination, [{ x: 4, y: 5 }, { x: 5, y: 5 }, destination]);
        context.fightProperties!.getFireWalls().add(destination);
        context.fightProperties!.getVines().add(destination, 2, UPPER);

        const actions = new ExposedStrategyV0_1().completeValidatedMove(attacker, context, route);
        expect(actions.map((action) => action.type)).toEqual(["move_unit", "melee_attack"]);
        const strike = meleeAction(actions);
        expect(strike).toMatchObject({
            targetId: target.getId(),
            attackFrom: destination,
        });
        expect(strike?.path).toBeUndefined();

        const engine = startActionEngine(combat, attacker, context);
        const moveResult = engine.apply(actions[0]);
        expect(moveResult.completed).toBe(true);
        expect(moveResult.events.some((event) => event.type === "unit_moved")).toBe(true);
        expect(moveResult.events.some((event) => event.type === "fire_wall_burned")).toBe(true);
        expect(attacker.hasDebuffActive("Vine Throw")).toBe(true);
        expect(attacker.getCumulativeHp()).toBeLessThan(400);

        const strikeResult = engine.apply(actions[1]);
        expect(strikeResult.completed).toBe(true);
        expect(strikeResult.events.some((event) => event.type === "unit_attacked")).toBe(true);
    });

    it("drops a fallback melee suffix when Fire Wall would make Cowardice reject it after moving", () => {
        const combat = createCombatTestContext();
        const attacker = createTestUnit({
            name: "Projected coward",
            team: LOWER,
            attackType: MELEE,
            amountAlive: 2,
            maxHp: 100,
            speed: 4,
        });
        const target = createTestUnit({
            name: "Stronger after burn",
            team: UPPER,
            attackType: MELEE,
            amountAlive: 15,
            maxHp: 10,
        });
        placeUnit(combat.grid, combat.unitsHolder, attacker, { x: 4, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, target, { x: 7, y: 5 });
        applyCowardice(attacker);
        const context = contextFor(combat);
        const destination = { x: 6, y: 5 };
        const route = routeTo(destination, [{ x: 4, y: 5 }, { x: 5, y: 5 }, destination]);
        context.fightProperties!.getFireWalls().add(destination, 2, 50);

        const actions = new ExposedStrategyV0_1().completeValidatedMove(attacker, context, route);
        expect(actions).toEqual([
            {
                type: "move_unit",
                unitId: attacker.getId(),
                path: route.route,
                targetCells: [destination],
                hasLavaCell: false,
                hasWaterCell: false,
            },
        ]);

        const moveResult = startActionEngine(combat, attacker, context).apply(actions[0]);
        expect(moveResult.completed).toBe(true);
        expect(attacker.getCumulativeHp()).toBe(100);
        expect(attacker.getCumulativeHp()).toBeLessThan(target.getCumulativeHp());
    });

    it("completes a fallback move when Cowardice bars every ranged target", () => {
        const combat = createCombatTestContext();
        const shooter = createTestUnit({
            name: "Cowardly archer",
            team: LOWER,
            attackType: RANGE,
            rangeShots: 5,
            shotDistance: 30,
            amountAlive: 1,
            maxHp: 10,
            speed: 3,
        });
        const stronger = createTestUnit({
            name: "Stronger distant target",
            team: UPPER,
            attackType: MELEE,
            amountAlive: 20,
            maxHp: 10,
        });
        placeUnit(combat.grid, combat.unitsHolder, shooter, { x: 3, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, stronger, { x: 12, y: 5 });
        shooter.refreshPossibleAttackTypes(true);
        applyCowardice(shooter);
        const context = contextFor(combat);

        const actions = getAIStrategy("v0.1").decideTurn(shooter, context);
        expect(actions).toHaveLength(1);
        expect(actions[0]).toMatchObject({
            type: "move_unit",
            unitId: shooter.getId(),
        });
        expect(actions.some((action) => action.type === "range_attack" || action.type === "melee_attack")).toBe(false);

        const engine = startActionEngine(combat, shooter, context);
        expect(actions.map((action) => engine.apply(action).completed)).toEqual([true]);
        expect(shooter.getBaseCell().x).toBeGreaterThan(3);
    });

    it("selects the concrete MELEE_MAGIC stance instead of emitting a rejected generic MELEE prefix", () => {
        const combat = createCombatTestContext();
        const attacker = createTestUnit({
            name: "Hybrid",
            team: LOWER,
            attackType: MELEE_MAGIC,
            spells: ["System:Resurrection"],
        });
        const target = createTestUnit({ name: "Target", team: UPPER, attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, attacker, { x: 5, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, target, { x: 5, y: 6 });
        attacker.refreshPossibleAttackTypes(true);
        expect(attacker.selectAttackType(MAGIC)).toBe(true);

        const actions = getAIStrategy("v0.1").decideTurn(attacker, contextFor(combat));
        expect(actions[0]).toEqual({
            type: "select_attack_type",
            unitId: attacker.getId(),
            attackType: MELEE_MAGIC,
        });
        expect(meleeAction(actions)?.targetId).toBe(target.getId());
    });
});
