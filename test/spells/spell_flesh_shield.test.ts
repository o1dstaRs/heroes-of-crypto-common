/*
 * -----------------------------------------------------------------------------
 * Flesh Shield Aura (Abomination) vs CAST spell damage.
 *
 * Regression guard for the physical-only rule: the aura is flesh, not a ward. Every
 * point a spellbook throws is magical, so a protected ally eats a Fire Strike or a
 * Meteorite in full and the Abomination beside it never pays a share.
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
        team: PBTypes.TeamVals.LEFT,
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
        team: PBTypes.TeamVals.RIGHT,
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
            team: PBTypes.TeamVals.RIGHT,
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

    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LEFT, 1);
    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.RIGHT, withAbomination ? 2 : 1);
    fightProperties.startTurn(PBTypes.TeamVals.LEFT, 1000);

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

const setupMeteoriteFight = (
    casterAmountAlive = 57,
    abominationCell: { x: number; y: number } = { x: 5, y: 4 },
    magicDamageBonus = 25,
) => {
    const context = createCombatTestContext(PBTypes.GridVals.NORMAL);
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(PBTypes.GridVals.NORMAL);
    fightProperties.startFight();

    const caster = createTestUnit({
        name: "Battle Mage",
        team: PBTypes.TeamVals.LEFT,
        attackType: PBTypes.AttackVals.MELEE_MAGIC,
        spells: ["Life:Meteorite"],
        amountAlive: casterAmountAlive,
        stackPower: 5,
        initiative: 5,
        morale: 4,
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
        createTestUnit({ name: "Victim A", team: PBTypes.TeamVals.RIGHT, maxHp: 10_000, initiative: 3 }),
        createTestUnit({ name: "Victim B", team: PBTypes.TeamVals.RIGHT, maxHp: 10_000, initiative: 3 }),
    ];
    placeUnit(context.grid, context.unitsHolder, victims[0], { x: 6, y: 3 });
    placeUnit(context.grid, context.unitsHolder, victims[1], { x: 6, y: 4 });

    const abomination = createTestUnit({
        name: "Abomination",
        team: PBTypes.TeamVals.RIGHT,
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

    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LEFT, 1);
    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.RIGHT, 3);
    fightProperties.startTurn(PBTypes.TeamVals.LEFT, 1000);

    const engine = new GameActionEngine({
        fightProperties,
        grid: context.grid,
        unitsHolder: context.unitsHolder,
        moveHandler: new MoveHandler(context.grid.getSettings(), context.grid, context.unitsHolder),
        sceneLog: new SceneLogMock(),
        attackHandler: context.attackHandler,
    });
    return { ...context, engine, caster, victims, abomination };
};

describe("Flesh Shield aura vs cast spell damage", () => {
    it("leaves a Fire Strike entirely on the target beside the Abomination", () => {
        const unprotected = fireStrike(setupFight(false));
        const protectedRun = fireStrike(setupFight(true));

        // Baseline: the whole strike lands on the victim.
        expect(unprotected.victimTook).toBeGreaterThan(0);
        expect(unprotected.abominationTook).toBe(0);

        // Spell damage is magical, so the aura is inert: the victim takes exactly the unprotected amount.
        expect(protectedRun.victimTook).toBe(unprotected.victimTook);
        expect(protectedRun.abominationTook).toBe(0);
        expect(protectedRun.secondary).toEqual([]);
    });

    it("lands a Meteorite AOE in full on protected units without touching the aura owner", () => {
        // 57 mages x Meteorite's flat 4 x a real 25% Empower bonus = 285 per victim, 570 total.
        const setup = setupMeteoriteFight();
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

        expect(primary.reduce((sum, entry) => sum + entry.amount, 0)).toBe(570);
        expect(secondary).toEqual([]);
        expect(hpBefore.reduce((sum, hp, index) => sum + hp - setup.victims[index].getHp(), 0)).toBe(570);
        // The Abomination stands outside the 2x2 and absorbs nothing, so it keeps every point of its 500 HP.
        expect(setup.abomination.getHp()).toBe(500);
        expect(setup.abomination.isDead()).toBe(false);
        expect(setup.damageStatisticHolder.get().reduce((sum, entry) => sum + entry.damage, 0)).toBe(570);
    });

    it("still lands an aura owner's own simultaneous AOE hit in full", () => {
        // 150 mages x Meteorite's flat 4 = 600 per target. The Abomination stands inside the 2x2 and takes its
        // own direct hit like any other victim — it is capped by its 500 HP, not by anything it absorbed.
        const setup = setupMeteoriteFight(150, { x: 7, y: 4 }, 0);
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
});
