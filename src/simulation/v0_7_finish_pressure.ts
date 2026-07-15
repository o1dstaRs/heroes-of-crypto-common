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

import { NUMBER_OF_LAPS_FIRST_ARMAGEDDON, NUMBER_OF_LAPS_TILL_NARROWING_NORMAL } from "../constants";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { TeamType } from "../generated/protobuf/v1/types_gen";
import type { UnitsHolder } from "../units/units_holder";

export interface FinishPressureOriginalUnit {
    readonly id: string;
    readonly team: TeamType;
    readonly hp: number;
}

export interface FinishPressureState {
    readonly originalUnits: readonly FinishPressureOriginalUnit[];
    readonly initialBoardRangedness: number;
}

function clamp01(value: number): number {
    if (Number.isNaN(value)) {
        return 0;
    }
    return Math.min(1, Math.max(0, value));
}

function nonnegativeFinite(value: number): number {
    return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** Captures the post-setup armies. Units added later are intentionally absent from this state. */
export function captureFinishPressureState(unitsHolder: UnitsHolder): FinishPressureState {
    const originalUnits: FinishPressureOriginalUnit[] = [];
    let totalHp = 0;
    let rangedHp = 0;

    for (const unit of unitsHolder.getAllUnits().values()) {
        if (unit.isSummoned()) {
            continue;
        }
        const hp = nonnegativeFinite(unit.getCumulativeHp());
        originalUnits.push({ id: unit.getId(), team: unit.getTeam(), hp });
        totalHp += hp;
        if (unit.getAttackType() === PBTypes.AttackVals.RANGE) {
            rangedHp += hp;
        }
    }

    return {
        originalUnits,
        initialBoardRangedness: clamp01(totalHp > 0 ? rangedHp / totalHp : 0),
    };
}

/** Zero through narrowing lap 3, then linear to one at the first Armageddon lap. */
export function finishPressureProximity(currentLap: number): number {
    const rampLaps = NUMBER_OF_LAPS_FIRST_ARMAGEDDON - NUMBER_OF_LAPS_TILL_NARROWING_NORMAL;
    return clamp01((currentLap - NUMBER_OF_LAPS_TILL_NARROWING_NORMAL) / rampLaps);
}

/**
 * Ranged-board pressure to finish an injured opposing original army before Armageddon.
 * Summons do not affect either the initial composition or the remaining-HP fraction.
 */
export function finishPressureForSide(
    state: FinishPressureState,
    unitsHolder: UnitsHolder,
    side: TeamType,
    currentLap: number,
): number {
    let enemyOriginalHp = 0;
    let enemyRemainingHp = 0;

    for (const original of state.originalUnits) {
        if (original.team === side) {
            continue;
        }
        const originalHp = nonnegativeFinite(original.hp);
        enemyOriginalHp += originalHp;

        const current = unitsHolder.getAllUnits().get(original.id);
        if (current && !current.isDead()) {
            enemyRemainingHp += Math.min(originalHp, nonnegativeFinite(current.getCumulativeHp()));
        }
    }

    const remainingFraction = clamp01(enemyOriginalHp > 0 ? enemyRemainingHp / enemyOriginalHp : 0);
    const rangedness = clamp01(state.initialBoardRangedness);
    const proximity = finishPressureProximity(currentLap);
    const damageFraction = clamp01(1 - remainingFraction);
    return clamp01(rangedness * proximity * damageFraction);
}
