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
import type { DecisionPathCatalog } from "./decision_path_catalog";
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
    | "v0.8_supported_ranged_escape_funnel"
    | "v0.8_response_neutral_advance"
    | "v0.8_protected_advance_guardrail"
    | "v0.8_supported_prepin_egress"
    | "v0.8_supported_prepin_egress_funnel"
    | "v0.8_supported_band_advance"
    | "v0.8_supported_band_advance_funnel"
    | "v0.8_supported_band_dominance_comparison"
    | "v0.8_supported_band_screened_closer_comparison"
    | "v0.8_supported_band_duel_difference";

export const V08_SUPPORTED_RANGED_ESCAPE_FUNNEL_STAGES = [
    "melee_incumbent",
    "attack_context",
    "current_ranged_mode",
    "ammo",
    "mobile",
    "ordinary_shooter",
    "range_unsuppressed",
    "currently_pinned",
    "no_nonmelee_commitment",
    "finish_override_clear",
    "armageddon_buffer_clear",
    "target_found",
    "damage_supported",
    "nonsecure_melee",
    "live_enemies",
    "frontline_present",
    "reachable_route",
    "valid_route",
    "legacy_retreat_route",
    "target_screen_route",
    "unscreened_reduced_route",
    "exposure_nonincreasing_route",
    "partial_delta_route",
    "delta_only_best",
] as const;

export type V08SupportedRangedEscapeFunnelStage = (typeof V08_SUPPORTED_RANGED_ESCAPE_FUNNEL_STAGES)[number];

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

export const V08_SUPPORTED_BAND_ADVANCE_FUNNEL_STAGES = [
    "ordinary_shot",
    "eligible_shooter",
    "target_no_counter",
    "native_guard",
    "current_signature",
    "ranged_posture",
    "reachable_route",
    "zero_exposure_route",
    "target_screened",
    "strictly_closer",
    "retained_signature",
    "damage_band_improved",
    /** Neutral matched-arm comparison: strict emitted a real proposal and is eligible for dominance filtering. */
    "dominance_eligible",
    /** Neutral matched-arm comparison: strict objectively improves shipped divisor/exposure metadata. */
    "dominance_dominant",
    /** Neutral matched-arm comparison: shipped is equal or better and therefore remains selected. */
    "dominance_filtered",
    /** Neutral matched-arm comparison: strict proposed and shipped emitted a structurally consistent outcome. */
    "screened_closer_eligible",
    /** Neutral matched-arm comparison: strict is safely screened and objectively closer than shipped. */
    "screened_closer_dominant",
    /** Neutral matched-arm comparison: the screened-closer proof did not qualify or failed closed. */
    "screened_closer_filtered",
] as const;

export type V08SupportedBandAdvanceFunnelStage = (typeof V08_SUPPORTED_BAND_ADVANCE_FUNNEL_STAGES)[number];

interface IAIPolicyEventBase {
    unitId: string;
    creatureName: string;
    team: TeamType;
    lap: number;
}

/** Detached geometry for one live weak-melee escape proposal. */
export interface IV08SupportedRangedEscapeDetails {
    fromCell: XY;
    toCell: XY;
    incumbentAttackFromCell: XY;
    targetId: string;
    targetCreatureName: string;
    targetHp: number;
    meleeHitChance: number;
    expectedEffectiveMeleeDamage: number;
    reachableThreatsBefore: number;
    screenedThreatsBefore: number;
    unscreenedThreatsBefore: number;
    reachableThreatsAfter: number;
    screenedThreatsAfter: number;
    unscreenedThreatsAfter: number;
    targetDistanceBefore: number;
    targetDistanceAfter: number;
    minEnemyDistanceBefore: number;
    minEnemyDistanceAfter: number;
    nearestFrontlineDistanceAfter: number;
    screeningFrontlinerId: string;
    screeningFrontlinerCreatureName: string;
    routeCost: number;
}

/** Detached geometry for one live supported pre-pin proposal. */
export interface IV08SupportedPrepinEgressDetails {
    fromCell: XY;
    toCell: XY;
    targetId: string;
    targetCreatureName: string;
    exposureBefore: number;
    exposureAfter: number;
    divisorBefore: number;
    divisorAfter: number;
    targetDistanceBefore: number;
    targetDistanceAfter: number;
    minEnemyDistanceBefore: number;
    minEnemyDistanceAfter: number;
    rangedSuperior: boolean;
}

/** Detached geometry for one strict, fully screened ranged damage-band proposal. */
export interface IV08SupportedBandAdvanceDetails extends IV08SupportedPrepinEgressDetails {
    /** Whether v0.8's dominant or urgent anti-Armageddon finish sprint released the ranged-superiority hold. */
    finishActive: boolean;
    /** Whether a native-melee ally screens the selected destination from the aimed target. */
    targetScreenedAfter: boolean;
    /** Stable identity of the native-melee target screen used by the selected route. */
    screeningGuardId: string | null;
    /** Whether the selected move preserves the incumbent shot's complete non-regressing hit signature. */
    retainedSignatureAfter: boolean;
}

export type V08SupportedBandDuelDifference =
    "strict_hold_shipped_advance" | "strict_advance_shipped_hold" | "different_advance" | "other";

/** Detached executable fields used to compare one strict-vs-shipped supported-band decision. */
export interface IV08SupportedBandDuelDecisionSummary {
    actionTypes: GameAction["type"][];
    movePath: XY[] | null;
    moveTargetCells: XY[] | null;
    moveHasLavaCell: boolean | null;
    moveHasWaterCell: boolean | null;
    rangeTargetId: string | null;
    rangeAimCell: XY | null;
    rangeAimSide: number | null;
}

/** Exact root decision difference produced by the strict-vs-shipped supported-band duel. */
export interface IV08SupportedBandDuelDetails {
    difference: V08SupportedBandDuelDifference;
    strict: IV08SupportedBandDuelDecisionSummary;
    shipped: IV08SupportedBandDuelDecisionSummary;
}

export type V08SupportedBandDominanceReason =
    "no_shipped_advance" | "lower_divisor" | "lower_reachable_threats" | "filtered";

/** Neutral strict-vs-shipped metadata comparison emitted identically by matched dominance catalogs. */
export interface IV08SupportedBandDominanceComparisonDetails {
    /** Whether the arm selected strict; false in the matched selector-off control. */
    selected: boolean;
    /** Objective comparison result before the matched control selector is applied. */
    dominant: boolean;
    /** False when strict or present shipped metadata is non-finite, negative, or otherwise malformed. */
    metadataValid: boolean;
    /** First satisfied dominance rule in preregistered order, or filtered when shipped is equal/better/invalid. */
    reason: V08SupportedBandDominanceReason;
    targetId: string;
    targetCreatureName: string;
    strict: IV08SupportedBandDuelDecisionSummary;
    shipped: IV08SupportedBandDuelDecisionSummary;
    strictDivisorAfter: number | null;
    strictReachableThreatsAfter: number | null;
    shippedDivisorAfter: number | null;
    shippedReachableThreatsAfter: number | null;
}

export type V08SupportedBandScreenedCloserReason = "screened_closer" | "decisive_screened_closer" | "filtered";

/** Neutral strict-vs-shipped proof for the separately sealed screened-closer overlay. */
export interface IV08SupportedBandScreenedCloserComparisonDetails {
    /** Whether the arm selected strict; false in the matched selector-off control. */
    selected: boolean;
    /** Objective comparison result before the matched control selector is applied. */
    dominant: boolean;
    /** False only for malformed or inconsistent geometry/metadata; a valid shipped shot-only fallback is true. */
    metadataValid: boolean;
    reason: V08SupportedBandScreenedCloserReason;
    targetId: string;
    targetCreatureName: string;
    strict: IV08SupportedBandDuelDecisionSummary;
    shipped: IV08SupportedBandDuelDecisionSummary;
    strictFromCell: XY;
    strictToCell: XY;
    shippedFromCell: XY | null;
    shippedToCell: XY | null;
    strictDivisorBefore: number | null;
    strictDivisorAfter: number | null;
    strictReachableThreatsBefore: number | null;
    strictReachableThreatsAfter: number | null;
    strictTargetDistanceBefore: number | null;
    strictTargetDistanceAfter: number | null;
    strictTargetDistanceCompression: number | null;
    strictFinishActive: boolean | null;
    strictTargetScreenedAfter: boolean | null;
    strictScreeningGuardId: string | null;
    strictRetainedSignatureAfter: boolean | null;
    shippedDivisorBefore: number | null;
    shippedDivisorAfter: number | null;
    shippedReachableThreatsAfter: number | null;
    shippedTargetDistanceBefore: number | null;
    shippedTargetDistanceAfter: number | null;
    shippedTargetDistanceCompression: number | null;
    shippedFinishActive: boolean | null;
    shippedTargetScreenedAfter: boolean | null;
    shippedScreeningGuardId: string | null;
    shippedRetainedSignatureAfter: boolean | null;
}

export type V08ProtectedAdvanceGuardrailReason = "ranged_superior_hold" | "partial_band";
export type V08ProtectedAdvanceGuardrailMode = "both" | "catalog_only" | V08ProtectedAdvanceGuardrailReason;

/** Detached incumbent proposal that a live-root guardrail converted back to the original ranged shot. */
export interface IV08ProtectedAdvanceGuardrailDetails {
    reason: V08ProtectedAdvanceGuardrailReason;
    fromCell: XY;
    toCell: XY;
    targetId: string;
    targetCreatureName: string;
    divisorBefore: number;
    divisorAfter: number;
    ownRangedOutput: number;
    enemyRangedOutput: number;
    rangedSuperior: boolean;
    finishActive: boolean;
    reachableThreatsAfter: number;
}

/** Detached, read-only strategy telemetry used by simulation diagnostics; live callers leave it unset. */
export type IAIPolicyEvent =
    | (IAIPolicyEventBase & {
          kind: "v0.8_supported_ranged_escape";
          details: IV08SupportedRangedEscapeDetails;
          stage?: never;
      })
    | (IAIPolicyEventBase & {
          kind: "v0.8_supported_ranged_escape_funnel";
          stage: V08SupportedRangedEscapeFunnelStage;
          details?: never;
      })
    | (IAIPolicyEventBase & {
          kind: "v0.8_protected_advance_guardrail";
          details: IV08ProtectedAdvanceGuardrailDetails;
          stage?: never;
      })
    | (IAIPolicyEventBase & {
          kind: "v0.8_supported_band_advance";
          details: IV08SupportedBandAdvanceDetails;
          stage?: never;
      })
    | (IAIPolicyEventBase & {
          kind: "v0.8_supported_band_advance_funnel";
          stage: V08SupportedBandAdvanceFunnelStage;
          details?: never;
      })
    | (IAIPolicyEventBase & {
          kind: "v0.8_supported_band_duel_difference";
          details: IV08SupportedBandDuelDetails;
          stage?: never;
      })
    | (IAIPolicyEventBase & {
          kind: "v0.8_supported_band_dominance_comparison";
          details: IV08SupportedBandDominanceComparisonDetails;
          stage?: never;
      })
    | (IAIPolicyEventBase & {
          kind: "v0.8_supported_band_screened_closer_comparison";
          details: IV08SupportedBandScreenedCloserComparisonDetails;
          stage?: never;
      })
    | (IAIPolicyEventBase & {
          kind: "v0.8_supported_prepin_egress";
          details: IV08SupportedPrepinEgressDetails;
          stage?: never;
      })
    | (IAIPolicyEventBase & {
          kind: "v0.8_supported_prepin_egress_funnel";
          stage: V08SupportedPrepinEgressFunnelStage;
          details?: never;
      })
    | (IAIPolicyEventBase & {
          kind: Exclude<
              AIPolicyEventKind,
              | "v0.8_supported_ranged_escape"
              | "v0.8_supported_ranged_escape_funnel"
              | "v0.8_supported_band_advance"
              | "v0.8_supported_band_advance_funnel"
              | "v0.8_supported_band_dominance_comparison"
              | "v0.8_supported_band_screened_closer_comparison"
              | "v0.8_supported_band_duel_difference"
              | "v0.8_protected_advance_guardrail"
              | "v0.8_supported_prepin_egress"
              | "v0.8_supported_prepin_egress_funnel"
          >;
          stage?: never;
          details?: never;
      });

export interface IDecisionContext {
    grid: Grid;
    matrix: number[][];
    unitsHolder: UnitsHolder;
    pathHelper: PathHelper;
    /** @internal Shared read-only reachability for this synchronous decision only. */
    readonly decisionPathCatalog?: DecisionPathCatalog;
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
    /**
     * Explicit origin for policies that must distinguish a live incumbent from a hypothetical future turn.
     * Research selectors should fail closed when this is absent; ordinary policies ignore it.
     */
    decisionOrigin?: "root" | "rollout";
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
