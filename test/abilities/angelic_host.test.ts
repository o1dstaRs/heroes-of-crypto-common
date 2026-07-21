/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 * -----------------------------------------------------------------------------
 */

import { beforeEach, describe, expect, it } from "bun:test";

import { AbilityPowerType, AbilityType } from "../../src/abilities/ability_properties";
import { getAbilityConfig, getCreatureConfig, getSpellConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Spell } from "../../src/spells/spell";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

beforeEach(() => FightStateManager.getInstance().reset());

describe("Angelic Host configuration", () => {
    it("assigns the non-stacking army passive to Angel without an aura radius", () => {
        const ability = getAbilityConfig("Angelic Host");
        const angel = getCreatureConfig(PBTypes.TeamVals.LOWER, "Life", "Angel", "angel_512", 1);
        const abilityIndex = angel.abilities.indexOf("Angelic Host");

        expect(ability.type).toBe(AbilityType.MASS_BUFF);
        expect(ability.power).toBe(1);
        expect(ability.power_type).toBe(AbilityPowerType.ARMY_FLYING_ATTACK_ARMOR_STEPS);
        expect(ability.stack_powered).toBe(false);
        expect(ability.aura_effect).toBeNull();
        expect(abilityIndex).toBeGreaterThanOrEqual(0);
        expect(angel.abilities_stack_powered[abilityIndex]).toBe(false);
        expect(angel.abilities_auras[abilityIndex]).toBe(false);
        expect(angel.aura_ranges[abilityIndex]).toBe(0);
    });
});

describe("Angelic Host army passive", () => {
    it("buffs the living carrier and every allied flyer, without range or stacking", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const firstCarrier = createTestUnit({
            name: "Angel",
            team: PBTypes.TeamVals.LOWER,
            abilities: ["Angelic Host"],
            movementType: PBTypes.MovementVals.FLY,
        });
        const secondCarrier = createTestUnit({
            name: "Second Carrier",
            team: PBTypes.TeamVals.LOWER,
            abilities: ["Angelic Host"],
            movementType: PBTypes.MovementVals.FLY,
        });
        const distantAlliedFlyer = createTestUnit({
            name: "Distant Allied Flyer",
            team: PBTypes.TeamVals.LOWER,
            movementType: PBTypes.MovementVals.FLY,
        });
        const alliedWalker = createTestUnit({ name: "Allied Walker", team: PBTypes.TeamVals.LOWER });
        const enemyFlyer = createTestUnit({
            name: "Enemy Flyer",
            team: PBTypes.TeamVals.UPPER,
            movementType: PBTypes.MovementVals.FLY,
        });

        placeUnit(grid, unitsHolder, firstCarrier, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, secondCarrier, { x: 2, y: 1 });
        placeUnit(grid, unitsHolder, distantAlliedFlyer, { x: 10, y: 8 });
        placeUnit(grid, unitsHolder, alliedWalker, { x: 4, y: 4 });
        placeUnit(grid, unitsHolder, enemyFlyer, { x: 9, y: 7 });

        unitsHolder.refreshStackPowerForAllUnits();
        unitsHolder.refreshStackPowerForAllUnits();

        for (const flyer of [firstCarrier, secondCarrier, distantAlliedFlyer]) {
            expect(flyer.getAttack()).toBe(11);
            expect(flyer.getArmor()).toBe(11);
            expect(flyer.getRangeArmor()).toBe(11);
            expect(flyer.getSteps()).toBe(4);
            expect(flyer.getAllProperties().applied_buffs.filter((name) => name === "Angelic Host")).toHaveLength(1);
            expect(flyer.getBuff("Angelic Host")?.getPower()).toBe(1);
        }

        expect(alliedWalker.hasBuffActive("Angelic Host")).toBe(false);
        expect(alliedWalker.getAttack()).toBe(10);
        expect(alliedWalker.getArmor()).toBe(10);
        expect(alliedWalker.getSteps()).toBe(3);
        expect(enemyFlyer.hasBuffActive("Angelic Host")).toBe(false);
        expect(enemyFlyer.getAttack()).toBe(10);
        expect(enemyFlyer.getArmor()).toBe(10);
        expect(enemyFlyer.getSteps()).toBe(3);

        const serialized = distantAlliedFlyer.getAllProperties();
        const markerIndex = serialized.applied_buffs.indexOf("Angelic Host");
        expect(serialized.applied_buffs_powers[markerIndex]).toBe(1);
        expect(serialized.applied_buffs_descriptions[markerIndex]).toContain(
            "Angelic Host grants +1 attack, +1 defense and +1 movement distance.",
        );

        firstCarrier.applyDamage(1_000, 0, new SceneLogMock());
        unitsHolder.refreshStackPowerForAllUnits();
        expect(distantAlliedFlyer.getAttack()).toBe(11);
        expect(
            distantAlliedFlyer.getAllProperties().applied_buffs.filter((name) => name === "Angelic Host"),
        ).toHaveLength(1);

        secondCarrier.applyDamage(1_000, 0, new SceneLogMock());
        unitsHolder.refreshStackPowerForAllUnits();
        expect(distantAlliedFlyer.getAttack()).toBe(10);
        expect(distantAlliedFlyer.getArmor()).toBe(10);
        expect(distantAlliedFlyer.getSteps()).toBe(3);
        expect(distantAlliedFlyer.hasBuffActive("Angelic Host")).toBe(false);
    });

    it("applies exactly +1 after percentage attack, defense and movement effects", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const carrier = createTestUnit({
            name: "Angel",
            team: PBTypes.TeamVals.LOWER,
            abilities: ["Angelic Host"],
            movementType: PBTypes.MovementVals.FLY,
        });
        const hostedFlyer = createTestUnit({
            name: "Hosted Flyer",
            team: PBTypes.TeamVals.LOWER,
            movementType: PBTypes.MovementVals.FLY,
        });
        const controlFlyer = createTestUnit({
            name: "Control Flyer",
            team: PBTypes.TeamVals.UPPER,
            movementType: PBTypes.MovementVals.FLY,
        });

        placeUnit(grid, unitsHolder, carrier, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, hostedFlyer, { x: 5, y: 5 });
        placeUnit(grid, unitsHolder, controlFlyer, { x: 8, y: 5 });

        for (const flyer of [hostedFlyer, controlFlyer]) {
            flyer.applyBuff(new Spell({ spellProperties: getSpellConfig("Chaos", "Riot"), amount: 1 }));
            flyer.applyBuff(new Spell({ spellProperties: getSpellConfig("Life", "Spiritual Armor"), amount: 1 }));
            flyer.applyDebuff(new Spell({ spellProperties: getSpellConfig("Death", "Quagmire"), amount: 1 }));
        }

        unitsHolder.refreshStackPowerForAllUnits();

        expect(hostedFlyer.getAttack() - controlFlyer.getAttack()).toBe(1);
        expect(hostedFlyer.getArmor() - controlFlyer.getArmor()).toBe(1);
        expect(hostedFlyer.getRangeArmor() - controlFlyer.getRangeArmor()).toBe(1);
        expect(hostedFlyer.getSteps() - controlFlyer.getSteps()).toBe(1);
    });

    it("removes the army bonus while the last carrier is Broken and restores it when Break expires", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const carrier = createTestUnit({
            name: "Angel",
            team: PBTypes.TeamVals.LOWER,
            abilities: ["Angelic Host"],
            movementType: PBTypes.MovementVals.FLY,
        });
        const alliedFlyer = createTestUnit({
            name: "Allied Flyer",
            team: PBTypes.TeamVals.LOWER,
            movementType: PBTypes.MovementVals.FLY,
        });
        placeUnit(grid, unitsHolder, carrier, { x: 2, y: 2 });
        placeUnit(grid, unitsHolder, alliedFlyer, { x: 8, y: 7 });

        unitsHolder.refreshStackPowerForAllUnits();
        for (const flyer of [carrier, alliedFlyer]) {
            expect(flyer.getAttack()).toBe(11);
            expect(flyer.getArmor()).toBe(11);
            expect(flyer.getRangeArmor()).toBe(11);
            expect(flyer.getSteps()).toBe(4);
            expect(flyer.hasBuffActive("Angelic Host")).toBe(true);
        }

        const breakEffect = new EffectFactory().makeEffect("Break");
        expect(breakEffect).toBeDefined();
        expect(carrier.applyEffect(breakEffect!)).toBe(true);
        expect(carrier.hasAbilityActive("Angelic Host")).toBe(false);
        unitsHolder.refreshStackPowerForAllUnits();

        for (const flyer of [carrier, alliedFlyer]) {
            expect(flyer.getAttack()).toBe(10);
            expect(flyer.getArmor()).toBe(10);
            expect(flyer.getRangeArmor()).toBe(10);
            expect(flyer.getSteps()).toBe(3);
            expect(flyer.hasBuffActive("Angelic Host")).toBe(false);
        }

        carrier.minusLap();
        expect(carrier.hasEffectActive("Break")).toBe(false);
        expect(carrier.hasAbilityActive("Angelic Host")).toBe(true);
        unitsHolder.refreshStackPowerForAllUnits();

        for (const flyer of [carrier, alliedFlyer]) {
            expect(flyer.getAttack()).toBe(11);
            expect(flyer.getArmor()).toBe(11);
            expect(flyer.getRangeArmor()).toBe(11);
            expect(flyer.getSteps()).toBe(4);
            expect(flyer.hasBuffActive("Angelic Host")).toBe(true);
        }
    });

    it("removes the bonus on the last carrier's death and restores it after self-resurrection", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const carrier = createTestUnit({
            name: "Angel",
            team: PBTypes.TeamVals.LOWER,
            abilities: ["Angelic Host", "Resurrection"],
            spells: [":Resurrection"],
            amountAlive: 2,
            movementType: PBTypes.MovementVals.FLY,
        });
        const alliedFlyer = createTestUnit({
            name: "Allied Flyer",
            team: PBTypes.TeamVals.LOWER,
            movementType: PBTypes.MovementVals.FLY,
        });
        placeUnit(grid, unitsHolder, carrier, { x: 2, y: 2 });
        placeUnit(grid, unitsHolder, alliedFlyer, { x: 7, y: 6 });

        unitsHolder.refreshStackPowerForAllUnits();
        expect(alliedFlyer.getAttack()).toBe(11);

        carrier.applyDamage(1_000, 0, new SceneLogMock());
        unitsHolder.refreshStackPowerForAllUnits();
        expect(carrier.isDead()).toBe(true);
        expect(alliedFlyer.hasBuffActive("Angelic Host")).toBe(false);
        expect(alliedFlyer.getAttack()).toBe(10);
        expect(alliedFlyer.getArmor()).toBe(10);
        expect(alliedFlyer.getSteps()).toBe(3);

        expect(unitsHolder.deleteUnitById(carrier.getId(), true)).toBe(false);
        expect(carrier.isDead()).toBe(false);
        unitsHolder.refreshStackPowerForAllUnits();

        expect(alliedFlyer.getAttack()).toBe(11);
        expect(alliedFlyer.getArmor()).toBe(11);
        expect(alliedFlyer.getSteps()).toBe(4);
        expect(alliedFlyer.getAllProperties().applied_buffs.filter((name) => name === "Angelic Host")).toHaveLength(1);
    });

    it("follows the active ability when Predatory Assimilation steals it", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const originalCarrier = createTestUnit({
            name: "Angel",
            team: PBTypes.TeamVals.LOWER,
            abilities: ["Angelic Host"],
            movementType: PBTypes.MovementVals.FLY,
        });
        const lowerFlyer = createTestUnit({
            name: "Lower Flyer",
            team: PBTypes.TeamVals.LOWER,
            movementType: PBTypes.MovementVals.FLY,
        });
        const thief = createTestUnit({
            name: "Arachna Queen",
            team: PBTypes.TeamVals.UPPER,
            abilities: ["Predatory Assimilation"],
            movementType: PBTypes.MovementVals.FLY,
        });
        const upperFlyer = createTestUnit({
            name: "Upper Flyer",
            team: PBTypes.TeamVals.UPPER,
            movementType: PBTypes.MovementVals.FLY,
        });
        placeUnit(grid, unitsHolder, originalCarrier, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, lowerFlyer, { x: 3, y: 3 });
        placeUnit(grid, unitsHolder, thief, { x: 8, y: 8 });
        placeUnit(grid, unitsHolder, upperFlyer, { x: 10, y: 8 });

        unitsHolder.refreshStackPowerForAllUnits();
        expect(lowerFlyer.getAttack()).toBe(11);
        expect(upperFlyer.getAttack()).toBe(10);

        expect(originalCarrier.disableAbilityAsStolen("Angelic Host")).toBeDefined();
        thief.grantStolenAbility("Angelic Host");
        unitsHolder.refreshStackPowerForAllUnits();

        expect(originalCarrier.hasAbilityActive("Angelic Host")).toBe(false);
        expect(thief.hasAbilityActive("Angelic Host")).toBe(true);
        expect(lowerFlyer.getAttack()).toBe(10);
        expect(lowerFlyer.hasBuffActive("Angelic Host")).toBe(false);
        expect(thief.getAttack()).toBe(11);
        expect(upperFlyer.getAttack()).toBe(11);
    });
});
