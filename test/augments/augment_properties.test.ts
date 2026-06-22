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

import {
    ArmorAugment,
    DefaultPlacementLevel1,
    getArmorPower,
    getMightPower,
    getMovementPower,
    getPlacementSizes,
    getSniperPower,
    MightAugment,
    MovementAugment,
    PlacementAugment,
    SniperAugment,
    ToAllUnitsScoutAugment,
    ToArmorAugment,
    ToAugmentsAndMapScoutAugment,
    ToMightAugment,
    ToMovementAugment,
    ToPlacementAugment,
    ToSniperAugment,
} from "../../src/augments/augment_properties";
import { PlacementType } from "../../src/grid/placement_properties";

describe("augment_properties", () => {
    it("maps string values to augment enums", () => {
        expect(ToPlacementAugment[""]).toBe(PlacementAugment.LEVEL_1);
        expect(ToPlacementAugment["2"]).toBe(PlacementAugment.LEVEL_3);
        expect(ToArmorAugment["3"]).toBe(ArmorAugment.LEVEL_3);
        expect(ToMightAugment["2"]).toBe(MightAugment.LEVEL_2);
        expect(ToSniperAugment["1"]).toBe(SniperAugment.LEVEL_1);
        expect(ToMovementAugment["2"]).toBe(MovementAugment.LEVEL_2);
        expect(ToAllUnitsScoutAugment["1"]).toBe(1);
        expect(ToAugmentsAndMapScoutAugment["1"]).toBe(1);
    });

    it("returns placement sizes for default and upgraded placements", () => {
        expect(
            getPlacementSizes(PlacementType.SQUARE, PlacementAugment.LEVEL_1, DefaultPlacementLevel1.THREE_BY_THREE),
        ).toEqual([3]);
        expect(
            getPlacementSizes(PlacementType.RECTANGLE, PlacementAugment.LEVEL_1, DefaultPlacementLevel1.FOUR_BY_FOUR),
        ).toEqual([4]);
        expect(
            getPlacementSizes(PlacementType.SQUARE, PlacementAugment.LEVEL_2, DefaultPlacementLevel1.THREE_BY_THREE),
        ).toEqual([5]);
        expect(
            getPlacementSizes(PlacementType.RECTANGLE, PlacementAugment.LEVEL_2, DefaultPlacementLevel1.THREE_BY_THREE),
        ).toEqual([4]);
        expect(
            getPlacementSizes(PlacementType.SQUARE, PlacementAugment.LEVEL_3, DefaultPlacementLevel1.THREE_BY_THREE),
        ).toEqual([5, 5]);
        expect(
            getPlacementSizes(PlacementType.RECTANGLE, PlacementAugment.LEVEL_3, DefaultPlacementLevel1.THREE_BY_THREE),
        ).toEqual([5]);
        expect(
            getPlacementSizes(PlacementType.NO_TYPE, PlacementAugment.LEVEL_2, DefaultPlacementLevel1.THREE_BY_THREE),
        ).toEqual([0]);
        expect(
            getPlacementSizes(PlacementType.NO_TYPE, PlacementAugment.LEVEL_3, DefaultPlacementLevel1.THREE_BY_THREE),
        ).toEqual([0]);
    });

    it("returns power values for all combat augments", () => {
        expect([
            getArmorPower(ArmorAugment.NO_AUGMENT),
            getArmorPower(ArmorAugment.LEVEL_1),
            getArmorPower(ArmorAugment.LEVEL_2),
            getArmorPower(ArmorAugment.LEVEL_3),
        ]).toEqual([0, 6, 13, 21]);
        expect([
            getMightPower(MightAugment.NO_AUGMENT),
            getMightPower(MightAugment.LEVEL_1),
            getMightPower(MightAugment.LEVEL_2),
            getMightPower(MightAugment.LEVEL_3),
        ]).toEqual([0, 8, 17, 27]);
        expect([
            getSniperPower(SniperAugment.NO_AUGMENT),
            getSniperPower(SniperAugment.LEVEL_1),
            getSniperPower(SniperAugment.LEVEL_2),
            getSniperPower(SniperAugment.LEVEL_3),
        ]).toEqual([
            [0, 0],
            [7, 20],
            [15, 40],
            [24, 70],
        ]);
        expect([
            getMovementPower(MovementAugment.NO_AUGMENT),
            getMovementPower(MovementAugment.LEVEL_1),
            getMovementPower(MovementAugment.LEVEL_2),
        ]).toEqual([0, 1, 2]);
    });

    it("throws for invalid augment values", () => {
        expect(() =>
            getPlacementSizes(PlacementType.SQUARE, PlacementAugment.LEVEL_1, DefaultPlacementLevel1.NO_DEFAULT),
        ).toThrow();
        expect(() =>
            getPlacementSizes(PlacementType.SQUARE, 99 as PlacementAugment, DefaultPlacementLevel1.THREE_BY_THREE),
        ).toThrow();
        expect(() => getArmorPower(99 as ArmorAugment)).toThrow();
        expect(() => getMightPower(99 as MightAugment)).toThrow();
        expect(() => getSniperPower(99 as SniperAugment)).toThrow();
        expect(() => getMovementPower(99 as MovementAugment)).toThrow();
    });
});
