import { expect, test } from "bun:test";
import { predictEmpowerPolicyTree } from "../../src/ai/setup/empower_policy_tree";
import { fitEmpowerPolicyTree, type IEmpowerPolicyExample } from "../../src/simulation/empower_policy_tree_training";

const recipe = { depth: 2, minimumBoards: 4, uncertaintyPenalty: 1, margin: 0.01 };

test("paired policy learning discovers different funding decisions and preserves the no-change action", () => {
    const rows: IEmpowerPolicyExample[] = Array.from({ length: 60 }, (_, board) => {
        const group = board % 3;
        return {
            board,
            features: [group],
            gains: [0, group === 0 ? 0.5 : -0.5, -0.5, -0.5, group === 2 ? 0.5 : -0.5, -0.5, -0.5],
        };
    });
    const tree = fitEmpowerPolicyTree(rows, recipe);
    expect([0, 1, 2].map((x) => predictEmpowerPolicyTree(tree, [x]))).toEqual([1, 0, 4]);
    expect(fitEmpowerPolicyTree(rows, recipe)).toEqual(tree);
});

test("two correlated assignments cannot masquerade as enough independent boards to split", () => {
    const rows: IEmpowerPolicyExample[] = Array.from({ length: 6 }, (_, board) =>
        Array.from({ length: 2 }, () => ({
            board,
            features: [board % 2],
            gains: [0, board % 2 ? 0.5 : -0.5, 0, 0, 0, 0, 0],
        })),
    ).flat();
    expect(fitEmpowerPolicyTree(rows, recipe)).toEqual({ arm: 0 });
});

test("unfavorable evidence retains the incumbent and invalid labels are rejected", () => {
    const rows = Array.from({ length: 20 }, (_, board) => ({
        board,
        features: [board],
        gains: [0, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5],
    }));
    expect(fitEmpowerPolicyTree(rows, recipe)).toEqual({ arm: 0 });
    expect(() => fitEmpowerPolicyTree([{ ...rows[0], gains: [1, 0, 0, 0, 0, 0, 0] }], recipe)).toThrow();
});
