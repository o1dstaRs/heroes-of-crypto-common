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

import { getAbilitiesWithPosisionCoefficient } from "../abilities/ability_helper";
import type { GameAction } from "../engine/actions";
import { PBTypes } from "../generated/protobuf/v1/types";
import { getCellsAroundPosition, getPositionForCell } from "../grid/grid_math";
import type { Unit } from "../units/unit";
import type { XY } from "../utils/math";
import type { IDecisionContext } from "./ai_strategy";

export interface IWeightedMeleeDamage {
    /** Primary-target damage after every deterministic modifier, conditional on the attack landing. */
    damage: number;
    /** Conditional probability of this damage outcome. Landed outcomes sum to one. */
    probability: number;
}

export interface IPrimaryMeleeDamageEstimate {
    /** Engine miss roll expressed as a probability that the primary hit lands. */
    hitChance: number;
    /** Exact supported single-hit damage distribution, conditional on landing. */
    landedOutcomes: IWeightedMeleeDamage[];
    /** Hit-weighted expected effective damage, capped by the target's current cumulative HP. */
    expectedEffectiveDamage: number;
    /** True only when the supported primary attack cannot miss and every damage outcome kills the target. */
    secureKill: boolean;
}

const clampChance = (chance: number): number => Math.min(100, Math.max(0, chance)) / 100;

function standCells(unit: Unit, context: IDecisionContext, standCell: XY): XY[] {
    if (unit.isSmallSize()) {
        return [{ x: standCell.x, y: standCell.y }];
    }
    const settings = context.grid.getSettings();
    const position = getPositionForCell(standCell, settings.getMinX(), settings.getStep(), settings.getHalfStep());
    return getCellsAroundPosition(settings, {
        x: position.x - settings.getHalfStep(),
        y: position.y - settings.getHalfStep(),
    });
}

function chargeDistance(actions: readonly GameAction[]): number {
    const move = actions.find((action) => action.type === "move_unit");
    if (move?.type === "move_unit" && move.path.length) {
        return move.path.length;
    }
    const melee = actions.find((action) => action.type === "melee_attack");
    return melee?.type === "melee_attack" && melee.path?.length ? melee.path.length : 1;
}

function unsupportedSequence(unit: Unit, actions: readonly GameAction[]): boolean {
    const move = actions.find((action) => action.type === "move_unit");
    if (move?.type === "move_unit" && (move.hasLavaCell || move.hasWaterCell)) {
        return true;
    }
    // These abilities add, replace, or sequence primary damage around retaliation. A static estimator cannot
    // reproduce them without rolling a cloned engine state, so M3 must leave the incumbent untouched.
    return ["Lightning Spin", "Double Punch", "Fire Breath", "Skewer Strike", "Chain Lightning"].some((name) =>
        Boolean(unit.getAbility(name)),
    );
}

function addOutcome(outcomes: Map<number, number>, damage: number, probability: number): void {
    if (probability <= 0) {
        return;
    }
    outcomes.set(damage, (outcomes.get(damage) ?? 0) + probability);
}

/**
 * Pure estimate of the engine's supported, direct primary melee hit. This mirrors AttackHandler/Unit damage
 * arithmetic without drawing RNG. Unsupported replacement/multi-hit and terrain-transition sequences return
 * undefined; callers must preserve their incumbent rather than silently price the wrong action.
 */
export function estimatePrimaryMeleeDamage(
    unit: Unit,
    target: Unit,
    context: IDecisionContext,
    standCell: XY,
    actions: readonly GameAction[],
): IPrimaryMeleeDamageEstimate | undefined {
    const fightProperties = context.fightProperties;
    if (!fightProperties || target.isDead() || unsupportedSequence(unit, actions)) {
        return undefined;
    }

    const attackerAbilityPower = fightProperties.getAdditionalAbilityPowerPerTeam(unit.getTeam());
    const defenderAbilityPower = fightProperties.getAdditionalAbilityPowerPerTeam(target.getTeam());
    const futureAuraAttack = context.unitsHolder.getUnitAuraAttackMod(unit, standCells(unit, context, standCell));
    const attackWithoutCurrentAura = Math.max(
        unit.getBaseAttack(),
        unit.getAttack() - unit.getCurrentAttackModIncrease(),
    );
    const attackRate = attackWithoutCurrentAura + futureAuraAttack;
    const minimum = unit.calculateAttackDamageMin(attackRate, target, false, attackerAbilityPower, 1);
    const maximum = unit.calculateAttackDamageMax(attackRate, target, false, attackerAbilityPower, 1);
    if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || maximum < minimum) {
        return undefined;
    }

    // Avoid making candidate generation unexpectedly expensive for a malformed/modded damage range.
    const rollCount = maximum === minimum ? 1 : maximum - minimum;
    if (rollCount > 10_000) {
        return undefined;
    }

    const nativeMeleeMultiplier =
        unit.getAttackType() === PBTypes.AttackVals.RANGE && !unit.hasAbilityActive("Handyman") ? 0.5 : 1;
    let handlerMultiplier = 1;
    const rapidCharge = unit.getAbility("Rapid Charge");
    if (rapidCharge) {
        const base = unit.calculateAbilityMultiplier(rapidCharge, attackerAbilityPower);
        if (base >= 1) {
            handlerMultiplier *= 1 + (base - 1) * chargeDistance(actions);
        }
    }
    const paralysis = unit.getEffect("Paralysis");
    if (paralysis) {
        handlerMultiplier *= (100 - paralysis.getPower()) / 100;
    }
    for (const ability of getAbilitiesWithPosisionCoefficient(
        unit.getAbilities(),
        standCell,
        target.getBaseCell(),
        target.isSmallSize(),
        unit.getTeam(),
    )) {
        handlerMultiplier *= unit.calculateAbilityMultiplier(ability, attackerAbilityPower);
    }

    const hasDeepWounds =
        unit.hasAbilityActive("Deep Wounds Level 1") ||
        unit.hasAbilityActive("Deep Wounds Level 2") ||
        unit.hasAbilityActive("Deep Wounds Level 3");
    const deepWoundsMultiplier = hasDeepWounds ? 1 + (target.getEffect("Deep Wounds")?.getPower() ?? 0) / 100 : 1;
    // AttackHandler includes Deep Wounds in its supplied ability multiplier and Unit.calculateAttackDamage
    // applies the same target-state multiplier again. Preserve that authoritative behavior here.
    handlerMultiplier *= deepWoundsMultiplier;

    const luckyStrike = unit.getAbility("Lucky Strike");
    const luckyChance = luckyStrike
        ? clampChance(unit.calculateAbilityApplyChance(luckyStrike, attackerAbilityPower))
        : 0;
    const luckyMultiplier = luckyStrike ? unit.calculateAbilityMultiplier(luckyStrike, attackerAbilityPower) : 1;
    const penetratingBite = unit.getAbility("Penetrating Bite");
    const biteDamage = penetratingBite
        ? Math.floor((unit.calculateAbilityMultiplier(penetratingBite, attackerAbilityPower) - 1) * target.getMaxHp())
        : 0;

    const outcomes = new Map<number, number>();
    const rawEnd = maximum === minimum ? minimum + 1 : maximum;
    for (let raw = minimum; raw < rawEnd; raw += 1) {
        const ordinary = Math.floor(raw * nativeMeleeMultiplier * handlerMultiplier * deepWoundsMultiplier);
        const rawProbability = 1 / rollCount;
        if (luckyChance > 0) {
            addOutcome(outcomes, ordinary + biteDamage, rawProbability * (1 - luckyChance));
            addOutcome(outcomes, Math.floor(ordinary * luckyMultiplier) + biteDamage, rawProbability * luckyChance);
        } else {
            addOutcome(outcomes, ordinary + biteDamage, rawProbability);
        }
    }

    const landedOutcomes = [...outcomes.entries()].map(([damage, probability]) => ({ damage, probability }));
    const hitChance = 1 - clampChance(unit.calculateMissChance(target, defenderAbilityPower));
    const targetHp = target.getCumulativeHp();
    const expectedEffectiveDamage =
        hitChance *
        landedOutcomes.reduce(
            (total, outcome) => total + outcome.probability * Math.min(targetHp, Math.max(0, outcome.damage)),
            0,
        );
    const secureKill = hitChance === 1 && landedOutcomes.every((outcome) => outcome.damage >= targetHp);
    return { hitChance, landedOutcomes, expectedEffectiveDamage, secureKill };
}
