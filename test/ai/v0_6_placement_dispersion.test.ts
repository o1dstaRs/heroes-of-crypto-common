/*
 * -----------------------------------------------------------------------------
 * v0.6 enemy-AOE-aware placement: against an adjacent-SPLASH shooter (Area Throw / Large Caliber) the
 * army deploys with a 1-cell gap between stacks so one blast can't catch several. Against non-splash AOE
 * (Fire Breath line) it keeps v0.5's packed formation (measured: dispersion hurts there).
 * -----------------------------------------------------------------------------
 */
import { describe, expect, it } from "bun:test";

import { getAIStrategy } from "../../src/ai";
import type { XY } from "../../src/utils/math";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PlacementPositionType } from "../../src/grid/placement_properties";
import { RectanglePlacement } from "../../src/grid/rectangle_placement";
import { createCombatTestContext, createTestUnit, testGridSettings } from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const MELEE = PBTypes.AttackVals.MELEE;
const RANGE = PBTypes.AttackVals.RANGE;
const v06 = getAIStrategy("v0.6");

/** True if any two placed base cells touch (8-neighbour adjacency). */
function anyAdjacent(cells: XY[]): boolean {
    for (let i = 0; i < cells.length; i += 1) {
        for (let j = i + 1; j < cells.length; j += 1) {
            const a = cells[i];
            const b = cells[j];
            if (Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) === 1) {
                return true;
            }
        }
    }
    return false;
}

function placeVsEnemy(enemyAbilities: string[]): XY[] {
    const c = createCombatTestContext();
    const enemy = createTestUnit({
        team: UPPER,
        name: "Threat",
        attackType: RANGE,
        abilities: enemyAbilities,
        amountAlive: 8,
    });
    c.unitsHolder.addUnit(enemy);
    const myUnits = [1, 2, 3].map((i) =>
        createTestUnit({ team: LOWER, name: `M${i}`, attackType: MELEE, amountAlive: 20 }),
    );
    const zone = new RectanglePlacement(testGridSettings, PlacementPositionType.LOWER_LEFT, 5);
    const placed = v06.placeArmy(myUnits, {
        team: LOWER,
        grid: c.grid,
        unitsHolder: c.unitsHolder,
        pathHelper: undefined as never,
        placement: zone,
    });
    expect(placed.size).toBe(myUnits.length);
    return [...placed.values()];
}

describe("v0.6 placement dispersion vs splash AOE", () => {
    it("disperses (no adjacent stacks) when the enemy fields Area Throw splash", () => {
        expect(anyAdjacent(placeVsEnemy(["Area Throw"]))).toBe(false);
    });

    it("keeps the packed formation (adjacent stacks) vs Fire Breath — a line, not splash", () => {
        expect(anyAdjacent(placeVsEnemy(["Fire Breath"]))).toBe(true);
    });
});
