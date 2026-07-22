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

import type { IEnumeratedCandidate } from "../ai";
import type { Unit } from "../units/unit";
import type { UnitsHolder } from "../units/units_holder";
import type { PureRangedTerminalState } from "./v0_7_pure_ranged_terminal";

interface IRankedShot {
    readonly candidate: IEnumeratedCandidate;
    readonly index: number;
    readonly targetId: string;
    readonly primaryDamage: number;
}

/** A stationary ranged delivery may select RANGE first, but cannot move, pass, defend, or hit an obstacle. */
function stationaryPositiveShot(candidate: IEnumeratedCandidate, index: number): IRankedShot | undefined {
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

function compareShots(left: IRankedShot, right: IRankedShot): number {
    return (
        right.candidate.features.expectedKill - left.candidate.features.expectedKill ||
        right.primaryDamage - left.primaryDamage ||
        right.candidate.features.expectedDamage - left.candidate.features.expectedDamage ||
        (left.candidate.shotFeatures?.friendlyFireDamage ?? 0) -
            (right.candidate.shotFeatures?.friendlyFireDamage ?? 0) ||
        left.index - right.index
    );
}

/**
 * Rank the narrow terminal-barrier intervention. Immediate stationary shot kills on another stack come first;
 * otherwise a No Melee shooter takes the highest-value stationary shot that really damages a living enemy
 * No Melee stack. The caller still applies the candidates through the real engine and takes the first
 * engine-valid delivery.
 */
export function rankPureRangedNoMeleePressureCandidates(
    actor: Unit,
    unitsHolder: UnitsHolder,
    candidates: readonly IEnumeratedCandidate[],
    originalState: PureRangedTerminalState | null,
): IEnumeratedCandidate[] {
    if (
        !originalState?.eligible ||
        actor.isDead() ||
        actor.getRangeShots() <= 0 ||
        !actor.hasAbilityActive("No Melee")
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

    const shots = candidates.map(stationaryPositiveShot).filter((shot): shot is IRankedShot => {
        if (!shot) return false;
        const target = unitsHolder.getAllUnits().get(shot.targetId);
        return target !== undefined && !target.isDead() && target.getTeam() !== actor.getTeam();
    });
    if (!shots.length) {
        return [];
    }

    const immediateKills = shots
        .filter(({ candidate, targetId }) => candidate.features.expectedKill === 1 && !enemyNoMeleeIds.has(targetId))
        .sort(compareShots);
    const barrierShots = shots.filter(({ targetId }) => enemyNoMeleeIds.has(targetId)).sort(compareShots);
    return [...immediateKills, ...barrierShots].map(({ candidate }) => candidate);
}
