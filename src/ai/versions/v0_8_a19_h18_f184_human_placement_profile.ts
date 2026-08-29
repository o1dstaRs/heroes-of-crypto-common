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
import {
    V08_A19_F184_HUMAN_PLACEMENT_FIXTURE_SHA256,
    V08_A19_F184_HUMAN_PLACEMENT_POLICY,
    V08A19F184HumanPlacementStrategy,
} from "./v0_8_a19_f184_human_placement";

export const V08_A19_H18_F184_HUMAN_PLACEMENT_PROFILE_SCHEMA =
    "hoc.v0_8_a19_h18_f184_human_placement_research_profile.v10" as const;
export const V08_A19_H18_F184_HUMAN_PLACEMENT_CANDIDATE_ID = "a19-h18-prod-f184-opening-v1-research" as const;
export const V08_A19_H18_F184_HUMAN_PLACEMENT_BASE_VERSION = "v0.8" as const;
export const V08_A19_H18_F184_HUMAN_PLACEMENT_IMPLEMENTATION_SOURCE =
    "src/ai/versions/v0_8_a19_f184_human_placement.ts" as const;
// Re-pinned for rectangular unit footprints (2026-08-24): the layout's hand-written 1x1-or-2x2 expansion was
// replaced by the shared simulation/footprint.ts one. Both shipped shapes keep their exact cells, so every
// qualified 1x1/2x2 placement this profile was measured on is reproduced cell for cell; only the bytes moved.
export const V08_A19_H18_F184_HUMAN_PLACEMENT_IMPLEMENTATION_SHA256 =
    "2a85b4b0e51bd0e2bdad4052fb2aafee644cab05ca1921515c22277f954d0f6d" as const;

/**
 * Browser-safe identity for the exact production-replay opening. The source digest is
 * verified by the test harness; runtime consumers only read this immutable binding and never need filesystem
 * or crypto APIs.
 */
export const V08_A19_H18_F184_HUMAN_PLACEMENT_POLICY_BINDING = Object.freeze({
    schema: V08_A19_F184_HUMAN_PLACEMENT_POLICY.schema,
    policyId: V08_A19_F184_HUMAN_PLACEMENT_POLICY.policyId,
    implementationSource: V08_A19_H18_F184_HUMAN_PLACEMENT_IMPLEMENTATION_SOURCE,
    implementationSha256: V08_A19_H18_F184_HUMAN_PLACEMENT_IMPLEMENTATION_SHA256,
    informationRequirement: "public-roster" as const,
    productionFixture: Object.freeze({
        matchId: "f1841493-c0bd-41e8-9281-27ce531ece8b" as const,
        fixtureId: "prod-ranked-f184-v1" as const,
        sha256: V08_A19_F184_HUMAN_PLACEMENT_FIXTURE_SHA256,
    }),
    scope: Object.freeze({
        map: "NORMAL" as const,
        gridTypes: V08_A19_F184_HUMAN_PLACEMENT_POLICY.maps,
        formation: "prod-f184-observed-opening" as const,
        placementType: "RECTANGLE" as const,
        placementDepth: 3 as const,
        legalZoneCellCount: 42 as const,
        exactPublicMatchup: true as const,
        openingIds: Object.freeze(["prod-f184-lower-roster", "prod-f184-upper-roster"] as const),
        rosterCreatureIds: Object.freeze({
            left: Object.freeze([3, 4, 6, 9, 33, 37] as const),
            right: Object.freeze([12, 27, 34, 43, 47, 55] as const),
        }),
    }),
});

/**
 * A composite research identity. It keeps the frozen A19-H18 search/genome identity byte-for-byte and adds
 * only the independently pinned placement policy. It does not replace or mutate V08_A19_H18_PROFILE.
 */
export const V08_A19_H18_F184_HUMAN_PLACEMENT_PROFILE = Object.freeze({
    schema: V08_A19_H18_F184_HUMAN_PLACEMENT_PROFILE_SCHEMA,
    candidateId: V08_A19_H18_F184_HUMAN_PLACEMENT_CANDIDATE_ID,
    researchOnly: true as const,
    baseVersion: V08_A19_H18_F184_HUMAN_PLACEMENT_BASE_VERSION,
    derivesFrom: V08_A19_H18_PROFILE,
    genomeSha256: V08_A19_H18_GENOME_SHA256,
    behaviorEnvironmentSha256: V08_A19_H18_BEHAVIOR_ENVIRONMENT_SHA256,
    genome: V08_A19_H18_PROFILE.genome,
    search: V08_A19_H18_PROFILE.search,
    policy: V08_A19_H18_PROFILE.policy,
    placementPolicy: V08_A19_H18_F184_HUMAN_PLACEMENT_POLICY_BINDING,
});

/** Create a fresh A19 placement decorator over the exact v0.8 combat strategy. */
export function createV08A19H18F184HumanPlacementStrategy(): V08A19F184HumanPlacementStrategy {
    const base = new StrategyV0_8();
    if (base.version !== V08_A19_H18_F184_HUMAN_PLACEMENT_BASE_VERSION) {
        throw new Error(
            `v0.8 A19-H18 ranked placement requires ${V08_A19_H18_F184_HUMAN_PLACEMENT_BASE_VERSION}, got ${base.version}`,
        );
    }
    return new V08A19F184HumanPlacementStrategy(base);
}
