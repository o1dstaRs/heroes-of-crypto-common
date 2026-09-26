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

import { beforeEach, describe, expect, it } from "bun:test";
import { processFireforgedSwordAbility } from "../../src/abilities/fireforged_sword_ability";
import { SceneLogMock } from "../../src/scene/scene_log_mock";

import { EmpowerAugment, DefaultPlacementLevel1 } from "../../src/augments/augment_properties";
import { NUMBER_OF_LAPS_TOTAL } from "../../src/constants";
import { getSpellConfig } from "../../src/configuration/config_provider";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { Doctrine } from "../../src/doctrines/doctrine_properties";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { Spell } from "../../src/spells/spell";
import { fireforgedSwordDamage, getEmpowerPercentage } from "../../src/spells/spell_damage";
import { createCombatTestContext, createTestUnit, DamageStatisticHolder, placeUnit } from "../helpers/combat";

/**
 * End-to-end checks that the Empower Augment reaches the places that DEAL magic damage — not just the pure
 * helpers. The augment travels as an "Empower Augment" buff applied by UnitsHolder.applyAugments, so these
 * tests buy the augment on FightProperties the way the pickers do and then read what the units end up with.
 */
const setupTeam = (empower: EmpowerAugment) => {
    const context = createCombatTestContext(PBTypes.GridVals.NORMAL);
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(PBTypes.GridVals.NORMAL);
    fightProperties.setDoctrinePerTeam(PBTypes.TeamVals.LEFT, Doctrine.SEE_NONE);
    fightProperties.setDefaultPlacementPerTeam(PBTypes.TeamVals.LEFT, DefaultPlacementLevel1.THREE_BY_THREE);
    fightProperties.setDoctrinePerTeam(PBTypes.TeamVals.RIGHT, Doctrine.SEE_NONE);
    fightProperties.setDefaultPlacementPerTeam(PBTypes.TeamVals.RIGHT, DefaultPlacementLevel1.THREE_BY_THREE);
    if (empower) {
        expect(fightProperties.setAugmentPerTeam(PBTypes.TeamVals.LEFT, { type: "Empower", value: empower })).toBe(
            true,
        );
    }
    return { context, fightProperties };
};

describe("Empower augment in a live fight", () => {
    beforeEach(() => {
        FightStateManager.getInstance().reset();
    });

    it("puts the buff on the whole team, and on nobody else's", () => {
        const { context, fightProperties } = setupTeam(EmpowerAugment.LEVEL_2);

        const mage = createTestUnit({ name: "Battle Mage", team: PBTypes.TeamVals.LEFT, initiative: 5 });
        const friend = createTestUnit({ name: "Friend", team: PBTypes.TeamVals.LEFT, initiative: 4 });
        const enemy = createTestUnit({ name: "Enemy", team: PBTypes.TeamVals.RIGHT, initiative: 3 });
        placeUnit(context.grid, context.unitsHolder, mage, { x: 3, y: 3 });
        placeUnit(context.grid, context.unitsHolder, friend, { x: 4, y: 3 });
        placeUnit(context.grid, context.unitsHolder, enemy, { x: 3, y: 6 });

        context.unitsHolder.applyAugments(fightProperties);

        expect(mage.getEmpowerPercentage()).toBe(15);
        expect(friend.getEmpowerPercentage()).toBe(15);
        expect(enemy.getEmpowerPercentage()).toBe(0);
        // The same number the damage helpers read off the caster.
        expect(getEmpowerPercentage(mage)).toBe(15);
    });

    it("is nothing at all until the team buys it", () => {
        const { context, fightProperties } = setupTeam(EmpowerAugment.NO_AUGMENT);
        const mage = createTestUnit({ name: "Battle Mage", team: PBTypes.TeamVals.LEFT, initiative: 5 });
        placeUnit(context.grid, context.unitsHolder, mage, { x: 3, y: 3 });

        context.unitsHolder.applyAugments(fightProperties);

        expect(mage.getEmpowerPercentage()).toBe(0);
        expect(mage.getBuff("Empower Augment")).toBeUndefined();
    });

    it("raises the three magic abilities' multipliers and leaves the physical ones alone", () => {
        const { context, fightProperties } = setupTeam(EmpowerAugment.LEVEL_3);
        const plain = createCombatTestContext(PBTypes.GridVals.NORMAL);

        const empowered = createTestUnit({
            name: "Dragon",
            team: PBTypes.TeamVals.LEFT,
            initiative: 5,
            abilities: ["Fire Breath", "Fire Shield", "Chain Lightning", "Double Punch"],
        });
        const baseline = createTestUnit({
            name: "Dragon",
            team: PBTypes.TeamVals.RIGHT,
            initiative: 5,
            abilities: ["Fire Breath", "Fire Shield", "Chain Lightning", "Double Punch"],
        });
        placeUnit(context.grid, context.unitsHolder, empowered, { x: 3, y: 3 });
        placeUnit(plain.grid, plain.unitsHolder, baseline, { x: 3, y: 3 });

        context.unitsHolder.applyAugments(fightProperties);

        for (const abilityName of ["Fire Breath", "Fire Shield", "Chain Lightning"]) {
            const boostedAbility = empowered.getAbility(abilityName);
            const plainAbility = baseline.getAbility(abilityName);
            expect(boostedAbility).toBeDefined();
            expect(plainAbility).toBeDefined();
            const boosted = empowered.calculateAbilityMultiplier(boostedAbility!, 0);
            const plainValue = baseline.calculateAbilityMultiplier(plainAbility!, 0);
            expect(boosted).toBeCloseTo(plainValue * 1.24, 6);
        }

        // Double Punch is a physical ability: Might's business, not Empower's.
        const boostedPunch = empowered.getAbility("Double Punch");
        const plainPunch = baseline.getAbility("Double Punch");
        if (boostedPunch && plainPunch) {
            expect(empowered.calculateAbilityMultiplier(boostedPunch, 0)).toBeCloseTo(
                baseline.calculateAbilityMultiplier(plainPunch, 0),
                6,
            );
        }
    });

    it("prints the raised figure on the Fire Shield / Fire Breath cards", () => {
        const { context, fightProperties } = setupTeam(EmpowerAugment.LEVEL_1);
        const dragon = createTestUnit({ name: "Dragon", team: PBTypes.TeamVals.LEFT, initiative: 5 });
        placeUnit(context.grid, context.unitsHolder, dragon, { x: 3, y: 3 });

        // Augment first, then hand the abilities over: registerAbility writes each card's text as it lands,
        // and the buff has to be on the unit by then for the card to read the Empowered number.
        context.unitsHolder.applyAugments(fightProperties);
        dragon.grantAbility("Fire Breath");
        dragon.grantAbility("Fire Shield");

        const descriptions = dragon.getUnitProperties().abilities_descriptions.join("\n");
        // Fire Shield's configured 40% becomes 42.8%, Fire Breath's 100% becomes 107%.
        expect(descriptions).toContain("42.8");
        expect(descriptions).toContain("107");
    });

    it("leaves a Fireforged Sword at its own percentage when the team bought Empower", () => {
        const { context, fightProperties } = setupTeam(EmpowerAugment.LEVEL_3);
        const swordsman = createTestUnit({ name: "Swordsman", team: PBTypes.TeamVals.LEFT, initiative: 5 });
        const target = createTestUnit({
            name: "Target",
            team: PBTypes.TeamVals.RIGHT,
            magicResist: 0,
            maxHp: 500,
            amountAlive: 5,
        });
        placeUnit(context.grid, context.unitsHolder, swordsman, { x: 3, y: 3 });
        placeUnit(context.grid, context.unitsHolder, target, { x: 4, y: 3 });

        context.unitsHolder.applyAugments(fightProperties);
        swordsman.applyBuff(
            new Spell({
                spellProperties: getSpellConfig("Chaos", "Fireforged Sword", NUMBER_OF_LAPS_TOTAL),
                amount: 1,
            }),
        );
        swordsman.adjustBaseStats(false, 0, PBTypes.GridVals.NORMAL, 0, [], 0, 0, false);

        // Empower is on the team, and it must not touch the blade. The sword stays a magic rider — it
        // does not fold into attack — and a 100-damage hit still burns for the buff's own 20.
        expect(swordsman.getEmpowerPercentage()).toBe(24);
        expect(swordsman.getUnitProperties().attack_mod).toBe(0);
        expect(swordsman.getBuff("Fireforged Sword")?.getPower()).toBe(20);
        const secondary: { source: string; amount: number }[] = [];
        processFireforgedSwordAbility(
            swordsman,
            target,
            100,
            new SceneLogMock(),
            new DamageStatisticHolder(),
            secondary,
        );
        expect(secondary).toEqual([expect.objectContaining({ source: "fireforged_sword", amount: 20 })]);
        expect(
            fireforgedSwordDamage({
                damageDealt: 100,
                swordPercentage: swordsman.getBuff("Fireforged Sword")?.getPower() ?? 0,
                targetMagicResist: 0,
                targetIsFireElement: false,
                targetIsWaterElement: false,
            }),
        ).toBe(20);
    });
});
