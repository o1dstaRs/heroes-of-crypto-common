/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */

import type { GameAction } from "../../engine/actions";

export const V08_A19_SCORED_ARBITRATION_POLICY = Object.freeze({
    schema: "hoc.v0_8_a19_scored_arbitration.v1" as const,
    valueGain: 0.01,
    preserveNativeCombatOnZeroTie: true as const,
});

interface IScoredCandidate {
    readonly actions: readonly GameAction[];
}

/**
 * Arbitrate an already scored shortlist before the urgent finish tier. Target-pressure preferences may
 * break ties, but cannot discard a materially better rollout. When every legal rollout loses, preserve
 * an executable native combat action rather than replacing it with an equally losing decoy.
 *
 * Candidate zero is the native incumbent. This uses only restored rollout means; it adds no simulations
 * and consumes no random numbers.
 */
export function selectV08A19ScoredCandidateIndex(
    candidates: readonly IScoredCandidate[],
    means: readonly number[],
    selectedIndex: number,
    incumbent: readonly GameAction[],
): number {
    if (
        candidates.length !== means.length ||
        selectedIndex < 0 ||
        selectedIndex >= candidates.length ||
        !Number.isFinite(means[selectedIndex])
    ) {
        return selectedIndex;
    }
    if (
        Number.isFinite(means[0]) &&
        means.every((mean) => !Number.isFinite(mean) || mean === 0) &&
        incumbent.some(
            (action) =>
                action.type === "range_attack" || action.type === "melee_attack" || action.type === "cast_spell",
        )
    ) {
        return 0;
    }
    let bestIndex = selectedIndex;
    for (let index = 0; index < candidates.length; index += 1) {
        if (Number.isFinite(means[index]) && means[index] > means[bestIndex]) bestIndex = index;
    }
    return means[bestIndex] - means[selectedIndex] >= V08_A19_SCORED_ARBITRATION_POLICY.valueGain
        ? bestIndex
        : selectedIndex;
}
