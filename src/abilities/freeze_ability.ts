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

import type { Ability } from "./ability";
import { AbilityType } from "./ability_properties";
import * as HoCLib from "../utils/lib";
import type { ISceneLog } from "../scene/scene_log_interface";
import { Unit } from "../units/unit";
import { FightStateManager } from "../fights/fight_state_manager";

/**
 * The Crafted frozen-weapon ability that grants freeze-on-attack: "Crafted Frozen Bow" for ranged units,
 * "Crafted Frozen Sword" for melee. Both apply the same "Freeze" effect; either name resolves here so the
 * processor is a drop-in mirror of processStunAbility.
 */
function getFrozenWeaponAbility(fromUnit: Unit): Ability | undefined {
    return fromUnit.getAbility("Crafted Frozen Bow") ?? fromUnit.getAbility("Crafted Frozen Sword");
}

/** Engine-identical marginal chance that an attack applies Freeze to `targetUnit`. */
export function calculateFreezeApplyChance(fromUnit: Unit, targetUnit: Unit, additionalAbilityPower: number): number {
    const freezeAbility = getFrozenWeaponAbility(fromUnit);
    if (!freezeAbility) {
        return 0;
    }
    const amplifier =
        freezeAbility.getType() === AbilityType.STATUS && targetUnit.hasAbilityActive("Mechanism") ? 1.5 : 1;
    return Math.max(
        0,
        Math.min(
            100,
            fromUnit.calculateAbilityApplyChance(freezeAbility, additionalAbilityPower) *
                amplifier *
                (1 - targetUnit.getStatusResist() / 100),
        ),
    );
}

/**
 * Rolls the Crafted frozen-weapon's freeze on a single hit against `targetUnit` and, on success, applies the
 * 2-turn Freeze effect. Called once per target (independent roll), so AoE attacks can freeze several enemies.
 * Mirrors processStunAbility exactly, including the dedupe guard and the extend()-when-active-unit fix.
 */
export function processFreezeAbility(
    fromUnit: Unit,
    targetUnit: Unit,
    currentActiveUnit: Unit,
    sceneLog: ISceneLog,
): void {
    if (targetUnit.isDead()) {
        return;
    }

    const freezeAbility = getFrozenWeaponAbility(fromUnit);
    if (!freezeAbility) {
        return;
    }

    const chance = calculateFreezeApplyChance(
        fromUnit,
        targetUnit,
        FightStateManager.getInstance().getFightProperties().getAdditionalAbilityPowerPerTeam(fromUnit.getTeam()),
    );
    if (HoCLib.getRandomInt(0, 100) < chance) {
        const freezeEffect = freezeAbility.getEffect();
        if (!freezeEffect) {
            return;
        }

        if (targetUnit.hasEffectActive(freezeEffect.getName())) {
            return;
        }

        const laps = freezeEffect.getLaps();

        if (targetUnit.getId() === currentActiveUnit.getId()) {
            freezeEffect.extend();
        }

        if (targetUnit.applyEffect(freezeEffect)) {
            sceneLog.updateLog(`${targetUnit.getName()} got frozen for ${HoCLib.getLapString(laps)}`);
        }
    }
}
