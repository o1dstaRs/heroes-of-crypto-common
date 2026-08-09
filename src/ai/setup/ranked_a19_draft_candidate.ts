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

import { TIER1_ARTIFACT_WINRATE } from "../../ai/setup/setup_strategy";
import {
    createLeagueGenome,
    LEAGUE_ANCHOR_GENOME,
    LEAGUE_GENOME_LAYOUT,
    scoreLeagueGenomeCreature,
} from "../../simulation/league_genome";
import {
    applyCreatureRoleFitMultiplier,
    creatureRoleFitMultiplier,
    eligibleBacklineProtectorChoices,
} from "./creature_score";
import { pickCoherentDraftCreature } from "./draft_coherence";
import leagueRound1CandidateGenome from "./draft_genomes/league_round1_br_57de5a2d_candidate.json";
import { RANKED_DRAFT_INTERACTION_PRIOR_ID } from "./draft_interaction_prior";

export const RANKED_A19_DRAFT_CANDIDATE_ID = "ranked-calibrated-a19-v1" as const;
export const RANKED_A19_DRAFT_INTRINSIC_ANCHOR_BLEND = 0.2 as const;

const calibratedWeights = (): number[] => {
    const weights = [...leagueRound1CandidateGenome.weights];
    const { offset, length } = LEAGUE_GENOME_LAYOUT.draftIntrinsic;
    for (let index = 0; index < length; index += 1) {
        weights[offset + index] =
            (1 - RANKED_A19_DRAFT_INTRINSIC_ANCHOR_BLEND) * weights[offset + index] +
            RANKED_A19_DRAFT_INTRINSIC_ANCHOR_BLEND * LEAGUE_ANCHOR_GENOME[offset + index];
    }
    return weights;
};

export const RANKED_A19_DRAFT_CANDIDATE = createLeagueGenome(
    RANKED_A19_DRAFT_CANDIDATE_ID,
    calibratedWeights(),
    false,
    { draftInteractionPrior: RANKED_DRAFT_INTERACTION_PRIOR_ID },
);

export const rankedA19DraftCandidateScore = (creatureId: number): number =>
    scoreLeagueGenomeCreature(creatureId, [], [], RANKED_A19_DRAFT_CANDIDATE);

export function pickRankedA19DraftCandidateBundle(bundles: readonly (readonly [number, number, number])[]): number {
    let bestIndex = 0;
    let bestScore = -Infinity;
    bundles.forEach(([level1, level2, artifact], index) => {
        const score =
            rankedA19DraftCandidateScore(level1) +
            rankedA19DraftCandidateScore(level2) +
            (TIER1_ARTIFACT_WINRATE[artifact] ?? 50);
        if (score > bestScore) {
            bestIndex = index;
            bestScore = score;
        }
    });
    return bestIndex;
}

export function pickRankedA19DraftCandidateCreature(
    available: readonly number[],
    ownCreatureIds: readonly number[],
    knownOpponentCreatureIds: readonly number[],
    tier1ArtifactId?: number,
): number | undefined {
    const eligible = eligibleBacklineProtectorChoices(available, ownCreatureIds, knownOpponentCreatureIds);
    return pickCoherentDraftCreature(
        eligible,
        (creatureId) =>
            applyCreatureRoleFitMultiplier(
                rankedA19DraftCandidateScore(creatureId),
                creatureRoleFitMultiplier(creatureId, ownCreatureIds, knownOpponentCreatureIds),
            ),
        {
            ownCreatureIds,
            tier1ArtifactId,
            knownOpponentCreatureIds,
            draftInteractionPrior: RANKED_DRAFT_INTERACTION_PRIOR_ID,
        },
    );
}
