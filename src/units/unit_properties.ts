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

import { PBTypes } from "../generated/protobuf/v1/types";
import type { TeamType, UnitType, AttackType, MovementType, FactionType } from "../generated/protobuf/v1/types_gen";
import {
    CreatureLevels as GenCreatureLevels,
    CreatureByLevel as GenCreatureByLevel,
    CreatureFactions as GenCreatureFactions, // if you generated it
} from "../generated/protobuf/v1/creature_gen";

export const ToAttackType: { [attackTypeName: string]: AttackType } = {
    "": PBTypes.AttackVals.NO_ATTACK,
    NO_ATTACK: PBTypes.AttackVals.NO_ATTACK,
    MELEE: PBTypes.AttackVals.MELEE,
    RANGE: PBTypes.AttackVals.RANGE,
    MAGIC: PBTypes.AttackVals.MAGIC,
    MELEE_MAGIC: PBTypes.AttackVals.MELEE_MAGIC,
};

export const ToMovementType: { [movementTypeName: string]: MovementType } = {
    "": PBTypes.MovementVals.NO_MOVEMENT,
    NO_MOVEMENT: PBTypes.MovementVals.NO_MOVEMENT,
    WALK: PBTypes.MovementVals.WALK,
    FLY: PBTypes.MovementVals.FLY,
    TELEPORT: PBTypes.MovementVals.TELEPORT,
};

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

export type CreatureId = (typeof PBTypes.CreatureVals)[keyof typeof PBTypes.CreatureVals]; // number
export type UnitLevelId = (typeof PBTypes.UnitLevelVals)[keyof typeof PBTypes.UnitLevelVals]; // number
export type FactionId = (typeof PBTypes.FactionVals)[keyof typeof PBTypes.FactionVals]; // number

// Use the generated numeric tables directly with ergonomic aliases
export const CreatureLevels: Record<number, number> = GenCreatureLevels;
export const CreatureByLevel: ReadonlyArray<ReadonlyArray<number>> = GenCreatureByLevel;
// Optional factions map (if emitted)
export const CreatureFactions: Record<number, number> = GenCreatureFactions ?? {};

// Helpers with typed params/returns (still numbers under the hood)
export const getCreatureLevel = (c: CreatureId): UnitLevelId =>
    (GenCreatureLevels as Record<number, UnitLevelId>)[c] ?? PBTypes.UnitLevelVals.NO_LEVEL;

export const getCreaturesByLevel = (lvl: UnitLevelId): ReadonlyArray<CreatureId> =>
    (GenCreatureByLevel as ReadonlyArray<ReadonlyArray<CreatureId>>)[lvl] ?? [];

export const CreaturePoolByLevel = [2, 2, 1, 1] as const;

export const allCreatureIds: readonly CreatureId[] = Object.keys(CreatureLevels)
    .map((k) => Number(k) as CreatureId)
    .filter((id) => id !== (PBTypes.CreatureVals.NO_CREATURE as unknown as CreatureId));
Object.freeze(allCreatureIds);

/** All faction ids we care about (customize if you have more) */
export const allFactions: readonly FactionType[] = [
    PBTypes.FactionVals.LIFE,
    PBTypes.FactionVals.NATURE,
    PBTypes.FactionVals.CHAOS,
    PBTypes.FactionVals.MIGHT,
    PBTypes.FactionVals.DEATH,
    PBTypes.FactionVals.ORDER,
] as const;
Object.freeze(allFactions);

/** Safe accessors that return strongly typed values */
export const getFactionOf = (c: CreatureId): FactionType =>
    ((CreatureFactions as Record<number, FactionType>)[c] ?? PBTypes.FactionVals.MIGHT) as FactionType;

export const getLevelOf = (c: CreatureId): UnitLevelId =>
    (CreatureLevels as Record<number, UnitLevelId>)[c] ?? PBTypes.UnitLevelVals.NO_LEVEL;

/** Group creatures by faction, typed and readonly */
const _byFaction: Record<FactionType, CreatureId[]> = Object.fromEntries(
    allFactions.map((f) => [f, [] as CreatureId[]]),
) as Record<FactionType, CreatureId[]>;

for (const id of allCreatureIds) {
    const f = getFactionOf(id);
    // Only collect if the faction is among allFactions; drop or route to a "Neutral" if you have one.
    if (f in _byFaction) _byFaction[f].push(id);
}

/** Freeze each array and the container */
for (const f of allFactions) Object.freeze(_byFaction[f]);
export const CreaturesByFaction: Readonly<Record<FactionType, readonly CreatureId[]>> = Object.freeze(_byFaction);

/** Count of creatures per (level, faction), useful for layout math */
export type LevelsByFactionCounts = Readonly<Record<UnitLevelId, Readonly<Record<FactionType, number>>>>;

const _levelsByFaction: Record<UnitLevelId, Record<FactionType, number>> = {} as any;

for (let lvl = PBTypes.UnitLevelVals.FIRST; lvl <= PBTypes.UnitLevelVals.FOURTH; lvl++) {
    const levelId = lvl as UnitLevelId;
    const atLevel = getCreaturesByLevel(levelId);
    const counts: Record<FactionType, number> = Object.fromEntries(allFactions.map((f) => [f, 0])) as any;

    for (const cid of atLevel) {
        const f = getFactionOf(cid);
        if (f in counts) counts[f] += 1;
    }
    _levelsByFaction[levelId] = counts;
}

for (const lvl of Object.keys(_levelsByFaction).map((k) => Number(k) as UnitLevelId)) {
    Object.freeze(_levelsByFaction[lvl]);
}
export const LevelFactionCounts: LevelsByFactionCounts = Object.freeze(_levelsByFaction);

/**
 * Precomputed level buckets for UI:
 * - label: "Level N"
 * - count: max per-faction count at that level (so columns align)
 * - unitSize: your 2× icon rule for level 4
 */
export const LevelBuckets: ReadonlyArray<Readonly<{ label: string; count: number; unitSize: 1 | 2 }>> = Object.freeze(
    [
        PBTypes.UnitLevelVals.FIRST,
        PBTypes.UnitLevelVals.SECOND,
        PBTypes.UnitLevelVals.THIRD,
        PBTypes.UnitLevelVals.FOURTH,
    ].map((lvl, i) => {
        const counts = LevelFactionCounts[lvl];
        const max = Math.max(...allFactions.map((f) => counts[f] ?? 0));
        return Object.freeze({
            label: `Level ${i + 1}`,
            count: max,
            unitSize: i + 1 === 4 ? 2 : 1,
        });
    }),
);

/** Convenience: creatures of a level *and* faction, already sorted by level-stable id */
export const getCreaturesOf = (f: FactionType, lvl?: UnitLevelId): readonly CreatureId[] => {
    const ids = CreaturesByFaction[f] ?? [];
    if (lvl == null) return ids;
    return ids.filter((id) => getLevelOf(id) === lvl);
};
