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

import { processLightningSpinAbility } from "../../src/abilities/lightning_spin_ability";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { createCombatTestContext, createTestUnit, DamageStatisticHolder, placeUnit } from "../helpers/combat";

describe("lightning spin branches", () => {
    it("runs the on-hit sub-ability chain when the enemy survives", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const stats = new DamageStatisticHolder();
        // Weak attacker so the enemy survives the spin → the else-branch (Miner/Stun/Petrify/... and
        // the Fire Shield reflection pass) runs instead of the kill path.
        const attacker = createTestUnit({
            name: "Spinner",
            team: PBTypes.TeamVals.UPPER,
            abilities: ["Lightning Spin"],
            attack: 1,
            damageMin: 1,
            damageMax: 1,
            amountAlive: 1,
            stackPower: 1,
        });
        // Fire Shield on the survivor exercises the post-loop reflection pass (morale + reflected
        // damage bookkeeping) in addition to the on-hit sub-ability chain.
        const survivor = createTestUnit({
            name: "Tank",
            team: PBTypes.TeamVals.LOWER,
            maxHp: 1000,
            amountAlive: 10,
            armor: 50,
            abilities: ["Fire Shield"],
        });

        placeUnit(grid, unitsHolder, attacker, { x: 5, y: 5 });
        placeUnit(grid, unitsHolder, survivor, { x: 5, y: 6 });

        const result = processLightningSpinAbility(
            attacker,
            new SceneLogMock(),
            unitsHolder,
            1,
            stats,
            { x: 5, y: 5 },
            true,
        );

        expect(result.landed).toBe(true);
        expect(survivor.isDead()).toBe(false);
        // The survivor took (and reflected) damage — at least one damage stat was recorded.
        expect(stats.get().length).toBeGreaterThanOrEqual(1);
    });

    it("runs in response mode (resp) against a surviving enemy", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const stats = new DamageStatisticHolder();
        const attacker = createTestUnit({
            name: "Spinner",
            team: PBTypes.TeamVals.UPPER,
            abilities: ["Lightning Spin"],
            attack: 1,
            damageMin: 1,
            damageMax: 1,
            amountAlive: 1,
        });
        const survivor = createTestUnit({ name: "Tank", team: PBTypes.TeamVals.LOWER, maxHp: 1000, amountAlive: 10 });

        placeUnit(grid, unitsHolder, attacker, { x: 5, y: 5 });
        placeUnit(grid, unitsHolder, survivor, { x: 5, y: 6 });

        // isAttack = false → response path (actionString "resp", Blindness branch, One In The Field).
        const result = processLightningSpinAbility(
            attacker,
            new SceneLogMock(),
            unitsHolder,
            0,
            stats,
            { x: 5, y: 5 },
            false,
        );

        expect(result.landed).toBe(true);
        expect(survivor.isDead()).toBe(false);
    });

    it("no-ops for a unit without the Lightning Spin ability", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const stats = new DamageStatisticHolder();
        const plain = createTestUnit({ name: "Plain", team: PBTypes.TeamVals.UPPER });
        const enemy = createTestUnit({ name: "Enemy", team: PBTypes.TeamVals.LOWER });
        placeUnit(grid, unitsHolder, plain, { x: 5, y: 5 });
        placeUnit(grid, unitsHolder, enemy, { x: 5, y: 6 });

        const result = processLightningSpinAbility(
            plain,
            new SceneLogMock(),
            unitsHolder,
            0,
            stats,
            { x: 5, y: 5 },
            true,
        );
        expect(result.landed).toBe(false);
        expect(result.unitIdsDied).toEqual([]);
    });
});
