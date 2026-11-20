import { expect, test } from "bun:test";

import {
    artifactFitVersionForSetupSpec,
    GIANTS_MAUL_BENEFICIARY_ABILITIES,
    tier2ArtifactHasBeneficiary,
} from "../../src/ai/setup/artifact_fit";
import { creatureInfo } from "../../src/ai/setup/creature_score";
import { resolveSetupPolicy } from "../../src/ai/setup/setup_ship";
import { createTier2ArtifactDecisionContext } from "../../src/ai/setup/setup_strategy";
import { TIER2_ARTIFACT_LIST, Tier2Artifact as T2 } from "../../src/artifacts/artifact_properties";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { RANKED_SETUP_POLICY_ARTIFACT_FIT_V6, RANKED_SETUP_POLICY_ARTIFACT_FIT_V8 } from "../../src/ai/ranked_profile";

const C = PBTypes.CreatureVals;
const base = "conditional-v1:sniper+t2a19";
const v6 = resolveSetupPolicy(`artifact-fit-v6:${base}`);
const v8 = resolveSetupPolicy(`artifact-fit-v8:${base}`);
// The five picks a player holds when the Tier-2 artifact is chosen. Not one of them shoots.
const strikers = [C.SQUIRE, C.WANDERING_MAGE, C.HYENA, C.MANTICORE, C.EFREET];
const shooters = [C.SCAVENGER, C.DRYAD, C.MEDUSA, C.BEHOLDER, C.ZENA];

// "As the army stands": the seat adds no shooter with its level-4 pick.
const asItStands = createTier2ArtifactDecisionContext({ publicOpponentCreatureIds: [], ownProspectiveCreatureIds: [] });
const expecting = (creature: number) =>
    createTier2ArtifactDecisionContext({ publicOpponentCreatureIds: [], ownProspectiveCreatureIds: [creature] });

test("an army without shooters is not offered Farsight Quiver ahead of an artifact that works", () => {
    // The offer a live player was shown: both quivers do nothing for this army, the pendant does.
    const offers = [T2.QUIVER_OF_ECHOES, T2.FARSIGHT_QUIVER, T2.PENDANT_OF_VITALITY];
    expect(v6.pickArtifactT2(offers, strikers, asItStands)).toBe(T2.FARSIGHT_QUIVER);
    expect(v8.pickArtifactT2(offers, strikers, asItStands)).toBe(T2.PENDANT_OF_VITALITY);
    // The ranking a suggestion list shows is the repeated pick: the working artifact first, both quivers after it.
    const ranked: number[] = [];
    const left = [...offers];
    while (left.length) {
        const pick = v8.pickArtifactT2(left, strikers, asItStands);
        ranked.push(pick);
        left.splice(left.indexOf(pick), 1);
    }
    expect(ranked[0]).toBe(T2.PENDANT_OF_VITALITY);
    expect(new Set(ranked)).toEqual(new Set(offers));
});

test("Farsight Quiver stays on the table for a seat about to add a shooter, or one that cannot say", () => {
    const offers = [T2.QUIVER_OF_ECHOES, T2.FARSIGHT_QUIVER, T2.PENDANT_OF_VITALITY];
    // One level-4 shooter makes the artifact strong: the measured case the rule must not break.
    expect(tier2ArtifactHasBeneficiary(T2.FARSIGHT_QUIVER, strikers, [C.GARGANTUAN])).toBe(true);
    expect(v8.pickArtifactT2(offers, strikers, expecting(C.GARGANTUAN))).toBe(T2.FARSIGHT_QUIVER);
    expect(v8.pickArtifactT2(offers, strikers, expecting(C.MAGIC_DRAGON))).toBe(T2.PENDANT_OF_VITALITY);
    // No statement about the next pick: nothing changes.
    expect(tier2ArtifactHasBeneficiary(T2.FARSIGHT_QUIVER, strikers)).toBe(true);
    expect(v8.pickArtifactT2(offers, strikers)).toBe(v6.pickArtifactT2(offers, strikers));
    expect(
        v8.pickArtifactT2(offers, strikers, createTier2ArtifactDecisionContext({ publicOpponentCreatureIds: [] })),
    ).toBe(T2.FARSIGHT_QUIVER);
});

test("the same offer keeps its old answer for an army that does shoot", () => {
    const offers = [T2.FARSIGHT_QUIVER, T2.PENDANT_OF_VITALITY, T2.CROWN_OF_COMMAND];
    expect(tier2ArtifactHasBeneficiary(T2.FARSIGHT_QUIVER, shooters, [])).toBe(true);
    expect(v8.pickArtifactT2(offers, shooters, asItStands)).toBe(v6.pickArtifactT2(offers, shooters, asItStands));
    // One shooter among melee is enough for the artifact to act.
    const oneShooter = [C.SQUIRE, C.HYENA, C.MANTICORE, C.EFREET, C.DRYAD];
    expect(tier2ArtifactHasBeneficiary(T2.FARSIGHT_QUIVER, oneShooter, [])).toBe(true);
    expect(v8.pickArtifactT2(offers, oneShooter, asItStands)).toBe(v6.pickArtifactT2(offers, oneShooter, asItStands));
});

test("Farsight Quiver follows the engine: native shooters only, and nothing for a Sniper", () => {
    expect(creatureInfo(C.ARBALESTER)!.abilities).toContain("Sniper");
    expect(tier2ArtifactHasBeneficiary(T2.FARSIGHT_QUIVER, [C.ARBALESTER, C.SQUIRE, C.HYENA], [])).toBe(false);
    expect(tier2ArtifactHasBeneficiary(T2.FARSIGHT_QUIVER, [C.ARBALESTER, C.DRYAD], [])).toBe(true);
    // A damage caster is not a shooter: the engine grants the marker to ranged attackers only.
    expect(tier2ArtifactHasBeneficiary(T2.FARSIGHT_QUIVER, [C.WANDERING_MAGE, C.BATTLE_MAGE], [])).toBe(false);
    // An unknown roster gives no verdict.
    expect(tier2ArtifactHasBeneficiary(T2.FARSIGHT_QUIVER, [], [])).toBe(true);
});

test("Giant's Maul needs a physical area attacker", () => {
    const offers = [T2.GIANTS_MAUL, T2.BERSERKERS_BOND, T2.CROWN_OF_COMMAND];
    expect(tier2ArtifactHasBeneficiary(T2.GIANTS_MAUL, strikers)).toBe(false);
    expect(v6.pickArtifactT2(offers, strikers)).toBe(T2.GIANTS_MAUL);
    expect(v8.pickArtifactT2(offers, strikers)).not.toBe(T2.GIANTS_MAUL);
    for (const [creature, ability] of [
        [C.HYDRA, "Lightning Spin"],
        [C.GARGANTUAN, "Area Throw"],
        [C.TSAR_CANNON, "Through Shot"],
        [C.PIKEMAN, "Skewer Strike"],
        [C.CYCLOPS, "Large Caliber"],
        [C.ZENA, "Chakram"],
    ] as const) {
        expect(GIANTS_MAUL_BENEFICIARY_ABILITIES).toContain(ability);
        expect(creatureInfo(creature)!.abilities).toContain(ability);
        const army = [C.SQUIRE, C.HYENA, creature];
        expect(tier2ArtifactHasBeneficiary(T2.GIANTS_MAUL, army)).toBe(true);
        expect(v8.pickArtifactT2(offers, army)).toBe(v6.pickArtifactT2(offers, army));
    }
    // Unlike the quiver, an area attacker expected at level 4 does not rescue the Maul: that was measured.
    expect(tier2ArtifactHasBeneficiary(T2.GIANTS_MAUL, strikers, [C.GARGANTUAN])).toBe(false);
    expect(v8.pickArtifactT2(offers, strikers, expecting(C.GARGANTUAN))).not.toBe(T2.GIANTS_MAUL);
});

test("when nothing on offer can be used the choice stays the older one", () => {
    const offers = [T2.FARSIGHT_QUIVER, T2.GIANTS_MAUL];
    expect(v8.pickArtifactT2(offers, strikers, asItStands)).toBe(v6.pickArtifactT2(offers, strikers, asItStands));
    expect(v8.pickArtifactT2([T2.FARSIGHT_QUIVER], strikers, asItStands)).toBe(T2.FARSIGHT_QUIVER);
    expect(v8.pickArtifactT2([], strikers, asItStands)).toBe(T2.NO_ARTIFACT);
});

test("v8 differs from v6 only when an offered artifact has no beneficiary", () => {
    const live = TIER2_ARTIFACT_LIST.map((artifact) => artifact.id);
    const creatures = Object.values(C).filter(
        (value): value is number => typeof value === "number" && !!creatureInfo(value),
    );
    let state = 20261120;
    const next = (bound: number): number => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state % bound;
    };
    let compared = 0;
    let changed = 0;
    for (let round = 0; round < 4000; round++) {
        // A drafted army holds five different creatures when the Tier-2 artifact is chosen.
        const pool = [...creatures];
        const army = Array.from({ length: 5 }, () => pool.splice(next(pool.length), 1)[0]);
        const offers = [...new Set(Array.from({ length: 3 }, () => live[next(live.length)]))];
        const before = v6.pickArtifactT2(offers, army, asItStands);
        const after = v8.pickArtifactT2(offers, army, asItStands);
        const usable = offers.filter((id) => tier2ArtifactHasBeneficiary(id, army, []));
        // By construction: the older answer over the artifacts this army can use, or over all when none can.
        expect(after).toBe(v6.pickArtifactT2(usable.length ? usable : offers, army, asItStands));
        if (usable.length === offers.length) {
            expect(after).toBe(before);
            compared++;
        } else if (after !== before) {
            // Only ever a move away from an artifact this army cannot use, to one it can.
            expect(usable).not.toContain(before);
            expect(usable).toContain(after);
            changed++;
        }
    }
    expect(compared).toBeGreaterThan(2000);
    expect(changed).toBeGreaterThan(20);
});

test("v8 has its own identity on the v6 line and drafts exactly as v6", () => {
    expect(v8.spec).toBe(`artifact-fit-v8:${base}`);
    // A draft never sees 8: "at least 7" selects the unadopted Dual Strike candidate, and frozen draft helpers
    // read this number.
    expect(artifactFitVersionForSetupSpec(v8.spec)).toBe(6);
    expect(artifactFitVersionForSetupSpec(v6.spec)).toBe(6);
    expect(artifactFitVersionForSetupSpec(`artifact-fit-v7:${base}`)).toBe(7);
    expect(RANKED_SETUP_POLICY_ARTIFACT_FIT_V8.version).toBe("setup-v0+artifact-fit-v8");
    // Same opening-bundle and creature choices as v6: only the Tier-2 pick gained a rule.
    const bundles = [
        [C.SQUIRE, C.HYENA, 7],
        [C.DRYAD, C.MEDUSA, 10],
        [C.WANDERING_MAGE, C.BATTLE_MAGE, 13],
    ] as const;
    expect(RANKED_SETUP_POLICY_ARTIFACT_FIT_V8.pickBundle(bundles)).toBe(
        RANKED_SETUP_POLICY_ARTIFACT_FIT_V6.pickBundle(bundles),
    );
    const pool = [C.EFREET, C.ZENA, C.CRUSADER, C.MONK];
    expect(
        RANKED_SETUP_POLICY_ARTIFACT_FIT_V8.pickCreature(3, pool, strikers.slice(0, 4), shooters.slice(0, 3), 7),
    ).toBe(RANKED_SETUP_POLICY_ARTIFACT_FIT_V6.pickCreature(3, pool, strikers.slice(0, 4), shooters.slice(0, 3), 7));
    expect(() => resolveSetupPolicy("artifact-fit-v8:")).toThrow();
});
