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

/**
 * The exact a13 genome selected by the 2026-07-21 v0.8 aggressive campaign.
 *
 * a13 was trained and validated under the `v0.8s` measurement alias. Production
 * v0.8 deliberately bakes the alias-only combat behavior before rebinding this
 * search profile to `v0.8`; the rebound is qualified independently on current
 * source and must not be confused with the frozen source binding below.
 */
export const V08_A13_PROFILE_SCHEMA = "hoc.v0_8_a13_production_profile.v1" as const;
export const V08_A13_CANDIDATE_ID = "a13" as const;
export const V08_A13_SOURCE_VERSION = "v0.8s" as const;
export const V08_A13_PRODUCTION_VERSION = "v0.8" as const;
export const V08_A13_OPPONENT_VERSION = "v0.7" as const;
export const V08_A13_SOURCE_COMMIT = "80059c9f34d918285eeb996589c9e3335efc240a" as const;
export const V08_A13_SOURCE_TREE = "b72339469be9b2b5a950e0844da31805d4da3a23" as const;
export const V08_A13_GENOME_SHA256 = "a46ac7ef0c18da1f3fb3b82a3fc1cd53e5565747d4d1673ac5340af5bf92ba49" as const;
export const V08_A13_SOURCE_BINDING_SHA256 =
    "e68485b177e98f4fb98228a6595e29b08c50726ef4882ee44ea53652a4613459" as const;
export const V08_A13_SOURCE_BEHAVIOR_ENVIRONMENT_SHA256 =
    "0f2489977d6c3a2dcefeebc82199e6e67ce16055ec6aa56451dd756b50b9ebbf" as const;

export const V08_A13_VALUE_LEAF = Object.freeze({
    b: 0.06534069459644987,
    w: Object.freeze([
        4.081035119926148, 2.888055625991499, 1.5730598211772326, -0.14364677977916157, -0.9336837765909962,
        0.9424346838241414, 0.17431508444555918, -0.007341719297552218, -0.09187297180358436, -1.693004732001635,
        -0.9302454303156342, 0.8326260014807879, -0.022885714019288697, -0.1735045054852376, -0.38810438466884667,
        0.3455894074090006, -0.1977868027929208, 0.19436133681826734, 0.08764765038160915, -0.0886442161600852,
        -0.022333755776636363, 0.05008653363915094, 0.09613198971949269, -0.12419696394202148, 0.24397787486642764,
        -0.39144163121731707, -0.004186954261656481, -0.05983012755704068, -0.09481213427654372, 0.0045777947992519715,
        0.891963773262178, -0.10327544784067408, 0.6939172983924118, -0.10199997336223199, -0.44672539998196686,
        0.4033776987507763, 0.013195634163514743, 0.003411488246245757, -0.08396831152209017, 0.11817034579981349,
        0.1832615097900565, -0.016642402929354507, -0.0023490845170962785, 0.17362261816678032, -0.020724298210454056,
        0.02157391740448175, 0.003484199080506326, 0.0007289902802438304, 0.019989821117927336, 0.0034341629267996467,
        -0.02847864807477138, -0.005357478254936718, 0.05599302453005189, -0.03991863932614784, 0.02013540637235298,
        -0.012549746705592852, 0.04492606068889813, -0.059452297864131504, -0.05135951065639726, 0.0677561550834195,
    ]),
});

export const V08_A13_SEARCH = Object.freeze({
    gate: 0.03,
    horizon: 12,
    rollouts: 2,
    includeMoves: true,
    maxMoves: 1,
    maxMelee: 6,
    maxShots: 4,
    maxThrows: 2,
    activeChallengers: true,
    shortlist: 3,
    decisionDeadlineMs: 175,
    circuitBreakerMs: 275,
    lateRangedFinishWeight: 0,
    pureRangedTerminalWeight: 0,
});

export const V08_A13_POLICY = Object.freeze({
    meleeRapidChargeWeight: 0,
    meleeRangedTargetWeight: 2,
    placementReveal: true,
    denseMeleeMagicIsolation: false,
    auraCasterMode: "off" as const,
    aggressive: true,
});

/** Canonical campaign genome; its fingerprint must equal V08_A13_GENOME_SHA256. */
export const V08_A13_GENOME = Object.freeze({
    search: Object.freeze({
        leafMode: "model" as const,
        leaf: V08_A13_VALUE_LEAF,
        gate: V08_A13_SEARCH.gate,
        horizon: V08_A13_SEARCH.horizon,
        rollouts: V08_A13_SEARCH.rollouts,
        includeMoves: V08_A13_SEARCH.includeMoves,
        maxMelee: V08_A13_SEARCH.maxMelee,
        maxShots: V08_A13_SEARCH.maxShots,
        maxThrows: V08_A13_SEARCH.maxThrows,
    }),
    controls: Object.freeze({
        activeChallengers: V08_A13_SEARCH.activeChallengers,
        shortlist: V08_A13_SEARCH.shortlist,
        decisionDeadlineMs: V08_A13_SEARCH.decisionDeadlineMs,
        lateRangedFinishWeight: V08_A13_SEARCH.lateRangedFinishWeight,
        pureRangedTerminalWeight: V08_A13_SEARCH.pureRangedTerminalWeight,
        meleeRangedTargetWeight: V08_A13_POLICY.meleeRangedTargetWeight,
        placementReveal: V08_A13_POLICY.placementReveal,
        denseMeleeMagicIsolation: V08_A13_POLICY.denseMeleeMagicIsolation,
        auraCasterMode: V08_A13_POLICY.auraCasterMode,
    }),
});

/**
 * Complete behavior environment consumed by SearchDriver. Strategy-time controls
 * (melee target weight, reveal placement, v0.8s finish/ranged behavior) are also
 * baked into StrategyV0_8 so they remain active after this construction scope ends.
 */
export function buildV08A13SearchEnvironment(
    version = V08_A13_PRODUCTION_VERSION,
): Readonly<Record<string, string | undefined>> {
    if (version !== V08_A13_PRODUCTION_VERSION && version !== V08_A13_SOURCE_VERSION) {
        throw new Error(`v0.8 a13 profile cannot target strategy ${version}`);
    }
    return Object.freeze({
        Q2_ORACLE: "0",
        Q2_WAIT_ABLATION: "0",
        SEARCH_ACTIVE_CHALLENGERS: "1",
        SEARCH_AUDIT: "0",
        SEARCH_AUDIT_TURNS: "0",
        SEARCH_CHALLENGER_KINDS: undefined,
        SEARCH_CIRCUIT_BREAKER_MS: String(V08_A13_SEARCH.circuitBreakerMs),
        SEARCH_DECISION_DEADLINE_MS: String(V08_A13_SEARCH.decisionDeadlineMs),
        SEARCH_GATE: String(V08_A13_SEARCH.gate),
        SEARCH_HORIZON: String(V08_A13_SEARCH.horizon),
        SEARCH_INCLUDE_MOVES: "1",
        SEARCH_INCUMBENT_KINDS: undefined,
        SEARCH_IL_DATASET: undefined,
        SEARCH_LATE_RANGED_FINISH_WEIGHT: "0",
        SEARCH_MAX_MELEE: String(V08_A13_SEARCH.maxMelee),
        // Production is sealed default-off. Research callers may spread this environment and override only
        // the cap; the paired scope below then keeps an otherwise identical seat as the control.
        SEARCH_MAX_MOVE_SHOTS: "0",
        SEARCH_MOVE_SHOT_VERSIONS: version,
        SEARCH_MAX_MOVES: String(V08_A13_SEARCH.maxMoves),
        SEARCH_MAX_SHOTS: String(V08_A13_SEARCH.maxShots),
        SEARCH_MAX_THROWS: String(V08_A13_SEARCH.maxThrows),
        SEARCH_OPP_MODEL: "",
        SEARCH_OBSERVE_ONLY: "0",
        SEARCH_PURE_RANGED_DEADLINE_FINISHER: "0",
        SEARCH_PURE_RANGED_DEADLINE_FINISHER_VERSIONS: version,
        SEARCH_PURE_RANGED_JIT_NO_MELEE_FOCUS: "0",
        SEARCH_PURE_RANGED_JIT_NO_MELEE_FOCUS_VERSIONS: version,
        SEARCH_PURE_RANGED_NO_MELEE_PRESSURE: "0",
        SEARCH_PURE_RANGED_NO_MELEE_PRESSURE_VERSIONS: version,
        SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS: "0",
        SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_DAMAGE_FLOOR: "1",
        SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_SCOPE: "pure_ranged",
        SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_VERSIONS: version,
        SEARCH_PURE_RANGED_TERMINAL_WEIGHT: "0",
        SEARCH_ROLLOUTS: String(V08_A13_SEARCH.rollouts),
        SEARCH_SHORTLIST: String(V08_A13_SEARCH.shortlist),
        SEARCH_VALIDATION_ROLLOUTS: undefined,
        SEARCH_VERSIONS: version,
        V06_MELEE_DIMS: `${V08_A13_POLICY.meleeRapidChargeWeight},${V08_A13_POLICY.meleeRangedTargetWeight}`,
        V06_MELEE_DIMS_VERSIONS: version,
        V07_AURA_CASTER_ROUTER: "off",
        V07_AURA_CASTER_ROUTER_VERSIONS: version,
        V07_AURA_CASTER_SPELLS: "",
        V07_DENSE_MM_SALVAGE_ISOLATION: "0",
        V07_DENSE_MM_SALVAGE_ISOLATION_VERSIONS: version,
        V07_PLACEMENT_REVEAL: "on",
        V07_PLACEMENT_REVEAL_VERSIONS: version,
        V07_SEARCH: "1",
        V07_VALUE_WEIGHTS: undefined,
        V07_VALUE_WEIGHTS_V2: JSON.stringify(V08_A13_VALUE_LEAF),
        V08_AGGRESSIVE: "1",
        // Research-only post-catalog vetoes for the shipped protected-advance catalog. Production remains
        // sealed default-off; the paired runner supplies all three gates together for its live-root arm.
        V08_PROTECTED_ADVANCE_GUARDRAILS: "0",
        V08_PROTECTED_ADVANCE_GUARDRAILS_LIVE_ONLY: "0",
        V08_PROTECTED_ADVANCE_GUARDRAILS_MODE: "both",
        V08_PROTECTED_ADVANCE_GUARDRAILS_VERSIONS: "",
        V08_SUPPORTED_BAND_ADVANCE: "0",
        V08_SUPPORTED_BAND_ADVANCE_FUNNEL_VERSIONS: "",
        V08_SUPPORTED_BAND_ADVANCE_LEGACY_CONTROL_VERSIONS: "",
        V08_SUPPORTED_BAND_ADVANCE_LIVE_ONLY: "0",
        V08_SUPPORTED_BAND_ADVANCE_VERSIONS: "",
        // Research-only strategy delta. Ordinary a13 construction records the global gate and selector as off;
        // paired runners may override both in their isolated child environment.
        V08_SUPPORTED_PREPIN_EGRESS: "0",
        V08_SUPPORTED_PREPIN_EGRESS_FUNNEL_VERSIONS: "",
        V08_SUPPORTED_PREPIN_EGRESS_LIVE_ONLY: "0",
        V08_SUPPORTED_PREPIN_EGRESS_VERSIONS: "",
    });
}

export const V08_A13_PROFILE = Object.freeze({
    schema: V08_A13_PROFILE_SCHEMA,
    candidateId: V08_A13_CANDIDATE_ID,
    sourceVersion: V08_A13_SOURCE_VERSION,
    productionVersion: V08_A13_PRODUCTION_VERSION,
    opponentVersion: V08_A13_OPPONENT_VERSION,
    sourceCommit: V08_A13_SOURCE_COMMIT,
    sourceTree: V08_A13_SOURCE_TREE,
    genomeSha256: V08_A13_GENOME_SHA256,
    sourceBindingSha256: V08_A13_SOURCE_BINDING_SHA256,
    sourceBehaviorEnvironmentSha256: V08_A13_SOURCE_BEHAVIOR_ENVIRONMENT_SHA256,
    genome: V08_A13_GENOME,
    valueLeaf: V08_A13_VALUE_LEAF,
    search: V08_A13_SEARCH,
    policy: V08_A13_POLICY,
});
