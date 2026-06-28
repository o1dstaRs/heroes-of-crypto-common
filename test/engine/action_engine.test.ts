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

import { MAX_HITS_MOUNTAIN } from "../../src/constants";
import { getSpellConfig } from "../../src/configuration/config_provider";
import { GameActionEngine, type IGameActionEngineContext } from "../../src/engine/action_engine";
import type { GameAction } from "../../src/engine/actions";
import { createSequenceGameRuntime } from "../../src/engine/runtime";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { AttackType, GridType, MovementType, UnitSizeType } from "../../src/generated/protobuf/v1/types_gen";
import type { IWeightedRoute } from "../../src/grid/path_definitions";
import { getPositionForCell, RangeAttackCellSide } from "../../src/grid/grid_math";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Spell } from "../../src/spells/spell";
import { SpellProperties, SpellTargetType } from "../../src/spells/spell_properties";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const setupActionFight = (
    opts: {
        activeUnit?: "lower" | "upper";
        lowerAttackType?: AttackType;
        lowerAttack?: number;
        lowerAbilities?: string[];
        lowerDamageMin?: number;
        lowerDamageMax?: number;
        lowerRangeShots?: number;
        lowerSize?: UnitSizeType;
        lowerSpells?: string[];
        lowerStackPower?: number;
        supportMovementType?: MovementType;
        upperMovementType?: MovementType;
        supportCell?: { x: number; y: number };
        upperCell?: { x: number; y: number };
        upperAbilities?: string[];
        upperAmountAlive?: number;
        upperArmor?: number;
        upperMaxHp?: number;
        upperSpells?: string[];
        lowerUnitsAlive?: number;
        currentActiveKnownPaths?: Map<number, IWeightedRoute[]>;
        currentEnemiesCellsWithinMovementRange?: { x: number; y: number }[];
        createSummonedUnit?: IGameActionEngineContext["createSummonedUnit"];
        gridType?: GridType;
    } = {},
) => {
    const gridType = opts.gridType ?? PBTypes.GridVals.NORMAL;
    const context = createCombatTestContext(gridType);
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(gridType);
    fightProperties.startFight();

    const lower = createTestUnit({
        name: "Lower",
        team: PBTypes.TeamVals.LOWER,
        attackType: opts.lowerAttackType ?? PBTypes.AttackVals.MELEE,
        attack: opts.lowerAttack,
        damageMin: opts.lowerDamageMin,
        damageMax: opts.lowerDamageMax,
        abilities: opts.lowerAbilities,
        rangeShots: opts.lowerRangeShots ?? 0,
        size: opts.lowerSize,
        speed: 5,
        morale: 4,
        spells: opts.lowerSpells,
        stackPower: opts.lowerStackPower,
    });
    const upper = createTestUnit({
        name: "Upper",
        team: PBTypes.TeamVals.UPPER,
        speed: 3,
        morale: 4,
        abilities: opts.upperAbilities,
        amountAlive: opts.upperAmountAlive,
        armor: opts.upperArmor,
        maxHp: opts.upperMaxHp,
        spells: opts.upperSpells,
        movementType: opts.upperMovementType,
    });
    const lowerSupport = createTestUnit({
        name: "Lower Support",
        team: PBTypes.TeamVals.LOWER,
        speed: 2,
        movementType: opts.supportMovementType,
    });

    placeUnit(context.grid, context.unitsHolder, lower, { x: 3, y: 3 });
    placeUnit(context.grid, context.unitsHolder, upper, opts.upperCell ?? { x: 9, y: 9 });
    placeUnit(context.grid, context.unitsHolder, lowerSupport, opts.supportCell ?? { x: 4, y: 3 });
    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LOWER, opts.lowerUnitsAlive ?? 2);
    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.UPPER, 1);
    fightProperties.startTurn(PBTypes.TeamVals.LOWER, 1000);

    const activeUnit = opts.activeUnit === "upper" ? upper : lower;
    const sceneLog = new SceneLogMock();
    const moveHandler = new MoveHandler(context.grid.getSettings(), context.grid, context.unitsHolder);
    const engine = new GameActionEngine({
        fightProperties,
        grid: context.grid,
        unitsHolder: context.unitsHolder,
        moveHandler,
        sceneLog,
        attackHandler: context.attackHandler,
        getCurrentActiveUnitId: () => activeUnit.getId(),
        getCurrentActiveKnownPaths: () => opts.currentActiveKnownPaths,
        getCurrentEnemiesCellsWithinMovementRange: () => opts.currentEnemiesCellsWithinMovementRange,
        createSummonedUnit: opts.createSummonedUnit,
        runtime: createSequenceGameRuntime({ nowMillis: [1400] }),
    });

    return { ...context, fightProperties, lower, lowerSupport, upper, activeUnit, sceneLog, moveHandler, engine };
};

const setupPlacementFight = (
    opts: {
        amountAlive?: number;
        canSplitUnit?: IGameActionEngineContext["canSplitUnit"];
        createSplitUnit?: IGameActionEngineContext["createSplitUnit"];
    } = {},
) => {
    const context = createCombatTestContext(PBTypes.GridVals.NORMAL);
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(PBTypes.GridVals.NORMAL);
    const sceneLog = new SceneLogMock();
    const moveHandler = new MoveHandler(context.grid.getSettings(), context.grid, context.unitsHolder);
    const unit = createTestUnit({
        name: "Peasant",
        team: PBTypes.TeamVals.LOWER,
        amountAlive: opts.amountAlive,
    });
    context.unitsHolder.addUnit(unit);
    const engine = new GameActionEngine({
        fightProperties,
        grid: context.grid,
        unitsHolder: context.unitsHolder,
        moveHandler,
        sceneLog,
        canPlaceUnit: (_unit, cells) => cells.every((cell) => cell.x <= 4 && cell.y <= 4),
        canSplitUnit: opts.canSplitUnit,
        createSplitUnit: opts.createSplitUnit,
    });

    return { ...context, fightProperties, unit, sceneLog, moveHandler, engine };
};

const cellKey = (cell: { x: number; y: number }): number => (cell.x << 4) | cell.y;

const weightedRoute = (route: { x: number; y: number }[]): IWeightedRoute => ({
    cell: route[route.length - 1],
    route,
    weight: Math.max(0, route.length - 1),
    firstAggrMet: false,
    hasLavaCell: false,
    hasWaterCell: false,
});

describe("GameActionEngine", () => {
    it("ends the active unit turn through common turn mechanics (manual end is not a skip)", () => {
        const setup = setupActionFight();
        const moraleBefore = setup.lower.getMorale();

        const result = setup.engine.apply({ type: "end_turn", unitId: setup.lower.getId() });

        expect(result.completed).toBe(true);
        expect(result.rejectionReason).toBeUndefined();
        // A manual end-of-turn is NOT a skip: no unit_skipped event and no morale penalty.
        expect(result.events.some((event) => event.type === "unit_skipped")).toBe(false);
        expect(result.events).toContainEqual({
            type: "turn_completed",
            unitId: setup.lower.getId(),
            team: PBTypes.TeamVals.LOWER,
            hourglass: false,
        });
        setup.unitsHolder.refreshStackPowerForAllUnits();
        expect(setup.lower.getMorale()).toBe(moraleBefore);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.lower.getId())).toBe(true);
        expect(setup.fightProperties.getCurrentLapTotalTime(PBTypes.TeamVals.LOWER)).toBe(400);
    });

    it("keeps the full +3 distance morale when a move also ends the unit's turn", () => {
        const path = [
            { x: 3, y: 3 },
            { x: 3, y: 4 },
            { x: 3, y: 5 },
            { x: 3, y: 6 },
        ];
        const targetCell = path[path.length - 1];
        const setup = setupActionFight({
            currentActiveKnownPaths: new Map([[cellKey(targetCell), [weightedRoute(path)]]]),
        });
        expect(setup.lower.getMorale()).toBe(4);

        // Move toward the enemy (+3), then end the turn manually — the end must NOT apply the skip
        // penalty, so the net stays +3 (regression: it used to net -1).
        expect(setup.engine.apply({ type: "move_unit", unitId: setup.lower.getId(), path }).completed).toBe(true);
        expect(setup.engine.apply({ type: "end_turn", unitId: setup.lower.getId() }).completed).toBe(true);

        setup.unitsHolder.refreshStackPowerForAllUnits();
        expect(setup.lower.getMorale()).toBe(7);
    });

    it("applies the full -3 distance morale when a move away also ends the turn", () => {
        // Enemy is at (9,9); lower starts at (3,3) morale 4. This path walks away from it.
        const path = [
            { x: 3, y: 3 },
            { x: 3, y: 2 },
            { x: 3, y: 1 },
        ];
        const targetCell = path[path.length - 1];
        const setup = setupActionFight({
            currentActiveKnownPaths: new Map([[cellKey(targetCell), [weightedRoute(path)]]]),
        });
        expect(setup.lower.getMorale()).toBe(4);

        expect(setup.engine.apply({ type: "move_unit", unitId: setup.lower.getId(), path }).completed).toBe(true);
        expect(setup.engine.apply({ type: "end_turn", unitId: setup.lower.getId() }).completed).toBe(true);

        setup.unitsHolder.refreshStackPowerForAllUnits();
        expect(setup.lower.getMorale()).toBe(1);
    });

    it("waits on hourglass without marking the unit as having completed the lap", () => {
        const setup = setupActionFight();

        const result = setup.engine.apply({ type: "wait_turn", unitId: setup.lower.getId() });

        expect(result.completed).toBe(true);
        expect(result.events).toEqual([
            { type: "unit_waited", unitId: setup.lower.getId(), team: PBTypes.TeamVals.LOWER },
            {
                type: "turn_completed",
                unitId: setup.lower.getId(),
                team: PBTypes.TeamVals.LOWER,
                hourglass: true,
            },
        ]);
        expect(setup.lower.isOnHourglass()).toBe(true);
        expect(setup.fightProperties.hourglassIncludes(setup.lower.getId())).toBe(true);
        expect(setup.fightProperties.hasAlreadyHourglass(setup.lower.getId())).toBe(true);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.lower.getId())).toBe(false);
    });

    it("defends with luck shield and completes the unit turn", () => {
        const setup = setupActionFight();

        const result = setup.engine.apply({ type: "defend_turn", unitId: setup.lower.getId() });

        expect(result.completed).toBe(true);
        expect(result.events).toContainEqual({
            type: "unit_defended",
            unitId: setup.lower.getId(),
            team: PBTypes.TeamVals.LOWER,
        });
        expect(result.events).toContainEqual({
            type: "turn_completed",
            unitId: setup.lower.getId(),
            team: PBTypes.TeamVals.LOWER,
            hourglass: false,
        });
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.lower.getId())).toBe(true);
    });

    it("rejects hourglass when the active unit is the only living unit on its team", () => {
        const setup = setupActionFight({ lowerUnitsAlive: 1 });

        const result = setup.engine.apply({ type: "wait_turn", unitId: setup.lower.getId() });

        expect(result).toEqual({
            completed: false,
            events: [],
            rejectionReason: "hourglass_not_available",
            message: undefined,
        });
        expect(setup.lower.isOnHourglass()).toBe(false);
        expect(setup.fightProperties.hourglassIncludes(setup.lower.getId())).toBe(false);
    });

    it("rejects actions for units that are not currently active", () => {
        const setup = setupActionFight();

        const result = setup.engine.apply({ type: "end_turn", unitId: setup.upper.getId() });

        expect(result).toEqual({
            completed: false,
            events: [],
            rejectionReason: "unit_not_active",
            message: undefined,
        });
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.upper.getId())).toBe(false);
    });

    it("selects an available attack type for the active unit", () => {
        const setup = setupActionFight({ lowerAttackType: PBTypes.AttackVals.RANGE, lowerRangeShots: 3 });
        setup.lower.refreshPossibleAttackTypes(true);

        const result = setup.engine.apply({
            type: "select_attack_type",
            unitId: setup.lower.getId(),
            attackType: PBTypes.AttackVals.MELEE,
        });

        expect(result.completed).toBe(true);
        expect(result.events).toEqual([
            {
                type: "attack_type_selected",
                unitId: setup.lower.getId(),
                team: PBTypes.TeamVals.LOWER,
                attackType: PBTypes.AttackVals.MELEE,
            },
        ]);
        expect(setup.lower.getAttackTypeSelection()).toBe(PBTypes.AttackVals.MELEE);
    });

    it("accepts selecting the already selected attack type as an idempotent action", () => {
        const setup = setupActionFight({ lowerAttackType: PBTypes.AttackVals.RANGE, lowerRangeShots: 3 });
        setup.lower.refreshPossibleAttackTypes(false);
        expect(setup.lower.getAttackTypeSelection()).toBe(PBTypes.AttackVals.MELEE);

        const result = setup.engine.apply({
            type: "select_attack_type",
            unitId: setup.lower.getId(),
            attackType: PBTypes.AttackVals.MELEE,
        });

        expect(result).toEqual({ completed: true, events: [] });
        expect(setup.lower.getAttackTypeSelection()).toBe(PBTypes.AttackVals.MELEE);
    });

    it("moves the active unit and leaves the turn open", () => {
        const setup = setupActionFight();
        const targetCell = { x: 3, y: 4 };

        const result = setup.engine.apply({
            type: "move_unit",
            unitId: setup.lower.getId(),
            path: [targetCell],
        });

        expect(result.completed).toBe(true);
        expect(result.events).toHaveLength(1);
        expect(result.events[0]).toMatchObject({
            type: "unit_moved",
            unitId: setup.lower.getId(),
            path: [targetCell],
            targetCells: [targetCell],
        });
        expect(setup.lower.getBaseCell()).toEqual(targetCell);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.lower.getId())).toBe(false);
    });

    it("accepts move routes that include the current cell", () => {
        const currentCell = { x: 3, y: 3 };
        const path = [currentCell, { x: 3, y: 4 }, { x: 3, y: 5 }, { x: 3, y: 6 }];
        const targetCell = path[path.length - 1];
        const setup = setupActionFight({
            currentActiveKnownPaths: new Map([[cellKey(targetCell), [weightedRoute(path)]]]),
        });

        const result = setup.engine.apply({
            type: "move_unit",
            unitId: setup.lower.getId(),
            path,
        });

        expect(result.completed).toBe(true);
        expect(result.events[0]).toMatchObject({
            type: "unit_moved",
            unitId: setup.lower.getId(),
            path,
            targetCells: [targetCell],
        });
        expect(setup.lower.getBaseCell()).toEqual(targetCell);
    });

    it("gives +3 morale end-to-end when a move_unit shortens the distance to the enemy", () => {
        // Enemy (upper) is at (9,9); lower starts at (3,3) with morale 4. This path walks toward it.
        const path = [
            { x: 3, y: 3 },
            { x: 3, y: 4 },
            { x: 3, y: 5 },
            { x: 3, y: 6 },
        ];
        const targetCell = path[path.length - 1];
        const setup = setupActionFight({
            currentActiveKnownPaths: new Map([[cellKey(targetCell), [weightedRoute(path)]]]),
        });
        expect(setup.lower.getMorale()).toBe(4);

        const result = setup.engine.apply({
            type: "move_unit",
            unitId: setup.lower.getId(),
            path,
        });
        expect(result.completed).toBe(true);

        // refreshStackPowerForAllUnits syncs the morale change (written to initialUnitProperties by
        // increaseMorale) into unitProperties, exactly as the scene does after a move.
        setup.unitsHolder.refreshStackPowerForAllUnits();
        expect(setup.lower.getMorale()).toBe(7);
    });

    it("rejects direct moves that are not present in current active known paths", () => {
        const currentCell = { x: 3, y: 3 };
        const allowedCell = { x: 3, y: 4 };
        const forbiddenCell = { x: 3, y: 5 };
        const setup = setupActionFight({
            currentActiveKnownPaths: new Map([[cellKey(allowedCell), [weightedRoute([currentCell, allowedCell])]]]),
        });

        const result = setup.engine.apply({
            type: "move_unit",
            unitId: setup.lower.getId(),
            path: [currentCell, forbiddenCell],
        });

        expect(result.completed).toBe(false);
        expect(result.rejectionReason).toBe("invalid_move");
        expect(setup.lower.getBaseCell()).toEqual(currentCell);
    });

    it("rejects move routes whose travelled cells exceed unit steps", () => {
        const setup = setupActionFight();
        const currentCell = setup.lower.getBaseCell();

        const result = setup.engine.apply({
            type: "move_unit",
            unitId: setup.lower.getId(),
            path: [currentCell, { x: 3, y: 4 }, { x: 3, y: 5 }, { x: 3, y: 6 }, { x: 3, y: 7 }],
        });

        expect(result.completed).toBe(false);
        expect(result.rejectionReason).toBe("invalid_move");
        expect(setup.lower.getBaseCell()).toEqual(currentCell);
    });

    it("rejects discontinuous move routes when known paths are unavailable", () => {
        const setup = setupActionFight();
        const currentCell = setup.lower.getBaseCell();
        const targetCell = { x: 3, y: 5 };

        const result = setup.engine.apply({
            type: "move_unit",
            unitId: setup.lower.getId(),
            path: [targetCell],
        });

        expect(result.completed).toBe(false);
        expect(result.rejectionReason).toBe("invalid_move");
        expect(setup.lower.getBaseCell()).toEqual(currentCell);
    });

    it("accepts large footprint-only moves when the footprint matches a known route", () => {
        const currentCell = { x: 3, y: 3 };
        const routeAnchor = { x: 5, y: 5 };
        const route = [currentCell, { x: 4, y: 4 }, routeAnchor];
        const footprint = [
            { x: 4, y: 4 },
            { x: 5, y: 4 },
            { x: 4, y: 5 },
            { x: 5, y: 5 },
        ];
        const setup = setupActionFight({
            lowerSize: PBTypes.UnitSizeVals.LARGE,
            currentActiveKnownPaths: new Map([[cellKey(routeAnchor), [weightedRoute(route)]]]),
        });

        const result = setup.engine.apply({
            type: "move_unit",
            unitId: setup.lower.getId(),
            path: footprint,
            targetCells: footprint,
        });

        expect(result.completed).toBe(true);
        expect(result.events[0]).toMatchObject({
            type: "unit_moved",
            unitId: setup.lower.getId(),
            path: footprint,
            targetCells: footprint,
        });
    });

    it("performs a melee attack and completes the active unit turn", () => {
        const setup = setupActionFight({
            supportCell: { x: 2, y: 3 },
            upperCell: { x: 4, y: 3 },
        });
        setup.lower.refreshPossibleAttackTypes(true);

        const result = setup.engine.apply({
            type: "melee_attack",
            attackerId: setup.lower.getId(),
            targetId: setup.upper.getId(),
            attackFrom: { x: 3, y: 3 },
        });

        expect(result.completed).toBe(true);
        expect(result.events).toContainEqual(
            expect.objectContaining({
                type: "unit_attacked",
                attackType: "melee",
                attackerId: setup.lower.getId(),
                targetId: setup.upper.getId(),
            }),
        );
        expect(result.events).toContainEqual({
            type: "turn_completed",
            unitId: setup.lower.getId(),
            team: PBTypes.TeamVals.LOWER,
            hourglass: false,
        });
        expect(setup.upper.getCumulativeHp()).toBeLessThan(setup.upper.getCumulativeMaxHp());
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.lower.getId())).toBe(true);
    });

    it("performs a move-melee attack when the supplied path matches known paths", () => {
        const currentCell = { x: 3, y: 3 };
        const attackFrom = { x: 4, y: 3 };
        const path = [currentCell, attackFrom];
        const setup = setupActionFight({
            supportCell: { x: 2, y: 3 },
            upperCell: { x: 5, y: 3 },
            currentActiveKnownPaths: new Map([[cellKey(attackFrom), [weightedRoute(path)]]]),
        });
        setup.lower.refreshPossibleAttackTypes(true);

        const result = setup.engine.apply({
            type: "melee_attack",
            attackerId: setup.lower.getId(),
            targetId: setup.upper.getId(),
            attackFrom,
            path,
        });

        expect(result.completed).toBe(true);
        expect(result.events).toContainEqual(
            expect.objectContaining({
                type: "unit_attacked",
                attackType: "melee",
                attackerId: setup.lower.getId(),
                targetId: setup.upper.getId(),
            }),
        );
        expect(setup.lower.getBaseCell()).toEqual(attackFrom);
    });

    it("rejects move-melee attacks when the supplied path is not in known paths", () => {
        const currentCell = { x: 3, y: 3 };
        const allowedCell = { x: 3, y: 4 };
        const attackFrom = { x: 4, y: 3 };
        const setup = setupActionFight({
            supportCell: { x: 2, y: 3 },
            upperCell: { x: 5, y: 3 },
            currentActiveKnownPaths: new Map([[cellKey(allowedCell), [weightedRoute([currentCell, allowedCell])]]]),
        });
        setup.lower.refreshPossibleAttackTypes(true);

        const result = setup.engine.apply({
            type: "melee_attack",
            attackerId: setup.lower.getId(),
            targetId: setup.upper.getId(),
            attackFrom,
            path: [currentCell, attackFrom],
        });

        expect(result.completed).toBe(false);
        expect(result.rejectionReason).toBe("attack_not_available");
        expect(setup.lower.getBaseCell()).toEqual(currentCell);
        expect(setup.upper.getCumulativeHp()).toBe(setup.upper.getCumulativeMaxHp());
    });

    it("performs a range attack and consumes a shot through common mechanics", () => {
        const setup = setupActionFight({
            lowerAttackType: PBTypes.AttackVals.RANGE,
            lowerRangeShots: 3,
            supportCell: { x: 2, y: 3 },
            upperCell: { x: 7, y: 3 },
        });
        setup.lower.refreshPossibleAttackTypes(true);
        const shotsBefore = setup.lower.getRangeShots();

        const result = setup.engine.apply({
            type: "range_attack",
            attackerId: setup.lower.getId(),
            targetId: setup.upper.getId(),
        });

        expect(result.completed).toBe(true);
        expect(result.events).toContainEqual(
            expect.objectContaining({
                type: "unit_attacked",
                attackType: "range",
                attackerId: setup.lower.getId(),
                targetId: setup.upper.getId(),
            }),
        );
        expect(setup.lower.getRangeShots()).toBe(shotsBefore - 1);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.lower.getId())).toBe(true);
    });

    it("honors a valid range aim (visible edge) and clamps a tampered aim cell to the target", () => {
        const makeSetup = () => {
            const setup = setupActionFight({
                lowerAttackType: PBTypes.AttackVals.RANGE,
                lowerRangeShots: 3,
                supportCell: { x: 2, y: 3 },
                upperCell: { x: 7, y: 3 },
            });
            setup.lower.refreshPossibleAttackTypes(true);
            return setup;
        };

        // Valid aim: the target's own cell + its LEFT side (facing the attacker at x=3 < 7).
        const aimed = makeSetup();
        const aimedHpBefore = aimed.upper.getCumulativeHp();
        const aimedResult = aimed.engine.apply({
            type: "range_attack",
            attackerId: aimed.lower.getId(),
            targetId: aimed.upper.getId(),
            aimCell: { x: 7, y: 3 },
            aimSide: RangeAttackCellSide.LEFT,
        });
        expect(aimedResult.completed).toBe(true);
        expect(aimed.upper.getCumulativeHp()).toBeLessThan(aimedHpBefore);

        // Tampered aim: a cell that is NOT part of the target is clamped to the target's footprint —
        // the action still lands on the intended target rather than being honored or silently lost.
        const tampered = makeSetup();
        const tamperedHpBefore = tampered.upper.getCumulativeHp();
        const tamperedResult = tampered.engine.apply({
            type: "range_attack",
            attackerId: tampered.lower.getId(),
            targetId: tampered.upper.getId(),
            aimCell: { x: 14, y: 14 },
            aimSide: RangeAttackCellSide.UP,
        });
        expect(tamperedResult.completed).toBe(true);
        expect(tampered.upper.getCumulativeHp()).toBeLessThan(tamperedHpBefore);
    });

    it("carries per-affected-unit splash damage for a Large Caliber (AOE) range attack", () => {
        // Cyclops' Large Caliber is a RANGE attack that splashes the 3x3 around the target. The hit
        // unit's damage must travel in damage.splash with the unit id + impact position so the client
        // can draw a floating number ON the affected unit, not at the primary-target spot only.
        const setup = setupActionFight({
            lowerAttackType: PBTypes.AttackVals.RANGE,
            lowerAttack: 20,
            lowerAbilities: ["Large Caliber"],
            lowerDamageMin: 10,
            lowerDamageMax: 10,
            lowerRangeShots: 3,
            supportCell: { x: 2, y: 3 },
            upperCell: { x: 7, y: 3 },
        });
        setup.lower.refreshPossibleAttackTypes(true);
        const hpBefore = setup.upper.getCumulativeHp();
        const upperPosition = { ...setup.upper.getPosition() };

        const result = setup.engine.apply({
            type: "range_attack",
            attackerId: setup.lower.getId(),
            targetId: setup.upper.getId(),
        });

        expect(result.completed).toBe(true);
        const attacked = result.events.find((event) => event.type === "unit_attacked");
        expect(attacked?.type).toBe("unit_attacked");
        if (attacked?.type !== "unit_attacked") {
            throw new Error("expected unit_attacked event");
        }
        const splash = attacked.damage.splash;
        expect(splash?.length).toBeGreaterThan(0);
        const entry = splash?.find((s) => s.unitId === setup.upper.getId());
        expect(entry).toBeDefined();
        expect(entry?.amount).toBeGreaterThan(0);
        // Position is captured at impact, so it matches where the unit stood when hit.
        expect(entry?.position).toEqual(upperPosition);
        // Sanity: the splashed amount reflects the HP actually lost.
        expect(setup.upper.getCumulativeHp()).toBe(hpBefore - (entry?.amount ?? 0));
    });

    it("rejects range attacks against hidden targets without consuming the turn", () => {
        const setup = setupActionFight({
            lowerAttackType: PBTypes.AttackVals.RANGE,
            lowerRangeShots: 3,
            supportCell: { x: 2, y: 3 },
            upperCell: { x: 7, y: 3 },
        });
        setup.upper.applyBuff(
            new Spell({
                spellProperties: getSpellConfig("System", "Hidden"),
                amount: 1,
            }),
        );
        setup.lower.refreshPossibleAttackTypes(true);
        const shotsBefore = setup.lower.getRangeShots();

        const result = setup.engine.apply({
            type: "range_attack",
            attackerId: setup.lower.getId(),
            targetId: setup.upper.getId(),
        });

        expect(result.completed).toBe(false);
        expect(result.rejectionReason).toBe("attack_not_available");
        expect(setup.lower.getRangeShots()).toBe(shotsBefore);
        expect(setup.upper.getCumulativeHp()).toBe(setup.upper.getCumulativeMaxHp());
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.lower.getId())).toBe(false);
    });

    it("cleans up units killed by common attacks from the holder and grid", () => {
        const upperCell = { x: 7, y: 3 };
        const setup = setupActionFight({
            lowerAttackType: PBTypes.AttackVals.RANGE,
            lowerAttack: 100,
            lowerDamageMin: 100,
            lowerDamageMax: 100,
            lowerRangeShots: 3,
            supportCell: { x: 2, y: 3 },
            upperCell,
            upperAmountAlive: 1,
            upperArmor: 0,
            upperMaxHp: 10,
        });
        setup.lower.refreshPossibleAttackTypes(true);

        const result = setup.engine.apply({
            type: "range_attack",
            attackerId: setup.lower.getId(),
            targetId: setup.upper.getId(),
        });

        expect(result.completed).toBe(true);
        expect(result.events).toContainEqual({
            type: "unit_destroyed",
            unitId: setup.upper.getId(),
            reason: "dead_cleanup",
        });
        expect(setup.unitsHolder.getAllUnits().has(setup.upper.getId())).toBe(false);
        expect(setup.grid.getOccupantUnitId(upperCell)).toBe("");
    });

    it("keeps resurrecting units in the holder while emitting a common resurrection event", () => {
        const upperCell = { x: 7, y: 3 };
        const setup = setupActionFight({
            lowerAttackType: PBTypes.AttackVals.RANGE,
            lowerAttack: 100,
            lowerDamageMin: 100,
            lowerDamageMax: 100,
            lowerRangeShots: 3,
            supportCell: { x: 2, y: 3 },
            upperCell,
            upperAbilities: ["Resurrection"],
            upperAmountAlive: 2,
            upperArmor: 0,
            upperMaxHp: 10,
            upperSpells: ["System:Resurrection"],
        });
        setup.lower.refreshPossibleAttackTypes(true);

        const result = setup.engine.apply({
            type: "range_attack",
            attackerId: setup.lower.getId(),
            targetId: setup.upper.getId(),
        });

        expect(result.completed).toBe(true);
        expect(result.events).toContainEqual(
            expect.objectContaining({
                type: "unit_resurrected",
                unitId: setup.upper.getId(),
                team: setup.upper.getTeam(),
            }),
        );
        expect(
            result.events.some((event) => event.type === "unit_destroyed" && event.unitId === setup.upper.getId()),
        ).toBe(false);
        expect(setup.unitsHolder.getAllUnits().get(setup.upper.getId())).toBe(setup.upper);
        expect(setup.grid.getOccupantUnitId(upperCell)).toBe(setup.upper.getId());
        expect(setup.upper.getAmountAlive()).toBeGreaterThan(0);
        expect(setup.upper.hasSpellRemaining("Resurrection")).toBe(false);
    });

    it("attacks a block-center obstacle through common mechanics", () => {
        const setup = setupActionFight({
            gridType: PBTypes.GridVals.BLOCK_CENTER,
            lowerAttackType: PBTypes.AttackVals.RANGE,
            lowerRangeShots: 3,
            supportCell: { x: 2, y: 3 },
            upperCell: { x: 9, y: 9 },
        });
        setup.lower.refreshPossibleAttackTypes(true);
        const settings = setup.grid.getSettings();
        const targetPosition = getPositionForCell(
            setup.grid.getCenterCells()[0],
            settings.getMinX(),
            settings.getStep(),
            settings.getHalfStep(),
        );

        const result = setup.engine.apply({
            type: "obstacle_attack",
            attackerId: setup.lower.getId(),
            targetPosition,
        });

        expect(result.completed).toBe(true);
        expect(result.events).toContainEqual({
            type: "obstacle_attacked",
            attackerId: setup.lower.getId(),
            targetPosition,
            attackFrom: undefined,
            hitsBefore: MAX_HITS_MOUNTAIN,
            hitsAfter: MAX_HITS_MOUNTAIN - 1,
            animations: expect.any(Array),
        });
        expect(setup.lower.getRangeShots()).toBe(2);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.lower.getId())).toBe(true);
    });

    it("clears the center obstacle when the final common obstacle hit lands", () => {
        const setup = setupActionFight({
            gridType: PBTypes.GridVals.BLOCK_CENTER,
            lowerAttackType: PBTypes.AttackVals.RANGE,
            lowerRangeShots: 3,
            supportCell: { x: 2, y: 3 },
            upperCell: { x: 9, y: 9 },
        });
        setup.lower.refreshPossibleAttackTypes(true);
        for (let hit = 1; hit < MAX_HITS_MOUNTAIN; hit++) {
            setup.fightProperties.encounterObstacleHit();
        }
        const settings = setup.grid.getSettings();
        const targetPosition = getPositionForCell(
            setup.grid.getCenterCells()[0],
            settings.getMinX(),
            settings.getStep(),
            settings.getHalfStep(),
        );

        const result = setup.engine.apply({
            type: "obstacle_attack",
            attackerId: setup.lower.getId(),
            targetPosition,
        });

        expect(result.completed).toBe(true);
        expect(result.events).toContainEqual({
            type: "center_obstacle_cleared",
            gridType: PBTypes.GridVals.BLOCK_CENTER,
        });
        expect(setup.fightProperties.getObstacleHitsLeft()).toBe(0);
        expect(setup.grid.getCenterCells().every((cell) => setup.grid.getOccupantUnitId(cell) === "")).toBe(true);
    });

    it("rejects obstacle attacks when no ranged hit or melee approach can land", () => {
        const setup = setupActionFight({
            gridType: PBTypes.GridVals.BLOCK_CENTER,
            lowerAttackType: PBTypes.AttackVals.RANGE,
            lowerRangeShots: 0,
            supportCell: { x: 2, y: 3 },
            upperCell: { x: 9, y: 9 },
        });
        const settings = setup.grid.getSettings();
        const targetPosition = getPositionForCell(
            setup.grid.getCenterCells()[0],
            settings.getMinX(),
            settings.getStep(),
            settings.getHalfStep(),
        );

        const result = setup.engine.apply({
            type: "obstacle_attack",
            attackerId: setup.lower.getId(),
            targetPosition,
        });

        expect(result).toEqual({
            completed: false,
            events: [],
            rejectionReason: "attack_not_available",
            message: undefined,
        });
        expect(setup.fightProperties.getObstacleHitsLeft()).toBe(MAX_HITS_MOUNTAIN);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.lower.getId())).toBe(false);
    });

    it("rejects obstacle move-attacks when the supplied path is not in known paths", () => {
        const currentCell = { x: 3, y: 3 };
        const allowedCell = { x: 3, y: 4 };
        const setup = setupActionFight({
            gridType: PBTypes.GridVals.BLOCK_CENTER,
            lowerAttackType: PBTypes.AttackVals.MELEE,
            supportCell: { x: 2, y: 3 },
            upperCell: { x: 9, y: 9 },
            currentActiveKnownPaths: new Map([[cellKey(allowedCell), [weightedRoute([currentCell, allowedCell])]]]),
        });
        setup.lower.refreshPossibleAttackTypes(true);
        const targetCell = setup.grid.getCenterCells().at(-1);
        expect(targetCell).toBeDefined();
        const attackFrom = { x: targetCell!.x + 1, y: targetCell!.y + 1 };
        const settings = setup.grid.getSettings();
        const targetPosition = getPositionForCell(
            targetCell!,
            settings.getMinX(),
            settings.getStep(),
            settings.getHalfStep(),
        );

        const result = setup.engine.apply({
            type: "obstacle_attack",
            attackerId: setup.lower.getId(),
            targetPosition,
            attackFrom,
            path: [currentCell, attackFrom],
        });

        expect(result.completed).toBe(false);
        expect(result.rejectionReason).toBe("attack_not_available");
        expect(setup.fightProperties.getObstacleHitsLeft()).toBe(MAX_HITS_MOUNTAIN);
        expect(setup.lower.getBaseCell()).toEqual(currentCell);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.lower.getId())).toBe(false);
    });

    it("performs an area throw at a target cell through common mechanics", () => {
        const setup = setupActionFight({
            lowerAttackType: PBTypes.AttackVals.RANGE,
            lowerAttack: 20,
            lowerAbilities: ["Area Throw"],
            lowerDamageMin: 10,
            lowerDamageMax: 10,
            lowerRangeShots: 2,
            supportCell: { x: 2, y: 3 },
            upperCell: { x: 7, y: 7 },
        });
        setup.lower.refreshPossibleAttackTypes(true);
        const shotsBefore = setup.lower.getRangeShots();
        const hpBefore = setup.upper.getCumulativeHp();

        const result = setup.engine.apply({
            type: "area_throw_attack",
            attackerId: setup.lower.getId(),
            targetCell: { x: 7, y: 6 },
        });

        expect(result.completed).toBe(true);
        expect(result.events).toContainEqual(
            expect.objectContaining({
                type: "area_attacked",
                attackType: "area_throw",
                attackerId: setup.lower.getId(),
                targetCell: { x: 7, y: 6 },
                affectedUnitIds: [setup.upper.getId()],
            }),
        );
        expect(setup.lower.getRangeShots()).toBe(shotsBefore - 1);
        expect(setup.upper.getCumulativeHp()).toBeLessThan(hpBefore);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.lower.getId())).toBe(true);

        // The affected unit's damage rides along in damage.splash (with its impact position) so the
        // client can place the floating number on the splashed unit rather than the throw's center.
        const area = result.events.find((event) => event.type === "area_attacked");
        if (area?.type !== "area_attacked") {
            throw new Error("expected area_attacked event");
        }
        const entry = area.damage.splash?.find((s) => s.unitId === setup.upper.getId());
        expect(entry).toBeDefined();
        expect(entry?.amount).toBeGreaterThan(0);
        expect(entry?.position).toEqual(setup.upper.getPosition());
    });

    it("projects an area throw onto the first enemy standing on the trajectory", () => {
        // Attacker at {3,3}; an enemy sits at {5,3} directly between it and the empty aimed cell
        // {7,3}. The throw must be intercepted by (project onto) that enemy instead of passing
        // through to the empty cell behind it.
        const setup = setupActionFight({
            lowerAttackType: PBTypes.AttackVals.RANGE,
            lowerAttack: 20,
            lowerAbilities: ["Area Throw"],
            lowerDamageMin: 10,
            lowerDamageMax: 10,
            lowerRangeShots: 2,
            supportCell: { x: 2, y: 8 },
            upperCell: { x: 5, y: 3 },
        });
        setup.lower.refreshPossibleAttackTypes(true);
        const hpBefore = setup.upper.getCumulativeHp();

        const result = setup.engine.apply({
            type: "area_throw_attack",
            attackerId: setup.lower.getId(),
            targetCell: { x: 7, y: 3 },
        });

        expect(result.completed).toBe(true);
        expect(result.events).toContainEqual(
            expect.objectContaining({
                type: "area_attacked",
                attackType: "area_throw",
                attackerId: setup.lower.getId(),
                // Projected from the aimed {7,3} onto the intercepting enemy at {5,3}.
                targetCell: { x: 5, y: 3 },
                affectedUnitIds: [setup.upper.getId()],
            }),
        );
        expect(setup.upper.getCumulativeHp()).toBeLessThan(hpBefore);
    });

    it("rejects area throws without range selection or available shots", () => {
        const wrongType = setupActionFight({
            lowerAttackType: PBTypes.AttackVals.MELEE,
            lowerAbilities: ["Area Throw"],
            lowerRangeShots: 2,
            supportCell: { x: 2, y: 3 },
            upperCell: { x: 7, y: 7 },
        });

        const wrongTypeResult = wrongType.engine.apply({
            type: "area_throw_attack",
            attackerId: wrongType.lower.getId(),
            targetCell: { x: 7, y: 6 },
        });

        expect(wrongTypeResult.completed).toBe(false);
        expect(wrongTypeResult.rejectionReason).toBe("attack_not_available");
        expect(wrongType.fightProperties.hasAlreadyMadeTurn(wrongType.lower.getId())).toBe(false);

        const noShots = setupActionFight({
            lowerAttackType: PBTypes.AttackVals.RANGE,
            lowerAbilities: ["Area Throw"],
            lowerRangeShots: 0,
            supportCell: { x: 2, y: 3 },
            upperCell: { x: 7, y: 7 },
        });
        noShots.lower.refreshPossibleAttackTypes(true);

        const noShotsResult = noShots.engine.apply({
            type: "area_throw_attack",
            attackerId: noShots.lower.getId(),
            targetCell: { x: 7, y: 6 },
        });

        expect(noShotsResult.completed).toBe(false);
        expect(noShotsResult.rejectionReason).toBe("attack_not_available");
        expect(noShots.fightProperties.hasAlreadyMadeTurn(noShots.lower.getId())).toBe(false);
    });

    it("rejects area throws aimed at occupied unit cells", () => {
        const setup = setupActionFight({
            lowerAttackType: PBTypes.AttackVals.RANGE,
            lowerAbilities: ["Area Throw"],
            lowerRangeShots: 2,
            supportCell: { x: 2, y: 3 },
            upperCell: { x: 7, y: 7 },
        });
        setup.lower.refreshPossibleAttackTypes(true);
        const shotsBefore = setup.lower.getRangeShots();

        const result = setup.engine.apply({
            type: "area_throw_attack",
            attackerId: setup.lower.getId(),
            targetCell: setup.upper.getBaseCell(),
        });

        expect(result.completed).toBe(false);
        expect(result.rejectionReason).toBe("attack_not_available");
        expect(setup.lower.getRangeShots()).toBe(shotsBefore);
        expect(setup.upper.getCumulativeHp()).toBe(setup.upper.getCumulativeMaxHp());
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.lower.getId())).toBe(false);
    });

    it("casts a single-target spell and completes the active unit turn", () => {
        const setup = setupActionFight({ lowerSpells: ["Death:Weakness"] });

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.lower.getId(),
            spellName: "Weakness",
            targetId: setup.upper.getId(),
        });

        expect(result.completed).toBe(true);
        expect(result.events).toContainEqual(
            expect.objectContaining({
                type: "spell_cast",
                casterId: setup.lower.getId(),
                spellName: "Weakness",
                targetId: setup.upper.getId(),
            }),
        );
        expect(result.events).toContainEqual({
            type: "turn_completed",
            unitId: setup.lower.getId(),
            team: PBTypes.TeamVals.LOWER,
            hourglass: false,
        });
        expect(setup.upper.hasDebuffActive("Weakness")).toBe(true);
        expect(setup.lower.hasSpellRemaining("Weakness")).toBe(false);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.lower.getId())).toBe(true);
    });

    it("rejects single-target spells with stale target-cell data", () => {
        const setup = setupActionFight({ lowerSpells: ["Death:Weakness"] });

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.lower.getId(),
            spellName: "Weakness",
            targetId: setup.upper.getId(),
            targetCell: setup.lowerSupport.getBaseCell(),
        });

        expect(result.completed).toBe(false);
        expect(result.rejectionReason).toBe("spell_not_available");
        expect(setup.upper.hasDebuffActive("Weakness")).toBe(false);
        expect(setup.lower.hasSpellRemaining("Weakness")).toBe(true);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.lower.getId())).toBe(false);
    });

    it("emits spell animation metadata for Castling swaps", () => {
        const upperCell = { x: 4, y: 3 };
        const setup = setupActionFight({
            lowerSpells: ["System:Castling"],
            lowerStackPower: 4,
            supportCell: { x: 2, y: 3 },
            upperCell,
            currentEnemiesCellsWithinMovementRange: [upperCell],
        });
        const casterStart = structuredClone(setup.lower.getPosition());
        const targetStart = structuredClone(setup.upper.getPosition());

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.lower.getId(),
            spellName: "Castling",
            targetId: setup.upper.getId(),
        });

        expect(result.completed).toBe(true);
        expect(setup.lower.getPosition()).toEqual(targetStart);
        expect(setup.upper.getPosition()).toEqual(casterStart);
        expect(result.events).toContainEqual(
            expect.objectContaining({
                type: "spell_cast",
                casterId: setup.lower.getId(),
                spellName: "Castling",
                targetId: setup.upper.getId(),
                animations: expect.arrayContaining([
                    expect.objectContaining({
                        affectedUnitId: setup.lower.getId(),
                        bodyUnitId: setup.lower.getId(),
                        toPosition: targetStart,
                    }),
                    expect.objectContaining({
                        affectedUnitId: setup.upper.getId(),
                        bodyUnitId: setup.upper.getId(),
                        toPosition: casterStart,
                    }),
                ]),
            }),
        );
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.lower.getId())).toBe(true);
    });

    it("rejects invalid spell targets without completing the turn", () => {
        const setup = setupActionFight({ lowerSpells: ["Death:Weakness"] });

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.lower.getId(),
            spellName: "Weakness",
            targetId: setup.lowerSupport.getId(),
        });

        expect(result).toEqual({
            completed: false,
            events: [],
            rejectionReason: "spell_not_available",
            message: undefined,
        });
        expect(setup.lowerSupport.hasDebuffActive("Weakness")).toBe(false);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.lower.getId())).toBe(false);
    });

    it("casts a mass spell through common mechanics", () => {
        const setup = setupActionFight({
            lowerSpells: ["Life:Mass Heal"],
            lowerStackPower: 3,
        });
        setup.lowerSupport.applyDamage(6, 0, setup.sceneLog);
        const hpBefore = setup.lowerSupport.getHp();

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.lower.getId(),
            spellName: "Mass Heal",
        });

        expect(result.completed).toBe(true);
        expect(result.events).toContainEqual(
            expect.objectContaining({
                type: "spell_cast",
                casterId: setup.lower.getId(),
                spellName: "Mass Heal",
            }),
        );
        expect(setup.lowerSupport.getHp()).toBeGreaterThan(hpBefore);
        expect(setup.lower.hasSpellRemaining("Mass Heal")).toBe(false);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.lower.getId())).toBe(true);
    });

    it("casts mass flying buffs through common mechanics", () => {
        const setup = setupActionFight({
            lowerSpells: ["System:Wind Flow"],
            lowerStackPower: 5,
            supportMovementType: PBTypes.MovementVals.FLY,
            upperMovementType: PBTypes.MovementVals.FLY,
        });

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.lower.getId(),
            spellName: "Wind Flow",
        });

        expect(result.completed).toBe(true);
        expect(setup.lowerSupport.hasBuffActive("Wind Flow")).toBe(true);
        expect(setup.upper.hasBuffActive("Wind Flow")).toBe(true);
        expect(setup.lower.hasSpellRemaining("Wind Flow")).toBe(false);
    });

    it("casts mass enemy debuffs through common mechanics", () => {
        const setup = setupActionFight();
        const weaknessProperties = getSpellConfig("Death", "Weakness");
        const massWeaknessProperties = new SpellProperties(
            weaknessProperties.faction,
            "Mass Weakness",
            weaknessProperties.level,
            [...weaknessProperties.desc],
            SpellTargetType.ALL_ENEMIES,
            weaknessProperties.power,
            weaknessProperties.power_type,
            weaknessProperties.multiplier_type,
            weaknessProperties.laps,
            weaknessProperties.is_buff,
            weaknessProperties.self_cast_allowed,
            weaknessProperties.self_debuff_applies,
            weaknessProperties.minimal_caster_stack_power,
            [...weaknessProperties.conflicts_with],
            weaknessProperties.is_giftable,
            weaknessProperties.maximum_gift_level,
        );
        setup.lower.getSpells().push(new Spell({ spellProperties: massWeaknessProperties, amount: 1 }));

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.lower.getId(),
            spellName: "Mass Weakness",
        });

        expect(result.completed).toBe(true);
        expect(setup.upper.hasDebuffActive("Mass Weakness")).toBe(true);
        expect(setup.lower.hasSpellRemaining("Mass Weakness")).toBe(false);
    });

    it("summons a new stack through common mechanics", () => {
        const summonCell = { x: 3, y: 4 };
        const setup = setupActionFight({
            lowerSpells: ["Nature:Summon Wolves"],
            createSummonedUnit: ({ team, unitName, amount }) =>
                createTestUnit({
                    name: unitName,
                    team,
                    amountAlive: amount,
                    summoned: true,
                }),
        });

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.lower.getId(),
            spellName: "Summon Wolves",
            targetCell: summonCell,
        });

        const summoned = Array.from(setup.unitsHolder.getAllUnits().values()).find((unit) => unit.getName() === "Wolf");
        expect(result.completed).toBe(true);
        expect(summoned).toBeDefined();
        expect(summoned?.isSummoned()).toBe(true);
        expect(summoned?.getBaseCell()).toEqual(summonCell);
        expect(setup.grid.getOccupantUnitId(summonCell)).toBe(summoned?.getId());
        expect(result.events).toContainEqual(
            expect.objectContaining({
                type: "unit_summoned",
                casterId: setup.lower.getId(),
                unitId: summoned?.getId(),
                unitName: "Wolf",
                amount: 1,
                merged: false,
            }),
        );
        expect(setup.lower.hasSpellRemaining("Summon Wolves")).toBe(false);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.lower.getId())).toBe(true);
    });

    it("merges summon amount into an existing summoned stack", () => {
        const setup = setupActionFight({ lowerSpells: ["Nature:Summon Wolves"] });
        const existingWolf = createTestUnit({
            name: "Wolf",
            team: PBTypes.TeamVals.LOWER,
            amountAlive: 3,
            summoned: true,
        });
        placeUnit(setup.grid, setup.unitsHolder, existingWolf, { x: 5, y: 5 });

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.lower.getId(),
            spellName: "Summon Wolves",
            targetCell: { x: 3, y: 4 },
        });

        expect(result.completed).toBe(true);
        expect(existingWolf.getAmountAlive()).toBe(4);
        expect(result.events).toContainEqual(
            expect.objectContaining({
                type: "unit_summoned",
                unitId: existingWolf.getId(),
                amount: 1,
                merged: true,
            }),
        );
        expect(setup.lower.hasSpellRemaining("Summon Wolves")).toBe(false);
    });

    it("rejects new summon stacks when no common factory is available", () => {
        const setup = setupActionFight({ lowerSpells: ["Nature:Summon Wolves"] });

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.lower.getId(),
            spellName: "Summon Wolves",
            targetCell: { x: 3, y: 4 },
        });

        expect(result).toEqual({
            completed: false,
            events: [],
            rejectionReason: "summon_unit_factory_missing",
            message: undefined,
        });
        expect(setup.lower.hasSpellRemaining("Summon Wolves")).toBe(true);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.lower.getId())).toBe(false);
    });

    it("starts a valid setup fight through common mechanics", () => {
        const setup = setupPlacementFight();
        const upper = createTestUnit({ name: "Upper", team: PBTypes.TeamVals.UPPER });
        placeUnit(setup.grid, setup.unitsHolder, setup.unit, { x: 2, y: 2 });
        placeUnit(setup.grid, setup.unitsHolder, upper, { x: 10, y: 10 });

        const result = setup.engine.apply({ type: "start_fight" });

        expect(result).toEqual({
            completed: true,
            events: [{ type: "fight_started", lowerUnitsAlive: 1, upperUnitsAlive: 1 }],
        });
        expect(setup.fightProperties.hasFightStarted()).toBe(true);
        expect(setup.fightProperties.getTeamUnitsAlive(PBTypes.TeamVals.LOWER)).toBe(1);
        expect(setup.fightProperties.getTeamUnitsAlive(PBTypes.TeamVals.UPPER)).toBe(1);
    });

    it("rejects fight starts without both teams or after the fight has started", () => {
        const missingTeam = setupPlacementFight();
        placeUnit(missingTeam.grid, missingTeam.unitsHolder, missingTeam.unit, { x: 2, y: 2 });

        expect(missingTeam.engine.apply({ type: "start_fight" })).toEqual({
            completed: false,
            events: [],
            rejectionReason: "start_not_available",
            message: undefined,
        });

        const started = setupPlacementFight();
        const upper = createTestUnit({ name: "Upper", team: PBTypes.TeamVals.UPPER });
        placeUnit(started.grid, started.unitsHolder, started.unit, { x: 2, y: 2 });
        placeUnit(started.grid, started.unitsHolder, upper, { x: 10, y: 10 });
        expect(started.engine.apply({ type: "start_fight" }).completed).toBe(true);
        expect(started.engine.apply({ type: "start_fight" }).rejectionReason).toBe("start_not_available");
    });

    it("places an existing unit before fight start", () => {
        const setup = setupPlacementFight();
        const cells = [{ x: 2, y: 2 }];

        const result = setup.engine.apply({
            type: "place_unit",
            unitId: setup.unit.getId(),
            team: setup.unit.getTeam(),
            unitName: setup.unit.getName(),
            cells,
        });

        expect(result.completed).toBe(true);
        expect(result.events).toEqual([
            {
                type: "unit_placed",
                unitId: setup.unit.getId(),
                team: setup.unit.getTeam(),
                position: setup.unit.getPosition(),
                cells,
            },
        ]);
        expect(setup.grid.getOccupantUnitId(cells[0])).toBe(setup.unit.getId());
        expect(setup.unit.getBaseCell()).toEqual(cells[0]);
    });

    it("rolls back a moved unit when placement is blocked", () => {
        const setup = setupPlacementFight();
        const blocker = createTestUnit({ name: "Blocker", team: PBTypes.TeamVals.UPPER });
        placeUnit(setup.grid, setup.unitsHolder, setup.unit, { x: 2, y: 2 });
        placeUnit(setup.grid, setup.unitsHolder, blocker, { x: 3, y: 3 });
        const originalPosition = structuredClone(setup.unit.getPosition());

        const result = setup.engine.apply({
            type: "place_unit",
            unitId: setup.unit.getId(),
            team: setup.unit.getTeam(),
            unitName: setup.unit.getName(),
            cells: [{ x: 3, y: 3 }],
        });

        expect(result).toEqual({
            completed: false,
            events: [],
            rejectionReason: "placement_blocked",
            message: undefined,
        });
        expect(setup.grid.getOccupantUnitId({ x: 2, y: 2 })).toBe(setup.unit.getId());
        expect(setup.grid.getOccupantUnitId({ x: 3, y: 3 })).toBe(blocker.getId());
        expect(setup.unit.getPosition()).toEqual(originalPosition);
    });

    it("deletes an unstarted placement unit through common mechanics", () => {
        const setup = setupPlacementFight();
        placeUnit(setup.grid, setup.unitsHolder, setup.unit, { x: 2, y: 2 });

        const result = setup.engine.apply({ type: "delete_unit", unitId: setup.unit.getId() });

        expect(result).toEqual({
            completed: true,
            events: [{ type: "unit_deleted", unitId: setup.unit.getId(), team: setup.unit.getTeam() }],
        });
        expect(setup.unitsHolder.getAllUnits().has(setup.unit.getId())).toBe(false);
        expect(setup.grid.getOccupantUnitId({ x: 2, y: 2 })).toBe("");
    });

    it("splits an unstarted placement stack through common mechanics", () => {
        const setup = setupPlacementFight({
            amountAlive: 7,
            canSplitUnit: () => true,
            createSplitUnit: (sourceUnit, amount) =>
                createTestUnit({ name: sourceUnit.getName(), team: sourceUnit.getTeam(), amountAlive: amount }),
        });

        const result = setup.engine.apply({ type: "split_unit", unitId: setup.unit.getId(), amount: 3 });
        const splitEvent = result.events.find((event) => event.type === "unit_split");

        expect(result.completed).toBe(true);
        expect(splitEvent).toEqual({
            type: "unit_split",
            sourceUnitId: setup.unit.getId(),
            newUnitId: splitEvent?.type === "unit_split" ? splitEvent.newUnitId : "",
            team: setup.unit.getTeam(),
            sourceAmount: 4,
            splitAmount: 3,
        });
        expect(setup.unit.getAmountAlive()).toBe(4);
        expect(setup.unitsHolder.getAllUnits().size).toBe(2);
        expect(
            setup.unitsHolder
                .getAllUnits()
                .get(splitEvent?.type === "unit_split" ? splitEvent.newUnitId : "")
                ?.getAmountAlive(),
        ).toBe(3);
    });

    it("rejects invalid or over-cap placement stack splits", () => {
        const setup = setupPlacementFight({
            amountAlive: 7,
            canSplitUnit: () => false,
            createSplitUnit: (sourceUnit, amount) =>
                createTestUnit({ name: sourceUnit.getName(), team: sourceUnit.getTeam(), amountAlive: amount }),
        });

        expect(setup.engine.apply({ type: "split_unit", unitId: setup.unit.getId(), amount: 7 })).toEqual({
            completed: false,
            events: [],
            rejectionReason: "invalid_split",
            message: undefined,
        });
        expect(setup.engine.apply({ type: "split_unit", unitId: setup.unit.getId(), amount: 3 })).toEqual({
            completed: false,
            events: [],
            rejectionReason: "unit_limit_reached",
            message: undefined,
        });
        expect(setup.unit.getAmountAlive()).toBe(7);
        expect(setup.unitsHolder.getAllUnits().size).toBe(1);
    });

    it("rejects placement and setup deletion after the fight starts", () => {
        const setup = setupPlacementFight();
        setup.fightProperties.startFight();

        expect(
            setup.engine.apply({
                type: "place_unit",
                unitId: setup.unit.getId(),
                team: setup.unit.getTeam(),
                unitName: setup.unit.getName(),
                cells: [{ x: 2, y: 2 }],
            }).rejectionReason,
        ).toBe("placement_not_available");
        expect(setup.engine.apply({ type: "delete_unit", unitId: setup.unit.getId() }).rejectionReason).toBe(
            "delete_not_available",
        );
    });

    it("exposes deterministic helper behavior for common event serialization and footprints", () => {
        const setup = setupPlacementFight();
        const engineAny = setup.engine as any;
        const largeUnit = createTestUnit({ size: PBTypes.UnitSizeVals.LARGE });
        const spell = new Spell({
            spellProperties: getSpellConfig("Nature", "Summon Wolves"),
            amount: 1,
        });

        const clonedDamage = engineAny.cloneVisibleDamage({
            amount: 5,
            render: true,
            unitPosition: { x: 1, y: 2 },
            unitIsSmall: true,
            hits: [{ amount: 5, unitsDied: 1 }],
        });
        clonedDamage.hits[0].amount = 7;

        expect(clonedDamage.unitPosition).toEqual({ x: 1, y: 2 });
        expect(engineAny.resolveSummonCells(setup.unit, { x: 4, y: 4 })).toEqual([{ x: 4, y: 4 }]);
        expect(engineAny.resolveSummonCells(largeUnit, { x: 4, y: 4 })).toEqual([
            { x: 3, y: 4 },
            { x: 4, y: 4 },
            { x: 3, y: 3 },
            { x: 4, y: 3 },
        ]);
        expect(engineAny.isValidPlacementFootprint(setup.unit, [{ x: 1, y: 1 }])).toBe(true);
        expect(
            engineAny.isValidPlacementFootprint(largeUnit, [
                { x: 1, y: 1 },
                { x: 2, y: 1 },
                { x: 1, y: 2 },
                { x: 2, y: 2 },
            ]),
        ).toBe(true);
        expect(engineAny.cellsMatchInOrder([{ x: 1, y: 1 }], [{ x: 1, y: 1 }])).toBe(true);
        expect(
            engineAny.cellsMatchAsSet(
                [
                    { x: 2, y: 1 },
                    { x: 1, y: 1 },
                ],
                [
                    { x: 1, y: 1 },
                    { x: 2, y: 1 },
                ],
            ),
        ).toBe(true);

        const route = [
            { x: 3, y: 3 },
            { x: 4, y: 4 },
        ];
        const actionSetup = setupActionFight({
            currentActiveKnownPaths: new Map([[cellKey({ x: 4, y: 4 }), [weightedRoute(route)]]]),
        });
        const resolvedKnownPaths = (actionSetup.engine as any).resolveKnownPaths(
            actionSetup.lower,
            { x: 4, y: 4 },
            route,
        );

        expect(resolvedKnownPaths.get(cellKey({ x: 4, y: 4 }))).toHaveLength(1);

        const animationEvents = engineAny.serializeAnimations([
            {
                toPosition: { x: 10, y: 11 },
                fromPosition: { x: 8, y: 9 },
                affectedUnit: setup.unit,
                bodyUnit: setup.unit,
            },
        ]);
        const summonEvents = engineAny.createSummonEvents(setup.unit, spell, largeUnit, 3, [{ x: 4, y: 4 }], false);

        expect(animationEvents).toEqual([
            {
                toPosition: { x: 10, y: 11 },
                fromPosition: { x: 8, y: 9 },
                affectedUnitId: setup.unit.getId(),
                bodyUnitId: setup.unit.getId(),
            },
        ]);
        expect(summonEvents[1]).toMatchObject({
            type: "unit_summoned",
            casterId: setup.unit.getId(),
            unitId: largeUnit.getId(),
            amount: 3,
            merged: false,
        });
    });

    it("rejects unsupported actions without mutating game state", () => {
        const setup = setupActionFight();

        const result = setup.engine.apply({
            type: "unknown_action",
            unitId: setup.lower.getId(),
        } as unknown as GameAction);

        expect(result.completed).toBe(false);
        expect(result.rejectionReason).toBe("unsupported_action");
        expect(result.events).toEqual([]);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.lower.getId())).toBe(false);
    });
});
