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

import { AIActionType, findTarget } from "../../src/ai/ai";
import { createDecisionPathCatalog } from "../../src/ai/decision_path_catalog";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;
const MELEE = PBTypes.AttackVals.MELEE;

const pathHelper = new PathHelper(testGridSettings);

describe("Backstab (Scavenger) AI positioning", () => {
    for (const team of [LEFT, RIGHT]) {
        for (const sideOriented of [false, true]) {
            for (const cached of [false, true]) {
                it(`keeps a fractional-budget backstab engine-reachable (team ${team}, side ${sideOriented}, cached ${cached})`, () => {
                    const { grid, unitsHolder } = createCombatTestContext();
                    FightStateManager.getInstance().getFightProperties().setSideOrientedPlacement(sideOriented);
                    const enemyTeam = team === LEFT ? RIGHT : LEFT;
                    // Reduced geometry of the native invalid-move case: the raw four-step route can reach
                    // the far side, but enemy threat makes it cost six against a 4.3-step budget. Mirror
                    // teams and rotate axes so the legal fallback is not tied to one board orientation.
                    const orient = ({ x, y }: XY): XY => {
                        const advance = team === RIGHT ? x : 15 - x;
                        return sideOriented ? { x: advance, y } : { x: y, y: advance };
                    };
                    const scavenger = createTestUnit({ name: "Scavenger", team, abilities: ["Backstab"] });
                    Object.assign(scavenger.getUnitProperties(), { steps: 4.3, steps_mod: 0 });
                    const prey = createTestUnit({ name: "Prey", team: enemyTeam });
                    const ally = createTestUnit({ name: "Ally", team });
                    placeUnit(grid, unitsHolder, scavenger, orient({ x: 8, y: 6 }));
                    placeUnit(grid, unitsHolder, prey, orient({ x: 5, y: 7 }));
                    placeUnit(grid, unitsHolder, ally, orient({ x: 6, y: 7 }));
                    const matrix = grid.getMatrix();
                    const source = cached ? createDecisionPathCatalog(grid, pathHelper, scavenger, matrix) : pathHelper;
                    const action = findTarget(scavenger, grid, matrix, unitsHolder, source);
                    const reachable = pathHelper.getMovePath(
                        scavenger.getBaseCell(),
                        matrix,
                        scavenger.getSteps(),
                        grid.getAggrMatrixByTeam(enemyTeam),
                    ).knownPaths;

                    expect(action?.actionType()).toBe(AIActionType.MOVE_AND_MELEE_ATTACK);
                    expect(action?.cellToAttack()).toEqual(prey.getBaseCell());
                    const destination = action!.cellToMove()!;
                    const nativeRoutes = reachable.get((destination.x << 4) | destination.y);
                    expect(nativeRoutes).toBeDefined();
                    expect(nativeRoutes![0].weight).toBeLessThanOrEqual(scavenger.getSteps());
                    expect(action!.currentActiveKnownPaths().get((destination.x << 4) | destination.y)).toEqual(
                        nativeRoutes,
                    );
                });
            }
        }
    }

    it("reroutes a LEFT-team Scavenger to strike from below the target (higher y)", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        // Scavenger is adjacent to the enemy on the NON-backstab side (above it, lower y). For a LEFT
        // attacker the bonus needs y > target.y, so it should circle to a cell below the enemy.
        const scavenger = createTestUnit({
            name: "Scavenger",
            team: LEFT,
            attackType: MELEE,
            abilities: ["Backstab"],
        });
        // Circling an adjacent enemy spends threat-weighted movement too; fund this positive case.
        Object.assign(scavenger.getUnitProperties(), { steps: 5 });
        const enemy = createTestUnit({ name: "Prey", team: RIGHT, attackType: MELEE });
        placeUnit(grid, unitsHolder, scavenger, { x: 6, y: 4 });
        placeUnit(grid, unitsHolder, enemy, { x: 5, y: 5 });

        const action = findTarget(scavenger, grid, grid.getMatrix(), unitsHolder, pathHelper);
        expect(action).toBeDefined();
        expect(action?.actionType()).toBe(AIActionType.MOVE_AND_MELEE_ATTACK);
        expect(action?.cellToAttack()).toEqual({ x: 5, y: 5 });
        // Stand cell is on the backstab side: below the target (y > 5).
        expect(action!.cellToMove()!.y).toBeGreaterThan(5);
        const cell = action!.cellToMove()!;
        const route = pathHelper
            .getMovePath(
                scavenger.getBaseCell(),
                grid.getMatrix(),
                scavenger.getSteps(),
                grid.getAggrMatrixByTeam(RIGHT),
            )
            .knownPaths.get((cell.x << 4) | cell.y)?.[0];
        expect(route).toBeDefined();
        expect(route!.weight).toBeLessThanOrEqual(scavenger.getSteps());
    });

    it("reroutes a RIGHT-team Scavenger to strike from above the target (lower y)", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const scavenger = createTestUnit({
            name: "Scavenger",
            team: RIGHT,
            attackType: MELEE,
            abilities: ["Backstab"],
        });
        Object.assign(scavenger.getUnitProperties(), { steps: 5 });
        const enemy = createTestUnit({ name: "Prey", team: LEFT, attackType: MELEE });
        // Adjacent on the non-backstab side (below the enemy). RIGHT needs y < target.y → circle above.
        placeUnit(grid, unitsHolder, scavenger, { x: 6, y: 6 });
        placeUnit(grid, unitsHolder, enemy, { x: 5, y: 5 });

        const action = findTarget(scavenger, grid, grid.getMatrix(), unitsHolder, pathHelper);
        expect(action?.actionType()).toBe(AIActionType.MOVE_AND_MELEE_ATTACK);
        expect(action!.cellToMove()!.y).toBeLessThan(5);
        const cell = action!.cellToMove()!;
        const route = pathHelper
            .getMovePath(
                scavenger.getBaseCell(),
                grid.getMatrix(),
                scavenger.getSteps(),
                grid.getAggrMatrixByTeam(LEFT),
            )
            .knownPaths.get((cell.x << 4) | cell.y)?.[0];
        expect(route).toBeDefined();
        expect(route!.weight).toBeLessThanOrEqual(scavenger.getSteps());
    });

    for (const team of [LEFT, RIGHT]) {
        it(`keeps an adjacent strike when the weighted backstab is unaffordable (team ${team})`, () => {
            const { grid, unitsHolder } = createCombatTestContext();
            const scavenger = createTestUnit({ name: "Scavenger", team, abilities: ["Backstab"] });
            const enemy = createTestUnit({ name: "Prey", team: team === LEFT ? RIGHT : LEFT });
            const base = { x: 6, y: team === LEFT ? 4 : 6 };
            placeUnit(grid, unitsHolder, scavenger, base);
            placeUnit(grid, unitsHolder, enemy, { x: 5, y: 5 });

            const action = findTarget(scavenger, grid, grid.getMatrix(), unitsHolder, pathHelper);
            expect(action?.actionType()).toBe(AIActionType.MELEE_ATTACK);
            expect(action?.cellToMove()).toEqual(base);
            expect(action?.cellToAttack()).toEqual(enemy.getBaseCell());
        });
    }

    it("does not reroute a unit without Backstab", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const plain = createTestUnit({ name: "Grunt", team: LEFT, attackType: MELEE });
        const enemy = createTestUnit({ name: "Prey", team: RIGHT, attackType: MELEE });
        placeUnit(grid, unitsHolder, plain, { x: 6, y: 4 });
        placeUnit(grid, unitsHolder, enemy, { x: 5, y: 5 });

        const action = findTarget(plain, grid, grid.getMatrix(), unitsHolder, pathHelper);
        // Already adjacent → it just melees in place from its current (non-backstab) cell.
        expect(action?.actionType()).toBe(AIActionType.MELEE_ATTACK);
        expect(action?.cellToMove()).toEqual({ x: 6, y: 4 });
    });

    it("keeps striking in place when already on the backstab side", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const scavenger = createTestUnit({
            name: "Scavenger",
            team: LEFT,
            attackType: MELEE,
            abilities: ["Backstab"],
        });
        const enemy = createTestUnit({ name: "Prey", team: RIGHT, attackType: MELEE });
        // Already below the enemy (y=6 > 5) → backstab already satisfied, no repositioning.
        placeUnit(grid, unitsHolder, scavenger, { x: 5, y: 6 });
        placeUnit(grid, unitsHolder, enemy, { x: 5, y: 5 });

        const action = findTarget(scavenger, grid, grid.getMatrix(), unitsHolder, pathHelper);
        expect(action?.actionType()).toBe(AIActionType.MELEE_ATTACK);
        expect(action?.cellToMove()).toEqual({ x: 5, y: 6 });
    });
});
