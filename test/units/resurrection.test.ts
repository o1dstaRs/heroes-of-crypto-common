/*
 * -----------------------------------------------------------------------------
 * Unit.applyResurrection: spend a hit-point budget on a stack's graveyard.
 *
 * The budget first tops the wounded front member up, then buys whole members back;
 * whatever is left over raises one more at partial health. Regression guard: a
 * budget that was an exact multiple of max_hp left a remainder of 0, which was
 * written straight onto the stack — raising the members but standing them up with
 * a 0 hp front member ("resurrection doesn't recover hp").
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { createTestUnit } from "../helpers/combat";

/** A stack with `alive` standing (front member on `hp`) and `died` in the graveyard. */
const stack = (maxHp: number, hp: number, alive: number, died: number) => {
    const unit = createTestUnit({ name: "Fallen", team: PBTypes.TeamVals.LOWER, maxHp, amountAlive: alive });
    const properties = unit.getUnitProperties();
    properties.hp = hp;
    properties.amount_alive = alive;
    properties.amount_died = died;
    return unit;
};

describe("applyResurrection", () => {
    it("stands the last raised member up at FULL health when the budget divides exactly", () => {
        const unit = stack(100, 100, 1, 5);

        expect(unit.applyResurrection(300)).toBe(3);
        // 300 buys exactly three whole members, so none of them is wounded.
        expect(unit.getUnitProperties().hp).toBe(100);
        expect(unit.getUnitProperties().amount_alive).toBe(4);
        expect(unit.getUnitProperties().amount_died).toBe(2);
    });

    it("leaves the last raised member wounded when the budget does not divide exactly", () => {
        const unit = stack(100, 100, 1, 5);

        // 250 = two whole members plus half of a third.
        expect(unit.applyResurrection(250)).toBe(3);
        expect(unit.getUnitProperties().hp).toBe(50);
        expect(unit.getUnitProperties().amount_alive).toBe(4);
    });

    it("tops the wounded front member up without raising anyone", () => {
        const unit = stack(100, 40, 1, 3);

        expect(unit.applyResurrection(30)).toBe(0);
        expect(unit.getUnitProperties().hp).toBe(70);
        expect(unit.getUnitProperties().amount_died).toBe(3);
    });

    it("cannot raise more than the graveyard holds, and wastes the surplus", () => {
        const unit = stack(100, 100, 1, 2);

        expect(unit.applyResurrection(1000)).toBe(2);
        expect(unit.getUnitProperties().hp).toBe(100);
        expect(unit.getUnitProperties().amount_alive).toBe(3);
        expect(unit.getUnitProperties().amount_died).toBe(0);
    });

    it("spends the budget on the wounded front member before buying anyone back", () => {
        const unit = stack(100, 60, 1, 4);

        // 40 heals the front member to full, the remaining 200 buys two whole members.
        expect(unit.applyResurrection(240)).toBe(2);
        expect(unit.getUnitProperties().hp).toBe(100);
        expect(unit.getUnitProperties().amount_alive).toBe(3);
        expect(unit.getUnitProperties().amount_died).toBe(2);
    });
});
