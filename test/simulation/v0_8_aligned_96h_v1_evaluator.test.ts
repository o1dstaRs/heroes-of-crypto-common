/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { IMatchConfig, IMatchResult } from "../../src/simulation/battle_engine";
import type { IV07ComposedAuditRow } from "../../src/simulation/v0_7_composed_ranked_ladder";
import {
    evaluateV07AlignedV2Shard,
    validateAligned96hWorkerAttestation,
} from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_evaluator";
import {
    compactV07AlignedV2Observation,
    playV07AlignedV2Task,
    type IAligned96hBattleRecord,
} from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_game_adapter";
import {
    V07_ALIGNED_V2_EVALUATOR_CELLS,
    buildAligned96hCheckpointShardSpecs,
    flattenV07AlignedV2SeedPlan,
    type IV07AlignedV2InjectedSeedPlan,
} from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_protocol";
import { buildV08AlignedV1ProductionIncumbentGenome } from "../../src/simulation/optimizer/v0_8_aligned_96h_v1_catalog";
import {
    bindV08AlignedV1Candidate,
    type IV08AlignedV1CandidateBinding,
} from "../../src/simulation/optimizer/v0_8_aligned_96h_v1_protocol";

function legacyGeometrySeedPlan(): IV07AlignedV2InjectedSeedPlan {
    let nextSeed = 70_000;
    const take = (): number => nextSeed++;
    return {
        schemaVersion: 1,
        panelId: "v0.8-real-both-seat-smoke",
        purpose: "train",
        scenariosPerCell: 1,
        denysetSha256: "a".repeat(64),
        pairs: V07_ALIGNED_V2_EVALUATOR_CELLS.map((cell) => {
            if (cell.distribution === "fixed_template") {
                const setupSeeds = [take()];
                const combatSeed = take();
                return {
                    cellId: cell.id,
                    scenarioOrdinal: 0,
                    scenarioId: "scenario-0",
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
                scenarioId: "scenario-0",
                seats: { candidate_green: stream(), candidate_red: stream() },
            };
        }),
    };
}

function searchOffBinding(): IV08AlignedV1CandidateBinding {
    const genome = buildV08AlignedV1ProductionIncumbentGenome();
    genome.search.leafMode = "off";
    genome.search.leaf = undefined;
    return bindV08AlignedV1Candidate(genome);
}

function fakeResult(config: IMatchConfig): IMatchResult {
    return {
        seed: config.seed,
        gridType: config.gridType ?? PBTypes.GridVals.NORMAL,
        winner: "green",
        endReason: "elimination",
        laps: 4,
        totalActions: 0,
        roster: config.roster,
        redRoster: config.redRoster,
        placements: { green: [], red: [] },
        actions: [],
        outcome: {
            green: { version: config.greenVersion, unitsAlive: 6, creaturesAlive: 6, hpRemaining: 100 },
            red: { version: config.redVersion, unitsAlive: 0, creaturesAlive: 0, hpRemaining: 0 },
        },
        attrition: {
            reachedArmageddon: false,
            armageddonWaves: 0,
            unitsKilledByArmageddon: 0,
            unitsKilledByNarrowing: 0,
            decidedByArmageddon: false,
        },
        rejectedGreen: 0,
        rejectedRed: 0,
        rejectedDetails: [],
        greenArtifactT1: config.greenArtifactT1 ?? 0,
        redArtifactT1: config.redArtifactT1 ?? 0,
        greenArtifactT2: config.greenArtifactT2 ?? 0,
        redArtifactT2: config.redArtifactT2 ?? 0,
    };
}

function auditFor(
    record: IAligned96hBattleRecord<IV08AlignedV1CandidateBinding>,
    binding: IV08AlignedV1CandidateBinding,
): IV07ComposedAuditRow {
    return {
        t: "game",
        mode: "search",
        seed: record.combatSeed,
        green: record.greenVersion,
        red: record.redVersion,
        winner: record.winner,
        endReason: record.endReason,
        gate: binding.genome.search.gate,
        horizon: binding.genome.search.horizon,
        rollouts: binding.genome.search.rollouts,
        leaf: binding.genome.search.leafMode === "model" ? "learned_v2" : "material",
        decisions: 1,
        searched: 1,
        overrides: 0,
        illegalIncumbent: 0,
        shortlist: binding.genome.controls.shortlist,
        decisionDeadlineMs: binding.genome.controls.decisionDeadlineMs,
        deadlineFallbacks: 0,
        lateRangedFinishWeight: binding.genome.controls.lateRangedFinishWeight,
        pureRangedTerminalWeight: binding.genome.controls.pureRangedTerminalWeight,
        msTotal: 1,
        circuitBreakerMs: 275,
        circuitOpened: false,
        circuitSkipped: 0,
    };
}

describe("v0.8 aligned 96-hour v1 production evaluator bridge", () => {
    it("runs one real fixed matchup in both seats through the shared production shard worker", async () => {
        const directory = mkdtempSync(join(tmpdir(), "hoc-v08-aligned-real-smoke-"));
        const seedPlan = legacyGeometrySeedPlan();
        const binding = searchOffBinding();
        const shards = buildAligned96hCheckpointShardSpecs({
            runFingerprint: "b".repeat(64),
            seedPlan,
            binding,
            maxScenarioPairsPerShard: 1,
        });
        const shard = shards.find((candidate) => candidate.tasks[0]?.cellId === "fixed_mage_frontline");
        expect(shard?.tasks.map((task) => task.candidateSeat)).toEqual(["candidate_green", "candidate_red"]);

        try {
            const evaluation = await evaluateV07AlignedV2Shard({
                shard: shard!,
                seedPlan,
                binding,
                workers: 1,
                auditDirectory: join(directory, "audit"),
            });

            expect(evaluation.records.map(({ greenVersion, redVersion }) => [greenVersion, redVersion])).toEqual([
                ["v0.8s", "v0.7"],
                ["v0.7", "v0.8s"],
            ]);
            expect(evaluation.records.map((record) => record.candidateSeat)).toEqual([
                "candidate_green",
                "candidate_red",
            ]);
            expect(evaluation.records[0].physicalSetupSha256).toBe(evaluation.records[1].physicalSetupSha256);
            expect(evaluation.records.every((record) => !("artifactKind" in record))).toBe(true);
            expect(evaluation.checkpoint.observations).toHaveLength(2);
            expect(evaluation.auditArtifacts).toHaveLength(1);
            expect(evaluation.auditArtifacts[0].rows).toBe(0);
            expect(evaluation.attestations).toHaveLength(1);
            expect(validateAligned96hWorkerAttestation(binding, evaluation.attestations[0])).toMatchObject({
                artifactKind: "v0_8_aligned_96h_v1_worker_attestation",
                versionProfile: { candidate: "v0.8s", candidateBase: "v0.8", opponent: "v0.7" },
            });
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    }, 60_000);

    it("rejects v0.7 audit versions and a relabeled v0.8 binding before execution", async () => {
        const seedPlan = legacyGeometrySeedPlan();
        const task = flattenV07AlignedV2SeedPlan(seedPlan).find(
            (candidate) => candidate.cellId === "fixed_mage_frontline" && candidate.candidateSeat === "candidate_green",
        )!;
        const binding = bindV08AlignedV1Candidate(buildV08AlignedV1ProductionIncumbentGenome());
        const record = playV07AlignedV2Task(task, { matchRunner: fakeResult }, binding);
        const audit = auditFor(record, binding);

        expect(() => compactV07AlignedV2Observation(record, binding, audit)).not.toThrow();
        expect(() =>
            compactV07AlignedV2Observation(record, binding, {
                ...audit,
                green: "v0.7s",
                red: "v0.6",
            }),
        ).toThrow("search audit does not match the candidate binding");

        const searchOff = searchOffBinding();
        const shard = buildAligned96hCheckpointShardSpecs({
            runFingerprint: "c".repeat(64),
            seedPlan,
            binding: searchOff,
            maxScenarioPairsPerShard: 1,
        })[4];
        const relabeled = structuredClone(searchOff) as IV08AlignedV1CandidateBinding;
        (relabeled as unknown as { opponent: string }).opponent = "v0.6";
        expect(() => playV07AlignedV2Task(task, { matchRunner: fakeResult }, relabeled)).toThrow(
            "candidate binding does not match its canonical genome and version profile",
        );
        expect(() => compactV07AlignedV2Observation(record, relabeled, audit)).toThrow(
            "candidate binding does not match its canonical genome and version profile",
        );
        const unknownProfile = structuredClone(searchOff) as IV08AlignedV1CandidateBinding;
        (unknownProfile as unknown as { candidate: string }).candidate = "v9";
        expect(() => playV07AlignedV2Task(task, { matchRunner: fakeResult }, unknownProfile)).toThrow(
            "unsupported aligned game-adapter candidate v9",
        );
        let workersStarted = 0;
        await expect(
            evaluateV07AlignedV2Shard({
                shard,
                seedPlan,
                binding: relabeled,
                workers: 1,
                auditDirectory: join(tmpdir(), "hoc-v08-aligned-must-not-start"),
                onWorkerStarted: () => {
                    workersStarted += 1;
                },
            }),
        ).rejects.toThrow("candidate binding does not match its canonical genome and version profile");
        expect(workersStarted).toBe(0);
    });
});
