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

import { afterEach, describe, expect, test } from "bun:test";

import type { IArmyUnitSpec } from "../../src/simulation/army";
import { runMatch, type IMatchResult } from "../../src/simulation/battle_engine";

/**
 * The acceptance test for rectangular unit footprints: play WHOLE MATCHES with a 2x1 and a 1x2 stack on the
 * board, under every shipped AI version, and require the engine to accept every command the AI proposes.
 *
 * `rejectedGreen`/`rejectedRed` is the right assertion because a footprint bug does not usually crash — it
 * makes the AI reason about a body of the wrong shape and then propose a move or a strike the engine refuses.
 * In ranked that is exactly the "the bot stalls / skips its turn / moves but does not attack" report. A count
 * of zero across a full match is the strongest end-to-end statement available in a headless test.
 *
 * The shapes come from HOC_FOOTPRINT_OVERRIDES rather than from creatures.json on purpose: which creature
 * becomes rectangular is a balance and art decision, so the engine is proven against the two whose
 * battlefield art is already authored two cells wide (White Tiger, Hyena) without changing their data.
 */
const FOOTPRINT_OVERRIDE_ENV = "HOC_FOOTPRINT_OVERRIDES";

// White Tiger is the 2x1 (two cells WIDE); Hyena is deliberately given the transposed 1x2, because almost
// every bug in this area is an axis confusion that a single orientation would hide.
const RECTANGULAR_OVERRIDES = "White Tiger=2x1,Hyena=1x2";

const WHITE_TIGER: IArmyUnitSpec = { faction: "Nature", creatureName: "White Tiger", level: 2, size: 1, amount: 12 };
const HYENA: IArmyUnitSpec = { faction: "Might", creatureName: "Hyena", level: 2, size: 1, amount: 12 };
const PEASANT: IArmyUnitSpec = { faction: "Life", creatureName: "Peasant", level: 1, size: 1, amount: 30 };
const ARBALESTER: IArmyUnitSpec = { faction: "Life", creatureName: "Arbalester", level: 1, size: 1, amount: 12 };
const ARACHNA_QUEEN: IArmyUnitSpec = { faction: "Nature", creatureName: "Arachna Queen", level: 4, size: 2, amount: 2 };

/** A mixed board: both rectangles, a small melee wall, a shooter, and a genuine 2x2 to share the field with. */
const MIXED_ROSTER: IArmyUnitSpec[] = [WHITE_TIGER, HYENA, PEASANT, ARBALESTER, ARACHNA_QUEEN];

const withRectangularFootprints = <T>(run: () => T): T => {
    const previous = process.env[FOOTPRINT_OVERRIDE_ENV];
    process.env[FOOTPRINT_OVERRIDE_ENV] = RECTANGULAR_OVERRIDES;
    try {
        return run();
    } finally {
        if (previous === undefined) {
            delete process.env[FOOTPRINT_OVERRIDE_ENV];
        } else {
            process.env[FOOTPRINT_OVERRIDE_ENV] = previous;
        }
    }
};

const describeRejections = (result: IMatchResult): string =>
    (result.rejectedDetails ?? [])
        .map((d) => `${d.version}:${d.creature ?? "?"}:${d.type}:${d.reason ?? "?"}${d.cause ? `(${d.cause})` : ""}`)
        .join(", ");

afterEach(() => {
    delete process.env[FOOTPRINT_OVERRIDE_ENV];
});

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
        // IPlacementRecord only spells the dimensions out when they are NOT the square `size x size` block,
        // which is itself the assertion that these two stacks really were rectangular on the board.
        for (const tiger of tigers) {
            expect([tiger.footprintWidth, tiger.footprintHeight]).toEqual([2, 1]);
        }
        for (const hyena of hyenas) {
            expect([hyena.footprintWidth, hyena.footprintHeight]).toEqual([1, 2]);
        }
        // A square stack must not have grown the fields — that would mean every recorded match just changed.
        for (const record of placed.filter((r) => r.creatureName === "Peasant")) {
            expect(record.footprintWidth).toBeUndefined();
            expect(record.footprintHeight).toBeUndefined();
        }
    });

    for (const version of ["v0.1", "v0.2", "v0.3", "v0.4", "v0.5", "v0.6", "v0.7", "v0.8"] as const) {
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

    test("a rectangular match still reaches a real conclusion rather than stalling", () => {
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
    });

    /**
     * The deepest shape the engine is verified for. This case is the one that found the whole
     * anchor-from-position family: before it was fixed, a 1x3 stack refused roughly 64 melee actions per 8
     * matches, because `getCellForPosition(unit.getPosition())` returned the body's MIDDLE cell and the
     * stand-still check compared that against an anchor. Zero here is what raised
     * MAX_VERIFIED_FOOTPRINT_SIDE from 2 to 3, so it belongs in the gate rather than in a one-off script.
     */
    test("a body three cells deep is played out with no illegal action either", () => {
        const previous = process.env[FOOTPRINT_OVERRIDE_ENV];
        process.env[FOOTPRINT_OVERRIDE_ENV] = "White Tiger=3x1,Hyena=1x3";
        try {
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
        } finally {
            if (previous === undefined) {
                delete process.env[FOOTPRINT_OVERRIDE_ENV];
            } else {
                process.env[FOOTPRINT_OVERRIDE_ENV] = previous;
            }
        }
    });

    /**
     * The same three-deep bodies under the A19 SEARCH driver — the production configuration, and a
     * different code path from the plain versions above.
     *
     * What this pins is what it says: the whole a19 configuration plays a match with a 3-deep body and the
     * engine refuses nothing. It does NOT pin the shape-aware canBeAttackedByMelee conversion, though an
     * earlier version of this comment claimed it did. That was checked rather than argued: reverting both
     * candidates.ts call sites to the legacy boolean leaves every test in this file green, because the two
     * gated sites (enrichIncumbentMetadata, and the move-shot enumerator's maxMoveShotComposites) are not
     * opened by this harness. The boolean-vs-object divergence is pinned directly, at the unit level, in
     * test/handlers/footprint_attacks.test.ts — that is the test to break if you want to know.
     */
    test("a body three cells deep survives the A19 search driver with no illegal action", () => {
        const previous = process.env[FOOTPRINT_OVERRIDE_ENV];
        const previousSearch = process.env.V08_A19_SEARCH;
        process.env[FOOTPRINT_OVERRIDE_ENV] = "White Tiger=3x1,Hyena=1x3";
        process.env.V08_A19_SEARCH = "1";
        try {
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
        } finally {
            if (previous === undefined) {
                delete process.env[FOOTPRINT_OVERRIDE_ENV];
            } else {
                process.env[FOOTPRINT_OVERRIDE_ENV] = previous;
            }
            if (previousSearch === undefined) {
                delete process.env.V08_A19_SEARCH;
            } else {
                process.env.V08_A19_SEARCH = previousSearch;
            }
        }
    });

    /**
     * The two new systems together: rectangular bodies on the SIDE-oriented board, across every live
     * grid type. The side board turns the axis of advance to X, which is exactly the axis a 2x1 body
     * spans — the pairing where anchor/edge mistakes surface that neither feature shows alone.
     */
    test("rectangles on the side-oriented board play every live map with no illegal action", () => {
        const previous = process.env[FOOTPRINT_OVERRIDE_ENV];
        process.env[FOOTPRINT_OVERRIDE_ENV] = "White Tiger=2x1,Hyena=1x2";
        try {
            for (const gridType of [1, 3, 4]) {
                const result = runMatch({
                    roster: MIXED_ROSTER,
                    greenVersion: "v0.8",
                    redVersion: "v0.8",
                    seed: 4_120_090 + gridType,
                    maxLaps: 24,
                    gridType,
                    sideOrientedPlacement: true,
                });
                expect(result.totalActions).toBeGreaterThan(0);
                expect(describeRejections(result)).toBe("");
                expect((result.rejectedGreen ?? 0) + (result.rejectedRed ?? 0)).toBe(0);
            }
        } finally {
            if (previous === undefined) {
                delete process.env[FOOTPRINT_OVERRIDE_ENV];
            } else {
                process.env[FOOTPRINT_OVERRIDE_ENV] = previous;
            }
        }
    });

    test("without the override the shapes are the SHIPPED ones: mounted 2x1, everything else square", () => {
        const result = runMatch({
            roster: MIXED_ROSTER,
            greenVersion: "v0.4",
            redVersion: "v0.4",
            seed: 4_120_077,
            maxLaps: 1,
        });

        // White Tiger and Hyena are mounted-class and ship 2x1 from creatures.json — the override in the
        // tests above merely restates their shipped shape (and reshapes the squares). The rest of the
        // roster records no footprint at all.
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
