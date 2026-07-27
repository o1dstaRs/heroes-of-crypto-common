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

/** Exact maximum-HP part of Unit.applyLavaWaterModifier's Made of Fire boost. */
export function madeOfFireBoostedMaxHp(maxHp: number, spellPower: number): number {
    return Math.max(Math.ceil(maxHp + maxHp / spellPower), maxHp);
}
