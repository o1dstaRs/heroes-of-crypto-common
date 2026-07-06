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
import * as HoCLib from "../utils/lib";
import { FightStateManager } from "../fights/fight_state_manager";

export function calculateActiveDeepWoundsEffect(fromUnit: Unit, targetUnit: Unit): number {
    const activeDeepWoundsEffect = targetUnit.getEffect("Deep Wounds");
    if (!activeDeepWoundsEffect?.getPower()) {
        return 0;
    }

    const deepWoundsLevel1Ability = fromUnit.getAbility("Deep Wounds Level 1");
    const deepWoundsLevel2Ability = fromUnit.getAbility("Deep Wounds Level 2");
    const deepWoundsLevel3Ability = fromUnit.getAbility("Deep Wounds Level 3");

    if (!deepWoundsLevel1Ability && !deepWoundsLevel2Ability && !deepWoundsLevel3Ability) {
        return 0;
    }

    return activeDeepWoundsEffect.getPower();
}

// Returns the target's total Deep Wounds power AFTER this application (0 when nothing was applied). The
// caller uses a non-zero return to fire the orange-claw VFX once per application — so a double-attacker
// that wounds on each hit fires the claw once per hit.
export function processDeepWoundsAbility(
    fromUnit: Unit,
    targetUnit: Unit,
    currentActiveUnit: Unit,
    sceneLog: ISceneLog,
): number {
    if (targetUnit.isDead()) {
        return 0;
    }

    const deepWoundsLevel1Ability = fromUnit.getAbility("Deep Wounds Level 1");
    const deepWoundsLevel2Ability = fromUnit.getAbility("Deep Wounds Level 2");
    const deepWoundsLevel3Ability = fromUnit.getAbility("Deep Wounds Level 3");
    let powerSum = 0;
    let deepWoundsEffect =
        deepWoundsLevel1Ability?.getEffect() ??
        deepWoundsLevel2Ability?.getEffect() ??
        deepWoundsLevel3Ability?.getEffect() ??
        null;
    if (deepWoundsLevel1Ability && deepWoundsLevel1Ability.getEffect()) {
        powerSum += fromUnit.calculateAbilityCount(
            deepWoundsLevel1Ability,
            FightStateManager.getInstance().getFightProperties().getAdditionalAbilityPowerPerTeam(fromUnit.getTeam()),
        );
    }
    if (deepWoundsLevel2Ability && deepWoundsLevel2Ability.getEffect()) {
        powerSum += fromUnit.calculateAbilityCount(
            deepWoundsLevel2Ability,
            FightStateManager.getInstance().getFightProperties().getAdditionalAbilityPowerPerTeam(fromUnit.getTeam()),
        );
    }
    if (deepWoundsLevel3Ability && deepWoundsLevel3Ability.getEffect()) {
        powerSum += fromUnit.calculateAbilityCount(
            deepWoundsLevel3Ability,
            FightStateManager.getInstance().getFightProperties().getAdditionalAbilityPowerPerTeam(fromUnit.getTeam()),
        );
    }

    // ARTIFACT Wounding Charm grants Deep Wounds Level 1 to the whole army (see UnitsHolder.applyArtifacts),
    // but at a FRACTION of full strength — the buff power is a percent (default 50) — so a whole-army Deep
    // Wounds isn't oppressive. Full-strength granting tested at ~66% (top artifact by a mile), hence the scale.
    const woundingCharmBuff = fromUnit.getBuff("Wounding Charm");
    if (woundingCharmBuff) {
        powerSum *= woundingCharmBuff.getPower() / 100;
    }

    if (powerSum && deepWoundsEffect) {
        const activeDeepWoundsEffect = targetUnit.getEffect("Deep Wounds");

        // need to overwrite actual effect power here
        const totalPower = Number(((activeDeepWoundsEffect?.getPower() ?? 0) + powerSum).toFixed(1));
        deepWoundsEffect.setPower(totalPower);

        const laps = deepWoundsEffect.getLaps();

        if (targetUnit.getId() === currentActiveUnit.getId()) {
            deepWoundsEffect.extend();
        }

        if (targetUnit.applyEffect(deepWoundsEffect)) {
            sceneLog.updateLog(
                `${fromUnit.getName()} applied Deep Wounds on ${targetUnit.getName()} for ${HoCLib.getLapString(laps)}`,
            );
        }
        return totalPower;
    }
    return 0;
}
