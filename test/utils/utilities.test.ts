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

import { AbilityFactory } from "../../src/abilities/ability_factory";
import { EffectFactory } from "../../src/effects/effect_factory";
import { GridSettings } from "../../src/grid/grid_settings";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import {
    ChaosSynergy,
    getChaosSynergyByName,
    getLifeSynergyByName,
    getMightSynergyByName,
    getNatureSynergyByName,
    LifeSynergy,
    MightSynergy,
    NatureSynergy,
} from "../../src/synergies/synergy_properties";
import {
    base64ToUint8Array,
    getLapString,
    isBrowser,
    matrixElement,
    RefNumber,
    removeItemOnce,
    shuffle,
    stringToBoolean,
    uuidFromBytes,
    uuidToUint8Array,
} from "../../src/utils/lib";
import {
    asc,
    getDistance,
    intersect2D,
    matrixElementOrDefault,
    mean,
    minus,
    perpDot,
    q25,
    q50,
    q75,
    q90,
    quantile,
    std,
    sum,
    updateMatrixElementIfExists,
    winningAtLeastOneEventProbability,
} from "../../src/utils/math";

describe("utility functions", () => {
    it("covers collection, UUID, base64, and ref-number helpers", () => {
        const values = [3, 1, 2];
        const ref = new RefNumber(5);
        const uuid = "00112233-4455-6677-8899-aabbccddeeff";
        const bytes = uuidToUint8Array(uuid);

        expect(shuffle(values).sort()).toEqual([1, 2, 3]);
        expect(matrixElement([[1, 2]], 1, 0)).toBe(2);
        expect(matrixElement([[1, 2]], 3, 0)).toBe(0);
        expect(stringToBoolean("true")).toBe(true);
        expect(stringToBoolean("1")).toBe(true);
        expect(stringToBoolean("false")).toBe(false);
        expect(stringToBoolean(undefined)).toBe(false);

        const removable = ["a", "b", "c"];
        expect(removeItemOnce(removable, "b")).toBe(true);
        expect(removeItemOnce(removable, "x")).toBe(false);
        expect(removable).toEqual(["a", "c"]);

        expect(isBrowser()).toBe(false);
        expect(bytes).toHaveLength(16);
        expect(uuidFromBytes(bytes)).toBe(uuid);
        expect(() => uuidToUint8Array("bad")).toThrow("Invalid UUID format");
        expect(() => uuidFromBytes(new Uint8Array(1))).toThrow("Buffer must be 16 bytes long");
        expect(Array.from(base64ToUint8Array("aG9j"))).toEqual([104, 111, 99]);

        expect(ref.getValue()).toBe(5);
        ref.increment();
        ref.increment(4);
        ref.decrement(3);
        ref.reset(9);
        expect(ref.getValue()).toBe(9);
        expect(getLapString(1)).toBe("1 lap");
        expect(getLapString(2)).toBe("2 laps");
    });

    it("covers numeric helpers and line intersections", () => {
        const matrix = [
            [1, 2],
            [3, 4],
        ];

        expect(getDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
        expect(minus({ x: 5, y: 3 }, { x: 2, y: 1 })).toEqual({ x: 3, y: 2 });
        expect(perpDot({ x: 1, y: 2 }, { x: 3, y: 4 })).toBe(-2);
        expect(matrixElementOrDefault(matrix, 1, 1, -1)).toBe(4);
        expect(matrixElementOrDefault(matrix, 3, 1, -1)).toBe(-1);
        updateMatrixElementIfExists(matrix, 0, 1, 5);
        updateMatrixElementIfExists(matrix, 5, 5, 5);
        expect(matrix[1][0]).toBe(8);

        expect(intersect2D({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: -1 }, { x: 5, y: 1 }).x).toBe(5);
        expect(intersect2D({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 1 }, { x: 10, y: 1 }).x).toBeUndefined();
        expect(intersect2D({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 }, { x: 15, y: 0 }).x).toBeUndefined();

        expect(asc([3, 1, 2])).toEqual([1, 2, 3]);
        expect(sum([1, 2, 3])).toBe(6);
        expect(mean([1, 2, 3])).toBe(2);
        expect(std([1, 2, 3])).toBe(1);
        expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
        expect(q25([1, 2, 3, 4])).toBe(1.75);
        expect(q50([1, 2, 3, 4])).toBe(2.5);
        expect(q75([1, 2, 3, 4])).toBe(3.25);
        expect(q90([1, 2, 3, 4])).toBe(3.7);
        expect(winningAtLeastOneEventProbability([0.5, 0.5])).toBe(0.75);
        expect(() => winningAtLeastOneEventProbability([1.5])).toThrow("Probability must be between 0 and 1");
    });

    it("covers settings, synergy mappers, mocks, and factory fallback paths", () => {
        const settings = new GridSettings(16, 2048, 0, 1024, -1024, 5, 0.06);
        const sceneLog = new SceneLogMock();
        const effectFactory = new EffectFactory();
        const abilityFactory = new AbilityFactory(effectFactory);

        expect(settings.getGridSize()).toBe(16);
        expect(settings.getStep()).toBe(128);
        expect(settings.getHalfStep()).toBe(64);
        expect(settings.getQuarterStep()).toBe(32);
        expect(settings.getTwoSteps()).toBe(256);
        expect(settings.getFourSteps()).toBe(512);
        expect(settings.getDiagonalStep()).toBeGreaterThan(180);
        expect(settings.getMovementDelta()).toBe(5);
        expect(settings.getUnitSizeDelta()).toBe(0.06);
        expect(settings.getUnitSize()).toBeCloseTo(63.94);
        expect(settings.getMaxY()).toBe(2048);
        expect(settings.getMinY()).toBe(0);
        expect(settings.getMaxX()).toBe(1024);
        expect(settings.getMinX()).toBe(-1024);
        expect(settings.getCellSize()).toBe(128);

        expect(getLifeSynergyByName("PLUS_SUPPLY_PERCENTAGE")).toBe(LifeSynergy.PLUS_SUPPLY_PERCENTAGE);
        expect(getChaosSynergyByName("BREAK_ON_ATTACK")).toBe(ChaosSynergy.BREAK_ON_ATTACK);
        expect(getMightSynergyByName("PLUS_STACK_ABILITIES_POWER")).toBe(MightSynergy.PLUS_STACK_ABILITIES_POWER);
        expect(getNatureSynergyByName("PLUS_FLY_ARMOR")).toBe(NatureSynergy.PLUS_FLY_ARMOR);

        expect(sceneLog.getLog()).toBe("");
        expect(sceneLog.hasBeenUpdated()).toBe(false);
        expect(sceneLog.updateLog("ignored")).toBeUndefined();

        expect(effectFactory.makeEffect(null)).toBeUndefined();
        expect(effectFactory.makeEffect("missing")).toBeUndefined();
        expect(effectFactory.makeAuraEffect(null)).toBeUndefined();
        expect(effectFactory.makeAuraEffect("missing")).toBeUndefined();
        expect(abilityFactory.getEffectsFactory()).toBe(effectFactory);
        expect(abilityFactory.makeAbility("Resurrection").getSpell()?.getName()).toBe("Resurrection");
    });
});
