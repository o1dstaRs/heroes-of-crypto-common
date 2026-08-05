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
    V08_A19_H18_BEHAVIOR_ENVIRONMENT_SHA256,
    V08_A19_H18_GENOME_SHA256,
    V08_A19_H18_PROFILE,
} from "./v0_8_a19_h18_profile";
import { V08_A19_RANKED_PLACEMENT_POLICY, V08A19RankedPlacementStrategy } from "./v0_8_a19_ranked_placement";

export const V08_A19_H18_RANKED_PLACEMENT_PROFILE_SCHEMA =
    "hoc.v0_8_a19_h18_ranked_placement_research_profile.v8" as const;
export const V08_A19_H18_RANKED_PLACEMENT_CANDIDATE_ID = "a19-h18-ranked-placement-v8-research" as const;
export const V08_A19_H18_RANKED_PLACEMENT_BASE_VERSION = "v0.8" as const;
export const V08_A19_H18_RANKED_PLACEMENT_IMPLEMENTATION_SOURCE =
    "src/ai/versions/v0_8_a19_ranked_placement.ts" as const;
export const V08_A19_H18_RANKED_PLACEMENT_IMPLEMENTATION_SHA256 =
    "bdef5884d15c92a0eb6fa9d1b70cd85a802964f70da9a235bc208b6c85365eb2" as const;

/**
 * Browser-safe identity for the production-replay-derived anti-flyer role correction. The source digest is
 * verified by the test harness; runtime consumers only read this immutable binding and never need filesystem
 * or crypto APIs.
 */
export const V08_A19_H18_RANKED_PLACEMENT_POLICY_BINDING = Object.freeze({
    schema: V08_A19_RANKED_PLACEMENT_POLICY.schema,
    policyId: V08_A19_RANKED_PLACEMENT_POLICY.policyId,
    implementationSource: V08_A19_H18_RANKED_PLACEMENT_IMPLEMENTATION_SOURCE,
    implementationSha256: V08_A19_H18_RANKED_PLACEMENT_IMPLEMENTATION_SHA256,
    informationRequirement: "public-roster" as const,
    scope: Object.freeze({
        map: "NORMAL" as const,
        gridTypes: V08_A19_RANKED_PLACEMENT_POLICY.maps,
        formation: "physical-role-corrected-double-flyer-shooter-screen" as const,
        incumbentPrecedence: Object.freeze(["archetype-anchor", "splash-dispersion", "protector-screen"] as const),
    }),
});

/**
 * A composite research identity. It keeps the frozen A19-H18 search/genome identity byte-for-byte and adds
 * only the independently pinned placement policy. It does not replace or mutate V08_A19_H18_PROFILE.
 */
export const V08_A19_H18_RANKED_PLACEMENT_PROFILE = Object.freeze({
    schema: V08_A19_H18_RANKED_PLACEMENT_PROFILE_SCHEMA,
    candidateId: V08_A19_H18_RANKED_PLACEMENT_CANDIDATE_ID,
    researchOnly: true as const,
    baseVersion: V08_A19_H18_RANKED_PLACEMENT_BASE_VERSION,
    derivesFrom: V08_A19_H18_PROFILE,
    genomeSha256: V08_A19_H18_GENOME_SHA256,
    behaviorEnvironmentSha256: V08_A19_H18_BEHAVIOR_ENVIRONMENT_SHA256,
    genome: V08_A19_H18_PROFILE.genome,
    search: V08_A19_H18_PROFILE.search,
    policy: V08_A19_H18_PROFILE.policy,
    placementPolicy: V08_A19_H18_RANKED_PLACEMENT_POLICY_BINDING,
});

/** Create a fresh A19 placement decorator over the exact v0.8 combat strategy. */
export function createV08A19H18RankedPlacementStrategy(): V08A19RankedPlacementStrategy {
    const base = new StrategyV0_8();
    if (base.version !== V08_A19_H18_RANKED_PLACEMENT_BASE_VERSION) {
        throw new Error(
            `v0.8 A19-H18 ranked placement requires ${V08_A19_H18_RANKED_PLACEMENT_BASE_VERSION}, got ${base.version}`,
        );
    }
    return new V08A19RankedPlacementStrategy(base);
}
