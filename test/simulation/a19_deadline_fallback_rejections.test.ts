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
import { Worker } from "node:worker_threads";

import type { AiMetaCohort, IAiMetaGameOutcome } from "../../src/simulation/ai_meta_cohorts_core";
import { resolveAiMetaFightProfile, sanitizedAiMetaEnvironment } from "../../src/simulation/measure_ai_meta_cohorts";

/**
 * A timed-out a19 search returns the native v0.8 incumbent unscored, so any engine-illegal plan that full search
 * normally out-scores reaches the board. On a loaded host (puffalo at 24 shards, 2026-09-13) that surfaced three
 * rejected attacks in 7,056 meta games. Each pair below reproduced one of them on every forced timeout:
 *   - ranged-heavy 63: a 2x2 Behemoth walks onto a Fire Wall under a NON-anchor body cell and dies; the planned
 *     strike then names a removed attacker (unit_not_found).
 *   - flyer-heavy 137: a 2x1 Wolf stack is thinned the same way, so Cowardice bars its planned strike.
 *   - cross-archetype 249: a Medusa's aimless shot was validated on the nearest cell's nearest side while the
 *     engine fires at the nearest observable edge overall, which lay behind a Block Center mountain.
 * The pair indexes re-shuffle whenever the seeded drafts change; the general contract — no rejected command from
 * a deadline fallback — is what stays pinned.
 */
const REPRO_PAIRS: { cohort: AiMetaCohort; pair: number }[] = [
    { cohort: "ranged-heavy", pair: 63 },
    { cohort: "flyer-heavy", pair: 137 },
    { cohort: "cross-archetype", pair: 249 },
];

type PairGames = { cohort: AiMetaCohort; pair: number; games: IAiMetaGameOutcome[] };

const playWithForcedDeadlines = (): Promise<PairGames[]> =>
    new Promise((resolve, reject) => {
        const fightProfile = resolveAiMetaFightProfile("a19");
        const worker = new Worker(new URL("../fixtures/a19_forced_truncation_worker.ts", import.meta.url), {
            workerData: { pairs: REPRO_PAIRS, strategyProfileId: fightProfile.strategyProfileId },
            env: {
                ...sanitizedAiMetaEnvironment(process.env, fightProfile),
                // Keep every decision on the deadline-fallback path rather than the circuit-open skip.
                SEARCH_CIRCUIT_BREAKER_MS: "1000000000",
            },
        });
        worker.once("error", reject);
        worker.once("message", (message: { type: "result" | "error"; games?: PairGames[]; error?: string }) => {
            void worker.terminate();
            if (message.type === "result" && message.games) {
                resolve(message.games);
            } else {
                reject(new Error(message.error ?? "forced truncation worker failed"));
            }
        });
    });

describe("a19 deadline fallback", () => {
    it("never emits an engine-rejected command when every search times out", async () => {
        const results = await playWithForcedDeadlines();

        expect(results.map(({ cohort, pair }) => `${cohort}:${pair}`)).toEqual(
            REPRO_PAIRS.map(({ cohort, pair }) => `${cohort}:${pair}`),
        );
        const rejected = results.flatMap(({ cohort, pair, games }) =>
            games
                .filter((game) => game.rejectedA + game.rejectedB > 0)
                .map((game) => `${cohort}:${pair} aIsGreen=${game.aIsGreen} A=${game.rejectedA} B=${game.rejectedB}`),
        );
        expect(rejected).toEqual([]);
    }, 120_000);
});
