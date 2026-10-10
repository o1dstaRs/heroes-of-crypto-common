import { expect, test } from "bun:test";
import { enumerateFullBudgetAugmentPlans, augmentPlanId } from "../../src/ai/setup/setup_ship";
import {
    enumeratePremiumAugmentPlans,
    premiumAugmentPlanCost,
    premiumAugmentPlanId,
    premiumSetupAugmentsForPlan,
    assertPremiumAugmentPlan,
} from "../../src/ai/setup/premium_augment_plans";

test("Premium enumerates the complete six-axis live budget while preserving the legacy domain", () => {
    for (const [budget, total, legacy] of [
        [5, 186, 81],
        [6, 267, 96],
        [7, 330, 96],
    ]) {
        const plans = enumeratePremiumAugmentPlans(budget);
        expect(plans).toHaveLength(total);
        expect(new Set(plans.map(premiumAugmentPlanId)).size).toBe(total);
        expect(plans.every((plan) => premiumAugmentPlanCost(plan) === budget)).toBe(true);
        expect(plans.filter((plan) => !plan.empower).map(premiumAugmentPlanId)).toEqual(
            enumerateFullBudgetAugmentPlans(budget).map(augmentPlanId),
        );
        expect(enumerateFullBudgetAugmentPlans(budget)).toHaveLength(legacy);
    }
});

test("Empower is a separate paid axis, not silently discarded or encoded as Might", () => {
    const plan = { placement: 1, armor: 3, might: 0, sniper: 0, movement: 0, empower: 3 };
    expect(premiumAugmentPlanId(plan)).toBe("P1-A3-M0-S0-V0-E3");
    expect(premiumSetupAugmentsForPlan(plan)).toEqual([
        { kind: "Placement", value: 1 },
        { kind: "Armor", value: 3 },
        { kind: "Empower", value: 3 },
    ]);
    expect(() => assertPremiumAugmentPlan(plan, 6)).toThrow("budget");
    expect(() => premiumAugmentPlanId({ ...plan, empower: 4 })).toThrow();
});

test("full Premium collection retains the visible draft but samples all six setup axes", async () => {
    const { prepareMetaPair, AI_META_COHORTS } = await import("../../src/simulation/ai_meta_cohorts_core");
    const { PREMIUM_META_STUDY, PREMIUM_META_FULL_AUGMENTS_STUDY, PREMIUM_META_FULL_AUGMENTS_SCHEMA } =
        await import("../../src/simulation/ai_meta_study");
    const { getUpgradePoints } = await import("../../src/doctrines/doctrine_properties");
    const selected = new Set<number>();
    for (const cohort of AI_META_COHORTS)
        for (let pair = 0; pair < 12; pair++) {
            const options = { cohort, games: 24, baseSeed: 85003777, collectEvidence: true };
            const full = prepareMetaPair({ ...options, studyProfile: PREMIUM_META_FULL_AUGMENTS_STUDY }, pair);
            const legacy = prepareMetaPair({ ...options, studyProfile: PREMIUM_META_STUDY }, pair);
            expect(full.evidence!.schema).toBe(PREMIUM_META_FULL_AUGMENTS_SCHEMA);
            expect(full.evidence!.rankedDraft).toEqual(legacy.evidence!.rankedDraft);
            for (const army of [full.armyA, full.armyB]) {
                const budget = getUpgradePoints(army.doctrine);
                expect(premiumAugmentPlanCost(army.augment.plan)).toBe(budget);
                expect(army.augment.evidence!.candidates.map((c) => c.key).sort()).toEqual(
                    enumeratePremiumAugmentPlans(budget).map(premiumAugmentPlanId).sort(),
                );
                expect(army.augment.evidence!.candidates.every((c) => c.probability > 0)).toBe(true);
                selected.add(army.augment.plan.empower ?? 0);
            }
        }
    expect([...selected].sort()).toEqual([0, 1, 2, 3]);
});
