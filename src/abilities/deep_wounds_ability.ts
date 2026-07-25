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

// Every Deep Wounds card, weakest first. The levels SUM below rather than one overriding another, so a
// unit holding two cards (a White Tiger's native Level 2 plus the Level 1 the Wounding Charm grants it,
// see UnitsHolder.applyArtifacts) applies both. Level 0 is native to no creature and nothing grants it
// today — it is kept configured as the weaker alternative for the charm to hand out.
const DEEP_WOUNDS_ABILITY_NAMES = [
    "Deep Wounds Level 0",
    "Deep Wounds Level 1",
    "Deep Wounds Level 2",
    "Deep Wounds Level 3",
] as const;

// True when the unit carries any Deep Wounds card — the gate every damage path uses before consuming
// the amplification stacked on the target (attack handler, double punch, lightning spin, AI estimate).
export function hasAnyDeepWoundsAbility(unit: Unit): boolean {
    return DEEP_WOUNDS_ABILITY_NAMES.some((abilityName) => unit.hasAbilityActive(abilityName));
}

export function calculateActiveDeepWoundsEffect(fromUnit: Unit, targetUnit: Unit): number {
    const activeDeepWoundsEffect = targetUnit.getEffect("Deep Wounds");
    if (!activeDeepWoundsEffect?.getPower()) {
        return 0;
    }

    if (!DEEP_WOUNDS_ABILITY_NAMES.some((abilityName) => fromUnit.getAbility(abilityName))) {
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

    const additionalAbilityPower = FightStateManager.getInstance()
        .getFightProperties()
        .getAdditionalAbilityPowerPerTeam(fromUnit.getTeam());

    const heldAbilities = [];
    let deepWoundsEffect;
    for (const abilityName of DEEP_WOUNDS_ABILITY_NAMES) {
        const ability = fromUnit.getAbility(abilityName);
        const abilityEffect = ability?.getEffect();
        if (!ability || !abilityEffect) {
            continue;
        }
        // Every card yields an identical freshly built "Deep Wounds" effect, so the first one wins.
        deepWoundsEffect ??= abilityEffect;
        heldAbilities.push(ability);
    }
    // Every card the unit holds resolves as ONE application: the powers stack and luck is added once.
    const powerSum = fromUnit.calculateDeepWoundsCount(heldAbilities, additionalAbilityPower);

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
