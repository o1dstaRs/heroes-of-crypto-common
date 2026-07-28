/*
 * Fireforged Sword's burning edge.
 *
 * It used to be implemented as a flat attack_mod -- a PHYSICAL buff on base_attack -- which meant none of
 * the blade's actual rules could hold: no fire damage was dealt at all, armour blunted it, magic
 * resistance did not, and it burned Fire Elements happily. It is now a magic rider on the swing.
 */
import { describe, expect, it } from "bun:test";

import { FIREFORGED_SWORD_WATER_MULTIPLIER, fireforgedSwordDamage } from "../../src/spells/spell_damage";

const burn = (overrides: Partial<Parameters<typeof fireforgedSwordDamage>[0]> = {}) =>
    fireforgedSwordDamage({
        damageDealt: 100,
        swordPercentage: 10,
        targetMagicResist: 0,
        targetIsFireElement: false,
        targetIsWaterElement: false,
        ...overrides,
    });

describe("Fireforged Sword", () => {
    it("sets the target alight for a share of the damage the swing dealt", () => {
        expect(burn()).toBe(10);
        expect(burn({ damageDealt: 250 })).toBe(25);
        // No swing landed (fully absorbed by a shield) leaves nothing to set alight.
        expect(burn({ damageDealt: 0 })).toBe(0);
    });

    it("burns water creatures 50% hotter", () => {
        expect(burn({ targetIsWaterElement: true })).toBe(15);
        expect(FIREFORGED_SWORD_WATER_MULTIPLIER).toBe(1.5);
    });

    it("does nothing to a fire creature, however hard the swing hit", () => {
        expect(burn({ targetIsFireElement: true })).toBe(0);
        expect(burn({ damageDealt: 10_000, targetIsFireElement: true })).toBe(0);
        // Fire immunity beats the water bonus rather than fighting it.
        expect(burn({ targetIsFireElement: true, targetIsWaterElement: true })).toBe(0);
    });

    it("is magic damage, so magic resistance cuts it and full immunity stops it", () => {
        expect(burn({ targetMagicResist: 50 })).toBe(5);
        expect(burn({ targetMagicResist: 75 })).toBe(2);
        expect(burn({ targetMagicResist: 100 })).toBe(0);
        // Even against water, where the blade burns hottest, 100% magic resistance takes nothing.
        expect(burn({ targetMagicResist: 100, targetIsWaterElement: true })).toBe(0);
        // A resistant water creature still takes the water bonus first, then the reduction.
        expect(burn({ targetMagicResist: 50, targetIsWaterElement: true })).toBe(7);
    });

    it("scales with the buff's own power, so Empower raises the fire", () => {
        // swordPercentage arrives already raised by the team's Empower Augment (fireforgedSwordPower).
        expect(burn({ swordPercentage: 10.7 })).toBe(10);
        expect(burn({ swordPercentage: 20 })).toBe(20);
        expect(burn({ swordPercentage: 0 })).toBe(0);
    });
});
