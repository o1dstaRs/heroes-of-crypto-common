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

import type { GameAction } from "../engine/actions";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { Unit } from "../units/unit";

const MELEE = PBTypes.AttackVals.MELEE;
const MELEE_MAGIC = PBTypes.AttackVals.MELEE_MAGIC;

const isMeleeSelection = (attackType: number): boolean => attackType === MELEE || attackType === MELEE_MAGIC;

/** Select the concrete melee stance exposed by the unit, if a stance change is needed. */
export function meleeAttackTypeSelectionPrefix(unit: Unit): GameAction[] {
    if (isMeleeSelection(unit.getAttackTypeSelection())) {
        return [];
    }
    const possible = unit.getPossibleAttackTypes();
    const attackType = possible.includes(MELEE) ? MELEE : possible.includes(MELEE_MAGIC) ? MELEE_MAGIC : undefined;
    return attackType === undefined ? [] : [{ type: "select_attack_type", unitId: unit.getId(), attackType }];
}

/**
 * v0.1-v0.6 historically emitted MELEE as a generic melee selector. MELEE_MAGIC stacks expose only
 * MELEE_MAGIC, so that prefix is rejected even though the following melee strike is valid. Correct that
 * inherited action at the v0.7 boundary without changing any frozen earlier strategy.
 */
export function normalizeMeleeMagicSelection(unit: Unit, decision: GameAction[]): GameAction[] {
    const possible = unit.getPossibleAttackTypes();
    if (
        possible.includes(MELEE) ||
        !possible.includes(MELEE_MAGIC) ||
        !decision.some((action) => action.type === "select_attack_type" && action.attackType === MELEE)
    ) {
        return decision;
    }

    const normalized: GameAction[] = [];
    let selected = unit.getAttackTypeSelection();
    for (const action of decision) {
        if (action.type !== "select_attack_type") {
            normalized.push(action);
            continue;
        }
        if (action.attackType !== MELEE) {
            normalized.push(action);
            selected = action.attackType;
            continue;
        }
        if (selected !== MELEE_MAGIC) {
            normalized.push({ ...action, attackType: MELEE_MAGIC });
            selected = MELEE_MAGIC;
        }
    }
    return normalized;
}
