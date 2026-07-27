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

import { NUMBER_OF_LAPS_FIRST_ARMAGEDDON } from "../../constants";
import type { GameAction } from "../../engine/actions";
import {
    getPositionForCells,
    getRangeAttackSideCenter,
    isRangeAttackSideObservable,
    RANGE_ATTACK_CELL_SIDES,
    type RangeAttackCellSide,
} from "../../grid/grid_math";
import { IL_ACTION_FEATURE_NAMES, ilCandidateActionEncoding } from "../../simulation/il_action_features";
import { VALUE_FEATURE_NAMES_V2, extractValueFeaturesV2 } from "../../simulation/value_features";
import type { Unit } from "../../units/unit";
import type { XY } from "../../utils/math";
import type { IDecisionContext } from "../ai_strategy";
import type { IEnumeratedCandidate } from "../candidates";
import { isV08StrongerRangedPostureWait } from "./v0_8";
import { v08DominantFinishState } from "./v0_8_dominant_finish";

export const V09_FEATURE_SCHEMA = "hoc.ai.v0_9_features.il_v4.v1" as const;

export const V09_CANDIDATE_FEATURE_NAMES = [
    "moraleDelta",
    "luckDelta",
    "enemiesNotYetActedFrac",
    "alliesNotYetActedFrac",
    "lap",
    "hourglassSpent",
    "spendsRangeShot",
    "spendsSpellCharge",
    "burnsResurrectionCharge",
    "expectedDamage",
    "expectedKill",
] as const;

/**
 * Public pre-decision observations added by IL-v4. These are deliberately semantic rather than creature-id
 * one-hots, so new units can be represented immediately through their live stats and roles.
 */
export const V09_RICH_FEATURE_NAMES = [
    "actorLevel",
    "actorHpFraction",
    "actorStackFraction",
    "actorAttack",
    "actorDefence",
    "actorSteps",
    "actorAmountAlive",
    "actorIsRanged",
    "actorCanCast",
    "actorHasFrontlineSupport",
    "actorAdjacentAllies",
    "actorThreatenedBy",
    "actorNearestEnemyDistance",
    "hasDeclaredTarget",
    "hasFirstHitTarget",
    "declaredIsFirstHit",
    "targetLevel",
    "targetHpFraction",
    "targetStackFraction",
    "targetFirepower",
    "targetIsRanged",
    "targetCanCast",
    "targetNotActed",
    "targetDistance",
    "targetScreened",
    "hasAim",
    "aimVisibleEdge",
    "trajectoryIntercepted",
    "rangeDivisor",
    "distanceAfterMove",
    "movesCloser",
    "movesBehindFrontline",
    "hasEscapeCell",
    "attackFromSafe",
    "isSpell",
    "spellChargeFraction",
    "productive",
    "waitEligible",
    "luckShield",
    "mountainAttack",
    "urgentFinish",
    "dominantFinish",
    "armageddonRisk",
    "expectedCounterDamage",
    "selfExposure",
] as const;

export const V09_INPUT_FEATURE_NAMES: readonly string[] = Object.freeze([
    ...VALUE_FEATURE_NAMES_V2.map((name) => `state_${name}`),
    ...V09_CANDIDATE_FEATURE_NAMES.map((name) => `candidate_${name}`),
    ...IL_ACTION_FEATURE_NAMES.map((name) => `action_${name}`),
    ...V09_RICH_FEATURE_NAMES.map((name) => `rich_${name}`),
]);

export const V09_FEATURE_SCHEMA_SHA256 = "01d5d1fdb32edb31add64201da4d37443f0e8a54379f2f50763da83c1ca3d18e";

const chebyshev = (left: XY, right: XY): number => Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));

const living = (units: readonly Unit[]): Unit[] => units.filter((unit) => !unit.isDead());

const stackFraction = (unit: Unit): number => {
    const alive = Math.max(0, unit.getAmountAlive());
    const original = alive + Math.max(0, unit.getAmountDied());
    return original > 0 ? alive / original : 0;
};

const hpFraction = (unit: Unit): number => {
    const original = Math.max(0, unit.getAmountAlive()) + Math.max(0, unit.getAmountDied());
    const maximum = Math.max(0, unit.getMaxHp()) * original;
    return maximum > 0 ? Math.max(0, unit.getCumulativeHp()) / maximum : 0;
};

const candidateFeatureVector = (candidate: IEnumeratedCandidate): number[] => [
    candidate.features.moraleDelta,
    candidate.features.luckDelta,
    candidate.features.enemiesNotYetActedFrac,
    candidate.features.alliesNotYetActedFrac,
    candidate.features.lap,
    candidate.features.hourglassSpent,
    candidate.features.spendsRangeShot,
    candidate.features.spendsSpellCharge,
    candidate.features.burnsResurrectionCharge,
    candidate.features.expectedDamage,
    candidate.features.expectedKill,
];

const candidateMoveDestination = (unit: Unit, candidate: IEnumeratedCandidate): XY => {
    const move = candidate.actions.find((action) => action.type === "move_unit");
    const pathCell = move?.path[move.path.length - 1];
    return candidate.targetCell ?? pathCell ?? unit.getBaseCell();
};

const threatenedAt = (cell: XY, enemies: readonly Unit[]): number => {
    let threats = 0;
    for (const enemy of enemies) {
        // This is a public, conservative next-activation exposure estimate. The engine still owns exact
        // reachability; the model cannot use this feature to bypass candidate legality.
        if (chebyshev(cell, enemy.getBaseCell()) <= Math.max(1, enemy.getSteps() + 1)) {
            threats += 1;
        }
    }
    return threats;
};

const hasScreen = (cell: XY, targetCell: XY | undefined, allies: readonly Unit[], actorId: string): boolean => {
    if (!targetCell) return false;
    const actorDistance = chebyshev(cell, targetCell);
    return allies.some(
        (ally) =>
            ally.getId() !== actorId &&
            !ally.isRangeCapable() &&
            chebyshev(ally.getBaseCell(), targetCell) < actorDistance &&
            chebyshev(ally.getBaseCell(), cell) <= 3,
    );
};

const declaredTargetId = (actions: readonly GameAction[]): string | undefined => {
    for (const action of actions) {
        if (action.type === "melee_attack" || action.type === "range_attack") return action.targetId;
        if (action.type === "cast_spell" && action.targetId !== undefined) return action.targetId;
    }
    return undefined;
};

export const v09CandidateIsProductive = (candidate: IEnumeratedCandidate): boolean =>
    candidate.actions.some(
        (action) =>
            action.type === "move_unit" ||
            action.type === "melee_attack" ||
            action.type === "range_attack" ||
            action.type === "area_throw_attack" ||
            action.type === "cast_spell",
    ) && !candidate.actions.some((action) => action.type === "obstacle_attack");

export const v09CandidateConsumesPassiveTurn = (candidate: IEnumeratedCandidate): boolean =>
    candidate.actions.some(
        (action) => action.type === "end_turn" || action.type === "defend_turn" || action.type === "obstacle_attack",
    );

export interface IV09RangeObservation {
    readonly hasAim: boolean;
    readonly aimVisibleEdge: boolean;
    readonly declaredTargetId?: string;
    readonly firstHitTargetId?: string;
    readonly declaredIsFirstHit: boolean;
    readonly trajectoryIntercepted: boolean;
    readonly rangeDivisor: number;
}

/** Resolve the same first-hit trajectory the engine sees, without mutating the battle. */
export function v09RangeObservation(
    unit: Unit,
    context: IDecisionContext,
    candidate: IEnumeratedCandidate,
): IV09RangeObservation {
    const shot = candidate.actions.find((action) => action.type === "range_attack");
    if (!shot?.aimCell || shot.aimSide === undefined) {
        return {
            hasAim: false,
            aimVisibleEdge: false,
            declaredTargetId: shot?.targetId,
            firstHitTargetId: candidate.targetId,
            declaredIsFirstHit: shot?.targetId !== undefined && shot.targetId === candidate.targetId,
            trajectoryIntercepted: false,
            rangeDivisor: 0,
        };
    }

    const through = unit.hasAbilityActive("Through Shot");
    const sideValid = RANGE_ATTACK_CELL_SIDES.includes(shot.aimSide as RangeAttackCellSide);
    const visible =
        sideValid &&
        isRangeAttackSideObservable(
            context.matrix,
            shot.aimCell,
            shot.aimSide as RangeAttackCellSide,
            unit.getTeam(),
            through,
        );
    let firstHitTargetId = candidate.targetId;
    let rangeDivisor = 0;
    const move = candidate.actions.find((action) => action.type === "move_unit");
    const from =
        (move?.targetCells && getPositionForCells(context.grid.getSettings(), move.targetCells)) ?? unit.getPosition();
    if (visible && context.attackHandler) {
        const to = getRangeAttackSideCenter(
            context.grid.getSettings(),
            shot.aimCell,
            shot.aimSide as RangeAttackCellSide,
            from,
        );
        const evaluation = context.attackHandler.evaluateRangeAttack(
            context.unitsHolder.getAllUnits(),
            unit,
            from,
            to,
            through,
            false,
            unit.hasAbilityActive("Large Caliber") || unit.hasAbilityActive("Area Throw"),
        );
        // Once the authoritative trajectory has been evaluated, an empty hit list really means the
        // projectile reaches no unit. Falling back to the enumerator's declared target here would let
        // a no-hit shot masquerade as a valid visible first hit.
        firstHitTargetId = evaluation.affectedUnits[0]?.[0]?.getId();
        rangeDivisor = evaluation.rangeAttackDivisors[0] ?? 0;
    }
    const declaredIsFirstHit = shot.targetId === firstHitTargetId;
    return {
        hasAim: true,
        aimVisibleEdge: visible,
        declaredTargetId: shot.targetId,
        firstHitTargetId,
        declaredIsFirstHit,
        trajectoryIntercepted: firstHitTargetId !== undefined && !declaredIsFirstHit,
        rangeDivisor,
    };
}

/**
 * Stronger than mere engine legality: a learned challenger may only shoot a visible edge of the unit that
 * the authoritative trajectory hits first. This prevents a rear-stack declaration/projectile from masking a
 * different front-stack hit. Candidate zero remains the exact v0.8 fallback.
 */
export function v09HasResolvedVisibleShot(
    unit: Unit,
    context: IDecisionContext,
    candidate: IEnumeratedCandidate,
): boolean {
    const shot = candidate.actions.find((action) => action.type === "range_attack");
    if (!shot) return true;
    const observation = v09RangeObservation(unit, context, candidate);
    const target =
        observation.firstHitTargetId === undefined
            ? undefined
            : context.unitsHolder.getAllUnits().get(observation.firstHitTargetId);
    return (
        observation.hasAim &&
        observation.aimVisibleEdge &&
        observation.declaredIsFirstHit &&
        !!target &&
        !target.isDead() &&
        target.getTeam() !== unit.getTeam() &&
        target.getCells().some((cell) => cell.x === shot.aimCell?.x && cell.y === shot.aimCell?.y)
    );
}

function richFeatureVector(
    candidate: IEnumeratedCandidate,
    unit: Unit,
    context: IDecisionContext,
    candidates: readonly IEnumeratedCandidate[],
): number[] {
    const allUnits = context.unitsHolder.getAllUnits();
    const allies = living(context.unitsHolder.getAllAllies(unit.getTeam()));
    const enemies = living(context.unitsHolder.getAllEnemyUnits(unit.getTeam()));
    const actorCell = unit.getBaseCell();
    const destination = candidateMoveDestination(unit, candidate);
    const range = v09RangeObservation(unit, context, candidate);
    const declaredId = declaredTargetId(candidate.actions);
    const firstHitId = range.hasAim ? range.firstHitTargetId : (candidate.targetId ?? declaredId);
    const target = firstHitId === undefined ? undefined : allUnits.get(firstHitId);
    const targetCell = target?.getBaseCell();
    const nearestEnemy = [...enemies].sort((left, right) => {
        const distance = chebyshev(actorCell, left.getBaseCell()) - chebyshev(actorCell, right.getBaseCell());
        if (distance) return distance;
        const leftCell = left.getBaseCell();
        const rightCell = right.getBaseCell();
        return leftCell.x - rightCell.x || leftCell.y - rightCell.y;
    })[0];
    const nearestEnemyDistance = nearestEnemy ? chebyshev(actorCell, nearestEnemy.getBaseCell()) : 0;
    const currentExposure = threatenedAt(actorCell, enemies);
    const selfExposure = threatenedAt(destination, enemies);
    const hasEscapeCell = candidates.some((other) => {
        if (!other.actions.some((action) => action.type === "move_unit")) return false;
        return threatenedAt(candidateMoveDestination(unit, other), enemies) < currentExposure;
    });
    const distanceBefore = targetCell ? chebyshev(actorCell, targetCell) : 0;
    const distanceAfter = targetCell ? chebyshev(destination, targetCell) : 0;
    const frontlineSupport = hasScreen(actorCell, nearestEnemy?.getBaseCell(), allies, unit.getId());
    const targetScreened = hasScreen(destination, targetCell, allies, unit.getId());
    const movesBehindFrontline = candidate.actions.some((action) => action.type === "move_unit") && targetScreened;
    const spellAction = candidate.actions.find((action) => action.type === "cast_spell");
    const spell = spellAction ? unit.getSpells().find((entry) => entry.getName() === spellAction.spellName) : undefined;
    const spellAmount = Math.max(0, spell?.getAmount() ?? 0);
    const lap = context.fightProperties?.getCurrentLap() ?? 0;
    const finish = v08DominantFinishState(context.unitsHolder, unit.getTeam(), lap);
    const armageddonRisk = Math.max(0, Math.min(1, 1 - (NUMBER_OF_LAPS_FIRST_ARMAGEDDON - lap) / 5));
    const melee = candidate.actions.some((action) => action.type === "melee_attack");
    const expectedCounterDamage =
        melee && target
            ? Math.max(0, (target.getAttackDamageMin() + target.getAttackDamageMax()) / 2) *
              Math.max(0, target.getAmountAlive())
            : 0;
    const targetNotActed =
        target && context.fightProperties && !context.fightProperties.hasAlreadyMadeTurn(target.getId()) ? 1 : 0;

    return [
        unit.getLevel(),
        hpFraction(unit),
        stackFraction(unit),
        unit.getAttack(),
        unit.getArmor(),
        unit.getSteps(),
        unit.getAmountAlive(),
        unit.isRangeCapable() ? 1 : 0,
        unit.getCanCastSpells() && unit.getSpells().some((entry) => entry.isRemaining()) ? 1 : 0,
        frontlineSupport ? 1 : 0,
        allies.filter((ally) => ally.getId() !== unit.getId() && chebyshev(actorCell, ally.getBaseCell()) <= 1).length,
        currentExposure,
        nearestEnemyDistance,
        declaredId === undefined ? 0 : 1,
        firstHitId === undefined ? 0 : 1,
        declaredId !== undefined && declaredId === firstHitId ? 1 : 0,
        target?.getLevel() ?? 0,
        target ? hpFraction(target) : 0,
        target ? stackFraction(target) : 0,
        target ? target.getAttack() * Math.max(0, target.getAmountAlive()) : 0,
        target?.isRangeCapable() ? 1 : 0,
        target?.getCanCastSpells() ? 1 : 0,
        targetNotActed,
        distanceBefore,
        targetScreened ? 1 : 0,
        range.hasAim ? 1 : 0,
        range.aimVisibleEdge ? 1 : 0,
        range.trajectoryIntercepted ? 1 : 0,
        range.rangeDivisor,
        distanceAfter,
        targetCell && distanceAfter < distanceBefore ? 1 : 0,
        movesBehindFrontline ? 1 : 0,
        hasEscapeCell ? 1 : 0,
        candidate.actions.some(
            (action) =>
                action.type === "melee_attack" || action.type === "range_attack" || action.type === "area_throw_attack",
        ) && selfExposure === 0
            ? 1
            : 0,
        spellAction ? 1 : 0,
        spellAmount > 0 ? spellAmount / (spellAmount + 1) : 0,
        v09CandidateIsProductive(candidate) ? 1 : 0,
        isV08StrongerRangedPostureWait(unit, context.unitsHolder, lap, candidate.actions) ? 1 : 0,
        candidate.actions.some((action) => action.type === "defend_turn") ? 1 : 0,
        candidate.actions.some((action) => action.type === "obstacle_attack") ? 1 : 0,
        finish.urgent ? 1 : 0,
        finish.dominant ? 1 : 0,
        armageddonRisk,
        expectedCounterDamage,
        selfExposure,
    ];
}

/**
 * Browser-safe IL-v4 inference vector. Missing turn state fails closed instead of silently presenting a trained
 * model with a zeroed temporal/Armageddon block; StrategyV0_9 then returns the exact v0.8 anchor.
 */
export function v09CandidateFeatureVector(
    candidate: IEnumeratedCandidate,
    unit: Unit,
    context: IDecisionContext,
    candidates: readonly IEnumeratedCandidate[],
): number[] {
    if (!context.fightProperties) {
        throw new Error("v0.9 IL-v4 inference requires fightProperties");
    }
    const vector = [
        ...extractValueFeaturesV2(context.unitsHolder, context.fightProperties, unit.getTeam()),
        ...candidateFeatureVector(candidate),
        ...ilCandidateActionEncoding(candidate, unit.getTeam()).features,
        ...richFeatureVector(candidate, unit, context, candidates),
    ];
    if (vector.length !== V09_INPUT_FEATURE_NAMES.length || vector.some((value) => !Number.isFinite(value))) {
        throw new Error(`v0.9 IL-v4 produced an invalid ${vector.length}-value feature vector`);
    }
    return vector;
}
