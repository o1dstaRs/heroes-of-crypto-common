import { describe, expect, it } from "bun:test";

import { GameActionEngine } from "../../src/engine/action_engine";
import { projectPostMoveActorAvailability } from "../../src/engine/post_move_actor_availability";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getFootprintCellsForAnchor, getSweptFootprintCells } from "../../src/grid/grid_math";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const names = (cells: readonly XY[]) => cells.map((cell) => `${cell.x},${cell.y}`).sort();
const origin = { x: 7, y: 7 };
const directions = [
    { x: 1, y: 1 },
    { x: -1, y: 1 },
    { x: 1, y: -1 },
    { x: -1, y: -1 },
];

function setup(width: number, height: number, direction: XY, flying = false) {
    const context = createCombatTestContext();
    const mover = createTestUnit({
        team: PBTypes.TeamVals.LEFT,
        footprintWidth: width,
        footprintHeight: height,
        movementType: flying ? PBTypes.MovementVals.FLY : PBTypes.MovementVals.WALK,
        maxHp: 40,
        amountAlive: 4,
    });
    mover.getUnitProperties().steps = 10;
    const destination = { x: origin.x + direction.x, y: origin.y + direction.y };
    const target = createTestUnit({ team: PBTypes.TeamVals.RIGHT, maxHp: 100, amountAlive: 10 });
    placeUnit(context.grid, context.unitsHolder, mover, origin);
    placeUnit(context.grid, context.unitsHolder, target, {
        x: destination.x + (direction.x > 0 ? 1 : -width),
        y: destination.y,
    });
    const start = getFootprintCellsForAnchor(origin, width, height);
    const landing = getFootprintCellsForAnchor(destination, width, height);
    const occupied = new Set(names([...start, ...landing]));
    // Independent one-step sweep oracle: the two corners of the bounding rectangle that neither
    // endpoint footprint occupies are exactly the cells the old waypoint-only check missed.
    const corners: XY[] = [];
    for (let x = Math.min(origin.x, destination.x) - width + 1; x <= Math.max(origin.x, destination.x); x++) {
        for (let y = Math.min(origin.y, destination.y) - height + 1; y <= Math.max(origin.y, destination.y); y++) {
            if (!occupied.has(`${x},${y}`)) corners.push({ x, y });
        }
    }
    expect(corners).toHaveLength(2);
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.startFight();
    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LEFT, 1);
    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.RIGHT, 1);
    fightProperties.startTurn(PBTypes.TeamVals.LEFT, 1_000);
    const walls = fightProperties.getFireWalls();
    walls.addAll(corners, 3);
    const sceneLog = new SceneLogMock();
    const engine = new GameActionEngine({
        ...context,
        fightProperties,
        sceneLog,
        moveHandler: new MoveHandler(context.grid.getSettings(), context.grid, context.unitsHolder),
        getCurrentActiveUnitId: () => mover.getId(),
        getCurrentActiveKnownPaths: () =>
            new PathHelper(context.grid.getSettings()).getMovePath(
                origin,
                context.grid.getMatrix(),
                10,
                undefined,
                flying,
                width * height === 1,
                false,
                false,
                width,
                height,
            ).knownPaths,
    });
    const action = {
        type: "move_unit" as const,
        unitId: mover.getId(),
        path: [origin, destination],
        targetCells: landing,
    };
    return { ...context, mover, target, engine, walls, destination, corners, action, sceneLog };
}

describe("ground movement through diagonal Fire Wall corners", () => {
    for (const [width, height] of [
        [1, 1],
        [2, 1],
        [1, 2],
        [2, 2],
    ]) {
        for (const direction of directions) {
            const label = `${width}x${height}, direction ${direction.x},${direction.y}`;

            it(`${label}: burns both crossed corners on a clear-to-clear move, matching projection`, () => {
                const s = setup(width, height, direction);
                const swept = getSweptFootprintCells(origin, s.destination, width, height);
                expect(s.corners.every((cell) => names(swept).includes(`${cell.x},${cell.y}`))).toBe(true);
                const projected = projectPostMoveActorAvailability(s.mover, s.walls, s.action);
                expect(names(projected.burningCells)).toEqual(names(s.corners));
                expect(projected.totalAppliedDamage).toBe(70); // 25% of 160, then 25% of the surviving 120.
                const result = s.engine.apply(s.action);
                expect(result.completed).toBe(true);
                const burn = result.events.find((event) => event.type === "fire_wall_burned");
                expect(names(burn?.cells ?? [])).toEqual(names(s.corners));
                expect(burn?.amount).toBe(70);
                expect(s.mover.getCumulativeHp()).toBe(90);
                expect(projected.stack.amountAlive).toBe(s.mover.getAmountAlive());
                expect(projected.stack.hp).toBe(s.mover.getHp());
            });

            it(`${label}: burns a melee approach before its strike`, () => {
                const s = setup(width, height, direction);
                const result = s.engine.apply({
                    type: "melee_attack",
                    attackerId: s.mover.getId(),
                    targetId: s.target.getId(),
                    attackFrom: s.destination,
                    path: s.action.path,
                });
                expect(result.completed).toBe(true);
                const burn = result.events.find((event) => event.type === "fire_wall_burned");
                expect(names(burn?.cells ?? [])).toEqual(names(s.corners));
                expect(burn?.amount).toBe(70);
                expect(result.events.findIndex((event) => event.type === "unit_attacked")).toBeGreaterThan(
                    result.events.indexOf(burn!),
                );
            });

            it(`${label}: flyers still clear the corners without burning`, () => {
                const s = setup(width, height, direction, true);
                expect(projectPostMoveActorAvailability(s.mover, s.walls, s.action).totalAppliedDamage).toBe(0);
                const result = s.engine.apply(s.action);
                expect(result.completed).toBe(true);
                expect(result.events.some((event) => event.type === "fire_wall_burned")).toBe(false);
                expect(s.mover.getCumulativeHp()).toBe(160);
            });
        }
    }

    it("prices the diagonal corner contact in the pathfinder as well as in damage", () => {
        const s = setup(1, 1, directions[0]);
        const paths = new PathHelper(s.grid.getSettings()).getMovePath(origin, s.grid.getMatrix(), 10);
        const route = paths.knownPaths.get((s.destination.x << 4) | s.destination.y)![0];
        expect(route.weight).toBeCloseTo(PathHelper.DIAGONAL_MOVE_COST + 2, 5);
    });

    it("uses the resolved walk for a legacy destination-footprint payload", () => {
        const s = setup(2, 2, directions[0]);
        const action = { ...s.action, path: [...s.action.targetCells].reverse() };
        const projected = projectPostMoveActorAvailability(s.mover, s.walls, action, {
            route: s.action.path,
            hasLavaCell: false,
            hasWaterCell: false,
        });
        expect(projected.totalAppliedDamage).toBe(70);
        const result = s.engine.apply(action);
        expect(result.completed).toBe(true);
        expect(result.events).toContainEqual(expect.objectContaining({ type: "fire_wall_burned", amount: 70 }));
        expect(s.mover.getCumulativeHp()).toBe(90);
    });

    it("removes a stack killed at the diagonal crossing before it can deliver a melee strike", () => {
        const s = setup(1, 1, directions[0]);
        s.mover.applyDamage(159, 0, s.sceneLog);
        const result = s.engine.apply({
            type: "melee_attack",
            attackerId: s.mover.getId(),
            targetId: s.target.getId(),
            attackFrom: s.destination,
            path: s.action.path,
        });
        expect(result.completed).toBe(true);
        expect(result.events.some((event) => event.type === "unit_destroyed")).toBe(true);
        expect(result.events.some((event) => event.type === "unit_attacked")).toBe(false);
        expect(s.unitsHolder.getAllUnits().has(s.mover.getId())).toBe(false);
    });
});
