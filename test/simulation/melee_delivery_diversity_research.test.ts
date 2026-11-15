import { describe, expect, test } from "bun:test";
import {
    diversifyMeleeDeliveries,
    type IMeleeDeliveryView,
} from "../../src/simulation/melee_delivery_diversity_research";

const row = (x: number, y: number, patch: Partial<IMeleeDeliveryView> = {}): IMeleeDeliveryView => ({
    targetId: "enemy",
    expectedDamage: 10,
    expectedKill: 0,
    stationary: false,
    x,
    y,
    ...patch,
});
const identity = (value: IMeleeDeliveryView) => value;
const slotClass = (value: IMeleeDeliveryView) =>
    [value.targetId, value.expectedDamage, value.expectedKill, value.stationary] as const;

describe("research melee delivery diversity", () => {
    test("offers opposite approaches while preserving the incumbent target delivery and action identity", () => {
        const pool = [row(6, 7), row(6, 8), row(6, 9), row(8, 9), row(8, 7)];
        pool.forEach(Object.freeze);
        const kept = Object.freeze(pool.slice(0, 3));
        const result = diversifyMeleeDeliveries(Object.freeze(pool), kept, identity);
        expect(result[0]).toBe(kept[0]);
        expect(result[1]).toBe(pool[3]);
        expect(result[2]).toBe(pool[2]);
        expect(kept).toEqual(pool.slice(0, 3));
    });

    test("does not buy diversity by losing targets, secure kills, damage or stationary coverage", () => {
        const pool = [
            row(6, 7, { stationary: true }),
            row(6, 8, { targetId: "other", expectedDamage: 15, expectedKill: 1 }),
            row(6, 9),
            row(7, 9),
            row(15, 15, { expectedDamage: 9 }),
            row(15, 14, { expectedKill: 1 }),
            row(15, 13, { targetId: "other", expectedDamage: 15, expectedKill: 1 }),
            row(8, 9),
        ];
        const kept = pool.slice(0, 4);
        const result = diversifyMeleeDeliveries(pool, kept, identity);
        expect(result.map(slotClass)).toEqual(kept.map(slotClass));
        expect(result[0]).toBe(kept[0]);
        expect(result[1]).toBe(kept[1]);
        expect(result[2]).toBe(pool[7]);
        expect(result).not.toContain(pool[4]);
        expect(result).not.toContain(pool[5]);
        expect(result).not.toContain(pool[6]);
    });

    test("returns the original array for uncapped, unchanged or unsupported input", () => {
        const pool = [row(1, 1), row(2, 2), row(3, 3)];
        expect(diversifyMeleeDeliveries(pool, pool, identity)).toBe(pool);
        const kept = [pool[0], pool[2]];
        expect(diversifyMeleeDeliveries(pool, kept, identity)).toBe(kept);
        expect(diversifyMeleeDeliveries([...pool, pool[0]], kept, identity)).toBe(kept);
        expect(diversifyMeleeDeliveries([...pool, row(NaN, 2)], kept, identity)).toBe(kept);
        const invented = [row(1, 1), pool[1]];
        expect(diversifyMeleeDeliveries(pool, invented, identity)).toBe(invented);
    });

    test("preserves all slot contracts across varied allocations without RNG or input changes", () => {
        for (let variant = 0; variant < 120; variant++) {
            const pool = Array.from({ length: 35 }, (_, index) =>
                Object.freeze(
                    row((index * 7 + variant) % 16, (index * 3 + variant) % 16, {
                        targetId: `target-${(index + variant) % 3}`,
                        expectedDamage: 10 + (index % 2),
                        expectedKill: index % 4 === 0 ? 1 : 0,
                        stationary: index % 7 === 0,
                    }),
                ),
            );
            const kept = Object.freeze(pool.slice(0, 10 + (variant % 9)));
            const before = JSON.stringify({ pool, kept });
            const result = diversifyMeleeDeliveries(pool, kept, identity);
            expect(result.map(slotClass)).toEqual(kept.map(slotClass));
            expect(new Set(result).size).toBe(kept.length);
            expect(result.every((value) => pool.includes(value))).toBe(true);
            for (const targetId of new Set(kept.map((value) => value.targetId))) {
                expect(result.find((value) => value.targetId === targetId)).toBe(
                    kept.find((value) => value.targetId === targetId),
                );
            }
            expect(JSON.stringify({ pool, kept })).toBe(before);
            expect(diversifyMeleeDeliveries(pool, kept, identity)).toEqual(result);
        }
    });
});
