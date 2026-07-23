#!/usr/bin/env bun

/**
 * A13 Workstream 2 pathfinding microbenchmark and compatibility oracle.
 *
 * The baseline is intentionally embedded here: `legacyNeighborCells` is the pre-optimization
 * `PathHelper.getNeighborCells` implementation, including its observable cardinal-before-diagonal ordering.
 * `LegacyNeighborPathHelper` routes the otherwise-current `getMovePath` implementation through that frozen
 * neighbor function. The candidate always invokes the production `PathHelper` methods. This keeps the harness
 * useful while neighbor enumeration is optimized without maintaining a frozen copy of the much larger pathfinder.
 * It intentionally does not measure changes elsewhere in getMovePath (for example, queue draining): both full-path
 * arms inherit those current internals, so such changes require a sealed two-source-root benchmark instead.
 *
 * Default evidence run (about 20 seconds per cohort on an idle machine):
 *   bun docs/evidence/tools/a13_path_microbench.ts --out /tmp/a13-path-microbench.json
 *
 * Short wiring/semantic smoke (not statistically authoritative):
 *   bun docs/evidence/tools/a13_path_microbench.ts --smoke --no-enforce
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { GridSettings } from "../../../src/grid/grid_settings";
import { PathHelper } from "../../../src/grid/path_helper";
import type { IMovePath } from "../../../src/grid/path_definitions";
import { ObstacleType } from "../../../src/obstacles/obstacle_type";
import { getDeterministicRandomSource, setDeterministicRandomSource, type RandomSource } from "../../../src/utils/lib";
import type { XY } from "../../../src/utils/math";

const TOOL_PATH = fileURLToPath(import.meta.url);
const COMMON_ROOT = resolve(dirname(TOOL_PATH), "../../..");
const GRID_SIZE = 16;
const DEFAULT_SEED = 0xa13_2026;
const UINT32_SCALE = 0x1_0000_0000;
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

type Variant = "baseline" | "candidate";
type CohortName = "direct-neighbor" | "representative-full-path";

interface ICliOptions {
    blocks: number;
    targetMs: number;
    warmupMs: number;
    bootstrapSamples: number;
    seed: number;
    smoke: boolean;
    enforce: boolean;
    outPath?: string;
}

interface INeighborWorkload {
    id: string;
    currentCell: Readonly<XY>;
    visited: ReadonlySet<number>;
    isSmallUnit: boolean;
    getDiag: boolean;
    includeLeftRightEdges: boolean;
}

interface IPathWorkload {
    id: string;
    currentCell: Readonly<XY>;
    matrix: ReadonlyArray<ReadonlyArray<number>>;
    maxSteps: number;
    aggrBoard?: ReadonlyArray<ReadonlyArray<number>>;
    canFly: boolean;
    isSmallUnit: boolean;
    isMadeOfFire: boolean;
    randomSeed: number;
}

interface IArmSample {
    block: number;
    order: "AB" | "BA";
    durationNs: number;
    nanosecondsPerCall: number;
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

interface IBootstrapSummary {
    method: string;
    samples: number;
    seed: number;
    medianRatio: IInterval;
    medianReduction: IInterval;
    p95Ratio: IInterval;
    p99Ratio: IInterval;
}

interface ICohortResult {
    name: CohortName;
    workloadCount: number;
    calibration: {
        targetMsPerArm: number;
        iterationsPerArm: number;
        callsPerArm: number;
        pilotBaselineMs: number;
        pilotCandidateMs: number;
        estimatedBaselineMsPerArm: number;
        estimatedCandidateMsPerArm: number;
    };
    executionOrders: Array<"AB" | "BA">;
    baseline: ReturnType<typeof summarizeSamples>;
    candidate: ReturnType<typeof summarizeSamples>;
    pointEstimate: {
        medianRatio: number;
        medianReduction: number;
        p95Ratio: number;
        p99Ratio: number;
    };
    bootstrap: IBootstrapSummary;
    checksums: {
        allPairsEqual: boolean;
        baseline: number[];
        candidate: number[];
        pairedSha256: string;
    };
}

/** Literal compatibility baseline. Do not refactor this function along with production code. */
function legacyNeighborCells(
    gridSize: number,
    currentCell: XY,
    visited: ReadonlySet<number> = new Set(),
    isSmallUnit = true,
    getDiag = true,
    includeLeftRightEdges = false,
): XY[] {
    const neighborsLine = [];
    const neighborsDiag = [];
    const diff = includeLeftRightEdges ? 2 : 0;
    const canGoLeft = currentCell.x > (isSmallUnit ? 0 : 1) - diff;
    const canGoRight = currentCell.x < gridSize - 1 + diff;
    let canGoDown;
    if (currentCell.x < 0) {
        canGoDown = currentCell.y > 2;
    } else if (isSmallUnit) {
        canGoDown = currentCell.y > 0;
    } else {
        canGoDown = currentCell.y > 1;
    }
    const canGoUp = currentCell.y < gridSize - 1;

    if (canGoLeft) {
        const newX = currentCell.x - 1;
        const p1 = (newX << 4) | currentCell.y;
        if (!visited.has(p1)) {
            neighborsLine.push({ x: newX, y: currentCell.y });
        }
        if (canGoDown && getDiag) {
            const newY = currentCell.y - 1;
            const p2 = (newX << 4) | newY;
            if (!visited.has(p2)) {
                neighborsDiag.push({ x: newX, y: newY });
            }
        }
        if (canGoUp && getDiag) {
            const newY = currentCell.y + 1;
            const p3 = (newX << 4) | newY;
            if (!visited.has(p3)) {
                neighborsDiag.push({ x: newX, y: newY });
            }
        }
    }
    if (canGoUp) {
        const newY = currentCell.y + 1;
        const p4 = (currentCell.x << 4) | newY;
        if (!visited.has(p4)) {
            neighborsLine.push({ x: currentCell.x, y: newY });
        }
    }
    if (canGoDown) {
        const newY = currentCell.y - 1;
        const p5 = (currentCell.x << 4) | newY;
        if (!visited.has(p5)) {
            neighborsLine.push({ x: currentCell.x, y: newY });
        }
    }
    if (canGoRight) {
        const newX = currentCell.x + 1;
        const p6 = (newX << 4) | currentCell.y;
        if (!visited.has(p6)) {
            neighborsLine.push({ x: newX, y: currentCell.y });
        }
        if (canGoDown && getDiag) {
            const newY = currentCell.y - 1;
            const p7 = (newX << 4) | newY;
            if (!visited.has(p7)) {
                neighborsDiag.push({ x: newX, y: newY });
            }
        }
        if (canGoUp && getDiag) {
            const newY = currentCell.y + 1;
            const p8 = (newX << 4) | newY;
            if (!visited.has(p8)) {
                neighborsDiag.push({ x: newX, y: newY });
            }
        }
    }

    return [...neighborsLine, ...neighborsDiag];
}

class LegacyNeighborPathHelper extends PathHelper {
    public override getNeighborCells(
        currentCell: XY,
        visited: Set<number> = new Set(),
        isSmallUnit = true,
        getDiag = true,
        includeLeftRightEdges = false,
    ): XY[] {
        return legacyNeighborCells(GRID_SIZE, currentCell, visited, isSmallUnit, getDiag, includeLeftRightEdges);
    }
}

function parseCli(argv: string[]): ICliOptions {
    const valueAfter = (flag: string): string | undefined => {
        const index = argv.indexOf(flag);
        return index < 0 ? undefined : argv[index + 1];
    };
    const smoke = argv.includes("--smoke");
    const integer = (flag: string, fallback: number, minimum: number): number => {
        const raw = valueAfter(flag);
        if (raw === undefined) return fallback;
        const value = Number(raw);
        if (!Number.isSafeInteger(value) || value < minimum) {
            throw new Error(`${flag} must be an integer >= ${minimum}; got ${raw}`);
        }
        return value;
    };
    const finite = (flag: string, fallback: number, minimumExclusive: number): number => {
        const raw = valueAfter(flag);
        if (raw === undefined) return fallback;
        const value = Number(raw);
        if (!Number.isFinite(value) || value <= minimumExclusive) {
            throw new Error(`${flag} must be > ${minimumExclusive}; got ${raw}`);
        }
        return value;
    };
    const blocks = integer("--blocks", smoke ? 5 : 31, 3);
    if (blocks % 2 === 0) throw new Error(`--blocks must be odd so AB/BA differs by only one block; got ${blocks}`);
    const seed = integer("--seed", DEFAULT_SEED, 0);
    if (seed > 0xffffffff) throw new Error(`--seed must be a uint32; got ${seed}`);
    return {
        blocks,
        targetMs: finite("--target-ms", smoke ? 12 : 150, 0),
        warmupMs: finite("--warmup-ms", smoke ? 60 : 750, 0),
        bootstrapSamples: integer("--bootstrap", smoke ? 1_000 : 10_000, 100),
        seed,
        smoke,
        enforce: !argv.includes("--no-enforce"),
        outPath: valueAfter("--out"),
    };
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

function sha256(value: string | Uint8Array): string {
    return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value: unknown): unknown {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
        if (Number.isNaN(value)) return "__NaN__";
        if (value === Number.POSITIVE_INFINITY) return "__Infinity__";
        if (value === Number.NEGATIVE_INFINITY) return "__-Infinity__";
        return Object.is(value, -0) ? 0 : value;
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

function canonicalJson(value: unknown): string {
    return JSON.stringify(canonicalize(value));
}

function digest(value: unknown): string {
    return sha256(canonicalJson(value));
}

function makeGridSettings(): GridSettings {
    return new GridSettings(GRID_SIZE, 2048, 0, 1024, -1024, 5, 0.06);
}

function neighborWorkloads(seed: number): readonly INeighborWorkload[] {
    const random = mulberry32(seed ^ 0x4e45_4947);
    const workloads: INeighborWorkload[] = [];
    const configurations = [
        { isSmallUnit: true, getDiag: true, includeLeftRightEdges: false },
        { isSmallUnit: true, getDiag: false, includeLeftRightEdges: false },
        { isSmallUnit: false, getDiag: true, includeLeftRightEdges: false },
        { isSmallUnit: false, getDiag: false, includeLeftRightEdges: false },
        { isSmallUnit: true, getDiag: true, includeLeftRightEdges: true },
        { isSmallUnit: false, getDiag: true, includeLeftRightEdges: true },
    ] as const;

    for (let ordinal = 0; ordinal < 1_536; ordinal++) {
        const configuration = configurations[ordinal % configurations.length];
        const edgeCase = ordinal % 5 === 0;
        const minX = configuration.includeLeftRightEdges ? -2 : configuration.isSmallUnit ? 0 : 1;
        const maxX = configuration.includeLeftRightEdges ? GRID_SIZE + 1 : GRID_SIZE - 1;
        const x = edgeCase
            ? [minX, maxX, 0, GRID_SIZE - 1][ordinal % 4]
            : minX + Math.floor(random() * (maxX - minX + 1));
        const yFloor = configuration.isSmallUnit ? 0 : 1;
        const y = edgeCase
            ? [yFloor, GRID_SIZE - 1, Math.min(2, GRID_SIZE - 1)][ordinal % 3]
            : yFloor + Math.floor(random() * (GRID_SIZE - yFloor));
        const visited = new Set<number>();
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if ((dx !== 0 || dy !== 0) && random() < 0.28) visited.add(((x + dx) << 4) | (y + dy));
            }
        }
        const currentCell = Object.freeze({ x, y });
        workloads.push(
            Object.freeze({
                id: `neighbor-${ordinal.toString().padStart(4, "0")}`,
                currentCell,
                visited,
                ...configuration,
            }),
        );
    }
    return Object.freeze(workloads);
}

function pathWorkloads(seed: number): readonly IPathWorkload[] {
    const random = mulberry32(seed ^ 0x5041_5448);
    const workloads: IPathWorkload[] = [];
    const stepBudgets = [2, 3.3, 4.2, 6.3] as const;
    const obstacleValues = [1, 2, ObstacleType.BLOCK, ObstacleType.HOLE, ObstacleType.LAVA, ObstacleType.WATER];

    for (let ordinal = 0; ordinal < 72; ordinal++) {
        const isSmallUnit = ordinal % 4 !== 3;
        const canFly = ordinal % 6 === 1 || ordinal % 6 === 4;
        const isMadeOfFire = ordinal % 8 === 2 || ordinal % 8 === 5;
        const usesAggro = ordinal % 3 !== 0;
        const xFloor = isSmallUnit ? 0 : 1;
        const yFloor = isSmallUnit ? 0 : 1;
        const currentCell = {
            x: xFloor + Math.floor(random() * (GRID_SIZE - xFloor)),
            y: yFloor + Math.floor(random() * (GRID_SIZE - yFloor)),
        };
        const density = [0, 0.07, 0.12, 0.18][ordinal % 4];
        const matrix = Array.from({ length: GRID_SIZE }, () => Array<number>(GRID_SIZE).fill(0));
        const aggrBoard = usesAggro
            ? Array.from({ length: GRID_SIZE }, () => Array<number>(GRID_SIZE).fill(1))
            : undefined;

        for (let x = 0; x < GRID_SIZE; x++) {
            for (let y = 0; y < GRID_SIZE; y++) {
                if (random() < density) {
                    // Movement matrices are addressed as matrix[y][x]. Aggro boards below intentionally keep the
                    // engine's historical aggrBoard[x][y] layout.
                    matrix[y][x] = obstacleValues[Math.floor(random() * obstacleValues.length)];
                }
                if (aggrBoard && random() < 0.16) aggrBoard[x][y] = 2 + Math.floor(random() * 3);
            }
        }

        const clear = (x: number, y: number): void => {
            if (x >= 0 && x < GRID_SIZE && y >= 0 && y < GRID_SIZE) {
                matrix[y][x] = 0;
                if (aggrBoard) aggrBoard[x][y] = 1;
            }
        };
        clear(currentCell.x, currentCell.y);
        if (!isSmallUnit) {
            clear(currentCell.x - 1, currentCell.y);
            clear(currentCell.x, currentCell.y - 1);
            clear(currentCell.x - 1, currentCell.y - 1);
        }

        // Keep the numeric rows as normal dense arrays, matching live Grid matrices. Workload hashes before/after the
        // benchmark detect mutation without changing JSC's array representation by freezing the hot numeric rows.
        Object.freeze(currentCell);
        workloads.push(
            Object.freeze({
                id: `path-${ordinal.toString().padStart(3, "0")}`,
                currentCell,
                matrix,
                maxSteps: stepBudgets[ordinal % stepBudgets.length],
                aggrBoard,
                canFly,
                isSmallUnit,
                isMadeOfFire,
                randomSeed: (seed + Math.imul(ordinal + 1, 0x9e37_79b1)) >>> 0,
            }),
        );
    }
    return Object.freeze(workloads);
}

function mutableSet(value: ReadonlySet<number>): Set<number> {
    return value as Set<number>;
}

function mutableMatrix(value: ReadonlyArray<ReadonlyArray<number>>): number[][] {
    return value as number[][];
}

function shapeMovePath(movePath: IMovePath): unknown {
    return {
        cells: movePath.cells,
        hashes: [...movePath.hashes],
        knownPaths: [...movePath.knownPaths].map(([key, routes]) => [
            key,
            routes.map((route) => ({
                cell: route.cell,
                route: route.route,
                weight: route.weight,
                firstAggrMet: route.firstAggrMet,
                hasLavaCell: route.hasLavaCell,
                hasWaterCell: route.hasWaterCell,
            })),
        ]),
    };
}

function withRandomSource<T>(source: RandomSource, work: () => T): T {
    const previous = getDeterministicRandomSource();
    setDeterministicRandomSource(source);
    try {
        return work();
    } finally {
        setDeterministicRandomSource(previous);
    }
}

function getMovePath(helper: PathHelper, workload: IPathWorkload): IMovePath {
    return helper.getMovePath(
        workload.currentCell,
        mutableMatrix(workload.matrix),
        workload.maxSteps,
        workload.aggrBoard ? mutableMatrix(workload.aggrBoard) : undefined,
        workload.canFly,
        workload.isSmallUnit,
        workload.isMadeOfFire,
    );
}

function verifySemantics(
    production: PathHelper,
    legacy: LegacyNeighborPathHelper,
    neighbors: readonly INeighborWorkload[],
    paths: readonly IPathWorkload[],
): Record<string, unknown> {
    const neighborBaselineHash = createHash("sha256");
    const neighborCandidateHash = createHash("sha256");
    for (const workload of neighbors) {
        const baseline = legacyNeighborCells(
            GRID_SIZE,
            workload.currentCell,
            workload.visited,
            workload.isSmallUnit,
            workload.getDiag,
            workload.includeLeftRightEdges,
        );
        const candidate = production.getNeighborCells(
            workload.currentCell,
            mutableSet(workload.visited),
            workload.isSmallUnit,
            workload.getDiag,
            workload.includeLeftRightEdges,
        );
        const baselineJson = canonicalJson(baseline);
        const candidateJson = canonicalJson(candidate);
        if (baselineJson !== candidateJson) {
            throw new Error(
                `direct-neighbor semantic mismatch at ${workload.id}: baseline=${baselineJson} candidate=${candidateJson}`,
            );
        }
        neighborBaselineHash.update(`${workload.id}\0${baselineJson}\n`);
        neighborCandidateHash.update(`${workload.id}\0${candidateJson}\n`);
    }

    const pathBaselineHash = createHash("sha256");
    const pathCandidateHash = createHash("sha256");
    for (const workload of paths) {
        const baseline = withRandomSource(mulberry32(workload.randomSeed), () => getMovePath(legacy, workload));
        const candidate = withRandomSource(mulberry32(workload.randomSeed), () => getMovePath(production, workload));
        const baselineJson = canonicalJson(shapeMovePath(baseline));
        const candidateJson = canonicalJson(shapeMovePath(candidate));
        if (baselineJson !== candidateJson) {
            throw new Error(
                `full-path semantic mismatch at ${workload.id}: baseline=${sha256(baselineJson)} candidate=${sha256(candidateJson)}`,
            );
        }
        pathBaselineHash.update(`${workload.id}\0${baselineJson}\n`);
        pathCandidateHash.update(`${workload.id}\0${candidateJson}\n`);
    }

    const neighborBaselineSha256 = neighborBaselineHash.digest("hex");
    const neighborCandidateSha256 = neighborCandidateHash.digest("hex");
    const pathBaselineSha256 = pathBaselineHash.digest("hex");
    const pathCandidateSha256 = pathCandidateHash.digest("hex");
    return {
        passed: neighborBaselineSha256 === neighborCandidateSha256 && pathBaselineSha256 === pathCandidateSha256,
        directNeighbor: {
            cases: neighbors.length,
            baselineSha256: neighborBaselineSha256,
            candidateSha256: neighborCandidateSha256,
            identical: neighborBaselineSha256 === neighborCandidateSha256,
        },
        representativeFullPath: {
            cases: paths.length,
            baselineSha256: pathBaselineSha256,
            candidateSha256: pathCandidateSha256,
            identical: pathBaselineSha256 === pathCandidateSha256,
        },
    };
}

function foldCell(checksum: number, cell: XY): number {
    checksum ^= ((cell.x & 0xffff) << 16) ^ (cell.y & 0xffff);
    return Math.imul(checksum, FNV_PRIME) >>> 0;
}

function foldMovePath(checksum: number, movePath: IMovePath): number {
    checksum = Math.imul(checksum ^ movePath.cells.length, FNV_PRIME) >>> 0;
    checksum = Math.imul(checksum ^ movePath.hashes.size, FNV_PRIME) >>> 0;
    checksum = Math.imul(checksum ^ movePath.knownPaths.size, FNV_PRIME) >>> 0;
    if (movePath.cells.length) {
        checksum = foldCell(checksum, movePath.cells[0]);
        checksum = foldCell(checksum, movePath.cells[movePath.cells.length - 1]);
    }
    for (const [key, routes] of movePath.knownPaths) {
        checksum = Math.imul(checksum ^ key, FNV_PRIME) >>> 0;
        checksum = Math.imul(checksum ^ routes.length, FNV_PRIME) >>> 0;
    }
    return checksum;
}

function neighborRunner(
    variant: Variant,
    production: PathHelper,
    workloads: readonly INeighborWorkload[],
): () => number {
    return (): number => {
        let checksum = FNV_OFFSET;
        for (const workload of workloads) {
            const cells =
                variant === "baseline"
                    ? legacyNeighborCells(
                          GRID_SIZE,
                          workload.currentCell,
                          workload.visited,
                          workload.isSmallUnit,
                          workload.getDiag,
                          workload.includeLeftRightEdges,
                      )
                    : production.getNeighborCells(
                          workload.currentCell,
                          mutableSet(workload.visited),
                          workload.isSmallUnit,
                          workload.getDiag,
                          workload.includeLeftRightEdges,
                      );
            checksum = Math.imul(checksum ^ cells.length, FNV_PRIME) >>> 0;
            for (const cell of cells) checksum = foldCell(checksum, cell);
        }
        return checksum;
    };
}

function pathRunner(helper: PathHelper, workloads: readonly IPathWorkload[], seed: number): () => number {
    return (): number =>
        withRandomSource(mulberry32(seed), () => {
            let checksum = FNV_OFFSET;
            for (const workload of workloads) checksum = foldMovePath(checksum, getMovePath(helper, workload));
            return checksum;
        });
}

function nowNs(): bigint {
    return process.hrtime.bigint();
}

function measure(run: () => number, iterations: number): { durationNs: number; checksum: number } {
    let checksum = FNV_OFFSET;
    const started = nowNs();
    for (let iteration = 0; iteration < iterations; iteration++) {
        checksum = Math.imul(checksum ^ run(), FNV_PRIME) >>> 0;
    }
    const durationNs = Number(nowNs() - started);
    return { durationNs, checksum };
}

function warmUp(baseline: () => number, candidate: () => number, warmupMs: number): number {
    const deadline = nowNs() + BigInt(Math.ceil(warmupMs * 1_000_000));
    let passes = 0;
    while (nowNs() < deadline) {
        if (passes % 2 === 0) {
            baseline();
            candidate();
        } else {
            candidate();
            baseline();
        }
        passes++;
    }
    return passes;
}

function calibrate(
    baseline: () => number,
    candidate: () => number,
    targetMs: number,
): {
    iterations: number;
    pilotBaselineMs: number;
    pilotCandidateMs: number;
    estimatedBaselineMs: number;
    estimatedCandidateMs: number;
} {
    let pilotIterations = 1;
    let baselinePilot = measure(baseline, pilotIterations);
    let candidatePilot = measure(candidate, pilotIterations);
    while (Math.min(baselinePilot.durationNs, candidatePilot.durationNs) < 2_000_000 && pilotIterations < 1 << 20) {
        pilotIterations *= 2;
        baselinePilot = measure(baseline, pilotIterations);
        candidatePilot = measure(candidate, pilotIterations);
    }
    const meanNsPerIteration =
        (baselinePilot.durationNs + candidatePilot.durationNs) / (2 * Math.max(1, pilotIterations));
    const iterations = Math.max(1, Math.round((targetMs * 1_000_000) / Math.max(1, meanNsPerIteration)));
    return {
        iterations,
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
    workloadsPerIteration: number;
}): IPairedSamples {
    const baseline: IArmSample[] = [];
    const candidate: IArmSample[] = [];
    const callsPerArm = options.iterations * options.workloadsPerIteration;
    const capture = (variant: Variant, block: number, order: "AB" | "BA"): void => {
        const result = measure(variant === "baseline" ? options.baseline : options.candidate, options.iterations);
        const sample = {
            block,
            order,
            durationNs: result.durationNs,
            nanosecondsPerCall: result.durationNs / callsPerArm,
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

function summarizeSamples(samples: readonly IArmSample[]): {
    blocks: number;
    unit: string;
    median: number;
    p95: number;
    p99: number;
    minimum: number;
    maximum: number;
} {
    const values = samples.map((sample) => sample.nanosecondsPerCall);
    return {
        blocks: values.length,
        unit: "nanoseconds/call",
        median: quantile(values, 0.5),
        p95: quantile(values, 0.95),
        p99: quantile(values, 0.99),
        minimum: Math.min(...values),
        maximum: Math.max(...values),
    };
}

function interval(values: readonly number[]): IInterval {
    return {
        lower95: quantile(values, 0.025),
        median: quantile(values, 0.5),
        upper95: quantile(values, 0.975),
    };
}

function pairedBootstrap(paired: IPairedSamples, samples: number, seed: number): IBootstrapSummary {
    const random = mulberry32(seed);
    const baseline = paired.baseline.map((sample) => sample.nanosecondsPerCall);
    const candidate = paired.candidate.map((sample) => sample.nanosecondsPerCall);
    if (baseline.length !== candidate.length) throw new Error("paired benchmark arms have different block counts");
    const medianRatios: number[] = [];
    const medianReductions: number[] = [];
    const p95Ratios: number[] = [];
    const p99Ratios: number[] = [];
    for (let sample = 0; sample < samples; sample++) {
        const baselineResample: number[] = [];
        const candidateResample: number[] = [];
        for (let pair = 0; pair < baseline.length; pair++) {
            const index = Math.floor(random() * baseline.length);
            baselineResample.push(baseline[index]);
            candidateResample.push(candidate[index]);
        }
        const medianRatio = quantile(candidateResample, 0.5) / quantile(baselineResample, 0.5);
        medianRatios.push(medianRatio);
        medianReductions.push(1 - medianRatio);
        p95Ratios.push(quantile(candidateResample, 0.95) / quantile(baselineResample, 0.95));
        p99Ratios.push(quantile(candidateResample, 0.99) / quantile(baselineResample, 0.99));
    }
    return {
        method: "paired nonparametric block bootstrap (whole AB/BA pairs resampled with replacement)",
        samples,
        seed,
        medianRatio: interval(medianRatios),
        medianReduction: interval(medianReductions),
        p95Ratio: interval(p95Ratios),
        p99Ratio: interval(p99Ratios),
    };
}

function cohortResult(
    name: CohortName,
    workloadCount: number,
    targetMs: number,
    calibration: ReturnType<typeof calibrate>,
    paired: IPairedSamples,
    bootstrapSamples: number,
    bootstrapSeed: number,
): ICohortResult {
    const baseline = summarizeSamples(paired.baseline);
    const candidate = summarizeSamples(paired.candidate);
    const checksumsBaseline = paired.baseline.map((sample) => sample.checksum);
    const checksumsCandidate = paired.candidate.map((sample) => sample.checksum);
    return {
        name,
        workloadCount,
        calibration: {
            targetMsPerArm: targetMs,
            iterationsPerArm: paired.iterationsPerArm,
            callsPerArm: paired.callsPerArm,
            pilotBaselineMs: calibration.pilotBaselineMs,
            pilotCandidateMs: calibration.pilotCandidateMs,
            estimatedBaselineMsPerArm: calibration.estimatedBaselineMs,
            estimatedCandidateMsPerArm: calibration.estimatedCandidateMs,
        },
        executionOrders: paired.baseline.map((sample) => sample.order),
        baseline,
        candidate,
        pointEstimate: {
            medianRatio: candidate.median / baseline.median,
            medianReduction: 1 - candidate.median / baseline.median,
            p95Ratio: candidate.p95 / baseline.p95,
            p99Ratio: candidate.p99 / baseline.p99,
        },
        bootstrap: pairedBootstrap(paired, bootstrapSamples, bootstrapSeed),
        checksums: {
            allPairsEqual: checksumsBaseline.every((checksum, index) => checksum === checksumsCandidate[index]),
            baseline: checksumsBaseline,
            candidate: checksumsCandidate,
            pairedSha256: digest({ baseline: checksumsBaseline, candidate: checksumsCandidate }),
        },
    };
}

function runCohort(options: {
    name: CohortName;
    workloadCount: number;
    baseline: () => number;
    candidate: () => number;
    cli: ICliOptions;
    bootstrapSeed: number;
}): { result: ICohortResult; warmupPasses: number } {
    const warmupPasses = warmUp(options.baseline, options.candidate, options.cli.warmupMs);
    const calibration = calibrate(options.baseline, options.candidate, options.cli.targetMs);
    const paired = runPairedBlocks({
        baseline: options.baseline,
        candidate: options.candidate,
        blocks: options.cli.blocks,
        iterations: calibration.iterations,
        workloadsPerIteration: options.workloadCount,
    });
    return {
        result: cohortResult(
            options.name,
            options.workloadCount,
            options.cli.targetMs,
            calibration,
            paired,
            options.cli.bootstrapSamples,
            options.bootstrapSeed,
        ),
        warmupPasses,
    };
}

function selectedSourceSeal(): Record<string, unknown> {
    const selected = [
        "src/grid/path_helper.ts",
        "src/grid/grid_settings.ts",
        "src/grid/grid_math.ts",
        "src/grid/path_definitions.ts",
        "src/obstacles/obstacle_type.ts",
        "src/utils/lib.ts",
        "src/utils/math.ts",
    ];
    const files = selected.map((path) => {
        const bytes = readFileSync(join(COMMON_ROOT, path));
        return { path, bytes: bytes.byteLength, sha256: sha256(bytes) };
    });
    const srcRoot = join(COMMON_ROOT, "src");
    const manifest: Array<{ path: string; bytes: number; sha256: string }> = [];
    const visit = (directory: string): void => {
        for (const name of readdirSync(directory).sort()) {
            const path = join(directory, name);
            const stat = statSync(path);
            if (stat.isDirectory()) visit(path);
            else if (stat.isFile()) {
                const bytes = readFileSync(path);
                manifest.push({ path: relative(srcRoot, path), bytes: bytes.byteLength, sha256: sha256(bytes) });
            }
        }
    };
    visit(srcRoot);
    return {
        commonRoot: COMMON_ROOT,
        gitHead: gitOutput(["rev-parse", "HEAD"]),
        selectedFiles: files,
        selectedFilesSha256: digest(files),
        srcTreeFiles: manifest.length,
        srcTreeBytes: manifest.reduce((sum, file) => sum + file.bytes, 0),
        srcTreeManifestSha256: digest(manifest),
        runner: {
            path: relative(COMMON_ROOT, TOOL_PATH),
            bytes: readFileSync(TOOL_PATH).byteLength,
            sha256: sha256(readFileSync(TOOL_PATH)),
        },
        embeddedLegacyFunctionSha256: sha256(legacyNeighborCells.toString()),
        runtimeProductionNeighborFunctionSha256: sha256(PathHelper.prototype.getNeighborCells.toString()),
    };
}

function gitOutput(args: string[]): string | null {
    try {
        return execFileSync("git", args, {
            cwd: COMMON_ROOT,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
    } catch {
        return null;
    }
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
        processId: process.pid,
        command: process.argv,
    };
}

function gateResult(neighbor: ICohortResult, fullPath: ICohortResult, semanticPass: boolean): Record<string, unknown> {
    const checks = [
        {
            id: "semantic-equivalence",
            threshold: "all direct-neighbor and representative full-path outputs are byte-identical canonically",
            observed: semanticPass,
            passed: semanticPass,
        },
        {
            id: "paired-checksums",
            threshold: "every timed baseline/candidate checksum pair is equal",
            observed: neighbor.checksums.allPairsEqual && fullPath.checksums.allPairsEqual,
            passed: neighbor.checksums.allPairsEqual && fullPath.checksums.allPairsEqual,
        },
        {
            id: "neighbor-median-reduction",
            threshold: ">= 0.15",
            observed: neighbor.pointEstimate.medianReduction,
            passed: neighbor.pointEstimate.medianReduction >= 0.15,
        },
        {
            id: "full-path-median-reduction",
            threshold: ">= 0.03",
            observed: fullPath.pointEstimate.medianReduction,
            passed: fullPath.pointEstimate.medianReduction >= 0.03,
        },
        {
            id: "full-path-median-ratio-upper95",
            threshold: "< 1.00",
            observed: fullPath.bootstrap.medianRatio.upper95,
            passed: fullPath.bootstrap.medianRatio.upper95 < 1,
        },
        {
            id: "full-path-p95-ratio-upper95",
            threshold: "<= 1.05",
            observed: fullPath.bootstrap.p95Ratio.upper95,
            passed: fullPath.bootstrap.p95Ratio.upper95 <= 1.05,
        },
        {
            id: "full-path-p99-ratio-upper95",
            threshold: "<= 1.05",
            observed: fullPath.bootstrap.p99Ratio.upper95,
            passed: fullPath.bootstrap.p99Ratio.upper95 <= 1.05,
        },
    ];
    return { passed: checks.every((check) => check.passed), checks };
}

function main(): void {
    const cli = parseCli(process.argv.slice(2));
    const sourceBefore = selectedSourceSeal();
    const settings = makeGridSettings();
    const production = new PathHelper(settings);
    const legacy = new LegacyNeighborPathHelper(settings);
    const neighbors = neighborWorkloads(cli.seed);
    const paths = pathWorkloads(cli.seed);
    const workloadBefore = {
        directNeighborSha256: digest(neighbors),
        representativeFullPathSha256: digest(paths),
    };
    const semantics = verifySemantics(production, legacy, neighbors, paths);

    const neighbor = runCohort({
        name: "direct-neighbor",
        workloadCount: neighbors.length,
        baseline: neighborRunner("baseline", production, neighbors),
        candidate: neighborRunner("candidate", production, neighbors),
        cli,
        bootstrapSeed: cli.seed ^ 0x4e42_5354,
    });
    const pathSeed = cli.seed ^ 0x5255_4e53;
    const fullPath = runCohort({
        name: "representative-full-path",
        workloadCount: paths.length,
        baseline: pathRunner(legacy, paths, pathSeed),
        candidate: pathRunner(production, paths, pathSeed),
        cli,
        bootstrapSeed: cli.seed ^ 0x5042_5354,
    });

    const workloadAfter = {
        directNeighborSha256: digest(neighbors),
        representativeFullPathSha256: digest(paths),
    };
    const sourceAfter = selectedSourceSeal();
    const integrity = {
        workloadBefore,
        workloadAfter,
        workloadsUnchanged: canonicalJson(workloadBefore) === canonicalJson(workloadAfter),
        sourceBefore,
        sourceAfter,
        sourcesUnchanged: canonicalJson(sourceBefore) === canonicalJson(sourceAfter),
    };
    const semanticPass =
        semantics.passed === true && integrity.workloadsUnchanged === true && integrity.sourcesUnchanged === true;
    const gates = gateResult(neighbor.result, fullPath.result, semanticPass);
    const reportWithoutDigest = {
        schema: "heroes-of-crypto/a13-path-microbench/v1",
        generatedAt: new Date().toISOString(),
        mode: cli.smoke ? "smoke-not-authoritative" : "evidence",
        labels: {
            baseline: "frozen legacy getNeighborCells; current getMovePath routed through frozen neighbor override",
            candidate: "production PathHelper.getNeighborCells and PathHelper.getMovePath",
        },
        configuration: {
            blocks: cli.blocks,
            pairing: "alternating AB/BA; one odd extra AB block",
            targetMsPerArm: cli.targetMs,
            warmupMsPerCohort: cli.warmupMs,
            bootstrapSamples: cli.bootstrapSamples,
            seed: cli.seed,
            enforce: cli.enforce,
            pregeneratedWorkloads: true,
            workloadMutationGuard: "canonical SHA-256 before/after; hot numeric rows retain production array shape",
        },
        methodology: {
            timingClock: "process.hrtime.bigint",
            calibration: "one shared iteration count per cohort, estimated from warmed baseline/candidate pilots",
            sampleUnit: "elapsed nanoseconds divided by exact workload calls in one arm block",
            semanticComparison:
                "ordered cells, ordered hashes, ordered knownPaths, every route/cell/weight/flag; RNG reset per path case",
            bootstrap:
                "paired whole-block resampling; median, p95, and p99 candidate/baseline ratios; deterministic 10k default",
            caution:
                "this isolates neighbor enumeration only; smoke proves wiring/semantics only; authoritative gates require defaults on an idle machine; p95/p99 here describe block-average throughput, not individual-call latency",
        },
        environment: environmentSeal(),
        integrity,
        semantics,
        warmup: {
            directNeighborPasses: neighbor.warmupPasses,
            representativeFullPathPasses: fullPath.warmupPasses,
        },
        cohorts: {
            directNeighbor: neighbor.result,
            representativeFullPath: fullPath.result,
        },
        gates,
    };
    const report = {
        ...reportWithoutDigest,
        reportPayloadSha256: digest(reportWithoutDigest),
    };
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (cli.outPath) writeFileSync(resolve(cli.outPath), json);
    process.stdout.write(json);
    if (cli.enforce && gates.passed !== true) process.exitCode = 1;
}

if (import.meta.main) main();
