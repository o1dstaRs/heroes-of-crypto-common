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

import { A19_LEARNED_FINAL_PLACEMENT_POLICY } from "../placement/policy";
import { A19_TERRAIN_PLACEMENT_POLICY } from "../placement/terrain_reflection";
import { A19_REVEALED_RANGED_POLICY, A19_SNIPER_DONOR_POLICY } from "../setup/a19_revealed_ranged_identity";
import { A19_SHOOTERLESS_MOVEMENT_POLICY } from "../setup/a19_shooterless_setup_identity";
import { A19_STRIKER_MATCHUP_POLICY } from "../setup/a19_striker_matchup_identity";
import { A19_STRIKER_RUSH_POLICY } from "../setup/a19_striker_rush_identity";
import { A19_WANDERING_MAGE_SUPPORT_POLICY } from "../wandering_mage_support";
import { A19_UNIT_SUPPORT_POLICY } from "../support_setup";
import { A19_NIGHTMARE_WALL_MOVEMENT_POLICY } from "../nightmare_wall_movement";
import { BATTLE_MAGE_TARGET_POLICY } from "../battle_mage_targets";

import { StrategyV0_8 } from "./v0_8";
import { V08_A19_SCORED_ARBITRATION_POLICY } from "./v0_8_a19_scored_arbitration";
import { A19_NEURAL_POLICY } from "./v0_8_a19_neural_policy";
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
 * each measured on top of it, complementary R2 search, and the four-layer public-roster placement composition.
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
 *   - complementary R2 adopted by explicit user instruction on 2026-10-25: 37.86% less offline fight time,
 *     48.91% score against R4 over 6,000 games (95% interval 47.33–50.50%). The user accepted the remaining
 *     strength uncertainty; this does not establish the earlier 48% non-inferiority floor or live latency.
 *   - two-fit neural primary-tie correction adopted by explicit user instruction on 2026-11-01.
 *     Both fitted probability heads share the native-start allowance; late or faulty inference retains R2.
 *   - neutral cemetery barrel deliberation (profile v14) adopted by explicit user instruction on 2026-11-19:
 *     a scripted strike on a standing neutral barrel is searched against the other legal actions instead of
 *     being returned unsearched. +3.58 score points against v13 on the registered held-out Cemetery bank
 *     (95% +2.44 to +4.75); its quality and serial-cost gates failed and stay recorded as failed.
 *   - striker rush and the Tier-2 beneficiary rule (profile v15) adopted on 2026-11-20 under the user's
 *     standing instruction to lock in confirmed wins. The seat drafts melee strikers and, facing an army that is
 *     not a melee army, buys Placement 2 / Movement 2 and starts its strikers on the edge of the zone. Search,
 *     weights and budgets are untouched. +28.80 score points against v14 on the registered sealed bank (95%
 *     +23.52 to +34.07); its quality and cost gates failed and stay recorded as failed
 *     (docs/striker_rush_adoption.md).
 *   - shooterless Movement (profile v16) adopted on 2026-11-20 under the same standing instruction. A seat
 *     without a ranged creature spends the Sniper point of its upgrade plan on Movement: Sniper does nothing for
 *     such an army. Only seven-point plans hold that point. +8.06 score points for a seven-point seat against
 *     v15 on the registered sealed bank (95% +3.89 to +12.04); all five registered gates passed
 *     (docs/shooterless_movement_adoption.md). Search, weights and budgets are untouched.
 *   - striker matchup draft (profile v17) adopted on 2026-11-20 under the same standing instruction. Among
 *     the strikers on offer the seat takes the one worth most against the army it can see: every striker has
 *     a measured value for a rush and another for a melee fight, weighed by the probability that the opponent
 *     ends with four or more strikers. Only legally visible opposing creatures are read. +28.06 score points
 *     against v16 on the registered sealed bank (95% +22.96 to +33.06) and +3.52 against v14 (95% -0.83 to
 *     +7.96); all six registered gates passed (docs/striker_matchup_adoption.md). Search, weights and budgets
 *     are untouched.
 */
export const V08_A19_PROFILE_SCHEMA = "hoc.v0_8_a19_production_profile.v17" as const;
export const V08_A19_CANDIDATE_ID = "a19" as const;
export const V08_A19_PRODUCTION_VERSION = V08_A13_PRODUCTION_VERSION;

/** Search controls. Everything not listed here is inherited unchanged from the a13 genome. */
export const V08_A19_SEARCH = Object.freeze({
    ...V08_A13_SEARCH,
    horizon: 64,
    rollouts: 2,
    chanceSampling: "actor-antithetic",
    shortlist: 6,
    maxMelee: 10,
    decisionDeadlineMs: 1000,
    circuitBreakerMs: 1500,
});

/** The A19 search rules layered over the a13 driver, all on. Each key is a `SearchDriver` environment switch. */
export const V08_A19_SEARCH_RULES = Object.freeze({
    // User-adopted 2026-10-25: complementary actor/lap-aligned R2; strength uncertainty is documented.
    SEARCH_A19_COMPLEMENTARY_R2: "1",
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
    // Fresh 12,096-game confirmation: compare melee clears with legal movement and holds, never force them.
    SEARCH_A19_MELEE_BARREL_DELIBERATION: "1",
    // Explicit user adoption: neutral barrel strikes, melee or ranged, get the same comparison. The held-out
    // gain is confirmed; the failed quality and cost gates stay recorded separately.
    SEARCH_A19_NEUTRAL_BARREL_DELIBERATION: "1",
    // Explicit user adoption; preserve the positive estimate and failed qualification separately.
    SEARCH_A19_NIGHTMARE_WALL_MOVEMENT: "1",
    // Keep one broader single-target Gravechain attack for the horizon to price its movement denial.
    SEARCH_A19_GRAVECHAIN_COVERAGE: "1",
    // Give a wounded Last Fuse stack one supported counter-trade stand for real-engine comparison.
    SEARCH_A19_LAST_FUSE_TRADES: "1",
    SEARCH_A19_LAST_FUSE_PRIMARY_TRADES: "1",
    // Hydra's capped catalog prices the complete radial impact, shared shields and Devour recovery.
    SEARCH_A19_LIGHTNING_SPIN_COVERAGE: "1",
    SEARCH_A19_NEURAL_TIES: "1",
    SEARCH_A19_WANDERING_MAGE_SUPPORT: "1",
    SEARCH_A19_SATYR_CONTACT_SUPPORT: "1",
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
export const V08_A19_GENOME_SHA256 = "1ff72691020e57cda1432d08c240a4a32ce8726ad8078c75f34a4030ad5c767c" as const;
export const V08_A19_BEHAVIOR_ENVIRONMENT_SHA256 =
    "397a2fc8dc8d3145ab4cbc5300818d9eb3a89edeb2aacb57739a0a38d0c5c004" as const;

/**
 * User-adopted neutral cemetery barrel deliberation. The switch lives in `SearchDriver`; this record keeps the
 * decision and the failed gates with the profile. See docs/neutral_barrel_deliberation_adoption.md.
 */
export const V08_A19_NEUTRAL_BARREL_DELIBERATION_POLICY = Object.freeze({
    policyId: "a19-neutral-barrel-deliberation-v1",
    adoptedAt: "2026-11-19",
    adoption: "explicit-user-instruction",
    registrationSha256: "8d4a618a9f3533b6a9a91e1784cfe197725996aa97c0a0284529a969badefc81",
    qualification: "strength-confirmed-quality-and-cost-gates-failed",
} as const);

/**
 * Striker rush (profile v15). The draft head and the setup rule live in ai/setup/a19_striker_rush.ts and the
 * server's draft and setup deciders, not in `SearchDriver`; this record keeps the decision, its registration and
 * the two failed gates with the profile. See docs/striker_rush_adoption.md.
 */
export const V08_A19_STRIKER_RUSH_POLICY = Object.freeze({
    policyId: A19_STRIKER_RUSH_POLICY,
    adoptedAt: "2026-11-20",
    adoption: "standing-user-instruction",
    registrationSha256: "d2786fd4acf80d1a02d59cd2ad733e0d78a23a420b54f457bf13d944b24a50b0",
    qualification: "strength-confirmed-quality-and-cost-gates-failed",
} as const);

/**
 * Tier-2 beneficiary rule (artifact-fit-v8), adopted with profile v15 on a changed-case diagnostic rather than
 * a registered confirmation. See docs/artifact_beneficiary_rule.md.
 */
export const V08_A19_ARTIFACT_BENEFICIARY_POLICY = Object.freeze({
    policyId: "artifact-fit-v8",
    adoptedAt: "2026-11-20",
    adoption: "standing-user-instruction",
    qualification: "changed-case-diagnostic",
} as const);

/**
 * Shooterless Movement (profile v16). The rule lives in ai/setup/a19_shooterless_setup.ts and the server's setup
 * decider, not in `SearchDriver`; this record keeps the decision and its registration with the profile. See
 * docs/shooterless_movement_adoption.md.
 */
export const V08_A19_SHOOTERLESS_MOVEMENT_POLICY = Object.freeze({
    policyId: A19_SHOOTERLESS_MOVEMENT_POLICY,
    adoptedAt: "2026-11-20",
    adoption: "standing-user-instruction",
    registrationSha256: "28ca93f78b560d0a8e5217e88f28f4dd8ca2077176fabd899ce676c9ec701945",
    qualification: "registered-confirmation-passed",
} as const);

/**
 * Striker matchup draft (profile v17). The values and the choice live in ai/setup/a19_striker_matchup.ts and the
 * server's draft decider, not in `SearchDriver`; this record keeps the decision and its registration with the
 * profile. See docs/striker_matchup_adoption.md.
 */
export const V08_A19_STRIKER_MATCHUP_POLICY = Object.freeze({
    policyId: A19_STRIKER_MATCHUP_POLICY,
    adoptedAt: "2026-11-20",
    adoption: "standing-user-instruction",
    registrationSha256: "764d9b96b46a323f2ffc3542bf1d39107babbbc43268f33a69b70e3b256db593",
    qualification: "registered-confirmation-passed",
} as const);

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
        role: "terrain-placement-reflection" as const,
        source: "src/ai/placement/terrain_reflection.ts" as const,
        sha256: "3f598faf67be49b241d124f35c2b47192804cdbd52ff738b92f871469106884b" as const,
    }),
    Object.freeze({
        role: "melee-barrel-rollback-environment" as const,
        source: "src/ai/versions/v0_8_a13_profile.ts" as const,
        sha256: "0de782b3da74931726cb8da41c0577546919a2e1f338cb97af99e0a00f26c9eb" as const,
    }),
    Object.freeze({
        role: "nightmare-wall-movement" as const,
        source: "src/ai/nightmare_wall_movement.ts" as const,
        sha256: "2618932cb65f4205ce4a82ec9ff54c41797ee4ca4e85bed6126374957d245020" as const,
    }),
    Object.freeze({
        role: "battle-mage-targets" as const,
        source: "src/ai/battle_mage_targets.ts" as const,
        sha256: "a185a1361e3781cc2e41a8774d86cda77cf986617f7494c2be9ffe87775b86c6" as const,
    }),
    Object.freeze({
        role: "native-v08-combat" as const,
        source: "src/ai/versions/v0_8.ts" as const,
        sha256: "516b07f452d1fdd6b43e5ff1d1c6c498d19f7d7038da957d8158b3963c0f8904" as const,
    }),
    Object.freeze({
        role: "search-driver" as const,
        source: "src/simulation/search_driver.ts" as const,
        // Carries the neutral cemetery barrel deliberation switch that profile v14 turns on.
        sha256: "09f51dd48caee326017ae44597e738d7ee12994118ab343a0ba9cf88a53890e8" as const,
    }),
    Object.freeze({
        role: "unit-support-setup" as const,
        source: "src/ai/support_setup.ts" as const,
        sha256: "540fd13ca8861af1442f136d75e3236caaa488fad2e406af03c205fd0605e622" as const,
    }),
    Object.freeze({
        role: "healer-support-setup" as const,
        source: "src/ai/healer_support_setup.ts" as const,
        sha256: "052d847e336793704059ad9361729b7604eabeed1d9d73708d5a37a0b84bbd18" as const,
    }),
    Object.freeze({
        role: "wandering-mage-support" as const,
        source: "src/ai/wandering_mage_support.ts" as const,
        sha256: "0487911c030deae457a009180c7131277e9610a01e5d22eb805de28e00bdc923" as const,
    }),
    Object.freeze({
        role: "satyr-contact-support" as const,
        source: "src/ai/satyr_contact_support.ts" as const,
        sha256: "d03da01acec056a1f88292ede6f762c1932e733c7b52392d298ee74d181d1a0a" as const,
    }),
    Object.freeze({
        role: "unit-support-adapter" as const,
        source: "src/simulation/a19_support.ts" as const,
        sha256: "7f3d44ddde59aba25540d8e0f9ea48016f93e3945947a335201377c995257db9" as const,
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
        // Candidate rays share the player cursor's selectable-edge gate; Through Shot retains free aim.
        sha256: "896f58905e7c12b52923e602970dd4701fd763faa94fc3337973443bbf62916e" as const,
    }),
    Object.freeze({
        role: "ranged-target-selection" as const,
        source: "src/ai/versions/v0_2.ts" as const,
        sha256: "7a1cfcecc02a803d2a5d7c4dd0dd41a76b98894b1be62d9fdf88644150849a4d" as const,
    }),
    Object.freeze({
        role: "ranged-action-validation" as const,
        source: "src/ai/versions/v0_4.ts" as const,
        sha256: "ce69329aa0d3248847376d10c104adde09014917bc769609f96eb96e385d01ef" as const,
    }),
    Object.freeze({
        role: "player-ranged-aim" as const,
        source: "src/grid/grid_math.ts" as const,
        sha256: "c2032e7689700e930e90f890bd9e8dc1cb3835945dbcb9817470ac455a2947c9" as const,
    }),
    Object.freeze({
        role: "summon-placement" as const,
        source: "src/spells/spell_helper.ts" as const,
        sha256: "dfb8bcdcbf3f550a8f8ca30de2af01174a78dc81b892ece14ef1d4780fcf4c6a" as const,
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
        sha256: "889d2ec21163edf614cfdf69657dc4ae5f43b7f15ade55f8f3cfb91935cab10d" as const,
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
        role: "chance-sampling" as const,
        source: "src/simulation/search_chance_sampling.ts" as const,
        sha256: "76437941046cf686f4ad2cb389afd48672d8ed05c9e379c43edd1e1d7dd6370e" as const,
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
        sha256: "69d86f5c7c6a7514612e4c16df0d2d40b789c98ae0ced434c162c01905d00f6b" as const,
    }),
    Object.freeze({
        role: "default-search-factory" as const,
        source: "src/simulation/v0_8_a19_search.ts" as const,
        sha256: "558dd7252b0a94e3968a7a9d825b89edb3843258899bc9b976b1aca658306e89" as const,
    }),
    Object.freeze({
        role: "default-search-routing" as const,
        source: "src/simulation/battle_engine.ts" as const,
        // Offline formation collection is opt-in; omitted callers preserve default routing.
        sha256: "2378bb71912ecce3eb678c5a97037f943b9f8bfdf688e1c08e38c3e5e0bc8d38" as const,
    }),
    Object.freeze({
        role: "neural-policy" as const,
        source: "src/ai/versions/v0_8_a19_neural_policy.ts" as const,
        sha256: "69312ffe37e2970365ca412425dd2091966d31fc6b55e86d0bdb01c7c02852e0" as const,
    }),
    Object.freeze({
        role: "neural-adapter" as const,
        source: "src/simulation/a19_neural.ts" as const,
        sha256: "d37efcce4a123294b133c71de94bf85ebfcda9c44d0ab62a26d78982cfbae14d" as const,
    }),
    Object.freeze({
        role: "neural-model" as const,
        source: "src/simulation/a19_neural_model.ts" as const,
        sha256: "fa0f7ea4277099ebe4de6d51bffdcba886b3e2eca3853fd39b067904ca268f3b" as const,
    }),
    Object.freeze({
        role: "neural-correction" as const,
        source: "src/simulation/v0_9/a19_correction.ts" as const,
        sha256: "e0d0368c74b05470aa2490af56706be0a157d0bc998fd9e1e18b4cca54b625b2" as const,
    }),
    Object.freeze({
        role: "neural-observation" as const,
        source: "src/simulation/v0_9/a19_observation.ts" as const,
        sha256: "8dd195a919cac26cd6db4336711121b0828aebe88e080404876d0322c1b4f780" as const,
    }),
    Object.freeze({
        role: "neural-inference" as const,
        source: "src/simulation/v0_9/a19_inference.ts" as const,
        sha256: "58e622d890ca8f171979906ccb909902dff1da7609cbe132739d5ad31c33b383" as const,
    }),
    Object.freeze({
        role: "neural-batch256-weights" as const,
        source: "src/ai/models/a19/batch256.json" as const,
        sha256: "63c07debd0e08debe24482a8cd9d6046e09d0f7fd73292c65b80dbca7f4e1ef3" as const,
    }),
    Object.freeze({
        role: "neural-lr0003-weights" as const,
        source: "src/ai/models/a19/lr0003.json" as const,
        sha256: "c0be648360497095958f85af2068fcbf7d79176526feb270935770e6f0c30507" as const,
    }),
    Object.freeze({
        role: "final-placement-adapter" as const,
        source: "src/ai/placement/adapter.ts" as const,
        sha256: "5e34e7e857cc934d5d157292fbefe9b8a0ed584e8b501e2b3000bf691916df58" as const,
    }),
    Object.freeze({
        role: "final-placement-proposals" as const,
        source: "src/ai/placement/layout.ts" as const,
        sha256: "398cfda370abc28f4a3b395b7bebeea854cb1f1e010e943ea4b03a32fdf58a41" as const,
    }),
    Object.freeze({
        role: "final-placement-model" as const,
        source: "src/ai/placement/model.ts" as const,
        sha256: "ad146d7e7f9277c6c6e7bad24285c6fa423400720e78f1492d5f1ee64a6784f1" as const,
    }),
    Object.freeze({
        role: "final-placement-seed" as const,
        source: "src/ai/placement/sha256.ts" as const,
        sha256: "56dc48b19b3ff674e736335955ff2be55aac7fbf7bde6695da88826670db65c9" as const,
    }),
    Object.freeze({
        role: "final-placement-policy" as const,
        source: "src/ai/placement/policy.ts" as const,
        sha256: "0199fa1465ea34f41820ae72d7751153d7c419441e60d80b4783b7e642c5033d" as const,
    }),
    Object.freeze({
        role: "final-placement-weights" as const,
        source: "src/ai/models/a19/placement_v1.json" as const,
        sha256: "496842b113847a9ee902cc920daa23d3a2d8970c49353221f08ee34aedf26aa7" as const,
    }),
    Object.freeze({
        role: "final-placement-relations" as const,
        source: "src/ai/placement/relations.ts" as const,
        sha256: "a4cac3935c8b92d9ea4742c3e65e316729581a087b961cbe8922a0dd1ef8bce0" as const,
    }),
    Object.freeze({
        role: "final-placement-v2-weights" as const,
        source: "src/ai/models/a19/placement_v2.json" as const,
        sha256: "690f77e18625aab335ec4fdee3e686cd42a2a2bd677399c92fe300728431275b" as const,
    }),
    Object.freeze({
        role: "revealed-ranged-identity" as const,
        source: "src/ai/setup/a19_revealed_ranged_identity.ts" as const,
        sha256: "bae448ebd270582379646f019d94dec2aa136654de443a4bb60fdd8faf8803c3" as const,
    }),
    Object.freeze({
        role: "revealed-ranged-draft" as const,
        source: "src/ai/setup/a19_revealed_ranged_draft.ts" as const,
        sha256: "984c26414f9848cfe732c1347bcfedef68fe108fbe687e50d3c2ac41759781f7" as const,
    }),
    Object.freeze({
        role: "revealed-ranged-setup" as const,
        source: "src/ai/setup/a19_revealed_ranged_setup.ts" as const,
        sha256: "d4edea27356e342756850dc9e65466df68a916e20f907d7ead263ebb3a2b32df" as const,
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
    neuralPolicy: A19_NEURAL_POLICY,
    authoritativeFinalPlacement: A19_LEARNED_FINAL_PLACEMENT_POLICY,
    terrainPlacement: A19_TERRAIN_PLACEMENT_POLICY,
    authoritativeRevealedRangedDelivery: A19_REVEALED_RANGED_POLICY,
    authoritativeSniperDonorProtection: A19_SNIPER_DONOR_POLICY,
    wanderingMageSupport: A19_WANDERING_MAGE_SUPPORT_POLICY,
    unitSupport: A19_UNIT_SUPPORT_POLICY,
    battleMageTargets: BATTLE_MAGE_TARGET_POLICY,
    nightmareWallMovement: A19_NIGHTMARE_WALL_MOVEMENT_POLICY,
    neutralBarrelDeliberation: V08_A19_NEUTRAL_BARREL_DELIBERATION_POLICY,
    strikerRush: V08_A19_STRIKER_RUSH_POLICY,
    artifactBeneficiary: V08_A19_ARTIFACT_BENEFICIARY_POLICY,
    shooterlessMovement: V08_A19_SHOOTERLESS_MOVEMENT_POLICY,
    strikerMatchup: V08_A19_STRIKER_MATCHUP_POLICY,
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
        SEARCH_A19_MATERIAL_ARBITRATION: "ties",
        SEARCH_A19_CERTIFIED_SELECTION_BOUNDS: "1",
        SEARCH_A19_CERTIFIED_TIGHT_BOUNDS: "1",
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
