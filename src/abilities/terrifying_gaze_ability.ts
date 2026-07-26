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
import { getRandomInt, getLapString } from "../utils/lib";
import { AbilityType } from "./ability_properties";
import { FightStateManager } from "../fights/fight_state_manager";
import { Unit } from "../units/unit";
import type { ISceneLog } from "../scene/scene_log_interface";

/**
 * Terrifying Gaze (Manticore) — the exact inverse of Aggr. Aggr narrows the victim's options down to the
 * attacker; this one removes the attacker from them: for one lap the frightened unit can neither attack nor
 * retaliate against the gazer, while every other enemy stays fair game.
 *
 * Chance is stack-powered through the shared calculateAbilityApplyChance, so it rises linearly with the
 * stack: at power 60 that is 12% at one stack up to 60% at five.
 */
export function processTerrifyingGazeAbility(
    fromUnit: Unit,
    targetUnit: Unit,
    currentActiveUnit: Unit,
    sceneLog: ISceneLog,
): void {
    if (targetUnit.isDead()) {
        return;
    }

    const terrifyingGazeAbility = fromUnit.getAbility("Terrifying Gaze");
    if (!terrifyingGazeAbility) {
        return;
    }

    // As with Aggr, MIND resistance (e.g. Helm of Focus) lowers the odds the fright lands.
    const mindResistCoeff =
        terrifyingGazeAbility.getType() === AbilityType.MIND ? 1 - targetUnit.getMindResist() / 100 : 1;

    if (
        getRandomInt(0, 100) >=
        fromUnit.calculateAbilityApplyChance(
            terrifyingGazeAbility,
            FightStateManager.getInstance().getFightProperties().getAdditionalAbilityPowerPerTeam(fromUnit.getTeam()),
        ) *
            mindResistCoeff
    ) {
        return;
    }

    const terrifyingGazeEffect = terrifyingGazeAbility.getEffect();
    if (!terrifyingGazeEffect) {
        return;
    }

    if (targetUnit.hasEffectActive(terrifyingGazeEffect.getName())) {
        // Already frightened: refresh which Manticore it is afraid of rather than stacking a second copy.
        targetUnit.setForbiddenTarget(fromUnit.getId());
        return;
    }

    const laps = terrifyingGazeEffect.getLaps();

    // Mirrors Aggr: a unit frightened during its OWN activation would otherwise burn the whole effect on the
    // turn it was applied, so give it back the lap it is currently spending.
    if (targetUnit.getId() === currentActiveUnit.getId()) {
        terrifyingGazeEffect.extend();
    }

    if (
        !(terrifyingGazeAbility.getType() === AbilityType.MIND && targetUnit.hasMindAttackResistance()) &&
        targetUnit.applyEffect(terrifyingGazeEffect)
    ) {
        targetUnit.setForbiddenTarget(fromUnit.getId());
        sceneLog.updateLog(
            `${fromUnit.getName()} terrified ${targetUnit.getName()} away from itself for ${getLapString(laps)}`,
        );
    } else {
        sceneLog.updateLog(`${targetUnit.getName()} resisted from Terrifying Gaze`);
    }
}
