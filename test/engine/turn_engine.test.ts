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

import { TurnEngine } from "../../src/engine/turn_engine";
import { createSequenceGameRuntime } from "../../src/engine/runtime";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const queuedZeros = (count: number): number[] => Array.from({ length: count }, () => 0);

function setupStartedFight(opts: { lowerMorale?: number; upperMorale?: number } = {}) {
    const context = createCombatTestContext(PBTypes.GridVals.NORMAL);
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(PBTypes.GridVals.NORMAL);
    fightProperties.startFight();

    const lower = createTestUnit({
        name: "Lower",
        team: PBTypes.TeamVals.LOWER,
        speed: 5,
        morale: opts.lowerMorale ?? 0,
    });
    const upper = createTestUnit({
        name: "Upper",
        team: PBTypes.TeamVals.UPPER,
        speed: 3,
        morale: opts.upperMorale ?? 0,
    });

    placeUnit(context.grid, context.unitsHolder, lower, { x: 3, y: 3 });
    placeUnit(context.grid, context.unitsHolder, upper, { x: 9, y: 9 });
    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LOWER, 1);
    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.UPPER, 1);

    return {
        ...context,
        fightProperties,
        lower,
        upper,
        sceneLog: new SceneLogMock(),
        moveHandler: new MoveHandler(context.grid.getSettings(), context.grid, context.unitsHolder),
    };
}

describe("TurnEngine", () => {
    it("initializes the first lap and activates the next unit with injected clock/runtime", () => {
        const setup = setupStartedFight();
        const engine = new TurnEngine({
            fightProperties: setup.fightProperties,
            grid: setup.grid,
            unitsHolder: setup.unitsHolder,
            moveHandler: setup.moveHandler,
            sceneLog: setup.sceneLog,
            runtime: createSequenceGameRuntime({ ints: queuedZeros(12), nowMillis: [1000] }),
        });

        const result = engine.advanceAfterNoActiveUnit();

        expect(result.fightFinished).toBe(false);
        expect(result.nextUnit?.getId()).toBe(setup.lower.getId());
        expect(setup.fightProperties.getCurrentLap()).toBe(1);
        expect(setup.fightProperties.getFirstTurnMade()).toBe(true);
        expect(setup.fightProperties.getCurrentTurnStart()).toBe(1000);
        expect(result.events).toContainEqual({ type: "lap_initialized", lap: 1 });
        expect(result.events).toContainEqual({
            type: "next_unit_selected",
            unitId: setup.lower.getId(),
            team: PBTypes.TeamVals.LOWER,
        });
    });

    it("completes turns using injected time instead of global time", () => {
        const setup = setupStartedFight();
        const engine = new TurnEngine({
            fightProperties: setup.fightProperties,
            grid: setup.grid,
            unitsHolder: setup.unitsHolder,
            moveHandler: setup.moveHandler,
            sceneLog: setup.sceneLog,
            runtime: createSequenceGameRuntime({ ints: queuedZeros(12), nowMillis: [1000, 1750] }),
        });

        const advance = engine.advanceAfterNoActiveUnit();
        expect(advance.nextUnit?.getId()).toBe(setup.lower.getId());

        const events = engine.completeTurn(setup.lower);

        expect(events).toEqual([
            {
                type: "turn_completed",
                unitId: setup.lower.getId(),
                team: PBTypes.TeamVals.LOWER,
                hourglass: false,
            },
        ]);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.lower.getId())).toBe(true);
        expect(setup.fightProperties.getCurrentLapTotalTime(PBTypes.TeamVals.LOWER)).toBe(750);
    });

    it("uses deterministic morale rolls during common lap transitions", () => {
        const setup = setupStartedFight({ lowerMorale: 100, upperMorale: -100 });

        const engine = new TurnEngine({
            fightProperties: setup.fightProperties,
            grid: setup.grid,
            unitsHolder: setup.unitsHolder,
            moveHandler: setup.moveHandler,
            sceneLog: setup.sceneLog,
            runtime: createSequenceGameRuntime({ ints: queuedZeros(16), nowMillis: [1000] }),
        });

        const result = engine.advanceAfterNoActiveUnit();

        expect(result.events).toContainEqual({
            type: "morale_applied",
            unitId: setup.lower.getId(),
            kind: "plus",
            lap: 1,
        });
        expect(result.events).toContainEqual({
            type: "morale_applied",
            unitId: setup.upper.getId(),
            kind: "minus",
            lap: 1,
        });
        expect(setup.lower.hasBuffActive("Morale")).toBe(true);
        expect(setup.upper.hasDebuffActive("Dismorale")).toBe(true);
    });

    it("flips completed laps and applies non-rendering narrowing mechanics", () => {
        const setup = setupStartedFight();
        setup.fightProperties.markFirstTurn();
        setup.fightProperties.startTurn(PBTypes.TeamVals.LOWER, 0);
        setup.fightProperties.addAlreadyMadeTurn(PBTypes.TeamVals.LOWER, setup.lower.getId(), 10);
        setup.fightProperties.addAlreadyMadeTurn(PBTypes.TeamVals.UPPER, setup.upper.getId(), 10);
        setup.unitsHolder.haveDistancesToClosestEnemiesDecreased();

        const engine = new TurnEngine({
            fightProperties: setup.fightProperties,
            grid: setup.grid,
            unitsHolder: setup.unitsHolder,
            moveHandler: setup.moveHandler,
            sceneLog: setup.sceneLog,
            runtime: createSequenceGameRuntime({ ints: queuedZeros(16), nowMillis: [1000] }),
        });

        const result = engine.advanceAfterNoActiveUnit();

        expect(setup.fightProperties.getCurrentLap()).toBe(2);
        expect(setup.fightProperties.getAdditionalNarrowingLaps()).toBe(1);
        expect(result.events).toContainEqual({ type: "lap_flipped", previousLap: 1, currentLap: 2 });
        expect(result.events).toContainEqual({
            type: "narrowing_applied",
            lap: 2,
            layers: 1,
            encounterCurrent: true,
        });
    });
});
