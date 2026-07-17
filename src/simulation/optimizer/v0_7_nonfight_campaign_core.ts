/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import { createHash } from "node:crypto";
import { resolve } from "node:path";

export const V07_NONFIGHT_CAMPAIGN_SCHEMA_VERSION = 1 as const;
export const V07_NONFIGHT_CAMPAIGN_DEFAULT_LANE_STOP_GRACE_MS = 30 * 60 * 1000;
export const V07_NONFIGHT_CAMPAIGN_HOUR_MS = 60 * 60 * 1000;

export type V07NonfightLaneRestartPolicy = "never" | "on-failure";

export interface IV07NonfightCampaignLaneConfig {
    name: string;
    workers: number;
    command: string[];
    cwd: string;
    env: Record<string, string>;
    restartPolicy: V07NonfightLaneRestartPolicy;
    maxRestarts: number;
    restartBackoffMs: number;
}

export interface IV07NonfightCampaignConfig {
    schemaVersion: 1;
    outputDirectory: string;
    repositoryRoot: string;
    hours: number;
    durationMs: number;
    totalWorkers: number;
    heartbeatMs: number;
    stopGraceMs: number;
    laneStopGraceMs: number;
    lanes: [IV07NonfightCampaignLaneConfig, IV07NonfightCampaignLaneConfig];
    configSha256: string;
}

export interface IV07NonfightCampaignTiming {
    startAtMs: number;
    laneDeadlineAtMs: number;
    hardDeadlineAtMs: number;
    laneStopGraceMs: number;
    durationMs: number;
}

export interface IV07NonfightCampaignProvenanceInput {
    commit: string;
    tree: string;
    branch: string;
    originMain: string;
    originUrl: string;
    statusPorcelain: string;
    capturedAtMs: number;
    platform: NodeJS.Platform;
    arch: string;
    hostname: string;
    logicalCpuCount: number;
    bunVersion: string;
    bunRevision: string;
}

export interface IV07NonfightCampaignProvenance {
    schemaVersion: 1;
    commit: string;
    tree: string;
    branch: string;
    originMain: string;
    originUrl: string;
    cleanIncludingUntracked: boolean;
    statusPorcelainSha256: string;
    capturedAtMs: number;
    platform: NodeJS.Platform;
    arch: string;
    hostname: string;
    logicalCpuCount: number;
    bunVersion: string;
    bunRevision: string;
    provenanceSha256: string;
}

export interface IV07NonfightCampaignRenderContext {
    runId: string;
    repositoryRoot: string;
    campaignOutputDir: string;
    laneOutputDir: string;
    workers: number;
    laneDeadlineAtMs: number;
    hardDeadlineAtMs: number;
}

export interface IV07NonfightCampaignRenderedLane extends IV07NonfightCampaignLaneConfig {
    outputDirectory: string;
    command: string[];
    env: Record<string, string>;
}

interface IV07NonfightCampaignResolutionOptions {
    configDirectory: string;
    repositoryRoot: string;
    outputDirectoryOverride?: string;
    hoursOverride?: number;
}

const ROOT_KEYS = new Set([
    "schemaVersion",
    "outputDirectory",
    "hours",
    "totalWorkers",
    "heartbeatSeconds",
    "stopGraceSeconds",
    "laneStopGraceMs",
    "lanes",
]);
const LANE_KEYS = new Set([
    "name",
    "workers",
    "command",
    "cwd",
    "env",
    "restartPolicy",
    "maxRestarts",
    "restartBackoffSeconds",
]);
const LANE_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const GIT_OBJECT_PATTERN = /^[0-9a-f]{40,64}$/;
const UNRESOLVED_PLACEHOLDER_PATTERN = /\{[A-Za-z][A-Za-z0-9]*\}/;
const EXPERIMENT_ENVIRONMENT_PATTERN = /^(?:V\d+_|SEARCH_|Q\d+_|CEM_|FIGHT_|ROSTER_|AUGCA_)/;
const EXPLICIT_EXPERIMENT_ENVIRONMENT_KEYS = new Set(["FORCE_CREATURES", "LIVETWIN", "SIM_NO_ACTIONS", "VALUE_DATA"]);
const RUNTIME_INJECTION_ENVIRONMENT_KEYS = new Set([
    "BUN_CONFIG",
    "BUN_OPTIONS",
    "BUN_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "LD_PRELOAD",
    "NODE_OPTIONS",
    "NODE_PATH",
    "TS_NODE_PROJECT",
    "TS_NODE_TRANSPILE_ONLY",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>, label: string): void {
    const unexpected = Object.keys(value).filter((key) => !expected.has(key));
    if (unexpected.length) throw new Error(`${label} has unexpected key(s): ${unexpected.sort().join(", ")}`);
}

function requireFiniteNumber(value: unknown, label: string, minimumExclusive = 0): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= minimumExclusive) {
        throw new Error(`${label} must be a finite number greater than ${minimumExclusive}`);
    }
    return value;
}

function requireInteger(value: unknown, label: string, minimum: number, maximum: number): number {
    if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
        throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
    }
    return value as number;
}

function requireString(value: unknown, label: string): string {
    if (typeof value !== "string" || !value.length || value.includes("\0")) {
        throw new Error(`${label} must be a non-empty string without NUL bytes`);
    }
    return value;
}

function canonicalValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalValue);
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, entry]) => [key, canonicalValue(entry)]),
        );
    }
    return value;
}

export function canonicalV07NonfightCampaignJson(value: unknown): string {
    return JSON.stringify(canonicalValue(value));
}

export function fingerprintV07NonfightCampaign(value: unknown): string {
    return createHash("sha256").update(canonicalV07NonfightCampaignJson(value)).digest("hex");
}

/** Remove ambient runtime/experiment controls, then apply only recorded lane overrides. */
export function sanitizeV07NonfightCampaignEnvironment(
    inherited: Readonly<Record<string, string | undefined>>,
    explicit: Readonly<Record<string, string>>,
): Record<string, string> {
    const clean = Object.fromEntries(
        Object.entries(inherited).filter(
            ([key, value]) =>
                value !== undefined &&
                !RUNTIME_INJECTION_ENVIRONMENT_KEYS.has(key) &&
                !EXPERIMENT_ENVIRONMENT_PATTERN.test(key) &&
                !EXPLICIT_EXPERIMENT_ENVIRONMENT_KEYS.has(key),
        ),
    ) as Record<string, string>;
    return Object.fromEntries(
        Object.entries({ ...clean, ...explicit }).sort(([left], [right]) => left.localeCompare(right)),
    );
}

function normalizedEnvironment(value: unknown, label: string): Record<string, string> {
    if (value === undefined) return {};
    if (!isRecord(value)) throw new Error(`${label} must be an object of string values`);
    const entries = Object.entries(value).map(([key, entry]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof entry !== "string" || entry.includes("\0")) {
            throw new Error(`${label}.${key} must be a valid environment key with a string value`);
        }
        return [key, entry] as const;
    });
    return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function normalizedLane(raw: unknown, index: number, repositoryRoot: string): IV07NonfightCampaignLaneConfig {
    const label = `non-fight campaign lane ${index}`;
    if (!isRecord(raw)) throw new Error(`${label} must be an object`);
    assertExactKeys(raw, LANE_KEYS, label);
    const name = requireString(raw.name, `${label}.name`);
    if (!LANE_NAME_PATTERN.test(name)) {
        throw new Error(`${label}.name must match ${String(LANE_NAME_PATTERN)}`);
    }
    const workers = requireInteger(raw.workers, `${label}.workers`, 1, 512);
    if (!Array.isArray(raw.command) || !raw.command.length) {
        throw new Error(`${label}.command must be a non-empty argv array`);
    }
    const command = raw.command.map((entry, commandIndex) => requireString(entry, `${label}.command[${commandIndex}]`));
    const cwdRaw = raw.cwd === undefined ? repositoryRoot : requireString(raw.cwd, `${label}.cwd`);
    const cwd = resolve(repositoryRoot, cwdRaw);
    if (cwd !== repositoryRoot && !cwd.startsWith(`${repositoryRoot}/`)) {
        throw new Error(`${label}.cwd must remain inside the immutable repository root`);
    }
    const restartPolicy = raw.restartPolicy ?? "on-failure";
    if (restartPolicy !== "never" && restartPolicy !== "on-failure") {
        throw new Error(`${label}.restartPolicy must be never or on-failure`);
    }
    const maxRestarts = requireInteger(raw.maxRestarts ?? 4, `${label}.maxRestarts`, 0, 100);
    const restartBackoffSeconds = requireFiniteNumber(
        raw.restartBackoffSeconds ?? 15,
        `${label}.restartBackoffSeconds`,
    );
    const restartBackoffMs = restartBackoffSeconds * 1000;
    if (!Number.isSafeInteger(restartBackoffMs)) {
        throw new Error(`${label}.restartBackoffSeconds must resolve to integer milliseconds`);
    }
    return {
        name,
        workers,
        command,
        cwd,
        env: normalizedEnvironment(raw.env, `${label}.env`),
        restartPolicy,
        maxRestarts,
        restartBackoffMs,
    };
}

/** Validate and normalize the strict, shell-free two-lane campaign configuration. */
export function resolveV07NonfightCampaignConfig(
    raw: unknown,
    options: IV07NonfightCampaignResolutionOptions,
): IV07NonfightCampaignConfig {
    if (!isRecord(raw)) throw new Error("Non-fight campaign config must be an object");
    assertExactKeys(raw, ROOT_KEYS, "Non-fight campaign config");
    if (raw.schemaVersion !== V07_NONFIGHT_CAMPAIGN_SCHEMA_VERSION) {
        throw new Error(`Non-fight campaign config schemaVersion must be ${V07_NONFIGHT_CAMPAIGN_SCHEMA_VERSION}`);
    }
    const outputRaw = options.outputDirectoryOverride ?? requireString(raw.outputDirectory, "outputDirectory");
    const outputDirectory = resolve(options.configDirectory, outputRaw);
    const repositoryRoot = resolve(options.repositoryRoot);
    if (
        outputDirectory === repositoryRoot ||
        repositoryRoot.startsWith(`${outputDirectory}/`) ||
        outputDirectory.startsWith(`${repositoryRoot}/`)
    ) {
        throw new Error("Campaign output directory must be outside the repository tree and its parents");
    }
    const hours = requireFiniteNumber(options.hoursOverride ?? raw.hours, "hours");
    if (hours > 24 * 7) throw new Error("hours may not exceed 168");
    const durationMs = hours * V07_NONFIGHT_CAMPAIGN_HOUR_MS;
    if (!Number.isSafeInteger(durationMs)) throw new Error("hours must resolve to integer milliseconds");
    const totalWorkers = requireInteger(raw.totalWorkers, "totalWorkers", 2, 512);
    const heartbeatSeconds = requireFiniteNumber(raw.heartbeatSeconds ?? 30, "heartbeatSeconds");
    const heartbeatMs = heartbeatSeconds * 1000;
    if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 100 || heartbeatMs > 5 * 60 * 1000) {
        throw new Error("heartbeatSeconds must resolve to 100..300000 integer milliseconds");
    }
    const stopGraceSeconds = requireFiniteNumber(raw.stopGraceSeconds ?? 30, "stopGraceSeconds");
    const stopGraceMs = stopGraceSeconds * 1000;
    if (!Number.isSafeInteger(stopGraceMs) || stopGraceMs < 100 || stopGraceMs > 10 * 60 * 1000) {
        throw new Error("stopGraceSeconds must resolve to 100..600000 integer milliseconds");
    }
    const laneStopGraceMs = requireInteger(
        raw.laneStopGraceMs ?? V07_NONFIGHT_CAMPAIGN_DEFAULT_LANE_STOP_GRACE_MS,
        "laneStopGraceMs",
        100,
        durationMs - 1,
    );
    if (!Array.isArray(raw.lanes) || raw.lanes.length !== 2) {
        throw new Error("Non-fight campaign config must define exactly two lanes");
    }
    const lanes = raw.lanes.map((lane, index) => normalizedLane(lane, index, repositoryRoot)) as [
        IV07NonfightCampaignLaneConfig,
        IV07NonfightCampaignLaneConfig,
    ];
    if (lanes[0].name === lanes[1].name) throw new Error("Non-fight campaign lane names must be unique");
    const allocatedWorkers = lanes.reduce((sum, lane) => sum + lane.workers, 0);
    if (allocatedWorkers !== totalWorkers) {
        throw new Error(`Lane worker allocation ${allocatedWorkers} does not equal totalWorkers ${totalWorkers}`);
    }
    const unsigned = {
        schemaVersion: V07_NONFIGHT_CAMPAIGN_SCHEMA_VERSION,
        outputDirectory,
        repositoryRoot,
        hours,
        durationMs,
        totalWorkers,
        heartbeatMs,
        stopGraceMs,
        laneStopGraceMs,
        lanes,
    };
    return { ...unsigned, configSha256: fingerprintV07NonfightCampaign(unsigned) };
}

/** Freeze the hard wall-clock deadline and the earlier per-lane finalization deadline. */
export function deriveV07NonfightCampaignTiming(
    startAtMs: number,
    durationMs: number,
    laneStopGraceMs: number,
): IV07NonfightCampaignTiming {
    requireInteger(startAtMs, "startAtMs", 0, Number.MAX_SAFE_INTEGER);
    requireInteger(durationMs, "durationMs", 1, Number.MAX_SAFE_INTEGER);
    requireInteger(laneStopGraceMs, "laneStopGraceMs", 1, durationMs - 1);
    const hardDeadlineAtMs = startAtMs + durationMs;
    if (!Number.isSafeInteger(hardDeadlineAtMs)) throw new Error("Campaign hard deadline exceeds safe integer range");
    return {
        startAtMs,
        laneDeadlineAtMs: hardDeadlineAtMs - laneStopGraceMs,
        hardDeadlineAtMs,
        laneStopGraceMs,
        durationMs,
    };
}

/** Build self-hashed source/host provenance from captured git and runtime facts. */
export function buildV07NonfightCampaignProvenance(
    input: IV07NonfightCampaignProvenanceInput,
): IV07NonfightCampaignProvenance {
    for (const [label, value] of [
        ["commit", input.commit],
        ["tree", input.tree],
        ["originMain", input.originMain],
    ] as const) {
        if (!GIT_OBJECT_PATTERN.test(value)) throw new Error(`${label} must be a lowercase git object id`);
    }
    requireString(input.branch, "branch");
    requireString(input.originUrl, "originUrl");
    requireString(input.platform, "platform");
    requireString(input.arch, "arch");
    requireString(input.hostname, "hostname");
    requireInteger(input.logicalCpuCount, "logicalCpuCount", 1, 8192);
    requireInteger(input.capturedAtMs, "capturedAtMs", 0, Number.MAX_SAFE_INTEGER);
    requireString(input.bunVersion, "bunVersion");
    requireString(input.bunRevision, "bunRevision");
    const unsigned = {
        schemaVersion: V07_NONFIGHT_CAMPAIGN_SCHEMA_VERSION,
        commit: input.commit,
        tree: input.tree,
        branch: input.branch,
        originMain: input.originMain,
        originUrl: input.originUrl,
        cleanIncludingUntracked: input.statusPorcelain.length === 0,
        statusPorcelainSha256: fingerprintV07NonfightCampaign(input.statusPorcelain),
        capturedAtMs: input.capturedAtMs,
        platform: input.platform,
        arch: input.arch,
        hostname: input.hostname,
        logicalCpuCount: input.logicalCpuCount,
        bunVersion: input.bunVersion,
        bunRevision: input.bunRevision,
    };
    return { ...unsigned, provenanceSha256: fingerprintV07NonfightCampaign(unsigned) };
}

/** Refuse launches that are not a clean, pushed main checkout. */
export function assertV07NonfightCampaignLaunchable(provenance: IV07NonfightCampaignProvenance): void {
    if (provenance.branch !== "main") throw new Error(`Campaign must launch from main, found ${provenance.branch}`);
    if (provenance.commit !== provenance.originMain) {
        throw new Error(`Campaign HEAD ${provenance.commit} does not match origin/main ${provenance.originMain}`);
    }
    if (!provenance.cleanIncludingUntracked) {
        throw new Error("Campaign repository must be clean including untracked files");
    }
}

function renderTemplate(value: string, context: IV07NonfightCampaignRenderContext): string {
    const replacements: Record<string, string> = {
        "{runId}": context.runId,
        "{repositoryRoot}": context.repositoryRoot,
        "{campaignOutputDir}": context.campaignOutputDir,
        "{laneOutputDir}": context.laneOutputDir,
        "{workers}": String(context.workers),
        // Keep deadlineAtMs as the optimizer-facing deadline for existing lane CLIs.
        "{deadlineAtMs}": String(context.laneDeadlineAtMs),
        "{laneDeadlineAtMs}": String(context.laneDeadlineAtMs),
        "{hardDeadlineAtMs}": String(context.hardDeadlineAtMs),
        "{deadlineEpoch}": String(Math.floor(context.laneDeadlineAtMs / 1000)),
        "{hardDeadlineEpoch}": String(Math.floor(context.hardDeadlineAtMs / 1000)),
    };
    let rendered = value;
    for (const [placeholder, replacement] of Object.entries(replacements)) {
        rendered = rendered.split(placeholder).join(replacement);
    }
    const unresolved = rendered.match(UNRESOLVED_PLACEHOLDER_PATTERN)?.[0];
    if (unresolved) throw new Error(`Unknown campaign command placeholder ${unresolved}`);
    return rendered;
}

/** Render a lane without invoking a shell; argv boundaries remain intact. */
export function renderV07NonfightCampaignLane(
    lane: IV07NonfightCampaignLaneConfig,
    context: IV07NonfightCampaignRenderContext,
): IV07NonfightCampaignRenderedLane {
    if (context.workers !== lane.workers) throw new Error(`Render worker mismatch for lane ${lane.name}`);
    const command = lane.command.map((entry) => renderTemplate(entry, context));
    const env = Object.fromEntries(
        Object.entries(lane.env).map(([key, value]) => [key, renderTemplate(value, context)]),
    );
    return { ...lane, outputDirectory: context.laneOutputDir, command, env };
}
