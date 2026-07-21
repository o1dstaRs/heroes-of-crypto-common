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
import { getSpellConfig } from "../../src/configuration/config_provider";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Spell } from "../../src/spells/spell";
import type { Unit } from "../../src/units/unit";
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

describe("v0.1 melee robustness", () => {
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

    it("can retarget a move-and-strike without changing its validated route", () => {
        const combat = createCombatTestContext();
        const attacker = createTestUnit({ name: "Berserker", team: LOWER, attackType: MELEE });
        const fresh = createTestUnit({ name: "Fresh", team: UPPER, attackType: MELEE });
        const responded = createTestUnit({ name: "Responded", team: UPPER, attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, attacker, { x: 4, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, fresh, { x: 7, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, responded, { x: 7, y: 6 });
        FightStateManager.getInstance().getFightProperties().addRepliedAttack(responded.getId());

        const strike = meleeAction(getAIStrategy("v0.1").decideTurn(attacker, contextFor(combat)));
        expect(strike?.targetId).toBe(responded.getId());
        expect(strike?.path?.length).toBeGreaterThan(0);
        expect(combat.grid.areCellsAdjacent([strike!.attackFrom], responded.getCells())).toBe(true);
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
