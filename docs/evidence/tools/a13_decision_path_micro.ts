#!/usr/bin/env bun

/**
 * A13 Workstream 4 decision-path catalog microbenchmark.
 *
 * This runner measures the final, separate read-only DecisionPathCatalog API with four arms:
 *
 *   1. pass-through — PathHelper performs every request, with no catalog bookkeeping;
 *   2. bookkeeping-control — a fresh catalog performs the production key checks, but the final
 *      `isMadeOfFire` flag deliberately differs on canonical requests so every request delegates;
 *   3. ideal-reuse — PathHelper performs only the computations needed by the cached arm, while a local
 *      variable supplies repeated logical results without any catalog work;
 *   4. cached — the production catalog performs one canonical miss and reuses later canonical requests.
 *
 * The deterministic workload matches the observed searched-decision request mix: 0.57 long-budget bypasses and
 * 2.89 canonical requests per decision. All matrices exclude lava, so toggling only `isMadeOfFire` in the control
 * arm is a last-field cache-key mismatch without changing PathHelper's returned value.
 *
 * Evidence run:
 *   bun docs/evidence/tools/a13_decision_path_micro.ts \
 *     --out /tmp/a13-decision-path-micro.json
 *
 * Short wiring/performance smoke:
 *   bun docs/evidence/tools/a13_decision_path_micro.ts \
 *     --smoke --out /tmp/a13-decision-path-micro-smoke.json
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
    createDecisionPathCatalog,
    type IDecisionPathCatalogStats,
    type IReadonlyMovePath,
} from "../../../src/ai/decision_path_catalog";
import { PBTypes } from "../../../src/generated/protobuf/v1/types";
import { Grid } from "../../../src/grid/grid";
import { GridSettings } from "../../../src/grid/grid_settings";
import { PathHelper } from "../../../src/grid/path_helper";
import type { Unit } from "../../../src/units/unit";
import {
    getDeterministicRandomSource,
    getRandomInt,
    setDeterministicRandomSource,
    type RandomSource,
} from "../../../src/utils/lib";
import type { XY } from "../../../src/utils/math";

const SCHEMA = "heroes-of-crypto/a13-decision-path-micro/v2" as const;
const RUNNER_PATH = fileURLToPath(import.meta.url);
const GRID_SIZE = 16;
const DEFAULT_BLOCKS = 60;
const DEFAULT_TARGET_MS = 100;
const DEFAULT_WARMUP_MS = 750;
const DEFAULT_EXACT_CYCLES = 100;
const DEFAULT_BOOTSTRAP_SAMPLES = 20_000;
const DEFAULT_BOOTSTRAP_SEED = 0xa13d_da7a;
const SMOKE_BLOCKS = 20;
const SMOKE_TARGET_MS = 30;
const SMOKE_WARMUP_MS = 150;
const SMOKE_EXACT_CYCLES = 20;
const SMOKE_BOOTSTRAP_SAMPLES = 2_000;
const MAX_CYCLES_PER_BLOCK = 100_000;
const STRICT_OVERHEAD_TO_SAVED_GATE = 0.1;
const FNV_OFFSET = 0x811c_9dc5;
const FNV_PRIME = 0x0100_0193;
const LONG_BYPASS_PERCENT = 57;
const THIRD_CANONICAL_PERCENT = 89;

type ArmName = "passThrough" | "bookkeepingControl" | "idealReuse" | "cachedCatalog";
type MovePathArgs = [
    currentCell: XY,
    matrix: number[][],
    maxSteps: number,
    aggrBoard: number[][],
    canFly: boolean,
    isSmallUnit: boolean,
    isMadeOfFire: boolean,
];

interface ICliOptions {
    blocks: number;
    targetMs: number;
    warmupMs: number;
    exactCycles: number;
    bootstrapSamples: number;
    bootstrapSeed: number;
    smoke: boolean;
    out?: string;
}

interface IBenchmarkUnit {
    getTeam(): number;
    getBaseCell(): XY;
    getSteps(): number;
    canFly(): boolean;
    isSmallSize(): boolean;
    canTraverseLava(): boolean;
}

interface ICase {
    name: string;
    grid: Grid;
    delegate: PathHelper;
    unit: Unit;
    currentCell: XY;
    matrix: number[][];
    maxSteps: number;
    aggrBoard: number[][];
    canFly: boolean;
    isSmallUnit: boolean;
    isMadeOfFire: boolean;
}

interface IArmMeasurement {
    durationNs: number;
    nanosecondsPerCycle: number;
    checksum: number;
}

interface IRawBlock {
    block: number;
    order: ArmName[];
    passThrough: IArmMeasurement;
    bookkeepingControl: IArmMeasurement;
    idealReuse: IArmMeasurement;
    cachedCatalog: IArmMeasurement;
}

interface IExactArmResult {
    calls: number;
    valueSha256: string;
    pathRngDraws: number;
    rngTail: number[];
    checksum: number;
    stats: IDecisionPathCatalogStats;
    canonicalOwnershipViolations: number;
}

interface IStartCellOwnershipPreflight {
    passed: true;
    requestReferenceEscaped: false;
    shapeStableAfterRequestMutation: true;
    repeatReturnedSameObject: true;
    beforeMutationSha256: string;
    afterMutationSha256: string;
    stats: IDecisionPathCatalogStats;
}

interface IAggregateTiming {
    passThroughNsPerCycle: number;
    bookkeepingControlNsPerCycle: number;
    idealReuseNsPerCycle: number;
    cachedCatalogNsPerCycle: number;
    bookkeepingControlOverheadNsPerCycle: number;
    grossRecomputeSavedNsPerCycle: number;
    catalogOverheadNsPerCycle: number;
    netSavedNsPerCycle: number;
    overheadToSavedRatio: number;
    cachedToIdealRatio: number;
    cachedToPassThroughRatio: number;
    cachedToControlRatio: number;
}

interface IInterval {
    lower95: number;
    median: number;
    upper95: number;
    lower99: number;
    upper99: number;
    acceptedSamples: number;
    rejectedSamples: number;
}

const ARM_NAMES: readonly ArmName[] = ["passThrough", "bookkeepingControl", "idealReuse", "cachedCatalog"];
// Even-order Williams square: every arm occupies every position once and every directed adjacent pair occurs
// exactly once per four-block schedule.
const BALANCED_ARM_ORDERS: readonly (readonly ArmName[])[] = [
    ["passThrough", "bookkeepingControl", "cachedCatalog", "idealReuse"],
    ["bookkeepingControl", "idealReuse", "passThrough", "cachedCatalog"],
    ["idealReuse", "cachedCatalog", "bookkeepingControl", "passThrough"],
    ["cachedCatalog", "passThrough", "idealReuse", "bookkeepingControl"],
];

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error(`${name} must be a positive integer`);
    }
    return parsed;
}

function positiveNumber(value: string | undefined, fallback: number, name: string): number {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${name} must be a positive finite number`);
    }
    return parsed;
}

function uint32(value: string | undefined, fallback: number, name: string): number {
    if (value === undefined) return fallback >>> 0;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0xffff_ffff) {
        throw new Error(`${name} must be an unsigned 32-bit integer`);
    }
    return parsed >>> 0;
}

function commandLine(): ICliOptions {
    const values = parseArgs({
        args: process.argv.slice(2),
        strict: true,
        allowPositionals: false,
        options: {
            blocks: { type: "string" },
            "target-ms": { type: "string" },
            "warmup-ms": { type: "string" },
            "exact-cycles": { type: "string" },
            "bootstrap-samples": { type: "string" },
            "bootstrap-seed": { type: "string" },
            smoke: { type: "boolean", default: false },
            out: { type: "string" },
        },
    }).values;
    const smoke = values.smoke ?? false;
    const blocks = positiveInteger(values.blocks, smoke ? SMOKE_BLOCKS : DEFAULT_BLOCKS, "--blocks");
    if (blocks < BALANCED_ARM_ORDERS.length || blocks % BALANCED_ARM_ORDERS.length !== 0) {
        throw new Error(
            `--blocks must be a positive multiple of ${BALANCED_ARM_ORDERS.length} so every balanced arm order is equally represented`,
        );
    }
    return {
        blocks,
        targetMs: positiveNumber(values["target-ms"], smoke ? SMOKE_TARGET_MS : DEFAULT_TARGET_MS, "--target-ms"),
        warmupMs: positiveNumber(values["warmup-ms"], smoke ? SMOKE_WARMUP_MS : DEFAULT_WARMUP_MS, "--warmup-ms"),
        exactCycles: positiveInteger(
            values["exact-cycles"],
            smoke ? SMOKE_EXACT_CYCLES : DEFAULT_EXACT_CYCLES,
            "--exact-cycles",
        ),
        bootstrapSamples: positiveInteger(
            values["bootstrap-samples"],
            smoke ? SMOKE_BOOTSTRAP_SAMPLES : DEFAULT_BOOTSTRAP_SAMPLES,
            "--bootstrap-samples",
        ),
        bootstrapSeed: uint32(values["bootstrap-seed"], DEFAULT_BOOTSTRAP_SEED, "--bootstrap-seed"),
        smoke,
        out: values.out?.trim() ? resolve(values.out) : undefined,
    };
}

function makeUnit(options: {
    team: number;
    currentCell: XY;
    maxSteps: number;
    canFly: boolean;
    isSmallUnit: boolean;
}): Unit {
    const unit: IBenchmarkUnit = {
        getTeam: () => options.team,
        getBaseCell: () => ({ ...options.currentCell }),
        getSteps: () => options.maxSteps,
        canFly: () => options.canFly,
        isSmallSize: () => options.isSmallUnit,
        canTraverseLava: () => false,
    };
    return unit as unknown as Unit;
}

function makeMatrix(seed: number, currentCell: XY, isSmallUnit: boolean, density: number): number[][] {
    let state = seed >>> 0;
    const matrix = Array.from({ length: GRID_SIZE }, () => Array<number>(GRID_SIZE).fill(0));
    for (let x = 0; x < GRID_SIZE; x++) {
        for (let y = 0; y < GRID_SIZE; y++) {
            state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
            if ((state & 0xff) < density) {
                matrix[x][y] = state & 0x100 ? PBTypes.TeamVals.LOWER : PBTypes.TeamVals.UPPER;
            }
        }
    }
    // Keep the source footprint and its immediate exits legal. Workloads contain occupancy only, never lava.
    for (let x = Math.max(0, currentCell.x - 2); x <= Math.min(GRID_SIZE - 1, currentCell.x + 1); x++) {
        for (let y = Math.max(0, currentCell.y - 2); y <= Math.min(GRID_SIZE - 1, currentCell.y + 1); y++) {
            matrix[x][y] = 0;
        }
    }
    if (!isSmallUnit) {
        matrix[currentCell.x - 1][currentCell.y] = 0;
        matrix[currentCell.x][currentCell.y - 1] = 0;
        matrix[currentCell.x - 1][currentCell.y - 1] = 0;
    }
    return matrix;
}

function makeCase(options: {
    name: string;
    seed: number;
    currentCell: XY;
    maxSteps: number;
    canFly: boolean;
    isSmallUnit: boolean;
    density: number;
    aggressionStride: number;
}): ICase {
    const gridSettings = new GridSettings(GRID_SIZE, 2048, 0, 1024, -1024, 5, 0.06);
    const grid = new Grid(gridSettings, PBTypes.GridVals.NORMAL);
    const team = options.seed & 1 ? PBTypes.TeamVals.LOWER : PBTypes.TeamVals.UPPER;
    const enemyTeam = team === PBTypes.TeamVals.LOWER ? PBTypes.TeamVals.UPPER : PBTypes.TeamVals.LOWER;
    const aggrBoard = grid.getAggrMatrixByTeam(enemyTeam);
    if (!aggrBoard) {
        throw new Error(`${options.name}: production grid did not expose an aggression board`);
    }
    for (let x = 0; x < GRID_SIZE; x++) {
        for (let y = 0; y < GRID_SIZE; y++) {
            if ((x * 17 + y * 31 + options.seed) % options.aggressionStride === 0) {
                aggrBoard[x][y] = 2 + ((x + y) & 1);
            }
        }
    }
    const matrix = makeMatrix(options.seed, options.currentCell, options.isSmallUnit, options.density);
    const unit = makeUnit({
        team,
        currentCell: options.currentCell,
        maxSteps: options.maxSteps,
        canFly: options.canFly,
        isSmallUnit: options.isSmallUnit,
    });
    return {
        name: options.name,
        grid,
        delegate: new PathHelper(gridSettings),
        unit,
        currentCell: { ...options.currentCell },
        matrix,
        maxSteps: options.maxSteps,
        aggrBoard,
        canFly: options.canFly,
        isSmallUnit: options.isSmallUnit,
        isMadeOfFire: false,
    };
}

function makeCases(): readonly ICase[] {
    return [
        makeCase({
            name: "small-open-3.3",
            seed: 0x101,
            currentCell: { x: 8, y: 8 },
            maxSteps: 3.3,
            canFly: false,
            isSmallUnit: true,
            density: 0,
            aggressionStride: 11,
        }),
        makeCase({
            name: "small-mixed-4.2",
            seed: 0x202,
            currentCell: { x: 5, y: 7 },
            maxSteps: 4.2,
            canFly: false,
            isSmallUnit: true,
            density: 34,
            aggressionStride: 7,
        }),
        makeCase({
            name: "large-mixed-6.3",
            seed: 0x303,
            currentCell: { x: 10, y: 10 },
            maxSteps: 6.3,
            canFly: false,
            isSmallUnit: false,
            density: 26,
            aggressionStride: 9,
        }),
        makeCase({
            name: "small-flying-4.2",
            seed: 0x404,
            currentCell: { x: 4, y: 11 },
            maxSteps: 4.2,
            canFly: true,
            isSmallUnit: true,
            density: 52,
            aggressionStride: 5,
        }),
        makeCase({
            name: "small-aggression-6.3",
            seed: 0x505,
            currentCell: { x: 12, y: 4 },
            maxSteps: 6.3,
            canFly: false,
            isSmallUnit: true,
            density: 18,
            aggressionStride: 4,
        }),
    ];
}

function canonicalArgs(pathCase: ICase): MovePathArgs {
    return [
        { ...pathCase.currentCell },
        pathCase.matrix,
        pathCase.maxSteps,
        pathCase.aggrBoard,
        pathCase.canFly,
        pathCase.isSmallUnit,
        pathCase.isMadeOfFire,
    ];
}

function longBypassArgs(pathCase: ICase): MovePathArgs {
    return [
        { ...pathCase.currentCell },
        pathCase.matrix,
        pathCase.maxSteps + 100,
        pathCase.aggrBoard,
        pathCase.canFly,
        pathCase.isSmallUnit,
        pathCase.isMadeOfFire,
    ];
}

function controlArgs(pathCase: ICase): MovePathArgs {
    // This is the final field compared by sameCanonicalInput. There is no lava in any benchmark matrix, so the
    // delegated PathHelper computation and exact returned value remain identical to the canonical request.
    return [
        { ...pathCase.currentCell },
        pathCase.matrix,
        pathCase.maxSteps,
        pathCase.aggrBoard,
        pathCase.canFly,
        pathCase.isSmallUnit,
        !pathCase.isMadeOfFire,
    ];
}

function addStats(target: IDecisionPathCatalogStats, source: IDecisionPathCatalogStats): void {
    target.requests += source.requests;
    target.hits += source.hits;
    target.misses += source.misses;
    target.bypasses += source.bypasses;
}

function fold(checksum: number, value: number): number {
    return Math.imul(checksum ^ (value | 0), FNV_PRIME) >>> 0;
}

function foldMovePath(checksum: number, movePath: IReadonlyMovePath): number {
    checksum = fold(checksum, movePath.cells.length);
    checksum = fold(checksum, movePath.hashes.size);
    checksum = fold(checksum, movePath.knownPaths.size);
    const first = movePath.cells[0];
    const last = movePath.cells[movePath.cells.length - 1];
    if (first) {
        checksum = fold(checksum, first.x);
        checksum = fold(checksum, first.y);
    }
    if (last) {
        checksum = fold(checksum, last.x);
        checksum = fold(checksum, last.y);
    }
    for (const [key, routes] of movePath.knownPaths) {
        checksum = fold(checksum, key);
        checksum = fold(checksum, routes.length);
        const route = routes[0];
        if (route) {
            checksum = fold(checksum, route.route.length);
            checksum = fold(checksum, Math.round(route.weight * 1_000_000));
            checksum = fold(checksum, Number(route.hasLavaCell));
            checksum = fold(checksum, Number(route.hasWaterCell));
        }
    }
    return checksum;
}

function executeCycle(
    arm: ArmName,
    pathCase: ICase,
    cycle: number,
    collectStats: boolean,
    onResult: (result: IReadonlyMovePath) => void,
): { calls: number; stats: IDecisionPathCatalogStats; canonicalResults: IReadonlyMovePath[] } {
    const includeLongBypass = cycle % 100 < LONG_BYPASS_PERCENT;
    const includeThirdCanonical = cycle % 100 < THIRD_CANONICAL_PERCENT;
    // Allocate every argument tuple before selecting an arm so harness allocation is identical in all three
    // measurements. Only catalog construction, key checks, delegation, and reuse differ between the arms.
    const canonical = canonicalArgs(pathCase);
    const longBypass = longBypassArgs(pathCase);
    const control = controlArgs(pathCase);
    const stats: IDecisionPathCatalogStats = { requests: 0, hits: 0, misses: 0, bypasses: 0 };
    const canonicalResults: IReadonlyMovePath[] = [];
    let calls = 0;

    if (arm === "passThrough") {
        if (includeLongBypass) {
            onResult(pathCase.delegate.getMovePath(...longBypass));
            calls++;
        }
        const canonicalCallCount = includeThirdCanonical ? 3 : 2;
        for (let call = 0; call < canonicalCallCount; call++) {
            const result = pathCase.delegate.getMovePath(...canonical);
            canonicalResults.push(result);
            onResult(result);
            calls++;
        }
        return { calls, stats, canonicalResults };
    }

    if (arm === "idealReuse") {
        if (includeLongBypass) {
            onResult(pathCase.delegate.getMovePath(...longBypass));
            calls++;
        }
        const canonicalCallCount = includeThirdCanonical ? 3 : 2;
        const sharedResult = pathCase.delegate.getMovePath(...canonical);
        for (let call = 0; call < canonicalCallCount; call++) {
            canonicalResults.push(sharedResult);
            onResult(sharedResult);
            calls++;
        }
        return { calls, stats, canonicalResults };
    }

    const catalog = createDecisionPathCatalog(
        pathCase.grid,
        pathCase.delegate,
        pathCase.unit,
        pathCase.matrix,
        collectStats,
    );
    if (includeLongBypass) {
        onResult(catalog.getMovePath(...longBypass));
        calls++;
    }
    const canonicalCallCount = includeThirdCanonical ? 3 : 2;
    const args = arm === "bookkeepingControl" ? control : canonical;
    for (let call = 0; call < canonicalCallCount; call++) {
        const result = catalog.getMovePath(...args);
        canonicalResults.push(result);
        onResult(result);
        calls++;
    }
    if (collectStats) addStats(stats, catalog.getStats());
    return { calls, stats, canonicalResults };
}

const floatBuffer = new ArrayBuffer(8);
const floatView = new DataView(floatBuffer);

function float64Bits(value: number): string {
    floatView.setFloat64(0, value, false);
    return `${floatView.getUint32(0, false).toString(16).padStart(8, "0")}${floatView
        .getUint32(4, false)
        .toString(16)
        .padStart(8, "0")}`;
}

function exactMovePathShape(movePath: IReadonlyMovePath): Record<string, unknown> {
    return {
        cells: movePath.cells.map((cell) => ({ x: float64Bits(cell.x), y: float64Bits(cell.y) })),
        hashes: [...movePath.hashes].map(float64Bits),
        knownPaths: [...movePath.knownPaths].map(([key, routes]) => ({
            key: float64Bits(key),
            routes: routes.map((route) => ({
                cell: { x: float64Bits(route.cell.x), y: float64Bits(route.cell.y) },
                route: route.route.map((cell) => ({ x: float64Bits(cell.x), y: float64Bits(cell.y) })),
                weight: float64Bits(route.weight),
                firstAggrMet: route.firstAggrMet,
                hasLavaCell: route.hasLavaCell,
                hasWaterCell: route.hasWaterCell,
            })),
        })),
    };
}

function movePathContainsReference(movePath: IReadonlyMovePath, target: XY): boolean {
    if (movePath.cells.some((cell) => cell === target)) return true;
    for (const routes of movePath.knownPaths.values()) {
        for (const route of routes) {
            if (route.cell === target || route.route.some((cell) => cell === target)) return true;
        }
    }
    return false;
}

function shapeSha256(movePath: IReadonlyMovePath): string {
    return createHash("sha256")
        .update(JSON.stringify(exactMovePathShape(movePath)))
        .digest("hex");
}

function startCellOwnershipPreflight(pathCase: ICase): IStartCellOwnershipPreflight {
    const requestStart = { ...pathCase.currentCell };
    const request: MovePathArgs = [
        requestStart,
        pathCase.matrix,
        pathCase.maxSteps,
        pathCase.aggrBoard,
        pathCase.canFly,
        pathCase.isSmallUnit,
        pathCase.isMadeOfFire,
    ];
    const catalog = createDecisionPathCatalog(pathCase.grid, pathCase.delegate, pathCase.unit, pathCase.matrix, true);
    const first = catalog.getMovePath(...request);
    const requestReferenceEscaped = movePathContainsReference(first, requestStart);
    const beforeMutationSha256 = shapeSha256(first);

    requestStart.x += GRID_SIZE * 2;
    requestStart.y -= GRID_SIZE * 2;

    const afterMutationSha256 = shapeSha256(first);
    const repeat = catalog.getMovePath(...canonicalArgs(pathCase));
    const repeatReturnedSameObject = repeat === first;
    const stats = catalog.getStats();
    if (
        requestReferenceEscaped ||
        beforeMutationSha256 !== afterMutationSha256 ||
        !repeatReturnedSameObject ||
        shapeSha256(repeat) !== beforeMutationSha256 ||
        stats.requests !== 2 ||
        stats.hits !== 1 ||
        stats.misses !== 1 ||
        stats.bypasses !== 0
    ) {
        throw new Error(
            `catalog start-cell ownership preflight failed: ${JSON.stringify({
                requestReferenceEscaped,
                beforeMutationSha256,
                afterMutationSha256,
                repeatReturnedSameObject,
                repeatSha256: shapeSha256(repeat),
                stats,
            })}`,
        );
    }
    return {
        passed: true,
        requestReferenceEscaped: false,
        shapeStableAfterRequestMutation: true,
        repeatReturnedSameObject: true,
        beforeMutationSha256,
        afterMutationSha256,
        stats,
    };
}

function makeRng(seed: number, onDraw?: () => void): RandomSource {
    let state = seed >>> 0;
    return () => {
        onDraw?.();
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
    };
}

function exactArm(arm: ArmName, cases: readonly ICase[], cycles: number): IExactArmResult {
    const previousSource = getDeterministicRandomSource();
    let rawDraws = 0;
    const source = makeRng(0xa13c_ace, () => rawDraws++);
    setDeterministicRandomSource(source);
    const hash = createHash("sha256");
    const stats: IDecisionPathCatalogStats = { requests: 0, hits: 0, misses: 0, bypasses: 0 };
    let calls = 0;
    let checksum = FNV_OFFSET;
    let canonicalOwnershipViolations = 0;
    try {
        for (let cycle = 0; cycle < cycles; cycle++) {
            const execution = executeCycle(arm, cases[cycle % cases.length], cycle, true, (result) => {
                hash.update(`${JSON.stringify(exactMovePathShape(result))}\n`);
                checksum = foldMovePath(checksum, result);
            });
            calls += execution.calls;
            addStats(stats, execution.stats);
            for (let index = 1; index < execution.canonicalResults.length; index++) {
                const aliasesFirst = execution.canonicalResults[index] === execution.canonicalResults[0];
                const shouldAlias = arm === "cachedCatalog" || arm === "idealReuse";
                if (shouldAlias ? !aliasesFirst : aliasesFirst) {
                    canonicalOwnershipViolations++;
                }
            }
        }
        const pathRngDraws = rawDraws;
        const rngTail = Array.from({ length: 8 }, () => getRandomInt(0, 1_000_000));
        return {
            calls,
            valueSha256: hash.digest("hex"),
            pathRngDraws,
            rngTail,
            checksum,
            stats,
            canonicalOwnershipViolations,
        };
    } finally {
        setDeterministicRandomSource(previousSource);
    }
}

function assertExactness(exact: Record<ArmName, IExactArmResult>, cycles: number): void {
    const pass = exact.passThrough;
    for (const arm of ARM_NAMES) {
        const result = exact[arm];
        if (
            result.calls !== pass.calls ||
            result.valueSha256 !== pass.valueSha256 ||
            result.checksum !== pass.checksum ||
            result.pathRngDraws !== 0 ||
            result.rngTail.join(",") !== pass.rngTail.join(",") ||
            result.canonicalOwnershipViolations !== 0
        ) {
            throw new Error(`exactness failed for ${arm}: ${JSON.stringify(result)} vs ${JSON.stringify(pass)}`);
        }
    }
    const expectedLongBypasses = Array.from({ length: cycles }, (_, cycle) =>
        cycle % 100 < LONG_BYPASS_PERCENT ? 1 : 0,
    ).reduce<number>((total, value) => total + value, 0);
    const expectedCanonicalCalls = Array.from({ length: cycles }, (_, cycle) =>
        cycle % 100 < THIRD_CANONICAL_PERCENT ? 3 : 2,
    ).reduce<number>((total, value) => total + value, 0);
    const cached = exact.cachedCatalog.stats;
    const control = exact.bookkeepingControl.stats;
    const emptyStatsArms: readonly ArmName[] = ["passThrough", "idealReuse"];
    for (const arm of emptyStatsArms) {
        const stats = exact[arm].stats;
        if (stats.requests !== 0 || stats.hits !== 0 || stats.misses !== 0 || stats.bypasses !== 0) {
            throw new Error(`${arm} unexpectedly recorded catalog counters: ${JSON.stringify(stats)}`);
        }
    }
    if (
        cached.requests !== expectedLongBypasses + expectedCanonicalCalls ||
        cached.misses !== cycles ||
        cached.hits !== expectedCanonicalCalls - cycles ||
        cached.bypasses !== expectedLongBypasses
    ) {
        throw new Error(`cached catalog counters are inconsistent: ${JSON.stringify(cached)}`);
    }
    if (
        control.requests !== expectedLongBypasses + expectedCanonicalCalls ||
        control.hits !== 0 ||
        control.misses !== 0 ||
        control.bypasses !== expectedLongBypasses + expectedCanonicalCalls
    ) {
        throw new Error(`bookkeeping-control counters are inconsistent: ${JSON.stringify(control)}`);
    }
}

function timedArm(arm: ArmName, cases: readonly ICase[], cycles: number): IArmMeasurement {
    let checksum = FNV_OFFSET;
    const started = process.hrtime.bigint();
    for (let cycle = 0; cycle < cycles; cycle++) {
        executeCycle(arm, cases[cycle % cases.length], cycle, false, (result) => {
            checksum = foldMovePath(checksum, result);
        });
    }
    const durationNs = Number(process.hrtime.bigint() - started);
    return {
        durationNs,
        nanosecondsPerCycle: durationNs / cycles,
        checksum,
    };
}

function warmUp(cases: readonly ICase[], warmupMs: number): number {
    const deadline = process.hrtime.bigint() + BigInt(Math.ceil(warmupMs * 1_000_000));
    let rounds = 0;
    while (process.hrtime.bigint() < deadline) {
        const order = BALANCED_ARM_ORDERS[rounds % BALANCED_ARM_ORDERS.length];
        for (const arm of order) timedArm(arm, cases, 12);
        rounds++;
    }
    return rounds;
}

function calibrate(
    cases: readonly ICase[],
    targetMs: number,
): {
    cyclesPerBlock: number;
    pilotCycles: number;
    pilot: Record<ArmName, IArmMeasurement>;
} {
    let pilotCycles = 8;
    let pilot = Object.fromEntries(ARM_NAMES.map((arm) => [arm, timedArm(arm, cases, pilotCycles)])) as Record<
        ArmName,
        IArmMeasurement
    >;
    while (
        Math.min(...ARM_NAMES.map((arm) => pilot[arm].durationNs)) < 5_000_000 &&
        pilotCycles < MAX_CYCLES_PER_BLOCK
    ) {
        pilotCycles *= 2;
        pilot = Object.fromEntries(ARM_NAMES.map((arm) => [arm, timedArm(arm, cases, pilotCycles)])) as Record<
            ArmName,
            IArmMeasurement
        >;
    }
    const meanNsPerCycle =
        ARM_NAMES.reduce((total, arm) => total + pilot[arm].nanosecondsPerCycle, 0) / ARM_NAMES.length;
    const requestedCycles = (targetMs * 1_000_000) / meanNsPerCycle;
    // executeCycle's deterministic 57/100 and 89/100 branches restart at zero for each block. A multiple of
    // 100 keeps every measured block at the exact declared workload mix instead of a calibration-dependent one.
    const cyclesPerBlock = Math.min(MAX_CYCLES_PER_BLOCK, Math.max(100, Math.round(requestedCycles / 100) * 100));
    return {
        cyclesPerBlock,
        pilotCycles,
        pilot,
    };
}

function runBlocks(cases: readonly ICase[], blocks: number, cyclesPerBlock: number): IRawBlock[] {
    const rows: IRawBlock[] = [];
    for (let block = 0; block < blocks; block++) {
        const order = [...BALANCED_ARM_ORDERS[block % BALANCED_ARM_ORDERS.length]];
        const measured = {} as Record<ArmName, IArmMeasurement>;
        for (const arm of order) {
            measured[arm] = timedArm(arm, cases, cyclesPerBlock);
        }
        const checksums = ARM_NAMES.map((arm) => measured[arm].checksum);
        if (new Set(checksums).size !== 1) {
            throw new Error(`timed checksum mismatch in block ${block}: ${checksums.join(",")}`);
        }
        rows.push({
            block,
            order,
            passThrough: measured.passThrough,
            bookkeepingControl: measured.bookkeepingControl,
            idealReuse: measured.idealReuse,
            cachedCatalog: measured.cachedCatalog,
        });
    }
    return rows;
}

function mean(values: readonly number[]): number {
    return values.reduce((total, value) => total + value, 0) / values.length;
}

function quantile(values: readonly number[], probability: number): number {
    if (!values.length) throw new Error("cannot calculate a quantile of an empty set");
    const sorted = [...values].sort((left, right) => left - right);
    if (sorted.length === 1) return sorted[0];
    const position = (sorted.length - 1) * probability;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    const fraction = position - lower;
    return sorted[lower] * (1 - fraction) + sorted[upper] * fraction;
}

function aggregate(rows: readonly IRawBlock[]): IAggregateTiming {
    const passThroughNsPerCycle = mean(rows.map((row) => row.passThrough.nanosecondsPerCycle));
    const bookkeepingControlNsPerCycle = mean(rows.map((row) => row.bookkeepingControl.nanosecondsPerCycle));
    const idealReuseNsPerCycle = mean(rows.map((row) => row.idealReuse.nanosecondsPerCycle));
    const cachedCatalogNsPerCycle = mean(rows.map((row) => row.cachedCatalog.nanosecondsPerCycle));
    const bookkeepingControlOverheadNsPerCycle = bookkeepingControlNsPerCycle - passThroughNsPerCycle;
    const grossRecomputeSavedNsPerCycle = passThroughNsPerCycle - idealReuseNsPerCycle;
    const catalogOverheadNsPerCycle = cachedCatalogNsPerCycle - idealReuseNsPerCycle;
    const netSavedNsPerCycle = passThroughNsPerCycle - cachedCatalogNsPerCycle;
    return {
        passThroughNsPerCycle,
        bookkeepingControlNsPerCycle,
        idealReuseNsPerCycle,
        cachedCatalogNsPerCycle,
        bookkeepingControlOverheadNsPerCycle,
        grossRecomputeSavedNsPerCycle,
        catalogOverheadNsPerCycle,
        netSavedNsPerCycle,
        overheadToSavedRatio: catalogOverheadNsPerCycle / grossRecomputeSavedNsPerCycle,
        cachedToIdealRatio: cachedCatalogNsPerCycle / idealReuseNsPerCycle,
        cachedToPassThroughRatio: cachedCatalogNsPerCycle / passThroughNsPerCycle,
        cachedToControlRatio: cachedCatalogNsPerCycle / bookkeepingControlNsPerCycle,
    };
}

function bootstrap(
    rows: readonly IRawBlock[],
    samples: number,
    seed: number,
    select: (timing: IAggregateTiming) => number,
): IInterval {
    const estimates: number[] = [];
    let rejectedSamples = 0;
    const random = makeRng(seed);
    for (let sample = 0; sample < samples; sample++) {
        const resampled = Array.from({ length: rows.length }, () => rows[Math.floor(random() * rows.length)]);
        const timing = aggregate(resampled);
        const estimate = select(timing);
        if (!Number.isFinite(estimate) || timing.grossRecomputeSavedNsPerCycle <= 0) {
            rejectedSamples++;
            continue;
        }
        estimates.push(estimate);
    }
    if (estimates.length < Math.max(100, samples * 0.95)) {
        throw new Error(`bootstrap retained only ${estimates.length}/${samples} samples`);
    }
    return {
        lower95: quantile(estimates, 0.025),
        median: quantile(estimates, 0.5),
        upper95: quantile(estimates, 0.975),
        lower99: quantile(estimates, 0.005),
        upper99: quantile(estimates, 0.995),
        acceptedSamples: estimates.length,
        rejectedSamples,
    };
}

function sha256File(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function main(): Promise<void> {
    const options = commandLine();
    const cases = makeCases();
    const startCellOwnership = startCellOwnershipPreflight(cases[0]);
    const exact = Object.fromEntries(
        ARM_NAMES.map((arm) => [arm, exactArm(arm, cases, options.exactCycles)]),
    ) as Record<ArmName, IExactArmResult>;
    assertExactness(exact, options.exactCycles);

    const warmupRounds = warmUp(cases, options.warmupMs);
    const calibration = calibrate(cases, options.targetMs);
    const rows = runBlocks(cases, options.blocks, calibration.cyclesPerBlock);
    const timing = aggregate(rows);
    const overheadInterval = bootstrap(
        rows,
        options.bootstrapSamples,
        options.bootstrapSeed,
        (sample) => sample.overheadToSavedRatio,
    );
    const cachedControlInterval = bootstrap(
        rows,
        options.bootstrapSamples,
        options.bootstrapSeed ^ 0x9e37_79b9,
        (sample) => sample.cachedToControlRatio,
    );
    const cachedPassThroughInterval = bootstrap(
        rows,
        options.bootstrapSamples,
        options.bootstrapSeed ^ 0x243f_6a88,
        (sample) => sample.cachedToPassThroughRatio,
    );
    const gate = {
        thresholdExclusive: STRICT_OVERHEAD_TO_SAVED_GATE,
        positiveGrossRecomputeSaved: timing.grossRecomputeSavedNsPerCycle > 0,
        pointBelowThreshold: timing.overheadToSavedRatio < STRICT_OVERHEAD_TO_SAVED_GATE,
        bootstrapUpper95BelowThreshold: overheadInterval.upper95 < STRICT_OVERHEAD_TO_SAVED_GATE,
        passed:
            timing.grossRecomputeSavedNsPerCycle > 0 &&
            timing.overheadToSavedRatio < STRICT_OVERHEAD_TO_SAVED_GATE &&
            overheadInterval.upper95 < STRICT_OVERHEAD_TO_SAVED_GATE,
    };
    const sourceRoot = resolve(dirname(RUNNER_PATH), "../../..");
    const report = {
        schema: SCHEMA,
        generatedAt: new Date().toISOString(),
        mode: options.smoke ? "smoke" : "evidence",
        command: {
            blocks: options.blocks,
            targetMs: options.targetMs,
            warmupMs: options.warmupMs,
            exactCycles: options.exactCycles,
            bootstrapSamples: options.bootstrapSamples,
            bootstrapSeed: options.bootstrapSeed,
        },
        host: {
            platform: platform(),
            release: release(),
            arch: arch(),
            cpuModel: cpus()[0]?.model ?? "unknown",
            logicalCpus: cpus().length,
            bunVersion: Bun.version,
        },
        source: {
            root: sourceRoot,
            runnerPath: RUNNER_PATH,
            runnerSha256: sha256File(RUNNER_PATH),
            decisionPathCatalogSha256: sha256File(resolve(sourceRoot, "src/ai/decision_path_catalog.ts")),
            pathHelperSha256: sha256File(resolve(sourceRoot, "src/grid/path_helper.ts")),
        },
        workload: {
            gridSize: GRID_SIZE,
            cases: cases.map((pathCase) => ({
                name: pathCase.name,
                currentCell: pathCase.currentCell,
                maxSteps: pathCase.maxSteps,
                canFly: pathCase.canFly,
                isSmallUnit: pathCase.isSmallUnit,
                reachableDestinations: pathCase.delegate.getMovePath(...canonicalArgs(pathCase)).knownPaths.size,
            })),
            longBudgetBypassesPer100Decisions: LONG_BYPASS_PERCENT,
            canonicalRequestsPer100Decisions: 200 + THIRD_CANONICAL_PERCENT,
            meanRequestsPerDecision: (LONG_BYPASS_PERCENT + 200 + THIRD_CANONICAL_PERCENT) / 100,
            meanCanonicalRequestsPerDecision: (200 + THIRD_CANONICAL_PERCENT) / 100,
            control:
                "same catalog creation and full canonical-key comparison; final isMadeOfFire mismatch forces delegation on non-lava matrices",
            idealReuse:
                "same logical requests and result folds as cached; direct PathHelper computes the long bypass and first canonical request only, then a local variable supplies repeated canonical results",
        },
        exactness: {
            passed: true,
            startCellOwnership,
            cyclesPerArm: options.exactCycles,
            arms: exact,
        },
        warmup: {
            durationTargetMs: options.warmupMs,
            latinRounds: warmupRounds,
        },
        calibration,
        performance: {
            timing,
            overheadToSavedBootstrap: overheadInterval,
            cachedToPassThroughBootstrap: cachedPassThroughInterval,
            cachedToControlBootstrap: cachedControlInterval,
            gate,
        },
        rawBlocks: rows,
    };

    if (options.out) {
        mkdirSync(dirname(options.out), { recursive: true });
        writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    }
    console.log(
        JSON.stringify(
            {
                out: options.out ?? null,
                mode: report.mode,
                exactness: report.exactness.passed,
                cyclesPerBlock: calibration.cyclesPerBlock,
                timing,
                overheadToSavedBootstrap: overheadInterval,
                cachedToPassThroughBootstrap: cachedPassThroughInterval,
                gate,
            },
            null,
            2,
        ),
    );
    if (!gate.passed) {
        throw new Error(
            `strict catalog-overhead gate failed: point=${timing.overheadToSavedRatio}, upper95=${overheadInterval.upper95}, threshold<${STRICT_OVERHEAD_TO_SAVED_GATE}`,
        );
    }
}

await main();
