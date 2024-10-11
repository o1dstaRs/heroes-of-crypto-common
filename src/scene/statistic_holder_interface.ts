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

export interface IStatisticHolder<T> {
    add(singleDamageStatistic: T, identifyFn: (a: T, b: T) => boolean, combineFn: (a: T, b: T) => T): void;
    get(compareFn: (a: T, b: T) => number): T[];
}
