/*
 * -----------------------------------------------------------------------------
 * Arcane Ward Blessing (Squire): magic defence for the WHOLE army, scaled by the
 * Squire's stack and moved by its luck — 2/4/6/8/10 at the card's power of 10.
 *
 * It was a 2-cell aura until the owner call of 2026-08-28 made it reach every ally
 * wherever they stand; the range below is what carries that, so it is pinned here.
 *
 * Also pins that the CARD prints the projected figure rather than the raw power:
 * a runtime grant used to fall through to the raw-power default, so every stack
 * would read the same number.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import { getAbilityConfig, getAuraEffectConfig } from "../../src/configuration/config_provider";
import { GRID_SIZE } from "../../src/grid/grid_constants";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { createTestUnit } from "../helpers/combat";

const squire = (stackPower: number, luck = 0) =>
    createTestUnit({
        name: "Squire",
        team: PBTypes.TeamVals.LOWER,
        abilities: ["Arcane Ward Blessing"],
        auraEffects: ["Arcane Ward"],
        auraRanges: [2],
        auraIsBuff: [true],
        stackPower,
        luck,
    });

const projected = (stackPower: number, luck = 0, synergy = 0) => {
    const unit = squire(stackPower, luck);
    return unit.calculateAuraPower(unit.getAuraEffects()[0], synergy);
};

describe("Arcane Ward Blessing", () => {
    it("reaches every ally on the board, not a 2-cell neighbourhood", () => {
        // Delivery is still the aura pipeline (so the stack/luck maths, stacking rules and buff card all
        // keep working), but the reach is what makes it army-wide: a radius of at least one full board
        // covers every cell from wherever the Squire happens to stand, corner to corner.
        const range = getAuraEffectConfig("Arcane Ward")?.range ?? 0;
        expect(range).toBeGreaterThanOrEqual(GRID_SIZE);
    });

    it("no longer calls itself an aura, and says who it reaches", () => {
        // The art was authored as arcane_ward_blessing_256 and abilityToTextureName keys straight off the
        // NAME, so a name ending in "Aura" is also why the card rendered with no icon at all.
        expect(getAbilityConfig("Arcane Ward Blessing").name).not.toContain("Aura");
        expect(getAbilityConfig("Arcane Ward Blessing").desc.join(" ")).toContain("Every ally");
    });

    it("is configured at 10 power on both the ability and its aura effect", () => {
        // The ladder below is (power / MAX_UNIT_STACK_POWER) * stack, so the two must agree or the card
        // would advertise a different number than the aura projects.
        expect(getAbilityConfig("Arcane Ward Blessing").power).toBe(10);
        expect(getAuraEffectConfig("Arcane Ward")?.power).toBe(10);
    });

    it("runs 2/4/6/8/10 across the stack", () => {
        expect([1, 2, 3, 4, 5].map((stack) => projected(stack))).toEqual([2, 4, 6, 8, 10]);
    });

    it("moves with the Squire's luck and the team's synergy bonus", () => {
        // getLuck caps the roll at +-10, so luck shifts the projection by at most ten points either way.
        expect(projected(5, 10)).toBe(20);
        expect(projected(5, -10)).toBe(0);
        expect(projected(3, 10, 5)).toBe(21);
    });

    it("prints the projected figure on the card, not the raw power", () => {
        const bearer = createTestUnit({ name: "Bearer", team: PBTypes.TeamVals.LOWER, stackPower: 2 });
        bearer.grantAbility("Arcane Ward Blessing");

        const index = bearer.getUnitProperties().abilities.indexOf("Arcane Ward Blessing");
        const description = bearer.getUnitProperties().abilities_descriptions[index];

        // Two stacks projects 4, while the card's raw power is 10.
        expect(description).toContain("4%");
        expect(description).not.toContain("10%");
    });
});
