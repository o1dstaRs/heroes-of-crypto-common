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

export enum AbilityPowerType {
    NO_TYPE = 0,
    TOTAL_DAMAGE_PERCENTAGE = 1,
    ADDITIONAL_DAMAGE_PERCENTAGE = 2,
    UNLIMITED_RESPONSES = 3,
    UNLIMITED_SUPPLIES = 4,
    UNLIMITED_RANGE = 5,
    MAGIC_RESIST_100 = 6,
    LIGHTNING_SPIN_ATTACK = 7,
    FIRE_BREATH = 8,
    APPLY_EFFECT = 9,
}

export const AllAbilityPowerTypes = [
    AbilityPowerType.NO_TYPE,
    AbilityPowerType.TOTAL_DAMAGE_PERCENTAGE,
    AbilityPowerType.ADDITIONAL_DAMAGE_PERCENTAGE,
    AbilityPowerType.UNLIMITED_RESPONSES,
    AbilityPowerType.UNLIMITED_SUPPLIES,
    AbilityPowerType.UNLIMITED_RANGE,
    AbilityPowerType.MAGIC_RESIST_100,
    AbilityPowerType.LIGHTNING_SPIN_ATTACK,
    AbilityPowerType.FIRE_BREATH,
    AbilityPowerType.APPLY_EFFECT,
];

export type AllAbilityPowerType = typeof AllAbilityPowerTypes[number];

export const ToAbilityPowerType: { [abilityPowerTypeName: string]: AbilityPowerType } = {
    "": AbilityPowerType.NO_TYPE,
    NO_TYPE: AbilityPowerType.NO_TYPE,
    TOTAL_DAMAGE_PERCENTAGE: AbilityPowerType.TOTAL_DAMAGE_PERCENTAGE,
    ADDITIONAL_DAMAGE_PERCENTAGE: AbilityPowerType.ADDITIONAL_DAMAGE_PERCENTAGE,
    UNLIMITED_RESPONSES: AbilityPowerType.UNLIMITED_RESPONSES,
    UNLIMITED_SUPPLIES: AbilityPowerType.UNLIMITED_SUPPLIES,
    UNLIMITED_RANGE: AbilityPowerType.UNLIMITED_RANGE,
    MAGIC_RESIST_100: AbilityPowerType.MAGIC_RESIST_100,
    LIGHTNING_SPIN_ATTACK: AbilityPowerType.LIGHTNING_SPIN_ATTACK,
    FIRE_BREATH: AbilityPowerType.FIRE_BREATH,
    APPLY_EFFECT: AbilityPowerType.APPLY_EFFECT,
};

export enum AbilityType {
    NO_TYPE = 0,
    ATTACK = 1,
    ADDITIONAL_ATTACK = 2,
    RESPOND = 3,
    SUPPLIES = 4,
    DEFENCE = 5,
    REFLECT = 6,
    STATUS = 7,
    HEAL = 8,
    UNIT_TYPE = 9,
}

export const AllAbilityTypes = [
    AbilityType.NO_TYPE,
    AbilityType.ATTACK,
    AbilityType.ADDITIONAL_ATTACK,
    AbilityType.RESPOND,
    AbilityType.SUPPLIES,
    AbilityType.DEFENCE,
    AbilityType.REFLECT,
    AbilityType.STATUS,
    AbilityType.HEAL,
    AbilityType.UNIT_TYPE,
];

export type AllAbilityType = typeof AllAbilityTypes[number];

export const ToAbilityType: { [abilityTypeName: string]: AbilityType } = {
    "": AbilityType.NO_TYPE,
    NO_TYPE: AbilityType.NO_TYPE,
    ATTACK: AbilityType.ATTACK,
    ADDITIONAL_ATTACK: AbilityType.ADDITIONAL_ATTACK,
    RESPOND: AbilityType.RESPOND,
    SUPPLIES: AbilityType.SUPPLIES,
    DEFENCE: AbilityType.DEFENCE,
    REFLECT: AbilityType.REFLECT,
    STATUS: AbilityType.STATUS,
    HEAL: AbilityType.HEAL,
    UNIT_TYPE: AbilityType.UNIT_TYPE,
};

export class AbilityProperties {
    public readonly name: string;

    public readonly type: AbilityType;

    public readonly desc: string;

    public readonly power: number;

    public readonly power_type: AbilityPowerType;

    public readonly skip_response: boolean;

    public readonly effect: string | null;

    public constructor(
        name: string,
        type: AbilityType,
        desc: string,
        power: number,
        powerType: AbilityPowerType,
        skipResponse: boolean,
        effect: string | null,
    ) {
        this.name = name;
        this.type = type;
        this.desc = desc;
        this.power = power;
        this.power_type = powerType;
        this.skip_response = skipResponse;
        this.effect = effect;
    }
}
