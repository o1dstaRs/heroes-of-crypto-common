import { afterEach, describe, expect, test } from "bun:test";

import { FightStateManager } from "../../src/fights/fight_state_manager";
import { GridSettings } from "../../src/grid/grid_settings";
import { PathHelper } from "../../src/grid/path_helper";
import type { IMovePath } from "../../src/grid/path_definitions";
import { ObstacleType } from "../../src/obstacles/obstacle_type";
import { getRandomInt, setDeterministicRandomSource } from "../../src/utils/lib";
import type { XY } from "../../src/utils/math";

const gridSettings = new GridSettings(16, 2048, 0, 1024, -1024, 5, 0.06);

class GenericPathHelper extends PathHelper {
    public override getNeighborCells(
        currentCell: XY,
        visited: Set<number> = new Set(),
        isSmallUnit = true,
        getDiag = true,
        includeLeftRightEdges = false,
    ): XY[] {
        return super.getNeighborCells(currentCell, visited, isSmallUnit, getDiag, includeLeftRightEdges);
    }
}

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

const numberBitsView = new DataView(new ArrayBuffer(8));
const numberBits = (value: number): string => {
    numberBitsView.setFloat64(0, value, false);
    return numberBitsView.getBigUint64(0, false).toString(16).padStart(16, "0");
};
const cell = (value: XY): string => `${numberBits(value.x)}:${numberBits(value.y)}`;

const snapshot = (path: IMovePath): unknown => ({
    cells: path.cells.map(cell),
    hashes: Array.from(path.hashes, numberBits),
    knownPaths: Array.from(path.knownPaths, ([key, routes]) => [
        numberBits(key),
        routes.map((route) => ({
            cell: cell(route.cell),
            route: route.route.map(cell),
            weight: numberBits(route.weight),
            firstAggrMet: route.firstAggrMet,
            hasLavaCell: route.hasLavaCell,
            hasWaterCell: route.hasWaterCell,
        })),
    ]),
});

interface Case {
    start: XY;
    matrix: number[][];
    steps: number;
    aggression?: number[][];
    canFly: boolean;
    small: boolean;
    madeOfFire: boolean;
    vineStride: boolean;
    seed: number;
}

const makeCase = (index: number, start: XY, small: boolean): Case => {
    const seed = (0x51a7_5eed ^ Math.imul(index + 1, 0x9e37_79b1) ^ (start.x << 16) ^ start.y) >>> 0;
    const random = makeRng(seed);
    const matrix = Array.from({ length: 16 }, () => Array<number>(16).fill(0));
    const terrain = [0, 0, 0, 0, 0, ObstacleType.BLOCK, ObstacleType.HOLE, ObstacleType.LAVA, ObstacleType.WATER];
    for (let x = 0; x < 16; x++) {
        for (let y = 0; y < 16; y++) matrix[x][y] = terrain[Math.floor(random() * terrain.length)];
    }
    for (const x of small ? [start.x] : [start.x - 1, start.x]) {
        for (const y of small ? [start.y] : [start.y - 1, start.y]) matrix[x][y] = 0;
    }
    const aggression =
        index % 3 === 0
            ? undefined
            : Array.from({ length: 16 }, () =>
                  Array.from({ length: 16 }, () => [0, 1, 1, 1.25, 2, 3][Math.floor(random() * 6)]),
              );
    const stepValues = [0, 0.5, 1, PathHelper.DIAGONAL_MOVE_COST, 2, 3.5, 8, 16, Number.POSITIVE_INFINITY];
    return {
        start,
        matrix,
        steps: stepValues[index % stepValues.length],
        aggression,
        canFly: (index & 1) !== 0,
        small,
        madeOfFire: (index & 2) !== 0,
        vineStride: (index & 4) !== 0,
        seed,
    };
};

const execute = (helper: PathHelper, value: Case): { result: unknown; rngTail: number[] } => {
    let draws = 0;
    const source = makeRng(value.seed);
    setDeterministicRandomSource(() => {
        draws++;
        return source();
    });
    const result = snapshot(
        helper.getMovePath(
            { ...value.start },
            value.matrix.map((row) => row.slice()),
            value.steps,
            value.aggression?.map((row) => row.slice()),
            value.canFly,
            value.small,
            value.madeOfFire,
            value.vineStride,
        ),
    );
    const rngTail = [draws, getRandomInt(0, 1_000_000_000), getRandomInt(0, 1_000_000_000)];
    setDeterministicRandomSource(undefined);
    return { result, rngTail };
};

const fightProperties = FightStateManager.getInstance().getFightProperties();
afterEach(() => {
    setDeterministicRandomSource(undefined);
    fightProperties.getVines().clear();
    fightProperties.getFireWalls().clear();
});

describe("PathHelper indexed state differential", () => {
    test("matches the generic collection path for every legal origin across a randomized flag corpus", () => {
        const fast = new PathHelper(gridSettings);
        const generic = new GenericPathHelper(gridSettings);
        let cases = 0;
        fightProperties.getVines().addAll([
            { x: 5, y: 5 },
            { x: 6, y: 6 },
            { x: 10, y: 9 },
        ]);
        fightProperties.getFireWalls().addAll([
            { x: 4, y: 11 },
            { x: 8, y: 8 },
            { x: 12, y: 3 },
        ]);

        for (const small of [true, false]) {
            const minimum = small ? 0 : 1;
            for (let x = minimum; x < 16; x++) {
                for (let y = minimum; y < 16; y++) {
                    for (let variant = 0; variant < 4; variant++) {
                        const value = makeCase(cases + variant, { x, y }, small);
                        expect(execute(fast, value)).toEqual(execute(generic, value));
                        cases++;
                    }
                }
            }
        }

        expect(cases).toBe(1_924);
    });

    test("does not retain per-call typed state", () => {
        const fast = new PathHelper(gridSettings);
        const first = makeCase(9_001, { x: 8, y: 8 }, true);
        const second = makeCase(9_002, { x: 2, y: 13 }, false);

        execute(fast, first);
        expect(execute(fast, second)).toEqual(execute(new GenericPathHelper(gridSettings), second));
        expect(execute(fast, first)).toEqual(execute(new GenericPathHelper(gridSettings), first));
    });

    test("keeps custom helper hooks on the generic collection path", () => {
        type Filter = (path: IMovePath, matrix: number[][], small: boolean, madeOfFire: boolean) => IMovePath;
        const helper = new PathHelper(gridSettings);
        const prototypeFilter = (PathHelper.prototype as unknown as { filterUnallowedDestinations: Filter })
            .filterUnallowedDestinations;
        let workingHashCount = -1;
        (helper as unknown as { filterUnallowedDestinations: Filter }).filterUnallowedDestinations = function (
            path,
            matrix,
            small,
            madeOfFire,
        ) {
            workingHashCount = path.hashes.size;
            return prototypeFilter.call(this, path, matrix, small, madeOfFire);
        };

        const result = helper.getMovePath(
            { x: 8, y: 8 },
            Array.from({ length: 16 }, () => Array<number>(16).fill(0)),
            3,
        );

        expect(result.cells.length).toBeGreaterThan(0);
        expect(workingHashCount).toBeGreaterThan(0);
    });

    test("keeps prototype-level helper hooks on the generic collection path", () => {
        type Filter = (path: IMovePath, matrix: number[][], small: boolean, madeOfFire: boolean) => IMovePath;
        const prototype = PathHelper.prototype as unknown as { filterUnallowedDestinations: Filter };
        const native = prototype.filterUnallowedDestinations;
        let workingHashCount = -1;

        prototype.filterUnallowedDestinations = function (path, matrix, small, madeOfFire) {
            workingHashCount = path.hashes.size;
            return native.call(this, path, matrix, small, madeOfFire);
        };
        try {
            const result = new PathHelper(gridSettings).getMovePath(
                { x: 8, y: 8 },
                Array.from({ length: 16 }, () => Array<number>(16).fill(0)),
                3,
            );

            expect(result.cells.length).toBeGreaterThan(0);
            expect(workingHashCount).toBeGreaterThan(0);
        } finally {
            prototype.filterUnallowedDestinations = native;
        }
    });

    test("does not pre-read observable matrix rows", () => {
        const run = (helper: PathHelper): { result: unknown; rowReads: number[]; rngTail: number[] } => {
            const rowReads: number[] = [];
            const rows = Array.from({ length: 16 }, () => Array<number>(16).fill(0));
            const matrix = new Array<number[]>(16);
            for (let index = 0; index < 16; index++) {
                Object.defineProperty(matrix, index, {
                    configurable: true,
                    enumerable: true,
                    get: () => {
                        rowReads.push(index);
                        return rows[index];
                    },
                });
            }

            const source = makeRng(0x72ea_104d);
            setDeterministicRandomSource(source);
            const result = snapshot(helper.getMovePath({ x: 8, y: 8 }, matrix, 3));
            const rngTail = [getRandomInt(0, 1_000_000_000), getRandomInt(0, 1_000_000_000)];
            setDeterministicRandomSource(undefined);
            return { result, rowReads, rngTail };
        };

        expect(run(new PathHelper(gridSettings))).toEqual(run(new GenericPathHelper(gridSettings)));
    });
});
