/*
 * -----------------------------------------------------------------------------
 * Thrown spells (Fire Strike, Ring of Fire, Vine Throw) against — and from — 2x2 creatures.
 *
 * Regression guard: a large creature stands on FOUR cells but is addressed by ONE base cell, and the
 * line-of-sight walk ran to that base cell rejecting every occupied cell on the way. Because the base
 * cell is the bottom-left of the square, the walk crossed the creature's OWN other cells whenever the
 * shot came from the right or from above — so a 2x2 target was unhittable from half the board, and a
 * 2x2 caster could not shoot into that half at all. Which half depended on where you stood, which is
 * why it read as "Fire Strike sometimes just doesn't work on big units".
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { isCellWithinGrid, getPositionForCell } from "../../src/grid/grid_math";
import type { Grid } from "../../src/grid/grid";
import { isSpellLineOfSightClear } from "../../src/spells/spell_helper";
import type { Unit } from "../../src/units/unit";
import type { UnitsHolder } from "../../src/units/units_holder";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, testGridSettings } from "../helpers/combat";

/**
 * Place a unit the way the real board does — occupyCells over its whole footprint.
 *
 * NOT the shared placeUnit helper: that one stamps a single cell via occupyCell, so a 2x2 leaves three
 * of its four cells reading as empty ground and this whole file would pass without the fix.
 */
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

const makeLarge = (name: string, team: number) =>
    createTestUnit({ name, team: team as never, size: PBTypes.UnitSizeVals.LARGE });

const sightBetween = (grid: Grid, from: XY, to: XY): boolean =>
    isSpellLineOfSightClear(grid, (cell) => isCellWithinGrid(grid.getSettings(), cell), from, to);

describe("thrown spell line of sight around 2x2 creatures", () => {
    it("reaches a 2x2 target from every side, not just the two its base cell faces", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const target = makeLarge("Big Target", PBTypes.TeamVals.UPPER);
        place(grid, unitsHolder, target, { x: 8, y: 8 });

        // The base cell is the bottom-left of the square, so approaches from the right or from above are
        // exactly the ones that used to be swallowed by the target's own body.
        const base = target.getBaseCell();
        expect(target.getCells()).toHaveLength(4);
        for (const from of [
            { x: 8, y: 2 }, // below   — worked before
            { x: 2, y: 8 }, // left    — worked before
            { x: 2, y: 2 }, // below-left diagonal — worked before
            { x: 12, y: 8 }, // right  — crosses (9,8), the target's own cell
            { x: 8, y: 12 }, // above  — crosses (8,9)
            { x: 12, y: 12 }, // above-right diagonal — crosses (9,9)
            { x: 9, y: 12 }, // straight down the target's OTHER column
            { x: 12, y: 9 }, // straight along the target's OTHER row
        ]) {
            expect(sightBetween(grid, from, base), `blocked from (${from.x},${from.y})`).toBe(true);
        }
    });

    it("lets a 2x2 caster shoot in every direction instead of being walled in by itself", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const caster = makeLarge("Big Mage", PBTypes.TeamVals.LOWER);
        place(grid, unitsHolder, caster, { x: 8, y: 8 });

        const base = caster.getBaseCell();
        for (const to of [
            { x: 8, y: 2 },
            { x: 2, y: 8 },
            { x: 2, y: 2 },
            { x: 12, y: 8 }, // the caster's own (9,8) is in the way
            { x: 8, y: 12 }, // its own (8,9)
            { x: 12, y: 12 }, // its own (9,9)
        ]) {
            expect(sightBetween(grid, base, to), `walled in aiming at (${to.x},${to.y})`).toBe(true);
        }
    });

    it("still refuses the shot when a THIRD creature stands in the way", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const caster = createTestUnit({ name: "Mage", team: PBTypes.TeamVals.LOWER });
        const blocker = createTestUnit({ name: "Blocker", team: PBTypes.TeamVals.UPPER });
        const target = makeLarge("Big Target", PBTypes.TeamVals.UPPER);
        place(grid, unitsHolder, caster, { x: 2, y: 8 });
        place(grid, unitsHolder, blocker, { x: 5, y: 8 });
        place(grid, unitsHolder, target, { x: 8, y: 8 });

        // The endpoints' own bodies are excused; anyone else's is not. Without this the fix would read
        // as "large units are never blocked", which is a different bug in the other direction.
        expect(sightBetween(grid, caster.getBaseCell(), target.getBaseCell())).toBe(false);
    });

    it("is unchanged for two small creatures with a clear lane", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const caster = createTestUnit({ name: "Mage", team: PBTypes.TeamVals.LOWER });
        const target = createTestUnit({ name: "Victim", team: PBTypes.TeamVals.UPPER });
        place(grid, unitsHolder, caster, { x: 2, y: 8 });
        place(grid, unitsHolder, target, { x: 8, y: 8 });

        expect(sightBetween(grid, caster.getBaseCell(), target.getBaseCell())).toBe(true);
    });
});
