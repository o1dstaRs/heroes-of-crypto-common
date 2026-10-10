import {
    assertAugmentPlan,
    augmentPlanCost,
    augmentPlanId,
    enumerateFullBudgetAugmentPlans,
    setupAugmentsForPlan,
    type IAugmentPlan,
    type ISetupAugmentChoice,
} from "./setup_ship";

/** The live sixth axis is opt-in here; legacy balance/setup enumerators remain unchanged. */
export interface IPremiumAugmentPlan extends IAugmentPlan {
    empower?: number;
}
export const PREMIUM_AUGMENT_DOMAIN = "six-axis-empower-v1";
export const premiumAugmentPlanCost = (plan: Readonly<IPremiumAugmentPlan>): number =>
    augmentPlanCost(plan) + (plan.empower ?? 0);

export function assertPremiumAugmentPlan(plan: Readonly<IPremiumAugmentPlan>, budget = 7): void {
    assertAugmentPlan(plan, budget);
    const empower = plan.empower ?? 0;
    if (!Number.isInteger(empower) || empower < 0 || empower > 3 || premiumAugmentPlanCost(plan) > budget)
        throw new RangeError("Invalid Empower level or full augment budget");
}

/** Preserve historical IDs at Empower 0; an E suffix always means an additional paid augment. */
export function premiumAugmentPlanId(plan: Readonly<IPremiumAugmentPlan>): string {
    assertPremiumAugmentPlan(plan);
    return `${augmentPlanId(plan)}${plan.empower ? `-E${plan.empower}` : ""}`;
}

export function premiumSetupAugmentsForPlan(plan: Readonly<IPremiumAugmentPlan>): ISetupAugmentChoice[] {
    assertPremiumAugmentPlan(plan);
    return [
        ...setupAugmentsForPlan(plan),
        ...(plan.empower ? [{ kind: "Empower" as const, value: plan.empower }] : []),
    ];
}

export function enumeratePremiumAugmentPlans(budget: number): IPremiumAugmentPlan[] {
    if (!Number.isInteger(budget) || budget < 0 || budget > 7) throw new RangeError("Invalid Premium augment budget");
    return [0, 1, 2, 3]
        .filter((empower) => empower <= budget)
        .flatMap((empower) => enumerateFullBudgetAugmentPlans(budget - empower).map((plan) => ({ ...plan, empower })))
        .sort((a, b) => premiumAugmentPlanId(a).localeCompare(premiumAugmentPlanId(b)));
}
