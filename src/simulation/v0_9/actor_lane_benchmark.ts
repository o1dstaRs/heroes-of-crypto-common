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

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { arch, freemem, hostname, loadavg, platform, release } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";

import { discoverV09ActorCpuTopology, parseV09LinuxCpuList } from "./actor_cpu_topology";
import {
    buildV09CampaignManifest,
    buildV09DevelopmentActorPhysicalCorePolicy,
    buildV09SeedLedger,
    initializeV09Campaign,
    v09CampaignRunFingerprint,
    V09_RTX5090_GPU_UUID,
    type IV09CampaignIdentity,
    type V09SeedPurpose,
} from "./campaign";
import {
    V09_ACTOR_LANE_SELECTION_POLICY,
    V09_AUDITED_ACTOR_LANE_COUNTS,
    sealV09ActorLaneBenchmarkReceipt,
    validateV09ActorLaneBenchmarkReceipt,
    type IV09ActorLaneBenchmarkHost,
    type IV09ActorLaneBenchmarkIdleEvidence,
    type IV09ActorLaneBenchmarkInput,
    type IV09ActorLaneBenchmarkReceipt,
    type IV09ActorLaneBenchmarkRun,
    type V09ActorLaneBenchmarkMode,
} from "./actor_lane_benchmark_receipt";
import { runV09ActorCommandsFailFast, type IV09ActorCommandLaunch, type ICommandResult } from "./orchestrator";
import { validateV09GameShard } from "./recorder";
import { verifyV09SourceIdentity, writeV09SourceIdentity, type IV09SourceIdentityReceipt } from "./source_identity";
import {
    assertV09OutputIsolation,
    canonicalV09PathThroughExistingAncestor,
    writeV09V08ProtectionReceipt,
} from "./supervisor";

export interface IV09ActorLaneBenchmarkPlanEntry {
    sequence: number;
    repetition: number;
    workers: number;
}

export interface IV09ActorLaneBenchmarkPlan {
    mode: V09ActorLaneBenchmarkMode;
    candidates: number[];
    panelGames: number;
    repetitions: number;
    entries: IV09ActorLaneBenchmarkPlanEntry[];
}

export interface IV09ActorLaneBenchmarkOptions {
    outputDirectory: string;
    repositoryRoot: string;
    sourceReceiptPath: string;
    gpuUuid: string;
    protectedV08Roots: readonly string[];
    panelGames: number;
    repetitions: number;
}

export type IV09ActorLaneBenchmarkReceiptBase = Omit<IV09ActorLaneBenchmarkInput, "runs" | "completedAt">;

export type V09ActorLaneBenchmarkExecutor = (
    entry: IV09ActorLaneBenchmarkPlanEntry,
) => Promise<IV09ActorLaneBenchmarkRun>;

interface IHostInspection {
    host: IV09ActorLaneBenchmarkHost;
    idle: IV09ActorLaneBenchmarkIdleEvidence;
    temperaturePaths: string[];
    throttlePaths: string[];
}

const CONFLICTING_PROCESS =
    /(?:src\/simulation\/v0_9\/teacher_actor\.ts|src\/simulation\/v0_9\/orchestrator\.ts\s+(?:launch|resume|actors|learner|smoke)|src\/simulation\/v0_9\/python\/learner\.py|src\/simulation\/v0_9\/qualify\.ts|src\/simulation\/run_(?:tournament|match)\.ts|src\/simulation\/measure_mirror_cohorts\.ts|src\/simulation\/optimizer\/)/;

function parsePositiveInteger(value: string | undefined, fallback: number, context: string): number {
    const parsed = value === undefined ? fallback : Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${context} must be a positive integer`);
    return parsed;
}

export function buildV09ActorLaneBenchmarkPlan(options: {
    mode: V09ActorLaneBenchmarkMode;
    candidates?: readonly number[];
    panelGames: number;
    repetitions: number;
}): IV09ActorLaneBenchmarkPlan {
    const candidates = [...(options.candidates ?? V09_AUDITED_ACTOR_LANE_COUNTS)];
    if (
        !candidates.length ||
        candidates.some((candidate) => !Number.isSafeInteger(candidate) || candidate < 1) ||
        new Set(candidates).size !== candidates.length
    ) {
        throw new Error("actor lane candidates must be unique positive integers");
    }
    candidates.sort((left, right) => left - right);
    if (!Number.isSafeInteger(options.panelGames) || options.panelGames < 1) {
        throw new Error("actor lane panelGames must be a positive integer");
    }
    if (!Number.isSafeInteger(options.repetitions) || options.repetitions < 1) {
        throw new Error("actor lane repetitions must be a positive integer");
    }
    if (options.mode === "production") {
        if (
            candidates.length !== V09_AUDITED_ACTOR_LANE_COUNTS.length ||
            candidates.some((candidate, index) => candidate !== V09_AUDITED_ACTOR_LANE_COUNTS[index])
        ) {
            throw new Error("production actor benchmark candidates are restricted to 20/22/23/24");
        }
        if (
            options.panelGames < V09_ACTOR_LANE_SELECTION_POLICY.minimumProductionPanelGames ||
            options.repetitions < V09_ACTOR_LANE_SELECTION_POLICY.minimumProductionRepetitions
        ) {
            throw new Error("production actor benchmark panel/repetitions are below the audited minimum");
        }
    }
    const entries: IV09ActorLaneBenchmarkPlanEntry[] = [];
    for (let repetition = 0; repetition < options.repetitions; repetition += 1) {
        const ordered = repetition % 2 === 0 ? candidates : [...candidates].reverse();
        for (const workers of ordered) {
            entries.push({ sequence: entries.length, repetition, workers });
        }
    }
    return {
        mode: options.mode,
        candidates,
        panelGames: options.panelGames,
        repetitions: options.repetitions,
        entries,
    };
}

/**
 * Execute a prevalidated plan serially so candidate runs cannot overlap or contaminate each other's timing.
 * This seam also permits a tiny in-memory fixture to exercise the real ordering, fail-fast, thermal, sealing,
 * and selection path without launching production actors.
 */
export async function executeV09ActorLaneBenchmarkPlan(
    plan: IV09ActorLaneBenchmarkPlan,
    receiptBase: IV09ActorLaneBenchmarkReceiptBase,
    executor: V09ActorLaneBenchmarkExecutor,
    completedAt: () => string = () => new Date().toISOString(),
): Promise<IV09ActorLaneBenchmarkReceipt> {
    if (
        receiptBase.mode !== plan.mode ||
        receiptBase.panel.games !== plan.panelGames ||
        receiptBase.panel.repetitions !== plan.repetitions
    ) {
        throw new Error("actor benchmark execution plan does not match its receipt base");
    }
    const runs: IV09ActorLaneBenchmarkRun[] = [];
    for (const entry of plan.entries) {
        const run = await executor(entry);
        if (run.sequence !== entry.sequence || run.repetition !== entry.repetition || run.workers !== entry.workers) {
            throw new Error(`actor benchmark executor returned the wrong identity for sequence ${entry.sequence}`);
        }
        if (
            receiptBase.mode === "production" &&
            (run.peakTemperatureC > V09_ACTOR_LANE_SELECTION_POLICY.maximumTemperatureC ||
                run.throttleCountAfter !== run.throttleCountBefore)
        ) {
            throw new Error(`actor benchmark candidate ${entry.workers} failed thermal safety`);
        }
        runs.push(run);
    }
    return validateV09ActorLaneBenchmarkReceipt(
        sealV09ActorLaneBenchmarkReceipt({
            ...receiptBase,
            runs,
            completedAt: completedAt(),
        }),
    );
}

export function parseV09CpuList(value: string): number[] {
    return parseV09LinuxCpuList(value);
}

function command(executable: string, args: readonly string[]): string {
    const result = spawnSync(executable, args, { encoding: "utf8" });
    if (result.status !== 0) {
        throw new Error(`${executable} ${args.join(" ")} failed: ${result.stderr.trim()}`);
    }
    return result.stdout;
}

function cpuModel(): string {
    const cpuInfo = readFileSync("/proc/cpuinfo", "utf8");
    const match = /^model name\s*:\s*(.+)$/m.exec(cpuInfo);
    if (!match) throw new Error("cannot read CPU model from /proc/cpuinfo");
    return match[1]!.trim();
}

function hwmonTelemetryPaths(): { temperaturePaths: string[]; throttlePaths: string[] } {
    const temperaturePaths: string[] = [];
    const hwmonRoot = "/sys/class/hwmon";
    if (existsSync(hwmonRoot)) {
        for (const directory of readdirSync(hwmonRoot).sort()) {
            const root = resolve(hwmonRoot, directory);
            if (!statSync(root).isDirectory()) continue;
            const namePath = resolve(root, "name");
            const name = existsSync(namePath) ? readFileSync(namePath, "utf8").trim().toLowerCase() : "";
            if (["nvme", "amdgpu", "nouveau"].some((prefix) => name.startsWith(prefix))) continue;
            for (const file of readdirSync(root).sort()) {
                if (/^temp\d+_input$/.test(file)) temperaturePaths.push(resolve(root, file));
            }
        }
    }
    const throttlePaths: string[] = [];
    const cpuRoot = "/sys/devices/system/cpu";
    if (existsSync(cpuRoot)) {
        for (const directory of readdirSync(cpuRoot)
            .filter((entry) => /^cpu\d+$/.test(entry))
            .sort()) {
            const root = resolve(cpuRoot, directory, "thermal_throttle");
            if (!existsSync(root)) continue;
            for (const file of ["core_throttle_count", "package_throttle_count"]) {
                const path = resolve(root, file);
                if (existsSync(path)) throttlePaths.push(path);
            }
        }
    }
    return {
        temperaturePaths: [...new Set(temperaturePaths)].sort(),
        throttlePaths: [...new Set(throttlePaths)].sort(),
    };
}

function readPeakTemperature(paths: readonly string[]): number {
    const values = paths.map((path) => {
        const raw = Number(readFileSync(path, "utf8").trim());
        if (!Number.isFinite(raw) || raw < 0) throw new Error(`invalid temperature telemetry at ${path}`);
        return raw > 1_000 ? raw / 1_000 : raw;
    });
    if (!values.length) throw new Error("CPU temperature telemetry is unavailable");
    return Math.max(...values);
}

function readThrottleCount(paths: readonly string[]): number {
    if (!paths.length) throw new Error("CPU thermal-throttle telemetry is unavailable");
    return paths.reduce((sum, path) => {
        const value = Number(readFileSync(path, "utf8").trim());
        if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid throttle telemetry at ${path}`);
        return sum + value;
    }, 0);
}

function cpuTotals(): { idle: number; total: number } {
    const line = readFileSync("/proc/stat", "utf8").split(/\r?\n/, 1)[0];
    const fields = line?.trim().split(/\s+/);
    if (!fields || fields[0] !== "cpu" || fields.length < 6) {
        throw new Error("cannot read aggregate CPU utilization from /proc/stat");
    }
    const counters = fields.slice(1).map(Number);
    if (counters.some((value) => !Number.isFinite(value) || value < 0)) {
        throw new Error("invalid aggregate CPU counters in /proc/stat");
    }
    return {
        idle: counters[3]! + (counters[4] ?? 0),
        total: counters.reduce((sum, value) => sum + value, 0),
    };
}

async function instantaneousCpuUtilization(): Promise<number> {
    const before = cpuTotals();
    await Bun.sleep(250);
    const after = cpuTotals();
    const total = after.total - before.total;
    const idle = after.idle - before.idle;
    if (!(total > 0) || idle < 0 || idle > total) throw new Error("aggregate CPU counters did not advance");
    return (total - idle) / total;
}

function conflictingProcesses(): string[] {
    const output = command("ps", ["-eo", "pid=,args="]);
    return output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => {
            const pid = Number(/^(\d+)/.exec(line)?.[1]);
            return pid !== process.pid && CONFLICTING_PROCESS.test(line);
        });
}

function gpuComputePids(gpuUuid: string): number[] {
    const output = command("nvidia-smi", [
        `--id=${gpuUuid}`,
        "--query-compute-apps=pid",
        "--format=csv,noheader,nounits",
    ]);
    return output
        .split(/\r?\n/)
        .map((line) => Number(line.trim()))
        .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

function assertGpu(gpuUuid: string): void {
    if (gpuUuid !== V09_RTX5090_GPU_UUID) {
        throw new Error(`actor benchmark requires the approved RTX 5090 UUID ${V09_RTX5090_GPU_UUID}`);
    }
    const observed = command("nvidia-smi", [
        `--id=${gpuUuid}`,
        "--query-gpu=uuid",
        "--format=csv,noheader,nounits",
    ]).trim();
    if (observed !== gpuUuid) throw new Error(`nvidia-smi resolved unexpected GPU ${observed}`);
}

export function inspectV09ActorLaneBenchmarkHost(gpuUuid: string): IHostInspection {
    assertGpu(gpuUuid);
    const topology = discoverV09ActorCpuTopology();
    const telemetry = hwmonTelemetryPaths();
    const maximumLoadOne = Math.max(1, topology.physicalCpuIds.length * 0.1);
    return {
        host: {
            hostname: hostname(),
            platform: platform(),
            architecture: arch(),
            release: release(),
            bunVersion: Bun.version,
            cpuModel: cpuModel(),
            logicalCpuCount: topology.allowedLogicalCpuIds.length,
            allowedLogicalCpuIds: topology.allowedLogicalCpuIds,
            physicalCpuIds: topology.physicalCpuIds,
            topologySha256: topology.topologySha256,
            gpuUuid,
            temperatureSensorCount: telemetry.temperaturePaths.length,
            throttleCounterCount: telemetry.throttlePaths.length,
        },
        idle: {
            checkedAt: new Date().toISOString(),
            loadOne: loadavg()[0],
            maximumLoadOne,
            freeMemoryBytes: freemem(),
            conflictingProcesses: conflictingProcesses(),
            gpuComputePids: gpuComputePids(gpuUuid),
        },
        ...telemetry,
    };
}

function assertProductionHost(inspection: IHostInspection): void {
    const { host, idle } = inspection;
    if (
        host.platform !== V09_ACTOR_LANE_SELECTION_POLICY.requiredPlatform ||
        host.architecture !== V09_ACTOR_LANE_SELECTION_POLICY.requiredArchitecture ||
        host.bunVersion !== V09_ACTOR_LANE_SELECTION_POLICY.requiredBunVersion
    ) {
        throw new Error(
            `actor benchmark requires ${V09_ACTOR_LANE_SELECTION_POLICY.requiredPlatform}/` +
                `${V09_ACTOR_LANE_SELECTION_POLICY.requiredArchitecture} and Bun ` +
                V09_ACTOR_LANE_SELECTION_POLICY.requiredBunVersion,
        );
    }
    if (host.physicalCpuIds.length < Math.max(...V09_AUDITED_ACTOR_LANE_COUNTS)) {
        throw new Error("actor benchmark requires 24 affinity-allowed physical CPU lanes");
    }
    if (!host.temperatureSensorCount || !host.throttleCounterCount) {
        throw new Error("actor benchmark requires CPU temperature and thermal-throttle telemetry");
    }
    if (idle.conflictingProcesses.length) {
        throw new Error(`actor benchmark found conflicting jobs:\n${idle.conflictingProcesses.join("\n")}`);
    }
    if (idle.gpuComputePids.length) {
        throw new Error(`actor benchmark found active GPU compute PIDs: ${idle.gpuComputePids.join(",")}`);
    }
    if (idle.loadOne > idle.maximumLoadOne) {
        throw new Error(`actor benchmark host load ${idle.loadOne} exceeds idle ceiling ${idle.maximumLoadOne}`);
    }
    if (idle.freeMemoryBytes < V09_ACTOR_LANE_SELECTION_POLICY.minimumFreeMemoryBytes) {
        throw new Error("actor benchmark host has insufficient free memory");
    }
}

function normalizedProtectedRoots(roots: readonly string[]): string[] {
    const normalized = [...new Set(roots.map((root) => resolve(root)))].sort();
    if (!normalized.length) throw new Error("actor benchmark requires at least one --protect-v08-root");
    for (const root of normalized) {
        if (!existsSync(root)) throw new Error(`protected v0.8 root does not exist: ${root}`);
        const status = lstatSync(root);
        if (status.isSymbolicLink() || !status.isDirectory()) {
            throw new Error(`protected v0.8 root must be a real directory: ${root}`);
        }
    }
    return normalized;
}

function isWithin(parent: string, candidate: string): boolean {
    const path = relative(parent, candidate);
    return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export function assertFreshV09ActorLaneBenchmarkOutput(
    outputDirectory: string,
    repositoryRoot: string,
    protectedV08Roots: readonly string[],
): string {
    const requestedOutput = resolve(outputDirectory);
    if (lstatSync(requestedOutput, { throwIfNoEntry: false }) !== undefined) {
        throw new Error(`actor benchmark refuses existing output/campaign path ${requestedOutput}`);
    }
    const requestedParent = dirname(requestedOutput);
    if (
        !existsSync(requestedParent) ||
        lstatSync(requestedParent).isSymbolicLink() ||
        !lstatSync(requestedParent).isDirectory()
    ) {
        throw new Error(`actor benchmark output parent must be an existing real directory: ${requestedParent}`);
    }
    const output = canonicalV09PathThroughExistingAncestor(requestedOutput);
    const repository = canonicalV09PathThroughExistingAncestor(repositoryRoot);
    if (isWithin(repository, output)) {
        throw new Error("actor benchmark output must be outside the clean source repository");
    }
    assertV09OutputIsolation(output, protectedV08Roots);
    return output;
}

function actorGames(results: readonly ICommandResult[]): number {
    return results.reduce((total, result) => {
        const summary = result.stdout
            .trim()
            .split(/\r?\n/)
            .flatMap((line) => {
                try {
                    const parsed = JSON.parse(line) as { completed?: number; resumed?: number };
                    return Number.isSafeInteger(parsed.completed) && Number.isSafeInteger(parsed.resumed)
                        ? [{ completed: parsed.completed!, resumed: parsed.resumed! }]
                        : [];
                } catch {
                    return [];
                }
            })
            .at(-1);
        if (!summary || summary.completed < 0 || summary.resumed !== 0) {
            throw new Error("actor benchmark received an invalid or resumed actor summary");
        }
        return total + summary.completed;
    }, 0);
}

function benchmarkShardSet(
    campaignDirectory: string,
    panelGames: number,
    seeds: readonly number[],
): { games: number; shardSetSha256: string } {
    const directory = resolve(campaignDirectory, "il", "wide_teacher_train", "v0.8-a13");
    const files = existsSync(directory)
        ? readdirSync(directory)
              .filter((file) => file.endsWith(".jsonl"))
              .sort()
        : [];
    if (files.length !== panelGames) {
        throw new Error(`actor benchmark produced ${files.length}/${panelGames} shards`);
    }
    const hash = createHash("sha256");
    for (let index = 0; index < panelGames; index += 1) {
        const expected = `${String(index).padStart(6, "0")}-${seeds[index]}.jsonl`;
        if (files[index] !== expected) throw new Error(`actor benchmark shard set is missing ${expected}`);
        const path = resolve(directory, expected);
        const footer = validateV09GameShard(path);
        if (
            footer.seed !== seeds[index] ||
            footer.gameId !== `wide_teacher_train:${index}:${seeds[index]}:v0.8-a13:anchor-mirror`
        ) {
            throw new Error(`actor benchmark shard ${expected} violates immutable identity`);
        }
        const bytes = readFileSync(path);
        hash.update(expected);
        hash.update("\0");
        hash.update(bytes);
        hash.update("\0");
    }
    return { games: files.length, shardSetSha256: hash.digest("hex") };
}

function benchmarkCounts(panelGames: number): Record<V09SeedPurpose, number> {
    return {
        wide_teacher_train: panelGames,
        wide_teacher_validation: 1,
        dagger_1_train: 1,
        dagger_1_validation: 1,
        dagger_2_train: 1,
        dagger_2_validation: 1,
        confirmation: 2,
        qualification: 2,
    };
}

function benchmarkIdentity(source: IV09SourceIdentityReceipt, gpuUuid: string): IV09CampaignIdentity {
    return {
        sourceCommit: source.sourceCommit,
        sourceStatusSha256: source.sourceStatusSha256,
        sourceDirty: false,
        rulesFingerprint: source.rulesFingerprint,
        rosterFingerprint: source.rosterFingerprint,
        anchorVersion: "v0.8",
        anchorFingerprint: source.anchorFingerprint,
        gpuUuid,
    };
}

async function runCandidate(
    root: string,
    repositoryRoot: string,
    protectedRoots: readonly string[],
    sourceReceipt: IV09SourceIdentityReceipt,
    identity: IV09CampaignIdentity,
    ledger: ReturnType<typeof buildV09SeedLedger>,
    entry: IV09ActorLaneBenchmarkPlanEntry,
    physicalCpuIds: readonly number[],
    temperaturePaths: readonly string[],
    throttlePaths: readonly string[],
): Promise<IV09ActorLaneBenchmarkRun> {
    verifyV09SourceIdentity(sourceReceipt, repositoryRoot);
    const conflicts = conflictingProcesses();
    const gpuPids = gpuComputePids(identity.gpuUuid);
    const currentLoadOne = loadavg()[0];
    const maximumResidualLoadOne = Math.max(1, physicalCpuIds.length * 1.25);
    const currentCpuUtilization = await instantaneousCpuUtilization();
    if (conflicts.length || gpuPids.length) {
        throw new Error("actor benchmark detected a newly active training/learner job before candidate launch");
    }
    if (
        currentLoadOne > maximumResidualLoadOne ||
        currentCpuUtilization > 0.2 ||
        freemem() < V09_ACTOR_LANE_SELECTION_POLICY.minimumFreeMemoryBytes
    ) {
        throw new Error(
            `actor benchmark host is no longer available before candidate launch ` +
                `(load=${currentLoadOne}/${maximumResidualLoadOne}, cpu=${currentCpuUtilization}, ` +
                `freeMemory=${freemem()})`,
        );
    }
    const campaignDirectory = resolve(
        root,
        "runs",
        `${String(entry.sequence).padStart(2, "0")}-r${entry.repetition}-w${entry.workers}`,
    );
    if (existsSync(campaignDirectory))
        throw new Error(`actor benchmark run output already exists: ${campaignDirectory}`);
    const manifest = buildV09CampaignManifest(
        identity,
        campaignDirectory,
        ledger,
        buildV09DevelopmentActorPhysicalCorePolicy(),
    );
    initializeV09Campaign(campaignDirectory, manifest, ledger);
    writeV09SourceIdentity(resolve(campaignDirectory, "source-identity.json"), sourceReceipt);
    writeV09V08ProtectionReceipt(campaignDirectory, manifest, protectedRoots);

    const script = resolve(repositoryRoot, "src/simulation/v0_9/teacher_actor.ts");
    const launches: IV09ActorCommandLaunch[] = Array.from({ length: entry.workers }, (_, workerIndex) => ({
        executable: "nice",
        args: [
            "-n",
            "10",
            "taskset",
            "-c",
            String(physicalCpuIds[workerIndex]),
            process.execPath,
            script,
            "--campaign",
            campaignDirectory,
            "--purpose",
            "wide_teacher_train",
            "--worker-index",
            String(workerIndex),
            "--workers",
            String(entry.workers),
        ],
        cwd: repositoryRoot,
        environment: { ...process.env, CUDA_VISIBLE_DEVICES: "" },
    }));

    const throttleCountBefore = readThrottleCount(throttlePaths);
    let peakTemperatureC = readPeakTemperature(temperaturePaths);
    let telemetryFailure: unknown;
    const sampler = setInterval(() => {
        try {
            peakTemperatureC = Math.max(peakTemperatureC, readPeakTemperature(temperaturePaths));
        } catch (error) {
            telemetryFailure = error;
        }
    }, 2_000);
    const started = performance.now();
    let results: ICommandResult[];
    try {
        results = await runV09ActorCommandsFailFast(launches);
    } finally {
        clearInterval(sampler);
    }
    const elapsedSeconds = (performance.now() - started) / 1_000;
    peakTemperatureC = Math.max(peakTemperatureC, readPeakTemperature(temperaturePaths));
    if (telemetryFailure) throw telemetryFailure;
    const throttleCountAfter = readThrottleCount(throttlePaths);
    if (
        peakTemperatureC > V09_ACTOR_LANE_SELECTION_POLICY.maximumTemperatureC ||
        throttleCountAfter !== throttleCountBefore
    ) {
        throw new Error(
            `actor benchmark candidate ${entry.workers} failed thermal safety ` +
                `(peak=${peakTemperatureC}C, throttles=${throttleCountBefore}->${throttleCountAfter})`,
        );
    }
    const completed = actorGames(results);
    const stream = ledger.streams.find((candidate) => candidate.purpose === "wide_teacher_train")!;
    const shardSet = benchmarkShardSet(campaignDirectory, stream.count, stream.seeds);
    if (completed !== stream.count || shardSet.games !== stream.count) {
        throw new Error(`actor benchmark candidate completed ${completed}/${stream.count} games`);
    }
    verifyV09SourceIdentity(sourceReceipt, repositoryRoot);
    return {
        sequence: entry.sequence,
        repetition: entry.repetition,
        workers: entry.workers,
        physicalCpuIds: physicalCpuIds.slice(0, entry.workers),
        games: completed,
        elapsedSeconds,
        gamesPerSecond: completed / elapsedSeconds,
        shardSetSha256: shardSet.shardSetSha256,
        peakTemperatureC,
        throttleCountBefore,
        throttleCountAfter,
    };
}

export async function runV09ActorLaneBenchmark(
    options: IV09ActorLaneBenchmarkOptions,
): Promise<IV09ActorLaneBenchmarkReceipt> {
    const plan = buildV09ActorLaneBenchmarkPlan({
        mode: "production",
        panelGames: options.panelGames,
        repetitions: options.repetitions,
    });
    const repositoryRoot = resolve(options.repositoryRoot);
    const protectedRoots = normalizedProtectedRoots(options.protectedV08Roots);
    const outputDirectory = assertFreshV09ActorLaneBenchmarkOutput(
        options.outputDirectory,
        repositoryRoot,
        protectedRoots,
    );
    const sourceReceipt = verifyV09SourceIdentity(
        JSON.parse(readFileSync(options.sourceReceiptPath, "utf8")) as IV09SourceIdentityReceipt,
        repositoryRoot,
    );
    const inspection = inspectV09ActorLaneBenchmarkHost(options.gpuUuid);
    assertProductionHost(inspection);

    // Creation happens only after every clean-source, host-idle, topology, GPU, and path-isolation gate passes.
    mkdirSync(outputDirectory);
    const startedAt = new Date().toISOString();
    const identity = benchmarkIdentity(sourceReceipt, options.gpuUuid);
    const ledger = buildV09SeedLedger(v09CampaignRunFingerprint(identity), [], benchmarkCounts(plan.panelGames));
    const stream = ledger.streams.find((candidate) => candidate.purpose === "wide_teacher_train")!;
    const receiptBase: IV09ActorLaneBenchmarkReceiptBase = {
        mode: "production",
        source: {
            receiptSha256: sourceReceipt.receiptSha256,
            sourceCommit: sourceReceipt.sourceCommit,
            sourceStatusSha256: sourceReceipt.sourceStatusSha256,
            rulesFingerprint: sourceReceipt.rulesFingerprint,
        },
        host: inspection.host,
        idle: inspection.idle,
        panel: {
            purpose: "wide_teacher_train",
            games: stream.count,
            repetitions: plan.repetitions,
            productionTeacherSearch: true,
            runFingerprint: ledger.runFingerprint,
            seedLedgerSha256: ledger.ledgerSha256,
            seedsSha256: stream.seedsSha256,
        },
        startedAt,
    };
    const receipt = await executeV09ActorLaneBenchmarkPlan(plan, receiptBase, (entry) =>
        runCandidate(
            outputDirectory,
            repositoryRoot,
            protectedRoots,
            sourceReceipt,
            identity,
            ledger,
            entry,
            inspection.host.physicalCpuIds,
            inspection.temperaturePaths,
            inspection.throttlePaths,
        ),
    );
    verifyV09SourceIdentity(sourceReceipt, repositoryRoot);
    const receiptPath = resolve(outputDirectory, "actor-lane-benchmark.json");
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return receipt;
}

function cliOptions(): IV09ActorLaneBenchmarkOptions {
    const { values } = parseArgs({
        args: Bun.argv.slice(2),
        options: {
            out: { type: "string" },
            repository: { type: "string", default: process.cwd() },
            "source-receipt": { type: "string" },
            "gpu-uuid": { type: "string" },
            "protect-v08-root": { type: "string", multiple: true },
            "panel-games": { type: "string" },
            repetitions: { type: "string" },
        },
        strict: true,
    });
    if (!values.out || !values["source-receipt"] || !values["gpu-uuid"]) {
        throw new Error(
            "usage: bun actor_lane_benchmark.ts --out <fresh-dir> --source-receipt <json> " +
                "--gpu-uuid <uuid> --protect-v08-root <dir>",
        );
    }
    return {
        outputDirectory: values.out,
        repositoryRoot: values.repository,
        sourceReceiptPath: values["source-receipt"],
        gpuUuid: values["gpu-uuid"],
        protectedV08Roots: values["protect-v08-root"] ?? [],
        panelGames: parsePositiveInteger(
            values["panel-games"],
            V09_ACTOR_LANE_SELECTION_POLICY.minimumProductionPanelGames,
            "--panel-games",
        ),
        repetitions: parsePositiveInteger(
            values.repetitions,
            V09_ACTOR_LANE_SELECTION_POLICY.minimumProductionRepetitions,
            "--repetitions",
        ),
    };
}

if (import.meta.main) {
    runV09ActorLaneBenchmark(cliOptions())
        .then((receipt) => {
            process.stdout.write(
                `${JSON.stringify({
                    receiptSha256: receipt.receiptSha256,
                    selectedWorkers: receipt.selection.selectedWorkers,
                    eligibleForCampaign: receipt.eligibleForCampaign,
                })}\n`,
            );
        })
        .catch((error) => {
            process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
            process.exitCode = 1;
        });
}
