/*
 * -----------------------------------------------------------------------------
 * Owner 2026-08-08: Trent's Vine Throw is thrown in an ARC — it reaches anyone unless a CREATURE stands
 * in the lane. Terrain that used to refuse the cast (the centre mountain, a narrowed hole) no longer
 * does; the vine simply fails to take root on ground it cannot grip. This file drives the real engine
 * cast so the relaxed rule cannot be undone by a second gate further down, and pins what the throw
 * paints on its way.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import { GameActionEngine } from "../../src/engine/action_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { Grid } from "../../src/grid/grid";
import { getPositionForCell } from "../../src/grid/grid_math";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import type { Unit } from "../../src/units/unit";
import type { UnitsHolder } from "../../src/units/units_holder";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, testGridSettings } from "../helpers/combat";

const place = (grid: Grid, unitsHolder: UnitsHolder, unit: Unit, cell: XY): void => {
    const position = getPositionForCell(
        cell,
        testGridSettings.getMinX(),
        testGridSettings.getStep(),
        testGridSettings.getHalfStep(),
    );
    unit.setPosition(position.x, position.y);
    grid.occupyCells(unit.getCells(), unit.getId(), unit.getTeam(), unit.getAttackRange(), false, false);
    unitsHolder.addUnit(unit);
};

/** Trent at (2,8) throwing at an enemy at (8,8), with whatever else the caller wants in between. */
const setupThrow = (options: { screenAt?: XY; terrainAt?: { cell: XY; marker: string } } = {}) => {
    const context = createCombatTestContext();
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(PBTypes.GridVals.NORMAL);
    fightProperties.startFight();

    const trent = createTestUnit({
        name: "Trent",
        team: PBTypes.TeamVals.LOWER,
        spells: ["System:Vine Throw"],
        stackPower: 5,
        initiative: 5,
        morale: 4,
    });
    const target = createTestUnit({
        name: "Target",
        team: PBTypes.TeamVals.UPPER,
        maxHp: 1000,
        amountAlive: 1,
        magicResist: 0,
        initiative: 3,
        morale: 4,
    });
    place(context.grid, context.unitsHolder, trent, { x: 2, y: 8 });
    place(context.grid, context.unitsHolder, target, { x: 8, y: 8 });
    if (options.screenAt) {
        const screen = createTestUnit({ name: "Screen", team: PBTypes.TeamVals.UPPER, maxHp: 100, amountAlive: 1 });
        place(context.grid, context.unitsHolder, screen, options.screenAt);
    }
    if (options.terrainAt) {
        // Terrain markers sit on the board exactly where a body would, which is what used to refuse the
        // throw. occupyByHole writes "H"; the mountain marker "B" is written the same way the grid does.
        if (options.terrainAt.marker === "H") {
            context.grid.occupyByHole(options.terrainAt.cell);
        } else {
            (context.grid as unknown as { boardCoord: string[][] }).boardCoord[options.terrainAt.cell.x][
                options.terrainAt.cell.y
            ] = options.terrainAt.marker;
        }
    }
    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LOWER, 1);
    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.UPPER, 1);
    fightProperties.startTurn(PBTypes.TeamVals.LOWER, 1000);

    const engine = new GameActionEngine({
        fightProperties,
        grid: context.grid,
        unitsHolder: context.unitsHolder,
        moveHandler: new MoveHandler(context.grid.getSettings(), context.grid, context.unitsHolder),
        sceneLog: new SceneLogMock(),
        attackHandler: context.attackHandler,
        getCurrentActiveUnitId: () => trent.getId(),
    });
    return { engine, trent, target, fightProperties };
};

const throwAt = (setup: ReturnType<typeof setupThrow>) =>
    setup.engine.apply({
        type: "cast_spell",
        casterId: setup.trent.getId(),
        spellName: "Vine Throw",
        targetId: setup.target.getId(),
        targetCell: setup.target.getBaseCell(),
    });

describe("Vine Throw reaches anyone a creature is not screening", () => {
    it("lands across an open lane", () => {
        const setup = setupThrow();
        const result = throwAt(setup);
        expect(result.completed).toBe(true);
        expect(result.events.some((event) => event.type === "vine_placed")).toBe(true);
    });

    it("is refused when a creature screens the target", () => {
        const setup = setupThrow({ screenAt: { x: 5, y: 8 } });
        const result = throwAt(setup);
        expect(result.completed).toBe(false);
        expect(result.rejectionReason).toBe("spell_not_available");
    });

    it("arcs over the mountain that used to refuse it, and skips rooting there", () => {
        const setup = setupThrow({ terrainAt: { cell: { x: 5, y: 8 }, marker: "B" } });
        const result = throwAt(setup);
        expect(result.completed).toBe(true);

        const placed = result.events.find((event) => event.type === "vine_placed");
        expect(placed).toBeDefined();
        const cells = placed?.type === "vine_placed" ? placed.cells : [];
        expect(cells.length).toBeGreaterThan(0);
        // The vine cannot grip the rock, but everything else in the lane — including the target's own
        // cell — takes one.
        expect(cells.some((cell) => cell.x === 5 && cell.y === 8)).toBe(false);
        expect(cells.some((cell) => cell.x === 8 && cell.y === 8)).toBe(true);
    });

    it("arcs over a narrowed hole too", () => {
        const setup = setupThrow({ terrainAt: { cell: { x: 4, y: 8 }, marker: "H" } });
        const result = throwAt(setup);
        expect(result.completed).toBe(true);
        const placed = result.events.find((event) => event.type === "vine_placed");
        const cells = placed?.type === "vine_placed" ? placed.cells : [];
        expect(cells.some((cell) => cell.x === 4 && cell.y === 8)).toBe(false);
    });
});
