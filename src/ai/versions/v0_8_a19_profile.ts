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
import { A19_TIER2_STRIKER_POLICY } from "../setup/a19_tier2_striker_identity";
import {
    A19_STRIKER_RUSH_MIXED_POLICY,
    A19_STRIKER_RUSH_ONE_SHOOTER_POLICY,
    A19_STRIKER_RUSH_POLICY,
} from "../setup/a19_striker_rush_identity";
import { A19_WANDERING_MAGE_SUPPORT_POLICY } from "../wandering_mage_support";
import { A19_UNIT_SUPPORT_POLICY } from "../support_setup";
import { A19_NIGHTMARE_WALL_MOVEMENT_POLICY } from "../nightmare_wall_movement";
import { BATTLE_MAGE_TARGET_POLICY } from "../battle_mage_targets";

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
 *   - two-fit neural primary-tie correction adopted by explicit user instruction on 2026-11-01; REMOVED on
 *     2026-11-26 by owner decision ("yeah lets do it so it is all clean", and "Remove it" for its one live use, the
 *     browser sandbox). Bot seats (deep fit, stock 2,500 / 3,750 ms) and Premium never ran it; the sandbox and offline
 *     stock-driver play (the 1,000 / 1,500 ms budget, e.g. the a19-work meta profile) now take the native choice.
 *     Outputs recorded before the removal with that budget used the correction. A removal, not a strength claim.
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
 *   - striker rush against mixed armies (profile v18) adopted on 2026-11-20 under the same standing
 *     instruction. The rush also covers an army with exactly four strikers and at least two shooters; it used
 *     to stop at three enemy strikers, and such an army's shooters shot freely. +9.20 score points against
 *     mixed armies on the registered sealed bank (95% +6.81 to +11.68), +23.2 and +13.2 on the tasks where the
 *     setup changes. Its quality gate failed (four candidate games against one with a declined scripted melee
 *     proposal) and stays recorded as failed; a wider rule, any army with four strikers, failed its mirror
 *     guard and was not adopted (docs/striker_rush_mixed_adoption.md).
 *   - striker rush from one shooter (profile v19) adopted on 2026-11-20 under the same standing instruction.
 *     An army with exactly four strikers is rushed from one shooter instead of two; casters do not count.
 *     +4.64 score points on the registered sealed bank where the setup changes (95% +0.91 to +8.40); its
 *     quality gate failed (two candidate games against one with a declined scripted melee proposal) and stays
 *     recorded as failed (docs/striker_rush_one_shooter_adoption.md).
 *   - Tier-2 pick for a striker army (profile v20) adopted on 2026-11-21 under the same standing instruction.
 *     An army with fewer than two ranged stacks takes Crown of Command when it is offered and the opponent's
 *     melee probability is below 0.8; otherwise an established artifact outranks the five that artifact-fit-v8
 *     scores with a forecast. +7.06 score points on the 1,693 registered sealed tasks where the
 *     artifact changes (95% +4.39 to +9.76); mirror over all its tasks +0.42. Its quality gate failed (two
 *     candidate games against one with a declined scripted melee proposal) and stays recorded as failed
 *     (docs/tier2_striker_adoption.md).
 *   - Keep-attack fix (profile v21) adopted on 2026-11-21 at the owner's request: a melee unit no longer walks up to an
 *     enemy and ends its turn without attacking when an attack was available. Plain moves into contact fell from
 *     3,499 to 84 on the registered sealed bank; mirror +1.34 score points (95% -0.39 to +3.05), owner guard +2.15;
 *     registered as a non-inferiority check, so no strength gain is claimed (docs/keep_attack_adoption.md).
 *   - Rejection fixes (profile v22) adopted on 2026-11-21 at the owner's request: the native decision no longer
 *     moves and then proposes a strike from the old cell (ai/coherent_melee_approach.ts), and a move route must end
 *     where the engine's zone-of-control-aware paths reach (StrategyV0_1.isLegalMoveRoute); registered as a
 *     non-inferiority check (docs/rejection_fixes_adoption.md).
 *   - Deep search when it fits (profile v23) adopted on 2026-11-22 under the standing instruction, at the owner-approved
 *     think budget of about 4 s: a bot seat runs the deep A19 search (8 rollouts, shortlist 10, max melee 16) after the
 *     stock search when both fit 2,800 rollout turns (simulation/v0_8_a19_deep_fit.ts). Mirror +5.35 score points (95%
 *     +2.72 to +8.06), owner guard +3.67; its quality gate failed and stays recorded as failed
 *     (docs/deep_fit_adoption.md).
 *   - Wild Regeneration gift (profile v24) adopted on 2026-11-22 by the owner's explicit decision after its confirmation
 *     failed the owner-shaped guard (-2.34; registered gate W3, recorded as failed): the Troll's one-way gift goes only
 *     to an ally whose creatures have more max HP than the caster's (ai/wild_regeneration_gift.ts). Strength on fresh
 *     tasks +0.05 (95% -1.97 to +2.09); gifts to weaker creatures 526 -> 0 (docs/wild_regen_gift_adoption.md).
 *   - Decoy-aware targeting (profile v25) adopted on 2026-11-22 under the standing instruction: a melee unit never spends
 *     its strike on a one-model decoy while it can strike a real stack (ai/decoy_aware.ts). Against the owner's
 *     checkerboard decoy-fort layout +6.33 points (95% +2.59 to +10.05); every guard passed
 *     (docs/decoy_aware_adoption.md).
 *   - Gated counter draft (profile v26) adopted on 2026-11-22 under the standing instruction: once a seat sees two
 *     opposing creatures that read melee, it drafts with a matchup model of counters (ai/setup/a19_counter_draft.ts).
 *     Against the default AI +5.30 points (95% +1.19 to +9.35); every guard passed
 *     (docs/counter_draft_adoption.md).
 *   - Lava Striders by map (profile v27) adopted on 2026-11-22 under the standing instruction, after the owner saw it
 *     suggested on a map without lava: never taken there while a usable artifact is offered
 *     (ai/setup/a19_lava_map_artifact.ts). Without lava +0.48 points (95% +0.24 to +0.73); the
 *     owner-rush guard passed. The registered lava-map rule failed its strength gate (+0.09, -0.32 to
 *     +0.51) and is not adopted (docs/lava_map_artifact_adoption.md).
 *   - Valkyrie with the strikers (profile v28) adopted on 2026-11-23 under the standing instruction, after the owner saw a
 *     rushing AI leave its Valkyries at the back: the rush formation moves Valkyrie with the strikers
 *     (ai/setup/a19_valkyrie_striker.ts). On rush armies with a Valkyrie +7.36 points per task (95% +4.72
 *     to +10.02). Confirmation P, which also put flyers in the middle rows, failed (docs/valkyrie_striker_adoption.md).
 *   - Deep fit at 4,000 rollout turns (profile v29) adopted on 2026-11-23 under the standing instruction: the deep-fit
 *     budget fills the owner-approved 4 s (2,800 turns took at most about 2.7-3.3 s live); the 4,000 ms deadline is
 *     unchanged (simulation/v0_8_a19_deep_fit.ts). Registered confirmation U: +2.48 points per task (95% +1.67 to
 *     +3.28; 7,950 tasks), every population and map at least +0.98 (docs/deep_fit_4000_adoption.md).
 *   - Stock deadline 2,500 ms (profile v30) adopted on 2026-11-24 under the standing instruction, for the owner's question
 *     how much the bot can do in 4 s on the production host: the bot seat's stock search gets a 2,500 ms live deadline and
 *     a 3,750 ms breaker instead of 1,000 / 1,500 (simulation/v0_8_a19_deep_fit.ts; offline work is unchanged).
 *     Registered confirmation SD (real-time clash at production speed): 53.12% head to head against v29 (95% 51.56 to
 *     54.76; 720 tasks x both seats) (docs/stock_deadline_adoption.md).
 *   - Wait clock (profile v31) adopted on 2026-11-24 at the owner's request ("Keep v29, confirm cap"): the bot seat's stock
 *     and deep searches run WAIT comparisons under their deadline (SEARCH_WAIT_DEADLINE_POLICY profile instead of
 *     operation_bounded; simulation/v0_8_a19_deep_fit.ts; offline work is unchanged), so no move outruns the owner's 4 s.
 *     Registered non-inferiority confirmation WC (real-time clash at production speed): 49.05% head to head against v30
 *     (95% 47.89 to 50.19; 1,080 tasks x both seats); longest move 4.09 s, none over 4.5 s (docs/wait_clock_adoption.md).
 *   - Carrier cohesion (profile v32) adopted on 2026-11-24 at the owner's request ("AI needs to be more cautious", after
 *     losing its Crusader early): in laps 1-3 a principal blessing carrier that walks does not leave its army; the
 *     native move becomes a wait, else a defend, and such challengers are removed; flying carriers and striker-rush
 *     seats are exempt (ai/carrier_cohesion.ts). A non-inferiority check, registered confirmation CF on v30: +0.41
 *     points (95% -0.33 to +1.24); early isolating moves outside the rush 63 -> 2. The first version, which held flying
 *     carriers too, failed confirmation CC's forced-Manticore gate and is not adopted (docs/carrier_cohesion_adoption.md).
 *   - Queen counter (profile v33) adopted on 2026-11-24 at the owner's request ("They never pick tsar cannon, magic
 *     dragon, zena or anything to counterbalance me"): at a level-4 pick, once the opposing Arachna Queen is visible, the
 *     seat takes Magic Dragon when it is offered (ai/setup/a19_queen_counter.ts, applied last by the server's draft
 *     decider). Registered confirmation QV: +58.98 points (95% +49.61 to +68.36) on the owner's exact setups
 *     (docs/queen_counter_adoption.md).
 *   - Closing pick v2 (profile v34) adopted on 2026-11-24 under the standing instruction, for the owner's "catch and
 *     close picks": at the level-4 pick, while the counter draft's gate is shut but an opposing creature is visible, the
 *     matchup model's best offer (with a synergy bonus) replaces the earlier layers' choice when it is 0.05 better
 *     (ai/setup/a19_closing_pick.ts, applied by the server's draft decider before the Queen counter). Registered
 *     confirmation CPC: +5.99 points (95% +0.52 to +11.33) on the six human setups where it changes the pick; AI vs AI
 *     +7.23 per changed draft (95% +0.59 to +14.01) (docs/closing_pick_adoption.md).
 *   - Split screen (profile v35) adopted on 2026-11-25 at the owner's request ("premium for some reason always decides
 *     to split ranges instead of melee ... wolf is much better to split to cover, as it is 1x2 unit"; owner decision
 *     "AI seats + Premium, after a check"): the split plan reserves no shooter cover split, lets 1x2/2x1 stacks split,
 *     and spends every slot left after the aura/support/shield splits on one-model screen splits of the cheapest body
 *     (ai/split_screen.ts, ai/tactical_split_placement.ts; the server's split plan for AI seats and Premium "Arrange
 *     army"). A non-inferiority check, registered confirmation OA: +0.87 points (95% −0.15 to +1.88)
 *     (docs/owner_asks_adoption.md).
 *   - Shield screen (profile v36) adopted on 2026-11-25 by the owner's decision ("it is always better to split mermaid
 *     if we have it, because it takes two shots to kill her"; "Both now": AI seats and Premium): in screen mode a
 *     splittable Water Shield stack (Mermaid) is the screen body before any other, so every spare slot becomes a
 *     one-model Mermaid that takes two attacks to kill (ai/split_screen.ts, ai/tactical_split_placement.ts). A
 *     registered non-inferiority check follows (docs/shield_screen_adoption.md).
 *   - Counter model v2 (profile v37) adopted on 2026-11-26 under the owner's standing instruction ("Make sure we lock in
 *     wins"; goal: Scout and Spymaster use their view of the opponent's picks): the counter draft and the closing pick
 *     score with a19-counter-model-v2, v1's strengths and counters refit on November 25 AI-vs-AI games
 *     (ai/setup/draft_models/a19_counter_draft_v2.json; A19_COUNTER_MODEL=v1 restores v1). Screen MV1 +5.65 per changed
 *     Spymaster draft and +10.12 per changed Scout draft; registered confirmation MV3 on the fixed tree
 *     (docs/counter_model_v2_adoption.md).
 */
export const V08_A19_PROFILE_SCHEMA = "hoc.v0_8_a19_production_profile.v40" as const;
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
    SEARCH_A19_BARREL_ENGAGEMENT_ADVANCE: "1",
    // Explicit user adoption; preserve the positive estimate and failed qualification separately.
    SEARCH_A19_NIGHTMARE_WALL_MOVEMENT: "1",
    // Keep one broader single-target Gravechain attack for the horizon to price its movement denial.
    SEARCH_A19_GRAVECHAIN_COVERAGE: "1",
    // Give a wounded Last Fuse stack one supported counter-trade stand for real-engine comparison.
    SEARCH_A19_LAST_FUSE_TRADES: "1",
    SEARCH_A19_LAST_FUSE_PRIMARY_TRADES: "1",
    // Hydra's capped catalog prices the complete radial impact, shared shields and Devour recovery.
    SEARCH_A19_LIGHTNING_SPIN_COVERAGE: "1",
    SEARCH_A19_WANDERING_MAGE_SUPPORT: "1",
    SEARCH_A19_SATYR_CONTACT_SUPPORT: "1",
    // Owner-requested fix (profile v21, ai/keep_attack.ts): a melee unit's native attack is only replaced by another
    // attack, and while an attack is scored no plain move ends next to an enemy. Confirmed not to cost strength.
    SEARCH_A19_KEEP_MELEE_ATTACK: "1",
    SEARCH_A19_KEEP_CONTACT_ATTACK: "1",
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
// The sealed environment's fingerprint. 2026-11-26: SEARCH_A19_NEURAL_TIES left the environment with the A19 neural
// correction (owner decision); before that the fingerprint was 429c490e0b611975db37f33c7111c7553b2f8d72c108e03f56f70df01636fb2e.
export const V08_A19_BEHAVIOR_ENVIRONMENT_SHA256 =
    "9c9ff683e10eb1bedb57676b205072ffa45ba5da3b1db9c9b43140e81c7862bf" as const;

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

/** Owner adoption after staging match 48e40715. The 108-game development comparison was inconclusive. */
export const V08_A19_BARREL_ENGAGEMENT_ADVANCE_POLICY = Object.freeze({
    policyId: "a19-barrel-engagement-advance-v1",
    adoptedAt: "2026-11-27",
    adoption: "explicit-user-instruction",
    qualification: "replay-confirmed-development-inconclusive",
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
 * Striker rush against mixed armies (profile v18). The condition lives in ai/setup/a19_striker_rush.ts; this
 * record keeps the decision, its registration and the failed quality gate with the profile. See
 * docs/striker_rush_mixed_adoption.md.
 */
export const V08_A19_STRIKER_RUSH_MIXED_POLICY = Object.freeze({
    policyId: A19_STRIKER_RUSH_MIXED_POLICY,
    adoptedAt: "2026-11-20",
    adoption: "standing-user-instruction",
    registrationSha256: "ad387b7c4c3e815a1432b3f853b0895dfcd2b0a567e3a9a9c1ad9d9e579d715a",
    qualification: "strength-confirmed-quality-gate-failed",
} as const);

/**
 * Striker rush from one shooter (profile v19). The threshold lives in ai/setup/a19_striker_rush.ts; this record keeps
 * the decision and its registration with the profile. See docs/striker_rush_one_shooter_adoption.md.
 */
export const V08_A19_STRIKER_RUSH_ONE_SHOOTER_POLICY = Object.freeze({
    policyId: A19_STRIKER_RUSH_ONE_SHOOTER_POLICY,
    adoptedAt: "2026-11-20",
    adoption: "standing-user-instruction",
    registrationSha256: "8654e5a54721df0c4ccd74ecc6bbfd31c404203b36bd295c82669febaa241b62",
    qualification: "strength-confirmed-quality-gate-failed",
} as const);

/**
 * Tier-2 pick for a striker army (profile v20). The rule lives in ai/setup/a19_tier2_striker.ts and the server's
 * A19 setup policy; this record keeps the decision and its registration with the profile. See
 * docs/tier2_striker_adoption.md.
 */
export const V08_A19_TIER2_STRIKER_POLICY = Object.freeze({
    policyId: A19_TIER2_STRIKER_POLICY,
    adoptedAt: "2026-11-21",
    adoption: "standing-user-instruction",
    registrationSha256: "3e1c94aead03725988f8fc298aeb0e960eb873c1fbb04abc57c31f204112a3b4",
    qualification: "strength-confirmed-quality-gate-failed",
} as const);

/**
 * Keep-attack fix (profile v21). The rule lives in ai/keep_attack.ts and the search driver; this record keeps the
 * decision and its registration with the profile. See docs/keep_attack_adoption.md.
 */
export const V08_A19_KEEP_ATTACK_POLICY = Object.freeze({
    policyId: "a19-keep-attack-v1" as const,
    adoptedAt: "2026-11-21",
    adoption: "owner-request",
    registrationSha256: "01cec0b5e01e328838864415a1884e7ddf35abbe879ff74ed42c3ffca15e0999",
    qualification: "non-inferiority-confirmed",
} as const);

/**
 * Rejection fixes (profile v22). a19-coherent-melee-approach-v1 is the last step of StrategyV0_8.decideTurn and
 * a19-engine-reachable-routes-v1 lives in StrategyV0_1.isLegalMoveRoute; both are on unless a seat's switch
 * (A19_COHERENT_MELEE_APPROACH_<LEFT|RIGHT>, A19_ENGINE_REACHABLE_ROUTES_<LEFT|RIGHT>) is "0". This record keeps the
 * decision and its registration with the profile. See docs/rejection_fixes_adoption.md.
 */
export const V08_A19_REJECTION_FIXES_POLICY = Object.freeze({
    policyId: "a19-rejection-fixes-v1" as const,
    components: Object.freeze(["a19-coherent-melee-approach-v1", "a19-engine-reachable-routes-v1"] as const),
    adoptedAt: "2026-11-21",
    adoption: "owner-request",
    registrationSha256: "0613b1987e120e72cb874aae41fb01b781c3acbb46382d3fed41d960620bbea0",
    qualification: "non-inferiority-confirmed",
} as const);

/**
 * Deep search when it fits (profile v23). The driver is V08_A19_DEEP_FIT / createV08A19DeepFitSearchDriver in
 * simulation/v0_8_a19_deep_fit.ts (2,800 rollout turns, 4,000 ms live); the server gives it to bot seats only, and
 * Premium advice keeps the stock search. This record keeps the decision and its registration with the profile. See
 * docs/deep_fit_adoption.md.
 */
export const V08_A19_DEEP_FIT_POLICY = Object.freeze({
    policyId: "a19-deep-fit-v1" as const,
    adoptedAt: "2026-11-22",
    adoption: "standing-user-instruction",
    registrationSha256: "aa99e261a3d7ee4f33fbe95d3cc349aa0651e01a1c1539b8e59f4a7084122616",
    qualification: "strength-confirmed-quality-gate-failed",
} as const);

/**
 * Wild Regeneration gift (profile v24): ai/wild_regeneration_gift.ts, used by the candidate generator and the v0.8 native
 * gift. Adopted by the owner's explicit decision; its registered owner guard (W3) failed and stays recorded as failed.
 * See docs/wild_regen_gift_adoption.md.
 */
export const V08_A19_WILD_REGEN_GIFT_POLICY = Object.freeze({
    policyId: "a19-wild-regen-gift-v1" as const,
    adoptedAt: "2026-11-22",
    adoption: "owner-explicit-decision",
    registrationSha256: "15861f7f825265f6b376b134bc1ea71f7944d364ab7fc65a2e49bd116823f712",
    qualification: "behaviour-confirmed-owner-guard-failed",
} as const);

/**
 * Decoy-aware targeting (profile v25): ai/decoy_aware.ts, used by the candidate generator and the server's root
 * redirect. See docs/decoy_aware_adoption.md.
 */
export const V08_A19_DECOY_AWARE_POLICY = Object.freeze({
    policyId: "a19-decoy-aware-v1" as const,
    adoptedAt: "2026-11-22",
    adoption: "standing-user-instruction",
    registrationSha256: "9e2d00ea2bfdd5b610d2f2cf54f661b58c2aa541c929d42bc6850e3f62f1f146",
    qualification: "strength-confirmed",
} as const);

/**
 * Stock deadline 2,500 ms (profile v30): V08_A19_DEEP_FIT.stockBudget in simulation/v0_8_a19_deep_fit.ts, the bot seat's
 * stock search under live timing. See docs/stock_deadline_adoption.md.
 */
export const V08_A19_STOCK_DEADLINE_POLICY = Object.freeze({
    policyId: "a19-stock-deadline-v1" as const,
    adoptedAt: "2026-11-24",
    adoption: "standing-user-instruction",
    registrationSha256: "0861b6ac1fa9f09ad5831b15ddcdf3103a9bb79f328fa7a8128a42ab8c20eef1",
    qualification: "strength-confirmed",
} as const);

/**
 * Wait clock (profile v31): V08_A19_DEEP_FIT.waitBudget in simulation/v0_8_a19_deep_fit.ts, the bot seat's stock and deep
 * searches under live timing. See docs/wait_clock_adoption.md.
 */
export const V08_A19_WAIT_CLOCK_POLICY = Object.freeze({
    policyId: "a19-wait-clock-v1" as const,
    adoptedAt: "2026-11-24",
    adoption: "owner-request",
    registrationSha256: "2820fe568be7bda58822bca3ab62bb14233dd84d648a93b68e81a96feb98ec0e",
    qualification: "non-inferiority-confirmed",
} as const);

/**
 * Carrier cohesion (profile v32). The rule lives in ai/carrier_cohesion.ts and the search driver; this record keeps the
 * decision and its registration with the profile. See docs/carrier_cohesion_adoption.md.
 */
export const V08_A19_CARRIER_COHESION_POLICY = Object.freeze({
    policyId: "a19-carrier-cohesion-v2" as const,
    adoptedAt: "2026-11-24",
    adoption: "owner-request",
    registrationSha256: "1f2adb866f41bf506f147df36d08f23e909d6990b8f31c0a722c9f5c19124b2a",
    qualification: "non-inferiority-confirmed",
} as const);

/**
 * Queen counter (profile v33): ai/setup/a19_queen_counter.ts, called last by the server's draft decider. See
 * docs/queen_counter_adoption.md.
 */
export const V08_A19_QUEEN_COUNTER_POLICY = Object.freeze({
    policyId: "a19-queen-counter-v1" as const,
    adoptedAt: "2026-11-24",
    adoption: "owner-request",
    registrationSha256: "e208b2f6a36d20fa2c86aa310d451a96d6b55a34b77e3b8163a54e23169efc12",
    qualification: "strength-confirmed",
} as const);

/**
 * Closing pick v2 (profile v34): ai/setup/a19_closing_pick.ts, called by the server's draft decider before the Queen
 * counter. See docs/closing_pick_adoption.md.
 */
export const V08_A19_CLOSING_PICK_POLICY = Object.freeze({
    policyId: "a19-closing-pick-synergy-v1" as const,
    adoptedAt: "2026-11-24",
    adoption: "standing-instruction",
    registrationSha256: "c994f2e56535f430cfd8fc1cdac01029e47e4f423c09ec9c3ba6aa505a00b38e",
    qualification: "strength-confirmed",
} as const);

/**
 * Split screen (profile v35): ai/split_screen.ts switches ai/tactical_split_placement.ts's screen mode for the
 * server's split plan (AI seats and Premium "Arrange army") and the client's Premium projection. See
 * docs/owner_asks_adoption.md.
 */
export const V08_A19_SPLIT_SCREEN_POLICY = Object.freeze({
    policyId: "a19-split-screen-v1" as const,
    adoptedAt: "2026-11-25",
    adoption: "owner-request",
    registrationSha256: "01fdd229c2e6ac7a8d4ea3d99f0dd13c20e60991dc8c71401fa63f24e86b89e4",
    qualification: "non-inferiority-confirmed",
} as const);

/**
 * Shield screen (profile v36): ai/split_screen.ts switches the Water Shield screen body of ai/tactical_split_placement.ts
 * for the server's split plan (AI seats and Premium "Arrange army") and the client's Premium projection. Adopted by the
 * owner's decision before its check; the registration is the frozen decision record. Its registered non-inferiority
 * check SH1 passed on November 26, 2026 (not a strength gain). See docs/shield_screen_adoption.md.
 */
export const V08_A19_SHIELD_SCREEN_POLICY = Object.freeze({
    policyId: "a19-shield-screen-v1" as const,
    adoptedAt: "2026-11-25",
    adoption: "owner-explicit-decision",
    registrationSha256: "e50024247b049178de58d092acca14ac93433c405e843647b7b6b20799bf3ddc",
    qualification: "non-inferiority-confirmed",
} as const);

/**
 * Close screen (profile v39): ai/split_screen.ts switches the close-range screen body of ai/tactical_split_placement.ts
 * (an army with no shooter facing a public shooter screens with its fastest cheap body) for the server's split plan (AI
 * seats and Premium "Arrange army") and the client's Premium projection. Adopted by the owner's decision ("Adopt now,
 * check after"). The decision record is frozen. The registered check CS1 confirmed non-inferiority on November 27.
 * See docs/close_screen_adoption.md.
 */
export const V08_A19_CLOSE_SCREEN_POLICY = Object.freeze({
    policyId: "a19-close-screen-v1" as const,
    adoptedAt: "2026-11-26",
    adoption: "owner-explicit-decision",
    registrationSha256: "e170fb92d6dae94b86de5df152dc35a58085a2ccf40ed4806286d856ace875a6",
    qualification: "non-inferiority-confirmed",
} as const);

/**
 * Counter model v2 (profile v37): ai/setup/a19_counter_draft.ts scores with draft_models/a19_counter_draft_v2.json, the
 * counter draft's and the closing pick's model refit on November 25 games; A19_COUNTER_MODEL=v1 restores v1. The
 * registration is confirmation MV3's decision rule. See docs/counter_model_v2_adoption.md.
 */
export const V08_A19_COUNTER_MODEL_POLICY = Object.freeze({
    policyId: "a19-counter-model-v2" as const,
    adoptedAt: "2026-11-26",
    adoption: "standing-user-instruction",
    registrationSha256: "e62c89868e8b201c2417282a8178fe7703e3cd46e9f3f4d98196085330ed7235",
    qualification: "strength-confirmed",
} as const);

/**
 * Deep fit at 4,000 rollout turns (profile v29): V08_A19_DEEP_FIT.rolloutTurnBudget in simulation/v0_8_a19_deep_fit.ts,
 * the same a19-deep-fit-v1 driver and deadline. See docs/deep_fit_4000_adoption.md.
 */
export const V08_A19_DEEP_FIT_4000_POLICY = Object.freeze({
    policyId: "a19-deep-fit-4000-v1" as const,
    adoptedAt: "2026-11-23",
    adoption: "standing-user-instruction",
    registrationSha256: "6f7431f0fb0d533eb3c9604e331bdc891b338ff32655b2f8a03c9007a2568729",
    qualification: "strength-confirmed",
} as const);

/**
 * Valkyrie with the strikers (profile v28): ai/setup/a19_valkyrie_striker.ts, called by the server's strikerRushFormation.
 * See docs/valkyrie_striker_adoption.md.
 */
export const V08_A19_VALKYRIE_STRIKER_POLICY = Object.freeze({
    policyId: "a19-valkyrie-striker-v1" as const,
    adoptedAt: "2026-11-23",
    adoption: "standing-user-instruction",
    registrationSha256: "cb9274594d957678298c35f0569777cbb89a446068ade351e1efe4cdc98f3536",
    qualification: "strength-confirmed",
} as const);

/**
 * Lava Striders by map (profile v27): ai/setup/a19_lava_map_artifact.ts, called by the server's Tier-2 pick around the
 * striker rule. See docs/lava_map_artifact_adoption.md.
 */
export const V08_A19_LAVA_MAP_ARTIFACT_POLICY = Object.freeze({
    policyId: "a19-lava-map-artifact-v1" as const,
    adoptedAt: "2026-11-22",
    adoption: "standing-user-instruction",
    registrationSha256: "09fdcef677947b48b52c0baee2d6beb296aa9add6dad05c55d92a587d80a364f",
    qualification: "strength-confirmed",
} as const);

/**
 * Gated counter draft (profile v26): ai/setup/a19_counter_draft.ts with its model draft_models/a19_counter_draft_v1.json,
 * called by the server's draft decider after the striker matchup head. See docs/counter_draft_adoption.md.
 */
export const V08_A19_COUNTER_DRAFT_POLICY = Object.freeze({
    policyId: "a19-counter-draft-v1" as const,
    adoptedAt: "2026-11-22",
    adoption: "standing-user-instruction",
    registrationSha256: "7d5b23d507419eac1246f70e81916103c02ad577e0d04eb675db91e46e73bebb",
    qualification: "strength-confirmed",
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
        sha256: "fff690b3ae132e13ea1c9f5b22a7f9aeacdbf417a5891be531c6bad965323111" as const,
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
        // Ends with the coherent melee approach of profile v22.
        sha256: "07b86b77f43fce6e2ff7c766d73c4cc7afd56ccb138d9b3d05acf6dcac975163" as const,
    }),
    Object.freeze({
        role: "search-driver" as const,
        source: "src/simulation/search_driver.ts" as const,
        // Carries the neutral cemetery barrel deliberation switch that profile v14 turns on, the keep-attack
        // switches of profile v21 and the carrier cohesion rule of profile v32. Re-pinned for the native rollout
        // seam (HOC_NATIVE_ROLLOUTS) and its default with hook detection: the TypeScript loop is unchanged, a native
        // bank leaves the driver as it does, and bot seats pass no native harness (docs/native_rollouts.md).
        // Re-pinned for 950aac89: both bank paths report each candidate's finite rollouts to the A19 neural
        // correction (lastBankFiniteRollouts) in place of its rollout patch; decision traces identical 0 / 1 / shadow.
        // Re-pinned 2026-11-26: v0.9 and the A19 neural correction removed by owner decision ("yeah lets do it so it
        // is all clean"; "Remove it" for the sandbox correction). Bot seats and Premium decisions are unchanged.
        // Re-pinned: a driver without a native harness (a live bot seat) never asks for the library; only the order of
        // the bank's fallback checks changes.
        // Profile v40 adds the advance toward the main fight to neutral-barrel deliberation.
        sha256: "11127d8f031dff926365ea4ca353d4dfc2317726704da6a39d2cb8bfdecd4585" as const,
    }),
    Object.freeze({
        role: "unit-support-setup" as const,
        source: "src/ai/support_setup.ts" as const,
        sha256: "c072fd7e5165863573d2e807401477593039fba85a9b6c00b8ae76f18f06e1a0" as const,
    }),
    Object.freeze({
        role: "healer-support-setup" as const,
        source: "src/ai/healer_support_setup.ts" as const,
        sha256: "e4abe8065a750f832b4a944f70c2a62770983a889418a06b262c63943add38cf" as const,
    }),
    Object.freeze({
        role: "wandering-mage-support" as const,
        source: "src/ai/wandering_mage_support.ts" as const,
        sha256: "4c6d87f98498388ff7f41fc3a29ce9f0825dea28c62450987c5052d32de98c97" as const,
    }),
    Object.freeze({
        role: "satyr-contact-support" as const,
        source: "src/ai/satyr_contact_support.ts" as const,
        sha256: "d03da01acec056a1f88292ede6f762c1932e733c7b52392d298ee74d181d1a0a" as const,
    }),
    Object.freeze({
        role: "unit-support-adapter" as const,
        source: "src/simulation/a19_support.ts" as const,
        sha256: "ac15f16a2b5810e269867595201b6c5dd90b364fd680fd61f5b0806bc44856a8" as const,
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
        // Neutral-barrel deliberation can use the capped move slot for an advance toward the main fight.
        sha256: "32f0da36cf109da6167820cbb90b12f10b6d42698386ffbbd60b98f50cfa4e8f" as const,
    }),
    Object.freeze({
        role: "ranged-target-selection" as const,
        source: "src/ai/versions/v0_2.ts" as const,
        sha256: "7a1cfcecc02a803d2a5d7c4dd0dd41a76b98894b1be62d9fdf88644150849a4d" as const,
    }),
    Object.freeze({
        role: "ranged-action-validation" as const,
        source: "src/ai/versions/v0_4.ts" as const,
        sha256: "171ef6adfa1c4efb14b89caed09c0e3701829fe3ed957be9d618906003116a8f" as const,
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
        // Re-pinned 2026-11-26: v0.9 and the A19 neural correction removed by owner decision ("yeah lets do it so it
        // is all clean"; "Remove it" for the sandbox correction). Bot seats and Premium decisions are unchanged.
        sha256: "8ec0e30ad352b16c5cc3de0ccac0fbbd3601bce235ac101254d3340591ddbcef" as const,
    }),
    Object.freeze({
        role: "default-search-factory" as const,
        source: "src/simulation/v0_8_a19_search.ts" as const,
        // Re-pinned 2026-11-26: v0.9 and the A19 neural correction removed by owner decision ("yeah lets do it so it
        // is all clean"; "Remove it" for the sandbox correction). Bot seats and Premium decisions are unchanged.
        sha256: "fbf2bb5c300af51859c47d0f8d8a838eca3de2217b2c4016ee1f8fa366c95690" as const,
    }),
    Object.freeze({
        role: "default-search-routing" as const,
        source: "src/simulation/battle_engine.ts" as const,
        // Offline formation collection is opt-in; omitted callers preserve default routing. Re-pinned for the
        // native rollout harness facts and the opt-in searched-seat driver hook (docs/native_rollouts.md).
        // Re-pinned 2026-11-26: v0.9 and the A19 neural correction removed by owner decision ("yeah lets do it so it
        // is all clean"; "Remove it" for the sandbox correction). Bot seats and Premium decisions are unchanged.
        sha256: "851f018e9129614b71c550f58d9bf783580f6dc51a33b396cb254871567b617c" as const,
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
    Object.freeze({
        role: "keep-attack" as const,
        source: "src/ai/keep_attack.ts" as const,
        sha256: "0085acaca83845a838b56270a95db8996e0626bad06818ad4000acb0b2754dc9" as const,
    }),
    Object.freeze({
        role: "coherent-melee-approach" as const,
        source: "src/ai/coherent_melee_approach.ts" as const,
        sha256: "35fe4148388f7ec0aad4b95d67b000e5d2139a77cb4e150e9eec6fd7742b946b" as const,
    }),
    Object.freeze({
        role: "engine-reachable-routes" as const,
        source: "src/ai/versions/v0_1.ts" as const,
        sha256: "0fd06f0f134a237454b6b659ee486da74cd79b870e72f9cb92f11eb90168988f" as const,
    }),
    Object.freeze({
        role: "deep-fit" as const,
        source: "src/simulation/v0_8_a19_deep_fit.ts" as const,
        // Re-pinned 2026-11-26: v0.9 and the A19 neural correction removed by owner decision ("yeah lets do it so it
        // is all clean"; "Remove it" for the sandbox correction). Bot seats and Premium decisions are unchanged.
        sha256: "c97f364c99e346ffddb2ec0365b69db044a283b9275e9d3abd575bfec2c33fff" as const,
    }),
    Object.freeze({
        role: "wild-regen-gift" as const,
        source: "src/ai/wild_regeneration_gift.ts" as const,
        sha256: "1947b0ecbdc25c3a7f5284f58910193f7e37cf5a376188aaaddc75d1c53fcb20" as const,
    }),
    Object.freeze({
        role: "decoy-aware" as const,
        source: "src/ai/decoy_aware.ts" as const,
        sha256: "2e75080ab2751be7b64bf0cf77a2a7129c88cbe539ff91980a5f5b0abd50ac43" as const,
    }),
    Object.freeze({
        role: "decoy-aware-redirect" as const,
        source: "src/ai/decoy_aware_redirect.ts" as const,
        sha256: "4065952f69c77117db4b81a1790f2453df42894e146978359558907f1b56f98b" as const,
    }),
    Object.freeze({
        role: "counter-draft" as const,
        source: "src/ai/setup/a19_counter_draft.ts" as const,
        // Profile v37 selects counter model v2 by default (A19_COUNTER_MODEL=v1 restores v1).
        sha256: "6d26aa83b40406b69a6ca6294e1554c3717ae60358f20fc4f74a78e8a11556a0" as const,
    }),
    Object.freeze({
        role: "counter-draft-model" as const,
        source: "src/ai/setup/draft_models/a19_counter_draft_v1.json" as const,
        sha256: "444c5cf85a25f3ef5231c99424f2c77ef1486e56b982f22f0eda7a059044734d" as const,
    }),
    Object.freeze({
        role: "counter-draft-model-v2" as const,
        source: "src/ai/setup/draft_models/a19_counter_draft_v2.json" as const,
        sha256: "251c34930f17c58cafdaeb3fd0c9daae34fccff0cadf57667655cffa7e499040" as const,
    }),
    Object.freeze({
        role: "lava-map-artifact" as const,
        source: "src/ai/setup/a19_lava_map_artifact.ts" as const,
        sha256: "0ee31d0335359ab12ac6a712ec3b4808674343971ae1fc8fc70c0a1f839714c5" as const,
    }),
    Object.freeze({
        role: "valkyrie-striker" as const,
        source: "src/ai/setup/a19_valkyrie_striker.ts" as const,
        sha256: "7335b5e1055d56d996d9b08cf25f8302fbbebea826de3b0ed5f836edba0a2640" as const,
    }),
    Object.freeze({
        role: "carrier-cohesion" as const,
        source: "src/ai/carrier_cohesion.ts" as const,
        sha256: "e7103949bd6386290a4b3f78917e0f2fcf0d925995e345ebb688917118c262ee" as const,
    }),
    Object.freeze({
        role: "queen-counter" as const,
        source: "src/ai/setup/a19_queen_counter.ts" as const,
        sha256: "7ae513b9cba9d816db555b6346d63e89ed2d5cd6d0c740db3c47d9fc220eccef" as const,
    }),
    Object.freeze({
        role: "closing-pick" as const,
        source: "src/ai/setup/a19_closing_pick.ts" as const,
        sha256: "4020b15a274a461f6230badf0f907b7758e6a7eaee1f94134c1bc645d8f3a1e4" as const,
    }),
    Object.freeze({
        role: "split-screen" as const,
        source: "src/ai/split_screen.ts" as const,
        // Profile v36 adds the shield screen switch, profile v39 the close screen switch.
        sha256: "ecffc6e5252f415691133fac8e4df680d72d9527658920e901a98a86c313d8fa" as const,
    }),
    Object.freeze({
        role: "tactical-split-placement" as const,
        source: "src/ai/tactical_split_placement.ts" as const,
        // The split planner; profile v35 adds its screen mode, profile v36 the Water Shield screen body, profile v39 the
        // close-range screen body.
        sha256: "ded8b068d1148167a9833fc70a44eaf5b082fa8986e0d611468e3efe6a2f8240" as const,
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
    authoritativeFinalPlacement: A19_LEARNED_FINAL_PLACEMENT_POLICY,
    terrainPlacement: A19_TERRAIN_PLACEMENT_POLICY,
    authoritativeRevealedRangedDelivery: A19_REVEALED_RANGED_POLICY,
    authoritativeSniperDonorProtection: A19_SNIPER_DONOR_POLICY,
    wanderingMageSupport: A19_WANDERING_MAGE_SUPPORT_POLICY,
    unitSupport: A19_UNIT_SUPPORT_POLICY,
    battleMageTargets: BATTLE_MAGE_TARGET_POLICY,
    nightmareWallMovement: A19_NIGHTMARE_WALL_MOVEMENT_POLICY,
    neutralBarrelDeliberation: V08_A19_NEUTRAL_BARREL_DELIBERATION_POLICY,
    barrelEngagementAdvance: V08_A19_BARREL_ENGAGEMENT_ADVANCE_POLICY,
    strikerRush: V08_A19_STRIKER_RUSH_POLICY,
    artifactBeneficiary: V08_A19_ARTIFACT_BENEFICIARY_POLICY,
    shooterlessMovement: V08_A19_SHOOTERLESS_MOVEMENT_POLICY,
    strikerMatchup: V08_A19_STRIKER_MATCHUP_POLICY,
    strikerRushMixed: V08_A19_STRIKER_RUSH_MIXED_POLICY,
    strikerRushOneShooter: V08_A19_STRIKER_RUSH_ONE_SHOOTER_POLICY,
    tier2Striker: V08_A19_TIER2_STRIKER_POLICY,
    keepAttack: V08_A19_KEEP_ATTACK_POLICY,
    rejectionFixes: V08_A19_REJECTION_FIXES_POLICY,
    deepFit: V08_A19_DEEP_FIT_POLICY,
    wildRegenGift: V08_A19_WILD_REGEN_GIFT_POLICY,
    decoyAware: V08_A19_DECOY_AWARE_POLICY,
    counterDraft: V08_A19_COUNTER_DRAFT_POLICY,
    lavaMapArtifact: V08_A19_LAVA_MAP_ARTIFACT_POLICY,
    valkyrieStriker: V08_A19_VALKYRIE_STRIKER_POLICY,
    deepFit4000: V08_A19_DEEP_FIT_4000_POLICY,
    stockDeadline: V08_A19_STOCK_DEADLINE_POLICY,
    waitClock: V08_A19_WAIT_CLOCK_POLICY,
    carrierCohesion: V08_A19_CARRIER_COHESION_POLICY,
    queenCounter: V08_A19_QUEEN_COUNTER_POLICY,
    closingPick: V08_A19_CLOSING_PICK_POLICY,
    splitScreen: V08_A19_SPLIT_SCREEN_POLICY,
    shieldScreen: V08_A19_SHIELD_SCREEN_POLICY,
    counterModel: V08_A19_COUNTER_MODEL_POLICY,
    closeScreen: V08_A19_CLOSE_SCREEN_POLICY,
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
