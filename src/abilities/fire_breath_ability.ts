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

import { PBTypes } from "../generated/protobuf/v1/types";
import { Grid } from "../grid/grid";
import * as HoCMath from "../utils/math";
import * as HoCConstants from "../constants";
import * as HoCLib from "../utils/lib";
import type { ISceneLog } from "../scene/scene_log_interface";
import { Unit } from "../units/unit";
import { FightStateManager } from "../fights/fight_state_manager";
import { UnitsHolder } from "../units/units_holder";
import * as AbilityHelper from "../abilities/ability_helper";
import type { IStatisticHolder } from "../scene/statistic_holder_interface";
import type { IDamageStatistic } from "../scene/scene_stats";
import type { ISecondaryDamage } from "../scene/animations";

export interface IFireBreathResult {
    increaseMorale: number;
    unitIdsDied: string[];
    moraleDecreaseForTheUnitTeam: Record<string, number>;
}

export function processFireBreathAbility(
    fromUnit: Unit,
    toUnit: Unit,
    sceneLog: ISceneLog,
    unitsHolder: UnitsHolder,
    grid: Grid,
    attackTypeString: string,
    damageStatisticHolder: IStatisticHolder<IDamageStatistic>,
    targetMovePosition?: HoCMath.XY,
    secondaryDamage?: ISecondaryDamage[],
): IFireBreathResult {
    const unitIdsDied: string[] = [];
    const moraleDecreaseForTheUnitTeam: Record<string, number> = {};
    const fireBreathAbility = fromUnit.getAbility("Fire Breath");
    let increaseMoraleTotal = 0;

    if (!fireBreathAbility) {
        return {
            increaseMorale: increaseMoraleTotal,
            moraleDecreaseForTheUnitTeam,
            unitIdsDied,
        };
    }

    const unitsDead: Unit[] = [];
    const targets = AbilityHelper.nextStandingTargets(fromUnit, toUnit, grid, unitsHolder, targetMovePosition);

    for (const nextStandingTarget of targets) {
        // A dead unit doesn't block the wave — the fire passes through its (about-to-be-emptied) cell.
        if (nextStandingTarget.isDead()) {
            continue;
        }
        // A FULLY fire-immune unit (Fire Element, e.g. Efreet / Black Dragon, or 100% magic resist) takes no
        // damage AND acts as a fire wall: it shields every unit behind it in the wave's path. Stop the sweep
        // here — do not carry the breath through to further targets.
        if (nextStandingTarget.getMagicResist() >= 100 || nextStandingTarget.hasAbilityActive("Fire Element")) {
            break;
        }

        const heavyArmorAbility = nextStandingTarget.getAbility("Heavy Armor");
        let multiplier = 1;
        if (heavyArmorAbility) {
            multiplier = Number(
                (
                    ((heavyArmorAbility.getPower() + nextStandingTarget.getLuck()) /
                        100 /
                        HoCConstants.MAX_UNIT_STACK_POWER) *
                        nextStandingTarget.getStackPower() +
                    1
                ).toFixed(2),
            );
        }

        // take magic resist into account
        let fireBreathAttackDamage = Math.floor(
            fromUnit.calculateAttackDamage(
                nextStandingTarget,
                PBTypes.AttackVals.MELEE,
                FightStateManager.getInstance()
                    .getFightProperties()
                    .getAdditionalAbilityPowerPerTeam(fromUnit.getTeam()),
                1,
                fromUnit.calculateAbilityMultiplier(
                    fireBreathAbility,
                    FightStateManager.getInstance()
                        .getFightProperties()
                        .getAdditionalAbilityPowerPerTeam(fromUnit.getTeam()),
                ),
            ) *
                (1 - nextStandingTarget.getMagicResist() / 100) *
                multiplier,
        );

        // ARTIFACT Giant's Maul: +damage to non-primary breath targets (toUnit is the primary target).
        const giantsMaulBuff = fromUnit.getBuff("Giants Maul");
        if (giantsMaulBuff && nextStandingTarget.getId() !== toUnit.getId()) {
            fireBreathAttackDamage = Math.floor(fireBreathAttackDamage * (1 + giantsMaulBuff.getPower() / 100));
        }
        // ARTIFACT Broken Aegis: the victim takes reduced damage from area attacks.
        const aegisShieldBuff = nextStandingTarget.getBuff("Broken Aegis");
        if (aegisShieldBuff) {
            fireBreathAttackDamage = Math.floor(fireBreathAttackDamage * (1 - aegisShieldBuff.getPower() / 100));
        }

        const positionAtImpact = { ...nextStandingTarget.getPosition() };
        const amountAliveBefore = nextStandingTarget.getAmountAlive();
        damageStatisticHolder.add({
            unitName: fromUnit.getName(),
            damage: nextStandingTarget.applyDamage(fireBreathAttackDamage, 0 /* magic attack */, sceneLog),
            team: fromUnit.getTeam(),
            lap: FightStateManager.getInstance().getFightProperties().getCurrentLap(),
        });
        const unitsKilled = Math.max(0, amountAliveBefore - nextStandingTarget.getAmountAlive());
        secondaryDamage?.push({
            source: "fire_breath",
            unitId: nextStandingTarget.getId(),
            position: positionAtImpact,
            amount: fireBreathAttackDamage,
            unitsDied: unitsKilled,
        });

        sceneLog.updateLog(
            `${fromUnit.getName()} ${attackTypeString} ${nextStandingTarget.getName()} (${fireBreathAttackDamage})` +
                HoCLib.killTag(unitsKilled),
        );

        if (nextStandingTarget.isDead()) {
            unitsDead.push(nextStandingTarget);
        }
    }

    for (const unitDead of unitsDead) {
        sceneLog.updateLog(`${unitDead.getName()} died`);
        unitIdsDied.push(unitDead.getId());
        increaseMoraleTotal += HoCConstants.MORALE_CHANGE_FOR_KILL;
        const unitNameKey = `${unitDead.getName()}:${unitDead.getTeam()}`;
        moraleDecreaseForTheUnitTeam[unitNameKey] =
            (moraleDecreaseForTheUnitTeam[unitNameKey] || 0) + HoCConstants.MORALE_CHANGE_FOR_KILL;
    }

    return {
        increaseMorale: increaseMoraleTotal,
        moraleDecreaseForTheUnitTeam,
        unitIdsDied,
    };
}
