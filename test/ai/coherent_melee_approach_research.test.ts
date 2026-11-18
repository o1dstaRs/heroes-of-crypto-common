import { describe, expect, it } from "bun:test";

import type { IDecisionContext } from "../../src/ai/ai_strategy";
import { coherentMeleeApproachResearch } from "../../src/ai/coherent_melee_approach_research";
import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { captureDeterministicRandomState } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;

function fixture(team: 1 | 2 = LEFT, width = 1, height = 1, amountAlive = 10) {
    const combat = createCombatTestContext();
    const actor = createTestUnit({
        team,
        footprintWidth: width,
        footprintHeight: height,
        amountAlive,
        initiative: 5,
    });
    const enemyTeam = team === LEFT ? RIGHT : LEFT;
    const target = createTestUnit({ team: enemyTeam, amountAlive: 100 });
    placeUnit(combat.grid, combat.unitsHolder, actor, { x: 3, y: 3 });
    placeUnit(combat.grid, combat.unitsHolder, target, { x: 6, y: 5 });
    const properties = FightStateManager.getInstance().getFightProperties();
    const pathHelper = new PathHelper(testGridSettings);
    const context: IDecisionContext = {
        ...combat,
        matrix: combat.grid.getMatrix(),
        pathHelper,
        fightProperties: properties,
    };
    const actions: GameAction[] = [
        {
            type: "move_unit",
            unitId: actor.getId(),
            path: [
                { x: 3, y: 3 },
                { x: 4, y: 3 },
            ],
            targetCells: actor.getFootprintCellsForAnchor({ x: 4, y: 3 }),
            hasLavaCell: false,
            hasWaterCell: false,
        },
        {
            type: "melee_attack",
            attackerId: actor.getId(),
            targetId: target.getId(),
            attackFrom: { x: 5, y: 4 },
            path: [
                { x: 3, y: 3 },
                { x: 4, y: 4 },
                { x: 5, y: 4 },
            ],
            // Deliberately stale flags: the repaired move must use the native route's flags.
            hasLavaCell: true,
            hasWaterCell: true,
        },
    ];
    function engine() {
        properties.startFight();
        properties.setTeamUnitsAlive(LEFT, combat.unitsHolder.getAllAllies(LEFT).length);
        properties.setTeamUnitsAlive(RIGHT, combat.unitsHolder.getAllAllies(RIGHT).length);
        properties.startTurn(team, 1_000);
        return new GameActionEngine({
            ...combat,
            fightProperties: properties,
            moveHandler: new MoveHandler(testGridSettings, combat.grid, combat.unitsHolder),
            sceneLog: new SceneLogMock(),
            getCurrentActiveUnitId: () => actor.getId(),
            getCurrentActiveKnownPaths: () =>
                pathHelper.getMovePath(
                    actor.getBaseCell(),
                    combat.grid.getMatrix(),
                    actor.getSteps(),
                    combat.grid.getAggrMatrixByTeam(enemyTeam),
                    actor.canFly(),
                    actor.isSmallSize(),
                    actor.canTraverseLava(),
                    actor.hasAbilityActive("In Its Own World"),
                    width,
                    height,
                ).knownPaths,
        });
    }
    return { combat, actor, target, context, actions, properties, engine };
}

describe("offline coherent melee approach", () => {
    for (const team of [LEFT, RIGHT] as const) {
        for (const [width, height] of [
            [1, 1],
            [2, 1],
            [1, 2],
            [2, 2],
        ]) {
            it(`runs one native move and stationary hit for team ${team}, body ${width}x${height}`, () => {
                const f = fixture(team, width, height);
                const before = structuredClone(f.actions);
                const propertiesBefore = structuredClone(f.actor.getUnitProperties());
                const randomBefore = captureDeterministicRandomState();
                const result = coherentMeleeApproachResearch(f.actor, f.context, f.actions);
                expect(result.reason).toBe("aligned-approach");
                expect(f.actions).toEqual(before);
                expect(f.actor.getUnitProperties()).toEqual(propertiesBefore);
                expect(captureDeterministicRandomState()).toEqual(randomBefore);
                expect(result.actions.map((action) => action.type)).toEqual(["move_unit", "melee_attack"]);
                const move = result.actions[0] as Extract<GameAction, { type: "move_unit" }>;
                const strike = result.actions[1] as Extract<GameAction, { type: "melee_attack" }>;
                expect(move.path.at(-1)).toEqual(strike.attackFrom);
                expect(move.targetCells).toEqual(f.actor.getFootprintCellsForAnchor(strike.attackFrom));
                expect(move.hasLavaCell).toBe(false);
                expect(move.hasWaterCell).toBe(false);
                expect(strike.path).toBeUndefined();
                const engine = f.engine();
                const movement = engine.apply(move);
                expect(movement.completed).toBe(true);
                expect(movement.events.some((event) => event.type === "unit_moved")).toBe(true);
                const targetHp = f.target.getCumulativeHp();
                const hit = engine.apply(strike);
                expect(hit.completed).toBe(true);
                expect(hit.events.some((event) => event.type === "unit_attacked")).toBe(true);
                expect(f.target.getCumulativeHp()).toBeLessThan(targetHp);
            });
        }
    }

    it("keeps coherent moves, path-bearing attacks and passive decisions by reference", () => {
        const f = fixture();
        const coherent = structuredClone(f.actions);
        const move = coherent[0] as Extract<GameAction, { type: "move_unit" }>;
        move.targetCells = [{ x: 5, y: 4 }];
        move.path = [
            { x: 3, y: 3 },
            { x: 4, y: 4 },
            { x: 5, y: 4 },
        ];
        for (const actions of [
            coherent,
            [f.actions[0]],
            [f.actions[1]],
            [{ type: "wait_turn", unitId: f.actor.getId() } as GameAction],
        ]) {
            const result = coherentMeleeApproachResearch(f.actor, f.context, actions);
            expect(result.actions).toBe(actions);
            expect(result.reason).toBe("unchanged");
        }
    });

    it("preserves the original move when the new approach is unreachable", () => {
        const f = fixture();
        const context = {
            ...f.context,
            pathHelper: {
                getMovePath: () => ({ cells: [], hashes: new Set(), knownPaths: new Map() }),
            } as unknown as PathHelper,
        };
        const result = coherentMeleeApproachResearch(f.actor, context, f.actions);
        expect(result.reason).toBe("unavailable-approach");
        expect(result.actions).toEqual([f.actions[0]]);
    });

    it("does not carry a strike through fatal Fire Wall cleanup on the repaired route", () => {
        const f = fixture(LEFT, 1, 1, 1);
        f.combat.grid.cleanupAll(f.actor.getId(), f.actor.getAttackRange(), f.actor.isSmallSize());
        placeUnit(f.combat.grid, f.combat.unitsHolder, f.actor, { x: 4, y: 3 });
        const context = { ...f.context, matrix: f.combat.grid.getMatrix() };
        const oldMove = f.actions[0] as Extract<GameAction, { type: "move_unit" }>;
        oldMove.path = [
            { x: 4, y: 3 },
            { x: 4, y: 4 },
        ];
        oldMove.targetCells = [{ x: 4, y: 4 }];
        f.actor.applyDamage(f.actor.getCumulativeHp() - 1, 0, new SceneLogMock());
        f.properties.getFireWalls().add({ x: 5, y: 4 }, 3, 25);
        const result = coherentMeleeApproachResearch(f.actor, context, f.actions);
        expect(result.reason).toBe("movement-blocks-strike");
        expect(result.actions.map((action) => action.type)).toEqual(["move_unit"]);
        const move = f.engine().apply(result.actions[0]);
        expect(move.completed).toBe(true);
        expect(f.actor.isDead()).toBe(true);
        expect(move.events.some((event) => event.type === "fire_wall_burned")).toBe(true);
    });

    it("drops the stale move when the chosen strike is already stationary", () => {
        const f = fixture();
        f.combat.grid.cleanupAll(f.target.getId(), f.target.getAttackRange(), f.target.isSmallSize());
        placeUnit(f.combat.grid, f.combat.unitsHolder, f.target, { x: 4, y: 4 });
        const strike = f.actions[1] as Extract<GameAction, { type: "melee_attack" }>;
        strike.attackFrom = f.actor.getBaseCell();
        const result = coherentMeleeApproachResearch(f.actor, f.context, f.actions);
        expect(result.reason).toBe("stationary-strike");
        expect(result.actions.map((action) => action.type)).toEqual(["melee_attack"]);
        expect(f.engine().apply(result.actions[0]).completed).toBe(true);
    });
});
