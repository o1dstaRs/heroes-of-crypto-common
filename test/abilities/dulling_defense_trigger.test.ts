/*
 * Dulling Defense rides the Goblin Knight's own melee blow: his attack and his retaliation.
 * A hit he does not answer does not dull the striker.
 */

import { afterEach, describe, expect, it } from "bun:test";

import { GameActionEngine } from "../../src/engine/action_engine";
import { createSequenceGameRuntime } from "../../src/engine/runtime";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler } from "../../src/handlers/move_handler";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

describe("Dulling Defense triggers only on the knight's own blow", () => {
    afterEach(() => setDeterministicRandomSource(undefined));

    const fight = () => {
        setDeterministicRandomSource(() => 0);
        const context = createCombatTestContext();
        const fightProperties = FightStateManager.getInstance().getFightProperties();
        fightProperties.startFight();
        const knight = createTestUnit({
            name: "Goblin Knight",
            team: PBTypes.TeamVals.LEFT,
            abilities: ["Dulling Defense"],
            attack: 20,
            damageMin: 10,
            damageMax: 10,
            maxHp: 200,
            amountAlive: 4,
            stackPower: 5,
        });
        const orc = createTestUnit({
            name: "Orc",
            team: PBTypes.TeamVals.RIGHT,
            attack: 12,
            damageMin: 8,
            damageMax: 8,
            maxHp: 200,
            amountAlive: 4,
            stackPower: 5,
        });
        placeUnit(context.grid, context.unitsHolder, knight, { x: 4, y: 4 });
        placeUnit(context.grid, context.unitsHolder, orc, { x: 5, y: 4 });
        fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LEFT, 1);
        fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.RIGHT, 1);
        let activeId = knight.getId();
        const engine = new GameActionEngine({
            fightProperties,
            grid: context.grid,
            unitsHolder: context.unitsHolder,
            moveHandler: new MoveHandler(testGridSettings, context.grid, context.unitsHolder),
            sceneLog: context.attackHandler["sceneLog"],
            attackHandler: context.attackHandler,
            getCurrentActiveUnitId: () => activeId,
            runtime: createSequenceGameRuntime({ nowMillis: [1400] }),
        });
        return {
            ...context,
            fightProperties,
            engine,
            knight,
            orc,
            activate: (unit: { getId: () => string }) => {
                activeId = unit.getId();
            },
        };
    };

    const dulled = (unit: ReturnType<typeof createTestUnit>): number | undefined =>
        unit.getDebuff("Dulling Defense")?.getPower();

    it("the knight's attack dulls the unit he struck, even when that unit does not answer", () => {
        const { engine, fightProperties, knight, orc } = fight();
        fightProperties.startTurn(PBTypes.TeamVals.LEFT, 1000);
        orc.setResponded(true);

        const result = engine.apply({
            type: "melee_attack",
            attackerId: knight.getId(),
            targetId: orc.getId(),
            attackFrom: { x: 4, y: 4 },
        });

        expect(result.completed).toBe(true);
        expect(dulled(orc)).toBe(2);
        expect(orc.getBaseAttack()).toBe(10);
        expect(dulled(knight)).toBeUndefined();
    });

    it("a hit the knight does not answer dulls nobody", () => {
        const { engine, fightProperties, knight, orc, activate } = fight();
        activate(orc);
        fightProperties.startTurn(PBTypes.TeamVals.RIGHT, 1000);
        knight.setResponded(true);

        const result = engine.apply({
            type: "melee_attack",
            attackerId: orc.getId(),
            targetId: knight.getId(),
            attackFrom: { x: 5, y: 4 },
        });

        expect(result.completed).toBe(true);
        expect(dulled(orc)).toBeUndefined();
        expect(dulled(knight)).toBeUndefined();
        expect(orc.getBaseAttack()).toBe(12);
        expect(knight.getBaseAttack()).toBe(20);
    });

    it("the knight's retaliation dulls the unit he struck back", () => {
        const { engine, fightProperties, knight, orc, activate } = fight();
        activate(orc);
        fightProperties.startTurn(PBTypes.TeamVals.RIGHT, 1000);

        const result = engine.apply({
            type: "melee_attack",
            attackerId: orc.getId(),
            targetId: knight.getId(),
            attackFrom: { x: 5, y: 4 },
        });

        expect(result.completed).toBe(true);
        expect(dulled(orc)).toBe(2);
        expect(orc.getBaseAttack()).toBe(10);
        expect(dulled(knight)).toBeUndefined();
    });

    it("counts a flat 2 even for a partial stack with luck", () => {
        const knight = createTestUnit({
            name: "Goblin Knight",
            abilities: ["Dulling Defense"],
            luck: 10,
            stackPower: 1,
            amountAlive: 1,
        });
        const ability = knight.getAbility("Dulling Defense");

        expect(ability?.getPower()).toBe(2);
        expect(knight.calculateAbilityCount(ability!, 5)).toBe(2);
    });
});
