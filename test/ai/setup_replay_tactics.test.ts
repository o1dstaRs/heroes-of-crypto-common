import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
    canonicalReplayTacticsSetupBehavior,
    parseReplayTacticsSetupArtifact,
    RANKED_REPLAY_TACTICS_BASE_SPEC,
    RANKED_REPLAY_TACTICS_BEHAVIOR_SHA256,
    RANKED_REPLAY_TACTICS_BUDGET,
    RANKED_REPLAY_TACTICS_SETUP_ARTIFACT,
    RANKED_REPLAY_TACTICS_SETUP_SPEC,
    replayTacticsArmyIdentity,
    replayTacticsAugmentPlan,
    replayRapidChargeCoreEligible,
} from "../../src/ai/setup/setup_replay_tactics";
import { resolveSetupPolicy, V07_NONFIGHT_SETUP_SPEC } from "../../src/ai/setup/setup_ship";
import { PBTypes } from "../../src/generated/protobuf/v1/types";

const C = PBTypes.CreatureVals;

describe("ranked replay tactics setup artifact", () => {
    test("freezes a hashed seven-point plan for every replay army identity", () => {
        expect(RANKED_REPLAY_TACTICS_SETUP_ARTIFACT).toMatchObject({
            schemaVersion: 1,
            spec: RANKED_REPLAY_TACTICS_SETUP_SPEC,
            behaviorSha256: RANKED_REPLAY_TACTICS_BEHAVIOR_SHA256,
        });
        expect(RANKED_REPLAY_TACTICS_SETUP_ARTIFACT.policy.baseSpec).toBe(RANKED_REPLAY_TACTICS_BASE_SPEC);
        expect(RANKED_REPLAY_TACTICS_BASE_SPEC).toBe(V07_NONFIGHT_SETUP_SPEC);
        expect(
            createHash("sha256")
                .update(canonicalReplayTacticsSetupBehavior(RANKED_REPLAY_TACTICS_SETUP_ARTIFACT.policy))
                .digest("hex"),
        ).toBe(RANKED_REPLAY_TACTICS_BEHAVIOR_SHA256);
        for (const plan of Object.values(RANKED_REPLAY_TACTICS_SETUP_ARTIFACT.policy.augmentPlansByIdentity)) {
            expect(plan.placement + plan.armor + plan.might + plan.sniper + plan.movement).toBe(
                RANKED_REPLAY_TACTICS_BUDGET,
            );
            expect(Object.isFrozen(plan)).toBe(true);
        }
        expect(Object.isFrozen(RANKED_REPLAY_TACTICS_SETUP_ARTIFACT.policy.classifier.durableCarryNames)).toBe(true);
    });

    test("rejects mutation under a copied approved hash", () => {
        const tampered = structuredClone(RANKED_REPLAY_TACTICS_SETUP_ARTIFACT);
        tampered.policy.augmentPlansByIdentity["ranged-battery"] = {
            placement: 1,
            armor: 3,
            might: 0,
            sniper: 3,
            movement: 0,
        };

        expect(() => parseReplayTacticsSetupArtifact(tampered)).toThrow("does not match approved spec");
    });
});

describe("ranked replay tactics own-roster classifier", () => {
    test("requires a Wolf Rider or Champion plus another distinct Rapid Charge unit", () => {
        expect(replayRapidChargeCoreEligible([C.WOLF_RIDER, C.NOMAD])).toBe(true);
        expect(replayRapidChargeCoreEligible([C.CHAMPION, C.NOMAD])).toBe(true);
        expect(replayRapidChargeCoreEligible([C.WOLF_RIDER, C.CHAMPION])).toBe(true);
        expect(replayRapidChargeCoreEligible([C.NOMAD, C.PEASANT])).toBe(false);
        expect(replayRapidChargeCoreEligible([C.WOLF_RIDER, C.PEASANT])).toBe(false);
        expect(replayRapidChargeCoreEligible([C.WOLF_RIDER, C.WOLF_RIDER])).toBe(false);
    });

    test("keeps two-plus-ranged batteries on their incumbent Sniper plan", () => {
        expect(replayRapidChargeCoreEligible([C.WOLF_RIDER, C.NOMAD, C.ARBALESTER])).toBe(true);
        expect(
            replayRapidChargeCoreEligible([C.WOLF_RIDER, C.NOMAD, C.ARBALESTER, C.ELF]),
        ).toBe(false);
    });

    test("keeps the ranged battery first and does not count duplicate identities twice", () => {
        expect(replayTacticsArmyIdentity([C.ARBALESTER, C.ELF, C.WOLF_RIDER, C.NOMAD, C.GRIFFIN, C.THUNDERBIRD])).toBe(
            "ranged-battery",
        );
        expect(replayTacticsArmyIdentity([C.HEALER, C.ABOMINATION])).toBe("healer-durable-carry");
        expect(replayTacticsArmyIdentity([C.BATTLE_MAGE, C.PEASANT])).toBe("ordinary");
        expect(replayTacticsArmyIdentity([C.ARBALESTER, C.ARBALESTER])).toBe("ordinary");
    });

    test("requires a Rapid Charge core instead of treating the one-Rapid, two-mobile roster as fast", () => {
        expect(
            replayTacticsArmyIdentity([C.NOMAD, C.VALKYRIE, C.PEASANT, C.BATTLE_MAGE, C.BLACKSMITH, C.LEPRECHAUN]),
        ).toBe("ordinary");
        expect(replayTacticsArmyIdentity([C.WOLF_RIDER, C.NOMAD])).toBe("fast-mobile-melee");
    });

    test("separates the observed two-Rapid, four-mobile winner from an ordinary two-mobile roster", () => {
        expect(
            replayTacticsArmyIdentity([C.SCAVENGER, C.VALKYRIE, C.PEASANT, C.BATTLE_MAGE, C.BLACKSMITH, C.LEPRECHAUN]),
        ).toBe("ordinary");
        expect(
            replayTacticsArmyIdentity([C.WOLF_RIDER, C.NOMAD, C.GRIFFIN, C.THUNDERBIRD, C.PEASANT, C.BATTLE_MAGE]),
        ).toBe("fast-mobile-melee");
        expect(replayTacticsArmyIdentity([C.SCAVENGER, C.VALKYRIE, C.EFREET, C.PEGASUS])).toBe("fast-mobile-melee");
    });

    test("keeps Healer plus durable carry ahead of the broad mobile fallback", () => {
        expect(
            replayTacticsArmyIdentity([C.HEALER, C.FRENZIED_BOAR, C.SCAVENGER, C.VALKYRIE, C.EFREET, C.BLACKSMITH]),
        ).toBe("healer-durable-carry");
        for (const anchor of [C.ABOMINATION, C.FRENZIED_BOAR, C.GOBLIN_KNIGHT, C.ANGEL]) {
            expect(replayTacticsArmyIdentity([C.HEALER, anchor])).toBe("healer-durable-carry");
        }
    });

    test("returns the exact full-spend replay plans", () => {
        expect(replayTacticsAugmentPlan([C.ARBALESTER, C.ELF])).toEqual({
            placement: 2,
            armor: 2,
            might: 0,
            sniper: 3,
            movement: 0,
        });
        expect(replayTacticsAugmentPlan([C.WOLF_RIDER, C.NOMAD])).toEqual({
            placement: 1,
            armor: 1,
            might: 3,
            sniper: 0,
            movement: 2,
        });
        expect(replayTacticsAugmentPlan([C.HEALER, C.ABOMINATION])).toEqual({
            placement: 1,
            armor: 3,
            might: 2,
            sniper: 0,
            movement: 1,
        });
        expect(replayTacticsAugmentPlan([C.BATTLE_MAGE])).toEqual({
            placement: 0,
            armor: 3,
            might: 3,
            sniper: 0,
            movement: 1,
        });
    });
});

describe("ranked replay tactics setup resolver", () => {
    const replay = resolveSetupPolicy(RANKED_REPLAY_TACTICS_SETUP_SPEC);
    const frozenV07 = resolveSetupPolicy(V07_NONFIGHT_SETUP_SPEC);

    test("resolves explicitly and emits Placement wire values before the stat augments", () => {
        expect(replay).toMatchObject({
            configured: true,
            mode: "replay-tactics-v1",
            spec: RANKED_REPLAY_TACTICS_SETUP_SPEC,
            journalVersion: RANKED_REPLAY_TACTICS_SETUP_SPEC,
            placement: frozenV07.placement,
            placementAugmentTiming: "setup-before-placement",
        });
        expect(replay.pickAugments(7, [C.ARBALESTER, C.ELF])).toEqual([
            { kind: "Placement", value: 2 },
            { kind: "Armor", value: 2 },
            { kind: "Sniper", value: 3 },
        ]);
        expect(replay.pickAugments(7, [C.WOLF_RIDER, C.NOMAD])).toEqual([
            { kind: "Placement", value: 1 },
            { kind: "Armor", value: 1 },
            { kind: "Might", value: 3 },
            { kind: "Movement", value: 2 },
        ]);
    });

    test("preserves frozen v0.7 Tier-2, synergy, placement, and fallback behavior", () => {
        const own = [C.HEALER, C.ABOMINATION, C.PEASANT];
        const offered = [1, 4, 10];

        expect(replay.pickArtifactT2(offered, own)).toBe(frozenV07.pickArtifactT2(offered, own));
        expect(replay.pickSynergies(own)).toEqual(frozenV07.pickSynergies(own));
        expect(replay.placement).toBe(frozenV07.placement);
        expect(replay.pickAugments(6, own)).toEqual(frozenV07.pickAugments(6, own));
        expect(replay.pickAugments(7, [])).toEqual(frozenV07.pickAugments(7, []));
    });
});
