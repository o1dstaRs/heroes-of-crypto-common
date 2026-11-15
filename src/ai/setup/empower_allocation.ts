import { creatureInfo } from "./creature_score";
import { EMPOWER_CONTEXT_FEATURES, empowerContextFeatures } from "./empower_context";
import { empowerSetupPlan } from "./empower_setup";
import type { ISetupAugmentChoice } from "./setup_ship";
import type { IPlacementSetupDecisionContext } from "./setup_strategy";

export const EMPOWER_ALLOCATION_SCHEMA = "public-empower-allocation-v1";
export const EMPOWER_ALLOCATION_ARMS = [
    "current",
    "physical1",
    "physical2",
    "physical3",
    "armor1",
    "armor2",
    "armor3",
] as const;
const FACTIONS = ["Life", "Chaos", "Might", "Nature"] as const;
export const EMPOWER_ALLOCATION_FEATURES = [
    ...EMPOWER_CONTEXT_FEATURES,
    ...FACTIONS.flatMap((faction) => [1, 2].map((variant) => `publicVariant:${faction}:${variant}`)),
];
export interface IEmpowerAllocationModel {
    schema: typeof EMPOWER_ALLOCATION_SCHEMA;
    features: readonly string[];
    heads: readonly { b: number; w: readonly number[] }[];
    margin: number;
}

export function sameEmpowerAllocation(a: readonly ISetupAugmentChoice[], b: readonly ISetupAugmentChoice[]): boolean {
    const signature = (plan: readonly ISetupAugmentChoice[]) => {
        if (
            new Set(plan.map((entry) => entry.kind)).size !== plan.length ||
            plan.some((entry) => !Number.isInteger(entry.value) || entry.value < 0 || entry.value > 3)
        )
            return undefined;
        return plan
            .filter((entry) => entry.value > 0)
            .map((entry) => `${entry.kind}:${entry.value}`)
            .sort()
            .join(",");
    };
    const left = signature(a);
    return left !== undefined && left === signature(b);
}

/** Paid Placement, manual builds and partial budgets retain their exact incumbent plan. */
export function empowerAllocationPlan(
    budget: number,
    own: readonly number[],
    incumbent: readonly ISetupAugmentChoice[],
    arm: number,
): ISetupAugmentChoice[] {
    const retained = incumbent.map((entry) => ({ ...entry }));
    if (!Number.isInteger(arm) || arm < 0 || arm >= EMPOWER_ALLOCATION_ARMS.length)
        throw new RangeError("Invalid Empower allocation arm");
    if (arm === 0 || ![5, 6, 7].includes(budget) || !sameEmpowerAllocation(incumbent, empowerSetupPlan(budget, own, 0)))
        return retained;
    const level = ((arm - 1) % 3) + 1;
    const ranged = own.filter((id) => creatureInfo(id)?.ranged).length >= 2;
    const preferred = ranged ? "Sniper" : "Might",
        spare = ranged ? "Might" : "Sniper";
    const order = arm <= 3 ? [spare, preferred, "Armor"] : [spare, "Armor", preferred];
    const levels = new Map<string, number>(incumbent.map((entry) => [entry.kind, entry.value]));
    let remaining = level;
    for (const kind of order) {
        const take = Math.min(remaining, levels.get(kind) ?? 0);
        levels.set(kind, (levels.get(kind) ?? 0) - take);
        remaining -= take;
    }
    if (remaining) throw new Error("Unfunded Empower allocation");
    return [
        ...incumbent.map((entry) => ({ ...entry, value: levels.get(entry.kind)! })).filter((entry) => entry.value > 0),
        { kind: "Empower", value: level },
    ];
}

export function empowerAllocationFeatures(
    budget: number,
    own: readonly number[],
    context?: Readonly<IPlacementSetupDecisionContext>,
): number[] | undefined {
    const base = empowerContextFeatures(budget, own, context);
    if (
        !base ||
        !context?.synergyVariants ||
        FACTIONS.some((faction) => ![1, 2].includes(context.synergyVariants![faction]))
    )
        return undefined;
    return [
        ...base,
        ...FACTIONS.flatMap((faction) =>
            [1, 2].map((variant) => Number(context.synergyVariants![faction] === variant)),
        ),
    ];
}

export function validateEmpowerAllocationModel(model: IEmpowerAllocationModel): void {
    if (
        model.schema !== EMPOWER_ALLOCATION_SCHEMA ||
        model.features.join("\n") !== EMPOWER_ALLOCATION_FEATURES.join("\n") ||
        !Number.isFinite(model.margin) ||
        model.margin < 0 ||
        model.margin > 1 ||
        model.heads.length !== 6 ||
        model.heads.some(
            (head) =>
                !Number.isFinite(head.b) ||
                head.w.length !== EMPOWER_ALLOCATION_FEATURES.length ||
                head.w.some((weight) => !Number.isFinite(weight)),
        )
    )
        throw new Error("Invalid Empower allocation model");
}

export function selectEmpowerAllocation(
    model: IEmpowerAllocationModel,
    budget: number,
    own: readonly number[],
    context: Readonly<IPlacementSetupDecisionContext> | undefined,
    incumbent: readonly ISetupAugmentChoice[],
): number {
    validateEmpowerAllocationModel(model);
    const features = empowerAllocationFeatures(budget, own, context);
    if (!features || !sameEmpowerAllocation(incumbent, empowerSetupPlan(budget, own, 0))) return 0;
    let selected = 0,
        best = model.margin;
    for (const [index, head] of model.heads.entries()) {
        const gain = head.b + features.reduce((sum, value, feature) => sum + value * head.w[feature], 0);
        if (gain > best) {
            best = gain;
            selected = index + 1;
        }
    }
    return selected;
}
