import { describe, expect, test } from "bun:test";
import {
    ARTIFACT_FIT_SETUP_PREFIX_V5,
    artifactFitVersionForSetupSpec,
    tier2ArtifactFitScoreV4,
    tier2ArtifactFitScoreV5,
} from "../../src/ai/setup/artifact_fit";
import { draftCreatureCoherenceAffinity } from "../../src/ai/setup/draft_coherence";
import { resolveSetupPolicy } from "../../src/ai/setup/setup_ship";
import { createTier2ArtifactDecisionContext } from "../../src/ai/setup/setup_strategy";
import { TIER2_ARTIFACT_LIST, Tier2Artifact as T2 } from "../../src/artifacts/artifact_properties";
import { PBTypes } from "../../src/generated/protobuf/v1/types";

const C = PBTypes.CreatureVals;
// Legal pre-level-4 rosters: one level 1, two level 2 and two level 3 identities.
const shooters = [C.CENTAUR, C.ELF, C.BEHOLDER, C.CYCLOPS, C.ZENA];
const melee = [C.WOLF, C.WHITE_TIGER, C.WYVERN, C.UNICORN, C.CRUSADER];
const base = "conditional-v1:sniper+t2a19";
const v5 = resolveSetupPolicy(`${ARTIFACT_FIT_SETUP_PREFIX_V5}${base}`);
const context = (enemy: readonly number[]) => createTier2ArtifactDecisionContext({ publicOpponentCreatureIds: enemy });

describe("Last Fuse draft plan v5", () => {
    test("takes Last Fuse as melee protection for shooters, while historical v4 still takes Crown", () => {
        const offers = [T2.CROWN_OF_COMMAND, T2.LAST_FUSE];
        expect(resolveSetupPolicy(`artifact-fit-v4:${base}`).pickArtifactT2(offers, shooters, context(melee))).toBe(
            T2.CROWN_OF_COMMAND,
        );
        expect(v5.pickArtifactT2(offers, shooters, context(melee))).toBe(T2.LAST_FUSE);
    });

    test("does not infer a whole melee army from one reveal or buy a contact plan for a ranged duel", () => {
        const offers = [T2.CROWN_OF_COMMAND, T2.LAST_FUSE];
        expect(v5.pickArtifactT2(offers, shooters)).toBe(T2.CROWN_OF_COMMAND);
        expect(v5.pickArtifactT2(offers, shooters, context([C.WOLF]))).toBe(T2.CROWN_OF_COMMAND);
        expect(v5.pickArtifactT2(offers, shooters, context(shooters))).toBe(T2.CROWN_OF_COMMAND);
        expect(
            v5.pickArtifactT2(
                offers,
                shooters,
                context([C.WANDERING_MAGE, C.BATTLE_MAGE, C.SATYR, C.OGRE_MAGE, C.NIGHTMARE]),
            ),
        ).toBe(T2.CROWN_OF_COMMAND);
        expect(tier2ArtifactFitScoreV5(T2.LAST_FUSE, shooters, context(melee))).toBeGreaterThan(
            tier2ArtifactFitScoreV5(T2.LAST_FUSE, shooters, context(shooters)),
        );
    });

    test("does not displace a better fitting ranged item or force the artifact when it was not offered", () => {
        expect(v5.pickArtifactT2([T2.QUIVER_OF_ECHOES, T2.LAST_FUSE], shooters, context(melee))).toBe(
            T2.QUIVER_OF_ECHOES,
        );
        expect(v5.pickArtifactT2([T2.CROWN_OF_COMMAND], shooters, context(melee))).toBe(T2.CROWN_OF_COMMAND);
        expect(v5.pickArtifactT2([T2.LAST_FUSE], shooters, context(shooters))).toBe(T2.LAST_FUSE);
        expect(v5.pickArtifactT2([], shooters)).toBe(T2.NO_ARTIFACT);
    });

    test("prices the complete footprint ring and delays native resurrection without inventing original-HP damage", () => {
        const fit = (id: number) => tier2ArtifactFitScoreV5(T2.LAST_FUSE, [id], context(melee));
        expect(fit(C.GARGANTUAN)).toBeGreaterThan(fit(C.CENTAUR));
        expect(fit(C.CENTAUR)).toBeGreaterThan(fit(C.ARBALESTER));
        expect(fit(C.ANGEL)).toBeLessThan(fit(C.CHAMPION));
        expect(fit(C.ABOMINATION)).toBe(fit(C.CHAMPION));
    });

    test("completes the chosen Last Fuse plan with the final creature, including a ranged body that can be reached", () => {
        const bonus = (id: number, version: 4 | 5, enemies = melee) => {
            const baseContext = { ownCreatureIds: [], artifactFitVersion: version, knownOpponentCreatureIds: enemies };
            return (
                draftCreatureCoherenceAffinity(id, { ...baseContext, tier2ArtifactId: T2.LAST_FUSE }) -
                draftCreatureCoherenceAffinity(id, baseContext)
            );
        };
        expect(bonus(C.GARGANTUAN, 4)).toBe(0);
        expect(bonus(C.GARGANTUAN, 5)).toBeGreaterThan(0);
        expect(bonus(C.GARGANTUAN, 5, shooters)).toBe(0);
        expect(bonus(C.ANGEL, 5)).toBeLessThan(bonus(C.CHAMPION, 5));
    });

    test.each(TIER2_ARTIFACT_LIST.filter((artifact) => artifact.id !== T2.LAST_FUSE))(
        "keeps exact v4 scores for $name",
        ({ id }) => {
            for (const own of [[], shooters, melee, [C.ANGEL, C.BLACK_DRAGON], [C.HEALER, C.SATYR]]) {
                for (const enemy of [[], shooters, melee, [C.WOLF]]) {
                    expect(tier2ArtifactFitScoreV5(id, own, context(enemy))).toBe(
                        tier2ArtifactFitScoreV4(id, own, context(enemy)),
                    );
                }
            }
        },
    );

    test("keeps public identities distinct, ignores invalid IDs and preserves caller arrays", () => {
        const own = Object.freeze([...shooters, shooters[0], 999999]);
        const enemy = Object.freeze([...melee, melee[0], 999999]);
        expect(tier2ArtifactFitScoreV5(T2.LAST_FUSE, own, context(enemy))).toBe(
            tier2ArtifactFitScoreV5(T2.LAST_FUSE, shooters, context(melee)),
        );
        expect(own).toHaveLength(shooters.length + 2);
        expect(enemy).toHaveLength(melee.length + 2);
        expect(artifactFitVersionForSetupSpec(v5.spec)).toBe(5);
        expect(v5.journalVersion).toStartWith(ARTIFACT_FIT_SETUP_PREFIX_V5);
        expect(() => resolveSetupPolicy(ARTIFACT_FIT_SETUP_PREFIX_V5)).toThrow();
    });
});
