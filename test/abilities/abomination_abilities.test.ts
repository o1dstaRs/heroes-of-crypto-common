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
import { processFleshShieldAura } from "../../src/abilities/flesh_shield_aura_ability";
import { processLightningSpinAbility } from "../../src/abilities/lightning_spin_ability";
import { processThroughShotAbility } from "../../src/abilities/through_shot_ability";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { ISecondaryDamage } from "../../src/scene/animations";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

describe("Dense Flesh (ranged attacks cost extra shots)", () => {
    it("consumes two shots when the ranged target has Dense Flesh and one otherwise", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const shooter = createTestUnit({
            team: PBTypes.TeamVals.UPPER,
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 5,
        });
        const abomination = createTestUnit({
            name: "Abomination",
            team: PBTypes.TeamVals.LOWER,
            abilities: ["Dense Flesh"],
        });
        const regularTarget = createTestUnit({ name: "Regular", team: PBTypes.TeamVals.LOWER });
        placeUnit(grid, unitsHolder, shooter, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, abomination, { x: 5, y: 1 });
        placeUnit(grid, unitsHolder, regularTarget, { x: 5, y: 3 });

        shooter.calculateAttackDamage(regularTarget, PBTypes.AttackVals.RANGE, 0);
        expect(shooter.getRangeShots()).toBe(4);

        shooter.calculateAttackDamage(abomination, PBTypes.AttackVals.RANGE, 0);
        expect(shooter.getRangeShots()).toBe(2);
    });

    it("clamps at zero when only one shot remains", () => {
        createCombatTestContext();
        const shooter = createTestUnit({
            team: PBTypes.TeamVals.UPPER,
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 1,
        });
        const abomination = createTestUnit({
            name: "Abomination",
            team: PBTypes.TeamVals.LOWER,
            abilities: ["Dense Flesh"],
        });

        shooter.calculateAttackDamage(abomination, PBTypes.AttackVals.RANGE, 0);
        expect(shooter.getRangeShots()).toBe(0);
    });

    it("does not double-charge when the shot decrement is suppressed (pass-through paths)", () => {
        createCombatTestContext();
        const shooter = createTestUnit({
            team: PBTypes.TeamVals.UPPER,
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 3,
        });
        const abomination = createTestUnit({
            name: "Abomination",
            team: PBTypes.TeamVals.LOWER,
            abilities: ["Dense Flesh"],
        });

        shooter.calculateAttackDamage(abomination, PBTypes.AttackVals.RANGE, 0, 1, 1, false);
        expect(shooter.getRangeShots()).toBe(3);
    });
});

describe("Flesh Shield aura (damage absorption)", () => {
    const setupAuraTrio = (options?: {
        abominationLuck?: number;
        abominationMaxHp?: number;
        abominationStackPower?: number;
        allyArmor?: number;
        abominationArmor?: number;
        allyMagicResist?: number;
        abominationMagicResist?: number;
    }) => {
        const context = createCombatTestContext();
        const abomination = createTestUnit({
            name: "Abomination",
            team: PBTypes.TeamVals.LOWER,
            maxHp: options?.abominationMaxHp ?? 200,
            armor: options?.abominationArmor ?? 20,
            magicResist: options?.abominationMagicResist ?? 0,
            luck: options?.abominationLuck ?? 0,
            stackPower: options?.abominationStackPower ?? 5,
            abilities: ["Flesh Shield Aura"],
            auraEffects: ["Flesh Shield"],
            auraRanges: [1],
            auraIsBuff: [true],
        });
        const ally = createTestUnit({
            name: "Protected Ally",
            team: PBTypes.TeamVals.LOWER,
            maxHp: 100,
            armor: options?.allyArmor ?? 20,
            magicResist: options?.allyMagicResist ?? 0,
        });
        const attacker = createTestUnit({
            name: "Enemy",
            team: PBTypes.TeamVals.UPPER,
            maxHp: 100,
        });
        placeUnit(context.grid, context.unitsHolder, abomination, { x: 2, y: 2 });
        placeUnit(context.grid, context.unitsHolder, ally, { x: 3, y: 2 });
        placeUnit(context.grid, context.unitsHolder, attacker, { x: 5, y: 2 });
        context.unitsHolder.refreshAuraEffectsForAllUnits();
        return { ...context, abomination, ally, attacker };
    };

    it("applies the aura buff to the adjacent ally with the base 90% power", () => {
        const { ally, abomination } = setupAuraTrio();
        expect(ally.hasBuffActive("Flesh Shield Aura")).toBe(true);
        expect(ally.getBuff("Flesh Shield Aura")?.getPower()).toBe(90);
        expect(abomination.hasBuffActive("Flesh Shield Aura")).toBe(true);
    });

    it("scales the absorb percentage with the owner's stack power", () => {
        const low = setupAuraTrio({ abominationStackPower: 1 });
        expect(low.ally.getBuff("Flesh Shield Aura")?.getPower()).toBe(18);

        const middle = setupAuraTrio({ abominationStackPower: 3 });
        expect(middle.ally.getBuff("Flesh Shield Aura")?.getPower()).toBe(54);

        const full = setupAuraTrio({ abominationStackPower: 5 });
        expect(full.ally.getBuff("Flesh Shield Aura")?.getPower()).toBe(90);
    });

    it("shifts the absorb percentage by the owner's luck, capped to [0, 100]", () => {
        const positive = setupAuraTrio({ abominationLuck: 10 });
        expect(positive.ally.getBuff("Flesh Shield Aura")?.getPower()).toBe(100);

        const negative = setupAuraTrio({ abominationLuck: -10 });
        expect(negative.ally.getBuff("Flesh Shield Aura")?.getPower()).toBe(80);
    });

    it("redirects 90% of the damage to the aura owner and leaves the remainder on the ally", () => {
        const { grid, unitsHolder, damageStatisticHolder, abomination, ally, attacker } = setupAuraTrio();
        const secondary: ISecondaryDamage[] = [];
        const sceneLog = new SceneLogMock();

        const result = processFleshShieldAura(
            attacker,
            ally,
            100,
            false,
            grid,
            unitsHolder,
            sceneLog,
            damageStatisticHolder,
            secondary,
        );

        expect(result.remainingDamage).toBe(10);
        // equal armors: the absorbed 90 re-lands on the owner unchanged
        expect(result.absorbedDamage).toBe(90);
        expect(abomination.getHp()).toBe(110);
        expect(secondary).toHaveLength(1);
        expect(secondary[0]).toMatchObject({ source: "flesh_shield", unitId: abomination.getId(), amount: 90 });
        expect(result.unitIdsDied).toEqual([]);
    });

    it("recalculates the absorbed damage against the owner's higher armor", () => {
        const { grid, unitsHolder, damageStatisticHolder, abomination, ally, attacker } = setupAuraTrio({
            allyArmor: 20,
            abominationArmor: 40,
        });
        const result = processFleshShieldAura(
            attacker,
            ally,
            100,
            false,
            grid,
            unitsHolder,
            new SceneLogMock(),
            damageStatisticHolder,
        );

        expect(result.remainingDamage).toBe(10);
        // 90 absorbed, rescaled by armor ratio 20/40 -> 45
        expect(result.absorbedDamage).toBe(45);
        expect(abomination.getHp()).toBe(155);
    });

    it("recalculates magical AOE absorption through the owner's magic resistance", () => {
        const { grid, unitsHolder, damageStatisticHolder, abomination, ally, attacker } = setupAuraTrio({
            abominationLuck: 10,
            allyMagicResist: 0,
            abominationMagicResist: 50,
        });
        const result = processFleshShieldAura(
            attacker,
            ally,
            100,
            false,
            grid,
            unitsHolder,
            new SceneLogMock(),
            damageStatisticHolder,
            undefined,
            "magic",
        );

        expect(result.remainingDamage).toBe(0);
        expect(result.absorbedDamage).toBe(50);
        expect(abomination.getHp()).toBe(150);
    });

    it("does not absorb its own damage or trigger for units outside the aura", () => {
        const { grid, unitsHolder, damageStatisticHolder, abomination, attacker } = setupAuraTrio();
        const selfResult = processFleshShieldAura(
            attacker,
            abomination,
            100,
            false,
            grid,
            unitsHolder,
            new SceneLogMock(),
            damageStatisticHolder,
        );
        expect(selfResult.remainingDamage).toBe(100);
        expect(selfResult.absorbedDamage).toBe(0);

        const farAlly = createTestUnit({ name: "Far Ally", team: PBTypes.TeamVals.LOWER, maxHp: 100 });
        placeUnit(grid, unitsHolder, farAlly, { x: 7, y: 7 });
        unitsHolder.refreshAuraEffectsForAllUnits();
        const farResult = processFleshShieldAura(
            attacker,
            farAlly,
            100,
            false,
            grid,
            unitsHolder,
            new SceneLogMock(),
            damageStatisticHolder,
        );
        expect(farResult.remainingDamage).toBe(100);
        expect(farResult.absorbedDamage).toBe(0);
    });

    it("returns lethal overflow to the protected unit instead of losing damage", () => {
        const { grid, unitsHolder, damageStatisticHolder, abomination, ally, attacker } = setupAuraTrio();
        abomination.applyDamage(150, 0, new SceneLogMock());
        expect(abomination.getHp()).toBe(50);

        const result = processFleshShieldAura(
            attacker,
            ally,
            100,
            false,
            grid,
            unitsHolder,
            new SceneLogMock(),
            damageStatisticHolder,
        );

        expect(result.remainingDamage).toBe(50);
        expect(result.absorbedDamage).toBe(50);
        expect(abomination.isDead()).toBe(true);
        expect(result.unitIdsDied).toEqual([abomination.getId()]);
    });

    it("converts limited owner HP through the defense ratio before returning overflow", () => {
        const { grid, unitsHolder, damageStatisticHolder, abomination, ally, attacker } = setupAuraTrio({
            abominationMaxHp: 50,
            allyArmor: 40,
            abominationArmor: 20,
        });

        const result = processFleshShieldAura(
            attacker,
            ally,
            100,
            false,
            grid,
            unitsHolder,
            new SceneLogMock(),
            damageStatisticHolder,
        );

        // The owner's lower armor doubles redirected damage: 25 target-space damage consumes all 50 HP.
        expect(result.absorbedDamage).toBe(50);
        expect(result.remainingDamage).toBe(75);
        expect(abomination.isDead()).toBe(true);
    });

    it("returns the exact rounding overflow at the Abomination's default 44 armor", () => {
        const { grid, unitsHolder, damageStatisticHolder, abomination, ally, attacker } = setupAuraTrio({
            abominationMaxHp: 40,
            allyArmor: 20,
            abominationArmor: 44,
        });

        const result = processFleshShieldAura(
            attacker,
            ally,
            100,
            false,
            grid,
            unitsHolder,
            new SceneLogMock(),
            damageStatisticHolder,
        );

        // Redirecting all 90 would ceil to 41 owner damage; 88 is the largest share that costs exactly 40.
        expect(result.absorbedDamage).toBe(40);
        expect(result.remainingDamage).toBe(12);
        expect(abomination.isDead()).toBe(true);
    });

    it("aggregates one AOE transfer and returns damage beyond the owner's 500 HP", () => {
        const { grid, unitsHolder, damageStatisticHolder, abomination, ally, attacker } = setupAuraTrio({
            abominationLuck: 10,
            abominationMaxHp: 500,
        });
        const secondAlly = createTestUnit({
            name: "Second Protected Ally",
            team: PBTypes.TeamVals.LOWER,
            maxHp: 1000,
            armor: 20,
        });
        placeUnit(grid, unitsHolder, secondAlly, { x: 2, y: 3 });
        unitsHolder.refreshAuraEffectsForAllUnits();

        const secondary: ISecondaryDamage[] = [];
        const first = processFleshShieldAura(
            attacker,
            ally,
            285,
            false,
            grid,
            unitsHolder,
            new SceneLogMock(),
            damageStatisticHolder,
            secondary,
        );
        const firstDamage = ally.applyDamage(first.remainingDamage, 0, new SceneLogMock());
        const second = processFleshShieldAura(
            attacker,
            secondAlly,
            285,
            false,
            grid,
            unitsHolder,
            new SceneLogMock(),
            damageStatisticHolder,
            secondary,
        );
        const secondDamage = secondAlly.applyDamage(second.remainingDamage, 0, new SceneLogMock());

        expect(first.remainingDamage).toBe(0);
        expect(second.remainingDamage).toBe(70);
        expect(firstDamage + secondDamage).toBe(70);
        expect(abomination.isDead()).toBe(true);
        expect(secondary).toEqual([
            expect.objectContaining({
                source: "flesh_shield",
                unitId: abomination.getId(),
                amount: 500,
                unitsDied: 1,
            }),
        ]);
        expect((secondary[0]?.amount ?? 0) + firstDamage + secondDamage).toBe(570);
    });

    it("preserves all damage through the real range-AOE processor and emits one owner event", () => {
        const { grid, unitsHolder, damageStatisticHolder } = createCombatTestContext();
        const abomination = createTestUnit({
            name: "Abomination",
            team: PBTypes.TeamVals.LOWER,
            maxHp: 500,
            armor: 20,
            luck: 10,
            stackPower: 5,
            abilities: ["Flesh Shield Aura"],
            auraEffects: ["Flesh Shield"],
            auraRanges: [1],
            auraIsBuff: [true],
        });
        const firstAlly = createTestUnit({
            name: "First Protected Ally",
            team: PBTypes.TeamVals.LOWER,
            maxHp: 1000,
            armor: 20,
        });
        const secondAlly = createTestUnit({
            name: "Second Protected Ally",
            team: PBTypes.TeamVals.LOWER,
            maxHp: 1000,
            armor: 20,
        });
        const attacker = createTestUnit({
            name: "AOE Attacker",
            team: PBTypes.TeamVals.UPPER,
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 2,
            abilities: ["Area Throw"],
        });
        attacker.calculateMissChance = () => 0;
        attacker.calculateAttackDamage = (target) => (target.getId() === firstAlly.getId() ? 300 : 270);

        placeUnit(grid, unitsHolder, abomination, { x: 2, y: 2 });
        placeUnit(grid, unitsHolder, firstAlly, { x: 3, y: 2 });
        placeUnit(grid, unitsHolder, secondAlly, { x: 2, y: 3 });
        placeUnit(grid, unitsHolder, attacker, { x: 7, y: 7 });
        unitsHolder.refreshAuraEffectsForAllUnits();

        const secondary: ISecondaryDamage[] = [];
        const result = processRangeAOEAbility(
            attacker,
            [firstAlly, secondAlly],
            attacker,
            1,
            unitsHolder,
            grid,
            new SceneLogMock(),
            damageStatisticHolder,
            true,
            secondary,
        );

        expect(result.landed).toBe(true);
        expect(result.perUnitDamage.map((entry) => entry.amount)).toEqual([0, 70]);
        expect(abomination.isDead()).toBe(true);
        expect(result.unitIdsDied.filter((unitId) => unitId === abomination.getId())).toHaveLength(1);
        expect(secondary).toEqual([
            expect.objectContaining({
                source: "flesh_shield",
                unitId: abomination.getId(),
                amount: 500,
                unitsDied: 1,
            }),
        ]);
        expect(damageStatisticHolder.get().reduce((total, entry) => total + entry.damage, 0)).toBe(570);
    });

    it("reserves an Abomination's own simultaneous splash hit before it absorbs for allies", () => {
        const { grid, unitsHolder, damageStatisticHolder } = createCombatTestContext();
        const abomination = createTestUnit({
            name: "Abomination",
            team: PBTypes.TeamVals.LOWER,
            maxHp: 500,
            armor: 20,
            luck: 10,
            stackPower: 5,
            abilities: ["Flesh Shield Aura"],
            auraEffects: ["Flesh Shield"],
            auraRanges: [1],
            auraIsBuff: [true],
        });
        const firstAlly = createTestUnit({
            name: "First Protected Ally",
            team: PBTypes.TeamVals.LOWER,
            maxHp: 1000,
            armor: 20,
        });
        const secondAlly = createTestUnit({
            name: "Second Protected Ally",
            team: PBTypes.TeamVals.LOWER,
            maxHp: 1000,
            armor: 20,
        });
        const attacker = createTestUnit({
            name: "AOE Attacker",
            team: PBTypes.TeamVals.UPPER,
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 2,
            abilities: ["Area Throw"],
        });
        attacker.calculateMissChance = () => 0;
        attacker.calculateAttackDamage = (target) => {
            if (target.getId() === firstAlly.getId()) return 300;
            if (target.getId() === secondAlly.getId()) return 270;
            return 100;
        };

        placeUnit(grid, unitsHolder, abomination, { x: 2, y: 2 });
        placeUnit(grid, unitsHolder, firstAlly, { x: 3, y: 2 });
        placeUnit(grid, unitsHolder, secondAlly, { x: 2, y: 3 });
        placeUnit(grid, unitsHolder, attacker, { x: 7, y: 7 });
        unitsHolder.refreshAuraEffectsForAllUnits();

        const secondary: ISecondaryDamage[] = [];
        // Deliberately supply allies first. Simultaneous range splash must still reserve the owner's own
        // 100-point hit before deciding how much of the allies' 570 points can be redirected.
        const result = processRangeAOEAbility(
            attacker,
            [firstAlly, secondAlly, abomination],
            attacker,
            1,
            unitsHolder,
            grid,
            new SceneLogMock(),
            damageStatisticHolder,
            true,
            secondary,
        );

        expect(result.perUnitDamage.map(({ unitId, amount }) => ({ unitId, amount }))).toEqual([
            { unitId: abomination.getId(), amount: 100 },
            { unitId: firstAlly.getId(), amount: 0 },
            { unitId: secondAlly.getId(), amount: 170 },
        ]);
        expect(result.unitIdsDied.filter((unitId) => unitId === abomination.getId())).toHaveLength(1);
        expect(secondary).toEqual([
            expect.objectContaining({
                source: "flesh_shield",
                unitId: abomination.getId(),
                amount: 400,
                unitsDied: 1,
            }),
        ]);
        expect(damageStatisticHolder.get().reduce((total, entry) => total + entry.damage, 0)).toBe(670);
    });

    it("reserves an Abomination's own Lightning Spin hit before it absorbs for adjacent allies", () => {
        const { grid, unitsHolder, damageStatisticHolder } = createCombatTestContext();
        const abomination = createTestUnit({
            name: "Abomination",
            team: PBTypes.TeamVals.LOWER,
            maxHp: 500,
            armor: 20,
            luck: 10,
            stackPower: 5,
            abilities: ["Flesh Shield Aura"],
            auraEffects: ["Flesh Shield"],
            auraRanges: [1],
            auraIsBuff: [true],
        });
        const firstAlly = createTestUnit({
            name: "First Protected Ally",
            team: PBTypes.TeamVals.LOWER,
            maxHp: 1000,
            armor: 20,
        });
        const secondAlly = createTestUnit({
            name: "Second Protected Ally",
            team: PBTypes.TeamVals.LOWER,
            maxHp: 1000,
            armor: 20,
        });
        const attacker = createTestUnit({
            name: "Spin Attacker",
            team: PBTypes.TeamVals.UPPER,
            abilities: ["Lightning Spin"],
        });
        attacker.calculateMissChance = () => 0;
        attacker.calculateAttackDamage = (target) => {
            if (target.getId() === firstAlly.getId()) return 300;
            if (target.getId() === secondAlly.getId()) return 270;
            return 100;
        };

        placeUnit(grid, unitsHolder, firstAlly, { x: 3, y: 4 });
        placeUnit(grid, unitsHolder, secondAlly, { x: 4, y: 3 });
        placeUnit(grid, unitsHolder, abomination, { x: 3, y: 3 });
        placeUnit(grid, unitsHolder, attacker, { x: 4, y: 4 });
        unitsHolder.refreshAuraEffectsForAllUnits();
        // Force the pre-fix allies-first neighbour order; the processor must stable-partition the owner first.
        unitsHolder.allEnemiesAroundUnit = () => [firstAlly, secondAlly, abomination];

        const secondary: ISecondaryDamage[] = [];
        const result = processLightningSpinAbility(
            attacker,
            new SceneLogMock(),
            unitsHolder,
            1,
            damageStatisticHolder,
            attacker.getBaseCell(),
            true,
            secondary,
            grid,
        );

        expect(result.landed).toBe(true);
        expect(result.unitIdsDied.filter((unitId) => unitId === abomination.getId())).toHaveLength(1);
        expect(secondary).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    source: "flesh_shield",
                    unitId: abomination.getId(),
                    amount: 400,
                    unitsDied: 1,
                }),
                expect.objectContaining({
                    source: "lightning_spin",
                    unitId: abomination.getId(),
                    amount: 100,
                }),
                expect.objectContaining({
                    source: "lightning_spin",
                    unitId: secondAlly.getId(),
                    amount: 170,
                }),
            ]),
        );
        expect(damageStatisticHolder.get().reduce((total, entry) => total + entry.damage, 0)).toBe(670);
    });

    it("does not hit an Abomination again after an earlier Through Shot target kills it via absorption", () => {
        const { grid, unitsHolder, damageStatisticHolder } = createCombatTestContext();
        const abomination = createTestUnit({
            name: "Abomination",
            team: PBTypes.TeamVals.LOWER,
            maxHp: 100,
            armor: 20,
            luck: 10,
            stackPower: 5,
            abilities: ["Flesh Shield Aura"],
            auraEffects: ["Flesh Shield"],
            auraRanges: [1],
            auraIsBuff: [true],
        });
        const protectedAlly = createTestUnit({
            name: "Protected Front Unit",
            team: PBTypes.TeamVals.LOWER,
            maxHp: 1000,
            armor: 20,
        });
        const attacker = createTestUnit({
            name: "Through Shooter",
            team: PBTypes.TeamVals.UPPER,
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 2,
            abilities: ["Through Shot"],
        });
        attacker.calculateMissChance = () => 0;
        let damageCalculations = 0;
        attacker.calculateAttackDamage = () => {
            damageCalculations++;
            return 150;
        };

        placeUnit(grid, unitsHolder, protectedAlly, { x: 2, y: 2 });
        placeUnit(grid, unitsHolder, abomination, { x: 3, y: 2 });
        placeUnit(grid, unitsHolder, attacker, { x: 7, y: 2 });
        unitsHolder.refreshAuraEffectsForAllUnits();

        const secondary: ISecondaryDamage[] = [];
        const result = processThroughShotAbility(
            attacker,
            [[protectedAlly], [abomination]],
            attacker,
            [1, 1],
            protectedAlly.getPosition(),
            unitsHolder,
            grid,
            new SceneLogMock(),
            damageStatisticHolder,
            true,
            secondary,
        );

        expect(result.landed).toBe(true);
        expect(damageCalculations).toBe(1);
        expect(result.perUnitDamage).toEqual([expect.objectContaining({ unitId: protectedAlly.getId(), amount: 50 })]);
        expect(result.unitIdsDied.filter((unitId) => unitId === abomination.getId())).toHaveLength(1);
        expect(secondary).toEqual([
            expect.objectContaining({
                source: "flesh_shield",
                unitId: abomination.getId(),
                amount: 100,
                unitsDied: 1,
            }),
        ]);
        expect(damageStatisticHolder.get().reduce((total, entry) => total + entry.damage, 0)).toBe(150);
    });
});
