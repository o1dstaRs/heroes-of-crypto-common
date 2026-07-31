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

import { getAIStrategy, type IDecisionContext } from "../../src/ai";
import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getRangeAttackSideCenter, RangeAttackCellSide } from "../../src/grid/grid_math";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import type { IArmyUnitSpec } from "../../src/simulation/army";
import {
    runMatch,
    type IDecisionObservation,
    type IMatchResult,
    type ITurnExecutionObservation,
} from "../../src/simulation/battle_engine";
import { liveTwinSetup } from "../../src/simulation/livetwin";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

type StackSpec = readonly [faction: string, creatureName: string, level: number, size: number, amount: number];

interface RecordedReplay {
    seed: number;
    gridType: number;
    green: readonly StackSpec[];
    red: readonly StackSpec[];
}

interface DecisionSnapshot {
    unitId: string;
    creatureName: string;
    cumulativeHp: number;
    hasCowardice: boolean;
    forcedTargetId: string;
    forcedTargetName?: string;
    enemies: { id: string; name: string; cumulativeHp: number }[];
    explicitRangeFirstHits: { targetId: string; id: string; name: string; cumulativeHp: number }[];
}

interface ObservedTurn {
    decision: DecisionSnapshot;
    execution: ITurnExecutionObservation;
}

const toRoster = (rows: readonly StackSpec[]): IArmyUnitSpec[] =>
    rows.map(([faction, creatureName, level, size, amount]) => ({ faction, creatureName, level, size, amount }));

// Re-seeded when Satyr gained Sylvan Focus: BOTH armies below field a Satyr, so the aura changed what the
// search evaluates and the old seed (1323129968) stopped producing any edge-aimed shot at all — not a
// different aim cell, none. This seed reproduces the same behaviour the test was written to guard: red's
// Arbalester picking the alternate DOWN edge rather than the natural one.
// Re-seeded again after the Sniper augment's attack component rose to 8/17/27 (parity with Might): the
// stronger shot EV re-biased edge selection and seed 1323620946 stopped producing any DOWN-edge
// alternate at all. This seed reproduces the guarded behaviour (DOWN-edge aim at cell (5,6)).
const BLOCK_GAME_62: RecordedReplay = {
    seed: 1100000245,
    gridType: PBTypes.GridVals.BLOCK_CENTER,
    green: [
        ["Nature", "Wolf", 1, 1, 124],
        ["Life", "Arbalester", 1, 1, 124],
        ["Might", "Hyena", 2, 1, 26],
        ["Nature", "Satyr", 2, 1, 36],
        ["Life", "Crusader", 3, 1, 8],
        ["Life", "Tsar Cannon", 4, 2, 2],
    ],
    red: [
        ["Life", "Arbalester", 1, 1, 124],
        ["Life", "Squire", 1, 1, 132],
        ["Life", "Pikeman", 2, 1, 23],
        ["Nature", "Satyr", 2, 1, 36],
        ["Nature", "Mantis", 3, 1, 12],
        ["Might", "Thunderbird", 4, 2, 3],
    ],
};

// Re-seeded after the accumulated balance changes (Battle Mage 14/11 -> 26/10 most recently): the old seed
// stopped producing a Cowardice-struck Beholder that takes a range shot at all, so there was nothing left for
// this case to assert on. This seed reproduces the same behaviour it was written to guard.
const LAVA_GAME_158: RecordedReplay = {
    seed: 4173008544,
    gridType: PBTypes.GridVals.LAVA_CENTER,
    green: [
        ["Nature", "Leprechaun", 1, 1, 148],
        ["Chaos", "Scavenger", 1, 1, 164],
        ["Chaos", "Beholder", 2, 1, 22],
        ["Chaos", "Troll", 2, 1, 25],
        ["Life", "Crusader", 3, 1, 8],
        ["Might", "Thunderbird", 4, 2, 3],
    ],
    red: [
        ["Life", "Arbalester", 1, 1, 124],
        ["Life", "Squire", 1, 1, 132],
        ["Chaos", "Beholder", 2, 1, 22],
        ["Nature", "Satyr", 2, 1, 36],
        ["Nature", "Mantis", 3, 1, 12],
        ["Life", "Angel", 4, 2, 2],
    ],
};

// Re-seeded with the Sniper 8/17/27 change: the prior seed's Aggr chain no longer yields a red
// Arbalester shot at its live forced Pikeman target. This seed reproduces the guarded chain — the
// forced target IS the executed range target.
const NORMAL_GAME_1148: RecordedReplay = {
    seed: 2500000198,
    gridType: PBTypes.GridVals.NORMAL,
    green: [
        ["Might", "Wolf Rider", 1, 1, 81],
        ["Chaos", "Orc", 1, 1, 100],
        ["Nature", "Elf", 2, 1, 26],
        ["Life", "Pikeman", 2, 1, 23],
        ["Life", "Crusader", 3, 1, 8],
        ["Might", "Behemoth", 4, 2, 2],
    ],
    red: [
        ["Life", "Arbalester", 1, 1, 124],
        ["Might", "Berserker", 1, 1, 109],
        ["Nature", "Satyr", 2, 1, 36],
        ["Nature", "Elf", 2, 1, 26],
        ["Life", "Crusader", 3, 1, 8],
        ["Chaos", "Hydra", 4, 2, 2],
    ],
};

function snapshotDecision(observation: IDecisionObservation): DecisionSnapshot {
    const { unit, context, incumbent } = observation;
    const allUnits = context.unitsHolder.getAllUnits();
    const forcedTargetId = unit.getTarget();
    const forcedTarget = forcedTargetId ? allUnits.get(forcedTargetId) : undefined;
    const explicitRangeFirstHits: DecisionSnapshot["explicitRangeFirstHits"] = [];

    for (const action of incumbent) {
        if (
            action.type !== "range_attack" ||
            !action.aimCell ||
            action.aimSide === undefined ||
            !context.attackHandler
        ) {
            continue;
        }
        const to = getRangeAttackSideCenter(
            context.grid.getSettings(),
            action.aimCell,
            action.aimSide as RangeAttackCellSide,
            unit.getPosition(),
        );
        const evaluation = context.attackHandler.evaluateRangeAttack(
            allUnits,
            unit,
            unit.getPosition(),
            to,
            unit.hasAbilityActive("Through Shot"),
            false,
            unit.hasAbilityActive("Large Caliber") || unit.hasAbilityActive("Area Throw"),
        );
        const firstHit = evaluation.affectedUnits[0]?.[0];
        if (firstHit) {
            explicitRangeFirstHits.push({
                targetId: action.targetId,
                id: firstHit.getId(),
                name: firstHit.getName(),
                cumulativeHp: firstHit.getCumulativeHp(),
            });
        }
    }

    return {
        unitId: unit.getId(),
        creatureName: unit.getName(),
        cumulativeHp: unit.getCumulativeHp(),
        hasCowardice: unit.hasDebuffActive("Cowardice"),
        forcedTargetId,
        forcedTargetName: forcedTarget?.getName(),
        enemies: context.unitsHolder
            .getAllEnemyUnits(unit.getTeam())
            .filter((enemy) => !enemy.isDead())
            .map((enemy) => ({
                id: enemy.getId(),
                name: enemy.getName(),
                cumulativeHp: enemy.getCumulativeHp(),
            })),
        explicitRangeFirstHits,
    };
}

function replay(recorded: RecordedReplay): { result: IMatchResult; turns: ObservedTurn[] } {
    const decisions: DecisionSnapshot[] = [];
    const executions: ITurnExecutionObservation[] = [];
    const setup = liveTwinSetup();
    const result = runMatch({
        greenVersion: "v0.1",
        redVersion: "v0.1",
        roster: toRoster(recorded.green),
        redRoster: toRoster(recorded.red),
        seed: recorded.seed,
        gridType: recorded.gridType,
        maxLaps: 8,
        greenPerk: setup.perk,
        redPerk: setup.perk,
        greenAugments: setup.augments,
        redAugments: setup.augments,
        decisionObserver: (observation) => decisions.push(snapshotDecision(observation)),
        turnExecutionObserver: (observation) => executions.push(observation),
    });

    expect(executions).toHaveLength(decisions.length);
    const turns = executions.map((execution, index) => {
        const decision = decisions[index];
        expect(execution.unitId).toBe(decision.unitId);
        return { decision, execution };
    });
    return { result, turns };
}

function rangeAction(turn: ObservedTurn): Extract<GameAction, { type: "range_attack" }> | undefined {
    return turn.execution.rawIncumbent.find(
        (action): action is Extract<GameAction, { type: "range_attack" }> => action.type === "range_attack",
    );
}

function expectWholeStrategyPlanCompleted(turn: ObservedTurn): void {
    expect(turn.execution.strategyActions).toHaveLength(turn.execution.rawIncumbent.length);
    for (let index = 0; index < turn.execution.rawIncumbent.length; index += 1) {
        const applied = turn.execution.strategyActions[index];
        expect(applied.action).toEqual(turn.execution.rawIncumbent[index]);
        expect(applied.completed).toBe(true);
        expect(applied.rejectionReason).toBeUndefined();
    }
    expect(turn.execution.recovery).toEqual({ source: "none", completed: false, events: [] });
    expect(turn.execution.recoveryAttempts).toEqual([]);
}

function expectEveryRangePlanCompleted(turns: readonly ObservedTurn[]): void {
    const rangeTurns = turns.filter((turn) => rangeAction(turn));
    expect(rangeTurns.length).toBeGreaterThan(0);
    for (const turn of rangeTurns) {
        // Validate the whole proposed plan, including a select_attack_type prefix when one is present.
        expectWholeStrategyPlanCompleted(turn);
    }
}

describe("v0.1 ranged-fire robustness", () => {
    test("BLOCK game 62 selects the alternate DOWN edge and the engine accepts the complete plan", () => {
        const { result, turns } = replay(BLOCK_GAME_62);
        const greenArbalester = result.placements.green.find((placement) => placement.creatureName === "Arbalester");
        const redArbalester = result.placements.red.find((placement) => placement.creatureName === "Arbalester");
        expect(greenArbalester).toBeDefined();
        expect(redArbalester).toBeDefined();

        const alternateEdgeTurn = turns.find((turn) => {
            const action = rangeAction(turn);
            return (
                action?.attackerId === redArbalester!.unitId &&
                action.targetId === greenArbalester!.unitId &&
                action.aimCell?.x === 5 &&
                action.aimCell.y === 6 &&
                action.aimSide === RangeAttackCellSide.DOWN
            );
        });
        expect(alternateEdgeTurn).toBeDefined();
        expect(alternateEdgeTurn!.execution.rawIncumbent).toEqual([
            {
                type: "range_attack",
                attackerId: redArbalester!.unitId,
                targetId: greenArbalester!.unitId,
                aimCell: { x: 5, y: 6 },
                aimSide: RangeAttackCellSide.DOWN,
            },
        ]);
        expectWholeStrategyPlanCompleted(alternateEdgeTurn!);
        expect(
            alternateEdgeTurn!.execution.strategyActions[0].events.some(
                (event) => event.type === "unit_attacked" && event.targetId === greenArbalester!.unitId,
            ),
        ).toBe(true);
        expectEveryRangePlanCompleted(turns);
        expect(result.rejectedGreen + result.rejectedRed).toBe(0);
    });

    test("Cowardice chooses an edge whose actual first hit is weak enough, then completes it", () => {
        const { result, turns } = replay(LAVA_GAME_158);
        const cowardiceShot = turns.find(
            (turn) =>
                turn.execution.side === "red" &&
                turn.decision.creatureName === "Beholder" &&
                turn.decision.hasCowardice &&
                !!rangeAction(turn),
        );
        expect(cowardiceShot).toBeDefined();
        const action = rangeAction(cowardiceShot!);
        expect(action?.aimCell).toBeDefined();
        expect(action?.aimSide).toBeDefined();
        expect(cowardiceShot!.decision.explicitRangeFirstHits).toHaveLength(1);
        const firstHit = cowardiceShot!.decision.explicitRangeFirstHits[0];
        expect(firstHit.name).toBe("Beholder");
        expect(firstHit.cumulativeHp).toBeLessThanOrEqual(cowardiceShot!.decision.cumulativeHp);
        expectWholeStrategyPlanCompleted(cowardiceShot!);
        expectEveryRangePlanCompleted(turns);
        expect(result.rejectedGreen + result.rejectedRed).toBe(0);
    });

    test("a live Aggr target becomes the proposed and successfully executed range target", () => {
        const { result, turns } = replay(NORMAL_GAME_1148);
        const forcedShot = turns.find(
            (turn) =>
                turn.execution.side === "red" &&
                turn.decision.creatureName === "Arbalester" &&
                turn.decision.forcedTargetName === "Pikeman" &&
                !!rangeAction(turn),
        );
        expect(forcedShot).toBeDefined();
        const action = rangeAction(forcedShot!);
        expect(action?.targetId).toBe(forcedShot!.decision.forcedTargetId);
        expectWholeStrategyPlanCompleted(forcedShot!);
        expect(
            forcedShot!.execution.strategyActions.some(
                (applied) => applied.action.type === "range_attack" && applied.completed,
            ),
        ).toBe(true);
        expectEveryRangePlanCompleted(turns);
        expect(result.rejectedGreen + result.rejectedRed).toBe(0);
    });

    test("skips a Terrifying Gaze target even when that unit is the ray's first intersection", () => {
        const combat = createCombatTestContext();
        const shooter = createTestUnit({
            name: "Gaze-aware shooter",
            team: PBTypes.TeamVals.LOWER,
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 5,
            shotDistance: 30,
        });
        const forbidden = createTestUnit({
            name: "Forbidden gazer",
            team: PBTypes.TeamVals.UPPER,
            attackType: PBTypes.AttackVals.MELEE,
        });
        const legal = createTestUnit({
            name: "Legal alternate",
            team: PBTypes.TeamVals.UPPER,
            attackType: PBTypes.AttackVals.MELEE,
        });
        placeUnit(combat.grid, combat.unitsHolder, shooter, { x: 2, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, forbidden, { x: 8, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, legal, { x: 9, y: 8 });
        shooter.setForbiddenTarget(forbidden.getId());
        shooter.refreshPossibleAttackTypes(true);

        const fightProperties = FightStateManager.getInstance().getFightProperties();
        fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LOWER, 1);
        fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.UPPER, 2);
        const context: IDecisionContext = {
            grid: combat.grid,
            matrix: combat.grid.getMatrix(),
            unitsHolder: combat.unitsHolder,
            pathHelper: new PathHelper(testGridSettings),
            attackHandler: combat.attackHandler,
            fightProperties,
        };
        const actions = getAIStrategy("v0.1").decideTurn(shooter, context);
        const shot = actions.find(
            (action): action is Extract<GameAction, { type: "range_attack" }> => action.type === "range_attack",
        );
        expect(shot).toBeDefined();
        expect(shot?.targetId).toBe(legal.getId());

        fightProperties.startFight();
        fightProperties.startTurn(shooter.getTeam(), 1_000);
        const engine = new GameActionEngine({
            fightProperties,
            grid: combat.grid,
            unitsHolder: combat.unitsHolder,
            moveHandler: new MoveHandler(testGridSettings, combat.grid, combat.unitsHolder),
            sceneLog: new SceneLogMock(),
            attackHandler: combat.attackHandler,
            getCurrentActiveUnitId: () => shooter.getId(),
            getCurrentEnemiesCellsWithinMovementRange: () => [],
        });
        expect(actions.map((action) => engine.apply(action).completed)).toEqual(actions.map(() => true));
        expect(forbidden.getCumulativeHp()).toBe(forbidden.getCumulativeMaxHp());
        expect(legal.getCumulativeHp()).toBeLessThan(legal.getCumulativeMaxHp());
    });
});
