import { expect, spyOn, test } from "bun:test";

import { AbilityFactory } from "../../src/abilities/ability_factory";
import { getAbilityConfig, getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Unit } from "../../src/units/unit";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

const blessing = "Tie up the Horses Blessing";
const left = PBTypes.TeamVals.LEFT;
const right = PBTypes.TeamVals.RIGHT;
const baseBonuses = [0.42, 0.84, 1.26, 1.68, 2.1];

function fixture(tier = 5, luck = 0) {
    const context = createCombatTestContext();
    const champion = createTestUnit({
        team: left,
        name: "Champion",
        abilities: [blessing],
        exp: 1,
        amountAlive: tier * 20,
        luck,
    });
    const near = createTestUnit({ team: left, exp: 1, amountAlive: 100, attack: 100, armor: 100 });
    const far = createTestUnit({ team: left, exp: 1, amountAlive: 100, luck: -10 });
    const flyer = createTestUnit({ team: left, exp: 1, amountAlive: 100, movementType: PBTypes.MovementVals.FLY });
    const enemy = createTestUnit({ team: right, exp: 1, amountAlive: 100 });
    placeUnit(context.grid, context.unitsHolder, champion, { x: 1, y: 1 });
    placeUnit(context.grid, context.unitsHolder, near, { x: 2, y: 1 });
    placeUnit(context.grid, context.unitsHolder, far, { x: 14, y: 14 });
    placeUnit(context.grid, context.unitsHolder, flyer, { x: 13, y: 14 });
    placeUnit(context.grid, context.unitsHolder, enemy, { x: 14, y: 13 });
    const steps = new Map([champion, near, far, flyer, enemy].map((unit) => [unit, unit.getSteps()]));
    return { ...context, champion, near, far, flyer, enemy, steps };
}

test("Champion's real card is a stack-powered army blessing with no local aura", () => {
    const properties = getCreatureConfig(left, "Life", "Champion", "champion_512", 100);
    const effects = new EffectFactory();
    const champion = Unit.createUnit(
        properties,
        testGridSettings,
        left,
        properties.unit_type,
        new AbilityFactory(effects),
        effects,
        false,
    );
    const index = properties.abilities.indexOf(blessing);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(properties.abilities_auras[index]).toBe(false);
    expect(properties.abilities_stack_powered[index]).toBe(true);
    expect(champion.getAuraEffects()).toHaveLength(0);
    expect(getAbilityConfig(blessing).power).toBe(2.1);
});

for (let tier = 1; tier <= 5; tier++) {
    for (const luck of [-10, 0, 10]) {
        test(`tier ${tier}, source luck ${luck}: blesses all walking allies including itself, without accumulating`, () => {
            const f = fixture(tier, luck);
            const expected = Number((baseBonuses[tier - 1] * (1 + luck / 100)).toFixed(4));
            for (let refresh = 0; refresh < 3; refresh++) {
                f.unitsHolder.refreshStackPowerForAllUnits();
                expect(f.champion.getStackPower()).toBe(tier);
                expect(f.champion.getLuck()).toBe(luck);
                for (const unit of [f.champion, f.near, f.far]) {
                    expect(unit.getBuff(blessing)?.getPower()).toBe(expected);
                    expect(unit.getSteps()).toBeCloseTo(f.steps.get(unit)! + expected, 6);
                    expect(unit.getUnitProperties().applied_buffs.filter((name) => name === blessing)).toHaveLength(1);
                }
                for (const unit of [f.flyer, f.enemy]) {
                    expect(unit.hasBuffActive(blessing)).toBe(false);
                    expect(unit.getSteps()).toBe(f.steps.get(unit)!);
                }
                expect(f.near.getBaseAttack()).toBe(100);
                expect(f.near.getBaseArmor()).toBe(100);
                const card =
                    f.champion.getUnitProperties().abilities_descriptions[
                        f.champion.getUnitProperties().abilities.indexOf(blessing)
                    ];
                expect(card).toContain(`+${expected} movement distance anywhere`);
            }
        });
    }
}

test("keeps the exact fractional luck multiplier in the movement budget", () => {
    const f = fixture(1, 1);
    f.unitsHolder.refreshStackPowerForAllUnits();
    expect(f.near.getBuff(blessing)?.getPower()).toBe(0.4242);
    expect(f.near.getSteps()).toBeCloseTo(f.steps.get(f.near)! + 0.4242, 8);
});

test("reads updated team luck immediately, without requiring a Leprechaun or a second refresh", () => {
    const f = fixture();
    const fight = FightStateManager.getInstance().getFightProperties();
    const luck = spyOn(fight, "getAdditionalLuckPerTeam").mockImplementation((team) => (team === left ? 10 : 0));
    try {
        f.unitsHolder.refreshStackPowerForAllUnits();
        expect(f.champion.getLuck()).toBe(10);
        expect(f.far.getBuff(blessing)?.getPower()).toBe(2.31);
        luck.mockImplementation(() => 0);
        f.unitsHolder.refreshStackPowerForAllUnits();
        expect(f.champion.getLuck()).toBe(0);
        expect(f.far.getBuff(blessing)?.getPower()).toBe(2.1);
    } finally {
        luck.mockRestore();
    }
});

test("Leprechaun luck strengthens Champion immediately and disappears immediately on Break", () => {
    const f = fixture(2);
    const leprechaun = createTestUnit({ team: left, abilities: ["Luck Blessing"], exp: 1, amountAlive: 100 });
    placeUnit(f.grid, f.unitsHolder, leprechaun, { x: 3, y: 3 });
    f.unitsHolder.refreshStackPowerForAllUnits();
    expect(f.champion.getLuck()).toBe(10);
    expect(f.far.getBuff(blessing)?.getPower()).toBe(0.924);
    leprechaun.applyEffect(new EffectFactory().makeEffect("Break")!);
    f.unitsHolder.refreshStackPowerForAllUnits();
    expect(f.champion.getLuck()).toBe(0);
    expect(f.far.getBuff(blessing)?.getPower()).toBe(0.84);
});

test("casualties reduce the bonus and same-name sources use the strongest computed power", () => {
    const f = fixture(5, 10);
    const other = createTestUnit({ team: left, abilities: [blessing], exp: 1, amountAlive: 100, luck: -10 });
    placeUnit(f.grid, f.unitsHolder, other, { x: 3, y: 3 });
    f.unitsHolder.refreshStackPowerForAllUnits();
    expect(f.far.getBuff(blessing)?.getPower()).toBe(2.31);
    f.champion.applyDamage(200, 0, new SceneLogMock());
    f.unitsHolder.refreshStackPowerForAllUnits();
    expect(f.champion.getStackPower()).toBe(4);
    expect(f.far.getBuff(blessing)?.getPower()).toBe(1.89); // Other source beats 1.68 × 1.10.
    other.applyEffect(new EffectFactory().makeEffect("Break")!);
    f.unitsHolder.refreshStackPowerForAllUnits();
    expect(f.far.getBuff(blessing)?.getPower()).toBe(1.848);
    f.champion.applyDamage(100000, 0, new SceneLogMock());
    f.unitsHolder.refreshStackPowerForAllUnits();
    expect(f.far.hasBuffActive(blessing)).toBe(false);
    expect(f.far.getSteps()).toBe(f.steps.get(f.far)!);
});

test("Champion and Wolf Rider are separate movement blessings; only Wolf Rider buffs flyers", () => {
    const f = fixture();
    const wolf = createTestUnit({ team: left, abilities: ["Wolf Trail Blessing"], exp: 1, amountAlive: 100 });
    placeUnit(f.grid, f.unitsHolder, wolf, { x: 3, y: 3 });
    f.unitsHolder.refreshStackPowerForAllUnits();
    expect(f.far.getSteps()).toBeCloseTo(f.steps.get(f.far)! + 2.1 + 1, 6);
    expect(f.flyer.getSteps()).toBeCloseTo(f.steps.get(f.flyer)! + 1, 6);
    expect(f.flyer.hasBuffActive(blessing)).toBe(false);
});
