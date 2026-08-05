import { describe, expect, test } from "bun:test";

import {
    applyRankedDraftInteractionOverlay,
    rankedDraftBundleInteractionAffinity,
    rankedDraftInteractionBreakdown,
    RANKED_DRAFT_INTERACTION_EVIDENCE,
    RANKED_DRAFT_INTERACTION_PRIOR_SOURCE,
} from "../../src/ai/setup/draft_interaction_prior";
import { PBTypes } from "../../src/generated/protobuf/v1/types";

const Creature = PBTypes.CreatureVals;

describe("ranked draft interaction prior", () => {
    test("pins the confidence-gated 10,008-game live-ranked source artifact", () => {
        expect(RANKED_DRAFT_INTERACTION_PRIOR_SOURCE.games).toBe(10_008);
        expect(RANKED_DRAFT_INTERACTION_PRIOR_SOURCE.matchupPairs).toBe(5_004);
        expect(RANKED_DRAFT_INTERACTION_PRIOR_SOURCE.cohorts).toEqual(["ranked-draft"]);
        expect(RANKED_DRAFT_INTERACTION_EVIDENCE.allyPairs).toHaveLength(6);
        expect(RANKED_DRAFT_INTERACTION_EVIDENCE.counters).toHaveLength(16);
        expect(RANKED_DRAFT_INTERACTION_EVIDENCE.allyTrios).toHaveLength(0);
        expect(
            RANKED_DRAFT_INTERACTION_EVIDENCE.allyPairs.some(
                (row) =>
                    row.creatureIds.includes(Creature.ARBALESTER) &&
                    row.creatureIds.includes(Creature.BLACK_DRAGON) &&
                    row.conservativeLiftPp > 5,
            ),
        ).toBe(true);
    });

    test("uses own co-play and revealed counters without hidden opponent inputs", () => {
        const blackDragonWithArbalester = rankedDraftInteractionBreakdown(Creature.BLACK_DRAGON, {
            ownCreatureIds: [Creature.ARBALESTER],
        });
        expect(blackDragonWithArbalester.allyPair).toBeGreaterThan(0.5);

        const battleMageWithoutReveal = rankedDraftInteractionBreakdown(Creature.BATTLE_MAGE, {
            ownCreatureIds: [],
        });
        const battleMageAgainstRevealedAbomination = rankedDraftInteractionBreakdown(Creature.BATTLE_MAGE, {
            ownCreatureIds: [],
            knownOpponentCreatureIds: [Creature.ABOMINATION],
        });
        expect(battleMageWithoutReveal.counter).toBe(0);
        expect(battleMageAgainstRevealedAbomination.counter).toBeGreaterThan(0.3);
        expect(battleMageAgainstRevealedAbomination.total).toBeGreaterThan(battleMageWithoutReveal.total);

        const abominationWithBerserker = rankedDraftInteractionBreakdown(Creature.ABOMINATION, {
            ownCreatureIds: [Creature.BERSERKER],
        });
        expect(abominationWithBerserker.allyPair).toBeLessThan(0);
    });

    test("rewards a supported starter pair and only breaks close baseline offers", () => {
        expect(
            rankedDraftBundleInteractionAffinity([Creature.BERSERKER, Creature.WOLF_RIDER], {
                ownCreatureIds: [],
            }),
        ).toBeGreaterThan(0.28);

        const close = applyRankedDraftInteractionOverlay([1000, 960], [0, 0.29]);
        expect(close[1]).toBeGreaterThan(close[0]);
        const wide = applyRankedDraftInteractionOverlay([3325.8, 859.7], [0, 0.29]);
        expect(wide[0]).toBeGreaterThan(wide[1]);
    });
});
