import { expect, test } from "bun:test";
import {
    EMPOWER_POLICY_TREE_SCHEMA,
    selectEmpowerPolicyTree,
    validateEmpowerPolicyTree,
    type IEmpowerPolicyTreeModel,
} from "../../src/ai/setup/empower_policy_tree";
import { EMPOWER_ALLOCATION_FEATURES, empowerAllocationPlan } from "../../src/ai/setup/empower_allocation";
import { empowerSetupPlan } from "../../src/ai/setup/empower_setup";
import type { IPlacementSetupDecisionContext } from "../../src/ai/setup/setup_strategy";

const own = [49, 1, 55, 4, 8, 57];
const context: IPlacementSetupDecisionContext = {
    decisionPhase: "placement",
    opponentRosterVisibility: "complete",
    publicOpponentCreatureIds: [2, 3, 14, 5, 18, 9],
    gridType: 1,
    gridSize: 16,
    ownDoctrine: 3,
    ownArtifactIds: [1, 1],
    synergyVariants: { Life: 1, Chaos: 1, Might: 1, Nature: 1 },
};
const model: IEmpowerPolicyTreeModel = {
    schema: EMPOWER_POLICY_TREE_SCHEMA,
    features: EMPOWER_ALLOCATION_FEATURES,
    tree: { arm: 4 },
};

test("explicit policy trees preserve legal budgets and abstain on private, partial, and manually funded setup", () => {
    const incumbent = empowerSetupPlan(7, own, 0);
    expect(selectEmpowerPolicyTree(model, 7, own, context, incumbent)).toBe(4);
    expect(empowerAllocationPlan(7, own, incumbent, 4).reduce((sum, choice) => sum + choice.value, 0)).toBe(7);
    expect(selectEmpowerPolicyTree(model, 7, own, { ...context, opponentRosterVisibility: "partial" }, incumbent)).toBe(
        0,
    );
    expect(selectEmpowerPolicyTree(model, 6, own, context, empowerSetupPlan(6, own, 0))).toBe(0);
    expect(selectEmpowerPolicyTree(model, 7, own, context, [{ kind: "Empower", value: 1 }])).toBe(0);
    expect(
        selectEmpowerPolicyTree(model, 7, own, context, [
            { kind: "Placement", value: 1 },
            { kind: "Sniper", value: 3 },
            { kind: "Armor", value: 3 },
        ]),
    ).toBe(0);
});

test("malformed or over-deep research models cannot change spending", () => {
    expect(() => validateEmpowerPolicyTree({ ...model, tree: { arm: 7 } })).toThrow();
    expect(() =>
        validateEmpowerPolicyTree({
            ...model,
            tree: { feature: 9999, threshold: 0, left: { arm: 0 }, right: { arm: 1 } },
        }),
    ).toThrow();
    let tree = model.tree;
    for (let i = 0; i < 4; i += 1) tree = { feature: 0, threshold: 0.5, left: tree, right: { arm: 0 } };
    expect(() => validateEmpowerPolicyTree({ ...model, tree })).toThrow();
});
