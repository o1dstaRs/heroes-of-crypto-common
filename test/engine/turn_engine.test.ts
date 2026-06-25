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

import { NUMBER_OF_LAPS_FIRST_ARMAGEDDON } from "../../src/constants";
import { TurnEngine } from "../../src/engine/turn_engine";
import { createSequenceGameRuntime } from "../../src/engine/runtime";
import type { FightProperties } from "../../src/fights/fight_properties";
import { EffectFactory } from "../../src/effects/effect_factory";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const queuedZeros = (count: number): number[] => Array.from({ length: count }, () => 0);

function setupStartedFight(
    opts: {
        lowerAttackType?: PBTypes.AttackVals;
        lowerMorale?: number;
        lowerRangeShots?: number;
        lowerSpeed?: number;
        upperMorale?: number;
        upperSpeed?: number;
    } = {},
) {
    const context = createCombatTestContext(PBTypes.GridVals.NORMAL);
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(PBTypes.GridVals.NORMAL);
    fightProperties.startFight();

    const lower = createTestUnit({
        name: "Lower",
        team: PBTypes.TeamVals.LOWER,
        attackType: opts.lowerAttackType,
        rangeShots: opts.lowerRangeShots,
        speed: opts.lowerSpeed ?? 5,
        morale: opts.lowerMorale ?? 0,
    });
    const upper = createTestUnit({
        name: "Upper",
        team: PBTypes.TeamVals.UPPER,
        speed: opts.upperSpeed ?? 3,
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

function advanceFightToLap(fightProperties: FightProperties, lap: number) {
    while (fightProperties.getCurrentLap() < lap) {
        fightProperties.flipLap();
    }
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

    it("refreshes active unit attack options with injected range availability", () => {
        const setup = setupStartedFight({
            lowerAttackType: PBTypes.AttackVals.RANGE,
            lowerRangeShots: 3,
        });
        const engine = new TurnEngine({
            fightProperties: setup.fightProperties,
            grid: setup.grid,
            unitsHolder: setup.unitsHolder,
            moveHandler: setup.moveHandler,
            sceneLog: setup.sceneLog,
            canLandRangeAttack: (unit) => {
                expect(unit.getId()).toBe(setup.lower.getId());
                return false;
            },
            runtime: createSequenceGameRuntime({ ints: queuedZeros(12), nowMillis: [1000] }),
        });

        expect(setup.lower.getPossibleAttackTypes()).toEqual([]);

        const result = engine.advanceAfterNoActiveUnit();

        expect(result.nextUnit?.getId()).toBe(setup.lower.getId());
        expect(setup.lower.getPossibleAttackTypes()).toEqual([PBTypes.AttackVals.MELEE]);
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

    it("completes a selected skipping unit turn through common mechanics", () => {
        const setup = setupStartedFight();
        const stun = new EffectFactory().makeEffect("Stun");
        expect(stun).toBeDefined();
        setup.lower.applyEffect(stun!);

        const engine = new TurnEngine({
            fightProperties: setup.fightProperties,
            grid: setup.grid,
            unitsHolder: setup.unitsHolder,
            moveHandler: setup.moveHandler,
            sceneLog: setup.sceneLog,
            runtime: createSequenceGameRuntime({ ints: queuedZeros(12), nowMillis: [1000, 1250] }),
        });

        const result = engine.advanceAfterNoActiveUnit();

        expect(result.fightFinished).toBe(false);
        expect(result.nextUnit).toBeUndefined();
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.lower.getId())).toBe(true);
        expect(setup.lower.getMorale()).toBeLessThan(0);
        expect(result.events).toContainEqual({
            type: "next_unit_selected",
            unitId: setup.lower.getId(),
            team: PBTypes.TeamVals.LOWER,
        });
        expect(result.events).toContainEqual({
            type: "unit_skipped",
            unitId: setup.lower.getId(),
            team: PBTypes.TeamVals.LOWER,
            reason: "effect",
        });
        expect(result.events).toContainEqual({
            type: "turn_completed",
            unitId: setup.lower.getId(),
            team: PBTypes.TeamVals.LOWER,
            hourglass: false,
        });
    });

    it("finishes the fight through common turn advancement when one team has no living units", () => {
        const setup = setupStartedFight();
        setup.unitsHolder.deleteUnitById(setup.upper.getId(), true);

        const engine = new TurnEngine({
            fightProperties: setup.fightProperties,
            grid: setup.grid,
            unitsHolder: setup.unitsHolder,
            moveHandler: setup.moveHandler,
            sceneLog: setup.sceneLog,
            runtime: createSequenceGameRuntime({ ints: queuedZeros(12), nowMillis: [1000] }),
        });

        const result = engine.advanceAfterNoActiveUnit();

        expect(result).toEqual({
            events: [{ type: "fight_finished", winningTeam: PBTypes.TeamVals.LOWER }],
            fightFinished: true,
        });
        expect(setup.fightProperties.hasFightFinished()).toBe(true);
    });

    it("applies armageddon damage and deletion through common lap mechanics", () => {
        const setup = setupStartedFight();
        setup.fightProperties.markFirstTurn();
        advanceFightToLap(setup.fightProperties, NUMBER_OF_LAPS_FIRST_ARMAGEDDON - 1);
        setup.fightProperties.addAlreadyMadeTurn(PBTypes.TeamVals.LOWER, setup.lower.getId(), 10);
        setup.fightProperties.addAlreadyMadeTurn(PBTypes.TeamVals.UPPER, setup.upper.getId(), 10);

        const engine = new TurnEngine({
            fightProperties: setup.fightProperties,
            grid: setup.grid,
            unitsHolder: setup.unitsHolder,
            moveHandler: setup.moveHandler,
            sceneLog: setup.sceneLog,
            runtime: createSequenceGameRuntime({ ints: queuedZeros(24), nowMillis: [1000] }),
        });

        const result = engine.advanceAfterNoActiveUnit();

        expect(setup.fightProperties.getCurrentLap()).toBe(NUMBER_OF_LAPS_FIRST_ARMAGEDDON);
        expect(result.events).toContainEqual({
            type: "lap_flipped",
            previousLap: NUMBER_OF_LAPS_FIRST_ARMAGEDDON - 1,
            currentLap: NUMBER_OF_LAPS_FIRST_ARMAGEDDON,
        });
        expect(result.events).toContainEqual({
            type: "armageddon_applied",
            unitId: setup.lower.getId(),
            wave: 1,
            damage: 75,
            unitsDied: 1,
        });
        expect(result.events).toContainEqual({
            type: "unit_destroyed",
            unitId: setup.lower.getId(),
            reason: "armageddon",
        });
        expect(setup.unitsHolder.getAllUnits().has(setup.lower.getId())).toBe(false);
    });

    it("orders multi-unit teams and converts system move results into common events", () => {
        const setup = setupStartedFight();
        const lowerFast = createTestUnit({
            name: "Lower Fast",
            team: PBTypes.TeamVals.LOWER,
            speed: 9,
        });
        const upperFast = createTestUnit({
            name: "Upper Fast",
            team: PBTypes.TeamVals.UPPER,
            speed: 8,
        });
        placeUnit(setup.grid, setup.unitsHolder, lowerFast, { x: 4, y: 3 });
        placeUnit(setup.grid, setup.unitsHolder, upperFast, { x: 10, y: 9 });

        const engine = new TurnEngine({
            fightProperties: setup.fightProperties,
            grid: setup.grid,
            unitsHolder: setup.unitsHolder,
            moveHandler: setup.moveHandler,
            sceneLog: setup.sceneLog,
            runtime: createSequenceGameRuntime({ ints: queuedZeros(24), nowMillis: [1000] }),
        });
        const engineAny = engine as any;

        const ordered = engineAny.getOrderedTurnUnits();
        expect(ordered.unitsLower.map((unit: { getId(): string }) => unit.getId())[0]).toBe(lowerFast.getId());
        expect(ordered.unitsUpper.map((unit: { getId(): string }) => unit.getId())[0]).toBe(upperFast.getId());

        const systemEvents = engineAny.handleSystemMoveResult({
            log: "line one\nline two",
            unitIdToNewPosition: new Map([[setup.upper.getId(), { x: 12, y: 12 }]]),
            unitIdsDestroyed: [setup.upper.getId()],
        });

        expect(systemEvents).toEqual([
            {
                type: "unit_moved_by_system",
                unitId: setup.upper.getId(),
                position: { x: 12, y: 12 },
                reason: "narrowing",
            },
            { type: "unit_destroyed", unitId: setup.upper.getId(), reason: "narrowing" },
        ]);
        expect(setup.unitsHolder.getAllUnits().has(setup.upper.getId())).toBe(false);
    });

    it("uses injected tie-break randoms for first-lap and active-lap queue prefetching", () => {
        const firstLapSetup = setupStartedFight({ lowerSpeed: 5, upperSpeed: 5 });
        const firstLapEngine = new TurnEngine({
            fightProperties: firstLapSetup.fightProperties,
            grid: firstLapSetup.grid,
            unitsHolder: firstLapSetup.unitsHolder,
            moveHandler: firstLapSetup.moveHandler,
            sceneLog: firstLapSetup.sceneLog,
            runtime: createSequenceGameRuntime({ ints: [1, 0, ...queuedZeros(12)], nowMillis: [1000] }),
        });

        const firstLapResult = firstLapEngine.advanceAfterNoActiveUnit();

        expect([firstLapSetup.lower.getId(), firstLapSetup.upper.getId()]).toContain(
            firstLapResult.nextUnit?.getId() ?? "",
        );

        const activeLapSetup = setupStartedFight({ lowerSpeed: 5, upperSpeed: 5 });
        activeLapSetup.fightProperties.markFirstTurn();
        activeLapSetup.fightProperties.flipLap();
        const activeLapEngine = new TurnEngine({
            fightProperties: activeLapSetup.fightProperties,
            grid: activeLapSetup.grid,
            unitsHolder: activeLapSetup.unitsHolder,
            moveHandler: activeLapSetup.moveHandler,
            sceneLog: activeLapSetup.sceneLog,
            runtime: createSequenceGameRuntime({ ints: [0, 1, ...queuedZeros(12)], nowMillis: [2000] }),
        });

        const activeLapResult = activeLapEngine.advanceAfterNoActiveUnit();

        expect([activeLapSetup.lower.getId(), activeLapSetup.upper.getId()]).toContain(
            activeLapResult.nextUnit?.getId() ?? "",
        );
    });
});
