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

import { PBTypes } from "../generated/protobuf/v1/types";
import { normalizeFootprintSide } from "../grid/grid_math";
import type { TeamType, UnitType, AttackType, MovementType, FactionType } from "../generated/protobuf/v1/types_gen";
import {
    CreatureLevels as GenCreatureLevels,
    CreatureByLevel as GenCreatureByLevel,
    CreatureFactions as GenCreatureFactions, // if you generated it
} from "../generated/protobuf/v1/creature_gen";
import { createSecureUuid } from "../utils/lib";

export type { TeamType, UnitType, AttackType, MovementType, FactionType };

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
    public initiative: number;
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
    /**
     * Extra ranged shots this unit has ALREADY been handed by a Rallying Volley Aura (Zena). The grant is
     * one-off: standing in the aura tops the quiver up once, and firing those shots spends them for good —
     * stepping out and back in, or a second Zena, tops up nothing (the aura does not stack).
     */
    public rallying_volley_granted: number;
    public shot_distance: number;
    public magic_resist: number;
    public magic_resist_mod: number;
    public can_cast_spells: boolean;
    public movement_type: MovementType;
    public exp: number;
    /** The creature's legacy SQUARE size (1 or 2). Picks the texture; never read as board geometry. */
    public readonly size: number;
    /**
     * The board footprint, in cells: `footprint_width` across x, `footprint_height` up y, anchored on the
     * unit's top-right cell. Defaults to the square `size x size`, which is what makes every shipped 1x1
     * and 2x2 creature an instance of the same rule. Kept as its own pair of fields rather than derived
     * from `size` so a rectangle can differ from the square size the texture and the card still use — and
     * so both sides survive every structuredClone of these properties (snapshots, stack splits, rollouts).
     */
    public readonly footprint_width: number;
    public readonly footprint_height: number;
    public readonly level: number;
    public readonly spells: string[];
    /** True once `spells` is a runtime/snapshot charge list rather than raw creature configuration. */
    public spell_entries_authoritative?: boolean;
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
    /**
     * How many times each applied effect has stacked (index-parallel to applied_effects). Only stacking
     * effects (Poison) go above 1. Deliberately NOT a constructor argument: every unit starts with no
     * applied effects, so an empty default keeps the two positional call sites untouched.
     */
    public applied_effects_stacks: number[];
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
    /**
     * The exact inverse of `target`: the id of an enemy this unit may NOT attack or retaliate against, while
     * every other enemy stays fair game. Written by Terrifying Gaze (Manticore) and cleared in adjustBaseStats
     * as soon as the effect of the same name expires — mirroring how Aggr owns `target`. Like `target`, this is
     * local turn state. Ranked snapshots carry it explicitly alongside the replicated "Terrifying Gaze"
     * status because the status name alone cannot identify which of several Manticores is the forbidden one.
     */
    public forbidden_target: string;
    /** Abilities that remain visible on the card but were permanently disabled by Predatory Assimilation. */
    public stolen_abilities: string[];
    /**
     * Abilities handed to this unit by the CURRENTLY equipped artifact (the Wounding Charm's Deep Wounds
     * card, for instance) — never a card the creature owns natively. applyArtifacts revokes exactly this
     * list before it re-applies, so swapping to another artifact in the same tier takes the old ability
     * away with it. Recording only what was granted is what keeps a Wolf's native Deep Wounds Level 1
     * from being stripped when the charm comes off. Lazily created, like stolen_abilities.
     */
    public artifact_granted_abilities?: string[];
    /** Turn-start snapshot. A flyer may cross/land in Web this turn and is locked only on its next activation. */
    public web_movement_locked: boolean;
    // When set, luck is supplied authoritatively (e.g. the ranked server's per-turn roll + auras) and
    // adjustBaseStats must NOT recompute/re-randomize it — the client would otherwise roll its own
    // luck spread that diverges from the server. Left undefined for locally-simulated units (sandbox),
    // which compute luck themselves.
    public luck_authoritative?: boolean;
    // The armor/attack twins of luck_authoritative, for the SAME reason turned inside out: adjustBaseStats
    // derives armor_mod and attack_mod from the effect/buff OBJECT arrays (Shatter Armor, Spiritual Armor,
    // Riot, Weakness, Veteran Helm, Titan Plate, Angelic Host, the Runes ...), and a ranked client
    // deliberately leaves those arrays EMPTY — it seeds only the DISPLAY strings, because rebuilding the
    // objects would double-apply stats that already arrive authoritative. The consequence was that NO
    // debuff- or buff-driven stat change ever reached the ranked HUD: a unit under Shatter Armor showed its
    // full base armor while the server had -10 applied, which reads as "the effect isn't working".
    //
    // The snapshot now carries the server's FINAL armor_mod / attack_mod, and these flags tell
    // adjustBaseStats to keep that number verbatim instead of re-deriving it from arrays it cannot see.
    // Both mods feed melee and ranged identically (getArmor/getRangeArmor/getAttack are base + mod), so one
    // number per stat is exact for every consumer. Left undefined for locally-simulated units (sandbox),
    // which own the whole derivation and must keep running it.
    public armor_mod_authoritative?: boolean;
    public attack_mod_authoritative?: boolean;
    // The movement twin, and the one with teeth: the ranked client computes its OWN reachable cells from
    // getSteps() (= steps + steps_mod), which adjustBaseStats derives from Quagmire / Hamstrung / Vine Throw
    // (debuffs) and Battle Roar / Swift Boots / Crown of Command / Movement Augment (buffs). With the
    // combat-applied ones absent, a slowed unit was offered its FULL range (the server then rejected the
    // move) and a Battle-Roared one was denied steps it legitimately had.
    public steps_authoritative?: boolean;
    // The max-HP twin. A ranked snapshot's max_hp is the server's FINAL cap — creature base with the
    // Pendant of Vitality / Boost Health / Unyielding Power laps already folded in. The client seeds
    // initialUnitProperties WITH that boosted number, and the ranked refresh also re-applies the artifact
    // buff objects (applyArtifacts), so re-deriving the cap in adjustBaseStats compounded the pendant a
    // second time: a 200-HP Arachna Queen showed 313 max (250 snapshot × 1.25 again) over 250 current —
    // "my army never has full HP". Left undefined for locally-simulated units (sandbox), which own the
    // whole derivation and must keep running it.
    public max_hp_authoritative?: boolean;
    // The morale twin of luck_authoritative. A ranked snapshot's morale is the server's FINAL value: base
    // + synergy + artifact deltas (Cursed Ward / Crown of Command) + every gain and loss accumulated during
    // the fight. adjustBaseStats must therefore not rebuild it from initialUnitProperties, because the
    // client seeds that base WITH the server's already-adjusted number and would subtract the artifact
    // delta a second time on every refreshUnits() — the "-18 morale from one Cursed Ward" bug. Left
    // undefined for locally-simulated units (sandbox), which own the whole computation.
    public morale_authoritative?: boolean;
    // The BASE-stat twins of armor_mod/attack_mod_authoritative, for the drifts that live in base_armor /
    // base_attack rather than the mods: Bitter Experience (+1 base armor per stack death), Made of Fire's
    // +10% boost, Unyielding Power's per-lap attack. A ranked client re-derives both bases from its local
    // creature config on every adjustBaseStats pass, so a server-side base gain was invisible in the HUD —
    // a Peasant with Bitter Experience showed its config armor forever ("the ability isn't working").
    // When set, adjustBaseStats keeps the snapshot's FINAL base value verbatim instead of re-deriving it.
    // Left undefined for locally-simulated units (sandbox), which own the whole derivation.
    public base_armor_authoritative?: boolean;
    public base_attack_authoritative?: boolean;
    public constructor(
        faction: FactionType,
        name: string,
        max_hp: number,
        steps: number,
        morale: number,
        luck: number,
        initiative: number,
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
        stolenAbilities: string[] = [],
        webMovementLocked = false,
        footprintWidth?: number,
        footprintHeight?: number,
    ) {
        this.id = createSecureUuid();
        this.faction = faction;
        this.name = name;
        this.hp = max_hp;
        this.max_hp = max_hp;
        this.steps = steps;
        this.steps_mod = 0;
        this.morale = morale;
        this.luck = luck;
        this.initiative = initiative;
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
        this.rallying_volley_granted = 0;
        this.shot_distance = shot_distance;
        this.magic_resist = magic_resist;
        this.magic_resist_mod = 0;
        this.can_cast_spells = spells.length > 0;
        this.movement_type = movement_type;
        this.exp = exp;
        this.size = size;
        this.footprint_width = normalizeFootprintSide(footprintWidth, size);
        this.footprint_height = normalizeFootprintSide(footprintHeight, size);
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
        this.applied_effects_stacks = [];
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
        this.forbidden_target = "";
        this.stolen_abilities = structuredClone(stolenAbilities);
        this.web_movement_locked = webMovementLocked;
    }
}

export type CreatureId = (typeof PBTypes.CreatureVals)[keyof typeof PBTypes.CreatureVals]; // number
export type UnitLevelId = (typeof PBTypes.UnitLevelVals)[keyof typeof PBTypes.UnitLevelVals]; // number
export type FactionId = (typeof PBTypes.FactionVals)[keyof typeof PBTypes.FactionVals]; // number

// Use the generated numeric tables directly with ergonomic aliases
export const CreatureLevelMap: Record<number, number> = GenCreatureLevels;
export const CreatureLevelList: ReadonlyArray<ReadonlyArray<number>> = GenCreatureByLevel;
// Optional factions map (if emitted)
export const CreatureFactionsMap: Record<number, number> = GenCreatureFactions ?? {};

// Helpers with typed params/returns (still numbers under the hood)
export const getCreatureLevel = (c: CreatureId): UnitLevelId =>
    (GenCreatureLevels as Record<number, UnitLevelId>)[c] ?? PBTypes.UnitLevelVals.NO_LEVEL;

export const getCreaturesByLevel = (lvl: UnitLevelId): ReadonlyArray<CreatureId> =>
    (GenCreatureByLevel as ReadonlyArray<ReadonlyArray<CreatureId>>)[lvl] ?? [];

export const CreaturePoolByLevel = [2, 2, 1, 1] as const;

export const allCreatureIds: readonly CreatureId[] = Object.keys(GenCreatureLevels)
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
    ((GenCreatureFactions as Record<number, FactionType>)[c] ?? PBTypes.FactionVals.MIGHT) as FactionType;

export const getLevelOf = (c: CreatureId): UnitLevelId =>
    (GenCreatureLevels as Record<number, UnitLevelId>)[c] ?? PBTypes.UnitLevelVals.NO_LEVEL;

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

const _levelsByFaction = {} as Record<UnitLevelId, Record<FactionType, number>>;

for (let lvl = PBTypes.UnitLevelVals.FIRST; lvl <= PBTypes.UnitLevelVals.FOURTH; lvl++) {
    const levelId = lvl as UnitLevelId;
    const atLevel = getCreaturesByLevel(levelId);
    const counts = Object.fromEntries(allFactions.map((f) => [f, 0])) as Record<FactionType, number>;

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
