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

import { runV08Level4CoverageGame, type IV08Level4CoverageOptions } from "../../src/simulation/v0_8_l4_coverage";

export const V08_LEVEL4_A13_REGRESSION_GAMES = [137, 156, 157] as const;
export const V08_LEVEL4_V07_REGRESSION_GAMES = [148, 219] as const;
export const V08_LEVEL4_REGRESSION_SEEDS = {
    137: 1_786_722_209,
    148: 146_190_674,
    156: 146_190_674,
    157: 146_190_674,
    219: 2_173_999_126,
} as const;

type Level4RegressionGame =
    (typeof V08_LEVEL4_A13_REGRESSION_GAMES)[number] | (typeof V08_LEVEL4_V07_REGRESSION_GAMES)[number];

const EXACT_FAILURE_OPTIONS: IV08Level4CoverageOptions = {
    candidateVersion: "v0.8",
    opponentVersion: "v0.7",
    pairsPerLane: 16,
    baseSeed: 2026072601,
    // Deterministic search work, not wall-clock: under the parallel suite's CPU contention the wall
    // clock shortens the search and this exact seeded game stops being the same game (observed as
    // phantom rejections after the mounted-class catalog change re-rolled the trajectory).
    searchOfflineDeterministicWork: true,
};

export function registerV08Level4CoverageRegression(game: Level4RegressionGame): void {
    describe("v0.8 forced level-4 coverage", () => {
        test(`keeps exact Terrifying Gaze game ${game} rejection-free`, () => {
            // Bun's file worker is the isolate: FightStateManager remains process-local without nesting a
            // second worker_threads pool beneath the already-parallel test runner.
            const result = runV08Level4CoverageGame(EXACT_FAILURE_OPTIONS, game);
            expect(result).toMatchObject({ game, seed: V08_LEVEL4_REGRESSION_SEEDS[game] });
            expect(result.rejectedCandidate).toBe(0);
            if ((V08_LEVEL4_V07_REGRESSION_GAMES as readonly number[]).includes(game)) {
                expect(result.rejectedOpponent).toBe(0);
            }
        }, 30_000);
    });
}
