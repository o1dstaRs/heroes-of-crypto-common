import { describe, expect, it } from "bun:test";

import { GameActionEngine } from "../../src/engine/action_engine";
import { createSequenceGameRuntime } from "../../src/engine/runtime";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getPositionForCell } from "../../src/grid/grid_math";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Grid } from "../../src/grid/grid";
import { UnitsHolder } from "../../src/units/units_holder";
import { Unit } from "../../src/units/unit";
import { createCombatTestContext, createTestUnit, testGridSettings } from "../helpers/combat";

function placeLargeUnit(
    grid: Grid,
    unitsHolder: UnitsHolder,
    unit: Unit,
    centerVertex: { x: number; y: number },
): void {
    unit.setPosition(centerVertex.x, centerVertex.y);
    grid.occupyCells(unit.getCells(), unit.getId(), unit.getTeam(), unit.getAttackRange(), false, false);
    unitsHolder.addUnit(unit);
}

function placeSmall(grid: Grid, unitsHolder: UnitsHolder, unit: Unit, cell: { x: number; y: number }): void {
    const pos = getPositionForCell(
        cell,
        testGridSettings.getMinX(),
        testGridSettings.getStep(),
        testGridSettings.getHalfStep(),
    );
    unit.setPosition(pos.x, pos.y);
    grid.occupyCell(cell, unit.getId(), unit.getTeam(), unit.getAttackRange(), false, false);
    unitsHolder.addUnit(unit);
}

describe("Through Shot from a large (2x2) attacker", () => {
    it("lands and damages every enemy on the trajectory", () => {
        const context = createCombatTestContext(PBTypes.GridVals.NORMAL);
        const { grid, unitsHolder } = context;
        const fightProperties = FightStateManager.getInstance().getFightProperties();
        fightProperties.setGridType(PBTypes.GridVals.NORMAL);
        fightProperties.startFight();

        const step = testGridSettings.getStep();
        const minX = testGridSettings.getMinX();

        // Large 2x2 Through Shot attacker; footprint cols {7,8} rows {1,2}, center vertex (0, 256).
        const attacker = createTestUnit({
            name: "Tsar Cannon",
            team: PBTypes.TeamVals.LOWER,
            attackType: PBTypes.AttackVals.RANGE,
            attack: 40,
            damageMin: 30,
            damageMax: 30,
            rangeShots: 4,
            shotDistance: 16,
            size: PBTypes.UnitSizeVals.LARGE,
            abilities: ["Through Shot", "No Melee"],
            speed: 5,
            morale: 4,
        });
        placeLargeUnit(grid, unitsHolder, attacker, { x: minX + 8 * step, y: 2 * step });
        attacker.refreshPossibleAttackTypes(true);

        // 4 small enemies stacked above the attacker (column 8, rows 6..9) along the shot line.
        const enemyCells = [
            { x: 8, y: 6 },
            { x: 8, y: 7 },
            { x: 8, y: 8 },
            { x: 8, y: 9 },
        ];
        const enemies = enemyCells.map((cell, i) => {
            const e = createTestUnit({
                name: `Enemy${i}`,
                team: PBTypes.TeamVals.UPPER,
                maxHp: 200,
                amountAlive: 10,
                armor: 0,
            });
            placeSmall(grid, unitsHolder, e, cell);
            return e;
        });

        fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LOWER, 1);
        fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.UPPER, enemies.length);
        fightProperties.startTurn(PBTypes.TeamVals.LOWER, 1000);

        const sceneLog = new SceneLogMock();
        const moveHandler = new MoveHandler(grid.getSettings(), grid, unitsHolder);
        const engine = new GameActionEngine({
            fightProperties,
            grid,
            unitsHolder,
            moveHandler,
            sceneLog,
            attackHandler: context.attackHandler,
            getCurrentActiveUnitId: () => attacker.getId(),
            runtime: createSequenceGameRuntime({ nowMillis: [1400] }),
        });

        const hpBefore = enemies.map((e) => e.getCumulativeHp());
        const result = engine.apply({
            type: "range_attack",
            attackerId: attacker.getId(),
            targetId: enemies[0].getId(),
            aimCell: enemyCells[0],
        });

        expect(result.completed).toBe(true);
        const hitCount = enemies.filter((e, i) => e.getCumulativeHp() < hpBefore[i]).length;
        expect(hitCount).toBe(enemies.length);
    });
});
