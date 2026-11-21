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
import { getFootprintCellsForAnchor } from "../grid/grid_math";
import type { Unit } from "../units/unit";
import type { UnitsHolder } from "../units/units_holder";
import type { XY } from "../utils/math";

/** Actions that count as attacking for the keep-attack rules (a cast counts: a caster may cast instead). */
export const A19_KEEP_ATTACK_ACTION_TYPES: ReadonlySet<string> = new Set([
    "melee_attack",
    "range_attack",
    "area_throw_attack",
    "obstacle_attack",
    "cast_spell",
]);

export function a19Attacks(actions: readonly GameAction[]): boolean {
    return actions.some((action) => A19_KEEP_ATTACK_ACTION_TYPES.has(action.type));
}

/** The cells the unit's body covers after `actions`: its current cells when they do not move it. */
export function a19CandidateEndCells(unit: Unit, actions: readonly GameAction[]): XY[] {
    let cells: XY[] = unit.getCells().map((cell) => ({ x: cell.x, y: cell.y }));
    const width = unit.getFootprintWidth();
    const height = unit.getFootprintHeight();
    for (const action of actions) {
        if (action.type === "move_unit") {
            if (action.targetCells?.length) cells = action.targetCells.map((cell) => ({ x: cell.x, y: cell.y }));
            else if (action.path.length)
                cells = getFootprintCellsForAnchor(action.path[action.path.length - 1], width, height);
        } else if (action.type === "melee_attack") {
            cells = getFootprintCellsForAnchor(action.attackFrom, width, height);
        } else if (action.type === "obstacle_attack" && action.attackFrom) {
            cells = getFootprintCellsForAnchor(action.attackFrom, width, height);
        }
    }
    return cells;
}

/** Whether `actions` move the unit, attack nothing, and leave its body next to (or diagonal to) an enemy. */
export function a19IsPlainContactMove(unit: Unit, actions: readonly GameAction[], unitsHolder: UnitsHolder): boolean {
    if (!actions.some((action) => action.type === "move_unit") || a19Attacks(actions)) return false;
    const enemyCells: XY[] = [];
    for (const other of unitsHolder.getAllUnits().values()) {
        if (!other.isDead() && other.getTeam() !== unit.getTeam()) enemyCells.push(...other.getCells());
    }
    return a19CandidateEndCells(unit, actions).some((cell) =>
        enemyCells.some((enemy) => Math.max(Math.abs(enemy.x - cell.x), Math.abs(enemy.y - cell.y)) <= 1),
    );
}

export interface IA19KeepAttackRules {
    /** SEARCH_A19_KEEP_MELEE_ATTACK: a native melee attack is only replaced by another attack. */
    keepMeleeAttack: boolean;
    /** SEARCH_A19_KEEP_CONTACT_ATTACK: while any scored candidate attacks, no plain move ends next to an enemy. */
    keepContactAttack: boolean;
}

/**
 * a19-keep-attack-v1. A melee unit's search takes the best of a few two-playout means, and a plain move next to the
 * enemy wins that noisy maximum about as often as an attack does, so players see a unit walk up and not attack.
 * Before selection, each rule moves such a challenger one full unit down, so only an attack or a cast can beat it:
 * when the native choice is a melee attack, every challenger that does not attack; when any scored candidate
 * attacks, every challenger that moves next to an enemy without attacking. Ranged units are left alone. Returns the
 * number of challengers lowered. `means` is changed in place; illegal candidates (-Infinity) stay illegal.
 */
export function applyA19KeepAttack(
    unit: Unit,
    candidates: readonly { actions: readonly GameAction[] }[],
    means: number[],
    unitsHolder: UnitsHolder,
    rules: IA19KeepAttackRules,
): number {
    if (unit.getAttackType() === PBTypes.AttackVals.RANGE) return 0;
    const nativeMelee =
        rules.keepMeleeAttack && (candidates[0]?.actions.some((action) => action.type === "melee_attack") ?? false);
    const attackScored =
        rules.keepContactAttack &&
        candidates.some((candidate, index) => means[index] !== -Infinity && a19Attacks(candidate.actions));
    if (!nativeMelee && !attackScored) return 0;
    let lowered = 0;
    for (let index = 1; index < candidates.length; index += 1) {
        if (means[index] === -Infinity || a19Attacks(candidates[index].actions)) continue;
        if (nativeMelee || a19IsPlainContactMove(unit, candidates[index].actions, unitsHolder)) {
            means[index] -= 1;
            lowered += 1;
        }
    }
    return lowered;
}
