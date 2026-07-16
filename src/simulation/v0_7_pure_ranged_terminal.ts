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
import { PBTypes } from "../generated/protobuf/v1/types";
import type { TeamType } from "../generated/protobuf/v1/types_gen";
import type { Unit } from "../units/unit";
import type { UnitsHolder } from "../units/units_holder";

export interface PureRangedTerminalOriginalUnit {
    readonly id: string;
    readonly team: TeamType;
}

export interface PureRangedTerminalState {
    readonly originalUnits: readonly PureRangedTerminalOriginalUnit[];
    readonly eligible: boolean;
    /** Average initial terminal budget of the two armies; one starting army is therefore about one unit. */
    readonly initialScale: number;
}

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const RANGE = PBTypes.AttackVals.RANGE;

function clamp(value: number, lower: number, upper: number): number {
    if (Number.isNaN(value)) {
        return 0;
    }
    return Math.min(upper, Math.max(lower, value));
}

function nonnegativeFinite(value: number): number {
    return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** Per-stack attack opportunities, approximated as one turn in each remaining pre-Armageddon lap. */
export function pureRangedAttackOpportunitiesToArmageddon(currentLap: number): number {
    if (!Number.isFinite(currentLap)) {
        return 0;
    }
    return Math.max(0, Math.floor(NUMBER_OF_LAPS_FIRST_ARMAGEDDON - currentLap));
}

/**
 * A living ranged stack's bounded damage budget before the first Armageddon wave.
 * Ranged creatures deal half damage after their ammunition is gone. No Melee stacks instead contribute
 * their current HP as a terminal barrier: once dry, the opponent still has to remove that inert stack.
 */
export function pureRangedTerminalValue(unit: Unit, attackOpportunities: number): number {
    if (unit.isDead()) {
        return 0;
    }

    const horizon = Math.max(0, Math.floor(nonnegativeFinite(attackOpportunities)));
    const reportedShots = unit.getRangeShots();
    // Endless Quiver currently reports 99. Infinity is treated the same way: only H shots can matter.
    const finiteShots = Number.isFinite(reportedShots) ? Math.max(0, Math.floor(reportedShots)) : horizon;
    const rangedTurns = Math.min(finiteShots, horizon);
    const currentMaxDamage = nonnegativeFinite(unit.getAttackDamageMax()) * nonnegativeFinite(unit.getAmountAlive());
    const noMelee = unit.hasAbilityActive("No Melee");
    const meleeMultiplier = unit.hasAbilityActive("Handyman") ? 1 : 0.5;
    const postAmmoMeleeDamage = noMelee ? 0 : Math.floor(currentMaxDamage * meleeMultiplier);
    const dryTurns = Math.max(0, horizon - rangedTurns);
    const hpBarrier = noMelee ? nonnegativeFinite(unit.getCumulativeHp()) : 0;
    const value = rangedTurns * currentMaxDamage + dryTurns * postAmmoMeleeDamage + hpBarrier;
    return Number.isFinite(value) ? Math.max(0, value) : Number.MAX_SAFE_INTEGER;
}

/** Capture post-setup original armies. Summons never affect eligibility, scale, or later leaf values. */
export function capturePureRangedTerminalState(unitsHolder: UnitsHolder, currentLap: number): PureRangedTerminalState {
    const originalUnits: PureRangedTerminalOriginalUnit[] = [];
    const initialByTeam = new Map<TeamType, number>([
        [LOWER, 0],
        [UPPER, 0],
    ]);
    const countByTeam = new Map<TeamType, number>([
        [LOWER, 0],
        [UPPER, 0],
    ]);
    const horizon = pureRangedAttackOpportunitiesToArmageddon(currentLap);
    let allRanged = true;

    for (const unit of unitsHolder.getAllUnits().values()) {
        if (unit.isSummoned()) {
            continue;
        }
        const team = unit.getTeam();
        originalUnits.push({ id: unit.getId(), team });
        if (team !== LOWER && team !== UPPER) {
            allRanged = false;
            continue;
        }
        countByTeam.set(team, (countByTeam.get(team) ?? 0) + 1);
        if (unit.getAttackType() !== RANGE) {
            allRanged = false;
        }
        initialByTeam.set(team, (initialByTeam.get(team) ?? 0) + pureRangedTerminalValue(unit, horizon));
    }

    const eligible = allRanged && countByTeam.get(LOWER)! > 0 && countByTeam.get(UPPER)! > 0;
    const averageInitialArmyBudget = ((initialByTeam.get(LOWER) ?? 0) + (initialByTeam.get(UPPER) ?? 0)) / 2;
    return {
        originalUnits,
        eligible,
        initialScale: eligible ? Math.max(1, nonnegativeFinite(averageInitialArmyBudget)) : 1,
    };
}

/** Perspective-antisymmetric, normalized terminal budget advantage in [-1, 1]. */
export function pureRangedTerminalAdvantage(
    state: PureRangedTerminalState,
    unitsHolder: UnitsHolder,
    side: TeamType,
    currentLap: number,
): number {
    if (!state.eligible || (side !== LOWER && side !== UPPER)) {
        return 0;
    }

    const horizon = pureRangedAttackOpportunitiesToArmageddon(currentLap);
    let own = 0;
    let enemy = 0;
    for (const original of state.originalUnits) {
        const unit = unitsHolder.getAllUnits().get(original.id);
        const value = unit ? pureRangedTerminalValue(unit, horizon) : 0;
        if (original.team === side) {
            own += value;
        } else {
            enemy += value;
        }
    }

    return clamp((own - enemy) / state.initialScale, -1, 1);
}
