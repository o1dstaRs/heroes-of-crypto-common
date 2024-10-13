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
    ADDITIONAL_MELEE_DAMAGE_PERCENTAGE = 16,
    DISABLE_RANGE_ATTACK = 17,
    LUCK_10 = 18,
    ADDITIONAL_RANGE_ARMOR_PERCENTAGE = 19,
    BASIC_AI = 20,
    MAGIC_RESIST_50 = 21,
    DODGE_PERCENTAGE = 22,
    DODGE_LARGE_PERCENTAGE = 23,
    GAIN_ARMOR_AND_STEPS_TAKING_DAMAGE = 24,
    ABSORB_DEBUFF = 25,
    APPLY_RANDOM_DEBUFF = 26,
    KILL_RANDOM_AMOUNT = 27,
    MAGIC_RESIST_25 = 28,
    ADDITIONAL_STEPS = 29,
    SPELLBOOK = 30,
    GAIN_ATTACK_AND_HP_EACH_LAP = 31,
    ADDITIONAL_BASE_ATTACK_AND_ARMOR = 32,
    MIND_RESIST = 33,
    GAIN_ATTACK_ON_LOSSES = 34,
    STEAL_ARMOR_ON_HIT = 35,
    UNDEAD = 36,
    MECHANISM = 37,
    RESURRECTION = 38,
    STEPS_AND_ARMOR = 39,
    SWAP_WITH_OPPONENT = 40,
    MAGIC_DAMAGE = 41,
    MAGIC_VULNERABILITY_EARTH = 42,
    ADDITIONAL_STEPS_WALK = 43,
    GAIN_ATTACK_AND_ARMOR_EACH_STEP = 44,
    BOOST_ALL_STATS_PERCENTAGE = 45,
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
    AbilityPowerType.ADDITIONAL_MELEE_DAMAGE_PERCENTAGE,
    AbilityPowerType.DISABLE_RANGE_ATTACK,
    AbilityPowerType.LUCK_10,
    AbilityPowerType.ADDITIONAL_RANGE_ARMOR_PERCENTAGE,
    AbilityPowerType.BASIC_AI,
    AbilityPowerType.MAGIC_RESIST_50,
    AbilityPowerType.DODGE_PERCENTAGE,
    AbilityPowerType.DODGE_LARGE_PERCENTAGE,
    AbilityPowerType.GAIN_ARMOR_AND_STEPS_TAKING_DAMAGE,
    AbilityPowerType.ABSORB_DEBUFF,
    AbilityPowerType.APPLY_RANDOM_DEBUFF,
    AbilityPowerType.KILL_RANDOM_AMOUNT,
    AbilityPowerType.MAGIC_RESIST_25,
    AbilityPowerType.ADDITIONAL_STEPS,
    AbilityPowerType.SPELLBOOK,
    AbilityPowerType.GAIN_ATTACK_AND_HP_EACH_LAP,
    AbilityPowerType.ADDITIONAL_BASE_ATTACK_AND_ARMOR,
    AbilityPowerType.MIND_RESIST,
    AbilityPowerType.GAIN_ATTACK_ON_LOSSES,
    AbilityPowerType.STEAL_ARMOR_ON_HIT,
    AbilityPowerType.UNDEAD,
    AbilityPowerType.MECHANISM,
    AbilityPowerType.RESURRECTION,
    AbilityPowerType.STEPS_AND_ARMOR,
    AbilityPowerType.SWAP_WITH_OPPONENT,
    AbilityPowerType.MAGIC_DAMAGE,
    AbilityPowerType.MAGIC_VULNERABILITY_EARTH,
    AbilityPowerType.ADDITIONAL_STEPS_WALK,
    AbilityPowerType.GAIN_ATTACK_AND_ARMOR_EACH_STEP,
    AbilityPowerType.BOOST_ALL_STATS_PERCENTAGE,
];

export type AllAbilityPowerType = (typeof AllAbilityPowerTypes)[number];

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
    ADDITIONAL_MELEE_DAMAGE_PERCENTAGE: AbilityPowerType.ADDITIONAL_MELEE_DAMAGE_PERCENTAGE,
    DISABLE_RANGE_ATTACK: AbilityPowerType.DISABLE_RANGE_ATTACK,
    LUCK_10: AbilityPowerType.LUCK_10,
    ADDITIONAL_RANGE_ARMOR_PERCENTAGE: AbilityPowerType.ADDITIONAL_RANGE_ARMOR_PERCENTAGE,
    BASIC_AI: AbilityPowerType.BASIC_AI,
    MAGIC_RESIST_50: AbilityPowerType.MAGIC_RESIST_50,
    DODGE_PERCENTAGE: AbilityPowerType.DODGE_PERCENTAGE,
    DODGE_LARGE_PERCENTAGE: AbilityPowerType.DODGE_LARGE_PERCENTAGE,
    GAIN_ARMOR_AND_STEPS_TAKING_DAMAGE: AbilityPowerType.GAIN_ARMOR_AND_STEPS_TAKING_DAMAGE,
    ABSORB_DEBUFF: AbilityPowerType.ABSORB_DEBUFF,
    APPLY_RANDOM_DEBUFF: AbilityPowerType.APPLY_RANDOM_DEBUFF,
    KILL_RANDOM_AMOUNT: AbilityPowerType.KILL_RANDOM_AMOUNT,
    MAGIC_RESIST_25: AbilityPowerType.MAGIC_RESIST_25,
    ADDITIONAL_STEPS: AbilityPowerType.ADDITIONAL_STEPS,
    SPELLBOOK: AbilityPowerType.SPELLBOOK,
    GAIN_ATTACK_AND_HP_EACH_LAP: AbilityPowerType.GAIN_ATTACK_AND_HP_EACH_LAP,
    ADDITIONAL_BASE_ATTACK_AND_ARMOR: AbilityPowerType.ADDITIONAL_BASE_ATTACK_AND_ARMOR,
    MIND_RESIST: AbilityPowerType.MIND_RESIST,
    GAIN_ATTACK_ON_LOSSES: AbilityPowerType.GAIN_ATTACK_ON_LOSSES,
    STEAL_ARMOR_ON_HIT: AbilityPowerType.STEAL_ARMOR_ON_HIT,
    UNDEAD: AbilityPowerType.UNDEAD,
    MECHANISM: AbilityPowerType.MECHANISM,
    RESURRECTION: AbilityPowerType.RESURRECTION,
    STEPS_AND_ARMOR: AbilityPowerType.STEPS_AND_ARMOR,
    SWAP_WITH_OPPONENT: AbilityPowerType.SWAP_WITH_OPPONENT,
    MAGIC_DAMAGE: AbilityPowerType.MAGIC_DAMAGE,
    MAGIC_VULNERABILITY_EARTH: AbilityPowerType.MAGIC_VULNERABILITY_EARTH,
    ADDITIONAL_STEPS_WALK: AbilityPowerType.ADDITIONAL_STEPS_WALK,
    GAIN_ATTACK_AND_ARMOR_EACH_STEP: AbilityPowerType.GAIN_ATTACK_AND_ARMOR_EACH_STEP,
    BOOST_ALL_STATS_PERCENTAGE: AbilityPowerType.BOOST_ALL_STATS_PERCENTAGE,
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
    BUFF_AURA = 10,
    DEBUFF_AURA = 11,
    CONTROL = 12,
    MIND = 13,
    MOVEMENT = 14,
    INFO = 15,
    EFFECT = 16,
    MASS_BUFF = 17,
    TEMP_BUFF = 18,
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
    AbilityType.BUFF_AURA,
    AbilityType.DEBUFF_AURA,
    AbilityType.CONTROL,
    AbilityType.MIND,
    AbilityType.MOVEMENT,
    AbilityType.INFO,
    AbilityType.EFFECT,
    AbilityType.MASS_BUFF,
    AbilityType.TEMP_BUFF,
];

export type AllAbilityType = (typeof AllAbilityTypes)[number];

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
    BUFF_AURA: AbilityType.BUFF_AURA,
    DEBUFF_AURA: AbilityType.DEBUFF_AURA,
    CONTROL: AbilityType.CONTROL,
    MIND: AbilityType.MIND,
    MOVEMENT: AbilityType.MOVEMENT,
    INFO: AbilityType.INFO,
    EFFECT: AbilityType.EFFECT,
    MASS_BUFF: AbilityType.MASS_BUFF,
    TEMP_BUFF: AbilityType.TEMP_BUFF,
};

export class AbilityProperties {
    public readonly name: string;

    public readonly type: AbilityType;

    public readonly desc: string[];

    public readonly power: number;

    public readonly power_type: AbilityPowerType;

    public readonly skip_response: boolean;

    public readonly stack_powered: boolean;

    public readonly effect: string | null;

    public readonly aura_effect: string | null;

    public readonly can_be_casted: boolean;

    public constructor(
        name: string,
        type: AbilityType,
        desc: string[],
        power: number,
        power_type: AbilityPowerType,
        skip_response: boolean,
        stack_powered: boolean,
        effect: string | null,
        aura_effect: string | null,
        can_be_casted: boolean,
    ) {
        this.name = name;
        this.type = type;
        this.desc = desc;
        this.power = power;
        this.power_type = power_type;
        this.skip_response = skip_response;
        this.stack_powered = stack_powered;
        this.effect = effect;
        this.aura_effect = aura_effect;
        this.can_be_casted = can_be_casted;
    }
}
