import { describe, expect, it, spyOn } from "bun:test";

import { AbilityFactory } from "../../src/abilities/ability_factory";
import { abilityToTextureName, isEquipmentOrMarkerSpellName } from "../../src/abilities/ability_helper";
import { STACK_BLESSINGS } from "../../src/abilities/stack_blessings";
import { getAbilityConfig, getCreatureConfig, getSpellConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Spell } from "../../src/spells/spell";
import { spellToTextureName } from "../../src/spells/spell_helper";
import { Unit } from "../../src/units/unit";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

const left = PBTypes.TeamVals.LEFT;
const right = PBTypes.TeamVals.RIGHT;
const creatures = [
    ["Nature", "Leprechaun", "Luck Blessing"],
    ["Nature", "Satyr", "Sylvan Focus Blessing"],
    ["Might", "Wolf Rider", "Wolf Trail Blessing"],
];

for (const { name, effect, walkingOnly } of STACK_BLESSINGS) {
    describe(name, () => {
        it("scales at 20% per stack-power tier and retains its icon", () => {
            const base = getAbilityConfig(name).power;
            for (let tier = 1; tier <= 5; tier++) {
                const source = createTestUnit({ abilities: [name], stackPower: tier, luck: 10 });
                expect(source.calculateStackBlessingPower(name)).toBeCloseTo(base * tier * 0.2);
                expect(source.getAuraEffects()).toHaveLength(0);
            }
            const icon = `${effect.toLowerCase().replace(/ /g, "_")}_aura_256`;
            expect(abilityToTextureName(name)).toBe(icon);
            expect(spellToTextureName(name)).toBe(icon);
            expect(isEquipmentOrMarkerSpellName(name)).toBe(true);
        });

        it("reaches distant allies, uses the strongest active source and stops on Break or death", () => {
            const { grid, unitsHolder } = createCombatTestContext();
            const strong = createTestUnit({ team: left, abilities: [name], exp: 1, amountAlive: 100 });
            const weak = createTestUnit({ team: left, abilities: [name], exp: 1, amountAlive: 40 });
            const ally = createTestUnit({ team: left });
            const flyer = createTestUnit({ team: left, movementType: PBTypes.MovementVals.FLY });
            const enemy = createTestUnit({ team: right });
            placeUnit(grid, unitsHolder, strong, { x: 1, y: 1 });
            placeUnit(grid, unitsHolder, weak, { x: 3, y: 1 });
            placeUnit(grid, unitsHolder, ally, { x: 14, y: 14 });
            placeUnit(grid, unitsHolder, flyer, { x: 13, y: 14 });
            placeUnit(grid, unitsHolder, enemy, { x: 14, y: 12 });
            unitsHolder.refreshStackPowerForAllUnits();
            const base = getAbilityConfig(name).power;
            expect(ally.getBuff(name)?.getPower()).toBe(base);
            expect(strong.getBuff(name)?.getPower()).toBe(base);
            expect(flyer.hasBuffActive(name)).toBe(!walkingOnly);
            expect(enemy.hasBuffActive(name)).toBe(false);
            strong.applyEffect(new EffectFactory().makeEffect("Break")!);
            unitsHolder.refreshStackPowerForAllUnits();
            expect(ally.getBuff(name)?.getPower()).toBe(base * 0.4);
            weak.applyDamage(100000, 0, new SceneLogMock());
            unitsHolder.refreshStackPowerForAllUnits();
            expect(ally.hasBuffActive(name)).toBe(false);
            strong.deleteEffect("Break");
            unitsHolder.refreshStackPowerForAllUnits();
            expect(ally.hasBuffActive(name)).toBe(true);
            strong.applyDamage(100000, 0, new SceneLogMock());
            unitsHolder.refreshStackPowerForAllUnits();
            expect(ally.hasBuffActive(name)).toBe(false);
        });

        it("migrates old saved abilities and strips their local aura", () => {
            const source = createTestUnit({ abilities: [name] });
            const properties = structuredClone(source.getUnitProperties());
            properties.abilities = [`${effect} Aura`];
            properties.abilities_auras = [true];
            properties.aura_effects = [effect];
            properties.aura_ranges = [2];
            properties.aura_is_buff = [true];
            const effects = new EffectFactory();
            const restored = Unit.createUnit(
                properties,
                testGridSettings,
                left,
                properties.unit_type,
                new AbilityFactory(effects),
                effects,
                false,
            );
            expect(restored.hasAbilityActive(name)).toBe(true);
            expect(restored.getAuraEffects()).toHaveLength(0);
            expect(restored.getUnitProperties().abilities_auras).toEqual([false]);
        });
    });
}

it("converts the requested Leprechaun, Satyr and Wolf Rider cards", () => {
    for (const [faction, creature, blessing] of creatures) {
        const properties = getCreatureConfig(left, faction, creature, "test_512", 10);
        expect(properties.abilities).toContain(blessing);
        expect(properties.aura_effects).toHaveLength(0);
        expect(properties.abilities_auras.every((value) => !value)).toBe(true);
    }
});

it("applies and removes actual luck, movement and magic bonuses without accumulating", () => {
    const { grid, unitsHolder } = createCombatTestContext();
    const source = createTestUnit({
        team: left,
        abilities: STACK_BLESSINGS.map(({ name }) => name),
        exp: 1,
        amountAlive: 40,
    });
    const ally = createTestUnit({ team: left, attack: 100, armor: 100, luck: 0, exp: 1, amountAlive: 100 });
    placeUnit(grid, unitsHolder, source, { x: 1, y: 1 });
    placeUnit(grid, unitsHolder, ally, { x: 14, y: 14 });
    const baseSteps = ally.getSteps();
    for (let i = 0; i < 3; i++) {
        unitsHolder.refreshStackPowerForAllUnits();
        expect(source.getStackPower()).toBe(2);
        expect(ally.getBaseAttack()).toBe(100);
        expect(ally.getBaseArmor()).toBe(100);
        expect(ally.getSteps()).toBeCloseTo(baseSteps + 0.4);
        expect(ally.getLuck()).toBe(4);
        expect(ally.getMagicDamageBonusPercentage()).toBe(6);
        const index = source.getUnitProperties().abilities.indexOf("Sylvan Focus Blessing");
        expect(source.getUnitProperties().abilities_descriptions[index]).toContain("+6% magic damage");
    }
    source.applyEffect(new EffectFactory().makeEffect("Break")!);
    unitsHolder.refreshStackPowerForAllUnits();
    expect(ally.getBaseAttack()).toBe(100);
    expect(ally.getBaseArmor()).toBe(100);
    expect(ally.getSteps()).toBe(baseSteps);
    expect(ally.getLuck()).toBe(0);
    expect(ally.getMagicDamageBonusPercentage()).toBe(0);
});

for (let tier = 1; tier <= 5; tier++) {
    it(`projects all stack blessings at tier ${tier} and updates after casualties`, () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const source = createTestUnit({
            team: left,
            abilities: STACK_BLESSINGS.map(({ name }) => name),
            exp: 1,
            amountAlive: tier * 20,
        });
        const ally = createTestUnit({ team: left, exp: 1, amountAlive: 100, attack: 100, armor: 100 });
        placeUnit(grid, unitsHolder, source, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, ally, { x: 14, y: 14 });
        const steps = ally.getSteps();
        unitsHolder.refreshStackPowerForAllUnits();
        expect(source.getStackPower()).toBe(tier);
        expect(ally.getBaseAttack()).toBe(100);
        expect(ally.getBaseArmor()).toBe(100);
        expect(ally.getSteps()).toBeCloseTo(steps + tier * 0.2);
        expect(ally.getLuck()).toBe(tier * 2);
        expect(ally.getMagicDamageBonusPercentage()).toBe(tier * 3);
        if (tier > 1) {
            source.applyDamage(200, 0, new SceneLogMock());
            unitsHolder.refreshStackPowerForAllUnits();
            expect(source.getStackPower()).toBe(tier - 1);
            expect(ally.getMagicDamageBonusPercentage()).toBe((tier - 1) * 3);
            expect(ally.getLuck()).toBe((tier - 1) * 2);
        }
    });
}

it("preserves Pegasus and Champion as their existing local auras", () => {
    for (const [faction, creature, aura] of [
        ["Nature", "Pegasus", "Pegasus Might Aura"],
        ["Life", "Champion", "Tie up the Horses Aura"],
    ]) {
        const properties = getCreatureConfig(left, faction, creature, "test_512", 10);
        expect(properties.abilities).toContain(aura);
        expect(getAbilityConfig(aura).aura_effect).not.toBeNull();
        expect(properties.abilities_auras[properties.abilities.indexOf(aura)]).toBe(true);
    }
    expect(getCreatureConfig(left, "Nature", "Pegasus", "test_512", 10).abilities).toEqual([
        "Pegasus Might Aura",
        "Pegasus Light",
    ]);
    expect(STACK_BLESSINGS.map(({ name }) => name)).toEqual([
        "Luck Blessing",
        "Sylvan Focus Blessing",
        "Wolf Trail Blessing",
    ]);
});

it("adds luck to distant allies and the source, respects the cap and cancels Misfortune", () => {
    const { grid, unitsHolder } = createCombatTestContext();
    const source = createTestUnit({ team: left, abilities: ["Luck Blessing"], exp: 1, amountAlive: 40, luck: 4 });
    const ally = createTestUnit({ team: left, exp: 1, amountAlive: 100, luck: 9 });
    const cursed = createTestUnit({ team: left, luck: 4 });
    const enemy = createTestUnit({ team: right, luck: 1 });
    placeUnit(grid, unitsHolder, source, { x: 1, y: 1 });
    placeUnit(grid, unitsHolder, ally, { x: 14, y: 14 });
    placeUnit(grid, unitsHolder, cursed, { x: 13, y: 14 });
    placeUnit(grid, unitsHolder, enemy, { x: 14, y: 12 });
    cursed.applyDebuff(new Spell({ spellProperties: getSpellConfig("Chaos", "Misfortune"), amount: 1 }));
    unitsHolder.refreshStackPowerForAllUnits();
    expect(source.getLuck()).toBe(8);
    expect(ally.getLuck()).toBe(10);
    expect(enemy.getLuck()).toBe(1);
    expect(cursed.getLuck()).toBe(0);
    expect(cursed.applyLuckShield()).toBe(false);
    expect(cursed.getLuck()).toBe(0);
    source.applyEffect(new EffectFactory().makeEffect("Break")!);
    unitsHolder.refreshStackPowerForAllUnits();
    expect(source.getLuck()).toBe(4);
    expect(ally.getLuck()).toBe(9);
    expect(cursed.getLuck()).toBe(-10);
});

it("updates luck-dependent blessings in the same refresh when Luck Blessing appears or disappears", () => {
    const { grid, unitsHolder } = createCombatTestContext();
    const source = createTestUnit({ team: left, abilities: ["Luck Blessing"], exp: 1, amountAlive: 40 });
    const names = [
        "Sharpened Weapons Blessing",
        "Arcane Ward Blessing",
        "Warding Mane Blessing",
        "Arrows Wingshield Blessing",
    ];
    const otherSource = createTestUnit({ team: left, abilities: names, exp: 1, amountAlive: 100, luck: 0 });
    const ally = createTestUnit({ team: left });
    placeUnit(grid, unitsHolder, source, { x: 1, y: 1 });
    placeUnit(grid, unitsHolder, otherSource, { x: 3, y: 1 });
    placeUnit(grid, unitsHolder, ally, { x: 14, y: 14 });
    for (const luck of [4, 0, 4]) {
        if (luck) source.deleteEffect("Break");
        else source.applyEffect(new EffectFactory().makeEffect("Break")!);
        unitsHolder.refreshStackPowerForAllUnits();
        expect(otherSource.getLuck()).toBe(luck);
        for (const name of names) {
            const base = getAbilityConfig(name).power;
            const expected =
                name === "Sharpened Weapons Blessing" || name === "Arcane Ward Blessing"
                    ? base + luck
                    : base * (1 + luck / 100);
            expect(ally.getBuff(name)?.getPower()).toBeCloseTo(expected);
        }
    }
});

it("does not roll luck or apply per-lap growth twice when resolving a blessing source early", () => {
    const { grid, unitsHolder } = createCombatTestContext();
    const source = createTestUnit({ team: left, abilities: ["Luck Blessing"], exp: 1, amountAlive: 100 });
    const squire = createTestUnit({
        team: left,
        abilities: ["Arcane Ward Blessing", "Unyielding Power"],
        exp: 1,
        amountAlive: 100,
        maxHp: 100,
    });
    placeUnit(grid, unitsHolder, source, { x: 1, y: 1 });
    placeUnit(grid, unitsHolder, squire, { x: 3, y: 1 });
    const rolls = spyOn(squire, "randomizeLuckPerTurn");
    try {
        FightStateManager.getInstance().getFightProperties().startFight();
        unitsHolder.refreshStackPowerForAllUnits();
        const hp = squire.getHp();
        const attack = squire.getBaseAttack();
        for (let i = 0; i < 3; i++) unitsHolder.refreshStackPowerForAllUnits();
        expect(rolls).toHaveBeenCalledTimes(1);
        expect(squire.getHp()).toBe(hp);
        expect(squire.getBaseAttack()).toBe(attack);
        expect(squire.getBuff("Arcane Ward Blessing")?.getPower()).toBe(
            getAbilityConfig("Arcane Ward Blessing").power + squire.getLuck(),
        );
    } finally {
        rolls.mockRestore();
    }
});
