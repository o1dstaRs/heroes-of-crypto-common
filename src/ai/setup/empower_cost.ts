import { Tier2Artifact } from "../../artifacts/artifact_properties";
import { getArmorPower, getEmpowerPower, getMightPower, getSniperPower } from "../../augments/augment_properties";
import {
    EMPOWER_ALLOCATION_FEATURES,
    empowerAllocationFeatures,
    empowerAllocationPlan,
    sameEmpowerAllocation,
} from "./empower_allocation";
import type { ISetupAugmentChoice } from "./setup_ship";
import type { IPlacementSetupDecisionContext } from "./setup_strategy";

export const EMPOWER_COST_SCHEMA = "public-empower-opportunity-cost-v1";
const MAGIC_IDS = new Set([8, 9, 19, 49, 55, 56, 57]);
const STATE_INDICES = EMPOWER_ALLOCATION_FEATURES.flatMap((name, index) => {
    const ownId = /^own:(\d+)$/.exec(name);
    if (ownId) return MAGIC_IDS.has(Number(ownId[1])) ? [index] : [];
    if (/^publicEnemy:\d+$/.test(name)) return [];
    if (name.startsWith("budget:") && name.split(":").length > 2) return [];
    return [index];
});
const STATE_NAMES = ["constant", ...STATE_INDICES.map((index) => EMPOWER_ALLOCATION_FEATURES[index])];
const COSTS = ["magicGain", "meleeAttackLost", "rangedAttackLost", "rangeLost", "armorLost"] as const;
export const EMPOWER_COST_FEATURES = COSTS.flatMap((cost) => STATE_NAMES.map((state) => `${cost}:${state}`));

export interface IEmpowerCostModel {
    schema: typeof EMPOWER_COST_SCHEMA;
    features: readonly string[];
    weights: readonly number[];
    margin: number;
}

/** One shared effect model prices each actual gain and loss against public setup context. */
export function empowerCostFeatures(
    budget: number,
    own: readonly number[],
    context: Readonly<IPlacementSetupDecisionContext> | undefined,
    incumbent: readonly ISetupAugmentChoice[],
    arm: number,
): number[] | undefined {
    if (!Number.isInteger(arm) || arm < 0 || arm > 6) throw new RangeError("Invalid Empower cost arm");
    const publicFeatures = empowerAllocationFeatures(budget, own, context);
    if (!publicFeatures || sameEmpowerAllocation(empowerAllocationPlan(budget, own, incumbent, 1), incumbent))
        return undefined;
    const proposed = empowerAllocationPlan(budget, own, incumbent, arm);
    const level = (plan: readonly ISetupAugmentChoice[], kind: ISetupAugmentChoice["kind"]) =>
        plan.find((entry) => entry.kind === kind)?.value ?? 0;
    const sniperBefore = getSniperPower(level(incumbent, "Sniper"));
    const sniperAfter = getSniperPower(level(proposed, "Sniper"));
    const costs = [
        (getEmpowerPower(level(proposed, "Empower")) - getEmpowerPower(level(incumbent, "Empower"))) / 24,
        (getMightPower(level(incumbent, "Might")) - getMightPower(level(proposed, "Might"))) / 27,
        (sniperBefore[0] - sniperAfter[0]) / 27,
        context?.ownArtifactIds?.[1] === Tier2Artifact.FARSIGHT_QUIVER ? 0 : (sniperBefore[1] - sniperAfter[1]) / 70,
        (getArmorPower(level(incumbent, "Armor")) - getArmorPower(level(proposed, "Armor"))) / 21,
    ];
    const state = [1, ...STATE_INDICES.map((index) => publicFeatures[index])];
    return costs.flatMap((cost) => state.map((value) => cost * value));
}

export function validateEmpowerCostModel(model: IEmpowerCostModel): void {
    if (
        model.schema !== EMPOWER_COST_SCHEMA ||
        model.features.join("\n") !== EMPOWER_COST_FEATURES.join("\n") ||
        model.weights.length !== EMPOWER_COST_FEATURES.length ||
        model.weights.some((value) => !Number.isFinite(value)) ||
        !Number.isFinite(model.margin) ||
        model.margin < 0 ||
        model.margin > 1
    )
        throw new Error("Invalid Empower cost model");
}

export function selectEmpowerCost(
    model: IEmpowerCostModel,
    budget: number,
    own: readonly number[],
    context: Readonly<IPlacementSetupDecisionContext> | undefined,
    incumbent: readonly ISetupAugmentChoice[],
): number {
    validateEmpowerCostModel(model);
    let selected = 0,
        best = model.margin;
    for (let arm = 1; arm <= 6; arm += 1) {
        const features = empowerCostFeatures(budget, own, context, incumbent, arm);
        if (!features) return 0;
        const gain = model.weights.reduce((sum, weight, index) => sum + weight * features[index], 0);
        if (gain > best) {
            selected = arm;
            best = gain;
        }
    }
    return selected;
}
