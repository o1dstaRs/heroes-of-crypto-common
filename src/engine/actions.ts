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

import type { AttackType, FactionType, TeamType } from "../generated/protobuf/v1/types_gen";
import type { XY } from "../utils/math";

export type GameAction =
    | { type: "start_fight" }
    | { type: "end_turn"; unitId: string; reason?: "effect" | "timeout" | "manual" | "skip" }
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
    | {
          type: "range_attack";
          attackerId: string;
          targetId: string;
          // The visible edge the player aimed at, as bounded intent only: which cell of the target
          // (aimCell) and which of its 4 sides (aimSide, see RangeAttackCellSide). The server
          // validates and reconstructs the exact trajectory from these — it never trusts a raw
          // position. Omitted by the AI path, where the engine picks a deterministic default edge.
          aimCell?: XY;
          aimSide?: number;
      }
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
    | { type: "split_unit"; unitId: string; amount: number }
    | { type: "delete_unit"; unitId: string }
    // Once per lap per team, the acting team may extend its running turn clock (see
    // FightProperties.requestAdditionalTurnTime). Carries the requesting team; the engine only
    // honours it while that team's unit is active and it hasn't already been used this lap.
    | { type: "request_additional_time"; team: TeamType }
    // During placement, a team spends its perk's upgrade-point budget on an army augment. `augmentKind`
    // is the augment category and `augmentValue` its level (see FightProperties.setAugmentPerTeam /
    // canAugment). Applied pre-fight to the army; not a turn action.
    | { type: "augment"; team: TeamType; augmentKind: AugmentKind; augmentValue: number }
    // During placement, a team selects one synergy per faction it fields (e.g. Might -> Auras Range).
    // `synergyName` is the specific synergy within `faction`; the server resolves it and re-derives the
    // level from army composition (setSynergyUnitsPerFactions), so synergies apply in the ranked fight.
    | { type: "synergy"; team: TeamType; faction: FactionType; synergyName: string; level: number };

// The five spendable army-augment categories (Placement resizes the placement grid; the others are
// stat buffs applied by UnitsHolder.applyAugments). Mirrors FightProperties' AugmentType.type union.
export type AugmentKind = "Placement" | "Armor" | "Might" | "Sniper" | "Movement";
