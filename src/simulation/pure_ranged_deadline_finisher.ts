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

import { NUMBER_OF_LAPS_FIRST_ARMAGEDDON } from "../constants";
import type { IEnumeratedCandidate } from "../ai";
import type { Unit } from "../units/unit";
import type { UnitsHolder } from "../units/units_holder";
import type { PureRangedTerminalState } from "./v0_7_pure_ranged_terminal";

interface IDeadlineShot {
    readonly candidate: IEnumeratedCandidate;
    readonly index: number;
    readonly targetId: string;
    readonly primaryDamage: number;
    readonly shotsNeeded: number;
}

function stationaryPositiveShot(
    candidate: IEnumeratedCandidate,
    index: number,
): Omit<IDeadlineShot, "shotsNeeded"> | undefined {
    const rangedActions = candidate.actions.filter((action) => action.type === "range_attack");
    if (
        rangedActions.length !== 1 ||
        candidate.actions.some((action) => action.type !== "select_attack_type" && action.type !== "range_attack") ||
        candidate.features.spendsRangeShot !== 1 ||
        !Number.isFinite(candidate.features.expectedDamage) ||
        candidate.features.expectedDamage <= 0
    ) {
        return undefined;
    }
    const primaryDamage = candidate.shotFeatures?.primaryTargetDamage ?? 0;
    if (!Number.isFinite(primaryDamage) || primaryDamage <= 0) {
        return undefined;
    }
    return {
        candidate,
        index,
        targetId: candidate.targetId ?? rangedActions[0].targetId,
        primaryDamage,
    };
}

function compareShots(left: IDeadlineShot, right: IDeadlineShot): number {
    return (
        right.shotsNeeded - left.shotsNeeded ||
        right.primaryDamage - left.primaryDamage ||
        right.candidate.features.expectedDamage - left.candidate.features.expectedDamage ||
        (left.candidate.shotFeatures?.friendlyFireDamage ?? 0) -
            (right.candidate.shotFeatures?.friendlyFireDamage ?? 0) ||
        left.index - right.index
    );
}

/**
 * Rank the deadline-slack terminal finisher. An Endless Quiver shooter keeps its normal target while enough
 * pre-Armageddon activations remain. Once delaying another activation would make the living original No Melee
 * barrier infeasible to finish at the current per-shot damage, the best stationary barrier shot comes first.
 */
export function rankPureRangedDeadlineFinisherCandidates(
    actor: Unit,
    unitsHolder: UnitsHolder,
    candidates: readonly IEnumeratedCandidate[],
    originalState: PureRangedTerminalState | null,
    currentLap: number,
): IEnumeratedCandidate[] {
    if (
        !originalState?.eligible ||
        actor.isDead() ||
        actor.getRangeShots() <= 0 ||
        !actor.hasAbilityActive("Endless Quiver") ||
        !Number.isFinite(currentLap)
    ) {
        return [];
    }

    const enemyNoMeleeIds = new Set<string>();
    for (const original of originalState.originalUnits) {
        const unit = unitsHolder.getAllUnits().get(original.id);
        if (unit && !unit.isDead() && unit.getTeam() !== actor.getTeam() && unit.hasAbilityActive("No Melee")) {
            enemyNoMeleeIds.add(unit.getId());
        }
    }
    if (!enemyNoMeleeIds.size) {
        return [];
    }

    const remainingActivations = Math.max(0, Math.floor(NUMBER_OF_LAPS_FIRST_ARMAGEDDON - currentLap));
    return candidates
        .map(stationaryPositiveShot)
        .filter((shot): shot is Omit<IDeadlineShot, "shotsNeeded"> => {
            if (!shot) return false;
            return enemyNoMeleeIds.has(shot.targetId);
        })
        .map((shot): IDeadlineShot | undefined => {
            const target = unitsHolder.getAllUnits().get(shot.targetId);
            if (!target || target.isDead()) return undefined;
            const shotsNeeded = Math.ceil(Math.max(0, target.getCumulativeHp()) / shot.primaryDamage);
            return shotsNeeded >= remainingActivations ? { ...shot, shotsNeeded } : undefined;
        })
        .filter((shot): shot is IDeadlineShot => shot !== undefined)
        .sort(compareShots)
        .map(({ candidate }) => candidate);
}
