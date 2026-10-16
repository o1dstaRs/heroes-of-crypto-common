import { describe, expect, test } from "bun:test";

import { getAIStrategy, type IDecisionContext } from "../../src/ai";
import { AbilityFactory } from "../../src/abilities/ability_factory";
import { EffectFactory } from "../../src/effects/effect_factory";
import { prioritizeV08HealerSustain } from "../../src/ai/versions/v0_8_support_roles";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

function fixture(team = PBTypes.TeamVals.LEFT, damage = 1, melee = false) {
    const combat = createCombatTestContext();
    const healer = createTestUnit({
        team,
        name: "Healer",
        amountAlive: 40,
        stackPower: 5,
        attackType: PBTypes.AttackVals.MELEE_MAGIC,
        spells: ["Life:Heal", "Life:Mass Heal", "Life:Spiritual Armor", "Life:Blessing"],
    });
    const carry = createTestUnit({
        team,
        name: "Damage dealer",
        amountAlive: 20,
        damageMin: 5,
        damageMax: 15,
        attackType: melee ? PBTypes.AttackVals.MELEE : PBTypes.AttackVals.RANGE,
        rangeShots: 8,
    });
    const wounded = createTestUnit({
        team,
        name: "Abomination",
        amountAlive: 1,
        maxHp: 500,
        level: PBTypes.UnitLevelVals.FOURTH,
        damageMin: 5,
        damageMax: 5,
    });
    const enemy = createTestUnit({
        team: team === PBTypes.TeamVals.LEFT ? PBTypes.TeamVals.RIGHT : PBTypes.TeamVals.LEFT,
        name: "Enemy",
        amountAlive: 100,
        maxHp: 100,
        damageMin: 5,
        damageMax: 10,
    });
    placeUnit(combat.grid, combat.unitsHolder, healer, { x: 2, y: 3 });
    placeUnit(combat.grid, combat.unitsHolder, carry, { x: 4, y: 8 });
    placeUnit(combat.grid, combat.unitsHolder, wounded, { x: 2, y: 5 });
    placeUnit(combat.grid, combat.unitsHolder, enemy, { x: melee ? 5 : 12, y: 8 });
    wounded.applyDamage(damage, 0, new SceneLogMock());
    const context: IDecisionContext = {
        grid: combat.grid,
        matrix: combat.grid.getMatrix(),
        unitsHolder: combat.unitsHolder,
        pathHelper: new PathHelper(testGridSettings),
        attackHandler: combat.attackHandler,
        fightProperties: FightStateManager.getInstance().getFightProperties(),
    };
    const choose = () =>
        prioritizeV08HealerSustain(healer, context, [
            { type: "cast_spell", casterId: healer.getId(), spellName: "Heal", targetId: wounded.getId() },
        ]).find((action) => action.type === "cast_spell");
    return { ...combat, healer, carry, wounded, enemy, context, choose };
}

describe("Healer weighs Blessing against actual recoverable HP", () => {
    for (const team of [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT]) {
        for (const melee of [false, true]) {
            test(`team ${team}: blesses a productive ${melee ? "melee" : "ranged"} ally over a scratch`, () => {
                const f = fixture(team, 1, melee);
                expect(f.choose()).toMatchObject({ spellName: "Blessing", targetId: f.carry.getId() });
                expect(getAIStrategy("v0.8").decideTurn(f.healer, f.context)).toContainEqual(
                    expect.objectContaining({ spellName: "Blessing", targetId: f.carry.getId() }),
                );
            });
        }
        test(`team ${team}: preserves substantial emergency healing`, () => {
            const f = fixture(team, 400);
            expect(f.choose()).toMatchObject({ spellName: "Heal", targetId: f.wounded.getId() });
        });
        test(`team ${team}: two scratches do not justify Mass Heal over Blessing`, () => {
            const f = fixture(team);
            f.carry.applyDamage(1, 0, new SceneLogMock());
            expect(f.choose()).toMatchObject({ spellName: "Blessing", targetId: f.carry.getId() });
        });
    }
    test("a one-power caster cannot suggest Blessing", () => {
        const f = fixture();
        f.healer.setStackPower(1);
        expect(f.choose()?.spellName).not.toBe("Blessing");
    });
    test("exhausted Blessing cannot be suggested", () => {
        const f = fixture();
        f.healer.useSpell("Blessing");
        expect(f.choose()?.spellName).not.toBe("Blessing");
    });
    for (const scratches of [1, 2]) {
        test(`${scratches} scratches do not spend healing scrolls when Blessing is unavailable`, () => {
            const f = fixture();
            f.healer.useSpell("Blessing");
            if (scratches === 2) f.carry.applyDamage(1, 0, new SceneLogMock());
            expect(f.choose()?.spellName).toBe("Spiritual Armor");
        });
    }
    test("fixed-damage allies gain nothing from Blessing", () => {
        const f = fixture();
        f.carry.getUnitProperties().attack_damage_min = f.carry.getAttackDamageMax();
        f.healer.getUnitProperties().attack_damage_min = f.healer.getAttackDamageMax();
        expect(f.choose()?.spellName).not.toBe("Blessing");
    });
    test("does not bless a shooter with no ammunition or melee attack", () => {
        const f = fixture();
        f.carry.addAbility(new AbilityFactory(new EffectFactory()).makeAbility("No Melee"));
        while (f.carry.getRangeShots() > 0) f.carry.decreaseNumberOfShots();
        expect(f.choose()?.spellName).not.toBe("Blessing");
    });
    test("does not renew an active Blessing", () => {
        const f = fixture();
        f.carry.applyBuff(f.healer.getSpells().find((spell) => spell.getName() === "Blessing")!);
        expect(f.choose()?.spellName).not.toBe("Blessing");
    });
});
