import { describe, expect, it } from "bun:test";

import { getAbilityConfig, getCreatureConfig } from "../../src/configuration/config_provider";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const BASE_PERCENT = getAbilityConfig("Sylvan Focus Blessing").power;

const makeSatyr = () =>
    createTestUnit({
        name: "Satyr",
        team: PBTypes.TeamVals.LEFT,
        attackType: PBTypes.AttackVals.MAGIC,
        abilities: ["Sylvan Focus Blessing"],
    });

const makeAlly = (name: string) =>
    createTestUnit({ name, team: PBTypes.TeamVals.LEFT, attackType: PBTypes.AttackVals.MAGIC });

describe("Sylvan Focus Blessing", () => {
    it("is a stack-powered army blessing with base power 15%", () => {
        expect(BASE_PERCENT).toBe(15);
        expect(getAbilityConfig("Sylvan Focus Blessing").stack_powered).toBe(true);
        expect(getAbilityConfig("Sylvan Focus Blessing").aura_effect).toBeNull();
    });

    it("raises the magic-damage bonus of allies anywhere on the battlefield", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const satyr = makeSatyr();
        const near = makeAlly("Near Ally");
        const far = makeAlly("Far Ally");
        const enemy = createTestUnit({
            name: "Enemy",
            team: PBTypes.TeamVals.RIGHT,
            attackType: PBTypes.AttackVals.MAGIC,
        });

        placeUnit(grid, unitsHolder, satyr, { x: 2, y: 2 });
        placeUnit(grid, unitsHolder, near, { x: 3, y: 2 });
        placeUnit(grid, unitsHolder, enemy, { x: 2, y: 3 });
        placeUnit(grid, unitsHolder, far, { x: 9, y: 9 });

        unitsHolder.refreshAuraEffectsForAllUnits();
        unitsHolder.refreshStackPowerForAllUnits();

        expect(near.getBuff("Sylvan Focus Blessing")?.getPower()).toBe(BASE_PERCENT);
        expect(near.getMagicDamageBonusPercentage()).toBe(BASE_PERCENT);
        expect(enemy.getMagicDamageBonusPercentage()).toBe(0);
        expect(far.getMagicDamageBonusPercentage()).toBe(BASE_PERCENT);
        expect(satyr.getMagicDamageBonusPercentage()).toBe(BASE_PERCENT);
    });

    it("uses stack power independently of source and recipient luck", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const luckySatyr = createTestUnit({
            name: "Lucky Satyr",
            team: PBTypes.TeamVals.LEFT,
            attackType: PBTypes.AttackVals.MAGIC,
            abilities: ["Sylvan Focus Blessing"],
            luck: 10,
        });
        const ally = createTestUnit({
            name: "Unlucky Ally",
            team: PBTypes.TeamVals.LEFT,
            attackType: PBTypes.AttackVals.MAGIC,
            luck: -10,
        });

        placeUnit(grid, unitsHolder, luckySatyr, { x: 2, y: 2 });
        placeUnit(grid, unitsHolder, ally, { x: 3, y: 2 });
        unitsHolder.refreshAuraEffectsForAllUnits();
        unitsHolder.refreshStackPowerForAllUnits();

        expect(ally.getBuff("Sylvan Focus Blessing")?.getPower()).toBe(BASE_PERCENT);
        expect(ally.getMagicDamageBonusPercentage()).toBe(BASE_PERCENT);
    });

    it("prints the current stack-scaled value on a runtime-granted card", () => {
        const bearer = createTestUnit({
            name: "Bearer",
            team: PBTypes.TeamVals.LEFT,
            stackPower: 1,
            luck: 10,
        });
        bearer.grantAbility("Sylvan Focus Blessing");

        const index = bearer.getUnitProperties().abilities.indexOf("Sylvan Focus Blessing");
        expect(bearer.getUnitProperties().abilities_descriptions[index]).toContain("3%");
    });

    it("does not compound across aura refreshes", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const satyr = makeSatyr();
        const ally = makeAlly("Ally");
        placeUnit(grid, unitsHolder, satyr, { x: 2, y: 2 });
        placeUnit(grid, unitsHolder, ally, { x: 3, y: 2 });

        for (let refresh = 0; refresh < 4; refresh += 1) {
            unitsHolder.refreshAuraEffectsForAllUnits();
            unitsHolder.refreshStackPowerForAllUnits();
        }

        expect(ally.getMagicDamageBonusPercentage()).toBe(BASE_PERCENT);
    });

    it("persists when the ally walks far away from the source", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const satyr = makeSatyr();
        const ally = makeAlly("Ally");
        placeUnit(grid, unitsHolder, satyr, { x: 2, y: 2 });
        placeUnit(grid, unitsHolder, ally, { x: 3, y: 2 });

        unitsHolder.refreshAuraEffectsForAllUnits();
        unitsHolder.refreshStackPowerForAllUnits();
        expect(ally.getMagicDamageBonusPercentage()).toBe(BASE_PERCENT);

        grid.cleanupAll(ally.getId(), ally.getAttackRange(), ally.isSmallSize());
        placeUnit(grid, unitsHolder, ally, { x: 9, y: 9 });
        unitsHolder.refreshAuraEffectsForAllUnits();
        unitsHolder.refreshStackPowerForAllUnits();

        expect(ally.getBuff("Sylvan Focus Blessing")).toBeDefined();
        expect(ally.getMagicDamageBonusPercentage()).toBe(BASE_PERCENT);
    });
});

describe("Satyr", () => {
    it("carries Sylvan Focus alongside its spellbook", () => {
        const satyr = getCreatureConfig(PBTypes.TeamVals.LEFT, "Nature", "Satyr", "satyr_512", 1, 0);
        expect(satyr.abilities).toEqual(["Forest Spellbook", "Sylvan Focus Blessing"]);
    });
});
