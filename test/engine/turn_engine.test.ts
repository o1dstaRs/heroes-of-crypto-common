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

import { getSpellConfig } from "../../src/configuration/config_provider";
import { NUMBER_OF_LAPS_FIRST_ARMAGEDDON } from "../../src/constants";
import { TurnEngine } from "../../src/engine/turn_engine";
import { createSequenceGameRuntime } from "../../src/engine/runtime";
import type { FightProperties } from "../../src/fights/fight_properties";
import { EffectFactory } from "../../src/effects/effect_factory";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Spell } from "../../src/spells/spell";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const queuedZeros = (count: number): number[] => Array.from({ length: count }, () => 0);

function setupStartedFight(
    opts: {
        leftAttackType?: PBTypes.AttackVals;
        leftMorale?: number;
        leftRangeShots?: number;
        leftInitiative?: number;
        rightMorale?: number;
        rightInitiative?: number;
    } = {},
) {
    const context = createCombatTestContext(PBTypes.GridVals.NORMAL);
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(PBTypes.GridVals.NORMAL);
    fightProperties.startFight();

    const left = createTestUnit({
        name: "Lower",
        team: PBTypes.TeamVals.LEFT,
        attackType: opts.leftAttackType,
        rangeShots: opts.leftRangeShots,
        initiative: opts.leftInitiative ?? 5,
        morale: opts.leftMorale ?? 0,
    });
    const right = createTestUnit({
        name: "Upper",
        team: PBTypes.TeamVals.RIGHT,
        initiative: opts.rightInitiative ?? 3,
        morale: opts.rightMorale ?? 0,
    });

    placeUnit(context.grid, context.unitsHolder, left, { x: 3, y: 3 });
    placeUnit(context.grid, context.unitsHolder, right, { x: 9, y: 9 });
    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LEFT, 1);
    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.RIGHT, 1);

    return {
        ...context,
        fightProperties,
        left,
        right,
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
        expect(result.nextUnit?.getId()).toBe(setup.left.getId());
        expect(setup.fightProperties.getCurrentLap()).toBe(1);
        expect(setup.fightProperties.getFirstTurnMade()).toBe(true);
        expect(setup.fightProperties.getCurrentTurnStart()).toBe(1000);
        expect(result.events).toContainEqual({ type: "lap_initialized", lap: 1 });
        expect(result.events).toContainEqual({
            type: "next_unit_selected",
            unitId: setup.left.getId(),
            team: PBTypes.TeamVals.LEFT,
        });
    });

    it("refreshes active unit attack options with injected range availability", () => {
        const setup = setupStartedFight({
            leftAttackType: PBTypes.AttackVals.RANGE,
            leftRangeShots: 3,
        });
        const engine = new TurnEngine({
            fightProperties: setup.fightProperties,
            grid: setup.grid,
            unitsHolder: setup.unitsHolder,
            moveHandler: setup.moveHandler,
            sceneLog: setup.sceneLog,
            canLandRangeAttack: (unit) => {
                expect(unit.getId()).toBe(setup.left.getId());
                return false;
            },
            runtime: createSequenceGameRuntime({ ints: queuedZeros(12), nowMillis: [1000] }),
        });

        expect(setup.left.getPossibleAttackTypes()).toEqual([]);

        const result = engine.advanceAfterNoActiveUnit();

        expect(result.nextUnit?.getId()).toBe(setup.left.getId());
        expect(setup.left.getPossibleAttackTypes()).toEqual([PBTypes.AttackVals.MELEE]);
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
        expect(advance.nextUnit?.getId()).toBe(setup.left.getId());

        const events = engine.completeTurn(setup.left);

        expect(events).toEqual([
            {
                type: "turn_completed",
                unitId: setup.left.getId(),
                team: PBTypes.TeamVals.LEFT,
                hourglass: false,
            },
        ]);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.left.getId())).toBe(true);
        expect(setup.fightProperties.getCurrentLapTotalTime(PBTypes.TeamVals.LEFT)).toBe(750);
    });

    it("reactivates a surviving hourglass unit after another stack dies before the wait", () => {
        const setup = setupStartedFight();
        const dead = createTestUnit({
            name: "Dead before wait",
            team: PBTypes.TeamVals.RIGHT,
            amountAlive: 0,
        });
        placeUnit(setup.grid, setup.unitsHolder, dead, { x: 10, y: 9 });
        expect(dead.isDead()).toBe(true);

        setup.fightProperties.markFirstTurn();
        setup.fightProperties.addAlreadyMadeTurn(setup.right.getTeam(), setup.right.getId());
        setup.fightProperties.enqueueHourglass(setup.left.getId());
        setup.left.setOnHourglass(true);

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
        expect(result.nextUnit?.getId()).toBe(setup.left.getId());
        expect(setup.fightProperties.getCurrentLap()).toBe(1);
        expect(result.events.some((event) => event.type === "lap_flipped")).toBe(false);
    });

    it("drains a retained dead up-next entry before activating the next living unit", () => {
        const setup = setupStartedFight();
        const dead = createTestUnit({
            name: "Dead queued stack",
            team: PBTypes.TeamVals.RIGHT,
            amountAlive: 0,
        });
        placeUnit(setup.grid, setup.unitsHolder, dead, { x: 10, y: 9 });

        setup.fightProperties.enqueueUpNext(dead.getId());
        setup.fightProperties.enqueueUpNext(setup.left.getId());

        const engine = new TurnEngine({
            fightProperties: setup.fightProperties,
            grid: setup.grid,
            unitsHolder: setup.unitsHolder,
            moveHandler: setup.moveHandler,
            sceneLog: setup.sceneLog,
            runtime: createSequenceGameRuntime({ ints: queuedZeros(12), nowMillis: [1000] }),
        });

        const result = engine.advanceAfterNoActiveUnit();

        expect(result.nextUnit?.getId()).toBe(setup.left.getId());
        expect(result.events).not.toContainEqual({
            type: "next_unit_selected",
            unitId: dead.getId(),
            team: PBTypes.TeamVals.RIGHT,
        });
    });

    it("uses deterministic morale rolls during common lap transitions", () => {
        const setup = setupStartedFight({ leftMorale: 100, rightMorale: -100 });

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
            unitId: setup.left.getId(),
            kind: "plus",
            lap: 1,
        });
        expect(result.events).toContainEqual({
            type: "morale_applied",
            unitId: setup.right.getId(),
            kind: "minus",
            lap: 1,
        });
        expect(setup.left.hasBuffActive("Morale")).toBe(true);
        expect(setup.right.hasDebuffActive("Dismorale")).toBe(true);
    });

    it("rolls fresh morale off a unit's TRUE morale, not the ±20 locked by last lap's Dismorale", () => {
        // Regression: a unit with real +morale that carried a Dismorale from the previous lap. That debuff
        // makes adjustBaseStats lock live morale to -MORALE_MAX (-20). The lap transition drops the debuff
        // then rolls — it must recompute first so applyMoraleRolls reads the true +2, NOT the stale -20.
        // Before the fix this re-rolled Dismorale (kind "minus") even though the unit's morale was positive.
        const setup = setupStartedFight({ leftMorale: 2 });
        setup.left.applyDebuff(new Spell({ spellProperties: getSpellConfig("System", "Dismorale"), amount: 1 }));
        setup.unitsHolder.refreshStackPowerForAllUnits();
        // Sanity: the active Dismorale has locked the live morale negative even though base morale is +2.
        expect(setup.left.getMorale()).toBeLessThan(0);

        const engine = new TurnEngine({
            fightProperties: setup.fightProperties,
            grid: setup.grid,
            unitsHolder: setup.unitsHolder,
            moveHandler: setup.moveHandler,
            sceneLog: setup.sceneLog,
            runtime: createSequenceGameRuntime({ ints: queuedZeros(16), nowMillis: [1000] }),
        });

        const result = engine.advanceAfterNoActiveUnit();

        // rng is all-zeros so the +2 morale always procs — as Morale (plus), never Dismorale.
        expect(result.events).toContainEqual({
            type: "morale_applied",
            unitId: setup.left.getId(),
            kind: "plus",
            lap: 1,
        });
        expect(
            result.events.some(
                (event) =>
                    event.type === "morale_applied" && event.unitId === setup.left.getId() && event.kind === "minus",
            ),
        ).toBe(false);
        expect(setup.left.hasBuffActive("Morale")).toBe(true);
        expect(setup.left.hasDebuffActive("Dismorale")).toBe(false);
    });

    it("flips completed laps and applies non-rendering narrowing mechanics", () => {
        const setup = setupStartedFight();
        setup.fightProperties.markFirstTurn();
        setup.fightProperties.startTurn(PBTypes.TeamVals.LEFT, 0);
        setup.fightProperties.addAlreadyMadeTurn(PBTypes.TeamVals.LEFT, setup.left.getId(), 10);
        setup.fightProperties.addAlreadyMadeTurn(PBTypes.TeamVals.RIGHT, setup.right.getId(), 10);
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
        setup.left.applyEffect(stun!);

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
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.left.getId())).toBe(true);
        expect(setup.left.getMorale()).toBeLessThan(0);
        expect(result.events).toContainEqual({
            type: "next_unit_selected",
            unitId: setup.left.getId(),
            team: PBTypes.TeamVals.LEFT,
        });
        expect(result.events).toContainEqual({
            type: "unit_skipped",
            unitId: setup.left.getId(),
            team: PBTypes.TeamVals.LEFT,
            reason: "effect",
        });
        expect(result.events).toContainEqual({
            type: "turn_completed",
            unitId: setup.left.getId(),
            team: PBTypes.TeamVals.LEFT,
            hourglass: false,
        });
    });

    it("forces a Whirlpool target to skip exactly one activation", () => {
        const setup = setupStartedFight();
        setup.left.applyDebuff(new Spell({ spellProperties: getSpellConfig("Nature", "Whirlpool"), amount: 1 }));
        expect(setup.left.isSkippingThisTurn()).toBe(true);

        const engine = new TurnEngine({
            fightProperties: setup.fightProperties,
            grid: setup.grid,
            unitsHolder: setup.unitsHolder,
            moveHandler: setup.moveHandler,
            sceneLog: setup.sceneLog,
            runtime: createSequenceGameRuntime({
                ints: queuedZeros(40),
                nowMillis: [1000, 1250, 1500, 1750, 2000],
            }),
        });

        const skipped = engine.advanceAfterNoActiveUnit();
        expect(skipped.nextUnit).toBeUndefined();
        expect(skipped.events).toContainEqual({
            type: "unit_skipped",
            unitId: setup.left.getId(),
            team: PBTypes.TeamVals.LEFT,
            reason: "effect",
        });
        expect(setup.left.hasDebuffActive("Whirlpool")).toBe(false);
        expect(setup.left.isSkippingThisTurn()).toBe(false);

        const rightTurn = engine.advanceAfterNoActiveUnit();
        expect(rightTurn.nextUnit?.getId()).toBe(setup.right.getId());
        engine.completeTurn(setup.right);

        let nextLap = engine.advanceAfterNoActiveUnit();
        // Morale/tie ordering may let Upper lead the new lap. Complete it if so; Lower must then activate
        // normally instead of carrying Whirlpool into a second activation.
        if (nextLap.nextUnit?.getId() === setup.right.getId()) {
            engine.completeTurn(setup.right);
            nextLap = engine.advanceAfterNoActiveUnit();
        }
        expect(nextLap.nextUnit?.getId()).toBe(setup.left.getId());
        expect(nextLap.events.some((event) => event.type === "unit_skipped")).toBe(false);
    });

    it("finishes the fight through common turn advancement when one team has no living units", () => {
        const setup = setupStartedFight();
        setup.unitsHolder.deleteUnitById(setup.right.getId(), true);

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
            events: [{ type: "fight_finished", winningTeam: PBTypes.TeamVals.LEFT }],
            fightFinished: true,
        });
        expect(setup.fightProperties.hasFightFinished()).toBe(true);
    });

    it("declares a draw (NO_TEAM) when BOTH teams are wiped out on the same lap", () => {
        const setup = setupStartedFight();
        // Armageddon (and other simultaneous wipes) can empty both teams at once. That is a draw, not
        // an automatic RIGHT win. Regression guard for finishFightIfNeeded, whose ternary used to fall
        // through to RIGHT whenever the LEFT list was empty — including when RIGHT was empty too.
        setup.unitsHolder.deleteUnitById(setup.left.getId(), true);
        setup.unitsHolder.deleteUnitById(setup.right.getId(), true);

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
            events: [{ type: "fight_finished", winningTeam: PBTypes.TeamVals.NO_TEAM }],
            fightFinished: true,
        });
        expect(setup.fightProperties.hasFightFinished()).toBe(true);
    });

    it("applies armageddon damage and deletion through common lap mechanics", () => {
        const setup = setupStartedFight();
        setup.fightProperties.markFirstTurn();
        advanceFightToLap(setup.fightProperties, NUMBER_OF_LAPS_FIRST_ARMAGEDDON - 1);
        setup.fightProperties.addAlreadyMadeTurn(PBTypes.TeamVals.LEFT, setup.left.getId(), 10);
        setup.fightProperties.addAlreadyMadeTurn(PBTypes.TeamVals.RIGHT, setup.right.getId(), 10);

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
            unitId: setup.left.getId(),
            wave: 1,
            damage: 75,
            unitsDied: 1,
        });
        expect(result.events).toContainEqual({
            type: "unit_destroyed",
            unitId: setup.left.getId(),
            reason: "armageddon",
        });
        expect(setup.unitsHolder.getAllUnits().has(setup.left.getId())).toBe(false);
    });

    it("orders multi-unit teams and converts system move results into common events", () => {
        const setup = setupStartedFight();
        const leftFast = createTestUnit({
            name: "Lower Fast",
            team: PBTypes.TeamVals.LEFT,
            initiative: 9,
        });
        const rightFast = createTestUnit({
            name: "Upper Fast",
            team: PBTypes.TeamVals.RIGHT,
            initiative: 8,
        });
        placeUnit(setup.grid, setup.unitsHolder, leftFast, { x: 4, y: 3 });
        placeUnit(setup.grid, setup.unitsHolder, rightFast, { x: 10, y: 9 });

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
        expect(ordered.unitsLeft.map((unit: { getId(): string }) => unit.getId())[0]).toBe(leftFast.getId());
        expect(ordered.unitsRight.map((unit: { getId(): string }) => unit.getId())[0]).toBe(rightFast.getId());

        const systemEvents = engineAny.handleSystemMoveResult({
            log: "line one\nline two",
            unitIdToNewPosition: new Map([[setup.right.getId(), { x: 12, y: 12 }]]),
            unitIdsDestroyed: [setup.right.getId()],
        });

        expect(systemEvents).toEqual([
            {
                type: "unit_moved_by_system",
                unitId: setup.right.getId(),
                position: { x: 12, y: 12 },
                reason: "narrowing",
            },
            { type: "unit_destroyed", unitId: setup.right.getId(), reason: "narrowing" },
        ]);
        expect(setup.unitsHolder.getAllUnits().has(setup.right.getId())).toBe(false);
    });

    it("uses injected tie-break randoms for first-lap and active-lap queue prefetching", () => {
        const firstLapSetup = setupStartedFight({ leftInitiative: 5, rightInitiative: 5 });
        const firstLapEngine = new TurnEngine({
            fightProperties: firstLapSetup.fightProperties,
            grid: firstLapSetup.grid,
            unitsHolder: firstLapSetup.unitsHolder,
            moveHandler: firstLapSetup.moveHandler,
            sceneLog: firstLapSetup.sceneLog,
            runtime: createSequenceGameRuntime({ ints: [1, 0, ...queuedZeros(12)], nowMillis: [1000] }),
        });

        const firstLapResult = firstLapEngine.advanceAfterNoActiveUnit();

        expect([firstLapSetup.left.getId(), firstLapSetup.right.getId()]).toContain(
            firstLapResult.nextUnit?.getId() ?? "",
        );

        const activeLapSetup = setupStartedFight({ leftInitiative: 5, rightInitiative: 5 });
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

        expect([activeLapSetup.left.getId(), activeLapSetup.right.getId()]).toContain(
            activeLapResult.nextUnit?.getId() ?? "",
        );
    });
});

describe("narrowing pushes a unit onto a Fire Wall", () => {
    const buildEngine = (setup: ReturnType<typeof setupStartedFight>) =>
        new TurnEngine({
            fightProperties: setup.fightProperties,
            grid: setup.grid,
            unitsHolder: setup.unitsHolder,
            moveHandler: setup.moveHandler,
            sceneLog: setup.sceneLog,
            runtime: createSequenceGameRuntime({ ints: queuedZeros(24), nowMillis: [1000] }),
        });

    it("burns a stack the closing board shoved into the flames", () => {
        const setup = setupStartedFight();
        const walls = setup.fightProperties.getFireWalls();
        walls.clear();
        // Light every cell the shoved unit ends up standing on.
        walls.addAll(setup.right.getCells());

        const hpBefore = setup.right.getCumulativeHp();
        const events = (buildEngine(setup) as any).handleSystemMoveResult({
            log: "",
            unitIdToNewPosition: new Map([[setup.right.getId(), setup.right.getPosition()]]),
            unitIdsDestroyed: [],
        });

        // The relocation is still reported...
        expect(events).toContainEqual({
            type: "unit_moved_by_system",
            unitId: setup.right.getId(),
            position: setup.right.getPosition(),
            reason: "narrowing",
        });
        // ...and the wall now actually charges for the arrival, which it never used to.
        const burn = events.find((e: { type: string }) => e.type === "fire_wall_burned");
        expect(burn).toBeDefined();
        expect(burn.unitId).toBe(setup.right.getId());
        expect(burn.amount).toBeGreaterThan(0);
        expect(setup.right.getCumulativeHp()).toBeLessThan(hpBefore);
        walls.clear();
    });

    it("leaves a unit shoved onto clear ground untouched", () => {
        const setup = setupStartedFight();
        const walls = setup.fightProperties.getFireWalls();
        walls.clear();
        // A wall exists, but nowhere near where this unit landed.
        walls.add({ x: 14, y: 14 });

        const hpBefore = setup.right.getCumulativeHp();
        const events = (buildEngine(setup) as any).handleSystemMoveResult({
            log: "",
            unitIdToNewPosition: new Map([[setup.right.getId(), setup.right.getPosition()]]),
            unitIdsDestroyed: [],
        });

        expect(events.some((e: { type: string }) => e.type === "fire_wall_burned")).toBe(false);
        expect(setup.right.getCumulativeHp()).toBe(hpBefore);
        walls.clear();
    });

    it("does not burn a unit the narrowing already crushed", () => {
        const setup = setupStartedFight();
        const walls = setup.fightProperties.getFireWalls();
        walls.clear();
        walls.addAll(setup.right.getCells());

        const events = (buildEngine(setup) as any).handleSystemMoveResult({
            log: "",
            unitIdToNewPosition: new Map([[setup.right.getId(), setup.right.getPosition()]]),
            unitIdsDestroyed: [setup.right.getId()],
        });

        expect(events).toContainEqual({ type: "unit_destroyed", unitId: setup.right.getId(), reason: "narrowing" });
        // Already off the board — the flames must not resurrect it to take a hit.
        expect(events.some((e: { type: string }) => e.type === "fire_wall_burned")).toBe(false);
        walls.clear();
    });
});
