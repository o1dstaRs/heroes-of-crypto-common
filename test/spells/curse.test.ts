/*
 * -----------------------------------------------------------------------------
 * Curse (owner 2026-08-08) is Blessing's mirror: where Blessing lifts every roll to the MAXIMUM, Curse
 * drops every roll to the MINIMUM — a 2-4 attacker reads 2-2 for 3 laps. The pair must never sit on one
 * unit (each names the other in conflicts_with), and the spread has to come back when the curse expires.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import { getSpellConfig } from "../../src/configuration/config_provider";
import { Spell } from "../../src/spells/spell";
import { SpellTargetType } from "../../src/spells/spell_properties";
import { createTestUnit } from "../helpers/combat";

const spell = (faction: string, name: string) =>
    new Spell({ spellProperties: getSpellConfig(faction, name), amount: 1 });
const refresh = (unit: ReturnType<typeof createTestUnit>) => unit.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);
const spread = (unit: ReturnType<typeof createTestUnit>) => {
    const props = unit.getUnitProperties();
    return `${props.attack_damage_min}-${props.attack_damage_max}`;
};

describe("Curse configuration", () => {
    it("is a 3-lap enemy debuff that conflicts with the buffs it mirrors", () => {
        const curse = getSpellConfig("Death", "Curse");
        expect(curse.laps).toBe(3);
        expect(curse.is_buff).toBe(false);
        expect(curse.spell_target_type).toBe(SpellTargetType.ANY_ENEMY);
        expect(curse.conflicts_with).toContain("Blessing");
        expect(curse.conflicts_with).toContain("Battle Roar");
        // ...and the mirrors name it back, so neither can be stacked onto the other.
        expect(getSpellConfig("Life", "Blessing").conflicts_with).toContain("Curse");
        expect(getSpellConfig("System", "Battle Roar").conflicts_with).toContain("Curse");
    });
});

describe("Curse damage collapse", () => {
    it("drops a 2-4 attacker to 2-2 and gives the spread back when it lifts", () => {
        const unit = createTestUnit({ damageMin: 2, damageMax: 4 });
        refresh(unit);
        expect(spread(unit)).toBe("2-4");

        unit.applyDebuff(spell("Death", "Curse"));
        refresh(unit);
        expect(spread(unit)).toBe("2-2");

        unit.deleteDebuff("Curse");
        refresh(unit);
        expect(spread(unit)).toBe("2-4");
    });

    it("is the exact mirror of Blessing on the same unit", () => {
        const blessed = createTestUnit({ damageMin: 2, damageMax: 4 });
        blessed.applyBuff(spell("Life", "Blessing"));
        refresh(blessed);
        expect(spread(blessed)).toBe("4-4");

        const cursed = createTestUnit({ damageMin: 2, damageMax: 4 });
        cursed.applyDebuff(spell("Death", "Curse"));
        refresh(cursed);
        expect(spread(cursed)).toBe("2-2");
    });

    // Ranked mirrors debuff NAMES but never rebuilds the objects, so the display list has to drive the
    // collapse there — the same reason Blessing reads its applied_buffs label.
    it("honours the authoritative display list without a debuff object", () => {
        const unit = createTestUnit({ damageMin: 3, damageMax: 9 });
        unit.getUnitProperties().applied_debuffs.push("Curse");
        refresh(unit);
        expect(spread(unit)).toBe("3-3");
    });

    // A stale label can only ever be generous: Blessing wins the tie, never a silent zeroing.
    it("lets Blessing win if both labels are somehow present", () => {
        const unit = createTestUnit({ damageMin: 2, damageMax: 4 });
        unit.getUnitProperties().applied_buffs.push("Blessing");
        unit.getUnitProperties().applied_debuffs.push("Curse");
        refresh(unit);
        expect(spread(unit)).toBe("4-4");
    });
});
