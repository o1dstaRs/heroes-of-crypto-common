import { creatureInfo } from "../ai/setup/creature_score";
import { draftContextAfterCreature, draftFactionContinuations } from "../ai/setup/draft_continuations";
import { pickRankedLiveDraftCreature } from "../ai/setup/draft_ship";
import { rankedDraftUnitSynergyLiftPp } from "../ai/setup/draft_strength_prior";
import type { IDraftScoutingContext } from "../picks/draft_visibility";
import type { ILeagueGenome } from "./league_genome";
import type { IRankedDraftResearchChoices, IRankedDraftResearchContext } from "./ranked_draft_eval";

export const DRAFT_SCOUTING_RESEARCH_ID = "visible-continuations-map-residual-v1";

const mapResidual = (id: number, map: number): number =>
    Math.max(-5, Math.min(5, rankedDraftUnitSynergyLiftPp(id, map) - rankedDraftUnitSynergyLiftPp(id)));

/** Experimental only. The old map fit supplies a bounded residual, never a current win probability. */
export function scoutingResearchPlanValue(
    roster: readonly number[],
    enemy: readonly number[],
    scouting: IDraftScoutingContext,
): number {
    const paths = draftFactionContinuations(roster, enemy, scouting).filter((path) => path.count % 2 === 1);
    let value = -0.08 * paths.filter((path) => !path.reachable).length;
    if (scouting.map !== undefined) {
        value += roster.reduce((sum, id) => sum + mapResidual(id, scouting.map!), 0) * 0.02;
        for (const path of paths.filter((entry) => entry.reachable)) {
            const residuals = path.creatureIds.map((id) => mapResidual(id, scouting.map!));
            value += Math.max(0, ...residuals) * 0.01;
        }
    }
    return value;
}

export function createScoutingResearchChoices(genome: ILeagueGenome): IRankedDraftResearchChoices {
    const plan = (roster: readonly number[], context: IRankedDraftResearchContext, scouting = context.scouting) =>
        scoutingResearchPlanValue(roster, context.knownOpponentCreatureIds, scouting);
    return {
        bundle: (bundles, context, preferred) => {
            let chosen = preferred;
            let value = plan(bundles[preferred].slice(0, 2), context) + 0.04;
            bundles.forEach((bundle, index) => {
                const candidate = plan(bundle.slice(0, 2), context);
                if (candidate > value) {
                    value = candidate;
                    chosen = index;
                }
            });
            return chosen;
        },
        creature: (available, context, preferred) => {
            const other = pickRankedLiveDraftCreature(
                genome,
                available.filter((id) => id !== preferred),
                context.ownCreatureIds,
                context.knownOpponentCreatureIds,
                context.tier1ArtifactId,
                context.scouting.map,
                undefined,
                context.tier2ArtifactId,
                context.artifactFitVersion,
            );
            if (other === undefined || !creatureInfo(preferred)) return preferred;
            const current = plan(
                [...context.ownCreatureIds, preferred],
                context,
                draftContextAfterCreature(context.scouting, preferred),
            );
            const alternative = plan(
                [...context.ownCreatureIds, other],
                context,
                draftContextAfterCreature(context.scouting, other),
            );
            return alternative > current + 0.04 ? other : preferred;
        },
    };
}
