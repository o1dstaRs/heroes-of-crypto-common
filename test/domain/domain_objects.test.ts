/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import { AbilityFactory } from "../../src/abilities/ability_factory";
import { EffectFactory } from "../../src/effects/effect_factory";
import { AuraEffect } from "../../src/effects/aura_effect";
import {
    AppliedAuraEffectProperties,
    AuraEffectProperties,
    EffectProperties,
} from "../../src/effects/effect_properties";
import { Effect } from "../../src/effects/effect";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { AppliedSpell } from "../../src/spells/applied_spell";
import { Spell } from "../../src/spells/spell";
import { getSpellConfig } from "../../src/configuration/config_provider";
import { AbilityPowerType } from "../../src/abilities/ability_properties";
import {
    getCreatureLevel,
    getCreaturesByLevel,
    getCreaturesOf,
    getFactionOf,
    getLevelOf,
    LevelBuckets,
} from "../../src/units/unit_properties";
import { SceneLogMock } from "../../src/scene/scene_log_mock";

describe("domain objects", () => {
    it("exposes ability data and returns defensive effect/property copies", () => {
        const effectFactory = new EffectFactory();
        const ability = new AbilityFactory(effectFactory).makeAbility("Stun");

        expect(ability.getName()).toBe("Stun");
        expect(ability.getDesc().length).toBeGreaterThan(0);
        expect(ability.getPower()).toBeGreaterThan(0);
        expect(ability.getType()).toBeGreaterThan(0);
        expect(ability.getPowerType()).toBeGreaterThan(0);
        expect(ability.getSkipResponse()).toBe(false);
        expect(ability.isStackPowered()).toBe(true);
        expect(ability.getEffectName()).toBe("Stun");
        expect(ability.getEffect()?.getName()).toBe("Stun");
        expect(ability.getProperties().name).toBe("Stun");
        expect(ability.getSpell()).toBeUndefined();
        expect(ability.getAuraEffect()).toBeUndefined();
        expect(ability.getAuraEffectName()).toBeUndefined();
    });

    it("builds ability spells and aura effects through factories", () => {
        const effectFactory = new EffectFactory();
        const resurrection = new AbilityFactory(effectFactory).makeAbility("Resurrection");
        const luckAura = new AbilityFactory(effectFactory).makeAbility("Luck Aura");

        expect(effectFactory.makeEffect(null)).toBeUndefined();
        expect(effectFactory.makeAuraEffect(null)).toBeUndefined();
        expect(effectFactory.makeEffect("Stun")?.getName()).toBe("Stun");
        expect(effectFactory.makeAuraEffect("Luck")?.getName()).toBe("Luck");
        expect(resurrection.getSpell()?.getName()).toBe("Resurrection");
        expect(luckAura.getAuraEffectName()).toBe("Luck");
        expect(luckAura.getAuraEffect()?.getName()).toBe("Luck");
        expect(effectFactory.makeEffect("Missing")).toBeUndefined();
        expect(effectFactory.makeAuraEffect("Missing")).toBeUndefined();
    });

    it("keeps the scene log mock inert while satisfying the scene-log contract", () => {
        const log = new SceneLogMock();

        expect(log.getLog()).toBe("");
        expect(log.hasBeenUpdated()).toBe(false);
        expect(log.updateLog("ignored")).toBeUndefined();
        expect(log.getLog()).toBe("");
        expect(log.hasBeenUpdated()).toBe(false);
    });

    it("updates finite effects while preserving infinite and total-lap effects", () => {
        const finite = new Effect(new EffectProperties("Finite", 2, "finite effect", 7));
        finite.extend();
        expect(finite.getLaps()).toBe(3);
        finite.minusLap();
        expect(finite.getLaps()).toBe(2);
        finite.setPower(9);
        expect(finite.getPower()).toBe(9);
        expect(finite.getName()).toBe("Finite");
        expect(finite.getDesc()).toBe("finite effect");
        expect(finite.getProperties().power).toBe(9);
        expect(finite.getDefaultProperties().power).toBe(7);

        const infinite = new Effect(new EffectProperties("Infinite", Number.MAX_SAFE_INTEGER, "forever", 1));
        infinite.extend();
        infinite.minusLap();
        expect(infinite.getLaps()).toBe(Number.MAX_SAFE_INTEGER);
    });

    it("updates aura effect power and range with lower bound", () => {
        const aura = new AuraEffect(
            new AuraEffectProperties("Aura", 1, "aura effect", 3, true, AbilityPowerType.ADDITIONAL_DAMAGE_PERCENTAGE),
        );

        expect(aura.getName()).toBe("Aura");
        expect(aura.getDesc()).toBe("aura effect");
        expect(aura.getRange()).toBe(1);
        expect(aura.getPower()).toBe(3);
        expect(aura.getPowerType()).toBe(AbilityPowerType.ADDITIONAL_DAMAGE_PERCENTAGE);
        expect(aura.getProperties().is_buff).toBe(true);

        aura.extendRange();
        expect(aura.getRange()).toBe(2);
        aura.narrowRange();
        aura.narrowRange();
        aura.narrowRange();
        aura.narrowRange();
        expect(aura.getRange()).toBe(-1);
        aura.setPower(6);
        expect(aura.getPower()).toBe(6);
        aura.toDefault();
        expect(aura.getRange()).toBe(1);
        expect(aura.getPower()).toBe(3);
    });

    it("stores applied aura source cells", () => {
        const props = new AuraEffectProperties("Aura", 2, "aura", 5, false, AbilityPowerType.DISABLE_RANGE_ATTACK);
        const applied = new AppliedAuraEffectProperties(props, { x: 4, y: 7 });

        expect(applied.getSourceCell()).toEqual({ x: 4, y: 7 });
        expect(applied.getSourceCellAsString()).toBe("4;7");
        expect(applied.getAuraEffectProperties()).toBe(props);
    });

    it("tracks spell amounts, mutable description and summon metadata", () => {
        const summon = new Spell({
            spellProperties: getSpellConfig("Nature", "Summon Wolves"),
            amount: 1,
        });

        expect(summon.getFaction()).toBe(PBTypes.FactionVals.NATURE);
        expect(summon.getName()).toBe("Summon Wolves");
        expect(summon.getLevel()).toBeGreaterThan(0);
        expect(summon.getDesc().length).toBeGreaterThan(0);
        expect(summon.getSpellTargetType()).toBeGreaterThan(0);
        expect(summon.getPower()).toBeGreaterThan(0);
        expect(summon.getPowerType()).toBeGreaterThan(0);
        expect(summon.getMultiplierType()).toBeGreaterThan(0);
        expect(summon.getLapsTotal()).toBeGreaterThan(0);
        expect(typeof summon.isBuff()).toBe("boolean");
        expect(typeof summon.isSelfCastAllowed()).toBe("boolean");
        expect(typeof summon.isSelfDebuffApplicable()).toBe("boolean");
        expect(summon.getMinimalCasterStackPower()).toBeGreaterThanOrEqual(0);
        expect(Array.isArray(summon.getConflictsWith())).toBe(true);
        expect(typeof summon.isGiftable()).toBe("boolean");
        expect(summon.getMaximumGiftLevel()).toBeGreaterThanOrEqual(0);
        expect(summon.isSummon()).toBe(true);
        expect(summon.getSummonUnitRace()).toBe(PBTypes.FactionVals.NATURE);
        expect(summon.getSummonUnitName()).toBe("Wolf");
        expect(summon.getSpellProperties().name).toBe("Summon Wolves");

        summon.setPower(12);
        summon.setDesc(["updated"]);
        summon.increaseAmount();
        expect(summon.getPower()).toBe(12);
        expect(summon.getDesc()).toEqual(["updated"]);
        expect(summon.getAmount()).toBe(2);
        summon.decreaseAmount();
        summon.decreaseAmount();
        summon.decreaseAmount();
        expect(summon.getAmount()).toBe(0);
        expect(summon.isRemaining()).toBe(false);
    });

    it("tracks applied spell laps and optional properties", () => {
        const applied = new AppliedSpell("Applied", 8, 2, 11, 12);

        expect(applied.getName()).toBe("Applied");
        expect(applied.getPower()).toBe(8);
        expect(applied.getFirstSpellProperty()).toBe(11);
        expect(applied.getSecondSpellProperty()).toBe(12);
        applied.minusLap();
        expect(applied.getLaps()).toBe(1);
        applied.minusLap();
        applied.minusLap();
        expect(applied.getLaps()).toBe(0);

        const infinite = new AppliedSpell("Infinite", 1, Number.MAX_SAFE_INTEGER);
        infinite.minusLap();
        expect(infinite.getLaps()).toBe(Number.MAX_SAFE_INTEGER);
    });

    it("exposes generated creature lookup helpers with safe fallbacks", () => {
        const firstLevelCreature = getCreaturesByLevel(PBTypes.UnitLevelVals.FIRST)[0];
        const missingCreature = 999999 as Parameters<typeof getCreatureLevel>[0];
        const missingFaction = 999999 as Parameters<typeof getCreaturesOf>[0];
        const faction = getFactionOf(firstLevelCreature);

        expect(getCreatureLevel(firstLevelCreature)).toBe(PBTypes.UnitLevelVals.FIRST);
        expect(getLevelOf(firstLevelCreature)).toBe(PBTypes.UnitLevelVals.FIRST);
        expect(getCreatureLevel(missingCreature)).toBe(PBTypes.UnitLevelVals.NO_LEVEL);
        expect(getLevelOf(missingCreature)).toBe(PBTypes.UnitLevelVals.NO_LEVEL);
        expect(getFactionOf(missingCreature)).toBe(PBTypes.FactionVals.MIGHT);

        expect(getCreaturesOf(faction)).toContain(firstLevelCreature);
        expect(getCreaturesOf(faction, PBTypes.UnitLevelVals.FIRST)).toContain(firstLevelCreature);
        expect(getCreaturesOf(missingFaction)).toEqual([]);
        expect(LevelBuckets).toHaveLength(4);
        expect(LevelBuckets[3]).toMatchObject({ label: "Level 4", unitSize: 2 });
    });
});
