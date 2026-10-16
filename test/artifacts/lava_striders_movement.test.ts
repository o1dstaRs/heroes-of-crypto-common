import { describe, expect, it } from "bun:test";

import { Tier2Artifact } from "../../src/artifacts/artifact_properties";
import { GameActionEngine } from "../../src/engine/action_engine";
import { projectPostMoveActorAvailability } from "../../src/engine/post_move_actor_availability";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

function setup(
    width = 1,
    height = 1,
    innate = false,
    artifact = true,
    movement: { flying?: boolean; origin?: XY } = {},
) {
    const { grid, unitsHolder, attackHandler } = createCombatTestContext(PBTypes.GridVals.LAVA_CENTER);
    const fight = FightStateManager.getInstance().getFightProperties();
    const unit = createTestUnit({
        name: "Squire",
        team: PBTypes.TeamVals.LEFT,
        size: width * height > 1 ? PBTypes.UnitSizeVals.LARGE : PBTypes.UnitSizeVals.SMALL,
        footprintWidth: width,
        footprintHeight: height,
        attack: 20,
        armor: 10,
        maxHp: 100,
        movementType: movement.flying ? PBTypes.MovementVals.FLY : PBTypes.MovementVals.WALK,
        abilities: innate ? ["Made of Fire"] : [],
    });
    placeUnit(grid, unitsHolder, unit, movement.origin ?? { x: 5, y: 7 });
    const enemy = createTestUnit({ team: PBTypes.TeamVals.RIGHT });
    placeUnit(grid, unitsHolder, enemy, { x: 14, y: 14 });
    if (artifact) fight.setArtifactPerTeam(PBTypes.TeamVals.LEFT, 2, Tier2Artifact.LAVA_STRIDERS);
    unitsHolder.applyArtifacts(fight);
    unitsHolder.refreshStackPowerForAllUnits();
    fight.setGridType(PBTypes.GridVals.LAVA_CENTER);
    fight.startFight();
    fight.setTeamUnitsAlive(PBTypes.TeamVals.LEFT, 1);
    fight.setTeamUnitsAlive(PBTypes.TeamVals.RIGHT, 1);
    fight.startTurn(PBTypes.TeamVals.LEFT, 1000);
    const pathHelper = new PathHelper(testGridSettings);
    const knownPaths = pathHelper.getMovePath(
        unit.getBaseCell(),
        grid.getMatrix(),
        unit.getSteps(),
        grid.getAggrMatrixByTeam(PBTypes.TeamVals.RIGHT),
        unit.canFly(),
        unit.isSmallSize(),
        unit.canTraverseLava(),
        unit.hasAbilityActive("In Its Own World"),
        width,
        height,
    ).knownPaths;
    const engine = new GameActionEngine({
        fightProperties: fight,
        grid,
        unitsHolder,
        moveHandler: new MoveHandler(testGridSettings, grid, unitsHolder),
        sceneLog: new SceneLogMock(),
        attackHandler,
        getCurrentActiveUnitId: () => unit.getId(),
        getCurrentActiveKnownPaths: () => knownPaths,
    });
    return { engine, fight, grid, unit, unitsHolder, knownPaths };
}

describe("Lava Striders movement bonuses", () => {
    for (const [width, height] of [
        [1, 1],
        [2, 2],
        [1, 2],
        [2, 1],
    ]) {
        for (const artifact of [true, false]) {
            it(`a ${width}x${height} flyer crossing lava and landing on dry ground ${artifact ? "earns the artifact buff" : "gets no buff without the artifact"}`, () => {
                const { engine, grid, unit, knownPaths } = setup(width, height, false, artifact, { flying: true });
                const target = { x: 7, y: 5 };
                const targetCells = unit.getFootprintCellsForAnchor(target);
                const route = knownPaths.get((target.x << 4) | target.y)![0];
                expect(unit.canFly()).toBe(true);
                expect(route.hasLavaCell).toBe(true);
                expect(targetCells.every((cell) => grid.getOccupantUnitId(cell) !== "L")).toBe(true);
                const result = engine.apply({
                    type: "move_unit",
                    unitId: unit.getId(),
                    path: route.route,
                    targetCells,
                    hasLavaCell: false,
                });
                expect(result.completed).toBe(true);
                expect(unit.getBaseCell()).toEqual(target);
                expect(unit.hasBuffActive("Made of Fire")).toBe(artifact);
            });
        }
    }

    for (const [width, height] of [
        [2, 2],
        [1, 2],
        [2, 1],
    ]) {
        it(`counts lava beneath the ${width}x${height} flying body when its anchor and landing stay dry`, () => {
            const origin = height > 1 ? { x: 5, y: 9 } : { x: 9, y: 5 };
            const target = height > 1 ? { x: 7, y: 11 } : { x: 11, y: 7 };
            const { engine, fight, grid, unit, knownPaths } = setup(width, height, false, true, {
                flying: true,
                origin,
            });
            const targetCells = unit.getFootprintCellsForAnchor(target);
            const route = knownPaths.get((target.x << 4) | target.y)![0];
            expect(route.route.every((cell) => grid.getOccupantUnitId(cell) !== "L")).toBe(true);
            expect(unit.getCells().every((cell) => grid.getOccupantUnitId(cell) !== "L")).toBe(true);
            expect(targetCells.every((cell) => grid.getOccupantUnitId(cell) !== "L")).toBe(true);
            expect(route.hasLavaCell).toBe(true);
            const action = { type: "move_unit" as const, unitId: unit.getId(), path: route.route, targetCells };
            const projected = projectPostMoveActorAvailability(unit, fight.getFireWalls(), action, route);
            expect(engine.apply(action).completed).toBe(true);
            expect(unit.hasBuffActive("Made of Fire")).toBe(true);
            expect(projected.madeOfFireApplied).toBe(true);
            expect(projected.stack.maxHp).toBe(unit.getMaxHp());
        });
    }

    for (const [width, height, footprintOnly] of [
        [1, 1, false],
        [2, 2, false],
        [1, 2, false],
        [2, 1, false],
        [2, 2, true],
        [2, 1, true],
    ] as const) {
        it(`grants the buff on a one-cell ${width}x${height} move with ${footprintOnly ? "a destination footprint" : "an ordered path"}`, () => {
            const { engine, fight, unit, unitsHolder, knownPaths } = setup(width, height);
            const target = { x: 6, y: 7 };
            const targetCells = unit.getFootprintCellsForAnchor(target);
            const route = knownPaths.get((target.x << 4) | target.y)![0];
            const attackBefore = unit.getBaseAttack();
            const hpBefore = unit.getMaxHp();
            expect(route.hasLavaCell).toBe(true);
            expect(unit.hasBuffActive("Made of Fire")).toBe(false);
            fight.getFireWalls().add(target, 3, 25);
            const action = {
                type: "move_unit" as const,
                unitId: unit.getId(),
                path: footprintOnly ? targetCells : [unit.getBaseCell(), target],
                targetCells,
                hasLavaCell: false,
            };
            const projected = projectPostMoveActorAvailability(unit, fight.getFireWalls(), action, route);
            const result = engine.apply(action);
            expect(result.completed).toBe(true);
            expect(unit.getBaseCell()).toEqual(target);
            expect(unit.hasBuffActive("Made of Fire")).toBe(true);
            expect(unit.hasAbilityActive("Made of Fire")).toBe(false);
            expect(projected.madeOfFireApplied).toBe(true);
            expect(projected.stack.maxHp).toBe(unit.getMaxHp());
            expect(projected.stack.hp).toBe(unit.getHp());
            unitsHolder.applyArtifacts(fight);
            unitsHolder.refreshStackPowerForAllUnits();
            expect(unit.getBaseAttack()).toBeCloseTo(attackBefore * 1.1);
            expect(unit.getMaxHp()).toBe(Math.round(hpBefore * 1.1));
            expect(unit.getUnitProperties().applied_buffs.filter((name) => name === "Made of Fire")).toHaveLength(1);
        });
    }

    it("also grants the terrain bonus to an innate lava walker on a one-cell move", () => {
        const { engine, unit } = setup(1, 1, true, false);
        const result = engine.apply({
            type: "move_unit",
            unitId: unit.getId(),
            path: [unit.getBaseCell(), { x: 6, y: 7 }],
        });
        expect(result.completed).toBe(true);
        expect(unit.hasBuffActive("Made of Fire")).toBe(true);
    });

    it("does not grant a terrain bonus from a forged lava flag on dry ground", () => {
        const { engine, unit } = setup();
        const result = engine.apply({
            type: "move_unit",
            unitId: unit.getId(),
            path: [unit.getBaseCell(), { x: 5, y: 8 }],
            hasLavaCell: true,
        });
        expect(result.completed).toBe(true);
        expect(unit.hasBuffActive("Made of Fire")).toBe(false);
    });

    it("does not grant the buff or move an army that cannot traverse lava", () => {
        const { engine, unit } = setup(1, 1, false, false);
        const origin = unit.getBaseCell();
        const result = engine.apply({
            type: "move_unit",
            unitId: unit.getId(),
            path: [origin, { x: 6, y: 7 }],
            hasLavaCell: true,
        });
        expect(result.completed).toBe(false);
        expect(unit.getBaseCell()).toEqual(origin);
        expect(unit.hasBuffActive("Made of Fire")).toBe(false);
    });
});
