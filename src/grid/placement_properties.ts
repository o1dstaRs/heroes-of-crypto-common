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

import type { XY } from "../utils/math";

export interface IPlacement {
    getType(): PlacementType;
    getSize(): number;
    isAllowed(v: XY): boolean;
    possibleCellHashes(): Set<number>;
    possibleCellPositions(isSmallUnit?: boolean): XY[];
}

export enum PlacementPositionType {
    NO_TYPE = 0,
    UPPER_RIGHT = 1,
    LOWER_LEFT = 2,
    UPPER_LEFT = 3,
    LOWER_RIGHT = 4,
}

export enum PlacementType {
    NO_TYPE = 0,
    SQUARE = 1,
    RECTANGLE = 2,
}
