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

import { FactionType } from "../factions/faction_type";

export enum SpellTargetType {
    NO_TYPE = 0,
    FREE_CELL = 1,
    ANY_ALLY = 2,
    RANDOM_CLOSE_TO_CASTER = 3,
    ALL_ALLIES = 4,
    ALL_ENEMIES = 5,
    ANY_ENEMY = 6,
    ANY_UNIT = 7,
    ALL_FLYING = 8,
    ENEMY_WITHIN_MOVEMENT_RANGE = 9,
    AUTO = 10,
}

export const AllSpellTargetTypes = [
    SpellTargetType.FREE_CELL,
    SpellTargetType.ANY_ALLY,
    SpellTargetType.RANDOM_CLOSE_TO_CASTER,
    SpellTargetType.ALL_ALLIES,
    SpellTargetType.ALL_ENEMIES,
    SpellTargetType.ANY_ENEMY,
    SpellTargetType.ANY_UNIT,
    SpellTargetType.ALL_FLYING,
    SpellTargetType.ENEMY_WITHIN_MOVEMENT_RANGE,
    SpellTargetType.AUTO,
];

export type AllSpellTargetType = (typeof AllSpellTargetTypes)[number];

export const ToSpellTargetType: { [spellTargetTypeName: string]: SpellTargetType } = {
    "": SpellTargetType.NO_TYPE,
    FREE_CELL: SpellTargetType.FREE_CELL,
    ANY_ALLY: SpellTargetType.ANY_ALLY,
    RANDOM_CLOSE_TO_CASTER: SpellTargetType.RANDOM_CLOSE_TO_CASTER,
    ALL_ALLIES: SpellTargetType.ALL_ALLIES,
    ALL_ENEMIES: SpellTargetType.ALL_ENEMIES,
    ANY_ENEMY: SpellTargetType.ANY_ENEMY,
    ANY_UNIT: SpellTargetType.ANY_UNIT,
    ALL_FLYING: SpellTargetType.ALL_FLYING,
    ENEMY_WITHIN_MOVEMENT_RANGE: SpellTargetType.ENEMY_WITHIN_MOVEMENT_RANGE,
    AUTO: SpellTargetType.AUTO,
};

export enum SpellPowerType {
    NO_TYPE = 0,
    COMMON = 1,
    MIND = 2,
    HEAL = 3,
    POSITION_CHANGE = 4,
}

export const AllSpellPowerTypes = [
    SpellPowerType.COMMON,
    SpellPowerType.MIND,
    SpellPowerType.HEAL,
    SpellPowerType.POSITION_CHANGE,
];

export type AllSpellPowerType = (typeof AllSpellPowerTypes)[number];

export const ToSpellPowerType: { [spellPowerTypeName: string]: SpellPowerType } = {
    "": SpellPowerType.NO_TYPE,
    COMMON: SpellPowerType.COMMON,
    MIND: SpellPowerType.MIND,
    HEAL: SpellPowerType.HEAL,
    POSITION_CHANGE: SpellPowerType.POSITION_CHANGE,
};

export enum SpellMultiplierType {
    NO_TYPE = 0,
    NO_MULTIPLIER = 1,
    UNIT_AMOUNT = 2,
    UNIT_AMOUNT_POWER = 3,
}

export const AllSpellMultiplierTypes = [
    SpellMultiplierType.NO_MULTIPLIER,
    SpellMultiplierType.UNIT_AMOUNT,
    SpellMultiplierType.UNIT_AMOUNT_POWER,
];

export type AllSpellMultiplierType = (typeof AllSpellMultiplierTypes)[number];

export const ToSpellMultiplierType: { [spellMultiplierTypeName: string]: SpellMultiplierType } = {
    "": SpellMultiplierType.NO_TYPE,
    NO_MULTIPLIER: SpellMultiplierType.NO_MULTIPLIER,
    UNIT_AMOUNT: SpellMultiplierType.UNIT_AMOUNT,
    UNIT_AMOUNT_POWER: SpellMultiplierType.UNIT_AMOUNT_POWER,
};

export class SpellProperties {
    public readonly name: string;

    public readonly faction: FactionType;

    public readonly level: number;

    public desc: string[];

    public readonly spell_target_type: SpellTargetType;

    public power: number;

    public readonly power_type: SpellPowerType;

    public readonly multiplier_type: SpellMultiplierType;

    public readonly laps: number;

    public readonly is_buff: boolean;

    public readonly self_cast_allowed: boolean;

    public readonly self_debuff_applies: boolean;

    public readonly minimal_caster_stack_power: number;

    public readonly conflicts_with: string[];

    public readonly is_giftable: boolean;

    public readonly maximum_gift_level: number;

    public constructor(
        faction: FactionType,
        name: string,
        level: number,
        desc: string[],
        spell_target_type: SpellTargetType,
        power: number,
        power_type: SpellPowerType,
        multiplier_type: SpellMultiplierType,
        laps: number,
        is_buff: boolean,
        self_cast_allowed: boolean,
        self_debuff_applies: boolean,
        minimal_caster_stack_power: number,
        conflicts_with: string[],
        is_giftable: boolean,
        maximum_gift_level: number,
    ) {
        this.faction = faction;
        this.name = name;
        this.level = level;
        this.desc = desc;
        this.spell_target_type = spell_target_type;
        this.power = power;
        this.power_type = power_type;
        this.multiplier_type = multiplier_type;
        this.laps = laps;
        this.is_buff = is_buff;
        this.self_cast_allowed = self_cast_allowed;
        this.self_debuff_applies = self_debuff_applies;
        this.minimal_caster_stack_power = minimal_caster_stack_power;
        this.conflicts_with = conflicts_with;
        this.is_giftable = is_giftable;
        this.maximum_gift_level = maximum_gift_level;
    }
}
