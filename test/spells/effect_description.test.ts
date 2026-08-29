/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import { getSpellConfig } from "../../src/configuration/config_provider";
import { fillEffectPowerPlaceholders, positionalPropertyCount } from "../../src/spells/effect_description";
import { Spell } from "../../src/spells/spell";

/**
 * A player must never read a literal "{}" in a tooltip.
 *
 * Applied buff/debuff descriptions are stored as `text;firstProperty;secondProperty` and the client fills
 * the text's placeholders from those properties. Every spell CAST applies its buff with no properties, so
 * the placeholders survived all the way to the hover card: "Reflects {}% of consumed magical damage back
 * to attacker". The number is the effect's own power in each case.
 */
describe("effect description placeholders", () => {
    it("fills a placeholder with the effect's power", () => {
        expect(fillEffectPowerPlaceholders("Adds {}% to all magic damage.", 25, 0)).toBe(
            "Adds 25% to all magic damage.",
        );
    });

    it("fills every placeholder when the caller supplies no properties", () => {
        expect(fillEffectPowerPlaceholders("Reflects {}%. Gives {}% chance.", 30, 0)).toBe(
            "Reflects 30%. Gives 30% chance.",
        );
    });

    it("leaves placeholders the caller fills positionally", () => {
        // Sniper/Armor Augment pass both properties; those must reach the text, not the power.
        expect(fillEffectPowerPlaceholders("{} then {}", 99, 2)).toBe("{} then {}");
        // One supplied property consumes the FIRST placeholder; the rest fall back to power.
        expect(fillEffectPowerPlaceholders("{} then {}", 99, 1)).toBe("{} then 99");
    });

    it("leaves a text that has already been substituted upstream", () => {
        // The augments rewrite their own description before applying; nothing must change under them.
        const substituted = "Grants 15 armor.";
        expect(fillEffectPowerPlaceholders(substituted, 15, 0)).toBe(substituted);
    });

    it("leaves the template alone when there is no usable power", () => {
        // "0%" would read worse than an untouched template, and these effects substitute upstream.
        expect(fillEffectPowerPlaceholders("Adds {}%.", 0, 0)).toBe("Adds {}%.");
        expect(fillEffectPowerPlaceholders("Adds {}%.", Number.NaN, 0)).toBe("Adds {}%.");
    });

    it("keeps a fractional power readable", () => {
        expect(fillEffectPowerPlaceholders("{}x", 1.5, 0)).toBe("1.5x");
        // Tome amplification produces values like 25 * 1.2; they must not render as 30.000000000000004.
        expect(fillEffectPowerPlaceholders("{}%", 25 * 1.2, 0)).toBe("30%");
    });

    it("counts only the properties the caller actually supplied", () => {
        expect(positionalPropertyCount(undefined, undefined)).toBe(0);
        expect(positionalPropertyCount(3, undefined)).toBe(1);
        expect(positionalPropertyCount(3, 4)).toBe(2);
        // Zero is a supplied value, not an absent one.
        expect(positionalPropertyCount(0, undefined)).toBe(1);
    });
});

describe("cast buffs no longer show a raw placeholder", () => {
    /** What the client renders: the text before the `;`, with its positional properties filled in. */
    const shownText = (stored: string): string => {
        const parts = stored.split(";");
        let text = parts[0] ?? "";
        for (let p = 1; p < parts.length; p++) {
            const value = parts[p];
            if (value === undefined || value === "" || !text.includes("{}")) continue;
            text = text.replace("{}", value);
        }
        return text;
    };

    // Every buff a unit can CAST whose description carries a placeholder. These reach a player as a hover
    // card on the buffed unit, which is where the literal "{}" was reported.
    for (const [faction, name, power] of [
        ["Chaos", "Mass Magic Mirror", 32],
        ["Chaos", "Magic Mirror", 40],
        ["Chaos", "Empower", 25],
        ["Chaos", "Fireforged Sword", 10],
    ] as const) {
        it(`${name} states its ${power}% rather than a placeholder`, () => {
            const spell = new Spell({ spellProperties: getSpellConfig(faction, name), amount: 1 });
            const body = spell
                .getDesc()
                .slice(0, spell.getDesc().length - 1)
                .join(" ");
            const stored = `${fillEffectPowerPlaceholders(body, spell.getPower(), 0)};;`;

            const text = shownText(stored);
            expect(text).not.toContain("{}");
            expect(text).toContain(`${power}%`);
        });
    }

    it("Magic Mirror quotes the same number the engine rolls the debuff mirror against", () => {
        // isMirrored() rolls against getMagicMirrorPower(), which IS the buff's power — so the two
        // sentences legitimately quote one number, and the tooltip must not invent a second.
        const spell = new Spell({ spellProperties: getSpellConfig("Chaos", "Magic Mirror"), amount: 1 });
        const body = spell
            .getDesc()
            .slice(0, spell.getDesc().length - 1)
            .join(" ");

        const filled = fillEffectPowerPlaceholders(body, spell.getPower(), 0);
        expect(filled.match(/40%/g)?.length).toBe(2);
    });
});
