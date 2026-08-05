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
import {
    V08_A19_F184_LOWER_HUMAN_PLACEMENT_FIXTURE_SHA256,
    V08_A19_F184_LOWER_HUMAN_PLACEMENT_POLICY,
    V08A19F184LowerHumanPlacementStrategy,
} from "../../src/ai/versions/v0_8_a19_f184_lower_human_placement";
import {
    buildV08A19H18F184LowerHumanRankedFallbackSearchEnvironment,
    createV08A19H18F184LowerHumanPlacementStrategy,
    createV08A19H18F184LowerHumanRankedFallbackStrategy,
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
import { fingerprintV08AlignedV1 } from "../../src/simulation/optimizer/v0_8_aligned_96h_v1_protocol";
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
                    lower: [3, 4, 6, 9, 33, 37],
                    upper: [12, 27, 34, 43, 47, 55],
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
});
