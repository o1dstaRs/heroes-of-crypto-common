import {
    empowerAllocationPlan,
    sameEmpowerAllocation,
    selectEmpowerAllocation,
    type IEmpowerAllocationModel,
} from "./empower_allocation";
import type { ISetupAugmentChoice } from "./setup_ship";
import type { IPlacementSetupDecisionContext } from "./setup_strategy";

/** An explicit model is required; this adapter does not select or activate a default checkpoint. */
export function compatibleEmpowerAllocation(
    model: IEmpowerAllocationModel,
    budget: number,
    own: readonly number[],
    context: Readonly<IPlacementSetupDecisionContext> | undefined,
    incumbent: readonly ISetupAugmentChoice[],
) {
    const arm = selectEmpowerAllocation(model, budget, own, context, incumbent);
    return {
        arm,
        augments: empowerAllocationPlan(budget, own, incumbent, arm),
        formationAugments: incumbent.map((entry) => ({ ...entry })),
    };
}

/** Restore the measured formation context only for the exact selected, fully funded build. */
export function compatibleEmpowerAllocationFormation(
    model: IEmpowerAllocationModel,
    budget: number,
    own: readonly number[],
    context: Readonly<IPlacementSetupDecisionContext> | undefined,
    incumbent: readonly ISetupAugmentChoice[],
    actual: readonly ISetupAugmentChoice[],
): ISetupAugmentChoice[] {
    const selected = compatibleEmpowerAllocation(model, budget, own, context, incumbent);
    return selected.arm > 0 && sameEmpowerAllocation(selected.augments, actual)
        ? selected.formationAugments
        : actual.map((entry) => ({ ...entry }));
}
