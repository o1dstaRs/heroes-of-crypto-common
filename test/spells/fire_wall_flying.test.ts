import { describe, expect, it } from "bun:test";

import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameAction } from "../../src/engine/actions";
import {
    projectPostMoveActorAvailability,
    repairUnavailableMovePrefixedAttack,
} from "../../src/engine/post_move_actor_availability";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { GridType } from "../../src/generated/protobuf/v1/types_gen";
import { getFootprintCellsForAnchor, getPositionForCell } from "../../src/grid/grid_math";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { FIRE_WALL_ORIENTATIONS, fireWallCells } from "../../src/spells/fire_walls";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, placeUnit, type TestUnitOptions } from "../helpers/combat";

const directions: XY[] = [
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
    { x: -1, y: 1 },
    { x: -1, y: 0 },
    { x: -1, y: -1 },
    { x: 0, y: -1 },
    { x: 1, y: -1 },
];
const footprints = [
    { width: 1, height: 1 },
    { width: 2, height: 2 },
    { width: 2, height: 1 },
    { width: 1, height: 2 },
];
const start = { x: 7, y: 7 };
const along = (direction: XY, distance: number): XY => ({
    x: start.x + direction.x * distance,
    y: start.y + direction.y * distance,
});
const route = (direction: XY, distance: number): XY[] =>
    Array.from({ length: distance + 1 }, (_, index) => along(direction, index));

function setup(
    options: TestUnitOptions = {},
    enemyCell: XY = { x: 14, y: 14 },
    base: XY = start,
    gridType: GridType = PBTypes.GridVals.NORMAL,
) {
    const context = createCombatTestContext(gridType);
    const mover = createTestUnit({
        team: PBTypes.TeamVals.LEFT,
        movementType: PBTypes.MovementVals.FLY,
        maxHp: 40,
        amountAlive: 4,
        ...options,
    });
    mover.getUnitProperties().steps = 10;
    const enemy = createTestUnit({ team: PBTypes.TeamVals.RIGHT, maxHp: 100, amountAlive: 10 });
    placeUnit(context.grid, context.unitsHolder, mover, base);
    placeUnit(context.grid, context.unitsHolder, enemy, enemyCell);
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(gridType);
    fightProperties.startFight();
    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LEFT, 1);
    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.RIGHT, 1);
    fightProperties.startTurn(PBTypes.TeamVals.LEFT, 1_000);
    const sceneLog = new SceneLogMock();
    const engine = new GameActionEngine({
        ...context,
        fightProperties,
        sceneLog,
        moveHandler: new MoveHandler(context.grid.getSettings(), context.grid, context.unitsHolder),
        getCurrentActiveUnitId: () => mover.getId(),
    });
    return { ...context, mover, enemy, sceneLog, engine, walls: fightProperties.getFireWalls() };
}

describe("flying over Fire Wall", () => {
    for (const { width, height } of footprints) {
        for (const direction of directions) {
            for (const orientation of FIRE_WALL_ORIENTATIONS) {
                for (const landsInFire of [false, true]) {
                    it(`${width}x${height}, direction ${direction.x},${direction.y}, wall ${orientation}: ${landsInFire ? "only landing burns" : "crossing is safe"}`, () => {
                        const s = setup({ footprintWidth: width, footprintHeight: height });
                        const distance = landsInFire ? 3 : 6;
                        const targetCells = s.mover.getFootprintCellsForAnchor(along(direction, distance));
                        s.walls.addAll(fireWallCells(along(direction, 3), orientation), 3);
                        const action: Extract<GameAction, { type: "move_unit" }> = {
                            type: "move_unit",
                            unitId: s.mover.getId(),
                            path: route(direction, distance),
                            targetCells,
                        };
                        const expectedBurning = targetCells.filter((cell) => s.walls.has(cell));
                        expect(action.path.some((cell) => s.walls.has(cell))).toBe(true);
                        expect(expectedBurning.length > 0).toBe(landsInFire);
                        const projected = projectPostMoveActorAvailability(s.mover, s.walls, action);
                        expect(projected.burningCells).toEqual(expectedBurning);

                        let expectedHp = 160;
                        for (let index = 0; index < expectedBurning.length; index += 1) {
                            expectedHp -= Math.floor(Math.ceil(expectedHp / 40) * 40 * 0.25);
                        }
                        const result = s.engine.apply(action);
                        expect(result.completed).toBe(true);
                        const burn = result.events.find((event) => event.type === "fire_wall_burned");
                        expect(burn?.cells ?? []).toEqual(expectedBurning);
                        expect(burn?.amount ?? 0).toBe(160 - expectedHp);
                        expect(s.mover.getCumulativeHp()).toBe(expectedHp);
                        expect(projected.totalAppliedDamage).toBe(160 - expectedHp);
                        expect(projected.stack.amountAlive).toBe(s.mover.getAmountAlive());
                        expect(projected.stack.hp).toBe(s.mover.getHp());
                        expect(new Set(s.mover.getCells().map((cell) => `${cell.x},${cell.y}`))).toEqual(
                            new Set(targetCells.map((cell) => `${cell.x},${cell.y}`)),
                        );
                    });
                }
            }

            for (const landingCell of getFootprintCellsForAnchor(along(direction, 3), width, height)) {
                it(`${width}x${height}, direction ${direction.x},${direction.y}: landing burns body cell ${landingCell.x},${landingCell.y}`, () => {
                    const s = setup({ footprintWidth: width, footprintHeight: height });
                    s.walls.add(landingCell, 3);
                    const targetCells = s.mover.getFootprintCellsForAnchor(along(direction, 3));
                    const result = s.engine.apply({
                        type: "move_unit",
                        unitId: s.mover.getId(),
                        path: width * height > 1 ? [...targetCells].reverse() : route(direction, 3),
                        targetCells,
                    });
                    expect(result.completed).toBe(true);
                    expect(result.events).toContainEqual(
                        expect.objectContaining({
                            type: "fire_wall_burned",
                            cells: [landingCell],
                            amount: 40,
                        }),
                    );
                    expect(s.mover.getCumulativeHp()).toBe(120);
                });
            }

            for (const landsInFire of [false, true]) {
                it(`${width}x${height}, direction ${direction.x},${direction.y}: melee ${landsInFire ? "landing burns before the strike" : "approach crosses safely"}`, () => {
                    const attackFrom = along(direction, 3);
                    const enemyCell = {
                        x: attackFrom.x + (direction.x > 0 ? 1 : direction.x < 0 ? -width : 0),
                        y: attackFrom.y + (direction.x !== 0 ? 0 : direction.y > 0 ? 1 : -height),
                    };
                    const s = setup({ footprintWidth: width, footprintHeight: height }, enemyCell);
                    const landingCell = s.mover.getFootprintCellsForAnchor(attackFrom).at(-1)!;
                    s.walls.add(landsInFire ? landingCell : along(direction, 1), 3);
                    const result = s.engine.apply({
                        type: "melee_attack",
                        attackerId: s.mover.getId(),
                        targetId: s.enemy.getId(),
                        attackFrom,
                        path: route(direction, 3),
                    });
                    expect(result.completed).toBe(true);
                    const burn = result.events.find((event) => event.type === "fire_wall_burned");
                    expect(burn?.cells ?? []).toEqual(landsInFire ? [landingCell] : []);
                    expect(burn?.amount ?? 0).toBe(landsInFire ? 40 : 0);
                    const strikeIndex = result.events.findIndex((event) => event.type === "unit_attacked");
                    expect(strikeIndex).toBeGreaterThanOrEqual(0);
                    if (landsInFire) {
                        expect(result.events.indexOf(burn!)).toBeLessThan(strikeIndex);
                    }
                });
            }
        }
    }

    it("does not spend Water Shield or Resurrection crossing fire, and preserves a planned follow-up strike", () => {
        const s = setup({
            amountAlive: 1,
            abilities: ["Water Shield", "Resurrection"],
            spells: ["System:Resurrection"],
        });
        s.mover.applyDamage(39, 0, s.sceneLog);
        s.mover.trySeedWaterShield();
        s.walls.addAll(
            [
                { x: 8, y: 7 },
                { x: 9, y: 7 },
            ],
            3,
            100,
        );
        const move: Extract<GameAction, { type: "move_unit" }> = {
            type: "move_unit",
            unitId: s.mover.getId(),
            path: route({ x: 1, y: 0 }, 3),
        };
        const strike: GameAction = {
            type: "melee_attack",
            attackerId: s.mover.getId(),
            targetId: s.enemy.getId(),
            attackFrom: { x: 10, y: 7 },
        };
        const projected = projectPostMoveActorAvailability(s.mover, s.walls, move);
        expect(projected).toMatchObject({
            totalAppliedDamage: 0,
            waterShieldConsumed: false,
            resurrected: false,
            availableAfterMove: true,
        });
        expect(repairUnavailableMovePrefixedAttack(s.mover, s.walls, [move, strike])).toEqual([move, strike]);
        expect(s.engine.apply(move).completed).toBe(true);
        expect(s.mover.getCumulativeHp()).toBe(1);
        expect(s.mover.willWaterShieldAbsorb()).toBe(true);
        expect(s.mover.hasSpellRemaining("Resurrection")).toBe(true);
    });

    it("keeps lethal landing damage and cleanup, and drops a planned strike after landing in fire", () => {
        const s = setup({ amountAlive: 1 });
        s.mover.applyDamage(39, 0, s.sceneLog);
        s.walls.add({ x: 8, y: 7 }, 3);
        const move: Extract<GameAction, { type: "move_unit" }> = {
            type: "move_unit",
            unitId: s.mover.getId(),
            path: [start, { x: 8, y: 7 }],
        };
        const strike: GameAction = {
            type: "melee_attack",
            attackerId: s.mover.getId(),
            targetId: s.enemy.getId(),
            attackFrom: { x: 8, y: 7 },
        };
        expect(projectPostMoveActorAvailability(s.mover, s.walls, move).availableAfterMove).toBe(false);
        expect(repairUnavailableMovePrefixedAttack(s.mover, s.walls, [move, strike])).toEqual([move]);
        const result = s.engine.apply(move);
        expect(result.completed).toBe(true);
        expect(result.events).toContainEqual(
            expect.objectContaining({ type: "unit_destroyed", unitId: s.mover.getId() }),
        );
        expect(s.unitsHolder.getAllUnits().has(s.mover.getId())).toBe(false);
    });

    for (const landsInFire of [false, true]) {
        it(`a wounded flying attacker ${landsInFire ? "dies on landing before it can strike" : "survives crossing fire long enough to strike"}`, () => {
            const s = setup({ amountAlive: 1 }, { x: 11, y: 7 });
            s.mover.applyDamage(39, 0, s.sceneLog);
            s.walls.add({ x: landsInFire ? 10 : 8, y: 7 }, 3);
            const victimHp = s.enemy.getCumulativeHp();
            const result = s.engine.apply({
                type: "melee_attack",
                attackerId: s.mover.getId(),
                targetId: s.enemy.getId(),
                attackFrom: { x: 10, y: 7 },
                path: route({ x: 1, y: 0 }, 3),
            });
            expect(result.completed).toBe(true);
            expect(result.events.some((event) => event.type === "fire_wall_burned")).toBe(landsInFire);
            expect(result.events.some((event) => event.type === "unit_attacked")).toBe(!landsInFire);
            if (landsInFire) {
                expect(s.enemy.getCumulativeHp()).toBe(victimHp);
                expect(s.unitsHolder.getAllUnits().has(s.mover.getId())).toBe(false);
            }
        });
    }

    it("charges only landing cells against Water Shield, then burns the unshielded second landing cell", () => {
        const s = setup({ footprintWidth: 2, footprintHeight: 2, abilities: ["Water Shield"] });
        s.mover.trySeedWaterShield();
        s.walls.add({ x: 8, y: 7 }, 3, 100);
        s.walls.add({ x: 10, y: 7 }, 3, 100);
        s.walls.add({ x: 9, y: 6 }, 3);
        const action: Extract<GameAction, { type: "move_unit" }> = {
            type: "move_unit",
            unitId: s.mover.getId(),
            path: route({ x: 1, y: 0 }, 3),
            targetCells: s.mover.getFootprintCellsForAnchor({ x: 10, y: 7 }),
        };
        const projected = projectPostMoveActorAvailability(s.mover, s.walls, action);
        expect(projected.burningCells).toEqual([
            { x: 10, y: 7 },
            { x: 9, y: 6 },
        ]);
        expect(projected.fireWallHits.map((hit) => hit.absorbedByWaterShield)).toEqual([true, false]);
        expect(projected.totalAppliedDamage).toBe(40);
        const result = s.engine.apply(action);
        expect(result.completed).toBe(true);
        expect(s.mover.getCumulativeHp()).toBe(120);
        expect(s.mover.willWaterShieldAbsorb()).toBe(false);
    });

    it("does not burn a flying stationary attack or a takeoff from fire onto clear ground", () => {
        const stationary = setup({}, { x: 8, y: 7 });
        stationary.walls.add(start, 3);
        const strike = stationary.engine.apply({
            type: "melee_attack",
            attackerId: stationary.mover.getId(),
            targetId: stationary.enemy.getId(),
            attackFrom: start,
        });
        expect(strike.completed).toBe(true);
        expect(strike.events.some((event) => event.type === "fire_wall_burned")).toBe(false);

        const departing = setup({ footprintWidth: 2, footprintHeight: 2 });
        departing.walls.addAll(departing.mover.getCells(), 3);
        const action: Extract<GameAction, { type: "move_unit" }> = {
            type: "move_unit",
            unitId: departing.mover.getId(),
            path: route({ x: 1, y: 0 }, 3),
            targetCells: departing.mover.getFootprintCellsForAnchor({ x: 10, y: 7 }),
        };
        expect(projectPostMoveActorAvailability(departing.mover, departing.walls, action).burningCells).toEqual([]);
        const moved = departing.engine.apply(action);
        expect(moved.completed).toBe(true);
        expect(moved.events.some((event) => event.type === "fire_wall_burned")).toBe(false);
        expect(departing.mover.getCumulativeHp()).toBe(160);
    });

    for (const { width, height } of footprints) {
        for (const landsInFire of [false, true]) {
            it(`${width}x${height}: a flying obstacle attack ${landsInFire ? "burns on landing" : "crosses fire safely"}`, () => {
                const s = setup(
                    { footprintWidth: width, footprintHeight: height },
                    { x: 14, y: 14 },
                    { x: 3, y: 3 },
                    PBTypes.GridVals.BLOCK_CENTER,
                );
                const target = { x: 7, y: 3 };
                const attackFrom = { x: 6, y: 3 };
                s.grid.setScatteredMountains([target]);
                const burning = landsInFire ? s.mover.getFootprintCellsForAnchor(attackFrom).at(-1)! : { x: 4, y: 3 };
                s.walls.add(burning, 3);
                const result = s.engine.apply({
                    type: "obstacle_attack",
                    attackerId: s.mover.getId(),
                    attackFrom,
                    targetPosition: getPositionForCell(
                        target,
                        s.grid.getSettings().getMinX(),
                        s.grid.getSettings().getStep(),
                        s.grid.getSettings().getHalfStep(),
                    ),
                    path: [{ x: 3, y: 3 }, { x: 4, y: 3 }, { x: 5, y: 3 }, attackFrom],
                });
                expect(result.completed).toBe(true);
                const burn = result.events.find((event) => event.type === "fire_wall_burned");
                expect(burn?.cells ?? []).toEqual(landsInFire ? [burning] : []);
                expect(burn?.amount ?? 0).toBe(landsInFire ? 40 : 0);
                expect(result.events.some((event) => event.type === "obstacle_attacked")).toBe(true);
                expect(s.grid.getScatteredMountainsStanding()).toEqual([]);
            });
        }
    }

    for (const direction of directions) {
        it(`direction ${direction.x},${direction.y}: Fire Wall adds no flight movement cost, including landing`, () => {
            const s = setup();
            const destination = along(direction, 2);
            s.walls.addAll(route(direction, 2).slice(1), 3);
            const paths = new PathHelper(s.grid.getSettings()).getMovePath(
                start,
                s.grid.getMatrix(),
                10,
                undefined,
                true,
            );
            const routes = paths.knownPaths.get((destination.x << 4) | destination.y)!;
            expect(routes.length).toBeGreaterThan(0);
            expect(Math.min(...routes.map((candidate) => candidate.weight))).toBeCloseTo(
                2 * (direction.x && direction.y ? PathHelper.DIAGONAL_MOVE_COST : 1),
                5,
            );
        });
    }
});
