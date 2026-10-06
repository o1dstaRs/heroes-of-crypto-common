import { afterEach, describe, expect, it } from "bun:test";

import { processBlindnessAbility } from "../../src/abilities/blindness_ability";
import { processStunAbility } from "../../src/abilities/stun_ability";
import {
    ArtifactTier,
    Tier1Artifact,
    TIER1_ARTIFACT_LIST,
    formatArtifactDescription,
} from "../../src/artifacts/artifact_properties";
import { GameActionEngine } from "../../src/engine/action_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { DefaultPlacementLevel1 } from "../../src/augments/augment_properties";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { autoPlaceArtifactBarrels, reconcileArtifactBarrels } from "../../src/grid/artifact_barrels";
import { getPositionForCell } from "../../src/grid/grid_math";
import { scatteredMountainsForSeed } from "../../src/grid/scattered_mountains";
import { MoveHandler } from "../../src/handlers/move_handler";
import { BattleRollbackJournal, snapshotBattle, restoreBattle } from "../../src/simulation/battle_snapshot";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { getRandomInt, setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;
const fixture = (gridType = PBTypes.GridVals.NORMAL, ranged = false) => {
    const context = createCombatTestContext(gridType);
    const fp = FightStateManager.getInstance().getFightProperties();
    fp.setGridType(gridType);
    fp.setDefaultPlacementPerTeam(LEFT, DefaultPlacementLevel1.THREE_BY_THREE);
    fp.setDefaultPlacementPerTeam(RIGHT, DefaultPlacementLevel1.THREE_BY_THREE);
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
        expect(formatArtifactDescription(amulet)).toBe("Grants your army +25% status and mind resistance.");
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
    it("keeps the screen off a friendly ranged file and still takes the inward edge", () => {
        const { grid, fp } = fixture();
        fp.setSideOrientedPlacement(true);
        autoPlaceArtifactBarrels(
            grid,
            fp,
            LEFT,
            [
                { x: 4, y: 3 },
                { x: 3, y: 3 },
                { x: 4, y: 1 },
                { x: 4, y: 2 },
                { x: 2, y: 5 },
            ],
            [{ x: 2, y: 3 }],
        );
        expect(grid.getArtifactBarrels(LEFT).map((barrel) => barrel.cell)).toEqual([
            { x: 4, y: 2 },
            { x: 4, y: 1 },
        ]);
    });
    it("screens the shooter instead of the far end of the deployment edge", () => {
        const { grid, fp } = fixture();
        fp.setSideOrientedPlacement(true);
        const front = [6, 7, 8, 9, 1].map((y) => ({ x: 4, y }));
        autoPlaceArtifactBarrels(grid, fp, LEFT, [...front, { x: 4, y: 8 }, { x: 3, y: 8 }], [{ x: 2, y: 8 }]);
        expect(grid.getArtifactBarrels(LEFT).map((barrel) => barrel.cell)).toEqual([
            { x: 4, y: 7 },
            { x: 4, y: 6 },
        ]);
    });
    it("chooses an adjacent free pair instead of an isolated first cell, without overwriting units", () => {
        const { grid, fp, attacker } = fixture();
        autoPlaceArtifactBarrels(grid, fp, LEFT, [
            { x: 1, y: 5 },
            { x: 4, y: 3 },
            { x: 2, y: 2 },
            { x: 3, y: 2 },
        ]);
        const barrels = grid.getArtifactBarrels(LEFT);
        expect(barrels.map((barrel) => barrel.cell)).toEqual([
            { x: 2, y: 2 },
            { x: 3, y: 2 },
        ]);
        expect(grid.getOccupantUnitId({ x: 4, y: 3 })).toBe(attacker.getId());
        autoPlaceArtifactBarrels(grid, fp, LEFT);
        expect(grid.getArtifactBarrels(LEFT)).toEqual(barrels);
    });
    it("fills the missing slot next to a manually moved barrel and preserves a separated manual pair", () => {
        const { grid, fp, engine } = fixture();
        place(engine, 0, 2, 2);
        autoPlaceArtifactBarrels(grid, fp, LEFT, [
            { x: 1, y: 5 },
            { x: 3, y: 2 },
        ]);
        expect(grid.getArtifactBarrels(LEFT)[1].cell).toEqual({ x: 3, y: 2 });
        expect(place(engine, 1, 1, 5).completed).toBe(true);
        const chosen = grid.getArtifactBarrels(LEFT);
        autoPlaceArtifactBarrels(grid, fp, LEFT);
        expect(grid.getArtifactBarrels(LEFT)).toEqual(chosen);
    });
    it("falls back to available cells on a crowded board and never re-creates destroyed barrels in combat", () => {
        const { grid, fp } = fixture();
        autoPlaceArtifactBarrels(grid, fp, LEFT, [
            { x: 1, y: 1 },
            { x: 3, y: 5 },
        ]);
        expect(grid.getArtifactBarrels(LEFT)).toHaveLength(2);
        fp.startFight();
        grid.clearScatteredMountainAt(1, 1);
        autoPlaceArtifactBarrels(grid, fp, LEFT);
        expect(grid.getArtifactBarrels(LEFT)).toHaveLength(1);
    });
    it("rejects placing a unit onto a reserved barrel and keeps both original occupants intact", () => {
        const { grid, engine, attacker } = fixture();
        place(engine, 0);
        const result = engine.apply({
            type: "place_unit",
            unitId: attacker.getId(),
            team: LEFT,
            unitName: attacker.getName(),
            cells: [{ x: 3, y: 3 }],
        });
        expect(result.rejectionReason).toBe("placement_blocked");
        expect(grid.getOccupantUnitId({ x: 3, y: 3 })).toBe("B");
        expect(grid.getOccupantUnitId({ x: 4, y: 3 })).toBe(attacker.getId());
        expect(grid.getArtifactBarrels(LEFT)).toEqual([{ team: LEFT, index: 0, cell: { x: 3, y: 3 } }]);
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
    afterEach(() => setDeterministicRandomSource(undefined));

    for (const snapshotPower of [0, 25]) {
        it(`keeps both resistances in snapshot state with display power ${snapshotPower}`, () => {
            const { unitsHolder, fp, attacker: unit } = fixture();
            fp.setArtifactPerTeam(LEFT, ArtifactTier.TIER_1, Tier1Artifact.AMULET_OF_RESOLVE);
            unitsHolder.applyArtifacts(fp);
            const properties = unit.getUnitProperties();
            unit.getBuffs().splice(0);
            properties.applied_buffs_powers[0] = snapshotPower;
            expect(unit.getBuff("Amulet of Resolve")).toBeUndefined();
            expect(unit.getStatusResist()).toBe(25);
            expect(unit.getMindResist()).toBe(25);
            expect(unit.getPhysicalAoeDamageMultiplier()).toBe(0.75);

            properties.applied_buffs_laps[0] = 0;
            expect(unit.getStatusResist()).toBe(0);
            expect(unit.getMindResist()).toBe(0);
            expect(unit.getPhysicalAoeDamageMultiplier()).toBe(1);
        });
    }

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
        const snapshot = snapshotBattle(unitsHolder, grid, fp);
        fp.setArtifactPerTeam(LEFT, ArtifactTier.TIER_1, Tier1Artifact.BARREL_BARRICADE);
        unitsHolder.applyArtifacts(fp);
        expect(summoned.getStatusResist()).toBe(0);
        expect(summoned.getMindResist()).toBe(0);
        restoreBattle(snapshot, unitsHolder, grid, fp);
        for (const ally of unitsHolder.getAllAllies(LEFT)) {
            expect(ally.getStatusResist()).toBe(25);
            expect(ally.getMindResist()).toBe(25);
        }
    });

    for (const { effect, roll, lands, process } of [
        { effect: "Stun", roll: 26, lands: true, process: processStunAbility },
        { effect: "Stun", roll: 27, lands: false, process: processStunAbility },
        { effect: "Blindness", roll: 18, lands: true, process: processBlindnessAbility },
        { effect: "Blindness", roll: 19, lands: false, process: processBlindnessAbility },
    ]) {
        it(`uses 25% resistance for ${effect} with a d100 roll of ${roll}`, () => {
            const { grid, unitsHolder, fp, attacker: target } = fixture();
            const source = createTestUnit({ team: RIGHT, abilities: [effect], stackPower: 5 });
            placeUnit(grid, unitsHolder, source, { x: 10, y: 10 });
            // Keep the 21 high bits zero and put the requested roll in the 32 low bits.
            setDeterministicRandomSource(() => roll / 2 ** 32);
            expect(getRandomInt(0, 100)).toBe(roll);
            const log = new SceneLogMock();
            process(source, target, source, log);
            expect(target.hasEffectActive(effect)).toBe(true);

            target.deleteEffect(effect);
            fp.setArtifactPerTeam(LEFT, ArtifactTier.TIER_1, Tier1Artifact.AMULET_OF_RESOLVE);
            unitsHolder.applyArtifacts(fp);
            process(source, target, source, log);
            expect(target.hasEffectActive(effect)).toBe(lands);
        });
    }
});
