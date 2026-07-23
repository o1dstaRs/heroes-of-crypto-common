#!/usr/bin/env bun

/**
 * Fresh sealed paired macro capture for the combined A13 first-layer and unit-stat rounding candidate.
 *
 * This runner is deliberately independent from the rejected first-layer qualification. It accepts exactly
 * the five-file runtime delta frozen in the companion replication protocol and emits one capture containing
 * exact cross-root semantics plus serial paired timings. A capture is never a qualification by itself.
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
    existsSync,
    linkSync,
    lstatSync,
    readFileSync,
    readdirSync,
    readlinkSync,
    realpathSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { arch, cpus, homedir, platform, release } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const SCHEMA = "heroes-of-crypto/a13-stat-rounding-near-grid-pair/v2" as const;
const PROTOCOL_SCHEMA = "heroes-of-crypto/a13-stat-rounding-near-grid-replication-protocol/v2" as const;
const CANONICAL_ENCODING_SCHEMA = "heroes-of-crypto/type-tagged-canonical-value/v1" as const;
const AI_VERSION = "v0.8";
const UINT32_MAX = 0xffff_ffff;
const DEFAULT_SEEDS = Object.freeze(Array.from({ length: 40 }, (_, index) => index + 1));
const DEFAULT_GRID_TYPES = Object.freeze([1, 2, 3, 4]);
const DEFAULT_MAX_LAPS = 2;
const DEFAULT_WARMUP_SEED = UINT32_MAX;
const RUNNER_PATH = fileURLToPath(import.meta.url);
const RUNNER_ROOT = resolve(dirname(RUNNER_PATH), "../../..");
const PROTOCOL_PATH = resolve(
    dirname(RUNNER_PATH),
    "../a13_stat_rounding_near_grid_replication_protocol_2026-07-23.json",
);
const EXPECTED_HOST = Object.freeze({
    platform: "darwin",
    release: "24.6.0",
    arch: "arm64",
    cpuModel: "Apple M4 Max",
    logicalCpus: 16,
    bunVersion: "1.3.14",
    bunRevision: "0d9b296af33f2b851fcbf4df3e9ec89751734ba4",
    bunExecutableSha256: "e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233",
});
const REQUIRED_RUNTIME_ENVIRONMENT = Object.freeze({
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    TZ: "UTC",
    LANG: "C.UTF-8",
    LC_ALL: "C",
});
const GOVERNED_LOCALE_ENVIRONMENT_KEYS = Object.freeze([
    "TZ",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LC_COLLATE",
    "LC_NUMERIC",
    "LC_TIME",
    "LC_MESSAGES",
    "LC_MONETARY",
    "LC_PAPER",
    "LC_NAME",
    "LC_ADDRESS",
    "LC_TELEPHONE",
    "LC_MEASUREMENT",
    "LC_IDENTIFICATION",
]);
const ALLOWED_BUN_ENVIRONMENT_KEYS = Object.freeze(["BUN_INSTALL", "BUN_RUNTIME_TRANSPILER_CACHE_PATH"]);
const EXPECTED_SOURCE_DELTA = Object.freeze([
    { path: "ai/ai.ts", change: "modified" },
    { path: "ai/decision_path_catalog.ts", change: "modified" },
    { path: "ai/internal/melee_target_layers.ts", change: "modified" },
    { path: "units/stat_rounding.ts", change: "added" },
    { path: "units/unit.ts", change: "modified" },
] as const);
const SCRUBBED_ENVIRONMENT_PREFIXES = ["SEARCH_", "V04_", "V05_", "V06_", "V07_", "V08_", "Q2_", "SIM_"] as const;
const EXACT_GOVERNED_ENVIRONMENT_KEYS = [
    "LIVETWIN",
    "FIGHT_MELEE_ROSTERS",
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
const FIXED_ENVIRONMENT_OVERRIDES = Object.freeze({
    V08_A13_SEARCH: "0",
    V07_SEARCH: "1",
    Q2_ORACLE: undefined,
    Q2_WAIT_ABLATION: undefined,
    SEARCH_DECISION_DEADLINE_MS: undefined,
    SEARCH_CIRCUIT_BREAKER_MS: undefined,
    LIVETWIN: "1",
    FIGHT_MELEE_ROSTERS: "0",
    V04_BOXHOLD: undefined,
    V04_FRONTLINE: undefined,
    V04_FRONTMOVE: undefined,
    V04_BUFFWAIT: undefined,
    V04_BEHESELF: undefined,
    V04_OGRESELF: undefined,
    V04_MVGUARD: undefined,
    V04_FHUNT2: undefined,
    V04_TROLL: undefined,
    FORCE_CREATURES: undefined,
    COHORT: undefined,
    ROSTER_RANGED_MIN: undefined,
    ROSTER_RANGED_MAX: undefined,
    ROSTER_FLYER_MIN: undefined,
    ROSTER_FLYER_MAX: undefined,
    ROSTER_CASTER_MIN: undefined,
    ROSTER_CASTER_MAX: undefined,
    VALUE_DATA: undefined,
    VALUE_DATA_FEATURES: undefined,
    PHASE_B_RUN_FINGERPRINT: undefined,
});
const FORBIDDEN_INJECTION_ENVIRONMENT_KEYS = Object.freeze([
    "BUN_PRELOAD",
    "BUN_OPTIONS",
    "NODE_OPTIONS",
    "NODE_PATH",
    "LD_PRELOAD",
    "LD_AUDIT",
    "LD_LIBRARY_PATH",
    "HOC_BREAK_DEBUG",
    "MALLOC_CONF",
    "GLIBC_TUNABLES",
    "UV_THREADPOOL_SIZE",
    "XDG_CONFIG_HOME",
]);
const FORBIDDEN_INJECTION_ENVIRONMENT_PREFIXES = Object.freeze([
    "DYLD_",
    "BUN_JSC_",
    "JSC_",
    "BUN_GC_",
    "Malloc",
    "MALLOC_",
]);
const FORBIDDEN_EXEC_ARGV_FLAGS = Object.freeze([
    "-r",
    "--require",
    "--import",
    "--loader",
    "--experimental-loader",
    "--preload",
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
    {
        label: "process.hrtime",
        name: "hrtime",
        length: 0,
        nativeSourceSha256: "8d7372efb0cec13469e60491554ce3777647371afb42eaa2452e8991b961e64a",
    },
    {
        label: "process.hrtime.bigint",
        name: "bigint",
        length: 0,
        nativeSourceSha256: "dcd68afd0903329bfbd866993a686ea597de8bb3ce75d2d1bd4902d2e01fe723",
    },
]);

type VariantLabel = "baseline" | "candidate";
type TaskOrder = "AB" | "BA";

interface ICli {
    attemptId: string;
    captureId: string;
    baselineRoot: string;
    candidateRoot: string;
    out: string;
    seeds: number[];
    gridTypes: number[];
    maxLaps: number;
    warmupSeed: number;
    invertOrder: boolean;
    smoke: boolean;
}

interface IArmyModule {
    buildRoster(rng: () => number): unknown[];
    makeRng(seed: number): () => number;
}

interface IBattleModule {
    runMatch(config: Record<string, unknown>): Record<string, unknown>;
}

interface IA13ProfileModule {
    V08_A13_PROFILE: unknown;
    V08_A13_GENOME: unknown;
    V08_A13_SEARCH: unknown;
    V08_A13_POLICY: unknown;
    buildV08A13SearchEnvironment(version?: string): Readonly<Record<string, string | undefined>>;
}

interface IProductionSearchModule {
    shouldUseDefaultV08A13Search(match: { greenVersion: string; redVersion: string }): boolean;
}

interface ITreeEntry {
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

interface ISourceSeal {
    entries: ITreeEntry[];
    report: {
        root: string;
        realRoot: string;
        srcEntryCount: number;
        srcBytes: number;
        srcTreeManifestSha256: string;
        packageJson: IFileSeal;
        tsconfigJson: IFileSeal;
        bunfigToml: IFileSeal;
        workspaceLock: IFileSeal;
        runtimeDependencies: Record<string, IDirectorySeal>;
        runtimeResolution: Record<string, { resolvedPath: string; realPath: string; withinSealedRoot: true }>;
        dependencyRealpaths: {
            rootNodeModules: string;
            workspaceNodeModules: string;
        };
        bunExecutable: IFileSeal;
        identitySha256: string;
    };
}

interface IDirectorySeal {
    root: string;
    realRoot: string;
    entryCount: number;
    bytes: number;
    manifestSha256: string;
}

interface IProfileSeal {
    profileSha256: string;
    genomeSha256: string;
    searchSha256: string;
    policySha256: string;
    fullEnvironmentSha256: string;
    activeEnvironmentSha256: string;
    genericSearchDriverSelected: true;
    deadlineFree: true;
}

interface IVariant {
    label: VariantLabel;
    army: IArmyModule;
    battle: IBattleModule;
    environment: Readonly<Record<string, string | undefined>>;
    profile: IProfileSeal;
}

interface IRun {
    elapsedNs: number;
    canonical: {
        result: string;
        actions: string;
        placements: string;
        roster: string;
    };
    endReason: string;
    totalActions: number;
    search: ISearchCounters | null;
}

interface IExactDigests {
    resultSha256: string;
    actionsSha256: string;
    placementsSha256: string;
    rosterSha256: string;
}

interface ISearchCounters {
    decisions: number;
    catalogs: number;
    requests: number;
    hits: number;
    misses: number;
    bypasses: number;
}

interface IRow {
    ordinal: number;
    order: TaskOrder;
    seed: number;
    gridType: number;
    baselineNs: number;
    candidateNs: number;
    ratio: number;
    resultSha256: string;
    candidateResultSha256: string;
    actionsSha256: string;
    candidateActionsSha256: string;
    placementsSha256: string;
    candidatePlacementsSha256: string;
    rosterSha256: string;
    candidateRosterSha256: string;
    endReason: string;
    candidateEndReason: string;
    baselineTotalActions: number;
    candidateTotalActions: number;
    exact: true;
}

interface INativeFunctionLocation {
    label: string;
    owner: object;
    key: string;
    value: CallableFunction;
}

interface IRunnerWorkspaceSeal {
    root: string;
    realRoot: string;
    packageJson: IFileSeal;
    tsconfigJson: IFileSeal;
    bunfigToml: IFileSeal;
    workspaceLock: IFileSeal;
    identitySha256: string;
}

interface ICaptureSchedule {
    id: string;
    seeds: number[];
    gridTypes: number[];
    invertOrder: boolean;
}

interface IProtocolBinding {
    schema: typeof PROTOCOL_SCHEMA;
    before: IFileSeal;
    captureRunner: {
        schema: typeof SCHEMA;
        sha256: string;
    };
    schedule: ICaptureSchedule;
    scheduleExact: boolean;
}

interface IGovernedEnvironmentSnapshot {
    behaviorEntries: Array<{ key: string; value: string | undefined }>;
    runtimeEntries: Array<{ key: string; expected: string; observed: string | null }>;
    hocBreakDebug: string | null;
    sha256: string;
}

interface IPinnedHostAudit {
    pinned: true;
    expected: typeof EXPECTED_HOST;
    observed: {
        platform: string;
        release: string;
        arch: string;
        cpuModel: string;
        logicalCpus: number;
        bunVersion: string;
        bunRevision: string;
        bunExecutableSha256: string;
    };
    bunExecutable: IFileSeal;
}

function sha256(value: string | Uint8Array): string {
    return createHash("sha256").update(value).digest("hex");
}

interface ICanonicalState {
    nextObjectId: number;
    objectIds: WeakMap<object, number>;
}

function canonicalize(value: unknown, state: ICanonicalState): unknown {
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
    if (typeof value === "symbol" || typeof value === "function") {
        throw new Error(`Canonical encoding does not support ${typeof value} values`);
    }
    if (typeof value !== "object") throw new Error(`Canonical encoding does not support ${typeof value} values`);

    const existingId = state.objectIds.get(value);
    if (existingId !== undefined) return ["reference", existingId];
    const objectId = state.nextObjectId++;
    state.objectIds.set(value, objectId);

    if (Array.isArray(value)) {
        const slots = Array.from({ length: value.length }, (_, index) =>
            Object.hasOwn(value, index) ? canonicalize(value[index], state) : ["array-hole"],
        );
        const extraKeys = Object.keys(value)
            .filter((key) => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)
            .sort()
            .map((key) => [key, canonicalize((value as unknown as Record<string, unknown>)[key], state)]);
        const allowedKeys = new Set(["length", ...Array.from({ length: value.length }, (_, index) => String(index))]);
        for (const key of Reflect.ownKeys(value)) {
            if (
                typeof key === "symbol" ||
                (typeof key === "string" && !allowedKeys.has(key) && !extraKeys.some(([k]) => k === key))
            ) {
                throw new Error("Canonical encoding encountered an unsupported array property");
            }
        }
        return ["array", objectId, slots, extraKeys];
    }
    if (value instanceof Map) {
        if (Reflect.ownKeys(value).length > 0) {
            throw new Error("Canonical encoding does not support custom Map properties");
        }
        return [
            "map",
            objectId,
            [...value.entries()].map(([key, child]) => [canonicalize(key, state), canonicalize(child, state)]),
        ];
    }
    if (value instanceof Set) {
        if (Reflect.ownKeys(value).length > 0) {
            throw new Error("Canonical encoding does not support custom Set properties");
        }
        return ["set", objectId, [...value.values()].map((child) => canonicalize(child, state))];
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`Canonical encoding does not support ${prototype?.constructor?.name ?? "unknown"} objects`);
    }
    const keys = Object.keys(value).sort();
    const ownKeys = Reflect.ownKeys(value);
    if (
        ownKeys.some((key) => typeof key === "symbol") ||
        ownKeys.some((key) => typeof key === "string" && !keys.includes(key))
    ) {
        throw new Error("Canonical encoding requires enumerable string-keyed plain objects");
    }
    return [
        prototype === null ? "null-prototype-object" : "object",
        objectId,
        keys.map((key) => [key, canonicalize((value as Record<string, unknown>)[key], state)]),
    ];
}

const canonicalJson = (value: unknown): string =>
    JSON.stringify(canonicalize(value, { nextObjectId: 0, objectIds: new WeakMap<object, number>() }));
const digest = (value: unknown): string => sha256(canonicalJson(value));
const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
const normalizedPath = (value: string): string => value.split(sep).join("/");
const compareStrings = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

function assertCanonicalEncoding(): Record<string, unknown> {
    const shared: Record<string, never> = {};
    const collisionPairs: Array<{ label: string; left: unknown; right: unknown }> = [
        { label: "undefined/null", left: undefined, right: null },
        { label: "bigint/string", left: 1n, right: "1" },
        { label: "negative/positive zero", left: -0, right: 0 },
        { label: "NaN/null", left: Number.NaN, right: null },
        { label: "positive infinity/null", left: Number.POSITIVE_INFINITY, right: null },
        { label: "negative infinity/null", left: Number.NEGATIVE_INFINITY, right: null },
        { label: "undefined/null property", left: { value: undefined }, right: { value: null } },
        { label: "Map/plain object", left: new Map([["value", 1]]), right: { value: 1 } },
        { label: "Set/array", left: new Set([1]), right: [1] },
        { label: "array hole/undefined", left: Array(1), right: [undefined] },
        { label: "shared/duplicated reference", left: { left: shared, right: shared }, right: { left: {}, right: {} } },
    ];
    for (const pair of collisionPairs) {
        if (canonicalJson(pair.left) === canonicalJson(pair.right)) {
            throw new Error(`Canonical encoding collision: ${pair.label}`);
        }
    }
    if (canonicalJson({ left: 1, right: 2 }) !== canonicalJson({ right: 2, left: 1 })) {
        throw new Error("Canonical encoding is not independent of plain-object insertion order");
    }
    return {
        schema: CANONICAL_ENCODING_SCHEMA,
        passed: true,
        collisionPairs: collisionPairs.map((pair) => pair.label),
        distinguishesObjectAliasing: true,
        plainObjectKeyOrderIndependent: true,
    };
}

function parseIntegerList(value: string, name: string, min: number, max: number): number[] {
    const output: number[] = [];
    for (const raw of value.split(",")) {
        const token = raw.trim();
        const range = /^(\d+)-(\d+)$/.exec(token);
        if (range) {
            const first = Number(range[1]);
            const last = Number(range[2]);
            if (first > last || first < min || last > max) throw new Error(`${name} has invalid range ${token}`);
            for (let current = first; current <= last; current++) output.push(current);
        } else {
            const parsed = Number(token);
            if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
                throw new Error(`${name} has invalid value ${token}`);
            }
            output.push(parsed);
        }
    }
    if (output.length === 0 || new Set(output).size !== output.length) {
        throw new Error(`${name} must be non-empty and unique`);
    }
    return output;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
    return parsed;
}

function requireRoot(input: string): string {
    const root = resolve(input);
    for (const path of [
        "package.json",
        "tsconfig.json",
        "bunfig.toml",
        "src/simulation/army.ts",
        "src/simulation/battle_engine.ts",
        "src/simulation/v0_8_a13_search.ts",
        "src/ai/versions/v0_8_a13_profile.ts",
    ]) {
        if (!existsSync(join(root, path)) || !statSync(join(root, path)).isFile()) {
            throw new Error(`${root} is missing ${path}`);
        }
    }
    if (!existsSync(join(root, "node_modules"))) throw new Error(`${root} is missing node_modules`);
    return root;
}

function isPathWithin(path: string, root: string): boolean {
    return path === root || path.startsWith(`${root}${sep}`);
}

function requireSafeOutput(input: string, immutableRoots: readonly string[]): string {
    const requested = resolve(input);
    if (existsSync(requested)) throw new Error(`Refusing to overwrite ${requested}`);
    const requestedParent = dirname(requested);
    if (!existsSync(requestedParent) || !statSync(requestedParent).isDirectory()) {
        throw new Error(`Output parent must already exist as a directory: ${requestedParent}`);
    }
    const realParent = realpathSync(requestedParent);
    if (realParent !== requestedParent || lstatSync(requestedParent).isSymbolicLink()) {
        throw new Error(`Output parent must be a canonical non-symlink path: ${requestedParent}`);
    }
    const output = join(realParent, basename(requested));
    for (const root of immutableRoots.map((value) => realpathSync(value))) {
        if (isPathWithin(output, root)) throw new Error(`Output must be outside immutable root ${root}`);
    }
    return output;
}

function commandLine(): ICli | undefined {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        strict: true,
        allowPositionals: false,
        options: {
            help: { type: "boolean", default: false },
            smoke: { type: "boolean", default: false },
            "invert-order": { type: "boolean", default: false },
            "attempt-id": { type: "string" },
            "capture-id": { type: "string" },
            "baseline-root": { type: "string" },
            "candidate-root": { type: "string" },
            out: { type: "string" },
            seeds: { type: "string" },
            "grid-types": { type: "string" },
            "max-laps": { type: "string" },
            "warmup-seed": { type: "string" },
        },
    });
    if (values.help) {
        console.log(
            "Usage: bun docs/evidence/tools/a13_stat_rounding_near_grid_pair.ts " +
                "--attempt-id=UUID --capture-id=r0 --baseline-root=ROOT --candidate-root=ROOT --out=REPORT.json " +
                "[--seeds=1-40] [--grid-types=1,2,3,4] [--invert-order] [--smoke]",
        );
        return undefined;
    }
    if (
        !values["attempt-id"] ||
        !values["capture-id"] ||
        !values["baseline-root"] ||
        !values["candidate-root"] ||
        !values.out
    ) {
        throw new Error("--attempt-id, --capture-id, --baseline-root, --candidate-root, and --out are required");
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(values["attempt-id"])) {
        throw new Error("--attempt-id must be a canonical lowercase RFC 4122 UUID");
    }
    if (values["capture-id"] !== "semantic" && !/^r\d+$/.test(values["capture-id"])) {
        throw new Error("--capture-id must be semantic or match r<nonnegative integer>");
    }
    const baselineRoot = requireRoot(values["baseline-root"]);
    const candidateRoot = requireRoot(values["candidate-root"]);
    if (realpathSync(baselineRoot) === realpathSync(candidateRoot)) {
        throw new Error("Baseline and candidate roots must be distinct");
    }
    const smoke = values.smoke ?? false;
    const out = requireSafeOutput(values.out, [baselineRoot, candidateRoot]);
    return {
        attemptId: values["attempt-id"],
        captureId: values["capture-id"],
        baselineRoot,
        candidateRoot,
        out,
        smoke,
        invertOrder: values["invert-order"] ?? false,
        seeds: parseIntegerList(values.seeds ?? (smoke ? "1-2" : DEFAULT_SEEDS.join(",")), "--seeds", 0, UINT32_MAX),
        gridTypes: parseIntegerList(
            values["grid-types"] ?? (smoke ? "1,2" : DEFAULT_GRID_TYPES.join(",")),
            "--grid-types",
            1,
            4,
        ),
        maxLaps: positiveInteger(values["max-laps"], DEFAULT_MAX_LAPS, "--max-laps"),
        warmupSeed: parseIntegerList(
            values["warmup-seed"] ?? String(DEFAULT_WARMUP_SEED),
            "--warmup-seed",
            0,
            UINT32_MAX,
        )[0],
    };
}

function collectEntries(directory: string, root: string, entries: ITreeEntry[]): void {
    for (const item of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
        compareStrings(left.name, right.name),
    )) {
        const path = join(directory, item.name);
        const stats = lstatSync(path);
        if (stats.isDirectory()) {
            collectEntries(path, root, entries);
        } else if (stats.isFile()) {
            const bytes = readFileSync(path);
            entries.push({
                path: normalizedPath(relative(root, path)),
                kind: "file",
                bytes: bytes.byteLength,
                sha256: sha256(bytes),
            });
        } else if (stats.isSymbolicLink()) {
            const target = readlinkSync(path);
            entries.push({
                path: normalizedPath(relative(root, path)),
                kind: "symlink",
                bytes: Buffer.byteLength(target),
                sha256: sha256(target),
            });
        }
    }
}

function fileSeal(pathInput: string): IFileSeal {
    const path = resolve(pathInput);
    const bytes = readFileSync(path);
    return { path, realPath: realpathSync(path), bytes: bytes.byteLength, sha256: sha256(bytes) };
}

function directorySeal(pathInput: string): IDirectorySeal {
    const root = resolve(pathInput);
    const realRoot = realpathSync(root);
    const entries: ITreeEntry[] = [];
    collectEntries(realRoot, realRoot, entries);
    entries.sort((left, right) => compareStrings(left.path, right.path));
    return {
        root,
        realRoot,
        entryCount: entries.length,
        bytes: sum(entries.map((entry) => entry.bytes)),
        manifestSha256: digest(entries),
    };
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
    throw new Error(`No workspace lock above ${start}`);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
    return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
    if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
    return value;
}

function requireBoolean(value: unknown, label: string): boolean {
    if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
    return value;
}

function requireIntegerArray(value: unknown, label: string): number[] {
    if (!Array.isArray(value) || value.some((child) => !Number.isSafeInteger(child))) {
        throw new Error(`${label} must be an integer array`);
    }
    return value as number[];
}

function runnerWorkspaceSeal(): IRunnerWorkspaceSeal {
    const root = resolve(RUNNER_ROOT);
    const realRoot = realpathSync(root);
    if (realpathSync(process.cwd()) !== realRoot) {
        throw new Error(`Pair runner must start with cwd equal to ${realRoot}`);
    }
    const reportWithoutIdentity = {
        root,
        realRoot,
        packageJson: fileSeal(join(root, "package.json")),
        tsconfigJson: fileSeal(join(root, "tsconfig.json")),
        bunfigToml: fileSeal(join(root, "bunfig.toml")),
        workspaceLock: fileSeal(nearestWorkspaceLock(root)),
    };
    return { ...reportWithoutIdentity, identitySha256: digest(reportWithoutIdentity) };
}

function auditBunConfigFiles(): Record<string, unknown> {
    const paths = [
        { label: "runner/bunfig.local.toml", path: join(RUNNER_ROOT, "bunfig.local.toml") },
        { label: "runner/.bunfig.toml", path: join(RUNNER_ROOT, ".bunfig.toml") },
        { label: "home/.bunfig.toml", path: join(homedir(), ".bunfig.toml") },
        { label: "home/.config/bunfig.toml", path: join(homedir(), ".config/bunfig.toml") },
        { label: "home/.config/bun/bunfig.toml", path: join(homedir(), ".config/bun/bunfig.toml") },
    ];
    const present = paths.filter((entry) => existsSync(entry.path)).map((entry) => entry.label);
    if (present.length > 0) throw new Error(`Forbidden Bun config files are present: ${present.join(",")}`);
    return {
        passed: true,
        checked: paths.map((entry) => entry.label),
        present,
        xdgConfig: {
            environmentKey: "XDG_CONFIG_HOME",
            environmentValue: process.env.XDG_CONFIG_HOME ?? null,
            effectiveLocation: "home/.config",
            bunConfigCandidatesAbsent: true,
        },
    };
}

function loadProtocolBinding(cli: ICli, runner: IFileSeal): IProtocolBinding {
    const before = fileSeal(PROTOCOL_PATH);
    const protocol = requireRecord(JSON.parse(readFileSync(PROTOCOL_PATH, "utf8")), "protocol");
    if (protocol.schema !== PROTOCOL_SCHEMA) {
        throw new Error(`Protocol schema must be ${PROTOCOL_SCHEMA}`);
    }
    const captureRunner = requireRecord(protocol.captureRunner, "protocol captureRunner");
    const expectedCaptureRunner = { schema: SCHEMA, sha256: runner.sha256 };
    if (canonicalJson(captureRunner) !== canonicalJson(expectedCaptureRunner)) {
        throw new Error(
            `Protocol capture runner mismatch: expected=${canonicalJson(expectedCaptureRunner)} ` +
                `actual=${canonicalJson(captureRunner)}`,
        );
    }
    const fixedWork = requireRecord(protocol.fixedWork, "protocol fixedWork");
    let schedule: ICaptureSchedule;
    let expectedMaxLaps: unknown;
    if (cli.captureId === "semantic") {
        const semanticCorpus = requireRecord(protocol.semanticCorpus, "protocol semanticCorpus");
        if (semanticCorpus.seeds !== "1-40") throw new Error("semantic corpus seeds must be the natural 1-40 panel");
        schedule = {
            id: "semantic",
            seeds: [...DEFAULT_SEEDS],
            gridTypes: requireIntegerArray(semanticCorpus.gridTypes, "semantic corpus grid types"),
            invertOrder: false,
        };
        expectedMaxLaps = semanticCorpus.maxLaps;
    } else {
        if (!Array.isArray(protocol.captures)) throw new Error("protocol captures must be an array");
        const matches = protocol.captures
            .map((value, index) => requireRecord(value, `protocol capture ${index}`))
            .filter((value) => value.id === cli.captureId);
        if (matches.length !== 1) throw new Error(`Protocol must contain exactly one capture ${cli.captureId}`);
        const capture = matches[0];
        schedule = {
            id: requireString(capture.id, "protocol capture id"),
            seeds: requireIntegerArray(capture.seeds, `${cli.captureId} protocol seeds`),
            gridTypes: requireIntegerArray(capture.gridTypes, `${cli.captureId} protocol grid types`),
            invertOrder: requireBoolean(capture.invertOrder, `${cli.captureId} protocol invert order`),
        };
        expectedMaxLaps = fixedWork.maxLaps;
    }
    const expectedCommand = {
        invertOrder: schedule.invertOrder,
        seeds: schedule.seeds,
        gridTypes: schedule.gridTypes,
        maxLaps: expectedMaxLaps,
        warmupSeed: fixedWork.warmupSeed,
    };
    const actualCommand = {
        invertOrder: cli.invertOrder,
        seeds: cli.seeds,
        gridTypes: cli.gridTypes,
        maxLaps: cli.maxLaps,
        warmupSeed: cli.warmupSeed,
    };
    const scheduleExact = canonicalJson(actualCommand) === canonicalJson(expectedCommand);
    if (!cli.smoke && !scheduleExact) {
        throw new Error(
            `${cli.captureId} command differs from protocol: expected=${canonicalJson(expectedCommand)} ` +
                `actual=${canonicalJson(actualCommand)}`,
        );
    }
    if (cli.smoke && cli.invertOrder !== schedule.invertOrder) {
        throw new Error(`Smoke inversion must still match protocol capture ${cli.captureId}`);
    }
    return {
        schema: PROTOCOL_SCHEMA,
        before,
        captureRunner: expectedCaptureRunner,
        schedule,
        scheduleExact,
    };
}

function sourceSeal(rootInput: string): ISourceSeal {
    const root = requireRoot(rootInput);
    const srcRoot = join(root, "src");
    const entries: ITreeEntry[] = [];
    collectEntries(srcRoot, srcRoot, entries);
    entries.sort((left, right) => compareStrings(left.path, right.path));
    const rootNodeModules = realpathSync(join(root, "node_modules"));
    const workspaceLockPath = nearestWorkspaceLock(dirname(rootNodeModules));
    const workspaceNodeModules = realpathSync(join(dirname(workspaceLockPath), "node_modules"));
    const runtimeDependencies = {
        denque: directorySeal(join(root, "node_modules/denque")),
        "google-protobuf": directorySeal(join(root, "node_modules/google-protobuf")),
    };
    const requireFromRoot = createRequire(join(root, "package.json"));
    const runtimeResolution = Object.fromEntries(
        Object.entries(runtimeDependencies).map(([name, dependency]) => {
            const resolvedPath = requireFromRoot.resolve(name);
            const realPath = realpathSync(resolvedPath);
            if (!isPathWithin(realPath, dependency.realRoot)) {
                throw new Error(`${name} resolved outside its sealed dependency root: ${realPath}`);
            }
            return [name, { resolvedPath, realPath, withinSealedRoot: true as const }];
        }),
    );
    const reportWithoutIdentity = {
        root,
        realRoot: realpathSync(root),
        srcEntryCount: entries.length,
        srcBytes: sum(entries.map((entry) => entry.bytes)),
        srcTreeManifestSha256: digest(entries),
        packageJson: fileSeal(join(root, "package.json")),
        tsconfigJson: fileSeal(join(root, "tsconfig.json")),
        bunfigToml: fileSeal(join(root, "bunfig.toml")),
        workspaceLock: fileSeal(workspaceLockPath),
        runtimeDependencies,
        runtimeResolution,
        dependencyRealpaths: { rootNodeModules, workspaceNodeModules },
        bunExecutable: fileSeal(process.execPath),
    };
    return {
        entries,
        report: { ...reportWithoutIdentity, identitySha256: digest(reportWithoutIdentity) },
    };
}

function sourceDelta(baseline: ISourceSeal, candidate: ISourceSeal): Record<string, unknown> {
    const before = new Map(baseline.entries.map((entry) => [entry.path, entry]));
    const after = new Map(candidate.entries.map((entry) => [entry.path, entry]));
    const differences = [...new Set([...before.keys(), ...after.keys()])]
        .sort()
        .filter((path) => canonicalJson(before.get(path)) !== canonicalJson(after.get(path)))
        .map((path) => ({
            path,
            change: !before.has(path) ? "added" : !after.has(path) ? "deleted" : "modified",
            baselineSha256: before.get(path)?.sha256 ?? null,
            candidateSha256: after.get(path)?.sha256 ?? null,
        }));
    const actual = differences.map(({ path, change }) => ({ path, change }));
    if (canonicalJson(actual) !== canonicalJson(EXPECTED_SOURCE_DELTA)) {
        throw new Error(
            `Unexpected runtime delta: expected=${canonicalJson(EXPECTED_SOURCE_DELTA)} actual=${canonicalJson(actual)}`,
        );
    }
    return {
        exactExpected: true,
        expected: EXPECTED_SOURCE_DELTA,
        actual,
        changedEntryCount: differences.length,
        manifestSha256: digest(differences),
        differences,
    };
}

function shouldScrub(key: string): boolean {
    return (
        SCRUBBED_ENVIRONMENT_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
        EXACT_GOVERNED_ENVIRONMENT_KEYS.some((exact) => key === exact)
    );
}

function scrubEnvironment(): { scrubbedKeys: string[]; restore: () => void } {
    const saved = new Map<string, string>();
    for (const key of Object.keys(process.env)) {
        if (!shouldScrub(key)) continue;
        const value = process.env[key];
        if (value !== undefined) saved.set(key, value);
        delete process.env[key];
    }
    return {
        scrubbedKeys: [...saved.keys()].sort(compareStrings),
        restore: () => {
            for (const key of Object.keys(process.env)) if (shouldScrub(key)) delete process.env[key];
            for (const [key, value] of saved) process.env[key] = value;
        },
    };
}

function governedEnvironmentSnapshot(): IGovernedEnvironmentSnapshot {
    const behaviorEntries = Object.keys(process.env)
        .filter(shouldScrub)
        .sort(compareStrings)
        .map((key) => ({ key, value: process.env[key] }));
    const runtimeEntries = Object.entries(REQUIRED_RUNTIME_ENVIRONMENT)
        .sort(([left], [right]) => compareStrings(left, right))
        .map(([key, expected]) => ({ key, expected, observed: process.env[key] ?? null }));
    return {
        behaviorEntries,
        runtimeEntries,
        hocBreakDebug: process.env.HOC_BREAK_DEBUG ?? null,
        sha256: digest({ behaviorEntries, runtimeEntries, hocBreakDebug: process.env.HOC_BREAK_DEBUG ?? null }),
    };
}

function assertScopedEnvironment(environment: Readonly<Record<string, string | undefined>>, phase: string): void {
    const expected = Object.entries(environment)
        .filter(([key, value]) => shouldScrub(key) && value !== undefined)
        .sort(([left], [right]) => compareStrings(left, right));
    const actual = Object.keys(process.env)
        .filter(shouldScrub)
        .sort(compareStrings)
        .map((key) => [key, process.env[key]] as const);
    if (canonicalJson(actual) !== canonicalJson(expected)) {
        throw new Error(
            `${phase} governed environment mismatch: expected=${canonicalJson(expected)} actual=${canonicalJson(actual)}`,
        );
    }
    if (process.env.HOC_BREAK_DEBUG !== undefined) throw new Error(`${phase} enabled HOC_BREAK_DEBUG`);
}

function installEnvironment(environment: Readonly<Record<string, string | undefined>>): Map<string, string> {
    const saved = new Map<string, string>();
    for (const key of Object.keys(process.env)) {
        if (!shouldScrub(key)) continue;
        const value = process.env[key];
        if (value !== undefined) saved.set(key, value);
        delete process.env[key];
    }
    for (const [key, value] of Object.entries(environment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    return saved;
}

function restoreEnvironment(saved: ReadonlyMap<string, string>): void {
    for (const key of Object.keys(process.env)) if (shouldScrub(key)) delete process.env[key];
    for (const [key, value] of saved) process.env[key] = value;
}

function withEnvironment<T>(environment: Readonly<Record<string, string | undefined>>, callback: () => T): T {
    const saved = installEnvironment(environment);
    try {
        assertScopedEnvironment(environment, "scoped callback preflight");
        const result = callback();
        assertScopedEnvironment(environment, "scoped callback postflight");
        return result;
    } finally {
        restoreEnvironment(saved);
    }
}

async function withEnvironmentAsync<T>(
    environment: Readonly<Record<string, string | undefined>>,
    callback: () => Promise<T>,
): Promise<T> {
    const saved = installEnvironment(environment);
    try {
        assertScopedEnvironment(environment, "scoped async callback preflight");
        const result = await callback();
        assertScopedEnvironment(environment, "scoped async callback postflight");
        return result;
    } finally {
        restoreEnvironment(saved);
    }
}

async function loadVariant(label: VariantLabel, root: string): Promise<IVariant> {
    const profile = (await import(
        pathToFileURL(join(root, "src/ai/versions/v0_8_a13_profile.ts")).href
    )) as IA13ProfileModule;
    const fullEnvironment = profile.buildV08A13SearchEnvironment(AI_VERSION);
    const environment = Object.freeze({ ...fullEnvironment, ...FIXED_ENVIRONMENT_OVERRIDES });
    const [army, battle, productionSearch] = await withEnvironmentAsync(environment, () =>
        Promise.all([
            import(pathToFileURL(join(root, "src/simulation/army.ts")).href) as Promise<IArmyModule>,
            import(pathToFileURL(join(root, "src/simulation/battle_engine.ts")).href) as Promise<IBattleModule>,
            import(
                pathToFileURL(join(root, "src/simulation/v0_8_a13_search.ts")).href
            ) as Promise<IProductionSearchModule>,
        ]),
    );
    const promoted = withEnvironment(environment, () =>
        productionSearch.shouldUseDefaultV08A13Search({ greenVersion: AI_VERSION, redVersion: AI_VERSION }),
    );
    if (promoted) throw new Error(`${label} unexpectedly selected the bounded A13 constructor`);
    if (
        environment.V08_A13_SEARCH !== "0" ||
        environment.V07_SEARCH !== "1" ||
        environment.SEARCH_DECISION_DEADLINE_MS !== undefined ||
        environment.SEARCH_CIRCUIT_BREAKER_MS !== undefined
    ) {
        throw new Error(`${label} did not construct the deadline-free generic-search environment`);
    }
    const environmentEntries = (value: Readonly<Record<string, string | undefined>>): unknown =>
        Object.entries(value)
            .sort(([left], [right]) => compareStrings(left, right))
            .map(([key, child]) => ({ key, value: child }));
    return {
        label,
        army,
        battle,
        environment,
        profile: {
            profileSha256: digest(profile.V08_A13_PROFILE),
            genomeSha256: digest(profile.V08_A13_GENOME),
            searchSha256: digest(profile.V08_A13_SEARCH),
            policySha256: digest(profile.V08_A13_POLICY),
            fullEnvironmentSha256: digest(environmentEntries(fullEnvironment)),
            activeEnvironmentSha256: digest(environmentEntries(environment)),
            genericSearchDriverSelected: true,
            deadlineFree: true,
        },
    };
}

function nonnegativeInteger(value: unknown, name: string): number {
    const parsed = Number(value ?? 0);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} is not a nonnegative integer`);
    return parsed;
}

function run(
    variant: IVariant,
    seed: number,
    gridType: number,
    maxLaps: number,
    phase: string,
    observeSearch = false,
): IRun {
    const roster = withEnvironment(variant.environment, () => variant.army.buildRoster(variant.army.makeRng(seed)));
    const inputRosterCanonical = canonicalJson(roster);
    const catalogs: Array<{ getStats: () => unknown }> = [];
    let decisions = 0;
    const config: Record<string, unknown> = {
        greenVersion: AI_VERSION,
        redVersion: AI_VERSION,
        roster,
        seed,
        gridType,
        maxLaps,
    };
    if (observeSearch) {
        config.decisionObserver = (observation: unknown): void => {
            decisions++;
            const context = (observation as { context?: { decisionPathCatalog?: unknown } } | null)?.context;
            const catalog = context?.decisionPathCatalog;
            if (
                catalog &&
                typeof catalog === "object" &&
                "getStats" in catalog &&
                typeof (catalog as { getStats?: unknown }).getStats === "function"
            ) {
                catalogs.push(catalog as { getStats: () => unknown });
            }
        };
    }
    const measured = withEnvironment(variant.environment, () => {
        const started = process.hrtime.bigint();
        const result = variant.battle.runMatch(config);
        const elapsedNs = Number(process.hrtime.bigint() - started);
        return { result, elapsedNs };
    });
    const { result, elapsedNs } = measured;
    if (!Number.isSafeInteger(elapsedNs) || elapsedNs <= 0) throw new Error(`Invalid ${variant.label} timing`);
    const rejected =
        nonnegativeInteger(result.rejectedGreen, "rejectedGreen") +
        nonnegativeInteger(result.rejectedRed, "rejectedRed");
    if (rejected !== 0) {
        throw new Error(`Rejected action in ${variant.label} ${phase} seed=${seed} gridType=${gridType}`);
    }
    const endReason = String(result.endReason ?? "");
    if (endReason !== "elimination" && endReason !== "turn_cap") {
        throw new Error(`Invalid end reason ${endReason} in ${variant.label} ${phase}`);
    }
    if (!Array.isArray(result.actions) || !result.placements || !Array.isArray(result.roster)) {
        throw new Error(`Incomplete result in ${variant.label} ${phase}`);
    }
    const totalActions = nonnegativeInteger(result.totalActions, "totalActions");
    if (totalActions !== result.actions.length) throw new Error(`Action count mismatch in ${variant.label} ${phase}`);
    const rosterCanonical = canonicalJson(result.roster);
    if (rosterCanonical !== inputRosterCanonical) throw new Error(`Roster mutation in ${variant.label} ${phase}`);
    let search: ISearchCounters | null = null;
    if (observeSearch) {
        if (decisions === 0 || catalogs.length !== decisions || new Set(catalogs).size !== catalogs.length) {
            throw new Error(`Search observation failed in ${variant.label} ${phase}`);
        }
        search = { decisions, catalogs: catalogs.length, requests: 0, hits: 0, misses: 0, bypasses: 0 };
        for (const catalog of catalogs) {
            const stats = catalog.getStats() as Record<string, unknown>;
            const requests = nonnegativeInteger(stats.requests, "requests");
            const hits = nonnegativeInteger(stats.hits, "hits");
            const misses = nonnegativeInteger(stats.misses, "misses");
            const bypasses = nonnegativeInteger(stats.bypasses, "bypasses");
            if (requests !== hits + misses + bypasses) throw new Error("Search accounting mismatch");
            search.requests += requests;
            search.hits += hits;
            search.misses += misses;
            search.bypasses += bypasses;
        }
        if (search.requests === 0) throw new Error(`No search requests in ${variant.label} ${phase}`);
    }
    return {
        elapsedNs,
        canonical: {
            result: canonicalJson(result),
            actions: canonicalJson(result.actions),
            placements: canonicalJson(result.placements),
            roster: rosterCanonical,
        },
        endReason,
        totalActions,
        search,
    };
}

function assertExact(baseline: IRun, candidate: IRun, seed: number, gridType: number, phase: string): IExactDigests {
    const fields = ["result", "actions", "placements", "roster"] as const;
    for (const field of fields) {
        if (baseline.canonical[field] !== candidate.canonical[field]) {
            throw new Error(`Semantic ${field} mismatch in ${phase} seed=${seed} gridType=${gridType}`);
        }
    }
    if (baseline.endReason !== candidate.endReason || baseline.totalActions !== candidate.totalActions) {
        throw new Error(`Semantic summary mismatch in ${phase} seed=${seed} gridType=${gridType}`);
    }
    return {
        resultSha256: sha256(baseline.canonical.result),
        actionsSha256: sha256(baseline.canonical.actions),
        placementsSha256: sha256(baseline.canonical.placements),
        rosterSha256: sha256(baseline.canonical.roster),
    };
}

function writeJsonAtomicExclusive(pathInput: string, value: unknown): void {
    const path = resolve(pathInput);
    const parent = dirname(path);
    if (realpathSync(parent) !== parent || lstatSync(parent).isSymbolicLink()) {
        throw new Error(`Output parent changed or is not canonical: ${parent}`);
    }
    if (existsSync(path)) throw new Error(`Refusing to overwrite ${path}`);
    const temporary = join(parent, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    try {
        linkSync(temporary, path);
    } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
    }
}

function isForbiddenExecArgv(value: string): boolean {
    return FORBIDDEN_EXEC_ARGV_FLAGS.some(
        (flag) =>
            value === flag ||
            value.startsWith(`${flag}=`) ||
            (flag === "-r" && value.startsWith("-r") && value.length > 2),
    );
}

function auditRuntimeInjection(): Record<string, unknown> {
    const environmentKeys = Object.keys(process.env).sort(compareStrings);
    const presentEnvironmentKeys = environmentKeys.filter(
        (key) =>
            FORBIDDEN_INJECTION_ENVIRONMENT_KEYS.includes(
                key as (typeof FORBIDDEN_INJECTION_ENVIRONMENT_KEYS)[number],
            ) || FORBIDDEN_INJECTION_ENVIRONMENT_PREFIXES.some((prefix) => key.startsWith(prefix)),
    );
    const unexpectedBunEnvironmentKeys = environmentKeys.filter(
        (key) => key.startsWith("BUN_") && !ALLOWED_BUN_ENVIRONMENT_KEYS.includes(key),
    );
    const unexpectedLocaleEnvironmentKeys = environmentKeys.filter(
        (key) => key.startsWith("LC_") && !GOVERNED_LOCALE_ENVIRONMENT_KEYS.includes(key),
    );
    const requiredEnvironment = Object.fromEntries(
        Object.entries(REQUIRED_RUNTIME_ENVIRONMENT).map(([key, expected]) => [
            key,
            { expected, observed: process.env[key] ?? null },
        ]),
    );
    const governedEnvironment = Object.fromEntries(
        Object.keys(REQUIRED_RUNTIME_ENVIRONMENT)
            .sort(compareStrings)
            .map((key) => [key, process.env[key] ?? null]),
    );
    const mismatchedRequiredEnvironment = Object.entries(REQUIRED_RUNTIME_ENVIRONMENT)
        .filter(([key, expected]) => process.env[key] !== expected)
        .map(([key]) => key);
    const execArgv = [...process.execArgv];
    const forbiddenExecArgv = execArgv.filter(isForbiddenExecArgv);
    if (
        presentEnvironmentKeys.length > 0 ||
        unexpectedBunEnvironmentKeys.length > 0 ||
        unexpectedLocaleEnvironmentKeys.length > 0 ||
        mismatchedRequiredEnvironment.length > 0 ||
        forbiddenExecArgv.length > 0 ||
        execArgv.length > 0
    ) {
        throw new Error(
            `Runtime injection audit failed: environment=${presentEnvironmentKeys.join(",")} ` +
                `unexpectedBun=${unexpectedBunEnvironmentKeys.join(",")} ` +
                `unexpectedLocale=${unexpectedLocaleEnvironmentKeys.join(",")} ` +
                `required=${mismatchedRequiredEnvironment.join(",")} execArgv=${execArgv.join(",")}`,
        );
    }
    return {
        passed: true,
        forbiddenEnvironmentKeys: FORBIDDEN_INJECTION_ENVIRONMENT_KEYS,
        forbiddenEnvironmentPrefixes: FORBIDDEN_INJECTION_ENVIRONMENT_PREFIXES,
        presentEnvironmentKeys,
        allowedBunEnvironmentKeys: ALLOWED_BUN_ENVIRONMENT_KEYS,
        unexpectedBunEnvironmentKeys,
        governedLocaleEnvironmentKeys: GOVERNED_LOCALE_ENVIRONMENT_KEYS,
        unexpectedLocaleEnvironmentKeys,
        requiredEnvironment,
        mismatchedRequiredEnvironment,
        forbiddenExecArgvFlags: FORBIDDEN_EXEC_ARGV_FLAGS,
        execArgv,
        forbiddenExecArgv,
        execArgvExactlyEmpty: true,
        requiredExecutionEnvironment: REQUIRED_RUNTIME_ENVIRONMENT,
        governedEnvironment,
    };
}

function auditPinnedHost(): IPinnedHostAudit {
    const bunExecutable = fileSeal(process.execPath);
    const observed = {
        platform: platform(),
        release: release(),
        arch: arch(),
        cpuModel: cpus()[0]?.model ?? "unknown",
        logicalCpus: cpus().length,
        bunVersion: Bun.version,
        bunRevision: Bun.revision,
        bunExecutableSha256: bunExecutable.sha256,
    };
    if (canonicalJson(observed) !== canonicalJson(EXPECTED_HOST)) {
        throw new Error(
            `Pinned host mismatch: expected=${canonicalJson(EXPECTED_HOST)} actual=${canonicalJson(observed)}`,
        );
    }
    return { pinned: true, expected: EXPECTED_HOST, observed, bunExecutable };
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
        { label: "process.hrtime", owner: process, key: "hrtime", value: process.hrtime },
        {
            label: "process.hrtime.bigint",
            owner: process.hrtime,
            key: "bigint",
            value: process.hrtime.bigint,
        },
    ];
    const functions = locations.map((location, index) => {
        const expected = EXPECTED_NATIVE_FUNCTIONS[index];
        if (location.label !== expected.label) throw new Error(`Realm audit definition drift at ${location.label}`);
        const descriptor = Object.getOwnPropertyDescriptor(location.owner, location.key);
        const expectedEnumerable = location.label.startsWith("process.hrtime");
        if (
            !descriptor ||
            descriptor.value !== location.value ||
            descriptor.writable !== true ||
            descriptor.enumerable !== expectedEnumerable ||
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
            descriptor: { writable: true, enumerable: expectedEnumerable, configurable: true, data: true },
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

async function main(): Promise<void> {
    const cli = commandLine();
    if (!cli) return;
    const canonicalEncoding = assertCanonicalEncoding();
    const runtimeInjectionBefore = auditRuntimeInjection();
    const pinnedHost = auditPinnedHost();
    const bunConfigBefore = auditBunConfigFiles();
    const realmBefore = auditStandardNumericRealm();
    const scrubbedEnvironment = scrubEnvironment();
    try {
        const governedBefore = governedEnvironmentSnapshot();
        if (governedBefore.behaviorEntries.length !== 0) {
            throw new Error("Governed behavior environment was not empty after startup scrub");
        }
        const runnerBefore = fileSeal(RUNNER_PATH);
        const runnerCwdBefore = runnerWorkspaceSeal();
        const protocolBinding = loadProtocolBinding(cli, runnerBefore);
        const baselineBefore = sourceSeal(cli.baselineRoot);
        const candidateBefore = sourceSeal(cli.candidateRoot);
        const dependencyIdentity = (dependencies: Record<string, IDirectorySeal>): unknown =>
            Object.fromEntries(
                Object.entries(dependencies).map(([name, dependency]) => [
                    name,
                    {
                        realRoot: dependency.realRoot,
                        entryCount: dependency.entryCount,
                        bytes: dependency.bytes,
                        manifestSha256: dependency.manifestSha256,
                    },
                ]),
            );
        const sharedInputs = {
            packageJson: baselineBefore.report.packageJson.sha256 === candidateBefore.report.packageJson.sha256,
            tsconfigJson: baselineBefore.report.tsconfigJson.sha256 === candidateBefore.report.tsconfigJson.sha256,
            bunfigToml: baselineBefore.report.bunfigToml.sha256 === candidateBefore.report.bunfigToml.sha256,
            workspaceLock: baselineBefore.report.workspaceLock.sha256 === candidateBefore.report.workspaceLock.sha256,
            dependencies:
                canonicalJson(dependencyIdentity(baselineBefore.report.runtimeDependencies)) ===
                canonicalJson(dependencyIdentity(candidateBefore.report.runtimeDependencies)),
            dependencyResolution:
                canonicalJson(
                    Object.fromEntries(
                        Object.entries(baselineBefore.report.runtimeResolution).map(([name, resolution]) => [
                            name,
                            resolution.realPath,
                        ]),
                    ),
                ) ===
                canonicalJson(
                    Object.fromEntries(
                        Object.entries(candidateBefore.report.runtimeResolution).map(([name, resolution]) => [
                            name,
                            resolution.realPath,
                        ]),
                    ),
                ),
            bunExecutable: baselineBefore.report.bunExecutable.sha256 === candidateBefore.report.bunExecutable.sha256,
            runnerPackageJson:
                runnerCwdBefore.packageJson.sha256 === baselineBefore.report.packageJson.sha256 &&
                runnerCwdBefore.packageJson.sha256 === candidateBefore.report.packageJson.sha256,
            runnerTsconfigJson:
                runnerCwdBefore.tsconfigJson.sha256 === baselineBefore.report.tsconfigJson.sha256 &&
                runnerCwdBefore.tsconfigJson.sha256 === candidateBefore.report.tsconfigJson.sha256,
            runnerBunfigToml:
                runnerCwdBefore.bunfigToml.sha256 === baselineBefore.report.bunfigToml.sha256 &&
                runnerCwdBefore.bunfigToml.sha256 === candidateBefore.report.bunfigToml.sha256,
            runnerWorkspaceLock:
                runnerCwdBefore.workspaceLock.sha256 === baselineBefore.report.workspaceLock.sha256 &&
                runnerCwdBefore.workspaceLock.sha256 === candidateBefore.report.workspaceLock.sha256,
        };
        if (Object.values(sharedInputs).some((exact) => !exact)) {
            throw new Error(`Cross-root input mismatch: ${canonicalJson(sharedInputs)}`);
        }
        const delta = sourceDelta(baselineBefore, candidateBefore);
        const baseline = await loadVariant("baseline", cli.baselineRoot);
        const candidate = await loadVariant("candidate", cli.candidateRoot);
        if (canonicalJson(baseline.profile) !== canonicalJson(candidate.profile)) {
            throw new Error("Cross-root A13 profile identity differs");
        }

        const warmupRows: Array<Record<string, unknown>> = [];
        for (let index = 0; index < cli.gridTypes.length; index++) {
            const gridType = cli.gridTypes[index];
            const natural: TaskOrder = index % 2 === 0 ? "AB" : "BA";
            const order: TaskOrder = cli.invertOrder ? (natural === "AB" ? "BA" : "AB") : natural;
            const first =
                order === "AB"
                    ? run(baseline, cli.warmupSeed, gridType, cli.maxLaps, "warmup", true)
                    : run(candidate, cli.warmupSeed, gridType, cli.maxLaps, "warmup", true);
            const second =
                order === "AB"
                    ? run(candidate, cli.warmupSeed, gridType, cli.maxLaps, "warmup", true)
                    : run(baseline, cli.warmupSeed, gridType, cli.maxLaps, "warmup", true);
            const baselineRun = order === "AB" ? first : second;
            const candidateRun = order === "AB" ? second : first;
            const exactDigests = assertExact(baselineRun, candidateRun, cli.warmupSeed, gridType, "warmup");
            if (canonicalJson(baselineRun.search) !== canonicalJson(candidateRun.search)) {
                throw new Error(`Warmup search mismatch on grid ${gridType}`);
            }
            warmupRows.push({
                gridType,
                order,
                resultSha256: exactDigests.resultSha256,
                actions: baselineRun.totalActions,
                search: baselineRun.search,
                exact: true,
                timingDiscarded: true,
            });
        }

        const tasks = cli.seeds.flatMap((seed, seedIndex) =>
            cli.gridTypes.map((gridType, gridIndex) => ({ seed, seedIndex, gridType, gridIndex })),
        );
        const rows: IRow[] = [];
        for (let ordinal = 0; ordinal < tasks.length; ordinal++) {
            const task = tasks[ordinal];
            const natural: TaskOrder = (task.seedIndex + task.gridIndex) % 2 === 0 ? "AB" : "BA";
            const order: TaskOrder = cli.invertOrder ? (natural === "AB" ? "BA" : "AB") : natural;
            const first =
                order === "AB"
                    ? run(baseline, task.seed, task.gridType, cli.maxLaps, "measured")
                    : run(candidate, task.seed, task.gridType, cli.maxLaps, "measured");
            const second =
                order === "AB"
                    ? run(candidate, task.seed, task.gridType, cli.maxLaps, "measured")
                    : run(baseline, task.seed, task.gridType, cli.maxLaps, "measured");
            const baselineRun = order === "AB" ? first : second;
            const candidateRun = order === "AB" ? second : first;
            const exactDigests = assertExact(baselineRun, candidateRun, task.seed, task.gridType, "measured");
            rows.push({
                ordinal,
                order,
                seed: task.seed,
                gridType: task.gridType,
                baselineNs: baselineRun.elapsedNs,
                candidateNs: candidateRun.elapsedNs,
                ratio: candidateRun.elapsedNs / baselineRun.elapsedNs,
                resultSha256: exactDigests.resultSha256,
                candidateResultSha256: exactDigests.resultSha256,
                actionsSha256: exactDigests.actionsSha256,
                candidateActionsSha256: exactDigests.actionsSha256,
                placementsSha256: exactDigests.placementsSha256,
                candidatePlacementsSha256: exactDigests.placementsSha256,
                rosterSha256: exactDigests.rosterSha256,
                candidateRosterSha256: exactDigests.rosterSha256,
                endReason: baselineRun.endReason,
                candidateEndReason: candidateRun.endReason,
                baselineTotalActions: baselineRun.totalActions,
                candidateTotalActions: candidateRun.totalActions,
                exact: true,
            });
        }

        const baselineAfter = sourceSeal(cli.baselineRoot);
        const candidateAfter = sourceSeal(cli.candidateRoot);
        if (
            baselineBefore.report.identitySha256 !== baselineAfter.report.identitySha256 ||
            candidateBefore.report.identitySha256 !== candidateAfter.report.identitySha256
        ) {
            throw new Error("Source or dependency input changed during capture");
        }
        const runnerAfter = fileSeal(RUNNER_PATH);
        if (canonicalJson(runnerBefore) !== canonicalJson(runnerAfter))
            throw new Error("Runner changed during capture");
        const protocolAfterBinding = loadProtocolBinding(cli, runnerAfter);
        if (canonicalJson(protocolBinding.before) !== canonicalJson(protocolAfterBinding.before)) {
            throw new Error("Companion protocol changed during capture");
        }
        const runnerCwdAfter = runnerWorkspaceSeal();
        if (canonicalJson(runnerCwdBefore) !== canonicalJson(runnerCwdAfter)) {
            throw new Error("Runner cwd package, bunfig, or workspace lock changed during capture");
        }
        const bunConfigAfter = auditBunConfigFiles();
        if (canonicalJson(bunConfigBefore) !== canonicalJson(bunConfigAfter)) {
            throw new Error("Bun config-file audit changed during capture");
        }
        const realmAfter = auditStandardNumericRealm();
        if (canonicalJson(realmBefore) !== canonicalJson(realmAfter)) {
            throw new Error("Numeric realm intrinsics changed during capture");
        }
        const governedAfter = governedEnvironmentSnapshot();
        if (canonicalJson(governedBefore) !== canonicalJson(governedAfter)) {
            throw new Error("Governed environment changed during capture");
        }
        const runtimeInjectionAfter = auditRuntimeInjection();
        if (canonicalJson(runtimeInjectionBefore) !== canonicalJson(runtimeInjectionAfter)) {
            throw new Error("Runtime injection envelope changed during capture");
        }
        const pinnedHostAfter = auditPinnedHost();
        if (canonicalJson(pinnedHost) !== canonicalJson(pinnedHostAfter)) {
            throw new Error("Pinned host identity changed during capture");
        }
        const baselineTotalNs = sum(rows.map((row) => row.baselineNs));
        const candidateTotalNs = sum(rows.map((row) => row.candidateNs));
        const semanticRows = rows.map((row) => ({
            seed: row.seed,
            gridType: row.gridType,
            resultSha256: row.resultSha256,
            actionsSha256: row.actionsSha256,
            placementsSha256: row.placementsSha256,
            rosterSha256: row.rosterSha256,
            endReason: row.endReason,
            totalActions: row.baselineTotalActions,
        }));
        const report = {
            schema: SCHEMA,
            attemptId: cli.attemptId,
            generatedAt: new Date().toISOString(),
            command: {
                captureId: cli.captureId,
                smoke: cli.smoke,
                invertOrder: cli.invertOrder,
                seeds: cli.seeds,
                gridTypes: cli.gridTypes,
                maxLaps: cli.maxLaps,
                warmupSeed: cli.warmupSeed,
            },
            protocol: {
                schema: PROTOCOL_SCHEMA,
                before: protocolBinding.before,
                after: protocolAfterBinding.before,
                unchanged: true,
                captureRunner: protocolBinding.captureRunner,
                schedule: protocolBinding.schedule,
                scheduleExact: protocolBinding.scheduleExact,
            },
            host: { ...pinnedHost.observed, pinned: true, bunExecutable: pinnedHost.bunExecutable },
            realm: {
                startupInvariant: "Fresh pinned Bun realm with standard numeric and process.hrtime intrinsics",
                preloadHooksAbsent: true,
                runtimeInjection: {
                    before: runtimeInjectionBefore,
                    after: runtimeInjectionAfter,
                    unchanged: true,
                },
                standardDescriptorsAndNativeSourcesVerified: true,
                before: realmBefore,
                after: realmAfter,
                unchanged: true,
            },
            environment: {
                governedBefore,
                governedAfter,
                unchanged: true,
                scrubbedStartupBehaviorKeys: scrubbedEnvironment.scrubbedKeys,
                requiredRuntimeEnvironment: REQUIRED_RUNTIME_ENVIRONMENT,
                bunConfigFiles: { before: bunConfigBefore, after: bunConfigAfter, unchanged: true },
                runnerCwd: { before: runnerCwdBefore, after: runnerCwdAfter, unchanged: true },
            },
            digest: {
                ...canonicalEncoding,
                comparison:
                    "Canonical semantic payload strings are compared byte-for-byte outside timing before SHA-256.",
                payloads: ["fullResult", "actions", "placements", "roster"],
            },
            source: {
                runnerBefore,
                runnerAfter,
                runnerUnchanged: true,
                baselineBefore: baselineBefore.report,
                baselineAfter: baselineAfter.report,
                candidateBefore: candidateBefore.report,
                candidateAfter: candidateAfter.report,
                delta,
                sharedInputs,
                postflightUnchanged: true,
            },
            profile: { crossRootExact: true, baseline: baseline.profile, candidate: candidate.profile },
            warmup: { passed: true, discarded: true, rows: warmupRows },
            work: {
                captureId: cli.captureId,
                protocolScheduleExact: protocolBinding.scheduleExact,
                serial: true,
                measuredTasks: rows.length,
                measuredMatchesPerVariant: rows.length,
                measuredMatchesTotal: rows.length * 2,
                warmupMatchesPerVariant: cli.gridTypes.length,
                configuredMaxLaps: cli.maxLaps,
                abTasks: rows.filter((row) => row.order === "AB").length,
                baTasks: rows.filter((row) => row.order === "BA").length,
            },
            exactness: {
                passed: true,
                taskCount: rows.length,
                semanticMismatchCount: 0,
                rejectedActions: 0,
                stuckMatches: 0,
                exceptions: 0,
                canonicalEncodingSchema: CANONICAL_ENCODING_SCHEMA,
                comparedCanonicalPayloadStringsBeforeHashing: true,
                rowsSha256: digest(semanticRows),
            },
            performance: {
                baselineTotalMs: baselineTotalNs / 1_000_000,
                candidateTotalMs: candidateTotalNs / 1_000_000,
                totalRatio: candidateTotalNs / baselineTotalNs,
            },
            qualification: {
                eligible: false,
                passed: false,
                reason: "A single capture never qualifies; use the sealed ten-capture replication runner.",
            },
            rows,
        };
        writeJsonAtomicExclusive(cli.out, report);
        console.log(
            JSON.stringify({
                out: cli.out,
                captureId: cli.captureId,
                tasks: rows.length,
                exact: true,
                totalRatio: report.performance.totalRatio,
                smoke: cli.smoke,
            }),
        );
    } finally {
        scrubbedEnvironment.restore();
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
});
