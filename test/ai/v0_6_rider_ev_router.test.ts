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

import { AbilityFactory } from "../../src/abilities/ability_factory";
import { calculatePetrifyingGazeKillChance } from "../../src/abilities/petrifying_gaze_ability";
import { calculateStunApplyChance } from "../../src/abilities/stun_ability";
import type { IDecisionContext } from "../../src/ai";
import { enumerateCandidates, type IEnumeratedCandidate } from "../../src/ai/candidates";
import { estimateMeleeRiderEV, routeMeleeRiderEV } from "../../src/ai/versions/rider_ev_router";
import { getCreatureConfig, getSpellConfig } from "../../src/configuration/config_provider";
import { NUMBER_OF_LAPS_TOTAL } from "../../src/constants";
import { EffectFactory } from "../../src/effects/effect_factory";
import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getPositionForCells } from "../../src/grid/grid_math";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Spell } from "../../src/spells/spell";
import { Unit } from "../../src/units/unit";
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

function activateEngine(combat: CombatTestContext, active: Unit): GameActionEngine {
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(PBTypes.GridVals.NORMAL);
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
    });
}

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

function estimateWithMissSource(mutate?: (attacker: Unit, target: Unit) => void) {
    const combat = createCombatTestContext();
    const attacker = createTestUnit({
        name: "Large Petrifier",
        team: LOWER,
        attackType: MELEE,
        damageMin: 10,
        damageMax: 10,
        amountAlive: 10,
        maxHp: 100,
        stackPower: 100,
        size: PBTypes.UnitSizeVals.LARGE,
        abilities: ["Petrifying Gaze"],
    });
    const target = createTestUnit({
        name: "Target",
        team: UPPER,
        attackType: MELEE,
        amountAlive: 20,
        maxHp: 100,
        stackPower: 100,
    });
    placeLarge(combat, attacker, { x: 6, y: 6 });
    placeUnit(combat.grid, combat.unitsHolder, target, { x: 7, y: 6 });
    mutate?.(attacker, target);
    const context = contextFor(combat);
    const estimate = estimateMeleeRiderEV(attacker, context, candidateFor(attacker, target, context));
    if (!estimate) {
        throw new Error("Expected a supported single-hit rider estimate");
    }
    return estimate;
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

    it("hit-weights base and Petrify EV for Dodge, Small Specie, Broken Aegis, and Boar Saliva", () => {
        const baseline = estimateWithMissSource();
        const dodge = estimateWithMissSource((_attacker, target) => target.grantAbility("Dodge"));
        const smallSpecie = estimateWithMissSource((_attacker, target) => target.grantAbility("Small Specie"));
        const brokenAegis = estimateWithMissSource((attacker) => {
            const buff = new Spell({
                spellProperties: getSpellConfig("System", "Broken Aegis", NUMBER_OF_LAPS_TOTAL),
                amount: 1,
            });
            buff.setPower(20);
            attacker.applyBuff(buff);
        });
        const boarSaliva = estimateWithMissSource((attacker) => {
            attacker.applyEffect(new EffectFactory().makeEffect("Boar Saliva"));
        });

        for (const evasive of [dodge, smallSpecie, brokenAegis, boarSaliva]) {
            expect(evasive.hitChance).toBeLessThan(baseline.hitChance);
            expect(evasive.baseDamageEv).toBeLessThan(baseline.baseDamageEv);
            expect(evasive.petrifyKillEv).toBeLessThan(baseline.petrifyKillEv);
        }
    });

    it("does not let an evasive target outrank a reliable target at the same stand cell", () => {
        process.env.V06_RIDER_EV = "on";
        const combat = createCombatTestContext();
        const attacker = createTestUnit({
            name: "Large Petrifier",
            team: LOWER,
            attackType: MELEE,
            damageMin: 10,
            damageMax: 10,
            amountAlive: 10,
            stackPower: 100,
            size: PBTypes.UnitSizeVals.LARGE,
            abilities: ["Petrifying Gaze"],
        });
        const evasive = createTestUnit({
            name: "Evasive",
            team: UPPER,
            attackType: MELEE,
            amountAlive: 20,
            maxHp: 100,
            stackPower: 100,
            abilities: ["Dodge", "Small Specie"],
        });
        const reliable = createTestUnit({
            name: "Reliable",
            team: UPPER,
            attackType: MELEE,
            amountAlive: 20,
            maxHp: 100,
        });
        placeLarge(combat, attacker, { x: 6, y: 6 });
        placeUnit(combat.grid, combat.unitsHolder, evasive, { x: 4, y: 6 });
        placeUnit(combat.grid, combat.unitsHolder, reliable, { x: 7, y: 6 });
        const context = contextFor(combat);

        expect(selectedTarget(routeMeleeRiderEV(attacker, context, melee(attacker, evasive)))).toBe(reliable.getId());
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

    it("preserves the incumbent for the shipped Hydra replacement-hit and Devour sequence", () => {
        process.env.V06_RIDER_EV = "on";
        const combat = createCombatTestContext();
        const hydra = makeReal(LOWER, "Chaos", "Hydra");
        const target = createTestUnit({ name: "Target", team: UPPER, attackType: MELEE, maxHp: 500 });
        placeLarge(combat, hydra, { x: 6, y: 6 });
        placeUnit(combat.grid, combat.unitsHolder, target, { x: 7, y: 6 });
        const context = contextFor(combat);
        const candidate = candidateFor(hydra, target, context);
        const incumbent = candidate.actions;

        expect(hydra.hasAbilityActive("Lightning Spin")).toBe(true);
        expect(hydra.hasAbilityActive("Devour Essence")).toBe(true);
        expect(estimateMeleeRiderEV(hydra, context, candidate)).toBeUndefined();
        expect(routeMeleeRiderEV(hydra, context, incumbent)).toBe(incumbent);
    });

    it("preserves an incumbent whose pending Stun target has a multi-hit turn", () => {
        process.env.V06_RIDER_EV = "on";
        const combat = createCombatTestContext();
        const squire = createTestUnit({
            name: "Squire",
            team: LOWER,
            attackType: MELEE,
            damageMin: 2,
            damageMax: 2,
            stackPower: 100,
            abilities: ["Stun"],
        });
        const target = createTestUnit({
            name: "Double Punch target",
            team: UPPER,
            attackType: MELEE,
            amountAlive: 10,
            maxHp: 100,
            abilities: ["Double Punch"],
        });
        placeUnit(combat.grid, combat.unitsHolder, squire, { x: 6, y: 6 });
        placeUnit(combat.grid, combat.unitsHolder, target, { x: 7, y: 6 });
        const context = contextFor(combat);
        const candidate = candidateFor(squire, target, context);
        const incumbent = melee(squire, target);

        expect(estimateMeleeRiderEV(squire, context, candidate)).toBeUndefined();
        expect(routeMeleeRiderEV(squire, context, incumbent)).toBe(incumbent);
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
        const engine = activateEngine(combat, squire);
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
        const incumbentMove = incumbent!.actions.find((action) => action.type === "move_unit");
        expect(incumbentMove?.type).toBe("move_unit");

        const routed = routeMeleeRiderEV(squire, context, incumbent!.actions);
        const routedMove = routed.find((action) => action.type === "move_unit");
        const routedAttack = routed.find((action) => action.type === "melee_attack");
        expect(routedAttack?.type === "melee_attack" && routedAttack.targetId).toBe(pending.getId());
        expect(routedAttack?.type === "melee_attack" && routedAttack.attackFrom).toEqual(standCell);
        expect(routedMove).toBe(incumbentMove);
        expect(routedMove?.type === "move_unit" && routedMove.path).toBe(
            incumbentMove?.type === "move_unit" ? incumbentMove.path : undefined,
        );
        expect(routedMove?.type === "move_unit" && routedMove.path[routedMove.path.length - 1]).toEqual(standCell);
        for (const action of routed) {
            const result = engine.apply(action);
            expect(result.completed, `${action.type}: ${result.rejectionReason ?? "rejected"}`).toBe(true);
        }
    });
});
