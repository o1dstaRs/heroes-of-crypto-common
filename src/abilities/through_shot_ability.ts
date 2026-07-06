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
import * as HoCLib from "../utils/lib";
import * as HoCMath from "../utils/math";
import * as HoCConstants from "../constants";
import { Grid } from "../grid/grid";
import type { ISceneLog } from "../scene/scene_log_interface";
import { Unit } from "../units/unit";
import { FightStateManager } from "../fights/fight_state_manager";
import { UnitsHolder } from "../units/units_holder";
import type { IAnimationData } from "../scene/animations";
import type { IStatisticHolder } from "../scene/statistic_holder_interface";
import type { IDamageStatistic } from "../scene/scene_stats";

import { processLuckyStrikeAbility } from "./lucky_strike_ability";
import { processPetrifyingGazeAbility } from "./petrifying_gaze_ability";
import { processSpitBallAbility } from "./spit_ball_ability";
import { processStunAbility } from "./stun_ability";

export interface IThroughShotResult {
    landed: boolean;
    unitIdsDied: string[];
    animationData: IAnimationData[];
    // Per-affected-unit damage so the client can draw a floating number on EVERY unit the shot pierced,
    // not just the aimed target. Mirrors the AOE-range payload (Large Caliber / Area Throw); without it
    // Through Shot's secondary hits deal damage but show no animation. See IVisibleDamage.splash.
    perUnitDamage: { unitId: string; position: HoCMath.XY; amount: number; unitsDied: number }[];
}

export function processThroughShotAbility(
    attackerUnit: Unit,
    targetUnits: Array<Unit[]>,
    currentActiveUnit: Unit,
    hoverRangeAttackDivisors: number[],
    hoverRangeAttackPosition: HoCMath.XY,
    unitsHolder: UnitsHolder,
    grid: Grid,
    sceneLog: ISceneLog,
    damageStatisticHolder: IStatisticHolder<IDamageStatistic>,
    decreaseNumberOfShots = true,
): IThroughShotResult {
    const animationData: IAnimationData[] = [];
    const unitIdsDied: string[] = [];
    const perUnitDamage: { unitId: string; position: HoCMath.XY; amount: number; unitsDied: number }[] = [];
    const throughShotAbility = attackerUnit.getAbility("Through Shot");
    if (!throughShotAbility) {
        return { landed: false, unitIdsDied, animationData, perUnitDamage };
    }

    let targetUnitUndex = 0;
    let targetUnit: Unit | undefined = undefined;

    const unitsDamaged: Unit[] = [];

    while (targetUnitUndex < targetUnits.length) {
        const affectedUnits = targetUnits[targetUnitUndex];
        if (affectedUnits?.length !== 1) {
            targetUnitUndex++;
            continue;
        }

        targetUnit = affectedUnits[0];
        if (!targetUnit) {
            targetUnitUndex++;
            continue;
        }

        const hoverRangeAttackDivisor: number | undefined = hoverRangeAttackDivisors.at(targetUnitUndex);
        if (!hoverRangeAttackDivisor) {
            targetUnitUndex++;
            continue;
        }
        targetUnitUndex++;

        const isAttackMissed =
            HoCLib.getRandomInt(0, 100) <
            attackerUnit.calculateMissChance(
                targetUnit,
                FightStateManager.getInstance()
                    .getFightProperties()
                    .getAdditionalAbilityPowerPerTeam(targetUnit.getTeam()),
            );
        if (isAttackMissed) {
            sceneLog.updateLog(`${attackerUnit.getName()} misses attk ${targetUnit.getName()}`);
        } else {
            let throughShotMultiplier = attackerUnit.calculateAbilityMultiplier(
                throughShotAbility,
                FightStateManager.getInstance()
                    .getFightProperties()
                    .getAdditionalAbilityPowerPerTeam(attackerUnit.getTeam()),
            );
            const paralysisAttackerEffect = attackerUnit.getEffect("Paralysis");
            if (paralysisAttackerEffect) {
                throughShotMultiplier *= (100 - paralysisAttackerEffect.getPower()) / 100;
            }
            let damageFromAttack = processLuckyStrikeAbility(
                attackerUnit,
                attackerUnit.calculateAttackDamage(
                    targetUnit,
                    PBTypes.AttackVals.RANGE,
                    FightStateManager.getInstance()
                        .getFightProperties()
                        .getAdditionalAbilityPowerPerTeam(targetUnit.getTeam()),
                    hoverRangeAttackDivisor,
                    throughShotMultiplier,
                    false,
                ),
                sceneLog,
            );
            // Through Shot is a physical line/AOE attack: status resistance hardens the victim (Mechanisms take extra).
            damageFromAttack = Math.floor(damageFromAttack * targetUnit.getPhysicalAoeDamageMultiplier());
            sceneLog.updateLog(`${attackerUnit.getName()} attk ${targetUnit.getName()} (${damageFromAttack})`);
            const amountAliveBeforeDamage = targetUnit.getAmountAlive();
            const positionAtImpact = { ...targetUnit.getPosition() };
            const damageDealt = targetUnit.applyDamage(
                damageFromAttack,
                FightStateManager.getInstance().getFightProperties().getBreakChancePerTeam(attackerUnit.getTeam()),
                sceneLog,
            );
            damageStatisticHolder.add({
                unitName: attackerUnit.getName(),
                damage: damageDealt,
                team: attackerUnit.getTeam(),
                lap: FightStateManager.getInstance().getFightProperties().getCurrentLap(),
            });
            perUnitDamage.push({
                unitId: targetUnit.getId(),
                position: positionAtImpact,
                amount: damageDealt,
                unitsDied: Math.max(0, amountAliveBeforeDamage - targetUnit.getAmountAlive()),
            });
            const pegasusLightEffect = targetUnit.getEffect("Pegasus Light");
            if (pegasusLightEffect) {
                attackerUnit.increaseMorale(
                    pegasusLightEffect.getPower(),
                    FightStateManager.getInstance()
                        .getFightProperties()
                        .getAdditionalMoralePerTeam(attackerUnit.getTeam()),
                );
            }
            unitsDamaged.push(targetUnit);

            if (!targetUnit.isDead()) {
                processPetrifyingGazeAbility(
                    attackerUnit,
                    targetUnit,
                    damageFromAttack,
                    sceneLog,
                    damageStatisticHolder,
                );
            }
        }
    }

    let moraleIncreaseTotal = 0;
    let moraleDecreaseForTheUnitTeam: Record<string, number> = {};

    for (const unit of unitsDamaged) {
        if (unit.isDead()) {
            sceneLog.updateLog(`${unit.getName()} died`);
            unitIdsDied.push(unit.getId());
            moraleIncreaseTotal += HoCConstants.MORALE_CHANGE_FOR_KILL;
            const unitNameKey = `${unit.getName()}:${unit.getTeam()}`;
            moraleDecreaseForTheUnitTeam[unitNameKey] =
                (moraleDecreaseForTheUnitTeam[unitNameKey] || 0) + HoCConstants.MORALE_CHANGE_FOR_KILL;
        } else {
            processStunAbility(attackerUnit, unit, attackerUnit, sceneLog);
            processSpitBallAbility(attackerUnit, unit, currentActiveUnit, unitsHolder, grid, sceneLog);
        }
    }

    attackerUnit.increaseMorale(
        moraleIncreaseTotal,
        FightStateManager.getInstance().getFightProperties().getAdditionalMoralePerTeam(attackerUnit.getTeam()),
    );
    unitsHolder.decreaseMoraleForTheSameUnitsOfTheTeam(moraleDecreaseForTheUnitTeam);

    if (decreaseNumberOfShots) {
        attackerUnit.decreaseNumberOfShots();
    }
    if (targetUnit) {
        animationData.push({
            fromPosition: attackerUnit.getPosition(),
            toPosition: hoverRangeAttackPosition,
            affectedUnit: targetUnit,
        });
    }

    return { landed: true, unitIdsDied, animationData, perUnitDamage };
}
