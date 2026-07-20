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
import creaturesJson from "../configuration/creatures.json";

// Creature names that own a Deep Wounds card NATIVELY (Wolf L1, White Tiger / Griffin L2, Behemoth
// L3), from the static creature config. Runtime unitProperties can't answer this: a Wounding-Charm-
// granted "Deep Wounds Level 1" lands in unitProperties.abilities too, so after a serialize/rebuild
// a granted card is indistinguishable from a native one there.
const NATIVE_DEEP_WOUNDS_L1_OWNERS: ReadonlySet<string> = (() => {
    const owners = new Set<string>();
    for (const [faction, creatures] of Object.entries(creaturesJson as Record<string, unknown>)) {
        if (faction === "version" || typeof creatures !== "object" || !creatures) {
            continue;
        }
        for (const [name, config] of Object.entries(creatures as Record<string, { abilities?: string[] }>)) {
            if (config.abilities?.includes("Deep Wounds Level 1")) {
                owners.add(name);
            }
        }
    }
    return owners;
})();

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
    const deepWoundsEffect =
        deepWoundsLevel1Ability?.getEffect() ??
        deepWoundsLevel2Ability?.getEffect() ??
        deepWoundsLevel3Ability?.getEffect() ??
        null;
    const additionalAbilityPower = FightStateManager.getInstance()
        .getFightProperties()
        .getAdditionalAbilityPowerPerTeam(fromUnit.getTeam());
    const level1Power =
        deepWoundsLevel1Ability && deepWoundsLevel1Ability.getEffect()
            ? fromUnit.calculateAbilityCount(deepWoundsLevel1Ability, additionalAbilityPower)
            : 0;
    let higherLevelsPower = 0;
    if (deepWoundsLevel2Ability && deepWoundsLevel2Ability.getEffect()) {
        higherLevelsPower += fromUnit.calculateAbilityCount(deepWoundsLevel2Ability, additionalAbilityPower);
    }
    if (deepWoundsLevel3Ability && deepWoundsLevel3Ability.getEffect()) {
        higherLevelsPower += fromUnit.calculateAbilityCount(deepWoundsLevel3Ability, additionalAbilityPower);
    }

    // ARTIFACT Wounding Charm grants Deep Wounds Level 1 to the whole army (see UnitsHolder.applyArtifacts)
    // at a FRACTION of full strength — the buff power is a percent (default 50) — so a whole-army Deep
    // Wounds isn't oppressive. Full-strength granting tested at ~66% (top artifact by a mile), hence the
    // scale. The scale applies ONLY to the charm's own Level-1 contribution: native deep-wounders (Wolf,
    // White Tiger, Griffin, Behemoth — per the static creature config, since runtime properties can't tell
    // native from granted after a rebuild) keep their own cards at FULL strength and the charm bonus STACKS
    // on top; it must never scale a native card down.
    let powerSum: number;
    const woundingCharmBuff = fromUnit.getBuff("Wounding Charm");
    if (woundingCharmBuff) {
        const charmScale = woundingCharmBuff.getPower() / 100;
        const ownsNativeLevel1 = NATIVE_DEEP_WOUNDS_L1_OWNERS.has(fromUnit.getName());
        powerSum = higherLevelsPower + (ownsNativeLevel1 ? level1Power : 0) + level1Power * charmScale;
    } else {
        powerSum = level1Power + higherLevelsPower;
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
