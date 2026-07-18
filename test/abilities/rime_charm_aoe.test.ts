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

import { processRangeAOEAbility } from "../../src/abilities/aoe_range_ability";
import { processLightningSpinAbility } from "../../src/abilities/lightning_spin_ability";
import { processSkewerStrikeAbility } from "../../src/abilities/skewer_strike_ability";
import { processThroughShotAbility } from "../../src/abilities/through_shot_ability";
import { getSpellConfig } from "../../src/configuration/config_provider";
import { NUMBER_OF_LAPS_TOTAL } from "../../src/constants";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Spell } from "../../src/spells/spell";
import { Unit } from "../../src/units/unit";
import { createCombatTestContext, createTestUnit, DamageStatisticHolder, placeUnit } from "../helpers/combat";

// The ARTIFACT Rime Charm slow must proc from physical AOE attacks (their SECONDARY/splash targets), not
// only the primary single-target hit: Large Caliber (Cyclops / Tsar Cannon), Area Throw (Gargantuan),
// Skewer Strike (Pikeman) and Lightning Spin (Hydra) — plus Through Shot. Each handler now runs
// processRimeCharmAbility on every unit it damages, alongside the existing Stun proc.

// A 100%-power Rime Charm buff + the deterministic minimum RNG below => the chill always lands.
function giveRimeCharm(unit: Unit): void {
    const rime = new Spell({
        spellProperties: getSpellConfig("System", "Rime Charm", NUMBER_OF_LAPS_TOTAL),
        amount: 1,
    });
    rime.setPower(100);
    unit.applyBuff(rime, 100, 3);
}

function tank(name: string): Unit {
    return createTestUnit({ name, team: PBTypes.TeamVals.LOWER, amountAlive: 20, maxHp: 1000, armor: 10 });
}

function installMinimumRandom(): () => void {
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    // Minimum RNG (all-zero rolls) so a 100%-power buff always procs — but keep unit-id (16-byte UUID)
    // requests UNIQUE via an incrementing seed, or every test unit collides on the same all-zero id and
    // the position-lookup abilities (Lightning Spin / Skewer Strike) find no targets.
    let uuidSeed = 1;
    const cryptoMock = {
        getRandomValues<T extends ArrayBufferView>(array: T): T {
            const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
            bytes.fill(0);
            if (bytes.length === 16) {
                let value = uuidSeed++;
                for (let i = bytes.length - 1; i >= 0 && value > 0; i--) {
                    bytes[i] = value & 0xff;
                    value >>= 8;
                }
            }
            return array;
        },
    };
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: cryptoMock });
    return () => {
        if (originalDescriptor) {
            Object.defineProperty(globalThis, "crypto", originalDescriptor);
        } else {
            Reflect.deleteProperty(globalThis, "crypto");
        }
    };
}

describe("Rime Charm procs its slow from physical AOE", () => {
    let restoreRandom: (() => void) | undefined;
    beforeEach(() => {
        restoreRandom = installMinimumRandom();
    });
    afterEach(() => {
        restoreRandom?.();
        restoreRandom = undefined;
    });

    it("Large Caliber / Area Throw chills every splash target (Cyclops, Gargantuan, Tsar Cannon)", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const attacker = createTestUnit({
            name: "Cannon",
            team: PBTypes.TeamVals.UPPER,
            attackType: PBTypes.AttackVals.RANGE,
            abilities: ["Large Caliber"],
            attack: 40,
            damageMin: 100,
            damageMax: 100,
            rangeShots: 2,
            stackPower: 100,
        });
        giveRimeCharm(attacker);
        const a = tank("A");
        const b = tank("B");
        placeUnit(grid, unitsHolder, attacker, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, a, { x: 7, y: 7 });
        placeUnit(grid, unitsHolder, b, { x: 7, y: 8 });

        processRangeAOEAbility(
            attacker,
            [a, b],
            attacker,
            1,
            unitsHolder,
            grid,
            new SceneLogMock(),
            new DamageStatisticHolder(),
            true,
        );

        expect(a.hasDebuffActive("Quagmire")).toBe(true);
        expect(b.hasDebuffActive("Quagmire")).toBe(true);
    });

    it("Lightning Spin chills every surrounding enemy (Hydra)", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const attacker = createTestUnit({
            name: "Hydra",
            team: PBTypes.TeamVals.UPPER,
            abilities: ["Lightning Spin"],
            attack: 40,
            damageMin: 100,
            damageMax: 100,
            stackPower: 100,
        });
        giveRimeCharm(attacker);
        const a = tank("A");
        const b = tank("B");
        placeUnit(grid, unitsHolder, attacker, { x: 5, y: 5 });
        placeUnit(grid, unitsHolder, a, { x: 5, y: 6 });
        placeUnit(grid, unitsHolder, b, { x: 6, y: 5 });

        processLightningSpinAbility(
            attacker,
            new SceneLogMock(),
            unitsHolder,
            1,
            new DamageStatisticHolder(),
            { x: 5, y: 5 },
            true,
        );

        expect(a.hasDebuffActive("Quagmire")).toBe(true);
        expect(b.hasDebuffActive("Quagmire")).toBe(true);
    });

    it("Skewer Strike chills the unit pierced behind the primary (Pikeman)", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const attacker = createTestUnit({
            name: "Pikeman",
            team: PBTypes.TeamVals.UPPER,
            abilities: ["Skewer Strike"],
            attack: 40,
            damageMin: 100,
            damageMax: 100,
            stackPower: 100,
        });
        giveRimeCharm(attacker);
        const primary = tank("Primary");
        const behind = tank("Behind");
        placeUnit(grid, unitsHolder, attacker, { x: 5, y: 7 });
        placeUnit(grid, unitsHolder, primary, { x: 5, y: 5 });
        placeUnit(grid, unitsHolder, behind, { x: 5, y: 3 });

        processSkewerStrikeAbility(
            attacker,
            primary,
            new SceneLogMock(),
            unitsHolder,
            grid,
            new DamageStatisticHolder(),
        );

        expect(behind.hasDebuffActive("Quagmire")).toBe(true);
    });

    it("Through Shot chills the unit pierced behind the target", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const attacker = createTestUnit({
            name: "Piercer",
            team: PBTypes.TeamVals.UPPER,
            attackType: PBTypes.AttackVals.RANGE,
            abilities: ["Through Shot"],
            attack: 40,
            damageMin: 100,
            damageMax: 100,
            rangeShots: 2,
            stackPower: 100,
        });
        giveRimeCharm(attacker);
        const front = tank("Front");
        const rear = tank("Rear");
        placeUnit(grid, unitsHolder, attacker, { x: 5, y: 9 });
        placeUnit(grid, unitsHolder, front, { x: 5, y: 7 });
        placeUnit(grid, unitsHolder, rear, { x: 5, y: 5 });

        processThroughShotAbility(
            attacker,
            [[front], [rear], []],
            attacker,
            [1, 1, 1],
            rear.getPosition(),
            unitsHolder,
            grid,
            new SceneLogMock(),
            new DamageStatisticHolder(),
        );

        expect(rear.hasDebuffActive("Quagmire")).toBe(true);
    });
});
