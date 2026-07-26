import { describe, expect, it } from "bun:test";

import { GameActionEngine } from "../../src/engine/action_engine";
import { createSequenceGameRuntime } from "../../src/engine/runtime";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { RangeAttackCellSide } from "../../src/grid/grid_math";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

/**
 * Dense Flesh (Abomination) makes a ranged volley aimed at it cost its ability power in arrows instead of
 * one. A SPLASH shooter routes its damage through the AOE tail, which used to decrement exactly once and
 * so exempted every splash shooter from the rule: Gargantuan's Double Shot into an Abomination spent 2
 * arrows (14 -> 12) where it owes 4 (14 -> 10) — two volleys at double cost.
 */
const setup = (attackerAbilities: string[], targetAbilities: string[]) => {
    const { grid, unitsHolder, attackHandler } = createCombatTestContext();
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(PBTypes.GridVals.NORMAL);
    fightProperties.startFight();

    const attacker = createTestUnit({
        name: "Gargantuan",
        team: PBTypes.TeamVals.LOWER,
        attackType: PBTypes.AttackVals.RANGE,
        attack: 30,
        damageMin: 20,
        damageMax: 20,
        rangeShots: 14,
        shotDistance: 20,
        speed: 5,
        morale: 4,
        abilities: attackerAbilities,
    });
    placeUnit(grid, unitsHolder, attacker, { x: 2, y: 5 });
    attacker.refreshPossibleAttackTypes(true);

    const target = createTestUnit({
        name: "Abomination",
        team: PBTypes.TeamVals.UPPER,
        maxHp: 8000,
        amountAlive: 20,
        armor: 0,
        abilities: targetAbilities,
    });
    placeUnit(grid, unitsHolder, target, { x: 6, y: 5 });

    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LOWER, 1);
    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.UPPER, 1);
    fightProperties.startTurn(PBTypes.TeamVals.LOWER, 1000);

    const engine = new GameActionEngine({
        fightProperties,
        grid,
        unitsHolder,
        moveHandler: new MoveHandler(grid.getSettings(), grid, unitsHolder),
        sceneLog: new SceneLogMock(),
        attackHandler,
        getCurrentActiveUnitId: () => attacker.getId(),
        runtime: createSequenceGameRuntime({ nowMillis: [1400] }),
    });

    const fire = () =>
        engine.apply({
            type: "range_attack",
            attackerId: attacker.getId(),
            targetId: target.getId(),
            aimCell: { x: 6, y: 5 },
            aimSide: RangeAttackCellSide.LEFT,
        });

    return { attacker, target, fire };
};

describe("Dense Flesh shot cost", () => {
    it("charges a splash Double Shot two arrows per volley against Dense Flesh", () => {
        const { attacker, fire } = setup(["Double Shot", "Area Throw"], ["Dense Flesh"]);
        const before = attacker.getRangeShots();
        expect(fire().completed).toBe(true);
        // Two volleys x Dense Flesh's cost of 2 = 4 arrows, not the 2 the AOE tail used to spend.
        expect(before - attacker.getRangeShots()).toBe(4);
    });

    it("charges a splash Double Shot one arrow per volley against an ordinary target", () => {
        const { attacker, fire } = setup(["Double Shot", "Area Throw"], []);
        const before = attacker.getRangeShots();
        expect(fire().completed).toBe(true);
        expect(before - attacker.getRangeShots()).toBe(2);
    });

    it("still charges a single-target shooter Dense Flesh's cost", () => {
        const { attacker, fire } = setup([], ["Dense Flesh"]);
        const before = attacker.getRangeShots();
        expect(fire().completed).toBe(true);
        expect(before - attacker.getRangeShots()).toBe(2);
    });
});
