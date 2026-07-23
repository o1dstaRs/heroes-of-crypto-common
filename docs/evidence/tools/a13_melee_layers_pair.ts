#!/usr/bin/env bun

/**
 * Sealed two-source-root macro qualification for A13 Workstream 5 melee target-layer construction.
 *
 * The runner compares complete source roots and accepts exactly this runtime delta:
 *
 *   modified  src/ai/ai.ts
 *   added     src/ai/internal/melee_target_layers.ts
 *
 * Each root supplies its own runMatch/buildRoster implementation. The fixed A13 profile is loaded from
 * each root and required to match exactly. V08_A13_SEARCH=0 deliberately selects the generic SearchDriver:
 * it consumes the full A13 environment while the two wall-clock cutoff variables are removed. This makes
 * semantic comparison deterministic; it is not a production-deadline latency measurement.
 *
 * Evidence run (80 serial AB/BA tasks):
 *   bun docs/evidence/tools/a13_melee_layers_pair.ts \
 *     --baseline-root=/tmp/common-baseline \
 *     --candidate-root=/tmp/common-candidate \
 *     --out=/tmp/a13-melee-layers-pair.json
 *
 * Structural smoke:
 *   bun docs/evidence/tools/a13_melee_layers_pair.ts \
 *     --smoke \
 *     --baseline-root=/tmp/common-baseline \
 *     --candidate-root=/tmp/common-candidate \
 *     --out=/tmp/a13-melee-layers-pair-smoke.json
 */

import { createHash } from "node:crypto";
import {
    existsSync,
    linkSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    readlinkSync,
    realpathSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { arch, cpus, platform, release } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const SCHEMA = "heroes-of-crypto/a13-melee-layers-pair/v1" as const;
const UINT32_MAX = 0xffff_ffff;
const DEFAULT_BOOTSTRAP_SEED = 0xa135_1a9e;
const DEFAULT_BOOTSTRAP_SAMPLES = 20_000;
const DEFAULT_SEEDS = Object.freeze(Array.from({ length: 20 }, (_, index) => index + 1));
const DEFAULT_GRID_TYPES = Object.freeze([1, 2, 3, 4]);
const DEFAULT_MAX_LAPS = 2;
const DEFAULT_WARMUP_SEED = UINT32_MAX;
const RUNNER_PATH = fileURLToPath(import.meta.url);
const AI_VERSION = "v0.8";
const EXPECTED_SOURCE_DELTA = Object.freeze([
    { path: "ai/ai.ts", change: "modified" },
    { path: "ai/internal/melee_target_layers.ts", change: "added" },
] as const);
const SCRUBBED_ENVIRONMENT_PREFIXES = ["SEARCH_", "V05_", "V06_", "V07_", "V08_", "Q2_", "SIM_"] as const;
const FIXED_ENVIRONMENT_OVERRIDES = Object.freeze({
    V08_A13_SEARCH: "0",
    V07_SEARCH: "1",
    Q2_ORACLE: undefined,
    Q2_WAIT_ABLATION: undefined,
    SEARCH_DECISION_DEADLINE_MS: undefined,
    SEARCH_CIRCUIT_BREAKER_MS: undefined,
    LIVETWIN: "1",
    FIGHT_MELEE_ROSTERS: "0",
});

type VariantLabel = "baseline" | "candidate";
type TaskOrder = "AB" | "BA";

interface ICliOptions {
    baselineRoot: string;
    candidateRoot: string;
    out: string;
    seeds: number[];
    gridTypes: number[];
    maxLaps: number;
    warmupSeed: number;
    bootstrapSeed: number;
    bootstrapSamples: number;
    smoke: boolean;
    invertOrder: boolean;
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

interface IProfileSeal {
    profileSha256: string;
    genomeSha256: string;
    searchSha256: string;
    policySha256: string;
    fullEnvironmentSha256: string;
    activeEnvironmentSha256: string;
    fullEnvironment: IEnvironmentEntry[];
    activeEnvironment: IEnvironmentEntry[];
    genericSearchDriverSelected: true;
    deadlineFree: true;
}

interface IVariant {
    label: VariantLabel;
    root: string;
    army: IArmyModule;
    battle: IBattleModule;
    environment: Readonly<Record<string, string | undefined>>;
    profile: IProfileSeal;
}

interface IEnvironmentEntry {
    key: string;
    value: string | null;
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

interface ISourceSealReport {
    root: string;
    realRoot: string;
    srcEntryCount: number;
    srcBytes: number;
    srcTreeManifestSha256: string;
    packageJson: IFileSeal;
    workspaceLock: IFileSeal;
    dependencyRealpaths: {
        rootNodeModules: string;
        workspaceNodeModules: string;
    };
    identitySha256: string;
}

interface ISourceSeal {
    entries: ITreeEntry[];
    report: ISourceSealReport;
}

interface IRun {
    elapsedNs: number;
    resultSha256: string;
    actionsSha256: string;
    placementsSha256: string;
    rosterSha256: string;
    resultRosterSha256: string;
    endReason: string;
    totalActions: number;
    searchExercise: ISearchExercise | null;
}

interface ISearchExercise {
    decisionsObserved: number;
    catalogsObserved: number;
    requests: number;
    hits: number;
    misses: number;
    bypasses: number;
}

interface ITaskRow {
    ordinal: number;
    order: TaskOrder;
    seed: number;
    gridType: number;
    baselineNs: number;
    candidateNs: number;
    ratio: number;
    baselineTotalActions: number;
    candidateTotalActions: number;
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
    exact: true;
}

interface IWarmupRow {
    gridType: number;
    order: TaskOrder;
    baselineActions: number;
    candidateActions: number;
    resultSha256: string;
    baselineSearch: ISearchExercise;
    candidateSearch: ISearchExercise;
    exact: true;
    timingDiscarded: true;
}

interface IBootstrapIntervals {
    totalRatio95: [number, number];
    geometricMeanPairedRatio95: [number, number];
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
const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

function normalizedPath(path: string): string {
    return path.split(sep).join("/");
}

function printHelp(): void {
    console.log(`A13 melee target-layer sealed paired macro qualification

Usage:
  bun docs/evidence/tools/a13_melee_layers_pair.ts \\
    --baseline-root=ROOT --candidate-root=ROOT --out=REPORT.json [options]

Options:
  --seeds=1-20                    Default: 1-20 (smoke: 1-2)
  --grid-types=1,2,3,4            Default: 1,2,3,4 (smoke: 1,2)
  --max-laps=2                    Default: 2
  --warmup-seed=4294967295        Discarded balanced warmup on every map
  --bootstrap-seed=2704611998     Deterministic seed-cluster bootstrap seed
  --bootstrap-samples=20000       Default: 20000 (smoke: 1000)
  --invert-order                  Flip every measured and warmup AB/BA pair; individually ineligible
  --smoke                         Structural run; never marked qualified
  --help

The evidence gate requires exact task-by-task results and actions, total-ratio bootstrap upper95 <= 0.99,
point p50 and p99 paired ratios < 1, and every per-map point total ratio <= 1.05.`);
}

function parseIntegerList(value: string, name: string, min: number, max: number): number[] {
    const values: number[] = [];
    for (const rawToken of value.split(",")) {
        const token = rawToken.trim();
        const range = /^(\d+)-(\d+)$/.exec(token);
        if (range) {
            const first = Number(range[1]);
            const last = Number(range[2]);
            if (first > last || first < min || last > max) {
                throw new Error(`${name} contains invalid range ${token}`);
            }
            for (let current = first; current <= last; current++) values.push(current);
            continue;
        }
        const parsed = Number(token);
        if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
            throw new Error(`${name} contains invalid value ${token}`);
        }
        values.push(parsed);
    }
    if (values.length === 0 || new Set(values).size !== values.length) {
        throw new Error(`${name} must be non-empty and contain no duplicates`);
    }
    return values;
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
        "src/simulation/army.ts",
        "src/simulation/battle_engine.ts",
        "src/simulation/v0_8_a13_search.ts",
        "src/ai/versions/v0_8_a13_profile.ts",
    ]) {
        const fullPath = join(root, path);
        if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
            throw new Error(`Source root ${root} is missing ${path}`);
        }
    }
    if (!existsSync(join(root, "node_modules"))) {
        throw new Error(`Source root ${root} is missing node_modules`);
    }
    return root;
}

function commandLine(): ICliOptions | undefined {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        strict: true,
        allowPositionals: false,
        options: {
            help: { type: "boolean", default: false },
            smoke: { type: "boolean", default: false },
            "invert-order": { type: "boolean", default: false },
            "baseline-root": { type: "string" },
            "candidate-root": { type: "string" },
            out: { type: "string" },
            seeds: { type: "string" },
            "grid-types": { type: "string" },
            "max-laps": { type: "string" },
            "warmup-seed": { type: "string" },
            "bootstrap-seed": { type: "string" },
            "bootstrap-samples": { type: "string" },
        },
    });
    if (values.help) {
        printHelp();
        return undefined;
    }
    if (!values["baseline-root"]?.trim()) throw new Error("--baseline-root is required");
    if (!values["candidate-root"]?.trim()) throw new Error("--candidate-root is required");
    if (!values.out?.trim()) throw new Error("--out is required");
    const baselineRoot = requireRoot(values["baseline-root"]);
    const candidateRoot = requireRoot(values["candidate-root"]);
    if (realpathSync(baselineRoot) === realpathSync(candidateRoot)) {
        throw new Error("baseline and candidate roots must be distinct");
    }
    const out = resolve(values.out);
    if (existsSync(out)) throw new Error(`Refusing to overwrite output: ${out}`);
    const smoke = values.smoke ?? false;
    return {
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
        bootstrapSeed: parseIntegerList(
            values["bootstrap-seed"] ?? String(DEFAULT_BOOTSTRAP_SEED),
            "--bootstrap-seed",
            0,
            UINT32_MAX,
        )[0],
        bootstrapSamples: positiveInteger(
            values["bootstrap-samples"],
            smoke ? 1_000 : DEFAULT_BOOTSTRAP_SAMPLES,
            "--bootstrap-samples",
        ),
    };
}

function environmentEntries(environment: Readonly<Record<string, string | undefined>>): IEnvironmentEntry[] {
    return Object.entries(environment)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => ({ key, value: value ?? null }));
}

function activeEnvironment(
    fullEnvironment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
    return Object.freeze({ ...fullEnvironment, ...FIXED_ENVIRONMENT_OVERRIDES });
}

function shouldScrubEnvironmentKey(key: string): boolean {
    return (
        SCRUBBED_ENVIRONMENT_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
        key === "LIVETWIN" ||
        key === "FIGHT_MELEE_ROSTERS"
    );
}

function scrubExperimentEnvironment(): () => void {
    const saved = new Map<string, string>();
    for (const key of Object.keys(process.env)) {
        if (!shouldScrubEnvironmentKey(key)) continue;
        const value = process.env[key];
        if (value !== undefined) saved.set(key, value);
        delete process.env[key];
    }
    return (): void => {
        for (const key of Object.keys(process.env)) {
            if (shouldScrubEnvironmentKey(key)) delete process.env[key];
        }
        for (const [key, value] of saved) process.env[key] = value;
    };
}

function withEnvironment<T>(environment: Readonly<Record<string, string | undefined>>, callback: () => T): T {
    const saved = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(environment)) {
        saved.set(key, process.env[key]);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try {
        return callback();
    } finally {
        for (const [key, value] of saved) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

async function withEnvironmentAsync<T>(
    environment: Readonly<Record<string, string | undefined>>,
    callback: () => Promise<T>,
): Promise<T> {
    const saved = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(environment)) {
        saved.set(key, process.env[key]);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try {
        return await callback();
    } finally {
        for (const [key, value] of saved) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

async function loadVariant(label: VariantLabel, root: string): Promise<IVariant> {
    const profile = (await import(
        pathToFileURL(join(root, "src/ai/versions/v0_8_a13_profile.ts")).href
    )) as IA13ProfileModule;
    const fullEnvironment = profile.buildV08A13SearchEnvironment(AI_VERSION);
    const environment = activeEnvironment(fullEnvironment);
    // Some legacy strategy modules snapshot default gates at module evaluation. Import each runtime tree under
    // the exact active environment, sequentially across roots, so those values cannot depend on the caller.
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
        productionSearch.shouldUseDefaultV08A13Search({
            greenVersion: AI_VERSION,
            redVersion: AI_VERSION,
        }),
    );
    if (promoted) {
        throw new Error(
            `${label} selected the promoted bounded A13 constructor; expected generic deadline-free search`,
        );
    }
    if (
        environment.V08_A13_SEARCH !== "0" ||
        environment.V07_SEARCH !== "1" ||
        environment.SEARCH_DECISION_DEADLINE_MS !== undefined ||
        environment.SEARCH_CIRCUIT_BREAKER_MS !== undefined ||
        environment.LIVETWIN !== "1" ||
        environment.FIGHT_MELEE_ROSTERS !== "0"
    ) {
        throw new Error(`${label} failed to construct the exact deadline-free A13 environment`);
    }
    return {
        label,
        root,
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
            fullEnvironment: environmentEntries(fullEnvironment),
            activeEnvironment: environmentEntries(environment),
            genericSearchDriverSelected: true,
            deadlineFree: true,
        },
    };
}

function collectSourceEntries(directory: string, srcRoot: string, entries: ITreeEntry[]): void {
    for (const item of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
        left.name.localeCompare(right.name),
    )) {
        const path = join(directory, item.name);
        const stats = lstatSync(path);
        if (stats.isDirectory()) {
            collectSourceEntries(path, srcRoot, entries);
        } else if (stats.isFile()) {
            entries.push({
                path: normalizedPath(relative(srcRoot, path)),
                kind: "file",
                bytes: stats.size,
                sha256: sha256(readFileSync(path)),
            });
        } else if (stats.isSymbolicLink()) {
            const target = readlinkSync(path);
            entries.push({
                path: normalizedPath(relative(srcRoot, path)),
                kind: "symlink",
                bytes: Buffer.byteLength(target),
                sha256: sha256(target),
            });
        }
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

function sourceSeal(rootInput: string): ISourceSeal {
    const root = requireRoot(rootInput);
    const srcRoot = join(root, "src");
    const entries: ITreeEntry[] = [];
    collectSourceEntries(srcRoot, srcRoot, entries);
    entries.sort((left, right) => left.path.localeCompare(right.path));
    const rootNodeModules = realpathSync(join(root, "node_modules"));
    const workspaceLockPath = nearestWorkspaceLock(dirname(rootNodeModules));
    const workspaceNodeModulesPath = join(dirname(workspaceLockPath), "node_modules");
    if (!existsSync(workspaceNodeModulesPath)) {
        throw new Error(`Workspace node_modules is missing beside ${workspaceLockPath}`);
    }
    const reportWithoutIdentity = {
        root,
        realRoot: realpathSync(root),
        srcEntryCount: entries.length,
        srcBytes: sum(entries.map((entry) => entry.bytes)),
        srcTreeManifestSha256: digest(entries),
        packageJson: fileSeal(join(root, "package.json")),
        workspaceLock: fileSeal(workspaceLockPath),
        dependencyRealpaths: {
            rootNodeModules,
            workspaceNodeModules: realpathSync(workspaceNodeModulesPath),
        },
    };
    return {
        entries,
        report: {
            ...reportWithoutIdentity,
            identitySha256: digest(reportWithoutIdentity),
        },
    };
}

function assertSourceUnchanged(before: ISourceSeal, after: ISourceSeal, label: VariantLabel): void {
    if (before.report.identitySha256 !== after.report.identitySha256) {
        throw new Error(
            `${label} source/package/lock/dependency seal changed: ` +
                `${before.report.identitySha256} -> ${after.report.identitySha256}`,
        );
    }
}

function sourceDelta(baseline: ISourceSeal, candidate: ISourceSeal): Record<string, unknown> {
    const baselineEntries = new Map(baseline.entries.map((entry) => [entry.path, entry]));
    const candidateEntries = new Map(candidate.entries.map((entry) => [entry.path, entry]));
    const paths = [...new Set([...baselineEntries.keys(), ...candidateEntries.keys()])].sort();
    const differences = paths
        .filter((path) => canonicalJson(baselineEntries.get(path)) !== canonicalJson(candidateEntries.get(path)))
        .map((path) => {
            const left = baselineEntries.get(path);
            const right = candidateEntries.get(path);
            return {
                path,
                change: !left ? "added" : !right ? "deleted" : "modified",
                baselineKind: left?.kind ?? null,
                candidateKind: right?.kind ?? null,
                baselineBytes: left?.bytes ?? null,
                candidateBytes: right?.bytes ?? null,
                baselineSha256: left?.sha256 ?? null,
                candidateSha256: right?.sha256 ?? null,
            };
        });
    const shape = differences.map(({ path, change }) => ({ path, change }));
    const exactExpected = canonicalJson(shape) === canonicalJson(EXPECTED_SOURCE_DELTA);
    return {
        exactExpected,
        expected: EXPECTED_SOURCE_DELTA,
        actual: shape,
        changedEntryCount: differences.length,
        manifestSha256: digest(differences),
        differences,
    };
}

function runnerSeal(): IFileSeal {
    return fileSeal(RUNNER_PATH);
}

function nonnegativeInteger(value: unknown, name: string): number {
    const parsed = Number(value ?? 0);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
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
    const rosterSha256 = digest(roster);
    const catalogs: Array<{ getStats: () => unknown }> = [];
    let decisionsObserved = 0;
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
            decisionsObserved++;
            if (!observation || typeof observation !== "object") return;
            const context = (observation as { context?: { decisionPathCatalog?: unknown } }).context;
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
    const started = process.hrtime.bigint();
    const result = withEnvironment(variant.environment, () => variant.battle.runMatch(config));
    const elapsedNs = Number(process.hrtime.bigint() - started);
    if (!Number.isSafeInteger(elapsedNs) || elapsedNs <= 0) {
        throw new Error(`Invalid elapsed time in ${variant.label} ${phase} seed=${seed} gridType=${gridType}`);
    }
    const rejectedGreen = nonnegativeInteger(result.rejectedGreen, "rejectedGreen");
    const rejectedRed = nonnegativeInteger(result.rejectedRed, "rejectedRed");
    if (rejectedGreen + rejectedRed !== 0) {
        throw new Error(
            `Rejected action in ${variant.label} ${phase} seed=${seed} gridType=${gridType}: ` +
                `green=${rejectedGreen} red=${rejectedRed}`,
        );
    }
    const endReason = String(result.endReason ?? "");
    if (endReason === "stuck") {
        throw new Error(`Stuck match in ${variant.label} ${phase} seed=${seed} gridType=${gridType}`);
    }
    if (endReason !== "elimination" && endReason !== "turn_cap") {
        throw new Error(
            `Invalid end reason in ${variant.label} ${phase} seed=${seed} gridType=${gridType}: ${endReason}`,
        );
    }
    if (!Array.isArray(result.actions)) {
        throw new Error(`Missing actions in ${variant.label} ${phase} seed=${seed} gridType=${gridType}`);
    }
    if (!result.placements || typeof result.placements !== "object") {
        throw new Error(`Missing placements in ${variant.label} ${phase} seed=${seed} gridType=${gridType}`);
    }
    if (!Array.isArray(result.roster)) {
        throw new Error(`Missing result roster in ${variant.label} ${phase} seed=${seed} gridType=${gridType}`);
    }
    const totalActions = nonnegativeInteger(result.totalActions, "totalActions");
    if (totalActions !== result.actions.length) {
        throw new Error(
            `Action count mismatch in ${variant.label} ${phase} seed=${seed} gridType=${gridType}: ` +
                `totalActions=${totalActions} actions.length=${result.actions.length}`,
        );
    }
    const resultRosterSha256 = digest(result.roster);
    if (resultRosterSha256 !== rosterSha256) {
        throw new Error(`runMatch changed its roster in ${variant.label} ${phase} seed=${seed} gridType=${gridType}`);
    }
    let searchExercise: ISearchExercise | null = null;
    if (observeSearch) {
        if (
            decisionsObserved === 0 ||
            catalogs.length !== decisionsObserved ||
            new Set(catalogs).size !== catalogs.length
        ) {
            throw new Error(
                `Generic search observation failed in ${variant.label} ${phase} seed=${seed} gridType=${gridType}: ` +
                    `decisions=${decisionsObserved} catalogs=${catalogs.length} unique=${new Set(catalogs).size}`,
            );
        }
        searchExercise = {
            decisionsObserved,
            catalogsObserved: catalogs.length,
            requests: 0,
            hits: 0,
            misses: 0,
            bypasses: 0,
        };
        for (const catalog of catalogs) {
            const stats = catalog.getStats() as Record<string, unknown>;
            const requests = nonnegativeInteger(stats.requests, "catalog requests");
            const hits = nonnegativeInteger(stats.hits, "catalog hits");
            const misses = nonnegativeInteger(stats.misses, "catalog misses");
            const bypasses = nonnegativeInteger(stats.bypasses, "catalog bypasses");
            if (requests !== hits + misses + bypasses) {
                throw new Error(
                    `Path catalog accounting mismatch in ${variant.label} ${phase} seed=${seed} gridType=${gridType}`,
                );
            }
            searchExercise.requests += requests;
            searchExercise.hits += hits;
            searchExercise.misses += misses;
            searchExercise.bypasses += bypasses;
        }
        if (searchExercise.requests === 0) {
            throw new Error(
                `Generic search exercised no path requests in ${variant.label} ${phase} ` +
                    `seed=${seed} gridType=${gridType}`,
            );
        }
    }
    return {
        elapsedNs,
        resultSha256: digest(result),
        actionsSha256: digest(result.actions),
        placementsSha256: digest(result.placements),
        rosterSha256,
        resultRosterSha256,
        endReason,
        totalActions,
        searchExercise,
    };
}

function exactPair(baseline: IRun, candidate: IRun, seed: number, gridType: number, phase: string): void {
    const comparison = {
        result: baseline.resultSha256 === candidate.resultSha256,
        actions: baseline.actionsSha256 === candidate.actionsSha256,
        placements: baseline.placementsSha256 === candidate.placementsSha256,
        roster: baseline.rosterSha256 === candidate.rosterSha256,
        endReason: baseline.endReason === candidate.endReason,
        totalActions: baseline.totalActions === candidate.totalActions,
    };
    if (Object.values(comparison).some((equal) => !equal)) {
        throw new Error(
            `Semantic mismatch in ${phase} seed=${seed} gridType=${gridType}: ${canonicalJson(comparison)}`,
        );
    }
}

function aggregateSearchExercise(exercises: readonly ISearchExercise[]): ISearchExercise {
    return exercises.reduce<ISearchExercise>(
        (total, exercise) => ({
            decisionsObserved: total.decisionsObserved + exercise.decisionsObserved,
            catalogsObserved: total.catalogsObserved + exercise.catalogsObserved,
            requests: total.requests + exercise.requests,
            hits: total.hits + exercise.hits,
            misses: total.misses + exercise.misses,
            bypasses: total.bypasses + exercise.bypasses,
        }),
        {
            decisionsObserved: 0,
            catalogsObserved: 0,
            requests: 0,
            hits: 0,
            misses: 0,
            bypasses: 0,
        },
    );
}

function quantile(values: readonly number[], probability: number): number {
    if (values.length === 0) throw new Error("Cannot calculate a quantile of an empty sample");
    const sorted = [...values].sort((left, right) => left - right);
    const position = (sorted.length - 1) * probability;
    const lower = Math.floor(position);
    const fraction = position - lower;
    return sorted[lower] + (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]) * fraction;
}

function seedClusterBootstrap(
    rows: readonly ITaskRow[],
    seeds: readonly number[],
    bootstrapSeed: number,
    samples: number,
): IBootstrapIntervals {
    const clusters = seeds.map((seed) => rows.filter((row) => row.seed === seed));
    if (clusters.some((cluster) => cluster.length === 0)) throw new Error("Bootstrap seed cluster is empty");
    let state = bootstrapSeed >>> 0;
    const random = (): number => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
    };
    const totalRatios: number[] = [];
    const geometricRatios: number[] = [];
    for (let sample = 0; sample < samples; sample++) {
        let baselineNs = 0;
        let candidateNs = 0;
        let logRatio = 0;
        let count = 0;
        for (let index = 0; index < clusters.length; index++) {
            const cluster = clusters[Math.floor(random() * clusters.length)];
            for (const row of cluster) {
                baselineNs += row.baselineNs;
                candidateNs += row.candidateNs;
                logRatio += Math.log(row.ratio);
                count++;
            }
        }
        totalRatios.push(candidateNs / baselineNs);
        geometricRatios.push(Math.exp(logRatio / count));
    }
    return {
        totalRatio95: [quantile(totalRatios, 0.025), quantile(totalRatios, 0.975)],
        geometricMeanPairedRatio95: [quantile(geometricRatios, 0.025), quantile(geometricRatios, 0.975)],
    };
}

function writeJsonAtomicExclusive(pathInput: string, value: unknown): void {
    const path = resolve(pathInput);
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) throw new Error(`Refusing to overwrite output: ${path}`);
    const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    try {
        linkSync(temporary, path);
    } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
    }
}

async function main(): Promise<void> {
    const options = commandLine();
    if (!options) return;
    const restoreEnvironment = scrubExperimentEnvironment();
    const runnerBefore = runnerSeal();
    try {
        const baselineSourceBefore = sourceSeal(options.baselineRoot);
        const candidateSourceBefore = sourceSeal(options.candidateRoot);
        if (
            baselineSourceBefore.report.packageJson.sha256 !== candidateSourceBefore.report.packageJson.sha256 ||
            baselineSourceBefore.report.workspaceLock.sha256 !== candidateSourceBefore.report.workspaceLock.sha256 ||
            canonicalJson(baselineSourceBefore.report.dependencyRealpaths) !==
                canonicalJson(candidateSourceBefore.report.dependencyRealpaths)
        ) {
            throw new Error(
                "Baseline and candidate must share exact package, workspace lock, and dependency realpaths",
            );
        }
        const delta = sourceDelta(baselineSourceBefore, candidateSourceBefore);
        if (delta.exactExpected !== true) {
            throw new Error(
                `Unexpected runtime source delta: ${canonicalJson({
                    expected: delta.expected,
                    actual: delta.actual,
                })}`,
            );
        }

        const baseline = await loadVariant("baseline", options.baselineRoot);
        const candidate = await loadVariant("candidate", options.candidateRoot);
        const profileIdentity = (profile: IProfileSeal): unknown => ({
            profileSha256: profile.profileSha256,
            genomeSha256: profile.genomeSha256,
            searchSha256: profile.searchSha256,
            policySha256: profile.policySha256,
            fullEnvironmentSha256: profile.fullEnvironmentSha256,
            activeEnvironmentSha256: profile.activeEnvironmentSha256,
        });
        if (canonicalJson(profileIdentity(baseline.profile)) !== canonicalJson(profileIdentity(candidate.profile))) {
            throw new Error("Baseline and candidate A13 profile/genome/environment hashes differ");
        }

        const warmupRows: IWarmupRow[] = [];
        for (let index = 0; index < options.gridTypes.length; index++) {
            const gridType = options.gridTypes[index];
            const defaultOrder: TaskOrder = index % 2 === 0 ? "AB" : "BA";
            const order: TaskOrder = options.invertOrder ? (defaultOrder === "AB" ? "BA" : "AB") : defaultOrder;
            const first =
                order === "AB"
                    ? run(baseline, options.warmupSeed, gridType, options.maxLaps, "warmup", true)
                    : run(candidate, options.warmupSeed, gridType, options.maxLaps, "warmup", true);
            const second =
                order === "AB"
                    ? run(candidate, options.warmupSeed, gridType, options.maxLaps, "warmup", true)
                    : run(baseline, options.warmupSeed, gridType, options.maxLaps, "warmup", true);
            const baselineRun = order === "AB" ? first : second;
            const candidateRun = order === "AB" ? second : first;
            exactPair(baselineRun, candidateRun, options.warmupSeed, gridType, "warmup");
            if (!baselineRun.searchExercise || !candidateRun.searchExercise) {
                throw new Error(`Missing generic-search warmup counters for gridType=${gridType}`);
            }
            if (canonicalJson(baselineRun.searchExercise) !== canonicalJson(candidateRun.searchExercise)) {
                throw new Error(`Generic-search warmup counter mismatch for gridType=${gridType}`);
            }
            warmupRows.push({
                gridType,
                order,
                baselineActions: baselineRun.totalActions,
                candidateActions: candidateRun.totalActions,
                resultSha256: baselineRun.resultSha256,
                baselineSearch: baselineRun.searchExercise,
                candidateSearch: candidateRun.searchExercise,
                exact: true,
                timingDiscarded: true,
            });
        }
        const baselineWarmupSearch = aggregateSearchExercise(warmupRows.map((row) => row.baselineSearch));
        const candidateWarmupSearch = aggregateSearchExercise(warmupRows.map((row) => row.candidateSearch));

        const tasks = options.seeds.flatMap((seed, seedIndex) =>
            options.gridTypes.map((gridType, gridIndex) => ({ seed, seedIndex, gridType, gridIndex })),
        );
        const rows: ITaskRow[] = [];
        for (let ordinal = 0; ordinal < tasks.length; ordinal++) {
            const task = tasks[ordinal];
            const defaultOrder: TaskOrder = (task.seedIndex + task.gridIndex) % 2 === 0 ? "AB" : "BA";
            const order: TaskOrder = options.invertOrder ? (defaultOrder === "AB" ? "BA" : "AB") : defaultOrder;
            const first =
                order === "AB"
                    ? run(baseline, task.seed, task.gridType, options.maxLaps, "measured")
                    : run(candidate, task.seed, task.gridType, options.maxLaps, "measured");
            const second =
                order === "AB"
                    ? run(candidate, task.seed, task.gridType, options.maxLaps, "measured")
                    : run(baseline, task.seed, task.gridType, options.maxLaps, "measured");
            const baselineRun = order === "AB" ? first : second;
            const candidateRun = order === "AB" ? second : first;
            exactPair(baselineRun, candidateRun, task.seed, task.gridType, "measured");
            rows.push({
                ordinal,
                order,
                seed: task.seed,
                gridType: task.gridType,
                baselineNs: baselineRun.elapsedNs,
                candidateNs: candidateRun.elapsedNs,
                ratio: candidateRun.elapsedNs / baselineRun.elapsedNs,
                baselineTotalActions: baselineRun.totalActions,
                candidateTotalActions: candidateRun.totalActions,
                resultSha256: baselineRun.resultSha256,
                candidateResultSha256: candidateRun.resultSha256,
                actionsSha256: baselineRun.actionsSha256,
                candidateActionsSha256: candidateRun.actionsSha256,
                placementsSha256: baselineRun.placementsSha256,
                candidatePlacementsSha256: candidateRun.placementsSha256,
                rosterSha256: baselineRun.rosterSha256,
                candidateRosterSha256: candidateRun.rosterSha256,
                endReason: baselineRun.endReason,
                candidateEndReason: candidateRun.endReason,
                exact: true,
            });
        }

        const ratios = rows.map((row) => row.ratio);
        const baselineNs = rows.map((row) => row.baselineNs);
        const candidateNs = rows.map((row) => row.candidateNs);
        const bootstrap = seedClusterBootstrap(rows, options.seeds, options.bootstrapSeed, options.bootstrapSamples);
        const perMap = options.gridTypes.map((gridType) => {
            const mapRows = rows.filter((row) => row.gridType === gridType);
            const totalRatio = sum(mapRows.map((row) => row.candidateNs)) / sum(mapRows.map((row) => row.baselineNs));
            return {
                gridType,
                tasks: mapRows.length,
                baselineTotalMs: sum(mapRows.map((row) => row.baselineNs)) / 1_000_000,
                candidateTotalMs: sum(mapRows.map((row) => row.candidateNs)) / 1_000_000,
                totalRatio,
                passedMaximumPointRatio: totalRatio <= 1.05,
            };
        });
        const totalRatio = sum(candidateNs) / sum(baselineNs);
        const p50Ratio = quantile(ratios, 0.5);
        const p95Ratio = quantile(ratios, 0.95);
        const p99Ratio = quantile(ratios, 0.99);
        const geometricMeanPairedRatio = Math.exp(sum(ratios.map(Math.log)) / ratios.length);
        const performanceGates = {
            totalRatioBootstrapUpper95: {
                threshold: 0.99,
                observed: bootstrap.totalRatio95[1],
                passed: bootstrap.totalRatio95[1] <= 0.99,
            },
            p50PointRatio: {
                threshold: 1,
                observed: p50Ratio,
                passed: p50Ratio < 1,
            },
            p99PointRatio: {
                threshold: 1,
                observed: p99Ratio,
                passed: p99Ratio < 1,
            },
            perMapPointRatio: {
                threshold: 1.05,
                observedMaximum: Math.max(...perMap.map((row) => row.totalRatio)),
                passed: perMap.every((row) => row.passedMaximumPointRatio),
            },
        };
        const performancePassed = Object.values(performanceGates).every((gate) => gate.passed);

        const baselineSourceAfter = sourceSeal(options.baselineRoot);
        const candidateSourceAfter = sourceSeal(options.candidateRoot);
        assertSourceUnchanged(baselineSourceBefore, baselineSourceAfter, "baseline");
        assertSourceUnchanged(candidateSourceBefore, candidateSourceAfter, "candidate");
        const runnerAfter = runnerSeal();
        if (canonicalJson(runnerBefore) !== canonicalJson(runnerAfter)) {
            throw new Error("Runner changed during qualification");
        }

        const baselineActions = sum(rows.map((row) => row.baselineTotalActions));
        const candidateActions = sum(rows.map((row) => row.candidateTotalActions));
        const exactRows = rows.map((row) => ({
            seed: row.seed,
            gridType: row.gridType,
            resultSha256: row.resultSha256,
            actionsSha256: row.actionsSha256,
            placementsSha256: row.placementsSha256,
            rosterSha256: row.rosterSha256,
            endReason: row.endReason,
            totalActions: row.baselineTotalActions,
        }));
        const exactnessPassed =
            rows.length === options.seeds.length * options.gridTypes.length &&
            rows.every((row) => row.exact) &&
            baselineActions === candidateActions;
        const standardEvidenceProtocol =
            canonicalJson(options.seeds) === canonicalJson(DEFAULT_SEEDS) &&
            canonicalJson(options.gridTypes) === canonicalJson(DEFAULT_GRID_TYPES) &&
            options.maxLaps === DEFAULT_MAX_LAPS &&
            options.warmupSeed === DEFAULT_WARMUP_SEED &&
            options.bootstrapSeed === DEFAULT_BOOTSTRAP_SEED &&
            options.bootstrapSamples === DEFAULT_BOOTSTRAP_SAMPLES &&
            !options.invertOrder;
        const eligible = !options.smoke && standardEvidenceProtocol;
        const qualified = eligible && exactnessPassed && performancePassed;
        const report = {
            schema: SCHEMA,
            generatedAt: new Date().toISOString(),
            command: {
                smoke: options.smoke,
                invertOrder: options.invertOrder,
                seeds: options.seeds,
                gridTypes: options.gridTypes,
                maxLaps: options.maxLaps,
                warmupSeed: options.warmupSeed,
                bootstrapSeed: options.bootstrapSeed,
                bootstrapSamples: options.bootstrapSamples,
                bootstrapUnit: "seed (all requested maps retained as one cluster)",
            },
            host: {
                platform: platform(),
                release: release(),
                arch: arch(),
                cpuModel: cpus()[0]?.model ?? "unknown",
                logicalCpus: cpus().length,
                bunVersion: Bun.version,
            },
            profile: {
                crossRootExact: true,
                baseline: baseline.profile,
                candidate: candidate.profile,
                searchConstruction:
                    "generic SearchDriver with each root's exact A13 profile environment and V08_A13_SEARCH=0",
                deadlinePolicy:
                    "SEARCH_DECISION_DEADLINE_MS and SEARCH_CIRCUIT_BREAKER_MS are absent; no wall-clock branch",
                genericSearchExercised: true,
            },
            source: {
                runnerBefore,
                runnerAfter,
                runnerUnchanged: true,
                baselineBefore: baselineSourceBefore.report,
                baselineAfter: baselineSourceAfter.report,
                candidateBefore: candidateSourceBefore.report,
                candidateAfter: candidateSourceAfter.report,
                delta,
                postflightUnchanged: true,
                dependencyContentLimitation:
                    "Package and workspace lock bytes plus both dependency realpaths are sealed; installed " +
                    "dependency contents are not recursively hashed.",
            },
            warmup: {
                passed: true,
                discarded: true,
                balancedOrders: {
                    ab: warmupRows.filter((row) => row.order === "AB").length,
                    ba: warmupRows.filter((row) => row.order === "BA").length,
                },
                searchVerification: {
                    passed: true,
                    scope: "instrumented, timing-discarded per-map warmups only",
                    signal:
                        "decisionPathCatalog exists only when SearchDriver.appliesTo(v0.8); every decision " +
                        "had a fresh catalog and nonzero accounted path requests",
                    baseline: baselineWarmupSearch,
                    candidate: candidateWarmupSearch,
                    crossRootCountersExact:
                        canonicalJson(baselineWarmupSearch) === canonicalJson(candidateWarmupSearch),
                },
                rows: warmupRows,
            },
            work: {
                fixed: {
                    serial: true,
                    measuredTasks: rows.length,
                    measuredMatchesPerVariant: rows.length,
                    measuredMatchesTotal: rows.length * 2,
                    warmupMatchesPerVariant: options.gridTypes.length,
                    warmupMatchesTotal: options.gridTypes.length * 2,
                    configuredMaxLapsPerMeasuredMatch: options.maxLaps,
                    abTasks: rows.filter((row) => row.order === "AB").length,
                    baTasks: rows.filter((row) => row.order === "BA").length,
                },
                logical: {
                    availableCounter: "runMatch.totalActions (accepted recorded actions)",
                    baselineAcceptedActions: baselineActions,
                    candidateAcceptedActions: candidateActions,
                    taskByTaskExact: rows.every((row) => row.baselineTotalActions === row.candidateTotalActions),
                    targetLayerTelemetryAvailable: false,
                    targetLayerTelemetryNote:
                        "No target-layer work counter exists in the runtime; this runner does not infer or invent one.",
                },
            },
            exactness: {
                required: true,
                passed: exactnessPassed,
                taskCount: rows.length,
                semanticMismatchCount: 0,
                rejectedActions: 0,
                stuckMatches: 0,
                exceptions: 0,
                resultsSha256: digest(exactRows.map((row) => row.resultSha256)),
                actionsSha256: digest(exactRows.map((row) => row.actionsSha256)),
                placementsSha256: digest(exactRows.map((row) => row.placementsSha256)),
                rostersSha256: digest(exactRows.map((row) => row.rosterSha256)),
                endReasonsSha256: digest(exactRows.map((row) => row.endReason)),
                totalActionsSha256: digest(exactRows.map((row) => row.totalActions)),
                rowsSha256: digest(exactRows),
            },
            performance: {
                passed: performancePassed,
                baselineTotalMs: sum(baselineNs) / 1_000_000,
                candidateTotalMs: sum(candidateNs) / 1_000_000,
                totalRatio,
                totalRatioSeedClusterBootstrap95: bootstrap.totalRatio95,
                geometricMeanPairedRatio,
                geometricMeanPairedRatioSeedClusterBootstrap95: bootstrap.geometricMeanPairedRatio95,
                p50PairedRatio: p50Ratio,
                p95PairedRatio: p95Ratio,
                p99PairedRatio: p99Ratio,
                candidateFasterTasks: ratios.filter((ratio) => ratio < 1).length,
                tiedTasks: ratios.filter((ratio) => ratio === 1).length,
                candidateSlowerTasks: ratios.filter((ratio) => ratio > 1).length,
                perMap,
                gates: performanceGates,
            },
            qualification: {
                eligible,
                passed: qualified,
                smokeNeverQualifies: options.smoke,
                standardEvidenceProtocol,
            },
            rows,
        };
        writeJsonAtomicExclusive(options.out, report);
        console.log(
            JSON.stringify(
                {
                    out: options.out,
                    exactness: report.exactness,
                    performance: report.performance,
                    qualification: report.qualification,
                },
                null,
                2,
            ),
        );
        if (eligible && !qualified) {
            throw new Error(`A13 melee target-layer qualification gates failed; report retained at ${options.out}`);
        }
    } finally {
        restoreEnvironment();
    }
}

await main();
