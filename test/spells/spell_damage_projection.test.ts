/*
 * -----------------------------------------------------------------------------
 * The number the hover projection SHOWS must be the number the cast DEALS.
 *
 * It was not: the client priced every offensive spell with the UNIT_AMOUNT_STACK_POWER shape, so the Battle
 * Mage's flat-per-caster book (Fire Strike, Meteorite) was projected at up to 5x — one extra factor of the
 * caster's stack power — while the Magic Dragon's stack-powered book happened to read correctly. These tests
 * walk every offensive spell in the catalog rather than a hand-picked pair, so a new spell in either shape
 * cannot reintroduce the gap.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import spellsJson from "../../src/configuration/spells.json";
import {
    applyElementAndResistToSpellDamage,
    applyMagicResistToSpellDamage,
    calculateSpellDamage,
    isOffensiveSpellMultiplier,
    offensiveSpellDamageAgainstTarget,
} from "../../src/spells/spell_damage";
import { SpellMultiplierType } from "../../src/spells/spell_properties";

interface IRawSpell {
    power: number;
    multiplier_type: string;
}

/** Every offensive spell in the catalog, as (faction, name, power, multiplier) rows. */
const offensiveSpells = (): { faction: string; name: string; power: number; multiplier: SpellMultiplierType }[] => {
    const rows: { faction: string; name: string; power: number; multiplier: SpellMultiplierType }[] = [];
    const catalog = spellsJson as unknown as Record<string, Record<string, IRawSpell>>;
    for (const [faction, spells] of Object.entries(catalog)) {
        if (!spells || typeof spells !== "object") {
            continue;
        }
        for (const [name, spell] of Object.entries(spells)) {
            const multiplier = SpellMultiplierType[spell?.multiplier_type as keyof typeof SpellMultiplierType];
            if (multiplier !== undefined && isOffensiveSpellMultiplier(multiplier)) {
                rows.push({ faction, name, power: spell.power, multiplier });
            }
        }
    }
    return rows;
};

// The engine's own two steps, spelled out here rather than imported, so this test would still catch a change
// that edited both the projection and the engine's helper in the same direction.
const engineDamage = (
    multiplier: SpellMultiplierType,
    power: number,
    alive: number,
    stackPower: number,
    bonus: number,
    elementMultiplier: number,
    resist: number,
): number => {
    const raw = calculateSpellDamage(multiplier, power, alive, stackPower, bonus);
    if (elementMultiplier <= 0) {
        return 0;
    }
    const scaled = elementMultiplier === 1 ? raw : Math.floor(raw * elementMultiplier);
    return applyMagicResistToSpellDamage(scaled, resist);
};

describe("offensive spell damage projection", () => {
    it("covers both multiplier shapes, so this suite is not silently testing one of them", () => {
        const shapes = new Set(offensiveSpells().map((row) => row.multiplier));
        expect(shapes.has(SpellMultiplierType.UNIT_AMOUNT_DAMAGE)).toBe(true);
        expect(shapes.has(SpellMultiplierType.UNIT_AMOUNT_STACK_POWER)).toBe(true);
    });

    it("projects exactly what the engine deals, for every offensive spell across casters and targets", () => {
        const casters = [
            { alive: 1, stackPower: 1, bonus: 0 },
            { alive: 50, stackPower: 5, bonus: 0 },
            { alive: 37, stackPower: 3, bonus: 15 },
            { alive: 200, stackPower: 5, bonus: 30 },
        ];
        // Element multipliers the catalog actually produces: immune, neutral, and the half-again weakness.
        const targets = [
            { resist: 0, element: 1 },
            { resist: 26, element: 1 },
            { resist: 75, element: 1 },
            { resist: 100, element: 1 },
            { resist: 20, element: 1.5 },
            { resist: 20, element: 0 },
        ];

        for (const spell of offensiveSpells()) {
            for (const caster of casters) {
                for (const target of targets) {
                    const projected = offensiveSpellDamageAgainstTarget(
                        spell.multiplier,
                        spell.power,
                        caster.alive,
                        caster.stackPower,
                        caster.bonus,
                        target.resist,
                        target.element,
                    );
                    const dealt = engineDamage(
                        spell.multiplier,
                        spell.power,
                        caster.alive,
                        caster.stackPower,
                        caster.bonus,
                        target.element,
                        target.resist,
                    );
                    expect({ spell: spell.name, ...caster, ...target, damage: projected }).toEqual({
                        spell: spell.name,
                        ...caster,
                        ...target,
                        damage: dealt,
                    });
                }
            }
        }
    });

    // The specific regression: a flat-per-caster spell must NOT pick up the caster's stack power.
    it("does not multiply a UNIT_AMOUNT_DAMAGE spell by stack power", () => {
        const flat = (stackPower: number) =>
            offensiveSpellDamageAgainstTarget(SpellMultiplierType.UNIT_AMOUNT_DAMAGE, 6, 50, stackPower, 0, 0);
        // Fire Strike at 50 casters is 300 regardless of how powered the stack is.
        expect(flat(1)).toBe(300);
        expect(flat(5)).toBe(300);
        // ...while the stack-powered shape does scale, which is what made the bug invisible on the Dragon.
        const powered = (stackPower: number) =>
            offensiveSpellDamageAgainstTarget(SpellMultiplierType.UNIT_AMOUNT_STACK_POWER, 24, 50, stackPower, 0, 0);
        expect(powered(1)).toBe(1200);
        expect(powered(5)).toBe(6000);
    });

    // An AOE deals one raw damage but lands differently on each unit it catches, which is the whole reason
    // the projection is computed per target rather than once for the blast.
    it("differs per target under one blast when resistances differ", () => {
        const raw = { multiplier: SpellMultiplierType.UNIT_AMOUNT_STACK_POWER, power: 21.6, alive: 10, sp: 5 };
        const against = (resist: number) =>
            offensiveSpellDamageAgainstTarget(raw.multiplier, raw.power, raw.alive, raw.sp, 0, resist);
        expect(against(0)).toBe(1080);
        expect(against(50)).toBe(540);
        expect(against(100)).toBe(0);
        expect(against(0)).not.toBe(against(50));
    });

    it("zeroes a target whose element is immune to the spell, before resistance is even considered", () => {
        expect(applyElementAndResistToSpellDamage(1000, 0, 0)).toBe(0);
        expect(applyElementAndResistToSpellDamage(1000, 1.5, 0)).toBe(1500);
        expect(applyElementAndResistToSpellDamage(1000, 1.5, 50)).toBe(750);
    });
});
