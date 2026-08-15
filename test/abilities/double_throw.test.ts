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

import { getDoubleShotAbility, hasDoubleShotAbility } from "../../src/abilities/ability_helper";
import { processDoubleShotAbility } from "../../src/abilities/double_shot_ability";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import {
    createCombatTestContext,
    createTestUnit,
    createVisibleDamage,
    DamageStatisticHolder,
    placeUnit,
} from "../helpers/combat";

const setUpThrow = (targetAbilities: string[] = []) => {
    const { grid, unitsHolder } = createCombatTestContext();
    const gargantuan = createTestUnit({
        name: "Gargantuan",
        team: PBTypes.TeamVals.LOWER,
        attackType: PBTypes.AttackVals.RANGE,
        abilities: ["Double Throw", "Area Throw"],
        attack: 20,
        damageMin: 10,
        damageMax: 10,
        rangeShots: 3,
        stackPower: 20,
    });
    const target = createTestUnit({
        name: "Target",
        team: PBTypes.TeamVals.UPPER,
        abilities: targetAbilities,
        amountAlive: 100,
        maxHp: 100,
        armor: 0,
        stackPower: 100,
    });

    placeUnit(grid, unitsHolder, gargantuan, { x: 2, y: 2 });
    placeUnit(grid, unitsHolder, target, { x: 7, y: 7 });

    const fireSecondBoulder = () =>
        processDoubleShotAbility(
            gargantuan,
            target,
            [target],
            new SceneLogMock(),
            unitsHolder,
            grid,
            1,
            target.getPosition(),
            createVisibleDamage(target),
            new DamageStatisticHolder(),
            true,
        );

    return { fireSecondBoulder, gargantuan, target };
};

describe("Gargantuan Double Throw", () => {
    afterEach(() => setDeterministicRandomSource(undefined));

    it("routes the full-power second boulder through the ranged second-shot path", () => {
        setDeterministicRandomSource(() => 0);
        const { fireSecondBoulder, gargantuan, target } = setUpThrow();
        const ability = getDoubleShotAbility(gargantuan);
        const hpBefore = target.getCumulativeHp();

        expect(ability?.getName()).toBe("Double Throw");
        expect(hasDoubleShotAbility(gargantuan)).toBe(true);
        expect(gargantuan.calculateAbilityMultiplier(ability!, 0)).toBe(1);

        const result = fireSecondBoulder();
        expect(result.applied).toBe(true);
        expect(result.animationData).toHaveLength(1);
        expect(result.damage).toBeGreaterThan(0);
        expect(target.getCumulativeHp()).toBeLessThan(hpBefore);
    });

    it("still emits the second-boulder animation when that throw misses", () => {
        setDeterministicRandomSource(() => 0);
        const { fireSecondBoulder, target } = setUpThrow(["Dodge"]);
        const hpBefore = target.getCumulativeHp();

        const result = fireSecondBoulder();
        expect(result.applied).toBe(false);
        expect(result.animationData).toHaveLength(1);
        expect(result.animationData[0].affectedUnit).toBe(target);
        expect(target.getCumulativeHp()).toBe(hpBefore);
    });
});
