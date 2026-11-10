import { expect, test } from "bun:test";
import { creatureInfo } from "../../src/ai/setup/creature_score";
import {
    CONTEXTUAL_DRAFT_FEATURE_NAMES,
    CONTEXTUAL_DRAFT_SCHEMA,
    CONTEXTUAL_DRAFT_FEATURE_SCHEMA,
    type IContextualDraftModel,
} from "../../src/simulation/contextual_draft_research";
import { createContextualDraftChoices } from "../../src/simulation/contextual_draft_battles";
import {
    resolveRankedDraftPick,
    rankedDraftStrengthCandidate,
    permuteRankedDraftSeed,
} from "../../src/simulation/ranked_draft_eval";
import { V09_DEFAULT_DRAFT_BASE_POLICY_SPEC } from "../../src/ai/setup/doctrine_draft_policy";
import { createLockedDoctrineDraftResearchChoices } from "../../src/simulation/v0_9/doctrine_draft_checkpoint";
import { synergyVariantsForSeed } from "../../src/synergies/synergy_properties";

const zero: IContextualDraftModel = {
    schema: CONTEXTUAL_DRAFT_SCHEMA,
    featureSchema: CONTEXTUAL_DRAFT_FEATURE_SCHEMA,
    features: CONTEXTUAL_DRAFT_FEATURE_NAMES,
    weights: CONTEXTUAL_DRAFT_FEATURE_NAMES.map(() => 0),
    margin: 0.02,
    information: "full",
    productionPromotion: false,
};

test("a neutral contextual head reproduces the complete locked draft, including collision retries", () => {
    const genome = rankedDraftStrengthCandidate(V09_DEFAULT_DRAFT_BASE_POLICY_SPEC);
    for (const seed of [381100401, 381100409, 381100417]) {
        const variants = synergyVariantsForSeed("contextual-test-" + seed);
        for (const doctrine of ["see-all", "three-reveals", "see-none"] as const) {
            const run = (candidate: ReturnType<typeof createContextualDraftChoices>) =>
                resolveRankedDraftPick(
                    permuteRankedDraftSeed(seed),
                    genome,
                    genome,
                    {},
                    {
                        liveDraftRules: true,
                        liveSequentialBundles: true,
                        gridType: 4,
                        synergyVariants: variants,
                        researchDraftChoicesByTeam: { 1: candidate },
                    },
                );
            const reference = run(
                createLockedDoctrineDraftResearchChoices({ genome, doctrine, synergyVariants: variants }),
            );
            const trial = run(
                createContextualDraftChoices({
                    doctrine,
                    synergyVariants: variants,
                    targetLevel: 0,
                    mode: "model",
                    model: zero,
                }),
            );
            expect(trial).toEqual(reference);
        }
    }
});

test("forced training forks use one legal target-level intervention from public projections", () => {
    const genome = rankedDraftStrengthCandidate(V09_DEFAULT_DRAFT_BASE_POLICY_SPEC);
    for (let targetLevel = 0; targetLevel <= 4; targetLevel++) {
        const decisions: {
            level: number;
            chosen: number;
            preferred: number;
            context: { scouting: { map?: number }; ownCreatureIds: readonly number[] };
        }[] = [];
        const policy = createContextualDraftChoices({
            doctrine: "see-none",
            synergyVariants: synergyVariantsForSeed("contextual-fork-" + targetLevel),
            targetLevel,
            mode: "fork",
            recordTrainingDecision: true,
            onDecision: (decision) => decisions.push(decision),
        });
        resolveRankedDraftPick(
            permuteRankedDraftSeed(381100521 + targetLevel),
            genome,
            genome,
            {},
            {
                liveDraftRules: true,
                liveSequentialBundles: true,
                gridType: 3,
                researchDraftChoicesByTeam: { 1: policy },
            },
        );
        expect(decisions.length).toBe(1);
        expect(decisions[0].level).toBe(targetLevel);
        expect(decisions[0].chosen).not.toBe(decisions[0].preferred);
        if (targetLevel > 0) expect(creatureInfo(decisions[0].chosen)?.level).toBe(targetLevel);
        expect(decisions[0].context.scouting.map).toBe(targetLevel < 3 ? undefined : 3);
    }
});
