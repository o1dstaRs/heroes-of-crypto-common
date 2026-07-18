import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import { Tier2Artifact } from "../../src/artifacts/artifact_properties";
import { creatureInfo } from "../../src/ai/setup/creature_score";
import { conditionalAugments, parseConditionalRules } from "../../src/ai/setup/setup_conditional";
import {
    canonicalSetupPolicyBehavior,
    compileNonFightSetupPolicy,
    COHORT_SAFE_PUBLIC_ROSTER_PLACEMENT,
    parseSetupPolicyArtifact,
    parseSetupPolicyBehavior,
    placementOpponentVisibility,
    pickSynergiesForVariant,
    pickTier2ForVariant,
    resolveSetupPolicy,
    SETUP_COHORTS,
    setupAugmentsForPlan,
    setupCohort,
    V07_COHORT_SAFE_PUBLIC_ROSTER_BEHAVIOR_SHA256,
    V07_COHORT_SAFE_PUBLIC_ROSTER_SETUP_ARTIFACT,
    V07_COHORT_SAFE_PUBLIC_ROSTER_SETUP_SPEC,
    V07_NONFIGHT_BEHAVIOR_SHA256,
    V07_NONFIGHT_SETUP_ARTIFACT,
    V07_NONFIGHT_SETUP_SPEC,
    V07_PUBLIC_ROSTER_BEHAVIOR_SHA256,
    V07_PUBLIC_ROSTER_SETUP_ARTIFACT,
    V07_PUBLIC_ROSTER_SETUP_SPEC,
    type ISetupPolicyBehavior,
    type SetupCohort,
} from "../../src/ai/setup/setup_ship";
import { SETUP_POLICY_V0 } from "../../src/ai/setup/setup_v0";
import { ChaosSynergy } from "../../src/synergies/synergy_properties";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import {
    compileNonFightSetupPolicy as optimizerCompileNonFightSetupPolicy,
    setupCohort as optimizerSetupCohort,
} from "../../src/simulation/optimizer/v0_7_setup_overnight_core";

const allCreatureIds = Object.values(PBTypes.CreatureVals).filter(
    (value): value is number => typeof value === "number" && value > 0 && !!creatureInfo(value),
);
const ranged = allCreatureIds.filter((id) => creatureInfo(id)!.ranged);
const meleeOther = allCreatureIds.filter((id) => setupCohort([id]) === "melee-other");

const rosterForCohort = (cohort: SetupCohort): number[] => {
    const special = allCreatureIds.find((id) => setupCohort([id]) === cohort);
    const roster =
        cohort === "ranged-4plus"
            ? [...ranged.slice(0, 4), ...meleeOther.slice(0, 2)]
            : cohort === "ranged-2to3"
              ? [...ranged.slice(0, 2), ...meleeOther.slice(0, 4)]
              : cohort === "ranged-1"
                ? [...ranged.slice(0, 1), ...meleeOther.slice(0, 5)]
                : cohort === "melee-other"
                  ? meleeOther.slice(0, 6)
                  : [special!, ...meleeOther.filter((id) => id !== special).slice(0, 5)];
    expect(roster).toHaveLength(6);
    expect(roster.every((id) => id !== undefined)).toBe(true);
    expect(setupCohort(roster)).toBe(cohort);
    return roster;
};

const artifactOffers = (): number[][] => {
    const offers: number[][] = [];
    for (let first = 1; first <= 10; first += 1) {
        for (let second = first + 1; second <= 11; second += 1) {
            for (let third = second + 1; third <= 12; third += 1) offers.push([first, second, third]);
        }
    }
    return offers;
};

describe("frozen v0.7 non-fight setup artifact", () => {
    test("has the deterministic behavior hash, exact terminal behavior, and immutable nested state", () => {
        expect(V07_NONFIGHT_SETUP_ARTIFACT.spec).toBe(V07_NONFIGHT_SETUP_SPEC);
        expect(
            createHash("sha256").update(canonicalSetupPolicyBehavior(V07_NONFIGHT_SETUP_ARTIFACT.policy)).digest("hex"),
        ).toBe(V07_NONFIGHT_BEHAVIOR_SHA256);
        expect(V07_NONFIGHT_SETUP_ARTIFACT.policy).toEqual({
            augmentsByCohort: {
                "ranged-4plus": { placement: 0, armor: 3, might: 1, sniper: 3, movement: 0 },
                "ranged-2to3": { placement: 0, armor: 2, might: 2, sniper: 3, movement: 0 },
                "ranged-1": { placement: 0, armor: 3, might: 3, sniper: 1, movement: 0 },
                "melee-magic": { placement: 0, armor: 3, might: 3, sniper: 0, movement: 1 },
                mage: { placement: 0, armor: 3, might: 3, sniper: 0, movement: 1 },
                "aura-heavy": { placement: 0, armor: 3, might: 3, sniper: 0, movement: 1 },
                "melee-other": { placement: 0, armor: 3, might: 3, sniper: 0, movement: 1 },
            },
            tier2ByCohort: {
                "ranged-4plus": "baseline",
                "ranged-2to3": "promote:10",
                "ranged-1": "promote:1",
                "melee-magic": "baseline",
                mage: "baseline",
                "aura-heavy": "baseline",
                "melee-other": "promote:4",
            },
            synergy: "flip-chaos",
            placement: "legitimate-reveal",
            placementAugmentTiming: "setup-before-placement",
        });
        expect(Object.isFrozen(V07_NONFIGHT_SETUP_ARTIFACT)).toBe(true);
        expect(Object.isFrozen(V07_NONFIGHT_SETUP_ARTIFACT.policy.augmentsByCohort["ranged-2to3"])).toBe(true);
    });

    test("rejects schema drift, unknown keys, incomplete cohorts, invalid plans, and legacy timing", () => {
        expect(() => parseSetupPolicyArtifact({ ...V07_NONFIGHT_SETUP_ARTIFACT, extra: true })).toThrow("keys");
        expect(() =>
            parseSetupPolicyBehavior({ ...V07_NONFIGHT_SETUP_ARTIFACT.policy, placementAugmentTiming: "current-live" }),
        ).toThrow("setup-before-placement");
        expect(() =>
            parseSetupPolicyBehavior({
                ...V07_NONFIGHT_SETUP_ARTIFACT.policy,
                augmentsByCohort: {
                    ...V07_NONFIGHT_SETUP_ARTIFACT.policy.augmentsByCohort,
                    unexpected: { placement: 0, armor: 3, might: 3, sniper: 1, movement: 0 },
                },
            }),
        ).toThrow("keys");
        expect(() =>
            parseSetupPolicyBehavior({
                ...V07_NONFIGHT_SETUP_ARTIFACT.policy,
                augmentsByCohort: {
                    ...V07_NONFIGHT_SETUP_ARTIFACT.policy.augmentsByCohort,
                    mage: { placement: 0, armor: 3, might: 2, sniper: 0, movement: 1 },
                },
            }),
        ).toThrow("spend exactly 7");
    });

    test("rejects a different valid policy even when it copies the approved behavior hash", () => {
        const tamperedPolicy = structuredClone(V07_NONFIGHT_SETUP_ARTIFACT.policy) as ISetupPolicyBehavior;
        tamperedPolicy.augmentsByCohort["ranged-2to3"] = {
            placement: 0,
            armor: 3,
            might: 1,
            sniper: 3,
            movement: 0,
        };
        expect(() =>
            parseSetupPolicyArtifact({
                schemaVersion: 1,
                spec: V07_NONFIGHT_SETUP_SPEC,
                behaviorSha256: V07_NONFIGHT_BEHAVIOR_SHA256,
                policy: tamperedPolicy,
            }),
        ).toThrow("does not match approved spec");
    });

    test("freezes the public-roster candidate as a placement-only delta", () => {
        expect(V07_PUBLIC_ROSTER_SETUP_ARTIFACT.spec).toBe(V07_PUBLIC_ROSTER_SETUP_SPEC);
        expect(
            createHash("sha256")
                .update(canonicalSetupPolicyBehavior(V07_PUBLIC_ROSTER_SETUP_ARTIFACT.policy))
                .digest("hex"),
        ).toBe(V07_PUBLIC_ROSTER_BEHAVIOR_SHA256);
        expect(V07_PUBLIC_ROSTER_SETUP_ARTIFACT.policy.placement).toBe("public-roster");
        expect({
            ...V07_PUBLIC_ROSTER_SETUP_ARTIFACT.policy,
            placement: V07_NONFIGHT_SETUP_ARTIFACT.policy.placement,
        }).toEqual(V07_NONFIGHT_SETUP_ARTIFACT.policy);
        expect(Object.isFrozen(V07_PUBLIC_ROSTER_SETUP_ARTIFACT)).toBe(true);
        expect(Object.isFrozen(V07_PUBLIC_ROSTER_SETUP_ARTIFACT.policy)).toBe(true);
        expect(Object.isFrozen(V07_PUBLIC_ROSTER_SETUP_ARTIFACT.policy.tier2ByCohort)).toBe(true);
    });

    test("freezes the cohort-safe candidate as a distinct placement-only delta", () => {
        expect(V07_COHORT_SAFE_PUBLIC_ROSTER_SETUP_ARTIFACT.spec).toBe(V07_COHORT_SAFE_PUBLIC_ROSTER_SETUP_SPEC);
        expect(
            createHash("sha256")
                .update(canonicalSetupPolicyBehavior(V07_COHORT_SAFE_PUBLIC_ROSTER_SETUP_ARTIFACT.policy))
                .digest("hex"),
        ).toBe(V07_COHORT_SAFE_PUBLIC_ROSTER_BEHAVIOR_SHA256);
        expect(V07_COHORT_SAFE_PUBLIC_ROSTER_SETUP_ARTIFACT.policy.placement).toBe(COHORT_SAFE_PUBLIC_ROSTER_PLACEMENT);
        expect({
            ...V07_COHORT_SAFE_PUBLIC_ROSTER_SETUP_ARTIFACT.policy,
            placement: V07_NONFIGHT_SETUP_ARTIFACT.policy.placement,
        }).toEqual(V07_NONFIGHT_SETUP_ARTIFACT.policy);
        expect(Object.isFrozen(V07_COHORT_SAFE_PUBLIC_ROSTER_SETUP_ARTIFACT)).toBe(true);
        expect(Object.isFrozen(V07_COHORT_SAFE_PUBLIC_ROSTER_SETUP_ARTIFACT.policy)).toBe(true);
        expect(Object.isFrozen(V07_COHORT_SAFE_PUBLIC_ROSTER_SETUP_ARTIFACT.policy.augmentsByCohort.mage)).toBe(true);
    });

    test("rejects cross-spec hash and behavior substitution", () => {
        expect(() =>
            parseSetupPolicyArtifact({
                ...V07_NONFIGHT_SETUP_ARTIFACT,
                spec: V07_PUBLIC_ROSTER_SETUP_SPEC,
                behaviorSha256: V07_PUBLIC_ROSTER_BEHAVIOR_SHA256,
            }),
        ).toThrow(`does not match approved spec ${V07_PUBLIC_ROSTER_SETUP_SPEC}`);
        expect(() =>
            parseSetupPolicyArtifact({
                ...V07_PUBLIC_ROSTER_SETUP_ARTIFACT,
                spec: V07_NONFIGHT_SETUP_SPEC,
                behaviorSha256: V07_NONFIGHT_BEHAVIOR_SHA256,
            }),
        ).toThrow(`does not match approved spec ${V07_NONFIGHT_SETUP_SPEC}`);
        expect(() =>
            parseSetupPolicyArtifact({
                ...V07_PUBLIC_ROSTER_SETUP_ARTIFACT,
                spec: V07_NONFIGHT_SETUP_SPEC,
            }),
        ).toThrow("unknown setup policy behavior hash");
        expect(() =>
            parseSetupPolicyArtifact({
                ...V07_PUBLIC_ROSTER_SETUP_ARTIFACT,
                spec: "v07-nonfight-unknown",
            }),
        ).toThrow("unknown setup policy spec");
    });
});

describe("v0.7 setup ship resolver", () => {
    const optimized = resolveSetupPolicy(V07_NONFIGHT_SETUP_SPEC);

    test("keeps the optimized spec explicit and preserves setup-v0 plus conditional-v1 aliases", () => {
        expect(resolveSetupPolicy(undefined).mode).toBe("setup-v0");
        expect(resolveSetupPolicy("off").mode).toBe("setup-v0");
        expect(resolveSetupPolicy("setup-v0").journalVersion).toBe("setup_v0");
        for (const alias of ["conditional-v1", "conditional-setup-v1", "on", "1", "all", "sniper,t2"]) {
            expect(resolveSetupPolicy(alias).journalVersion).toBe("conditional-setup-v1:sniper+t2");
        }
        expect(resolveSetupPolicy("conditional-v1:sniper").rules).toEqual(["sniper"]);
        expect(resolveSetupPolicy("conditional-setup-v1:sniper+t2").rules).toEqual(["sniper", "t2"]);
        expect(optimized.mode).toBe("optimized-v07");
        expect(optimized.placement).toBe("legitimate-reveal");
        const publicRoster = resolveSetupPolicy(V07_PUBLIC_ROSTER_SETUP_SPEC);
        expect(publicRoster).toMatchObject({
            mode: "optimized-v07",
            spec: V07_PUBLIC_ROSTER_SETUP_SPEC,
            journalVersion: V07_PUBLIC_ROSTER_SETUP_SPEC,
            placement: "public-roster",
        });
        expect(publicRoster.pickAugments(7, rosterForCohort("ranged-2to3"))).toEqual(
            optimized.pickAugments(7, rosterForCohort("ranged-2to3")),
        );
        const cohortSafe = resolveSetupPolicy(V07_COHORT_SAFE_PUBLIC_ROSTER_SETUP_SPEC);
        expect(cohortSafe).toMatchObject({
            mode: "optimized-v07",
            spec: V07_COHORT_SAFE_PUBLIC_ROSTER_SETUP_SPEC,
            journalVersion: V07_COHORT_SAFE_PUBLIC_ROSTER_SETUP_SPEC,
            placement: COHORT_SAFE_PUBLIC_ROSTER_PLACEMENT,
        });
        expect(cohortSafe.pickAugments(7, rosterForCohort("ranged-2to3"))).toEqual(
            optimized.pickAugments(7, rosterForCohort("ranged-2to3")),
        );
        expect(() => resolveSetupPolicy("latest")).toThrow("Invalid setup policy spec");
        expect(() => resolveSetupPolicy("snper")).toThrow("Invalid setup policy spec");
    });

    test("parses the cohort-safe placement mode and resolves only exact melee-other to incumbent visibility", () => {
        const behavior = structuredClone(V07_NONFIGHT_SETUP_ARTIFACT.policy) as ISetupPolicyBehavior;
        behavior.placement = COHORT_SAFE_PUBLIC_ROSTER_PLACEMENT;
        expect(parseSetupPolicyBehavior(behavior).placement).toBe(COHORT_SAFE_PUBLIC_ROSTER_PLACEMENT);
        expect(compileNonFightSetupPolicy(behavior).placement).toBe(COHORT_SAFE_PUBLIC_ROSTER_PLACEMENT);
        expect(placementOpponentVisibility(COHORT_SAFE_PUBLIC_ROSTER_PLACEMENT, rosterForCohort("melee-other"))).toBe(
            "legitimate-reveal",
        );
        for (const cohort of SETUP_COHORTS.filter((value) => value !== "melee-other")) {
            expect(placementOpponentVisibility(COHORT_SAFE_PUBLIC_ROSTER_PLACEMENT, rosterForCohort(cohort))).toBe(
                "public-roster",
            );
        }
        expect(placementOpponentVisibility(COHORT_SAFE_PUBLIC_ROSTER_PLACEMENT, [])).toBe("legitimate-reveal");
    });

    test("does not expose the Set used by conditional decision closures", () => {
        const policy = resolveSetupPolicy("conditional-v1:sniper");
        const roster = rosterForCohort("ranged-2to3");
        const offered = [Tier2Artifact.FARSIGHT_QUIVER, Tier2Artifact.WARLORDS_EDGE];
        const beforeMutation = policy.pickArtifactT2(offered, roster);

        expect(Object.isFrozen(policy.rules)).toBe(true);
        expect(() => (policy.rules as unknown as string[]).push("t2")).toThrow();
        expect(policy.rules).toEqual(["sniper"]);
        expect(policy.pickArtifactT2(offered, roster)).toBe(beforeMutation);
        expect(policy.pickArtifactT2(offered, roster)).toBe(SETUP_POLICY_V0.pickArtifactT2(offered));
    });

    test("uses every frozen cohort plan at budget 7 and conditional-v1 at other budgets", () => {
        const allRules = parseConditionalRules("all");
        for (const cohort of SETUP_COHORTS) {
            const roster = rosterForCohort(cohort);
            expect(optimized.pickAugments(7, roster)).toEqual(
                setupAugmentsForPlan(V07_NONFIGHT_SETUP_ARTIFACT.policy.augmentsByCohort[cohort]),
            );
            for (const budget of [5, 6, 7.5]) {
                expect(optimized.pickAugments(budget, roster)).toEqual(conditionalAugments(budget, roster, allRules));
            }
        }
        expect(optimized.pickAugments(7, [])).toEqual(SETUP_POLICY_V0.pickAugments(7));
    });

    test("matches the shared Tier-2 resolver over every legal three-artifact offer and every cohort", () => {
        expect(artifactOffers()).toHaveLength(220);
        for (const cohort of SETUP_COHORTS) {
            const rosterAtTier2 = rosterForCohort(cohort).slice(0, 5);
            expect(setupCohort(rosterAtTier2)).toBe(cohort);
            const variant = V07_NONFIGHT_SETUP_ARTIFACT.policy.tier2ByCohort[cohort];
            for (const offered of artifactOffers()) {
                expect(optimized.pickArtifactT2(offered, rosterAtTier2)).toBe(
                    pickTier2ForVariant(offered, rosterAtTier2, variant),
                );
            }
        }
        expect(
            optimized.pickArtifactT2([Tier2Artifact.TOME_OF_AMPLIFICATION, 2, 3], rosterForCohort("ranged-2to3")),
        ).toBe(Tier2Artifact.TOME_OF_AMPLIFICATION);
        expect(optimized.pickArtifactT2([Tier2Artifact.WARLORDS_EDGE, 2, 3], rosterForCohort("ranged-1"))).toBe(
            Tier2Artifact.WARLORDS_EDGE,
        );
        expect(optimized.pickArtifactT2([Tier2Artifact.CLOVER_OF_FORTUNE, 2, 3], rosterForCohort("melee-other"))).toBe(
            Tier2Artifact.CLOVER_OF_FORTUNE,
        );
    });

    test("ships the exact shared flip-chaos synergy policy", () => {
        const chaos = allCreatureIds
            .filter((id) => creatureInfo(id)!.faction === PBTypes.FactionVals.CHAOS)
            .slice(0, 2);
        expect(chaos).toHaveLength(2);
        expect(optimized.pickSynergies(chaos)).toEqual(pickSynergiesForVariant(chaos, "flip-chaos"));
        expect(optimized.pickSynergies(chaos)).toContainEqual({
            faction: PBTypes.FactionVals.CHAOS,
            synergy: ChaosSynergy.BREAK_ON_ATTACK,
        });
    });

    test("optimizer imports are the production functions and compile the same behavior", () => {
        expect(optimizerSetupCohort).toBe(setupCohort);
        expect(optimizerCompileNonFightSetupPolicy).toBe(compileNonFightSetupPolicy);
        const candidate = {
            id: "equivalence",
            ...(structuredClone(V07_NONFIGHT_SETUP_ARTIFACT.policy) as ISetupPolicyBehavior),
        };
        const optimizerPolicy = optimizerCompileNonFightSetupPolicy(candidate, V07_NONFIGHT_SETUP_SPEC);
        for (const cohort of SETUP_COHORTS) {
            const roster = rosterForCohort(cohort);
            expect(optimizerPolicy.pickAugments(7, roster)).toEqual(optimized.pickAugments(7, roster));
            expect(optimizerPolicy.pickSynergies(roster)).toEqual(optimized.pickSynergies(roster));
        }
    });
});
