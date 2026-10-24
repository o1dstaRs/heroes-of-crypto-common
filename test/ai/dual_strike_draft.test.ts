import { describe, expect, test } from "bun:test";

import {
    artifactFitVersionForSetupSpec,
    tier1ArtifactFitScoreV4,
    tier1ArtifactFitScoreV7,
} from "../../src/ai/setup/artifact_fit";
import { creatureInfo } from "../../src/ai/setup/creature_score";
import { draftCreatureCoherenceAffinity, pickCoherentDraftCreature } from "../../src/ai/setup/draft_coherence";
import {
    dualStrikeDraftAffinity,
    dualStrikeRelativeDamageGain,
    hasNativeSecondAttack,
} from "../../src/ai/setup/dual_strike_fit";
import { parseDraftGenome, pickRankedLiveDraftBundle } from "../../src/ai/setup/draft_ship";
import { resolveSetupPolicy } from "../../src/ai/setup/setup_ship";
import { RANKED_SETUP_POLICY_ARTIFACT_FIT_V6, RANKED_SETUP_POLICY_ARTIFACT_FIT_V7 } from "../../src/ai/ranked_profile";
import { TIER1_ARTIFACT_LIST, Tier1Artifact as T1, Tier2Artifact as T2 } from "../../src/artifacts/artifact_properties";
import { PBTypes } from "../../src/generated/protobuf/v1/types";

const C = PBTypes.CreatureVals;
const info = (id: number) => creatureInfo(id)!;
const native = [C.BERSERKER, C.WOLF, C.CRUSADER, C.GARGANTUAN, C.ELF];
const charm = T1.DUAL_STRIKE_CHARM;
const bonus = (id: number, ownCreatureIds: readonly number[], artifactFitVersion: 6 | 7) => {
    const context = { ownCreatureIds, artifactFitVersion };
    return (
        draftCreatureCoherenceAffinity(id, { ...context, tier1ArtifactId: charm }) -
        draftCreatureCoherenceAffinity(id, context)
    );
};

describe("Dual Strike draft candidate v7", () => {
    test.each(native)("recognizes native second attacks from the engine's ability families: %s", (id) => {
        expect(hasNativeSecondAttack(info(id))).toBe(true);
        expect(bonus(id, [], 6)).toBe(0);
        expect(bonus(id, [], 7)).toBeCloseTo(1.2);
        expect(dualStrikeRelativeDamageGain(info(id), [])).toBeCloseTo(0.25);
    });

    test("does not invent a second attack for ordinary shooters, casters, or empty ammunition", () => {
        for (const id of [C.ARBALESTER, C.PIKEMAN, C.HEALER, C.WANDERING_MAGE]) {
            expect(hasNativeSecondAttack(info(id))).toBe(false);
            expect(dualStrikeRelativeDamageGain(info(id), [])).toBe(0);
        }
        expect(hasNativeSecondAttack({ ...info(C.ELF), shots: 1 })).toBe(false);
        expect(hasNativeSecondAttack({ ...info(C.GARGANTUAN), shots: 0 })).toBe(false);
    });

    test("learns Craft from the spellbook and discounts its chance instead of granting a third attack", () => {
        const blacksmith = info(C.BLACKSMITH);
        expect(blacksmith.castsCraft).toBe(true);
        expect(info(C.WANDERING_MAGE).castsCraft).toBe(false);
        expect(dualStrikeRelativeDamageGain(info(C.ARBALESTER), [blacksmith])).toBeCloseTo(0.2 / 1.4);
        expect(dualStrikeDraftAffinity(info(C.ARBALESTER), [blacksmith])).toBeGreaterThan(0);
        for (const id of native) {
            expect(dualStrikeDraftAffinity(info(id), [blacksmith])).toBe(dualStrikeDraftAffinity(info(id), []));
            expect(dualStrikeRelativeDamageGain(info(id), [blacksmith])).toBe(0.25);
        }
        expect(dualStrikeDraftAffinity(blacksmith, [info(C.ARBALESTER)])).toBeGreaterThan(
            dualStrikeDraftAffinity(blacksmith, [info(C.ELF)]),
        );
        expect(dualStrikeDraftAffinity(blacksmith, [info(C.ARBALESTER)])).toBeLessThan(
            dualStrikeDraftAffinity(info(C.ELF), []),
        );
    });

    test("bounds the Craft-area forecast and ignores duplicated roster identities", () => {
        const own = [C.BLACKSMITH, C.ARBALESTER, C.PIKEMAN, C.CENTAUR].map(info);
        const gain = dualStrikeRelativeDamageGain(info(C.ARBALESTER), own);
        expect(gain).toBeCloseTo(0.1 / 1.2);
        expect(dualStrikeRelativeDamageGain(info(C.ARBALESTER), [...own, ...own])).toBe(gain);
        expect(dualStrikeRelativeDamageGain(info(C.HEALER), own)).toBe(0);
    });

    test("takes the compatible opening bundle and avoids a dead Charm bundle", () => {
        const genome = parseDraftGenome("ranked-unit-strength-a19-side-v4-w8-r4");
        const compatible = [
            [C.WOLF, C.ELF, T1.IRON_PLATE],
            [C.WOLF, C.ELF, charm],
        ] as const;
        expect(pickRankedLiveDraftBundle(genome, compatible, undefined, 6)).toBe(0);
        expect(pickRankedLiveDraftBundle(genome, compatible, undefined, 7)).toBe(1);
        expect(RANKED_SETUP_POLICY_ARTIFACT_FIT_V6.pickBundle(compatible)).toBe(0);
        expect(RANKED_SETUP_POLICY_ARTIFACT_FIT_V7.pickBundle(compatible)).toBe(1);
        expect(tier1ArtifactFitScoreV7(charm, [C.ARBALESTER, C.PIKEMAN], 47.2)).toBe(0);
        expect(tier1ArtifactFitScoreV7(charm, [C.WOLF, C.ELF], 47.2)).toBe(75);
        expect(tier1ArtifactFitScoreV7(charm, [C.BLACKSMITH, C.ARBALESTER], 47.2)).toBeGreaterThan(50);
    });

    test("prefers fitting close offers while retaining a substantially stronger ordinary unit", () => {
        const context = { ownCreatureIds: [], tier1ArtifactId: charm, artifactFitVersion: 7 as const };
        expect(pickCoherentDraftCreature([C.SCAVENGER, C.WOLF], () => 100, context)).toBe(C.WOLF);
        expect(pickCoherentDraftCreature([C.SCAVENGER, C.WOLF], (id) => (id === C.SCAVENGER ? 1000 : 1), context)).toBe(
            C.SCAVENGER,
        );
    });

    test("records the candidate version and retains the old heads and unrelated setup decisions", () => {
        const base = "conditional-v1:sniper+t2a19";
        const old = resolveSetupPolicy(`artifact-fit-v6:${base}`);
        const candidate = resolveSetupPolicy(`artifact-fit-v7:${base}`);
        expect(artifactFitVersionForSetupSpec(candidate.spec)).toBe(7);
        expect(candidate.journalVersion).toStartWith("artifact-fit-v7:");
        expect(() => resolveSetupPolicy("artifact-fit-v7:")).toThrow();
        for (const { id } of TIER1_ARTIFACT_LIST) {
            if (id !== charm)
                expect(tier1ArtifactFitScoreV7(id, native, 47.2)).toBe(tier1ArtifactFitScoreV4(id, native, 47.2));
        }
        expect(tier1ArtifactFitScoreV4(charm, native, 47.2)).toBe(47.2);
        expect(candidate.pickAugments(7, native)).toEqual(old.pickAugments(7, native));
        expect(candidate.pickSynergies(native)).toEqual(old.pickSynergies(native));
        expect(candidate.pickArtifactT2([T2.QUIVER_OF_ECHOES, T2.LAST_FUSE], native)).toBe(
            old.pickArtifactT2([T2.QUIVER_OF_ECHOES, T2.LAST_FUSE], native),
        );
        expect(candidate.placement).toBe(old.placement);
    });
});
