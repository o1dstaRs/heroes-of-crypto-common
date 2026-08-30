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

import type { IArmyUnitSpec } from "../../src/simulation/army";
import type { IMatchResult } from "../../src/simulation/battle_engine";

export const FOOTPRINT_OVERRIDE_ENV = "HOC_FOOTPRINT_OVERRIDES";
export const RECTANGULAR_OVERRIDES = "White Tiger=2x1,Hyena=1x2";
export const THREE_DEEP_OVERRIDES = "White Tiger=3x1,Hyena=1x3";

const WHITE_TIGER: IArmyUnitSpec = { faction: "Nature", creatureName: "White Tiger", level: 2, size: 1, amount: 12 };
const HYENA: IArmyUnitSpec = { faction: "Might", creatureName: "Hyena", level: 2, size: 1, amount: 12 };
const PEASANT: IArmyUnitSpec = { faction: "Life", creatureName: "Peasant", level: 1, size: 1, amount: 30 };
const ARBALESTER: IArmyUnitSpec = { faction: "Life", creatureName: "Arbalester", level: 1, size: 1, amount: 12 };
const ARACHNA_QUEEN: IArmyUnitSpec = { faction: "Nature", creatureName: "Arachna Queen", level: 4, size: 2, amount: 2 };

/** A mixed board: both rectangles, a small melee wall, a shooter, and a genuine 2x2 to share the field with. */
export const MIXED_ROSTER: IArmyUnitSpec[] = [WHITE_TIGER, HYENA, PEASANT, ARBALESTER, ARACHNA_QUEEN];

export function withEnvironment<T>(overrides: Readonly<Record<string, string>>, run: () => T): T {
    const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
    Object.assign(process.env, overrides);
    try {
        return run();
    } finally {
        for (const [key, value] of previous) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }
}

export const withRectangularFootprints = <T>(run: () => T): T =>
    withEnvironment({ [FOOTPRINT_OVERRIDE_ENV]: RECTANGULAR_OVERRIDES }, run);

export const describeRejections = (result: IMatchResult): string =>
    (result.rejectedDetails ?? [])
        .map(
            (detail) =>
                `${detail.version}:${detail.creature ?? "?"}:${detail.type}:${detail.reason ?? "?"}${detail.cause ? `(${detail.cause})` : ""}`,
        )
        .join(", ");
