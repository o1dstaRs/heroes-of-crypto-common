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

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { AI_VERSIONS, DEFAULT_AI_VERSION, getAIStrategy, LATEST_AI_VERSION } from "../../src/ai";
import { StrategyV0_7 } from "../../src/ai/versions/v0_7";
import { StrategyV0_7S } from "../../src/ai/versions/v0_7s";
import { buildRoster, makeRng } from "../../src/simulation/army";
import { runMatch } from "../../src/simulation/battle_engine";

const SEARCH_ENV_KEYS = ["V07_SEARCH", "Q2_WAIT_ABLATION", "Q2_ORACLE", "SEARCH_VERSIONS"] as const;
const savedSearchEnv = Object.fromEntries(SEARCH_ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
    for (const key of SEARCH_ENV_KEYS) delete process.env[key];
});

afterEach(() => {
    for (const key of SEARCH_ENV_KEYS) {
        const value = savedSearchEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

describe("v0.7 search measurement alias", () => {
    it("is registered before v0.7 without changing the shipped latest/default version", () => {
        const alias = getAIStrategy("v0.7s");
        expect(alias).toBeInstanceOf(StrategyV0_7);
        expect(alias.version).toBe("v0.7s");
        expect(Object.getOwnPropertyNames(StrategyV0_7S.prototype)).toEqual(["constructor"]);
        expect(AI_VERSIONS.indexOf("v0.7s")).toBe(AI_VERSIONS.indexOf("v0.7") - 1);
        expect(LATEST_AI_VERSION).toBe("v0.7");
        expect(DEFAULT_AI_VERSION).toBe("v0.7");
    });

    it("plays an unsearched seeded match byte-identically to v0.7 apart from version identity", () => {
        const seed = 20260716;
        const roster = buildRoster(makeRng(seed));
        const config = { redVersion: "v0.6", roster, seed, maxLaps: 60 } as const;
        const baseline = runMatch({ ...structuredClone(config), greenVersion: "v0.7" });
        const aliased = runMatch({ ...structuredClone(config), greenVersion: "v0.7s" });

        expect(aliased.outcome.green.version).toBe("v0.7s");
        aliased.outcome.green.version = "v0.7";
        expect(aliased).toEqual(baseline);
    });
});
