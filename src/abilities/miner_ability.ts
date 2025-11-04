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

import { ISceneLog } from "../scene/scene_log_interface";
import { Unit } from "../units/unit";
import { FightStateManager } from "../fights/fight_state_manager";

export function processMinerAbility(attackerUnit: Unit, targetUnit: Unit, sceneLog: ISceneLog) {
    const minerAbility = attackerUnit.getAbility("Miner");

    if (!minerAbility || attackerUnit.isDead()) {
        return;
    }

    const armorAmount = attackerUnit.calculateAbilityCount(
        minerAbility,
        FightStateManager.getInstance().getFightProperties().getAdditionalAbilityPowerPerTeam(targetUnit.getTeam()),
    );
    if (armorAmount > 0) {
        attackerUnit.increaseBaseArmor(armorAmount);
        targetUnit.decreaseBaseArmor(armorAmount);
        sceneLog.updateLog(
            `${attackerUnit.getName()} mined ${Number(armorAmount.toFixed(2))} armor from ${targetUnit.getName()}`,
        );
    }
}
