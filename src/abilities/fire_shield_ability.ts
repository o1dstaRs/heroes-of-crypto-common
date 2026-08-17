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

import * as HoCConstants from "../constants";
import type { ISceneLog } from "../scene/scene_log_interface";
import { Unit } from "../units/unit";
import { FightStateManager } from "../fights/fight_state_manager";
import { UnitsHolder } from "../units/units_holder";
import type { IStatisticHolder } from "../scene/statistic_holder_interface";
import type { IDamageStatistic } from "../scene/scene_stats";
import type { ISecondaryDamage } from "../scene/animations";
import { applyMagicMirrorDamage } from "../spells/magic_mirror_damage";
import { SpellElement } from "../spells/spell_properties";

export interface IFireShieldResult {
    increaseMorale: number;
    unitIdsDied: string[];
    moraleDecreaseForTheUnitTeam: Record<string, number>;
}

export function processFireShieldAbility(
    fromUnit: Unit,
    toUnit: Unit,
    sceneLog: ISceneLog,
    damageFromAttack: number,
    unitsHolder: UnitsHolder,
    damageStatisticHolder: IStatisticHolder<IDamageStatistic>,
    secondaryDamage?: ISecondaryDamage[],
): IFireShieldResult {
    const unitIdsDied: string[] = [];
    let increaseMorale = 0;
    let moraleDecreaseForTheUnitTeam: Record<string, number> = {};
    if (toUnit.isDead()) {
        return { increaseMorale, unitIdsDied, moraleDecreaseForTheUnitTeam };
    }

    const fireShieldAbility = fromUnit.getAbility("Fire Shield");
    if (fireShieldAbility && !toUnit.hasAbilityActive("Fire Element")) {
        const heavyArmorAbility = toUnit.getAbility("Heavy Armor");
        let multiplier = 1;
        if (heavyArmorAbility) {
            multiplier = Number(
                (
                    ((heavyArmorAbility.getPower() + toUnit.getLuck()) / 100 / HoCConstants.MAX_UNIT_STACK_POWER) *
                        toUnit.getStackPower() +
                    1
                ).toFixed(2),
            );
        }

        // take magic resist into account
        const fireShieldDmg = Math.floor(
            Math.ceil(
                damageFromAttack *
                    fromUnit.calculateAbilityMultiplier(
                        fireShieldAbility,
                        FightStateManager.getInstance()
                            .getFightProperties()
                            .getAdditionalAbilityPowerPerTeam(fromUnit.getTeam()),
                    ),
            ) *
                (1 - toUnit.getMagicResist() / 100) *
                multiplier,
        );
        const positionAtImpact = { ...toUnit.getPosition() };
        const amountAliveBefore = toUnit.getAmountAlive();
        const damageDealt = toUnit.applyDamage(fireShieldDmg, 0 /* magic attack */, sceneLog, false, fromUnit);
        damageStatisticHolder.add({
            unitName: fromUnit.getName(),
            damage: damageDealt,
            team: fromUnit.getTeam(),
            lap: FightStateManager.getInstance().getFightProperties().getCurrentLap(),
        });
        secondaryDamage?.push({
            source: "fire_shield",
            unitId: toUnit.getId(),
            position: positionAtImpact,
            amount: fireShieldDmg,
            unitsDied: Math.max(0, amountAliveBefore - toUnit.getAmountAlive()),
        });
        sceneLog.updateLog(`${toUnit.getName()} received (${fireShieldDmg}) from Fire Shield`);
        const mirror = applyMagicMirrorDamage({
            attacker: fromUnit,
            holder: toUnit,
            landedOnHolder: fireShieldDmg,
            element: SpellElement.FIRE,
            sceneLog,
            secondaryDamage,
        });
        if (mirror?.unitDied && !unitIdsDied.includes(fromUnit.getId())) {
            unitIdsDied.push(fromUnit.getId());
        }

        if (toUnit.isDead() && !unitIdsDied.includes(toUnit.getId())) {
            sceneLog.updateLog(`${toUnit.getName()} died`);
            unitIdsDied.push(toUnit.getId());
            increaseMorale = HoCConstants.MORALE_CHANGE_FOR_KILL;
            moraleDecreaseForTheUnitTeam = {
                [`${toUnit.getName()}:${toUnit.getTeam()}`]: HoCConstants.MORALE_CHANGE_FOR_KILL,
            };
        }
    }

    return { increaseMorale, unitIdsDied, moraleDecreaseForTheUnitTeam };
}
