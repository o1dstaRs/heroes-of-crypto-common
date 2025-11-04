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

import { IBoardObj, Unit } from "../units/unit";
import { XY } from "../utils/math";

export interface IAnimationData {
    toPosition: XY;
    affectedUnit: IBoardObj;
    fromPosition?: XY;
    bodyUnit?: Unit;
}

export interface IVisibleDamage {
    amount: number;
    render: boolean;
    unitPosition: XY;
    unitIsSmall: boolean;
}
