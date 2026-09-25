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

// Full v0.8 matches (a19 search on every turn) outlast the package-wide 30s default on the shared CI runners: the
// first test timed out at 30.3s and, once shooters could no longer move and fire in one turn (longer fights,
// common f6573e0), at 33.5s — while a workstation runs this whole file in ~10s. ~4x the slowest observed CI cost.
const V08_FULL_MATCH_TIMEOUT_MS = 120_000;

describe("rectangular footprints end to end", () => {
    test(
        "v0.8 proposes no illegal action with a 2x1 and a 1x2 on the board",
        () => {
            const result = withRectangularFootprints(() =>
                runMatch({
                    roster: MIXED_ROSTER,
                    greenVersion: "v0.8",
                    redVersion: "v0.8",
                    seed: 4_120_077,
                    maxLaps: 24,
                }),
            );

            expect(result.totalActions).toBeGreaterThan(0);
            expect(describeRejections(result)).toBe("");
            expect(result.rejectedGreen ?? 0).toBe(0);
            expect(result.rejectedRed ?? 0).toBe(0);
        },
        V08_FULL_MATCH_TIMEOUT_MS,
    );

    test(
        "a rectangular match still reaches a real conclusion rather than stalling",
        () => {
            const result = withRectangularFootprints(() =>
                runMatch({
                    roster: MIXED_ROSTER,
                    greenVersion: "v0.8",
                    redVersion: "v0.4",
                    seed: 9_004_411,
                    maxLaps: 60,
                }),
            );

            expect(result.endReason).not.toBe("stuck");
            expect(result.laps).toBeGreaterThan(0);
            expect(result.rejectedGreen ?? 0).toBe(0);
            expect(result.rejectedRed ?? 0).toBe(0);
        },
        V08_FULL_MATCH_TIMEOUT_MS,
    );
});
