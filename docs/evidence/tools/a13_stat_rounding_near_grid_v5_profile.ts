#!/usr/bin/env bun

/**
 * Sealed cross-root fixed-work CPU profiler and timing-excluded telemetry runner for the A13
 * unit-stat decimal-normalization candidate.
 *
 * This runner is intentionally independent from the sealed Workstream 1 and Workstream 4 evidence
 * tools. A normal run launches balanced fresh Bun processes for the baseline and candidate roots. Every process:
 *
 *  - starts from the exact scrubbed environment below;
 *  - warms v0.8 mirror self-play once, outside the profiler;
 *  - records nine identical repeats of the six-seed corpus in a Chrome CPU profile;
 *  - rejects engine-declined actions, stuck matches, semantic drift, source/HEAD drift, or any
 *    mismatch between the optimized stat result and the legacy native-toFixed oracle.
 *
 * The parent parses sample stacks from each .cpuprofile. Inclusive attribution requires both each
 * exact function name and its registered source URL suffix, so identically named helpers in
 * dependencies cannot contaminate the result. Native `toFixed` is instead identified by an empty
 * source URL and enters the intended denominator only with an exact `adjustBaseStats@src/units/unit.ts`
 * or `roundUnitStat@src/units/stat_rounding.ts` caller; under-adjust coverage then detects loss of the
 * `adjustBaseStats` ancestor without contamination from unrelated native conversions.
 *
 * The fresh candidate contains the previously measured first-layer elision, so all of that seam's
 * attribution gates are rerun. The timing-excluded loader pass additionally proves one rounding
 * decision and one native oracle comparison per legacy conversion without contaminating CPU samples.
 *
 * Evidence run:
 *   bun docs/evidence/tools/a13_stat_rounding_near_grid_v5_profile.ts \
 *     --baseline-root=/tmp/common-baseline --candidate-root=/tmp/common-candidate \
 *     --out=/tmp/a13-stat-rounding-near-grid-profile.json
 *
 * Structural smoke (one capture and three repeats for stable attribution coverage; never marked qualified):
 *   bun docs/evidence/tools/a13_stat_rounding_near_grid_v5_profile.ts \
 *     --baseline-root=/tmp/common-baseline --candidate-root=/tmp/common-candidate \
 *     --smoke --out=/tmp/a13-stat-rounding-near-grid-profile-smoke.json
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

const SCHEMA = "heroes-of-crypto/a13-stat-rounding-near-grid-profile/v3" as const;
const CAPTURE_SCHEMA = "heroes-of-crypto/a13-stat-rounding-near-grid-capture/v2" as const;
const TELEMETRY_SCHEMA = "heroes-of-crypto/a13-stat-rounding-near-grid-telemetry/v2" as const;
const RUNNER_PATH = fileURLToPath(import.meta.url);
const AI_SOURCE_SUFFIX = "/src/ai/ai.ts";
const CATALOG_SOURCE_SUFFIX = "/src/ai/decision_path_catalog.ts";
const FUSED_SOURCE_SUFFIX = "/src/ai/internal/melee_target_layers.ts";
const UNIT_SOURCE_SUFFIX = "/src/units/unit.ts";
const ROUNDING_SOURCE_SUFFIX = "/src/units/stat_rounding.ts";
const BASELINE_COMMIT = "188452cad6ec718540b7c452a579ac3cea73a67f";
const CANDIDATE_COMMIT = "77ee4616688f764fcfe49d4a1b15ec19e1ef384e";
const BASELINE_SRC_MANIFEST_SHA256 = "73f78af822eace14fbe63c22115922732e0255b431a24403bc8ec794aaf98369";
const CANDIDATE_SRC_MANIFEST_SHA256 = "c7456047698a25c0c399ee8397b826615735df826bcc6713657a5b1cb08e7211";
const UNAVAILABLE_GIT_HEAD = "unavailable-source-root-without-git-metadata";
const EXPECTED_PACKAGE_JSON_SHA256 = "990a779e01b64fab88bdb72cb7fd6fa790eabc66a2f550d1e3481d620e1cf001";
const EXPECTED_TSCONFIG_JSON_SHA256 = "013d77997ebb76aabe5f12044db25f7eadf57565d2cd7670f2320b073972c383";
const EXPECTED_BUNFIG_TOML_SHA256 = "4a55c242db51f5ab64ce7df1ef8401f7815bd10ef28e42bf1a7d4f68168aa3cc";
const EXPECTED_WORKSPACE_LOCK_SHA256 = "227ac3cc87c8488dea87841311baf509e361c22610ffc0ee21c553245e58ab54";
const EXPECTED_BUN_EXECUTABLE_SHA256 = "e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233";
const EXPECTED_RUNTIME_DEPENDENCIES = Object.freeze({
    denque: {
        entryCount: 6,
        bytes: 30_361,
        manifestSha256: "56e571f695d1a01729ed0f0688c9e51990fb467b1392973c77cc57927e605531",
    },
    "google-protobuf": {
        entryCount: 17,
        bytes: 927_462,
        manifestSha256: "4ef936752035903b763562107050b45e230062f512c78ff1900e38d5de53ae52",
    },
});
const PROFILE_INTERVAL_US = 500;
const EVIDENCE_CAPTURES = 4;
const EVIDENCE_REPEATS = 9;
const SMOKE_CAPTURES = 1;
const SMOKE_REPEATS = 3;
const WARMUP_SEED = 9001;
const WARMUP_MAX_LAPS = 2;
const PROFILE_SEEDS = [1, 42, 43, 44, 45, 46] as const;
const PROFILE_MAX_LAPS = 4;
const AI_VERSION = "v0.8";
const MINIMUM_INFINITE_PARENT_REDUCTION = 0.5;
const MAXIMUM_CANDIDATE_COMBINED_BUILDER_SHARE = 0.03;
const MAXIMUM_NATIVE_TO_FIXED_UNDER_ADJUST_RATIO = 0.25;
const MAXIMUM_ADJUST_BASE_STATS_RATIO = 0.9;
const MAXIMUM_CANDIDATE_NATIVE_TO_FIXED_UNDER_ADJUST_SHARE = 0.01;
const MINIMUM_FAST_PATH_SHARE = 0.9;
const MINIMUM_BASELINE_FULL_BUILDER_UNDER_FIND_US_PER_CAPTURE = 10_000;
const MINIMUM_BASELINE_ADJUST_BASE_STATS_US_PER_CAPTURE = 50_000;
const MINIMUM_BASELINE_NATIVE_TO_FIXED_UNDER_ADJUST_US_PER_CAPTURE = 10_000;
const MINIMUM_NATIVE_TO_FIXED_UNDER_ADJUST_COVERAGE = 0.85;
const FORBIDDEN_INJECTION_ENVIRONMENT_KEYS = Object.freeze([
    "BUN_PRELOAD",
    "BUN_OPTIONS",
    "NODE_OPTIONS",
    "LD_PRELOAD",
    "HOC_BREAK_DEBUG",
]);
const FORBIDDEN_INJECTION_ENVIRONMENT_PREFIXES = Object.freeze([
    "DYLD_",
    "BUN_JSC_",
    "JSC_",
    "BUN_GC_",
    "MALLOC_",
    "Malloc",
]);
const REQUIRED_EXECUTION_ENVIRONMENT = Object.freeze({
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    LANG: "C.UTF-8",
    LC_ALL: "C",
    TZ: "UTC",
});
const FORBIDDEN_EXEC_ARGV_FLAGS = Object.freeze([
    "-r",
    "--require",
    "--import",
    "--loader",
    "--experimental-loader",
    "--preload",
]);
const CHILD_ENVIRONMENT_ALLOWLIST = Object.freeze([
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "USER",
    "LOGNAME",
    "SHELL",
    "TERM",
    "CI",
    "NO_COLOR",
    "FORCE_COLOR",
    "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
]);
const EXPECTED_NATIVE_FUNCTIONS = Object.freeze([
    {
        label: "Function.prototype.toString",
        name: "toString",
        length: 0,
        nativeSourceSha256: "14e89f65c8f615e78a921e427745d694c9be449421207ad27860575741ce6068",
    },
    {
        label: "Number",
        name: "Number",
        length: 1,
        nativeSourceSha256: "9a6eb610f91809c3ae9bb04ab9cbc0a97e471f64d02099e6993f1c981cabd8e5",
    },
    {
        label: "Number.prototype.toFixed",
        name: "toFixed",
        length: 1,
        nativeSourceSha256: "6fd2e7ec90562d96c2c0c3f428c78efb40938ac9dcd224ae2033edf6a676501e",
    },
    {
        label: "Number.isSafeInteger",
        name: "isSafeInteger",
        length: 1,
        nativeSourceSha256: "08f8fa7d0b5e9c917873a97efab3d3dc30e6e1fc8aa846edf32d3508de99735a",
    },
    {
        label: "Reflect.apply",
        name: "apply",
        length: 3,
        nativeSourceSha256: "ecf1a1a012a3f06a7dd0c0267e1f2be429aab7d64d29fc318e6acf733e554332",
    },
]);
const TARGET_FUNCTIONS = [
    "doFindTarget",
    "canElideUnconsumedMeleeLayers",
    "buildMeleeTargetLayers",
    "buildFirstMeleeTargetLayers",
    "appendSmallLayer",
    "appendBigLayer",
    "isFreeAt",
    "adjustBaseStats",
    "roundUnitStat",
    "nativeToFixed",
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
    "src/units/stat_rounding.ts",
    "src/units/unit.ts",
    "bunfig.toml",
    "package.json",
    "tsconfig.json",
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
    adjustBaseStats: UNIT_SOURCE_SUFFIX,
    roundUnitStat: ROUNDING_SOURCE_SUFFIX,
    nativeToFixed: "<native>",
} as const satisfies Readonly<Record<TargetFunction, string>>;
type RunMode = "evidence" | "smoke";

interface ISourceEntry {
    path: string;
    kind: "file" | "symlink";
    bytes: number;
    sha256: string;
}

interface IFileSeal {
    path: string;
    realPath: string;
    bytes: number;
    sha256: string;
}

interface IDirectorySeal {
    root: string;
    realRoot: string;
    entryCount: number;
    bytes: number;
    manifestSha256: string;
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
    tsconfigJson: IFileSeal;
    bunfigToml: IFileSeal;
    workspaceLock: {
        path: string;
        bytes: number;
        sha256: string;
    };
    runtimeDependencies: Record<keyof typeof EXPECTED_RUNTIME_DEPENDENCIES, IDirectorySeal>;
    bunExecutable: IFileSeal;
    dependencySeal: {
        sealed: true;
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
    attemptId: string;
    variant: "baseline" | "candidate";
    capture: number;
    intervalMicroseconds: number;
    environment: Record<string, string>;
    realm: {
        runtimeInjection: Record<string, unknown>;
        before: Record<string, unknown>;
        after: Record<string, unknown>;
        unchanged: true;
    };
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

interface ITelemetryCounts {
    fullBuilder: number;
    firstBuilder: number;
    adjustBaseStats: number;
    legacyConversions: number;
    calls: number;
    fast: number;
    exactGridFast: number;
    nearGridFast: number;
    nearGridNegativeZero: number;
    numericFallback: number;
    dynamicFallback: number;
    oracleChecks: number;
    mismatches: number;
    oracleDepth: number;
    adjustDepth: number;
}

interface ITelemetryMetadata {
    schema: typeof TELEMETRY_SCHEMA;
    attemptId: string;
    variant: "baseline" | "candidate";
    sourceBefore: ISourceSeal;
    sourceAfter: ISourceSeal;
    sourceUnchanged: true;
    realm: {
        runtimeInjection: Record<string, unknown>;
        before: Record<string, unknown>;
        after: Record<string, unknown>;
        unchanged: true;
    };
    instrumentation: {
        traceOnly: true;
        runnerSha256: string;
        sourcePath: string;
        sourceSha256: string;
        transformedSha256: string;
        unitSourcePath: string;
        unitSourceSha256: string;
        transformedUnitSha256: string;
        roundingSourcePath: string | null;
        roundingSourceSha256: string | null;
        transformedRoundingSha256: string | null;
        fullBuilderReplacements: 1;
        firstBuilderReplacements: 0 | 1;
        adjustBaseStatsReplacements: 1;
        roundUnitStatReplacements: 0 | 1;
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
    counts: ITelemetryCounts;
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
    underAdjustBaseStatsSampledMicroseconds: number;
    underAdjustBaseStatsShare: number;
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

interface INativeFunctionLocation {
    label: string;
    owner: object;
    key: string;
    value: CallableFunction;
}

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

function canonicalize(value: unknown): unknown {
    if (value === null) return ["null"];
    if (typeof value === "string") return ["string", value];
    if (typeof value === "boolean") return ["boolean", value];
    if (typeof value === "number") {
        if (Number.isNaN(value)) return ["number", "NaN"];
        if (value === Number.POSITIVE_INFINITY) return ["number", "+Infinity"];
        if (value === Number.NEGATIVE_INFINITY) return ["number", "-Infinity"];
        if (Object.is(value, -0)) return ["number", "-0"];
        return ["number", value];
    }
    if (typeof value === "bigint") return ["bigint", value.toString()];
    if (typeof value === "undefined") return ["undefined"];
    if (Array.isArray(value)) return ["array", value.map(canonicalize)];
    if (value instanceof Map) {
        return [
            "map",
            [...value.entries()]
                .map(([key, item]) => [canonicalize(key), canonicalize(item)])
                .sort((left, right) => JSON.stringify(left[0]).localeCompare(JSON.stringify(right[0]))),
        ];
    }
    if (value instanceof Set) {
        return [
            "set",
            [...value.values()]
                .map(canonicalize)
                .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
        ];
    }
    if (typeof value === "object") {
        return [
            "object",
            Object.keys(value as Record<string, unknown>)
                .sort()
                .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
        ];
    }
    return [typeof value, String(value)];
}

const canonicalJson = (value: unknown): string => JSON.stringify(canonicalize(value));
const digest = (value: unknown): string => sha256(canonicalJson(value));

function normalizedPath(path: string): string {
    return path.split(sep).join("/");
}

function protocolManifestDigest(entries: readonly ISourceEntry[]): string {
    return sha256(
        JSON.stringify(
            entries.map((entry) => ({
                bytes: entry.bytes,
                kind: entry.kind,
                path: entry.path,
                sha256: entry.sha256,
            })),
        ),
    );
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

function fileSeal(pathInput: string): IFileSeal {
    const path = resolve(pathInput);
    const bytes = readFileSync(path);
    return {
        path,
        realPath: realpathSync(path),
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
    };
}

function directorySeal(pathInput: string): IDirectorySeal {
    const root = resolve(pathInput);
    const realRoot = realpathSync(root);
    const entries: ISourceEntry[] = [];
    collectSourceEntries(realRoot, realRoot, entries);
    entries.sort((left, right) => left.path.localeCompare(right.path));
    return {
        root,
        realRoot,
        entryCount: entries.length,
        bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
        manifestSha256: protocolManifestDigest(entries),
    };
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
    collectSourceEntries(sourceRoot, sourceRoot, entries);
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
        srcManifestSha256: protocolManifestDigest(entries),
        selectedSha256,
        tsconfigJson: fileSeal(join(root, "tsconfig.json")),
        bunfigToml: fileSeal(join(root, "bunfig.toml")),
        workspaceLock: {
            path: normalizedPath(relative(root, workspaceLockPath)),
            bytes: workspaceLockStats.size,
            sha256: sha256(readFileSync(workspaceLockPath)),
        },
        runtimeDependencies: {
            denque: directorySeal(join(root, "node_modules/denque")),
            "google-protobuf": directorySeal(join(root, "node_modules/google-protobuf")),
        },
        bunExecutable: fileSeal(process.execPath),
        dependencySeal: {
            sealed: true as const,
            commonNodeModulesRealPath,
            workspaceNodeModulesRealPath: realpathSync(workspaceNodeModulesPath),
            limitation:
                "The full denque and google-protobuf dependency trees used by this workload are recursively sealed; " +
                "other installed dependency trees are outside this runtime workload seal.",
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

function assertExpectedImmutableSource(
    seal: ISourceSeal,
    label: "baseline" | "candidate",
    expectedCommit: string,
    expectedSrcManifestSha256: string,
): void {
    if (seal.srcManifestSha256 !== expectedSrcManifestSha256) {
        throw new Error(
            `${label} source manifest is not the preregistered ${expectedCommit} tree: ` +
                `expected=${expectedSrcManifestSha256} actual=${seal.srcManifestSha256}`,
        );
    }
    if (seal.gitHead !== UNAVAILABLE_GIT_HEAD && seal.gitHead !== expectedCommit) {
        throw new Error(`${label} git HEAD mismatch: expected=${expectedCommit} actual=${seal.gitHead}`);
    }
}

function assertPinnedRuntimeInputs(seal: ISourceSeal, label: "baseline" | "candidate"): void {
    const observed = {
        packageJsonSha256: seal.selectedSha256["package.json"],
        tsconfigJsonSha256: seal.tsconfigJson.sha256,
        bunfigTomlSha256: seal.bunfigToml.sha256,
        workspaceLockSha256: seal.workspaceLock.sha256,
        bunExecutableSha256: seal.bunExecutable.sha256,
    };
    const expected = {
        packageJsonSha256: EXPECTED_PACKAGE_JSON_SHA256,
        tsconfigJsonSha256: EXPECTED_TSCONFIG_JSON_SHA256,
        bunfigTomlSha256: EXPECTED_BUNFIG_TOML_SHA256,
        workspaceLockSha256: EXPECTED_WORKSPACE_LOCK_SHA256,
        bunExecutableSha256: EXPECTED_BUN_EXECUTABLE_SHA256,
    };
    if (canonicalJson(observed) !== canonicalJson(expected)) {
        throw new Error(`${label} pinned runtime input mismatch: ${canonicalJson({ expected, observed })}`);
    }
    for (const dependency of Object.keys(EXPECTED_RUNTIME_DEPENDENCIES) as Array<
        keyof typeof EXPECTED_RUNTIME_DEPENDENCIES
    >) {
        const actual = seal.runtimeDependencies[dependency];
        const expectedDependency = EXPECTED_RUNTIME_DEPENDENCIES[dependency];
        if (
            actual.entryCount !== expectedDependency.entryCount ||
            actual.bytes !== expectedDependency.bytes ||
            actual.manifestSha256 !== expectedDependency.manifestSha256
        ) {
            throw new Error(
                `${label} ${dependency} dependency seal mismatch: ` +
                    canonicalJson({ expected: expectedDependency, actual }),
            );
        }
    }
}

const EXPECTED_SOURCE_DELTA = Object.freeze([
    { path: "ai/ai.ts", change: "modified" },
    { path: "ai/decision_path_catalog.ts", change: "modified" },
    { path: "ai/internal/melee_target_layers.ts", change: "modified" },
    { path: "units/stat_rounding.ts", change: "added" },
    { path: "units/unit.ts", change: "modified" },
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

function auditRuntimeInjection(): Record<string, unknown> {
    const environmentKeys = Object.keys(process.env).sort();
    const presentEnvironmentKeys = environmentKeys.filter(
        (key) =>
            FORBIDDEN_INJECTION_ENVIRONMENT_KEYS.includes(
                key as (typeof FORBIDDEN_INJECTION_ENVIRONMENT_KEYS)[number],
            ) || FORBIDDEN_INJECTION_ENVIRONMENT_PREFIXES.some((prefix) => key.startsWith(prefix)),
    );
    const execArgv = [...process.execArgv];
    const governedEnvironment = Object.fromEntries(
        Object.keys(REQUIRED_EXECUTION_ENVIRONMENT)
            .sort()
            .map((key) => [key, process.env[key] ?? null]),
    );
    if (
        presentEnvironmentKeys.length > 0 ||
        execArgv.length > 0 ||
        canonicalJson(governedEnvironment) !== canonicalJson(REQUIRED_EXECUTION_ENVIRONMENT)
    ) {
        throw new Error(
            `Runtime injection audit failed: environment=${presentEnvironmentKeys.join(",")} ` +
                `execArgv=${execArgv.join(",")} governed=${canonicalJson(governedEnvironment)}`,
        );
    }
    return {
        passed: true,
        forbiddenEnvironmentKeys: FORBIDDEN_INJECTION_ENVIRONMENT_KEYS,
        forbiddenEnvironmentPrefixes: FORBIDDEN_INJECTION_ENVIRONMENT_PREFIXES,
        presentEnvironmentKeys,
        forbiddenExecArgvFlags: FORBIDDEN_EXEC_ARGV_FLAGS,
        execArgv,
        execArgvExactlyEmpty: true,
        requiredExecutionEnvironment: REQUIRED_EXECUTION_ENVIRONMENT,
        governedEnvironment,
    };
}

function auditStandardNumericRealm(): Record<string, unknown> {
    const locations: INativeFunctionLocation[] = [
        {
            label: "Function.prototype.toString",
            owner: Function.prototype,
            key: "toString",
            value: Function.prototype.toString,
        },
        { label: "Number", owner: globalThis, key: "Number", value: Number },
        {
            label: "Number.prototype.toFixed",
            owner: Number.prototype,
            key: "toFixed",
            value: Number.prototype.toFixed,
        },
        {
            label: "Number.isSafeInteger",
            owner: Number,
            key: "isSafeInteger",
            value: Number.isSafeInteger,
        },
        { label: "Reflect.apply", owner: Reflect, key: "apply", value: Reflect.apply },
    ];
    const functions = locations.map((location, index) => {
        const expected = EXPECTED_NATIVE_FUNCTIONS[index];
        if (location.label !== expected.label) throw new Error(`Realm audit definition drift at ${location.label}`);
        const descriptor = Object.getOwnPropertyDescriptor(location.owner, location.key);
        if (
            !descriptor ||
            descriptor.value !== location.value ||
            descriptor.writable !== true ||
            descriptor.enumerable !== false ||
            descriptor.configurable !== true ||
            descriptor.get !== undefined ||
            descriptor.set !== undefined ||
            location.value.name !== expected.name ||
            location.value.length !== expected.length
        ) {
            throw new Error(`Non-standard descriptor for ${location.label}`);
        }
        const nativeSource = Function.prototype.toString.call(location.value);
        const nativeSourceSha256 = sha256(nativeSource);
        if (!nativeSource.includes("[native code]") || nativeSourceSha256 !== expected.nativeSourceSha256) {
            throw new Error(`Non-standard native implementation for ${location.label}`);
        }
        return {
            label: location.label,
            name: location.value.name,
            length: location.value.length,
            descriptor: { writable: true, enumerable: false, configurable: true, data: true },
            nativeMarker: true,
            nativeSourceSha256,
        };
    });
    return {
        passed: true,
        standardDescriptorsVerified: true,
        nativeFunctionSourcesVerified: true,
        functions,
    };
}

function assertSameRealm(expected: Record<string, unknown>, actual: Record<string, unknown>, phase: string): void {
    if (canonicalJson(expected) !== canonicalJson(actual)) {
        throw new Error(`Numeric realm intrinsics changed during ${phase}`);
    }
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
    auditRuntimeInjection();
    const environment: Record<string, string> = {};
    for (const key of CHILD_ENVIRONMENT_ALLOWLIST) {
        const value = process.env[key];
        if (value !== undefined) environment[key] = value;
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

function requireAttemptId(value: string | undefined): string {
    if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
        throw new Error("--attempt-id must be a lowercase UUIDv4");
    }
    return value;
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
            "attempt-id": { type: "string" },
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
        !values["attempt-id"] ||
        !values["source-root"] ||
        !values.capture ||
        !values.repeats ||
        !values.profile ||
        !values.metadata
    ) {
        throw new Error(
            "Internal capture requires --attempt-id, baseline/candidate --variant, --source-root, " +
                "--capture, --repeats, --profile, and --metadata",
        );
    }
    const attemptId = requireAttemptId(values["attempt-id"]);
    const variant = values.variant;
    const sourceRoot = resolve(values["source-root"]);
    const capture = positiveInteger(values.capture, "--capture");
    const repeats = positiveInteger(values.repeats, "--repeats");
    const profilePath = resolve(values.profile);
    const metadataPath = resolve(values.metadata);
    if (existsSync(profilePath) || existsSync(metadataPath)) {
        throw new Error(`Refusing to overwrite capture ${capture} output`);
    }

    const runtimeInjectionBefore = auditRuntimeInjection();
    const realmBefore = auditStandardNumericRealm();
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
    const realmAfter = auditStandardNumericRealm();
    assertSameRealm(realmBefore, realmAfter, `capture ${capture}`);
    const runtimeInjectionAfter = auditRuntimeInjection();
    if (canonicalJson(runtimeInjectionBefore) !== canonicalJson(runtimeInjectionAfter)) {
        throw new Error(`Runtime execution environment changed during capture ${capture}`);
    }
    const profileStats = statSync(profilePath);
    const metadata: ICaptureMetadata = {
        schema: CAPTURE_SCHEMA,
        attemptId,
        variant,
        capture,
        intervalMicroseconds: PROFILE_INTERVAL_US,
        environment,
        realm: {
            runtimeInjection: {
                before: runtimeInjectionBefore,
                after: runtimeInjectionAfter,
                unchanged: true,
            },
            before: realmBefore,
            after: realmAfter,
            unchanged: true,
        },
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

const TELEMETRY_KEY = "__hocA13StatRoundingTelemetry" as const;

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
        `\n    (globalThis as unknown as { ${TELEMETRY_KEY}: { fullBuilder: number; firstBuilder: number } })` +
        `.${TELEMETRY_KEY}.${field}++;`;
    return {
        source: `${source.slice(0, insertionIndex)}${counter}${source.slice(insertionIndex)}`,
        replacements: 1,
    };
}

function injectAdjustBaseStatsTelemetry(source: string): { source: string; replacements: 1 } {
    const signature = "    public adjustBaseStats(";
    const signatureIndex = source.indexOf(signature);
    if (signatureIndex < 0 || source.indexOf(signature, signatureIndex + signature.length) >= 0) {
        throw new Error("adjustBaseStats instrumentation target must occur exactly once");
    }
    const bodyMarker = "\n    ) {\n";
    const bodyIndex = source.indexOf(bodyMarker, signatureIndex + signature.length);
    if (bodyIndex < 0) throw new Error("adjustBaseStats body marker is absent");
    const bodyInsertion = bodyIndex + bodyMarker.length;
    const nextMethodMarker = "\n    public setRangeShotDistance(";
    const nextMethodIndex = source.indexOf(nextMethodMarker, bodyInsertion);
    if (nextMethodIndex < 0) throw new Error("adjustBaseStats successor marker is absent");
    const closingMarker = "\n    }";
    const closingIndex = source.lastIndexOf(closingMarker, nextMethodIndex);
    if (closingIndex < bodyInsertion) throw new Error("adjustBaseStats closing marker is absent");
    const opening =
        `        const __hocStatTelemetry = (globalThis as unknown as { ${TELEMETRY_KEY}: ` +
        "{ adjustBaseStats: number; adjustDepth: number } })." +
        `${TELEMETRY_KEY};\n` +
        "        __hocStatTelemetry.adjustBaseStats++;\n" +
        "        __hocStatTelemetry.adjustDepth++;\n" +
        "        try {\n";
    const closing = "\n        } finally {\n" + "            __hocStatTelemetry.adjustDepth--;\n" + "        }";
    return {
        source:
            source.slice(0, bodyInsertion) +
            opening +
            source.slice(bodyInsertion, closingIndex) +
            closing +
            source.slice(closingIndex),
        replacements: 1,
    };
}

function injectRoundUnitStatTelemetry(source: string): { source: string; replacements: 1 } {
    const signature = "export function roundUnitStat(";
    const signatureIndex = source.indexOf(signature);
    if (signatureIndex < 0 || source.indexOf(signature, signatureIndex + signature.length) >= 0) {
        throw new Error("roundUnitStat instrumentation target must occur exactly once");
    }
    const renamed = `${source.slice(0, signatureIndex)}function roundUnitStatMeasuredImplementation(${source.slice(
        signatureIndex + signature.length,
    )}`;
    const wrapper = `

export function roundUnitStat(value: number, fractionDigits: UnitStatFractionDigits): number {
    const telemetry = (globalThis as unknown as {
        ${TELEMETRY_KEY}: {
            calls: number;
            fast: number;
            exactGridFast: number;
            nearGridFast: number;
            nearGridNegativeZero: number;
            numericFallback: number;
            dynamicFallback: number;
            oracleChecks: number;
            mismatches: number;
            oracleDepth: number;
        };
    }).${TELEMETRY_KEY};
    telemetry.calls++;

    const numberConstructor = Number;
    const toFixed = value.toFixed;
    let classification: "exactGridFast" | "nearGridFast" | "numericFallback" | "dynamicFallback";
    if (
        typeof value !== "number" ||
        toFixed !== INTRINSIC_TO_FIXED ||
        numberConstructor !== INTRINSIC_NUMBER ||
        (fractionDigits !== 1 && fractionDigits !== 2)
    ) {
        classification = "dynamicFallback";
    } else {
        const scale = fractionDigits === 1 ? 10 : 100;
        const scaled = value * scale;
        const exactGrid =
            INTRINSIC_NUMBER_IS_SAFE_INTEGER(scaled) &&
            scaled >= -MAX_EXACT_SCALED_INTEGER &&
            scaled <= MAX_EXACT_SCALED_INTEGER &&
            scaled / scale === value;
        if (exactGrid) {
            classification = "exactGridFast";
        } else if (scaled > -NEAR_GRID_SCALED_LIMIT && scaled < NEAR_GRID_SCALED_LIMIT) {
            const nearestScaledInteger = scaled < 0 ? (scaled - 0.5) | 0 : (scaled + 0.5) | 0;
            const distance = scaled - nearestScaledInteger;
            if (distance > -NEAR_GRID_MAX_DISTANCE && distance < NEAR_GRID_MAX_DISTANCE) {
                classification = "nearGridFast";
                if (nearestScaledInteger === 0 && value < 0) telemetry.nearGridNegativeZero++;
            } else {
                classification = "numericFallback";
            }
        } else {
            classification = "numericFallback";
        }
    }
    telemetry[classification]++;
    if (classification === "exactGridFast" || classification === "nearGridFast") telemetry.fast++;

    const actual = roundUnitStatMeasuredImplementation(value, fractionDigits);
    telemetry.oracleDepth++;
    let oracle: number;
    try {
        oracle = numberConstructor(INTRINSIC_APPLY(toFixed, value, [fractionDigits]));
    } finally {
        telemetry.oracleDepth--;
    }
    telemetry.oracleChecks++;
    if (!Object.is(actual, oracle)) telemetry.mismatches++;
    return actual;
}
`;
    return { source: `${renamed.trimEnd()}${wrapper}`, replacements: 1 };
}

function installNativeToFixedTelemetry(counts: ITelemetryCounts): () => void {
    const descriptor = Object.getOwnPropertyDescriptor(Number.prototype, "toFixed");
    const original = Number.prototype.toFixed;
    if (!descriptor || typeof original !== "function") {
        throw new Error("Number.prototype.toFixed is not the expected callable own property");
    }
    const wrapped = function toFixed(this: number, fractionDigits?: number): string {
        if (counts.adjustDepth > 0 && counts.oracleDepth === 0) counts.legacyConversions++;
        return Reflect.apply(original, this, [fractionDigits]);
    };
    Object.defineProperty(Number.prototype, "toFixed", {
        ...descriptor,
        value: wrapped,
    });
    return () => {
        const current = Object.getOwnPropertyDescriptor(Number.prototype, "toFixed");
        if (!current || current.value !== wrapped) {
            throw new Error("Number.prototype.toFixed telemetry wrapper changed before restoration");
        }
        Object.defineProperty(Number.prototype, "toFixed", descriptor);
    };
}

async function telemetryMain(args: string[]): Promise<void> {
    const { values } = parseArgs({
        args,
        strict: true,
        allowPositionals: false,
        options: {
            "attempt-id": { type: "string" },
            variant: { type: "string" },
            "source-root": { type: "string" },
            metadata: { type: "string" },
        },
    });
    if (
        (values.variant !== "baseline" && values.variant !== "candidate") ||
        !values["attempt-id"] ||
        !values["source-root"] ||
        !values.metadata
    ) {
        throw new Error(
            "Internal telemetry requires --attempt-id, baseline/candidate --variant, --source-root, and --metadata",
        );
    }
    const attemptId = requireAttemptId(values["attempt-id"]);
    const variant = values.variant;
    const sourceRoot = resolve(values["source-root"]);
    const metadataPath = resolve(values.metadata);
    if (existsSync(metadataPath)) throw new Error(`Refusing to overwrite telemetry metadata: ${metadataPath}`);
    const runtimeInjectionBefore = auditRuntimeInjection();
    const realmBefore = auditStandardNumericRealm();
    installFixedEnvironment();
    const preciseCoverageError = await preciseCoverageUnsupported();
    const sourceBefore = sourceSeal(sourceRoot);
    const layerPath = join(sourceRoot, "src/ai/internal/melee_target_layers.ts");
    const unitPath = join(sourceRoot, "src/units/unit.ts");
    const roundingPath = join(sourceRoot, "src/units/stat_rounding.ts");
    const originalLayer = readFileSync(layerPath, "utf8");
    const originalUnit = readFileSync(unitPath, "utf8");
    const originalRounding = variant === "candidate" ? readFileSync(roundingPath, "utf8") : null;
    const full = injectCallCounter(originalLayer, "buildMeleeTargetLayers", "fullBuilder", true);
    const first = injectCallCounter(
        full.source,
        "buildFirstMeleeTargetLayers",
        "firstBuilder",
        variant === "candidate",
    );
    if (full.replacements !== 1) throw new Error("Full-builder instrumentation replacement count drift");
    const adjusted = injectAdjustBaseStatsTelemetry(originalUnit);
    const rounded = originalRounding ? injectRoundUnitStatTelemetry(originalRounding) : null;
    const counters: ITelemetryCounts = {
        fullBuilder: 0,
        firstBuilder: 0,
        adjustBaseStats: 0,
        legacyConversions: 0,
        calls: 0,
        fast: 0,
        exactGridFast: 0,
        nearGridFast: 0,
        nearGridNegativeZero: 0,
        numericFallback: 0,
        dynamicFallback: 0,
        oracleChecks: 0,
        mismatches: 0,
        oracleDepth: 0,
        adjustDepth: 0,
    };
    (globalThis as unknown as { [TELEMETRY_KEY]: ITelemetryCounts })[TELEMETRY_KEY] = counters;
    const restoreNativeToFixed = installNativeToFixedTelemetry(counters);
    Bun.plugin({
        name: `a13-stat-rounding-near-grid-telemetry-${variant}-${process.pid}`,
        setup(build): void {
            build.onLoad({ filter: /[/\\]ai[/\\]internal[/\\]melee_target_layers\.ts$/ }, () => {
                return { contents: first.source, loader: "ts" };
            });
            build.onLoad({ filter: /[/\\]units[/\\]unit\.ts$/ }, () => {
                return { contents: adjusted.source, loader: "ts" };
            });
            if (rounded) {
                build.onLoad({ filter: /[/\\]units[/\\]stat_rounding\.ts$/ }, () => {
                    return { contents: rounded.source, loader: "ts" };
                });
            }
        },
    });
    const importNonce = `telemetry-${variant}-${process.pid}`;
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
        assertHealthyResult(result, `telemetry variant=${variant} seed=${seed}`);
        return result;
    };
    runSeed(WARMUP_SEED, WARMUP_MAX_LAPS);
    for (const key of Object.keys(counters) as (keyof ITelemetryCounts)[]) counters[key] = 0;
    const results = PROFILE_SEEDS.map((seed) => runSeed(seed, PROFILE_MAX_LAPS));
    if (counters.adjustDepth !== 0 || counters.oracleDepth !== 0) {
        throw new Error(
            `Unbalanced telemetry depth after workload: adjust=${counters.adjustDepth} oracle=${counters.oracleDepth}`,
        );
    }
    restoreNativeToFixed();
    const realmAfter = auditStandardNumericRealm();
    assertSameRealm(realmBefore, realmAfter, `${variant} timing-excluded telemetry`);
    const runtimeInjectionAfter = auditRuntimeInjection();
    if (canonicalJson(runtimeInjectionBefore) !== canonicalJson(runtimeInjectionAfter)) {
        throw new Error(`Runtime execution environment changed during ${variant} telemetry`);
    }
    const sourceAfter = sourceSeal(sourceRoot);
    assertSameSource(sourceBefore, sourceAfter, `${variant} timing-excluded telemetry`);
    const metadata: ITelemetryMetadata = {
        schema: TELEMETRY_SCHEMA,
        attemptId,
        variant,
        sourceBefore,
        sourceAfter,
        sourceUnchanged: true,
        realm: {
            runtimeInjection: {
                before: runtimeInjectionBefore,
                after: runtimeInjectionAfter,
                unchanged: true,
            },
            before: realmBefore,
            after: realmAfter,
            unchanged: true,
        },
        instrumentation: {
            traceOnly: true,
            runnerSha256: sha256(readFileSync(RUNNER_PATH)),
            sourcePath: normalizedPath(relative(sourceRoot, layerPath)),
            sourceSha256: sha256(originalLayer),
            transformedSha256: sha256(first.source),
            unitSourcePath: normalizedPath(relative(sourceRoot, unitPath)),
            unitSourceSha256: sha256(originalUnit),
            transformedUnitSha256: sha256(adjusted.source),
            roundingSourcePath: originalRounding ? normalizedPath(relative(sourceRoot, roundingPath)) : null,
            roundingSourceSha256: originalRounding ? sha256(originalRounding) : null,
            transformedRoundingSha256: rounded ? sha256(rounded.source) : null,
            fullBuilderReplacements: full.replacements,
            firstBuilderReplacements: first.replacements,
            adjustBaseStatsReplacements: adjusted.replacements,
            roundUnitStatReplacements: rounded?.replacements ?? 0,
            profilerPreciseCoverageUnavailable: true,
            limitation:
                `Inspector Profiler.startPreciseCoverage rejected this process with '${preciseCoverageError}'. ` +
                "A separate, timing-excluded loader pass wraps adjustBaseStats and the realm's native toFixed, " +
                "instruments both melee builders symmetrically, and wraps only the candidate roundUnitStat. " +
                "Every optimized result is checked against the legacy native conversion. Its action/result " +
                "digests must match the uninstrumented profiles; no timing is read from this pass.",
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
        counts: { ...counters },
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
    if (name === "nativeToFixed") {
        return frame?.functionName === "toFixed" && normalizedSourceUrl(frame.url) === "";
    }
    return frame?.functionName === name && normalizedSourceUrl(frame.url).endsWith(targetSourceSuffix(name));
}

function isContextualTargetFrame(stack: readonly IProfileNode[], index: number, name: TargetFunction): boolean {
    if (!isExactTargetFrame(stack[index]?.callFrame, name)) return false;
    if (name !== "nativeToFixed") return true;
    return stack
        .slice(index + 1)
        .some(
            (node) =>
                isExactTargetFrame(node.callFrame, "adjustBaseStats") ||
                isExactTargetFrame(node.callFrame, "roundUnitStat"),
        );
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
    const underAdjustBaseStats = Object.fromEntries(TARGET_FUNCTIONS.map((name) => [name, 0])) as Record<
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
                if (isContextualTargetFrame(stack, index, name)) matchingIndexes.push(index);
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
            if (
                name === "adjustBaseStats" ||
                stack.slice(outermostIndex + 1).some((node) => isExactTargetFrame(node.callFrame, "adjustBaseStats"))
            ) {
                underAdjustBaseStats[name] += delta;
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
            underAdjustBaseStatsSampledMicroseconds: underAdjustBaseStats[name],
            underAdjustBaseStatsShare: underAdjustBaseStats[name] / totalSampledMicroseconds,
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
        metadata.workload.aiVersion !== AI_VERSION ||
        metadata.realm?.unchanged !== true
    ) {
        throw new Error(`Capture metadata contract drift: ${path}`);
    }
    return metadata;
}

async function runChildCapture(
    attemptId: string,
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
            `--attempt-id=${attemptId}`,
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

async function runChildTelemetry(
    attemptId: string,
    variant: "baseline" | "candidate",
    sourceRoot: string,
    metadataPath: string,
): Promise<void> {
    const child = Bun.spawn({
        cmd: [
            process.execPath,
            RUNNER_PATH,
            "telemetry",
            `--attempt-id=${attemptId}`,
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
            `${variant} telemetry failed with exit ${exitCode}${stderr.trim() ? `:\n${stderr.trim()}` : ""}`,
        );
    }
    if (stderr.trim()) process.stderr.write(stderr);
}

function readTelemetryMetadata(path: string, variant: "baseline" | "candidate"): ITelemetryMetadata {
    const metadata = JSON.parse(readFileSync(path, "utf8")) as ITelemetryMetadata;
    if (
        metadata.schema !== TELEMETRY_SCHEMA ||
        metadata.variant !== variant ||
        metadata.workload.matches !== PROFILE_SEEDS.length ||
        metadata.realm?.unchanged !== true
    ) {
        throw new Error(`Telemetry metadata contract drift: ${path}`);
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
        requiredExecutionEnvironment: REQUIRED_EXECUTION_ENVIRONMENT,
        governedEnvironment: Object.fromEntries(
            Object.keys(REQUIRED_EXECUTION_ENVIRONMENT)
                .sort()
                .map((key) => [key, process.env[key] ?? null]),
        ),
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
        let underAdjustBaseStatsSampledMicroseconds = 0;
        let exclusiveSampledMicroseconds = 0;
        const stacks = new Map<string, number>();
        for (const capture of captures) {
            const item = capture.attribution.functions[name];
            for (const nodeId of item.matchedNodeIds) matchedNodeIds.add(nodeId);
            inclusiveSampledMicroseconds += item.inclusiveSampledMicroseconds;
            underDoFindTargetSampledMicroseconds += item.underDoFindTargetSampledMicroseconds;
            underAdjustBaseStatsSampledMicroseconds += item.underAdjustBaseStatsSampledMicroseconds;
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
            underAdjustBaseStatsSampledMicroseconds,
            underAdjustBaseStatsShare: underAdjustBaseStatsSampledMicroseconds / totalSampledMicroseconds,
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
            "attempt-id": { type: "string" },
            "baseline-root": { type: "string" },
            "candidate-root": { type: "string" },
            out: { type: "string" },
            smoke: { type: "boolean", default: false },
            help: { type: "boolean", default: false },
        },
    });
    if (values.help) {
        console.log(
            "Usage: bun docs/evidence/tools/a13_stat_rounding_near_grid_v5_profile.ts " +
                "--attempt-id=UUID --baseline-root=ROOT --candidate-root=ROOT --out=REPORT.json [--smoke]",
        );
        return;
    }
    if (!values["attempt-id"] || !values["baseline-root"] || !values["candidate-root"] || !values.out) {
        throw new Error("--attempt-id, --baseline-root, --candidate-root, and --out are required");
    }
    const attemptId = requireAttemptId(values["attempt-id"]);
    const baselineRoot = resolve(values["baseline-root"]);
    const candidateRoot = resolve(values["candidate-root"]);
    if (realpathSync(baselineRoot) === realpathSync(candidateRoot)) {
        throw new Error("Baseline and candidate roots must be distinct");
    }
    const parentRuntimeInjectionBefore = auditRuntimeInjection();
    const parentRealmBefore = auditStandardNumericRealm();
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
    assertExpectedImmutableSource(sourceBefore.baseline, "baseline", BASELINE_COMMIT, BASELINE_SRC_MANIFEST_SHA256);
    assertExpectedImmutableSource(sourceBefore.candidate, "candidate", CANDIDATE_COMMIT, CANDIDATE_SRC_MANIFEST_SHA256);
    assertPinnedRuntimeInputs(sourceBefore.baseline, "baseline");
    assertPinnedRuntimeInputs(sourceBefore.candidate, "candidate");
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
        tsconfigJsonSha256: sourceBefore.baseline.tsconfigJson.sha256,
        bunfigTomlSha256: sourceBefore.baseline.bunfigToml.sha256,
        workspaceLockSha256: sourceBefore.baseline.workspaceLock.sha256,
        bunExecutableSha256: sourceBefore.baseline.bunExecutable.sha256,
        runtimeDependencies: Object.fromEntries(
            Object.entries(sourceBefore.baseline.runtimeDependencies).map(([name, seal]) => [
                name,
                {
                    entryCount: seal.entryCount,
                    bytes: seal.bytes,
                    manifestSha256: seal.manifestSha256,
                },
            ]),
        ),
        commonNodeModulesRealPath: sourceBefore.baseline.dependencySeal.commonNodeModulesRealPath,
        workspaceNodeModulesRealPath: sourceBefore.baseline.dependencySeal.workspaceNodeModulesRealPath,
    };
    const delta = sourceDelta(baselineRoot, candidateRoot);
    const temporaryRoot = mkdtempSync(join(tmpdir(), "hoc-a13-stat-rounding-near-grid-profile-"));
    const captures: Record<"baseline" | "candidate", ICaptureReport[]> = {
        baseline: [],
        candidate: [],
    };
    const telemetry = {} as Record<"baseline" | "candidate", ITelemetryMetadata>;
    const metadataRows: ICaptureMetadata[] = [];
    try {
        for (const variant of ["baseline", "candidate"] as const) {
            const sourceRoot = variant === "baseline" ? baselineRoot : candidateRoot;
            const metadataPath = join(temporaryRoot, `${variant}-telemetry.workload.json`);
            await runChildTelemetry(attemptId, variant, sourceRoot, metadataPath);
            const metadata = readTelemetryMetadata(metadataPath, variant);
            if (metadata.attemptId !== attemptId) throw new Error(`${variant} telemetry attempt binding mismatch`);
            assertSameSource(sourceBefore[variant], metadata.sourceBefore, `${variant} telemetry preflight`);
            assertSameSource(sourceBefore[variant], metadata.sourceAfter, `${variant} telemetry postflight`);
            if (metadata.instrumentation.runnerSha256 !== sha256(readFileSync(RUNNER_PATH))) {
                throw new Error(`${variant} telemetry transform runner hash mismatch`);
            }
            telemetry[variant] = metadata;
        }
        for (let capture = 1; capture <= captureCount; capture += 1) {
            const order = captureVariantOrder(capture);
            for (const variant of order) {
                const sourceRoot = variant === "baseline" ? baselineRoot : candidateRoot;
                const profileName = `${variant}-capture-${capture}.cpuprofile`;
                const metadataName = `${variant}-capture-${capture}.workload.json`;
                const profilePath = join(temporaryRoot, profileName);
                const metadataPath = join(temporaryRoot, metadataName);
                await runChildCapture(attemptId, variant, sourceRoot, capture, repeats, profilePath, metadataPath);
                const metadata = readCaptureMetadata(metadataPath);
                if (
                    metadata.attemptId !== attemptId ||
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
        const parentRealmAfter = auditStandardNumericRealm();
        assertSameRealm(parentRealmBefore, parentRealmAfter, "parent orchestration");
        const parentRuntimeInjectionAfter = auditRuntimeInjection();
        if (canonicalJson(parentRuntimeInjectionBefore) !== canonicalJson(parentRuntimeInjectionAfter)) {
            throw new Error("Parent runtime execution environment changed during profile orchestration");
        }
        const childRealmPassed =
            metadataRows.every((metadata) => metadata.realm.unchanged) &&
            (["baseline", "candidate"] as const).every((variant) => telemetry[variant].realm.unchanged);
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
        const warmupSemanticsPassed =
            metadataRows.length === captureCount * 2 &&
            metadataRows.every(
                (metadata) =>
                    metadata.warmup.actionDigest === metadataRows[0].warmup.actionDigest &&
                    metadata.warmup.resultDigest === metadataRows[0].warmup.resultDigest,
            );
        const telemetrySemanticsPassed = (["baseline", "candidate"] as const).every(
            (variant) =>
                telemetry[variant].workload.actionDigest === metadataRows[0].workload.actionDigest &&
                telemetry[variant].workload.resultDigest === metadataRows[0].workload.resultDigest,
        );
        const baselineCounts = telemetry.baseline.counts;
        const candidateCounts = telemetry.candidate.counts;
        const fullBuilderCallRatio =
            baselineCounts.fullBuilder > 0
                ? candidateCounts.fullBuilder / baselineCounts.fullBuilder
                : Number.POSITIVE_INFINITY;
        const fullBuilderCallsPassed = baselineCounts.fullBuilder > 0 && fullBuilderCallRatio <= 0.5;
        const firstBuilderCallsPassed = baselineCounts.firstBuilder === 0 && candidateCounts.firstBuilder > 0;
        const telemetryAdjustCallsPassed =
            baselineCounts.adjustBaseStats > 0 &&
            candidateCounts.adjustBaseStats === baselineCounts.adjustBaseStats &&
            baselineCounts.adjustDepth === 0 &&
            candidateCounts.adjustDepth === 0 &&
            baselineCounts.oracleDepth === 0 &&
            candidateCounts.oracleDepth === 0;
        const telemetryCallsPassed = candidateCounts.calls > 0;
        const telemetryOraclePassed =
            candidateCounts.oracleChecks === candidateCounts.calls && candidateCounts.mismatches === 0;
        const telemetryClassificationPassed =
            candidateCounts.exactGridFast +
                candidateCounts.nearGridFast +
                candidateCounts.numericFallback +
                candidateCounts.dynamicFallback ===
                candidateCounts.calls &&
            candidateCounts.fast === candidateCounts.exactGridFast + candidateCounts.nearGridFast;
        const telemetryNearGridPassed =
            candidateCounts.nearGridFast > 0 &&
            candidateCounts.nearGridNegativeZero >= 0 &&
            candidateCounts.nearGridNegativeZero <= candidateCounts.nearGridFast;
        const telemetryDynamicFallbackPassed = candidateCounts.dynamicFallback === 0;
        const fastPathShare = candidateCounts.calls > 0 ? candidateCounts.fast / candidateCounts.calls : 0;
        const telemetryFastSharePassed = fastPathShare >= MINIMUM_FAST_PATH_SHARE;
        const telemetryLegacyParityPassed =
            baselineCounts.legacyConversions > 0 && candidateCounts.calls === baselineCounts.legacyConversions;
        const candidateFallbackAccountingPassed = candidateCounts.legacyConversions === candidateCounts.numericFallback;
        const baselineTelemetryCleanPassed =
            baselineCounts.calls === 0 &&
            baselineCounts.fast === 0 &&
            baselineCounts.exactGridFast === 0 &&
            baselineCounts.nearGridFast === 0 &&
            baselineCounts.nearGridNegativeZero === 0 &&
            baselineCounts.numericFallback === 0 &&
            baselineCounts.dynamicFallback === 0 &&
            baselineCounts.oracleChecks === 0 &&
            baselineCounts.mismatches === 0;
        const baselineAdjustSampledMicroseconds =
            pooled.baseline.functions.adjustBaseStats.inclusiveSampledMicroseconds;
        const candidateAdjustSampledMicroseconds =
            pooled.candidate.functions.adjustBaseStats.inclusiveSampledMicroseconds;
        const adjustBaseStatsRatio =
            baselineAdjustSampledMicroseconds > 0
                ? candidateAdjustSampledMicroseconds / baselineAdjustSampledMicroseconds
                : Number.POSITIVE_INFINITY;
        const adjustBaseStatsRatioPassed =
            baselineAdjustSampledMicroseconds > 0 && adjustBaseStatsRatio <= MAXIMUM_ADJUST_BASE_STATS_RATIO;
        const baselineNativeUnderAdjustMicroseconds =
            pooled.baseline.functions.nativeToFixed.underAdjustBaseStatsSampledMicroseconds;
        const candidateNativeUnderAdjustMicroseconds =
            pooled.candidate.functions.nativeToFixed.underAdjustBaseStatsSampledMicroseconds;
        const nativeToFixedUnderAdjustRatio =
            baselineNativeUnderAdjustMicroseconds > 0
                ? candidateNativeUnderAdjustMicroseconds / baselineNativeUnderAdjustMicroseconds
                : Number.POSITIVE_INFINITY;
        const nativeToFixedRatioPassed =
            baselineNativeUnderAdjustMicroseconds > 0 &&
            nativeToFixedUnderAdjustRatio <= MAXIMUM_NATIVE_TO_FIXED_UNDER_ADJUST_RATIO;
        const candidateNativeUnderAdjustShare =
            candidateNativeUnderAdjustMicroseconds / pooled.candidate.totalSampledMicroseconds;
        const candidateNativeSharePassed =
            candidateNativeUnderAdjustShare <= MAXIMUM_CANDIDATE_NATIVE_TO_FIXED_UNDER_ADJUST_SHARE;
        const perCaptureProfileSupport = captures.baseline.map((baselineCapture) => {
            const candidateCapture = captures.candidate.find((capture) => capture.capture === baselineCapture.capture);
            if (!candidateCapture) throw new Error(`Missing candidate profile capture ${baselineCapture.capture}`);
            const baselineFull =
                baselineCapture.attribution.functions.buildMeleeTargetLayers.underDoFindTargetSampledMicroseconds;
            const candidateFull =
                candidateCapture.attribution.functions.buildMeleeTargetLayers.underDoFindTargetSampledMicroseconds;
            const baselineAdjust = baselineCapture.attribution.functions.adjustBaseStats.inclusiveSampledMicroseconds;
            const candidateAdjust = candidateCapture.attribution.functions.adjustBaseStats.inclusiveSampledMicroseconds;
            const baselineNative =
                baselineCapture.attribution.functions.nativeToFixed.underAdjustBaseStatsSampledMicroseconds;
            const candidateNative =
                candidateCapture.attribution.functions.nativeToFixed.underAdjustBaseStatsSampledMicroseconds;
            const baselineNativeInclusive =
                baselineCapture.attribution.functions.nativeToFixed.inclusiveSampledMicroseconds;
            const candidateNativeInclusive =
                candidateCapture.attribution.functions.nativeToFixed.inclusiveSampledMicroseconds;
            const baselineNativeCoverage = baselineNativeInclusive > 0 ? baselineNative / baselineNativeInclusive : 0;
            const candidateNativeCoverage =
                candidateNativeInclusive > 0 ? candidateNative / candidateNativeInclusive : 0;
            const candidateRound = candidateCapture.attribution.functions.roundUnitStat.inclusiveSampledMicroseconds;
            const candidateCombinedShare =
                candidateCapture.attribution.functions.buildMeleeTargetLayers.inclusiveShare +
                candidateCapture.attribution.functions.buildFirstMeleeTargetLayers.inclusiveShare;
            const signalsPassed =
                baselineFull >= MINIMUM_BASELINE_FULL_BUILDER_UNDER_FIND_US_PER_CAPTURE &&
                baselineAdjust >= MINIMUM_BASELINE_ADJUST_BASE_STATS_US_PER_CAPTURE &&
                baselineNative >= MINIMUM_BASELINE_NATIVE_TO_FIXED_UNDER_ADJUST_US_PER_CAPTURE &&
                candidateRound > 0 &&
                baselineNativeCoverage >= MINIMUM_NATIVE_TO_FIXED_UNDER_ADJUST_COVERAGE &&
                candidateNativeCoverage >= MINIMUM_NATIVE_TO_FIXED_UNDER_ADJUST_COVERAGE;
            const directionsPassed =
                candidateFull < baselineFull &&
                candidateAdjust < baselineAdjust &&
                candidateNative < baselineNative &&
                candidateCombinedShare <= MAXIMUM_CANDIDATE_COMBINED_BUILDER_SHARE;
            return {
                capture: baselineCapture.capture,
                baselineSignals: {
                    fullBuilderUnderDoFindTargetMicroseconds: baselineFull,
                    adjustBaseStatsMicroseconds: baselineAdjust,
                    nativeToFixedUnderAdjustMicroseconds: baselineNative,
                    nativeToFixedInclusiveMicroseconds: baselineNativeInclusive,
                    nativeToFixedUnderAdjustCoverage: baselineNativeCoverage,
                },
                candidateSignals: {
                    fullBuilderUnderDoFindTargetMicroseconds: candidateFull,
                    adjustBaseStatsMicroseconds: candidateAdjust,
                    nativeToFixedUnderAdjustMicroseconds: candidateNative,
                    nativeToFixedInclusiveMicroseconds: candidateNativeInclusive,
                    nativeToFixedUnderAdjustCoverage: candidateNativeCoverage,
                    roundUnitStatMicroseconds: candidateRound,
                    combinedBuilderShare: candidateCombinedShare,
                },
                signalsPassed,
                directionsPassed,
                passed: signalsPassed && directionsPassed,
            };
        });
        const perCaptureProfileSupportPassed =
            perCaptureProfileSupport.length === captureCount &&
            perCaptureProfileSupport.every((capture) => capture.passed);
        const measurementGatesPassed =
            exactSemanticsPassed &&
            warmupSemanticsPassed &&
            telemetrySemanticsPassed &&
            fullBuilderCallsPassed &&
            firstBuilderCallsPassed &&
            telemetryAdjustCallsPassed &&
            telemetryCallsPassed &&
            telemetryOraclePassed &&
            telemetryClassificationPassed &&
            telemetryNearGridPassed &&
            telemetryDynamicFallbackPassed &&
            telemetryFastSharePassed &&
            telemetryLegacyParityPassed &&
            candidateFallbackAccountingPassed &&
            baselineTelemetryCleanPassed &&
            childRealmPassed &&
            baselineSignalPassed &&
            infiniteParentReductionPassed &&
            candidateCombinedBuilderPassed &&
            adjustBaseStatsRatioPassed &&
            nativeToFixedRatioPassed &&
            candidateNativeSharePassed &&
            perCaptureProfileSupportPassed;
        const report = {
            schema: SCHEMA,
            attemptId,
            createdAt: new Date().toISOString(),
            mode,
            protocol: {
                purpose:
                    "A13 cross-root unit-stat decimal-normalization attribution with fresh first-layer regression gates",
                immutableRoots: {
                    baselineCommit: BASELINE_COMMIT,
                    baselineSrcManifestSha256: BASELINE_SRC_MANIFEST_SHA256,
                    candidateCommit: CANDIDATE_COMMIT,
                    candidateSrcManifestSha256: CANDIDATE_SRC_MANIFEST_SHA256,
                    archivePolicy:
                        "A git HEAD must equal the declared commit when metadata exists; metadata-free immutable " +
                        "archives are accepted only when the full src manifest equals the commit-pinned digest.",
                },
                aiVersion: AI_VERSION,
                mirror: true,
                environmentScrubPrefixes: ENVIRONMENT_PREFIXES,
                environmentScrubExactKeys: ENVIRONMENT_EXACT_KEYS,
                fixedEnvironment: FIXED_ENVIRONMENT,
                processIsolation: {
                    forbiddenInjectionEnvironmentKeys: FORBIDDEN_INJECTION_ENVIRONMENT_KEYS,
                    forbiddenInjectionEnvironmentPrefixes: FORBIDDEN_INJECTION_ENVIRONMENT_PREFIXES,
                    forbiddenExecArgvFlags: FORBIDDEN_EXEC_ARGV_FLAGS,
                    childEnvironmentAllowlist: CHILD_ENVIRONMENT_ALLOWLIST,
                    startupNumericIntrinsics: EXPECTED_NATIVE_FUNCTIONS,
                    pinnedRuntimeInputs: {
                        packageJsonSha256: EXPECTED_PACKAGE_JSON_SHA256,
                        tsconfigJsonSha256: EXPECTED_TSCONFIG_JSON_SHA256,
                        bunfigTomlSha256: EXPECTED_BUNFIG_TOML_SHA256,
                        workspaceLockSha256: EXPECTED_WORKSPACE_LOCK_SHA256,
                        bunExecutableSha256: EXPECTED_BUN_EXECUTABLE_SHA256,
                        runtimeDependencies: EXPECTED_RUNTIME_DEPENDENCIES,
                    },
                },
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
                        "a source function matches only when both functionName and source URL suffix match; native " +
                        "toFixed matches only an exact toFixed frame with an empty source URL and an exact " +
                        "adjustBaseStats or roundUnitStat caller in the reconstructed stack",
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
                    perCaptureSupport: {
                        minimumBaselineFullBuilderUnderDoFindTargetMicroseconds:
                            MINIMUM_BASELINE_FULL_BUILDER_UNDER_FIND_US_PER_CAPTURE,
                        minimumBaselineAdjustBaseStatsMicroseconds: MINIMUM_BASELINE_ADJUST_BASE_STATS_US_PER_CAPTURE,
                        minimumBaselineNativeToFixedUnderAdjustMicroseconds:
                            MINIMUM_BASELINE_NATIVE_TO_FIXED_UNDER_ADJUST_US_PER_CAPTURE,
                        minimumNativeToFixedUnderAdjustCoverage: MINIMUM_NATIVE_TO_FIXED_UNDER_ADJUST_COVERAGE,
                        requiredDirections: [
                            "candidate full-builder-under-doFindTarget < baseline",
                            "candidate adjustBaseStats inclusive < baseline",
                            "candidate native-toFixed-under-adjust < baseline",
                            "candidate combined builder share <= 3%",
                        ],
                    },
                    statRoundingMetrics: {
                        nativeToFixedUnderAdjust:
                            "Exact native toFixed frames whose reconstructed caller stack contains exact " +
                            "adjustBaseStats@src/units/unit.ts",
                        maximumCandidateToBaselineNativeToFixedRatio: MAXIMUM_NATIVE_TO_FIXED_UNDER_ADJUST_RATIO,
                        maximumCandidateToBaselineAdjustBaseStatsRatio: MAXIMUM_ADJUST_BASE_STATS_RATIO,
                        maximumCandidateNativeToFixedUnderAdjustShare:
                            MAXIMUM_CANDIDATE_NATIVE_TO_FIXED_UNDER_ADJUST_SHARE,
                    },
                    timingExcludedTelemetry: {
                        method:
                            "Fresh child processes use loader transforms and a native-toFixed wrapper only outside " +
                            "the CPU-profile captures after Profiler.startPreciseCoverage is confirmed unsupported",
                        minimumFastPathShare: MINIMUM_FAST_PATH_SHARE,
                        requirements: [
                            "calls > 0",
                            "oracleChecks === calls",
                            "mismatches === 0",
                            "exactGridFast + nearGridFast + numericFallback + dynamicFallback === calls",
                            "fast === exactGridFast + nearGridFast",
                            "nearGridFast > 0",
                            "0 <= nearGridNegativeZero <= nearGridFast",
                            "fast / calls >= 0.90",
                            "dynamicFallback === 0 in the clean realm",
                            "candidate calls === baseline legacy conversions for the same workload",
                            "candidate legacy conversions === candidate numeric fallbacks",
                        ],
                    },
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
            realm: {
                startupInvariant:
                    "Parent and every fresh child verify standard Number, Number.prototype.toFixed, " +
                    "Number.isSafeInteger, Reflect.apply, and Function.prototype.toString descriptors and native sources",
                preloadHooksAbsent: true,
                parentRuntimeInjection: {
                    before: parentRuntimeInjectionBefore,
                    after: parentRuntimeInjectionAfter,
                    unchanged: true,
                },
                parentBefore: parentRealmBefore,
                parentAfter: parentRealmAfter,
                parentUnchanged: true,
                childEvidencePassed: childRealmPassed,
            },
            artifacts: {
                directory: basename(profileDirectory),
                rawChromeProfilesRetained: true,
                workloadMetadataRetained: true,
                telemetryMetadataRetained: true,
            },
            semantic: {
                actionDigest: metadataRows[0].workload.actionDigest,
                resultDigest: metadataRows[0].workload.resultDigest,
                repeatsCompared: repeats * captureCount * 2,
                capturesCompared: captureCount * 2,
                variantsCompared: ["baseline", "candidate"],
                identicalAcrossRepeatsCapturesAndVariants: exactSemanticsPassed,
                warmupActionDigest: metadataRows[0].warmup.actionDigest,
                warmupResultDigest: metadataRows[0].warmup.resultDigest,
                warmupsIdenticalAcrossCapturesAndVariants: warmupSemanticsPassed,
                instrumentedTelemetryTraceIdenticalToUninstrumented: telemetrySemanticsPassed,
                rejected: 0,
                stuck: 0,
            },
            telemetry: {
                baseline: telemetry.baseline,
                candidate: telemetry.candidate,
                fullBuilderCandidateToBaselineRatio: fullBuilderCallRatio,
                fastPathShare,
                candidateCallsToBaselineLegacyConversionsRatio:
                    baselineCounts.legacyConversions > 0
                        ? candidateCounts.calls / baselineCounts.legacyConversions
                        : Number.POSITIVE_INFINITY,
            },
            captures,
            pooled,
            gates: {
                exactSemanticsPassed,
                warmupSemanticsPassed,
                telemetrySemanticsPassed,
                parentAndChildRealmPassed: childRealmPassed,
                fullBuilderCalls: {
                    comparator: "<=",
                    threshold: 0.5,
                    baseline: baselineCounts.fullBuilder,
                    candidate: candidateCounts.fullBuilder,
                    observedCandidateToBaselineRatio: fullBuilderCallRatio,
                    passed: fullBuilderCallsPassed,
                },
                firstBuilderCalls: {
                    baselineExpected: 0,
                    baseline: baselineCounts.firstBuilder,
                    candidateMinimumExclusive: 0,
                    candidate: candidateCounts.firstBuilder,
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
                timingExcludedTelemetry: {
                    adjustCalls: {
                        baseline: baselineCounts.adjustBaseStats,
                        candidate: candidateCounts.adjustBaseStats,
                        balancedDepths:
                            baselineCounts.adjustDepth === 0 &&
                            candidateCounts.adjustDepth === 0 &&
                            baselineCounts.oracleDepth === 0 &&
                            candidateCounts.oracleDepth === 0,
                        passed: telemetryAdjustCallsPassed,
                    },
                    calls: {
                        comparator: ">",
                        threshold: 0,
                        observed: candidateCounts.calls,
                        passed: telemetryCallsPassed,
                    },
                    oracle: {
                        calls: candidateCounts.calls,
                        oracleChecks: candidateCounts.oracleChecks,
                        mismatches: candidateCounts.mismatches,
                        passed: telemetryOraclePassed,
                    },
                    classification: {
                        calls: candidateCounts.calls,
                        fast: candidateCounts.fast,
                        exactGridFast: candidateCounts.exactGridFast,
                        nearGridFast: candidateCounts.nearGridFast,
                        nearGridNegativeZero: candidateCounts.nearGridNegativeZero,
                        numericFallback: candidateCounts.numericFallback,
                        dynamicFallback: candidateCounts.dynamicFallback,
                        sum:
                            candidateCounts.exactGridFast +
                            candidateCounts.nearGridFast +
                            candidateCounts.numericFallback +
                            candidateCounts.dynamicFallback,
                        passed: telemetryClassificationPassed,
                    },
                    nearGrid: {
                        scaledLowerExclusive: -(2 ** 30),
                        scaledUpperExclusive: 2 ** 30,
                        distanceLowerExclusive: -0.25,
                        distanceUpperExclusive: 0.25,
                        observedFast: candidateCounts.nearGridFast,
                        observedNegativeZero: candidateCounts.nearGridNegativeZero,
                        passed: telemetryNearGridPassed,
                    },
                    fastPathShare: {
                        comparator: ">=",
                        threshold: MINIMUM_FAST_PATH_SHARE,
                        observed: fastPathShare,
                        passed: telemetryFastSharePassed,
                    },
                    dynamicFallback: {
                        comparator: "===",
                        threshold: 0,
                        observed: candidateCounts.dynamicFallback,
                        passed: telemetryDynamicFallbackPassed,
                    },
                    legacyConversionParity: {
                        baselineLegacyConversions: baselineCounts.legacyConversions,
                        candidateCalls: candidateCounts.calls,
                        passed: telemetryLegacyParityPassed,
                    },
                    candidateFallbackAccounting: {
                        candidateLegacyConversions: candidateCounts.legacyConversions,
                        candidateNumericFallbacks: candidateCounts.numericFallback,
                        passed: candidateFallbackAccountingPassed,
                    },
                    baselineClean: {
                        passed: baselineTelemetryCleanPassed,
                    },
                },
                adjustBaseStatsFixedWorkRatio: {
                    comparator: "<=",
                    threshold: MAXIMUM_ADJUST_BASE_STATS_RATIO,
                    baselineSampledMicroseconds: baselineAdjustSampledMicroseconds,
                    candidateSampledMicroseconds: candidateAdjustSampledMicroseconds,
                    observedCandidateToBaselineRatio: adjustBaseStatsRatio,
                    passed: adjustBaseStatsRatioPassed,
                },
                nativeToFixedUnderAdjustRatio: {
                    comparator: "<=",
                    threshold: MAXIMUM_NATIVE_TO_FIXED_UNDER_ADJUST_RATIO,
                    baselineSampledMicroseconds: baselineNativeUnderAdjustMicroseconds,
                    candidateSampledMicroseconds: candidateNativeUnderAdjustMicroseconds,
                    observedCandidateToBaselineRatio: nativeToFixedUnderAdjustRatio,
                    passed: nativeToFixedRatioPassed,
                },
                candidateNativeToFixedUnderAdjustShare: {
                    comparator: "<=",
                    threshold: MAXIMUM_CANDIDATE_NATIVE_TO_FIXED_UNDER_ADJUST_SHARE,
                    candidateSampledMicroseconds: candidateNativeUnderAdjustMicroseconds,
                    candidateTotalSampledMicroseconds: pooled.candidate.totalSampledMicroseconds,
                    observed: candidateNativeUnderAdjustShare,
                    passed: candidateNativeSharePassed,
                },
                perCaptureProfileSupport: {
                    minimumSignals: {
                        baselineFullBuilderUnderDoFindTargetMicroseconds:
                            MINIMUM_BASELINE_FULL_BUILDER_UNDER_FIND_US_PER_CAPTURE,
                        baselineAdjustBaseStatsMicroseconds: MINIMUM_BASELINE_ADJUST_BASE_STATS_US_PER_CAPTURE,
                        baselineNativeToFixedUnderAdjustMicroseconds:
                            MINIMUM_BASELINE_NATIVE_TO_FIXED_UNDER_ADJUST_US_PER_CAPTURE,
                        nativeToFixedUnderAdjustCoverage: MINIMUM_NATIVE_TO_FIXED_UNDER_ADJUST_COVERAGE,
                    },
                    captures: perCaptureProfileSupport,
                    passed: perCaptureProfileSupportPassed,
                },
                measurementGatesPassed,
                qualified: mode === "evidence" && measurementGatesPassed,
                smokeNeverQualifies: mode === "smoke",
            },
        };

        mkdirSync(profileDirectory, { recursive: true });
        for (const variant of ["baseline", "candidate"] as const) {
            const telemetryName = `${variant}-telemetry.workload.json`;
            copyFileSync(
                join(temporaryRoot, telemetryName),
                join(profileDirectory, telemetryName),
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
                `${(candidateCombinedBuilderShare * 100).toFixed(3)}%; adjustBaseStats ratio=` +
                `${adjustBaseStatsRatio.toFixed(4)}; native-toFixed-under-adjust ratio=` +
                `${nativeToFixedUnderAdjustRatio.toFixed(4)}; fast path=${(fastPathShare * 100).toFixed(3)}%`,
        );
        if (mode === "evidence" && !measurementGatesPassed) {
            throw new Error("A13 stat-rounding cross-root attribution gates failed");
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
    if (command === "telemetry") {
        await telemetryMain(rest);
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
