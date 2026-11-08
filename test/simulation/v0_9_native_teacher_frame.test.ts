import { expect, test } from "bun:test";

import { v09CandidateSignature } from "../../src/ai/versions/v0_9";
import { V09_FEATURE_SCHEMA_SHA256, V09_INPUT_FEATURE_NAMES } from "../../src/ai/versions/v0_9_features";
import type { GameAction } from "../../src/engine/actions";
import {
    labelV09NativeTeacherFrame,
    type IV09NativeTeacherFrame,
} from "../../src/simulation/v0_9/native_teacher_frame";

const actions: GameAction[][] = [[{ type: "wait_turn", unitId: "actor" }], [{ type: "defend_turn", unitId: "actor" }]];
const frame = (eligible = [true, true]): IV09NativeTeacherFrame => ({
    schema: "hoc.ai.v0_9.native-teacher-frame.v1",
    featureSchemaSha256: V09_FEATURE_SCHEMA_SHA256,
    signatures: actions.map(v09CandidateSignature),
    features: actions.map(() => Array<number>(V09_INPUT_FEATURE_NAMES.length).fill(0)),
    eligible,
});

test("native teacher labels retain the exact teacher action and distinguish the anchor", () => {
    expect(labelV09NativeTeacherFrame(frame(), actions[0])).toMatchObject({
        teacherIndex: 0,
        trainable: true,
        reason: null,
    });
    expect(labelV09NativeTeacherFrame(frame(), actions[1])).toMatchObject({
        teacherIndex: 1,
        trainable: true,
        reason: null,
    });
});

test("missing native actions are reported without a fabricated anchor target", () => {
    const label = labelV09NativeTeacherFrame(frame(), [{ type: "end_turn", unitId: "actor" }]);
    expect(label).toMatchObject({ teacherIndex: null, trainable: false, reason: "teacher_outside_native_catalog" });
});

test("a teacher action excluded by native safety remains excluded from supervised labels", () => {
    expect(labelV09NativeTeacherFrame(frame([true, false]), actions[1])).toMatchObject({
        teacherIndex: 1,
        trainable: false,
        reason: "teacher_rejected_by_native_guard",
    });
});

test("incompatible or ambiguous native observations fail before labeling", () => {
    expect(() => labelV09NativeTeacherFrame({ ...frame(), featureSchemaSha256: "0".repeat(64) }, actions[0])).toThrow();
    expect(() => labelV09NativeTeacherFrame({ ...frame(), eligible: [true] }, actions[0])).toThrow();
    expect(() =>
        labelV09NativeTeacherFrame(
            { ...frame(), signatures: [frame().signatures[0], frame().signatures[0]] },
            actions[0],
        ),
    ).toThrow();
});
