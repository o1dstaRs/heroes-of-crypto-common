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

import { roundUnitStat, type UnitStatFractionDigits } from "../../src/units/stat_rounding";

function legacyRoundUnitStat(value: number, fractionDigits: UnitStatFractionDigits): number {
    return Number(value.toFixed(fractionDigits));
}

function expectExactLegacyResult(value: number, fractionDigits: UnitStatFractionDigits): void {
    expect(Object.is(roundUnitStat(value, fractionDigits), legacyRoundUnitStat(value, fractionDigits))).toBe(true);
}

const floatBuffer = new ArrayBuffer(8);
const floatView = new DataView(floatBuffer);

function floatBits(value: number): bigint {
    floatView.setFloat64(0, value);
    return floatView.getBigUint64(0);
}

function floatFromBits(bits: bigint): number {
    floatView.setBigUint64(0, bits);
    return floatView.getFloat64(0);
}

function nextUp(value: number): number {
    if (Number.isNaN(value) || value === Number.POSITIVE_INFINITY) {
        return value;
    }
    if (value === 0) {
        return Number.MIN_VALUE;
    }
    const bits = floatBits(value);
    return floatFromBits(value > 0 ? bits + 1n : bits - 1n);
}

function nextDown(value: number): number {
    if (Number.isNaN(value) || value === Number.NEGATIVE_INFINITY) {
        return value;
    }
    if (value === 0) {
        return -Number.MIN_VALUE;
    }
    const bits = floatBits(value);
    return floatFromBits(value > 0 ? bits - 1n : bits + 1n);
}

describe("roundUnitStat", () => {
    it("matches native numeric toFixed conversion at IEEE and decimal boundaries", () => {
        const values = [
            0,
            -0,
            Number.MIN_VALUE,
            -Number.MIN_VALUE,
            2 ** -1022,
            -(2 ** -1022),
            Number.MAX_VALUE,
            -Number.MAX_VALUE,
            Number.MAX_SAFE_INTEGER,
            -Number.MAX_SAFE_INTEGER,
            Number.NaN,
            Number.POSITIVE_INFINITY,
            Number.NEGATIVE_INFINITY,
            0.1,
            -0.1,
            2.9,
            6.3,
            7.75,
            44,
            1.005,
            -1.005,
            2.675,
            -2.675,
            1.25,
            -1.25,
            0.05,
            -0.05,
            0.005,
            -0.005,
            -226801603510430.12,
            -776169524486.2999,
            2251799813685249 / 4,
            562949953421313 / 8,
            1e21,
            -1e21,
            nextDown(1e21),
            nextUp(1e21),
            nextDown(-1e21),
            nextUp(-1e21),
        ];

        for (const value of [...values]) {
            if (Number.isFinite(value)) {
                values.push(nextDown(value), nextUp(value));
            }
        }

        for (const value of values) {
            expectExactLegacyResult(value, 1);
            expectExactLegacyResult(value, 2);
        }
    });

    it("matches native conversion around exact one- and two-decimal grid values", () => {
        for (let scaled = -100_000; scaled <= 100_000; scaled += 37) {
            for (const scale of [10, 100] as const) {
                const value = scaled / scale;
                const fractionDigits: UnitStatFractionDigits = scale === 10 ? 1 : 2;
                expectExactLegacyResult(nextDown(value), fractionDigits);
                expectExactLegacyResult(value, fractionDigits);
                expectExactLegacyResult(nextUp(value), fractionDigits);
            }
        }
    });

    it("matches native conversion around the guarded near-grid boundary", () => {
        const offsets = [
            -0.5,
            nextUp(-0.5),
            nextDown(-0.25),
            -0.25,
            nextUp(-0.25),
            -Number.EPSILON,
            0,
            Number.EPSILON,
            nextDown(0.25),
            0.25,
            nextUp(0.25),
            nextDown(0.5),
            0.5,
        ];
        const scaledIntegers = [
            -(2 ** 30),
            -(2 ** 30) + 1,
            -1_000_003,
            -(2 ** 24) - 1,
            -(2 ** 24) + 1,
            -101,
            -29,
            -3,
            -1,
            0,
            1,
            3,
            29,
            101,
            2 ** 24 - 1,
            2 ** 24 + 1,
            1_000_003,
            2 ** 30 - 1,
            2 ** 30,
            2 ** 31 - 1,
        ];

        for (const scale of [10, 100] as const) {
            const fractionDigits: UnitStatFractionDigits = scale === 10 ? 1 : 2;
            for (const scaledInteger of scaledIntegers) {
                for (const offset of offsets) {
                    const value = (scaledInteger + offset) / scale;
                    expectExactLegacyResult(nextDown(value), fractionDigits);
                    expectExactLegacyResult(value, fractionDigits);
                    expectExactLegacyResult(nextUp(value), fractionDigits);
                }
            }
        }

        for (const value of [-(0.1 + 0.2), -0.006, -0.004, -Number.MIN_VALUE]) {
            for (const fractionDigits of [1, 2] as const) {
                expectExactLegacyResult(value, fractionDigits);
                expect(Object.is(roundUnitStat(value, fractionDigits), -0)).toBe(
                    Object.is(legacyRoundUnitStat(value, fractionDigits), -0),
                );
            }
        }
    });

    it("matches native conversion over deterministic near-grid int32 values", () => {
        const offsets = [-0.500001, -0.499999, -0.250001, -0.249999, 0, 0.249999, 0.250001, 0.499999, 0.500001];
        let state = 0x6d2b79f5;

        for (let i = 0; i < 50_000; i++) {
            state = (state * 1_664_525 + 1_013_904_223) >>> 0;
            const scaledInteger = (state % (2 ** 31 - 1)) - (2 ** 30 - 1);
            const offset = offsets[state % offsets.length];

            for (const scale of [10, 100] as const) {
                const fractionDigits: UnitStatFractionDigits = scale === 10 ? 1 : 2;
                const value = (scaledInteger + offset) / scale;
                expectExactLegacyResult(nextDown(value), fractionDigits);
                expectExactLegacyResult(value, fractionDigits);
                expectExactLegacyResult(nextUp(value), fractionDigits);
            }
        }
    });

    it("matches native conversion over deterministic raw binary64 patterns", () => {
        let state = 0x9e3779b97f4a7c15n;
        const mask = (1n << 64n) - 1n;

        for (let i = 0; i < 500_000; i++) {
            state ^= state << 13n;
            state ^= state >> 7n;
            state ^= state << 17n;
            state &= mask;
            const value = floatFromBits(state);
            expectExactLegacyResult(value, 1);
            expectExactLegacyResult(value, 2);
        }
    });

    it("preserves a replaced toFixed lookup, receiver, result, and failure", () => {
        const originalDescriptor = Object.getOwnPropertyDescriptor(Number.prototype, "toFixed");
        expect(originalDescriptor).toBeDefined();
        const nearGridValue = 15.000000000000002;

        try {
            let gets = 0;
            let calls = 0;
            let receiverMatches = false;
            Object.defineProperty(Number.prototype, "toFixed", {
                configurable: true,
                get() {
                    gets++;
                    return function (this: unknown, fractionDigits: number): string {
                        "use strict";
                        calls++;
                        receiverMatches = this === nearGridValue;
                        return fractionDigits === 1 ? "7.7" : "7.77";
                    };
                },
            });

            expect(roundUnitStat(nearGridValue, 1)).toBe(7.7);
            expect(gets).toBe(1);
            expect(calls).toBe(1);
            expect(receiverMatches).toBe(true);

            Object.defineProperty(Number.prototype, "toFixed", {
                configurable: true,
                value: 42,
            });
            expect(() => roundUnitStat(nearGridValue, 1)).toThrow(TypeError);
        } finally {
            if (originalDescriptor) {
                Object.defineProperty(Number.prototype, "toFixed", originalDescriptor);
            }
        }
    });

    it("preserves Number-before-argument evaluation order and unsupported runtime digits", () => {
        const originalNumber = globalThis.Number;
        const originalDescriptor = Object.getOwnPropertyDescriptor(Number.prototype, "toFixed");
        expect(originalDescriptor).toBeDefined();

        try {
            Object.defineProperty(Number.prototype, "toFixed", {
                configurable: true,
                get() {
                    globalThis.Number = (() => 123) as unknown as NumberConstructor;
                    return function (): string {
                        return "7.7";
                    };
                },
            });

            const result = roundUnitStat(1.2, 1);
            globalThis.Number = originalNumber;
            if (originalDescriptor) {
                Object.defineProperty(Number.prototype, "toFixed", originalDescriptor);
            }
            expect(result).toBe(7.7);

            const runtimeRound = roundUnitStat as (value: number, fractionDigits: number) => number;
            expect(Object.is(runtimeRound(1.25, 0), Number((1.25).toFixed(0)))).toBe(true);
            expect(() => runtimeRound(1.25, 101)).toThrow(RangeError);
        } finally {
            globalThis.Number = originalNumber;
            if (originalDescriptor) {
                Object.defineProperty(Number.prototype, "toFixed", originalDescriptor);
            }
        }
    });

    it("does not introduce observable Math calls on exact- or near-grid fast paths", () => {
        const originalAbs = Math.abs;
        try {
            Math.abs = () => {
                throw new Error("unexpected Math.abs call");
            };
            expect(roundUnitStat(6.3, 1)).toBe(6.3);
            expect(roundUnitStat(7.75, 2)).toBe(7.75);
            expect(roundUnitStat(0.1 + 0.2, 1)).toBe(0.3);
            expect(roundUnitStat(44 * 1.15, 2)).toBe(50.6);
        } finally {
            Math.abs = originalAbs;
        }
    });

    it("falls back before coercing a boxed Number value", () => {
        class StrictNumber extends Number {
            public override valueOf(): number {
                throw new Error("unexpected numeric coercion");
            }
        }

        const boxed = new StrictNumber(1.2);
        const runtimeRound = roundUnitStat as unknown as (
            value: unknown,
            fractionDigits: UnitStatFractionDigits,
        ) => number;
        expect(runtimeRound(boxed, 1)).toBe(Number(boxed.toFixed(1)));
    });
});
