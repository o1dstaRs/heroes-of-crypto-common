import { describe, expect, test } from "bun:test";

import {
    decideRankedDraftVariety,
    pickRankedDraftVarietyCreature,
    RANKED_DRAFT_VARIETY_MAX_SCORE_REGRET,
    RANKED_DRAFT_VARIETY_OWN_CREATURE_COUNT,
} from "../../src/ai/setup/draft_variety";
import { Tier1Artifact } from "../../src/artifacts/artifact_properties";
import { PBTypes } from "../../src/generated/protobuf/v1/types";

const Creature = PBTypes.CreatureVals;

describe("ranked draft variety", () => {
    test("uses a public artifact build plan to break a genuinely close offer", () => {
        const available = [Creature.HYDRA, Creature.TSAR_CANNON];
        const scores = [1, 1 - RANKED_DRAFT_VARIETY_MAX_SCORE_REGRET / 2];
        const context = {
            ownCreatureIds: [Creature.BERSERKER, Creature.SQUIRE, Creature.ORC, Creature.CENTAUR],
            tier1ArtifactId: Tier1Artifact.HUNTERS_LONGBOW,
        };
        const decision = decideRankedDraftVariety(available, scores, context);

        expect(decision.argmaxCreatureId).toBe(Creature.HYDRA);
        expect(decision.desiredArchetype).toBe("ranged");
        expect(decision.creatureId).toBe(Creature.TSAR_CANNON);
        expect(decision.changedFromArgmax).toBeTrue();
        expect(pickRankedDraftVarietyCreature(available, scores, context)).toBe(Creature.TSAR_CANNON);
    });

    test("never spends more score than the fixed regret bound", () => {
        const available = [Creature.HYDRA, Creature.TSAR_CANNON];
        const scores = [1, 1 - RANKED_DRAFT_VARIETY_MAX_SCORE_REGRET - 0.0001];
        const decision = decideRankedDraftVariety(available, scores, {
            ownCreatureIds: [Creature.BERSERKER, Creature.SQUIRE, Creature.ORC, Creature.CENTAUR],
            tier1ArtifactId: Tier1Artifact.HUNTERS_LONGBOW,
        });

        expect(decision.creatureId).toBe(Creature.HYDRA);
        expect(decision.changedFromArgmax).toBeFalse();
        expect(decision.eligibleCreatureIds).toEqual([Creature.HYDRA]);
    });

    test("is deterministic and invariant to input ordering for the same public draft state", () => {
        const context = {
            ownCreatureIds: [Creature.BERSERKER, Creature.SQUIRE, Creature.ORC, Creature.CENTAUR],
            knownOpponentCreatureIds: [Creature.ARBALESTER],
        };
        const expected = decideRankedDraftVariety(
            [Creature.HYDRA, Creature.TSAR_CANNON, Creature.GRIFFIN],
            [1, 0.98, 0.99],
            context,
        );
        for (let attempt = 0; attempt < 10; attempt += 1) {
            expect(
                decideRankedDraftVariety(
                    [Creature.HYDRA, Creature.TSAR_CANNON, Creature.GRIFFIN],
                    [1, 0.98, 0.99],
                    context,
                ),
            ).toEqual(expected);
        }
        const reordered = decideRankedDraftVariety(
            [Creature.GRIFFIN, Creature.HYDRA, Creature.TSAR_CANNON],
            [0.99, 1, 0.98],
            context,
        );
        expect(reordered.creatureId).toBe(expected.creatureId);
        expect(reordered.desiredArchetype).toBe(expected.desiredArchetype);
    });

    test("keeps every other draft slot on the exact post-score argmax", () => {
        const decision = decideRankedDraftVariety([Creature.HYDRA, Creature.TSAR_CANNON], [1, 0.995], {
            ownCreatureIds: new Array(RANKED_DRAFT_VARIETY_OWN_CREATURE_COUNT - 1).fill(Creature.BERSERKER),
        });
        expect(decision.creatureId).toBe(Creature.HYDRA);
        expect(decision.changedFromArgmax).toBeFalse();
    });
});
