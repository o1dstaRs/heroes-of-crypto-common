/*
 * -----------------------------------------------------------------------------
 * The Satyr's Sylvan Focus Aura: allies standing within 2 cells deal more MAGIC damage.
 *
 * The bonus lands on the same surface the Empower augment amplifies — spells and the magic
 * abilities — which is why both are summed in one place (Unit.getMagicDamageBonusPercentage)
 * rather than each multiplying the damage separately.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import { getAbilityConfig, getAuraEffectConfig, getCreatureConfig } from "../../src/configuration/config_provider";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const AURA_PERCENT = getAbilityConfig("Sylvan Focus Aura").power;

const makeSatyr = () =>
    createTestUnit({
        name: "Satyr",
        team: PBTypes.TeamVals.LEFT,
        attackType: PBTypes.AttackVals.MAGIC,
        abilities: ["Sylvan Focus Aura"],
        auraEffects: ["Sylvan Focus"],
        auraRanges: [2],
        auraIsBuff: [true],
    });

const makeAlly = (name: string) =>
    createTestUnit({ name, team: PBTypes.TeamVals.LEFT, attackType: PBTypes.AttackVals.MAGIC });

describe("Sylvan Focus Aura", () => {
    it("is a flat, non-stack-powered 2-cell buff aura worth 15%", () => {
        const aura = getAuraEffectConfig("Sylvan Focus");
        expect(aura?.range).toBe(2);
        expect(aura?.is_buff).toBe(true);
        expect(AURA_PERCENT).toBe(15);
        expect(getAbilityConfig("Sylvan Focus Aura").stack_powered).toBe(false);
    });

    it("raises the magic-damage bonus of allies in range, and only those", () => {
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

        expect(near.getAppliedAuraEffect("Sylvan Focus Aura")?.getPower()).toBe(AURA_PERCENT);
        expect(near.getMagicDamageBonusPercentage()).toBe(AURA_PERCENT);
        // It buffs allies only — an enemy standing just as close gets nothing.
        expect(enemy.getMagicDamageBonusPercentage()).toBe(0);
        expect(far.getMagicDamageBonusPercentage()).toBe(0);
        // The Satyr stands in its own aura.
        expect(satyr.getMagicDamageBonusPercentage()).toBe(AURA_PERCENT);
    });

    // The SATYR's luck sets the strength for everyone — it is folded into the stored aura power, so the
    // ally's buff and the Satyr's own ability card both read the same recalculated number. The ally's own
    // luck is irrelevant, which is what makes it "the aura's strength" rather than a per-ally roll.
    it("adds the Satyr's luck to the bonus every ally receives", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const luckySatyr = createTestUnit({
            name: "Lucky Satyr",
            team: PBTypes.TeamVals.LEFT,
            attackType: PBTypes.AttackVals.MAGIC,
            abilities: ["Sylvan Focus Aura"],
            auraEffects: ["Sylvan Focus"],
            auraRanges: [2],
            auraIsBuff: [true],
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

        expect(ally.getAppliedAuraEffect("Sylvan Focus Aura")?.getPower()).toBe(AURA_PERCENT + 10);
        expect(ally.getMagicDamageBonusPercentage()).toBe(AURA_PERCENT + 10);
    });

    it("prints the owner's luck-adjusted value on a runtime-granted card", () => {
        const bearer = createTestUnit({
            name: "Bearer",
            team: PBTypes.TeamVals.LEFT,
            stackPower: 1,
            luck: 10,
        });
        bearer.grantAbility("Sylvan Focus Aura");

        const index = bearer.getUnitProperties().abilities.indexOf("Sylvan Focus Aura");
        expect(bearer.getUnitProperties().abilities_descriptions[index]).toContain("25%");
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

        expect(ally.getMagicDamageBonusPercentage()).toBe(AURA_PERCENT);
    });

    it("is given up when the ally walks out of the aura", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const satyr = makeSatyr();
        const ally = makeAlly("Ally");
        placeUnit(grid, unitsHolder, satyr, { x: 2, y: 2 });
        placeUnit(grid, unitsHolder, ally, { x: 3, y: 2 });

        unitsHolder.refreshAuraEffectsForAllUnits();
        unitsHolder.refreshStackPowerForAllUnits();
        expect(ally.getMagicDamageBonusPercentage()).toBe(AURA_PERCENT);

        grid.cleanupAll(ally.getId(), ally.getAttackRange(), ally.isSmallSize());
        placeUnit(grid, unitsHolder, ally, { x: 9, y: 9 });
        unitsHolder.refreshAuraEffectsForAllUnits();
        unitsHolder.refreshStackPowerForAllUnits();

        expect(ally.getAppliedAuraEffect("Sylvan Focus Aura")).toBeUndefined();
        expect(ally.getMagicDamageBonusPercentage()).toBe(0);
    });
});

describe("Satyr", () => {
    it("carries Sylvan Focus alongside its spellbook", () => {
        const satyr = getCreatureConfig(PBTypes.TeamVals.LEFT, "Nature", "Satyr", "satyr_512", 1, 0);
        expect(satyr.abilities).toEqual(["Forest Spellbook", "Sylvan Focus Aura"]);
    });
});
