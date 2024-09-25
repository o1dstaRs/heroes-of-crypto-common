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

export enum DefaultPlacementLevel1 {
    NO_DEFAULT = 0,
    THREE_BY_THREE = 3,
    FOUR_BY_FOUR = 4,
}

export enum PlacementAugment {
    LEVEL_1 = 0,
    LEVEL_2 = 1,
    LEVEL_3 = 2,
}

export const ToPlacementAugment: { [placementAugemtValue: string]: PlacementAugment } = {
    "": PlacementAugment.LEVEL_1,
    "0": PlacementAugment.LEVEL_1,
    "1": PlacementAugment.LEVEL_2,
    "2": PlacementAugment.LEVEL_3,
};

export const getPlacementSizes = (augment: PlacementAugment, defaultPlacement: DefaultPlacementLevel1): number[] => {
    switch (augment) {
        case PlacementAugment.LEVEL_1:
            switch (defaultPlacement) {
                case DefaultPlacementLevel1.THREE_BY_THREE:
                    return [DefaultPlacementLevel1.THREE_BY_THREE];
                case DefaultPlacementLevel1.FOUR_BY_FOUR:
                    return [DefaultPlacementLevel1.FOUR_BY_FOUR];
                default:
                    throw new Error("Invalid default placement size. Supported: 3x3, 4x4");
            }
        case PlacementAugment.LEVEL_2:
            return [5];
        case PlacementAugment.LEVEL_3:
            return [5, 5];
        default:
            throw new Error("Invalid placement augment");
    }
};

export enum ArmorAugment {
    NO_AUGMENT = 0,
    LEVEL_1 = 1,
    LEVEL_2 = 2,
    LEVEL_3 = 3,
}

export type AugmentType = { type: "Placement"; value: PlacementAugment } | { type: "Armor"; value: ArmorAugment };
