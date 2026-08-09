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
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
    absolvingArrowFirstLiftChance,
    processAbsolvingArrowAbility,
} from "../../src/abilities/absolving_arrow_ability";
import {
    BORROWED_GRACE_MIN_CHANCE,
    borrowedGraceChance,
    isTakeableBuff,
    processBorrowedGraceAbility,
} from "../../src/abilities/borrowed_grace_ability";
import { getCreatureConfig, getSpellConfig } from "../../src/configuration/config_provider";
import { LUCK_MAX_CHANGE_FOR_TURN, MAX_UNIT_STACK_POWER, NUMBER_OF_LAPS_TOTAL } from "../../src/constants";
import { EffectFactory } from "../../src/effects/effect_factory";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Spell } from "../../src/spells/spell";
import { Unit } from "../../src/units/unit";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import {
    createCombatTestContext,
    createTestUnit,
    createVisibleDamage,
    placeUnit,
    testGridSettings,
} from "../helpers/combat";

beforeEach(() => FightStateManager.getInstance().reset());
afterEach(() => setDeterministicRandomSource(undefined));

/**
 * Pin the exact value each getRandomInt(0, 100) call returns, in order. getRandomInt combines one 21-bit
 * and one 32-bit source draw, so an exact raw integer keeps the percentage boundary explicit (same trick
 * as the Predatory Assimilation tests). A single-candidate pick consumes no draw at all — getRandomInt
 * returns min when the span is 1.
 */
const setRolls = (...rolls: number[]) => {
    const draws: number[] = [];
    for (const roll of rolls) {
        draws.push(0, roll / 0x100000000);
    }
    let index = 0;
    setDeterministicRandomSource(() => draws[index++] ?? 0);
};

const config = (faction: string, name: string) =>
    getCreatureConfig(PBTypes.TeamVals.LOWER, faction, name, `${name.toLowerCase()}_512`, 1, 0);

/** adjustBaseStats rolls this turn's luck spread over [-L, L]; the mid value of that range pins luck to 0. */
const setNeutralLuckRoll = () => setRolls(LUCK_MAX_CHANGE_FOR_TURN);

const castBuff = (unit: Unit, faction: string, name: string, laps?: number) =>
    unit.applyBuff(new Spell({ spellProperties: getSpellConfig(faction, name, laps), amount: 1 }));

const castDebuff = (unit: Unit, faction: string, name: string) =>
    unit.applyDebuff(new Spell({ spellProperties: getSpellConfig(faction, name), amount: 1 }));

describe("Monk configuration", () => {
    it("is a Life level 3 walking shooter with the three Monk cards", () => {
        const monk = config("Life", "Monk");

        expect(monk.level).toBe(PBTypes.UnitLevelVals.THIRD);
        expect(monk.attack_type).toBe(PBTypes.AttackVals.RANGE);
        expect(monk.movement_type).toBe(PBTypes.MovementVals.WALK);
        expect(monk.size).toBe(PBTypes.UnitSizeVals.SMALL);
        expect(monk.abilities).toEqual(["Magic Shield", "Borrowed Grace", "Absolving Arrow"]);
    });

    it("trades 10-20% of the Cyclops' defence for a harder but tighter shot", () => {
        const monk = config("Life", "Monk");
        const cyclops = config("Might", "Cyclops");

        // Defence: hp, armor and magic resist all land in the -10%..-20% band.
        const softer = (monkStat: number, cyclopsStat: number) => monkStat / cyclopsStat;
        expect(softer(monk.max_hp, cyclops.max_hp)).toBeGreaterThanOrEqual(0.8);
        expect(softer(monk.max_hp, cyclops.max_hp)).toBeLessThanOrEqual(0.9);
        expect(softer(monk.base_armor, cyclops.base_armor)).toBeGreaterThanOrEqual(0.8);
        expect(softer(monk.base_armor, cyclops.base_armor)).toBeLessThanOrEqual(0.9);
        expect(softer(monk.magic_resist, cyclops.magic_resist)).toBeGreaterThanOrEqual(0.8);
        expect(softer(monk.magic_resist, cyclops.magic_resist)).toBeLessThanOrEqual(0.9);

        // Offence: attack power keeps the original +25%..+35% edge; the damage dice were re-priced by
        // the owner (2026-08-05) from 22-29 to a tighter, more reliable 20-25 — still strictly above
        // the Cyclops' 17-23 on both ends (+8%..+25%), with the spread tightened from 7 to 5 (now
        // matching the Cyclops'): the shot hits harder on average without the old spike ceiling.
        const harder = (monkStat: number, cyclopsStat: number) => monkStat / cyclopsStat;
        expect(harder(monk.base_attack, cyclops.base_attack)).toBeGreaterThanOrEqual(1.25);
        expect(harder(monk.base_attack, cyclops.base_attack)).toBeLessThanOrEqual(1.35);
        expect(monk.attack_damage_min).toBe(20);
        expect(monk.attack_damage_max).toBe(25);
        expect(harder(monk.attack_damage_min, cyclops.attack_damage_min)).toBeGreaterThanOrEqual(1.1);
        expect(harder(monk.attack_damage_max, cyclops.attack_damage_max)).toBeGreaterThanOrEqual(1.08);
        expect(harder(monk.attack_damage_max, cyclops.attack_damage_max)).toBeLessThanOrEqual(1.25);

        // Reach and ammunition are untouched — the shot got harder, not longer.
        expect(monk.range_shots).toBe(cyclops.range_shots);
        expect(monk.shot_distance).toBe(cyclops.shot_distance);
    });
});

// The Monk used to carry "Serene Mind", a byte-for-byte duplicate of Magic Shield (same DEFENCE type,
// same 50 power, same MAGIC_RESIST_50 power type, same text). It was removed in favour of the original.
describe("Magic Shield on the Monk", () => {
    it("adds a 50% magic-armor roll on top of the Monk's own magic resist at full stack", () => {
        const monk = createTestUnit({ name: "Monk", abilities: ["Magic Shield"], magicResist: 8, stackPower: 5 });

        setNeutralLuckRoll();
        monk.adjustBaseStats(true, 1, 0, 0, 0, 0, 0, 0);

        // Independent rolls, exactly like Wardguard: 1 - (1 - 0.08)(1 - 0.5) = 54%.
        expect(monk.getMagicResist()).toBeCloseTo(54, 1);
    });

    it("scales with the stack, so a battered Monk wards less", () => {
        const monk = createTestUnit({ name: "Monk", abilities: ["Magic Shield"], magicResist: 8, stackPower: 1 });

        setNeutralLuckRoll();
        monk.adjustBaseStats(true, 1, 0, 0, 0, 0, 0, 0);

        // 50/5 = 10% at one stack: 1 - 0.92 * 0.9 = 17.2%.
        expect(monk.getMagicResist()).toBeCloseTo(17.2, 1);
    });
});

describe("Borrowed Grace", () => {
    const makeMonk = (stackPower: number, luck = 0) =>
        createTestUnit({ name: "Monk", abilities: ["Borrowed Grace"], stackPower, luck });

    it("runs from 20% at one stack to the card's power at five", () => {
        expect(borrowedGraceChance(makeMonk(1), 0)).toBe(BORROWED_GRACE_MIN_CHANCE);
        expect(borrowedGraceChance(makeMonk(2), 0)).toBe(32.5);
        expect(borrowedGraceChance(makeMonk(3), 0)).toBe(45);
        expect(borrowedGraceChance(makeMonk(4), 0)).toBe(57.5);
        expect(borrowedGraceChance(makeMonk(5), 0)).toBe(70);
    });

    it("takes a cast buff off the target and wears it with the laps it had left", () => {
        const monk = makeMonk(5);
        const target = createTestUnit({ name: "Target", team: PBTypes.TeamVals.UPPER });
        castBuff(target, "Life", "Blessing");
        const laps = target.getBuff("Blessing")?.getLaps();

        setRolls(0); // one candidate, so only the chance roll draws
        const stolen = processBorrowedGraceAbility(monk, target, new SceneLogMock());

        expect(stolen?.buffName).toBe("Blessing");
        expect(target.getBuff("Blessing")).toBeUndefined();
        expect(monk.getBuff("Blessing")?.getLaps()).toBe(laps);
    });

    it("takes nothing when the roll misses", () => {
        const monk = makeMonk(1); // 20% chance
        const target = createTestUnit({ name: "Target", team: PBTypes.TeamVals.UPPER });
        castBuff(target, "Life", "Blessing");

        setRolls(20); // the boundary itself misses
        expect(processBorrowedGraceAbility(monk, target, new SceneLogMock())).toBeUndefined();
        expect(target.getBuff("Blessing")).toBeDefined();
    });

    it("leaves auras and worn equipment alone", () => {
        const monk = makeMonk(5);
        const target = createTestUnit({ name: "Target", team: PBTypes.TeamVals.UPPER });
        target.applyAuraEffect("Luck Aura", "aura", true, 10, "3;3");
        target.applyBuff(
            new Spell({ spellProperties: getSpellConfig("System", "Keen Blade", NUMBER_OF_LAPS_TOTAL), amount: 1 }),
        );

        expect(target.getBuffs().filter(isTakeableBuff)).toHaveLength(0);

        setRolls(0);
        expect(processBorrowedGraceAbility(monk, target, new SceneLogMock())).toBeUndefined();
        expect(target.getBuff("Luck Aura")).toBeDefined();
        expect(target.getBuff("Keen Blade")).toBeDefined();
    });
});

describe("Absolving Arrow", () => {
    const setup = (stackPower = MAX_UNIT_STACK_POWER) => {
        const context = createCombatTestContext();
        const monk = createTestUnit({
            name: "Monk",
            team: PBTypes.TeamVals.LOWER,
            abilities: ["Absolving Arrow"],
            attackType: PBTypes.AttackVals.RANGE,
            stackPower,
        });
        const ally = createTestUnit({ name: "Ally", team: PBTypes.TeamVals.LOWER });
        const enemy = createTestUnit({ name: "Enemy", team: PBTypes.TeamVals.UPPER });

        // One straight column: the arrow leaves the Monk, crosses the ally and ends on the enemy.
        placeUnit(context.grid, context.unitsHolder, monk, { x: 5, y: 2 });
        placeUnit(context.grid, context.unitsHolder, ally, { x: 5, y: 5 });
        placeUnit(context.grid, context.unitsHolder, enemy, { x: 5, y: 8 });

        return { ...context, monk, ally, enemy };
    };

    const absolve = (
        monk: Unit,
        enemy: Unit,
        context: ReturnType<typeof createCombatTestContext>,
    ): ReturnType<typeof processAbsolvingArrowAbility> =>
        processAbsolvingArrowAbility(
            monk,
            enemy.getPosition(),
            context.unitsHolder.getAllUnits(),
            context.grid,
            testGridSettings,
            new SceneLogMock(),
        );

    it("runs the first lift on the flat stack ladder, 20% per stack up to the card's power", () => {
        const first = (stackPower: number) => absolvingArrowFirstLiftChance(setup(stackPower).monk, 0);

        expect(first(1)).toBe(20);
        expect(first(2)).toBe(40);
        expect(first(3)).toBe(60);
        expect(first(4)).toBe(80);
        expect(first(5)).toBe(100);
    });

    it("moves the first lift with the shooter's luck and the team's synergy bonus", () => {
        const monkWithLuck = (stackPower: number, luck: number) =>
            createTestUnit({
                name: "Monk",
                team: PBTypes.TeamVals.LOWER,
                abilities: ["Absolving Arrow"],
                attackType: PBTypes.AttackVals.RANGE,
                stackPower,
                luck,
            });

        // Stack alone would print 60; luck moves it either way (getLuck caps the roll at +-10) and the
        // team's synergy bonus stacks on top of that.
        expect(absolvingArrowFirstLiftChance(monkWithLuck(3, -10), 0)).toBe(50);
        expect(absolvingArrowFirstLiftChance(monkWithLuck(3, 10), 0)).toBe(70);
        expect(absolvingArrowFirstLiftChance(monkWithLuck(3, 10), 10)).toBe(80);
        // Never leaves [0, 100], however far luck and synergy push.
        expect(absolvingArrowFirstLiftChance(monkWithLuck(5, 10), 0)).toBe(100);
        expect(absolvingArrowFirstLiftChance(monkWithLuck(1, -10), -50)).toBe(0);
    });

    it("writes the exact chance onto the card when the ability is granted at runtime", () => {
        // getCreatureConfig bakes the raw power into the card text before any unit exists (the client's
        // refreshAbilitiesDescriptions then swaps in the live figure). A RUNTIME grant does have a unit, so
        // common must print the real chance there — it used to fall through to the raw-power default.
        const bearer = createTestUnit({
            name: "Bearer",
            team: PBTypes.TeamVals.LOWER,
            attackType: PBTypes.AttackVals.RANGE,
            stackPower: 2,
        });
        bearer.grantAbility("Absolving Arrow");

        const index = bearer.getUnitProperties().abilities.indexOf("Absolving Arrow");
        const description = bearer.getUnitProperties().abilities_descriptions[index];

        // 20% per stack: two stacks reads 40, not the card's raw power of 100.
        expect(description).toContain("40% chance");
        expect(description).not.toContain("100% chance");
    });

    it("lifts the ally's only negative effect for certain at full stack", () => {
        const { monk, ally, enemy, ...context } = setup();
        ally.applyEffect(new EffectFactory().makeEffect("Stun")!);

        setRolls(99); // the highest roll there is still beats a 100% chance
        const absolutions = absolve(monk, enemy, context as ReturnType<typeof createCombatTestContext>);

        expect(absolutions).toHaveLength(1);
        expect(absolutions[0]?.liftedNames).toEqual(["Stun"]);
        expect(ally.hasEffectActive("Stun")).toBe(false);
    });

    it("halves the chance for every further negative on the same ally", () => {
        const { monk, ally, enemy, ...context } = setup();
        const effectFactory = new EffectFactory();
        ally.applyEffect(effectFactory.makeEffect("Stun")!);
        ally.applyEffect(effectFactory.makeEffect("Break")!);
        castDebuff(ally, "Death", "Sadness");

        // At five stacks: 100% for the first, 50% for the second, 25% for the third — a roll of 49 clears
        // the second but not the third.
        setRolls(0, 49, 49);
        const absolutions = absolve(monk, enemy, context as ReturnType<typeof createCombatTestContext>);

        expect(absolutions[0]?.liftedNames).toEqual(["Stun", "Break"]);
        expect(ally.hasEffectActive("Stun")).toBe(false);
        expect(ally.hasEffectActive("Break")).toBe(false);
        expect(ally.hasDebuffActive("Sadness")).toBe(true);
    });

    it("keeps the halving ladder at one stack, now starting from 20%", () => {
        const { monk, ally, enemy, ...context } = setup(1);
        const effectFactory = new EffectFactory();
        ally.applyEffect(effectFactory.makeEffect("Stun")!);
        ally.applyEffect(effectFactory.makeEffect("Break")!);

        // 20% then 10%: a roll of 19 lifts the Stun, 9 would have lifted the Break, 10 does not.
        setRolls(19, 10);
        const absolutions = absolve(monk, enemy, context as ReturnType<typeof createCombatTestContext>);

        expect(absolutions[0]?.liftedNames).toEqual(["Stun"]);
        expect(ally.hasEffectActive("Break")).toBe(true);
    });

    it("lifts nothing at one stack when the roll misses the 20%", () => {
        const { monk, ally, enemy, ...context } = setup(1);
        ally.applyEffect(new EffectFactory().makeEffect("Stun")!);

        setRolls(20); // the boundary itself misses
        expect(absolve(monk, enemy, context as ReturnType<typeof createCombatTestContext>)).toEqual([]);
        expect(ally.hasEffectActive("Stun")).toBe(true);
    });

    it("cleanses nobody but allies on the line — not the enemy it is aimed at, not the Monk itself", () => {
        const { monk, ally, enemy, ...context } = setup();
        const effectFactory = new EffectFactory();
        enemy.applyEffect(effectFactory.makeEffect("Stun")!);
        monk.applyEffect(effectFactory.makeEffect("Stun")!);
        ally.applyEffect(effectFactory.makeEffect("Stun")!);

        setRolls(0, 0, 0);
        const absolutions = absolve(monk, enemy, context as ReturnType<typeof createCombatTestContext>);

        expect(absolutions.map((entry) => entry.unitId)).toEqual([ally.getId()]);
        expect(enemy.hasEffectActive("Stun")).toBe(true);
        expect(monk.hasEffectActive("Stun")).toBe(true);
    });

    it("both riders fire on one real shot through handleRangeAttack", () => {
        const { grid, unitsHolder, attackHandler } = createCombatTestContext();
        const monk = createTestUnit({
            name: "Monk",
            team: PBTypes.TeamVals.LOWER,
            attackType: PBTypes.AttackVals.RANGE,
            abilities: ["Borrowed Grace", "Absolving Arrow"],
            attack: 10,
            damageMin: 5,
            damageMax: 5,
            rangeShots: 3,
            stackPower: 5,
        });
        const ally = createTestUnit({ name: "Ally", team: PBTypes.TeamVals.LOWER });
        const enemy = createTestUnit({
            name: "Enemy",
            team: PBTypes.TeamVals.UPPER,
            armor: 100,
            maxHp: 500,
            amountAlive: 5,
        });

        placeUnit(grid, unitsHolder, monk, { x: 5, y: 2 });
        placeUnit(grid, unitsHolder, ally, { x: 5, y: 5 });
        placeUnit(grid, unitsHolder, enemy, { x: 5, y: 8 });
        ally.applyEffect(new EffectFactory().makeEffect("Stun")!);
        castBuff(enemy, "Life", "Blessing");

        // Every roll returns its minimum: the shot cannot miss, the theft cannot fail, the cleanse lands.
        setDeterministicRandomSource(() => 0);
        const result = attackHandler.handleRangeAttack(
            unitsHolder,
            [1],
            1,
            createVisibleDamage(enemy),
            monk,
            [[enemy]],
            undefined,
            enemy.getPosition(),
        );

        expect(result.completed).toBe(true);
        expect(enemy.isDead()).toBe(false);
        // Absolving Arrow cleansed the ally the arrow crossed...
        expect(ally.hasEffectActive("Stun")).toBe(false);
        // ...and Borrowed Grace moved the target's blessing onto the Monk.
        expect(enemy.getBuff("Blessing")).toBeUndefined();
        expect(monk.getBuff("Blessing")).toBeDefined();
    });

    it("does not touch an ally standing off the line", () => {
        const { monk, ally, enemy, ...context } = setup();
        const offLine = createTestUnit({ name: "Off Line", team: PBTypes.TeamVals.LOWER });
        placeUnit(context.grid, context.unitsHolder, offLine, { x: 9, y: 5 });
        offLine.applyEffect(new EffectFactory().makeEffect("Stun")!);
        ally.applyEffect(new EffectFactory().makeEffect("Stun")!);

        setRolls(0, 0);
        absolve(monk, enemy, context as ReturnType<typeof createCombatTestContext>);

        expect(offLine.hasEffectActive("Stun")).toBe(true);
        expect(ally.hasEffectActive("Stun")).toBe(false);
    });
});
