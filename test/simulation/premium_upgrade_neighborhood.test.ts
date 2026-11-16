import { describe, expect, it } from "bun:test";
import {
    enumeratePremiumAugmentPlans,
    premiumAugmentPlanCost,
    premiumAugmentPlanId,
} from "../../src/ai/setup/premium_augment_plans";
import {
    premiumNativePurchases,
    premiumPlanFromNative,
    premiumUpgradeNeighbors,
    premiumUpgradeSlate,
} from "../../src/simulation/premium_upgrade_neighborhood";

describe("prospective matched upgrade action space", () => {
    it("covers every funded doctrine plan, preserving Placement and moving exactly one point", () => {
        let plans = 0;
        for (const budget of [5, 6, 7])
            for (const current of enumeratePremiumAugmentPlans(budget)) {
                plans++;
                const frozen = structuredClone(current);
                const native = premiumNativePurchases(current);
                expect(premiumPlanFromNative(native, budget)).toEqual(current);
                const neighbors = premiumUpgradeNeighbors(current, budget);
                for (const neighbor of neighbors) {
                    expect(premiumAugmentPlanCost(neighbor.plan)).toBe(budget);
                    expect(neighbor.plan.placement).toBe(current.placement);
                    expect(
                        Object.keys(current).reduce(
                            (sum, key) =>
                                sum +
                                Math.abs(
                                    (current as Record<string, number>)[key] -
                                        (neighbor.plan as Record<string, number>)[key],
                                ),
                            0,
                        ),
                    ).toBe(2);
                    expect(neighbor.plan[neighbor.transfer.from]).toBe(current[neighbor.transfer.from]! - 1);
                    expect(neighbor.plan[neighbor.transfer.to]).toBe(current[neighbor.transfer.to]! + 1);
                }
                const slate = premiumUpgradeSlate(native, budget, 7200000 + plans);
                expect(slate.plans).toHaveLength(4);
                expect(new Set(slate.plans.map(({ key }) => key)).size).toBe(4);
                expect(slate.plans[0].key).toBe(premiumAugmentPlanId(current));
                expect(
                    slate.plans
                        .slice(1)
                        .every(({ inclusionProbability }) => inclusionProbability === 3 / neighbors.length),
                ).toBe(true);
                expect(slate).toEqual(premiumUpgradeSlate(native, budget, 7200000 + plans));
                expect(current).toEqual(frozen);
            }
        expect(plans).toBe(783);
    });

    it("samples alternatives across seeds without a result, opponent-private field or policy choice", () => {
        const native = [
            { kind: "Placement" as const, value: 1 },
            { kind: "Armor" as const, value: 2 },
            { kind: "Might" as const, value: 2 },
        ];
        const current = premiumPlanFromNative(native, 5);
        const all = premiumUpgradeNeighbors(current, 5);
        const seen = new Set<string>();
        for (let seed = 1; seed <= 200; seed++) {
            const slate = premiumUpgradeSlate(native, 5, seed);
            for (const entry of slate.plans.slice(1)) seen.add(entry.key);
            expect(slate.policySelected).toBe(false);
            expect(slate.plans[0].inclusionProbability).toBe(1);
        }
        expect([...seen].sort()).toEqual(all.map(({ key }) => key).sort());
    });

    it("rejects underfunding, illegal levels, duplicate purchases and invalid seed domains", () => {
        expect(() => premiumPlanFromNative([{ kind: "Armor", value: 3 }], 5)).toThrow("complete budget");
        expect(() =>
            premiumPlanFromNative(
                [
                    { kind: "Armor", value: 3 },
                    { kind: "Armor", value: 2 },
                ],
                5,
            ),
        ).toThrow("duplicate");
        expect(() =>
            premiumPlanFromNative(
                [
                    { kind: "Movement", value: 3 },
                    { kind: "Might", value: 2 },
                ],
                5,
            ),
        ).toThrow();
        expect(() =>
            premiumPlanFromNative(
                [
                    { kind: "Armor", value: 3 },
                    { kind: "Might", value: 2 },
                ],
                4,
            ),
        ).toThrow("doctrine");
        for (const seed of [-1, 0.5, Number.NaN, 0x100000000])
            expect(() => premiumUpgradeSlate([], 5, seed)).toThrow("selection seed");
    });
});
