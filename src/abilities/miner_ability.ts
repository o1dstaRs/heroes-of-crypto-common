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

import type { ISceneLog } from "../scene/scene_log_interface";
import { Unit } from "../units/unit";
import { FightStateManager } from "../fights/fight_state_manager";
import { Spell } from "../spells/spell";
import { getSpellConfig } from "../configuration/config_provider";
import { NUMBER_OF_LAPS_TOTAL } from "../constants";

const MINER_DEBUFF = "Miner";

export function processMinerAbility(attackerUnit: Unit, targetUnit: Unit, sceneLog: ISceneLog) {
    const minerAbility = attackerUnit.getAbility("Miner");

    if (!minerAbility || attackerUnit.isDead() || targetUnit.isDead()) {
        return;
    }

    const armorAmount = Number(
        attackerUnit
            .calculateAbilityCount(
                minerAbility,
                FightStateManager.getInstance()
                    .getFightProperties()
                    .getAdditionalAbilityPowerPerTeam(attackerUnit.getTeam()),
            )
            .toFixed(2),
    );
    const armorMined = targetUnit.decreaseBaseArmor(armorAmount);
    if (armorMined <= 0) {
        return;
    }

    attackerUnit.increaseBaseArmor(armorMined);

    // The base-stat mutation is permanent, but it also needs a persistent display object. Accumulate the
    // exact armor actually removed (the target clamps at 1), replace the prior row, and apply through the
    // normal debuff funnel so local and ranked effect capture/sidebar serialization see the same state.
    const existing = targetUnit.getDebuff(MINER_DEBUFF);
    const totalMined = Number(((existing?.getPower() ?? 0) + armorMined).toFixed(2));
    if (existing) {
        targetUnit.deleteDebuff(MINER_DEBUFF);
    }
    const minerDebuff = new Spell({
        spellProperties: getSpellConfig("System", MINER_DEBUFF, NUMBER_OF_LAPS_TOTAL),
        amount: 1,
    });
    minerDebuff.setPower(totalMined);
    targetUnit.applyDebuff(minerDebuff, totalMined);

    sceneLog.updateLog(`${attackerUnit.getName()} mined ${armorMined} armor from ${targetUnit.getName()}`);
}
