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
    | { type: "unit_destroyed"; unitId: string; reason: "narrowing" | "armageddon" | "dead_cleanup" | "poison" }
    | { type: "poison_ticked"; unitId: string; damage: number; unitsDied: number }
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
          sourceAbility?: string;
      }
    | { type: "ability_stolen"; thiefId: string; targetId: string; abilityName: string }
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
          /**
           * How much each unit was actually healed (after magic resist, Holy Cross and the missing-HP
           * cap). Ranked rebuilds its scene log from these events rather than from the engine's own text,
           * so without this a heal reads as a bare "cast Heal on X" with no number — see
           * RankedPlayScene.buildAuthoritativeSceneLogLines. One entry per healed unit; a mass heal has
           * many, and a heal that restored nothing has none.
           */
          healed?: { unitId: string; amount: number }[];
          /**
           * Damage a DAMAGING spell actually dealt, per unit — the mirror image of `healed` above, and read
           * the same way: ranked rebuilds its scene log and its floating numbers from events, never from the
           * engine's own text, so without this the Battle Mage's Fire Strike would read as a bare "cast Fire
           * Strike on X" with nothing landing on the board.
           *
           * `position` is the victim's world position at the moment of impact, captured BEFORE applyDamage
           * because a killed stack is removed before the visuals play. Fire Strike has one entry; Meteorite
           * has one per enemy caught under its 2x2 (and none when it lands on empty ground).
           */
          damaged?: { unitId: string; position: XY; amount: number; unitsDied: number }[];
          /**
           * What a RESURRECT cast actually brought back, read exactly like `healed` and `damaged` above:
           * ranked rebuilds both its scene log and its VFX from events, never from the engine's own text, so
           * without this the Angel's cast reads as a bare "cast Resurrection on X" with no count and nothing
           * to play the effect on.
           *
           * `amount` is whole stacks raised and is 0 when the cast only topped a survivor's health up; `hp`
           * is the health restored either way. `position` is the target's world position after the raise,
           * which is where the effect belongs.
           */
          resurrected?: { unitId: string; amount: number; hp: number; position: XY }[];
      }
    // Smoke spell: clouds placed on free cells of a 2x2 block. lapsRemaining is the per-cell budget at place
    // time (mirrors SmokeClouds.add) — the client renders the cloud and can show the countdown.
    | { type: "smoke_placed"; casterId: string; cells: XY[]; lapsRemaining: number }
    // A creature stepped onto a smoked cell (or otherwise occupied it) — that cell's smoke disperses now.
    | { type: "smoke_dispel"; cells: XY[] }
    // Lap transition decremented every cloud; these cells hit 0 laps and dispersed this tick.
    | { type: "smoke_expired"; cells: XY[] }
    // Vine Throw: the vine laid from the caster to the target. `cells` is in throw order (nearest the caster
    // first) so the client can animate the vine growing along the path; `targetId` is the snared creature.
    | { type: "vine_placed"; casterId: string; targetId: string; cells: XY[]; lapsRemaining: number }
    // Vines that withered on lap transition — the client drops their visuals.
    | { type: "vine_expired"; cells: XY[] }
    // Fire Wall: the three cells set alight by one cast, in wall order (so the client can light them up in
    // sequence). lapsRemaining is the per-cell budget at place time, mirroring FireWalls.add.
    | { type: "fire_wall_placed"; casterId: string; cells: XY[]; lapsRemaining: number }
    // Walls that burnt out on lap transition — the client drops their visuals.
    | { type: "fire_wall_expired"; cells: XY[] }
    /**
     * A creature crossed one or more burning cells during its move and got seared for each of them.
     *
     * Reported per crossing unit rather than per cell so the client pops ONE damage number for the whole
     * walk, and carried as its own event (not folded into `unit_moved`) because ranked rebuilds both its
     * scene log and its floating numbers from events. `position` is the victim's world position captured
     * BEFORE the damage lands, for the same reason `damaged` on spell_cast captures it early: a stack that
     * dies to the flames is gone by the time the visuals play.
     */
    | {
          type: "fire_wall_burned";
          unitId: string;
          cells: XY[];
          position: XY;
          amount: number;
          unitsDied: number;
      }
    | { type: "fight_finished"; winningTeam: TeamType };
