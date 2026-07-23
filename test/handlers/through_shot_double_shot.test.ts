import { afterEach, describe, expect, it } from "bun:test";

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
import { setDeterministicRandomSource } from "../../src/utils/lib";
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

// Fire one Through-Shot range attack down a lane of 4 enemies and return the total cumulative HP removed.
// The enemies are given enormous HP so they survive BOTH volleys — a unit killed by the first volley would
// be skipped by the second, hiding whether the second volley fired at all.
function runThroughShotScenario(abilities: string[]): number {
    const context = createCombatTestContext(PBTypes.GridVals.NORMAL);
    const { grid, unitsHolder } = context;
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(PBTypes.GridVals.NORMAL);
    fightProperties.startFight();

    const step = testGridSettings.getStep();
    const minX = testGridSettings.getMinX();

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
        abilities,
        speed: 5,
        morale: 4,
    });
    placeLargeUnit(grid, unitsHolder, attacker, { x: minX + 8 * step, y: 2 * step });
    attacker.refreshPossibleAttackTypes(true);

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
            maxHp: 100000,
            amountAlive: 1,
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
        // A double volley draws the clock more than once; hand it a generous sequence.
        runtime: createSequenceGameRuntime({ nowMillis: Array.from({ length: 32 }, (_, i) => 1400 + i) }),
    });

    const hpBefore = enemies.reduce((sum, e) => sum + e.getCumulativeHp(), 0);
    const result = engine.apply({
        type: "range_attack",
        attackerId: attacker.getId(),
        targetId: enemies[0].getId(),
        aimCell: enemyCells[0],
    });
    expect(result.completed).toBe(true);
    const hpAfter = enemies.reduce((sum, e) => sum + e.getCumulativeHp(), 0);
    return hpBefore - hpAfter;
}

describe("Double Shot fires a second volley for a Through-Shot attacker (Tsar Cannon)", () => {
    // Pin the RNG so miss/luck are deterministic across both scenario runs. Source 0 => getRandomInt returns
    // its min, so the miss roll `getRandomInt(0,100) < missChance(=0)` is always false => every volley lands.
    afterEach(() => setDeterministicRandomSource(undefined));

    it("deals strictly more damage than a lone Through Shot volley", () => {
        setDeterministicRandomSource(() => 0);
        const singleVolley = runThroughShotScenario(["Through Shot", "No Melee"]);
        const doubleVolley = runThroughShotScenario(["Through Shot", "No Melee", "Double Shot"]);

        // The lone Through Shot must actually deal damage, otherwise the comparison is meaningless.
        expect(singleVolley).toBeGreaterThan(0);
        // The Double Shot's second piercing volley adds damage on top — before the fix it returned early and
        // the second volley never fired, so this was equal to the single volley.
        expect(doubleVolley).toBeGreaterThan(singleVolley);
    });
});
