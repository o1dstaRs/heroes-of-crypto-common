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

import type { GridType, TeamType } from "../generated/protobuf/v1/types_gen";
import type { XY } from "../utils/math";

export type GameEvent =
    | { type: "turn_completed"; unitId: string; team: TeamType; hourglass: boolean }
    | { type: "lap_initialized"; lap: number }
    | { type: "lap_flipped"; previousLap: number; currentLap: number }
    | { type: "center_dried"; gridType: GridType }
    | { type: "narrowing_applied"; lap: number; layers: number; encounterCurrent: boolean }
    | { type: "unit_moved_by_system"; unitId: string; position: XY; reason: "narrowing" }
    | { type: "unit_destroyed"; unitId: string; reason: "narrowing" | "armageddon" | "dead_cleanup" }
    | { type: "armageddon_applied"; unitId: string; wave: number }
    | { type: "morale_applied"; unitId: string; kind: "plus" | "minus"; lap: number }
    | { type: "next_unit_selected"; unitId: string; team: TeamType }
    | { type: "unit_skipped"; unitId: string; team: TeamType; reason: "effect" }
    | { type: "fight_finished"; winningTeam: TeamType };
