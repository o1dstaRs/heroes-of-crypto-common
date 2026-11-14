import { empowerSetupPlan, selectEmpowerSetup, type IEmpowerSetupModel } from "./empower_setup";
import type { ISetupAugmentChoice } from "./setup_ship";

function samePlan(a: readonly ISetupAugmentChoice[], b: readonly ISetupAugmentChoice[]): boolean {
    const normalize = (plan: readonly ISetupAugmentChoice[]) => {
        if (
            new Set(plan.map((entry) => entry.kind)).size !== plan.length ||
            plan.some((entry) => !Number.isInteger(entry.value) || entry.value < 0)
        )
            return undefined;
        return plan
            .filter((entry) => entry.value > 0)
            .map((entry) => `${entry.kind}:${entry.value}`)
            .sort()
            .join(",");
    };
    const left = normalize(a),
        right = normalize(b);
    return left !== undefined && right !== undefined && left === right;
}

/** Preserve other setup policies, including funded Placement, until the combined policy is measured. */
export function compatibleEmpowerSetup(
    model: IEmpowerSetupModel,
    budget: number,
    own: readonly number[],
    incumbent: readonly ISetupAugmentChoice[],
): { level: number; augments: ISetupAugmentChoice[]; formationAugments: ISetupAugmentChoice[] } {
    const baseline = incumbent.map((entry) => ({ ...entry }));
    const retain = () => ({ level: 0, augments: baseline, formationAugments: baseline });
    if (![5, 6, 7].includes(budget) || !samePlan(incumbent, empowerSetupPlan(budget, own, 0))) return retain();
    const level = selectEmpowerSetup(model, budget, own);
    return level ? { level, augments: empowerSetupPlan(budget, own, level), formationAugments: baseline } : retain();
}

/** Only a matching selected build receives its incumbent formation context; manual builds keep their own. */
export function compatibleEmpowerFormation(
    model: IEmpowerSetupModel,
    budget: number,
    own: readonly number[],
    incumbent: readonly ISetupAugmentChoice[],
    actual: readonly ISetupAugmentChoice[],
): ISetupAugmentChoice[] {
    const selected = compatibleEmpowerSetup(model, budget, own, incumbent);
    return selected.level > 0 && samePlan(actual, selected.augments)
        ? selected.formationAugments
        : actual.map((entry) => ({ ...entry }));
}
