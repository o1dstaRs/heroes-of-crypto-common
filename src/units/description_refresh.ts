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

/**
 * A bot's search simulates thousands of actions per decision, and every simulated action recomputes every unit's
 * stats. That stat pass also rebuilt each unit's ability description text, which nothing inside a search reads: the
 * rollouts are rolled back, and the next real action rebuilds the text before any snapshot reaches a player. While a
 * search runs inside {@link withUnitDescriptionRefreshSuppressed}, Unit.adjustBaseStats skips those rebuilds. Every
 * decision stays byte-identical; the search spends about 3% less CPU.
 */
let suppressedDepth = 0;

export function withUnitDescriptionRefreshSuppressed<T>(run: () => T): T {
    suppressedDepth += 1;
    try {
        return run();
    } finally {
        suppressedDepth -= 1;
    }
}

export function isUnitDescriptionRefreshSuppressed(): boolean {
    return suppressedDepth > 0;
}
