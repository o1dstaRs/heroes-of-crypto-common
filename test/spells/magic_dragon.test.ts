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

import { afterEach, describe, expect, it } from "bun:test";

import creaturesJson from "../../src/configuration/creatures.json";
import spellsJson from "../../src/configuration/spells.json";
import { getSpellConfig } from "../../src/configuration/config_provider";
import { MAX_UNIT_STACK_POWER } from "../../src/constants";
import { GameActionEngine } from "../../src/engine/action_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { amountForCreatureExperienceBudget, STACK_EXPERIENCE_BUDGET } from "../../src/simulation/army";
import { calculateStackPoweredSpellDamage, isThrownOffensiveSpell } from "../../src/spells/spell_damage";
import { Spell } from "../../src/spells/spell";
import { SpellElement, SpellMultiplierType, SpellTargetType } from "../../src/spells/spell_properties";
import { getMagicMirrorAbilityChance } from "../../src/spells/spell_helper";
import type { Unit } from "../../src/units/unit";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

interface IRawCreature {
    hp: number;
    steps: number;
    initiative: number;
    armor: number;
    attack: number;
    attack_damage_min: number;
    attack_damage_max: number;
    attack_type: string;
    movement_type: string;
    magic_resist: number;
    exp: number;
    size: number;
    level: number;
    spells: string[];
    abilities: string[];
}

const creatures = creaturesJson as unknown as Record<string, Record<string, IRawCreature>>;
const dragon = creatures.Nature["Magic Dragon"];
const natureSpells = (spellsJson as unknown as Record<string, Record<string, { power: number }>>).Nature;
const chaosSpells = (spellsJson as unknown as Record<string, Record<string, { power: number }>>).Chaos;

/**
 * Every draw getRandomInt makes returns `value`.
 *
 * nextRaw53 pulls TWO numbers from the seeded source — 21 high bits then 32 low bits — so yielding
 * (0, value / 2^32) in a loop builds the 53-bit integer `value` exactly. For any value under 100 that
 * makes getRandomInt(0, 100) return it outright, which is what every percentage roll in the engine reads.
 */
const alwaysRoll = (value: number): void => {
    let call = 0;
    setDeterministicRandomSource(() => (call++ % 2 === 0 ? 0 : value / 0x1_0000_0000));
};

afterEach(() => setDeterministicRandomSource(undefined));

/**
 * A fight with the Magic Dragon on the LOWER team. Local rather than shared because these tests need control
 * of the caster's head-count and stack power (the damage formula reads both) and of exactly who stands beside
 * whom (Ring of Fire splashes onto neighbours, Meteor Shower covers a 3x3).
 *
 * The caster is placed SMALL even though the real creature is size 2: none of the cast mechanics under test
 * depend on the caster's own footprint, and a 1x1 keeps the cell arithmetic in each case readable. Its size
 * is pinned in the configuration block below instead.
 */
const setupDragonFight = (opts: {
    casterAmountAlive: number;
    casterStackPower: number;
    casterMaxHp?: number;
    casterMagicResist?: number;
    casterSpells?: string[];
    enemies?: {
        cell: { x: number; y: number };
        maxHp?: number;
        magicResist?: number;
        abilities?: string[];
        large?: boolean;
        stackPower?: number;
    }[];
    allies?: { cell: { x: number; y: number } }[];
    blockerCell?: { x: number; y: number };
}) => {
    const context = createCombatTestContext(PBTypes.GridVals.NORMAL);
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(PBTypes.GridVals.NORMAL);
    fightProperties.startFight();

    const caster = createTestUnit({
        name: "Magic Dragon",
        team: PBTypes.TeamVals.LOWER,
        attackType: PBTypes.AttackVals.MELEE_MAGIC,
        movementType: PBTypes.MovementVals.FLY,
        magicResist: opts.casterMagicResist ?? 0,
        maxHp: opts.casterMaxHp ?? 10_000,
        spells: opts.casterSpells ?? dragon.spells,
        abilities: ["Tome of Elements"],
        amountAlive: opts.casterAmountAlive,
        stackPower: opts.casterStackPower,
        initiative: 5,
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
            abilities: spec.abilities ?? [],
            // Magic Reflection is stack-scaled, so a mirror's rebound share depends on how full its stack
            // is. These tests are about rebound MECHANICS -- the extra hit, resistances, event buckets --
            // so they pin a full stack and read the familiar 75% share; the scaling itself is asserted by
            // the two formula tests at the top of the Magic Reflection describe.
            stackPower: spec.stackPower ?? 1,
            size: spec.large ? PBTypes.UnitSizeVals.LARGE : PBTypes.UnitSizeVals.SMALL,
            initiative: 3,
            morale: 4,
        });
        placeUnit(context.grid, context.unitsHolder, enemy, spec.cell);
        enemies.push(enemy);
    }

    const allies: Unit[] = [];
    for (const [index, spec] of (opts.allies ?? []).entries()) {
        const ally = createTestUnit({
            name: `Friend ${index}`,
            team: PBTypes.TeamVals.LOWER,
            maxHp: 10_000,
            initiative: 2,
        });
        placeUnit(context.grid, context.unitsHolder, ally, spec.cell);
        allies.push(ally);
    }

    if (opts.blockerCell) {
        const blocker = createTestUnit({ name: "Blocker", team: PBTypes.TeamVals.LOWER, maxHp: 10_000, initiative: 2 });
        placeUnit(context.grid, context.unitsHolder, blocker, opts.blockerCell);
    }

    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LOWER, 1 + allies.length);
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

    return { ...context, fightProperties, caster, enemies, allies, engine, sceneLog };
};

const schoolOf = (name: string): string => (name === "Ring of Fire" ? "Chaos" : "Nature");
const scrollsOf = (name: string): number =>
    dragon.spells.filter((entry) => entry === `${schoolOf(name)}:${name}`).length;
const rawSpell = (name: string): { power: number } => (name === "Ring of Fire" ? chaosSpells : natureSpells)[name];

describe("Magic Dragon creature configuration", () => {
    it("is a level 4 Nature flyer that fights in melee and casts, sized like every other level 4", () => {
        expect(dragon.level).toBe(4);
        expect(dragon.size).toBe(2); // every level 4 is 2x2 — the rule holds with no exceptions
        expect(dragon.movement_type).toBe("FLY");
        expect(dragon.attack_type).toBe("MELEE_MAGIC");
        expect(dragon.magic_resist).toBe(15); // every level 4 creature carries 15
        expect(dragon.abilities).toEqual(["Tome of Elements", "Magic Reflection"]);
    });

    // The brief: the Tsar Cannon and the Gargantuan, roughly 10-20% weaker on shared movement and upper damage,
    // with an attack that is much weaker still, because the creature's damage is meant to come out of its spellbook.
    it("sits 10-20% under the Tsar Cannon / Gargantuan average on shared movement and upper damage", () => {
        const cannon = creatures.Life["Tsar Cannon"];
        const gargantuan = creatures.Nature.Gargantuan;
        const midpoint = (key: keyof IRawCreature): number =>
            ((cannon[key] as number) + (gargantuan[key] as number)) / 2;

        for (const key of ["steps", "attack_damage_max"] as const) {
            const ratio = dragon[key] / midpoint(key);
            expect(ratio).toBeGreaterThanOrEqual(0.8);
            expect(ratio).toBeLessThanOrEqual(0.9);
        }
    });

    it("keeps its deliberately lower armor and damage floor after the Tsar Cannon buff", () => {
        const cannon = creatures.Life["Tsar Cannon"];
        const gargantuan = creatures.Nature.Gargantuan;
        const midpoint = (key: "armor" | "attack_damage_min"): number => (cannon[key] + gargantuan[key]) / 2;

        expect(dragon.armor).toBe(25);
        expect(dragon.attack_damage_min).toBe(28);
        expect(dragon.armor / midpoint("armor")).toBeLessThan(0.85);
        expect(dragon.attack_damage_min / midpoint("attack_damage_min")).toBeLessThan(0.85);
    });

    // hp is a DELIBERATE exception to the band above, taken together with the 25% cut to the spellbook's
    // damage: at 150 the dragon sits ~19% under the Tsar Cannon / Gargantuan midpoint of 185 rather than the
    // 10-15% the brief asked for (the band would want 158-166). Pinned exactly rather than folded back into
    // the loop so the deviation stays visible and a later nudge still has to come here and re-decide it.
    it("carries a deliberately below-band 150 hp", () => {
        const cannon = creatures.Life["Tsar Cannon"];
        const gargantuan = creatures.Nature.Gargantuan;
        const midpoint = (cannon.hp + gargantuan.hp) / 2;

        expect(dragon.hp).toBe(150);
        expect(dragon.hp / midpoint).toBeLessThan(0.85);
    });

    it("carries a caster's attack — around 60% of its level, the way the Battle Mage and Healer do", () => {
        const natureLevelFour = Object.values(creatures.Nature).filter(
            (entry) => entry.level === 4 && entry.attack_type !== "MELEE_MAGIC",
        );
        const peerAverage =
            natureLevelFour.reduce((sum, entry) => sum + entry.attack, 0) / Math.max(1, natureLevelFour.length);

        expect(dragon.attack / peerAverage).toBeLessThan(0.7);
        // …and far below the two creatures its other stats were derived from.
        expect(dragon.attack).toBeLessThan(creatures.Life["Tsar Cannon"].attack * 0.6);
    });

    // The live server sizes a stack as ceil(1000 / exp) and livetwin.test.ts asserts every level 4 creature
    // lands in 1..3. Pin it here too, so a balance nudge to `exp` fails in the creature's own test first.
    it("keeps exp inside the level 4 stack-amount band", () => {
        const amount = amountForCreatureExperienceBudget("Magic Dragon", STACK_EXPERIENCE_BUDGET, 30);
        expect(amount).toBeGreaterThanOrEqual(1);
        expect(amount).toBeLessThanOrEqual(3);
    });
});

describe("Tome of Elements spell configuration", () => {
    it("hands out the scroll counts and stack-power gates the brief asked for", () => {
        expect(scrollsOf("Whirlpool")).toBe(1);
        expect(scrollsOf("Lightning Strike")).toBe(4);
        expect(scrollsOf("Ring of Fire")).toBe(2);
        expect(scrollsOf("Meteor Shower")).toBe(1);

        expect(getSpellConfig("Nature", "Whirlpool").minimal_caster_stack_power).toBe(3);
        expect(getSpellConfig("Nature", "Lightning Strike").minimal_caster_stack_power).toBe(1);
        expect(getSpellConfig("Chaos", "Ring of Fire").minimal_caster_stack_power).toBe(4);
        expect(getSpellConfig("Nature", "Meteor Shower").minimal_caster_stack_power).toBe(5);
    });

    // The three damage spells are a chained LADDER, which is the design as briefed: the bolt is the number
    // everything else is priced off, the ring is the bolt less 20%, and the shower is the ring less 10% for
    // covering the most ground. Every power was then halved across the board, so the ladder reads
    // 30 -> 24 -> 21.6 in the config. A full stack is 2 dragons — exp 500 against the 1000-point stack
    // budget — so the two-dragon row is what the spellbook actually reads on the board.
    it("prices each spell at its per-dragon damage target at full stack power", () => {
        const damage = (name: string, alive: number): number =>
            calculateStackPoweredSpellDamage(rawSpell(name).power, alive, MAX_UNIT_STACK_POWER);

        expect(damage("Lightning Strike", 1)).toBe(150);
        expect(damage("Ring of Fire", 1)).toBe(120);
        expect(damage("Meteor Shower", 1)).toBe(108);

        expect(damage("Lightning Strike", 2)).toBe(300);
        expect(damage("Ring of Fire", 2)).toBe(240);
        expect(damage("Meteor Shower", 2)).toBe(216);
    });

    it("keeps the ladder percentages the brief set", () => {
        expect(rawSpell("Ring of Fire").power).toBeCloseTo(rawSpell("Lightning Strike").power * 0.8, 5);
        expect(rawSpell("Meteor Shower").power).toBeCloseTo(rawSpell("Ring of Fire").power * 0.9, 5);
    });

    it("gives each Tome of Elements spell its element, and leaves ordinary spells elementless", () => {
        expect(getSpellConfig("Nature", "Whirlpool").element).toBe(SpellElement.WATER);
        expect(getSpellConfig("Nature", "Lightning Strike").element).toBe(SpellElement.AIR);
        expect(getSpellConfig("Chaos", "Ring of Fire").element).toBe(SpellElement.FIRE);
        expect(getSpellConfig("Nature", "Meteor Shower").element).toBe(SpellElement.EARTH);
        expect(getSpellConfig("Nature", "Meteorite").element).toBe(SpellElement.EARTH);
        expect(getSpellConfig("Life", "Heal").element).toBe(SpellElement.NO_ELEMENT);
    });

    // The exact ladder percentages are gone, but the ORDER is still design intent: the single-target bolt
    // out-damages the ring it splashes, which out-damages the 3x3 shower that hits the most units at once.
    it("keeps the damage ordering bolt > ring > shower", () => {
        expect(rawSpell("Lightning Strike").power).toBeGreaterThan(rawSpell("Ring of Fire").power);
        expect(rawSpell("Ring of Fire").power).toBeGreaterThan(rawSpell("Meteor Shower").power);
    });

    it("aims each spell the way its own handler reads it", () => {
        for (const name of ["Lightning Strike", "Ring of Fire", "Meteor Shower"]) {
            const spell = getSpellConfig(schoolOf(name), name);
            expect(spell.multiplier_type).toBe(SpellMultiplierType.UNIT_AMOUNT_STACK_POWER);
            expect(spell.is_buff).toBe(false);
        }
        expect(getSpellConfig("Nature", "Lightning Strike").spell_target_type).toBe(SpellTargetType.ANY_ENEMY);
        expect(getSpellConfig("Chaos", "Ring of Fire").spell_target_type).toBe(SpellTargetType.ANY_ENEMY);
        // Meteor Shower is aimed at a spot on the ground, not at a creature.
        expect(getSpellConfig("Nature", "Meteor Shower").spell_target_type).toBe(SpellTargetType.FREE_CELL);
    });

    it("makes Whirlpool a 1-lap debuff that deals no damage", () => {
        const whirlpool = getSpellConfig("Nature", "Whirlpool");
        expect(whirlpool.is_buff).toBe(false);
        expect(whirlpool.laps).toBe(1);
        expect(whirlpool.power).toBe(0);
        expect(whirlpool.multiplier_type).toBe(SpellMultiplierType.NO_MULTIPLIER);
        expect(whirlpool.desc.join(" ")).toContain("skips its next turn");
    });

    // Only the THROWN spells need a clear line. Getting this wrong does not crash anything — it silently
    // hides a legal cast from the client's target highlight and from the AI's candidate search.
    it("counts only Ring of Fire as thrown; the two called down out of the sky are not", () => {
        expect(isThrownOffensiveSpell("Ring of Fire")).toBe(true);
        expect(isThrownOffensiveSpell("Fire Strike")).toBe(true);
        expect(isThrownOffensiveSpell("Lightning Strike")).toBe(false);
        expect(isThrownOffensiveSpell("Meteor Shower")).toBe(false);
    });
});

describe("action engine — Lightning Strike", () => {
    it("strikes for the formula damage, spends one of four scrolls and ends the turn", () => {
        const setup = setupDragonFight({
            casterAmountAlive: 1,
            casterStackPower: 5,
            enemies: [{ cell: { x: 6, y: 3 } }],
        });
        const hpBefore = setup.enemies[0].getHp();

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Lightning Strike",
            targetId: setup.enemies[0].getId(),
        });

        expect(result.completed).toBe(true);
        expect(hpBefore - setup.enemies[0].getHp()).toBe(150); // 1 alive x stack power 5 x 30
        expect(
            setup.caster
                .getSpells()
                .find((s) => s.getName() === "Lightning Strike")
                ?.getAmount(),
        ).toBe(3);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.caster.getId())).toBe(true);
    });

    // The whole point of the spell: unlike Fire Strike, nothing on the board can stand in its way.
    it("falls out of the sky, so a body squarely on the line does not stop it", () => {
        const setup = setupDragonFight({
            casterAmountAlive: 2,
            casterStackPower: 5,
            enemies: [{ cell: { x: 6, y: 3 } }],
            blockerCell: { x: 5, y: 3 },
        });
        const hpBefore = setup.enemies[0].getHp();

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Lightning Strike",
            targetId: setup.enemies[0].getId(),
        });

        expect(result.completed).toBe(true);
        expect(hpBefore - setup.enemies[0].getHp()).toBe(300);
    });

    it("is magical: magic resistance cuts it down", () => {
        const setup = setupDragonFight({
            casterAmountAlive: 1,
            casterStackPower: 5,
            enemies: [{ cell: { x: 6, y: 3 }, magicResist: 25 }],
        });
        const hpBefore = setup.enemies[0].getHp();

        setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Lightning Strike",
            targetId: setup.enemies[0].getId(),
        });

        expect(hpBefore - setup.enemies[0].getHp()).toBe(112); // floor(150 * 0.75)
    });
});

describe("action engine — Ring of Fire", () => {
    // The defining rule: the ring burns AROUND its target, never the target. The aimed creature is the one
    // thing standing in the fire that does not take a point of it.
    it("spares the aimed target and burns every unit touching it, friend or foe, but never the dragon", () => {
        const setup = setupDragonFight({
            casterAmountAlive: 1,
            casterStackPower: 5,
            enemies: [{ cell: { x: 6, y: 3 } }, { cell: { x: 7, y: 3 } }, { cell: { x: 9, y: 3 } }],
            allies: [{ cell: { x: 6, y: 4 } }],
        });
        const before = [...setup.enemies, ...setup.allies].map((unit) => unit.getHp());
        const casterHpBefore = setup.caster.getHp();

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Ring of Fire",
            targetId: setup.enemies[0].getId(),
        });

        expect(result.completed).toBe(true);
        expect(before[0] - setup.enemies[0].getHp()).toBe(0); // the aimed target is inside the ring, untouched
        expect(before[1] - setup.enemies[1].getHp()).toBe(120); // (7,3) touches (6,3): 1 x 5 x 24
        expect(before[2] - setup.enemies[2].getHp()).toBe(0); // (9,3) is two cells away
        expect(before[3] - setup.allies[0].getHp()).toBe(120); // an ally next to the target burns too
        expect(setup.caster.getHp()).toBe(casterHpBefore);
    });

    // Size-scaling: a 2x2 target is ringed by the 12 cells around its whole block, not the 8 around its base
    // cell. (7,4) touches the block's top-right corner and would fall OUTSIDE a base-cell-only ring, so it is
    // the cell that actually distinguishes the two shapes.
    it("rings a large target's whole 2x2 block rather than just its base cell", () => {
        const setup = setupDragonFight({
            casterAmountAlive: 1,
            casterStackPower: 5,
            enemies: [{ cell: { x: 6, y: 3 }, large: true }, { cell: { x: 8, y: 4 } }, { cell: { x: 9, y: 9 } }],
        });
        const before = setup.enemies.map((unit) => unit.getHp());

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Ring of Fire",
            targetId: setup.enemies[0].getId(),
        });

        expect(result.completed).toBe(true);
        expect(before[0] - setup.enemies[0].getHp()).toBe(0); // the large target is spared like any other
        expect(before[1] - setup.enemies[1].getHp()).toBe(120); // hugs the block, outside a base-cell-only ring
        expect(before[2] - setup.enemies[2].getHp()).toBe(0); // far away, clear of even the wider ring
    });

    // Owner 2026-08-08: an empty ring is a VALID cast, not a refusal. A lone enemy in line of sight is a
    // legal aim point — it is spared like every other target and the ring simply burns no one. The scroll is
    // still spent and the turn ends. This was the "sometimes it will not cast, with nothing in the way"
    // report: the invisible barrier was this neighbour requirement, now gone.
    it("casts on a lone target, sparing it and burning no one, but still spends the charge", () => {
        const setup = setupDragonFight({
            casterAmountAlive: 1,
            casterStackPower: 5,
            enemies: [{ cell: { x: 9, y: 9 } }],
        });
        const hpBefore = setup.enemies[0].getHp();

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Ring of Fire",
            targetId: setup.enemies[0].getId(),
        });

        expect(result.completed).toBe(true);
        expect(setup.enemies[0].getHp()).toBe(hpBefore); // spared — nothing stood around it to burn
        expect(
            setup.caster
                .getSpells()
                .find((s) => s.getName() === "Ring of Fire")
                ?.getAmount(),
        ).toBe(1); // the charge is spent even though the ring caught no one
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.caster.getId())).toBe(true);
    });

    // The one enemy Ring of Fire cannot be pointed at: a fully magic-immune target (a Black Dragon at 100%
    // resist). canCastSpell turns it away before the ring is ever laid — even though the ring would spare it
    // anyway — so the spellbook never offers a cast the aim point renders pointless.
    it("refuses a fully magic-immune target (100% resist), even with a neighbour that would have burned", () => {
        const setup = setupDragonFight({
            casterAmountAlive: 1,
            casterStackPower: 5,
            enemies: [{ cell: { x: 6, y: 3 }, magicResist: 100 }, { cell: { x: 7, y: 3 } }],
        });
        const before = setup.enemies.map((unit) => unit.getHp());

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Ring of Fire",
            targetId: setup.enemies[0].getId(),
        });

        expect(result.completed).toBe(false);
        expect(setup.enemies[1].getHp()).toBe(before[1]); // no ring laid: the neighbour that would have burned is untouched
        expect(
            setup.caster
                .getSpells()
                .find((s) => s.getName() === "Ring of Fire")
                ?.getAmount(),
        ).toBe(2); // charge kept
    });

    it("is thrown, so a body squarely on the line refuses the cast and keeps the scroll", () => {
        const setup = setupDragonFight({
            casterAmountAlive: 1,
            casterStackPower: 5,
            enemies: [{ cell: { x: 6, y: 3 } }],
            blockerCell: { x: 5, y: 3 },
        });
        const hpBefore = setup.enemies[0].getHp();

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Ring of Fire",
            targetId: setup.enemies[0].getId(),
        });

        expect(result.completed).toBe(false);
        expect(setup.enemies[0].getHp()).toBe(hpBefore);
        expect(
            setup.caster
                .getSpells()
                .find((s) => s.getName() === "Ring of Fire")
                ?.getAmount(),
        ).toBe(2);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.caster.getId())).toBe(false);
    });
});

describe("action engine — Meteor Shower", () => {
    it("covers the 3x3 centred on the aimed cell and catches only enemies", () => {
        const setup = setupDragonFight({
            casterAmountAlive: 1,
            casterStackPower: 5,
            // (7,7) is the centre: (6,6) and (8,8) are corners of the block, (9,7) is outside it.
            enemies: [{ cell: { x: 6, y: 6 } }, { cell: { x: 8, y: 8 } }, { cell: { x: 9, y: 7 } }],
            allies: [{ cell: { x: 7, y: 6 } }],
        });
        const before = [...setup.enemies, ...setup.allies].map((unit) => unit.getHp());

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Meteor Shower",
            targetCell: { x: 7, y: 7 },
        });

        expect(result.completed).toBe(true);
        expect(before[0] - setup.enemies[0].getHp()).toBe(108); // 1 x 5 x 21.6
        expect(before[1] - setup.enemies[1].getHp()).toBe(108);
        expect(before[2] - setup.enemies[2].getHp()).toBe(0); // outside the block
        expect(before[3] - setup.allies[0].getHp()).toBe(0); // allies are not caught
    });

    it("deals Earth damage normally to Fire and Water Elements", () => {
        const setup = setupDragonFight({
            casterAmountAlive: 1,
            casterStackPower: 5,
            enemies: [
                { cell: { x: 6, y: 6 }, abilities: ["Fire Element"] },
                { cell: { x: 8, y: 8 }, abilities: ["Water Element"] },
                { cell: { x: 7, y: 8 } },
            ],
        });
        const before = setup.enemies.map((unit) => unit.getHp());

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Meteor Shower",
            targetCell: { x: 7, y: 7 },
        });

        expect(result.completed).toBe(true);
        expect(before[0] - setup.enemies[0].getHp()).toBe(108);
        expect(before[1] - setup.enemies[1].getHp()).toBe(108);
        expect(before[2] - setup.enemies[2].getHp()).toBe(108);
    });

    it("refuses a drop that catches nobody rather than burn the only scroll", () => {
        const setup = setupDragonFight({
            casterAmountAlive: 1,
            casterStackPower: 5,
            enemies: [{ cell: { x: 9, y: 9 } }],
        });

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Meteor Shower",
            targetCell: { x: 5, y: 5 },
        });

        expect(result.completed).toBe(false);
        expect(
            setup.caster
                .getSpells()
                .find((s) => s.getName() === "Meteor Shower")
                ?.getAmount(),
        ).toBe(1);
        expect(setup.fightProperties.hasAlreadyMadeTurn(setup.caster.getId())).toBe(false);
    });
});

describe("action engine — Whirlpool", () => {
    it("marks the target to skip its next activation without dealing damage", () => {
        const setup = setupDragonFight({
            casterAmountAlive: 1,
            casterStackPower: 5,
            enemies: [{ cell: { x: 6, y: 3 } }],
        });
        const target = setup.enemies[0];
        expect(target.canMove()).toBe(true);
        const hpBefore = target.getHp();

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Whirlpool",
            targetId: target.getId(),
        });

        expect(result.completed).toBe(true);
        expect(target.hasDebuffActive("Whirlpool")).toBe(true);
        expect(target.canMove()).toBe(false);
        expect(target.isSkippingThisTurn()).toBe(true);
        // The vortex controls the activation rather than masquerading as a Stun effect, and deals no damage.
        expect(target.getHp()).toBe(hpBefore);
        expect(target.hasEffectActive("Stun")).toBe(false);
    });

    // The element gate is a TARGETING rule, not a damage one, which matters most for Whirlpool: it deals no
    // damage at all, so the only way a Water Element can shrug it off is for the cast to be refused outright.
    it("cannot chain a Water Element, and lightning cannot be aimed at a Wind Element", () => {
        const setup = setupDragonFight({
            casterAmountAlive: 1,
            casterStackPower: 5,
            enemies: [
                { cell: { x: 6, y: 3 }, abilities: ["Water Element"] },
                { cell: { x: 6, y: 5 }, abilities: ["Wind Element"] },
            ],
        });
        const [water, wind] = setup.enemies;

        const whirlpool = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Whirlpool",
            targetId: water.getId(),
        });
        expect(whirlpool.completed).toBe(false);
        expect(water.hasDebuffActive("Whirlpool")).toBe(false);
        expect(water.canMove()).toBe(true);

        const bolt = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Lightning Strike",
            targetId: wind.getId(),
        });
        expect(bolt.completed).toBe(false);
        expect(wind.getHp()).toBe(wind.getMaxHp());

        // The charges are still on the page: a refused cast must not cost the dragon a scroll.
        const charges = (name: string) =>
            setup.caster
                .getSpells()
                .find((entry) => entry.getName() === name)
                ?.getAmount();
        expect(charges("Whirlpool")).toBe(1);
        expect(charges("Lightning Strike")).toBe(4);
    });
});

describe("Magic Mirror spell buffs", () => {
    for (const [spellName, expectedRebound] of [
        ["Magic Mirror", 45],
        ["Mass Magic Mirror", 37],
    ] as const) {
        it(`${spellName} always returns its configured share of landed magical damage`, () => {
            // A high roll proves this is the spell buff's guaranteed damage return, not the Magic Dragon
            // passive's chance-based rebound. Lightning Strike lands for 150; the two buffs return 30% and
            // 25% respectively, floored before the caster's own defences are applied.
            alwaysRoll(99);
            const setup = setupDragonFight({
                casterAmountAlive: 1,
                casterStackPower: 5,
                enemies: [{ cell: { x: 6, y: 3 } }],
            });
            setup.enemies[0].applyBuff(new Spell({ spellProperties: getSpellConfig("Chaos", spellName), amount: 1 }));
            const targetHpBefore = setup.enemies[0].getHp();
            const casterHpBefore = setup.caster.getHp();

            const result = setup.engine.apply({
                type: "cast_spell",
                casterId: setup.caster.getId(),
                spellName: "Lightning Strike",
                targetId: setup.enemies[0].getId(),
            });

            expect(result.completed).toBe(true);
            expect(targetHpBefore - setup.enemies[0].getHp()).toBe(150);
            expect(casterHpBefore - setup.caster.getHp()).toBe(expectedRebound);
            const cast = result.events.find((event) => event.type === "spell_cast");
            expect(cast?.type === "spell_cast" ? cast.damaged?.filter((entry) => entry.rebounded) : []).toEqual([
                expect.objectContaining({
                    unitId: setup.caster.getId(),
                    amount: expectedRebound,
                    reboundedFromUnitId: setup.enemies[0].getId(),
                }),
            ]);
        });
    }
});

describe("Magic Reflection (passive)", () => {
    // STACK-SCALED, like the game's other percentages: the configured 75 is what a FULL stack rebounds, and
    // a depleted one rebounds proportionally less -- 15/30/45/60/75 across the five tiers -- before luck
    // shifts it. A dragon down to its last pip is a much poorer mirror than a fresh one.
    it("scales the ability's 75% base across the stack, then shifts it by the holder's own luck", () => {
        const atStack = (stackPower: number, luck = 0) =>
            getMagicMirrorAbilityChance(
                createTestUnit({
                    name: `Mirror ${stackPower}/${luck}`,
                    abilities: ["Magic Reflection"],
                    stackPower,
                    luck,
                }),
            );

        expect([1, 2, 3, 4, 5].map((stackPower) => atStack(stackPower))).toEqual([15, 30, 45, 60, 75]);
        expect(atStack(5, 10)).toBe(85);
        expect(atStack(5, -10)).toBe(65);
        expect(atStack(1, 10)).toBe(25);
        expect(atStack(1, -10)).toBe(5);
        expect(getMagicMirrorAbilityChance(createTestUnit({ name: "Plain" }))).toBe(0);
    });

    // Luck itself is capped at +/-10 by the unit, so a full stack reaches 65..85 and the 0..100 clamp in
    // magicReflectionPercent is belt-and-braces rather than something luck can ever drive it to. The floor
    // matters more now that the base scales down: an unlucky single pip must never go negative.
    it("stays inside 0..100 however extreme the requested luck", () => {
        const atLuck = (luck: number, stackPower = 5) =>
            getMagicMirrorAbilityChance(
                createTestUnit({ name: `Mirror ${luck}`, abilities: ["Magic Reflection"], stackPower, luck }),
            );

        expect(atLuck(100)).toBe(85);
        expect(atLuck(-100)).toBe(65);
        expect(atLuck(-100, 1)).toBe(5);
    });

    // The mirror does NOT shield its holder. The spell resolves on it exactly as it would without the
    // ability, and the rebound is a SECOND hit landing on the caster — that is the whole point of it.
    // What comes back is the mirror's own share (75% at base luck), not the whole spell.
    it("is an extra hit, not a redirection: the holder takes it in full and the caster takes the share", () => {
        alwaysRoll(0); // 0 < 80 -> the rebound lands
        const setup = setupDragonFight({
            casterAmountAlive: 1,
            casterStackPower: 5,
            enemies: [{ cell: { x: 6, y: 3 }, abilities: ["Magic Reflection"], stackPower: 5 }],
        });
        const targetHpBefore = setup.enemies[0].getHp();
        const casterHpBefore = setup.caster.getHp();

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Lightning Strike",
            targetId: setup.enemies[0].getId(),
        });

        expect(result.completed).toBe(true);
        expect(targetHpBefore - setup.enemies[0].getHp()).toBe(150); // the spell landed as normal
        expect(casterHpBefore - setup.caster.getHp()).toBe(112); // 75% of it came back: floor(150 * 0.75)
    });

    it("reports the rebound's damage rather than leaving the caster hit unexplained", () => {
        alwaysRoll(0); // 0 < 80 -> the rebound lands
        const setup = setupDragonFight({
            casterAmountAlive: 1,
            casterStackPower: 5,
            enemies: [{ cell: { x: 6, y: 3 }, abilities: ["Magic Reflection"], stackPower: 5 }],
        });

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Lightning Strike",
            targetId: setup.enemies[0].getId(),
        });
        expect(result.completed).toBe(true);

        // The caster's own entry is flagged, so ranked (which rebuilds its log from events, never from the
        // engine's text) can name the rebound instead of showing a bare hit on the caster.
        const spellCast = result.events.find((event) => event.type === "spell_cast");
        const damaged = spellCast?.type === "spell_cast" ? (spellCast.damaged ?? []) : [];
        const reboundEntry = damaged.find((entry) => entry.rebounded);
        expect(reboundEntry).toBeDefined();
        expect(reboundEntry!.unitId).toBe(setup.caster.getId());
        expect(reboundEntry!.amount).toBe(112); // the mirror's 75% share, not the whole 150
        // The holder rides along so the scenes can draw the beam back from the mirror that threw it.
        expect(reboundEntry!.reboundedFromUnitId).toBe(setup.enemies[0].getId());
        // The holder's own hit is NOT a rebound.
        expect(damaged.filter((entry) => entry.rebounded)).toHaveLength(1);
        // The reflected hit is damage the caster suffered, not another 150 of offensive output by it.
        expect(setup.damageStatisticHolder.get().map(({ damage }) => damage)).toEqual([150]);
    });

    it("also rebounds Fire Strike, whose dedicated cast path must not bypass Magic Reflection", () => {
        alwaysRoll(0);
        const setup = setupDragonFight({
            casterAmountAlive: 10,
            casterStackPower: 5,
            casterSpells: ["Life:Fire Strike"],
            enemies: [{ cell: { x: 6, y: 3 }, abilities: ["Magic Reflection"], stackPower: 5 }],
        });
        const targetHpBefore = setup.enemies[0].getHp();
        const casterHpBefore = setup.caster.getHp();

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Fire Strike",
            targetId: setup.enemies[0].getId(),
        });

        expect(result.completed).toBe(true);
        expect(targetHpBefore - setup.enemies[0].getHp()).toBe(60); // 10 surviving casters x 6
        expect(casterHpBefore - setup.caster.getHp()).toBe(45); // the mirror's 75% share
        const cast = result.events.find((event) => event.type === "spell_cast");
        expect(cast?.type === "spell_cast" ? cast.damaged?.filter((entry) => entry.rebounded) : []).toHaveLength(1);
    });

    it("also rebounds Meteorite once per mirror inside its AOE", () => {
        alwaysRoll(0);
        const setup = setupDragonFight({
            casterAmountAlive: 10,
            casterStackPower: 5,
            casterSpells: ["Life:Meteorite"],
            enemies: [
                { cell: { x: 6, y: 3 }, abilities: ["Magic Reflection"], stackPower: 5 },
                { cell: { x: 7, y: 4 }, abilities: ["Magic Reflection"], stackPower: 5 },
            ],
        });
        const casterHpBefore = setup.caster.getHp();

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Meteorite",
            targetCell: { x: 6, y: 3 },
        });

        expect(result.completed).toBe(true);
        expect(casterHpBefore - setup.caster.getHp()).toBe(60); // 75% of (10 casters x 4), twice
        const cast = result.events.find((event) => event.type === "spell_cast");
        expect(cast?.type === "spell_cast" ? cast.damaged?.filter((entry) => entry.rebounded) : []).toHaveLength(2);
    });

    it("rebounds once per mirror caught in a splash", () => {
        alwaysRoll(0);
        const setup = setupDragonFight({
            casterAmountAlive: 1,
            casterStackPower: 5,
            // The ring spares whatever it is aimed at, so the mirrors have to be the NEIGHBOURS: the target
            // at (6,3) carries none and burns for nothing, while (7,3) and (6,4) both hug it and both reflect.
            // Neither sits on the caster's line to the target — the dragon throws this one, so a body at
            // (5,3) would block the cast outright rather than joining the ring.
            enemies: [
                { cell: { x: 6, y: 3 } },
                { cell: { x: 7, y: 3 }, abilities: ["Magic Reflection"], stackPower: 5 },
                { cell: { x: 6, y: 4 }, abilities: ["Magic Reflection"], stackPower: 5 },
            ],
        });
        const casterHpBefore = setup.caster.getHp();
        const before = setup.enemies.map((unit) => unit.getHp());

        setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Ring of Fire",
            targetId: setup.enemies[0].getId(),
        });

        expect(before[0] - setup.enemies[0].getHp()).toBe(0); // aimed at, so spared
        expect(before[1] - setup.enemies[1].getHp()).toBe(120);
        expect(before[2] - setup.enemies[2].getHp()).toBe(120);
        expect(casterHpBefore - setup.caster.getHp()).toBe(180); // 75% of 120 back off each mirror: 90 + 90
    });

    it("does not apply a later rebound to a caster an earlier mirror already killed", () => {
        alwaysRoll(0);
        const setup = setupDragonFight({
            casterAmountAlive: 1,
            casterStackPower: 5,
            casterMaxHp: 30,
            enemies: [
                // Ring of Fire spares its aimed target, so both mirrors must stand on neighbouring ring cells.
                { cell: { x: 6, y: 3 } },
                { cell: { x: 7, y: 3 }, abilities: ["Magic Reflection"], stackPower: 5 },
                { cell: { x: 6, y: 4 }, abilities: ["Magic Reflection"], stackPower: 5 },
            ],
        });

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Ring of Fire",
            targetId: setup.enemies[0].getId(),
        });

        expect(result.completed).toBe(true);
        expect(setup.caster.isDead()).toBe(true);
        const cast = result.events.find((event) => event.type === "spell_cast");
        const rebounds = cast?.type === "spell_cast" ? (cast.damaged ?? []).filter((entry) => entry.rebounded) : [];
        expect(rebounds).toEqual([
            expect.objectContaining({
                unitId: setup.caster.getId(),
                amount: 30,
                unitsDied: 1,
            }),
        ]);
    });

    it("never routes spell damage — direct or rebounded — through a Flesh Shield owner", () => {
        alwaysRoll(0);
        const setup = setupDragonFight({
            casterAmountAlive: 1,
            casterStackPower: 5,
            // The aimed target is spared. Its mirror-bearing neighbour burns and rebounds while the friendly
            // neighbour supplies the direct hit; both lower-team impacts are in Abomination range.
            // Keep the mirror off the caster-to-target diagonal; Ring of Fire is thrown and checks LOS.
            enemies: [
                { cell: { x: 5, y: 1 } },
                { cell: { x: 6, y: 2 }, abilities: ["Magic Reflection"], stackPower: 5 },
            ],
            allies: [{ cell: { x: 5, y: 2 } }],
        });
        const abomination = createTestUnit({
            name: "Abomination",
            team: PBTypes.TeamVals.LOWER,
            maxHp: 10_000,
            luck: 10,
            stackPower: 5,
            abilities: ["Flesh Shield Aura"],
            auraEffects: ["Flesh Shield"],
            auraRanges: [1],
            auraIsBuff: [true],
        });
        placeUnit(setup.grid, setup.unitsHolder, abomination, { x: 4, y: 3 });
        setup.unitsHolder.refreshAuraEffectsForAllUnits();
        const abominationHpBefore = abomination.getHp();

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Ring of Fire",
            targetId: setup.enemies[0].getId(),
        });

        expect(result.completed).toBe(true);
        const cast = result.events.find((event) => event.type === "spell_cast");
        const absorbed = cast?.type === "spell_cast" ? (cast.secondary ?? []) : [];
        // The aura absorbs physical damage only: the burning ally beside it and the mirror's rebound onto the
        // caster are both magical, so nothing is transferred and the owner stays untouched.
        expect(absorbed.filter((entry) => entry.source === "flesh_shield")).toEqual([]);
        expect(abomination.getHp()).toBe(abominationHpBefore);
    });

    it("does not reward or demoralize its team when the Ring burns a friendly stack to death", () => {
        alwaysRoll(99); // keep Magic Reflection out of this friendly-fire assertion
        const setup = setupDragonFight({
            casterAmountAlive: 1,
            casterStackPower: 5,
            enemies: [{ cell: { x: 5, y: 1 } }],
        });
        // Standing inside the ring next to the aimed enemy, this fragile friendly stack takes the full
        // friendly-fire splash (120) and dies.
        const victim = createTestUnit({
            name: "Abomination",
            team: PBTypes.TeamVals.LOWER,
            maxHp: 100,
            morale: 4,
        });
        const witness = createTestUnit({
            name: "Abomination",
            team: PBTypes.TeamVals.LOWER,
            maxHp: 10_000,
            morale: 4,
        });
        placeUnit(setup.grid, setup.unitsHolder, victim, { x: 5, y: 2 });
        placeUnit(setup.grid, setup.unitsHolder, witness, { x: 8, y: 8 });
        setup.unitsHolder.refreshAuraEffectsForAllUnits();
        const casterMoraleBefore = setup.caster.getMorale();
        const witnessMoraleBefore = witness.getMorale();

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Ring of Fire",
            targetId: setup.enemies[0].getId(),
        });

        expect(result.completed).toBe(true);
        expect(victim.isDead()).toBe(true);
        expect(setup.caster.getMorale()).toBe(casterMoraleBefore);
        expect(witness.getMorale()).toBe(witnessMoraleBefore);
    });

    it("costs the caster nothing when the roll misses, while the spell lands the same", () => {
        alwaysRoll(90); // 90 >= 80 -> no rebound
        const setup = setupDragonFight({
            casterAmountAlive: 1,
            casterStackPower: 5,
            enemies: [{ cell: { x: 6, y: 3 }, abilities: ["Magic Reflection"], stackPower: 5 }],
        });
        const targetHpBefore = setup.enemies[0].getHp();
        const casterHpBefore = setup.caster.getHp();

        setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Lightning Strike",
            targetId: setup.enemies[0].getId(),
        });

        expect(targetHpBefore - setup.enemies[0].getHp()).toBe(150);
        expect(setup.caster.getHp()).toBe(casterHpBefore);
    });

    // Effects rebound the same additive way damage does. This half already worked — attack_handler applies
    // the debuff to the target and THEN mirrors a copy onto the attacker — so the test pins that the passive
    // ability feeds that existing seam (via isMirrored) rather than needing its own path.
    it("rebounds the effect too: both the holder and the caster end up chained", () => {
        alwaysRoll(0);
        const setup = setupDragonFight({
            casterAmountAlive: 1,
            casterStackPower: 5,
            enemies: [{ cell: { x: 6, y: 3 }, abilities: ["Magic Reflection"], stackPower: 5 }],
        });

        setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Whirlpool",
            targetId: setup.enemies[0].getId(),
        });

        expect(setup.enemies[0].hasDebuffActive("Whirlpool")).toBe(true);
        expect(setup.caster.hasDebuffActive("Whirlpool")).toBe(true);
        expect(setup.caster.canMove()).toBe(false);
    });

    it("cuts a rebounded hit by the CASTER's magic resistance, not the holder's", () => {
        alwaysRoll(0);
        const setup = setupDragonFight({
            casterAmountAlive: 1,
            casterStackPower: 5,
            casterMagicResist: 50,
            enemies: [{ cell: { x: 6, y: 3 }, magicResist: 0, abilities: ["Magic Reflection"], stackPower: 5 }],
        });
        const casterHpBefore = setup.caster.getHp();

        setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Lightning Strike",
            targetId: setup.enemies[0].getId(),
        });

        // 75% share of the 150 that landed, then halved by the CASTER's own 50% magic resistance.
        expect(casterHpBefore - setup.caster.getHp()).toBe(56); // floor(floor(150 * 0.75) * 0.5)
    });
});
