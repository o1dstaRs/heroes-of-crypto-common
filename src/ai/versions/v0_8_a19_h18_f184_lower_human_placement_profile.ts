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

import { StrategyV0_8 } from "./v0_8";
import {
    V08_A19_F184_LOWER_HUMAN_PLACEMENT_FIXTURE_SHA256,
    V08_A19_F184_LOWER_HUMAN_PLACEMENT_POLICY,
    V08A19F184LowerHumanPlacementStrategy,
} from "./v0_8_a19_f184_lower_human_placement";
import {
    V08_A19_H18_F184_HUMAN_PLACEMENT_IMPLEMENTATION_SHA256,
    V08_A19_H18_F184_HUMAN_PLACEMENT_IMPLEMENTATION_SOURCE,
} from "./v0_8_a19_h18_f184_human_placement_profile";
import {
    buildV08A19H18SearchEnvironment,
    V08_A19_H18_BEHAVIOR_ENVIRONMENT_SHA256,
    V08_A19_H18_GENOME_SHA256,
    V08_A19_H18_PROFILE,
} from "./v0_8_a19_h18_profile";
import {
    createV08A19H18RankedPlacementStrategy,
    V08_A19_H18_RANKED_PLACEMENT_POLICY_BINDING,
    V08_A19_H18_RANKED_PLACEMENT_PROFILE,
} from "./v0_8_a19_h18_ranked_placement_profile";

export const V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_PROFILE_SCHEMA =
    "hoc.v0_8_a19_h18_f184_human_placement_research_profile.v11.lower-only-v1" as const;
export const V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_CANDIDATE_ID =
    "a19-h18-prod-f184-opening-lower-only-v1-research" as const;
export const V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_BASE_VERSION = "v0.8" as const;
export const V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_IMPLEMENTATION_SOURCE =
    "src/ai/versions/v0_8_a19_f184_lower_human_placement.ts" as const;
export const V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_IMPLEMENTATION_SHA256 =
    "5f631b85dcc13fc1c0199d2a2aa6d2ac10f07dce903a8ba9120d5784a24c8464" as const;

/**
 * Browser-safe identity for the development-selected LOWER-only f184 opening. The profile pins both this
 * seat gate and the frozen v10 implementation that supplies its exact roster and legality checks.
 */
export const V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_POLICY_BINDING = Object.freeze({
    schema: V08_A19_F184_LOWER_HUMAN_PLACEMENT_POLICY.schema,
    policyId: V08_A19_F184_LOWER_HUMAN_PLACEMENT_POLICY.policyId,
    implementationSource: V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_IMPLEMENTATION_SOURCE,
    implementationSha256: V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_IMPLEMENTATION_SHA256,
    upstreamImplementation: Object.freeze({
        source: V08_A19_H18_F184_HUMAN_PLACEMENT_IMPLEMENTATION_SOURCE,
        sha256: V08_A19_H18_F184_HUMAN_PLACEMENT_IMPLEMENTATION_SHA256,
        schema: V08_A19_F184_LOWER_HUMAN_PLACEMENT_POLICY.upstreamPolicy.schema,
        policyId: V08_A19_F184_LOWER_HUMAN_PLACEMENT_POLICY.upstreamPolicy.policyId,
    }),
    informationRequirement: "public-roster" as const,
    productionFixture: Object.freeze({
        matchId: "f1841493-c0bd-41e8-9281-27ce531ece8b" as const,
        fixtureId: "prod-ranked-f184-v1" as const,
        sha256: V08_A19_F184_LOWER_HUMAN_PLACEMENT_FIXTURE_SHA256,
    }),
    scope: Object.freeze({
        map: "NORMAL" as const,
        gridTypes: V08_A19_F184_LOWER_HUMAN_PLACEMENT_POLICY.maps,
        formation: "prod-f184-observed-opening-lower-only-v1" as const,
        placementType: "RECTANGLE" as const,
        placementDepth: 3 as const,
        legalZoneCellCount: 42 as const,
        exactPublicMatchup: true as const,
        supportedTeam: "LOWER" as const,
        unsupportedTeamFallback: "exact-incumbent" as const,
        openingIds: Object.freeze(["prod-f184-lower-roster", "prod-f184-upper-roster"] as const),
        rosterCreatureIds: Object.freeze({
            lower: Object.freeze([3, 4, 6, 9, 33, 37] as const),
            upper: Object.freeze([12, 27, 34, 43, 47, 55] as const),
        }),
    }),
});

/**
 * A composite research identity. It keeps the frozen A19-H18 search/genome identity byte-for-byte and adds
 * only the independently pinned LOWER-side placement policy. It does not replace or mutate the base profile.
 */
export const V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_PROFILE = Object.freeze({
    schema: V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_PROFILE_SCHEMA,
    candidateId: V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_CANDIDATE_ID,
    researchOnly: true as const,
    baseVersion: V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_BASE_VERSION,
    derivesFrom: V08_A19_H18_PROFILE,
    genomeSha256: V08_A19_H18_GENOME_SHA256,
    behaviorEnvironmentSha256: V08_A19_H18_BEHAVIOR_ENVIRONMENT_SHA256,
    genome: V08_A19_H18_PROFILE.genome,
    search: V08_A19_H18_PROFILE.search,
    policy: V08_A19_H18_PROFILE.policy,
    placementPolicy: V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_POLICY_BINDING,
});

/** Create a fresh LOWER-only placement decorator over the exact v0.8 combat strategy. */
export function createV08A19H18F184LowerHumanPlacementStrategy(): V08A19F184LowerHumanPlacementStrategy {
    const base = new StrategyV0_8();
    if (base.version !== V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_BASE_VERSION) {
        throw new Error(
            `v0.8 A19-H18 LOWER-only placement requires ${V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_BASE_VERSION}, got ${base.version}`,
        );
    }
    return new V08A19F184LowerHumanPlacementStrategy(base);
}

export const V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_PROFILE_SCHEMA =
    "hoc.v0_8_a19_h18_f184_lower_human_ranked_fallback_research_profile.v2" as const;
export const V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_CANDIDATE_ID =
    "a19-h18-prod-f184-lower-exact-ranked-fallback-tempo-v2-research" as const;
export const V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_FAST_FLYER_COHESION_ENV =
    "SEARCH_A19_FAST_FLYER_COHESION" as const;
export const V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_BEHAVIOR_ENVIRONMENT_SHA256 =
    "735ff73a351f26283629c6d73bf3d6216598c5d7966b05e8cb6d497362f1eac7" as const;

export const V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_SEARCH_POLICY_BINDING = Object.freeze({
    schema: "hoc.v0_8_a19_h18_fast_flyer_cohesion.v1" as const,
    policyId: "a19-h18-fast-flyer-cohesion-v1" as const,
    environmentControl: V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_FAST_FLYER_COHESION_ENV,
    scope: Object.freeze({
        version: V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_BASE_VERSION,
        horizon: V08_A19_H18_PROFILE.search.horizon,
        lap: 1 as const,
        incumbent: "wait" as const,
        candidate: "move-only" as const,
        unit: "level-4-fast-flyer" as const,
    }),
});

/** Materialize the complete runtime search environment without mutating the frozen A19-H18 profile. */
export function buildV08A19H18F184LowerHumanRankedFallbackSearchEnvironment(): Readonly<
    Record<string, string | undefined>
> {
    return Object.freeze({
        ...buildV08A19H18SearchEnvironment(),
        [V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_FAST_FLYER_COHESION_ENV]: "1",
    });
}

/** Identity for the runtime composition; the two independently pinned policy bindings remain unchanged. */
export const V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_POLICY_BINDING = Object.freeze({
    schema: "hoc.v0_8_a19_h18_f184_lower_human_ranked_fallback_placement.v1" as const,
    policyId: "a19-prod-f184-lower-exact-ranked-fallback-v1" as const,
    informationRequirement: "public-roster" as const,
    precedence: Object.freeze(["exact-f184-lower", "generic-ranked-placement", "plain-v0.8"] as const),
    exactPolicy: V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_POLICY_BINDING,
    fallbackPolicy: V08_A19_H18_RANKED_PLACEMENT_POLICY_BINDING,
    behavior: Object.freeze({
        exactMiss: "delegate-to-generic-ranked-placement" as const,
        unsupportedTeam: "delegate-to-generic-ranked-placement" as const,
        genericMiss: "delegate-to-plain-v0.8" as const,
    }),
});

/**
 * The live composite derives from the generic ranked-placement candidate and applies the frozen f184 treatment
 * above it. Keeping this identity separate prevents historical exact-f184 A/B reports from describing a policy
 * whose off-fixture behavior they did not measure.
 */
export const V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_PROFILE = Object.freeze({
    schema: V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_PROFILE_SCHEMA,
    candidateId: V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_CANDIDATE_ID,
    researchOnly: true as const,
    baseVersion: V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_BASE_VERSION,
    derivesFrom: V08_A19_H18_RANKED_PLACEMENT_PROFILE,
    exactTreatmentEvidence: V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_PROFILE,
    genomeSha256: V08_A19_H18_GENOME_SHA256,
    behaviorEnvironmentSha256: V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_BEHAVIOR_ENVIRONMENT_SHA256,
    genome: V08_A19_H18_PROFILE.genome,
    search: V08_A19_H18_PROFILE.search,
    policy: V08_A19_H18_PROFILE.policy,
    searchPolicy: V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_SEARCH_POLICY_BINDING,
    placementPolicy: V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_POLICY_BINDING,
});

/** Create the live exact-f184 -> generic-ranked-placement -> plain-v0.8 composition. */
export function createV08A19H18F184LowerHumanRankedFallbackStrategy(): V08A19F184LowerHumanPlacementStrategy {
    return new V08A19F184LowerHumanPlacementStrategy(createV08A19H18RankedPlacementStrategy());
}
