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

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
    abilityToTextureName,
    getAbilitiesWithPosisionCoefficient,
    nextStandingTargets,
} from "../../src/abilities/ability_helper";
import { processBoarSalivaAbility } from "../../src/abilities/boar_saliva_ability";
import { getChainLightningTargets, processChainLightningAbility } from "../../src/abilities/chain_lightning_ability";
import { processAggrAbility } from "../../src/abilities/aggr_ability";
import { processBlindnessAbility } from "../../src/abilities/blindness_ability";
import { calculateActiveDeepWoundsEffect, processDeepWoundsAbility } from "../../src/abilities/deep_wounds_ability";
import { processDevourEssenceAbility } from "../../src/abilities/devour_essense_ability";
import { processDoublePunchAbility } from "../../src/abilities/double_punch_ability";
import { processDullingDefenseAblity } from "../../src/abilities/dulling_defense_ability";
import { evaluateAffectedUnits, processRangeAOEAbility } from "../../src/abilities/aoe_range_ability";
import { processDoubleShotAbility } from "../../src/abilities/double_shot_ability";
import { processFireShieldAbility } from "../../src/abilities/fire_shield_ability";
import { processFireBreathAbility } from "../../src/abilities/fire_breath_ability";
import { processLightningSpinAbility } from "../../src/abilities/lightning_spin_ability";
import { processLuckyStrikeAbility } from "../../src/abilities/lucky_strike_ability";
import { processMinerAbility } from "../../src/abilities/miner_ability";
import { processParalysisAbility } from "../../src/abilities/paralysis_ability";
import { processPegasusLightAbility } from "../../src/abilities/pegasus_light_ability";
import { processPetrifyingGazeAbility } from "../../src/abilities/petrifying_gaze_ability";
import { processRapidChargeAbility } from "../../src/abilities/rapid_charge_ability";
import { processShatterArmorAbility } from "../../src/abilities/shatter_armor_ability";
import { processSkewerStrikeAbility } from "../../src/abilities/skewer_strike_ability";
import { processSpitBallAbility } from "../../src/abilities/spit_ball_ability";
import { processStunAbility } from "../../src/abilities/stun_ability";
import { processThroughShotAbility } from "../../src/abilities/through_shot_ability";
import { getSpellConfig } from "../../src/configuration/config_provider";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Spell } from "../../src/spells/spell";
import {
    createCombatTestContext,
    createTestUnit,
    createVisibleDamage,
    DamageStatisticHolder,
    placeUnit,
} from "../helpers/combat";

describe("ability processors", () => {
    let restoreRandom: (() => void) | undefined;

    beforeEach(() => {
        restoreRandom = installMinimumRandom();
    });

    afterEach(() => {
        restoreRandom?.();
        restoreRandom = undefined;
    });

    it("selects positional ability coefficients and next standing targets", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const attacker = createTestUnit({
            team: PBTypes.TeamVals.LOWER,
            abilities: ["Backstab"],
        });
        const target = createTestUnit({ team: PBTypes.TeamVals.UPPER });
        const behindTarget = createTestUnit({ team: PBTypes.TeamVals.UPPER });

        placeUnit(grid, unitsHolder, attacker, { x: 5, y: 7 });
        placeUnit(grid, unitsHolder, target, { x: 5, y: 5 });
        placeUnit(grid, unitsHolder, behindTarget, { x: 5, y: 3 });

        expect(abilityToTextureName("Chain Lightning")).toBe("chain_lightning_256");
        expect(
            getAbilitiesWithPosisionCoefficient(
                attacker.getAbilities(),
                { x: 5, y: 7 },
                { x: 5, y: 5 },
                true,
                PBTypes.TeamVals.LOWER,
            ).map((ability) => ability.getName()),
        ).toEqual(["Backstab"]);
        expect(getAbilitiesWithPosisionCoefficient(attacker.getAbilities(), undefined, { x: 5, y: 5 }, true)).toEqual(
            [],
        );
        expect(
            getAbilitiesWithPosisionCoefficient(
                attacker.getAbilities(),
                { x: 5, y: 4 },
                { x: 5, y: 6 },
                false,
                PBTypes.TeamVals.UPPER,
            ).map((ability) => ability.getName()),
        ).toEqual(["Backstab"]);
        expect(nextStandingTargets(attacker, target, grid, unitsHolder).map((unit) => unit.getId())).toEqual([
            behindTarget.getId(),
        ]);
        expect(nextStandingTargets(attacker, target, grid, unitsHolder, undefined, true, true)).toEqual([behindTarget]);

        const largeContext = createCombatTestContext();
        const largeAttacker = createTestUnit({
            name: "Large Attacker",
            team: PBTypes.TeamVals.LOWER,
            size: PBTypes.UnitSizeVals.LARGE,
        });
        const largeTarget = createTestUnit({
            name: "Large Target",
            team: PBTypes.TeamVals.UPPER,
            size: PBTypes.UnitSizeVals.LARGE,
        });

        placeUnit(largeContext.grid, largeContext.unitsHolder, largeAttacker, { x: 8, y: 8 });
        placeUnit(largeContext.grid, largeContext.unitsHolder, largeTarget, { x: 6, y: 6 });

        expect(nextStandingTargets(largeAttacker, largeTarget, largeContext.grid, largeContext.unitsHolder)).toEqual(
            [],
        );
    });

    it("chains lightning through nearby enemies and records damage", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const stats = new DamageStatisticHolder();
        const attacker = createTestUnit({
            name: "Storm Caster",
            team: PBTypes.TeamVals.UPPER,
            abilities: ["Chain Lightning"],
            attack: 20,
            damageMin: 20,
            damageMax: 20,
            stackPower: 5,
        });
        const target = createTestUnit({ name: "Primary", team: PBTypes.TeamVals.LOWER, amountAlive: 3, maxHp: 20 });
        const layer1 = createTestUnit({ name: "Layer 1", team: PBTypes.TeamVals.LOWER, amountAlive: 3, maxHp: 20 });
        const layer2 = createTestUnit({ name: "Layer 2", team: PBTypes.TeamVals.LOWER, amountAlive: 3, maxHp: 20 });
        const layer3 = createTestUnit({ name: "Layer 3", team: PBTypes.TeamVals.LOWER, amountAlive: 3, maxHp: 20 });

        placeUnit(grid, unitsHolder, attacker, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, target, { x: 5, y: 5 });
        placeUnit(grid, unitsHolder, layer1, { x: 5, y: 6 });
        placeUnit(grid, unitsHolder, layer2, { x: 6, y: 6 });
        placeUnit(grid, unitsHolder, layer3, { x: 6, y: 7 });

        expect(getChainLightningTargets(target, grid, unitsHolder).map((unit) => unit.getName())).toEqual(
            expect.arrayContaining(["Primary", "Layer 1", "Layer 2", "Layer 3"]),
        );

        const unitIdsDied = processChainLightningAbility(
            attacker,
            target,
            40,
            grid,
            unitsHolder,
            new SceneLogMock(),
            stats,
        );

        expect(unitIdsDied).toEqual([]);
        expect(stats.get().length).toBeGreaterThanOrEqual(4);
        expect(target.getCumulativeHp()).toBeLessThan(target.getCumulativeMaxHp());
        expect(layer1.getCumulativeHp()).toBeLessThan(layer1.getCumulativeMaxHp());
    });

    it("applies chain lightning kill morale and magic mirror reflection", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const stats = new DamageStatisticHolder();
        const attacker = createTestUnit({
            name: "Fragile Caster",
            team: PBTypes.TeamVals.UPPER,
            abilities: ["Chain Lightning"],
            amountAlive: 1,
            maxHp: 10,
            attack: 20,
            damageMin: 20,
            damageMax: 20,
            stackPower: 5,
        });
        const target = createTestUnit({
            name: "Mirrored Primary",
            team: PBTypes.TeamVals.LOWER,
            amountAlive: 1,
            maxHp: 5,
        });
        const chainedTarget = createTestUnit({
            name: "Chained Neighbor",
            team: PBTypes.TeamVals.LOWER,
            amountAlive: 3,
            maxHp: 100,
        });
        const mirror = new Spell({
            spellProperties: getSpellConfig("Chaos", "Magic Mirror"),
            amount: 1,
        });
        mirror.setPower(100);
        target.applyBuff(mirror);

        placeUnit(grid, unitsHolder, attacker, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, target, { x: 5, y: 5 });
        placeUnit(grid, unitsHolder, chainedTarget, { x: 5, y: 6 });

        const unitIdsDied = processChainLightningAbility(
            attacker,
            target,
            20,
            grid,
            unitsHolder,
            new SceneLogMock(),
            stats,
        );

        expect(unitIdsDied).toEqual(expect.arrayContaining([target.getId(), attacker.getId()]));
        expect(target.isDead()).toBe(true);
        expect(attacker.isDead()).toBe(true);
        expect(stats.get()).toHaveLength(2);
    });

    it("runs lightning spin against adjacent enemies", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const stats = new DamageStatisticHolder();
        const attacker = createTestUnit({
            name: "Spinner",
            team: PBTypes.TeamVals.UPPER,
            abilities: ["Lightning Spin"],
            attack: 10,
            damageMin: 10,
            damageMax: 10,
            amountAlive: 2,
            stackPower: 5,
        });
        const enemyA = createTestUnit({ name: "Enemy A", team: PBTypes.TeamVals.LOWER, amountAlive: 2 });
        const enemyB = createTestUnit({ name: "Enemy B", team: PBTypes.TeamVals.LOWER, amountAlive: 2 });

        placeUnit(grid, unitsHolder, attacker, { x: 5, y: 5 });
        placeUnit(grid, unitsHolder, enemyA, { x: 5, y: 6 });
        placeUnit(grid, unitsHolder, enemyB, { x: 6, y: 5 });

        const result = processLightningSpinAbility(
            attacker,
            new SceneLogMock(),
            unitsHolder,
            1,
            stats,
            { x: 5, y: 5 },
            true,
        );

        expect(result.landed).toBe(true);
        expect(result.unitIdsDied.sort()).toEqual([enemyA.getId(), enemyB.getId()].sort());
        expect(stats.get()).toHaveLength(2);
        expect(enemyA.isDead()).toBe(true);
        expect(enemyB.isDead()).toBe(true);
    });

    it("processes ranged AOE abilities and evaluates affected units", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const stats = new DamageStatisticHolder();
        const attacker = createTestUnit({
            name: "Thrower",
            team: PBTypes.TeamVals.UPPER,
            attackType: PBTypes.AttackVals.RANGE,
            abilities: ["Area Throw"],
            attack: 10,
            damageMin: 10,
            damageMax: 10,
            rangeShots: 2,
            amountAlive: 1,
            stackPower: 5,
        });
        const targetA = createTestUnit({ name: "Target A", team: PBTypes.TeamVals.LOWER, amountAlive: 2 });
        const targetB = createTestUnit({ name: "Target B", team: PBTypes.TeamVals.LOWER, amountAlive: 2 });

        placeUnit(grid, unitsHolder, attacker, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, targetA, { x: 7, y: 7 });
        placeUnit(grid, unitsHolder, targetB, { x: 7, y: 8 });

        expect(
            evaluateAffectedUnits(
                [
                    { x: 7, y: 7 },
                    { x: 7, y: 7 },
                    { x: 7, y: 8 },
                ],
                unitsHolder,
                grid,
            ),
        ).toEqual([
            [targetA, targetB],
            [targetA, targetB],
        ]);
        expect(evaluateAffectedUnits([{ x: 2, y: 2 }], unitsHolder, grid)).toBeUndefined();

        const result = processRangeAOEAbility(
            attacker,
            [targetA, targetB],
            attacker,
            1,
            unitsHolder,
            grid,
            new SceneLogMock(),
            stats,
            true,
        );

        expect(result.landed).toBe(true);
        expect(result.maxDamage).toBe(10);
        expect(result.unitIdsDied).toEqual([]);
        expect(attacker.getRangeShots()).toBe(1);
        expect(stats.get()).toHaveLength(2);
    });

    it("processes through-shot lanes and records secondary deaths", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const stats = new DamageStatisticHolder();
        const attacker = createTestUnit({
            name: "Piercer",
            team: PBTypes.TeamVals.UPPER,
            attackType: PBTypes.AttackVals.RANGE,
            abilities: ["Through Shot"],
            attack: 10,
            damageMin: 10,
            damageMax: 10,
            rangeShots: 2,
            stackPower: 100,
        });
        const frontTarget = createTestUnit({
            name: "Front",
            team: PBTypes.TeamVals.LOWER,
            amountAlive: 2,
            maxHp: 25,
        });
        const rearTarget = createTestUnit({
            name: "Rear",
            team: PBTypes.TeamVals.LOWER,
            amountAlive: 1,
            maxHp: 5,
        });

        placeUnit(grid, unitsHolder, attacker, { x: 5, y: 9 });
        placeUnit(grid, unitsHolder, frontTarget, { x: 5, y: 7 });
        placeUnit(grid, unitsHolder, rearTarget, { x: 5, y: 5 });

        const result = processThroughShotAbility(
            attacker,
            [[frontTarget], [rearTarget], []],
            attacker,
            [1, 1, 1],
            rearTarget.getPosition(),
            unitsHolder,
            grid,
            new SceneLogMock(),
            stats,
        );

        expect(result.landed).toBe(true);
        expect(result.unitIdsDied).toEqual([rearTarget.getId()]);
        expect(result.animationData).toHaveLength(1);
        expect(result.animationData[0].affectedUnit).toBe(rearTarget);
        expect(stats.get()).toHaveLength(2);
        expect(frontTarget.getCumulativeHp()).toBeLessThan(frontTarget.getCumulativeMaxHp());
        expect(rearTarget.isDead()).toBe(true);
        expect(attacker.getRangeShots()).toBe(1);
    });

    it("applies double shot direct damage and rejected preconditions", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const stats = new DamageStatisticHolder();
        const attacker = createTestUnit({
            name: "Repeater",
            team: PBTypes.TeamVals.UPPER,
            attackType: PBTypes.AttackVals.RANGE,
            abilities: ["Double Shot"],
            attack: 10,
            damageMin: 10,
            damageMax: 10,
            rangeShots: 2,
            stackPower: 100,
        });
        const target = createTestUnit({
            name: "Target",
            team: PBTypes.TeamVals.LOWER,
            amountAlive: 2,
            maxHp: 20,
        });

        placeUnit(grid, unitsHolder, attacker, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, target, { x: 7, y: 7 });

        const damageForAnimation = createVisibleDamage(target);
        const result = processDoubleShotAbility(
            attacker,
            target,
            [],
            new SceneLogMock(),
            unitsHolder,
            grid,
            1,
            target.getPosition(),
            damageForAnimation,
            stats,
            false,
        );

        expect(result.applied).toBe(true);
        expect(result.aoeRangeAttackLanded).toBe(false);
        expect(result.damage).toBeGreaterThan(0);
        expect(result.animationData[0].affectedUnit).toBe(target);
        expect(damageForAnimation.render).toBe(true);
        expect(damageForAnimation.amount).toBe(result.damage);
        expect(stats.get()).toHaveLength(1);
        expect(target.getCumulativeHp()).toBeLessThan(target.getCumulativeMaxHp());

        attacker.setTarget("someone-else");
        expect(
            processDoubleShotAbility(
                attacker,
                target,
                [],
                new SceneLogMock(),
                unitsHolder,
                grid,
                1,
                target.getPosition(),
                createVisibleDamage(target),
                stats,
                false,
            ).applied,
        ).toBe(false);
    });

    it("logs the Double Shot second attack with the range icon, not the literal 'attk'", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const lines: string[] = [];
        const capturingLog = {
            getLog: () => lines.join("\n"),
            updateLog: (line?: string) => {
                if (line) lines.push(line);
            },
            hasBeenUpdated: () => true,
        };
        const attacker = createTestUnit({
            name: "Repeater",
            team: PBTypes.TeamVals.UPPER,
            attackType: PBTypes.AttackVals.RANGE,
            abilities: ["Double Shot"],
            attack: 10,
            damageMin: 10,
            damageMax: 10,
            rangeShots: 2,
            stackPower: 100,
        });
        const target = createTestUnit({ name: "Target", team: PBTypes.TeamVals.LOWER, amountAlive: 2, maxHp: 20 });
        placeUnit(grid, unitsHolder, attacker, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, target, { x: 7, y: 7 });

        processDoubleShotAbility(
            attacker,
            target,
            [],
            capturingLog,
            unitsHolder,
            grid,
            1,
            target.getPosition(),
            createVisibleDamage(target),
            new DamageStatisticHolder(),
            false,
        );

        const hitLine = lines.find((l) => l.includes(target.getName()) && l.includes("("));
        expect(hitLine).toBeDefined();
        // The second (Double Shot) strike must read like the first: 🏹 for a ranged hit, never " attk ".
        expect(hitLine).toContain("🏹");
        expect(hitLine).not.toContain(" attk ");
    });

    it("uses double shot to trigger ranged AOE damage when available", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const stats = new DamageStatisticHolder();
        const attacker = createTestUnit({
            name: "Volley",
            team: PBTypes.TeamVals.UPPER,
            attackType: PBTypes.AttackVals.RANGE,
            abilities: ["Double Shot", "Area Throw"],
            attack: 10,
            damageMin: 10,
            damageMax: 10,
            rangeShots: 3,
            stackPower: 100,
        });
        const targetA = createTestUnit({ name: "Cluster A", team: PBTypes.TeamVals.LOWER, amountAlive: 2 });
        const targetB = createTestUnit({ name: "Cluster B", team: PBTypes.TeamVals.LOWER, amountAlive: 2 });

        placeUnit(grid, unitsHolder, attacker, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, targetA, { x: 7, y: 7 });
        placeUnit(grid, unitsHolder, targetB, { x: 7, y: 8 });

        const result = processDoubleShotAbility(
            attacker,
            targetA,
            [targetA, targetB],
            new SceneLogMock(),
            unitsHolder,
            grid,
            1,
            targetA.getPosition(),
            createVisibleDamage(targetA),
            stats,
            true,
        );

        expect(result.applied).toBe(true);
        expect(result.aoeRangeAttackLanded).toBe(true);
        expect(result.damage).toBe(10);
        expect(result.unitIdsDied).toEqual([]);
        expect(stats.get()).toHaveLength(2);
    });

    it("processes skewer strike against the next standing target", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const stats = new DamageStatisticHolder();
        const attacker = createTestUnit({
            name: "Skewer",
            team: PBTypes.TeamVals.LOWER,
            abilities: ["Skewer Strike"],
            attack: 20,
            damageMin: 20,
            damageMax: 20,
            stackPower: 100,
        });
        const primary = createTestUnit({ name: "Primary", team: PBTypes.TeamVals.UPPER, amountAlive: 3, maxHp: 30 });
        const behind = createTestUnit({ name: "Behind", team: PBTypes.TeamVals.UPPER, amountAlive: 1, maxHp: 5 });

        placeUnit(grid, unitsHolder, attacker, { x: 5, y: 7 });
        placeUnit(grid, unitsHolder, primary, { x: 5, y: 5 });
        placeUnit(grid, unitsHolder, behind, { x: 5, y: 3 });

        const result = processSkewerStrikeAbility(attacker, primary, new SceneLogMock(), unitsHolder, grid, stats);

        expect(result.unitIdsDied).toEqual([behind.getId()]);
        expect(result.increaseMorale).toBeGreaterThan(0);
        expect(result.moraleDecreaseForTheUnitTeam).toEqual({
            [`${behind.getName()}:${behind.getTeam()}`]: result.increaseMorale,
        });
        expect(result.secondaryDamages).toHaveLength(1);
        expect(result.secondaryDamages[0]).toMatchObject({
            unitId: behind.getId(),
            unitIsSmall: true,
            unitsDied: 1,
        });
        expect(stats.get()).toHaveLength(1);
        expect(behind.isDead()).toBe(true);

        const noAbility = createTestUnit({ name: "Plain", team: PBTypes.TeamVals.LOWER });
        expect(
            processSkewerStrikeAbility(noAbility, primary, new SceneLogMock(), unitsHolder, grid, stats)
                .secondaryDamages,
        ).toEqual([]);
    });

    it("processes fire breath with magic resistance and heavy armor modifiers", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const stats = new DamageStatisticHolder();
        const attacker = createTestUnit({
            name: "Dragon",
            team: PBTypes.TeamVals.LOWER,
            abilities: ["Fire Breath"],
            attack: 20,
            damageMin: 20,
            damageMax: 20,
            stackPower: 100,
        });
        const primary = createTestUnit({ name: "Primary", team: PBTypes.TeamVals.UPPER, amountAlive: 3, maxHp: 30 });
        const behind = createTestUnit({
            name: "Armored",
            team: PBTypes.TeamVals.UPPER,
            abilities: ["Heavy Armor"],
            amountAlive: 1,
            maxHp: 5,
            magicResist: 25,
            stackPower: 100,
        });

        placeUnit(grid, unitsHolder, attacker, { x: 5, y: 7 });
        placeUnit(grid, unitsHolder, primary, { x: 5, y: 5 });
        placeUnit(grid, unitsHolder, behind, { x: 5, y: 3 });

        const result = processFireBreathAbility(
            attacker,
            primary,
            new SceneLogMock(),
            unitsHolder,
            grid,
            "attk",
            stats,
        );

        expect(result.unitIdsDied).toEqual([behind.getId()]);
        expect(result.increaseMorale).toBeGreaterThan(0);
        expect(result.moraleDecreaseForTheUnitTeam).toEqual({
            [`${behind.getName()}:${behind.getTeam()}`]: result.increaseMorale,
        });
        expect(stats.get()).toHaveLength(1);
        expect(behind.isDead()).toBe(true);
    });

    it("processes standalone status and effect abilities deterministically", () => {
        const sceneLog = new SceneLogMock();
        const attacker = createTestUnit({
            name: "Controller",
            team: PBTypes.TeamVals.UPPER,
            abilities: [
                "Stun",
                "Paralysis",
                "Shatter Armor",
                "Boar Saliva",
                "Pegasus Light",
                "Deep Wounds Level 1",
                "Deep Wounds Level 2",
                "Deep Wounds Level 3",
            ],
            luck: 100,
            stackPower: 100,
        });
        const target = createTestUnit({
            name: "Target",
            team: PBTypes.TeamVals.LOWER,
            amountAlive: 3,
        });
        const mechanism = createTestUnit({
            name: "Mechanism",
            team: PBTypes.TeamVals.LOWER,
            abilities: ["Mechanism"],
            amountAlive: 3,
        });
        const resisted = createTestUnit({
            name: "Mindless",
            team: PBTypes.TeamVals.LOWER,
            abilities: ["Mechanism"],
        });

        expect(calculateActiveDeepWoundsEffect(attacker, target)).toBe(0);

        processDeepWoundsAbility(attacker, target, target, sceneLog);
        processShatterArmorAbility(attacker, target, target, sceneLog);
        processBoarSalivaAbility(attacker, target, target, sceneLog);
        processPegasusLightAbility(attacker, target, target, sceneLog);
        processParalysisAbility(attacker, mechanism, mechanism, sceneLog);
        processStunAbility(attacker, mechanism, mechanism, sceneLog);
        processBoarSalivaAbility(attacker, resisted, resisted, sceneLog);

        expect(target.hasEffectActive("Deep Wounds")).toBe(true);
        expect(calculateActiveDeepWoundsEffect(attacker, target)).toBeGreaterThan(0);
        expect(target.hasEffectActive("Shatter Armor")).toBe(true);
        expect(target.hasEffectActive("Boar Saliva")).toBe(true);
        expect(target.hasEffectActive("Pegasus Light")).toBe(true);
        expect(mechanism.hasEffectActive("Paralysis")).toBe(true);
        expect(mechanism.hasEffectActive("Stun")).toBe(true);
        expect(resisted.hasEffectActive("Boar Saliva")).toBe(false);

        processStunAbility(attacker, mechanism, mechanism, sceneLog);
        processParalysisAbility(attacker, mechanism, mechanism, sceneLog);

        expect(mechanism.hasEffectActive("Stun")).toBe(true);
        expect(mechanism.hasEffectActive("Paralysis")).toBe(true);
    });

    it("processes low-level melee utility abilities", () => {
        const miner = createTestUnit({
            name: "Miner",
            team: PBTypes.TeamVals.UPPER,
            abilities: ["Miner", "Rapid Charge"],
            stackPower: 100,
            armor: 10,
        });
        const defender = createTestUnit({
            name: "Defender",
            team: PBTypes.TeamVals.LOWER,
            armor: 10,
        });
        const duller = createTestUnit({
            name: "Duller",
            team: PBTypes.TeamVals.LOWER,
            abilities: ["Dulling Defense"],
            stackPower: 100,
        });
        const attacker = createTestUnit({
            name: "Attacker",
            team: PBTypes.TeamVals.UPPER,
            attack: 10,
        });
        const sceneLog = new SceneLogMock();

        processMinerAbility(miner, defender, sceneLog);
        processDullingDefenseAblity(duller, attacker, sceneLog);
        miner.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);
        defender.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);
        attacker.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);

        expect(miner.getBaseArmor()).toBeGreaterThan(10);
        expect(defender.getBaseArmor()).toBeLessThan(10);
        expect(attacker.getBaseAttack()).toBeLessThan(10);
        expect(processRapidChargeAbility(miner, 3)).toBeGreaterThan(1);
        expect(processRapidChargeAbility(defender, 3)).toBe(1);
    });

    it("applies mind-control skip effects and respects mind resistance", () => {
        const aggrCaster = createTestUnit({
            name: "Agitator",
            team: PBTypes.TeamVals.UPPER,
            abilities: ["Aggr"],
            stackPower: 3,
        });
        const blindCaster = createTestUnit({
            name: "Blinder",
            team: PBTypes.TeamVals.UPPER,
            abilities: ["Blindness"],
            stackPower: 5,
        });
        const target = createTestUnit({ name: "Target", team: PBTypes.TeamVals.LOWER });
        const resistant = createTestUnit({
            name: "Mechanism",
            team: PBTypes.TeamVals.LOWER,
            abilities: ["Mechanism"],
        });
        const sceneLog = new SceneLogMock();

        processAggrAbility(aggrCaster, target, target, sceneLog);
        processAggrAbility(aggrCaster, target, target, sceneLog);
        processBlindnessAbility(blindCaster, target, target, sceneLog);
        processAggrAbility(aggrCaster, resistant, resistant, sceneLog);
        processBlindnessAbility(blindCaster, resistant, resistant, sceneLog);

        expect(target.hasEffectActive("Aggr")).toBe(true);
        expect(target.getTarget()).toBe(aggrCaster.getId());
        expect(target.hasEffectActive("Blindness")).toBe(true);
        expect(resistant.hasEffectActive("Aggr")).toBe(false);
        expect(resistant.hasEffectActive("Blindness")).toBe(false);
    });

    it("processes petrifying gaze damage and resistant targets", () => {
        const stats = new DamageStatisticHolder();
        const attacker = createTestUnit({
            name: "Gazer",
            team: PBTypes.TeamVals.UPPER,
            abilities: ["Petrifying Gaze"],
            luck: 100,
            stackPower: 100,
        });
        const target = createTestUnit({
            name: "Victim",
            team: PBTypes.TeamVals.LOWER,
            amountAlive: 5,
            maxHp: 10,
        });
        const resistant = createTestUnit({
            name: "Mechanism",
            team: PBTypes.TeamVals.LOWER,
            abilities: ["Mechanism"],
            amountAlive: 5,
            maxHp: 10,
        });

        processPetrifyingGazeAbility(attacker, resistant, 100, new SceneLogMock(), stats);
        expect(stats.get()).toHaveLength(0);

        processPetrifyingGazeAbility(attacker, target, 100, new SceneLogMock(), stats);

        expect(stats.get()).toHaveLength(1);
        expect(target.getAmountAlive()).toBeLessThan(5);
    });

    it("processes double punch damage, miss branch, and lucky strike", () => {
        const sceneLog = new SceneLogMock();
        const attacker = createTestUnit({
            name: "Brawler",
            team: PBTypes.TeamVals.UPPER,
            abilities: ["Double Punch", "Lucky Strike", "Penetrating Bite"],
            attack: 10,
            damageMin: 10,
            damageMax: 10,
            luck: 100,
            stackPower: 100,
        });
        const target = createTestUnit({
            name: "Target",
            team: PBTypes.TeamVals.LOWER,
            amountAlive: 3,
            maxHp: 30,
        });
        const dodger = createTestUnit({
            name: "Dodger",
            team: PBTypes.TeamVals.LOWER,
            abilities: ["Dodge"],
            luck: 100,
            stackPower: 100,
        });
        const plain = createTestUnit({ name: "Plain", team: PBTypes.TeamVals.UPPER });

        const result = processDoublePunchAbility(attacker, target, sceneLog);
        const missed = processDoublePunchAbility(attacker, dodger, sceneLog);
        const skipped = processDoublePunchAbility(plain, target, sceneLog);

        expect(result.applied).toBe(true);
        expect(result.missed).toBe(false);
        expect(result.damage).toBeGreaterThan(0);
        expect(missed.applied).toBe(true);
        expect(missed.missed).toBe(true);
        expect(skipped.applied).toBe(false);
        expect(processLuckyStrikeAbility(attacker, 10, sceneLog)).toBeGreaterThan(10);
        expect(processLuckyStrikeAbility(plain, 10, sceneLog)).toBe(10);
    });

    it("processes fire shield retaliation and devour essence healing", () => {
        const { unitsHolder, grid } = createCombatTestContext();
        const stats = new DamageStatisticHolder();
        const fireShield = createTestUnit({
            name: "Shield",
            team: PBTypes.TeamVals.UPPER,
            abilities: ["Fire Shield"],
            luck: 100,
            stackPower: 100,
        });
        const heavyTarget = createTestUnit({
            name: "Heavy",
            team: PBTypes.TeamVals.LOWER,
            abilities: ["Heavy Armor"],
            amountAlive: 1,
            maxHp: 5,
            magicResist: 25,
            stackPower: 100,
        });
        const devourer = createTestUnit({
            name: "Devourer",
            team: PBTypes.TeamVals.UPPER,
            abilities: ["Devour Essence"],
            amountAlive: 1,
            maxHp: 20,
            luck: 100,
            stackPower: 100,
        });
        const killedEnemy = createTestUnit({
            name: "Killed",
            team: PBTypes.TeamVals.LOWER,
        });

        placeUnit(grid, unitsHolder, devourer, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, killedEnemy, { x: 2, y: 2 });

        const shieldResult = processFireShieldAbility(
            fireShield,
            heavyTarget,
            new SceneLogMock(),
            20,
            unitsHolder,
            stats,
        );

        devourer.applyDamage(15, 0, new SceneLogMock());
        processDevourEssenceAbility(
            devourer,
            [killedEnemy.getId(), killedEnemy.getId()],
            unitsHolder,
            new SceneLogMock(),
        );

        expect(shieldResult.unitIdsDied).toEqual([heavyTarget.getId()]);
        expect(shieldResult.increaseMorale).toBeGreaterThan(0);
        expect(stats.get()).toHaveLength(1);
        expect(devourer.getHp()).toBe(20);
    });

    it("processes spit ball application, resistance, and exhausted debuff pools", () => {
        const { unitsHolder, grid } = createCombatTestContext();
        const attacker = createTestUnit({
            name: "Spitter",
            team: PBTypes.TeamVals.UPPER,
            abilities: ["Spit Ball"],
            luck: 100,
            stackPower: 100,
        });
        const rangedTarget = createTestUnit({
            name: "Ranged",
            team: PBTypes.TeamVals.LOWER,
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 2,
        });
        const resistant = createTestUnit({
            name: "Resistant",
            team: PBTypes.TeamVals.LOWER,
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 2,
            magicResist: 100,
        });

        placeUnit(grid, unitsHolder, attacker, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, rangedTarget, { x: 2, y: 2 });
        placeUnit(grid, unitsHolder, resistant, { x: 3, y: 3 });

        processSpitBallAbility(attacker, rangedTarget, rangedTarget, unitsHolder, grid, new SceneLogMock());
        processSpitBallAbility(attacker, rangedTarget, rangedTarget, unitsHolder, grid, new SceneLogMock());
        processSpitBallAbility(attacker, resistant, resistant, unitsHolder, grid, new SceneLogMock());

        expect(rangedTarget.hasDebuffActive("Sadness")).toBe(true);
        expect(rangedTarget.hasDebuffActive("Quagmire")).toBe(true);
        expect(rangedTarget.hasDebuffActive("Weakening Beam")).toBe(true);
        expect(rangedTarget.hasDebuffActive("Weakness")).toBe(true);
        expect(rangedTarget.hasDebuffActive("Rangebane")).toBe(true);
        expect(rangedTarget.hasDebuffActive("Cowardice")).toBe(true);
        expect(resistant.hasDebuffActive("Sadness")).toBe(false);
    });
});

function installMinimumRandom(): () => void {
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    let uuidSeed = 1;
    const cryptoMock = {
        getRandomValues<T extends ArrayBufferView>(array: T): T {
            const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
            bytes.fill(0);
            if (bytes.length === 16) {
                let value = uuidSeed++;
                for (let i = bytes.length - 1; i >= 0 && value > 0; i--) {
                    bytes[i] = value & 0xff;
                    value >>= 8;
                }
            }
            return array;
        },
    };

    Object.defineProperty(globalThis, "crypto", {
        configurable: true,
        value: cryptoMock,
    });

    return () => {
        if (originalDescriptor) {
            Object.defineProperty(globalThis, "crypto", originalDescriptor);
        } else {
            Reflect.deleteProperty(globalThis, "crypto");
        }
    };
}
