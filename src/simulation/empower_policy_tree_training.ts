import type { EmpowerPolicyTree } from "../ai/setup/empower_policy_tree";

export interface IEmpowerPolicyExample {
    board: number;
    features: readonly number[];
    gains: readonly number[];
}
export interface IEmpowerPolicyTreeRecipe {
    depth: number;
    minimumBoards: number;
    uncertaintyPenalty: number;
    margin: number;
}

/** Whole-board uncertainty, including both army assignments when they reach the same leaf. */
function leaf(rows: readonly IEmpowerPolicyExample[], recipe: IEmpowerPolicyTreeRecipe) {
    const byBoard = new Map<number, number[]>();
    for (const row of rows) {
        const sums = byBoard.get(row.board) ?? Array<number>(7).fill(0);
        row.gains.forEach((value, arm) => (sums[arm] += value));
        byBoard.set(row.board, sums);
    }
    const n = byBoard.size;
    let arm = 0,
        value = 0;
    let heterogeneity = 0;
    for (let candidate = 1; candidate <= 6; candidate += 1) {
        const total = rows.reduce((sum, row) => sum + row.gains[candidate], 0);
        const squared = [...byBoard.values()].reduce((sum, gains) => sum + gains[candidate] ** 2, 0);
        const error = n > 1 ? Math.sqrt(Math.max(0, (n / (n - 1)) * (squared - total ** 2 / n))) : Infinity;
        const conservative = total - recipe.uncertaintyPenalty * error - recipe.margin * rows.length;
        if (conservative > value) {
            arm = candidate;
            value = conservative;
        }
        heterogeneity += total ** 2 / Math.max(1, rows.length);
    }
    return { arm, value, heterogeneity, boards: n };
}

/** Fit action choices directly to paired gains. Every threshold and leaf is learned on the supplied fold only. */
export function fitEmpowerPolicyTree(
    rows: readonly IEmpowerPolicyExample[],
    recipe: IEmpowerPolicyTreeRecipe,
): EmpowerPolicyTree {
    if (
        !Number.isInteger(recipe.depth) ||
        recipe.depth < 1 ||
        recipe.depth > 3 ||
        !Number.isInteger(recipe.minimumBoards) ||
        recipe.minimumBoards < 2 ||
        !Number.isFinite(recipe.uncertaintyPenalty) ||
        recipe.uncertaintyPenalty < 0 ||
        !Number.isFinite(recipe.margin) ||
        recipe.margin < 0 ||
        !rows.length
    )
        throw new Error("Invalid Empower policy training recipe");
    const width = rows[0].features.length;
    for (const row of rows)
        if (
            !Number.isSafeInteger(row.board) ||
            row.features.length !== width ||
            row.features.some((value) => !Number.isFinite(value)) ||
            row.gains.length !== 7 ||
            row.gains[0] !== 0 ||
            row.gains.some((value) => !Number.isFinite(value) || Math.abs(value) > 1)
        )
            throw new Error("Invalid paired Empower training row");
    const grow = (subset: readonly IEmpowerPolicyExample[], depth: number): EmpowerPolicyTree => {
        const current = leaf(subset, recipe);
        if (depth === recipe.depth || current.boards < 2 * recipe.minimumBoards) return { arm: current.arm };
        let best:
            | { feature: number; threshold: number; left: IEmpowerPolicyExample[]; right: IEmpowerPolicyExample[] }
            | undefined;
        let value = current.value,
            heterogeneity = current.heterogeneity;
        for (let feature = 0; feature < width; feature += 1) {
            const values = [...new Set(subset.map((row) => row.features[feature]))].sort((a, b) => a - b);
            const indices =
                values.length <= 9
                    ? values.slice(1).map((_, index) => index + 1)
                    : [
                          ...new Set(
                              [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875].map((q) => Math.floor(q * values.length)),
                          ),
                      ];
            for (const index of indices) {
                const threshold = (values[index - 1] + values[index]) / 2;
                const left = subset.filter((row) => row.features[feature] <= threshold);
                const right = subset.filter((row) => row.features[feature] > threshold);
                const a = leaf(left, recipe),
                    b = leaf(right, recipe);
                if (a.boards < recipe.minimumBoards || b.boards < recipe.minimumBoards) continue;
                const proposed = a.value + b.value,
                    variation = a.heterogeneity + b.heterogeneity;
                if (
                    proposed > value + 1e-12 ||
                    (Math.abs(proposed - value) <= 1e-12 && variation > heterogeneity + 1e-12)
                ) {
                    best = { feature, threshold, left, right };
                    value = proposed;
                    heterogeneity = variation;
                }
            }
        }
        if (!best) return { arm: current.arm };
        const left = grow(best.left, depth + 1),
            right = grow(best.right, depth + 1);
        if ("arm" in left && "arm" in right && left.arm === right.arm) return left;
        return { feature: best.feature, threshold: best.threshold, left, right };
    };
    return grow(rows, 0);
}
