import { afterEach, describe, expect, test } from "bun:test";
import { GridSettings } from "../../src/grid/grid_settings";
import type { IMovePath } from "../../src/grid/path_definitions";
import { PathHelper } from "../../src/grid/path_helper";
import { ObstacleType } from "../../src/obstacles/obstacle_type";
import { getRandomInt, setDeterministicRandomSource } from "../../src/utils/lib";
import type { XY } from "../../src/utils/math";

const PRODUCTION_GRID_SIZE = 16;

const makeGridSettings = (gridSize: number): GridSettings => new GridSettings(gridSize, 2048, 0, 1024, -1024, 5, 0.06);

const cellHash = (cell: XY): number => (cell.x << 4) | cell.y;

/**
 * Frozen compatibility oracle for the neighbor order/edge/filter contract that predates the A13 pathfinding work.
 *
 * This is deliberately a literal copy, rather than a second implementation derived from a neighbor table. Keep it
 * independent from PathHelper.getNeighborCells: an optimized production implementation must prove that it preserves
 * this behavior, including its bitwise hash coercions for fractional and malformed public inputs.
 */
class LegacyNeighborPathHelper extends PathHelper {
    private readonly legacyGridSettings: GridSettings;

    public constructor(gridSettings: GridSettings) {
        super(gridSettings);
        this.legacyGridSettings = gridSettings;
    }

    public override getNeighborCells(
        currentCell: XY,
        visited: Set<number> = new Set(),
        isSmallUnit = true,
        getDiag = true,
        includeLeftRightEdges = false,
    ): XY[] {
        const neighborsLine = [];
        const neighborsDiag = [];
        const diff = includeLeftRightEdges ? 2 : 0;
        const canGoLeft = currentCell.x > (isSmallUnit ? 0 : 1) - diff;
        const canGoRight = currentCell.x < this.legacyGridSettings.getGridSize() - 1 + diff;
        let canGoDown;
        if (currentCell.x < 0) {
            canGoDown = currentCell.y > 2;
        } else if (isSmallUnit) {
            canGoDown = currentCell.y > 0;
        } else {
            canGoDown = currentCell.y > 1;
        }
        const canGoUp = currentCell.y < this.legacyGridSettings.getGridSize() - 1;

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
}

const numberBits = (value: number): string => {
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    view.setFloat64(0, value, false);
    return view.getBigUint64(0, false).toString(16).padStart(16, "0");
};

const xySnapshot = (cell: XY): [string, string] => [numberBits(cell.x), numberBits(cell.y)];

const assertSameCells = (actual: XY[], expected: XY[], context: string): void => {
    if (actual.length !== expected.length) {
        throw new Error(`${context}: neighbor count ${actual.length} !== ${expected.length}`);
    }
    for (let index = 0; index < actual.length; index++) {
        if (!Object.is(actual[index].x, expected[index].x) || !Object.is(actual[index].y, expected[index].y)) {
            throw new Error(
                `${context}: neighbor ${index} ${JSON.stringify(xySnapshot(actual[index]))} !== ${JSON.stringify(
                    xySnapshot(expected[index]),
                )}`,
            );
        }
    }
};

const makeRng = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
    };
};

const snapshotValue = (value: unknown): string => {
    if (typeof value === "number") {
        return `n:${numberBits(value)}`;
    }
    if (typeof value === "boolean") {
        return value ? "b:1" : "b:0";
    }
    if (typeof value === "string") {
        return `s:${JSON.stringify(value)}`;
    }
    if (value === undefined) {
        return "u";
    }
    if (value === null) {
        return "null";
    }
    if (Array.isArray(value)) {
        const entries: string[] = [];
        for (let index = 0; index < value.length; index++) {
            entries.push(index in value ? snapshotValue(value[index]) : "hole");
        }
        return `a:${value.length}[${entries.join(",")}]`;
    }
    if (typeof value === "object") {
        const record = value as Record<string, unknown>;
        return `o:{${Object.keys(record)
            .sort()
            .map((key) => `${JSON.stringify(key)}=${snapshotValue(record[key])}`)
            .join(",")}}`;
    }
    return `${typeof value}:${String(value)}`;
};

interface MoveCase {
    name: string;
    gridSize: number;
    currentCell: XY;
    matrix: number[][];
    maxSteps: number;
    aggrBoard?: number[][];
    canFly: boolean;
    isSmallUnit: boolean;
    isMadeOfFire: boolean;
    randomSeed: number;
}

interface SerializedMoveResult {
    cells: [string, string][];
    hashes: string[];
    knownPaths: {
        key: string;
        routes: {
            cell: [string, string];
            route: [string, string][];
            weight: string;
            firstAggrMet: boolean;
            hasLavaCell: boolean;
            hasWaterCell: boolean;
        }[];
    }[];
}

interface MoveExecution {
    outcome: { kind: "result"; value: SerializedMoveResult } | { kind: "exception"; name: string; message: string };
    rngTail: number[];
}

const serializeMovePath = (movePath: IMovePath): SerializedMoveResult => ({
    cells: movePath.cells.map(xySnapshot),
    hashes: Array.from(movePath.hashes, numberBits),
    knownPaths: Array.from(movePath.knownPaths, ([key, routes]) => ({
        key: numberBits(key),
        routes: routes.map((weightedRoute) => ({
            cell: xySnapshot(weightedRoute.cell),
            route: weightedRoute.route.map(xySnapshot),
            weight: numberBits(weightedRoute.weight),
            firstAggrMet: weightedRoute.firstAggrMet,
            hasLavaCell: weightedRoute.hasLavaCell,
            hasWaterCell: weightedRoute.hasWaterCell,
        })),
    })),
});

const cloneMatrix = (matrix: number[][]): number[][] => matrix.map((row) => row.slice());

const executeMoveCase = (helper: PathHelper, moveCase: MoveCase): MoveExecution => {
    const currentCell = { ...moveCase.currentCell };
    const matrix = cloneMatrix(moveCase.matrix);
    const aggrBoard = moveCase.aggrBoard ? cloneMatrix(moveCase.aggrBoard) : undefined;
    const inputBefore = snapshotValue({ currentCell, matrix, aggrBoard });
    let outcome: MoveExecution["outcome"];

    setDeterministicRandomSource(makeRng(moveCase.randomSeed));
    try {
        outcome = {
            kind: "result",
            value: serializeMovePath(
                helper.getMovePath(
                    currentCell,
                    matrix,
                    moveCase.maxSteps,
                    aggrBoard,
                    moveCase.canFly,
                    moveCase.isSmallUnit,
                    moveCase.isMadeOfFire,
                ),
            ),
        };
    } catch (error) {
        outcome = {
            kind: "exception",
            name: error instanceof Error ? error.name : typeof error,
            message: error instanceof Error ? error.message : String(error),
        };
    }

    const inputAfter = snapshotValue({ currentCell, matrix, aggrBoard });
    if (inputAfter !== inputBefore) {
        throw new Error(`${moveCase.name}: getMovePath mutated a caller-owned input`);
    }

    const rngTail = [getRandomInt(0, 1_000_000_000), getRandomInt(0, 1_000_000_000), getRandomInt(0, 1_000_000_000)];
    setDeterministicRandomSource(undefined);
    return { outcome, rngTail };
};

const emptyMatrix = (size: number): number[][] => Array.from({ length: size }, () => Array<number>(size).fill(0));

const makeRandomMoveCase = (index: number, gridSize = PRODUCTION_GRID_SIZE): MoveCase => {
    const randomSeed = (0xa13d_da7a ^ Math.imul(index + 1, 0x9e37_79b1) ^ gridSize) >>> 0;
    const random = makeRng(randomSeed);
    const nextInt = (maxExclusive: number): number => Math.floor(random() * maxExclusive);
    const isSmallUnit = (index & 1) === 0 || gridSize < 2;
    const canFly = (index & 2) !== 0;
    const isMadeOfFire = (index & 4) !== 0;
    const minimumAnchor = isSmallUnit ? 0 : 1;
    const currentCell = {
        x: minimumAnchor + nextInt(Math.max(1, gridSize - minimumAnchor)),
        y: minimumAnchor + nextInt(Math.max(1, gridSize - minimumAnchor)),
    };
    const matrix = emptyMatrix(gridSize);
    const terrain = [0, 0, 0, 0, 0, 0, ObstacleType.BLOCK, ObstacleType.HOLE, ObstacleType.LAVA, ObstacleType.WATER, 1];
    for (let y = 0; y < gridSize; y++) {
        for (let x = 0; x < gridSize; x++) {
            matrix[y][x] = terrain[nextInt(terrain.length)];
        }
    }

    // Most cases start on a legal empty footprint; every ninth case intentionally keeps start terrain so the
    // initial-cell exemption and lava/water route metadata are part of the oracle corpus too.
    if (index % 9 !== 0) {
        for (const x of isSmallUnit ? [currentCell.x] : [currentCell.x - 1, currentCell.x]) {
            for (const y of isSmallUnit ? [currentCell.y] : [currentCell.y - 1, currentCell.y]) {
                if (matrix[y]?.[x] !== undefined) {
                    matrix[y][x] = 0;
                }
            }
        }
    }

    let aggrBoard: number[][] | undefined;
    if ((index & 8) !== 0) {
        aggrBoard = emptyMatrix(gridSize);
        const aggrValues = [0, 1, 1, 1, 2, 2, 3, 4];
        for (let y = 0; y < gridSize; y++) {
            for (let x = 0; x < gridSize; x++) {
                aggrBoard[y][x] = aggrValues[nextInt(aggrValues.length)];
            }
        }
    }

    const stepBudgets = [0, 0.25, 0.999999999999, 1, PathHelper.DIAGONAL_MOVE_COST, 2, 3.3, 4.2, 6.3];
    return {
        name: `seeded-${gridSize}-${index}`,
        gridSize,
        currentCell,
        matrix,
        maxSteps: stepBudgets[index % stepBudgets.length],
        aggrBoard,
        canFly,
        isSmallUnit,
        isMadeOfFire,
        randomSeed,
    };
};

const makeSpecialMoveCases = (): MoveCase[] => {
    const diagonalSqueeze = emptyMatrix(PRODUCTION_GRID_SIZE);
    diagonalSqueeze[7][6] = ObstacleType.BLOCK;
    diagonalSqueeze[6][7] = ObstacleType.HOLE;

    const terrainBands = emptyMatrix(PRODUCTION_GRID_SIZE);
    for (let index = 0; index < PRODUCTION_GRID_SIZE; index++) {
        terrainBands[4][index] = ObstacleType.LAVA;
        terrainBands[8][index] = ObstacleType.WATER;
        terrainBands[12][index] = index % 2 ? ObstacleType.BLOCK : 1;
    }

    const weightedAggro = emptyMatrix(PRODUCTION_GRID_SIZE);
    for (let y = 0; y < PRODUCTION_GRID_SIZE; y++) {
        for (let x = 0; x < PRODUCTION_GRID_SIZE; x++) {
            weightedAggro[y][x] = ((x * 3 + y * 5) % 4) + 1;
        }
    }

    const sparseMatrix = emptyMatrix(PRODUCTION_GRID_SIZE);
    sparseMatrix.length = 7;
    sparseMatrix[2].length = 3;
    delete sparseMatrix[1][1];

    return [
        {
            name: "small-corner-clear",
            gridSize: 16,
            currentCell: { x: 0, y: 0 },
            matrix: emptyMatrix(16),
            maxSteps: 6.3,
            canFly: false,
            isSmallUnit: true,
            isMadeOfFire: false,
            randomSeed: 1,
        },
        {
            name: "large-corner-clear",
            gridSize: 16,
            currentCell: { x: 1, y: 1 },
            matrix: emptyMatrix(16),
            maxSteps: 6.3,
            canFly: false,
            isSmallUnit: false,
            isMadeOfFire: false,
            randomSeed: 2,
        },
        {
            name: "small-diagonal-squeeze",
            gridSize: 16,
            currentCell: { x: 6, y: 6 },
            matrix: diagonalSqueeze,
            maxSteps: 4.2,
            canFly: false,
            isSmallUnit: true,
            isMadeOfFire: false,
            randomSeed: 3,
        },
        {
            name: "large-terrain-bands-fire",
            gridSize: 16,
            currentCell: { x: 8, y: 8 },
            matrix: terrainBands,
            maxSteps: 6.3,
            aggrBoard: weightedAggro,
            canFly: false,
            isSmallUnit: false,
            isMadeOfFire: true,
            randomSeed: 4,
        },
        {
            name: "flying-over-obstacles",
            gridSize: 16,
            currentCell: { x: 7, y: 7 },
            matrix: terrainBands,
            maxSteps: 4.2,
            aggrBoard: weightedAggro,
            canFly: true,
            isSmallUnit: true,
            isMadeOfFire: false,
            randomSeed: 5,
        },
        {
            name: "fractional-current",
            gridSize: 16,
            currentCell: { x: 5.5, y: 7.25 },
            matrix: emptyMatrix(16),
            maxSteps: 3.3,
            canFly: false,
            isSmallUnit: true,
            isMadeOfFire: false,
            randomSeed: 6,
        },
        {
            name: "nan-current",
            gridSize: 16,
            currentCell: { x: Number.NaN, y: Number.NaN },
            matrix: emptyMatrix(16),
            maxSteps: 4.2,
            canFly: false,
            isSmallUnit: true,
            isMadeOfFire: false,
            randomSeed: 7,
        },
        {
            name: "infinite-current",
            gridSize: 16,
            currentCell: { x: Number.POSITIVE_INFINITY, y: Number.NEGATIVE_INFINITY },
            matrix: emptyMatrix(16),
            maxSteps: 4.2,
            canFly: true,
            isSmallUnit: true,
            isMadeOfFire: true,
            randomSeed: 8,
        },
        {
            name: "nan-budget",
            gridSize: 16,
            currentCell: { x: 7, y: 7 },
            matrix: emptyMatrix(16),
            maxSteps: Number.NaN,
            canFly: false,
            isSmallUnit: true,
            isMadeOfFire: false,
            randomSeed: 9,
        },
        {
            name: "infinite-budget",
            gridSize: 7,
            currentCell: { x: 3, y: 3 },
            matrix: emptyMatrix(7),
            maxSteps: Number.POSITIVE_INFINITY,
            canFly: false,
            isSmallUnit: true,
            isMadeOfFire: false,
            randomSeed: 10,
        },
        {
            name: "ragged-matrix",
            gridSize: 16,
            currentCell: { x: 2, y: 2 },
            matrix: sparseMatrix,
            maxSteps: 4.2,
            canFly: false,
            isSmallUnit: true,
            isMadeOfFire: false,
            randomSeed: 11,
        },
        {
            name: "ragged-aggro-throws",
            gridSize: 16,
            currentCell: { x: 6, y: 6 },
            matrix: emptyMatrix(16),
            maxSteps: 4.2,
            aggrBoard: [[1]],
            canFly: false,
            isSmallUnit: true,
            isMadeOfFire: false,
            randomSeed: 12,
        },
    ];
};

afterEach(() => setDeterministicRandomSource(undefined));

describe("PathHelper neighbor compatibility oracle", () => {
    test("exhaustively preserves every 16x16 neighbor mode and relevant visited subset", () => {
        const gridSettings = makeGridSettings(PRODUCTION_GRID_SIZE);
        const production = new PathHelper(gridSettings);
        const legacy = new LegacyNeighborPathHelper(gridSettings);
        let comparisons = 0;

        for (let x = 0; x < PRODUCTION_GRID_SIZE; x++) {
            for (let y = 0; y < PRODUCTION_GRID_SIZE; y++) {
                const currentCell = { x, y };
                for (const isSmallUnit of [false, true]) {
                    for (const getDiag of [false, true]) {
                        for (const includeLeftRightEdges of [false, true]) {
                            const candidates = legacy.getNeighborCells(
                                currentCell,
                                new Set(),
                                isSmallUnit,
                                getDiag,
                                includeLeftRightEdges,
                            );
                            for (let mask = 0; mask < 1 << candidates.length; mask++) {
                                const visited = new Set<number>([cellHash(currentCell), 0x7fff_ffff]);
                                for (let index = 0; index < candidates.length; index++) {
                                    if (mask & (1 << index)) {
                                        visited.add(cellHash(candidates[index]));
                                    }
                                }
                                const visitedBefore = Array.from(visited);
                                const currentBefore = { ...currentCell };
                                const expected = legacy.getNeighborCells(
                                    currentCell,
                                    new Set(visited),
                                    isSmallUnit,
                                    getDiag,
                                    includeLeftRightEdges,
                                );
                                const actual = production.getNeighborCells(
                                    currentCell,
                                    visited,
                                    isSmallUnit,
                                    getDiag,
                                    includeLeftRightEdges,
                                );
                                assertSameCells(
                                    actual,
                                    expected,
                                    `cell=${x},${y} small=${isSmallUnit} diag=${getDiag} edges=${includeLeftRightEdges} mask=${mask}`,
                                );
                                expect(Array.from(visited)).toEqual(visitedBefore);
                                expect(currentCell).toEqual(currentBefore);
                                comparisons++;
                            }
                        }
                    }
                }
            }
        }

        expect(comparisons).toBeGreaterThan(100_000);
    });

    test("preserves fallback/custom-grid behavior for fractional, out-of-range, and malformed coordinates", () => {
        const gridSizes = [-3, 0, 1, 2, 7, 15, 17, 31, 7.5];
        const fixedValues = [
            Number.NEGATIVE_INFINITY,
            -17,
            -3.5,
            -1,
            -0,
            0,
            0.5,
            1,
            3.25,
            15,
            15.5,
            16,
            31,
            Number.MAX_SAFE_INTEGER,
            Number.POSITIVE_INFINITY,
            Number.NaN,
        ];
        let comparisons = 0;

        for (const gridSize of gridSizes) {
            const gridSettings = makeGridSettings(gridSize);
            const production = new PathHelper(gridSettings);
            const legacy = new LegacyNeighborPathHelper(gridSettings);
            const cells: XY[] = fixedValues.map((value, index) => ({
                x: value,
                y: fixedValues[(index * 7 + 3) % fixedValues.length],
            }));
            cells.push(
                { x: gridSize - 1, y: gridSize - 1 },
                { x: gridSize - 0.5, y: gridSize + 0.5 },
                { x: gridSize + 1, y: -gridSize },
            );

            for (const currentCell of cells) {
                const visitedVariants = [
                    new Set<number>(),
                    new Set<number>([0, 1, -1, 15, 16, 255, 256, cellHash(currentCell)]),
                    new Set<number>([
                        ((currentCell.x - 1) << 4) | currentCell.y,
                        ((currentCell.x + 1) << 4) | currentCell.y,
                        (currentCell.x << 4) | (currentCell.y - 1),
                        (currentCell.x << 4) | (currentCell.y + 1),
                    ]),
                ];
                for (const visited of visitedVariants) {
                    for (const isSmallUnit of [false, true]) {
                        for (const getDiag of [false, true]) {
                            for (const includeLeftRightEdges of [false, true]) {
                                const expected = legacy.getNeighborCells(
                                    currentCell,
                                    new Set(visited),
                                    isSmallUnit,
                                    getDiag,
                                    includeLeftRightEdges,
                                );
                                const actual = production.getNeighborCells(
                                    currentCell,
                                    new Set(visited),
                                    isSmallUnit,
                                    getDiag,
                                    includeLeftRightEdges,
                                );
                                assertSameCells(
                                    actual,
                                    expected,
                                    `grid=${gridSize} current=${snapshotValue(currentCell)} visited=${snapshotValue(
                                        Array.from(visited),
                                    )} small=${isSmallUnit} diag=${getDiag} edges=${includeLeftRightEdges}`,
                                );
                                comparisons++;
                            }
                        }
                    }
                }
            }
        }

        expect(comparisons).toBe(4_104);
    });

    test("returns caller-owned arrays and cells without mutating or retaining caller input", () => {
        const gridSettings = makeGridSettings(PRODUCTION_GRID_SIZE);
        const production = new PathHelper(gridSettings);
        const currentCell = { x: 8, y: 8 };
        const visited = new Set<number>([(7 << 4) | 8]);
        const first = production.getNeighborCells(currentCell, visited, true, true, true);
        const pristine = new LegacyNeighborPathHelper(gridSettings).getNeighborCells(
            currentCell,
            visited,
            true,
            true,
            true,
        );

        expect(first).not.toBe(pristine);
        for (let left = 0; left < first.length; left++) {
            expect(first[left]).not.toBe(currentCell);
            for (let right = left + 1; right < first.length; right++) {
                expect(first[left]).not.toBe(first[right]);
            }
        }

        first[0].x = -123_456;
        first[1].y = 987_654;
        first.length = 2;
        visited.add((9 << 4) | 8);
        currentCell.x = 4;

        const untouchedInputResult = production.getNeighborCells(
            { x: 8, y: 8 },
            new Set([(7 << 4) | 8]),
            true,
            true,
            true,
        );
        assertSameCells(untouchedInputResult, pristine, "mutation isolation");
    });

    test("preserves complete getMovePath results, exceptions, RNG consumption, and input immutability", () => {
        const moveCases: MoveCase[] = [];
        for (let index = 0; index < 1_024; index++) {
            moveCases.push(makeRandomMoveCase(index));
        }
        const customGridSizes = [1, 2, 3, 7, 15, 17, 31];
        for (let index = 0; index < 224; index++) {
            moveCases.push(makeRandomMoveCase(10_000 + index, customGridSizes[index % customGridSizes.length]));
        }
        moveCases.push(...makeSpecialMoveCases());

        for (const moveCase of moveCases) {
            const gridSettings = makeGridSettings(moveCase.gridSize);
            const expected = executeMoveCase(new LegacyNeighborPathHelper(gridSettings), moveCase);
            const actual = executeMoveCase(new PathHelper(gridSettings), moveCase);
            const expectedSnapshot = snapshotValue(expected);
            const actualSnapshot = snapshotValue(actual);
            if (actualSnapshot !== expectedSnapshot) {
                throw new Error(
                    `${moveCase.name}: production getMovePath differs from the legacy-neighbor oracle\nexpected ${expectedSnapshot}\nactual   ${actualSnapshot}`,
                );
            }
        }

        expect(moveCases.length).toBe(1_260);
    });
});
