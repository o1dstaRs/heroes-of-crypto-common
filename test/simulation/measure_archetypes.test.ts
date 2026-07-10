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

import { describe, expect, test } from "bun:test";

import { ARCHETYPE_NAMES, type IArchetypeMatchOutcome } from "../../src/simulation/archetype_payoff";
import {
    aggregateRecord,
    buildCellJobs,
    cellBaseSeed,
    CHALLENGERS,
    emptyAggregate,
    evaluateKillGate,
    KILL_GATE,
    MELEE_BASELINE,
    oracleCellKey,
    orderedCellKey,
    orderedCells,
    poolVsMelee,
    rateWithSe,
    runJobsSequential,
    type ICellAggregate,
    type IMatrixJob,
} from "../../src/simulation/measure_archetypes";

const GREEN_ALWAYS_WINS = (): IArchetypeMatchOutcome => ({
    winner: "green",
    laps: 5,
    endReason: "elimination",
    attrition: { decidedByArmageddon: false },
});

describe("ordered 5x5 cells", () => {
    test("enumerates all 25 ordered cells with 5 mirror controls and unique ids", () => {
        const cells = orderedCells();
        expect(cells.length).toBe(ARCHETYPE_NAMES.length * ARCHETYPE_NAMES.length);
        expect(new Set(cells.map((cell) => cell.id)).size).toBe(cells.length);
        expect(cells.filter((cell) => cell.control).length).toBe(ARCHETYPE_NAMES.length);
        for (const cell of cells) {
            expect(cell.control).toBe(cell.row === cell.col);
            expect(cell.archetypeA).toBe(cell.row);
            expect(cell.archetypeB).toBe(cell.col);
        }
        expect(cells.some((cell) => cell.row === MELEE_BASELINE && cell.col === MELEE_BASELINE)).toBe(true);
    });

    test("per-cell seed streams are distinct across cells and phases", () => {
        const seeds = new Set<number>();
        let count = 0;
        for (const phase of [1, 2] as const) {
            for (let cellIndex = 0; cellIndex < 32; cellIndex += 1) {
                const seed = cellBaseSeed(1, phase, cellIndex);
                expect(Number.isInteger(seed)).toBe(true);
                expect(seed).toBeGreaterThanOrEqual(0);
                expect(seed).toBeLessThanOrEqual(0xffffffff);
                seeds.add(seed);
                count += 1;
            }
        }
        expect(seeds.size).toBe(count);
        expect(cellBaseSeed(1, 1, 0)).not.toBe(cellBaseSeed(2, 1, 0));
    });
});

describe("paired side-swap accounting", () => {
    function runCell(row: (typeof ARCHETYPE_NAMES)[number], col: (typeof ARCHETYPE_NAMES)[number]): ICellAggregate {
        const key = orderedCellKey(row, col);
        const cell = { id: key, archetypeA: row, archetypeB: col, control: row === col };
        const jobs = buildCellJobs(key, cell, cellBaseSeed(7, 1, 0), 4);
        const aggregates = new Map([[key, emptyAggregate(key, cell, cellBaseSeed(7, 1, 0))]]);
        runJobsSequential(jobs, aggregates, { matchRunner: GREEN_ALWAYS_WINS });
        return aggregates.get(key)!;
    }

    test("a green-biased engine splits slot wins exactly 50/50 (seat bias cancels by construction)", () => {
        const aggregate = runCell(MELEE_BASELINE, "flyer_max");
        expect(aggregate.games).toBe(4);
        expect(aggregate.winsRow).toBe(2);
        expect(aggregate.winsCol).toBe(2);
        expect(aggregate.draws).toBe(0);
        expect(aggregate.greenWins).toBe(4);
        expect(aggregate.redWins).toBe(0);
    });

    test("side-swapped pairs share their combat seed; distinct pairs do not", () => {
        const key = orderedCellKey(MELEE_BASELINE, "anchor");
        const cell = { id: key, archetypeA: MELEE_BASELINE, archetypeB: "anchor" as const, control: false };
        const jobs: IMatrixJob[] = buildCellJobs(key, cell, 12345, 4);
        const seeds: number[] = [];
        const aggregates = new Map([[key, emptyAggregate(key, cell, 12345)]]);
        runJobsSequential(jobs, aggregates, { matchRunner: GREEN_ALWAYS_WINS }, (_job, record) => {
            seeds.push(record.seed);
        });
        expect(seeds[0]).toBe(seeds[1]);
        expect(seeds[2]).toBe(seeds[3]);
        expect(seeds[0]).not.toBe(seeds[2]);
    });

    test("mirror cells field identical rosters on both sides", () => {
        const key = orderedCellKey(MELEE_BASELINE, MELEE_BASELINE);
        const cell = { id: key, archetypeA: MELEE_BASELINE, archetypeB: MELEE_BASELINE, control: true };
        const aggregates = new Map([[key, emptyAggregate(key, cell, 99)]]);
        runJobsSequential(
            buildCellJobs(key, cell, 99, 2),
            aggregates,
            { matchRunner: GREEN_ALWAYS_WINS },
            (_job, record) => {
                expect(record.greenRoster).toBe(record.redRoster);
            },
        );
    });
});

describe("vs-melee pooling", () => {
    test("pools ordered forward, ordered backward and oracle powering cells", () => {
        const challenger = CHALLENGERS[0];
        const aggregates = new Map<string, ICellAggregate>();
        const forwardKey = orderedCellKey(challenger, MELEE_BASELINE);
        const backwardKey = orderedCellKey(MELEE_BASELINE, challenger);
        const oracleKey = oracleCellKey(challenger);
        const mk = (
            key: string,
            a: typeof challenger | typeof MELEE_BASELINE,
            b: typeof challenger | typeof MELEE_BASELINE,
        ) => emptyAggregate(key, { id: key, archetypeA: a, archetypeB: b, control: false }, 1);
        const forward = mk(forwardKey, challenger, MELEE_BASELINE);
        forward.games = 10;
        forward.winsRow = 6; // challenger wins as slot A
        forward.winsCol = 3;
        forward.draws = 1;
        const backward = mk(backwardKey, MELEE_BASELINE, challenger);
        backward.games = 10;
        backward.winsRow = 4;
        backward.winsCol = 5; // challenger wins as slot B
        backward.draws = 1;
        const oracle = mk(oracleKey, challenger, MELEE_BASELINE);
        oracle.games = 20;
        oracle.winsRow = 12;
        oracle.winsCol = 8;
        aggregates.set(forwardKey, forward);
        aggregates.set(backwardKey, backward);
        aggregates.set(oracleKey, oracle);
        const pooled = poolVsMelee(aggregates, challenger);
        expect(pooled.wins).toBe(6 + 5 + 12);
        expect(pooled.decisive).toBe(9 + 9 + 20);
        expect(pooled.games).toBe(40);
        expect(pooled.rate).toBeCloseTo(23 / 38, 12);
    });

    test("rateWithSe is binomial and defends the empty cell", () => {
        expect(rateWithSe(500, 1000).rate).toBeCloseTo(0.5, 12);
        expect(rateWithSe(500, 1000).sePp).toBeCloseTo(100 * Math.sqrt(0.25 / 1000), 9);
        expect(rateWithSe(0, 0).rate).toBe(0.5);
        expect(rateWithSe(0, 0).sePp).toBe(Number.POSITIVE_INFINITY);
    });
});

describe("registered kill gate", () => {
    const base = {
        bestChallenger: "ranged_max_sniper3" as const,
        bestChallengerDecisiveGames: 4000,
        oracleDecisiveGames: 9500,
        oracleGames: 10000,
    };

    test("PASS when a challenger reaches 55% regardless of the oracle", () => {
        const verdict = evaluateKillGate({ ...base, bestChallengerRate: 0.57, oracleWinRate: 0.51 });
        expect(verdict.verdict).toBe("PASS");
        expect(verdict.challengerAtOrAboveThreshold).toBe(true);
    });

    test("PASS when only the oracle clears +3pp (challenger between 53% and 55%)", () => {
        const verdict = evaluateKillGate({ ...base, bestChallengerRate: 0.539, oracleWinRate: 0.539 });
        expect(verdict.verdict).toBe("PASS");
        expect(verdict.challengerAtOrAboveThreshold).toBe(false);
        expect(verdict.oracleGainPp).toBeCloseTo(3.9, 9);
    });

    test("KILL only when both survival conditions fail", () => {
        const verdict = evaluateKillGate({ ...base, bestChallengerRate: 0.52, oracleWinRate: 0.52 });
        expect(verdict.verdict).toBe("KILL");
        expect(verdict.oracleGainAtOrAboveThreshold).toBe(false);
        expect(verdict.reason).toContain("< +3pp");
    });

    test("flags an underpowered oracle sample", () => {
        const verdict = evaluateKillGate({
            ...base,
            oracleGames: KILL_GATE.minOracleGames - 1,
            bestChallengerRate: 0.52,
            oracleWinRate: 0.52,
        });
        expect(verdict.oracleAdequatelyPowered).toBe(false);
    });

    test("thresholds match the registered gate", () => {
        expect(KILL_GATE.challengerWinRateThreshold).toBe(0.55);
        expect(KILL_GATE.oracleGainThresholdPp).toBe(3);
        expect(KILL_GATE.minOracleGames).toBe(5000);
    });
});

describe("record aggregation", () => {
    test("winner slots, seats, draws and end reasons fold into the aggregate", () => {
        const key = orderedCellKey(MELEE_BASELINE, "hybrid");
        const aggregate = emptyAggregate(
            key,
            { id: key, archetypeA: MELEE_BASELINE, archetypeB: "hybrid", control: false },
            1,
        );
        const record = {
            cellId: key,
            game: 0,
            seed: 1,
            greenSlot: "a" as const,
            greenArchetype: MELEE_BASELINE,
            redArchetype: "hybrid" as const,
            greenRoster: "L1:Ax1",
            redRoster: "L1:Bx1",
            winnerSide: "green" as const,
            winnerSlot: "a" as const,
            laps: 7,
            endReason: "elimination" as const,
            decidedByArmageddon: false,
            hybridRosterBuilds: 1,
            hybridRoleFallbacks: 2,
        };
        aggregateRecord(aggregate, record);
        aggregateRecord(aggregate, { ...record, winnerSlot: "draw", winnerSide: "draw", decidedByArmageddon: true });
        expect(aggregate.games).toBe(2);
        expect(aggregate.winsRow).toBe(1);
        expect(aggregate.winsCol).toBe(0);
        expect(aggregate.draws).toBe(1);
        expect(aggregate.greenWins).toBe(1);
        expect(aggregate.armageddonDecided).toBe(1);
        expect(aggregate.hybridRoleFallbacks).toBe(4);
        expect(aggregate.endReasons.elimination).toBe(2);
    });
});
