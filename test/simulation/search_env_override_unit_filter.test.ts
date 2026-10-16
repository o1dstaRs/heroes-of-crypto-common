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

import { GREEN_TEAM, type IMatchConfig, runMatch } from "../../src/simulation/battle_engine";
import type { Unit } from "../../src/units/unit";

const DEEP = JSON.stringify({ SEARCH_ROLLOUTS: "4", SEARCH_SHORTLIST: "6", SEARCH_MAX_MELEE: "10" });
const savedOverrides = process.env.V08_A19_SEARCH_ENV_OVERRIDES;

afterEach(() => {
    if (savedOverrides === undefined) delete process.env.V08_A19_SEARCH_ENV_OVERRIDES;
    else process.env.V08_A19_SEARCH_ENV_OVERRIDES = savedOverrides;
});

const base: IMatchConfig = {
    greenVersion: "v0.8",
    redVersion: "v0.8",
    roster: [
        { faction: "Might", creatureName: "Harpy", level: 2, size: 1, amount: 20 },
        { faction: "Nature", creatureName: "Trent", level: 2, size: 1, amount: 24 },
    ],
    redRoster: [{ faction: "Life", creatureName: "Peasant", level: 1, size: 1, amount: 100 }],
    seed: 123,
    maxLaps: 2,
    searchOfflineDeterministicWork: true,
};

const trace = (config: IMatchConfig): string => JSON.stringify(runMatch(config).actions);

describe("search env override unit filter", () => {
    it("routes only accepted units of the listed team and is exact at both extremes", () => {
        delete process.env.V08_A19_SEARCH_ENV_OVERRIDES;
        const stock = trace(base);

        process.env.V08_A19_SEARCH_ENV_OVERRIDES = DEEP;
        const wholeTeam = trace({ ...base, searchEnvOverrideTeams: [GREEN_TEAM] });
        const seen: Unit[] = [];
        const acceptAll = trace({
            ...base,
            searchEnvOverrideTeams: [GREEN_TEAM],
            searchEnvOverrideUnitFilter: (unit) => {
                seen.push(unit);
                return true;
            },
        });
        const rejectAll = trace({
            ...base,
            searchEnvOverrideTeams: [GREEN_TEAM],
            searchEnvOverrideUnitFilter: () => false,
        });

        expect(acceptAll).toBe(wholeTeam);
        expect(rejectAll).toBe(stock);
        expect(seen.length).toBeGreaterThan(0);
        expect(seen.every((unit) => unit.getTeam() === GREEN_TEAM)).toBe(true);
    }, 120_000);
});
