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

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

import {
    buildArchetypeRoster,
    buildSharedArchetypeOffers,
    setupForArchetype,
    ARCHETYPE_NAMES,
    type ArchetypeName,
} from "./archetype_payoff";
import {
    creaturesByLevel,
    DEFAULT_AMOUNT_BY_LEVEL,
    makeRng,
    resolveStackAmount,
    type IArmyUnitSpec,
    type StackAmountMode,
} from "./army";
import {
    GREEN_TEAM,
    runMatch,
    type IDecisionObservation,
    type IMatchConfig,
    type IMatchResult,
    type ITurnExecutionObservation,
    type TurnRecoverySource,
} from "./battle_engine";
import { FightStateManager } from "../fights/fight_state_manager";
import type { GameAction } from "../engine/actions";
import { PBTypes } from "../generated/protobuf/v1/types";
import {
    V08_SUPPORTED_BAND_ADVANCE_FUNNEL_STAGES,
    V08_SUPPORTED_PREPIN_EGRESS_FUNNEL_STAGES,
    V08_SUPPORTED_RANGED_ESCAPE_FUNNEL_STAGES,
    type IAIPolicyEvent,
    type IV08ProtectedAdvanceGuardrailDetails,
    type IV08SupportedBandAdvanceDetails,
    type IV08SupportedBandDominanceComparisonDetails,
    type IV08SupportedBandScreenedCloserComparisonDetails,
    type IV08SupportedBandDuelDecisionSummary,
    type IV08SupportedBandDuelDetails,
    type IV08SupportedPrepinEgressDetails,
    type IV08SupportedRangedEscapeDetails,
    type V08ProtectedAdvanceGuardrailReason,
    type V08SupportedBandAdvanceFunnelStage,
    type V08SupportedBandDominanceReason,
    type V08SupportedBandScreenedCloserReason,
    type V08SupportedBandDuelDifference,
    type V08SupportedPrepinEgressFunnelStage,
    type V08SupportedRangedEscapeFunnelStage,
} from "../ai/ai_strategy";
import {
    canWaitOnHourglassMirror,
    DISTILLED_WAIT_WEIGHTS_2026_07_10,
    extractWaitFeatures,
    waitScore,
    waitScorerInSupport,
} from "../ai/versions/wait_scorer";

/**
 * MEASURE MIRROR COHORTS — version-vs-version A/B on FORCED SYMMETRIC rosters.
 *
 * Both seats field the IDENTICAL roster (a committed archetype from archetype_payoff.ts, or the fixed
 * 6/6 pure-shooter roster); only the AI version differs, with paired side-swap seeds (games 2k / 2k+1
 * share seed + roster and swap which seat runs version A). This isolates the VERSION effect per army
 * composition — the axis every melee-skewed draft gate misses (FIGHT_MELEE_ROSTERS=0 still yields
 * melee-heavy DRAFTED rosters, so "random cohort" gates never test ranged mirrors).
 *
 * WHY THIS EXISTS (2026-07-10 ranged-collapse reproduction): v0.7's baked wait-scorer was distilled from
 * 5,000 LIVETWIN MELEE-draft oracle games. On ranged armies it extrapolates out-of-distribution and
 * waits on ~40-48% of decisions (the incumbent v0.5 hourglass rule deliberately EXCLUDED RANGE units).
 * In a shootout, waiting does not dodge incoming fire — it cedes first-volley focus-fire every lap.
 * Measured v0.7 vs v0.6 (paired mirrors, LIVETWIN, fresh 78xx710 seeds): melee_coevo 72.1%±0.7,
 * hybrid 58.4%±0.8, ranged_max_sniper3 25.0%±0.7, pure_ranged 2.1%±0.3 (reproduces the 2.7% probe);
 * with V07_WAIT_WEIGHTS all-zero (scorer disabled, salvage kept) every ranged cohort returns to EXACT
 * 50.00% parity — the collapse is 100% the wait-scorer.
 *
 * FIXED (same day) by the wait_scorer.ts TRAINING-SUPPORT GUARD (default "support": melee-attack-type
 * acting unit AND majority-melee own army). Guarded v0.7 vs v0.6, 3k paired games per cell, seeds
 * 7815710/7816710/7817710/7818710: melee_coevo 71.5%±0.8 (edge retained), hybrid 60.2%±0.9,
 * ranged_max_sniper3 50.6%±0.9 (was 25.0), pure_ranged EXACT 50.00%±1.1 (was 2.1). The "class"-only
 * arm scored 48.9%±0.9 on ranged_max (paired seed 7817710) — the army-context clause is worth +1.7pp
 * there, so "support" ships as the default. Diag (200 games, seed 7821710): v0.7 wait rate 4.0% vs
 * v0.6 3.9% (was 40.9% vs 5.1%), shot damage/game 1011 vs 1008 (was 753 vs 1304), casualty curves
 * indistinguishable, cfScorerFiresInSupport = 0 on the armed seat.
 *
 * Usage:
 *   bun src/simulation/measure_mirror_cohorts.ts --cohort ranged_max_sniper3 --games 4000 --seed 7803710 \
 *       --concurrency 10 --out sim-out/mirror_ranged            # LIVETWIN exp-budget amounts (default)
 *   ... --livetwin 0 --amount-mode levelTable                   # historical {50,30,15,8} sanity config
 *   ... --diag                                                  # per-decision observer + full action logs:
 *       per-side wait rates per lap, wait-scorer counterfactual fires, first-volley stats, casualty curves
 *   ... --zero-scorer                                           # V07_WAIT_WEIGHTS=all-zero (disables ONLY
 *       v0.7's baked wait-scorer; caster salvage stays) — the scorer-attribution arm
 *   ... --guard off|class|support                               # V07_WAIT_GUARD arm: "off" reproduces the
 *       pre-fix unguarded scorer; empty = the code default ("support", the shipped training-support guard)
 */

export const PURE_RANGED_ROSTER_NAMES: readonly { level: number; creatureName: string }[] = [
    { level: 1, creatureName: "Arbalester" },
    { level: 1, creatureName: "Orc" },
    { level: 2, creatureName: "Elf" },
    { level: 2, creatureName: "Medusa" },
    { level: 3, creatureName: "Cyclops" },
    { level: 4, creatureName: "Tsar Cannon" },
];

/** Fixed mixed screen used to oversample native Large Caliber and Through Shot decisions. */
export const MIXED_CYCLOPS_TSAR_ROSTER_NAMES: readonly { level: number; creatureName: string }[] = [
    { level: 1, creatureName: "Squire" },
    { level: 1, creatureName: "Arbalester" },
    { level: 2, creatureName: "Pikeman" },
    { level: 2, creatureName: "Elf" },
    { level: 3, creatureName: "Cyclops" },
    { level: 4, creatureName: "Tsar Cannon" },
];

export type MirrorCohortName = ArchetypeName | "pure_ranged" | "mixed_cyclops_tsar";

export const MIRROR_COHORTS: readonly MirrorCohortName[] = [...ARCHETYPE_NAMES, "pure_ranged", "mixed_cyclops_tsar"];

export interface IMirrorRunConfig {
    cohort: MirrorCohortName;
    games: number;
    seed: number;
    vA: string;
    vB: string;
    amountMode: StackAmountMode;
    livetwin: boolean;
    diag: boolean;
    zeroScorer: boolean;
    /** V07_WAIT_GUARD arm for the run: "" = code default ("support"); "off" reproduces the pre-fix scorer. */
    guard?: "" | "support" | "class" | "off";
}

export interface IMirrorLapDiag {
    lap: number;
    decisions: number;
    waits: number;
    eligible: number;
    cfFires: number;
}

export interface IMirrorSideDiag {
    version: string;
    decisions: number;
    waits: number;
    waitsRangedUnit: number;
    eligible: number;
    cfFires: number;
    cfFiresRangedUnit: number;
    /** cfFires that are ALSO inside the training-support guard (wait_scorer.ts waitScorerInSupport). */
    cfFiresInSupport: number;
    byLap: IMirrorLapDiag[];
    shots: number;
    shotDamage: number;
    /** Adjacent completed move_unit -> range_attack pairs by the same side/unit/lap. */
    moveShotSequences: number;
    /** Recorded range-attack damage dealt by moveShotSequences. */
    moveShotRangeDamage: number;
    /** Delta-only weak-melee escapes selected by v0.8 ranged positioning. */
    supportedRangedEscapes: number;
    /** Pre-search weak-melee escape proposals, including ones later replaced by a13. */
    supportedRangedEscapeProposals: number;
    /** Live-root catalog counts at each weak-melee supported-delta eligibility stage. */
    supportedRangedEscapeFunnel: Record<V08SupportedRangedEscapeFunnelStage, number>;
    /** Delta-only protected advances whose ordinary counter-shot was proven response-neutral. */
    responseNeutralAdvances: number;
    /** Pre-search response-neutral advance proposals, including ones later replaced by a13. */
    responseNeutralAdvanceProposals: number;
    /** Supported damage-band advances retained after a13 arbitration. */
    supportedBandAdvanceSelections: number;
    /** Selector-enabled root proposals for supported damage-band advances. */
    supportedBandAdvanceProposals: number;
    /** Root-catalog counts at each supported damage-band stage, including selector-disabled catalog-only runs. */
    supportedBandAdvanceFunnel: Record<V08SupportedBandAdvanceFunnelStage, number>;
    /** Strict proposals eligible for the neutral dominance comparison, before search arbitration. */
    supportedBandDominanceEligibleComparisons: number;
    /** Eligible comparisons whose strict catalog objectively dominates shipped metadata. */
    supportedBandDominanceDominantComparisons: number;
    /** Eligible comparisons kept on shipped because strict was equal, worse, or malformed. */
    supportedBandDominanceFilteredComparisons: number;
    /** Dominant comparisons whose arm selector chose strict (zero in the matched selector-off control). */
    supportedBandDominanceSelectedComparisons: number;
    /** Filtered comparisons caused by malformed/non-finite/negative metadata. */
    supportedBandDominanceInvalidComparisons: number;
    /** Eligible comparisons split by the first satisfied preregistered dominance rule. */
    supportedBandDominanceComparisonsByReason: Record<V08SupportedBandDominanceReason, number>;
    /** Strict proposals eligible for the independently sealed screened-closer comparison. */
    supportedBandScreenedCloserEligibleComparisons: number;
    /** Eligible comparisons whose strict route satisfies the complete screened-closer proof. */
    supportedBandScreenedCloserDominantComparisons: number;
    /** Eligible comparisons retained on shipped because the proof failed closed. */
    supportedBandScreenedCloserFilteredComparisons: number;
    /** Proven comparisons whose treatment selector chose strict. */
    supportedBandScreenedCloserSelectedComparisons: number;
    /** Comparisons rejected for malformed/inconsistent metadata; valid shipped shot-only fallbacks are excluded. */
    supportedBandScreenedCloserInvalidComparisons: number;
    /** Screened-closer comparisons split by objective result. */
    supportedBandScreenedCloserComparisonsByReason: Record<V08SupportedBandScreenedCloserReason, number>;
    /** Strict-vs-shipped root decision differences retained after a13 arbitration. */
    supportedBandDuelDifferenceSelections: number;
    /** Pre-search strict-vs-shipped root decision differences. */
    supportedBandDuelDifferenceProposals: number;
    /** Retained strict-vs-shipped root decision differences split by action direction. */
    supportedBandDuelDifferenceSelectionsByDifference: Record<V08SupportedBandDuelDifference, number>;
    /** Proposed strict-vs-shipped root decision differences split by action direction. */
    supportedBandDuelDifferenceProposalsByDifference: Record<V08SupportedBandDuelDifference, number>;
    /** Shipped protected advances converted back to the original ranged shot by a live-root guardrail. */
    protectedAdvanceGuardrailVetoes: number;
    /** Protected-advance vetoes split by the guardrail that fired. */
    protectedAdvanceGuardrailVetoesByReason: Record<V08ProtectedAdvanceGuardrailReason, number>;
    /** Live-root protected-advance guardrail proposals, including ones later replaced by search. */
    protectedAdvanceGuardrailProposals: number;
    /** Protected-advance guardrail proposals split by the proposed veto reason. */
    protectedAdvanceGuardrailProposalsByReason: Record<V08ProtectedAdvanceGuardrailReason, number>;
    /** Supported pre-pin egress proposals retained after a13 arbitration. */
    supportedPrepinEgressSelections: number;
    /** Pre-search supported pre-pin egress proposals, including ones later replaced by a13. */
    supportedPrepinEgressProposals: number;
    /** Selector-scoped, pre-search counts at each supported pre-pin eligibility stage. */
    supportedPrepinEgressFunnel: Record<V08SupportedPrepinEgressFunnelStage, number>;
    meleeDamage: number;
    firstVolleyLap: number | null;
    firstVolleyDamage: number | null;
    dmgByLap: Record<number, number>;
    /** Deaths SUFFERED by this side's units, by lap (action-attributed; narrowing/armageddon excluded). */
    deathsByLap: Record<number, number>;
}

const newSupportedPrepinEgressFunnel = (): Record<V08SupportedPrepinEgressFunnelStage, number> =>
    Object.fromEntries(V08_SUPPORTED_PREPIN_EGRESS_FUNNEL_STAGES.map((stage) => [stage, 0])) as Record<
        V08SupportedPrepinEgressFunnelStage,
        number
    >;

const newSupportedRangedEscapeFunnel = (): Record<V08SupportedRangedEscapeFunnelStage, number> =>
    Object.fromEntries(V08_SUPPORTED_RANGED_ESCAPE_FUNNEL_STAGES.map((stage) => [stage, 0])) as Record<
        V08SupportedRangedEscapeFunnelStage,
        number
    >;

const newSupportedBandAdvanceFunnel = (): Record<V08SupportedBandAdvanceFunnelStage, number> =>
    Object.fromEntries(V08_SUPPORTED_BAND_ADVANCE_FUNNEL_STAGES.map((stage) => [stage, 0])) as Record<
        V08SupportedBandAdvanceFunnelStage,
        number
    >;

const SUPPORTED_BAND_DUEL_DIFFERENCES: readonly V08SupportedBandDuelDifference[] = [
    "strict_hold_shipped_advance",
    "strict_advance_shipped_hold",
    "different_advance",
    "other",
];

const newSupportedBandDuelDifferenceCounts = (): Record<V08SupportedBandDuelDifference, number> => ({
    strict_hold_shipped_advance: 0,
    strict_advance_shipped_hold: 0,
    different_advance: 0,
    other: 0,
});

const SUPPORTED_BAND_DOMINANCE_REASONS: readonly V08SupportedBandDominanceReason[] = [
    "no_shipped_advance",
    "lower_divisor",
    "lower_reachable_threats",
    "filtered",
];

const newSupportedBandDominanceReasonCounts = (): Record<V08SupportedBandDominanceReason, number> => ({
    no_shipped_advance: 0,
    lower_divisor: 0,
    lower_reachable_threats: 0,
    filtered: 0,
});

const SUPPORTED_BAND_SCREENED_CLOSER_REASONS: readonly V08SupportedBandScreenedCloserReason[] = [
    "screened_closer",
    "decisive_screened_closer",
    "filtered",
];

const newSupportedBandScreenedCloserReasonCounts = (): Record<V08SupportedBandScreenedCloserReason, number> => ({
    screened_closer: 0,
    decisive_screened_closer: 0,
    filtered: 0,
});

const PROTECTED_ADVANCE_GUARDRAIL_REASONS: readonly V08ProtectedAdvanceGuardrailReason[] = [
    "ranged_superior_hold",
    "partial_band",
];

const newProtectedAdvanceGuardrailReasonCounts = (): Record<V08ProtectedAdvanceGuardrailReason, number> => ({
    ranged_superior_hold: 0,
    partial_band: 0,
});

export interface IMirrorGameRecord {
    game: number;
    seed: number;
    greenVersion: string;
    winnerVersion: string;
    laps: number;
    endReason: IMatchResult["endReason"];
    armageddon: boolean;
    rejectedGreen: number;
    rejectedRed: number;
    rosterSig?: string;
    diag?: { green: IMirrorSideDiag; red: IMirrorSideDiag };
    /** Root proposals only; omitted when the game has none to keep large JSONL artifacts compact. */
    supportedBandAdvanceEvents?: IMirrorSupportedBandAdvanceEvent[];
    /** Neutral dominance comparisons; retained marks the comparison attached to the search-selected incumbent. */
    supportedBandDominanceComparisonEvents?: IMirrorSupportedBandDominanceComparisonEvent[];
    /** Neutral screened-closer comparisons; retained marks the comparison attached to the selected incumbent. */
    supportedBandScreenedCloserComparisonEvents?: IMirrorSupportedBandScreenedCloserComparisonEvent[];
    /** Strict-vs-shipped decision differences; retained marks the incumbent that survived search. */
    supportedBandDuelDifferenceEvents?: IMirrorSupportedBandDuelDifferenceEvent[];
    /** Root veto proposals; retained marks the one surviving search. Omitted when none to keep JSONL compact. */
    protectedAdvanceGuardrailEvents?: IMirrorProtectedAdvanceGuardrailEvent[];
    /** Root proposals only; omitted when the game has none to keep large JSONL artifacts compact. */
    supportedPrepinEgressEvents?: IMirrorSupportedPrepinEgressEvent[];
    /** Root weak-melee escape proposals; retained marks the one surviving search. */
    supportedRangedEscapeEvents?: IMirrorSupportedRangedEscapeEvent[];
}

export interface IMirrorSupportedRangedEscapeEvent extends IV08SupportedRangedEscapeDetails {
    side: "green" | "red";
    unitId: string;
    creatureName: string;
    lap: number;
    retained: boolean;
}

export interface IMirrorSupportedBandAdvanceEvent extends IV08SupportedBandAdvanceDetails {
    side: "green" | "red";
    unitId: string;
    creatureName: string;
    lap: number;
    retained: boolean;
}

export interface IMirrorSupportedBandDominanceComparisonEvent extends IV08SupportedBandDominanceComparisonDetails {
    side: "green" | "red";
    unitId: string;
    creatureName: string;
    lap: number;
    retained: boolean;
}

export type MirrorSupportedBandScreenedCloserPostA13BindingStatus =
    "resolved" | "missing_turn_execution" | "no_matching_current_turn_comparison" | "multiple_current_turn_comparisons";

export type MirrorSupportedBandScreenedCloserFinalChoice =
    "strict" | "shipped" | "neither" | "ambiguous" | "unresolved";

export interface IMirrorSupportedBandScreenedCloserPostA13Actor {
    unitId: string;
    creatureName: string;
    side: "green" | "red";
    strategyVersion: string;
}

export interface IMirrorSupportedBandScreenedCloserPostA13Execution {
    strategyActionCompletions: boolean[];
    strategyActionRejectionReasons: Array<string | null>;
    strategyActionCountMatchesChosen: boolean;
    chosenDecisionCompleted: boolean;
    substantiveActionCompleted: boolean;
    recoveryAttemptCount: number;
    recoverySource: TurnRecoverySource;
    recoveryCompleted: boolean;
    recoveryRejectionReason: string | null;
}

/**
 * Post-SearchDriver evidence for the exact turn that produced a screened-closer comparison. Full actions are
 * retained because a13 may select an arbitrary melee, spell, move, or other challenger that the ranged summary
 * cannot represent. A non-resolved binding is deliberately unclassified and must fail closed downstream.
 */
export interface IMirrorSupportedBandScreenedCloserPostA13Evidence {
    bindingStatus: MirrorSupportedBandScreenedCloserPostA13BindingStatus;
    actor: IMirrorSupportedBandScreenedCloserPostA13Actor | null;
    rawIncumbent: GameAction[] | null;
    chosenDecision: GameAction[] | null;
    rawIncumbentMatchesStrict: boolean | null;
    rawIncumbentMatchesShipped: boolean | null;
    chosenMatchesStrict: boolean | null;
    chosenMatchesShipped: boolean | null;
    finalChoice: MirrorSupportedBandScreenedCloserFinalChoice;
    execution: IMirrorSupportedBandScreenedCloserPostA13Execution | null;
}

export interface IMirrorSupportedBandScreenedCloserComparisonEvent extends IV08SupportedBandScreenedCloserComparisonDetails {
    side: "green" | "red";
    unitId: string;
    creatureName: string;
    lap: number;
    retained: boolean;
    postA13: IMirrorSupportedBandScreenedCloserPostA13Evidence;
}

export interface IMirrorSupportedBandDuelDifferenceEvent extends IV08SupportedBandDuelDetails {
    side: "green" | "red";
    unitId: string;
    creatureName: string;
    lap: number;
    retained: boolean;
}

export interface IMirrorProtectedAdvanceGuardrailEvent extends IV08ProtectedAdvanceGuardrailDetails {
    side: "green" | "red";
    unitId: string;
    creatureName: string;
    lap: number;
    retained: boolean;
}

export interface IMirrorSupportedPrepinEgressEvent extends IV08SupportedPrepinEgressDetails {
    side: "green" | "red";
    unitId: string;
    creatureName: string;
    lap: number;
    retained: boolean;
}

export interface IMirrorDependencies {
    matchRunner?: (config: IMatchConfig) => IMatchResult;
}

const detachSupportedBandDuelDecision = (
    decision: IV08SupportedBandDuelDecisionSummary,
): IV08SupportedBandDuelDecisionSummary => ({
    ...decision,
    actionTypes: [...decision.actionTypes],
    movePath: decision.movePath?.map((cell) => ({ ...cell })) ?? null,
    moveTargetCells: decision.moveTargetCells?.map((cell) => ({ ...cell })) ?? null,
    rangeAimCell: decision.rangeAimCell ? { ...decision.rangeAimCell } : null,
});

const detachGameActions = (actions: ITurnExecutionObservation["chosenDecision"]): GameAction[] =>
    structuredClone(actions) as GameAction[];

const summarizeSupportedBandDecision = (
    decision: ITurnExecutionObservation["chosenDecision"],
): IV08SupportedBandDuelDecisionSummary => {
    const move = decision.find(
        (action): action is Readonly<Extract<GameAction, { type: "move_unit" }>> => action.type === "move_unit",
    );
    const shot = decision.find(
        (action): action is Readonly<Extract<GameAction, { type: "range_attack" }>> => action.type === "range_attack",
    );
    return {
        actionTypes: decision.map((action) => action.type),
        movePath: move ? move.path.map((cell) => ({ ...cell })) : null,
        moveTargetCells: move?.targetCells ? move.targetCells.map((cell) => ({ ...cell })) : null,
        moveHasLavaCell: move?.hasLavaCell ?? null,
        moveHasWaterCell: move?.hasWaterCell ?? null,
        rangeTargetId: shot?.targetId ?? null,
        rangeAimCell: shot?.aimCell ? { ...shot.aimCell } : null,
        rangeAimSide: shot?.aimSide ?? null,
    };
};

const sameCells = (
    left: readonly { x: number; y: number }[] | null,
    right: readonly { x: number; y: number }[] | null,
) =>
    left === right ||
    (left !== null &&
        right !== null &&
        left.length === right.length &&
        left.every((cell, index) => cell.x === right[index]!.x && cell.y === right[index]!.y));

const sameSupportedBandDecision = (
    left: IV08SupportedBandDuelDecisionSummary,
    right: IV08SupportedBandDuelDecisionSummary,
): boolean =>
    left.actionTypes.length === right.actionTypes.length &&
    left.actionTypes.every((type, index) => type === right.actionTypes[index]) &&
    sameCells(left.movePath, right.movePath) &&
    sameCells(left.moveTargetCells, right.moveTargetCells) &&
    left.moveHasLavaCell === right.moveHasLavaCell &&
    left.moveHasWaterCell === right.moveHasWaterCell &&
    left.rangeTargetId === right.rangeTargetId &&
    ((left.rangeAimCell === null && right.rangeAimCell === null) ||
        (left.rangeAimCell !== null &&
            right.rangeAimCell !== null &&
            left.rangeAimCell.x === right.rangeAimCell.x &&
            left.rangeAimCell.y === right.rangeAimCell.y)) &&
    left.rangeAimSide === right.rangeAimSide;

const supportedBandDecisionUsesActor = (
    decision: ITurnExecutionObservation["chosenDecision"],
    actorUnitId: string,
): boolean =>
    decision.every((action) => {
        if (action.type === "move_unit") return action.unitId === actorUnitId;
        if (action.type === "range_attack") return action.attackerId === actorUnitId;
        return true;
    });

const unresolvedSupportedBandScreenedCloserPostA13Evidence = (): IMirrorSupportedBandScreenedCloserPostA13Evidence => ({
    bindingStatus: "missing_turn_execution",
    actor: null,
    rawIncumbent: null,
    chosenDecision: null,
    rawIncumbentMatchesStrict: null,
    rawIncumbentMatchesShipped: null,
    chosenMatchesStrict: null,
    chosenMatchesShipped: null,
    finalChoice: "unresolved",
    execution: null,
});

const supportedBandScreenedCloserPostA13Evidence = (
    observation: ITurnExecutionObservation,
    comparison: IMirrorSupportedBandScreenedCloserComparisonEvent,
    bindingStatus: Exclude<MirrorSupportedBandScreenedCloserPostA13BindingStatus, "missing_turn_execution">,
): IMirrorSupportedBandScreenedCloserPostA13Evidence => {
    const rawIncumbent = detachGameActions(observation.rawIncumbent);
    const chosenDecision = detachGameActions(observation.chosenDecision);
    const resolved = bindingStatus === "resolved";
    const rawSummary = resolved ? summarizeSupportedBandDecision(observation.rawIncumbent) : null;
    const chosenSummary = resolved ? summarizeSupportedBandDecision(observation.chosenDecision) : null;
    const rawUsesActor = resolved && supportedBandDecisionUsesActor(observation.rawIncumbent, observation.unitId);
    const chosenUsesActor = resolved && supportedBandDecisionUsesActor(observation.chosenDecision, observation.unitId);
    const rawIncumbentMatchesStrict =
        rawSummary && rawUsesActor
            ? sameSupportedBandDecision(rawSummary, comparison.strict)
            : rawSummary
              ? false
              : null;
    const rawIncumbentMatchesShipped =
        rawSummary && rawUsesActor
            ? sameSupportedBandDecision(rawSummary, comparison.shipped)
            : rawSummary
              ? false
              : null;
    const chosenMatchesStrict =
        chosenSummary && chosenUsesActor
            ? sameSupportedBandDecision(chosenSummary, comparison.strict)
            : chosenSummary
              ? false
              : null;
    const chosenMatchesShipped =
        chosenSummary && chosenUsesActor
            ? sameSupportedBandDecision(chosenSummary, comparison.shipped)
            : chosenSummary
              ? false
              : null;
    const finalChoice: MirrorSupportedBandScreenedCloserFinalChoice =
        chosenMatchesStrict === null || chosenMatchesShipped === null
            ? "unresolved"
            : chosenMatchesStrict && chosenMatchesShipped
              ? "ambiguous"
              : chosenMatchesStrict
                ? "strict"
                : chosenMatchesShipped
                  ? "shipped"
                  : "neither";
    return {
        bindingStatus,
        actor: {
            unitId: observation.unitId,
            creatureName: observation.creatureName,
            side: observation.side,
            strategyVersion: observation.strategyVersion,
        },
        rawIncumbent,
        chosenDecision,
        rawIncumbentMatchesStrict,
        rawIncumbentMatchesShipped,
        chosenMatchesStrict,
        chosenMatchesShipped,
        finalChoice,
        execution: {
            strategyActionCompletions: observation.strategyActions.map((action) => action.completed),
            strategyActionRejectionReasons: observation.strategyActions.map((action) => action.rejectionReason ?? null),
            strategyActionCountMatchesChosen: observation.strategyActions.length === observation.chosenDecision.length,
            chosenDecisionCompleted:
                observation.chosenDecision.length > 0 &&
                observation.strategyActions.length === observation.chosenDecision.length &&
                observation.strategyActions.every((action) => action.completed),
            substantiveActionCompleted: observation.strategyActions.some(
                ({ action, completed }) => completed && action.type !== "select_attack_type",
            ),
            recoveryAttemptCount: observation.recoveryAttempts.length,
            recoverySource: observation.recovery.source,
            recoveryCompleted: observation.recovery.completed,
            recoveryRejectionReason: observation.recovery.rejectionReason ?? null,
        },
    };
};

/** Pair seed rule shared with archetype_payoff: games 2k / 2k+1 replay the same seed with seats swapped. */
export const mirrorGameSeed = (baseSeed: number, game: number): number =>
    (baseSeed + Math.floor(game / 2) * 0x9e3779b1) >>> 0;

/**
 * Static worker-lane assignment. A treatment may take slightly longer than its control, so completion-order
 * dispatch can send later games through different long-lived worker isolates and their process-local caches.
 * Pinning game `workerIndex + n * concurrency` to that worker keeps matched runs comparable without giving up
 * parallel execution.
 */
export function mirrorWorkerGameIndex(workerIndex: number, dispatchedByWorker: number, concurrency: number): number {
    if (
        !Number.isSafeInteger(workerIndex) ||
        workerIndex < 0 ||
        !Number.isSafeInteger(dispatchedByWorker) ||
        dispatchedByWorker < 0 ||
        !Number.isSafeInteger(concurrency) ||
        concurrency <= 0 ||
        workerIndex >= concurrency
    ) {
        throw new RangeError("workerIndex, dispatchedByWorker, and concurrency must describe a valid worker lane");
    }
    return workerIndex + dispatchedByWorker * concurrency;
}

export function buildMirrorRoster(
    cohort: MirrorCohortName,
    seed: number,
    amountMode: StackAmountMode,
): IArmyUnitSpec[] {
    let base: IArmyUnitSpec[];
    if (cohort === "pure_ranged" || cohort === "mixed_cyclops_tsar") {
        const fixedRosterNames = cohort === "pure_ranged" ? PURE_RANGED_ROSTER_NAMES : MIXED_CYCLOPS_TSAR_ROSTER_NAMES;
        base = fixedRosterNames.map(({ level, creatureName }) => {
            const spec = creaturesByLevel(level).find((c) => c.creatureName === creatureName);
            if (!spec) {
                throw new Error(`Catalog is missing ${creatureName} at level ${level}`);
            }
            return {
                faction: spec.faction,
                creatureName: spec.creatureName,
                level: spec.level,
                size: spec.size,
                amount: 0,
            };
        });
    } else {
        base = buildArchetypeRoster(cohort, buildSharedArchetypeOffers(makeRng(seed))).roster;
    }
    return base.map((unit) => ({
        ...unit,
        amount: resolveStackAmount(unit.creatureName, unit.level, DEFAULT_AMOUNT_BY_LEVEL, amountMode),
    }));
}

/** Fixed mirror cohorts use the ordinary blind LiveTwin setup rather than adding another setup factor. */
const mirrorSetup = (cohort: MirrorCohortName): ReturnType<typeof setupForArchetype> =>
    setupForArchetype(cohort === "pure_ranged" || cohort === "mixed_cyclops_tsar" ? "melee_coevo" : cohort);

function newSideDiag(version: string): IMirrorSideDiag {
    return {
        version,
        decisions: 0,
        waits: 0,
        waitsRangedUnit: 0,
        eligible: 0,
        cfFires: 0,
        cfFiresRangedUnit: 0,
        cfFiresInSupport: 0,
        byLap: [],
        shots: 0,
        shotDamage: 0,
        moveShotSequences: 0,
        moveShotRangeDamage: 0,
        supportedRangedEscapes: 0,
        supportedRangedEscapeProposals: 0,
        supportedRangedEscapeFunnel: newSupportedRangedEscapeFunnel(),
        responseNeutralAdvances: 0,
        responseNeutralAdvanceProposals: 0,
        supportedBandAdvanceSelections: 0,
        supportedBandAdvanceProposals: 0,
        supportedBandAdvanceFunnel: newSupportedBandAdvanceFunnel(),
        supportedBandDominanceEligibleComparisons: 0,
        supportedBandDominanceDominantComparisons: 0,
        supportedBandDominanceFilteredComparisons: 0,
        supportedBandDominanceSelectedComparisons: 0,
        supportedBandDominanceInvalidComparisons: 0,
        supportedBandDominanceComparisonsByReason: newSupportedBandDominanceReasonCounts(),
        supportedBandScreenedCloserEligibleComparisons: 0,
        supportedBandScreenedCloserDominantComparisons: 0,
        supportedBandScreenedCloserFilteredComparisons: 0,
        supportedBandScreenedCloserSelectedComparisons: 0,
        supportedBandScreenedCloserInvalidComparisons: 0,
        supportedBandScreenedCloserComparisonsByReason: newSupportedBandScreenedCloserReasonCounts(),
        supportedBandDuelDifferenceSelections: 0,
        supportedBandDuelDifferenceProposals: 0,
        supportedBandDuelDifferenceSelectionsByDifference: newSupportedBandDuelDifferenceCounts(),
        supportedBandDuelDifferenceProposalsByDifference: newSupportedBandDuelDifferenceCounts(),
        protectedAdvanceGuardrailVetoes: 0,
        protectedAdvanceGuardrailVetoesByReason: newProtectedAdvanceGuardrailReasonCounts(),
        protectedAdvanceGuardrailProposals: 0,
        protectedAdvanceGuardrailProposalsByReason: newProtectedAdvanceGuardrailReasonCounts(),
        supportedPrepinEgressSelections: 0,
        supportedPrepinEgressProposals: 0,
        supportedPrepinEgressFunnel: newSupportedPrepinEgressFunnel(),
        meleeDamage: 0,
        firstVolleyLap: null,
        firstVolleyDamage: null,
        dmgByLap: {},
        deathsByLap: {},
    };
}

function lapSlot(side: IMirrorSideDiag, lap: number): IMirrorLapDiag {
    let slot = side.byLap.find((entry) => entry.lap === lap);
    if (!slot) {
        slot = { lap, decisions: 0, waits: 0, eligible: 0, cfFires: 0 };
        side.byLap.push(slot);
    }
    return slot;
}

/** Play one independently addressable mirror game. Exported for tests (inject a fake matchRunner). */
export function playMirrorGame(
    cfg: IMirrorRunConfig,
    game: number,
    dependencies: IMirrorDependencies = {},
): IMirrorGameRecord {
    const seed = mirrorGameSeed(cfg.seed, game);
    const roster = buildMirrorRoster(cfg.cohort, seed, cfg.amountMode);
    const setup = mirrorSetup(cfg.cohort);
    const aIsGreen = game % 2 === 0;
    const greenVersion = aIsGreen ? cfg.vA : cfg.vB;
    const redVersion = aIsGreen ? cfg.vB : cfg.vA;

    const diag = cfg.diag ? { green: newSideDiag(greenVersion), red: newSideDiag(redVersion) } : undefined;
    const supportedRangedEscapeEvents: IMirrorSupportedRangedEscapeEvent[] = [];
    const rangedEscapeRecordByEvent = new WeakMap<IAIPolicyEvent, IMirrorSupportedRangedEscapeEvent>();
    const supportedBandAdvanceEvents: IMirrorSupportedBandAdvanceEvent[] = [];
    const bandAdvanceRecordByEvent = new WeakMap<IAIPolicyEvent, IMirrorSupportedBandAdvanceEvent>();
    const supportedBandDominanceComparisonEvents: IMirrorSupportedBandDominanceComparisonEvent[] = [];
    const bandDominanceRecordByEvent = new WeakMap<IAIPolicyEvent, IMirrorSupportedBandDominanceComparisonEvent>();
    const supportedBandScreenedCloserComparisonEvents: IMirrorSupportedBandScreenedCloserComparisonEvent[] = [];
    const pendingSupportedBandScreenedCloserComparisons: IMirrorSupportedBandScreenedCloserComparisonEvent[] = [];
    const bandScreenedCloserRecordByEvent = new WeakMap<
        IAIPolicyEvent,
        IMirrorSupportedBandScreenedCloserComparisonEvent
    >();
    const supportedBandDuelDifferenceEvents: IMirrorSupportedBandDuelDifferenceEvent[] = [];
    const bandDuelDifferenceRecordByEvent = new WeakMap<IAIPolicyEvent, IMirrorSupportedBandDuelDifferenceEvent>();
    const protectedAdvanceGuardrailEvents: IMirrorProtectedAdvanceGuardrailEvent[] = [];
    const guardrailRecordByEvent = new WeakMap<IAIPolicyEvent, IMirrorProtectedAdvanceGuardrailEvent>();
    const supportedPrepinEgressEvents: IMirrorSupportedPrepinEgressEvent[] = [];
    const prepinRecordByEvent = new WeakMap<IAIPolicyEvent, IMirrorSupportedPrepinEgressEvent>();
    const observer = diag
        ? (obs: IDecisionObservation): void => {
              const side = obs.unit.getTeam() === GREEN_TEAM ? diag.green : diag.red;
              const fp = obs.context.fightProperties;
              const slot = lapSlot(side, fp ? fp.getCurrentLap() : 0);
              side.decisions += 1;
              slot.decisions += 1;
              const isRangedUnit = obs.unit.getAttackType() === PBTypes.AttackVals.RANGE;
              if (obs.incumbent.some((a) => a.type === "wait_turn")) {
                  side.waits += 1;
                  slot.waits += 1;
                  if (isRangedUnit) {
                      side.waitsRangedUnit += 1;
                  }
                  return;
              }
              if (!fp || !canWaitOnHourglassMirror(obs.unit, fp, obs.context.unitsHolder.getAllUnits())) {
                  return;
              }
              side.eligible += 1;
              slot.eligible += 1;
              const features = extractWaitFeatures(obs.unit, obs.context.unitsHolder, fp, obs.incumbent);
              if (waitScore(DISTILLED_WAIT_WEIGHTS_2026_07_10, features) > 0) {
                  side.cfFires += 1;
                  slot.cfFires += 1;
                  if (isRangedUnit) {
                      side.cfFiresRangedUnit += 1;
                  }
                  if (waitScorerInSupport(obs.unit, obs.context.unitsHolder)) {
                      side.cfFiresInSupport += 1;
                  }
              }
          }
        : undefined;
    const policyEventObserver: IMatchConfig["policyEventObserver"] = diag
        ? (event): void => {
              const side = event.team === GREEN_TEAM ? diag.green : diag.red;
              if (event.kind === "v0.8_supported_ranged_escape") {
                  side.supportedRangedEscapes += 1;
                  const proposal = rangedEscapeRecordByEvent.get(event);
                  if (proposal) proposal.retained = true;
              } else if (event.kind === "v0.8_response_neutral_advance") {
                  side.responseNeutralAdvances += 1;
              } else if (event.kind === "v0.8_supported_band_advance") {
                  side.supportedBandAdvanceSelections += 1;
                  const proposal = bandAdvanceRecordByEvent.get(event);
                  if (proposal) proposal.retained = true;
              } else if (event.kind === "v0.8_supported_band_dominance_comparison") {
                  const proposal = bandDominanceRecordByEvent.get(event);
                  if (proposal) proposal.retained = true;
              } else if (event.kind === "v0.8_supported_band_screened_closer_comparison") {
                  const proposal = bandScreenedCloserRecordByEvent.get(event);
                  if (proposal) proposal.retained = true;
              } else if (event.kind === "v0.8_supported_band_duel_difference") {
                  side.supportedBandDuelDifferenceSelections += 1;
                  side.supportedBandDuelDifferenceSelectionsByDifference[event.details.difference] += 1;
                  const proposal = bandDuelDifferenceRecordByEvent.get(event);
                  if (proposal) proposal.retained = true;
              } else if (event.kind === "v0.8_protected_advance_guardrail") {
                  side.protectedAdvanceGuardrailVetoes += 1;
                  side.protectedAdvanceGuardrailVetoesByReason[event.details.reason] += 1;
                  const proposal = guardrailRecordByEvent.get(event);
                  if (proposal) proposal.retained = true;
              } else if (event.kind === "v0.8_supported_prepin_egress") {
                  side.supportedPrepinEgressSelections += 1;
                  const proposal = prepinRecordByEvent.get(event);
                  if (proposal) proposal.retained = true;
              }
          }
        : undefined;
    const policyProposalObserver: IMatchConfig["policyProposalObserver"] = diag
        ? (event): void => {
              const side = event.team === GREEN_TEAM ? diag.green : diag.red;
              if (event.kind === "v0.8_supported_ranged_escape") {
                  side.supportedRangedEscapeProposals += 1;
                  const proposal: IMirrorSupportedRangedEscapeEvent = {
                      ...event.details,
                      fromCell: { ...event.details.fromCell },
                      toCell: { ...event.details.toCell },
                      incumbentAttackFromCell: { ...event.details.incumbentAttackFromCell },
                      side: event.team === GREEN_TEAM ? "green" : "red",
                      unitId: event.unitId,
                      creatureName: event.creatureName,
                      lap: event.lap,
                      retained: false,
                  };
                  supportedRangedEscapeEvents.push(proposal);
                  rangedEscapeRecordByEvent.set(event, proposal);
              } else if (event.kind === "v0.8_supported_ranged_escape_funnel" && event.stage) {
                  side.supportedRangedEscapeFunnel[event.stage] += 1;
              } else if (event.kind === "v0.8_response_neutral_advance") {
                  side.responseNeutralAdvanceProposals += 1;
              } else if (event.kind === "v0.8_supported_band_advance") {
                  side.supportedBandAdvanceProposals += 1;
                  const proposal: IMirrorSupportedBandAdvanceEvent = {
                      ...event.details,
                      fromCell: { ...event.details.fromCell },
                      toCell: { ...event.details.toCell },
                      side: event.team === GREEN_TEAM ? "green" : "red",
                      unitId: event.unitId,
                      creatureName: event.creatureName,
                      lap: event.lap,
                      retained: false,
                  };
                  supportedBandAdvanceEvents.push(proposal);
                  bandAdvanceRecordByEvent.set(event, proposal);
              } else if (event.kind === "v0.8_supported_band_dominance_comparison") {
                  side.supportedBandDominanceEligibleComparisons += 1;
                  if (event.details.dominant) side.supportedBandDominanceDominantComparisons += 1;
                  else side.supportedBandDominanceFilteredComparisons += 1;
                  if (event.details.selected) side.supportedBandDominanceSelectedComparisons += 1;
                  if (!event.details.metadataValid) side.supportedBandDominanceInvalidComparisons += 1;
                  side.supportedBandDominanceComparisonsByReason[event.details.reason] += 1;
                  const proposal: IMirrorSupportedBandDominanceComparisonEvent = {
                      ...event.details,
                      strict: detachSupportedBandDuelDecision(event.details.strict),
                      shipped: detachSupportedBandDuelDecision(event.details.shipped),
                      side: event.team === GREEN_TEAM ? "green" : "red",
                      unitId: event.unitId,
                      creatureName: event.creatureName,
                      lap: event.lap,
                      retained: false,
                  };
                  supportedBandDominanceComparisonEvents.push(proposal);
                  bandDominanceRecordByEvent.set(event, proposal);
              } else if (event.kind === "v0.8_supported_band_screened_closer_comparison") {
                  side.supportedBandScreenedCloserEligibleComparisons += 1;
                  if (event.details.dominant) side.supportedBandScreenedCloserDominantComparisons += 1;
                  else side.supportedBandScreenedCloserFilteredComparisons += 1;
                  if (event.details.selected) side.supportedBandScreenedCloserSelectedComparisons += 1;
                  if (!event.details.metadataValid) side.supportedBandScreenedCloserInvalidComparisons += 1;
                  side.supportedBandScreenedCloserComparisonsByReason[event.details.reason] += 1;
                  const proposal: IMirrorSupportedBandScreenedCloserComparisonEvent = {
                      ...event.details,
                      strict: detachSupportedBandDuelDecision(event.details.strict),
                      shipped: detachSupportedBandDuelDecision(event.details.shipped),
                      strictFromCell: { ...event.details.strictFromCell },
                      strictToCell: { ...event.details.strictToCell },
                      shippedFromCell:
                          event.details.shippedFromCell === null ? null : { ...event.details.shippedFromCell },
                      shippedToCell: event.details.shippedToCell === null ? null : { ...event.details.shippedToCell },
                      side: event.team === GREEN_TEAM ? "green" : "red",
                      unitId: event.unitId,
                      creatureName: event.creatureName,
                      lap: event.lap,
                      retained: false,
                      postA13: unresolvedSupportedBandScreenedCloserPostA13Evidence(),
                  };
                  supportedBandScreenedCloserComparisonEvents.push(proposal);
                  pendingSupportedBandScreenedCloserComparisons.push(proposal);
                  bandScreenedCloserRecordByEvent.set(event, proposal);
              } else if (event.kind === "v0.8_supported_band_duel_difference") {
                  side.supportedBandDuelDifferenceProposals += 1;
                  side.supportedBandDuelDifferenceProposalsByDifference[event.details.difference] += 1;
                  const proposal: IMirrorSupportedBandDuelDifferenceEvent = {
                      ...event.details,
                      strict: detachSupportedBandDuelDecision(event.details.strict),
                      shipped: detachSupportedBandDuelDecision(event.details.shipped),
                      side: event.team === GREEN_TEAM ? "green" : "red",
                      unitId: event.unitId,
                      creatureName: event.creatureName,
                      lap: event.lap,
                      retained: false,
                  };
                  supportedBandDuelDifferenceEvents.push(proposal);
                  bandDuelDifferenceRecordByEvent.set(event, proposal);
              } else if (event.kind === "v0.8_supported_band_advance_funnel" && event.stage) {
                  side.supportedBandAdvanceFunnel[event.stage] += 1;
              } else if (event.kind === "v0.8_protected_advance_guardrail") {
                  side.protectedAdvanceGuardrailProposals += 1;
                  side.protectedAdvanceGuardrailProposalsByReason[event.details.reason] += 1;
                  const proposal: IMirrorProtectedAdvanceGuardrailEvent = {
                      ...event.details,
                      fromCell: { ...event.details.fromCell },
                      toCell: { ...event.details.toCell },
                      side: event.team === GREEN_TEAM ? "green" : "red",
                      unitId: event.unitId,
                      creatureName: event.creatureName,
                      lap: event.lap,
                      retained: false,
                  };
                  protectedAdvanceGuardrailEvents.push(proposal);
                  guardrailRecordByEvent.set(event, proposal);
              } else if (event.kind === "v0.8_supported_prepin_egress") {
                  side.supportedPrepinEgressProposals += 1;
                  const proposal: IMirrorSupportedPrepinEgressEvent = {
                      ...event.details,
                      fromCell: { ...event.details.fromCell },
                      toCell: { ...event.details.toCell },
                      side: event.team === GREEN_TEAM ? "green" : "red",
                      unitId: event.unitId,
                      creatureName: event.creatureName,
                      lap: event.lap,
                      retained: false,
                  };
                  supportedPrepinEgressEvents.push(proposal);
                  prepinRecordByEvent.set(event, proposal);
              } else if (event.kind === "v0.8_supported_prepin_egress_funnel" && event.stage) {
                  side.supportedPrepinEgressFunnel[event.stage] += 1;
              }
          }
        : undefined;
    const turnExecutionObserver: IMatchConfig["turnExecutionObserver"] = diag
        ? (observation): void => {
              const currentTurnComparisons = pendingSupportedBandScreenedCloserComparisons.splice(
                  0,
                  pendingSupportedBandScreenedCloserComparisons.length,
              );
              if (!currentTurnComparisons.length) return;
              const exactActorComparisons = currentTurnComparisons.filter(
                  (comparison) =>
                      comparison.unitId === observation.unitId &&
                      comparison.creatureName === observation.creatureName &&
                      comparison.side === observation.side &&
                      observation.strategyVersion === (comparison.side === "green" ? greenVersion : redVersion),
              );
              const bindingStatus: Exclude<
                  MirrorSupportedBandScreenedCloserPostA13BindingStatus,
                  "missing_turn_execution"
              > =
                  currentTurnComparisons.length !== 1
                      ? "multiple_current_turn_comparisons"
                      : exactActorComparisons.length === 1
                        ? "resolved"
                        : "no_matching_current_turn_comparison";
              for (const comparison of currentTurnComparisons) {
                  comparison.postA13 = supportedBandScreenedCloserPostA13Evidence(
                      observation,
                      comparison,
                      bindingStatus,
                  );
              }
          }
        : undefined;

    // Prime the lazy singleton outside runMatch's seeded scope (archetype_payoff.ts rationale).
    const matchRunner =
        dependencies.matchRunner ??
        ((config: IMatchConfig): IMatchResult => {
            FightStateManager.getInstance();
            return runMatch(config);
        });
    const result = matchRunner({
        greenVersion,
        redVersion,
        roster: roster.map((unit) => ({ ...unit })),
        redRoster: roster.map((unit) => ({ ...unit })),
        seed,
        gridType: PBTypes.GridVals.NORMAL,
        greenPerk: setup.perk,
        redPerk: setup.perk,
        greenAugments: setup.augments.map((augment) => ({ ...augment })),
        redAugments: setup.augments.map((augment) => ({ ...augment })),
        ...(observer ? { decisionObserver: observer } : {}),
        ...(policyProposalObserver ? { policyProposalObserver } : {}),
        ...(policyEventObserver ? { policyEventObserver } : {}),
        ...(turnExecutionObserver ? { turnExecutionObserver } : {}),
    });

    if (diag) {
        const sideOf = new Map<string, "green" | "red">();
        for (const p of result.placements.green) {
            sideOf.set(p.unitId, "green");
        }
        for (const p of result.placements.red) {
            sideOf.set(p.unitId, "red");
        }
        for (let actionIndex = 0; actionIndex < result.actions.length; actionIndex += 1) {
            const action = result.actions[actionIndex];
            if (!action.completed) {
                continue;
            }
            const actor = action.side === "green" ? diag.green : diag.red;
            const damage = action.impactDamage ?? action.damage ?? 0;
            if (action.actionType === "range_attack") {
                actor.shots += 1;
                actor.shotDamage += damage;
                const preceding = result.actions[actionIndex - 1];
                if (
                    preceding?.completed &&
                    preceding.actionType === "move_unit" &&
                    preceding.side === action.side &&
                    preceding.unitId === action.unitId &&
                    preceding.lap === action.lap
                ) {
                    actor.moveShotSequences += 1;
                    actor.moveShotRangeDamage += damage;
                }
                if (actor.firstVolleyLap === null) {
                    actor.firstVolleyLap = action.lap;
                    actor.firstVolleyDamage = damage;
                }
            } else if (action.actionType === "melee_attack") {
                actor.meleeDamage += damage;
            }
            if (damage > 0) {
                actor.dmgByLap[action.lap] = (actor.dmgByLap[action.lap] ?? 0) + damage;
            }
            for (const died of action.unitIdsDied ?? []) {
                const victimSide = sideOf.get(died);
                if (victimSide) {
                    const victim = victimSide === "green" ? diag.green : diag.red;
                    victim.deathsByLap[action.lap] = (victim.deathsByLap[action.lap] ?? 0) + 1;
                }
            }
        }
        diag.green.byLap.sort((x, y) => x.lap - y.lap);
        diag.red.byLap.sort((x, y) => x.lap - y.lap);
    }

    const winnerVersion = result.winner === "draw" ? "draw" : result.winner === "green" ? greenVersion : redVersion;
    return {
        game,
        seed,
        greenVersion,
        winnerVersion,
        laps: result.laps,
        endReason: result.endReason,
        armageddon: result.attrition.decidedByArmageddon,
        rejectedGreen: result.rejectedGreen ?? 0,
        rejectedRed: result.rejectedRed ?? 0,
        ...(game === 0 ? { rosterSig: roster.map((u) => `L${u.level}:${u.creatureName}x${u.amount}`).join("|") } : {}),
        ...(diag ? { diag } : {}),
        ...(supportedRangedEscapeEvents.length ? { supportedRangedEscapeEvents } : {}),
        ...(supportedBandAdvanceEvents.length ? { supportedBandAdvanceEvents } : {}),
        ...(supportedBandDominanceComparisonEvents.length ? { supportedBandDominanceComparisonEvents } : {}),
        ...(supportedBandScreenedCloserComparisonEvents.length ? { supportedBandScreenedCloserComparisonEvents } : {}),
        ...(supportedBandDuelDifferenceEvents.length ? { supportedBandDuelDifferenceEvents } : {}),
        ...(protectedAdvanceGuardrailEvents.length ? { protectedAdvanceGuardrailEvents } : {}),
        ...(supportedPrepinEgressEvents.length ? { supportedPrepinEgressEvents } : {}),
    };
}

export interface IMirrorSummary {
    kind: "mirror_cohort_ab";
    cohort: MirrorCohortName;
    versions: { A: string; B: string };
    games: number;
    baseSeed: number;
    amountMode: StackAmountMode;
    livetwin: boolean;
    zeroScorer: boolean;
    guard: string;
    pairedSideSwap: true;
    symmetricRosters: true;
    winsA: number;
    winsB: number;
    draws: number;
    decisive: number;
    winRateA: number;
    winRateAPp: number;
    sePp: number;
    deltaFromParityPp: number;
    avgLaps: number;
    endReasons: Record<string, number>;
    armageddonDecided: number;
    rejectedActions: number;
    exampleRoster?: string;
    wallSeconds?: number;
    diagAggregate?: Record<string, unknown>;
}

export function summarizeMirrorRecords(records: readonly IMirrorGameRecord[], cfg: IMirrorRunConfig): IMirrorSummary {
    const winsA = records.filter((r) => r.winnerVersion === cfg.vA).length;
    const winsB = records.filter((r) => r.winnerVersion === cfg.vB).length;
    const draws = records.filter((r) => r.winnerVersion === "draw").length;
    const decisive = winsA + winsB;
    const rate = decisive ? winsA / decisive : 0.5;
    const endReasons: Record<string, number> = {};
    for (const r of records) {
        endReasons[r.endReason] = (endReasons[r.endReason] ?? 0) + 1;
    }
    return {
        kind: "mirror_cohort_ab",
        cohort: cfg.cohort,
        versions: { A: cfg.vA, B: cfg.vB },
        games: records.length,
        baseSeed: cfg.seed,
        amountMode: cfg.amountMode,
        livetwin: cfg.livetwin,
        zeroScorer: cfg.zeroScorer,
        guard: cfg.guard || "default(support)",
        pairedSideSwap: true,
        symmetricRosters: true,
        winsA,
        winsB,
        draws,
        decisive,
        winRateA: rate,
        winRateAPp: rate * 100,
        sePp: decisive ? 100 * Math.sqrt((rate * (1 - rate)) / decisive) : Number.POSITIVE_INFINITY,
        deltaFromParityPp: (rate - 0.5) * 100,
        avgLaps: records.length ? records.reduce((s, r) => s + r.laps, 0) / records.length : 0,
        endReasons,
        armageddonDecided: records.filter((r) => r.armageddon).length,
        rejectedActions: records.reduce((s, r) => s + r.rejectedGreen + r.rejectedRed, 0),
        ...(records.find((r) => r.rosterSig) ? { exampleRoster: records.find((r) => r.rosterSig)!.rosterSig } : {}),
    };
}

interface IVersionAggregate {
    decisions: number;
    waits: number;
    waitsRangedUnit: number;
    eligible: number;
    cfFires: number;
    cfFiresRangedUnit: number;
    cfFiresInSupport: number;
    byLap: Map<number, { decisions: number; waits: number; eligible: number; cfFires: number }>;
    firstVolleyLaps: number[];
    shots: number;
    shotDamage: number;
    moveShotSequences: number;
    moveShotRangeDamage: number;
    supportedRangedEscapes: number;
    supportedRangedEscapeProposals: number;
    supportedRangedEscapeFunnel: Record<V08SupportedRangedEscapeFunnelStage, number>;
    responseNeutralAdvances: number;
    responseNeutralAdvanceProposals: number;
    supportedBandAdvanceSelections: number;
    supportedBandAdvanceProposals: number;
    supportedBandAdvanceFunnel: Record<V08SupportedBandAdvanceFunnelStage, number>;
    supportedBandDominanceEligibleComparisons: number;
    supportedBandDominanceDominantComparisons: number;
    supportedBandDominanceFilteredComparisons: number;
    supportedBandDominanceSelectedComparisons: number;
    supportedBandDominanceInvalidComparisons: number;
    supportedBandDominanceComparisonsByReason: Record<V08SupportedBandDominanceReason, number>;
    supportedBandScreenedCloserEligibleComparisons: number;
    supportedBandScreenedCloserDominantComparisons: number;
    supportedBandScreenedCloserFilteredComparisons: number;
    supportedBandScreenedCloserSelectedComparisons: number;
    supportedBandScreenedCloserInvalidComparisons: number;
    supportedBandScreenedCloserComparisonsByReason: Record<V08SupportedBandScreenedCloserReason, number>;
    supportedBandDuelDifferenceSelections: number;
    supportedBandDuelDifferenceProposals: number;
    supportedBandDuelDifferenceSelectionsByDifference: Record<V08SupportedBandDuelDifference, number>;
    supportedBandDuelDifferenceProposalsByDifference: Record<V08SupportedBandDuelDifference, number>;
    protectedAdvanceGuardrailVetoes: number;
    protectedAdvanceGuardrailVetoesByReason: Record<V08ProtectedAdvanceGuardrailReason, number>;
    protectedAdvanceGuardrailProposals: number;
    protectedAdvanceGuardrailProposalsByReason: Record<V08ProtectedAdvanceGuardrailReason, number>;
    supportedPrepinEgressSelections: number;
    supportedPrepinEgressProposals: number;
    supportedPrepinEgressFunnel: Record<V08SupportedPrepinEgressFunnelStage, number>;
    meleeDamage: number;
    deathsByLap: Map<number, number>;
    dmgByLap: Map<number, number>;
    games: number;
}

export function aggregateMirrorDiag(
    records: readonly IMirrorGameRecord[],
    cfg: IMirrorRunConfig,
): Record<string, unknown> {
    const agg = new Map<string, IVersionAggregate>();
    const versionAgg = (v: string): IVersionAggregate => {
        let a = agg.get(v);
        if (!a) {
            a = {
                decisions: 0,
                waits: 0,
                waitsRangedUnit: 0,
                eligible: 0,
                cfFires: 0,
                cfFiresRangedUnit: 0,
                cfFiresInSupport: 0,
                byLap: new Map(),
                firstVolleyLaps: [],
                shots: 0,
                shotDamage: 0,
                moveShotSequences: 0,
                moveShotRangeDamage: 0,
                supportedRangedEscapes: 0,
                supportedRangedEscapeProposals: 0,
                supportedRangedEscapeFunnel: newSupportedRangedEscapeFunnel(),
                responseNeutralAdvances: 0,
                responseNeutralAdvanceProposals: 0,
                supportedBandAdvanceSelections: 0,
                supportedBandAdvanceProposals: 0,
                supportedBandAdvanceFunnel: newSupportedBandAdvanceFunnel(),
                supportedBandDominanceEligibleComparisons: 0,
                supportedBandDominanceDominantComparisons: 0,
                supportedBandDominanceFilteredComparisons: 0,
                supportedBandDominanceSelectedComparisons: 0,
                supportedBandDominanceInvalidComparisons: 0,
                supportedBandDominanceComparisonsByReason: newSupportedBandDominanceReasonCounts(),
                supportedBandScreenedCloserEligibleComparisons: 0,
                supportedBandScreenedCloserDominantComparisons: 0,
                supportedBandScreenedCloserFilteredComparisons: 0,
                supportedBandScreenedCloserSelectedComparisons: 0,
                supportedBandScreenedCloserInvalidComparisons: 0,
                supportedBandScreenedCloserComparisonsByReason: newSupportedBandScreenedCloserReasonCounts(),
                supportedBandDuelDifferenceSelections: 0,
                supportedBandDuelDifferenceProposals: 0,
                supportedBandDuelDifferenceSelectionsByDifference: newSupportedBandDuelDifferenceCounts(),
                supportedBandDuelDifferenceProposalsByDifference: newSupportedBandDuelDifferenceCounts(),
                protectedAdvanceGuardrailVetoes: 0,
                protectedAdvanceGuardrailVetoesByReason: newProtectedAdvanceGuardrailReasonCounts(),
                protectedAdvanceGuardrailProposals: 0,
                protectedAdvanceGuardrailProposalsByReason: newProtectedAdvanceGuardrailReasonCounts(),
                supportedPrepinEgressSelections: 0,
                supportedPrepinEgressProposals: 0,
                supportedPrepinEgressFunnel: newSupportedPrepinEgressFunnel(),
                meleeDamage: 0,
                deathsByLap: new Map(),
                dmgByLap: new Map(),
                games: 0,
            };
            agg.set(v, a);
        }
        return a;
    };
    for (const r of records) {
        if (!r.diag) {
            continue;
        }
        for (const side of [r.diag.green, r.diag.red]) {
            const a = versionAgg(side.version);
            a.games += 1;
            a.decisions += side.decisions;
            a.waits += side.waits;
            a.waitsRangedUnit += side.waitsRangedUnit;
            a.eligible += side.eligible;
            a.cfFires += side.cfFires;
            a.cfFiresRangedUnit += side.cfFiresRangedUnit;
            a.cfFiresInSupport += side.cfFiresInSupport ?? 0;
            a.shots += side.shots;
            a.shotDamage += side.shotDamage;
            a.moveShotSequences += side.moveShotSequences ?? 0;
            a.moveShotRangeDamage += side.moveShotRangeDamage ?? 0;
            a.supportedRangedEscapes += side.supportedRangedEscapes ?? 0;
            a.supportedRangedEscapeProposals += side.supportedRangedEscapeProposals ?? 0;
            for (const stage of V08_SUPPORTED_RANGED_ESCAPE_FUNNEL_STAGES) {
                a.supportedRangedEscapeFunnel[stage] += side.supportedRangedEscapeFunnel?.[stage] ?? 0;
            }
            a.responseNeutralAdvances += side.responseNeutralAdvances ?? 0;
            a.responseNeutralAdvanceProposals += side.responseNeutralAdvanceProposals ?? 0;
            a.supportedBandAdvanceSelections += side.supportedBandAdvanceSelections ?? 0;
            a.supportedBandAdvanceProposals += side.supportedBandAdvanceProposals ?? 0;
            for (const stage of V08_SUPPORTED_BAND_ADVANCE_FUNNEL_STAGES) {
                a.supportedBandAdvanceFunnel[stage] += side.supportedBandAdvanceFunnel?.[stage] ?? 0;
            }
            a.supportedBandDominanceEligibleComparisons += side.supportedBandDominanceEligibleComparisons ?? 0;
            a.supportedBandDominanceDominantComparisons += side.supportedBandDominanceDominantComparisons ?? 0;
            a.supportedBandDominanceFilteredComparisons += side.supportedBandDominanceFilteredComparisons ?? 0;
            a.supportedBandDominanceSelectedComparisons += side.supportedBandDominanceSelectedComparisons ?? 0;
            a.supportedBandDominanceInvalidComparisons += side.supportedBandDominanceInvalidComparisons ?? 0;
            for (const reason of SUPPORTED_BAND_DOMINANCE_REASONS) {
                a.supportedBandDominanceComparisonsByReason[reason] +=
                    side.supportedBandDominanceComparisonsByReason?.[reason] ?? 0;
            }
            a.supportedBandScreenedCloserEligibleComparisons +=
                side.supportedBandScreenedCloserEligibleComparisons ?? 0;
            a.supportedBandScreenedCloserDominantComparisons +=
                side.supportedBandScreenedCloserDominantComparisons ?? 0;
            a.supportedBandScreenedCloserFilteredComparisons +=
                side.supportedBandScreenedCloserFilteredComparisons ?? 0;
            a.supportedBandScreenedCloserSelectedComparisons +=
                side.supportedBandScreenedCloserSelectedComparisons ?? 0;
            a.supportedBandScreenedCloserInvalidComparisons += side.supportedBandScreenedCloserInvalidComparisons ?? 0;
            for (const reason of SUPPORTED_BAND_SCREENED_CLOSER_REASONS) {
                a.supportedBandScreenedCloserComparisonsByReason[reason] +=
                    side.supportedBandScreenedCloserComparisonsByReason?.[reason] ?? 0;
            }
            a.supportedBandDuelDifferenceSelections += side.supportedBandDuelDifferenceSelections ?? 0;
            a.supportedBandDuelDifferenceProposals += side.supportedBandDuelDifferenceProposals ?? 0;
            for (const difference of SUPPORTED_BAND_DUEL_DIFFERENCES) {
                a.supportedBandDuelDifferenceSelectionsByDifference[difference] +=
                    side.supportedBandDuelDifferenceSelectionsByDifference?.[difference] ?? 0;
                a.supportedBandDuelDifferenceProposalsByDifference[difference] +=
                    side.supportedBandDuelDifferenceProposalsByDifference?.[difference] ?? 0;
            }
            a.protectedAdvanceGuardrailVetoes += side.protectedAdvanceGuardrailVetoes ?? 0;
            for (const reason of PROTECTED_ADVANCE_GUARDRAIL_REASONS) {
                a.protectedAdvanceGuardrailVetoesByReason[reason] +=
                    side.protectedAdvanceGuardrailVetoesByReason?.[reason] ?? 0;
            }
            a.protectedAdvanceGuardrailProposals += side.protectedAdvanceGuardrailProposals ?? 0;
            for (const reason of PROTECTED_ADVANCE_GUARDRAIL_REASONS) {
                a.protectedAdvanceGuardrailProposalsByReason[reason] +=
                    side.protectedAdvanceGuardrailProposalsByReason?.[reason] ?? 0;
            }
            a.supportedPrepinEgressSelections += side.supportedPrepinEgressSelections ?? 0;
            a.supportedPrepinEgressProposals += side.supportedPrepinEgressProposals ?? 0;
            for (const stage of V08_SUPPORTED_PREPIN_EGRESS_FUNNEL_STAGES) {
                a.supportedPrepinEgressFunnel[stage] += side.supportedPrepinEgressFunnel?.[stage] ?? 0;
            }
            a.meleeDamage += side.meleeDamage;
            if (side.firstVolleyLap !== null) {
                a.firstVolleyLaps.push(side.firstVolleyLap);
            }
            for (const lapEntry of side.byLap) {
                const slot = a.byLap.get(lapEntry.lap) ?? { decisions: 0, waits: 0, eligible: 0, cfFires: 0 };
                slot.decisions += lapEntry.decisions;
                slot.waits += lapEntry.waits;
                slot.eligible += lapEntry.eligible;
                slot.cfFires += lapEntry.cfFires;
                a.byLap.set(lapEntry.lap, slot);
            }
            for (const [lap, n] of Object.entries(side.deathsByLap)) {
                a.deathsByLap.set(Number(lap), (a.deathsByLap.get(Number(lap)) ?? 0) + n);
            }
            for (const [lap, n] of Object.entries(side.dmgByLap)) {
                a.dmgByLap.set(Number(lap), (a.dmgByLap.get(Number(lap)) ?? 0) + n);
            }
        }
    }
    const out: Record<string, unknown> = {};
    for (const [version, a] of agg) {
        const laps = [...a.byLap.keys()].sort((x, y) => x - y);
        out[version] = {
            games: a.games,
            decisions: a.decisions,
            waitRate: a.waits / Math.max(1, a.decisions),
            waits: a.waits,
            waitsRangedUnit: a.waitsRangedUnit,
            scorerEligibleNonWait: a.eligible,
            cfScorerFires: a.cfFires,
            cfScorerFireRate: a.cfFires / Math.max(1, a.eligible),
            cfScorerFiresRangedUnit: a.cfFiresRangedUnit,
            cfScorerFiresInSupport: a.cfFiresInSupport,
            meanFirstVolleyLap: a.firstVolleyLaps.length
                ? a.firstVolleyLaps.reduce((s, x) => s + x, 0) / a.firstVolleyLaps.length
                : null,
            gamesWithVolley: a.firstVolleyLaps.length,
            shotsPerGame: a.shots / Math.max(1, a.games),
            shotDamagePerGame: a.shotDamage / Math.max(1, a.games),
            moveShotSequences: a.moveShotSequences,
            moveShotSequencesPerGame: a.moveShotSequences / Math.max(1, a.games),
            moveShotRangeDamage: a.moveShotRangeDamage,
            moveShotRangeDamagePerGame: a.moveShotRangeDamage / Math.max(1, a.games),
            meanMoveShotRangeDamage: a.moveShotSequences > 0 ? a.moveShotRangeDamage / a.moveShotSequences : null,
            supportedRangedEscapes: a.supportedRangedEscapes,
            supportedRangedEscapesPerGame: a.supportedRangedEscapes / Math.max(1, a.games),
            supportedRangedEscapeProposals: a.supportedRangedEscapeProposals,
            supportedRangedEscapeProposalsPerGame: a.supportedRangedEscapeProposals / Math.max(1, a.games),
            supportedRangedEscapeFunnel: a.supportedRangedEscapeFunnel,
            supportedRangedEscapeFunnelPerGame: Object.fromEntries(
                V08_SUPPORTED_RANGED_ESCAPE_FUNNEL_STAGES.map((stage) => [
                    stage,
                    a.supportedRangedEscapeFunnel[stage] / Math.max(1, a.games),
                ]),
            ),
            responseNeutralAdvances: a.responseNeutralAdvances,
            responseNeutralAdvancesPerGame: a.responseNeutralAdvances / Math.max(1, a.games),
            responseNeutralAdvanceProposals: a.responseNeutralAdvanceProposals,
            responseNeutralAdvanceProposalsPerGame: a.responseNeutralAdvanceProposals / Math.max(1, a.games),
            supportedBandAdvanceSelections: a.supportedBandAdvanceSelections,
            supportedBandAdvanceSelectionsPerGame: a.supportedBandAdvanceSelections / Math.max(1, a.games),
            supportedBandAdvanceProposals: a.supportedBandAdvanceProposals,
            supportedBandAdvanceProposalsPerGame: a.supportedBandAdvanceProposals / Math.max(1, a.games),
            supportedBandAdvanceFunnel: a.supportedBandAdvanceFunnel,
            supportedBandAdvanceFunnelPerGame: Object.fromEntries(
                V08_SUPPORTED_BAND_ADVANCE_FUNNEL_STAGES.map((stage) => [
                    stage,
                    a.supportedBandAdvanceFunnel[stage] / Math.max(1, a.games),
                ]),
            ),
            supportedBandDominanceEligibleComparisons: a.supportedBandDominanceEligibleComparisons,
            supportedBandDominanceEligibleComparisonsPerGame:
                a.supportedBandDominanceEligibleComparisons / Math.max(1, a.games),
            supportedBandDominanceDominantComparisons: a.supportedBandDominanceDominantComparisons,
            supportedBandDominanceDominantComparisonsPerGame:
                a.supportedBandDominanceDominantComparisons / Math.max(1, a.games),
            supportedBandDominanceFilteredComparisons: a.supportedBandDominanceFilteredComparisons,
            supportedBandDominanceFilteredComparisonsPerGame:
                a.supportedBandDominanceFilteredComparisons / Math.max(1, a.games),
            supportedBandDominanceSelectedComparisons: a.supportedBandDominanceSelectedComparisons,
            supportedBandDominanceSelectedComparisonsPerGame:
                a.supportedBandDominanceSelectedComparisons / Math.max(1, a.games),
            supportedBandDominanceInvalidComparisons: a.supportedBandDominanceInvalidComparisons,
            supportedBandDominanceInvalidComparisonsPerGame:
                a.supportedBandDominanceInvalidComparisons / Math.max(1, a.games),
            supportedBandDominanceComparisonsByReason: a.supportedBandDominanceComparisonsByReason,
            supportedBandDominanceComparisonsByReasonPerGame: Object.fromEntries(
                SUPPORTED_BAND_DOMINANCE_REASONS.map((reason) => [
                    reason,
                    a.supportedBandDominanceComparisonsByReason[reason] / Math.max(1, a.games),
                ]),
            ),
            supportedBandScreenedCloserEligibleComparisons: a.supportedBandScreenedCloserEligibleComparisons,
            supportedBandScreenedCloserEligibleComparisonsPerGame:
                a.supportedBandScreenedCloserEligibleComparisons / Math.max(1, a.games),
            supportedBandScreenedCloserDominantComparisons: a.supportedBandScreenedCloserDominantComparisons,
            supportedBandScreenedCloserDominantComparisonsPerGame:
                a.supportedBandScreenedCloserDominantComparisons / Math.max(1, a.games),
            supportedBandScreenedCloserFilteredComparisons: a.supportedBandScreenedCloserFilteredComparisons,
            supportedBandScreenedCloserFilteredComparisonsPerGame:
                a.supportedBandScreenedCloserFilteredComparisons / Math.max(1, a.games),
            supportedBandScreenedCloserSelectedComparisons: a.supportedBandScreenedCloserSelectedComparisons,
            supportedBandScreenedCloserSelectedComparisonsPerGame:
                a.supportedBandScreenedCloserSelectedComparisons / Math.max(1, a.games),
            supportedBandScreenedCloserInvalidComparisons: a.supportedBandScreenedCloserInvalidComparisons,
            supportedBandScreenedCloserInvalidComparisonsPerGame:
                a.supportedBandScreenedCloserInvalidComparisons / Math.max(1, a.games),
            supportedBandScreenedCloserComparisonsByReason: a.supportedBandScreenedCloserComparisonsByReason,
            supportedBandScreenedCloserComparisonsByReasonPerGame: Object.fromEntries(
                SUPPORTED_BAND_SCREENED_CLOSER_REASONS.map((reason) => [
                    reason,
                    a.supportedBandScreenedCloserComparisonsByReason[reason] / Math.max(1, a.games),
                ]),
            ),
            supportedBandDuelDifferenceSelections: a.supportedBandDuelDifferenceSelections,
            supportedBandDuelDifferenceSelectionsPerGame:
                a.supportedBandDuelDifferenceSelections / Math.max(1, a.games),
            supportedBandDuelDifferenceSelectionsByDifference: a.supportedBandDuelDifferenceSelectionsByDifference,
            supportedBandDuelDifferenceSelectionsByDifferencePerGame: Object.fromEntries(
                SUPPORTED_BAND_DUEL_DIFFERENCES.map((difference) => [
                    difference,
                    a.supportedBandDuelDifferenceSelectionsByDifference[difference] / Math.max(1, a.games),
                ]),
            ),
            supportedBandDuelDifferenceProposals: a.supportedBandDuelDifferenceProposals,
            supportedBandDuelDifferenceProposalsPerGame: a.supportedBandDuelDifferenceProposals / Math.max(1, a.games),
            supportedBandDuelDifferenceProposalsByDifference: a.supportedBandDuelDifferenceProposalsByDifference,
            supportedBandDuelDifferenceProposalsByDifferencePerGame: Object.fromEntries(
                SUPPORTED_BAND_DUEL_DIFFERENCES.map((difference) => [
                    difference,
                    a.supportedBandDuelDifferenceProposalsByDifference[difference] / Math.max(1, a.games),
                ]),
            ),
            protectedAdvanceGuardrailVetoes: a.protectedAdvanceGuardrailVetoes,
            protectedAdvanceGuardrailVetoesPerGame: a.protectedAdvanceGuardrailVetoes / Math.max(1, a.games),
            protectedAdvanceGuardrailVetoesByReason: a.protectedAdvanceGuardrailVetoesByReason,
            protectedAdvanceGuardrailVetoesByReasonPerGame: Object.fromEntries(
                PROTECTED_ADVANCE_GUARDRAIL_REASONS.map((reason) => [
                    reason,
                    a.protectedAdvanceGuardrailVetoesByReason[reason] / Math.max(1, a.games),
                ]),
            ),
            protectedAdvanceGuardrailProposals: a.protectedAdvanceGuardrailProposals,
            protectedAdvanceGuardrailProposalsPerGame: a.protectedAdvanceGuardrailProposals / Math.max(1, a.games),
            protectedAdvanceGuardrailProposalsByReason: a.protectedAdvanceGuardrailProposalsByReason,
            protectedAdvanceGuardrailProposalsByReasonPerGame: Object.fromEntries(
                PROTECTED_ADVANCE_GUARDRAIL_REASONS.map((reason) => [
                    reason,
                    a.protectedAdvanceGuardrailProposalsByReason[reason] / Math.max(1, a.games),
                ]),
            ),
            supportedPrepinEgressSelections: a.supportedPrepinEgressSelections,
            supportedPrepinEgressSelectionsPerGame: a.supportedPrepinEgressSelections / Math.max(1, a.games),
            supportedPrepinEgressProposals: a.supportedPrepinEgressProposals,
            supportedPrepinEgressProposalsPerGame: a.supportedPrepinEgressProposals / Math.max(1, a.games),
            supportedPrepinEgressFunnel: a.supportedPrepinEgressFunnel,
            supportedPrepinEgressFunnelPerGame: Object.fromEntries(
                V08_SUPPORTED_PREPIN_EGRESS_FUNNEL_STAGES.map((stage) => [
                    stage,
                    a.supportedPrepinEgressFunnel[stage] / Math.max(1, a.games),
                ]),
            ),
            meleeDamagePerGame: a.meleeDamage / Math.max(1, a.games),
            perLap: laps.map((lap) => {
                const slot = a.byLap.get(lap)!;
                return {
                    lap,
                    decisions: slot.decisions,
                    waitRate: slot.waits / Math.max(1, slot.decisions),
                    eligible: slot.eligible,
                    cfFires: slot.cfFires,
                    deaths: a.deathsByLap.get(lap) ?? 0,
                    dmgDealt: a.dmgByLap.get(lap) ?? 0,
                };
            }),
        };
    }
    return {
        versions: out,
        note:
            "cfScorerFires = counterfactual z>0 (baked weights, UNGUARDED) on non-wait eligible points; " +
            `on the armed ${cfg.vA} seat cfScorerFiresInSupport must be ~0 (in-support fires are already ` +
            `converted) while cfScorerFires-cfScorerFiresInSupport counts points the training-support guard ` +
            `suppressed; on ${cfg.vB} cfScorerFires estimates the unguarded would-fire rate`,
    };
}

// ---------------------------------------------------------------------------------------------------------
// Worker entry — this file spawns itself; workers only ever see the message loop below.
// ---------------------------------------------------------------------------------------------------------
if (!isMainThread && parentPort) {
    const port = parentPort;
    const cfg = workerData as IMirrorRunConfig;
    port.on("message", (message: { type: "game"; game: number } | { type: "stop" }) => {
        if (message.type === "stop") {
            port.close();
            return;
        }
        try {
            const record = playMirrorGame(cfg, message.game);
            port.postMessage({ type: "result", record });
        } catch (error) {
            port.postMessage({
                type: "error",
                error: error instanceof Error ? (error.stack ?? error.message) : String(error),
            });
        }
    });
    port.postMessage({ type: "ready" });
}

export async function main(): Promise<void> {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            cohort: { type: "string", default: "ranged_max_sniper3" },
            games: { type: "string", default: "4000" },
            seed: { type: "string", default: "1" },
            concurrency: { type: "string", default: "10" },
            "amount-mode": { type: "string", default: "expBudget" },
            livetwin: { type: "string", default: "1" },
            vA: { type: "string", default: "v0.7" },
            vB: { type: "string", default: "v0.6" },
            diag: { type: "boolean", default: false },
            "zero-scorer": { type: "boolean", default: false },
            guard: { type: "string", default: "" },
            out: { type: "string", default: "sim-out/mirror_cohort" },
        },
        strict: true,
        allowPositionals: false,
    });
    const cfg: IMirrorRunConfig = {
        cohort: values.cohort as MirrorCohortName,
        games: Number(values.games),
        seed: Number(values.seed),
        vA: values.vA!,
        vB: values.vB!,
        amountMode: values["amount-mode"] as StackAmountMode,
        livetwin: values.livetwin === "1",
        diag: values.diag!,
        zeroScorer: values["zero-scorer"]!,
        guard: values.guard as IMirrorRunConfig["guard"],
    };
    if (cfg.guard && !["support", "class", "off"].includes(cfg.guard)) {
        throw new Error(`--guard must be support|class|off (or empty for the code default); got ${cfg.guard}`);
    }
    if (!MIRROR_COHORTS.includes(cfg.cohort)) {
        throw new Error(`--cohort must be one of ${MIRROR_COHORTS.join(", ")}; got ${String(cfg.cohort)}`);
    }
    if (!Number.isSafeInteger(cfg.games) || cfg.games < 2 || cfg.games % 2 !== 0) {
        throw new Error("--games must be a positive even integer (paired side swaps)");
    }
    if (!Number.isSafeInteger(cfg.seed)) {
        throw new Error(`--seed must be a safe integer; got ${values.seed}`);
    }

    // Environment BEFORE spawning workers (they inherit it at spawn).
    if (cfg.livetwin) {
        process.env.LIVETWIN = "1";
    } else {
        delete process.env.LIVETWIN;
    }
    if (cfg.diag) {
        delete process.env.SIM_NO_ACTIONS;
    } else {
        process.env.SIM_NO_ACTIONS = "1";
    }
    if (cfg.zeroScorer) {
        process.env.V07_WAIT_WEIGHTS = JSON.stringify({ b: 0, w: new Array(41).fill(0) });
    } else {
        delete process.env.V07_WAIT_WEIGHTS;
    }
    if (cfg.guard) {
        process.env.V07_WAIT_GUARD = cfg.guard;
    } else {
        delete process.env.V07_WAIT_GUARD;
    }

    const outBase = resolve(String(values.out));
    mkdirSync(dirname(outBase), { recursive: true });
    const jsonlPath = `${outBase}.records.jsonl`;
    writeFileSync(jsonlPath, "");

    const concurrency = Math.max(1, Math.min(Number(values.concurrency), cfg.games));
    const started = Date.now();
    console.error(
        `[mirror_cohort] cohort=${cfg.cohort} games=${cfg.games} seed=${cfg.seed} ` +
            `${cfg.vA} vs ${cfg.vB} amountMode=${cfg.amountMode} LIVETWIN=${cfg.livetwin ? 1 : 0} ` +
            `diag=${cfg.diag} zeroScorer=${cfg.zeroScorer} guard=${cfg.guard || "default"} conc=${concurrency}`,
    );

    const records: IMirrorGameRecord[] = [];
    await new Promise<void>((resolvePromise, rejectPromise) => {
        const dispatchedByWorker = new Array<number>(concurrency).fill(0);
        let completed = 0;
        let settled = false;
        const workers: Worker[] = [];
        const cleanup = (): void => {
            for (const w of workers) void w.terminate();
        };
        const fail = (error: unknown): void => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            rejectPromise(error instanceof Error ? error : new Error(String(error)));
        };
        const dispatchNext = (worker: Worker, workerIndex: number): void => {
            const game = mirrorWorkerGameIndex(workerIndex, dispatchedByWorker[workerIndex]!, concurrency);
            if (game >= cfg.games) {
                worker.postMessage({ type: "stop" });
                return;
            }
            dispatchedByWorker[workerIndex] += 1;
            worker.postMessage({ type: "game", game });
        };
        for (let i = 0; i < concurrency; i += 1) {
            const worker = new Worker(new URL(import.meta.url), { workerData: cfg });
            workers.push(worker);
            worker.on(
                "message",
                (
                    message:
                        | { type: "ready" }
                        | { type: "result"; record: IMirrorGameRecord }
                        | { type: "error"; error: string },
                ) => {
                    if (settled) {
                        return;
                    }
                    if (message.type === "error") {
                        fail(new Error(message.error));
                        return;
                    }
                    if (message.type === "ready") {
                        dispatchNext(worker, i);
                        return;
                    }
                    records.push(message.record);
                    appendFileSync(jsonlPath, `${JSON.stringify(message.record)}\n`);
                    completed += 1;
                    if (completed % Math.max(50, Math.floor(cfg.games / 20)) === 0 || completed === cfg.games) {
                        const rate = completed / ((Date.now() - started) / 1000);
                        console.error(`  ${completed}/${cfg.games} (${rate.toFixed(1)} games/s)`);
                    }
                    if (completed >= cfg.games) {
                        settled = true;
                        cleanup();
                        resolvePromise();
                        return;
                    }
                    dispatchNext(worker, i);
                },
            );
            worker.on("error", fail);
        }
    });

    const summary = summarizeMirrorRecords(records, cfg);
    summary.wallSeconds = (Date.now() - started) / 1000;
    if (cfg.diag) {
        summary.diagAggregate = aggregateMirrorDiag(records, cfg);
    }
    writeFileSync(`${outBase}.summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
    console.error(
        `RESULT ${cfg.cohort} ${cfg.vA} vs ${cfg.vB}: ${(summary.winRateA * 100).toFixed(2)}% ± ` +
            `${summary.sePp.toFixed(2)}pp (W${summary.winsA}/L${summary.winsB}/D${summary.draws}, ` +
            `avgLaps ${summary.avgLaps.toFixed(1)}, armageddon ${summary.armageddonDecided}, ` +
            `rej ${summary.rejectedActions})`,
    );
    console.error(`Summary: ${outBase}.summary.json`);
}

if (isMainThread && (import.meta as unknown as { main?: boolean }).main) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
