import { afterEach, describe, expect, test } from "bun:test";

import { resolveChakramTrajectory } from "../../src/abilities/chakram_ability";
import type { IDecisionContext } from "../../src/ai/ai_strategy";
import { enumerateCandidates } from "../../src/ai/candidates";
import { GameActionEngine } from "../../src/engine/action_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { GridType } from "../../src/generated/protobuf/v1/types_gen";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { snapshotBattle } from "../../src/simulation/battle_snapshot";
import {
    chakramExposureAt,
    reserveChakramScreenMove,
    selectChakramScreenMove,
} from "../../src/simulation/chakram_screen_move_research";
import type { Unit } from "../../src/units/unit";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;
afterEach(() => setDeterministicRandomSource(undefined));

function fixture(width = 1, height = 1, gridType: GridType = PBTypes.GridVals.NORMAL, wingshield = false) {
    const combat = createCombatTestContext(gridType);
    const abilities =
        gridType === PBTypes.GridVals.LAVA_CENTER
            ? ["Made of Fire"]
            : gridType === PBTypes.GridVals.WATER_CENTER
              ? ["Made of Water"]
              : [];
    const fp = FightStateManager.getInstance().getFightProperties();
    const actor = createTestUnit({
        name: "Moving body",
        team: LEFT,
        maxHp: 1000,
        exp: 10,
        footprintWidth: width,
        footprintHeight: height,
        abilities,
    });
    const ally = createTestUnit({
        name: "Carry",
        team: LEFT,
        maxHp: 1000,
        exp: 30,
        abilities: wingshield ? ["Arrows Wingshield Blessing"] : [],
    });
    const wall = createTestUnit({ name: "Bridge blocker", team: LEFT, maxHp: 1000, exp: 5, abilities });
    const enemy = createTestUnit({
        name: "Chakram shooter",
        team: RIGHT,
        maxHp: 1000,
        abilities: ["Chakram"],
        attackType: PBTypes.AttackVals.RANGE,
        rangeShots: 20,
        stackPower: 5,
    });
    placeUnit(combat.grid, combat.unitsHolder, actor, width === 1 && height === 1 ? { x: 7, y: 8 } : { x: 8, y: 10 });
    placeUnit(combat.grid, combat.unitsHolder, ally, { x: 5, y: 8 });
    placeUnit(combat.grid, combat.unitsHolder, wall, { x: 6, y: 8 });
    placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 5, y: 2 });
    fp.startFight();
    fp.setTeamUnitsAlive(LEFT, 3);
    fp.setTeamUnitsAlive(RIGHT, 1);
    fp.startTurn(LEFT, 1000);
    const context: IDecisionContext = {
        ...combat,
        fightProperties: fp,
        decisionOrigin: "root",
        matrix: combat.grid.getMatrix(),
        pathHelper: new PathHelper(combat.grid.getSettings()),
    };
    const incumbent = [{ type: "defend_turn" as const, unitId: actor.getId() }];
    const moves = enumerateCandidates(actor, context, incumbent).candidates.filter(
        (candidate) => candidate.kind === "move",
    );
    const engine = new GameActionEngine({
        ...combat,
        fightProperties: fp,
        sceneLog: new SceneLogMock(),
        moveHandler: new MoveHandler(combat.grid.getSettings(), combat.grid, combat.unitsHolder),
        getCurrentActiveUnitId: () => actor.getId(),
        canLandRangeAttack: (unit: Unit) =>
            combat.attackHandler.canLandRangeAttack(unit, combat.grid.getEnemyAggrMatrixByUnitId(unit.getId())),
    });
    return { ...combat, fp, actor, ally, wall, enemy, context, incumbent, moves, engine };
}

function actualExposure(h: ReturnType<typeof fixture>) {
    const values = [h.actor, h.ally, h.wall].map((primary) => {
        const trajectory = resolveChakramTrajectory(h.enemy, primary, h.unitsHolder, h.grid);
        return trajectory.hitUnits.reduce(
            (sum, unit) =>
                sum +
                Math.max(1, unit.getExp() * unit.getAmountAlive()) * trajectory.damageFactorByUnitId[unit.getId()],
            0,
        );
    });
    return { maximum: Math.max(...values), total: values.reduce((a, b) => a + b, 0), flights: 3 };
}

describe("offline Chakram screen moves", () => {
    test("vacated lava and cleared terrain match the engine, including a Wingshield holder", () => {
        for (const map of [PBTypes.GridVals.LAVA_CENTER]) {
            for (const cleared of [false, true]) {
                const h = fixture(1, 1, map, true);
                if (cleared) h.grid.cleanupCenterObstacle();
                const moves = enumerateCandidates(
                    h.actor,
                    { ...h.context, matrix: h.grid.getMatrix() },
                    h.incumbent,
                ).candidates;
                const move = moves.find(
                    (candidate) =>
                        candidate.kind === "move" && candidate.targetCell?.x === 5 && candidate.targetCell.y === 7,
                );
                expect(move).toBeDefined();
                const action = move!.actions[0];
                if (action.type !== "move_unit") throw new Error("Expected move");
                const before = JSON.stringify(snapshotBattle(h.unitsHolder, h.grid, h.fp));
                const predicted = chakramExposureAt(h.actor, h.context, action.targetCells!);
                expect(JSON.stringify(snapshotBattle(h.unitsHolder, h.grid, h.fp))).toBe(before);
                expect(h.engine.apply(action).completed).toBe(true);
                expect(h.grid.getOccupantUnitId({ x: 7, y: 8 })).toBe(
                    cleared ? "" : map === PBTypes.GridVals.LAVA_CENTER ? "L" : "W",
                );
                expect(predicted).toEqual(actualExposure(h));
            }
        }
    });
    test("virtual movement matches actual engine movement for small, large and rectangular bodies", () => {
        for (const [width, height] of [
            [1, 1],
            [2, 1],
            [1, 2],
            [2, 2],
        ]) {
            for (const index of [0, 5, 10]) {
                const h = fixture(width, height);
                const move = h.moves[index];
                expect(move).toBeDefined();
                const action = move.actions[0];
                if (action.type !== "move_unit") throw new Error("Expected move");
                const before = JSON.stringify(snapshotBattle(h.unitsHolder, h.grid, h.fp));
                let draws = 0;
                setDeterministicRandomSource(() => {
                    draws += 1;
                    return 0.5;
                });
                const predicted = chakramExposureAt(h.actor, h.context, action.targetCells!);
                expect(draws).toBe(0);
                expect(JSON.stringify(snapshotBattle(h.unitsHolder, h.grid, h.fp))).toBe(before);
                expect(h.engine.apply(action).completed).toBe(true);
                expect(predicted).toEqual(actualExposure(h));
                setDeterministicRandomSource(undefined);
            }
        }
    });

    test("adds a safer option when ordinary movement opens a chain, without forcing that move", () => {
        const h = fixture();
        const unsafe = h.moves.find((candidate) => candidate.targetCell?.x === 8 && candidate.targetCell.y === 6)!;
        expect(unsafe).toBeDefined();
        expect(actualExposure(h).maximum).toBe(0);
        const before = JSON.stringify(snapshotBattle(h.unitsHolder, h.grid, h.fp));
        const result = selectChakramScreenMove(h.actor, h.context, h.moves, [unsafe], h.incumbent)!;
        expect(result).toBeDefined();
        expect(result.baseline.maximum).toBeGreaterThan(0);
        expect(result.selected.maximum).toBe(0);
        expect(result.candidate).not.toBe(unsafe);
        expect(JSON.stringify(snapshotBattle(h.unitsHolder, h.grid, h.fp))).toBe(before);
        expect(h.engine.apply(result.candidate.actions[0]).completed).toBe(true);
        expect(actualExposure(h)).toEqual(result.selected);
    });

    test("does not expand an already safe move catalog or a catalog with a safe native move", () => {
        const h = fixture();
        const safe = h.moves.find((candidate) => candidate.targetCell?.x === 5 && candidate.targetCell.y === 9)!;
        const unsafe = h.moves.find((candidate) => candidate.targetCell?.x === 8 && candidate.targetCell.y === 6)!;
        expect(safe).toBeDefined();
        expect(unsafe).toBeDefined();
        expect(selectChakramScreenMove(h.actor, h.context, h.moves, [safe], h.incumbent)).toBeUndefined();
        expect(selectChakramScreenMove(h.actor, h.context, h.moves, [unsafe], safe.actions)).toBeUndefined();
        expect(
            selectChakramScreenMove(
                h.actor,
                { ...h.context, decisionOrigin: undefined },
                h.moves,
                [unsafe],
                h.incumbent,
            ),
        ).toBeUndefined();
        h.enemy.getRangeShots = () => 0;
        expect(selectChakramScreenMove(h.actor, h.context, h.moves, [unsafe], h.incumbent)).toBeUndefined();
    });

    test("reserves at most one candidate within K while preserving the top challenger", () => {
        const h = fixture();
        const retained = h.moves.slice(0, 3);
        const extra = h.moves[4];
        const result = reserveChakramScreenMove(extra, retained, 3);
        expect(result.length).toBe(3);
        expect(result[0]).toBe(retained[0]);
        expect(result).toContain(extra);
        expect(retained).not.toContain(extra);
        expect(reserveChakramScreenMove(undefined, retained, 3)).toBe(retained);
        expect(reserveChakramScreenMove(extra, result, 3)).toBe(result);
        expect(reserveChakramScreenMove(extra, retained, 1)).toBe(retained);
    });
});
