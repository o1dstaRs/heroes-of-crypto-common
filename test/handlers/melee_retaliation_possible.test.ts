/*
 * -----------------------------------------------------------------------------
 * A Shadow Touch attacker is never retaliated against — "the unit's attacks are not
 * responded". The engine has always honoured it; the CLIENT could not ask, because it
 * infers a counter from the hit points the attacker lost during the action and the full
 * rule answers "no" for the wrong reason once a real counter has spent the defender's
 * response. meleeRetaliationEverPossible is the permanent half of that rule, so a Fairy's
 * strike can no longer have the Wolf it hit lunge back on screen over hit points lost to
 * something else entirely (owner report 2026-09-19).
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { canUnitRespondToMelee, meleeRetaliationEverPossible } from "../../src/handlers/melee_response";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const pair = (attackerAbilities: string[] = [], targetAbilities: string[] = []) => {
    const { grid, unitsHolder } = createCombatTestContext();
    const attacker = createTestUnit({
        name: "Fairy",
        team: PBTypes.TeamVals.LEFT,
        abilities: attackerAbilities,
        stackPower: 5,
    });
    const target = createTestUnit({
        name: "Wolf",
        team: PBTypes.TeamVals.RIGHT,
        abilities: targetAbilities,
        stackPower: 5,
    });
    placeUnit(grid, unitsHolder, attacker, { x: 3, y: 3 });
    placeUnit(grid, unitsHolder, target, { x: 4, y: 3 });
    return { attacker, target };
};

describe("melee retaliation, the permanent half", () => {
    it("a plain attacker may be retaliated against", () => {
        const { attacker, target } = pair();
        expect(meleeRetaliationEverPossible(attacker, target)).toBe(true);
        expect(canUnitRespondToMelee(attacker, target)).toBe(true);
    });

    it("Shadow Touch denies the counter outright", () => {
        const { attacker, target } = pair(["Shadow Touch"]);
        expect(meleeRetaliationEverPossible(attacker, target)).toBe(false);
        expect(canUnitRespondToMelee(attacker, target)).toBe(false);
    });

    it("a target that cannot fight in melee never counters", () => {
        const { attacker, target } = pair([], ["No Melee"]);
        expect(meleeRetaliationEverPossible(attacker, target)).toBe(false);
    });

    it("an Aggr lock pointing at someone else denies it, and one pointing here allows it", () => {
        const { attacker, target } = pair();
        target.setTarget("someone-else");
        expect(meleeRetaliationEverPossible(attacker, target)).toBe(false);
        target.setTarget(attacker.getId());
        expect(meleeRetaliationEverPossible(attacker, target)).toBe(true);
    });

    // The whole point of the split: a spent response is what the ACTION did, so the client must not read
    // it. The full rule still refuses, which is correct for the engine and wrong for a replay.
    it("a spent response stops the full rule but not the permanent half", () => {
        const { attacker, target } = pair();
        target.setResponded(true);
        expect(canUnitRespondToMelee(attacker, target)).toBe(false);
        expect(meleeRetaliationEverPossible(attacker, target)).toBe(true);
    });
});
