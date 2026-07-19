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
import { ensureExplicitV08Action, StrategyV0_8 } from "../../src/ai/versions/v0_8";
import type { GameAction } from "../../src/engine/actions";
import { buildRoster, makeRng } from "../../src/simulation/army";
import { runMatch } from "../../src/simulation/battle_engine";

const BEHAVIOR_ENV_PREFIXES = ["V04_", "V05_", "V06_", "V07_", "SEARCH_", "Q2_", "CEM_"] as const;
const savedBehaviorEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => BEHAVIOR_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))),
);

beforeEach(() => {
    for (const key of Object.keys(process.env)) {
        if (BEHAVIOR_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) delete process.env[key];
    }
});

afterEach(() => {
    for (const key of Object.keys(process.env)) {
        if (BEHAVIOR_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) delete process.env[key];
    }
    Object.assign(process.env, savedBehaviorEnv);
});

describe("v0.8 candidate policy", () => {
    it("is the latest candidate while v0.7 remains the shipped default", () => {
        const candidate = getAIStrategy("v0.8");
        expect(candidate).toBeInstanceOf(StrategyV0_7);
        expect(candidate).toBeInstanceOf(StrategyV0_8);
        expect(candidate.version).toBe("v0.8");
        expect(Object.getOwnPropertyNames(StrategyV0_8.prototype)).toEqual(["constructor", "decideTurn"]);
        expect(AI_VERSIONS.indexOf("v0.8")).toBeGreaterThan(AI_VERSIONS.indexOf("v0.7"));
        expect(LATEST_AI_VERSION).toBe("v0.8");
        expect(DEFAULT_AI_VERSION).toBe("v0.7");
    });

    it("replaces only empty/end-turn-only decisions with an explicit defend", () => {
        const endTurn: GameAction[] = [{ type: "end_turn", unitId: "u1", reason: "manual" }];
        const defend: GameAction[] = [{ type: "defend_turn", unitId: "u1" }];
        const mixed: GameAction[] = [...endTurn, ...defend];

        expect(ensureExplicitV08Action("u1", [])).toEqual(defend);
        expect(ensureExplicitV08Action("u1", endTurn)).toEqual(defend);
        expect(ensureExplicitV08Action("u1", defend)).toBe(defend);
        expect(ensureExplicitV08Action("u1", mixed)).toBe(mixed);
    });

    it("plays a clean-default seeded match byte-identically to v0.7 apart from version identity", () => {
        const seed = 20260718;
        const roster = buildRoster(makeRng(seed));
        const config = { redVersion: "v0.6", roster, seed, maxLaps: 60 } as const;
        const baseline = runMatch({ ...structuredClone(config), greenVersion: "v0.7" });
        const candidate = runMatch({ ...structuredClone(config), greenVersion: "v0.8" });

        expect(candidate.outcome.green.version).toBe("v0.8");
        candidate.outcome.green.version = "v0.7";
        expect(candidate).toEqual(baseline);
    });
});
