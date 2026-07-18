/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import type { IV07ComposedAuditRow } from "../v0_7_composed_ranked_ladder";
import {
    V08_ALIGNED_96H_V1_VERSION_PROFILE,
    assertAligned96hVersionProfile,
    cloneAligned96hVersionProfile,
} from "./aligned_96h_version_profile";
import {
    compactV07AlignedV2Observation,
    playV07AlignedV2Task,
    readV07AlignedV2AuditAppend,
    type IAligned96hBattleRecord,
    type IV07AlignedV2GameDependencies,
} from "./v0_7_aligned_96h_v2_game_adapter";
import type { IV07AlignedV2ExecutionTask } from "./v0_7_aligned_96h_v2_protocol";
import type { IV08AlignedV1GameObservation } from "./v0_8_aligned_96h_v1_core";
import {
    evaluatorCellV08AlignedV1,
    v08AlignedV1TaskKey,
    validateV08AlignedV1CandidateBinding,
    type IV08AlignedV1CandidateBinding,
    type IV08AlignedV1ExecutionTask,
} from "./v0_8_aligned_96h_v1_protocol";

export interface IV08AlignedV1BattleRecord extends IAligned96hBattleRecord<IV08AlignedV1CandidateBinding> {
    artifactKind: "v0_8_aligned_96h_v1_battle_record";
    versionProfile: typeof V08_ALIGNED_96H_V1_VERSION_PROFILE;
}

export type V08AlignedV1ExecutionTaskInput = IV07AlignedV2ExecutionTask | IV08AlignedV1ExecutionTask;

export function validateV08AlignedV1ExecutionTask(task: V08AlignedV1ExecutionTaskInput): void {
    if ("artifactKind" in task) {
        if (task.artifactKind !== "v0_8_aligned_96h_v1_execution_task") {
            throw new Error("v0.8 aligned v1 execution task artifact kind is invalid");
        }
        assertAligned96hVersionProfile(task.versionProfile, V08_ALIGNED_96H_V1_VERSION_PROFILE);
    }
    const cell = evaluatorCellV08AlignedV1(task.cellId);
    if (
        cell.candidate !== V08_ALIGNED_96H_V1_VERSION_PROFILE.candidate ||
        cell.candidateBase !== V08_ALIGNED_96H_V1_VERSION_PROFILE.candidateBase ||
        cell.opponent !== V08_ALIGNED_96H_V1_VERSION_PROFILE.opponent
    ) {
        throw new Error(`${cell.id}: v0.8 aligned evaluator version isolation drifted`);
    }
}

export function playV08AlignedV1Task(
    task: V08AlignedV1ExecutionTaskInput,
    binding: IV08AlignedV1CandidateBinding,
    dependencies: IV07AlignedV2GameDependencies = {},
): IV08AlignedV1BattleRecord {
    validateV08AlignedV1ExecutionTask(task);
    validateV08AlignedV1CandidateBinding(binding);
    const record = playV07AlignedV2Task(task, dependencies, binding);
    if (record.taskKey !== v08AlignedV1TaskKey(task)) {
        throw new Error("v0.8 aligned task key drifted while reconstructing the physical match");
    }
    return {
        ...record,
        artifactKind: "v0_8_aligned_96h_v1_battle_record",
        versionProfile: cloneAligned96hVersionProfile(V08_ALIGNED_96H_V1_VERSION_PROFILE),
    };
}

export function compactV08AlignedV1Observation(
    record: IV08AlignedV1BattleRecord,
    binding: IV08AlignedV1CandidateBinding,
    audit?: IV07ComposedAuditRow,
): IV08AlignedV1GameObservation {
    if (record.artifactKind !== "v0_8_aligned_96h_v1_battle_record") {
        throw new Error(`${record.taskKey}: v0.8 battle record artifact kind is invalid`);
    }
    assertAligned96hVersionProfile(record.versionProfile, V08_ALIGNED_96H_V1_VERSION_PROFILE);
    validateV08AlignedV1CandidateBinding(binding);
    return compactV07AlignedV2Observation(record, binding, audit);
}

export const readV08AlignedV1AuditAppend = readV07AlignedV2AuditAppend;
