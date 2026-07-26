/*
 * -----------------------------------------------------------------------------
 * The Armor augment hardens MAGIC armor by the same percentage it adds to physical
 * armor — one purchase, both defences, identical shape (a % of the unit's own stat).
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

    it("raises magic resist by the augment's own percentage, at every level", () => {
        for (const level of [ArmorAugment.LEVEL_1, ArmorAugment.LEVEL_2, ArmorAugment.LEVEL_3]) {
            const { plain, augmented } = withAndWithout(level, 20, 12);
            const expected = 20 + (20 / 100) * getArmorPower(level);

            expect(plain.getMagicResist()).toBeCloseTo(20, 1);
            expect(augmented.getMagicResist()).toBeCloseTo(expected, 1);
        }
    });

    it("uses the SAME percentage on both defences", () => {
        const { plain, augmented } = withAndWithout(ArmorAugment.LEVEL_3, 20, 12);

        const magicGain = augmented.getMagicResist() / plain.getMagicResist();
        const armorGain = augmented.getBaseArmor() / plain.getBaseArmor();
        expect(magicGain).toBeCloseTo(armorGain, 3);
        expect(magicGain).toBeCloseTo(1 + getArmorPower(ArmorAugment.LEVEL_3) / 100, 3);
    });

    it("leaves a unit with no magic resist at zero — it is a percentage, not a flat grant", () => {
        const { augmented } = withAndWithout(ArmorAugment.LEVEL_3, 0, 12);

        expect(augmented.getMagicResist()).toBe(0);
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
