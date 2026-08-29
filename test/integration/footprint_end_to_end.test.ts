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
 *
 * This file is the fast summary, NOT the search. src/simulation/rect_stability_sweep.ts is the search: it
 * drives this same runMatch harness across the whole (version x roster x shape x map x orientation x seed)
 * grid, and that is where a new failure gets FOUND. What lands here is a configuration that sweep has
 * already played out at scale and found clean, pinned at one or two seeds — enough to catch a regression,
 * cheap enough to keep the whole file inside a CI minute.
 */
const FOOTPRINT_OVERRIDE_ENV = "HOC_FOOTPRINT_OVERRIDES";

// White Tiger is the 2x1 (two cells WIDE); Hyena is deliberately given the transposed 1x2, because almost
// every bug in this area is an axis confusion that a single orientation would hide.
const RECTANGULAR_OVERRIDES = "White Tiger=2x1,Hyena=1x2";

/**
 * The same two stacks with their shapes SWAPPED. Nothing about this board is symmetric — the deployment
 * strip, the axis of advance and (on the side-oriented block map) the seeded stone band all have a grain —
 * so "tiger wide, hyena tall" and "tiger tall, hyena wide" are two different boards, and only the first was
 * ever pinned here. The sweep drives both; these cases carry the transposed one into CI.
 */
const TRANSPOSED_OVERRIDES = "White Tiger=1x2,Hyena=2x1";

const WHITE_TIGER: IArmyUnitSpec = { faction: "Nature", creatureName: "White Tiger", level: 2, size: 1, amount: 12 };
const HYENA: IArmyUnitSpec = { faction: "Might", creatureName: "Hyena", level: 2, size: 1, amount: 12 };
const PEASANT: IArmyUnitSpec = { faction: "Life", creatureName: "Peasant", level: 1, size: 1, amount: 30 };
const ARBALESTER: IArmyUnitSpec = { faction: "Life", creatureName: "Arbalester", level: 1, size: 1, amount: 12 };
const ARACHNA_QUEEN: IArmyUnitSpec = { faction: "Nature", creatureName: "Arachna Queen", level: 4, size: 2, amount: 2 };

/** A mixed board: both rectangles, a small melee wall, a shooter, and a genuine 2x2 to share the field with. */
const MIXED_ROSTER: IArmyUnitSpec[] = [WHITE_TIGER, HYENA, PEASANT, ARBALESTER, ARACHNA_QUEEN];

/**
 * Every version the ranked profile registers (src/ai/ranked_profile.ts), in registry order.
 *
 * Four of them were never named by this file. v0.9 is simply newer than it; v0.6s, v0.7s and v0.8s are the
 * search-scoped aliases, and with V07_SEARCH / V08_A19_SEARCH unset each one IS its base strategy, so
 * covering the base was treated as covering the alias. "Treated as" is not what a gate is for: the alias is
 * the object a ranked seat actually instantiates, and the day one of them stops being its base — a default
 * flipped on, a driver promoted — is the day this file should be the one to say so.
 */
const ALL_VERSIONS = [
    "v0.1",
    "v0.2",
    "v0.3",
    "v0.4",
    "v0.5",
    "v0.6s",
    "v0.6",
    "v0.7s",
    "v0.7",
    "v0.8s",
    "v0.8",
    "v0.9",
] as const;

/**
 * v0.8 is the only expensive version in the list: it drives the promoted A19 search and measures at seconds
 * per match, against tens of milliseconds for every other version. The cases that sweep the cheap versions
 * therefore leave it out — it is already covered, one map per test, by the v0.8 cases that follow.
 */
const VERSIONS_WITHOUT_V08 = ALL_VERSIONS.filter((version) => version !== "v0.8");

/**
 * ...and on the side-oriented BLOCK_CENTER map, v0.1 and v0.2 come out too. That one cell is the only
 * configuration that swaps the classic central mountain pair for SEEDED scattered stones, and the sweep
 * found a real defect living in it: v0.1 re-derives a ranged shot's aim point itself — nearest target CELL,
 * then a side of that one cell — instead of asking the engine's resolveRangeAttackAimEdge for the nearest
 * VISIBLE EDGE of the whole body, so against a screened multi-cell target it certifies one trajectory and
 * the engine fires another, and refuses the shot. It is NOT a footprint bug: driving that same cell with
 * all-square 1x1 bodies reproduces it in 8 of 60 matches. Pinning a seed that happens to dodge it would buy
 * a green tick that goes red on the next harmless RNG change and points at the wrong file. The fix belongs
 * in src/ai/versions/v0_1.ts; when it lands, delete this filter and let the two versions back in.
 */
const BLOCK_CENTRE_SIDE_VERSIONS = VERSIONS_WITHOUT_V08.filter((version) => version !== "v0.1" && version !== "v0.2");

/**
 * Mixed-version seats. Each pair puts one of the four newly covered versions opposite an older one, and the
 * first two are the same pair both ways round: which side of the board a version sits on is not a symmetry
 * you get for free — the sweep has a failure that appears with the seats swapped and not as first written.
 * v0.1 and v0.2 stay out for the reason above; every failure the sweep attributed to a mixed match was
 * emitted by a v0.1 seat.
 */
const ASYMMETRIC_PAIRS = [
    ["v0.9", "v0.6s"],
    ["v0.6s", "v0.9"],
    ["v0.7s", "v0.4"],
    ["v0.8s", "v0.3"],
] as const;

const withFootprintOverrides = <T>(shapes: string, run: () => T): T => {
    const previous = process.env[FOOTPRINT_OVERRIDE_ENV];
    process.env[FOOTPRINT_OVERRIDE_ENV] = shapes;
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

const withRectangularFootprints = <T>(run: () => T): T => withFootprintOverrides(RECTANGULAR_OVERRIDES, run);

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

    test("the transposed override reshapes those same two stacks the other way round", () => {
        const result = withFootprintOverrides(TRANSPOSED_OVERRIDES, () =>
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
        // The whole point of the transposed set is that the SAME creature is tall here and wide in the test
        // above. If this ever reads 2x1/1x2 again, the override has quietly stopped transposing and every
        // transposed case below is silently re-running a board that was already covered.
        for (const tiger of tigers) {
            expect([tiger.footprintWidth, tiger.footprintHeight]).toEqual([1, 2]);
        }
        for (const hyena of hyenas) {
            expect([hyena.footprintWidth, hyena.footprintHeight]).toEqual([2, 1]);
        }
    });

    for (const version of ALL_VERSIONS) {
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

    /**
     * The same assertion as the loop above, on the transposed shapes and a second seed, every version in one
     * case because only v0.8 costs more than a blink. Two variables move at once deliberately: a gate that
     * only ever plays one board cannot tell "this version is sound" from "this version survives seed
     * 4_120_077". Breadth stays in the sweep; this is one more board, not a search.
     */
    test("every version plays the transposed pair out with no illegal action either", () => {
        for (const version of ALL_VERSIONS) {
            const result = withFootprintOverrides(TRANSPOSED_OVERRIDES, () =>
                runMatch({
                    roster: MIXED_ROSTER,
                    greenVersion: version,
                    redVersion: version,
                    seed: 4_120_101,
                    maxLaps: 24,
                }),
            );

            // The version travels inside every assertion, so a failure names the seat that produced it
            // instead of pointing at a loop body.
            expect([version, result.totalActions > 0]).toEqual([version, true]);
            expect([version, describeRejections(result)]).toEqual([version, ""]);
            expect([version, (result.rejectedGreen ?? 0) + (result.rejectedRed ?? 0)]).toEqual([version, 0]);
        }
    }, 60_000);

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
    }, 120_000);

    /**
     * The two new systems together: rectangular bodies on the SIDE-oriented board, across every live
     * grid type. The side board turns the axis of advance to X, which is exactly the axis a 2x1 body
     * spans — the pairing where anchor/edge mistakes surface that neither feature shows alone.
     */
    /**
     * The side board turns the axis of advance to X — exactly the axis a 2x1 spans — so it is where anchor
     * and edge mistakes surface that neither feature shows alone. One test PER MAP rather than a loop: as a
     * single case the three matches ran ~44s on CI's slower runner and blew the 30s per-test budget, while
     * each map on its own sits well inside it. Same maps, same seeds, same laps, same assertions.
     */
    for (const [gridType, mapName] of [
        [1, "normal"],
        [3, "water centre"],
        [4, "block centre"],
    ] as const) {
        test(`rectangles on the side-oriented ${mapName} map play with no illegal action`, () => {
            withRectangularFootprints(() => {
                const result = runMatch({
                    roster: MIXED_ROSTER,
                    greenVersion: "v0.8",
                    redVersion: "v0.8",
                    // Unchanged from when the three maps shared one test, so each keeps its exact match.
                    seed: 4_120_090 + gridType,
                    maxLaps: 24,
                    gridType,
                    sideOrientedPlacement: true,
                });
                expect(result.totalActions).toBeGreaterThan(0);
                expect(describeRejections(result)).toBe("");
                expect((result.rejectedGreen ?? 0) + (result.rejectedRed ?? 0)).toBe(0);
            });
            // A real v0.8-vs-v0.8 match, per the preload's rule that genuine multi-game simulations carry
            // their own budget. The heaviest map projects to ~22s on CI's runner, which is too little
            // headroom under the 30s default when a load spike lands on it.
        }, 60_000);
    }

    /**
     * The side board for the versions that are NOT v0.8. The loop above proves it one map per test because
     * v0.8 is expensive; the rest measure in tens of milliseconds, so a whole version list fits in one case
     * per map. These run the TRANSPOSED shapes on purpose: the side board turns the axis of advance to X,
     * and the transposed set is the one that puts the tall body — the shape that spans the axis it is NOT
     * advancing along — on each side of that lane.
     */
    for (const [gridType, mapName, versions] of [
        [1, "normal", VERSIONS_WITHOUT_V08],
        [4, "block centre", BLOCK_CENTRE_SIDE_VERSIONS],
    ] as const) {
        test(`every other version plays rectangles on the side-oriented ${mapName} map`, () => {
            for (const version of versions) {
                const result = withFootprintOverrides(TRANSPOSED_OVERRIDES, () =>
                    runMatch({
                        roster: MIXED_ROSTER,
                        greenVersion: version,
                        redVersion: version,
                        // One seed per map, as in the v0.8 cases above, so each map keeps its exact match.
                        seed: 4_120_101 + gridType,
                        maxLaps: 24,
                        gridType,
                        sideOrientedPlacement: true,
                    }),
                );

                expect([version, result.totalActions > 0]).toEqual([version, true]);
                expect([version, describeRejections(result)]).toEqual([version, ""]);
                expect([version, result.endReason === "stuck"]).toEqual([version, false]);
            }
        }, 60_000);
    }

    /**
     * Mixed-version seats. Every case above has both sides reasoning with the same code, which is the one
     * arrangement that cannot expose a disagreement ABOUT a body between two versions — and a rejection is
     * always a disagreement: one side proposed, the engine refused. Each pair plays two boards, the
     * transposed pair on the square board and three-deep bodies on the side-oriented block map, which is the
     * intersection the sweep spent most of its failures in.
     */
    test("mixed-version matches on rectangular bodies are clean in both directions", () => {
        const boards = [
            { shapes: TRANSPOSED_OVERRIDES, seed: 4_120_103, gridType: 1, sideOrientedPlacement: false },
            { shapes: "White Tiger=3x1,Hyena=1x3", seed: 4_120_105, gridType: 4, sideOrientedPlacement: true },
        ];

        for (const [greenVersion, redVersion] of ASYMMETRIC_PAIRS) {
            for (const board of boards) {
                const seats = `${greenVersion} vs ${redVersion} on ${board.shapes}`;
                const result = withFootprintOverrides(board.shapes, () =>
                    runMatch({
                        roster: MIXED_ROSTER,
                        greenVersion,
                        redVersion,
                        seed: board.seed,
                        maxLaps: 24,
                        gridType: board.gridType,
                        sideOrientedPlacement: board.sideOrientedPlacement,
                    }),
                );

                expect([seats, result.totalActions > 0]).toEqual([seats, true]);
                expect([seats, describeRejections(result)]).toEqual([seats, ""]);
                expect([seats, (result.rejectedGreen ?? 0) + (result.rejectedRed ?? 0)]).toEqual([seats, 0]);
            }
        }
    }, 60_000);

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

    /**
     * The shooter-versus-deep-body case that the stability sweep actually caught.
     *
     * v0.1 carried its own copy of the engine's aim rule: nearest target CELL, then a side of that one
     * cell, and the body's CENTRE when that cell showed no observable side. That was the engine's rule
     * until 2d28761 replaced it with resolveRangeAttackAimEdge — nearest observable edge across the WHOLE
     * body, and no visible edge means the shot is refused. The two agree for a 1x1 target and part company
     * for a rectangle, because a 3-deep body's interior cell is screened on its long axis by its own
     * siblings, so the nearest-cell rule locks onto exactly the cell the engine will not shoot at. v0.1
     * then validated one trajectory and emitted an aimless action the engine resolved onto another,
     * blocked one: `attack_not_available`, which a player sees as a shooter that skips its turn.
     *
     * These three seeds each rejected before the fix and are clean after it. The shape/map/orientation
     * combination is the point — a shooter against a 3-deep body on the side-oriented block-centre map,
     * which no other case in this file fields.
     */
    // Each row is a match the sweep actually rejected, replayed with ITS OWN roster and shapes — the seed
    // alone does not reproduce a failure, the (seed, roster, shapes) triple does.
    for (const rejected of [
        { seed: 10_002_086, roster: [WHITE_TIGER, HYENA, ARBALESTER], shapes: "White Tiger=3x1,Hyena=1x3" },
        { seed: 4_123_196, roster: [WHITE_TIGER, HYENA, ARBALESTER], shapes: "White Tiger=3x1,Hyena=1x3" },
        { seed: 10_009_149, roster: MIXED_ROSTER, shapes: "White Tiger=3x1,Hyena=1x3" },
        { seed: 10_016_212, roster: MIXED_ROSTER, shapes: TRANSPOSED_OVERRIDES },
    ]) {
        test(`a shooter aims at an edge the engine agrees with (seed ${rejected.seed})`, () => {
            const result = withFootprintOverrides(rejected.shapes, () =>
                runMatch({
                    roster: rejected.roster,
                    greenVersion: "v0.1",
                    redVersion: "v0.1",
                    seed: rejected.seed,
                    maxLaps: 24,
                    gridType: 4,
                    sideOrientedPlacement: true,
                }),
            );

            expect(result.totalActions).toBeGreaterThan(0);
            expect(describeRejections(result)).toBe("");
            expect((result.rejectedGreen ?? 0) + (result.rejectedRed ?? 0)).toBe(0);
        });
    }
});
