import { describe, expect, it } from "bun:test";

import {
    CHAKRAM_ARC_DIAMETER,
    chakramBounceDamagePercent,
    chakramCircleCells,
    resolveChakramTrajectory,
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

    it("damages EVERY enemy the disc's circle passes through, and never an ally", () => {
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

        // Two enemies and an ally, each on a distinct cell the FIRST circle actually crosses — the mechanic
        // must clip BOTH enemies (not just the first one it reaches) and leave the ally untouched.
        const ring = firstCircleCells(grid, primaryCell);
        const enemyCellA = ring[Math.floor(ring.length * 0.25)];
        const enemyCellB = ring[Math.floor(ring.length * 0.5)];
        const allyCell = ring[Math.floor(ring.length * 0.75)];

        const enemyA = createTestUnit({ name: "EnemyA", team: PBTypes.TeamVals.UPPER });
        const enemyB = createTestUnit({ name: "EnemyB", team: PBTypes.TeamVals.UPPER });
        const friend = createTestUnit({ name: "Friend", team: PBTypes.TeamVals.LOWER });
        placeUnit(grid, unitsHolder, enemyA, enemyCellA);
        placeUnit(grid, unitsHolder, enemyB, enemyCellB);
        placeUnit(grid, unitsHolder, friend, allyCell);

        const trajectory = resolveChakramTrajectory(zena, primary, unitsHolder, grid, alwaysSide(0.1));
        const names = trajectory.hitUnits.map((u) => u.getName());

        expect(names).toContain("EnemyA");
        expect(names).toContain("EnemyB");
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
        placeUnit(grid, unitsHolder, angel, firstCircleCells(grid, primaryCell)[0]);

        const trajectory = resolveChakramTrajectory(zena, primary, unitsHolder, grid, alwaysSide(0.1));
        expect(trajectory.hitUnits.map((u) => u.getName())).not.toContain("Angel");
    });

    it("deals ~100% damage on a hit, swinging 90-110 with luck", () => {
        // ~100% on a hit, swinging 90-110 with luck — never outside that band.
        expect(chakramBounceDamagePercent(createTestUnit({ name: "Zena", luck: 0 }))).toBe(100);
        expect(chakramBounceDamagePercent(createTestUnit({ name: "Zena", luck: 10 }))).toBe(110);
        expect(chakramBounceDamagePercent(createTestUnit({ name: "Zena", luck: -10 }))).toBe(90);
        expect(chakramBounceDamagePercent(createTestUnit({ name: "Zena", luck: 100 }))).toBe(110);
    });
});
