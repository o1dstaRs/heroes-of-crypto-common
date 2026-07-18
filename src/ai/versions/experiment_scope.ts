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
 * Exact comma-list scope shared by seat-scoped AI experiments. An absent scope keeps the historical
 * all-versions behavior; an explicitly empty scope matches no version and therefore fails closed.
 */
export function strategyVersionMatchesExperimentScope(
    version: string | undefined,
    rawScope: string | undefined,
): boolean {
    if (rawScope === undefined) {
        return true;
    }
    if (!version) {
        return false;
    }
    return rawScope
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .includes(version);
}
