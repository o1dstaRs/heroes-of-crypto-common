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
import { SpellMultiplierType, SpellTargetType } from "../../src/spells/spell_properties";
import { getMagicMirrorAbilityChance } from "../../src/spells/spell_helper";
import type { Unit } from "../../src/units/unit";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

interface IRawCreature {
    hp: number;
    steps: number;
    speed: number;
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
    casterMagicResist?: number;
    enemies?: { cell: { x: number; y: number }; maxHp?: number; magicResist?: number; abilities?: string[] }[];
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
        maxHp: 10_000,
        spells: dragon.spells,
        abilities: ["Tome of Elements"],
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
            abilities: spec.abilities ?? [],
            speed: 3,
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
            speed: 2,
        });
        placeUnit(context.grid, context.unitsHolder, ally, spec.cell);
        allies.push(ally);
    }

    if (opts.blockerCell) {
        const blocker = createTestUnit({ name: "Blocker", team: PBTypes.TeamVals.LOWER, maxHp: 10_000, speed: 2 });
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

const scrollsOf = (name: string): number => dragon.spells.filter((entry) => entry === `Nature:${name}`).length;

describe("Magic Dragon creature configuration", () => {
    it("is a level 4 Nature flyer that fights in melee and casts, sized like every other level 4", () => {
        expect(dragon.level).toBe(4);
        expect(dragon.size).toBe(2); // every level 4 is 2x2 — the rule holds with no exceptions
        expect(dragon.movement_type).toBe("FLY");
        expect(dragon.attack_type).toBe("MELEE_MAGIC");
        expect(dragon.magic_resist).toBe(15); // every level 4 creature carries 15
        expect(dragon.abilities).toEqual(["Tome of Elements", "Magic Mirror"]);
    });

    // The brief: the Tsar Cannon and the Gargantuan, roughly 10-15% weaker across the board, with an attack
    // that is much weaker still, because the creature's damage is meant to come out of its spellbook.
    it("sits 10-15% under the Tsar Cannon / Gargantuan average on every stat but attack", () => {
        const cannon = creatures.Life["Tsar Cannon"];
        const gargantuan = creatures.Nature.Gargantuan;
        const midpoint = (key: keyof IRawCreature): number =>
            ((cannon[key] as number) + (gargantuan[key] as number)) / 2;

        for (const key of ["hp", "steps", "speed", "armor", "attack_damage_min", "attack_damage_max"] as const) {
            const ratio = dragon[key] / midpoint(key);
            expect(ratio).toBeGreaterThanOrEqual(0.85);
            expect(ratio).toBeLessThanOrEqual(0.9);
        }
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
        expect(getSpellConfig("Nature", "Ring of Fire").minimal_caster_stack_power).toBe(4);
        expect(getSpellConfig("Nature", "Meteor Shower").minimal_caster_stack_power).toBe(5);
    });

    it("prices Lightning Strike at 300 damage per living dragon at full stack power", () => {
        const power = natureSpells["Lightning Strike"].power;
        expect(calculateStackPoweredSpellDamage(power, 1, MAX_UNIT_STACK_POWER)).toBe(300);
        expect(calculateStackPoweredSpellDamage(power, 2, MAX_UNIT_STACK_POWER)).toBe(600);
    });

    // The three damage spells are a priced set, not three independent numbers. Pin the relationships in the
    // CONFIG so a later tweak to one power cannot silently break the ladder.
    it("prices Ring of Fire 20% under Lightning Strike and Meteor Shower 10% under Ring of Fire", () => {
        expect(natureSpells["Ring of Fire"].power).toBeCloseTo(natureSpells["Lightning Strike"].power * 0.8, 10);
        expect(natureSpells["Meteor Shower"].power).toBeCloseTo(natureSpells["Ring of Fire"].power * 0.9, 10);
    });

    it("aims each spell the way its own handler reads it", () => {
        for (const name of ["Lightning Strike", "Ring of Fire", "Meteor Shower"]) {
            const spell = getSpellConfig("Nature", name);
            expect(spell.multiplier_type).toBe(SpellMultiplierType.UNIT_AMOUNT_STACK_POWER);
            expect(spell.is_buff).toBe(false);
        }
        expect(getSpellConfig("Nature", "Lightning Strike").spell_target_type).toBe(SpellTargetType.ANY_ENEMY);
        expect(getSpellConfig("Nature", "Ring of Fire").spell_target_type).toBe(SpellTargetType.ANY_ENEMY);
        // Meteor Shower is aimed at a spot on the ground, not at a creature.
        expect(getSpellConfig("Nature", "Meteor Shower").spell_target_type).toBe(SpellTargetType.FREE_CELL);
    });

    it("makes Whirlpool a 1-lap debuff that deals no damage", () => {
        const whirlpool = getSpellConfig("Nature", "Whirlpool");
        expect(whirlpool.is_buff).toBe(false);
        expect(whirlpool.laps).toBe(1);
        expect(whirlpool.power).toBe(0);
        expect(whirlpool.multiplier_type).toBe(SpellMultiplierType.NO_MULTIPLIER);
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
        expect(hpBefore - setup.enemies[0].getHp()).toBe(300); // 1 alive x stack power 5 x 60
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
        expect(hpBefore - setup.enemies[0].getHp()).toBe(600);
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

        expect(hpBefore - setup.enemies[0].getHp()).toBe(225); // floor(300 * 0.75)
    });
});

describe("action engine — Ring of Fire", () => {
    it("burns the target and every unit touching it, friend or foe, but never the dragon", () => {
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
        expect(before[0] - setup.enemies[0].getHp()).toBe(240); // the aimed target: 1 x 5 x 48
        expect(before[1] - setup.enemies[1].getHp()).toBe(240); // (7,3) touches (6,3)
        expect(before[2] - setup.enemies[2].getHp()).toBe(0); // (9,3) is two cells away
        expect(before[3] - setup.allies[0].getHp()).toBe(240); // an ally next to the target burns too
        expect(setup.caster.getHp()).toBe(casterHpBefore);
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
        expect(before[0] - setup.enemies[0].getHp()).toBe(216); // 1 x 5 x 43.2, floored
        expect(before[1] - setup.enemies[1].getHp()).toBe(216);
        expect(before[2] - setup.enemies[2].getHp()).toBe(0); // outside the block
        expect(before[3] - setup.allies[0].getHp()).toBe(0); // allies are not caught
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
    it("chains the target to the spot without stunning it", () => {
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
        // Pinned, not silenced: it deals no damage and the target keeps its turn and its retaliation.
        expect(target.getHp()).toBe(hpBefore);
        expect(target.hasEffectActive("Stun")).toBe(false);
    });
});

describe("Magic Mirror (passive)", () => {
    it("reads its 80% chance off the ability, and nothing off a unit without it", () => {
        const mirrored = createTestUnit({ name: "Mirrored", abilities: ["Magic Mirror"] });
        const plain = createTestUnit({ name: "Plain" });

        expect(getMagicMirrorAbilityChance(mirrored)).toBe(80);
        expect(getMagicMirrorAbilityChance(plain)).toBe(0);
    });

    // The mirror does NOT shield its holder. The spell resolves on it exactly as it would without the
    // ability, and the rebound is a SECOND hit landing on the caster — that is the whole point of it.
    it("is an extra hit, not a redirection: the holder takes it in full and so does the caster", () => {
        alwaysRoll(0); // 0 < 80 -> the rebound lands
        const setup = setupDragonFight({
            casterAmountAlive: 1,
            casterStackPower: 5,
            enemies: [{ cell: { x: 6, y: 3 }, abilities: ["Magic Mirror"] }],
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
        expect(targetHpBefore - setup.enemies[0].getHp()).toBe(300); // the spell landed as normal
        expect(casterHpBefore - setup.caster.getHp()).toBe(300); // and came back on top
    });

    it("rebounds once per mirror caught in a splash", () => {
        alwaysRoll(0);
        const setup = setupDragonFight({
            casterAmountAlive: 1,
            casterStackPower: 5,
            // Both stand inside the ring around (6,3), and both carry a mirror.
            enemies: [
                { cell: { x: 6, y: 3 }, abilities: ["Magic Mirror"] },
                { cell: { x: 7, y: 3 }, abilities: ["Magic Mirror"] },
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

        expect(before[0] - setup.enemies[0].getHp()).toBe(240);
        expect(before[1] - setup.enemies[1].getHp()).toBe(240);
        expect(casterHpBefore - setup.caster.getHp()).toBe(480); // 240 back off each mirror
    });

    it("costs the caster nothing when the roll misses, while the spell lands the same", () => {
        alwaysRoll(90); // 90 >= 80 -> no rebound
        const setup = setupDragonFight({
            casterAmountAlive: 1,
            casterStackPower: 5,
            enemies: [{ cell: { x: 6, y: 3 }, abilities: ["Magic Mirror"] }],
        });
        const targetHpBefore = setup.enemies[0].getHp();
        const casterHpBefore = setup.caster.getHp();

        setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Lightning Strike",
            targetId: setup.enemies[0].getId(),
        });

        expect(targetHpBefore - setup.enemies[0].getHp()).toBe(300);
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
            enemies: [{ cell: { x: 6, y: 3 }, abilities: ["Magic Mirror"] }],
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
            enemies: [{ cell: { x: 6, y: 3 }, magicResist: 0, abilities: ["Magic Mirror"] }],
        });
        const casterHpBefore = setup.caster.getHp();

        setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Lightning Strike",
            targetId: setup.enemies[0].getId(),
        });

        expect(casterHpBefore - setup.caster.getHp()).toBe(150); // floor(300 * 0.5)
    });
});
