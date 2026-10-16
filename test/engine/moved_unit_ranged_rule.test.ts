/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import { GameActionEngine, MOVED_THIS_TURN_MELEE_ONLY_MESSAGE } from "../../src/engine/action_engine";
import { canWaitOnHourglass } from "../../src/engine/hourglass";
import { createSequenceGameRuntime } from "../../src/engine/runtime";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getPositionForCell } from "../../src/grid/grid_math";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import type { Unit } from "../../src/units/unit";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;

interface ISetup {
    attackType: number;
    ours: XY;
    theirs: XY;
    abilities?: string[];
    spells?: string[];
    gridType?: number;
    /** An ally that has not acted yet, which keeps the hourglass open. */
    teammate?: XY;
}

/** Our active unit and one enemy (plus an optional unacted ally), fight started, our unit's turn. */
const setup = (options: ISetup) => {
    const gridType = options.gridType ?? PBTypes.GridVals.NORMAL;
    const { grid, unitsHolder, attackHandler } = createCombatTestContext(gridType);
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(gridType);
    fightProperties.startFight();
    const shoots = options.attackType === PBTypes.AttackVals.RANGE;
    const actor = createTestUnit({
        name: shoots ? "Archer" : options.attackType === PBTypes.AttackVals.MAGIC ? "Mage" : "Footman",
        team: LEFT,
        attackType: options.attackType,
        attack: 40,
        damageMin: 30,
        damageMax: 30,
        rangeShots: shoots ? 3 : 0,
        shotDistance: 16,
        initiative: 5,
        steps: 4,
        abilities: options.abilities,
        spells: options.spells,
    });
    placeUnit(grid, unitsHolder, actor, options.ours);
    actor.refreshPossibleAttackTypes(true);
    const enemy = createTestUnit({ name: "Target", team: RIGHT, maxHp: 400, amountAlive: 20, armor: 0 });
    placeUnit(grid, unitsHolder, enemy, options.theirs);
    if (options.teammate) {
        placeUnit(grid, unitsHolder, createTestUnit({ name: "Ally", team: LEFT, initiative: 2 }), options.teammate);
    }
    fightProperties.setTeamUnitsAlive(LEFT, options.teammate ? 2 : 1);
    fightProperties.setTeamUnitsAlive(RIGHT, 1);
    fightProperties.startTurn(LEFT, 1000);
    const engine = new GameActionEngine({
        fightProperties,
        grid,
        unitsHolder,
        moveHandler: new MoveHandler(grid.getSettings(), grid, unitsHolder),
        sceneLog: new SceneLogMock(),
        attackHandler,
        getCurrentActiveUnitId: () => actor.getId(),
        runtime: createSequenceGameRuntime({ nowMillis: [1400] }),
    });
    const step = (to: XY) => {
        expect(engine.apply({ type: "move_unit", unitId: actor.getId(), path: [to] }).completed).toBe(true);
        expect(actor.hasMovedThisTurn()).toBe(true);
    };
    return { engine, actor, enemy, grid, unitsHolder, fightProperties, step };
};

const hp = (unit: Unit): number => unit.getCumulativeHp();

describe("only melee may follow a move in the same turn", () => {
    it("lets a ranged unit shoot when it has not moved", () => {
        const { engine, actor, enemy } = setup({
            attackType: PBTypes.AttackVals.RANGE,
            ours: { x: 3, y: 3 },
            theirs: { x: 3, y: 12 },
        });
        const before = hp(enemy);
        const shot = engine.apply({ type: "range_attack", attackerId: actor.getId(), targetId: enemy.getId() });
        expect(shot.completed).toBe(true);
        expect(hp(enemy)).toBeLessThan(before);
    });

    it("rejects a shot from a ranged unit that moved this turn and leaves the target untouched", () => {
        const { engine, actor, enemy, step } = setup({
            attackType: PBTypes.AttackVals.RANGE,
            ours: { x: 3, y: 3 },
            theirs: { x: 3, y: 12 },
        });
        step({ x: 3, y: 4 });
        const before = hp(enemy);
        const shots = actor.getRangeShots();
        const shot = engine.apply({ type: "range_attack", attackerId: actor.getId(), targetId: enemy.getId() });
        expect(shot.completed).toBe(false);
        expect(shot.rejectionReason).toBe("attack_not_available");
        expect(shot.message).toBe(MOVED_THIS_TURN_MELEE_ONLY_MESSAGE);
        expect(hp(enemy)).toBe(before);
        expect(actor.getRangeShots()).toBe(shots);
        // The move stands and the turn can still be closed normally; the unit's next turn starts unmoved.
        expect(engine.apply({ type: "end_turn", unitId: actor.getId() }).completed).toBe(true);
        expect(actor.hasMovedThisTurn()).toBe(false);
    });

    it("still lets a melee unit strike after walking up in the same turn", () => {
        const { engine, actor, enemy, step } = setup({
            attackType: PBTypes.AttackVals.MELEE,
            ours: { x: 3, y: 3 },
            theirs: { x: 3, y: 6 },
        });
        step({ x: 3, y: 4 });
        const before = hp(enemy);
        const strike = engine.apply({
            type: "melee_attack",
            attackerId: actor.getId(),
            targetId: enemy.getId(),
            attackFrom: { x: 3, y: 5 },
            path: [{ x: 3, y: 5 }],
        });
        expect(strike.completed).toBe(true);
        expect(hp(enemy)).toBeLessThan(before);
    });

    it("rejects an Area Throw after a move; the same throw lands from where the thrower stood", () => {
        const throwAt = (moveFirst: boolean) => {
            const { engine, actor, enemy, step } = setup({
                attackType: PBTypes.AttackVals.RANGE,
                abilities: ["Area Throw"],
                ours: { x: 3, y: 3 },
                theirs: { x: 3, y: 12 },
            });
            if (moveFirst) step({ x: 3, y: 4 });
            const before = hp(enemy);
            const result = engine.apply({
                type: "area_throw_attack",
                attackerId: actor.getId(),
                // An empty cell beside the target: the throw lands on free ground and its 3x3 blast catches the stack.
                targetCell: { x: 3, y: 11 },
            });
            return { result, damage: before - hp(enemy) };
        };
        const stationary = throwAt(false);
        expect(stationary.result.completed).toBe(true);
        expect(stationary.damage).toBeGreaterThan(0);
        const moved = throwAt(true);
        expect(moved.result.completed).toBe(false);
        expect(moved.result.rejectionReason).toBe("attack_not_available");
        expect(moved.result.message).toBe(MOVED_THIS_TURN_MELEE_ONLY_MESSAGE);
        expect(moved.damage).toBe(0);
    });

    it("rejects a mage's spell after a move; the same cast lands from where the mage stood", () => {
        const castAt = (moveFirst: boolean) => {
            const { engine, actor, enemy, step } = setup({
                attackType: PBTypes.AttackVals.MAGIC,
                spells: ["Life:Fire Strike"],
                ours: { x: 3, y: 3 },
                theirs: { x: 3, y: 9 },
            });
            if (moveFirst) step({ x: 3, y: 4 });
            const before = hp(enemy);
            const result = engine.apply({
                type: "cast_spell",
                casterId: actor.getId(),
                spellName: "Fire Strike",
                targetId: enemy.getId(),
                targetCell: enemy.getBaseCell(),
            });
            return { result, damage: before - hp(enemy) };
        };
        const stationary = castAt(false);
        expect(stationary.result.completed).toBe(true);
        expect(stationary.damage).toBeGreaterThan(0);
        const moved = castAt(true);
        expect(moved.result.completed).toBe(false);
        expect(moved.result.rejectionReason).toBe("spell_not_available");
        expect(moved.result.message).toBe(MOVED_THIS_TURN_MELEE_ONLY_MESSAGE);
        expect(moved.damage).toBe(0);
    });

    it("rejects a ranged hit on a stone after a move and leaves the stone standing", () => {
        const shootStone = (moveFirst: boolean) => {
            const { engine, actor, grid, step } = setup({
                attackType: PBTypes.AttackVals.RANGE,
                gridType: PBTypes.GridVals.BLOCK_CENTER,
                ours: { x: 3, y: 3 },
                theirs: { x: 12, y: 12 },
            });
            const stone = moveFirst ? { x: 7, y: 4 } : { x: 7, y: 3 };
            grid.setScatteredMountains([stone]);
            actor.refreshPossibleAttackTypes(true);
            if (moveFirst) step({ x: 3, y: 4 });
            const settings = grid.getSettings();
            const result = engine.apply({
                type: "obstacle_attack",
                attackerId: actor.getId(),
                targetPosition: getPositionForCell(
                    stone,
                    settings.getMinX(),
                    settings.getStep(),
                    settings.getHalfStep(),
                ),
            });
            return { result, standing: grid.getScatteredMountainsStanding() };
        };
        const stationary = shootStone(false);
        expect(stationary.result.completed).toBe(true);
        expect(stationary.standing).toEqual([]);
        const moved = shootStone(true);
        expect(moved.result.completed).toBe(false);
        expect(moved.result.rejectionReason).toBe("attack_not_available");
        expect(moved.result.message).toBe(MOVED_THIS_TURN_MELEE_ONLY_MESSAGE);
        expect(moved.standing).toEqual([{ x: 7, y: 4 }]);
    });

    it("rejects waiting on the hourglass after a move, so a moved unit can't take a second turn later in the lap", () => {
        const waitAfter = (moveFirst: boolean) => {
            const { engine, actor, unitsHolder, fightProperties, step } = setup({
                attackType: PBTypes.AttackVals.RANGE,
                ours: { x: 3, y: 3 },
                theirs: { x: 3, y: 12 },
                teammate: { x: 6, y: 3 },
            });
            if (moveFirst) step({ x: 3, y: 4 });
            const open = canWaitOnHourglass(actor, fightProperties, unitsHolder.getAllUnits());
            return { open, result: engine.apply({ type: "wait_turn", unitId: actor.getId() }) };
        };
        const stationary = waitAfter(false);
        expect(stationary.open).toBe(true);
        expect(stationary.result.completed).toBe(true);
        const moved = waitAfter(true);
        expect(moved.open).toBe(false);
        expect(moved.result.completed).toBe(false);
        expect(moved.result.rejectionReason).toBe("hourglass_not_available");
        expect(moved.result.message).toBe(MOVED_THIS_TURN_MELEE_ONLY_MESSAGE);
    });
});
