import { describe, expect, test } from "bun:test";

import {
    AI_VERSIONS,
    createAIStrategy,
    getAIStrategy,
    getRankedAIProfile,
    LATEST_AI_VERSION,
    RANKED_AI_PROFILES,
} from "../../src/ai";
import { Tier1Artifact, Tier2Artifact } from "../../src/artifacts/artifact_properties";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getUpgradePoints, DOCTRINE_LIST, type Doctrine } from "../../src/doctrines/doctrine_properties";

const AUGMENT_CAPS = {
    Placement: 2,
    Armor: 3,
    Might: 3,
    Sniper: 3,
    Movement: 2,
} as const;

describe("full-ranked AI profiles", () => {
    test("binds every registered AI version exactly once", () => {
        expect(AI_VERSIONS).toHaveLength(12);
        expect(RANKED_AI_PROFILES.map((profile) => profile.version)).toEqual([...AI_VERSIONS]);
        expect(LATEST_AI_VERSION).toBe(AI_VERSIONS.at(-1));
        expect(new Set(AI_VERSIONS).size).toBe(AI_VERSIONS.length);
        for (const profile of RANKED_AI_PROFILES) {
            expect(getRankedAIProfile(profile.version)).toBe(profile);
            expect(profile.setupPolicyVersion).toBe(profile.setupPolicy.version);
            expect(profile.setupPolicyVersion).toBe("setup-v0");
            expect(profile.setupPolicy.placement).toBe("baseline");
            expect(profile.setupPolicy.placementAugmentTiming).toBe("setup-before-placement");
            expect(Object.isFrozen(profile)).toBe(true);
        }
    });

    test("rejects unknown versions instead of silently changing AI strength", () => {
        expect(() => getRankedAIProfile("v9.9")).toThrow('Unknown AI version "v9.9"');
        expect(() => createAIStrategy("v9.9")).toThrow('Unknown AI version "v9.9"');
        expect(() => getAIStrategy("v9.9")).toThrow('Unknown AI version "v9.9"');
    });

    test.each([...AI_VERSIONS])("%s creates fresh, exact-version match strategies", (version) => {
        const first = createAIStrategy(version);
        const second = getRankedAIProfile(version).createStrategy();
        expect(first.version).toBe(version);
        expect(second.version).toBe(version);
        expect(first).not.toBe(second);
        // The historical accessor remains a stable shared instance for browser/simulation compatibility.
        expect(getAIStrategy(version)).toBe(getAIStrategy(version));
    });

    test.each([...AI_VERSIONS])("%s makes legal choices throughout ranked setup", (version) => {
        const setup = getRankedAIProfile(version).setupPolicy;

        const doctrine = setup.pickDoctrine() as Doctrine;
        expect(DOCTRINE_LIST.some((entry) => entry.id === doctrine)).toBe(true);

        const bannable = [PBTypes.CreatureVals.ORC, PBTypes.CreatureVals.HEALER, PBTypes.CreatureVals.CHAMPION];
        const ban = setup.pickBan(bannable);
        expect(ban).toBeDefined();
        expect(bannable).toContain(ban as PBTypes.CreatureVals);
        expect(setup.pickBan([])).toBeUndefined();

        const bundles = [
            [PBTypes.CreatureVals.ORC, PBTypes.CreatureVals.HEALER, Tier1Artifact.IRON_PLATE],
            [PBTypes.CreatureVals.SCAVENGER, PBTypes.CreatureVals.PIKEMAN, Tier1Artifact.CURSED_WARD],
        ] as const;
        const bundleIndex = setup.pickBundle(bundles);
        expect(bundleIndex).toBeGreaterThanOrEqual(0);
        expect(bundleIndex).toBeLessThan(bundles.length);

        const creatureOffer = [
            PBTypes.CreatureVals.GRIFFIN,
            PBTypes.CreatureVals.NIGHTMARE,
            PBTypes.CreatureVals.BLACKSMITH,
        ];
        const creature = setup.pickCreature(
            3,
            creatureOffer,
            [PBTypes.CreatureVals.ORC, PBTypes.CreatureVals.HEALER],
            [PBTypes.CreatureVals.ASH_MOTH],
            bundles[bundleIndex][2],
        );
        expect(creatureOffer).toContain(creature);

        const tier2Offer = [Tier2Artifact.WARLORDS_EDGE, Tier2Artifact.TITAN_PLATE, Tier2Artifact.CLOVER_OF_FORTUNE];
        expect(tier2Offer).toContain(
            setup.pickArtifactT2(tier2Offer, [bundles[bundleIndex][0], bundles[bundleIndex][1], creature]),
        );

        const budget = getUpgradePoints(doctrine);
        const augments = setup.pickAugments(budget, [bundles[bundleIndex][0], bundles[bundleIndex][1], creature]);
        expect(augments.reduce((cost, augment) => cost + augment.value, 0)).toBeLessThanOrEqual(budget);
        for (const augment of augments) {
            expect(augment.value).toBeInteger();
            expect(augment.value).toBeGreaterThan(0);
            expect(augment.value).toBeLessThanOrEqual(AUGMENT_CAPS[augment.kind]);
        }

        const synergies = setup.pickSynergies([
            PBTypes.CreatureVals.PIKEMAN,
            PBTypes.CreatureVals.HEALER,
            PBTypes.CreatureVals.ORC,
        ]);
        expect(synergies.length).toBeGreaterThan(0);
        for (const synergy of synergies) {
            expect(synergy.faction).toBeGreaterThan(0);
            expect(synergy.synergy).toBeGreaterThan(0);
            expect(setup.bestSynergyForFaction(synergy.faction)).toBeGreaterThan(0);
        }
    });
});
