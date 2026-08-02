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

import type { FactionType } from "../generated/protobuf/v1/types_gen";

export const SynergyKeysToPower: { [key: string]: number[] } = {
    "Life:1:1": [6],
    "Life:2:1": [6, 2],
    "Life:1:2": [12],
    "Life:2:2": [13, 5],
    "Life:1:3": [19],
    "Life:2:3": [20, 9],
    "Chaos:1:1": [1],
    "Chaos:2:1": [6],
    "Chaos:1:2": [2],
    "Chaos:2:2": [11],
    "Chaos:1:3": [3],
    "Chaos:2:3": [17],
    "Might:1:1": [1],
    "Might:2:1": [5],
    "Might:1:2": [2],
    "Might:2:2": [8],
    "Might:1:3": [3],
    "Might:2:3": [12],
    "Nature:1:1": [1],
    "Nature:2:1": [10],
    "Nature:1:2": [2],
    "Nature:2:2": [20],
    "Nature:1:3": [3],
    "Nature:2:3": [30],
};

export enum LifeSynergy {
    NO_SYNERGY = 0,
    PLUS_SUPPLY_PERCENTAGE = 1,
    PLUS_MORALE_AND_LUCK = 2,
}

export const LifeSynergyNames = {
    NO_SYNERGY: "NO_SYNERGY",
    PLUS_SUPPLY_PERCENTAGE: "PLUS_SUPPLY_PERCENTAGE",
    PLUS_MORALE_AND_LUCK: "PLUS_MORALE_AND_LUCK",
} as const;

export const ToLifeSynergy: { [synergyName: string]: LifeSynergy } = {
    "": LifeSynergy.NO_SYNERGY,
    NO_SYNERGY: LifeSynergy.NO_SYNERGY,
    PLUS_SUPPLY_PERCENTAGE: LifeSynergy.PLUS_SUPPLY_PERCENTAGE,
    PLUS_MORALE_AND_LUCK: LifeSynergy.PLUS_MORALE_AND_LUCK,
};

export type LifeSynergyNamesType = keyof typeof LifeSynergyNames;

export function getLifeSynergyByName(name: LifeSynergyNamesType): LifeSynergy {
    return LifeSynergy[name];
}

export enum ChaosSynergy {
    NO_SYNERGY = 0,
    MOVEMENT = 1,
    BREAK_ON_ATTACK = 2,
}

export const ChaosSynergyNames = {
    NO_SYNERGY: "NO_SYNERGY",
    MOVEMENT: "MOVEMENT",
    BREAK_ON_ATTACK: "BREAK_ON_ATTACK",
} as const;

export const ToChaosSynergy: { [synergyName: string]: ChaosSynergy } = {
    "": ChaosSynergy.NO_SYNERGY,
    NO_SYNERGY: ChaosSynergy.NO_SYNERGY,
    MOVEMENT: ChaosSynergy.MOVEMENT,
    BREAK_ON_ATTACK: ChaosSynergy.BREAK_ON_ATTACK,
};

export type ChaosSynergyNamesType = keyof typeof ChaosSynergyNames;

export function getChaosSynergyByName(name: ChaosSynergyNamesType): ChaosSynergy {
    return ChaosSynergy[name];
}

export enum MightSynergy {
    NO_SYNERGY = 0,
    PLUS_AURAS_RANGE = 1,
    PLUS_STACK_ABILITIES_POWER = 2,
}

export const MightSynergyNames = {
    NO_SYNERGY: "NO_SYNERGY",
    PLUS_AURAS_RANGE: "PLUS_AURAS_RANGE",
    PLUS_STACK_ABILITIES_POWER: "PLUS_STACK_ABILITIES_POWER",
} as const;

export const ToMightSynergy: { [synergyName: string]: MightSynergy } = {
    "": MightSynergy.NO_SYNERGY,
    NO_SYNERGY: MightSynergy.NO_SYNERGY,
    PLUS_AURAS_RANGE: MightSynergy.PLUS_AURAS_RANGE,
    PLUS_STACK_ABILITIES_POWER: MightSynergy.PLUS_STACK_ABILITIES_POWER,
};

export type MightSynergyNamesType = keyof typeof MightSynergyNames;

export function getMightSynergyByName(name: MightSynergyNamesType): MightSynergy {
    return MightSynergy[name];
}

export enum NatureSynergy {
    NO_SYNERGY = 0,
    INCREASE_BOARD_UNITS = 1,
    PLUS_FLY_ARMOR = 2,
}

export const NatureSynergyNames = {
    NO_SYNERGY: "NO_SYNERGY",
    INCREASE_BOARD_UNITS: "INCREASE_BOARD_UNITS",
    PLUS_FLY_ARMOR: "PLUS_FLY_ARMOR",
} as const;

export const ToNatureSynergy: { [synergyName: string]: NatureSynergy } = {
    "": NatureSynergy.NO_SYNERGY,
    NO_SYNERGY: NatureSynergy.NO_SYNERGY,
    INCREASE_BOARD_UNITS: NatureSynergy.INCREASE_BOARD_UNITS,
    PLUS_FLY_ARMOR: NatureSynergy.PLUS_FLY_ARMOR,
};

export function getNatureSynergyByName(name: NatureSynergyNamesType): NatureSynergy {
    return NatureSynergy[name];
}

export type NatureSynergyNamesType = keyof typeof NatureSynergyNames;

export type SpecificSynergy = LifeSynergy | ChaosSynergy | MightSynergy | NatureSynergy;

/**
 * The two synergies each faction can field. A match uses exactly ONE of each pair — there is no in-game
 * choice any more: the variant is drawn per game (see synergyVariantsForSeed) and then levels itself from
 * the drafted army, so both players see the same four synergies from the first pick of the draft.
 */
export const FACTION_SYNERGY_PAIRS: { [factionName: string]: [SpecificSynergy, SpecificSynergy] } = {
    Life: [LifeSynergy.PLUS_SUPPLY_PERCENTAGE, LifeSynergy.PLUS_MORALE_AND_LUCK],
    Nature: [NatureSynergy.INCREASE_BOARD_UNITS, NatureSynergy.PLUS_FLY_ARMOR],
    Chaos: [ChaosSynergy.MOVEMENT, ChaosSynergy.BREAK_ON_ATTACK],
    Might: [MightSynergy.PLUS_AURAS_RANGE, MightSynergy.PLUS_STACK_ABILITIES_POWER],
};

/** Faction order the variants are drawn in — also the order the draft rails show them. */
export const SYNERGY_FACTION_ORDER = ["Life", "Nature", "Chaos", "Might"] as const;

/**
 * Which variant of each pair this match fields, derived from the game id alone.
 *
 * Deterministic on purpose: the server, both clients and every replay hash the SAME id and land on the
 * same four synergies without a single extra wire field, so the draft can show them before any unit is
 * picked and nothing can drift between the seats.
 */
export const synergyVariantsForSeed = (seed: string): { [factionName: string]: SpecificSynergy } => {
    // FNV-1a: tiny, stable across runtimes, and well spread over short ids.
    let hash = 0x811c9dc5;
    for (let i = 0; i < seed.length; i++) {
        hash ^= seed.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    const variants: { [factionName: string]: SpecificSynergy } = {};
    SYNERGY_FACTION_ORDER.forEach((faction, index) => {
        const pair = FACTION_SYNERGY_PAIRS[faction];
        variants[faction] = pair[(hash >>> (index * 3)) & 1];
    });
    return variants;
};

/** The variants a fight falls back to when no seed was supplied (sandbox, unit tests, legacy saves). */
export const DEFAULT_SYNERGY_VARIANTS: { [factionName: string]: SpecificSynergy } = {
    Life: LifeSynergy.PLUS_SUPPLY_PERCENTAGE,
    Nature: NatureSynergy.PLUS_FLY_ARMOR,
    Chaos: ChaosSynergy.MOVEMENT,
    Might: MightSynergy.PLUS_AURAS_RANGE,
};

export enum SynergyLevel {
    NO_SYNERGY = 0,
    LEVEL_1 = 1,
    LEVEL_2 = 2,
    LEVEL_3 = 3,
}

export type SynergyWithLevel = {
    synergy: string;
    level: SynergyLevel;
    faction: FactionType;
};

export const UNITS_TO_SYNERGY_LEVEL: { [key: number]: SynergyLevel } = {
    0: SynergyLevel.NO_SYNERGY,
    2: SynergyLevel.LEVEL_1,
    4: SynergyLevel.LEVEL_2,
    6: SynergyLevel.LEVEL_3,
};
