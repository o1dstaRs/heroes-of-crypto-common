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

import abilitiesJson from "../../src/configuration/abilities.json";
import auraEffectsJson from "../../src/configuration/aura_effects.json";
import creaturesJson from "../../src/configuration/creatures.json";
import effectsJson from "../../src/configuration/effects.json";
import spellsJson from "../../src/configuration/spells.json";
import {
    getAbilityConfig,
    getAuraEffectConfig,
    getCreatureConfig,
    getEffectConfig,
    getHeroConfig,
    getSpellConfig,
} from "../../src/configuration/config_provider";
import { PBTypes } from "../../src/generated/protobuf/v1/types";

describe("config_provider", () => {
    it("builds hero configs for every supported faction", () => {
        for (const factionName of ["Might", "Chaos", "Nature", "Life", "Death", "Order"]) {
            const hero = getHeroConfig(PBTypes.TeamVals.UPPER, factionName, `${factionName} Hero`, "hero_large_512");

            expect(hero.name).toBe(`${factionName} Hero`);
            expect(hero.team).toBe(PBTypes.TeamVals.UPPER);
            expect(hero.unit_type).toBe(PBTypes.UnitVals.HERO);
            expect(hero.faction).not.toBe(PBTypes.FactionVals.NO_FACTION);
            expect(hero.attack_type).not.toBe(PBTypes.AttackVals.NO_ATTACK);
            expect(hero.movement_type).not.toBe(PBTypes.MovementVals.NO_MOVEMENT);
        }
    });

    it("builds creature configs for every creature catalog entry", () => {
        for (const [factionName, creatures] of objectEntries(creaturesJson)) {
            if (factionName === "version" || !isRecord(creatures)) {
                continue;
            }

            for (const creatureName of Object.keys(creatures)) {
                const creature = getCreatureConfig(
                    PBTypes.TeamVals.LOWER,
                    factionName,
                    creatureName,
                    `${creatureName.replace(/\s+/g, "_")}_512`,
                    2,
                );

                expect(creature.name.length).toBeGreaterThan(0);
                expect(creature.team).toBe(PBTypes.TeamVals.LOWER);
                expect(creature.unit_type).toBe(PBTypes.UnitVals.CREATURE);
                expect(creature.amount_alive).toBe(2);
                expect(creature.abilities_descriptions.length).toBe(creature.abilities.length);
                expect(creature.abilities_stack_powered.length).toBe(creature.abilities.length);
                expect(creature.abilities_auras.length).toBe(creature.abilities.length);
                expect(creature.aura_ranges.length).toBe(creature.abilities.length);
                expect(creature.aura_is_buff.length).toBe(creature.abilities.length);
            }
        }
    });

    it("derives creature amount from total experience when amount is not positive", () => {
        const creature = getCreatureConfig(PBTypes.TeamVals.UPPER, "Might", "Berserker", "berserker_512", 0, 1);

        expect(creature.amount_alive).toBeGreaterThanOrEqual(1);
    });

    it("loads the one-unit Abomination balance and stack-powered Flesh Shield metadata", () => {
        const creature = getCreatureConfig(PBTypes.TeamVals.UPPER, "Chaos", "Abomination", "abomination_512", 0, 1000);

        expect(creature.max_hp).toBe(500);
        expect(creature.steps).toBe(4.2);
        expect(creature.speed).toBe(3.3);
        expect(creature.base_armor).toBe(44);
        expect(creature.base_attack).toBe(20);
        expect(creature.exp).toBe(1000);
        expect(creature.amount_alive).toBe(1);

        const fleshShieldIndex = creature.abilities.indexOf("Flesh Shield Aura");
        expect(fleshShieldIndex).toBeGreaterThanOrEqual(0);
        expect(creature.abilities_stack_powered[fleshShieldIndex]).toBe(true);
        expect(creature.abilities_descriptions[fleshShieldIndex]?.toLowerCase()).not.toContain("luck");
    });

    it("loads every ability config", () => {
        for (const abilityName of catalogKeys(abilitiesJson)) {
            const ability = getAbilityConfig(abilityName);

            expect(ability.name).toBe(abilityName);
            expect(ability.desc.length).toBeGreaterThan(0);
            expect(ability.type).not.toBe(0);
            expect(ability.power_type).not.toBe(0);
            expect(typeof ability.skip_response).toBe("boolean");
            expect(typeof ability.stack_powered).toBe("boolean");
            expect(typeof ability.can_be_cast).toBe("boolean");
        }
    });

    it("loads every spell config", () => {
        for (const [factionName, spells] of objectEntries(spellsJson)) {
            if (factionName === "version" || !isRecord(spells)) {
                continue;
            }

            for (const spellName of Object.keys(spells)) {
                const spell = getSpellConfig(factionName, spellName, 3);

                expect(spell.name).toBe(spellName);
                expect(spell.desc.length).toBeGreaterThan(0);
                expect(spell.laps).toBe(3);
                expect(spell.spell_target_type).not.toBe(0);
                expect(spell.power_type).not.toBe(0);
                expect(spell.multiplier_type).not.toBe(0);
            }
        }
    });

    it("loads every effect and aura effect config", () => {
        for (const effectName of catalogKeys(effectsJson)) {
            const effect = getEffectConfig(effectName);

            expect(effect?.name).toBe(effectName);
            expect(effect?.desc.length).toBeGreaterThan(0);
        }

        for (const auraEffectName of catalogKeys(auraEffectsJson)) {
            const auraEffect = getAuraEffectConfig(auraEffectName);

            expect(auraEffect?.name).toBe(auraEffectName);
            expect(auraEffect?.desc.length).toBeGreaterThan(0);
            expect(auraEffect?.power_type).not.toBe(0);
        }
    });

    it("throws for unknown required config names", () => {
        expect(() => getAbilityConfig("Missing Ability")).toThrow();
        expect(() => getCreatureConfig(PBTypes.TeamVals.UPPER, "Missing", "Berserker", "berserker_512", 1)).toThrow();
        expect(() => getCreatureConfig(PBTypes.TeamVals.UPPER, "Might", "Missing", "missing_512", 1)).toThrow();
        expect(() => getSpellConfig("Might", "Missing")).toThrow();
        expect(getEffectConfig("Missing Effect")).toBeUndefined();
        expect(getAuraEffectConfig("Missing Aura")).toBeUndefined();
    });
});

function catalogKeys(catalog: unknown): string[] {
    if (!isRecord(catalog)) {
        return [];
    }

    return Object.keys(catalog).filter((key) => key !== "version");
}

function objectEntries(value: unknown): [string, unknown][] {
    if (!isRecord(value)) {
        return [];
    }

    return Object.entries(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}
