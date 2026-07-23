#!/usr/bin/env bun

/**
 * A13 Workstream 2 sealed two-source-root PathHelper microbenchmark.
 *
 * This runner is intended for production `getMovePath` changes that cannot be isolated by the embedded-neighbor
 * benchmark. Each arm imports PathHelper, GridSettings, and deterministic-random state from its own immutable source
 * root. By default, the recursively hashed `src` trees must differ at exactly `src/grid/path_helper.ts`.
 *
 * Evidence run (31 alternating AB/BA blocks, about 10 seconds on an idle M4 Max):
 *   bun docs/evidence/tools/a13_path_pair_microbench.ts \
 *     --baseline-root /tmp/path-baseline --candidate-root /tmp/path-candidate \
 *     --out /tmp/a13-path-pair.json
 *
 * Wiring smoke against two distinct copies of the same source tree (not performance evidence):
 *   bun docs/evidence/tools/a13_path_pair_microbench.ts \
 *     --baseline-root /tmp/path-copy-a --candidate-root /tmp/path-copy-b \
 *     --smoke --allow-identical-sources --out /tmp/a13-path-pair-smoke.json
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    existsSync,
    lstatSync,
    readFileSync,
    readdirSync,
    readlinkSync,
    realpathSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { arch, cpus, freemem, loadavg, platform, release, totalmem } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const SCHEMA = "heroes-of-crypto/a13-path-pair-microbench/v1" as const;
const RUNNER_PATH = fileURLToPath(import.meta.url);
const GRID_SIZE = 16;
const DEFAULT_SEED = 0xa13_2202;
const UINT32_SCALE = 0x1_0000_0000;
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const FLOAT64_SCRATCH = new DataView(new ArrayBuffer(8));
const EXPECTED_SOURCE_DIFFERENCE = "src/grid/path_helper.ts";
const STEP_BUDGETS = [2, 3.3, 4.2, 6.3] as const;

type VariantName = "baseline" | "candidate";
type RandomSource = () => number;

interface IXY {
    x: number;
    y: number;
}

interface IWeightedRoute {
    cell: IXY;
    route: IXY[];
    weight: number;
    firstAggrMet: boolean;
    hasLavaCell: boolean;
    hasWaterCell: boolean;
}

interface IMovePath {
    cells: IXY[];
    hashes: Set<number>;
    knownPaths: Map<number, IWeightedRoute[]>;
}

interface IPathHelperInstance {
    getMovePath(
        currentCell: IXY,
        matrix: number[][],
        maxSteps: number,
        aggrBoard?: number[][],
        canFly?: boolean,
        isSmallUnit?: boolean,
        isMadeOfFire?: boolean,
    ): IMovePath;
}

interface IPathHelperModule {
    PathHelper: new (settings: unknown) => IPathHelperInstance;
}

interface IGridSettingsModule {
    GridSettings: new (
        gridSize: number,
        maxY: number,
        minY: number,
        maxX: number,
        minX: number,
        movementDelta: number,
        unitSizeDelta: number,
    ) => unknown;
}

interface IRandomModule {
    getDeterministicRandomSource(): RandomSource | undefined;
    setDeterministicRandomSource(source: RandomSource | undefined): void;
}

interface IObstacleModule {
    ObstacleType: {
        BLOCK: number;
        HOLE: number;
        LAVA: number;
        WATER: number;
    };
}

interface IVariantRuntime {
    name: VariantName;
    root: string;
    realRoot: string;
    moduleUrls: {
        pathHelper: string;
        gridSettings: string;
        random: string;
        obstacleType: string;
    };
    PathHelper: IPathHelperModule["PathHelper"];
    GridSettings: IGridSettingsModule["GridSettings"];
    random: IRandomModule;
    obstacleType: IObstacleModule["ObstacleType"];
}

interface ICliOptions {
    baselineRoot: string;
    candidateRoot: string;
    blocks: number;
    targetMs: number;
    warmupMs: number;
    bootstrapSamples: number;
    seed: number;
    smoke: boolean;
    enforce: boolean;
    allowIdenticalSources: boolean;
    outPath?: string;
}

interface IPathWorkload {
    id: string;
    currentCell: Readonly<IXY>;
    matrix: number[][];
    maxSteps: number;
    aggrBoard?: number[][];
    canFly: boolean;
    isSmallUnit: boolean;
    isMadeOfFire: boolean;
    randomSeed: number;
    profile: string;
}

type SemanticCorpusName = "timed-live-shaped" | "fallback-edge";

interface ISemanticPathCase extends IPathWorkload {
    gridSize: number;
    semanticCorpus: SemanticCorpusName;
    edgeTags: readonly string[];
}

interface IManifestEntry {
    path: string;
    kind: "file" | "symlink";
    mode: number;
    bytes: number;
    sha256: string;
    linkTarget?: string;
}

interface ISourceSealInternal {
    root: string;
    realRoot: string;
    srcEntries: IManifestEntry[];
    srcFileCount: number;
    srcBytes: number;
    srcTreeManifestSha256: string;
    packageJsonSha256: string | null;
    bunLockSha256: string | null;
    dependencyRoot: string | null;
    gitHead: string | null;
    selectedFiles: Record<string, string | null>;
}

interface IArmSample {
    block: number;
    order: "AB" | "BA";
    durationNs: number;
    nanosecondsPerGetMovePath: number;
    checksum: number;
}

interface IPairedSamples {
    baseline: IArmSample[];
    candidate: IArmSample[];
    iterationsPerArm: number;
    callsPerArm: number;
}

interface IInterval {
    lower95: number;
    median: number;
    upper95: number;
}

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

function canonicalize(value: unknown): unknown {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
        if (Number.isNaN(value)) return "__NaN__";
        if (value === Number.POSITIVE_INFINITY) return "__Infinity__";
        if (value === Number.NEGATIVE_INFINITY) return "__-Infinity__";
        return Object.is(value, -0) ? "__-0__" : value;
    }
    if (typeof value === "bigint") return `${value}n`;
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value instanceof Set) return [...value].map(canonicalize);
    if (value instanceof Map) return [...value].map(([key, item]) => [canonicalize(key), canonicalize(item)]);
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

function parseCli(argv: string[]): ICliOptions {
    const { values } = parseArgs({
        args: argv,
        strict: true,
        allowPositionals: false,
        options: {
            "baseline-root": { type: "string" },
            "candidate-root": { type: "string" },
            out: { type: "string" },
            blocks: { type: "string" },
            "target-ms": { type: "string" },
            "warmup-ms": { type: "string" },
            bootstrap: { type: "string" },
            seed: { type: "string" },
            smoke: { type: "boolean", default: false },
            "no-enforce": { type: "boolean", default: false },
            "allow-identical-sources": { type: "boolean", default: false },
        },
    });
    if (!values["baseline-root"] || !values["candidate-root"]) {
        throw new Error("--baseline-root and --candidate-root are required");
    }
    const smoke = values.smoke ?? false;
    const integer = (name: string, raw: string | undefined, fallback: number, minimum: number): number => {
        if (raw === undefined) return fallback;
        const value = Number(raw);
        if (!Number.isSafeInteger(value) || value < minimum) {
            throw new Error(`--${name} must be an integer >= ${minimum}; got ${raw}`);
        }
        return value;
    };
    const finite = (name: string, raw: string | undefined, fallback: number): number => {
        if (raw === undefined) return fallback;
        const value = Number(raw);
        if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be > 0; got ${raw}`);
        return value;
    };
    const blocks = integer("blocks", values.blocks, smoke ? 5 : 31, 3);
    if (blocks % 2 === 0) throw new Error(`--blocks must be odd; got ${blocks}`);
    const seed = integer("seed", values.seed, DEFAULT_SEED, 0);
    if (seed > 0xffffffff) throw new Error(`--seed must be a uint32; got ${seed}`);
    const allowIdenticalSources = values["allow-identical-sources"] ?? false;
    if (allowIdenticalSources && !smoke) {
        throw new Error("--allow-identical-sources is restricted to --smoke runs");
    }
    return {
        baselineRoot: requireRoot(values["baseline-root"]),
        candidateRoot: requireRoot(values["candidate-root"]),
        blocks,
        targetMs: finite("target-ms", values["target-ms"], smoke ? 12 : 150),
        warmupMs: finite("warmup-ms", values["warmup-ms"], smoke ? 60 : 1_000),
        bootstrapSamples: integer("bootstrap", values.bootstrap, smoke ? 1_000 : 10_000, 100),
        seed,
        smoke,
        enforce: !(values["no-enforce"] ?? false),
        allowIdenticalSources,
        outPath: values.out,
    };
}

function requireRoot(input: string): string {
    const root = resolve(input);
    for (const required of [
        "src/grid/path_helper.ts",
        "src/grid/grid_settings.ts",
        "src/utils/lib.ts",
        "src/obstacles/obstacle_type.ts",
    ]) {
        const path = join(root, required);
        if (!existsSync(path) || !statSync(path).isFile())
            throw new Error(`source root is missing ${required}: ${root}`);
    }
    return root;
}

function mulberry32(seed: number): RandomSource {
    let state = seed >>> 0;
    return (): number => {
        state = (state + 0x6d2b79f5) | 0;
        let value = Math.imul(state ^ (state >>> 15), 1 | state);
        value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
        return ((value ^ (value >>> 14)) >>> 0) / UINT32_SCALE;
    };
}

function gitOutput(root: string, args: string[]): string | null {
    try {
        return execFileSync("git", ["-C", root, ...args], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
    } catch {
        return null;
    }
}

function fileHash(path: string): string | null {
    return existsSync(path) && statSync(path).isFile() ? sha256(readFileSync(path)) : null;
}

function sourceSeal(rootInput: string): ISourceSealInternal {
    const root = requireRoot(rootInput);
    const realRoot = realpathSync(root);
    const srcRoot = join(root, "src");
    const srcEntries: IManifestEntry[] = [];
    const visit = (directory: string): void => {
        for (const name of readdirSync(directory).sort()) {
            const path = join(directory, name);
            const stat = lstatSync(path);
            if (stat.isDirectory()) {
                visit(path);
            } else if (stat.isFile()) {
                const bytes = readFileSync(path);
                srcEntries.push({
                    path: relative(root, path),
                    kind: "file",
                    mode: stat.mode & 0o777,
                    bytes: bytes.byteLength,
                    sha256: sha256(bytes),
                });
            } else if (stat.isSymbolicLink()) {
                const target = readlinkSync(path);
                srcEntries.push({
                    path: relative(root, path),
                    kind: "symlink",
                    mode: stat.mode & 0o777,
                    bytes: Buffer.byteLength(target),
                    sha256: sha256(target),
                    linkTarget: target,
                });
            } else {
                throw new Error(`unsupported entry under src: ${path}`);
            }
        }
    };
    visit(srcRoot);
    let dependencyRoot: string | null = null;
    const nodeModules = join(root, "node_modules");
    if (existsSync(nodeModules)) {
        try {
            dependencyRoot = realpathSync(nodeModules);
        } catch {
            dependencyRoot = null;
        }
    }
    const selected = [
        "src/grid/path_helper.ts",
        "src/grid/grid_settings.ts",
        "src/grid/path_definitions.ts",
        "src/grid/grid_math.ts",
        "src/utils/lib.ts",
        "src/utils/math.ts",
        "src/obstacles/obstacle_type.ts",
    ];
    return {
        root,
        realRoot,
        srcEntries,
        srcFileCount: srcEntries.length,
        srcBytes: srcEntries.reduce((sum, entry) => sum + entry.bytes, 0),
        srcTreeManifestSha256: digest(srcEntries),
        packageJsonSha256: fileHash(join(root, "package.json")),
        bunLockSha256: fileHash(join(root, "bun.lock")) ?? fileHash(join(root, "bun.lockb")),
        dependencyRoot,
        gitHead: gitOutput(root, ["rev-parse", "HEAD"]),
        selectedFiles: Object.fromEntries(selected.map((path) => [path, fileHash(join(root, path))])),
    };
}

function publicSourceSeal(seal: ISourceSealInternal): Record<string, unknown> {
    return {
        root: seal.root,
        realRoot: seal.realRoot,
        srcFileCount: seal.srcFileCount,
        srcBytes: seal.srcBytes,
        srcTreeManifestSha256: seal.srcTreeManifestSha256,
        packageJsonSha256: seal.packageJsonSha256,
        bunLockSha256: seal.bunLockSha256,
        dependencyRoot: seal.dependencyRoot,
        gitHead: seal.gitHead,
        selectedFiles: seal.selectedFiles,
    };
}

function sourceSealIdentity(seal: ISourceSealInternal): Record<string, unknown> {
    return {
        realRoot: seal.realRoot,
        srcEntries: seal.srcEntries,
        packageJsonSha256: seal.packageJsonSha256,
        bunLockSha256: seal.bunLockSha256,
        dependencyRoot: seal.dependencyRoot,
    };
}

function compareSourceTrees(
    baseline: ISourceSealInternal,
    candidate: ISourceSealInternal,
    allowIdenticalSources: boolean,
): Record<string, unknown> & { exact: boolean } {
    const base = new Map(baseline.srcEntries.map((entry) => [entry.path, entry]));
    const cand = new Map(candidate.srcEntries.map((entry) => [entry.path, entry]));
    const paths = [...new Set([...base.keys(), ...cand.keys()])].sort();
    const differences = paths
        .filter((path) => canonicalJson(base.get(path)) !== canonicalJson(cand.get(path)))
        .map((path) => ({
            path,
            change: !base.has(path) ? "added" : !cand.has(path) ? "deleted" : "modified",
            baseline: base.get(path) ?? null,
            candidate: cand.get(path) ?? null,
        }));
    const exactExpectedPathHelperOnly = differences.length === 1 && differences[0]?.path === EXPECTED_SOURCE_DIFFERENCE;
    const exactIdenticalSmoke = allowIdenticalSources && differences.length === 0;
    return {
        exact: exactExpectedPathHelperOnly || exactIdenticalSmoke,
        exactExpectedPathHelperOnly,
        exactIdenticalSmoke,
        expectedDifference: EXPECTED_SOURCE_DIFFERENCE,
        differences,
        policy: allowIdenticalSources
            ? "smoke-only exception: zero src differences or exactly path_helper.ts"
            : "baseline and candidate recursively sealed src trees must differ only at src/grid/path_helper.ts",
    };
}

function runnerSeal(): { path: string; bytes: number; sha256: string } {
    const bytes = readFileSync(RUNNER_PATH);
    return { path: RUNNER_PATH, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

async function importFrom<T>(root: string, relativePath: string): Promise<T> {
    return (await import(pathToFileURL(join(root, relativePath)).href)) as T;
}

async function loadVariant(name: VariantName, root: string): Promise<IVariantRuntime> {
    const realRoot = realpathSync(root);
    const moduleUrls = {
        pathHelper: pathToFileURL(join(root, "src/grid/path_helper.ts")).href,
        gridSettings: pathToFileURL(join(root, "src/grid/grid_settings.ts")).href,
        random: pathToFileURL(join(root, "src/utils/lib.ts")).href,
        obstacleType: pathToFileURL(join(root, "src/obstacles/obstacle_type.ts")).href,
    };
    // Import PathHelper first: its relative dependency graph then owns the exact lib.ts instance imported below.
    const pathHelper = await importFrom<IPathHelperModule>(root, "src/grid/path_helper.ts");
    const gridSettings = await importFrom<IGridSettingsModule>(root, "src/grid/grid_settings.ts");
    const random = await importFrom<IRandomModule>(root, "src/utils/lib.ts");
    const obstacle = await importFrom<IObstacleModule>(root, "src/obstacles/obstacle_type.ts");
    if (typeof pathHelper.PathHelper !== "function" || typeof gridSettings.GridSettings !== "function") {
        throw new Error(`${name} source root did not export PathHelper/GridSettings constructors`);
    }
    if (
        typeof random.getDeterministicRandomSource !== "function" ||
        typeof random.setDeterministicRandomSource !== "function"
    ) {
        throw new Error(`${name} source root did not export deterministic random controls`);
    }
    return {
        name,
        root,
        realRoot,
        moduleUrls,
        PathHelper: pathHelper.PathHelper,
        GridSettings: gridSettings.GridSettings,
        random,
        obstacleType: obstacle.ObstacleType,
    };
}

function runtimeIsolation(
    baseline: IVariantRuntime,
    candidate: IVariantRuntime,
): Record<string, unknown> & {
    exact: boolean;
} {
    const baselinePrevious = baseline.random.getDeterministicRandomSource();
    const candidatePrevious = candidate.random.getDeterministicRandomSource();
    const baselineSentinel: RandomSource = () => 0.125;
    const candidateSentinel: RandomSource = () => 0.875;
    let baselineOwnState = false;
    let candidateUnaffectedByBaseline = false;
    let candidateOwnState = false;
    let baselineUnaffectedByCandidate = false;
    try {
        baseline.random.setDeterministicRandomSource(baselineSentinel);
        baselineOwnState = baseline.random.getDeterministicRandomSource() === baselineSentinel;
        candidateUnaffectedByBaseline = candidate.random.getDeterministicRandomSource() === candidatePrevious;
        baseline.random.setDeterministicRandomSource(baselinePrevious);
        candidate.random.setDeterministicRandomSource(candidateSentinel);
        candidateOwnState = candidate.random.getDeterministicRandomSource() === candidateSentinel;
        baselineUnaffectedByCandidate = baseline.random.getDeterministicRandomSource() === baselinePrevious;
    } finally {
        baseline.random.setDeterministicRandomSource(baselinePrevious);
        candidate.random.setDeterministicRandomSource(candidatePrevious);
    }
    const checks: Record<string, boolean> = {
        distinctRealRoots: baseline.realRoot !== candidate.realRoot,
        distinctPathHelperConstructors: baseline.PathHelper !== candidate.PathHelper,
        distinctGridSettingsConstructors: baseline.GridSettings !== candidate.GridSettings,
        distinctRandomModules: baseline.random !== candidate.random,
        baselineRandomInitiallyClear: baselinePrevious === undefined,
        candidateRandomInitiallyClear: candidatePrevious === undefined,
        baselineOwnRandomState: baselineOwnState,
        candidateUnaffectedByBaselineRandomState: candidateUnaffectedByBaseline,
        candidateOwnRandomState: candidateOwnState,
        baselineUnaffectedByCandidateRandomState: baselineUnaffectedByCandidate,
    };
    return {
        exact: Object.values(checks).every(Boolean),
        checks,
        baselineModuleUrls: baseline.moduleUrls,
        candidateModuleUrls: candidate.moduleUrls,
    };
}

function assertMatchingObstacleValues(baseline: IVariantRuntime, candidate: IVariantRuntime): void {
    for (const name of ["BLOCK", "HOLE", "LAVA", "WATER"] as const) {
        if (baseline.obstacleType[name] !== candidate.obstacleType[name]) {
            throw new Error(
                `obstacle value differs outside the allowed path_helper overlay: ${name} ` +
                    `${baseline.obstacleType[name]} != ${candidate.obstacleType[name]}`,
            );
        }
    }
}

function pathWorkloads(seed: number, obstacles: IObstacleModule["ObstacleType"]): readonly IPathWorkload[] {
    const random = mulberry32(seed ^ 0x5041_4952);
    const obstacleValues = [1, 2, obstacles.BLOCK, obstacles.HOLE, obstacles.LAVA, obstacles.WATER];
    const workloads: IPathWorkload[] = [];
    let ordinal = 0;
    for (const maxSteps of STEP_BUDGETS) {
        for (const isSmallUnit of [true, false]) {
            for (const canFly of [false, true]) {
                for (const isMadeOfFire of [false, true]) {
                    for (const weightedAggro of [false, true]) {
                        const xFloor = isSmallUnit ? 0 : 1;
                        const yFloor = isSmallUnit ? 0 : 1;
                        const currentCell = {
                            x: xFloor + Math.floor(random() * (GRID_SIZE - xFloor)),
                            y: yFloor + Math.floor(random() * (GRID_SIZE - yFloor)),
                        };
                        const density = [0.04, 0.09, 0.14, 0.19][ordinal % 4];
                        // Live movement grids are matrix[y][x]. Keep these rows dense and unfrozen for JSC parity.
                        const matrix = Array.from({ length: GRID_SIZE }, () => Array<number>(GRID_SIZE).fill(0));
                        // The engine intentionally indexes aggression as aggrBoard[x][y], unlike the movement grid.
                        const aggrBoard = weightedAggro
                            ? Array.from({ length: GRID_SIZE }, () => Array<number>(GRID_SIZE).fill(1))
                            : undefined;
                        for (let y = 0; y < GRID_SIZE; y++) {
                            for (let x = 0; x < GRID_SIZE; x++) {
                                if (random() < density) {
                                    matrix[y][x] = obstacleValues[Math.floor(random() * obstacleValues.length)];
                                }
                                if (aggrBoard && random() < 0.2) aggrBoard[x][y] = 2 + Math.floor(random() * 4);
                            }
                        }
                        const clearAnchor = (x: number, y: number): void => {
                            if (x < 0 || y < 0 || x >= GRID_SIZE || y >= GRID_SIZE) return;
                            matrix[y][x] = 0;
                            if (aggrBoard) aggrBoard[x][y] = 1;
                            if (!isSmallUnit && x > 0 && y > 0) {
                                matrix[y][x - 1] = 0;
                                matrix[y - 1][x] = 0;
                                matrix[y - 1][x - 1] = 0;
                                if (aggrBoard) {
                                    aggrBoard[x - 1][y] = 1;
                                    aggrBoard[x][y - 1] = 1;
                                    aggrBoard[x - 1][y - 1] = 1;
                                }
                            }
                        };
                        clearAnchor(currentCell.x, currentCell.y);
                        const towardCenterX = currentCell.x < GRID_SIZE / 2 ? currentCell.x + 1 : currentCell.x - 1;
                        const towardCenterY = currentCell.y < GRID_SIZE / 2 ? currentCell.y + 1 : currentCell.y - 1;
                        clearAnchor(towardCenterX, currentCell.y);
                        clearAnchor(currentCell.x, towardCenterY);
                        if (aggrBoard) {
                            // Guarantee a reachable weighted patch in addition to randomized live-shaped pressure.
                            aggrBoard[towardCenterX][currentCell.y] = 2 + (ordinal % 4);
                        }
                        Object.freeze(currentCell);
                        workloads.push(
                            Object.freeze({
                                id: `path-${ordinal.toString().padStart(3, "0")}`,
                                currentCell,
                                matrix,
                                maxSteps,
                                aggrBoard,
                                canFly,
                                isSmallUnit,
                                isMadeOfFire,
                                randomSeed: (seed + Math.imul(ordinal + 1, 0x9e37_79b1)) >>> 0,
                                profile: `${isSmallUnit ? "small" : "large"}/${canFly ? "fly" : "ground"}/${
                                    isMadeOfFire ? "fire" : "normal"
                                }/${weightedAggro ? "weighted-aggr" : "no-aggr"}/steps-${maxSteps}`,
                            }),
                        );
                        ordinal++;
                    }
                }
            }
        }
    }
    return Object.freeze(workloads);
}

function timedSemanticCases(workloads: readonly IPathWorkload[]): readonly ISemanticPathCase[] {
    return Object.freeze(
        workloads.map((workload) =>
            Object.freeze({
                ...workload,
                gridSize: GRID_SIZE,
                semanticCorpus: "timed-live-shaped" as const,
                edgeTags: Object.freeze(["live-shaped"]),
            }),
        ),
    );
}

function denseMatrix(gridSize: number): number[][] {
    return Array.from({ length: gridSize }, () => Array<number>(gridSize).fill(0));
}

function fallbackSemanticCases(seed: number): readonly ISemanticPathCase[] {
    const cases: ISemanticPathCase[] = [];
    const add = (options: {
        id: string;
        gridSize?: number;
        currentCell?: IXY;
        matrix?: number[][];
        maxSteps?: number;
        aggrBoard?: number[][];
        canFly?: boolean;
        isSmallUnit?: boolean;
        isMadeOfFire?: boolean;
        edgeTags: string[];
    }): void => {
        const gridSize = options.gridSize ?? GRID_SIZE;
        const currentCell = Object.freeze(
            options.currentCell ?? { x: Math.min(4, gridSize - 1), y: Math.min(4, gridSize - 1) },
        );
        const ordinal = cases.length;
        cases.push(
            Object.freeze({
                id: options.id,
                gridSize,
                currentCell,
                matrix: options.matrix ?? denseMatrix(gridSize),
                maxSteps: options.maxSteps ?? 3.3,
                aggrBoard: options.aggrBoard,
                canFly: options.canFly ?? false,
                isSmallUnit: options.isSmallUnit ?? true,
                isMadeOfFire: options.isMadeOfFire ?? false,
                randomSeed: (seed ^ Math.imul(ordinal + 1, 0x85eb_ca6b)) >>> 0,
                profile: options.edgeTags.join("/"),
                semanticCorpus: "fallback-edge" as const,
                edgeTags: Object.freeze([...options.edgeTags]),
            }),
        );
    };

    for (const gridSize of [1, 7, 15, 17, 31]) {
        const middle = Math.floor(gridSize / 2);
        add({
            id: `edge-custom-grid-${gridSize}`,
            gridSize,
            currentCell: { x: middle, y: middle },
            maxSteps: gridSize === 1 ? 6.3 : 2,
            edgeTags: ["custom-grid", `grid-${gridSize}`],
        });
    }

    add({
        id: "edge-fractional-x",
        currentCell: { x: 3.5, y: 4 },
        edgeTags: ["fractional-coordinate", "fractional-x"],
    });
    add({
        id: "edge-fractional-y",
        currentCell: { x: 4, y: 5.25 },
        edgeTags: ["fractional-coordinate", "fractional-y"],
    });
    add({
        id: "edge-fractional-custom-grid",
        gridSize: 7,
        currentCell: { x: 2.5, y: 3.5 },
        edgeTags: ["custom-grid", "fractional-coordinate", "fractional-xy"],
    });
    add({
        id: "edge-negative-zero-x",
        currentCell: { x: -0, y: 4 },
        edgeTags: ["negative-zero", "negative-zero-x"],
    });
    add({
        id: "edge-negative-zero-y",
        currentCell: { x: 4, y: -0 },
        edgeTags: ["negative-zero", "negative-zero-y"],
    });
    add({
        id: "edge-nan-x",
        currentCell: { x: Number.NaN, y: 4 },
        edgeTags: ["non-finite-coordinate", "nan-x"],
    });
    add({
        id: "edge-nan-y",
        currentCell: { x: 4, y: Number.NaN },
        edgeTags: ["non-finite-coordinate", "nan-y"],
    });
    add({
        id: "edge-positive-infinity-x",
        currentCell: { x: Number.POSITIVE_INFINITY, y: 4 },
        edgeTags: ["non-finite-coordinate", "positive-infinity-x"],
    });
    add({
        id: "edge-negative-infinity-x",
        currentCell: { x: Number.NEGATIVE_INFINITY, y: 4 },
        edgeTags: ["non-finite-coordinate", "negative-infinity-x"],
    });
    add({
        id: "edge-positive-infinity-y",
        currentCell: { x: 4, y: Number.POSITIVE_INFINITY },
        edgeTags: ["non-finite-coordinate", "positive-infinity-y"],
    });
    add({
        id: "edge-negative-infinity-y",
        currentCell: { x: 4, y: Number.NEGATIVE_INFINITY },
        edgeTags: ["non-finite-coordinate", "negative-infinity-y"],
    });
    add({
        id: "edge-malformed-large-anchor-x-zero",
        currentCell: { x: 0, y: 4 },
        isSmallUnit: false,
        edgeTags: ["malformed-large-anchor", "large-anchor-x-zero"],
    });

    const raggedMatrix = denseMatrix(GRID_SIZE);
    raggedMatrix[2] = [0, 0];
    raggedMatrix[3] = [];
    raggedMatrix[5] = Array<number>(9);
    raggedMatrix[5][4] = 0;
    add({
        id: "edge-ragged-matrix-rows",
        currentCell: { x: 4, y: 4 },
        matrix: raggedMatrix,
        edgeTags: ["ragged-matrix", "sparse-row"],
    });

    const sparseMatrix = new Array<number[]>(GRID_SIZE);
    sparseMatrix[4] = Array<number>(GRID_SIZE);
    sparseMatrix[4][4] = 0;
    sparseMatrix[4][5] = 0;
    sparseMatrix[5] = Array<number>(GRID_SIZE);
    sparseMatrix[5][4] = 0;
    add({
        id: "edge-sparse-matrix-outer-and-cells",
        currentCell: { x: 4, y: 4 },
        matrix: sparseMatrix,
        edgeTags: ["sparse-matrix", "sparse-outer", "sparse-cells"],
    });

    const raggedAggro = denseMatrix(GRID_SIZE);
    delete raggedAggro[3];
    add({
        id: "edge-ragged-aggr-exception",
        currentCell: { x: 4, y: 4 },
        aggrBoard: raggedAggro,
        edgeTags: ["ragged-aggr", "expected-exception"],
    });

    add({
        id: "edge-budget-nan",
        maxSteps: Number.NaN,
        edgeTags: ["non-finite-budget", "nan-budget"],
    });
    add({
        id: "edge-budget-positive-infinity",
        maxSteps: Number.POSITIVE_INFINITY,
        edgeTags: ["non-finite-budget", "positive-infinity-budget"],
    });
    add({
        id: "edge-budget-negative-infinity",
        maxSteps: Number.NEGATIVE_INFINITY,
        edgeTags: ["non-finite-budget", "negative-infinity-budget"],
    });
    add({
        id: "edge-budget-zero",
        maxSteps: 0,
        edgeTags: ["zero-budget"],
    });

    return Object.freeze(cases);
}

function float64Bits(value: number): string {
    const bytes = Buffer.allocUnsafe(8);
    bytes.writeDoubleBE(value, 0);
    return bytes.toString("hex");
}

const shapeXY = (cell: IXY): { x: string; y: string } => ({ x: float64Bits(cell.x), y: float64Bits(cell.y) });

function shapeMovePath(movePath: IMovePath): Record<string, unknown> {
    // Values alone are insufficient for an internal-change oracle: replacing a shared route/cell with a copy can
    // alter later mutation behavior while serializing to the same numbers. Assign per-result IDs on first encounter
    // in one explicit traversal order, then include the ID at every occurrence so reference aliasing is observable.
    const objectIds = new WeakMap<object, number>();
    let nextObjectId = 1;
    const objectId = (value: object): number => {
        const known = objectIds.get(value);
        if (known !== undefined) return known;
        const assigned = nextObjectId++;
        objectIds.set(value, assigned);
        return assigned;
    };
    const shapeXYReference = (cell: IXY): Record<string, unknown> => ({
        objectId: objectId(cell),
        ...shapeXY(cell),
    });

    const movePathObjectId = objectId(movePath);
    const cellsObjectId = objectId(movePath.cells);
    const cells = movePath.cells.map(shapeXYReference);
    const hashesObjectId = objectId(movePath.hashes);
    const hashes = [...movePath.hashes].map(float64Bits);
    const knownPathsObjectId = objectId(movePath.knownPaths);
    const knownPaths = [...movePath.knownPaths].map(([key, routes]) => {
        const routesObjectId = objectId(routes);
        return {
            key: float64Bits(key),
            routesObjectId,
            routes: routes.map((route) => {
                const routeObjectId = objectId(route);
                const cell = shapeXYReference(route.cell);
                const routeArrayObjectId = objectId(route.route);
                const routeCells = route.route.map(shapeXYReference);
                return {
                    routeObjectId,
                    cell,
                    routeArrayObjectId,
                    route: routeCells,
                    weight: float64Bits(route.weight),
                    firstAggrMet: route.firstAggrMet,
                    hasLavaCell: route.hasLavaCell,
                    hasWaterCell: route.hasWaterCell,
                };
            }),
        };
    });
    return {
        movePathObjectId,
        cells: { objectId: cellsObjectId, values: cells },
        hashes: { objectId: hashesObjectId, values: hashes },
        knownPaths: { objectId: knownPathsObjectId, entries: knownPaths },
        objectCount: nextObjectId - 1,
    };
}

function shapeNumericArray(values: number[]): Record<string, unknown> {
    const entries: Array<{ index: number; value: string }> = [];
    for (let index = 0; index < values.length; index++) {
        if (Object.prototype.hasOwnProperty.call(values, index)) {
            entries.push({ index, value: float64Bits(values[index]) });
        }
    }
    return { length: values.length, entries };
}

function shapeNumericMatrix(matrix: number[][]): Record<string, unknown> {
    const rows: Array<{ index: number; row: Record<string, unknown> }> = [];
    for (let index = 0; index < matrix.length; index++) {
        if (Object.prototype.hasOwnProperty.call(matrix, index)) {
            rows.push({ index, row: shapeNumericArray(matrix[index]) });
        }
    }
    return { length: matrix.length, rows };
}

function shapeWorkload(workload: IPathWorkload): Record<string, unknown> {
    return {
        id: workload.id,
        currentCell: shapeXY(workload.currentCell),
        matrix: shapeNumericMatrix(workload.matrix),
        maxSteps: float64Bits(workload.maxSteps),
        aggrBoard: workload.aggrBoard ? shapeNumericMatrix(workload.aggrBoard) : null,
        canFly: workload.canFly,
        isSmallUnit: workload.isSmallUnit,
        isMadeOfFire: workload.isMadeOfFire,
        randomSeed: float64Bits(workload.randomSeed),
        profile: workload.profile,
    };
}

function shapeSemanticCase(semanticCase: ISemanticPathCase): Record<string, unknown> {
    return {
        ...shapeWorkload(semanticCase),
        gridSize: float64Bits(semanticCase.gridSize),
        semanticCorpus: semanticCase.semanticCorpus,
        edgeTags: semanticCase.edgeTags,
    };
}

function workloadDigest(workloads: readonly IPathWorkload[]): string {
    return digest(workloads.map(shapeWorkload));
}

function makeHelper(variant: IVariantRuntime, gridSize = GRID_SIZE): IPathHelperInstance {
    const settings = new variant.GridSettings(gridSize, 2048, 0, 1024, -1024, 5, 0.06);
    return new variant.PathHelper(settings);
}

function errorShape(error: unknown): Record<string, unknown> {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            cause:
                error.cause === undefined
                    ? null
                    : error.cause instanceof Error
                      ? { name: error.cause.name, message: error.cause.message }
                      : String(error.cause),
        };
    }
    return { name: typeof error, message: String(error), cause: null };
}

function executeSemanticCase(
    variant: IVariantRuntime,
    helper: IPathHelperInstance,
    workload: ISemanticPathCase,
): { outcome: Record<string, unknown> & { returned: boolean }; rngTail: string[] } {
    const previous = variant.random.getDeterministicRandomSource();
    const source = mulberry32(workload.randomSeed);
    variant.random.setDeterministicRandomSource(source);
    try {
        let outcome: Record<string, unknown> & { returned: boolean };
        try {
            outcome = {
                returned: true,
                value: shapeMovePath(
                    helper.getMovePath(
                        workload.currentCell as IXY,
                        workload.matrix,
                        workload.maxSteps,
                        workload.aggrBoard,
                        workload.canFly,
                        workload.isSmallUnit,
                        workload.isMadeOfFire,
                    ),
                ),
            };
        } catch (error) {
            outcome = { returned: false, exception: errorShape(error) };
        }
        return { outcome, rngTail: Array.from({ length: 8 }, () => float64Bits(source())) };
    } finally {
        variant.random.setDeterministicRandomSource(previous);
    }
}

function verifySemanticCorpus(
    baseline: IVariantRuntime,
    candidate: IVariantRuntime,
    cases: readonly ISemanticPathCase[],
): Record<string, unknown> & { passed: boolean } {
    const baselineHelpers = new Map<number, IPathHelperInstance>();
    const candidateHelpers = new Map<number, IPathHelperInstance>();
    const helperFor = (
        helpers: Map<number, IPathHelperInstance>,
        variant: IVariantRuntime,
        gridSize: number,
    ): IPathHelperInstance => {
        let helper = helpers.get(gridSize);
        if (!helper) {
            helper = makeHelper(variant, gridSize);
            helpers.set(gridSize, helper);
        }
        return helper;
    };
    const baselineHash = createHash("sha256");
    const candidateHash = createHash("sha256");
    const mismatches: Array<Record<string, unknown>> = [];
    const inputsBefore = digest(cases.map(shapeSemanticCase));
    let mutationDetected = false;
    let mismatchCount = 0;
    let baselineExceptionCount = 0;
    let candidateExceptionCount = 0;
    for (const semanticCase of cases) {
        const before = digest(shapeSemanticCase(semanticCase));
        const baselineResult = executeSemanticCase(
            baseline,
            helperFor(baselineHelpers, baseline, semanticCase.gridSize),
            semanticCase,
        );
        const afterBaseline = digest(shapeSemanticCase(semanticCase));
        const candidateResult = executeSemanticCase(
            candidate,
            helperFor(candidateHelpers, candidate, semanticCase.gridSize),
            semanticCase,
        );
        const afterCandidate = digest(shapeSemanticCase(semanticCase));
        const baselineJson = canonicalJson(baselineResult);
        const candidateJson = canonicalJson(candidateResult);
        baselineHash.update(`${semanticCase.id}\0${baselineJson}\n`);
        candidateHash.update(`${semanticCase.id}\0${candidateJson}\n`);
        if (!baselineResult.outcome.returned) baselineExceptionCount++;
        if (!candidateResult.outcome.returned) candidateExceptionCount++;
        const inputsUnchanged = before === afterBaseline && before === afterCandidate;
        mutationDetected ||= !inputsUnchanged;
        if (baselineJson !== candidateJson || !inputsUnchanged) {
            mismatchCount++;
            if (mismatches.length < 12) {
                mismatches.push({
                    caseId: semanticCase.id,
                    gridSize: semanticCase.gridSize,
                    profile: semanticCase.profile,
                    edgeTags: semanticCase.edgeTags,
                    outputsIdentical: baselineJson === candidateJson,
                    inputsUnchanged,
                    inputSha256: { before, afterBaseline, afterCandidate },
                    baselineResultSha256: sha256(baselineJson),
                    candidateResultSha256: sha256(candidateJson),
                    baselineReturned: baselineResult.outcome.returned,
                    candidateReturned: candidateResult.outcome.returned,
                });
            }
        }
    }
    const inputsAfter = digest(cases.map(shapeSemanticCase));
    const baselineSha256 = baselineHash.digest("hex");
    const candidateSha256 = candidateHash.digest("hex");
    const passed =
        baselineSha256 === candidateSha256 && !mutationDetected && inputsBefore === inputsAfter && mismatchCount === 0;
    const gridSizeCounts = new Map<number, number>();
    const edgeTagCounts = new Map<string, number>();
    for (const semanticCase of cases) {
        gridSizeCounts.set(semanticCase.gridSize, (gridSizeCounts.get(semanticCase.gridSize) ?? 0) + 1);
        for (const tag of semanticCase.edgeTags) edgeTagCounts.set(tag, (edgeTagCounts.get(tag) ?? 0) + 1);
    }
    return {
        passed,
        corpus: cases[0]?.semanticCorpus ?? null,
        cases: cases.length,
        caseIds: cases.map((semanticCase) => semanticCase.id),
        gridSizeCounts: Object.fromEntries([...gridSizeCounts].sort((a, b) => a[0] - b[0])),
        edgeTagCounts: Object.fromEntries([...edgeTagCounts].sort(([a], [b]) => a.localeCompare(b))),
        baselineSha256,
        candidateSha256,
        exceptions: {
            baseline: baselineExceptionCount,
            candidate: candidateExceptionCount,
            countsEqual: baselineExceptionCount === candidateExceptionCount,
        },
        inputs: {
            denseNumericRowsFrozen: false,
            sparseAndRaggedTopologyEncoded: true,
            beforeSha256: inputsBefore,
            afterSha256: inputsAfter,
            unchanged: inputsBefore === inputsAfter && !mutationDetected,
        },
        mismatchCount,
        mismatches,
    };
}

function verifySemantics(
    baseline: IVariantRuntime,
    candidate: IVariantRuntime,
    timedLiveCases: readonly ISemanticPathCase[],
    fallbackEdgeCases: readonly ISemanticPathCase[],
): Record<string, unknown> & { passed: boolean } {
    const timedLiveShaped = verifySemanticCorpus(baseline, candidate, timedLiveCases);
    const fallbackEdge = verifySemanticCorpus(baseline, candidate, fallbackEdgeCases);
    const inputsBefore = digest({
        timedLiveShaped: (timedLiveShaped.inputs as { beforeSha256: string }).beforeSha256,
        fallbackEdge: (fallbackEdge.inputs as { beforeSha256: string }).beforeSha256,
    });
    const inputsAfter = digest({
        timedLiveShaped: (timedLiveShaped.inputs as { afterSha256: string }).afterSha256,
        fallbackEdge: (fallbackEdge.inputs as { afterSha256: string }).afterSha256,
    });
    const baselineSha256 = digest({
        timedLiveShaped: timedLiveShaped.baselineSha256,
        fallbackEdge: fallbackEdge.baselineSha256,
    });
    const candidateSha256 = digest({
        timedLiveShaped: timedLiveShaped.candidateSha256,
        fallbackEdge: fallbackEdge.candidateSha256,
    });
    const mismatchCount = (timedLiveShaped.mismatchCount as number) + (fallbackEdge.mismatchCount as number);
    const inputsUnchanged =
        (timedLiveShaped.inputs as { unchanged: boolean }).unchanged &&
        (fallbackEdge.inputs as { unchanged: boolean }).unchanged &&
        inputsBefore === inputsAfter;
    return {
        passed:
            timedLiveShaped.passed &&
            fallbackEdge.passed &&
            baselineSha256 === candidateSha256 &&
            inputsUnchanged &&
            mismatchCount === 0,
        cases: timedLiveCases.length + fallbackEdgeCases.length,
        comparison:
            "ordered cells/hashes/knownPaths/routes; Float64 bit patterns for every coordinate, key, and weight; per-result WeakMap traversal IDs preserving all container/route/XY reference aliases; exact exception name/message/cause; eight-draw RNG tail; sparse/ragged input topology and immutability",
        baselineSha256,
        candidateSha256,
        corpora: { timedLiveShaped, fallbackEdge },
        inputs: {
            denseNumericRowsFrozen: false,
            sparseAndRaggedTopologyEncoded: true,
            beforeSha256: inputsBefore,
            afterSha256: inputsAfter,
            unchanged: inputsUnchanged,
        },
        mismatchCount,
    };
}

function fold(checksum: number, value: number): number {
    return Math.imul((checksum ^ value) >>> 0, FNV_PRIME) >>> 0;
}

function foldFloat(checksum: number, value: number): number {
    FLOAT64_SCRATCH.setFloat64(0, value, true);
    checksum = fold(checksum, FLOAT64_SCRATCH.getUint32(0, true));
    return fold(checksum, FLOAT64_SCRATCH.getUint32(4, true));
}

function foldCell(checksum: number, cell: IXY): number {
    checksum = foldFloat(checksum, cell.x);
    return foldFloat(checksum, cell.y);
}

function foldRouteSummary(checksum: number, route: IWeightedRoute): number {
    checksum = foldFloat(checksum, route.weight);
    checksum = fold(checksum, route.route.length);
    checksum = foldCell(checksum, route.cell);
    if (route.route.length) {
        checksum = foldCell(checksum, route.route[0]);
        checksum = foldCell(checksum, route.route[route.route.length - 1]);
    }
    checksum = fold(checksum, route.firstAggrMet ? 1 : 0);
    checksum = fold(checksum, route.hasLavaCell ? 1 : 0);
    return fold(checksum, route.hasWaterCell ? 1 : 0);
}

function foldMovePath(checksum: number, movePath: IMovePath): number {
    checksum = fold(checksum, movePath.cells.length);
    if (movePath.cells.length) {
        checksum = foldCell(checksum, movePath.cells[0]);
        checksum = foldCell(checksum, movePath.cells[movePath.cells.length - 1]);
    }
    checksum = fold(checksum, movePath.hashes.size);
    checksum = fold(checksum, movePath.knownPaths.size);
    for (const [key, routes] of movePath.knownPaths) {
        checksum = foldFloat(checksum, key);
        checksum = fold(checksum, routes.length);
        // The exact preflight already hashes every route and coordinate. The timed sink deliberately consumes only
        // the first/last ordered routes so it prevents dead-code elimination without becoming the measured workload.
        if (routes.length) {
            checksum = foldRouteSummary(checksum, routes[0]);
            if (routes.length > 1) checksum = foldRouteSummary(checksum, routes[routes.length - 1]);
        }
    }
    return checksum;
}

function captureBatchOutputs(
    variant: IVariantRuntime,
    helper: IPathHelperInstance,
    workloads: readonly IPathWorkload[],
    seed: number,
): { movePaths: IMovePath[]; rngTail: number[] } {
    const previous = variant.random.getDeterministicRandomSource();
    const source = mulberry32(seed);
    variant.random.setDeterministicRandomSource(source);
    try {
        return {
            movePaths: workloads.map((workload) =>
                helper.getMovePath(
                    workload.currentCell as IXY,
                    workload.matrix,
                    workload.maxSteps,
                    workload.aggrBoard,
                    workload.canFly,
                    workload.isSmallUnit,
                    workload.isMadeOfFire,
                ),
            ),
            rngTail: Array.from({ length: 8 }, () => source()),
        };
    } finally {
        variant.random.setDeterministicRandomSource(previous);
    }
}

function foldTimedBatchSink(movePaths: readonly IMovePath[], rngTail: readonly number[]): number {
    let checksum = FNV_OFFSET;
    let lastMovePath: IMovePath | undefined;
    for (const movePath of movePaths) {
        checksum = fold(checksum, movePath.cells.length);
        checksum = fold(checksum, movePath.hashes.size);
        checksum = fold(checksum, movePath.knownPaths.size);
        lastMovePath = movePath;
    }
    if (lastMovePath) checksum = foldMovePath(checksum, lastMovePath);
    for (const value of rngTail) checksum = foldFloat(checksum, value);
    return checksum;
}

function checksumOnlyRunner(batch: { movePaths: IMovePath[]; rngTail: number[] }): () => number {
    return (): number => {
        return foldTimedBatchSink(batch.movePaths, batch.rngTail);
    };
}

function checksumOverheadDiagnostic(
    batch: { movePaths: IMovePath[]; rngTail: number[] },
    workloadCount: number,
): Record<string, unknown> {
    const run = checksumOnlyRunner(batch);
    for (let warmup = 0; warmup < 25; warmup++) run();
    let pilotIterations = 1;
    let pilot = measure(run, pilotIterations);
    while (pilot.durationNs < 5_000_000 && pilotIterations < 1 << 20) {
        pilotIterations *= 2;
        pilot = measure(run, pilotIterations);
    }
    const iterations = Math.max(1, Math.round((25_000_000 * pilotIterations) / Math.max(1, pilot.durationNs)));
    const samples = Array.from({ length: 9 }, () => measure(run, iterations).durationNs);
    const perOutput = samples.map((duration) => duration / (iterations * workloadCount));
    return {
        scope: "exact timed sink over cached outputs: all batch result sizes plus the last result's ordered keys/boundary routes and RNG tail; excludes PathHelper, input traversal, and RNG setup",
        allocationsInFoldFloat: 0,
        sampledBlocks: samples.length,
        iterationsPerBlock: iterations,
        nanosecondsPerOutput: {
            median: quantile(perOutput, 0.5),
            p95: quantile(perOutput, 0.95),
            minimum: Math.min(...perOutput),
            maximum: Math.max(...perOutput),
        },
        checksum: run(),
    };
}

function pathRunner(
    variant: IVariantRuntime,
    helper: IPathHelperInstance,
    workloads: readonly IPathWorkload[],
    seed: number,
): () => number {
    return (): number => {
        const previous = variant.random.getDeterministicRandomSource();
        const source = mulberry32(seed);
        variant.random.setDeterministicRandomSource(source);
        let checksum = FNV_OFFSET;
        let lastMovePath: IMovePath | undefined;
        try {
            for (const workload of workloads) {
                const movePath = helper.getMovePath(
                    workload.currentCell as IXY,
                    workload.matrix,
                    workload.maxSteps,
                    workload.aggrBoard,
                    workload.canFly,
                    workload.isSmallUnit,
                    workload.isMadeOfFire,
                );
                checksum = fold(checksum, movePath.cells.length);
                checksum = fold(checksum, movePath.hashes.size);
                checksum = fold(checksum, movePath.knownPaths.size);
                lastMovePath = movePath;
            }
            if (lastMovePath) checksum = foldMovePath(checksum, lastMovePath);
            for (let tail = 0; tail < 8; tail++) checksum = foldFloat(checksum, source());
            return checksum;
        } finally {
            variant.random.setDeterministicRandomSource(previous);
        }
    };
}

const nowNs = (): bigint => process.hrtime.bigint();

function measure(run: () => number, iterations: number): { durationNs: number; checksum: number } {
    let checksum = FNV_OFFSET;
    const started = nowNs();
    for (let iteration = 0; iteration < iterations; iteration++) checksum = fold(checksum, run());
    return { durationNs: Number(nowNs() - started), checksum };
}

function warmUp(baseline: () => number, candidate: () => number, warmupMs: number): number {
    const deadline = nowNs() + BigInt(Math.ceil(warmupMs * 1_000_000));
    let pairs = 0;
    while (nowNs() < deadline) {
        if (pairs % 2 === 0) {
            baseline();
            candidate();
        } else {
            candidate();
            baseline();
        }
        pairs++;
    }
    return pairs;
}

function calibrate(
    baseline: () => number,
    candidate: () => number,
    targetMs: number,
): {
    iterations: number;
    pilotIterations: number;
    pilotBaselineMs: number;
    pilotCandidateMs: number;
    estimatedBaselineMs: number;
    estimatedCandidateMs: number;
} {
    let pilotIterations = 1;
    let baselinePilot = measure(baseline, pilotIterations);
    let candidatePilot = measure(candidate, pilotIterations);
    while (Math.min(baselinePilot.durationNs, candidatePilot.durationNs) < 5_000_000 && pilotIterations < 1 << 18) {
        pilotIterations *= 2;
        baselinePilot = measure(baseline, pilotIterations);
        candidatePilot = measure(candidate, pilotIterations);
    }
    const meanNsPerIteration =
        (baselinePilot.durationNs + candidatePilot.durationNs) / (2 * Math.max(1, pilotIterations));
    const iterations = Math.max(1, Math.round((targetMs * 1_000_000) / Math.max(1, meanNsPerIteration)));
    return {
        iterations,
        pilotIterations,
        pilotBaselineMs: baselinePilot.durationNs / 1_000_000,
        pilotCandidateMs: candidatePilot.durationNs / 1_000_000,
        estimatedBaselineMs: (baselinePilot.durationNs / pilotIterations / 1_000_000) * iterations,
        estimatedCandidateMs: (candidatePilot.durationNs / pilotIterations / 1_000_000) * iterations,
    };
}

function runPairedBlocks(options: {
    baseline: () => number;
    candidate: () => number;
    blocks: number;
    iterations: number;
    workloadCount: number;
}): IPairedSamples {
    const baseline: IArmSample[] = [];
    const candidate: IArmSample[] = [];
    const callsPerArm = options.iterations * options.workloadCount;
    const capture = (variant: VariantName, block: number, order: "AB" | "BA"): void => {
        const result = measure(variant === "baseline" ? options.baseline : options.candidate, options.iterations);
        const sample = {
            block,
            order,
            durationNs: result.durationNs,
            nanosecondsPerGetMovePath: result.durationNs / callsPerArm,
            checksum: result.checksum,
        };
        (variant === "baseline" ? baseline : candidate).push(sample);
    };
    for (let block = 0; block < options.blocks; block++) {
        const order = block % 2 === 0 ? "AB" : "BA";
        if (order === "AB") {
            capture("baseline", block, order);
            capture("candidate", block, order);
        } else {
            capture("candidate", block, order);
            capture("baseline", block, order);
        }
    }
    baseline.sort((a, b) => a.block - b.block);
    candidate.sort((a, b) => a.block - b.block);
    return { baseline, candidate, iterationsPerArm: options.iterations, callsPerArm };
}

function quantile(values: readonly number[], probability: number): number {
    if (!values.length) throw new Error("cannot calculate a quantile of an empty sample");
    const sorted = [...values].sort((a, b) => a - b);
    if (sorted.length === 1) return sorted[0];
    const position = (sorted.length - 1) * probability;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    const fraction = position - lower;
    return sorted[lower] * (1 - fraction) + sorted[upper] * fraction;
}

function interval(values: readonly number[]): IInterval {
    return {
        lower95: quantile(values, 0.025),
        median: quantile(values, 0.5),
        upper95: quantile(values, 0.975),
    };
}

function summarizeSamples(samples: readonly IArmSample[]): Record<string, unknown> {
    const values = samples.map((sample) => sample.nanosecondsPerGetMovePath);
    return {
        blocks: values.length,
        unit: "nanoseconds/getMovePath (block-average throughput, not individual-call latency)",
        median: quantile(values, 0.5),
        p95: quantile(values, 0.95),
        p99: quantile(values, 0.99),
        minimum: Math.min(...values),
        maximum: Math.max(...values),
        samples,
    };
}

function pairedBootstrap(
    paired: IPairedSamples,
    samples: number,
    seed: number,
): Record<string, unknown> & {
    medianRatio: IInterval;
    medianReduction: IInterval;
    p95Ratio: IInterval;
    p99Ratio: IInterval;
} {
    const random = mulberry32(seed);
    const baseline = paired.baseline.map((sample) => sample.nanosecondsPerGetMovePath);
    const candidate = paired.candidate.map((sample) => sample.nanosecondsPerGetMovePath);
    if (baseline.length !== candidate.length) throw new Error("paired arms have different block counts");
    const medianRatios: number[] = [];
    const medianReductions: number[] = [];
    const p95Ratios: number[] = [];
    const p99Ratios: number[] = [];
    for (let sample = 0; sample < samples; sample++) {
        const baseResample: number[] = [];
        const candResample: number[] = [];
        for (let pair = 0; pair < baseline.length; pair++) {
            const index = Math.floor(random() * baseline.length);
            baseResample.push(baseline[index]);
            candResample.push(candidate[index]);
        }
        const medianRatio = quantile(candResample, 0.5) / quantile(baseResample, 0.5);
        medianRatios.push(medianRatio);
        medianReductions.push(1 - medianRatio);
        p95Ratios.push(quantile(candResample, 0.95) / quantile(baseResample, 0.95));
        p99Ratios.push(quantile(candResample, 0.99) / quantile(baseResample, 0.99));
    }
    return {
        method: "paired nonparametric bootstrap; whole alternating AB/BA block pairs resampled with replacement",
        samples,
        seed,
        medianRatio: interval(medianRatios),
        medianReduction: interval(medianReductions),
        p95Ratio: interval(p95Ratios),
        p99Ratio: interval(p99Ratios),
    };
}

function benchmarkResult(
    cli: ICliOptions,
    baseline: IVariantRuntime,
    candidate: IVariantRuntime,
    workloads: readonly IPathWorkload[],
): Record<string, unknown> & {
    checksumsEqual: boolean;
    medianReduction: number;
    bootstrap: ReturnType<typeof pairedBootstrap>;
} {
    const benchmarkSeed = cli.seed ^ 0x5255_4e53;
    const baselineBatch = captureBatchOutputs(baseline, makeHelper(baseline), workloads, benchmarkSeed);
    const candidateBatch = captureBatchOutputs(candidate, makeHelper(candidate), workloads, benchmarkSeed);
    const baselineBatchJson = canonicalJson({
        movePaths: baselineBatch.movePaths.map(shapeMovePath),
        rngTail: baselineBatch.rngTail.map(float64Bits),
    });
    const candidateBatchJson = canonicalJson({
        movePaths: candidateBatch.movePaths.map(shapeMovePath),
        rngTail: candidateBatch.rngTail.map(float64Bits),
    });
    const fullOutputPreflight = {
        mode: "untimed continuous-RNG batch matching the timed runner",
        baselineSha256: sha256(baselineBatchJson),
        candidateSha256: sha256(candidateBatchJson),
        identical: baselineBatchJson === candidateBatchJson,
    };
    const checksumOverhead = checksumOverheadDiagnostic(baselineBatch, workloads.length);
    const baselineRun = pathRunner(baseline, makeHelper(baseline), workloads, benchmarkSeed);
    const candidateRun = pathRunner(candidate, makeHelper(candidate), workloads, benchmarkSeed);
    const warmupPairs = warmUp(baselineRun, candidateRun, cli.warmupMs);
    const calibration = calibrate(baselineRun, candidateRun, cli.targetMs);
    const paired = runPairedBlocks({
        baseline: baselineRun,
        candidate: candidateRun,
        blocks: cli.blocks,
        iterations: calibration.iterations,
        workloadCount: workloads.length,
    });
    const baselineSummary = summarizeSamples(paired.baseline);
    const candidateSummary = summarizeSamples(paired.candidate);
    const baselineMedian = baselineSummary.median as number;
    const candidateMedian = candidateSummary.median as number;
    const bootstrap = pairedBootstrap(paired, cli.bootstrapSamples, cli.seed ^ 0x5042_5354);
    const baselineChecksums = paired.baseline.map((sample) => sample.checksum);
    const candidateChecksums = paired.candidate.map((sample) => sample.checksum);
    const timedChecksumsEqual = baselineChecksums.every((checksum, index) => checksum === candidateChecksums[index]);
    const checksumsEqual = timedChecksumsEqual && fullOutputPreflight.identical;
    return {
        fullOutputPreflight,
        checksumOverhead,
        warmup: { durationMs: cli.warmupMs, alternatingPairs: warmupPairs },
        calibration: {
            method: "one shared iteration count derived from warmed baseline/candidate pilot mean",
            targetMsPerArm: cli.targetMs,
            ...calibration,
            callsPerArm: paired.callsPerArm,
        },
        executionOrders: paired.baseline.map((sample) => sample.order),
        baseline: baselineSummary,
        candidate: candidateSummary,
        pointEstimate: {
            medianRatio: candidateMedian / baselineMedian,
            medianReduction: 1 - candidateMedian / baselineMedian,
            p95Ratio: (candidateSummary.p95 as number) / (baselineSummary.p95 as number),
            p99Ratio: (candidateSummary.p99 as number) / (baselineSummary.p99 as number),
        },
        medianReduction: 1 - candidateMedian / baselineMedian,
        bootstrap,
        checksumsEqual,
        checksums: {
            timedPairsEqual: timedChecksumsEqual,
            baseline: baselineChecksums,
            candidate: candidateChecksums,
            pairedSha256: digest({ baseline: baselineChecksums, candidate: candidateChecksums }),
            coverage:
                "timed sink: sizes for every batch result, then last-result boundary cells, every ordered known-path key/route count, first/last route endpoints/weights/lengths/flags, and RNG tail. The untimed continuous-RNG batch preflight compares every output bit",
        },
    };
}

function environmentSeal(): Record<string, unknown> {
    const processors = cpus();
    return {
        bunVersion: Bun.version,
        bunRevision: Bun.revision,
        processVersions: process.versions,
        platform: platform(),
        release: release(),
        architecture: arch(),
        cpuModel: processors[0]?.model ?? null,
        logicalCpuCount: processors.length,
        totalMemoryBytes: totalmem(),
        freeMemoryBytesAtStart: freemem(),
        loadAverageAtStart: loadavg(),
        processId: process.pid,
        command: process.argv,
    };
}

function coverageSummary(workloads: readonly IPathWorkload[]): Record<string, unknown> {
    const count = (predicate: (workload: IPathWorkload) => boolean): number => workloads.filter(predicate).length;
    return {
        workloadCount: workloads.length,
        grid: "16x16 dense matrix[y][x]",
        aggressionLayout: "aggrBoard[x][y]",
        small: count((workload) => workload.isSmallUnit),
        large: count((workload) => !workload.isSmallUnit),
        ground: count((workload) => !workload.canFly),
        fly: count((workload) => workload.canFly),
        normal: count((workload) => !workload.isMadeOfFire),
        madeOfFire: count((workload) => workload.isMadeOfFire),
        noAggro: count((workload) => workload.aggrBoard === undefined),
        weightedAggro: count((workload) => workload.aggrBoard !== undefined),
        stepBudgets: Object.fromEntries(
            STEP_BUDGETS.map((steps) => [String(steps), count((workload) => workload.maxSteps === steps)]),
        ),
        obstacleKinds: ["occupied(1)", "occupied(2)", "BLOCK", "HOLE", "LAVA", "WATER"],
    };
}

function gateResult(options: {
    smoke: boolean;
    overlayExact: boolean;
    runtimeIsolationExact: boolean;
    semanticPassed: boolean;
    inputUnchanged: boolean;
    sourceIntegrityExact: boolean;
    runnerUnchanged: boolean;
    benchmark: ReturnType<typeof benchmarkResult> | null;
}): Record<string, unknown> & { passed: boolean } {
    const performanceApplicable = !options.smoke && options.benchmark !== null;
    const checks = [
        {
            id: "exact-source-difference",
            threshold: "only src/grid/path_helper.ts differs (zero differences allowed only in explicit smoke mode)",
            observed: options.overlayExact,
            applicable: true,
            passed: options.overlayExact,
        },
        {
            id: "distinct-runtime-graphs",
            threshold: "distinct roots, constructors, and deterministic RNG module state",
            observed: options.runtimeIsolationExact,
            applicable: true,
            passed: options.runtimeIsolationExact,
        },
        {
            id: "exact-semantic-preflight",
            threshold: "all ordered bit-exact outputs/exceptions/RNG tails match",
            observed: options.semanticPassed,
            applicable: true,
            passed: options.semanticPassed,
        },
        {
            id: "input-immutability",
            threshold: "workload hashes unchanged across semantic and timed calls",
            observed: options.inputUnchanged,
            applicable: true,
            passed: options.inputUnchanged,
        },
        {
            id: "source-and-runner-integrity",
            threshold: "both recursively sealed src trees and runner bytes unchanged before/after",
            observed: options.sourceIntegrityExact && options.runnerUnchanged,
            applicable: true,
            passed: options.sourceIntegrityExact && options.runnerUnchanged,
        },
        {
            id: "timed-checksums",
            threshold: "every paired timed output checksum is equal",
            observed: options.benchmark?.checksumsEqual ?? false,
            applicable: options.benchmark !== null,
            passed: options.benchmark?.checksumsEqual ?? false,
        },
        {
            id: "full-path-median-reduction",
            threshold: ">= 0.03",
            observed: options.benchmark?.medianReduction ?? null,
            applicable: performanceApplicable,
            passed: !performanceApplicable || (options.benchmark?.medianReduction ?? Number.NEGATIVE_INFINITY) >= 0.03,
        },
        {
            id: "full-path-median-ratio-upper95",
            threshold: "< 1.00",
            observed: options.benchmark?.bootstrap.medianRatio.upper95 ?? null,
            applicable: performanceApplicable,
            passed: !performanceApplicable || (options.benchmark?.bootstrap.medianRatio.upper95 ?? Infinity) < 1,
        },
        {
            id: "block-average-p95-ratio-upper95",
            threshold: "<= 1.05",
            observed: options.benchmark?.bootstrap.p95Ratio.upper95 ?? null,
            applicable: performanceApplicable,
            passed: !performanceApplicable || (options.benchmark?.bootstrap.p95Ratio.upper95 ?? Infinity) <= 1.05,
        },
        {
            id: "block-average-p99-ratio-upper95",
            threshold: "<= 1.05",
            observed: options.benchmark?.bootstrap.p99Ratio.upper95 ?? null,
            applicable: performanceApplicable,
            passed: !performanceApplicable || (options.benchmark?.bootstrap.p99Ratio.upper95 ?? Infinity) <= 1.05,
        },
    ];
    return { passed: checks.every((check) => check.passed), checks };
}

async function main(): Promise<void> {
    const cli = parseCli(process.argv.slice(2));
    const environment = environmentSeal();
    const runnerBefore = runnerSeal();
    const baselineBefore = sourceSeal(cli.baselineRoot);
    const candidateBefore = sourceSeal(cli.candidateRoot);
    const overlayBefore = compareSourceTrees(baselineBefore, candidateBefore, cli.allowIdenticalSources);
    if (!overlayBefore.exact) {
        throw new Error(`source isolation failed: ${JSON.stringify(overlayBefore.differences)}`);
    }
    const baseline = await loadVariant("baseline", cli.baselineRoot);
    const candidate = await loadVariant("candidate", cli.candidateRoot);
    const isolation = runtimeIsolation(baseline, candidate);
    if (!isolation.exact) throw new Error(`runtime source-graph isolation failed: ${JSON.stringify(isolation)}`);
    assertMatchingObstacleValues(baseline, candidate);
    const workloads = pathWorkloads(cli.seed, baseline.obstacleType);
    const workloadsBefore = workloadDigest(workloads);
    const timedLiveSemanticCases = timedSemanticCases(workloads);
    const fallbackEdgeCases = fallbackSemanticCases(cli.seed);
    const semantics = verifySemantics(baseline, candidate, timedLiveSemanticCases, fallbackEdgeCases);
    const benchmark = semantics.passed ? benchmarkResult(cli, baseline, candidate, workloads) : null;
    const workloadsAfter = workloadDigest(workloads);
    const baselineAfter = sourceSeal(cli.baselineRoot);
    const candidateAfter = sourceSeal(cli.candidateRoot);
    const overlayAfter = compareSourceTrees(baselineAfter, candidateAfter, cli.allowIdenticalSources);
    const runnerAfter = runnerSeal();
    const sourceIntegrityExact =
        digest(sourceSealIdentity(baselineBefore)) === digest(sourceSealIdentity(baselineAfter)) &&
        digest(sourceSealIdentity(candidateBefore)) === digest(sourceSealIdentity(candidateAfter)) &&
        canonicalJson(overlayBefore) === canonicalJson(overlayAfter);
    const runnerUnchanged = runnerBefore.sha256 === runnerAfter.sha256;
    const inputUnchanged =
        workloadsBefore === workloadsAfter &&
        semantics.inputs !== undefined &&
        (semantics.inputs as { unchanged?: boolean }).unchanged === true;
    const gates = gateResult({
        smoke: cli.smoke,
        overlayExact: overlayBefore.exact && overlayAfter.exact,
        runtimeIsolationExact: isolation.exact,
        semanticPassed: semantics.passed,
        inputUnchanged,
        sourceIntegrityExact,
        runnerUnchanged,
        benchmark,
    });
    const reportWithoutDigest = {
        schema: SCHEMA,
        generatedAt: new Date().toISOString(),
        mode: cli.smoke ? "smoke-not-authoritative" : "evidence",
        labels: {
            baseline: `${baseline.realRoot}/src/grid/path_helper.ts`,
            candidate: `${candidate.realRoot}/src/grid/path_helper.ts`,
        },
        configuration: {
            blocks: cli.blocks,
            targetMsPerArm: cli.targetMs,
            warmupMs: cli.warmupMs,
            bootstrapSamples: cli.bootstrapSamples,
            seed: cli.seed,
            enforce: cli.enforce,
            allowIdenticalSources: cli.allowIdenticalSources,
            pairing: "31 alternating AB/BA blocks by default; odd block count leaves one extra AB",
        },
        methodology: {
            measuredCall: "full production PathHelper.getMovePath",
            sourceLoading:
                "each arm dynamically imports its own path_helper.ts, grid_settings.ts, and utils/lib.ts from a distinct real source root",
            timingClock: "process.hrtime.bigint",
            calibration: "one shared warmed iteration count targets 150ms per arm by default",
            semanticPreflight:
                "bit-exact ordered result graph including reference-alias topology, exceptions, independent-root deterministic RNG tails, and input immutability",
            bootstrap: "paired whole-block nonparametric resampling with deterministic seed",
            tailLabel:
                "reported p95/p99 are quantiles of block-average getMovePath throughput; they are not individual-call latency tails",
            smokeWarning:
                "smoke mode proves wiring, isolation, semantics, checksums, and integrity only; its performance observations are non-authoritative and performance gates are not applicable",
        },
        environment,
        roots: {
            baselineBefore: publicSourceSeal(baselineBefore),
            candidateBefore: publicSourceSeal(candidateBefore),
            baselineAfter: publicSourceSeal(baselineAfter),
            candidateAfter: publicSourceSeal(candidateAfter),
            recursiveSourceOverlayBefore: overlayBefore,
            recursiveSourceOverlayAfter: overlayAfter,
            runtimeIsolation: isolation,
        },
        runner: { before: runnerBefore, after: runnerAfter, unchanged: runnerUnchanged },
        integrity: {
            sourceIntegrityExact,
            workloadsBeforeSha256: workloadsBefore,
            workloadsAfterSha256: workloadsAfter,
            workloadsUnchanged: inputUnchanged,
            dependencySeal: {
                sealed: false,
                limitation:
                    "dependency installation is identified by resolved node_modules path and lock hash; dependency contents are not recursively hashed",
            },
        },
        coverage: coverageSummary(workloads),
        semantics,
        benchmark,
        gates,
    };
    const report = { ...reportWithoutDigest, reportPayloadSha256: digest(reportWithoutDigest) };
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (cli.outPath) writeFileSync(resolve(cli.outPath), json);
    process.stdout.write(json);
    if (cli.enforce && !gates.passed) process.exitCode = 1;
}

if (import.meta.main) await main();
