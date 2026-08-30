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

import { describe, expect, test } from "bun:test";

import { runMatch } from "../../src/simulation/battle_engine";
import {
    describeRejections,
    FOOTPRINT_OVERRIDE_ENV,
    MIXED_ROSTER,
    THREE_DEEP_OVERRIDES,
    withEnvironment,
} from "./footprint_end_to_end_helpers";

describe("rectangular footprints end to end", () => {
    /**
     * This case found the anchor-from-position family: a 1x3 stack used to compare its middle cell against
     * an anchor and refuse melee actions. It remains one test so its two original matches stay unchanged.
     */
    test("a body three cells deep is played out with no illegal action either", () => {
        withEnvironment({ [FOOTPRINT_OVERRIDE_ENV]: THREE_DEEP_OVERRIDES }, () => {
            for (const version of ["v0.4", "v0.8"] as const) {
                const result = runMatch({
                    roster: MIXED_ROSTER,
                    greenVersion: version,
                    redVersion: version,
                    seed: 4_120_077,
                    maxLaps: 24,
                });
                expect(result.totalActions).toBeGreaterThan(0);
                expect(describeRejections(result)).toBe("");
                expect((result.rejectedGreen ?? 0) + (result.rejectedRed ?? 0)).toBe(0);
            }
        });
    }, 60_000);
});
