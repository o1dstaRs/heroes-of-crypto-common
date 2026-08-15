import { describe, expect, it } from "bun:test";

import { ELEMENT_COUNTER_MULTIPLIER, elementalSpellMultiplier } from "../../src/spells/spell_damage";
import { SpellElement } from "../../src/spells/spell_properties";

/**
 * The element table, stated once in one place.
 *
 * Two opposed pairs — fire against water, earth against wind — where each element cannot touch the
 * creature that IS it and deals half again as much to the one it counters, in BOTH directions. The
 * ability cards have always promised this from the defending side (MAGIC_VULNERABILITY_WATER / _FIRE /
 * _EARTH, each at power 50); for a long time only fire-against-water was actually wired up.
 *
 * Earth's own immunity and air's counter have no creature to land on yet — nothing in the roster carries
 * an "Earth Element" ability — but they are pinned here so the rule cannot quietly rot before the first
 * earth creature arrives.
 */
const against = (element: SpellElement, target: "fire" | "water" | "wind" | "earth" | "none"): number =>
    elementalSpellMultiplier({
        element,
        targetIsFireElement: target === "fire",
        targetIsWaterElement: target === "water",
        targetIsWindElement: target === "wind",
        targetIsEarthElement: target === "earth",
    });

describe("elemental counter table", () => {
    it("makes every element harmless to the creature that IS it", () => {
        expect(against(SpellElement.FIRE, "fire")).toBe(0);
        expect(against(SpellElement.WATER, "water")).toBe(0);
        expect(against(SpellElement.AIR, "wind")).toBe(0);
        expect(against(SpellElement.EARTH, "earth")).toBe(0);
    });

    it("pays the counter bonus in both directions of each pair", () => {
        // fire <-> water
        expect(against(SpellElement.FIRE, "water")).toBe(ELEMENT_COUNTER_MULTIPLIER);
        expect(against(SpellElement.WATER, "fire")).toBe(ELEMENT_COUNTER_MULTIPLIER);
        // earth <-> wind
        expect(against(SpellElement.EARTH, "wind")).toBe(ELEMENT_COUNTER_MULTIPLIER);
        expect(against(SpellElement.AIR, "earth")).toBe(ELEMENT_COUNTER_MULTIPLIER);
    });

    it("leaves the opposite pair alone", () => {
        // Fire and water have no quarrel with wind or earth, and vice versa.
        for (const element of [SpellElement.FIRE, SpellElement.WATER] as const) {
            expect(against(element, "wind")).toBe(1);
            expect(against(element, "earth")).toBe(1);
        }
        for (const element of [SpellElement.AIR, SpellElement.EARTH] as const) {
            expect(against(element, "fire")).toBe(1);
            expect(against(element, "water")).toBe(1);
        }
    });

    it("leaves an elementless spell — most of the book — untouched", () => {
        for (const target of ["fire", "water", "wind", "earth", "none"] as const) {
            expect(against(SpellElement.NO_ELEMENT, target)).toBe(1);
        }
    });

    it("treats a missing targetIsEarthElement as 'not earth' so old call sites keep their meaning", () => {
        expect(
            elementalSpellMultiplier({
                element: SpellElement.EARTH,
                targetIsFireElement: false,
                targetIsWaterElement: false,
                targetIsWindElement: true,
            }),
        ).toBe(ELEMENT_COUNTER_MULTIPLIER);
        expect(
            elementalSpellMultiplier({
                element: SpellElement.AIR,
                targetIsFireElement: false,
                targetIsWaterElement: false,
                targetIsWindElement: false,
            }),
        ).toBe(1);
    });
});
