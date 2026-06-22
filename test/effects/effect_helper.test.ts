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

import { getAuraEffectConfig } from "../../src/configuration/config_provider";
import {
    canApplyAuraEffect,
    getAbsorptionTarget,
    getAuraCellKeys,
    getAuraCells,
} from "../../src/effects/effect_helper";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

describe("effect_helper", () => {
    it("decides which aura effects can apply to matching units", () => {
        const ranged = createTestUnit({
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 2,
        });
        const melee = createTestUnit({
            attackType: PBTypes.AttackVals.MELEE,
        });
        const flying = createTestUnit({
            movementType: PBTypes.MovementVals.FLY,
        });
        const disguised = createTestUnit({
            abilities: ["Disguise Aura"],
            auraEffects: ["Disguise"],
        });

        expect(canApplyAuraEffect(disguised, getAuraEffectConfig("Disguise")!)).toBe(true);
        expect(canApplyAuraEffect(ranged, getAuraEffectConfig("Luck")!)).toBe(true);
        expect(canApplyAuraEffect(ranged, getAuraEffectConfig("Absorb Penalties")!)).toBe(true);
        expect(canApplyAuraEffect(ranged, getAuraEffectConfig("Arrows Wingshield")!)).toBe(true);
        expect(canApplyAuraEffect(melee, getAuraEffectConfig("Pegasus Might")!)).toBe(true);
        expect(canApplyAuraEffect(melee, getAuraEffectConfig("Wolf Trail")!)).toBe(true);
        expect(canApplyAuraEffect(melee, getAuraEffectConfig("Tie up the Horses")!)).toBe(true);
        expect(canApplyAuraEffect(flying, getAuraEffectConfig("Tie up the Horses")!)).toBe(false);
        expect(canApplyAuraEffect(ranged, getAuraEffectConfig("Range Null Field")!)).toBe(true);
        expect(canApplyAuraEffect(melee, getAuraEffectConfig("Range Null Field")!)).toBe(false);
        expect(canApplyAuraEffect(melee, getAuraEffectConfig("Sharpened Weapons")!)).toBe(true);
        expect(canApplyAuraEffect(ranged, getAuraEffectConfig("Sharpened Weapons")!)).toBe(false);
    });

    it("collects aura cells and keys around a source cell", () => {
        expect(getAuraCellKeys(testGridSettings, { x: 5, y: 5 }, -1)).toEqual([]);
        expect(getAuraCells(testGridSettings, { x: 5, y: 5 }, -1)).toEqual([]);

        const rangeOneCells = getAuraCells(testGridSettings, { x: 5, y: 5 }, 1);
        const rangeOneKeys = getAuraCellKeys(testGridSettings, { x: 5, y: 5 }, 1);

        expect(rangeOneCells).toHaveLength(9);
        expect(rangeOneCells).toEqual(expect.arrayContaining([{ x: 5, y: 5 }, { x: 4, y: 4 }, { x: 6, y: 6 }]));
        expect(rangeOneKeys).toContain((5 << 4) | 5);
        expect(rangeOneKeys).toContain((4 << 4) | 4);
        expect(new Set(rangeOneKeys).size).toBe(rangeOneKeys.length);
    });

    it("finds an absorption aura source from applied aura metadata", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const source = createTestUnit({
            name: "Absorber",
            team: PBTypes.TeamVals.LOWER,
        });
        const protectedAlly = createTestUnit({
            name: "Protected",
            team: PBTypes.TeamVals.LOWER,
        });

        placeUnit(grid, unitsHolder, source, { x: 3, y: 3 });
        placeUnit(grid, unitsHolder, protectedAlly, { x: 4, y: 3 });

        expect(getAbsorptionTarget(protectedAlly, grid, unitsHolder)).toBeUndefined();

        protectedAlly.applyAuraEffect("Absorb Penalties Aura", "absorb", true, 100, "3;3");

        expect(getAbsorptionTarget(protectedAlly, grid, unitsHolder)).toBe(source);

        source.applyDamage(1000, 0, new SceneLogMock());

        expect(getAbsorptionTarget(protectedAlly, grid, unitsHolder)).toBeUndefined();
    });
});
