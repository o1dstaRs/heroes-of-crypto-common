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

import * as HoCLib from "../utils/lib";
import { ISceneLog } from "../scene/scene_log_interface";
import { Unit } from "../units/unit";
import { FightStateManager } from "../fights/fight_state_manager";

export function processLuckyStrikeAbility(attackerUnit: Unit, damageFromAttack: number, sceneLog: ISceneLog): number {
    const luckyStrikeAbility = attackerUnit.getAbility("Lucky Strike");

    if (!luckyStrikeAbility) {
        return damageFromAttack;
    }

    if (
        HoCLib.getRandomInt(0, 100) <
        attackerUnit.calculateAbilityApplyChance(
            luckyStrikeAbility,
            FightStateManager.getInstance()
                .getFightProperties()
                .getAdditionalAbilityPowerPerTeam(attackerUnit.getTeam()),
        )
    ) {
        sceneLog.updateLog(`${attackerUnit.getName()} activates Lucky Strike`);
        damageFromAttack = Math.floor(
            damageFromAttack *
                attackerUnit.calculateAbilityMultiplier(
                    luckyStrikeAbility,
                    FightStateManager.getInstance()
                        .getFightProperties()
                        .getAdditionalAbilityPowerPerTeam(attackerUnit.getTeam()),
                ),
        );
    }

    return damageFromAttack;
}
