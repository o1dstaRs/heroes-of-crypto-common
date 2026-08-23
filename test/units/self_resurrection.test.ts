/*
 * -----------------------------------------------------------------------------
 * A dying stack that still holds its Resurrection charge raises itself.
 *
 * Regression guard: the raise was floor(died / 2), which is 0 for a stack of ONE —
 * so a lone Angel (exactly what you get after splitting a pair) fell through to
 * deletion and never came back. At least one always returns now.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

/** An Angel-shaped stack of `amount`, wiped out and awaiting cleanup. */
const fallenAngel = (amount: number, options: { spentSpell?: boolean; withAbility?: boolean } = {}) => {
    const { grid, unitsHolder } = createCombatTestContext();
    const angel = createTestUnit({
        name: "Angel",
        team: PBTypes.TeamVals.LOWER,
        amountAlive: amount,
        abilities: options.withAbility === false ? [] : ["Resurrection"],
        spells: ["System:Resurrection"],
    });
    placeUnit(grid, unitsHolder, angel, { x: 2, y: 2 });
    if (options.spentSpell) {
        angel.useSpell("Resurrection");
    }

    const properties = angel.getUnitProperties();
    properties.amount_alive = 0;
    properties.amount_died = amount;
    properties.hp = 0;

    return { angel, unitsHolder, properties };
};

describe("self-resurrection on death", () => {
    it("brings a LONE stack back — the split-Angel case", () => {
        const { angel, unitsHolder, properties } = fallenAngel(1);
        const aggravated = createTestUnit({ team: PBTypes.TeamVals.UPPER });
        unitsHolder.addUnit(aggravated);
        aggravated.setTarget(angel.getId());

        // false = the unit was not deleted, i.e. it resurrected instead.
        expect(unitsHolder.deleteUnitById(angel.getId(), true)).toBe(false);
        expect(properties.amount_alive).toBe(1);
        expect(properties.amount_died).toBe(0);
        expect(aggravated.getTarget()).toBe(angel.getId());
    });

    it("still brings back half of a larger stack", () => {
        for (const [amount, expected] of [
            [2, 1],
            [5, 2],
            [8, 4],
        ] as const) {
            const { angel, unitsHolder, properties } = fallenAngel(amount);
            expect(unitsHolder.deleteUnitById(angel.getId(), true)).toBe(false);
            expect(properties.amount_alive).toBe(expected);
            expect(properties.amount_died).toBe(amount - expected);
        }
    });

    it("spends the charge, so it cannot raise itself twice", () => {
        const { angel, unitsHolder } = fallenAngel(1);
        unitsHolder.deleteUnitById(angel.getId(), true);

        // The ability is consumed by the raise; a second death is final.
        expect(angel.hasAbilityActive("Resurrection")).toBe(false);
        const properties = angel.getUnitProperties();
        properties.amount_alive = 0;
        properties.amount_died = 1;
        expect(unitsHolder.deleteUnitById(angel.getId(), true)).toBe(true);
    });

    it("does not raise a stack that already spent the spell", () => {
        const { angel, unitsHolder } = fallenAngel(1, { spentSpell: true });

        expect(unitsHolder.deleteUnitById(angel.getId(), true)).toBe(true);
    });

    it("does not raise a stack without the ability at all", () => {
        const { angel, unitsHolder } = fallenAngel(1, { withAbility: false });

        expect(unitsHolder.deleteUnitById(angel.getId(), true)).toBe(true);
    });
});
