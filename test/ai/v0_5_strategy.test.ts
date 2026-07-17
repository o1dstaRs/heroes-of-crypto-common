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

import { getAIStrategy, type IDecisionContext } from "../../src/ai";
import { StrategyV0_5 } from "../../src/ai/versions/v0_5";
import { DEFAULT_V05_W, V05_WEIGHT_KEYS, loadV05Weights } from "../../src/ai/versions/v0_5_weights";
import { getSpellConfig } from "../../src/configuration/config_provider";
import type { GameAction } from "../../src/engine/actions";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { Spell } from "../../src/spells/spell";
import type { Unit } from "../../src/units/unit";
import {
    createCombatTestContext,
    createTestUnit,
    placeUnit,
    testGridSettings,
    type CombatTestContext,
} from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;

const decisionContext = (combat: CombatTestContext): IDecisionContext => ({
    grid: combat.grid,
    matrix: combat.grid.getMatrix(),
    unitsHolder: combat.unitsHolder,
    pathHelper: new PathHelper(testGridSettings),
    attackHandler: combat.attackHandler,
});

const applyCowardice = (unit: Unit): void => {
    unit.applyDebuff(new Spell({ spellProperties: getSpellConfig("Order", "Cowardice"), amount: 1 }));
};

const aoeRetarget = (
    unit: Unit,
    combat: CombatTestContext,
    baseTarget: Unit,
    baseAttackFrom: { x: number; y: number },
    weightIndex: number,
): Extract<GameAction, { type: "melee_attack" }> => {
    const weights = new Array(DEFAULT_V05_W.length).fill(0);
    weights[weightIndex] = 1;
    const actions = new StrategyV0_5(weights)["aoeMeleeByPolicy"](unit, decisionContext(combat), [
        {
            type: "melee_attack",
            attackerId: unit.getId(),
            targetId: baseTarget.getId(),
            attackFrom: baseAttackFrom,
        },
    ]);
    const attack = actions.find((action) => action.type === "melee_attack");
    if (!attack || attack.type !== "melee_attack") {
        throw new Error("Expected the AOE policy to retain a melee attack");
    }
    return attack;
};

describe("v0.5 — reinforcement-learned strategy", () => {
    afterEach(() => {
        delete process.env.V05_WEIGHTS;
    });

    it("is registered and reports version v0.5", () => {
        const v05 = getAIStrategy("v0.5");
        expect(v05.version).toBe("v0.5");
    });

    it("ships the trained vector (53 dims; overnight retrain, panel 72.24%, fresh-guard +0.93pp)", () => {
        // 10h CEM (2026-07-04, pass 20/21) re-trained after the Double Shot fix reopened the scoring landscape.
        // Panel 72.24% vs 70.55% base; fresh-seed guarded +0.93pp over the prior champion. All 53 dims trained,
        // including the target-caster features [51..52] (meleeTargetCaster / shotTargetCaster).
        expect(DEFAULT_V05_W).toEqual([
            1.7828, -0.8949, -0.3052, 1.8604, 1.5213, 5.5993, 0.5624, 0.1799, -0.9702, 1.2231, 0.2149, 2.1894, 3.1582,
            3.0048, -0.0237, 0.9643, 4.1739, 5.1118, -0.5432, 0.5818, -2.0671, 0.277, -2.6274, -2.4165, -1.3698, 2.6379,
            0.2916, -0.4279, 0.1587, -1.2452, -0.6807, 0.7213, -0.3563, 2.1045, -0.7515, 1.0022, 0.2311, 2.6854,
            -0.0261, -0.2301, 4.4516, 2.2054, -2.4419, 1.2098, 0.3502, -0.2083, 0.7573, -0.3856, 2.329, 0.1822, -1.5113,
            0.1957, 1.1489, -0.4775, -0.0261, 0.4148,
            // [56..59] meleeRapidCharge, meleeRangedTarget, meleeBaitRetal, meleeArmageddonTrade — untrained (0).
            0, 0, 0, 0,
        ]);
        expect(DEFAULT_V05_W.length).toBe(V05_WEIGHT_KEYS.length);
        expect(DEFAULT_V05_W.length).toBe(60);
    });

    it("loadV05Weights honours a well-formed process.env.V05_WEIGHTS override", () => {
        const trained = [
            1.2, 0.5, 0.8, 0.1, 0.05, 1.0, 0.4, -0.2, -0.6, 1.0, 0.3, -0.5, 0.7, 0.2, 0.9, 0.6, 0.3, 0.1, -0.4, 1.5,
            -0.7, 0.4, 0.3, -0.2, -0.5, -0.8, 0.2, -0.3, 0.1, 0.4, -0.1, 0.6, -0.2, 0.9, -0.4, 1.1, -0.7, 0.2, -0.9,
            0.5, 0.3, 0.15, -0.25, 0.35, -0.15, 0.45, -0.55, 0.65, -0.35, 0.2, -0.4, 0.6, -0.1, 0.25, -0.15, 0.35, 0.12,
            -0.22, 0.32, 0.42,
        ];
        process.env.V05_WEIGHTS = JSON.stringify(trained);
        expect(loadV05Weights()).toEqual(trained);
    });

    it("loadV05Weights falls back to the default on malformed / wrong-length / non-finite input", () => {
        for (const bad of ["not json", "[1,2,3]", JSON.stringify([1, 2, 3, 4, 5, "x"]), "{}", JSON.stringify(null)]) {
            process.env.V05_WEIGHTS = bad;
            expect(loadV05Weights()).toEqual(DEFAULT_V05_W.slice());
        }
    });

    it("returns the committed default when no override is set", () => {
        delete process.env.V05_WEIGHTS;
        expect(loadV05Weights()).toEqual(DEFAULT_V05_W.slice());
    });

    it("aims Lightning Spin at a Cowardice-legal primary without giving up the legal surround", () => {
        const combat = createCombatTestContext();
        const spinner = createTestUnit({ team: LOWER, abilities: ["Lightning Spin"], maxHp: 10, speed: 3 });
        const blocked = createTestUnit({ team: UPPER, name: "Blocked", amountAlive: 2, maxHp: 10 });
        const primary = createTestUnit({ team: UPPER, name: "Primary", maxHp: 10 });
        const splash = createTestUnit({ team: UPPER, name: "Splash", maxHp: 10 });
        placeUnit(combat.grid, combat.unitsHolder, spinner, { x: 6, y: 6 });
        placeUnit(combat.grid, combat.unitsHolder, blocked, { x: 6, y: 7 });
        placeUnit(combat.grid, combat.unitsHolder, primary, { x: 7, y: 6 });
        placeUnit(combat.grid, combat.unitsHolder, splash, { x: 7, y: 7 });
        applyCowardice(spinner);

        const attack = aoeRetarget(spinner, combat, primary, { x: 8, y: 6 }, 33);

        expect(blocked.getCumulativeHp()).toBeGreaterThan(spinner.getCumulativeHp());
        expect(primary.getCumulativeHp()).toBeLessThanOrEqual(spinner.getCumulativeHp());
        expect(attack.targetId).toBe(primary.getId());
        expect(attack.targetId).not.toBe(blocked.getId());
        expect(attack.attackFrom).toEqual({ x: 6, y: 6 });
        expect(Math.max(Math.abs(splash.getBaseCell().x - 6), Math.abs(splash.getBaseCell().y - 6))).toBe(1);
    });

    it("aims Skewer through a Cowardice-legal primary while retaining its legal line splash", () => {
        const combat = createCombatTestContext();
        const pikeman = createTestUnit({ team: LOWER, abilities: ["Skewer Strike"], maxHp: 10, speed: 3 });
        const blocked = createTestUnit({ team: UPPER, name: "Blocked", amountAlive: 2, maxHp: 10 });
        const blockedSplash = createTestUnit({ team: UPPER, name: "Blocked Splash", amountAlive: 2, maxHp: 10 });
        const primary = createTestUnit({ team: UPPER, name: "Primary", maxHp: 10 });
        const splash = createTestUnit({ team: UPPER, name: "Splash", maxHp: 10 });
        placeUnit(combat.grid, combat.unitsHolder, pikeman, { x: 6, y: 6 });
        placeUnit(combat.grid, combat.unitsHolder, blocked, { x: 7, y: 6 });
        placeUnit(combat.grid, combat.unitsHolder, blockedSplash, { x: 8, y: 6 });
        placeUnit(combat.grid, combat.unitsHolder, primary, { x: 6, y: 7 });
        placeUnit(combat.grid, combat.unitsHolder, splash, { x: 6, y: 8 });
        applyCowardice(pikeman);

        const attack = aoeRetarget(pikeman, combat, primary, { x: 5, y: 7 }, 41);

        expect(blocked.getCumulativeHp()).toBeGreaterThan(pikeman.getCumulativeHp());
        expect(primary.getCumulativeHp()).toBeLessThanOrEqual(pikeman.getCumulativeHp());
        expect(attack.targetId).toBe(primary.getId());
        expect(attack.targetId).not.toBe(blocked.getId());
        expect(attack.attackFrom).toEqual({ x: 6, y: 6 });
        expect(splash.getBaseCell()).toEqual({ x: 6, y: 8 });
    });

    it("does not score a large flying AOE attack from an unoccupiable lava footprint", () => {
        const combat = createCombatTestContext(PBTypes.GridVals.LAVA_CENTER);
        const dragon = createTestUnit({
            name: "Black Dragon",
            team: LOWER,
            abilities: ["Fire Breath"],
            movementType: PBTypes.MovementVals.FLY,
            size: PBTypes.UnitSizeVals.LARGE,
            speed: 4,
        });
        const incumbentTarget = createTestUnit({ team: UPPER, name: "Incumbent Target" });
        const lavaTarget = createTestUnit({ team: UPPER, name: "Lava Target" });
        const lavaSplash1 = createTestUnit({ team: UPPER, name: "Lava Splash 1" });
        const lavaSplash2 = createTestUnit({ team: UPPER, name: "Lava Splash 2" });
        placeUnit(combat.grid, combat.unitsHolder, dragon, { x: 9, y: 11 });
        placeUnit(combat.grid, combat.unitsHolder, incumbentTarget, { x: 8, y: 9 });
        placeUnit(combat.grid, combat.unitsHolder, lavaTarget, { x: 8, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, lavaSplash1, { x: 8, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, lavaSplash2, { x: 8, y: 3 });

        const lavaAttackFrom = { x: 8, y: 7 };
        const lavaFootprint = [
            { x: 8, y: 7 },
            { x: 8, y: 6 },
            { x: 7, y: 7 },
            { x: 7, y: 6 },
        ];
        const context = decisionContext(combat);
        context.pathHelper = {
            getMovePath: () => ({
                cells: [],
                hashes: new Set(),
                knownPaths: new Map([
                    [
                        (lavaAttackFrom.x << 4) | lavaAttackFrom.y,
                        [
                            {
                                cell: lavaAttackFrom,
                                route: [dragon.getBaseCell(), lavaAttackFrom],
                                weight: 1,
                                firstAggrMet: false,
                                hasLavaCell: true,
                                hasWaterCell: false,
                            },
                        ],
                    ],
                ]),
            }),
        } as PathHelper;
        const weights = new Array(DEFAULT_V05_W.length).fill(0);
        weights[41] = 1;

        expect(combat.grid.areAllCellsEmpty(lavaFootprint, dragon.getId())).toBe(false);
        expect(combat.grid.canOccupyCells(lavaFootprint, false, false)).toBe(false);

        const actions = new StrategyV0_5(weights)["aoeMeleeByPolicy"](dragon, context, [
            {
                type: "melee_attack",
                attackerId: dragon.getId(),
                targetId: incumbentTarget.getId(),
                attackFrom: dragon.getBaseCell(),
            },
        ]);
        const attack = actions.find((action) => action.type === "melee_attack");

        expect(attack).toMatchObject({
            targetId: incumbentTarget.getId(),
            attackFrom: dragon.getBaseCell(),
        });
        expect(attack).not.toMatchObject({ attackFrom: lavaAttackFrom });
    });
});
