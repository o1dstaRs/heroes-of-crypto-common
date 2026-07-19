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

import { getSpellConfig } from "../../src/configuration/config_provider";
import { HITS_PER_MOUNTAIN, MORALE_CHANGE_FOR_KILL } from "../../src/constants";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getPositionForCell } from "../../src/grid/grid_math";
import { MoveHandler } from "../../src/handlers/move_handler";
import { AttackTarget } from "../../src/handlers/attack_handler";
import { Spell } from "../../src/spells/spell";
import {
    createCombatTestContext,
    createTestUnit,
    createVisibleDamage,
    placeUnit,
    testGridSettings,
} from "../helpers/combat";

describe("AttackHandler", () => {
    describe("public helpers", () => {
        it("exposes attack targets and damage statistic holder", () => {
            const { attackHandler, damageStatisticHolder } = createCombatTestContext();
            const target = new AttackTarget({ x: 1, y: 2 }, 1);

            expect(attackHandler.getDamageStatisticHolder()).toBe(damageStatisticHolder);
            expect(target.getPosition()).toEqual({ x: 1, y: 2 });
            expect(target.getRenderPosition()).toEqual({ x: 1, y: 2 });
            expect(target.isSmallSize()).toBe(true);

            target.setRenderPosition(3, 4);
            damageStatisticHolder.add({
                unitName: "Target",
                damage: 5,
                team: PBTypes.TeamVals.LOWER,
                lap: 2,
            });

            expect(target.getRenderPosition()).toEqual({ x: 3, y: 4 });
            expect(damageStatisticHolder.has(2)).toBe(true);
            expect(damageStatisticHolder.has(3)).toBe(false);
        });

        it("calculates range divisors and evaluates affected range targets", () => {
            const { grid, unitsHolder, attackHandler } = createCombatTestContext();
            const attacker = createTestUnit({
                team: PBTypes.TeamVals.UPPER,
                attackType: PBTypes.AttackVals.RANGE,
                rangeShots: 3,
                shotDistance: 2,
            });
            const target = createTestUnit({ team: PBTypes.TeamVals.LOWER });

            placeUnit(grid, unitsHolder, attacker, { x: 1, y: 1 });
            placeUnit(grid, unitsHolder, target, { x: 8, y: 1 });

            expect(attackHandler.getRangeAttackDivisor(attacker, target.getPosition())).toBeGreaterThan(1);
            expect(attackHandler.canLandRangeAttack(attacker, grid.getEnemyAggrMatrixByUnitId(attacker.getId()))).toBe(
                true,
            );
            expect(
                attackHandler.canBeAttackedByMelee(
                    attacker.getPosition(),
                    attacker.isSmallSize(),
                    grid.getEnemyAggrMatrixByUnitId(attacker.getId()),
                ),
            ).toBe(false);

            const evaluation = attackHandler.evaluateRangeAttack(
                unitsHolder.getAllUnits(),
                attacker,
                attacker.getPosition(),
                target.getPosition(),
            );

            expect(evaluation.rangeAttackDivisors.length).toBeGreaterThan(0);
            expect(evaluation.affectedUnits.flat()).toContain(target);
            expect(evaluation.affectedCells.length).toBeGreaterThan(0);
        });
    });

    describe("handleMagicAttack", () => {
        it("returns incomplete for missing spell context and hidden enemy targets", () => {
            const { grid, unitsHolder, attackHandler } = createCombatTestContext();
            const caster = createTestUnit({
                team: PBTypes.TeamVals.UPPER,
                spells: ["Death:Weakness"],
            });
            const target = createTestUnit({
                team: PBTypes.TeamVals.LOWER,
            });

            placeUnit(grid, unitsHolder, caster, { x: 1, y: 1 });
            placeUnit(grid, unitsHolder, target, { x: 8, y: 1 });
            target.applyBuff(
                new Spell({
                    spellProperties: getSpellConfig("System", "Hidden"),
                    amount: 1,
                }),
            );

            expect(attackHandler.handleMagicAttack(grid.getMatrix(), unitsHolder).completed).toBe(false);
            expect(
                attackHandler.handleMagicAttack(grid.getMatrix(), unitsHolder, caster.getSpells()[0], caster, target)
                    .completed,
            ).toBe(false);
        });

        it("heals damaged allies and consumes the spell", () => {
            const { grid, unitsHolder, attackHandler } = createCombatTestContext();
            const caster = createTestUnit({
                team: PBTypes.TeamVals.UPPER,
                spells: ["Life:Heal"],
                amountAlive: 2,
            });
            const target = createTestUnit({
                team: PBTypes.TeamVals.UPPER,
                maxHp: 20,
                amountAlive: 1,
            });

            placeUnit(grid, unitsHolder, caster, { x: 1, y: 1 });
            placeUnit(grid, unitsHolder, target, { x: 2, y: 1 });
            target.applyDamage(8, 0, attackHandler.sceneLog);

            const result = attackHandler.handleMagicAttack(
                grid.getMatrix(),
                unitsHolder,
                caster.getSpells()[0],
                caster,
                target,
            );

            expect(result.completed).toBe(true);
            expect(target.getHp()).toBeGreaterThan(12);
            expect(caster.hasSpellRemaining("Heal")).toBe(false);
        });

        it("applies common enemy debuffs", () => {
            const { grid, unitsHolder, attackHandler } = createCombatTestContext();
            const caster = createTestUnit({
                team: PBTypes.TeamVals.UPPER,
                spells: ["Death:Weakness"],
            });
            const target = createTestUnit({
                team: PBTypes.TeamVals.LOWER,
                magicResist: 0,
            });

            placeUnit(grid, unitsHolder, caster, { x: 1, y: 1 });
            placeUnit(grid, unitsHolder, target, { x: 8, y: 1 });

            const result = attackHandler.handleMagicAttack(
                grid.getMatrix(),
                unitsHolder,
                caster.getSpells()[0],
                caster,
                target,
            );

            expect(result.completed).toBe(true);
            expect(target.hasDebuffActive("Weakness")).toBe(true);
            expect(caster.hasSpellRemaining("Weakness")).toBe(false);
        });

        it("applies ally buffs and caster self-debuffs", () => {
            const { grid, unitsHolder, attackHandler } = createCombatTestContext();
            const caster = createTestUnit({
                name: "Helping Caster",
                team: PBTypes.TeamVals.UPPER,
                spells: ["Life:Helping Hand"],
                stackPower: 4,
            });
            const target = createTestUnit({
                name: "Helping Target",
                team: PBTypes.TeamVals.UPPER,
                stackPower: 4,
            });

            placeUnit(grid, unitsHolder, caster, { x: 1, y: 1 });
            placeUnit(grid, unitsHolder, target, { x: 2, y: 1 });

            const result = attackHandler.handleMagicAttack(
                grid.getMatrix(),
                unitsHolder,
                caster.getSpells()[0],
                caster,
                target,
            );

            expect(result.completed).toBe(true);
            expect(target.hasBuffActive("Helping Hand")).toBe(true);
            expect(caster.hasDebuffActive("Helping Hand")).toBe(true);
        });

        it("swaps positions for Castling", () => {
            const { grid, unitsHolder, attackHandler } = createCombatTestContext();
            const caster = createTestUnit({
                team: PBTypes.TeamVals.UPPER,
                spells: ["System:Castling"],
                stackPower: 4,
            });
            const target = createTestUnit({
                team: PBTypes.TeamVals.LOWER,
                stackPower: 4,
            });

            placeUnit(grid, unitsHolder, caster, { x: 1, y: 1 });
            placeUnit(grid, unitsHolder, target, { x: 2, y: 1 });

            const casterStart = structuredClone(caster.getPosition());
            const targetStart = structuredClone(target.getPosition());
            const result = attackHandler.handleMagicAttack(
                grid.getMatrix(),
                unitsHolder,
                caster.getSpells()[0],
                caster,
                target,
                [target.getBaseCell()],
            );

            expect(result.completed).toBe(true);
            expect(caster.getPosition()).toEqual(targetStart);
            expect(target.getPosition()).toEqual(casterStart);
            expect(result.animationData).toHaveLength(2);
        });
    });

    describe("handleRangeAttack", () => {
        it("a kill grants the attacker +MORALE_CHANGE_FOR_KILL and drops the fallen stack's same-type allies", () => {
            const { grid, unitsHolder, attackHandler } = createCombatTestContext();

            // One-shot the whole target stack (single 1-HP Peasant) with an overwhelming ranged hit.
            const attacker = createTestUnit({
                name: "Arbalester",
                team: PBTypes.TeamVals.UPPER,
                attackType: PBTypes.AttackVals.RANGE,
                attack: 100,
                damageMin: 100,
                damageMax: 100,
                rangeShots: 3,
                amountAlive: 1,
                morale: 0,
            });
            const target = createTestUnit({
                name: "Peasant",
                team: PBTypes.TeamVals.LOWER,
                armor: 1,
                amountAlive: 1,
                maxHp: 1,
                morale: 0,
            });
            // Another Peasant stack on the target's team, off to the side (same name + team → loses morale).
            const targetAlly = createTestUnit({
                name: "Peasant",
                team: PBTypes.TeamVals.LOWER,
                amountAlive: 1,
                morale: 10,
            });

            placeUnit(grid, unitsHolder, attacker, { x: 1, y: 1 });
            placeUnit(grid, unitsHolder, target, { x: 8, y: 1 });
            placeUnit(grid, unitsHolder, targetAlly, { x: 6, y: 6 });

            const attackerMoraleBefore = attacker.getMorale();
            const allyMoraleBefore = targetAlly.getMorale();

            const result = attackHandler.handleRangeAttack(
                unitsHolder,
                [1],
                1,
                createVisibleDamage(target),
                attacker,
                [[target]],
                undefined,
                target.getPosition(),
            );

            // Kill morale is written to BASE morale; the turn flow surfaces it to effective morale on the
            // next adjustBaseStats pass (which drives the lap-start Morale roll). Mirror that here.
            attacker.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);
            targetAlly.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);

            expect(result.completed).toBe(true);
            expect(target.isDead()).toBe(true);
            // Killer gains morale; the fallen stack's surviving same-type ally loses it.
            expect(attacker.getMorale()).toBe(attackerMoraleBefore + MORALE_CHANGE_FOR_KILL);
            expect(targetAlly.getMorale()).toBe(allyMoraleBefore - MORALE_CHANGE_FOR_KILL);
        });

        it("applies direct range attack damage once while recording animation and statistics", () => {
            const { grid, unitsHolder, attackHandler, damageStatisticHolder } = createCombatTestContext();

            const attacker = createTestUnit({
                name: "Range Attacker",
                team: PBTypes.TeamVals.UPPER,
                attackType: PBTypes.AttackVals.RANGE,
                attack: 10,
                armor: 10,
                damageMin: 10,
                damageMax: 10,
                rangeShots: 3,
                amountAlive: 1,
            });
            const target = createTestUnit({
                name: "Range Target",
                team: PBTypes.TeamVals.LOWER,
                attackType: PBTypes.AttackVals.MELEE,
                attack: 10,
                armor: 10,
                damageMin: 1,
                damageMax: 1,
                rangeShots: 0,
                amountAlive: 3,
            });

            placeUnit(grid, unitsHolder, attacker, { x: 1, y: 1 });
            placeUnit(grid, unitsHolder, target, { x: 8, y: 1 });

            const damageForAnimation = createVisibleDamage(target);

            const result = attackHandler.handleRangeAttack(
                unitsHolder,
                [1],
                1,
                damageForAnimation,
                attacker,
                [[target]],
                undefined,
                target.getPosition(),
            );

            expect(result.completed).toBe(true);
            expect(target.getAmountAlive()).toBe(2);
            expect(target.getAmountDied()).toBe(1);
            expect(target.getHp()).toBe(target.getMaxHp());
            expect(damageForAnimation.render).toBe(true);
            expect(damageForAnimation.hits).toEqual([{ amount: 10, unitsDied: 1 }]);
            expect(damageStatisticHolder.get()).toEqual([
                {
                    unitName: "Range Attacker",
                    damage: 10,
                    team: PBTypes.TeamVals.UPPER,
                    lap: 1,
                },
            ]);
        });

        it("does not land a range attack while the attacker is threatened by melee", () => {
            const { grid, unitsHolder, attackHandler, damageStatisticHolder } = createCombatTestContext();
            const attacker = createTestUnit({
                team: PBTypes.TeamVals.UPPER,
                attackType: PBTypes.AttackVals.RANGE,
                damageMin: 10,
                damageMax: 10,
                rangeShots: 3,
            });
            const adjacentEnemy = createTestUnit({
                team: PBTypes.TeamVals.LOWER,
                attackType: PBTypes.AttackVals.MELEE,
                amountAlive: 3,
            });

            placeUnit(grid, unitsHolder, attacker, { x: 1, y: 1 });
            placeUnit(grid, unitsHolder, adjacentEnemy, { x: 2, y: 1 });

            const damageForAnimation = createVisibleDamage(adjacentEnemy);
            const result = attackHandler.handleRangeAttack(
                unitsHolder,
                [1],
                1,
                damageForAnimation,
                attacker,
                [[adjacentEnemy]],
                undefined,
                adjacentEnemy.getPosition(),
            );

            expect(result.completed).toBe(false);
            expect(adjacentEnemy.getAmountAlive()).toBe(3);
            expect(attacker.getRangeShots()).toBe(3);
            expect(damageForAnimation.render).toBe(false);
            expect(damageStatisticHolder.get()).toEqual([]);
        });

        it("does not attack a different unit while a live forced target exists", () => {
            const { grid, unitsHolder, attackHandler, damageStatisticHolder } = createCombatTestContext();
            const attacker = createTestUnit({
                team: PBTypes.TeamVals.UPPER,
                attackType: PBTypes.AttackVals.RANGE,
                damageMin: 10,
                damageMax: 10,
                rangeShots: 3,
            });
            const selectedTarget = createTestUnit({
                team: PBTypes.TeamVals.LOWER,
                amountAlive: 3,
            });
            const forcedTarget = createTestUnit({
                team: PBTypes.TeamVals.LOWER,
                amountAlive: 3,
            });

            placeUnit(grid, unitsHolder, attacker, { x: 1, y: 1 });
            placeUnit(grid, unitsHolder, selectedTarget, { x: 8, y: 1 });
            placeUnit(grid, unitsHolder, forcedTarget, { x: 8, y: 3 });
            attacker.setTarget(forcedTarget.getId());

            const damageForAnimation = createVisibleDamage(selectedTarget);
            const result = attackHandler.handleRangeAttack(
                unitsHolder,
                [1],
                1,
                damageForAnimation,
                attacker,
                [[selectedTarget]],
                undefined,
                selectedTarget.getPosition(),
            );

            expect(result.completed).toBe(false);
            expect(selectedTarget.getAmountAlive()).toBe(3);
            expect(attacker.getRangeShots()).toBe(3);
            expect(damageStatisticHolder.get()).toEqual([]);
        });

        it("applies ranged response damage and records both damage statistics", () => {
            const { grid, unitsHolder, attackHandler, damageStatisticHolder } = createCombatTestContext();
            const attacker = createTestUnit({
                name: "Attacking Archer",
                team: PBTypes.TeamVals.UPPER,
                attackType: PBTypes.AttackVals.RANGE,
                attack: 10,
                armor: 30,
                damageMin: 10,
                damageMax: 10,
                rangeShots: 3,
                amountAlive: 3,
            });
            const target = createTestUnit({
                name: "Responding Archer",
                team: PBTypes.TeamVals.LOWER,
                attackType: PBTypes.AttackVals.RANGE,
                attack: 10,
                armor: 30,
                damageMin: 10,
                damageMax: 10,
                rangeShots: 2,
                amountAlive: 3,
            });

            placeUnit(grid, unitsHolder, attacker, { x: 1, y: 1 });
            placeUnit(grid, unitsHolder, target, { x: 8, y: 1 });

            const result = attackHandler.handleRangeAttack(
                unitsHolder,
                [1],
                1,
                createVisibleDamage(target),
                attacker,
                [[target]],
                [attacker],
                target.getPosition(),
            );

            expect(result.completed).toBe(true);
            expect(attacker.getAmountAlive()).toBe(2);
            expect(attacker.getAmountDied()).toBe(1);
            expect(target.getAmountAlive()).toBe(2);
            expect(target.getAmountDied()).toBe(1);
            expect(attacker.getRangeShots()).toBe(2);
            expect(target.getRangeShots()).toBe(1);
            expect(damageStatisticHolder.get()).toEqual([
                {
                    unitName: "Responding Archer",
                    damage: 10,
                    team: PBTypes.TeamVals.LOWER,
                    lap: 1,
                },
                {
                    unitName: "Attacking Archer",
                    damage: 10,
                    team: PBTypes.TeamVals.UPPER,
                    lap: 1,
                },
            ]);
        });
    });

    describe("handleMeleeAttack", () => {
        it("applies adjacent melee attack damage and response damage", () => {
            const { grid, unitsHolder, attackHandler, damageStatisticHolder } = createCombatTestContext();
            const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
            const attacker = createTestUnit({
                name: "Melee Attacker",
                team: PBTypes.TeamVals.UPPER,
                attackType: PBTypes.AttackVals.MELEE,
                attack: 10,
                armor: 30,
                damageMin: 10,
                damageMax: 10,
                amountAlive: 3,
            });
            const target = createTestUnit({
                name: "Melee Target",
                team: PBTypes.TeamVals.LOWER,
                attackType: PBTypes.AttackVals.MELEE,
                attack: 10,
                armor: 30,
                damageMin: 10,
                damageMax: 10,
                amountAlive: 3,
            });

            placeUnit(grid, unitsHolder, attacker, { x: 1, y: 1 });
            placeUnit(grid, unitsHolder, target, { x: 2, y: 1 });

            const damageForAnimation = createVisibleDamage(target);
            damageForAnimation.hits = [];

            const result = attackHandler.handleMeleeAttack(
                unitsHolder,
                moveHandler,
                damageForAnimation,
                undefined,
                attacker,
                target,
                { x: 1, y: 1 },
            );

            expect(result.completed).toBe(true);
            expect(target.getAmountAlive()).toBe(2);
            expect(attacker.getAmountAlive()).toBe(2);
            expect(damageForAnimation.render).toBe(true);
            expect(damageForAnimation.hits).toEqual([{ amount: 10, unitsDied: 1 }]);
            expect(damageStatisticHolder.get()).toEqual([
                {
                    unitName: "Melee Target",
                    damage: 10,
                    team: PBTypes.TeamVals.LOWER,
                    lap: 1,
                },
                {
                    unitName: "Melee Attacker",
                    damage: 10,
                    team: PBTypes.TeamVals.UPPER,
                    lap: 1,
                },
            ]);
        });

        it("does not hit a primary Abomination again after Fire Breath absorption kills it", () => {
            const { grid, unitsHolder, attackHandler, damageStatisticHolder } = createCombatTestContext();
            const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
            const attacker = createTestUnit({
                name: "Fire Breather",
                team: PBTypes.TeamVals.UPPER,
                attackType: PBTypes.AttackVals.MELEE,
                abilities: ["Fire Breath"],
            });
            const abomination = createTestUnit({
                name: "Abomination",
                team: PBTypes.TeamVals.LOWER,
                maxHp: 50,
                armor: 20,
                luck: 10,
                stackPower: 5,
                abilities: ["Flesh Shield Aura"],
                auraEffects: ["Flesh Shield"],
                auraRanges: [1],
                auraIsBuff: [true],
            });
            const protectedAlly = createTestUnit({
                name: "Protected Rear Unit",
                team: PBTypes.TeamVals.LOWER,
                maxHp: 1000,
                armor: 20,
            });
            attacker.calculateMissChance = () => 0;
            attacker.calculateAttackDamage = () => 100;

            placeUnit(grid, unitsHolder, attacker, { x: 1, y: 1 });
            placeUnit(grid, unitsHolder, abomination, { x: 2, y: 1 });
            placeUnit(grid, unitsHolder, protectedAlly, { x: 3, y: 1 });
            unitsHolder.refreshAuraEffectsForAllUnits();

            const damageForAnimation = createVisibleDamage(abomination);
            damageForAnimation.hits = [];
            const result = attackHandler.handleMeleeAttack(
                unitsHolder,
                moveHandler,
                damageForAnimation,
                undefined,
                attacker,
                abomination,
                { x: 1, y: 1 },
            );

            expect(result.completed).toBe(true);
            expect(abomination.getAmountAlive()).toBe(0);
            expect(abomination.getAmountDied()).toBe(1);
            expect(protectedAlly.getCumulativeHp()).toBe(950);
            expect(damageForAnimation.hits).toEqual([]);
            expect(result.unitIdsDied.filter((unitId) => unitId === abomination.getId())).toHaveLength(1);
            expect(damageForAnimation.secondary).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        source: "flesh_shield",
                        unitId: abomination.getId(),
                        amount: 50,
                    }),
                    expect.objectContaining({
                        source: "fire_breath",
                        unitId: protectedAlly.getId(),
                        amount: 50,
                    }),
                ]),
            );
            expect(damageStatisticHolder.get().reduce((total, entry) => total + entry.damage, 0)).toBe(100);
        });

        it("does not apply a base response after response Fire Breath absorption kills the attacker", () => {
            const { grid, unitsHolder, attackHandler, damageStatisticHolder } = createCombatTestContext();
            const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
            const abomination = createTestUnit({
                name: "Abomination",
                team: PBTypes.TeamVals.UPPER,
                maxHp: 50,
                armor: 20,
                luck: 10,
                stackPower: 5,
                abilities: ["Flesh Shield Aura"],
                auraEffects: ["Flesh Shield"],
                auraRanges: [1],
                auraIsBuff: [true],
            });
            const protectedAlly = createTestUnit({
                name: "Protected Rear Unit",
                team: PBTypes.TeamVals.UPPER,
                maxHp: 1000,
                armor: 20,
            });
            const responder = createTestUnit({
                name: "Responding Fire Breather",
                team: PBTypes.TeamVals.LOWER,
                maxHp: 1000,
                armor: 20,
                attackType: PBTypes.AttackVals.MELEE,
                abilities: ["Fire Breath"],
            });
            abomination.calculateMissChance = () => 0;
            abomination.calculateAttackDamage = () => 10;
            responder.calculateMissChance = () => 0;
            responder.calculateAttackDamage = () => 100;

            placeUnit(grid, unitsHolder, protectedAlly, { x: 0, y: 1 });
            placeUnit(grid, unitsHolder, abomination, { x: 1, y: 1 });
            placeUnit(grid, unitsHolder, responder, { x: 2, y: 1 });
            unitsHolder.refreshAuraEffectsForAllUnits();

            const damageForAnimation = createVisibleDamage(responder);
            damageForAnimation.hits = [];
            const result = attackHandler.handleMeleeAttack(
                unitsHolder,
                moveHandler,
                damageForAnimation,
                undefined,
                abomination,
                responder,
                { x: 1, y: 1 },
            );

            expect(result.completed).toBe(true);
            expect(abomination.getAmountAlive()).toBe(0);
            expect(abomination.getAmountDied()).toBe(1);
            expect(protectedAlly.getCumulativeHp()).toBe(950);
            expect(responder.getCumulativeHp()).toBe(990);
            expect(damageForAnimation.hits).toEqual([{ amount: 10, unitsDied: 0 }]);
            expect(result.unitIdsDied.filter((unitId) => unitId === abomination.getId())).toHaveLength(1);
            expect(damageStatisticHolder.get().reduce((total, entry) => total + entry.damage, 0)).toBe(110);

            responder.adjustBaseStats(false, 1, 0, 0, 0, 0, 0, 0);
            expect(responder.getMorale()).toBe(MORALE_CHANGE_FOR_KILL);
        });

        it("returns incomplete for invalid melee attack preconditions", () => {
            const { grid, unitsHolder, attackHandler } = createCombatTestContext();
            const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
            const attacker = createTestUnit({
                team: PBTypes.TeamVals.UPPER,
                attackType: PBTypes.AttackVals.RANGE,
                rangeShots: 3,
            });
            const target = createTestUnit({ team: PBTypes.TeamVals.LOWER });

            placeUnit(grid, unitsHolder, attacker, { x: 1, y: 1 });
            placeUnit(grid, unitsHolder, target, { x: 8, y: 1 });

            expect(
                attackHandler.handleMeleeAttack(
                    unitsHolder,
                    moveHandler,
                    createVisibleDamage(target),
                    undefined,
                    attacker,
                    target,
                    { x: 1, y: 1 },
                ).completed,
            ).toBe(false);
        });
    });

    describe("handleObstacleAttack (two 2x2 mountains)", () => {
        // BLOCK_CENTER is two 2x2 mountains: left = rows 5,6 / right = rows 9,10, both on cols 7,8, with a
        // 2x2 walkable corridor (rows 7,8) between them. Each mountain has its own HITS_PER_MOUNTAIN pool.
        const setupMountainFight = () => {
            const ctx = createCombatTestContext(PBTypes.GridVals.BLOCK_CENTER);
            const moveHandler = new MoveHandler(testGridSettings, ctx.grid, ctx.unitsHolder);
            const fightProperties = FightStateManager.getInstance().getFightProperties();
            fightProperties.setGridType(PBTypes.GridVals.BLOCK_CENTER);
            return { ...ctx, moveHandler, fightProperties };
        };
        const leftMountainCell = { x: 6, y: 7 };
        const rightMountainCell = { x: 9, y: 7 };

        it("range attack hits the LEFT mountain and spends only its own hit points", () => {
            const { grid, unitsHolder, attackHandler, moveHandler, fightProperties } = setupMountainFight();
            const attacker = createTestUnit({
                name: "Siege Archer",
                team: PBTypes.TeamVals.UPPER,
                attackType: PBTypes.AttackVals.RANGE,
                rangeShots: 3,
            });
            placeUnit(grid, unitsHolder, attacker, { x: 1, y: 1 });

            const result = attackHandler.handleObstacleAttack(
                positionForCell(leftMountainCell),
                unitsHolder,
                moveHandler,
                attacker,
            );

            expect(result.completed).toBe(true);
            expect(result.animationData).toHaveLength(1);
            expect(attacker.getRangeShots()).toBe(2);
            expect(fightProperties.getObstacleHitsLeftLeft()).toBe(HITS_PER_MOUNTAIN - 1);
            expect(fightProperties.getObstacleHitsLeftRight()).toBe(HITS_PER_MOUNTAIN);
        });

        it("range attack hits the RIGHT mountain and spends only its own hit points", () => {
            const { grid, unitsHolder, attackHandler, moveHandler, fightProperties } = setupMountainFight();
            const attacker = createTestUnit({
                team: PBTypes.TeamVals.UPPER,
                attackType: PBTypes.AttackVals.RANGE,
                rangeShots: 3,
            });
            placeUnit(grid, unitsHolder, attacker, { x: 1, y: 1 });

            const result = attackHandler.handleObstacleAttack(
                positionForCell(rightMountainCell),
                unitsHolder,
                moveHandler,
                attacker,
            );

            expect(result.completed).toBe(true);
            expect(fightProperties.getObstacleHitsLeftRight()).toBe(HITS_PER_MOUNTAIN - 1);
            expect(fightProperties.getObstacleHitsLeftLeft()).toBe(HITS_PER_MOUNTAIN);
        });

        it("small melee unit strikes the left mountain from an outer (non-corridor) cell", () => {
            const { grid, unitsHolder, attackHandler, moveHandler, fightProperties } = setupMountainFight();
            const attacker = createTestUnit({ team: PBTypes.TeamVals.UPPER, attackType: PBTypes.AttackVals.MELEE });
            placeUnit(grid, unitsHolder, attacker, { x: 6, y: 6 }); // col-6 side of the left mountain

            const result = attackHandler.handleObstacleAttack(
                positionForCell(leftMountainCell),
                unitsHolder,
                moveHandler,
                attacker,
                { x: 6, y: 6 },
            );

            expect(result.completed).toBe(true);
            expect(fightProperties.getObstacleHitsLeftLeft()).toBe(HITS_PER_MOUNTAIN - 1);
            expect(fightProperties.getObstacleHitsLeftRight()).toBe(HITS_PER_MOUNTAIN);
        });

        it("small melee unit strikes the LEFT mountain from the corridor between the two mountains", () => {
            const { grid, unitsHolder, attackHandler, moveHandler, fightProperties } = setupMountainFight();
            const attacker = createTestUnit({ team: PBTypes.TeamVals.UPPER, attackType: PBTypes.AttackVals.MELEE });
            placeUnit(grid, unitsHolder, attacker, { x: 7, y: 7 }); // corridor cell, adjacent to left (6,7)

            const result = attackHandler.handleObstacleAttack(
                positionForCell(leftMountainCell),
                unitsHolder,
                moveHandler,
                attacker,
                { x: 7, y: 7 },
            );

            expect(result.completed).toBe(true);
            expect(fightProperties.getObstacleHitsLeftLeft()).toBe(HITS_PER_MOUNTAIN - 1);
            expect(fightProperties.getObstacleHitsLeftRight()).toBe(HITS_PER_MOUNTAIN);
        });

        it("small melee unit strikes the RIGHT mountain from the corridor between the two mountains", () => {
            const { grid, unitsHolder, attackHandler, moveHandler, fightProperties } = setupMountainFight();
            const attacker = createTestUnit({ team: PBTypes.TeamVals.UPPER, attackType: PBTypes.AttackVals.MELEE });
            placeUnit(grid, unitsHolder, attacker, { x: 8, y: 7 }); // corridor cell, adjacent to right (9,7)

            const result = attackHandler.handleObstacleAttack(
                positionForCell(rightMountainCell),
                unitsHolder,
                moveHandler,
                attacker,
                { x: 8, y: 7 },
            );

            expect(result.completed).toBe(true);
            expect(fightProperties.getObstacleHitsLeftRight()).toBe(HITS_PER_MOUNTAIN - 1);
            expect(fightProperties.getObstacleHitsLeftLeft()).toBe(HITS_PER_MOUNTAIN);
        });

        it("small melee unit strikes the left mountain from a DIAGONAL corner cell", () => {
            const { grid, unitsHolder, attackHandler, moveHandler, fightProperties } = setupMountainFight();
            const attacker = createTestUnit({ team: PBTypes.TeamVals.UPPER, attackType: PBTypes.AttackVals.MELEE });
            // (4,6) is diagonally (Chebyshev 1) adjacent to left mountain cell (5,7) — a legal corner strike.
            placeUnit(grid, unitsHolder, attacker, { x: 4, y: 6 });

            const result = attackHandler.handleObstacleAttack(
                positionForCell({ x: 5, y: 7 }),
                unitsHolder,
                moveHandler,
                attacker,
                { x: 4, y: 6 },
            );

            expect(result.completed).toBe(true);
            expect(fightProperties.getObstacleHitsLeftLeft()).toBe(HITS_PER_MOUNTAIN - 1);
            expect(fightProperties.getObstacleHitsLeftRight()).toBe(HITS_PER_MOUNTAIN);
        });

        it("does not land a melee strike from a non-adjacent cell", () => {
            const { grid, unitsHolder, attackHandler, moveHandler, fightProperties } = setupMountainFight();
            const attacker = createTestUnit({ team: PBTypes.TeamVals.UPPER, attackType: PBTypes.AttackVals.MELEE });
            placeUnit(grid, unitsHolder, attacker, { x: 1, y: 1 });

            const result = attackHandler.handleObstacleAttack(
                positionForCell(leftMountainCell),
                unitsHolder,
                moveHandler,
                attacker,
                { x: 1, y: 1 },
            );

            expect(result.completed).toBe(false);
            expect(fightProperties.getObstacleHitsLeft()).toBe(2 * HITS_PER_MOUNTAIN);
        });

        it("large (2x2) melee unit strikes an adjacent mountain", () => {
            const { grid, unitsHolder, attackHandler, moveHandler, fightProperties } = setupMountainFight();
            const attacker = createTestUnit({
                name: "Mountain Breaker",
                team: PBTypes.TeamVals.UPPER,
                attackType: PBTypes.AttackVals.MELEE,
                size: PBTypes.UnitSizeVals.LARGE,
            });
            // 2x2 footprint below the left mountain (cols 5,6 / rows 5,6), adjacent to it, no overlap.
            placeUnit(grid, unitsHolder, attacker, { x: 6, y: 6 });

            const result = attackHandler.handleObstacleAttack(
                positionForCell(leftMountainCell),
                unitsHolder,
                moveHandler,
                attacker,
                { x: 6, y: 6 },
            );

            expect(result.completed).toBe(true);
            expect(fightProperties.getObstacleHitsLeftLeft()).toBe(HITS_PER_MOUNTAIN - 1);
        });

        it("returns incomplete for non-block grids", () => {
            const { grid, unitsHolder, attackHandler } = createCombatTestContext();
            const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
            const attacker = createTestUnit({ team: PBTypes.TeamVals.UPPER });

            placeUnit(grid, unitsHolder, attacker, { x: 1, y: 1 });

            expect(
                attackHandler.handleObstacleAttack(
                    positionForCell({ x: 6, y: 6 }),
                    unitsHolder,
                    moveHandler,
                    attacker,
                    { x: 5, y: 6 },
                ).completed,
            ).toBe(false);
        });
    });
});

function positionForCell(cell: { x: number; y: number }): { x: number; y: number } {
    return getPositionForCell(
        cell,
        testGridSettings.getMinX(),
        testGridSettings.getStep(),
        testGridSettings.getHalfStep(),
    );
}
