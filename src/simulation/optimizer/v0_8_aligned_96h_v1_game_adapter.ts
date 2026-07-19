/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import { enumerateCandidates } from "../../ai";
import type { GameAction } from "../../engine/actions";
import { GREEN_TEAM, type IDecisionObservation, type ITurnExecutionObservation, type Side } from "../battle_engine";
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
import {
    emptyV08AlignedV1ExecutionAudit,
    gridTypeV08AlignedV1,
    validateV08AlignedV1GameObservation,
    type IV08AlignedV1CandidatePassiveAlternatives,
    type IV08AlignedV1ExecutionAudit,
    type IV08AlignedV1GameObservation,
    type IV08AlignedV1PassiveAlternativeAudit,
    type IV08AlignedV1SideExecutionAudit,
    type V08AlignedV1GridType,
} from "./v0_8_aligned_96h_v1_core";
import {
    evaluatorCellV08AlignedV1,
    upgradeV08AlignedV1ExecutionTask,
    v08AlignedV1TaskKey,
    validateV08AlignedV1CandidateBinding,
    type IV08AlignedV1CandidateBinding,
    type IV08AlignedV1ExecutionTask,
} from "./v0_8_aligned_96h_v1_protocol";

export interface IV08AlignedV1BattleRecord extends IAligned96hBattleRecord<IV08AlignedV1CandidateBinding> {
    artifactKind: "v0_8_aligned_96h_v1_battle_record";
    versionProfile: typeof V08_ALIGNED_96H_V1_VERSION_PROFILE;
    gridType: V08AlignedV1GridType;
    execution: IV08AlignedV1ExecutionAudit;
}

export type V08AlignedV1ExecutionTaskInput = IV07AlignedV2ExecutionTask | IV08AlignedV1ExecutionTask;

export interface IV08AlignedV1GameDependencies extends IV07AlignedV2GameDependencies {
    candidateEnumerator?: typeof enumerateCandidates;
}

interface IV08DecisionAlternatives {
    attackOrSpell: boolean;
    move: boolean;
    obstacleAttack: boolean;
}

interface IV08PendingDecision {
    unitId: string;
    side: Side;
    strategyVersion: string;
    alternatives: IV08DecisionAlternatives;
}

const MEANINGFUL_ACTION_TYPES = new Set<GameAction["type"]>([
    "wait_turn",
    "defend_turn",
    "move_unit",
    "melee_attack",
    "range_attack",
    "area_throw_attack",
    "obstacle_attack",
    "cast_spell",
]);

const ATTACK_OR_SPELL_ACTION_TYPES = new Set<GameAction["type"]>([
    "melee_attack",
    "range_attack",
    "area_throw_attack",
    "cast_spell",
]);

function sideForDecision(observation: IDecisionObservation): Side {
    return observation.unit.getTeam() === GREEN_TEAM ? "green" : "red";
}

function legalAlternatives(
    observation: IDecisionObservation,
    enumerate: typeof enumerateCandidates,
): IV08DecisionAlternatives {
    const candidates = enumerate(observation.unit, observation.context, [...observation.incumbent], {
        includeMountainAttacks: true,
    }).candidates;
    const actions = candidates.flatMap((candidate) => candidate.actions);
    return {
        attackOrSpell: actions.some((action) => ATTACK_OR_SPELL_ACTION_TYPES.has(action.type)),
        move: actions.some((action) => action.type === "move_unit"),
        // Kept action-based so the audit automatically sees mining when the shared legal enumerator exposes it.
        obstacleAttack: actions.some((action) => action.type === "obstacle_attack"),
    };
}

function incrementPassiveAlternatives(
    audit: IV08AlignedV1PassiveAlternativeAudit,
    alternatives: IV08DecisionAlternatives,
): void {
    audit.turns += 1;
    audit.withLegalAttackOrSpell += Number(alternatives.attackOrSpell);
    audit.withLegalMove += Number(alternatives.move);
    audit.withLegalObstacleAttack += Number(alternatives.obstacleAttack);
}

function observeExecution(
    audit: IV08AlignedV1ExecutionAudit,
    pending: IV08PendingDecision,
    observation: ITurnExecutionObservation,
    candidateSide: Side,
): void {
    if (
        pending.unitId !== observation.unitId ||
        pending.side !== observation.side ||
        pending.strategyVersion !== observation.strategyVersion
    ) {
        throw new Error("v0.8 decision/execution observer pairing drifted");
    }
    const side: IV08AlignedV1SideExecutionAudit = observation.side === candidateSide ? audit.candidate : audit.opponent;
    const completed = observation.strategyActions.filter((execution) => execution.completed);
    const rejected = observation.strategyActions.filter((execution) => !execution.completed);
    const recoveries = observation.recoveryAttempts.length
        ? observation.recoveryAttempts
        : observation.recovery.source === "none"
          ? []
          : [observation.recovery];
    const strategyNoOp = !completed.some((execution) => MEANINGFUL_ACTION_TYPES.has(execution.action.type));
    const explicitWait = completed.some((execution) => execution.action.type === "wait_turn");
    const explicitDefend = completed.some((execution) => execution.action.type === "defend_turn");

    side.observedTurns += 1;
    side.strategyNoOpTurns += Number(strategyNoOp);
    side.recoveryTurns += Number(recoveries.length > 0);
    side.recoveryAdvanceTurns += Number(recoveries.some((recovery) => recovery.source === "advance"));
    side.recoveryDefendTurns += Number(recoveries.some((recovery) => recovery.source === "defend"));
    side.recoveryFailedTurns += Number(recoveries.some((recovery) => !recovery.completed));
    side.rejectedTurns += Number(rejected.length > 0);
    side.rejectedActions += rejected.length;
    side.explicitWaits += Number(explicitWait);
    side.explicitDefends += Number(explicitDefend);
    side.completedMoves += completed.filter((execution) => execution.action.type === "move_unit").length;
    side.completedAttacksOrSpells += completed.filter((execution) =>
        ATTACK_OR_SPELL_ACTION_TYPES.has(execution.action.type),
    ).length;
    side.completedObstacleAttacks += completed.filter(
        (execution) => execution.action.type === "obstacle_attack",
    ).length;

    if (observation.side !== candidateSide) return;
    const passive: IV08AlignedV1CandidatePassiveAlternatives = audit.candidatePassiveAlternatives;
    if (explicitWait) incrementPassiveAlternatives(passive.explicitWait, pending.alternatives);
    if (explicitDefend) incrementPassiveAlternatives(passive.explicitDefend, pending.alternatives);
    if (recoveries.length) incrementPassiveAlternatives(passive.recovery, pending.alternatives);
    if (strategyNoOp) incrementPassiveAlternatives(passive.strategyNoOp, pending.alternatives);
}

export function validateV08AlignedV1ExecutionTask(task: V08AlignedV1ExecutionTaskInput): void {
    const upgraded = upgradeV08AlignedV1ExecutionTask(task);
    const cell = evaluatorCellV08AlignedV1(upgraded.cellId);
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
    dependencies: IV08AlignedV1GameDependencies = {},
): IV08AlignedV1BattleRecord {
    validateV08AlignedV1ExecutionTask(task);
    validateV08AlignedV1CandidateBinding(binding);
    const upgraded = upgradeV08AlignedV1ExecutionTask(task);
    if (dependencies.gridType !== undefined && dependencies.gridType !== upgraded.gridType) {
        throw new Error("v0.8 aligned dependency gridType conflicts with the scenarioOrdinal map assignment");
    }
    const candidateSide: Side = upgraded.candidateSeat === "candidate_green" ? "green" : "red";
    const { candidateEnumerator: _candidateEnumerator, ...sharedDependencies } = dependencies;
    const pending: IV08PendingDecision[] = [];
    const execution = emptyV08AlignedV1ExecutionAudit();
    const decisionObserver = (observation: IDecisionObservation): void => {
        const side = sideForDecision(observation);
        pending.push({
            unitId: observation.unit.getId(),
            side,
            strategyVersion: observation.strategyVersion,
            alternatives:
                side === candidateSide
                    ? legalAlternatives(observation, dependencies.candidateEnumerator ?? enumerateCandidates)
                    : { attackOrSpell: false, move: false, obstacleAttack: false },
        });
        dependencies.decisionObserver?.(observation);
    };
    const turnExecutionObserver = (observation: ITurnExecutionObservation): void => {
        const decision = pending.shift();
        if (!decision) throw new Error("v0.8 turn execution was emitted without its pre-search decision");
        observeExecution(execution, decision, observation, candidateSide);
        dependencies.turnExecutionObserver?.(observation);
    };
    const record = playV07AlignedV2Task(
        upgraded,
        {
            ...sharedDependencies,
            gridType: upgraded.gridType,
            decisionObserver,
            turnExecutionObserver,
        },
        binding,
    );
    if (pending.length) throw new Error("v0.8 match ended with an unpaired pre-search decision observation");
    if (execution.candidate.observedTurns + execution.opponent.observedTurns < 1) {
        throw new Error("v0.8 match runner did not invoke the required turn execution observers");
    }
    if (record.taskKey !== v08AlignedV1TaskKey(upgraded)) {
        throw new Error("v0.8 aligned task key drifted while reconstructing the physical match");
    }
    return {
        ...record,
        artifactKind: "v0_8_aligned_96h_v1_battle_record",
        versionProfile: cloneAligned96hVersionProfile(V08_ALIGNED_96H_V1_VERSION_PROFILE),
        gridType: upgraded.gridType,
        execution,
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
    if (record.gridType !== gridTypeV08AlignedV1(record.scenarioOrdinal)) {
        throw new Error(`${record.taskKey}: v0.8 battle record gridType does not match its scenarioOrdinal`);
    }
    const compact = compactV07AlignedV2Observation(record, binding, audit);
    return validateV08AlignedV1GameObservation({
        ...compact,
        scenarioOrdinal: record.scenarioOrdinal,
        gridType: record.gridType,
        execution: structuredClone(record.execution),
    });
}

export const readV08AlignedV1AuditAppend = readV07AlignedV2AuditAppend;
