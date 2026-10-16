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

import type { GameAction } from "../../engine/actions";
import type { Unit } from "../../units/unit";
import type { IDecisionContext } from "../ai_strategy";
import { enumerateCandidates, type IEnumeratedCandidate } from "../candidates";
import { assertNoLegacySeatEnv, seatEnvName } from "../seat_env";

/**
 * Research seam, off by default: `V08_FLYER_BACKLINE_PRIORITY_<LEFT|RIGHT>=1` makes that seat's melee flyers take a
 * legal melee attack on an enemy shooter or caster whenever one exists, instead of the front-line hit or wait the
 * search chose.
 *
 * Replays of drafted side-board games showed melee flyers had a shooter/caster in melee reach on 40% of their
 * decisions yet struck the front line or waited about two thirds of those times, then died around lap 3. This seam
 * measures whether using flight to reach the backline is the better play.
 */
export const V08_FLYER_BACKLINE_PRIORITY_ENV = "V08_FLYER_BACKLINE_PRIORITY";

export function isV08FlyerBacklinePriorityOn(team: number): boolean {
    assertNoLegacySeatEnv(V08_FLYER_BACKLINE_PRIORITY_ENV);
    return process.env[seatEnvName(V08_FLYER_BACKLINE_PRIORITY_ENV, team)] === "1";
}

/** A melee flyer: flies, and has neither a live ranged attack nor spells of its own. */
export const isV08MeleeFlyer = (unit: Unit): boolean =>
    unit.canFly() && !(unit.isRangeCapable() && unit.getRangeShots() > 0) && !unit.getCanCastSpells();

/** An enemy the flyer's flight is for: a stack with a live ranged attack or castable spells. */
export const isV08BacklineTarget = (unit: Unit): boolean =>
    !unit.isDead() && ((unit.isRangeCapable() && unit.getRangeShots() > 0) || unit.getCanCastSpells());

const meleeTargetId = (actions: readonly GameAction[]): string | undefined =>
    [...actions]
        .reverse()
        .find((action): action is Extract<GameAction, { type: "melee_attack" }> => action.type === "melee_attack")
        ?.targetId;

/**
 * Prefer a kill, then the most expected damage, then the stack with the most output (amount x max damage), with the
 * candidate order as the final deterministic tie-break.
 */
const backlineValue = (candidate: IEnumeratedCandidate, target: Unit): [number, number, number] => [
    candidate.features.expectedKill,
    candidate.features.expectedDamage,
    Math.max(1, target.getAmountAlive()) * Math.max(1, target.getAttackDamageMax()),
];

/**
 * Apply the priority to a decision already chosen for this unit. Returns `chosen` by reference whenever the seam is
 * off, the unit is not a melee flyer, the decision already strikes the backline or casts, or no legal backline
 * strike exists.
 */
export function applyV08FlyerBacklinePriority(
    unit: Unit,
    context: IDecisionContext | undefined,
    chosen: GameAction[],
): GameAction[] {
    if (!context || !isV08FlyerBacklinePriorityOn(unit.getTeam()) || !isV08MeleeFlyer(unit)) return chosen;
    if (chosen.some((action) => action.type === "cast_spell")) return chosen;
    const units = context.unitsHolder.getAllUnits();
    const currentTargetId = meleeTargetId(chosen);
    const currentTarget = currentTargetId ? units.get(currentTargetId) : undefined;
    if (currentTarget && currentTarget.getTeam() !== unit.getTeam() && isV08BacklineTarget(currentTarget)) {
        return chosen;
    }

    let best: IEnumeratedCandidate | undefined;
    let bestValue: [number, number, number] | undefined;
    for (const candidate of enumerateCandidates(unit, context, chosen).candidates) {
        if (candidate.kind !== "melee" || !candidate.targetId) continue;
        const target = units.get(candidate.targetId);
        if (!target || target.getTeam() === unit.getTeam() || !isV08BacklineTarget(target)) continue;
        const value = backlineValue(candidate, target);
        if (
            !bestValue ||
            value[0] > bestValue[0] ||
            (value[0] === bestValue[0] &&
                (value[1] > bestValue[1] || (value[1] === bestValue[1] && value[2] > bestValue[2])))
        ) {
            best = candidate;
            bestValue = value;
        }
    }
    return best ? best.actions : chosen;
}
