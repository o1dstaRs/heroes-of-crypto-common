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

import { LUCK_MAX_VALUE_TOTAL } from "../../src/constants";
import { getSpellConfig } from "../../src/configuration/config_provider";
import { Spell } from "../../src/spells/spell";
import type { Unit } from "../../src/units/unit";
import { createTestUnit } from "../helpers/combat";

const spell = (faction: string, name: string): Spell =>
    new Spell({ spellProperties: getSpellConfig(faction, name), amount: 1 });

const misfortune = (): Spell => spell("Chaos", "Misfortune");
const cloverOfFortune = (): Spell => spell("System", "Clover of Fortune");

/** One refresh of the live stat derivation, the way UnitsHolder runs it every turn. */
const refresh = (unit: Unit, lap = 1): void => unit.adjustBaseStats(true, lap, 0, 0, 0, 0, 0);

/**
 * Misfortune OWNS the target's luck: it is pinned to the floor for as long as the debuff lasts, and only a
 * luck buff (the Leprechaun's Luck Aura, the Clover of Fortune) trades that floor for a flat zero. Nothing
 * the unit does afterwards may lift it — not the Luck Shield a defending unit raises, not the per-turn luck
 * roll every lap brings.
 */
describe("Misfortune pins luck", () => {
    it("drops a plain unit to the floor, whatever luck it started with", () => {
        const unit = createTestUnit({ name: "Squire", luck: 5 });
        unit.applyDebuff(misfortune());
        refresh(unit);

        expect(unit.getLuck()).toBe(-LUCK_MAX_VALUE_TOTAL);
    });

    it("is traded for exactly zero when the target is luck-buffed", () => {
        const unit = createTestUnit({ name: "Squire", luck: 5 });
        unit.applyBuff(cloverOfFortune(), 10);
        unit.applyDebuff(misfortune());
        refresh(unit);

        expect(unit.getLuck()).toBe(0);
    });

    it("is not lifted by the Luck Shield a defending unit raises", () => {
        const unit = createTestUnit({ name: "Squire", luck: 5 });
        unit.applyDebuff(misfortune());
        refresh(unit);
        unit.applyLuckShield();

        expect(unit.getLuck()).toBe(-LUCK_MAX_VALUE_TOTAL);

        const buffed = createTestUnit({ name: "Squire", luck: 5 });
        buffed.applyBuff(cloverOfFortune(), 10);
        buffed.applyDebuff(misfortune());
        refresh(buffed);
        buffed.applyLuckShield();

        expect(buffed.getLuck()).toBe(0);
    });

    it("is not lifted by the per-turn luck roll", () => {
        const unit = createTestUnit({ name: "Squire", luck: 5 });
        unit.applyDebuff(misfortune());
        refresh(unit);
        for (let roll = 0; roll < 20; roll += 1) {
            unit.randomizeLuckPerTurn();
            expect(unit.getLuck()).toBe(-LUCK_MAX_VALUE_TOTAL);
        }
    });

    it("gives the luck back once the debuff is gone", () => {
        const unit = createTestUnit({ name: "Squire", luck: 5 });
        unit.applyDebuff(misfortune());
        refresh(unit);
        expect(unit.getLuck()).toBe(-LUCK_MAX_VALUE_TOTAL);

        unit.deleteDebuff("Misfortune");
        refresh(unit, 2);

        expect(unit.getLuck()).toBeGreaterThan(-LUCK_MAX_VALUE_TOTAL);
    });
});
