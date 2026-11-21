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

import { TIER2_ARTIFACT_LIST, Tier2Artifact } from "../../artifacts/artifact_properties";
import { tier2ArtifactHasBeneficiary } from "./artifact_fit";
import { creatureInfo } from "./creature_score";
import type { ITier2ArtifactDecisionContext } from "./setup_strategy";

export { A19_TIER2_STRIKER_POLICY } from "./a19_tier2_striker_identity";

/**
 * Tier-2 pick for a striker army (A19 profile v20, docs/tier2_striker_adoption.md).
 *
 * Since the striker draft (profile v15) the default fields armies with fewer than two ranged stacks, and those read
 * the v0.7 melee table, measured before the rush existed: Crown of Command is its lowest entry. The five newer
 * artifacts get forecast scores from artifact-fit-v8 instead of a measurement. Playing every usable offer on the
 * same tasks showed both: Crown wins the rush (+1 movement) and loses the melee mirror, and the five forecast
 * artifacts sit below the established ones for these armies.
 */
export const A19_TIER2_STRIKER_MAX_RANGED = 1;
/** Crown of Command is taken below this opponent melee probability (the matchup head's estimate). */
export const A19_TIER2_STRIKER_CROWN_MAX_MELEE_PROBABILITY = 0.8;
/** The artifacts artifact-fit-v8 scores with a forecast rather than a measured table entry. */
export const A19_TIER2_FORECAST_ARTIFACTS: ReadonlySet<number> = new Set([
    Tier2Artifact.ARCHMAGES_RING,
    Tier2Artifact.AEGIS_OF_THE_ARCANE,
    Tier2Artifact.QUIVER_OF_ECHOES,
    Tier2Artifact.GRAVECHAIN,
    Tier2Artifact.LAST_FUSE,
]);
const LIVE_TIER2_IDS: ReadonlySet<number> = new Set(TIER2_ARTIFACT_LIST.map((artifact) => artifact.id));

export interface IA19Tier2StrikerDecision {
    /** The usable offered artifacts (beneficiary rule applied). */
    readonly usable: readonly number[];
    /** Ranged stacks among the seat's known creatures. */
    readonly ownRanged: number;
    /** Probability that the opponent ends with four or more strikers, from what the seat may legally see. */
    readonly meleeProbability: number;
    /** The artifact-fit-v8 choice. */
    readonly shipped: number;
    /** The shipped policy's choice among a subset (used for the established artifacts). */
    readonly pickEstablished: (established: readonly number[]) => number;
}

/** The rule itself, on explicit inputs (also the parity fixture's entry point). */
export function a19Tier2StrikerDecision(input: Readonly<IA19Tier2StrikerDecision>): number {
    if (input.ownRanged > A19_TIER2_STRIKER_MAX_RANGED || !input.usable.length) return input.shipped;
    if (
        input.usable.includes(Tier2Artifact.CROWN_OF_COMMAND) &&
        input.meleeProbability < A19_TIER2_STRIKER_CROWN_MAX_MELEE_PROBABILITY
    ) {
        return Tier2Artifact.CROWN_OF_COMMAND;
    }
    if (A19_TIER2_FORECAST_ARTIFACTS.has(input.shipped)) {
        const established = input.usable.filter((id) => !A19_TIER2_FORECAST_ARTIFACTS.has(id));
        if (established.length) return input.pickEstablished(established);
    }
    return input.shipped;
}

/**
 * The rule for a live decision: `shipped` is the seat's artifact-fit-v8 choice over `offered`, `pickEstablished`
 * the same policy over a subset. An empty roster gives no verdict and keeps the shipped choice.
 */
export function a19Tier2StrikerArtifact(
    offered: readonly number[],
    ownIds: readonly number[],
    context: Readonly<ITier2ArtifactDecisionContext> | undefined,
    meleeProbability: number,
    shipped: number,
    pickEstablished: (established: readonly number[]) => number,
): number {
    const own = [...new Set(ownIds)].flatMap((id) => creatureInfo(id) ?? []);
    if (!own.length) return shipped;
    const usable = offered.filter(
        (id) => LIVE_TIER2_IDS.has(id) && tier2ArtifactHasBeneficiary(id, ownIds, context?.ownProspectiveCreatureIds),
    );
    return a19Tier2StrikerDecision({
        usable,
        ownRanged: own.filter((unit) => unit.ranged).length,
        meleeProbability,
        shipped,
        pickEstablished,
    });
}
