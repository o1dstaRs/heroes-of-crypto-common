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

import { AbilityFactory } from "../../src/abilities/ability_factory";
import { getSpellConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getPositionForCell } from "../../src/grid/grid_math";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Spell } from "../../src/spells/spell";
import { createTestUnit, testGridSettings } from "../helpers/combat";

describe("Unit", () => {
    describe("state and metadata", () => {
        it("exposes metadata, target, position, and stack bounds", () => {
            const unit = createTestUnit({
                name: "Stats Unit",
                team: PBTypes.TeamVals.LOWER,
                attackType: PBTypes.AttackVals.RANGE,
                attack: 12,
                armor: 7,
                damageMin: 2,
                damageMax: 5,
                rangeShots: 2,
                shotDistance: 4,
                magicResist: 6,
                morale: 3,
                luck: 4,
                speed: 8,
                exp: 9,
                movementType: PBTypes.MovementVals.FLY,
                level: PBTypes.UnitLevelVals.SECOND,
                unitType: PBTypes.UnitVals.HERO,
            });

            unit.setTarget("enemy-id");
            unit.setPosition(positionForCell({ x: 3, y: 4 }).x, positionForCell({ x: 3, y: 4 }).y);
            unit.setRenderPosition(11, 12);

            expect(unit.getTarget()).toBe("enemy-id");
            unit.resetTarget();
            expect(unit.getTarget()).toBe("");
            expect(unit.getFaction()).toBe(PBTypes.FactionVals.MIGHT);
            expect(unit.getName()).toBe("Stats Unit");
            expect(unit.getSteps()).toBe(3);
            expect(unit.getMorale()).toBe(3);
            expect(unit.getLuck()).toBe(4);
            expect(unit.getSpeed()).toBe(8);
            expect(unit.getBaseArmor()).toBe(7);
            expect(unit.getRangeArmor()).toBe(7);
            expect(unit.getBaseAttack()).toBe(12);
            expect(unit.getAttack()).toBe(12);
            expect(unit.getAttackDamageMin()).toBe(2);
            expect(unit.getAttackDamageMax()).toBe(5);
            expect(unit.getAttackRange()).toBe(1);
            expect(unit.getRangeShots()).toBe(2);
            expect(unit.getRangeShotDistance()).toBe(4);
            unit.setRangeShotDistance(7);
            expect(unit.getRangeShotDistance()).toBe(7);
            expect(unit.getMagicResist()).toBe(6);
            expect(unit.getCanCastSpells()).toBe(false);
            expect(unit.getMovementType()).toBe(PBTypes.MovementVals.FLY);
            expect(unit.canFly()).toBe(true);
            expect(unit.getExp()).toBe(9);
            expect(unit.getTeam()).toBe(PBTypes.TeamVals.LOWER);
            expect(unit.getOppositeTeam()).toBe(PBTypes.TeamVals.UPPER);
            expect(unit.getUnitType()).toBe(PBTypes.UnitVals.HERO);
            expect(unit.getSmallTextureName()).toBe("");
            expect(unit.getLargeTextureName()).toBe("");
            expect(unit.getAuraRanges()).toEqual([]);
            expect(unit.getAuraIsBuff()).toEqual([]);
            expect(unit.getBaseCell()).toEqual({ x: 3, y: 4 });
            expect(unit.getCenter()).toEqual(unit.getPosition());
            expect(unit.getCells()).toEqual([{ x: 3, y: 4 }]);
            expect(unit.getSize()).toBe(PBTypes.UnitSizeVals.SMALL);
            expect(unit.isSmallSize()).toBe(true);
            expect(unit.isSummoned()).toBe(false);
            expect(unit.getLevel()).toBe(PBTypes.UnitLevelVals.SECOND);

            unit.setStackPower(100);
            expect(unit.getStackPower()).toBe(5);
            unit.setStackPower(-1);
            expect(unit.getStackPower()).toBe(1);

            const noTeamUnit = createTestUnit({ team: PBTypes.TeamVals.NO_TEAM });
            expect(noTeamUnit.getOppositeTeam()).toBe(PBTypes.TeamVals.NO_TEAM);
        });

        it("handles large-unit center and cells", () => {
            const unit = createTestUnit({ size: PBTypes.UnitSizeVals.LARGE });

            unit.setPosition(positionForCell({ x: 3, y: 3 }).x, positionForCell({ x: 3, y: 3 }).y);

            expect(unit.isSmallSize()).toBe(false);
            expect(unit.getCenter()).toEqual({
                x: unit.getPosition().x + testGridSettings.getHalfStep(),
                y: unit.getPosition().y + testGridSettings.getHalfStep(),
            });
            expect(unit.getCells()).toHaveLength(4);
        });
    });

    describe("effects, buffs, and debuffs", () => {
        it("applies, ages, and deletes effects", () => {
            const effectFactory = new EffectFactory();
            const unit = createTestUnit({ abilities: ["Dodge"] });
            const stun = effectFactory.makeEffect("Stun")!;
            const breakEffect = effectFactory.makeEffect("Break")!;

            expect(unit.applyEffect(stun)).toBe(true);
            expect(unit.getEffect("Stun")).toBeDefined();
            expect(unit.hasEffectActive("Stun")).toBe(true);
            expect(unit.isSkippingThisTurn()).toBe(true);
            expect(unit.canRespond(PBTypes.AttackVals.MELEE)).toBe(false);

            unit.minusLap();

            expect(unit.hasEffectActive("Stun")).toBe(false);

            unit.applyEffect(breakEffect);

            expect(unit.hasAbilityActive("Dodge")).toBe(false);
            expect(unit.getAbility("Dodge")).toBeUndefined();
            expect(unit.getAbilities()).toEqual([]);
            expect(unit.getAuraEffects()).toEqual([]);
            expect(unit.getAbilityPower("Dodge")).toBe(0);
            expect(unit.getSpellsCount()).toBe(0);

            unit.deleteAllEffects();

            expect(unit.getEffects()).toEqual([]);
        });

        it("applies and clears buffs, debuffs, and aura effects", () => {
            const unit = createTestUnit();
            const blessing = spell("Life", "Blessing");
            const weakness = spell("Death", "Weakness");

            unit.applyBuff(blessing, 7, 9, true);
            unit.applyDebuff(weakness, 3, 4, true);
            unit.applyAuraEffect("Pegasus Might Aura", "power", true, 5, "1;2");
            unit.applyAuraEffect("Range Null Field Aura", "power", false, 6, "3;4");

            expect(unit.hasBuffActive("Blessing")).toBe(true);
            expect(unit.hasDebuffActive("Weakness")).toBe(true);
            expect(unit.getBuffProperties("Blessing")).toEqual(["7", "9"]);
            expect(unit.getAppliedAuraEffect("Pegasus Might Aura")?.getPower()).toBe(5);
            expect(unit.hasBuffActive("Pegasus Might Aura")).toBe(true);
            expect(unit.hasDebuffActive("Range Null Field Aura")).toBe(true);

            unit.cleanAuraEffects();

            expect(unit.hasBuffActive("Pegasus Might Aura")).toBe(false);
            expect(unit.hasDebuffActive("Range Null Field Aura")).toBe(false);

            unit.deleteBuff("Blessing");
            unit.deleteDebuff("Weakness");

            expect(unit.hasBuffActive("Blessing")).toBe(false);
            expect(unit.hasDebuffActive("Weakness")).toBe(false);

            unit.applyBuff(spell("Chaos", "Riot"));
            unit.applyDebuff(spell("Order", "Cowardice"));
            unit.deleteAllBuffs();
            unit.deleteAllDebuffs();

            expect(unit.getBuffs()).toEqual([]);
            expect(unit.getDebuffs()).toEqual([]);
        });

        it("refreshes regeneration and spell-cast state before turns", () => {
            const unit = createTestUnit({
                abilities: ["Wild Regeneration"],
                spells: ["Life:Heal"],
                amountAlive: 1,
                maxHp: 20,
            });

            unit.applyDamage(7, 0, new SceneLogMock());
            unit.refreshPreTurnState(new SceneLogMock());

            expect(unit.getHp()).toBe(20);
            expect(unit.getCanCastSpells()).toBe(true);
        });
    });

    describe("applyDamage", () => {
        it("subtracts partial damage from the current stack member", () => {
            const unit = createTestUnit({ amountAlive: 3, maxHp: 10 });

            const damageDealt = unit.applyDamage(4, 0, new SceneLogMock());

            expect(damageDealt).toBe(4);
            expect(unit.getAmountAlive()).toBe(3);
            expect(unit.getAmountDied()).toBe(0);
            expect(unit.getHp()).toBe(6);
            expect(unit.isDead()).toBe(false);
        });

        it("kills exactly one stack member on exact current HP damage", () => {
            const unit = createTestUnit({ amountAlive: 3, maxHp: 10 });

            const damageDealt = unit.applyDamage(10, 0, new SceneLogMock());

            expect(damageDealt).toBe(10);
            expect(unit.getAmountAlive()).toBe(2);
            expect(unit.getAmountDied()).toBe(1);
            expect(unit.getHp()).toBe(10);
            expect(unit.isDead()).toBe(false);
        });

        it("carries excess damage onto the next stack member", () => {
            const unit = createTestUnit({ amountAlive: 3, maxHp: 10 });

            const damageDealt = unit.applyDamage(15, 0, new SceneLogMock());

            expect(damageDealt).toBe(15);
            expect(unit.getAmountAlive()).toBe(2);
            expect(unit.getAmountDied()).toBe(1);
            expect(unit.getHp()).toBe(5);
            expect(unit.isDead()).toBe(false);
        });

        it("caps overkill damage at the remaining cumulative HP", () => {
            const unit = createTestUnit({ amountAlive: 2, maxHp: 10 });

            const damageDealt = unit.applyDamage(25, 0, new SceneLogMock());

            expect(damageDealt).toBe(20);
            expect(unit.getAmountAlive()).toBe(0);
            expect(unit.getAmountDied()).toBe(2);
            expect(unit.isDead()).toBe(true);
        });
    });

    describe("healing, resurrection, and base stat changes", () => {
        it("heals, resurrects, and caps amount changes", () => {
            const unit = createTestUnit({ amountAlive: 3, maxHp: 10 });

            unit.applyDamage(15, 0, new SceneLogMock());

            expect(unit.applyHeal(-1)).toBe(0);
            expect(unit.applyHeal(3.8)).toBe(3);
            expect(unit.getHp()).toBe(8);
            expect(unit.applyResurrection(12)).toBe(1);
            expect(unit.getAmountAlive()).toBe(3);
            expect(unit.getAmountDied()).toBe(0);

            unit.setAmountAlive(0);
            expect(unit.getAmountAlive()).toBe(3);
            unit.setAmountAlive(5.8);
            expect(unit.getAmountAlive()).toBe(5);
            unit.increaseSupply(20);
            expect(unit.getAmountAlive()).toBe(6);
        });

        it("adjusts morale, armor, attack modifiers, and armageddon damage", () => {
            const unit = createTestUnit({
                amountAlive: 10,
                maxHp: 10,
                morale: 1,
                armor: 10,
                attack: 10,
            });

            unit.increaseAttackMod(2.345);
            expect(unit.getCurrentAttackModIncrease()).toBe(2.345);
            expect(unit.getAttack()).toBe(12.35);
            unit.cleanupAttackModIncrease();
            expect(unit.getCurrentAttackModIncrease()).toBe(2.345);
            expect(unit.getAttack()).toBeCloseTo(10);

            unit.increaseMorale(4, 1);
            unit.decreaseMorale(2, 1);
            unit.decreaseBaseArmor(20);
            unit.increaseBaseArmor(4);
            unit.reduceBaseAttack(3);
            unit.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);

            expect(unit.getBaseArmor()).toBe(5);
            expect(unit.getBaseAttack()).toBe(7);

            unit.applyArmageddonDamage(0, new SceneLogMock());
            expect(unit.getAmountAlive()).toBe(10);
            unit.applyArmageddonDamage(1, new SceneLogMock());
            expect(unit.getAmountAlive()).toBeLessThan(10);
        });
    });

    describe("luck", () => {
        it("drops the random per-turn spread before the fight starts (placement shows default luck)", () => {
            const unit = createTestUnit({ luck: 4 });

            // Simulate in-fight lap rolls until a non-zero spread is present, so the assertion below
            // is meaningful (the roll range includes 0).
            let guard = 0;
            do {
                unit.randomizeLuckPerTurn();
                guard += 1;
            } while (unit.getLuck() === 4 && guard < 50);
            expect(unit.getLuck()).not.toBe(4);

            // Placement / pre-fight refresh (hasFightStarted = false) must clear the random spread
            // and show only the unit's default luck.
            unit.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);
            expect(unit.getLuck()).toBe(4);

            // Once the fight starts, the per-lap randomness applies again.
            unit.adjustBaseStats(true, 1, 0, 0, 0, 0, 0);
            expect(Math.abs(unit.getLuck() - 4)).toBeLessThanOrEqual(3);
        });
    });

    describe("calculateAttackDamage", () => {
        it("calculates deterministic range damage and consumes one shot", () => {
            const attacker = createTestUnit({
                attackType: PBTypes.AttackVals.RANGE,
                attack: 10,
                damageMin: 10,
                damageMax: 10,
                rangeShots: 2,
            });
            const target = createTestUnit({
                team: PBTypes.TeamVals.LOWER,
                armor: 10,
            });

            const damage = attacker.calculateAttackDamage(target, PBTypes.AttackVals.RANGE, 0);

            expect(damage).toBe(10);
            expect(attacker.getRangeShots()).toBe(1);
        });

        it("returns zero range damage when no shots remain", () => {
            const attacker = createTestUnit({
                attackType: PBTypes.AttackVals.RANGE,
                attack: 10,
                damageMin: 10,
                damageMax: 10,
                rangeShots: 0,
            });
            const target = createTestUnit({
                team: PBTypes.TeamVals.LOWER,
                armor: 10,
            });

            const damage = attacker.calculateAttackDamage(target, PBTypes.AttackVals.RANGE, 0);

            expect(damage).toBe(0);
            expect(attacker.getRangeShots()).toBe(0);
        });

        it("halves melee damage for ranged units without Handyman", () => {
            const attacker = createTestUnit({
                attackType: PBTypes.AttackVals.RANGE,
                attack: 10,
                damageMin: 10,
                damageMax: 10,
                rangeShots: 2,
            });
            const target = createTestUnit({
                team: PBTypes.TeamVals.LOWER,
                armor: 10,
            });

            const damage = attacker.calculateAttackDamage(target, PBTypes.AttackVals.MELEE, 0);

            expect(damage).toBe(5);
            expect(attacker.getRangeShots()).toBe(2);
        });
    });

    describe("abilities and combat calculations", () => {
        it("adds dynamic abilities and exposes cloned properties and loss estimates", () => {
            const effectFactory = new EffectFactory();
            const abilityFactory = new AbilityFactory(effectFactory);
            const unit = createTestUnit({ amountAlive: 3, maxHp: 10 });

            expect(unit.calculatePossibleLosses(4)).toBe(0);
            expect(unit.calculatePossibleLosses(10)).toBe(1);
            expect(unit.calculatePossibleLosses(35)).toBe(3);

            const properties = unit.getAllProperties();
            properties.hp = 999;

            expect(unit.getHp()).not.toBe(999);

            unit.addAbility(abilityFactory.makeAbility("Chain Lightning"));
            unit.addAbility(abilityFactory.makeAbility("Paralysis"));
            unit.addAbility(abilityFactory.makeAbility("Dodge"));

            expect(unit.hasAbilityActive("Chain Lightning")).toBe(true);
            expect(unit.hasAbilityActive("Paralysis")).toBe(true);
            expect(unit.hasAbilityActive("Dodge")).toBe(true);
        });

        it("calculates ability, aura, effect, and miss values", () => {
            const effectFactory = new EffectFactory();
            const attacker = createTestUnit({
                abilities: ["Crusade", "Dodge", "Magic Shield", "Made of Fire"],
                luck: 5,
                stackPower: 5,
            });
            const enemy = createTestUnit({
                team: PBTypes.TeamVals.LOWER,
                abilities: ["Dodge"],
                stackPower: 5,
            });
            const crusade = attacker.getAbility("Crusade");
            const magicShield = attacker.getAbility("Magic Shield");
            const dodge = attacker.getAbility("Dodge");
            const aura = effectFactory.makeAuraEffect("War Anger")!;
            const pegasusLight = effectFactory.makeEffect("Pegasus Light")!;

            attacker.applyLavaWaterModifier(true, false);

            expect(attacker.hasBuffActive("Made of Fire")).toBe(true);
            expect(crusade && attacker.calculateAbilityCount(crusade, 0)).toBeGreaterThan(0);
            expect(magicShield && attacker.calculateAbilityMultiplier(magicShield, 0)).toBeGreaterThan(0);
            expect(dodge && attacker.calculateAbilityApplyChance(dodge, 0)).toBeGreaterThan(0);
            expect(attacker.calculateAuraPower(aura, 0)).toBeGreaterThanOrEqual(0);
            expect(attacker.calculateEffectMultiplier(pegasusLight, 0)).toBeGreaterThan(0);
            expect(attacker.calculateMissChance(enemy, 0)).toBeGreaterThan(0);

            attacker.applyTravelledDistanceModifier(3, 0);
            attacker.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);

            expect(attacker.getBaseAttack()).toBeGreaterThan(10);
            expect(attacker.hasMindAttackResistance()).toBe(false);
            expect(attacker.canBeHealed()).toBe(true);

            const mechanism = createTestUnit({ abilities: ["Mechanism"] });

            expect(mechanism.hasMindAttackResistance()).toBe(true);
            expect(mechanism.canBeHealed()).toBe(false);
        });

        it("tracks response ability restrictions and attack type selection", () => {
            const ranged = createTestUnit({
                attackType: PBTypes.AttackVals.RANGE,
                rangeShots: 2,
                spells: ["Life:Heal"],
                abilities: ["Through Shot"],
            });
            const noMelee = createTestUnit({
                attackType: PBTypes.AttackVals.RANGE,
                rangeShots: 2,
                abilities: ["No Melee"],
            });

            expect(ranged.canSkipResponse()).toBe(false);
            expect(ranged.canRespond(PBTypes.AttackVals.RANGE)).toBe(false);
            expect(ranged.refreshPossibleAttackTypes(true)).toBe(false);
            expect(ranged.getPossibleAttackTypes()).toEqual([
                PBTypes.AttackVals.RANGE,
                PBTypes.AttackVals.MELEE,
                PBTypes.AttackVals.MAGIC,
            ]);
            expect(ranged.getAttackTypeSelectionIndex()).toEqual([0, 3]);
            expect(ranged.selectAttackType(PBTypes.AttackVals.MAGIC)).toBe(true);
            expect(ranged.getAttackTypeSelection()).toBe(PBTypes.AttackVals.MAGIC);
            expect(ranged.selectAttackType(PBTypes.AttackVals.RANGE)).toBe(true);
            expect(ranged.selectNextAttackType()).toBe(true);
            expect(ranged.getAttackTypeSelection()).toBe(PBTypes.AttackVals.MELEE);
            ranged.setOnHourglass(true);
            expect(ranged.isOnHourglass()).toBe(true);
            ranged.setResponded(true);

            noMelee.refreshPossibleAttackTypes(true);

            expect(noMelee.getPossibleAttackTypes()).toEqual([PBTypes.AttackVals.RANGE]);
            expect(noMelee.selectAttackType(PBTypes.AttackVals.MELEE)).toBe(false);
        });

        it("finds melee attack targets for mobile and immobilized units", () => {
            const attacker = createTestUnit();
            const enemy = createTestUnit({ team: PBTypes.TeamVals.LOWER });
            const positions = new Map([[enemy.getId(), positionForCell({ x: 2, y: 1 })]]);

            attacker.setPosition(positionForCell({ x: 1, y: 1 }).x, positionForCell({ x: 1, y: 1 }).y);
            enemy.setPosition(positionForCell({ x: 2, y: 1 }).x, positionForCell({ x: 2, y: 1 }).y);

            const mobileTargets = attacker.attackMeleeAllowed([enemy], positions, [enemy], [{ x: 1, y: 1 }]);

            expect(mobileTargets.unitIds.has(enemy.getId())).toBe(true);
            expect(mobileTargets.attackCells).toContainEqual({ x: 1, y: 1 });

            attacker.applyEffect(new EffectFactory().makeEffect("Paralysis")!);

            const immobilizedTargets = attacker.attackMeleeAllowed([enemy], positions, [enemy]);

            expect(immobilizedTargets.unitIds.has(enemy.getId())).toBe(true);
            expect(immobilizedTargets.attackCells.length).toBeGreaterThan(0);
        });
    });
});

function spell(faction: string, name: string): Spell {
    return new Spell({
        spellProperties: getSpellConfig(faction, name),
        amount: 1,
    });
}

function positionForCell(cell: { x: number; y: number }): { x: number; y: number } {
    return getPositionForCell(
        cell,
        testGridSettings.getMinX(),
        testGridSettings.getStep(),
        testGridSettings.getHalfStep(),
    );
}
