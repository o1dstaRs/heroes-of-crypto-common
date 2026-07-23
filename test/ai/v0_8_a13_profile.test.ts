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

import { afterEach, describe, expect, it } from "bun:test";

import {
    buildV08A13SearchEnvironment,
    V08_A13_GENOME,
    V08_A13_GENOME_SHA256,
    V08_A13_POLICY,
    V08_A13_SEARCH,
    V08_A13_SOURCE_VERSION,
    V08_A13_VALUE_LEAF,
} from "../../src/ai/versions/v0_8_a13_profile";
import type { ILookaheadDeps } from "../../src/simulation/lookahead";
import { fingerprintV08AlignedV1CandidateGenome } from "../../src/simulation/optimizer/v0_8_aligned_96h_v1_protocol";
import {
    createV08A13SearchDriver,
    shouldUseDefaultV08A13Search,
    V08_A13_SEARCH_OVERRIDE_ENV,
} from "../../src/simulation/v0_8_a13_search";

const ENV_KEYS = [
    V08_A13_SEARCH_OVERRIDE_ENV,
    "V07_SEARCH",
    "Q2_WAIT_ABLATION",
    "Q2_ORACLE",
    "SEARCH_VERSIONS",
    "SEARCH_GATE",
    "SEARCH_HORIZON",
    "SEARCH_ROLLOUTS",
    "SEARCH_INCLUDE_MOVES",
    "SEARCH_ACTIVE_CHALLENGERS",
    "SEARCH_MAX_MOVE_SHOTS",
    "SEARCH_MOVE_SHOT_VERSIONS",
    "SEARCH_SHORTLIST",
    "SEARCH_DECISION_DEADLINE_MS",
    "SEARCH_CIRCUIT_BREAKER_MS",
    "SEARCH_PURE_RANGED_NO_MELEE_PRESSURE",
    "SEARCH_PURE_RANGED_NO_MELEE_PRESSURE_VERSIONS",
    "SEARCH_PURE_RANGED_DEADLINE_FINISHER",
    "SEARCH_PURE_RANGED_DEADLINE_FINISHER_VERSIONS",
    "SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS",
    "SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_VERSIONS",
    "SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_DAMAGE_FLOOR",
    "SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_SCOPE",
    "SEARCH_PURE_RANGED_JIT_NO_MELEE_FOCUS",
    "SEARCH_PURE_RANGED_JIT_NO_MELEE_FOCUS_VERSIONS",
    "V08_PROTECTED_ADVANCE_GUARDRAILS",
    "V08_PROTECTED_ADVANCE_GUARDRAILS_LIVE_ONLY",
    "V08_PROTECTED_ADVANCE_GUARDRAILS_MODE",
    "V08_PROTECTED_ADVANCE_GUARDRAILS_VERSIONS",
    "V08_SUPPORTED_BAND_ADVANCE",
    "V08_SUPPORTED_BAND_ADVANCE_FUNNEL_VERSIONS",
    "V08_SUPPORTED_BAND_ADVANCE_LEGACY_CONTROL_VERSIONS",
    "V08_SUPPORTED_BAND_ADVANCE_LIVE_ONLY",
    "V08_SUPPORTED_BAND_ADVANCE_VERSIONS",
    "V08_SUPPORTED_PREPIN_EGRESS",
    "V08_SUPPORTED_PREPIN_EGRESS_FUNNEL_VERSIONS",
    "V08_SUPPORTED_PREPIN_EGRESS_LIVE_ONLY",
    "V08_SUPPORTED_PREPIN_EGRESS_VERSIONS",
    "V07_VALUE_WEIGHTS",
    "V07_VALUE_WEIGHTS_V2",
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
    for (const key of ENV_KEYS) {
        const value = saved[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

describe("v0.8 a13 production profile", () => {
    it("pins the exact selected campaign genome", () => {
        expect(V08_A13_VALUE_LEAF.w).toHaveLength(60);
        expect(fingerprintV08AlignedV1CandidateGenome(V08_A13_GENOME)).toBe(V08_A13_GENOME_SHA256);
        expect(V08_A13_SEARCH).toMatchObject({
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
        });
        expect(V08_A13_POLICY).toMatchObject({
            meleeRapidChargeWeight: 0,
            meleeRangedTargetWeight: 2,
            placementReveal: true,
            denseMeleeMagicIsolation: false,
            auraCasterMode: "off",
            aggressive: true,
        });
    });

    it("materializes the full production and source-alias search scopes", () => {
        const production = buildV08A13SearchEnvironment();
        const source = buildV08A13SearchEnvironment(V08_A13_SOURCE_VERSION);
        expect(production).toMatchObject({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8",
            SEARCH_GATE: "0.03",
            SEARCH_HORIZON: "12",
            SEARCH_ROLLOUTS: "2",
            SEARCH_INCLUDE_MOVES: "1",
            SEARCH_MAX_MOVE_SHOTS: "0",
            SEARCH_MOVE_SHOT_VERSIONS: "v0.8",
            SEARCH_MAX_MOVES: "1",
            SEARCH_MAX_MELEE: "6",
            SEARCH_MAX_SHOTS: "4",
            SEARCH_MAX_THROWS: "2",
            SEARCH_ACTIVE_CHALLENGERS: "1",
            SEARCH_SHORTLIST: "3",
            SEARCH_DECISION_DEADLINE_MS: "175",
            SEARCH_CIRCUIT_BREAKER_MS: "275",
            SEARCH_PURE_RANGED_NO_MELEE_PRESSURE: "0",
            SEARCH_PURE_RANGED_DEADLINE_FINISHER: "0",
            SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS: "0",
            SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_DAMAGE_FLOOR: "1",
            SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_SCOPE: "pure_ranged",
            SEARCH_PURE_RANGED_JIT_NO_MELEE_FOCUS: "0",
            V08_PROTECTED_ADVANCE_GUARDRAILS: "0",
            V08_PROTECTED_ADVANCE_GUARDRAILS_LIVE_ONLY: "0",
            V08_PROTECTED_ADVANCE_GUARDRAILS_MODE: "both",
            V08_PROTECTED_ADVANCE_GUARDRAILS_VERSIONS: "",
            V08_SUPPORTED_BAND_ADVANCE: "0",
            V08_SUPPORTED_BAND_ADVANCE_FUNNEL_VERSIONS: "",
            V08_SUPPORTED_BAND_ADVANCE_LEGACY_CONTROL_VERSIONS: "",
            V08_SUPPORTED_BAND_ADVANCE_LIVE_ONLY: "0",
            V08_SUPPORTED_BAND_ADVANCE_VERSIONS: "",
            V08_SUPPORTED_PREPIN_EGRESS: "0",
            V08_SUPPORTED_PREPIN_EGRESS_FUNNEL_VERSIONS: "",
            V08_SUPPORTED_PREPIN_EGRESS_LIVE_ONLY: "0",
            V08_SUPPORTED_PREPIN_EGRESS_VERSIONS: "",
            V06_MELEE_DIMS: "0,2",
            V07_PLACEMENT_REVEAL: "on",
            V08_AGGRESSIVE: "1",
        });
        expect(JSON.parse(production.V07_VALUE_WEIGHTS_V2!)).toEqual(V08_A13_VALUE_LEAF);
        expect(source.SEARCH_VERSIONS).toBe("v0.8s");
        expect(source.SEARCH_MAX_MOVE_SHOTS).toBe("0");
        expect(source.SEARCH_MOVE_SHOT_VERSIONS).toBe("v0.8s");
        expect(source.V06_MELEE_DIMS_VERSIONS).toBe("v0.8s");
        expect(source.V07_PLACEMENT_REVEAL_VERSIONS).toBe("v0.8s");

        // A research runner can spread the canonical profile and override only the cap; the safe seat scope
        // remains bound to the requested profile version.
        expect({ ...production, SEARCH_MAX_MOVE_SHOTS: "2" }).toMatchObject({
            SEARCH_MAX_MOVE_SHOTS: "2",
            SEARCH_MOVE_SHOT_VERSIONS: "v0.8",
        });
    });

    it("constructs an exact bounded driver and restores hostile ambient experiments", () => {
        process.env.V07_SEARCH = "0";
        process.env.SEARCH_GATE = "99";
        process.env.SEARCH_HORIZON = "999";
        process.env.SEARCH_ROLLOUTS = "999";
        process.env.SEARCH_VERSIONS = "v0.4";
        process.env.SEARCH_MAX_MOVE_SHOTS = "2";
        process.env.SEARCH_MOVE_SHOT_VERSIONS = "v0.7";
        process.env.SEARCH_PURE_RANGED_NO_MELEE_PRESSURE = "1";
        process.env.SEARCH_PURE_RANGED_DEADLINE_FINISHER = "1";
        process.env.SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS = "1";
        process.env.SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_DAMAGE_FLOOR = "0.9";
        process.env.SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_SCOPE = "any_board";
        process.env.SEARCH_PURE_RANGED_JIT_NO_MELEE_FOCUS = "1";
        process.env.SEARCH_PURE_RANGED_JIT_NO_MELEE_FOCUS_VERSIONS = "v0.7";
        process.env.V08_PROTECTED_ADVANCE_GUARDRAILS = "1";
        process.env.V08_PROTECTED_ADVANCE_GUARDRAILS_LIVE_ONLY = "1";
        process.env.V08_PROTECTED_ADVANCE_GUARDRAILS_MODE = "partial_band";
        process.env.V08_PROTECTED_ADVANCE_GUARDRAILS_VERSIONS = "v0.7";
        process.env.V08_SUPPORTED_BAND_ADVANCE = "1";
        process.env.V08_SUPPORTED_BAND_ADVANCE_FUNNEL_VERSIONS = "v0.6";
        process.env.V08_SUPPORTED_BAND_ADVANCE_LEGACY_CONTROL_VERSIONS = "v0.8s";
        process.env.V08_SUPPORTED_BAND_ADVANCE_LIVE_ONLY = "1";
        process.env.V08_SUPPORTED_BAND_ADVANCE_VERSIONS = "v0.7";
        process.env.V08_SUPPORTED_PREPIN_EGRESS = "1";
        process.env.V08_SUPPORTED_PREPIN_EGRESS_FUNNEL_VERSIONS = "v0.6";
        process.env.V08_SUPPORTED_PREPIN_EGRESS_LIVE_ONLY = "1";
        process.env.V08_SUPPORTED_PREPIN_EGRESS_VERSIONS = "v0.7";
        process.env.V07_VALUE_WEIGHTS = "material";
        const driver = createV08A13SearchDriver({} as ILookaheadDeps, {
            seed: 13,
            greenVersion: "v0.8",
            redVersion: "v0.7",
        });
        const internals = driver as unknown as {
            gate: number;
            horizon: number;
            rollouts: number;
            includeMoves: boolean;
            activeChallengers: boolean;
            maxMoveShotComposites: number;
            moveShotCapForVersion: (version: string) => number;
            aggressiveV08: boolean;
            shortlist: number | null;
            decisionDeadlineMs: number | null;
            circuitBreakerMs: number | null;
            pureRangedNoMeleePressure: boolean;
            pureRangedDeadlineFinisher: boolean;
            pureRangedParetoNoMeleeFocus: boolean;
            pureRangedParetoNoMeleeFocusDamageFloor: number;
            pureRangedParetoNoMeleeFocusScope: string;
            pureRangedJitNoMeleeFocus: boolean;
            pureRangedJitNoMeleeFocusVersions: ReadonlySet<string>;
            learnedV2: { b: number; w: number[] } | null;
            caps: {
                maxMoveDestinations: number;
                maxMeleePairs: number;
                maxShotAims: number;
                maxAreaThrowCells: number;
            };
        };

        expect(driver.enabled).toBe(true);
        expect(driver.appliesTo("v0.8")).toBe(true);
        expect(driver.appliesTo("v0.8s")).toBe(false);
        expect(internals).toMatchObject({
            gate: 0.03,
            horizon: 12,
            rollouts: 2,
            includeMoves: true,
            activeChallengers: true,
            maxMoveShotComposites: 0,
            aggressiveV08: true,
            shortlist: 3,
            decisionDeadlineMs: 175,
            circuitBreakerMs: 275,
            pureRangedNoMeleePressure: false,
            pureRangedDeadlineFinisher: false,
            pureRangedParetoNoMeleeFocus: false,
            pureRangedParetoNoMeleeFocusDamageFloor: 1,
            pureRangedParetoNoMeleeFocusScope: "pure_ranged",
            pureRangedJitNoMeleeFocus: false,
            caps: {
                maxMoveDestinations: 1,
                maxMeleePairs: 6,
                maxShotAims: 4,
                maxAreaThrowCells: 2,
            },
        });
        expect(internals.moveShotCapForVersion("v0.8")).toBe(0);
        expect(internals.moveShotCapForVersion("v0.7")).toBe(0);
        expect(internals.learnedV2).toEqual(V08_A13_VALUE_LEAF);
        expect([...internals.pureRangedJitNoMeleeFocusVersions]).toEqual([]);
        expect(process.env.V07_SEARCH).toBe("0");
        expect(process.env.SEARCH_GATE).toBe("99");
        expect(process.env.SEARCH_HORIZON).toBe("999");
        expect(process.env.SEARCH_ROLLOUTS).toBe("999");
        expect(process.env.SEARCH_VERSIONS).toBe("v0.4");
        expect(process.env.SEARCH_MAX_MOVE_SHOTS).toBe("2");
        expect(process.env.SEARCH_MOVE_SHOT_VERSIONS).toBe("v0.7");
        expect(process.env.SEARCH_PURE_RANGED_NO_MELEE_PRESSURE).toBe("1");
        expect(process.env.SEARCH_PURE_RANGED_DEADLINE_FINISHER).toBe("1");
        expect(process.env.SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS).toBe("1");
        expect(process.env.SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_DAMAGE_FLOOR).toBe("0.9");
        expect(process.env.SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_SCOPE).toBe("any_board");
        expect(process.env.SEARCH_PURE_RANGED_JIT_NO_MELEE_FOCUS).toBe("1");
        expect(process.env.SEARCH_PURE_RANGED_JIT_NO_MELEE_FOCUS_VERSIONS).toBe("v0.7");
        expect(process.env.V08_PROTECTED_ADVANCE_GUARDRAILS).toBe("1");
        expect(process.env.V08_PROTECTED_ADVANCE_GUARDRAILS_LIVE_ONLY).toBe("1");
        expect(process.env.V08_PROTECTED_ADVANCE_GUARDRAILS_MODE).toBe("partial_band");
        expect(process.env.V08_PROTECTED_ADVANCE_GUARDRAILS_VERSIONS).toBe("v0.7");
        expect(process.env.V08_SUPPORTED_BAND_ADVANCE).toBe("1");
        expect(process.env.V08_SUPPORTED_BAND_ADVANCE_FUNNEL_VERSIONS).toBe("v0.6");
        expect(process.env.V08_SUPPORTED_BAND_ADVANCE_LEGACY_CONTROL_VERSIONS).toBe("v0.8s");
        expect(process.env.V08_SUPPORTED_BAND_ADVANCE_LIVE_ONLY).toBe("1");
        expect(process.env.V08_SUPPORTED_BAND_ADVANCE_VERSIONS).toBe("v0.7");
        expect(process.env.V08_SUPPORTED_PREPIN_EGRESS).toBe("1");
        expect(process.env.V08_SUPPORTED_PREPIN_EGRESS_FUNNEL_VERSIONS).toBe("v0.6");
        expect(process.env.V08_SUPPORTED_PREPIN_EGRESS_LIVE_ONLY).toBe("1");
        expect(process.env.V08_SUPPORTED_PREPIN_EGRESS_VERSIONS).toBe("v0.7");
        expect(process.env.V07_VALUE_WEIGHTS).toBe("material");
    });

    it("defaults ordinary v0.8 matches to a13 while preserving explicit research and rollback controls", () => {
        for (const key of ENV_KEYS) delete process.env[key];
        const match = { greenVersion: "v0.8", redVersion: "v0.7" };
        expect(shouldUseDefaultV08A13Search(match)).toBe(true);
        expect(shouldUseDefaultV08A13Search({ greenVersion: "v0.8s", redVersion: "v0.7" })).toBe(false);

        process.env.V07_SEARCH = "1";
        expect(shouldUseDefaultV08A13Search(match)).toBe(false);
        delete process.env.V07_SEARCH;
        process.env[V08_A13_SEARCH_OVERRIDE_ENV] = "0";
        expect(shouldUseDefaultV08A13Search(match)).toBe(false);
        process.env[V08_A13_SEARCH_OVERRIDE_ENV] = "1";
        process.env.Q2_ORACLE = "1";
        expect(shouldUseDefaultV08A13Search(match)).toBe(true);
    });
});
