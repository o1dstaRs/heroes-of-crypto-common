import { describe, expect, it } from "bun:test";

import {
    CHAKRAM_ARC_DIAMETER,
    chakramBounceDamagePercent,
    chakramCircleCells,
    resolveChakramTrajectory,
    SEARCH_SWEEP,
} from "../../src/abilities/chakram_ability";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

/** Deterministic side rolls so a test can pin which flank the chakram takes. */
const alwaysSide = (value: number) => () => value;

/** The full-circle cells the disc's FIRST leg sweeps for a straight-up shot on the chosen flank, minus the
 *  primary's own cell — the cells a test can place victims on to track the real geometry. */
function firstCircleCells(
    grid: ReturnType<typeof createCombatTestContext>["grid"],
    primaryCell: { x: number; y: number },
) {
    return chakramCircleCells(primaryCell, { x: 0, y: 1 }, 1, grid.getSettings()).filter(
        (cell) => !(cell.x === primaryCell.x && cell.y === primaryCell.y),
    );
}

/** The 180° search-arc cells the disc's FIRST ricochet leg rides for a straight-up shot on flank +1, minus the
 *  primary's own cell — where a test places the enemy the disc should curve into. */
function firstSearchArc(
    grid: ReturnType<typeof createCombatTestContext>["grid"],
    primaryCell: { x: number; y: number },
) {
    return chakramCircleCells(primaryCell, { x: 0, y: 1 }, 1, grid.getSettings(), SEARCH_SWEEP).filter(
        (cell) => !(cell.x === primaryCell.x && cell.y === primaryCell.y),
    );
}

describe("Zena's Chakram", () => {
    it("carves a FULL circle on the chosen flank, closing back on itself", () => {
        const { grid } = createCombatTestContext();
        const origin = { x: 8, y: 8 };
        const up = { x: 0, y: 1 };

        const cells = chakramCircleCells(origin, up, 1, grid.getSettings());

        // A full ring of this diameter — not a straight line, and (unlike the old half arc) it loops all the
        // way around so it reaches cells on BOTH sides of the origin along the travel axis.
        expect(cells.length).toBeGreaterThan(CHAKRAM_ARC_DIAMETER);
        expect(cells.some((cell) => cell.y > origin.y)).toBe(true);
        expect(cells.some((cell) => cell.y < origin.y)).toBe(true);
        // …and bulges roughly a full diameter out to the chosen flank.
        const spread = Math.max(...cells.map((cell) => Math.abs(cell.x - origin.x)));
        expect(spread).toBeGreaterThanOrEqual(CHAKRAM_ARC_DIAMETER - 2);
    });

    it("ricochets into the first enemy its arc meets, and never an ally", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const zena = createTestUnit({
            name: "Zena",
            team: PBTypes.TeamVals.LOWER,
            stackPower: 5,
            abilities: ["Chakram"],
        });
        const primaryCell = { x: 8, y: 8 };
        const primary = createTestUnit({ name: "Primary", team: PBTypes.TeamVals.UPPER });
        placeUnit(grid, unitsHolder, zena, { x: 8, y: 3 });
        placeUnit(grid, unitsHolder, primary, primaryCell);

        // An enemy sits on the disc's 180° search arc (within its 1-cell reach); an ally sits on the FAR side of
        // the full circle, off that arc. The disc must strike the enemy, never the ally (allies are excluded
        // outright), and never the primary again (the shot already hit it).
        const arc = firstSearchArc(grid, primaryCell);
        const fullRing = firstCircleCells(grid, primaryCell);
        const enemy = createTestUnit({ name: "Enemy", team: PBTypes.TeamVals.UPPER });
        const friend = createTestUnit({ name: "Friend", team: PBTypes.TeamVals.LOWER });
        placeUnit(grid, unitsHolder, enemy, arc[Math.floor(arc.length * 0.5)]);
        placeUnit(grid, unitsHolder, friend, fullRing[Math.floor(fullRing.length * 0.75)]);

        const trajectory = resolveChakramTrajectory(zena, primary, unitsHolder, grid, alwaysSide(0.1));
        const names = trajectory.hitUnits.map((u) => u.getName());

        expect(names).toContain("Enemy");
        expect(names).not.toContain("Friend");
        expect(names).not.toContain("Primary"); // the primary hit is the shot itself, not a bounce
    });

    it("stops dead at an Angel — never strikes it", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const zena = createTestUnit({
            name: "Zena",
            team: PBTypes.TeamVals.LOWER,
            stackPower: 5,
            abilities: ["Chakram"],
        });
        const primaryCell = { x: 8, y: 8 };
        const primary = createTestUnit({ name: "Primary", team: PBTypes.TeamVals.UPPER });
        placeUnit(grid, unitsHolder, zena, { x: 8, y: 3 });
        placeUnit(grid, unitsHolder, primary, primaryCell);

        // Angel sits on the first cell the disc reaches — it must halt the chain and take no damage.
        const angel = createTestUnit({
            name: "Angel",
            team: PBTypes.TeamVals.UPPER,
            abilities: ["Arrows Wingshield Aura"],
        });
        placeUnit(grid, unitsHolder, angel, firstSearchArc(grid, primaryCell)[0]);

        const trajectory = resolveChakramTrajectory(zena, primary, unitsHolder, grid, alwaysSide(0.1));
        expect(trajectory.hitUnits.map((u) => u.getName())).not.toContain("Angel");
    });

    it("always loops once around the target, then ricochets truncate at each hit with a final flourish", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const zena = createTestUnit({
            name: "Zena",
            team: PBTypes.TeamVals.LOWER,
            stackPower: 5,
            abilities: ["Chakram"],
        });
        const primaryCell = { x: 8, y: 8 };
        const primary = createTestUnit({ name: "Primary", team: PBTypes.TeamVals.UPPER });
        placeUnit(grid, unitsHolder, zena, { x: 8, y: 3 });
        placeUnit(grid, unitsHolder, primary, primaryCell);

        // Lone target: leg 0's 180° search finds nobody, so the disc flies its ONE mandatory full-circle
        // flourish around the primary and heads home — never an instant bounce-back. The flourish hits nobody
        // (only the primary was there, and the shot already hit it).
        const lone = resolveChakramTrajectory(zena, primary, unitsHolder, grid, alwaysSide(0.1));
        expect(lone.steps).toHaveLength(1);
        expect(lone.steps[0].fromCell).toEqual(primaryCell);
        expect(lone.steps[0].hitUnitIds).toHaveLength(0);
        expect(lone.hitUnits).toHaveLength(0);
        const flourishLen = lone.steps[0].circleCells.length;

        // With an enemy on the search arc, leg 0 becomes a CONNECTING ricochet: it is TRUNCATED at the one
        // victim (a shorter arc than the full flourish loop), and the LAST recorded step is the empty flourish.
        const arc = firstSearchArc(grid, primaryCell);
        const enemy = createTestUnit({ name: "Enemy", team: PBTypes.TeamVals.UPPER });
        placeUnit(grid, unitsHolder, enemy, arc[Math.floor(arc.length * 0.5)]);
        const connecting = resolveChakramTrajectory(zena, primary, unitsHolder, grid, alwaysSide(0.1));

        expect(connecting.hitUnits.map((u) => u.getName())).toContain("Enemy");
        expect(connecting.steps[0].hitUnitIds).toEqual([enemy.getId()]);
        expect(connecting.steps[0].circleCells.length).toBeLessThan(flourishLen);
        const last = connecting.steps[connecting.steps.length - 1];
        expect(last.hitUnitIds.length + last.mountainCells.length).toBe(0); // the terminal flourish hits nothing
        for (let i = 0; i < connecting.steps.length - 1; i += 1) {
            expect(connecting.steps[i].hitUnitIds.length + connecting.steps[i].mountainCells.length).toBeGreaterThan(0); // every leg before the flourish actually connected
        }
    });

    it("deals ~100% damage on a hit, swinging 90-110 with luck", () => {
        // ~100% on a hit, swinging 90-110 with luck — never outside that band.
        expect(chakramBounceDamagePercent(createTestUnit({ name: "Zena", luck: 0 }))).toBe(100);
        expect(chakramBounceDamagePercent(createTestUnit({ name: "Zena", luck: 10 }))).toBe(110);
        expect(chakramBounceDamagePercent(createTestUnit({ name: "Zena", luck: -10 }))).toBe(90);
        expect(chakramBounceDamagePercent(createTestUnit({ name: "Zena", luck: 100 }))).toBe(110);
    });
});
