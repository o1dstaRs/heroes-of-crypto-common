import { describe, expect, it } from "bun:test";
import {
    complementSearchChance,
    makeSearchChanceStream,
    type SearchChanceBank,
} from "../../src/simulation/search_chance_sampling";

describe("offline search chance banks", () => {
    it("leaves the driver untouched when the diagnostic is imported", async () => {
        const { SearchDriver } = await import("../../src/simulation/search_driver");
        const names = ["chooseDecision", "rollout", "scoreCandidates", "shortlistCandidates"];
        const before = names.map((name) => Reflect.get(SearchDriver.prototype, name));
        await import("../../src/simulation/measure_search_chance");
        expect(names.map((name) => Reflect.get(SearchDriver.prototype, name))).toEqual(before);
    });
    it("complements both endpoints on the exact uint32 grid", () => {
        expect(complementSearchChance(0)).toBe(1 - 2 ** -32);
        expect(complementSearchChance(1 - 2 ** -32)).toBe(0);
    });
    it("pairs aligned draws despite extra draws by another actor or lap", () => {
        let leftId = "A",
            rightId = "A",
            leftLap = 1,
            rightLap = 1;
        const left = { getActiveUnitId: () => leftId, fightProperties: { getCurrentLap: () => leftLap } };
        const right = { getActiveUnitId: () => rightId, fightProperties: { getCurrentLap: () => rightLap } };
        for (const pair of [0, 2]) {
            const a = makeSearchChanceStream(315555, pair, "actor-antithetic", left, { hashes: new Map() });
            const b = makeSearchChanceStream(315555, pair + 1, "actor-antithetic", right, { hashes: new Map() });
            for (let i = 0; i < 5000; i++) {
                leftId = "A";
                rightId = "B";
                rightLap = 2;
                for (let j = 0; j < i % 4; j++) b();
                rightId = "A";
                rightLap = leftLap;
                const x = a(),
                    y = b();
                expect(x + y).toBe(1 - 2 ** -32);
                expect(Number.isInteger(x * 2 ** 32)).toBe(true);
                if (i % 1000 === 999) leftLap++;
            }
        }
    });
    it("reusing a hash cache never reuses a generator's mutable state", () => {
        const context = { getActiveUnitId: () => "actor", fightProperties: { getCurrentLap: () => 3 } };
        const cache = { hashes: new Map<string, number>() };
        for (const bank of ["actor", "actor-antithetic"] as const) {
            const first = makeSearchChanceStream(0xffffffff, 0, bank, context, cache);
            const expected = Array.from({ length: 100 }, first);
            for (let i = 0; i < 400; i++) first();
            const second = makeSearchChanceStream(0xffffffff, 0, bank, context, cache);
            expect(Array.from({ length: 100 }, second)).toEqual(expected);
        }
    });
    it("global antithetic banks never read actor context", () => {
        const context = {
            getActiveUnitId: (): string => {
                throw new Error("unexpected actor lookup");
            },
            fightProperties: { getCurrentLap: () => 0 },
        };
        const a = makeSearchChanceStream(10, 2, "antithetic", context, { hashes: new Map() });
        const b = makeSearchChanceStream(10, 3, "antithetic", context, { hashes: new Map() });
        for (let i = 0; i < 1000; i++) expect(a() + b()).toBe(1 - 2 ** -32);
    });
    it("rejects invalid seed, rollout and bank metadata", () => {
        const context = { getActiveUnitId: () => "", fightProperties: { getCurrentLap: () => 0 } };
        const cache = { hashes: new Map<string, number>() };
        for (const seed of [-1, 2 ** 32, NaN, 1.5])
            expect(() => makeSearchChanceStream(seed, 0, "actor", context, cache)).toThrow();
        for (const index of [-1, 4, NaN, 1.5])
            expect(() => makeSearchChanceStream(1, index, "actor", context, cache)).toThrow();
        expect(() => makeSearchChanceStream(1, 0, "invalid" as SearchChanceBank, context, cache)).toThrow();
    });
});
