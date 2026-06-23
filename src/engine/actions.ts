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

import type { AttackType, TeamType } from "../generated/protobuf/v1/types_gen";
import type { XY } from "../utils/math";

export type GameAction =
    | { type: "end_turn"; unitId: string }
    | { type: "wait_turn"; unitId: string }
    | { type: "defend_turn"; unitId: string }
    | { type: "select_attack_type"; unitId: string; attackType: AttackType }
    | { type: "move_unit"; unitId: string; path: XY[] }
    | { type: "melee_attack"; attackerId: string; targetId: string; attackFrom: XY }
    | { type: "range_attack"; attackerId: string; targetId: string }
    | { type: "cast_spell"; casterId: string; spellName: string; targetId?: string; targetCell?: XY }
    | { type: "place_unit"; team: TeamType; unitName: string; cells: XY[]; amount?: number }
    | { type: "delete_unit"; unitId: string };
