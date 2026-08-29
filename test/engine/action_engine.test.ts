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

import { afterEach, describe, expect, it } from "bun:test";

import { ArtifactTier, Tier2Artifact } from "../../src/artifacts/artifact_properties";
import { HITS_PER_MOUNTAIN, MORALE_CHANGE_FOR_CLOCK, MORALE_CHANGE_FOR_SHIELD } from "../../src/constants";
import { getSpellConfig } from "../../src/configuration/config_provider";
import { GameActionEngine, type IGameActionEngineContext } from "../../src/engine/action_engine";
import type { GameAction } from "../../src/engine/actions";
import { createSequenceGameRuntime } from "../../src/engine/runtime";
import { EffectFactory } from "../../src/effects/effect_factory";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { AttackType, GridType, MovementType, UnitSizeType } from "../../src/generated/protobuf/v1/types_gen";
import type { IWeightedRoute } from "../../src/grid/path_definitions";
import { getPositionForCell, getPositionForCells, RangeAttackCellSide } from "../../src/grid/grid_math";
import { MoveHandler } from "../../src/handlers/move_handler";
import { PathHelper } from "../../src/grid/path_helper";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { getRandomInt, setDeterministicRandomSource } from "../../src/utils/lib";
import { Spell } from "../../src/spells/spell";
import { SpellProperties, SpellTargetType } from "../../src/spells/spell_properties";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const setupActionFight = (
    opts: {
        activeUnit?: "lower" | "upper";
        leftAttackType?: AttackType;
        leftAttack?: number;
        leftAbilities?: string[];
        leftDamageMin?: number;
        leftDamageMax?: number;
        leftRangeShots?: number;
        leftSize?: UnitSizeType;
        leftSpells?: string[];
        leftStackPower?: number;
        leftMovementType?: MovementType;
        supportMovementType?: MovementType;
        rightMovementType?: MovementType;
        rightAttackType?: AttackType;
        rightDamageMin?: number;
        rightDamageMax?: number;
        rightRangeShots?: number;
        leftCell?: { x: number; y: number };
        supportCell?: { x: number; y: number };
        rightCell?: { x: number; y: number };
        rightAbilities?: string[];
        rightAmountAlive?: number;
        rightArmor?: number;
        rightMagicResist?: number;
        rightMaxHp?: number;
        rightSpells?: string[];
        leftUnitsAlive?: number;
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

    const left = createTestUnit({
        name: "Lower",
        team: PBTypes.TeamVals.LEFT,
        attackType: opts.leftAttackType ?? PBTypes.AttackVals.MELEE,
        attack: opts.leftAttack,
        damageMin: opts.leftDamageMin,
        damageMax: opts.leftDamageMax,
        abilities: opts.leftAbilities,
        rangeShots: opts.leftRangeShots ?? 0,
        size: opts.leftSize,
        initiative: 5,
        morale: 4,
        spells: opts.leftSpells,
        stackPower: opts.leftStackPower,
        movementType: opts.leftMovementType,
    });
    const right = createTestUnit({
        name: "Upper",
        team: PBTypes.TeamVals.RIGHT,
        attackType: opts.rightAttackType,
        initiative: 3,
        morale: 4,
        abilities: opts.rightAbilities,
        amountAlive: opts.rightAmountAlive,
        armor: opts.rightArmor,
        damageMin: opts.rightDamageMin,
        damageMax: opts.rightDamageMax,
        magicResist: opts.rightMagicResist,
        maxHp: opts.rightMaxHp,
        rangeShots: opts.rightRangeShots,
        spells: opts.rightSpells,
        movementType: opts.rightMovementType,
    });
    const leftSupport = createTestUnit({
        name: "Lower Support",
        team: PBTypes.TeamVals.LEFT,
        initiative: 2,
        movementType: opts.supportMovementType,
    });

    placeUnit(context.grid, context.unitsHolder, left, opts.leftCell ?? { x: 3, y: 3 });
    placeUnit(context.grid, context.unitsHolder, right, opts.rightCell ?? { x: 9, y: 9 });
    placeUnit(context.grid, context.unitsHolder, leftSupport, opts.supportCell ?? { x: 4, y: 3 });
    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LEFT, opts.leftUnitsAlive ?? 2);
    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.RIGHT, 1);
    fightProperties.startTurn(PBTypes.TeamVals.LEFT, 1000);

    const activeUnit = opts.activeUnit === "upper" ? right : left;
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

    return { ...context, fightProperties, left, leftSupport, right, activeUnit, sceneLog, moveHandler, engine };
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
        team: PBTypes.TeamVals.LEFT,
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
    it("treats a manual end with no action taken as a skip (do-nothing turn, e.g. an AI unit)", () => {
        const setup = setupActionFight();
        const moraleBefore = setup.left.getMorale();

        // The unit ends its turn without moving/attacking/casting. Reaching end_turn at all means it
        // didn't attack/cast (those complete the turn directly), and it didn't move either, so it did
        // nothing — that must read + score as a skip even though the end carried no explicit reason.
        const result = setup.engine.apply({ type: "end_turn", unitId: setup.left.getId() });

        expect(result.completed).toBe(true);
        expect(result.rejectionReason).toBeUndefined();
        expect(result.events).toContainEqual(
            expect.objectContaining({ type: "unit_skipped", unitId: setup.left.getId(), reason: "skip" }),
        );
        expect(result.events).toContainEqual({
            type: "turn_completed",
            unitId: setup.left.getId(),
            team: PBTypes.TeamVals.LEFT,
            hourglass: false,
        });
        setup.unitsHolder.refreshStackPowerForAllUnits();
        expect(setup.left.getMorale()).toBeLessThan(moraleBefore);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.left.getId())).toBe(true);
        expect(setup.fightProperties.getCurrentLapTotalTime(PBTypes.TeamVals.LEFT)).toBe(400);
    });

    it("drops morale and emits unit_skipped when the turn is skipped (Next/skip)", () => {
        const setup = setupActionFight();
        const moraleBefore = setup.left.getMorale();

        const result = setup.engine.apply({ type: "end_turn", unitId: setup.left.getId(), reason: "skip" });

        expect(result.completed).toBe(true);
        expect(result.events).toContainEqual(
            expect.objectContaining({ type: "unit_skipped", unitId: setup.left.getId(), reason: "skip" }),
        );
        setup.unitsHolder.refreshStackPowerForAllUnits();
        expect(setup.left.getMorale()).toBeLessThan(moraleBefore);
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
        expect(setup.left.getMorale()).toBe(4);

        // Move toward the enemy (+3), then end the turn manually — the end must NOT apply the skip
        // penalty, so the net stays +3 (regression: it used to net -1).
        expect(setup.engine.apply({ type: "move_unit", unitId: setup.left.getId(), path }).completed).toBe(true);
        expect(setup.engine.apply({ type: "end_turn", unitId: setup.left.getId() }).completed).toBe(true);

        setup.unitsHolder.refreshStackPowerForAllUnits();
        expect(setup.left.getMorale()).toBe(7);
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
        expect(setup.left.getMorale()).toBe(4);

        expect(setup.engine.apply({ type: "move_unit", unitId: setup.left.getId(), path }).completed).toBe(true);
        expect(setup.engine.apply({ type: "end_turn", unitId: setup.left.getId() }).completed).toBe(true);

        setup.unitsHolder.refreshStackPowerForAllUnits();
        expect(setup.left.getMorale()).toBe(1);
    });

    it("waits on hourglass without marking the unit as having completed the lap", () => {
        const setup = setupActionFight();

        const result = setup.engine.apply({ type: "wait_turn", unitId: setup.left.getId() });

        expect(result.completed).toBe(true);
        expect(result.events).toEqual([
            { type: "unit_waited", unitId: setup.left.getId(), team: PBTypes.TeamVals.LEFT },
            {
                type: "turn_completed",
                unitId: setup.left.getId(),
                team: PBTypes.TeamVals.LEFT,
                hourglass: true,
            },
        ]);
        expect(setup.left.isOnHourglass()).toBe(true);
        expect(setup.fightProperties.hourglassIncludes(setup.left.getId())).toBe(true);
        expect(setup.fightProperties.hasAlreadyHourglass(setup.left.getId())).toBe(true);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.left.getId())).toBe(false);
    });

    it("grants additional turn time to the active team once per lap and refuses off-turn / repeat requests", () => {
        const setup = setupActionFight(); // active unit belongs to LEFT
        const before = setup.fightProperties.getCurrentTurnEnd();

        // Off-turn: RIGHT cannot extend the clock while a LEFT unit is active.
        expect(setup.engine.apply({ type: "request_additional_time", team: PBTypes.TeamVals.RIGHT })).toMatchObject({
            completed: false,
            rejectionReason: "additional_time_not_available",
        });
        expect(setup.fightProperties.getCurrentTurnEnd()).toBe(before);

        // The active team's first request this lap extends the running clock.
        expect(setup.engine.apply({ type: "request_additional_time", team: PBTypes.TeamVals.LEFT }).completed).toBe(
            true,
        );
        const extended = setup.fightProperties.getCurrentTurnEnd();
        expect(extended).toBeGreaterThan(before);

        // A second request in the same lap is refused (once per lap per team).
        expect(setup.engine.apply({ type: "request_additional_time", team: PBTypes.TeamVals.LEFT })).toMatchObject({
            completed: false,
            rejectionReason: "additional_time_not_available",
        });
        expect(setup.fightProperties.getCurrentTurnEnd()).toBe(extended);
    });

    it("defends with luck shield and completes the unit turn", () => {
        const setup = setupActionFight();

        const result = setup.engine.apply({ type: "defend_turn", unitId: setup.left.getId() });

        expect(result.completed).toBe(true);
        expect(result.events).toContainEqual({
            type: "unit_defended",
            unitId: setup.left.getId(),
            team: PBTypes.TeamVals.LEFT,
        });
        expect(result.events).toContainEqual({
            type: "turn_completed",
            unitId: setup.left.getId(),
            team: PBTypes.TeamVals.LEFT,
            hourglass: false,
        });
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.left.getId())).toBe(true);
    });

    it("defending (Luck Shield) costs MORALE_CHANGE_FOR_SHIELD morale", () => {
        const setup = setupActionFight();
        const before = setup.left.getMorale();

        setup.engine.apply({ type: "defend_turn", unitId: setup.left.getId() });

        expect(setup.left.getMorale()).toBe(before - MORALE_CHANGE_FOR_SHIELD);
    });

    it("waiting on the hourglass costs MORALE_CHANGE_FOR_CLOCK morale", () => {
        const setup = setupActionFight();
        const before = setup.left.getMorale();

        const result = setup.engine.apply({ type: "wait_turn", unitId: setup.left.getId() });

        expect(result.completed).toBe(true);
        expect(setup.left.getMorale()).toBe(before - MORALE_CHANGE_FOR_CLOCK);
    });

    it("rejects Hourglass globally while a Time Denial holder is active", () => {
        const setup = setupActionFight({ rightAbilities: ["Time Denial"] });

        expect(setup.right.hasAbilityActive("Time Denial")).toBe(true);
        expect(setup.engine.apply({ type: "wait_turn", unitId: setup.left.getId() })).toMatchObject({
            completed: false,
            rejectionReason: "hourglass_not_available",
        });
    });

    it("lifts Time Denial when its holder is Broken and carries it with a thief", () => {
        const brokenSource = setupActionFight({ rightAbilities: ["Time Denial"] });
        brokenSource.right.applyEffect(new EffectFactory().makeEffect("Break")!);
        expect(brokenSource.right.hasAbilityActive("Time Denial")).toBe(false);
        expect(brokenSource.engine.apply({ type: "wait_turn", unitId: brokenSource.left.getId() }).completed).toBe(
            true,
        );

        const stolenSource = setupActionFight({ rightAbilities: ["Time Denial"] });
        expect(stolenSource.right.disableAbilityAsStolen("Time Denial")).toBeDefined();
        stolenSource.left.grantStolenAbility("Time Denial");
        expect(stolenSource.right.hasAbilityActive("Time Denial")).toBe(false);
        expect(stolenSource.left.hasAbilityActive("Time Denial")).toBe(true);
        expect(stolenSource.engine.apply({ type: "wait_turn", unitId: stolenSource.left.getId() })).toMatchObject({
            completed: false,
            rejectionReason: "hourglass_not_available",
        });
    });

    it("rejects hourglass when the active unit is the only living unit on its team", () => {
        const setup = setupActionFight({ leftUnitsAlive: 1 });

        const result = setup.engine.apply({ type: "wait_turn", unitId: setup.left.getId() });

        expect(result).toEqual({
            completed: false,
            events: [],
            rejectionReason: "hourglass_not_available",
            message: undefined,
        });
        expect(setup.left.isOnHourglass()).toBe(false);
        expect(setup.fightProperties.hourglassIncludes(setup.left.getId())).toBe(false);
    });

    it("rejects hourglass when every living teammate already completed its turn this lap", () => {
        const setup = setupActionFight();
        setup.fightProperties.addAlreadyMadeTurn(
            PBTypes.TeamVals.LEFT,
            setup.leftSupport.getId(),
            setup.fightProperties.getCurrentTurnStart(),
        );

        const result = setup.engine.apply({ type: "wait_turn", unitId: setup.left.getId() });

        expect(result).toEqual({
            completed: false,
            events: [],
            rejectionReason: "hourglass_not_available",
            message: undefined,
        });
        expect(setup.left.isOnHourglass()).toBe(false);
        expect(setup.fightProperties.hourglassIncludes(setup.left.getId())).toBe(false);
    });

    it("rejects actions for units that are not currently active", () => {
        const setup = setupActionFight();

        const result = setup.engine.apply({ type: "end_turn", unitId: setup.right.getId() });

        expect(result).toEqual({
            completed: false,
            events: [],
            rejectionReason: "unit_not_active",
            message: undefined,
        });
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.right.getId())).toBe(false);
    });

    it("selects an available attack type for the active unit", () => {
        const setup = setupActionFight({ leftAttackType: PBTypes.AttackVals.RANGE, leftRangeShots: 3 });
        setup.left.refreshPossibleAttackTypes(true);

        const result = setup.engine.apply({
            type: "select_attack_type",
            unitId: setup.left.getId(),
            attackType: PBTypes.AttackVals.MELEE,
        });

        expect(result.completed).toBe(true);
        expect(result.events).toEqual([
            {
                type: "attack_type_selected",
                unitId: setup.left.getId(),
                team: PBTypes.TeamVals.LEFT,
                attackType: PBTypes.AttackVals.MELEE,
            },
        ]);
        expect(setup.left.getAttackTypeSelection()).toBe(PBTypes.AttackVals.MELEE);
    });

    it("accepts selecting the already selected attack type as an idempotent action", () => {
        const setup = setupActionFight({ leftAttackType: PBTypes.AttackVals.RANGE, leftRangeShots: 3 });
        setup.left.refreshPossibleAttackTypes(false);
        expect(setup.left.getAttackTypeSelection()).toBe(PBTypes.AttackVals.MELEE);

        const result = setup.engine.apply({
            type: "select_attack_type",
            unitId: setup.left.getId(),
            attackType: PBTypes.AttackVals.MELEE,
        });

        expect(result).toEqual({ completed: true, events: [] });
        expect(setup.left.getAttackTypeSelection()).toBe(PBTypes.AttackVals.MELEE);
    });

    it("moves the active unit and leaves the turn open", () => {
        const setup = setupActionFight();
        const targetCell = { x: 3, y: 4 };

        const result = setup.engine.apply({
            type: "move_unit",
            unitId: setup.left.getId(),
            path: [targetCell],
        });

        expect(result.completed).toBe(true);
        expect(result.events).toHaveLength(1);
        expect(result.events[0]).toMatchObject({
            type: "unit_moved",
            unitId: setup.left.getId(),
            path: [targetCell],
            targetCells: [targetCell],
        });
        expect(setup.left.getBaseCell()).toEqual(targetCell);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.left.getId())).toBe(false);
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
            unitId: setup.left.getId(),
            path,
        });

        expect(result.completed).toBe(true);
        expect(result.events[0]).toMatchObject({
            type: "unit_moved",
            unitId: setup.left.getId(),
            path,
            targetCells: [targetCell],
        });
        expect(setup.left.getBaseCell()).toEqual(targetCell);
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
        expect(setup.left.getMorale()).toBe(4);

        const result = setup.engine.apply({
            type: "move_unit",
            unitId: setup.left.getId(),
            path,
        });
        expect(result.completed).toBe(true);

        // refreshStackPowerForAllUnits syncs the morale change (written to initialUnitProperties by
        // increaseMorale) into unitProperties, exactly as the scene does after a move.
        setup.unitsHolder.refreshStackPowerForAllUnits();
        expect(setup.left.getMorale()).toBe(7);
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
            unitId: setup.left.getId(),
            path: [currentCell, forbiddenCell],
        });

        expect(result.completed).toBe(false);
        expect(result.rejectionReason).toBe("invalid_move");
        expect(setup.left.getBaseCell()).toEqual(currentCell);
    });

    it("rejects move routes whose travelled cells exceed unit steps", () => {
        const setup = setupActionFight();
        const currentCell = setup.left.getBaseCell();

        const result = setup.engine.apply({
            type: "move_unit",
            unitId: setup.left.getId(),
            path: [currentCell, { x: 3, y: 4 }, { x: 3, y: 5 }, { x: 3, y: 6 }, { x: 3, y: 7 }],
        });

        expect(result.completed).toBe(false);
        expect(result.rejectionReason).toBe("invalid_move");
        expect(setup.left.getBaseCell()).toEqual(currentCell);
    });

    it("rejects discontinuous move routes when known paths are unavailable", () => {
        const setup = setupActionFight();
        const currentCell = setup.left.getBaseCell();
        const targetCell = { x: 3, y: 5 };

        const result = setup.engine.apply({
            type: "move_unit",
            unitId: setup.left.getId(),
            path: [targetCell],
        });

        expect(result.completed).toBe(false);
        expect(result.rejectionReason).toBe("invalid_move");
        expect(setup.left.getBaseCell()).toEqual(currentCell);
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
            leftSize: PBTypes.UnitSizeVals.LARGE,
            currentActiveKnownPaths: new Map([[cellKey(routeAnchor), [weightedRoute(route)]]]),
        });

        const result = setup.engine.apply({
            type: "move_unit",
            unitId: setup.left.getId(),
            path: footprint,
            targetCells: footprint,
        });

        expect(result.completed).toBe(true);
        expect(result.events[0]).toMatchObject({
            type: "unit_moved",
            unitId: setup.left.getId(),
            path: footprint,
            targetCells: footprint,
        });
    });

    it("moves a large lava walker across its own footprint onto lava", () => {
        const currentCell = { x: 5, y: 7 };
        const targetCell = { x: 6, y: 7 };
        const targetCells = [
            { x: 6, y: 7 },
            { x: 5, y: 7 },
            { x: 6, y: 6 },
            { x: 5, y: 6 },
        ];
        const path = [currentCell, targetCell];
        const setup = setupActionFight({
            gridType: PBTypes.GridVals.LAVA_CENTER,
            leftAbilities: ["Made of Fire"],
            leftSize: PBTypes.UnitSizeVals.LARGE,
            leftCell: currentCell,
            supportCell: { x: 2, y: 2 },
            rightCell: { x: 12, y: 12 },
            currentActiveKnownPaths: new Map([[cellKey(targetCell), [weightedRoute(path)]]]),
        });

        const result = setup.engine.apply({
            type: "move_unit",
            unitId: setup.left.getId(),
            path,
            targetCells,
            hasLavaCell: true,
        });

        expect(result.completed).toBe(true);
        expect(result.rejectionReason).toBeUndefined();
        expect(setup.left.getBaseCell()).toEqual(targetCell);
        expect(setup.left.getCells()).toEqual(expect.arrayContaining(targetCells));
        expect(result.events[0]).toMatchObject({
            type: "unit_moved",
            path,
            targetCells,
        });
    });

    it("performs a melee attack and completes the active unit turn", () => {
        const setup = setupActionFight({
            supportCell: { x: 2, y: 3 },
            rightCell: { x: 4, y: 3 },
        });
        setup.left.refreshPossibleAttackTypes(true);

        const result = setup.engine.apply({
            type: "melee_attack",
            attackerId: setup.left.getId(),
            targetId: setup.right.getId(),
            attackFrom: { x: 3, y: 3 },
        });

        expect(result.completed).toBe(true);
        expect(result.events).toContainEqual(
            expect.objectContaining({
                type: "unit_attacked",
                attackType: "melee",
                attackerId: setup.left.getId(),
                targetId: setup.right.getId(),
            }),
        );
        expect(result.events).toContainEqual({
            type: "turn_completed",
            unitId: setup.left.getId(),
            team: PBTypes.TeamVals.LEFT,
            hourglass: false,
        });
        expect(setup.right.getCumulativeHp()).toBeLessThan(setup.right.getCumulativeMaxHp());
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.left.getId())).toBe(true);
    });

    it("performs a move-melee attack when the supplied path matches known paths", () => {
        const currentCell = { x: 3, y: 3 };
        const attackFrom = { x: 4, y: 3 };
        const path = [currentCell, attackFrom];
        const setup = setupActionFight({
            supportCell: { x: 2, y: 3 },
            rightCell: { x: 5, y: 3 },
            currentActiveKnownPaths: new Map([[cellKey(attackFrom), [weightedRoute(path)]]]),
        });
        setup.left.refreshPossibleAttackTypes(true);

        const result = setup.engine.apply({
            type: "melee_attack",
            attackerId: setup.left.getId(),
            targetId: setup.right.getId(),
            attackFrom,
            path,
        });

        expect(result.completed).toBe(true);
        expect(result.events).toContainEqual(
            expect.objectContaining({
                type: "unit_attacked",
                attackType: "melee",
                attackerId: setup.left.getId(),
                targetId: setup.right.getId(),
            }),
        );
        expect(setup.left.getBaseCell()).toEqual(attackFrom);
    });

    it("rejects move-melee attacks when the supplied path is not in known paths", () => {
        const currentCell = { x: 3, y: 3 };
        const allowedCell = { x: 3, y: 4 };
        const attackFrom = { x: 4, y: 3 };
        const setup = setupActionFight({
            supportCell: { x: 2, y: 3 },
            rightCell: { x: 5, y: 3 },
            currentActiveKnownPaths: new Map([[cellKey(allowedCell), [weightedRoute([currentCell, allowedCell])]]]),
        });
        setup.left.refreshPossibleAttackTypes(true);

        const result = setup.engine.apply({
            type: "melee_attack",
            attackerId: setup.left.getId(),
            targetId: setup.right.getId(),
            attackFrom,
            path: [currentCell, attackFrom],
        });

        expect(result.completed).toBe(false);
        expect(result.rejectionReason).toBe("attack_not_available");
        expect(setup.left.getBaseCell()).toEqual(currentCell);
        expect(setup.right.getCumulativeHp()).toBe(setup.right.getCumulativeMaxHp());
    });

    // -------------------------------------------------------------------------------------------------
    // Regression: a LEGIT move-attack must not be refused (attack_not_available) just because the client
    // animated a DIFFERENT equal-cost route to a reachable attack-from cell than the server's canonical one.
    // Live repro (ranked, Leprechaun): server reach had a route to the attack-from cell (afReachable=true,
    // adjacent=true) but the client walked (2,5)->(1,5)->(2,4) while the server's route was (2,5)->(2,4);
    // the old exact-path match returned undefined -> the move-then-strike failed -> the turn was rejected.
    // The fix keeps full reachability + anti-spoof enforcement (destination must be in known paths; the
    // SERVER's route/terrain flags are used, never the client's) but stops gating on the exact path.
    // -------------------------------------------------------------------------------------------------
    it("performs a move-melee attack when the attack-from cell is reachable but the client's path differs from the server's canonical route", () => {
        const currentCell = { x: 3, y: 3 };
        const attackFrom = { x: 4, y: 3 };
        // Server's canonical (authoritative) route to the attack-from cell: a direct one-step move.
        const canonical = [currentCell, attackFrom];
        // Client animated a longer, equally-legal detour to the SAME cell (benign pather divergence).
        const clientDetour = [currentCell, { x: 3, y: 4 }, attackFrom];
        const setup = setupActionFight({
            supportCell: { x: 2, y: 3 },
            rightCell: { x: 5, y: 3 },
            currentActiveKnownPaths: new Map([[cellKey(attackFrom), [weightedRoute(canonical)]]]),
        });
        setup.left.refreshPossibleAttackTypes(true);

        const result = setup.engine.apply({
            type: "melee_attack",
            attackerId: setup.left.getId(),
            targetId: setup.right.getId(),
            attackFrom,
            path: clientDetour,
        });

        expect(result.completed).toBe(true);
        expect(result.events).toContainEqual(
            expect.objectContaining({
                type: "unit_attacked",
                attackType: "melee",
                attackerId: setup.left.getId(),
                targetId: setup.right.getId(),
            }),
        );
        // The unit moved to the (reachable) attack-from cell and the strike landed.
        expect(setup.left.getBaseCell()).toEqual(attackFrom);
        expect(setup.right.getCumulativeHp()).toBeLessThan(setup.right.getCumulativeMaxHp());
    });

    it("SECURITY: still refuses a move-melee whose attack-from cell is adjacent to the target but NOT reachable (no teleport-melee)", () => {
        const currentCell = { x: 3, y: 3 };
        const reachableButIrrelevant = { x: 3, y: 4 };
        const attackFrom = { x: 4, y: 3 }; // adjacent to the target at (5,3) but absent from known paths
        const setup = setupActionFight({
            supportCell: { x: 2, y: 3 },
            rightCell: { x: 5, y: 3 },
            // Known paths only reach a different cell — the attack-from cell has NO known route, so it is
            // unreachable this turn. The fallback must NOT invent a route to it.
            currentActiveKnownPaths: new Map([
                [cellKey(reachableButIrrelevant), [weightedRoute([currentCell, reachableButIrrelevant])]],
            ]),
        });
        setup.left.refreshPossibleAttackTypes(true);

        const result = setup.engine.apply({
            type: "melee_attack",
            attackerId: setup.left.getId(),
            targetId: setup.right.getId(),
            attackFrom,
            path: [currentCell, attackFrom],
        });

        expect(result.completed).toBe(false);
        expect(result.rejectionReason).toBe("attack_not_available");
        expect(setup.left.getBaseCell()).toEqual(currentCell);
        expect(setup.right.getCumulativeHp()).toBe(setup.right.getCumulativeMaxHp());
    });

    it("chooses the server's lowest-weight canonical route when several known routes reach the attack-from cell and none matches the client path", () => {
        const currentCell = { x: 3, y: 3 };
        const attackFrom = { x: 4, y: 3 };
        const longRoute = weightedRoute([currentCell, { x: 3, y: 2 }, { x: 4, y: 2 }, attackFrom]); // weight 3
        const shortRoute = weightedRoute([currentCell, attackFrom]); // weight 1 -> canonical
        const setup = setupActionFight({
            supportCell: { x: 2, y: 3 },
            rightCell: { x: 5, y: 3 },
            // Order deliberately puts the longer route first to prove selection is by weight, not position.
            currentActiveKnownPaths: new Map([[cellKey(attackFrom), [longRoute, shortRoute]]]),
        });
        setup.left.refreshPossibleAttackTypes(true);

        const result = setup.engine.apply({
            type: "melee_attack",
            attackerId: setup.left.getId(),
            targetId: setup.right.getId(),
            attackFrom,
            path: [currentCell, { x: 4, y: 4 }, attackFrom], // matches neither known route
        });

        expect(result.completed).toBe(true);
        expect(setup.left.getBaseCell()).toEqual(attackFrom);
        expect(setup.right.getCumulativeHp()).toBeLessThan(setup.right.getCumulativeMaxHp());
    });

    it("performs a move_unit to a reachable destination when the client's path differs from the server's canonical route", () => {
        const currentCell = { x: 3, y: 3 };
        const destination = { x: 3, y: 6 };
        const canonical = [currentCell, { x: 3, y: 4 }, { x: 3, y: 5 }, destination];
        const clientDetour = [currentCell, { x: 4, y: 4 }, { x: 4, y: 5 }, destination];
        const setup = setupActionFight({
            supportCell: { x: 2, y: 3 },
            currentActiveKnownPaths: new Map([[cellKey(destination), [weightedRoute(canonical)]]]),
        });

        const result = setup.engine.apply({
            type: "move_unit",
            unitId: setup.left.getId(),
            path: clientDetour,
        });

        expect(result.completed).toBe(true);
        expect(result.events[0]).toMatchObject({ type: "unit_moved", unitId: setup.left.getId() });
        expect(setup.left.getBaseCell()).toEqual(destination);
    });

    it("SECURITY: still rejects a move_unit whose DESTINATION is not in known paths (path relaxation does not weaken reachability)", () => {
        const currentCell = { x: 3, y: 3 };
        const reachable = { x: 3, y: 4 };
        const unreachableDestination = { x: 3, y: 7 };
        const setup = setupActionFight({
            supportCell: { x: 2, y: 3 },
            currentActiveKnownPaths: new Map([[cellKey(reachable), [weightedRoute([currentCell, reachable])]]]),
        });

        const result = setup.engine.apply({
            type: "move_unit",
            unitId: setup.left.getId(),
            path: [currentCell, { x: 3, y: 5 }, { x: 3, y: 6 }, unreachableDestination],
        });

        expect(result.completed).toBe(false);
        expect(result.rejectionReason).toBe("invalid_move");
        expect(setup.left.getBaseCell()).toEqual(currentCell);
    });

    it("selects the lowest-weight canonical route for a move_unit when several routes reach the destination and none matches the client path", () => {
        const currentCell = { x: 3, y: 3 };
        const destination = { x: 3, y: 5 };
        const longRoute = weightedRoute([currentCell, { x: 2, y: 4 }, { x: 2, y: 5 }, destination]); // weight 3
        const shortRoute = weightedRoute([currentCell, { x: 3, y: 4 }, destination]); // weight 2 -> canonical
        const setup = setupActionFight({
            supportCell: { x: 2, y: 3 },
            currentActiveKnownPaths: new Map([[cellKey(destination), [longRoute, shortRoute]]]),
        });

        const result = setup.engine.apply({
            type: "move_unit",
            unitId: setup.left.getId(),
            path: [currentCell, { x: 4, y: 4 }, destination], // matches neither known route
        });

        expect(result.completed).toBe(true);
        expect(setup.left.getBaseCell()).toEqual(destination);
    });

    it("performs a range attack and consumes a shot through common mechanics", () => {
        const setup = setupActionFight({
            leftAttackType: PBTypes.AttackVals.RANGE,
            leftRangeShots: 3,
            supportCell: { x: 2, y: 3 },
            rightCell: { x: 7, y: 3 },
        });
        setup.left.refreshPossibleAttackTypes(true);
        const shotsBefore = setup.left.getRangeShots();

        const result = setup.engine.apply({
            type: "range_attack",
            attackerId: setup.left.getId(),
            targetId: setup.right.getId(),
        });

        expect(result.completed).toBe(true);
        expect(result.events).toContainEqual(
            expect.objectContaining({
                type: "unit_attacked",
                attackType: "range",
                attackerId: setup.left.getId(),
                targetId: setup.right.getId(),
            }),
        );
        expect(setup.left.getRangeShots()).toBe(shotsBefore - 1);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.left.getId())).toBe(true);
    });

    it("a shot-at shooter counter-shoots, and a bouncing Chakram attacker does not suppress it", () => {
        // A ranged attack is answered by a ranged victim. Zena's Chakram routes its bounces through the
        // AOE tail, which is a different path from a plain shot, so pin that the PRIMARY victim still
        // gets its counter-shot in both shapes — with and without extra enemies for the disc to bounce to.
        const run = (abilities?: string[], bounceTargets = 0): number => {
            const setup = setupActionFight({
                leftAttackType: PBTypes.AttackVals.RANGE,
                leftRangeShots: 3,
                leftAbilities: abilities,
                leftStackPower: 5,
                supportCell: { x: 2, y: 3 },
                rightAttackType: PBTypes.AttackVals.RANGE,
                rightRangeShots: 3,
                rightCell: { x: 7, y: 3 },
            });
            for (let i = 0; i < bounceTargets; i++) {
                const extra = createTestUnit({
                    name: `Bounce ${i}`,
                    team: PBTypes.TeamVals.RIGHT,
                    maxHp: 10_000,
                });
                placeUnit(setup.grid, setup.unitsHolder, extra, { x: 8, y: 4 + i });
            }
            setup.left.refreshPossibleAttackTypes(true);
            setup.right.refreshPossibleAttackTypes(true);
            const hpBefore = setup.left.getHp();
            const result = setup.engine.apply({
                type: "range_attack",
                attackerId: setup.left.getId(),
                targetId: setup.right.getId(),
            });
            expect(result.completed).toBe(true);
            return hpBefore - setup.left.getHp();
        };
        expect(run()).toBeGreaterThan(0);
        expect(run(["Chakram"])).toBeGreaterThan(0);
        expect(run(undefined, 2)).toBeGreaterThan(0);
        expect(run(["Chakram"], 2)).toBeGreaterThan(0);
    });

    it("rejects a range attack from a unit standing in a Range Null Field", () => {
        const setup = setupActionFight({
            leftAttackType: PBTypes.AttackVals.RANGE,
            leftRangeShots: 3,
            supportCell: { x: 2, y: 3 },
            rightCell: { x: 7, y: 3 },
        });
        setup.left.refreshPossibleAttackTypes(true);
        // Stand the shooter inside an enemy's Range Null Field (modelled as a debuff aura) — firing must
        // be impossible, not merely discouraged.
        setup.left.applyAuraEffect("Range Null Field Aura", "", false, 0, "");
        expect(setup.left.hasDebuffActive("Range Null Field Aura")).toBe(true);
        const shotsBefore = setup.left.getRangeShots();

        const result = setup.engine.apply({
            type: "range_attack",
            attackerId: setup.left.getId(),
            targetId: setup.right.getId(),
        });

        expect(result.completed).toBe(false);
        expect(result.rejectionReason).toBe("attack_not_available");
        expect(setup.left.getRangeShots()).toBe(shotsBefore); // no shot consumed
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.left.getId())).toBe(false);
    });

    it("honors a valid range aim (visible edge) and clamps a tampered aim cell to the target", () => {
        const makeSetup = () => {
            const setup = setupActionFight({
                leftAttackType: PBTypes.AttackVals.RANGE,
                leftRangeShots: 3,
                supportCell: { x: 2, y: 3 },
                rightCell: { x: 7, y: 3 },
            });
            setup.left.refreshPossibleAttackTypes(true);
            return setup;
        };

        // Valid aim: the target's own cell + its LEFT side (facing the attacker at x=3 < 7).
        const aimed = makeSetup();
        const aimedHpBefore = aimed.right.getCumulativeHp();
        const aimedResult = aimed.engine.apply({
            type: "range_attack",
            attackerId: aimed.left.getId(),
            targetId: aimed.right.getId(),
            aimCell: { x: 7, y: 3 },
            aimSide: RangeAttackCellSide.LEFT,
        });
        expect(aimedResult.completed).toBe(true);
        expect(aimed.right.getCumulativeHp()).toBeLessThan(aimedHpBefore);

        // Tampered aim: a cell that is NOT part of the target is clamped to the target's footprint —
        // the action still lands on the intended target rather than being honored or silently lost.
        const tampered = makeSetup();
        const tamperedHpBefore = tampered.right.getCumulativeHp();
        const tamperedResult = tampered.engine.apply({
            type: "range_attack",
            attackerId: tampered.left.getId(),
            targetId: tampered.right.getId(),
            aimCell: { x: 14, y: 14 },
            aimSide: RangeAttackCellSide.UP,
        });
        expect(tamperedResult.completed).toBe(true);
        expect(tampered.right.getCumulativeHp()).toBeLessThan(tamperedHpBefore);
    });

    it("carries per-affected-unit splash damage for a Large Caliber (AOE) range attack", () => {
        // Cyclops' Large Caliber is a RANGE attack that splashes the 3x3 around the target. The hit
        // unit's damage must travel in damage.splash with the unit id + impact position so the client
        // can draw a floating number ON the affected unit, not at the primary-target spot only.
        const setup = setupActionFight({
            leftAttackType: PBTypes.AttackVals.RANGE,
            leftAttack: 20,
            leftAbilities: ["Large Caliber"],
            leftDamageMin: 10,
            leftDamageMax: 10,
            leftRangeShots: 3,
            supportCell: { x: 2, y: 3 },
            rightCell: { x: 7, y: 3 },
        });
        setup.left.refreshPossibleAttackTypes(true);
        const hpBefore = setup.right.getCumulativeHp();
        const rightPosition = { ...setup.right.getPosition() };

        const result = setup.engine.apply({
            type: "range_attack",
            attackerId: setup.left.getId(),
            targetId: setup.right.getId(),
        });

        expect(result.completed).toBe(true);
        const attacked = result.events.find((event) => event.type === "unit_attacked");
        expect(attacked?.type).toBe("unit_attacked");
        if (attacked?.type !== "unit_attacked") {
            throw new Error("expected unit_attacked event");
        }
        const splash = attacked.damage.splash;
        expect(splash?.length).toBeGreaterThan(0);
        const entry = splash?.find((s) => s.unitId === setup.right.getId());
        expect(entry).toBeDefined();
        expect(entry?.amount).toBeGreaterThan(0);
        // Position is captured at impact, so it matches where the unit stood when hit.
        expect(entry?.position).toEqual(rightPosition);
        // Sanity: the splashed amount reflects the HP actually lost.
        expect(setup.right.getCumulativeHp()).toBe(hpBefore - (entry?.amount ?? 0));
    });

    it("uses Double Shot's first projectile on a scattered stone and the second on the aimed unit", () => {
        const setup = setupActionFight({
            gridType: PBTypes.GridVals.BLOCK_CENTER,
            leftAttackType: PBTypes.AttackVals.RANGE,
            leftAbilities: ["Double Shot"],
            leftRangeShots: 3,
            leftCell: { x: 3, y: 3 },
            supportCell: { x: 3, y: 4 },
            rightCell: { x: 9, y: 3 },
        });
        setup.grid.setScatteredMountains([{ x: 6, y: 3 }]);
        setup.left.refreshPossibleAttackTypes(true);
        const hpBefore = setup.right.getCumulativeHp();
        const shotsBefore = setup.left.getRangeShots();

        const result = setup.engine.apply({
            type: "range_attack",
            attackerId: setup.left.getId(),
            targetId: setup.right.getId(),
        });

        expect(result.completed).toBe(true);
        expect(setup.grid.getScatteredMountainsStanding()).toEqual([]);
        expect(setup.right.getCumulativeHp()).toBeLessThan(hpBefore);
        expect(setup.left.getRangeShots()).toBe(shotsBefore - 1);
        expect(result.events.filter((event) => event.type === "obstacle_attacked")).toHaveLength(1);
        expect(result.events.filter((event) => event.type === "unit_attacked")).toHaveLength(1);
    });

    // Gargantuan carries Double Shot AND Area Throw. "Ranged attacks ignore structures" has to WIN: before
    // this, the Double Shot stone rule ran first and spent both projectiles on tombstones, so a Cemetery lane
    // holding two stones left the declared creature completely untouched — the ability read as doing nothing.
    // Cyclops never showed it, because Large Caliber comes without Double Shot.
    //
    // Damage is pinned (attack + flat min/max) for the same reason the Large Caliber test above pins it: an
    // unpinned roll can land on nothing and turn "did the shot arrive" into a coin flip.
    for (const ignoring of ["Area Throw", "Large Caliber"]) {
        it(`fires THROUGH scattered stones with Double Shot + ${ignoring} instead of spending projectiles on them`, () => {
            const setup = setupActionFight({
                gridType: PBTypes.GridVals.BLOCK_CENTER,
                leftAttackType: PBTypes.AttackVals.RANGE,
                leftAttack: 20,
                leftAbilities: ["Double Shot", ignoring],
                leftDamageMin: 10,
                leftDamageMax: 10,
                leftRangeShots: 3,
                leftCell: { x: 3, y: 7 },
                supportCell: { x: 3, y: 6 },
                rightCell: { x: 8, y: 7 },
            });
            // TWO stones strictly between shooter and target: the exact shape that used to eat both
            // projectiles and end the turn with zero unit_attacked events.
            setup.grid.setScatteredMountains([
                { x: 5, y: 7 },
                { x: 7, y: 7 },
            ]);
            setup.left.refreshPossibleAttackTypes(true);
            const hpBefore = setup.right.getCumulativeHp();

            const result = setup.engine.apply({
                type: "range_attack",
                attackerId: setup.left.getId(),
                targetId: setup.right.getId(),
            });

            expect(result.completed).toBe(true);
            expect(setup.right.getCumulativeHp()).toBeLessThan(hpBefore);
            // The old behaviour produced obstacle hits and NO unit_attacked at all.
            expect(result.events.filter((event) => event.type === "unit_attacked").length).toBeGreaterThan(0);
        });
    }

    it("shows direct obstacle targeting the same trajectory rule: Double Shot destroys the blocker then the aimed stone", () => {
        const setup = setupActionFight({
            gridType: PBTypes.GridVals.BLOCK_CENTER,
            leftAttackType: PBTypes.AttackVals.RANGE,
            leftAbilities: ["Double Shot"],
            leftRangeShots: 3,
            leftCell: { x: 3, y: 3 },
            supportCell: { x: 3, y: 4 },
            rightCell: { x: 10, y: 8 },
        });
        const blocker = { x: 5, y: 3 };
        const aimedStone = { x: 7, y: 3 };
        // Deliberately reverse layout order: emitted events must still follow projectile/trajectory order.
        setup.grid.setScatteredMountains([aimedStone, blocker]);
        setup.left.refreshPossibleAttackTypes(true);
        const settings = setup.grid.getSettings();
        const targetPosition = getPositionForCell(
            aimedStone,
            settings.getMinX(),
            settings.getStep(),
            settings.getHalfStep(),
        );
        const shotsBefore = setup.left.getRangeShots();

        const result = setup.engine.apply({
            type: "obstacle_attack",
            attackerId: setup.left.getId(),
            targetPosition,
        });

        expect(result.completed).toBe(true);
        expect(setup.grid.getScatteredMountainsStanding()).toEqual([]);
        expect(setup.left.getRangeShots()).toBe(shotsBefore - 1);
        const obstacleEvents = result.events.filter((event) => event.type === "obstacle_attacked");
        expect(obstacleEvents).toHaveLength(2);
        expect(obstacleEvents.map((event) => event.targetPosition)).toEqual([
            getPositionForCell(blocker, settings.getMinX(), settings.getStep(), settings.getHalfStep()),
            targetPosition,
        ]);
    });

    it("spends both Double Shot projectiles on the first two scattered stones before the aimed unit", () => {
        const setup = setupActionFight({
            gridType: PBTypes.GridVals.BLOCK_CENTER,
            leftAttackType: PBTypes.AttackVals.RANGE,
            leftAbilities: ["Double Shot"],
            leftRangeShots: 3,
            leftCell: { x: 3, y: 3 },
            supportCell: { x: 3, y: 4 },
            rightCell: { x: 10, y: 3 },
        });
        const thirdStone = { x: 8, y: 3 };
        setup.grid.setScatteredMountains([{ x: 5, y: 3 }, { x: 7, y: 3 }, thirdStone]);
        setup.left.refreshPossibleAttackTypes(true);
        const hpBefore = setup.right.getCumulativeHp();
        const shotsBefore = setup.left.getRangeShots();

        const result = setup.engine.apply({
            type: "range_attack",
            attackerId: setup.left.getId(),
            targetId: setup.right.getId(),
        });

        expect(result.completed).toBe(true);
        expect(setup.right.getCumulativeHp()).toBe(hpBefore);
        expect(setup.left.getRangeShots()).toBe(shotsBefore - 1);
        expect(setup.grid.getScatteredMountainsStanding()).toEqual([thirdStone]);
        expect(result.events.filter((event) => event.type === "obstacle_attacked")).toHaveLength(2);
        expect(result.events.filter((event) => event.type === "unit_attacked")).toHaveLength(0);
    });

    it("Large Caliber ignores scattered stones on its trajectory and destroys every stone in its 3x3 blast", () => {
        const setup = setupActionFight({
            gridType: PBTypes.GridVals.BLOCK_CENTER,
            leftAttackType: PBTypes.AttackVals.RANGE,
            leftAttack: 20,
            leftAbilities: ["Large Caliber"],
            leftDamageMin: 10,
            leftDamageMax: 10,
            leftRangeShots: 3,
            leftCell: { x: 3, y: 7 },
            supportCell: { x: 3, y: 6 },
            rightCell: { x: 8, y: 7 },
        });
        const inBlast = [
            { x: 7, y: 7 },
            { x: 8, y: 8 },
        ];
        const outsideBlast = { x: 11, y: 11 };
        setup.grid.setScatteredMountains([...inBlast, outsideBlast]);
        setup.left.refreshPossibleAttackTypes(true);
        const hpBefore = setup.right.getCumulativeHp();

        const result = setup.engine.apply({
            type: "range_attack",
            attackerId: setup.left.getId(),
            targetId: setup.right.getId(),
        });

        expect(result.completed).toBe(true);
        expect(setup.right.getCumulativeHp()).toBeLessThan(hpBefore);
        expect(setup.grid.getScatteredMountainsStanding()).toEqual([outsideBlast]);
        expect(result.events.filter((event) => event.type === "obstacle_attacked")).toHaveLength(2);
    });

    it("lets the actual front intersection retaliate when Large Caliber intentionally aims at a rear stack", () => {
        const setup = setupActionFight({
            leftAttackType: PBTypes.AttackVals.RANGE,
            leftAttack: 20,
            leftAbilities: ["Large Caliber"],
            leftDamageMin: 10,
            leftDamageMax: 10,
            leftRangeShots: 3,
            leftCell: { x: 2, y: 7 },
            supportCell: { x: 2, y: 6 },
            rightAttackType: PBTypes.AttackVals.RANGE,
            rightAbilities: ["Infest"],
            rightAmountAlive: 100,
            rightDamageMin: 1_000,
            rightDamageMax: 1_000,
            rightMaxHp: 100,
            rightRangeShots: 3,
            rightCell: { x: 7, y: 7 },
            createSummonedUnit: ({ team, unitName }) =>
                createTestUnit({
                    name: unitName,
                    team,
                    abilities: ["Infest"],
                    summoned: true,
                }),
        });
        const rearAim = createTestUnit({
            name: "Rear aim anchor",
            team: PBTypes.TeamVals.RIGHT,
            attackType: PBTypes.AttackVals.MELEE,
            amountAlive: 100,
            maxHp: 100,
        });
        placeUnit(setup.grid, setup.unitsHolder, rearAim, { x: 10, y: 7 });
        setup.fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.RIGHT, 2);
        setup.left.refreshPossibleAttackTypes(true);
        setup.right.refreshPossibleAttackTypes(true);
        const attackerHpBefore = setup.left.getCumulativeHp();
        const frontHpBefore = setup.right.getCumulativeHp();
        const rearHpBefore = rearAim.getCumulativeHp();

        const result = setup.engine.apply({
            type: "range_attack",
            attackerId: setup.left.getId(),
            targetId: rearAim.getId(),
            aimCell: { x: 10, y: 7 },
            aimSide: RangeAttackCellSide.LEFT,
        });

        expect(result.completed).toBe(true);
        expect(setup.right.getCumulativeHp()).toBeLessThan(frontHpBefore);
        expect(rearAim.getCumulativeHp()).toBe(rearHpBefore);
        expect(setup.right.getResponded()).toBe(true);
        expect(setup.left.getCumulativeHp()).toBeLessThan(attackerHpBefore);
        expect(result.events).toContainEqual(
            expect.objectContaining({
                type: "unit_summoned",
                team: setup.right.getTeam(),
                sourceAbility: "Infest",
            }),
        );
        // The event retains the bounded transport intent; damage and response ownership follow the ray.
        expect(result.events).toContainEqual(
            expect.objectContaining({
                type: "unit_attacked",
                attackType: "range",
                attackerId: setup.left.getId(),
                targetId: rearAim.getId(),
            }),
        );
    });

    it("rejects range attacks against hidden targets without consuming the turn", () => {
        const setup = setupActionFight({
            leftAttackType: PBTypes.AttackVals.RANGE,
            leftRangeShots: 3,
            supportCell: { x: 2, y: 3 },
            rightCell: { x: 7, y: 3 },
        });
        setup.right.applyBuff(
            new Spell({
                spellProperties: getSpellConfig("System", "Hidden"),
                amount: 1,
            }),
        );
        setup.left.refreshPossibleAttackTypes(true);
        const shotsBefore = setup.left.getRangeShots();

        const result = setup.engine.apply({
            type: "range_attack",
            attackerId: setup.left.getId(),
            targetId: setup.right.getId(),
        });

        expect(result.completed).toBe(false);
        expect(result.rejectionReason).toBe("attack_not_available");
        expect(setup.left.getRangeShots()).toBe(shotsBefore);
        expect(setup.right.getCumulativeHp()).toBe(setup.right.getCumulativeMaxHp());
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.left.getId())).toBe(false);
    });

    it("cleans up units killed by common attacks from the holder and grid", () => {
        const rightCell = { x: 7, y: 3 };
        const setup = setupActionFight({
            leftAttackType: PBTypes.AttackVals.RANGE,
            leftAttack: 100,
            leftDamageMin: 100,
            leftDamageMax: 100,
            leftRangeShots: 3,
            supportCell: { x: 2, y: 3 },
            rightCell,
            rightAmountAlive: 1,
            rightArmor: 0,
            rightMaxHp: 10,
        });
        setup.left.refreshPossibleAttackTypes(true);

        const result = setup.engine.apply({
            type: "range_attack",
            attackerId: setup.left.getId(),
            targetId: setup.right.getId(),
        });

        expect(result.completed).toBe(true);
        expect(result.events).toContainEqual({
            type: "unit_destroyed",
            unitId: setup.right.getId(),
            reason: "dead_cleanup",
        });
        expect(setup.unitsHolder.getAllUnits().has(setup.right.getId())).toBe(false);
        expect(setup.grid.getOccupantUnitId(rightCell)).toBe("");
    });

    it("keeps resurrecting units in the holder while emitting a common resurrection event", () => {
        const rightCell = { x: 7, y: 3 };
        const setup = setupActionFight({
            leftAttackType: PBTypes.AttackVals.RANGE,
            leftAttack: 100,
            leftDamageMin: 100,
            leftDamageMax: 100,
            leftRangeShots: 3,
            supportCell: { x: 2, y: 3 },
            rightCell,
            rightAbilities: ["Resurrection"],
            rightAmountAlive: 2,
            rightArmor: 0,
            rightMaxHp: 10,
            rightSpells: ["System:Resurrection"],
        });
        setup.left.refreshPossibleAttackTypes(true);

        const result = setup.engine.apply({
            type: "range_attack",
            attackerId: setup.left.getId(),
            targetId: setup.right.getId(),
        });

        expect(result.completed).toBe(true);
        expect(result.events).toContainEqual(
            expect.objectContaining({
                type: "unit_resurrected",
                unitId: setup.right.getId(),
                team: setup.right.getTeam(),
            }),
        );
        expect(
            result.events.some((event) => event.type === "unit_destroyed" && event.unitId === setup.right.getId()),
        ).toBe(false);
        expect(setup.unitsHolder.getAllUnits().get(setup.right.getId())).toBe(setup.right);
        expect(setup.grid.getOccupantUnitId(rightCell)).toBe(setup.right.getId());
        expect(setup.right.getAmountAlive()).toBeGreaterThan(0);
        expect(setup.right.hasSpellRemaining("Resurrection")).toBe(false);
    });

    it("attacks a block-center obstacle through common mechanics", () => {
        const setup = setupActionFight({
            gridType: PBTypes.GridVals.BLOCK_CENTER,
            leftAttackType: PBTypes.AttackVals.RANGE,
            leftRangeShots: 3,
            supportCell: { x: 2, y: 3 },
            rightCell: { x: 9, y: 9 },
        });
        setup.left.refreshPossibleAttackTypes(true);
        const settings = setup.grid.getSettings();
        const targetPosition = getPositionForCell(
            setup.grid.getCenterCells()[0],
            settings.getMinX(),
            settings.getStep(),
            settings.getHalfStep(),
        );

        const result = setup.engine.apply({
            type: "obstacle_attack",
            attackerId: setup.left.getId(),
            targetPosition,
        });

        expect(result.completed).toBe(true);
        expect(result.events).toContainEqual({
            type: "obstacle_attacked",
            attackerId: setup.left.getId(),
            targetPosition,
            attackFrom: undefined,
            hitsBefore: 2 * HITS_PER_MOUNTAIN,
            hitsAfter: 2 * HITS_PER_MOUNTAIN - 1,
            hitsAfterLeft: HITS_PER_MOUNTAIN - 1,
            hitsAfterRight: HITS_PER_MOUNTAIN,
            animations: expect.any(Array),
        });
        expect(setup.left.getRangeShots()).toBe(2);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.left.getId())).toBe(true);
    });

    it("clears ONLY the struck mountain, leaving the other standing", () => {
        const setup = setupActionFight({
            gridType: PBTypes.GridVals.BLOCK_CENTER,
            leftAttackType: PBTypes.AttackVals.RANGE,
            leftRangeShots: 3,
            supportCell: { x: 2, y: 3 },
            rightCell: { x: 9, y: 9 },
        });
        setup.left.refreshPossibleAttackTypes(true);
        const leftCells = setup.grid.getCenterCells().filter((cell) => cell.x < 8);
        const rightCells = setup.grid.getCenterCells().filter((cell) => cell.x >= 8);
        // Spend the left mountain down to its final hit so this attack (on a left cell) clears it.
        for (let hit = 1; hit < HITS_PER_MOUNTAIN; hit++) {
            setup.fightProperties.encounterObstacleHit(false);
        }
        const settings = setup.grid.getSettings();
        const targetPosition = getPositionForCell(
            leftCells[0],
            settings.getMinX(),
            settings.getStep(),
            settings.getHalfStep(),
        );

        const result = setup.engine.apply({
            type: "obstacle_attack",
            attackerId: setup.left.getId(),
            targetPosition,
        });

        expect(result.completed).toBe(true);
        expect(result.events).toContainEqual({
            type: "center_obstacle_cleared",
            gridType: PBTypes.GridVals.BLOCK_CENTER,
        });
        // Left mountain gone (walkable, no longer a center cell); right mountain untouched.
        expect(setup.fightProperties.getObstacleHitsLeftLeft()).toBe(0);
        expect(setup.fightProperties.getObstacleHitsLeftRight()).toBe(HITS_PER_MOUNTAIN);
        expect(leftCells.every((cell) => setup.grid.getOccupantUnitId(cell) === "")).toBe(true);
        expect(rightCells.every((cell) => setup.grid.getOccupantUnitId(cell) === "B")).toBe(true);
        expect(setup.grid.getCenterCells()).toEqual(rightCells);
    });

    it("clears the whole center once BOTH mountains are spent", () => {
        const setup = setupActionFight({
            gridType: PBTypes.GridVals.BLOCK_CENTER,
            leftAttackType: PBTypes.AttackVals.RANGE,
            leftRangeShots: 3,
            supportCell: { x: 2, y: 3 },
            rightCell: { x: 9, y: 9 },
        });
        setup.left.refreshPossibleAttackTypes(true);
        const allCenterCells = [...setup.grid.getCenterCells()];
        const rightCells = allCenterCells.filter((cell) => cell.x >= 8);
        // Left fully spent, right down to its final hit — this attack (on a right cell) clears both.
        for (let hit = 0; hit < HITS_PER_MOUNTAIN; hit++) {
            setup.fightProperties.encounterObstacleHit(false); // left → 0
        }
        for (let hit = 1; hit < HITS_PER_MOUNTAIN; hit++) {
            setup.fightProperties.encounterObstacleHit(true); // right → 1
        }
        const settings = setup.grid.getSettings();
        const targetPosition = getPositionForCell(
            rightCells[0],
            settings.getMinX(),
            settings.getStep(),
            settings.getHalfStep(),
        );

        const result = setup.engine.apply({
            type: "obstacle_attack",
            attackerId: setup.left.getId(),
            targetPosition,
        });

        expect(result.completed).toBe(true);
        expect(result.events).toContainEqual({
            type: "center_obstacle_cleared",
            gridType: PBTypes.GridVals.BLOCK_CENTER,
        });
        expect(setup.fightProperties.getObstacleHitsLeft()).toBe(0);
        expect(allCenterCells.every((cell) => setup.grid.getOccupantUnitId(cell) === "")).toBe(true);
        expect(setup.grid.getCenterCells()).toEqual([]);
    });

    it("rejects obstacle attacks when no ranged hit or melee approach can land", () => {
        const setup = setupActionFight({
            gridType: PBTypes.GridVals.BLOCK_CENTER,
            leftAttackType: PBTypes.AttackVals.RANGE,
            leftRangeShots: 0,
            supportCell: { x: 2, y: 3 },
            rightCell: { x: 9, y: 9 },
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
            attackerId: setup.left.getId(),
            targetPosition,
        });

        expect(result).toEqual({
            completed: false,
            events: [],
            rejectionReason: "attack_not_available",
            message: undefined,
        });
        expect(setup.fightProperties.getObstacleHitsLeft()).toBe(2 * HITS_PER_MOUNTAIN);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.left.getId())).toBe(false);
    });

    it("rejects obstacle move-attacks when the supplied path is not in known paths", () => {
        const currentCell = { x: 3, y: 3 };
        const allowedCell = { x: 3, y: 4 };
        const setup = setupActionFight({
            gridType: PBTypes.GridVals.BLOCK_CENTER,
            leftAttackType: PBTypes.AttackVals.MELEE,
            supportCell: { x: 2, y: 3 },
            rightCell: { x: 9, y: 9 },
            currentActiveKnownPaths: new Map([[cellKey(allowedCell), [weightedRoute([currentCell, allowedCell])]]]),
        });
        setup.left.refreshPossibleAttackTypes(true);
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
            attackerId: setup.left.getId(),
            targetPosition,
            attackFrom,
            path: [currentCell, attackFrom],
        });

        expect(result.completed).toBe(false);
        expect(result.rejectionReason).toBe("attack_not_available");
        expect(setup.fightProperties.getObstacleHitsLeft()).toBe(2 * HITS_PER_MOUNTAIN);
        expect(setup.left.getBaseCell()).toEqual(currentCell);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.left.getId())).toBe(false);
    });

    it("performs an area throw at a target cell through common mechanics", () => {
        const setup = setupActionFight({
            leftAttackType: PBTypes.AttackVals.RANGE,
            leftAttack: 20,
            leftAbilities: ["Area Throw"],
            leftDamageMin: 10,
            leftDamageMax: 10,
            leftRangeShots: 2,
            supportCell: { x: 2, y: 3 },
            rightCell: { x: 7, y: 7 },
        });
        setup.left.refreshPossibleAttackTypes(true);
        const shotsBefore = setup.left.getRangeShots();
        const hpBefore = setup.right.getCumulativeHp();

        const result = setup.engine.apply({
            type: "area_throw_attack",
            attackerId: setup.left.getId(),
            targetCell: { x: 7, y: 6 },
        });

        expect(result.completed).toBe(true);
        expect(result.events).toContainEqual(
            expect.objectContaining({
                type: "area_attacked",
                attackType: "area_throw",
                attackerId: setup.left.getId(),
                targetCell: { x: 7, y: 6 },
                affectedUnitIds: [setup.right.getId()],
            }),
        );
        expect(setup.left.getRangeShots()).toBe(shotsBefore - 1);
        expect(setup.right.getCumulativeHp()).toBeLessThan(hpBefore);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.left.getId())).toBe(true);

        // The affected unit's damage rides along in damage.splash (with its impact position) so the
        // client can place the floating number on the splashed unit rather than the throw's center.
        const area = result.events.find((event) => event.type === "area_attacked");
        if (area?.type !== "area_attacked") {
            throw new Error("expected area_attacked event");
        }
        const entry = area.damage.splash?.find((s) => s.unitId === setup.right.getId());
        expect(entry).toBeDefined();
        expect(entry?.amount).toBeGreaterThan(0);
        expect(entry?.position).toEqual(setup.right.getPosition());
    });

    it("carries a separate splash entry per shot for a Double-Shot area throw", () => {
        // Gargantuan's Area Throw + Double Shot hits the splash twice. Each shot must contribute its
        // OWN per-unit splash entry so the client draws two distinct floating numbers per affected unit,
        // not a single merged total (the second shot's damage used to be applied but never recorded).
        const setup = setupActionFight({
            leftAttackType: PBTypes.AttackVals.RANGE,
            leftAttack: 20,
            leftAbilities: ["Area Throw", "Double Shot"],
            leftDamageMin: 10,
            leftDamageMax: 10,
            leftRangeShots: 3,
            supportCell: { x: 2, y: 3 },
            rightCell: { x: 7, y: 7 },
            // Area Throw is stack-independent (full 100% from a single stack), so give the target enough bulk
            // to survive BOTH volleys — otherwise the first shot kills it and the second has nothing to splash,
            // which is not what this test is guarding (a recorded entry per shot).
            rightAmountAlive: 100,
            rightMaxHp: 100,
        });
        setup.left.refreshPossibleAttackTypes(true);

        const result = setup.engine.apply({
            type: "area_throw_attack",
            attackerId: setup.left.getId(),
            targetCell: { x: 7, y: 6 },
        });

        expect(result.completed).toBe(true);
        const area = result.events.find((event) => event.type === "area_attacked");
        if (area?.type !== "area_attacked") {
            throw new Error("expected area_attacked event");
        }
        const entries = (area.damage.splash ?? []).filter((s) => s.unitId === setup.right.getId());
        expect(entries.length).toBe(2); // one floating number per shot, not a merged total
        expect(entries.every((e) => e.amount > 0)).toBe(true);
    });

    it("Area Throw flies over scattered stones and destroys every stone in the landing area", () => {
        const setup = setupActionFight({
            gridType: PBTypes.GridVals.BLOCK_CENTER,
            leftAttackType: PBTypes.AttackVals.RANGE,
            leftAttack: 20,
            leftAbilities: ["Area Throw"],
            leftDamageMin: 10,
            leftDamageMax: 10,
            leftRangeShots: 2,
            leftCell: { x: 3, y: 7 },
            supportCell: { x: 3, y: 6 },
            rightCell: { x: 8, y: 8 },
        });
        const inBlast = [
            { x: 7, y: 7 },
            { x: 8, y: 7 },
        ];
        const outsideBlast = { x: 11, y: 11 };
        setup.grid.setScatteredMountains([...inBlast, outsideBlast]);
        setup.left.refreshPossibleAttackTypes(true);
        const hpBefore = setup.right.getCumulativeHp();

        const result = setup.engine.apply({
            type: "area_throw_attack",
            attackerId: setup.left.getId(),
            targetCell: { x: 7, y: 7 },
        });

        expect(result.completed).toBe(true);
        expect(setup.right.getCumulativeHp()).toBeLessThan(hpBefore);
        expect(setup.grid.getScatteredMountainsStanding()).toEqual([outsideBlast]);
        expect(result.events.filter((event) => event.type === "obstacle_attacked")).toHaveLength(2);
    });

    it("projects an area throw onto the first enemy standing on the trajectory", () => {
        // Attacker at {3,3}; an enemy sits at {5,3} directly between it and the empty aimed cell
        // {7,3}. The throw must be intercepted by (project onto) that enemy instead of passing
        // through to the empty cell behind it.
        const setup = setupActionFight({
            leftAttackType: PBTypes.AttackVals.RANGE,
            leftAttack: 20,
            leftAbilities: ["Area Throw"],
            leftDamageMin: 10,
            leftDamageMax: 10,
            leftRangeShots: 2,
            supportCell: { x: 2, y: 8 },
            rightCell: { x: 5, y: 3 },
        });
        setup.left.refreshPossibleAttackTypes(true);
        const hpBefore = setup.right.getCumulativeHp();

        const result = setup.engine.apply({
            type: "area_throw_attack",
            attackerId: setup.left.getId(),
            targetCell: { x: 7, y: 3 },
        });

        expect(result.completed).toBe(true);
        expect(result.events).toContainEqual(
            expect.objectContaining({
                type: "area_attacked",
                attackType: "area_throw",
                attackerId: setup.left.getId(),
                // Projected from the aimed {7,3} onto the intercepting enemy at {5,3}.
                targetCell: { x: 5, y: 3 },
                affectedUnitIds: [setup.right.getId()],
            }),
        );
        expect(setup.right.getCumulativeHp()).toBeLessThan(hpBefore);
    });

    it("rejects area throws without range selection or available shots", () => {
        const wrongType = setupActionFight({
            leftAttackType: PBTypes.AttackVals.MELEE,
            leftAbilities: ["Area Throw"],
            leftRangeShots: 2,
            supportCell: { x: 2, y: 3 },
            rightCell: { x: 7, y: 7 },
        });

        const wrongTypeResult = wrongType.engine.apply({
            type: "area_throw_attack",
            attackerId: wrongType.left.getId(),
            targetCell: { x: 7, y: 6 },
        });

        expect(wrongTypeResult.completed).toBe(false);
        expect(wrongTypeResult.rejectionReason).toBe("attack_not_available");
        expect(wrongType.fightProperties.hasAlreadyMadeTurn(wrongType.left.getId())).toBe(false);

        const noShots = setupActionFight({
            leftAttackType: PBTypes.AttackVals.RANGE,
            leftAbilities: ["Area Throw"],
            leftRangeShots: 0,
            supportCell: { x: 2, y: 3 },
            rightCell: { x: 7, y: 7 },
        });
        noShots.left.refreshPossibleAttackTypes(true);

        const noShotsResult = noShots.engine.apply({
            type: "area_throw_attack",
            attackerId: noShots.left.getId(),
            targetCell: { x: 7, y: 6 },
        });

        expect(noShotsResult.completed).toBe(false);
        expect(noShotsResult.rejectionReason).toBe("attack_not_available");
        expect(noShots.fightProperties.hasAlreadyMadeTurn(noShots.left.getId())).toBe(false);
    });

    it("rejects area throws aimed at occupied unit cells", () => {
        const setup = setupActionFight({
            leftAttackType: PBTypes.AttackVals.RANGE,
            leftAbilities: ["Area Throw"],
            leftRangeShots: 2,
            supportCell: { x: 2, y: 3 },
            rightCell: { x: 7, y: 7 },
        });
        setup.left.refreshPossibleAttackTypes(true);
        const shotsBefore = setup.left.getRangeShots();

        const result = setup.engine.apply({
            type: "area_throw_attack",
            attackerId: setup.left.getId(),
            targetCell: setup.right.getBaseCell(),
        });

        expect(result.completed).toBe(false);
        expect(result.rejectionReason).toBe("attack_not_available");
        expect(setup.left.getRangeShots()).toBe(shotsBefore);
        expect(setup.right.getCumulativeHp()).toBe(setup.right.getCumulativeMaxHp());
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.left.getId())).toBe(false);
    });

    it("casts a single-target spell and completes the active unit turn", () => {
        const setup = setupActionFight({ leftSpells: ["Death:Weakness"] });

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.left.getId(),
            spellName: "Weakness",
            targetId: setup.right.getId(),
        });

        expect(result.completed).toBe(true);
        expect(result.events).toContainEqual(
            expect.objectContaining({
                type: "spell_cast",
                casterId: setup.left.getId(),
                spellName: "Weakness",
                targetId: setup.right.getId(),
            }),
        );
        expect(result.events).toContainEqual({
            type: "turn_completed",
            unitId: setup.left.getId(),
            team: PBTypes.TeamVals.LEFT,
            hourglass: false,
        });
        expect(setup.right.hasDebuffActive("Weakness")).toBe(true);
        expect(setup.left.hasSpellRemaining("Weakness")).toBe(false);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.left.getId())).toBe(true);
    });

    it("reports Wild Regeneration's delivered ability on the authoritative spell event", () => {
        const setup = setupActionFight({ leftAbilities: ["Wild Regeneration"] });

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.left.getId(),
            spellName: "Wild Regeneration",
            targetId: setup.leftSupport.getId(),
        });

        expect(result.completed).toBe(true);
        expect(result.events).toContainEqual(
            expect.objectContaining({
                type: "spell_cast",
                casterId: setup.left.getId(),
                spellName: "Wild Regeneration",
                targetId: setup.leftSupport.getId(),
                abilityTransfers: [
                    {
                        abilityName: "Wild Regeneration",
                        fromUnitId: setup.left.getId(),
                        toUnitId: setup.leftSupport.getId(),
                        mode: "gifted",
                    },
                ],
            }),
        );
        expect(setup.left.hasAbilityActive("Wild Regeneration")).toBe(false);
        expect(setup.leftSupport.hasAbilityActive("Wild Regeneration")).toBe(true);
        expect(setup.left.hasSpellRemaining("Wild Regeneration")).toBe(false);
    });

    it("reports Holy Cross copying Wild Regeneration while both allies retain the ability", () => {
        const setup = setupActionFight({ leftAbilities: ["Wild Regeneration"] });
        setup.left.applyBuff(
            new Spell({
                spellProperties: getSpellConfig("System", "Holy Cross"),
                amount: 1,
            }),
        );

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.left.getId(),
            spellName: "Wild Regeneration",
            targetId: setup.leftSupport.getId(),
        });

        expect(result.completed).toBe(true);
        expect(result.events).toContainEqual(
            expect.objectContaining({
                type: "spell_cast",
                casterId: setup.left.getId(),
                spellName: "Wild Regeneration",
                targetId: setup.leftSupport.getId(),
                abilityTransfers: [
                    {
                        abilityName: "Wild Regeneration",
                        fromUnitId: setup.left.getId(),
                        toUnitId: setup.leftSupport.getId(),
                        mode: "copied",
                    },
                ],
            }),
        );
        expect(setup.left.hasAbilityActive("Wild Regeneration")).toBe(true);
        expect(setup.leftSupport.hasAbilityActive("Wild Regeneration")).toBe(true);
    });

    it("reports a Wild Regeneration gift delivered while Break temporarily disables the recipient", () => {
        const setup = setupActionFight({ leftAbilities: ["Wild Regeneration"] });
        setup.leftSupport.applyEffect(new EffectFactory().makeEffect("Break")!);

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.left.getId(),
            spellName: "Wild Regeneration",
            targetId: setup.leftSupport.getId(),
        });

        expect(result.completed).toBe(true);
        expect(result.events).toContainEqual(
            expect.objectContaining({
                type: "spell_cast",
                abilityTransfers: [
                    expect.objectContaining({
                        abilityName: "Wild Regeneration",
                        toUnitId: setup.leftSupport.getId(),
                        mode: "gifted",
                    }),
                ],
            }),
        );
        expect(setup.leftSupport.hasAbilityActive("Wild Regeneration")).toBe(false);
        expect(setup.leftSupport.getUnitProperties().abilities).toContain("Wild Regeneration");
    });

    it("casts Castling (POSITION_CHANGE) and swaps the caster with the in-range small enemy", () => {
        const enemyCell = { x: 5, y: 3 };
        const setup = setupActionFight({
            leftSpells: ["System:Castling"],
            leftStackPower: 4, // Castling needs minimal_caster_stack_power 4
            rightCell: enemyCell,
            currentEnemiesCellsWithinMovementRange: [enemyCell],
        });
        const casterStart = { ...setup.left.getBaseCell() };

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.left.getId(),
            spellName: "Castling",
            targetId: setup.right.getId(),
            targetCell: setup.right.getBaseCell(),
        });

        expect(result.completed).toBe(true);
        expect(setup.left.getBaseCell()).toEqual(enemyCell);
        expect(setup.right.getBaseCell()).toEqual(casterStart);
    });

    it("rejects Castling inherited by a LARGE caster without mutating combat state", () => {
        const enemyCell = { x: 5, y: 3 };
        const setup = setupActionFight({
            leftSize: PBTypes.UnitSizeVals.LARGE,
            leftSpells: ["System:Castling"],
            leftStackPower: 4,
            rightCell: enemyCell,
            currentEnemiesCellsWithinMovementRange: [enemyCell],
        });
        const casterPosition = structuredClone(setup.left.getPosition());
        const targetPosition = structuredClone(setup.right.getPosition());
        const matrix = structuredClone(setup.grid.getMatrix());

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.left.getId(),
            spellName: "Castling",
            targetId: setup.right.getId(),
            targetCell: setup.right.getBaseCell(),
        });

        expect(result.completed).toBe(false);
        expect(result.rejectionReason).toBe("spell_not_available");
        expect(setup.left.getPosition()).toEqual(casterPosition);
        expect(setup.right.getPosition()).toEqual(targetPosition);
        expect(setup.grid.getMatrix()).toEqual(matrix);
        expect(setup.left.hasSpellRemaining("Castling")).toBe(true);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.left.getId())).toBe(false);
    });

    it("does not collapse a LARGE Absorb Penalties target when Castling is redirected", () => {
        const enemyCell = { x: 5, y: 3 };
        const setup = setupActionFight({
            leftSpells: ["System:Castling"],
            leftStackPower: 4,
            rightCell: enemyCell,
            currentEnemiesCellsWithinMovementRange: [enemyCell],
        });
        const absorber = createTestUnit({
            name: "Large Absorber",
            team: PBTypes.TeamVals.RIGHT,
            size: PBTypes.UnitSizeVals.LARGE,
        });
        const absorberCells = [
            { x: 7, y: 5 },
            { x: 6, y: 5 },
            { x: 7, y: 4 },
            { x: 6, y: 4 },
        ];
        const absorberPosition = getPositionForCells(setup.grid.getSettings(), absorberCells);
        expect(absorberPosition).toBeDefined();
        absorber.setPosition(absorberPosition!.x, absorberPosition!.y);
        setup.grid.occupyCells(
            absorberCells,
            absorber.getId(),
            absorber.getTeam(),
            absorber.getAttackRange(),
            false,
            false,
        );
        setup.unitsHolder.addUnit(absorber);
        setup.right.applyAuraEffect("Absorb Penalties Aura", "absorb", true, 100, "7;5");

        const casterPosition = structuredClone(setup.left.getPosition());
        const targetPosition = structuredClone(setup.right.getPosition());
        const largePosition = structuredClone(absorber.getPosition());
        const matrix = structuredClone(setup.grid.getMatrix());
        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.left.getId(),
            spellName: "Castling",
            targetId: setup.right.getId(),
            targetCell: setup.right.getBaseCell(),
        });

        expect(result.completed).toBe(true);
        expect(result.rejectionReason).toBeUndefined();
        expect(setup.left.getPosition()).toEqual(casterPosition);
        expect(setup.right.getPosition()).toEqual(targetPosition);
        expect(absorber.getPosition()).toEqual(largePosition);
        expect(setup.grid.getMatrix()).toEqual(matrix);
        expect(result.events).toContainEqual(
            expect.objectContaining({
                type: "spell_cast",
                casterId: setup.left.getId(),
                targetId: setup.right.getId(),
                spellName: "Castling",
                animations: [],
            }),
        );
        expect(setup.left.hasSpellRemaining("Castling")).toBe(false);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.left.getId())).toBe(true);
    });

    it("rejects Castling when the in-range enemy list is absent (the ranked server-context bug)", () => {
        const enemyCell = { x: 5, y: 3 };
        const setup = setupActionFight({
            leftSpells: ["System:Castling"],
            leftStackPower: 4,
            rightCell: enemyCell,
            // currentEnemiesCellsWithinMovementRange intentionally omitted — exactly what the server used
            // to do, which made every Castling cast reject. Providing it (server fix) is what makes the
            // positive test above pass.
        });

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.left.getId(),
            spellName: "Castling",
            targetId: setup.right.getId(),
            targetCell: setup.right.getBaseCell(),
        });

        expect(result.completed).toBe(false);
        expect(result.rejectionReason).toBe("spell_not_available");
    });

    it("rejects single-target spells with stale target-cell data", () => {
        const setup = setupActionFight({ leftSpells: ["Death:Weakness"] });

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.left.getId(),
            spellName: "Weakness",
            targetId: setup.right.getId(),
            targetCell: setup.leftSupport.getBaseCell(),
        });

        expect(result.completed).toBe(false);
        expect(result.rejectionReason).toBe("spell_not_available");
        expect(setup.right.hasDebuffActive("Weakness")).toBe(false);
        expect(setup.left.hasSpellRemaining("Weakness")).toBe(true);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.left.getId())).toBe(false);
    });

    it("emits spell animation metadata for Castling swaps", () => {
        const rightCell = { x: 4, y: 3 };
        const setup = setupActionFight({
            leftSpells: ["System:Castling"],
            leftStackPower: 4,
            supportCell: { x: 2, y: 3 },
            rightCell,
            currentEnemiesCellsWithinMovementRange: [rightCell],
        });
        const casterStart = structuredClone(setup.left.getPosition());
        const targetStart = structuredClone(setup.right.getPosition());

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.left.getId(),
            spellName: "Castling",
            targetId: setup.right.getId(),
        });

        expect(result.completed).toBe(true);
        expect(setup.left.getPosition()).toEqual(targetStart);
        expect(setup.right.getPosition()).toEqual(casterStart);
        expect(result.events).toContainEqual(
            expect.objectContaining({
                type: "spell_cast",
                casterId: setup.left.getId(),
                spellName: "Castling",
                targetId: setup.right.getId(),
                animations: expect.arrayContaining([
                    expect.objectContaining({
                        affectedUnitId: setup.left.getId(),
                        bodyUnitId: setup.left.getId(),
                        toPosition: targetStart,
                    }),
                    expect.objectContaining({
                        affectedUnitId: setup.right.getId(),
                        bodyUnitId: setup.right.getId(),
                        toPosition: casterStart,
                    }),
                ]),
            }),
        );
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.left.getId())).toBe(true);
    });

    it("rejects invalid spell targets without completing the turn", () => {
        const setup = setupActionFight({ leftSpells: ["Death:Weakness"] });

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.left.getId(),
            spellName: "Weakness",
            targetId: setup.leftSupport.getId(),
        });

        expect(result).toEqual({
            completed: false,
            events: [],
            rejectionReason: "spell_not_available",
            message: undefined,
        });
        expect(setup.leftSupport.hasDebuffActive("Weakness")).toBe(false);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.left.getId())).toBe(false);
    });

    it("does not amplify healing spells with Tome", () => {
        const setup = setupActionFight({
            leftSpells: ["Life:Mass Heal"],
            leftStackPower: 3,
        });
        setup.fightProperties.setArtifactPerTeam(
            PBTypes.TeamVals.LEFT,
            ArtifactTier.TIER_2,
            Tier2Artifact.TOME_OF_AMPLIFICATION,
        );
        setup.unitsHolder.applyArtifacts(setup.fightProperties);
        setup.leftSupport.applyDamage(6, 0, setup.sceneLog);
        const hpBefore = setup.leftSupport.getHp();

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.left.getId(),
            spellName: "Mass Heal",
        });

        expect(result.completed).toBe(true);
        expect(result.events).toContainEqual(
            expect.objectContaining({
                type: "spell_cast",
                casterId: setup.left.getId(),
                spellName: "Mass Heal",
            }),
        );
        expect(setup.leftSupport.getHp()).toBe(hpBefore + 2);
        expect(setup.left.hasSpellRemaining("Mass Heal")).toBe(false);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.left.getId())).toBe(true);
    });

    it("amplifies an Ogre Mage's Mass Riot once for every allied recipient", () => {
        const setup = setupActionFight({
            leftSpells: ["Chaos:Mass Riot"],
            leftStackPower: 4,
        });
        setup.fightProperties.setArtifactPerTeam(
            PBTypes.TeamVals.LEFT,
            ArtifactTier.TIER_2,
            Tier2Artifact.TOME_OF_AMPLIFICATION,
        );
        setup.unitsHolder.applyArtifacts(setup.fightProperties);
        const sourceSpell = setup.left.getSpells()[0];

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.left.getId(),
            spellName: "Mass Riot",
        });

        expect(result.completed).toBe(true);
        expect(sourceSpell.getPower()).toBe(25);
        expect(setup.left.getBuff("Mass Riot")?.getPower()).toBe(37.5);
        expect(setup.leftSupport.getBuff("Mass Riot")?.getPower()).toBe(37.5);
        expect(setup.leftSupport.getUnitProperties().applied_buffs_powers).toContain(37.5);
        expect(setup.leftSupport.getBuff("Mass Riot")?.getPower()).not.toBe(56.25);
        setup.leftSupport.adjustBaseStats(false, 1, 0, 0, 0, 0, 0, 0);
        expect(setup.leftSupport.getAttack()).toBeCloseTo(13.75);
        setup.leftSupport.adjustBaseStats(false, 1, 0, 0, 0, 0, 0, 0);
        expect(setup.leftSupport.getAttack()).toBeCloseTo(13.75);
    });

    it("amplifies a cast Wind Flow only for allied flyers", () => {
        const setup = setupActionFight({
            leftSpells: ["System:Wind Flow"],
            leftStackPower: 5,
            supportMovementType: PBTypes.MovementVals.FLY,
            rightMovementType: PBTypes.MovementVals.FLY,
        });
        setup.fightProperties.setArtifactPerTeam(
            PBTypes.TeamVals.LEFT,
            ArtifactTier.TIER_2,
            Tier2Artifact.TOME_OF_AMPLIFICATION,
        );
        setup.unitsHolder.applyArtifacts(setup.fightProperties);

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.left.getId(),
            spellName: "Wind Flow",
        });

        expect(result.completed).toBe(true);
        expect(setup.leftSupport.hasBuffActive("Wind Flow")).toBe(true);
        expect(setup.right.hasBuffActive("Wind Flow")).toBe(true);
        expect(setup.leftSupport.getBuff("Wind Flow")?.getPower()).toBe(6);
        expect(setup.right.getBuff("Wind Flow")?.getPower()).toBe(4);
        expect(setup.left.hasSpellRemaining("Wind Flow")).toBe(false);
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
            weaknessProperties.element,
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
        setup.left.getSpells().push(new Spell({ spellProperties: massWeaknessProperties, amount: 1 }));

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.left.getId(),
            spellName: "Mass Weakness",
        });

        expect(result.completed).toBe(true);
        expect(setup.right.hasDebuffActive("Mass Weakness")).toBe(true);
        expect(setup.left.hasSpellRemaining("Mass Weakness")).toBe(false);
    });

    it("summons a new stack through common mechanics", () => {
        const summonCell = { x: 3, y: 4 };
        const setup = setupActionFight({
            leftSpells: ["Nature:Summon Wolves"],
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
            casterId: setup.left.getId(),
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
                casterId: setup.left.getId(),
                unitId: summoned?.getId(),
                unitName: "Wolf",
                amount: 1,
                merged: false,
            }),
        );
        expect(setup.left.hasSpellRemaining("Summon Wolves")).toBe(false);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.left.getId())).toBe(true);
    });

    it("merges summon amount into an existing summoned stack", () => {
        const setup = setupActionFight({ leftSpells: ["Nature:Summon Wolves"] });
        const existingWolf = createTestUnit({
            name: "Wolf",
            team: PBTypes.TeamVals.LEFT,
            amountAlive: 3,
            summoned: true,
        });
        placeUnit(setup.grid, setup.unitsHolder, existingWolf, { x: 5, y: 5 });

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.left.getId(),
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
        expect(setup.left.hasSpellRemaining("Summon Wolves")).toBe(false);
    });

    it("rejects new summon stacks when no common factory is available", () => {
        const setup = setupActionFight({ leftSpells: ["Nature:Summon Wolves"] });

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.left.getId(),
            spellName: "Summon Wolves",
            targetCell: { x: 3, y: 4 },
        });

        expect(result).toEqual({
            completed: false,
            events: [],
            rejectionReason: "summon_unit_factory_missing",
            message: undefined,
        });
        expect(setup.left.hasSpellRemaining("Summon Wolves")).toBe(true);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.left.getId())).toBe(false);
    });

    it("starts a valid setup fight through common mechanics", () => {
        const setup = setupPlacementFight();
        const right = createTestUnit({ name: "Upper", team: PBTypes.TeamVals.RIGHT });
        placeUnit(setup.grid, setup.unitsHolder, setup.unit, { x: 2, y: 2 });
        placeUnit(setup.grid, setup.unitsHolder, right, { x: 10, y: 10 });

        const result = setup.engine.apply({ type: "start_fight" });

        expect(result).toEqual({
            completed: true,
            events: [{ type: "fight_started", leftUnitsAlive: 1, rightUnitsAlive: 1 }],
        });
        expect(setup.fightProperties.hasFightStarted()).toBe(true);
        expect(setup.fightProperties.getTeamUnitsAlive(PBTypes.TeamVals.LEFT)).toBe(1);
        expect(setup.fightProperties.getTeamUnitsAlive(PBTypes.TeamVals.RIGHT)).toBe(1);
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
        const right = createTestUnit({ name: "Upper", team: PBTypes.TeamVals.RIGHT });
        placeUnit(started.grid, started.unitsHolder, started.unit, { x: 2, y: 2 });
        placeUnit(started.grid, started.unitsHolder, right, { x: 10, y: 10 });
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
        const blocker = createTestUnit({ name: "Blocker", team: PBTypes.TeamVals.RIGHT });
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

    it("drops a cell-less split beside the source instead of leaving it at the origin", () => {
        const setup = setupPlacementFight({
            amountAlive: 7,
            canSplitUnit: () => true,
            createSplitUnit: (sourceUnit, amount) =>
                createTestUnit({ name: sourceUnit.getName(), team: sourceUnit.getTeam(), amountAlive: amount }),
        });

        const sourceCell = { x: 2, y: 2 };
        expect(
            setup.engine.apply({
                type: "place_unit",
                unitId: setup.unit.getId(),
                team: setup.unit.getTeam(),
                unitName: setup.unit.getName(),
                cells: [sourceCell],
            }).completed,
        ).toBe(true);

        const result = setup.engine.apply({ type: "split_unit", unitId: setup.unit.getId(), amount: 3 });
        const splitEvent = result.events.find((event) => event.type === "unit_split");
        const placedEvent = result.events.find((event) => event.type === "unit_placed");
        const newUnitId = splitEvent?.type === "unit_split" ? splitEvent.newUnitId : "";
        const placedCell = placedEvent?.type === "unit_placed" ? placedEvent.cells[0] : undefined;

        expect(result.completed).toBe(true);
        // The sidebar's "Split Selected" names no cell, so the engine picks one touching the source.
        expect(placedCell).toBeDefined();
        expect(Math.max(Math.abs(placedCell!.x - sourceCell.x), Math.abs(placedCell!.y - sourceCell.y))).toBe(1);
        expect(setup.grid.getOccupantUnitId(placedCell!)).toBe(newUnitId);
        expect(setup.unit.getAmountAlive()).toBe(4);
    });

    it("splits AND places the peeled stack when the drag gesture supplies target cells", () => {
        const setup = setupPlacementFight({
            amountAlive: 7,
            canSplitUnit: () => true,
            createSplitUnit: (sourceUnit, amount) =>
                createTestUnit({ name: sourceUnit.getName(), team: sourceUnit.getTeam(), amountAlive: amount }),
        });

        const target = { x: 4, y: 4 };
        const result = setup.engine.apply({
            type: "split_unit",
            unitId: setup.unit.getId(),
            amount: 3,
            cells: [target],
        });
        const splitEvent = result.events.find((event) => event.type === "unit_split");
        const placedEvent = result.events.find((event) => event.type === "unit_placed");
        const newUnitId = splitEvent?.type === "unit_split" ? splitEvent.newUnitId : "";

        expect(result.completed).toBe(true);
        // The placement rides in the SAME action, so no second round-trip can lose the cell.
        expect(placedEvent?.type === "unit_placed" ? placedEvent.unitId : "").toBe(newUnitId);
        expect(setup.grid.getOccupantUnitId(target)).toBe(newUnitId);
        expect(setup.unit.getAmountAlive()).toBe(4);
        expect(setup.unitsHolder.getAllUnits().get(newUnitId)?.getAmountAlive()).toBe(3);
    });

    it("leaves the source stack whole when the drag target is not placeable", () => {
        const setup = setupPlacementFight({
            amountAlive: 7,
            canSplitUnit: () => true,
            createSplitUnit: (sourceUnit, amount) =>
                createTestUnit({ name: sourceUnit.getName(), team: sourceUnit.getTeam(), amountAlive: amount }),
        });

        // Outside the fixture's placement predicate (it only allows cells with x <= 4 && y <= 4).
        const result = setup.engine.apply({
            type: "split_unit",
            unitId: setup.unit.getId(),
            amount: 3,
            cells: [{ x: 7, y: 7 }],
        });

        // The peel must be all-or-nothing: a refused target can't leave a halved stack with nowhere to go.
        expect(result.completed).toBe(false);
        expect(setup.unit.getAmountAlive()).toBe(7);
        expect(setup.unitsHolder.getAllUnits().size).toBe(1);
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
            actionSetup.left,
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
            unitId: setup.left.getId(),
        } as unknown as GameAction);

        expect(result.completed).toBe(false);
        expect(result.rejectionReason).toBe("unsupported_action");
        expect(result.events).toEqual([]);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.left.getId())).toBe(false);
    });
});

describe("action engine — custom targeted spell legality", () => {
    const enemySpells: readonly {
        spellName: string;
        spells?: string[];
        abilities?: string[];
        stackPower: number;
        supportCell?: { x: number; y: number };
    }[] = [
        { spellName: "Vine Throw", abilities: ["Vine Throw"], stackPower: 3 },
        { spellName: "Fire Strike", spells: ["Life:Fire Strike"], stackPower: 1 },
        { spellName: "Lightning Strike", spells: ["Nature:Lightning Strike"], stackPower: 1 },
        // Ring of Fire needs a body in the ring: the redesign spares the aimed enemy itself, so a cast at a
        // lone target now legitimately catches nobody and the engine refuses it. Parking the ally beside the
        // target (it burns friend or foe) gives the ring something to hit, while (6,4) stays off the
        // caster's line to (6,3) so this still tests LINE OF SIGHT rather than accidentally blocking it.
        { spellName: "Ring of Fire", spells: ["Nature:Ring of Fire"], stackPower: 4, supportCell: { x: 6, y: 4 } },
    ];

    for (const spellCase of enemySpells) {
        it(`${spellCase.spellName} rejects a Hidden enemy without spending its charge or turn`, () => {
            const setup = setupActionFight({
                leftAbilities: spellCase.abilities,
                leftSpells: spellCase.spells,
                leftStackPower: spellCase.stackPower,
                rightCell: { x: 6, y: 3 },
                rightMaxHp: 10_000,
                supportCell: spellCase.supportCell ?? { x: 3, y: 6 },
            });
            setup.right.applyBuff(
                new Spell({
                    spellProperties: getSpellConfig("System", "Hidden"),
                    amount: 1,
                }),
            );
            const chargesBefore = setup.left
                .getSpells()
                .find((spell) => spell.getName() === spellCase.spellName)
                ?.getAmount();

            const result = setup.engine.apply({
                type: "cast_spell",
                casterId: setup.left.getId(),
                spellName: spellCase.spellName,
                targetId: setup.right.getId(),
            });

            expect(result.completed).toBe(false);
            expect(result.rejectionReason).toBe("spell_not_available");
            expect(
                setup.left
                    .getSpells()
                    .find((spell) => spell.getName() === spellCase.spellName)
                    ?.getAmount(),
            ).toBe(chargesBefore);
            expect(setup.fightProperties.hasAlreadyMadeTurn(setup.left.getId())).toBe(false);
        });

        it(`${spellCase.spellName} rejects an allied target without spending its charge or turn`, () => {
            const setup = setupActionFight({
                leftAbilities: spellCase.abilities,
                leftSpells: spellCase.spells,
                leftStackPower: spellCase.stackPower,
                rightCell: { x: 6, y: 3 },
                supportCell: { x: 3, y: 6 },
            });
            const chargesBefore = setup.left
                .getSpells()
                .find((spell) => spell.getName() === spellCase.spellName)
                ?.getAmount();

            const result = setup.engine.apply({
                type: "cast_spell",
                casterId: setup.left.getId(),
                spellName: spellCase.spellName,
                targetId: setup.leftSupport.getId(),
            });

            expect(result.completed).toBe(false);
            expect(result.rejectionReason).toBe("spell_not_available");
            expect(
                setup.left
                    .getSpells()
                    .find((spell) => spell.getName() === spellCase.spellName)
                    ?.getAmount(),
            ).toBe(chargesBefore);
            expect(setup.fightProperties.hasAlreadyMadeTurn(setup.left.getId())).toBe(false);
        });

        it(`${spellCase.spellName} still accepts a visible enemy target`, () => {
            const setup = setupActionFight({
                leftAbilities: spellCase.abilities,
                leftSpells: spellCase.spells,
                leftStackPower: spellCase.stackPower,
                rightCell: { x: 6, y: 3 },
                rightMaxHp: 10_000,
                supportCell: spellCase.supportCell ?? { x: 3, y: 6 },
            });
            const aimedHpBefore = setup.right.getCumulativeHp();
            const ringVictimHpBefore = setup.leftSupport.getCumulativeHp();

            const result = setup.engine.apply({
                type: "cast_spell",
                casterId: setup.left.getId(),
                spellName: spellCase.spellName,
                targetId: setup.right.getId(),
            });

            expect(result.completed).toBe(true);
            expect(setup.fightProperties.hasAlreadyMadeTurn(setup.left.getId())).toBe(true);
            if (spellCase.spellName === "Ring of Fire") {
                expect(setup.right.getCumulativeHp()).toBe(aimedHpBefore);
                expect(setup.leftSupport.getCumulativeHp()).toBeLessThan(ringVictimHpBefore);
            }
        });
    }

    it("Armor Rune rejects an enemy but still accepts an ally", () => {
        const enemySetup = setupActionFight({
            leftAbilities: ["Enchants"],
            leftSpells: ["System:Armor Rune"],
            leftStackPower: 1,
            rightCell: { x: 6, y: 3 },
            supportCell: { x: 3, y: 6 },
        });
        const rejected = enemySetup.engine.apply({
            type: "cast_spell",
            casterId: enemySetup.left.getId(),
            spellName: "Armor Rune",
            targetId: enemySetup.right.getId(),
        });

        expect(rejected.completed).toBe(false);
        expect(rejected.rejectionReason).toBe("spell_not_available");
        expect(enemySetup.left.hasSpellRemaining("Armor Rune")).toBe(true);
        expect(enemySetup.fightProperties.hasAlreadyMadeTurn(enemySetup.left.getId())).toBe(false);

        const allySetup = setupActionFight({
            leftAbilities: ["Enchants"],
            leftSpells: ["System:Armor Rune"],
            leftStackPower: 1,
            rightCell: { x: 6, y: 3 },
            supportCell: { x: 3, y: 6 },
        });
        const accepted = allySetup.engine.apply({
            type: "cast_spell",
            casterId: allySetup.left.getId(),
            spellName: "Armor Rune",
            targetId: allySetup.leftSupport.getId(),
        });

        expect(accepted.completed).toBe(true);
        expect(allySetup.left.hasSpellRemaining("Armor Rune")).toBe(false);
        expect(allySetup.fightProperties.hasAlreadyMadeTurn(allySetup.left.getId())).toBe(true);
    });
});

// Vine Throw (Trent / Grove Spellbook) — the cast has to do three things at once: lay the vine on every
// cell it crossed, snare the target's movement, and refuse the throw when the line is blocked. The
// movement PRICE of a vined cell is pinned separately in test/spells/vine_movement.test.ts.
describe("action engine — Vine Throw", () => {
    it("lays the vine along the path, snares the target, and spends the scroll", () => {
        const setup = setupActionFight({
            // Carried as a castable ABILITY (like Valkyrie's Wind Flow), not as a spellbook entry.
            leftAbilities: ["Vine Throw"],
            leftStackPower: 3,
            rightCell: { x: 6, y: 3 },
            // The harness parks the friendly support on (4,3) by default, which is ON the throw line and
            // would (correctly) block it. Move it aside so this test exercises the clear-line case.
            supportCell: { x: 3, y: 6 },
        });
        const vines = setup.fightProperties.getVines();
        expect(vines.size()).toBe(0);
        const stepsBefore = setup.right.getSteps();

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.left.getId(),
            spellName: "Vine Throw",
            targetId: setup.right.getId(),
        });

        expect(result.completed).toBe(true);
        // Caster at (3,3), target at (6,3): the three cells in between and the target's own get vined,
        // the caster's own cell does not.
        expect(vines.has({ x: 3, y: 3 })).toBe(false);
        for (const cell of [
            { x: 4, y: 3 },
            { x: 5, y: 3 },
            { x: 6, y: 3 },
        ]) {
            expect(vines.has(cell)).toBe(true);
        }
        expect(result.events).toContainEqual(
            expect.objectContaining({
                type: "vine_placed",
                casterId: setup.left.getId(),
                targetId: setup.right.getId(),
                // The harness default is 0 magic resist, so the snare cannot be saved against here.
                snareResisted: false,
            }),
        );
        expect(setup.right.hasDebuffActive("Vine Throw")).toBe(true);
        expect(setup.right.getSteps()).toBeLessThan(stepsBefore);
        expect(setup.left.hasSpellRemaining("Vine Throw")).toBe(false);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.left.getId())).toBe(true);
    });

    // The snare is a debuff, so magic armor takes its usual save against it. What the save does NOT undo is
    // the terrain: the vine is laid by the throw itself, which physically happened, and the charge is spent
    // buying that throw. Resisting means this creature shrugs off the grip, not that the vine never existed.
    // The roll is driven from a seeded source rather than a 100-resist target, because 100 is full magic
    // immunity and the cast is refused outright before it ever reaches the save.
    describe("magic armor save", () => {
        afterEach(() => setDeterministicRandomSource(undefined));

        const WARDED_RESIST = 50;
        // Constant sources, so it does not matter how many draws the cast takes on the way to the save —
        // every one of them yields the same number. What that number IS falls out of the seeded source's
        // bit mixing rather than the float itself, so the first test below pins both against the resist;
        // without it these two could quietly drift onto the same side and stop testing anything.
        const SOURCE_UNDER_RESIST = 0;
        const SOURCE_OVER_RESIST = 0.25;

        const throwAtWardedTarget = (source: number) => {
            setDeterministicRandomSource(() => source);
            const setup = setupActionFight({
                leftAbilities: ["Vine Throw"],
                leftStackPower: 3,
                rightCell: { x: 6, y: 3 },
                supportCell: { x: 3, y: 6 },
                rightMagicResist: WARDED_RESIST,
            });
            const result = setup.engine.apply({
                type: "cast_spell",
                casterId: setup.left.getId(),
                spellName: "Vine Throw",
                targetId: setup.right.getId(),
            });
            return { setup, result };
        };

        const VINED_CELLS = [
            { x: 4, y: 3 },
            { x: 5, y: 3 },
            { x: 6, y: 3 },
        ];

        it("draws the two seeded rolls on either side of the target's magic resist", () => {
            setDeterministicRandomSource(() => SOURCE_UNDER_RESIST);
            expect(getRandomInt(0, 100)).toBeLessThan(WARDED_RESIST);
            setDeterministicRandomSource(() => SOURCE_OVER_RESIST);
            expect(getRandomInt(0, 100)).toBeGreaterThanOrEqual(WARDED_RESIST);
        });

        it("shrugs the snare off on a winning roll, and still leaves the vine on the ground", () => {
            const { setup, result } = throwAtWardedTarget(SOURCE_UNDER_RESIST);

            expect(result.completed).toBe(true);
            expect(setup.right.hasDebuffActive("Vine Throw")).toBe(false);
            // The throw landed its terrain regardless, and paid for it.
            for (const cell of VINED_CELLS) {
                expect(setup.fightProperties.getVines().has(cell)).toBe(true);
            }
            expect(setup.left.hasSpellRemaining("Vine Throw")).toBe(false);
            // Ranked rebuilds its scene log from events and never reads the engine's text, so the save has
            // to ride on the event or a resisted snare reads there exactly like one that landed.
            expect(result.events).toContainEqual(expect.objectContaining({ type: "vine_placed", snareResisted: true }));
        });

        it("snares the same warded target when the roll goes the other way", () => {
            const { setup, result } = throwAtWardedTarget(SOURCE_OVER_RESIST);

            expect(result.completed).toBe(true);
            expect(setup.right.hasDebuffActive("Vine Throw")).toBe(true);
            for (const cell of VINED_CELLS) {
                expect(setup.fightProperties.getVines().has(cell)).toBe(true);
            }
            expect(result.events).toContainEqual(
                expect.objectContaining({ type: "vine_placed", snareResisted: false }),
            );
        });
    });

    it("refuses the throw when a body blocks the line and leaves no vine behind", () => {
        const setup = setupActionFight({
            // Carried as a castable ABILITY (like Valkyrie's Wind Flow), not as a spellbook entry.
            leftAbilities: ["Vine Throw"],
            leftStackPower: 3,
            rightCell: { x: 6, y: 3 },
            // The friendly support sits between caster and target, breaking line of sight.
            supportCell: { x: 5, y: 3 },
        });

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.left.getId(),
            spellName: "Vine Throw",
            targetId: setup.right.getId(),
        });

        expect(result.completed).toBe(false);
        expect(setup.fightProperties.getVines().size()).toBe(0);
        expect(setup.right.hasDebuffActive("Vine Throw")).toBe(false);
        expect(setup.left.hasSpellRemaining("Vine Throw")).toBe(true);
    });
});

// The client's move pipeline end-to-end for a vine strider: compute the reachable set with the REAL
// pathfinder (as Sandbox does), hand it to the engine as currentActiveKnownPaths (as Sandbox does), then
// actually walk onto a cell that is only reachable BECAUSE of the vine discount. The earlier vine tests
// only pinned the path COST — they never proved the engine accepts the resulting move, which is exactly
// where "the range shows further but I cannot step there" would live.
describe("action engine — walking the vine", () => {
    const layVineRoad = (fromX: number, y: number, length: number) => {
        const vines = FightStateManager.getInstance().getFightProperties().getVines();
        const road = [];
        for (let i = 1; i <= length; i++) {
            const cell = { x: fromX + i, y };
            vines.add(cell);
            road.push(cell);
        }
        return road;
    };

    it("accepts a move onto a far vine cell that only the stride discount makes reachable", () => {
        const opts: Parameters<typeof setupActionFight>[0] & {
            currentActiveKnownPaths?: Map<number, IWeightedRoute[]>;
        } = {
            leftAbilities: ["In Its Own World"],
            // Keep the friendly support off the vine road running east from (3,3).
            supportCell: { x: 3, y: 6 },
            rightCell: { x: 12, y: 12 },
        };
        const setup = setupActionFight(opts);
        const road = layVineRoad(3, 3, 6);

        const steps = setup.left.getSteps();
        const movePath = new PathHelper(setup.grid.getSettings()).getMovePath(
            { x: 3, y: 3 },
            setup.grid.getMatrix(),
            steps,
            undefined,
            setup.left.canFly(),
            setup.left.isSmallSize(),
            setup.left.canTraverseLava(),
            setup.left.hasAbilityActive("In Its Own World"),
        );

        // The last vine cell is far beyond a plain walker's reach at these steps — that is the whole point.
        const destination = road[road.length - 1];
        const key = (destination.x << 4) | destination.y;
        expect(movePath.hashes.has(key)).toBe(true);
        const route = movePath.knownPaths.get(key)?.[0];
        expect(route).toBeDefined();
        expect(route!.weight).toBeLessThanOrEqual(steps);

        // Wire the computed reachability into the engine exactly like the scene does, then walk it.
        opts.currentActiveKnownPaths = movePath.knownPaths;
        const result = setup.engine.apply({
            type: "move_unit",
            unitId: setup.left.getId(),
            path: route!.route as { x: number; y: number }[],
        });

        expect(result.rejectionReason).toBeUndefined();
        expect(result.completed).toBe(true);
        expect(setup.left.getBaseCell()).toEqual(destination);
    });

    it("still refuses a vine cell beyond the discounted budget", () => {
        const opts: Parameters<typeof setupActionFight>[0] & {
            currentActiveKnownPaths?: Map<number, IWeightedRoute[]>;
        } = {
            leftAbilities: ["In Its Own World"],
            supportCell: { x: 3, y: 6 },
            rightCell: { x: 12, y: 12 },
        };
        const setup = setupActionFight(opts);
        layVineRoad(3, 3, 12);

        const movePath = new PathHelper(setup.grid.getSettings()).getMovePath(
            { x: 3, y: 3 },
            setup.grid.getMatrix(),
            setup.left.getSteps(),
            undefined,
            false,
            true,
            false,
            true,
        );
        // Even at half price the budget runs out eventually; that cell must not be reachable.
        const tooFar = { x: 3 + 12, y: 3 };
        expect(movePath.hashes.has((tooFar.x << 4) | tooFar.y)).toBe(false);
    });
});

// Standing in the enemy's vine is the same snare the throw applies. Crossing one is priced by the
// pathfinder; ENDING UP in one is priced here. A flyer clears a vine it flies over but is gripped by one
// it lands in, and a vine never snares the side that threw it.
describe("action engine — standing in a vine", () => {
    const layEnemyVine = (cell: { x: number; y: number }, team: number) => {
        FightStateManager.getInstance().getFightProperties().getVines().add(cell, 2, team);
    };

    const walkOnto = (setup: ReturnType<typeof setupActionFight>, opts: { currentActiveKnownPaths?: unknown }) => {
        const path = [
            { x: 3, y: 3 },
            { x: 3, y: 4 },
        ];
        const target = path[path.length - 1];
        (opts as { currentActiveKnownPaths?: Map<number, IWeightedRoute[]> }).currentActiveKnownPaths = new Map([
            [cellKey(target), [weightedRoute(path)]],
        ]);
        return setup.engine.apply({ type: "move_unit", unitId: setup.left.getId(), path });
    };

    it("snares a walker that ends its move in an enemy vine", () => {
        const opts: Record<string, unknown> = { supportCell: { x: 6, y: 6 }, rightCell: { x: 12, y: 12 } };
        const setup = setupActionFight(opts);
        layEnemyVine({ x: 3, y: 4 }, PBTypes.TeamVals.RIGHT);
        const stepsBefore = setup.left.getSteps();

        expect(walkOnto(setup, opts).completed).toBe(true);
        expect(setup.left.hasDebuffActive("Vine Throw")).toBe(true);
        // Steps are recomputed on the turn/lap boundary, the same cadence as Quagmire — force the recalc
        // here so the test pins the EFFECT rather than just the flag.
        setup.left.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);
        expect(setup.left.getSteps()).toBeLessThan(stepsBefore);
    });

    it("snares a FLYER that lands in one — flying clears a vine, it does not clear standing in it", () => {
        const opts: Record<string, unknown> = {
            supportCell: { x: 6, y: 6 },
            rightCell: { x: 12, y: 12 },
            leftMovementType: PBTypes.MovementVals.FLY,
        };
        const setup = setupActionFight(opts);
        layEnemyVine({ x: 3, y: 4 }, PBTypes.TeamVals.RIGHT);

        expect(walkOnto(setup, opts).completed).toBe(true);
        expect(setup.left.hasDebuffActive("Vine Throw")).toBe(true);
    });

    it("leaves a unit standing in its OWN side's vine alone", () => {
        const opts: Record<string, unknown> = { supportCell: { x: 6, y: 6 }, rightCell: { x: 12, y: 12 } };
        const setup = setupActionFight(opts);
        layEnemyVine({ x: 3, y: 4 }, PBTypes.TeamVals.LEFT); // same team as the mover
        const stepsBefore = setup.left.getSteps();

        expect(walkOnto(setup, opts).completed).toBe(true);
        expect(setup.left.hasDebuffActive("Vine Throw")).toBe(false);
        setup.left.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);
        expect(setup.left.getSteps()).toBe(stepsBefore);
    });
});
