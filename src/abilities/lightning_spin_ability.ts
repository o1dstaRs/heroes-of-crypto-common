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
import type { Grid } from "../grid/grid";
import * as HoCLib from "../utils/lib";
import * as HoCMath from "../utils/math";
import * as HoCConstants from "../constants";
import type { ISceneLog } from "../scene/scene_log_interface";
import { Unit } from "../units/unit";
import { FightStateManager } from "../fights/fight_state_manager";
import { UnitsHolder } from "../units/units_holder";
import type { IStatisticHolder } from "../scene/statistic_holder_interface";
import type { IDamageStatistic } from "../scene/scene_stats";
import type { ISecondaryDamage } from "../scene/animations";

import { processFireShieldAbility } from "./fire_shield_ability";
import { processFleshShieldAura } from "./flesh_shield_aura_ability";
import { processOneInTheFieldAbility } from "./one_in_the_field_ability";
import { processRimeCharmAbility } from "./rime_charm_ability";
import { processStunAbility } from "./stun_ability";
import { processBlindnessAbility } from "./blindness_ability";
import { processBoarSalivaAbility } from "./boar_saliva_ability";
import { processPetrifyingGazeAbility } from "./petrifying_gaze_ability";
import { processLuckyStrikeAbility } from "./lucky_strike_ability";
import { processShatterArmorAbility } from "./shatter_armor_ability";
import { processRapidChargeAbility } from "./rapid_charge_ability";
import { processPenetratingBiteAbility } from "./penetrating_bite_ability";
import { processPegasusLightAbility } from "./pegasus_light_ability";
import { processParalysisAbility } from "./paralysis_ability";
import { processDeepWoundsAbility } from "./deep_wounds_ability";
import { processMinerAbility } from "./miner_ability";
import { processAggrAbility } from "./aggr_ability";
import { processDullingDefenseAblity } from "./dulling_defense_ability";

export interface ILightningSpinResult {
    landed: boolean;
    unitIdsDied: string[];
}

export function processLightningSpinAbility(
    fromUnit: Unit,
    sceneLog: ISceneLog,
    unitsHolder: UnitsHolder,
    rapidChargeCells: number,
    damageStatisticHolder: IStatisticHolder<IDamageStatistic>,
    attackFromCell?: HoCMath.XY,
    isAttack = true,
    secondaryDamage?: ISecondaryDamage[],
    grid?: Grid,
): ILightningSpinResult {
    const unitIdsDied: string[] = [];
    let lightningSpinLanded = false;
    const lightningSpinAbility = fromUnit.getAbility("Lightning Spin");

    if (lightningSpinAbility) {
        const unitsDead: Unit[] = [];
        const wasDead: Unit[] = [];
        const nearbyEnemies = unitsHolder.allEnemiesAroundUnit(fromUnit, isAttack, attackFromCell);
        // Lightning Spin is one radial impact. As with range splash, resolve any Flesh Shield owners
        // caught in it before their protected allies so the owner's direct hit reserves HP and cannot
        // disappear merely because grid-neighbour iteration returned an ally first.
        const enemyList = [
            ...nearbyEnemies.filter((unit) => unit.hasAbilityActive("Flesh Shield Aura")),
            ...nearbyEnemies.filter((unit) => !unit.hasAbilityActive("Flesh Shield Aura")),
        ];
        let actionString: string;
        if (isAttack) {
            actionString = "attk";
        } else {
            actionString = "resp";
        }
        const enemyIdDamageFromAttack: Map<string, number> = new Map();

        const commonAbilityMultiplier = processRapidChargeAbility(fromUnit, rapidChargeCells);
        let increaseMoraleTotal = 0;

        const moraleDecreaseForTheUnitTeam: Record<string, number> = {};

        for (const enemy of enemyList) {
            if (enemy.isDead()) {
                wasDead.push(enemy);
                continue;
            }

            const isAttackMissed =
                HoCLib.getRandomInt(0, 100) <
                fromUnit.calculateMissChance(
                    enemy,
                    FightStateManager.getInstance()
                        .getFightProperties()
                        .getAdditionalAbilityPowerPerTeam(enemy.getTeam()),
                );

            if (fromUnit.hasDebuffActive("Cowardice") && fromUnit.getCumulativeHp() < enemy.getCumulativeHp()) {
                continue;
            }

            if (isAttackMissed) {
                sceneLog.updateLog(
                    `${fromUnit.getName()} misses ⚔️ ${actionString === "attk" ? "on" : "resp on"} ${enemy.getName()}`,
                );
                continue;
            }

            let abilityMultiplier =
                fromUnit.calculateAbilityMultiplier(
                    lightningSpinAbility,
                    FightStateManager.getInstance()
                        .getFightProperties()
                        .getAdditionalAbilityPowerPerTeam(fromUnit.getTeam()),
                ) * commonAbilityMultiplier;
            const paralysisAttackerEffect = fromUnit.getEffect("Paralysis");
            if (paralysisAttackerEffect) {
                abilityMultiplier *= (100 - paralysisAttackerEffect.getPower()) / 100;
            }

            const deepWoundsEffect = enemy.getEffect("Deep Wounds");
            if (
                deepWoundsEffect &&
                (fromUnit.hasAbilityActive("Deep Wounds Level 1") ||
                    fromUnit.hasAbilityActive("Deep Wounds Level 2") ||
                    fromUnit.hasAbilityActive("Deep Wounds Level 3"))
            ) {
                abilityMultiplier *= 1 + deepWoundsEffect.getPower() / 100;
            }

            let damageFromAttack =
                processLuckyStrikeAbility(
                    fromUnit,
                    fromUnit.calculateAttackDamage(enemy, PBTypes.AttackVals.MELEE, 1, abilityMultiplier),
                    sceneLog,
                ) + processPenetratingBiteAbility(fromUnit, enemy);

            // ARTIFACT Giant's Maul: +% non-magical AOE damage at impact to every struck unit (Lightning Spin
            // hits many), before the status-resistance reduction below.
            const giantsMaulBuff = fromUnit.getBuff("Giants Maul");
            if (giantsMaulBuff) {
                damageFromAttack = Math.floor(damageFromAttack * (1 + giantsMaulBuff.getPower() / 100));
            }
            // ARTIFACT Broken Aegis: the victim takes reduced damage from area attacks.
            const aegisShieldBuff = enemy.getBuff("Broken Aegis");
            if (aegisShieldBuff) {
                damageFromAttack = Math.floor(damageFromAttack * (1 - aegisShieldBuff.getPower() / 100));
            }

            // Status resistance hardens the victim vs physical AOE (Mechanisms take extra).
            damageFromAttack = Math.floor(damageFromAttack * enemy.getPhysicalAoeDamageMultiplier());

            if (grid) {
                const fleshShieldResult = processFleshShieldAura(
                    fromUnit,
                    enemy,
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
                for (const [unitNameKey, moraleDecrease] of Object.entries(
                    fleshShieldResult.moraleDecreaseForTheUnitTeam,
                )) {
                    moraleDecreaseForTheUnitTeam[unitNameKey] =
                        (moraleDecreaseForTheUnitTeam[unitNameKey] ?? 0) + moraleDecrease;
                }
            }

            const positionAtImpact = { ...enemy.getPosition() };
            const amountAliveBefore = enemy.getAmountAlive();
            const damageDealt = enemy.applyDamage(
                damageFromAttack,
                FightStateManager.getInstance().getFightProperties().getBreakChancePerTeam(fromUnit.getTeam()),
                sceneLog,
            );
            damageStatisticHolder.add({
                unitName: fromUnit.getName(),
                damage: damageDealt,
                team: fromUnit.getTeam(),
                lap: FightStateManager.getInstance().getFightProperties().getCurrentLap(),
            });
            secondaryDamage?.push({
                source: "lightning_spin",
                unitId: enemy.getId(),
                position: positionAtImpact,
                amount: damageDealt,
                unitsDied: Math.max(0, amountAliveBefore - enemy.getAmountAlive()),
            });
            const unitsKilled = Math.max(0, amountAliveBefore - enemy.getAmountAlive());
            enemyIdDamageFromAttack.set(enemy.getId(), damageFromAttack);
            const pegasusLightEffect = enemy.getEffect("Pegasus Light");
            if (pegasusLightEffect) {
                increaseMoraleTotal += pegasusLightEffect.getPower();
            }

            sceneLog.updateLog(
                `${fromUnit.getName()} ${isAttack ? "⚔️" : "resp"} ${enemy.getName()} (${damageFromAttack})` +
                    HoCLib.killTag(unitsKilled),
            );

            if (enemy.isDead()) {
                unitsDead.push(enemy);
            } else {
                // check all the possible modificators here
                // just in case if we have more inherited/stolen abilities
                processMinerAbility(fromUnit, enemy, sceneLog);
                processStunAbility(fromUnit, enemy, fromUnit, sceneLog);
                processRimeCharmAbility(fromUnit, enemy, sceneLog);
                processDullingDefenseAblity(enemy, fromUnit, sceneLog);
                processPetrifyingGazeAbility(
                    fromUnit,
                    enemy,
                    damageFromAttack,
                    sceneLog,
                    damageStatisticHolder,
                    secondaryDamage,
                );
                processBoarSalivaAbility(fromUnit, enemy, fromUnit, sceneLog);
                processAggrAbility(fromUnit, enemy, fromUnit, sceneLog);
                processDeepWoundsAbility(fromUnit, enemy, fromUnit, sceneLog);
                processPegasusLightAbility(fromUnit, enemy, fromUnit, sceneLog);
                processParalysisAbility(fromUnit, enemy, fromUnit, sceneLog);
                if (isAttack) {
                    processShatterArmorAbility(fromUnit, enemy, fromUnit, sceneLog);
                } else {
                    processBlindnessAbility(fromUnit, enemy, fromUnit, sceneLog);
                }
            }
        }

        for (const enemy of enemyList) {
            if (!wasDead.includes(enemy)) {
                const damageFromAttack = enemyIdDamageFromAttack.get(enemy.getId());
                if (damageFromAttack) {
                    const fireShieldResult = processFireShieldAbility(
                        enemy,
                        fromUnit,
                        sceneLog,
                        damageFromAttack,
                        unitsHolder,
                        damageStatisticHolder,
                    );

                    if (fireShieldResult.increaseMorale) {
                        enemy.increaseMorale(
                            fireShieldResult.increaseMorale,
                            FightStateManager.getInstance()
                                .getFightProperties()
                                .getAdditionalMoralePerTeam(enemy.getTeam()),
                        );
                    }

                    for (const [unitNameKey, moraleDecrease] of Object.entries(
                        fireShieldResult.moraleDecreaseForTheUnitTeam,
                    )) {
                        moraleDecreaseForTheUnitTeam[unitNameKey] =
                            (moraleDecreaseForTheUnitTeam[unitNameKey] ?? 0) + moraleDecrease;
                    }

                    for (const uId in fireShieldResult.unitIdsDied) {
                        if (!unitIdsDied.includes(uId)) {
                            unitIdsDied.push(uId);
                        }
                    }
                }
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

        if (!isAttack) {
            processOneInTheFieldAbility(fromUnit);
        }

        lightningSpinLanded = true;

        if (!fromUnit.isDead()) {
            fromUnit.increaseMorale(
                increaseMoraleTotal,
                FightStateManager.getInstance().getFightProperties().getAdditionalMoralePerTeam(fromUnit.getTeam()),
            );
        }

        unitsHolder.decreaseMoraleForTheSameUnitsOfTheTeam(moraleDecreaseForTheUnitTeam);
    }

    return { landed: lightningSpinLanded, unitIdsDied };
}
