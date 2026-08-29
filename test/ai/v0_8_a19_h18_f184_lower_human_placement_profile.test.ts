/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "bun:test";

import { StrategyV0_8 } from "../../src/ai/versions/v0_8";
import { V08A19BoarBattleMageFlankPlacementStrategy } from "../../src/ai/versions/v0_8_a19_boar_battle_mage_flank_placement";
import { V08A19CompactPlacementStrategy } from "../../src/ai/versions/v0_8_a19_compact_placement";
import {
    V08_A19_F184_LOWER_HUMAN_PLACEMENT_FIXTURE_SHA256,
    V08_A19_F184_LOWER_HUMAN_PLACEMENT_POLICY,
    V08A19F184LowerHumanPlacementStrategy,
} from "../../src/ai/versions/v0_8_a19_f184_lower_human_placement";
import {
    buildV08A19H64FinalistV6SearchEnvironment,
    buildV08A19H18F184LowerHumanRankedFallbackSearchEnvironment,
    buildV08A19H64F184LowerHumanRankedFallbackScoreSafeCompactValidatedSearchEnvironment,
    buildV08A19H64F184LowerHumanRankedFallbackScoreSafeSearchEnvironment,
    createV08A19H18F184LowerHumanPlacementStrategy,
    createV08A19H18F184LowerHumanRankedFallbackStrategy,
    createV08A19H64FinalistV6Strategy,
    createV08A19H64F184LowerHumanRankedFallbackScoreSafeCompactStrategy,
    createV08A19H64F184LowerHumanRankedFallbackScoreSafeCompactValidatedStrategy,
    V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_BASE_VERSION,
    V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_CANDIDATE_ID,
    V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_IMPLEMENTATION_SHA256,
    V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_IMPLEMENTATION_SOURCE,
    V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_POLICY_BINDING,
    V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_PROFILE,
    V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_PROFILE_SCHEMA,
    V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_CANDIDATE_ID,
    V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_BEHAVIOR_ENVIRONMENT_SHA256,
    V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_FAST_FLYER_COHESION_ENV,
    V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_POLICY_BINDING,
    V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_PROFILE,
    V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_PROFILE_SCHEMA,
    V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_SEARCH_POLICY_BINDING,
    V08_A19_H64_FINALIST_V6_BEHAVIOR_ENVIRONMENT_SHA256,
    V08_A19_H64_FINALIST_V6_CANDIDATE_ID,
    V08_A19_H64_FINALIST_V6_PLACEMENT_POLICY_BINDING,
    V08_A19_H64_FINALIST_V6_PROFILE,
    V08_A19_H64_FINALIST_V6_PROFILE_SCHEMA,
    V08_A19_H64_FINALIST_V6_RUNTIME_SOURCE_LEDGER,
    V08_A19_H64_FINALIST_V6_SEARCH_POLICY_BINDING,
    V08_A19_H64_FINALIST_V6_SOLE_ABOMINATION_ARMAGEDDON_DEFEND_ENV,
    V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_ABOMINATION_MIRROR_RELEASE_ENV,
    V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_ARMAGEDDON_DEFEND_CANDIDATE_ENV,
    V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_BEHAVIOR_ENVIRONMENT_SHA256,
    V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_CANDIDATE_ID,
    V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_CANDIDATE_ID,
    V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_IMPLEMENTATION_SHA256,
    V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_POLICY_BINDING,
    V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_PROFILE,
    V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_PROFILE_SCHEMA,
    V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_BEHAVIOR_ENVIRONMENT_SHA256,
    V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_CANDIDATE_ID,
    V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_ENV,
    V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_IMPLEMENTATION_SHA256,
    V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_IMPLEMENTATION_SOURCE,
    V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_PLACEMENT_IMPLEMENTATION_SHA256,
    V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_PLACEMENT_IMPLEMENTATION_SOURCE,
    V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_POLICY_BINDING,
    V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_PROFILE,
    V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_PROFILE_SCHEMA,
    V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_QUALIFICATION_SOURCE_LEDGER,
    V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_EXACT_TERMINAL_RESULTS_ENV,
    V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_FAST_FLYER_COHESION_ENV,
    V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_GENOME,
    V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_GENOME_SHA256,
    V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_NONREGRESSIVE_PRODUCTIVE_OVERRIDE_ENV,
    V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_POLICY_BINDING,
    V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_PROFILE,
    V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_PROFILE_SCHEMA,
    V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_SEARCH,
    V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_STRICT_AGGRESSIVE_WAIT_TIES_ENV,
} from "../../src/ai/versions/v0_8_a19_h18_f184_lower_human_placement_profile";
import {
    V08_A19_H18_F184_HUMAN_PLACEMENT_IMPLEMENTATION_SHA256,
    V08_A19_H18_F184_HUMAN_PLACEMENT_IMPLEMENTATION_SOURCE,
} from "../../src/ai/versions/v0_8_a19_h18_f184_human_placement_profile";
import {
    buildV08A19H18SearchEnvironment,
    V08_A19_H18_BEHAVIOR_ENVIRONMENT_SHA256,
    V08_A19_H18_CANDIDATE_ID,
    V08_A19_H18_GENOME_SHA256,
    V08_A19_H18_PROFILE,
    V08_A19_H18_PROFILE_SCHEMA,
} from "../../src/ai/versions/v0_8_a19_h18_profile";
import {
    V08_A19_H18_RANKED_PLACEMENT_POLICY_BINDING,
    V08_A19_H18_RANKED_PLACEMENT_PROFILE,
} from "../../src/ai/versions/v0_8_a19_h18_ranked_placement_profile";
import { V08A19RankedPlacementStrategy } from "../../src/ai/versions/v0_8_a19_ranked_placement";
import {
    V08_A19_PROD_F184_FIXTURE_ID,
    V08_A19_PROD_F184_FIXTURE_SHA256,
    V08_A19_PROD_F184_MATCH_ID,
} from "../../src/simulation/v0_8_a19_prod_f184_anchor";
import type { ILookaheadDeps } from "../../src/simulation/lookahead";
import {
    fingerprintV08AlignedV1,
    fingerprintV08AlignedV1CandidateGenome,
} from "../../src/simulation/optimizer/v0_8_aligned_96h_v1_protocol";
import { SearchDriver } from "../../src/simulation/search_driver";
import { withScopedAIEnvironment } from "../../src/simulation/v0_8_a13_search";

const implementationUrl = new URL(
    `../../${V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_IMPLEMENTATION_SOURCE}`,
    import.meta.url,
);

describe("v0.8 A19-H18 f184 LOWER-only human-placement research profile", () => {
    it("derives explicitly from the unchanged frozen A19-H18 profile", () => {
        expect(V08_A19_H18_PROFILE).toMatchObject({
            schema: V08_A19_H18_PROFILE_SCHEMA,
            candidateId: V08_A19_H18_CANDIDATE_ID,
            genomeSha256: V08_A19_H18_GENOME_SHA256,
            behaviorEnvironmentSha256: V08_A19_H18_BEHAVIOR_ENVIRONMENT_SHA256,
            researchOnly: true,
        });
        expect(Object.isFrozen(V08_A19_H18_PROFILE)).toBe(true);
        expect(V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_PROFILE.derivesFrom).toBe(V08_A19_H18_PROFILE);
        expect(V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_PROFILE).toMatchObject({
            schema: V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_PROFILE_SCHEMA,
            candidateId: V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_CANDIDATE_ID,
            baseVersion: "v0.8",
            genomeSha256: V08_A19_H18_GENOME_SHA256,
            behaviorEnvironmentSha256: V08_A19_H18_BEHAVIOR_ENVIRONMENT_SHA256,
            researchOnly: true,
        });
        expect(V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_PROFILE_SCHEMA).toContain("lower-only-v1");
        expect(V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_CANDIDATE_ID).toContain("lower-only-v1");
        expect(V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_PROFILE.genome).toBe(V08_A19_H18_PROFILE.genome);
        expect(V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_PROFILE.search).toBe(V08_A19_H18_PROFILE.search);
        expect(V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_PROFILE.policy).toBe(V08_A19_H18_PROFILE.policy);
    });

    it("pins the exact LOWER-only implementation source bytes", () => {
        const bytes = readFileSync(implementationUrl);
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(
            V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_IMPLEMENTATION_SHA256,
        );
    });

    it("binds the frozen v10 gates, production fixture, and LOWER-only scope", () => {
        expect(V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_POLICY_BINDING).toMatchObject({
            schema: V08_A19_F184_LOWER_HUMAN_PLACEMENT_POLICY.schema,
            policyId: V08_A19_F184_LOWER_HUMAN_PLACEMENT_POLICY.policyId,
            implementationSource: V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_IMPLEMENTATION_SOURCE,
            implementationSha256: V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_IMPLEMENTATION_SHA256,
            upstreamImplementation: {
                source: V08_A19_H18_F184_HUMAN_PLACEMENT_IMPLEMENTATION_SOURCE,
                sha256: V08_A19_H18_F184_HUMAN_PLACEMENT_IMPLEMENTATION_SHA256,
                schema: "hoc.v0_8_a19_f184_human_placement.v10",
                policyId: "a19-prod-f184-opening-v1",
            },
            informationRequirement: "public-roster",
            productionFixture: {
                matchId: V08_A19_PROD_F184_MATCH_ID,
                fixtureId: V08_A19_PROD_F184_FIXTURE_ID,
                sha256: V08_A19_PROD_F184_FIXTURE_SHA256,
            },
            scope: {
                map: "NORMAL",
                formation: "prod-f184-observed-opening-lower-only-v1",
                placementType: "RECTANGLE",
                placementDepth: 3,
                legalZoneCellCount: 42,
                exactPublicMatchup: true,
                supportedTeam: "LOWER",
                unsupportedTeamFallback: "exact-incumbent",
                openingIds: ["prod-f184-lower-roster", "prod-f184-upper-roster"],
                rosterCreatureIds: {
                    left: [3, 4, 6, 9, 33, 37],
                    right: [12, 27, 34, 43, 47, 55],
                },
            },
        });
        expect(V08_A19_F184_LOWER_HUMAN_PLACEMENT_FIXTURE_SHA256).toBe(V08_A19_PROD_F184_FIXTURE_SHA256);
        expect(V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_POLICY_BINDING.scope.gridTypes).toBe(
            V08_A19_F184_LOWER_HUMAN_PLACEMENT_POLICY.maps,
        );
        expect(V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_PROFILE.placementPolicy).toBe(
            V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_POLICY_BINDING,
        );
        expect(Object.isFrozen(V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_POLICY_BINDING)).toBe(true);
        expect(Object.isFrozen(V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_POLICY_BINDING.scope)).toBe(true);
    });

    it("keeps the frozen exact-f184 factory on its original plain v0.8 base", () => {
        const first = createV08A19H18F184LowerHumanPlacementStrategy();
        const second = createV08A19H18F184LowerHumanPlacementStrategy();
        const baseOf = (strategy: V08A19F184LowerHumanPlacementStrategy): StrategyV0_8 =>
            (strategy as unknown as { base: StrategyV0_8 }).base;

        expect(first).toBeInstanceOf(V08A19F184LowerHumanPlacementStrategy);
        expect(second).toBeInstanceOf(V08A19F184LowerHumanPlacementStrategy);
        expect(first).not.toBe(second);
        expect(first.version).toBe(V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_BASE_VERSION);
        expect(baseOf(first)).toBeInstanceOf(StrategyV0_8);
        expect(baseOf(second)).toBeInstanceOf(StrategyV0_8);
        expect(baseOf(first)).not.toBe(baseOf(second));
        expect(baseOf(first).version).toBe("v0.8");
    });

    it("gives the exact-over-generic runtime composition a distinct immutable identity", () => {
        expect(V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_PROFILE).toMatchObject({
            schema: V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_PROFILE_SCHEMA,
            candidateId: V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_CANDIDATE_ID,
            baseVersion: "v0.8",
            genomeSha256: V08_A19_H18_GENOME_SHA256,
            behaviorEnvironmentSha256: V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_BEHAVIOR_ENVIRONMENT_SHA256,
            researchOnly: true,
            searchPolicy: V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_SEARCH_POLICY_BINDING,
        });
        expect(V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_PROFILE.derivesFrom).toBe(
            V08_A19_H18_RANKED_PLACEMENT_PROFILE,
        );
        expect(V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_PROFILE.exactTreatmentEvidence).toBe(
            V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_PROFILE,
        );
        expect(V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_POLICY_BINDING).toMatchObject({
            precedence: ["exact-f184-lower", "generic-ranked-placement", "plain-v0.8"],
            behavior: {
                exactMiss: "delegate-to-generic-ranked-placement",
                unsupportedTeam: "delegate-to-generic-ranked-placement",
                genericMiss: "delegate-to-plain-v0.8",
            },
        });
        expect(V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_POLICY_BINDING.exactPolicy).toBe(
            V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_POLICY_BINDING,
        );
        expect(V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_POLICY_BINDING.fallbackPolicy).toBe(
            V08_A19_H18_RANKED_PLACEMENT_POLICY_BINDING,
        );
        expect(V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_PROFILE.placementPolicy).toBe(
            V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_POLICY_BINDING,
        );
        expect(Object.isFrozen(V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_PROFILE)).toBe(true);
        expect(Object.isFrozen(V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_POLICY_BINDING)).toBe(true);
    });

    it("routes the tempo guard only through the versioned runtime composite", () => {
        const frozenA19Environment = buildV08A19H18SearchEnvironment();
        const runtimeEnvironment = buildV08A19H18F184LowerHumanRankedFallbackSearchEnvironment();
        expect(frozenA19Environment[V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_FAST_FLYER_COHESION_ENV]).toBe(
            undefined,
        );
        expect(runtimeEnvironment).toMatchObject({
            SEARCH_HORIZON: "18",
            SEARCH_VERSIONS: "v0.8",
            [V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_FAST_FLYER_COHESION_ENV]: "1",
        });
        expect(fingerprintV08AlignedV1(runtimeEnvironment)).toBe(
            V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_BEHAVIOR_ENVIRONMENT_SHA256,
        );

        const enabledFor = (environment: Readonly<Record<string, string | undefined>>): boolean =>
            withScopedAIEnvironment(
                environment,
                () =>
                    (
                        new SearchDriver({} as ILookaheadDeps, {
                            seed: 184,
                            greenVersion: "v0.8",
                            redVersion: "v0.1",
                        }) as unknown as { fastFlyerCohesion: boolean }
                    ).fastFlyerCohesion,
            );
        expect(enabledFor(frozenA19Environment)).toBe(false);
        expect(enabledFor(runtimeEnvironment)).toBe(true);
    });

    it("keeps the historical v2 profile and environment byte-exact", () => {
        const serializedSha256 = (value: unknown): string =>
            createHash("sha256").update(JSON.stringify(value)).digest("hex");

        expect(V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_PROFILE_SCHEMA).toBe(
            "hoc.v0_8_a19_h18_f184_lower_human_ranked_fallback_research_profile.v2",
        );
        expect(V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_CANDIDATE_ID).toBe(
            "a19-h18-prod-f184-lower-exact-ranked-fallback-tempo-v2-research",
        );
        expect(serializedSha256(buildV08A19H18F184LowerHumanRankedFallbackSearchEnvironment())).toBe(
            "3711c6671beb1e0f0bf3198d1e37596d3c2731814c260026352745b620bbfe24",
        );
        expect(serializedSha256(V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_PROFILE)).toBe(
            "accc304bc99c55dfabbb442966fca1219eb23aa6913aac3a35b68fdd43bb97f6",
        );
    });

    it("adds only the qualified H64 score-safe runtime deltas", () => {
        const v2Environment = buildV08A19H18F184LowerHumanRankedFallbackSearchEnvironment();
        const v3Environment = buildV08A19H64F184LowerHumanRankedFallbackScoreSafeSearchEnvironment();
        const changedKeys = [...new Set([...Object.keys(v2Environment), ...Object.keys(v3Environment)])]
            .filter((key) => v2Environment[key] !== v3Environment[key])
            .sort();

        expect(changedKeys).toEqual([
            "SEARCH_A19_ABOMINATION_MIRROR_RELEASE",
            "SEARCH_A19_ARMAGEDDON_DEFEND_CANDIDATE",
            "SEARCH_A19_EXACT_TERMINAL_RESULTS",
            "SEARCH_A19_NONREGRESSIVE_PRODUCTIVE_OVERRIDE",
            "SEARCH_A19_STRICT_AGGRESSIVE_WAIT_TIES",
            "SEARCH_HORIZON",
        ]);
        expect(v3Environment).toMatchObject({
            SEARCH_HORIZON: "64",
            SEARCH_ROLLOUTS: "2",
            SEARCH_VERSIONS: "v0.8",
            [V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_FAST_FLYER_COHESION_ENV]: "1",
            [V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_ABOMINATION_MIRROR_RELEASE_ENV]: "1",
            [V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_ARMAGEDDON_DEFEND_CANDIDATE_ENV]: "1",
            [V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_STRICT_AGGRESSIVE_WAIT_TIES_ENV]: "1",
            [V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_NONREGRESSIVE_PRODUCTIVE_OVERRIDE_ENV]: "1",
            [V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_EXACT_TERMINAL_RESULTS_ENV]: "1",
        });
        expect(Object.isFrozen(v3Environment)).toBe(true);
        expect(fingerprintV08AlignedV1(v3Environment)).toBe(
            V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_BEHAVIOR_ENVIRONMENT_SHA256,
        );
        expect(
            fingerprintV08AlignedV1CandidateGenome(V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_GENOME),
        ).toBe(V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_GENOME_SHA256);
    });

    it("pins a distinct frozen H64 v3 identity over the unchanged placement composition", () => {
        expect(V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_PROFILE).toMatchObject({
            schema: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_PROFILE_SCHEMA,
            candidateId: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_CANDIDATE_ID,
            researchOnly: true,
            baseVersion: "v0.8",
            genomeSha256: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_GENOME_SHA256,
            behaviorEnvironmentSha256:
                V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_BEHAVIOR_ENVIRONMENT_SHA256,
            search: {
                horizon: 64,
                rollouts: 2,
            },
            searchPolicy: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_POLICY_BINDING,
        });
        expect(V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_PROFILE.derivesFrom).toBe(
            V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_PROFILE,
        );
        expect(V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_PROFILE.placementPolicy).toBe(
            V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_POLICY_BINDING,
        );
        expect(V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_POLICY_BINDING.scope).toMatchObject({
            version: "v0.8",
            horizon: 64,
            rollouts: 2,
            placementComposition: ["exact-f184-lower", "generic-ranked-placement", "plain-v0.8"],
        });
        expect(fingerprintV08AlignedV1(V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_PROFILE)).toBe(
            "599b3cdcf9e432d15c18fbe81300733dd0a69a684867a112499cd6679813bc7f",
        );
        expect(Object.isFrozen(V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_PROFILE)).toBe(true);
        expect(Object.isFrozen(V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_SEARCH)).toBe(true);
        expect(Object.isFrozen(V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_GENOME)).toBe(true);
        expect(Object.isFrozen(V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_GENOME.search)).toBe(true);
        expect(Object.isFrozen(V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_POLICY_BINDING)).toBe(true);
        expect(
            Object.isFrozen(V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_POLICY_BINDING.environmentControls),
        ).toBe(true);
        expect(Object.isFrozen(V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_POLICY_BINDING.scope)).toBe(
            true,
        );
    });

    it("routes every H64 v3 search control through the scoped runtime environment", () => {
        const environment = buildV08A19H64F184LowerHumanRankedFallbackScoreSafeSearchEnvironment();
        const runtime = withScopedAIEnvironment(
            environment,
            () =>
                new SearchDriver({} as ILookaheadDeps, {
                    seed: 184,
                    greenVersion: "v0.8",
                    redVersion: "v0.1",
                }) as unknown as {
                    fastFlyerCohesion: boolean;
                    armageddonDefendCandidate: boolean;
                    abominationMirrorRelease: boolean;
                    strictAggressiveWaitTies: boolean;
                    nonregressiveProductiveOverride: boolean;
                    exactTerminalResults: boolean;
                    horizon: number;
                    rollouts: number;
                },
        );

        expect(runtime).toMatchObject({
            fastFlyerCohesion: true,
            armageddonDefendCandidate: true,
            abominationMirrorRelease: true,
            strictAggressiveWaitTies: true,
            nonregressiveProductiveOverride: true,
            exactTerminalResults: true,
            horizon: 64,
            rollouts: 2,
        });
    });

    it("creates fresh exact, generic, and v0.8 layers for the distinct runtime composition", () => {
        const first = createV08A19H18F184LowerHumanRankedFallbackStrategy();
        const second = createV08A19H18F184LowerHumanRankedFallbackStrategy();
        const genericOf = (strategy: V08A19F184LowerHumanPlacementStrategy): V08A19RankedPlacementStrategy =>
            (strategy as unknown as { base: V08A19RankedPlacementStrategy }).base;
        const baseOf = (strategy: V08A19F184LowerHumanPlacementStrategy): StrategyV0_8 =>
            (genericOf(strategy) as unknown as { base: StrategyV0_8 }).base;

        expect(first).toBeInstanceOf(V08A19F184LowerHumanPlacementStrategy);
        expect(second).toBeInstanceOf(V08A19F184LowerHumanPlacementStrategy);
        expect(first).not.toBe(second);
        expect(genericOf(first)).toBeInstanceOf(V08A19RankedPlacementStrategy);
        expect(genericOf(second)).toBeInstanceOf(V08A19RankedPlacementStrategy);
        expect(genericOf(first)).not.toBe(genericOf(second));
        expect(baseOf(first)).toBeInstanceOf(StrategyV0_8);
        expect(baseOf(second)).toBeInstanceOf(StrategyV0_8);
        expect(baseOf(first)).not.toBe(baseOf(second));
    });

    it("pins a distinct v4 profile and preserves its historical compact source bytes", () => {
        expect(V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_IMPLEMENTATION_SHA256).toBe(
            "b75fef5f755154f6e645126206cedb37cee849741ebb453c8e250db2999e2be0",
        );
        expect(V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_PROFILE).toMatchObject({
            schema: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_PROFILE_SCHEMA,
            candidateId: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_CANDIDATE_ID,
            researchOnly: true,
            baseVersion: "v0.8",
            genomeSha256: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_GENOME_SHA256,
            behaviorEnvironmentSha256:
                V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_BEHAVIOR_ENVIRONMENT_SHA256,
            placementPolicy: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_POLICY_BINDING,
        });
        expect(V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_PROFILE.derivesFrom).toBe(
            V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_PROFILE,
        );
        expect(V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_POLICY_BINDING.precedence).toEqual([
            "exact-f184-lower",
            "l4-scoped-compact",
            "generic-ranked-placement",
            "plain-v0.8",
        ]);
        expect(Object.isFrozen(V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_PROFILE)).toBe(true);
        expect(Object.isFrozen(V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_POLICY_BINDING)).toBe(
            true,
        );
    });

    it("creates fresh exact, compact, generic, and v0.8 layers for v4", () => {
        const first = createV08A19H64F184LowerHumanRankedFallbackScoreSafeCompactStrategy();
        const second = createV08A19H64F184LowerHumanRankedFallbackScoreSafeCompactStrategy();
        const compactOf = (strategy: V08A19F184LowerHumanPlacementStrategy): V08A19CompactPlacementStrategy =>
            (strategy as unknown as { base: V08A19CompactPlacementStrategy }).base;
        const genericOf = (strategy: V08A19F184LowerHumanPlacementStrategy): V08A19RankedPlacementStrategy =>
            (compactOf(strategy) as unknown as { base: V08A19RankedPlacementStrategy }).base;
        const baseOf = (strategy: V08A19F184LowerHumanPlacementStrategy): StrategyV0_8 =>
            (genericOf(strategy) as unknown as { base: StrategyV0_8 }).base;

        expect(first).toBeInstanceOf(V08A19F184LowerHumanPlacementStrategy);
        expect(compactOf(first)).toBeInstanceOf(V08A19CompactPlacementStrategy);
        expect(genericOf(first)).toBeInstanceOf(V08A19RankedPlacementStrategy);
        expect(baseOf(first)).toBeInstanceOf(StrategyV0_8);
        expect(first).not.toBe(second);
        expect(compactOf(first)).not.toBe(compactOf(second));
        expect(genericOf(first)).not.toBe(genericOf(second));
        expect(baseOf(first)).not.toBe(baseOf(second));
    });

    it("pins the self-contained v5 environment and preserves its historical qualification bytes", () => {
        const v3Environment = buildV08A19H64F184LowerHumanRankedFallbackScoreSafeSearchEnvironment();
        const v5Environment = buildV08A19H64F184LowerHumanRankedFallbackScoreSafeCompactValidatedSearchEnvironment();
        const changedKeys = [...new Set([...Object.keys(v3Environment), ...Object.keys(v5Environment)])]
            .filter((key) => v3Environment[key] !== v5Environment[key])
            .sort();

        expect(changedKeys).toEqual([
            "SEARCH_A19_ARMAGEDDON_DEFEND_CANDIDATE",
            V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_ENV,
        ]);
        expect(v5Environment).toMatchObject({
            SEARCH_A19_ARMAGEDDON_DEFEND_CANDIDATE: "0",
            [V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_ENV]: "1",
            SEARCH_GATE: "0.03",
            SEARCH_HORIZON: "64",
            SEARCH_ROLLOUTS: "2",
            SEARCH_VERSIONS: "v0.8",
        });
        expect(Object.isFrozen(v5Environment)).toBe(true);
        expect(fingerprintV08AlignedV1(v5Environment)).toBe(
            V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_BEHAVIOR_ENVIRONMENT_SHA256,
        );

        expect(V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_IMPLEMENTATION_SHA256).toBe(
            "00b1fe13e651ce82b309754993c5dcae4038ad7558092a5edd0fb47a63e85e16",
        );
        expect(
            V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_PLACEMENT_IMPLEMENTATION_SHA256,
        ).toBe("b75fef5f755154f6e645126206cedb37cee849741ebb453c8e250db2999e2be0");
        expect(
            V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_QUALIFICATION_SOURCE_LEDGER,
        ).toEqual([
            {
                role: "search-driver",
                source: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_IMPLEMENTATION_SOURCE,
                sha256: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_IMPLEMENTATION_SHA256,
            },
            {
                role: "compact-placement",
                source: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_PLACEMENT_IMPLEMENTATION_SOURCE,
                sha256: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_PLACEMENT_IMPLEMENTATION_SHA256,
            },
        ]);
    });

    it("pins v5 as a distinct immutable profile over v4", () => {
        expect(V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_PROFILE).toMatchObject({
            schema: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_PROFILE_SCHEMA,
            candidateId: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_CANDIDATE_ID,
            researchOnly: true,
            baseVersion: "v0.8",
            behaviorEnvironmentSha256:
                V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_BEHAVIOR_ENVIRONMENT_SHA256,
            searchPolicy: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_POLICY_BINDING,
            placementPolicy: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_POLICY_BINDING,
        });
        expect(V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_PROFILE.derivesFrom).toBe(
            V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_PROFILE,
        );
        expect(
            V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_PROFILE.qualificationSourceLedger,
        ).toBe(V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_QUALIFICATION_SOURCE_LEDGER);
        expect(
            V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_POLICY_BINDING.validation,
        ).toEqual({
            domain: "a19-nonregressive-override-validation-v2",
            rollouts: 2,
            minimumDelta: 0.03,
            failClosed: true,
        });
        expect(Object.isFrozen(V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_PROFILE)).toBe(
            true,
        );
        expect(
            Object.isFrozen(
                V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_POLICY_BINDING.validation,
            ),
        ).toBe(true);
    });

    it("creates fresh exact, compact, generic, and v0.8 layers for v5", () => {
        const first = createV08A19H64F184LowerHumanRankedFallbackScoreSafeCompactValidatedStrategy();
        const second = createV08A19H64F184LowerHumanRankedFallbackScoreSafeCompactValidatedStrategy();
        const compactOf = (strategy: V08A19F184LowerHumanPlacementStrategy): V08A19CompactPlacementStrategy =>
            (strategy as unknown as { base: V08A19CompactPlacementStrategy }).base;
        const genericOf = (strategy: V08A19F184LowerHumanPlacementStrategy): V08A19RankedPlacementStrategy =>
            (compactOf(strategy) as unknown as { base: V08A19RankedPlacementStrategy }).base;
        const baseOf = (strategy: V08A19F184LowerHumanPlacementStrategy): StrategyV0_8 =>
            (genericOf(strategy) as unknown as { base: StrategyV0_8 }).base;

        expect(first).not.toBe(second);
        expect(compactOf(first)).not.toBe(compactOf(second));
        expect(genericOf(first)).not.toBe(genericOf(second));
        expect(baseOf(first)).not.toBe(baseOf(second));
    });

    it("pins the self-contained v6 environment and immutable qualification source ledger", () => {
        const v5Environment = buildV08A19H64F184LowerHumanRankedFallbackScoreSafeCompactValidatedSearchEnvironment();
        const v6Environment = buildV08A19H64FinalistV6SearchEnvironment();
        const changedKeys = [...new Set([...Object.keys(v5Environment), ...Object.keys(v6Environment)])]
            .filter((key) => v5Environment[key] !== v6Environment[key])
            .sort();

        expect(changedKeys).toEqual([V08_A19_H64_FINALIST_V6_SOLE_ABOMINATION_ARMAGEDDON_DEFEND_ENV]);
        expect(v6Environment).toMatchObject({
            SEARCH_A19_ARMAGEDDON_DEFEND_CANDIDATE: "0",
            SEARCH_A19_NONREGRESSIVE_OVERRIDE_VALIDATION: "1",
            [V08_A19_H64_FINALIST_V6_SOLE_ABOMINATION_ARMAGEDDON_DEFEND_ENV]: "1",
        });
        expect(fingerprintV08AlignedV1(v6Environment)).toBe(V08_A19_H64_FINALIST_V6_BEHAVIOR_ENVIRONMENT_SHA256);
        expect(Object.isFrozen(v6Environment)).toBe(true);

        expect(V08_A19_H64_FINALIST_V6_RUNTIME_SOURCE_LEDGER.map(({ role }) => role)).toEqual([
            "search-driver",
            "armageddon-endgame",
            "boar-battle-mage-flank-placement",
            "compact-placement",
            "tournament-entrant-a-router",
            "battle-engine-search-team-scope",
        ]);
        // Promotion intentionally changed the registry/search router and the tournament's native control, and
        // subsequent shipped policy work changed the generic search driver. Retain those historical entries as
        // immutable qualification provenance while continuing to verify the unchanged policy implementations.
        const currentImplementationRoles = new Set([
            "armageddon-endgame",
            "boar-battle-mage-flank-placement",
            "compact-placement",
        ]);
        for (const { role, source, sha256 } of V08_A19_H64_FINALIST_V6_RUNTIME_SOURCE_LEDGER) {
            if (!currentImplementationRoles.has(role)) continue;
            const bytes = readFileSync(new URL(`../../${source}`, import.meta.url));
            expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
        }
        expect(Object.isFrozen(V08_A19_H64_FINALIST_V6_RUNTIME_SOURCE_LEDGER)).toBe(true);
        expect(V08_A19_H64_FINALIST_V6_RUNTIME_SOURCE_LEDGER.every((pin) => Object.isFrozen(pin))).toBe(true);
    });

    it("pins v6 as a distinct immutable finalist over v5", () => {
        expect(V08_A19_H64_FINALIST_V6_PROFILE).toMatchObject({
            schema: V08_A19_H64_FINALIST_V6_PROFILE_SCHEMA,
            candidateId: V08_A19_H64_FINALIST_V6_CANDIDATE_ID,
            researchOnly: true,
            baseVersion: "v0.8",
            behaviorEnvironmentSha256: V08_A19_H64_FINALIST_V6_BEHAVIOR_ENVIRONMENT_SHA256,
            searchPolicy: V08_A19_H64_FINALIST_V6_SEARCH_POLICY_BINDING,
            placementPolicy: V08_A19_H64_FINALIST_V6_PLACEMENT_POLICY_BINDING,
        });
        expect(V08_A19_H64_FINALIST_V6_PROFILE.derivesFrom).toBe(
            V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_PROFILE,
        );
        expect(V08_A19_H64_FINALIST_V6_PROFILE.runtimeSourceLedger).toBe(V08_A19_H64_FINALIST_V6_RUNTIME_SOURCE_LEDGER);
        expect(V08_A19_H64_FINALIST_V6_PLACEMENT_POLICY_BINDING.precedence).toEqual([
            "exact-f184-lower",
            "boar-battle-mage-far-flank",
            "l4-scoped-compact",
            "generic-ranked-placement",
            "plain-v0.8",
        ]);
        expect(V08_A19_H64_FINALIST_V6_SEARCH_POLICY_BINDING.scope).toMatchObject({
            actingUnit: "Abomination",
            livingAllies: "sole-acting-abomination",
            livingEnemies: "sole-opposing-abomination",
            broadArmageddonCandidate: false,
        });
        expect(Object.isFrozen(V08_A19_H64_FINALIST_V6_PROFILE)).toBe(true);
        expect(Object.isFrozen(V08_A19_H64_FINALIST_V6_SEARCH_POLICY_BINDING)).toBe(true);
        expect(Object.isFrozen(V08_A19_H64_FINALIST_V6_SEARCH_POLICY_BINDING.scope)).toBe(true);
        expect(Object.isFrozen(V08_A19_H64_FINALIST_V6_PLACEMENT_POLICY_BINDING)).toBe(true);
    });

    it("enables the v6 terminal policy only in its scoped environment", () => {
        const enabledFor = (environment: Readonly<Record<string, string | undefined>>): boolean =>
            withScopedAIEnvironment(
                environment,
                () =>
                    (
                        new SearchDriver({} as ILookaheadDeps, {
                            seed: 184,
                            greenVersion: "v0.8",
                            redVersion: "v0.1",
                        }) as unknown as { soleAbominationArmageddonDefendPolicy: boolean }
                    ).soleAbominationArmageddonDefendPolicy,
            );

        expect(enabledFor(buildV08A19H64F184LowerHumanRankedFallbackScoreSafeCompactValidatedSearchEnvironment())).toBe(
            false,
        );
        expect(enabledFor(buildV08A19H64FinalistV6SearchEnvironment())).toBe(true);
    });

    it("creates fresh exact, flank, compact, generic, and v0.8 layers for v6", () => {
        const first = createV08A19H64FinalistV6Strategy();
        const second = createV08A19H64FinalistV6Strategy();
        const flankOf = (strategy: V08A19F184LowerHumanPlacementStrategy): V08A19BoarBattleMageFlankPlacementStrategy =>
            (strategy as unknown as { base: V08A19BoarBattleMageFlankPlacementStrategy }).base;
        const compactOf = (strategy: V08A19F184LowerHumanPlacementStrategy): V08A19CompactPlacementStrategy =>
            (flankOf(strategy) as unknown as { base: V08A19CompactPlacementStrategy }).base;
        const genericOf = (strategy: V08A19F184LowerHumanPlacementStrategy): V08A19RankedPlacementStrategy =>
            (compactOf(strategy) as unknown as { base: V08A19RankedPlacementStrategy }).base;
        const baseOf = (strategy: V08A19F184LowerHumanPlacementStrategy): StrategyV0_8 =>
            (genericOf(strategy) as unknown as { base: StrategyV0_8 }).base;

        expect(first).toBeInstanceOf(V08A19F184LowerHumanPlacementStrategy);
        expect(flankOf(first)).toBeInstanceOf(V08A19BoarBattleMageFlankPlacementStrategy);
        expect(compactOf(first)).toBeInstanceOf(V08A19CompactPlacementStrategy);
        expect(genericOf(first)).toBeInstanceOf(V08A19RankedPlacementStrategy);
        expect(baseOf(first)).toBeInstanceOf(StrategyV0_8);
        expect(first).not.toBe(second);
        expect(flankOf(first)).not.toBe(flankOf(second));
        expect(compactOf(first)).not.toBe(compactOf(second));
        expect(genericOf(first)).not.toBe(genericOf(second));
        expect(baseOf(first)).not.toBe(baseOf(second));
    });
});
