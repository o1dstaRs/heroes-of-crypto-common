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
    APPLY_EFFECT = 7,
    IGNORE_ARMOR = 8,
    PHYSICAL_RESIST_WHILE_MAGIC_VULNERABLE = 9,
    NORMAL_DAMAGE = 10,
    LIMITED_SUPPLIES = 11,
    REGENERATION = 12,
    BOOST_HEALTH = 13,
    MAGIC_VULNERABILITY_WATER = 14,
    RANGE_ARMOR_MODIFIER = 15,
}

export const AllAbilityPowerTypes = [
    AbilityPowerType.NO_TYPE,
    AbilityPowerType.TOTAL_DAMAGE_PERCENTAGE,
    AbilityPowerType.ADDITIONAL_DAMAGE_PERCENTAGE,
    AbilityPowerType.UNLIMITED_RESPONSES,
    AbilityPowerType.UNLIMITED_SUPPLIES,
    AbilityPowerType.UNLIMITED_RANGE,
    AbilityPowerType.MAGIC_RESIST_100,
    AbilityPowerType.APPLY_EFFECT,
    AbilityPowerType.IGNORE_ARMOR,
    AbilityPowerType.PHYSICAL_RESIST_WHILE_MAGIC_VULNERABLE,
    AbilityPowerType.NORMAL_DAMAGE,
    AbilityPowerType.LIMITED_SUPPLIES,
    AbilityPowerType.REGENERATION,
    AbilityPowerType.BOOST_HEALTH,
    AbilityPowerType.MAGIC_VULNERABILITY_WATER,
    AbilityPowerType.RANGE_ARMOR_MODIFIER,
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
    APPLY_EFFECT: AbilityPowerType.APPLY_EFFECT,
    IGNORE_ARMOR: AbilityPowerType.IGNORE_ARMOR,
    PHYSICAL_RESIST_WHILE_MAGIC_VULNERABLE: AbilityPowerType.PHYSICAL_RESIST_WHILE_MAGIC_VULNERABLE,
    NORMAL_DAMAGE: AbilityPowerType.NORMAL_DAMAGE,
    LIMITED_SUPPLIES: AbilityPowerType.LIMITED_SUPPLIES,
    REGENERATION: AbilityPowerType.REGENERATION,
    BOOST_HEALTH: AbilityPowerType.BOOST_HEALTH,
    MAGIC_VULNERABILITY_WATER: AbilityPowerType.MAGIC_VULNERABILITY_WATER,
    RANGE_ARMOR_MODIFIER: AbilityPowerType.RANGE_ARMOR_MODIFIER,
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

    public readonly stack_powered: boolean;

    public readonly effect: string | null;

    public constructor(
        name: string,
        type: AbilityType,
        desc: string,
        power: number,
        powerType: AbilityPowerType,
        skipResponse: boolean,
        stackPowered: boolean,
        effect: string | null,
    ) {
        this.name = name;
        this.type = type;
        this.desc = desc;
        this.power = power;
        this.power_type = powerType;
        this.skip_response = skipResponse;
        this.stack_powered = stackPowered;
        this.effect = effect;
    }
}
