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

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import type { IEnumeratedCandidate } from "../../src/ai";
import type { GameAction } from "../../src/engine/actions";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { ILookaheadDeps } from "../../src/simulation/lookahead";
import { SearchDriver } from "../../src/simulation/search_driver";
import type { Unit } from "../../src/units/unit";

const ENV_KEYS = [
    "V07_SEARCH",
    "Q2_WAIT_ABLATION",
    "Q2_ORACLE",
    "SEARCH_VERSIONS",
    "SEARCH_GATE",
    "SEARCH_HORIZON",
    "SEARCH_ROLLOUTS",
    "SEARCH_AUDIT",
    "SEARCH_AUDIT_TURNS",
    "SEARCH_OBSERVE_ONLY",
    "SEARCH_INCUMBENT_KINDS",
    "SEARCH_CHALLENGER_KINDS",
    "SEARCH_VALIDATION_ROLLOUTS",
    "SEARCH_IL_DATASET",
    "SEARCH_SHORTLIST",
    "SEARCH_DECISION_DEADLINE_MS",
    "SEARCH_CIRCUIT_BREAKER_MS",
] as const;

const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function setEnv(patch: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
    for (const key of ENV_KEYS) {
        const value = patch[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}

afterEach(() => {
    for (const key of ENV_KEYS) {
        const value = savedEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

const candidateFeatures = {
    moraleDelta: 0,
    luckDelta: 0,
    enemiesNotYetActedFrac: 0,
    alliesNotYetActedFrac: 0,
    lap: 1,
    hourglassSpent: 0 as const,
    spendsRangeShot: 0 as const,
    spendsSpellCharge: 0 as const,
    burnsResurrectionCharge: 0 as const,
    expectedDamage: 1,
    expectedKill: 0 as const,
};

function candidates(incumbent: GameAction[]): IEnumeratedCandidate[] {
    return [
        { kind: "incumbent", actions: incumbent, features: candidateFeatures },
        {
            kind: "melee",
            actions: [
                {
                    type: "melee_attack",
                    attackerId: "unit",
                    targetId: "enemy",
                    attackFrom: { x: 1, y: 1 },
                },
            ],
            features: candidateFeatures,
        },
        {
            kind: "shot",
            actions: [{ type: "range_attack", attackerId: "unit", targetId: "enemy" }],
            features: candidateFeatures,
        },
    ];
}

function fakeDeps(): ILookaheadDeps {
    return {
        fightProperties: { getCurrentLap: () => 3 },
        getActiveUnitId: () => "unit",
        setActiveUnitId: () => undefined,
    } as unknown as ILookaheadDeps;
}

const fakeUnit = {
    getId: () => "unit",
    getName: () => "Squire",
    getTeam: () => PBTypes.TeamVals.LOWER,
} as unknown as Unit;

interface SearchInternals {
    counters: { decisions: number; overrides: number; shadowRecommendations: number };
    search(
        unit: Unit,
        candidates: IEnumeratedCandidate[],
        incumbent: GameAction[],
        seedBase: number,
        t0: number,
    ): GameAction[];
    scoreCandidates(
        unit: Unit,
        candidates: readonly IEnumeratedCandidate[],
        seedBase: number,
        horizon: string,
        rollouts?: number,
        deadline?: number | null,
    ): number[];
}

describe("search driver passive shadow mode", () => {
    it("returns the exact incumbent reference even when discovery finds a gated challenger", () => {
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.7",
            SEARCH_OBSERVE_ONLY: "1",
            SEARCH_GATE: "0",
        });
        const incumbent: GameAction[] = [{ type: "defend_turn", unitId: "unit" }];
        const driver = new SearchDriver(fakeDeps()) as unknown as SearchInternals;
        driver.scoreCandidates = () => [0.1, 0.9, 0.7];

        expect(driver.search(fakeUnit, candidates(incumbent), incumbent, 123, performance.now())).toBe(incumbent);
        expect(driver.counters.overrides).toBe(0);
        expect(driver.counters.shadowRecommendations).toBe(1);
    });

    it("returns before seed construction, enumeration, or search counters for an excluded incumbent kind", () => {
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.7",
            SEARCH_OBSERVE_ONLY: "1",
            SEARCH_INCUMBENT_KINDS: "idle,defend",
        });
        const incumbent: GameAction[] = [{ type: "range_attack", attackerId: "unit", targetId: "enemy" }];
        const driver = new SearchDriver({} as ILookaheadDeps);

        expect(driver.chooseDecision({} as Unit, "v0.7", incumbent)).toBe(incumbent);
        expect((driver as unknown as SearchInternals).counters.decisions).toBe(0);
    });

    it("emits a game summary when no incumbent matches so a seed plan remains fully auditable", () => {
        const auditPath = join(mkdtempSync(join(tmpdir(), "search-shadow-empty-")), "audit.jsonl");
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.7",
            SEARCH_OBSERVE_ONLY: "1",
            SEARCH_INCUMBENT_KINDS: "idle,defend",
            SEARCH_AUDIT: auditPath,
            SEARCH_AUDIT_TURNS: "1",
        });
        const driver = new SearchDriver(fakeDeps(), {
            seed: 100,
            greenVersion: "v0.7",
            redVersion: "v0.7",
        });

        driver.onMatchEnd("draw", "turn_cap");

        expect(JSON.parse(readFileSync(auditPath, "utf8"))).toMatchObject({
            t: "game",
            seed: 100,
            observeOnly: true,
            decisions: 0,
            searched: 0,
        });
    });

    it("uses a domain-separated paired validation bank and emits its selected attack", () => {
        const auditPath = join(mkdtempSync(join(tmpdir(), "search-shadow-")), "audit.jsonl");
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.7",
            SEARCH_OBSERVE_ONLY: "1",
            SEARCH_GATE: "0",
            SEARCH_ROLLOUTS: "2",
            SEARCH_VALIDATION_ROLLOUTS: "5",
            SEARCH_AUDIT: auditPath,
            SEARCH_AUDIT_TURNS: "1",
        });
        const incumbent: GameAction[] = [{ type: "defend_turn", unitId: "unit" }];
        const driver = new SearchDriver(fakeDeps(), {
            seed: 99,
            greenVersion: "v0.7",
            redVersion: "v0.7",
        });
        const internals = driver as unknown as SearchInternals;
        internals.counters.decisions = 1;
        const calls: Array<{ seedBase: number; kinds: string[]; rollouts: number | undefined }> = [];
        internals.scoreCandidates = (_unit, scored, seedBase, _horizon, rollouts) => {
            calls.push({ seedBase, kinds: scored.map(({ kind }) => kind), rollouts });
            return calls.length === 1 ? [0.2, 0.8, 0.7] : [0.4, 0.9];
        };

        expect(internals.search(fakeUnit, candidates(incumbent), incumbent, 123, performance.now())).toBe(incumbent);
        expect(calls).toEqual([
            { seedBase: 123, kinds: ["incumbent", "melee", "shot"], rollouts: 2 },
            { seedBase: expect.any(Number), kinds: ["incumbent", "melee"], rollouts: 5 },
        ]);
        expect(calls[1].seedBase).not.toBe(calls[0].seedBase);

        driver.onMatchEnd("green", "elimination");
        const rows = readFileSync(auditPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        expect(rows[0]).toMatchObject({
            t: "turn",
            side: "green",
            unitId: "unit",
            decisionOrdinal: 0,
            observeOnly: 1,
            wouldOverride: 1,
            ov: 0,
            chosen: "defend",
            selectedKind: "melee",
            selectedSignature: "ml:enemy@1,1",
            discoveryDelta: 0.6,
            validationRollouts: 5,
            validationDelta: 0.5,
        });
        expect(rows[1]).toMatchObject({
            t: "game",
            observeOnly: true,
            overrides: 0,
            shadowRecommendations: 1,
            validationRollouts: 5,
        });
    });

    it("keeps normal searched selection unchanged when all shadow knobs are unset", () => {
        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.7", SEARCH_GATE: "0" });
        const incumbent: GameAction[] = [{ type: "defend_turn", unitId: "unit" }];
        const allCandidates = candidates(incumbent);
        const driver = new SearchDriver(fakeDeps()) as unknown as SearchInternals;
        driver.scoreCandidates = () => [0.1, 0.9, 0.7];

        expect(driver.search(fakeUnit, allCandidates, incumbent, 123, performance.now())).toBe(
            allCandidates[1].actions,
        );
        expect(driver.counters.overrides).toBe(1);
        expect(driver.counters.shadowRecommendations).toBe(0);
    });

    it("rejects shadow filters and validation unless the fail-closed observe-only mode is active", () => {
        setEnv({ SEARCH_OBSERVE_ONLY: "1" });
        expect(() => new SearchDriver(fakeDeps())).toThrow("SEARCH_OBSERVE_ONLY requires V07_SEARCH=1");

        setEnv({ V07_SEARCH: "1", SEARCH_INCUMBENT_KINDS: "idle,defend" });
        expect(() => new SearchDriver(fakeDeps())).toThrow("require SEARCH_OBSERVE_ONLY=1");

        setEnv({
            V07_SEARCH: "1",
            SEARCH_OBSERVE_ONLY: "1",
            SEARCH_CHALLENGER_KINDS: "melee,unknown",
        });
        expect(() => new SearchDriver(fakeDeps())).toThrow("SEARCH_CHALLENGER_KINDS must be");

        setEnv({ V07_SEARCH: "1", SEARCH_OBSERVE_ONLY: "1", SEARCH_VALIDATION_ROLLOUTS: "0" });
        expect(() => new SearchDriver(fakeDeps())).toThrow("SEARCH_VALIDATION_ROLLOUTS must be a positive integer");

        setEnv({
            V07_SEARCH: "1",
            SEARCH_OBSERVE_ONLY: "1",
            SEARCH_VALIDATION_ROLLOUTS: "5",
            SEARCH_IL_DATASET: "/tmp/must-not-be-written.jsonl",
        });
        expect(() => new SearchDriver(fakeDeps())).toThrow(
            "SEARCH_VALIDATION_ROLLOUTS cannot be combined with SEARCH_IL_DATASET",
        );
    });
});
