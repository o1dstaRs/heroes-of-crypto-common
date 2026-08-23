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

import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IL_ACTION_FEATURE_NAMES } from "../../src/simulation/il_action_features";
import { VALUE_FEATURE_NAMES_V2 } from "../../src/simulation/value_features";
import {
    buildV09CrossArchTeacherParityReceipt,
    validateV09CrossArchTeacherParityReceipt,
} from "../../src/simulation/v0_9/cross_arch_teacher_parity";
import { V09GameRecorder } from "../../src/simulation/v0_9/recorder";
import { V09_RICH_FEATURE_NAMES } from "../../src/simulation/v0_9/protocol";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const RUN = "d".repeat(64);

function writeShard(directory: string, teacherMean: number, signature = "wait_turn"): void {
    const common = {
        sourceCommit: SHA_A,
        rulesFingerprint: SHA_B,
        anchorFingerprint: SHA_C,
        phase: "wide_teacher" as const,
        split: "train" as const,
        cohort: "uniform-mixed",
        map: "normal" as const,
        seed: 7,
        gameId: "wide_teacher_train:0:7:v0.8-a13:anchor-mirror",
    };
    const recorder = new V09GameRecorder(
        {
            runFingerprint: RUN,
            sourceCommit: SHA_A,
            rulesFingerprint: SHA_B,
            anchorFingerprint: SHA_C,
        },
        {
            ...common,
            greenVersion: "v0.8+a13",
            redVersion: "v0.8+a13",
            winner: "green",
            endReason: "elimination",
        },
    );
    recorder.record({
        ...common,
        decision: 0,
        seat: "green",
        lap: 1,
        actorUnitName: "Archer",
        valueFeatures: Array<number>(VALUE_FEATURE_NAMES_V2.length).fill(0),
        incumbentIndex: 0,
        teacherIndex: 0,
        candidates: [
            {
                kind: "wait",
                signature,
                actions: [{ type: "wait_turn", unitId: "actor" }],
                candidateFeatures: Array<number>(11).fill(0),
                actionFeatures: Array<number>(IL_ACTION_FEATURE_NAMES.length).fill(0),
                richFeatures: Array<number>(V09_RICH_FEATURE_NAMES.length).fill(0),
                metadata: {
                    declaredUnitId: null,
                    firstHitUnitId: null,
                    aimUnitId: null,
                    aimCell: null,
                    aimSide: null,
                    spellName: null,
                    spellTargetMode: null,
                },
                flags: {
                    productive: 0,
                    waitEligible: 1,
                    luckShield: 0,
                    mountainAttack: 0,
                    urgentFinish: 0,
                    dominantFinish: 0,
                    aimVisibleEdge: 0,
                    trajectoryIntercepted: 0,
                },
                teacherMean,
                teacherStdErr: null,
                teacherVisits: 8,
            },
        ],
    });
    recorder.finalize(join(directory, "000000-7.jsonl"));
}

describe("v0.9 cross-architecture teacher parity", () => {
    it("seals exact labels and outcomes while allowing only bounded teacher-score drift", () => {
        const left = mkdtempSync(join(tmpdir(), "hoc-v09-parity-left-"));
        const right = mkdtempSync(join(tmpdir(), "hoc-v09-parity-right-"));
        writeShard(left, 0.5);
        writeShard(right, 0.5 + Number.EPSILON);

        const receipt = buildV09CrossArchTeacherParityReceipt({
            leftDirectory: left,
            rightDirectory: right,
            leftArchitecture: "arm64",
            rightArchitecture: "x64",
            mode: "test_fixture",
            minimumGames: 1,
        });
        expect(receipt.eligibleForDistributedTeacher).toBeFalse();
        expect(receipt.phase).toBe("wide_teacher");
        expect(receipt.split).toBe("train");
        expect(receipt.games).toBe(1);
        expect(receipt.rawExactGames).toBe(0);
        expect(receipt.labelExactGames).toBe(1);
        expect(receipt.outcomeExactGames).toBe(1);
        expect(receipt.scoreDifferences).toBe(1);
        expect(receipt.maximumScoreDifference).toBe(Number.EPSILON);
        expect(validateV09CrossArchTeacherParityReceipt(receipt)).toEqual(receipt);
        expect(() => validateV09CrossArchTeacherParityReceipt({ ...receipt, maximumScoreDifference: 0 })).toThrow(
            "invalid v0.9 cross-architecture teacher parity receipt",
        );
    });

    it("rejects label/action structure changes and score drift beyond tolerance", () => {
        const left = mkdtempSync(join(tmpdir(), "hoc-v09-parity-left-"));
        const changedLabel = mkdtempSync(join(tmpdir(), "hoc-v09-parity-label-"));
        const changedScore = mkdtempSync(join(tmpdir(), "hoc-v09-parity-score-"));
        writeShard(left, 0.5);
        writeShard(changedLabel, 0.5, "different_wait");
        writeShard(changedScore, 0.5 + 1e-9);

        const options = {
            leftDirectory: left,
            leftArchitecture: "arm64",
            rightArchitecture: "x64",
            mode: "test_fixture" as const,
            minimumGames: 1,
        };
        expect(() => buildV09CrossArchTeacherParityReceipt({ ...options, rightDirectory: changedLabel })).toThrow(
            "labels, candidates, actions, or features differ",
        );
        expect(() => buildV09CrossArchTeacherParityReceipt({ ...options, rightDirectory: changedScore })).toThrow(
            "beyond 1e-12",
        );
    });

    it("never marks a sub-96 game fixture eligible for distributed training", () => {
        const left = mkdtempSync(join(tmpdir(), "hoc-v09-parity-left-"));
        const right = mkdtempSync(join(tmpdir(), "hoc-v09-parity-right-"));
        writeShard(left, 0.5);
        writeShard(right, 0.5);

        expect(() =>
            buildV09CrossArchTeacherParityReceipt({
                leftDirectory: left,
                rightDirectory: right,
                leftArchitecture: "arm64",
                rightArchitecture: "x64",
                minimumGames: 1,
            }),
        ).toThrow("production cross-architecture parity requires at least 96 games");
    });
});
