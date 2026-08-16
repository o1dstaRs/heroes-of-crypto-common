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
    V08_A19_BOAR_BATTLE_MAGE_FLANK_PLACEMENT_POLICY,
    V08A19BoarBattleMageFlankPlacementStrategy,
} from "./v0_8_a19_boar_battle_mage_flank_placement";
import {
    V08_A19_COMPACT_PLACEMENT_ANCHORS,
    V08_A19_COMPACT_PLACEMENT_POLICY,
    V08A19CompactPlacementStrategy,
} from "./v0_8_a19_compact_placement";
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
    const environment = { ...buildV08A19H18SearchEnvironment() };
    // A13 now clears this research switch explicitly. Remove that inherited slot before re-adding the v2 value
    // so the historical environment's canonical JSON key order (and therefore its frozen fingerprint) is stable.
    delete environment[V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_FAST_FLYER_COHESION_ENV];
    return Object.freeze({
        ...environment,
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

export const V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_PROFILE_SCHEMA =
    "hoc.v0_8_a19_h64_f184_lower_human_ranked_fallback_score_safe_research_profile.v3" as const;
export const V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_CANDIDATE_ID =
    "a19-h64-prod-f184-lower-exact-ranked-fallback-score-safe-v3-research" as const;
export const V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_FAST_FLYER_COHESION_ENV =
    "SEARCH_A19_FAST_FLYER_COHESION" as const;
export const V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_ABOMINATION_MIRROR_RELEASE_ENV =
    "SEARCH_A19_ABOMINATION_MIRROR_RELEASE" as const;
export const V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_ARMAGEDDON_DEFEND_CANDIDATE_ENV =
    "SEARCH_A19_ARMAGEDDON_DEFEND_CANDIDATE" as const;
export const V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_STRICT_AGGRESSIVE_WAIT_TIES_ENV =
    "SEARCH_A19_STRICT_AGGRESSIVE_WAIT_TIES" as const;
export const V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_NONREGRESSIVE_PRODUCTIVE_OVERRIDE_ENV =
    "SEARCH_A19_NONREGRESSIVE_PRODUCTIVE_OVERRIDE" as const;
export const V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_EXACT_TERMINAL_RESULTS_ENV =
    "SEARCH_A19_EXACT_TERMINAL_RESULTS" as const;
export const V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_BEHAVIOR_ENVIRONMENT_SHA256 =
    "231818aebb9215c0032e6a9a180f078a82dd410acef24a43026f432d95ec484a" as const;

export const V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_SEARCH = Object.freeze({
    ...V08_A19_H18_PROFILE.search,
    horizon: 64,
});

export const V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_GENOME = Object.freeze({
    ...V08_A19_H18_PROFILE.genome,
    search: Object.freeze({
        ...V08_A19_H18_PROFILE.genome.search,
        horizon: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_SEARCH.horizon,
    }),
});
export const V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_GENOME_SHA256 =
    "c866a90e3159e91fa3c01eb80819a8fa3f4d41e6c3577af6927c70a708c7109f" as const;

/** The exact opt-in controls retained by the H64 score-safe qualification. */
export const V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_POLICY_BINDING = Object.freeze({
    schema: "hoc.v0_8_a19_h64_ranked_fallback_score_safe_search.v3" as const,
    policyId: "a19-h64-ranked-fallback-score-safe-v3" as const,
    derivesFrom: V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_SEARCH_POLICY_BINDING,
    environmentControls: Object.freeze({
        fastFlyerCohesion: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_FAST_FLYER_COHESION_ENV,
        abominationMirrorRelease:
            V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_ABOMINATION_MIRROR_RELEASE_ENV,
        armageddonDefendCandidate:
            V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_ARMAGEDDON_DEFEND_CANDIDATE_ENV,
        strictAggressiveWaitTies:
            V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_STRICT_AGGRESSIVE_WAIT_TIES_ENV,
        nonregressiveProductiveOverride:
            V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_NONREGRESSIVE_PRODUCTIVE_OVERRIDE_ENV,
        exactTerminalResults: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_EXACT_TERMINAL_RESULTS_ENV,
    }),
    scope: Object.freeze({
        version: V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_BASE_VERSION,
        horizon: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_SEARCH.horizon,
        rollouts: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_SEARCH.rollouts,
        placementComposition: V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_POLICY_BINDING.precedence,
    }),
});

/** Materialize the complete H64 v3 runtime environment without changing the historical H18 v2 builder. */
export function buildV08A19H64F184LowerHumanRankedFallbackScoreSafeSearchEnvironment(): Readonly<
    Record<string, string | undefined>
> {
    return Object.freeze({
        ...buildV08A19H18F184LowerHumanRankedFallbackSearchEnvironment(),
        SEARCH_HORIZON: String(V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_SEARCH.horizon),
        [V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_FAST_FLYER_COHESION_ENV]: "1",
        [V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_ABOMINATION_MIRROR_RELEASE_ENV]: "1",
        [V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_ARMAGEDDON_DEFEND_CANDIDATE_ENV]: "1",
        [V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_STRICT_AGGRESSIVE_WAIT_TIES_ENV]: "1",
        [V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_NONREGRESSIVE_PRODUCTIVE_OVERRIDE_ENV]: "1",
        [V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_EXACT_TERMINAL_RESULTS_ENV]: "1",
    });
}

/** Immutable identity for the separately qualified H64 score-safe runtime; v2 remains historical evidence. */
export const V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_PROFILE = Object.freeze({
    schema: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_PROFILE_SCHEMA,
    candidateId: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_CANDIDATE_ID,
    researchOnly: true as const,
    baseVersion: V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_BASE_VERSION,
    derivesFrom: V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_PROFILE,
    exactTreatmentEvidence: V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_PROFILE,
    genomeSha256: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_GENOME_SHA256,
    behaviorEnvironmentSha256: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_BEHAVIOR_ENVIRONMENT_SHA256,
    genome: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_GENOME,
    search: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_SEARCH,
    policy: V08_A19_H18_PROFILE.policy,
    searchPolicy: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_POLICY_BINDING,
    placementPolicy: V08_A19_H18_F184_LOWER_HUMAN_RANKED_FALLBACK_POLICY_BINDING,
});

export const V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_PROFILE_SCHEMA =
    "hoc.v0_8_a19_h64_f184_lower_human_ranked_fallback_score_safe_compact_research_profile.v4" as const;
export const V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_CANDIDATE_ID =
    "a19-h64-prod-f184-lower-exact-ranked-fallback-score-safe-compact-v4-research" as const;
export const V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_IMPLEMENTATION_SOURCE =
    "src/ai/versions/v0_8_a19_compact_placement.ts" as const;
/** Historical source bytes recorded by the accepted v4 compact qualification. */
export const V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_IMPLEMENTATION_SHA256 =
    "b75fef5f755154f6e645126206cedb37cee849741ebb453c8e250db2999e2be0" as const;

/** Immutable placement identity for the H64 v4 qualification candidate. */
export const V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_POLICY_BINDING = Object.freeze({
    schema: V08_A19_COMPACT_PLACEMENT_POLICY.schema,
    policyId: V08_A19_COMPACT_PLACEMENT_POLICY.policyId,
    implementationSource: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_IMPLEMENTATION_SOURCE,
    implementationSha256: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_IMPLEMENTATION_SHA256,
    informationRequirement: "own-army+map+legal-cells" as const,
    anchors: V08_A19_COMPACT_PLACEMENT_ANCHORS,
    precedence: Object.freeze([
        "exact-f184-lower",
        "l4-scoped-compact",
        "generic-ranked-placement",
        "plain-v0.8",
    ] as const),
    exactPolicy: V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_POLICY_BINDING,
    compactPolicy: V08_A19_COMPACT_PLACEMENT_POLICY,
    genericPolicy: V08_A19_H18_RANKED_PLACEMENT_POLICY_BINDING,
});

/** The v4 profile changes only placement composition; its H64 score-safe search identity remains v3. */
export const V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_PROFILE = Object.freeze({
    schema: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_PROFILE_SCHEMA,
    candidateId: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_CANDIDATE_ID,
    researchOnly: true as const,
    baseVersion: V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_BASE_VERSION,
    derivesFrom: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_PROFILE,
    genomeSha256: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_GENOME_SHA256,
    behaviorEnvironmentSha256: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_BEHAVIOR_ENVIRONMENT_SHA256,
    genome: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_GENOME,
    search: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_SEARCH,
    policy: V08_A19_H18_PROFILE.policy,
    searchPolicy: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_POLICY_BINDING,
    placementPolicy: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_POLICY_BINDING,
});

/** Create exact-f184 -> scoped-compact -> generic-ranked -> plain-v0.8 with fresh match-local state. */
export function createV08A19H64F184LowerHumanRankedFallbackScoreSafeCompactStrategy(): V08A19F184LowerHumanPlacementStrategy {
    return new V08A19F184LowerHumanPlacementStrategy(
        new V08A19CompactPlacementStrategy(createV08A19H18RankedPlacementStrategy()),
    );
}

export const V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_PROFILE_SCHEMA =
    "hoc.v0_8_a19_h64_f184_lower_human_ranked_fallback_score_safe_compact_validated_research_profile.v5" as const;
export const V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_CANDIDATE_ID =
    "a19-h64-prod-f184-lower-exact-ranked-fallback-score-safe-compact-validated-v5-research" as const;
export const V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_ENV =
    "SEARCH_A19_NONREGRESSIVE_OVERRIDE_VALIDATION" as const;
export const V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_BEHAVIOR_ENVIRONMENT_SHA256 =
    "9713416c23f82af148a98cb019970cb11c5788cd4622ffbea5e6c8186c4c9f71" as const;
export const V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_IMPLEMENTATION_SOURCE =
    "src/simulation/search_driver.ts" as const;
/** Historical source bytes recorded by the accepted v5 seed-271828182 2k qualification artifact. */
export const V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_IMPLEMENTATION_SHA256 =
    "00b1fe13e651ce82b309754993c5dcae4038ad7558092a5edd0fb47a63e85e16" as const;
export const V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_PLACEMENT_IMPLEMENTATION_SOURCE =
    V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_IMPLEMENTATION_SOURCE;
/** Historical compact-placement bytes recorded by the same v5 qualification artifact. */
export const V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_PLACEMENT_IMPLEMENTATION_SHA256 =
    V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_IMPLEMENTATION_SHA256;

export const V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_QUALIFICATION_SOURCE_LEDGER =
    Object.freeze([
        Object.freeze({
            role: "search-driver" as const,
            source: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_IMPLEMENTATION_SOURCE,
            sha256: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_IMPLEMENTATION_SHA256,
        }),
        Object.freeze({
            role: "compact-placement" as const,
            source: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_PLACEMENT_IMPLEMENTATION_SOURCE,
            sha256: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_PLACEMENT_IMPLEMENTATION_SHA256,
        }),
    ] as const);

/**
 * Final v5 search binding. A separate paired R2 bank must independently clear the same 0.03 gate before an
 * otherwise valid search override can replace the incumbent. The inconsistent Armageddon-defend experiment is
 * explicitly disabled; it remains isolated in the historical v3/v4 research identities.
 */
export const V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_POLICY_BINDING = Object.freeze({
    schema: "hoc.v0_8_a19_h64_paired_override_validation.v1" as const,
    policyId: "a19-h64-paired-r2-gate-003-v1" as const,
    derivesFrom: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_POLICY_BINDING,
    implementationSource:
        V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_IMPLEMENTATION_SOURCE,
    implementationSha256:
        V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_IMPLEMENTATION_SHA256,
    environmentControls: Object.freeze({
        nonregressiveOverrideValidation: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_ENV,
        armageddonDefendCandidate:
            V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_ARMAGEDDON_DEFEND_CANDIDATE_ENV,
    }),
    validation: Object.freeze({
        domain: "a19-nonregressive-override-validation-v2" as const,
        rollouts: 2 as const,
        minimumDelta: 0.03 as const,
        failClosed: true as const,
    }),
    disabledExperiments: Object.freeze(["armageddon-defend-candidate"] as const),
});

/** Materialize the complete, self-contained v5 environment used by qualification and tournament workers. */
export function buildV08A19H64F184LowerHumanRankedFallbackScoreSafeCompactValidatedSearchEnvironment(): Readonly<
    Record<string, string | undefined>
> {
    return Object.freeze({
        ...buildV08A19H64F184LowerHumanRankedFallbackScoreSafeSearchEnvironment(),
        [V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_ARMAGEDDON_DEFEND_CANDIDATE_ENV]: "0",
        [V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_ENV]: "1",
    });
}

/** Immutable v5 qualification identity: H64/R2 search, paired override validation, and scoped compact placement. */
export const V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_PROFILE = Object.freeze({
    schema: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_PROFILE_SCHEMA,
    candidateId: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_CANDIDATE_ID,
    researchOnly: true as const,
    baseVersion: V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_BASE_VERSION,
    derivesFrom: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_PROFILE,
    genomeSha256: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_GENOME_SHA256,
    behaviorEnvironmentSha256:
        V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_BEHAVIOR_ENVIRONMENT_SHA256,
    genome: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_GENOME,
    search: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_SEARCH,
    policy: V08_A19_H18_PROFILE.policy,
    searchPolicy: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_POLICY_BINDING,
    placementPolicy: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_POLICY_BINDING,
    qualificationSourceLedger:
        V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_QUALIFICATION_SOURCE_LEDGER,
});

/** Create a fresh strategy stack for the v5 placement identity; its search behavior is bound by the v5 env. */
export function createV08A19H64F184LowerHumanRankedFallbackScoreSafeCompactValidatedStrategy(): V08A19F184LowerHumanPlacementStrategy {
    return createV08A19H64F184LowerHumanRankedFallbackScoreSafeCompactStrategy();
}

export const V08_A19_H64_FINALIST_V6_PROFILE_SCHEMA =
    "hoc.v0_8_a19_h64_paired_safe_compact_terminal_flank_research_profile.v6" as const;
export const V08_A19_H64_FINALIST_V6_CANDIDATE_ID =
    "a19-h64-paired-safe-compact-sole-abom-boar-flank-v6-research" as const;
export const V08_A19_H64_FINALIST_V6_SOLE_ABOMINATION_ARMAGEDDON_DEFEND_ENV =
    "SEARCH_A19_SOLE_ABOMINATION_ARMAGEDDON_DEFEND_POLICY" as const;
export const V08_A19_H64_FINALIST_V6_BEHAVIOR_ENVIRONMENT_SHA256 =
    "423b42c155fd1f90f135cf2feb3999006c22b408c5be6e3b9db132242c85fc88" as const;
export const V08_A19_H64_FINALIST_V6_SEARCH_IMPLEMENTATION_SOURCE = "src/simulation/search_driver.ts" as const;
export const V08_A19_H64_FINALIST_V6_SEARCH_IMPLEMENTATION_SHA256 =
    "4ca144f1ce64e74958fc0ace6a9d1c9c671b7986318f18041a7c84a68a5e63c9" as const;
export const V08_A19_H64_FINALIST_V6_ARMAGEDDON_ENDGAME_IMPLEMENTATION_SOURCE =
    "src/ai/versions/v0_8_armageddon_endgame.ts" as const;
export const V08_A19_H64_FINALIST_V6_ARMAGEDDON_ENDGAME_IMPLEMENTATION_SHA256 =
    "03c069c85fb2e010112cf29d9c6eed079cd221067352935558758606885c919e" as const;
export const V08_A19_H64_FINALIST_V6_PLACEMENT_IMPLEMENTATION_SOURCE =
    "src/ai/versions/v0_8_a19_boar_battle_mage_flank_placement.ts" as const;
export const V08_A19_H64_FINALIST_V6_PLACEMENT_IMPLEMENTATION_SHA256 =
    "8351dce5ee864227ee0438dc3020e2a7eabdee99ae2f86ac4d196df314904f07" as const;
export const V08_A19_H64_FINALIST_V6_COMPACT_PLACEMENT_IMPLEMENTATION_SOURCE =
    V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_IMPLEMENTATION_SOURCE;
export const V08_A19_H64_FINALIST_V6_COMPACT_PLACEMENT_IMPLEMENTATION_SHA256 =
    "432353f62375db8ae85b6120036f7e1a31e607198eb4713c8edfbab5bcf41969" as const;
export const V08_A19_H64_FINALIST_V6_TOURNAMENT_ROUTING_IMPLEMENTATION_SOURCE = "src/simulation/tournament.ts" as const;
export const V08_A19_H64_FINALIST_V6_TOURNAMENT_ROUTING_IMPLEMENTATION_SHA256 =
    "afc6df1b4ca82e16a43ebc5bf2cce37ab0c761bec81f8ef5714c3d80c8b2d294" as const;
export const V08_A19_H64_FINALIST_V6_BATTLE_ENGINE_ROUTING_IMPLEMENTATION_SOURCE =
    "src/simulation/battle_engine.ts" as const;
export const V08_A19_H64_FINALIST_V6_BATTLE_ENGINE_ROUTING_IMPLEMENTATION_SHA256 =
    "aabbec00d051a1835011f44b1058a91c1528757a59bcca4d7a115fc13603308b" as const;

/** Complete source-byte ledger for the v6 runtime delta, including entrant-A-only routing. */
export const V08_A19_H64_FINALIST_V6_RUNTIME_SOURCE_LEDGER = Object.freeze([
    Object.freeze({
        role: "search-driver" as const,
        source: V08_A19_H64_FINALIST_V6_SEARCH_IMPLEMENTATION_SOURCE,
        sha256: V08_A19_H64_FINALIST_V6_SEARCH_IMPLEMENTATION_SHA256,
    }),
    Object.freeze({
        role: "armageddon-endgame" as const,
        source: V08_A19_H64_FINALIST_V6_ARMAGEDDON_ENDGAME_IMPLEMENTATION_SOURCE,
        sha256: V08_A19_H64_FINALIST_V6_ARMAGEDDON_ENDGAME_IMPLEMENTATION_SHA256,
    }),
    Object.freeze({
        role: "boar-battle-mage-flank-placement" as const,
        source: V08_A19_H64_FINALIST_V6_PLACEMENT_IMPLEMENTATION_SOURCE,
        sha256: V08_A19_H64_FINALIST_V6_PLACEMENT_IMPLEMENTATION_SHA256,
    }),
    Object.freeze({
        role: "compact-placement" as const,
        source: V08_A19_H64_FINALIST_V6_COMPACT_PLACEMENT_IMPLEMENTATION_SOURCE,
        sha256: V08_A19_H64_FINALIST_V6_COMPACT_PLACEMENT_IMPLEMENTATION_SHA256,
    }),
    Object.freeze({
        role: "tournament-entrant-a-router" as const,
        source: V08_A19_H64_FINALIST_V6_TOURNAMENT_ROUTING_IMPLEMENTATION_SOURCE,
        sha256: V08_A19_H64_FINALIST_V6_TOURNAMENT_ROUTING_IMPLEMENTATION_SHA256,
    }),
    Object.freeze({
        role: "battle-engine-search-team-scope" as const,
        source: V08_A19_H64_FINALIST_V6_BATTLE_ENGINE_ROUTING_IMPLEMENTATION_SOURCE,
        sha256: V08_A19_H64_FINALIST_V6_BATTLE_ENGINE_ROUTING_IMPLEMENTATION_SHA256,
    }),
] as const);

/** Search delta selected for the v6 finalist after paired safety and independent terminal-policy validation. */
export const V08_A19_H64_FINALIST_V6_SEARCH_POLICY_BINDING = Object.freeze({
    schema: "hoc.v0_8_a19_sole_abomination_armageddon_defend.v1" as const,
    policyId: "a19-sole-abomination-armageddon-defend-v1" as const,
    derivesFrom: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_POLICY_BINDING,
    environmentControl: V08_A19_H64_FINALIST_V6_SOLE_ABOMINATION_ARMAGEDDON_DEFEND_ENV,
    implementationSource: V08_A19_H64_FINALIST_V6_SEARCH_IMPLEMENTATION_SOURCE,
    implementationSha256: V08_A19_H64_FINALIST_V6_SEARCH_IMPLEMENTATION_SHA256,
    scope: Object.freeze({
        actingUnit: "Abomination" as const,
        livingAllies: "sole-acting-abomination" as const,
        livingEnemies: "sole-opposing-abomination" as const,
        opportunity: "exact-upcoming-armageddon-survival-edge" as const,
        liveAndRolloutPolicy: "identical-deterministic-defend" as const,
        broadArmageddonCandidate: false as const,
        searchTeamScope: "entrant-a-physical-team" as const,
    }),
});

/** Placement delta selected for the v6 finalist; all earlier placement identities remain immutable. */
export const V08_A19_H64_FINALIST_V6_PLACEMENT_POLICY_BINDING = Object.freeze({
    schema: V08_A19_BOAR_BATTLE_MAGE_FLANK_PLACEMENT_POLICY.schema,
    policyId: V08_A19_BOAR_BATTLE_MAGE_FLANK_PLACEMENT_POLICY.policyId,
    implementationSource: V08_A19_H64_FINALIST_V6_PLACEMENT_IMPLEMENTATION_SOURCE,
    implementationSha256: V08_A19_H64_FINALIST_V6_PLACEMENT_IMPLEMENTATION_SHA256,
    informationRequirement: "own-army+map+legal-cells" as const,
    precedence: Object.freeze([
        "exact-f184-lower",
        "boar-battle-mage-far-flank",
        "l4-scoped-compact",
        "generic-ranked-placement",
        "plain-v0.8",
    ] as const),
    exactPolicy: V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_POLICY_BINDING,
    flankPolicy: V08_A19_BOAR_BATTLE_MAGE_FLANK_PLACEMENT_POLICY,
    compactPolicy: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_POLICY_BINDING,
    genericPolicy: V08_A19_H18_RANKED_PLACEMENT_POLICY_BINDING,
});

/** Materialize the complete v6 finalist environment without ambient research switches. */
export function buildV08A19H64FinalistV6SearchEnvironment(): Readonly<Record<string, string | undefined>> {
    return Object.freeze({
        ...buildV08A19H64F184LowerHumanRankedFallbackScoreSafeCompactValidatedSearchEnvironment(),
        [V08_A19_H64_FINALIST_V6_SOLE_ABOMINATION_ARMAGEDDON_DEFEND_ENV]: "1",
    });
}

export const V08_A19_H64_FINALIST_V6_PROFILE = Object.freeze({
    schema: V08_A19_H64_FINALIST_V6_PROFILE_SCHEMA,
    candidateId: V08_A19_H64_FINALIST_V6_CANDIDATE_ID,
    researchOnly: true as const,
    baseVersion: V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_BASE_VERSION,
    derivesFrom: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED_PROFILE,
    genomeSha256: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_GENOME_SHA256,
    behaviorEnvironmentSha256: V08_A19_H64_FINALIST_V6_BEHAVIOR_ENVIRONMENT_SHA256,
    genome: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_GENOME,
    search: V08_A19_H64_F184_LOWER_HUMAN_RANKED_FALLBACK_SCORE_SAFE_SEARCH,
    policy: V08_A19_H18_PROFILE.policy,
    searchPolicy: V08_A19_H64_FINALIST_V6_SEARCH_POLICY_BINDING,
    placementPolicy: V08_A19_H64_FINALIST_V6_PLACEMENT_POLICY_BINDING,
    runtimeSourceLedger: V08_A19_H64_FINALIST_V6_RUNTIME_SOURCE_LEDGER,
});

/** Create exact -> Boar/Battle-Mage flank -> scoped compact -> generic ranked -> plain v0.8. */
export function createV08A19H64FinalistV6Strategy(): V08A19F184LowerHumanPlacementStrategy {
    return new V08A19F184LowerHumanPlacementStrategy(
        new V08A19BoarBattleMageFlankPlacementStrategy(
            new V08A19CompactPlacementStrategy(createV08A19H18RankedPlacementStrategy()),
        ),
    );
}
