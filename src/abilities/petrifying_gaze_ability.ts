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

import * as HoCLib from "../utils/lib";
import { AbilityType } from "./ability_properties";
import type { ISceneLog } from "../scene/scene_log_interface";
import { Unit } from "../units/unit";
import type { IStatisticHolder } from "../scene/statistic_holder_interface";
import type { IDamageStatistic } from "../scene/scene_stats";
import type { ISecondaryDamage } from "../scene/animations";
import { FightStateManager } from "../fights/fight_state_manager";

// Petrify (instant-kill) chance climbs with the TARGET's level, so Petrifying Gaze is at its most dangerous
// against big level-3/4 units — its whole point — instead of only mowing down cheap level-1 stacks. Kept
// deliberately low: it's an instant kill, so it should be a gamble, not the expected outcome.
const PETRIFY_STACK_SCALE = 0.25; // only a quarter of the caster's base chance feeds the petrify roll
const PETRIFY_LEVEL_BONUS = 4; // +% petrify chance per target level above 1
const PETRIFY_MAX_CHANCE = 35; // hard cap
const PETRIFY_RANGE_FALLOFF = 0.75; // fraction of the petrify chance kept per ranged shot-distance bracket

export function processPetrifyingGazeAbility(
    fromUnit: Unit,
    toUnit: Unit,
    damageFromAttack: number,
    sceneLog: ISceneLog,
    damageStatisticHolder: IStatisticHolder<IDamageStatistic>,
    secondaryDamage?: ISecondaryDamage[],
    // Ranged shot-distance divisor for THIS attack (1 = full, 2 = half, 4 = quarter, 8 = eighth). Melee = 1.
    rangeDivisor = 1,
): void {
    if (toUnit.isDead() || damageFromAttack <= 0) {
        return;
    }

    const petrifyingGazeAbility = fromUnit.getAbility("Petrifying Gaze");
    if (
        !petrifyingGazeAbility ||
        (petrifyingGazeAbility.getType() === AbilityType.MIND && toUnit.hasMindAttackResistance())
    ) {
        return;
    }

    const percentageMax = Math.floor(
        fromUnit.calculateAbilityApplyChance(
            petrifyingGazeAbility,
            FightStateManager.getInstance().getFightProperties().getAdditionalAbilityPowerPerTeam(fromUnit.getTeam()),
        ),
    );
    const percentageMin = Math.floor((percentageMax / 3) * 2);

    const randomCoeff = HoCLib.getRandomInt(percentageMin, percentageMax) / 100;
    const randomAdditionalDamage = damageFromAttack * randomCoeff;
    const unitsKilled = randomAdditionalDamage / toUnit.getMaxHp();
    let amountOfUnitsKilled = Math.min(Math.floor(unitsKilled), toUnit.getAmountAlive() - 1);
    let damageFromAbility = amountOfUnitsKilled * toUnit.getMaxHp();

    let proc = false;
    if (amountOfUnitsKilled < toUnit.getAmountAlive()) {
        // Chance to petrify (instantly kill) the target's front creature. The base chance already folds in the
        // caster's power, stack power and luck (percentageMax, computed above); on top of that, higher-level
        // targets are EASIER to petrify (+PETRIFY_LEVEL_BONUS per level), so a lone level-3/4 unit is the most
        // likely to be turned to stone while a level-1 loses at most one creature of its stack.
        const baseChance = Math.min(
            PETRIFY_MAX_CHANCE,
            Math.round(percentageMax * PETRIFY_STACK_SCALE) + PETRIFY_LEVEL_BONUS * (toUnit.getLevel() - 1),
        );
        // Ranged shots petrify less at longer distances (mirrors the damage falloff, but gentler): the chance
        // keeps PETRIFY_RANGE_FALLOFF of its value per shot-distance bracket. rangeDivisor 1/2/4/8 -> brackets
        // 0/1/2/3. Melee (rangeDivisor 1) is unaffected.
        const rangeFactor = Math.pow(PETRIFY_RANGE_FALLOFF, Math.log2(Math.max(1, rangeDivisor)));
        const petrifyChance = Math.max(0, Math.round(baseChance * rangeFactor));
        if (HoCLib.getRandomInt(0, 100) < petrifyChance) {
            damageFromAbility += toUnit.getHp();
            proc = true;
        }
    } else {
        amountOfUnitsKilled = toUnit.getAmountAlive();
    }

    if (amountOfUnitsKilled || proc) {
        let damageFromAbilityTmp = damageFromAbility;

        if (damageFromAbility >= toUnit.getHp()) {
            amountOfUnitsKilled = 1;
            damageFromAbilityTmp -= toUnit.getHp();
        }
        amountOfUnitsKilled += Math.floor(damageFromAbilityTmp / toUnit.getMaxHp());

        // apply the ability damage
        const positionAtImpact = { ...toUnit.getPosition() };
        const amountAliveBefore = toUnit.getAmountAlive();
        damageStatisticHolder.add({
            unitName: fromUnit.getName(),
            damage: toUnit.applyDamage(
                damageFromAbility,
                FightStateManager.getInstance().getFightProperties().getBreakChancePerTeam(fromUnit.getTeam()),
                sceneLog,
            ),
            team: fromUnit.getTeam(),
            lap: FightStateManager.getInstance().getFightProperties().getCurrentLap(),
        });

        secondaryDamage?.push({
            source: "petrifying_gaze",
            unitId: toUnit.getId(),
            position: positionAtImpact,
            amount: damageFromAbility,
            unitsDied: Math.max(0, amountAliveBefore - toUnit.getAmountAlive()),
        });
        sceneLog.updateLog(`${amountOfUnitsKilled} ${toUnit.getName()} killed by ${petrifyingGazeAbility.getName()}`);
    }
}
