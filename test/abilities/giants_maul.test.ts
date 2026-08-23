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

import { processRangeAOEAbility } from "../../src/abilities/aoe_range_ability";
import { getSpellConfig } from "../../src/configuration/config_provider";
import { NUMBER_OF_LAPS_TOTAL } from "../../src/constants";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Spell } from "../../src/spells/spell";
import type { Unit } from "../../src/units/unit";
import { createCombatTestContext, createTestUnit, DamageStatisticHolder, placeUnit } from "../helpers/combat";

const GREEN = PBTypes.TeamVals.LOWER;
const RED = PBTypes.TeamVals.UPPER;

const giveGiantsMaul = (unit: Unit, power: number): void => {
    const buff = new Spell({
        spellProperties: getSpellConfig("System", "Giants Maul", NUMBER_OF_LAPS_TOTAL),
        amount: 1,
    });
    buff.setPower(power);
    unit.applyBuff(buff);
};

describe("Giant's Maul (+40% non-magical AOE damage)", () => {
    const aoeContext = (options?: { maul?: number; factor?: number }) => {
        const { grid, unitsHolder } = createCombatTestContext();
        const damageStatisticHolder = new DamageStatisticHolder();
        const attacker = createTestUnit({
            name: "AOE Attacker",
            team: RED,
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 2,
            abilities: ["Area Throw"],
        });
        attacker.calculateMissChance = () => 0;
        attacker.calculateAttackDamage = () => 100;
        const target = createTestUnit({ name: "Target", team: GREEN, maxHp: 10_000, armor: 0 });
        placeUnit(grid, unitsHolder, attacker, { x: 7, y: 7 });
        placeUnit(grid, unitsHolder, target, { x: 2, y: 2 });
        if (options?.maul) {
            giveGiantsMaul(attacker, options.maul);
        }
        const result = processRangeAOEAbility(
            attacker,
            [target],
            attacker,
            1,
            unitsHolder,
            grid,
            new SceneLogMock(),
            damageStatisticHolder,
            true,
            [],
            options?.factor !== undefined ? { [target.getId()]: options.factor } : undefined,
        );
        return result.perUnitDamage[0]?.amount ?? 0;
    };

    it("boosts a struck unit's AOE damage by the configured percent", () => {
        expect(aoeContext()).toBe(100); // no Maul: base 100
        expect(aoeContext({ maul: 40 })).toBe(140); // +40% at impact
    });

    it("applies on top of Zena's Chakram bounce factor (the disc routes through the shared AOE tail)", () => {
        // A two-cell bounce halves the hit; Giant's Maul still boosts what lands. The Chakram feeds its
        // damageFactorByUnitId into this exact processor, so proving the factor+Maul stack here proves the
        // disc's bounces are boosted (attack_handler passes the trajectory's factors straight through).
        expect(aoeContext({ factor: 0.5 })).toBe(50); // half bounce, no Maul
        expect(aoeContext({ factor: 0.5, maul: 40 })).toBe(70); // 100 -> 50 -> +40% = 70
    });
});

describe("Giant's Maul rescales the AOE ability descriptions", () => {
    const lightningSpinDamagePercent = (unit: Unit): string | undefined => {
        const props = unit.getUnitProperties();
        const index = props.abilities.indexOf("Lightning Spin");
        return props.abilities_descriptions[index];
    };

    it("shows the boosted damage percent while the buff is up, and the base percent without it", () => {
        const unit = createTestUnit({ name: "Spinner", team: GREEN, abilities: ["Lightning Spin"], stackPower: 5 });
        unit.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);
        expect(lightningSpinDamagePercent(unit)).toContain("100% damage");

        giveGiantsMaul(unit, 40);
        unit.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);
        expect(lightningSpinDamagePercent(unit)).toContain("140% damage");
        expect(lightningSpinDamagePercent(unit)).not.toContain("100% damage");

        unit.deleteBuff("Giants Maul");
        unit.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);
        expect(lightningSpinDamagePercent(unit)).toContain("100% damage");
    });

    it("prints the owner's LUCK in the percentage, with the Maul stacking on top of it", () => {
        // This pass is the LAST writer of these cards — the client chains up to it, and in ranked it is the
        // only writer — and it used to print the ability's base power, so Gargantuan's Area Throw read a
        // flat "100%" however lucky the stack was while the shot itself landed 100% + luck.
        const areaThrowPercent = (unit: Unit): string | undefined => {
            const props = unit.getUnitProperties();
            return props.abilities_descriptions[props.abilities.indexOf("Area Throw")];
        };

        const lucky = createTestUnit({
            name: "Thrower",
            team: GREEN,
            attackType: PBTypes.AttackVals.RANGE,
            abilities: ["Area Throw"],
            stackPower: 5,
            luck: 5,
        });
        lucky.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);
        expect(areaThrowPercent(lucky)).toContain("105%");

        giveGiantsMaul(lucky, 40);
        lucky.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);
        expect(areaThrowPercent(lucky)).toContain("147%"); // 105 x 1.4, the order the AOE tail applies them

        // Area Throw is not stack-powered, so a lone survivor still throws the full percentage + luck.
        const alone = createTestUnit({
            name: "Last Thrower",
            team: GREEN,
            attackType: PBTypes.AttackVals.RANGE,
            abilities: ["Area Throw"],
            stackPower: 1,
            luck: 5,
        });
        alone.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);
        expect(areaThrowPercent(alone)).toContain("105%");
    });
});
