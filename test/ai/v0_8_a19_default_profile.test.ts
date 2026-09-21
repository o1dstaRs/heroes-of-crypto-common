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

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { IAIStrategy } from "../../src/ai/ai_strategy";
import { StrategyV0_8 } from "../../src/ai/versions/v0_8";
import { buildV08A13SearchEnvironment, V08_A13_GENOME } from "../../src/ai/versions/v0_8_a13_profile";
import { V08A19BoarBattleMageFlankPlacementStrategy } from "../../src/ai/versions/v0_8_a19_boar_battle_mage_flank_placement";
import { V08A19CompactPlacementStrategy } from "../../src/ai/versions/v0_8_a19_compact_placement";
import { V08A19F184LowerHumanPlacementStrategy } from "../../src/ai/versions/v0_8_a19_f184_lower_human_placement";
import {
    buildV08A19SearchEnvironment,
    createV08A19Strategy,
    V08_A19_BEHAVIOR_ENVIRONMENT_SHA256,
    V08_A19_GENOME,
    V08_A19_GENOME_SHA256,
    V08_A19_PROFILE,
    V08_A19_SEARCH,
    V08_A19_SEARCH_RULES,
    V08_A19_SOURCE_LEDGER,
} from "../../src/ai/versions/v0_8_a19_profile";
import { V08A19RankedPlacementStrategy } from "../../src/ai/versions/v0_8_a19_ranked_placement";
import { runMatch } from "../../src/simulation/battle_engine";
import { fingerprintV08AlignedV1 } from "../../src/simulation/optimizer/v0_8_aligned_96h_v1_protocol";
import { shouldUseDefaultV08A19Search, V08_A19_SEARCH_OVERRIDE_ENV } from "../../src/simulation/v0_8_a19_search";
import { V08_A13_SEARCH_OVERRIDE_ENV } from "../../src/simulation/v0_8_a13_search";

const ENV_KEYS = [
    V08_A19_SEARCH_OVERRIDE_ENV,
    V08_A13_SEARCH_OVERRIDE_ENV,
    "V08_A19_SEARCH_ENV_OVERRIDES",
    "V07_SEARCH",
    "Q2_WAIT_ABLATION",
    "Q2_ORACLE",
    "V08_VISIBLE_EDGE_SCREEN_PRESSURE",
] as const;
const savedEnvironment = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

const restoreEnvironment = (): void => {
    for (const key of ENV_KEYS) {
        const value = savedEnvironment.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
};

beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(restoreEnvironment);

describe("v0.8+A19 production profile", () => {
    it("is one flat production identity with the deep search budget and every A19 rule on", () => {
        const environment = buildV08A19SearchEnvironment();

        expect(V08_A19_PROFILE).toMatchObject({
            schema: "hoc.v0_8_a19_production_profile.v2",
            candidateId: "a19",
            productionVersion: "v0.8",
            researchOnly: false,
        });
        expect(V08_A19_SEARCH).toMatchObject({
            gate: 0.03,
            horizon: 64,
            rollouts: 4,
            shortlist: 6,
            maxMelee: 10,
            maxShots: 4,
            maxThrows: 2,
            decisionDeadlineMs: 1000,
            circuitBreakerMs: 1500,
            waitDeadlinePolicy: "operation_bounded",
        });
        expect(environment).toMatchObject({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8",
            SEARCH_GATE: "0.03",
            SEARCH_HORIZON: "64",
            SEARCH_ROLLOUTS: "4",
            SEARCH_SHORTLIST: "6",
            SEARCH_MAX_MELEE: "10",
            SEARCH_DECISION_DEADLINE_MS: "1000",
            SEARCH_CIRCUIT_BREAKER_MS: "1500",
            V07_PLACEMENT_REVEAL: "on",
            V08_AGGRESSIVE: "1",
            ...V08_A19_SEARCH_RULES,
        });
        for (const value of Object.values(V08_A19_SEARCH_RULES)) expect(value).toBe("1");
        // The re-score bank and the broad Armageddon-defend research arm no longer exist anywhere.
        expect(environment).not.toHaveProperty("SEARCH_A19_NONREGRESSIVE_OVERRIDE_VALIDATION");
        expect(environment).not.toHaveProperty("SEARCH_A19_POOLED_OVERRIDE_VALIDATION");
        expect(environment).not.toHaveProperty("SEARCH_A19_ARMAGEDDON_DEFEND_CANDIDATE");
        // Everything else is the a13 base, untouched.
        const base = buildV08A13SearchEnvironment("v0.8");
        for (const [key, value] of Object.entries(base)) {
            if (key in V08_A19_SEARCH_RULES) continue;
            if (
                [
                    "SEARCH_HORIZON",
                    "SEARCH_ROLLOUTS",
                    "SEARCH_SHORTLIST",
                    "SEARCH_MAX_MELEE",
                    "SEARCH_DECISION_DEADLINE_MS",
                    "SEARCH_CIRCUIT_BREAKER_MS",
                ].includes(key)
            ) {
                continue;
            }
            expect(environment[key]).toBe(value);
        }
    });

    it("fingerprints its genome and sealed environment", () => {
        expect(V08_A19_GENOME.controls).toMatchObject({
            ...V08_A13_GENOME.controls,
            shortlist: 6,
            decisionDeadlineMs: 1000,
        });
        expect(V08_A19_GENOME.search).toMatchObject({
            ...V08_A13_GENOME.search,
            horizon: 64,
            rollouts: 4,
            maxMelee: 10,
        });
        // The deep budget sits outside the v0.7 aligned-campaign grid, so the genome is hashed canonically as-is.
        expect(fingerprintV08AlignedV1(V08_A19_GENOME)).toBe(V08_A19_GENOME_SHA256);
        expect(fingerprintV08AlignedV1(buildV08A19SearchEnvironment())).toBe(V08_A19_BEHAVIOR_ENVIRONMENT_SHA256);
    });

    it("pins the bytes of every source its behavior depends on", () => {
        expect(V08_A19_PROFILE.sourceLedger).toBe(V08_A19_SOURCE_LEDGER);
        expect(V08_A19_SOURCE_LEDGER.map(({ role }) => role)).toEqual([
            "search-driver",
            "armageddon-endgame",
            "f184-lower-placement",
            "boar-battle-mage-flank-placement",
            "compact-placement",
            "ranked-placement",
            "ai-registry-promotion",
            "default-search-factory",
            "default-search-routing",
        ]);
        for (const { source, sha256 } of V08_A19_SOURCE_LEDGER) {
            const bytes = readFileSync(new URL(`../../${source}`, import.meta.url));
            expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
        }
    });

    it("composes exact f184 -> flank -> compact -> ranked placement over a fresh native v0.8", () => {
        const strategy = createV08A19Strategy();
        const layer = (value: unknown): unknown => (value as { base: unknown }).base;

        expect(strategy).toBeInstanceOf(V08A19F184LowerHumanPlacementStrategy);
        expect(layer(strategy)).toBeInstanceOf(V08A19BoarBattleMageFlankPlacementStrategy);
        expect(layer(layer(strategy))).toBeInstanceOf(V08A19CompactPlacementStrategy);
        expect(layer(layer(layer(strategy)))).toBeInstanceOf(V08A19RankedPlacementStrategy);
        expect(layer(layer(layer(layer(strategy))))).toBeInstanceOf(StrategyV0_8);
        expect(strategy.version).toBe("v0.8");
        expect(createV08A19Strategy()).not.toBe(strategy);
        expect(V08_A19_PROFILE.placementPolicy.precedence).toEqual([
            "exact-f184-lower",
            "boar-battle-mage-far-flank",
            "l4-scoped-compact",
            "generic-ranked-placement",
            "plain-v0.8",
        ]);
    });

    it("merges research overrides last and refuses malformed ones", () => {
        process.env.V08_A19_SEARCH_ENV_OVERRIDES = JSON.stringify({ SEARCH_ROLLOUTS: "2" });
        expect(buildV08A19SearchEnvironment().SEARCH_ROLLOUTS).toBe("2");
        expect(buildV08A19SearchEnvironment().SEARCH_SHORTLIST).toBe("6");

        process.env.V08_A19_SEARCH_ENV_OVERRIDES = "{not json";
        expect(() => buildV08A19SearchEnvironment()).toThrow("V08_A19_SEARCH_ENV_OVERRIDES is not valid JSON");
        process.env.V08_A19_SEARCH_ENV_OVERRIDES = JSON.stringify({ SEARCH_ROLLOUTS: 2 });
        expect(() => buildV08A19SearchEnvironment()).toThrow(
            "V08_A19_SEARCH_ENV_OVERRIDES.SEARCH_ROLLOUTS must be a string",
        );
        process.env.V08_A19_SEARCH_ENV_OVERRIDES = "[]";
        expect(() => buildV08A19SearchEnvironment()).toThrow("must be a JSON object");
    });

    it("is the ordinary v0.8 search while retaining explicit research and rollback controls", () => {
        const match = { greenVersion: "v0.8", redVersion: "v0.7" };
        expect(shouldUseDefaultV08A19Search(match)).toBe(true);
        expect(shouldUseDefaultV08A19Search({ greenVersion: "v0.8s", redVersion: "v0.7" })).toBe(false);

        process.env.V07_SEARCH = "1";
        expect(shouldUseDefaultV08A19Search(match)).toBe(false);
        delete process.env.V07_SEARCH;

        process.env[V08_A13_SEARCH_OVERRIDE_ENV] = "1";
        expect(shouldUseDefaultV08A19Search(match)).toBe(false);
        process.env[V08_A19_SEARCH_OVERRIDE_ENV] = "1";
        expect(shouldUseDefaultV08A19Search(match)).toBe(false);
        delete process.env[V08_A19_SEARCH_OVERRIDE_ENV];
        delete process.env[V08_A13_SEARCH_OVERRIDE_ENV];

        process.env[V08_A19_SEARCH_OVERRIDE_ENV] = "0";
        expect(shouldUseDefaultV08A19Search(match)).toBe(false);
        process.env[V08_A19_SEARCH_OVERRIDE_ENV] = "1";
        process.env.Q2_ORACLE = "1";
        expect(shouldUseDefaultV08A19Search(match)).toBe(true);
    });

    it("keeps the sealed A19 environment active for every live and rollout strategy decision", () => {
        const observedDynamicFlags: Array<string | undefined> = [];
        const recordingStrategy = (): IAIStrategy => {
            const base = new StrategyV0_8();
            return {
                version: base.version,
                placeArmy: base.placeArmy.bind(base),
                decideTurn: (unit, context) => {
                    observedDynamicFlags.push(process.env.V08_VISIBLE_EDGE_SCREEN_PRESSURE);
                    return base.decideTurn(unit, context);
                },
            };
        };

        process.env.V08_VISIBLE_EDGE_SCREEN_PRESSURE = "1";
        runMatch({
            greenVersion: "v0.8",
            redVersion: "v0.8",
            greenStrategyOverride: recordingStrategy(),
            redStrategyOverride: recordingStrategy(),
            roster: [{ faction: "Nature", creatureName: "Trent", level: 2, size: 1, amount: 24 }],
            seed: 20260805,
            maxLaps: 1,
        });

        expect(observedDynamicFlags.length).toBeGreaterThan(0);
        expect(observedDynamicFlags.every((value) => value === undefined)).toBe(true);
        expect(process.env.V08_VISIBLE_EDGE_SCREEN_PRESSURE).toBe("1");
    });
});
