import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { getSpellConfig } from "../../src/configuration/config_provider";
import creatures from "../../src/configuration/creatures.json";
import { GameActionEngine } from "../../src/engine/action_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Spell } from "../../src/spells/spell";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const setup = (selfCast: boolean) => {
    const context = createCombatTestContext(PBTypes.GridVals.NORMAL);
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.startFight();
    const caster = createTestUnit({
        name: "Blacksmith",
        team: PBTypes.TeamVals.LEFT,
        abilities: ["Enchants"],
        spells: creatures.Life.Blacksmith.spells,
        amountAlive: 5,
        stackPower: 5,
    });
    const ally = createTestUnit({ name: "Squire", team: PBTypes.TeamVals.LEFT });
    const enemy = createTestUnit({ team: PBTypes.TeamVals.RIGHT });
    placeUnit(context.grid, context.unitsHolder, caster, { x: 1, y: 1 });
    placeUnit(context.grid, context.unitsHolder, ally, { x: 2, y: 1 });
    placeUnit(context.grid, context.unitsHolder, enemy, { x: 10, y: 10 });
    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LEFT, 2);
    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.RIGHT, 1);
    fightProperties.startTurn(PBTypes.TeamVals.LEFT, 1000);
    const engine = new GameActionEngine({
        ...context,
        fightProperties,
        moveHandler: new MoveHandler(context.grid.getSettings(), context.grid, context.unitsHolder),
        sceneLog: new SceneLogMock(),
        getCurrentActiveUnitId: () => caster.getId(),
    });
    return { ...context, fightProperties, caster, target: selfCast ? caster : ally, engine };
};

const roll = (value: number) => {
    let draw = 0;
    setDeterministicRandomSource(() => (draw++ % 2 === 0 ? 0 : value / 0x1_0000_0000));
};

describe("Blacksmith enchant bonuses never reset on failure", () => {
    beforeEach(() => FightStateManager.getInstance().reset());
    afterEach(() => setDeterministicRandomSource(undefined));

    for (const name of ["Armor Rune", "Weapon Rune"] as const) {
        for (const selfCast of [false, true]) {
            for (const initial of [0, 3]) {
                for (const value of [0, 49, 50, 99]) {
                    it(`${name}, self=${selfCast}, existing=+${initial}, roll=${value}: adds only +0 or +1`, () => {
                        const { target, caster, unitsHolder, engine, fightProperties } = setup(selfCast);
                        const baseArmor = target.getArmor();
                        const baseAttack = target.getAttack();
                        if (initial) {
                            target.applyBuff(
                                new Spell({ spellProperties: getSpellConfig("System", name), amount: 1 }),
                                initial,
                            );
                        }
                        unitsHolder.refreshStackPowerForAllUnits();
                        const before = structuredClone(target.getUnitProperties());
                        roll(value);
                        const result = engine.apply({
                            type: "cast_spell",
                            casterId: caster.getId(),
                            targetId: target.getId(),
                            spellName: name,
                        });
                        const success = value < 50;
                        const total = initial + Number(success);
                        expect(result.completed).toBe(true);
                        expect(target.getBuff(name)?.getFirstSpellProperty() ?? 0).toBe(total);
                        expect(target.getArmor()).toBe(baseArmor + (name === "Armor Rune" ? total : 0));
                        expect(target.getAttack()).toBe(baseAttack + (name === "Weapon Rune" ? total : 0));
                        expect(
                            caster
                                .getSpells()
                                .find((spell) => spell.getName() === name)
                                ?.getAmount(),
                        ).toBe(4);
                        expect(fightProperties.hasAlreadyMadeTurn(caster.getId())).toBe(true);
                        const event = result.events.find((entry) => entry.type === "spell_cast");
                        expect(event?.type === "spell_cast" && event.outcomes).toEqual([
                            {
                                unitId: target.getId(),
                                outcome: success ? "enchanted" : "failed",
                                ...(success ? { amount: total } : {}),
                            },
                        ]);
                        if (!success) {
                            const after = target.getUnitProperties();
                            expect(after.applied_buffs).toEqual(before.applied_buffs);
                            expect(after.applied_buffs_descriptions).toEqual(before.applied_buffs_descriptions);
                            expect(after.applied_buffs_laps).toEqual(before.applied_buffs_laps);
                            expect(after.applied_buffs_powers).toEqual(before.applied_buffs_powers);
                        }
                    });
                }
            }

            it(`${name}, self=${selfCast}: success, failure, failure, success, failure retains both bonuses`, () => {
                const { target, caster, unitsHolder, engine, fightProperties } = setup(selfCast);
                const baseArmor = target.getArmor();
                const baseAttack = target.getAttack();
                target.applyBuff(new Spell({ spellProperties: getSpellConfig("System", "Armor Rune"), amount: 1 }), 2);
                target.applyBuff(new Spell({ spellProperties: getSpellConfig("System", "Weapon Rune"), amount: 1 }), 3);
                unitsHolder.refreshStackPowerForAllUnits();
                let gained = 0;
                for (const value of [0, 99, 50, 49, 99]) {
                    roll(value);
                    expect(
                        engine.apply({
                            type: "cast_spell",
                            casterId: caster.getId(),
                            targetId: target.getId(),
                            spellName: name,
                        }).completed,
                    ).toBe(true);
                    gained += Number(value < 50);
                    expect(target.getArmor()).toBe(baseArmor + 2 + (name === "Armor Rune" ? gained : 0));
                    expect(target.getAttack()).toBe(baseAttack + 3 + (name === "Weapon Rune" ? gained : 0));
                    expect(target.getBuffs().filter((buff) => buff.getName() === name)).toHaveLength(1);
                    fightProperties.flipLap();
                    fightProperties.startTurn(PBTypes.TeamVals.LEFT, 1000);
                }
                expect(caster.hasSpellRemaining(name)).toBe(false);
            });
        }
    }
});
