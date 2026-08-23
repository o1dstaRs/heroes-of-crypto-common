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

import { POISON_ON_HIT_AURA_BUFF_NAMES } from "../configuration/config_provider";
import type { ISceneLog } from "../scene/scene_log_interface";
import { Unit } from "../units/unit";
import { applyPoisonEffect } from "./poison_ability";

/**
 * Venom Cloud Aura (Wyvern, 2 cells) and any future poison aura: every ally standing
 * inside the aura, when it lands a hit, ALSO applies a portion of that hit's damage to the target as Poison. The
 * portion = the aura's configured base power (%) plus the ATTACKER's luck. The aura buff that carries the
 * base power sits on the attacker (mirrors the Flesh Shield Aura buff-on-hit pattern).
 *
 * An ally can stand in both auras at once; they do NOT stack — the strongest one applies, the same way a
 * unit re-entering a single aura is topped up rather than doubled.
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

    let basePower: number | undefined = undefined;
    for (const buffName of POISON_ON_HIT_AURA_BUFF_NAMES) {
        const poisonAuraBuff = attackerUnit.getBuff(buffName);
        if (poisonAuraBuff && (basePower === undefined || poisonAuraBuff.getPower() > basePower)) {
            basePower = poisonAuraBuff.getPower();
        }
    }

    if (basePower === undefined) {
        return;
    }

    const percent = Math.max(0, basePower + attackerUnit.getLuck());
    const poisonHp = Math.floor((damageDealt * percent) / 100);
    if (poisonHp <= 0) {
        return;
    }

    applyPoisonEffect(targetUnit, poisonHp, sceneLog);
}
