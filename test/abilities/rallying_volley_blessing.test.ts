import { describe, expect, it } from "bun:test";
import { AbilityFactory } from "../../src/abilities/ability_factory";
import { abilityToTextureName, isEquipmentOrMarkerSpellName } from "../../src/abilities/ability_helper";
import { AbilityPowerType, AbilityType } from "../../src/abilities/ability_properties";
import {
    getAbilityConfig,
    getAuraEffectConfig,
    getCreatureConfig,
    getSpellConfig,
} from "../../src/configuration/config_provider";
import { MAX_UNIT_STACK_POWER } from "../../src/constants";
import { EffectFactory } from "../../src/effects/effect_factory";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { TeamType } from "../../src/generated/protobuf/v1/types_gen";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Spell } from "../../src/spells/spell";
import { Unit } from "../../src/units/unit";
import type { UnitProperties } from "../../src/units/unit_properties";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const BLESSING = "Rallying Volley Blessing";
const LEGACY = "Rallying Volley Aura";
const shooter = (team: TeamType, name = "Archer", shots = 5) =>
    createTestUnit({ name, team, attackType: PBTypes.AttackVals.RANGE, rangeShots: shots, amountAlive: 10 });
const bearer = (team: TeamType) =>
    createTestUnit({
        name: "Zena",
        team,
        attackType: PBTypes.AttackVals.RANGE,
        rangeShots: 8,
        abilities: [BLESSING],
    });
const rebuild = (properties: UnitProperties, grid: ReturnType<typeof createCombatTestContext>["grid"]): Unit => {
    const effects = new EffectFactory();
    return Unit.createUnit(
        properties,
        grid.getSettings(),
        properties.team,
        properties.unit_type,
        new AbilityFactory(effects),
        effects,
        false,
    );
};

describe(BLESSING, () => {
    it("is a flat mass blessing with no aura/radius, canonical art and a protected army marker", () => {
        const ability = getAbilityConfig(BLESSING);
        const zena = getCreatureConfig(PBTypes.TeamVals.LEFT, "Might", "Zena", "zena_512", 1);
        const index = zena.abilities.indexOf(BLESSING);
        expect(ability.type).toBe(AbilityType.MASS_BUFF);
        expect(ability.power_type).toBe(AbilityPowerType.ADDITIONAL_RANGE_SHOTS);
        expect(ability.power).toBe(2);
        expect(ability.stack_powered).toBe(false);
        expect(ability.aura_effect).toBeNull();
        expect(getAuraEffectConfig("Rallying Volley")).toBeUndefined();
        expect(index).toBeGreaterThanOrEqual(0);
        expect(zena.abilities_auras[index]).toBe(false);
        expect(zena.aura_ranges[index]).toBe(0);
        expect(abilityToTextureName(BLESSING)).toBe("rallying_volley_blessing_256");
        expect(isEquipmentOrMarkerSpellName(BLESSING)).toBe(true);
    });

    for (const team of [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT]) {
        it(`reaches the whole army, including its source, without giving melee-only units a bow (team ${team})`, () => {
            const { grid, unitsHolder } = createCombatTestContext();
            const zena = bearer(team);
            const distant = shooter(team);
            const empty = shooter(team, "Empty Archer", 0);
            const melee = createTestUnit({ name: "Melee", team, rangeShots: 0, shotDistance: 0 });
            const enemy = shooter(team === PBTypes.TeamVals.LEFT ? PBTypes.TeamVals.RIGHT : PBTypes.TeamVals.LEFT);
            placeUnit(grid, unitsHolder, zena, { x: 1, y: 1 });
            placeUnit(grid, unitsHolder, distant, { x: 14, y: 14 });
            placeUnit(grid, unitsHolder, empty, { x: 14, y: 13 });
            placeUnit(grid, unitsHolder, melee, { x: 13, y: 14 });
            placeUnit(grid, unitsHolder, enemy, { x: 2, y: 1 });
            unitsHolder.refreshStackPowerForAllUnits();
            expect(zena.getRangeShots()).toBe(10);
            expect(distant.getRangeShots()).toBe(7);
            expect(empty.getRangeShots()).toBe(2);
            for (const unit of [zena, distant, empty, melee]) {
                expect(unit.getBuff(BLESSING)?.getPower()).toBe(2);
                expect(unit.getAllProperties().applied_buffs.filter((name) => name === BLESSING)).toHaveLength(1);
                expect(unit.getAuraEffects()).toHaveLength(0);
            }
            expect(melee.getRangeShots()).toBe(0);
            expect(melee.isRangeCapable()).toBe(false);
            melee.refreshPossibleAttackTypes(true);
            expect(melee.getPossibleAttackTypes()).not.toContain(PBTypes.AttackVals.RANGE);
            expect(enemy.getRangeShots()).toBe(5);
            expect(enemy.hasBuffActive(BLESSING)).toBe(false);
        });

        it(`does not scale with stack/luck, stack across bearers, or replenish spent shots (team ${team})`, () => {
            const { grid, unitsHolder } = createCombatTestContext();
            const first = bearer(team);
            const second = bearer(team);
            const archer = shooter(team);
            first.getUnitProperties().stack_power = 5;
            first.getUnitProperties().luck = 20;
            second.getUnitProperties().stack_power = 1;
            second.getUnitProperties().luck = -20;
            placeUnit(grid, unitsHolder, first, { x: 1, y: 1 });
            placeUnit(grid, unitsHolder, second, { x: 2, y: 1 });
            placeUnit(grid, unitsHolder, archer, { x: 14, y: 14 });
            for (let i = 0; i < 4; i++) unitsHolder.refreshStackPowerForAllUnits();
            expect(archer.getRangeShots()).toBe(7);
            archer.decreaseNumberOfShots();
            archer.decreaseNumberOfShots();
            unitsHolder.refreshStackPowerForAllUnits();
            expect(archer.getRangeShots()).toBe(5);
            expect(archer.getUnitProperties().rallying_volley_granted).toBe(2);
        });
    }

    it("grants a newly arriving ally and a newly granted shooter, without converting ordinary melee", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const team = PBTypes.TeamVals.LEFT;
        const zena = bearer(team);
        const laterShooter = createTestUnit({ name: "Arachna Queen", team, rangeShots: 0, shotDistance: 0 });
        placeUnit(grid, unitsHolder, zena, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, laterShooter, { x: 14, y: 14 });
        unitsHolder.refreshStackPowerForAllUnits();
        expect(laterShooter.getUnitProperties().rallying_volley_granted).toBe(0);
        laterShooter.grantStolenAbility("Endless Quiver");
        const arrival = shooter(team, "Summoned Archer");
        placeUnit(grid, unitsHolder, arrival, { x: 14, y: 13 });
        unitsHolder.refreshStackPowerForAllUnits();
        expect(arrival.getRangeShots()).toBe(7);
        expect(laterShooter.getUnitProperties().range_shots).toBe(2);
        expect(laterShooter.getUnitProperties().rallying_volley_granted).toBe(2);
        expect(laterShooter.isRangeCapable()).toBe(true);
        expect(laterShooter.getAttackType()).toBe(PBTypes.AttackVals.MELEE);
    });

    it("does not revoke granted arrows or grant again after source death, Break, resurrection or replacement", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const zena = bearer(PBTypes.TeamVals.LEFT);
        const archer = shooter(PBTypes.TeamVals.LEFT);
        placeUnit(grid, unitsHolder, zena, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, archer, { x: 14, y: 14 });
        unitsHolder.refreshStackPowerForAllUnits();
        archer.decreaseNumberOfShots();
        const breakEffect = new EffectFactory().makeEffect("Break")!;
        zena.applyEffect(breakEffect);
        unitsHolder.refreshStackPowerForAllUnits();
        expect(archer.getRangeShots()).toBe(6);
        expect(archer.hasBuffActive(BLESSING)).toBe(false);
        zena.deleteEffect("Break");
        zena.applyDamage(10_000, 0, new SceneLogMock());
        unitsHolder.refreshStackPowerForAllUnits();
        expect(archer.getRangeShots()).toBe(6);
        zena.reviveAfterDeath(1);
        unitsHolder.refreshStackPowerForAllUnits();
        expect(archer.getRangeShots()).toBe(6);
        expect(archer.hasBuffActive(BLESSING)).toBe(true);
        archer.applyDamage(10_000, 0, new SceneLogMock());
        archer.reviveAfterDeath(1);
        unitsHolder.refreshStackPowerForAllUnits();
        expect(archer.getRangeShots()).toBe(6);
        zena.disableAbilityAsStolen(BLESSING);
        const enemyBearer = bearer(PBTypes.TeamVals.RIGHT);
        placeUnit(grid, unitsHolder, enemyBearer, { x: 2, y: 1 });
        unitsHolder.refreshStackPowerForAllUnits();
        expect(archer.getRangeShots()).toBe(6);
        expect(archer.hasBuffActive(BLESSING)).toBe(false);
        expect(enemyBearer.getRangeShots()).toBe(10);
        zena.grantStolenAbility(BLESSING);
        unitsHolder.refreshStackPowerForAllUnits();
        expect(archer.getRangeShots()).toBe(6);
    });

    it("preserves the grant ledger and total remaining arrows through split and merge refreshes", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const zena = bearer(PBTypes.TeamVals.LEFT);
        const archer = shooter(PBTypes.TeamVals.LEFT);
        placeUnit(grid, unitsHolder, zena, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, archer, { x: 14, y: 14 });
        unitsHolder.refreshStackPowerForAllUnits();
        archer.decreaseNumberOfShots();
        const split = shooter(PBTypes.TeamVals.LEFT, "Archer Part");
        archer.shareResourcesWithSplit(split, 4);
        archer.setAmountAlive(6);
        split.setAmountAlive(4);
        placeUnit(grid, unitsHolder, split, { x: 14, y: 13 });
        unitsHolder.refreshStackPowerForAllUnits();
        expect(archer.getRangeShots() + split.getRangeShots()).toBe(6);
        expect(split.getUnitProperties().rallying_volley_granted).toBe(2);
        archer.takeResourcesFromMerge(split, 4);
        split.setAmountAlive(0);
        archer.setAmountAlive(10);
        unitsHolder.refreshStackPowerForAllUnits();
        expect(archer.getRangeShots()).toBe(6);
    });

    for (let tier = 1; tier <= MAX_UNIT_STACK_POWER; tier++) {
        it(`keeps the flat grant above real Arbalester Limited Supply at stack power ${tier}`, () => {
            const { grid } = createCombatTestContext();
            const config = getCreatureConfig(PBTypes.TeamVals.LEFT, "Life", "Arbalester", "arbalester_512", 50);
            const ownShots = config.range_shots;
            const arbalester = rebuild(config, grid);
            arbalester.getUnitProperties().stack_power = tier;
            const grant = () =>
                arbalester.applyBuff(new Spell({ spellProperties: getSpellConfig("System", BLESSING), amount: 1 }));
            grant();
            arbalester.adjustBaseStats(false, 1, 0, 0, 0, 0, 0, 0);
            const expected = Math.floor((ownShots * tier) / MAX_UNIT_STACK_POWER) + 2;
            expect(arbalester.getRangeShots()).toBe(expected);
            arbalester.decreaseNumberOfShots();
            arbalester.deleteBuff(BLESSING);
            grant();
            arbalester.adjustBaseStats(false, 1, 0, 0, 0, 0, 0, 0);
            expect(arbalester.getRangeShots()).toBe(expected - 1);
        });
    }

    it("migrates legacy saved cards, stolen cards and markers without restoring the old aura or ammo", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const properties = bearer(PBTypes.TeamVals.LEFT).getAllProperties();
        properties.abilities = [LEGACY];
        properties.abilities_descriptions = ["Allied RANGED units in range gain +2 shots"];
        properties.abilities_auras = [true];
        properties.aura_effects = ["Rallying Volley"];
        properties.aura_ranges = [2];
        properties.applied_buffs = [LEGACY];
        properties.applied_buffs_powers = [2];
        properties.applied_buffs_laps = [15];
        properties.applied_buffs_descriptions = ["Ranged allies within range gain +2 shots.;1;1"];
        properties.range_shots = 9;
        properties.rallying_volley_granted = 2;
        const restored = rebuild(properties, grid);
        placeUnit(grid, unitsHolder, restored, { x: 1, y: 1 });
        unitsHolder.refreshStackPowerForAllUnits();
        expect(restored.getRangeShots()).toBe(9);
        expect(restored.getAuraEffects()).toHaveLength(0);
        expect(restored.getAllProperties().abilities).toEqual([BLESSING]);
        expect(restored.getAllProperties().abilities_auras).toEqual([false]);
        expect(restored.getAllProperties().aura_ranges).toEqual([0]);
        expect(restored.getAllProperties().abilities_descriptions[0]).not.toContain("in range");
        expect(restored.getAllProperties().applied_buffs).toEqual([BLESSING]);
        expect(getAbilityConfig(LEGACY).name).toBe(BLESSING);
        properties.stolen_abilities = [LEGACY];
        const stolen = rebuild(properties, grid);
        expect(stolen.getAllProperties().stolen_abilities).toEqual([BLESSING]);
        expect(stolen.hasAbilityActive(BLESSING)).toBe(false);
        expect(stolen.getAuraEffects()).toHaveLength(0);
        delete (properties as Partial<UnitProperties>).rallying_volley_granted;
        const olderSaved = rebuild(properties, grid);
        expect(olderSaved.getUnitProperties().rallying_volley_granted).toBe(2);
        expect(olderSaved.getRangeShots()).toBe(9);
    });
});
