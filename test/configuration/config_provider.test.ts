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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

import abilitiesJson from "../../src/configuration/abilities.json";
import auraEffectsJson from "../../src/configuration/aura_effects.json";
import creaturesJson from "../../src/configuration/creatures.json";
import effectsJson from "../../src/configuration/effects.json";
import spellsJson from "../../src/configuration/spells.json";
import { AbilityPowerType } from "../../src/abilities/ability_properties";
import {
    MAX_VERIFIED_FOOTPRINT_SIDE,
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
            const hero = getHeroConfig(PBTypes.TeamVals.RIGHT, factionName, `${factionName} Hero`, "hero_large_512");

            expect(hero.name).toBe(`${factionName} Hero`);
            expect(hero.team).toBe(PBTypes.TeamVals.RIGHT);
            expect(hero.unit_type).toBe(PBTypes.UnitVals.HERO);
            expect(hero.faction).not.toBe(PBTypes.FactionVals.NO_FACTION);
            expect(hero.attack_type).not.toBe(PBTypes.AttackVals.NO_ATTACK);
            expect(hero.movement_type).not.toBe(PBTypes.MovementVals.NO_MOVEMENT);
        }
    });

    /**
     * A creature's catalog KEY and its `name` field are the same string, and the config layer relies on it:
     * callers look a creature up by key and then read `name` back off the built properties.
     *
     * This is pinned because the invariant used to be patched around rather than held. A rename that landed
     * in the code before the data (Ash Moth -> Wandering Mage) left `getCreatureConfig` carrying
     * `creatureName === "Wandering Mage" ? creatureName : creatureConfig.name` — a branch that silently
     * preferred the key for exactly one creature. The data was fixed later and the branch outlived it as a
     * no-op, reading as though that creature were special when it was not.
     *
     * If this fails, the fix is the DATA: make the entry's `name` match its key. Do not reintroduce a
     * per-creature branch — a mismatch is a catalog bug and should say so here rather than be absorbed
     * silently at every call site.
     */
    it("names every creature exactly as its catalog key", () => {
        const mismatches: string[] = [];
        for (const [factionName, creatures] of objectEntries(creaturesJson)) {
            if (factionName === "version" || !isRecord(creatures)) {
                continue;
            }

            for (const [creatureName, creatureConfig] of Object.entries(creatures)) {
                if (!isRecord(creatureConfig)) {
                    continue;
                }
                if (creatureConfig.name !== creatureName) {
                    mismatches.push(`${factionName}/${creatureName}: name=${String(creatureConfig.name)}`);
                }
            }
        }
        expect(mismatches).toEqual([]);
    });

    it("builds creature configs for every creature catalog entry", () => {
        for (const [factionName, creatures] of objectEntries(creaturesJson)) {
            if (factionName === "version" || !isRecord(creatures)) {
                continue;
            }

            for (const creatureName of Object.keys(creatures)) {
                const creature = getCreatureConfig(
                    PBTypes.TeamVals.LEFT,
                    factionName,
                    creatureName,
                    `${creatureName.replace(/\s+/g, "_")}_512`,
                    2,
                );

                expect(creature.name.length).toBeGreaterThan(0);
                expect(creature.team).toBe(PBTypes.TeamVals.LEFT);
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

    it("gives Zena Handyman: her kit waives the ranged melee penalty (desc arrays aligned)", () => {
        const creature = getCreatureConfig(PBTypes.TeamVals.RIGHT, "Might", "Zena", "zena_512", 0, 141);

        expect(creature.hp).toBe(55);
        expect(creature.base_armor).toBe(17);

        const handymanIndex = creature.abilities.indexOf("Handyman");
        expect(handymanIndex).toBeGreaterThanOrEqual(0);
        expect(creature.abilities_descriptions[handymanIndex]).toContain("Melee damage is not reduced");
        // Ranged kit sanity: the penalty this ability waives only exists for RANGE attackers.
        expect(creature.attack_type).toBe(PBTypes.AttackVals.RANGE);

        const chakramIndex = creature.abilities.indexOf("Chakram");
        expect(chakramIndex).toBeGreaterThanOrEqual(0);
        expect(creature.abilities_descriptions[chakramIndex]).toContain("Maximum targets: 1.");
        expect(creature.abilities_descriptions[chakramIndex]).not.toContain("{}");
        expect(creature.abilities_descriptions[chakramIndex]).not.toContain("100 targets");
    });

    it("loads Hydra's reduced durability", () => {
        const creature = getCreatureConfig(PBTypes.TeamVals.RIGHT, "Chaos", "Hydra", "hydra_512", 0, 500);

        expect(creature.hp).toBe(185);
        expect(creature.base_armor).toBe(33);
    });

    it("loads Hyena's reduced attack", () => {
        const creature = getCreatureConfig(PBTypes.TeamVals.RIGHT, "Might", "Hyena", "hyena_512", 0, 40);

        expect(creature.base_attack).toBe(21);
    });

    it("loads Ogre Mage's improved damage range", () => {
        const creature = getCreatureConfig(PBTypes.TeamVals.RIGHT, "Might", "Ogre Mage", "ogre_mage_512", 1);

        expect(creature.attack_damage_min).toBe(16);
        expect(creature.attack_damage_max).toBe(20);
    });

    it("loads Tsar Cannon's improved ranged profile", () => {
        const creature = getCreatureConfig(PBTypes.TeamVals.RIGHT, "Life", "Tsar Cannon", "tsar_cannon_512", 0, 500);

        expect(creature.base_armor).toBe(32);
        expect(creature.base_attack).toBe(46);
        expect(creature.attack_damage_min).toBe(40);
        expect(creature.attack_damage_max).toBe(55);
        expect(creature.shot_distance).toBe(9.5);
    });

    it("loads Dryad's improved attack profile", () => {
        const creature = getCreatureConfig(PBTypes.TeamVals.RIGHT, "Nature", "Dryad", "dryad_512", 1);

        expect(creature.base_attack).toBe(11);
        expect(creature.attack_damage_min).toBe(3);
        expect(creature.attack_damage_max).toBe(6);
    });

    it("loads Beholder's improved ranged attack profile", () => {
        const creature = getCreatureConfig(PBTypes.TeamVals.RIGHT, "Chaos", "Beholder", "beholder_512", 1);

        expect(creature.base_attack).toBe(17);
        expect(creature.attack_damage_min).toBe(9);
        expect(creature.attack_damage_max).toBe(11);
    });

    it("loads Nightmare's improved durability and damage range", () => {
        const creature = getCreatureConfig(PBTypes.TeamVals.RIGHT, "Chaos", "Nightmare", "nightmare_512", 1);

        expect(creature.hp).toBe(65);
        expect(creature.base_armor).toBe(21);
        expect(creature.attack_damage_min).toBe(15);
        expect(creature.attack_damage_max).toBe(20);
    });

    it("loads the reduced caster initiatives without rounding away tenths", () => {
        const battleMage = getCreatureConfig(PBTypes.TeamVals.RIGHT, "Life", "Battle Mage", "battle_mage_512", 1);
        const magicDragon = getCreatureConfig(PBTypes.TeamVals.RIGHT, "Nature", "Magic Dragon", "magic_dragon_512", 1);

        expect(battleMage.initiative).toBe(2.1);
        expect(magicDragon.initiative).toBe(2.4);
    });

    it("derives creature amount from total experience when amount is not positive", () => {
        const creature = getCreatureConfig(PBTypes.TeamVals.RIGHT, "Might", "Berserker", "berserker_512", 0, 1);

        expect(creature.amount_alive).toBeGreaterThanOrEqual(1);
    });

    it("loads the one-unit Abomination balance and stack-powered Flesh Shield metadata", () => {
        const creature = getCreatureConfig(PBTypes.TeamVals.RIGHT, "Chaos", "Abomination", "abomination_512", 0, 1000);

        // The requested one-unit tank profile: a 1,000-XP stack is exactly one 550-HP creature.
        expect(creature.max_hp).toBe(550);
        expect(creature.steps).toBe(4.2);
        expect(creature.initiative).toBe(3.3);
        expect(creature.base_armor).toBe(49);
        expect(creature.base_attack).toBe(22);
        expect(creature.exp).toBe(1000);
        expect(creature.amount_alive).toBe(1);

        const fleshShieldIndex = creature.abilities.indexOf("Flesh Shield Aura");
        expect(fleshShieldIndex).toBeGreaterThanOrEqual(0);
        expect(creature.abilities_stack_powered[fleshShieldIndex]).toBe(true);
        expect(creature.abilities_descriptions[fleshShieldIndex]?.toLowerCase()).not.toContain("luck");
    });

    it("loads Frenzied Boar's reduced durability", () => {
        const creature = getCreatureConfig(PBTypes.TeamVals.RIGHT, "Might", "Frenzied Boar", "frenzied_boar_512", 1);

        expect(creature.max_hp).toBe(220);
        expect(creature.base_armor).toBe(40);
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

    it("makes Trent and Gargantuan Earth Elements", () => {
        const earthElement = getAbilityConfig("Earth Element");
        const trent = getCreatureConfig(PBTypes.TeamVals.RIGHT, "Nature", "Trent", "trent_512", 1);
        const gargantuan = getCreatureConfig(PBTypes.TeamVals.RIGHT, "Nature", "Gargantuan", "gargantuan_512", 1);

        expect(earthElement.power).toBe(50);
        expect(earthElement.power_type).toBe(AbilityPowerType.MAGIC_VULNERABILITY_WIND);
        expect(trent.abilities).toContain("Earth Element");
        expect(gargantuan.abilities).toContain("Earth Element");
    });

    it("loads Spit Ball's increased stack-powered chance", () => {
        const ability = getAbilityConfig("Spit Ball");

        expect(ability.power).toBe(40);
        expect(ability.stack_powered).toBe(true);
    });

    it("loads Hamstring's increased stack-powered chance", () => {
        const ability = getAbilityConfig("Hamstring");

        expect(ability.power).toBe(40);
        expect(ability.stack_powered).toBe(true);
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
        expect(() => getCreatureConfig(PBTypes.TeamVals.RIGHT, "Missing", "Berserker", "berserker_512", 1)).toThrow();
        expect(() => getCreatureConfig(PBTypes.TeamVals.RIGHT, "Might", "Missing", "missing_512", 1)).toThrow();
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

/**
 * The engine generalises to an arbitrary W x H, but the bound states what has been MEASURED. Whole matches
 * with 1x1, 2x2, 2x1, 1x2, 3x1, 1x3, 3x2, 2x3 and 3x3 stacks on the board produce zero engine-rejected
 * actions across all four boards; side 4 has simply never been clashed.
 *
 * A 3x1 used to measure dozens of declined melee strikes — an earlier version of this comment said so in
 * the present tense and was left behind when the bound moved from 2 to 3. The cause was never the side
 * length: it was a family of call sites reading `getCellForPosition(unit.getPosition())` as the body's
 * ANCHOR, which is only true while both sides are at most 2.
 *
 * The bound is enforced where a footprint is DECLARED, so an unsupported shape fails at configuration time
 * instead of becoming an AI that proposes refused moves all match.
 */
describe("footprint sides are bounded to what the engine is verified for", () => {
    const FOOTPRINT_OVERRIDE_ENV = "HOC_FOOTPRINT_OVERRIDES";

    const withOverrides = <T>(value: string, body: () => T): T => {
        const previous = process.env[FOOTPRINT_OVERRIDE_ENV];
        process.env[FOOTPRINT_OVERRIDE_ENV] = value;
        try {
            return body();
        } finally {
            if (previous === undefined) {
                delete process.env[FOOTPRINT_OVERRIDE_ENV];
            } else {
                process.env[FOOTPRINT_OVERRIDE_ENV] = previous;
            }
        }
    };

    const tiger = () => getCreatureConfig(PBTypes.TeamVals.LEFT, "Nature", "White Tiger", "white_tiger_512", 1);

    it("accepts the shapes the clash proves — every side up to the verified bound", () => {
        expect(MAX_VERIFIED_FOOTPRINT_SIDE).toBe(3);
        for (const [width, height] of [
            [1, 1],
            [2, 1],
            [1, 2],
            [2, 2],
            [3, 1],
            [1, 3],
            [3, 2],
            [2, 3],
            [3, 3],
        ] as const) {
            const properties = withOverrides(`White Tiger=${width}x${height}`, tiger);
            expect([properties.footprint_width, properties.footprint_height]).toEqual([width, height]);
        }
    });

    it("ignores a QA override the engine cannot honour rather than building a broken unit", () => {
        // One past the bound, whatever the bound currently is — the point of the test is that an
        // unverified shape is refused, not that any particular number is refused. Refusing it falls back
        // to the SHIPPED shape, which for White Tiger is its declared 2x1.
        const beyond = MAX_VERIFIED_FOOTPRINT_SIDE + 1;
        const properties = withOverrides(`White Tiger=${beyond}x1`, tiger);
        expect([properties.footprint_width, properties.footprint_height]).toEqual([2, 1]);
    });
});

/**
 * The mounted class ships 2x1 — two cells long, one tall (Point X3). This pin is the catalog's source of
 * truth for WHICH creatures are rectangular; the engine-side behavior is proven by the clash harness and
 * the footprint suites.
 *
 * If this test is failing because the declarations were removed from creatures.json to quiet the
 * size === max(width, height) validator: the correct fix is `size: 2` alongside the footprint (size is the
 * legacy ART tier and must read as the bigger square), NOT deleting the footprint. That deletion already
 * happened once (common 1696372) and silently turned the whole mounted class back into squares.
 */
describe("the mounted class ships 2x1", () => {
    const MOUNTED_2X1: ReadonlyArray<readonly [string, string]> = [
        ["Life", "Griffin"],
        ["Nature", "Wolf"],
        ["Nature", "White Tiger"],
        ["Nature", "Unicorn"],
        ["Nature", "Mantis"],
        ["Nature", "Pegasus"],
        ["Chaos", "Manticore"],
        ["Chaos", "Nightmare"],
        ["Might", "Centaur"],
        ["Might", "Wolf Rider"],
        ["Might", "Nomad"],
        ["Might", "Hyena"],
        ["Might", "Wyvern"],
    ];

    it("every mounted creature declares 2x1 with the size-2 art tier", () => {
        for (const [factionName, creatureName] of MOUNTED_2X1) {
            const properties = getCreatureConfig(
                PBTypes.TeamVals.LEFT,
                factionName,
                creatureName,
                `${creatureName.toLowerCase().replace(/ /g, "_")}_512`,
                1,
            );
            expect({
                creatureName,
                width: properties.footprint_width,
                height: properties.footprint_height,
                size: properties.size,
            }).toEqual({ creatureName, width: 2, height: 1, size: 2 });
        }
    });

    it("and no other creature declares a rectangle", () => {
        const declared = new Set(MOUNTED_2X1.map(([, creatureName]) => creatureName));
        const catalog = JSON.parse(
            readFileSync(join(import.meta.dir, "..", "..", "src", "configuration", "creatures.json"), "utf8"),
        ) as Record<string, Record<string, { footprint_width?: number; footprint_height?: number }>>;
        for (const creatures of Object.values(catalog)) {
            if (typeof creatures !== "object") continue;
            for (const [creatureName, config] of Object.entries(creatures)) {
                if (!config || typeof config !== "object") continue;
                if (config.footprint_width !== undefined || config.footprint_height !== undefined) {
                    expect({ creatureName, declared: declared.has(creatureName) }).toEqual({
                        creatureName,
                        declared: true,
                    });
                }
            }
        }
    });
});
