import {
    assertPremiumAugmentPlan,
    premiumAugmentPlanId,
    type IPremiumAugmentPlan,
} from "../ai/setup/premium_augment_plans";
import type { ISetupAugmentChoice } from "../ai/setup/setup_ship";
import type { IAiMetaPairRecord } from "./ai_meta_cohorts_core";
import { PREMIUM_META_CURRENT_STUDY } from "./ai_meta_study";

/** Actual purchases, not the first-seat army descriptor, are the unit of setup attribution. */
export function aiMetaPlanFromAppliedAugments(augments: readonly ISetupAugmentChoice[]): IPremiumAugmentPlan {
    const plan: IPremiumAugmentPlan = { placement: 0, armor: 0, might: 0, sniper: 0, movement: 0, empower: 0 };
    const seen = new Set<string>();
    for (const { kind, value } of augments) {
        const key = kind.toLowerCase() as keyof IPremiumAugmentPlan;
        if (!(key in plan) || seen.has(key)) throw new Error("Unknown or repeated applied upgrade");
        seen.add(key);
        plan[key] = value;
    }
    assertPremiumAugmentPlan(plan);
    return plan;
}

export function aiMetaActualArmy(record: IAiMetaPairRecord, fightIndex: number, side: "a" | "b") {
    const army = side === "a" ? record.armyA : record.armyB;
    if (record.evidence?.studyProfile !== PREMIUM_META_CURRENT_STUDY) return army;
    const augments = record.evidence.fights?.[fightIndex].formations[side].augments;
    if (!augments) throw new Error("Native setup is missing per-fight applied upgrades");
    const plan = aiMetaPlanFromAppliedAugments(augments);
    return {
        ...army,
        augment: { ...army.augment, plan, planId: premiumAugmentPlanId(plan), augments, evidence: undefined },
    };
}
