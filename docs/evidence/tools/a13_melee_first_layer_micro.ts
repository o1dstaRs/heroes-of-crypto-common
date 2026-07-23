#!/usr/bin/env bun

/**
 * A13 Workstream 5 canonical melee first-layer differential microbenchmark.
 *
 * The baseline performs the production full-layer build and consumes only layer zero, matching the infinite
 * movement branch before this slice. The candidate times the complete production eligibility guard plus the
 * first-layer helper. Every timed case reuses a pre-created real Unit, Grid, PathHelper, and DecisionPathCatalog.
 *
 * Evidence:
 *   bun docs/evidence/tools/a13_melee_first_layer_micro.ts \
 *     --out=/tmp/a13-melee-first-layer-micro.json
 *
 * Short structural smoke (never qualifies as evidence):
 *   bun docs/evidence/tools/a13_melee_first_layer_micro.ts \
 *     --smoke --out=/tmp/a13-melee-first-layer-micro-smoke.json
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
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
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { DecisionPathCatalog, createDecisionPathCatalog } from "../../../src/ai/decision_path_catalog";
import { buildFirstMeleeTargetLayers, buildMeleeTargetLayers } from "../../../src/ai/internal/melee_target_layers";
import { PBTypes } from "../../../src/generated/protobuf/v1/types";
import type { Grid } from "../../../src/grid/grid";
import { PathHelper } from "../../../src/grid/path_helper";
import type { IUnitAIRepr, Unit } from "../../../src/units/unit";
import {
    getDeterministicRandomSource,
    getRandomInt,
    setDeterministicRandomSource,
    type RandomSource,
} from "../../../src/utils/lib";
import type { XY } from "../../../src/utils/math";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../../../test/helpers/combat";

const SCHEMA = "heroes-of-crypto/a13-melee-first-layer-micro/v1" as const;
const RUNNER_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(RUNNER_PATH), "../../..");
const SOURCE_ROOT = join(ROOT, "src");
const WORKSPACE_ROOT = resolve(ROOT, "../..");
const WORKSPACE_LOCK_PATH = join(WORKSPACE_ROOT, "bun.lock");
const CANDIDATE_PATHS = Object.freeze([
    join(ROOT, "src/ai/ai.ts"),
    join(ROOT, "src/ai/decision_path_catalog.ts"),
    join(ROOT, "src/ai/internal/melee_target_layers.ts"),
]);
const SUPPORT_PATHS = Object.freeze([join(ROOT, "test/helpers/combat.ts")]);
const GRID_SIZE = 16;
const EVIDENCE_BLOCKS = 60;
const EVIDENCE_TARGET_MS = 90;
const EVIDENCE_WARMUP_MS = 750;
const EVIDENCE_BOOTSTRAP_SAMPLES = 20_000;
const SMOKE_BLOCKS = 8;
const SMOKE_TARGET_MS = 25;
const SMOKE_WARMUP_MS = 150;
const SMOKE_BOOTSTRAP_SAMPLES = 2_000;
const BOOTSTRAP_SEED = 0xa135_1a9e;
const MAX_CYCLES_PER_BLOCK = 1_000_000;
const CANDIDATE_RATIO_UPPER_95_GATE = 0.8;
const FAMILY_POINT_RATIO_GATE = 1.05;
const FNV_OFFSET = 0x811c_9dc5;
const FNV_PRIME = 0x0100_0193;

type ArmName = "legacy" | "candidate";
type RunMode = "evidence" | "smoke";

interface ICli {
    mode: RunMode;
    out: string;
    blocks: number;
    targetMs: number;
    warmupMs: number;
    bootstrapSamples: number;
}

interface ISourceEntry {
    path: string;
    kind: "file" | "symlink";
    bytes: number;
    sha256: string;
}

interface IRunSeal {
    root: string;
    realRoot: string;
    workspaceRoot: string;
    realWorkspaceRoot: string;
    gitHead: string;
    gitTree: string;
    source: {
        entries: number;
        bytes: number;
        manifestSha256: string;
        runtimeSha256: Record<string, string>;
        supportSha256: Record<string, string>;
    };
    runner: {
        path: string;
        bytes: number;
        sha256: string;
    };
    workspaceLock: {
        path: string;
        bytes: number;
        sha256: string;
    };
    dependencies: {
        recursivelySealed: false;
        commonNodeModulesRealPath: string;
        workspaceNodeModulesRealPath: string;
        limitation: string;
    };
    identitySha256: string;
}

interface ICase {
    name: string;
    family: string;
    matrix: number[][];
    target: XY;
    attacker: Unit;
    grid: Grid;
    catalog: DecisionPathCatalog;
    attackerCells: readonly XY[];
    isCurrentUnitSmall: boolean;
    isTargetUnitSmall: boolean;
}

interface IArmMeasurement {
    durationNs: number;
    nanosecondsPerCorpus: number;
    checksum: number;
    familyDurationNs: Record<string, number>;
    familyNanosecondsPerCorpus: Record<string, number>;
    familyChecksums: Record<string, number>;
}

interface IRawBlock {
    block: number;
    order: ArmName[];
    familyOrder: string[];
    legacy: IArmMeasurement;
    candidate: IArmMeasurement;
}

interface IPointEstimate {
    ratioOfTotals: number;
    pairedLogRatio: number;
    legacyNanosecondsPerCorpus: number;
    candidateNanosecondsPerCorpus: number;
}

interface IInterval {
    lower95: number;
    median: number;
    upper95: number;
    samples: number;
}

interface IBuilderOutputMaterialization {
    fullBuilderConsumedAtLayerZero: {
        emittedSurvivorXyObjectsAllLayers: number;
        resultAndLayerArrayObjects: number;
        builderOwnedOutputObjects: number;
    };
    guardedFirstLayer: {
        emittedSurvivorXyObjectsLayerZero: number;
        resultAndLayerArrayObjects: number;
        builderOwnedOutputObjects: number;
    };
    reduction: {
        builderOwnedOutputObjects: number;
        fractionOfFullBuilderOwnedOutputObjects: number;
    };
}

// Four-block ABBA schedule: each arm occupies each position equally, and both transition directions are balanced.
const BALANCED_ORDERS: readonly (readonly ArmName[])[] = [
    ["legacy", "candidate"],
    ["candidate", "legacy"],
    ["candidate", "legacy"],
    ["legacy", "candidate"],
];

function sha256(value: string | Uint8Array): string {
    return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) {
            const item = (value as Record<string, unknown>)[key];
            if (item !== undefined) result[key] = canonicalize(item);
        }
        return result;
    }
    return value;
}

const canonicalJson = (value: unknown): string => JSON.stringify(canonicalize(value));
const digest = (value: unknown): string => sha256(canonicalJson(value));
const normalizedPath = (path: string): string => path.split(sep).join("/");

function commandLine(): ICli {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        strict: true,
        allowPositionals: false,
        options: {
            out: { type: "string" },
            smoke: { type: "boolean", default: false },
            help: { type: "boolean", default: false },
        },
    });
    if (values.help) {
        console.log("Usage: bun docs/evidence/tools/a13_melee_first_layer_micro.ts --out=REPORT.json [--smoke]");
        process.exit(0);
    }
    if (!values.out?.trim()) throw new Error("--out is required");
    const out = resolve(values.out);
    if (existsSync(out)) throw new Error(`Refusing to overwrite report: ${out}`);
    const mode: RunMode = values.smoke ? "smoke" : "evidence";
    return {
        mode,
        out,
        blocks: mode === "evidence" ? EVIDENCE_BLOCKS : SMOKE_BLOCKS,
        targetMs: mode === "evidence" ? EVIDENCE_TARGET_MS : SMOKE_TARGET_MS,
        warmupMs: mode === "evidence" ? EVIDENCE_WARMUP_MS : SMOKE_WARMUP_MS,
        bootstrapSamples: mode === "evidence" ? EVIDENCE_BOOTSTRAP_SAMPLES : SMOKE_BOOTSTRAP_SAMPLES,
    };
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

function runSeal(): IRunSeal {
    for (const path of [...CANDIDATE_PATHS, ...SUPPORT_PATHS]) {
        if (!existsSync(path) || !statSync(path).isFile()) {
            throw new Error(`Required source is missing: ${path}`);
        }
    }
    if (!existsSync(WORKSPACE_LOCK_PATH) || !statSync(WORKSPACE_LOCK_PATH).isFile()) {
        throw new Error(`Workspace lockfile is missing: ${WORKSPACE_LOCK_PATH}`);
    }
    const entries: ISourceEntry[] = [];
    collectSourceEntries(SOURCE_ROOT, ROOT, entries);
    entries.sort((left, right) => left.path.localeCompare(right.path));
    const runnerStats = statSync(RUNNER_PATH);
    const lockStats = statSync(WORKSPACE_LOCK_PATH);
    const sealWithoutIdentity = {
        root: ROOT,
        realRoot: realpathSync(ROOT),
        workspaceRoot: WORKSPACE_ROOT,
        realWorkspaceRoot: realpathSync(WORKSPACE_ROOT),
        gitHead: gitValue("rev-parse", "HEAD"),
        gitTree: gitValue("rev-parse", "HEAD^{tree}"),
        source: {
            entries: entries.length,
            bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
            manifestSha256: digest(entries),
            runtimeSha256: Object.fromEntries(
                CANDIDATE_PATHS.map((path) => [normalizedPath(relative(ROOT, path)), sha256(readFileSync(path))]),
            ),
            supportSha256: Object.fromEntries(
                SUPPORT_PATHS.map((path) => [normalizedPath(relative(ROOT, path)), sha256(readFileSync(path))]),
            ),
        },
        runner: {
            path: normalizedPath(relative(ROOT, RUNNER_PATH)),
            bytes: runnerStats.size,
            sha256: sha256(readFileSync(RUNNER_PATH)),
        },
        workspaceLock: {
            path: normalizedPath(relative(ROOT, WORKSPACE_LOCK_PATH)),
            bytes: lockStats.size,
            sha256: sha256(readFileSync(WORKSPACE_LOCK_PATH)),
        },
        dependencies: {
            recursivelySealed: false as const,
            commonNodeModulesRealPath: realpathSync(join(ROOT, "node_modules")),
            workspaceNodeModulesRealPath: realpathSync(join(WORKSPACE_ROOT, "node_modules")),
            limitation:
                "The workspace bun.lock bytes and both node_modules realpaths are sealed; installed dependency " +
                "contents are not recursively hashed.",
        },
    };
    return {
        ...sealWithoutIdentity,
        identitySha256: digest(sealWithoutIdentity),
    };
}

function assertSameSeal(before: IRunSeal, after: IRunSeal): void {
    if (before.identitySha256 !== after.identitySha256) {
        throw new Error(`Source/runner/lock drift: ${before.identitySha256} -> ${after.identitySha256}`);
    }
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

function makeAttacker(cells: readonly XY[], onGetCells?: () => void): IUnitAIRepr {
    return {
        getCells: () => {
            onGetCells?.();
            return cells as XY[];
        },
    } as IUnitAIRepr;
}

function emptyMatrix(rows = GRID_SIZE, columns = GRID_SIZE): number[][] {
    return Array.from({ length: rows }, () => Array<number>(columns).fill(0));
}

function bigFootprint(anchor: XY): XY[] {
    return [
        { x: anchor.x, y: anchor.y },
        { x: anchor.x - 1, y: anchor.y },
        { x: anchor.x - 1, y: anchor.y - 1 },
        { x: anchor.x, y: anchor.y - 1 },
    ];
}

function decorateLiveMatrix(matrix: number[][], seed: number, excluded: readonly XY[]): void {
    const excludedKeys = new Set(excluded.map((cell) => `${cell.x},${cell.y}`));
    let state = seed >>> 0;
    for (let index = 0; index < 28; index++) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        const x = state & 15;
        const y = (state >>> 8) & 15;
        if (excludedKeys.has(`${x},${y}`)) continue;
        const values = [-4, -2, -1, 1, 2] as const;
        matrix[y][x] = values[(state >>> 16) % values.length];
    }
}

function putCells(matrix: number[][], cells: readonly XY[], value: number): void {
    for (const cell of cells) {
        if (cell.y >= 0 && cell.y < matrix.length && cell.x >= 0 && cell.x < matrix[cell.y].length) {
            matrix[cell.y][cell.x] = value;
        }
    }
}

function makeCanonicalCase(options: {
    name: string;
    family: string;
    target: XY;
    attackerAnchor: XY;
    small: boolean;
    seed: number;
    blocked?: boolean;
}): ICase {
    const combat = createCombatTestContext();
    const attacker = createTestUnit({
        name: `${options.name} actor`,
        team: PBTypes.TeamVals.LOWER,
        size: options.small ? PBTypes.UnitSizeVals.SMALL : PBTypes.UnitSizeVals.BIG,
        speed: 4.2,
    });
    const targetUnit = createTestUnit({
        name: `${options.name} target`,
        team: PBTypes.TeamVals.UPPER,
        size: PBTypes.UnitSizeVals.SMALL,
    });
    placeUnit(combat.grid, combat.unitsHolder, attacker, options.attackerAnchor);
    placeUnit(combat.grid, combat.unitsHolder, targetUnit, options.target);
    const matrix = combat.grid.getMatrix();
    const attackerCells = attacker.getCells().map((cell) => ({ ...cell }));
    const exclusion = [...attackerCells, options.target];
    decorateLiveMatrix(matrix, options.seed, exclusion);
    if (options.blocked) {
        for (let y = options.target.y - 3; y <= options.target.y + 4; y++) {
            for (let x = options.target.x - 3; x <= options.target.x + 4; x++) {
                if (y >= 0 && y < GRID_SIZE && x >= 0 && x < GRID_SIZE) matrix[y][x] = -1;
            }
        }
    }
    putCells(matrix, [options.target], 2);
    putCells(matrix, attackerCells, 1);
    const catalog = createDecisionPathCatalog(combat.grid, new PathHelper(testGridSettings), attacker, matrix);
    return {
        name: options.name,
        family: options.family,
        matrix,
        target: options.target,
        attacker,
        grid: combat.grid,
        catalog,
        attackerCells,
        isCurrentUnitSmall: options.small,
        isTargetUnitSmall: true,
    };
}

function makeCanonicalCases(): ICase[] {
    return [
        makeCanonicalCase({
            name: "small-interior-live",
            family: "small/interior",
            target: { x: 8, y: 8 },
            attackerAnchor: { x: 4, y: 9 },
            small: true,
            seed: 11,
        }),
        makeCanonicalCase({
            name: "small-edge-live",
            family: "small/edge",
            target: { x: 0, y: 0 },
            attackerAnchor: { x: 1, y: 0 },
            small: true,
            seed: 12,
        }),
        makeCanonicalCase({
            name: "small-early-own-cell",
            family: "small/early",
            target: { x: 8, y: 8 },
            attackerAnchor: { x: 7, y: 7 },
            small: true,
            seed: 13,
        }),
        makeCanonicalCase({
            name: "small-blocked-ring",
            family: "small/blocked",
            target: { x: 8, y: 8 },
            attackerAnchor: { x: 2, y: 2 },
            small: true,
            seed: 14,
            blocked: true,
        }),
        makeCanonicalCase({
            name: "big-interior-live",
            family: "big/interior",
            target: { x: 8, y: 8 },
            attackerAnchor: { x: 4, y: 10 },
            small: false,
            seed: 21,
        }),
        makeCanonicalCase({
            name: "big-edge-live",
            family: "big/edge",
            target: { x: 0, y: 0 },
            attackerAnchor: { x: 2, y: 1 },
            small: false,
            seed: 22,
        }),
        makeCanonicalCase({
            name: "big-early-own-cell",
            family: "big/early",
            target: { x: 8, y: 8 },
            attackerAnchor: { x: 7, y: 7 },
            small: false,
            seed: 23,
        }),
        makeCanonicalCase({
            name: "big-blocked-ring",
            family: "big/blocked",
            target: { x: 8, y: 8 },
            attackerAnchor: { x: 3, y: 3 },
            small: false,
            seed: 24,
            blocked: true,
        }),
    ];
}

function exactShape(layers: readonly (readonly XY[])[]): number[][][] {
    return layers.map((layer) => layer.map((cell) => [cell.x, cell.y]));
}

function assertEqualLayers(
    expected: readonly (readonly XY[])[],
    actual: readonly (readonly XY[])[],
    context: string,
): void {
    const expectedJson = JSON.stringify(exactShape(expected));
    const actualJson = JSON.stringify(exactShape(actual));
    if (expectedJson !== actualJson) {
        throw new Error(
            `${context}: first-layer helper differs from full-builder layer zero\nexpected=${expectedJson}\nactual=${actualJson}`,
        );
    }
}

function runOneExact(
    matrix: number[][],
    target: XY,
    attackerCells: readonly XY[],
    isCurrentUnitSmall: boolean,
    isTargetUnitSmall: boolean,
    context: string,
): { fullBuilderGetterCalls: number; firstLayerGetterCalls: number; outputCells: number; shapeSha256: string } {
    let fullBuilderGetterCalls = 0;
    let candidateGetterCalls = 0;
    const full = buildMeleeTargetLayers(
        target,
        matrix,
        makeAttacker(attackerCells, () => fullBuilderGetterCalls++),
        isCurrentUnitSmall,
        isTargetUnitSmall,
    );
    const expected = full.length === 0 ? [] : [full[0]];
    const candidate = buildFirstMeleeTargetLayers(
        target,
        matrix,
        makeAttacker(attackerCells, () => candidateGetterCalls++),
        isCurrentUnitSmall,
        isTargetUnitSmall,
    );
    assertEqualLayers(expected, candidate, context);
    return {
        fullBuilderGetterCalls,
        firstLayerGetterCalls: candidateGetterCalls,
        outputCells: candidate.reduce((sum, layer) => sum + layer.length, 0),
        shapeSha256: digest(exactShape(candidate)),
    };
}

function exhaustiveCorrectness(): Record<string, unknown> {
    const matrixFamilies = [
        { name: "open", seed: undefined },
        { name: "live-a", seed: 0x101 },
        { name: "live-b", seed: 0x202 },
    ] as const;
    let comparisons = 0;
    const dimensions = [
        { rows: 1, columns: 1 },
        { rows: 2, columns: 3 },
        { rows: 3, columns: 2 },
        { rows: 7, columns: 9 },
        { rows: 16, columns: 16 },
        { rows: 17, columns: 13 },
    ] as const;
    let fullBuilderGetterCalls = 0;
    let firstLayerGetterCalls = 0;
    let outputCellsCompared = 0;
    const hash = createHash("sha256");
    for (const dimension of dimensions) {
        for (const matrixFamily of matrixFamilies) {
            for (const isSmall of [true, false]) {
                const anchor = {
                    x: Math.max(isSmall ? 0 : 1, Math.min(dimension.columns - 1, 3)),
                    y: Math.max(isSmall ? 0 : 1, Math.min(dimension.rows - 1, 3)),
                };
                const attackerCells = isSmall ? [{ ...anchor }] : bigFootprint(anchor);
                const matrix = emptyMatrix(dimension.rows, dimension.columns);
                if (
                    matrixFamily.seed !== undefined &&
                    dimension.rows === GRID_SIZE &&
                    dimension.columns === GRID_SIZE
                ) {
                    decorateLiveMatrix(matrix, matrixFamily.seed, attackerCells);
                }
                putCells(matrix, attackerCells, 1);
                for (let targetY = -2; targetY <= dimension.rows + 1; targetY++) {
                    for (let targetX = -2; targetX <= dimension.columns + 1; targetX++) {
                        const result = runOneExact(
                            matrix,
                            { x: targetX, y: targetY },
                            attackerCells,
                            isSmall,
                            true,
                            `${dimension.rows}x${dimension.columns}/${matrixFamily.name}/` +
                                `${isSmall ? "small" : "big"}/${targetX},${targetY}`,
                        );
                        comparisons++;
                        fullBuilderGetterCalls += result.fullBuilderGetterCalls;
                        firstLayerGetterCalls += result.firstLayerGetterCalls;
                        outputCellsCompared += result.outputCells;
                        hash.update(
                            `${dimension.rows}x${dimension.columns},${matrixFamily.name},${Number(isSmall)},` +
                                `${targetX},${targetY},${result.shapeSha256}\n`,
                        );
                    }
                }
            }
        }
    }
    for (const isSmall of [true, false]) {
        const cells = isSmall ? [{ x: 7, y: 7 }] : bigFootprint({ x: 7, y: 7 });
        const matrix = emptyMatrix();
        putCells(matrix, cells, 1);
        const result = runOneExact(
            matrix,
            { x: 8, y: 8 },
            cells,
            isSmall,
            false,
            `non-small-target/${isSmall ? "small" : "big"}`,
        );
        comparisons++;
        fullBuilderGetterCalls += result.fullBuilderGetterCalls;
        firstLayerGetterCalls += result.firstLayerGetterCalls;
    }
    return {
        passed: true,
        matrixFamilies: matrixFamilies.map((family) => family.name),
        dimensions,
        targetCoordinates: "every anchor from -2 through rows/columns + 1 for every dimension",
        attackerSizes: ["small", "big"],
        nonSmallTargetCases: 2,
        comparisons,
        fullBuilderGetterCalls,
        firstLayerGetterCalls,
        outputCellsCompared,
        digestSha256: hash.digest("hex"),
    };
}

function ownershipAndDuplicates(): Record<string, unknown> {
    const matrix = emptyMatrix();
    const attacker = makeAttacker([{ x: 15, y: 15 }]);
    const target = { x: 8, y: 8 };
    const first = buildFirstMeleeTargetLayers(target, matrix, attacker, true, true);
    const second = buildFirstMeleeTargetLayers(target, matrix, attacker, true, true);
    const expected = buildMeleeTargetLayers(target, matrix, attacker, true, true).slice(0, 1);
    assertEqualLayers(expected, first, "ownership preflight");
    if (first === second || first.some((layer, index) => layer === second[index])) {
        throw new Error("candidate returned an outer or layer array owned by another call");
    }
    const firstObjects = first.flat();
    const secondObjects = second.flat();
    if (
        new Set(firstObjects).size !== firstObjects.length ||
        firstObjects.some((cell) => secondObjects.includes(cell))
    ) {
        throw new Error("candidate aliases returned XY objects within or across calls");
    }
    const firstLayerShape = exactShape([first[0]]);
    const coordinateCounts = new Map<string, number>();
    for (const cell of first[0]) {
        const key = `${cell.x},${cell.y}`;
        coordinateCounts.set(key, (coordinateCounts.get(key) ?? 0) + 1);
    }
    const duplicateEntries = [...coordinateCounts.values()].filter((count) => count > 1);
    if (first[0].length !== 12 || duplicateEntries.length !== 4 || duplicateEntries.some((count) => count !== 2)) {
        throw new Error(
            `first-layer duplicate-corner multiplicity was not retained: ${JSON.stringify(firstLayerShape)}`,
        );
    }
    first[0][0].x = -999;
    first[0].push({ x: -998, y: -998 });
    const stableSecond = buildFirstMeleeTargetLayers(target, matrix, attacker, true, true);
    assertEqualLayers(expected, stableSecond, "mutation isolation");
    return {
        passed: true,
        freshOuterArrays: true,
        freshLayerArrays: true,
        freshXyObjectsWithinCall: true,
        freshXyObjectsAcrossCalls: true,
        firstLayerEntries: firstLayerShape[0].length,
        firstLayerDistinctCoordinates: coordinateCounts.size,
        duplicatedCornerCoordinates: duplicateEntries.length,
        duplicateMultiplicity: 2,
        mutationIsolation: true,
    };
}

function makeRng(seed: number, onDraw?: () => void): RandomSource {
    let state = seed >>> 0;
    return () => {
        onDraw?.();
        state = (state + 0x6d2b_79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
    };
}

function rngArm(arm: ArmName, cases: readonly ICase[]): { drawsDuringPrimitive: number; tail: number[] } {
    const previous = getDeterministicRandomSource();
    let draws = 0;
    setDeterministicRandomSource(makeRng(0xa135_cafe, () => draws++));
    try {
        for (const item of cases) {
            invoke(arm, item);
        }
        const drawsDuringPrimitive = draws;
        const tail = Array.from({ length: 8 }, () => getRandomInt(0, 1_000_000));
        return { drawsDuringPrimitive, tail };
    } finally {
        setDeterministicRandomSource(previous);
    }
}

function rngPreflight(cases: readonly ICase[]): Record<string, unknown> {
    const legacy = rngArm("legacy", cases);
    const candidate = rngArm("candidate", cases);
    if (
        legacy.drawsDuringPrimitive !== 0 ||
        candidate.drawsDuringPrimitive !== 0 ||
        legacy.tail.join(",") !== candidate.tail.join(",")
    ) {
        throw new Error(`RNG drift: legacy=${JSON.stringify(legacy)}, candidate=${JSON.stringify(candidate)}`);
    }
    return { passed: true, legacy, candidate };
}

function fold(checksum: number, value: number): number {
    return Math.imul(checksum ^ (value | 0), FNV_PRIME) >>> 0;
}

function foldLayer(checksum: number, layer: readonly XY[]): number {
    checksum = fold(checksum, layer.length);
    for (const cell of layer) {
        checksum = fold(checksum, cell.x);
        checksum = fold(checksum, cell.y);
    }
    return checksum;
}

function invoke(arm: ArmName, item: ICase): readonly XY[] {
    if (arm === "legacy") {
        return (
            buildMeleeTargetLayers(
                item.target,
                item.matrix,
                item.attacker,
                item.isCurrentUnitSmall,
                item.isTargetUnitSmall,
            )[0] ?? []
        );
    }
    if (!DecisionPathCatalog.canElideUnconsumedMeleeLayers(item.catalog, item.grid, item.attacker, item.matrix)) {
        return (
            buildMeleeTargetLayers(
                item.target,
                item.matrix,
                item.attacker,
                item.isCurrentUnitSmall,
                item.isTargetUnitSmall,
            )[0] ?? []
        );
    }
    return (
        buildFirstMeleeTargetLayers(
            item.target,
            item.matrix,
            item.attacker,
            item.isCurrentUnitSmall,
            item.isTargetUnitSmall,
        )[0] ?? []
    );
}

function groupCases(cases: readonly ICase[]): Map<string, ICase[]> {
    const grouped = new Map<string, ICase[]>();
    for (const item of cases) {
        const family = grouped.get(item.family) ?? [];
        family.push(item);
        grouped.set(item.family, family);
    }
    return grouped;
}

function timedArm(
    arm: ArmName,
    groupedCases: ReadonlyMap<string, readonly ICase[]>,
    familyOrder: readonly string[],
    cycles: number,
): IArmMeasurement {
    let checksum = FNV_OFFSET;
    let durationNs = 0;
    const familyDurationNs: Record<string, number> = {};
    const familyNanosecondsPerCorpus: Record<string, number> = {};
    const familyChecksums: Record<string, number> = {};
    for (const family of familyOrder) {
        const cases = groupedCases.get(family);
        if (!cases) throw new Error(`Unknown family ${family}`);
        let familyChecksum = FNV_OFFSET;
        const started = process.hrtime.bigint();
        for (let cycle = 0; cycle < cycles; cycle++) {
            for (const item of cases) {
                const result = invoke(arm, item);
                familyChecksum = foldLayer(familyChecksum, result);
            }
        }
        const familyNs = Number(process.hrtime.bigint() - started);
        durationNs += familyNs;
        familyDurationNs[family] = familyNs;
        familyNanosecondsPerCorpus[family] = familyNs / cycles;
        familyChecksums[family] = familyChecksum;
        checksum = fold(checksum, familyChecksum);
    }
    return {
        durationNs,
        nanosecondsPerCorpus: durationNs / cycles,
        checksum,
        familyDurationNs,
        familyNanosecondsPerCorpus,
        familyChecksums,
    };
}

function warmUp(
    groupedCases: ReadonlyMap<string, readonly ICase[]>,
    familyNames: readonly string[],
    warmupMs: number,
): { targetMilliseconds: number; actualMilliseconds: number; rounds: number } {
    const started = process.hrtime.bigint();
    const deadline = started + BigInt(Math.ceil(warmupMs * 1_000_000));
    let rounds = 0;
    while (process.hrtime.bigint() < deadline) {
        const order = BALANCED_ORDERS[rounds % BALANCED_ORDERS.length];
        const familyOrder = rounds % 2 === 0 ? familyNames : [...familyNames].reverse();
        for (const arm of order) timedArm(arm, groupedCases, familyOrder, 2);
        rounds++;
    }
    return {
        targetMilliseconds: warmupMs,
        actualMilliseconds: Number(process.hrtime.bigint() - started) / 1_000_000,
        rounds,
    };
}

function calibrate(
    groupedCases: ReadonlyMap<string, readonly ICase[]>,
    familyNames: readonly string[],
    targetMs: number,
): Record<string, unknown> & { cyclesPerBlock: number } {
    let pilotCycles = 1;
    let legacy = timedArm("legacy", groupedCases, familyNames, pilotCycles);
    let candidate = timedArm("candidate", groupedCases, familyNames, pilotCycles);
    while (Math.min(legacy.durationNs, candidate.durationNs) < 8_000_000 && pilotCycles < MAX_CYCLES_PER_BLOCK) {
        pilotCycles *= 2;
        legacy = timedArm("legacy", groupedCases, familyNames, pilotCycles);
        candidate = timedArm("candidate", groupedCases, familyNames, pilotCycles);
    }
    const meanNanosecondsPerCorpus = (legacy.nanosecondsPerCorpus + candidate.nanosecondsPerCorpus) / 2;
    const cyclesPerBlock = Math.min(
        MAX_CYCLES_PER_BLOCK,
        Math.max(1, Math.round((targetMs * 1_000_000) / meanNanosecondsPerCorpus)),
    );
    return {
        targetMillisecondsPerArm: targetMs,
        pilotCycles,
        pilot: { legacy, candidate },
        meanNanosecondsPerCorpus,
        cyclesPerBlock,
    };
}

function runBlocks(
    groupedCases: ReadonlyMap<string, readonly ICase[]>,
    familyNames: readonly string[],
    blocks: number,
    cyclesPerBlock: number,
): IRawBlock[] {
    const rows: IRawBlock[] = [];
    for (let block = 0; block < blocks; block++) {
        const order = [...BALANCED_ORDERS[block % BALANCED_ORDERS.length]];
        const familyOrder = block % 2 === 0 ? [...familyNames] : [...familyNames].reverse();
        const measured = {} as Record<ArmName, IArmMeasurement>;
        for (const arm of order) measured[arm] = timedArm(arm, groupedCases, familyOrder, cyclesPerBlock);
        if (
            measured.legacy.checksum !== measured.candidate.checksum ||
            canonicalJson(measured.legacy.familyChecksums) !== canonicalJson(measured.candidate.familyChecksums)
        ) {
            throw new Error(`Timed checksum mismatch in block ${block}`);
        }
        rows.push({
            block,
            order,
            familyOrder,
            legacy: measured.legacy,
            candidate: measured.candidate,
        });
    }
    return rows;
}

function mean(values: readonly number[]): number {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function quantile(values: readonly number[], probability: number): number {
    if (!values.length) throw new Error("Cannot calculate an empty quantile");
    const sorted = [...values].sort((left, right) => left - right);
    const position = (sorted.length - 1) * probability;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    const fraction = position - lower;
    return sorted[lower] * (1 - fraction) + sorted[upper] * fraction;
}

function pointEstimate(rows: readonly IRawBlock[], family?: string): IPointEstimate {
    const legacyDurations = rows.map((row) =>
        family === undefined ? row.legacy.durationNs : row.legacy.familyDurationNs[family],
    );
    const candidateDurations = rows.map((row) =>
        family === undefined ? row.candidate.durationNs : row.candidate.familyDurationNs[family],
    );
    if (
        legacyDurations.some((value) => !Number.isFinite(value)) ||
        candidateDurations.some((value) => !Number.isFinite(value))
    ) {
        throw new Error(`Missing duration for ${family ?? "whole corpus"}`);
    }
    const legacyTotal = legacyDurations.reduce((sum, value) => sum + value, 0);
    const candidateTotal = candidateDurations.reduce((sum, value) => sum + value, 0);
    return {
        ratioOfTotals: candidateTotal / legacyTotal,
        pairedLogRatio: Math.exp(
            mean(candidateDurations.map((candidate, index) => Math.log(candidate / legacyDurations[index]))),
        ),
        legacyNanosecondsPerCorpus: mean(
            rows.map((row) =>
                family === undefined ? row.legacy.nanosecondsPerCorpus : row.legacy.familyNanosecondsPerCorpus[family],
            ),
        ),
        candidateNanosecondsPerCorpus: mean(
            rows.map((row) =>
                family === undefined
                    ? row.candidate.nanosecondsPerCorpus
                    : row.candidate.familyNanosecondsPerCorpus[family],
            ),
        ),
    };
}

function bootstrap(
    rows: readonly IRawBlock[],
    samples: number,
    seed: number,
    family: string | undefined,
    selector: (point: IPointEstimate) => number,
): IInterval {
    const random = makeRng(seed);
    const estimates: number[] = [];
    for (let sample = 0; sample < samples; sample++) {
        const resampled = Array.from({ length: rows.length }, () => rows[Math.floor(random() * rows.length)]);
        estimates.push(selector(pointEstimate(resampled, family)));
    }
    return {
        lower95: quantile(estimates, 0.025),
        median: quantile(estimates, 0.5),
        upper95: quantile(estimates, 0.975),
        samples,
    };
}

function performanceReport(
    rows: readonly IRawBlock[],
    familyNames: readonly string[],
    bootstrapSamples: number,
): Record<string, unknown> {
    const point = pointEstimate(rows);
    const ratioOfTotals = bootstrap(
        rows,
        bootstrapSamples,
        BOOTSTRAP_SEED,
        undefined,
        (sample) => sample.ratioOfTotals,
    );
    const pairedLogRatio = bootstrap(
        rows,
        bootstrapSamples,
        BOOTSTRAP_SEED ^ 0x9e37_79b9,
        undefined,
        (sample) => sample.pairedLogRatio,
    );
    const families: Record<string, unknown> = {};
    for (let index = 0; index < familyNames.length; index++) {
        const family = familyNames[index];
        const familyPoint = pointEstimate(rows, family);
        families[family] = {
            point: familyPoint,
            ratioOfTotalsBootstrap: bootstrap(
                rows,
                bootstrapSamples,
                BOOTSTRAP_SEED ^ Math.imul(index + 1, 0x45d9_f3b),
                family,
                (sample) => sample.ratioOfTotals,
            ),
            pairedLogRatioBootstrap: bootstrap(
                rows,
                bootstrapSamples,
                BOOTSTRAP_SEED ^ Math.imul(index + 1, 0x27d4_eb2d),
                family,
                (sample) => sample.pairedLogRatio,
            ),
        };
    }
    return {
        point,
        ratioOfTotalsBootstrap: ratioOfTotals,
        pairedLogRatioBootstrap: pairedLogRatio,
        families,
    };
}

function builderOutputMaterialization(cases: readonly ICase[]): IBuilderOutputMaterialization {
    const fullBuilderConsumedAtLayerZero = {
        emittedSurvivorXyObjectsAllLayers: 0,
        resultAndLayerArrayObjects: 0,
        builderOwnedOutputObjects: 0,
    };
    const guardedFirstLayer = {
        emittedSurvivorXyObjectsLayerZero: 0,
        resultAndLayerArrayObjects: 0,
        builderOwnedOutputObjects: 0,
    };
    for (const item of cases) {
        const full = buildMeleeTargetLayers(
            item.target,
            item.matrix,
            item.attacker,
            item.isCurrentUnitSmall,
            item.isTargetUnitSmall,
        );
        const first = buildFirstMeleeTargetLayers(
            item.target,
            item.matrix,
            item.attacker,
            item.isCurrentUnitSmall,
            item.isTargetUnitSmall,
        );
        fullBuilderConsumedAtLayerZero.emittedSurvivorXyObjectsAllLayers += full.reduce(
            (sum, layer) => sum + layer.length,
            0,
        );
        fullBuilderConsumedAtLayerZero.resultAndLayerArrayObjects += 1 + full.length;
        guardedFirstLayer.emittedSurvivorXyObjectsLayerZero += first.reduce((sum, layer) => sum + layer.length, 0);
        guardedFirstLayer.resultAndLayerArrayObjects += 1 + first.length;
    }
    fullBuilderConsumedAtLayerZero.builderOwnedOutputObjects =
        fullBuilderConsumedAtLayerZero.emittedSurvivorXyObjectsAllLayers +
        fullBuilderConsumedAtLayerZero.resultAndLayerArrayObjects;
    guardedFirstLayer.builderOwnedOutputObjects =
        guardedFirstLayer.emittedSurvivorXyObjectsLayerZero + guardedFirstLayer.resultAndLayerArrayObjects;
    return {
        fullBuilderConsumedAtLayerZero,
        guardedFirstLayer,
        reduction: {
            builderOwnedOutputObjects:
                fullBuilderConsumedAtLayerZero.builderOwnedOutputObjects - guardedFirstLayer.builderOwnedOutputObjects,
            fractionOfFullBuilderOwnedOutputObjects:
                1 -
                guardedFirstLayer.builderOwnedOutputObjects / fullBuilderConsumedAtLayerZero.builderOwnedOutputObjects,
        },
    };
}

function compareOutcomes(
    baseline: () => XY[][],
    candidate: () => XY[][],
    context: string,
): { threw: boolean; errorName?: string; errorMessage?: string; shapeSha256?: string } {
    let legacyValue: XY[][] | undefined;
    let candidateValue: XY[][] | undefined;
    let legacyError: unknown;
    let candidateError: unknown;
    try {
        legacyValue = baseline();
    } catch (error) {
        legacyError = error;
    }
    try {
        candidateValue = candidate();
    } catch (error) {
        candidateError = error;
    }
    if (legacyError !== undefined || candidateError !== undefined) {
        if (
            !(legacyError instanceof Error) ||
            !(candidateError instanceof Error) ||
            legacyError.name !== candidateError.name ||
            legacyError.message !== candidateError.message
        ) {
            throw new Error(
                `${context}: throw behavior differs; legacy=${String(legacyError)}, candidate=${String(candidateError)}`,
            );
        }
        return { threw: true, errorName: legacyError.name, errorMessage: legacyError.message };
    }
    assertEqualLayers(legacyValue!, candidateValue!, context);
    return { threw: false, shapeSha256: digest(exactShape(candidateValue!)) };
}

function postTimingMalformedAndCustom(): Record<string, unknown> {
    const cases = [
        {
            name: "ragged",
            matrix: [[0, 0, 0, 0], [0], [0, 1, 0], [], [0, 0]],
            target: { x: 1, y: 2 },
            cells: [{ x: 1, y: 1 }],
            currentSmall: true,
            targetSmall: true,
        },
        {
            name: "empty-first-row",
            matrix: [[], [0, -1], [0, 0, 0]],
            target: { x: 0, y: 1 },
            cells: [{ x: 0, y: 1 }],
            currentSmall: false,
            targetSmall: true,
        },
        {
            name: "single-row",
            matrix: [[0, 1, 0, 0, 0]],
            target: { x: 2, y: 0 },
            cells: [{ x: 1, y: 0 }],
            currentSmall: true,
            targetSmall: false,
        },
        {
            name: "empty-matrix",
            matrix: [] as number[][],
            target: { x: 0, y: 0 },
            cells: [{ x: 0, y: 0 }],
            currentSmall: true,
            targetSmall: true,
        },
    ] as const;
    const outcomes = cases.map((item) => {
        let fullBuilderCalls = 0;
        let firstLayerCalls = 0;
        const result = compareOutcomes(
            () =>
                buildMeleeTargetLayers(
                    item.target,
                    item.matrix as number[][],
                    makeAttacker(item.cells, () => fullBuilderCalls++),
                    item.currentSmall,
                    item.targetSmall,
                ).slice(0, 1),
            () =>
                buildFirstMeleeTargetLayers(
                    item.target,
                    item.matrix as number[][],
                    makeAttacker(item.cells, () => firstLayerCalls++),
                    item.currentSmall,
                    item.targetSmall,
                ),
            `post-timing/${item.name}`,
        );
        return { name: item.name, fullBuilderCalls, firstLayerCalls, ...result };
    });
    return {
        passed: true,
        deliberatelyRunAfterTiming: true,
        malformedCases: outcomes,
        note: "Only returned layer zero is compared; deeper full-builder getter traffic is intentionally unconsumed work.",
    };
}

async function main(): Promise<void> {
    const cli = commandLine();
    const sealBefore = runSeal();
    const cases = makeCanonicalCases();
    const groupedCases = groupCases(cases);
    const familyNames = [...groupedCases.keys()];

    const exhaustive = exhaustiveCorrectness();
    const ownership = ownershipAndDuplicates();
    const rng = rngPreflight(cases);
    const eligibility = cases.map((item) => ({
        name: item.name,
        eligible: DecisionPathCatalog.canElideUnconsumedMeleeLayers(
            item.catalog,
            item.grid,
            item.attacker,
            item.matrix,
        ),
    }));
    if (eligibility.some((item) => !item.eligible)) {
        throw new Error(`Canonical timing corpus failed eligibility: ${canonicalJson(eligibility)}`);
    }
    for (const item of cases) {
        const expected = invoke("legacy", item);
        const actual = invoke("candidate", item);
        assertEqualLayers([expected], [actual], `canonical/${item.name}`);
    }

    const warmup = warmUp(groupedCases, familyNames, cli.warmupMs);
    const calibration = calibrate(groupedCases, familyNames, cli.targetMs);
    const rows = runBlocks(groupedCases, familyNames, cli.blocks, calibration.cyclesPerBlock);
    const performance = performanceReport(rows, familyNames, cli.bootstrapSamples);
    const materialization = builderOutputMaterialization(cases);

    // Keep malformed/custom objects out of the JIT's canonical timing history.
    const postTiming = postTimingMalformedAndCustom();
    const sealAfter = runSeal();
    assertSameSeal(sealBefore, sealAfter);

    const point = (performance.point ?? {}) as IPointEstimate;
    const ratioInterval = (performance.ratioOfTotalsBootstrap ?? {}) as IInterval;
    const familyPerformance = (performance.families ?? {}) as Record<string, { point: IPointEstimate }>;
    const ratioUpper95Passed = ratioInterval.upper95 <= CANDIDATE_RATIO_UPPER_95_GATE;
    const familyPoints = familyNames.map((family) => ({
        family,
        candidateToLegacy: familyPerformance[family].point.ratioOfTotals,
        passed: familyPerformance[family].point.ratioOfTotals <= FAMILY_POINT_RATIO_GATE,
    }));
    const allFamilyPointsPassed = familyPoints.every((family) => family.passed);
    const measurementPassed = ratioUpper95Passed && allFamilyPointsPassed;
    const qualified = cli.mode === "evidence" && measurementPassed;
    const report = {
        schema: SCHEMA,
        createdAt: new Date().toISOString(),
        mode: cli.mode,
        protocol: {
            purpose: "A13 Workstream 5 guarded canonical melee first-layer differential microbenchmark",
            arms: {
                legacy: "production buildMeleeTargetLayers with only result[0] consumed, matching the old infinite-path branch",
                candidate:
                    "production DecisionPathCatalog.canElideUnconsumedMeleeLayers guard plus buildFirstMeleeTargetLayers, with only result[0] consumed",
            },
            order: {
                schedule: BALANCED_ORDERS,
                description:
                    "60 evidence blocks use a repeated two-arm Williams ABBA schedule; family traversal reverses every block",
            },
            timing: {
                blocks: cli.blocks,
                targetMillisecondsPerArmBlock: cli.targetMs,
                warmupMinimumMilliseconds: cli.warmupMs,
                cyclesPerBlock: calibration.cyclesPerBlock,
                sameCorpusCallsAndLayerZeroChecksum: true,
            },
            bootstrap: {
                pairedBlockResampling: true,
                samples: cli.bootstrapSamples,
                seed: BOOTSTRAP_SEED,
                intervals: "percentile 95%",
            },
        },
        source: {
            before: sealBefore,
            after: sealAfter,
            unchanged: true,
        },
        runtime: {
            platform: platform(),
            release: release(),
            arch: arch(),
            cpuModel: cpus()[0]?.model ?? "unknown",
            logicalCpus: cpus().length,
            bunVersion: Bun.version,
        },
        workload: {
            gridSize: GRID_SIZE,
            corpusCases: cases.map((item) => ({
                name: item.name,
                family: item.family,
                target: item.target,
                attackerCells: item.attackerCells,
                attackerSize: item.isCurrentUnitSmall ? "small" : "big",
                nonzeroMatrixCells: item.matrix.flat().filter((value) => value !== 0).length,
                realObjects: {
                    unit: item.attacker.constructor.name,
                    grid: item.grid.constructor.name,
                    catalog: item.catalog.constructor.name,
                },
            })),
            families: familyNames,
            canonicalEligibility: eligibility,
            values: "live-like dense rectangular numeric 16x16 matrices use empty 0, obstacle -4/-2/-1, and team 1/2 cells",
        },
        correctness: {
            order: ["fixed exhaustive differential", "ownership/duplicates", "RNG tail", "timing", "malformed/custom"],
            exhaustive,
            ownership,
            rng,
            canonicalCorpusPassed: true,
            postTiming,
        },
        warmup,
        calibration,
        performance,
        builderOutputMaterialization: {
            ...materialization,
            scope:
                "exact deterministic source-level builder-owned output objects for one complete " +
                "canonical-corpus pass",
            countedObjects: [
                "one result array per layer-builder call",
                "one layer array per materialized distance layer",
                "one emitted XY object per retained landing-cell occurrence, including duplicate-coordinate occurrences",
            ],
            excludedObjects: [
                "arrays, temporary XY values, and returned XY values allocated inside Unit.getCells during occupied-cell probes",
                "objects outside the layer builders, including engine and eligibility-guard implementation details",
                "runtime, JIT, garbage-collector, and other hidden allocations",
            ],
            heapMeasurement: {
                measured: false,
                limitation:
                    "Bun/JSC does not expose a stable per-primitive heap-allocation counter; process heap deltas " +
                    "would mix GC and runtime noise. This is a deliberately narrow builder-output materialization " +
                    "count, not a total allocation count or a measurement of heap bytes.",
            },
        },
        gates: {
            candidatePrimitive: {
                metric: "paired-bootstrap upper 95% bound of guarded-first-layer/full-builder-consumed-at-layer-zero total-duration ratio",
                thresholdInclusive: CANDIDATE_RATIO_UPPER_95_GATE,
                point: point.ratioOfTotals,
                upper95: ratioInterval.upper95,
                passed: ratioUpper95Passed,
            },
            perFamily: {
                metric: "guarded-first-layer/full-builder-consumed-at-layer-zero ratio of total durations",
                thresholdInclusive: FAMILY_POINT_RATIO_GATE,
                families: familyPoints,
                passed: allFamilyPointsPassed,
            },
            measurementPassed,
            qualified,
            smokeNeverQualifies: cli.mode === "smoke",
        },
        rawBlocks: rows,
    };
    writeJsonAtomicExclusive(cli.out, report);
    console.log(
        JSON.stringify(
            {
                out: cli.out,
                mode: cli.mode,
                exactComparisons: (exhaustive as { comparisons: number }).comparisons,
                cyclesPerBlock: calibration.cyclesPerBlock,
                ratioOfTotals: point.ratioOfTotals,
                ratioUpper95: ratioInterval.upper95,
                familyPoints,
                builderOutputMaterializationReduction: materialization.reduction,
                qualified,
            },
            null,
            2,
        ),
    );
    if (cli.mode === "evidence" && !measurementPassed) {
        throw new Error(
            `Workstream 5 gate failed: ratio upper95=${ratioInterval.upper95}, ` +
                `slow families=${familyPoints.filter((family) => !family.passed).map((family) => family.family)}`,
        );
    }
}

try {
    await main();
} catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
}
