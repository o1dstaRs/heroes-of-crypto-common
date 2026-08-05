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
    SEARCH_RESEARCH_HORIZON_ENV,
    SEARCH_RESEARCH_HORIZON_MIN_RANGED_TYPES_ENV,
    SEARCH_RESEARCH_HORIZON_VERSIONS_ENV,
    SearchDriver,
} from "../../src/simulation/search_driver";
import type { Unit } from "../../src/units/unit";

const ENV_KEYS = [
    "V07_SEARCH",
    "Q2_WAIT_ABLATION",
    "Q2_ORACLE",
    "SEARCH_VERSIONS",
    "SEARCH_HORIZON",
    "SEARCH_ROLLOUTS",
    "SEARCH_GATE",
    "SEARCH_OBSERVE_ONLY",
    "SEARCH_VALIDATION_ROLLOUTS",
    SEARCH_RESEARCH_HORIZON_ENV,
    SEARCH_RESEARCH_HORIZON_MIN_RANGED_TYPES_ENV,
    SEARCH_RESEARCH_HORIZON_VERSIONS_ENV,
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
        {
            kind: "move",
            actions: [{ type: "move_unit", unitId: "unit", path: [{ x: 1, y: 1 }] }],
            features,
        },
    ];
}

interface SearchInternals {
    turnHorizonForVersion(version: string, team: PBTypes.TeamVals): number;
    onFightReady(): void;
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
    scoreCandidates(
        unit: Unit,
        candidates: readonly IEnumeratedCandidate[],
        seedBase: number,
        horizonMode: string,
        rolloutCount?: number,
        deadlineAt?: number | null,
        turnHorizon?: number,
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

describe("research-only version-scoped search horizon", () => {
    it("is exact H12 identity when both research variables are absent", () => {
        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.8,v0.8s", SEARCH_HORIZON: "12" });
        const driver = new SearchDriver(fakeDeps) as unknown as SearchInternals;

        expect(driver.turnHorizonForVersion("v0.8", PBTypes.TeamVals.LOWER)).toBe(12);
        expect(driver.turnHorizonForVersion("v0.8s", PBTypes.TeamVals.LOWER)).toBe(12);
    });

    it("freezes a distinct native RANGE-name scope for each acting team at fight readiness", () => {
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8,v0.8s",
            SEARCH_HORIZON: "12",
            [SEARCH_RESEARCH_HORIZON_ENV]: "18",
            [SEARCH_RESEARCH_HORIZON_VERSIONS_ENV]: "v0.8",
            [SEARCH_RESEARCH_HORIZON_MIN_RANGED_TYPES_ENV]: "2",
        });
        const units = new Map<string, Unit>();
        const addUnit = (
            id: string,
            name: string,
            team: PBTypes.TeamVals,
            attackType: PBTypes.AttackVals,
            summoned = false,
            dead = false,
        ): void => {
            units.set(id, {
                getId: () => id,
                getName: () => name,
                getTeam: () => team,
                getAttackType: () => attackType,
                isSummoned: () => summoned,
                isDead: () => dead,
            } as unknown as Unit);
        };
        addUnit("lower-medusa-a", "Medusa", PBTypes.TeamVals.LOWER, PBTypes.AttackVals.RANGE);
        addUnit("lower-medusa-b", "Medusa", PBTypes.TeamVals.LOWER, PBTypes.AttackVals.RANGE);
        addUnit("lower-cyclops", "Cyclops", PBTypes.TeamVals.LOWER, PBTypes.AttackVals.RANGE);
        addUnit("upper-medusa", "Medusa", PBTypes.TeamVals.UPPER, PBTypes.AttackVals.RANGE);
        addUnit("upper-dead", "Cyclops", PBTypes.TeamVals.UPPER, PBTypes.AttackVals.RANGE, false, true);
        addUnit("upper-summon", "Arachna Spider", PBTypes.TeamVals.UPPER, PBTypes.AttackVals.RANGE, true);
        addUnit("upper-mage", "Healer", PBTypes.TeamVals.UPPER, PBTypes.AttackVals.MAGIC);
        const deps = {
            fightProperties: { getCurrentLap: () => 3 },
            unitsHolder: { getAllUnits: () => units },
        } as unknown as ILookaheadDeps;
        const driver = new SearchDriver(deps) as unknown as SearchInternals;

        driver.onFightReady();
        expect(driver.turnHorizonForVersion("v0.8", PBTypes.TeamVals.LOWER)).toBe(18);
        expect(driver.turnHorizonForVersion("v0.8", PBTypes.TeamVals.UPPER)).toBe(12);
        expect(driver.turnHorizonForVersion("v0.8s", PBTypes.TeamVals.LOWER)).toBe(12);

        addUnit("upper-late-ranged", "Cyclops", PBTypes.TeamVals.UPPER, PBTypes.AttackVals.RANGE);
        driver.onFightReady();
        expect(driver.turnHorizonForVersion("v0.8", PBTypes.TeamVals.UPPER)).toBe(12);
    });

    it("uses H18 for v0.8 discovery and validation while v0.8s remains H12", () => {
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8,v0.8s",
            SEARCH_HORIZON: "12",
            SEARCH_ROLLOUTS: "3",
            SEARCH_GATE: "0",
            SEARCH_OBSERVE_ONLY: "1",
            SEARCH_VALIDATION_ROLLOUTS: "2",
            [SEARCH_RESEARCH_HORIZON_ENV]: "18",
            [SEARCH_RESEARCH_HORIZON_VERSIONS_ENV]: "v0.8",
        });
        const driver = new SearchDriver(fakeDeps) as unknown as SearchInternals;
        const calls: { horizonMode: string; rolloutCount: number | undefined; turnHorizon: number | undefined }[] = [];
        driver.scoreCandidates = (_unit, scored, _seed, horizonMode, rolloutCount, _deadline, turnHorizon) => {
            calls.push({ horizonMode, rolloutCount, turnHorizon });
            return scored.map((_candidate, index) => (index === 0 ? 0.1 : 0.9));
        };

        runPrivateSearch(driver, "v0.8");
        runPrivateSearch(driver, "v0.8s");

        expect(calls).toEqual([
            { horizonMode: "turns", rolloutCount: 3, turnHorizon: 18 },
            { horizonMode: "turns", rolloutCount: 2, turnHorizon: 18 },
            { horizonMode: "turns", rolloutCount: 3, turnHorizon: 12 },
            { horizonMode: "turns", rolloutCount: 2, turnHorizon: 12 },
        ]);
    });

    it("rejects malformed, incomplete, duplicate, and out-of-search scopes", () => {
        const construct = () => new SearchDriver(fakeDeps);
        const base = { V07_SEARCH: "1", SEARCH_VERSIONS: "v0.8,v0.8s" } as const;

        setEnv({ ...base, [SEARCH_RESEARCH_HORIZON_ENV]: "18" });
        expect(construct).toThrow(SEARCH_RESEARCH_HORIZON_VERSIONS_ENV);

        setEnv({
            ...base,
            [SEARCH_RESEARCH_HORIZON_ENV]: "1.5",
            [SEARCH_RESEARCH_HORIZON_VERSIONS_ENV]: "v0.8",
        });
        expect(construct).toThrow(`${SEARCH_RESEARCH_HORIZON_ENV} must be a positive integer`);

        setEnv({
            ...base,
            [SEARCH_RESEARCH_HORIZON_ENV]: "18",
            [SEARCH_RESEARCH_HORIZON_VERSIONS_ENV]: "v0.8,v0.8",
        });
        expect(construct).toThrow(SEARCH_RESEARCH_HORIZON_VERSIONS_ENV);

        setEnv({
            ...base,
            [SEARCH_RESEARCH_HORIZON_ENV]: "18",
            [SEARCH_RESEARCH_HORIZON_VERSIONS_ENV]: "v0.7",
        });
        expect(construct).toThrow(SEARCH_RESEARCH_HORIZON_VERSIONS_ENV);

        setEnv({ [SEARCH_RESEARCH_HORIZON_ENV]: "18", [SEARCH_RESEARCH_HORIZON_VERSIONS_ENV]: "v0.8" });
        expect(construct).toThrow(`${SEARCH_RESEARCH_HORIZON_ENV} requires V07_SEARCH=1`);

        setEnv({ [SEARCH_RESEARCH_HORIZON_MIN_RANGED_TYPES_ENV]: "2" });
        expect(construct).toThrow(
            `${SEARCH_RESEARCH_HORIZON_MIN_RANGED_TYPES_ENV} requires ${SEARCH_RESEARCH_HORIZON_ENV}`,
        );

        for (const malformed of ["", "0", "-1", "1.5", "NaN"]) {
            setEnv({
                ...base,
                [SEARCH_RESEARCH_HORIZON_ENV]: "18",
                [SEARCH_RESEARCH_HORIZON_VERSIONS_ENV]: "v0.8",
                [SEARCH_RESEARCH_HORIZON_MIN_RANGED_TYPES_ENV]: malformed,
            });
            expect(construct).toThrow(`${SEARCH_RESEARCH_HORIZON_MIN_RANGED_TYPES_ENV} must be a positive integer`);
        }
    });
});
