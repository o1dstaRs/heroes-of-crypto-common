import { describe, expect, test } from "bun:test";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getPositionForFootprintAnchor } from "../../src/grid/grid_math";
import { nextStandingTargets } from "../../src/abilities/ability_helper";
import { createCombatTestContext, createTestUnit, testGridSettings } from "../helpers/combat";
import type { Unit } from "../../src/units/unit";
import type { XY } from "../../src/utils/math";

const stand = (ctx: ReturnType<typeof createCombatTestContext>, unit: Unit, anchor: XY, w: number, h: number) => {
    const pos = getPositionForFootprintAnchor(testGridSettings, anchor, w, h);
    unit.setPosition(pos.x, pos.y);
    ctx.grid.occupyCells(unit.getCells(), unit.getId(), unit.getTeam(), unit.getAttackRange(), false, false);
    ctx.unitsHolder.addUnit(unit);
};

/**
 * The pierce wave behind a melee victim (Fire Breath, Skewer Strike) is pushed back by the target's own
 * DEPTH, one cell per cell of body beyond the first. That used to be read as a literal 2 on both axes —
 * correct only for a 2x2 — and a 1x2 is not "small", so on the axis where it is a single cell thick the wave
 * stepped a full cell too far: it skipped whoever stood in contact behind the body and burned a unit two
 * cells away across an EMPTY cell.
 */
describe("pierce wave depth follows the target's own extent", () => {
    test("a 1x2 target attacked across its NARROW axis does not skip the unit behind it", () => {
        const ctx = createCombatTestContext();
        const dragon = createTestUnit({
            name: "Dragon",
            team: PBTypes.TeamVals.LOWER,
            size: PBTypes.UnitSizeVals.LARGE,
        });
        const target = createTestUnit({ name: "Tall", team: PBTypes.TeamVals.UPPER });
        (target.getUnitProperties() as { footprint_width: number }).footprint_width = 1;
        (target.getUnitProperties() as { footprint_height: number }).footprint_height = 2;
        const behind = createTestUnit({ name: "Behind", team: PBTypes.TeamVals.UPPER });
        const further = createTestUnit({ name: "Further", team: PBTypes.TeamVals.UPPER });
        stand(ctx, dragon, { x: 7, y: 5 }, 2, 2);
        stand(ctx, target, { x: 5, y: 5 }, 1, 2);
        stand(ctx, behind, { x: 4, y: 5 }, 1, 1);
        stand(ctx, further, { x: 3, y: 5 }, 1, 1);

        const names = nextStandingTargets(dragon, target, ctx.grid, ctx.unitsHolder, undefined, true).map((u) =>
            u.getName(),
        );
        expect(names).toContain("Behind");
        expect(names).not.toContain("Further");
    });

    test("a 2x2 target keeps its shipped depth-2 band", () => {
        const ctx = createCombatTestContext();
        const dragon = createTestUnit({
            name: "Dragon",
            team: PBTypes.TeamVals.LOWER,
            size: PBTypes.UnitSizeVals.LARGE,
        });
        const target = createTestUnit({ name: "Big", team: PBTypes.TeamVals.UPPER, size: PBTypes.UnitSizeVals.LARGE });
        const behind = createTestUnit({ name: "Behind", team: PBTypes.TeamVals.UPPER });
        stand(ctx, dragon, { x: 7, y: 5 }, 2, 2);
        stand(ctx, target, { x: 5, y: 5 }, 2, 2);
        stand(ctx, behind, { x: 3, y: 5 }, 1, 1);
        const names = nextStandingTargets(dragon, target, ctx.grid, ctx.unitsHolder, undefined, true).map((u) =>
            u.getName(),
        );
        expect(names).toContain("Behind");
    });
});
