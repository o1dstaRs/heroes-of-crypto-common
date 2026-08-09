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

import { getSpellConfig } from "../../src/configuration/config_provider";
import { NUMBER_OF_LAPS_TOTAL } from "../../src/constants";
import { GameActionEngine } from "../../src/engine/action_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Spell } from "../../src/spells/spell";
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
        initiative: 5,
        morale: 4,
    });
    placeUnit(context.grid, context.unitsHolder, caster, { x: 3, y: 3 });

    const victim = createTestUnit({
        name: "Victim",
        team: PBTypes.TeamVals.UPPER,
        maxHp: 10_000,
        armor: 20,
        initiative: 3,
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
            initiative: 3,
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
    const castEvent = result.events.find((event) => event.type === "spell_cast");
    return {
        victimTook: hpBefore - setup.victim.getHp(),
        abominationTook: abominationHpBefore - (setup.abomination?.getHp() ?? 0),
        secondary: castEvent?.type === "spell_cast" ? (castEvent.secondary ?? []) : [],
    };
};

const setupMeteoriteOverflow = (
    casterAmountAlive = 57,
    abominationCell: { x: number; y: number } = { x: 5, y: 4 },
    casterAbilities: string[] = [],
    magicDamageBonus = 25,
) => {
    const context = createCombatTestContext(PBTypes.GridVals.NORMAL);
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(PBTypes.GridVals.NORMAL);
    fightProperties.startFight();

    const caster = createTestUnit({
        name: "Battle Mage",
        team: PBTypes.TeamVals.LOWER,
        attackType: PBTypes.AttackVals.MELEE_MAGIC,
        spells: ["Life:Meteorite"],
        amountAlive: casterAmountAlive,
        stackPower: 5,
        initiative: 5,
        morale: 4,
        abilities: casterAbilities,
    });
    placeUnit(context.grid, context.unitsHolder, caster, { x: 3, y: 3 });
    if (magicDamageBonus > 0) {
        const augment = new Spell({
            spellProperties: getSpellConfig("System", "Empower Augment", NUMBER_OF_LAPS_TOTAL),
            amount: 1,
        });
        augment.setPower(magicDamageBonus);
        caster.applyBuff(augment);
    }

    const victims = [
        createTestUnit({ name: "Victim A", team: PBTypes.TeamVals.UPPER, maxHp: 10_000, initiative: 3 }),
        createTestUnit({ name: "Victim B", team: PBTypes.TeamVals.UPPER, maxHp: 10_000, initiative: 3 }),
    ];
    placeUnit(context.grid, context.unitsHolder, victims[0], { x: 6, y: 3 });
    placeUnit(context.grid, context.unitsHolder, victims[1], { x: 6, y: 4 });

    const abomination = createTestUnit({
        name: "Abomination",
        team: PBTypes.TeamVals.UPPER,
        maxHp: 500,
        magicResist: 0,
        stackPower: 5,
        initiative: 3,
        morale: 4,
        abilities: ["Flesh Shield Aura"],
        auraEffects: ["Flesh Shield"],
        auraRanges: [1],
        auraIsBuff: [true],
    });
    placeUnit(context.grid, context.unitsHolder, abomination, abominationCell);
    context.unitsHolder.refreshAuraEffectsForAllUnits();

    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LOWER, 1);
    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.UPPER, 3);
    fightProperties.startTurn(PBTypes.TeamVals.LOWER, 1000);

    const engine = new GameActionEngine({
        fightProperties,
        grid: context.grid,
        unitsHolder: context.unitsHolder,
        moveHandler: new MoveHandler(context.grid.getSettings(), context.grid, context.unitsHolder),
        sceneLog: new SceneLogMock(),
        attackHandler: context.attackHandler,
        createSummonedUnit: ({ team, unitName }) =>
            createTestUnit({
                name: unitName,
                team,
                level: PBTypes.UnitLevelVals.FIRST,
                abilities: ["Infest"],
                summoned: true,
            }),
    });
    return { ...context, engine, caster, victims, abomination };
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
        expect(protectedRun.secondary).toEqual([
            expect.objectContaining({
                source: "flesh_shield",
                amount: protectedRun.abominationTook,
            }),
        ]);
    });

    it("conserves the strike — nothing is created or lost in the transfer", () => {
        const unprotected = fireStrike(setupFight(false));
        const protectedRun = fireStrike(setupFight(true));

        // These two units have identical 0% magic resistance, so every point removed from the protected
        // victim must appear on the Abomination. This pins the no-disappearing-damage invariant directly.
        expect(protectedRun.victimTook + protectedRun.abominationTook).toBe(unprotected.victimTook);
    });

    it("returns AOE overflow to protected units when the 500-HP absorber exhausts", () => {
        // 57 mages x Meteorite's flat 4 x a real 25% Empower bonus = 285 per victim, 570 total.
        const setup = setupMeteoriteOverflow();
        const hpBefore = setup.victims.map((unit) => unit.getHp());

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Meteorite",
            targetCell: { x: 6, y: 3 },
        });
        expect(result.completed).toBe(true);

        const cast = result.events.find((event) => event.type === "spell_cast");
        expect(cast?.type).toBe("spell_cast");
        const primary = cast?.type === "spell_cast" ? (cast.damaged ?? []) : [];
        const secondary = cast?.type === "spell_cast" ? (cast.secondary ?? []) : [];
        const primaryDamage = primary.reduce((sum, entry) => sum + entry.amount, 0);
        const absorbedDamage = secondary.reduce((sum, entry) => sum + entry.amount, 0);

        // Two 285 hits = 570. The Abomination can pay exactly 500, so the remaining 70 lands back on the
        // protected victims instead of disappearing when the aura source dies midway through the AOE.
        expect(primaryDamage).toBe(70);
        expect(absorbedDamage).toBe(500);
        expect(primaryDamage + absorbedDamage).toBe(570);
        expect(hpBefore.reduce((sum, hp, index) => sum + hp - setup.victims[index].getHp(), 0)).toBe(70);
        expect(secondary).toEqual([
            expect.objectContaining({
                source: "flesh_shield",
                unitId: setup.abomination.getId(),
                amount: 500,
                unitsDied: 1,
            }),
        ]);
        expect(setup.abomination.isDead()).toBe(true);
        expect(setup.damageStatisticHolder.get().reduce((sum, entry) => sum + entry.damage, 0)).toBe(570);
    });

    it("reserves an aura owner's own simultaneous AOE hit before ally transfers", () => {
        // 150 mages x Meteorite's flat 4 = 600 per target. The Abomination stands inside the 2x2 after both allies in
        // cell-enumeration order; resolving those allies first used to spend its 500 HP on absorption and
        // make the owner's own direct 500-HP hit disappear.
        const setup = setupMeteoriteOverflow(150, { x: 7, y: 4 }, [], 0);
        const victimHpBefore = setup.victims.map((unit) => unit.getHp());

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Meteorite",
            targetCell: { x: 6, y: 3 },
        });
        expect(result.completed).toBe(true);

        const cast = result.events.find((event) => event.type === "spell_cast");
        const damaged = cast?.type === "spell_cast" ? (cast.damaged ?? []) : [];
        const secondary = cast?.type === "spell_cast" ? (cast.secondary ?? []) : [];
        const victimDamage = victimHpBefore.reduce((sum, hp, index) => sum + hp - setup.victims[index].getHp(), 0);
        const ownerDamage = damaged.find((entry) => entry.unitId === setup.abomination.getId())?.amount ?? 0;

        expect(victimDamage).toBe(1_200);
        expect(ownerDamage).toBe(500);
        expect(secondary).toEqual([]);
        expect(damaged.reduce((sum, entry) => sum + entry.amount, 0)).toBe(1_700);
        expect(setup.damageStatisticHolder.get().reduce((sum, entry) => sum + entry.damage, 0)).toBe(1_700);
    });

    it("attributes an absorber killed by hostile redirection to the spell for Infest", () => {
        const setup = setupMeteoriteOverflow(57, { x: 5, y: 4 }, ["Infest"]);
        const moraleWitness = createTestUnit({
            name: "Abomination",
            team: PBTypes.TeamVals.UPPER,
            maxHp: 10_000,
            morale: 4,
        });
        placeUnit(setup.grid, setup.unitsHolder, moraleWitness, { x: 9, y: 9 });
        const casterMoraleBefore = setup.caster.getMorale();
        const witnessMoraleBefore = moraleWitness.getMorale();

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Meteorite",
            targetCell: { x: 6, y: 3 },
        });
        expect(result.completed).toBe(true);
        expect(result.events).toContainEqual(
            expect.objectContaining({
                type: "unit_summoned",
                unitName: "Arachna Spider",
                sourceAbility: "Infest",
            }),
        );
        expect(result.events.filter((event) => event.type === "unit_summoned")).toHaveLength(1);
        expect(setup.caster.getMorale()).toBeGreaterThan(casterMoraleBefore);
        expect(moraleWitness.getMorale()).toBeLessThan(witnessMoraleBefore);
    });
});
