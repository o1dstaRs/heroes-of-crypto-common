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

export enum LifeSynergy {
    NO_SYNERGY = 0,
    PLUS_SUPPLY_PERCENTAGE = 1,
    PLUS_MORALE = 2,
}

export const LifeSynergyNames = {
    NO_SYNERGY: "NO_SYNERGY",
    PLUS_SUPPLY_PERCENTAGE: "PLUS_SUPPLY_PERCENTAGE",
    PLUS_MORALE: "PLUS_MORALE",
} as const;

export const ToLifeSynergy: { [synergyName: string]: LifeSynergy } = {
    "": LifeSynergy.NO_SYNERGY,
    NO_SYNERGY: LifeSynergy.NO_SYNERGY,
    PLUS_SUPPLY_PERCENTAGE: LifeSynergy.PLUS_SUPPLY_PERCENTAGE,
    PLUS_MORALE: LifeSynergy.PLUS_MORALE,
};

export type LifeSynergyNamesType = keyof typeof LifeSynergyNames;

export function getLifeSynergyByName(name: LifeSynergyNamesType): LifeSynergy {
    return LifeSynergy[name];
}

export enum ChaosSynergy {
    NO_SYNERGY = 0,
    SLOW_ON_SHOT = 1,
    BREAK_ON_ATTACK = 2,
}

export const ChaosSynergyNames = {
    NO_SYNERGY: "NO_SYNERGY",
    SLOW_ON_SHOT: "SLOW_ON_SHOT",
    BREAK_ON_ATTACK: "BREAK_ON_ATTACK",
} as const;

export const ToChaosSynergy: { [synergyName: string]: ChaosSynergy } = {
    "": ChaosSynergy.NO_SYNERGY,
    NO_SYNERGY: ChaosSynergy.NO_SYNERGY,
    SLOW_ON_SHOT: ChaosSynergy.SLOW_ON_SHOT,
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
};

export const UNITS_TO_SYNERGY_LEVEL: { [key: number]: SynergyLevel } = {
    2: SynergyLevel.LEVEL_1,
    4: SynergyLevel.LEVEL_2,
    6: SynergyLevel.LEVEL_3,
};
