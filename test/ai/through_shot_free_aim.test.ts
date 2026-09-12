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

import { afterEach, describe, expect, it } from "bun:test";

import { enumerateCandidates, type IEnumeratedCandidate } from "../../src/ai/candidates";
import { AI_VERSIONS, createAIStrategy } from "../../src/ai/ranked_profile";
import { V08_THROUGH_SHOT_LINE_ENV } from "../../src/ai/through_shot_line";
import { StrategyV0_8 } from "../../src/ai/versions/v0_8";
import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getRangeAttackSideCenter, type RangeAttackCellSide } from "../../src/grid/grid_math";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import type { Unit } from "../../src/units/unit";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;

/**
 * A Through Shot is a LINE: it pierces every enemy on its ray to the field edge, and the new aiming lets
 * the shooter aim that ray at any world point rather than only at a visible edge of one stack.
 *
 * This board is one where that matters. Four enemies stand so that every visible-edge aim pierces exactly
 * ONE of them, while a ray through the corner region of E1's cell grazes E1 and continues into E2 — a line
 * no edge produces. Found by a randomized sweep (300 boards: ~3% have such a line, and a 5x5 aim sub-grid
 * finds nothing a 3x3 does not), then frozen here.
 */
const board = () => {
    const context = createCombatTestContext(PBTypes.GridVals.NORMAL);
    const { grid, unitsHolder, attackHandler } = context;
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(PBTypes.GridVals.NORMAL);
    fightProperties.startFight();

    const cannon = createTestUnit({
        name: "Tsar Cannon",
        team: LEFT,
        attackType: PBTypes.AttackVals.RANGE,
        attack: 60,
        damageMin: 50,
        damageMax: 50,
        rangeShots: 5,
        shotDistance: 20,
        initiative: 9,
        size: PBTypes.UnitSizeVals.LARGE,
        abilities: ["Through Shot", "Mechanism", "No Melee"],
    });
    placeUnit(grid, unitsHolder, cannon, { x: 4, y: 13 });

    const enemy = (name: string, cell: XY, size = PBTypes.UnitSizeVals.SMALL): Unit => {
        const unit = createTestUnit({ name, team: RIGHT, maxHp: 300, amountAlive: 8, armor: 0, size });
        placeUnit(grid, unitsHolder, unit, cell);
        return unit;
    };
    const enemies = {
        E0: enemy("E0", { x: 10, y: 12 }),
        E1: enemy("E1", { x: 7, y: 11 }),
        E2: enemy("E2", { x: 12, y: 6 }, PBTypes.UnitSizeVals.LARGE),
        E3: enemy("E3", { x: 9, y: 13 }),
    };

    fightProperties.setTeamUnitsAlive(LEFT, 1);
    fightProperties.setTeamUnitsAlive(RIGHT, 4);
    fightProperties.startTurn(LEFT, 1000);

    const decisionContext = {
        grid,
        matrix: grid.getMatrix(),
        unitsHolder,
        pathHelper: new PathHelper(grid.getSettings()),
        attackHandler,
        fightProperties,
    };

    /** The enemy stacks the engine's own ray evaluation says this shot action pierces, in ray order. */
    const pierced = (action: GameAction): string[] => {
        if (action.type !== "range_attack") {
            return [];
        }
        const to =
            action.targetPosition ??
            getRangeAttackSideCenter(
                grid.getSettings(),
                action.aimCell as XY,
                action.aimSide as RangeAttackCellSide,
                cannon.getPosition(),
            );
        return attackHandler
            .evaluateRangeAttack(unitsHolder.getAllUnits(), cannon, cannon.getPosition(), to, true, false, false)
            .affectedUnits.flat()
            .map((unit) => unit.getName());
    };

    const engine = new GameActionEngine({
        fightProperties,
        grid,
        unitsHolder,
        moveHandler: new MoveHandler(grid.getSettings(), grid, unitsHolder),
        sceneLog: new SceneLogMock(),
        attackHandler,
        getCurrentActiveUnitId: () => cannon.getId(),
    });

    return { cannon, enemies, decisionContext, pierced, engine };
};

const neutral = (unit: Unit): GameAction[] => [{ type: "end_turn", unitId: unit.getId(), reason: "manual" }];
const shotOf = (actions: readonly GameAction[]): Extract<GameAction, { type: "range_attack" }> | undefined =>
    actions.find((action): action is Extract<GameAction, { type: "range_attack" }> => action.type === "range_attack");
const shots = (candidates: readonly IEnumeratedCandidate[]): IEnumeratedCandidate[] =>
    candidates.filter((candidate) => candidate.kind === "shot");
const isFreeAim = (candidate: IEnumeratedCandidate): boolean => shotOf(candidate.actions)?.targetPosition !== undefined;

const withEnv = <T>(name: string, value: string | undefined, run: () => T): T => {
    const previous = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    try {
        return run();
    } finally {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
    }
};

afterEach(() => {
    delete process.env[V08_THROUGH_SHOT_LINE_ENV];
    delete process.env.V06_THROUGH_SHOT;
});

describe("Through Shot free aim in the candidate catalog", () => {
    it("is opt-in: without the option the catalog is the historical edge-only one", () => {
        const { cannon, decisionContext, pierced } = board();
        const edgeOnly = shots(enumerateCandidates(cannon, decisionContext as never, neutral(cannon)).candidates);

        expect(edgeOnly.length).toBeGreaterThan(0);
        expect(edgeOnly.some(isFreeAim)).toBe(false);
        // Every edge line on this board pierces exactly one stack — the premise of the fixture.
        for (const candidate of edgeOnly) {
            expect(pierced(candidate.actions.at(-1) as GameAction)).toHaveLength(1);
        }
    });

    it("adds only lines no visible edge reaches, and prices every pierced stack", () => {
        const { cannon, decisionContext, pierced } = board();
        const edgeOnly = shots(enumerateCandidates(cannon, decisionContext as never, neutral(cannon)).candidates);
        const withFree = shots(
            enumerateCandidates(cannon, decisionContext as never, neutral(cannon), { throughShotFreeAim: true })
                .candidates,
        );
        const free = withFree.filter(isFreeAim);
        const edge = withFree.filter((candidate) => !isFreeAim(candidate));

        // The edge catalog is untouched by the option; free lines are appended.
        expect(edge.map((candidate) => candidate.actions)).toEqual(edgeOnly.map((candidate) => candidate.actions));
        expect(free.length).toBeGreaterThan(0);

        const edgeLines = new Set(
            edgeOnly.map((candidate) => pierced(candidate.actions.at(-1) as GameAction).join(",")),
        );
        for (const candidate of free) {
            const shot = shotOf(candidate.actions)!;
            expect(shot.targetId).toBe("");
            expect(shot.aimCell).toBeUndefined();
            expect(Number.isInteger(shot.targetPosition!.x) && Number.isInteger(shot.targetPosition!.y)).toBe(true);
            expect(edgeLines.has(pierced(shot).join(","))).toBe(false);
            // The candidate's target is the first stack the ray crosses.
            expect(candidate.targetId).toBe(
                decisionContext.unitsHolder.getAllUnits().get(candidate.targetId!)!.getId(),
            );
        }
        // The grazing E1 -> E2 line exists and is priced as two full-strength hits: twice the best edge line.
        const grazing = free.find((candidate) => pierced(shotOf(candidate.actions)!).join(",") === "E1,E2");
        expect(grazing).toBeDefined();
        const bestEdge = Math.max(...edgeOnly.map((candidate) => candidate.features.expectedDamage));
        expect(grazing!.features.expectedDamage).toBe(2 * bestEdge);
        expect(grazing!.shotFeatures?.enemyDamage).toBe(grazing!.features.expectedDamage);
        expect(grazing!.shotFeatures?.friendlyFireDamage).toBe(0);
    });

    it("emits engine-legal actions: the free line applies and damages exactly the stacks it priced", () => {
        const { cannon, enemies, decisionContext, pierced, engine } = board();
        const free = shots(
            enumerateCandidates(cannon, decisionContext as never, neutral(cannon), { throughShotFreeAim: true })
                .candidates,
        ).filter(isFreeAim);
        const grazing = free.find((candidate) => pierced(shotOf(candidate.actions)!).join(",") === "E1,E2")!;
        const before = Object.fromEntries(
            Object.entries(enemies).map(([name, unit]) => [name, unit.getCumulativeHp()]),
        );

        for (const action of grazing.actions) {
            const result = engine.apply(action);
            expect(result.completed, `${action.type}: ${result.rejectionReason ?? "rejected"}`).toBe(true);
        }

        expect(enemies.E1.getCumulativeHp()).toBeLessThan(before.E1);
        expect(enemies.E2.getCumulativeHp()).toBeLessThan(before.E2);
        expect(enemies.E0.getCumulativeHp()).toBe(before.E0);
        expect(enemies.E3.getCumulativeHp()).toBe(before.E3);
    });
});

describe("v0.8 takes the strongest Through Shot line", () => {
    it("chooses the free two-stack line over every single-stack edge aim", () => {
        const { cannon, decisionContext, pierced, engine } = board();
        const actions = new StrategyV0_8().decideTurn(cannon, decisionContext as never);
        const shot = shotOf(actions)!;

        expect(shot.targetId).toBe("");
        expect(pierced(shot)).toEqual(["E1", "E2"]);
        for (const action of actions) {
            expect(engine.apply(action).completed).toBe(true);
        }
    });

    it("keeps the edge-aimed decision under the kill-switch, and honours a seat scope", () => {
        const off = withEnv(V08_THROUGH_SHOT_LINE_ENV, "off", () => {
            const { cannon, decisionContext, pierced } = board();
            const shot = shotOf(new StrategyV0_8().decideTurn(cannon, decisionContext as never))!;
            return { targetId: shot.targetId, pierced: pierced(shot) };
        });
        expect(off.targetId).not.toBe("");
        expect(off.pierced).toHaveLength(1);

        // The cannon is on the LEFT (green) seat: "red" scopes the policy away from it, "green" keeps it.
        const red = withEnv(V08_THROUGH_SHOT_LINE_ENV, "red", () => {
            const { cannon, decisionContext } = board();
            return shotOf(new StrategyV0_8().decideTurn(cannon, decisionContext as never))!.targetId;
        });
        const green = withEnv(V08_THROUGH_SHOT_LINE_ENV, "green", () => {
            const { cannon, decisionContext } = board();
            return shotOf(new StrategyV0_8().decideTurn(cannon, decisionContext as never))!.targetId;
        });
        expect(red).not.toBe("");
        expect(green).toBe("");
    });
});

describe("the frozen versions behind the V06_THROUGH_SHOT gate", () => {
    const frozen = AI_VERSIONS.filter((version) => !version.startsWith("v0.8") && version !== "v0.9");

    it("keep their exact decisions while the gate is off", () => {
        for (const version of frozen) {
            const { cannon, decisionContext } = board();
            const shot = shotOf(createAIStrategy(version).decideTurn(cannon, decisionContext as never));
            expect(`${version}:${shot?.targetPosition === undefined}`).toBe(`${version}:true`);
        }
    });

    it("all take the two-stack line once the gate is on", () => {
        withEnv("V06_THROUGH_SHOT", "on", () => {
            for (const version of frozen) {
                const { cannon, decisionContext, pierced } = board();
                const shot = shotOf(createAIStrategy(version).decideTurn(cannon, decisionContext as never));
                expect(`${version}:${shot ? pierced(shot).join(",") : "none"}`).toBe(`${version}:E1,E2`);
            }
        });
    });
});
