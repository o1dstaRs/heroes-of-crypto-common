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
import type { PlacementPolicyVariant } from "./setup/setup_ship";
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
     * Deduplicated creature identities from the opponent's complete, placement-visible drafted roster. This
     * deliberately carries no opponent positions, stack sizes, artifacts, perk, augments, or synergies. It is
     * consumed only when setupPlacementPolicy explicitly selects a complete-public-roster experiment.
     */
    publicOpponentCreatureIds?: readonly number[];
    /**
     * Legacy partial pick-phase knowledge (perk reveals + pick collisions). Kept separate from the complete
     * placement-visible roster so the shipped `legitimate-reveal` policy remains byte-identical while a
     * complete-roster candidate is measured independently.
     *
     * @deprecated New full-roster policies should use publicOpponentCreatureIds.
     */
    revealedOpponentCreatures?: readonly number[];
    /** Explicit setup-policy placement mode. When present it overrides the legacy process env gate. */
    setupPlacementPolicy?: PlacementPolicyVariant;
}

export type AIPolicyEventKind =
    | "v0.8_supported_ranged_escape"
    | "v0.8_response_neutral_advance"
    | "v0.8_supported_prepin_egress"
    | "v0.8_supported_prepin_egress_funnel";

export const V08_SUPPORTED_PREPIN_EGRESS_FUNNEL_STAGES = [
    "ordinary_shot",
    "eligible_shooter",
    "target_no_counter",
    "future_exposure",
    "native_guard",
    "current_signature",
    "reachable_route",
    "pending_distance_safe",
    "screened_route",
    "exposure_improved",
    "retained_signature",
    "posture_safe",
] as const;

export type V08SupportedPrepinEgressFunnelStage = (typeof V08_SUPPORTED_PREPIN_EGRESS_FUNNEL_STAGES)[number];

/** Detached, read-only strategy telemetry used by simulation diagnostics; live callers leave it unset. */
export interface IAIPolicyEvent {
    kind: AIPolicyEventKind;
    unitId: string;
    creatureName: string;
    team: TeamType;
    lap: number;
    /** Present only on research funnel events; ordinary policy-selection events leave it unset. */
    stage?: V08SupportedPrepinEgressFunnelStage;
}

export interface IDecisionContext {
    grid: Grid;
    matrix: number[][];
    unitsHolder: UnitsHolder;
    pathHelper: PathHelper;
    /**
     * Optional: lets a strategy ask whether a unit can actually LAND a ranged shot right now (not just
     * whether it has ammo) — i.e. it isn't boxed in by melee and isn't range-suppressed — and to
     * evaluate candidate shots (which units a trajectory hits, with what divisors). v0.1 uses it as an
     * exact legality guard; v0.2+ also uses it to score and pick the best shot.
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
    /** Optional simulation-only policy telemetry. Observers must not mutate strategy or battle state. */
    policyEventObserver?: (event: IAIPolicyEvent) => void;
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
