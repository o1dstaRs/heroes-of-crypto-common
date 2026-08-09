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

import { EffectFactory } from "../effects/effect_factory";
import type { ISceneLog } from "../scene/scene_log_interface";
import { Unit } from "../units/unit";
import * as HoCLib from "../utils/lib";

export const STUN_AURA_ABILITY_NAME = "Stun Aura";
/** The BUFF the aura lands on every ally standing in the field (see the UnitsHolder aura pass). */
export const STUN_AURA_BUFF_NAME = "Stun Aura";

const effectFactory = new EffectFactory();

/**
 * Stun Aura (Abomination), 2 cells: every ally standing in the field, when it lands a hit, gets a chance
 * to Stun the enemy it hit for a turn. Mirrors the Venom Cloud Aura buff-on-hit pattern.
 *
 * The chance is the aura's configured base power scaled by the ABOMINATION's stack power plus its luck.
 * That whole live chance is computed by calculateAuraPower (STUN_CHANCE) at aura-application time and
 * stored ON the buff the ally carries, so the roll here reads it straight off the buff — no need to
 * resolve the distant owner. It is then cut by the target's status resist and amplified against
 * Mechanisms, exactly like the Squire's Stun on-hit.
 */
export function processStunAuraOnHit(
    attackerUnit: Unit,
    targetUnit: Unit,
    currentActiveUnit: Unit,
    sceneLog: ISceneLog,
    rollPercent: () => number = () => HoCLib.getRandomInt(0, 100),
): void {
    if (targetUnit.isDead()) {
        return;
    }

    const stunAuraBuff = attackerUnit.getBuff(STUN_AURA_BUFF_NAME);
    if (!stunAuraBuff) {
        return;
    }

    const stunEffect = effectFactory.makeEffect("Stun");
    if (!stunEffect) {
        return;
    }
    if (targetUnit.hasEffectActive(stunEffect.getName())) {
        return;
    }

    const amplifier = targetUnit.hasAbilityActive("Mechanism") ? 1.5 : 1;
    const chance = Math.max(
        0,
        Math.min(100, stunAuraBuff.getPower() * amplifier * (1 - targetUnit.getStatusResist() / 100)),
    );
    if (rollPercent() >= chance) {
        return;
    }

    // Catching the CURRENTLY active unit costs it this whole activation — the same shape the Squire's Stun
    // gets when it lands on the active attacker (stun_ability.processStunAbility).
    if (targetUnit.getId() === currentActiveUnit.getId()) {
        stunEffect.extend();
    }

    if (targetUnit.applyEffect(stunEffect)) {
        sceneLog.updateLog(`${targetUnit.getName()} got stunned for ${HoCLib.getLapString(stunEffect.getLaps())}`);
    }
}
