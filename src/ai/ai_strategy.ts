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
import type { FightProperties } from "../fights/fight_properties";
import type { TeamType } from "../generated/protobuf/v1/types_gen";
import type { Grid } from "../grid/grid";
import type { PathHelper } from "../grid/path_helper";
import type { IPlacement } from "../grid/placement_properties";
import type { AttackHandler } from "../handlers/attack_handler";
import type { Unit } from "../units/unit";
import type { UnitsHolder } from "../units/units_holder";
import type { XY } from "../utils/math";

/**
 * Versioned strategy seam for the in-game (heuristic, non-LLM) AI.
 *
 * Every behavioural decision the AI makes — where it deploys its army before the fight and what each
 * unit does on its turn — goes through an IAIStrategy. Strategies are registered by version string
 * (see ai/index.ts), so multiple generations (v0.1, v0.2, …) coexist and can be pitted head-to-head
 * by the battle engine. v0.1 is the frozen baseline (today's shipping `findTarget` behaviour); later
 * versions diverge from it without touching the baseline, so a tournament cleanly answers "did the
 * new version actually improve?".
 */
export interface IPlacementContext {
    team: TeamType;
    grid: Grid;
    unitsHolder: UnitsHolder;
    pathHelper: PathHelper;
    /** The legal deployment rectangle for this team (cells the strategy may place onto). */
    placement: IPlacement;
    /**
     * Optional: creature ids of OPPONENT stacks this team LEGITIMATELY learned during the pick phase
     * (perk reveals + pick collisions — pick_sim's getKnownOpponentCreatures; live equivalent: the
     * server session's knownOpponentCreatureIdsByPlayer). Absent/empty = the seat knows nothing it
     * could fairly act on. Consumed only by the env-gated reveal-conditioned placement experiment
     * (V07_PLACEMENT_REVEAL=on, default off); absent keeps every strategy byte-identical.
     */
    revealedOpponentCreatures?: readonly number[];
}

export interface IDecisionContext {
    grid: Grid;
    matrix: number[][];
    unitsHolder: UnitsHolder;
    pathHelper: PathHelper;
    /**
     * Optional: lets a strategy ask whether a unit can actually LAND a ranged shot right now (not just
     * whether it has ammo) — i.e. it isn't boxed in by melee and isn't range-suppressed — and to
     * evaluate candidate shots (which units a trajectory hits, with what divisors). v0.1 ignores it;
     * v0.2+ uses it to pick the best shot and to stop wasting turns on doomed ones.
     */
    attackHandler?: AttackHandler;
    /** Optional: turn/hourglass state, so a strategy can decide whether a unit may wait (hourglass). */
    fightProperties?: FightProperties;
    /**
     * Optional: base cells of SMALL enemy units within the ACTIVE unit's movement range — the legality
     * input for ENEMY_WITHIN_MOVEMENT_RANGE spells (Harpy's Castling). The client computes this when a
     * player arms the spell (Sandbox.currentEnemiesCellsWithinMovementRange); AI-side consumers may omit
     * it and the candidate generator (ai/candidates.ts getEnemiesCellsWithinMovementRange) computes the
     * same list locally. NOTE: for a Castling cast to be ACCEPTED, the GameActionEngine context must
     * expose the same list via IGameActionEngineContext.getCurrentEnemiesCellsWithinMovementRange —
     * wire both from the same helper.
     */
    getCurrentEnemiesCellsWithinMovementRange?: () => XY[] | undefined;
}

export interface IAIStrategy {
    /** Stable version id, e.g. "v0.1". Recorded into every match log. */
    readonly version: string;

    /**
     * Choose a base cell for each of this team's units before the fight. Returns unitId -> base cell
     * (top-left cell for large units). The battle engine validates each cell is inside the team's
     * placement zone and non-overlapping; any unit left unplaced is auto-placed by the engine.
     */
    placeArmy(units: Unit[], context: IPlacementContext): Map<string, XY>;

    /**
     * The full ordered list of engine actions for the active unit's turn — e.g.
     * [select_attack_type, range_attack], a single move_unit, or an end_turn to pass. Never empty;
     * the battle engine still force-ends the turn if these actions don't complete it (safety net).
     */
    decideTurn(unit: Unit, context: IDecisionContext): GameAction[];
}
