/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { IV07ComposedAuditRow } from "../../src/simulation/v0_7_composed_ranked_ladder";
import {
    V07_ALIGNED_96H_V2_CELLS,
    V07_ALIGNED_96H_V2_SEATS,
    type IV07AlignedV2GameObservation,
    type V07AlignedV2Outcome,
} from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_core";
import type {
    IV07AlignedV2ShardEvaluation,
    IV07AlignedV2WorkerAttestation,
} from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_evaluator";
import {
    compactV07AlignedV2Observation,
    type IV07AlignedV2BattleRecord,
} from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_game_adapter";
import {
    buildV07AlignedV2ProductionCandidateCatalog,
    buildV07AlignedV2ProductionIncumbentGenome,
} from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_catalog";
import { createV07AlignedV2FilesystemEvidenceResolver } from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_filesystem_resolvers";
import {
    applyV07AlignedV2OrchestratorCommand,
    createV07AlignedV2OrchestratorDefinition,
    deriveV07AlignedV2OrchestratorState,
    type IV07AlignedV2OrchestratorCommand,
    type IV07AlignedV2OrchestratorDefinition,
    type IV07AlignedV2OrchestratorEvent,
    type IV07AlignedV2OrchestratorReplayResolvers,
    type IV07AlignedV2PanelEvidenceInput,
    type IV07AlignedV2RevealedSeedArtifacts,
    type IV07AlignedV2SeedArtifactRef,
} from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_orchestrator";
import { runV07AlignedV2SyntheticOrchestrationDryRun } from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_orchestration_dry_run";
import {
    appendV07AlignedV2OrchestratorEvent,
    initializeV07AlignedV2OrchestratorPersistence,
    loadV07AlignedV2PersistedOrchestrator,
    type IV07AlignedV2OrchestratorCurrent,
} from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_orchestrator_persistence";
import {
    loadV07AlignedV2PersistedShard,
    persistV07AlignedV2ShardEvaluation,
} from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_persistence";
import {
    bindV07AlignedV2Candidate,
    bindV07AlignedV2SeedPlan,
    buildV07AlignedV2CandidateEnvironment,
    buildV07AlignedV2CheckpointShardSpecs,
    canonicalV07AlignedV2Json,
    createV07AlignedV2Checkpoint,
    fingerprintV07AlignedV2,
    flattenV07AlignedV2SeedPlan,
    v07AlignedV2TaskKey,
    V07_ALIGNED_V2_EVALUATOR_CELLS,
    type IV07AlignedV2CandidateGenome,
    type IV07AlignedV2CheckpointPanelBinding,
    type IV07AlignedV2InjectedSeedPlan,
    type V07AlignedV2PanelPurpose,
} from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_protocol";
import { validateV07AlignedV2TerminalReplay } from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_supervisor";

const HOUR_MS = 60 * 60 * 1000;

function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

function canonicalFile(value: unknown): string {
    return `${canonicalV07AlignedV2Json(value)}\n`;
}

function testGenomes(): [IV07AlignedV2CandidateGenome, IV07AlignedV2CandidateGenome, IV07AlignedV2CandidateGenome] {
    const candidates = buildV07AlignedV2ProductionCandidateCatalog();
    return [candidates[0], candidates[1], buildV07AlignedV2ProductionIncumbentGenome()];
}

function syntheticSeedPlan(
    purpose: V07AlignedV2PanelPurpose,
    panelId: string,
    firstSeed: number,
): IV07AlignedV2InjectedSeedPlan {
    let nextSeed = firstSeed;
    const take = (): number => nextSeed++;
    return {
        schemaVersion: 1,
        panelId,
        purpose,
        scenariosPerCell: 1,
        denysetSha256: "d".repeat(64),
        pairs: V07_ALIGNED_V2_EVALUATOR_CELLS.map((cell) => {
            if (cell.distribution === "fixed_template") {
                const setupSeeds = [take()];
                const combatSeed = take();
                return {
                    cellId: cell.id,
                    scenarioOrdinal: 0,
                    scenarioId: "0",
                    seats: {
                        candidate_green: { setupSeeds: [...setupSeeds], combatSeed },
                        candidate_red: { setupSeeds: [...setupSeeds], combatSeed },
                    },
                };
            }
            const stream = () => ({
                setupSeeds: Array.from({ length: 128 }, take),
                combatSeed: take(),
            });
            return {
                cellId: cell.id,
                scenarioOrdinal: 0,
                scenarioId: "0",
                seats: { candidate_green: stream(), candidate_red: stream() },
            };
        }),
    };
}

function observations(outcome: V07AlignedV2Outcome, firstLoss = false): IV07AlignedV2GameObservation[] {
    return V07_ALIGNED_96H_V2_CELLS.flatMap((cell) =>
        V07_ALIGNED_96H_V2_SEATS.map((candidateSeat, seatIndex): IV07AlignedV2GameObservation => ({
            cellId: cell.id,
            candidateSeat,
            scenarioId: "0",
            outcome:
                firstLoss && cell.id === V07_ALIGNED_96H_V2_CELLS[0].id && seatIndex === 0 ? "opponent_win" : outcome,
            reachedArmageddon: false,
            candidateRejections: 0,
            opponentRejections: 0,
            searchAudit: {
                decisions: 10,
                searchedDecisions: 10,
                deadlineFallbacks: 0,
                illegalIncumbents: 0,
                circuitOpened: false,
                circuitSkippedDecisions: 0,
                msTotal: 100,
            },
        })),
    );
}

function evidence(
    panel: IV07AlignedV2CheckpointPanelBinding,
    genomeSha256: string,
    rows: IV07AlignedV2GameObservation[],
    label: string,
): IV07AlignedV2PanelEvidenceInput {
    return {
        panel,
        genomeSha256,
        artifacts: [{ directory: `synthetic/${label}`, manifestSha256: sha256(label) }],
        observations: rows,
    };
}

interface IOrchestrationFixture {
    definition: IV07AlignedV2OrchestratorDefinition;
    trainPlan: IV07AlignedV2InjectedSeedPlan;
    confirmPlan: IV07AlignedV2InjectedSeedPlan;
    finalPlan: IV07AlignedV2InjectedSeedPlan;
    seedArtifacts: IV07AlignedV2RevealedSeedArtifacts;
    seedCommitment: IV07AlignedV2SeedArtifactRef;
    training: IV07AlignedV2PanelEvidenceInput[];
    confirmation: { challenger: IV07AlignedV2PanelEvidenceInput; incumbent: IV07AlignedV2PanelEvidenceInput };
    selectedGenomeSha256: string;
    evidenceRows: Map<string, IV07AlignedV2GameObservation[]>;
    resolvers: IV07AlignedV2OrchestratorReplayResolvers;
}

function evidenceKey(panelFingerprint: string, genomeSha256: string): string {
    return `${panelFingerprint}|${genomeSha256}`;
}

function orchestrationFixture(): IOrchestrationFixture {
    const [candidateA, candidateB, incumbentGenome] = testGenomes();
    const trainPlan = syntheticSeedPlan("train", "synthetic-train", 10_000);
    const confirmPlan = syntheticSeedPlan("confirm", "synthetic-confirm", 100_000);
    const finalPlan = syntheticSeedPlan("final", "synthetic-final", 200_000);
    const seedCommitment = {
        path: "seed-allocation/commitment.json",
        bytesSha256: sha256("synthetic commitment bytes"),
        artifactSha256: sha256("synthetic commitment"),
    };
    const seedArtifacts = {
        commitment: seedCommitment,
        finalReveal: {
            path: "seed-allocation/final-reveal.json",
            bytesSha256: sha256("synthetic final reveal bytes"),
            artifactSha256: sha256("synthetic final reveal"),
        },
    };
    const startAtMs = 1_000_000;
    const definition = createV07AlignedV2OrchestratorDefinition({
        mode: "synthetic_dry_run",
        runId: "aligned-v2-synthetic-restart",
        createdAtMs: startAtMs,
        composedSealSha256: "c".repeat(64),
        candidateLimit: 2,
        schedule: {
            startAtMs,
            trainDeadlineAtMs: startAtMs + 24 * HOUR_MS,
            confirmDeadlineAtMs: startAtMs + 48 * HOUR_MS,
            finalDeadlineAtMs: startAtMs + 96 * HOUR_MS,
        },
        candidateGenomes: [candidateB, candidateA],
        incumbentGenome,
        trainSeedPlan: trainPlan,
        confirmSeedPlan: confirmPlan,
        finalPanelCommitment: bindV07AlignedV2SeedPlan(finalPlan),
        seedCommitment,
    });
    const selectedGenomeSha256 = definition.candidates[0].genomeSha256;
    const otherGenomeSha256 = definition.candidates[1].genomeSha256;
    const selectedTrainingRows = observations("candidate_win");
    const otherTrainingRows = observations("candidate_win", true);
    const challengerRows = observations("candidate_win");
    const incumbentRows = observations("opponent_win");
    const training = [
        evidence(definition.panels.train, otherGenomeSha256, otherTrainingRows, "train-other"),
        evidence(definition.panels.train, selectedGenomeSha256, selectedTrainingRows, "train-selected"),
    ];
    const confirmation = {
        challenger: evidence(definition.panels.confirm, selectedGenomeSha256, challengerRows, "confirm-challenger"),
        incumbent: evidence(
            definition.panels.confirm,
            definition.incumbent.genomeSha256,
            incumbentRows,
            "confirm-incumbent",
        ),
    };
    const evidenceRows = new Map<string, IV07AlignedV2GameObservation[]>([
        [evidenceKey(definition.panels.train.panelFingerprint, otherGenomeSha256), otherTrainingRows],
        [evidenceKey(definition.panels.train.panelFingerprint, selectedGenomeSha256), selectedTrainingRows],
        [evidenceKey(definition.panels.confirm.panelFingerprint, selectedGenomeSha256), challengerRows],
        [evidenceKey(definition.panels.confirm.panelFingerprint, definition.incumbent.genomeSha256), incumbentRows],
    ]);
    const resolvers: IV07AlignedV2OrchestratorReplayResolvers = {
        seedCommitment: (artifact) => {
            if (canonicalV07AlignedV2Json(artifact) !== canonicalV07AlignedV2Json(seedCommitment)) {
                throw new Error("test seed commitment ref mismatch");
            }
            const final = bindV07AlignedV2SeedPlan(finalPlan);
            return {
                train: trainPlan,
                confirm: confirmPlan,
                final: {
                    panelId: final.panelId,
                    purpose: "final",
                    scenariosPerCell: final.scenariosPerCell,
                    denysetSha256: final.denysetSha256!,
                    panelFingerprint: final.panelFingerprint,
                    taskCount: final.taskCount,
                    tasksSha256: final.tasksSha256,
                },
            };
        },
        seedPlans: (artifacts, frozen) => {
            if (
                canonicalV07AlignedV2Json(artifacts) !== canonicalV07AlignedV2Json(seedArtifacts) ||
                frozen.genomeSha256 !== selectedGenomeSha256
            ) {
                throw new Error("test seed reveal ref/freeze mismatch");
            }
            return { train: trainPlan, confirm: confirmPlan, final: finalPlan };
        },
        evidence: (summary) => {
            const rows = evidenceRows.get(evidenceKey(summary.panel.panelFingerprint, summary.genomeSha256));
            if (!rows) throw new Error(`test evidence resolver omitted ${summary.evidenceSha256}`);
            return rows;
        },
    };
    return {
        definition,
        trainPlan,
        confirmPlan,
        finalPlan,
        seedArtifacts,
        seedCommitment,
        training,
        confirmation,
        selectedGenomeSha256,
        evidenceRows,
        resolvers,
    };
}

function apply(
    definition: IV07AlignedV2OrchestratorDefinition,
    events: IV07AlignedV2OrchestratorEvent[],
    command: IV07AlignedV2OrchestratorCommand,
): IV07AlignedV2OrchestratorEvent[] {
    return applyV07AlignedV2OrchestratorCommand(definition, events, command).events;
}

function auditFor(record: IV07AlignedV2BattleRecord, genome: IV07AlignedV2CandidateGenome): IV07ComposedAuditRow {
    return {
        t: "game",
        mode: "search",
        seed: record.combatSeed,
        green: record.greenVersion,
        red: record.redVersion,
        winner: record.winner,
        endReason: record.endReason,
        gate: genome.search.gate,
        horizon: genome.search.horizon,
        rollouts: genome.search.rollouts,
        leaf: "learned_v2",
        decisions: 10,
        searched: 10,
        overrides: 1,
        illegalIncumbent: 0,
        shortlist: genome.controls.shortlist,
        decisionDeadlineMs: genome.controls.decisionDeadlineMs,
        deadlineFallbacks: 0,
        lateRangedFinishWeight: genome.controls.lateRangedFinishWeight,
        pureRangedTerminalWeight: genome.controls.pureRangedTerminalWeight,
        msTotal: 100,
        circuitBreakerMs: 275,
        circuitOpened: false,
        circuitSkipped: 0,
    };
}

function shardEvaluation(
    options: {
        runFingerprint?: string;
        genome?: IV07AlignedV2CandidateGenome;
        seedPlan?: IV07AlignedV2InjectedSeedPlan;
    } = {},
): {
    evaluation: IV07AlignedV2ShardEvaluation;
    seedPlan: IV07AlignedV2InjectedSeedPlan;
} {
    const [fallbackGenome] = testGenomes();
    const genome = options.genome ?? fallbackGenome;
    const binding = bindV07AlignedV2Candidate(genome);
    const seedPlan = options.seedPlan ?? syntheticSeedPlan("train", "synthetic-shard", 500_000);
    const shard = buildV07AlignedV2CheckpointShardSpecs({
        runFingerprint: options.runFingerprint ?? "a".repeat(64),
        seedPlan,
        binding,
        maxScenarioPairsPerShard: 12,
    })[0];
    const tasks = flattenV07AlignedV2SeedPlan(seedPlan);
    const records = tasks.map((task): IV07AlignedV2BattleRecord => {
        const candidateIsGreen = task.candidateSeat === "candidate_green";
        return {
            schemaVersion: 1,
            taskKey: v07AlignedV2TaskKey(task),
            panelId: task.panelId,
            cellId: task.cellId,
            scenarioOrdinal: task.scenarioOrdinal,
            scenarioId: task.scenarioId,
            candidateSeat: task.candidateSeat,
            setupSeed: task.setupSeeds[0],
            setupAttempt: 0,
            combatSeed: task.combatSeed,
            candidateIsGreen,
            greenVersion: candidateIsGreen ? "v0.7s" : "v0.6",
            redVersion: candidateIsGreen ? "v0.6" : "v0.7s",
            physicalSetupSha256: "e".repeat(64),
            lowerRoster: "synthetic-lower",
            upperRoster: "synthetic-upper",
            winner: candidateIsGreen ? "green" : "red",
            winnerSlot: "candidate",
            laps: 4,
            endReason: "elimination",
            reachedArmageddon: false,
            decidedByArmageddon: false,
            rejectedGreen: 0,
            rejectedRed: 0,
            resultFingerprint: "f".repeat(64),
        };
    });
    const audits = records.map((record) => auditFor(record, binding.genome));
    const observations = records.map((record, index) => compactV07AlignedV2Observation(record, binding, audits[index]));
    const checkpoint = createV07AlignedV2Checkpoint(shard, observations);
    const sourcePath = "/synthetic/worker-0.audit.jsonl";
    const contents = `${audits.map((row) => canonicalV07AlignedV2Json(row)).join("\n")}\n`;
    const workerEnvironment = buildV07AlignedV2CandidateEnvironment(binding.genome, sourcePath);
    const attestation: IV07AlignedV2WorkerAttestation = {
        workerIndex: 0,
        runFingerprint: shard.runFingerprint,
        genomeSha256: binding.genomeSha256,
        behaviorEnvironmentSha256: binding.behaviorEnvironmentSha256,
        environmentSha256: fingerprintV07AlignedV2(workerEnvironment),
        removedEnvironmentKeys: Object.keys(workerEnvironment).sort(),
        transpilerCacheDisabled: "0",
        auditPath: sourcePath,
    };
    return {
        seedPlan,
        evaluation: {
            shard,
            binding,
            checkpoint,
            records,
            attestations: [attestation],
            auditArtifacts: [
                {
                    workerIndex: 0,
                    sourcePath,
                    taskKeys: records.map((record) => record.taskKey),
                    contents,
                    contentsSha256: sha256(contents),
                    bytes: Buffer.byteLength(contents),
                    rows: audits.length,
                },
            ],
        },
    };
}

function faultAt(target: string): { afterDurableStep(step: string): void } {
    let fired = false;
    return {
        afterDurableStep(step) {
            if (!fired && step === target) {
                fired = true;
                throw new Error(`synthetic fault after ${step}`);
            }
        },
    };
}

describe("v0.7 aligned 96-hour v2 durable restart", () => {
    it("persists exact raw/audit/checkpoint bytes and idempotently reopens a completed shard", () => {
        const root = mkdtempSync(join(tmpdir(), "hoc-v07-aligned-shard-"));
        try {
            const { evaluation, seedPlan } = shardEvaluation();
            const unattested = structuredClone(evaluation);
            unattested.attestations[0].environmentSha256 = "0".repeat(64);
            expect(() => persistV07AlignedV2ShardEvaluation(root, unattested, seedPlan)).toThrow(
                "attestation/audit binding is inconsistent",
            );
            const persisted = persistV07AlignedV2ShardEvaluation(root, evaluation, seedPlan);
            expect(persisted.reused).toBe(false);
            expect(persisted.manifest.files.rawRecords.rows).toBe(24);
            expect(persisted.manifest.audits[0].rows).toBe(24);
            const reopened = loadV07AlignedV2PersistedShard(persisted.directory, {
                shard: evaluation.shard,
                binding: evaluation.binding,
                seedPlan,
            });
            expect(reopened.manifestSha256).toBe(persisted.manifestSha256);
            expect(reopened.evaluation.checkpoint).toEqual(evaluation.checkpoint);
            expect(() =>
                loadV07AlignedV2PersistedShard(persisted.directory, {
                    shard: evaluation.shard,
                    binding: evaluation.binding,
                    seedPlan,
                    manifestSha256: "0".repeat(64),
                }),
            ).toThrow("manifest changed from its exact evidence reference");
            expect(persistV07AlignedV2ShardEvaluation(root, evaluation, seedPlan).reused).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("quarantines abandoned/corrupt shard publications and resumes after every durable boundary", () => {
        const root = mkdtempSync(join(tmpdir(), "hoc-v07-aligned-shard-fault-"));
        const publishedRoot = mkdtempSync(join(tmpdir(), "hoc-v07-aligned-shard-published-"));
        try {
            const { evaluation, seedPlan } = shardEvaluation();
            expect(() =>
                persistV07AlignedV2ShardEvaluation(root, evaluation, seedPlan, faultAt("file:checkpoint.json")),
            ).toThrow("synthetic fault");
            let resumed = persistV07AlignedV2ShardEvaluation(root, evaluation, seedPlan);
            expect(resumed.reused).toBe(false);
            expect(readdirSync(root).some((name) => name.includes(".abandoned-"))).toBe(true);

            expect(() =>
                persistV07AlignedV2ShardEvaluation(publishedRoot, evaluation, seedPlan, faultAt("directory_published")),
            ).toThrow("synthetic fault");
            expect(persistV07AlignedV2ShardEvaluation(publishedRoot, evaluation, seedPlan).reused).toBe(true);

            const malformedBytes = readFileSync(join(resumed.directory, resumed.manifest.files.rawRecords.path));
            malformedBytes[0] = 0xff;
            writeFileSync(join(resumed.directory, resumed.manifest.files.rawRecords.path), malformedBytes);
            expect(() =>
                loadV07AlignedV2PersistedShard(resumed.directory, {
                    shard: evaluation.shard,
                    binding: evaluation.binding,
                    seedPlan,
                }),
            ).toThrow("is not valid UTF-8");
            resumed = persistV07AlignedV2ShardEvaluation(root, evaluation, seedPlan);

            writeFileSync(join(resumed.directory, resumed.manifest.files.rawRecords.path), "{}\n");
            expect(() =>
                loadV07AlignedV2PersistedShard(resumed.directory, {
                    shard: evaluation.shard,
                    binding: evaluation.binding,
                    seedPlan,
                }),
            ).toThrow("hash mismatch");
            const rebuilt = persistV07AlignedV2ShardEvaluation(root, evaluation, seedPlan);
            expect(rebuilt.reused).toBe(false);
            expect(readdirSync(root).some((name) => name.includes(".corrupt-"))).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
            rmSync(publishedRoot, { recursive: true, force: true });
        }
    });

    it("rebuilds orchestration evidence only from the exact referenced persisted shard set", () => {
        const root = mkdtempSync(join(tmpdir(), "hoc-v07-aligned-fs-resolver-"));
        try {
            const fixture = orchestrationFixture();
            const candidate = fixture.definition.candidates.find(
                (entry) => entry.genomeSha256 === fixture.selectedGenomeSha256,
            )!;
            const { evaluation, seedPlan } = shardEvaluation({
                runFingerprint: fixture.definition.definitionSha256,
                genome: candidate.genome,
                seedPlan: fixture.trainPlan,
            });
            const persisted = persistV07AlignedV2ShardEvaluation(join(root, "evidence"), evaluation, seedPlan);
            const evidenceInput: IV07AlignedV2PanelEvidenceInput = {
                panel: fixture.definition.panels.train,
                genomeSha256: candidate.genomeSha256,
                artifacts: [
                    {
                        directory: `evidence/${basename(persisted.directory)}`,
                        manifestSha256: persisted.manifestSha256,
                    },
                ],
                observations: evaluation.checkpoint.observations,
            };
            const result = applyV07AlignedV2OrchestratorCommand(fixture.definition, [], {
                type: "record_train",
                commandId: "filesystem-evidence",
                nowMs: fixture.definition.schedule.startAtMs + 1,
                candidateGenomeSha256: candidate.genomeSha256,
                evidence: evidenceInput,
            });
            const filesystemEvidence = createV07AlignedV2FilesystemEvidenceResolver({
                artifactRoot: root,
                definition: fixture.definition,
                resolveSeedPlan: () => fixture.trainPlan,
            });
            expect(() =>
                deriveV07AlignedV2OrchestratorState(fixture.definition, result.events, {
                    seedCommitment: fixture.resolvers.seedCommitment,
                    evidence: filesystemEvidence,
                }),
            ).not.toThrow();

            writeFileSync(
                join(persisted.directory, persisted.manifest.files.rawRecords.path),
                `${canonicalV07AlignedV2Json(evaluation.records[0])}\n`,
            );
            expect(() =>
                deriveV07AlignedV2OrchestratorState(fixture.definition, result.events, {
                    seedCommitment: fixture.resolvers.seedCommitment,
                    evidence: filesystemEvidence,
                }),
            ).toThrow("byte/hash mismatch");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("freezes the deterministic max-min candidate, reveals seeds only afterward, and terminates research-only", () => {
        const fixture = orchestrationFixture();
        const { definition } = fixture;
        let events: IV07AlignedV2OrchestratorEvent[] = [];
        const start = definition.schedule.startAtMs;
        expect(() =>
            applyV07AlignedV2OrchestratorCommand(definition, events, {
                type: "reveal_final_plan",
                commandId: "too-early-reveal",
                nowMs: start + 1,
                trainSeedPlan: fixture.trainPlan,
                confirmSeedPlan: fixture.confirmPlan,
                finalSeedPlan: fixture.finalPlan,
                seedArtifacts: fixture.seedArtifacts,
            }),
        ).toThrow("before immutable candidate freeze");

        const firstTrain: IV07AlignedV2OrchestratorCommand = {
            type: "record_train",
            commandId: "train-other",
            nowMs: start + 2,
            candidateGenomeSha256: fixture.training[0].genomeSha256,
            evidence: fixture.training[0],
        };
        events = apply(definition, events, firstTrain);
        events = apply(definition, events, {
            type: "record_train",
            commandId: "train-selected",
            nowMs: start + 3,
            candidateGenomeSha256: fixture.training[1].genomeSha256,
            evidence: fixture.training[1],
        });
        events = apply(definition, events, {
            type: "freeze_candidate",
            commandId: "freeze",
            nowMs: start + 4,
        });
        let state = deriveV07AlignedV2OrchestratorState(definition, events, fixture.resolvers);
        expect(state.frozen).toMatchObject({
            genomeSha256: fixture.selectedGenomeSha256,
            reason: "all_candidates_complete",
        });
        expect(state.frozen?.freezeArtifactSha256).toMatch(/^[0-9a-f]{64}$/);

        const reused = applyV07AlignedV2OrchestratorCommand(definition, events, firstTrain);
        expect(reused.reused).toBe(true);
        expect(reused.appended).toBeNull();
        expect(() =>
            applyV07AlignedV2OrchestratorCommand(definition, events, { ...firstTrain, nowMs: start + 9 }),
        ).toThrow("commandId was reused with new content");

        const wrongFinal = structuredClone(fixture.finalPlan);
        wrongFinal.pairs[0].seats.candidate_green.combatSeed += 1_000_000;
        expect(() =>
            applyV07AlignedV2OrchestratorCommand(definition, events, {
                type: "reveal_final_plan",
                commandId: "wrong-reveal",
                nowMs: start + 5,
                trainSeedPlan: fixture.trainPlan,
                confirmSeedPlan: fixture.confirmPlan,
                finalSeedPlan: wrongFinal,
                seedArtifacts: fixture.seedArtifacts,
            }),
        ).toThrow("does not open all precommitted panels");
        events = apply(definition, events, {
            type: "reveal_final_plan",
            commandId: "reveal",
            nowMs: start + 5,
            trainSeedPlan: fixture.trainPlan,
            confirmSeedPlan: fixture.confirmPlan,
            finalSeedPlan: fixture.finalPlan,
            seedArtifacts: fixture.seedArtifacts,
        });

        const orderSensitiveConfirmation = structuredClone(fixture.confirmation);
        for (const input of [orderSensitiveConfirmation.challenger, orderSensitiveConfirmation.incumbent]) {
            input.observations.forEach((row, index) => {
                row.searchAudit!.msTotal = index === 0 ? 1e16 : index < 3 ? 1 : 0;
            });
        }
        const canonicalConfirmation = applyV07AlignedV2OrchestratorCommand(definition, events, {
            type: "record_confirmation",
            commandId: "confirm-canonical-order",
            nowMs: start + 6,
            ...orderSensitiveConfirmation,
        }).appended!;
        const reversedConfirmation = applyV07AlignedV2OrchestratorCommand(definition, events, {
            type: "record_confirmation",
            commandId: "confirm-reversed-order",
            nowMs: start + 6,
            challenger: {
                ...orderSensitiveConfirmation.challenger,
                observations: [...orderSensitiveConfirmation.challenger.observations].reverse(),
            },
            incumbent: {
                ...orderSensitiveConfirmation.incumbent,
                observations: [...orderSensitiveConfirmation.incumbent.observations].reverse(),
            },
        }).appended!;
        if (
            canonicalConfirmation.eventType !== "confirmation_recorded" ||
            reversedConfirmation.eventType !== "confirmation_recorded"
        ) {
            throw new Error("test expected confirmation transitions");
        }
        expect(reversedConfirmation.payload).toEqual(canonicalConfirmation.payload);

        const promotedConfirmation = structuredClone(canonicalConfirmation);
        promotedConfirmation.payload.promotion.verdict = "PROMOTE";
        promotedConfirmation.payload.promotion.reasons = [];
        promotedConfirmation.payload.terminal = null;
        const promotedUnsigned = { ...promotedConfirmation };
        delete (promotedUnsigned as Partial<typeof promotedConfirmation>).eventSha256;
        promotedConfirmation.eventSha256 = fingerprintV07AlignedV2(promotedUnsigned);
        const finalReadyEvents = [...events, promotedConfirmation];
        expect(deriveV07AlignedV2OrchestratorState(definition, finalReadyEvents).phase).toBe("final");
        const finalRows = observations("candidate_win");
        finalRows.forEach((row, index) => {
            row.searchAudit!.msTotal = index === 0 ? 1e16 : index < 3 ? 1 : 0;
        });
        const finalEvidence = evidence(
            definition.panels.finalCommitment,
            fixture.selectedGenomeSha256,
            finalRows,
            "final-order",
        );
        const canonicalFinal = applyV07AlignedV2OrchestratorCommand(definition, finalReadyEvents, {
            type: "record_final",
            commandId: "final-canonical-order",
            nowMs: start + 7,
            evidence: finalEvidence,
        }).appended!;
        const reversedFinal = applyV07AlignedV2OrchestratorCommand(definition, finalReadyEvents, {
            type: "record_final",
            commandId: "final-reversed-order",
            nowMs: start + 7,
            evidence: { ...finalEvidence, observations: [...finalEvidence.observations].reverse() },
        }).appended!;
        if (canonicalFinal.eventType !== "final_recorded" || reversedFinal.eventType !== "final_recorded") {
            throw new Error("test expected final transitions");
        }
        expect(reversedFinal.payload).toEqual(canonicalFinal.payload);

        events = apply(definition, events, {
            type: "record_confirmation",
            commandId: "confirm",
            nowMs: start + 6,
            ...fixture.confirmation,
        });
        state = deriveV07AlignedV2OrchestratorState(definition, events, fixture.resolvers);
        expect(state).toMatchObject({
            phase: "terminal",
            finalPlanRevealed: true,
            terminal: {
                status: "research_only_no_bake",
                automaticBake: false,
                automaticDeploy: false,
                reason: "confirm_hold",
                verdict: "HOLD",
            },
        });

        const key = evidenceKey(definition.panels.train.panelFingerprint, fixture.selectedGenomeSha256);
        const original = fixture.evidenceRows.get(key)!;
        fixture.evidenceRows.set(key, [{ ...original[0], outcome: "opponent_win" }, ...original.slice(1)]);
        expect(() => deriveV07AlignedV2OrchestratorState(definition, events, fixture.resolvers)).toThrow(
            "does not replay exactly",
        );
    });

    it("enforces immutable phase deadlines without allocating extra candidates or seeds", () => {
        const fixture = orchestrationFixture();
        const { definition } = fixture;
        let events: IV07AlignedV2OrchestratorEvent[] = [];
        events = apply(definition, events, {
            type: "record_train",
            commandId: "partial-train",
            nowMs: definition.schedule.startAtMs + 1,
            candidateGenomeSha256: fixture.training[1].genomeSha256,
            evidence: fixture.training[1],
        });
        events = apply(definition, events, {
            type: "tick",
            commandId: "train-deadline",
            nowMs: definition.schedule.trainDeadlineAtMs,
        });
        expect(deriveV07AlignedV2OrchestratorState(definition, events).terminal).toMatchObject({
            frozenCandidateSha256: null,
            reason: "train_catalog_incomplete",
            verdict: "INCOMPLETE",
        });

        const terminalEvents = apply(definition, [], {
            type: "tick",
            commandId: "late-first-tick",
            nowMs: definition.schedule.confirmDeadlineAtMs,
        });
        expect(deriveV07AlignedV2OrchestratorState(definition, terminalEvents).terminal).toMatchObject({
            reason: "train_deadline_after_confirm_cutoff",
            verdict: "INCOMPLETE",
        });
    });

    it("rejects rehashed deadline bypasses, premature terminals, and noncanonical evidence references", () => {
        const fixture = orchestrationFixture();
        const { definition } = fixture;
        expect(() =>
            deriveV07AlignedV2OrchestratorState(definition, [], {
                seedCommitment: (artifact) => {
                    const resolved = fixture.resolvers.seedCommitment!(artifact);
                    return {
                        ...resolved,
                        final: { ...resolved.final, panelFingerprint: "0".repeat(64) },
                    };
                },
            }),
        ).toThrow("does not replay all panel commitments exactly");
        let events: IV07AlignedV2OrchestratorEvent[] = [];
        events = apply(definition, events, {
            type: "record_train",
            commandId: "tamper-train-other",
            nowMs: definition.schedule.startAtMs + 1,
            candidateGenomeSha256: fixture.training[0].genomeSha256,
            evidence: fixture.training[0],
        });
        events = apply(definition, events, {
            type: "record_train",
            commandId: "tamper-train-selected",
            nowMs: definition.schedule.startAtMs + 2,
            candidateGenomeSha256: fixture.training[1].genomeSha256,
            evidence: fixture.training[1],
        });
        events = apply(definition, events, {
            type: "freeze_candidate",
            commandId: "tamper-freeze",
            nowMs: definition.schedule.startAtMs + 3,
        });
        const lateFreeze = structuredClone(events.at(-1)!);
        if (lateFreeze.eventType !== "candidate_frozen") throw new Error("test expected a candidate freeze");
        lateFreeze.nowMs = definition.schedule.trainDeadlineAtMs;
        lateFreeze.payload.frozen.frozenAtMs = lateFreeze.nowMs;
        const frozenUnsigned = { ...lateFreeze.payload.frozen };
        delete (frozenUnsigned as Partial<typeof lateFreeze.payload.frozen>).freezeArtifactSha256;
        lateFreeze.payload.frozen.freezeArtifactSha256 = fingerprintV07AlignedV2(frozenUnsigned);
        const lateFreezeUnsigned = { ...lateFreeze };
        delete (lateFreezeUnsigned as Partial<typeof lateFreeze>).eventSha256;
        lateFreeze.eventSha256 = fingerprintV07AlignedV2(lateFreezeUnsigned);
        expect(() => deriveV07AlignedV2OrchestratorState(definition, [...events.slice(0, -1), lateFreeze])).toThrow(
            "deterministic eligible max-min selection",
        );

        const noEligible = applyV07AlignedV2OrchestratorCommand(definition, [], {
            type: "tick",
            commandId: "valid-no-eligible-deadline",
            nowMs: definition.schedule.trainDeadlineAtMs,
        }).appended!;
        const premature = structuredClone(noEligible);
        premature.nowMs = definition.schedule.startAtMs + 1;
        const prematureUnsigned = { ...premature };
        delete (prematureUnsigned as Partial<typeof premature>).eventSha256;
        premature.eventSha256 = fingerprintV07AlignedV2(prematureUnsigned);
        expect(() => deriveV07AlignedV2OrchestratorState(definition, [premature])).toThrow(
            "duplicated or illegal for its phase/deadline",
        );

        const evidenceInput = structuredClone(fixture.training[1]);
        evidenceInput.artifacts = [
            { directory: "synthetic/z-shard", manifestSha256: "a".repeat(64) },
            { directory: "synthetic/a-shard", manifestSha256: "b".repeat(64) },
        ];
        const evidenceEvent = applyV07AlignedV2OrchestratorCommand(definition, [], {
            type: "record_train",
            commandId: "canonical-artifacts",
            nowMs: definition.schedule.startAtMs + 1,
            candidateGenomeSha256: evidenceInput.genomeSha256,
            evidence: evidenceInput,
        }).appended!;
        if (evidenceEvent.eventType !== "train_recorded") throw new Error("test expected training evidence");
        const reverseOrderEvent = applyV07AlignedV2OrchestratorCommand(definition, [], {
            type: "record_train",
            commandId: "canonical-observation-order",
            nowMs: definition.schedule.startAtMs + 1,
            candidateGenomeSha256: evidenceInput.genomeSha256,
            evidence: { ...evidenceInput, observations: [...evidenceInput.observations].reverse() },
        }).appended!;
        if (reverseOrderEvent.eventType !== "train_recorded") throw new Error("test expected training evidence");
        expect(reverseOrderEvent.payload.evidence).toEqual(evidenceEvent.payload.evidence);
        const noncanonical = structuredClone(evidenceEvent);
        noncanonical.payload.evidence.artifacts.reverse();
        const evidenceUnsigned = { ...noncanonical.payload.evidence };
        delete (evidenceUnsigned as Partial<typeof noncanonical.payload.evidence>).evidenceSha256;
        noncanonical.payload.evidence.evidenceSha256 = fingerprintV07AlignedV2(evidenceUnsigned);
        const noncanonicalUnsigned = { ...noncanonical };
        delete (noncanonicalUnsigned as Partial<typeof noncanonical>).eventSha256;
        noncanonical.eventSha256 = fingerprintV07AlignedV2(noncanonicalUnsigned);
        expect(() => deriveV07AlignedV2OrchestratorState(definition, [noncanonical])).toThrow(
            "artifact references are not in canonical order",
        );
    });

    it("repairs a stale CURRENT after transition publication and derives an immutable terminal artifact", () => {
        const root = mkdtempSync(join(tmpdir(), "hoc-v07-aligned-ledger-parent-"));
        const directory = join(root, "orchestrator");
        try {
            const fixture = orchestrationFixture();
            let ledger = initializeV07AlignedV2OrchestratorPersistence(
                directory,
                fixture.definition,
                fixture.resolvers,
            );
            expect(ledger.reused).toBe(false);
            const firstResult = applyV07AlignedV2OrchestratorCommand(fixture.definition, ledger.events, {
                type: "record_train",
                commandId: "ledger-train-other",
                nowMs: fixture.definition.schedule.startAtMs + 1,
                candidateGenomeSha256: fixture.training[0].genomeSha256,
                evidence: fixture.training[0],
            });
            expect(() =>
                appendV07AlignedV2OrchestratorEvent(
                    directory,
                    fixture.definition,
                    firstResult.appended!,
                    fixture.resolvers,
                    faultAt("transition_published"),
                ),
            ).toThrow("synthetic fault");
            ledger = loadV07AlignedV2PersistedOrchestrator(directory, fixture.resolvers, fixture.definition);
            expect(ledger.current.nextSequence).toBe(1);
            expect(ledger.current.eventHeadSha256).toBe(firstResult.appended!.eventSha256);
            expect(
                appendV07AlignedV2OrchestratorEvent(
                    directory,
                    fixture.definition,
                    firstResult.appended!,
                    fixture.resolvers,
                ).reused,
            ).toBe(true);

            const appendCommand = (command: IV07AlignedV2OrchestratorCommand): void => {
                const result = applyV07AlignedV2OrchestratorCommand(fixture.definition, ledger.events, command);
                ledger = appendV07AlignedV2OrchestratorEvent(
                    directory,
                    fixture.definition,
                    result.appended!,
                    fixture.resolvers,
                );
            };
            appendCommand({
                type: "record_train",
                commandId: "ledger-train-selected",
                nowMs: fixture.definition.schedule.startAtMs + 2,
                candidateGenomeSha256: fixture.training[1].genomeSha256,
                evidence: fixture.training[1],
            });
            appendCommand({
                type: "freeze_candidate",
                commandId: "ledger-freeze",
                nowMs: fixture.definition.schedule.startAtMs + 3,
            });
            appendCommand({
                type: "reveal_final_plan",
                commandId: "ledger-reveal",
                nowMs: fixture.definition.schedule.startAtMs + 4,
                trainSeedPlan: fixture.trainPlan,
                confirmSeedPlan: fixture.confirmPlan,
                finalSeedPlan: fixture.finalPlan,
                seedArtifacts: fixture.seedArtifacts,
            });
            const confirmation = applyV07AlignedV2OrchestratorCommand(fixture.definition, ledger.events, {
                type: "record_confirmation",
                commandId: "ledger-confirm",
                nowMs: fixture.definition.schedule.startAtMs + 5,
                ...fixture.confirmation,
            });
            expect(() =>
                appendV07AlignedV2OrchestratorEvent(
                    directory,
                    fixture.definition,
                    confirmation.appended!,
                    fixture.resolvers,
                    faultAt("current_published"),
                ),
            ).toThrow("synthetic fault");
            expect(existsSync(join(directory, "TERMINAL.json"))).toBe(false);
            ledger = loadV07AlignedV2PersistedOrchestrator(directory, fixture.resolvers, fixture.definition);
            expect(ledger.state.phase).toBe("terminal");
            expect(ledger.terminalPath).toBe(join(directory, "TERMINAL.json"));
            expect(JSON.parse(readFileSync(ledger.terminalPath!, "utf8"))).toEqual(ledger.state.terminal);
            expect(validateV07AlignedV2TerminalReplay(directory, fixture.definition, fixture.resolvers)).toEqual(
                ledger.state.terminal,
            );
            expect(() => validateV07AlignedV2TerminalReplay(directory, fixture.definition, {})).toThrow(
                "terminal replay requires exact",
            );

            const currentPath = join(directory, "CURRENT");
            const validCurrent = JSON.parse(readFileSync(currentPath, "utf8")) as IV07AlignedV2OrchestratorCurrent;
            const aheadUnsigned = { ...validCurrent, nextSequence: validCurrent.nextSequence + 1 };
            delete (aheadUnsigned as Partial<IV07AlignedV2OrchestratorCurrent>).currentSha256;
            const ahead = { ...aheadUnsigned, currentSha256: fingerprintV07AlignedV2(aheadUnsigned) };
            writeFileSync(currentPath, canonicalFile(ahead));
            expect(() =>
                loadV07AlignedV2PersistedOrchestrator(directory, fixture.resolvers, fixture.definition),
            ).toThrow("points ahead");
            writeFileSync(currentPath, canonicalFile(validCurrent));

            const firstTransition = readdirSync(join(directory, "transitions")).sort()[0];
            const duplicateName = `000000-${"0".repeat(64)}.json`;
            writeFileSync(
                join(directory, "transitions", duplicateName),
                readFileSync(join(directory, "transitions", firstTransition), "utf8"),
            );
            expect(() =>
                loadV07AlignedV2PersistedOrchestrator(directory, fixture.resolvers, fixture.definition),
            ).toThrow();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("runs the finite orchestration dry-run with no games, workers, or generated seed material", () => {
        const fixture = orchestrationFixture();
        const report = runV07AlignedV2SyntheticOrchestrationDryRun({
            definition: {
                mode: fixture.definition.mode,
                runId: fixture.definition.runId,
                createdAtMs: fixture.definition.createdAtMs,
                composedSealSha256: fixture.definition.composedSealSha256,
                candidateLimit: fixture.definition.candidateLimit,
                schedule: fixture.definition.schedule,
                candidateGenomes: fixture.definition.candidates.map((candidate) => candidate.genome),
                incumbentGenome: fixture.definition.incumbent.genome,
                trainSeedPlan: fixture.trainPlan,
                confirmSeedPlan: fixture.confirmPlan,
                finalPanelCommitment: fixture.definition.panels.finalCommitment,
                seedCommitment: fixture.seedCommitment,
            },
            trainingEvidence: fixture.training.map((entry) => ({
                candidateGenomeSha256: entry.genomeSha256,
                evidence: entry,
            })),
            seedReveal: {
                trainSeedPlan: fixture.trainPlan,
                confirmSeedPlan: fixture.confirmPlan,
                finalSeedPlan: fixture.finalPlan,
                seedArtifacts: fixture.seedArtifacts,
            },
            confirmation: fixture.confirmation,
        });
        expect(report).toMatchObject({
            mode: "synthetic_dry_run",
            status: "research_only_no_bake",
            automaticBake: false,
            automaticDeploy: false,
            gamesExecuted: 0,
            workersStarted: 0,
            seedMaterialGenerated: false,
            injectedSeedPlansOnly: true,
            outcomeDrivenSeedAllocation: false,
            verdict: "HOLD",
        });
        expect(report.reportSha256).toMatch(/^[0-9a-f]{64}$/);
    });
});
