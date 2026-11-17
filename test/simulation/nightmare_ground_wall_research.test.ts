import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { enumerateCandidates } from "../../src/ai/candidates";
import type { IDecisionContext } from "../../src/ai/ai_strategy";
import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameAction } from "../../src/engine/actions";
import { projectPostMoveActorAvailability } from "../../src/engine/post_move_actor_availability";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { isCellWithinGrid } from "../../src/grid/grid_math";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { fireWallLitCells, FireWalls } from "../../src/spells/fire_walls";
import {
    appendNightmareGroundWall,
    proposeNightmareGroundWall,
} from "../../src/simulation/nightmare_ground_wall_research";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

function setup(kind: "flyer" | "shooter" | "caster" | "walker" = "flyer") {
    const combat = createCombatTestContext();
    const nightmare = createTestUnit({ team: 2, name: "Nightmare", spells: ["Chaos:Fire Wall"], stackPower: 5 });
    const ground = createTestUnit({ team: 1, name: "Ground threat", amountAlive: 10, maxHp: 100, damageMax: 10 });
    const distraction = createTestUnit({
        team: 1,
        name: "High damage distraction",
        amountAlive: 30,
        damageMax: 50,
        movementType: kind === "flyer" ? PBTypes.MovementVals.FLY : PBTypes.MovementVals.WALK,
        attackType: kind === "shooter" ? PBTypes.AttackVals.RANGE : PBTypes.AttackVals.MELEE,
        rangeShots: kind === "shooter" ? 10 : 0,
        spells: kind === "caster" ? ["Chaos:Fireball"] : [],
        stackPower: 5,
    });
    placeUnit(combat.grid, combat.unitsHolder, nightmare, { x: 3, y: 3 });
    placeUnit(combat.grid, combat.unitsHolder, ground, { x: 3, y: 12 });
    placeUnit(combat.grid, combat.unitsHolder, distraction, { x: 13, y: 12 });
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    const context: IDecisionContext = {
        ...combat,
        matrix: combat.grid.getMatrix(),
        pathHelper: new PathHelper(testGridSettings),
        fightProperties,
        decisionOrigin: "root",
    };
    const catalog = enumerateCandidates(nightmare, context, [
        { type: "end_turn", unitId: nightmare.getId(), reason: "manual" },
    ]).candidates;
    return { ...combat, nightmare, ground, distraction, context, catalog, fightProperties };
}

describe("Nightmare ground-wall research", () => {
    for (const kind of ["flyer", "shooter", "caster"] as const) {
        test(`offers a ground approach instead of the dominant ${kind}`, () => {
            const s = setup(kind);
            const original = s.catalog.find((candidate) => candidate.spellName === "Fire Wall");
            const proposal = proposeNightmareGroundWall(s.nightmare, s.context, s.catalog);
            expect(original).toBeDefined();
            expect(proposal?.groundEnemyIds).toEqual([s.ground.getId()]);
            expect(proposal?.excludedEnemyIds).toEqual([s.distraction.getId()]);
            expect(proposal?.candidate.actions).not.toEqual(original?.actions);
            expect(proposal?.candidate.features.expectedDamage).toBe(0);
            expect(proposal?.candidate.features.expectedKill).toBe(0);
        });
    }
    test("does not duplicate the existing all-ground geometry", () => {
        const s = setup("walker");
        expect(proposeNightmareGroundWall(s.nightmare, s.context, s.catalog)).toBeUndefined();
    });
    test("declines missing availability, other actors and rollout-only calls", () => {
        const s = setup();
        expect(proposeNightmareGroundWall(s.nightmare, s.context, [])).toBeUndefined();
        expect(proposeNightmareGroundWall(s.ground, s.context, s.catalog)).toBeUndefined();
        expect(
            proposeNightmareGroundWall(s.nightmare, { ...s.context, decisionOrigin: undefined }, s.catalog),
        ).toBeUndefined();
    });
    test("keeps every ordinary alternative and does not mutate state or metadata", () => {
        const s = setup();
        const before = JSON.stringify({
            catalog: s.catalog,
            walls: s.fightProperties.getFireWalls().toJSON(),
            cells: s.ground.getCells(),
            hp: s.ground.getCumulativeHp(),
        });
        const proposal = proposeNightmareGroundWall(s.nightmare, s.context, s.catalog);
        const retained = s.catalog.slice(0, 6);
        const combined = appendNightmareGroundWall(retained, proposal);
        expect(combined.length).toBe(retained.length + 1);
        retained.forEach((candidate, i) => expect(combined[i]).toBe(candidate));
        expect(appendNightmareGroundWall(retained, undefined)).toBe(retained);
        expect(
            JSON.stringify({
                catalog: s.catalog,
                walls: s.fightProperties.getFireWalls().toJSON(),
                cells: s.ground.getCells(),
                hp: s.ground.getCumulativeHp(),
            }),
        ).toBe(before);
        expect(proposeNightmareGroundWall(s.nightmare, s.context, [...s.catalog, proposal!.candidate])).toBeUndefined();
    });
    test("the proposed cast is engine-legal and covers a ground crossing the old wall misses", () => {
        const s = setup();
        const original = s.catalog.find((candidate) => candidate.spellName === "Fire Wall")!;
        const proposal = proposeNightmareGroundWall(s.nightmare, s.context, s.catalog)!;
        const cells = (candidate: typeof original) => {
            const action = candidate.actions[0];
            if (action.type !== "cast_spell" || !action.targetCell) throw new Error("Missing wall");
            return fireWallLitCells(
                s.grid,
                (c) => isCellWithinGrid(testGridSettings, c),
                action.targetCell,
                action.targetOrientation ?? 0,
            );
        };
        const oldWalls = new FireWalls();
        oldWalls.addAll(cells(original), 3);
        const move: Extract<GameAction, { type: "move_unit" }> = {
            type: "move_unit",
            unitId: s.ground.getId(),
            path: [
                { x: 3, y: 12 },
                { x: 3, y: 11 },
                { x: 3, y: 10 },
            ],
            targetCells: [{ x: 3, y: 10 }],
        };
        expect(projectPostMoveActorAvailability(s.ground, oldWalls, move).totalAppliedDamage).toBe(0);
        s.fightProperties.startFight();
        s.fightProperties.setTeamUnitsAlive(2, 1);
        s.fightProperties.setTeamUnitsAlive(1, 2);
        s.fightProperties.startTurn(2, 1000);
        const engine = new GameActionEngine({
            ...s.context,
            fightProperties: s.fightProperties,
            moveHandler: new MoveHandler(testGridSettings, s.grid, s.unitsHolder),
            sceneLog: new SceneLogMock(),
            getCurrentActiveUnitId: () => s.nightmare.getId(),
            getCurrentEnemiesCellsWithinMovementRange: () => [],
        });
        const cast = engine.apply(proposal.candidate.actions[0]);
        expect(cast.completed).toBe(true);
        expect(s.fightProperties.getFireWalls().cells()).toEqual(cells(proposal.candidate));
        expect(
            projectPostMoveActorAvailability(s.ground, s.fightProperties.getFireWalls(), move).totalAppliedDamage,
        ).toBe(250);
    });
    test("is absent from the serving driver and profile", () => {
        for (const path of ["../../src/simulation/search_driver.ts", "../../src/ai/versions/v0_8_a19_profile.ts"])
            expect(readFileSync(new URL(path, import.meta.url), "utf8")).not.toContain(
                "nightmare_ground_wall_research",
            );
    });
});
