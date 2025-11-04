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
import { Unit } from "../units/unit";
import { ISceneLog } from "../scene/scene_log_interface";
import { FightStateManager } from "../fights/fight_state_manager";

export function processBlindnessAbility(
    fromUnit: Unit,
    targetUnit: Unit,
    currentActiveUnit: Unit,
    sceneLog: ISceneLog,
): void {
    if (targetUnit.isDead()) {
        return;
    }

    const blindnessAbility = fromUnit.getAbility("Blindness");
    if (
        blindnessAbility &&
        HoCLib.getRandomInt(0, 100) <
            fromUnit.calculateAbilityApplyChance(
                blindnessAbility,
                FightStateManager.getInstance()
                    .getFightProperties()
                    .getAdditionalAbilityPowerPerTeam(fromUnit.getTeam()),
            )
    ) {
        const blindnessEffect = blindnessAbility.getEffect();
        if (!blindnessEffect) {
            return;
        }

        if (targetUnit.hasEffectActive(blindnessEffect.getName())) {
            return;
        }

        const laps = blindnessEffect.getLaps();

        if (targetUnit.getId() === currentActiveUnit.getId()) {
            blindnessEffect.extend();
        }

        if (
            !(blindnessAbility.getType() === AbilityType.MIND && targetUnit.hasMindAttackResistance()) &&
            targetUnit.applyEffect(blindnessEffect)
        ) {
            sceneLog.updateLog(`${targetUnit.getName()} is blind for ${HoCLib.getLapString(laps)}`);
        } else {
            sceneLog.updateLog(`${targetUnit.getName()} resisted from blindness effect`);
        }
    }
}
