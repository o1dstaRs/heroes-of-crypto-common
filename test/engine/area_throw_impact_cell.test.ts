import { afterEach, expect, test } from "bun:test";
import { GameActionEngine } from "../../src/engine/action_engine";
import { createSequenceGameRuntime } from "../../src/engine/runtime";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { getPositionForCell } from "../../src/grid/grid_math";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

const previousFight = FightStateManager.getInstance().getFightProperties();
afterEach(() => FightStateManager.getInstance().setFightProperties(previousFight));

function fixture(
    attackerCell: XY,
    targetCell: XY,
    width: number,
    height: number,
    gridType = PBTypes.GridVals.NORMAL,
    attackerSize: 1 | 2 = 1,
) {
    const context = createCombatTestContext(gridType);
    const attacker = createTestUnit({
        name: "Gargantuan",
        team: PBTypes.TeamVals.LEFT,
        attackType: PBTypes.AttackVals.RANGE,
        abilities: ["Area Throw", "Double Throw"],
        rangeShots: 5,
        damageMin: 10,
        damageMax: 10,
        size: attackerSize,
        footprintWidth: attackerSize,
        footprintHeight: attackerSize,
    });
    placeUnit(context.grid, context.unitsHolder, attacker, attackerCell);
    attacker.refreshPossibleAttackTypes(true);
    const target = createTestUnit({
        name: "Manticore",
        team: PBTypes.TeamVals.RIGHT,
        footprintWidth: width,
        footprintHeight: height,
        maxHp: 1000,
        amountAlive: 10,
    });
    placeUnit(context.grid, context.unitsHolder, target, targetCell);
    const fight = FightStateManager.getInstance().getFightProperties();
    fight.setGridType(gridType);
    fight.startFight();
    fight.startTurn(attacker.getTeam(), 1000);
    const engine = new GameActionEngine({
        ...context,
        fightProperties: fight,
        moveHandler: new MoveHandler(testGridSettings, context.grid, context.unitsHolder),
        sceneLog: new SceneLogMock(),
        getCurrentActiveUnitId: () => attacker.getId(),
        runtime: createSequenceGameRuntime({ nowMillis: [1400] }),
    });
    return { ...context, attacker, target, engine };
}

function assertImpact(f: ReturnType<typeof fixture>, aim: XY, impact: XY) {
    const position = getPositionForCell(
        impact,
        testGridSettings.getMinX(),
        testGridSettings.getStep(),
        testGridSettings.getHalfStep(),
    );
    expect(f.attackHandler.projectAreaThrowTargetCell(f.unitsHolder.getAllUnits(), f.attacker, aim)).toEqual(impact);
    const result = f.engine.apply({ type: "area_throw_attack", attackerId: f.attacker.getId(), targetCell: aim });
    expect(result.completed).toBe(true);
    const event = result.events.find((event) => event.type === "area_attacked");
    if (event?.type !== "area_attacked") throw new Error("Expected area throw");
    expect(event.targetCell).toEqual(impact);
    expect(event.targetPosition).toEqual(position);
    expect(
        event.animations.every(
            (animation) => animation.toPosition?.x === position.x && animation.toPosition?.y === position.y,
        ),
    ).toBe(true);
    expect(new Set(event.affectedUnitIds).size).toBe(event.affectedUnitIds.length);
    return event;
}

test("reported two-cell Manticore: aiming behind it cannot move the blast onto its hidden far cell", () => {
    const f = fixture({ x: 1, y: 1 }, { x: 5, y: 1 }, 2, 1, PBTypes.GridVals.NORMAL, 2);
    const near = createTestUnit({ name: "Near blast", team: PBTypes.TeamVals.RIGHT, maxHp: 1000, amountAlive: 10 });
    const far = createTestUnit({ name: "Far blast", team: PBTypes.TeamVals.RIGHT, maxHp: 1000, amountAlive: 10 });
    placeUnit(f.grid, f.unitsHolder, near, { x: 3, y: 2 });
    placeUnit(f.grid, f.unitsHolder, far, { x: 6, y: 2 });
    const nearHp = near.getCumulativeHp();
    const farHp = far.getCumulativeHp();
    const event = assertImpact(f, { x: 6, y: 1 }, { x: 4, y: 1 });
    expect(event.targetCell).not.toEqual(f.target.getBaseCell());
    expect(event.affectedUnitIds).toContain(near.getId());
    expect(event.affectedUnitIds).not.toContain(far.getId());
    expect(near.getCumulativeHp()).toBeLessThan(nearHp);
    expect(far.getCumulativeHp()).toBe(farHp);
    expect(event.damage.splash?.filter((hit) => hit.unitId === f.target.getId())).toHaveLength(2);
});

for (const [width, height, from, aim, impact] of [
    [2, 1, { x: 2, y: 8 }, { x: 12, y: 8 }, { x: 7, y: 8 }],
    [2, 1, { x: 13, y: 8 }, { x: 2, y: 8 }, { x: 8, y: 8 }],
    [2, 1, { x: 7, y: 2 }, { x: 7, y: 12 }, { x: 7, y: 8 }],
    [2, 1, { x: 7, y: 13 }, { x: 7, y: 2 }, { x: 7, y: 8 }],
    [1, 2, { x: 8, y: 2 }, { x: 8, y: 12 }, { x: 8, y: 7 }],
    [1, 2, { x: 8, y: 13 }, { x: 8, y: 2 }, { x: 8, y: 8 }],
    [1, 2, { x: 2, y: 7 }, { x: 12, y: 7 }, { x: 8, y: 7 }],
    [1, 2, { x: 13, y: 7 }, { x: 2, y: 7 }, { x: 8, y: 7 }],
] as const) {
    test(`${width}x${height} body: ${from.x},${from.y} hits its first visible cell`, () => {
        assertImpact(fixture(from, { x: 8, y: 8 }, width, height), aim, impact);
    });
}

test("lava cells earlier on the ray cannot be mistaken for the intercepted unit's impact", () => {
    const f = fixture({ x: 3, y: 7 }, { x: 10, y: 8 }, 1, 2, PBTypes.GridVals.LAVA_CENTER);
    const event = assertImpact(f, { x: 14, y: 7 }, { x: 10, y: 7 });
    expect(event.affectedUnitIds).toContain(f.target.getId());
});
