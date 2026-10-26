import { describe, expect, it } from "bun:test";
import { SearchDriver } from "../../src/simulation/search_driver";

const beforeImport = Reflect.get(SearchDriver.prototype, "rollout");
const { discreteAntitheticQuantile, makeA19DiscreteChanceTape } =
    await import("../../src/simulation/a19_discrete_chance");
const TWO53 = 1n << 53n;

describe("research integer antithetics", () => {
    it("does not change the driver or randomness on import", () => {
        expect(Reflect.get(SearchDriver.prototype, "rollout")).toBe(beforeImport);
    });

    it("fixes a concrete failure of raw complements after modulo conversion", () => {
        const raw = 0n;
        expect((raw % 100n) + ((TWO53 - 1n - raw) % 100n)).toBe(91n);
        expect(discreteAntitheticQuantile(raw, 100n, false)).toBe(0n);
        expect(discreteAntitheticQuantile(raw, 100n, true)).toBe(99n);
    });

    it("gives every discrete outcome exactly the same accepted bucket size", () => {
        for (const span of [2n, 3n, 9n, 17n, 100n, 257n, 10000n]) {
            const bucket = TWO53 / span;
            for (let index = 0n; index < span; index++) {
                const first = bucket * index;
                const last = first + bucket - 1n;
                for (const raw of [first, last]) {
                    expect(discreteAntitheticQuantile(raw, span, false)).toBe(index);
                    expect(discreteAntitheticQuantile(raw, span, true)).toBe(span - 1n - index);
                }
            }
            for (let raw = bucket * span; raw < TWO53; raw++) {
                expect(discreteAntitheticQuantile(raw, span, false)).toBeUndefined();
                expect(discreteAntitheticQuantile(raw, span, true)).toBeUndefined();
            }
        }
    });

    it("preserves pairing through actual actor/lap tapes including rejection-heavy ranges", () => {
        let id = "actor-A";
        let lap = 1;
        const context = { getActiveUnitId: () => id, fightProperties: { getCurrentLap: () => lap } };
        for (const seed of [0, 1, 0xffffffff]) {
            const a = makeA19DiscreteChanceTape(seed, 0, context, { hashes: new Map() });
            const b = makeA19DiscreteChanceTape(seed, 1, context, { hashes: new Map() });
            for (let index = 0; index < 2000; index++) {
                id = index % 3 ? "actor-A" : "actor-B";
                lap = 1 + Math.floor(index / 400);
                for (const [min, max] of [
                    [0, 100],
                    [-50, 51],
                    [8, 17],
                    [0, 2 ** 52 + 1],
                    [-1, Number.MAX_SAFE_INTEGER],
                ]) {
                    const x = a.integer(min, max);
                    const y = b.integer(min, max);
                    expect(Number.isSafeInteger(x) && x >= min && x < max).toBe(true);
                    expect(Number.isSafeInteger(y) && y >= min && y < max).toBe(true);
                    expect(BigInt(x) + BigInt(y)).toBe(BigInt(min) + BigInt(max) - 1n);
                }
            }
        }
    });

    it("keeps another actor's extra draws out of an aligned pair", () => {
        const leftId = "A";
        let rightId = "A",
            rightLap = 1;
        const a = makeA19DiscreteChanceTape(
            918273,
            0,
            {
                getActiveUnitId: () => leftId,
                fightProperties: { getCurrentLap: () => 1 },
            },
            { hashes: new Map() },
        );
        const b = makeA19DiscreteChanceTape(
            918273,
            1,
            {
                getActiveUnitId: () => rightId,
                fightProperties: { getCurrentLap: () => rightLap },
            },
            { hashes: new Map() },
        );
        for (let index = 0; index < 1000; index++) {
            rightId = "B";
            rightLap = 2;
            for (let extra = 0; extra < index % 5; extra++) b.integer(0, 100);
            rightId = leftId;
            rightLap = 1;
            expect(a.integer(0, 100) + b.integer(0, 100)).toBe(99);
        }
    });

    it("never stores mutable generator state in the shared hash cache", () => {
        const context = { getActiveUnitId: () => "A", fightProperties: { getCurrentLap: () => 1 } };
        const cache = { hashes: new Map<string, number>() };
        const first = makeA19DiscreteChanceTape(42, 0, context, cache);
        const expected = Array.from({ length: 100 }, () => first.integer(0, 100));
        for (let i = 0; i < 100; i++) first.integer(0, 100);
        const second = makeA19DiscreteChanceTape(42, 0, context, cache);
        expect(Array.from({ length: 100 }, () => second.integer(0, 100))).toEqual(expected);
    });

    it("rejects invalid metadata and does not consume a tape for constant ranges", () => {
        const context = { getActiveUnitId: () => "A", fightProperties: { getCurrentLap: () => 1 } };
        const cache = { hashes: new Map<string, number>() };
        for (const seed of [-1, 2 ** 32, NaN, 0.5])
            expect(() => makeA19DiscreteChanceTape(seed, 0, context, cache)).toThrow();
        for (const index of [-1, 2, 0.5, NaN])
            expect(() => makeA19DiscreteChanceTape(1, index, context, cache)).toThrow();
        const a = makeA19DiscreteChanceTape(1, 0, context, cache);
        const b = makeA19DiscreteChanceTape(1, 0, context, cache);
        for (const range of [
            [NaN, 1],
            [0, Infinity],
            [0.5, 2],
            [2, 1],
            [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
        ])
            expect(() => a.integer(range[0], range[1])).toThrow();
        expect(a.integer(4, 4)).toBe(4);
        expect(a.integer(-7, -6)).toBe(-7);
        expect(a.integer(0, 100)).toBe(b.integer(0, 100));
        for (const [raw, span] of [
            [-1n, 2n],
            [TWO53, 2n],
            [0n, 0n],
            [0n, TWO53 + 1n],
        ])
            expect(() => discreteAntitheticQuantile(raw, span, false)).toThrow();
    });
});
