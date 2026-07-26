/*
 * -----------------------------------------------------------------------------
 * Warding Mane Aura (Manticore): magic resistance for nearby allies, scaled by the
 * Manticore's stack and moved by its luck — 5/10/15/20/25 at the card's power of 25.
 *
 * Also pins that the CARD prints the projected figure rather than the raw power:
 * a runtime grant used to fall through to the raw-power default, so every stack
 * read the same number.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import { getAbilityConfig, getAuraEffectConfig } from "../../src/configuration/config_provider";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { createTestUnit } from "../helpers/combat";

const manticore = (stackPower: number, luck = 0) =>
    createTestUnit({
        name: "Manticore",
        team: PBTypes.TeamVals.LOWER,
        abilities: ["Warding Mane Aura"],
        auraEffects: ["Warding Mane"],
        auraRanges: [2],
        auraIsBuff: [true],
        stackPower,
        luck,
    });

const projected = (stackPower: number, luck = 0, synergy = 0) => {
    const unit = manticore(stackPower, luck);
    return unit.calculateAuraPower(unit.getAuraEffects()[0], synergy);
};

describe("Warding Mane Aura", () => {
    it("is configured at 25 power on both the ability and its aura effect", () => {
        // The ladder below is (power / MAX_UNIT_STACK_POWER) * stack, so the two must agree or the card
        // would advertise a different number than the aura projects.
        expect(getAbilityConfig("Warding Mane Aura").power).toBe(25);
        expect(getAuraEffectConfig("Warding Mane")?.power).toBe(25);
    });

    it("runs 5/10/15/20/25 across the stack", () => {
        expect([1, 2, 3, 4, 5].map((stack) => projected(stack))).toEqual([5, 10, 15, 20, 25]);
    });

    it("moves with the Manticore's luck and the team's synergy bonus", () => {
        // getLuck caps the roll at +-10, so luck shifts the projection by at most ten points either way.
        expect(projected(3, 10)).toBe(25);
        expect(projected(3, -10)).toBe(5);
        expect(projected(3, 10, 5)).toBe(30);
    });

    it("prints the projected figure on the card, not the raw power", () => {
        const bearer = createTestUnit({ name: "Bearer", team: PBTypes.TeamVals.LOWER, stackPower: 2 });
        bearer.grantAbility("Warding Mane Aura");

        const index = bearer.getUnitProperties().abilities.indexOf("Warding Mane Aura");
        const description = bearer.getUnitProperties().abilities_descriptions[index];

        // Two stacks projects 10, while the card's raw power is 25.
        expect(description).toContain("10%");
        expect(description).not.toContain("25%");
    });
});
