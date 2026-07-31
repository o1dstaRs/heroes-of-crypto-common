import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import {
    assertFreshV09ActorLaneBenchmarkOutput,
    buildV09ActorLaneBenchmarkPlan,
    executeV09ActorLaneBenchmarkPlan,
    parseV09CpuList,
    type IV09ActorLaneBenchmarkReceiptBase,
} from "../../src/simulation/v0_9/actor_lane_benchmark";
import {
    sealV09ActorLaneBenchmarkReceipt,
    validateV09ActorLaneBenchmarkReceipt,
    V09_ACTOR_LANE_SELECTION_POLICY,
    type IV09ActorLaneBenchmarkHost,
    type IV09ActorLaneBenchmarkInput,
} from "../../src/simulation/v0_9/actor_lane_benchmark_receipt";
import type { IV09ActorCpuTopology } from "../../src/simulation/v0_9/actor_cpu_topology";
import {
    buildV09AuditedActorPhysicalCorePolicy,
    buildV09CampaignManifest,
    buildV09DevelopmentActorPhysicalCorePolicy,
    buildV09SeedLedger,
    validateV09CampaignManifest,
    v09CampaignRunFingerprint,
    V09_RTX5090_GPU_UUID,
} from "../../src/simulation/v0_9/campaign";
import {
    requireV09AuditedActorPhysicalCorePolicy,
    resolveV09CampaignActorCpuIds,
    resolveV09OrchestratorWorkers,
} from "../../src/simulation/v0_9/orchestrator";
import { fingerprintV09 } from "../../src/simulation/v0_9/protocol";
import type { IV09SourceIdentityReceipt } from "../../src/simulation/v0_9/source_identity";
import {
    bindV09ActorLaneBenchmarkToCampaign,
    canonicalV09PathThroughExistingAncestor,
    writeV09ActorLaneBenchmarkEvidence,
} from "../../src/simulation/v0_9/supervisor";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const SHA_E = "e".repeat(64);
const GIT_COMMIT = "1".repeat(40);

function host(physicalCpuIds: number[], production = true): IV09ActorLaneBenchmarkHost {
    const allowedLogicalCpuIds = Array.from({ length: Math.max(...physicalCpuIds, 0) + 1 }, (_, cpu) => cpu);
    return {
        hostname: "benchmark-host",
        platform: production ? "linux" : "test",
        architecture: production ? "x64" : "test",
        release: "test-kernel",
        bunVersion: production ? V09_ACTOR_LANE_SELECTION_POLICY.requiredBunVersion : Bun.version,
        cpuModel: "fixture CPU",
        logicalCpuCount: allowedLogicalCpuIds.length,
        allowedLogicalCpuIds,
        physicalCpuIds,
        topologySha256: SHA_A,
        gpuUuid: V09_RTX5090_GPU_UUID,
        temperatureSensorCount: production ? 2 : 0,
        throttleCounterCount: production ? 2 : 0,
    };
}

function inputFromPlan(options: {
    mode: "production" | "test_fixture";
    candidates: number[];
    games: number;
    repetitions: number;
    throughput: Readonly<Record<number, number>>;
    physicalCpuIds: number[];
}): IV09ActorLaneBenchmarkInput {
    const plan = buildV09ActorLaneBenchmarkPlan({
        mode: options.mode,
        candidates: options.candidates,
        panelGames: options.games,
        repetitions: options.repetitions,
    });
    return {
        mode: options.mode,
        thermalTelemetry: "observed",
        source: {
            receiptSha256: SHA_B,
            sourceCommit: GIT_COMMIT,
            sourceStatusSha256: SHA_C,
            rulesFingerprint: SHA_D,
        },
        host: host(options.physicalCpuIds, options.mode === "production"),
        idle: {
            checkedAt: "2026-07-29T12:00:00.000Z",
            loadOne: 0.25,
            maximumLoadOne: 2.4,
            freeMemoryBytes: 32 * 1024 * 1024 * 1024,
            conflictingProcesses: [],
            gpuComputePids: [],
        },
        panel: {
            purpose: "wide_teacher_train",
            games: options.games,
            repetitions: options.repetitions,
            productionTeacherSearch: true,
            runFingerprint: SHA_A,
            seedLedgerSha256: SHA_B,
            seedsSha256: SHA_C,
        },
        runs: plan.entries.map((entry) => {
            const gamesPerSecond = options.throughput[entry.workers]!;
            return {
                ...entry,
                physicalCpuIds: options.physicalCpuIds.slice(0, entry.workers),
                games: options.games,
                elapsedSeconds: options.games / gamesPerSecond,
                gamesPerSecond,
                shardSetSha256: SHA_E,
                peakTemperatureC: 65,
                throttleCountBefore: 10,
                throttleCountAfter: 10,
            };
        }),
        startedAt: "2026-07-29T12:00:01.000Z",
        completedAt: "2026-07-29T14:00:01.000Z",
    };
}

function productionInput(): IV09ActorLaneBenchmarkInput {
    return inputFromPlan({
        mode: "production",
        candidates: [20, 22, 23, 24],
        games: V09_ACTOR_LANE_SELECTION_POLICY.minimumProductionPanelGames,
        repetitions: V09_ACTOR_LANE_SELECTION_POLICY.minimumProductionRepetitions,
        throughput: { 20: 1, 22: 1.02, 23: 1.05, 24: 1.07 },
        physicalCpuIds: Array.from({ length: 24 }, (_, cpu) => cpu),
    });
}

function sourceReceipt(): IV09SourceIdentityReceipt {
    return {
        schema: "hoc.ai.v0_9_source_identity.v1",
        sourceCommit: GIT_COMMIT,
        sourceTree: "2".repeat(40),
        sourceStatusSha256: SHA_C,
        sourceDirty: false,
        rulesFingerprint: SHA_D,
        rosterFingerprint: "6".repeat(64),
        anchorVersion: "v0.8",
        anchorFingerprint: "7".repeat(64),
        trackedInputs: { rules: [], roster: [], anchor: [] },
        receiptSha256: SHA_B,
    };
}

function topologyFor(input: IV09ActorLaneBenchmarkInput): IV09ActorCpuTopology {
    return {
        allowedLogicalCpuIds: [...input.host.allowedLogicalCpuIds],
        physicalCpuRows: input.host.physicalCpuIds.map((cpu) => ({ cpu, core: cpu, socket: 0 })),
        physicalCpuIds: [...input.host.physicalCpuIds],
        topologySha256: input.host.topologySha256,
    };
}

describe("v0.9 actor lane benchmark", () => {
    it("counterbalances the audited production candidates and permits a tiny ineligible fixture", () => {
        const production = buildV09ActorLaneBenchmarkPlan({
            mode: "production",
            panelGames: 96,
            repetitions: 2,
        });
        expect(production.entries).toEqual([
            { sequence: 0, repetition: 0, workers: 20 },
            { sequence: 1, repetition: 0, workers: 22 },
            { sequence: 2, repetition: 0, workers: 23 },
            { sequence: 3, repetition: 0, workers: 24 },
            { sequence: 4, repetition: 1, workers: 24 },
            { sequence: 5, repetition: 1, workers: 23 },
            { sequence: 6, repetition: 1, workers: 22 },
            { sequence: 7, repetition: 1, workers: 20 },
        ]);

        const fixture = buildV09ActorLaneBenchmarkPlan({
            mode: "test_fixture",
            candidates: [1, 2],
            panelGames: 2,
            repetitions: 1,
        });
        expect(fixture.entries).toEqual([
            { sequence: 0, repetition: 0, workers: 1 },
            { sequence: 1, repetition: 0, workers: 2 },
        ]);
        expect(() =>
            buildV09ActorLaneBenchmarkPlan({
                mode: "production",
                candidates: [20, 21, 22, 24],
                panelGames: 96,
                repetitions: 2,
            }),
        ).toThrow("restricted to 20/22/23/24");
        expect(() =>
            buildV09ActorLaneBenchmarkPlan({
                mode: "production",
                panelGames: 95,
                repetitions: 2,
            }),
        ).toThrow("below the audited minimum");
    });

    it("selects only a material stable gain and seals the audited topology and result", () => {
        const receipt = sealV09ActorLaneBenchmarkReceipt(productionInput());
        expect(receipt.eligibleForCampaign).toBe(true);
        expect(receipt.selection.selectedWorkers).toBe(23);
        expect(receipt.selection.reservedPhysicalCores).toBe(1);
        expect(receipt.selection.selectedPhysicalCpuIds).toEqual(Array.from({ length: 23 }, (_, cpu) => cpu));
        expect(receipt.selection.candidates.map((candidate) => candidate.workers)).toEqual([20, 22, 23, 24]);
        expect(receipt.receiptSha256).toHaveLength(64);
        expect(validateV09ActorLaneBenchmarkReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
    });

    it("permits an explicit missing-thermal-telemetry override without fabricating telemetry", () => {
        const overridden = productionInput();
        overridden.thermalTelemetry = "unavailable_user_override";
        overridden.host.temperatureSensorCount = 0;
        overridden.host.throttleCounterCount = 0;
        for (const run of overridden.runs) {
            run.peakTemperatureC = 0;
            run.throttleCountBefore = 0;
            run.throttleCountAfter = 0;
        }
        const receipt = sealV09ActorLaneBenchmarkReceipt(overridden);
        expect(receipt.eligibleForCampaign).toBe(true);
        expect(receipt.thermalTelemetry).toBe("unavailable_user_override");
        expect(receipt.selection.rationale).toContain("explicitly user-overridden");

        const observedWithoutTelemetry = productionInput();
        observedWithoutTelemetry.host.temperatureSensorCount = 0;
        observedWithoutTelemetry.host.throttleCounterCount = 0;
        expect(() => sealV09ActorLaneBenchmarkReceipt(observedWithoutTelemetry)).toThrow(
            "requires temperature and throttle telemetry",
        );

        const inconsistentOverride = structuredClone(overridden);
        inconsistentOverride.host.temperatureSensorCount = 1;
        expect(() => sealV09ActorLaneBenchmarkReceipt(inconsistentOverride)).toThrow("override is only valid");
    });

    it("keeps tiny fixture receipts ineligible for campaign initialization", () => {
        const input = inputFromPlan({
            mode: "test_fixture",
            candidates: [1, 2],
            games: 2,
            repetitions: 1,
            throughput: { 1: 1, 2: 1.2 },
            physicalCpuIds: [3, 7],
        });
        const receipt = sealV09ActorLaneBenchmarkReceipt(input);
        expect(receipt.eligibleForCampaign).toBe(false);
        expect(receipt.selection.selectedWorkers).toBe(2);
        expect(receipt.selection.selectedPhysicalCpuIds).toEqual([3, 7]);
        expect(validateV09ActorLaneBenchmarkReceipt(receipt)).toEqual(receipt);

        const tie = sealV09ActorLaneBenchmarkReceipt(
            inputFromPlan({
                mode: "test_fixture",
                candidates: [1, 2],
                games: 2,
                repetitions: 1,
                throughput: { 1: 1, 2: 1 },
                physicalCpuIds: [3, 7],
            }),
        );
        const threshold = sealV09ActorLaneBenchmarkReceipt(
            inputFromPlan({
                mode: "test_fixture",
                candidates: [1, 2],
                games: 2,
                repetitions: 1,
                throughput: { 1: 1, 2: 1.03 },
                physicalCpuIds: [3, 7],
            }),
        );
        expect(tie.selection.selectedWorkers).toBe(1);
        expect(threshold.selection.selectedWorkers).toBe(2);
    });

    it("executes the real serial runner seam in plan order and stops before a thermally unsafe successor", async () => {
        const input = productionInput();
        const plan = buildV09ActorLaneBenchmarkPlan({
            mode: "production",
            panelGames: input.panel.games,
            repetitions: input.panel.repetitions,
        });
        const base: IV09ActorLaneBenchmarkReceiptBase = {
            mode: input.mode,
            thermalTelemetry: input.thermalTelemetry,
            source: input.source,
            host: input.host,
            idle: input.idle,
            panel: input.panel,
            startedAt: input.startedAt,
        };
        const executed: number[] = [];
        const receipt = await executeV09ActorLaneBenchmarkPlan(
            plan,
            base,
            async (entry) => {
                executed.push(entry.sequence);
                return structuredClone(input.runs[entry.sequence]!);
            },
            () => input.completedAt,
        );
        expect(executed).toEqual(plan.entries.map((entry) => entry.sequence));
        expect(receipt.selection.selectedWorkers).toBe(23);

        executed.length = 0;
        await expect(
            executeV09ActorLaneBenchmarkPlan(plan, base, async (entry) => {
                executed.push(entry.sequence);
                const run = structuredClone(input.runs[entry.sequence]!);
                if (entry.sequence === 1) run.throttleCountAfter += 1;
                return run;
            }),
        ).rejects.toThrow("failed thermal safety");
        expect(executed).toEqual([0, 1]);
    });

    it("rejects parity, thermal, stability, idleness, and selection tampering", () => {
        const parity = productionInput();
        parity.runs[1]!.shardSetSha256 = "f".repeat(64);
        expect(() => sealV09ActorLaneBenchmarkReceipt(parity)).toThrow("byte-identical");

        const thermal = productionInput();
        thermal.runs[0]!.throttleCountAfter += 1;
        expect(() => sealV09ActorLaneBenchmarkReceipt(thermal)).toThrow("thermal safety");

        const unstable = productionInput();
        unstable.runs.find((run) => run.workers === 22)!.gamesPerSecond = 0.8;
        unstable.runs.find((run) => run.workers === 22)!.elapsedSeconds = unstable.panel.games / 0.8;
        expect(() => sealV09ActorLaneBenchmarkReceipt(unstable)).toThrow("not stable enough");

        const busy = productionInput();
        busy.idle.conflictingProcesses = ["123 bun teacher_actor.ts"];
        expect(() => sealV09ActorLaneBenchmarkReceipt(busy)).toThrow("did not begin on an idle host");

        const unbalanced = productionInput();
        [unbalanced.runs[0], unbalanced.runs[1]] = [unbalanced.runs[1]!, unbalanced.runs[0]!];
        unbalanced.runs.forEach((run, sequence) => {
            run.sequence = sequence;
        });
        expect(() => sealV09ActorLaneBenchmarkReceipt(unbalanced)).toThrow("not counterbalanced");

        const receipt = sealV09ActorLaneBenchmarkReceipt(productionInput());
        const tampered = {
            ...receipt,
            selection: { ...receipt.selection, selectedWorkers: 24 },
        };
        tampered.receiptSha256 = fingerprintV09(
            Object.fromEntries(Object.entries(tampered).filter(([key]) => key !== "receiptSha256")),
        );
        expect(() => validateV09ActorLaneBenchmarkReceipt(tampered)).toThrow("identity or selection mismatch");
    });

    it("parses Linux affinity ranges and refuses existing, repository-local, or v0.8-overlapping outputs", () => {
        expect(parseV09CpuList("0-3,8,10-11")).toEqual([0, 1, 2, 3, 8, 10, 11]);
        expect(() => parseV09CpuList("3-1")).toThrow("invalid Linux CPU range");
        expect(() => parseV09CpuList("")).toThrow("affinity is empty");

        const root = mkdtempSync(join(tmpdir(), "hoc-v09-lane-output-"));
        const repository = join(root, "repository");
        const protectedRoot = join(root, "v0.8");
        mkdirSync(repository);
        mkdirSync(protectedRoot);
        const fresh = join(root, "benchmark");
        expect(assertFreshV09ActorLaneBenchmarkOutput(fresh, repository, [protectedRoot])).toBe(
            canonicalV09PathThroughExistingAncestor(fresh),
        );

        mkdirSync(fresh);
        expect(() => assertFreshV09ActorLaneBenchmarkOutput(fresh, repository, [protectedRoot])).toThrow(
            "refuses existing",
        );
        expect(() =>
            assertFreshV09ActorLaneBenchmarkOutput(join(repository, "benchmark"), repository, [protectedRoot]),
        ).toThrow("outside the clean source repository");
        expect(() =>
            assertFreshV09ActorLaneBenchmarkOutput(join(protectedRoot, "benchmark"), repository, [protectedRoot]),
        ).toThrow("overlaps protected v0.8 root");

        const protectedNested = join(protectedRoot, "nested");
        const repositoryNested = join(repository, "nested");
        mkdirSync(protectedNested);
        mkdirSync(repositoryNested);
        const protectedBridge = join(root, "protected-bridge");
        const repositoryBridge = join(root, "repository-bridge");
        symlinkSync(protectedRoot, protectedBridge, "dir");
        symlinkSync(repository, repositoryBridge, "dir");
        expect(() =>
            assertFreshV09ActorLaneBenchmarkOutput(join(protectedBridge, "nested", "benchmark"), repository, [
                protectedRoot,
            ]),
        ).toThrow("overlaps protected v0.8 root");
        expect(() =>
            assertFreshV09ActorLaneBenchmarkOutput(join(repositoryBridge, "nested", "benchmark"), repository, [
                protectedRoot,
            ]),
        ).toThrow("outside the clean source repository");

        const danglingOutput = join(root, "dangling-output");
        const missingOutsideTarget = join(root, "outside", "future-output");
        symlinkSync(missingOutsideTarget, danglingOutput, "dir");
        expect(() => assertFreshV09ActorLaneBenchmarkOutput(danglingOutput, repository, [protectedRoot])).toThrow(
            "refuses existing",
        );
        expect(() => canonicalV09PathThroughExistingAncestor(danglingOutput)).toThrow();
    });

    it("binds an eligible receipt into the immutable campaign CPU policy and exact CPU IDs", () => {
        const input = productionInput();
        const receipt = sealV09ActorLaneBenchmarkReceipt(input);
        const source = sourceReceipt();
        const topology = topologyFor(input);
        const bound = bindV09ActorLaneBenchmarkToCampaign(receipt, source, V09_RTX5090_GPU_UUID, topology);

        expect(bound.actorPhysicalCores.target).toBe(23);
        expect(bound.actorPhysicalCores.reserveForOsAndLearner).toBe(1);
        expect(bound.actorPhysicalCores.selection.kind).toBe("audited_benchmark");
        expect(resolveV09CampaignActorCpuIds(bound.actorPhysicalCores, 23, topology)).toEqual(
            receipt.selection.selectedPhysicalCpuIds,
        );
        expect(resolveV09CampaignActorCpuIds(bound.actorPhysicalCores, 4, topology)).toEqual([0, 1, 2, 3]);

        const identity = {
            sourceCommit: source.sourceCommit,
            sourceStatusSha256: source.sourceStatusSha256,
            sourceDirty: false as const,
            rulesFingerprint: source.rulesFingerprint,
            rosterFingerprint: source.rosterFingerprint,
            anchorVersion: "v0.8" as const,
            anchorFingerprint: source.anchorFingerprint,
            gpuUuid: V09_RTX5090_GPU_UUID,
        };
        const ledger = buildV09SeedLedger(v09CampaignRunFingerprint(identity));
        const output = join(tmpdir(), "hoc-v09-audited-campaign");
        const manifest = buildV09CampaignManifest(identity, output, ledger, bound.actorPhysicalCores);
        expect(validateV09CampaignManifest(manifest, output)).toEqual(manifest);

        expect(() =>
            bindV09ActorLaneBenchmarkToCampaign(receipt, source, V09_RTX5090_GPU_UUID, {
                ...topology,
                topologySha256: SHA_E,
            }),
        ).toThrow("CPU topology");
        expect(() => resolveV09CampaignActorCpuIds(bound.actorPhysicalCores, 24, topology)).toThrow(
            "beyond immutable target",
        );

        const invalidTarget = buildV09AuditedActorPhysicalCorePolicy({
            benchmarkReceiptSha256: SHA_A,
            benchmarkSourceReceiptSha256: SHA_B,
            topologySha256: SHA_C,
            benchmarkPhysicalCoreCount: 24,
            selectedWorkers: 21,
            selectedPhysicalCpuIds: Array.from({ length: 21 }, (_, cpu) => cpu),
        });
        expect(() => buildV09CampaignManifest(identity, output, ledger, invalidTarget)).toThrow(
            "audited actor physical-core policy",
        );

        const fixture = buildV09DevelopmentActorPhysicalCorePolicy();
        expect(fixture.selection.kind).toBe("development_fixture");
        expect(() => requireV09AuditedActorPhysicalCorePolicy(fixture)).toThrow(
            "requires an audited actor-lane benchmark policy",
        );
        expect(() => requireV09AuditedActorPhysicalCorePolicy(bound.actorPhysicalCores)).not.toThrow();
        expect(
            resolveV09CampaignActorCpuIds(
                fixture,
                fixture.target,
                undefined,
                Array.from({ length: 24 }, (_, cpu) => cpu),
            ),
        ).toEqual(Array.from({ length: 20 }, (_, cpu) => cpu));
    });

    it("enforces immutable target and smoke worker counts for every orchestrator entry point", () => {
        const policy = buildV09AuditedActorPhysicalCorePolicy({
            benchmarkReceiptSha256: SHA_A,
            benchmarkSourceReceiptSha256: SHA_B,
            topologySha256: SHA_C,
            benchmarkPhysicalCoreCount: 24,
            selectedWorkers: 23,
            selectedPhysicalCpuIds: Array.from({ length: 23 }, (_, cpu) => cpu),
        });

        expect(resolveV09OrchestratorWorkers("launch", undefined, false, policy)).toBe(23);
        expect(resolveV09OrchestratorWorkers("resume", "23", false, policy)).toBe(23);
        expect(() => resolveV09OrchestratorWorkers("launch", "20", false, policy)).toThrow(
            "immutable benchmark target 23",
        );
        expect(() => resolveV09OrchestratorWorkers("resume", "22", false, policy)).toThrow(
            "immutable benchmark target 23",
        );

        expect(resolveV09OrchestratorWorkers("actors", undefined, true, policy)).toBe(4);
        expect(resolveV09OrchestratorWorkers("smoke", undefined, false, policy)).toBe(4);
        expect(() => resolveV09OrchestratorWorkers("actors", "20", true, policy)).toThrow("immutable smoke target 4");
        expect(() => resolveV09OrchestratorWorkers("smoke", "23", false, policy)).toThrow("immutable smoke target 4");

        expect(resolveV09OrchestratorWorkers("qualification", "1", false, policy)).toBe(1);
        expect(() => resolveV09OrchestratorWorkers("qualification", undefined, false, policy)).toThrow(
            "explicit --workers 1",
        );
    });

    it("copies eligible benchmark evidence idempotently and rejects incompatible resume evidence", () => {
        const campaign = mkdtempSync(join(tmpdir(), "hoc-v09-lane-evidence-"));
        const receipt = sealV09ActorLaneBenchmarkReceipt(productionInput());
        const first = writeV09ActorLaneBenchmarkEvidence(campaign, receipt);
        expect(writeV09ActorLaneBenchmarkEvidence(campaign, structuredClone(receipt))).toBe(first);

        const incompatibleInput = productionInput();
        incompatibleInput.completedAt = "2026-07-29T14:00:02.000Z";
        const incompatible = sealV09ActorLaneBenchmarkReceipt(incompatibleInput);
        expect(() => writeV09ActorLaneBenchmarkEvidence(campaign, incompatible)).toThrow(
            "incompatible actor-lane benchmark evidence",
        );
    });
});
