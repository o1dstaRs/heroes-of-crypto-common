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
import type { ISceneLog } from "../scene/scene_log_interface";
import { Grid } from "../grid/grid";
import { Unit } from "../units/unit";
import { UnitsHolder } from "../units/units_holder";
import type { IAnimationData } from "../scene/animations";
import type { IStatisticHolder } from "../scene/statistic_holder_interface";
import type { IDamageStatistic } from "../scene/scene_stats";
import type { IVisibleDamage } from "../scene/animations";
import { FightStateManager } from "../fights/fight_state_manager";

import { processRangeAOEAbility } from "./aoe_range_ability";
import { processFleshShieldAura } from "./flesh_shield_aura_ability";
import { processLuckyStrikeAbility } from "./lucky_strike_ability";

export interface IDoubleShotResult {
    applied: boolean;
    aoeRangeAttackLanded: boolean;
    damage: number;
    /** Second-shot impact before Flesh Shield; Petrifying Gaze resolves from this damage on the hit target. */
    petrifyingGazeDamage: number;
    unitIdsDied: string[];
    animationData: IAnimationData[];
    moraleIncrease: number;
    moraleDecreaseForTheUnitTeam: Record<string, number>;
}

export function processDoubleShotAbility(
    fromUnit: Unit,
    toUnit: Unit,
    affectedUnits: Unit[],
    sceneLog: ISceneLog,
    unitsHolder: UnitsHolder,
    grid: Grid,
    hoverRangeAttackDivisor: number,
    hoverRangeAttackPosition: HoCMath.XY,
    damageForAnimation: IVisibleDamage,
    damageStatisticHolder: IStatisticHolder<IDamageStatistic>,
    isAOE: boolean,
): IDoubleShotResult {
    const animationData: IAnimationData[] = [];
    // Crafted Double Shot (granted by the Blacksmith's Craft) behaves identically to Double Shot.
    const doubleShotAbility = fromUnit.getAbility("Double Shot") ?? fromUnit.getAbility("Crafted Double Shot");
    const unitIdsDied: string[] = [];

    let damageFromAttack = 0;
    let petrifyingGazeDamage = 0;
    let moraleIncrease = 0;
    const moraleDecreaseForTheUnitTeam: Record<string, number> = {};

    if (
        !doubleShotAbility ||
        (!isAOE &&
            (fromUnit.isDead() ||
                toUnit.isDead() ||
                fromUnit.isSkippingThisTurn() ||
                (fromUnit.getTarget() && fromUnit.getTarget() !== toUnit.getId())))
    ) {
        return {
            applied: false,
            aoeRangeAttackLanded: false,
            damage: damageFromAttack,
            petrifyingGazeDamage,
            unitIdsDied,
            animationData,
            moraleIncrease,
            moraleDecreaseForTheUnitTeam,
        };
    }

    const isSecondAttackMissed =
        HoCLib.getRandomInt(0, 100) <
        fromUnit.calculateMissChance(
            toUnit,
            FightStateManager.getInstance().getFightProperties().getAdditionalAbilityPowerPerTeam(toUnit.getTeam()),
        );
    if (isSecondAttackMissed) {
        sceneLog.updateLog(`${fromUnit.getName()} misses 🏹 on ${toUnit.getName()}`);
        return {
            applied: false,
            aoeRangeAttackLanded: false,
            damage: damageFromAttack,
            petrifyingGazeDamage,
            unitIdsDied,
            animationData,
            moraleIncrease,
            moraleDecreaseForTheUnitTeam,
        };
    }

    animationData.push({
        fromPosition: fromUnit.getPosition(),
        toPosition: hoverRangeAttackPosition,
        affectedUnit: toUnit,
    });
    let aoeRangeAttackResult = processRangeAOEAbility(
        fromUnit,
        affectedUnits,
        fromUnit,
        hoverRangeAttackDivisor,
        unitsHolder,
        grid,
        sceneLog,
        damageStatisticHolder,
        true,
        (damageForAnimation.secondary ??= []),
    );
    if (aoeRangeAttackResult.landed) {
        damageFromAttack = processLuckyStrikeAbility(fromUnit, aoeRangeAttackResult.maxDamage, sceneLog);
        for (const uId of aoeRangeAttackResult.unitIdsDied) {
            if (!unitIdsDied.includes(uId)) {
                unitIdsDied.push(uId);
            }
        }
        // Record THIS (second) shot's per-unit damage as its OWN splash entries. The first shot already
        // filled damageForAnimation.splash; appending here means a Double-Shot AOE (Gargantuan's Area
        // Throw) carries two entries per affected unit, so the client draws a separate floating number
        // for each shot instead of one merged total.
        if (aoeRangeAttackResult.perUnitDamage.length) {
            (damageForAnimation.splash ??= []).push(
                ...aoeRangeAttackResult.perUnitDamage.map((entry) => ({ ...entry, position: { ...entry.position } })),
            );
        }
    } else {
        let abilityMultiplier = fromUnit.calculateAbilityMultiplier(
            doubleShotAbility,
            FightStateManager.getInstance().getFightProperties().getAdditionalAbilityPowerPerTeam(fromUnit.getTeam()),
        );
        // ARTIFACT Dual Strike Charm: the second (Double Shot) attack deals extra damage.
        const dualStrikeCharmBuff = fromUnit.getBuff("Dual Strike Charm");
        if (dualStrikeCharmBuff) {
            abilityMultiplier *= 1 + dualStrikeCharmBuff.getPower() / 100;
        }
        const paralysisAttackerEffect = fromUnit.getEffect("Paralysis");
        if (paralysisAttackerEffect) {
            abilityMultiplier *= (100 - paralysisAttackerEffect.getPower()) / 100;
        }
        damageFromAttack = processLuckyStrikeAbility(
            fromUnit,
            fromUnit.calculateAttackDamage(
                toUnit,
                PBTypes.AttackVals.RANGE,
                FightStateManager.getInstance()
                    .getFightProperties()
                    .getAdditionalAbilityPowerPerTeam(fromUnit.getTeam()),
                hoverRangeAttackDivisor,
                abilityMultiplier,
            ),
            sceneLog,
        );
        // The second shot's gaze stays on the struck unit even if Flesh Shield redirects the entire base hit.
        petrifyingGazeDamage = damageFromAttack;
        const fleshShieldAbsorb = processFleshShieldAura(
            fromUnit,
            toUnit,
            damageFromAttack,
            true,
            grid,
            unitsHolder,
            sceneLog,
            damageStatisticHolder,
            (damageForAnimation.secondary ??= []),
        );
        damageFromAttack = fleshShieldAbsorb.remainingDamage;
        moraleIncrease += fleshShieldAbsorb.increaseMorale;
        for (const uId of fleshShieldAbsorb.unitIdsDied) {
            if (!aoeRangeAttackResult.unitIdsDied.includes(uId)) {
                aoeRangeAttackResult.unitIdsDied.push(uId);
            }
        }
        for (const [unitNameKey, moraleDecrease] of Object.entries(fleshShieldAbsorb.moraleDecreaseForTheUnitTeam)) {
            moraleDecreaseForTheUnitTeam[unitNameKey] =
                (moraleDecreaseForTheUnitTeam[unitNameKey] ?? 0) + moraleDecrease;
        }
        damageForAnimation.render = true;
        damageForAnimation.amount = damageFromAttack;
        damageForAnimation.unitPosition = toUnit.getPosition();
        damageForAnimation.unitIsSmall = toUnit.isSmallSize();
        // Snapshot losses BEFORE applyDamage — calculatePossibleLosses reads current hp/amount_alive.
        const unitsKilled = toUnit.calculatePossibleLosses(damageFromAttack);
        damageStatisticHolder.add({
            unitName: fromUnit.getName(),
            damage: toUnit.applyDamage(
                damageFromAttack,
                FightStateManager.getInstance().getFightProperties().getBreakChancePerTeam(fromUnit.getTeam()),
                sceneLog,
            ),
            team: fromUnit.getTeam(),
            lap: FightStateManager.getInstance().getFightProperties().getCurrentLap(),
        });
        const pegasusLightEffect = toUnit.getEffect("Pegasus Light");
        if (pegasusLightEffect) {
            moraleIncrease += pegasusLightEffect.getPower();
        }
        sceneLog.updateLog(
            `${fromUnit.getName()} 🏹 ${toUnit.getName()} (${damageFromAttack})` + HoCLib.killTag(unitsKilled),
        );
    }

    return {
        applied: true,
        aoeRangeAttackLanded: aoeRangeAttackResult.landed,
        damage: damageFromAttack,
        petrifyingGazeDamage,
        unitIdsDied: aoeRangeAttackResult.unitIdsDied,
        animationData,
        moraleIncrease,
        moraleDecreaseForTheUnitTeam,
    };
}
