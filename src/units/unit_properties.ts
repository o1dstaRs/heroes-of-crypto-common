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

import { FactionType } from "../factions/faction_type";
import { Creature } from "../generated/protobuf/v1/types_pb";

export enum AttackType {
    NO_TYPE = 0,
    MELEE = 1,
    RANGE = 2,
    MAGIC = 3,
    MELEE_MAGIC = 4,
}

export const ToAttackType: { [attackTypeName: string]: AttackType } = {
    "": AttackType.NO_TYPE,
    NO_TYPE: AttackType.NO_TYPE,
    MELEE: AttackType.MELEE,
    RANGE: AttackType.RANGE,
    MAGIC: AttackType.MAGIC,
    MELEE_MAGIC: AttackType.MELEE_MAGIC,
};

export enum MovementType {
    NO_TYPE = 0,
    WALK = 1,
    FLY = 2,
    TELEPORT = 3,
}

export const ToMovementType: { [movementTypeName: string]: MovementType } = {
    "": MovementType.NO_TYPE,
    NO_TYPE: MovementType.NO_TYPE,
    WALK: MovementType.WALK,
    FLY: MovementType.FLY,
    TELEPORT: MovementType.TELEPORT,
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
    morale: number;
}

export class UnitProperties {
    public readonly id: string;

    public readonly faction: FactionType;

    public readonly name: string;

    public readonly team: TeamType;

    public readonly unit_type: UnitType;

    public max_hp: number;

    public hp: number;

    public steps: number;

    public steps_mod: number;

    public morale: number;

    public luck: number;

    public speed: number;

    public armor_mod: number;

    public base_armor: number;

    public range_armor: number;

    public readonly attack_type: AttackType;

    public attack_type_selected: AttackType;

    public base_attack: number;

    public attack_mod: number;

    public attack_damage_min: number;

    public attack_damage_max: number;

    public readonly attack_range: number;

    public range_shots: number;

    public range_shots_mod: number;

    public shot_distance: number;

    public magic_resist: number;

    public magic_resist_mod: number;

    public can_cast_spells: boolean;

    public movement_type: MovementType;

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

    public synergies: string[];

    public amount_alive: number;

    public amount_died: number;

    public luck_mod: number;

    public attack_multiplier: number;

    public small_texture_name: string;

    public large_texture_name: string;

    public stack_power: number;

    public target: string;

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
        movement_type: MovementType,
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
        synergies: string[],
        amount_alive: number,
        amount_died: number,
        team: TeamType,
        unit_type: UnitType,
        small_texture_name: string,
        large_texture_name: string,
        stack_power: number,
        target: string,
    ) {
        this.id = uuidv4();
        this.faction = faction;
        this.name = name;
        this.hp = max_hp;
        this.max_hp = max_hp;
        this.steps = steps;
        this.steps_mod = 0;
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
        this.movement_type = movement_type;
        this.exp = exp;
        this.size = size;
        this.level = level;
        this.spells = structuredClone(spells);
        this.abilities = structuredClone(abilities);
        this.abilities_descriptions = structuredClone(abilities_descriptions);
        this.abilities_stack_powered = structuredClone(abilities_stack_powered);
        this.abilities_auras = structuredClone(abilities_auras);
        this.applied_effects = structuredClone(applied_effects);
        this.applied_buffs = structuredClone(applied_buffs);
        this.applied_debuffs = structuredClone(applied_debuffs);
        this.applied_effects_laps = structuredClone(applied_effects_laps);
        this.applied_buffs_laps = structuredClone(applied_buffs_laps);
        this.applied_debuffs_laps = structuredClone(applied_debuffs_laps);
        this.applied_effects_descriptions = structuredClone(applied_effects_descriptions);
        this.applied_buffs_descriptions = structuredClone(applied_buffs_descriptions);
        this.applied_debuffs_descriptions = structuredClone(applied_debuffs_descriptions);
        this.applied_effects_powers = structuredClone(applied_effects_powers);
        this.applied_buffs_powers = structuredClone(applied_buffs_powers);
        this.applied_debuffs_powers = structuredClone(applied_debuffs_powers);
        this.aura_effects = structuredClone(aura_effects);
        this.aura_ranges = structuredClone(aura_ranges);
        this.aura_is_buff = structuredClone(aura_is_buff);
        this.synergies = structuredClone(synergies);
        this.luck_mod = 0;
        this.attack_multiplier = 1;
        this.amount_alive = amount_alive;
        this.amount_died = amount_died;
        this.team = team;
        this.unit_type = unit_type;
        this.small_texture_name = small_texture_name;
        this.large_texture_name = large_texture_name;
        this.stack_power = stack_power;
        this.target = target;
    }
}

export const CreatureByLevel = [
    [
        Creature.ORC,
        Creature.SCAVENGER,
        Creature.TROGLODYTE,
        Creature.CENTAUR,
        Creature.BERSERKER,
        Creature.WOLF_RIDER,
        Creature.WOLF,
        Creature.FAIRY,
        Creature.LEPRECHAUN,
        Creature.PEASANT,
        Creature.SQUIRE,
        Creature.ARBALESTER,
    ],
    [
        Creature.TROLL,
        Creature.MEDUSA,
        Creature.BEHOLDER,
        Creature.HARPY,
        Creature.NOMAD,
        Creature.HYENA,
        Creature.ELF,
        Creature.WHITE_TIGER,
        Creature.SATYR,
        Creature.VALKYRIE,
        Creature.PIKEMAN,
        Creature.HEALER,
    ],
    [
        Creature.GOBLIN_KNIGHT,
        Creature.EFREET,
        Creature.CYCLOPS,
        Creature.OGRE_MAGE,
        Creature.MANTIS,
        Creature.UNICORN,
        Creature.GRIFFIN,
        Creature.CRUSADER,
    ],
    [
        Creature.BLACK_DRAGON,
        Creature.HYDRA,
        Creature.THUNDERBIRD,
        Creature.BEHEMOTH,
        Creature.GARGANTUAN,
        Creature.PEGASUS,
        Creature.TSAR_CANNON,
        Creature.ANGEL,
    ],
] as const;

export const CreatureLevels = {
    [Creature.ORC]: 1,
    [Creature.SCAVENGER]: 1,
    [Creature.TROGLODYTE]: 1,
    [Creature.CENTAUR]: 1,
    [Creature.BERSERKER]: 1,
    [Creature.WOLF_RIDER]: 1,
    [Creature.WOLF]: 1,
    [Creature.FAIRY]: 1,
    [Creature.LEPRECHAUN]: 1,
    [Creature.PEASANT]: 1,
    [Creature.SQUIRE]: 1,
    [Creature.ARBALESTER]: 1,
    [Creature.TROLL]: 2,
    [Creature.MEDUSA]: 2,
    [Creature.BEHOLDER]: 2,
    [Creature.HARPY]: 2,
    [Creature.NOMAD]: 2,
    [Creature.HYENA]: 2,
    [Creature.ELF]: 2,
    [Creature.WHITE_TIGER]: 2,
    [Creature.SATYR]: 2,
    [Creature.VALKYRIE]: 2,
    [Creature.PIKEMAN]: 2,
    [Creature.HEALER]: 2,
    [Creature.GOBLIN_KNIGHT]: 3,
    [Creature.EFREET]: 3,
    [Creature.CYCLOPS]: 3,
    [Creature.OGRE_MAGE]: 3,
    [Creature.MANTIS]: 3,
    [Creature.UNICORN]: 3,
    [Creature.GRIFFIN]: 3,
    [Creature.CRUSADER]: 3,
    [Creature.BLACK_DRAGON]: 4,
    [Creature.HYDRA]: 4,
    [Creature.THUNDERBIRD]: 4,
    [Creature.BEHEMOTH]: 4,
    [Creature.GARGANTUAN]: 4,
    [Creature.PEGASUS]: 4,
    [Creature.TSAR_CANNON]: 4,
    [Creature.ANGEL]: 4,
};

export const CreaturePoolByLevel = [2, 2, 1, 1] as const;
