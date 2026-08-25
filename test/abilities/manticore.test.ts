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

import { processTerrifyingGazeAbility } from "../../src/abilities/terrifying_gaze_ability";
import { AbilityFactory } from "../../src/abilities/ability_factory";
import { AbilityPowerType } from "../../src/abilities/ability_properties";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { Unit } from "../../src/units/unit";
import { canApplyAuraEffect } from "../../src/effects/effect_helper";
import { AuraEffectProperties } from "../../src/effects/effect_properties";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

/** A unit built the way the game builds it: straight from creatures.json via the config provider. */
const createConfiguredUnit = (factionName: string, creatureName: string, team: PBTypes.TeamVals): Unit => {
    const effectFactory = new EffectFactory();
    const abilityFactory = new AbilityFactory(effectFactory);
    return Unit.createUnit(
        getCreatureConfig(team, factionName, creatureName, `${creatureName.toLowerCase()}_512`, 1),
        testGridSettings,
        team,
        PBTypes.UnitVals.CREATURE,
        abilityFactory,
        effectFactory,
        false,
    );
};

const wardingMane = () =>
    new AuraEffectProperties(
        "Warding Mane",
        2,
        "Affected allies gain {}% resistance to all magical attacks and debuffs.",
        20,
        true,
        AbilityPowerType.ADDITIONAL_MAGIC_RESIST_PERCENTAGE,
    );

describe("Manticore", () => {
    it("is configured as a Chaos level 2 mounted (2x1) flyer with its three abilities", () => {
        const config = getCreatureConfig(PBTypes.TeamVals.LOWER, "Chaos", "Manticore", "manticore_512", 1);
        expect(config.level).toBe(PBTypes.UnitLevelVals.SECOND);
        // Mounted class: the body is 2 cells long and 1 tall; `size` is the legacy art tier and must read
        // as the bigger square (size === max(width, height)).
        expect(config.size).toBe(PBTypes.UnitSizeVals.LARGE);
        expect([config.footprint_width, config.footprint_height]).toEqual([2, 1]);
        expect(config.movement_type).toBe(PBTypes.MovementVals.FLY);
        expect(config.attack_type).toBe(PBTypes.AttackVals.MELEE);
        expect(config.abilities).toEqual(["Warding Mane Aura", "Terrifying Gaze", "Deep Wounds Level 2"]);
    });

    describe("Warding Mane Aura", () => {
        it("is offered to allies of every attack type, unlike the range-only auras", () => {
            const aura = wardingMane();
            for (const attackType of [
                PBTypes.AttackVals.MELEE,
                PBTypes.AttackVals.RANGE,
                PBTypes.AttackVals.MAGIC,
                PBTypes.AttackVals.MELEE_MAGIC,
            ]) {
                expect(canApplyAuraEffect(createTestUnit({ attackType }), aura)).toBe(true);
            }
        });

        it("raises the holder's magic resist without ever reaching immunity", () => {
            const ally = createTestUnit({ name: "Ally", magicResist: 5 });
            ally.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);
            const before = ally.getMagicResist();

            ally.applyAuraEffect("Warding Mane Aura", "", true, 20, "1;1");
            ally.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);
            const after = ally.getMagicResist();

            expect(before).toBe(5);
            // Composed as an independent resistance roll, not a flat sum: 1 - (1 - 0.05)(1 - 0.20) = 24%.
            expect(after).toBeCloseTo(24, 1);
            expect(after).toBeLessThan(100);
        });

        it("reaches an ally standing in range through the real aura refresh", () => {
            const { grid, unitsHolder } = createCombatTestContext();
            const manticore = createTestUnit({
                name: "Manticore",
                team: PBTypes.TeamVals.LOWER,
                abilities: ["Warding Mane Aura"],
                auraEffects: ["Warding Mane"],
                auraRanges: [2],
                auraIsBuff: [true],
                magicResist: 5,
            });
            const nearAlly = createTestUnit({ name: "Near Ally", team: PBTypes.TeamVals.LOWER, magicResist: 8 });
            const farAlly = createTestUnit({ name: "Far Ally", team: PBTypes.TeamVals.LOWER, magicResist: 8 });

            placeUnit(grid, unitsHolder, manticore, { x: 2, y: 2 });
            placeUnit(grid, unitsHolder, nearAlly, { x: 3, y: 2 });
            placeUnit(grid, unitsHolder, farAlly, { x: 9, y: 9 });

            unitsHolder.refreshAuraEffectsForAllUnits();
            unitsHolder.refreshStackPowerForAllUnits();
            nearAlly.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);
            farAlly.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);

            // Full stack at the card's power of 30 projects the top of the 6/12/18/24/30 ladder.
            expect(nearAlly.getAppliedAuraEffect("Warding Mane Aura")?.getPower()).toBe(30);
            // Independent rolls, as everywhere else: 1 - (1 - 0.08)(1 - 0.30) = 35.6%.
            expect(nearAlly.getMagicResist()).toBeCloseTo(35.6, 1);
            expect(farAlly.getAppliedAuraEffect("Warding Mane Aura")).toBeUndefined();
            expect(farAlly.getMagicResist()).toBe(8);
        });

        it("carries its aura metadata through config_provider", () => {
            // Without this the aura is published with range 0 and silently reaches nobody.
            const manticore = createConfiguredUnit("Chaos", "Manticore", PBTypes.TeamVals.LOWER);
            expect(manticore.getAuraEffects().map((a) => a.getName())).toEqual(["Warding Mane"]);
            expect(manticore.getAuraEffects()[0].getRange()).toBe(2);
        });

        /**
         * Runs a config-built ally next to a config-built Manticore through the same refresh pair the sandbox's
         * refreshUnits() uses, and returns its live magic resist. Comparing WITH against WITHOUT is the only
         * honest measurement: refreshStackPowerForAllUnits already re-runs adjustBaseStats, so reading the same
         * unit "before and after" an explicit adjustBaseStats compares a value against itself.
         */
        const magicResistBesideManticore = (
            faction: string,
            name: string,
            withManticore: boolean,
            team: PBTypes.TeamVals = PBTypes.TeamVals.LOWER,
        ): { magicResist: number; hasAura: boolean } => {
            const { grid, unitsHolder } = createCombatTestContext();
            const subject = createConfiguredUnit(faction, name, team);
            placeUnit(grid, unitsHolder, subject, { x: 3, y: 2 });
            if (withManticore) {
                const manticore = createConfiguredUnit("Chaos", "Manticore", PBTypes.TeamVals.LOWER);
                placeUnit(grid, unitsHolder, manticore, { x: 2, y: 2 });
            }
            unitsHolder.refreshAuraEffectsForAllUnits();
            unitsHolder.refreshStackPowerForAllUnits();
            return {
                magicResist: subject.getMagicResist(),
                hasAura: !!subject.getAppliedAuraEffect("Warding Mane Aura"),
            };
        };

        it("raises a config-built ally's magic resist on the sandbox's own refresh path", () => {
            expect(magicResistBesideManticore("Chaos", "Troll", false).magicResist).toBe(5);
            // Warding Mane's full-stack power is 30 (the 6/12/18/24/30 ladder). The config-built
            // Manticore's own luck shifts the projection a point off the round number, hence 29 rather
            // than 30: 1 - (1 - 0.05)(1 - 0.29) = 32.55%.
            expect(magicResistBesideManticore("Chaos", "Troll", true).magicResist).toBeCloseTo(32.55, 1);
            // A zero-resist ally gets the aura's own value and nothing more.
            expect(magicResistBesideManticore("Life", "Peasant", false).magicResist).toBe(0);
            // …and it is the same 29 the Troll line above is derived from, which is what makes the two agree.
            expect(magicResistBesideManticore("Life", "Peasant", true).magicResist).toBeCloseTo(29, 0);
        });

        it("is a BUFF aura, so an enemy standing in range gets nothing", () => {
            const alone = magicResistBesideManticore("Life", "Monk", false, PBTypes.TeamVals.UPPER);
            const beside = magicResistBesideManticore("Life", "Monk", true, PBTypes.TeamVals.UPPER);

            expect(beside.hasAura).toBe(false);
            expect(beside.magicResist).toBe(alone.magicResist);
        });

        /**
         * Regression guard for a real report of "the aura does nothing". It composes as an INDEPENDENT
         * resistance roll, so on an ally who already resists a lot (the Monk's Magic Shield puts him near 55%)
         * the same aura only moves the number a few points — very easy to read as broken.
         */
        it("still lands on a high-resistance ally, just with a much smaller visible delta", () => {
            const alone = magicResistBesideManticore("Life", "Monk", false);
            const beside = magicResistBesideManticore("Life", "Monk", true);

            expect(beside.hasAura).toBe(true);
            expect(beside.magicResist).toBeGreaterThan(alone.magicResist);
            expect(beside.magicResist - alone.magicResist).toBeLessThan(5);
        });
    });

    describe("Terrifying Gaze", () => {
        const gazer = () =>
            createTestUnit({
                name: "Manticore",
                team: PBTypes.TeamVals.UPPER,
                abilities: ["Terrifying Gaze"],
                stackPower: 5,
            });

        it("bars the frightened unit from the gazer alone, and only for that one enemy", () => {
            const manticore = gazer();
            const bystander = createTestUnit({ name: "Bystander", team: PBTypes.TeamVals.UPPER });
            const victim = createTestUnit({ name: "Victim", team: PBTypes.TeamVals.LOWER });

            // Stack power 5 => 60% per hit; a handful of attempts makes a miss vanishingly unlikely.
            const sceneLog = new SceneLogMock();
            for (let attempt = 0; attempt < 40 && !victim.hasEffectActive("Terrifying Gaze"); attempt++) {
                processTerrifyingGazeAbility(manticore, victim, victim, sceneLog);
            }

            expect(victim.hasEffectActive("Terrifying Gaze")).toBe(true);
            expect(victim.getForbiddenTarget()).toBe(manticore.getId());
            expect(victim.cannotAttackUnitId(manticore.getId())).toBe(true);
            // The inverse of Aggr: everyone else stays a legal target.
            expect(victim.cannotAttackUnitId(bystander.getId())).toBe(false);
            // ...and it must not have narrowed the victim onto a forced target the way Aggr does.
            expect(victim.getTarget()).toBe("");
        });

        it("never lands on a mind-resistant target", () => {
            const manticore = gazer();
            const resistant = createTestUnit({
                name: "Mechanism",
                team: PBTypes.TeamVals.LOWER,
                abilities: ["Mechanism"],
            });
            const sceneLog = new SceneLogMock();

            for (let attempt = 0; attempt < 40; attempt++) {
                processTerrifyingGazeAbility(manticore, resistant, resistant, sceneLog);
            }

            expect(resistant.hasEffectActive("Terrifying Gaze")).toBe(false);
            expect(resistant.cannotAttackUnitId(manticore.getId())).toBe(false);
        });

        it("releases the victim once the effect expires", () => {
            const manticore = gazer();
            const victim = createTestUnit({ name: "Victim", team: PBTypes.TeamVals.LOWER });
            const sceneLog = new SceneLogMock();

            for (let attempt = 0; attempt < 40 && !victim.hasEffectActive("Terrifying Gaze"); attempt++) {
                processTerrifyingGazeAbility(manticore, victim, victim, sceneLog);
            }
            expect(victim.cannotAttackUnitId(manticore.getId())).toBe(true);

            victim.deleteEffect("Terrifying Gaze");
            victim.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);

            expect(victim.getForbiddenTarget()).toBe("");
            expect(victim.cannotAttackUnitId(manticore.getId())).toBe(false);
        });

        it("preserves the forbidden target through a ranked display-only status refresh", () => {
            const manticore = gazer();
            const victim = createTestUnit({ name: "Victim", team: PBTypes.TeamVals.LOWER });

            // Ranked reconstructs combat effects as display entries and keeps the server authoritative for
            // mechanics; it deliberately does not create Effect objects that could double-apply stats.
            victim.getUnitProperties().applied_debuffs.push("Terrifying Gaze");
            victim.getUnitProperties().applied_debuffs_laps.push(1);
            victim.getUnitProperties().applied_debuffs_descriptions.push("Cannot attack the gazer.");
            victim.getUnitProperties().applied_debuffs_powers.push(0);
            victim.setForbiddenTarget(manticore.getId());

            victim.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);

            expect(victim.hasEffectActive("Terrifying Gaze")).toBe(false);
            expect(victim.hasStatusApplied("Terrifying Gaze")).toBe(true);
            expect(victim.cannotAttackUnitId(manticore.getId())).toBe(true);
        });
    });
});
