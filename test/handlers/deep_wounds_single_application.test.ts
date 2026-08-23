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

import { processDoublePunchAbility } from "../../src/abilities/double_punch_ability";
import { projectAttackDamage } from "../../src/damage/damage_projection";
import { EffectFactory } from "../../src/effects/effect_factory";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import type { Unit } from "../../src/units/unit";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import {
    createCombatTestContext,
    createTestUnit,
    createVisibleDamage,
    placeUnit,
    testGridSettings,
} from "../helpers/combat";

/**
 * REGRESSION (engine defect): Deep Wounds used to be applied TWICE on every melee hit.
 *
 * AttackHandler folded `1 + power/100` into the abilityMultiplier it handed to calculateAttackDamage, and
 * calculateAttackDamage re-derived the very same multiplier from the victim's effect and multiplied it in
 * again — so damage scaled as base * (1 + p/100)^2. At power 63 a measured 82-damage swing landed for 132
 * (+61%). processDoublePunchAbility carried the same duplicate, squaring it on the second punch as well.
 *
 * Unit.calculateAttackDamage is the single owner now (the term lives in damage/damage_projection's chain),
 * which is what lets a hover project the number the engine will actually deal.
 */

const RED = PBTypes.TeamVals.UPPER;
const GREEN = PBTypes.TeamVals.LOWER;
const MELEE = PBTypes.AttackVals.MELEE;

/** The powers the differential measurement swept, plus 0 as the control. */
const DEEP_WOUNDS_POWERS = [6, 13, 21, 30, 42, 63] as const;

const applyDeepWoundsEffect = (unit: Unit, power: number): void => {
    const effect = new EffectFactory().makeEffect("Deep Wounds");
    if (!effect) {
        throw new Error("Deep Wounds effect config is missing");
    }
    effect.setPower(power);
    unit.applyEffect(effect);
    expect(unit.getEffect("Deep Wounds")?.getPower()).toBe(power);
};

const makeAttacker = (abilities: string[]): Unit => {
    const attacker = createTestUnit({
        name: "Wounder",
        team: RED,
        attackType: MELEE,
        attack: 10,
        damageMin: 7,
        damageMax: 7,
        amountAlive: 5,
        stackPower: 5,
        maxHp: 100_000,
        abilities,
    });
    // Take the miss roll out of the comparison entirely; this test is about the damage product.
    attacker.calculateMissChance = () => 0;
    return attacker;
};

/** A wall: it must survive every swing so the HP delta IS the damage the engine dealt. */
const makeTarget = (deepWoundsPower: number): Unit => {
    const target = createTestUnit({
        name: "Wounded",
        team: GREEN,
        attackType: MELEE,
        armor: 7,
        attack: 1,
        damageMin: 1,
        damageMax: 1,
        maxHp: 100_000,
        amountAlive: 4,
    });
    if (deepWoundsPower > 0) {
        applyDeepWoundsEffect(target, deepWoundsPower);
    }
    return target;
};

/** One melee swing driven end to end through AttackHandler; returns the victim's cumulative-HP loss. */
const strikeThroughHandler = (attacker: Unit, target: Unit): number => {
    const { grid, unitsHolder, attackHandler } = createCombatTestContext();
    const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
    placeUnit(grid, unitsHolder, target, { x: 4, y: 3 });
    placeUnit(grid, unitsHolder, attacker, { x: 5, y: 3 });

    const hpBefore = target.getCumulativeHp();
    const result = attackHandler.handleMeleeAttack(
        unitsHolder,
        moveHandler,
        createVisibleDamage(target),
        undefined,
        attacker,
        target,
        { x: 5, y: 3 },
    );
    expect(result.completed).toBe(true);

    return hpBefore - target.getCumulativeHp();
};

describe("Deep Wounds is applied exactly once on the melee path", () => {
    afterEach(() => setDeterministicRandomSource(undefined));

    it("amplifies a swing by (1 + power/100), never by its square", () => {
        setDeterministicRandomSource(() => 0);

        const baseline = strikeThroughHandler(makeAttacker(["Deep Wounds Level 3"]), makeTarget(0));
        expect(baseline).toBeGreaterThan(0);

        for (const power of DEEP_WOUNDS_POWERS) {
            const target = makeTarget(power);
            const dealt = strikeThroughHandler(makeAttacker(["Deep Wounds Level 3"]), target);

            const amplifiedOnce = Math.floor(baseline * (1 + power / 100));
            const amplifiedTwice = Math.floor(baseline * (1 + power / 100) * (1 + power / 100));
            // The two candidates must actually differ, or the assertion below proves nothing.
            expect({ power, differ: amplifiedTwice > amplifiedOnce }).toEqual({ power, differ: true });
            expect({ power, dealt }).toEqual({ power, dealt: amplifiedOnce });
        }
    });

    it("deals exactly what the shared projection predicts, at every power", () => {
        setDeterministicRandomSource(() => 0);

        for (const power of DEEP_WOUNDS_POWERS) {
            const attacker = makeAttacker(["Deep Wounds Level 3"]);
            const target = makeTarget(power);
            // Projected BEFORE the swing: the handler's riders stack more Deep Wounds onto the victim
            // afterwards, so the post-hit state is no longer the state this hit was priced against.
            const projected = projectAttackDamage({
                attacker,
                target,
                attackType: MELEE,
                synergyAbilityPowerIncrease: 0,
            });

            expect({ power, dealt: strikeThroughHandler(attacker, target) }).toEqual({
                power,
                dealt: projected.min,
            });
        }
    });

    it("is ignored for an attacker that inflicts no Deep Wounds at all", () => {
        setDeterministicRandomSource(() => 0);

        const plainBaseline = strikeThroughHandler(makeAttacker([]), makeTarget(0));
        const plainVsWounded = strikeThroughHandler(makeAttacker([]), makeTarget(63));
        expect(plainVsWounded).toBe(plainBaseline);
    });

    it("does not square it on Double Punch's second hit either", () => {
        setDeterministicRandomSource(() => 0);
        createCombatTestContext();

        const attacker = makeAttacker(["Double Punch", "Deep Wounds Level 3"]);
        const doublePunch = attacker.getAbility("Double Punch");
        expect(doublePunch).toBeDefined();
        const secondPunchMultiplier = attacker.calculateAbilityMultiplier(doublePunch!, 0);
        expect(secondPunchMultiplier).toBeGreaterThan(0);

        for (const power of DEEP_WOUNDS_POWERS) {
            const target = makeTarget(power);
            const projected = projectAttackDamage({
                attacker,
                target,
                attackType: MELEE,
                synergyAbilityPowerIncrease: 0,
                abilityMultiplier: secondPunchMultiplier,
            });
            // The pre-fix number, reconstructed: the ability folded (1 + p/100) into its own multiplier and
            // calculateAttackDamage applied the very same factor again on top of it.
            const squared = projectAttackDamage({
                attacker,
                target,
                attackType: MELEE,
                synergyAbilityPowerIncrease: 0,
                abilityMultiplier: secondPunchMultiplier * (1 + power / 100),
            }).min;
            expect(squared).toBeGreaterThan(projected.min);

            const result = processDoublePunchAbility(attacker, target, new SceneLogMock());
            expect({ power, applied: result.applied, missed: result.missed }).toEqual({
                power,
                applied: true,
                missed: false,
            });
            expect({ power, damage: result.damage }).toEqual({ power, damage: projected.min });
            expect({ power, damage: result.damage }).not.toEqual({ power, damage: squared });
        }
    });
});
