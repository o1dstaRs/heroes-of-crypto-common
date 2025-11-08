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

import { GridVals } from "../generated/protobuf/v1/types_pb";
import { GridType } from "../generated/protobuf/v1/types_gen";

export const ToGridType: { [gridTypeValue: string]: GridType } = {
    "": GridVals.NO_TYPE,
    "1": GridVals.NORMAL,
    "2": GridVals.LAVA_CENTER,
    "3": GridVals.BLOCK_CENTER,
    // "4": GridType.WATER_CENTER,
};
