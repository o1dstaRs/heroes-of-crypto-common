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
import {
    buildV08A19SearchEnvironment,
    V08_A19_PRODUCTION_ROUTING_SOURCE_LEDGER,
    V08_A19_PROFILE,
} from "../../src/ai/versions/v0_8_a19_profile";
import { runMatch } from "../../src/simulation/battle_engine";
import { shouldUseDefaultV08A19Search, V08_A19_SEARCH_OVERRIDE_ENV } from "../../src/simulation/v0_8_a19_search";
import { V08_A13_SEARCH_OVERRIDE_ENV } from "../../src/simulation/v0_8_a13_search";

const ENV_KEYS = [
    V08_A19_SEARCH_OVERRIDE_ENV,
    V08_A13_SEARCH_OVERRIDE_ENV,
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
    it("promotes the qualified v6 identity and its sealed H64 search environment", () => {
        const environment = buildV08A19SearchEnvironment();

        expect(V08_A19_PROFILE).toMatchObject({
            candidateId: "a19",
            productionVersion: "v0.8",
            researchOnly: false,
        });
        expect(V08_A19_PROFILE.promotedFrom.candidateId).toContain("a19-h64");
        expect(environment.SEARCH_VERSIONS).toBe("v0.8");
        expect(environment.SEARCH_HORIZON).toBe("64");
        expect(environment.SEARCH_A19_SOLE_ABOMINATION_ARMAGEDDON_DEFEND_POLICY).toBe("1");
        expect(environment.SEARCH_A19_NONREGRESSIVE_OVERRIDE_VALIDATION).toBe("1");
    });

    it("pins the current registry, default-search, and historical-control routing bytes", () => {
        expect(V08_A19_PROFILE.promotionSourceLedger).toBe(V08_A19_PRODUCTION_ROUTING_SOURCE_LEDGER);
        expect(V08_A19_PRODUCTION_ROUTING_SOURCE_LEDGER.map(({ role }) => role)).toEqual([
            "ai-registry-promotion",
            "default-search-factory",
            "default-search-routing",
            "historical-tournament-control",
        ]);
        for (const { source, sha256 } of V08_A19_PRODUCTION_ROUTING_SOURCE_LEDGER) {
            const bytes = readFileSync(new URL(`../../${source}`, import.meta.url));
            expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
        }
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
