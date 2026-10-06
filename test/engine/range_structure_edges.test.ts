import { afterEach, describe, expect, it } from "bun:test";

import { AbilityFactory } from "../../src/abilities/ability_factory";
import type { IDecisionContext } from "../../src/ai/ai_strategy";
import { enumerateCandidates, findBestLegalStationaryRangeAttack } from "../../src/ai/candidates";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { GameActionEngine } from "../../src/engine/action_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { TeamType } from "../../src/generated/protobuf/v1/types_gen";
import {
    getRangeAttackSideCenter,
    hasObservableRangeAttackEdge,
    isRangeAttackSideObservable,
    RangeAttackCellSide,
    resolveRangeAttackAimEdge,
} from "../../src/grid/grid_math";
import { MoveHandler } from "../../src/handlers/move_handler";
import { ObstacleType } from "../../src/obstacles/obstacle_type";
import { PathHelper } from "../../src/grid/path_helper";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Unit } from "../../src/units/unit";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, placeUnit, testGridSettings } from "../helpers/combat";

const previousFight = FightStateManager.getInstance().getFightProperties();
afterEach(() => {
    setDeterministicRandomSource(undefined);
    FightStateManager.getInstance().setFightProperties(previousFight);
});

const directions = [
    { side: RangeAttackCellSide.LEFT, barrel: { x: 7, y: 8 }, shooter: { x: 3, y: 8 } },
    { side: RangeAttackCellSide.RIGHT, barrel: { x: 9, y: 8 }, shooter: { x: 13, y: 8 } },
    { side: RangeAttackCellSide.DOWN, barrel: { x: 8, y: 7 }, shooter: { x: 8, y: 3 } },
    { side: RangeAttackCellSide.UP, barrel: { x: 8, y: 9 }, shooter: { x: 8, y: 13 } },
];

function realUnit(faction: string, name: string, team: TeamType, amount = 1): Unit {
    const effects = new EffectFactory();
    return Unit.createUnit(
        getCreatureConfig(team, faction, name, "", amount),
        testGridSettings,
        team,
        PBTypes.UnitVals.CREATURE,
        new AbilityFactory(effects),
        effects,
        false,
    );
}

function fixture(name: string, team: TeamType, direction = directions[0], boxed = false) {
    const combat = createCombatTestContext(PBTypes.GridVals.BLOCK_CENTER);
    combat.grid.setScatteredMountains(boxed ? directions.map((entry) => entry.barrel) : [direction.barrel]);
    const enemyTeam = team === PBTypes.TeamVals.LEFT ? PBTypes.TeamVals.RIGHT : PBTypes.TeamVals.LEFT;
    const faction = name === "Gargantuan" ? "Nature" : name === "Cyclops" ? "Might" : "Life";
    const attacker = realUnit(faction, name, team);
    const target = realUnit("Life", "Peasant", enemyTeam, 100);
    placeUnit(combat.grid, combat.unitsHolder, attacker, direction.shooter);
    placeUnit(combat.grid, combat.unitsHolder, target, { x: 8, y: 8 });
    const fight = FightStateManager.getInstance().getFightProperties();
    fight.setGridType(PBTypes.GridVals.BLOCK_CENTER);
    fight.startFight();
    fight.setTeamUnitsAlive(team, 1);
    fight.setTeamUnitsAlive(enemyTeam, 1);
    fight.startTurn(team, 1000);
    attacker.refreshPossibleAttackTypes(true);
    const context: IDecisionContext = {
        ...combat,
        matrix: combat.grid.getMatrix(),
        pathHelper: new PathHelper(testGridSettings),
        fightProperties: fight,
    };
    const engine = new GameActionEngine({
        ...combat,
        fightProperties: fight,
        moveHandler: new MoveHandler(testGridSettings, combat.grid, combat.unitsHolder),
        sceneLog: new SceneLogMock(),
        getCurrentActiveUnitId: () => attacker.getId(),
    });
    return { ...combat, attacker, target, fight, context, engine };
}

describe("ranged edges beside structures", () => {
    for (const team of [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT]) {
        for (const name of ["Cyclops", "Gargantuan"]) {
            for (const direction of directions) {
                it(`${name}, team ${team}: honors side ${direction.side} beside a barrel and resolves its splash`, () => {
                    setDeterministicRandomSource(() => 0.99);
                    const f = fixture(name, team, direction);
                    const aimCell = f.target.getBaseCell();
                    const expectedAim = getRangeAttackSideCenter(
                        testGridSettings,
                        aimCell,
                        direction.side,
                        f.attacker.getPosition(),
                    );
                    const resolved = resolveRangeAttackAimEdge(
                        f.grid.getMatrix(),
                        testGridSettings,
                        f.target.getCells(),
                        f.attacker.getPosition(),
                        team,
                        false,
                        aimCell,
                        direction.side,
                        true,
                    );
                    expect(resolved?.side).toBe(direction.side);
                    const evaluate = f.attackHandler.evaluateRangeAttack.bind(f.attackHandler);
                    const aims: Parameters<typeof evaluate>[3][] = [];
                    f.attackHandler.evaluateRangeAttack = (...args) => {
                        aims.push(args[3]);
                        return evaluate(...args);
                    };
                    const hpBefore = f.target.getCumulativeHp();
                    const shotsBefore = f.attacker.getRangeShots();
                    const result = f.engine.apply({
                        type: "range_attack",
                        attackerId: f.attacker.getId(),
                        targetId: f.target.getId(),
                        aimCell,
                        aimSide: direction.side,
                    });
                    expect(result.completed).toBe(true);
                    expect(aims[0]).toEqual(expectedAim);
                    expect(f.target.getCumulativeHp()).toBeLessThan(hpBefore);
                    expect(f.grid.isScatteredMountainCell(direction.barrel.x, direction.barrel.y)).toBe(false);
                    expect(f.attacker.getRangeShots()).toBe(shotsBefore - (name === "Gargantuan" ? 2 : 1));
                    expect(f.fight.hasAlreadyMadeTurn(f.attacker.getId())).toBe(true);
                });
            }

            it(`${name}, team ${team}: AI finds an engine-legal shot at a target boxed in by barrels`, () => {
                const f = fixture(name, team, directions[0], true);
                const best = findBestLegalStationaryRangeAttack(f.attacker, f.context);
                expect(best).toBeDefined();
                const set = enumerateCandidates(f.attacker, f.context, []);
                const candidate = set.candidates.find((entry) =>
                    entry.actions.some(
                        (action) => action.type === "range_attack" && action.targetId === f.target.getId(),
                    ),
                );
                expect(candidate).toBeDefined();
                for (const action of candidate!.actions) {
                    expect(f.engine.apply(action).completed).toBe(true);
                }
            });
        }

        it(`team ${team}: ordinary arrows and Through Shot remain blocked by a barrel-covered edge`, () => {
            const f = fixture("Arbalester", team, directions[0], true);
            const cell = f.target.getBaseCell();
            expect(hasObservableRangeAttackEdge(f.grid.getMatrix(), f.target.getCells(), team)).toBe(false);
            expect(isRangeAttackSideObservable(f.grid.getMatrix(), cell, RangeAttackCellSide.LEFT, team, true)).toBe(
                false,
            );
            expect(
                f.engine.apply({ type: "range_attack", attackerId: f.attacker.getId(), targetId: f.target.getId() })
                    .completed,
            ).toBe(false);
        });

        it(`team ${team}: ignoring structures still cannot expose an edge covered by another enemy`, () => {
            const matrix = Array.from({ length: 16 }, () => new Array<number>(16).fill(0));
            const enemy = team === PBTypes.TeamVals.LEFT ? PBTypes.TeamVals.RIGHT : PBTypes.TeamVals.LEFT;
            matrix[8][7] = enemy;
            expect(
                isRangeAttackSideObservable(matrix, { x: 8, y: 8 }, RangeAttackCellSide.LEFT, team, false, true),
            ).toBe(false);
            matrix[8][7] = ObstacleType.BLOCK;
            expect(
                isRangeAttackSideObservable(matrix, { x: 8, y: 8 }, RangeAttackCellSide.LEFT, team, false, true),
            ).toBe(true);
        });
    }
});
