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
    /** Production A19 search is a different path from the plain-version matches in the sibling files. */
    test("a body three cells deep survives the A19 search driver with no illegal action", () => {
        withEnvironment({ [FOOTPRINT_OVERRIDE_ENV]: THREE_DEEP_OVERRIDES, V08_A19_SEARCH: "1" }, () => {
            const result = runMatch({
                roster: MIXED_ROSTER,
                greenVersion: "v0.8",
                redVersion: "v0.8",
                seed: 4_120_078,
                maxLaps: 24,
                searchOfflineDeterministicWork: true,
            });
            expect(result.totalActions).toBeGreaterThan(0);
            expect(describeRejections(result)).toBe("");
            expect((result.rejectedGreen ?? 0) + (result.rejectedRed ?? 0)).toBe(0);
        });
    }, 120_000);
});
