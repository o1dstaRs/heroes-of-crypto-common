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

import { AI_VERSIONS, DEFAULT_AI_VERSION, getAIStrategy, LATEST_AI_VERSION, type IDecisionContext } from "../../src/ai";
import { applyV07WaitCandidate } from "../../src/ai/versions/v0_7";
import {
    canWaitOnHourglassMirror,
    DISTILLED_WAIT_WEIGHTS_2026_07_10,
    extractWaitFeatures,
    waitScore,
} from "../../src/ai/versions/wait_scorer";
import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import type { Unit } from "../../src/units/unit";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const ENV_KEYS = ["V07_WAIT_SCORER", "V07_WAIT_WEIGHTS", "V07_WAIT_VERSIONS"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
    for (const key of ENV_KEYS) {
        const value = savedEnv[key];
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
});

interface Board {
    actor: Unit;
    context: IDecisionContext;
    incumbent: GameAction[];
}

function buildBoard(enemyAmountAlive = 1): Board {
    const combat = createCombatTestContext();
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    const actor = createTestUnit({ name: "Actor", team: LOWER, speed: 4 });
    const ally = createTestUnit({ name: "Ally", team: LOWER, speed: 2 });
    const enemyA = createTestUnit({ name: "Enemy A", team: UPPER, speed: 3, amountAlive: enemyAmountAlive });
    const enemyB = createTestUnit({ name: "Enemy B", team: UPPER, speed: 5, amountAlive: enemyAmountAlive });
    placeUnit(combat.grid, combat.unitsHolder, actor, { x: 3, y: 3 });
    placeUnit(combat.grid, combat.unitsHolder, ally, { x: 5, y: 3 });
    placeUnit(combat.grid, combat.unitsHolder, enemyA, { x: 3, y: 10 });
    placeUnit(combat.grid, combat.unitsHolder, enemyB, { x: 5, y: 10 });
    fightProperties.setTeamUnitsAlive(LOWER, 2);
    fightProperties.setTeamUnitsAlive(UPPER, 2);

    return {
        actor,
        context: {
            grid: combat.grid,
            matrix: combat.grid.getMatrix(),
            unitsHolder: combat.unitsHolder,
            pathHelper: new PathHelper(testGridSettings),
            attackHandler: combat.attackHandler,
            fightProperties,
        },
        incumbent: [
            {
                type: "melee_attack",
                attackerId: actor.getId(),
                targetId: enemyA.getId(),
                attackFrom: { x: 3, y: 9 },
                path: [
                    { x: 3, y: 4 },
                    { x: 3, y: 5 },
                ],
            },
        ],
    };
}

describe("v0.7 candidate registry", () => {
    it("registers v0.7 for explicit tournaments without promoting the shipping version", () => {
        expect(AI_VERSIONS).toContain("v0.7");
        expect(getAIStrategy("v0.7").version).toBe("v0.7");
        expect(DEFAULT_AI_VERSION).toBe("v0.6");
        expect(LATEST_AI_VERSION).toBe("v0.6");
    });
});

describe("v0.7 committed wait candidate", () => {
    it("matches the exact committed linear scorer at an eligible decision point", () => {
        const { actor, context, incumbent } = buildBoard();
        const fightProperties = context.fightProperties!;
        expect(canWaitOnHourglassMirror(actor, fightProperties)).toBe(true);
        const score = waitScore(
            DISTILLED_WAIT_WEIGHTS_2026_07_10,
            extractWaitFeatures(actor, context.unitsHolder, fightProperties, incumbent),
        );
        const actual = applyV07WaitCandidate(actor, context, incumbent);
        expect(actual).toEqual(score > 0 ? [{ type: "wait_turn", unitId: actor.getId() }] : incumbent);
        expect(score).not.toBe(0);
        expect(score).toBeLessThan(0);
    });

    it("replaces an eligible action when the committed scorer is positive", () => {
        const { actor, context, incumbent } = buildBoard(10);
        const fightProperties = context.fightProperties!;
        const score = waitScore(
            DISTILLED_WAIT_WEIGHTS_2026_07_10,
            extractWaitFeatures(actor, context.unitsHolder, fightProperties, incumbent),
        );

        expect(score).toBeGreaterThan(0);
        expect(applyV07WaitCandidate(actor, context, incumbent)).toEqual([
            { type: "wait_turn", unitId: actor.getId() },
        ]);
    });

    it("emits a wait that the action engine accepts at a positive-score decision point", () => {
        delete process.env.V07_WAIT_SCORER;
        delete process.env.V07_WAIT_WEIGHTS;
        delete process.env.V07_WAIT_VERSIONS;
        const { actor, context } = buildBoard(10);
        const fightProperties = context.fightProperties!;
        fightProperties.startFight();
        fightProperties.startTurn(LOWER, 1_000);

        expect(
            getAIStrategy("v0.6")
                .decideTurn(actor, context)
                .some((action) => action.type === "wait_turn"),
        ).toBe(false);
        const actions = getAIStrategy("v0.7").decideTurn(actor, context);
        expect(actions).toEqual([{ type: "wait_turn", unitId: actor.getId() }]);

        const engine = new GameActionEngine({
            fightProperties,
            grid: context.grid,
            unitsHolder: context.unitsHolder,
            moveHandler: new MoveHandler(testGridSettings, context.grid, context.unitsHolder),
            sceneLog: new SceneLogMock(),
            attackHandler: context.attackHandler,
            getCurrentActiveUnitId: () => actor.getId(),
        });
        const result = engine.apply(actions[0]);

        expect(result.completed).toBe(true);
        expect(result.rejectionReason).toBeUndefined();
        expect(result.events).toContainEqual({ type: "unit_waited", unitId: actor.getId(), team: LOWER });
        expect(fightProperties.hourglassIncludes(actor.getId())).toBe(true);
        expect(fightProperties.hasAlreadyMadeTurn(actor.getId())).toBe(false);
    });

    it("applies the committed scorer after the inherited v0.6 decision", () => {
        delete process.env.V07_WAIT_SCORER;
        delete process.env.V07_WAIT_WEIGHTS;
        delete process.env.V07_WAIT_VERSIONS;
        const { actor, context } = buildBoard();
        const incumbent = getAIStrategy("v0.6").decideTurn(actor, context);
        const expected = applyV07WaitCandidate(actor, context, incumbent);
        expect(getAIStrategy("v0.7").decideTurn(actor, context)).toEqual(expected);
    });

    it("does not consult env-gated weights even when v0.7 is explicitly put in their scope", () => {
        const { actor, context } = buildBoard();
        delete process.env.V07_WAIT_SCORER;
        delete process.env.V07_WAIT_WEIGHTS;
        delete process.env.V07_WAIT_VERSIONS;
        const baseline = getAIStrategy("v0.7").decideTurn(actor, context);
        expect(baseline.some((action) => action.type === "wait_turn")).toBe(false);
        process.env.V07_WAIT_SCORER = "on";
        process.env.V07_WAIT_VERSIONS = "v0.7";
        process.env.V07_WAIT_WEIGHTS = JSON.stringify({
            b: 1_000,
            w: DISTILLED_WAIT_WEIGHTS_2026_07_10.w.map(() => 0),
        });
        expect(getAIStrategy("v0.7").decideTurn(actor, context)).toEqual(baseline);
    });

    it("leaves the registered default strategy isolated from the candidate", () => {
        expect(getAIStrategy(DEFAULT_AI_VERSION)).toBe(getAIStrategy("v0.6"));
        expect(getAIStrategy(DEFAULT_AI_VERSION)).not.toBe(getAIStrategy("v0.7"));
    });
});
