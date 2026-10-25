import { eligibleBacklineProtectorChoices } from "../ai/setup/creature_score";
import { draftContextAfterCreature, draftCreatureContinuation } from "../ai/setup/draft_continuations";
import { pickRankedLiveDraftCreature } from "../ai/setup/draft_ship";
import { rankedDraftRangedFloor } from "../ai/setup/draft_strength_prior";
import type { ILeagueGenome } from "./league_genome";
import type { IRankedDraftResearchChoices, IRankedDraftResearchContext } from "./ranked_draft_eval";

export const DRAFT_CAPACITY_RESEARCH_ID = "visible-ranged-capacity-v1";

export function draftRangedCapacityChoices(
    available: readonly number[],
    context: IRankedDraftResearchContext,
    floor: number,
): readonly number[] {
    if (!available.length || floor <= 0) return available;
    const maximum = available.map(
        (id) =>
            draftCreatureContinuation(
                [...context.ownCreatureIds, id],
                context.knownOpponentCreatureIds,
                draftContextAfterCreature(context.scouting, id),
                (unit) => unit.ranged,
            ).maximumCount,
    );
    const target = Math.min(floor, Math.max(...maximum));
    return available.filter((_, index) => maximum[index] >= target);
}

export function createCapacityResearchChoices(genome: ILeagueGenome): IRankedDraftResearchChoices {
    return {
        creature: (available, context, preferred) => {
            const eligible = draftRangedCapacityChoices(
                eligibleBacklineProtectorChoices(available, context.ownCreatureIds, context.knownOpponentCreatureIds),
                context,
                rankedDraftRangedFloor(genome.draftStrengthPolicy),
            );
            if (eligible.includes(preferred)) return preferred;
            return (
                pickRankedLiveDraftCreature(
                    genome,
                    eligible,
                    context.ownCreatureIds,
                    context.knownOpponentCreatureIds,
                    context.tier1ArtifactId,
                    context.scouting.map,
                    undefined,
                    context.tier2ArtifactId,
                    context.artifactFitVersion,
                ) ?? preferred
            );
        },
    };
}
