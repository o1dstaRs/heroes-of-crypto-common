import { createHash } from "node:crypto";
import savedModel from "../../simulation/checkpoints/contextual_draft_20261110/full-model.json";
import {
    contextualDraftFeatures,
    predictContextualDraft,
    validateContextualDraftModel,
    type IContextualDraftContext,
    type IContextualDraftModel,
} from "../../simulation/contextual_draft_research";
import type { ILeagueGenome } from "../../simulation/league_genome";
import type { IDoctrineDraftCandidate, IDoctrineDraftDecision } from "./doctrine_draft_policy";
import { pickDraftGenomeCreature, pickRankedLiveDraftBundle } from "./draft_ship";

export const A19_CONTEXTUAL_DRAFT_MODEL_ID = "contextual-draft-063a888e-20261114-user-adoption";
export const A19_CONTEXTUAL_DRAFT_MODEL_SHA256 = "063a888e6e38fe4322e89385929ac8f21dcb7b7f0dd5db070cb46a44a95eeeba";
const model = savedModel as IContextualDraftModel;
validateContextualDraftModel(model);
if (createHash("sha256").update(JSON.stringify(model)).digest("hex") !== A19_CONTEXTUAL_DRAFT_MODEL_SHA256)
    throw new Error("Changed adopted A19 contextual draft checkpoint");
Object.freeze(model.features);
Object.freeze(model.weights);
Object.freeze(model);

/** Explicit user adoption; the immutable checkpoint still records its failed historical qualification. */
export function selectA19ContextualDraftChoice(input: {
    context: IContextualDraftContext;
    preferred: IDoctrineDraftCandidate;
    alternative?: IDoctrineDraftCandidate;
    level: number;
    overrideUsed: boolean;
}): IDoctrineDraftDecision {
    if (input.overrideUsed || !input.alternative) return { choice: input.preferred.id, consumeOverride: false };
    const features = contextualDraftFeatures(input.context, input.preferred, input.alternative, input.level);
    if (!features) return { choice: input.preferred.id, consumeOverride: false };
    const consumeOverride = predictContextualDraft(model, features) > model.margin;
    return { choice: consumeOverride ? input.alternative.id : input.preferred.id, consumeOverride, features };
}

/** Call after V3. Its separate consumption must be committed even when this head reverses V3's choice. */
export function createA19ContextualDraftPolicy(genome: ILeagueGenome) {
    return Object.freeze({
        modelId: A19_CONTEXTUAL_DRAFT_MODEL_ID,
        bundle: (
            bundles: readonly (readonly [number, number, number])[],
            preferred: number,
            context: IContextualDraftContext,
            overrideUsed: boolean,
        ) => {
            if (overrideUsed || !bundles[preferred]) return { choice: preferred, consumeOverride: false };
            const remaining = bundles.map((bundle, id) => ({ bundle, id })).filter((entry) => entry.id !== preferred);
            const other = remaining.length
                ? remaining[
                      pickRankedLiveDraftBundle(
                          genome,
                          remaining.map((entry) => entry.bundle),
                          context.synergyVariants,
                          context.artifactFitVersion,
                          context.scouting,
                      )
                  ]
                : undefined;
            return selectA19ContextualDraftChoice({
                context,
                preferred: {
                    id: preferred,
                    creatureIds: bundles[preferred].slice(0, 2),
                    tier1ArtifactId: bundles[preferred][2],
                },
                alternative: other
                    ? { id: other.id, creatureIds: other.bundle.slice(0, 2), tier1ArtifactId: other.bundle[2] }
                    : undefined,
                level: 0,
                overrideUsed,
            });
        },
        creature: (
            available: readonly number[],
            preferred: number,
            context: IContextualDraftContext,
            level: number,
            overrideUsed: boolean,
        ) => {
            if (overrideUsed) return { choice: preferred, consumeOverride: false };
            const other = pickDraftGenomeCreature(
                genome,
                available.filter((id) => id !== preferred),
                context.ownCreatureIds,
                context.knownOpponentCreatureIds,
                context.tier1ArtifactId,
                context.scouting.map,
            );
            return selectA19ContextualDraftChoice({
                context,
                preferred: { id: preferred, creatureIds: [preferred] },
                alternative: other === undefined ? undefined : { id: other, creatureIds: [other] },
                level,
                overrideUsed,
            });
        },
    });
}
