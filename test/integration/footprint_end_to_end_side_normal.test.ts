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
import { describeRejections, MIXED_ROSTER, withRectangularFootprints } from "./footprint_end_to_end_helpers";

describe("rectangular footprints end to end", () => {
    test("rectangles on the side-oriented normal map play with no illegal action", () => {
        withRectangularFootprints(() => {
            const result = runMatch({
                roster: MIXED_ROSTER,
                greenVersion: "v0.8",
                redVersion: "v0.8",
                seed: 4_120_091,
                maxLaps: 24,
                gridType: 1,
                sideOrientedPlacement: true,
            });
            expect(result.totalActions).toBeGreaterThan(0);
            expect(describeRejections(result)).toBe("");
            expect((result.rejectedGreen ?? 0) + (result.rejectedRed ?? 0)).toBe(0);
        });
    }, 60_000);
});
