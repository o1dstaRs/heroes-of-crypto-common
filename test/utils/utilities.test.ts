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

import { AbilityFactory } from "../../src/abilities/ability_factory";
import { EffectFactory } from "../../src/effects/effect_factory";
import { GridSettings } from "../../src/grid/grid_settings";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import {
    ChaosSynergy,
    getChaosSynergyByName,
    getLifeSynergyByName,
    getMightSynergyByName,
    getNatureSynergyByName,
    LifeSynergy,
    MightSynergy,
    NatureSynergy,
} from "../../src/synergies/synergy_properties";
import {
    base64ToUint8Array,
    createSecureUuid,
    getLapString,
    getRandomInt,
    interval,
    isBrowser,
    isDeterministicRandomActive,
    matrixElement,
    RefNumber,
    removeItemOnce,
    setDeterministicRandomSource,
    shuffle,
    stringToBoolean,
    uuidFromBytes,
    uuidToUint8Array,
} from "../../src/utils/lib";
import {
    asc,
    getDistance,
    intersect2D,
    matrixElementOrDefault,
    mean,
    minus,
    perpDot,
    q25,
    q50,
    q75,
    q90,
    quantile,
    std,
    sum,
    updateMatrixElementIfExists,
    winningAtLeastOneEventProbability,
} from "../../src/utils/math";

describe("utility functions", () => {
    const withCryptoMock = (cryptoMock: object | undefined, fn: () => void): void => {
        const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
        if (cryptoMock) {
            Object.defineProperty(globalThis, "crypto", {
                configurable: true,
                value: cryptoMock,
            });
        } else {
            Reflect.deleteProperty(globalThis, "crypto");
        }

        try {
            fn();
        } finally {
            if (originalDescriptor) {
                Object.defineProperty(globalThis, "crypto", originalDescriptor);
            } else {
                Reflect.deleteProperty(globalThis, "crypto");
            }
        }
    };

    it("covers collection, UUID, base64, and ref-number helpers", () => {
        const values = [3, 1, 2];
        const ref = new RefNumber(5);
        const uuid = "00112233-4455-6677-8899-aabbccddeeff";
        const bytes = uuidToUint8Array(uuid);

        expect(shuffle(values).sort()).toEqual([1, 2, 3]);
        expect(matrixElement([[1, 2]], 1, 0)).toBe(2);
        expect(matrixElement([[1, 2]], 3, 0)).toBe(0);
        expect(stringToBoolean("true")).toBe(true);
        expect(stringToBoolean("1")).toBe(true);
        expect(stringToBoolean("false")).toBe(false);
        expect(stringToBoolean(undefined)).toBe(false);

        const removable = ["a", "b", "c"];
        expect(removeItemOnce(removable, "b")).toBe(true);
        expect(removeItemOnce(removable, "x")).toBe(false);
        expect(removable).toEqual(["a", "c"]);

        expect(isBrowser()).toBe(false);
        expect(bytes).toHaveLength(16);
        expect(uuidFromBytes(bytes)).toBe(uuid);
        expect(() => uuidToUint8Array("bad")).toThrow("Invalid UUID format");
        expect(() => uuidToUint8Array("zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz")).toThrow("Invalid UUID format");
        expect(() => uuidFromBytes(new Uint8Array(1))).toThrow("Buffer must be 16 bytes long");
        expect(Array.from(base64ToUint8Array("aG9j"))).toEqual([104, 111, 99]);

        expect(ref.getValue()).toBe(5);
        ref.increment();
        ref.increment(4);
        ref.decrement(3);
        ref.reset(9);
        expect(ref.getValue()).toBe(9);
        expect(getLapString(1)).toBe("1 lap");
        expect(getLapString(2)).toBe("2 laps");
    });

    it("covers numeric helpers and line intersections", () => {
        const matrix = [
            [1, 2],
            [3, 4],
        ];

        expect(getDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
        expect(minus({ x: 5, y: 3 }, { x: 2, y: 1 })).toEqual({ x: 3, y: 2 });
        expect(perpDot({ x: 1, y: 2 }, { x: 3, y: 4 })).toBe(-2);
        expect(matrixElementOrDefault(matrix, 1, 1, -1)).toBe(4);
        expect(matrixElementOrDefault(matrix, 3, 1, -1)).toBe(-1);
        updateMatrixElementIfExists(matrix, 0, 1, 5);
        updateMatrixElementIfExists(matrix, 5, 5, 5);
        expect(matrix[1][0]).toBe(8);

        expect(intersect2D({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: -1 }, { x: 5, y: 1 }).x).toBe(5);
        expect(intersect2D({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 1 }, { x: 10, y: 1 }).x).toBeUndefined();
        expect(intersect2D({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 }, { x: 15, y: 0 }).x).toBeUndefined();

        expect(asc([3, 1, 2])).toEqual([1, 2, 3]);
        expect(sum([1, 2, 3])).toBe(6);
        expect(mean([1, 2, 3])).toBe(2);
        expect(std([1, 2, 3])).toBe(1);
        expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
        expect(q25([1, 2, 3, 4])).toBe(1.75);
        expect(q50([1, 2, 3, 4])).toBe(2.5);
        expect(q75([1, 2, 3, 4])).toBe(3.25);
        expect(q90([1, 2, 3, 4])).toBe(3.7);
        expect(winningAtLeastOneEventProbability([0.5, 0.5])).toBe(0.75);
        expect(() => winningAtLeastOneEventProbability([1.5])).toThrow("Probability must be between 0 and 1");
    });

    it("covers settings, synergy mappers, mocks, and factory fallback paths", () => {
        const settings = new GridSettings(16, 2048, 0, 1024, -1024, 5, 0.06);
        const sceneLog = new SceneLogMock();
        const effectFactory = new EffectFactory();
        const abilityFactory = new AbilityFactory(effectFactory);

        expect(settings.getGridSize()).toBe(16);
        expect(settings.getStep()).toBe(128);
        expect(settings.getHalfStep()).toBe(64);
        expect(settings.getQuarterStep()).toBe(32);
        expect(settings.getTwoSteps()).toBe(256);
        expect(settings.getFourSteps()).toBe(512);
        expect(settings.getDiagonalStep()).toBeGreaterThan(180);
        expect(settings.getMovementDelta()).toBe(5);
        expect(settings.getUnitSizeDelta()).toBe(0.06);
        expect(settings.getUnitSize()).toBeCloseTo(63.94);
        expect(settings.getMaxY()).toBe(2048);
        expect(settings.getMinY()).toBe(0);
        expect(settings.getMaxX()).toBe(1024);
        expect(settings.getMinX()).toBe(-1024);
        expect(settings.getCellSize()).toBe(128);

        expect(getLifeSynergyByName("PLUS_SUPPLY_PERCENTAGE")).toBe(LifeSynergy.PLUS_SUPPLY_PERCENTAGE);
        expect(getChaosSynergyByName("BREAK_ON_ATTACK")).toBe(ChaosSynergy.BREAK_ON_ATTACK);
        expect(getMightSynergyByName("PLUS_STACK_ABILITIES_POWER")).toBe(MightSynergy.PLUS_STACK_ABILITIES_POWER);
        expect(getNatureSynergyByName("PLUS_FLY_ARMOR")).toBe(NatureSynergy.PLUS_FLY_ARMOR);

        expect(sceneLog.getLog()).toBe("");
        expect(sceneLog.hasBeenUpdated()).toBe(false);
        expect(sceneLog.updateLog("ignored")).toBeUndefined();

        expect(effectFactory.makeEffect(null)).toBeUndefined();
        expect(effectFactory.makeEffect("missing")).toBeUndefined();
        expect(effectFactory.makeEffect("Stun")?.getName()).toBe("Stun");
        expect(effectFactory.makeAuraEffect(null)).toBeUndefined();
        expect(effectFactory.makeAuraEffect("missing")).toBeUndefined();
        expect(effectFactory.makeAuraEffect("Luck")?.getName()).toBe("Luck");
        expect(abilityFactory.getEffectsFactory()).toBe(effectFactory);
        expect(abilityFactory.makeAbility("Resurrection").getSpell()?.getName()).toBe("Resurrection");
    });

    it("fails closed when crypto-secure random values are unavailable", () => {
        withCryptoMock(undefined, () => {
            expect(() => getRandomInt(0, 2)).toThrow("Crypto-secure random values are unavailable in this runtime");
            expect(createSecureUuid).toThrow("Crypto-secure UUID generation is unavailable in this runtime");
        });
    });

    it("uses unbiased secure random integers and validates safe ranges", () => {
        withCryptoMock(
            {
                getRandomValues<T extends ArrayBufferView>(array: T): T {
                    const values = new Uint32Array(
                        array.buffer,
                        array.byteOffset,
                        array.byteLength / Uint32Array.BYTES_PER_ELEMENT,
                    );
                    values[0] = 0;
                    values[1] = 5;
                    return array;
                },
            },
            () => {
                expect(getRandomInt(10, 13)).toBe(12);
                expect(getRandomInt(7, 7)).toBe(7);
                expect(getRandomInt(7, 8)).toBe(7);
                expect(() => getRandomInt(0.5, 2)).toThrow("min/max must be safe integers");
                expect(() => getRandomInt(Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 2)).toThrow(
                    "min/max must be safe integers",
                );
                expect(() => getRandomInt(-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toThrow(
                    "range must contain at most 2^53 possible values",
                );
                expect(() => getRandomInt(5, 4)).toThrow("max must be >= min");
            },
        );
    });

    it("uses an installed deterministic source (simulation/tests) and clears back to crypto", () => {
        expect(isDeterministicRandomActive()).toBe(false);
        try {
            // A constant 0 source always lands on the low end of [min, max).
            setDeterministicRandomSource(() => 0);
            expect(isDeterministicRandomActive()).toBe(true);
            expect(getRandomInt(10, 20)).toBe(10);
            expect(getRandomInt(7, 7)).toBe(7); // max === min short-circuits
            expect(getRandomInt(7, 8)).toBe(7); // span === 1 short-circuits

            // Out-of-range inputs are clamped into [0, 1) and never overflow max (the result stays < max).
            setDeterministicRandomSource(() => 1.5); // clamped to just below 1
            const high = getRandomInt(0, 4);
            expect(high).toBeGreaterThanOrEqual(0);
            expect(high).toBeLessThan(4);
            setDeterministicRandomSource(() => -2); // out-of-range low is clamped to 0 -> the minimum
            expect(getRandomInt(0, 4)).toBe(0);

            // Same seed reproduces the same sequence (the property the optimizer relies on).
            const seeded = (): (() => number) => {
                let s = 12345 >>> 0;
                return () => {
                    s = (s + 0x6d2b79f5) >>> 0;
                    let t = s;
                    t = Math.imul(t ^ (t >>> 15), t | 1);
                    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
                    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
                };
            };
            setDeterministicRandomSource(seeded());
            const first = Array.from({ length: 8 }, () => getRandomInt(0, 1000));
            setDeterministicRandomSource(seeded());
            const second = Array.from({ length: 8 }, () => getRandomInt(0, 1000));
            expect(second).toEqual(first);
        } finally {
            setDeterministicRandomSource(undefined);
        }
        expect(isDeterministicRandomActive()).toBe(false);
        // With the source cleared, the secure path is back in force (fails closed without crypto).
        withCryptoMock(undefined, () => {
            expect(() => getRandomInt(0, 2)).toThrow("Crypto-secure random values are unavailable in this runtime");
        });
    });

    it("seeded getRandomInt has full low-bit entropy (small ranges are not stuck)", () => {
        // Regression: the seeded mulberry32 source yields 32-bit floats; nextRaw53 must spread those into a
        // full 53-bit value with random LOW bits. A prior `floor(r * 2^53)` left the low 21 bits always 0, so
        // getRandomInt(0, 2) returned the low bit -> ALWAYS 0. That silently rigged every coin flip in the
        // sim (e.g. the turn-order morale-tie, making LOWER/green always move first -> a spurious ~57/43 side
        // bias). Production (crypto path) was never affected. Guard small-range uniformity here.
        try {
            let s = 0xc0ffee >>> 0;
            const seeded = () => {
                s = (s + 0x6d2b79f5) >>> 0;
                let t = s;
                t = Math.imul(t ^ (t >>> 15), t | 1);
                t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            };
            setDeterministicRandomSource(seeded);
            let zeros = 0;
            let ones = 0;
            for (let i = 0; i < 2000; i += 1) {
                const v = getRandomInt(0, 2);
                expect(v === 0 || v === 1).toBe(true);
                if (v === 0) zeros += 1;
                else ones += 1;
            }
            // Both outcomes must appear and be roughly balanced (would be 2000/0 with the old bug).
            expect(zeros).toBeGreaterThan(700);
            expect(ones).toBeGreaterThan(700);
        } finally {
            setDeterministicRandomSource(undefined);
        }
    });

    it("creates secure v4 UUIDs from random bytes when native randomUUID is absent", () => {
        withCryptoMock(
            {
                getRandomValues<T extends ArrayBufferView>(array: T): T {
                    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
                    for (let i = 0; i < bytes.length; i++) {
                        bytes[i] = i;
                    }
                    return array;
                },
            },
            () => {
                expect(createSecureUuid()).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
            },
        );
    });

    it("schedules interval callbacks through the host timer", async () => {
        const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "setInterval");
        let scheduled: (() => void | Promise<void>) | undefined;
        let calls = 0;

        Object.defineProperty(globalThis, "setInterval", {
            configurable: true,
            value: (handler: TimerHandler, timeout?: number): ReturnType<typeof setInterval> => {
                expect(timeout).toBe(25);
                scheduled = handler as () => void | Promise<void>;
                return 1 as unknown as ReturnType<typeof setInterval>;
            },
        });

        try {
            interval(async () => {
                calls += 1;
            }, 25);

            await scheduled?.();
            expect(calls).toBe(1);
        } finally {
            if (originalDescriptor) {
                Object.defineProperty(globalThis, "setInterval", originalDescriptor);
            } else {
                Reflect.deleteProperty(globalThis, "setInterval");
            }
        }
    });
});
