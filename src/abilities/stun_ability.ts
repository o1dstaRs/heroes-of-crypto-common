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

import { AbilityType } from "./ability_properties";
import * as HoCLib from "../utils/lib";
import type { ISceneLog } from "../scene/scene_log_interface";
import { Unit } from "../units/unit";
import { FightStateManager } from "../fights/fight_state_manager";

/** Engine-identical marginal chance that an attack applies Stun to `targetUnit`. */
export function calculateStunApplyChance(fromUnit: Unit, targetUnit: Unit, additionalAbilityPower: number): number {
    const stunAbility = fromUnit.getAbility("Stun");
    if (!stunAbility) {
        return 0;
    }
    const amplifier =
        stunAbility.getType() === AbilityType.STATUS && targetUnit.hasAbilityActive("Mechanism") ? 1.5 : 1;
    return Math.max(
        0,
        Math.min(
            100,
            fromUnit.calculateAbilityApplyChance(stunAbility, additionalAbilityPower) *
                amplifier *
                (1 - targetUnit.getStatusResist() / 100),
        ),
    );
}

export function processStunAbility(
    fromUnit: Unit,
    targetUnit: Unit,
    currentActiveUnit: Unit,
    sceneLog: ISceneLog,
): void {
    if (targetUnit.isDead()) {
        return;
    }

    const stunAbility = fromUnit.getAbility("Stun");

    if (!stunAbility) {
        return;
    }

    const chance = calculateStunApplyChance(
        fromUnit,
        targetUnit,
        FightStateManager.getInstance().getFightProperties().getAdditionalAbilityPowerPerTeam(fromUnit.getTeam()),
    );
    if (HoCLib.getRandomInt(0, 100) < chance) {
        const stunEffect = stunAbility.getEffect();
        if (!stunEffect) {
            return;
        }

        if (targetUnit.hasEffectActive(stunEffect.getName())) {
            return;
        }

        const laps = stunEffect.getLaps();

        if (targetUnit.getId() === currentActiveUnit.getId()) {
            stunEffect.extend();
        }

        if (targetUnit.applyEffect(stunEffect)) {
            sceneLog.updateLog(`${targetUnit.getName()} got stunned for ${HoCLib.getLapString(laps)}`);
        }
    }
}
