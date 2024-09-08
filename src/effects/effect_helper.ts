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

import { AbilityPowerType } from "../abilities/ability_properties";
import { AttackType } from "../units/unit_properties";
import { AuraEffectProperties } from "./effect_properties";

export function canApplyAuraEffect(unitAttackType: AttackType, auraEffectProperties: AuraEffectProperties): boolean {
    if (
        auraEffectProperties.power_type === AbilityPowerType.LUCK_10 ||
        auraEffectProperties.power_type === AbilityPowerType.ABSORB_DEBUFF ||
        auraEffectProperties.power_type === AbilityPowerType.ADDITIONAL_RANGE_ARMOR_PERCENTAGE ||
        auraEffectProperties.power_type === AbilityPowerType.ADDITIONAL_BASE_ATTACK_AND_ARMOR ||
        auraEffectProperties.power_type === AbilityPowerType.ADDITIONAL_STEPS
    ) {
        return true;
    }

    if (
        unitAttackType === AttackType.RANGE &&
        auraEffectProperties.power_type === AbilityPowerType.DISABLE_RANGE_ATTACK
    ) {
        return true;
    }

    if (
        unitAttackType === AttackType.MELEE &&
        auraEffectProperties.power_type === AbilityPowerType.ADDITIONAL_MELEE_DAMAGE_PERCENTAGE
    ) {
        return true;
    }

    return false;
}
