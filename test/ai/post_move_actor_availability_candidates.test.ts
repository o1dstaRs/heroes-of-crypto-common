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

import { enumerateCandidates, type IDecisionContext, type IEnumeratedCandidate } from "../../src/ai";
import type { IReadonlyWeightedRoute } from "../../src/ai/decision_path_catalog";
import { StrategyV0_5 } from "../../src/ai/versions/v0_5";
import { StrategyV0_8 } from "../../src/ai/versions/v0_8";
import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameAction } from "../../src/engine/actions";
import { repairUnavailableMovePrefixedAttack } from "../../src/engine/post_move_actor_availability";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import type { Unit } from "../../src/units/unit";
import type { XY } from "../../src/utils/math";
import {
    createCombatTestContext,
    createTestUnit,
    placeUnit,
    testGridSettings,
    type CombatTestContext,
} from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const MELEE = PBTypes.AttackVals.MELEE;
const RANGE = PBTypes.AttackVals.RANGE;

const endTurn = (unit: Unit): GameAction[] => [{ type: "end_turn", unitId: unit.getId(), reason: "manual" }];
const key = (cell: XY): number => (cell.x << 4) | cell.y;

function route(cell: XY, path: XY[]): IReadonlyWeightedRoute {
    return {
        cell,
        route: path,
        weight: Math.max(0, path.length - 1),
        firstAggrMet: false,
        hasLavaCell: false,
        hasWaterCell: false,
    };
}

function contextWithRoutes(combat: CombatTestContext, routes: IReadonlyWeightedRoute[]): IDecisionContext {
    return {
        grid: combat.grid,
        matrix: combat.grid.getMatrix(),
        unitsHolder: combat.unitsHolder,
        pathHelper: {
            getMovePath: () => ({
                cells: routes.map((candidate) => ({ ...candidate.cell })),
                hashes: new Set(routes.map((candidate) => key(candidate.cell))),
                knownPaths: new Map(routes.map((candidate) => [key(candidate.cell), [candidate]])),
            }),
        } as unknown as PathHelper,
        attackHandler: combat.attackHandler,
        fightProperties: FightStateManager.getInstance().getFightProperties(),
    };
}

function activateEngine(combat: CombatTestContext, unit: Unit, context: IDecisionContext): GameActionEngine {
    const fightProperties = context.fightProperties!;
    fightProperties.startFight();
    fightProperties.setTeamUnitsAlive(LOWER, combat.unitsHolder.getAllAllies(LOWER).length);
    fightProperties.setTeamUnitsAlive(UPPER, combat.unitsHolder.getAllAllies(UPPER).length);
    fightProperties.startTurn(unit.getTeam(), 1_000);
    return new GameActionEngine({
        fightProperties,
        grid: combat.grid,
        unitsHolder: combat.unitsHolder,
        moveHandler: new MoveHandler(testGridSettings, combat.grid, combat.unitsHolder),
        sceneLog: new SceneLogMock(),
        attackHandler: combat.attackHandler,
        getCurrentActiveUnitId: () => unit.getId(),
    });
}

function moveOf(candidate: IEnumeratedCandidate): Extract<GameAction, { type: "move_unit" }> | undefined {
    return candidate.actions.find(
        (action): action is Extract<GameAction, { type: "move_unit" }> => action.type === "move_unit",
    );
}

function meleeFixture(resurrection = false): {
    combat: CombatTestContext;
    actor: Unit;
    target: Unit;
    context: IDecisionContext;
    lethal: IReadonlyWeightedRoute;
    safe: IReadonlyWeightedRoute;
} {
    const combat = createCombatTestContext();
    const actor = createTestUnit({
        team: LOWER,
        name: resurrection ? "Charged Angel" : "Fragile brawler",
        attackType: MELEE,
        speed: 4,
        amountAlive: 1,
        maxHp: 10,
        damageMin: 2,
        damageMax: 2,
        abilities: resurrection ? ["Resurrection"] : [],
        spells: resurrection ? ["System:Resurrection"] : [],
    });
    const target = createTestUnit({ team: UPPER, name: "Melee target", amountAlive: 10, maxHp: 20 });
    actor.applyDamage(9, 0, new SceneLogMock());
    placeUnit(combat.grid, combat.unitsHolder, actor, { x: 2, y: 2 });
    placeUnit(combat.grid, combat.unitsHolder, target, { x: 5, y: 3 });
    const lethal = route({ x: 4, y: 2 }, [
        { x: 2, y: 2 },
        { x: 3, y: 2 },
        { x: 4, y: 2 },
    ]);
    const safe = route({ x: 4, y: 3 }, [
        { x: 2, y: 2 },
        { x: 3, y: 3 },
        { x: 4, y: 3 },
    ]);
    FightStateManager.getInstance().getFightProperties().getFireWalls().add({ x: 3, y: 2 }, 3, 25);
    return { combat, actor, target, context: contextWithRoutes(combat, [lethal, safe]), lethal, safe };
}

function moveShotFixture(): {
    combat: CombatTestContext;
    shooter: Unit;
    target: Unit;
    context: IDecisionContext;
    lethal: IReadonlyWeightedRoute;
    safe: IReadonlyWeightedRoute;
} {
    const combat = createCombatTestContext();
    const shooter = createTestUnit({
        team: LOWER,
        name: "Fragile archer",
        attackType: RANGE,
        speed: 4,
        rangeShots: 5,
        shotDistance: 3,
        amountAlive: 1,
        maxHp: 10,
        damageMin: 10,
        damageMax: 10,
    });
    const target = createTestUnit({ team: UPPER, name: "Distant target", amountAlive: 20, maxHp: 20 });
    shooter.applyDamage(9, 0, new SceneLogMock());
    placeUnit(combat.grid, combat.unitsHolder, shooter, { x: 2, y: 7 });
    placeUnit(combat.grid, combat.unitsHolder, target, { x: 10, y: 7 });
    shooter.refreshPossibleAttackTypes(true);
    const lethal = route({ x: 5, y: 7 }, [
        { x: 2, y: 7 },
        { x: 3, y: 7 },
        { x: 4, y: 7 },
        { x: 5, y: 7 },
    ]);
    const safe = route({ x: 5, y: 8 }, [
        { x: 2, y: 7 },
        { x: 3, y: 8 },
        { x: 4, y: 8 },
        { x: 5, y: 8 },
    ]);
    FightStateManager.getInstance().getFightProperties().getFireWalls().add({ x: 3, y: 7 }, 3, 25);
    return { combat, shooter, target, context: contextWithRoutes(combat, [lethal, safe]), lethal, safe };
}

describe("AI post-move actor availability", () => {
    it("filters lethal move-melee before maxMeleePairs, backfills safe melee, and keeps the lethal standalone move", () => {
        const fixture = meleeFixture();
        const result = enumerateCandidates(fixture.actor, fixture.context, endTurn(fixture.actor), {
            maxMeleePairs: 1,
        });
        const melee = result.candidates.filter((candidate) => candidate.kind === "melee");
        const moves = result.candidates.filter((candidate) => candidate.kind === "move");

        expect(melee).toHaveLength(1);
        expect(melee[0].standCell).toEqual(fixture.safe.cell);
        expect(moveOf(melee[0])?.path).toEqual(fixture.safe.route.map((cell) => ({ ...cell })));
        expect(
            moves.some(
                (candidate) =>
                    moveOf(candidate)?.targetCells?.[0].x === fixture.lethal.cell.x &&
                    moveOf(candidate)?.targetCells?.[0].y === fixture.lethal.cell.y,
            ),
        ).toBe(true);

        const engine = activateEngine(fixture.combat, fixture.actor, fixture.context);
        expect(melee[0].actions.map((action) => engine.apply(action).completed)).toEqual([true, true]);
    });

    it("uses the bound authoritative Fire Wall store when a legacy decision context omits fightProperties", () => {
        const fixture = meleeFixture();
        const legacyContext = { ...fixture.context, fightProperties: undefined };

        const melee = enumerateCandidates(fixture.actor, legacyContext, endTurn(fixture.actor), {
            maxMeleePairs: 1,
        }).candidates.filter((candidate) => candidate.kind === "melee");

        expect(melee).toHaveLength(1);
        expect(melee[0].standCell).toEqual(fixture.safe.cell);
        expect(moveOf(melee[0])?.path).toEqual(fixture.safe.route.map((cell) => ({ ...cell })));
    });

    it("retains a lethal move-melee when the mover's live Resurrection charge makes the suffix legal", () => {
        const fixture = meleeFixture(true);
        const candidates = enumerateCandidates(fixture.actor, fixture.context, endTurn(fixture.actor)).candidates;
        const resurrecting = candidates.find(
            (candidate) =>
                candidate.kind === "melee" &&
                candidate.standCell?.x === fixture.lethal.cell.x &&
                candidate.standCell.y === fixture.lethal.cell.y,
        );
        expect(resurrecting).toBeDefined();

        const engine = activateEngine(fixture.combat, fixture.actor, fixture.context);
        const moveResult = engine.apply(resurrecting!.actions[0]);
        expect(moveResult.completed).toBe(true);
        expect(fixture.combat.unitsHolder.getAllUnits().has(fixture.actor.getId())).toBe(true);
        expect(fixture.actor.hasSpellRemaining("Resurrection")).toBe(false);
        expect(engine.apply(resurrecting!.actions[1]).completed).toBe(true);
    });

    it("filters lethal move-shots before the cap, backfills a safe shot, and refuses unsafe incumbent enrichment", () => {
        const fixture = moveShotFixture();
        const generated = enumerateCandidates(fixture.shooter, fixture.context, endTurn(fixture.shooter), {
            maxMoveShotComposites: 1,
        });
        const moveShots = generated.candidates.filter(
            (candidate) =>
                candidate.actions.some((action) => action.type === "move_unit") &&
                candidate.actions.some((action) => action.type === "range_attack"),
        );
        expect(moveShots).toHaveLength(1);
        expect(moveOf(moveShots[0])?.targetCells?.[0]).toEqual(fixture.safe.cell);

        const stationaryShot = generated.candidates.find(
            (candidate) =>
                candidate.kind === "shot" &&
                !candidate.actions.some((action) => action.type === "move_unit") &&
                candidate.actions.some((action) => action.type === "range_attack"),
        );
        expect(stationaryShot).toBeDefined();
        const unsafeIncumbent: GameAction[] = [
            {
                type: "move_unit",
                unitId: fixture.shooter.getId(),
                path: fixture.lethal.route.map((cell) => ({ ...cell })),
                targetCells: [{ ...fixture.lethal.cell }],
                hasLavaCell: false,
                hasWaterCell: false,
            },
            ...stationaryShot!.actions,
        ];
        const anchor = enumerateCandidates(fixture.shooter, fixture.context, unsafeIncumbent, {
            maxMoveShotComposites: 0,
            enrichIncumbentMetadata: true,
        }).candidates[0];
        expect(anchor.actions).toBe(unsafeIncumbent);
        expect(anchor.targetId).toBeUndefined();
        expect(anchor.features.expectedDamage).toBe(0);

        const engine = activateEngine(fixture.combat, fixture.shooter, fixture.context);
        expect(moveShots[0].actions.map((action) => engine.apply(action).completed)).toEqual([true, true]);
    });

    it("repairs only explicit actor-owned move→attack suffixes, not standalone moves or path-bearing melee", () => {
        const fixture = meleeFixture();
        const move: Extract<GameAction, { type: "move_unit" }> = {
            type: "move_unit",
            unitId: fixture.actor.getId(),
            path: fixture.lethal.route.map((cell) => ({ ...cell })),
            targetCells: [{ ...fixture.lethal.cell }],
        };
        const strike: Extract<GameAction, { type: "melee_attack" }> = {
            type: "melee_attack",
            attackerId: fixture.actor.getId(),
            targetId: fixture.target.getId(),
            attackFrom: { ...fixture.lethal.cell },
        };
        const explicit = [move, strike];
        const standalone = [move];
        const pathBearing: GameAction[] = [{ ...strike, path: move.path }];
        const walls = fixture.context.fightProperties!.getFireWalls();

        expect(repairUnavailableMovePrefixedAttack(fixture.actor, walls, explicit)).toEqual([move]);
        expect(repairUnavailableMovePrefixedAttack(fixture.actor, walls, standalone)).toBe(standalone);
        expect(repairUnavailableMovePrefixedAttack(fixture.actor, walls, pathBearing)).toBe(pathBearing);
    });

    it("v0.5's learned explicit move-melee seam skips a lethal route and selects the safe alternative", () => {
        const fixture = meleeFixture();
        const weights = new Array(60).fill(0);
        weights[19] = -1;
        const strategy = new StrategyV0_5(weights) as unknown as {
            meleeByPolicy(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[];
        };
        const decision: GameAction[] = [
            {
                type: "melee_attack",
                attackerId: fixture.actor.getId(),
                targetId: fixture.target.getId(),
                attackFrom: fixture.actor.getBaseCell(),
            },
        ];

        const actions = strategy.meleeByPolicy(fixture.actor, fixture.context, decision);
        const move = actions.find((action) => action.type === "move_unit");
        expect(move?.type).toBe("move_unit");
        if (move?.type !== "move_unit") throw new Error("expected v0.5 move-melee");
        expect(move.targetCells?.[0]).toEqual(fixture.safe.cell);
        expect(actions.some((action) => action.type === "melee_attack")).toBe(true);
    });

    it("v0.8 keeps a legal stationary shot instead of emitting a lethal protected move-shot", () => {
        const decide = (withLethalWall: boolean): GameAction[] => {
            const combat = createCombatTestContext();
            const shooter = createTestUnit({
                team: LOWER,
                name: "Protected fragile archer",
                attackType: RANGE,
                speed: 4,
                rangeShots: 8,
                shotDistance: 3,
                amountAlive: 1,
                maxHp: 10,
                damageMin: 10,
                damageMax: 10,
            });
            const target = createTestUnit({
                team: UPPER,
                name: "Protected target",
                attackType: MELEE,
                speed: 1,
                amountAlive: 10,
                maxHp: 20,
            });
            const guard = createTestUnit({ team: LOWER, name: "Frontline", attackType: MELEE, speed: 1 });
            shooter.applyDamage(9, 0, new SceneLogMock());
            placeUnit(combat.grid, combat.unitsHolder, shooter, { x: 2, y: 7 });
            placeUnit(combat.grid, combat.unitsHolder, guard, { x: 6, y: 7 });
            placeUnit(combat.grid, combat.unitsHolder, target, { x: 10, y: 7 });
            shooter.refreshPossibleAttackTypes(true);
            const candidateRoute = route({ x: 5, y: 7 }, [
                { x: 2, y: 7 },
                { x: 3, y: 7 },
                { x: 4, y: 7 },
                { x: 5, y: 7 },
            ]);
            const context = contextWithRoutes(combat, [candidateRoute]);
            if (withLethalWall) {
                context.fightProperties!.getFireWalls().add({ x: 3, y: 7 }, 3, 25);
            }
            return new StrategyV0_8().decideTurn(shooter, context);
        };

        expect(decide(false).map((action) => action.type)).toEqual(["move_unit", "range_attack"]);
        expect(decide(true).map((action) => action.type)).toEqual(["range_attack"]);
    });
});
