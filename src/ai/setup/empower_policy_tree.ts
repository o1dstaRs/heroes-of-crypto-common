import { EMPOWER_ALLOCATION_FEATURES, empowerAllocationFeatures, sameEmpowerAllocation } from "./empower_allocation";
import { empowerSetupPlan } from "./empower_setup";
import type { ISetupAugmentChoice } from "./setup_ship";
import type { IPlacementSetupDecisionContext } from "./setup_strategy";

export const EMPOWER_POLICY_TREE_SCHEMA = "public-empower-policy-tree-v1";
export type EmpowerPolicyTree =
    { arm: number } | { feature: number; threshold: number; left: EmpowerPolicyTree; right: EmpowerPolicyTree };
export interface IEmpowerPolicyTreeModel {
    schema: typeof EMPOWER_POLICY_TREE_SCHEMA;
    features: readonly string[];
    tree: EmpowerPolicyTree;
}

export function validateEmpowerPolicyTree(model: IEmpowerPolicyTreeModel): void {
    if (
        model.schema !== EMPOWER_POLICY_TREE_SCHEMA ||
        model.features.join("\n") !== EMPOWER_ALLOCATION_FEATURES.join("\n")
    )
        throw new Error("Invalid Empower policy tree schema");
    const visit = (node: EmpowerPolicyTree, depth: number): void => {
        if (!node || depth > 3) throw new Error("Invalid Empower policy tree depth");
        if ("arm" in node) {
            if (!Number.isInteger(node.arm) || node.arm < 0 || node.arm > 6 || "feature" in node)
                throw new Error("Invalid Empower policy arm");
            return;
        }
        if (
            !Number.isInteger(node.feature) ||
            node.feature < 0 ||
            node.feature >= model.features.length ||
            !Number.isFinite(node.threshold)
        )
            throw new Error("Invalid Empower policy split");
        visit(node.left, depth + 1);
        visit(node.right, depth + 1);
    };
    visit(model.tree, 0);
}

export function predictEmpowerPolicyTree(tree: EmpowerPolicyTree, features: readonly number[]): number {
    let node = tree;
    while (!("arm" in node)) node = features[node.feature] <= node.threshold ? node.left : node.right;
    return node.arm;
}

/** An explicit research model is required; unsupported or partially funded setup retains the incumbent. */
export function selectEmpowerPolicyTree(
    model: IEmpowerPolicyTreeModel,
    budget: number,
    own: readonly number[],
    context: Readonly<IPlacementSetupDecisionContext> | undefined,
    incumbent: readonly ISetupAugmentChoice[],
): number {
    validateEmpowerPolicyTree(model);
    const features = empowerAllocationFeatures(budget, own, context);
    if (!features || !sameEmpowerAllocation(incumbent, empowerSetupPlan(budget, own, 0))) return 0;
    return predictEmpowerPolicyTree(model.tree, features);
}
