import { creatureInfo } from "../../ai/setup/creature_score";
import { pickRankedLiveDraftBundle, pickRankedLiveDraftCreature } from "../../ai/setup/draft_ship";
import type { RankedDraftSynergyVariants } from "../../ai/setup/draft_synergy_variants";
import type { ILeagueGenome } from "../league_genome";
import type { IRankedDraftResearchChoices, IRankedDraftResearchContext } from "../ranked_draft_eval";
import {
    doctrineDraftFeatures,
    predictDoctrineDraftGain,
    type DoctrineDraftModelVersion,
    type IDoctrineDraftChoice,
    type IDoctrineDraftModel,
    type ScoutingDoctrine,
} from "./doctrine_draft_model";

export interface IDoctrineDraftResearchDecision {
    readonly level: number;
    readonly preferred: number;
    readonly alternative: number;
    readonly features: readonly number[];
    readonly chosen: number;
}

export interface IDoctrineDraftResearchPolicyOptions {
    readonly doctrine: ScoutingDoctrine;
    readonly genome: ILeagueGenome;
    readonly synergyVariants?: RankedDraftSynergyVariants;
    readonly maskAdvanceInformation?: boolean;
    readonly onDecision?: (decision: IDoctrineDraftResearchDecision) => void;
}

/** Create once per draft seat, retaining the consumed override across hidden-pick collision retries. */
export function createDoctrineDraftResearchChoices(
    model: IDoctrineDraftModel,
    options: IDoctrineDraftResearchPolicyOptions,
): IRankedDraftResearchChoices {
    predictDoctrineDraftGain(model, new Array<number>(model.features.length).fill(0));
    if (!Number.isFinite(model.switchMargin)) throw new Error("Invalid doctrine draft switch margin");
    const version = model.schema.slice("hoc.ai.v0_9.doctrine_draft.".length) as DoctrineDraftModelVersion;
    const lastDecisionLevel = version === "v1" ? 2 : 3;
    let switched = false;
    const choose = (
        context: IRankedDraftResearchContext,
        preferred: number,
        alternative: number | undefined,
        base: IDoctrineDraftChoice,
        other: IDoctrineDraftChoice | undefined,
        level: number,
    ): number => {
        if (alternative === undefined || !other || switched || level > lastDecisionLevel) return preferred;
        const features = doctrineDraftFeatures(
            options.doctrine,
            context,
            base,
            other,
            level,
            options.maskAdvanceInformation ?? false,
            version,
        );
        if (!features) return preferred;
        switched = predictDoctrineDraftGain(model, features) > model.switchMargin;
        const chosen = switched ? alternative : preferred;
        options.onDecision?.({ level, preferred, alternative, features, chosen });
        return chosen;
    };
    return {
        bundle: (bundles, context, preferred) => {
            const remaining = bundles
                .map((bundle, index) => ({ bundle, index }))
                .filter((entry) => entry.index !== preferred);
            const other = remaining.length
                ? remaining[
                      pickRankedLiveDraftBundle(
                          options.genome,
                          remaining.map((entry) => entry.bundle),
                          options.synergyVariants,
                          context.artifactFitVersion,
                          context.scouting,
                      )
                  ]
                : undefined;
            return choose(
                context,
                preferred,
                other?.index,
                { creatureIds: bundles[preferred].slice(0, 2), tier1ArtifactId: bundles[preferred][2] },
                other ? { creatureIds: other.bundle.slice(0, 2), tier1ArtifactId: other.bundle[2] } : undefined,
                0,
            );
        },
        creature: (available, context, preferred) => {
            const level = creatureInfo(preferred)?.level ?? 4;
            if (level > lastDecisionLevel) return preferred;
            const alternative = pickRankedLiveDraftCreature(
                options.genome,
                available.filter((id) => id !== preferred),
                context.ownCreatureIds,
                context.knownOpponentCreatureIds,
                context.tier1ArtifactId,
                context.scouting.map,
                options.synergyVariants,
                context.tier2ArtifactId,
                context.artifactFitVersion,
                context.scouting,
            );
            return choose(
                context,
                preferred,
                alternative,
                { creatureIds: [preferred] },
                alternative === undefined ? undefined : { creatureIds: [alternative] },
                level,
            );
        },
    };
}
