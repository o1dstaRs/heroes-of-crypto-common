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

import type { GameAction } from "../../engine/actions";
import type { Unit } from "../../units/unit";
import type { UnitsHolder } from "../../units/units_holder";
import type { XY } from "../../utils/math";
import { captureAITargetMemory, recordAITargetMemory, restoreAITargetMemory } from "../ai";
import type {
    IAIStrategy,
    IDecisionContext,
    IPlacementContext,
    IV09DecisionTelemetryDetails,
    V09DecisionFallbackReason,
} from "../ai_strategy";
import { enumerateCandidates, type IEnumeratedCandidate } from "../candidates";
import { isV08StrongerRangedPostureWait, StrategyV0_8 } from "./v0_8";
import {
    buildV08BacklineProtectorIntent,
    buildV08BacklineWardIntent,
    isV08BacklineProtectorRuntimeDecisionAllowed,
    preservesV08BacklineWardIntent,
    v08BacklineProtectorHasCatchUpRoute,
    type IV08BacklineProtectorIntent,
    type IV08BacklineWardIntent,
} from "./v0_8_backline_protector";
import { v08DominantFinishState } from "./v0_8_dominant_finish";
import { V09_MODEL_ARTIFACT } from "./v0_9_artifact";
import {
    v09CandidateConsumesPassiveTurn,
    v09CandidateFeatureVector,
    v09CandidateIsProductive,
    v09HasResolvedVisibleShot,
} from "./v0_9_features";
import { scoreV09FixedPoint, validateV09ModelArtifact, type IV09ModelArtifact } from "./v0_9_model";

export const V09_MAX_CANDIDATES = 96;
const V09_OFFLINE_RESEARCH_ACTIVATION = Symbol("v0.9 offline research activation");

const monotonicNow = (): number => globalThis.performance?.now?.() ?? Date.now();

const canonicalValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalValue);
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
        Object.keys(record)
            .sort()
            .filter((key) => record[key] !== undefined)
            .map((key) => [key, canonicalValue(record[key])]),
    );
};

/** Stable browser/server signature used only for attribution and deterministic tie diagnostics. */
export const v09CandidateSignature = (actions: readonly GameAction[]): string =>
    JSON.stringify(canonicalValue(actions)) ?? "[]";

/** Commit only the target memory belonging to a learned decision that displaced the anchor. */
export function commitV09TargetMemoryOverride(
    unitsHolder: UnitsHolder,
    unitId: string,
    targetMemoryBeforeAnchor: ReadonlyMap<string, string>,
    selectedActions: readonly GameAction[],
): void {
    restoreAITargetMemory(unitsHolder, targetMemoryBeforeAnchor);
    const executedAttack = [...selectedActions]
        .reverse()
        .find((action) => action.type === "melee_attack" || action.type === "range_attack");
    if (executedAttack && (executedAttack.type === "melee_attack" || executedAttack.type === "range_attack")) {
        recordAITargetMemory(unitsHolder, unitId, executedAttack.targetId);
    }
}

const attacksForbiddenTarget = (unit: Unit, candidate: IEnumeratedCandidate): boolean =>
    candidate.actions.some(
        (action) =>
            (action.type === "melee_attack" || action.type === "range_attack") &&
            unit.cannotAttackUnitId(action.targetId),
    );

const chebyshev = (left: XY, right: XY): number => Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));

const hasDirectFinishDamage = (candidate: IEnumeratedCandidate): boolean =>
    candidate.features.expectedDamage > 0 ||
    candidate.actions.some(
        (action) =>
            action.type === "melee_attack" || action.type === "range_attack" || action.type === "area_throw_attack",
    );

const closesEnemyDistance = (candidate: IEnumeratedCandidate, unit: Unit, context: IDecisionContext): boolean => {
    const move = candidate.actions.find((action) => action.type === "move_unit");
    const destination = move?.path[move.path.length - 1];
    if (!destination) return false;
    const enemies = context.unitsHolder.getAllEnemyUnits(unit.getTeam()).filter((enemy) => !enemy.isDead());
    if (!enemies.length) return false;
    const before = Math.min(...enemies.map((enemy) => chebyshev(unit.getBaseCell(), enemy.getBaseCell())));
    const after = Math.min(...enemies.map((enemy) => chebyshev(destination, enemy.getBaseCell())));
    return after < before;
};

/**
 * Late-fight pressure hierarchy: take an available kill, otherwise deal damage now, otherwise close distance.
 * Support/retreat remains available only when no candidate can make stronger progress toward elimination.
 */
const v09FinishPressure = (candidate: IEnumeratedCandidate, unit: Unit, context: IDecisionContext): 0 | 1 | 2 | 3 => {
    const directDamage = hasDirectFinishDamage(candidate);
    if (directDamage && candidate.features.expectedKill) return 3;
    if (directDamage) return 2;
    if (closesEnemyDistance(candidate, unit, context)) return 1;
    return 0;
};

export interface IV09HardGuardSummary {
    readonly productiveExists: boolean;
    readonly finishActive: boolean;
    readonly requiredFinishPressure: number;
    readonly backlineProtectorIntent: IV08BacklineProtectorIntent | undefined;
    readonly backlineProtectorHasCatchUpRoute: boolean;
    readonly backlineWardIntent: IV08BacklineWardIntent | undefined;
}

const v09CandidatePassesBaseSafety = (
    candidate: IEnumeratedCandidate,
    unit: Unit,
    context: IDecisionContext,
    backlineProtectorIntent: IV08BacklineProtectorIntent | undefined,
    backlineProtectorHasCatchUpRoute: boolean,
    backlineWardIntent: IV08BacklineWardIntent | undefined,
): boolean => {
    if (!candidate.actions.length || attacksForbiddenTarget(unit, candidate)) return false;
    if (!v09HasResolvedVisibleShot(unit, context, candidate)) return false;
    if (
        backlineProtectorIntent &&
        !isV08BacklineProtectorRuntimeDecisionAllowed(
            backlineProtectorIntent,
            unit,
            context,
            candidate.actions,
            backlineProtectorHasCatchUpRoute,
        )
    ) {
        return false;
    }
    if (backlineWardIntent && !preservesV08BacklineWardIntent(backlineWardIntent, unit, context, candidate.actions)) {
        return false;
    }
    return true;
};

export function buildV09HardGuardSummary(
    candidates: readonly IEnumeratedCandidate[],
    unit: Unit,
    context: IDecisionContext,
): IV09HardGuardSummary {
    const finish = v08DominantFinishState(
        context.unitsHolder,
        unit.getTeam(),
        context.fightProperties?.getCurrentLap() ?? 0,
    );
    const backlineProtectorIntent = buildV08BacklineProtectorIntent(unit, context);
    const backlineProtectorHasCatchUpRoute = backlineProtectorIntent
        ? v08BacklineProtectorHasCatchUpRoute(backlineProtectorIntent, unit, context)
        : false;
    const backlineWardIntent = buildV08BacklineWardIntent(unit, context);
    const baseSafeCandidates = candidates.filter((candidate) =>
        v09CandidatePassesBaseSafety(
            candidate,
            unit,
            context,
            backlineProtectorIntent,
            backlineProtectorHasCatchUpRoute,
            backlineWardIntent,
        ),
    );
    return {
        productiveExists: baseSafeCandidates.some(v09CandidateIsProductive),
        finishActive: finish.active,
        requiredFinishPressure: finish.active
            ? baseSafeCandidates.reduce(
                  (best, candidate) => Math.max(best, v09FinishPressure(candidate, unit, context)),
                  0,
              )
            : 0,
        backlineProtectorIntent,
        backlineProtectorHasCatchUpRoute,
        backlineWardIntent,
    };
}

/**
 * Model-side safety firewall for a trained/promoted artifact. The inert/unpromoted paths return the exact v0.8
 * anchor before candidate enumeration, while a live learned policy applies the same non-negotiable guards to
 * candidate zero too: a bad anchor may not retain an avoidable passive, mountain, or intercepted shot merely
 * because it came from the incumbent.
 */
export function v09CandidatePassesHardGuards(
    _index: number,
    candidate: IEnumeratedCandidate,
    candidates: readonly IEnumeratedCandidate[],
    unit: Unit,
    context: IDecisionContext,
    guardSummary: IV09HardGuardSummary = buildV09HardGuardSummary(candidates, unit, context),
): boolean {
    if (
        !v09CandidatePassesBaseSafety(
            candidate,
            unit,
            context,
            guardSummary.backlineProtectorIntent,
            guardSummary.backlineProtectorHasCatchUpRoute,
            guardSummary.backlineWardIntent,
        )
    ) {
        return false;
    }

    if (guardSummary.productiveExists && v09CandidateConsumesPassiveTurn(candidate)) return false;
    const hasWait = candidate.actions.some((action) => action.type === "wait_turn");
    if (
        hasWait &&
        !candidate.features.hourglassSpent &&
        !candidate.actions.some((action) => action.type === "move_unit")
    ) {
        return false;
    }
    if (hasWait) {
        // A model may retain the same intentional ranged-superiority wait as v0.8. It may also retain v0.8's
        // exact protector hold when every role-compatible active candidate is unavailable; it cannot invent a
        // new passive posture or use the exception to leave the ward.
        const lap = context.fightProperties?.getCurrentLap() ?? 0;
        const waitEligible = isV08StrongerRangedPostureWait(unit, context.unitsHolder, lap, candidate.actions);
        const protectorHoldEligible =
            !!guardSummary.backlineProtectorIntent &&
            !guardSummary.productiveExists &&
            isV08BacklineProtectorRuntimeDecisionAllowed(
                guardSummary.backlineProtectorIntent,
                unit,
                context,
                candidate.actions,
                guardSummary.backlineProtectorHasCatchUpRoute,
            );
        if (!waitEligible && !protectorHoldEligible) return false;
    }
    if (guardSummary.finishActive) {
        if (
            guardSummary.requiredFinishPressure > 0 &&
            v09FinishPressure(candidate, unit, context) < guardSummary.requiredFinishPressure
        ) {
            return false;
        }
        if (!v09CandidateIsProductive(candidate)) return false;
    }
    return true;
}

export interface IV09RankedSelection {
    readonly index: number;
    readonly fallbackReason: "no_safe_candidate" | "hard_guard" | "below_margin" | null;
}

/** Highest score wins; exact ties, sub-margin challengers and all invalid candidates resolve to candidate zero. */
export function selectV09RankedCandidate(
    scores: readonly number[],
    eligible: readonly boolean[],
    minOverrideMargin: number,
): IV09RankedSelection {
    if (!scores.length || scores.length !== eligible.length || !Number.isInteger(scores[0])) {
        throw new Error("v0.9 ranked selection requires aligned integer scores with candidate zero");
    }
    let bestIndex = -1;
    for (let index = 0; index < scores.length; index += 1) {
        if (
            eligible[index] &&
            Number.isInteger(scores[index]) &&
            (bestIndex === -1 || scores[index] > scores[bestIndex])
        ) {
            bestIndex = index;
        }
    }
    if (bestIndex === -1) {
        return { index: 0, fallbackReason: "no_safe_candidate" };
    }
    // A promoted policy may not keep an anchor that violates a non-negotiable safety rule. In this case the
    // best legal candidate wins regardless of learned margin; model/runtime failure still falls back outside
    // this selector and lets the server circuit-break to exact v0.8+a13.
    if (bestIndex !== 0 && !eligible[0]) {
        return { index: bestIndex, fallbackReason: null };
    }
    if (bestIndex !== 0 && scores[bestIndex] - scores[0] >= minOverrideMargin) {
        return { index: bestIndex, fallbackReason: null };
    }
    const guardedWinner = scores.some(
        (score, index) =>
            index > 0 && !eligible[index] && Number.isInteger(score) && score - scores[0] >= minOverrideMargin,
    );
    return { index: 0, fallbackReason: guardedWinner ? "hard_guard" : "below_margin" };
}

/**
 * A learned-policy abstention is not an engine fault. When every learned candidate is guarded out,
 * v0.9 returns the exact legal v0.8 anchor action at candidate zero and records `no_safe_candidate`
 * for analysis. Reserve circuit-breaker telemetry for a model/runtime path that could make an action
 * invalid or otherwise requires operational intervention.
 */
export function v09FallbackRequiresCircuitBreaker(fallbackReason: V09DecisionFallbackReason | null): boolean {
    return (
        fallbackReason === "invalid_artifact" ||
        fallbackReason === "missing_context" ||
        fallbackReason === "runtime_error" ||
        fallbackReason === "budget_exceeded"
    );
}

function enumerateV09Candidates(
    unit: Unit,
    context: IDecisionContext,
    anchor: GameAction[],
): readonly IEnumeratedCandidate[] {
    return enumerateCandidates(unit, context, anchor, {
        maxMoveDestinations: 8,
        preserveMovePostureDiversity: true,
        maxMeleePairs: 16,
        maxShotAims: 16,
        maxMoveShotComposites: 2,
        maxAreaThrowCells: 8,
        preserveAttackTargetCoverage: true,
        includeMountainAttacks: true,
        enrichIncumbentMetadata: true,
    }).candidates.slice(0, V09_MAX_CANDIDATES);
}

/**
 * v0.9 owns no inherited mutable policy state: it composes a private exact v0.8 instance, anchors every candidate
 * set at that decision, and only permits a qualified fixed-point artifact to override it.
 */
export class StrategyV0_9 implements IAIStrategy {
    public readonly version = "v0.9";
    private readonly anchorStrategy = new StrategyV0_8();
    private readonly artifactErrors: readonly string[];
    private readonly policyActive: boolean;
    public constructor(
        private readonly artifact: IV09ModelArtifact = V09_MODEL_ARTIFACT,
        activation?: symbol,
    ) {
        this.artifactErrors = validateV09ModelArtifact(artifact);
        this.policyActive = artifact.promoted || activation === V09_OFFLINE_RESEARCH_ACTIVATION;
    }
    public placeArmy(units: Unit[], context: IPlacementContext): Map<string, XY> {
        return this.anchorStrategy.placeArmy(units, context);
    }
    public decideTurn(unit: Unit, context: IDecisionContext): GameAction[] {
        const startedAt = monotonicNow();
        // Anchor-only, invalid, unpromoted and incompletely wired seats do not even touch policy-side memory;
        // they execute the exact v0.8 path. Snapshot only when an override can genuinely be attempted.
        const targetMemoryBeforeAnchor =
            !this.artifactErrors.length &&
            this.artifact.status === "trained" &&
            this.policyActive &&
            context.fightProperties &&
            context.attackHandler
                ? captureAITargetMemory(context.unitsHolder)
                : undefined;
        const anchor = this.anchorStrategy.decideTurn(unit, context);
        const rootDecision = context.decisionOrigin !== "rollout";
        let candidateCount = 1;
        let anchorScore: number | null = null;
        let selectedScore: number | null = null;
        let margin: number | null = null;
        let selectedIndex = 0;
        let fallbackReason: V09DecisionFallbackReason | null = null;

        const emit = (): void => {
            if (!rootDecision || !context.policyEventObserver) return;
            const details: IV09DecisionTelemetryDetails = {
                artifactStatus: this.artifact.status,
                modelId: this.artifact.modelId,
                modelSha256: this.artifact.modelSha256,
                selectedCandidateIndex: selectedIndex,
                selectedCandidateSignature: v09CandidateSignature(anchor),
                candidateCount,
                anchorScore,
                selectedScore,
                margin,
                elapsedMicros: Math.max(0, Math.round((monotonicNow() - startedAt) * 1000)),
                fallbackReason,
                circuitBreakerRecommended: v09FallbackRequiresCircuitBreaker(fallbackReason),
            };
            try {
                context.policyEventObserver({
                    kind: "v0.9_decision",
                    unitId: unit.getId(),
                    creatureName: unit.getName(),
                    team: unit.getTeam(),
                    lap: context.fightProperties?.getCurrentLap() ?? 0,
                    details,
                });
            } catch {
                // Diagnostics are observational and can never change an AI action.
            }
        };

        if (this.artifactErrors.length) {
            fallbackReason = "invalid_artifact";
            emit();
            return anchor;
        }
        if (this.artifact.status === "anchor_only") {
            fallbackReason = "untrained_anchor";
            emit();
            return anchor;
        }
        if (!this.policyActive) {
            fallbackReason = "unpromoted_model";
            emit();
            return anchor;
        }
        if (!context.fightProperties || !context.attackHandler) {
            fallbackReason = "missing_context";
            emit();
            return anchor;
        }

        try {
            const candidates = enumerateV09Candidates(unit, context, anchor);
            candidateCount = candidates.length;
            if (!candidates.length) throw new Error("v0.9 enumerator omitted candidate zero");
            const scores = candidates.map((candidate) =>
                scoreV09FixedPoint(this.artifact, v09CandidateFeatureVector(candidate, unit, context, candidates)),
            );
            const guardSummary = buildV09HardGuardSummary(candidates, unit, context);
            const eligible = candidates.map((candidate, index) =>
                v09CandidatePassesHardGuards(index, candidate, candidates, unit, context, guardSummary),
            );
            const selection = selectV09RankedCandidate(scores, eligible, this.artifact.minOverrideMargin);
            selectedIndex = selection.index;
            anchorScore = scores[0] ?? null;
            selectedScore = scores[selectedIndex] ?? null;
            margin = anchorScore === null || selectedScore === null ? null : Math.max(0, selectedScore - anchorScore);
            fallbackReason = selection.fallbackReason;
            const selected = candidates[selectedIndex];
            if (!selected) throw new Error("v0.9 selected an absent candidate");

            if (rootDecision && context.policyEventObserver) {
                const details: IV09DecisionTelemetryDetails = {
                    artifactStatus: this.artifact.status,
                    modelId: this.artifact.modelId,
                    modelSha256: this.artifact.modelSha256,
                    selectedCandidateIndex: selectedIndex,
                    selectedCandidateSignature: v09CandidateSignature(selected.actions),
                    candidateCount,
                    anchorScore,
                    selectedScore,
                    margin,
                    elapsedMicros: Math.max(0, Math.round((monotonicNow() - startedAt) * 1000)),
                    fallbackReason,
                    circuitBreakerRecommended: v09FallbackRequiresCircuitBreaker(fallbackReason),
                };
                try {
                    context.policyEventObserver({
                        kind: "v0.9_decision",
                        unitId: unit.getId(),
                        creatureName: unit.getName(),
                        team: unit.getTeam(),
                        lap: context.fightProperties.getCurrentLap(),
                        details,
                    });
                } catch {
                    // Diagnostics are observational and can never change an AI action.
                }
            }
            if (selectedIndex !== 0) {
                // The anchor policy may update its per-battle focus memory while deciding. A learned override
                // must not leak that abandoned target into the next activation: restore the pre-anchor snapshot,
                // then persist only the attack v0.9 will actually execute (same contract as SearchDriver).
                // Commit last so any earlier inference/telemetry fault can still return the untouched anchor.
                commitV09TargetMemoryOverride(
                    context.unitsHolder,
                    unit.getId(),
                    targetMemoryBeforeAnchor!,
                    selected.actions,
                );
            }
            return selected.actions;
        } catch {
            fallbackReason = "runtime_error";
            selectedIndex = 0;
            selectedScore = anchorScore;
            margin = anchorScore === null ? null : 0;
            emit();
            return anchor;
        }
    }
}

/**
 * Activate an unpromoted, structurally valid research artifact only inside an explicitly constructed
 * simulation strategy. This avoids forging `promoted:true` (which now requires a qualification receipt)
 * while keeping the registered/browser/server v0.9 singleton unable to run research weights.
 */
export function createV09OfflineResearchStrategy(artifact: IV09ModelArtifact): IAIStrategy {
    if (artifact.status !== "trained" || artifact.promoted || artifact.qualification !== null) {
        throw new Error("offline v0.9 evaluation requires an unpromoted trained research artifact");
    }
    const errors = validateV09ModelArtifact(artifact);
    if (errors.length) {
        throw new Error(`offline v0.9 research artifact is invalid: ${errors.join("; ")}`);
    }
    return new StrategyV0_9(artifact, V09_OFFLINE_RESEARCH_ACTIVATION);
}

export const STRATEGY_V0_9: IAIStrategy = new StrategyV0_9();
