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

import { isTakeableBuff } from "../../src/abilities/borrowed_grace_ability";
import { getSpellConfig } from "../../src/configuration/config_provider";
import spellsJson from "../../src/configuration/spells.json";
import { NUMBER_OF_LAPS_TOTAL } from "../../src/constants";
import { Spell } from "../../src/spells/spell";
import {
    ChaosSynergyNames,
    LifeSynergyNames,
    MightSynergyNames,
    NatureSynergyNames,
} from "../../src/synergies/synergy_properties";
import { createTestUnit } from "../helpers/combat";
import { PBTypes } from "../../src/generated/protobuf/v1/types";

// Borrowed Grace (the Monk's buff-steal shot) must never take team-setup state off a unit: augment
// buffs are worn "* Augment" System spells, and synergies must never exist as unit buffs at all.
describe("Borrowed Grace setup-state exclusions", () => {
    const AUGMENT_BUFFS = ["Armor Augment", "Might Augment", "Empower Augment", "Sniper Augment", "Movement Augment"];

    it("cannot take any worn augment buff", () => {
        const target = createTestUnit({ name: "Target", team: PBTypes.TeamVals.LOWER, amountAlive: 5, maxHp: 50 });
        for (const buffName of AUGMENT_BUFFS) {
            const buff = new Spell({
                spellProperties: getSpellConfig("System", buffName, NUMBER_OF_LAPS_TOTAL),
                amount: 1,
            });
            target.applyBuff(buff);
        }
        const worn = target.getBuffs();
        expect(worn.length).toBe(AUGMENT_BUFFS.length);
        for (const buff of worn) {
            expect(isTakeableBuff(buff)).toBe(false);
        }
    });

    it("synergies never materialize as unit buffs, so there is nothing to steal", () => {
        // A synergy is a computed team bonus (FightProperties.getAdditional*PerTeam), not an AppliedSpell.
        // Guard the structural side: no synergy name may gain a System spell entry — the moment one does,
        // it would become wearable and this exclusion list needs a real decision.
        const systemSpellNames = new Set(Object.keys((spellsJson as Record<string, object>).System ?? {}));
        const synergyNames = [
            ...Object.values(LifeSynergyNames),
            ...Object.values(ChaosSynergyNames),
            ...Object.values(MightSynergyNames),
            ...Object.values(NatureSynergyNames),
        ];
        expect(synergyNames.length).toBeGreaterThan(0);
        for (const name of synergyNames) {
            expect(systemSpellNames.has(String(name))).toBe(false);
        }
    });

    it("still takes an ordinary cast blessing (positive control)", () => {
        const target = createTestUnit({ name: "Target", team: PBTypes.TeamVals.LOWER, amountAlive: 5, maxHp: 50 });
        target.applyBuff(new Spell({ spellProperties: getSpellConfig("Life", "Spiritual Armor"), amount: 1 }));
        const worn = target.getBuffs();
        expect(worn.length).toBe(1);
        expect(isTakeableBuff(worn[0])).toBe(true);
    });
});
