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
    buildV08A13SearchEnvironment,
    V08_A13_GENOME,
    V08_A13_POLICY,
    V08_A13_PRODUCTION_VERSION,
    V08_A13_SEARCH,
} from "./v0_8_a13_profile";
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
    V08_A19_F184_LOWER_HUMAN_PLACEMENT_POLICY,
    V08A19F184LowerHumanPlacementStrategy,
} from "./v0_8_a19_f184_lower_human_placement";
import { V08_A19_RANKED_PLACEMENT_POLICY, V08A19RankedPlacementStrategy } from "./v0_8_a19_ranked_placement";

/**
 * The production v0.8 AI: "a19". One flat profile — the a13 genome and value leaf, the A19 search rules that were
 * each measured on top of it, the deep search budget, and the four-layer public-roster placement composition.
 * Saved games and AI seats keep the wire version `v0.8`; this profile is what that version resolves to.
 *
 * The research chain that produced it (h18 -> h64 score-safe -> compact -> validated -> finalist v6 -> v7) was
 * collapsed into this file on 2026-09-20. The measured facts it carried forward:
 *   - horizon 64 with exact terminal results (v3): the leaf reads real fight results inside the horizon;
 *   - fast-flyer cohesion, Abomination mirror release, strict aggressive wait ties, non-regressive productive
 *     override (v3), the sole-Abomination Armageddon defend policy (v6);
 *   - no re-score bank (v7): the paired validation bank vetoed 78% of proposals with a median delta of 0.000
 *     and measured null switched off (50.5% ± 2.9) and pooled (50.5% ± 1.9) — its code is gone;
 *   - per-decision degradation instead of the match-sticky circuit breaker (v7);
 *   - the DEEP BUDGET (2026-09-13, seat-alternated a19-vs-a19 A/Bs at deterministic work): rollouts 4 /
 *     shortlist 6 / max melee 10 measured 55.1% ± 2.0 (2,312 decisive, z 4.9) against the 2/3/6 budget, and
 *     the live-host deadline curve recovered the whole gain at 600 ms (+13.4pp) with 0% deadline fallbacks
 *     at 1,000 ms (p50 211 ms / p90 544 ms / max 980 ms on the 2 vCPU game server).
 */
export const V08_A19_PROFILE_SCHEMA = "hoc.v0_8_a19_production_profile.v2" as const;
export const V08_A19_CANDIDATE_ID = "a19" as const;
export const V08_A19_PRODUCTION_VERSION = V08_A13_PRODUCTION_VERSION;

/** Search controls. Everything not listed here is inherited unchanged from the a13 genome. */
export const V08_A19_SEARCH = Object.freeze({
    ...V08_A13_SEARCH,
    horizon: 64,
    rollouts: 4,
    shortlist: 6,
    maxMelee: 10,
    decisionDeadlineMs: 1000,
    circuitBreakerMs: 1500,
});

/** The A19 search rules layered over the a13 driver, all on. Each key is a `SearchDriver` environment switch. */
export const V08_A19_SEARCH_RULES = Object.freeze({
    SEARCH_A19_FAST_FLYER_COHESION: "1",
    SEARCH_A19_ABOMINATION_MIRROR_RELEASE: "1",
    SEARCH_A19_STRICT_AGGRESSIVE_WAIT_TIES: "1",
    SEARCH_A19_NONREGRESSIVE_PRODUCTIVE_OVERRIDE: "1",
    SEARCH_A19_EXACT_TERMINAL_RESULTS: "1",
    SEARCH_A19_SOLE_ABOMINATION_ARMAGEDDON_DEFEND_POLICY: "1",
    SEARCH_A19_ADAPTIVE_BUDGET: "1",
} as const);

/** Adaptive budget: what a breaker overrun degrades the next decisions to (wall-clock mode only). */
export const V08_A19_DEGRADED_BUDGET = Object.freeze({
    rollouts: 1,
    shortlist: 2,
    decisions: 3,
});

export const V08_A19_POLICY = V08_A13_POLICY;

/** Canonical genome; its canonical-JSON fingerprint must equal V08_A19_GENOME_SHA256. */
export const V08_A19_GENOME = Object.freeze({
    ...V08_A13_GENOME,
    search: Object.freeze({
        ...V08_A13_GENOME.search,
        horizon: V08_A19_SEARCH.horizon,
        rollouts: V08_A19_SEARCH.rollouts,
        maxMelee: V08_A19_SEARCH.maxMelee,
    }),
    controls: Object.freeze({
        ...V08_A13_GENOME.controls,
        shortlist: V08_A19_SEARCH.shortlist,
        decisionDeadlineMs: V08_A19_SEARCH.decisionDeadlineMs,
    }),
});
export const V08_A19_GENOME_SHA256 = "d7e11ac060707a9b70c2be109534b905f25150fdef593cfcc38ba3d38bfec305" as const;
export const V08_A19_BEHAVIOR_ENVIRONMENT_SHA256 =
    "67b82dd713bf6f875daa5125b7ca0f15863a3e70fff015140b208221def82db1" as const;

/**
 * Placement: exact production f184 opening (LEFT only) -> Boar/Battle-Mage far flank -> level-4 scoped compact
 * -> generic ranked placement -> plain v0.8. Each layer delegates on a miss; every layer needs only the public
 * roster and the map.
 */
export const V08_A19_PLACEMENT_POLICY = Object.freeze({
    schema: "hoc.v0_8_a19_placement.v1" as const,
    policyId: "a19-exact-f184-flank-compact-ranked-v1" as const,
    informationRequirement: "public-roster" as const,
    precedence: Object.freeze([
        "exact-f184-lower",
        "boar-battle-mage-far-flank",
        "l4-scoped-compact",
        "generic-ranked-placement",
        "plain-v0.8",
    ] as const),
    exactPolicy: V08_A19_F184_LOWER_HUMAN_PLACEMENT_POLICY,
    flankPolicy: V08_A19_BOAR_BATTLE_MAGE_FLANK_PLACEMENT_POLICY,
    compactPolicy: Object.freeze({ ...V08_A19_COMPACT_PLACEMENT_POLICY, anchors: V08_A19_COMPACT_PLACEMENT_ANCHORS }),
    genericPolicy: V08_A19_RANKED_PLACEMENT_POLICY,
});

/**
 * Source bytes this profile's behavior depends on. `test/ai/v0_8_a19_default_profile.test.ts` re-hashes every
 * entry, so a change to any of these files is a deliberate, re-pinned change to the production AI.
 */
export const V08_A19_SOURCE_LEDGER = Object.freeze([
    Object.freeze({
        role: "search-driver" as const,
        source: "src/simulation/search_driver.ts" as const,
        sha256: "a4804c1df958bf876398c29a4cd9a44e1515bcb72c3cbf5142d98e15dc6b27e3" as const,
    }),
    Object.freeze({
        role: "armageddon-endgame" as const,
        source: "src/ai/versions/v0_8_armageddon_endgame.ts" as const,
        sha256: "03c069c85fb2e010112cf29d9c6eed079cd221067352935558758606885c919e" as const,
    }),
    Object.freeze({
        role: "f184-lower-placement" as const,
        source: "src/ai/versions/v0_8_a19_f184_lower_human_placement.ts" as const,
        sha256: "24e88df821d1cdbc1897bffd2d1f1c6df53ed5f2338f3e97b238b53efb792650" as const,
    }),
    Object.freeze({
        role: "boar-battle-mage-flank-placement" as const,
        source: "src/ai/versions/v0_8_a19_boar_battle_mage_flank_placement.ts" as const,
        sha256: "b73082e2aba6faaab326732e95df4e5f9d554238c1fbd03603bd54685abf7178" as const,
    }),
    Object.freeze({
        role: "compact-placement" as const,
        source: "src/ai/versions/v0_8_a19_compact_placement.ts" as const,
        sha256: "52387ea4bc8d355403e4e74d8026431182ef6bf5430729e31f1e9511439a3629" as const,
    }),
    Object.freeze({
        role: "ranked-placement" as const,
        source: "src/ai/versions/v0_8_a19_ranked_placement.ts" as const,
        sha256: "6abcd286f3f325c64c51ead0ffdd2cd2615b861649a02c3a58bbaee994037599" as const,
    }),
    Object.freeze({
        role: "ai-registry-promotion" as const,
        source: "src/ai/index.ts" as const,
        sha256: "95ea67eda995ecb1acd4e6aa7675eba6a07ea9d550998326363a40805b588c34" as const,
    }),
    Object.freeze({
        role: "default-search-factory" as const,
        source: "src/simulation/v0_8_a19_search.ts" as const,
        sha256: "9c1d70f719c8f6db786a0d00b04a40e4bfa9b90b22c0f22d1ae4374905faf134" as const,
    }),
    Object.freeze({
        role: "default-search-routing" as const,
        source: "src/simulation/battle_engine.ts" as const,
        sha256: "51b90a5336674d7eb231e93795574946f4b0a1318b4497091b0404c8c9a03335" as const,
    }),
] as const);

export const V08_A19_PROFILE = Object.freeze({
    schema: V08_A19_PROFILE_SCHEMA,
    candidateId: V08_A19_CANDIDATE_ID,
    researchOnly: false as const,
    productionVersion: V08_A19_PRODUCTION_VERSION,
    genomeSha256: V08_A19_GENOME_SHA256,
    behaviorEnvironmentSha256: V08_A19_BEHAVIOR_ENVIRONMENT_SHA256,
    genome: V08_A19_GENOME,
    search: V08_A19_SEARCH,
    searchRules: V08_A19_SEARCH_RULES,
    degradedBudget: V08_A19_DEGRADED_BUDGET,
    policy: V08_A19_POLICY,
    placementPolicy: V08_A19_PLACEMENT_POLICY,
    sourceLedger: V08_A19_SOURCE_LEDGER,
});

/** The complete sealed environment: the a13 base with every A19 delta applied. */
function buildSealedEnvironment(): Readonly<Record<string, string | undefined>> {
    return Object.freeze({
        ...buildV08A13SearchEnvironment(V08_A19_PRODUCTION_VERSION),
        SEARCH_HORIZON: String(V08_A19_SEARCH.horizon),
        SEARCH_ROLLOUTS: String(V08_A19_SEARCH.rollouts),
        SEARCH_SHORTLIST: String(V08_A19_SEARCH.shortlist),
        SEARCH_MAX_MELEE: String(V08_A19_SEARCH.maxMelee),
        SEARCH_DECISION_DEADLINE_MS: String(V08_A19_SEARCH.decisionDeadlineMs),
        SEARCH_CIRCUIT_BREAKER_MS: String(V08_A19_SEARCH.circuitBreakerMs),
        ...V08_A19_SEARCH_RULES,
    });
}

/**
 * Build the sealed A19 environment used by every default v0.8 rollout-search runtime.
 *
 * Research override seam: `V08_A19_SEARCH_ENV_OVERRIDES` (a JSON object of env-key -> string) merges LAST, so a
 * measurement can vary individual knobs (SEARCH_ROLLOUTS, SEARCH_SHORTLIST, SEARCH_MAX_MELEE, ...) while
 * everything else stays the exact production profile. Absent (production) the environment is byte-identical;
 * a malformed value THROWS — a silently ignored override would fake the A/B (SEARCH_OPP_MODEL precedent).
 */
export function buildV08A19SearchEnvironment(): Readonly<Record<string, string | undefined>> {
    const base = buildSealedEnvironment();
    const raw = process.env.V08_A19_SEARCH_ENV_OVERRIDES;
    if (!raw) {
        return base;
    }
    let overrides: unknown;
    try {
        overrides = JSON.parse(raw);
    } catch {
        throw new Error(`V08_A19_SEARCH_ENV_OVERRIDES is not valid JSON: ${raw}`);
    }
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
        throw new Error("V08_A19_SEARCH_ENV_OVERRIDES must be a JSON object of env-key -> string");
    }
    for (const [key, value] of Object.entries(overrides)) {
        if (typeof value !== "string") {
            throw new Error(`V08_A19_SEARCH_ENV_OVERRIDES.${key} must be a string`);
        }
    }
    return Object.freeze({ ...base, ...(overrides as Record<string, string>) });
}

/** Generic ranked placement over the native v0.8 combat strategy (the composition's fallback layer). */
export function createV08A19RankedPlacementStrategy(): V08A19RankedPlacementStrategy {
    const base = new StrategyV0_8();
    if (base.version !== V08_A19_PRODUCTION_VERSION) {
        throw new Error(`v0.8 A19 requires ${V08_A19_PRODUCTION_VERSION}, got ${base.version}`);
    }
    return new V08A19RankedPlacementStrategy(base);
}

/** Create fresh match-local placement state around the native v0.8 combat strategy. */
export function createV08A19Strategy(): V08A19F184LowerHumanPlacementStrategy {
    return new V08A19F184LowerHumanPlacementStrategy(
        new V08A19BoarBattleMageFlankPlacementStrategy(
            new V08A19CompactPlacementStrategy(createV08A19RankedPlacementStrategy()),
        ),
    );
}
