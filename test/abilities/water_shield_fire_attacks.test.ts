/*
 * Fire Breath, Fire Shield and a Fireforged Sword burn are fire attacks. A Water Shield lets them
 * through and stays up, even when the unit dealing them is not itself a Fire Element.
 *
 * The weapon hit under a Fireforged Sword is not fire: it still breaks the shield. The burn is priced
 * from that swing and still lands.
 */
import { afterEach, describe, expect, it } from "bun:test";

import { processFireBreathAbility } from "../../src/abilities/fire_breath_ability";
import { processFireShieldAbility } from "../../src/abilities/fire_shield_ability";
import { processFireforgedSwordAbility } from "../../src/abilities/fireforged_sword_ability";
import { getSpellConfig } from "../../src/configuration/config_provider";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Spell } from "../../src/spells/spell";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import {
    createCombatTestContext,
    createTestUnit,
    createVisibleDamage,
    DamageStatisticHolder,
    placeUnit,
    testGridSettings,
} from "../helpers/combat";

const shield = (name = "Mermaid", team = PBTypes.TeamVals.RIGHT, maxHp = 200) => {
    const unit = createTestUnit({
        name,
        team,
        abilities: ["Water Shield"],
        amountAlive: 1,
        maxHp,
        armor: 0,
        luck: 0,
    });
    unit.trySeedWaterShield();
    expect(unit.hasBuffActive("Water Shield")).toBe(true);
    return unit;
};

describe("fire attacks pass through a Water Shield", () => {
    afterEach(() => {
        setDeterministicRandomSource(undefined);
    });

    it("lets Fire Breath through from a breather who is not a Fire Element", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const attacker = createTestUnit({
            name: "Breath Thief",
            team: PBTypes.TeamVals.LEFT,
            abilities: ["Fire Breath"],
            amountAlive: 1,
            maxHp: 200,
            attack: 20,
            damageMin: 20,
            damageMax: 20,
            stackPower: 5,
            luck: 0,
        });
        const primary = createTestUnit({
            name: "Primary",
            team: PBTypes.TeamVals.RIGHT,
            amountAlive: 1,
            maxHp: 200,
        });
        const behind = shield("Behind", PBTypes.TeamVals.RIGHT, 5000);
        placeUnit(grid, unitsHolder, attacker, { x: 5, y: 7 });
        placeUnit(grid, unitsHolder, primary, { x: 5, y: 5 });
        placeUnit(grid, unitsHolder, behind, { x: 5, y: 3 });
        const hpBefore = behind.getCumulativeHp();

        processFireBreathAbility(
            attacker,
            primary,
            new SceneLogMock(),
            unitsHolder,
            grid,
            "attk",
            new DamageStatisticHolder(),
        );

        expect(hpBefore - behind.getCumulativeHp()).toBeGreaterThan(0);
        expect(behind.hasBuffActive("Water Shield")).toBe(true);
    });

    it("lets Fire Shield through onto a striker who is not facing a Fire Element", () => {
        const owner = createTestUnit({
            name: "Shield Thief",
            team: PBTypes.TeamVals.RIGHT,
            abilities: ["Fire Shield"],
            amountAlive: 1,
            maxHp: 200,
            stackPower: 5,
            luck: 0,
        });
        const striker = shield("Striker", PBTypes.TeamVals.LEFT);
        const hpBefore = striker.getHp();

        processFireShieldAbility(
            owner,
            striker,
            new SceneLogMock(),
            100,
            createCombatTestContext().unitsHolder,
            new DamageStatisticHolder(),
        );

        expect(hpBefore - striker.getHp()).toBeGreaterThan(0);
        expect(striker.hasBuffActive("Water Shield")).toBe(true);
    });

    it("lets a Fireforged burn through and leaves the shield for the weapon hit", () => {
        const attacker = createTestUnit({
            name: "Swordsman",
            team: PBTypes.TeamVals.LEFT,
            amountAlive: 1,
            maxHp: 200,
        });
        attacker.applyBuff(new Spell({ spellProperties: getSpellConfig("Chaos", "Fireforged Sword"), amount: 1 }));
        const target = shield();
        const hpBefore = target.getHp();

        processFireforgedSwordAbility(attacker, target, 100, new SceneLogMock(), new DamageStatisticHolder());

        expect(hpBefore - target.getHp()).toBeGreaterThan(0);
        expect(target.hasBuffActive("Water Shield")).toBe(true);
    });

    it("still breaks the shield on the steel, then lands the Fireforged burn", () => {
        setDeterministicRandomSource(() => 0);
        const { grid, unitsHolder, attackHandler } = createCombatTestContext();
        const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
        const attacker = createTestUnit({
            name: "Swordsman",
            team: PBTypes.TeamVals.LEFT,
            attackType: PBTypes.AttackVals.MELEE,
            amountAlive: 1,
            maxHp: 500,
            damageMin: 20,
            damageMax: 20,
            luck: 0,
        });
        attacker.applyBuff(new Spell({ spellProperties: getSpellConfig("Chaos", "Fireforged Sword"), amount: 1 }));
        const target = createTestUnit({
            name: "Mermaid",
            team: PBTypes.TeamVals.RIGHT,
            attackType: PBTypes.AttackVals.MELEE,
            abilities: ["Water Shield"],
            amountAlive: 1,
            maxHp: 200,
            armor: 0,
            damageMin: 0,
            damageMax: 0,
            luck: 0,
        });
        target.trySeedWaterShield();
        placeUnit(grid, unitsHolder, attacker, { x: 4, y: 3 });
        placeUnit(grid, unitsHolder, target, { x: 5, y: 3 });
        const hpBefore = target.getHp();
        const damage = createVisibleDamage(target);

        const result = attackHandler.handleMeleeAttack(unitsHolder, moveHandler, damage, undefined, attacker, target, {
            x: 4,
            y: 3,
        });

        const burns = (damage.secondary ?? []).filter((entry) => entry.source === "fireforged_sword");
        expect(result.completed).toBe(true);
        expect(burns).toHaveLength(1);
        expect(burns[0].amount).toBeGreaterThan(0);
        // The steel was absorbed. The only health lost is the fire.
        expect(hpBefore - target.getHp()).toBe(burns[0].amount);
        expect(target.hasBuffActive("Water Shield")).toBe(false);
    });
});
