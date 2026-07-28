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

import { beforeEach, describe, expect, it } from "bun:test";

import { getSpellConfig } from "../../src/configuration/config_provider";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { Spell } from "../../src/spells/spell";
import { Unit } from "../../src/units/unit";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const rune = (name: "Armor Rune" | "Weapon Rune") =>
    new Spell({ spellProperties: getSpellConfig("System", name), amount: 1 });

/**
 * Strip a unit down to how a RANKED client carries its buffs: the authoritative snapshot conveys buffs as
 * the `applied_buffs*` display arrays only, and RankedPlayScene rebuilds units from that — `this.buffs`
 * (what getBuff reads) stays empty. Keep the arrays, drop the live AppliedSpells.
 */
const asRankedSnapshotUnit = (unit: Unit): void => {
    for (const buff of [...unit.getBuffs()]) {
        const index = unit.getUnitProperties().applied_buffs.indexOf(buff.getName());
        unit.getBuffs().splice(unit.getBuffs().indexOf(buff), 1);
        expect(index).toBeGreaterThan(-1);
    }
    expect(unit.getBuffs()).toHaveLength(0);
};

describe("Blacksmith runes in ranked", () => {
    beforeEach(() => {
        FightStateManager.getInstance().reset();
    });

    /**
     * The Blacksmith's whole contribution is the number the rune adds, so when the ranked client scored it as
     * +0 the enchants looked completely dead: the log said "+2 armor" and the unit card never moved. The
     * stacking total rides the buff description (`desc;first;second`) which the server ships verbatim, so a
     * snapshot-only unit has to reach the same stats as one holding the live buff.
     */
    it("still applies the stacked bonus to a unit that carries them as snapshot state only", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const live = createTestUnit({ name: "Squire", team: PBTypes.TeamVals.LOWER });
        const ranked = createTestUnit({ name: "Squire", team: PBTypes.TeamVals.LOWER });
        placeUnit(grid, unitsHolder, live, { x: 2, y: 2 });
        placeUnit(grid, unitsHolder, ranked, { x: 4, y: 2 });
        const baseArmor = live.getArmor();
        const baseAttack = live.getAttack();

        for (const unit of [live, ranked]) {
            unit.applyBuff(rune("Armor Rune"), 3);
            unit.applyBuff(rune("Weapon Rune"), 2);
        }
        asRankedSnapshotUnit(ranked);
        unitsHolder.refreshStackPowerForAllUnits();

        expect(live.getArmor()).toBe(baseArmor + 3);
        expect(live.getAttack()).toBe(baseAttack + 2);
        expect(ranked.getArmor()).toBe(live.getArmor());
        expect(ranked.getAttack()).toBe(live.getAttack());
    });

    // The fallback reads the display arrays; it must not fold the bonus in twice for the unit that also
    // holds the live buff, nor leak a stat onto a unit that was never enchanted.
    it("counts each rune once and leaves an un-enchanted unit alone", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const enchanted = createTestUnit({ name: "Squire", team: PBTypes.TeamVals.LOWER });
        const plain = createTestUnit({ name: "Squire", team: PBTypes.TeamVals.LOWER });
        placeUnit(grid, unitsHolder, enchanted, { x: 2, y: 2 });
        placeUnit(grid, unitsHolder, plain, { x: 4, y: 2 });
        const baseArmor = plain.getArmor();

        enchanted.applyBuff(rune("Armor Rune"), 4);
        for (let i = 0; i < 3; i += 1) {
            unitsHolder.refreshStackPowerForAllUnits();
        }

        expect(enchanted.getArmor()).toBe(baseArmor + 4);
        expect(plain.getArmor()).toBe(baseArmor);
    });
});
