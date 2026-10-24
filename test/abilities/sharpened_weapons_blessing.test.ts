import { afterEach, describe, expect, it } from "bun:test";

import { AbilityFactory } from "../../src/abilities/ability_factory";
import { abilityToTextureName, isEquipmentOrMarkerSpellName } from "../../src/abilities/ability_helper";
import { AbilityPowerType, AbilityType } from "../../src/abilities/ability_properties";
import {
    getAbilityConfig,
    getAuraEffectConfig,
    getCreatureConfig,
    getSpellConfig,
} from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { GameActionEngine } from "../../src/engine/action_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { TeamType } from "../../src/generated/protobuf/v1/types_gen";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { restoreBattle, snapshotBattle } from "../../src/simulation/battle_snapshot";
import { Spell } from "../../src/spells/spell";
import { spellToTextureName } from "../../src/spells/spell_helper";
import { MightSynergy } from "../../src/synergies/synergy_properties";
import { Unit } from "../../src/units/unit";
import type { UnitProperties } from "../../src/units/unit_properties";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

const BLESSING = "Sharpened Weapons Blessing";
const LEGACY = "Sharpened Weapons Aura";
afterEach(() => setDeterministicRandomSource(undefined));
const bearer = (team: TeamType, stackPower = 5, luck = 0) =>
    createTestUnit({ name: "Crusader", team, abilities: [BLESSING], stackPower, luck, attack: 100 });

function rebuild(properties: UnitProperties): Unit {
    const effects = new EffectFactory();
    return Unit.createUnit(
        properties,
        testGridSettings,
        properties.team,
        properties.unit_type,
        new AbilityFactory(effects),
        effects,
        false,
    );
}

describe(BLESSING, () => {
    it("is Crusader's stack-powered army blessing with no local aura and keeps its published icon", () => {
        const ability = getAbilityConfig(BLESSING);
        const crusader = getCreatureConfig(PBTypes.TeamVals.LEFT, "Life", "Crusader", "crusader_512", 8);
        const index = crusader.abilities.indexOf(BLESSING);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(ability.type).toBe(AbilityType.MASS_BUFF);
        expect(ability.power).toBe(18);
        expect(ability.power_type).toBe(AbilityPowerType.ADDITIONAL_MELEE_DAMAGE_PERCENTAGE);
        expect(ability.stack_powered).toBe(true);
        expect(ability.aura_effect).toBeNull();
        expect(crusader.abilities_stack_powered[index]).toBe(true);
        expect(crusader.abilities_auras[index]).toBe(false);
        expect(crusader.aura_ranges[index]).toBe(0);
        expect(getAuraEffectConfig("Sharpened Weapons")).toBeUndefined();
        expect(abilityToTextureName(BLESSING)).toBe("sharpened_weapons_aura_256");
        expect(spellToTextureName(BLESSING)).toBe("sharpened_weapons_aura_256");
        expect(isEquipmentOrMarkerSpellName(BLESSING)).toBe(true);
    });

    it("keeps the former stack tiers and additive luck, ability synergy and Made of Fire bonuses", () => {
        const team = PBTypes.TeamVals.LEFT;
        expect([1, 2, 3, 4, 5].map((stack) => bearer(team, stack).calculateSharpenedWeaponsBlessingPower())).toEqual([
            3.6, 7.2, 10.8, 14.4, 18,
        ]);
        expect(bearer(team, 3, 10).calculateSharpenedWeaponsBlessingPower(8)).toBe(28.8);
        expect(bearer(team, 5, -10).calculateSharpenedWeaponsBlessingPower()).toBe(8);
        const burning = bearer(team, 3, 10);
        burning.applyBuff(new Spell({ spellProperties: getSpellConfig("System", "Made of Fire"), amount: 1 }));
        expect(burning.calculateSharpenedWeaponsBlessingPower(8)).toBe(30.6);
    });

    for (const team of [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT]) {
        it(`reaches every allied melee and magic stack at any distance, including the source (team ${team})`, () => {
            const { grid, unitsHolder } = createCombatTestContext();
            const source = bearer(team);
            const recipients = [PBTypes.AttackVals.MELEE, PBTypes.AttackVals.MAGIC, PBTypes.AttackVals.MELEE_MAGIC].map(
                (attackType) => createTestUnit({ team, attackType, attack: 100 }),
            );
            const archer = createTestUnit({ team, attackType: PBTypes.AttackVals.RANGE, rangeShots: 2, attack: 100 });
            const enemy = createTestUnit({
                team: team === PBTypes.TeamVals.LEFT ? PBTypes.TeamVals.RIGHT : PBTypes.TeamVals.LEFT,
                attack: 100,
            });
            placeUnit(grid, unitsHolder, source, { x: 1, y: 1 });
            recipients.forEach((unit, i) => placeUnit(grid, unitsHolder, unit, { x: 14, y: 12 + i }));
            placeUnit(grid, unitsHolder, archer, { x: 13, y: 14 });
            placeUnit(grid, unitsHolder, enemy, { x: 2, y: 1 });
            for (let pass = 0; pass < 3; pass++) unitsHolder.refreshStackPowerForAllUnits();
            for (const unit of [source, ...recipients]) {
                expect(unit.getBaseAttack()).toBe(118);
                expect(unit.getBuff(BLESSING)?.getPower()).toBe(18);
                expect(unit.getAllProperties().applied_buffs.filter((name) => name === BLESSING)).toHaveLength(1);
                expect(unit.getAuraEffects()).toHaveLength(0);
            }
            expect(archer.getBaseAttack()).toBe(100);
            expect(archer.hasBuffActive(BLESSING)).toBe(false);
            archer.selectAttackType(PBTypes.AttackVals.MELEE);
            unitsHolder.refreshStackPowerForAllUnits();
            expect(archer.hasBuffActive(BLESSING)).toBe(false);
            expect(enemy.getBaseAttack()).toBe(100);
            expect(enemy.hasBuffActive(BLESSING)).toBe(false);
        });
    }

    it("uses the strongest living unbroken source, falls back, and lifts when the last source dies", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const team = PBTypes.TeamVals.LEFT;
        const strong = bearer(team, 5, 10);
        const weak = bearer(team, 5);
        const ally = createTestUnit({ team, attack: 100 });
        placeUnit(grid, unitsHolder, strong, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, weak, { x: 2, y: 1 });
        placeUnit(grid, unitsHolder, ally, { x: 14, y: 14 });
        unitsHolder.refreshStackPowerForAllUnits();
        expect(ally.getBaseAttack()).toBe(128);
        strong.applyEffect(new EffectFactory().makeEffect("Break")!);
        unitsHolder.refreshStackPowerForAllUnits();
        expect(ally.getBaseAttack()).toBe(118);
        weak.applyEffect(new EffectFactory().makeEffect("Break")!);
        unitsHolder.refreshStackPowerForAllUnits();
        expect(ally.getBaseAttack()).toBe(100);
        expect(ally.hasBuffActive(BLESSING)).toBe(false);
        strong.deleteEffect("Break");
        unitsHolder.refreshStackPowerForAllUnits();
        expect(ally.getBaseAttack()).toBe(128);
        strong.applyDamage(1000, 0, new SceneLogMock());
        weak.deleteEffect("Break");
        unitsHolder.refreshStackPowerForAllUnits();
        expect(ally.getBaseAttack()).toBe(118);
        weak.applyDamage(1000, 0, new SceneLogMock());
        unitsHolder.refreshStackPowerForAllUnits();
        expect(ally.hasBuffActive(BLESSING)).toBe(false);
        expect(ally.getBaseAttack()).toBe(100);
    });

    it("preserves negative-luck penalties on weak stacks and still chooses the strongest source", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const team = PBTypes.TeamVals.LEFT;
        const weak = bearer(team, 1, -10);
        const stronger = bearer(team, 2, -10);
        weak.getUnitProperties().exp = 1;
        stronger.getUnitProperties().exp = 2;
        const ally = createTestUnit({ team, attack: 100 });
        const fullStack = createTestUnit({ team: PBTypes.TeamVals.RIGHT, exp: 5 });
        placeUnit(grid, unitsHolder, weak, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, stronger, { x: 2, y: 1 });
        placeUnit(grid, unitsHolder, ally, { x: 14, y: 14 });
        placeUnit(grid, unitsHolder, fullStack, { x: 13, y: 14 });
        unitsHolder.refreshStackPowerForAllUnits();
        expect(ally.getBuff(BLESSING)?.getPower()).toBe(-2.8);
        expect(ally.getBaseAttack()).toBe(97.2);
        stronger.applyEffect(new EffectFactory().makeEffect("Break")!);
        unitsHolder.refreshStackPowerForAllUnits();
        expect(ally.getBuff(BLESSING)?.getPower()).toBe(-6.4);
        expect(ally.getBaseAttack()).toBe(93.6);
        weak.applyDamage(1000, 0, new SceneLogMock());
        unitsHolder.refreshStackPowerForAllUnits();
        expect(ally.hasBuffActive(BLESSING)).toBe(false);
        expect(ally.getBaseAttack()).toBe(100);
    });

    it("refreshes newly arriving allies, drops off-board sources, and restores the blessing through rollback", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const team = PBTypes.TeamVals.LEFT;
        const source = bearer(team);
        placeUnit(grid, unitsHolder, source, { x: 1, y: 1 });
        const sourcePosition = { ...source.getPosition() };
        unitsHolder.refreshStackPowerForAllUnits();
        const arrival = createTestUnit({ team, attack: 100 });
        placeUnit(grid, unitsHolder, arrival, { x: 14, y: 14 });
        unitsHolder.refreshStackPowerForAllUnits();
        expect(arrival.getBaseAttack()).toBe(118);
        source.setPosition(-10000, -10000);
        unitsHolder.refreshStackPowerForAllUnits();
        expect(arrival.getBaseAttack()).toBe(100);
        expect(arrival.hasBuffActive(BLESSING)).toBe(false);
        source.setPosition(sourcePosition.x, sourcePosition.y);
        unitsHolder.refreshStackPowerForAllUnits();
        const saved = snapshotBattle(unitsHolder, grid, FightStateManager.getInstance().getFightProperties());
        unitsHolder.deleteUnitById(source.getId());
        unitsHolder.refreshStackPowerForAllUnits();
        expect(arrival.getBaseAttack()).toBe(100);
        restoreBattle(saved, unitsHolder, grid, FightStateManager.getInstance().getFightProperties());
        unitsHolder.refreshStackPowerForAllUnits();
        expect(arrival.getBaseAttack()).toBe(118);
        expect(arrival.getAllProperties().applied_buffs.filter((name) => name === BLESSING)).toHaveLength(1);
    });

    it("increases a distant ally's actual melee damage through the ranked engine's start and attack actions", () => {
        const context = createCombatTestContext();
        const team = PBTypes.TeamVals.LEFT;
        const source = bearer(team);
        const attacker = createTestUnit({ team, attack: 100, damageMin: 10, damageMax: 10, maxHp: 1000 });
        const target = createTestUnit({
            team: PBTypes.TeamVals.RIGHT,
            armor: 10,
            maxHp: 1000,
            abilities: ["No Melee"],
        });
        placeUnit(context.grid, context.unitsHolder, source, { x: 1, y: 1 });
        placeUnit(context.grid, context.unitsHolder, attacker, { x: 13, y: 14 });
        placeUnit(context.grid, context.unitsHolder, target, { x: 14, y: 14 });
        const fightProperties = FightStateManager.getInstance().getFightProperties();
        const engine = new GameActionEngine({
            ...context,
            fightProperties,
            sceneLog: new SceneLogMock(),
            moveHandler: new MoveHandler(context.grid.getSettings(), context.grid, context.unitsHolder),
        });
        setDeterministicRandomSource(() => 3 / 2 ** 32);
        expect(engine.apply({ type: "start_fight" }).completed).toBe(true);
        expect(attacker.getBaseAttack()).toBe(118);
        fightProperties.startTurn(team, 1000);
        const result = engine.apply({
            type: "melee_attack",
            attackerId: attacker.getId(),
            targetId: target.getId(),
            attackFrom: attacker.getBaseCell(),
        });
        expect(result.completed).toBe(true);
        const hit = result.events.find((event) => event.type === "unit_attacked");
        expect(hit?.damage.amount).toBe(118);
        expect(target.getCumulativeHp()).toBe(882);
    });

    it("uses native Crusader stats and Might synergy in the shared engine and its ranked card text", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const team = PBTypes.TeamVals.LEFT;
        const source = rebuild(getCreatureConfig(team, "Life", "Crusader", "crusader_512", 8));
        const ally = createTestUnit({ team, attack: 100 });
        const fight = FightStateManager.getInstance().getFightProperties();
        fight.setSynergyVariants({ Might: MightSynergy.PLUS_STACK_ABILITIES_POWER });
        fight.setSynergyUnitsPerFactions(team, 0, 0, 4, 0);
        placeUnit(grid, unitsHolder, source, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, ally, { x: 14, y: 14 });
        unitsHolder.refreshStackPowerForAllUnits();
        expect(source.getStackPower()).toBe(5);
        expect(ally.getBuff(BLESSING)?.getPower()).toBe(27);
        expect(ally.getBaseAttack()).toBe(127);
        const index = source.getAllProperties().abilities.indexOf(BLESSING);
        const description = source.getAllProperties().abilities_descriptions[index];
        expect(description).toContain("+27%");
        expect(description).toContain("all allied melee and magic units on the battlefield");
        expect(source.getAuraEffects()).toHaveLength(0);
        const snapshotProperties = ally.getAllProperties();
        snapshotProperties.base_attack_authoritative = true;
        const rankedAlly = rebuild(snapshotProperties);
        rankedAlly.adjustBaseStats(false, 1, 8, 0, 0, 0, 0, 0);
        expect(rankedAlly.getBaseAttack()).toBe(127);
        expect(rankedAlly.getAllProperties().applied_buffs).toContain(BLESSING);
    });

    it("migrates saved and stolen aura cards, removes the radius, and canonicalizes runtime grants", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const properties = bearer(PBTypes.TeamVals.LEFT).getAllProperties();
        properties.abilities = [LEGACY];
        properties.abilities_descriptions = ["Affected melee allies have +18% base attack power"];
        properties.abilities_auras = [true];
        properties.aura_effects = ["Sharpened Weapons"];
        properties.aura_ranges = [2];
        properties.applied_buffs = [LEGACY];
        properties.applied_buffs_powers = [18];
        properties.applied_buffs_laps = [Number.MAX_SAFE_INTEGER];
        properties.applied_buffs_descriptions = ["Affected melee allies have +18% base attack power.;1;1"];
        const restored = rebuild(properties);
        placeUnit(grid, unitsHolder, restored, { x: 1, y: 1 });
        unitsHolder.refreshStackPowerForAllUnits();
        expect(restored.getAllProperties().abilities).toEqual([BLESSING]);
        expect(restored.getAllProperties().abilities_auras).toEqual([false]);
        expect(restored.getAllProperties().abilities_stack_powered).toEqual([true]);
        expect(restored.getAllProperties().aura_ranges).toEqual([0]);
        expect(restored.getAllProperties().applied_buffs).toEqual([BLESSING]);
        expect(restored.getAuraEffects()).toHaveLength(0);
        expect(restored.getBaseAttack()).toBe(118);
        expect(getAbilityConfig(LEGACY).name).toBe(BLESSING);
        properties.stolen_abilities = [LEGACY];
        properties.artifact_granted_abilities = [LEGACY];
        const stolen = rebuild(properties);
        expect(stolen.getAllProperties().stolen_abilities).toEqual([BLESSING]);
        expect(stolen.getAllProperties().artifact_granted_abilities).toEqual([BLESSING]);
        expect(stolen.hasAbilityActive(BLESSING)).toBe(false);
        expect(stolen.getAuraEffects()).toHaveLength(0);
        stolen.grantAbility(LEGACY);
        expect(stolen.hasAbilityActive(BLESSING)).toBe(false);
        stolen.grantStolenAbility(LEGACY);
        expect(stolen.hasAbilityActive(BLESSING)).toBe(true);
        expect(stolen.getAuraEffects()).toHaveLength(0);
    });
});
