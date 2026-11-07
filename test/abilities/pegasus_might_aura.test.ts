import { expect, test } from "bun:test";

import { AbilityType } from "../../src/abilities/ability_properties";
import { getAbilityConfig, getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const team = PBTypes.TeamVals.LEFT;
const aura = "Pegasus Might Aura";

test("Pegasus keeps its original aura and Pegasus Light", () => {
    const properties = getCreatureConfig(team, "Nature", "Pegasus", "test_512", 10);
    expect(properties.abilities).toEqual([aura, "Pegasus Light"]);
    expect(getAbilityConfig(aura)).toMatchObject({
        type: AbilityType.BUFF_AURA,
        power: 2,
        stack_powered: false,
        aura_effect: "Pegasus Might",
    });
});

test.each([1, 2, 3, 4, 5])("Pegasus grants the same nearby +2 attack and armor at stack tier %s", (tier) => {
    const { grid, unitsHolder } = createCombatTestContext();
    const source = createTestUnit({ team, abilities: [aura], exp: 1, amountAlive: tier * 20, luck: 10 });
    const near = createTestUnit({ team, attack: 100, armor: 100, exp: 1, amountAlive: 100 });
    const far = createTestUnit({ team, attack: 100, armor: 100 });
    const enemy = createTestUnit({ team: PBTypes.TeamVals.RIGHT, attack: 100, armor: 100 });
    placeUnit(grid, unitsHolder, source, { x: 4, y: 8 });
    placeUnit(grid, unitsHolder, near, { x: 6, y: 8 });
    placeUnit(grid, unitsHolder, far, { x: 14, y: 14 });
    placeUnit(grid, unitsHolder, enemy, { x: 4, y: 10 });
    const sourceAttack = source.getBaseAttack();
    for (let refresh = 0; refresh < 3; refresh++) {
        unitsHolder.refreshStackPowerForAllUnits();
        expect(source.getBaseAttack()).toBe(sourceAttack + 2);
        expect(near.getBaseAttack()).toBe(102);
        expect(near.getBaseArmor()).toBe(102);
        expect(far.getBaseAttack()).toBe(100);
        expect(far.getBaseArmor()).toBe(100);
        expect(enemy.getBaseAttack()).toBe(100);
        expect(near.hasBuffActive("Pegasus Might Blessing")).toBe(false);
    }
    source.applyEffect(new EffectFactory().makeEffect("Break")!);
    unitsHolder.refreshStackPowerForAllUnits();
    expect(near.getBaseAttack()).toBe(100);
    expect(near.getBaseArmor()).toBe(100);
    source.deleteEffect("Break");
    unitsHolder.refreshStackPowerForAllUnits();
    expect(near.getBaseAttack()).toBe(102);
    source.applyDamage(100000, 0, new SceneLogMock());
    expect(source.isDead()).toBe(true);
    unitsHolder.deleteUnitById(source.getId());
    unitsHolder.refreshStackPowerForAllUnits();
    expect(near.getBaseAttack()).toBe(100);
    expect(near.getBaseArmor()).toBe(100);
});
