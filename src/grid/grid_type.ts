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

import { PBTypes } from "../generated/protobuf/v1/types";
import type { GridType } from "../generated/protobuf/v1/types_gen";

export const ToGridType: { [gridTypeValue: string]: GridType } = {
    "": PBTypes.GridVals.NO_TYPE,
    "1": PBTypes.GridVals.NORMAL,
    "2": PBTypes.GridVals.LAVA_CENTER,
    "3": PBTypes.GridVals.BLOCK_CENTER,
    // "4": GridType.WATER_CENTER,
};
