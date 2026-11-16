import {
    assertPremiumAugmentPlan,
    premiumAugmentPlanCost,
    premiumAugmentPlanId,
    type IPremiumAugmentPlan,
} from "../ai/setup/premium_augment_plans";
import type { ISetupAugmentChoice } from "../ai/setup/setup_ship";
import { makeRng } from "./army";

export const PREMIUM_UPGRADE_NEIGHBORHOOD = "premium-one-point-upgrades-v1";
const axes = ["armor", "might", "sniper", "movement", "empower"] as const;
const caps = { armor: 3, might: 3, sniper: 3, movement: 2, empower: 3 };
const kinds = {
    placement: "Placement",
    armor: "Armor",
    might: "Might",
    sniper: "Sniper",
    movement: "Movement",
    empower: "Empower",
} as const;

/** Current native purchases are an input, never recomputed by a second setup policy. */
export function premiumPlanFromNative(
    augments: readonly ISetupAugmentChoice[],
    budget: number,
): Required<IPremiumAugmentPlan> {
    if (![5, 6, 7].includes(budget)) throw new Error("Expected a ranked doctrine budget");
    const plan = { placement: 0, armor: 0, might: 0, sniper: 0, movement: 0, empower: 0 };
    const seen = new Set<string>();
    for (const choice of augments) {
        const axis = (Object.keys(kinds) as (keyof typeof kinds)[]).find((key) => kinds[key] === choice.kind);
        if (!axis || seen.has(axis) || !Number.isSafeInteger(choice.value) || choice.value <= 0)
            throw new Error("Invalid or duplicate native purchase");
        seen.add(axis);
        plan[axis] = choice.value;
    }
    assertPremiumAugmentPlan(plan, budget);
    if (premiumAugmentPlanCost(plan) !== budget) throw new Error("Native plan must spend the complete budget");
    return plan;
}

/** Exact one-point transfers, excluding Placement so the funded stack/geometry capacity cannot change. */
export function premiumUpgradeNeighbors(current: Readonly<IPremiumAugmentPlan>, budget: number) {
    assertPremiumAugmentPlan(current, budget);
    if (![5, 6, 7].includes(budget) || premiumAugmentPlanCost(current) !== budget)
        throw new Error("Expected a fully funded ranked plan");
    const base: Required<IPremiumAugmentPlan> = { ...current, empower: current.empower ?? 0 };
    const neighbors = axes
        .flatMap((from) =>
            axes.flatMap((to) => {
                if (from === to || !base[from] || base[to] >= caps[to]) return [];
                const plan = { ...base, [from]: base[from] - 1, [to]: base[to] + 1 };
                assertPremiumAugmentPlan(plan, budget);
                return [{ key: premiumAugmentPlanId(plan), plan, transfer: { from, to } }];
            }),
        )
        .sort((a, b) => a.key.localeCompare(b.key));
    if (neighbors.length < 3 || new Set(neighbors.map(({ key }) => key)).size !== neighbors.length)
        throw new Error("Incomplete or duplicate one-point neighborhood");
    return neighbors;
}

/** Data collection only: incumbent plus three uniformly sampled distinct neighbors, before any outcome. */
export function premiumUpgradeSlate(augments: readonly ISetupAugmentChoice[], budget: number, selectionSeed: number) {
    if (!Number.isSafeInteger(selectionSeed) || selectionSeed < 0 || selectionSeed > 0xffffffff)
        throw new Error("Invalid outcome-independent selection seed");
    const current = premiumPlanFromNative(augments, budget);
    const neighbors = premiumUpgradeNeighbors(current, budget);
    const shuffled = [...neighbors];
    const random = makeRng(selectionSeed);
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const selected = shuffled.slice(0, 3).sort((a, b) => a.key.localeCompare(b.key));
    return {
        schema: PREMIUM_UPGRADE_NEIGHBORHOOD,
        budget,
        neighborhoodSize: neighbors.length,
        eligibleKeys: neighbors.map(({ key }) => key),
        plans: [
            { key: premiumAugmentPlanId(current), plan: current, transfer: null, inclusionProbability: 1 },
            ...selected.map((entry) => ({ ...entry, inclusionProbability: 3 / neighbors.length })),
        ],
        inclusionMeaning: "slate-sampling-without-replacement-not-behavior-propensity" as const,
        executionRequired: "native-public-setup-with-incumbent-geometry-and-splits" as const,
        policySelected: false as const,
    };
}

export function premiumNativePurchases(plan: Readonly<IPremiumAugmentPlan>): ISetupAugmentChoice[] {
    assertPremiumAugmentPlan(plan);
    return (Object.keys(kinds) as (keyof typeof kinds)[])
        .filter((key) => (plan[key] ?? 0) > 0)
        .map((key) => ({ kind: kinds[key], value: plan[key]! }));
}
