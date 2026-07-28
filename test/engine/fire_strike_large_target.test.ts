/*
 * -----------------------------------------------------------------------------
 * The reported symptom, end to end through the real cast: "unable to hit large 2x2 units with Fire
 * Strike". The shared line-of-sight rule is pinned in test/spells/thrown_spell_large_units.test.ts;
 * this file proves the engine's cast_spell path actually lands, so a fix at the helper cannot be
 * undone by a second gate further down.
 *
 * The board is built here rather than through the shared setupActionFight/placeUnit helpers because
 * those stamp a single cell per unit (occupyCell), which leaves three quarters of a 2x2 reading as
 * empty ground — the bug is invisible on such a board.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import { GameActionEngine } from "../../src/engine/action_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getPositionForCell } from "../../src/grid/grid_math";
import type { Grid } from "../../src/grid/grid";
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

/** Caster on one side of a 2x2 target, with the whole board otherwise empty. */
const setupStrike = (casterCell: XY) => {
    const context = createCombatTestContext();
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(PBTypes.GridVals.NORMAL);
    fightProperties.startFight();

    const caster = createTestUnit({
        name: "Mage",
        team: PBTypes.TeamVals.LOWER,
        spells: ["Life:Fire Strike"],
        speed: 5,
        morale: 4,
    });
    const bigTarget = createTestUnit({
        name: "Colossus",
        team: PBTypes.TeamVals.UPPER,
        size: PBTypes.UnitSizeVals.LARGE,
        maxHp: 10_000,
        amountAlive: 1,
        speed: 3,
        morale: 4,
    });
    place(context.grid, context.unitsHolder, caster, casterCell);
    place(context.grid, context.unitsHolder, bigTarget, { x: 8, y: 8 });
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
        getCurrentActiveUnitId: () => caster.getId(),
    });
    return { engine, caster, bigTarget };
};

const castFireStrike = (casterCell: XY) => {
    const { engine, caster, bigTarget } = setupStrike(casterCell);
    const hpBefore = bigTarget.getCumulativeHp();
    const result = engine.apply({
        type: "cast_spell",
        casterId: caster.getId(),
        spellName: "Fire Strike",
        targetId: bigTarget.getId(),
        targetCell: bigTarget.getBaseCell(),
    });
    return { result, damage: hpBefore - bigTarget.getCumulativeHp() };
};

describe("Fire Strike on a 2x2 target", () => {
    // (8,8) is the target's base cell; it also stands on (9,8), (8,9) and (9,9). Casters to the right or
    // above have to cross one of those three to "reach" the base cell, and that is what used to refuse
    // the cast — from the left or below the very same cast always worked.
    const casterCells: readonly { side: string; cell: XY }[] = [
        { side: "left", cell: { x: 2, y: 8 } },
        { side: "below", cell: { x: 8, y: 2 } },
        { side: "right", cell: { x: 13, y: 8 } },
        { side: "above", cell: { x: 8, y: 13 } },
        { side: "above-right", cell: { x: 13, y: 13 } },
    ];

    for (const { side, cell } of casterCells) {
        it(`lands and deals damage from the ${side}`, () => {
            const { result, damage } = castFireStrike(cell);

            expect(result.completed).toBe(true);
            expect(damage).toBeGreaterThan(0);
        });
    }
});
