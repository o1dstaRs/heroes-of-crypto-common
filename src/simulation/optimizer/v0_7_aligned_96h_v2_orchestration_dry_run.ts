/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import {
    applyV07AlignedV2OrchestratorCommand,
    createV07AlignedV2OrchestratorDefinition,
    deriveV07AlignedV2OrchestratorState,
    type IV07AlignedV2OrchestratorDefinitionInput,
    type IV07AlignedV2OrchestratorEvent,
    type IV07AlignedV2PanelEvidenceInput,
    type IV07AlignedV2RevealedSeedArtifacts,
} from "./v0_7_aligned_96h_v2_orchestrator";
import { fingerprintV07AlignedV2, type IV07AlignedV2InjectedSeedPlan } from "./v0_7_aligned_96h_v2_protocol";

export interface IV07AlignedV2SyntheticDryRunInput {
    definition: IV07AlignedV2OrchestratorDefinitionInput;
    trainingEvidence: Array<{
        candidateGenomeSha256: string;
        evidence: IV07AlignedV2PanelEvidenceInput;
    }>;
    seedReveal: {
        trainSeedPlan: IV07AlignedV2InjectedSeedPlan;
        confirmSeedPlan: IV07AlignedV2InjectedSeedPlan;
        finalSeedPlan: IV07AlignedV2InjectedSeedPlan;
        seedArtifacts: IV07AlignedV2RevealedSeedArtifacts;
    };
    confirmation: {
        challenger: IV07AlignedV2PanelEvidenceInput;
        incumbent: IV07AlignedV2PanelEvidenceInput;
    };
}

export interface IV07AlignedV2SyntheticDryRunReport {
    schemaVersion: 1;
    artifactKind: "v0_7_aligned_96h_v2_orchestration_dry_run";
    mode: "synthetic_dry_run";
    status: "research_only_no_bake";
    automaticBake: false;
    automaticDeploy: false;
    gamesExecuted: 0;
    workersStarted: 0;
    seedMaterialGenerated: false;
    injectedSeedPlansOnly: true;
    outcomeDrivenSeedAllocation: false;
    definitionSha256: string;
    events: number;
    eventHeadSha256: string;
    frozenCandidateSha256: string;
    terminalSha256: string;
    verdict: "HOLD";
    reportSha256: string;
}

/** Exercise the complete synthetic train/freeze/reveal/confirm path without executing a game or worker. */
export function runV07AlignedV2SyntheticOrchestrationDryRun(
    input: IV07AlignedV2SyntheticDryRunInput,
): IV07AlignedV2SyntheticDryRunReport {
    if (input.definition.mode !== "synthetic_dry_run") {
        throw new Error("aligned v2 orchestration dry-run accepts only synthetic_dry_run definitions");
    }
    const definition = createV07AlignedV2OrchestratorDefinition(input.definition);
    if (input.trainingEvidence.length !== definition.candidates.length) {
        throw new Error("aligned v2 orchestration dry-run requires the exact finite candidate catalog");
    }
    let events: IV07AlignedV2OrchestratorEvent[] = [];
    let nowMs = definition.schedule.startAtMs;
    for (const training of input.trainingEvidence) {
        const result = applyV07AlignedV2OrchestratorCommand(definition, events, {
            type: "record_train",
            commandId: `dry-run-train-${training.candidateGenomeSha256}`,
            nowMs: ++nowMs,
            candidateGenomeSha256: training.candidateGenomeSha256,
            evidence: training.evidence,
        });
        events = result.events;
    }
    let result = applyV07AlignedV2OrchestratorCommand(definition, events, {
        type: "freeze_candidate",
        commandId: "dry-run-freeze",
        nowMs: ++nowMs,
    });
    events = result.events;
    result = applyV07AlignedV2OrchestratorCommand(definition, events, {
        type: "reveal_final_plan",
        commandId: "dry-run-reveal",
        nowMs: ++nowMs,
        ...input.seedReveal,
    });
    events = result.events;
    result = applyV07AlignedV2OrchestratorCommand(definition, events, {
        type: "record_confirmation",
        commandId: "dry-run-confirm",
        nowMs: ++nowMs,
        ...input.confirmation,
    });
    events = result.events;
    const state = deriveV07AlignedV2OrchestratorState(definition, events);
    if (
        state.phase !== "terminal" ||
        !state.frozen ||
        !state.terminal ||
        state.terminal.status !== "research_only_no_bake" ||
        state.terminal.verdict !== "HOLD" ||
        !state.eventHeadSha256
    ) {
        throw new Error("aligned v2 synthetic dry-run did not reach its expected research-only HOLD terminal");
    }
    const unsigned = {
        schemaVersion: 1 as const,
        artifactKind: "v0_7_aligned_96h_v2_orchestration_dry_run" as const,
        mode: "synthetic_dry_run" as const,
        status: "research_only_no_bake" as const,
        automaticBake: false as const,
        automaticDeploy: false as const,
        gamesExecuted: 0 as const,
        workersStarted: 0 as const,
        seedMaterialGenerated: false as const,
        injectedSeedPlansOnly: true as const,
        outcomeDrivenSeedAllocation: false as const,
        definitionSha256: definition.definitionSha256,
        events: events.length,
        eventHeadSha256: state.eventHeadSha256,
        frozenCandidateSha256: state.frozen.genomeSha256,
        terminalSha256: state.terminal.terminalSha256,
        verdict: "HOLD" as const,
    };
    return { ...unsigned, reportSha256: fingerprintV07AlignedV2(unsigned) };
}
