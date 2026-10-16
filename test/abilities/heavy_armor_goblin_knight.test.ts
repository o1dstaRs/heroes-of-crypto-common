/*
 * -----------------------------------------------------------------------------
 * The Goblin Knight that actually ships — creatures.json, not a stand-in — pays
 * Heavy Armor's other half: every source of magic damage hits it harder than the
 * same creature with the card taken away. The synthetic G6 cases in
 * audit_fixes.test.ts pin the arithmetic; this pins it to the real unit, its real
 * magic resistance (10), and a real cast resolved by the engine, so a config or
 * ability change that quietly switched the vulnerability off would fail here.
 *
 * Owner question 2026-09-24: "make sure Goblin Knight with his ability actually
 * gets more damage from magic attacks". Before the KB-audit fix (common c0a7052d)
 * the answer was NO for spells, Fire Wall and Fireforged burns — only Fire
 * Breath, Chain Lightning and Fire Shield applied it, each from a private copy
 * of the formula. Those copies now read Unit.getMagicDamageTakenMultiplier too.
 *
 * A REAL unit on a board rolls its lap luck (Unit.randomizeLuckPerTurn, -3..+3)
 * the moment stack power is refreshed, and luck shifts the multiplier by 1/100 a
 * point. The RNG is pinned so the roll is stable, and every expectation is
 * DERIVED from the unit's own luck and card power rather than assuming luck 0 —
 * the rule under test is "half again, shifted by luck", not one lucky number.
 * -----------------------------------------------------------------------------
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { AbilityFactory } from "../../src/abilities/ability_factory";
import { getCreatureConfig, getSpellConfig } from "../../src/configuration/config_provider";
import { MAX_UNIT_STACK_POWER } from "../../src/constants";
import { EffectFactory } from "../../src/effects/effect_factory";
import { GameActionEngine } from "../../src/engine/action_engine";
import { fireWallBurnTargetOf } from "../../src/engine/post_move_actor_availability";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { fireWallBurnDamage } from "../../src/spells/fire_walls";
import { Spell } from "../../src/spells/spell";
import { spellDamageAgainstUnit } from "../../src/spells/spell_cast_projection";
import { applyMagicResistToSpellDamage, fireforgedSwordDamage } from "../../src/spells/spell_damage";
import { Unit } from "../../src/units/unit";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;

/** Ten Goblin Knights straight out of creatures.json. */
function realGoblinKnight(team = RIGHT, amount = 10): Unit {
    const effectFactory = new EffectFactory();
    return Unit.createUnit(
        getCreatureConfig(team, "Chaos", "Goblin Knight", "", amount),
        testGridSettings,
        team,
        PBTypes.UnitVals.CREATURE,
        new AbilityFactory(effectFactory),
        effectFactory,
        false,
    );
}

/** The same creature with the card mechanically gone — the control every case below is measured against. */
function withoutHeavyArmor(unit: Unit): Unit {
    expect(unit.disableAbilityAsStolen("Heavy Armor")).toBeDefined();
    expect(unit.getAbility("Heavy Armor")).toBeUndefined();
    return unit;
}

/**
 * The card's own rule, computed from the unit as it stands: power per stack power, shifted by its luck.
 * +50% for a full stack at luck 0 — this is what Unit.getMagicDamageTakenMultiplier must answer.
 */
function heavyArmorRule(unit: Unit): number {
    const heavyArmor = unit.getAbility("Heavy Armor");
    expect(heavyArmor).toBeDefined();
    return Number(
        (((heavyArmor!.getPower() + unit.getLuck()) / 100 / MAX_UNIT_STACK_POWER) * unit.getStackPower() + 1).toFixed(
            2,
        ),
    );
}

const fireStrike = (): Spell => new Spell({ spellProperties: getSpellConfig("Chaos", "Fire Strike"), amount: 1 });

/**
 * Two knights on one board so both read the same stack power: the strongest stack on the board is power 5,
 * and with nothing else fielded they are each other's strongest.
 */
function knightsOnABoard(): { armored: Unit; bare: Unit } {
    const { grid, unitsHolder } = createCombatTestContext();
    const armored = realGoblinKnight(RIGHT);
    const bare = withoutHeavyArmor(realGoblinKnight(RIGHT));
    placeUnit(grid, unitsHolder, armored, { x: 3, y: 10 });
    placeUnit(grid, unitsHolder, bare, { x: 11, y: 10 });
    unitsHolder.refreshStackPowerForAllUnits();
    expect(armored.getStackPower()).toBe(MAX_UNIT_STACK_POWER);
    expect(bare.getStackPower()).toBe(MAX_UNIT_STACK_POWER);
    expect(armored.getLuck()).toBe(bare.getLuck());
    return { armored, bare };
}

describe("the shipping Goblin Knight takes more magic damage for its Heavy Armor", () => {
    beforeEach(() => {
        setDeterministicRandomSource(() => 0);
    });
    afterEach(() => {
        setDeterministicRandomSource(undefined);
    });

    it("carries the card, 10 magic resist, and half again on magic at a full stack (shifted by its luck)", () => {
        const { armored, bare } = knightsOnABoard();

        expect(armored.getAbility("Heavy Armor")).toBeDefined();
        expect(armored.getAbility("Heavy Armor")!.getPower()).toBe(50);
        expect(armored.getMagicResist()).toBe(10);
        expect(armored.getMagicDamageTakenMultiplier()).toBe(heavyArmorRule(armored));
        expect(armored.getMagicDamageTakenMultiplier()).toBeGreaterThan(1);
        expect(bare.getMagicDamageTakenMultiplier()).toBe(1);
    });

    it("a damage spell lands harder than its magic resistance alone would leave it", () => {
        const { armored, bare } = knightsOnABoard();
        const spell = fireStrike();

        // Its resistance alone would take 100 down to 90; Heavy Armor then puts (about) half again on top.
        const resistedOnly = applyMagicResistToSpellDamage(100, armored.getMagicResist());
        expect(resistedOnly).toBe(90);
        expect(spellDamageAgainstUnit(spell, 100, bare)).toBe(90);
        expect(spellDamageAgainstUnit(spell, 100, armored)).toBe(Math.floor(90 * heavyArmorRule(armored)));
        expect(spellDamageAgainstUnit(spell, 100, armored)).toBeGreaterThan(90);
    });

    it("a Fire Strike cast by the engine wounds the armored knight more than the bare one", () => {
        const castAt = (stripHeavyArmor: boolean): { lost: number; expected: number } => {
            const { grid, unitsHolder, attackHandler } = createCombatTestContext();
            const caster = createTestUnit({
                name: "Caster",
                team: LEFT,
                spells: ["Chaos:Fire Strike"],
                amountAlive: 50,
                maxHp: 100,
            });
            const knight = stripHeavyArmor ? withoutHeavyArmor(realGoblinKnight(RIGHT)) : realGoblinKnight(RIGHT);
            placeUnit(grid, unitsHolder, caster, { x: 2, y: 2 });
            placeUnit(grid, unitsHolder, knight, { x: 2, y: 5 });
            unitsHolder.refreshStackPowerForAllUnits();

            const fightProperties = FightStateManager.getInstance().getFightProperties();
            fightProperties.setGridType(PBTypes.GridVals.NORMAL);
            fightProperties.startFight();
            fightProperties.setTeamUnitsAlive(LEFT, 1);
            fightProperties.setTeamUnitsAlive(RIGHT, 1);
            fightProperties.startTurn(LEFT, 1_000);
            const engine = new GameActionEngine({
                fightProperties,
                grid,
                unitsHolder,
                moveHandler: new MoveHandler(testGridSettings, grid, unitsHolder),
                sceneLog: new SceneLogMock(),
                attackHandler,
                getCurrentActiveUnitId: () => caster.getId(),
            });

            // 50 casters x 6 = 300 raw; the knight's 10 resistance leaves 270, and Heavy Armor — read off the
            // knight as it stands when the spell lands — multiplies that.
            const expected = Math.floor(270 * knight.getMagicDamageTakenMultiplier());
            const hpBefore = knight.getCumulativeHp();
            const result = engine.apply({
                type: "cast_spell",
                casterId: caster.getId(),
                spellName: "Fire Strike",
                targetId: knight.getId(),
            });
            expect(result.completed, result.rejectionReason).toBe(true);
            return { lost: hpBefore - knight.getCumulativeHp(), expected };
        };

        const bare = castAt(true);
        const armored = castAt(false);

        expect(bare.lost).toBe(270);
        expect(armored.lost).toBe(armored.expected);
        // A real creature and more, off the same cast: the knight is 100 hp a head.
        expect(armored.lost - bare.lost).toBeGreaterThanOrEqual(100);
    });

    it("crossing a Fire Wall sears it harder", () => {
        const { armored, bare } = knightsOnABoard();
        const burnOn = (knight: Unit): number =>
            fireWallBurnDamage(knight.getCumulativeMaxHp(), 25, fireWallBurnTargetOf(knight));

        // 1000 max hp x 25% = 250 before the 10% resistance trims it; Heavy Armor lifts the 250 first.
        expect(burnOn(bare)).toBe(225);
        expect(burnOn(armored)).toBe(
            Math.max(1, Math.floor(Math.floor(250 * heavyArmorRule(armored)) * (1 - armored.getMagicResist() / 100))),
        );
        expect(burnOn(armored)).toBeGreaterThan(225);
    });

    it("a Fireforged Sword's burn is hotter on it", () => {
        const { armored, bare } = knightsOnABoard();
        const burnOn = (knight: Unit): number =>
            fireforgedSwordDamage({
                damageDealt: 100,
                swordPercentage: 20,
                targetMagicResist: knight.getMagicResist(),
                targetIsFireElement: false,
                targetIsWaterElement: false,
                targetMagicDamageTakenMultiplier: knight.getMagicDamageTakenMultiplier(),
            });

        // A 20% edge on a 100 hit is 20; the knight's resistance trims it to 18 bare, and Heavy Armor lifts
        // the 20 before that trim.
        expect(burnOn(bare)).toBe(18);
        expect(burnOn(armored)).toBe(
            applyMagicResistToSpellDamage(Math.floor(20 * heavyArmorRule(armored)), armored.getMagicResist()),
        );
        expect(burnOn(armored)).toBeGreaterThan(18);
    });
});
