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

import { calculatePetrifyingGazeKillChance } from "../../src/abilities/petrifying_gaze_ability";
import { calculateStunApplyChance } from "../../src/abilities/stun_ability";
import type { IDecisionContext } from "../../src/ai";
import { enumerateCandidates, type IEnumeratedCandidate } from "../../src/ai/candidates";
import { estimateMeleeRiderEV, routeMeleeRiderEV } from "../../src/ai/versions/rider_ev_router";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
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

function contextFor(combat: CombatTestContext, withFightState = true): IDecisionContext {
    return {
        grid: combat.grid,
        matrix: combat.grid.getMatrix(),
        unitsHolder: combat.unitsHolder,
        pathHelper: new PathHelper(testGridSettings),
        attackHandler: combat.attackHandler,
        fightProperties: withFightState ? FightStateManager.getInstance().getFightProperties() : undefined,
    };
}

function melee(unit: Unit, target: Unit): GameAction[] {
    return [
        {
            type: "melee_attack",
            attackerId: unit.getId(),
            targetId: target.getId(),
            attackFrom: { ...unit.getBaseCell() },
        },
    ];
}

function selectedTarget(actions: readonly GameAction[]): string | undefined {
    const attack = actions.find((action) => action.type === "melee_attack");
    return attack?.type === "melee_attack" ? attack.targetId : undefined;
}

function candidateFor(unit: Unit, target: Unit, context: IDecisionContext): IEnumeratedCandidate {
    const neutral: GameAction[] = [{ type: "end_turn", unitId: unit.getId(), reason: "manual" }];
    const candidate = enumerateCandidates(unit, context, neutral).candidates.find(
        (value) =>
            value.kind === "melee" &&
            value.targetId === target.getId() &&
            value.standCell?.x === unit.getBaseCell().x &&
            value.standCell.y === unit.getBaseCell().y,
    );
    if (!candidate) {
        throw new Error(`missing in-place melee candidate for ${target.getName()}`);
    }
    return candidate;
}

function placeThree(combat: CombatTestContext, unit: Unit, left: Unit, right: Unit): void {
    placeUnit(combat.grid, combat.unitsHolder, unit, { x: 6, y: 6 });
    placeUnit(combat.grid, combat.unitsHolder, left, { x: 5, y: 6 });
    placeUnit(combat.grid, combat.unitsHolder, right, { x: 7, y: 6 });
}

afterEach(() => {
    delete process.env.V06_RIDER_EV;
});

describe("v0.6 melee rider EV router", () => {
    it("preserves the engine Petrify and Stun chance formulas used by the EV terms", () => {
        // Pre-extraction Petrify arithmetic: 60 apply chance -> 15% base; level 4 adds 12 points. At
        // divisor 2 and 25% MIND resist: round((15 + 12) * .75 * .75) = 15.
        expect(calculatePetrifyingGazeKillChance(60, 1, 0)).toBe(15);
        expect(calculatePetrifyingGazeKillChance(60, 4, 0)).toBe(27);
        expect(calculatePetrifyingGazeKillChance(60, 4, 25, 2)).toBe(15);

        const attacker = createTestUnit({
            team: LOWER,
            abilities: ["Stun"],
            luck: 0,
            stackPower: 100,
        });
        const ordinary = createTestUnit({ team: UPPER });
        const mechanism = createTestUnit({ team: UPPER, abilities: ["Mechanism"] });
        // Pre-extraction Stun arithmetic: 35 base at full stack; STATUS gets x1.5 vs Mechanism.
        expect(calculateStunApplyChance(attacker, ordinary, 0)).toBe(35);
        expect(calculateStunApplyChance(attacker, mechanism, 0)).toBe(52.5);
        expect(calculateStunApplyChance(attacker, ordinary, 10)).toBe(45);
    });

    it("is byte-parity inert while gated off and when fight state is unavailable", () => {
        const combat = createCombatTestContext();
        const unit = createTestUnit({ team: LOWER, attackType: MELEE, abilities: ["Stun"] });
        const target = createTestUnit({ team: UPPER, attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, unit, { x: 6, y: 6 });
        placeUnit(combat.grid, combat.unitsHolder, target, { x: 7, y: 6 });
        const incumbent = melee(unit, target);
        let enumerations = 0;
        const enumerate = () => {
            enumerations += 1;
            return { candidates: [], truncated: [] };
        };

        expect(routeMeleeRiderEV(unit, contextFor(combat), incumbent, enumerate)).toBe(incumbent);
        process.env.V06_RIDER_EV = "on";
        expect(routeMeleeRiderEV(unit, contextFor(combat, false), incumbent, enumerate)).toBe(incumbent);
        expect(enumerations).toBe(0);
    });

    it("adds Petrifying Gaze kill EV and prefers the higher-level target from the same stand cell", () => {
        process.env.V06_RIDER_EV = "on";
        const combat = createCombatTestContext();
        const medusa = createTestUnit({
            name: "Medusa",
            team: LOWER,
            attackType: MELEE,
            attack: 10,
            damageMin: 2,
            damageMax: 2,
            amountAlive: 10,
            stackPower: 100,
            abilities: ["Petrifying Gaze"],
        });
        const lowLevel = createTestUnit({
            name: "Level 1",
            team: UPPER,
            attackType: MELEE,
            amountAlive: 20,
            maxHp: 100,
            level: PBTypes.UnitLevelVals.FIRST,
        });
        const highLevel = createTestUnit({
            name: "Level 4",
            team: UPPER,
            attackType: MELEE,
            amountAlive: 20,
            maxHp: 100,
            level: PBTypes.UnitLevelVals.FOURTH,
        });
        placeThree(combat, medusa, lowLevel, highLevel);
        const context = contextFor(combat);

        const lowEv = estimateMeleeRiderEV(medusa, context, candidateFor(medusa, lowLevel, context));
        const highEv = estimateMeleeRiderEV(medusa, context, candidateFor(medusa, highLevel, context));
        expect(lowEv?.petrifyKillEv).toBeGreaterThan(0);
        expect(highEv!.petrifyKillEv).toBeGreaterThan(lowEv!.petrifyKillEv);

        const routed = routeMeleeRiderEV(medusa, context, melee(medusa, lowLevel));
        expect(selectedTarget(routed)).toBe(highLevel.getId());
    });

    it("prices Stun only before the target acts and preserves the incumbent when both denial terms tie", () => {
        process.env.V06_RIDER_EV = "on";
        const combat = createCombatTestContext();
        const squire = createTestUnit({
            name: "Squire",
            team: LOWER,
            attackType: MELEE,
            damageMin: 1,
            damageMax: 1,
            amountAlive: 5,
            stackPower: 100,
            abilities: ["Stun"],
        });
        const acted = createTestUnit({
            name: "Acted",
            team: UPPER,
            attackType: MELEE,
            damageMin: 10,
            damageMax: 10,
            amountAlive: 10,
            maxHp: 100,
        });
        const pending = createTestUnit({
            name: "Pending",
            team: UPPER,
            attackType: MELEE,
            damageMin: 10,
            damageMax: 10,
            amountAlive: 10,
            maxHp: 100,
        });
        placeThree(combat, squire, acted, pending);
        const context = contextFor(combat);
        context.fightProperties!.addAlreadyMadeTurn(UPPER, acted.getId(), 0);

        const actedEv = estimateMeleeRiderEV(squire, context, candidateFor(squire, acted, context));
        const pendingEv = estimateMeleeRiderEV(squire, context, candidateFor(squire, pending, context));
        expect(actedEv?.stunTurnDenialEv).toBe(0);
        expect(pendingEv?.stunTurnDenialEv).toBeGreaterThan(0);
        expect(selectedTarget(routeMeleeRiderEV(squire, context, melee(squire, acted)))).toBe(pending.getId());

        context.fightProperties!.addAlreadyMadeTurn(UPPER, pending.getId(), 0);
        const incumbent = melee(squire, acted);
        expect(routeMeleeRiderEV(squire, context, incumbent)).toBe(incumbent);
    });

    it("values Devour Essence only on a minimum-damage kill that restores current front HP", () => {
        process.env.V06_RIDER_EV = "on";
        const combat = createCombatTestContext();
        const hydra = createTestUnit({
            name: "Hydra",
            team: LOWER,
            attackType: MELEE,
            damageMin: 10,
            damageMax: 10,
            maxHp: 100,
            stackPower: 100,
            abilities: ["Devour Essence"],
        });
        const secure = createTestUnit({
            name: "Secure kill",
            team: UPPER,
            attackType: MELEE,
            maxHp: 5,
        });
        const survivor = createTestUnit({
            name: "Survivor",
            team: UPPER,
            attackType: MELEE,
            maxHp: 50,
        });
        placeThree(combat, hydra, survivor, secure);
        hydra.applyDamage(80, 0, new SceneLogMock());
        const context = contextFor(combat);

        const secureEv = estimateMeleeRiderEV(hydra, context, candidateFor(hydra, secure, context));
        const survivorEv = estimateMeleeRiderEV(hydra, context, candidateFor(hydra, survivor, context));
        expect(secureEv?.secureKill).toBe(true);
        expect(secureEv?.devourKillSecureEv).toBe(80);
        expect(survivorEv?.secureKill).toBe(false);
        expect(survivorEv?.devourKillSecureEv).toBe(0);
        expect(selectedTarget(routeMeleeRiderEV(hydra, context, melee(hydra, survivor)))).toBe(secure.getId());
    });

    it("does not invent a kill bonus when Devour Essence has no missing HP", () => {
        process.env.V06_RIDER_EV = "on";
        const combat = createCombatTestContext();
        const hydra = createTestUnit({
            name: "Hydra",
            team: LOWER,
            attackType: MELEE,
            damageMin: 10,
            damageMax: 10,
            maxHp: 100,
            stackPower: 100,
            abilities: ["Devour Essence"],
        });
        const small = createTestUnit({ name: "Small", team: UPPER, attackType: MELEE, maxHp: 5 });
        const large = createTestUnit({ name: "Large", team: UPPER, attackType: MELEE, maxHp: 50 });
        placeThree(combat, hydra, large, small);
        const context = contextFor(combat);
        const incumbent = melee(hydra, large);

        expect(estimateMeleeRiderEV(hydra, context, candidateFor(hydra, small, context))?.devourKillSecureEv).toBe(0);
        expect(routeMeleeRiderEV(hydra, context, incumbent)).toBe(incumbent);
    });

    it("re-targets a move-plus-melee candidate without changing its incumbent stand cell", () => {
        process.env.V06_RIDER_EV = "on";
        const combat = createCombatTestContext();
        const squire = createTestUnit({
            name: "Moving Squire",
            team: LOWER,
            attackType: MELEE,
            damageMin: 1,
            damageMax: 1,
            amountAlive: 5,
            speed: 4,
            stackPower: 100,
            abilities: ["Stun"],
        });
        const acted = createTestUnit({
            name: "Acted target",
            team: UPPER,
            attackType: MELEE,
            damageMin: 10,
            damageMax: 10,
            amountAlive: 10,
            maxHp: 100,
        });
        const pending = createTestUnit({
            name: "Pending target",
            team: UPPER,
            attackType: MELEE,
            damageMin: 10,
            damageMax: 10,
            amountAlive: 10,
            maxHp: 100,
        });
        placeUnit(combat.grid, combat.unitsHolder, squire, { x: 6, y: 3 });
        placeUnit(combat.grid, combat.unitsHolder, acted, { x: 5, y: 6 });
        placeUnit(combat.grid, combat.unitsHolder, pending, { x: 7, y: 6 });
        const context = contextFor(combat);
        context.fightProperties!.addAlreadyMadeTurn(UPPER, acted.getId(), 0);
        const standCell = { x: 6, y: 5 };
        const neutral: GameAction[] = [{ type: "end_turn", unitId: squire.getId(), reason: "manual" }];
        const incumbent = enumerateCandidates(squire, context, neutral).candidates.find(
            (candidate) =>
                candidate.kind === "melee" &&
                candidate.targetId === acted.getId() &&
                candidate.standCell?.x === standCell.x &&
                candidate.standCell.y === standCell.y,
        );
        expect(incumbent).toBeDefined();
        expect(incumbent!.actions.some((action) => action.type === "move_unit")).toBe(true);

        const routed = routeMeleeRiderEV(squire, context, incumbent!.actions);
        const routedMove = routed.find((action) => action.type === "move_unit");
        const routedAttack = routed.find((action) => action.type === "melee_attack");
        expect(routedAttack?.type === "melee_attack" && routedAttack.targetId).toBe(pending.getId());
        expect(routedAttack?.type === "melee_attack" && routedAttack.attackFrom).toEqual(standCell);
        expect(routedMove?.type === "move_unit" && routedMove.path[routedMove.path.length - 1]).toEqual(standCell);
    });
});
