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

import {
    buildV08A19H64FinalistV6SearchEnvironment,
    createV08A19H64FinalistV6Strategy,
    V08_A19_H64_FINALIST_V6_PROFILE,
} from "./v0_8_a19_h18_f184_lower_human_placement_profile";

/** Stable production identity for the qualified A19 finalist shipped behind the v0.8 wire version. */
export const V08_A19_PROFILE_SCHEMA = "hoc.v0_8_a19_production_profile.v1" as const;
export const V08_A19_CANDIDATE_ID = "a19" as const;
export const V08_A19_PRODUCTION_VERSION = "v0.8" as const;
export const V08_A19_PRODUCTION_REGISTRY_IMPLEMENTATION_SOURCE = "src/ai/index.ts" as const;
// Re-pinned after exporting the ranked AI doctrine-choice helpers. The v0.8 registry routing itself is unchanged;
// this ledger intentionally binds the complete current source bytes rather than frozen qualification evidence.
export const V08_A19_PRODUCTION_REGISTRY_IMPLEMENTATION_SHA256 =
    "4b35add5cacfe4f4a128b0179543b1b245b90cbbdba20e8f731dbc4f31d757bc" as const;
export const V08_A19_PRODUCTION_SEARCH_FACTORY_IMPLEMENTATION_SOURCE = "src/simulation/v0_8_a19_search.ts" as const;
export const V08_A19_PRODUCTION_SEARCH_FACTORY_IMPLEMENTATION_SHA256 =
    "9c1d70f719c8f6db786a0d00b04a40e4bfa9b90b22c0f22d1ae4374905faf134" as const;
export const V08_A19_PRODUCTION_BATTLE_ENGINE_IMPLEMENTATION_SOURCE = "src/simulation/battle_engine.ts" as const;
// Re-pinned for rectangular unit footprints (2026-08-24): placeArmy now records a stack's width/height when
// it is not square, the three hand-written 2x2 expansions were routed through simulation/footprint.ts, and
// the tactical-split placement payload now carries the real footprint instead of only a small/large boolean.
// Both shipped shapes keep their exact cells, so the routing decision and every 1x1/2x2 rollout are unchanged
// — held to the square-only outcome fingerprint across v0.1..v0.8 and all four grid types.
export const V08_A19_PRODUCTION_BATTLE_ENGINE_IMPLEMENTATION_SHA256 =
    "c3bc26bcb4b88e94bae45296586a9e01b6e107ec4cf502455b31e744fbac0d43" as const;
export const V08_A19_PRODUCTION_TOURNAMENT_IMPLEMENTATION_SOURCE = "src/simulation/tournament.ts" as const;
export const V08_A19_PRODUCTION_TOURNAMENT_IMPLEMENTATION_SHA256 =
    "afc6df1b4ca82e16a43ebc5bf2cce37ab0c761bec81f8ef5714c3d80c8b2d294" as const;

/** Current-source routing added by promotion; the finalist's frozen qualification ledger remains immutable. */
export const V08_A19_PRODUCTION_ROUTING_SOURCE_LEDGER = Object.freeze([
    Object.freeze({
        role: "ai-registry-promotion" as const,
        source: V08_A19_PRODUCTION_REGISTRY_IMPLEMENTATION_SOURCE,
        sha256: V08_A19_PRODUCTION_REGISTRY_IMPLEMENTATION_SHA256,
    }),
    Object.freeze({
        role: "default-search-factory" as const,
        source: V08_A19_PRODUCTION_SEARCH_FACTORY_IMPLEMENTATION_SOURCE,
        sha256: V08_A19_PRODUCTION_SEARCH_FACTORY_IMPLEMENTATION_SHA256,
    }),
    Object.freeze({
        role: "default-search-routing" as const,
        source: V08_A19_PRODUCTION_BATTLE_ENGINE_IMPLEMENTATION_SOURCE,
        sha256: V08_A19_PRODUCTION_BATTLE_ENGINE_IMPLEMENTATION_SHA256,
    }),
    Object.freeze({
        role: "historical-tournament-control" as const,
        source: V08_A19_PRODUCTION_TOURNAMENT_IMPLEMENTATION_SOURCE,
        sha256: V08_A19_PRODUCTION_TOURNAMENT_IMPLEMENTATION_SHA256,
    }),
] as const);

/**
 * Promote the qualified A19 v6 finalist without mutating its frozen research evidence. Saved games and AI
 * seats continue to use `v0.8`; this profile identifies the placement and rollout-search composition behind it.
 */
export const V08_A19_PROFILE = Object.freeze({
    schema: V08_A19_PROFILE_SCHEMA,
    candidateId: V08_A19_CANDIDATE_ID,
    researchOnly: false as const,
    productionVersion: V08_A19_PRODUCTION_VERSION,
    promotedFrom: V08_A19_H64_FINALIST_V6_PROFILE,
    genomeSha256: V08_A19_H64_FINALIST_V6_PROFILE.genomeSha256,
    behaviorEnvironmentSha256: V08_A19_H64_FINALIST_V6_PROFILE.behaviorEnvironmentSha256,
    genome: V08_A19_H64_FINALIST_V6_PROFILE.genome,
    search: V08_A19_H64_FINALIST_V6_PROFILE.search,
    policy: V08_A19_H64_FINALIST_V6_PROFILE.policy,
    searchPolicy: V08_A19_H64_FINALIST_V6_PROFILE.searchPolicy,
    placementPolicy: V08_A19_H64_FINALIST_V6_PROFILE.placementPolicy,
    promotionSourceLedger: V08_A19_PRODUCTION_ROUTING_SOURCE_LEDGER,
});

/** Build the complete sealed A19 environment used by default v0.8 rollout-search runtimes. */
export function buildV08A19SearchEnvironment(): Readonly<Record<string, string | undefined>> {
    return buildV08A19H64FinalistV6SearchEnvironment();
}

/** Create fresh match-local placement state around the native v0.8 combat strategy. */
export function createV08A19Strategy(): ReturnType<typeof createV08A19H64FinalistV6Strategy> {
    return createV08A19H64FinalistV6Strategy();
}
