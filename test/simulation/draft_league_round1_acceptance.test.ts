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

import { describe, expect, it } from "bun:test";

import leagueRound1Artifact from "../../src/ai/setup/draft_genomes/league_round1_br_57de5a2d_candidate.json";
import acceptance from "../../src/simulation/results/draft_league_round1_v0_7_acceptance.json";
import { clusteredLowerBound, type ILeagueGameRecord } from "../../src/simulation/league_eval";
import { pairedClusterEstimate } from "../../src/simulation/measure_setup_conditional";

type CandidateResult = ILeagueGameRecord["candidateResult"];
type AcceptanceCell = (typeof acceptance.perSeed)[number];

const recordsFromHistogram = (cell: AcceptanceCell, boardOffset: number): ILeagueGameRecord[] => {
    const records: ILeagueGameRecord[] = [];
    let board = boardOffset;
    const add = (result: CandidateResult, count: number): void => {
        for (let index = 0; index < count; index += 1) {
            records.push({ candidateResult: result, offerBoard: board } as ILeagueGameRecord);
        }
    };
    for (const [wins, losses, draws, count] of cell.clusterHistogram) {
        for (let repeat = 0; repeat < count; repeat += 1) {
            add("win", wins);
            add("loss", losses);
            add("draw", draws);
            board += 1;
        }
    }
    return records;
};

const resultCounts = (records: readonly ILeagueGameRecord[]): { wins: number; losses: number; draws: number } => ({
    wins: records.filter(({ candidateResult }) => candidateResult === "win").length,
    losses: records.filter(({ candidateResult }) => candidateResult === "loss").length,
    draws: records.filter(({ candidateResult }) => candidateResult === "draw").length,
});

describe("accepted League round-1 draft evidence", () => {
    it("reproduces every per-seed and pooled clustered lower bound from compact board evidence", () => {
        for (const cell of acceptance.perSeed) {
            const records = recordsFromHistogram(cell, 0);
            expect(records).toHaveLength(cell.games);
            expect(resultCounts(records)).toEqual({ wins: cell.wins, losses: cell.losses, draws: cell.draws });
            expect(clusteredLowerBound(records, 1.96)).toBe(cell.clusteredLowerBound);
            expect(cell.passed).toBe(true);
        }

        for (const pooled of acceptance.pooled) {
            const cells = acceptance.perSeed.filter(({ opponentId }) => opponentId === pooled.opponentId);
            const records = cells.flatMap((cell, index) => recordsFromHistogram(cell, index * 1_000_000));
            expect(records).toHaveLength(pooled.games);
            expect(resultCounts(records)).toEqual({ wins: pooled.wins, losses: pooled.losses, draws: pooled.draws });
            expect(new Set(records.map(({ offerBoard }) => offerBoard)).size).toBe(pooled.offerBoardClusters);
            expect(clusteredLowerBound(records, 1.96)).toBe(pooled.clusteredLowerBound);
            expect(pooled.clusteredLowerBound).toBeGreaterThanOrEqual(pooled.gate);
            expect(pooled.passed).toBe(true);
        }
    });

    it("reproduces the powered setup-interaction non-regression gate", () => {
        const interaction = acceptance.setupInteraction;
        const estimate = pairedClusterEstimate(interaction.winsOn, interaction.winsOff, interaction.pairMoments);

        expect(estimate.gainPp).toBe(interaction.gainPp);
        expect(estimate.standardErrorPp).toBe(interaction.standardErrorPp);
        expect(estimate.confidence95LowGainPp).toBe(interaction.confidence95LowGainPp);
        expect((estimate.confidence95!.high - 0.5) * 100).toBeCloseTo(interaction.confidence95HighGainPp, 12);
        expect(interaction.confidence95LowGainPp).toBeGreaterThanOrEqual(interaction.nonRegressionFloorPp);
        expect(interaction.passed).toBe(true);
    });

    it("pins the corrected preregistration and accepted artifact without claiming a deploy", () => {
        const reportSha256 = createHash("sha256")
            .update(
                readFileSync(
                    new URL("../../src/simulation/results/draft_league_round1_v0_7_acceptance.json", import.meta.url),
                ),
            )
            .digest("hex");

        expect(acceptance.preregistration.recordedBeforeFirstResult).toBe(true);
        expect(acceptance.preregistration.historicalCorrection).toContain("That is false");
        expect(acceptance.execution.recordReplay.determinismCheckAgainstOfficialCliReports).toBe("MATCH (exact)");
        expect(acceptance.verdict).toBe("PASS");
        expect(reportSha256).toBe(leagueRound1Artifact.acceptance.reportSha256);
        expect(leagueRound1Artifact.authority).toEqual({
            researchOnly: false,
            acceptedForRankedOptIn: true,
            eligibleForDefaultReview: true,
            defaultChanged: false,
            productionEnabled: false,
            deployAuthorization: false,
        });
    });
});
