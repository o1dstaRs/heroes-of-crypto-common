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

import type {
    IAIPolicyEvent,
    IV08ProtectedAdvanceGuardrailDetails,
    IV08SupportedBandAdvanceDetails,
    IV08SupportedBandDuelDetails,
    IV08SupportedPrepinEgressDetails,
    IV08SupportedRangedEscapeDetails,
} from "../../src/ai";
import {
    V08_SUPPORTED_BAND_ADVANCE_FUNNEL_STAGES,
    V08_SUPPORTED_RANGED_ESCAPE_FUNNEL_STAGES,
} from "../../src/ai/ai_strategy";
import { setupForArchetype } from "../../src/simulation/archetype_payoff";
import {
    aggregateMirrorDiag,
    buildMirrorRoster,
    MIRROR_COHORTS,
    mirrorGameSeed,
    mirrorWorkerGameIndex,
    MIXED_CYCLOPS_TSAR_ROSTER_NAMES,
    playMirrorGame,
    PURE_RANGED_ROSTER_NAMES,
    summarizeMirrorRecords,
    type IMirrorGameRecord,
    type IMirrorRunConfig,
    type IMirrorSideDiag,
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

const RANGED_ESCAPE_DETAILS: IV08SupportedRangedEscapeDetails = {
    fromCell: { x: 1, y: 2 },
    toCell: { x: 2, y: 2 },
    incumbentAttackFromCell: { x: 1, y: 2 },
    targetId: "pinned-target",
    targetCreatureName: "Pinned target",
    targetHp: 40,
    meleeHitChance: 0.8,
    expectedEffectiveMeleeDamage: 12,
    reachableThreatsBefore: 2,
    screenedThreatsBefore: 1,
    unscreenedThreatsBefore: 1,
    reachableThreatsAfter: 2,
    screenedThreatsAfter: 2,
    unscreenedThreatsAfter: 0,
    targetDistanceBefore: 1,
    targetDistanceAfter: 2,
    minEnemyDistanceBefore: 1,
    minEnemyDistanceAfter: 2,
    nearestFrontlineDistanceAfter: 1,
    screeningFrontlinerId: "screen",
    screeningFrontlinerCreatureName: "Squire",
    routeCost: 1,
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

const BAND_ADVANCE_DETAILS: IV08SupportedBandAdvanceDetails = {
    ...PREPIN_DETAILS,
    toCell: { x: 1, y: 1 },
    divisorBefore: 2,
    divisorAfter: 1,
    targetDistanceAfter: 7,
    minEnemyDistanceAfter: 3,
    rangedSuperior: false,
    finishActive: true,
};

const BAND_DUEL_DETAILS: IV08SupportedBandDuelDetails = {
    difference: "strict_hold_shipped_advance",
    strict: {
        actionTypes: ["range_attack"],
        movePath: null,
        moveTargetCells: null,
        moveHasLavaCell: null,
        moveHasWaterCell: null,
        rangeTargetId: "duel-target",
        rangeAimCell: { x: 4, y: 5 },
        rangeAimSide: 2,
    },
    shipped: {
        actionTypes: ["move_unit", "range_attack"],
        movePath: [{ x: 1, y: 1 }],
        moveTargetCells: [{ x: 1, y: 1 }],
        moveHasLavaCell: false,
        moveHasWaterCell: false,
        rangeTargetId: "duel-target",
        rangeAimCell: { x: 4, y: 5 },
        rangeAimSide: 2,
    },
};

const PROTECTED_ADVANCE_GUARDRAIL_DETAILS: IV08ProtectedAdvanceGuardrailDetails = {
    reason: "ranged_superior_hold",
    fromCell: { x: 0, y: 1 },
    toCell: { x: 1, y: 1 },
    targetId: "guardrail-target",
    targetCreatureName: "Guardrail target",
    divisorBefore: 2,
    divisorAfter: 1,
    ownRangedOutput: 200,
    enemyRangedOutput: 100,
    rangedSuperior: true,
    finishActive: false,
    reachableThreatsAfter: 0,
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

    test("mixed_cyclops_tsar is a fixed mixed screen with native Large Caliber and Through Shot actors", () => {
        const exp = buildMirrorRoster("mixed_cyclops_tsar", 1, "expBudget");
        const table = buildMirrorRoster("mixed_cyclops_tsar", 999, "levelTable");

        expect(MIRROR_COHORTS).toContain("mixed_cyclops_tsar");
        expect(exp.map((unit) => unit.creatureName)).toEqual(
            MIXED_CYCLOPS_TSAR_ROSTER_NAMES.map((unit) => unit.creatureName),
        );
        expect(exp.map((unit) => unit.level)).toEqual([1, 1, 2, 2, 3, 4]);
        expect(table.map((unit) => unit.creatureName)).toEqual(exp.map((unit) => unit.creatureName));
        expect(table.map((unit) => unit.amount)).toEqual([50, 50, 30, 30, 15, 8]);
        expect(exp.map((unit) => unit.amount)).not.toEqual(table.map((unit) => unit.amount));
        expect(exp.map((unit) => unit.creatureName)).not.toEqual(
            PURE_RANGED_ROSTER_NAMES.map((unit) => unit.creatureName),
        );
        expect(exp.map((unit) => unit.creatureName)).toEqual([
            "Squire",
            "Arbalester",
            "Pikeman",
            "Elf",
            "Cyclops",
            "Tsar Cannon",
        ]);
    });

    test("mixed_cyclops_tsar preserves symmetric paired side swaps and the ordinary LiveTwin setup", () => {
        const cfg: IMirrorRunConfig = { ...BASE_CFG, cohort: "mixed_cyclops_tsar" };
        const configs: IMatchConfig[] = [];
        const matchRunner = (config: IMatchConfig): IMatchResult => {
            configs.push(config);
            return fakeResult(config, "draw");
        };

        const first = playMirrorGame(cfg, 0, { matchRunner });
        const second = playMirrorGame(cfg, 1, { matchRunner });
        const signature = (roster: IMatchConfig["roster"]): string[] =>
            roster.map((unit) => `L${unit.level}:${unit.creatureName}x${unit.amount}`);
        const expectedSetup = setupForArchetype("melee_coevo");

        expect(first.seed).toBe(second.seed);
        expect(configs[0].greenVersion).toBe("v0.7");
        expect(configs[0].redVersion).toBe("v0.6");
        expect(configs[1].greenVersion).toBe("v0.6");
        expect(configs[1].redVersion).toBe("v0.7");
        expect(signature(configs[0].roster)).toEqual(signature(configs[0].redRoster!));
        expect(signature(configs[1].roster)).toEqual(signature(configs[0].roster));
        expect(configs[0].roster).not.toBe(configs[0].redRoster);
        expect(configs[0].greenPerk).toBe(expectedSetup.perk);
        expect(configs[0].redPerk).toBe(expectedSetup.perk);
        expect(configs[0].greenAugments).toEqual(expectedSetup.augments);
        expect(configs[0].redAugments).toEqual(expectedSetup.augments);
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
                details: RANGED_ESCAPE_DETAILS,
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
                details: RANGED_ESCAPE_DETAILS,
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
        expect(first.diag?.green.supportedBandAdvanceSelections).toBe(0);
        expect(first.diag?.red.supportedBandAdvanceProposals).toBe(0);
        expect(first.supportedBandAdvanceEvents).toBeUndefined();
        expect(first.diag?.green.protectedAdvanceGuardrailVetoes).toBe(0);
        expect(first.diag?.red.protectedAdvanceGuardrailVetoesByReason).toEqual({
            ranged_superior_hold: 0,
            partial_band: 0,
        });
        expect(first.diag?.green.protectedAdvanceGuardrailProposals).toBe(0);
        expect(first.diag?.red.protectedAdvanceGuardrailProposalsByReason).toEqual({
            ranged_superior_hold: 0,
            partial_band: 0,
        });
        expect(first.protectedAdvanceGuardrailEvents).toBeUndefined();
        expect(first.diag?.green.supportedPrepinEgressSelections).toBe(0);
        expect(first.diag?.red.supportedPrepinEgressProposals).toBe(0);
        expect(first.supportedPrepinEgressEvents).toBeUndefined();

        // Historical JSONL records omit the additive guardrail counters; aggregation must treat them as zero.
        const historicalSide = swapped.diag!.green as Partial<IMirrorSideDiag>;
        delete historicalSide.protectedAdvanceGuardrailVetoes;
        delete historicalSide.protectedAdvanceGuardrailVetoesByReason;
        delete historicalSide.protectedAdvanceGuardrailProposals;
        delete historicalSide.protectedAdvanceGuardrailProposalsByReason;
        delete historicalSide.supportedBandDuelDifferenceSelections;
        delete historicalSide.supportedBandDuelDifferenceProposals;
        delete historicalSide.supportedBandDuelDifferenceSelectionsByDifference;
        delete historicalSide.supportedBandDuelDifferenceProposalsByDifference;
        delete historicalSide.supportedRangedEscapeFunnel;

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
                    supportedBandAdvanceSelections: number;
                    supportedBandAdvanceProposals: number;
                    supportedBandDuelDifferenceSelections: number;
                    supportedBandDuelDifferenceProposals: number;
                    protectedAdvanceGuardrailVetoes: number;
                    protectedAdvanceGuardrailVetoesByReason: Record<string, number>;
                    protectedAdvanceGuardrailProposals: number;
                    protectedAdvanceGuardrailProposalsByReason: Record<string, number>;
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
                supportedBandAdvanceSelections: 0,
                supportedBandAdvanceProposals: 0,
                supportedBandDuelDifferenceSelections: 0,
                supportedBandDuelDifferenceProposals: 0,
                protectedAdvanceGuardrailVetoes: 0,
                protectedAdvanceGuardrailVetoesByReason: {
                    ranged_superior_hold: 0,
                    partial_band: 0,
                },
                protectedAdvanceGuardrailProposals: 0,
                protectedAdvanceGuardrailProposalsByReason: {
                    ranged_superior_hold: 0,
                    partial_band: 0,
                },
                supportedPrepinEgressSelections: 0,
                supportedPrepinEgressProposals: 0,
            });
        }
    });

    test("tracks the supported ranged escape funnel and detached retained proposals across side swaps", () => {
        const cfg: IMirrorRunConfig = { ...BASE_CFG, vA: "v0.8", vB: "v0.8s", diag: true };
        const partialStages = V08_SUPPORTED_RANGED_ESCAPE_FUNNEL_STAGES.slice(0, 5);
        const matchRunner = (config: IMatchConfig): IMatchResult => {
            const treatmentTeam = config.greenVersion === "v0.8" ? GREEN_TEAM : RED_TEAM;
            for (const stage of V08_SUPPORTED_RANGED_ESCAPE_FUNNEL_STAGES) {
                config.policyProposalObserver?.({
                    kind: "v0.8_supported_ranged_escape_funnel",
                    unitId: `full-${stage}`,
                    creatureName: "Arbalester",
                    team: treatmentTeam,
                    lap: 2,
                    stage,
                });
            }
            for (const stage of partialStages) {
                config.policyProposalObserver?.({
                    kind: "v0.8_supported_ranged_escape_funnel",
                    unitId: `partial-${stage}`,
                    creatureName: "Arbalester",
                    team: treatmentTeam,
                    lap: 2,
                    stage,
                });
            }

            const retainedDetails: IV08SupportedRangedEscapeDetails = {
                ...RANGED_ESCAPE_DETAILS,
                fromCell: { ...RANGED_ESCAPE_DETAILS.fromCell },
                toCell: { ...RANGED_ESCAPE_DETAILS.toCell },
                incumbentAttackFromCell: { ...RANGED_ESCAPE_DETAILS.incumbentAttackFromCell },
            };
            const retainedProposal: IAIPolicyEvent = {
                kind: "v0.8_supported_ranged_escape",
                unitId: "escape-retained",
                creatureName: "Arbalester",
                team: treatmentTeam,
                lap: 2,
                details: retainedDetails,
            };
            const replacedProposal: IAIPolicyEvent = {
                kind: "v0.8_supported_ranged_escape",
                unitId: "escape-replaced",
                creatureName: "Elf",
                team: treatmentTeam,
                lap: 2,
                details: {
                    ...RANGED_ESCAPE_DETAILS,
                    fromCell: { x: 3, y: 4 },
                    toCell: { x: 4, y: 4 },
                    incumbentAttackFromCell: { x: 3, y: 4 },
                    routeCost: 2,
                },
            };
            config.policyProposalObserver?.(retainedProposal);
            config.policyProposalObserver?.(replacedProposal);
            config.policyEventObserver?.(retainedProposal);

            // Mirror records own detached coordinates; later strategy-side mutation cannot rewrite JSONL evidence.
            retainedDetails.fromCell.x = 99;
            retainedDetails.toCell.x = 99;
            retainedDetails.incumbentAttackFromCell.x = 99;
            return fakeResult(config, "draw");
        };
        const records = [playMirrorGame(cfg, 0, { matchRunner }), playMirrorGame(cfg, 1, { matchRunner })];

        for (const record of records) {
            const treatment = record.diag!.green.version === "v0.8" ? record.diag!.green : record.diag!.red;
            const control = record.diag!.green.version === "v0.8s" ? record.diag!.green : record.diag!.red;
            expect(treatment.supportedRangedEscapeProposals).toBe(2);
            expect(treatment.supportedRangedEscapes).toBe(1);
            expect(treatment.supportedRangedEscapeFunnel.melee_incumbent).toBe(2);
            expect(treatment.supportedRangedEscapeFunnel.armageddon_buffer_clear).toBe(1);
            expect(control.supportedRangedEscapeProposals).toBe(0);
            expect(control.supportedRangedEscapes).toBe(0);
            expect(Object.values(control.supportedRangedEscapeFunnel).every((count) => count === 0)).toBe(true);
            expect(record.supportedRangedEscapeEvents?.map(({ retained }) => retained)).toEqual([true, false]);
            expect(record.supportedRangedEscapeEvents?.[0]).toMatchObject({
                ...RANGED_ESCAPE_DETAILS,
                fromCell: RANGED_ESCAPE_DETAILS.fromCell,
                toCell: RANGED_ESCAPE_DETAILS.toCell,
                incumbentAttackFromCell: RANGED_ESCAPE_DETAILS.incumbentAttackFromCell,
                side: record.greenVersion === "v0.8" ? "green" : "red",
                unitId: "escape-retained",
                creatureName: "Arbalester",
                lap: 2,
                retained: true,
            });
        }
        expect(records[0].supportedRangedEscapeEvents?.[0].side).toBe("green");
        expect(records[1].supportedRangedEscapeEvents?.[0].side).toBe("red");

        const aggregate = aggregateMirrorDiag(records, cfg) as {
            versions: Record<
                string,
                {
                    supportedRangedEscapes: number;
                    supportedRangedEscapesPerGame: number;
                    supportedRangedEscapeProposals: number;
                    supportedRangedEscapeProposalsPerGame: number;
                    supportedRangedEscapeFunnel: Record<string, number>;
                    supportedRangedEscapeFunnelPerGame: Record<string, number>;
                }
            >;
        };
        expect(aggregate.versions["v0.8"]).toMatchObject({
            supportedRangedEscapes: 2,
            supportedRangedEscapesPerGame: 1,
            supportedRangedEscapeProposals: 4,
            supportedRangedEscapeProposalsPerGame: 2,
            supportedRangedEscapeFunnel: {
                melee_incumbent: 4,
                current_ranged_mode: 4,
                armageddon_buffer_clear: 2,
                delta_only_best: 2,
            },
            supportedRangedEscapeFunnelPerGame: {
                melee_incumbent: 2,
                current_ranged_mode: 2,
                armageddon_buffer_clear: 1,
                delta_only_best: 1,
            },
        });
        expect(aggregate.versions["v0.8s"]).toMatchObject({
            supportedRangedEscapes: 0,
            supportedRangedEscapeProposals: 0,
        });
        expect(
            Object.values(aggregate.versions["v0.8s"].supportedRangedEscapeFunnel).every((count) => count === 0),
        ).toBe(true);
    });

    test("tracks the supported band catalog and exact retained treatment proposal across side swaps", () => {
        const cfg: IMirrorRunConfig = { ...BASE_CFG, vA: "v0.8", vB: "v0.8s", diag: true };
        const matchRunner = (config: IMatchConfig): IMatchResult => {
            const treatmentTeam = config.greenVersion === "v0.8" ? GREEN_TEAM : RED_TEAM;
            for (const stage of V08_SUPPORTED_BAND_ADVANCE_FUNNEL_STAGES) {
                config.policyProposalObserver?.({
                    kind: "v0.8_supported_band_advance_funnel",
                    unitId: `catalog-${treatmentTeam}-${stage}`,
                    creatureName: "Arbalester",
                    team: treatmentTeam,
                    lap: 2,
                    stage,
                });
            }
            const proposal: IAIPolicyEvent = {
                kind: "v0.8_supported_band_advance",
                unitId: `band-proposal-${treatmentTeam}`,
                creatureName: "Arbalester",
                team: treatmentTeam,
                lap: 2,
                details: {
                    ...BAND_ADVANCE_DETAILS,
                    fromCell: { ...BAND_ADVANCE_DETAILS.fromCell },
                    toCell: { ...BAND_ADVANCE_DETAILS.toCell },
                },
            };
            config.policyProposalObserver?.(proposal);
            config.policyEventObserver?.(proposal);
            return fakeResult(config, "draw");
        };
        const records = [playMirrorGame(cfg, 0, { matchRunner }), playMirrorGame(cfg, 1, { matchRunner })];

        for (const record of records) {
            const diag = record.diag!;
            const treatment = diag.green.version === "v0.8" ? diag.green : diag.red;
            const control = diag.green.version === "v0.8s" ? diag.green : diag.red;
            expect(treatment.supportedBandAdvanceProposals).toBe(1);
            expect(treatment.supportedBandAdvanceSelections).toBe(1);
            expect(control.supportedBandAdvanceProposals).toBe(0);
            expect(control.supportedBandAdvanceSelections).toBe(0);
            expect(Object.values(treatment.supportedBandAdvanceFunnel).every((count) => count === 1)).toBe(true);
            expect(Object.values(control.supportedBandAdvanceFunnel).every((count) => count === 0)).toBe(true);
            expect(record.supportedBandAdvanceEvents).toHaveLength(1);
            expect(record.supportedBandAdvanceEvents?.filter(({ retained }) => retained)).toHaveLength(1);
            expect(record.supportedBandAdvanceEvents?.find(({ retained }) => retained)).toMatchObject({
                ...BAND_ADVANCE_DETAILS,
                side: record.greenVersion === "v0.8" ? "green" : "red",
                unitId: `band-proposal-${record.greenVersion === "v0.8" ? GREEN_TEAM : RED_TEAM}`,
                creatureName: "Arbalester",
                lap: 2,
                retained: true,
            });
            expect(record.supportedBandAdvanceEvents?.[0]?.finishActive).toBe(true);
        }
        expect(records[0].supportedBandAdvanceEvents?.find(({ retained }) => retained)?.side).toBe("green");
        expect(records[1].supportedBandAdvanceEvents?.find(({ retained }) => retained)?.side).toBe("red");

        const aggregate = aggregateMirrorDiag(records, cfg) as {
            versions: Record<
                string,
                {
                    supportedBandAdvanceSelections: number;
                    supportedBandAdvanceSelectionsPerGame: number;
                    supportedBandAdvanceProposals: number;
                    supportedBandAdvanceProposalsPerGame: number;
                    supportedBandAdvanceFunnel: Record<string, number>;
                    supportedBandAdvanceFunnelPerGame: Record<string, number>;
                }
            >;
        };
        expect(aggregate.versions["v0.8"]).toMatchObject({
            supportedBandAdvanceSelections: 2,
            supportedBandAdvanceSelectionsPerGame: 1,
            supportedBandAdvanceProposals: 2,
            supportedBandAdvanceProposalsPerGame: 1,
        });
        expect(aggregate.versions["v0.8s"]).toMatchObject({
            supportedBandAdvanceSelections: 0,
            supportedBandAdvanceSelectionsPerGame: 0,
            supportedBandAdvanceProposals: 0,
            supportedBandAdvanceProposalsPerGame: 0,
        });
        expect(Object.values(aggregate.versions["v0.8"].supportedBandAdvanceFunnel)).toEqual(
            V08_SUPPORTED_BAND_ADVANCE_FUNNEL_STAGES.map(() => 2),
        );
        expect(Object.values(aggregate.versions["v0.8"].supportedBandAdvanceFunnelPerGame)).toEqual(
            V08_SUPPORTED_BAND_ADVANCE_FUNNEL_STAGES.map(() => 1),
        );
        expect(Object.values(aggregate.versions["v0.8s"].supportedBandAdvanceFunnel)).toEqual(
            V08_SUPPORTED_BAND_ADVANCE_FUNNEL_STAGES.map(() => 0),
        );
        expect(Object.values(aggregate.versions["v0.8s"].supportedBandAdvanceFunnelPerGame)).toEqual(
            V08_SUPPORTED_BAND_ADVANCE_FUNNEL_STAGES.map(() => 0),
        );
    });

    test("tracks strict-vs-shipped decision differences through search retention and side swaps", () => {
        const cfg: IMirrorRunConfig = { ...BASE_CFG, vA: "v0.8", vB: "v0.8s", diag: true };
        const matchRunner = (config: IMatchConfig): IMatchResult => {
            const candidateTeam = config.greenVersion === "v0.8" ? GREEN_TEAM : RED_TEAM;
            const retained: IAIPolicyEvent = {
                kind: "v0.8_supported_band_duel_difference",
                unitId: `duel-retained-${candidateTeam}`,
                creatureName: "Arbalester",
                team: candidateTeam,
                lap: 3,
                details: BAND_DUEL_DETAILS,
            };
            const replaced: IAIPolicyEvent = {
                kind: "v0.8_supported_band_duel_difference",
                unitId: `duel-replaced-${candidateTeam}`,
                creatureName: "Elf",
                team: candidateTeam,
                lap: 4,
                details: {
                    difference: "different_advance",
                    strict: {
                        ...BAND_DUEL_DETAILS.shipped,
                        actionTypes: [...BAND_DUEL_DETAILS.shipped.actionTypes],
                        movePath: [{ x: 2, y: 1 }],
                        moveTargetCells: [{ x: 2, y: 1 }],
                        rangeAimCell: { ...BAND_DUEL_DETAILS.shipped.rangeAimCell! },
                    },
                    shipped: {
                        ...BAND_DUEL_DETAILS.shipped,
                        actionTypes: [...BAND_DUEL_DETAILS.shipped.actionTypes],
                        movePath: [{ x: 1, y: 1 }],
                        moveTargetCells: [{ x: 1, y: 1 }],
                        rangeAimCell: { ...BAND_DUEL_DETAILS.shipped.rangeAimCell! },
                    },
                },
            };
            config.policyProposalObserver?.(retained);
            config.policyProposalObserver?.(replaced);
            config.policyEventObserver?.(retained);
            return fakeResult(config, "draw");
        };
        const records = [playMirrorGame(cfg, 0, { matchRunner }), playMirrorGame(cfg, 1, { matchRunner })];

        for (const record of records) {
            const candidate = record.diag!.green.version === "v0.8" ? record.diag!.green : record.diag!.red;
            const control = record.diag!.green.version === "v0.8s" ? record.diag!.green : record.diag!.red;
            expect(candidate.supportedBandDuelDifferenceSelections).toBe(1);
            expect(candidate.supportedBandDuelDifferenceProposals).toBe(2);
            expect(candidate.supportedBandDuelDifferenceSelectionsByDifference).toEqual({
                strict_hold_shipped_advance: 1,
                strict_advance_shipped_hold: 0,
                different_advance: 0,
                other: 0,
            });
            expect(candidate.supportedBandDuelDifferenceProposalsByDifference).toEqual({
                strict_hold_shipped_advance: 1,
                strict_advance_shipped_hold: 0,
                different_advance: 1,
                other: 0,
            });
            expect(control.supportedBandDuelDifferenceSelections).toBe(0);
            expect(control.supportedBandDuelDifferenceProposals).toBe(0);
            expect(record.supportedBandDuelDifferenceEvents?.map(({ retained: selected }) => selected)).toEqual([
                true,
                false,
            ]);
            expect(record.supportedBandDuelDifferenceEvents?.[0]).toMatchObject({
                ...BAND_DUEL_DETAILS,
                side: record.greenVersion === "v0.8" ? "green" : "red",
                unitId: `duel-retained-${record.greenVersion === "v0.8" ? GREEN_TEAM : RED_TEAM}`,
                creatureName: "Arbalester",
                lap: 3,
                retained: true,
            });
            expect(record.supportedBandDuelDifferenceEvents?.[0]?.strict).not.toBe(BAND_DUEL_DETAILS.strict);
            expect(record.supportedBandDuelDifferenceEvents?.[0]?.shipped.movePath).not.toBe(
                BAND_DUEL_DETAILS.shipped.movePath,
            );
        }
        expect(records[0].supportedBandDuelDifferenceEvents?.[0]?.side).toBe("green");
        expect(records[1].supportedBandDuelDifferenceEvents?.[0]?.side).toBe("red");

        const aggregate = aggregateMirrorDiag(records, cfg) as {
            versions: Record<
                string,
                {
                    supportedBandDuelDifferenceSelections: number;
                    supportedBandDuelDifferenceSelectionsPerGame: number;
                    supportedBandDuelDifferenceSelectionsByDifference: Record<string, number>;
                    supportedBandDuelDifferenceProposals: number;
                    supportedBandDuelDifferenceProposalsPerGame: number;
                    supportedBandDuelDifferenceProposalsByDifference: Record<string, number>;
                }
            >;
        };
        expect(aggregate.versions["v0.8"]).toMatchObject({
            supportedBandDuelDifferenceSelections: 2,
            supportedBandDuelDifferenceSelectionsPerGame: 1,
            supportedBandDuelDifferenceSelectionsByDifference: {
                strict_hold_shipped_advance: 2,
                strict_advance_shipped_hold: 0,
                different_advance: 0,
                other: 0,
            },
            supportedBandDuelDifferenceProposals: 4,
            supportedBandDuelDifferenceProposalsPerGame: 2,
            supportedBandDuelDifferenceProposalsByDifference: {
                strict_hold_shipped_advance: 2,
                strict_advance_shipped_hold: 0,
                different_advance: 2,
                other: 0,
            },
        });
        expect(aggregate.versions["v0.8s"]).toMatchObject({
            supportedBandDuelDifferenceSelections: 0,
            supportedBandDuelDifferenceProposals: 0,
        });
    });

    test("tracks protected-advance guardrail vetoes, reasons, and detached seed-forensic events", () => {
        const cfg: IMirrorRunConfig = { ...BASE_CFG, vA: "v0.8", vB: "v0.8s", diag: true };
        const matchRunner = (config: IMatchConfig): IMatchResult => {
            const candidateTeam = config.greenVersion === "v0.8" ? GREEN_TEAM : RED_TEAM;
            const vetoes: IAIPolicyEvent[] = [
                {
                    kind: "v0.8_protected_advance_guardrail",
                    unitId: "stronger-ranged-veto",
                    creatureName: "Arbalester",
                    team: candidateTeam,
                    lap: 2,
                    details: {
                        ...PROTECTED_ADVANCE_GUARDRAIL_DETAILS,
                        fromCell: { ...PROTECTED_ADVANCE_GUARDRAIL_DETAILS.fromCell },
                        toCell: { ...PROTECTED_ADVANCE_GUARDRAIL_DETAILS.toCell },
                    },
                },
                {
                    kind: "v0.8_protected_advance_guardrail",
                    unitId: "partial-band-veto",
                    creatureName: "Orc",
                    team: candidateTeam,
                    lap: 3,
                    details: {
                        ...PROTECTED_ADVANCE_GUARDRAIL_DETAILS,
                        reason: "partial_band",
                        fromCell: { x: 3, y: 4 },
                        toCell: { x: 4, y: 4 },
                        targetId: "partial-target",
                        targetCreatureName: "Tsar Cannon",
                        divisorBefore: 4,
                        divisorAfter: 2,
                        ownRangedOutput: 100,
                        enemyRangedOutput: 200,
                        rangedSuperior: false,
                    },
                },
            ];
            for (const veto of vetoes) config.policyProposalObserver?.(veto);
            config.policyEventObserver?.(vetoes[0]);
            return fakeResult(config, "draw");
        };
        const records = [playMirrorGame(cfg, 0, { matchRunner }), playMirrorGame(cfg, 1, { matchRunner })];

        for (const record of records) {
            const candidate = record.diag!.green.version === "v0.8" ? record.diag!.green : record.diag!.red;
            const control = record.diag!.green.version === "v0.8s" ? record.diag!.green : record.diag!.red;
            expect(candidate.protectedAdvanceGuardrailVetoes).toBe(1);
            expect(candidate.protectedAdvanceGuardrailVetoesByReason).toEqual({
                ranged_superior_hold: 1,
                partial_band: 0,
            });
            expect(candidate.protectedAdvanceGuardrailProposals).toBe(2);
            expect(candidate.protectedAdvanceGuardrailProposalsByReason).toEqual({
                ranged_superior_hold: 1,
                partial_band: 1,
            });
            expect(control.protectedAdvanceGuardrailVetoes).toBe(0);
            expect(control.protectedAdvanceGuardrailVetoesByReason).toEqual({
                ranged_superior_hold: 0,
                partial_band: 0,
            });
            expect(control.protectedAdvanceGuardrailProposals).toBe(0);
            expect(control.protectedAdvanceGuardrailProposalsByReason).toEqual({
                ranged_superior_hold: 0,
                partial_band: 0,
            });
            expect(record.protectedAdvanceGuardrailEvents).toHaveLength(2);
            expect(record.protectedAdvanceGuardrailEvents?.[0]).toMatchObject({
                ...PROTECTED_ADVANCE_GUARDRAIL_DETAILS,
                side: record.greenVersion === "v0.8" ? "green" : "red",
                unitId: "stronger-ranged-veto",
                creatureName: "Arbalester",
                lap: 2,
                retained: true,
            });
            expect(record.protectedAdvanceGuardrailEvents?.[1]).toMatchObject({
                reason: "partial_band",
                fromCell: { x: 3, y: 4 },
                toCell: { x: 4, y: 4 },
                targetId: "partial-target",
                targetCreatureName: "Tsar Cannon",
                divisorBefore: 4,
                divisorAfter: 2,
                ownRangedOutput: 100,
                enemyRangedOutput: 200,
                rangedSuperior: false,
                finishActive: false,
                reachableThreatsAfter: 0,
                side: record.greenVersion === "v0.8" ? "green" : "red",
                unitId: "partial-band-veto",
                creatureName: "Orc",
                lap: 3,
                retained: false,
            });
            expect(record.protectedAdvanceGuardrailEvents?.map(({ retained }) => retained)).toEqual([true, false]);
        }
        expect(records[0].protectedAdvanceGuardrailEvents?.[0].side).toBe("green");
        expect(records[1].protectedAdvanceGuardrailEvents?.[0].side).toBe("red");

        const aggregate = aggregateMirrorDiag(records, cfg) as {
            versions: Record<
                string,
                {
                    protectedAdvanceGuardrailVetoes: number;
                    protectedAdvanceGuardrailVetoesPerGame: number;
                    protectedAdvanceGuardrailVetoesByReason: Record<string, number>;
                    protectedAdvanceGuardrailVetoesByReasonPerGame: Record<string, number>;
                    protectedAdvanceGuardrailProposals: number;
                    protectedAdvanceGuardrailProposalsPerGame: number;
                    protectedAdvanceGuardrailProposalsByReason: Record<string, number>;
                    protectedAdvanceGuardrailProposalsByReasonPerGame: Record<string, number>;
                }
            >;
        };
        expect(aggregate.versions["v0.8"]).toMatchObject({
            protectedAdvanceGuardrailVetoes: 2,
            protectedAdvanceGuardrailVetoesPerGame: 1,
            protectedAdvanceGuardrailVetoesByReason: {
                ranged_superior_hold: 2,
                partial_band: 0,
            },
            protectedAdvanceGuardrailVetoesByReasonPerGame: {
                ranged_superior_hold: 1,
                partial_band: 0,
            },
            protectedAdvanceGuardrailProposals: 4,
            protectedAdvanceGuardrailProposalsPerGame: 2,
            protectedAdvanceGuardrailProposalsByReason: {
                ranged_superior_hold: 2,
                partial_band: 2,
            },
            protectedAdvanceGuardrailProposalsByReasonPerGame: {
                ranged_superior_hold: 1,
                partial_band: 1,
            },
        });
        expect(aggregate.versions["v0.8s"]).toMatchObject({
            protectedAdvanceGuardrailVetoes: 0,
            protectedAdvanceGuardrailVetoesPerGame: 0,
            protectedAdvanceGuardrailVetoesByReason: {
                ranged_superior_hold: 0,
                partial_band: 0,
            },
            protectedAdvanceGuardrailVetoesByReasonPerGame: {
                ranged_superior_hold: 0,
                partial_band: 0,
            },
            protectedAdvanceGuardrailProposals: 0,
            protectedAdvanceGuardrailProposalsPerGame: 0,
            protectedAdvanceGuardrailProposalsByReason: {
                ranged_superior_hold: 0,
                partial_band: 0,
            },
            protectedAdvanceGuardrailProposalsByReasonPerGame: {
                ranged_superior_hold: 0,
                partial_band: 0,
            },
        });
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
