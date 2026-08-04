import { describe, expect, test } from "bun:test";

import { Tier1Artifact } from "../../src/artifacts/artifact_properties";
import {
    applyDraftCoherenceOverlay,
    draftCreatureCoherenceAffinity,
    pickCoherentDraftBundle,
    pickCoherentDraftCreature,
} from "../../src/ai/setup/draft_coherence";
import { PBTypes } from "../../src/generated/protobuf/v1/types";

const Creature = PBTypes.CreatureVals;

describe("draft coherence overlay", () => {
    test("blends deterministic build fit without overruling a several-fold learned-score gap", () => {
        const wideGap = applyDraftCoherenceOverlay([-100, 900], [1.25, 0]);
        expect(wideGap[0]).toBeCloseTo(0.3263888889, 8);
        expect(wideGap[1]).toBe(1);

        const shippedL4Shape = applyDraftCoherenceOverlay([3325.8, 859.7], [0.4, 1.5]);
        expect(shippedL4Shape[0]).toBeGreaterThan(shippedL4Shape[1]);
        const nearTie = applyDraftCoherenceOverlay([1000, 900], [0, 1.2]);
        expect(nearTie[1]).toBeGreaterThan(nearTie[0]);

        expect(applyDraftCoherenceOverlay([42, 42], [0, 0])).toEqual([1, 1]);
        expect(() => applyDraftCoherenceOverlay([1], [1, 2])).toThrow(RangeError);
        expect(() => applyDraftCoherenceOverlay([Number.NaN], [0])).toThrow(TypeError);
    });

    test("pairs build-defining Tier-1 artifacts with their actual beneficiaries", () => {
        const emptyRoster = { ownCreatureIds: [] } as const;
        expect(
            draftCreatureCoherenceAffinity(Creature.ORC, {
                ...emptyRoster,
                tier1ArtifactId: Tier1Artifact.HUNTERS_LONGBOW,
            }),
        ).toBeGreaterThan(
            draftCreatureCoherenceAffinity(Creature.SCAVENGER, {
                ...emptyRoster,
                tier1ArtifactId: Tier1Artifact.HUNTERS_LONGBOW,
            }),
        );
        expect(
            draftCreatureCoherenceAffinity(Creature.GRIFFIN, {
                ...emptyRoster,
                tier1ArtifactId: Tier1Artifact.WINGED_BOOTS,
            }),
        ).toBeGreaterThan(
            draftCreatureCoherenceAffinity(Creature.CYCLOPS, {
                ...emptyRoster,
                tier1ArtifactId: Tier1Artifact.WINGED_BOOTS,
            }),
        );
        expect(
            draftCreatureCoherenceAffinity(Creature.BERSERKER, {
                ...emptyRoster,
                tier1ArtifactId: Tier1Artifact.WOUNDING_CHARM,
            }),
        ).toBeGreaterThan(
            draftCreatureCoherenceAffinity(Creature.SCAVENGER, {
                ...emptyRoster,
                tier1ArtifactId: Tier1Artifact.WOUNDING_CHARM,
            }),
        );
    });

    test("keeps later picks coherent with an established own-roster role", () => {
        const ownRanged = [Creature.ORC, Creature.MEDUSA];
        expect(
            pickCoherentDraftCreature([Creature.SCAVENGER, Creature.DRYAD], () => 0, {
                ownCreatureIds: ownRanged,
            }),
        ).toBe(Creature.DRYAD);

        const ownMobile = [Creature.WOLF_RIDER, Creature.VALKYRIE];
        expect(
            pickCoherentDraftCreature([Creature.TRENT, Creature.NOMAD], () => 0, {
                ownCreatureIds: ownMobile,
            }),
        ).toBe(Creature.NOMAD);
    });

    test("bundle scoring can prefer a coherent plan without changing the underlying scorer", () => {
        const plans = [
            [Creature.ORC, Creature.MEDUSA, Tier1Artifact.HUNTERS_LONGBOW],
            [Creature.VALKYRIE, Creature.GRIFFIN, Tier1Artifact.WINGED_BOOTS],
            [Creature.BERSERKER, Creature.WOLF, Tier1Artifact.WOUNDING_CHARM],
        ] as const;
        for (const plan of plans) {
            const generic = [plan[0], plan[1], Tier1Artifact.CURSED_WARD] as const;
            expect(
                pickCoherentDraftBundle(
                    [plan, generic],
                    () => 100,
                    (artifactId) => (artifactId === Tier1Artifact.CURSED_WARD ? 35 : 0),
                ),
            ).toBe(0);
        }
    });
});
