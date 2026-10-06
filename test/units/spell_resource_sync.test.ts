import { describe, expect, test } from "bun:test";

import { AbilityFactory } from "../../src/abilities/ability_factory";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { GameActionEngine } from "../../src/engine/action_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { isSpellUsableByCaster } from "../../src/spells/spell_helper";
import { Unit } from "../../src/units/unit";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

const casters = [
    ["Life", "Blacksmith"],
    ["Life", "Valkyrie"],
    ["Life", "Healer"],
    ["Life", "Battle Mage"],
    ["Life", "Angel"],
    ["Nature", "Satyr"],
    ["Nature", "Trent"],
    ["Nature", "Magic Dragon"],
    ["Chaos", "Troll"],
    ["Chaos", "Wandering Mage"],
    ["Chaos", "Nightmare"],
    ["Might", "Harpy"],
    ["Might", "Ogre Mage"],
    ["Might", "Behemoth"],
] as const;

const createCaster = (faction: string, name: string, amount = 1, entries?: string[]): Unit => {
    const factory = new EffectFactory();
    const properties = getCreatureConfig(PBTypes.TeamVals.LEFT, faction, name, "", amount);
    if (entries !== undefined) {
        properties.spells.splice(0, properties.spells.length, ...entries);
        properties.can_cast_spells = entries.length > 0;
        properties.spell_entries_authoritative = true;
    }
    const unit = Unit.createUnit(
        properties,
        testGridSettings,
        PBTypes.TeamVals.LEFT,
        PBTypes.UnitVals.CREATURE,
        new AbilityFactory(factory),
        factory,
        false,
    );
    unit.setStackPower(5);
    return unit;
};

const amounts = (unit: Unit): Record<string, number> =>
    Object.fromEntries(unit.getSpells().map((spell) => [spell.getName(), spell.getAmount()]));

describe("spell charges restored to a reconstructed caster", () => {
    for (const [faction, name] of casters) {
        test(`${name} can cast charges returned by a whole-stack merge`, () => {
            // A tiny split can have no charges. Reconstructing that state removes all Spell objects.
            const recipient = createCaster(faction, name, 1, []);
            const donor = createCaster(faction, name, 19);
            const book = [...donor.getUnitProperties().spells];
            const expectedAmounts = amounts(donor);
            const liveEntries = recipient.getUnitProperties().spells;

            recipient.takeResourcesFromMerge(donor, 19);

            expect(recipient.getUnitProperties().spells).toBe(liveEntries);
            expect(liveEntries).toEqual(book);
            expect(recipient.getCanCastSpells()).toBe(true);
            expect(amounts(recipient)).toEqual(expectedAmounts);
            expect(recipient.getSpells().every((spell) => isSpellUsableByCaster(recipient, spell))).toBe(true);
            expect(donor.getSpellsCount()).toBe(0);
            expect(donor.getCanCastSpells()).toBe(false);
            expect(donor.getSpells().every((spell) => !spell.isRemaining())).toBe(true);
        });

        test(`${name} can cast spells added to a partial authoritative book`, () => {
            const configured = createCaster(faction, name);
            const entries = [...configured.getUnitProperties().spells];
            const recipient = createCaster(faction, name, 1, entries.slice(-1));
            const existingSpell = recipient.getSpells()[0];

            recipient.syncAuthoritativeSpellEntries(entries);

            expect(amounts(recipient)).toEqual(amounts(configured));
            expect(recipient.getSpells()).toContain(existingSpell);
            expect(recipient.getSpells().every((spell) => isSpellUsableByCaster(recipient, spell))).toBe(true);
        });
    }

    test("syncing the unit's own entry array preserves its charges", () => {
        const healer = createCaster("Life", "Healer");
        const entries = healer.getUnitProperties().spells;
        const before = [...entries];
        healer.syncAuthoritativeSpellEntries(entries);
        expect(entries).toEqual(before);
        expect(healer.getSpellsCount()).toBe(before.length);
    });

    test("an authoritative empty book never restores a spent direct ability", () => {
        const angel = createCaster("Life", "Angel");
        angel.syncAuthoritativeSpellEntries([]);
        expect(angel.getSpellsCount()).toBe(0);
        expect(angel.getCanCastSpells()).toBe(false);
        expect(angel.getSpells().every((spell) => !spell.isRemaining())).toBe(true);
        const reconstructed = createCaster("Life", "Angel", 1, angel.getUnitProperties().spells);
        expect(reconstructed.getSpells()).toHaveLength(0);
    });

    test("a one-creature Healer really casts Heal after its empty book receives a charge", () => {
        const context = createCombatTestContext();
        const healer = createCaster("Life", "Healer", 1, []);
        healer.setStackPower(1);
        healer.syncAuthoritativeSpellEntries(["Life:Heal"]);
        const ally = createTestUnit({ name: "Ally", team: PBTypes.TeamVals.LEFT, maxHp: 20 });
        const enemy = createTestUnit({ name: "Enemy", team: PBTypes.TeamVals.RIGHT });
        placeUnit(context.grid, context.unitsHolder, healer, { x: 1, y: 1 });
        placeUnit(context.grid, context.unitsHolder, ally, { x: 3, y: 1 });
        placeUnit(context.grid, context.unitsHolder, enemy, { x: 12, y: 12 });
        ally.applyDamage(10, 1);
        const hpBefore = ally.getHp();
        const fightProperties = FightStateManager.getInstance().getFightProperties();
        fightProperties.startFight();
        fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LEFT, 2);
        fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.RIGHT, 1);
        fightProperties.startTurn(PBTypes.TeamVals.LEFT, 1000);
        const engine = new GameActionEngine({
            fightProperties,
            grid: context.grid,
            unitsHolder: context.unitsHolder,
            moveHandler: new MoveHandler(testGridSettings, context.grid, context.unitsHolder),
            sceneLog: new SceneLogMock(),
            attackHandler: context.attackHandler,
            getCurrentActiveUnitId: () => healer.getId(),
        });

        const result = engine.apply({
            type: "cast_spell",
            casterId: healer.getId(),
            spellName: "Heal",
            targetId: ally.getId(),
        });

        expect(result.completed).toBe(true);
        expect(ally.getHp()).toBeGreaterThan(hpBefore);
        expect(healer.getSpellsCount()).toBe(0);
        expect(result.events).toContainEqual(expect.objectContaining({ type: "spell_cast", spellName: "Heal" }));
    });
});
