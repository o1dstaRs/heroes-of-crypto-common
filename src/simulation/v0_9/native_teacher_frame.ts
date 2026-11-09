/** Native v0.9 observations and teacher coverage; importing never enables a learned policy. */
import type { GameAction } from "../../engine/actions";
import type { Unit } from "../../units/unit";
import type { IDecisionContext } from "../../ai/ai_strategy";
import {
    buildV09HardGuardSummary,
    enumerateV09Candidates,
    v09CandidatePassesHardGuards,
    v09CandidateSignature,
} from "../../ai/versions/v0_9";
import {
    V09_FEATURE_SCHEMA_SHA256,
    V09_INPUT_FEATURE_NAMES,
    v09DecisionFeatureVectors,
} from "../../ai/versions/v0_9_features";

export interface IV09NativeTeacherFrame {
    readonly schema: "hoc.ai.v0_9.native-teacher-frame.v1";
    readonly featureSchemaSha256: string;
    readonly signatures: readonly string[];
    readonly features: readonly (readonly number[])[];
    readonly eligible: readonly boolean[];
}

/** Capture before running the offline teacher, using the exact native enumerator, features and hard guards. */
export function captureV09NativeTeacherFrame(
    unit: Unit,
    context: IDecisionContext,
    anchor: GameAction[],
): IV09NativeTeacherFrame {
    const candidates = enumerateV09Candidates(unit, context, anchor);
    const summary = buildV09HardGuardSummary(candidates, unit, context);
    const signatures = candidates.map((candidate) => v09CandidateSignature(candidate.actions));
    const features = v09DecisionFeatureVectors(candidates, unit, context);
    const eligible = candidates.map((candidate, index) =>
        v09CandidatePassesHardGuards(index, candidate, candidates, unit, context, summary),
    );
    if (
        !candidates.length ||
        signatures[0] !== v09CandidateSignature(anchor) ||
        new Set(signatures).size !== signatures.length ||
        features.some((row) => row.length !== V09_INPUT_FEATURE_NAMES.length || !row.every(Number.isFinite))
    )
        throw new Error("Invalid native v0.9 teacher frame");
    return Object.freeze({
        schema: "hoc.ai.v0_9.native-teacher-frame.v1" as const,
        featureSchemaSha256: V09_FEATURE_SCHEMA_SHA256,
        signatures: Object.freeze(signatures),
        features: Object.freeze(features.map((row) => Object.freeze(row))),
        eligible: Object.freeze(eligible),
    });
}

/** An absent or guarded teacher action is missing evidence, never an invented candidate-zero label. */
export function labelV09NativeTeacherFrame(frame: IV09NativeTeacherFrame, teacher: readonly GameAction[]) {
    if (
        frame.schema !== "hoc.ai.v0_9.native-teacher-frame.v1" ||
        frame.featureSchemaSha256 !== V09_FEATURE_SCHEMA_SHA256 ||
        !frame.signatures.length ||
        frame.signatures.length !== frame.features.length ||
        frame.signatures.length !== frame.eligible.length ||
        frame.features.some((row) => row.length !== V09_INPUT_FEATURE_NAMES.length || !row.every(Number.isFinite)) ||
        frame.eligible.some((value) => typeof value !== "boolean") ||
        new Set(frame.signatures).size !== frame.signatures.length
    )
        throw new Error("Incompatible native v0.9 teacher frame");
    const signature = v09CandidateSignature(teacher);
    const index = frame.signatures.indexOf(signature);
    return Object.freeze({
        teacherSignature: signature,
        teacherIndex: index < 0 ? null : index,
        trainable: index >= 0 && frame.eligible[index],
        reason:
            index < 0
                ? ("teacher_outside_native_catalog" as const)
                : !frame.eligible[index]
                  ? ("teacher_rejected_by_native_guard" as const)
                  : null,
    });
}
