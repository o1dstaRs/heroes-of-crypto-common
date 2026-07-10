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

import { afterEach, expect, test } from "bun:test";

import { buildRoster, makeRng } from "../../src/simulation/army";
import { runMatch } from "../../src/simulation/battle_engine";

const ENV_KEYS = [
    "V07_SEARCH",
    "Q2_WAIT_ABLATION",
    "SEARCH_VERSIONS",
    "SEARCH_GATE",
    "SEARCH_HORIZON",
    "SEARCH_ROLLOUTS",
    "SEARCH_INCLUDE_MOVES",
    "SEARCH_OPP_MODEL",
    "V07_VALUE_WEIGHTS",
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function clearSearchEnv(): void {
    for (const key of ENV_KEYS) {
        delete process.env[key];
    }
}

afterEach(() => {
    for (const key of ENV_KEYS) {
        const value = saved[key];
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
});

test("an impossible override gate leaves the complete seeded match byte-identical", () => {
    clearSearchEnv();
    const seed = 20260710;
    const roster = buildRoster(makeRng(seed));
    const config = {
        greenVersion: "v0.6s",
        redVersion: "v0.6",
        roster,
        seed,
        maxLaps: 60,
    } as const;
    const baseline = runMatch(structuredClone(config));

    process.env.V07_SEARCH = "1";
    process.env.SEARCH_GATE = "99";
    process.env.SEARCH_ROLLOUTS = "1";
    process.env.SEARCH_HORIZON = "4";
    const searched = runMatch(structuredClone(config));

    expect(searched).toEqual(baseline);
}, 30_000);
