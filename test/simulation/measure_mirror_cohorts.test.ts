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

import {
    aggregateMirrorDiag,
    buildMirrorRoster,
    mirrorGameSeed,
    playMirrorGame,
    PURE_RANGED_ROSTER_NAMES,
    summarizeMirrorRecords,
    type IMirrorGameRecord,
    type IMirrorRunConfig,
} from "../../src/simulation/measure_mirror_cohorts";
import type { IMatchConfig, IMatchResult, IRecordedAction } from "../../src/simulation/battle_engine";

const BASE_CFG: IMirrorRunConfig = {
    cohort: "ranged_max_sniper3",
    games: 4,
    seed: 7803710,
    vA: "v0.7",
    vB: "v0.6",
    amountMode: "expBudget",
    livetwin: true,
    diag: false,
    zeroScorer: false,
};

function fakeResult(
    config: IMatchConfig,
    winner: IMatchResult["winner"],
    actions: IRecordedAction[] = [],
): IMatchResult {
    return {
        seed: config.seed,
        gridType: config.gridType ?? 1,
        winner,
        endReason: "elimination",
        laps: 5,
        totalActions: actions.length,
        roster: config.roster,
        placements: { green: [], red: [] },
        actions,
        outcome: {
            green: { version: config.greenVersion, unitsAlive: 1, creaturesAlive: 1, hpRemaining: 1 },
            red: { version: config.redVersion, unitsAlive: 0, creaturesAlive: 0, hpRemaining: 0 },
        },
        attrition: {
            reachedArmageddon: false,
            armageddonWaves: 0,
            unitsKilledByArmageddon: 0,
            unitsKilledByNarrowing: 0,
            decidedByArmageddon: false,
        },
    };
}

function recordedAction(
    index: number,
    actionType: IRecordedAction["actionType"],
    side: IRecordedAction["side"],
    unitId: string,
    lap: number,
    damage?: number,
    completed = true,
): IRecordedAction {
    return {
        index,
        lap,
        side,
        unitId,
        creatureName: "Arbalester",
        fromCell: { x: 0, y: 0 },
        actionType,
        completed,
        ...(damage === undefined ? {} : { damage }),
    };
}

describe("measure_mirror_cohorts", () => {
    test("paired games share the seed and swap which seat runs version A", () => {
        expect(mirrorGameSeed(BASE_CFG.seed, 0)).toBe(mirrorGameSeed(BASE_CFG.seed, 1));
        expect(mirrorGameSeed(BASE_CFG.seed, 2)).toBe(mirrorGameSeed(BASE_CFG.seed, 3));
        expect(mirrorGameSeed(BASE_CFG.seed, 0)).not.toBe(mirrorGameSeed(BASE_CFG.seed, 2));

        const configs: IMatchConfig[] = [];
        const matchRunner = (config: IMatchConfig): IMatchResult => {
            configs.push(config);
            return fakeResult(config, "green");
        };
        const first = playMirrorGame(BASE_CFG, 0, { matchRunner });
        const second = playMirrorGame(BASE_CFG, 1, { matchRunner });
        expect(first.seed).toBe(second.seed);
        expect(configs[0].greenVersion).toBe("v0.7");
        expect(configs[0].redVersion).toBe("v0.6");
        expect(configs[1].greenVersion).toBe("v0.6");
        expect(configs[1].redVersion).toBe("v0.7");
        // Green won both fakes: game 0 credits vA, game 1 credits vB.
        expect(first.winnerVersion).toBe("v0.7");
        expect(second.winnerVersion).toBe("v0.6");
    });

    test("both seats field the identical symmetric roster", () => {
        let observed: IMatchConfig | undefined;
        const matchRunner = (config: IMatchConfig): IMatchResult => {
            observed = config;
            return fakeResult(config, "draw");
        };
        playMirrorGame(BASE_CFG, 0, { matchRunner });
        expect(observed).toBeDefined();
        const sig = (roster: IMatchConfig["roster"]): string[] =>
            roster.map((u) => `L${u.level}:${u.creatureName}x${u.amount}`);
        expect(sig(observed!.redRoster!)).toEqual(sig(observed!.roster));
        expect(observed!.roster).not.toBe(observed!.redRoster);
    });

    test("pure_ranged is the fixed 6/6 shooter roster and amount modes change only stack sizes", () => {
        const exp = buildMirrorRoster("pure_ranged", 1, "expBudget");
        const table = buildMirrorRoster("pure_ranged", 999, "levelTable");
        expect(exp.map((u) => u.creatureName)).toEqual(PURE_RANGED_ROSTER_NAMES.map((u) => u.creatureName));
        expect(table.map((u) => u.creatureName)).toEqual(exp.map((u) => u.creatureName));
        // levelTable = the historical {50,30,15,8} per-level sizes.
        expect(table.map((u) => u.amount)).toEqual([50, 50, 30, 30, 15, 8]);
        // expBudget differs from the level table for at least one stack (live ceil(1000/exp) rule).
        expect(exp.map((u) => u.amount)).not.toEqual(table.map((u) => u.amount));
    });

    test("diagnostics aggregate only completed adjacent same-unit same-side same-lap move-shots by version", () => {
        const actions: IRecordedAction[] = [
            recordedAction(0, "move_unit", "green", "green-valid", 1),
            recordedAction(1, "range_attack", "green", "green-valid", 1, 40),
            recordedAction(2, "move_unit", "green", "interrupted", 1),
            recordedAction(3, "defend_turn", "green", "interrupted", 1),
            recordedAction(4, "range_attack", "green", "interrupted", 1, 99),
            recordedAction(5, "move_unit", "green", "cross-lap", 1),
            recordedAction(6, "range_attack", "green", "cross-lap", 2, 88),
            recordedAction(7, "move_unit", "red", "cross-side", 2),
            recordedAction(8, "range_attack", "green", "cross-side", 2, 77),
            recordedAction(9, "move_unit", "red", "incomplete", 3, undefined, false),
            recordedAction(10, "range_attack", "red", "incomplete", 3, 66),
            recordedAction(11, "move_unit", "red", "red-valid", 4),
            recordedAction(12, "range_attack", "red", "red-valid", 4, 30),
            recordedAction(13, "move_unit", "green", "unit-a", 5),
            recordedAction(14, "range_attack", "green", "unit-b", 5, 55),
        ];
        const cfg = { ...BASE_CFG, diag: true };
        const matchRunner = (config: IMatchConfig): IMatchResult => fakeResult(config, "draw", actions);
        const first = playMirrorGame(cfg, 0, { matchRunner });
        const swapped = playMirrorGame(cfg, 1, { matchRunner });

        expect(first.diag?.green.moveShotSequences).toBe(1);
        expect(first.diag?.green.moveShotRangeDamage).toBe(40);
        expect(first.diag?.red.moveShotSequences).toBe(1);
        expect(first.diag?.red.moveShotRangeDamage).toBe(30);

        const aggregate = aggregateMirrorDiag([first, swapped], cfg) as {
            versions: Record<
                string,
                {
                    games: number;
                    moveShotSequences: number;
                    moveShotSequencesPerGame: number;
                    moveShotRangeDamage: number;
                    moveShotRangeDamagePerGame: number;
                    meanMoveShotRangeDamage: number | null;
                }
            >;
        };
        for (const version of [cfg.vA, cfg.vB]) {
            expect(aggregate.versions[version]).toMatchObject({
                games: 2,
                moveShotSequences: 2,
                moveShotSequencesPerGame: 1,
                moveShotRangeDamage: 70,
                moveShotRangeDamagePerGame: 35,
                meanMoveShotRangeDamage: 35,
            });
        }
    });

    test("summary tallies wins per version with a binomial SE over decisive games", () => {
        const records: IMirrorGameRecord[] = [
            { winnerVersion: "v0.7", endReason: "elimination" },
            { winnerVersion: "v0.7", endReason: "elimination" },
            { winnerVersion: "v0.7", endReason: "elimination" },
            { winnerVersion: "v0.6", endReason: "elimination" },
            { winnerVersion: "draw", endReason: "turn_cap" },
        ].map((partial, index) => ({
            game: index,
            seed: mirrorGameSeed(BASE_CFG.seed, index),
            greenVersion: index % 2 === 0 ? "v0.7" : "v0.6",
            laps: 5,
            armageddon: false,
            rejectedGreen: 0,
            rejectedRed: 0,
            ...partial,
        })) as IMirrorGameRecord[];
        const summary = summarizeMirrorRecords(records, BASE_CFG);
        expect(summary.winsA).toBe(3);
        expect(summary.winsB).toBe(1);
        expect(summary.draws).toBe(1);
        expect(summary.decisive).toBe(4);
        expect(summary.winRateA).toBeCloseTo(0.75, 10);
        expect(summary.sePp).toBeCloseTo(100 * Math.sqrt((0.75 * 0.25) / 4), 10);
        expect(summary.deltaFromParityPp).toBeCloseTo(25, 10);
        expect(summary.endReasons).toEqual({ elimination: 4, turn_cap: 1 });
    });
});
