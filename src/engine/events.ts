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

import type { AttackType, GridType, TeamType } from "../generated/protobuf/v1/types_gen";
import type { IVisibleDamage } from "../scene/animations";
import type { XY } from "../utils/math";

export interface IGameAnimationEvent {
    toPosition: XY;
    affectedUnitId?: string;
    fromPosition?: XY;
    bodyUnitId?: string;
}

export type GameEvent =
    | { type: "fight_started"; lowerUnitsAlive: number; upperUnitsAlive: number }
    | { type: "turn_completed"; unitId: string; team: TeamType; hourglass: boolean }
    | { type: "lap_initialized"; lap: number }
    | { type: "lap_flipped"; previousLap: number; currentLap: number }
    | { type: "center_dried"; gridType: GridType }
    | { type: "center_obstacle_cleared"; gridType: GridType }
    | { type: "narrowing_applied"; lap: number; layers: number; encounterCurrent: boolean }
    | { type: "unit_moved_by_system"; unitId: string; position: XY; reason: "narrowing" }
    | { type: "unit_destroyed"; unitId: string; reason: "narrowing" | "armageddon" | "dead_cleanup" }
    | { type: "unit_resurrected"; unitId: string; team: TeamType; amount: number; hp: number; position: XY }
    | { type: "armageddon_applied"; unitId: string; wave: number; damage: number; unitsDied: number }
    | { type: "morale_applied"; unitId: string; kind: "plus" | "minus"; lap: number }
    | { type: "next_unit_selected"; unitId: string; team: TeamType }
    | { type: "unit_skipped"; unitId: string; team: TeamType; reason: "effect" | "timeout" | "manual" | "skip" }
    | { type: "unit_waited"; unitId: string; team: TeamType }
    | { type: "unit_defended"; unitId: string; team: TeamType }
    | { type: "attack_type_selected"; unitId: string; team: TeamType; attackType: AttackType }
    | { type: "unit_moved"; unitId: string; from: XY; to: XY; path: XY[]; targetCells: XY[] }
    | { type: "unit_placed"; unitId: string; team: TeamType; position: XY; cells: XY[] }
    | {
          type: "unit_split";
          sourceUnitId: string;
          newUnitId: string;
          team: TeamType;
          sourceAmount: number;
          splitAmount: number;
      }
    | { type: "unit_deleted"; unitId: string; team: TeamType }
    | {
          type: "unit_summoned";
          casterId: string;
          unitId: string;
          team: TeamType;
          unitName: string;
          amount: number;
          position: XY;
          cells: XY[];
          merged: boolean;
      }
    | {
          type: "unit_attacked";
          attackType: "melee" | "range";
          attackerId: string;
          targetId: string;
          unitIdsDied: string[];
          damage: IVisibleDamage;
          animations: IGameAnimationEvent[];
      }
    | {
          type: "obstacle_attacked";
          attackerId: string;
          targetPosition: XY;
          attackFrom?: XY;
          hitsBefore: number;
          hitsAfter: number;
          // Remaining hit points of EACH of the two BLOCK_CENTER mountains after this strike. The total
          // (hitsAfter) alone can't say which mountain was hit, so clients that restore it by splitting the
          // total drop the wrong sprite's HP (attacking the left mountain showed the right one losing HP).
          // Carry both sides so the client applies the damage to the mountain that was actually struck.
          // Optional so events replayed from an older journal (total-only) still typecheck.
          hitsAfterLeft?: number;
          hitsAfterRight?: number;
          animations: IGameAnimationEvent[];
      }
    | {
          type: "area_attacked";
          attackType: "area_throw";
          attackerId: string;
          targetCell: XY;
          targetPosition: XY;
          affectedUnitIds: string[];
          unitIdsDied: string[];
          damage: IVisibleDamage;
          animations: IGameAnimationEvent[];
      }
    | {
          type: "spell_cast";
          casterId: string;
          spellName: string;
          targetId?: string;
          targetCell?: XY;
          unitIdsDied: string[];
          animations: IGameAnimationEvent[];
      }
    | { type: "fight_finished"; winningTeam: TeamType };
