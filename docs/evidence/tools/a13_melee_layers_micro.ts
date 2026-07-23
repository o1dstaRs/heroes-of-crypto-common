#!/usr/bin/env bun

/**
 * A13 Workstream 5 fused melee-target-layer differential microbenchmark.
 *
 * The candidate is the production internal primitive. The baseline below is an independent, frozen copy of
 * the former getBorderCells_2 -> filterCells -> isFree pipeline, including its Set-of-fresh-objects behavior:
 * coordinate-equal corners are intentionally retained as distinct entries.
 *
 * Evidence:
 *   bun docs/evidence/tools/a13_melee_layers_micro.ts \
 *     --out=/tmp/a13-melee-layers-micro.json
 *
 * Short structural smoke (never qualifies as evidence):
 *   bun docs/evidence/tools/a13_melee_layers_micro.ts \
 *     --smoke --out=/tmp/a13-melee-layers-micro-smoke.json
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

import { buildMeleeTargetLayers } from "../../../src/ai/internal/melee_target_layers";
import type { IUnitAIRepr } from "../../../src/units/unit";
import {
    getDeterministicRandomSource,
    getRandomInt,
    setDeterministicRandomSource,
    type RandomSource,
} from "../../../src/utils/lib";
import { matrixElementOrDefault, type XY } from "../../../src/utils/math";

const SCHEMA = "heroes-of-crypto/a13-melee-layers-micro/v1" as const;
const RUNNER_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(RUNNER_PATH), "../../..");
const SOURCE_ROOT = join(ROOT, "src");
const WORKSPACE_ROOT = resolve(ROOT, "../..");
const WORKSPACE_LOCK_PATH = join(WORKSPACE_ROOT, "bun.lock");
const CANDIDATE_PATH = join(ROOT, "src/ai/internal/melee_target_layers.ts");
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
const CANDIDATE_RATIO_UPPER_95_GATE = 0.85;
const FAMILY_POINT_RATIO_GATE = 1.05;
const FNV_OFFSET = 0x811c_9dc5;
const FNV_PRIME = 0x0100_0193;

type ArmName = "legacy" | "candidate";
type RunMode = "evidence" | "smoke";
type Attacker = Pick<IUnitAIRepr, "getCells">;

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
        candidateSha256: string;
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
    attacker: IUnitAIRepr;
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

interface ILogicalAllocations {
    legacy: {
        borderCandidateXyObjects: number;
        bigAttackerProbeXyObjects: number;
        setObjects: number;
        arrayObjects: number;
        totalLogicalObjects: number;
    };
    candidate: {
        survivorXyObjects: number;
        arrayObjects: number;
        totalLogicalObjects: number;
    };
    reduction: {
        objects: number;
        fraction: number;
    };
}

interface IMutableLogicalAllocations {
    borderCandidateXyObjects: number;
    bigAttackerProbeXyObjects: number;
    setObjects: number;
    arrayObjects: number;
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
        console.log("Usage: bun docs/evidence/tools/a13_melee_layers_micro.ts --out=REPORT.json [--smoke]");
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
    if (!existsSync(CANDIDATE_PATH) || !statSync(CANDIDATE_PATH).isFile()) {
        throw new Error(`Candidate source is missing: ${CANDIDATE_PATH}`);
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
            candidateSha256: sha256(readFileSync(CANDIDATE_PATH)),
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

function legacyIsFree(cell: XY, matrix: number[][], attacker: Attacker): boolean {
    if (matrixElementOrDefault(matrix, cell.x, cell.y, 0) != 0) {
        for (const atCell of attacker.getCells()) {
            if (atCell.x === cell.x && atCell.y === cell.y) {
                return true;
            }
        }
        return false;
    }
    return cell.x >= 0 && cell.x < matrix[0].length && cell.y >= 0 && cell.y < matrix.length;
}

function legacyFilterCells(cells: XY[], matrix: number[][], isAttackerSmall: boolean, attacker: Attacker): XY[] {
    const filtered: XY[] = [];
    for (const cell of cells) {
        if (legacyIsFree(cell, matrix, attacker)) {
            if (isAttackerSmall) {
                filtered.push(cell);
            } else if (
                legacyIsFree({ x: cell.x - 1, y: cell.y }, matrix, attacker) &&
                legacyIsFree({ x: cell.x - 1, y: cell.y - 1 }, matrix, attacker) &&
                legacyIsFree({ x: cell.x, y: cell.y - 1 }, matrix, attacker)
            ) {
                filtered.push(cell);
            }
        }
    }
    return filtered;
}

function legacyBorderCells(currentCell: XY, isSmallUnit: boolean, distance: number): XY[] {
    const borderCells = new Set<XY>();
    for (let index = 0; index < distance * 2 + 1; index++) {
        borderCells.add({ x: currentCell.x - distance + index, y: currentCell.y - distance });
    }
    for (let index = 0; index < distance * 2 + 1; index++) {
        borderCells.add({
            x: currentCell.x - distance + index,
            y: currentCell.y + distance + (isSmallUnit ? 0 : 1),
        });
    }
    for (let index = 0; index < distance * 2 + 1; index++) {
        borderCells.add({ x: currentCell.x - distance, y: currentCell.y - distance + index });
    }
    for (let index = 0; index < distance * 2 + 1; index++) {
        borderCells.add({
            x: currentCell.x + distance + (isSmallUnit ? 0 : 1),
            y: currentCell.y - distance + index,
        });
    }
    if (!isSmallUnit) {
        borderCells.add({ x: currentCell.x + distance + 1, y: currentCell.y + distance + 1 });
    }
    return Array.from(borderCells);
}

function legacyBuildMeleeTargetLayers(
    cellToAttack: XY,
    matrix: number[][],
    attacker: Attacker,
    isCurrentUnitSmall = true,
    isTargetUnitSmall = true,
): XY[][] {
    const result: XY[][] = [];
    for (let distance = 1; distance < matrix.length / 2; distance++) {
        result[distance - 1] = legacyFilterCells(
            legacyBorderCells(cellToAttack, isCurrentUnitSmall, distance),
            matrix,
            isCurrentUnitSmall,
            attacker,
        );
    }
    return isTargetUnitSmall ? result : [];
}

const LEGACY_ORACLE = Object.freeze({
    buildMeleeTargetLayers: legacyBuildMeleeTargetLayers,
});

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
    const matrix = emptyMatrix();
    const attackerCells = options.small ? [{ ...options.attackerAnchor }] : bigFootprint(options.attackerAnchor);
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
    return {
        name: options.name,
        family: options.family,
        matrix,
        target: options.target,
        attacker: makeAttacker(attackerCells),
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

function assertEqualLayers(expected: XY[][], actual: XY[][], context: string): void {
    const expectedJson = JSON.stringify(exactShape(expected));
    const actualJson = JSON.stringify(exactShape(actual));
    if (expectedJson !== actualJson) {
        throw new Error(`${context}: candidate differs from legacy\nexpected=${expectedJson}\nactual=${actualJson}`);
    }
}

function runOneExact(
    matrix: number[][],
    target: XY,
    attackerCells: readonly XY[],
    isCurrentUnitSmall: boolean,
    isTargetUnitSmall: boolean,
    context: string,
): { getterCalls: number; outputCells: number; shapeSha256: string } {
    let legacyGetterCalls = 0;
    let candidateGetterCalls = 0;
    const legacy = LEGACY_ORACLE.buildMeleeTargetLayers(
        target,
        matrix,
        makeAttacker(attackerCells, () => legacyGetterCalls++),
        isCurrentUnitSmall,
        isTargetUnitSmall,
    );
    const candidate = buildMeleeTargetLayers(
        target,
        matrix,
        makeAttacker(attackerCells, () => candidateGetterCalls++),
        isCurrentUnitSmall,
        isTargetUnitSmall,
    );
    assertEqualLayers(legacy, candidate, context);
    if (legacyGetterCalls !== candidateGetterCalls) {
        throw new Error(
            `${context}: getCells calls differ: legacy=${legacyGetterCalls}, candidate=${candidateGetterCalls}`,
        );
    }
    return {
        getterCalls: candidateGetterCalls,
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
    let getterCallsCompared = 0;
    let outputCellsCompared = 0;
    const hash = createHash("sha256");
    for (const matrixFamily of matrixFamilies) {
        for (const isSmall of [true, false]) {
            const attackerCells = isSmall ? [{ x: 7, y: 7 }] : bigFootprint({ x: 7, y: 7 });
            const matrix = emptyMatrix();
            if (matrixFamily.seed !== undefined) {
                decorateLiveMatrix(matrix, matrixFamily.seed, attackerCells);
            }
            putCells(matrix, attackerCells, 1);
            for (let targetY = -2; targetY <= GRID_SIZE + 1; targetY++) {
                for (let targetX = -2; targetX <= GRID_SIZE + 1; targetX++) {
                    const result = runOneExact(
                        matrix,
                        { x: targetX, y: targetY },
                        attackerCells,
                        isSmall,
                        true,
                        `${matrixFamily.name}/${isSmall ? "small" : "big"}/${targetX},${targetY}`,
                    );
                    comparisons++;
                    getterCallsCompared += result.getterCalls;
                    outputCellsCompared += result.outputCells;
                    hash.update(
                        `${matrixFamily.name},${Number(isSmall)},${targetX},${targetY},${result.shapeSha256}\n`,
                    );
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
        getterCallsCompared += result.getterCalls;
    }
    return {
        passed: true,
        matrixFamilies: matrixFamilies.map((family) => family.name),
        targetCoordinatesPerAxis: { minimum: -2, maximum: GRID_SIZE + 1, count: GRID_SIZE + 4 },
        attackerSizes: ["small", "big"],
        eagerNonSmallTargetCases: 2,
        comparisons,
        getterCallsCompared,
        outputCellsCompared,
        digestSha256: hash.digest("hex"),
    };
}

function ownershipAndDuplicates(): Record<string, unknown> {
    const matrix = emptyMatrix();
    const attacker = makeAttacker([{ x: 15, y: 15 }]);
    const target = { x: 8, y: 8 };
    const first = buildMeleeTargetLayers(target, matrix, attacker, true, true);
    const second = buildMeleeTargetLayers(target, matrix, attacker, true, true);
    const expected = LEGACY_ORACLE.buildMeleeTargetLayers(target, matrix, attacker, true, true);
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
        throw new Error(`legacy duplicate-corner multiplicity was not retained: ${JSON.stringify(firstLayerShape)}`);
    }
    first[0][0].x = -999;
    first[0].push({ x: -998, y: -998 });
    const stableSecond = buildMeleeTargetLayers(target, matrix, attacker, true, true);
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
            if (arm === "legacy") {
                LEGACY_ORACLE.buildMeleeTargetLayers(
                    item.target,
                    item.matrix,
                    item.attacker,
                    item.isCurrentUnitSmall,
                    item.isTargetUnitSmall,
                );
            } else {
                buildMeleeTargetLayers(
                    item.target,
                    item.matrix,
                    item.attacker,
                    item.isCurrentUnitSmall,
                    item.isTargetUnitSmall,
                );
            }
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

function foldLayers(checksum: number, layers: readonly (readonly XY[])[]): number {
    checksum = fold(checksum, layers.length);
    for (const layer of layers) {
        checksum = fold(checksum, layer.length);
        for (const cell of layer) {
            checksum = fold(checksum, cell.x);
            checksum = fold(checksum, cell.y);
        }
    }
    return checksum;
}

function invoke(arm: ArmName, item: ICase): XY[][] {
    if (arm === "legacy") {
        return LEGACY_ORACLE.buildMeleeTargetLayers(
            item.target,
            item.matrix,
            item.attacker,
            item.isCurrentUnitSmall,
            item.isTargetUnitSmall,
        );
    }
    return buildMeleeTargetLayers(
        item.target,
        item.matrix,
        item.attacker,
        item.isCurrentUnitSmall,
        item.isTargetUnitSmall,
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
                familyChecksum = foldLayers(familyChecksum, result);
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

function countLegacyAllocations(item: ICase): IMutableLogicalAllocations {
    const counters: IMutableLogicalAllocations = {
        borderCandidateXyObjects: 0,
        bigAttackerProbeXyObjects: 0,
        setObjects: 0,
        arrayObjects: 1,
    };
    for (let distance = 1; distance < item.matrix.length / 2; distance++) {
        const border = legacyBorderCells(item.target, item.isCurrentUnitSmall, distance);
        counters.borderCandidateXyObjects += distance * 8 + 4 + (item.isCurrentUnitSmall ? 0 : 1);
        counters.setObjects++;
        counters.arrayObjects += 2;
        if (!item.isCurrentUnitSmall) {
            for (const cell of border) {
                if (!legacyIsFree(cell, item.matrix, item.attacker)) continue;
                counters.bigAttackerProbeXyObjects++;
                if (!legacyIsFree({ x: cell.x - 1, y: cell.y }, item.matrix, item.attacker)) continue;
                counters.bigAttackerProbeXyObjects++;
                if (!legacyIsFree({ x: cell.x - 1, y: cell.y - 1 }, item.matrix, item.attacker)) continue;
                counters.bigAttackerProbeXyObjects++;
            }
        }
    }
    return counters;
}

function logicalAllocations(cases: readonly ICase[]): ILogicalAllocations {
    const legacy = {
        borderCandidateXyObjects: 0,
        bigAttackerProbeXyObjects: 0,
        setObjects: 0,
        arrayObjects: 0,
        totalLogicalObjects: 0,
    };
    let candidateSurvivors = 0;
    let candidateArrays = 0;
    for (const item of cases) {
        const counted = countLegacyAllocations(item);
        legacy.borderCandidateXyObjects += counted.borderCandidateXyObjects;
        legacy.bigAttackerProbeXyObjects += counted.bigAttackerProbeXyObjects;
        legacy.setObjects += counted.setObjects;
        legacy.arrayObjects += counted.arrayObjects;
        const candidate = buildMeleeTargetLayers(
            item.target,
            item.matrix,
            item.attacker,
            item.isCurrentUnitSmall,
            item.isTargetUnitSmall,
        );
        candidateSurvivors += candidate.reduce((sum, layer) => sum + layer.length, 0);
        candidateArrays += 1 + Math.max(0, Math.ceil(item.matrix.length / 2) - 1);
    }
    legacy.totalLogicalObjects =
        legacy.borderCandidateXyObjects + legacy.bigAttackerProbeXyObjects + legacy.setObjects + legacy.arrayObjects;
    const candidate = {
        survivorXyObjects: candidateSurvivors,
        arrayObjects: candidateArrays,
        totalLogicalObjects: candidateSurvivors + candidateArrays,
    };
    return {
        legacy,
        candidate,
        reduction: {
            objects: legacy.totalLogicalObjects - candidate.totalLogicalObjects,
            fraction: 1 - candidate.totalLogicalObjects / legacy.totalLogicalObjects,
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
        let legacyCalls = 0;
        let candidateCalls = 0;
        const result = compareOutcomes(
            () =>
                LEGACY_ORACLE.buildMeleeTargetLayers(
                    item.target,
                    item.matrix as number[][],
                    makeAttacker(item.cells, () => legacyCalls++),
                    item.currentSmall,
                    item.targetSmall,
                ),
            () =>
                buildMeleeTargetLayers(
                    item.target,
                    item.matrix as number[][],
                    makeAttacker(item.cells, () => candidateCalls++),
                    item.currentSmall,
                    item.targetSmall,
                ),
            `post-timing/${item.name}`,
        );
        if (legacyCalls !== candidateCalls) {
            throw new Error(
                `post-timing/${item.name}: getCells calls differ: legacy=${legacyCalls}, candidate=${candidateCalls}`,
            );
        }
        return { name: item.name, getCellsCalls: candidateCalls, ...result };
    });

    function changingAttacker(events: string[]): IUnitAIRepr {
        let calls = 0;
        return {
            getCells: () => {
                events.push(`getCells:${calls}`);
                const phase = calls++ % 3;
                if (phase === 0) return [{ x: 7, y: 7 }];
                if (phase === 1) return [{ x: 9, y: 9 }];
                return [];
            },
        } as IUnitAIRepr;
    }
    const matrix = emptyMatrix();
    matrix[7][7] = 1;
    matrix[9][9] = 2;
    const legacyEvents: string[] = [];
    const candidateEvents: string[] = [];
    const custom = compareOutcomes(
        () => LEGACY_ORACLE.buildMeleeTargetLayers({ x: 8, y: 8 }, matrix, changingAttacker(legacyEvents), false, true),
        () => buildMeleeTargetLayers({ x: 8, y: 8 }, matrix, changingAttacker(candidateEvents), false, true),
        "post-timing/changing-attacker",
    );
    if (legacyEvents.join(",") !== candidateEvents.join(",")) {
        throw new Error(
            `post-timing/changing-attacker: getter event order differs\nlegacy=${legacyEvents}\ncandidate=${candidateEvents}`,
        );
    }

    function accessorAttacker(events: string[]): IUnitAIRepr {
        return {
            getCells: () => {
                events.push("getCells");
                return [
                    {
                        get x(): number {
                            events.push("cell0.x");
                            return 3;
                        },
                        get y(): number {
                            events.push("cell0.y");
                            return 3;
                        },
                    },
                    {
                        get x(): number {
                            events.push("cell1.x");
                            return 7;
                        },
                        get y(): number {
                            events.push("cell1.y");
                            return 7;
                        },
                    },
                ];
            },
        } as IUnitAIRepr;
    }
    const accessorLegacyEvents: string[] = [];
    const accessorCandidateEvents: string[] = [];
    const accessor = compareOutcomes(
        () =>
            LEGACY_ORACLE.buildMeleeTargetLayers(
                { x: 8, y: 8 },
                matrix,
                accessorAttacker(accessorLegacyEvents),
                false,
                true,
            ),
        () => buildMeleeTargetLayers({ x: 8, y: 8 }, matrix, accessorAttacker(accessorCandidateEvents), false, true),
        "post-timing/accessor-attacker",
    );
    if (accessorLegacyEvents.join(",") !== accessorCandidateEvents.join(",")) {
        throw new Error(
            "post-timing/accessor-attacker: x/y short-circuit trace differs\n" +
                `legacy=${accessorLegacyEvents}\ncandidate=${accessorCandidateEvents}`,
        );
    }
    return {
        passed: true,
        deliberatelyRunAfterTiming: true,
        malformedCases: outcomes,
        customGetter: {
            ...custom,
            eventCount: candidateEvents.length,
            eventDigestSha256: digest(candidateEvents),
            exactEventOrder: true,
        },
        accessorGetter: {
            ...accessor,
            eventCount: accessorCandidateEvents.length,
            eventDigestSha256: digest(accessorCandidateEvents),
            exactXThenYShortCircuitOrder: true,
        },
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
    for (const item of cases) {
        const expected = invoke("legacy", item);
        const actual = invoke("candidate", item);
        assertEqualLayers(expected, actual, `canonical/${item.name}`);
    }

    const warmup = warmUp(groupedCases, familyNames, cli.warmupMs);
    const calibration = calibrate(groupedCases, familyNames, cli.targetMs);
    const rows = runBlocks(groupedCases, familyNames, cli.blocks, calibration.cyclesPerBlock);
    const performance = performanceReport(rows, familyNames, cli.bootstrapSamples);
    const allocations = logicalAllocations(cases);

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
            purpose: "A13 Workstream 5 fused melee-target-layer differential microbenchmark",
            arms: {
                legacy: "independent frozen Set + Array.from + filterCells + isFree oracle copied from the removed pipeline",
                candidate: "production src/ai/internal/melee_target_layers.ts buildMeleeTargetLayers",
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
                sameFixedWorkAndChecksum: true,
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
            })),
            families: familyNames,
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
        logicalAllocations: {
            ...allocations,
            scope: "exact deterministic logical objects for one complete canonical-corpus pass",
            heapMeasurement: {
                measured: false,
                limitation:
                    "Bun/JSC does not expose a stable per-primitive heap-allocation counter; process heap deltas " +
                    "would mix GC and runtime noise. These are source-level logical object counts, not measured bytes.",
            },
        },
        gates: {
            candidatePrimitive: {
                metric: "paired-bootstrap upper 95% bound of candidate/legacy ratio of total durations",
                thresholdInclusive: CANDIDATE_RATIO_UPPER_95_GATE,
                point: point.ratioOfTotals,
                upper95: ratioInterval.upper95,
                passed: ratioUpper95Passed,
            },
            perFamily: {
                metric: "candidate/legacy ratio of total durations",
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
                logicalAllocationReduction: allocations.reduction,
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
