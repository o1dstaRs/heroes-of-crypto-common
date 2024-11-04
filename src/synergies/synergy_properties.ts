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
    "Might:2:1": [4],
    "Might:1:2": [2],
    "Might:2:2": [7],
    "Might:1:3": [3],
    "Might:2:3": [11],
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
