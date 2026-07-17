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

import { GameActionEngine } from "../../src/engine/action_engine";
import { createSequenceGameRuntime } from "../../src/engine/runtime";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { GridType } from "../../src/generated/protobuf/v1/types_gen";
import {
    getClosestSideCenterDetailed,
    getPositionForCell,
    getRangeAttackSideCenter,
    RangeAttackCellSide,
} from "../../src/grid/grid_math";
import { getDistance } from "../../src/utils/math";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import type { Grid } from "../../src/grid/grid";
import type { Unit } from "../../src/units/unit";
import type { UnitsHolder } from "../../src/units/units_holder";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";
import type { GameEvent } from "../../src/engine/events";

const GS = testGridSettings;

const cellCenter = (x: number, y: number) => getPositionForCell({ x, y }, GS.getMinX(), GS.getStep(), GS.getHalfStep());

interface RangeFightSetup {
    grid: Grid;
    unitsHolder: UnitsHolder;
    engine: GameActionEngine;
    attacker: Unit;
    target: Unit;
    attackHandler: ReturnType<typeof createCombatTestContext>["attackHandler"];
}

const setupRangeFight = (opts: {
    attackerCell: { x: number; y: number };
    targetCell: { x: number; y: number };
    extraEnemies?: { x: number; y: number }[];
    gridType?: GridType;
}): RangeFightSetup => {
    const context = createCombatTestContext(opts.gridType ?? PBTypes.GridVals.NORMAL);
    const { grid, unitsHolder, attackHandler } = context;
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(opts.gridType ?? PBTypes.GridVals.NORMAL);
    fightProperties.startFight();

    const attacker = createTestUnit({
        name: "Archer",
        team: PBTypes.TeamVals.LOWER,
        attackType: PBTypes.AttackVals.RANGE,
        attack: 40,
        damageMin: 30,
        damageMax: 30,
        rangeShots: 3,
        shotDistance: 16,
        speed: 5,
        morale: 4,
    });
    placeUnit(grid, unitsHolder, attacker, opts.attackerCell);
    attacker.refreshPossibleAttackTypes(true);

    const target = createTestUnit({
        name: "Target",
        team: PBTypes.TeamVals.UPPER,
        maxHp: 400,
        amountAlive: 20,
        armor: 0,
    });
    placeUnit(grid, unitsHolder, target, opts.targetCell);

    let enemyCount = 1;
    for (const cell of opts.extraEnemies ?? []) {
        const e = createTestUnit({
            name: `Cover${enemyCount}`,
            team: PBTypes.TeamVals.UPPER,
            maxHp: 400,
            amountAlive: 20,
        });
        placeUnit(grid, unitsHolder, e, cell);
        enemyCount += 1;
    }

    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LOWER, 1);
    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.UPPER, enemyCount);
    fightProperties.startTurn(PBTypes.TeamVals.LOWER, 1000);

    const sceneLog = new SceneLogMock();
    const moveHandler = new MoveHandler(grid.getSettings(), grid, unitsHolder);
    const engine = new GameActionEngine({
        fightProperties,
        grid,
        unitsHolder,
        moveHandler,
        sceneLog,
        attackHandler,
        getCurrentActiveUnitId: () => attacker.getId(),
        runtime: createSequenceGameRuntime({ nowMillis: [1400] }),
    });

    return { grid, unitsHolder, engine, attacker, target, attackHandler };
};

const attackAnimationToPosition = (events: GameEvent[], targetId: string) => {
    const attacked = events.find((e): e is Extract<GameEvent, { type: "unit_attacked" }> => e.type === "unit_attacked");
    expect(attacked).toBeDefined();
    // The primary target's recorded shot animation — this toPosition is exactly what the client
    // replay fires its projectile at, so asserting it proves client render == server trajectory.
    return (
        attacked!.animations.find((a) => a.affectedUnitId === targetId)?.toPosition ??
        attacked!.animations[0]?.toPosition
    );
};

describe("range attack trajectory (server/common engine)", () => {
    it("fires from the attacker center to the selected visible-edge center, not the target center", () => {
        const setup = setupRangeFight({ attackerCell: { x: 1, y: 5 }, targetCell: { x: 8, y: 5 } });
        const hpBefore = setup.target.getCumulativeHp();

        // Aim at the target's LEFT edge — the side facing the attacker, with an empty neighbour.
        const result = setup.engine.apply({
            type: "range_attack",
            attackerId: setup.attacker.getId(),
            targetId: setup.target.getId(),
            aimCell: { x: 8, y: 5 },
            aimSide: RangeAttackCellSide.LEFT,
        });

        expect(result.completed).toBe(true);
        expect(setup.target.getCumulativeHp()).toBeLessThan(hpBefore); // the attack actually happened

        const expectedEdge = getRangeAttackSideCenter(
            GS,
            { x: 8, y: 5 },
            RangeAttackCellSide.LEFT,
            setup.attacker.getPosition(),
        );
        const animTo = attackAnimationToPosition(result.events, setup.target.getId());
        expect(animTo).toBeDefined();
        // The recorded shot lands on the aimed EDGE...
        expect(getDistance(animTo!, expectedEdge)).toBeLessThanOrEqual(1);
        // ...which is a half-cell off the target's geometric center (a center hit would be the bug).
        expect(getDistance(animTo!, setup.target.getPosition())).toBeGreaterThan(GS.getHalfStep() - 2);
    });

    it("the shot line from attacker center to the resolved edge passes through the target", () => {
        const setup = setupRangeFight({ attackerCell: { x: 1, y: 5 }, targetCell: { x: 8, y: 5 } });
        const edge = getRangeAttackSideCenter(
            GS,
            { x: 8, y: 5 },
            RangeAttackCellSide.LEFT,
            setup.attacker.getPosition(),
        );

        const evaluation = setup.attackHandler.evaluateRangeAttack(
            setup.unitsHolder.getAllUnits(),
            setup.attacker,
            setup.attacker.getPosition(), // attacker CENTER
            edge, // selected EDGE center
            false,
            false,
            false,
        );

        expect(evaluation.affectedUnits.flat()).toContain(setup.target);
    });

    it("clamps an aim at a covered (non-observable) edge to a legal observable edge and still lands", () => {
        // Diagonal approach: both LEFT and DOWN of the target face the attacker. Cover DOWN with an
        // enemy, then aim DOWN — the engine must clamp to the observable LEFT edge.
        const setup = setupRangeFight({
            attackerCell: { x: 1, y: 1 },
            targetCell: { x: 8, y: 8 },
            extraEnemies: [{ x: 8, y: 7 }], // sits on the DOWN edge of the target
        });
        const hpBefore = setup.target.getCumulativeHp();

        const result = setup.engine.apply({
            type: "range_attack",
            attackerId: setup.attacker.getId(),
            targetId: setup.target.getId(),
            aimCell: { x: 8, y: 8 },
            aimSide: RangeAttackCellSide.DOWN, // covered → must be clamped
        });

        expect(result.completed).toBe(true);
        expect(setup.target.getCumulativeHp()).toBeLessThan(hpBefore);

        const coveredDownEdge = getRangeAttackSideCenter(
            GS,
            { x: 8, y: 8 },
            RangeAttackCellSide.DOWN,
            setup.attacker.getPosition(),
        );
        const animTo = attackAnimationToPosition(result.events, setup.target.getId());
        expect(animTo).toBeDefined();
        // It did NOT honor the covered DOWN edge.
        expect(getDistance(animTo!, coveredDownEdge)).toBeGreaterThan(2);
    });

    it("a mountain (BLOCK center) on the line intercepts the shot before it reaches the target", () => {
        const setup = setupRangeFight({
            attackerCell: { x: 1, y: 8 },
            targetCell: { x: 14, y: 8 },
            gridType: PBTypes.GridVals.BLOCK_CENTER,
        });
        // Sanity: the two mountains really sit on the shot's line (col 8) — (6,8) is the left mountain,
        // (9,8) the right; (7,8)/(8,8) between them are the walkable corridor, not rock.
        const centerOccupant =
            setup.grid.getOccupantUnitId({ x: 6, y: 8 }) || setup.grid.getOccupantUnitId({ x: 9, y: 8 });
        expect(centerOccupant).toBe("B");

        const evaluation = setup.attackHandler.evaluateRangeAttack(
            setup.unitsHolder.getAllUnits(),
            setup.attacker,
            setup.attacker.getPosition(),
            cellCenter(14, 8),
            false,
            false,
            false,
        );

        // The mountain is hit; the unit behind it is NOT reachable on this line.
        expect(evaluation.attackObstacle).toBeDefined();
        expect(evaluation.affectedUnits.flat()).not.toContain(setup.target);
        // The intercept marks the LEFT mountain the shot first reaches (world-X < the board centre 0),
        // not the old "centre of the board" projection that landed in the empty corridor between the two.
        expect(evaluation.attackObstacle!.position.x).toBeLessThan(0);
        expect(evaluation.attackObstacle!.size).toBe(2);
    });
});

describe("range attack on the two-mountain BLOCK_CENTER map (all angles)", () => {
    // Fire from the attacker centre to an aim point and report whether the rock intercepts and who is hit.
    const evalLine = (setup: RangeFightSetup, aim: { x: number; y: number }) =>
        setup.attackHandler.evaluateRangeAttack(
            setup.unitsHolder.getAllUnits(),
            setup.attacker,
            setup.attacker.getPosition(),
            aim,
            false,
            false,
            false,
        );

    it("a unit reachable through the 2x2 corridor is hit, not the mountain", () => {
        // Attacker and target aligned on corridor column x=8 (x∈{7,8} is the walkable gap between the two
        // mountains). The shot threads the corridor and lands on the unit.
        const setup = setupRangeFight({
            attackerCell: { x: 8, y: 1 },
            targetCell: { x: 8, y: 14 },
            gridType: PBTypes.GridVals.BLOCK_CENTER,
        });
        // The corridor cells really are empty (not rock).
        expect(setup.grid.getOccupantUnitId({ x: 8, y: 7 })).toBe("");
        expect(setup.grid.getOccupantUnitId({ x: 8, y: 8 })).toBe("");

        const edge = getRangeAttackSideCenter(
            GS,
            { x: 8, y: 14 },
            RangeAttackCellSide.DOWN,
            setup.attacker.getPosition(),
        );
        const evaluation = evalLine(setup, edge);
        expect(evaluation.attackObstacle).toBeUndefined();
        expect(evaluation.affectedUnits.flat()).toContain(setup.target);
    });

    it("a unit directly behind a mountain cannot be reached — the shot hits the rock", () => {
        // Target behind the LEFT mountain (column 6) from a shooter on the far side: the line crosses rock
        // at rows 7-8, so the engine intercepts at the mountain and the unit takes no hit.
        const setup = setupRangeFight({
            attackerCell: { x: 6, y: 1 },
            targetCell: { x: 6, y: 14 },
            gridType: PBTypes.GridVals.BLOCK_CENTER,
        });
        const evaluation = evalLine(setup, setup.target.getPosition());
        expect(evaluation.attackObstacle).toBeDefined();
        expect(evaluation.affectedUnits.flat()).not.toContain(setup.target);
        expect(evaluation.attackObstacle!.position.x).toBeLessThan(0); // the LEFT mountain (world-x < 0)
    });

    it("aims at the resolved visible edge, not the target centre, so a unit whose centre line clips the rock is still hit", () => {
        // Regression for the client "Hit the mountain" check that evaluated the target's geometric CENTRE.
        // Attacker (4,1), target (8,10) above the corridor: the attacker->centre line clips the mountain
        // corner, but the attacker-facing DOWN edge threads past it. Centre => "Hit the mountain" (unit
        // unattackable); the resolved edge => the shot lands on the unit.
        const setup = setupRangeFight({
            attackerCell: { x: 4, y: 1 },
            targetCell: { x: 8, y: 10 },
            gridType: PBTypes.GridVals.BLOCK_CENTER,
        });

        // 1) The CENTRE line is blocked by the rock — this is exactly what the buggy client check used.
        const centre = evalLine(setup, setup.target.getPosition());
        expect(centre.attackObstacle).toBeDefined();
        expect(centre.affectedUnits.flat()).not.toContain(setup.target);

        // 2) The resolved visible edge is the DOWN edge facing the attacker, and its line is clear.
        const aim = getClosestSideCenterDetailed(
            setup.grid.getMatrix(),
            GS,
            setup.target.getPosition(),
            setup.attacker.getPosition(),
            setup.target.getPosition(),
            setup.attacker.isSmallSize(),
            setup.target.isSmallSize(),
            setup.attacker.getTeam(),
            false,
        );
        expect(aim).toBeDefined();
        expect(aim!.side).toBe(RangeAttackCellSide.DOWN);

        const edge = evalLine(setup, aim!.position);
        expect(edge.attackObstacle).toBeUndefined();
        expect(edge.affectedUnits.flat()).toContain(setup.target);

        // 3) End to end: the engine action lands on the unit, not the rock.
        const hpBefore = setup.target.getCumulativeHp();
        const result = setup.engine.apply({
            type: "range_attack",
            attackerId: setup.attacker.getId(),
            targetId: setup.target.getId(),
            aimCell: { x: 8, y: 10 },
            aimSide: RangeAttackCellSide.DOWN,
        });
        expect(result.completed).toBe(true);
        expect(setup.target.getCumulativeHp()).toBeLessThan(hpBefore);
    });

    it("once the mountains are cleared the shot passes through and reaches the unit behind", () => {
        const setup = setupRangeFight({
            attackerCell: { x: 6, y: 1 },
            targetCell: { x: 6, y: 14 },
            gridType: PBTypes.GridVals.BLOCK_CENTER,
        });
        // Before: the standing mountain blocks the column-6 shot.
        expect(evalLine(setup, setup.target.getPosition()).attackObstacle).toBeDefined();

        setup.grid.cleanupCenterObstacle(); // both mountains crumble to walkable ground

        const after = evalLine(setup, setup.target.getPosition());
        expect(after.attackObstacle).toBeUndefined();
        expect(after.affectedUnits.flat()).toContain(setup.target);
    });
});
