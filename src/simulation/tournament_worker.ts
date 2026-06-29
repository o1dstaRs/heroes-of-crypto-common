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

import { parentPort, workerData } from "node:worker_threads";

import { playGame, type ITournamentOptions } from "./tournament";

/**
 * Worker side of the concurrent tournament. Each worker is its own isolate, so the singleton
 * FightStateManager the battle engine relies on is private to this thread — the worker plays ONE game
 * at a time (sequentially), and the pool runs many workers in parallel. The main thread hands out game
 * indices on demand (work-stealing) so longer matches don't stall a worker's share.
 */
if (!parentPort) {
    throw new Error("tournament_worker must be run as a worker thread");
}

const options = (workerData as { options: ITournamentOptions }).options;

parentPort.on("message", (message: { type: "game"; game: number } | { type: "stop" }) => {
    if (message.type === "stop") {
        parentPort!.close();
        return;
    }
    if (message.type === "game") {
        const record = playGame(options, message.game);
        parentPort!.postMessage({ type: "result", record });
    }
});

// Signal readiness so the pool can dispatch the first game.
parentPort.postMessage({ type: "ready" });
