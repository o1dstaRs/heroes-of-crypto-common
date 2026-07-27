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

import {
    V09_CANDIDATE_FEATURE_NAMES,
    V09_RICH_FEATURE_NAMES,
    v09CandidateFeatureVector,
    v09CandidateIsProductive,
    v09RangeObservation,
    type IV09RangeObservation,
} from "../../ai/versions/v0_9_features";
import { PBTypes } from "../../generated/protobuf/v1/types";
import { IL_ACTION_FEATURE_NAMES, ilCandidateActionEncoding } from "../il_action_features";
import { ilActionSignature, ilCandidateFeatureVector } from "../il_dataset";
import type { ISearchScoredDecision, SearchScoredDecisionObserver } from "../search_driver";
import { VALUE_FEATURE_NAMES_V2 } from "../value_features";
import type { IV09DecisionInput, V09GameRecorder } from "./recorder";

export type IV09TeacherObserverOptions = Omit<
    IV09DecisionInput,
    "decision" | "seat" | "lap" | "actorUnitName" | "valueFeatures" | "incumbentIndex" | "teacherIndex" | "candidates"
>;

const richIndex = Object.freeze(
    Object.fromEntries(V09_RICH_FEATURE_NAMES.map((name, index) => [name, index])) as Record<
        (typeof V09_RICH_FEATURE_NAMES)[number],
        number
    >,
);

const flag = (features: readonly number[], name: (typeof V09_RICH_FEATURE_NAMES)[number]): 0 | 1 =>
    features[richIndex[name]] === 1 ? 1 : 0;

const sameVector = (left: readonly number[], right: readonly number[]): boolean =>
    left.length === right.length && left.every((value, index) => value === right[index]);

export function v09TeacherFirstHitUnitId(
    range: Pick<IV09RangeObservation, "hasAim" | "firstHitTargetId">,
    candidateTargetId: string | undefined,
    declaredUnitId: string | null,
): string | null {
    return range.hasAim
        ? (range.firstHitTargetId ?? null)
        : (range.firstHitTargetId ?? candidateTargetId ?? declaredUnitId);
}

function targetMetadata(decision: ISearchScoredDecision, index: number) {
    const candidate = decision.candidates[index]!;
    const range = v09RangeObservation(decision.unit, decision.context, candidate);
    const shot = candidate.actions.find((action) => action.type === "range_attack");
    const melee = candidate.actions.find((action) => action.type === "melee_attack");
    const spell = candidate.actions.find((action) => action.type === "cast_spell");
    const declaredUnitId = shot?.targetId ?? melee?.targetId ?? spell?.targetId ?? null;
    const spellTargetMode = spell
        ? spell.targetId !== undefined
            ? ("unit" as const)
            : spell.targetCell !== undefined
              ? ("cell" as const)
              : ("mass" as const)
        : null;
    return {
        declaredUnitId,
        firstHitUnitId: v09TeacherFirstHitUnitId(range, candidate.targetId, declaredUnitId),
        aimUnitId: shot?.targetId ?? null,
        aimCell: shot?.aimCell ? { ...shot.aimCell } : null,
        aimSide: shot?.aimSide ?? null,
        spellName: spell?.spellName ?? null,
        spellTargetMode,
    };
}

/**
 * Convert the additive SearchDriver teacher seam into exact IL-v4 recorder rows. Engine-rejected candidate
 * values are retained as null observations, while an all-invalid/invalid-teacher decision is skipped. This keeps
 * actor games alive without inventing a finite score for a branch the authoritative action engine rejected.
 */
export function createV09TeacherObserver(
    recorder: V09GameRecorder,
    options: IV09TeacherObserverOptions,
): SearchScoredDecisionObserver {
    let decisionOrdinal = 0;
    return (decision) => {
        if (
            decision.candidates.length !== decision.means.length ||
            decision.teacherIndex < 0 ||
            decision.teacherIndex >= decision.candidates.length
        ) {
            throw new Error("v0.9 teacher observer received an inconsistent scored candidate set");
        }
        if (!Number.isFinite(decision.means[decision.teacherIndex])) return;
        const candidates = decision.candidates.map((candidate, index) => {
            const full = v09CandidateFeatureVector(candidate, decision.unit, decision.context, decision.candidates);
            const candidateFeatures = ilCandidateFeatureVector(candidate.features);
            const actionFeatures = ilCandidateActionEncoding(candidate, decision.unit.getTeam()).features;
            const bootstrap = [...decision.valueFeatures, ...candidateFeatures, ...actionFeatures];
            if (
                decision.valueFeatures.length !== VALUE_FEATURE_NAMES_V2.length ||
                candidateFeatures.length !== V09_CANDIDATE_FEATURE_NAMES.length ||
                actionFeatures.length !== IL_ACTION_FEATURE_NAMES.length ||
                !sameVector(full.slice(0, bootstrap.length), bootstrap)
            ) {
                throw new Error("v0.9 teacher/runtime feature extractors drifted");
            }
            const richFeatures = full.slice(bootstrap.length);
            const range = v09RangeObservation(decision.unit, decision.context, candidate);
            return {
                kind: candidate.kind,
                signature: ilActionSignature(candidate.actions),
                actions: candidate.actions,
                candidateFeatures,
                actionFeatures,
                richFeatures,
                metadata: targetMetadata(decision, index),
                flags: {
                    productive: v09CandidateIsProductive(candidate) ? (1 as const) : (0 as const),
                    waitEligible: flag(richFeatures, "waitEligible"),
                    luckShield: flag(richFeatures, "luckShield"),
                    mountainAttack: flag(richFeatures, "mountainAttack"),
                    urgentFinish: flag(richFeatures, "urgentFinish"),
                    dominantFinish: flag(richFeatures, "dominantFinish"),
                    aimVisibleEdge: range.aimVisibleEdge ? (1 as const) : (0 as const),
                    trajectoryIntercepted: range.trajectoryIntercepted ? (1 as const) : (0 as const),
                },
                teacherMean: Number.isFinite(decision.means[index]) ? decision.means[index]! : null,
                // SearchDriver retains exact rollout counts but not individual samples, so no SE is claimed.
                teacherStdErr: null,
                teacherVisits: decision.rolloutsPerCandidate,
            };
        });
        recorder.record({
            ...options,
            decision: decisionOrdinal,
            seat: decision.unit.getTeam() === PBTypes.TeamVals.LOWER ? "green" : "red",
            lap: decision.context.fightProperties!.getCurrentLap(),
            actorUnitName: decision.unit.getName(),
            valueFeatures: [...decision.valueFeatures],
            incumbentIndex: 0,
            teacherIndex: decision.teacherIndex,
            candidates,
        });
        decisionOrdinal += 1;
    };
}
