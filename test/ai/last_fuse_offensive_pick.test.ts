import { expect, test } from "bun:test";

import {
    tier2ArtifactFitScoreV5,
    tier2ArtifactFitScoreV6,
    artifactFitVersionForSetupSpec,
} from "../../src/ai/setup/artifact_fit";
import { creatureInfo } from "../../src/ai/setup/creature_score";
import { draftCreatureCoherenceAffinity } from "../../src/ai/setup/draft_coherence";
import { lastFuseExecutionAccess } from "../../src/ai/setup/last_fuse_fit";
import { resolveSetupPolicy } from "../../src/ai/setup/setup_ship";
import { createTier2ArtifactDecisionContext } from "../../src/ai/setup/setup_strategy";
import { TIER2_ARTIFACT_LIST, Tier2Artifact as T2 } from "../../src/artifacts/artifact_properties";
import { PBTypes } from "../../src/generated/protobuf/v1/types";

const C = PBTypes.CreatureVals;
const shooters = [C.CENTAUR, C.ELF, C.BEHOLDER, C.CYCLOPS, C.ZENA];
const melee = [C.WOLF, C.WHITE_TIGER, C.WYVERN, C.UNICORN, C.CRUSADER];
const casters = [C.WANDERING_MAGE, C.BATTLE_MAGE, C.SATYR, C.OGRE_MAGE, C.NIGHTMARE];
const base = "conditional-v1:sniper+t2a19";
const current = resolveSetupPolicy(`artifact-fit-v6:${base}`);
const previous = resolveSetupPolicy(`artifact-fit-v5:${base}`);
const context = (publicOpponentCreatureIds: readonly number[]) =>
    createTier2ArtifactDecisionContext({ publicOpponentCreatureIds });

test("Last Fuse rewards ranged executions without requiring the enemy to approach", () => {
    const offers = [T2.CROWN_OF_COMMAND, T2.LAST_FUSE];
    expect(previous.pickArtifactT2(offers, shooters, context(shooters))).toBe(T2.CROWN_OF_COMMAND);
    expect(current.pickArtifactT2(offers, shooters, context(shooters))).toBe(T2.LAST_FUSE);
    expect(current.pickArtifactT2(offers, shooters, context(melee))).toBe(T2.LAST_FUSE);
    expect(current.pickArtifactT2([T2.QUIVER_OF_ECHOES, T2.LAST_FUSE], shooters, context(melee))).toBe(
        T2.QUIVER_OF_ECHOES,
    );
    expect(current.pickArtifactT2([T2.CROWN_OF_COMMAND], shooters)).toBe(T2.CROWN_OF_COMMAND);
    expect(current.pickArtifactT2([], shooters)).toBe(T2.NO_ARTIFACT);
});

test("offensive spells and shots can finish enemies; the holder's size and resurrection do not create blasts", () => {
    const shooter = creatureInfo(C.ARBALESTER)!;
    expect(lastFuseExecutionAccess(shooter)).toBe(1);
    expect(
        lastFuseExecutionAccess({ ...shooter, footprintWidth: 2, footprintHeight: 2, abilities: "Resurrection" }),
    ).toBe(1);
    expect(lastFuseExecutionAccess({ ...shooter, shots: 0 })).toBe(0);
    expect(
        lastFuseExecutionAccess({ ...shooter, ranged: false, shots: 0, rangedSpellDamage: true, maxDamage: 0 }),
    ).toBe(1);
    expect(
        lastFuseExecutionAccess({ ...shooter, ranged: false, shots: 0, rangedSpellDamage: false, maxDamage: 0 }),
    ).toBe(0);
    expect(lastFuseExecutionAccess(creatureInfo(C.WANDERING_MAGE)!)).toBe(1);
});

test("enemy resurrection delays the opportunity while hidden enemy slots remain neutral", () => {
    const fit = (enemies: readonly number[]) => tier2ArtifactFitScoreV6(T2.LAST_FUSE, shooters, context(enemies));
    expect(fit(shooters)).toBe(fit(melee));
    expect(fit([C.ANGEL])).toBeLessThan(fit([C.CHAMPION]));
    expect(fit([])).toBe(fit([C.CHAMPION]));
    expect(fit([C.ANGEL, C.ANGEL, 99999])).toBe(fit([C.ANGEL]));
});

test("the last creature pick supports executions even against an enemy ranged army", () => {
    const bonus = (id: number, artifactFitVersion: 5 | 6) => {
        const c = { ownCreatureIds: [], knownOpponentCreatureIds: shooters, artifactFitVersion };
        return (
            draftCreatureCoherenceAffinity(id, { ...c, tier2ArtifactId: T2.LAST_FUSE }) -
            draftCreatureCoherenceAffinity(id, c)
        );
    };
    expect(bonus(C.ZENA, 5)).toBe(0);
    expect(bonus(C.ZENA, 6)).toBeGreaterThan(0);
    expect(bonus(C.WANDERING_MAGE, 6)).toBeGreaterThan(0);
});

test.each(TIER2_ARTIFACT_LIST.filter((artifact) => artifact.id !== T2.LAST_FUSE))("v6 preserves $name", ({ id }) => {
    for (const own of [[], shooters, melee, casters]) {
        for (const enemies of [[], shooters, melee, [C.ANGEL]]) {
            expect(tier2ArtifactFitScoreV6(id, own, context(enemies))).toBe(
                tier2ArtifactFitScoreV5(id, own, context(enemies)),
            );
        }
    }
});

test("v6 has its own recorded identity and leaves augment spending unchanged", () => {
    expect(artifactFitVersionForSetupSpec(current.spec)).toBe(6);
    expect(current.journalVersion).toStartWith("artifact-fit-v6:");
    expect(previous.journalVersion).toStartWith("artifact-fit-v5:");
    expect(() => resolveSetupPolicy("artifact-fit-v6:")).toThrow();
    for (const own of [shooters, melee, casters]) {
        expect(current.pickAugments(7, own)).toEqual(previous.pickAugments(7, own));
        expect(current.pickSynergies(own)).toEqual(previous.pickSynergies(own));
    }
});
