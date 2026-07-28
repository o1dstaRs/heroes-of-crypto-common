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

import creaturesJson from "../../src/configuration/creatures.json";
import spellsJson from "../../src/configuration/spells.json";
import { MAX_UNIT_STACK_POWER, NUMBER_OF_LAPS_TOTAL } from "../../src/constants";
import { getSpellConfig } from "../../src/configuration/config_provider";
import { GameActionEngine } from "../../src/engine/action_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { CreatureFactions } from "../../src/generated/protobuf/v1/creature_gen";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { amountForCreatureExperienceBudget, STACK_EXPERIENCE_BUDGET } from "../../src/simulation/army";
import { applyMagicResistToSpellDamage, calculateStackPoweredSpellDamage } from "../../src/spells/spell_damage";
import { Spell } from "../../src/spells/spell";
import { SpellMultiplierType, SpellTargetType } from "../../src/spells/spell_properties";
import type { Unit } from "../../src/units/unit";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const battleMage = (creaturesJson as unknown as Record<string, Record<string, Record<string, never>>>).Life[
    "Battle Mage"
] as unknown as {
    hp: number;
    armor: number;
    attack_type: string;
    movement_type: string;
    magic_resist: number;
    exp: number;
    size: number;
    level: number;
    spells: string[];
    abilities: string[];
};
const lifeSpells = (spellsJson as unknown as Record<string, Record<string, { power: number }>>).Life;

/**
 * A fight with the Battle Mage on the LOWER team and whatever enemies a test asks for. Deliberately local
 * rather than reusing action_engine.test.ts's harness: these tests need control of the caster's head-count
 * (the damage formula reads it) and more than one enemy on the board (Meteorite hits a 2x2).
 *
 * `enemies` are placed as-given; the caster always stands on (3,3).
 */
const setupMageFight = (opts: {
    casterAmountAlive: number;
    casterStackPower: number;
    spells?: string[];
    enemies?: { cell: { x: number; y: number }; maxHp?: number; magicResist?: number; amountAlive?: number }[];
    allyCell?: { x: number; y: number };
    blockerCell?: { x: number; y: number };
}) => {
    const context = createCombatTestContext(PBTypes.GridVals.NORMAL);
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(PBTypes.GridVals.NORMAL);
    fightProperties.startFight();

    const caster = createTestUnit({
        name: "Battle Mage",
        team: PBTypes.TeamVals.LOWER,
        attackType: PBTypes.AttackVals.MELEE_MAGIC,
        spells: opts.spells ?? ["Life:Fire Strike", "Life:Fire Strike", "Life:Fire Strike", "Life:Meteorite"],
        amountAlive: opts.casterAmountAlive,
        stackPower: opts.casterStackPower,
        speed: 5,
        morale: 4,
    });
    placeUnit(context.grid, context.unitsHolder, caster, { x: 3, y: 3 });

    const enemies: Unit[] = [];
    for (const [index, spec] of (opts.enemies ?? []).entries()) {
        const enemy = createTestUnit({
            name: `Enemy ${index}`,
            team: PBTypes.TeamVals.UPPER,
            maxHp: spec.maxHp ?? 10_000, // survives by default, so a test reads damage rather than a death
            magicResist: spec.magicResist ?? 0,
            amountAlive: spec.amountAlive ?? 1,
            speed: 3,
            morale: 4,
        });
        placeUnit(context.grid, context.unitsHolder, enemy, spec.cell);
        enemies.push(enemy);
    }

    let ally: Unit | undefined;
    if (opts.allyCell) {
        ally = createTestUnit({
            name: "Friend",
            team: PBTypes.TeamVals.LOWER,
            maxHp: 10_000,
            speed: 2,
        });
        placeUnit(context.grid, context.unitsHolder, ally, opts.allyCell);
    }
    if (opts.blockerCell) {
        const blocker = createTestUnit({ name: "Blocker", team: PBTypes.TeamVals.LOWER, maxHp: 10_000, speed: 2 });
        placeUnit(context.grid, context.unitsHolder, blocker, opts.blockerCell);
    }

    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LOWER, 1 + (ally ? 1 : 0));
    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.UPPER, Math.max(1, enemies.length));
    fightProperties.startTurn(PBTypes.TeamVals.LOWER, 1000);

    const sceneLog = new SceneLogMock();
    const moveHandler = new MoveHandler(context.grid.getSettings(), context.grid, context.unitsHolder);
    const engine = new GameActionEngine({
        fightProperties,
        grid: context.grid,
        unitsHolder: context.unitsHolder,
        moveHandler,
        sceneLog,
        attackHandler: context.attackHandler,
        getCurrentActiveUnitId: () => caster.getId(),
    });

    return { ...context, fightProperties, caster, enemies, ally, engine, sceneLog };
};

// The Magic Dragon formula: creatures alive x stack power x the spell's damage multiplier. It lives in one
// place because the spellbook card, AI estimate and engine cast must agree.
describe("stack-powered spell damage formula", () => {
    it("multiplies creatures alive by stack power by the spell multiplier", () => {
        expect(calculateStackPoweredSpellDamage(0.8, 38, 5)).toBe(152); // 38 * 5 * 0.8
        expect(calculateStackPoweredSpellDamage(0.8, 38, 3)).toBe(91); // floor(38 * 3 * 0.8) = floor(91.2)
        expect(calculateStackPoweredSpellDamage(0.8, 10, 1)).toBe(8);
    });

    it("floors the result and never goes negative", () => {
        expect(calculateStackPoweredSpellDamage(0.48, 7, 1)).toBe(3); // floor(3.36)
        expect(calculateStackPoweredSpellDamage(0.8, 0, 5)).toBe(0);
        expect(calculateStackPoweredSpellDamage(0.8, -5, 5)).toBe(0);
    });

    it("clamps stack power to the engine's 0..MAX band", () => {
        const atMax = calculateStackPoweredSpellDamage(0.8, 38, MAX_UNIT_STACK_POWER);
        expect(calculateStackPoweredSpellDamage(0.8, 38, MAX_UNIT_STACK_POWER + 7)).toBe(atMax);
        expect(calculateStackPoweredSpellDamage(0.8, 38, -2)).toBe(0);
    });

    it("cuts damage by the target's magic resistance and ignores armor entirely", () => {
        expect(applyMagicResistToSpellDamage(152, 0)).toBe(152);
        expect(applyMagicResistToSpellDamage(152, 5)).toBe(144); // floor(152 * 0.95)
        expect(applyMagicResistToSpellDamage(152, 100)).toBe(0);
    });
});

// The two spells are a matched flat-per-caster pair: Meteorite is one third below Fire Strike because it hits
// a whole 2x2 at once. Pin that in the config so a later tweak cannot silently break the relationship.
describe("Battle Mage spell configuration", () => {
    it("prices Fire Strike at 6 per mage and Meteorite a third under it, at 4", () => {
        expect(lifeSpells["Fire Strike"].power).toBe(6);
        expect(lifeSpells.Meteorite.power).toBe(4);
    });

    it("gives Fire Strike 3 scrolls at stack power 1 and Meteorite 1 scroll at stack power 5", () => {
        const fireStrikes = battleMage.spells.filter((entry) => entry === "Life:Fire Strike");
        const meteorites = battleMage.spells.filter((entry) => entry === "Life:Meteorite");
        expect(fireStrikes).toHaveLength(3);
        expect(meteorites).toHaveLength(1);

        expect(getSpellConfig("Life", "Fire Strike").minimal_caster_stack_power).toBe(1);
        expect(getSpellConfig("Life", "Meteorite").minimal_caster_stack_power).toBe(5);
    });

    // Head-count damage, NOT stack-powered: stack power is only the gate on casting (the scroll counts
    // above), so a worn-down stack throws full-strength fireballs — there are just fewer mages left.
    it("marks both spells as head-count damage aimed the way the brief asked", () => {
        const fireStrike = getSpellConfig("Life", "Fire Strike");
        const meteorite = getSpellConfig("Life", "Meteorite");

        for (const spell of [fireStrike, meteorite]) {
            expect(spell.multiplier_type).toBe(SpellMultiplierType.UNIT_AMOUNT_DAMAGE);
            expect(spell.is_buff).toBe(false);
        }
        // Fire Strike is aimed at a creature; Meteorite is aimed at a spot on the ground.
        expect(fireStrike.spell_target_type).toBe(SpellTargetType.ANY_ENEMY);
        expect(meteorite.spell_target_type).toBe(SpellTargetType.FREE_CELL);
    });

    it("is a level 2 walking human caster carrying the tome, sized like every other level 2", () => {
        expect(battleMage.level).toBe(2);
        expect(battleMage.size).toBe(1);
        expect(battleMage.movement_type).toBe("WALK");
        expect(battleMage.attack_type).toBe("MELEE_MAGIC");
        expect(battleMage.magic_resist).toBe(5); // every level 2 creature carries 5
        expect(battleMage.abilities).toEqual(["Basic Tome of Battle Magic"]);
    });

    // He is one of the HUMANS ("люди" = the Life faction), and he is the fourth level-2 human — Life had only
    // three where every other faction fields four. Pin both, since he was briefly filed under Might by mistake.
    it("is a human (Life) creature and completes Life's level 2 row to four", () => {
        const creatures = creaturesJson as unknown as Record<string, Record<string, { level: number }>>;
        expect(Object.keys(creatures.Life)).toContain("Battle Mage");
        expect(Object.keys(creatures.Might)).not.toContain("Battle Mage");
        expect(CreatureFactions[PBTypes.CreatureVals.BATTLE_MAGE]).toBe(PBTypes.FactionVals.LIFE);

        const levelTwoPerFaction = (faction: string): number =>
            Object.values(creatures[faction]).filter((creature) => creature.level === 2).length;
        expect(levelTwoPerFaction("Life")).toBe(4);
        // Life used to field three where the other playable factions fielded four; assert it is no longer the
        // short one rather than hardcoding four everywhere. Death is deliberately excluded — it is still a stub
        // faction with no level 2 creatures at all, so it is not part of "like everyone else".
        for (const faction of ["Nature", "Chaos", "Might"]) {
            expect(levelTwoPerFaction("Life")).toBeGreaterThanOrEqual(levelTwoPerFaction(faction));
        }
    });

    // The live server sizes a stack as ceil(1000 / exp), and livetwin.test.ts asserts every level 2 creature
    // lands in 22..40. Pin it here too so a balance nudge to `exp` fails in the creature's own test first.
    // Deliberately ABOVE the level 2 band of 22-40: the Battle Mage's damage comes out of a spellbook that
    // scales with how many of them are standing, so it is priced to field a big cheap stack. Pinned exactly
    // rather than as a range, because the whole point is the round 50 — see the matching exception in
    // livetwin.test.ts, which keeps the band honest for every other level 2.
    it("is priced to field exactly 50 bodies, above the level 2 band", () => {
        expect(amountForCreatureExperienceBudget("Battle Mage", STACK_EXPERIENCE_BUDGET, 30)).toBe(50);
    });

    // The Battle Mage pays for an OFFENSIVE book on ARMOR, not on health. It used to sit at or below the
    // weakest level 2 casters (Healer, Satyr) on both, but a rebalance took health 14 -> 26 and armor 11 -> 10:
    // the stack now survives a hit while still folding to sustained damage, so it plays as a body with a book
    // rather than as glass. Armor stays the cheapest of the three, which is where the price is now paid.
    it("is the softest-armoured level 2 caster, and buys health with it", () => {
        const creatures = creaturesJson as unknown as Record<string, Record<string, { hp: number; armor: number }>>;
        const healer = creatures.Life.Healer;
        const satyr = creatures.Nature.Satyr;

        expect(battleMage.armor).toBeLessThan(Math.min(healer.armor, satyr.armor));
        // Pinned outright rather than relative, so drifting back under the old floor has to be deliberate.
        expect(battleMage.hp).toBe(26);
        expect(battleMage.hp).toBeGreaterThan(Math.max(healer.hp, satyr.hp));
    });
});

describe("action engine — Fire Strike", () => {
    it("burns the target for the formula damage, spends one of three scrolls and ends the turn", () => {
        const setup = setupMageFight({
            casterAmountAlive: 38,
            casterStackPower: 5,
            enemies: [{ cell: { x: 6, y: 3 } }],
        });
        const hpBefore = setup.enemies[0].getHp();

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Fire Strike",
            targetId: setup.enemies[0].getId(),
        });

        expect(result.completed).toBe(true);
        // 38 mages x 6 = 228, and the target has no magic resistance to shave it. Stack power does not
        // scale it — it only decided the cast was allowed.
        expect(hpBefore - setup.enemies[0].getHp()).toBe(228);
        expect(
            setup.caster
                .getSpells()
                .find((s) => s.getName() === "Fire Strike")
                ?.getAmount(),
        ).toBe(2);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.caster.getId())).toBe(true);
    });

    it("deals the additive augment + Empower spell + Sylvan Focus damage the card and AI estimate promise", () => {
        const setup = setupMageFight({
            casterAmountAlive: 38,
            casterStackPower: 5,
            enemies: [{ cell: { x: 6, y: 3 } }],
        });
        const satyr = createTestUnit({
            name: "Satyr",
            team: PBTypes.TeamVals.LOWER,
            abilities: ["Sylvan Focus Aura"],
            auraEffects: ["Sylvan Focus"],
            auraRanges: [2],
            auraIsBuff: [true],
        });
        placeUnit(setup.grid, setup.unitsHolder, satyr, { x: 2, y: 3 });
        setup.unitsHolder.refreshAuraEffectsForAllUnits();

        const augment = new Spell({
            spellProperties: getSpellConfig("System", "Empower Augment", NUMBER_OF_LAPS_TOTAL),
            amount: 1,
        });
        augment.setPower(7);
        setup.caster.applyBuff(augment);
        setup.caster.applyBuff(
            new Spell({
                spellProperties: getSpellConfig("Chaos", "Empower", NUMBER_OF_LAPS_TOTAL),
                amount: 1,
            }),
        );
        expect(setup.caster.getMagicDamageBonusPercentage()).toBe(47); // 7 augment + 25 spell + 15 aura

        const hpBefore = setup.enemies[0].getHp();
        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Fire Strike",
            targetId: setup.enemies[0].getId(),
        });

        expect(result.completed).toBe(true);
        expect(hpBefore - setup.enemies[0].getHp()).toBe(335); // floor(38 mages x 6 x 1.47)
    });

    it("reports the damage on the cast event so ranked can draw the number", () => {
        const setup = setupMageFight({
            casterAmountAlive: 20,
            casterStackPower: 4,
            enemies: [{ cell: { x: 6, y: 3 } }],
        });

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Fire Strike",
            targetId: setup.enemies[0].getId(),
        });

        const cast = result.events.find((event) => event.type === "spell_cast");
        expect(cast).toBeDefined();
        expect(cast && "damaged" in cast ? cast.damaged : undefined).toEqual([
            {
                unitId: setup.enemies[0].getId(),
                position: expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
                amount: 120, // 20 mages x 6 — stack power 4 gated the cast, it did not scale the hit
                unitsDied: 0,
            },
        ]);
    });

    it("refuses the throw when a body blocks the line and keeps the scroll", () => {
        const setup = setupMageFight({
            casterAmountAlive: 38,
            casterStackPower: 5,
            enemies: [{ cell: { x: 6, y: 3 } }],
            blockerCell: { x: 5, y: 3 }, // squarely between (3,3) and (6,3)
        });
        const hpBefore = setup.enemies[0].getHp();

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Fire Strike",
            targetId: setup.enemies[0].getId(),
        });

        expect(result.completed).toBe(false);
        expect(setup.enemies[0].getHp()).toBe(hpBefore);
        expect(
            setup.caster
                .getSpells()
                .find((s) => s.getName() === "Fire Strike")
                ?.getAmount(),
        ).toBe(3);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.caster.getId())).toBe(false);
    });

    it("is magical: armor does nothing, magic resistance cuts it", () => {
        const tough = setupMageFight({
            casterAmountAlive: 38,
            casterStackPower: 5,
            enemies: [{ cell: { x: 6, y: 3 }, magicResist: 50 }],
        });
        const hpBefore = tough.enemies[0].getHp();

        tough.engine.apply({
            type: "cast_spell",
            casterId: tough.caster.getId(),
            spellName: "Fire Strike",
            targetId: tough.enemies[0].getId(),
        });

        expect(hpBefore - tough.enemies[0].getHp()).toBe(114); // 228 halved by 50% magic resistance
    });

    it("casts from a single stack — its minimum stack power is 1", () => {
        const setup = setupMageFight({
            casterAmountAlive: 6,
            casterStackPower: 1,
            enemies: [{ cell: { x: 6, y: 3 } }],
        });
        const hpBefore = setup.enemies[0].getHp();

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Fire Strike",
            targetId: setup.enemies[0].getId(),
        });

        expect(result.completed).toBe(true);
        // Stack power 1 is enough to CAST; it does not shrink the fireball: 6 mages x 6 = 36.
        expect(hpBefore - setup.enemies[0].getHp()).toBe(36);
    });
});

describe("action engine — Meteorite", () => {
    // The 2x2 whose bottom-left is (6,3) covers (6,3) (7,3) (6,4) (7,4) — the same corner convention Craft
    // and Smoke use.
    const BLOCK_ANCHOR = { x: 6, y: 3 };

    it("hits every enemy under the 2x2 for the reduced damage and leaves allies alone", () => {
        const setup = setupMageFight({
            casterAmountAlive: 38,
            casterStackPower: 5,
            enemies: [{ cell: { x: 6, y: 3 } }, { cell: { x: 7, y: 4 } }, { cell: { x: 9, y: 9 } }],
            allyCell: { x: 7, y: 3 }, // standing inside the block, and must come out unharmed
        });
        const hpBefore = setup.enemies.map((enemy) => enemy.getHp());
        const allyHpBefore = setup.ally?.getHp();

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Meteorite",
            targetCell: BLOCK_ANCHOR,
        });

        expect(result.completed).toBe(true);
        // 38 surviving mages x 4 = 152 per enemy caught.
        expect(hpBefore[0] - setup.enemies[0].getHp()).toBe(152);
        expect(hpBefore[1] - setup.enemies[1].getHp()).toBe(152);
        // The enemy standing well outside the block is untouched, and so is the ally standing inside it.
        expect(setup.enemies[2].getHp()).toBe(hpBefore[2]);
        expect(setup.ally?.getHp()).toBe(allyHpBefore);
        expect(
            setup.caster
                .getSpells()
                .find((s) => s.getName() === "Meteorite")
                ?.getAmount(),
        ).toBe(0);
    });

    it("needs no line of sight — it falls out of the sky behind a wall of bodies", () => {
        const setup = setupMageFight({
            casterAmountAlive: 38,
            casterStackPower: 5,
            enemies: [{ cell: { x: 6, y: 3 } }],
            blockerCell: { x: 5, y: 3 },
        });
        const hpBefore = setup.enemies[0].getHp();

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Meteorite",
            targetCell: BLOCK_ANCHOR,
        });

        expect(result.completed).toBe(true);
        expect(hpBefore - setup.enemies[0].getHp()).toBe(152);
    });

    it("refuses a drop that would catch nobody rather than burn the only charge", () => {
        const setup = setupMageFight({
            casterAmountAlive: 38,
            casterStackPower: 5,
            enemies: [{ cell: { x: 9, y: 9 } }],
        });

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Meteorite",
            targetCell: BLOCK_ANCHOR,
        });

        expect(result.completed).toBe(false);
        expect(
            setup.caster
                .getSpells()
                .find((s) => s.getName() === "Meteorite")
                ?.getAmount(),
        ).toBe(1);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.caster.getId())).toBe(false);
    });

    it("refuses a block that hangs off the edge of the board", () => {
        const setup = setupMageFight({
            casterAmountAlive: 38,
            casterStackPower: 5,
            enemies: [{ cell: { x: 6, y: 3 } }],
        });

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Meteorite",
            targetCell: { x: -1, y: 3 },
        });

        expect(result.completed).toBe(false);
        expect(
            setup.caster
                .getSpells()
                .find((s) => s.getName() === "Meteorite")
                ?.getAmount(),
        ).toBe(1);
    });

    it("stays locked below stack power 5", () => {
        const setup = setupMageFight({
            casterAmountAlive: 38,
            casterStackPower: 4,
            enemies: [{ cell: { x: 6, y: 3 } }],
        });
        const hpBefore = setup.enemies[0].getHp();

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Meteorite",
            targetCell: BLOCK_ANCHOR,
        });

        expect(result.completed).toBe(false);
        expect(setup.enemies[0].getHp()).toBe(hpBefore);
        expect(
            setup.caster
                .getSpells()
                .find((s) => s.getName() === "Meteorite")
                ?.getAmount(),
        ).toBe(1);
    });

    it("counts a large creature straddling the block once, not twice", () => {
        const setup = setupMageFight({
            casterAmountAlive: 38,
            casterStackPower: 5,
            enemies: [{ cell: { x: 6, y: 3 } }],
        });
        const hpBefore = setup.enemies[0].getHp();

        setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Meteorite",
            targetCell: BLOCK_ANCHOR,
        });

        // One stack under the block takes ONE hit even though evaluateAffectedUnits walks four cells.
        expect(hpBefore - setup.enemies[0].getHp()).toBe(152);
    });
});
