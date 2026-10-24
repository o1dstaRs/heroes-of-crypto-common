import { expect, test } from "bun:test";
import { productiveBarrelCoverAlternative } from "../../src/ai/barrel_cover_guard";
import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { GridType, TeamType } from "../../src/generated/protobuf/v1/types_gen";
import { getPositionForCell } from "../../src/grid/grid_math";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { snapshotBattle } from "../../src/simulation/battle_snapshot";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;
function fixture(map: GridType = 1, team: TeamType = LEFT) {
    const context = createCombatTestContext(map);
    const x = (value: number) => (team === LEFT ? value : 15 - value);
    const shooter = createTestUnit({ team, attackType: PBTypes.AttackVals.RANGE, rangeShots: 5 });
    const enemy = createTestUnit({ team: team === LEFT ? RIGHT : LEFT });
    placeUnit(context.grid, context.unitsHolder, shooter, { x: x(3), y: 11 });
    placeUnit(context.grid, context.unitsHolder, enemy, { x: x(10), y: 11 });
    const cell = { x: x(4), y: 12 };
    expect(context.grid.placeArtifactBarrel(team, 0, cell)).toBe(true);
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.startFight();
    const settings = context.grid.getSettings();
    const attack: GameAction = {
        type: "obstacle_attack",
        attackerId: shooter.getId(),
        targetPosition: getPositionForCell(cell, settings.getMinX(), settings.getStep(), settings.getHalfStep()),
    };
    const decisionContext = {
        ...context,
        matrix: context.grid.getMatrix(),
        fightProperties,
        pathHelper: new PathHelper(settings),
    };
    return { ...context, shooter, enemy, cell, attack, fightProperties, decisionContext };
}

for (const map of [1, 2, 3, 4] as const) {
    for (const team of [LEFT, RIGHT] as const) {
        test(`a productive shot preserves an owned screen without changing the projected state, map ${map}, team ${team}`, () => {
            const h = fixture(map, team);
            const before = snapshotBattle(h.unitsHolder, h.grid, h.fightProperties);
            const healthBefore = h.enemy.getCumulativeHp();
            const alternative = productiveBarrelCoverAlternative(h.shooter, h.decisionContext, [h.attack]);
            expect(alternative?.at(-1)).toMatchObject({ type: "range_attack", targetId: h.enemy.getId() });
            expect(snapshotBattle(h.unitsHolder, h.grid, h.fightProperties)).toEqual(before);
            const engine = new GameActionEngine({
                ...h,
                sceneLog: new SceneLogMock(),
                moveHandler: new MoveHandler(h.grid.getSettings(), h.grid, h.unitsHolder),
                getCurrentActiveUnitId: () => h.shooter.getId(),
            });
            for (const action of alternative!) expect(engine.apply(action).completed).toBe(true);
            expect(h.grid.getArtifactBarrels(team)).toHaveLength(1);
            expect(h.enemy.getCumulativeHp()).toBeLessThan(healthBefore);
        });
    }
}

test("clearing that really unlocks a teammate's forced shot remains available", () => {
    const h = fixture();
    h.grid.clearArtifactBarrels(LEFT);
    const enemy = createTestUnit({ team: RIGHT });
    const ally = createTestUnit({
        team: LEFT,
        attackType: PBTypes.AttackVals.RANGE,
        rangeShots: 5,
        target: enemy.getId(),
    });
    placeUnit(h.grid, h.unitsHolder, ally, { x: 3, y: 3 });
    placeUnit(h.grid, h.unitsHolder, enemy, { x: 10, y: 3 });
    const cell = { x: 5, y: 3 };
    h.grid.placeArtifactBarrel(LEFT, 0, cell);
    const settings = h.grid.getSettings();
    const attack = {
        ...h.attack,
        targetPosition: getPositionForCell(cell, settings.getMinX(), settings.getStep(), settings.getHalfStep()),
    };
    expect(
        productiveBarrelCoverAlternative(h.shooter, { ...h.decisionContext, matrix: h.grid.getMatrix() }, [attack]),
    ).toBeUndefined();
});

test("an enemy barrel and a planned move to a barrel are not rewritten", () => {
    const h = fixture();
    h.grid.clearArtifactBarrels(LEFT);
    h.grid.placeArtifactBarrel(RIGHT, 0, h.cell);
    expect(productiveBarrelCoverAlternative(h.shooter, h.decisionContext, [h.attack])).toBeUndefined();
    h.grid.clearArtifactBarrels(RIGHT);
    h.grid.placeArtifactBarrel(LEFT, 0, h.cell);
    expect(
        productiveBarrelCoverAlternative(h.shooter, h.decisionContext, [{ ...h.attack, path: [{ x: 4, y: 11 }] }]),
    ).toBeUndefined();
});

test("a barrel blocking the acting stack's only shot is still cleared", () => {
    const h = fixture();
    h.grid.clearArtifactBarrels(LEFT);
    const cell = { x: 5, y: 11 };
    h.grid.placeArtifactBarrel(LEFT, 0, cell);
    const settings = h.grid.getSettings();
    const attack = {
        ...h.attack,
        targetPosition: getPositionForCell(cell, settings.getMinX(), settings.getStep(), settings.getHalfStep()),
    };
    expect(
        productiveBarrelCoverAlternative(h.shooter, { ...h.decisionContext, matrix: h.grid.getMatrix() }, [attack]),
    ).toBeUndefined();
});
