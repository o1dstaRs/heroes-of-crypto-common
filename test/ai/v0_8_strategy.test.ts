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

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
    AI_VERSIONS,
    DEFAULT_AI_VERSION,
    getAIStrategy,
    LATEST_AI_VERSION,
    type IDecisionContext,
    type IEnumeratedCandidate,
} from "../../src/ai";
import { StrategyV0_7 } from "../../src/ai/versions/v0_7";
import {
    ensureExplicitV08Action,
    prioritizeV08Decision,
    prioritizeV08ProductiveAction,
    selectV08DirectCombatCandidate,
    selectV08ProductiveCandidate,
    StrategyV0_8,
} from "../../src/ai/versions/v0_8";
import { V08_DOMINANT_FINISH_START_LAP } from "../../src/ai/versions/v0_8_dominant_finish";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { buildRoster, makeRng } from "../../src/simulation/army";
import { runMatch } from "../../src/simulation/battle_engine";
import type { Unit } from "../../src/units/unit";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

const BEHAVIOR_ENV_PREFIXES = ["V04_", "V05_", "V06_", "V07_", "SEARCH_", "Q2_", "CEM_"] as const;
const savedBehaviorEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => BEHAVIOR_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))),
);

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const MELEE = PBTypes.AttackVals.MELEE;
const RANGE = PBTypes.AttackVals.RANGE;

function setupMountainDecision(
    enemyCell: { x: number; y: number },
    speed: number,
): {
    unit: Unit;
    enemy: Unit;
    context: IDecisionContext;
} {
    const combat = createCombatTestContext(PBTypes.GridVals.BLOCK_CENTER);
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(PBTypes.GridVals.BLOCK_CENTER);
    const unit = createTestUnit({ team: LOWER, attackType: MELEE, speed, name: "Miner" });
    const rangedAlly = createTestUnit({
        team: LOWER,
        attackType: RANGE,
        rangeShots: 5,
        damageMax: 10,
        name: "Archer",
    });
    const enemy = createTestUnit({ team: UPPER, attackType: MELEE, name: "Enemy" });
    placeUnit(combat.grid, combat.unitsHolder, unit, { x: 5, y: 7 });
    placeUnit(combat.grid, combat.unitsHolder, rangedAlly, { x: 1, y: 12 });
    placeUnit(combat.grid, combat.unitsHolder, enemy, enemyCell);
    return {
        unit,
        enemy,
        context: {
            grid: combat.grid,
            matrix: combat.grid.getMatrix(),
            unitsHolder: combat.unitsHolder,
            pathHelper: new PathHelper(testGridSettings),
            attackHandler: combat.attackHandler,
            fightProperties,
        },
    };
}

beforeEach(() => {
    for (const key of Object.keys(process.env)) {
        if (BEHAVIOR_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) delete process.env[key];
    }
});

afterEach(() => {
    for (const key of Object.keys(process.env)) {
        if (BEHAVIOR_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) delete process.env[key];
    }
    Object.assign(process.env, savedBehaviorEnv);
});

describe("v0.8 candidate policy", () => {
    it("is the latest candidate while v0.7 remains the shipped default", () => {
        const candidate = getAIStrategy("v0.8");
        expect(candidate).toBeInstanceOf(StrategyV0_7);
        expect(candidate).toBeInstanceOf(StrategyV0_8);
        expect(candidate.version).toBe("v0.8");
        expect(Object.getOwnPropertyNames(StrategyV0_8.prototype)).toEqual(["constructor", "decideTurn"]);
        expect(AI_VERSIONS.indexOf("v0.8")).toBeGreaterThan(AI_VERSIONS.indexOf("v0.7"));
        expect(LATEST_AI_VERSION).toBe("v0.8");
        expect(DEFAULT_AI_VERSION).toBe("v0.7");
    });

    it("replaces only empty/end-turn-only decisions with an explicit defend", () => {
        const endTurn: GameAction[] = [{ type: "end_turn", unitId: "u1", reason: "manual" }];
        const defend: GameAction[] = [{ type: "defend_turn", unitId: "u1" }];
        const mixed: GameAction[] = [...endTurn, ...defend];

        expect(ensureExplicitV08Action("u1", [])).toEqual(defend);
        expect(ensureExplicitV08Action("u1", endTurn)).toEqual(defend);
        expect(ensureExplicitV08Action("u1", defend)).toBe(defend);
        expect(ensureExplicitV08Action("u1", mixed)).toBe(mixed);
    });

    it("selects the strongest immediate attack before a move and a move before a support spell", () => {
        const move: GameAction[] = [{ type: "move_unit", unitId: "u1", path: [{ x: 2, y: 2 }] }];
        const spell: GameAction[] = [{ type: "cast_spell", casterId: "u1", spellName: "Courage" }];
        const highDamage: GameAction[] = [
            { type: "melee_attack", attackerId: "u1", targetId: "enemy-1", attackFrom: { x: 2, y: 2 } },
        ];
        const kill: GameAction[] = [
            { type: "melee_attack", attackerId: "u1", targetId: "enemy-2", attackFrom: { x: 2, y: 2 } },
        ];
        const movedHighDamage: GameAction[] = [
            { type: "move_unit", unitId: "u1", path: [{ x: 2, y: 2 }] },
            { type: "melee_attack", attackerId: "u1", targetId: "enemy-1", attackFrom: { x: 2, y: 2 } },
        ];
        const candidates = [
            { kind: "move", actions: move },
            { kind: "spell", actions: spell },
            { kind: "shot", actions: highDamage, features: { expectedKill: 1, expectedDamage: Number.NaN } },
            { kind: "melee", actions: movedHighDamage, features: { expectedKill: 0, expectedDamage: 100 } },
            { kind: "melee", actions: highDamage, features: { expectedKill: 0, expectedDamage: 100 } },
            { kind: "melee", actions: kill, features: { expectedKill: 1, expectedDamage: 10 } },
        ] as unknown as IEnumeratedCandidate[];

        expect(selectV08DirectCombatCandidate(candidates)?.actions).toBe(highDamage);
        expect(selectV08ProductiveCandidate(candidates)?.actions).toBe(highDamage);
        expect(selectV08ProductiveCandidate(candidates.slice(0, 2))?.actions).toBe(move);
    });

    it("preserves BLOCK_CENTER mining when no immediately damaging attack proves a better direct action", () => {
        const { unit, context } = setupMountainDecision({ x: 12, y: 12 }, 2);
        const inherited = new StrategyV0_7().decideTurn(unit, context);

        expect(inherited.map((action) => action.type)).toEqual(["obstacle_attack"]);
        const decision = new StrategyV0_8().decideTurn(unit, context);
        expect(decision).toEqual(inherited);

        const moveThenMine: GameAction[] = [
            { type: "move_unit", unitId: unit.getId(), path: [{ x: 5, y: 6 }] },
            { type: "obstacle_attack", attackerId: unit.getId(), targetPosition: { x: 7, y: 7 } },
        ];
        const repairedSequence = prioritizeV08ProductiveAction(unit, context, moveThenMine);
        expect(repairedSequence).toBe(moveThenMine);
    });

    it("replaces legacy BLOCK_CENTER mining with a reachable enemy attack before considering movement", () => {
        process.env.V06_LEGACY_MINE = "1";
        const { unit, enemy, context } = setupMountainDecision({ x: 5, y: 3 }, 5);
        expect(new StrategyV0_7().decideTurn(unit, context).map((action) => action.type)).toEqual(["obstacle_attack"]);

        const decision = new StrategyV0_8().decideTurn(unit, context);
        expect(decision.map((action) => action.type)).toEqual(["move_unit", "melee_attack"]);
        expect(decision[1]).toMatchObject({ type: "melee_attack", targetId: enemy.getId() });

        const moveThenMine: GameAction[] = [
            { type: "move_unit", unitId: unit.getId(), path: [{ x: 5, y: 6 }] },
            { type: "obstacle_attack", attackerId: unit.getId(), targetPosition: { x: 7, y: 7 } },
        ];
        expect(prioritizeV08ProductiveAction(unit, context, moveThenMine).map((action) => action.type)).toEqual([
            "move_unit",
            "melee_attack",
        ]);
    });

    it("preserves strategic wait and Luck Shield decisions outside the searched or dominant-finish paths", () => {
        const { unit, context } = setupMountainDecision({ x: 12, y: 12 }, 2);
        const wait: GameAction[] = [{ type: "wait_turn", unitId: unit.getId() }];
        const defend: GameAction[] = [{ type: "defend_turn", unitId: unit.getId() }];

        expect(prioritizeV08ProductiveAction(unit, context, wait)).toBe(wait);
        expect(prioritizeV08ProductiveAction(unit, context, defend)).toBe(defend);

        unit.setWebMovementLocked(true);
        expect(prioritizeV08ProductiveAction(unit, context, defend)).toBe(defend);
        expect(new StrategyV0_8().decideTurn(unit, context)).toEqual(defend);
    });

    it("forces a legal direct attack in the dominant finish window and preserves inherited combat", () => {
        const { unit, context } = setupMountainDecision({ x: 5, y: 3 }, 5);
        const move: GameAction[] = [{ type: "move_unit", unitId: unit.getId(), path: [{ x: 5, y: 6 }] }];
        const fightProperties = context.fightProperties!;

        expect(prioritizeV08Decision(unit, context, move)).toBe(move);
        while (fightProperties.getCurrentLap() < V08_DOMINANT_FINISH_START_LAP) {
            fightProperties.flipLap();
        }

        const directCombat = prioritizeV08Decision(unit, context, move);
        expect(directCombat.map((action) => action.type)).toEqual(["move_unit", "melee_attack"]);
        expect(prioritizeV08Decision(unit, context, directCombat)).toBe(directCombat);
    });

    it("leaves clean-default non-mountain v0.7 replay behavior byte-identical", () => {
        const seed = 20260718;
        const roster = buildRoster(makeRng(seed));
        const config = { redVersion: "v0.6", roster, seed, maxLaps: 60 } as const;
        const baseline = runMatch({ ...structuredClone(config), greenVersion: "v0.7" });
        const candidate = runMatch({ ...structuredClone(config), greenVersion: "v0.8" });
        const repeatedBaseline = runMatch({ ...structuredClone(config), greenVersion: "v0.7" });

        expect(candidate.outcome.green.version).toBe("v0.8");
        expect(repeatedBaseline).toEqual(baseline);
        candidate.outcome.green.version = "v0.7";
        expect(candidate).toEqual(baseline);
    });
});
