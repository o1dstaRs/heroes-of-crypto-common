/*
 * -----------------------------------------------------------------------------
 * Arrows Wingshield Blessing (Angel): board-wide defence against ranged attacks
 * while a source is alive, scaled 5/10/15/20/25 by stack and then multiplied by
 * that source's Luck. It used to be a range-2 aura painted around the Angel.
 * -----------------------------------------------------------------------------
 */

import { beforeEach, describe, expect, it } from "bun:test";

import { abilityToTextureName, isEquipmentOrMarkerSpellName } from "../../src/abilities/ability_helper";
import { AbilityPowerType, AbilityType } from "../../src/abilities/ability_properties";
import { getAbilityConfig, getAuraEffectConfig, getCreatureConfig } from "../../src/configuration/config_provider";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

beforeEach(() => FightStateManager.getInstance().reset());

const angel = (stackPower: number, luck = 0) =>
    createTestUnit({
        name: "Angel",
        team: PBTypes.TeamVals.LEFT,
        abilities: ["Arrows Wingshield Blessing"],
        stackPower,
        luck,
    });

describe("Arrows Wingshield Blessing", () => {
    it("is a stack-powered mass buff with no aura effect or radius", () => {
        const ability = getAbilityConfig("Arrows Wingshield Blessing");
        const creature = getCreatureConfig(PBTypes.TeamVals.LEFT, "Life", "Angel", "angel_512", 1);
        const abilityIndex = creature.abilities.indexOf("Arrows Wingshield Blessing");

        expect(ability.type).toBe(AbilityType.MASS_BUFF);
        expect(ability.power).toBe(25);
        expect(ability.power_type).toBe(AbilityPowerType.ADDITIONAL_RANGE_ARMOR_PERCENTAGE);
        expect(ability.stack_powered).toBe(true);
        expect(ability.aura_effect).toBeNull();
        expect(getAuraEffectConfig("Arrows Wingshield")).toBeUndefined();
        expect(abilityIndex).toBeGreaterThanOrEqual(0);
        expect(creature.abilities_stack_powered[abilityIndex]).toBe(true);
        expect(creature.abilities_auras[abilityIndex]).toBe(false);
        expect(creature.aura_ranges[abilityIndex]).toBe(0);
    });

    it("runs 5/10/15/20/25 across the stack and scales that value by the source's luck percentage", () => {
        expect([1, 2, 3, 4, 5].map((stack) => angel(stack).calculateArrowsWingshieldBlessingPower())).toEqual([
            5, 10, 15, 20, 25,
        ]);
        expect(angel(3, 10).calculateArrowsWingshieldBlessingPower()).toBe(16.5);
        expect(angel(3, -10).calculateArrowsWingshieldBlessingPower()).toBe(13.5);
        expect(angel(1, -10).calculateArrowsWingshieldBlessingPower()).toBe(4.5);
    });

    it("shields every living ally wherever it stands, and lifts when the last Angel dies", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const luckyCarrier = angel(5, 10);
        const fullStackCarrier = angel(5);
        // Far outside the range-2 radius the old aura painted — the whole point of the redo.
        const distantAlly = createTestUnit({ name: "Distant Ally", team: PBTypes.TeamVals.LEFT, armor: 20 });
        const enemy = createTestUnit({ name: "Enemy", team: PBTypes.TeamVals.RIGHT, armor: 20 });

        placeUnit(grid, unitsHolder, luckyCarrier, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, fullStackCarrier, { x: 2, y: 1 });
        placeUnit(grid, unitsHolder, distantAlly, { x: 10, y: 8 });
        placeUnit(grid, unitsHolder, enemy, { x: 9, y: 7 });

        unitsHolder.refreshStackPowerForAllUnits();
        unitsHolder.refreshStackPowerForAllUnits();

        for (const ally of [luckyCarrier, fullStackCarrier, distantAlly]) {
            expect(ally.getBuff("Arrows Wingshield Blessing")?.getPower()).toBe(27.5);
            expect(
                ally.getAllProperties().applied_buffs.filter((name) => name === "Arrows Wingshield Blessing"),
            ).toHaveLength(1);
        }
        // 20 armor * (1 + 27.5%) = 25.5, and melee armor is untouched.
        expect(distantAlly.getRangeArmor()).toBe(25.5);
        expect(distantAlly.getArmor()).toBe(20);
        expect(enemy.hasBuffActive("Arrows Wingshield Blessing")).toBe(false);
        expect(enemy.getRangeArmor()).toBe(20);

        // The strongest LIVING source wins: killing the lucky Angel drops the army to the plain full stack.
        luckyCarrier.applyDamage(1_000_000, 0, new SceneLogMock());
        unitsHolder.refreshStackPowerForAllUnits();

        expect(distantAlly.getBuff("Arrows Wingshield Blessing")?.getPower()).toBe(25);
        expect(distantAlly.getRangeArmor()).toBe(25);

        // "unless Angel dies from the board" — the last source dying takes the blessing with it.
        fullStackCarrier.applyDamage(1_000_000, 0, new SceneLogMock());
        unitsHolder.refreshStackPowerForAllUnits();
        expect(distantAlly.hasBuffActive("Arrows Wingshield Blessing")).toBe(false);
        expect(distantAlly.getRangeArmor()).toBe(20);
    });

    it("prints the live projection, keeps the barrier clause and reuses the existing Wingshield icon", () => {
        const bearer = createTestUnit({ name: "Bearer", team: PBTypes.TeamVals.LEFT, stackPower: 2, luck: 5 });
        bearer.grantAbility("Arrows Wingshield Blessing");

        const index = bearer.getUnitProperties().abilities.indexOf("Arrows Wingshield Blessing");
        const description = bearer.getUnitProperties().abilities_descriptions[index];

        expect(description).toContain("10.5%");
        expect(description).toContain("all allies on the board");
        // The Angel is still a physical barrier; that half of the card survived the redo.
        expect(description).toContain("immune to being shot through");
        expect(description).toContain("does not propagate AOE range damage");
        expect(abilityToTextureName("Arrows Wingshield Blessing")).toBe("arrows_wingshield_aura_256");
        expect(isEquipmentOrMarkerSpellName("Arrows Wingshield Blessing")).toBe(true);
    });
});
