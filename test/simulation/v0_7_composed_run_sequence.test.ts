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

import { describe, expect, it } from "bun:test";

import {
    assertV07ComposedGuardContinuity,
    V07_COMPOSED_GUARD_INTERVAL_MS,
    V07_COMPOSED_MAX_GUARD_GAP_MS,
} from "../../src/simulation/v0_7_composed_run_sequence";
import type { IV07ComposedZincSnapshot } from "../../src/simulation/v0_7_composed_zinc_guard";

function snapshot(capturedAt: string, logText: string): IV07ComposedZincSnapshot {
    return {
        schemaVersion: 1,
        capturedAt,
        files: {},
        logText,
        stateText: null,
        processes: [],
        processScanErrors: [],
        readOnlyScannerConfig: {
            cutoff: "2026-07-16T07:00:00Z",
            seedSetOutput: "/tmp/seeds.txt",
            summaryOutput: "/tmp/summary.json",
            excluded: [],
            excludedPathPrefixes: [],
            excludedRelativeSuffixes: [],
        },
    };
}

describe("v0.7 composed guarded sequence", () => {
    it("freezes a one-minute cadence with a ninety-second fail-closed gap", () => {
        expect(V07_COMPOSED_GUARD_INTERVAL_MS).toBe(60_000);
        expect(V07_COMPOSED_MAX_GUARD_GAP_MS).toBe(90_000);
        expect(
            assertV07ComposedGuardContinuity(
                snapshot("2026-07-16T07:00:00Z", "first\n"),
                snapshot("2026-07-16T07:01:30Z", "first\nsecond\n"),
            ),
        ).toBe(90_000);
    });

    it("fails on a late, reversed, or rewritten observation", () => {
        const first = snapshot("2026-07-16T07:00:00Z", "first\n");
        expect(() =>
            assertV07ComposedGuardContinuity(first, snapshot("2026-07-16T07:01:30.001Z", "first\nsecond\n")),
        ).toThrow("observation gap");
        expect(() => assertV07ComposedGuardContinuity(first, snapshot("2026-07-16T06:59:59Z", "first\n"))).toThrow(
            "chronological order",
        );
        expect(() =>
            assertV07ComposedGuardContinuity(first, snapshot("2026-07-16T07:00:30Z", "replacement\n")),
        ).toThrow("truncated, replaced, or changed");
    });

    it("rejects an unbounded gap before combat preflight", () => {
        expect(() =>
            assertV07ComposedGuardContinuity(
                snapshot("2026-07-16T01:00:00Z", "first\n"),
                snapshot("2026-07-16T07:00:00Z", "first\nsecond\n"),
            ),
        ).toThrow("observation gap");
    });
});
