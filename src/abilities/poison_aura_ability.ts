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
import { applyPoisonEffect } from "./poison_ability";

/**
 * Poison Cloud Aura (Dryad): every ally standing inside the 2-cell aura, when it lands a hit, ALSO applies
 * a portion of that hit's damage to the target as Poison. The portion = the aura's base power (%) plus the
 * ATTACKER's luck, so it varies from 0% (luck -10) through 10% (luck 0) to 20% (luck +10). The aura buff
 * that carries the base power sits on the attacker (mirrors the Flesh Shield Aura buff-on-hit pattern).
 */
export function processPoisonAuraAbility(
    attackerUnit: Unit,
    targetUnit: Unit,
    damageDealt: number,
    sceneLog: ISceneLog,
): void {
    if (damageDealt <= 0 || targetUnit.isDead()) {
        return;
    }

    const poisonAuraBuff = attackerUnit.getBuff("Poison Cloud Aura");
    if (!poisonAuraBuff) {
        return;
    }

    const percent = Math.max(0, poisonAuraBuff.getPower() + attackerUnit.getLuck());
    const poisonHp = Math.floor((damageDealt * percent) / 100);
    if (poisonHp <= 0) {
        return;
    }

    applyPoisonEffect(targetUnit, poisonHp, sceneLog);
}
