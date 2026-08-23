/*
 * Magic Mirror / Mass Magic Mirror return every direct magical hit, not only cast-spell damage.
 *
 * These tests exercise the four ability-side magic paths independently of the primary physical attack that
 * triggered them. Persistent Fire Wall terrain is intentionally outside this contract: after placement it
 * has no attacking unit to return damage to.
 */
import { describe, expect, it } from "bun:test";

import { processChainLightningAbility } from "../../src/abilities/chain_lightning_ability";
import { processFireBreathAbility } from "../../src/abilities/fire_breath_ability";
import { processFireShieldAbility } from "../../src/abilities/fire_shield_ability";
import { processFireforgedSwordAbility } from "../../src/abilities/fireforged_sword_ability";
import { getSpellConfig } from "../../src/configuration/config_provider";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { ISecondaryDamage } from "../../src/scene/animations";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Spell } from "../../src/spells/spell";
import type { Unit } from "../../src/units/unit";
import { createCombatTestContext, createTestUnit, DamageStatisticHolder, placeUnit } from "../helpers/combat";

const applyMirror = (unit: Unit, power = 100, name: "Magic Mirror" | "Mass Magic Mirror" = "Magic Mirror") => {
    const mirror = new Spell({ spellProperties: getSpellConfig("Chaos", name), amount: 1 });
    mirror.setPower(power);
    unit.applyBuff(mirror);
};

const reflected = (secondary: ISecondaryDamage[]) => secondary.filter(({ source }) => source === "magic_mirror");

describe("Magic Mirror returns all direct magical ability damage", () => {
    it("returns a lone Chain Lightning arc and applies the attacker's own magic resistance", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const attacker = createTestUnit({
            name: "Storm Caster",
            team: PBTypes.TeamVals.LOWER,
            abilities: ["Chain Lightning"],
            amountAlive: 1,
            maxHp: 100,
            magicResist: 50,
            stackPower: 5,
        });
        const target = createTestUnit({
            name: "Mirrored Target",
            team: PBTypes.TeamVals.UPPER,
            amountAlive: 1,
            maxHp: 100,
        });
        applyMirror(target);
        placeUnit(grid, unitsHolder, attacker, { x: 2, y: 2 });
        placeUnit(grid, unitsHolder, target, { x: 6, y: 6 });
        const attackerHpBefore = attacker.getHp();
        const secondary: ISecondaryDamage[] = [];

        processChainLightningAbility(
            attacker,
            target,
            20,
            grid,
            unitsHolder,
            new SceneLogMock(),
            new DamageStatisticHolder(),
            secondary,
        );

        // 20 * the full-stack 80% Chain Lightning power = 16; a 100% mirror returns it, then the caster's
        // own 50% magic resistance cuts the rebound to 8. This also covers the old primary-only early return.
        expect(attackerHpBefore - attacker.getHp()).toBe(8);
        expect(reflected(secondary)).toEqual([
            expect.objectContaining({ unitId: attacker.getId(), amount: 8, rebounded: true }),
        ]);
    });

    it("returns Fire Breath damage to a non-fire attacker", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const attacker = createTestUnit({
            name: "Breath Thief",
            team: PBTypes.TeamVals.LOWER,
            abilities: ["Fire Breath"],
            amountAlive: 1,
            maxHp: 200,
            attack: 20,
            damageMin: 20,
            damageMax: 20,
            stackPower: 5,
        });
        const primary = createTestUnit({ name: "Primary", team: PBTypes.TeamVals.UPPER, maxHp: 200 });
        const mirrored = createTestUnit({ name: "Behind", team: PBTypes.TeamVals.UPPER, maxHp: 200 });
        applyMirror(mirrored);
        placeUnit(grid, unitsHolder, attacker, { x: 5, y: 7 });
        placeUnit(grid, unitsHolder, primary, { x: 5, y: 5 });
        placeUnit(grid, unitsHolder, mirrored, { x: 5, y: 3 });
        const attackerHpBefore = attacker.getHp();
        const secondary: ISecondaryDamage[] = [];

        processFireBreathAbility(
            attacker,
            primary,
            new SceneLogMock(),
            unitsHolder,
            grid,
            "burned",
            new DamageStatisticHolder(),
            undefined,
            secondary,
        );

        const breath = secondary.find(({ source, unitId }) => source === "fire_breath" && unitId === mirrored.getId());
        const breathDamage = breath?.amount ?? 0;
        expect(breathDamage).toBeGreaterThan(0);
        expect(attackerHpBefore - attacker.getHp()).toBe(breathDamage);
        expect(reflected(secondary)).toEqual([
            expect.objectContaining({ unitId: attacker.getId(), amount: breathDamage, rebounded: true }),
        ]);
    });

    it("returns Fire Shield damage to the shield owner", () => {
        const { unitsHolder } = createCombatTestContext();
        const shieldOwner = createTestUnit({
            name: "Shield Owner",
            team: PBTypes.TeamVals.UPPER,
            abilities: ["Fire Shield"],
            amountAlive: 1,
            maxHp: 200,
            stackPower: 5,
        });
        const mirroredAttacker = createTestUnit({
            name: "Mirrored Attacker",
            team: PBTypes.TeamVals.LOWER,
            amountAlive: 1,
            maxHp: 200,
        });
        applyMirror(mirroredAttacker);
        const ownerHpBefore = shieldOwner.getHp();
        const secondary: ISecondaryDamage[] = [];

        processFireShieldAbility(
            shieldOwner,
            mirroredAttacker,
            new SceneLogMock(),
            100,
            unitsHolder,
            new DamageStatisticHolder(),
            secondary,
        );

        const shield = secondary.find(({ source }) => source === "fire_shield");
        const shieldDamage = shield?.amount ?? 0;
        expect(shieldDamage).toBeGreaterThan(0);
        expect(ownerHpBefore - shieldOwner.getHp()).toBe(shieldDamage);
        expect(reflected(secondary)).toEqual([
            expect.objectContaining({ unitId: shieldOwner.getId(), amount: shieldDamage, rebounded: true }),
        ]);
    });

    it("returns the Fireforged Sword's magical rider without reflecting the physical swing", () => {
        const attacker = createTestUnit({
            name: "Swordsman",
            team: PBTypes.TeamVals.LOWER,
            amountAlive: 1,
            maxHp: 200,
        });
        const target = createTestUnit({
            name: "Mirrored Target",
            team: PBTypes.TeamVals.UPPER,
            amountAlive: 1,
            maxHp: 200,
        });
        attacker.applyBuff(new Spell({ spellProperties: getSpellConfig("Chaos", "Fireforged Sword"), amount: 1 }));
        applyMirror(target);
        const attackerHpBefore = attacker.getHp();
        const secondary: ISecondaryDamage[] = [];

        processFireforgedSwordAbility(
            attacker,
            target,
            100,
            new SceneLogMock(),
            new DamageStatisticHolder(),
            secondary,
        );

        // The configured sword burns for 10% of the 100 physical damage. Only that 10-point magic rider is
        // reflected; the physical 100-point swing itself is outside Magic Mirror's contract.
        expect(attackerHpBefore - attacker.getHp()).toBe(10);
        expect(reflected(secondary)).toEqual([
            expect.objectContaining({ unitId: attacker.getId(), amount: 10, rebounded: true }),
        ]);
    });
});
