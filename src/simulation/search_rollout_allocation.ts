/*
 * This file is part of the common code of the Heroes of Crypto.
 * Licensed under the MIT license in the root directory of this source tree.
 */

export type SearchRolloutAllocation = "uniform" | "halving" | "validation";

export function parseSearchRolloutAllocation(raw: string | undefined): SearchRolloutAllocation {
    if (raw === undefined || raw === "uniform") return "uniform";
    if (raw === "halving" || raw === "validation") return raw;
    throw new Error("SEARCH_A19_ROLLOUT_ALLOCATION must be uniform, halving or validation");
}

/**
 * Two pilot samples per candidate, then four additional samples for at most half the candidates.
 * Candidate zero remains the policy anchor. Material breaks exact pilot-value ties before stable order.
 * This is heuristic elimination, not a dominance proof: a losing pilot can discard the true best move.
 */
export function selectSearchRolloutSurvivors(means: readonly number[], materials?: readonly number[]): number[] {
    if (means.length < 6 || (materials !== undefined && materials.length !== means.length)) {
        throw new Error("Search rollout allocation requires at least six candidates and aligned material evidence");
    }
    const ranked = means.flatMap((mean, index) => (index > 0 && Number.isFinite(mean) ? [index] : []));
    ranked.sort((left, right) => {
        const valueDifference = means[right] - means[left];
        if (valueDifference !== 0) return valueDifference;
        const leftMaterial = materials?.[left];
        const rightMaterial = materials?.[right];
        if (
            leftMaterial !== undefined &&
            rightMaterial !== undefined &&
            Number.isFinite(leftMaterial) &&
            Number.isFinite(rightMaterial) &&
            leftMaterial !== rightMaterial
        ) {
            return rightMaterial - leftMaterial;
        }
        return left - right;
    });
    return [0, ...ranked.slice(0, Math.floor(means.length / 2) - 1)].sort((left, right) => left - right);
}
