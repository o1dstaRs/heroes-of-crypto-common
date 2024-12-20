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

import abilitiesJson from "./abilities.json";
import auraEffectsJson from "./aura_effects.json";
import effectsJson from "./effects.json";
import spellsJson from "./spells.json";
import creaturesJson from "./creatures.json";

import { AuraEffectProperties, EffectProperties } from "../effects/effect_properties";
import { AbilityProperties, ToAbilityPowerType, ToAbilityType } from "../abilities/ability_properties";
import {
    SpellMultiplierType,
    SpellPowerType,
    SpellProperties,
    SpellTargetType,
    ToSpellMultiplierType,
    ToSpellPowerType,
    ToSpellTargetType,
} from "../spells/spell_properties";
import { FactionType } from "../factions/faction_type";
import {
    AttackType,
    MovementType,
    TeamType,
    ToAttackType,
    ToMovementType,
    UnitProperties,
    UnitType,
} from "../units/unit_properties";
import { MAX_UNIT_STACK_POWER, MIN_UNIT_STACK_POWER } from "../constants";

const DEFAULT_HERO_CONFIG = {
    hp: 120,
    steps: 3,
    speed: 2,
    armor: 12,
    attack_type: "MELEE",
    attack: 12,
    attack_damage_min: 15,
    attack_damage_max: 25,
    attack_range: 1,
    range_shots: 10,
    shot_distance: 5,
    magic_resists: 5,
    movement_type: "WALK",
    exp: 0,
    size: 1,
    level: 1,
    spells: [],
    abilities: [],
    abilities_descriptions: [],
    abilities_stack_powered: [],
    applied_effects: [],
    applied_buffs: [],
    applied_debuffs: [],
    applied_effects_laps: [],
    applied_buffs_laps: [],
    applied_debuffs_laps: [],
    applied_effects_descriptions: [],
    applied_buffs_descriptions: [],
    applied_debuffs_descriptions: [],
    applied_effects_powers: [],
    applied_buffs_powers: [],
    applied_debuffs_powers: [],
    abilities_auras: [],
    aura_effects: [],
    aura_ranges: [],
    aura_is_buff: [],
    synergies: [],
};

const DEFAULT_LUCK_PER_FACTION = {
    [FactionType.NO_TYPE]: 0,
    [FactionType.MIGHT]: 1,
    [FactionType.CHAOS]: -1,
    [FactionType.NATURE]: 4,
    [FactionType.LIFE]: 1,
    [FactionType.DEATH]: -2,
    [FactionType.ORDER]: 3,
};

const DEFAULT_MORALE_PER_FACTION = {
    [FactionType.NO_TYPE]: 0,
    [FactionType.MIGHT]: 2,
    [FactionType.CHAOS]: -1,
    [FactionType.NATURE]: 1,
    [FactionType.LIFE]: 4,
    [FactionType.DEATH]: -4,
    [FactionType.ORDER]: 3,
};

export const getHeroConfig = (
    team: TeamType,
    faction: FactionType,
    heroName: string,
    largeTextureName: string,
): UnitProperties => {
    const heroConfig = {
        ...DEFAULT_HERO_CONFIG,
        faction,
    };

    const luck = DEFAULT_LUCK_PER_FACTION[faction] ?? 0;
    const morale = DEFAULT_MORALE_PER_FACTION[faction] ?? 0;

    const attackType =
        heroConfig.attack_type && heroConfig.attack_type.constructor === String
            ? ToAttackType[heroConfig.attack_type as string]
            : undefined;
    if (attackType === undefined || attackType === AttackType.NO_TYPE) {
        throw new TypeError(`Invalid attack type for hero ${heroName} = ${attackType}`);
    }

    const movementType =
        heroConfig.movement_type && heroConfig.movement_type.constructor === String
            ? ToMovementType[heroConfig.movement_type as string]
            : undefined;
    if (movementType === undefined || movementType === MovementType.NO_TYPE) {
        throw new TypeError(`Invalid movement type for hero ${heroName} = ${movementType}`);
    }

    return new UnitProperties(
        faction,
        heroName,
        heroConfig.hp,
        heroConfig.steps,
        morale,
        luck,
        heroConfig.speed,
        heroConfig.armor,
        attackType,
        heroConfig.attack,
        heroConfig.attack_damage_min,
        heroConfig.attack_damage_max,
        heroConfig.attack_range,
        heroConfig.range_shots,
        heroConfig.shot_distance,
        heroConfig.magic_resists,
        movementType,
        heroConfig.exp,
        heroConfig.size,
        heroConfig.level,
        structuredClone(heroConfig.spells),
        heroConfig.abilities,
        heroConfig.abilities_descriptions,
        heroConfig.abilities_stack_powered,
        heroConfig.abilities_auras,
        heroConfig.applied_effects,
        heroConfig.applied_buffs,
        heroConfig.applied_debuffs,
        heroConfig.applied_effects_laps,
        heroConfig.applied_buffs_laps,
        heroConfig.applied_debuffs_laps,
        heroConfig.applied_effects_descriptions,
        heroConfig.applied_buffs_descriptions,
        heroConfig.applied_debuffs_descriptions,
        heroConfig.applied_effects_powers,
        heroConfig.applied_buffs_powers,
        heroConfig.applied_debuffs_powers,
        heroConfig.aura_effects,
        heroConfig.aura_ranges,
        heroConfig.aura_is_buff,
        heroConfig.synergies,
        1,
        0,
        team,
        UnitType.HERO,
        `${largeTextureName.split("_").slice(0, -1).join("_")}${heroConfig.size === 1 ? "_128" : "_256"}`,
        largeTextureName,
        MIN_UNIT_STACK_POWER,
        "",
    );
};

export const getAbilityConfig = (abilityName: string): AbilityProperties => {
    // @ts-ignore: we do not know the type here yet
    const ability = abilitiesJson[abilityName];
    if (!ability) {
        throw TypeError(`Unknown ability - ${abilityName}`);
    }

    const abilityType = ToAbilityType[ability.type];
    if (!abilityType) {
        throw new TypeError(`Invalid type for ability ${abilityName} = ${abilityType}`);
    }

    const abilityPowerType = ToAbilityPowerType[ability.power_type];
    if (!abilityPowerType) {
        throw new TypeError(`Invalid power type for ability ${abilityName} = ${abilityPowerType}`);
    }

    if (!ability.desc || ability.desc.constructor !== Array || !ability.desc.length) {
        throw new TypeError(`Invalid description list for ability ${abilityName}`);
    }

    if (ability.effect !== null && ability?.effect.constructor !== String) {
        throw new TypeError(`Invalid effect list for ability ${abilityName}`);
    }

    if (
        ability.can_be_cast === undefined ||
        ability.can_be_cast === null ||
        ability.can_be_cast.constructor !== Boolean
    ) {
        throw TypeError(`Unknown 'can_be_cast' type for ability ${abilityName}`);
    }

    return new AbilityProperties(
        abilityName,
        abilityType,
        ability.desc,
        ability.power,
        abilityPowerType,
        ability.skip_reponse,
        ability.stack_powered,
        ability.effect,
        ability.aura_effect,
        ability.can_be_cast,
    );
};

export const getCreatureConfig = (
    team: TeamType,
    faction: FactionType,
    creatureName: string,
    largeTextureName: string,
    amount: number,
    totalExp?: number,
): UnitProperties => {
    // @ts-ignore: we do not know the type here yet
    const factionUnits = creaturesJson[faction];
    if (!factionUnits) {
        throw TypeError(`Unknown faction - ${faction}`);
    }

    const creatureConfig = factionUnits[creatureName];
    if (!creatureConfig) {
        throw TypeError(`Unknown creature - ${creatureName}`);
    }

    const attackType =
        creatureConfig.attack_type && creatureConfig.attack_type.constructor === String
            ? ToAttackType[creatureConfig.attack_type]
            : undefined;
    if (attackType === undefined || attackType === AttackType.NO_TYPE) {
        throw new TypeError(`Invalid attack type for creature ${creatureName} = ${attackType}`);
    }

    const movementType =
        creatureConfig.movement_type && creatureConfig.movement_type.constructor === String
            ? ToMovementType[creatureConfig.movement_type as string]
            : undefined;
    if (movementType === undefined || movementType === MovementType.NO_TYPE) {
        throw new TypeError(`Invalid movement type for creature ${creatureName} = ${movementType}`);
    }

    const luck = DEFAULT_LUCK_PER_FACTION[faction] ?? 0;
    const morale = DEFAULT_MORALE_PER_FACTION[faction] ?? 0;

    const abilityAuraRanges: number[] = [];
    const abilityDescriptions: string[] = [];
    const abilityIsStackPowered: boolean[] = [];
    const abilityIsAura: boolean[] = [];
    const abilityAuraIsBuff: boolean[] = [];
    const auraEffects: string[] = [];

    for (const abilityName of creatureConfig.abilities) {
        const abilityConfig = getAbilityConfig(abilityName);

        if (!abilityConfig) {
            throw new TypeError(`Unable to get config for ability ${abilityName} and creature ${creatureName}`);
        }

        if (!abilityConfig.desc || abilityConfig.desc.constructor !== Array || !abilityConfig.desc.length) {
            throw new TypeError(`No description for ability ${abilityName} and creature ${creatureName}`);
        }

        if (abilityConfig.power === null || abilityConfig.power === undefined) {
            throw new TypeError(`No power for ability ${abilityName} and creature ${creatureName}`);
        }

        if (abilityConfig.name === "Chain Lightning") {
            const description = abilityConfig.desc.join("\n");
            const updatedDescription = description
                .replace("{}", Number(abilityConfig.power.toFixed()).toString())
                .replace("{}", Number(((abilityConfig.power / 8) * 7).toFixed()).toString())
                .replace("{}", Number(((abilityConfig.power / 8) * 6).toFixed()).toString())
                .replace("{}", Number(((abilityConfig.power / 8) * 5).toFixed()).toString());
            abilityDescriptions.push(updatedDescription);
        }
        if (abilityConfig.name === "Paralysis") {
            const description = abilityConfig.desc.join("\n");
            const updatedDescription = description
                .replace("{}", Number((abilityConfig.power * 2).toFixed()).toString())
                .replace("{}", Number(abilityConfig.power.toFixed()).toString());
            abilityDescriptions.push(updatedDescription);
        } else {
            abilityDescriptions.push(abilityConfig.desc.join("\n").replace(/\{\}/g, abilityConfig.power.toString()));
        }
        abilityIsStackPowered.push(abilityConfig.stack_powered);

        const auraEffect = abilityConfig.aura_effect;
        if (auraEffect) {
            auraEffects.push(auraEffect);
            const auraConfig = getAuraEffectConfig(auraEffect);
            abilityAuraRanges.push(auraConfig?.range ?? 0);
            abilityAuraIsBuff.push(auraConfig?.is_buff ?? true);
        } else {
            abilityAuraRanges.push(0);
            abilityAuraIsBuff.push(true);
        }

        abilityIsAura.push(!!abilityConfig.aura_effect);
    }

    return new UnitProperties(
        faction,
        creatureConfig.name,
        creatureConfig.hp,
        creatureConfig.steps,
        morale,
        luck,
        creatureConfig.speed,
        creatureConfig.armor,
        attackType,
        creatureConfig.attack,
        creatureConfig.attack_damage_min,
        creatureConfig.attack_damage_max,
        creatureConfig.attack_range,
        creatureConfig.range_shots,
        creatureConfig.shot_distance,
        creatureConfig.magic_resist,
        movementType,
        creatureConfig.exp,
        creatureConfig.size,
        creatureConfig.level,
        structuredClone(creatureConfig.spells),
        creatureConfig.abilities,
        abilityDescriptions,
        abilityIsStackPowered,
        abilityIsAura,
        [], // creatureConfig.effects,
        [],
        [],
        [],
        [],
        [],
        [],
        [],
        [],
        [],
        [],
        [],
        auraEffects,
        abilityAuraRanges,
        abilityAuraIsBuff,
        [],
        amount > 0 ? amount : Math.ceil((totalExp ?? 0) / creatureConfig.exp),
        0,
        team,
        UnitType.CREATURE,
        `${largeTextureName.split("_").slice(0, -1).join("_")}${creatureConfig.size === 1 ? "_128" : "_256"}`,
        largeTextureName,
        MAX_UNIT_STACK_POWER,
        "",
    );
};

export const getSpellConfig = (faction: FactionType, spellName: string, laps?: number): SpellProperties => {
    // @ts-ignore: we do not know the type here yet
    const raceSpells = spellsJson[faction ? faction : "System"];
    if (!raceSpells) {
        throw TypeError(`Unknown race ${faction} for the spell - ${spellName}`);
    }

    const spellConfig = raceSpells[spellName];
    if (!spellConfig) {
        throw TypeError(`Unknown spell - ${spellName}`);
    }

    if (!spellConfig.conflicts_with || spellConfig.conflicts_with.constructor !== Array) {
        throw TypeError(`Unknown 'conflicts_with' type for the spell - ${spellName}`);
    }

    if (
        spellConfig.is_buff === undefined ||
        spellConfig.is_buff === null ||
        spellConfig.is_buff.constructor !== Boolean
    ) {
        throw TypeError(`Unknown 'is_buff' type for the spell - ${spellName}`);
    }

    if (
        spellConfig.is_giftable === undefined ||
        spellConfig.is_giftable === null ||
        spellConfig.is_giftable.constructor !== Boolean
    ) {
        throw TypeError(`Unknown 'is_giftable' type for the spell - ${spellName}`);
    }

    if (
        spellConfig.minimal_caster_stack_power === undefined ||
        spellConfig.minimal_caster_stack_power === null ||
        spellConfig.minimal_caster_stack_power.constructor !== Number
    ) {
        throw TypeError(`Unknown 'minimal_caster_stack_power' type for the spell - ${spellName}`);
    }

    if (
        spellConfig.maximum_gift_level === undefined ||
        spellConfig.maximum_gift_level === null ||
        spellConfig.maximum_gift_level.constructor !== Number
    ) {
        throw TypeError(`Unknown 'maximum_gift_level' type for the spell - ${spellName}`);
    }

    const targetType =
        spellConfig.target && spellConfig.target.constructor === String
            ? ToSpellTargetType[spellConfig.target as string]
            : undefined;
    if (targetType === undefined || targetType === SpellTargetType.NO_TYPE) {
        throw new TypeError(`Invalid target type for spell ${spellName} = ${targetType}`);
    }

    const powerType =
        spellConfig.power_type && spellConfig.power_type.constructor === String
            ? ToSpellPowerType[spellConfig.power_type as string]
            : undefined;
    if (powerType === undefined || powerType === SpellPowerType.NO_TYPE) {
        throw new TypeError(`Invalid power type for spell ${spellName} = ${powerType}`);
    }

    const multiplierType =
        spellConfig.multiplier_type && spellConfig.multiplier_type.constructor === String
            ? ToSpellMultiplierType[spellConfig.multiplier_type as string]
            : undefined;
    if (multiplierType === undefined || multiplierType === SpellMultiplierType.NO_TYPE) {
        throw new TypeError(`Invalid multiplier type for spell ${spellName} = ${multiplierType}`);
    }

    return new SpellProperties(
        faction,
        spellConfig.name,
        spellConfig.level,
        spellConfig.desc,
        targetType,
        spellConfig.power,
        powerType,
        multiplierType,
        laps !== undefined ? laps : spellConfig.laps,
        spellConfig.is_buff,
        spellConfig.self_cast_allowed,
        spellConfig.self_debuff_applies,
        spellConfig.minimal_caster_stack_power,
        spellConfig.conflicts_with,
        spellConfig.is_giftable,
        spellConfig.maximum_gift_level,
    );
};

export const getEffectConfig = (effectName: string): EffectProperties | undefined => {
    // @ts-ignore: we do not know the type here yet
    const effect = effectsJson[effectName];
    if (!effect) {
        return undefined;
    }

    return new EffectProperties(effectName, effect.laps, effect.desc, effect.power);
};

export const getAuraEffectConfig = (auraEffectName: string): AuraEffectProperties | undefined => {
    // @ts-ignore: we do not know the type here yet
    const auraEffect = auraEffectsJson[auraEffectName];
    if (!auraEffect) {
        return undefined;
    }

    const auraEffectPowerType = ToAbilityPowerType[auraEffect.power_type];
    if (!auraEffectPowerType) {
        throw new TypeError(`Invalid power type for aura effect ${auraEffectName} = ${auraEffectPowerType}`);
    }

    return new AuraEffectProperties(
        auraEffectName,
        auraEffect.range,
        auraEffect.desc,
        auraEffect.power,
        auraEffect.is_buff,
        auraEffectPowerType,
    );
};
