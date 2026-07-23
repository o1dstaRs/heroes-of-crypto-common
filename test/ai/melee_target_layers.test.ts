/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import { buildFirstMeleeTargetLayers, buildMeleeTargetLayers } from "../../src/ai/internal/melee_target_layers";
import type { IUnitAIRepr } from "../../src/units/unit";
import type { XY } from "../../src/utils/math";

/*
 * Frozen independent oracle copied from the legacy getLayersForAttacker_2 path.
 *
 * Keep its Set<XY>, loose matrix comparison, repeated attacker.getCells() calls,
 * candidate construction order, and big-attacker short-circuiting intact. The
 * point of these tests is to make future implementation changes prove semantic
 * identity against that historical behavior rather than against a second
 * optimized implementation.
 */
const legacyMatrixElementOrDefault = (matrix: number[][], x: number, y: number, defaultValue: number): number => {
    if (!(y in matrix)) {
        return defaultValue;
    }
    if (!(x in matrix[y])) {
        return defaultValue;
    }
    return matrix[y][x];
};

const legacyIsSameCell = (first: XY, second: XY): boolean => first.x === second.x && first.y === second.y;

const legacyIsFree = (cell: XY, matrix: number[][], attacker: IUnitAIRepr): boolean => {
    if (legacyMatrixElementOrDefault(matrix, cell.x, cell.y, 0) != 0) {
        for (const atCell of attacker.getCells()) {
            if (legacyIsSameCell(atCell, cell)) {
                return true;
            }
        }
        return false;
    }
    return cell.x >= 0 && cell.x < matrix[0].length && cell.y >= 0 && cell.y < matrix.length;
};

const legacyFilterCells = (cells: XY[], matrix: number[][], isAttackerSmall: boolean, attacker: IUnitAIRepr): XY[] => {
    const filtered = [];
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
};

const legacyGetBorderCells2 = (currentCell: XY, isSmallUnit = true, distance = 1): XY[] => {
    // A Set does not deduplicate these newly allocated objects. That observable
    // duplicate order is intentional legacy behavior.
    const borderCells = new Set<XY>();
    for (let i = 0; i < distance * 2 + 1; i++) {
        borderCells.add({ x: currentCell.x - distance + i, y: currentCell.y - distance });
    }
    for (let i = 0; i < distance * 2 + 1; i++) {
        borderCells.add({
            x: currentCell.x - distance + i,
            y: currentCell.y + distance + (isSmallUnit ? 0 : 1),
        });
    }
    for (let i = 0; i < distance * 2 + 1; i++) {
        borderCells.add({ x: currentCell.x - distance, y: currentCell.y - distance + i });
    }
    for (let i = 0; i < distance * 2 + 1; i++) {
        borderCells.add({
            x: currentCell.x + distance + (isSmallUnit ? 0 : 1),
            y: currentCell.y - distance + i,
        });
    }
    if (!isSmallUnit) {
        borderCells.add({ x: currentCell.x + distance + 1, y: currentCell.y + distance + 1 });
    }
    return Array.from(borderCells);
};

const legacyBuildMeleeTargetLayers = (
    cellToAttack: XY,
    matrix: number[][],
    attacker: IUnitAIRepr,
    isCurrentUnitSmall = true,
    isTargetUnitSmall = true,
): XY[][] => {
    const result: XY[][] = [];
    for (let i = 1; i < matrix.length / 2; i++) {
        const borderCells = legacyFilterCells(
            legacyGetBorderCells2(cellToAttack, isCurrentUnitSmall, i),
            matrix,
            isCurrentUnitSmall,
            attacker,
        );
        result[i - 1] = borderCells;
    }
    if (isTargetUnitSmall) {
        return result;
    } else {
        return [];
    }
};

type Trace = string[];
type AttackerFactory = (trace: Trace) => IUnitAIRepr;
type MatrixFactory = (trace: Trace) => number[][];
type Outcome = { kind: "return"; value: XY[][] } | { error: unknown; kind: "throw" };

const attackerWithCells =
    (cells: readonly XY[]): AttackerFactory =>
    () =>
        ({
            getCells: () => cells as XY[],
        }) as unknown as IUnitAIRepr;

const freshAttackerWithCells = (cells: readonly XY[]): AttackerFactory => {
    return () => {
        const stableCells = cells.map((cell) => ({ x: cell.x, y: cell.y }));
        return {
            getCells: () => stableCells,
        } as unknown as IUnitAIRepr;
    };
};

const denseMatrixFactory = (matrix: readonly (readonly number[])[]): MatrixFactory => {
    return () => matrix.map((row) => [...row]);
};

const execute = (operation: () => XY[][]): Outcome => {
    try {
        return { kind: "return", value: operation() };
    } catch (error: unknown) {
        return { error, kind: "throw" };
    }
};

const normalizedError = (error: unknown): { message: string; name: string } => {
    if (error instanceof Error) {
        return { message: error.message, name: error.name };
    }
    return { message: String(error), name: typeof error };
};

const expectCoordinateArraysToBeSameValue = (actual: XY[][], expected: XY[][]): void => {
    expect(actual.length).toBe(expected.length);
    for (let layerIndex = 0; layerIndex < expected.length; layerIndex++) {
        const actualLayer = actual[layerIndex];
        const expectedLayer = expected[layerIndex];
        expect(actualLayer.length).toBe(expectedLayer.length);
        for (let cellIndex = 0; cellIndex < expectedLayer.length; cellIndex++) {
            const actualCell = actualLayer[cellIndex];
            const expectedCell = expectedLayer[cellIndex];
            expect(Object.is(actualCell.x, expectedCell.x)).toBe(true);
            expect(Object.is(actualCell.y, expectedCell.y)).toBe(true);
        }
    }
};

interface IEquivalenceCase {
    anchor: XY;
    attackerFactory: AttackerFactory;
    currentSmall: boolean;
    matrixFactory: MatrixFactory;
    targetSmall?: boolean;
}

const expectEquivalent = ({
    anchor,
    attackerFactory,
    currentSmall,
    matrixFactory,
    targetSmall = true,
}: IEquivalenceCase): XY[][] | undefined => {
    const legacyTrace: Trace = [];
    const fusedTrace: Trace = [];
    const legacyMatrix = matrixFactory(legacyTrace);
    const fusedMatrix = matrixFactory(fusedTrace);
    const legacyAttacker = attackerFactory(legacyTrace);
    const fusedAttacker = attackerFactory(fusedTrace);
    const expected = execute(() =>
        legacyBuildMeleeTargetLayers(
            { x: anchor.x, y: anchor.y },
            legacyMatrix,
            legacyAttacker,
            currentSmall,
            targetSmall,
        ),
    );
    const actual = execute(() =>
        buildMeleeTargetLayers({ x: anchor.x, y: anchor.y }, fusedMatrix, fusedAttacker, currentSmall, targetSmall),
    );

    expect(actual.kind).toBe(expected.kind);
    expect(fusedTrace).toEqual(legacyTrace);
    if (actual.kind === "throw" && expected.kind === "throw") {
        expect(normalizedError(actual.error)).toEqual(normalizedError(expected.error));
        return undefined;
    }
    if (actual.kind === "return" && expected.kind === "return") {
        expectCoordinateArraysToBeSameValue(actual.value, expected.value);
        return actual.value;
    }
    throw new Error("Outcome kinds differed after assertion");
};

const expectFirstLayerEquivalent = ({
    anchor,
    attackerFactory,
    currentSmall,
    matrixFactory,
    targetSmall = true,
}: IEquivalenceCase): XY[][] => {
    const expected = legacyBuildMeleeTargetLayers(
        { x: anchor.x, y: anchor.y },
        matrixFactory([]),
        attackerFactory([]),
        currentSmall,
        targetSmall,
    ).slice(0, 1);
    const actual = buildFirstMeleeTargetLayers(
        { x: anchor.x, y: anchor.y },
        matrixFactory([]),
        attackerFactory([]),
        currentSmall,
        targetSmall,
    );
    expectCoordinateArraysToBeSameValue(actual, expected);
    return actual;
};

const zeroMatrix = (height: number, width = height): number[][] =>
    Array.from({ length: height }, () => Array<number>(width).fill(0));

const matrixFromPattern = (
    height: number,
    width: number,
    pattern: "checker" | "obstacle" | "single" | "team" | "zero",
): number[][] => {
    const matrix = zeroMatrix(height, width);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (pattern === "obstacle") {
                matrix[y][x] = -1;
            } else if (pattern === "team") {
                matrix[y][x] = (x + y) % 2 === 0 ? 1 : 2;
            } else if (pattern === "checker") {
                matrix[y][x] = (x + y) % 2 === 0 ? 0 : -2;
            } else if (pattern === "single" && x === Math.floor(width / 2) && y === Math.floor(height / 2)) {
                matrix[y][x] = 2;
            }
        }
    }
    return matrix;
};

const makeLcg = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        return state;
    };
};

const expectEveryCellReferenceUnique = (layers: XY[][]): void => {
    const references = layers.flat();
    expect(new Set(references).size).toBe(references.length);
};

describe("buildMeleeTargetLayers legacy differential", () => {
    it("preserves the exact distance-one order, corner duplicates, and fresh references", () => {
        const matrix = zeroMatrix(16);
        const small = expectEquivalent({
            anchor: { x: 7, y: 7 },
            attackerFactory: attackerWithCells([]),
            currentSmall: true,
            matrixFactory: denseMatrixFactory(matrix),
        });
        const big = expectEquivalent({
            anchor: { x: 7, y: 7 },
            attackerFactory: attackerWithCells([]),
            currentSmall: false,
            matrixFactory: denseMatrixFactory(matrix),
        });

        expect(small?.[0]).toEqual([
            { x: 6, y: 6 },
            { x: 7, y: 6 },
            { x: 8, y: 6 },
            { x: 6, y: 8 },
            { x: 7, y: 8 },
            { x: 8, y: 8 },
            { x: 6, y: 6 },
            { x: 6, y: 7 },
            { x: 6, y: 8 },
            { x: 8, y: 6 },
            { x: 8, y: 7 },
            { x: 8, y: 8 },
        ]);
        expect(big?.[0]).toEqual([
            { x: 6, y: 6 },
            { x: 7, y: 6 },
            { x: 8, y: 6 },
            { x: 6, y: 9 },
            { x: 7, y: 9 },
            { x: 8, y: 9 },
            { x: 6, y: 6 },
            { x: 6, y: 7 },
            { x: 6, y: 8 },
            { x: 9, y: 6 },
            { x: 9, y: 7 },
            { x: 9, y: 8 },
            { x: 9, y: 9 },
        ]);
        expectEveryCellReferenceUnique(small ?? []);
        expectEveryCellReferenceUnique(big ?? []);
        expect(small?.[0][0]).not.toBe(small?.[0][6]);
        expect(big?.[0][0]).not.toBe(big?.[0][6]);
    });

    it("matches every target anchor on the production 16x16 grid for both attacker sizes", () => {
        const patterns = [
            matrixFromPattern(16, 16, "zero"),
            matrixFromPattern(16, 16, "checker"),
            matrixFromPattern(16, 16, "single"),
        ];
        let cases = 0;
        for (const matrix of patterns) {
            for (let y = 0; y < 16; y++) {
                for (let x = 0; x < 16; x++) {
                    for (const currentSmall of [true, false]) {
                        expectEquivalent({
                            anchor: { x, y },
                            attackerFactory: freshAttackerWithCells([
                                { x: 0, y: 0 },
                                { x: 1, y: 0 },
                                { x: 0, y: 1 },
                                { x: 1, y: 1 },
                            ]),
                            currentSmall,
                            matrixFactory: denseMatrixFactory(matrix),
                        });
                        cases++;
                    }
                }
            }
        }
        expect(cases).toBe(1_536);
    });

    it("matches dimensions 1..17, odd layer cutoffs, edges, and outside anchors", () => {
        const patterns = ["zero", "obstacle", "team", "checker", "single"] as const;
        let cases = 0;
        for (let dimension = 1; dimension <= 17; dimension++) {
            const width = 18 - dimension;
            const anchors = [
                { x: 0, y: 0 },
                { x: width - 1, y: dimension - 1 },
                { x: Math.floor(width / 2), y: Math.floor(dimension / 2) },
                { x: -2, y: -1 },
                { x: width + 1, y: dimension + 2 },
            ];
            for (const pattern of patterns) {
                const matrix = matrixFromPattern(dimension, width, pattern);
                for (const anchor of anchors) {
                    for (const currentSmall of [true, false]) {
                        expectEquivalent({
                            anchor,
                            attackerFactory: freshAttackerWithCells([
                                { x: 0, y: 0 },
                                { x: Math.max(0, width - 1), y: Math.max(0, dimension - 1) },
                            ]),
                            currentSmall,
                            matrixFactory: denseMatrixFactory(matrix),
                        });
                        cases++;
                    }
                }
            }
        }
        expect(cases).toBe(850);
    });

    it("matches 4096 seeded dense production-value matrices", () => {
        const random = makeLcg(0xa13_5eed);
        const productionValues = [-4, -3, -2, -1, 0, 1, 2] as const;
        for (let caseIndex = 0; caseIndex < 4_096; caseIndex++) {
            const matrix = zeroMatrix(16);
            for (let y = 0; y < 16; y++) {
                for (let x = 0; x < 16; x++) {
                    // Keep most cells empty, as production boards are sparse, but
                    // exercise every legal encoded matrix value.
                    const roll = random() % 10;
                    matrix[y][x] = roll < 6 ? 0 : productionValues[random() % productionValues.length];
                }
            }
            const occupiedCells = [
                { x: random() % 16, y: random() % 16 },
                { x: random() % 16, y: random() % 16 },
                { x: random() % 16, y: random() % 16 },
                { x: random() % 16, y: random() % 16 },
            ];
            expectEquivalent({
                anchor: { x: (random() % 22) - 3, y: (random() % 22) - 3 },
                attackerFactory: freshAttackerWithCells(occupiedCells),
                currentSmall: (random() & 1) === 0,
                matrixFactory: denseMatrixFactory(matrix),
                targetSmall: (random() & 3) !== 0,
            });
        }
    });

    it("matches ragged, sparse, malformed, NaN, undefined, and custom-value matrices", () => {
        const factories: MatrixFactory[] = [
            () => [],
            () => Array<number[]>(4),
            () => [[], [0], [0, 0, 0], []],
            () => [[0, 0, 0], [], [0], [0, 0]],
            () => {
                const matrix = zeroMatrix(6, 6);
                delete matrix[2];
                return matrix;
            },
            () => {
                const matrix = zeroMatrix(6, 6);
                delete matrix[3][2];
                return matrix;
            },
            () =>
                [
                    [0, -0, Number.NaN, Number.POSITIVE_INFINITY],
                    [Number.NEGATIVE_INFINITY, undefined, 0, 1],
                    [0, 0, 0, 0],
                    [0, 0, 0, 0],
                ] as unknown as number[][],
            (trace) => {
                const looseZero = {
                    valueOf: () => {
                        trace.push("valueOf:zero");
                        return 0;
                    },
                };
                const looseOne = {
                    valueOf: () => {
                        trace.push("valueOf:one");
                        return 1;
                    },
                };
                return [
                    [0, looseZero, looseOne, false],
                    ["", "0", "1", null],
                    [undefined, Number.NaN, 0, 0],
                    [0, 0, 0, 0],
                ] as unknown as number[][];
            },
        ];
        const anchors: XY[] = [
            { x: 0, y: 0 },
            { x: 2, y: 2 },
            { x: -1, y: 1 },
            { x: Number.NaN, y: 1 },
            { x: 1, y: Number.NaN },
            { x: Number.POSITIVE_INFINITY, y: Number.NEGATIVE_INFINITY },
            { x: -0, y: -0 },
            { x: 1.5, y: 2.5 },
        ];
        let cases = 0;
        for (const matrixFactory of factories) {
            for (const anchor of anchors) {
                for (const currentSmall of [true, false]) {
                    expectEquivalent({
                        anchor,
                        attackerFactory: freshAttackerWithCells([
                            { x: 0, y: 0 },
                            { x: Number.NaN, y: Number.NaN },
                        ]),
                        currentSmall,
                        matrixFactory,
                    });
                    cases++;
                }
            }
        }
        expect(cases).toBe(128);
    });

    it("preserves proxy-backed matrix lookup and bounds-access order", () => {
        const proxyMatrix: MatrixFactory = (trace) => {
            const rows = matrixFromPattern(6, 6, "checker").map(
                (row, rowIndex) =>
                    new Proxy(row, {
                        get(target, property, receiver): unknown {
                            trace.push(`row:${rowIndex}:get:${String(property)}`);
                            return Reflect.get(target, property, receiver);
                        },
                        has(target, property): boolean {
                            trace.push(`row:${rowIndex}:has:${String(property)}`);
                            return Reflect.has(target, property);
                        },
                    }),
            );
            return new Proxy(rows, {
                get(target, property, receiver): unknown {
                    trace.push(`matrix:get:${String(property)}`);
                    return Reflect.get(target, property, receiver);
                },
                has(target, property): boolean {
                    trace.push(`matrix:has:${String(property)}`);
                    return Reflect.has(target, property);
                },
            });
        };

        for (const currentSmall of [true, false]) {
            expectEquivalent({
                anchor: { x: 2, y: 2 },
                attackerFactory: freshAttackerWithCells([
                    { x: 1, y: 1 },
                    { x: 2, y: 2 },
                ]),
                currentSmall,
                matrixFactory: proxyMatrix,
            });
        }
    });

    it("preserves repeated getCells calls and getter access order", () => {
        const statefulAttacker: AttackerFactory = (trace) => {
            let calls = 0;
            return {
                getCells: () => {
                    calls++;
                    trace.push(`getCells:${calls}`);
                    const cells = [
                        { x: calls % 3, y: (calls + 1) % 3 },
                        { x: 2, y: 2 },
                    ];
                    return cells.map((cell, index) => ({
                        get x(): number {
                            trace.push(`cell:${calls}:${index}:x`);
                            return cell.x;
                        },
                        get y(): number {
                            trace.push(`cell:${calls}:${index}:y`);
                            return cell.y;
                        },
                    }));
                },
            } as unknown as IUnitAIRepr;
        };

        for (const currentSmall of [true, false]) {
            expectEquivalent({
                anchor: { x: 1, y: 1 },
                attackerFactory: statefulAttacker,
                currentSmall,
                matrixFactory: denseMatrixFactory(matrixFromPattern(6, 6, "team")),
            });
        }
    });

    it("preserves thrown getCells calls and native malformed-matrix exceptions", () => {
        const throwingAttacker = (throwOnCall: number): AttackerFactory => {
            return (trace) => {
                let calls = 0;
                return {
                    getCells: () => {
                        calls++;
                        trace.push(`getCells:${calls}`);
                        if (calls === throwOnCall) {
                            throw new RangeError(`getCells failed on call ${calls}`);
                        }
                        return [{ x: calls % 4, y: Math.floor(calls / 4) }];
                    },
                } as unknown as IUnitAIRepr;
            };
        };

        for (const throwOnCall of [1, 2, 5, 17, 41]) {
            expectEquivalent({
                anchor: { x: 2, y: 2 },
                attackerFactory: throwingAttacker(throwOnCall),
                currentSmall: throwOnCall % 2 === 0,
                matrixFactory: denseMatrixFactory(matrixFromPattern(8, 8, "team")),
            });
        }

        expectEquivalent({
            anchor: { x: 0, y: 0 },
            attackerFactory: attackerWithCells([]),
            currentSmall: true,
            matrixFactory: () => Array<number[]>(4),
        });
    });

    it("performs eager side effects before returning [] for a large target", () => {
        const countingAttacker: AttackerFactory = (trace) =>
            ({
                getCells: () => {
                    trace.push("getCells");
                    return [{ x: 2, y: 2 }];
                },
            }) as unknown as IUnitAIRepr;

        const result = expectEquivalent({
            anchor: { x: 2, y: 2 },
            attackerFactory: countingAttacker,
            currentSmall: false,
            matrixFactory: denseMatrixFactory(matrixFromPattern(8, 8, "team")),
            targetSmall: false,
        });
        expect(result).toEqual([]);
    });

    it("returns deeply fresh output whose cells do not alias inputs or later calls", () => {
        const anchor = { x: 7, y: 7 };
        const matrix = zeroMatrix(16);
        const attackerCells = [{ x: 1, y: 1 }];
        const attacker = attackerWithCells(attackerCells)([]);
        const first = buildMeleeTargetLayers(anchor, matrix, attacker, true, true);
        const second = buildMeleeTargetLayers(anchor, matrix, attacker, true, true);
        const firstSnapshot = first.map((layer) => layer.map((cell) => ({ ...cell })));
        const secondSnapshot = second.map((layer) => layer.map((cell) => ({ ...cell })));

        expectCoordinateArraysToBeSameValue(first, second);
        expect(first).not.toBe(second);
        expect(first[0]).not.toBe(second[0]);
        expect(first[0][0]).not.toBe(second[0][0]);
        expect(first[0][0]).not.toBe(anchor);
        expect(first[0][0]).not.toBe(attackerCells[0]);
        expectEveryCellReferenceUnique(first);
        expectEveryCellReferenceUnique(second);

        anchor.x = -500;
        anchor.y = 500;
        matrix[0][0] = 2;
        attackerCells[0].x = 15;
        attackerCells[0].y = 15;
        expect(first).toEqual(firstSnapshot);
        expect(second).toEqual(secondSnapshot);

        const untouchedSecond = { ...second[0][0] };
        first[0][0].x = 9_999;
        first[0][0].y = -9_999;
        first[0].push({ x: 123, y: 456 });
        expect(second[0][0]).toEqual(untouchedSecond);
        expect(second[0].some((cell) => cell.x === 123 && cell.y === 456)).toBe(false);
    });
});

describe("buildFirstMeleeTargetLayers legacy differential", () => {
    it("distinguishes a missing distance-one layer from a present but fully blocked layer", () => {
        expectFirstLayerEquivalent({
            anchor: { x: 0, y: 0 },
            attackerFactory: freshAttackerWithCells([]),
            currentSmall: true,
            matrixFactory: denseMatrixFactory([]),
        });
        expect(buildFirstMeleeTargetLayers({ x: 0, y: 0 }, [], freshAttackerWithCells([])([]))).toEqual([]);

        const blocked = matrixFromPattern(16, 16, "obstacle");
        const blockedResult = expectFirstLayerEquivalent({
            anchor: { x: 7, y: 7 },
            attackerFactory: freshAttackerWithCells([]),
            currentSmall: true,
            matrixFactory: denseMatrixFactory(blocked),
        });
        expect(blockedResult).toEqual([[]]);
    });

    it("matches the legacy first layer at every production anchor across attacker sizes and matrix families", () => {
        const patterns = ["zero", "checker", "single", "team", "obstacle"] as const;
        let cases = 0;
        for (const pattern of patterns) {
            const matrix = matrixFromPattern(16, 16, pattern);
            for (let y = 0; y < 16; y++) {
                for (let x = 0; x < 16; x++) {
                    for (const currentSmall of [true, false]) {
                        expectFirstLayerEquivalent({
                            anchor: { x, y },
                            attackerFactory: freshAttackerWithCells([
                                { x: 0, y: 0 },
                                { x: 1, y: 0 },
                                { x: 0, y: 1 },
                                { x: 1, y: 1 },
                            ]),
                            currentSmall,
                            matrixFactory: denseMatrixFactory(matrix),
                        });
                        cases++;
                    }
                }
            }
        }
        expect(cases).toBe(2_560);
    });

    it("matches dimensions 1..17, odd cutoffs, rectangular boards, edges, and outside anchors", () => {
        const patterns = ["zero", "obstacle", "team", "checker", "single"] as const;
        let cases = 0;
        for (let dimension = 1; dimension <= 17; dimension++) {
            const width = 18 - dimension;
            const anchors = [
                { x: 0, y: 0 },
                { x: width - 1, y: dimension - 1 },
                { x: Math.floor(width / 2), y: Math.floor(dimension / 2) },
                { x: -2, y: -1 },
                { x: width + 1, y: dimension + 2 },
            ];
            for (const pattern of patterns) {
                const matrix = matrixFromPattern(dimension, width, pattern);
                for (const anchor of anchors) {
                    for (const currentSmall of [true, false]) {
                        for (const targetSmall of [true, false]) {
                            expectFirstLayerEquivalent({
                                anchor,
                                attackerFactory: freshAttackerWithCells([
                                    { x: 0, y: 0 },
                                    { x: Math.max(0, width - 1), y: Math.max(0, dimension - 1) },
                                ]),
                                currentSmall,
                                matrixFactory: denseMatrixFactory(matrix),
                                targetSmall,
                            });
                            cases++;
                        }
                    }
                }
            }
        }
        expect(cases).toBe(1_700);
    });

    it("matches 4096 seeded production-value boards and owns every emitted object", () => {
        const random = makeLcg(0xa13_f1a5);
        for (let caseIndex = 0; caseIndex < 4_096; caseIndex++) {
            const matrix = zeroMatrix(16);
            for (let y = 0; y < 16; y++) {
                for (let x = 0; x < 16; x++) {
                    const roll = random() % 10;
                    matrix[y][x] = roll < 6 ? 0 : [-4, -3, -2, -1, 1, 2][random() % 6];
                }
            }
            const actual = expectFirstLayerEquivalent({
                anchor: { x: (random() % 22) - 3, y: (random() % 22) - 3 },
                attackerFactory: freshAttackerWithCells([
                    { x: random() % 16, y: random() % 16 },
                    { x: random() % 16, y: random() % 16 },
                    { x: random() % 16, y: random() % 16 },
                    { x: random() % 16, y: random() % 16 },
                ]),
                currentSmall: (random() & 1) === 0,
                matrixFactory: denseMatrixFactory(matrix),
            });
            expectEveryCellReferenceUnique(actual);
        }

        const matrix = zeroMatrix(16);
        const attacker = freshAttackerWithCells([{ x: 1, y: 1 }])([]);
        const first = buildFirstMeleeTargetLayers({ x: 7, y: 7 }, matrix, attacker, true, true);
        const second = buildFirstMeleeTargetLayers({ x: 7, y: 7 }, matrix, attacker, true, true);
        expect(first).not.toBe(second);
        expect(first[0]).not.toBe(second[0]);
        expect(first[0][0]).not.toBe(second[0][0]);
        const secondSnapshot = structuredClone(second);
        first[0][0].x = 99;
        first[0].push({ x: 100, y: 100 });
        expect(second).toEqual(secondSnapshot);
    });
});
