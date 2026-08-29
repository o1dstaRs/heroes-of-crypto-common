/*
 * -----------------------------------------------------------------------------
 * Warding Mane Blessing (Manticore): board-wide magic defence while a source is
 * alive, scaled 5/10/15/20/25 by stack and then multiplied by that source's Luck.
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

const manticore = (stackPower: number, luck = 0) =>
    createTestUnit({
        name: "Manticore",
        team: PBTypes.TeamVals.LOWER,
        abilities: ["Warding Mane Blessing"],
        stackPower,
        luck,
    });

describe("Warding Mane Blessing", () => {
    it("is a stack-powered mass buff with no aura effect or radius", () => {
        const ability = getAbilityConfig("Warding Mane Blessing");
        const creature = getCreatureConfig(PBTypes.TeamVals.LOWER, "Chaos", "Manticore", "manticore_512", 1);
        const abilityIndex = creature.abilities.indexOf("Warding Mane Blessing");

        expect(ability.type).toBe(AbilityType.MASS_BUFF);
        expect(ability.power).toBe(25);
        expect(ability.power_type).toBe(AbilityPowerType.ADDITIONAL_MAGIC_RESIST_PERCENTAGE);
        expect(ability.stack_powered).toBe(true);
        expect(ability.aura_effect).toBeNull();
        expect(getAuraEffectConfig("Warding Mane")).toBeUndefined();
        expect(abilityIndex).toBeGreaterThanOrEqual(0);
        expect(creature.abilities_stack_powered[abilityIndex]).toBe(true);
        expect(creature.abilities_auras[abilityIndex]).toBe(false);
        expect(creature.aura_ranges[abilityIndex]).toBe(0);
    });

    it("runs 5/10/15/20/25 across the stack and scales that value by the source's luck percentage", () => {
        expect([1, 2, 3, 4, 5].map((stack) => manticore(stack).calculateWardingManeBlessingPower())).toEqual([
            5, 10, 15, 20, 25,
        ]);
        expect(manticore(3, 10).calculateWardingManeBlessingPower()).toBe(16.5);
        expect(manticore(3, -10).calculateWardingManeBlessingPower()).toBe(13.5);
        expect(manticore(1, -10).calculateWardingManeBlessingPower()).toBe(4.5);
    });

    it("affects every living ally, uses the strongest source and ends when the last source dies", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const luckyCarrier = manticore(5, 10);
        const fullStackCarrier = manticore(5);
        const distantAlly = createTestUnit({
            name: "Distant Ally",
            team: PBTypes.TeamVals.LOWER,
            magicResist: 20,
        });
        const enemy = createTestUnit({ name: "Enemy", team: PBTypes.TeamVals.UPPER, magicResist: 20 });

        placeUnit(grid, unitsHolder, luckyCarrier, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, fullStackCarrier, { x: 2, y: 1 });
        placeUnit(grid, unitsHolder, distantAlly, { x: 10, y: 8 });
        placeUnit(grid, unitsHolder, enemy, { x: 9, y: 7 });

        unitsHolder.refreshStackPowerForAllUnits();
        unitsHolder.refreshStackPowerForAllUnits();

        for (const ally of [luckyCarrier, fullStackCarrier, distantAlly]) {
            expect(ally.getBuff("Warding Mane Blessing")?.getPower()).toBe(27.5);
            expect(
                ally.getAllProperties().applied_buffs.filter((name) => name === "Warding Mane Blessing"),
            ).toHaveLength(1);
        }
        expect(distantAlly.getMagicResist()).toBe(42);
        expect(enemy.hasBuffActive("Warding Mane Blessing")).toBe(false);
        expect(enemy.getMagicResist()).toBe(20);

        luckyCarrier.applyDamage(1_000, 0, new SceneLogMock());
        unitsHolder.refreshStackPowerForAllUnits();

        expect(distantAlly.getBuff("Warding Mane Blessing")?.getPower()).toBe(25);
        expect(distantAlly.getMagicResist()).toBe(40);

        fullStackCarrier.applyDamage(1_000, 0, new SceneLogMock());
        unitsHolder.refreshStackPowerForAllUnits();
        expect(distantAlly.hasBuffActive("Warding Mane Blessing")).toBe(false);
        expect(distantAlly.getMagicResist()).toBe(20);
    });

    it("prints the live projection and reuses the existing Warding Mane icon", () => {
        const bearer = createTestUnit({ name: "Bearer", team: PBTypes.TeamVals.LOWER, stackPower: 2, luck: 5 });
        bearer.grantAbility("Warding Mane Blessing");

        const index = bearer.getUnitProperties().abilities.indexOf("Warding Mane Blessing");
        const description = bearer.getUnitProperties().abilities_descriptions[index];

        expect(description).toContain("10.5%");
        expect(description).toContain("all allies on the board");
        expect(abilityToTextureName("Warding Mane Blessing")).toBe("warding_mane_aura_256");
        expect(isEquipmentOrMarkerSpellName("Warding Mane Blessing")).toBe(true);
    });
});
