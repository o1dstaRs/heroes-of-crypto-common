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
import { FightStateManager } from "../fights/fight_state_manager";
import { Grid } from "../grid/grid";
import type { ISecondaryDamage } from "../scene/animations";
import type { ISceneLog } from "../scene/scene_log_interface";
import type { IDamageStatistic } from "../scene/scene_stats";
import type { IStatisticHolder } from "../scene/statistic_holder_interface";
import { Unit } from "../units/unit";
import { UnitsHolder } from "../units/units_holder";

export interface IFleshShieldResult {
    remainingDamage: number;
    absorbedDamage: number;
    increaseMorale: number;
    unitIdsDied: string[];
    moraleDecreaseForTheUnitTeam: Record<string, number>;
}

/**
 * Flesh Shield aura (Abomination): when a unit protected by the aura takes a direct attack hit,
 * the aura's owner absorbs the aura-power % of that damage (scaled by stack power and the standard
 * stack-ability modifiers at aura-refresh time by calculateAuraPower). The absorbed portion is
 * recalculated against the owner's own defense — scaled by the ratio of the protected unit's effective
 * armor to the owner's effective armor as seen by this attacker — and dealt to the owner instead. The
 * protected unit only receives the remainder. If the owner cannot survive the full recalculated
 * transfer, only the affordable portion is redirected and the overflow remains on the protected unit.
 * Applies to direct hits, responses, multi-hits, and every unit struck by an AOE or pass-through attack.
 */
export function processFleshShieldAura(
    attackerUnit: Unit,
    targetUnit: Unit,
    damage: number,
    isRangeAttack: boolean,
    grid: Grid,
    unitsHolder: UnitsHolder,
    sceneLog: ISceneLog,
    damageStatisticHolder: IStatisticHolder<IDamageStatistic>,
    secondaryDamage?: ISecondaryDamage[],
    damageType: "physical" | "magic" = "physical",
): IFleshShieldResult {
    const result: IFleshShieldResult = {
        remainingDamage: damage,
        absorbedDamage: 0,
        increaseMorale: 0,
        unitIdsDied: [],
        moraleDecreaseForTheUnitTeam: {},
    };

    if (damage <= 0 || targetUnit.isDead()) {
        return result;
    }

    const fleshShieldBuff = targetUnit.getBuff("Flesh Shield Aura");
    if (!fleshShieldBuff) {
        return result;
    }

    const x = fleshShieldBuff.getFirstSpellProperty();
    const y = fleshShieldBuff.getSecondSpellProperty();
    if (x === undefined || y === undefined) {
        return result;
    }

    const auraSourceUnitId = grid.getOccupantUnitId({ x: x, y: y });
    if (!auraSourceUnitId || auraSourceUnitId === targetUnit.getId()) {
        return result;
    }

    const absorberUnit = unitsHolder.getAllUnits().get(auraSourceUnitId);
    if (
        !absorberUnit ||
        absorberUnit.isDead() ||
        absorberUnit.getTeam() !== targetUnit.getTeam() ||
        !absorberUnit.hasAbilityActive("Flesh Shield Aura")
    ) {
        return result;
    }

    const absorbPercentage = Math.min(100, Math.max(0, fleshShieldBuff.getPower()));
    const requestedAbsorbedBase = Math.floor((damage * absorbPercentage) / 100);
    if (requestedAbsorbedBase <= 0) {
        return result;
    }

    // Recalculate the absorbed chunk against the absorber's own matching defense. Physical attacks
    // use effective armor as seen by this attacker (including piercing); magical AOE has already been
    // reduced by the protected target's magic resistance, so convert it through the two resist ratios.
    const recalculateForAbsorber = (() => {
        if (damageType === "magic") {
            const targetDamageMultiplier = Math.max(0, 1 - targetUnit.getMagicResist() / 100);
            const absorberDamageMultiplier = Math.max(0, 1 - absorberUnit.getMagicResist() / 100);
            return (redirectedDamage: number): number => {
                if (redirectedDamage <= 0 || absorberDamageMultiplier <= 0) {
                    return 0;
                }
                if (targetDamageMultiplier <= 0) {
                    return redirectedDamage;
                }
                return Math.max(1, Math.ceil((redirectedDamage * absorberDamageMultiplier) / targetDamageMultiplier));
            };
        }

        const synergyAbilityPowerIncrease = FightStateManager.getInstance()
            .getFightProperties()
            .getAdditionalAbilityPowerPerTeam(attackerUnit.getTeam());
        const targetArmor = attackerUnit.getEnemyArmor(targetUnit, isRangeAttack, synergyAbilityPowerIncrease);
        const absorberArmor = attackerUnit.getEnemyArmor(absorberUnit, isRangeAttack, synergyAbilityPowerIncrease);
        return (redirectedDamage: number): number => {
            if (redirectedDamage <= 0) {
                return 0;
            }
            return absorberArmor > 0
                ? Math.max(1, Math.ceil((redirectedDamage * targetArmor) / absorberArmor))
                : redirectedDamage;
        };
    })();

    // Work in the protected target's damage space. The absorber's armor can make one redirected point
    // cost more or less than one HP, so simply min(requested, owner HP) would still lose or invent damage.
    // Find the largest integer share whose recalculated cost fits the owner's remaining cumulative HP.
    const absorberHpCapacity = absorberUnit.getCumulativeHp();
    let low = 0;
    let high = requestedAbsorbedBase;
    while (low < high) {
        const midpoint = Math.ceil((low + high) / 2);
        if (recalculateForAbsorber(midpoint) <= absorberHpCapacity) {
            low = midpoint;
        } else {
            high = midpoint - 1;
        }
    }
    const absorbedBase = low;
    if (absorbedBase <= 0) {
        return result;
    }
    const absorbedRecalculated = recalculateForAbsorber(absorbedBase);

    result.remainingDamage = damage - absorbedBase;

    const positionAtImpact = { ...absorberUnit.getPosition() };
    const amountAliveBefore = absorberUnit.getAmountAlive();
    const damageDealt = absorberUnit.applyDamage(
        absorbedRecalculated,
        FightStateManager.getInstance().getFightProperties().getBreakChancePerTeam(attackerUnit.getTeam()),
        sceneLog,
    );
    result.absorbedDamage = damageDealt;
    damageStatisticHolder.add({
        unitName: attackerUnit.getName(),
        damage: damageDealt,
        team: attackerUnit.getTeam(),
        lap: FightStateManager.getInstance().getFightProperties().getCurrentLap(),
    });
    const unitsDied = Math.max(0, amountAliveBefore - absorberUnit.getAmountAlive());
    if (secondaryDamage) {
        const aggregate = secondaryDamage.find(
            (entry) => entry.source === "flesh_shield" && entry.unitId === absorberUnit.getId(),
        );
        if (aggregate) {
            aggregate.amount += damageDealt;
            aggregate.unitsDied += unitsDied;
        } else {
            secondaryDamage.push({
                source: "flesh_shield",
                unitId: absorberUnit.getId(),
                position: positionAtImpact,
                amount: damageDealt,
                unitsDied,
            });
        }
    }
    sceneLog.updateLog(`${absorberUnit.getName()} absorbs (${damageDealt}) dmg dealt to ${targetUnit.getName()}`);

    if (absorberUnit.isDead()) {
        sceneLog.updateLog(`${absorberUnit.getName()} died`);
        result.unitIdsDied.push(absorberUnit.getId());
        result.increaseMorale = HoCConstants.MORALE_CHANGE_FOR_KILL;
        result.moraleDecreaseForTheUnitTeam = {
            [`${absorberUnit.getName()}:${absorberUnit.getTeam()}`]: HoCConstants.MORALE_CHANGE_FOR_KILL,
        };
    }

    return result;
}
