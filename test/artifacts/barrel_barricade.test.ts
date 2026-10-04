import { describe, expect, it } from "bun:test";

import {
    ArtifactTier,
    Tier1Artifact,
    TIER1_ARTIFACT_LIST,
    formatArtifactDescription,
} from "../../src/artifacts/artifact_properties";
import { GameActionEngine } from "../../src/engine/action_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { autoPlaceArtifactBarrels, reconcileArtifactBarrels } from "../../src/grid/artifact_barrels";
import { getPositionForCell } from "../../src/grid/grid_math";
import { scatteredMountainsForSeed } from "../../src/grid/scattered_mountains";
import { MoveHandler } from "../../src/handlers/move_handler";
import { BattleRollbackJournal, snapshotBattle, restoreBattle } from "../../src/simulation/battle_snapshot";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;
const fixture = (gridType = PBTypes.GridVals.NORMAL, ranged = false) => {
    const context = createCombatTestContext(gridType);
    const fp = FightStateManager.getInstance().getFightProperties();
    fp.setGridType(gridType);
    fp.setArtifactPerTeam(LEFT, ArtifactTier.TIER_1, Tier1Artifact.BARREL_BARRICADE);
    if (gridType === PBTypes.GridVals.BLOCK_CENTER)
        context.grid.setScatteredMountains(scatteredMountainsForSeed("barrel-test").map((barrel) => barrel.cell));
    const attacker = createTestUnit({
        team: LEFT,
        name: "Attacker",
        attackType: ranged ? PBTypes.AttackVals.RANGE : PBTypes.AttackVals.MELEE,
        rangeShots: ranged ? 4 : 0,
    });
    const enemy = createTestUnit({ team: RIGHT, name: "Enemy" });
    placeUnit(context.grid, context.unitsHolder, attacker, { x: 4, y: 3 });
    placeUnit(context.grid, context.unitsHolder, enemy, { x: 12, y: 12 });
    const engine = new GameActionEngine({
        ...context,
        fightProperties: fp,
        sceneLog: new SceneLogMock(),
        moveHandler: new MoveHandler(context.grid.getSettings(), context.grid, context.unitsHolder),
        getCurrentActiveUnitId: () => attacker.getId(),
        canPlaceBarrel: (team, cell) => team === LEFT && cell.x >= 1 && cell.x <= 4 && cell.y >= 1 && cell.y <= 5,
    });
    return { ...context, fp, engine, attacker };
};
const place = (engine: GameActionEngine, barrelIndex: number, x = 3, y = 3) =>
    engine.apply({ type: "place_barrel", team: LEFT, barrelIndex, cell: { x, y } });

describe("Barrel Barricade", () => {
    it("replaces the Helm in the tier-one draft and formats both Amulet bonuses", () => {
        expect(TIER1_ARTIFACT_LIST.some((artifact) => artifact.name === "Helm of Focus")).toBe(false);
        expect(TIER1_ARTIFACT_LIST.find((artifact) => artifact.id === 11)?.name).toBe("Barrel Barricade");
        const amulet = TIER1_ARTIFACT_LIST.find((artifact) => artifact.id === Tier1Artifact.AMULET_OF_RESOLVE)!;
        expect(formatArtifactDescription(amulet)).toBe(
            "Increases the army's status resistance by 25%. Increases the army's mind resistance by 25%.",
        );
    });
    it("owns exactly two terrain slots without adding creatures or consuming unit capacity", () => {
        const { grid, unitsHolder, engine } = fixture();
        expect(place(engine, 0).completed).toBe(true);
        expect(place(engine, 1, 2, 5).completed).toBe(true);
        expect(place(engine, 2, 2, 4).completed).toBe(false);
        expect(place(engine, -1).completed).toBe(false);
        expect(unitsHolder.getAllUnits().size).toBe(2);
        expect(grid.getArtifactBarrels(LEFT)).toHaveLength(2);
        expect(grid.getOccupantUnitId({ x: 3, y: 3 })).toBe("B");
        expect(grid.areAllCellsEmpty([{ x: 3, y: 3 }])).toBe(false);
    });
    it("repositions the same slot and rolls back when the new cell is occupied", () => {
        const { grid, engine } = fixture();
        place(engine, 0);
        expect(place(engine, 0, 4, 3).completed).toBe(false);
        expect(grid.getOccupantUnitId({ x: 3, y: 3 })).toBe("B");
        expect(place(engine, 0, 2, 4).completed).toBe(true);
        expect(grid.getOccupantUnitId({ x: 3, y: 3 })).toBe("");
        expect(grid.getArtifactBarrels()).toEqual([{ team: LEFT, index: 0, cell: { x: 2, y: 4 } }]);
        expect(engine.apply({ type: "unplace_barrel", team: LEFT, barrelIndex: 0 }).completed).toBe(true);
        expect(grid.getArtifactBarrels()).toEqual([]);
        expect(grid.getScatteredMountainsStanding()).toEqual([]);
        expect(grid.hasScatteredMountains()).toBe(true); // Empty authoritative layout must still travel.
    });
    it("rejects an absent artifact, the opponent's zone, malformed cells, and collisions", () => {
        const { fp, engine } = fixture();
        expect(place(engine, 0, 12, 12).completed).toBe(false);
        expect(place(engine, 0, 2.1, 2).completed).toBe(false);
        expect(place(engine, 0, -1, 2).completed).toBe(false);
        expect(place(engine, 0, NaN, 2).completed).toBe(false);
        place(engine, 0);
        expect(place(engine, 1).completed).toBe(false);
        fp.setArtifactPerTeam(LEFT, ArtifactTier.TIER_1, Tier1Artifact.AMULET_OF_RESOLVE);
        expect(place(engine, 1, 2, 2).completed).toBe(false);
    });
    it("clears barrels when the artifact changes or a smaller deployment zone excludes them", () => {
        const { grid, fp, engine } = fixture();
        place(engine, 0);
        place(engine, 1, 2, 2);
        reconcileArtifactBarrels(grid, fp, LEFT, (cell) => cell.x === 2);
        expect(grid.getArtifactBarrels()).toHaveLength(1);
        expect(grid.getOccupantUnitId({ x: 3, y: 3 })).toBe("");
        fp.setArtifactPerTeam(LEFT, ArtifactTier.TIER_1, Tier1Artifact.NO_ARTIFACT);
        reconcileArtifactBarrels(grid, fp, LEFT);
        expect(grid.getArtifactBarrels()).toEqual([]);
    });
    it("auto-fills empty slots after unit placement, keeps the player's cell, and locks both actions in combat", () => {
        const { grid, fp, engine } = fixture();
        place(engine, 0);
        autoPlaceArtifactBarrels(grid, fp, LEFT, [
            { x: 3, y: 3 },
            { x: 4, y: 3 },
            { x: 2, y: 5 },
        ]);
        expect(grid.getArtifactBarrels()).toEqual([
            { team: LEFT, index: 0, cell: { x: 3, y: 3 } },
            { team: LEFT, index: 1, cell: { x: 2, y: 5 } },
        ]);
        fp.startFight();
        expect(place(engine, 0, 1, 1).rejectionReason).toBe("placement_not_available");
        expect(engine.apply({ type: "unplace_barrel", team: LEFT, barrelIndex: 0 }).rejectionReason).toBe(
            "placement_not_available",
        );
    });
    it("restores barrel ownership and blocked terrain after an AI rollout destroys a barrel", () => {
        const { grid, fp, unitsHolder, engine } = fixture();
        place(engine, 0);
        const snapshot = snapshotBattle(unitsHolder, grid, fp);
        const checkpoint = new BattleRollbackJournal(unitsHolder, grid, fp).checkpoint();
        grid.clearScatteredMountainAt(3, 3);
        expect(grid.getArtifactBarrels()).toEqual([]);
        checkpoint.rollback();
        expect(grid.getArtifactBarrels()).toEqual([{ team: LEFT, index: 0, cell: { x: 3, y: 3 } }]);
        expect(grid.getOccupantUnitId({ x: 3, y: 3 })).toBe("B");
        engine.apply({ type: "unplace_barrel", team: LEFT, barrelIndex: 0 });
        restoreBattle(snapshot, unitsHolder, grid, fp);
        expect(grid.getOccupantUnitId({ x: 3, y: 3 })).toBe("B");
    });
    it("removes ownership when narrowing swallows a barrel, without reviving the hole on hydration", () => {
        const { grid, engine } = fixture();
        place(engine, 0);
        expect(grid.occupyByHole({ x: 3, y: 3 })).toBe(true);
        expect(grid.getArtifactBarrels()).toEqual([]);
        grid.setScatteredMountains([]);
        expect(grid.getOccupantUnitId({ x: 3, y: 3 })).toBe("H");
    });
    for (const gridType of [
        PBTypes.GridVals.NORMAL,
        PBTypes.GridVals.WATER_CENTER,
        PBTypes.GridVals.LAVA_CENTER,
        PBTypes.GridVals.BLOCK_CENTER,
    ]) {
        it(`destroys a deployed barrel with an ordinary shot on map ${gridType}`, () => {
            const { grid, fp, engine, attacker } = fixture(gridType, true);
            expect(place(engine, 0, 1, 3).completed).toBe(true);
            fp.setTeamUnitsAlive(LEFT, 1);
            fp.setTeamUnitsAlive(RIGHT, 1);
            fp.startFight();
            fp.startTurn(LEFT, 1000);
            const settings = grid.getSettings();
            const result = engine.apply({
                type: "obstacle_attack",
                attackerId: attacker.getId(),
                targetPosition: getPositionForCell(
                    { x: 1, y: 3 },
                    settings.getMinX(),
                    settings.getStep(),
                    settings.getHalfStep(),
                ),
            });
            expect(result.completed).toBe(true);
            expect(grid.getOccupantUnitId({ x: 1, y: 3 })).toBe("");
            expect(attacker.getRangeShots()).toBe(3);
            if (gridType === PBTypes.GridVals.WATER_CENTER) expect(grid.getOccupantUnitId({ x: 7, y: 7 })).toBe("W");
            if (gridType === PBTypes.GridVals.LAVA_CENTER) expect(grid.getOccupantUnitId({ x: 7, y: 7 })).toBe("L");
        });
    }
    it("preserves classic mountain cells when a legacy board also has a deployed barrel", () => {
        const { grid, fp, engine } = fixture();
        grid.refreshWithNewType(PBTypes.GridVals.BLOCK_CENTER);
        fp.setGridType(PBTypes.GridVals.BLOCK_CENTER);
        const original = grid.getCenterCells();
        expect(original).toHaveLength(8);
        place(engine, 0);
        expect(grid.getCenterCells()).toHaveLength(9);
        expect(grid.hasClassicMountains()).toBe(true);
        for (const cell of original) expect(grid.getOccupantUnitId(cell)).toBe("B");
    });

    for (const gridType of [
        PBTypes.GridVals.NORMAL,
        PBTypes.GridVals.WATER_CENTER,
        PBTypes.GridVals.LAVA_CENTER,
        PBTypes.GridVals.BLOCK_CENTER,
    ]) {
        it(`destroys a deployed barrel in one actual melee strike on map ${gridType}`, () => {
            const { grid, fp, engine, attacker } = fixture(gridType);
            place(engine, 0);
            const neutralBefore = grid.getScatteredMountainsStanding().length - 1;
            fp.setTeamUnitsAlive(LEFT, 1);
            fp.setTeamUnitsAlive(RIGHT, 1);
            fp.startFight();
            fp.startTurn(LEFT, 1000);
            const settings = grid.getSettings();
            const result = engine.apply({
                type: "obstacle_attack",
                attackerId: attacker.getId(),
                attackFrom: { x: 4, y: 3 },
                targetPosition: getPositionForCell(
                    { x: 3, y: 3 },
                    settings.getMinX(),
                    settings.getStep(),
                    settings.getHalfStep(),
                ),
            });
            expect(result.completed).toBe(true);
            expect(grid.getOccupantUnitId({ x: 3, y: 3 })).toBe("");
            expect(grid.getArtifactBarrels()).toEqual([]);
            expect(grid.getScatteredMountainsStanding()).toHaveLength(neutralBefore);
            grid.setScatteredMountains(grid.getScatteredMountainsStanding());
            expect(grid.getOccupantUnitId({ x: 3, y: 3 })).toBe("");
            expect(result.events.some((event) => event.type === "obstacle_attacked")).toBe(true);
        });
    }
});

describe("Amulet of Resolve", () => {
    it("gives the whole army 25% status and 25% mind resistance through a single marker, with no magic boost", () => {
        const { grid, unitsHolder, fp } = fixture();
        fp.setArtifactPerTeam(LEFT, ArtifactTier.TIER_1, Tier1Artifact.AMULET_OF_RESOLVE);
        const summoned = createTestUnit({ team: LEFT, name: "Summoned", magicResist: 10, summoned: true });
        placeUnit(grid, unitsHolder, summoned, { x: 1, y: 1 });
        for (let i = 0; i < 3; i++) unitsHolder.applyArtifacts(fp);
        for (const ally of unitsHolder.getAllAllies(LEFT)) {
            expect(ally.getStatusResist()).toBe(25);
            expect(ally.getMindResist()).toBe(25);
            expect(ally.getAllProperties().applied_buffs.filter((name) => name === "Amulet of Resolve")).toHaveLength(
                1,
            );
        }
        expect(summoned.getMagicResist()).toBe(10);
        expect(unitsHolder.getAllAllies(RIGHT)[0].getMindResist()).toBe(0);
        fp.setArtifactPerTeam(LEFT, ArtifactTier.TIER_1, Tier1Artifact.BARREL_BARRICADE);
        unitsHolder.applyArtifacts(fp);
        expect(summoned.getStatusResist()).toBe(0);
        expect(summoned.getMindResist()).toBe(0);
    });
});
