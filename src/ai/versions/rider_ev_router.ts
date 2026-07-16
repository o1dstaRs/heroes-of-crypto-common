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
import { PBTypes } from "../../generated/protobuf/v1/types";
import type { Unit } from "../../units/unit";
import type { XY } from "../../utils/math";
import type { IDecisionContext } from "../ai_strategy";
import { estimatePrimaryMeleeDamage, type IPrimaryMeleeDamageEstimate } from "../melee_damage_estimate";
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
    /** Engine-equivalent probability that the supported direct primary hit lands. */
    hitChance: number;
    /** Hit-weighted expected effective primary-target damage for a supported single-hit sequence. */
    baseDamageEv: number;
    /** Hit- and damage-roll-weighted Petrifying Gaze stack/front-creature damage. */
    petrifyKillEv: number;
    /** Conservative lower-bound basic-melee HP denied when Stun lands before the target's turn. */
    stunTurnDenialEv: number;
    /** Reserved for a future engine rollout; Devour sequences are currently left on the incumbent. */
    devourKillSecureEv: number;
    /** Whether every supported outcome lands and removes the primary target. */
    secureKill: boolean;
    /** Sum of supported HP terms; no trained or hand-authored coefficients. */
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

function retargetActions(
    incumbent: GameAction[],
    incumbentAttack: Extract<GameAction, { type: "melee_attack" }>,
    targetId: string,
): GameAction[] {
    return incumbent.map((action) => (action === incumbentAttack ? { ...action, targetId } : action));
}

function petrifyDamageForLandedHit(
    unit: Unit,
    target: Unit,
    landedDamage: number,
    additionalAbilityPower: number,
): number {
    const ability = unit.getAbility("Petrifying Gaze");
    const residualHp = Math.max(0, target.getCumulativeHp() - landedDamage);
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
        const killed = Math.min(Math.floor((landedDamage * (roll / 100)) / target.getMaxHp()), remainingCreatures - 1);
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

function expectedPetrifyDamage(
    unit: Unit,
    target: Unit,
    damage: IPrimaryMeleeDamageEstimate,
    additionalAbilityPower: number,
): number {
    return (
        damage.hitChance *
        damage.landedOutcomes.reduce(
            (total, outcome) =>
                total +
                outcome.probability * petrifyDamageForLandedHit(unit, target, outcome.damage, additionalAbilityPower),
            0,
        )
    );
}

function expectedStunDenial(
    unit: Unit,
    target: Unit,
    damage: IPrimaryMeleeDamageEstimate,
    context: IDecisionContext,
    additionalAbilityPower: number,
): number | undefined {
    const fp = context.fightProperties;
    if (
        !unit.getAbility("Stun") ||
        !fp ||
        fp.hasAlreadyMadeTurn(target.getId()) ||
        target.isSkippingThisTurn() ||
        target.hasAbilityActive("No Melee")
    ) {
        return 0;
    }
    if (target.hasAbilityActive("Double Punch")) {
        return undefined;
    }

    const targetAbilityPower = fp.getAdditionalAbilityPowerPerTeam(target.getTeam());
    const defenderAbilityPower = fp.getAdditionalAbilityPowerPerTeam(unit.getTeam());
    const targetHitChance =
        1 - Math.min(100, Math.max(0, target.calculateMissChance(unit, defenderAbilityPower))) / 100;
    const nativeMeleeMultiplier =
        target.getAttackType() === PBTypes.AttackVals.RANGE && !target.hasAbilityActive("Handyman") ? 0.5 : 1;
    const paralysis = target.getEffect("Paralysis");
    const paralysisMultiplier = paralysis ? (100 - paralysis.getPower()) / 100 : 1;
    const currentMinimumDamage = target.calculateAttackDamageMin(
        target.getAttack(),
        unit,
        false,
        targetAbilityPower,
        1,
    );
    const currentAmount = Math.max(1, target.getAmountAlive());
    const deniedBasicDamage = damage.landedOutcomes.reduce((total, outcome) => {
        const residualHp = Math.max(0, target.getCumulativeHp() - outcome.damage);
        if (residualHp <= 0) {
            return total;
        }
        const remainingAmount = Math.ceil(residualHp / target.getMaxHp());
        // This is deliberately a lower-bound basic-melee term: it uses minimum damage and scales by whole
        // creatures remaining. It does not pretend to predict the target's spell/ranged/movement policy.
        const lowerBoundDamage = Math.max(
            0,
            Math.floor(
                currentMinimumDamage * (remainingAmount / currentAmount) * nativeMeleeMultiplier * paralysisMultiplier,
            ),
        );
        return total + outcome.probability * Math.min(unit.getCumulativeHp(), lowerBoundDamage);
    }, 0);
    const stunChance = calculateStunApplyChance(unit, target, additionalAbilityPower) / 100;
    return damage.hitChance * stunChance * targetHitChance * deniedBasicDamage;
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
    if (!target || target.isDead() || !candidate.standCell) {
        return undefined;
    }
    const riders = [
        unit.getAbility("Petrifying Gaze"),
        unit.getAbility("Stun"),
        unit.getAbility("Devour Essence"),
    ].filter(Boolean);
    // Devour depends on retaliation/reflection and on any kill in the whole hit set; multiple riders and
    // replacement/multi-hit sequences need a joint rollout. Preserve the incumbent until that rollout exists.
    if (unit.getAbility("Devour Essence") || riders.length !== 1) {
        return undefined;
    }

    const additionalAbilityPower = context.fightProperties.getAdditionalAbilityPowerPerTeam(unit.getTeam());
    const damage = estimatePrimaryMeleeDamage(unit, target, context, candidate.standCell, candidate.actions);
    if (!damage) {
        return undefined;
    }
    const baseDamageEv = damage.expectedEffectiveDamage;
    const petrifyKillEv = expectedPetrifyDamage(unit, target, damage, additionalAbilityPower);
    const stunTurnDenialEv = expectedStunDenial(unit, target, damage, context, additionalAbilityPower);
    if (stunTurnDenialEv === undefined) {
        return undefined;
    }
    const totalEv = baseDamageEv + petrifyKillEv + stunTurnDenialEv;
    if (!Number.isFinite(totalEv)) {
        return undefined;
    }
    return {
        hitChance: damage.hitChance,
        baseDamageEv,
        petrifyKillEv,
        stunTurnDenialEv,
        devourKillSecureEv: 0,
        secureKill: damage.secureKill,
        totalEv,
    };
}

/**
 * Optional version scoping for a seat-scoped A/B (the wait-scorer V07_WAIT_VERSIONS pattern): with
 * V06_RIDER_EV_VERSIONS unset, every caller is in scope (the router's original one-global-switch
 * semantics). When set to a comma list (e.g. "v0.7s"), only strategies whose version string is listed
 * route — so ONE seat of a v0.7s-vs-v0.7 mirror can carry the router while the other stays incumbent.
 * A caller that passes no version (undefined) is out of scope whenever the list is set.
 */
function riderScopeAllows(version: string | undefined): boolean {
    const raw = process.env.V06_RIDER_EV_VERSIONS;
    if (!raw) {
        return true;
    }
    if (!version) {
        return false;
    }
    return raw
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .includes(version);
}

/**
 * Q1/M3 evidence-gated melee rider router. It only re-picks the target from the incumbent's exact stand cell
 * and rewrites only that target id, retaining the incumbent's action sequence and path. Strict improvement is
 * required; ties, unsupported sequences, missing fight state and every gate-off call preserve the exact array.
 */
export function routeMeleeRiderEV(
    unit: Unit,
    context: IDecisionContext,
    incumbent: GameAction[],
    enumerate: CandidateEnumerator = enumerateCandidates,
    version?: string,
): GameAction[] {
    if (
        process.env.V06_RIDER_EV !== "on" ||
        !riderScopeAllows(version) ||
        !context.fightProperties ||
        !!unit.getAbility("Devour Essence") ||
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
    const estimateOnIncumbentPath = (candidate: IEnumeratedCandidate): IMeleeRiderEV | undefined =>
        estimateMeleeRiderEV(unit, context, {
            ...candidate,
            actions: retargetActions(incumbent, incumbentAttack, candidate.targetId ?? incumbentAttack.targetId),
        });
    const incumbentEv = estimateOnIncumbentPath(incumbentCandidate);
    if (!incumbentEv) {
        return incumbent;
    }

    let best: IEnumeratedCandidate | undefined;
    let bestEv = incumbentEv.totalEv;
    for (const candidate of meleeCandidates) {
        const estimate = estimateOnIncumbentPath(candidate);
        if (estimate && estimate.totalEv > bestEv) {
            best = candidate;
            bestEv = estimate.totalEv;
        }
    }
    if (!best?.targetId) {
        return incumbent;
    }
    const targetId = best.targetId;
    return retargetActions(incumbent, incumbentAttack, targetId);
}
