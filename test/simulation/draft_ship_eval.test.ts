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

import { describe, expect, it } from "bun:test";

import {
    DEFAULT_DRAFT_SHIP_GATES,
    DRAFT_SHIP_DEFAULT_ID,
    DRAFT_SHIP_HEURISTIC_ID,
    draftShipEntrants,
    evaluateDraftShipGates,
    parseDraftShipArgs,
} from "../../src/simulation/draft_ship_eval";
import { createLeagueGenome, LEAGUE_ANCHOR_GENOME, LEAGUE_GENOME_LAYOUT } from "../../src/simulation/league_genome";
import type { ILeagueEvaluationReport, ILeagueOpponentResult } from "../../src/simulation/league_eval";

const opponent = (opponentId: string, clusteredLowerBound: number): ILeagueOpponentResult => ({
    opponentId,
    prior: 0.5,
    games: 4000,
    wins: 2400,
    losses: 1600,
    draws: 0,
    decisiveGames: 4000,
    offerBoards: 1000,
    decisiveWinRate: 0.6,
    clusteredLowerBound,
});

const report = (heuristicLower: number, defaultLower: number): ILeagueEvaluationReport => ({
    schemaVersion: 1,
    status: "measurement_only",
    generatedAt: "2026-07-11T00:00:00.000Z",
    candidateId: "candidate",
    totalGames: 8000,
    options: {
        gamesPerOpponent: 4000,
        baseSeed: 1,
        concurrency: 4,
        fightVersion: "v0.7",
        maxLaps: 60,
        mapTypes: [1],
        freezePerk: true,
        aggregate: "worst-case",
        softminTemperature: 0.025,
        confidenceZ: 1.96,
    },
    opponents: [opponent(DRAFT_SHIP_HEURISTIC_ID, heuristicLower), opponent(DRAFT_SHIP_DEFAULT_ID, defaultLower)],
    aggregate: {
        method: "worst-case",
        fitness: Math.min(heuristicLower, defaultLower),
        worstCaseLowerBound: Math.min(heuristicLower, defaultLower),
        worstCaseOpponent: DRAFT_SHIP_DEFAULT_ID,
        softminLowerBound: Math.min(heuristicLower, defaultLower),
        adversarialMixture: [],
    },
    limitations: [],
    provenance: {
        pickPhase: "common/picks/pick_sim",
        stackAmounts: "LiveTwin expBudget",
        setup: "genome heads; synergies frozen at setup-v0",
        fightVector: "v0.7 both sides",
        uncertainty: "cluster-robust lower bound over four-game offer boards",
        nashQualification: "none",
    },
});

describe("draft ship acceptance", () => {
    it("freezes irrelevant 95-vector heads before constructing evaluator entrants", () => {
        const intrinsicEnd = LEAGUE_GENOME_LAYOUT.draftIntrinsic.offset + LEAGUE_GENOME_LAYOUT.draftIntrinsic.length;
        const changed = [...LEAGUE_ANCHOR_GENOME];
        changed.fill(9999, intrinsicEnd);

        const baseline = draftShipEntrants(createLeagueGenome("candidate", LEAGUE_ANCHOR_GENOME));
        const irrelevantHeadsChanged = draftShipEntrants(createLeagueGenome("candidate", changed));
        expect(irrelevantHeadsChanged.candidate).toEqual(baseline.candidate);
        expect(irrelevantHeadsChanged.pool).toEqual(baseline.pool);
        for (const entrant of [irrelevantHeadsChanged.candidate, ...irrelevantHeadsChanged.pool]) {
            expect(entrant.weights.slice(intrinsicEnd)).toEqual(LEAGUE_ANCHOR_GENOME.slice(intrinsicEnd));
        }
    });

    it("requires both lower-bound gates and fails closed on malformed reports", () => {
        expect(evaluateDraftShipGates(report(0.56, 0.48), DEFAULT_DRAFT_SHIP_GATES).verdict).toBe("PASS");
        expect(evaluateDraftShipGates(report(0.54, 0.48), DEFAULT_DRAFT_SHIP_GATES).verdict).toBe("FAIL");
        expect(evaluateDraftShipGates(report(0.56, 0.46), DEFAULT_DRAFT_SHIP_GATES).verdict).toBe("FAIL");

        const missing = report(0.56, 0.48);
        missing.opponents.pop();
        expect(() => evaluateDraftShipGates(missing, DEFAULT_DRAFT_SHIP_GATES)).toThrow(DRAFT_SHIP_DEFAULT_ID);
        expect(() => evaluateDraftShipGates(report(0.56, 0.48), { vsHeuristic: Number.NaN, vsDefault: 0.47 })).toThrow(
            "finite probability",
        );
    });

    it("parses a strict and bounded CLI contract", () => {
        const parsed = parseDraftShipArgs([
            "--candidate=anchor",
            "--games",
            "12",
            "--seed",
            "7",
            "--concurrency",
            "2",
            "--gate-vs-heuristic",
            "0.6",
        ]);
        expect(parsed).toMatchObject({ games: 12, seed: 7, concurrency: 2, gates: { vsHeuristic: 0.6 } });

        expect(() => parseDraftShipArgs(["--candidate", "anchor", "--games", "10"])).toThrow("multiple of 4");
        expect(() => parseDraftShipArgs(["--candidate", "anchor", "--seed", "-1"])).toThrow("--seed");
        expect(() => parseDraftShipArgs(["--candidate", "anchor", "--concurrency", "0"])).toThrow("--concurrency");
        expect(() => parseDraftShipArgs(["--candidate", "anchor", "--gate-vs-default", "1.1"])).toThrow(
            "finite probability",
        );
        expect(() => parseDraftShipArgs(["--candidate", "anchor", "--wat", "1"])).toThrow("Unknown option");
        expect(() => parseDraftShipArgs(["--candidate", "anchor", "--candidate", "default"])).toThrow(
            "Duplicate option",
        );
    });
});
