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

import { Grid } from "../grid/grid";
import * as HoCConstants from "../constants";
import * as HoCMath from "../utils/math";
import * as HoCLib from "../utils/lib";
import { Unit } from "../units/unit";
import { FightStateManager } from "../fights/fight_state_manager";
import type { ISceneLog } from "../scene/scene_log_interface";
import { UnitsHolder } from "../units/units_holder";
import type { IStatisticHolder } from "../scene/statistic_holder_interface";
import type { IDamageStatistic } from "../scene/scene_stats";

import { processLuckyStrikeAbility } from "./lucky_strike_ability";
import { processPetrifyingGazeAbility } from "./petrifying_gaze_ability";
import { processSpitBallAbility } from "./spit_ball_ability";
import { processStunAbility } from "./stun_ability";
import { PBTypes } from "../generated/protobuf/v1/types";

export interface IAOERangeAttackResult {
    landed: boolean;
    maxDamage: number;
    unitIdsDied: string[];
    // Per-affected-unit damage so the client can draw a floating number on every splashed unit at its
    // own position (not just the primary target). Position is captured at impact time.
    perUnitDamage: { unitId: string; position: HoCMath.XY; amount: number; unitsDied: number }[];
}

export function processRangeAOEAbility(
    attackerUnit: Unit,
    affectedUnits: Unit[],
    currentActiveUnit: Unit,
    rangeAttackDivisor: number,
    unitsHolder: UnitsHolder,
    grid: Grid,
    sceneLog: ISceneLog,
    damageStatisticHolder: IStatisticHolder<IDamageStatistic>,
    isAttack = true,
): IAOERangeAttackResult {
    const unitIdsDied: string[] = [];
    const perUnitDamage: { unitId: string; position: HoCMath.XY; amount: number; unitsDied: number }[] = [];
    let aoeAbility = attackerUnit.getAbility("Area Throw");
    if (!aoeAbility) {
        aoeAbility = attackerUnit.getAbility("Large Caliber");
    }

    let maxDamage = 0;
    if (aoeAbility) {
        const wasDead: Unit[] = [];
        let increaseMoraleTotal = 0;
        for (const unit of affectedUnits) {
            if (unit.isDead()) {
                unitIdsDied.push(unit.getId());
                wasDead.push(unit);
                continue;
            }

            const isAttackMissed =
                HoCLib.getRandomInt(0, 100) <
                attackerUnit.calculateMissChance(
                    unit,
                    FightStateManager.getInstance()
                        .getFightProperties()
                        .getAdditionalAbilityPowerPerTeam(unit.getTeam()),
                );
            if (isAttackMissed) {
                sceneLog.updateLog(`${attackerUnit.getName()} misses ${isAttack ? "attk" : "resp"} ${unit.getName()}`);
            } else {
                let abilityMultiplier = attackerUnit.calculateAbilityMultiplier(
                    aoeAbility,
                    FightStateManager.getInstance()
                        .getFightProperties()
                        .getAdditionalAbilityPowerPerTeam(attackerUnit.getTeam()),
                );

                const paralysisAttackerEffect = attackerUnit.getEffect("Paralysis");
                if (paralysisAttackerEffect) {
                    abilityMultiplier *= (100 - paralysisAttackerEffect.getPower()) / 100;
                }

                const damageFromAttack = processLuckyStrikeAbility(
                    attackerUnit,
                    attackerUnit.calculateAttackDamage(
                        unit,
                        PBTypes.AttackVals.RANGE,
                        FightStateManager.getInstance()
                            .getFightProperties()
                            .getAdditionalAbilityPowerPerTeam(attackerUnit.getTeam()),
                        rangeAttackDivisor,
                        abilityMultiplier,
                        false,
                    ),
                    sceneLog,
                );

                // Snapshot position + stack BEFORE applying damage so the floating number lands where the
                // unit stood when hit (it may die and be removed before the visuals play).
                const unitPositionAtImpact = { ...unit.getPosition() };
                const amountAliveBeforeDamage = unit.getAmountAlive();
                const damageDealt = unit.applyDamage(
                    damageFromAttack,
                    FightStateManager.getInstance().getFightProperties().getBreakChancePerTeam(attackerUnit.getTeam()),
                    sceneLog,
                );
                perUnitDamage.push({
                    unitId: unit.getId(),
                    position: unitPositionAtImpact,
                    amount: damageDealt,
                    unitsDied: Math.max(0, amountAliveBeforeDamage - unit.getAmountAlive()),
                });

                damageStatisticHolder.add({
                    unitName: attackerUnit.getName(),
                    damage: damageDealt,
                    team: attackerUnit.getTeam(),
                    lap: FightStateManager.getInstance().getFightProperties().getCurrentLap(),
                });
                const pegasusLightEffect = unit.getEffect("Pegasus Light");
                if (pegasusLightEffect) {
                    increaseMoraleTotal += pegasusLightEffect.getPower();
                }
                sceneLog.updateLog(
                    `${attackerUnit.getName()} ${isAttack ? "attk" : "resp"} ${unit.getName()} (${damageFromAttack})`,
                );
                maxDamage = Math.max(maxDamage, damageFromAttack);

                if (!unit.isDead()) {
                    processPetrifyingGazeAbility(attackerUnit, unit, damageFromAttack, sceneLog, damageStatisticHolder);
                }
            }
        }

        const moraleDecreaseForTheUnitTeam: Record<string, number> = {};
        for (const unit of affectedUnits) {
            if (unit.isDead() && !wasDead.includes(unit)) {
                sceneLog.updateLog(`${unit.getName()} died`);
                if (!unitIdsDied.includes(unit.getId())) {
                    unitIdsDied.push(unit.getId());
                }
                increaseMoraleTotal += HoCConstants.MORALE_CHANGE_FOR_KILL;
                const unitNameKey = `${unit.getName()}:${unit.getTeam()}`;
                moraleDecreaseForTheUnitTeam[unitNameKey] =
                    (moraleDecreaseForTheUnitTeam[unitNameKey] || 0) + HoCConstants.MORALE_CHANGE_FOR_KILL;
                wasDead.push(unit);
            } else {
                processStunAbility(attackerUnit, unit, attackerUnit, sceneLog);
                processSpitBallAbility(attackerUnit, unit, currentActiveUnit, unitsHolder, grid, sceneLog);
            }
        }
        attackerUnit.increaseMorale(
            increaseMoraleTotal,
            FightStateManager.getInstance().getFightProperties().getAdditionalMoralePerTeam(attackerUnit.getTeam()),
        );
        unitsHolder.decreaseMoraleForTheSameUnitsOfTheTeam(moraleDecreaseForTheUnitTeam);
        attackerUnit.decreaseNumberOfShots();

        return {
            landed: true,
            maxDamage,
            unitIdsDied,
            perUnitDamage,
        };
    }

    return {
        landed: false,
        maxDamage,
        unitIdsDied,
        perUnitDamage,
    };
}

export function evaluateAffectedUnits(
    affectedCells: HoCMath.XY[],
    unitsHolder: UnitsHolder,
    grid: Grid,
): Array<Unit[]> | undefined {
    const cellKeys: number[] = [];
    const unitIds: string[] = [];
    const affectedUnits: Unit[] = [];

    for (const c of affectedCells) {
        const cellKey = (c.x << 4) | c.y;
        if (cellKeys.includes(cellKey)) {
            continue;
        }

        const occupantId = grid.getOccupantUnitId(c);
        if (!occupantId) {
            continue;
        }

        if (unitIds.includes(occupantId)) {
            continue;
        }

        const occupantUnit = unitsHolder.getAllUnits().get(occupantId);
        if (!occupantUnit) {
            continue;
        }

        affectedUnits.push(occupantUnit);
        cellKeys.push(cellKey);
        unitIds.push(occupantId);
    }

    if (affectedUnits.length) {
        return [affectedUnits, affectedUnits];
    }

    return undefined;
}
