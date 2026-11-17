import { describe, expect, it } from "bun:test";
import {
    draftMatchupContextFeatures,
    createDraftMatchupContextValue,
    createContextualHistoricalFinalPickAdvisor,
    type IDraftMatchupContextInput,
    type IDraftMatchupContextModel,
} from "../../src/ai/setup/draft_matchup_context_value";
import { CreatureLevelList } from "../../src/units/unit_properties";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { Tier1Artifact, Tier2Artifact } from "../../src/artifacts/artifact_properties";

const own = [...CreatureLevelList[1].slice(0, 2), ...CreatureLevelList[2].slice(0, 2), CreatureLevelList[3][0]];
const enemy = [
    ...CreatureLevelList[1].slice(2, 4),
    ...CreatureLevelList[2].slice(2, 4),
    CreatureLevelList[3][1],
    CreatureLevelList[4][0],
];
const input: IDraftMatchupContextInput = {
    ownCreatureIds: [...own, CreatureLevelList[4][1]],
    opponentCreatureIds: enemy,
    ownDoctrine: 2,
    map: 1,
    ownArtifactT1: Tier1Artifact.MAGES_RING,
    ownArtifactT2: Tier2Artifact.ARCHMAGES_RING,
    synergyVariants: { Life: 1, Chaos: 1, Might: 1, Nature: 1 },
};
const model = (weights: Record<string, number>): IDraftMatchupContextModel => ({
    schema: "draft-matchup-context-value-v1",
    recipe: "public-artifact-synergy-v1",
    sourceSha256: "a".repeat(64),
    snapshotSha256: "b".repeat(64),
    trainingFamilies: 10,
    weights,
});

describe("public contextual matchup value", () => {
    it("distinguishes known own artifact and synergy rolls while ignoring hidden context", () => {
        const features = draftMatchupContextFeatures(input);
        expect(features[`ownArtifact:1:${input.ownArtifactT1}:unit:${own[0]}`]).toBe(1);
        const changed = draftMatchupContextFeatures({
            ...input,
            synergyVariants: { ...input.synergyVariants, Chaos: 2 },
        });
        expect(changed).not.toEqual(features);
        expect(changed[`variant:Chaos:1:unit:${own[0]}`]).toBeUndefined();
        expect(changed[`variant:Chaos:2:unit:${own[0]}`]).toBe(1);
        expect(
            draftMatchupContextFeatures({
                ...input,
                enemyArtifactT2: 4,
                actualEnemyPositions: [9],
                actualSynergyLevels: [3, 3, 3, 3],
            } as IDraftMatchupContextInput),
        ).toEqual(features);
        expect(draftMatchupContextFeatures({ ...input, ownCreatureIds: [...input.ownCreatureIds].reverse() })).toEqual(
            features,
        );
        const predict = createDraftMatchupContextValue(
            model({ [`ownArtifact:1:${input.ownArtifactT1}:unit:${own[0]}`]: 0.1 }),
        );
        expect(predict(input)).toBe(0.6);
        expect(predict({ ...input, ownArtifactT1: Tier1Artifact.IRON_PLATE })).toBe(0.5);
        expect(predict({ ...input, ownArtifactT2: 999 })).toBeNull();
        expect(
            predict({
                ...input,
                synergyVariants: { ...input.synergyVariants, Chaos: 0 } as typeof input.synergyVariants,
            }),
        ).toBeNull();
    });

    it("routes only legal final-pick public views, requires actual own items, and preserves state", () => {
        const available = CreatureLevelList[4].slice(1),
            incumbent = available[0],
            preferred = available[1];
        const view: Parameters<ReturnType<typeof createContextualHistoricalFinalPickAdvisor>>[0] = {
            phaseSequence: 10,
            phase: PBTypes.PickPhaseVals.PICK,
            actors: [PBTypes.TeamVals.LEFT],
            requiredCreatureLevel: 4,
            complete: false,
            creaturesBanned: [],
            creaturesPicked: own,
            knownOpponentCreatures: enemy,
            doctrine: 2,
            bundles: [],
            tier2Offers: [],
            artifacts: [
                [1, input.ownArtifactT1],
                [2, input.ownArtifactT2],
            ] as [number, number][],
            availableCreatureIds: available,
            revealedMap: 1 as const,
            synergyVariants: input.synergyVariants,
        };
        const advise = createContextualHistoricalFinalPickAdvisor(
            model({ [`ownArtifact:1:${input.ownArtifactT1}:unit:${preferred}`]: 0.1 }),
        );
        const before = JSON.stringify(view);
        expect(advise(view, PBTypes.TeamVals.LEFT, incumbent)?.selectedCreatureId).toBe(preferred);
        expect(
            advise(
                {
                    ...view,
                    artifacts: [
                        [1, Tier1Artifact.IRON_PLATE],
                        [2, input.ownArtifactT2],
                    ],
                },
                PBTypes.TeamVals.LEFT,
                incumbent,
            )?.changed,
        ).toBe(false);
        expect(advise({ ...view, artifacts: [] }, PBTypes.TeamVals.LEFT, incumbent)).toBeNull();
        expect(
            advise({ ...view, knownOpponentCreatures: enemy.slice(0, 3) }, PBTypes.TeamVals.LEFT, incumbent),
        ).toBeNull();
        expect(JSON.stringify(view)).toBe(before);
    });
});
