#!/usr/bin/env bun

/**
 * Current-tree fixed-work CPU profiler for A13 Workstream 5 (melee target-layer construction).
 *
 * This runner is intentionally independent from the sealed Workstream 1 and Workstream 4 evidence
 * tools. A normal run launches three fresh Bun processes. Every process:
 *
 *  - starts from the exact scrubbed environment below;
 *  - warms v0.8 mirror self-play once, outside the profiler;
 *  - records nine identical repeats of the six-seed corpus in a Chrome CPU profile;
 *  - rejects engine-declined actions, stuck matches, semantic drift, or source/HEAD drift.
 *
 * The parent parses sample stacks from each .cpuprofile. Inclusive attribution requires both the
 * exact function name and a source URL ending in /src/ai/ai.ts, so identically named helpers in
 * dependencies cannot contaminate the result.
 *
 * Evidence run:
 *   bun docs/evidence/tools/a13_melee_target_profile.ts \
 *     --out=/tmp/a13-melee-target-profile.json
 *
 * Structural smoke (one capture and one repeat; never marked qualified):
 *   bun docs/evidence/tools/a13_melee_target_profile.ts \
 *     --smoke --out=/tmp/a13-melee-target-profile-smoke.json
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
    constants as fsConstants,
    copyFileSync,
    existsSync,
    linkSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    readlinkSync,
    realpathSync,
    rmSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { Session } from "node:inspector";
import { arch, cpus, platform, release, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const SCHEMA = "heroes-of-crypto/a13-melee-target-profile/v1" as const;
const CAPTURE_SCHEMA = "heroes-of-crypto/a13-melee-target-capture/v1" as const;
const RUNNER_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(RUNNER_PATH), "../../..");
const WORKSPACE_ROOT = resolve(ROOT, "../..");
const SOURCE_ROOT = join(ROOT, "src");
const WORKSPACE_LOCK_PATH = join(WORKSPACE_ROOT, "bun.lock");
const AI_SOURCE_SUFFIX = "/src/ai/ai.ts";
const PROFILE_INTERVAL_US = 500;
const EVIDENCE_CAPTURES = 3;
const EVIDENCE_REPEATS = 9;
const SMOKE_CAPTURES = 1;
const SMOKE_REPEATS = 1;
const WARMUP_SEED = 9001;
const WARMUP_MAX_LAPS = 2;
const PROFILE_SEEDS = [1, 42, 43, 44, 45, 46] as const;
const PROFILE_MAX_LAPS = 4;
const AI_VERSION = "v0.8";
const PRIMARY_TARGET = "getLayersForAttacker_2" as const;
const MINIMUM_PRIMARY_SHARE = 0.03;
const TARGET_FUNCTIONS = [
    "doFindTarget",
    "getLayersForAttacker_2",
    "getBorderCells_2",
    "filterCells",
    "isFree",
] as const;
const ENVIRONMENT_PREFIXES = ["SEARCH_", "V05_", "V06_", "V07_", "V08_", "Q2_", "SIM_"] as const;
const FIXED_ENVIRONMENT = Object.freeze({
    V08_A13_SEARCH: "1",
    LIVETWIN: "1",
    FIGHT_MELEE_ROSTERS: "0",
});
const SELECTED_SOURCE_PATHS = [
    "src/ai/ai.ts",
    "src/ai/ai_strategy.ts",
    "src/ai/candidates.ts",
    "src/ai/decision_path_catalog.ts",
    "src/simulation/army.ts",
    "src/simulation/battle_engine.ts",
    "src/simulation/search_driver.ts",
    "src/simulation/v0_8_a13_search.ts",
    "package.json",
] as const;

type TargetFunction = (typeof TARGET_FUNCTIONS)[number];
type RunMode = "evidence" | "smoke";

interface ISourceEntry {
    path: string;
    kind: "file" | "symlink";
    bytes: number;
    sha256: string;
}

interface ISourceSeal {
    root: string;
    realRoot: string;
    workspaceRoot: string;
    realWorkspaceRoot: string;
    gitHead: string;
    gitTree: string;
    srcEntryCount: number;
    srcBytes: number;
    srcManifestSha256: string;
    selectedSha256: Record<string, string | null>;
    workspaceLock: {
        path: string;
        bytes: number;
        sha256: string;
    };
    dependencySeal: {
        sealed: false;
        commonNodeModulesRealPath: string;
        workspaceNodeModulesRealPath: string;
        limitation: string;
    };
    runnerSha256: string;
    identitySha256: string;
}

interface IRepeatResult {
    repeat: number;
    matches: number;
    actions: number;
    actionDigest: string;
    resultDigest: string;
}

interface ICaptureMetadata {
    schema: typeof CAPTURE_SCHEMA;
    capture: number;
    intervalMicroseconds: number;
    environment: Record<string, string>;
    sourceBefore: ISourceSeal;
    sourceAfter: ISourceSeal;
    sourceUnchanged: true;
    warmup: {
        seed: number;
        maxLaps: number;
        actions: number;
        actionDigest: string;
        resultDigest: string;
    };
    workload: {
        aiVersion: typeof AI_VERSION;
        seeds: readonly number[];
        maxLaps: number;
        repeats: number;
        matches: number;
        actions: number;
        wallMilliseconds: number;
        actionDigest: string;
        resultDigest: string;
        repeatResults: IRepeatResult[];
        semanticRepeatEquality: true;
        rejected: 0;
        stuck: 0;
    };
    profile: {
        path: string;
        bytes: number;
        sha256: string;
        nodes: number;
        samples: number;
        startTime: number;
        endTime: number;
    };
}

interface ICallFrame {
    functionName?: string;
    scriptId?: string;
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
}

interface IProfileNode {
    id: number;
    callFrame?: ICallFrame;
    hitCount?: number;
    children?: number[];
    parent?: number;
}

interface IChromeCpuProfile {
    nodes: IProfileNode[];
    startTime: number;
    endTime: number;
    samples: number[];
    timeDeltas: number[];
}

interface IParentStackRow {
    stack: string;
    sampledMicroseconds: number;
    shareOfCapture: number;
}

interface IFunctionAttribution {
    functionName: TargetFunction;
    sourceSuffix: typeof AI_SOURCE_SUFFIX;
    matchedNodeIds: number[];
    matchedNodeCount: number;
    inclusiveSampledMicroseconds: number;
    inclusiveShare: number;
    exclusiveSampledMicroseconds: number;
    exclusiveShare: number;
    topParentStacks: IParentStackRow[];
}

interface IProfileAttribution {
    intervalMicroseconds: number;
    nodeCount: number;
    sampleCount: number;
    totalSampledMicroseconds: number;
    profileDurationMicroseconds: number;
    functions: Record<TargetFunction, IFunctionAttribution>;
    primaryTarget: typeof PRIMARY_TARGET;
    primaryInclusiveShare: number;
    primaryThreshold: number;
    primaryThresholdPassed: boolean;
}

interface ICaptureReport {
    capture: number;
    workloadArtifact: string;
    profileArtifact: string;
    workloadArtifactSha256: string;
    profileArtifactSha256: string;
    sourceIdentitySha256: string;
    matches: number;
    actions: number;
    wallMilliseconds: number;
    actionDigest: string;
    resultDigest: string;
    attribution: IProfileAttribution;
}

interface IInspectorResult {
    profile?: IChromeCpuProfile;
}

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

function canonicalize(value: unknown): unknown {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
        if (Number.isNaN(value)) return "__NaN__";
        if (value === Number.POSITIVE_INFINITY) return "__Infinity__";
        if (value === Number.NEGATIVE_INFINITY) return "__-Infinity__";
        if (Object.is(value, -0)) return 0;
        return value;
    }
    if (typeof value === "bigint") return `${value}n`;
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value instanceof Map) {
        return [...value.entries()]
            .map(([key, item]) => [canonicalize(key), canonicalize(item)])
            .sort((left, right) => JSON.stringify(left[0]).localeCompare(JSON.stringify(right[0])));
    }
    if (value instanceof Set) {
        return [...value.values()]
            .map(canonicalize)
            .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    }
    if (typeof value === "object") {
        const output: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) {
            const item = (value as Record<string, unknown>)[key];
            if (item !== undefined) output[key] = canonicalize(item);
        }
        return output;
    }
    return String(value);
}

const canonicalJson = (value: unknown): string => JSON.stringify(canonicalize(value));
const digest = (value: unknown): string => sha256(canonicalJson(value));

function normalizedPath(path: string): string {
    return path.split(sep).join("/");
}

function readSha256(path: string): string | null {
    return existsSync(path) && statSync(path).isFile() ? sha256(readFileSync(path)) : null;
}

function collectSourceEntries(directory: string, root: string, entries: ISourceEntry[]): void {
    for (const item of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
        left.name.localeCompare(right.name),
    )) {
        const path = join(directory, item.name);
        const relativePath = normalizedPath(relative(root, path));
        const stats = lstatSync(path);
        if (stats.isDirectory()) {
            collectSourceEntries(path, root, entries);
        } else if (stats.isSymbolicLink()) {
            const target = readlinkSync(path);
            entries.push({
                path: relativePath,
                kind: "symlink",
                bytes: Buffer.byteLength(target),
                sha256: sha256(target),
            });
        } else if (stats.isFile()) {
            entries.push({
                path: relativePath,
                kind: "file",
                bytes: stats.size,
                sha256: sha256(readFileSync(path)),
            });
        }
    }
}

function gitValue(...args: string[]): string {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function sourceSeal(): ISourceSeal {
    const entries: ISourceEntry[] = [];
    collectSourceEntries(SOURCE_ROOT, ROOT, entries);
    entries.sort((left, right) => left.path.localeCompare(right.path));
    const selectedSha256: Record<string, string | null> = {};
    for (const path of SELECTED_SOURCE_PATHS) selectedSha256[path] = readSha256(join(ROOT, path));
    if (!existsSync(WORKSPACE_LOCK_PATH) || !statSync(WORKSPACE_LOCK_PATH).isFile()) {
        throw new Error(`Workspace lockfile is missing: ${WORKSPACE_LOCK_PATH}`);
    }
    const workspaceLockStats = statSync(WORKSPACE_LOCK_PATH);
    const sealWithoutIdentity = {
        root: ROOT,
        realRoot: realpathSync(ROOT),
        workspaceRoot: WORKSPACE_ROOT,
        realWorkspaceRoot: realpathSync(WORKSPACE_ROOT),
        gitHead: gitValue("rev-parse", "HEAD"),
        gitTree: gitValue("rev-parse", "HEAD^{tree}"),
        srcEntryCount: entries.length,
        srcBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
        srcManifestSha256: digest(entries),
        selectedSha256,
        workspaceLock: {
            path: normalizedPath(relative(ROOT, WORKSPACE_LOCK_PATH)),
            bytes: workspaceLockStats.size,
            sha256: sha256(readFileSync(WORKSPACE_LOCK_PATH)),
        },
        dependencySeal: {
            sealed: false as const,
            commonNodeModulesRealPath: realpathSync(join(ROOT, "node_modules")),
            workspaceNodeModulesRealPath: realpathSync(join(WORKSPACE_ROOT, "node_modules")),
            limitation:
                "The workspace bun.lock bytes and both node_modules realpaths are sealed, but installed " +
                "dependency contents are not recursively hashed.",
        },
        runnerSha256: sha256(readFileSync(RUNNER_PATH)),
    };
    return {
        ...sealWithoutIdentity,
        identitySha256: digest(sealWithoutIdentity),
    };
}

function assertSameSource(expected: ISourceSeal, actual: ISourceSeal, phase: string): void {
    if (expected.identitySha256 !== actual.identitySha256) {
        throw new Error(
            `Source/HEAD drift during ${phase}: expected ${expected.identitySha256}, got ${actual.identitySha256}`,
        );
    }
}

function shouldScrubEnvironmentKey(key: string): boolean {
    return ENVIRONMENT_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function fixedChildEnvironment(): Record<string, string> {
    const environment: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !shouldScrubEnvironmentKey(key)) environment[key] = value;
    }
    Object.assign(environment, FIXED_ENVIRONMENT);
    return environment;
}

function installFixedEnvironment(): Record<string, string> {
    for (const key of Object.keys(process.env)) {
        if (shouldScrubEnvironmentKey(key)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(FIXED_ENVIRONMENT)) process.env[key] = value;
    const behaviorEnvironment: Record<string, string> = {};
    for (const key of Object.keys(process.env).sort()) {
        if (shouldScrubEnvironmentKey(key) || key === "LIVETWIN" || key === "FIGHT_MELEE_ROSTERS") {
            const value = process.env[key];
            if (value !== undefined) behaviorEnvironment[key] = value;
        }
    }
    if (canonicalJson(behaviorEnvironment) !== canonicalJson(FIXED_ENVIRONMENT)) {
        throw new Error(`Fixed environment installation failed: ${canonicalJson(behaviorEnvironment)}`);
    }
    return behaviorEnvironment;
}

function writeJsonExclusive(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

function writeJsonAtomicExclusive(path: string, value: unknown): void {
    const resolved = resolve(path);
    mkdirSync(dirname(resolved), { recursive: true });
    if (existsSync(resolved)) throw new Error(`Refusing to overwrite report: ${resolved}`);
    const temporary = join(dirname(resolved), `.${basename(resolved)}.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    try {
        linkSync(temporary, resolved);
    } finally {
        unlinkSync(temporary);
    }
}

function positiveInteger(value: string | undefined, name: string): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
    return parsed;
}

function assertHealthyResult(result: Record<string, unknown>, phase: string): void {
    const rejectedGreen = Number(result.rejectedGreen ?? 0);
    const rejectedRed = Number(result.rejectedRed ?? 0);
    if (
        !Number.isSafeInteger(rejectedGreen) ||
        rejectedGreen < 0 ||
        !Number.isSafeInteger(rejectedRed) ||
        rejectedRed < 0
    ) {
        throw new Error(`Invalid rejected-action counters in ${phase}`);
    }
    if (rejectedGreen + rejectedRed !== 0) {
        throw new Error(`Rejected action in ${phase}: green=${rejectedGreen}, red=${rejectedRed}`);
    }
    const endReason = String(result.endReason ?? "");
    if (endReason === "stuck") throw new Error(`Stuck match in ${phase}`);
    if (endReason !== "elimination" && endReason !== "turn_cap") {
        throw new Error(`Invalid end reason in ${phase}: ${endReason}`);
    }
    if (!Array.isArray(result.actions)) throw new Error(`Missing action record in ${phase}`);
    const totalActions = Number(result.totalActions);
    if (!Number.isSafeInteger(totalActions) || totalActions < 0 || totalActions !== result.actions.length) {
        throw new Error(`Invalid action total in ${phase}: ${totalActions}`);
    }
}

function postInspector(
    session: Session,
    method: string,
    parameters?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
    return new Promise((resolvePromise, rejectPromise) => {
        const callback = (error: Error | null, result?: Record<string, unknown>): void => {
            if (error) rejectPromise(error);
            else resolvePromise(result ?? {});
        };
        const post = session.post as unknown as (
            name: string,
            params: Record<string, unknown>,
            done: (error: Error | null, result?: Record<string, unknown>) => void,
        ) => void;
        post.call(session, method, parameters ?? {}, callback);
    });
}

async function recordCpuProfile(run: () => void): Promise<IChromeCpuProfile> {
    const session = new Session();
    session.connect();
    let started = false;
    try {
        await postInspector(session, "Profiler.enable");
        await postInspector(session, "Profiler.setSamplingInterval", { interval: PROFILE_INTERVAL_US });
        await postInspector(session, "Profiler.start");
        started = true;
        run();
        const stopped = (await postInspector(session, "Profiler.stop")) as IInspectorResult;
        started = false;
        if (!stopped.profile) throw new Error("Inspector did not return a CPU profile");
        return stopped.profile;
    } finally {
        if (started) {
            try {
                await postInspector(session, "Profiler.stop");
            } catch {
                // Preserve the original workload error.
            }
        }
        try {
            await postInspector(session, "Profiler.disable");
        } finally {
            session.disconnect();
        }
    }
}

async function captureMain(args: string[]): Promise<void> {
    const { values } = parseArgs({
        args,
        strict: true,
        allowPositionals: false,
        options: {
            capture: { type: "string" },
            repeats: { type: "string" },
            profile: { type: "string" },
            metadata: { type: "string" },
        },
    });
    if (!values.capture || !values.repeats || !values.profile || !values.metadata) {
        throw new Error("Internal capture requires --capture, --repeats, --profile, and --metadata");
    }
    const capture = positiveInteger(values.capture, "--capture");
    const repeats = positiveInteger(values.repeats, "--repeats");
    const profilePath = resolve(values.profile);
    const metadataPath = resolve(values.metadata);
    if (existsSync(profilePath) || existsSync(metadataPath)) {
        throw new Error(`Refusing to overwrite capture ${capture} output`);
    }

    const environment = installFixedEnvironment();
    const sourceBefore = sourceSeal();
    const army = await import("../../../src/simulation/army");
    const battle = await import("../../../src/simulation/battle_engine");
    const runSeed = (seed: number, maxLaps: number): Record<string, unknown> => {
        const result = battle.runMatch({
            greenVersion: AI_VERSION,
            redVersion: AI_VERSION,
            roster: army.buildRoster(army.makeRng(seed)),
            seed,
            maxLaps,
        }) as unknown as Record<string, unknown>;
        assertHealthyResult(result, `capture=${capture} seed=${seed} maxLaps=${maxLaps}`);
        return result;
    };

    const warmup = runSeed(WARMUP_SEED, WARMUP_MAX_LAPS);
    const repeatResults: IRepeatResult[] = [];
    let measuredResults: Record<string, unknown>[] = [];
    const workloadStarted = performance.now();
    const profile = await recordCpuProfile(() => {
        for (let repeat = 0; repeat < repeats; repeat += 1) {
            const results = PROFILE_SEEDS.map((seed) => runSeed(seed, PROFILE_MAX_LAPS));
            const row: IRepeatResult = {
                repeat,
                matches: results.length,
                actions: results.reduce((sum, result) => sum + Number(result.totalActions), 0),
                actionDigest: digest(results.map((result) => result.actions)),
                resultDigest: digest(results),
            };
            if (
                repeatResults.length > 0 &&
                (row.actionDigest !== repeatResults[0].actionDigest ||
                    row.resultDigest !== repeatResults[0].resultDigest)
            ) {
                throw new Error(
                    `Semantic drift inside capture ${capture}, repeat ${repeat}: ` +
                        `actions=${row.actionDigest}, result=${row.resultDigest}`,
                );
            }
            repeatResults.push(row);
            measuredResults = measuredResults.concat(results);
        }
    });
    const wallMilliseconds = performance.now() - workloadStarted;
    if (repeatResults.length !== repeats || measuredResults.length !== repeats * PROFILE_SEEDS.length) {
        throw new Error(`Incomplete workload in capture ${capture}`);
    }

    writeJsonExclusive(profilePath, profile);
    const sourceAfter = sourceSeal();
    assertSameSource(sourceBefore, sourceAfter, `capture ${capture}`);
    const profileStats = statSync(profilePath);
    const metadata: ICaptureMetadata = {
        schema: CAPTURE_SCHEMA,
        capture,
        intervalMicroseconds: PROFILE_INTERVAL_US,
        environment,
        sourceBefore,
        sourceAfter,
        sourceUnchanged: true,
        warmup: {
            seed: WARMUP_SEED,
            maxLaps: WARMUP_MAX_LAPS,
            actions: Number(warmup.totalActions),
            actionDigest: digest(warmup.actions),
            resultDigest: digest(warmup),
        },
        workload: {
            aiVersion: AI_VERSION,
            seeds: PROFILE_SEEDS,
            maxLaps: PROFILE_MAX_LAPS,
            repeats,
            matches: measuredResults.length,
            actions: measuredResults.reduce((sum, result) => sum + Number(result.totalActions), 0),
            wallMilliseconds,
            actionDigest: repeatResults[0].actionDigest,
            resultDigest: repeatResults[0].resultDigest,
            repeatResults,
            semanticRepeatEquality: true,
            rejected: 0,
            stuck: 0,
        },
        profile: {
            path: basename(profilePath),
            bytes: profileStats.size,
            sha256: sha256(readFileSync(profilePath)),
            nodes: profile.nodes.length,
            samples: profile.samples.length,
            startTime: profile.startTime,
            endTime: profile.endTime,
        },
    };
    writeJsonExclusive(metadataPath, metadata);
    console.log(
        `capture=${capture} matches=${metadata.workload.matches} actions=${metadata.workload.actions} ` +
            `samples=${metadata.profile.samples} wallMs=${wallMilliseconds.toFixed(2)}`,
    );
}

function normalizedSourceUrl(url: string | undefined): string {
    if (!url) return "";
    const withoutSuffix = url.split(/[?#]/, 1)[0];
    if (withoutSuffix.startsWith("file:")) {
        try {
            return normalizedPath(fileURLToPath(withoutSuffix));
        } catch {
            return normalizedPath(decodeURIComponent(withoutSuffix));
        }
    }
    return normalizedPath(decodeURIComponent(withoutSuffix));
}

function isExactTargetFrame(frame: ICallFrame | undefined, name: TargetFunction): boolean {
    return frame?.functionName === name && normalizedSourceUrl(frame.url).endsWith(AI_SOURCE_SUFFIX);
}

function relativeFrameUrl(url: string | undefined): string {
    const normalized = normalizedSourceUrl(url);
    const sourceIndex = normalized.lastIndexOf("/src/");
    return sourceIndex >= 0 ? normalized.slice(sourceIndex + 1) : normalized || "<native>";
}

function frameLabel(frame: ICallFrame | undefined): string {
    const functionName = frame?.functionName || "<anonymous>";
    const url = relativeFrameUrl(frame?.url);
    const line = typeof frame?.lineNumber === "number" ? frame.lineNumber + 1 : 0;
    return `${functionName}@${url}:${line}`;
}

function parseProfile(path: string): IProfileAttribution {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<IChromeCpuProfile>;
    if (
        !Array.isArray(parsed.nodes) ||
        !Array.isArray(parsed.samples) ||
        !Array.isArray(parsed.timeDeltas) ||
        typeof parsed.startTime !== "number" ||
        typeof parsed.endTime !== "number"
    ) {
        throw new Error(`Malformed Chrome CPU profile: ${path}`);
    }
    if (parsed.samples.length === 0 || parsed.samples.length !== parsed.timeDeltas.length) {
        throw new Error(
            `Invalid CPU sample/delta arrays in ${path}: samples=${parsed.samples.length}, deltas=${parsed.timeDeltas.length}`,
        );
    }
    const profile = parsed as IChromeCpuProfile;
    const nodes = new Map<number, IProfileNode>();
    const parents = new Map<number, number>();
    for (const node of profile.nodes) {
        if (!Number.isSafeInteger(node.id) || nodes.has(node.id)) {
            throw new Error(`Duplicate or invalid CPU profile node in ${path}: ${node.id}`);
        }
        nodes.set(node.id, node);
        if (Number.isSafeInteger(node.parent)) parents.set(node.id, node.parent as number);
    }
    for (const node of profile.nodes) {
        for (const child of node.children ?? []) {
            const previous = parents.get(child);
            if (previous !== undefined && previous !== node.id) {
                throw new Error(`CPU profile node ${child} has conflicting parents in ${path}`);
            }
            parents.set(child, node.id);
        }
    }

    const inclusive = Object.fromEntries(TARGET_FUNCTIONS.map((name) => [name, 0])) as Record<TargetFunction, number>;
    const exclusive = Object.fromEntries(TARGET_FUNCTIONS.map((name) => [name, 0])) as Record<TargetFunction, number>;
    const matchedNodeIds = Object.fromEntries(TARGET_FUNCTIONS.map((name) => [name, new Set<number>()])) as Record<
        TargetFunction,
        Set<number>
    >;
    const parentStacks = Object.fromEntries(
        TARGET_FUNCTIONS.map((name) => [name, new Map<string, number>()]),
    ) as Record<TargetFunction, Map<string, number>>;
    let totalSampledMicroseconds = 0;

    for (let sampleIndex = 0; sampleIndex < profile.samples.length; sampleIndex += 1) {
        const delta = profile.timeDeltas[sampleIndex];
        if (!Number.isFinite(delta) || delta < 0) {
            throw new Error(`Invalid CPU sample delta at index ${sampleIndex} in ${path}: ${delta}`);
        }
        totalSampledMicroseconds += delta;
        const leafId = profile.samples[sampleIndex];
        const stack: IProfileNode[] = [];
        const seenNodeIds = new Set<number>();
        let currentId: number | undefined = leafId;
        while (currentId !== undefined) {
            if (seenNodeIds.has(currentId)) throw new Error(`Cycle in CPU profile stack at node ${currentId}`);
            seenNodeIds.add(currentId);
            const node = nodes.get(currentId);
            if (!node) throw new Error(`CPU sample references missing node ${currentId} in ${path}`);
            stack.push(node);
            currentId = parents.get(currentId);
        }

        for (const name of TARGET_FUNCTIONS) {
            const matchingIndexes: number[] = [];
            for (let index = 0; index < stack.length; index += 1) {
                if (isExactTargetFrame(stack[index].callFrame, name)) matchingIndexes.push(index);
            }
            if (matchingIndexes.length === 0) continue;
            inclusive[name] += delta;
            for (const index of matchingIndexes) matchedNodeIds[name].add(stack[index].id);
            if (isExactTargetFrame(stack[0].callFrame, name)) exclusive[name] += delta;

            const outermostIndex = matchingIndexes[matchingIndexes.length - 1];
            const callerFrames = stack
                .slice(outermostIndex + 1)
                .map((node) => frameLabel(node.callFrame))
                .slice(0, 12);
            const callerStack = callerFrames.length > 0 ? callerFrames.join(" <- ") : "<root>";
            parentStacks[name].set(callerStack, (parentStacks[name].get(callerStack) ?? 0) + delta);
        }
    }
    if (totalSampledMicroseconds <= 0) throw new Error(`CPU profile has no sampled time: ${path}`);

    const functions = {} as Record<TargetFunction, IFunctionAttribution>;
    for (const name of TARGET_FUNCTIONS) {
        const sortedNodeIds = [...matchedNodeIds[name]].sort((left, right) => left - right);
        functions[name] = {
            functionName: name,
            sourceSuffix: AI_SOURCE_SUFFIX,
            matchedNodeIds: sortedNodeIds,
            matchedNodeCount: sortedNodeIds.length,
            inclusiveSampledMicroseconds: inclusive[name],
            inclusiveShare: inclusive[name] / totalSampledMicroseconds,
            exclusiveSampledMicroseconds: exclusive[name],
            exclusiveShare: exclusive[name] / totalSampledMicroseconds,
            topParentStacks: [...parentStacks[name].entries()]
                .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
                .slice(0, 12)
                .map(([stack, sampledMicroseconds]) => ({
                    stack,
                    sampledMicroseconds,
                    shareOfCapture: sampledMicroseconds / totalSampledMicroseconds,
                })),
        };
    }
    const primaryInclusiveShare = functions[PRIMARY_TARGET].inclusiveShare;
    return {
        intervalMicroseconds: PROFILE_INTERVAL_US,
        nodeCount: profile.nodes.length,
        sampleCount: profile.samples.length,
        totalSampledMicroseconds,
        profileDurationMicroseconds: profile.endTime - profile.startTime,
        functions,
        primaryTarget: PRIMARY_TARGET,
        primaryInclusiveShare,
        primaryThreshold: MINIMUM_PRIMARY_SHARE,
        primaryThresholdPassed: primaryInclusiveShare >= MINIMUM_PRIMARY_SHARE,
    };
}

function readCaptureMetadata(path: string): ICaptureMetadata {
    const metadata = JSON.parse(readFileSync(path, "utf8")) as ICaptureMetadata;
    if (
        metadata.schema !== CAPTURE_SCHEMA ||
        metadata.intervalMicroseconds !== PROFILE_INTERVAL_US ||
        metadata.workload.aiVersion !== AI_VERSION
    ) {
        throw new Error(`Capture metadata contract drift: ${path}`);
    }
    return metadata;
}

async function runChildCapture(
    capture: number,
    repeats: number,
    profilePath: string,
    metadataPath: string,
): Promise<void> {
    const child = Bun.spawn({
        cmd: [
            process.execPath,
            RUNNER_PATH,
            "capture",
            `--capture=${capture}`,
            `--repeats=${repeats}`,
            `--profile=${profilePath}`,
            `--metadata=${metadataPath}`,
        ],
        cwd: ROOT,
        env: fixedChildEnvironment(),
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    if (stdout.trim()) process.stdout.write(stdout);
    if (exitCode !== 0) {
        throw new Error(`Capture ${capture} failed with exit ${exitCode}${stderr.trim() ? `:\n${stderr.trim()}` : ""}`);
    }
    if (stderr.trim()) process.stderr.write(stderr);
}

function runtimeReport(): Record<string, unknown> {
    return {
        bun: Bun.version,
        platform: platform(),
        release: release(),
        arch: arch(),
        logicalCpuCount: cpus().length,
        cpuModel: cpus()[0]?.model ?? "unknown",
        pid: process.pid,
        execPath: process.execPath,
    };
}

function pooledAttribution(captures: readonly ICaptureReport[]): IProfileAttribution {
    const totalSampledMicroseconds = captures.reduce(
        (sum, capture) => sum + capture.attribution.totalSampledMicroseconds,
        0,
    );
    const functions = {} as Record<TargetFunction, IFunctionAttribution>;
    for (const name of TARGET_FUNCTIONS) {
        const matchedNodeIds = new Set<number>();
        let inclusiveSampledMicroseconds = 0;
        let exclusiveSampledMicroseconds = 0;
        const stacks = new Map<string, number>();
        for (const capture of captures) {
            const item = capture.attribution.functions[name];
            for (const nodeId of item.matchedNodeIds) matchedNodeIds.add(nodeId);
            inclusiveSampledMicroseconds += item.inclusiveSampledMicroseconds;
            exclusiveSampledMicroseconds += item.exclusiveSampledMicroseconds;
            for (const row of item.topParentStacks) {
                stacks.set(row.stack, (stacks.get(row.stack) ?? 0) + row.sampledMicroseconds);
            }
        }
        functions[name] = {
            functionName: name,
            sourceSuffix: AI_SOURCE_SUFFIX,
            matchedNodeIds: [...matchedNodeIds].sort((left, right) => left - right),
            matchedNodeCount: matchedNodeIds.size,
            inclusiveSampledMicroseconds,
            inclusiveShare: inclusiveSampledMicroseconds / totalSampledMicroseconds,
            exclusiveSampledMicroseconds,
            exclusiveShare: exclusiveSampledMicroseconds / totalSampledMicroseconds,
            topParentStacks: [...stacks.entries()]
                .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
                .slice(0, 12)
                .map(([stack, sampledMicroseconds]) => ({
                    stack,
                    sampledMicroseconds,
                    shareOfCapture: sampledMicroseconds / totalSampledMicroseconds,
                })),
        };
    }
    const primaryInclusiveShare = functions[PRIMARY_TARGET].inclusiveShare;
    return {
        intervalMicroseconds: PROFILE_INTERVAL_US,
        nodeCount: captures.reduce((sum, capture) => sum + capture.attribution.nodeCount, 0),
        sampleCount: captures.reduce((sum, capture) => sum + capture.attribution.sampleCount, 0),
        totalSampledMicroseconds,
        profileDurationMicroseconds: captures.reduce(
            (sum, capture) => sum + capture.attribution.profileDurationMicroseconds,
            0,
        ),
        functions,
        primaryTarget: PRIMARY_TARGET,
        primaryInclusiveShare,
        primaryThreshold: MINIMUM_PRIMARY_SHARE,
        primaryThresholdPassed: primaryInclusiveShare >= MINIMUM_PRIMARY_SHARE,
    };
}

async function orchestrate(args: string[]): Promise<void> {
    const { values } = parseArgs({
        args,
        strict: true,
        allowPositionals: false,
        options: {
            out: { type: "string" },
            smoke: { type: "boolean", default: false },
            help: { type: "boolean", default: false },
        },
    });
    if (values.help) {
        console.log("Usage: bun docs/evidence/tools/a13_melee_target_profile.ts " + "--out=REPORT.json [--smoke]");
        return;
    }
    if (!values.out) throw new Error("--out is required");
    const output = resolve(values.out);
    const profileDirectory = `${output}.profiles`;
    if (existsSync(output)) throw new Error(`Refusing to overwrite report: ${output}`);
    if (existsSync(profileDirectory)) {
        throw new Error(`Refusing to overwrite profile directory: ${profileDirectory}`);
    }

    const mode: RunMode = values.smoke ? "smoke" : "evidence";
    const captureCount = mode === "evidence" ? EVIDENCE_CAPTURES : SMOKE_CAPTURES;
    const repeats = mode === "evidence" ? EVIDENCE_REPEATS : SMOKE_REPEATS;
    const sourceBefore = sourceSeal();
    const temporaryRoot = mkdtempSync(join(tmpdir(), "hoc-a13-melee-target-profile-"));
    const captures: ICaptureReport[] = [];
    const metadataRows: ICaptureMetadata[] = [];
    try {
        for (let capture = 1; capture <= captureCount; capture += 1) {
            const profilePath = join(temporaryRoot, `capture-${capture}.cpuprofile`);
            const metadataPath = join(temporaryRoot, `capture-${capture}.workload.json`);
            await runChildCapture(capture, repeats, profilePath, metadataPath);
            const metadata = readCaptureMetadata(metadataPath);
            if (metadata.capture !== capture || metadata.workload.repeats !== repeats) {
                throw new Error(`Capture ${capture} metadata does not match its requested workload`);
            }
            assertSameSource(sourceBefore, metadata.sourceBefore, `capture ${capture} preflight`);
            assertSameSource(sourceBefore, metadata.sourceAfter, `capture ${capture} postflight`);
            if (metadata.profile.sha256 !== sha256(readFileSync(profilePath))) {
                throw new Error(`Capture ${capture} profile hash mismatch`);
            }
            if (
                metadataRows.length > 0 &&
                (metadata.workload.actionDigest !== metadataRows[0].workload.actionDigest ||
                    metadata.workload.resultDigest !== metadataRows[0].workload.resultDigest)
            ) {
                throw new Error(
                    `Semantic drift across captures at capture ${capture}: ` +
                        `actions=${metadata.workload.actionDigest}, result=${metadata.workload.resultDigest}`,
                );
            }
            metadataRows.push(metadata);
            captures.push({
                capture,
                workloadArtifact: `capture-${capture}.workload.json`,
                profileArtifact: `capture-${capture}.cpuprofile`,
                workloadArtifactSha256: sha256(readFileSync(metadataPath)),
                profileArtifactSha256: metadata.profile.sha256,
                sourceIdentitySha256: metadata.sourceBefore.identitySha256,
                matches: metadata.workload.matches,
                actions: metadata.workload.actions,
                wallMilliseconds: metadata.workload.wallMilliseconds,
                actionDigest: metadata.workload.actionDigest,
                resultDigest: metadata.workload.resultDigest,
                attribution: parseProfile(profilePath),
            });
        }
        const sourceAfter = sourceSeal();
        assertSameSource(sourceBefore, sourceAfter, "full profile run");
        const pooled = pooledAttribution(captures);
        const everyCaptureAtOrAboveThreshold = captures.every((capture) => capture.attribution.primaryThresholdPassed);
        const measurementGatesPassed = everyCaptureAtOrAboveThreshold && pooled.primaryThresholdPassed;
        const report = {
            schema: SCHEMA,
            createdAt: new Date().toISOString(),
            mode,
            protocol: {
                purpose: "A13 Workstream 5 current-tree melee target-layer attribution",
                aiVersion: AI_VERSION,
                mirror: true,
                environmentScrubPrefixes: ENVIRONMENT_PREFIXES,
                fixedEnvironment: FIXED_ENVIRONMENT,
                warmup: {
                    seed: WARMUP_SEED,
                    maxLaps: WARMUP_MAX_LAPS,
                    profiled: false,
                },
                measured: {
                    seeds: PROFILE_SEEDS,
                    maxLaps: PROFILE_MAX_LAPS,
                    repeatsPerCapture: repeats,
                    captures: captureCount,
                    matchesPerCapture: PROFILE_SEEDS.length * repeats,
                    profilerIntervalMicroseconds: PROFILE_INTERVAL_US,
                },
                attribution: {
                    sourceSuffix: AI_SOURCE_SUFFIX,
                    exactFunctionNames: TARGET_FUNCTIONS,
                    method:
                        "Chrome sample timeDeltas attributed through reconstructed leaf-to-root parent stacks; " +
                        "a function matches only when both functionName and source URL suffix match",
                    inclusiveRecursionPolicy: "at most once per named target per sample",
                    denominator: "all nonnegative sample timeDeltas in the capture",
                    primaryTarget: PRIMARY_TARGET,
                    minimumPrimaryInclusiveShare: MINIMUM_PRIMARY_SHARE,
                },
            },
            source: {
                before: sourceBefore,
                after: sourceAfter,
                unchanged: true,
                captureIdentitySha256: metadataRows.map((metadata) => metadata.sourceBefore.identitySha256),
            },
            runtime: runtimeReport(),
            artifacts: {
                directory: basename(profileDirectory),
                rawChromeProfilesRetained: true,
                workloadMetadataRetained: true,
            },
            semantic: {
                actionDigest: metadataRows[0].workload.actionDigest,
                resultDigest: metadataRows[0].workload.resultDigest,
                repeatsCompared: repeats * captureCount,
                capturesCompared: captureCount,
                identicalAcrossRepeatsAndCaptures: true,
                rejected: 0,
                stuck: 0,
            },
            captures,
            pooled,
            gates: {
                primaryTarget: PRIMARY_TARGET,
                minimumInclusiveShare: MINIMUM_PRIMARY_SHARE,
                captureShares: captures.map((capture) => ({
                    capture: capture.capture,
                    share: capture.attribution.primaryInclusiveShare,
                    passed: capture.attribution.primaryThresholdPassed,
                })),
                everyCaptureAtOrAboveThreshold,
                pooledShare: pooled.primaryInclusiveShare,
                pooledAtOrAboveThreshold: pooled.primaryThresholdPassed,
                measurementGatesPassed,
                qualified: mode === "evidence" && measurementGatesPassed,
                smokeNeverQualifies: mode === "smoke",
            },
        };

        mkdirSync(profileDirectory);
        for (let capture = 1; capture <= captureCount; capture += 1) {
            for (const extension of ["cpuprofile", "workload.json"]) {
                const name = `capture-${capture}.${extension}`;
                copyFileSync(join(temporaryRoot, name), join(profileDirectory, name), fsConstants.COPYFILE_EXCL);
            }
        }
        writeJsonAtomicExclusive(output, report);
        console.log(
            `wrote ${output}; ${PRIMARY_TARGET} pooled=${(pooled.primaryInclusiveShare * 100).toFixed(3)}% ` +
                `captures=[${captures
                    .map((capture) => (capture.attribution.primaryInclusiveShare * 100).toFixed(3))
                    .join(", ")}]%`,
        );
        if (mode === "evidence" && !measurementGatesPassed) {
            throw new Error(`Workstream 5 >=${MINIMUM_PRIMARY_SHARE * 100}% attribution gate failed`);
        }
    } finally {
        rmSync(temporaryRoot, { recursive: true, force: true });
    }
}

async function main(): Promise<void> {
    const [command, ...rest] = process.argv.slice(2);
    if (command === "capture") {
        await captureMain(rest);
        return;
    }
    await orchestrate(process.argv.slice(2));
}

try {
    await main();
} catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
}
