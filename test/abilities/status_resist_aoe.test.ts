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
import { processFireBreathAbility } from "../../src/abilities/fire_breath_ability";
import { processChainLightningAbility } from "../../src/abilities/chain_lightning_ability";
import { getSpellConfig } from "../../src/configuration/config_provider";
import { NUMBER_OF_LAPS_TOTAL } from "../../src/constants";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Spell } from "../../src/spells/spell";
import { Unit } from "../../src/units/unit";
import { createCombatTestContext, createTestUnit, DamageStatisticHolder, placeUnit } from "../helpers/combat";

// Status resistance (Amulet of Resolve) hardens a unit against PHYSICAL AOE damage. The engine applies it in
// every physical-AOE handler via Unit.getPhysicalAoeDamageMultiplier(). These tests fire each ability at a
// tanky target and compare damage dealt with/without 25% status resist (and, for physical, a -50 Mechanism).
// Magic AOE (Fire Breath / Chain Lightning) must be UNAFFECTED — it goes through magic resist instead.

const RESIST_PCT = 25;

function giveStatusResist(unit: Unit, percent: number): void {
    const amulet = new Spell({
        spellProperties: getSpellConfig("System", "Amulet of Resolve", NUMBER_OF_LAPS_TOTAL),
        amount: 1,
    });
    amulet.setPower(percent);
    unit.applyBuff(amulet);
}

function damageTo(units: Unit[]): number {
    return units.reduce((sum, u) => sum + (u.getCumulativeMaxHp() - u.getCumulativeHp()), 0);
}

type Variant = "plain" | "resist" | "mechanism";

describe("status resist reduces physical AOE damage (and never magic AOE)", () => {
    let restoreRandom: (() => void) | undefined;
    beforeEach(() => {
        restoreRandom = installMinimumRandom();
    });
    afterEach(() => {
        restoreRandom?.();
        restoreRandom = undefined;
    });

    // Builds a fresh enemy target with fixed, deterministic bulk so damage is never clamped by death.
    function enemy(name: string, variant: Variant, extraAbilities: string[] = []): Unit {
        const abilities = variant === "mechanism" ? [...extraAbilities, "Mechanism"] : extraAbilities;
        const u = createTestUnit({
            name,
            team: PBTypes.TeamVals.LOWER,
            amountAlive: 20,
            maxHp: 1000,
            armor: 10,
            abilities,
        });
        if (variant === "resist") {
            giveStatusResist(u, RESIST_PCT);
        }
        return u;
    }

    // ---- physical-AOE damage runners (one per handler) -------------------------------------------------

    function runAreaThrow(variant: Variant, abilityName: "Area Throw" | "Large Caliber"): number {
        const { grid, unitsHolder } = createCombatTestContext();
        const attacker = createTestUnit({
            name: "Thrower",
            team: PBTypes.TeamVals.UPPER,
            attackType: PBTypes.AttackVals.RANGE,
            abilities: [abilityName],
            attack: 40,
            damageMin: 100,
            damageMax: 100,
            rangeShots: 2,
            stackPower: 100,
        });
        const a = enemy("A", variant);
        const b = enemy("B", variant);
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
        return damageTo([a, b]);
    }

    function runLightningSpin(variant: Variant): number {
        const { grid, unitsHolder } = createCombatTestContext();
        const attacker = createTestUnit({
            name: "Spinner",
            team: PBTypes.TeamVals.UPPER,
            abilities: ["Lightning Spin"],
            attack: 40,
            damageMin: 100,
            damageMax: 100,
            stackPower: 100,
        });
        const a = enemy("A", variant);
        const b = enemy("B", variant);
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
        return damageTo([a, b]);
    }

    function runSkewerStrike(variant: Variant): number {
        const { grid, unitsHolder } = createCombatTestContext();
        const attacker = createTestUnit({
            name: "Skewer",
            team: PBTypes.TeamVals.UPPER,
            abilities: ["Skewer Strike"],
            attack: 40,
            damageMin: 100,
            damageMax: 100,
            stackPower: 100,
        });
        const primary = enemy("Primary", variant);
        const behind = enemy("Behind", variant);
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
        return damageTo([primary, behind]);
    }

    function runThroughShot(variant: Variant): number {
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
        const front = enemy("Front", variant);
        const rear = enemy("Rear", variant);
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
        return damageTo([front, rear]);
    }

    // ---- magic-AOE damage runners (must be unaffected by status resist) --------------------------------

    function runFireBreath(variant: Variant): number {
        const { grid, unitsHolder } = createCombatTestContext();
        const attacker = createTestUnit({
            name: "Dragon",
            team: PBTypes.TeamVals.UPPER,
            abilities: ["Fire Breath"],
            attack: 40,
            damageMin: 100,
            damageMax: 100,
            stackPower: 100,
        });
        const primary = enemy("Primary", variant);
        const behind = enemy("Behind", variant);
        placeUnit(grid, unitsHolder, attacker, { x: 5, y: 7 });
        placeUnit(grid, unitsHolder, primary, { x: 5, y: 5 });
        placeUnit(grid, unitsHolder, behind, { x: 5, y: 3 });
        processFireBreathAbility(
            attacker,
            primary,
            new SceneLogMock(),
            unitsHolder,
            grid,
            "attk",
            new DamageStatisticHolder(),
        );
        return damageTo([primary, behind]);
    }

    function runChainLightning(variant: Variant): number {
        const { grid, unitsHolder } = createCombatTestContext();
        const attacker = createTestUnit({
            name: "Storm",
            team: PBTypes.TeamVals.UPPER,
            abilities: ["Chain Lightning"],
            attack: 40,
            damageMin: 100,
            damageMax: 100,
            stackPower: 100,
        });
        const primary = enemy("Primary", variant);
        const l1 = enemy("L1", variant);
        const l2 = enemy("L2", variant);
        placeUnit(grid, unitsHolder, attacker, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, primary, { x: 5, y: 5 });
        placeUnit(grid, unitsHolder, l1, { x: 5, y: 6 });
        placeUnit(grid, unitsHolder, l2, { x: 6, y: 6 });
        processChainLightningAbility(
            attacker,
            primary,
            400,
            grid,
            unitsHolder,
            new SceneLogMock(),
            new DamageStatisticHolder(),
        );
        return damageTo([primary, l1, l2]);
    }

    const PHYSICAL: Array<[string, (v: Variant) => number]> = [
        ["Area Throw (Gargantuan)", (v) => runAreaThrow(v, "Area Throw")],
        ["Large Caliber (Cyclops)", (v) => runAreaThrow(v, "Large Caliber")],
        ["Lightning Spin (Hydra)", runLightningSpin],
        ["Skewer Strike (Pikeman)", runSkewerStrike],
        ["Through Shot (Tsar Cannon)", runThroughShot],
    ];

    it.each(PHYSICAL)("%s: 25%% status resist cuts damage ~25%%, Mechanism takes ~50%% more", (_name, run) => {
        const plain = run("plain");
        const resisted = run("resist");
        const mechanism = run("mechanism");

        expect(plain).toBeGreaterThan(0);
        // Resisted target takes strictly less, and close to 0.75x (per-target flooring gives small slack).
        expect(resisted).toBeLessThan(plain);
        expect(resisted / plain).toBeGreaterThan(0.72);
        expect(resisted / plain).toBeLessThan(0.78);
        // Mechanism (-50 status resist) takes strictly more, close to 1.5x.
        expect(mechanism).toBeGreaterThan(plain);
        expect(mechanism / plain).toBeGreaterThan(1.45);
        expect(mechanism / plain).toBeLessThan(1.55);
    });

    const MAGIC: Array<[string, (v: Variant) => number]> = [
        ["Fire Breath (Black Dragon)", runFireBreath],
        ["Chain Lightning (Thunderbird)", runChainLightning],
    ];

    it.each(MAGIC)("%s: magic AOE is UNAFFECTED by status resist", (_name, run) => {
        const plain = run("plain");
        const resisted = run("resist");
        expect(plain).toBeGreaterThan(0);
        expect(resisted).toBe(plain);
    });
});

function installMinimumRandom(): () => void {
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
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
