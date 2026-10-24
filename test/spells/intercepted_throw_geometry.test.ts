import { describe, expect, test } from "bun:test";
import { GameActionEngine } from "../../src/engine/action_engine";
import { createSequenceGameRuntime } from "../../src/engine/runtime";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getFootprintCellsForAnchor, isCellWithinGrid } from "../../src/grid/grid_math";
import { traceGridRayCells } from "../../src/grid/ray_traversal";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import {
    isTargetedSpellLineOfSightClear,
    resolveThrownSpellImpact,
    thrownSpellReachesAimedTarget,
} from "../../src/spells/spell_helper";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const barrels = [
    [6, 14],
    [7, 2],
    [8, 4],
    [7, 6],
    [8, 5],
    [8, 8],
    [6, 3],
    [8, 13],
    [7, 9],
    [8, 6],
    [6, 6],
    [7, 11],
].map(([x, y]) => ({ x, y }));
function rotate(cell: XY, turns: number): XY {
    for (let n = 0; n < turns; n++) cell = { x: 15 - cell.y, y: cell.x };
    return cell;
}
function fixture(spellName: string, turns = 0, production = true) {
    const c = createCombatTestContext(PBTypes.GridVals.BLOCK_CENTER);
    const team = turns % 2 ? PBTypes.TeamVals.LEFT : PBTypes.TeamVals.RIGHT;
    const caster = createTestUnit({
        name: "Battle Mage",
        team,
        spells: [`Chaos:${spellName}`],
        amountAlive: 56,
        stackPower: 5,
    });
    const target = createTestUnit({
        name: "Pegasus",
        team: team === 1 ? 2 : 1,
        maxHp: 10000,
        footprintWidth: production ? (turns % 2 ? 1 : 2) : 1,
        footprintHeight: production && turns % 2 ? 2 : 1,
    });
    c.grid.setScatteredMountains(production ? barrels.map((cell) => rotate(cell, turns)) : [{ x: 6, y: 3 }]);
    placeUnit(c.grid, c.unitsHolder, caster, production ? rotate({ x: 15, y: 0 }, turns) : { x: 3, y: 3 });
    const targetCells = getFootprintCellsForAnchor({ x: 6, y: 4 }, 2, 1).map((cell) => rotate(cell, turns));
    placeUnit(
        c.grid,
        c.unitsHolder,
        target,
        production
            ? {
                  x: Math.max(...targetCells.map((cell) => cell.x)),
                  y: Math.max(...targetCells.map((cell) => cell.y)),
              }
            : { x: 9, y: 3 },
    );
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(PBTypes.GridVals.BLOCK_CENTER);
    fightProperties.startFight();
    fightProperties.startTurn(team, 1000);
    const engine = new GameActionEngine({
        ...c,
        fightProperties,
        moveHandler: new MoveHandler(c.grid.getSettings(), c.grid, c.unitsHolder),
        sceneLog: new SceneLogMock(),
        getCurrentActiveUnitId: () => caster.getId(),
        runtime: createSequenceGameRuntime({ nowMillis: [1400] }),
    });
    const within = (cell: XY) => isCellWithinGrid(c.grid.getSettings(), cell);
    const transparent = (id: string) => c.unitsHolder.getAllUnits().get(id)?.getTeam() === team;
    return { ...c, caster, target, engine, within, transparent };
}

describe("intercepted fire spell geometry", () => {
    for (const spellName of ["Fire Strike", "Fireball"]) {
        for (let turns = 0; turns < 4; turns++) {
            test(`${spellName}, rotation ${turns}: production Pegasus cast records a clear flight instead of the barrel-crossing nearest edge`, () => {
                const f = fixture(spellName, turns);
                const impact = resolveThrownSpellImpact(
                    spellName,
                    f.grid,
                    f.within,
                    f.caster.getBaseCell(),
                    f.target.getBaseCell(),
                    f.transparent,
                );
                expect(impact.blockedByTerrain).toBe(false);
                expect(impact.interceptedBy).toBeUndefined();
                expect(impact.fromPosition).toEqual(f.caster.getPosition());
                expect(impact.toPosition).toBeDefined();
                const ray = traceGridRayCells(f.grid.getSettings(), impact.fromPosition!, impact.toPosition!);
                expect(ray.some(([cell]) => f.grid.getOccupantUnitId(cell) === "B")).toBe(false);
                expect(
                    isTargetedSpellLineOfSightClear(
                        spellName,
                        f.grid,
                        f.within,
                        f.caster.getBaseCell(),
                        f.target.getBaseCell(),
                        f.transparent,
                        f.target.getCells(),
                    ),
                ).toBe(true);
                expect(
                    thrownSpellReachesAimedTarget(
                        spellName,
                        f.grid,
                        f.within,
                        f.caster.getBaseCell(),
                        f.target.getBaseCell(),
                        f.transparent,
                        f.target.getCells(),
                    ),
                ).toBe(true);
                const before = f.target.getCumulativeHp();
                const result = f.engine.apply({
                    type: "cast_spell",
                    casterId: f.caster.getId(),
                    spellName,
                    targetId: f.target.getId(),
                    targetCell: f.target.getBaseCell(),
                });
                expect(result.completed).toBe(true);
                expect(f.target.getCumulativeHp()).toBeLessThan(before);
                const event = result.events.find((event) => event.type === "spell_cast");
                expect(event?.type === "spell_cast" && event.animations[0]).toEqual({
                    fromPosition: impact.fromPosition,
                    toPosition: impact.toPosition,
                    affectedUnitId: f.target.getId(),
                });
            });
        }
        test(`${spellName}: blocked casts spend no charge, deal no damage, and cannot make terrain transparent`, () => {
            const f = fixture(spellName, 0, false);
            const before = f.target.getCumulativeHp();
            const spells = f.caster.getUnitProperties().spells.slice();
            expect(
                resolveThrownSpellImpact(
                    spellName,
                    f.grid,
                    f.within,
                    f.caster.getBaseCell(),
                    f.target.getBaseCell(),
                    () => true,
                ).blockedByTerrain,
            ).toBe(true);
            const result = f.engine.apply({
                type: "cast_spell",
                casterId: f.caster.getId(),
                spellName,
                targetId: f.target.getId(),
                targetCell: f.target.getBaseCell(),
            });
            expect(result.completed).toBe(false);
            expect(f.target.getCumulativeHp()).toBe(before);
            expect(f.caster.getUnitProperties().spells).toEqual(spells);
            expect(f.grid.getScatteredMountainsStanding()).toEqual([{ x: 6, y: 3 }]);
        });
        test(`${spellName}: a friendly screen is transparent and an enemy screen still intercepts`, () => {
            for (const friendly of [false, true]) {
                const f = fixture(spellName, 0, false);
                f.grid.clearScatteredMountainAt(6, 3);
                const screen = createTestUnit({ team: friendly ? f.caster.getTeam() : f.target.getTeam() });
                placeUnit(f.grid, f.unitsHolder, screen, { x: 6, y: 3 });
                const impact = resolveThrownSpellImpact(
                    spellName,
                    f.grid,
                    f.within,
                    f.caster.getBaseCell(),
                    f.target.getBaseCell(),
                    f.transparent,
                );
                expect(impact.interceptedBy).toBe(friendly ? undefined : screen.getId());
                expect(impact.blockedByTerrain).toBe(false);
            }
        });
    }
});
