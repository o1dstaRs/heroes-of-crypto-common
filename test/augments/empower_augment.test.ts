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

import {
    ArmorAugment,
    empowerMultiplier,
    EmpowerAugment,
    getEmpowerPower,
    MightAugment,
    MovementAugment,
    PlacementAugment,
    SniperAugment,
    ToEmpowerAugment,
} from "../../src/augments/augment_properties";
import { MAX_UNIT_STACK_POWER } from "../../src/constants";
import { FightProperties } from "../../src/fights/fight_properties";
import { Doctrine } from "../../src/doctrines/doctrine_properties";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { DefaultPlacementLevel1 } from "../../src/augments/augment_properties";
import { fireWallBurnDamage, fireWallBurnPercentage, FIRE_WALL_BURN_PERCENTAGE } from "../../src/spells/fire_walls";
import {
    calculateStackPoweredSpellDamage,
    fireforgedSwordPower,
    getEmpowerPercentage,
} from "../../src/spells/spell_damage";

describe("Empower augment — power table", () => {
    it("is worth 7 / 15 / 24 percent, and nothing when unbought", () => {
        expect(getEmpowerPower(EmpowerAugment.NO_AUGMENT)).toBe(0);
        expect(getEmpowerPower(EmpowerAugment.LEVEL_1)).toBe(7);
        expect(getEmpowerPower(EmpowerAugment.LEVEL_2)).toBe(15);
        expect(getEmpowerPower(EmpowerAugment.LEVEL_3)).toBe(24);
    });

    it("rises with every level, so a costlier pick is never a worse one", () => {
        const ladder = [
            getEmpowerPower(EmpowerAugment.NO_AUGMENT),
            getEmpowerPower(EmpowerAugment.LEVEL_1),
            getEmpowerPower(EmpowerAugment.LEVEL_2),
            getEmpowerPower(EmpowerAugment.LEVEL_3),
        ];
        for (let i = 1; i < ladder.length; i++) {
            expect(ladder[i]).toBeGreaterThan(ladder[i - 1]!);
        }
    });

    it("rejects a level that does not exist rather than silently buffing nothing", () => {
        expect(() => getEmpowerPower(99 as EmpowerAugment)).toThrow();
    });

    it("parses the wire/string form the pickers hand back", () => {
        expect(ToEmpowerAugment[""]).toBe(EmpowerAugment.NO_AUGMENT);
        expect(ToEmpowerAugment["0"]).toBe(EmpowerAugment.NO_AUGMENT);
        expect(ToEmpowerAugment["1"]).toBe(EmpowerAugment.LEVEL_1);
        expect(ToEmpowerAugment["2"]).toBe(EmpowerAugment.LEVEL_2);
        expect(ToEmpowerAugment["3"]).toBe(EmpowerAugment.LEVEL_3);
    });

    it("turns a percentage into a multiplier, and degrades to 1 rather than NaN", () => {
        expect(empowerMultiplier(0)).toBe(1);
        expect(empowerMultiplier(7)).toBeCloseTo(1.07, 10);
        expect(empowerMultiplier(24)).toBeCloseTo(1.24, 10);
        expect(empowerMultiplier(Number.NaN)).toBe(1);
        expect(empowerMultiplier(-5)).toBe(1);
    });
});

describe("Empower augment — fight properties", () => {
    // Spymaster grants 5 upgrade points — enough to show Empower both fitting and running the team out.
    const seedTeam = (doctrine: Doctrine = Doctrine.SEE_ALL) => {
        const fightProperties = new FightProperties();
        fightProperties.setDoctrinePerTeam(PBTypes.TeamVals.LOWER, doctrine);
        fightProperties.setDefaultPlacementPerTeam(PBTypes.TeamVals.LOWER, DefaultPlacementLevel1.THREE_BY_THREE);
        return fightProperties;
    };

    it("defaults to NO_AUGMENT and stores what a team buys", () => {
        const fightProperties = seedTeam();
        expect(fightProperties.getAugmentEmpower(PBTypes.TeamVals.LOWER)).toBe(EmpowerAugment.NO_AUGMENT);

        expect(
            fightProperties.setAugmentPerTeam(PBTypes.TeamVals.LOWER, {
                type: "Empower",
                value: EmpowerAugment.LEVEL_2,
            }),
        ).toBe(true);
        expect(fightProperties.getAugmentEmpower(PBTypes.TeamVals.LOWER)).toBe(EmpowerAugment.LEVEL_2);
    });

    it("spends from the same upgrade budget as every other augment", () => {
        const fightProperties = seedTeam();
        // 3 of the 5 points go to Empower, 2 to Might — that fits...
        expect(
            fightProperties.setAugmentPerTeam(PBTypes.TeamVals.LOWER, {
                type: "Empower",
                value: EmpowerAugment.LEVEL_3,
            }),
        ).toBe(true);
        expect(
            fightProperties.setAugmentPerTeam(PBTypes.TeamVals.LOWER, { type: "Might", value: MightAugment.LEVEL_2 }),
        ).toBe(true);
        // ...and there is nothing left over for armour.
        expect(
            fightProperties.setAugmentPerTeam(PBTypes.TeamVals.LOWER, { type: "Armor", value: ArmorAugment.LEVEL_1 }),
        ).toBe(false);
        expect(fightProperties.getAugmentArmor(PBTypes.TeamVals.LOWER)).toBe(ArmorAugment.NO_AUGMENT);
    });

    it("is counted when another augment checks what is left", () => {
        const fightProperties = seedTeam();
        expect(
            fightProperties.setAugmentPerTeam(PBTypes.TeamVals.LOWER, {
                type: "Empower",
                value: EmpowerAugment.LEVEL_3,
            }),
        ).toBe(true);
        // 3 spent of 5: another 2 fit, a third does not.
        expect(fightProperties.canAugment(PBTypes.TeamVals.LOWER, { type: "Armor", value: ArmorAugment.LEVEL_2 })).toBe(
            true,
        );
        expect(fightProperties.canAugment(PBTypes.TeamVals.LOWER, { type: "Armor", value: ArmorAugment.LEVEL_3 })).toBe(
            false,
        );
        expect(
            fightProperties.canAugment(PBTypes.TeamVals.LOWER, { type: "Sniper", value: SniperAugment.LEVEL_3 }),
        ).toBe(false);
        expect(
            fightProperties.canAugment(PBTypes.TeamVals.LOWER, { type: "Movement", value: MovementAugment.LEVEL_2 }),
        ).toBe(true);
        expect(
            fightProperties.canAugment(PBTypes.TeamVals.LOWER, { type: "Placement", value: PlacementAugment.LEVEL_1 }),
        ).toBe(true);
    });
});

describe("Empower augment — magic damage routing", () => {
    it("leaves every damage figure alone when the team did not buy it", () => {
        expect(calculateStackPoweredSpellDamage(0.8, 38, 5, 0)).toBe(calculateStackPoweredSpellDamage(0.8, 38, 5));
        expect(fireWallBurnPercentage(0)).toBe(FIRE_WALL_BURN_PERCENTAGE);
        expect(fireforgedSwordPower(10, 0)).toBe(10);
    });

    it("raises stack-powered spell damage by exactly the augment's percentage", () => {
        // Fire Strike at a full 38-strong stack: 38 x 5 x 0.8 = 152 base.
        expect(calculateStackPoweredSpellDamage(0.8, 38, MAX_UNIT_STACK_POWER)).toBe(152);
        expect(calculateStackPoweredSpellDamage(0.8, 38, MAX_UNIT_STACK_POWER, 7)).toBe(162); // floor(152 * 1.07)
        expect(calculateStackPoweredSpellDamage(0.8, 38, MAX_UNIT_STACK_POWER, 15)).toBe(174); // floor(152 * 1.15)
        expect(calculateStackPoweredSpellDamage(0.8, 38, MAX_UNIT_STACK_POWER, 24)).toBe(188); // floor(152 * 1.24)
    });

    it("keeps a dead or powerless stack at zero however Empowered the team is", () => {
        expect(calculateStackPoweredSpellDamage(0.8, 0, MAX_UNIT_STACK_POWER, 24)).toBe(0);
        expect(calculateStackPoweredSpellDamage(0.8, 38, 0, 24)).toBe(0);
    });

    it("burns a hotter Fire Wall, and the wall remembers the heat it was lit with", () => {
        expect(fireWallBurnPercentage(7)).toBe(26.8); // 25 * 1.07 = 26.75, one decimal
        expect(fireWallBurnPercentage(15)).toBe(28.8);
        expect(fireWallBurnPercentage(24)).toBe(31);
        // A 1000-hp stack walking into a Level 3 wall.
        expect(fireWallBurnDamage(1000)).toBe(250);
        expect(fireWallBurnDamage(1000, fireWallBurnPercentage(24))).toBe(310);
        // A malformed share falls back to the base rather than dealing nothing.
        expect(fireWallBurnDamage(1000, 0)).toBe(250);
        expect(fireWallBurnDamage(1000, Number.NaN)).toBe(250);
    });

    it("sharpens a Fireforged Sword's burning edge", () => {
        expect(fireforgedSwordPower(10, 7)).toBe(10.7);
        expect(fireforgedSwordPower(10, 15)).toBe(11.5);
        expect(fireforgedSwordPower(10, 24)).toBe(12.4);
    });

    it("reads the percentage off the buff the augment puts on the caster", () => {
        expect(getEmpowerPercentage(undefined)).toBe(0);
        expect(getEmpowerPercentage({ getBuff: () => undefined })).toBe(0);
        expect(getEmpowerPercentage({ getBuff: () => ({ getPower: () => 15 }) })).toBe(15);
        // A buff carrying a broken power must not poison the damage with NaN.
        expect(getEmpowerPercentage({ getBuff: () => ({ getPower: () => Number.NaN }) })).toBe(0);
    });
});
