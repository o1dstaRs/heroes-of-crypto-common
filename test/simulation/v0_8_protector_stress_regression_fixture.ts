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

import { runV08ProtectorStressGame, type IV08ProtectorStressOptions } from "../../src/simulation/v0_8_protector_stress";

export const V08_PROTECTOR_STRESS_REGRESSION_GAMES = [11, 72] as const;
export const V08_PROTECTOR_STRESS_REGRESSION_SEEDS = {
    11: 2_527_619_087,
    72: 2_744_636_805,
} as const;

const REGRESSION_OPTIONS: IV08ProtectorStressOptions = {
    games: 2,
    baseSeed: 80_813_441,
    concurrency: 2,
    maxLaps: 60,
};

export function registerV08ProtectorStressRegression(
    game: (typeof V08_PROTECTOR_STRESS_REGRESSION_GAMES)[number],
): void {
    describe("v0.8 protector production regressions", () => {
        test(`keeps live ward game ${game} from melee-rushing out of Flesh Shield`, () => {
            // Bun's file worker is the isolate: FightStateManager remains process-local without nesting a
            // second worker_threads pool beneath the already-parallel test runner. Retain the production
            // worker's no-actions environment and restore it so direct single-file runs remain isolated too.
            const savedNoActions = process.env.SIM_NO_ACTIONS;
            process.env.SIM_NO_ACTIONS = "1";
            try {
                const record = runV08ProtectorStressGame(REGRESSION_OPTIONS, game);

                expect(record).toMatchObject({ game, seed: V08_PROTECTOR_STRESS_REGRESSION_SEEDS[game] });
                expect(record.endReason).not.toBe("crash");
                expect(record.rejectedActions).toBe(0);
                expect(record.metrics.wardGuardBreakingFinalActions).toBe(0);
                expect(record.metrics.wardRushViolations).toBe(0);
                expect(record.metrics.abominationCoverageGapTurns).toBe(0);
                expect(record.metrics.abominationExactRangeViolations).toBe(0);
            } finally {
                if (savedNoActions === undefined) delete process.env.SIM_NO_ACTIONS;
                else process.env.SIM_NO_ACTIONS = savedNoActions;
            }
        }, 30_000);
    });
}
