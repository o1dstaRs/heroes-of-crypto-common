import { planTacticalStackSplits, type ITacticalSplitUnit } from "./tactical_split_placement";
import { planA19HealerSplits, type A19HealerSplitMode, type A19SupportSplitPlan } from "./healer_support_setup";
import { planA19WanderingMageSplits } from "./wandering_mage_support";
import { creatureIdForName, creatureInfo } from "./setup/creature_score";

export const A19_UNIT_SUPPORT_POLICY = Object.freeze({
    id: "a19-unit-support-v1" as const,
    adoption: "user-authorized-with-inconclusive-strength" as const,
    combinedStrengthQualified: false,
    healerSelection: "own-roster-power-and-recipients-v1" as const,
    paidPlacementPurchase: false,
});

/** Only own roster data enters this dispatch; enemy hidden quantities are not selection inputs. */
export function chooseA19HealerSplitMode(
    units: readonly ITacticalSplitUnit[],
    availableSlots: number,
): A19HealerSplitMode {
    const living = units.filter((unit) => unit.amount > 0);
    const healer = living.find((unit) => unit.identity === "Healer:2");
    if (!healer) return "single";
    const experience = (unit: ITacticalSplitUnit): number => {
        const id = creatureIdForName(unit.identity.split(":")[0]);
        return id === undefined ? 0 : (creatureInfo(id)?.exp ?? 0);
    };
    const reference = Math.max(0, ...living.map((unit) => unit.amount * experience(unit)));
    const recipients = living.filter(
        (unit) =>
            unit.id !== healer.id &&
            unit.amount > 1 &&
            unit.identity !== "Healer:2" &&
            unit.hpPerCreature >= 2 * healer.hpPerCreature &&
            !unit.summoned,
    );
    const half = Math.floor(healer.amount / 2);
    if (reference > 0 && half > 1 && half * experience(healer) > 0.4 * reference && recipients.length >= 2)
        return "half";
    return availableSlots >= 2 && recipients.length >= 2 && healer.amount > 2 ? "two-singles" : "single";
}

/** Reserve one funded slot per support type before allocating a second Healer buff child. */
export function planA19SupportSplits(
    units: readonly ITacticalSplitUnit[],
    maximumStacks: number,
): A19SupportSplitPlan[] {
    const living = units.filter((unit) => unit.amount > 0);
    const incumbent = planA19WanderingMageSplits(units, maximumStacks);
    const healer = living.filter((unit) => unit.identity === "Healer:2");
    if (
        healer.length !== 1 ||
        !healer[0].small ||
        healer[0].summoned ||
        !Number.isSafeInteger(healer[0].amount) ||
        healer[0].amount < 2 ||
        !Number.isSafeInteger(maximumStacks)
    )
        return incumbent;
    const slots = Math.max(0, Math.min(maximumStacks - living.length, maximumStacks - 6));
    if (!slots) return incumbent;
    const mageIds = new Set(living.filter((unit) => unit.identity === "Wandering Mage:1").map((unit) => unit.id));
    const mage = slots >= 2 ? incumbent.find((plan) => mageIds.has(plan.sourceUnitId)) : undefined;
    const healerSlots = slots - (mage ? 1 : 0);
    const mode = chooseA19HealerSplitMode(units, healerSlots);
    const healers = planA19HealerSplits(units, maximumStacks, mode)
        .filter((plan) => plan.sourceUnitId === healer[0].id)
        .slice(0, healerSlots);
    const selected: A19SupportSplitPlan[] = [...healers, ...(mage ? [mage] : [])];
    const selectedIds = new Set(selected.map((plan) => plan.sourceUnitId));
    return selected.concat(
        planTacticalStackSplits(units, maximumStacks)
            .filter((plan) => !selectedIds.has(plan.sourceUnitId))
            .slice(0, Math.max(0, slots - selected.length)),
    );
}
