/*
 * -----------------------------------------------------------------------------
 * Arcane Ward Blessing (Squire): flat board-wide magic defence for every living ally,
 * equal to 10 plus the strongest living source's Luck until that source dies.
 * -----------------------------------------------------------------------------
 */

import { beforeEach, describe, expect, it } from "bun:test";

import { AbilityPowerType, AbilityType } from "../../src/abilities/ability_properties";
import { abilityToTextureName } from "../../src/abilities/ability_helper";
import { getAbilityConfig, getAuraEffectConfig, getCreatureConfig } from "../../src/configuration/config_provider";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

beforeEach(() => FightStateManager.getInstance().reset());

const squire = (stackPower: number, luck = 0) =>
    createTestUnit({
        name: "Squire",
        team: PBTypes.TeamVals.LOWER,
        abilities: ["Arcane Ward Blessing"],
        stackPower,
        luck,
    });

describe("Arcane Ward Blessing", () => {
    it("is a non-stack-powered mass buff with no aura effect or radius", () => {
        const ability = getAbilityConfig("Arcane Ward Blessing");
        const creature = getCreatureConfig(PBTypes.TeamVals.LOWER, "Life", "Squire", "squire_512", 1);
        const abilityIndex = creature.abilities.indexOf("Arcane Ward Blessing");

        expect(ability.type).toBe(AbilityType.MASS_BUFF);
        expect(ability.power).toBe(10);
        expect(ability.power_type).toBe(AbilityPowerType.ADDITIONAL_MAGIC_RESIST_PERCENTAGE);
        expect(ability.stack_powered).toBe(false);
        expect(ability.aura_effect).toBeNull();
        expect(getAuraEffectConfig("Arcane Ward")).toBeUndefined();
        expect(abilityIndex).toBeGreaterThanOrEqual(0);
        expect(creature.abilities_stack_powered[abilityIndex]).toBe(false);
        expect(creature.abilities_auras[abilityIndex]).toBe(false);
        expect(creature.aura_ranges[abilityIndex]).toBe(0);
    });

    it("always grants 10 plus luck regardless of stack size", () => {
        expect([1, 2, 3, 4, 5].map((stack) => squire(stack).calculateArcaneWardBlessingPower())).toEqual([
            10, 10, 10, 10, 10,
        ]);
        expect(squire(1, 10).calculateArcaneWardBlessingPower()).toBe(20);
        expect(squire(5, -10).calculateArcaneWardBlessingPower()).toBe(0);
    });

    it("affects every living ally on the board, uses the strongest source and never affects enemies", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const strongerCarrier = squire(1, 5);
        const weakerCarrier = squire(5);
        const distantAlly = createTestUnit({
            name: "Distant Ally",
            team: PBTypes.TeamVals.LOWER,
            magicResist: 20,
        });
        const enemy = createTestUnit({ name: "Enemy", team: PBTypes.TeamVals.UPPER, magicResist: 20 });

        placeUnit(grid, unitsHolder, strongerCarrier, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, weakerCarrier, { x: 2, y: 1 });
        placeUnit(grid, unitsHolder, distantAlly, { x: 10, y: 8 });
        placeUnit(grid, unitsHolder, enemy, { x: 9, y: 7 });

        unitsHolder.refreshStackPowerForAllUnits();
        unitsHolder.refreshStackPowerForAllUnits();

        for (const ally of [strongerCarrier, weakerCarrier, distantAlly]) {
            expect(ally.getBuff("Arcane Ward Blessing")?.getPower()).toBe(15);
            expect(
                ally.getAllProperties().applied_buffs.filter((name) => name === "Arcane Ward Blessing"),
            ).toHaveLength(1);
        }
        expect(distantAlly.getMagicResist()).toBe(32);
        expect(enemy.hasBuffActive("Arcane Ward Blessing")).toBe(false);
        expect(enemy.getMagicResist()).toBe(20);

        strongerCarrier.applyDamage(1_000, 0, new SceneLogMock());
        unitsHolder.refreshStackPowerForAllUnits();

        expect(distantAlly.getBuff("Arcane Ward Blessing")?.getPower()).toBe(10);
        expect(distantAlly.getMagicResist()).toBe(28);

        weakerCarrier.applyDamage(1_000, 0, new SceneLogMock());
        unitsHolder.refreshStackPowerForAllUnits();
        expect(distantAlly.hasBuffActive("Arcane Ward Blessing")).toBe(false);
        expect(distantAlly.getMagicResist()).toBe(20);
    });

    it("prints the live projection on runtime-granted cards and uses the renamed icon key", () => {
        const bearer = createTestUnit({ name: "Bearer", team: PBTypes.TeamVals.LOWER, stackPower: 2, luck: 5 });
        bearer.grantAbility("Arcane Ward Blessing");

        const index = bearer.getUnitProperties().abilities.indexOf("Arcane Ward Blessing");
        const description = bearer.getUnitProperties().abilities_descriptions[index];

        expect(description).toContain("15%");
        expect(description).toContain("does not scale with stack size");
        expect(abilityToTextureName("Arcane Ward Blessing")).toBe("arcane_ward_blessing_256");
    });
});
