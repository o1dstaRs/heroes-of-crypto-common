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

export type A19MaterialArbitrationMode = "ties" | "loss-edge" | "both-edges" | "sample-ties" | "sample-relative";

export const V08_A19_MATERIAL_ARBITRATION_POLICY = Object.freeze({
    schema: "hoc.v0_8_a19_material_arbitration.v3" as const,
    materialGain: 0.001,
    probabilityEdgeCap: 0.01,
    sampledOutcomeFraction: 0.5,
    materialSmoothing: 1000,
    primarySampleTolerance: 1,
    primaryRelativeTolerance: 0.25,
});

/** Secondary evidence from existing rollouts, with explicit limits on forecast tradeoffs. */
export function selectV08A19MaterialCandidateIndex(
    candidates: readonly { readonly actions: readonly GameAction[] }[],
    means: readonly number[],
    materials: readonly number[],
    selectedIndex: number,
    rolloutCount: number,
    mode: A19MaterialArbitrationMode,
    lowEvidenceWinningSamples = 1,
): number {
    if (
        candidates.length !== means.length ||
        means.length !== materials.length ||
        !Number.isInteger(selectedIndex) ||
        selectedIndex < 0 ||
        selectedIndex >= candidates.length ||
        !Number.isFinite(means[selectedIndex]) ||
        !Number.isFinite(materials[selectedIndex]) ||
        !Number.isInteger(rolloutCount) ||
        rolloutCount < 1 ||
        !Number.isInteger(lowEvidenceWinningSamples) ||
        lowEvidenceWinningSamples < 1 ||
        lowEvidenceWinningSamples > 8
    )
        return selectedIndex;

    let maximum = -Infinity;
    for (const mean of means) if (Number.isFinite(mean)) maximum = Math.max(maximum, mean);
    const cutoff = Math.min(
        V08_A19_MATERIAL_ARBITRATION_POLICY.probabilityEdgeCap,
        V08_A19_MATERIAL_ARBITRATION_POLICY.sampledOutcomeFraction / rolloutCount,
    );
    const chooseMaterial = (selected: number, eligible: (index: number) => boolean): number => {
        let best = selected;
        for (let index = 0; index < candidates.length; index += 1) {
            if (
                candidates[index].actions.length > 0 &&
                Number.isFinite(means[index]) &&
                Number.isFinite(materials[index]) &&
                eligible(index) &&
                materials[index] > materials[best]
            )
                best = index;
        }
        return materials[best] - materials[selected] >= V08_A19_MATERIAL_ARBITRATION_POLICY.materialGain
            ? best
            : selected;
    };
    const tied =
        means[selectedIndex] === maximum
            ? chooseMaterial(selectedIndex, (index) => means[index] === maximum)
            : selectedIndex;
    const hopeless = mode !== "ties" && maximum < cutoff;
    const confident = mode === "both-edges" && means[tied] > 1 - cutoff;
    const edged = hopeless || confident ? chooseMaterial(tied, (index) => hopeless || means[index] > 1 - cutoff) : tied;
    if (mode !== "sample-ties" && mode !== "sample-relative") return edged;
    const oneSample = V08_A19_MATERIAL_ARBITRATION_POLICY.primarySampleTolerance / rolloutCount;
    const lowEvidenceLimit =
        lowEvidenceWinningSamples === 1 ? oneSample : Math.min(0.1, lowEvidenceWinningSamples / rolloutCount);
    const lowEvidence = mode === "sample-relative" && maximum < lowEvidenceLimit;
    const tolerance =
        mode === "sample-relative"
            ? Math.min(oneSample, maximum * V08_A19_MATERIAL_ARBITRATION_POLICY.primaryRelativeTolerance)
            : oneSample;
    const minimum = lowEvidence ? -Infinity : maximum - tolerance - 1e-12;
    if (means[edged] < minimum) return edged;
    return chooseMaterial(edged, (index) => means[index] >= minimum);
}
