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
    cellBaseSeed,
    defaultCells,
    emptyTally,
    evaluateGate,
    pairedClusterEstimate,
    summarizeTally,
    tallyRecord,
    validateIndependentSetupConditionalReplications,
    validateSetupConditionalSeedStreams,
    type IMeasureSetupConditionalSummary,
    type ISetupConditionalCell,
    type ISetupConditionalCellSummary,
    type ISetupConditionalPairMoments,
    type ISetupConditionalRecord,
} from "../../src/simulation/measure_setup_conditional";

const record = (
    cell: ISetupConditionalCell,
    baseSeed: number,
    game: number,
    overrides: Partial<ISetupConditionalRecord> = {},
): ISetupConditionalRecord => ({
    cellId: cell.id,
    game,
    seed: ((baseSeed >>> 0) + Math.floor(game / 2) * 0x9e3779b1) >>> 0,
    aIsLower: game % 2 === 0,
    winnerSlot: game % 2 === 0 ? "a" : "b",
    laps: 10,
    endReason: "elimination",
    decidedByArmageddon: false,
    rejectedA: 0,
    rejectedB: 0,
    aRangedStacks: game % 2 === 0 ? 2 : 3,
    bRangedStacks: game % 2 === 0 ? 3 : 2,
    aT2Overridden: false,
    aAugmentsOverridden: false,
    ...overrides,
});

const decisivePairMoments = (winsA: number, games = 4000): ISetupConditionalPairMoments => {
    const clusters = games / 2;
    const bothAWins = Math.max(0, winsA - clusters);
    const splitPairs = winsA - 2 * bothAWins;
    return {
        clusters,
        sumWinSquared: 4 * bothAWins + splitPairs,
        sumWinDecisive: 2 * winsA,
        sumDecisiveSquared: 4 * clusters,
    };
};

const cellSummary = (
    cell: ISetupConditionalCell,
    index: number,
    winsA = cell.control ? 2000 : 2400,
    drawOrArmageddon = 160,
): ISetupConditionalCellSummary => {
    const games = 4000;
    const winsB = games - winsA;
    const pairMoments = decisivePairMoments(winsA, games);
    const estimate = pairedClusterEstimate(winsA, winsB, pairMoments);
    return {
        id: cell.id,
        draft: cell.draft,
        rules: cell.rules,
        control: cell.control,
        baseSeed: cellBaseSeed(1, index),
        expectedGames: games,
        games,
        winsA,
        winsB,
        decisive: games,
        draws: 0,
        winRateA: estimate.winRate,
        clusteredSePp: estimate.standardErrorPp,
        confidence95: estimate.confidence95,
        confidence95LowGainPp: estimate.confidence95LowGainPp,
        pairMoments,
        gainPp: estimate.gainPp,
        avgLaps: 10,
        endReasons: { elimination: games },
        armageddonDecided: drawOrArmageddon,
        drawOrArmageddon,
        drawOrArmageddonRate: drawOrArmageddon / games,
        rejectedA: 0,
        rejectedB: 0,
        recordsMissingRejectionCounts: 0,
        aRangedStacksPerGame: 2,
        bRangedStacksPerGame: 2,
        t2OverrideRate: cell.control ? 0 : 0.25,
        augmentsOverrideRate: cell.control ? 0 : 0.25,
        controlInvariantPassed: cell.control,
    };
};

const poweredCells = (): ISetupConditionalCellSummary[] =>
    defaultCells().map((cell, index) => cellSummary(cell, index, undefined, cell.id.endsWith("__all") ? 180 : 160));

const document = (replicationId: string, baseSeed: number): IMeasureSetupConditionalSummary => {
    const cells = poweredCells().map((cell, index) => ({ ...cell, baseSeed: cellBaseSeed(baseSeed, index) }));
    return {
        schemaVersion: 2,
        kind: "conditional_setup_v1_ab",
        fightVersion: "v0.7",
        startedAt: "2026-07-15T00:00:00.000Z",
        wallSeconds: 1,
        gamesPerSecond: 48_000,
        config: {
            liveTwinEnv: "1",
            amountMode: "expBudget",
            grid: "NORMAL",
            leagueGenomeSpec: "league-r3-br-52752642",
            gamesPerCell: 4000,
            baseSeed,
            replicationId,
            concurrency: 12,
            totalGames: 48_000,
            pairing: { clusterSize: 2, sharedOfferAndCombatSeed: true, armsSwapPickSeats: true },
        },
        cells,
        gate: evaluateGate(cells),
    };
};

describe("setup-conditional record integrity", () => {
    it("requires every frozen-control pair to be an exact seat swap", () => {
        const cell = defaultCells()[0];
        const baseSeed = cellBaseSeed(7, 0);
        const tally = emptyTally(cell, baseSeed, 2);
        tallyRecord(tally, record(cell, baseSeed, 0));
        tallyRecord(tally, record(cell, baseSeed, 1));

        const summary = summarizeTally(tally);
        expect(summary.controlInvariantPassed).toBe(true);
        expect(summary.winsA).toBe(1);
        expect(summary.winsB).toBe(1);
        expect(summary.rejectedA).toBe(0);
        expect(summary.rejectedB).toBe(0);

        const allDraws = emptyTally(cell, baseSeed, 2);
        tallyRecord(allDraws, record(cell, baseSeed, 0, { winnerSlot: "draw" }));
        tallyRecord(allDraws, record(cell, baseSeed, 1, { winnerSlot: "draw" }));
        expect(summarizeTally(allDraws).controlInvariantPassed).toBe(false);

        const broken = emptyTally(cell, baseSeed, 2);
        tallyRecord(broken, record(cell, baseSeed, 0));
        expect(() => tallyRecord(broken, record(cell, baseSeed, 1, { winnerSlot: "a" }))).toThrow("exact seat swap");
    });

    it("rejects duplicate, out-of-stream, and incomplete records", () => {
        const cell = defaultCells()[1];
        const baseSeed = cellBaseSeed(7, 1);
        const tally = emptyTally(cell, baseSeed, 2);
        const first = record(cell, baseSeed, 0);
        tallyRecord(tally, first);
        expect(() => tallyRecord(tally, first)).toThrow("duplicate game");
        expect(() => tallyRecord(emptyTally(cell, baseSeed, 2), { ...first, seed: first.seed + 1 })).toThrow(
            "does not match",
        );
        expect(() => summarizeTally(tally)).toThrow("1/2 unique games");
    });

    it("counts draw-or-Armageddon as a union and fails missing rejection telemetry closed", () => {
        const cell = defaultCells()[1];
        const baseSeed = cellBaseSeed(7, 1);
        const tally = emptyTally(cell, baseSeed, 2);
        tallyRecord(
            tally,
            record(cell, baseSeed, 0, {
                winnerSlot: "draw",
                decidedByArmageddon: true,
                rejectedA: undefined,
                rejectedB: 2,
            }),
        );
        tallyRecord(tally, record(cell, baseSeed, 1));
        const summary = summarizeTally(tally);
        expect(summary.drawOrArmageddon).toBe(1);
        expect(summary.armageddonDecided).toBe(1);
        expect(summary.recordsMissingRejectionCounts).toBe(1);
        expect(summary.rejectedB).toBe(2);
    });
});

describe("setup-conditional acceptance gate", () => {
    it("uses paired-cluster sandwich uncertainty and requires powered LCBs", () => {
        const moments = decisivePairMoments(2400);
        const estimate = pairedClusterEstimate(2400, 1600, moments);
        expect(estimate.gainPp).toBeCloseTo(10);
        expect(estimate.standardErrorPp).toBeGreaterThan(0);
        expect(estimate.confidence95LowGainPp).toBeLessThan(estimate.gainPp);

        const cells = poweredCells();
        expect(evaluateGate(cells).verdict).toBe("PASS");

        const weak = cells.map((cell) => ({ ...cell, pairMoments: { ...cell.pairMoments } }));
        const index = weak.findIndex((cell) => cell.id === "heuristic__all");
        weak[index] = { ...cellSummary(defaultCells()[1], 1, 1980, 180), confidence95LowGainPp: 99 };
        const verdict = evaluateGate(weak);
        expect(verdict.verdict).toBe("FAIL");
        expect(verdict.checks.confidence).toBe(false);
        expect(verdict.worstHeadlineCell?.confidence95LowGainPp).not.toBe(99);

        const underpowered = poweredCells().map((cell) => ({ ...cell, expectedGames: 3998 }));
        expect(evaluateGate(underpowered).checks.powered).toBe(false);
    });

    it("permits baseline attrition but rejects an all-rules candidate over +1pp versus its matched control", () => {
        const cells = poweredCells();
        const pass = evaluateGate(cells);
        expect(pass.verdict).toBe("PASS");
        expect(pass.maximumDrawOrArmageddonRate).toBe(0.045);
        expect(pass.maximumMatchedDrawOrArmageddonExcessPp).toBeCloseTo(0.5);
        expect(pass.matchedAttrition).toHaveLength(3);

        const ranged = cells.find((cell) => cell.id === "ranged__all")!;
        ranged.armageddonDecided = 201;
        ranged.drawOrArmageddon = 201;
        ranged.drawOrArmageddonRate = 201 / ranged.games;
        const fail = evaluateGate(cells);
        expect(fail.verdict).toBe("FAIL");
        expect(fail.checks.integrity).toBe(false);
        expect(fail.maximumMatchedDrawOrArmageddonExcessPp).toBeCloseTo(1.025);
    });

    it("rejects nonzero or missing action-rejection instrumentation", () => {
        const rejected = poweredCells();
        rejected[1].rejectedA = 1;
        expect(evaluateGate(rejected).checks.integrity).toBe(false);

        const missing = poweredCells();
        missing[1].recordsMissingRejectionCounts = 1;
        expect(evaluateGate(missing).checks.integrity).toBe(false);
    });
});

describe("setup-conditional seed identity", () => {
    it("rejects duplicate cells before launching workers", () => {
        const cells = defaultCells();
        expect(() => validateSetupConditionalSeedStreams([cells[0], cells[0]], 4000, 1)).toThrow("Duplicate");
        expect(() => validateSetupConditionalSeedStreams([], 4000, 1)).toThrow("at least one cell");
        expect(() => validateSetupConditionalSeedStreams(cells, 3999, 1)).toThrow("positive even");
    });

    it("proves replication IDs and paired seed streams are independent", () => {
        expect(() =>
            validateIndependentSetupConditionalReplications([document("rep-a", 1), document("rep-b", 101)]),
        ).not.toThrow();
        expect(() =>
            validateIndependentSetupConditionalReplications([document("rep-a", 1), document("rep-a", 101)]),
        ).toThrow("Duplicate setup-conditional replication id");
        expect(() =>
            validateIndependentSetupConditionalReplications([document("rep-a", 1), document("rep-b", 2)]),
        ).toThrow("overlaps");

        const duplicateCell = document("rep-c", 3);
        duplicateCell.cells.push({ ...duplicateCell.cells[0], baseSeed: cellBaseSeed(99, 0) });
        expect(() => validateIndependentSetupConditionalReplications([duplicateCell])).toThrow(
            "Duplicate setup-conditional cell",
        );
    });
});
