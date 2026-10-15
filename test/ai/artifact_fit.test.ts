import { describe, expect, test } from "bun:test";

import { getRankedAIProfile } from "../../src/ai/ranked_profile";
import {
    ARTIFACT_FIT_SETUP_PREFIX,
    tier1ArtifactFitScore,
    tier2ArtifactFitScore,
    withArtifactFitSetupPolicy,
} from "../../src/ai/setup/artifact_fit";
import { draftCreatureCoherenceAffinity } from "../../src/ai/setup/draft_coherence";
import { parseDraftGenome, pickRankedLiveDraftBundle } from "../../src/ai/setup/draft_ship";
import { resolveSetupPolicy } from "../../src/ai/setup/setup_ship";
import { createTier2ArtifactDecisionContext } from "../../src/ai/setup/setup_strategy";
import { TIER2_ARTIFACT_LIST, Tier1Artifact as T1, Tier2Artifact as T2 } from "../../src/artifacts/artifact_properties";
import { PBTypes } from "../../src/generated/protobuf/v1/types";

const C = PBTypes.CreatureVals;
const ranged = [C.ARBALESTER, C.ELF, C.TSAR_CANNON];
const melee = [C.WOLF, C.PIKEMAN, C.CRUSADER];
const magic = [C.WANDERING_MAGE, C.BATTLE_MAGE, C.MAGIC_DRAGON];
const BASE = "conditional-v1:sniper+t2a19";
const policy = resolveSetupPolicy(`${ARTIFACT_FIT_SETUP_PREFIX}${BASE}`);
const context = (enemy: readonly number[], tier1?: number) =>
    createTier2ArtifactDecisionContext({
        publicOpponentCreatureIds: enemy,
        ...(tier1 === undefined ? {} : { ownArtifactIds: [tier1] }),
    });

describe("current artifact AI fit", () => {
    test("prefers extra attacks for shooters and avoids buying them for a melee army", () => {
        const offered = [T2.QUIVER_OF_ECHOES, T2.LAST_FUSE];
        expect(policy.pickArtifactT2(offered, ranged)).toBe(T2.QUIVER_OF_ECHOES);
        expect(policy.pickArtifactT2(offered, [C.BEHEMOTH, C.ABOMINATION, C.CRUSADER])).toBe(T2.LAST_FUSE);
    });

    test("values one bonus volley rather than multiplying Gargantuan's two native attacks", () => {
        expect(tier2ArtifactFitScore(T2.QUIVER_OF_ECHOES, [C.GARGANTUAN])).toBeLessThan(
            tier2ArtifactFitScore(T2.QUIVER_OF_ECHOES, [C.ARBALESTER]),
        );
        expect(tier2ArtifactFitScore(T2.QUIVER_OF_ECHOES, [C.ELF])).toBe(
            tier2ArtifactFitScore(T2.QUIVER_OF_ECHOES, [C.GARGANTUAN]),
        );
        expect(tier2ArtifactFitScore(T2.QUIVER_OF_ECHOES, ranged, context([], T1.CURSED_WARD))).toBeGreaterThan(
            tier2ArtifactFitScore(T2.QUIVER_OF_ECHOES, ranged),
        );
    });

    test("takes magic defense against publicly revealed offensive casters, not support labels", () => {
        const offered = [T2.CROWN_OF_COMMAND, T2.AEGIS_OF_THE_ARCANE];
        expect(policy.pickArtifactT2(offered, ranged, context(magic))).toBe(T2.AEGIS_OF_THE_ARCANE);
        expect(policy.pickArtifactT2(offered, ranged, context(melee))).toBe(T2.CROWN_OF_COMMAND);
        expect(policy.pickArtifactT2(offered, ranged, context([C.HEALER, C.SATYR]))).toBe(T2.CROWN_OF_COMMAND);
    });

    test("pairs Gravechain with ranged control and prices the owner's movement curse", () => {
        const enemy = [...melee, C.BEHEMOTH];
        expect(policy.pickArtifactT2([T2.CROWN_OF_COMMAND, T2.GRAVECHAIN], ranged, context(enemy))).toBe(T2.GRAVECHAIN);
        expect(policy.pickArtifactT2([T2.TITAN_PLATE, T2.GRAVECHAIN], melee, context(enemy))).toBe(T2.TITAN_PLATE);
        expect(tier2ArtifactFitScore(T2.GRAVECHAIN, ranged, context(enemy))).toBeGreaterThan(
            tier2ArtifactFitScore(T2.GRAVECHAIN, melee, context(enemy)),
        );
    });

    test("pairs arcane rings with real magical damage including passive magic attacks", () => {
        expect(policy.pickArtifactT2([T2.ARCHMAGES_RING, T2.AEGIS_OF_THE_ARCANE], magic, context(melee))).toBe(
            T2.ARCHMAGES_RING,
        );
        expect(tier1ArtifactFitScore(T1.MAGES_RING, [C.THUNDERBIRD], 50)).toBeGreaterThan(50);
        expect(tier1ArtifactFitScore(T1.MAGES_RING, [C.HEALER, C.SATYR], 50)).toBeLessThan(50);
        expect(tier2ArtifactFitScore(T2.ARCHMAGES_RING, magic, context([], T1.MAGES_RING))).toBeLessThan(
            tier2ArtifactFitScore(T2.ARCHMAGES_RING, magic),
        );
    });

    test("drafts the moved Tome for amplifiable buffs without pricing resurrection as a buff", () => {
        expect(tier1ArtifactFitScore(T1.TOME_OF_AMPLIFICATION, [C.ANGEL, C.ARBALESTER], 68.8)).toBeLessThan(50);
        expect(tier1ArtifactFitScore(T1.TOME_OF_AMPLIFICATION, [C.OGRE_MAGE, C.ARBALESTER], 68.8)).toBeGreaterThan(50);
        const base = draftCreatureCoherenceAffinity(C.OGRE_MAGE, { ownCreatureIds: ranged });
        expect(
            draftCreatureCoherenceAffinity(C.OGRE_MAGE, {
                ownCreatureIds: ranged,
                tier1ArtifactId: T1.TOME_OF_AMPLIFICATION,
            }),
        ).toBeGreaterThan(base);
        expect(
            draftCreatureCoherenceAffinity(C.ANGEL, {
                ownCreatureIds: ranged,
                tier1ArtifactId: T1.TOME_OF_AMPLIFICATION,
            }),
        ).toBe(draftCreatureCoherenceAffinity(C.ANGEL, { ownCreatureIds: ranged }));
    });

    test("opening bundles use their actual two creatures for the new and moved Tier-1 items", () => {
        const bundles = [
            [C.ARBALESTER, C.ELF, T1.MAGES_RING],
            [C.ARBALESTER, C.ELF, T1.RIME_CHARM],
        ] as const;
        expect(getRankedAIProfile("v0.8").setupPolicy.pickBundle(bundles)).toBe(1);
        expect(pickRankedLiveDraftBundle(parseDraftGenome("ranked-unit-strength-a19-side-v4-w16-r4"), bundles)).toBe(1);
    });

    test("never redrafts retired Tier-2 versions of the moved items", () => {
        expect(policy.pickArtifactT2([T2.TOME_OF_AMPLIFICATION, T2.RIME_CHARM, T2.GRAVECHAIN], ranged)).toBe(
            T2.GRAVECHAIN,
        );
        expect(policy.pickArtifactT2([T2.TOME_OF_AMPLIFICATION, T2.RIME_CHARM], ranged)).toBe(T2.NO_ARTIFACT);
    });

    test("never spends the artifact slot on an effect with no beneficiaries", () => {
        expect(policy.pickArtifactT2([T2.QUIVER_OF_ECHOES, T2.CROWN_OF_COMMAND], melee)).toBe(T2.CROWN_OF_COMMAND);
        expect(policy.pickArtifactT2([T2.ARCHMAGES_RING, T2.CROWN_OF_COMMAND], melee)).toBe(T2.CROWN_OF_COMMAND);
        expect(tier2ArtifactFitScore(T2.AEGIS_OF_THE_ARCANE, [C.BLACK_DRAGON], context(magic))).toBe(0);
        expect(tier2ArtifactFitScore(T2.LAST_FUSE, [C.ANGEL])).toBeLessThan(
            tier2ArtifactFitScore(T2.LAST_FUSE, [C.CHAMPION]),
        );
    });

    test.each(TIER2_ARTIFACT_LIST)("can select the active artifact $name", ({ id }) => {
        expect(policy.pickArtifactT2([id], ranged, context(magic))).toBe(id);
    });

    test("uses only distinct public identities and does not mutate input arrays", () => {
        const own = Object.freeze([...ranged, ranged[0]]);
        const offered = Object.freeze([T2.AEGIS_OF_THE_ARCANE, T2.CROWN_OF_COMMAND]);
        const publicContext = context([...magic, magic[0]]);
        expect(policy.pickArtifactT2(offered, own, publicContext)).toBe(
            policy.pickArtifactT2(offered, ranged, context(magic)),
        );
        expect(own).toEqual([...ranged, ranged[0]]);
        expect(publicContext.publicOpponentCreatureIds).toEqual(magic);
        expect(policy.pickArtifactT2([], ranged)).toBe(T2.NO_ARTIFACT);
    });

    test("versions the artifact head, keeps unrelated setup heads, and retains an exact explicit rollback", () => {
        const base = resolveSetupPolicy(BASE);
        expect(withArtifactFitSetupPolicy(policy)).toBe(policy);
        expect(policy.spec).toBe(`${ARTIFACT_FIT_SETUP_PREFIX}${base.spec}`);
        expect(policy.journalVersion).toBe(`${ARTIFACT_FIT_SETUP_PREFIX}${base.journalVersion}`);
        expect(policy.pickAugments(7, ranged)).toEqual(base.pickAugments(7, ranged));
        expect(policy.pickSynergies(ranged)).toEqual(base.pickSynergies(ranged));
        expect(policy.placement).toBe(base.placement);
        const offers = [T2.AEGIS_OF_THE_ARCANE, T2.CROWN_OF_COMMAND];
        expect(base.pickArtifactT2(offers, ranged, context(magic))).toBe(T2.CROWN_OF_COMMAND);
        expect(policy.pickArtifactT2(offers, ranged, context(magic))).toBe(T2.AEGIS_OF_THE_ARCANE);
        expect(() => resolveSetupPolicy(ARTIFACT_FIT_SETUP_PREFIX)).toThrow();
    });
});
