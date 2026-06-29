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

import { Worker } from "node:worker_threads";

import {
    createTally,
    finalizeTally,
    runTournament,
    tallyGame,
    type IGameRecord,
    type ITournamentOptions,
    type ITournamentSummary,
} from "./tournament";

/**
 * Run a tournament across a pool of `concurrency` worker threads. The battle engine uses a singleton
 * (FightStateManager), so games must NOT share a thread — each worker is a separate isolate running one
 * game at a time, and the pool runs up to `concurrency` of them in parallel. Game indices are dispatched
 * on demand (work-stealing) for even load. `onGame` fires as each game finishes (completion order, not
 * game order — every record carries its own `game` index). With concurrency <= 1 it runs in-thread.
 *
 * Returns the same ITournamentSummary as runTournament; the tally is order-independent so parallelism
 * does not change the aggregate result.
 */
export function runTournamentConcurrent(
    options: ITournamentOptions,
    concurrency: number,
    onGame?: (record: IGameRecord) => void,
): Promise<ITournamentSummary> {
    const total = options.games;
    const poolSize = Math.max(1, Math.min(Math.floor(concurrency) || 1, total));

    if (poolSize <= 1 || total <= 1) {
        return Promise.resolve(runTournament(options, onGame));
    }

    return new Promise<ITournamentSummary>((resolve, reject) => {
        const tally = createTally(options);
        const workers: Worker[] = [];
        let dispatched = 0;
        let completed = 0;
        let settled = false;

        const cleanup = (): void => {
            for (const worker of workers) {
                void worker.terminate();
            }
        };
        const fail = (err: unknown): void => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            reject(err instanceof Error ? err : new Error(String(err)));
        };
        const dispatchNext = (worker: Worker): void => {
            if (dispatched >= total) {
                worker.postMessage({ type: "stop" });
                return;
            }
            worker.postMessage({ type: "game", game: dispatched });
            dispatched += 1;
        };

        const workerUrl = new URL("./tournament_worker.ts", import.meta.url);
        for (let i = 0; i < poolSize; i += 1) {
            let worker: Worker;
            try {
                worker = new Worker(workerUrl, { workerData: { options } });
            } catch (err) {
                fail(err);
                return;
            }
            workers.push(worker);
            worker.on("message", (message: { type: "ready" } | { type: "result"; record: IGameRecord }) => {
                if (settled) {
                    return;
                }
                if (message.type === "ready") {
                    dispatchNext(worker);
                    return;
                }
                if (message.type === "result") {
                    onGame?.(message.record);
                    tallyGame(tally, message.record, options);
                    completed += 1;
                    if (completed >= total) {
                        settled = true;
                        resolve(finalizeTally(tally, options));
                        cleanup();
                        return;
                    }
                    dispatchNext(worker);
                }
            });
            worker.on("error", fail);
        }
    });
}
