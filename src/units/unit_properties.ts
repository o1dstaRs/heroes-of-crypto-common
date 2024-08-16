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

import { v4 as uuidv4 } from "uuid";

import { FactionType } from "../factions/faction_properties";

export enum AttackType {
    NO_TYPE = 0,
    MELEE = 1,
    RANGE = 2,
    MAGIC = 3,
}

export const ToAttackType: { [attackTypeName: string]: AttackType } = {
    "": AttackType.NO_TYPE,
    NO_TYPE: AttackType.NO_TYPE,
    MELEE: AttackType.MELEE,
    RANGE: AttackType.RANGE,
    MAGIC: AttackType.MAGIC,
};

export enum TeamType {
    NO_TEAM = 0,
    UPPER = 1,
    LOWER = 2,
}

export enum UnitType {
    NO_TYPE = 0,
    CREATURE = 1,
    HERO = 2,
}

export interface IModifyableUnitProperties {
    hp: number;
    armor: number;
    luck: number;
}

export class UnitProperties {
    public readonly id: string;

    public readonly faction: FactionType;

    public readonly name: string;

    public readonly team: TeamType;

    public readonly unit_type: UnitType;

    public max_hp: number;

    public hp: number;

    public readonly steps: number;

    public steps_morale: number;

    public morale: number;

    public luck: number;

    public readonly speed: number;

    public armor_mod: number;

    public base_armor: number;

    public range_armor: number;

    public readonly attack_type: AttackType;

    public attack_type_selected: AttackType;

    public base_attack: number;

    public attack_mod: number;

    public readonly attack_damage_min: number;

    public readonly attack_damage_max: number;

    public readonly attack_range: number;

    public range_shots: number;

    public range_shots_mod: number;

    public shot_distance: number;

    public magic_resist: number;

    public magic_resist_mod: number;

    public readonly can_cast_spells: boolean;

    public can_fly: boolean;

    public exp: number;

    public readonly size: number;

    public readonly level: number;

    public readonly spells: string[];

    public readonly abilities: string[];

    public readonly abilities_descriptions: string[];

    public readonly abilities_stack_powered: boolean[];

    public readonly abilities_auras: boolean[];

    public applied_effects: string[];

    public applied_buffs: string[];

    public applied_debuffs: string[];

    public applied_effects_laps: number[];

    public applied_buffs_laps: number[];

    public applied_debuffs_laps: number[];

    public applied_effects_descriptions: string[];

    public applied_buffs_descriptions: string[];

    public applied_debuffs_descriptions: string[];

    public applied_effects_powers: number[];

    public applied_buffs_powers: number[];

    public applied_debuffs_powers: number[];

    public aura_effects: string[];

    public aura_ranges: number[];

    public aura_is_buff: boolean[];

    public amount_alive: number;

    public amount_died: number;

    public luck_per_turn: number;

    public attack_multiplier: number;

    public small_texture_name: string;

    public large_texture_name: string;

    public stack_power: number;

    public constructor(
        faction: FactionType,
        name: string,
        max_hp: number,
        steps: number,
        morale: number,
        luck: number,
        speed: number,
        base_armor: number,
        attack_type: AttackType,
        base_attack: number,
        attack_damage_min: number,
        attack_damage_max: number,
        attack_range: number,
        range_shots: number,
        shot_distance: number,
        magic_resist: number,
        can_fly: boolean,
        exp: number,
        size: number,
        level: number,
        spells: string[],
        abilities: string[],
        abilities_descriptions: string[],
        abilities_stack_powered: boolean[],
        abilities_auras: boolean[],
        applied_effects: string[],
        applied_buffs: string[],
        applied_debuffs: string[],
        applied_effects_laps: number[],
        applied_buffs_laps: number[],
        applied_debuffs_laps: number[],
        applied_effects_descriptions: string[],
        applied_buffs_descriptions: string[],
        applied_debuffs_descriptions: string[],
        applied_effects_powers: number[],
        applied_buffs_powers: number[],
        applied_debuffs_powers: number[],
        aura_effects: string[],
        aura_ranges: number[],
        aura_is_buff: boolean[],
        amount_alive: number,
        amount_died: number,
        team: TeamType,
        unit_type: UnitType,
        small_texture_name: string,
        large_texture_name: string,
        stack_power: number,
    ) {
        this.id = uuidv4();
        this.faction = faction;
        this.name = name;
        this.hp = max_hp;
        this.max_hp = max_hp;
        this.steps = steps;
        this.steps_morale = 0;
        this.morale = morale;
        this.luck = luck;
        this.speed = speed;
        this.armor_mod = 0;
        this.base_armor = base_armor;
        this.range_armor = base_armor;
        this.attack_type = attack_type;
        this.attack_type_selected = attack_type;
        this.base_attack = base_attack;
        this.attack_mod = 0;
        this.attack_damage_min = attack_damage_min;
        this.attack_damage_max = attack_damage_max;
        this.attack_range = attack_range;
        this.range_shots = range_shots;
        this.range_shots_mod = 0;
        this.shot_distance = shot_distance;
        this.magic_resist = magic_resist;
        this.magic_resist_mod = 0;
        this.can_cast_spells = spells.length > 0;
        this.can_fly = can_fly;
        this.exp = exp;
        this.size = size;
        this.level = level;
        this.spells = spells;
        this.abilities = abilities;
        this.abilities_descriptions = abilities_descriptions;
        this.abilities_stack_powered = abilities_stack_powered;
        this.abilities_auras = abilities_auras;
        this.applied_effects = applied_effects;
        this.applied_buffs = applied_buffs;
        this.applied_debuffs = applied_debuffs;
        this.applied_effects_laps = applied_effects_laps;
        this.applied_buffs_laps = applied_buffs_laps;
        this.applied_debuffs_laps = applied_debuffs_laps;
        this.applied_effects_descriptions = applied_effects_descriptions;
        this.applied_buffs_descriptions = applied_buffs_descriptions;
        this.applied_debuffs_descriptions = applied_debuffs_descriptions;
        this.applied_effects_powers = applied_effects_powers;
        this.applied_buffs_powers = applied_buffs_powers;
        this.applied_debuffs_powers = applied_debuffs_powers;
        this.aura_effects = aura_effects;
        this.aura_ranges = aura_ranges;
        this.aura_is_buff = aura_is_buff;
        this.luck_per_turn = 0;
        this.attack_multiplier = 1;
        this.amount_alive = amount_alive;
        this.amount_died = amount_died;
        this.team = team;
        this.unit_type = unit_type;
        this.small_texture_name = small_texture_name;
        this.large_texture_name = large_texture_name;
        this.stack_power = stack_power;
    }
}
