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
import type { TeamType } from "../../generated/protobuf/v1/types_gen";
import type { UnitsHolder } from "../../units/units_holder";

/** Leave five complete laps to turn a commanding material lead into a clean elimination. */
export const V08_DOMINANT_FINISH_START_LAP = NUMBER_OF_LAPS_FIRST_ARMAGEDDON - 5;

/** "Way stronger" is deliberately conservative: current original-stack HP must be at least two-to-one. */
export const V08_DOMINANT_FINISH_HP_RATIO = 2;

/** With three laps left, every surviving v0.8 army must press for elimination regardless of material. */
export const V08_URGENT_FINISH_START_LAP = NUMBER_OF_LAPS_FIRST_ARMAGEDDON - 3;

export interface IV08DominantFinishState {
    readonly currentLap: number;
    readonly ownHp: number;
    readonly enemyHp: number;
    /** Early five-lap finish window, armed only with at least a two-to-one original-stack HP lead. */
    readonly dominant: boolean;
    /** Universal three-lap terminal window; only immediate-kill retargeting is forced in balanced fights. */
    readonly urgent: boolean;
    readonly active: boolean;
}

const DIRECT_COMBAT_ACTION_TYPES = new Set<GameAction["type"]>(["melee_attack", "range_attack", "area_throw_attack"]);

const nonnegativeFinite = (value: number): number => (Number.isFinite(value) ? Math.max(0, value) : 0);

/** A direct attack can reduce the opposing army now; moves, support spells, and obstacle attacks cannot. */
export function isV08DirectCombatDecision(actions: readonly GameAction[]): boolean {
    return actions.some((action) => DIRECT_COMBAT_ACTION_TYPES.has(action.type));
}

/**
 * Describe the late-fight state in which v0.8 must force combat instead of protecting a saturated value estimate.
 * A commanding two-to-one army starts five laps before Armageddon; every surviving army starts a universal final
 * sprint three laps before it. Summons are excluded from the material comparison so a temporary/generated stack
 * cannot arm the early invariant.
 */
export function v08DominantFinishState(
    unitsHolder: UnitsHolder,
    team: TeamType,
    currentLap: number,
): IV08DominantFinishState {
    let ownHp = 0;
    let enemyHp = 0;

    for (const unit of unitsHolder.getAllUnits().values()) {
        if (unit.isDead() || unit.isSummoned()) continue;
        const hp = nonnegativeFinite(unit.getCumulativeHp());
        if (unit.getTeam() === team) ownHp += hp;
        else enemyHp += hp;
    }

    const validLap = Number.isFinite(currentLap);
    const dominant =
        validLap && currentLap >= V08_DOMINANT_FINISH_START_LAP && ownHp >= V08_DOMINANT_FINISH_HP_RATIO * enemyHp;
    const urgent = validLap && currentLap >= V08_URGENT_FINISH_START_LAP;
    const active = enemyHp > 0 && (dominant || urgent);
    return { currentLap, ownHp, enemyHp, dominant: enemyHp > 0 && dominant, urgent: enemyHp > 0 && urgent, active };
}
