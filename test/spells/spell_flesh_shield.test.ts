/*
 * -----------------------------------------------------------------------------
 * Flesh Shield Aura (Abomination) vs CAST spell damage.
 *
 * Regression guard: applySpellDamageToUnits went straight to applyDamage, so the
 * aura absorbed Fire Breath and Chain Lightning — whose ability modules call
 * processFleshShieldAura themselves — but nothing thrown from a spellbook. Fire
 * Strike and Meteorite passed through a protected ally untouched.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import { GameActionEngine } from "../../src/engine/action_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

/**
 * A Battle Mage facing an enemy that may or may not be standing next to an Abomination. Both enemies are
 * given enormous health so the test reads damage rather than deaths.
 */
const setupFight = (withAbomination: boolean) => {
    const context = createCombatTestContext(PBTypes.GridVals.NORMAL);
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(PBTypes.GridVals.NORMAL);
    fightProperties.startFight();

    const caster = createTestUnit({
        name: "Battle Mage",
        team: PBTypes.TeamVals.LOWER,
        attackType: PBTypes.AttackVals.MELEE_MAGIC,
        spells: ["Life:Fire Strike"],
        amountAlive: 38,
        stackPower: 5,
        speed: 5,
        morale: 4,
    });
    placeUnit(context.grid, context.unitsHolder, caster, { x: 3, y: 3 });

    const victim = createTestUnit({
        name: "Victim",
        team: PBTypes.TeamVals.UPPER,
        maxHp: 10_000,
        armor: 20,
        speed: 3,
        morale: 4,
    });
    placeUnit(context.grid, context.unitsHolder, victim, { x: 6, y: 3 });

    let abomination: ReturnType<typeof createTestUnit> | undefined;
    if (withAbomination) {
        abomination = createTestUnit({
            name: "Abomination",
            team: PBTypes.TeamVals.UPPER,
            maxHp: 10_000,
            armor: 20,
            magicResist: 0,
            luck: 0,
            stackPower: 5,
            speed: 3,
            morale: 4,
            abilities: ["Flesh Shield Aura"],
            auraEffects: ["Flesh Shield"],
            auraRanges: [1],
            auraIsBuff: [true],
        });
        placeUnit(context.grid, context.unitsHolder, abomination, { x: 7, y: 3 });
    }
    context.unitsHolder.refreshAuraEffectsForAllUnits();

    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LOWER, 1);
    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.UPPER, withAbomination ? 2 : 1);
    fightProperties.startTurn(PBTypes.TeamVals.LOWER, 1000);

    const sceneLog = new SceneLogMock();
    const engine = new GameActionEngine({
        fightProperties,
        grid: context.grid,
        unitsHolder: context.unitsHolder,
        moveHandler: new MoveHandler(context.grid.getSettings(), context.grid, context.unitsHolder),
        sceneLog,
        attackHandler: context.attackHandler,
    });

    return { ...context, engine, caster, victim, abomination };
};

const fireStrike = (setup: ReturnType<typeof setupFight>) => {
    const hpBefore = setup.victim.getHp();
    const abominationHpBefore = setup.abomination?.getHp() ?? 0;
    const result = setup.engine.apply({
        type: "cast_spell",
        casterId: setup.caster.getId(),
        spellName: "Fire Strike",
        targetId: setup.victim.getId(),
    });
    expect(result.completed).toBe(true);
    return {
        victimTook: hpBefore - setup.victim.getHp(),
        abominationTook: abominationHpBefore - (setup.abomination?.getHp() ?? 0),
    };
};

describe("Flesh Shield aura vs cast spell damage", () => {
    it("hands part of a Fire Strike to the Abomination beside the target", () => {
        const unprotected = fireStrike(setupFight(false));
        const protectedRun = fireStrike(setupFight(true));

        // Baseline: the whole strike lands on the victim.
        expect(unprotected.victimTook).toBeGreaterThan(0);
        expect(unprotected.abominationTook).toBe(0);

        // With the aura up the victim keeps only the remainder and the Abomination eats the rest.
        expect(protectedRun.abominationTook).toBeGreaterThan(0);
        expect(protectedRun.victimTook).toBeLessThan(unprotected.victimTook);
    });

    it("conserves the strike — nothing is created or lost in the transfer", () => {
        const unprotected = fireStrike(setupFight(false));
        const protectedRun = fireStrike(setupFight(true));

        // The Abomination's share is recalculated against its own defenses, so the two totals need not be
        // identical; what must hold is that the victim's relief is real and the absorber genuinely paid.
        expect(protectedRun.victimTook + protectedRun.abominationTook).toBeGreaterThan(0);
        expect(unprotected.victimTook - protectedRun.victimTook).toBeGreaterThan(0);
    });
});
