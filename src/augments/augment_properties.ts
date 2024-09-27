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

export const ToArmorAugment: { [armorAugemtValue: string]: ArmorAugment } = {
    "": ArmorAugment.NO_AUGMENT,
    "0": ArmorAugment.NO_AUGMENT,
    "1": ArmorAugment.LEVEL_1,
    "2": ArmorAugment.LEVEL_2,
    "3": ArmorAugment.LEVEL_3,
};

export const getArmorPower = (augment: ArmorAugment): number => {
    switch (augment) {
        case ArmorAugment.NO_AUGMENT:
            return 0;
        case ArmorAugment.LEVEL_1:
            return 6;
        case ArmorAugment.LEVEL_2:
            return 13;
        case ArmorAugment.LEVEL_3:
            return 21;
        default:
            throw new Error("Invalid armor augment");
    }
};

export enum MightAugment {
    NO_AUGMENT = 0,
    LEVEL_1 = 1,
    LEVEL_2 = 2,
    LEVEL_3 = 3,
}

export const ToMightAugment: { [mightAugemtValue: string]: MightAugment } = {
    "": MightAugment.NO_AUGMENT,
    "0": MightAugment.NO_AUGMENT,
    "1": MightAugment.LEVEL_1,
    "2": MightAugment.LEVEL_2,
    "3": MightAugment.LEVEL_3,
};

export const getMightPower = (augment: MightAugment): number => {
    switch (augment) {
        case MightAugment.NO_AUGMENT:
            return 0;
        case MightAugment.LEVEL_1:
            return 8;
        case MightAugment.LEVEL_2:
            return 17;
        case MightAugment.LEVEL_3:
            return 27;
        default:
            throw new Error("Invalid might augment");
    }
};

export enum SniperAugment {
    NO_AUGMENT = 0,
    LEVEL_1 = 1,
    LEVEL_2 = 2,
    LEVEL_3 = 3,
}

export const ToSniperAugment: { [sniperAugemtValue: string]: SniperAugment } = {
    "": SniperAugment.NO_AUGMENT,
    "0": SniperAugment.NO_AUGMENT,
    "1": SniperAugment.LEVEL_1,
    "2": SniperAugment.LEVEL_2,
    "3": SniperAugment.LEVEL_3,
};

export const getSniperPower = (augment: SniperAugment): [number, number] => {
    switch (augment) {
        case SniperAugment.NO_AUGMENT:
            return [0, 0];
        case SniperAugment.LEVEL_1:
            return [8, 20];
        case SniperAugment.LEVEL_2:
            return [17, 45];
        case SniperAugment.LEVEL_3:
            return [27, 75];
        default:
            throw new Error("Invalid sniper augment");
    }
};

export enum MovementAugment {
    NO_AUGMENT = 0,
    LEVEL_1 = 1,
    LEVEL_2 = 2,
}

export const ToMovementAugment: { [movementAugemtValue: string]: MovementAugment } = {
    "": MovementAugment.NO_AUGMENT,
    "0": MovementAugment.NO_AUGMENT,
    "1": MovementAugment.LEVEL_1,
    "2": MovementAugment.LEVEL_2,
};

export const getMovementPower = (augment: MovementAugment): number => {
    switch (augment) {
        case MovementAugment.NO_AUGMENT:
            return 0;
        case MovementAugment.LEVEL_1:
            return 1;
        case MovementAugment.LEVEL_2:
            return 2;
        default:
            throw new Error("Invalid movement augment");
    }
};

export type AugmentType =
    | { type: "Placement"; value: PlacementAugment }
    | { type: "Armor"; value: ArmorAugment }
    | { type: "Might"; value: MightAugment }
    | { type: "Sniper"; value: SniperAugment }
    | { type: "Movement"; value: MovementAugment };
