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

export enum GridType {
    NO_TYPE = 0,
    NORMAL = 1,
    LAVA_CENTER = 2,
    BLOCK_CENTER = 3,
    WATER_CENTER = 4,
}

export const AllGridTypes = [GridType.NORMAL, GridType.LAVA_CENTER, GridType.BLOCK_CENTER]; //, GridType.WATER_CENTER];

export type AllGridType = (typeof AllGridTypes)[number];

export const ToGridType: { [gridTypeValue: string]: GridType } = {
    "": GridType.NO_TYPE,
    "1": GridType.NORMAL,
    "2": GridType.LAVA_CENTER,
    "3": GridType.BLOCK_CENTER,
    // "4": GridType.WATER_CENTER,
};
