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
import { V08_A19_SCORED_ARBITRATION_POLICY } from "./v0_8_a19_scored_arbitration";
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
export const V08_A19_PROFILE_SCHEMA = "hoc.v0_8_a19_production_profile.v3" as const;
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
    SEARCH_A19_SCORED_ARBITRATION: "1",
    // One-hit deployment barrels. Search compares a barrel that blocks a friendly shot, and otherwise
    // the nearest enemy barrel only when nothing else deals damage. Classic mountain mining stays banned.
    SEARCH_A19_ARTIFACT_BARREL_ATTACK_COVERAGE: "1",
    // Keep one broader single-target Gravechain attack for the horizon to price its movement denial.
    SEARCH_A19_GRAVECHAIN_COVERAGE: "1",
    // Give a wounded Last Fuse stack one supported counter-trade stand for real-engine comparison.
    SEARCH_A19_LAST_FUSE_TRADES: "1",
    SEARCH_A19_LAST_FUSE_PRIMARY_TRADES: "1",
    // Hydra's capped catalog prices the complete radial impact, shared shields and Devour recovery.
    SEARCH_A19_LIGHTNING_SPIN_COVERAGE: "1",
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
    "34f6b79e5726d4ddde02029a5f5b5f8d0cce5fc8d0e9b8984a36375e03bac33e" as const;

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
        // Re-pinned for whole-impact Hydra catalogs in both production enumeration paths.
        sha256: "98ffdbcd49cda3b48c59338fe8f024d7eb4b7de5b7e086baefb2b1e2a39b917a" as const,
    }),
    Object.freeze({
        role: "gravechain-coverage" as const,
        source: "src/ai/gravechain_shortlist.ts" as const,
        sha256: "e6355ebe4367ec4218b3bd6803fe2e7e9764bf61fd1d7870fad6113d2433790f" as const,
    }),
    Object.freeze({
        role: "last-fuse-trades" as const,
        source: "src/ai/last_fuse_tactics.ts" as const,
        sha256: "26439e470c9e119220dc75654127097abda530772a2147eb98cea6727152cd09" as const,
    }),
    Object.freeze({
        role: "last-fuse-catalog" as const,
        source: "src/ai/candidates.ts" as const,
        // Re-pinned for decision-scoped Smoke damage reuse and exact zero-prevention early exits.
        sha256: "569cce67764aafa1e4ccc0645ccf3c742834c27141bc08c6692bae829b69e051" as const,
    }),
    Object.freeze({
        role: "last-fuse-estimates" as const,
        source: "src/ai/last_fuse_estimate.ts" as const,
        sha256: "c30b7fefd4174b5e9062e4fec0e608da9ef42d7e61d7f342cb651e499a8926f0" as const,
    }),
    Object.freeze({
        role: "lightning-spin-tactics" as const,
        source: "src/ai/lightning_spin_tactics.ts" as const,
        sha256: "bb904e3a03b1b233865a257dd1950605d61308857a21737c9c0317bc06b792b6" as const,
    }),
    Object.freeze({
        role: "ranged-shields" as const,
        source: "src/ai/ranged_shield_estimate.ts" as const,
        sha256: "2c7b63f0ba3460fd4a877bdc9144878539884a18ae007e9e085cb98b5b8ade0d" as const,
    }),
    Object.freeze({
        role: "selection-bounds" as const,
        source: "src/simulation/search_selection_bounds.ts" as const,
        sha256: "fadc8e59acdacd3d2cd9d4ea81d8a443d704dbfaa9c0fafed1f684a00d3a2d26" as const,
    }),
    Object.freeze({
        role: "rollout-allocation" as const,
        source: "src/simulation/search_rollout_allocation.ts" as const,
        sha256: "b0b8b9a488af042195081daeaa4f4c35a25d5d0a34cdf61cb5784d1cc56cb700" as const,
    }),
    Object.freeze({
        role: "scored-arbitration" as const,
        source: "src/ai/versions/v0_8_a19_scored_arbitration.ts" as const,
        sha256: "1acc372b0fb09147e6bfe79e159c197868a9f2643f4dffe7bb25177ca0d008ab" as const,
    }),
    Object.freeze({
        role: "material-arbitration" as const,
        source: "src/ai/versions/v0_8_a19_material_arbitration.ts" as const,
        sha256: "954c5a156b3c814a51ba8fabd9b1b94098198b43ab0068db15f4620b6fba7235" as const,
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
        sha256: "a74b0f7b014b5c138f719f2c4d34d449960975017b36ab796e70a80ac550a6dc" as const,
    }),
    Object.freeze({
        role: "ranked-placement" as const,
        source: "src/ai/versions/v0_8_a19_ranked_placement.ts" as const,
        sha256: "6abcd286f3f325c64c51ead0ffdd2cd2615b861649a02c3a58bbaee994037599" as const,
    }),
    Object.freeze({
        role: "ai-registry-promotion" as const,
        source: "src/ai/index.ts" as const,
        sha256: "8ab1d21ba39a7aeb52a4a6b33fc4784933f5fdbf4c210a9236e3a6cef8d14eb2" as const,
    }),
    Object.freeze({
        role: "default-search-factory" as const,
        source: "src/simulation/v0_8_a19_search.ts" as const,
        sha256: "77d6ffbfbf9a2ad74e2b7a995875ceec71b35bd663831e1f92c7ac337dbff860" as const,
    }),
    Object.freeze({
        role: "default-search-routing" as const,
        source: "src/simulation/battle_engine.ts" as const,
        // Re-pinned for an explicit research deployment intervention; absent hook preserves routing.
        sha256: "60b69ddd9f487c477562ebe6f3a19d1a32067a96a2de368e2024f060f012fe55" as const,
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
    scoredArbitrationPolicy: V08_A19_SCORED_ARBITRATION_POLICY,
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
        // Research candidates require an explicit seat-scoped JSON override; never inherit a shell gate.
        SEARCH_RESEARCH_RANGED_SHIELD_SEQUENCE: "0",
        SEARCH_RESEARCH_FIRE_BREATH_VALUE: "0",
        V08_MAGE_DAMAGE_KILL_PRIORITY_LEFT: "0",
        V08_MAGE_DAMAGE_KILL_PRIORITY_RIGHT: "0",
        // Only the explicit JSON research override may enable this unqualified candidate.
        SEARCH_A19_ARTIFACT_BARREL_SHOT_PROJECTION: "0",
        // Selection-aware tail bounds are an offline, measured research arm. Production stays sealed off.
        SEARCH_A19_CERTIFIED_SELECTION_BOUNDS: "0",
        // Adaptive allocation is an offline experiment; live A19 retains uniform sampling.
        SEARCH_A19_ROLLOUT_ALLOCATION: "uniform",
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
