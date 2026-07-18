/*
 * -----------------------------------------------------------------------------
 * Break-on-attack (Broken Aegis artifact / Chaos BREAK_ON_ATTACK synergy) is NOT magic. It must land on
 * magic-IMMUNE targets too — notably the Black Dragon, whose "Enchanted Skin" ability grants 100% magic
 * resistance ("protection against any magic, including buffs and debuffs"). Enchanted Skin governs SPELL
 * effects (attack_handler gates those on getMagicResist), but break-on-attack flows through
 * Unit.applyDamage -> Unit.applyEffect, which deliberately does NOT consult magic resist. These tests pin
 * that: a reviewer who "tidies up" applyEffect to respect magic resist would silently break this and make
 * Black Dragon (and every Enchanted Skin / Magic Shield unit) immune to Break, which is wrong.
 * -----------------------------------------------------------------------------
 */
import { describe, expect, it } from "bun:test";

import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { createTestUnit } from "../helpers/combat";

const makeBlackDragon = () =>
    createTestUnit({
        name: "Black Dragon",
        team: PBTypes.TeamVals.UPPER,
        maxHp: 1000,
        amountAlive: 5,
        abilities: ["Fire Element", "Enchanted Skin", "Fire Breath"],
    });

describe("Break-on-attack ignores magic immunity (Black Dragon / Enchanted Skin)", () => {
    it("Enchanted Skin yields 100% magic resist yet Break still applies at 100% break chance", () => {
        const log = new SceneLogMock();
        const bd = makeBlackDragon();
        // adjustBaseStats(hasFightStarted, lap, synAbilityPower, synMovementSteps, synFlyArmor, synMorale,
        // synLuck, stepsMoraleMult) — the pass that activates Enchanted Skin's magic_resist_mod = 100.
        bd.adjustBaseStats(true, 1, 0, 0, 0, 0, 0, 0);
        expect(bd.getMagicResist()).toBe(100);
        expect(bd.hasAbilityActive("Enchanted Skin")).toBe(true);

        bd.applyDamage(10, 100, log, false);
        expect(bd.hasEffectActive("Break")).toBe(true);
    });

    it("Break mutes the magic-immune unit's abilities (hasAbilityActive returns false under Break)", () => {
        const log = new SceneLogMock();
        const bd = makeBlackDragon();
        bd.adjustBaseStats(true, 1, 0, 0, 0, 0, 0, 0);
        expect(bd.hasAbilityActive("Fire Breath")).toBe(true);

        bd.applyDamage(10, 100, log, false);
        expect(bd.hasEffectActive("Break")).toBe(true);
        // All abilities are disabled for the Break duration — Fire Breath, Enchanted Skin, Fire Element.
        expect(bd.hasAbilityActive("Fire Breath")).toBe(false);
        expect(bd.hasAbilityActive("Enchanted Skin")).toBe(false);
        expect(bd.hasAbilityActive("Fire Element")).toBe(false);
    });

    it("Break survives a stats refresh (adjustBaseStats does not drop the effect)", () => {
        const log = new SceneLogMock();
        const bd = makeBlackDragon();
        bd.adjustBaseStats(true, 1, 0, 0, 0, 0, 0, 0);
        bd.applyDamage(10, 100, log, false);
        expect(bd.hasEffectActive("Break")).toBe(true);

        bd.adjustBaseStats(true, 1, 0, 0, 0, 0, 0, 0);
        expect(bd.hasEffectActive("Break")).toBe(true);
    });

    it("does NOT apply Break when the attacker's team break chance is 0 (no artifact/synergy)", () => {
        const log = new SceneLogMock();
        const bd = makeBlackDragon();
        bd.adjustBaseStats(true, 1, 0, 0, 0, 0, 0, 0);
        bd.applyDamage(10, 0, log, false);
        expect(bd.hasEffectActive("Break")).toBe(false);
    });

    it("applies Break identically to a plain (non-magic-immune) unit — behavior is target-agnostic", () => {
        const log = new SceneLogMock();
        const orc = createTestUnit({ name: "Orc", team: PBTypes.TeamVals.UPPER, maxHp: 1000, amountAlive: 5 });
        orc.applyDamage(10, 100, log, false);
        expect(orc.hasEffectActive("Break")).toBe(true);
    });
});
