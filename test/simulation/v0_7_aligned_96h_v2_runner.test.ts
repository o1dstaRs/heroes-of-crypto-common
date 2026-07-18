/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { arch, availableParallelism, hostname, platform, release, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { V07_COMPOSED_SEED_SCAN_POLICY } from "../../src/simulation/v0_7_composed_seed_scan";
import { V08_ALIGNED_96H_V1_VERSION_PROFILE } from "../../src/simulation/optimizer/aligned_96h_version_profile";
import {
    buildV07AlignedV2ProductionCandidateCatalog,
    buildV07AlignedV2ProductionIncumbentGenome,
} from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_catalog";
import {
    V08_ALIGNED_V1_PRODUCTION_CATALOG_SHA256,
    buildV08AlignedV1ProductionCandidateCatalog,
    buildV08AlignedV1ProductionIncumbentGenome,
} from "../../src/simulation/optimizer/v0_8_aligned_96h_v1_catalog";
import { createV07AlignedV2FilesystemReplayResolvers } from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_filesystem_resolvers";
import type { IV07AlignedV2OrchestratorDefinition } from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_orchestrator";
import { loadV07AlignedV2PersistedOrchestrator } from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_orchestrator_persistence";
import {
    canonicalV07AlignedV2Json,
    fingerprintV07AlignedV2,
} from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_protocol";
import {
    buildV08AlignedV1ThroughputCodeLedger,
    V07_ALIGNED_V2_THROUGHPUT_BATCHES,
    V07_ALIGNED_V2_THROUGHPUT_GAMES,
    V07_ALIGNED_V2_THROUGHPUT_SCENARIOS_PER_CELL,
    V08_ALIGNED_V1_THROUGHPUT_WORST_COST_GENOME_SHA256,
} from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_throughput";
import {
    parseV07AlignedV2RunnerArgs,
    prepareV07AlignedV2DefinitionBundle,
    quarantineV07AlignedV2RunnerAtomicTemporaries,
    runV07AlignedV2Runner,
    validateV07AlignedV2RunnerConfig,
    validateV07AlignedV2RunnerHeartbeat,
    validateV07AlignedV2RunnerBudget,
    validateV07AlignedV2ThroughputAttestation,
    type IV07AlignedV2DefinitionBootstrapRequest,
    type IV07AlignedV2PreparedDefinitionBundle,
    type IV07AlignedV2RunnerConfig,
    type IV07AlignedV2RunnerHeartbeat,
    type IV07AlignedV2ThroughputAttestation,
} from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_runner";
import {
    V07_ALIGNED_V2_SEED_ALLOCATION_DOMAIN,
    type IV07AlignedV2SeedAllocationRequest,
} from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_seed_allocator";
import { validateV07AlignedV2TerminalReplay } from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_supervisor";

const HOUR_MS = 60 * 60 * 1000;

function sha256(value: string | Uint8Array): string {
    return createHash("sha256").update(value).digest("hex");
}

function canonicalFile(value: unknown): string {
    return `${canonicalV07AlignedV2Json(value)}\n`;
}

function writeCanonical(path: string, value: unknown): string {
    const contents = canonicalFile(value);
    writeFileSync(path, contents, "utf8");
    return contents;
}

function sourceSha256(fileName: string): string {
    return sha256(readFileSync(resolve("src/simulation/optimizer", fileName)));
}

function hostFingerprintSha256(): string {
    return fingerprintV07AlignedV2({
        hostname: hostname(),
        platform: platform(),
        architecture: arch(),
        release: release(),
        logicalCpus: availableParallelism(),
    });
}

function scanFiles(root: string, site: "local" | "zinc", seeds: number[]): void {
    const directory = join(root, site);
    mkdirSync(directory);
    const seedSet = `${[...seeds].sort((left, right) => left - right).join("\n")}\n`;
    const summary = {
        schemaVersion: 1,
        scanPolicy: V07_COMPOSED_SEED_SCAN_POLICY,
        cutoff: "2026-07-16T09:18:00Z",
        uniqueSeeds: seeds.length,
        corpusFileSnapshotSha256: sha256(`${site}-snapshot`),
        corpusSeedSetSha256: sha256(seedSet),
    };
    writeCanonical(join(directory, "summary.json"), summary);
    writeFileSync(join(directory, "seeds.txt"), seedSet, "utf8");
}

interface IRunnerFixture {
    root: string;
    configPath: string;
    requestPath: string;
    preparedDirectory: string;
    outputRoot: string;
    orchestratorDirectory: string;
    bundle: IV07AlignedV2PreparedDefinitionBundle;
    definition: IV07AlignedV2OrchestratorDefinition;
    environment: NodeJS.ProcessEnv;
    startAtMs: number;
}

function runnerFixture(versionProfile?: typeof V08_ALIGNED_96H_V1_VERSION_PROFILE): IRunnerFixture {
    const v08Profile = versionProfile !== undefined;
    const root = mkdtempSync(join(tmpdir(), "aligned-v2-runner-"));
    const inputs = join(root, "inputs");
    mkdirSync(inputs);
    scanFiles(inputs, "local", [1, 2, 3]);
    scanFiles(inputs, "zinc", [4, 5, 6]);
    writeFileSync(join(inputs, "secret.bin"), Buffer.alloc(32, 7));

    const workerCount = 1;
    const sampleGames = 24;
    const elapsedMs = 24;
    const gamesPerWorkerHour = (sampleGames * HOUR_MS) / (elapsedMs * workerCount);
    const unsignedAttestation = {
        schemaVersion: 1 as const,
        artifactKind: v08Profile
            ? ("v0_8_aligned_96h_v1_throughput_attestation" as const)
            : ("v0_7_aligned_96h_v2_throughput_attestation" as const),
        ...(v08Profile
            ? {
                  versionProfile: { ...V08_ALIGNED_96H_V1_VERSION_PROFILE },
                  catalogSha256: V08_ALIGNED_V1_PRODUCTION_CATALOG_SHA256,
              }
            : {}),
        status: "research_only_no_bake" as const,
        automaticBake: false as const,
        automaticDeploy: false as const,
        measuredAtMs: 1_000_000,
        commit: "a".repeat(40),
        sourceTreeSha256: "b".repeat(64),
        bunVersion: process.versions.bun ?? "test-bun",
        bunRevision: "test-bun-revision",
        bunExecutableSha256: sha256(readFileSync(process.execPath)),
        dependencyManifestSha256: "c".repeat(64),
        lockfileSha256: null,
        hostFingerprintSha256: hostFingerprintSha256(),
        logicalCpus: availableParallelism(),
        workersPerShard: 1,
        concurrentShards: 1,
        sampleProtocol: "all_12_cells_two_seats_persisted_round_robin" as const,
        sampleGamesPerCellSeat: 1,
        sampleGames,
        elapsedMs,
        persistedReplayVerified: true as const,
        workerAttestationsVerified: true as const,
        gamesPerWorkerHour,
        runnerBytesSha256: sourceSha256("v0_7_aligned_96h_v2_runner.ts"),
        evaluatorBytesSha256: sourceSha256("v0_7_aligned_96h_v2_evaluator.ts"),
        workerBytesSha256: sourceSha256("v0_7_aligned_96h_v2_worker.ts"),
        gameAdapterBytesSha256: sourceSha256("v0_7_aligned_96h_v2_game_adapter.ts"),
        ...(v08Profile
            ? {
                  v08GameAdapterBytesSha256: sourceSha256("v0_8_aligned_96h_v1_game_adapter.ts"),
                  v08ProtocolBytesSha256: sourceSha256("v0_8_aligned_96h_v1_protocol.ts"),
              }
            : {}),
    };
    const attestation: IV07AlignedV2ThroughputAttestation = {
        ...unsignedAttestation,
        attestationSha256: fingerprintV07AlignedV2(unsignedAttestation),
    } as IV07AlignedV2ThroughputAttestation;
    const attestationContents = writeCanonical(join(inputs, "throughput.json"), attestation);

    const allocationRequest: IV07AlignedV2SeedAllocationRequest = {
        schemaVersion: 1,
        mode: "synthetic_dry_run",
        allocationId: "aligned-v2-runner-preflight",
        domain: V07_ALIGNED_V2_SEED_ALLOCATION_DOMAIN,
        panels: {
            train: { panelId: "runner-train", scenariosPerCell: 1 },
            confirm: { panelId: "runner-confirm", scenariosPerCell: 1 },
            final: { panelId: "runner-final", scenariosPerCell: 1 },
        },
        maxCandidatesPerSlot: 64,
    };
    const unsignedConfig = {
        schemaVersion: 1 as const,
        artifactKind: "v0_7_aligned_96h_v2_runner_config" as const,
        ...(v08Profile ? { versionProfile: { ...V08_ALIGNED_96H_V1_VERSION_PROFILE } } : {}),
        status: "research_only_no_bake" as const,
        automaticBake: false as const,
        automaticDeploy: false as const,
        mode: "synthetic_preflight" as const,
        seedInputs: {
            secretPath: "secret.bin",
            local: {
                firstSummaryPath: "local/summary.json",
                firstSeedSetPath: "local/seeds.txt",
                replaySummaryPath: "local/summary.json",
                replaySeedSetPath: "local/seeds.txt",
            },
            zinc: {
                firstSummaryPath: "zinc/summary.json",
                firstSeedSetPath: "zinc/seeds.txt",
                replaySummaryPath: "zinc/summary.json",
                replaySeedSetPath: "zinc/seeds.txt",
            },
            committedManifests: [],
        },
        allocationRequest,
        throughput: {
            logicalCpus: availableParallelism(),
            reservedCpus: availableParallelism() > 1 ? 1 : 0,
            workersPerShard: 1,
            concurrentShards: 1,
            maxScenarioPairsPerShard: 12,
            gamesPerWorkerHour,
            utilization: 1,
            safetyFactor: 1,
            panelStartupMinutes: 0,
            shardTimeoutMinutes: 1,
            rateAttestationPath: "throughput.json",
            rateAttestationBytesSha256: sha256(attestationContents),
            rateAttestationSha256: attestation.attestationSha256,
        },
    };
    const config: IV07AlignedV2RunnerConfig = {
        ...unsignedConfig,
        configSha256: fingerprintV07AlignedV2(unsignedConfig),
    };
    const configPath = join(inputs, "runner-config.json");
    const configContents = writeCanonical(configPath, config);

    const composedSealContents = writeCanonical(join(inputs, "composed-seal.json"), {
        schemaVersion: 1,
        artifactKind: "synthetic_composed_seal",
        status: "research_only_no_bake",
    });
    const genomes = (
        v08Profile ? buildV08AlignedV1ProductionCandidateCatalog() : buildV07AlignedV2ProductionCandidateCatalog()
    ).slice(0, 2);
    const startAtMs = 1_000_000;
    const unsignedRequest = {
        schemaVersion: 1 as const,
        artifactKind: "v0_7_aligned_96h_v2_definition_bootstrap_request" as const,
        ...(v08Profile ? { versionProfile: { ...V08_ALIGNED_96H_V1_VERSION_PROFILE } } : {}),
        status: "research_only_no_bake" as const,
        automaticBake: false as const,
        automaticDeploy: false as const,
        runId: "aligned-v2-runner-preflight",
        createdAtMs: startAtMs,
        candidateLimit: 2,
        schedule: {
            startAtMs,
            trainDeadlineAtMs: startAtMs + 24 * HOUR_MS,
            confirmDeadlineAtMs: startAtMs + 60 * HOUR_MS,
            finalDeadlineAtMs: startAtMs + 96 * HOUR_MS,
        },
        candidateGenomes: genomes,
        incumbentGenome: v08Profile
            ? buildV08AlignedV1ProductionIncumbentGenome()
            : buildV07AlignedV2ProductionIncumbentGenome(),
        composedSealPath: "composed-seal.json",
        composedSealBytesSha256: sha256(composedSealContents),
    };
    const request: IV07AlignedV2DefinitionBootstrapRequest = {
        ...unsignedRequest,
        requestSha256: fingerprintV07AlignedV2(unsignedRequest),
    };
    const requestPath = join(inputs, "definition-input.json");
    writeCanonical(requestPath, request);
    const preparedDirectory = join(root, "prepared");
    const bundle = prepareV07AlignedV2DefinitionBundle({ configPath, requestPath, preparedDirectory });
    const definitionPath = join(preparedDirectory, bundle.definitionPath);
    const definition = JSON.parse(readFileSync(definitionPath, "utf8")) as IV07AlignedV2OrchestratorDefinition;
    const outputRoot = join(root, "run-output");
    const orchestratorDirectory = join(outputRoot, "orchestrator");
    const environment: NodeJS.ProcessEnv = {
        V07_ALIGNED_V2_OUT: resolve(orchestratorDirectory),
        V07_ALIGNED_V2_DEFINITION: realpathSync(definitionPath),
        V07_ALIGNED_V2_DEADLINE_MS: String(definition.schedule.finalDeadlineAtMs),
        V07_ALIGNED_V2_DEADLINE_EPOCH: String(Math.floor(definition.schedule.finalDeadlineAtMs / 1000)),
        V07_ALIGNED_V2_RESEARCH_ONLY: "1",
        V07_ALIGNED_V2_NO_BAKE: "1",
        V07_ALIGNED_V2_NO_DEPLOY: "1",
        V07_ALIGNED_V2_RUNNER_CONFIG_SHA256: config.configSha256,
        V07_ALIGNED_V2_RUNNER_CONFIG_BYTES_SHA256: sha256(configContents),
        V07_ALIGNED_V2_RATE_ATTESTATION_SHA256: attestation.attestationSha256,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    };
    return {
        root,
        configPath,
        requestPath,
        preparedDirectory,
        outputRoot,
        orchestratorDirectory,
        bundle,
        definition,
        environment,
        startAtMs,
    };
}

function nestedFiles(root: string, name: string): string[] {
    const found: string[] = [];
    const visit = (directory: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) visit(path);
            else if (entry.isFile() && entry.name === name) found.push(path);
        }
    };
    visit(root);
    return found.sort();
}

function auditSourcePaths(outputRoot: string): string[] {
    return nestedFiles(join(outputRoot, "evidence"), "audit-index.json").flatMap((path) => {
        const index = JSON.parse(readFileSync(path, "utf8")) as { workers: { sourcePath: string }[] };
        return index.workers.map((entry) => entry.sourcePath);
    });
}

describe("v0.7 aligned 96-hour v2 exact runner", () => {
    it("dispatches schema-2 throughput evidence only to its exact version profile", () => {
        const digest = "a".repeat(64);
        const budget = {
            logicalCpus: availableParallelism(),
            reservedCpus: 0,
            workersPerShard: 1,
            concurrentShards: 1,
            maxScenarioPairsPerShard: 1,
            gamesPerWorkerHour: 1,
            utilization: 0.8,
            safetyFactor: 1,
            panelStartupMinutes: 1,
            shardTimeoutMinutes: 1,
            rateAttestationPath: "throughput.json",
            rateAttestationBytesSha256: digest,
            rateAttestationSha256: digest,
        };
        const common = {
            schemaVersion: 2,
            status: "research_only_no_bake",
            automaticBake: false,
            automaticDeploy: false,
            measuredAtMs: -1,
            commit: "b".repeat(40),
            sourceTreeSha256: digest,
            bunVersion: process.versions.bun ?? "test-bun",
            bunRevision: "test-revision",
            bunExecutableSha256: digest,
            dependencyManifestSha256: digest,
            lockfileSha256: null,
            hostFingerprintSha256: digest,
            logicalCpus: availableParallelism(),
            reservedCpus: 0,
            workersPerShard: 1,
            concurrentShards: 1,
            maxScenarioPairsPerShard: 1,
            shardTimeoutMinutes: 1,
            sampleProtocol: "all_12_cells_two_seats_8_sequential_batches_persisted_replay",
            sampleGamesPerCellSeat: V07_ALIGNED_V2_THROUGHPUT_SCENARIOS_PER_CELL,
            sampleGames: V07_ALIGNED_V2_THROUGHPUT_GAMES,
            batchCount: V07_ALIGNED_V2_THROUGHPUT_BATCHES,
            totalElapsedMs: 1,
            persistedReplayVerified: true,
            workerAttestationsVerified: true,
            gamesPerWorkerHour: 1,
            evidenceRootPath: "evidence",
            evidenceManifestBytesSha256: digest,
            evidenceManifestSha256: digest,
            attestationSha256: digest,
        };
        const v08Attestation = {
            ...common,
            artifactKind: "v0_8_aligned_96h_v1_throughput_attestation",
            versionProfile: { ...V08_ALIGNED_96H_V1_VERSION_PROFILE },
            catalogSha256: V08_ALIGNED_V1_PRODUCTION_CATALOG_SHA256,
            worstCostGenomeSha256: V08_ALIGNED_V1_THROUGHPUT_WORST_COST_GENOME_SHA256,
            code: buildV08AlignedV1ThroughputCodeLedger(),
        };
        const v07Attestation = {
            ...common,
            artifactKind: "v0_7_aligned_96h_v2_throughput_attestation",
            throughputBytesSha256: digest,
            runnerBytesSha256: digest,
            evaluatorBytesSha256: digest,
            workerBytesSha256: digest,
            gameAdapterBytesSha256: digest,
            persistenceBytesSha256: digest,
            protocolBytesSha256: digest,
            seedAllocatorBytesSha256: digest,
            catalogBytesSha256: digest,
        };
        const v07Context = { mode: "production" as const, configRoot: "." };
        const v08Context = {
            ...v07Context,
            versionProfile: V08_ALIGNED_96H_V1_VERSION_PROFILE,
        };

        expect(() => validateV07AlignedV2ThroughputAttestation(v08Attestation, budget, v08Context)).toThrow(
            "production throughput measuredAtMs must be an integer >= 0",
        );
        expect(() => validateV07AlignedV2ThroughputAttestation(v07Attestation, budget, v07Context)).toThrow(
            "production throughput measuredAtMs must be an integer >= 0",
        );
        expect(() => validateV07AlignedV2ThroughputAttestation(v07Attestation, budget, v08Context)).toThrow(
            "production throughput attestation header/fields are invalid",
        );
        expect(() => validateV07AlignedV2ThroughputAttestation(v08Attestation, budget, v07Context)).toThrow(
            "production throughput attestation header/fields are invalid",
        );
    });

    it("atomically prepares the commitment and definition without revealing final seeds or starting work", () => {
        const fixture = runnerFixture();
        try {
            expect(fixture.bundle).toMatchObject({
                status: "research_only_no_bake",
                automaticBake: false,
                automaticDeploy: false,
                gamesExecuted: 0,
                workersStarted: 0,
                commitmentPath: "seed-allocation/commitment.json",
                definitionPath: "definition.json",
            });
            expect(fixture.bundle.configBytesSha256).toBe(sha256(readFileSync(fixture.configPath)));
            const config = validateV07AlignedV2RunnerConfig(JSON.parse(readFileSync(fixture.configPath, "utf8")));
            const v08UnsignedConfig = { ...config, versionProfile: { ...V08_ALIGNED_96H_V1_VERSION_PROFILE } };
            delete (v08UnsignedConfig as Partial<IV07AlignedV2RunnerConfig>).configSha256;
            const v08Config = {
                ...v08UnsignedConfig,
                configSha256: fingerprintV07AlignedV2(v08UnsignedConfig),
            };
            expect(validateV07AlignedV2RunnerConfig(v08Config).versionProfile).toEqual(
                V08_ALIGNED_96H_V1_VERSION_PROFILE,
            );
            const wrongProfile = structuredClone(v08UnsignedConfig);
            (wrongProfile.versionProfile as { opponent: string }).opponent = "v0.6";
            expect(() =>
                validateV07AlignedV2RunnerConfig({
                    ...wrongProfile,
                    configSha256: fingerprintV07AlignedV2(wrongProfile),
                }),
            ).toThrow("v0.8s/v0.8 versus v0.7");
            expect(
                validateV07AlignedV2ThroughputAttestation(
                    JSON.parse(readFileSync(join(dirname(fixture.configPath), "throughput.json"), "utf8")),
                    config.throughput,
                ).attestationSha256,
            ).toBe(fixture.bundle.rateAttestationSha256);
            const syntheticAttestation = JSON.parse(
                readFileSync(join(dirname(fixture.configPath), "throughput.json"), "utf8"),
            );
            expect(() =>
                validateV07AlignedV2ThroughputAttestation(syntheticAttestation, config.throughput, {
                    mode: "production",
                    configRoot: dirname(fixture.configPath),
                }),
            ).toThrow("production mode requires schema-2 replayable throughput evidence");
            expect(() =>
                validateV07AlignedV2ThroughputAttestation({ schemaVersion: 2 }, config.throughput, {
                    mode: "synthetic_preflight",
                    configRoot: dirname(fixture.configPath),
                }),
            ).toThrow("replayable production throughput evidence is valid only in production mode");
            expect(readdirSync(fixture.preparedDirectory).sort()).toEqual([
                "bundle.json",
                "definition.json",
                "seed-allocation",
            ]);
            expect(readdirSync(join(fixture.preparedDirectory, "seed-allocation"))).toEqual(["commitment.json"]);
            const commitment = JSON.parse(
                readFileSync(join(fixture.preparedDirectory, fixture.bundle.commitmentPath), "utf8"),
            ) as Record<string, unknown>;
            expect(commitment.finalPlan).toBeUndefined();
            expect(commitment.finalTaskCount).toBe(24);
            expect(commitment.finalTasksSha256).toMatch(/^[0-9a-f]{64}$/);
            expect(
                prepareV07AlignedV2DefinitionBundle({
                    configPath: fixture.configPath,
                    requestPath: fixture.requestPath,
                    preparedDirectory: fixture.preparedDirectory,
                }),
            ).toEqual(fixture.bundle);

            writeFileSync(join(fixture.preparedDirectory, "definition.json"), "{}\n", "utf8");
            expect(() =>
                prepareV07AlignedV2DefinitionBundle({
                    configPath: fixture.configPath,
                    requestPath: fixture.requestPath,
                    preparedDirectory: fixture.preparedDirectory,
                }),
            ).toThrow("bundle file differs");
        } finally {
            rmSync(fixture.root, { recursive: true, force: true });
        }
    });

    it("runs and replays a supervisor-bound filesystem preflight with zero games and workers", async () => {
        const fixture = runnerFixture();
        let evaluatorCalls = 0;
        const invoke = () =>
            runV07AlignedV2Runner({
                configPath: fixture.configPath,
                definitionPath: join(fixture.preparedDirectory, fixture.bundle.definitionPath),
                orchestratorDirectory: fixture.orchestratorDirectory,
                preflight: true,
                environment: fixture.environment,
                dependencies: {
                    nowMs: () => fixture.startAtMs + 1,
                    evaluateShard: async () => {
                        evaluatorCalls += 1;
                        throw new Error("synthetic preflight must not invoke the evaluator");
                    },
                },
            });
        try {
            const first = await invoke();
            expect(first).toMatchObject({
                invocationGamesExecuted: 0,
                invocationWorkersStarted: 0,
                persistedGames: 0,
                persistedShards: 4,
                remainingCapacity: {
                    phase: "terminal",
                    remainingTrainGames: 0,
                    remainingConfirmGames: 0,
                    remainingFinalGames: 0,
                },
            });
            expect(first.finalRevealRef).not.toBeNull();
            expect(evaluatorCalls).toBe(0);
            const firstHeartbeat = JSON.parse(
                readFileSync(join(fixture.outputRoot, "runner.heartbeat.json"), "utf8"),
            ) as IV07AlignedV2RunnerHeartbeat;
            expect(firstHeartbeat).toMatchObject({
                artifactKind: "v0_7_aligned_96h_v2_runner_heartbeat",
                phase: "terminal",
                completedShards: 4,
                completedGames: 0,
            });
            const { heartbeatSha256, ...unsignedHeartbeat } = firstHeartbeat;
            expect(heartbeatSha256).toBe(fingerprintV07AlignedV2(unsignedHeartbeat));
            expect(validateV07AlignedV2RunnerHeartbeat(firstHeartbeat, fixture.definition.definitionSha256)).toEqual(
                firstHeartbeat,
            );
            const sourcePaths = auditSourcePaths(fixture.outputRoot);
            expect(sourcePaths).toHaveLength(4);
            expect(new Set(sourcePaths).size).toBe(sourcePaths.length);

            const second = await invoke();
            expect(second.terminalSha256).toBe(first.terminalSha256);
            expect(second).toMatchObject({
                invocationGamesExecuted: 0,
                invocationWorkersStarted: 0,
                persistedGames: first.persistedGames,
                persistedShards: first.persistedShards,
                remainingCapacity: {
                    phase: "terminal",
                    remainingTrainGames: 0,
                    remainingConfirmGames: 0,
                    remainingFinalGames: 0,
                },
            });
            expect(auditSourcePaths(fixture.outputRoot)).toEqual(sourcePaths);
            const secondHeartbeat = JSON.parse(
                readFileSync(join(fixture.outputRoot, "runner.heartbeat.json"), "utf8"),
            ) as IV07AlignedV2RunnerHeartbeat;
            expect(secondHeartbeat.sequence).toBeGreaterThan(firstHeartbeat.sequence);
            expect(secondHeartbeat.completedShards).toBe(firstHeartbeat.completedShards);

            const resolvers = createV07AlignedV2FilesystemReplayResolvers({
                artifactRoot: fixture.outputRoot,
                definition: fixture.definition,
            });
            const replay = loadV07AlignedV2PersistedOrchestrator(
                fixture.orchestratorDirectory,
                resolvers,
                fixture.definition,
            );
            expect(replay.state.terminal?.terminalSha256).toBe(first.terminalSha256);
            expect(
                validateV07AlignedV2TerminalReplay(fixture.orchestratorDirectory, fixture.definition, resolvers)
                    ?.terminalSha256,
            ).toBe(first.terminalSha256);
        } finally {
            rmSync(fixture.root, { recursive: true, force: true });
        }
    });

    it("runs the complete v0.8 bootstrap, synthetic lifecycle, terminal replay, and restart with zero games", async () => {
        const fixture = runnerFixture(V08_ALIGNED_96H_V1_VERSION_PROFILE);
        let evaluatorCalls = 0;
        const invoke = () =>
            runV07AlignedV2Runner({
                configPath: fixture.configPath,
                definitionPath: join(fixture.preparedDirectory, fixture.bundle.definitionPath),
                orchestratorDirectory: fixture.orchestratorDirectory,
                preflight: true,
                environment: fixture.environment,
                dependencies: {
                    nowMs: () => fixture.startAtMs + 1,
                    evaluateShard: async () => {
                        evaluatorCalls += 1;
                        throw new Error("v0.8 synthetic lifecycle must not invoke the evaluator");
                    },
                },
            });
        try {
            expect(fixture.definition).toMatchObject({
                artifactKind: "v0_8_aligned_96h_v1_orchestrator_definition",
                versionProfile: V08_ALIGNED_96H_V1_VERSION_PROFILE,
            });
            expect(
                [...fixture.definition.candidates, fixture.definition.incumbent].every(
                    (binding) => binding.candidate === "v0.8s" && binding.opponent === "v0.7",
                ),
            ).toBe(true);

            const first = await invoke();
            expect(first).toMatchObject({
                invocationGamesExecuted: 0,
                invocationWorkersStarted: 0,
                persistedGames: 0,
                persistedShards: 5,
                remainingCapacity: { phase: "terminal" },
            });
            expect(evaluatorCalls).toBe(0);
            const bindingPaths = nestedFiles(fixture.outputRoot, "binding.json");
            expect(bindingPaths).toHaveLength(5);
            expect(
                bindingPaths.every((path) => {
                    const binding = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
                    return (
                        binding.artifactKind === "v0_8_aligned_96h_v1_candidate_binding" &&
                        binding.candidate === "v0.8s" &&
                        binding.opponent === "v0.7"
                    );
                }),
            ).toBe(true);
            const evidenceDirectories = bindingPaths.map((path) => path.split("/evidence/")[1] ?? "");
            expect(evidenceDirectories.some((path) => path.startsWith("train/"))).toBe(true);
            expect(evidenceDirectories.some((path) => path.startsWith("confirm/"))).toBe(true);
            expect(evidenceDirectories.some((path) => path.startsWith("final/"))).toBe(true);

            const second = await invoke();
            expect(second.terminalSha256).toBe(first.terminalSha256);
            expect(second.persistedShards).toBe(first.persistedShards);
            expect(second.invocationGamesExecuted).toBe(0);
            expect(evaluatorCalls).toBe(0);

            const resolvers = createV07AlignedV2FilesystemReplayResolvers({
                artifactRoot: fixture.outputRoot,
                definition: fixture.definition,
            });
            const replay = loadV07AlignedV2PersistedOrchestrator(
                fixture.orchestratorDirectory,
                resolvers,
                fixture.definition,
            );
            expect(replay.state.terminal).toMatchObject({
                terminalSha256: first.terminalSha256,
                reason: "confirm_hold",
                verdict: "HOLD",
                final: null,
            });
            expect(replay.state.terminal?.promotion).not.toBeNull();
            expect(
                validateV07AlignedV2TerminalReplay(fixture.orchestratorDirectory, fixture.definition, resolvers)
                    ?.terminalSha256,
            ).toBe(first.terminalSha256);
        } finally {
            rmSync(fixture.root, { recursive: true, force: true });
        }
    });

    it("keeps interrupted prepared-directory quarantine terminal across repeated preparation", () => {
        const fixture = runnerFixture();
        try {
            rmSync(fixture.preparedDirectory, { recursive: true });
            const temporaryPrefix = `.${basename(fixture.preparedDirectory)}.tmp-`;
            const maximumLengthTemporary = `${temporaryPrefix}${"x".repeat(255 - Buffer.byteLength(temporaryPrefix))}`;
            mkdirSync(join(dirname(fixture.preparedDirectory), maximumLengthTemporary));

            expect(
                prepareV07AlignedV2DefinitionBundle({
                    configPath: fixture.configPath,
                    requestPath: fixture.requestPath,
                    preparedDirectory: fixture.preparedDirectory,
                }),
            ).toEqual(fixture.bundle);
            const terminalInventory = readdirSync(fixture.root).sort();
            const quarantineNames = terminalInventory.filter((name) =>
                name.startsWith(".v07-aligned-v2-quarantine-abandoned-"),
            );
            expect(quarantineNames).toHaveLength(1);
            expect(Buffer.byteLength(quarantineNames[0])).toBeLessThanOrEqual(255);
            for (let restart = 0; restart < 16; restart += 1) {
                expect(
                    prepareV07AlignedV2DefinitionBundle({
                        configPath: fixture.configPath,
                        requestPath: fixture.requestPath,
                        preparedDirectory: fixture.preparedDirectory,
                    }),
                ).toEqual(fixture.bundle);
                expect(readdirSync(fixture.root).sort()).toEqual(terminalInventory);
            }
        } finally {
            rmSync(fixture.root, { recursive: true, force: true });
        }
    });

    it("quarantines interrupted atomic temporaries once with bounded terminal names", () => {
        const root = mkdtempSync(join(tmpdir(), "aligned-v2-runner-atomic-"));
        const destination = join(root, "runner.heartbeat.json");
        const temporaryPrefix = ".runner.heartbeat.json.tmp-";
        const maximumLengthTemporary = `${temporaryPrefix}${"x".repeat(255 - Buffer.byteLength(temporaryPrefix))}`;
        const legacyAbandonedTemporary = `${temporaryPrefix}123-${"a".repeat(36)}.abandoned-1-2-${"b".repeat(36)}`;
        try {
            writeFileSync(join(root, maximumLengthTemporary), "maximum\n", "utf8");
            writeFileSync(join(root, legacyAbandonedTemporary), "legacy\n", "utf8");

            const quarantined = quarantineV07AlignedV2RunnerAtomicTemporaries(destination);
            expect(quarantined).toHaveLength(2);
            expect(new Set(quarantined).size).toBe(2);
            expect(quarantined.map((path) => readFileSync(path, "utf8")).sort()).toEqual(["legacy\n", "maximum\n"]);
            for (const path of quarantined) {
                expect(basename(path)).toMatch(
                    /^\.v07-aligned-v2-quarantine-abandoned-[0-9a-f]{16}-\d+-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
                );
                expect(Buffer.byteLength(basename(path))).toBeLessThanOrEqual(255);
            }

            const terminalInventory = readdirSync(root).sort();
            for (let restart = 0; restart < 32; restart += 1) {
                expect(quarantineV07AlignedV2RunnerAtomicTemporaries(destination)).toEqual([]);
                expect(readdirSync(root).sort()).toEqual(terminalInventory);
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("fails closed on supervisor provenance and impossible host/shard budgets", async () => {
        const fixture = runnerFixture();
        try {
            await expect(
                runV07AlignedV2Runner({
                    configPath: fixture.configPath,
                    definitionPath: join(fixture.preparedDirectory, fixture.bundle.definitionPath),
                    orchestratorDirectory: fixture.orchestratorDirectory,
                    preflight: true,
                    environment: { ...fixture.environment, V07_ALIGNED_V2_RUNNER_CONFIG_SHA256: "0".repeat(64) },
                    dependencies: { nowMs: () => fixture.startAtMs + 1 },
                }),
            ).rejects.toThrow("supervisor protocol mismatch for V07_ALIGNED_V2_RUNNER_CONFIG_SHA256");
            expect(existsSync(join(fixture.outputRoot, "seed-allocation", "commitment.json"))).toBe(false);
            await expect(
                runV07AlignedV2Runner({
                    configPath: fixture.configPath,
                    definitionPath: join(fixture.preparedDirectory, fixture.bundle.definitionPath),
                    orchestratorDirectory: fixture.orchestratorDirectory,
                    preflight: true,
                    environment: fixture.environment,
                    dependencies: {
                        nowMs: () => fixture.definition.schedule.trainDeadlineAtMs - 1,
                        evaluateShard: async () => {
                            throw new Error("impossible remaining capacity must not launch evaluation");
                        },
                    },
                }),
            ).rejects.toThrow("remaining capacity is impossible in training");
            expect(() =>
                validateV07AlignedV2RunnerBudget(
                    {
                        ...(JSON.parse(readFileSync(fixture.configPath, "utf8")) as IV07AlignedV2RunnerConfig),
                        throughput: {
                            ...(JSON.parse(readFileSync(fixture.configPath, "utf8")) as IV07AlignedV2RunnerConfig)
                                .throughput,
                            gamesPerWorkerHour: 0.001,
                        },
                    },
                    fixture.definition,
                ),
            ).toThrow("throughput budget is impossible");
            expect(() =>
                validateV07AlignedV2RunnerBudget(
                    {
                        ...(JSON.parse(readFileSync(fixture.configPath, "utf8")) as IV07AlignedV2RunnerConfig),
                        throughput: {
                            ...(JSON.parse(readFileSync(fixture.configPath, "utf8")) as IV07AlignedV2RunnerConfig)
                                .throughput,
                            logicalCpus: availableParallelism() + 1,
                        },
                    },
                    fixture.definition,
                ),
            ).toThrow("!= host");
            const negativeStartup = JSON.parse(readFileSync(fixture.configPath, "utf8")) as Record<string, unknown>;
            (negativeStartup.throughput as Record<string, unknown>).panelStartupMinutes = -0.5;
            delete negativeStartup.configSha256;
            negativeStartup.configSha256 = fingerprintV07AlignedV2(negativeStartup);
            expect(() => validateV07AlignedV2RunnerConfig(negativeStartup)).toThrow(
                "panelStartupMinutes must be finite and >= 0",
            );
        } finally {
            rmSync(fixture.root, { recursive: true, force: true });
        }
    });

    it("parses the dedicated preparation command separately from run and preflight", () => {
        expect(
            parseV07AlignedV2RunnerArgs(
                [
                    "--prepare-definition",
                    "--config=runner.json",
                    "--definition-input=definition-input.json",
                    "--prepared-dir=prepared",
                ],
                "/tmp/aligned-v2",
            ),
        ).toEqual({
            command: "prepare_definition",
            configPath: "/tmp/aligned-v2/runner.json",
            requestPath: "/tmp/aligned-v2/definition-input.json",
            preparedDirectory: "/tmp/aligned-v2/prepared",
        });
        expect(parseV07AlignedV2RunnerArgs(["--preflight", "--config=runner.json"], "/tmp/aligned-v2")).toEqual({
            command: "run",
            configPath: "/tmp/aligned-v2/runner.json",
            preflight: true,
        });
        expect(() =>
            parseV07AlignedV2RunnerArgs(["--prepare-definition", "--config=runner.json"], "/tmp/aligned-v2"),
        ).toThrow("requires --definition-input");
    });
});
