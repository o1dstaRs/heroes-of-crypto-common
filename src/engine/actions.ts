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
    | { type: "start_fight" }
    | { type: "end_turn"; unitId: string; reason?: "effect" | "timeout" | "manual" }
    | { type: "wait_turn"; unitId: string }
    | { type: "defend_turn"; unitId: string }
    | { type: "select_attack_type"; unitId: string; attackType: AttackType }
    | {
          type: "move_unit";
          unitId: string;
          path: XY[];
          targetCells?: XY[];
          hasLavaCell?: boolean;
          hasWaterCell?: boolean;
      }
    | {
          type: "melee_attack";
          attackerId: string;
          targetId: string;
          attackFrom: XY;
          path?: XY[];
          hasLavaCell?: boolean;
          hasWaterCell?: boolean;
      }
    | { type: "range_attack"; attackerId: string; targetId: string }
    | {
          type: "obstacle_attack";
          attackerId: string;
          targetPosition: XY;
          attackFrom?: XY;
          path?: XY[];
          hasLavaCell?: boolean;
          hasWaterCell?: boolean;
      }
    | { type: "area_throw_attack"; attackerId: string; targetCell: XY }
    | { type: "cast_spell"; casterId: string; spellName: string; targetId?: string; targetCell?: XY }
    | { type: "place_unit"; unitId: string; team: TeamType; unitName: string; cells: XY[]; amount?: number }
    | { type: "delete_unit"; unitId: string };
