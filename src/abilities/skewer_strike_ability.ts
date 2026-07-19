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
import type { ISceneLog } from "../scene/scene_log_interface";
import * as HoCLib from "../utils/lib";
import { Unit } from "../units/unit";
import { FightStateManager } from "../fights/fight_state_manager";
import { UnitsHolder } from "../units/units_holder";
import * as AbilityHelper from "./ability_helper";
import type { IStatisticHolder } from "../scene/statistic_holder_interface";
import type { IDamageStatistic } from "../scene/scene_stats";
import type { ISecondaryDamage } from "../scene/animations";

import { processAggrAbility } from "./aggr_ability";
import { processBlindnessAbility } from "./blindness_ability";
import { processBoarSalivaAbility } from "./boar_saliva_ability";
import { processDeepWoundsAbility } from "./deep_wounds_ability";
import { processDullingDefenseAblity } from "./dulling_defense_ability";
import { processFleshShieldAura } from "./flesh_shield_aura_ability";
import { processMinerAbility } from "./miner_ability";
import { processParalysisAbility } from "./paralysis_ability";
import { processPegasusLightAbility } from "./pegasus_light_ability";
import { processPetrifyingGazeAbility } from "./petrifying_gaze_ability";
import { processRimeCharmAbility } from "./rime_charm_ability";
import { processShatterArmorAbility } from "./shatter_armor_ability";
import { processStunAbility } from "./stun_ability";

export interface ISkewerStrikeDamage {
    unitId: string;
    unitPosition: { x: number; y: number };
    unitIsSmall: boolean;
    damage: number;
    unitsDied: number;
}

export interface ISkewerStrikeResult {
    increaseMorale: number;
    unitIdsDied: string[];
    moraleDecreaseForTheUnitTeam: Record<string, number>;
    secondaryDamages: ISkewerStrikeDamage[];
}

export function processSkewerStrikeAbility(
    fromUnit: Unit,
    toUnit: Unit,
    sceneLog: ISceneLog,
    unitsHolder: UnitsHolder,
    grid: Grid,
    damageStatisticHolder: IStatisticHolder<IDamageStatistic>,
    targetMovePosition?: HoCMath.XY,
    isAttack = true,
    secondaryDamage?: ISecondaryDamage[],
): ISkewerStrikeResult {
    const unitIdsDied: string[] = [];
    const skewerStrikeAbility = fromUnit.getAbility("Skewer Strike");
    const moraleDecreaseForTheUnitTeam: Record<string, number> = {};
    let increaseMoraleTotal = 0;

    if (!skewerStrikeAbility) {
        return { increaseMorale: increaseMoraleTotal, unitIdsDied, moraleDecreaseForTheUnitTeam, secondaryDamages: [] };
    }

    const unitsDead: Unit[] = [];
    const secondaryDamages: ISkewerStrikeDamage[] = [];
    const targets = AbilityHelper.nextStandingTargets(
        fromUnit,
        toUnit,
        grid,
        unitsHolder,
        targetMovePosition,
        false,
        true,
    );

    for (const nextStandingTarget of targets) {
        if (nextStandingTarget.isDead()) {
            continue;
        }

        if (
            HoCLib.getRandomInt(0, 100) <
            fromUnit.calculateMissChance(
                nextStandingTarget,
                FightStateManager.getInstance()
                    .getFightProperties()
                    .getAdditionalAbilityPowerPerTeam(nextStandingTarget.getTeam()),
            )
        ) {
            sceneLog.updateLog(
                `${fromUnit.getName()} misses Skewer Strike ${isAttack ? "attk" : "resp"} on ${nextStandingTarget.getName()}`,
            );
            continue;
        }

        let damageFromAttack = fromUnit.calculateAttackDamage(
            nextStandingTarget,
            PBTypes.AttackVals.MELEE,
            FightStateManager.getInstance().getFightProperties().getAdditionalAbilityPowerPerTeam(fromUnit.getTeam()),
            1,
            fromUnit.calculateAbilityMultiplier(
                skewerStrikeAbility,
                FightStateManager.getInstance()
                    .getFightProperties()
                    .getAdditionalAbilityPowerPerTeam(fromUnit.getTeam()),
            ),
        );

        // ARTIFACT Giant's Maul: +% non-magical AOE damage at impact (every struck unit), before status resist.
        const giantsMaulBuff = fromUnit.getBuff("Giants Maul");
        if (giantsMaulBuff) {
            damageFromAttack = Math.floor(damageFromAttack * (1 + giantsMaulBuff.getPower() / 100));
        }

        // Skewer Strike is a physical line/AOE attack: status resistance hardens the victim (Mechanisms take extra).
        damageFromAttack = Math.floor(damageFromAttack * nextStandingTarget.getPhysicalAoeDamageMultiplier());

        const fleshShieldResult = processFleshShieldAura(
            fromUnit,
            nextStandingTarget,
            damageFromAttack,
            false,
            grid,
            unitsHolder,
            sceneLog,
            damageStatisticHolder,
            secondaryDamage,
        );
        damageFromAttack = fleshShieldResult.remainingDamage;
        increaseMoraleTotal += fleshShieldResult.increaseMorale;
        for (const unitId of fleshShieldResult.unitIdsDied) {
            if (!unitIdsDied.includes(unitId)) {
                unitIdsDied.push(unitId);
            }
        }
        for (const [unitNameKey, moraleDecrease] of Object.entries(fleshShieldResult.moraleDecreaseForTheUnitTeam)) {
            moraleDecreaseForTheUnitTeam[unitNameKey] =
                (moraleDecreaseForTheUnitTeam[unitNameKey] ?? 0) + moraleDecrease;
        }

        const amountBefore = nextStandingTarget.getAmountAlive();
        const damageDealt = nextStandingTarget.applyDamage(
            damageFromAttack,
            FightStateManager.getInstance().getFightProperties().getBreakChancePerTeam(fromUnit.getTeam()),
            sceneLog,
        );
        const amountAfter = nextStandingTarget.getAmountAlive();

        damageStatisticHolder.add({
            unitName: fromUnit.getName(),
            damage: damageDealt,
            team: fromUnit.getTeam(),
            lap: FightStateManager.getInstance().getFightProperties().getCurrentLap(),
        });

        // Collect damage info for visual display
        secondaryDamages.push({
            unitId: nextStandingTarget.getId(),
            unitPosition: nextStandingTarget.getPosition(),
            unitIsSmall: nextStandingTarget.isSmallSize(),
            damage: damageDealt,
            unitsDied: Math.max(0, amountBefore - amountAfter),
        });

        sceneLog.updateLog(
            `${fromUnit.getName()} ${isAttack ? "⚔️" : "resp"} ${nextStandingTarget.getName()} (${damageFromAttack})` +
                HoCLib.killTag(Math.max(0, amountBefore - amountAfter)),
        );

        if (nextStandingTarget.isDead()) {
            unitsDead.push(nextStandingTarget);
        }

        // check all the possible modificators here
        // just in case if we have more inherited/stolen abilities
        processMinerAbility(fromUnit, nextStandingTarget, sceneLog);
        processStunAbility(fromUnit, nextStandingTarget, fromUnit, sceneLog);
        processRimeCharmAbility(fromUnit, nextStandingTarget, sceneLog);
        processDullingDefenseAblity(nextStandingTarget, fromUnit, sceneLog);
        processPetrifyingGazeAbility(fromUnit, nextStandingTarget, damageFromAttack, sceneLog, damageStatisticHolder);
        processBoarSalivaAbility(fromUnit, nextStandingTarget, fromUnit, sceneLog);
        processAggrAbility(fromUnit, nextStandingTarget, fromUnit, sceneLog);
        processDeepWoundsAbility(fromUnit, nextStandingTarget, fromUnit, sceneLog);
        processPegasusLightAbility(fromUnit, nextStandingTarget, fromUnit, sceneLog);
        processParalysisAbility(fromUnit, nextStandingTarget, fromUnit, sceneLog);
        if (isAttack) {
            processShatterArmorAbility(fromUnit, nextStandingTarget, fromUnit, sceneLog);
        } else {
            processBlindnessAbility(fromUnit, nextStandingTarget, fromUnit, sceneLog);
        }
    }

    for (const unitDead of unitsDead) {
        if (!unitIdsDied.includes(unitDead.getId())) {
            sceneLog.updateLog(`${unitDead.getName()} died`);
            unitIdsDied.push(unitDead.getId());
            increaseMoraleTotal += HoCConstants.MORALE_CHANGE_FOR_KILL;
            const unitNameKey = `${unitDead.getName()}:${unitDead.getTeam()}`;
            moraleDecreaseForTheUnitTeam[unitNameKey] =
                (moraleDecreaseForTheUnitTeam[unitNameKey] || 0) + HoCConstants.MORALE_CHANGE_FOR_KILL;
        }
    }

    return { increaseMorale: increaseMoraleTotal, unitIdsDied, moraleDecreaseForTheUnitTeam, secondaryDamages };
}
