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
    WATER_CENTER = 2,
    LAVA_CENTER = 3,
    BLOCK_CENTER = 4,
}

export const AllGridTypes = [GridType.NORMAL, GridType.WATER_CENTER, GridType.LAVA_CENTER, GridType.BLOCK_CENTER];

export type AllGridType = (typeof AllGridTypes)[number];

export const ToGridType: { [gridTypeName: string]: GridType } = {
    "": GridType.NO_TYPE,
    "1": GridType.NORMAL,
    "2": GridType.WATER_CENTER,
    "3": GridType.LAVA_CENTER,
    "4": GridType.BLOCK_CENTER,
};
