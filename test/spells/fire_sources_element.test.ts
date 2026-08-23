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

import spellsJson from "../../src/configuration/spells.json";
import { fireWallBurnDamage } from "../../src/spells/fire_walls";
import { ELEMENT_COUNTER_MULTIPLIER, fireforgedSwordDamage } from "../../src/spells/spell_damage";

const NEUTRAL = { isFireElement: false, isWaterElement: false, isWindElement: false, isEarthElement: false };

/**
 * Every source of fire in the game is priced by ONE element table. These pin the two that used to price
 * themselves: the Fireforged Sword carried a private copy of the fire rule, and the Fire Wall carried no
 * element at all — fire seared a Fire Element creature at full strength and gave a Water Element one no
 * extra.
 */
describe("fire sources all answer to the fire element", () => {
    describe("Fire Wall", () => {
        it("is declared FIRE in the spell book", () => {
            const fireWall = (spellsJson as unknown as Record<string, Record<string, { element: string }>>).Chaos?.[
                "Fire Wall"
            ];
            expect(fireWall?.element).toBe("FIRE");
        });

        it("cannot burn a creature made of fire", () => {
            expect(fireWallBurnDamage(1000, 25, { ...NEUTRAL, isFireElement: true })).toBe(0);
        });

        it("sears a water creature harder than a neutral one, by the table's counter", () => {
            const neutral = fireWallBurnDamage(1000, 25, NEUTRAL);
            const water = fireWallBurnDamage(1000, 25, { ...NEUTRAL, isWaterElement: true });

            expect(neutral).toBe(250);
            expect(water).toBe(Math.floor(250 * ELEMENT_COUNTER_MULTIPLIER));
            expect(water).toBeGreaterThan(neutral);
        });

        it("leaves wind and earth creatures on the neutral figure — fire counters neither", () => {
            const neutral = fireWallBurnDamage(1000, 25, NEUTRAL);
            expect(fireWallBurnDamage(1000, 25, { ...NEUTRAL, isWindElement: true })).toBe(neutral);
            expect(fireWallBurnDamage(1000, 25, { ...NEUTRAL, isEarthElement: true })).toBe(neutral);
        });

        it("still burns when the caller knows nothing about the target", () => {
            // The overload without a target keeps older callers working, priced as neutral.
            expect(fireWallBurnDamage(1000, 25)).toBe(250);
        });
    });

    describe("Fireforged Sword", () => {
        const burn = (target: Partial<typeof NEUTRAL>, magicResist = 0) =>
            fireforgedSwordDamage({
                damageDealt: 200,
                swordPercentage: 40,
                targetMagicResist: magicResist,
                targetIsFireElement: !!target.isFireElement,
                targetIsWaterElement: !!target.isWaterElement,
                targetIsWindElement: !!target.isWindElement,
                targetIsEarthElement: !!target.isEarthElement,
            });

        it("cannot burn a creature made of fire", () => {
            expect(burn({ isFireElement: true })).toBe(0);
        });

        it("burns a water creature by the same counter the table gives every fire source", () => {
            expect(burn({})).toBe(80);
            expect(burn({ isWaterElement: true })).toBe(Math.floor(80 * ELEMENT_COUNTER_MULTIPLIER));
        });

        it("leaves wind and earth creatures on the neutral figure", () => {
            expect(burn({ isWindElement: true })).toBe(80);
            expect(burn({ isEarthElement: true })).toBe(80);
        });

        it("is still cut by magic resistance, and fully stopped at 100", () => {
            expect(burn({}, 50)).toBe(40);
            expect(burn({}, 100)).toBe(0);
        });
    });
});
