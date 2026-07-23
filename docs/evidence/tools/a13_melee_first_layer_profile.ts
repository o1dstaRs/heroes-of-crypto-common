#!/usr/bin/env bun

/**
 * Sealed cross-root fixed-work CPU profiler for A13 Workstream 5 canonical first-layer elision.
 *
 * This runner is intentionally independent from the sealed Workstream 1 and Workstream 4 evidence
 * tools. A normal run launches balanced fresh Bun processes for the baseline and candidate roots. Every process:
 *
 *  - starts from the exact scrubbed environment below;
 *  - warms v0.8 mirror self-play once, outside the profiler;
 *  - records nine identical repeats of the six-seed corpus in a Chrome CPU profile;
 *  - rejects engine-declined actions, stuck matches, semantic drift, or source/HEAD drift.
 *
 * The parent parses sample stacks from each .cpuprofile. Inclusive attribution requires both each
 * exact function name and its registered source URL suffix, so identically named helpers in
 * dependencies cannot contaminate the result. It gates the reduction of full-builder work under
 * doFindTarget and the candidate's combined full-plus-first builder share while requiring exact match semantics.
 *
 * Evidence run:
 *   bun docs/evidence/tools/a13_melee_first_layer_profile.ts \
 *     --baseline-root=/tmp/common-baseline --candidate-root=/tmp/common-candidate \
 *     --out=/tmp/a13-melee-first-layer-profile.json
 *
 * Structural smoke (one capture and one repeat; never marked qualified):
 *   bun docs/evidence/tools/a13_melee_first_layer_profile.ts \
 *     --smoke --out=/tmp/a13-melee-first-layer-profile-smoke.json
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
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const SCHEMA = "heroes-of-crypto/a13-melee-first-layer-profile/v1" as const;
const CAPTURE_SCHEMA = "heroes-of-crypto/a13-melee-first-layer-capture/v1" as const;
const RUNNER_PATH = fileURLToPath(import.meta.url);
const RUNNER_ROOT = resolve(dirname(RUNNER_PATH), "../../..");
const AI_SOURCE_SUFFIX = "/src/ai/ai.ts";
const CATALOG_SOURCE_SUFFIX = "/src/ai/decision_path_catalog.ts";
const FUSED_SOURCE_SUFFIX = "/src/ai/internal/melee_target_layers.ts";
const PROFILE_INTERVAL_US = 500;
const EVIDENCE_CAPTURES = 4;
const EVIDENCE_REPEATS = 9;
const SMOKE_CAPTURES = 1;
const SMOKE_REPEATS = 1;
const WARMUP_SEED = 9001;
const WARMUP_MAX_LAPS = 2;
const PROFILE_SEEDS = [1, 42, 43, 44, 45, 46] as const;
const PROFILE_MAX_LAPS = 4;
const AI_VERSION = "v0.8";
const MINIMUM_INFINITE_PARENT_REDUCTION = 0.5;
const MAXIMUM_CANDIDATE_COMBINED_BUILDER_SHARE = 0.03;
const TARGET_FUNCTIONS = [
    "doFindTarget",
    "canElideUnconsumedMeleeLayers",
    "buildMeleeTargetLayers",
    "buildFirstMeleeTargetLayers",
    "appendSmallLayer",
    "appendBigLayer",
    "isFreeAt",
] as const;
const ENVIRONMENT_PREFIXES = ["SEARCH_", "V04_", "V05_", "V06_", "V07_", "V08_", "Q2_", "SIM_"] as const;
const ENVIRONMENT_EXACT_KEYS = [
    "FORCE_CREATURES",
    "COHORT",
    "ROSTER_RANGED_MIN",
    "ROSTER_RANGED_MAX",
    "ROSTER_FLYER_MIN",
    "ROSTER_FLYER_MAX",
    "ROSTER_CASTER_MIN",
    "ROSTER_CASTER_MAX",
    "VALUE_DATA",
    "VALUE_DATA_FEATURES",
    "PHASE_B_RUN_FINGERPRINT",
] as const;
const ENVIRONMENT_EXACT_KEY_SET = new Set<string>(ENVIRONMENT_EXACT_KEYS);
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
    "src/ai/internal/melee_target_layers.ts",
    "src/simulation/army.ts",
    "src/simulation/battle_engine.ts",
    "src/simulation/search_driver.ts",
    "src/simulation/v0_8_a13_search.ts",
    "package.json",
] as const;

type TargetFunction = (typeof TARGET_FUNCTIONS)[number];
const TARGET_SOURCE_SUFFIXES = {
    doFindTarget: AI_SOURCE_SUFFIX,
    canElideUnconsumedMeleeLayers: CATALOG_SOURCE_SUFFIX,
    buildMeleeTargetLayers: FUSED_SOURCE_SUFFIX,
    buildFirstMeleeTargetLayers: FUSED_SOURCE_SUFFIX,
    appendSmallLayer: FUSED_SOURCE_SUFFIX,
    appendBigLayer: FUSED_SOURCE_SUFFIX,
    isFreeAt: FUSED_SOURCE_SUFFIX,
} as const satisfies Readonly<Record<TargetFunction, string>>;
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
    variant: "baseline" | "candidate";
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

interface ICallCounterMetadata {
    schema: "heroes-of-crypto/a13-melee-first-layer-call-count/v1";
    variant: "baseline" | "candidate";
    sourceBefore: ISourceSeal;
    sourceAfter: ISourceSeal;
    sourceUnchanged: true;
    instrumentation: {
        traceOnly: true;
        runnerSha256: string;
        sourcePath: string;
        sourceSha256: string;
        transformedSha256: string;
        fullBuilderReplacements: 1;
        firstBuilderReplacements: 0 | 1;
        profilerPreciseCoverageUnavailable: true;
        limitation: string;
    };
    workload: {
        seeds: readonly number[];
        maxLaps: number;
        matches: number;
        actions: number;
        actionDigest: string;
        resultDigest: string;
        rejected: 0;
        stuck: 0;
    };
    calls: {
        fullBuilder: number;
        firstBuilder: number;
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
    sourceSuffix: string;
    matchedNodeIds: number[];
    matchedNodeCount: number;
    inclusiveSampledMicroseconds: number;
    inclusiveShare: number;
    underDoFindTargetSampledMicroseconds: number;
    underDoFindTargetShare: number;
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
}

interface ICaptureReport {
    variant: "baseline" | "candidate";
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

function gitValue(root: string, ...args: string[]): string {
    try {
        return execFileSync("git", args, {
            cwd: root,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
    } catch {
        return "unavailable-source-root-without-git-metadata";
    }
}

function nearestWorkspaceLock(start: string): string {
    let directory = resolve(start);
    while (true) {
        for (const name of ["bun.lock", "bun.lockb"]) {
            const path = join(directory, name);
            if (existsSync(path) && statSync(path).isFile()) return path;
        }
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
    }
    throw new Error(`Unable to find bun.lock or bun.lockb above dependency root ${start}`);
}

function sourceSeal(rootInput: string): ISourceSeal {
    const root = resolve(rootInput);
    const sourceRoot = join(root, "src");
    const commonNodeModulesRealPath = realpathSync(join(root, "node_modules"));
    const workspaceLockPath = nearestWorkspaceLock(dirname(commonNodeModulesRealPath));
    const workspaceRoot = dirname(workspaceLockPath);
    const workspaceNodeModulesPath = join(workspaceRoot, "node_modules");
    if (!existsSync(workspaceNodeModulesPath)) {
        throw new Error(`Workspace node_modules is missing beside ${workspaceLockPath}`);
    }
    const entries: ISourceEntry[] = [];
    collectSourceEntries(sourceRoot, root, entries);
    entries.sort((left, right) => left.path.localeCompare(right.path));
    const selectedSha256: Record<string, string | null> = {};
    for (const path of SELECTED_SOURCE_PATHS) selectedSha256[path] = readSha256(join(root, path));
    if (!existsSync(workspaceLockPath) || !statSync(workspaceLockPath).isFile()) {
        throw new Error(`Workspace lockfile is missing: ${workspaceLockPath}`);
    }
    const workspaceLockStats = statSync(workspaceLockPath);
    const sealWithoutIdentity = {
        root,
        realRoot: realpathSync(root),
        workspaceRoot,
        realWorkspaceRoot: realpathSync(workspaceRoot),
        gitHead: gitValue(root, "rev-parse", "HEAD"),
        gitTree: gitValue(root, "rev-parse", "HEAD^{tree}"),
        srcEntryCount: entries.length,
        srcBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
        srcManifestSha256: digest(entries),
        selectedSha256,
        workspaceLock: {
            path: normalizedPath(relative(root, workspaceLockPath)),
            bytes: workspaceLockStats.size,
            sha256: sha256(readFileSync(workspaceLockPath)),
        },
        dependencySeal: {
            sealed: false as const,
            commonNodeModulesRealPath,
            workspaceNodeModulesRealPath: realpathSync(workspaceNodeModulesPath),
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

const EXPECTED_SOURCE_DELTA = Object.freeze([
    { path: "ai/ai.ts", change: "modified" },
    { path: "ai/decision_path_catalog.ts", change: "modified" },
    { path: "ai/internal/melee_target_layers.ts", change: "modified" },
] as const);

function sourceEntries(rootInput: string): ISourceEntry[] {
    const root = resolve(rootInput);
    const entries: ISourceEntry[] = [];
    const sourceRoot = join(root, "src");
    collectSourceEntries(sourceRoot, sourceRoot, entries);
    return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function sourceDelta(baselineRoot: string, candidateRoot: string): Record<string, unknown> {
    const baseline = new Map(sourceEntries(baselineRoot).map((entry) => [entry.path, entry]));
    const candidate = new Map(sourceEntries(candidateRoot).map((entry) => [entry.path, entry]));
    const differences = [...new Set([...baseline.keys(), ...candidate.keys()])]
        .sort()
        .filter((path) => canonicalJson(baseline.get(path)) !== canonicalJson(candidate.get(path)))
        .map((path) => {
            const before = baseline.get(path);
            const after = candidate.get(path);
            return {
                path,
                change: !before ? "added" : !after ? "deleted" : "modified",
                baselineSha256: before?.sha256 ?? null,
                candidateSha256: after?.sha256 ?? null,
            };
        });
    const actual = differences.map(({ path, change }) => ({ path, change }));
    const exactExpected = canonicalJson(actual) === canonicalJson(EXPECTED_SOURCE_DELTA);
    if (!exactExpected) {
        throw new Error(
            `Profile roots must differ by exactly the preregistered runtime files: ` +
                `expected=${canonicalJson(EXPECTED_SOURCE_DELTA)} actual=${canonicalJson(actual)}`,
        );
    }
    return {
        exactExpected: true,
        expected: EXPECTED_SOURCE_DELTA,
        actual,
        differences,
        manifestSha256: digest(differences),
    };
}

function shouldScrubEnvironmentKey(key: string): boolean {
    return ENVIRONMENT_EXACT_KEY_SET.has(key) || ENVIRONMENT_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function assertFixedEnvironment(environment: Readonly<Record<string, string>>, phase: string): void {
    const fixedKeys = new Set(Object.keys(FIXED_ENVIRONMENT));
    const forbiddenSurvivors = Object.keys(environment)
        .filter((key) => shouldScrubEnvironmentKey(key) && !fixedKeys.has(key))
        .sort();
    if (forbiddenSurvivors.length > 0) {
        throw new Error(`${phase} retained scrubbed environment keys: ${forbiddenSurvivors.join(",")}`);
    }
    const installedFixed = Object.fromEntries(
        Object.keys(FIXED_ENVIRONMENT)
            .sort()
            .map((key) => [key, environment[key]]),
    );
    if (canonicalJson(installedFixed) !== canonicalJson(FIXED_ENVIRONMENT)) {
        throw new Error(`${phase} fixed environment mismatch: ${canonicalJson(installedFixed)}`);
    }
}

function fixedChildEnvironment(): Record<string, string> {
    const environment: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !shouldScrubEnvironmentKey(key)) environment[key] = value;
    }
    Object.assign(environment, FIXED_ENVIRONMENT);
    assertFixedEnvironment(environment, "Child environment construction");
    return environment;
}

function installFixedEnvironment(): Record<string, string> {
    for (const key of Object.keys(process.env)) {
        if (shouldScrubEnvironmentKey(key)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(FIXED_ENVIRONMENT)) process.env[key] = value;
    const installedEnvironment = Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    assertFixedEnvironment(installedEnvironment, "Child environment installation");
    return { ...FIXED_ENVIRONMENT };
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
            variant: { type: "string" },
            "source-root": { type: "string" },
            capture: { type: "string" },
            repeats: { type: "string" },
            profile: { type: "string" },
            metadata: { type: "string" },
        },
    });
    if (
        (values.variant !== "baseline" && values.variant !== "candidate") ||
        !values["source-root"] ||
        !values.capture ||
        !values.repeats ||
        !values.profile ||
        !values.metadata
    ) {
        throw new Error(
            "Internal capture requires baseline/candidate --variant, --source-root, --capture, --repeats, --profile, and --metadata",
        );
    }
    const variant = values.variant;
    const sourceRoot = resolve(values["source-root"]);
    const capture = positiveInteger(values.capture, "--capture");
    const repeats = positiveInteger(values.repeats, "--repeats");
    const profilePath = resolve(values.profile);
    const metadataPath = resolve(values.metadata);
    if (existsSync(profilePath) || existsSync(metadataPath)) {
        throw new Error(`Refusing to overwrite capture ${capture} output`);
    }

    const environment = installFixedEnvironment();
    const sourceBefore = sourceSeal(sourceRoot);
    const importNonce = `${variant}-${capture}-${process.pid}`;
    const army = await import(
        `${pathToFileURL(join(sourceRoot, "src/simulation/army.ts")).href}?profile=${importNonce}`
    );
    const battle = await import(
        `${pathToFileURL(join(sourceRoot, "src/simulation/battle_engine.ts")).href}?profile=${importNonce}`
    );
    const runSeed = (seed: number, maxLaps: number): Record<string, unknown> => {
        return battle.runMatch({
            greenVersion: AI_VERSION,
            redVersion: AI_VERSION,
            roster: army.buildRoster(army.makeRng(seed)),
            seed,
            maxLaps,
        }) as unknown as Record<string, unknown>;
    };

    const warmup = runSeed(WARMUP_SEED, WARMUP_MAX_LAPS);
    assertHealthyResult(warmup, `capture=${capture} warmup seed=${WARMUP_SEED}`);
    const measuredResultGroups: Record<string, unknown>[][] = [];
    const workloadStarted = performance.now();
    const profile = await recordCpuProfile(() => {
        for (let repeat = 0; repeat < repeats; repeat++) {
            measuredResultGroups.push(PROFILE_SEEDS.map((seed) => runSeed(seed, PROFILE_MAX_LAPS)));
        }
    });
    const wallMilliseconds = performance.now() - workloadStarted;
    const measuredResults = measuredResultGroups.flat();
    for (let repeat = 0; repeat < measuredResultGroups.length; repeat++) {
        for (let seedIndex = 0; seedIndex < measuredResultGroups[repeat].length; seedIndex++) {
            assertHealthyResult(
                measuredResultGroups[repeat][seedIndex],
                `capture=${capture} repeat=${repeat} seed=${PROFILE_SEEDS[seedIndex]}`,
            );
        }
    }
    const repeatResults: IRepeatResult[] = measuredResultGroups.map((results, repeat) => ({
        repeat,
        matches: results.length,
        actions: results.reduce((sum, result) => sum + Number(result.totalActions), 0),
        actionDigest: digest(results.map((result) => result.actions)),
        resultDigest: digest(results),
    }));
    for (const row of repeatResults.slice(1)) {
        if (row.actionDigest !== repeatResults[0].actionDigest || row.resultDigest !== repeatResults[0].resultDigest) {
            throw new Error(
                `Semantic drift inside capture ${capture}, repeat ${row.repeat}: ` +
                    `actions=${row.actionDigest}, result=${row.resultDigest}`,
            );
        }
    }
    if (repeatResults.length !== repeats || measuredResults.length !== repeats * PROFILE_SEEDS.length) {
        throw new Error(`Incomplete workload in capture ${capture}`);
    }

    writeJsonExclusive(profilePath, profile);
    const sourceAfter = sourceSeal(sourceRoot);
    assertSameSource(sourceBefore, sourceAfter, `capture ${capture}`);
    const profileStats = statSync(profilePath);
    const metadata: ICaptureMetadata = {
        schema: CAPTURE_SCHEMA,
        variant,
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

const CALL_COUNTER_KEY = "__hocA13MeleeFirstLayerCalls" as const;

async function preciseCoverageUnsupported(): Promise<string> {
    const session = new Session();
    session.connect();
    try {
        await postInspector(session, "Profiler.enable");
        try {
            await postInspector(session, "Profiler.startPreciseCoverage", {
                callCount: true,
                detailed: true,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!message.includes("Coverage APIs are not supported")) throw error;
            return message;
        }
        await postInspector(session, "Profiler.stopPreciseCoverage");
        throw new Error(
            "Profiler precise coverage is now supported; replace the loader fallback with native call-count telemetry",
        );
    } finally {
        try {
            await postInspector(session, "Profiler.disable");
        } finally {
            session.disconnect();
        }
    }
}

function injectCallCounter(
    source: string,
    functionName: "buildMeleeTargetLayers" | "buildFirstMeleeTargetLayers",
    field: "fullBuilder" | "firstBuilder",
    required: boolean,
): { source: string; replacements: 0 | 1 } {
    const signature = `export function ${functionName}(`;
    const signatureIndex = source.indexOf(signature);
    if (signatureIndex < 0) {
        if (required) throw new Error(`Instrumentation target is absent: ${functionName}`);
        return { source, replacements: 0 };
    }
    if (source.indexOf(signature, signatureIndex + signature.length) >= 0) {
        throw new Error(`Instrumentation target is ambiguous: ${functionName}`);
    }
    const bodyMarker = "): XY[][] {";
    const markerIndex = source.indexOf(bodyMarker, signatureIndex + signature.length);
    if (markerIndex < 0) throw new Error(`Instrumentation body marker is absent: ${functionName}`);
    const insertionIndex = markerIndex + bodyMarker.length;
    const counter =
        `\n    (globalThis as unknown as { ${CALL_COUNTER_KEY}: { fullBuilder: number; firstBuilder: number } })` +
        `.${CALL_COUNTER_KEY}.${field}++;`;
    return {
        source: `${source.slice(0, insertionIndex)}${counter}${source.slice(insertionIndex)}`,
        replacements: 1,
    };
}

async function callCounterMain(args: string[]): Promise<void> {
    const { values } = parseArgs({
        args,
        strict: true,
        allowPositionals: false,
        options: {
            variant: { type: "string" },
            "source-root": { type: "string" },
            metadata: { type: "string" },
        },
    });
    if (
        (values.variant !== "baseline" && values.variant !== "candidate") ||
        !values["source-root"] ||
        !values.metadata
    ) {
        throw new Error("Internal call counter requires baseline/candidate --variant, --source-root, and --metadata");
    }
    const variant = values.variant;
    const sourceRoot = resolve(values["source-root"]);
    const metadataPath = resolve(values.metadata);
    if (existsSync(metadataPath)) throw new Error(`Refusing to overwrite call-count metadata: ${metadataPath}`);
    installFixedEnvironment();
    const preciseCoverageError = await preciseCoverageUnsupported();
    const sourceBefore = sourceSeal(sourceRoot);
    const layerPath = join(sourceRoot, "src/ai/internal/melee_target_layers.ts");
    const original = readFileSync(layerPath, "utf8");
    const full = injectCallCounter(original, "buildMeleeTargetLayers", "fullBuilder", true);
    const first = injectCallCounter(
        full.source,
        "buildFirstMeleeTargetLayers",
        "firstBuilder",
        variant === "candidate",
    );
    (
        globalThis as unknown as {
            [CALL_COUNTER_KEY]: { fullBuilder: number; firstBuilder: number };
        }
    )[CALL_COUNTER_KEY] = { fullBuilder: 0, firstBuilder: 0 };
    Bun.plugin({
        name: `a13-melee-first-layer-call-counter-${variant}-${process.pid}`,
        setup(build): void {
            build.onLoad({ filter: /[/\\]ai[/\\]internal[/\\]melee_target_layers\.ts$/ }, () => {
                return { contents: first.source, loader: "ts" };
            });
        },
    });
    const importNonce = `counter-${variant}-${process.pid}`;
    const army = await import(
        `${pathToFileURL(join(sourceRoot, "src/simulation/army.ts")).href}?profile=${importNonce}`
    );
    const battle = await import(
        `${pathToFileURL(join(sourceRoot, "src/simulation/battle_engine.ts")).href}?profile=${importNonce}`
    );
    const runSeed = (seed: number, maxLaps: number): Record<string, unknown> => {
        const result = battle.runMatch({
            greenVersion: AI_VERSION,
            redVersion: AI_VERSION,
            roster: army.buildRoster(army.makeRng(seed)),
            seed,
            maxLaps,
        }) as unknown as Record<string, unknown>;
        assertHealthyResult(result, `call-counter variant=${variant} seed=${seed}`);
        return result;
    };
    runSeed(WARMUP_SEED, WARMUP_MAX_LAPS);
    const counters = (
        globalThis as unknown as {
            [CALL_COUNTER_KEY]: { fullBuilder: number; firstBuilder: number };
        }
    )[CALL_COUNTER_KEY];
    counters.fullBuilder = 0;
    counters.firstBuilder = 0;
    const results = PROFILE_SEEDS.map((seed) => runSeed(seed, PROFILE_MAX_LAPS));
    const sourceAfter = sourceSeal(sourceRoot);
    assertSameSource(sourceBefore, sourceAfter, `${variant} call-count trace`);
    const metadata: ICallCounterMetadata = {
        schema: "heroes-of-crypto/a13-melee-first-layer-call-count/v1",
        variant,
        sourceBefore,
        sourceAfter,
        sourceUnchanged: true,
        instrumentation: {
            traceOnly: true,
            runnerSha256: sha256(readFileSync(RUNNER_PATH)),
            sourcePath: normalizedPath(relative(sourceRoot, layerPath)),
            sourceSha256: sha256(original),
            transformedSha256: sha256(first.source),
            fullBuilderReplacements: full.replacements,
            firstBuilderReplacements: first.replacements,
            profilerPreciseCoverageUnavailable: true,
            limitation:
                `Inspector Profiler.startPreciseCoverage rejected this process with '${preciseCoverageError}'. ` +
                "A separate, timing-excluded symmetric loader transform increments only two numeric counters; " +
                "its action/result digests must match the uninstrumented profiles.",
        },
        workload: {
            seeds: PROFILE_SEEDS,
            maxLaps: PROFILE_MAX_LAPS,
            matches: results.length,
            actions: results.reduce((sum, result) => sum + Number(result.totalActions), 0),
            actionDigest: digest(results.map((result) => result.actions)),
            resultDigest: digest(results),
            rejected: 0,
            stuck: 0,
        },
        calls: { ...counters },
    };
    writeJsonExclusive(metadataPath, metadata);
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

function targetSourceSuffix(name: TargetFunction): string {
    return TARGET_SOURCE_SUFFIXES[name];
}

function isExactTargetFrame(frame: ICallFrame | undefined, name: TargetFunction): boolean {
    return frame?.functionName === name && normalizedSourceUrl(frame.url).endsWith(targetSourceSuffix(name));
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
    const underDoFindTarget = Object.fromEntries(TARGET_FUNCTIONS.map((name) => [name, 0])) as Record<
        TargetFunction,
        number
    >;
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
            if (stack.slice(outermostIndex + 1).some((node) => isExactTargetFrame(node.callFrame, "doFindTarget"))) {
                underDoFindTarget[name] += delta;
            }
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
            sourceSuffix: targetSourceSuffix(name),
            matchedNodeIds: sortedNodeIds,
            matchedNodeCount: sortedNodeIds.length,
            inclusiveSampledMicroseconds: inclusive[name],
            inclusiveShare: inclusive[name] / totalSampledMicroseconds,
            underDoFindTargetSampledMicroseconds: underDoFindTarget[name],
            underDoFindTargetShare: underDoFindTarget[name] / totalSampledMicroseconds,
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
    return {
        intervalMicroseconds: PROFILE_INTERVAL_US,
        nodeCount: profile.nodes.length,
        sampleCount: profile.samples.length,
        totalSampledMicroseconds,
        profileDurationMicroseconds: profile.endTime - profile.startTime,
        functions,
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
    variant: "baseline" | "candidate",
    sourceRoot: string,
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
            `--variant=${variant}`,
            `--source-root=${sourceRoot}`,
            `--capture=${capture}`,
            `--repeats=${repeats}`,
            `--profile=${profilePath}`,
            `--metadata=${metadataPath}`,
        ],
        cwd: sourceRoot,
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
        throw new Error(
            `${variant} capture ${capture} failed with exit ${exitCode}${stderr.trim() ? `:\n${stderr.trim()}` : ""}`,
        );
    }
    if (stderr.trim()) process.stderr.write(stderr);
}

async function runChildCallCounter(
    variant: "baseline" | "candidate",
    sourceRoot: string,
    metadataPath: string,
): Promise<void> {
    const child = Bun.spawn({
        cmd: [
            process.execPath,
            RUNNER_PATH,
            "count-calls",
            `--variant=${variant}`,
            `--source-root=${sourceRoot}`,
            `--metadata=${metadataPath}`,
        ],
        cwd: sourceRoot,
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
        throw new Error(
            `${variant} call counter failed with exit ${exitCode}${stderr.trim() ? `:\n${stderr.trim()}` : ""}`,
        );
    }
    if (stderr.trim()) process.stderr.write(stderr);
}

function readCallCounterMetadata(path: string, variant: "baseline" | "candidate"): ICallCounterMetadata {
    const metadata = JSON.parse(readFileSync(path, "utf8")) as ICallCounterMetadata;
    if (
        metadata.schema !== "heroes-of-crypto/a13-melee-first-layer-call-count/v1" ||
        metadata.variant !== variant ||
        metadata.workload.matches !== PROFILE_SEEDS.length
    ) {
        throw new Error(`Call-count metadata contract drift: ${path}`);
    }
    return metadata;
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
        let underDoFindTargetSampledMicroseconds = 0;
        let exclusiveSampledMicroseconds = 0;
        const stacks = new Map<string, number>();
        for (const capture of captures) {
            const item = capture.attribution.functions[name];
            for (const nodeId of item.matchedNodeIds) matchedNodeIds.add(nodeId);
            inclusiveSampledMicroseconds += item.inclusiveSampledMicroseconds;
            underDoFindTargetSampledMicroseconds += item.underDoFindTargetSampledMicroseconds;
            exclusiveSampledMicroseconds += item.exclusiveSampledMicroseconds;
            for (const row of item.topParentStacks) {
                stacks.set(row.stack, (stacks.get(row.stack) ?? 0) + row.sampledMicroseconds);
            }
        }
        functions[name] = {
            functionName: name,
            sourceSuffix: targetSourceSuffix(name),
            matchedNodeIds: [...matchedNodeIds].sort((left, right) => left - right),
            matchedNodeCount: matchedNodeIds.size,
            inclusiveSampledMicroseconds,
            inclusiveShare: inclusiveSampledMicroseconds / totalSampledMicroseconds,
            underDoFindTargetSampledMicroseconds,
            underDoFindTargetShare: underDoFindTargetSampledMicroseconds / totalSampledMicroseconds,
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
    };
}

function captureVariantOrder(capture: number): readonly ["baseline", "candidate"] | readonly ["candidate", "baseline"] {
    return capture % 4 === 1 || capture % 4 === 0
        ? (["baseline", "candidate"] as const)
        : (["candidate", "baseline"] as const);
}

async function orchestrate(args: string[]): Promise<void> {
    const { values } = parseArgs({
        args,
        strict: true,
        allowPositionals: false,
        options: {
            "baseline-root": { type: "string" },
            "candidate-root": { type: "string" },
            out: { type: "string" },
            smoke: { type: "boolean", default: false },
            help: { type: "boolean", default: false },
        },
    });
    if (values.help) {
        console.log(
            "Usage: bun docs/evidence/tools/a13_melee_first_layer_profile.ts " +
                "--baseline-root=ROOT --candidate-root=ROOT --out=REPORT.json [--smoke]",
        );
        return;
    }
    if (!values["baseline-root"] || !values["candidate-root"] || !values.out) {
        throw new Error("--baseline-root, --candidate-root, and --out are required");
    }
    const baselineRoot = resolve(values["baseline-root"]);
    const candidateRoot = resolve(values["candidate-root"]);
    if (realpathSync(baselineRoot) === realpathSync(candidateRoot)) {
        throw new Error("Baseline and candidate roots must be distinct");
    }
    const output = resolve(values.out);
    const profileDirectory = `${output}.profiles`;
    if (existsSync(output)) throw new Error(`Refusing to overwrite report: ${output}`);
    if (existsSync(profileDirectory)) {
        throw new Error(`Refusing to overwrite profile directory: ${profileDirectory}`);
    }

    const mode: RunMode = values.smoke ? "smoke" : "evidence";
    const captureCount = mode === "evidence" ? EVIDENCE_CAPTURES : SMOKE_CAPTURES;
    const repeats = mode === "evidence" ? EVIDENCE_REPEATS : SMOKE_REPEATS;
    const sourceBefore = {
        baseline: sourceSeal(baselineRoot),
        candidate: sourceSeal(candidateRoot),
    };
    const baselinePackageSha256 = sourceBefore.baseline.selectedSha256["package.json"];
    const candidatePackageSha256 = sourceBefore.candidate.selectedSha256["package.json"];
    if (
        baselinePackageSha256 === null ||
        candidatePackageSha256 === null ||
        baselinePackageSha256 !== candidatePackageSha256
    ) {
        throw new Error(
            `Baseline and candidate package hashes must be present and equal: ` +
                `baseline=${baselinePackageSha256} candidate=${candidatePackageSha256}`,
        );
    }
    if (
        sourceBefore.baseline.workspaceLock.sha256 !== sourceBefore.candidate.workspaceLock.sha256 ||
        sourceBefore.baseline.dependencySeal.commonNodeModulesRealPath !==
            sourceBefore.candidate.dependencySeal.commonNodeModulesRealPath ||
        sourceBefore.baseline.dependencySeal.workspaceNodeModulesRealPath !==
            sourceBefore.candidate.dependencySeal.workspaceNodeModulesRealPath
    ) {
        throw new Error("Baseline and candidate lock/dependency realpaths differ");
    }
    const crossRootInputPreflight = {
        passed: true,
        packageJsonSha256: baselinePackageSha256,
        workspaceLockSha256: sourceBefore.baseline.workspaceLock.sha256,
        commonNodeModulesRealPath: sourceBefore.baseline.dependencySeal.commonNodeModulesRealPath,
        workspaceNodeModulesRealPath: sourceBefore.baseline.dependencySeal.workspaceNodeModulesRealPath,
    };
    const delta = sourceDelta(baselineRoot, candidateRoot);
    const temporaryRoot = mkdtempSync(join(tmpdir(), "hoc-a13-melee-first-layer-profile-"));
    const captures: Record<"baseline" | "candidate", ICaptureReport[]> = {
        baseline: [],
        candidate: [],
    };
    const callCounters = {} as Record<"baseline" | "candidate", ICallCounterMetadata>;
    const metadataRows: ICaptureMetadata[] = [];
    try {
        for (const variant of ["baseline", "candidate"] as const) {
            const sourceRoot = variant === "baseline" ? baselineRoot : candidateRoot;
            const metadataPath = join(temporaryRoot, `${variant}-call-count.workload.json`);
            await runChildCallCounter(variant, sourceRoot, metadataPath);
            const metadata = readCallCounterMetadata(metadataPath, variant);
            assertSameSource(sourceBefore[variant], metadata.sourceBefore, `${variant} call-count preflight`);
            assertSameSource(sourceBefore[variant], metadata.sourceAfter, `${variant} call-count postflight`);
            if (metadata.instrumentation.runnerSha256 !== sha256(readFileSync(RUNNER_PATH))) {
                throw new Error(`${variant} call-count transform runner hash mismatch`);
            }
            callCounters[variant] = metadata;
        }
        for (let capture = 1; capture <= captureCount; capture += 1) {
            const order = captureVariantOrder(capture);
            for (const variant of order) {
                const sourceRoot = variant === "baseline" ? baselineRoot : candidateRoot;
                const profileName = `${variant}-capture-${capture}.cpuprofile`;
                const metadataName = `${variant}-capture-${capture}.workload.json`;
                const profilePath = join(temporaryRoot, profileName);
                const metadataPath = join(temporaryRoot, metadataName);
                await runChildCapture(variant, sourceRoot, capture, repeats, profilePath, metadataPath);
                const metadata = readCaptureMetadata(metadataPath);
                if (
                    metadata.variant !== variant ||
                    metadata.capture !== capture ||
                    metadata.workload.repeats !== repeats
                ) {
                    throw new Error(`${variant} capture ${capture} metadata does not match its requested workload`);
                }
                assertSameSource(
                    sourceBefore[variant],
                    metadata.sourceBefore,
                    `${variant} capture ${capture} preflight`,
                );
                assertSameSource(
                    sourceBefore[variant],
                    metadata.sourceAfter,
                    `${variant} capture ${capture} postflight`,
                );
                if (metadata.profile.sha256 !== sha256(readFileSync(profilePath))) {
                    throw new Error(`${variant} capture ${capture} profile hash mismatch`);
                }
                if (
                    metadataRows.length > 0 &&
                    (metadata.workload.actionDigest !== metadataRows[0].workload.actionDigest ||
                        metadata.workload.resultDigest !== metadataRows[0].workload.resultDigest)
                ) {
                    throw new Error(
                        `Semantic drift at ${variant} capture ${capture}: ` +
                            `actions=${metadata.workload.actionDigest}, result=${metadata.workload.resultDigest}`,
                    );
                }
                metadataRows.push(metadata);
                captures[variant].push({
                    variant,
                    capture,
                    workloadArtifact: metadataName,
                    profileArtifact: profileName,
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
        }
        const sourceAfter = {
            baseline: sourceSeal(baselineRoot),
            candidate: sourceSeal(candidateRoot),
        };
        assertSameSource(sourceBefore.baseline, sourceAfter.baseline, "full baseline profile run");
        assertSameSource(sourceBefore.candidate, sourceAfter.candidate, "full candidate profile run");
        const pooled = {
            baseline: pooledAttribution(captures.baseline),
            candidate: pooledAttribution(captures.candidate),
        };
        const baselineFullBuilder = pooled.baseline.functions.buildMeleeTargetLayers;
        const candidateFullBuilder = pooled.candidate.functions.buildMeleeTargetLayers;
        const baselineFullUnderDoFindTargetMicroseconds = baselineFullBuilder.underDoFindTargetSampledMicroseconds;
        const candidateFullUnderDoFindTargetMicroseconds = candidateFullBuilder.underDoFindTargetSampledMicroseconds;
        const baselineFullUnderDoFindTargetShare = baselineFullBuilder.underDoFindTargetShare;
        const candidateFullUnderDoFindTargetShare = candidateFullBuilder.underDoFindTargetShare;
        const infiniteParentReduction =
            baselineFullUnderDoFindTargetMicroseconds > 0
                ? 1 - candidateFullUnderDoFindTargetMicroseconds / baselineFullUnderDoFindTargetMicroseconds
                : Number.NEGATIVE_INFINITY;
        const candidateCombinedBuilderShare =
            pooled.candidate.functions.buildMeleeTargetLayers.inclusiveShare +
            pooled.candidate.functions.buildFirstMeleeTargetLayers.inclusiveShare;
        const baselineSignalPassed = baselineFullUnderDoFindTargetMicroseconds > 0;
        const infiniteParentReductionPassed =
            baselineSignalPassed && infiniteParentReduction >= MINIMUM_INFINITE_PARENT_REDUCTION;
        const candidateCombinedBuilderPassed =
            candidateCombinedBuilderShare <= MAXIMUM_CANDIDATE_COMBINED_BUILDER_SHARE;
        const exactSemanticsPassed =
            metadataRows.length === captureCount * 2 &&
            metadataRows.every(
                (metadata) =>
                    metadata.workload.actionDigest === metadataRows[0].workload.actionDigest &&
                    metadata.workload.resultDigest === metadataRows[0].workload.resultDigest,
            );
        const callCounterSemanticsPassed = (["baseline", "candidate"] as const).every(
            (variant) =>
                callCounters[variant].workload.actionDigest === metadataRows[0].workload.actionDigest &&
                callCounters[variant].workload.resultDigest === metadataRows[0].workload.resultDigest,
        );
        const fullBuilderCallRatio =
            callCounters.baseline.calls.fullBuilder > 0
                ? callCounters.candidate.calls.fullBuilder / callCounters.baseline.calls.fullBuilder
                : Number.POSITIVE_INFINITY;
        const fullBuilderCallsPassed = callCounters.baseline.calls.fullBuilder > 0 && fullBuilderCallRatio <= 0.5;
        const firstBuilderCallsPassed =
            callCounters.baseline.calls.firstBuilder === 0 && callCounters.candidate.calls.firstBuilder > 0;
        const measurementGatesPassed =
            exactSemanticsPassed &&
            callCounterSemanticsPassed &&
            fullBuilderCallsPassed &&
            firstBuilderCallsPassed &&
            baselineSignalPassed &&
            infiniteParentReductionPassed &&
            candidateCombinedBuilderPassed;
        const report = {
            schema: SCHEMA,
            createdAt: new Date().toISOString(),
            mode,
            protocol: {
                purpose: "A13 Workstream 5 cross-root melee first-layer attribution",
                aiVersion: AI_VERSION,
                mirror: true,
                environmentScrubPrefixes: ENVIRONMENT_PREFIXES,
                environmentScrubExactKeys: ENVIRONMENT_EXACT_KEYS,
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
                    capturesPerVariant: captureCount,
                    totalCaptures: captureCount * 2,
                    captureVariantOrder: Array.from({ length: captureCount }, (_, index) => ({
                        capture: index + 1,
                        order: captureVariantOrder(index + 1),
                    })),
                    matchesPerCapture: PROFILE_SEEDS.length * repeats,
                    profilerIntervalMicroseconds: PROFILE_INTERVAL_US,
                },
                attribution: {
                    exactFrames: TARGET_FUNCTIONS.map((functionName) => ({
                        functionName,
                        sourceSuffix: targetSourceSuffix(functionName),
                    })),
                    method:
                        "Chrome sample timeDeltas attributed through reconstructed leaf-to-root parent stacks; " +
                        "a function matches only when both functionName and source URL suffix match",
                    inclusiveRecursionPolicy: "at most once per named target per sample",
                    denominator: "all nonnegative sample timeDeltas in the capture",
                    profiledCallback:
                        "Only roster construction, runMatch, and retention of raw repeat result groups occur while profiling; validation, canonicalization, hashing, and repeat equality checks occur after Profiler.stop.",
                    infiniteParent:
                        "buildMeleeTargetLayers samples whose reconstructed caller stack contains exact doFindTarget@src/ai/ai.ts",
                    infiniteParentReductionMetric:
                        "1 - candidate fixed-work under-doFindTarget sampled microseconds / baseline fixed-work under-doFindTarget sampled microseconds; per-variant shares are descriptive only",
                    minimumInfiniteParentReduction: MINIMUM_INFINITE_PARENT_REDUCTION,
                    maximumCandidateCombinedBuilderShare: MAXIMUM_CANDIDATE_COMBINED_BUILDER_SHARE,
                    callCountTelemetry:
                        "Timing-excluded symmetric Bun loader transform after Profiler.startPreciseCoverage was confirmed unsupported",
                },
            },
            source: {
                before: sourceBefore,
                after: sourceAfter,
                unchanged: true,
                crossRootInputPreflight,
                delta,
                captureIdentitySha256: metadataRows.map((metadata) => ({
                    variant: metadata.variant,
                    capture: metadata.capture,
                    identitySha256: metadata.sourceBefore.identitySha256,
                })),
            },
            runtime: runtimeReport(),
            artifacts: {
                directory: basename(profileDirectory),
                rawChromeProfilesRetained: true,
                workloadMetadataRetained: true,
                callCountMetadataRetained: true,
            },
            semantic: {
                actionDigest: metadataRows[0].workload.actionDigest,
                resultDigest: metadataRows[0].workload.resultDigest,
                repeatsCompared: repeats * captureCount * 2,
                capturesCompared: captureCount * 2,
                variantsCompared: ["baseline", "candidate"],
                identicalAcrossRepeatsCapturesAndVariants: exactSemanticsPassed,
                instrumentedCallTraceIdenticalToUninstrumented: callCounterSemanticsPassed,
                rejected: 0,
                stuck: 0,
            },
            callCounts: {
                baseline: callCounters.baseline,
                candidate: callCounters.candidate,
                fullBuilderCandidateToBaselineRatio: fullBuilderCallRatio,
            },
            captures,
            pooled,
            gates: {
                exactSemanticsPassed,
                callCounterSemanticsPassed,
                fullBuilderCalls: {
                    comparator: "<=",
                    threshold: 0.5,
                    baseline: callCounters.baseline.calls.fullBuilder,
                    candidate: callCounters.candidate.calls.fullBuilder,
                    observedCandidateToBaselineRatio: fullBuilderCallRatio,
                    passed: fullBuilderCallsPassed,
                },
                firstBuilderCalls: {
                    baselineExpected: 0,
                    baseline: callCounters.baseline.calls.firstBuilder,
                    candidateMinimumExclusive: 0,
                    candidate: callCounters.candidate.calls.firstBuilder,
                    passed: firstBuilderCallsPassed,
                },
                baselineFullBuilderUnderDoFindTargetMicroseconds: baselineFullUnderDoFindTargetMicroseconds,
                candidateFullBuilderUnderDoFindTargetMicroseconds: candidateFullUnderDoFindTargetMicroseconds,
                baselineFullBuilderUnderDoFindTargetShare: baselineFullUnderDoFindTargetShare,
                candidateFullBuilderUnderDoFindTargetShare: candidateFullUnderDoFindTargetShare,
                baselineSignalPassed,
                infiniteParentReduction: {
                    comparator: ">=",
                    threshold: MINIMUM_INFINITE_PARENT_REDUCTION,
                    observed: infiniteParentReduction,
                    passed: infiniteParentReductionPassed,
                },
                candidateCombinedBuilderShare: {
                    comparator: "<=",
                    threshold: MAXIMUM_CANDIDATE_COMBINED_BUILDER_SHARE,
                    observed: candidateCombinedBuilderShare,
                    components: {
                        full: pooled.candidate.functions.buildMeleeTargetLayers.inclusiveShare,
                        first: pooled.candidate.functions.buildFirstMeleeTargetLayers.inclusiveShare,
                    },
                    passed: candidateCombinedBuilderPassed,
                },
                measurementGatesPassed,
                qualified: mode === "evidence" && measurementGatesPassed,
                smokeNeverQualifies: mode === "smoke",
            },
        };

        mkdirSync(profileDirectory);
        for (const variant of ["baseline", "candidate"] as const) {
            const callCountName = `${variant}-call-count.workload.json`;
            copyFileSync(
                join(temporaryRoot, callCountName),
                join(profileDirectory, callCountName),
                fsConstants.COPYFILE_EXCL,
            );
            for (let capture = 1; capture <= captureCount; capture += 1) {
                for (const extension of ["cpuprofile", "workload.json"]) {
                    const name = `${variant}-capture-${capture}.${extension}`;
                    copyFileSync(join(temporaryRoot, name), join(profileDirectory, name), fsConstants.COPYFILE_EXCL);
                }
            }
        }
        writeJsonAtomicExclusive(output, report);
        console.log(
            `wrote ${output}; full-builder-under-doFindTarget reduction=` +
                `${(infiniteParentReduction * 100).toFixed(3)}%; candidate combined builders=` +
                `${(candidateCombinedBuilderShare * 100).toFixed(3)}%`,
        );
        if (mode === "evidence" && !measurementGatesPassed) {
            throw new Error("Workstream 5 cross-root attribution gates failed");
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
    if (command === "count-calls") {
        await callCounterMain(rest);
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
