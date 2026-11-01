import { afterEach, expect, test } from "bun:test";

import { GameActionEngine } from "../../src/engine/action_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getPositionForCell } from "../../src/grid/grid_math";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

afterEach(() => setDeterministicRandomSource(undefined));

for (const ability of ["Fire Breath", "Skewer Strike"]) {
    test(`${ability} stops at a classic mountain behind the struck deployment barrel`, () => {
        const context = createCombatTestContext(PBTypes.GridVals.BLOCK_CENTER);
        const fp = FightStateManager.getInstance().getFightProperties();
        fp.setGridType(PBTypes.GridVals.BLOCK_CENTER);
        const attacker = createTestUnit({
            name: "Piercer",
            team: PBTypes.TeamVals.LEFT,
            abilities: [ability],
            maxHp: 5000,
            amountAlive: 1,
            damageMin: 1,
            damageMax: 1,
        });
        const enemy = createTestUnit({ name: "Enemy", team: PBTypes.TeamVals.RIGHT, maxHp: 5000, amountAlive: 1 });
        placeUnit(context.grid, context.unitsHolder, attacker, { x: 3, y: 7 });
        placeUnit(context.grid, context.unitsHolder, enemy, { x: 12, y: 12 });
        expect(context.grid.placeArtifactBarrel(PBTypes.TeamVals.LEFT, 0, { x: 4, y: 7 })).toBe(true);
        const before = [fp.getObstacleHitsLeftLeft(), fp.getObstacleHitsLeftRight()];
        fp.startFight();
        fp.startTurn(attacker.getTeam(), 1000);
        setDeterministicRandomSource(() => 0.5);
        const engine = new GameActionEngine({
            ...context,
            fightProperties: fp,
            sceneLog: new SceneLogMock(),
            moveHandler: new MoveHandler(context.grid.getSettings(), context.grid, context.unitsHolder),
            getCurrentActiveUnitId: () => attacker.getId(),
        });
        const settings = context.grid.getSettings();
        const result = engine.apply({
            type: "obstacle_attack",
            attackerId: attacker.getId(),
            targetPosition: getPositionForCell(
                { x: 4, y: 7 },
                settings.getMinX(),
                settings.getStep(),
                settings.getHalfStep(),
            ),
            attackFrom: attacker.getBaseCell(),
        });
        expect(result.completed).toBe(true);
        expect(context.grid.getArtifactBarrels()).toEqual([]);
        expect([fp.getObstacleHitsLeftLeft(), fp.getObstacleHitsLeftRight()]).toEqual(before);
        expect(context.grid.getOccupantUnitId({ x: 5, y: 7 })).toBe("B");
    });

    test(`${ability} does not spend classic mountain hits when an unrelated deployment barrel exists`, () => {
        const context = createCombatTestContext(PBTypes.GridVals.BLOCK_CENTER);
        const fp = FightStateManager.getInstance().getFightProperties();
        fp.setGridType(PBTypes.GridVals.BLOCK_CENTER);
        const attacker = createTestUnit({
            name: "Piercer",
            team: PBTypes.TeamVals.LEFT,
            abilities: [ability],
            maxHp: 5000,
            amountAlive: 1,
            damageMin: 1,
            damageMax: 1,
        });
        const target = createTestUnit({ name: "Target", team: PBTypes.TeamVals.RIGHT, maxHp: 5000, amountAlive: 1 });
        placeUnit(context.grid, context.unitsHolder, attacker, { x: 3, y: 7 });
        placeUnit(context.grid, context.unitsHolder, target, { x: 4, y: 7 });
        expect(context.grid.placeArtifactBarrel(PBTypes.TeamVals.LEFT, 0, { x: 3, y: 6 })).toBe(true);
        const before = [fp.getObstacleHitsLeftLeft(), fp.getObstacleHitsLeftRight()];
        fp.startFight();
        fp.startTurn(attacker.getTeam(), 1000);
        setDeterministicRandomSource(() => 0.5);
        const engine = new GameActionEngine({
            ...context,
            fightProperties: fp,
            sceneLog: new SceneLogMock(),
            moveHandler: new MoveHandler(context.grid.getSettings(), context.grid, context.unitsHolder),
            getCurrentActiveUnitId: () => attacker.getId(),
        });
        expect(
            engine.apply({
                type: "melee_attack",
                attackerId: attacker.getId(),
                targetId: target.getId(),
                attackFrom: attacker.getBaseCell(),
            }).completed,
        ).toBe(true);
        expect([fp.getObstacleHitsLeftLeft(), fp.getObstacleHitsLeftRight()]).toEqual(before);
        expect(context.grid.getOccupantUnitId({ x: 5, y: 7 })).toBe("B");
        expect(context.grid.getArtifactBarrels()).toHaveLength(1);
    });
}

test("a spin beside a deployment barrel breaks that barrel without spending classic mountain hits", () => {
    const context = createCombatTestContext(PBTypes.GridVals.BLOCK_CENTER);
    const fp = FightStateManager.getInstance().getFightProperties();
    fp.setGridType(PBTypes.GridVals.BLOCK_CENTER);
    const spinner = createTestUnit({
        name: "Spinner",
        team: PBTypes.TeamVals.LEFT,
        abilities: ["Lightning Spin"],
        maxHp: 5000,
        amountAlive: 1,
        damageMin: 1,
        damageMax: 1,
    });
    const target = createTestUnit({ name: "Target", team: PBTypes.TeamVals.RIGHT, maxHp: 5000, amountAlive: 1 });
    placeUnit(context.grid, context.unitsHolder, spinner, { x: 4, y: 8 });
    placeUnit(context.grid, context.unitsHolder, target, { x: 4, y: 9 });
    expect(context.grid.placeArtifactBarrel(PBTypes.TeamVals.LEFT, 0, { x: 3, y: 8 })).toBe(true);
    const before = [fp.getObstacleHitsLeftLeft(), fp.getObstacleHitsLeftRight()];
    fp.startFight();
    fp.startTurn(spinner.getTeam(), 1000);
    setDeterministicRandomSource(() => 0.5);
    const engine = new GameActionEngine({
        ...context,
        fightProperties: fp,
        sceneLog: new SceneLogMock(),
        moveHandler: new MoveHandler(context.grid.getSettings(), context.grid, context.unitsHolder),
        getCurrentActiveUnitId: () => spinner.getId(),
    });
    const result = engine.apply({
        type: "melee_attack",
        attackerId: spinner.getId(),
        targetId: target.getId(),
        attackFrom: spinner.getBaseCell(),
    });
    expect(result.completed).toBe(true);
    expect(context.grid.getArtifactBarrels()).toEqual([]);
    expect(context.grid.getOccupantUnitId({ x: 3, y: 8 })).toBe("");
    expect([fp.getObstacleHitsLeftLeft(), fp.getObstacleHitsLeftRight()]).toEqual(before);
    expect(context.grid.getOccupantUnitId({ x: 5, y: 8 })).toBe("B");
});
