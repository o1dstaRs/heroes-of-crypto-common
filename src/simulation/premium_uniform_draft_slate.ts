import { createHistoricalFinalPickAdvisor } from "../ai/setup/draft_matchup_pick";
import type { IDraftMatchupModel } from "../ai/setup/draft_matchup_value";
import { makeRng } from "./army";
import type { MatchedDraftView } from "./premium_matched_draft_model";

/** Research sampling only. Both challengers are uniform legal picks, independent of prior scores. */
export function createUniformMatchedDraftSlate(historical: IDraftMatchupModel) {
    const validate = createHistoricalFinalPickAdvisor(historical);
    return (view: MatchedDraftView, ownTeam: number, incumbent: number, selectionSeed: number) => {
        if (
            view.doctrine !== 2 ||
            !Number.isSafeInteger(selectionSeed) ||
            selectionSeed < 0 ||
            selectionSeed > 0xffffffff
        )
            return null;
        const scored = validate(view, ownTeam, incumbent);
        if (!scored) return null;
        const remaining = scored.choices
            .map((c) => c.creatureId)
            .filter((id) => id !== incumbent)
            .sort((a, b) => a - b);
        if (remaining.length < 2) return null;
        const rng = makeRng(selectionSeed);
        const sampled = [...remaining];
        for (let i = 0; i < 2; i++) {
            const j = i + Math.floor(rng() * (sampled.length - i));
            [sampled[i], sampled[j]] = [sampled[j], sampled[i]];
        }
        return {
            creatureIds: [incumbent, sampled[0], sampled[1]] as [number, number, number],
            inclusionProbabilities: [...view.availableCreatureIds]
                .sort((a, b) => a - b)
                .map((id) => ({
                    creatureId: id,
                    probability: id === incumbent ? 1 : 2 / remaining.length,
                })),
            historicalScores: scored.choices,
        };
    };
}
