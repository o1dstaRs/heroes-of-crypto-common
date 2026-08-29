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
import { getCraftChances } from "../abilities/craft_chances";
import { CHAKRAM_ABILITY_NAME, chakramDescription } from "../abilities/chakram_ability";
import {
    SpellElement,
    SpellMultiplierType,
    SpellPowerType,
    SpellProperties,
    SpellTargetType,
    ToSpellElement,
    ToSpellMultiplierType,
    ToSpellPowerType,
    ToSpellTargetType,
} from "../spells/spell_properties";
import { normalizeFootprintSide } from "../grid/grid_math";
import { ToAttackType, ToMovementType, UnitProperties } from "../units/unit_properties";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { TeamType } from "../../src/generated/protobuf/v1/types_gen";
import { MAX_UNIT_STACK_POWER, MIN_UNIT_STACK_POWER } from "../constants";
import { ToFactionType } from "../factions/faction_type";

const DEFAULT_HERO_CONFIG = {
    hp: 120,
    steps: 3,
    initiative: 2,
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

const DEFAULT_LUCK_PER_FACTION: Record<string, number> = {
    Might: 1,
    Chaos: -1,
    Nature: 4,
    Life: 1,
    Death: -2,
    Order: 3,
};

const DEFAULT_MORALE_PER_FACTION: Record<string, number> = {
    Might: 2,
    Chaos: -1,
    Nature: 1,
    Life: 4,
    Death: -4,
    Order: 3,
};

export const getHeroConfig = (
    team: TeamType,
    factionName: string,
    heroName: string,
    largeTextureName: string,
): UnitProperties => {
    const heroConfig = {
        ...DEFAULT_HERO_CONFIG,
        factionName,
    };

    const luck = DEFAULT_LUCK_PER_FACTION[factionName] ?? 0;
    const morale = DEFAULT_MORALE_PER_FACTION[factionName] ?? 0;

    const attackType =
        heroConfig.attack_type && heroConfig.attack_type.constructor === String
            ? ToAttackType[heroConfig.attack_type as string]
            : undefined;
    if (attackType === undefined || attackType === PBTypes.AttackVals.NO_ATTACK) {
        throw new TypeError(`Invalid attack type for hero ${heroName} = ${attackType}`);
    }

    const movementType =
        heroConfig.movement_type && heroConfig.movement_type.constructor === String
            ? ToMovementType[heroConfig.movement_type as string]
            : undefined;
    if (movementType === undefined || movementType === PBTypes.MovementVals.NO_MOVEMENT) {
        throw new TypeError(`Invalid movement type for hero ${heroName} = ${movementType}`);
    }

    return new UnitProperties(
        ToFactionType[factionName],
        heroName,
        heroConfig.hp,
        heroConfig.steps,
        morale,
        luck,
        heroConfig.initiative,
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
        PBTypes.UnitVals.HERO,
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
    // NO_TYPE is a legitimate value (enum 0) that the ToAbility*Type maps list explicitly, so reject only
    // unknown keys (undefined) — a `!x` guard would wrongly throw on the valid 0 (e.g. Water Shield's NO_TYPE).
    if (abilityType === undefined) {
        throw new TypeError(`Invalid type for ability ${abilityName} = ${ability.type}`);
    }

    const abilityPowerType = ToAbilityPowerType[ability.power_type];
    if (abilityPowerType === undefined) {
        throw new TypeError(`Invalid power type for ability ${abilityName} = ${ability.power_type}`);
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

/**
 * The optional rectangular footprint of a creature. `size` remains the LEGACY SQUARE size — it picks the art
 * tier (_128 vs _256) and still feeds the wire's UnitSizeVals enum and every consumer this migration has not
 * reached — while the footprint is what the engine reserves on the board.
 *
 * The two must agree on `size === max(width, height)`, enforced below. It is not derivable in either
 * direction (2x1 and 1x2 both max to 2), so it is declared and checked rather than computed, and the
 * direction of the rule is deliberate: an un-migrated `size === 2 ? large : small` branch then treats a
 * rectangle as the BIGGER square, which over-reserves cells and refuses a legal placement. The opposite
 * choice would have it under-reserve and let a second stack overlap the half of the body it forgot.
 */
interface ICreatureFootprintConfig {
    footprint_width?: unknown;
    footprint_height?: unknown;
}

/**
 * Read one declared footprint side. A side is a count of whole cells, so anything that is not a positive
 * integer is a configuration bug and throws like every other malformed field in this file — silently
 * flooring it would hand the engine a unit whose body is a different shape than the board reserved for it.
 */
/**
 * The largest footprint side the engine is VERIFIED for.
 *
 * This is a claim about what has been MEASURED, not about what the geometry can express — the helpers in
 * grid_math generalise to any W x H, and the anchor round trip is exact well past this number. What bounds
 * it is the clash: 1x1, 2x2, 2x1, 1x2, 3x1, 1x3, 3x2, 2x3 and 3x3 all play whole matches under every AI
 * version with zero engine-rejected actions, across all four boards. Side 4 has simply never been run.
 *
 * Side 3 used to be genuinely broken — ~64 refused melee actions per 8 matches — and the cause was not the
 * geometry but a family of call sites that read `getCellForPosition(unit.getPosition())` as "the unit's
 * anchor". `position` is the body's CENTRE, and the two coincide only up to side 2 (for a 2x1 / 1x2 merely
 * because the centre lands on a cell boundary and `floor` breaks the tie towards the anchor). Those sites
 * now ask for the anchor, and the shapes above measure clean.
 *
 * The bound stays enforced rather than assumed: a configuration the engine has not been shown to honour
 * should fail loudly where it is declared, not degrade into an AI that proposes moves the engine refuses
 * all match. Raising it further means running the clash for that side first.
 *
 * Note this is not permission to ship a 3-cell creature. Art is authored per size tier and stops at two
 * cells, and the deployment strips are shallow; a creature that ships deeper than 2 needs both addressed.
 */
export const MAX_VERIFIED_FOOTPRINT_SIDE = 3;

const getCreatureFootprintSide = (
    creatureName: string,
    key: "footprint_width" | "footprint_height",
    value: unknown,
): number | undefined => {
    if (value === undefined || value === null) {
        return undefined;
    }

    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        throw new TypeError(`Invalid ${key} for creature ${creatureName} = ${value}`);
    }

    if (value > MAX_VERIFIED_FOOTPRINT_SIDE) {
        throw new TypeError(
            `Unsupported ${key} for creature ${creatureName} = ${value}: ` +
                `footprint sides above ${MAX_VERIFIED_FOOTPRINT_SIDE} are not supported by the engine yet`,
        );
    }

    return value;
};

/**
 * QA/dev footprint overrides, so a rectangular body can be exercised end to end — headless sims, the server,
 * and a real browser match — WITHOUT changing any shipped creature's data. Turning a creature rectangular is
 * a balance and art decision, not an engineering one; this is the switch that lets the engineering be proven
 * before that decision is made.
 *
 * Node/CI:  HOC_FOOTPRINT_OVERRIDES="White Tiger=2x1,Hyena=2x1"
 * Browser:  globalThis.__hocFootprintOverrides = "White Tiger=2x1"   (before the first unit is built)
 *
 * Parsed on every read rather than cached, so a dev console can flip it mid-session. Malformed entries are
 * ignored — this is a diagnostic lever, and an unparsable one must not take a real match down with it.
 *
 * An override deliberately leaves `size` alone and so skips the size === max(W, H) rule the JSON must obey:
 * it exists to exercise the ENGINE, and re-tiering the art mid-session would only ask for a _256 texture the
 * overridden creature does not have. A creature that ships rectangular declares both, and gets art to match.
 */
const readFootprintOverrideSource = (): string => {
    const injected = (globalThis as { __hocFootprintOverrides?: unknown }).__hocFootprintOverrides;
    if (typeof injected === "string" && injected) {
        return injected;
    }
    // `process` is absent in the browser bundle and `env` can be absent in exotic hosts.
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    return env?.HOC_FOOTPRINT_OVERRIDES ?? "";
};

const getCreatureFootprintOverride = (creatureName: string): { width: number; height: number } | undefined => {
    const source = readFootprintOverrideSource();
    if (!source) {
        return undefined;
    }
    for (const entry of source.split(",")) {
        const separator = entry.lastIndexOf("=");
        if (separator <= 0) {
            continue;
        }
        if (entry.slice(0, separator).trim() !== creatureName) {
            continue;
        }
        const shape = /^([0-9]+)x([0-9]+)$/.exec(entry.slice(separator + 1).trim());
        if (!shape) {
            continue;
        }
        const width = Number(shape[1]);
        const height = Number(shape[2]);
        // Same bound as the JSON path. This lever exists to exercise shapes the engine can actually honour;
        // letting it conjure an unsupported one would only manufacture a broken match to debug.
        if (width > 0 && height > 0 && width <= MAX_VERIFIED_FOOTPRINT_SIDE && height <= MAX_VERIFIED_FOOTPRINT_SIDE) {
            return { width, height };
        }
    }
    return undefined;
};

const creatureFootprintCache = new Map<string, { width: number; height: number }>();

/**
 * A creature's board footprint WITHOUT building its full UnitProperties.
 *
 * The AI has to know how big a summon is before it decides where to put it, and it asks once per candidate
 * cell per summoner per turn — far too hot for `getCreatureConfig`, which parses abilities, spells and
 * effects to answer. This reads the two keys that matter (honouring the QA override, so an overridden shape
 * is seated the same way it is played) and memoises per creature, since creatures.json does not change
 * within a process.
 *
 * Returns 1x1 for an unknown creature rather than throwing: the caller is choosing a hypothetical spot, and
 * a bad name is the summon path's problem to report, not this lookup's.
 */
export const getCreatureFootprint = (factionName: string, creatureName: string): { width: number; height: number } => {
    const key = `${factionName}/${creatureName}`;
    const cached = creatureFootprintCache.get(key);
    if (cached) {
        return cached;
    }
    // @ts-ignore: the JSON shape is not typed here, exactly as in getCreatureConfig below
    const creatureConfig = creaturesJson[factionName]?.[creatureName];
    const override = getCreatureFootprintOverride(creatureName);
    const size = normalizeFootprintSide(creatureConfig?.size, 1);
    const resolved = override ?? {
        width: normalizeFootprintSide(creatureConfig?.footprint_width, size),
        height: normalizeFootprintSide(creatureConfig?.footprint_height, size),
    };
    creatureFootprintCache.set(key, resolved);
    return resolved;
};

export const getCreatureConfig = (
    team: TeamType,
    factionName: string,
    creatureName: string,
    largeTextureName: string,
    amount: number,
    totalExp?: number,
): UnitProperties => {
    // @ts-ignore: we do not know the type here yet
    const factionUnits = creaturesJson[factionName];
    if (!factionUnits) {
        throw TypeError(`Unknown faction - ${factionName}`);
    }

    const creatureConfig = factionUnits[creatureName];
    if (!creatureConfig) {
        throw TypeError(`Unknown creature - ${creatureName}`);
    }

    const attackType =
        creatureConfig.attack_type && creatureConfig.attack_type.constructor === String
            ? ToAttackType[creatureConfig.attack_type]
            : undefined;
    if (attackType === undefined || attackType === PBTypes.AttackVals.NO_ATTACK) {
        throw new TypeError(`Invalid attack type for creature ${creatureName} = ${attackType}`);
    }

    const movementType =
        creatureConfig.movement_type && creatureConfig.movement_type.constructor === String
            ? ToMovementType[creatureConfig.movement_type as string]
            : undefined;
    if (movementType === undefined || movementType === PBTypes.MovementVals.NO_MOVEMENT) {
        throw new TypeError(`Invalid movement type for creature ${creatureName} = ${movementType}`);
    }

    const creatureFootprint = creatureConfig as ICreatureFootprintConfig;
    const footprintWidth = getCreatureFootprintSide(creatureName, "footprint_width", creatureFootprint.footprint_width);
    const footprintHeight = getCreatureFootprintSide(
        creatureName,
        "footprint_height",
        creatureFootprint.footprint_height,
    );
    const footprintOverride = getCreatureFootprintOverride(creatureName);
    if (footprintOverride === undefined && (footprintWidth !== undefined || footprintHeight !== undefined)) {
        const declaredSize = creatureConfig.size;
        const width = footprintWidth ?? declaredSize;
        const height = footprintHeight ?? declaredSize;
        if (Math.max(width, height) !== declaredSize) {
            throw new TypeError(
                `Invalid footprint for creature ${creatureName}: size ${declaredSize} must equal max(${width}, ${height})`,
            );
        }
    }

    const luck = DEFAULT_LUCK_PER_FACTION[factionName] ?? 0;
    const morale = DEFAULT_MORALE_PER_FACTION[factionName] ?? 0;

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
        } else if (abilityConfig.name === "Paralysis") {
            const description = abilityConfig.desc.join("\n");
            const updatedDescription = description
                .replace("{}", Number((abilityConfig.power * 2).toFixed()).toString())
                .replace("{}", Number(abilityConfig.power.toFixed()).toString());
            abilityDescriptions.push(updatedDescription);
        } else if (abilityConfig.name === CHAKRAM_ABILITY_NAME) {
            // Creature configs are templates with the minimum stack tier. Live units rewrite this after
            // stack power is calculated; keeping the template at 1 avoids ever rendering power=100 targets.
            abilityDescriptions.push(chakramDescription(abilityConfig.desc.join("\n"), MIN_UNIT_STACK_POWER));
        } else if (abilityConfig.name === "Blacksmith Tools") {
            // Craft's four outcome odds are computed, not a single power — the config carries power 0, so the
            // generic branch below printed "0%" for all four and the card claimed the spell does nothing.
            // Luck is unknown here (this builds the creature TEMPLATE, before any unit exists), so the card
            // starts at the luck-0 split; Unit.getAbilityDescription re-renders it with the caster's real luck
            // once the unit is alive.
            const { stun, nothing, double, frozen } = getCraftChances(0);
            abilityDescriptions.push(
                abilityConfig.desc
                    .join("\n")
                    .replace("{}", double.toString())
                    .replace("{}", frozen.toString())
                    .replace("{}", stun.toString())
                    .replace("{}", nothing.toString()),
            );
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
        ToFactionType[factionName],
        creatureConfig.name,
        creatureConfig.hp,
        creatureConfig.steps,
        morale,
        luck,
        creatureConfig.initiative,
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
        PBTypes.UnitVals.CREATURE,
        `${largeTextureName.split("_").slice(0, -1).join("_")}${creatureConfig.size === 1 ? "_128" : "_256"}`,
        largeTextureName,
        MAX_UNIT_STACK_POWER,
        "",
        [],
        false,
        footprintOverride?.width ?? footprintWidth,
        footprintOverride?.height ?? footprintHeight,
    );
};

const LEGACY_SPELL_FACTION_REDIRECTS: Readonly<Record<string, string>> = {
    "Life:Fire Strike": "Chaos",
    "Life:Meteorite": "Chaos",
    "Nature:Meteorite": "Chaos",
};

export const getSpellConfig = (factionName: string, spellName: string, laps?: number): SpellProperties => {
    const requestedFactionName = factionName || "System";
    const resolvedFactionName =
        LEGACY_SPELL_FACTION_REDIRECTS[`${requestedFactionName}:${spellName}`] ?? requestedFactionName;
    // @ts-ignore: we do not know the type here yet
    const raceSpells = spellsJson[resolvedFactionName];
    if (!raceSpells) {
        throw TypeError(`Unknown race ${factionName} for the spell - ${spellName}`);
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

    // Element is the one classification a spell is allowed NOT to have: only the elemental spells declare
    // one, everything else carries "" and resolves to NO_ELEMENT. An unknown string is still a config bug.
    const element =
        spellConfig.element && spellConfig.element.constructor === String
            ? ToSpellElement[spellConfig.element as string]
            : SpellElement.NO_ELEMENT;
    if (element === undefined) {
        throw new TypeError(`Invalid element for spell ${spellName} = ${spellConfig.element}`);
    }

    const multiplierType =
        spellConfig.multiplier_type && spellConfig.multiplier_type.constructor === String
            ? ToSpellMultiplierType[spellConfig.multiplier_type as string]
            : undefined;
    if (multiplierType === undefined || multiplierType === SpellMultiplierType.NO_TYPE) {
        throw new TypeError(`Invalid multiplier type for spell ${spellName} = ${multiplierType}`);
    }

    return new SpellProperties(
        ToFactionType[resolvedFactionName],
        spellConfig.name,
        spellConfig.level,
        spellConfig.desc,
        targetType,
        spellConfig.power,
        powerType,
        element,
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

/**
 * Every aura effect name that can land on a unit while it stands inside an aura's radius — the keys of
 * aura_effects.json (minus the version marker): "Luck", "Pegasus Might", "War Anger", "Disguise", … .
 * Auras are applied and removed continuously as units (and their neighbours) move in and out of range,
 * so the UI must NOT animate them as freshly-applied buff/debuff pops. NOTE: the ABILITY is named
 * "<X> Aura", but the EFFECT it applies to a unit is this short name (e.g. ability "Pegasus Might Aura"
 * applies effect "Pegasus Might"), so a "name ends with ' Aura'" check alone misses every one of them.
 */
export const AURA_EFFECT_NAMES: ReadonlySet<string> = new Set(
    Object.keys(auraEffectsJson).filter((key) => key !== "version"),
);

/** True when `name` is an aura effect (continuous, radius-based) rather than a directly-applied one. */
export const isAuraEffectName = (name: string): boolean => name.endsWith(" Aura") || AURA_EFFECT_NAMES.has(name);

/**
 * The aura EFFECT names whose power type is POISON_ON_HIT — today just "Venom Cloud" (Wyvern, 2 cells).
 * "Poison Cloud" used to sit here too: the Dryad's aura until it traded poison for Guiding Winds, kept
 * on afterwards as an unassigned declaration and removed in full once nothing carried it.
 *
 * Still DERIVED from the config rather than hard-coded, and that matters more now that the set holds one
 * name: reading a literal instead is the exact bug this replaced — a second poison aura once buffed the
 * right allies, showed the right tooltip and poisoned nobody. A new poison aura needs only a declaration
 * in aura_effects.json; the on-hit path, the tooltip folding and the client description refresh all read
 * this set. See test/abilities/poison_aura_config_driven.test.ts, which guards the derivation directly.
 */
export const POISON_ON_HIT_AURA_EFFECT_NAMES: ReadonlySet<string> = new Set(
    Object.keys(auraEffectsJson).filter(
        // @ts-ignore: we do not know the type here yet
        (key) => key !== "version" && auraEffectsJson[key]?.power_type === "POISON_ON_HIT",
    ),
);

/**
 * The BUFF name each of those auras leaves on an affected ally. units_holder applies auras as
 * `${effectName} Aura`, which also happens to be the owning ability's name, so this one set covers both
 * `unit.getBuff(...)` lookups and `unit.getAbility(...)` lookups.
 */
export const POISON_ON_HIT_AURA_BUFF_NAMES: ReadonlySet<string> = new Set(
    Array.from(POISON_ON_HIT_AURA_EFFECT_NAMES, (name) => `${name} Aura`),
);
