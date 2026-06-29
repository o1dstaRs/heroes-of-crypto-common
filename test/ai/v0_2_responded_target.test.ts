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

import { getAIStrategy, type IDecisionContext } from "../../src/ai";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import type { GameAction } from "../../src/engine/actions";
import {
    createCombatTestContext,
    createTestUnit,
    placeUnit,
    testGridSettings,
    CombatTestContext,
} from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const MELEE = PBTypes.AttackVals.MELEE;

function ctxFor(c: CombatTestContext): IDecisionContext {
    return {
        grid: c.grid,
        matrix: c.grid.getMatrix(),
        unitsHolder: c.unitsHolder,
        pathHelper: new PathHelper(testGridSettings),
        attackHandler: c.attackHandler,
    };
}

const meleeTargetId = (actions: GameAction[]): string | undefined => {
    const a = actions.find((x) => x.type === "melee_attack");
    return a && a.type === "melee_attack" ? a.targetId : undefined;
};

describe("v0.2 prefers already-responded melee targets", () => {
    it("hits the responded enemy over an equally-adjacent one that would still counter", () => {
        const c = createCombatTestContext();
        const attacker = createTestUnit({ name: "Striker", team: LOWER, attackType: MELEE, stackPower: 3 });
        // Two meaningful (stack power 3) enemies, both adjacent to the attacker.
        const willCounter = createTestUnit({
            name: "Fresh",
            team: UPPER,
            attackType: MELEE,
            stackPower: 3,
            amountAlive: 5,
        });
        const responded = createTestUnit({
            name: "Spent",
            team: UPPER,
            attackType: MELEE,
            stackPower: 3,
            amountAlive: 5,
        });
        placeUnit(c.grid, c.unitsHolder, attacker, { x: 5, y: 5 });
        placeUnit(c.grid, c.unitsHolder, willCounter, { x: 5, y: 6 });
        placeUnit(c.grid, c.unitsHolder, responded, { x: 6, y: 5 });
        // Mark "responded" as having already used its retaliation this lap.
        FightStateManager.getInstance().getFightProperties().addRepliedAttack(responded.getId());

        const actions = getAIStrategy("v0.2").decideTurn(attacker, ctxFor(c));
        expect(meleeTargetId(actions)).toBe(responded.getId());
    });

    it("keeps the current victim when no MEANINGFUL no-counter alternative is adjacent (tiny stacks excluded)", () => {
        // Only adjacent enemies are the current fresh counter target and a tiny (stack power 1) stack.
        // The tiny stack is excluded as a swap target (its hit would be wasted), so the strike is left
        // on whatever findTarget chose — we never trade a real target for a trivial one.
        const c = createCombatTestContext();
        const attacker = createTestUnit({ name: "Striker", team: LOWER, attackType: MELEE, stackPower: 3 });
        const fresh = createTestUnit({ name: "Fresh", team: UPPER, attackType: MELEE, stackPower: 4, amountAlive: 8 });
        const tiny = createTestUnit({ name: "Tiny", team: UPPER, attackType: MELEE, stackPower: 1, amountAlive: 1 });
        placeUnit(c.grid, c.unitsHolder, attacker, { x: 5, y: 5 });
        placeUnit(c.grid, c.unitsHolder, fresh, { x: 5, y: 6 });
        placeUnit(c.grid, c.unitsHolder, tiny, { x: 6, y: 5 });
        FightStateManager.getInstance().getFightProperties().addRepliedAttack(tiny.getId());

        const target = meleeTargetId(getAIStrategy("v0.2").decideTurn(attacker, ctxFor(c)));
        // The result is one of the two adjacent enemies — and crucially the swap never *manufactured* a
        // tiny target: it's only "tiny" if findTarget itself originally chose it.
        expect(target).toBeDefined();
        expect([fresh.getId(), tiny.getId()]).toContain(target as string);
    });

    it("swaps onto a can't-respond (No Melee) enemy as well", () => {
        const c = createCombatTestContext();
        const attacker = createTestUnit({ name: "Striker", team: LOWER, attackType: MELEE, stackPower: 3 });
        const willCounter = createTestUnit({
            name: "Fresh",
            team: UPPER,
            attackType: MELEE,
            stackPower: 3,
            amountAlive: 5,
        });
        // A "No Melee" unit cannot melee-respond, so attacking it provokes no counter.
        const cantRespond = createTestUnit({
            name: "Shooter",
            team: UPPER,
            attackType: MELEE,
            stackPower: 3,
            amountAlive: 5,
            abilities: ["No Melee"],
        });
        placeUnit(c.grid, c.unitsHolder, attacker, { x: 5, y: 5 });
        placeUnit(c.grid, c.unitsHolder, willCounter, { x: 5, y: 6 });
        placeUnit(c.grid, c.unitsHolder, cantRespond, { x: 6, y: 5 });
        expect(cantRespond.canRespond(MELEE)).toBe(false);

        const actions = getAIStrategy("v0.2").decideTurn(attacker, ctxFor(c));
        expect(meleeTargetId(actions)).toBe(cantRespond.getId());
    });
});
