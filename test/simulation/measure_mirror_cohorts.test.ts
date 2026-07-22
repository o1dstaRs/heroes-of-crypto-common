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

import type { IAIPolicyEvent, IV08SupportedPrepinEgressDetails } from "../../src/ai";
import {
    aggregateMirrorDiag,
    buildMirrorRoster,
    mirrorGameSeed,
    mirrorWorkerGameIndex,
    playMirrorGame,
    PURE_RANGED_ROSTER_NAMES,
    summarizeMirrorRecords,
    type IMirrorGameRecord,
    type IMirrorRunConfig,
} from "../../src/simulation/measure_mirror_cohorts";
import {
    GREEN_TEAM,
    RED_TEAM,
    type IMatchConfig,
    type IMatchResult,
    type IRecordedAction,
} from "../../src/simulation/battle_engine";

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

const PREPIN_DETAILS: IV08SupportedPrepinEgressDetails = {
    fromCell: { x: 0, y: 1 },
    toCell: { x: 0, y: 0 },
    targetId: "target",
    targetCreatureName: "Shot target",
    exposureBefore: 1,
    exposureAfter: 0,
    divisorBefore: 1,
    divisorAfter: 1,
    targetDistanceBefore: 9,
    targetDistanceAfter: 10,
    minEnemyDistanceBefore: 4,
    minEnemyDistanceAfter: 5,
    rangedSuperior: true,
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
    impactDamage?: number,
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
        ...(impactDamage === undefined ? {} : { impactDamage }),
    };
}

describe("measure_mirror_cohorts", () => {
    test("pins every game to a deterministic worker lane instead of completion-order dispatch", () => {
        const games = 10;
        const concurrency = 3;
        const lanes = Array.from({ length: concurrency }, (_, workerIndex) => {
            const lane: number[] = [];
            for (let dispatched = 0; ; dispatched += 1) {
                const game = mirrorWorkerGameIndex(workerIndex, dispatched, concurrency);
                if (game >= games) break;
                lane.push(game);
            }
            return lane;
        });

        expect(lanes).toEqual([
            [0, 3, 6, 9],
            [1, 4, 7],
            [2, 5, 8],
        ]);
        expect(lanes.flat().sort((left, right) => left - right)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        expect(() => mirrorWorkerGameIndex(3, 0, concurrency)).toThrow(RangeError);
    });

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
            // Through Shot/AOE keeps the legacy visible primary at zero and records real impacts separately.
            recordedAction(1, "range_attack", "green", "green-valid", 1, 0, true, 40),
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
        const matchRunner = (config: IMatchConfig): IMatchResult => {
            config.policyProposalObserver?.({
                kind: "v0.8_response_neutral_advance",
                unitId: "green-proposal",
                creatureName: "Arbalester",
                team: GREEN_TEAM,
                lap: 1,
            });
            config.policyProposalObserver?.({
                kind: "v0.8_supported_ranged_escape",
                unitId: "red-proposal",
                creatureName: "Arbalester",
                team: RED_TEAM,
                lap: 4,
            });
            config.policyEventObserver?.({
                kind: "v0.8_response_neutral_advance",
                unitId: "green-valid",
                creatureName: "Arbalester",
                team: GREEN_TEAM,
                lap: 1,
            });
            config.policyEventObserver?.({
                kind: "v0.8_supported_ranged_escape",
                unitId: "red-valid",
                creatureName: "Arbalester",
                team: RED_TEAM,
                lap: 4,
            });
            return fakeResult(config, "draw", actions);
        };
        const first = playMirrorGame(cfg, 0, { matchRunner });
        const swapped = playMirrorGame(cfg, 1, { matchRunner });

        expect(first.diag?.green.moveShotSequences).toBe(1);
        expect(first.diag?.green.moveShotRangeDamage).toBe(40);
        expect(first.diag?.red.moveShotSequences).toBe(1);
        expect(first.diag?.red.moveShotRangeDamage).toBe(30);
        expect(first.diag?.green.responseNeutralAdvances).toBe(1);
        expect(first.diag?.red.supportedRangedEscapes).toBe(1);
        expect(first.diag?.green.responseNeutralAdvanceProposals).toBe(1);
        expect(first.diag?.red.supportedRangedEscapeProposals).toBe(1);
        expect(first.diag?.green.supportedPrepinEgressSelections).toBe(0);
        expect(first.diag?.red.supportedPrepinEgressProposals).toBe(0);
        expect(first.supportedPrepinEgressEvents).toBeUndefined();

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
                    supportedRangedEscapes: number;
                    supportedRangedEscapeProposals: number;
                    responseNeutralAdvances: number;
                    responseNeutralAdvanceProposals: number;
                    supportedPrepinEgressSelections: number;
                    supportedPrepinEgressProposals: number;
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
                supportedRangedEscapes: 1,
                supportedRangedEscapeProposals: 1,
                responseNeutralAdvances: 1,
                responseNeutralAdvanceProposals: 1,
                supportedPrepinEgressSelections: 0,
                supportedPrepinEgressProposals: 0,
            });
        }
    });

    test("separates pre-pin egress proposals from retained selections and keeps the control at zero", () => {
        const cfg: IMirrorRunConfig = { ...BASE_CFG, vA: "v0.8", vB: "v0.8s", diag: true };
        const matchRunner = (config: IMatchConfig): IMatchResult => {
            const candidateTeam = config.greenVersion === "v0.8" ? GREEN_TEAM : RED_TEAM;
            for (const stage of ["ordinary_shot", "eligible_shooter", "future_exposure"] as const) {
                config.policyProposalObserver?.({
                    kind: "v0.8_supported_prepin_egress_funnel",
                    unitId: `candidate-${stage}`,
                    creatureName: "Arbalester",
                    team: candidateTeam,
                    lap: 3,
                    stage,
                });
            }
            const proposals: IAIPolicyEvent[] = ["candidate-proposal-a", "candidate-proposal-b"].map((unitId) => ({
                kind: "v0.8_supported_prepin_egress",
                unitId,
                creatureName: "Arbalester",
                team: candidateTeam,
                lap: 3,
                details: {
                    ...PREPIN_DETAILS,
                    fromCell: { ...PREPIN_DETAILS.fromCell },
                    toCell: { ...PREPIN_DETAILS.toCell },
                },
            }));
            for (const proposal of proposals) {
                config.policyProposalObserver?.(proposal);
            }
            config.policyEventObserver?.(proposals[0]);
            return fakeResult(config, "draw");
        };
        const records = [playMirrorGame(cfg, 0, { matchRunner }), playMirrorGame(cfg, 1, { matchRunner })];

        for (const record of records) {
            const diag = record.diag!;
            const candidate = diag.green.version === "v0.8" ? diag.green : diag.red;
            const control = diag.green.version === "v0.8s" ? diag.green : diag.red;
            expect(candidate.supportedPrepinEgressProposals).toBe(2);
            expect(candidate.supportedPrepinEgressSelections).toBe(1);
            expect(candidate.supportedPrepinEgressFunnel).toMatchObject({
                ordinary_shot: 1,
                eligible_shooter: 1,
                future_exposure: 1,
                native_guard: 0,
            });
            expect(control.supportedPrepinEgressProposals).toBe(0);
            expect(control.supportedPrepinEgressSelections).toBe(0);
            expect(Object.values(control.supportedPrepinEgressFunnel).every((count) => count === 0)).toBe(true);
            expect(record.supportedPrepinEgressEvents).toHaveLength(candidate.supportedPrepinEgressProposals);
            expect(record.supportedPrepinEgressEvents?.filter(({ retained }) => retained)).toHaveLength(
                candidate.supportedPrepinEgressSelections,
            );
            expect(record.supportedPrepinEgressEvents?.map(({ retained }) => retained)).toEqual([true, false]);
            expect(record.supportedPrepinEgressEvents?.[0]).toMatchObject({
                ...PREPIN_DETAILS,
                side: record.greenVersion === "v0.8" ? "green" : "red",
                unitId: "candidate-proposal-a",
                creatureName: "Arbalester",
                lap: 3,
                retained: true,
            });
        }
        expect(records[0].supportedPrepinEgressEvents?.[0].side).toBe("green");
        expect(records[1].supportedPrepinEgressEvents?.[0].side).toBe("red");

        const aggregate = aggregateMirrorDiag(records, cfg) as {
            versions: Record<
                string,
                {
                    supportedPrepinEgressSelections: number;
                    supportedPrepinEgressSelectionsPerGame: number;
                    supportedPrepinEgressProposals: number;
                    supportedPrepinEgressProposalsPerGame: number;
                    supportedPrepinEgressFunnel: Record<string, number>;
                    supportedPrepinEgressFunnelPerGame: Record<string, number>;
                }
            >;
        };
        expect(aggregate.versions["v0.8"]).toMatchObject({
            supportedPrepinEgressSelections: 2,
            supportedPrepinEgressSelectionsPerGame: 1,
            supportedPrepinEgressProposals: 4,
            supportedPrepinEgressProposalsPerGame: 2,
            supportedPrepinEgressFunnel: {
                ordinary_shot: 2,
                eligible_shooter: 2,
                target_no_counter: 0,
                future_exposure: 2,
                native_guard: 0,
                current_signature: 0,
                reachable_route: 0,
                pending_distance_safe: 0,
                screened_route: 0,
                exposure_improved: 0,
                retained_signature: 0,
                posture_safe: 0,
            },
            supportedPrepinEgressFunnelPerGame: {
                ordinary_shot: 1,
                eligible_shooter: 1,
                target_no_counter: 0,
                future_exposure: 1,
                native_guard: 0,
                current_signature: 0,
                reachable_route: 0,
                pending_distance_safe: 0,
                screened_route: 0,
                exposure_improved: 0,
                retained_signature: 0,
                posture_safe: 0,
            },
        });
        expect(aggregate.versions["v0.8s"]).toMatchObject({
            supportedPrepinEgressSelections: 0,
            supportedPrepinEgressSelectionsPerGame: 0,
            supportedPrepinEgressProposals: 0,
            supportedPrepinEgressProposalsPerGame: 0,
            supportedPrepinEgressFunnel: {
                ordinary_shot: 0,
                eligible_shooter: 0,
                target_no_counter: 0,
                future_exposure: 0,
                native_guard: 0,
                current_signature: 0,
                reachable_route: 0,
                pending_distance_safe: 0,
                screened_route: 0,
                exposure_improved: 0,
                retained_signature: 0,
                posture_safe: 0,
            },
        });
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
