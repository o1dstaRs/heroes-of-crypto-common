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

import { Tier2Artifact } from "../artifacts/artifact_properties";
import { EffectFactory } from "../effects/effect_factory";
import { FightStateManager } from "../fights/fight_state_manager";
import type { ISceneLog } from "../scene/scene_log_interface";
import { Unit } from "../units/unit";

const effectFactory = new EffectFactory();

/**
 * Applies (or refreshes) the persistent Poison damage-over-time effect on a target.
 *
 * Poison ticks for `poisonHp` RAW hp at the START of the poisoned unit's turn (see TurnEngine) and lasts
 * until the very end of the fight — its config laps === NUMBER_OF_LAPS_TOTAL, which are never decremented.
 * A new poison only replaces an existing one when it is STRONGER (more hp/lap); a weaker/equal poison is
 * ignored so the target always suffers the worst poison it has been dealt.
 */
export function applyPoisonEffect(targetUnit: Unit, poisonHp: number, sceneLog: ISceneLog): void {
    if (targetUnit.isDead() || poisonHp <= 0) {
        return;
    }

    // Holy Cross (Tier 2) grants the wielder's whole army immunity to poison — nobody on that team can be
    // poisoned, so drop the effect entirely for them.
    if (
        FightStateManager.getInstance()
            .getFightProperties()
            .hasArtifactTier2(targetUnit.getTeam(), Tier2Artifact.HOLY_CROSS)
    ) {
        return;
    }

    const activePoison = targetUnit.getEffect("Poison");
    if (activePoison && activePoison.getPower() >= poisonHp) {
        return;
    }

    const poison = effectFactory.makeEffect("Poison");
    if (!poison) {
        return;
    }
    poison.setPower(poisonHp);

    if (targetUnit.applyEffect(poison)) {
        sceneLog.updateLog(`${targetUnit.getName()} is poisoned (${poisonHp} hp per turn)`);
    }
}
