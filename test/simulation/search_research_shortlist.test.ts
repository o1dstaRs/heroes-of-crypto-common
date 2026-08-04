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

import type { IEnumeratedCandidate } from "../../src/ai";
import type { GameAction } from "../../src/engine/actions";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { ILookaheadDeps } from "../../src/simulation/lookahead";
import {
    SEARCH_RESEARCH_SHORTLIST_ENV,
    SEARCH_RESEARCH_SHORTLIST_VERSIONS_ENV,
    SearchDriver,
} from "../../src/simulation/search_driver";
import type { Unit } from "../../src/units/unit";

const ENV_KEYS = [
    "V07_SEARCH",
    "Q2_WAIT_ABLATION",
    "Q2_ORACLE",
    "SEARCH_VERSIONS",
    "SEARCH_SHORTLIST",
    "SEARCH_HORIZON",
    "SEARCH_ROLLOUTS",
    "SEARCH_GATE",
    "SEARCH_OBSERVE_ONLY",
    "SEARCH_VALIDATION_ROLLOUTS",
    SEARCH_RESEARCH_SHORTLIST_ENV,
    SEARCH_RESEARCH_SHORTLIST_VERSIONS_ENV,
] as const;

const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function setEnv(patch: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
    for (const key of ENV_KEYS) {
        const value = patch[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}

beforeEach(() => setEnv({}));

afterEach(() => {
    for (const key of ENV_KEYS) {
        const value = savedEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

const fakeDeps = {
    fightProperties: { getCurrentLap: () => 3 },
    unitsHolder: { getAllUnits: () => new Map() },
} as unknown as ILookaheadDeps;

const fakeUnit = {
    getId: () => "unit",
    getName: () => "Squire",
    getTeam: () => PBTypes.TeamVals.LOWER,
} as unknown as Unit;

const features = {
    moraleDelta: 0,
    luckDelta: 0,
    enemiesNotYetActedFrac: 0,
    alliesNotYetActedFrac: 0,
    lap: 3,
    hourglassSpent: 0 as const,
    spendsRangeShot: 0 as const,
    spendsSpellCharge: 0 as const,
    burnsResurrectionCharge: 0 as const,
    expectedDamage: 0,
    expectedKill: 0 as const,
};

function candidates(incumbent: GameAction[]): IEnumeratedCandidate[] {
    return [
        { kind: "incumbent", actions: incumbent, features },
        ...[1, 2, 3].map((x): IEnumeratedCandidate => ({
            kind: "move",
            actions: [{ type: "move_unit", unitId: "unit", path: [{ x, y: 1 }] }],
            features,
        })),
    ];
}

interface SearchInternals {
    shortlistForVersion(version: string): number | null;
    search(
        unit: Unit,
        candidates: IEnumeratedCandidate[],
        incumbent: GameAction[],
        seedBase: number,
        t0: number,
        prioritizeProductiveActions: boolean,
        productiveFallback: IEnumeratedCandidate | undefined,
        prioritizeDominantFinish: boolean,
        aggressiveWaitComparison: boolean,
        prioritizeV08STargetPressure: boolean,
        prioritizeV08SUrgency: boolean,
        passiveAudit: undefined,
        deadlinePolicy: "profile",
        version: string,
    ): GameAction[];
    scorePassiveCounterfactual(
        audit: { beforeCounterfactual(): void },
        unit: Unit,
        candidates: IEnumeratedCandidate[],
        seedBase: number,
        prioritizeProductiveActions: boolean,
        prioritizeDominantFinish: boolean,
        prioritizeV08STargetPressure: boolean,
        prioritizeV08SUrgency: boolean,
        version: string,
    ): { candidates: readonly IEnumeratedCandidate[]; means: readonly number[] } | undefined;
    scoreCandidates(
        unit: Unit,
        candidates: readonly IEnumeratedCandidate[],
        seedBase: number,
        horizonMode: string,
    ): number[];
}

function runPrivateSearch(driver: SearchInternals, version: string): void {
    const incumbent: GameAction[] = [{ type: "defend_turn", unitId: "unit" }];
    driver.search(
        fakeUnit,
        candidates(incumbent),
        incumbent,
        123,
        performance.now(),
        false,
        undefined,
        false,
        false,
        false,
        false,
        undefined,
        "profile",
        version,
    );
}

describe("research-only version-scoped search shortlist", () => {
    it("is exact production-shortlist identity when both research variables are absent", () => {
        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.8,v0.8s", SEARCH_SHORTLIST: "2" });
        const driver = new SearchDriver(fakeDeps) as unknown as SearchInternals;

        expect(driver.shortlistForVersion("v0.8")).toBe(2);
        expect(driver.shortlistForVersion("v0.8s")).toBe(2);
    });

    it("scores three finalists only for the scoped acting version on live and passive paths", () => {
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8,v0.8s",
            SEARCH_SHORTLIST: "2",
            SEARCH_HORIZON: "1",
            SEARCH_ROLLOUTS: "1",
            SEARCH_GATE: "0",
            [SEARCH_RESEARCH_SHORTLIST_ENV]: "3",
            [SEARCH_RESEARCH_SHORTLIST_VERSIONS_ENV]: "v0.8",
        });
        const driver = new SearchDriver(fakeDeps) as unknown as SearchInternals;
        const calls: { mode: string; count: number }[] = [];
        driver.scoreCandidates = (_unit, scored, _seed, mode) => {
            calls.push({ mode, count: scored.length });
            return scored.map((_candidate, index) => (index === 0 ? 0.1 : 1 - index / 10));
        };

        expect(driver.shortlistForVersion("v0.8")).toBe(3);
        expect(driver.shortlistForVersion("v0.8s")).toBe(2);
        runPrivateSearch(driver, "v0.8");
        runPrivateSearch(driver, "v0.8s");

        const incumbent: GameAction[] = [{ type: "defend_turn", unitId: "unit" }];
        const audit = { beforeCounterfactual: () => undefined };
        driver.scorePassiveCounterfactual(
            audit,
            fakeUnit,
            candidates(incumbent),
            456,
            false,
            false,
            false,
            false,
            "v0.8",
        );
        driver.scorePassiveCounterfactual(
            audit,
            fakeUnit,
            candidates(incumbent),
            456,
            false,
            false,
            false,
            false,
            "v0.8s",
        );

        expect(calls).toEqual([
            { mode: "leaf", count: 4 },
            { mode: "turns", count: 3 },
            { mode: "leaf", count: 4 },
            { mode: "turns", count: 2 },
            { mode: "leaf", count: 4 },
            { mode: "turns", count: 3 },
            { mode: "leaf", count: 4 },
            { mode: "turns", count: 2 },
        ]);
    });

    it("rejects missing baselines, malformed pairs, duplicate scopes, and out-of-search versions", () => {
        const construct = () => new SearchDriver(fakeDeps);
        const base = {
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8,v0.8s",
            SEARCH_SHORTLIST: "2",
        } as const;

        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8,v0.8s",
            [SEARCH_RESEARCH_SHORTLIST_ENV]: "3",
            [SEARCH_RESEARCH_SHORTLIST_VERSIONS_ENV]: "v0.8",
        });
        expect(construct).toThrow(`${SEARCH_RESEARCH_SHORTLIST_ENV} requires SEARCH_SHORTLIST`);

        setEnv({ ...base, [SEARCH_RESEARCH_SHORTLIST_ENV]: "3" });
        expect(construct).toThrow(SEARCH_RESEARCH_SHORTLIST_VERSIONS_ENV);

        setEnv({ ...base, [SEARCH_RESEARCH_SHORTLIST_VERSIONS_ENV]: "v0.8" });
        expect(construct).toThrow(`${SEARCH_RESEARCH_SHORTLIST_ENV} must be an integer >= 2`);

        for (const malformed of ["", "0", "1", "1.5", "NaN"]) {
            setEnv({
                ...base,
                [SEARCH_RESEARCH_SHORTLIST_ENV]: malformed,
                [SEARCH_RESEARCH_SHORTLIST_VERSIONS_ENV]: "v0.8",
            });
            expect(construct).toThrow(`${SEARCH_RESEARCH_SHORTLIST_ENV} must be an integer >= 2`);
        }

        for (const malformed of ["", "v0.8,v0.8", "v0.8,", "v0.7"]) {
            setEnv({
                ...base,
                [SEARCH_RESEARCH_SHORTLIST_ENV]: "3",
                [SEARCH_RESEARCH_SHORTLIST_VERSIONS_ENV]: malformed,
            });
            expect(construct).toThrow(SEARCH_RESEARCH_SHORTLIST_VERSIONS_ENV);
        }

        setEnv({
            SEARCH_SHORTLIST: "2",
            [SEARCH_RESEARCH_SHORTLIST_ENV]: "3",
            [SEARCH_RESEARCH_SHORTLIST_VERSIONS_ENV]: "v0.8",
        });
        expect(construct).toThrow(`${SEARCH_RESEARCH_SHORTLIST_ENV} requires V07_SEARCH=1`);
    });
});
