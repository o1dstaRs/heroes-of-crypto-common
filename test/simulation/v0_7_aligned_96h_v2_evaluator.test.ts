/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { IMatchConfig, IMatchResult } from "../../src/simulation/battle_engine";
import { creatureIdForName } from "../../src/simulation/draft";
import type { IConditionalArmy } from "../../src/simulation/measure_setup_conditional";
import { v07ArchetypeTemplate } from "../../src/simulation/v0_7_archetype_battery";
import type { IV07ComposedAuditRow } from "../../src/simulation/v0_7_composed_ranked_ladder";
import {
    evaluateV07AlignedV2Shard,
    parseV07AlignedV2PreflightArgs,
    preflightV07AlignedV2,
    snapshotV07AlignedV2ShardEvaluationOptions,
} from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_evaluator";
import {
    compactV07AlignedV2Observation,
    playV07AlignedV2Task,
    readV07AlignedV2AuditAppend,
    type IV07AlignedV2BattleRecord,
} from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_game_adapter";
import { buildV07AlignedV2ProductionIncumbentGenome } from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_catalog";
import {
    bindV07AlignedV2Candidate,
    buildV07AlignedV2CandidateEnvironment,
    buildV07AlignedV2CheckpointShardSpecs,
    createV07AlignedV2Checkpoint,
    evaluatorCellV07AlignedV2,
    fingerprintV07AlignedV2,
    flattenV07AlignedV2SeedPlan,
    validateV07AlignedV2CandidateBinding,
    validateV07AlignedV2Checkpoint,
    validateV07AlignedV2CheckpointShardSpec,
    validateV07AlignedV2SeedPlan,
    verifyV07AlignedV2WorkerEnvironment,
    v07AlignedV2TaskIdentity,
    V07_ALIGNED_V2_EVALUATOR_CELLS,
    type IV07AlignedV2CandidateGenome,
    type IV07AlignedV2InjectedSeedPlan,
} from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_protocol";

const modelGenome = (): IV07AlignedV2CandidateGenome => buildV07AlignedV2ProductionIncumbentGenome();

const syntheticSeedPlan = (): IV07AlignedV2InjectedSeedPlan => {
    let nextSeed = 10_000;
    const take = (): number => nextSeed++;
    return {
        schemaVersion: 1,
        panelId: "test-only-synthetic-panel",
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
};

function fakeResult(
    config: IMatchConfig,
    winner: "green" | "red" | "draw" = "green",
    rejectedGreen = 0,
    rejectedRed = 0,
): IMatchResult {
    return {
        seed: config.seed,
        gridType: config.gridType ?? PBTypes.GridVals.NORMAL,
        winner,
        endReason: "elimination",
        laps: 4,
        totalActions: 0,
        roster: config.roster,
        redRoster: config.redRoster,
        placements: { green: [], red: [] },
        actions: [],
        outcome: {
            green: {
                version: config.greenVersion,
                unitsAlive: winner === "red" ? 0 : 6,
                creaturesAlive: winner === "red" ? 0 : 6,
                hpRemaining: winner === "red" ? 0 : 100,
            },
            red: {
                version: config.redVersion,
                unitsAlive: winner === "green" ? 0 : 6,
                creaturesAlive: winner === "green" ? 0 : 6,
                hpRemaining: winner === "green" ? 0 : 100,
            },
        },
        attrition: {
            reachedArmageddon: false,
            armageddonWaves: 0,
            unitsKilledByArmageddon: 0,
            unitsKilledByNarrowing: 0,
            decidedByArmageddon: false,
        },
        rejectedGreen,
        rejectedRed,
        rejectedDetails: [],
        greenArtifactT1: config.greenArtifactT1 ?? 0,
        redArtifactT1: config.redArtifactT1 ?? 0,
        greenArtifactT2: config.greenArtifactT2 ?? 0,
        redArtifactT2: config.redArtifactT2 ?? 0,
    };
}

const auditFor = (
    record: IV07AlignedV2BattleRecord,
    overrides: Partial<IV07ComposedAuditRow> = {},
): IV07ComposedAuditRow => ({
    t: "game",
    mode: "search",
    seed: record.combatSeed,
    green: record.greenVersion,
    red: record.redVersion,
    winner: record.winner,
    endReason: record.endReason,
    gate: 0.01,
    horizon: 12,
    rollouts: 3,
    leaf: "learned_v2",
    decisions: 10,
    searched: 10,
    overrides: 2,
    illegalIncumbent: 0,
    shortlist: null,
    decisionDeadlineMs: 200,
    deadlineFallbacks: 0,
    lateRangedFinishWeight: 0,
    pureRangedTerminalWeight: 0,
    msTotal: 1000,
    circuitBreakerMs: 275,
    circuitOpened: false,
    circuitSkipped: 0,
    ...overrides,
});

function army(templateName: "mage_frontline" | "ranged_precision"): IConditionalArmy {
    const template = v07ArchetypeTemplate(templateName);
    return {
        creatureIds: template.roster.map((unit) => creatureIdForName(unit.creatureName)),
        revealedOpponentCreatures: [],
        roster: template.roster.map((unit) => ({ ...unit })),
        perk: 0,
        augments: [],
        synergies: [],
        tier1Artifact: 0,
        tier2Artifact: 0,
        rangedStacks: 0,
        t2Overridden: false,
        augmentsOverridden: false,
    };
}

describe("v0.7 aligned 96-hour v2 evaluator", () => {
    it("binds the exact twelve cells to candidate v0.7s versus opponent v0.6", () => {
        expect(V07_ALIGNED_V2_EVALUATOR_CELLS).toHaveLength(12);
        expect(V07_ALIGNED_V2_EVALUATOR_CELLS.filter((cell) => cell.distribution === "ranked_taxonomy")).toHaveLength(
            4,
        );
        expect(V07_ALIGNED_V2_EVALUATOR_CELLS.filter((cell) => cell.distribution === "fixed_template")).toHaveLength(8);
        expect(
            V07_ALIGNED_V2_EVALUATOR_CELLS.every((cell) => cell.candidate === "v0.7s" && cell.opponent === "v0.6"),
        ).toBe(true);
        expect(V07_ALIGNED_V2_EVALUATOR_CELLS.every((cell) => Object.isFrozen(cell))).toBe(true);
        expect(evaluatorCellV07AlignedV2("ranked_melee_mage")).toMatchObject({
            archetype: "meleeMage",
            scenarioProtocol: "independent_seat_conditioned",
        });
    });

    it("binds every aligned control to the candidate-only worker environment", () => {
        const binding = bindV07AlignedV2Candidate(modelGenome());
        const environment = buildV07AlignedV2CandidateEnvironment(binding.genome, "/tmp/test-audit.jsonl");

        expect(binding).toMatchObject({
            candidate: "v0.7s",
            candidateBase: "v0.7",
            opponent: "v0.6",
            profile: "candidate_scoped_aligned_controls_melee57_fixed_275",
            searchEnabled: true,
        });
        expect(environment).toMatchObject({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.7s",
            SEARCH_DECISION_DEADLINE_MS: "200",
            SEARCH_CIRCUIT_BREAKER_MS: "275",
            SEARCH_ACTIVE_CHALLENGERS: "0",
            SEARCH_SHORTLIST: "",
            SEARCH_AUDIT_TURNS: "0",
            V06_MELEE_DIMS: "",
            V06_MELEE_DIMS_VERSIONS: "",
            V07_PLACEMENT_REVEAL: "off",
            V07_DENSE_MM_SALVAGE_ISOLATION: "0",
            V07_AURA_CASTER_ROUTER: "off",
            V07_AURA_CASTER_SPELLS: "",
        });
        expect(environment.V07_VALUE_WEIGHTS_V2).toBeString();
        expect("V07_VALUE_WEIGHTS" in environment).toBe(false);
        expect("V06_WEIGHTS" in environment).toBe(false);
        expect(verifyV07AlignedV2WorkerEnvironment(environment, environment).sha256).toBe(
            fingerprintV07AlignedV2(environment),
        );

        const material = structuredClone(modelGenome());
        material.search.leafMode = "material";
        material.search.leaf = undefined;
        const materialEnvironment = buildV07AlignedV2CandidateEnvironment(material, "/tmp/material.jsonl");
        expect(materialEnvironment.V07_VALUE_WEIGHTS).toBe("material");
        expect("V07_VALUE_WEIGHTS_V2" in materialEnvironment).toBe(false);

        const staleBinding = structuredClone(binding);
        staleBinding.genome.search.gate += 0.01;
        expect(() => validateV07AlignedV2CandidateBinding(staleBinding)).toThrow(
            "candidate binding does not match its canonical genome and search profile",
        );
    });

    it("accepts only complete collision-free externally injected seed plans", () => {
        const plan = syntheticSeedPlan();
        expect(() => validateV07AlignedV2SeedPlan(plan)).not.toThrow();
        const tasks = flattenV07AlignedV2SeedPlan(plan);
        expect(tasks).toHaveLength(24);
        expect(tasks.slice(0, 2).map((task) => task.candidateSeat)).toEqual(["candidate_green", "candidate_red"]);

        const fixedMismatch = structuredClone(plan);
        const fixed = fixedMismatch.pairs.find((pair) => pair.cellId === "fixed_mage_frontline")!;
        fixed.seats.candidate_red.combatSeed += 1;
        expect(() => validateV07AlignedV2SeedPlan(fixedMismatch)).toThrow("must share exact setup and combat seeds");

        const collision = structuredClone(plan);
        const first = collision.pairs[0].seats.candidate_green;
        collision.pairs[1].seats.candidate_green.setupSeeds[0] = first.setupSeeds[0];
        expect(() => validateV07AlignedV2SeedPlan(collision)).toThrow("aligned v2 seed collision");
    });

    it("builds deterministic pair-boundary shards and rejects checkpoint tampering", async () => {
        const plan = syntheticSeedPlan();
        const executionTasks = flattenV07AlignedV2SeedPlan(plan);
        const tasks = executionTasks.map((task) => v07AlignedV2TaskIdentity(task));
        const changedSeedTask = structuredClone(executionTasks[0]);
        changedSeedTask.combatSeed += 1_000_000;
        expect(v07AlignedV2TaskIdentity(changedSeedTask).seedMaterialSha256).not.toBe(tasks[0].seedMaterialSha256);
        const binding = bindV07AlignedV2Candidate(modelGenome());
        const shards = buildV07AlignedV2CheckpointShardSpecs({
            runFingerprint: "b".repeat(64),
            seedPlan: plan,
            binding,
            maxScenarioPairsPerShard: 5,
        });
        expect(shards[0].panel).toMatchObject({
            mode: "seed_plan",
            panelId: plan.panelId,
            purpose: "train",
            denysetSha256: plan.denysetSha256,
            scenariosPerCell: 1,
            taskCount: 24,
        });
        const sourceEnvironment = { PATH: "/test/bin" };
        const mutableInput = {
            shard: structuredClone(shards[0]),
            seedPlan: structuredClone(plan),
            binding: structuredClone(binding),
            workers: 1,
            auditDirectory: "/tmp/test-only",
            sourceEnvironment,
        };
        const snapshot = snapshotV07AlignedV2ShardEvaluationOptions(mutableInput);
        mutableInput.workers = 0;
        mutableInput.binding.genome.search.gate += 0.1;
        mutableInput.seedPlan.purpose = "final";
        mutableInput.shard.panel.purpose = "final";
        sourceEnvironment.PATH = "/mutated";
        expect(snapshot).toMatchObject({
            workers: 1,
            seedPlan: { purpose: "train" },
            shard: { panel: { purpose: "train" } },
            sourceEnvironment: { PATH: "/test/bin" },
        });
        expect(snapshot.binding.genome.search.gate).toBe(binding.genome.search.gate);
        expect(shards.map((shard) => shard.tasks.length)).toEqual([10, 10, 4]);
        expect(shards.map((shard) => [shard.pairStart, shard.pairEndExclusive])).toEqual([
            [0, 5],
            [5, 10],
            [10, 12],
        ]);
        const seedLeakingShard = structuredClone(shards[0]) as unknown as Record<string, unknown>;
        const seedLeakingTasks = seedLeakingShard.tasks as Record<string, unknown>[];
        seedLeakingTasks[0].setupSeeds = [123];
        expect(() => validateV07AlignedV2CheckpointShardSpec(seedLeakingShard)).toThrow("fields are not exact");

        const invalidRangeShard = structuredClone(shards[0]);
        invalidRangeShard.pairEndExclusive = invalidRangeShard.pairStart;
        await expect(
            evaluateV07AlignedV2Shard({
                shard: invalidRangeShard,
                seedPlan: plan,
                binding,
                workers: 1,
                auditDirectory: join(tmpdir(), "hoc-v07-aligned-must-not-start"),
            }),
        ).rejects.toThrow("range metadata is invalid");
        const relabeledPlan = structuredClone(plan);
        relabeledPlan.purpose = "final";
        await expect(
            evaluateV07AlignedV2Shard({
                shard: shards[0],
                seedPlan: relabeledPlan,
                binding,
                workers: 1,
                auditDirectory: join(tmpdir(), "hoc-v07-aligned-must-not-start"),
            }),
        ).rejects.toThrow("not the deterministic partition of its exact injected seed plan");
        const observations = shards[0].tasks.map((task) => ({
            cellId: task.cellId,
            candidateSeat: task.candidateSeat,
            scenarioId: task.scenarioId,
            outcome: "candidate_win" as const,
            reachedArmageddon: false,
            candidateRejections: 0,
            opponentRejections: 0,
            searchAudit: {
                decisions: 2,
                searchedDecisions: 2,
                deadlineFallbacks: 0,
                illegalIncumbents: 0,
                circuitOpened: false,
                circuitSkippedDecisions: 0,
                msTotal: 100,
            },
        }));
        const checkpoint = createV07AlignedV2Checkpoint(shards[0], observations);
        expect(validateV07AlignedV2Checkpoint(checkpoint, shards[0])).toEqual(checkpoint);

        const corruptHash = structuredClone(checkpoint);
        corruptHash.observations[0].outcome = "opponent_win";
        expect(() => validateV07AlignedV2Checkpoint(corruptHash, shards[0])).toThrow("observation hash mismatch");

        const wrongOrder = structuredClone(checkpoint);
        wrongOrder.observations.reverse();
        wrongOrder.observationsSha256 = fingerprintV07AlignedV2(wrongOrder.observations);
        expect(() => validateV07AlignedV2Checkpoint(wrongOrder, shards[0])).toThrow(
            "does not match its deterministic task",
        );

        const jointlyMutatedShard = structuredClone(shards[0]);
        jointlyMutatedShard.panel.panelFingerprint = "c".repeat(64);
        const jointlyMutatedCheckpoint = structuredClone(checkpoint);
        jointlyMutatedCheckpoint.shard = jointlyMutatedShard;
        expect(() => validateV07AlignedV2Checkpoint(jointlyMutatedCheckpoint, jointlyMutatedShard)).toThrow(
            "shard self-hash mismatch",
        );
    });

    it("reconstructs exact fixed-template setup and swaps only the candidate version", () => {
        const tasks = flattenV07AlignedV2SeedPlan(syntheticSeedPlan()).filter(
            (task) => task.cellId === "fixed_mage_frontline",
        );
        const configs: IMatchConfig[] = [];
        const records = tasks.map((task) =>
            playV07AlignedV2Task(task, {
                matchRunner: (config) => {
                    configs.push(config);
                    return fakeResult(config, "green", 1, 2);
                },
            }),
        );

        expect(configs.map(({ greenVersion, redVersion }) => [greenVersion, redVersion])).toEqual([
            ["v0.7s", "v0.6"],
            ["v0.6", "v0.7s"],
        ]);
        expect(configs[0].seed).toBe(configs[1].seed);
        expect(records[0].physicalSetupSha256).toBe(records[1].physicalSetupSha256);
        expect(records[0].lowerRoster).toBe(records[0].upperRoster);
        expect(
            configs.every((config) => (config.greenArtifactT1 ?? 0) === 0 && (config.greenArtifactT2 ?? 0) === 0),
        ).toBe(true);
        expect(records.map((record) => record.winnerSlot)).toEqual(["candidate", "opponent"]);

        const binding = bindV07AlignedV2Candidate(modelGenome());
        const redObservation = compactV07AlignedV2Observation(records[1], binding, auditFor(records[1]));
        expect(redObservation).toMatchObject({
            candidateSeat: "candidate_red",
            outcome: "opponent_win",
            candidateRejections: 2,
            opponentRejections: 1,
            searchAudit: { searchedDecisions: 10, msTotal: 1000 },
        });
    });

    it("conditions taxonomy first-hit selection on the candidate seat", () => {
        const task = flattenV07AlignedV2SeedPlan(syntheticSeedPlan()).find(
            (candidate) => candidate.cellId === "ranked_mage" && candidate.candidateSeat === "candidate_green",
        )!;
        let attempt = 0;
        const record = playV07AlignedV2Task(task, {
            pickRunner: () => {
                const lower = attempt++ === 0 ? army("ranged_precision") : army("mage_frontline");
                return { lower, upper: army("mage_frontline") };
            },
            matchRunner: (config) => fakeResult(config),
        });

        expect(record.setupAttempt).toBe(1);
        expect(record.setupSeed).toBe(task.setupSeeds[1]);
        expect(record.candidateSeat).toBe("candidate_green");
    });

    it("fails closed on missing or mismatched search audit rows", () => {
        const task = flattenV07AlignedV2SeedPlan(syntheticSeedPlan()).find(
            (candidate) => candidate.cellId === "fixed_ranged_control" && candidate.candidateSeat === "candidate_green",
        )!;
        const record = playV07AlignedV2Task(task, { matchRunner: (config) => fakeResult(config) });
        const binding = bindV07AlignedV2Candidate(modelGenome());
        expect(() => compactV07AlignedV2Observation(record, binding)).toThrow("audit presence disagrees");
        expect(() =>
            compactV07AlignedV2Observation(record, binding, auditFor(record, { seed: record.combatSeed + 1 })),
        ).toThrow("does not match the candidate binding");
        const wrongMatchup = { ...record, greenVersion: "v0.6" as const };
        expect(() => compactV07AlignedV2Observation(wrongMatchup, binding, auditFor(record))).toThrow(
            "is not an exact v0.7s versus v0.6 candidate-seat result",
        );
    });

    it("reads only complete appended audit rows and detects truncation", () => {
        const directory = mkdtempSync(join(tmpdir(), "hoc-v07-aligned-audit-"));
        const path = join(directory, "worker.jsonl");
        try {
            writeFileSync(path, `${JSON.stringify({ t: "game", seed: 1 })}\n`);
            const first = readV07AlignedV2AuditAppend(path, 0);
            expect(first.rows).toHaveLength(1);
            expect(first.nextByteOffset).toBeGreaterThan(0);
            expect(() => readV07AlignedV2AuditAppend(path, first.nextByteOffset + 1)).toThrow("shrank");
            writeFileSync(path, '{"t":"game"}');
            expect(() => readV07AlignedV2AuditAppend(path, 0)).toThrow("terminal newline");
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("rejects an expired immutable shard deadline before starting any worker", async () => {
        const directory = mkdtempSync(join(tmpdir(), "hoc-v07-aligned-deadline-"));
        const seedPlan = syntheticSeedPlan();
        const binding = bindV07AlignedV2Candidate(modelGenome());
        const shard = buildV07AlignedV2CheckpointShardSpecs({
            runFingerprint: "d".repeat(64),
            seedPlan,
            binding,
            maxScenarioPairsPerShard: 12,
        })[0];
        let workersStarted = 0;
        try {
            await expect(
                evaluateV07AlignedV2Shard({
                    shard,
                    seedPlan,
                    binding,
                    workers: 1,
                    auditDirectory: join(directory, "audit"),
                    deadlineAtMs: Date.now() - 1,
                    onWorkerStarted: () => {
                        workersStarted += 1;
                    },
                }),
            ).rejects.toThrow("deadline before worker start");
            expect(workersStarted).toBe(0);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("runs an inert two-row preflight without seeds, games, bake, or deploy", () => {
        const report = preflightV07AlignedV2();
        expect(report).toMatchObject({
            mode: "synthetic_no_seed_material",
            status: "research_only_no_bake",
            automaticBake: false,
            automaticDeploy: false,
            seedMaterialUsed: false,
            gamesExecuted: 0,
            rowsInjected: 2,
            checkpointReplayExact: true,
            fullGateExecuted: false,
        });
        expect(report.aggregate.observations).toBe(2);
        expect(report.aggregate.complete).toBe(false);
        expect(report.checkpoint.observations).toHaveLength(2);
    });

    it("accepts only explicit dry-run/preflight CLI modes and resolves injected files", () => {
        expect(() => parseV07AlignedV2PreflightArgs([])).toThrow("permits only --dry-run or --preflight");
        expect(parseV07AlignedV2PreflightArgs(["--dry-run", "--inject-two-game-rows", "rows.json"], "/tmp")).toEqual({
            dryRun: true,
            injectedRowsPath: resolve("/tmp", "rows.json"),
            genomePath: null,
        });
        expect(() =>
            preflightV07AlignedV2({
                injectedRows: [
                    {
                        cellId: "ranked_mage",
                        candidateSeat: "candidate_green",
                        scenarioId: "0",
                        outcome: "candidate_win",
                        reachedArmageddon: false,
                    },
                ],
            }),
        ).toThrow("exactly two injected rows");
    });
});
