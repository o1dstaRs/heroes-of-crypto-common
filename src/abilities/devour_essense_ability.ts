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
import type { ISecondaryDamage } from "../scene/animations";
import { Unit } from "../units/unit";
import { UnitsHolder } from "../units/units_holder";
import { FightStateManager } from "../fights/fight_state_manager";

export function processDevourEssenceAbility(
    fromUnit: Unit,
    unitIdsDied: string[],
    unitsHolder: UnitsHolder,
    sceneLog: ISceneLog,
    secondaryDamage?: ISecondaryDamage[],
): void {
    if (fromUnit.isDead()) {
        return;
    }

    const devourEssenceAbility = fromUnit.getAbility("Devour Essence");
    if (!devourEssenceAbility?.getPower()) {
        return;
    }

    const alreadyProcessed: string[] = [];
    let killedAnEnemy = false;
    for (const uId of unitIdsDied) {
        if (alreadyProcessed.includes(uId)) {
            continue;
        }

        const unit = unitsHolder.getAllUnits().get(uId);
        if (unit && fromUnit.getOppositeTeam() === unit.getTeam()) {
            killedAnEnemy = true;
            break;
        }
        alreadyProcessed.push(uId);
    }

    if (killedAnEnemy && devourEssenceAbility) {
        const devourEssenceAbilityPower = Number(
            fromUnit
                .calculateAbilityApplyChance(
                    devourEssenceAbility,
                    FightStateManager.getInstance()
                        .getFightProperties()
                        .getAdditionalAbilityPowerPerTeam(fromUnit.getTeam()),
                )
                .toFixed(2),
        );
        if (devourEssenceAbilityPower > 0) {
            const devourEssenceMultiplier = Math.min(1, devourEssenceAbilityPower / 100);
            const canRejuvinateUpTo = Math.ceil(fromUnit.getMaxHp() * devourEssenceMultiplier);
            if (canRejuvinateUpTo > fromUnit.getHp()) {
                const rejuvinateBy = canRejuvinateUpTo - fromUnit.getHp();
                fromUnit.applyHeal(rejuvinateBy);
                sceneLog.updateLog(`${fromUnit.getName()} rejuvinated for ${rejuvinateBy} hp`);
                // Ride the attack's damage payload so the heal reaches RANKED too — the sceneLog line
                // above only exists in the local sandbox; ranked rebuilds its log + VFX from events.
                secondaryDamage?.push({
                    source: "devour_essence",
                    unitId: fromUnit.getId(),
                    position: { ...fromUnit.getPosition() },
                    amount: rejuvinateBy,
                    unitsDied: 0,
                });
            }
        }
    }
}
