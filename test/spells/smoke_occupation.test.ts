import { afterEach, describe, expect, it } from "bun:test";

import { GameActionEngine, type IGameActionEngineContext } from "../../src/engine/action_engine";
import type { GameAction } from "../../src/engine/actions";
import type { GameEvent } from "../../src/engine/events";
import { TurnEngine } from "../../src/engine/turn_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { GridType } from "../../src/generated/protobuf/v1/types_gen";
import { UPDATE_DOWN, UPDATE_LEFT, UPDATE_RIGHT, UPDATE_UP } from "../../src/grid/grid_constants";
import { getPositionForCell } from "../../src/grid/grid_math";
import { MoveHandler, type ISystemMoveResult } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { SmokeClouds } from "../../src/spells/smoke_clouds";
import type { XY } from "../../src/utils/math";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, placeUnit, type TestUnitOptions } from "../helpers/combat";

const GREEN = PBTypes.TeamVals.LEFT;
const RED = PBTypes.TeamVals.RIGHT;
const shapes = [
    [1, 1],
    [1, 2],
    [2, 1],
    [2, 2],
] as const;
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
const key = (cell: XY) => `${cell.x},${cell.y}`;

afterEach(() => setDeterministicRandomSource(undefined));

function setup(
    options: TestUnitOptions = {},
    start: XY = { x: 7, y: 7 },
    enemyCell: XY = { x: 14, y: 14 },
    gridType: GridType = PBTypes.GridVals.NORMAL,
    enemyOptions: TestUnitOptions = {},
) {
    const combat = createCombatTestContext(gridType);
    const mover = createTestUnit({ team: GREEN, maxHp: 1000, amountAlive: 10, exp: 100, ...options });
    mover.getUnitProperties().steps = 10;
    const enemy = createTestUnit({
        team: mover.getTeam() === GREEN ? RED : GREEN,
        maxHp: 1000,
        amountAlive: 10,
        exp: 100,
        ...enemyOptions,
    });
    placeUnit(combat.grid, combat.unitsHolder, mover, start);
    placeUnit(combat.grid, combat.unitsHolder, enemy, enemyCell);
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(gridType);
    fightProperties.startFight();
    fightProperties.setTeamUnitsAlive(GREEN, 1);
    fightProperties.setTeamUnitsAlive(RED, 1);
    fightProperties.startTurn(mover.getTeam(), 1000);
    const sceneLog = new SceneLogMock();
    const moveHandler = new MoveHandler(combat.grid.getSettings(), combat.grid, combat.unitsHolder);
    const engineContext: IGameActionEngineContext = {
        ...combat,
        fightProperties,
        sceneLog,
        moveHandler,
        getCurrentActiveUnitId: () => mover.getId(),
        getCurrentEnemiesCellsWithinMovementRange: () => enemy.getCells(),
    };
    const engine = new GameActionEngine(engineContext);
    mover.calculateAttackDamage = () => 10;
    enemy.calculateAttackDamage = () => 0;
    mover.calculateMissChance = enemy.calculateMissChance = () => 0;
    setDeterministicRandomSource(() => 0);
    return {
        ...combat,
        mover,
        enemy,
        engineContext,
        engine,
        fightProperties,
        moveHandler,
        sceneLog,
        clouds: fightProperties.getSmokeClouds(),
    };
}

function assertDispersal(s: ReturnType<typeof setup>, events: GameEvent[], cells: XY[]) {
    const dispels = events.filter((event) => event.type === "smoke_dispel");
    expect(dispels).toHaveLength(1);
    expect(dispels[0].cells).toHaveLength(cells.length);
    expect(dispels[0].cells.map(key).sort()).toEqual(cells.map(key).sort());
    for (const cell of cells) expect(s.clouds.has(cell)).toBe(false);
    // This is the exact plain store data the ranked server's transient-cell snapshot reads.
    const restored = SmokeClouds.fromJSON(JSON.parse(JSON.stringify(s.clouds.toJSON())));
    for (const cell of cells) expect(restored.has(cell)).toBe(false);
}

describe("Smoke clears on a successfully occupied footprint", () => {
    for (const team of [GREEN, RED]) {
        for (const [width, height] of shapes) {
            for (const movementType of [PBTypes.MovementVals.WALK, PBTypes.MovementVals.FLY]) {
                for (const direction of directions) {
                    for (const type of ["move_unit", "melee_attack"] as const) {
                        it(`${type}, team ${team}, ${width}x${height}, movement ${movementType}, direction ${key(direction)} clears only the final body`, () => {
                            const start = { x: 7, y: 7 };
                            const path = Array.from({ length: 4 }, (_, n) => ({
                                x: start.x + direction.x * n,
                                y: start.y + direction.y * n,
                            }));
                            const destination = path.at(-1)!;
                            const enemyCell = {
                                x: destination.x + (direction.x > 0 ? 1 : direction.x < 0 ? -width : 0),
                                y: destination.y + (direction.x !== 0 ? 0 : direction.y > 0 ? 1 : -height),
                            };
                            const s = setup(
                                { team, footprintWidth: width, footprintHeight: height, movementType },
                                start,
                                enemyCell,
                            );
                            const body = s.mover.getFootprintCellsForAnchor(destination);
                            const occupiedStart = new Set(s.mover.getCells().map(key));
                            const targetKeys = new Set(body.map(key));
                            const crossed = path
                                .slice(1, -1)
                                .find((cell) => !occupiedStart.has(key(cell)) && !targetKeys.has(key(cell)))!;
                            expect(crossed).toBeDefined();
                            for (const cell of [...body, crossed]) s.clouds.add(cell, 3);
                            const revision = s.clouds.getRevision();
                            let verifiedBeforeStrike = false;
                            s.mover.calculateAttackDamage = () => {
                                expect(body.some((cell) => s.clouds.has(cell))).toBe(false);
                                verifiedBeforeStrike = true;
                                return 10;
                            };
                            const action: GameAction =
                                type === "move_unit"
                                    ? { type, unitId: s.mover.getId(), path, targetCells: body }
                                    : {
                                          type,
                                          attackerId: s.mover.getId(),
                                          targetId: s.enemy.getId(),
                                          attackFrom: destination,
                                          path,
                                      };

                            const result = s.engine.apply(action);

                            expect(result.completed, result.rejectionReason).toBe(true);
                            expect(s.mover.getBaseCell()).toEqual(destination);
                            for (const cell of body) expect(s.grid.getOccupantUnitId(cell)).toBe(s.mover.getId());
                            assertDispersal(s, result.events, body);
                            expect(s.clouds.has(crossed)).toBe(true);
                            expect(s.clouds.size()).toBe(1);
                            expect(s.clouds.getRevision()).toBeGreaterThan(revision);
                            if (type === "melee_attack") {
                                expect(verifiedBeforeStrike).toBe(true);
                                expect(result.events.findIndex((event) => event.type === "smoke_dispel")).toBeLessThan(
                                    result.events.findIndex((event) => event.type === "unit_attacked"),
                                );
                            }
                        });
                    }
                }
            }
        }
    }
});

describe("Smoke on obstacle approaches and fatal arrivals", () => {
    for (const [width, height] of shapes) {
        for (const movementType of [PBTypes.MovementVals.WALK, PBTypes.MovementVals.FLY]) {
            it(`${width}x${height}, movement ${movementType}: removes smoke before a mountain strike`, () => {
                const s = setup(
                    { footprintWidth: width, footprintHeight: height, movementType },
                    { x: 1, y: 4 },
                    { x: 14, y: 14 },
                    PBTypes.GridVals.BLOCK_CENTER,
                );
                const destination = { x: 4, y: 7 };
                const body = s.mover.getFootprintCellsForAnchor(destination);
                for (const cell of body) s.clouds.add(cell);
                s.clouds.add({ x: 2, y: 5 });
                const result = s.engine.apply({
                    type: "obstacle_attack",
                    attackerId: s.mover.getId(),
                    targetPosition: getPositionForCell(
                        { x: 5, y: 7 },
                        s.grid.getSettings().getMinX(),
                        s.grid.getSettings().getStep(),
                        s.grid.getSettings().getHalfStep(),
                    ),
                    attackFrom: destination,
                    path: [{ x: 1, y: 4 }, { x: 2, y: 5 }, { x: 3, y: 6 }, destination],
                });
                expect(result.completed, result.rejectionReason).toBe(true);
                assertDispersal(s, result.events, body);
                expect(s.clouds.has({ x: 2, y: 5 })).toBe(true);
                expect(result.events.findIndex((event) => event.type === "smoke_dispel")).toBeLessThan(
                    result.events.findIndex((event) => event.type === "obstacle_attacked"),
                );
            });
        }
    }

    for (const type of ["move_unit", "melee_attack", "obstacle_attack"] as const) {
        it(`${type}: a unit killed by fire on arrival still removes smoke before its burn`, () => {
            const obstacle = type === "obstacle_attack";
            const start = obstacle ? { x: 1, y: 4 } : { x: 7, y: 7 };
            const destination = obstacle ? { x: 4, y: 7 } : { x: 10, y: 7 };
            const s = setup(
                { footprintWidth: 2, footprintHeight: 2, amountAlive: 1, maxHp: 40 },
                start,
                { x: 11, y: 7 },
                obstacle ? PBTypes.GridVals.BLOCK_CENTER : PBTypes.GridVals.NORMAL,
            );
            const body = s.mover.getFootprintCellsForAnchor(destination);
            for (const cell of body) {
                s.clouds.add(cell);
                s.fightProperties.getFireWalls().add(cell, 3, 100);
            }
            const path = obstacle
                ? [start, { x: 2, y: 5 }, { x: 3, y: 6 }, destination]
                : [start, { x: 8, y: 7 }, { x: 9, y: 7 }, destination];
            const action: GameAction =
                type === "move_unit"
                    ? { type, unitId: s.mover.getId(), path, targetCells: body }
                    : type === "melee_attack"
                      ? { type, attackerId: s.mover.getId(), targetId: s.enemy.getId(), path, attackFrom: destination }
                      : {
                            type,
                            attackerId: s.mover.getId(),
                            attackFrom: destination,
                            path,
                            targetPosition: getPositionForCell(
                                { x: 5, y: 7 },
                                s.grid.getSettings().getMinX(),
                                s.grid.getSettings().getStep(),
                                s.grid.getSettings().getHalfStep(),
                            ),
                        };
            const victimHp = s.enemy.getCumulativeHp();

            const result = s.engine.apply(action);

            expect(result.completed, result.rejectionReason).toBe(true);
            assertDispersal(s, result.events, body);
            expect(s.unitsHolder.getAllUnits().has(s.mover.getId())).toBe(false);
            expect(
                result.events.some((event) => event.type === "unit_attacked" || event.type === "obstacle_attacked"),
            ).toBe(false);
            expect(s.enemy.getCumulativeHp()).toBe(victimHp);
            expect(result.events.findIndex((event) => event.type === "smoke_dispel")).toBeLessThan(
                result.events.findIndex((event) => event.type === "fire_wall_burned"),
            );
        });
    }
});

describe("Smoke rejects unoccupied arrival claims", () => {
    for (const [width, height] of shapes) {
        for (const type of ["move_unit", "melee_attack", "obstacle_attack"] as const) {
            it(`${type}, ${width}x${height}: a refused grid stamp retains smoke and position`, () => {
                const obstacle = type === "obstacle_attack";
                const start = obstacle ? { x: 1, y: 4 } : { x: 7, y: 7 };
                const destination = obstacle ? { x: 4, y: 7 } : { x: 10, y: 7 };
                const s = setup(
                    { footprintWidth: width, footprintHeight: height },
                    start,
                    { x: 11, y: 7 },
                    obstacle ? PBTypes.GridVals.BLOCK_CENTER : PBTypes.GridVals.NORMAL,
                );
                const body = s.mover.getFootprintCellsForAnchor(destination);
                for (const cell of body) s.clouds.add(cell);
                const before = { ...s.mover.getPosition() };
                if (width * height === 1) s.grid.occupyCell = () => false;
                else s.grid.occupyCells = () => false;
                const path = obstacle
                    ? [start, { x: 2, y: 5 }, { x: 3, y: 6 }, destination]
                    : [start, { x: 8, y: 7 }, { x: 9, y: 7 }, destination];
                const action: GameAction =
                    type === "move_unit"
                        ? { type, unitId: s.mover.getId(), path, targetCells: body }
                        : type === "melee_attack"
                          ? {
                                type,
                                attackerId: s.mover.getId(),
                                targetId: s.enemy.getId(),
                                attackFrom: destination,
                                path,
                            }
                          : {
                                type,
                                attackerId: s.mover.getId(),
                                attackFrom: destination,
                                path,
                                targetPosition: getPositionForCell(
                                    { x: 5, y: 7 },
                                    s.grid.getSettings().getMinX(),
                                    s.grid.getSettings().getStep(),
                                    s.grid.getSettings().getHalfStep(),
                                ),
                            };

                const result = s.engine.apply(action);

                expect(result.completed).toBe(false);
                expect(result.events).toEqual([]);
                expect(s.mover.getPosition()).toEqual(before);
                expect(s.clouds.cells()).toEqual(body);
            });
        }
    }
});

describe("Smoke clears on summon, swap and narrowing arrivals", () => {
    for (const team of [GREEN, RED]) {
        for (const [width, height] of shapes) {
            it(`team ${team}, ${width}x${height}: a merged summon clears its registered body and preserves the unused aim cell's lifetime`, () => {
                const s = setup({ team, spells: ["Nature:Summon Wolves"] }, { x: 3, y: 3 });
                const existing = createTestUnit({
                    team,
                    name: "Wolf",
                    amountAlive: 3,
                    summoned: true,
                    footprintWidth: width,
                    footprintHeight: height,
                });
                placeUnit(s.grid, s.unitsHolder, existing, { x: 9, y: 5 });
                const body = existing.getCells();
                for (const cell of body) s.clouds.add(cell, 5);
                const unusedAim = { x: 3, y: 5 };
                s.clouds.add(unusedAim, 6);
                const before = { ...existing.getPosition() };

                const result = s.engine.apply({
                    type: "cast_spell",
                    casterId: s.mover.getId(),
                    spellName: "Summon Wolves",
                    targetCell: unusedAim,
                });

                expect(result.completed, result.rejectionReason).toBe(true);
                expect(existing.getAmountAlive()).toBeGreaterThan(3);
                expect(existing.getPosition()).toEqual(before);
                expect(result.events).toContainEqual(
                    expect.objectContaining({
                        type: "unit_summoned",
                        unitId: existing.getId(),
                        merged: true,
                        cells: body,
                    }),
                );
                assertDispersal(s, result.events, body);
                expect(s.clouds.toJSON()).toEqual([{ ...unusedAim, l: 6 }]);
            });
        }
    }

    for (const [width, height] of shapes) {
        it(`clears every ${width}x${height} summon cell without changing nearby smoke`, () => {
            const s = setup({ spells: ["Nature:Summon Wolves"] }, { x: 3, y: 3 });
            const body = createTestUnit({ footprintWidth: width, footprintHeight: height }).getFootprintCellsForAnchor({
                x: 3,
                y: 5,
            });
            for (const cell of body) s.clouds.add(cell);
            s.clouds.add({ x: 5, y: 5 });
            const engine = new GameActionEngine({
                ...s.engineContext,
                createSummonedUnit: ({ team, unitName, amount }) =>
                    createTestUnit({
                        team,
                        name: unitName,
                        amountAlive: amount,
                        summoned: true,
                        footprintWidth: width,
                        footprintHeight: height,
                    }),
            });

            const result = engine.apply({
                type: "cast_spell",
                casterId: s.mover.getId(),
                spellName: "Summon Wolves",
                targetCell: { x: 3, y: 5 },
            });

            expect(result.completed, result.rejectionReason).toBe(true);
            assertDispersal(s, result.events, body);
            expect(s.clouds.has({ x: 5, y: 5 })).toBe(true);
        });

        it(`clears legacy occupied smoke at both ${width}x${height} Castling arrivals once`, () => {
            const s = setup(
                { spells: ["System:Castling"], stackPower: 5, footprintWidth: width, footprintHeight: height },
                { x: 3, y: 3 },
                { x: 5, y: 3 },
                PBTypes.GridVals.NORMAL,
                { footprintWidth: width, footprintHeight: height },
            );
            const cells = [...s.enemy.getCells(), ...s.mover.getCells()];
            for (const cell of cells) s.clouds.add(cell);
            s.clouds.add({ x: 4, y: 5 });

            const result = s.engine.apply({
                type: "cast_spell",
                casterId: s.mover.getId(),
                spellName: "Castling",
                targetId: s.enemy.getId(),
            });

            expect(result.completed, result.rejectionReason).toBe(true);
            expect(s.mover.getBaseCell()).toEqual({ x: 5, y: 3 });
            expect(s.enemy.getBaseCell()).toEqual({ x: 3, y: 3 });
            assertDispersal(s, result.events, cells);
            expect(s.clouds.has({ x: 4, y: 5 })).toBe(true);
        });

        for (const [mask, base, destination] of [
            [UPDATE_RIGHT, { x: width - 1, y: 7 }, { x: width, y: 7 }],
            [UPDATE_LEFT, { x: 15, y: 7 }, { x: 14, y: 7 }],
            [UPDATE_UP, { x: 7, y: height - 1 }, { x: 7, y: height }],
            [UPDATE_DOWN, { x: 7, y: 15 }, { x: 7, y: 14 }],
        ] as const) {
            it(`forwards smoke removal for a ${width}x${height} narrowing shove with mask ${mask}`, () => {
                const s = setup({ footprintWidth: width, footprintHeight: height }, base);
                const startKeys = new Set(s.mover.getCells().map(key));
                const entered = s.mover
                    .getFootprintCellsForAnchor(destination)
                    .filter((cell) => !startKeys.has(key(cell)));
                for (const cell of entered) s.clouds.add(cell);
                const turnEngine = new TurnEngine(s.engineContext);
                const move = s.moveHandler.moveUnitTowardsCenter(base, mask, 1);
                const events = (
                    turnEngine as unknown as { handleSystemMoveResult(result: ISystemMoveResult): GameEvent[] }
                ).handleSystemMoveResult(move);

                expect(s.mover.getBaseCell()).toEqual(destination);
                assertDispersal(s, events, entered);
                expect(events.findIndex((event) => event.type === "unit_moved_by_system")).toBeLessThan(
                    events.findIndex((event) => event.type === "smoke_dispel"),
                );
            });
        }
    }

    it("clears the free smoky extension of a successfully spawned Infest queen", () => {
        const s = setup({ abilities: ["Infest"] }, { x: 9, y: 7 }, { x: 8, y: 7 }, PBTypes.GridVals.NORMAL, {
            level: PBTypes.UnitLevelVals.FOURTH,
            footprintWidth: 1,
            footprintHeight: 2,
            amountAlive: 1,
            maxHp: 100,
        });
        s.mover.calculateAttackDamage = () => 1000;
        const smoky = [
            { x: 7, y: 7 },
            { x: 7, y: 6 },
        ];
        for (const cell of smoky) s.clouds.add(cell);
        const engine = new GameActionEngine({
            ...s.engineContext,
            createSummonedUnit: ({ team, unitName }) =>
                createTestUnit({
                    team,
                    name: unitName,
                    amountAlive: 1,
                    summoned: true,
                    footprintWidth: 2,
                    footprintHeight: 2,
                }),
        });

        const result = engine.apply({
            type: "melee_attack",
            attackerId: s.mover.getId(),
            targetId: s.enemy.getId(),
            attackFrom: s.mover.getBaseCell(),
        });

        expect(result.completed, result.rejectionReason).toBe(true);
        const spawned = result.events.find((event) => event.type === "unit_summoned");
        expect(spawned).toMatchObject({ sourceAbility: "Infest", unitName: "Arachna Queen" });
        for (const cell of smoky) expect(s.grid.getOccupantUnitId(cell)).toBe(spawned?.unitId);
        assertDispersal(s, result.events, smoky);
    });

    it("does not disperse a failed summon's smoke", () => {
        const s = setup({ spells: ["Nature:Summon Wolves"] }, { x: 3, y: 3 });
        const smoky = { x: 3, y: 5 };
        s.clouds.add(smoky);
        s.grid.occupyCells = () => false;
        const engine = new GameActionEngine({
            ...s.engineContext,
            createSummonedUnit: ({ team, unitName }) => createTestUnit({ team, name: unitName, summoned: true }),
        });

        const result = engine.apply({
            type: "cast_spell",
            casterId: s.mover.getId(),
            spellName: "Summon Wolves",
            targetCell: smoky,
        });

        expect(result.completed).toBe(false);
        expect(result.events).toEqual([]);
        expect(s.clouds.has(smoky)).toBe(true);
    });

    it("clears smoke in headless melee resolution without adding visual events", () => {
        const s = setup({}, { x: 7, y: 7 }, { x: 11, y: 7 });
        const destination = { x: 10, y: 7 };
        s.clouds.add(destination);
        const engine = new GameActionEngine({ ...s.engineContext, eventMode: "headless" });

        const result = engine.apply({
            type: "melee_attack",
            attackerId: s.mover.getId(),
            targetId: s.enemy.getId(),
            attackFrom: destination,
            path: [{ x: 7, y: 7 }, { x: 8, y: 7 }, { x: 9, y: 7 }, destination],
        });

        expect(result.completed).toBe(true);
        expect(s.clouds.has(destination)).toBe(false);
        expect(result.events.some((event) => event.type === "smoke_dispel")).toBe(false);
    });

    it("preserves smoky cells when a larger Infest spawn cannot fit beyond its rectangular corpse", () => {
        const s = setup({ abilities: ["Infest"] }, { x: 7, y: 7 }, { x: 8, y: 7 }, PBTypes.GridVals.NORMAL, {
            level: PBTypes.UnitLevelVals.FOURTH,
            footprintWidth: 1,
            footprintHeight: 2,
            amountAlive: 1,
            maxHp: 100,
        });
        s.mover.calculateAttackDamage = () => 1000;
        const smoky = [
            { x: 7, y: 7 },
            { x: 7, y: 6 },
        ];
        // The queen grows left into the free cell below the killer. The corpse's cells were never smoked.
        s.clouds.add(smoky[1]);
        const engine = new GameActionEngine({
            ...s.engineContext,
            createSummonedUnit: ({ team, unitName }) =>
                createTestUnit({
                    team,
                    name: unitName,
                    amountAlive: 1,
                    summoned: true,
                    footprintWidth: 2,
                    footprintHeight: 2,
                }),
        });
        const result = engine.apply({
            type: "melee_attack",
            attackerId: s.mover.getId(),
            targetId: s.enemy.getId(),
            attackFrom: s.mover.getBaseCell(),
        });
        // The killer occupies one queen cell here, so a blocked expansion must not clear the other.
        expect(result.completed, result.rejectionReason).toBe(true);
        expect(result.events.some((event) => event.type === "unit_summoned")).toBe(false);
        expect(s.clouds.has(smoky[1])).toBe(true);
    });
});
