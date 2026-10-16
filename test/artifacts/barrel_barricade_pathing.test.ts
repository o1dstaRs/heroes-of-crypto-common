import { describe, expect, it } from "bun:test";

import { GameActionEngine } from "../../src/engine/action_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getFootprintCellsForAnchor } from "../../src/grid/grid_math";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { ObstacleType } from "../../src/obstacles/obstacle_type";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const barrelCell = { x: 3, y: 3 };
const maps = [
    PBTypes.GridVals.NORMAL,
    PBTypes.GridVals.LAVA_CENTER,
    PBTypes.GridVals.WATER_CENTER,
    PBTypes.GridVals.BLOCK_CENTER,
];

describe("Barrel Barricade movement collision", () => {
    for (const gridType of maps) {
        for (const owner of [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT]) {
            it(`marks the barrel as blocking terrain on map ${gridType}, owner ${owner}`, () => {
                const { grid } = createCombatTestContext(gridType);
                grid.getMatrix(); // Prime the optional numeric-board cache before placing the barrel.
                expect(grid.placeArtifactBarrel(owner, 0, barrelCell)).toBe(true);
                expect(grid.getMatrix()[barrelCell.y][barrelCell.x]).toBe(ObstacleType.BLOCK);
                expect(grid.getMatrixNoUnits()[barrelCell.y][barrelCell.x]).toBe(ObstacleType.BLOCK);
                expect(grid.clearScatteredMountainAt(barrelCell.x, barrelCell.y)).toBe(true);
                expect(grid.getMatrix()[barrelCell.y][barrelCell.x]).toBe(0);
                expect(grid.getMatrixNoUnits()[barrelCell.y][barrelCell.x]).toBe(0);
            });
        }

        for (const size of [1, 2] as const) {
            it(`routes the entire ${size}x${size} body around an enemy barrel on map ${gridType}`, () => {
                const { grid, unitsHolder } = createCombatTestContext(gridType);
                const unit = createTestUnit({ team: PBTypes.TeamVals.RIGHT, size });
                placeUnit(grid, unitsHolder, unit, { x: 5, y: 4 });
                grid.placeArtifactBarrel(PBTypes.TeamVals.LEFT, 0, barrelCell);
                const path = new PathHelper(grid.getSettings()).getMovePath(
                    unit.getBaseCell()!,
                    grid.getMatrix(),
                    5,
                    undefined,
                    false,
                    size === 1,
                );
                expect(path.knownPaths.size).toBeGreaterThan(0);
                for (const routes of path.knownPaths.values()) {
                    for (const route of routes) {
                        for (const anchor of route.route) {
                            expect(getFootprintCellsForAnchor(anchor, size, size)).not.toContainEqual(barrelCell);
                        }
                    }
                }
            });
        }

        it(`rejects walking through a barrel and allows the same move after it breaks on map ${gridType}`, () => {
            const context = createCombatTestContext(gridType);
            const { grid, unitsHolder } = context;
            const fp = FightStateManager.getInstance().getFightProperties();
            const unit = createTestUnit({ team: PBTypes.TeamVals.RIGHT });
            placeUnit(grid, unitsHolder, unit, { x: 4, y: 3 });
            grid.placeArtifactBarrel(PBTypes.TeamVals.LEFT, 0, barrelCell);
            fp.startFight();
            const pathHelper = new PathHelper(grid.getSettings());
            const engine = new GameActionEngine({
                ...context,
                fightProperties: fp,
                sceneLog: new SceneLogMock(),
                moveHandler: new MoveHandler(grid.getSettings(), grid, unitsHolder),
                getCurrentActiveUnitId: () => unit.getId(),
                getCurrentActiveKnownPaths: () =>
                    pathHelper.getMovePath(unit.getBaseCell()!, grid.getMatrix(), 2).knownPaths,
            });
            const action = { type: "move_unit" as const, unitId: unit.getId(), path: [barrelCell, { x: 2, y: 3 }] };
            expect(engine.apply(action).completed).toBe(false);
            expect(unit.getBaseCell()).toEqual({ x: 4, y: 3 });
            expect(grid.getArtifactBarrels()).toHaveLength(1);
            grid.clearScatteredMountainAt(barrelCell.x, barrelCell.y);
            expect(engine.apply(action).completed).toBe(true);
            expect(unit.getBaseCell()).toEqual({ x: 2, y: 3 });
        });
    }
});
