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

import { ArtifactTier, Tier2Artifact } from "../../src/artifacts/artifact_properties";
import { getSpellConfig } from "../../src/configuration/config_provider";
import { HITS_PER_MOUNTAIN, MORALE_CHANGE_FOR_KILL } from "../../src/constants";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getPositionForCell } from "../../src/grid/grid_math";
import { MoveHandler } from "../../src/handlers/move_handler";
import { AttackTarget } from "../../src/handlers/attack_handler";
import { Spell } from "../../src/spells/spell";
import { fireforgedSwordDamage } from "../../src/spells/spell_damage";
import { setDeterministicRandomSource } from "../../src/utils/lib";
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
                team: PBTypes.TeamVals.LEFT,
                lap: 2,
            });

            expect(target.getRenderPosition()).toEqual({ x: 3, y: 4 });
            expect(damageStatisticHolder.has(2)).toBe(true);
            expect(damageStatisticHolder.has(3)).toBe(false);
        });

        it("floors the shot distance and halves damage per SQUARE band of whole cells", () => {
            const { attackHandler } = createCombatTestContext();
            const attacker = createTestUnit({
                attackType: PBTypes.AttackVals.RANGE,
                rangeShots: 3,
                // Fractional on purpose: the unit card and the left sidebar keep showing 2.9, the board
                // floors it to a 2-cell square.
                shotDistance: 2.9,
            });
            const center = (cell: { x: number; y: number }) =>
                getPositionForCell(
                    cell,
                    testGridSettings.getMinX(),
                    testGridSettings.getStep(),
                    testGridSettings.getHalfStep(),
                );
            const origin = center({ x: 4, y: 4 });
            attacker.setPosition(origin.x, origin.y);
            const divisorAt = (x: number, y: number) => attackHandler.getRangeAttackDivisor(attacker, center({ x, y }));

            // Full 1/1 everywhere inside the 2-cell square, diagonal corners included — those corners are
            // exactly what the old circular falloff cut off.
            expect(divisorAt(6, 4)).toBe(1);
            expect(divisorAt(6, 6)).toBe(1);
            expect(divisorAt(2, 2)).toBe(1);
            // The very next ring out halves, in every direction alike.
            expect(divisorAt(7, 4)).toBe(2);
            expect(divisorAt(7, 7)).toBe(2);
            expect(divisorAt(4, 7)).toBe(2);
            // Successive square bands: 3..4 cells -> 1/2, 5..6 -> 1/4, 7..8 -> 1/8, then capped.
            expect(divisorAt(8, 4)).toBe(2);
            expect(divisorAt(9, 4)).toBe(4);
            expect(divisorAt(10, 10)).toBe(4);
            expect(divisorAt(11, 4)).toBe(8);
            expect(divisorAt(12, 12)).toBe(8);
            expect(divisorAt(15, 15)).toBe(8);

            // An explicit origin re-measures the same square from somewhere else on the board.
            expect(
                attackHandler.getRangeAttackDivisor(attacker, center({ x: 15, y: 15 }), center({ x: 14, y: 14 })),
            ).toBe(1);

            const sniper = createTestUnit({
                attackType: PBTypes.AttackVals.RANGE,
                rangeShots: 3,
                shotDistance: 2.9,
                abilities: ["Sniper"],
            });
            sniper.setPosition(origin.x, origin.y);
            expect(attackHandler.getRangeAttackDivisor(sniper, center({ x: 15, y: 15 }))).toBe(1);
        });

        it("measures a large attacker's square from its footprint, not from its center", () => {
            const { attackHandler } = createCombatTestContext();
            const attacker = createTestUnit({
                attackType: PBTypes.AttackVals.RANGE,
                rangeShots: 3,
                shotDistance: 2,
                size: 2,
            });
            const center = (cell: { x: number; y: number }) =>
                getPositionForCell(
                    cell,
                    testGridSettings.getMinX(),
                    testGridSettings.getStep(),
                    testGridSettings.getHalfStep(),
                );
            // A 2x2 covering cells (4,4)..(5,5) sits on their shared intersection, so a raw
            // center-to-center measurement would put every target half a cell too far.
            const footprintCenter = center({ x: 4.5, y: 4.5 });
            attacker.setPosition(footprintCenter.x, footprintCenter.y);

            // Occupied cells are distance 0; the square then reaches two whole cells past the footprint.
            expect(attackHandler.getRangeAttackDivisor(attacker, center({ x: 4, y: 4 }))).toBe(1);
            expect(attackHandler.getRangeAttackDivisor(attacker, center({ x: 7, y: 7 }))).toBe(1);
            expect(attackHandler.getRangeAttackDivisor(attacker, center({ x: 2, y: 2 }))).toBe(1);
            expect(attackHandler.getRangeAttackDivisor(attacker, center({ x: 8, y: 8 }))).toBe(2);
            expect(attackHandler.getRangeAttackDivisor(attacker, center({ x: 1, y: 4 }))).toBe(2);
        });

        it("evaluates hypothetical shots with the supplied origin's falloff", () => {
            const { grid, unitsHolder, attackHandler } = createCombatTestContext();
            const attacker = createTestUnit({
                team: PBTypes.TeamVals.RIGHT,
                attackType: PBTypes.AttackVals.RANGE,
                rangeShots: 3,
                shotDistance: 2,
            });
            const target = createTestUnit({ team: PBTypes.TeamVals.LEFT });

            placeUnit(grid, unitsHolder, attacker, { x: 1, y: 1 });
            placeUnit(grid, unitsHolder, target, { x: 8, y: 1 });
            const hypotheticalOrigin = getPositionForCell(
                { x: 7, y: 1 },
                testGridSettings.getMinX(),
                testGridSettings.getStep(),
                testGridSettings.getHalfStep(),
            );

            expect(attackHandler.getRangeAttackDivisor(attacker, target.getPosition())).toBe(8);
            expect(attackHandler.getRangeAttackDivisor(attacker, target.getPosition(), hypotheticalOrigin)).toBe(1);

            const evaluation = attackHandler.evaluateRangeAttack(
                unitsHolder.getAllUnits(),
                attacker,
                hypotheticalOrigin,
                target.getPosition(),
            );

            expect(evaluation.affectedUnits[0]?.[0]).toBe(target);
            expect(evaluation.rangeAttackDivisors).toEqual([1]);
        });

        it("calculates range divisors and evaluates affected range targets", () => {
            const { grid, unitsHolder, attackHandler } = createCombatTestContext();
            const attacker = createTestUnit({
                team: PBTypes.TeamVals.RIGHT,
                attackType: PBTypes.AttackVals.RANGE,
                rangeShots: 3,
                shotDistance: 2,
            });
            const target = createTestUnit({ team: PBTypes.TeamVals.LEFT });

            placeUnit(grid, unitsHolder, attacker, { x: 1, y: 1 });
            placeUnit(grid, unitsHolder, target, { x: 8, y: 1 });

            expect(attackHandler.getRangeAttackDivisor(attacker, target.getPosition())).toBeGreaterThan(1);
            expect(attackHandler.canLandRangeAttack(attacker, grid.getEnemyAggrMatrixByUnitId(attacker.getId()))).toBe(
                true,
            );
            expect(
                attackHandler.canBeAttackedByMelee(
                    attacker.getPosition(),
                    attacker,
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
                team: PBTypes.TeamVals.RIGHT,
                spells: ["Death:Weakness"],
            });
            const target = createTestUnit({
                team: PBTypes.TeamVals.LEFT,
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
                team: PBTypes.TeamVals.RIGHT,
                spells: ["Life:Heal"],
                amountAlive: 2,
            });
            const target = createTestUnit({
                team: PBTypes.TeamVals.RIGHT,
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

            // The handler must REPORT what it restored, not just log it: ranked rebuilds its scene log
            // from the spell_cast event, so a heal with no reported amount reads as a bare "cast Heal on
            // X" with no number. The amount is what the target actually gained, capped by missing HP.
            expect(result.healed).toEqual([{ unitId: target.getId(), amount: target.getHp() - 12 }]);
        });

        it("applies common enemy debuffs", () => {
            const { grid, unitsHolder, attackHandler } = createCombatTestContext();
            const caster = createTestUnit({
                team: PBTypes.TeamVals.RIGHT,
                spells: ["Death:Weakness"],
            });
            const target = createTestUnit({
                team: PBTypes.TeamVals.LEFT,
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
                team: PBTypes.TeamVals.RIGHT,
                spells: ["Life:Helping Hand"],
                stackPower: 4,
            });
            const target = createTestUnit({
                name: "Helping Target",
                team: PBTypes.TeamVals.RIGHT,
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

        it("a Fireforged Sword is a stable 20% of the damage that landed, not the caster's HP", () => {
            setDeterministicRandomSource(() => 0);
            const { grid, unitsHolder, attackHandler } = createCombatTestContext();
            const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
            // Wandering Mage: 6 HP. That number used to leak into the buff tooltip as "6%".
            const caster = createTestUnit({
                name: "Wandering Mage",
                team: PBTypes.TeamVals.RIGHT,
                spells: ["Chaos:Fireforged Sword"],
                maxHp: 6,
                armor: 8,
            });
            const ally = createTestUnit({
                name: "Swordsman",
                team: PBTypes.TeamVals.RIGHT,
                attackType: PBTypes.AttackVals.MELEE,
                damageMin: 40,
                damageMax: 40,
                maxHp: 200,
                amountAlive: 3,
            });
            const enemy = createTestUnit({
                name: "Target",
                team: PBTypes.TeamVals.LEFT,
                armor: 0,
                magicResist: 0,
                maxHp: 500,
                amountAlive: 5,
                damageMin: 0,
                damageMax: 0,
            });

            placeUnit(grid, unitsHolder, caster, { x: 1, y: 1 });
            placeUnit(grid, unitsHolder, ally, { x: 2, y: 1 });
            placeUnit(grid, unitsHolder, enemy, { x: 3, y: 1 });

            const cast = attackHandler.handleMagicAttack(
                grid.getMatrix(),
                unitsHolder,
                caster.getSpells()[0],
                caster,
                ally,
            );

            expect(cast.completed).toBe(true);
            expect(ally.getBuff("Fireforged Sword")?.getPower()).toBe(20);
            expect(ally.getBuff("Fireforged Sword")?.getFirstSpellProperty()).toBeUndefined();
            const shown = ally.getUnitProperties().applied_buffs_descriptions[0]?.split(";")[0] ?? "";
            expect(shown).toContain("for 20%");
            expect(shown).not.toContain("for 6%");
            expect(shown).not.toContain("{}");

            const damage = createVisibleDamage(enemy);
            const attack = attackHandler.handleMeleeAttack(unitsHolder, moveHandler, damage, undefined, ally, enemy, {
                x: 2,
                y: 1,
            });

            expect(attack.completed).toBe(true);
            expect(damage.amount).toBeGreaterThan(0);
            // damage.amount is the swing that landed. The fire is exactly 20% of that number.
            const burns = (damage.secondary ?? []).filter((entry) => entry.source === "fireforged_sword");
            expect(burns).toHaveLength(1);
            expect(burns[0]?.unitId).toBe(enemy.getId());
            expect(burns[0]?.amount).toBe(
                fireforgedSwordDamage({
                    damageDealt: damage.amount,
                    swordPercentage: 20,
                    targetMagicResist: 0,
                    targetIsFireElement: false,
                    targetIsWaterElement: false,
                }),
            );
            setDeterministicRandomSource(undefined);
        });

        it("Tome of Amplification raises a Fireforged Sword from 20% to 30% of the hit", () => {
            setDeterministicRandomSource(() => 0);
            const { grid, unitsHolder, attackHandler } = createCombatTestContext();
            const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
            const caster = createTestUnit({
                name: "Wandering Mage",
                team: PBTypes.TeamVals.RIGHT,
                spells: ["Chaos:Fireforged Sword"],
                maxHp: 6,
            });
            const ally = createTestUnit({
                name: "Swordsman",
                team: PBTypes.TeamVals.RIGHT,
                attackType: PBTypes.AttackVals.MELEE,
                damageMin: 40,
                damageMax: 40,
                maxHp: 200,
                amountAlive: 3,
            });
            const enemy = createTestUnit({
                name: "Target",
                team: PBTypes.TeamVals.LEFT,
                armor: 0,
                magicResist: 0,
                maxHp: 500,
                amountAlive: 5,
                damageMin: 0,
                damageMax: 0,
            });

            placeUnit(grid, unitsHolder, caster, { x: 1, y: 1 });
            placeUnit(grid, unitsHolder, ally, { x: 2, y: 1 });
            placeUnit(grid, unitsHolder, enemy, { x: 3, y: 1 });
            const fightProperties = FightStateManager.getInstance().getFightProperties();
            fightProperties.setArtifactPerTeam(
                PBTypes.TeamVals.RIGHT,
                ArtifactTier.TIER_2,
                Tier2Artifact.TOME_OF_AMPLIFICATION,
            );
            unitsHolder.applyArtifacts(fightProperties);
            // Empower is a magic-damage bonus. It must not move the blade on top of the tome.
            ally.applyBuff(new Spell({ spellProperties: getSpellConfig("Chaos", "Empower"), amount: 1 }));

            const sourceSpell = caster.getSpells()[0];
            const cast = attackHandler.handleMagicAttack(grid.getMatrix(), unitsHolder, sourceSpell, caster, ally);

            expect(cast.completed).toBe(true);
            expect(sourceSpell.getPower()).toBe(20);
            expect(ally.getBuff("Fireforged Sword")?.getPower()).toBe(30);
            const swordIndex = ally.getUnitProperties().applied_buffs.indexOf("Fireforged Sword");
            const shown = ally.getUnitProperties().applied_buffs_descriptions[swordIndex]?.split(";")[0] ?? "";
            expect(shown).toContain("for 30%");
            expect(ally.getMagicDamageBonusPercentage()).toBeGreaterThan(0);

            const damage = createVisibleDamage(enemy);
            const attack = attackHandler.handleMeleeAttack(unitsHolder, moveHandler, damage, undefined, ally, enemy, {
                x: 2,
                y: 1,
            });

            expect(attack.completed).toBe(true);
            expect(damage.amount).toBeGreaterThan(0);
            const burns = (damage.secondary ?? []).filter((entry) => entry.source === "fireforged_sword");
            expect(burns).toHaveLength(1);
            expect(burns[0]?.amount).toBe(
                fireforgedSwordDamage({
                    damageDealt: damage.amount,
                    swordPercentage: 30,
                    targetMagicResist: 0,
                    targetIsFireElement: false,
                    targetIsWaterElement: false,
                }),
            );
            setDeterministicRandomSource(undefined);
        });

        it("amplifies a Healer's Spiritual Armor cast without mutating the source spell", () => {
            const { grid, unitsHolder, attackHandler } = createCombatTestContext();
            const caster = createTestUnit({
                name: "Healer",
                team: PBTypes.TeamVals.RIGHT,
                spells: ["Life:Spiritual Armor"],
            });
            const target = createTestUnit({
                name: "Armor Target",
                team: PBTypes.TeamVals.RIGHT,
                armor: 20,
            });
            const fightProperties = FightStateManager.getInstance().getFightProperties();

            placeUnit(grid, unitsHolder, caster, { x: 1, y: 1 });
            placeUnit(grid, unitsHolder, target, { x: 2, y: 1 });
            fightProperties.setArtifactPerTeam(
                PBTypes.TeamVals.RIGHT,
                ArtifactTier.TIER_2,
                Tier2Artifact.TOME_OF_AMPLIFICATION,
            );
            unitsHolder.applyArtifacts(fightProperties);

            const sourceSpell = caster.getSpells()[0];
            const result = attackHandler.handleMagicAttack(grid.getMatrix(), unitsHolder, sourceSpell, caster, target);

            expect(result.completed).toBe(true);
            expect(sourceSpell.getPower()).toBe(30);
            expect(target.getBuff("Spiritual Armor")?.getPower()).toBe(45);
            expect(target.getUnitProperties().applied_buffs_powers).toContain(45);
            target.adjustBaseStats(false, 1, 0, 0, 0, 0, 0, 0);
            expect(target.getArmor()).toBeCloseTo(29);
        });

        it("amplifies Helping Hand's allied benefit but not its caster debuff", () => {
            const { grid, unitsHolder, attackHandler } = createCombatTestContext();
            const caster = createTestUnit({
                name: "Satyr",
                team: PBTypes.TeamVals.RIGHT,
                spells: ["Life:Helping Hand"],
                stackPower: 4,
                maxHp: 100,
                armor: 20,
            });
            const target = createTestUnit({
                name: "Helping Target",
                team: PBTypes.TeamVals.RIGHT,
                stackPower: 4,
                maxHp: 10,
                armor: 10,
            });
            const fightProperties = FightStateManager.getInstance().getFightProperties();

            placeUnit(grid, unitsHolder, caster, { x: 1, y: 1 });
            placeUnit(grid, unitsHolder, target, { x: 2, y: 1 });
            fightProperties.setArtifactPerTeam(
                PBTypes.TeamVals.RIGHT,
                ArtifactTier.TIER_2,
                Tier2Artifact.TOME_OF_AMPLIFICATION,
            );
            unitsHolder.applyArtifacts(fightProperties);

            const sourceSpell = caster.getSpells()[0];
            const result = attackHandler.handleMagicAttack(grid.getMatrix(), unitsHolder, sourceSpell, caster, target);

            expect(result.completed).toBe(true);
            expect(sourceSpell.getPower()).toBe(30);
            expect(target.getBuff("Helping Hand")?.getPower()).toBe(45);
            expect(caster.getDebuff("Helping Hand")?.getPower()).toBe(30);
            expect(target.getUnitProperties().applied_buffs_powers).toContain(45);
            target.adjustBaseStats(false, 1, 0, 0, 0, 0, 0, 0);
            caster.adjustBaseStats(false, 1, 0, 0, 0, 0, 0, 0);
            expect(target.getMaxHp()).toBe(55);
            expect(target.getBaseArmor()).toBe(19);
            expect(caster.getMaxHp()).toBe(70);
            expect(caster.getBaseArmor()).toBe(14);
        });

        it("swaps positions for Castling", () => {
            const { grid, unitsHolder, attackHandler } = createCombatTestContext();
            const caster = createTestUnit({
                team: PBTypes.TeamVals.RIGHT,
                spells: ["System:Castling"],
                stackPower: 4,
            });
            const target = createTestUnit({
                team: PBTypes.TeamVals.LEFT,
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
                team: PBTypes.TeamVals.RIGHT,
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
                team: PBTypes.TeamVals.LEFT,
                armor: 1,
                amountAlive: 1,
                maxHp: 1,
                morale: 0,
            });
            // Another Peasant stack on the target's team, off to the side (same name + team → loses morale).
            const targetAlly = createTestUnit({
                name: "Peasant",
                team: PBTypes.TeamVals.LEFT,
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
            expect(result.unitIdsDied.filter((unitId) => unitId === target.getId())).toHaveLength(1);
            // Killer gains morale; the fallen stack's surviving same-type ally loses it.
            expect(attacker.getMorale()).toBe(attackerMoraleBefore + MORALE_CHANGE_FOR_KILL);
            expect(targetAlly.getMorale()).toBe(allyMoraleBefore - MORALE_CHANGE_FOR_KILL);
        });

        it("applies direct range attack damage once while recording animation and statistics", () => {
            const { grid, unitsHolder, attackHandler, damageStatisticHolder } = createCombatTestContext();

            const attacker = createTestUnit({
                name: "Range Attacker",
                team: PBTypes.TeamVals.RIGHT,
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
                team: PBTypes.TeamVals.LEFT,
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
                    team: PBTypes.TeamVals.RIGHT,
                    lap: 1,
                },
            ]);
        });

        it("does not land a range attack while the attacker is threatened by melee", () => {
            const { grid, unitsHolder, attackHandler, damageStatisticHolder } = createCombatTestContext();
            const attacker = createTestUnit({
                team: PBTypes.TeamVals.RIGHT,
                attackType: PBTypes.AttackVals.RANGE,
                damageMin: 10,
                damageMax: 10,
                rangeShots: 3,
            });
            const adjacentEnemy = createTestUnit({
                team: PBTypes.TeamVals.LEFT,
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
                team: PBTypes.TeamVals.RIGHT,
                attackType: PBTypes.AttackVals.RANGE,
                damageMin: 10,
                damageMax: 10,
                rangeShots: 3,
            });
            const selectedTarget = createTestUnit({
                team: PBTypes.TeamVals.LEFT,
                amountAlive: 3,
            });
            const forcedTarget = createTestUnit({
                team: PBTypes.TeamVals.LEFT,
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
                team: PBTypes.TeamVals.RIGHT,
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
                team: PBTypes.TeamVals.LEFT,
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
                    team: PBTypes.TeamVals.LEFT,
                    lap: 1,
                },
                {
                    unitName: "Attacking Archer",
                    damage: 10,
                    team: PBTypes.TeamVals.RIGHT,
                    lap: 1,
                },
            ]);
        });

        it("reports both deaths when primary Petrifying Gaze and the ranged response kill each other", () => {
            const { grid, unitsHolder, attackHandler } = createCombatTestContext();
            const attacker = createTestUnit({
                name: "Gazer",
                team: PBTypes.TeamVals.RIGHT,
                attackType: PBTypes.AttackVals.RANGE,
                rangeShots: 3,
                amountAlive: 1,
                maxHp: 10,
                abilities: ["Petrifying Gaze"],
                stackPower: 5,
                luck: 10,
            });
            const target = createTestUnit({
                name: "Responder",
                team: PBTypes.TeamVals.LEFT,
                attackType: PBTypes.AttackVals.RANGE,
                rangeShots: 3,
                amountAlive: 1,
                maxHp: 100,
                morale: 0,
            });
            const targetAlly = createTestUnit({
                name: "Responder",
                team: PBTypes.TeamVals.LEFT,
                amountAlive: 1,
                morale: 10,
            });
            attacker.calculateMissChance = () => 0;
            target.calculateMissChance = () => 0;
            attacker.calculateAttackDamage = () => 1;
            target.calculateAttackDamage = () => 100;

            placeUnit(grid, unitsHolder, attacker, { x: 1, y: 1 });
            placeUnit(grid, unitsHolder, target, { x: 8, y: 1 });
            placeUnit(grid, unitsHolder, targetAlly, { x: 6, y: 6 });
            const damageForAnimation = createVisibleDamage(target);

            setDeterministicRandomSource(() => 0);
            try {
                const result = attackHandler.handleRangeAttack(
                    unitsHolder,
                    [1],
                    1,
                    damageForAnimation,
                    attacker,
                    [[target]],
                    [attacker],
                    target.getPosition(),
                );

                targetAlly.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);

                expect(result.completed).toBe(true);
                expect(attacker.isDead()).toBe(true);
                expect(target.isDead()).toBe(true);
                expect(result.unitIdsDied.filter((unitId) => unitId === attacker.getId())).toHaveLength(1);
                expect(result.unitIdsDied.filter((unitId) => unitId === target.getId())).toHaveLength(1);
                expect(damageForAnimation.secondary).toEqual([
                    expect.objectContaining({
                        source: "petrifying_gaze",
                        unitId: target.getId(),
                        amount: 99,
                        unitsDied: 1,
                    }),
                ]);
                expect(targetAlly.getMorale()).toBe(10 - MORALE_CHANGE_FOR_KILL);
            } finally {
                setDeterministicRandomSource(undefined);
            }
        });

        it("applies Petrifying Gaze once to a unit-targeted Area Throw primary", () => {
            const { grid, unitsHolder, attackHandler } = createCombatTestContext();
            const attacker = createTestUnit({
                name: "AOE Gazer",
                team: PBTypes.TeamVals.RIGHT,
                attackType: PBTypes.AttackVals.RANGE,
                rangeShots: 3,
                amountAlive: 1,
                abilities: ["Area Throw", "Petrifying Gaze"],
                stackPower: 5,
                luck: 10,
            });
            const target = createTestUnit({
                name: "AOE Target",
                team: PBTypes.TeamVals.LEFT,
                amountAlive: 3,
                maxHp: 100,
            });
            attacker.calculateMissChance = () => 0;
            attacker.calculateAttackDamage = () => 10;

            placeUnit(grid, unitsHolder, attacker, { x: 1, y: 1 });
            placeUnit(grid, unitsHolder, target, { x: 8, y: 1 });
            const damageForAnimation = createVisibleDamage(target);

            setDeterministicRandomSource(() => 0);
            try {
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
                const gazeDamage = damageForAnimation.secondary?.filter((entry) => entry.source === "petrifying_gaze");

                expect(result.completed).toBe(true);
                expect(gazeDamage).toEqual([
                    expect.objectContaining({
                        unitId: target.getId(),
                        amount: 90,
                        unitsDied: 1,
                    }),
                ]);
                expect(target.getAmountAlive()).toBe(2);
                expect(target.getCumulativeHp()).toBe(200);
            } finally {
                setDeterministicRandomSource(undefined);
            }
        });
    });

    describe("handleMeleeAttack", () => {
        it("applies adjacent melee attack damage and response damage", () => {
            const { grid, unitsHolder, attackHandler, damageStatisticHolder } = createCombatTestContext();
            const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
            const attacker = createTestUnit({
                name: "Melee Attacker",
                team: PBTypes.TeamVals.RIGHT,
                attackType: PBTypes.AttackVals.MELEE,
                attack: 10,
                armor: 30,
                damageMin: 10,
                damageMax: 10,
                amountAlive: 3,
            });
            const target = createTestUnit({
                name: "Melee Target",
                team: PBTypes.TeamVals.LEFT,
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
                    team: PBTypes.TeamVals.LEFT,
                    lap: 1,
                },
                {
                    unitName: "Melee Attacker",
                    damage: 10,
                    team: PBTypes.TeamVals.RIGHT,
                    lap: 1,
                },
            ]);
        });

        // Skewer Strike, not Fire Breath: the aura absorbs PHYSICAL damage only, so a magical sweep can
        // never kill the Abomination this way. The invariant under test is the same — a primary target
        // already killed by an earlier sweep's absorption must not be struck a second time.
        it("does not hit a primary Abomination again after Skewer Strike absorption kills it", () => {
            const { grid, unitsHolder, attackHandler, damageStatisticHolder } = createCombatTestContext();
            const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
            const attacker = createTestUnit({
                name: "Skewerer",
                team: PBTypes.TeamVals.RIGHT,
                attackType: PBTypes.AttackVals.MELEE,
                abilities: ["Skewer Strike"],
            });
            const abomination = createTestUnit({
                name: "Abomination",
                team: PBTypes.TeamVals.LEFT,
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
                team: PBTypes.TeamVals.LEFT,
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
                        source: "skewer_strike",
                        unitId: protectedAlly.getId(),
                        amount: 50,
                    }),
                ]),
            );
            expect(damageStatisticHolder.get().reduce((total, entry) => total + entry.damage, 0)).toBe(100);
        });

        it("does not apply a base response after response Skewer Strike absorption kills the attacker", () => {
            const { grid, unitsHolder, attackHandler, damageStatisticHolder } = createCombatTestContext();
            const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
            const abomination = createTestUnit({
                name: "Abomination",
                team: PBTypes.TeamVals.RIGHT,
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
                team: PBTypes.TeamVals.RIGHT,
                maxHp: 1000,
                armor: 20,
            });
            const responder = createTestUnit({
                name: "Responding Skewerer",
                team: PBTypes.TeamVals.LEFT,
                maxHp: 1000,
                armor: 20,
                attackType: PBTypes.AttackVals.MELEE,
                abilities: ["Skewer Strike"],
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
                team: PBTypes.TeamVals.RIGHT,
                attackType: PBTypes.AttackVals.RANGE,
                rangeShots: 3,
            });
            const target = createTestUnit({ team: PBTypes.TeamVals.LEFT });

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
                team: PBTypes.TeamVals.RIGHT,
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
                team: PBTypes.TeamVals.RIGHT,
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

        it("destroys only the targeted scattered tombstone and makes its cell walkable", () => {
            const { grid, unitsHolder, attackHandler, moveHandler, fightProperties } = setupMountainFight();
            const target = { x: 6, y: 7 };
            const survivor = { x: 10, y: 8 };
            grid.setScatteredMountains([target, survivor]);
            const attacker = createTestUnit({
                team: PBTypes.TeamVals.RIGHT,
                attackType: PBTypes.AttackVals.RANGE,
                rangeShots: 3,
            });
            placeUnit(grid, unitsHolder, attacker, { x: 1, y: 1 });

            const result = attackHandler.handleObstacleAttack(
                positionForCell(target),
                unitsHolder,
                moveHandler,
                attacker,
            );

            expect(result.completed).toBe(true);
            expect(grid.getOccupantUnitId(target)).toBe("");
            expect(grid.getOccupantUnitId(survivor)).toBe("B");
            expect(grid.getScatteredMountainsStanding()).toEqual([survivor]);
            expect(fightProperties.getObstacleHitsLeft()).toBe(2 * HITS_PER_MOUNTAIN);
        });

        it("Double Shot destroys two aligned scattered tombstones in trajectory order", () => {
            const { grid, unitsHolder, attackHandler, moveHandler } = setupMountainFight();
            const first = { x: 5, y: 7 };
            const second = { x: 9, y: 7 };
            const survivor = { x: 10, y: 8 };
            grid.setScatteredMountains([first, second, survivor]);
            const attacker = createTestUnit({
                team: PBTypes.TeamVals.RIGHT,
                attackType: PBTypes.AttackVals.RANGE,
                rangeShots: 3,
                abilities: ["Double Shot"],
            });
            placeUnit(grid, unitsHolder, attacker, { x: 1, y: 7 });

            const result = attackHandler.handleObstacleAttack(
                positionForCell(second),
                unitsHolder,
                moveHandler,
                attacker,
            );

            expect(result.completed).toBe(true);
            expect(result.animationData).toHaveLength(2);
            expect(result.animationData![0].toPosition.x).toBeLessThan(result.animationData![1].toPosition.x);
            expect(result.animationData![0].toPosition.y).toBe(result.animationData![1].toPosition.y);
            expect(grid.getOccupantUnitId(first)).toBe("");
            expect(grid.getOccupantUnitId(second)).toBe("");
            expect(grid.getScatteredMountainsStanding()).toEqual([survivor]);
            expect(attacker.getRangeShots()).toBe(2);
        });

        // Skewer Strike (Pikeman) and Fire Breath (Black Dragon) strike the cell BEHIND a one-cell target, so
        // the cemetery barrel standing directly behind the struck one goes down with it — straight or diagonal
        // along the strike line. Cells sit off the classic 2x2 mountain footprint so the scattered layout is
        // the only obstacle in play.
        describe("piercing melee passives through scattered tombstones", () => {
            const strikeBarrels = (opts: {
                layout: { x: number; y: number }[];
                target: { x: number; y: number };
                standCell: { x: number; y: number };
                abilities?: string[];
                size?: PBTypes.UnitSizeVals;
            }) => {
                const ctx = setupMountainFight();
                ctx.grid.setScatteredMountains(opts.layout);
                const attacker = createTestUnit({
                    team: PBTypes.TeamVals.RIGHT,
                    attackType: PBTypes.AttackVals.MELEE,
                    abilities: opts.abilities,
                    size: opts.size,
                });
                placeUnit(ctx.grid, ctx.unitsHolder, attacker, opts.standCell);
                // Stationary strike: attackFrom is the unit's own anchor, so no movement paths are needed.
                const result = ctx.attackHandler.handleObstacleAttack(
                    positionForCell(opts.target),
                    ctx.unitsHolder,
                    ctx.moveHandler,
                    attacker,
                    opts.standCell,
                    undefined,
                );
                return { ...ctx, attacker, result };
            };

            it("Skewer Strike knocks out the barrel directly behind the struck one", () => {
                const behind = { x: 4, y: 3 };
                const survivor = { x: 10, y: 3 };
                const { grid, result } = strikeBarrels({
                    layout: [{ x: 3, y: 3 }, behind, survivor],
                    target: { x: 3, y: 3 },
                    standCell: { x: 2, y: 3 },
                    abilities: ["Skewer Strike"],
                });
                expect(result.completed).toBe(true);
                expect(grid.getScatteredMountainsStanding()).toEqual([survivor]);
                expect(grid.getOccupantUnitId(behind)).toBe("");
            });

            it("a diagonal strike pierces diagonally and spares the orthogonal neighbour", () => {
                const diagonal = { x: 4, y: 4 };
                const orthogonal = { x: 4, y: 3 };
                const { grid, result } = strikeBarrels({
                    layout: [{ x: 3, y: 3 }, orthogonal, diagonal],
                    target: { x: 3, y: 3 },
                    standCell: { x: 2, y: 2 },
                    abilities: ["Skewer Strike"],
                });
                expect(result.completed).toBe(true);
                expect(grid.getScatteredMountainsStanding()).toEqual([orthogonal]);
            });

            it("Fire Breath from a 2x2 body aims the pierce from its cell closest to the barrel", () => {
                const behind = { x: 4, y: 3 };
                // Anchor (2,3) = body cells (2,3) (1,3) (2,2) (1,2); (2,3) is the one touching the barrel.
                const { grid, result } = strikeBarrels({
                    layout: [{ x: 3, y: 3 }, behind],
                    target: { x: 3, y: 3 },
                    standCell: { x: 2, y: 3 },
                    abilities: ["Fire Breath"],
                    size: PBTypes.UnitSizeVals.LARGE,
                });
                expect(result.completed).toBe(true);
                expect(grid.getScatteredMountainsStanding()).toEqual([]);
            });

            it("does not jump a gap: an empty cell behind the barrel ends the sweep", () => {
                const farther = { x: 5, y: 3 };
                const { grid, result } = strikeBarrels({
                    layout: [{ x: 3, y: 3 }, farther],
                    target: { x: 3, y: 3 },
                    standCell: { x: 2, y: 3 },
                    abilities: ["Skewer Strike"],
                });
                expect(result.completed).toBe(true);
                expect(grid.getScatteredMountainsStanding()).toEqual([farther]);
            });

            it("a plain melee strike still breaks only the barrel it hits", () => {
                const behind = { x: 4, y: 3 };
                const { grid, result } = strikeBarrels({
                    layout: [{ x: 3, y: 3 }, behind],
                    target: { x: 3, y: 3 },
                    standCell: { x: 2, y: 3 },
                });
                expect(result.completed).toBe(true);
                expect(grid.getScatteredMountainsStanding()).toEqual([behind]);
            });

            it("a Skewer Strike aimed at a barrel runs on into the enemy standing behind it", () => {
                const ctx = setupMountainFight();
                const aimed = { x: 3, y: 3 };
                ctx.grid.setScatteredMountains([aimed]);
                const pikeman = createTestUnit({
                    team: PBTypes.TeamVals.RIGHT,
                    attackType: PBTypes.AttackVals.MELEE,
                    abilities: ["Skewer Strike"],
                    attack: 50,
                    damageMin: 100,
                    damageMax: 100,
                });
                const behind = createTestUnit({ name: "Behind", team: PBTypes.TeamVals.LEFT, maxHp: 10 });
                placeUnit(ctx.grid, ctx.unitsHolder, pikeman, { x: 2, y: 3 });
                placeUnit(ctx.grid, ctx.unitsHolder, behind, { x: 4, y: 3 });
                const damage = createVisibleDamage(pikeman);

                const result = ctx.attackHandler.handleObstacleAttack(
                    positionForCell(aimed),
                    ctx.unitsHolder,
                    ctx.moveHandler,
                    pikeman,
                    { x: 2, y: 3 },
                    undefined,
                    damage,
                );

                expect(result.completed).toBe(true);
                expect(ctx.grid.getScatteredMountainsStanding()).toEqual([]);
                expect(behind.isDead()).toBe(true);
                expect(result.unitIdsDied).toEqual([behind.getId()]);
                expect(damage.secondary).toContainEqual(
                    expect.objectContaining({ source: "skewer_strike", unitId: behind.getId(), unitsDied: 1 }),
                );
            });

            // A barrel strike with a unit standing right behind the barrel (attacker (2,3), barrel (3,3), unit (4,3)).
            const strikeBarrelWithUnitBehind = (
                abilities: string[],
                behindOptions: Parameters<typeof createTestUnit>[0],
            ) => {
                const ctx = setupMountainFight();
                ctx.grid.setScatteredMountains([{ x: 3, y: 3 }]);
                const attacker = createTestUnit({
                    team: PBTypes.TeamVals.RIGHT,
                    attackType: PBTypes.AttackVals.MELEE,
                    abilities,
                    attack: 50,
                    damageMin: 100,
                    damageMax: 100,
                });
                const behind = createTestUnit({ name: "Behind", maxHp: 10, ...behindOptions });
                placeUnit(ctx.grid, ctx.unitsHolder, attacker, { x: 2, y: 3 });
                placeUnit(ctx.grid, ctx.unitsHolder, behind, { x: 4, y: 3 });
                const damage = createVisibleDamage(attacker);
                const result = ctx.attackHandler.handleObstacleAttack(
                    positionForCell({ x: 3, y: 3 }),
                    ctx.unitsHolder,
                    ctx.moveHandler,
                    attacker,
                    { x: 2, y: 3 },
                    undefined,
                    damage,
                );
                expect(result.completed).toBe(true);
                expect(ctx.grid.getScatteredMountainsStanding()).toEqual([]);
                return { behind, damage, result };
            };

            it("the barrel strike's skewer spares an ally behind the barrel", () => {
                const { behind, damage, result } = strikeBarrelWithUnitBehind(["Skewer Strike"], {
                    team: PBTypes.TeamVals.RIGHT,
                });
                expect(behind.getCumulativeHp()).toBe(behind.getMaxHp());
                expect(result.unitIdsDied).toEqual([]);
                expect(damage.secondary ?? []).toEqual([]);
            });

            it("a Fire Breath aimed at a barrel burns whoever stands behind it, ally or enemy", () => {
                for (const team of [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT]) {
                    const { behind, damage, result } = strikeBarrelWithUnitBehind(["Fire Breath"], { team });
                    expect(behind.isDead()).toBe(true);
                    expect(result.unitIdsDied).toEqual([behind.getId()]);
                    expect(damage.secondary).toContainEqual(
                        expect.objectContaining({ source: "fire_breath", unitId: behind.getId() }),
                    );
                }
            });

            it("a Fire Breath aimed at a barrel leaves a fire-immune unit behind it untouched", () => {
                const { behind, damage, result } = strikeBarrelWithUnitBehind(["Fire Breath"], {
                    team: PBTypes.TeamVals.LEFT,
                    abilities: ["Fire Element"],
                });
                expect(behind.getCumulativeHp()).toBe(behind.getMaxHp());
                expect(result.unitIdsDied).toEqual([]);
                expect(damage.secondary ?? []).toEqual([]);
            });

            it("a unit strike's Fire Breath burns every barrel in its band behind a 2x2 target", () => {
                const ctx = setupMountainFight();
                // Dragon anchor (3,4) = body x 2..3, y 3..4; target anchor (5,4) = body x 4..5, y 3..4. The breath's
                // band is the target's own 2x2 depth straight behind it: x 6..7, y 3..4.
                const inBand = [
                    { x: 6, y: 4 },
                    { x: 7, y: 3 },
                ];
                const pastBand = { x: 8, y: 4 };
                ctx.grid.setScatteredMountains([pastBand, ...inBand]);
                const dragon = createTestUnit({
                    team: PBTypes.TeamVals.RIGHT,
                    attackType: PBTypes.AttackVals.MELEE,
                    abilities: ["Fire Breath"],
                    size: PBTypes.UnitSizeVals.LARGE,
                });
                const target = createTestUnit({
                    name: "Target",
                    team: PBTypes.TeamVals.LEFT,
                    maxHp: 1000,
                    size: PBTypes.UnitSizeVals.LARGE,
                });
                placeUnit(ctx.grid, ctx.unitsHolder, dragon, { x: 3, y: 4 });
                placeUnit(ctx.grid, ctx.unitsHolder, target, { x: 5, y: 4 });

                const result = ctx.attackHandler.handleMeleeAttack(
                    ctx.unitsHolder,
                    ctx.moveHandler,
                    createVisibleDamage(target),
                    undefined,
                    dragon,
                    target,
                    { x: 3, y: 4 },
                );

                expect(result.completed).toBe(true);
                expect(ctx.grid.getScatteredMountainsStanding()).toEqual([pastBand]);
                expect(result.piercedObstacles).toHaveLength(2);
                expect(result.piercedObstacles).toEqual(
                    expect.arrayContaining(inBand.map((cell) => ({ cell, source: "fire_breath" }))),
                );
            });

            it("a unit strike's Skewer Strike breaks the barrel behind its small target", () => {
                const ctx = setupMountainFight();
                const behind = { x: 4, y: 3 };
                const aside = { x: 4, y: 4 };
                ctx.grid.setScatteredMountains([aside, behind]);
                const pikeman = createTestUnit({
                    team: PBTypes.TeamVals.RIGHT,
                    attackType: PBTypes.AttackVals.MELEE,
                    abilities: ["Skewer Strike"],
                });
                const target = createTestUnit({ name: "Target", team: PBTypes.TeamVals.LEFT, maxHp: 1000 });
                placeUnit(ctx.grid, ctx.unitsHolder, pikeman, { x: 2, y: 3 });
                placeUnit(ctx.grid, ctx.unitsHolder, target, { x: 3, y: 3 });

                const result = ctx.attackHandler.handleMeleeAttack(
                    ctx.unitsHolder,
                    ctx.moveHandler,
                    createVisibleDamage(target),
                    undefined,
                    pikeman,
                    target,
                    { x: 2, y: 3 },
                );

                expect(result.completed).toBe(true);
                expect(ctx.grid.getScatteredMountainsStanding()).toEqual([aside]);
                expect(result.piercedObstacles).toEqual([{ cell: behind, source: "skewer_strike" }]);
            });

            it("a Skewer Strike into a large target breaks no barrel behind it", () => {
                const ctx = setupMountainFight();
                const behindBody = [
                    { x: 5, y: 3 },
                    { x: 5, y: 4 },
                ];
                ctx.grid.setScatteredMountains(behindBody);
                const pikeman = createTestUnit({
                    team: PBTypes.TeamVals.RIGHT,
                    attackType: PBTypes.AttackVals.MELEE,
                    abilities: ["Skewer Strike"],
                });
                const target = createTestUnit({
                    name: "Target",
                    team: PBTypes.TeamVals.LEFT,
                    maxHp: 1000,
                    size: PBTypes.UnitSizeVals.LARGE,
                });
                placeUnit(ctx.grid, ctx.unitsHolder, pikeman, { x: 2, y: 3 });
                // Anchor (4,4) = body (4,4) (3,4) (4,3) (3,3), touching the Pikeman at (3,3).
                placeUnit(ctx.grid, ctx.unitsHolder, target, { x: 4, y: 4 });

                const result = ctx.attackHandler.handleMeleeAttack(
                    ctx.unitsHolder,
                    ctx.moveHandler,
                    createVisibleDamage(target),
                    undefined,
                    pikeman,
                    target,
                    { x: 2, y: 3 },
                );

                expect(result.completed).toBe(true);
                expect(ctx.grid.getScatteredMountainsStanding()).toEqual(behindBody);
                expect(result.piercedObstacles).toEqual([]);
            });

            it("leaves the classic 2x2 mountains to their own hit counters", () => {
                const { grid, unitsHolder, attackHandler, moveHandler, fightProperties } = setupMountainFight();
                const attacker = createTestUnit({
                    team: PBTypes.TeamVals.RIGHT,
                    attackType: PBTypes.AttackVals.MELEE,
                    abilities: ["Skewer Strike"],
                });
                placeUnit(grid, unitsHolder, attacker, { x: 4, y: 7 });
                const result = attackHandler.handleObstacleAttack(
                    positionForCell({ x: 5, y: 7 }),
                    unitsHolder,
                    moveHandler,
                    attacker,
                    { x: 4, y: 7 },
                    undefined,
                );
                expect(result.completed).toBe(true);
                expect(fightProperties.getObstacleHitsLeftLeft()).toBe(HITS_PER_MOUNTAIN - 1);
                expect(fightProperties.getObstacleHitsLeftRight()).toBe(HITS_PER_MOUNTAIN);
            });
        });

        // Hydra's Lightning Spin is one radial impact: every barrel AND every enemy around her body is hit, whether
        // the blow that set it off was aimed at a barrel or at a unit.
        describe("Lightning Spin through scattered tombstones", () => {
            it("a 2x2 spinner aiming at one barrel breaks every barrel around her body, and nothing further out", () => {
                const ctx = setupMountainFight();
                // Anchor (3,4) = body (3,4) (2,4) (3,3) (2,3); the ring is x 1..4, y 2..5 minus the body.
                const aimed = { x: 4, y: 4 };
                const corner = { x: 1, y: 2 };
                const above = { x: 2, y: 5 };
                const outside = { x: 5, y: 4 };
                ctx.grid.setScatteredMountains([outside, above, aimed, corner]);
                const hydra = createTestUnit({
                    team: PBTypes.TeamVals.RIGHT,
                    attackType: PBTypes.AttackVals.MELEE,
                    abilities: ["Lightning Spin"],
                    size: PBTypes.UnitSizeVals.LARGE,
                });
                placeUnit(ctx.grid, ctx.unitsHolder, hydra, { x: 3, y: 4 });

                const result = ctx.attackHandler.handleObstacleAttack(
                    positionForCell(aimed),
                    ctx.unitsHolder,
                    ctx.moveHandler,
                    hydra,
                    { x: 3, y: 4 },
                    undefined,
                );

                expect(result.completed).toBe(true);
                expect(ctx.grid.getScatteredMountainsStanding()).toEqual([outside]);
                // The aimed stone fell to the blow itself; the spin reports only the ones it swept, in ring order.
                expect(result.spunObstacleCells).toEqual([corner, above]);
            });

            it("a barrel strike spins into the enemies around the attacker as well", () => {
                const ctx = setupMountainFight();
                const aimed = { x: 3, y: 3 };
                ctx.grid.setScatteredMountains([aimed]);
                const hydra = createTestUnit({
                    team: PBTypes.TeamVals.RIGHT,
                    attackType: PBTypes.AttackVals.MELEE,
                    abilities: ["Lightning Spin"],
                    attack: 50,
                    damageMin: 100,
                    damageMax: 100,
                });
                const adjacent = createTestUnit({ name: "Adjacent", team: PBTypes.TeamVals.LEFT, maxHp: 10 });
                const distant = createTestUnit({ name: "Distant", team: PBTypes.TeamVals.LEFT, maxHp: 10 });
                placeUnit(ctx.grid, ctx.unitsHolder, hydra, { x: 2, y: 3 });
                placeUnit(ctx.grid, ctx.unitsHolder, adjacent, { x: 2, y: 4 });
                placeUnit(ctx.grid, ctx.unitsHolder, distant, { x: 12, y: 3 });
                const damage = createVisibleDamage(hydra);

                const result = ctx.attackHandler.handleObstacleAttack(
                    positionForCell(aimed),
                    ctx.unitsHolder,
                    ctx.moveHandler,
                    hydra,
                    { x: 2, y: 3 },
                    undefined,
                    damage,
                );

                expect(result.completed).toBe(true);
                expect(ctx.grid.getScatteredMountainsStanding()).toEqual([]);
                expect(adjacent.isDead()).toBe(true);
                expect(result.unitIdsDied).toEqual([adjacent.getId()]);
                expect(damage.secondary).toContainEqual(
                    expect.objectContaining({ source: "lightning_spin", unitId: adjacent.getId() }),
                );
                expect(distant.getCumulativeHp()).toBe(distant.getMaxHp());
            });

            it("a unit strike breaks the barrels around the attacker in the same spin", () => {
                const ctx = setupMountainFight();
                const beside = { x: 2, y: 4 };
                const diagonal = { x: 1, y: 2 };
                const outside = { x: 5, y: 3 };
                ctx.grid.setScatteredMountains([beside, outside, diagonal]);
                const hydra = createTestUnit({
                    team: PBTypes.TeamVals.RIGHT,
                    attackType: PBTypes.AttackVals.MELEE,
                    abilities: ["Lightning Spin"],
                });
                const target = createTestUnit({ name: "Target", team: PBTypes.TeamVals.LEFT, maxHp: 1000 });
                placeUnit(ctx.grid, ctx.unitsHolder, hydra, { x: 2, y: 3 });
                placeUnit(ctx.grid, ctx.unitsHolder, target, { x: 3, y: 3 });

                const result = ctx.attackHandler.handleMeleeAttack(
                    ctx.unitsHolder,
                    ctx.moveHandler,
                    createVisibleDamage(target),
                    undefined,
                    hydra,
                    target,
                    { x: 2, y: 3 },
                );

                expect(result.completed).toBe(true);
                expect(ctx.grid.getScatteredMountainsStanding()).toEqual([outside]);
                expect(result.spunObstacleCells).toHaveLength(2);
                expect(result.spunObstacleCells).toEqual(expect.arrayContaining([beside, diagonal]));
            });

            it("a plain unit strike leaves the barrels beside the attacker standing", () => {
                const ctx = setupMountainFight();
                const beside = { x: 2, y: 4 };
                ctx.grid.setScatteredMountains([beside]);
                const attacker = createTestUnit({ team: PBTypes.TeamVals.RIGHT, attackType: PBTypes.AttackVals.MELEE });
                const target = createTestUnit({ name: "Target", team: PBTypes.TeamVals.LEFT, maxHp: 1000 });
                placeUnit(ctx.grid, ctx.unitsHolder, attacker, { x: 2, y: 3 });
                placeUnit(ctx.grid, ctx.unitsHolder, target, { x: 3, y: 3 });

                const result = ctx.attackHandler.handleMeleeAttack(
                    ctx.unitsHolder,
                    ctx.moveHandler,
                    createVisibleDamage(target),
                    undefined,
                    attacker,
                    target,
                    { x: 2, y: 3 },
                );

                expect(result.completed).toBe(true);
                expect(ctx.grid.getScatteredMountainsStanding()).toEqual([beside]);
                expect(result.spunObstacleCells).toEqual([]);
            });
        });

        it("small melee unit strikes the left mountain from an outer (non-corridor) cell", () => {
            const { grid, unitsHolder, attackHandler, moveHandler, fightProperties } = setupMountainFight();
            const attacker = createTestUnit({ team: PBTypes.TeamVals.RIGHT, attackType: PBTypes.AttackVals.MELEE });
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
            const attacker = createTestUnit({ team: PBTypes.TeamVals.RIGHT, attackType: PBTypes.AttackVals.MELEE });
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
            const attacker = createTestUnit({ team: PBTypes.TeamVals.RIGHT, attackType: PBTypes.AttackVals.MELEE });
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
            const attacker = createTestUnit({ team: PBTypes.TeamVals.RIGHT, attackType: PBTypes.AttackVals.MELEE });
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
            const attacker = createTestUnit({ team: PBTypes.TeamVals.RIGHT, attackType: PBTypes.AttackVals.MELEE });
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
                team: PBTypes.TeamVals.RIGHT,
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
            const attacker = createTestUnit({ team: PBTypes.TeamVals.RIGHT });

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
