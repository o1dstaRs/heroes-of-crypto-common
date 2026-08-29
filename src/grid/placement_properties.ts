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
    /** Every cell of the deployment zone. Shape-independent: a unit may COVER any of these. */
    possibleCellHashes(): Set<number>;
    /**
     * The anchors (top-right footprint cells) a `footprintWidth` x `footprintHeight` body may be placed on,
     * i.e. those whose whole footprint stays inside the zone. The width/height live on the interface so that
     * polymorphic callers can pass a unit's real footprint without casting the placement to a concrete class;
     * they default to the legacy `isSmallUnit ? 1 : 2` square so existing call sites keep their meaning.
     */
    possibleCellPositions(isSmallUnit?: boolean, footprintWidth?: number, footprintHeight?: number): XY[];
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
