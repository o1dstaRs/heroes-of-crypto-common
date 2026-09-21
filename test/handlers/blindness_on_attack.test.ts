/*
 * -----------------------------------------------------------------------------
 * Blindness is a two-way on-hit rider: the Unicorn blinds the enemy it strikes,
 * not only the enemy that strikes it. Regression: processBlindnessAbility was
 * wired into the melee RESPONSE path alone, so a Unicorn that opened the
 * exchange never blinded anything and the ability only paid off on defence.
 * -----------------------------------------------------------------------------
 */

import { afterEach, describe, expect, it } from "bun:test";

import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler } from "../../src/handlers/move_handler";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import {
    createCombatTestContext,
    createTestUnit,
    createVisibleDamage,
    placeUnit,
    testGridSettings,
} from "../helpers/combat";

// RNG pinned to 0 makes the check fully discriminating: the blindness roll (0 < chance) always LANDS
// once the rider is processed, and no unit here has a dodge source so nothing ever misses.
const pinRng = (): void => setDeterministicRandomSource(() => 0);

const makeUnicorn = (team = PBTypes.TeamVals.LEFT) =>
    createTestUnit({
        name: "Unicorn",
        team,
        attackType: PBTypes.AttackVals.MELEE,
        attack: 10,
        damageMin: 5,
        damageMax: 5,
        amountAlive: 3,
        luck: 40,
        abilities: ["Blindness"],
    });

const makeVictim = (team = PBTypes.TeamVals.RIGHT) =>
    createTestUnit({
        name: "Griffin",
        team,
        attackType: PBTypes.AttackVals.MELEE,
        maxHp: 400,
        amountAlive: 5,
    });

describe("Blindness rides the attack as well as the response", () => {
    afterEach(() => {
        setDeterministicRandomSource(undefined);
    });

    it("blinds the target the Unicorn attacks", () => {
        pinRng();
        const { grid, unitsHolder, attackHandler } = createCombatTestContext();
        const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
        const unicorn = makeUnicorn();
        const victim = makeVictim();

        placeUnit(grid, unitsHolder, victim, { x: 4, y: 3 });
        placeUnit(grid, unitsHolder, unicorn, { x: 5, y: 3 });

        const result = attackHandler.handleMeleeAttack(
            unitsHolder,
            moveHandler,
            createVisibleDamage(victim),
            undefined,
            unicorn,
            victim,
            { x: 5, y: 3 },
        );

        expect(result.completed).toBe(true);
        expect(victim.getEffects().map((e) => e.getName())).toContain("Blindness");
    });

    it("still blinds the attacker it responds to", () => {
        pinRng();
        const { grid, unitsHolder, attackHandler } = createCombatTestContext();
        const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
        // Roles swapped: the Unicorn is the one being hit, so only the response path can blind.
        const aggressor = makeVictim(PBTypes.TeamVals.LEFT);
        const unicorn = makeUnicorn(PBTypes.TeamVals.RIGHT);

        placeUnit(grid, unitsHolder, unicorn, { x: 4, y: 3 });
        placeUnit(grid, unitsHolder, aggressor, { x: 5, y: 3 });

        const result = attackHandler.handleMeleeAttack(
            unitsHolder,
            moveHandler,
            createVisibleDamage(unicorn),
            undefined,
            aggressor,
            unicorn,
            { x: 5, y: 3 },
        );

        expect(result.completed).toBe(true);
        expect(aggressor.getEffects().map((e) => e.getName())).toContain("Blindness");
    });
});
