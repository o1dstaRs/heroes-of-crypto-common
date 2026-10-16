import { describe, expect, test } from "bun:test";
import { GameActionEngine } from "../../src/engine/action_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { GridType, TeamType } from "../../src/generated/protobuf/v1/types_gen";
import { getPositionForCell } from "../../src/grid/grid_math";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const start = { x: 5, y: 3 };
const destination = { x: 2, y: 3 };
const barrel = { x: 3, y: 3 };
const direct = [start, { x: 4, y: 3 }, barrel, destination];
const maps = [1, 2, 3, 4] as const;
const teams = [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT];

function fixture(map: GridType, team: TeamType, width = 1, height = 1, flying = false) {
    const context = createCombatTestContext(map);
    const { grid, unitsHolder } = context;
    const opponent = team === PBTypes.TeamVals.LEFT ? PBTypes.TeamVals.RIGHT : PBTypes.TeamVals.LEFT;
    const unit = createTestUnit({
        team,
        footprintWidth: width,
        footprintHeight: height,
        movementType: flying ? PBTypes.MovementVals.FLY : PBTypes.MovementVals.WALK,
    });
    unit.getUnitProperties().steps = 10;
    placeUnit(grid, unitsHolder, unit, start);
    const target = createTestUnit({ team: opponent, maxHp: 1000 });
    placeUnit(grid, unitsHolder, target, { x: destination.x - width, y: destination.y });
    const paths = () =>
        new PathHelper(grid.getSettings()).getMovePath(
            start,
            grid.getMatrix(),
            unit.getSteps(),
            undefined,
            flying,
            unit.isSmallSize(),
            false,
            false,
            width,
            height,
        ).knownPaths;
    const stale = paths();
    expect(grid.placeArtifactBarrel(opponent, 0, barrel)).toBe(true);
    const fp = FightStateManager.getInstance().getFightProperties();
    fp.startFight();
    const engine = (mode: "fresh" | "stale" | "absent" = "fresh") =>
        new GameActionEngine({
            ...context,
            fightProperties: fp,
            sceneLog: new SceneLogMock(),
            moveHandler: new MoveHandler(grid.getSettings(), grid, unitsHolder),
            getCurrentActiveUnitId: () => unit.getId(),
            getCurrentActiveKnownPaths: mode === "absent" ? undefined : mode === "stale" ? () => stale : paths,
        });
    const expectClearRoute = (route: XY[] | undefined) => {
        expect(route?.length).toBeGreaterThan(2);
        expect(route?.[0]).toEqual(start);
        expect(route?.at(-1)).toEqual(destination);
        for (const anchor of route!) expect(unit.getFootprintCellsForAnchor(anchor)).not.toContainEqual(barrel);
    };
    return { grid, unit, target, opponent, engine, expectClearRoute };
}

describe("authoritative barrel movement routes", () => {
    for (const map of maps)
        for (const team of teams)
            for (const [width, height] of [
                [1, 1],
                [2, 2],
                [1, 2],
                [2, 1],
            ]) {
                test(`map ${map}, team ${team}, ${width}x${height}: emits the legal detour, including footprint-only moves`, () => {
                    const h = fixture(map, team, width, height);
                    const targetCells = h.unit.getFootprintCellsForAnchor(destination);
                    const result = h.engine().apply({
                        type: "move_unit",
                        unitId: h.unit.getId(),
                        path: h.unit.isSmallSize() ? direct : targetCells,
                        targetCells,
                    });
                    expect(result.completed).toBe(true);
                    const move = result.events.find((event) => event.type === "unit_moved");
                    expect(move?.type).toBe("unit_moved");
                    if (move?.type !== "unit_moved") throw new Error("Missing move event");
                    h.expectClearRoute(move.path);
                    expect(h.grid.getOccupantUnitId(barrel)).toBe("B");
                    expect(h.unit.getBaseCell()).toEqual(destination);
                });
            }

    for (const mode of ["stale", "absent"] as const)
        for (const [width, height] of [
            [1, 1],
            [2, 2],
            [1, 2],
            [2, 1],
        ]) {
            test(`${mode} path cache, ${width}x${height}: rejects a ground route through a barrel until it breaks`, () => {
                const h = fixture(1, teams[0], width, height);
                const action = { type: "move_unit" as const, unitId: h.unit.getId(), path: direct };
                expect(h.engine(mode).apply(action).completed).toBe(false);
                expect(h.unit.getBaseCell()).toEqual(start);
                expect(h.unit.hasMovedThisTurn()).toBe(false);
                expect(h.grid.getOccupantUnitId(barrel)).toBe("B");
                h.grid.clearScatteredMountainAt(barrel.x, barrel.y);
                expect(h.engine(mode).apply(action).completed).toBe(true);
            });
        }

    for (const attack of ["melee", "obstacle"] as const) {
        test(`${attack} approaches carry the accepted detour for replay`, () => {
            const h = fixture(1, teams[0]);
            const targetCell = h.target.getBaseCell();
            if (attack === "obstacle") {
                h.grid.cleanupAll(h.target.getId(), h.target.getAttackRange(), true);
                expect(h.grid.placeArtifactBarrel(h.opponent, 1, targetCell)).toBe(true);
            }
            const result = h
                .engine()
                .apply(
                    attack === "melee"
                        ? {
                              type: "melee_attack",
                              attackerId: h.unit.getId(),
                              targetId: h.target.getId(),
                              attackFrom: destination,
                              path: direct,
                          }
                        : {
                              type: "obstacle_attack",
                              attackerId: h.unit.getId(),
                              attackFrom: destination,
                              path: direct,
                              targetPosition: getPositionForCell(
                                  targetCell,
                                  h.grid.getSettings().getMinX(),
                                  h.grid.getSettings().getStep(),
                                  h.grid.getSettings().getHalfStep(),
                              ),
                          },
                );
            expect(result.completed).toBe(true);
            const event = result.events.find(
                (event) => event.type === (attack === "melee" ? "unit_attacked" : "obstacle_attacked"),
            );
            if (event?.type !== "unit_attacked" && event?.type !== "obstacle_attacked")
                throw new Error("Missing attack");
            h.expectClearRoute(event.approachPath);
            expect(h.grid.getOccupantUnitId(barrel)).toBe("B");
        });
        for (const mode of ["stale", "absent"] as const)
            test(`${attack} rejects a ${mode} route through a barrel`, () => {
                const h = fixture(1, teams[0]);
                const targetCell = h.target.getBaseCell();
                if (attack === "obstacle") {
                    h.grid.cleanupAll(h.target.getId(), h.target.getAttackRange(), true);
                    h.grid.placeArtifactBarrel(h.opponent, 1, targetCell);
                }
                const result = h
                    .engine(mode)
                    .apply(
                        attack === "melee"
                            ? {
                                  type: "melee_attack",
                                  attackerId: h.unit.getId(),
                                  targetId: h.target.getId(),
                                  attackFrom: destination,
                                  path: direct,
                              }
                            : {
                                  type: "obstacle_attack",
                                  attackerId: h.unit.getId(),
                                  attackFrom: destination,
                                  path: direct,
                                  targetPosition: getPositionForCell(
                                      targetCell,
                                      h.grid.getSettings().getMinX(),
                                      h.grid.getSettings().getStep(),
                                      h.grid.getSettings().getHalfStep(),
                                  ),
                              },
                    );
                expect(result.completed).toBe(false);
                expect(h.unit.getBaseCell()).toEqual(start);
                expect(h.grid.getOccupantUnitId(barrel)).toBe("B");
            });
    }
    test("flight may cross a barrel but cannot land on it", () => {
        const h = fixture(1, teams[0], 1, 1, true);
        expect(
            h.engine().apply({ type: "move_unit", unitId: h.unit.getId(), path: direct.slice(0, 3) }).completed,
        ).toBe(false);
        expect(h.engine().apply({ type: "move_unit", unitId: h.unit.getId(), path: direct }).completed).toBe(true);
        expect(h.grid.getOccupantUnitId(barrel)).toBe("B");
    });
});
