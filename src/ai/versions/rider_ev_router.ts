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

import { AbilityType } from "../../abilities/ability_properties";
import { calculatePetrifyingGazeKillChance } from "../../abilities/petrifying_gaze_ability";
import { calculateStunApplyChance } from "../../abilities/stun_ability";
import type { GameAction } from "../../engine/actions";
import type { Unit } from "../../units/unit";
import type { XY } from "../../utils/math";
import type { IDecisionContext } from "../ai_strategy";
import {
    enumerateCandidates,
    type ICandidateSet,
    type IEnumeratedCandidate,
    type IEnumerateOptions,
} from "../candidates";

type CandidateEnumerator = (
    unit: Unit,
    context: IDecisionContext,
    incumbent: GameAction[],
    options?: IEnumerateOptions,
) => ICandidateSet;

export interface IMeleeRiderEV {
    /** F4's expected effective primary-target damage. */
    baseDamageEv: number;
    /** Expected extra HP removed by Petrifying Gaze's stack kills and front-creature kill roll. */
    petrifyKillEv: number;
    /** Expected basic-attack HP denied when Stun lands before the target's turn. */
    stunTurnDenialEv: number;
    /** Exact Devour Essence healing unlocked by a minimum-damage primary-target kill. */
    devourKillSecureEv: number;
    /** Whether the ordinary melee minimum damage removes the primary target. */
    secureKill: boolean;
    /** Sum of like-for-like HP terms; no trained or hand-authored coefficients. */
    totalEv: number;
}

const sameCell = (a: XY | undefined, b: XY | undefined): boolean =>
    a === undefined || b === undefined ? a === b : a.x === b.x && a.y === b.y;

function meleeAction(actions: readonly GameAction[]): Extract<GameAction, { type: "melee_attack" }> | undefined {
    for (let index = actions.length - 1; index >= 0; index -= 1) {
        const action = actions[index];
        if (action.type === "melee_attack") {
            return action;
        }
    }
    return undefined;
}

function expectedPetrifyDamage(unit: Unit, target: Unit, baseDamage: number, additionalAbilityPower: number): number {
    const ability = unit.getAbility("Petrifying Gaze");
    const residualHp = Math.max(0, target.getCumulativeHp() - baseDamage);
    if (!ability || residualHp <= 0 || target.hasMindAttackResistance()) {
        return 0;
    }

    const percentageMax = Math.floor(unit.calculateAbilityApplyChance(ability, additionalAbilityPower));
    const percentageMin = Math.floor((percentageMax / 3) * 2);
    const rollCount = Math.max(1, percentageMax - percentageMin);
    const remainingCreatures = Math.max(1, Math.ceil(residualHp / target.getMaxHp()));
    let randomStackKillDamage = 0;
    for (
        let roll = percentageMin;
        roll < percentageMax || (percentageMax === percentageMin && roll === percentageMin);
        roll += 1
    ) {
        const killed = Math.min(Math.floor((baseDamage * (roll / 100)) / target.getMaxHp()), remainingCreatures - 1);
        randomStackKillDamage += killed * target.getMaxHp();
        if (percentageMax === percentageMin) {
            break;
        }
    }
    randomStackKillDamage /= rollCount;

    const frontHp = residualHp - (remainingCreatures - 1) * target.getMaxHp();
    const mindResist = ability.getType() === AbilityType.MIND ? target.getMindResist() : 0;
    const killChance = calculatePetrifyingGazeKillChance(percentageMax, target.getLevel(), mindResist) / 100;
    return Math.min(residualHp, randomStackKillDamage + killChance * frontHp);
}

function expectedStunDenial(
    unit: Unit,
    target: Unit,
    baseDamage: number,
    context: IDecisionContext,
    additionalAbilityPower: number,
): number {
    const fp = context.fightProperties;
    const residualHp = Math.max(0, target.getCumulativeHp() - baseDamage);
    if (
        !unit.getAbility("Stun") ||
        !fp ||
        residualHp <= 0 ||
        fp.hasAlreadyMadeTurn(target.getId()) ||
        target.isSkippingThisTurn() ||
        target.hasAbilityActive("No Melee")
    ) {
        return 0;
    }
    const attacks = target.hasAbilityActive("Double Punch") ? 2 : 1;
    const currentTurnDamage = Math.min(
        unit.getCumulativeHp(),
        (attacks *
            (target.calculateAttackDamageMin(target.getAttack(), unit, false, 0, 1) +
                target.calculateAttackDamageMax(target.getAttack(), unit, false, 0, 1))) /
            2,
    );
    const remainingStackFraction = residualHp / Math.max(1, target.getCumulativeHp());
    const chance = calculateStunApplyChance(unit, target, additionalAbilityPower) / 100;
    return chance * currentTurnDamage * remainingStackFraction;
}

function devourKillSecureValue(
    unit: Unit,
    target: Unit,
    additionalAbilityPower: number,
): { secureKill: boolean; value: number } {
    const attacks = unit.hasAbilityActive("Double Punch") ? 2 : 1;
    const minimumDamage = attacks * unit.calculateAttackDamageMin(unit.getAttack(), target, false, 0, 1);
    const uncertainHit =
        !!unit.getBuff("Broken Aegis") ||
        !!unit.getEffect("Boar Saliva") ||
        !!target.getAbility("Dodge") ||
        (!unit.isSmallSize() && !!target.getAbility("Small Specie"));
    const secureKill = !uncertainHit && minimumDamage >= target.getCumulativeHp();
    const ability = unit.getAbility("Devour Essence");
    if (!secureKill || !ability?.getPower() || !unit.canBeHealed()) {
        return { secureKill, value: 0 };
    }
    const power = Number(unit.calculateAbilityApplyChance(ability, additionalAbilityPower).toFixed(2));
    const healedUpTo = Math.ceil(unit.getMaxHp() * Math.min(1, power / 100));
    return { secureKill, value: Math.max(0, healedUpTo - unit.getHp()) };
}

/**
 * Estimate the three Q1/M3 rider terms for one F4 melee candidate. Undefined means the candidate cannot be
 * priced safely and therefore may not displace the incumbent.
 */
export function estimateMeleeRiderEV(
    unit: Unit,
    context: IDecisionContext,
    candidate: IEnumeratedCandidate,
): IMeleeRiderEV | undefined {
    if (candidate.kind !== "melee" || !candidate.targetId || !context.fightProperties) {
        return undefined;
    }
    const target = context.unitsHolder.getAllUnits().get(candidate.targetId);
    const baseDamageEv = candidate.features.expectedDamage;
    if (!target || target.isDead() || !Number.isFinite(baseDamageEv) || baseDamageEv < 0) {
        return undefined;
    }
    // Two independent Petrify/Stun rolls on Double Punch require a joint estimate. None of today's M3 units
    // combine those abilities, so preserve the incumbent if a future/inherited kit creates that unknown case.
    if (unit.hasAbilityActive("Double Punch") && (unit.getAbility("Petrifying Gaze") || unit.getAbility("Stun"))) {
        return undefined;
    }

    const additionalAbilityPower = context.fightProperties.getAdditionalAbilityPowerPerTeam(unit.getTeam());
    const petrifyKillEv = expectedPetrifyDamage(unit, target, baseDamageEv, additionalAbilityPower);
    const stunTurnDenialEv = expectedStunDenial(unit, target, baseDamageEv, context, additionalAbilityPower);
    const killSecure = devourKillSecureValue(unit, target, additionalAbilityPower);
    const totalEv = baseDamageEv + petrifyKillEv + stunTurnDenialEv + killSecure.value;
    if (!Number.isFinite(totalEv)) {
        return undefined;
    }
    return {
        baseDamageEv,
        petrifyKillEv,
        stunTurnDenialEv,
        devourKillSecureEv: killSecure.value,
        secureKill: killSecure.secureKill,
        totalEv,
    };
}

/**
 * Q1/M3 evidence-gated melee rider router. It only re-picks the target from the incumbent's exact stand cell,
 * keeping path length, exposure and area-melee coverage fixed. Strict improvement is required; ties, missing
 * fight state, an unpriced incumbent, and every gate-off call preserve the exact incumbent array.
 */
export function routeMeleeRiderEV(
    unit: Unit,
    context: IDecisionContext,
    incumbent: GameAction[],
    enumerate: CandidateEnumerator = enumerateCandidates,
): GameAction[] {
    if (
        process.env.V06_RIDER_EV !== "on" ||
        !context.fightProperties ||
        (!unit.getAbility("Petrifying Gaze") && !unit.getAbility("Stun") && !unit.getAbility("Devour Essence"))
    ) {
        return incumbent;
    }
    const incumbentAttack = meleeAction(incumbent);
    if (!incumbentAttack) {
        return incumbent;
    }

    const neutral: GameAction[] = [{ type: "end_turn", unitId: unit.getId(), reason: "manual" }];
    const meleeCandidates = enumerate(unit, context, neutral).candidates.filter(
        (candidate) => candidate.kind === "melee" && sameCell(candidate.standCell, incumbentAttack.attackFrom),
    );
    const incumbentCandidate = meleeCandidates.find(
        (candidate) =>
            candidate.targetId === incumbentAttack.targetId &&
            sameCell(candidate.standCell, incumbentAttack.attackFrom),
    );
    if (!incumbentCandidate) {
        return incumbent;
    }
    const incumbentEv = estimateMeleeRiderEV(unit, context, incumbentCandidate);
    if (!incumbentEv) {
        return incumbent;
    }

    let best: IEnumeratedCandidate | undefined;
    let bestEv = incumbentEv.totalEv;
    for (const candidate of meleeCandidates) {
        const estimate = estimateMeleeRiderEV(unit, context, candidate);
        if (estimate && estimate.totalEv > bestEv) {
            best = candidate;
            bestEv = estimate.totalEv;
        }
    }
    return best?.actions ?? incumbent;
}
