/*
 * -----------------------------------------------------------------------------
 * The Armor augment hardens MAGIC armor by adding its POINTS onto the base — one purchase, both defences,
 * but they land differently. Physical armor gains a percentage of the unit's own stat; magic armor gains
 * the number outright, because base magic armor is 0/5/10/15 by creature level and a percentage handed a
 * level 1 creature 21% of nothing.
 * -----------------------------------------------------------------------------
 */

import { afterEach, describe, expect, it } from "bun:test";

import { ArmorAugment, getArmorPower } from "../../src/augments/augment_properties";
import { getSpellConfig } from "../../src/configuration/config_provider";
import { NUMBER_OF_LAPS_TOTAL } from "../../src/constants";
import { Spell } from "../../src/spells/spell";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createTestUnit } from "../helpers/combat";

const armorAugmentBuff = (level: ArmorAugment): Spell => {
    const buff = new Spell({
        spellProperties: getSpellConfig("System", "Armor Augment", NUMBER_OF_LAPS_TOTAL),
        amount: 1,
    });
    buff.setPower(getArmorPower(level));
    return buff;
};

/** Base stats, then the same unit with the augment applied, both after a stat recompute. */
const withAndWithout = (level: ArmorAugment, magicResist: number, armor: number) => {
    const plain = createTestUnit({ name: "Squire", magicResist, armor });
    plain.adjustBaseStats(true, 1, 0, 0, 0, 0, 0, 0);

    const augmented = createTestUnit({ name: "Squire", magicResist, armor });
    augmented.applyBuff(armorAugmentBuff(level));
    augmented.adjustBaseStats(true, 1, 0, 0, 0, 0, 0, 0);

    return { plain, augmented };
};

describe("Armor augment grants magic armor too", () => {
    afterEach(() => setDeterministicRandomSource(undefined));

    it("adds the augment's points straight onto magic armor, at every level", () => {
        for (const level of [ArmorAugment.LEVEL_1, ArmorAugment.LEVEL_2, ArmorAugment.LEVEL_3]) {
            const { plain, augmented } = withAndWithout(level, 15, 12);

            expect(plain.getMagicResist()).toBeCloseTo(15, 1);
            expect(augmented.getMagicResist()).toBeCloseTo(15 + getArmorPower(level), 1);
        }
    });

    // The headline case: a level 4 creature's 15 becomes 36 under a level 3 augment.
    it("takes a level 4 creature's 15 magic armor to 36", () => {
        const { augmented } = withAndWithout(ArmorAugment.LEVEL_3, 15, 12);

        expect(augmented.getMagicResist()).toBeCloseTo(36, 1);
    });

    // Base magic armor by creature level: 0 / 5 / 10 / 15. Every tier gains the full points.
    it("gives the same points whatever the creature's level started at", () => {
        for (const base of [0, 5, 10, 15]) {
            const { augmented } = withAndWithout(ArmorAugment.LEVEL_2, base, 12);

            expect(augmented.getMagicResist()).toBeCloseTo(base + getArmorPower(ArmorAugment.LEVEL_2), 1);
        }
    });

    it("keeps physical armor on the percentage — only the magic half is flat", () => {
        const { plain, augmented } = withAndWithout(ArmorAugment.LEVEL_3, 20, 12);
        const power = getArmorPower(ArmorAugment.LEVEL_3);

        expect(augmented.getBaseArmor() / plain.getBaseArmor()).toBeCloseTo(1 + power / 100, 3);
        expect(augmented.getMagicResist() - plain.getMagicResist()).toBeCloseTo(power, 3);
    });

    // This is the case the percentage silently missed: a level 1 creature starts at 0 magic armor, so a
    // percentage of it was always 0 and the augment bought that unit nothing at all.
    it("arms a creature that started with no magic armor at all", () => {
        const { augmented } = withAndWithout(ArmorAugment.LEVEL_3, 0, 12);

        expect(augmented.getMagicResist()).toBeCloseTo(getArmorPower(ArmorAugment.LEVEL_3), 1);
    });

    it("still composes with an independent Magic Shield roll instead of replacing it", () => {
        // adjustBaseStats rolls the turn's luck before deriving stack-powered Magic Shield. Replay the exact
        // same roll for both units so this assertion isolates only the Armor augment.
        setDeterministicRandomSource(() => 0);
        const shielded = createTestUnit({
            name: "Squire",
            abilities: ["Magic Shield"],
            magicResist: 20,
            stackPower: 5,
        });
        shielded.adjustBaseStats(true, 1, 0, 0, 0, 0, 0, 0);
        const shieldedOnly = shielded.getMagicResist();

        setDeterministicRandomSource(() => 0);
        const both = createTestUnit({ name: "Squire", abilities: ["Magic Shield"], magicResist: 20, stackPower: 5 });
        both.applyBuff(armorAugmentBuff(ArmorAugment.LEVEL_3));
        both.adjustBaseStats(true, 1, 0, 0, 0, 0, 0, 0);

        // The augment lifts the base the shield rolls on top of, so the total climbs but stays under 100%.
        expect(both.getMagicResist()).toBeGreaterThan(shieldedOnly);
        expect(both.getMagicResist()).toBeLessThan(100);
    });

    it("says so on the buff card", () => {
        const description = getSpellConfig("System", "Armor Augment", NUMBER_OF_LAPS_TOTAL).desc.join(" ");

        expect(description).toContain("magic armor");
    });
});
