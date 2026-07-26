import { describe, expect, it } from "bun:test";

import {
    CHAKRAM_ARC_DIAMETER,
    chakramBounceBudget,
    chakramBounceCells,
    chakramBounceDamagePercent,
    resolveChakramBounces,
} from "../../src/abilities/chakram_ability";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

/** Deterministic side rolls so a test can pin which flank the chakram takes. */
const alwaysSide = (value: number) => () => value;

describe("Zena's Chakram", () => {
    it("carves a half circle that bulges the way the chakram was travelling", () => {
        const { grid } = createCombatTestContext();
        const impact = { x: 6, y: 6 };
        const up = { x: 0, y: 1 };

        const cells = chakramBounceCells(impact, up, 1, grid.getSettings());

        // A half circle of this diameter, not a straight line and not a full ring.
        expect(cells.length).toBeGreaterThan(CHAKRAM_ARC_DIAMETER);
        // It goes FORWARD (up the board) — the whole point of "bounces in the direction of the throw".
        expect(cells.some((cell) => cell.y > impact.y)).toBe(true);
        expect(cells.every((cell) => cell.y >= impact.y)).toBe(true);
        // …and it reaches roughly a full diameter out to the chosen flank.
        const spread = Math.max(...cells.map((cell) => Math.abs(cell.x - impact.x)));
        expect(spread).toBeGreaterThanOrEqual(CHAKRAM_ARC_DIAMETER - 2);

        // The other flank mirrors it.
        const other = chakramBounceCells(impact, up, -1, grid.getSettings());
        expect(other.some((cell) => cell.x > impact.x)).toBe(true);
        expect(cells.some((cell) => cell.x < impact.x)).toBe(true);
    });

    it("bounces from enemy to enemy and never touches an ally standing on the arc", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const zena = createTestUnit({
            name: "Zena",
            team: PBTypes.TeamVals.LOWER,
            stackPower: 5,
            abilities: ["Chakram"],
        });
        const primary = createTestUnit({ name: "Primary", team: PBTypes.TeamVals.UPPER });
        const secondEnemy = createTestUnit({ name: "Second", team: PBTypes.TeamVals.UPPER });
        const friend = createTestUnit({ name: "Friend", team: PBTypes.TeamVals.LOWER });

        placeUnit(grid, unitsHolder, zena, { x: 6, y: 2 });
        placeUnit(grid, unitsHolder, primary, { x: 6, y: 6 });
        // Both sit on the flank-(+1) arc out of the primary; only the enemy may be struck.
        placeUnit(grid, unitsHolder, friend, { x: 5, y: 8 });
        placeUnit(grid, unitsHolder, secondEnemy, { x: 4, y: 8 });

        const bounces = resolveChakramBounces(zena, primary, unitsHolder, grid, alwaysSide(0.1));
        const names = bounces.map((bounce) => bounce.unit.getName());

        expect(names).toContain("Second");
        expect(names).not.toContain("Friend");
        expect(names).not.toContain("Primary"); // the primary hit is not itself a bounce
    });

    it("stops dead at an Angel — it neither strikes it nor carries past it", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const zena = createTestUnit({
            name: "Zena",
            team: PBTypes.TeamVals.LOWER,
            stackPower: 5,
            abilities: ["Chakram"],
        });
        const primary = createTestUnit({ name: "Primary", team: PBTypes.TeamVals.UPPER });
        const angel = createTestUnit({
            name: "Angel",
            team: PBTypes.TeamVals.UPPER,
            abilities: ["Arrows Wingshield Aura"],
        });

        placeUnit(grid, unitsHolder, zena, { x: 6, y: 2 });
        placeUnit(grid, unitsHolder, primary, { x: 6, y: 6 });
        placeUnit(grid, unitsHolder, angel, { x: 5, y: 8 });

        const bounces = resolveChakramBounces(zena, primary, unitsHolder, grid, alwaysSide(0.1));

        expect(bounces.map((bounce) => bounce.unit.getName())).not.toContain("Angel");
    });

    it("scales the number of ricochets with the stack, and the damage with luck", () => {
        const full = createTestUnit({ name: "Zena", stackPower: 5 });
        const battered = createTestUnit({ name: "Zena", stackPower: 1 });
        expect(chakramBounceBudget(full)).toBeGreaterThan(chakramBounceBudget(battered));
        expect(chakramBounceBudget(battered)).toBeGreaterThanOrEqual(1);

        // ~100% on a bounce, swinging 90-110 with luck — never outside that band.
        expect(chakramBounceDamagePercent(createTestUnit({ name: "Zena", luck: 0 }))).toBe(100);
        expect(chakramBounceDamagePercent(createTestUnit({ name: "Zena", luck: 10 }))).toBe(110);
        expect(chakramBounceDamagePercent(createTestUnit({ name: "Zena", luck: -10 }))).toBe(90);
        expect(chakramBounceDamagePercent(createTestUnit({ name: "Zena", luck: 100 }))).toBe(110);
    });
});
