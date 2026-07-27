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

import { randomUUID } from "node:crypto";
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { availableParallelism, hostname } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

import type { IV09ModelArtifact } from "../../ai/versions/v0_9_model";
import {
    buildV09Checkpoint,
    readV09Checkpoint,
    sha256File,
    validateV09CampaignManifest,
    validateV09SeedLedger,
    writeV09Checkpoint,
    V09_CAMPAIGN_STAGES,
    V09_RTX5090_GPU_UUID,
    type IV09CampaignManifest,
    type IV09SeedLedger,
    type V09CampaignStage,
    type V09SeedPurpose,
} from "./campaign";
import {
    createV09ProductionHandoffBundle,
    validateV09ProductionHandoffBundle,
    type IV09VerifiedProductionHandoff,
} from "./handoff";
import { buildV09ParityCorpus, scoreV09ParityVectors, verifyV09ResearchArtifact } from "./parity";
import { fingerprintV09 } from "./protocol";
import {
    validateV09QualificationShardReceipt,
    validateV09QualificationSummary,
    type IV09QualificationShardReceipt,
    type IV09QualificationSummary,
    type V09QualificationNodeRole,
} from "./qualify";
import { validateV09GameShard } from "./recorder";
import { verifyV09SourceIdentity, type IV09SourceIdentityReceipt } from "./source_identity";
import {
    assessV09LearnerHardwareEvidence,
    buildV09LearnerLaunch,
    verifyV09V08ProtectionReceipt,
    V09_ARCHITECTURE_CANDIDATES,
    V09_GPU_EVIDENCE_POLICY,
    V09_PYTHON_ENVIRONMENT,
} from "./supervisor";
import { V09_TEACHER_COHORTS, V09_TEACHER_MAPS } from "./teacher_actor";

export const V09_ORCHESTRATOR_RECEIPT_SCHEMA = "hoc.ai.v0_9_orchestrator_receipt.v1" as const;

type TrainingPhase = "wide_teacher" | "dagger_1" | "dagger_2";

export interface ICommandResult {
    command: string[];
    exitCode: number;
    signalCode: NodeJS.Signals | null;
    startedAt: string;
    completedAt: string;
    elapsedSeconds: number;
    stdout: string;
    stderr: string;
    gpuSamples: Array<{ at: string; utilization: number; memoryMiB: number; temperatureC: number }>;
}

export interface IV09ActorCommandLaunch {
    executable: string;
    args: readonly string[];
    cwd: string;
    environment?: NodeJS.ProcessEnv;
}

export interface IV09CommandFailureStream {
    tail: string;
    totalCharacters: number;
    omittedCharacters: number;
}

export interface IV09CommandFailureDiagnostics {
    stderr: IV09CommandFailureStream | null;
    stdout: IV09CommandFailureStream | null;
}

export class V09CommandExecutionError extends Error {
    public readonly result: ICommandResult;
    public readonly diagnostics: IV09CommandFailureDiagnostics;
    public constructor(result: ICommandResult, cause?: unknown) {
        const diagnostics = commandFailureDiagnostics(result);
        super(
            `command failed (${result.exitCode}${result.signalCode ? `/${result.signalCode}` : ""}): ` +
                `${result.command.join(" ")}${commandFailureDiagnostic(diagnostics)}`,
            cause === undefined ? undefined : { cause },
        );
        this.name = "V09CommandExecutionError";
        this.result = {
            ...result,
            stderr: diagnostics.stderr?.tail ?? "",
            stdout: diagnostics.stdout?.tail ?? "",
        };
        this.diagnostics = diagnostics;
    }
}

export class V09ActorCommandsInterruptedError extends Error {
    public readonly signal: "SIGINT" | "SIGTERM";
    public readonly exitCode: 130 | 143;
    public constructor(signal: "SIGINT" | "SIGTERM") {
        super(`v0.9 actor commands were interrupted by ${signal}; every owned actor process group was terminated`);
        this.name = "V09ActorCommandsInterruptedError";
        this.signal = signal;
        this.exitCode = signal === "SIGINT" ? 130 : 143;
    }
}

interface IOrchestratorContext {
    campaignDirectory: string;
    receiptDirectory: string;
    repositoryRoot: string;
    manifest: IV09CampaignManifest;
    ledger: IV09SeedLedger;
    handoff: IV09VerifiedProductionHandoff | null;
}

const phasePurposes = (phase: TrainingPhase): [V09SeedPurpose, V09SeedPurpose] => [
    `${phase}_train` as V09SeedPurpose,
    `${phase}_validation` as V09SeedPurpose,
];

const V09_ACTOR_TERMINATION_GRACE_MS = 5_000;
const V09_ACTOR_PROCESS_GROUP_POLL_MS = 20;
const V09_COMMAND_DIAGNOSTIC_STREAM_LIMIT = 16_384;

function boundedDiagnosticStream(value: string): IV09CommandFailureStream | null {
    if (!value) return null;
    const omitted = Math.max(0, value.length - V09_COMMAND_DIAGNOSTIC_STREAM_LIMIT);
    const tail = omitted > 0 ? value.slice(-V09_COMMAND_DIAGNOSTIC_STREAM_LIMIT) : value;
    return {
        tail,
        totalCharacters: value.length,
        omittedCharacters: omitted,
    };
}

function commandFailureDiagnostics(result: ICommandResult): IV09CommandFailureDiagnostics {
    return {
        stderr: boundedDiagnosticStream(result.stderr),
        stdout: boundedDiagnosticStream(result.stdout),
    };
}

function commandFailureDiagnostic(diagnostics: IV09CommandFailureDiagnostics): string {
    const streams = (["stderr", "stdout"] as const).flatMap((label) => {
        const stream = diagnostics[label];
        if (!stream) return [];
        const qualifier =
            stream.omittedCharacters > 0
                ? `last ${stream.tail.length} of ${stream.totalCharacters} characters`
                : `${stream.totalCharacters} characters`;
        return [`${label} (${qualifier}):\n${stream.tail}`];
    });
    return streams.length ? `\n${streams.join("\n")}` : "";
}

function processGroupExists(processGroupId: number): boolean {
    try {
        process.kill(-processGroupId, 0);
        return true;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ESRCH") return false;
        if (code === "EPERM") return true;
        throw error;
    }
}

function signalOwnedProcessTree(child: ChildProcess, processGroupId: number | null, signal: NodeJS.Signals): void {
    if (processGroupId !== null) {
        try {
            process.kill(-processGroupId, signal);
            return;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
    }
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}

function waitMilliseconds(milliseconds: number): Promise<void> {
    return new Promise((accept) => setTimeout(accept, milliseconds));
}

async function waitForProcessGroupDisappearance(
    processGroupId: number,
    timeoutMilliseconds?: number,
): Promise<boolean> {
    const deadline =
        timeoutMilliseconds === undefined ? Number.POSITIVE_INFINITY : performance.now() + timeoutMilliseconds;
    while (processGroupExists(processGroupId)) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) return false;
        await waitMilliseconds(Math.min(V09_ACTOR_PROCESS_GROUP_POLL_MS, remaining));
    }
    return true;
}

function atomicJson(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, path);
}

async function withOrchestratorLock<T>(
    context: IOrchestratorContext,
    command: string,
    operation: () => Promise<T>,
): Promise<T> {
    mkdirSync(context.receiptDirectory, { recursive: true });
    const path = resolve(context.receiptDirectory, ".v0.9-orchestrator.lock");
    const token = randomUUID();
    const value = {
        schema: "hoc.ai.v0_9_orchestrator_lock.v1",
        token,
        runFingerprint: context.manifest.runFingerprint,
        host: hostname(),
        pid: process.pid,
        command,
        acquiredAt: new Date().toISOString(),
    };
    const acquire = (): void => {
        try {
            writeFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "EEXIST") throw error;
            let prior: Partial<typeof value>;
            try {
                prior = JSON.parse(readFileSync(path, "utf8")) as Partial<typeof value>;
            } catch {
                throw new Error(`v0.9 orchestrator lock is unreadable and must be inspected manually: ${path}`);
            }
            let alive = true;
            if (prior.host === hostname() && Number.isSafeInteger(prior.pid) && prior.pid! > 0) {
                try {
                    process.kill(prior.pid!, 0);
                } catch (probeError) {
                    alive = (probeError as NodeJS.ErrnoException).code === "EPERM";
                }
            }
            if (prior.host !== hostname() || alive) {
                throw new Error(
                    `v0.9 campaign is already owned by ${prior.host ?? "unknown"}:${prior.pid ?? "unknown"} ` +
                        `for ${prior.command ?? "unknown"} (${path})`,
                );
            }
            renameSync(path, `${path}.stale.${Date.now()}.${randomUUID()}`);
            writeFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
        }
    };
    acquire();
    try {
        return await operation();
    } finally {
        try {
            const current = JSON.parse(readFileSync(path, "utf8")) as { token?: string };
            if (current.token === token) unlinkSync(path);
        } catch {
            // Preserve an unreadable/replaced lock for manual inspection; never unlink another owner's lease.
        }
    }
}

function loadContext(campaignDirectory: string, repositoryRoot: string): IOrchestratorContext {
    const campaign = resolve(campaignDirectory);
    const repository = resolve(repositoryRoot);
    const manifest = JSON.parse(readFileSync(resolve(campaign, "manifest.json"), "utf8")) as IV09CampaignManifest;
    const ledger = JSON.parse(readFileSync(resolve(campaign, "seed-ledger.json"), "utf8")) as IV09SeedLedger;
    const sourceReceipt = JSON.parse(
        readFileSync(resolve(campaign, "source-identity.json"), "utf8"),
    ) as IV09SourceIdentityReceipt;
    validateV09CampaignManifest(manifest, campaign);
    validateV09SeedLedger(ledger);
    verifyV09V08ProtectionReceipt(campaign, manifest);
    const verifiedSource = verifyV09SourceIdentity(sourceReceipt, repository);
    if (
        manifest.identity.gpuUuid !== V09_RTX5090_GPU_UUID ||
        manifest.runFingerprint !== ledger.runFingerprint ||
        manifest.seedLedgerSha256 !== ledger.ledgerSha256 ||
        manifest.identity.sourceCommit !== verifiedSource.sourceCommit ||
        manifest.identity.sourceStatusSha256 !== verifiedSource.sourceStatusSha256 ||
        manifest.identity.rulesFingerprint !== verifiedSource.rulesFingerprint ||
        manifest.identity.rosterFingerprint !== verifiedSource.rosterFingerprint ||
        manifest.identity.anchorFingerprint !== verifiedSource.anchorFingerprint
    ) {
        throw new Error("v0.9 orchestrator campaign/GPU/seed/source identity mismatch");
    }
    return {
        campaignDirectory: campaign,
        receiptDirectory: campaign,
        repositoryRoot: repository,
        manifest,
        ledger,
        handoff: null,
    };
}

function loadBundleContext(
    bundleDirectory: string,
    repositoryRoot: string,
    outputDirectory: string,
): IOrchestratorContext {
    const handoff = validateV09ProductionHandoffBundle(bundleDirectory);
    const repository = resolve(repositoryRoot);
    const verifiedSource = verifyV09SourceIdentity(handoff.sourceIdentity, repository);
    if (
        handoff.manifest.identity.sourceCommit !== verifiedSource.sourceCommit ||
        handoff.manifest.identity.sourceStatusSha256 !== verifiedSource.sourceStatusSha256 ||
        handoff.manifest.identity.rulesFingerprint !== verifiedSource.rulesFingerprint ||
        handoff.manifest.identity.rosterFingerprint !== verifiedSource.rosterFingerprint ||
        handoff.manifest.identity.anchorFingerprint !== verifiedSource.anchorFingerprint
    ) {
        throw new Error("v0.9 production handoff does not match the isolated clean qualification checkout");
    }
    const output = resolve(outputDirectory);
    if (output === handoff.directory || output.startsWith(`${handoff.directory}/`)) {
        throw new Error("production qualification output must be outside the immutable handoff bundle");
    }
    mkdirSync(output, { recursive: true });
    return {
        campaignDirectory: handoff.directory,
        receiptDirectory: output,
        repositoryRoot: repository,
        manifest: handoff.manifest,
        ledger: handoff.ledger,
        handoff,
    };
}

function gpuSample(gpuUuid: string): ICommandResult["gpuSamples"][number] | null {
    const result = spawnSync(
        "nvidia-smi",
        [`--id=${gpuUuid}`, "--query-gpu=utilization.gpu,memory.used,temperature.gpu", "--format=csv,noheader,nounits"],
        { encoding: "utf8" },
    );
    if (result.status !== 0) return null;
    const values = result.stdout
        .trim()
        .split(",")
        .map((value) => Number(value.trim()));
    if (values.length !== 3 || values.some((value) => !Number.isFinite(value))) return null;
    return {
        at: new Date().toISOString(),
        utilization: values[0]!,
        memoryMiB: values[1]!,
        temperatureC: values[2]!,
    };
}

async function runCommand(
    executable: string,
    args: readonly string[],
    options: {
        cwd: string;
        environment?: NodeJS.ProcessEnv;
        monitorGpuUuid?: string;
        gpuLogPath?: string;
        abortSignal?: AbortSignal;
        terminationGraceMs?: number;
    },
): Promise<ICommandResult> {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const ownsProcessGroup = process.platform !== "win32" && options.abortSignal !== undefined;
    const child = spawn(executable, [...args], {
        cwd: options.cwd,
        env: options.environment ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: ownsProcessGroup,
    });
    const processGroupId = ownsProcessGroup && child.pid !== undefined ? child.pid : null;
    let closed = false;
    let childError: unknown;
    let terminationError: unknown;
    let terminationPromise: Promise<void> | undefined;
    let signalCode: NodeJS.Signals | null = null;
    let leaderExitObserved = false;
    let acceptLeaderExit!: () => void;
    const leaderExitPromise = new Promise<void>((accept) => {
        acceptLeaderExit = accept;
    });
    const observeLeaderExit = (): void => {
        if (leaderExitObserved) return;
        leaderExitObserved = true;
        acceptLeaderExit();
    };
    const closePromise = new Promise<number>((accept) => {
        child.once("error", (error) => {
            childError ??= error;
        });
        child.once("exit", observeLeaderExit);
        child.once("close", (code, signal) => {
            closed = true;
            signalCode = signal ?? null;
            observeLeaderExit();
            accept(code ?? -1);
        });
    });
    const terminate = (): void => {
        if (terminationPromise || (closed && processGroupId === null)) return;
        terminationPromise = (async () => {
            try {
                signalOwnedProcessTree(child, processGroupId, "SIGTERM");
            } catch (error) {
                terminationError ??= error;
            }
            const grace = options.terminationGraceMs ?? V09_ACTOR_TERMINATION_GRACE_MS;
            const terminatedWithinGrace =
                processGroupId === null
                    ? await (async (): Promise<boolean> => {
                          const deadline = performance.now() + grace;
                          while (!closed && performance.now() < deadline) {
                              await waitMilliseconds(
                                  Math.min(V09_ACTOR_PROCESS_GROUP_POLL_MS, deadline - performance.now()),
                              );
                          }
                          return closed;
                      })()
                    : await waitForProcessGroupDisappearance(processGroupId, grace);
            if (terminatedWithinGrace) return;
            try {
                signalOwnedProcessTree(child, processGroupId, "SIGKILL");
            } catch (error) {
                terminationError ??= error;
            }
            if (processGroupId !== null) {
                // Deliberately unbounded: ownership must not be released while any actor descendant survives.
                await waitForProcessGroupDisappearance(processGroupId);
            }
        })().catch((error: unknown) => {
            terminationError ??= error;
        });
    };
    if (options.abortSignal?.aborted) terminate();
    else options.abortSignal?.addEventListener("abort", terminate, { once: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        process.stderr.write(chunk);
    });
    const gpuSamples: ICommandResult["gpuSamples"] = [];
    const sample = (): void => {
        if (!options.monitorGpuUuid) return;
        const current = gpuSample(options.monitorGpuUuid);
        if (current) {
            gpuSamples.push(current);
            if (options.gpuLogPath) {
                mkdirSync(dirname(options.gpuLogPath), { recursive: true });
                appendFileSync(options.gpuLogPath, `${JSON.stringify(current)}\n`, "utf8");
            }
        }
    };
    sample();
    const timer = options.monitorGpuUuid
        ? setInterval(sample, V09_GPU_EVIDENCE_POLICY.sampleIntervalSeconds * 1_000)
        : undefined;
    let exitCode: number;
    try {
        await leaderExitPromise;
        if (processGroupId !== null && !terminationPromise) {
            let disappearedNaturally = false;
            try {
                disappearedNaturally = await waitForProcessGroupDisappearance(
                    processGroupId,
                    V09_ACTOR_PROCESS_GROUP_POLL_MS,
                );
            } catch (error) {
                terminationError ??= error;
            }
            if (!disappearedNaturally && !terminationPromise) {
                terminationError ??= new Error(
                    `command process group ${processGroupId} survived its leader exit; ` +
                        "terminating descendants before releasing campaign ownership",
                );
                terminate();
            }
        }
        exitCode = await closePromise;
        if (terminationPromise) await terminationPromise;
        if (processGroupId !== null) {
            // A successful group leader must not be allowed to daemonize descendants past the campaign lock.
            await waitForProcessGroupDisappearance(processGroupId);
        }
    } finally {
        if (timer) clearInterval(timer);
        options.abortSignal?.removeEventListener("abort", terminate);
    }
    sample();
    const result: ICommandResult = {
        command: [executable, ...args],
        exitCode,
        signalCode,
        startedAt,
        completedAt: new Date().toISOString(),
        elapsedSeconds: (performance.now() - started) / 1000,
        stdout,
        stderr,
        gpuSamples,
    };
    if (exitCode !== 0 || childError !== undefined || terminationError !== undefined) {
        throw new V09CommandExecutionError(result, childError ?? terminationError);
    }
    return result;
}

export async function runV09ActorCommandsFailFast(
    launches: readonly IV09ActorCommandLaunch[],
    terminationGraceMs = V09_ACTOR_TERMINATION_GRACE_MS,
): Promise<ICommandResult[]> {
    if (!Number.isFinite(terminationGraceMs) || terminationGraceMs < 0) {
        throw new Error("v0.9 actor termination grace must be a finite non-negative number");
    }
    const controller = new AbortController();
    let primaryFailure: unknown;
    let failed = false;
    const fail = (error: unknown): void => {
        if (!failed) {
            failed = true;
            primaryFailure = error;
        }
        if (!controller.signal.aborted) controller.abort(error);
    };
    const onSigint = (): void => fail(new V09ActorCommandsInterruptedError("SIGINT"));
    const onSigterm = (): void => fail(new V09ActorCommandsInterruptedError("SIGTERM"));
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    try {
        const running = launches.map((launch) =>
            runCommand(launch.executable, launch.args, {
                cwd: launch.cwd,
                environment: launch.environment,
                abortSignal: controller.signal,
                terminationGraceMs,
            }).catch((error: unknown) => {
                fail(error);
                throw error;
            }),
        );
        const settled = await Promise.allSettled(running);
        if (failed) throw primaryFailure;
        return settled.map((result) => {
            if (result.status === "rejected") throw result.reason;
            return result.value;
        });
    } finally {
        process.removeListener("SIGINT", onSigint);
        process.removeListener("SIGTERM", onSigterm);
    }
}

function writeReceipt(context: IOrchestratorContext, id: string, payload: unknown): void {
    const unsigned = {
        schema: V09_ORCHESTRATOR_RECEIPT_SCHEMA,
        runFingerprint: context.manifest.runFingerprint,
        manifestSha256: context.manifest.manifestSha256,
        id,
        payload,
    };
    atomicJson(resolve(context.receiptDirectory, "receipts", `${id}.json`), {
        ...unsigned,
        receiptSha256: fingerprintV09(unsigned),
    });
}

const stageIndex = (stage: V09CampaignStage): number => {
    const index = V09_CAMPAIGN_STAGES.indexOf(stage);
    if (index < 0) throw new Error(`unknown v0.9 campaign stage ${stage}`);
    return index;
};

function checkpointAt(context: IOrchestratorContext) {
    return readV09Checkpoint(resolve(context.campaignDirectory, "checkpoint.json"), context.manifest);
}

function assertCheckpointAtLeast(context: IOrchestratorContext, requiredStage: V09CampaignStage): void {
    const checkpoint = checkpointAt(context);
    if (!checkpoint || stageIndex(checkpoint.stage) < stageIndex(requiredStage)) {
        throw new Error(`v0.9 stage requires a completed ${requiredStage} checkpoint`);
    }
    if (checkpoint.completedUnits !== checkpoint.expectedUnits) {
        throw new Error(`v0.9 checkpoint ${checkpoint.stage} is incomplete`);
    }
}

function advanceCheckpoint(
    context: IOrchestratorContext,
    stage: V09CampaignStage,
    completedUnits: number,
    expectedUnits: number,
    artifacts: Record<string, string> = {},
): void {
    const current = checkpointAt(context);
    if (current && stageIndex(current.stage) > stageIndex(stage)) return;
    writeV09Checkpoint(
        resolve(context.campaignDirectory, "checkpoint.json"),
        buildV09Checkpoint(context.manifest, stage, completedUnits, expectedUnits, {
            ...(current?.stage === stage ? current.artifacts : {}),
            ...artifacts,
        }),
    );
}

function physicalCpuIds(): number[] {
    if (process.platform !== "linux") {
        return Array.from({ length: availableParallelism() }, (_, index) => index);
    }
    const result = spawnSync("lscpu", ["-p=CPU,CORE,SOCKET,ONLINE"], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`lscpu failed: ${result.stderr.trim()}`);
    const seen = new Set<string>();
    const cpus: number[] = [];
    for (const line of result.stdout.split(/\r?\n/)) {
        if (!line || line.startsWith("#")) continue;
        const [cpuRaw, core, socket, online = "Y"] = line.split(",");
        const cpu = Number(cpuRaw);
        if (!Number.isSafeInteger(cpu) || online !== "Y") continue;
        const key = `${socket}:${core}`;
        if (seen.has(key)) continue;
        seen.add(key);
        cpus.push(cpu);
    }
    if (!cpus.length) throw new Error("could not discover physical CPU lanes");
    return cpus;
}

async function bootstrapVenv(context: IOrchestratorContext): Promise<void> {
    const python = resolve(context.campaignDirectory, "venv/bin/python");
    const results: ICommandResult[] = [];
    const environment = { ...process.env, ...V09_PYTHON_ENVIRONMENT, PIP_NO_CACHE_DIR: "1" };
    if (!existsSync(python)) {
        results.push(
            await runCommand("python3.12", ["-m", "venv", resolve(context.campaignDirectory, "venv")], {
                cwd: context.repositoryRoot,
            }),
        );
    }
    results.push(
        await runCommand(
            python,
            [
                "-m",
                "pip",
                "install",
                "--disable-pip-version-check",
                "--requirement",
                resolve(context.repositoryRoot, "src/simulation/v0_9/python/requirements.lock"),
            ],
            { cwd: context.repositoryRoot, environment },
        ),
    );
    results.push(await runCommand(python, ["-m", "pip", "check"], { cwd: context.repositoryRoot, environment }));
    results.push(
        await runCommand(
            python,
            [
                "-c",
                [
                    "import platform, numpy, torch",
                    "assert platform.python_implementation() == 'CPython'",
                    "assert platform.python_version_tuple()[:2] == ('3', '12')",
                    "assert platform.system() == 'Linux' and platform.machine() == 'x86_64'",
                    "assert numpy.__version__ == '2.2.6'",
                    "assert torch.__version__ == '2.11.0+cu130'",
                    "assert torch.version.cuda == '13.0'",
                ].join("; "),
            ],
            { cwd: context.repositoryRoot, environment },
        ),
    );
    writeReceipt(context, "bootstrap-venv", results);
}

async function preflight(context: IOrchestratorContext): Promise<void> {
    const python = resolve(context.campaignDirectory, "venv/bin/python");
    if (!existsSync(python)) throw new Error("pinned campaign venv is missing; run bootstrap first");
    const result = await runCommand(
        python,
        [
            resolve(context.repositoryRoot, "src/simulation/v0_9/python/preflight.py"),
            "--gpu-uuid",
            V09_RTX5090_GPU_UUID,
            "--output-directory",
            context.campaignDirectory,
        ],
        {
            cwd: context.repositoryRoot,
            environment: {
                ...process.env,
                ...V09_PYTHON_ENVIRONMENT,
                CUDA_VISIBLE_DEVICES: V09_RTX5090_GPU_UUID,
            },
            monitorGpuUuid: V09_RTX5090_GPU_UUID,
        },
    );
    const report = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as { ok?: boolean };
    if (report.ok !== true) throw new Error("v0.9 preflight did not emit an ok receipt");
    writeReceipt(context, "preflight", { result, report });
    advanceCheckpoint(context, "preflight", 1, 1, { preflight: fingerprintV09(report) });
}

function studentBinding(path: string | null): string {
    if (!path) return "v0.8-a13";
    const artifact = JSON.parse(readFileSync(path, "utf8")) as IV09ModelArtifact;
    verifyV09ResearchArtifact(artifact);
    return artifact.modelSha256!;
}

function validateActorOutput(
    context: IOrchestratorContext,
    purpose: V09SeedPurpose,
    binding: string,
    expected: number,
    smokeRun: boolean,
): void {
    const directory = resolve(context.campaignDirectory, smokeRun ? "il-smoke" : "il", purpose, binding);
    const files = existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith(".jsonl")) : [];
    if (files.length !== expected) {
        throw new Error(`${purpose}/${binding} has ${files.length} complete shards; expected ${expected}`);
    }
    const stream = context.ledger.streams.find((candidate) => candidate.purpose === purpose)!;
    const phase = purpose.startsWith("wide_teacher")
        ? "wide_teacher"
        : purpose.startsWith("dagger_1")
          ? "dagger_1"
          : "dagger_2";
    const split = purpose.endsWith("_validation") ? "validation" : "train";
    for (let index = 0; index < expected; index += 1) {
        const seed = stream.seeds[index]!;
        const file = `${String(index).padStart(6, "0")}-${seed}.jsonl`;
        if (!files.includes(file)) throw new Error(`${purpose}/${binding} is missing exact seed lane ${index}`);
        const footer = validateV09GameShard(resolve(directory, file));
        const pattern =
            phase === "wide_teacher"
                ? "anchor-mirror"
                : (["student-green", "student-red", "student-self-a", "student-self-b"] as const)[index % 4]!;
        const studentVersion = `v0.9-research:${binding}`;
        const [greenVersion, redVersion] =
            phase === "wide_teacher"
                ? (["v0.8+a13", "v0.8+a13"] as const)
                : pattern === "student-green"
                  ? ([studentVersion, "v0.8+a13"] as const)
                  : pattern === "student-red"
                    ? (["v0.8+a13", studentVersion] as const)
                    : ([studentVersion, studentVersion] as const);
        const cohort = V09_TEACHER_COHORTS[index % V09_TEACHER_COHORTS.length]!;
        const map = V09_TEACHER_MAPS[Math.floor(index / V09_TEACHER_COHORTS.length) % V09_TEACHER_MAPS.length]!;
        if (
            footer.gameId !== `${purpose}:${index}:${seed}:${binding}:${pattern}` ||
            footer.seed !== seed ||
            footer.phase !== phase ||
            footer.split !== split ||
            footer.cohort !== cohort ||
            footer.map !== map.name ||
            footer.greenVersion !== greenVersion ||
            footer.redVersion !== redVersion
        ) {
            throw new Error(`${purpose}/${binding} shard ${index} violates its deterministic schedule`);
        }
    }
}

async function runActorPurpose(
    context: IOrchestratorContext,
    purpose: V09SeedPurpose,
    studentArtifact: string | null,
    workers: number,
    smoke: boolean,
): Promise<void> {
    const physical = physicalCpuIds();
    const reserve = context.manifest.resourcePolicy.v09ActorPhysicalCores.reserveForOsAndLearner;
    if (physical.length < workers + reserve) {
        throw new Error(
            `actor launch needs ${workers} physical lanes plus ${reserve} reserved; found ${physical.length}`,
        );
    }
    const script = resolve(context.repositoryRoot, "src/simulation/v0_9/teacher_actor.ts");
    const launches: IV09ActorCommandLaunch[] = Array.from({ length: workers }, (_, workerIndex) => {
        const actorArgs = [
            script,
            "--campaign",
            context.campaignDirectory,
            "--purpose",
            purpose,
            "--worker-index",
            String(workerIndex),
            "--workers",
            String(workers),
            ...(studentArtifact ? ["--student-artifact", resolve(studentArtifact)] : []),
            ...(smoke ? ["--limit", "1", "--smoke"] : []),
        ];
        const executable = process.platform === "linux" ? "nice" : process.execPath;
        const args =
            process.platform === "linux"
                ? [
                      "-n",
                      String(context.manifest.resourcePolicy.v09Nice),
                      "taskset",
                      "-c",
                      String(physical[workerIndex]),
                      process.execPath,
                      ...actorArgs,
                  ]
                : actorArgs;
        return {
            executable,
            args,
            cwd: context.repositoryRoot,
            environment: { ...process.env, CUDA_VISIBLE_DEVICES: "" },
        };
    });
    const results = await runV09ActorCommandsFailFast(launches);
    const binding = studentBinding(studentArtifact);
    const stream = context.ledger.streams.find((candidate) => candidate.purpose === purpose)!;
    validateActorOutput(context, purpose, binding, smoke ? Math.min(workers, stream.count) : stream.count, smoke);
    const games = results.reduce((sum, result) => {
        const measurements = result.stdout
            .trim()
            .split(/\r?\n/)
            .flatMap((line) => {
                try {
                    const completed = (JSON.parse(line) as { completed?: number }).completed;
                    return Number.isSafeInteger(completed) && completed! >= 0 ? [completed!] : [];
                } catch {
                    return [];
                }
            });
        if (!measurements.length) throw new Error("teacher actor emitted no completion summary");
        return sum + measurements[measurements.length - 1]!;
    }, 0);
    writeReceipt(context, `actors-${purpose}-${binding.slice(0, 12)}${smoke ? "-smoke" : ""}`, {
        purpose,
        binding,
        physicalCpuIds: physical.slice(0, workers),
        workers,
        games,
        gamesPerSecond: games / Math.max(...results.map((result) => result.elapsedSeconds), 1e-9),
        results,
    });
}

async function runActorPhase(
    context: IOrchestratorContext,
    phase: TrainingPhase,
    studentArtifact: string | null,
    workers: number,
    smoke: boolean,
): Promise<void> {
    if (phase !== "wide_teacher" && !studentArtifact) throw new Error(`${phase} requires --student-artifact`);
    if (!smoke) {
        const prerequisite: Record<TrainingPhase, V09CampaignStage> = {
            wide_teacher: "preflight",
            dagger_1: "initial_fit",
            dagger_2: "dagger_1",
        };
        assertCheckpointAtLeast(context, prerequisite[phase]);
    }
    for (const purpose of phasePurposes(phase)) {
        await runActorPurpose(context, purpose, studentArtifact, workers, smoke);
    }
    if (!smoke) {
        const expected = phasePurposes(phase).reduce(
            (sum, purpose) => sum + context.ledger.streams.find((stream) => stream.purpose === purpose)!.count,
            0,
        );
        advanceCheckpoint(context, phase, expected, expected, {
            corpus: fingerprintV09({ phase, studentBinding: studentBinding(studentArtifact) }),
        });
    }
}

async function runLearner(
    context: IOrchestratorContext,
    data: readonly string[],
    tag: string,
    hidden: readonly number[],
    smoke: boolean,
    resume: boolean,
): Promise<string> {
    const launch = buildV09LearnerLaunch(context.manifest, context.repositoryRoot, data, {
        hidden,
        modelTag: tag,
        epochs: smoke ? 1 : 30,
        qatEpochs: smoke ? 1 : 5,
        batchSize: 1024,
        workers: 8,
        resume: false,
        allowPartialCorpus: smoke,
        // A one-epoch smoke fit proves the CUDA/QAT -> CPU fixed-point -> parity pipeline, not model quality.
        // Full training retains the learner's strict 0.99 agreement / 0.01 accuracy-drop gates below.
        minimumFixedAgreement: smoke ? 0 : undefined,
        maximumFixedAccuracyDrop: smoke ? 1 : undefined,
    });
    if (!existsSync(launch.executable)) throw new Error("pinned learner interpreter is missing");
    const outputIndex = launch.argv.indexOf("--out") + 1;
    const checkpointIndex = launch.argv.indexOf("--checkpoint") + 1;
    const artifactPath = launch.argv[outputIndex]!;
    const checkpointPath = launch.argv[checkpointIndex]!;
    const metricsPath = artifactPath.replace(/\.json$/, ".metrics.json");
    const gpuLogPath = resolve(context.campaignDirectory, "hardware", `learner-${tag}-h${hidden.join("x")}.gpu.jsonl`);
    const currentCorpusSha256 = async (): Promise<string> => {
        const corpusValidation = await runCommand(
            launch.executable,
            [
                resolve(context.repositoryRoot, "src/simulation/v0_9/python/corpus.py"),
                "--campaign-manifest",
                resolve(context.campaignDirectory, "manifest.json"),
                ...data.flatMap((path) => ["--data", resolve(path)]),
                ...(smoke ? ["--allow-partial"] : []),
                "--summary-only",
            ],
            {
                cwd: context.repositoryRoot,
                environment: { ...process.env, ...launch.environment },
            },
        );
        const report = JSON.parse(corpusValidation.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as {
            schema?: string;
            runFingerprint?: string;
            corpusSha256?: string;
        };
        if (
            report.schema !== "hoc.ai.v0_9_corpus_validation.v1" ||
            report.runFingerprint !== context.manifest.runFingerprint ||
            !/^[0-9a-f]{64}$/.test(report.corpusSha256 ?? "")
        ) {
            throw new Error("current v0.9 corpus validation did not bind this exact campaign");
        }
        return report.corpusSha256!;
    };
    const validateArtifact = (): IV09ModelArtifact => {
        const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as IV09ModelArtifact;
        verifyV09ResearchArtifact(artifact);
        if (
            artifact.source.trainingRunId !== context.manifest.runFingerprint ||
            artifact.source.commonCommit !== context.manifest.identity.sourceCommit ||
            artifact.source.rulesSha256 !== context.manifest.identity.rulesFingerprint ||
            artifact.source.rosterSha256 !== context.manifest.identity.rosterFingerprint ||
            artifact.architecture.hiddenSizes.join(",") !== hidden.join(",")
        ) {
            throw new Error(`learner artifact ${artifactPath} does not match this exact campaign/architecture`);
        }
        return artifact;
    };
    const readMetrics = (
        expectedCorpusSha256?: string,
    ): {
        history: Array<{ examplesPerSecond?: number }>;
        hardware: {
            device: string;
            torchVersion: string;
            cudaVersion: string;
            cudaDevice: string;
            cudaCapability: number[];
        };
        finalValidation: { top1Accuracy: number };
        fixedValidation: { top1Accuracy: number; floatFixedTop1Agreement: number };
        corpusSha256: string;
    } => {
        if (!existsSync(metricsPath)) throw new Error(`learner metrics are missing at ${metricsPath}`);
        const metrics = JSON.parse(readFileSync(metricsPath, "utf8")) as {
            history?: Array<{ examplesPerSecond?: number }>;
            hardware?: {
                device?: string;
                torchVersion?: string;
                cudaVersion?: string | null;
                cudaDevice?: string | null;
                cudaCapability?: number[] | null;
            };
            finalValidation?: { top1Accuracy?: number };
            fixedValidation?: { top1Accuracy?: number; floatFixedTop1Agreement?: number };
            corpusSha256?: string;
        };
        if (
            !Array.isArray(metrics.history) ||
            !/^[0-9a-f]{64}$/.test(metrics.corpusSha256 ?? "") ||
            (expectedCorpusSha256 !== undefined && metrics.corpusSha256 !== expectedCorpusSha256) ||
            metrics.hardware?.device !== "cuda" ||
            typeof metrics.hardware.torchVersion !== "string" ||
            typeof metrics.hardware.cudaVersion !== "string" ||
            !/RTX\s*5090/i.test(metrics.hardware.cudaDevice ?? "") ||
            !Array.isArray(metrics.hardware.cudaCapability) ||
            metrics.hardware.cudaCapability.length !== 2 ||
            !metrics.hardware.cudaCapability.every((value) => Number.isSafeInteger(value) && value >= 0) ||
            !Number.isFinite(metrics.finalValidation?.top1Accuracy) ||
            !Number.isFinite(metrics.fixedValidation?.top1Accuracy) ||
            !Number.isFinite(metrics.fixedValidation?.floatFixedTop1Agreement)
        ) {
            throw new Error(`learner metrics are malformed or bind a stale corpus at ${metricsPath}`);
        }
        return metrics as ReturnType<typeof readMetrics>;
    };
    const persistedGpuSamples = (): ICommandResult["gpuSamples"] => {
        if (!existsSync(gpuLogPath)) return [];
        return readFileSync(gpuLogPath, "utf8")
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => JSON.parse(line) as ICommandResult["gpuSamples"][number])
            .filter(
                (sample) =>
                    typeof sample.at === "string" &&
                    Number.isFinite(sample.utilization) &&
                    sample.utilization >= 0 &&
                    sample.utilization <= 100 &&
                    Number.isFinite(sample.memoryMiB) &&
                    sample.memoryMiB >= 0 &&
                    Number.isFinite(sample.temperatureC),
            );
    };
    const finalizeLearnerReceipt = (
        artifact: IV09ModelArtifact,
        metrics: ReturnType<typeof readMetrics>,
        result: ICommandResult | null,
    ): void => {
        const throughput = metrics.history
            .map((entry) => entry.examplesPerSecond)
            .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
        if (!throughput.length) throw new Error("learner emitted no positive examples/second measurement");
        const gpu = assessV09LearnerHardwareEvidence(persistedGpuSamples(), throughput);
        if (!smoke && !gpu.satisfied) {
            throw new Error(`learner hardware evidence failed on the pinned RTX 5090: ${gpu.failures.join("; ")}`);
        }
        writeReceipt(context, `learner-${tag}-h${hidden.join("x")}`, {
            artifactPath,
            artifactSha256: sha256File(artifactPath),
            modelSha256: artifact.modelSha256,
            metricsPath,
            metricsSha256: sha256File(metricsPath),
            corpusSha256: metrics.corpusSha256,
            examplesPerSecond: throughput,
            examplesPerSecondSummary: gpu.examplesPerSecond,
            learnerHardware: metrics.hardware,
            gpuLogPath: existsSync(gpuLogPath) ? gpuLogPath : null,
            gpuLogSha256: existsSync(gpuLogPath) ? sha256File(gpuLogPath) : null,
            gpuEvidence: gpu,
            resumedExistingArtifact: result === null,
            result,
        });
    };
    if (existsSync(artifactPath)) {
        const artifact = validateArtifact();
        const metrics = readMetrics(await currentCorpusSha256());
        finalizeLearnerReceipt(artifact, metrics, null);
        return artifactPath;
    }
    if (existsSync(checkpointPath)) {
        if (!resume) throw new Error(`learner checkpoint exists at ${checkpointPath}; use the resume command`);
        launch.argv.push("--resume");
    }
    const result = await runCommand(launch.executable, launch.argv, {
        cwd: context.repositoryRoot,
        environment: { ...process.env, ...launch.environment },
        monitorGpuUuid: V09_RTX5090_GPU_UUID,
        gpuLogPath,
    });
    const artifact = validateArtifact();
    const metrics = readMetrics();
    finalizeLearnerReceipt(artifact, metrics, result);
    return artifactPath;
}

async function runParity(context: IOrchestratorContext, artifactPath: string, id: string): Promise<void> {
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as IV09ModelArtifact;
    verifyV09ResearchArtifact(artifact);
    const vectors = buildV09ParityCorpus(artifact);
    const expected = scoreV09ParityVectors(artifact, vectors);
    const expectedById = new Map(expected.map((entry) => [entry.id, entry.score]));
    const path = resolve(context.campaignDirectory, "parity", `${id}.jsonl`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
        path,
        `${vectors
            .map((vector) => JSON.stringify({ ...vector, expectedScore: expectedById.get(vector.id)! }))
            .join("\n")}\n`,
    );
    const result = await runCommand(
        resolve(context.campaignDirectory, "venv/bin/python"),
        [
            resolve(context.repositoryRoot, "src/simulation/v0_9/python/parity.py"),
            "--artifact",
            resolve(artifactPath),
            "--vectors",
            path,
        ],
        {
            cwd: context.repositoryRoot,
            environment: { ...process.env, ...V09_PYTHON_ENVIRONMENT },
        },
    );
    if (result.stdout.trim().split(/\r?\n/).filter(Boolean).length !== vectors.length) {
        throw new Error("Python/TypeScript parity output count mismatch");
    }
    writeReceipt(context, `parity-${id}`, { artifactPath, vectors: vectors.length, result });
}

interface ILearnerCandidate {
    artifactPath: string;
    artifact: IV09ModelArtifact;
    hidden: readonly number[];
    corpusSha256: string;
    floatTop1: number;
    fixedTop1: number;
    floatFixedAgreement: number;
    parameters: number;
}

function readLearnerCandidate(artifactPath: string, hidden: readonly number[]): ILearnerCandidate {
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as IV09ModelArtifact;
    verifyV09ResearchArtifact(artifact);
    if (artifact.architecture.hiddenSizes.join(",") !== hidden.join(",")) {
        throw new Error(`candidate ${artifactPath} has an unexpected architecture`);
    }
    const metricsPath = artifactPath.replace(/\.json$/, ".metrics.json");
    const metrics = JSON.parse(readFileSync(metricsPath, "utf8")) as {
        corpusSha256?: string;
        finalValidation?: { top1Accuracy?: number };
        fixedValidation?: { top1Accuracy?: number; floatFixedTop1Agreement?: number };
    };
    const floatTop1 = metrics.finalValidation?.top1Accuracy;
    const fixedTop1 = metrics.fixedValidation?.top1Accuracy;
    const floatFixedAgreement = metrics.fixedValidation?.floatFixedTop1Agreement;
    if (
        !metrics.corpusSha256 ||
        !Number.isFinite(floatTop1) ||
        !Number.isFinite(fixedTop1) ||
        !Number.isFinite(floatFixedAgreement)
    ) {
        throw new Error(`candidate metrics ${metricsPath} are incomplete`);
    }
    return {
        artifactPath,
        artifact,
        hidden,
        corpusSha256: metrics.corpusSha256,
        floatTop1: floatTop1!,
        fixedTop1: fixedTop1!,
        floatFixedAgreement: floatFixedAgreement!,
        parameters: artifact.layers.reduce((sum, layer) => sum + layer.weights.length + layer.biases.length, 0),
    };
}

function selectInitialCandidate(
    context: IOrchestratorContext,
    candidates: readonly ILearnerCandidate[],
): ILearnerCandidate {
    if (candidates.length !== V09_ARCHITECTURE_CANDIDATES.length) {
        throw new Error("initial architecture selection requires every preregistered candidate");
    }
    if (new Set(candidates.map((candidate) => candidate.corpusSha256)).size !== 1) {
        throw new Error("initial candidates were not trained on the exact same corpus");
    }
    const ranked = [...candidates].sort(
        (left, right) =>
            right.fixedTop1 - left.fixedTop1 ||
            right.floatFixedAgreement - left.floatFixedAgreement ||
            right.floatTop1 - left.floatTop1 ||
            left.parameters - right.parameters ||
            left.hidden.join("x").localeCompare(right.hidden.join("x")),
    );
    const selected = ranked[0]!;
    writeReceipt(context, "initial-architecture-selection", {
        criterion: [
            "fixedValidation.top1Accuracy:desc",
            "fixedValidation.floatFixedTop1Agreement:desc",
            "finalValidation.top1Accuracy:desc",
            "parameterCount:asc",
            "architecture:asc",
        ],
        corpusSha256: selected.corpusSha256,
        candidates: ranked.map((candidate) => ({
            artifactPath: candidate.artifactPath,
            modelSha256: candidate.artifact.modelSha256,
            hidden: candidate.hidden,
            floatTop1: candidate.floatTop1,
            fixedTop1: candidate.fixedTop1,
            floatFixedAgreement: candidate.floatFixedAgreement,
            parameters: candidate.parameters,
        })),
        selected: {
            artifactPath: selected.artifactPath,
            modelSha256: selected.artifact.modelSha256,
            hidden: selected.hidden,
        },
    });
    return selected;
}

const wideCorpus = (context: IOrchestratorContext): string[] => [
    resolve(context.campaignDirectory, "il/wide_teacher_train/v0.8-a13/*.jsonl"),
    resolve(context.campaignDirectory, "il/wide_teacher_validation/v0.8-a13/*.jsonl"),
];

const daggerCorpus = (
    context: IOrchestratorContext,
    prior: readonly string[],
    phase: "dagger_1" | "dagger_2",
    binding: string,
): string[] => [
    ...prior,
    resolve(context.campaignDirectory, `il/${phase}_train/${binding}/*.jsonl`),
    resolve(context.campaignDirectory, `il/${phase}_validation/${binding}/*.jsonl`),
];

async function runQualification(
    context: IOrchestratorContext,
    artifactPath: string,
    concurrency: number,
    nodeRole: V09QualificationNodeRole,
    limitPairs: number | null,
    shardCount: number,
    shardIndex: number,
    smokeRun: boolean,
): Promise<{ outputDirectory: string; receipt: IV09QualificationShardReceipt | null }> {
    if (nodeRole === "production_cpu" && (process.platform !== "linux" || concurrency !== 1)) {
        throw new Error("production_cpu qualification requires Linux and exactly one constrained worker");
    }
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as IV09ModelArtifact;
    verifyV09ResearchArtifact(artifact);
    const id =
        `${artifact.modelSha256!.slice(0, 12)}-${nodeRole.replaceAll("_", "-")}` + `-s${shardIndex}of${shardCount}`;
    const outputDirectory = resolve(context.receiptDirectory, "qualification", id);
    const args = [
        resolve(context.repositoryRoot, "src/simulation/v0_9/qualify.ts"),
        "--campaign",
        context.campaignDirectory,
        "--artifact",
        resolve(artifactPath),
        "--expected-model-sha256",
        artifact.modelSha256!,
        "--out",
        outputDirectory,
        "--node-role",
        nodeRole,
        "--concurrency",
        String(concurrency),
        "--shard-count",
        String(shardCount),
        "--shard-index",
        String(shardIndex),
        ...(limitPairs === null ? [] : ["--limit-pairs", String(limitPairs)]),
        ...(smokeRun ? ["--smoke"] : []),
    ];
    const physical = physicalCpuIds();
    const reserve =
        nodeRole === "production_cpu"
            ? 1
            : context.manifest.resourcePolicy.v09ActorPhysicalCores.reserveForOsAndLearner;
    if (physical.length < concurrency + reserve) {
        throw new Error(
            `${nodeRole} qualification needs ${concurrency} physical lanes plus ${reserve} reserved; ` +
                `found ${physical.length}`,
        );
    }
    const selectedCpuIds = physical.slice(0, concurrency);
    const executable = process.platform !== "linux" ? process.execPath : "nice";
    const commandArgs =
        process.platform !== "linux"
            ? args
            : [
                  "-n",
                  String(Math.max(10, context.manifest.resourcePolicy.v09Nice)),
                  "taskset",
                  "-c",
                  selectedCpuIds.join(","),
                  process.execPath,
                  ...args,
              ];
    const result = await runCommand(executable, commandArgs, {
        cwd: context.repositoryRoot,
        environment: { ...process.env, CUDA_VISIBLE_DEVICES: "" },
    });
    const receiptPath = resolve(outputDirectory, "qualification-shard-receipt.json");
    const receipt = existsSync(receiptPath)
        ? (JSON.parse(readFileSync(receiptPath, "utf8")) as IV09QualificationShardReceipt)
        : null;
    if (receipt) {
        validateV09QualificationShardReceipt(receipt);
        if (
            receipt.modelSha256 !== artifact.modelSha256 ||
            receipt.runFingerprint !== context.manifest.runFingerprint ||
            receipt.nodeRole !== nodeRole ||
            receipt.shardCount !== shardCount ||
            receipt.shardIndex !== shardIndex
        ) {
            throw new Error("qualification shard receipt does not match the orchestrated model/campaign/lane");
        }
    } else if (limitPairs === null) {
        throw new Error("complete qualification shard did not emit its immutable receipt");
    }
    writeReceipt(context, `qualification-${id}`, {
        artifactPath,
        outputDirectory,
        receiptPath: receipt ? receiptPath : null,
        shardReceiptSha256: receipt?.receiptSha256 ?? null,
        physicalCpuIds: selectedCpuIds,
        concurrency,
        nodeRole,
        shardCount,
        shardIndex,
        result,
    });
    return { outputDirectory, receipt };
}

async function mergeQualification(
    context: IOrchestratorContext,
    artifactPath: string,
    shardDirectories: readonly string[],
): Promise<{ outputDirectory: string; summary: IV09QualificationSummary }> {
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as IV09ModelArtifact;
    verifyV09ResearchArtifact(artifact);
    const outputDirectory = resolve(
        context.receiptDirectory,
        "qualification",
        `${artifact.modelSha256!.slice(0, 12)}-merged`,
    );
    const args = [
        resolve(context.repositoryRoot, "src/simulation/v0_9/qualify.ts"),
        "--campaign",
        context.campaignDirectory,
        "--artifact",
        resolve(artifactPath),
        "--expected-model-sha256",
        artifact.modelSha256!,
        "--out",
        outputDirectory,
        ...shardDirectories.flatMap((directory) => ["--merge-shard-dir", resolve(directory)]),
    ];
    const result = await runCommand(process.execPath, args, {
        cwd: context.repositoryRoot,
        environment: { ...process.env, CUDA_VISIBLE_DEVICES: "" },
    });
    const summaryPath = resolve(outputDirectory, "qualification-summary.json");
    if (!existsSync(summaryPath)) throw new Error("qualification merge did not emit its immutable summary");
    const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as IV09QualificationSummary;
    validateV09QualificationSummary(summary);
    if (summary.modelSha256 !== artifact.modelSha256 || summary.runFingerprint !== context.manifest.runFingerprint) {
        throw new Error("qualification merge summary does not match the orchestrated model/campaign");
    }
    writeReceipt(context, `qualification-${artifact.modelSha256!.slice(0, 12)}-merged`, {
        artifactPath,
        outputDirectory,
        shardDirectories,
        summaryPath,
        summarySha256: summary.summarySha256,
        result,
    });
    return { outputDirectory, summary };
}

function writeProductionReturnManifest(
    context: IOrchestratorContext,
    productionShardDirectory: string,
    mergedDirectory: string,
    summary: IV09QualificationSummary,
): { path: string; sha256: string } {
    if (!context.handoff) throw new Error("production return evidence requires a verified handoff bundle");
    const sourceFiles = [
        resolve(productionShardDirectory, "qualification-pairs.jsonl"),
        resolve(productionShardDirectory, "qualification-shard-receipt.json"),
        resolve(mergedDirectory, "qualification-summary.json"),
    ];
    const files = sourceFiles
        .map((path) => ({
            path: relative(context.receiptDirectory, path).split("\\").join("/"),
            sha256: sha256File(path),
        }))
        .sort((left, right) => left.path.localeCompare(right.path));
    const unsigned = {
        schema: "hoc.ai.v0_9_production_return.v1",
        handoffBundleSha256: context.handoff.bundle.bundleSha256,
        runFingerprint: context.manifest.runFingerprint,
        modelSha256: summary.modelSha256,
        summarySha256: summary.summarySha256,
        productionCpuP99TurnMs: summary.execution.productionCpuQualification.p99TurnMs,
        status: "qualified_offline_not_promoted",
        files,
        completedAt: summary.completedAt,
    };
    const value = { ...unsigned, returnSha256: fingerprintV09(unsigned) };
    const path = resolve(context.receiptDirectory, "production-return-manifest.json");
    if (existsSync(path)) {
        const existing = JSON.parse(readFileSync(path, "utf8")) as typeof value;
        if (
            existing.returnSha256 !==
                fingerprintV09(
                    Object.fromEntries(Object.entries(existing).filter(([key]) => key !== "returnSha256")),
                ) ||
            fingerprintV09(existing) !== fingerprintV09(value)
        ) {
            throw new Error("existing production return manifest disagrees with exact qualification evidence");
        }
    } else {
        atomicJson(path, value);
    }
    return { path, sha256: sha256File(path) };
}

async function fullPipeline(context: IOrchestratorContext, workers: number, resume: boolean): Promise<void> {
    const completionReceipt = resolve(context.campaignDirectory, "receipts", "training-host-complete.json");
    if (!resume && existsSync(completionReceipt)) {
        throw new Error("training-host pipeline is already complete; use resume to verify/replay it");
    }

    await bootstrapVenv(context);
    await preflight(context);
    await runActorPhase(context, "wide_teacher", null, workers, false);

    const wide = wideCorpus(context);
    const initialCandidates: ILearnerCandidate[] = [];
    for (const hidden of V09_ARCHITECTURE_CANDIDATES) {
        const artifactPath = await runLearner(context, wide, "initial", hidden, false, resume);
        await runParity(context, artifactPath, `initial-h${hidden.join("x")}`);
        initialCandidates.push(readLearnerCandidate(artifactPath, hidden));
    }
    const initial = selectInitialCandidate(context, initialCandidates);
    advanceCheckpoint(
        context,
        "initial_fit",
        initialCandidates.length,
        V09_ARCHITECTURE_CANDIDATES.length,
        Object.fromEntries(
            initialCandidates.map((candidate) => [`h${candidate.hidden.join("x")}`, candidate.artifact.modelSha256!]),
        ),
    );

    await runActorPhase(context, "dagger_1", initial.artifactPath, workers, false);
    const dagger1Data = daggerCorpus(context, wide, "dagger_1", initial.artifact.modelSha256!);
    const dagger1Path = await runLearner(context, dagger1Data, "dagger1", initial.hidden, false, resume);
    await runParity(context, dagger1Path, "dagger1");
    const dagger1 = readLearnerCandidate(dagger1Path, initial.hidden);
    advanceCheckpoint(context, "dagger_1", 1, 1, { student: dagger1.artifact.modelSha256! });

    await runActorPhase(context, "dagger_2", dagger1Path, workers, false);
    const dagger2Data = daggerCorpus(context, dagger1Data, "dagger_2", dagger1.artifact.modelSha256!);
    const finalPath = await runLearner(context, dagger2Data, "dagger2-final", initial.hidden, false, resume);
    await runParity(context, finalPath, "dagger2-final");
    const final = readLearnerCandidate(finalPath, initial.hidden);
    advanceCheckpoint(context, "quantize", 1, 1, { researchModel: final.artifact.modelSha256! });

    const trainingHost = await runQualification(context, finalPath, workers, "training_host", null, 2, 0, false);
    if (!trainingHost.receipt) throw new Error("training-host qualification shard is incomplete");
    const handoff = createV09ProductionHandoffBundle({
        destination: resolve(
            context.campaignDirectory,
            "handoff",
            `v0.9-${final.artifact.modelSha256!.slice(0, 12)}-production`,
        ),
        campaignDirectory: context.campaignDirectory,
        researchArtifactPath: finalPath,
        trainingHostShardDirectory: trainingHost.outputDirectory,
    });
    const productionCommand = handoff.bundle.productionCommand;
    writeReceipt(context, "production-cpu-handoff", {
        status: "awaiting_separate_production_cpu_qualification",
        bundleDirectory: handoff.directory,
        bundleSha256: handoff.bundle.bundleSha256,
        researchArtifactSha256: handoff.bundle.researchArtifactSha256,
        modelSha256: final.artifact.modelSha256,
        trainingHostShardReceiptSha256: handoff.bundle.trainingHostShardReceiptSha256,
        productionCommand,
        promotionIsAutomatic: false,
    });
    writeReceipt(context, "training-host-complete", {
        finalArtifact: finalPath,
        modelSha256: final.artifact.modelSha256,
        selectedArchitecture: final.hidden,
        productionHandoffBundle: handoff.directory,
        productionHandoffBundleSha256: handoff.bundle.bundleSha256,
        productionCommand,
    });
    process.stdout.write(
        `${JSON.stringify({
            status: "training-host-complete",
            finalArtifact: finalPath,
            modelSha256: final.artifact.modelSha256,
            next: productionCommand.join(" "),
        })}\n`,
    );
}

async function smoke(context: IOrchestratorContext, resume: boolean): Promise<void> {
    await bootstrapVenv(context);
    await preflight(context);
    const workers = context.manifest.resourcePolicy.v09ActorPhysicalCores.smoke;
    await runActorPhase(context, "wide_teacher", null, workers, true);
    const wide = [
        resolve(context.campaignDirectory, "il-smoke/wide_teacher_train/v0.8-a13/*.jsonl"),
        resolve(context.campaignDirectory, "il-smoke/wide_teacher_validation/v0.8-a13/*.jsonl"),
    ];
    const initial = await runLearner(context, wide, "smoke-wide", [64, 32], true, resume);
    await runParity(context, initial, "smoke-wide");
    await runActorPhase(context, "dagger_1", initial, workers, true);
    const initialArtifact = JSON.parse(readFileSync(initial, "utf8")) as IV09ModelArtifact;
    const dagger1Data = [
        ...wide,
        resolve(context.campaignDirectory, `il-smoke/dagger_1_train/${initialArtifact.modelSha256}/*.jsonl`),
        resolve(context.campaignDirectory, `il-smoke/dagger_1_validation/${initialArtifact.modelSha256}/*.jsonl`),
    ];
    const dagger1 = await runLearner(context, dagger1Data, "smoke-dagger1", [64, 32], true, resume);
    await runParity(context, dagger1, "smoke-dagger1");
    await runActorPhase(context, "dagger_2", dagger1, workers, true);
    const dagger1Artifact = JSON.parse(readFileSync(dagger1, "utf8")) as IV09ModelArtifact;
    const dagger2Data = [
        ...dagger1Data,
        resolve(context.campaignDirectory, `il-smoke/dagger_2_train/${dagger1Artifact.modelSha256}/*.jsonl`),
        resolve(context.campaignDirectory, `il-smoke/dagger_2_validation/${dagger1Artifact.modelSha256}/*.jsonl`),
    ];
    const dagger2 = await runLearner(context, dagger2Data, "smoke-dagger2", [64, 32], true, resume);
    await runParity(context, dagger2, "smoke-dagger2");
    await runQualification(context, dagger2, workers, "development_smoke", 1, 1, 0, true);
    writeReceipt(context, "smoke-complete", { artifacts: { initial, dagger1, dagger2 } });
}

interface ICli {
    command: string;
    context: IOrchestratorContext;
    values: {
        phase?: string;
        student?: string;
        artifact?: string;
        data?: string[];
        tag?: string;
        hidden?: string;
        workers?: string;
        resume?: boolean;
        smoke?: boolean;
        nodeRole?: string;
        bundle?: string;
        out?: string;
    };
}

function cli(): ICli {
    const { positionals, values } = parseArgs({
        args: Bun.argv.slice(2),
        allowPositionals: true,
        options: {
            campaign: { type: "string" },
            bundle: { type: "string" },
            out: { type: "string" },
            repository: { type: "string", default: process.cwd() },
            phase: { type: "string" },
            student: { type: "string" },
            artifact: { type: "string" },
            data: { type: "string", multiple: true },
            tag: { type: "string" },
            hidden: { type: "string" },
            workers: { type: "string" },
            resume: { type: "boolean", default: false },
            smoke: { type: "boolean", default: false },
            "node-role": { type: "string" },
        },
        strict: true,
    });
    const command = positionals[0];
    if (!command) {
        throw new Error(
            "usage: bun orchestrator.ts " +
                "<bootstrap|preflight|actors|learner|parity|qualification|smoke|launch|resume> " +
                "(--campaign <dir> | qualification --bundle <dir> --out <dir>) [stage options]",
        );
    }
    const qualification = command === "qualification";
    if (
        (qualification && (!values.bundle || !values.out || values.campaign || values.artifact)) ||
        (!qualification && (!values.campaign || values.bundle || values.out))
    ) {
        throw new Error(
            qualification
                ? "qualification requires --bundle and --out and rejects --campaign/--artifact"
                : `${command} requires --campaign and rejects production --bundle/--out`,
        );
    }
    const context = qualification
        ? loadBundleContext(values.bundle!, values.repository, values.out!)
        : loadContext(values.campaign!, values.repository);
    return {
        command,
        context,
        values: {
            ...values,
            artifact: qualification ? context.handoff!.artifactPath : values.artifact,
            nodeRole: values["node-role"],
        },
    };
}

async function main(): Promise<void> {
    const { command, context, values } = cli();
    if (command === "qualification" && values.workers === undefined) {
        throw new Error("production qualification requires an explicit --workers 1");
    }
    const workers = Number(values.workers ?? context.manifest.resourcePolicy.v09ActorPhysicalCores.target);
    const maximumWorkers = command === "qualification" ? 1 : 20;
    if (!Number.isSafeInteger(workers) || workers < 1 || workers > maximumWorkers) {
        throw new Error(`workers must be 1..${maximumWorkers}`);
    }
    if (command === "bootstrap") return withOrchestratorLock(context, command, () => bootstrapVenv(context));
    if (command === "preflight") return withOrchestratorLock(context, command, () => preflight(context));
    if (command === "smoke") {
        return withOrchestratorLock(context, command, () => smoke(context, values.resume === true));
    }
    if (command === "launch") {
        return withOrchestratorLock(context, command, () => fullPipeline(context, workers, false));
    }
    if (command === "resume") {
        return withOrchestratorLock(context, command, () => fullPipeline(context, workers, true));
    }
    if (command === "actors") {
        if (values.phase !== "wide_teacher" && values.phase !== "dagger_1" && values.phase !== "dagger_2") {
            throw new Error("actors requires --phase wide_teacher|dagger_1|dagger_2");
        }
        return withOrchestratorLock(context, command, () =>
            runActorPhase(
                context,
                values.phase as TrainingPhase,
                values.student ? resolve(values.student) : null,
                workers,
                values.smoke === true,
            ),
        );
    }
    if (command === "learner") {
        if (!values.data?.length || !values.tag) throw new Error("learner requires --data ... and --tag");
        const hidden = (values.hidden ?? V09_ARCHITECTURE_CANDIDATES[0].join(",")).split(",").map(Number);
        const artifact = await withOrchestratorLock(context, command, () =>
            runLearner(context, values.data!, values.tag!, hidden, values.smoke === true, values.resume === true),
        );
        process.stdout.write(`${JSON.stringify({ artifact })}\n`);
        return;
    }
    if (command === "parity") {
        if (!values.artifact || !values.tag) throw new Error("parity requires --artifact and --tag");
        return withOrchestratorLock(context, command, () => runParity(context, resolve(values.artifact!), values.tag!));
    }
    if (command === "qualification") {
        if (!values.artifact) throw new Error("qualification requires --artifact");
        if (values.nodeRole !== "production_cpu" || values.smoke) {
            throw new Error("bundle qualification requires --node-role production_cpu and does not allow --smoke");
        }
        assertCheckpointAtLeast(context, "quantize");
        return withOrchestratorLock(context, command, async () => {
            const outcome = await runQualification(
                context,
                resolve(values.artifact!),
                workers,
                "production_cpu",
                null,
                2,
                1,
                false,
            );
            if (!outcome.receipt) throw new Error("production-CPU qualification shard is incomplete");
            const artifact = JSON.parse(readFileSync(resolve(values.artifact!), "utf8")) as IV09ModelArtifact;
            verifyV09ResearchArtifact(artifact);
            const merged = await mergeQualification(context, resolve(values.artifact!), [
                context.handoff!.trainingHostShardDirectory,
                outcome.outputDirectory,
            ]);
            if (
                merged.summary.status !== "qualified_offline" ||
                merged.summary.failures.length ||
                !merged.summary.execution.productionCpuQualification.satisfied ||
                !merged.summary.execution.nodes.some((node) => node.nodeRole === "production_cpu")
            ) {
                throw new Error("production-CPU qualification did not pass every preregistered gate");
            }
            const productionReturn = writeProductionReturnManifest(
                context,
                outcome.outputDirectory,
                merged.outputDirectory,
                merged.summary,
            );
            writeReceipt(context, "production-cpu-qualified", {
                status: "qualified_offline_not_promoted",
                handoffBundleSha256: context.handoff!.bundle.bundleSha256,
                artifact: resolve(values.artifact!),
                modelSha256: merged.summary.modelSha256,
                summary: resolve(merged.outputDirectory, "qualification-summary.json"),
                summarySha256: merged.summary.summarySha256,
                productionReturnManifest: productionReturn.path,
                productionReturnManifestSha256: productionReturn.sha256,
            });
        });
    }
    throw new Error(`unknown v0.9 orchestrator command ${command}`);
}

if (import.meta.main) {
    main().catch((error) => {
        process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
        process.exitCode = error instanceof V09ActorCommandsInterruptedError ? error.exitCode : 1;
    });
}
