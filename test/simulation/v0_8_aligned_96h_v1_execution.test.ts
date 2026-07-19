/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import type { GameAction } from "../../src/engine/actions";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { Unit } from "../../src/units/unit";
import type { IDecisionContext } from "../../src/ai";
import type { IMatchConfig, IMatchResult, ITurnExecutionObservation } from "../../src/simulation/battle_engine";
import { buildV08AlignedV1ProductionIncumbentGenome } from "../../src/simulation/optimizer/v0_8_aligned_96h_v1_catalog";
import {
    V08_ALIGNED_96H_V1_CELLS,
    V08_ALIGNED_96H_V1_SEATS,
    aggregateV08AlignedV1,
    assessV08AlignedV1Final,
    assessV08AlignedV1Promotion,
    emptyV08AlignedV1ExecutionAudit,
    evaluateV08AlignedV1OperationalEligibility,
    exactGridCountsV08AlignedV1,
    gridTypeV08AlignedV1,
    type IV08AlignedV1GameObservation,
} from "../../src/simulation/optimizer/v0_8_aligned_96h_v1_core";
import {
    playV08AlignedV1Task,
    type IV08AlignedV1GameDependencies,
} from "../../src/simulation/optimizer/v0_8_aligned_96h_v1_game_adapter";
import {
    bindV08AlignedV1Candidate,
    upgradeV08AlignedV1ExecutionTask,
} from "../../src/simulation/optimizer/v0_8_aligned_96h_v1_protocol";

function searchOffBinding() {
    const genome = buildV08AlignedV1ProductionIncumbentGenome();
    genome.search.leafMode = "off";
    genome.search.leaf = undefined;
    return bindV08AlignedV1Candidate(genome);
}

function fixedTask(scenarioOrdinal = 0, candidateSeat: "candidate_green" | "candidate_red" = "candidate_green") {
    return upgradeV08AlignedV1ExecutionTask({
        panelId: "v0.8-execution-test",
        purpose: "train",
        cellId: "fixed_mage_frontline",
        scenarioOrdinal,
        scenarioId: `scenario-${scenarioOrdinal}`,
        candidateSeat,
        setupSeeds: [100_001 + scenarioOrdinal],
        combatSeed: 1 + scenarioOrdinal,
    });
}

function fakeResult(config: IMatchConfig): IMatchResult {
    return {
        seed: config.seed,
        gridType: config.gridType ?? PBTypes.GridVals.NORMAL,
        winner: "green",
        endReason: "elimination",
        laps: 1,
        totalActions: 1,
        roster: config.roster,
        redRoster: config.redRoster,
        placements: { green: [], red: [] },
        actions: [],
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
        rejectedGreen: 0,
        rejectedRed: 0,
        rejectedDetails: [],
        greenArtifactT1: config.greenArtifactT1 ?? 0,
        redArtifactT1: config.redArtifactT1 ?? 0,
        greenArtifactT2: config.greenArtifactT2 ?? 0,
        redArtifactT2: config.redArtifactT2 ?? 0,
    };
}

function detachedTurn(
    unitId: string,
    side: "green" | "red",
    strategyVersion: string,
    action?: GameAction,
): ITurnExecutionObservation {
    return {
        unitId,
        creatureName: "Test Unit",
        side,
        strategyVersion,
        rawIncumbent: action ? [structuredClone(action)] : [],
        chosenDecision: action ? [structuredClone(action)] : [],
        strategyActions: action ? [{ action: structuredClone(action), completed: true, events: [] }] : [],
        recoveryAttempts: [],
        recovery: { source: "none", completed: false, events: [] },
        events: [],
    };
}

function cleanObservation(
    cellId: IV08AlignedV1GameObservation["cellId"],
    candidateSeat: IV08AlignedV1GameObservation["candidateSeat"],
    scenarioOrdinal: number,
    outcome: IV08AlignedV1GameObservation["outcome"] = "candidate_win",
): IV08AlignedV1GameObservation {
    const execution = emptyV08AlignedV1ExecutionAudit();
    execution.candidate.observedTurns = 1;
    execution.candidate.completedAttacksOrSpells = 1;
    execution.opponent.observedTurns = 1;
    execution.opponent.completedAttacksOrSpells = 1;
    return {
        cellId,
        candidateSeat,
        scenarioOrdinal,
        scenarioId: `scenario-${scenarioOrdinal}`,
        gridType: gridTypeV08AlignedV1(scenarioOrdinal),
        outcome,
        reachedArmageddon: false,
        candidateRejections: 0,
        opponentRejections: 0,
        searchAudit: {
            decisions: 1,
            searchedDecisions: 1,
            deadlineFallbacks: 0,
            illegalIncumbents: 0,
            circuitOpened: false,
            circuitSkippedDecisions: 0,
            msTotal: 1,
        },
        execution,
    };
}

function exactPanel(scenariosPerCell: number, outcome: IV08AlignedV1GameObservation["outcome"] = "candidate_win") {
    return V08_ALIGNED_96H_V1_CELLS.flatMap((cell) =>
        V08_ALIGNED_96H_V1_SEATS.flatMap((candidateSeat) =>
            Array.from({ length: scenariosPerCell }, (_, scenarioOrdinal) =>
                cleanObservation(cell.id, candidateSeat, scenarioOrdinal, outcome),
            ),
        ),
    );
}

describe("v0.8 aligned execution and map integrity", () => {
    it("derives exact four-map counts without changing any production game budget", () => {
        expect(exactGridCountsV08AlignedV1(256)).toEqual({ 1: 64, 2: 64, 3: 64, 4: 64 });
        expect(exactGridCountsV08AlignedV1(1000)).toEqual({ 1: 250, 2: 250, 3: 250, 4: 250 });
        expect(exactGridCountsV08AlignedV1(2000)).toEqual({ 1: 500, 2: 500, 3: 500, 4: 500 });

        const aggregate = aggregateV08AlignedV1(exactPanel(4), { expectedGamesPerCellSeat: 4 });
        expect(aggregate.complete).toBe(true);
        expect(aggregate.mapCoverage.passed).toBe(true);
        expect(
            aggregate.mapCoverage.cellSeats.every((entry) => Object.values(entry.counts).every((n) => n === 1)),
        ).toBe(true);
    });

    it("rejects ordinal/grid relabeling and fails non-contiguous formal ordinals", () => {
        const relabeled = cleanObservation("ranked_mage", "candidate_green", 1);
        relabeled.gridType = PBTypes.GridVals.NORMAL;
        expect(() => aggregateV08AlignedV1([relabeled])).toThrow("gridType does not match its scenarioOrdinal");

        const panel = exactPanel(4);
        const row = panel.find(
            (entry) =>
                entry.cellId === "ranked_mage" &&
                entry.candidateSeat === "candidate_green" &&
                entry.scenarioOrdinal === 3,
        )!;
        row.scenarioOrdinal = 7;
        row.gridType = gridTypeV08AlignedV1(7);
        const aggregate = aggregateV08AlignedV1(panel, { expectedGamesPerCellSeat: 4 });
        expect(aggregate.complete).toBe(false);
        expect(aggregate.completenessErrors).toContain(
            "ranked_mage/candidate_green: scenario ordinals or grid coverage are not exact",
        );
    });

    it("records a real BLOCK_CENTER wait with attack, move, and mining alternatives", () => {
        const record = playV08AlignedV1Task(fixedTask(3), searchOffBinding());
        const wait = record.execution.candidatePassiveAlternatives.explicitWait;
        expect(record.gridType).toBe(PBTypes.GridVals.BLOCK_CENTER);
        expect(wait.withLegalAttackOrSpell > 0).toBe(true);
        expect(wait.withLegalMove > 0).toBe(true);
        expect(wait.withLegalObstacleAttack > 0).toBe(true);
        expect(record.execution.candidate.completedObstacleAttacks > 0).toBe(true);
    });

    it("pairs a search-overridden explicit defend with its incumbent attack and legal move", () => {
        const unitId = "candidate-unit";
        const incumbent: GameAction = {
            type: "melee_attack",
            attackerId: unitId,
            targetId: "target",
            attackFrom: { x: 1, y: 1 },
        };
        const defend: GameAction = { type: "defend_turn", unitId };
        const fakeUnit = { getId: () => unitId, getTeam: () => PBTypes.TeamVals.LOWER } as Unit;
        const dependencies: IV08AlignedV1GameDependencies = {
            candidateEnumerator: (() => ({
                candidates: [
                    { actions: [incumbent] },
                    { actions: [{ type: "move_unit", unitId, path: [{ x: 2, y: 2 }] }] },
                ],
                truncated: [],
            })) as IV08AlignedV1GameDependencies["candidateEnumerator"],
            matchRunner: (config) => {
                config.decisionObserver!({
                    unit: fakeUnit,
                    context: {} as IDecisionContext,
                    incumbent: [incumbent],
                    strategyVersion: "v0.8s",
                });
                config.turnExecutionObserver!(detachedTurn(unitId, "green", "v0.8s", defend));
                return fakeResult(config);
            },
        };
        const record = playV08AlignedV1Task(fixedTask(), searchOffBinding(), dependencies);
        expect(record.execution.candidatePassiveAlternatives.explicitDefend).toEqual({
            turns: 1,
            withLegalAttackOrSpell: 1,
            withLegalMove: 1,
            withLegalObstacleAttack: 0,
        });
    });

    it("fails closed when a runner omits or drifts the paired observer callbacks", () => {
        expect(() => playV08AlignedV1Task(fixedTask(), searchOffBinding(), { matchRunner: fakeResult })).toThrow(
            "did not invoke the required turn execution observers",
        );

        const opponent = { getId: () => "opponent", getTeam: () => PBTypes.TeamVals.UPPER } as Unit;
        expect(() =>
            playV08AlignedV1Task(fixedTask(), searchOffBinding(), {
                matchRunner: (config) => {
                    config.decisionObserver!({
                        unit: opponent,
                        context: {} as IDecisionContext,
                        incumbent: [],
                        strategyVersion: "v0.7",
                    });
                    config.turnExecutionObserver!(detachedTurn("wrong-unit", "red", "v0.7"));
                    return fakeResult(config);
                },
            }),
        ).toThrow("decision/execution observer pairing drifted");
    });

    it("hard-fails candidate no-op, recovery, and rejection but keeps opponent no-op informational", () => {
        const base = exactPanel(4);
        expect(
            evaluateV08AlignedV1OperationalEligibility(aggregateV08AlignedV1(base, { expectedGamesPerCellSeat: 4 }))
                .passed,
        ).toBe(true);

        const candidateNoOp = structuredClone(base);
        candidateNoOp[0].execution.candidate.strategyNoOpTurns = 1;
        candidateNoOp[0].execution.candidatePassiveAlternatives.strategyNoOp.turns = 1;
        expect(
            evaluateV08AlignedV1OperationalEligibility(
                aggregateV08AlignedV1(candidateNoOp, { expectedGamesPerCellSeat: 4 }),
            ).passed,
        ).toBe(false);

        const recovery = structuredClone(base);
        recovery[0].execution.candidate.strategyNoOpTurns = 1;
        recovery[0].execution.candidate.recoveryTurns = 1;
        recovery[0].execution.candidate.recoveryAdvanceTurns = 1;
        recovery[0].execution.candidatePassiveAlternatives.strategyNoOp.turns = 1;
        recovery[0].execution.candidatePassiveAlternatives.recovery.turns = 1;
        expect(
            evaluateV08AlignedV1OperationalEligibility(aggregateV08AlignedV1(recovery, { expectedGamesPerCellSeat: 4 }))
                .passed,
        ).toBe(false);

        const rejected = structuredClone(base);
        rejected[0].candidateRejections = 1;
        rejected[0].execution.candidate.rejectedTurns = 1;
        rejected[0].execution.candidate.rejectedActions = 1;
        expect(
            evaluateV08AlignedV1OperationalEligibility(aggregateV08AlignedV1(rejected, { expectedGamesPerCellSeat: 4 }))
                .passed,
        ).toBe(false);

        const opponentNoOp = structuredClone(base);
        opponentNoOp[0].execution.opponent.strategyNoOpTurns = 1;
        const opponentAggregate = aggregateV08AlignedV1(opponentNoOp, { expectedGamesPerCellSeat: 4 });
        expect(opponentAggregate.integrity.executionPassed).toBe(true);
        expect(evaluateV08AlignedV1OperationalEligibility(opponentAggregate).passed).toBe(true);
    });

    it("lets a clean challenger replace a passive incumbent but never promotes a passive challenger", () => {
        const challenger = exactPanel(1000, "candidate_win");
        const incumbent = exactPanel(1000, "opponent_win");
        incumbent[0].execution.candidate.strategyNoOpTurns = 1;
        incumbent[0].execution.candidatePassiveAlternatives.strategyNoOp.turns = 1;
        const pairs = challenger.map((row, index) => ({ challenger: row, incumbent: incumbent[index] }));
        expect(assessV08AlignedV1Promotion(pairs).verdict).toBe("PROMOTE");

        challenger[0].execution.candidate.strategyNoOpTurns = 1;
        challenger[0].execution.candidatePassiveAlternatives.strategyNoOp.turns = 1;
        expect(assessV08AlignedV1Promotion(pairs).verdict).toBe("HOLD");
    });

    it("cannot return final PASS when one candidate execution has a no-op", () => {
        const final = exactPanel(2000);
        expect(assessV08AlignedV1Final(final).verdict).toBe("PASS");
        final[0].execution.candidate.strategyNoOpTurns = 1;
        final[0].execution.candidatePassiveAlternatives.strategyNoOp.turns = 1;
        const terminal = assessV08AlignedV1Final(final);
        expect(terminal.verdict).toBe("FAIL");
        expect(terminal.checks.integrityPassed).toBe(false);
    });
});
