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

/**
 * The acceptance test for rectangular unit footprints: play whole matches with a 2x1 and a 1x2 stack on
 * the board and require the engine to accept every command the AI proposes. The slow configurations live
 * in sibling files so Bun can schedule them independently without changing any match or assertion.
 */
describe("rectangular footprints end to end", () => {
    test("the override actually reshapes the stacks the match places", () => {
        const result = withRectangularFootprints(() =>
            runMatch({
                roster: MIXED_ROSTER,
                greenVersion: "v0.4",
                redVersion: "v0.4",
                seed: 4_120_077,
                maxLaps: 1,
            }),
        );

        const placed = [...result.placements.green, ...result.placements.red];
        const tigers = placed.filter((record) => record.creatureName === "White Tiger");
        const hyenas = placed.filter((record) => record.creatureName === "Hyena");
        expect(tigers.length).toBeGreaterThan(0);
        expect(hyenas.length).toBeGreaterThan(0);
        for (const tiger of tigers) {
            expect([tiger.footprintWidth, tiger.footprintHeight]).toEqual([2, 1]);
        }
        for (const hyena of hyenas) {
            expect([hyena.footprintWidth, hyena.footprintHeight]).toEqual([1, 2]);
        }
        for (const record of placed.filter((item) => item.creatureName === "Peasant")) {
            expect(record.footprintWidth).toBeUndefined();
            expect(record.footprintHeight).toBeUndefined();
        }
    });

    for (const version of ["v0.1", "v0.2", "v0.3", "v0.4", "v0.5", "v0.6", "v0.7"] as const) {
        test(`${version} proposes no illegal action with a 2x1 and a 1x2 on the board`, () => {
            const result = withRectangularFootprints(() =>
                runMatch({
                    roster: MIXED_ROSTER,
                    greenVersion: version,
                    redVersion: version,
                    seed: 4_120_077,
                    maxLaps: 24,
                }),
            );

            expect(result.totalActions).toBeGreaterThan(0);
            expect(describeRejections(result)).toBe("");
            expect(result.rejectedGreen ?? 0).toBe(0);
            expect(result.rejectedRed ?? 0).toBe(0);
        });
    }

    test("without the override the shapes are the SHIPPED ones: mounted 2x1, everything else square", () => {
        const result = runMatch({
            roster: MIXED_ROSTER,
            greenVersion: "v0.4",
            redVersion: "v0.4",
            seed: 4_120_077,
            maxLaps: 1,
        });

        const mounted = new Set(["White Tiger", "Hyena"]);
        for (const record of [...result.placements.green, ...result.placements.red]) {
            if (mounted.has(record.creatureName)) {
                expect([record.creatureName, record.footprintWidth, record.footprintHeight]).toEqual([
                    record.creatureName,
                    2,
                    1,
                ]);
            } else {
                expect(record.footprintWidth).toBeUndefined();
                expect(record.footprintHeight).toBeUndefined();
            }
        }
    });
});
