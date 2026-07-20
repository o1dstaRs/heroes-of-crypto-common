/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
    appendFileSync,
    closeSync,
    existsSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { arch, cpus, hostname, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
    assertV07NonfightCampaignLaunchable,
    buildV07NonfightCampaignProvenance,
    canonicalV07NonfightCampaignJson,
    deriveV07NonfightCampaignTiming,
    fingerprintV07NonfightCampaign,
    renderV07NonfightCampaignLane,
    resolveV07NonfightCampaignConfig,
    sanitizeV07NonfightCampaignEnvironment,
    type IV07NonfightCampaignConfig,
    type IV07NonfightCampaignProvenance,
    type IV07NonfightCampaignRenderedLane,
    type IV07NonfightCampaignTiming,
} from "./v0_7_nonfight_campaign_core";

type V07NonfightLaneStatus =
    | "pending"
    | "waiting-to-restart"
    | "running"
    | "completed"
    | "failed"
    | "deadline-stopped"
    | "signal-stopped";

interface IV07NonfightCampaignRun {
    schemaVersion: 1;
    artifactKind: "v0_7_nonfight_campaign_run";
    status: "research_only_no_bake";
    automaticBake: false;
    automaticDeploy: false;
    runId: string;
    configSha256: string;
    outputDirectory: string;
    repositoryRoot: string;
    hours: number;
    durationMs: number;
    totalWorkers: number;
    heartbeatMs: number;
    stopGraceMs: number;
    laneStopGraceMs: number;
    startAtMs: number;
    laneDeadlineAtMs: number;
    hardDeadlineAtMs: number;
    provenance: IV07NonfightCampaignProvenance;
    lanes: IV07NonfightCampaignRenderedLane[];
    runSha256: string;
}

interface IV07NonfightLaneState {
    schemaVersion: 1;
    artifactKind: "v0_7_nonfight_campaign_lane_state";
    runId: string;
    lane: string;
    status: V07NonfightLaneStatus;
    attempt: number;
    pid: number | null;
    pgid: number | null;
    startedAtMs: number | null;
    endedAtMs: number | null;
    nextRestartAtMs: number | null;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    detail: string;
    logPath: string | null;
    updatedAtMs: number;
    stateSha256: string;
}

interface IV07NonfightCampaignHeartbeat {
    schemaVersion: 1;
    artifactKind: "v0_7_nonfight_campaign_heartbeat";
    status: "research_only_no_bake";
    automaticBake: false;
    automaticDeploy: false;
    runId: string;
    supervisorPid: number;
    sequence: number;
    nowMs: number;
    laneDeadlineAtMs: number;
    hardDeadlineAtMs: number;
    remainingMs: number;
    lanes: Array<Omit<IV07NonfightLaneState, "stateSha256">>;
    heartbeatSha256: string;
}

interface IV07NonfightCampaignTerminal {
    schemaVersion: 1;
    artifactKind: "v0_7_nonfight_campaign_terminal";
    status: "complete_research_only" | "failed_research_only" | "interrupted_research_only";
    automaticBake: false;
    automaticDeploy: false;
    promotionAttempted: false;
    runId: string;
    runSha256: string;
    reason: "deadline" | "lanes_completed" | "lane_failure" | "signal";
    signal: NodeJS.Signals | null;
    completedAtMs: number;
    startAtMs: number;
    laneDeadlineAtMs: number;
    hardDeadlineAtMs: number;
    hardDeadlineKilledLanes: string[];
    lanes: Array<Omit<IV07NonfightLaneState, "stateSha256">>;
    terminalSha256: string;
}

interface IV07NonfightLockOwner {
    schemaVersion: 1;
    token: string;
    pid: number;
    hostname: string;
    createdAtMs: number;
}

interface IV07NonfightRuntimeLane {
    definition: IV07NonfightCampaignRenderedLane;
    state: IV07NonfightLaneState;
    child: ChildProcess | null;
    childExitObserved: boolean;
}

const LOCK_DIRECTORY_NAME = ".nonfight-supervisor.lock";
const REPOSITORY_ROOT = resolve(import.meta.dir, "../../..");

function usage(): never {
    throw new Error(
        "Usage: bun src/simulation/optimizer/v0_7_nonfight_campaign.ts --config <path> [--output <path>] [--hours <number>]",
    );
}

function parseCli(argv: readonly string[]): { configPath: string; output?: string; hours?: number } {
    let configPath: string | undefined;
    let output: string | undefined;
    let hours: number | undefined;
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index]!;
        const [inlineName, inlineValue] = argument.split("=", 2);
        const takeValue = (): string => {
            if (inlineValue !== undefined) return inlineValue;
            const value = argv[(index += 1)];
            if (!value) usage();
            return value;
        };
        if (inlineName === "--config") configPath = takeValue();
        else if (inlineName === "--output") output = takeValue();
        else if (inlineName === "--hours") {
            hours = Number(takeValue());
            if (!Number.isFinite(hours)) throw new Error("--hours must be finite");
        } else if (argument === "--help" || argument === "-h") usage();
        else throw new Error(`Unknown argument ${argument}`);
    }
    if (!configPath) usage();
    return { configPath: resolve(configPath), output, hours };
}

function signed<T extends object, K extends string>(value: T, key: K): T & Record<K, string> {
    return { ...value, [key]: fingerprintV07NonfightCampaign(value) } as T & Record<K, string>;
}

function atomicJson(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
    const descriptor = openSync(temporary, "wx", 0o640);
    try {
        writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
        fsyncSync(descriptor);
    } finally {
        closeSync(descriptor);
    }
    renameSync(temporary, path);
    try {
        const directoryDescriptor = openSync(dirname(path), "r");
        try {
            fsyncSync(directoryDescriptor);
        } finally {
            closeSync(directoryDescriptor);
        }
    } catch {
        // Some macOS filesystems reject directory fsync; the file itself is already durable.
    }
}

function readJson(path: string): unknown {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function git(args: readonly string[]): string {
    return execFileSync("git", [...args], {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    }).trim();
}

function captureProvenance(nowMs: number): IV07NonfightCampaignProvenance {
    return buildV07NonfightCampaignProvenance({
        commit: git(["rev-parse", "HEAD"]),
        tree: git(["rev-parse", "HEAD^{tree}"]),
        branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
        originMain: git(["rev-parse", "refs/remotes/origin/main"]),
        originUrl: git(["remote", "get-url", "origin"]),
        statusPorcelain: execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
            cwd: REPOSITORY_ROOT,
            encoding: "utf8",
        }),
        capturedAtMs: nowMs,
        platform: platform(),
        arch: arch(),
        hostname: hostname(),
        logicalCpuCount: cpus().length,
        bunVersion: Bun.version,
        bunRevision: Bun.revision,
    });
}

function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

function processGroupAlive(pgid: number): boolean {
    try {
        process.kill(-pgid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

function acquireLock(outputDirectory: string): { directory: string; owner: IV07NonfightLockOwner } {
    mkdirSync(outputDirectory, { recursive: true });
    const directory = join(outputDirectory, LOCK_DIRECTORY_NAME);
    const owner: IV07NonfightLockOwner = {
        schemaVersion: 1,
        token: randomUUID(),
        pid: process.pid,
        hostname: hostname(),
        createdAtMs: Date.now(),
    };
    for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
            mkdirSync(directory, { mode: 0o700 });
            atomicJson(join(directory, "owner.json"), owner);
            return { directory, owner };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        let existing: IV07NonfightLockOwner | null = null;
        try {
            existing = readJson(join(directory, "owner.json")) as IV07NonfightLockOwner;
        } catch {
            const ageMs = Date.now() - statSync(directory).mtimeMs;
            if (ageMs < 10_000) throw new Error(`Campaign output is being locked by another supervisor`);
        }
        if (
            existing &&
            (existing.hostname !== owner.hostname || (Number.isSafeInteger(existing.pid) && processAlive(existing.pid)))
        ) {
            throw new Error(`Campaign output is already supervised by ${existing.hostname}:${existing.pid}`);
        }
        renameSync(directory, `${directory}.stale.${Date.now()}.${randomUUID()}`);
    }
    throw new Error("Unable to acquire campaign supervisor lock");
}

function releaseLock(lock: { directory: string; owner: IV07NonfightLockOwner }): void {
    try {
        const current = readJson(join(lock.directory, "owner.json")) as IV07NonfightLockOwner;
        if (current.token === lock.owner.token) rmSync(lock.directory, { recursive: true, force: true });
    } catch {
        // Never remove a lock whose ownership cannot be proven.
    }
}

function log(outputDirectory: string, message: string): void {
    appendFileSync(join(outputDirectory, "supervisor.log"), `[${new Date().toISOString()}] ${message}\n`, "utf8");
}

function runUnsigned(run: IV07NonfightCampaignRun): Omit<IV07NonfightCampaignRun, "runSha256"> {
    const unsigned = { ...run };
    delete (unsigned as Partial<IV07NonfightCampaignRun>).runSha256;
    return unsigned;
}

function validateExistingRun(value: unknown): IV07NonfightCampaignRun {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("run.json must be an object");
    const run = value as IV07NonfightCampaignRun;
    if (
        run.schemaVersion !== 1 ||
        run.artifactKind !== "v0_7_nonfight_campaign_run" ||
        run.status !== "research_only_no_bake" ||
        run.automaticBake !== false ||
        run.automaticDeploy !== false ||
        run.runSha256 !== fingerprintV07NonfightCampaign(runUnsigned(run))
    ) {
        throw new Error("Existing campaign run.json is invalid or has been modified");
    }
    return run;
}

function terminalUnsigned(
    terminal: IV07NonfightCampaignTerminal,
): Omit<IV07NonfightCampaignTerminal, "terminalSha256"> {
    const unsigned = { ...terminal };
    delete (unsigned as Partial<IV07NonfightCampaignTerminal>).terminalSha256;
    return unsigned;
}

function validTerminal(path: string, runId: string): IV07NonfightCampaignTerminal | null {
    if (!existsSync(path)) return null;
    const terminal = readJson(path) as IV07NonfightCampaignTerminal;
    if (
        terminal.schemaVersion !== 1 ||
        terminal.artifactKind !== "v0_7_nonfight_campaign_terminal" ||
        terminal.runId !== runId ||
        terminal.automaticBake !== false ||
        terminal.automaticDeploy !== false ||
        terminal.promotionAttempted !== false ||
        terminal.terminalSha256 !== fingerprintV07NonfightCampaign(terminalUnsigned(terminal))
    ) {
        throw new Error("Existing campaign TERMINAL.json is invalid or has been modified");
    }
    return terminal;
}

function laneStateUnsigned(state: IV07NonfightLaneState): Omit<IV07NonfightLaneState, "stateSha256"> {
    const unsigned = { ...state };
    delete (unsigned as Partial<IV07NonfightLaneState>).stateSha256;
    return unsigned;
}

function persistLaneState(outputDirectory: string, runtime: IV07NonfightRuntimeLane): void {
    const updated = signed(
        { ...laneStateUnsigned(runtime.state), updatedAtMs: Date.now() },
        "stateSha256",
    ) as IV07NonfightLaneState;
    runtime.state = updated;
    atomicJson(join(outputDirectory, "lanes", runtime.definition.name, "lane-state.json"), updated);
}

function initialLaneState(runId: string, lane: string): IV07NonfightLaneState {
    return signed(
        {
            schemaVersion: 1 as const,
            artifactKind: "v0_7_nonfight_campaign_lane_state" as const,
            runId,
            lane,
            status: "pending" as const,
            attempt: 0,
            pid: null,
            pgid: null,
            startedAtMs: null,
            endedAtMs: null,
            nextRestartAtMs: null,
            exitCode: null,
            signal: null,
            detail: "awaiting first launch",
            logPath: null,
            updatedAtMs: Date.now(),
        },
        "stateSha256",
    );
}

function loadLaneState(runId: string, definition: IV07NonfightCampaignRenderedLane): IV07NonfightLaneState {
    const path = join(dirname(dirname(definition.outputDirectory)), definition.name, "lane-state.json");
    if (!existsSync(path)) return initialLaneState(runId, definition.name);
    const state = readJson(path) as IV07NonfightLaneState;
    if (
        state.schemaVersion !== 1 ||
        state.artifactKind !== "v0_7_nonfight_campaign_lane_state" ||
        state.runId !== runId ||
        state.lane !== definition.name ||
        state.stateSha256 !== fingerprintV07NonfightCampaign(laneStateUnsigned(state))
    ) {
        throw new Error(`Invalid persisted lane state for ${definition.name}`);
    }
    return state;
}

function sanitizedEnvironment(run: IV07NonfightCampaignRun, lane: IV07NonfightCampaignRenderedLane): NodeJS.ProcessEnv {
    return sanitizeV07NonfightCampaignEnvironment(process.env, {
        ...lane.env,
        HOC_NONFIGHT_RESEARCH_ONLY: "1",
        HOC_NONFIGHT_NO_BAKE: "1",
        HOC_NONFIGHT_NO_DEPLOY: "1",
        HOC_NONFIGHT_RUN_ID: run.runId,
        HOC_NONFIGHT_LANE: lane.name,
        HOC_NONFIGHT_WORKERS: String(lane.workers),
        HOC_NONFIGHT_OUTPUT: lane.outputDirectory,
        HOC_NONFIGHT_LANE_DEADLINE_MS: String(run.laneDeadlineAtMs),
        HOC_NONFIGHT_HARD_DEADLINE_MS: String(run.hardDeadlineAtMs),
    });
}

async function spawnLane(
    outputDirectory: string,
    run: IV07NonfightCampaignRun,
    runtime: IV07NonfightRuntimeLane,
    wake: () => void,
): Promise<void> {
    const attempt = runtime.state.attempt + 1;
    const laneDirectory = join(outputDirectory, "lanes", runtime.definition.name);
    mkdirSync(runtime.definition.outputDirectory, { recursive: true });
    mkdirSync(laneDirectory, { recursive: true });
    const logPath = join(laneDirectory, `attempt-${String(attempt).padStart(3, "0")}.log`);
    const logDescriptor = openSync(logPath, "a", 0o640);
    let child: ChildProcess;
    try {
        child = spawn(runtime.definition.command[0]!, runtime.definition.command.slice(1), {
            cwd: runtime.definition.cwd,
            env: sanitizedEnvironment(run, runtime.definition),
            detached: true,
            stdio: ["ignore", logDescriptor, logDescriptor],
        });
        await new Promise<void>((resolveSpawn, rejectSpawn) => {
            child.once("spawn", resolveSpawn);
            child.once("error", rejectSpawn);
        });
    } finally {
        closeSync(logDescriptor);
    }
    if (!child.pid) throw new Error(`Lane ${runtime.definition.name} child has no pid`);
    runtime.child = child;
    runtime.childExitObserved = false;
    runtime.state = {
        ...runtime.state,
        status: "running",
        attempt,
        pid: child.pid,
        pgid: child.pid,
        startedAtMs: Date.now(),
        endedAtMs: null,
        nextRestartAtMs: null,
        exitCode: null,
        signal: null,
        detail: `attempt ${attempt} running`,
        logPath,
    };
    child.once("exit", (code, signal) => {
        runtime.childExitObserved = true;
        runtime.state.exitCode = code;
        runtime.state.signal = signal;
        wake();
    });
    persistLaneState(outputDirectory, runtime);
    log(outputDirectory, `lane=${runtime.definition.name} attempt=${attempt} pid=${child.pid} started`);
}

function finalizeExitedLane(outputDirectory: string, runtime: IV07NonfightRuntimeLane, nowMs: number): void {
    const exitCode = runtime.state.exitCode;
    runtime.child = null;
    runtime.childExitObserved = false;
    runtime.state.pid = null;
    runtime.state.pgid = null;
    runtime.state.endedAtMs = nowMs;
    if (exitCode === 0) {
        runtime.state.status = "completed";
        runtime.state.detail = `attempt ${runtime.state.attempt} completed with exit 0`;
    } else if (
        runtime.definition.restartPolicy === "on-failure" &&
        runtime.state.attempt <= runtime.definition.maxRestarts
    ) {
        runtime.state.status = "waiting-to-restart";
        runtime.state.nextRestartAtMs = nowMs + runtime.definition.restartBackoffMs;
        runtime.state.detail = `attempt ${runtime.state.attempt} exited ${String(exitCode)}; restart scheduled`;
    } else {
        runtime.state.status = "failed";
        runtime.state.detail = `attempt ${runtime.state.attempt} exited ${String(exitCode)}; restart budget exhausted`;
    }
    persistLaneState(outputDirectory, runtime);
    log(outputDirectory, `lane=${runtime.definition.name} ${runtime.state.detail}`);
}

function snapshotLane(state: IV07NonfightLaneState): Omit<IV07NonfightLaneState, "stateSha256"> {
    return laneStateUnsigned(state);
}

function writeHeartbeat(
    outputDirectory: string,
    run: IV07NonfightCampaignRun,
    runtimes: readonly IV07NonfightRuntimeLane[],
    sequence: number,
): void {
    const nowMs = Date.now();
    const heartbeat = signed(
        {
            schemaVersion: 1 as const,
            artifactKind: "v0_7_nonfight_campaign_heartbeat" as const,
            status: "research_only_no_bake" as const,
            automaticBake: false as const,
            automaticDeploy: false as const,
            runId: run.runId,
            supervisorPid: process.pid,
            sequence,
            nowMs,
            laneDeadlineAtMs: run.laneDeadlineAtMs,
            hardDeadlineAtMs: run.hardDeadlineAtMs,
            remainingMs: Math.max(0, run.hardDeadlineAtMs - nowMs),
            lanes: runtimes.map(({ state }) => snapshotLane(state)),
        },
        "heartbeatSha256",
    ) as IV07NonfightCampaignHeartbeat;
    atomicJson(join(outputDirectory, "heartbeat.json"), heartbeat);
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
    try {
        process.kill(-pgid, signal);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
}

async function stopRunningLanes(
    outputDirectory: string,
    runtimes: readonly IV07NonfightRuntimeLane[],
    terminalStatus: "deadline-stopped" | "signal-stopped",
    graceMs: number,
): Promise<void> {
    const groups = runtimes.flatMap(({ state }) =>
        state.status === "running" && state.pgid !== null ? [state.pgid] : [],
    );
    for (const pgid of groups) signalGroup(pgid, "SIGTERM");
    if (groups.length) await new Promise((resolveSleep) => setTimeout(resolveSleep, graceMs));
    for (const pgid of groups) if (processGroupAlive(pgid)) signalGroup(pgid, "SIGKILL");
    const nowMs = Date.now();
    for (const runtime of runtimes) {
        if (runtime.state.status !== "running") continue;
        runtime.state = {
            ...runtime.state,
            status: terminalStatus,
            pid: null,
            pgid: null,
            endedAtMs: nowMs,
            nextRestartAtMs: null,
            detail: terminalStatus === "deadline-stopped" ? "stopped at hard deadline" : "stopped by signal",
        };
        persistLaneState(outputDirectory, runtime);
    }
}

function writeTerminal(
    outputDirectory: string,
    run: IV07NonfightCampaignRun,
    runtimes: readonly IV07NonfightRuntimeLane[],
    reason: IV07NonfightCampaignTerminal["reason"],
    requestedSignal: NodeJS.Signals | null,
): IV07NonfightCampaignTerminal {
    const hardDeadlineKilledLanes = runtimes
        .filter(({ state }) => state.status === "deadline-stopped")
        .map(({ definition }) => definition.name)
        .sort();
    const terminalHasFailure =
        reason === "lane_failure" ||
        hardDeadlineKilledLanes.length > 0 ||
        runtimes.some(({ state }) => state.status === "failed");
    const status =
        reason === "signal"
            ? "interrupted_research_only"
            : terminalHasFailure
              ? "failed_research_only"
              : "complete_research_only";
    const terminal = signed(
        {
            schemaVersion: 1 as const,
            artifactKind: "v0_7_nonfight_campaign_terminal" as const,
            status,
            automaticBake: false as const,
            automaticDeploy: false as const,
            promotionAttempted: false as const,
            runId: run.runId,
            runSha256: run.runSha256,
            reason,
            signal: requestedSignal,
            completedAtMs: Date.now(),
            startAtMs: run.startAtMs,
            laneDeadlineAtMs: run.laneDeadlineAtMs,
            hardDeadlineAtMs: run.hardDeadlineAtMs,
            hardDeadlineKilledLanes,
            lanes: runtimes.map(({ state }) => snapshotLane(state)),
        },
        "terminalSha256",
    ) as IV07NonfightCampaignTerminal;
    atomicJson(join(outputDirectory, "TERMINAL.json"), terminal);
    return terminal;
}

function makeRun(
    config: IV07NonfightCampaignConfig,
    provenance: IV07NonfightCampaignProvenance,
    timing: IV07NonfightCampaignTiming,
): IV07NonfightCampaignRun {
    const runId = randomUUID();
    const lanes = config.lanes.map((lane) => {
        const laneOutputDir = join(config.outputDirectory, "lanes", lane.name, "output");
        return renderV07NonfightCampaignLane(lane, {
            runId,
            repositoryRoot: config.repositoryRoot,
            campaignOutputDir: config.outputDirectory,
            laneOutputDir,
            workers: lane.workers,
            laneDeadlineAtMs: timing.laneDeadlineAtMs,
            hardDeadlineAtMs: timing.hardDeadlineAtMs,
        });
    });
    return signed(
        {
            schemaVersion: 1 as const,
            artifactKind: "v0_7_nonfight_campaign_run" as const,
            status: "research_only_no_bake" as const,
            automaticBake: false as const,
            automaticDeploy: false as const,
            runId,
            configSha256: config.configSha256,
            outputDirectory: config.outputDirectory,
            repositoryRoot: config.repositoryRoot,
            hours: config.hours,
            durationMs: config.durationMs,
            totalWorkers: config.totalWorkers,
            heartbeatMs: config.heartbeatMs,
            stopGraceMs: config.stopGraceMs,
            laneStopGraceMs: config.laneStopGraceMs,
            startAtMs: timing.startAtMs,
            laneDeadlineAtMs: timing.laneDeadlineAtMs,
            hardDeadlineAtMs: timing.hardDeadlineAtMs,
            provenance,
            lanes,
        },
        "runSha256",
    ) as IV07NonfightCampaignRun;
}

async function supervise(config: IV07NonfightCampaignConfig): Promise<IV07NonfightCampaignTerminal> {
    const lock = acquireLock(config.outputDirectory);
    let wakeSleep: (() => void) | null = null;
    let requestedSignal: NodeJS.Signals | null = null;
    const requestStop = (signal: NodeJS.Signals): void => {
        requestedSignal ??= signal;
        wakeSleep?.();
    };
    const supervisedSignals: NodeJS.Signals[] = ["SIGHUP", "SIGINT", "SIGTERM"];
    const signalHandlers: Array<[NodeJS.Signals, () => void]> = supervisedSignals.map((signal) => [
        signal,
        () => requestStop(signal),
    ]);
    for (const [signal, handler] of signalHandlers) process.on(signal, handler);
    try {
        const provenance = captureProvenance(Date.now());
        assertV07NonfightCampaignLaunchable(provenance);
        const runPath = join(config.outputDirectory, "run.json");
        let run: IV07NonfightCampaignRun;
        if (existsSync(runPath)) {
            run = validateExistingRun(readJson(runPath));
            if (run.configSha256 !== config.configSha256) {
                throw new Error("Existing campaign config fingerprint differs; use a fresh output directory");
            }
            if (run.provenance.commit !== provenance.commit || run.provenance.tree !== provenance.tree) {
                throw new Error("Existing campaign source provenance differs; refusing an in-place source change");
            }
            const terminal = validTerminal(join(config.outputDirectory, "TERMINAL.json"), run.runId);
            if (terminal) return terminal;
            log(config.outputDirectory, `resuming run=${run.runId} with persisted hard deadline`);
        } else {
            const timing = deriveV07NonfightCampaignTiming(Date.now(), config.durationMs, config.laneStopGraceMs);
            run = makeRun(config, provenance, timing);
            atomicJson(runPath, run);
            log(
                config.outputDirectory,
                `created run=${run.runId} laneDeadline=${run.laneDeadlineAtMs} hardDeadline=${run.hardDeadlineAtMs}`,
            );
        }
        atomicJson(
            join(config.outputDirectory, "supervisor.pid.json"),
            signed(
                {
                    schemaVersion: 1 as const,
                    artifactKind: "v0_7_nonfight_campaign_supervisor_pid" as const,
                    runId: run.runId,
                    pid: process.pid,
                    hostname: hostname(),
                    startedAtMs: Date.now(),
                },
                "pidSha256",
            ),
        );
        const runtimes: IV07NonfightRuntimeLane[] = run.lanes.map((definition) => {
            const state = loadLaneState(run.runId, definition);
            if (state.status === "running" && (state.pgid === null || !processGroupAlive(state.pgid))) {
                state.status = "waiting-to-restart";
                state.pid = null;
                state.pgid = null;
                state.exitCode = null;
                state.signal = null;
                state.nextRestartAtMs = Date.now();
                state.detail = "prior supervisor disappeared and process group is absent; restart scheduled";
            }
            return { definition, state, child: null, childExitObserved: false };
        });
        for (const runtime of runtimes) persistLaneState(config.outputDirectory, runtime);

        let heartbeatSequence = 0;
        const wake = (): void => wakeSleep?.();
        const sleep = async (milliseconds: number): Promise<void> => {
            await new Promise<void>((resolveSleep) => {
                const timer = setTimeout(() => {
                    wakeSleep = null;
                    resolveSleep();
                }, milliseconds);
                wakeSleep = () => {
                    clearTimeout(timer);
                    wakeSleep = null;
                    resolveSleep();
                };
            });
        };

        while (true) {
            const nowMs = Date.now();
            for (const runtime of runtimes) {
                if (runtime.state.status === "running") {
                    const groupAlive = runtime.state.pgid !== null && processGroupAlive(runtime.state.pgid);
                    if (!groupAlive && (runtime.childExitObserved || runtime.child === null)) {
                        finalizeExitedLane(config.outputDirectory, runtime, nowMs);
                    }
                }
                if (
                    (runtime.state.status === "pending" || runtime.state.status === "waiting-to-restart") &&
                    (runtime.state.nextRestartAtMs === null || runtime.state.nextRestartAtMs <= nowMs) &&
                    nowMs < run.laneDeadlineAtMs
                ) {
                    try {
                        await spawnLane(config.outputDirectory, run, runtime, wake);
                    } catch (error) {
                        runtime.state.exitCode = 70;
                        runtime.state.detail = `spawn failed: ${String(error)}`;
                        runtime.state.attempt += 1;
                        finalizeExitedLane(config.outputDirectory, runtime, Date.now());
                    }
                } else if (
                    (runtime.state.status === "pending" || runtime.state.status === "waiting-to-restart") &&
                    nowMs >= run.laneDeadlineAtMs
                ) {
                    runtime.state.status = "failed";
                    runtime.state.nextRestartAtMs = null;
                    runtime.state.detail = "lane finalization deadline passed before launch or restart";
                    persistLaneState(config.outputDirectory, runtime);
                }
            }
            writeHeartbeat(config.outputDirectory, run, runtimes, heartbeatSequence++);

            if (requestedSignal) {
                await stopRunningLanes(config.outputDirectory, runtimes, "signal-stopped", config.stopGraceMs);
                return writeTerminal(config.outputDirectory, run, runtimes, "signal", requestedSignal);
            }
            if (Date.now() >= run.hardDeadlineAtMs) {
                await stopRunningLanes(config.outputDirectory, runtimes, "deadline-stopped", config.stopGraceMs);
                return writeTerminal(config.outputDirectory, run, runtimes, "deadline", null);
            }
            if (runtimes.every(({ state }) => state.status === "completed")) {
                return writeTerminal(config.outputDirectory, run, runtimes, "lanes_completed", null);
            }
            if (runtimes.every(({ state }) => state.status === "completed" || state.status === "failed")) {
                return writeTerminal(config.outputDirectory, run, runtimes, "lane_failure", null);
            }
            await sleep(Math.max(1, Math.min(config.heartbeatMs, run.hardDeadlineAtMs - Date.now())));
        }
    } finally {
        for (const [signal, handler] of signalHandlers) process.off(signal, handler);
        releaseLock(lock);
    }
}

async function main(): Promise<void> {
    const cli = parseCli(process.argv.slice(2));
    const raw = readJson(cli.configPath);
    const config = resolveV07NonfightCampaignConfig(raw, {
        configDirectory: dirname(cli.configPath),
        repositoryRoot: REPOSITORY_ROOT,
        outputDirectoryOverride: cli.output,
        hoursOverride: cli.hours,
    });
    const terminal = await supervise(config);
    process.stdout.write(`${canonicalV07NonfightCampaignJson(terminal)}\n`);
    process.exitCode =
        terminal.status === "complete_research_only" ? 0 : terminal.status === "interrupted_research_only" ? 143 : 1;
}

if (import.meta.main) {
    main().catch((error) => {
        process.stderr.write(`${basename(import.meta.path)}: ${String(error)}\n`);
        process.exitCode = String(error).includes("already supervised") ? 75 : 64;
    });
}
