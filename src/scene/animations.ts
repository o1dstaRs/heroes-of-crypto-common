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

import type { IBoardObj, Unit } from "../units/unit";
import type { XY } from "../utils/math";

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
    unitId?: string;
    hits?: { amount: number; unitsDied: number }[];
    // Per-affected-unit damage for AOE attacks (Large Caliber / Area Throw). Each entry carries the
    // hit unit's id, its world position at the moment of impact, the damage dealt and how many of its
    // stack died — so the renderer can place a floating number on EVERY splashed unit, not just the
    // primary target. Empty/undefined for single-target attacks.
    splash?: { unitId: string; position: XY; amount: number; unitsDied: number }[];
}
