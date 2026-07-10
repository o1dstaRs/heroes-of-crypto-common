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

import { PAYOFF_CELLS, playArchetypeGame, type INormalizedArchetypePayoffOptions } from "./archetype_payoff";

if (!parentPort) {
    throw new Error("archetype_payoff_worker must be run as a worker thread");
}

const options = (workerData as { options: INormalizedArchetypePayoffOptions }).options;

parentPort.on("message", (message: { type: "game"; cellIndex: number; game: number } | { type: "stop" }) => {
    if (message.type === "stop") {
        parentPort!.close();
        return;
    }
    try {
        const cell = PAYOFF_CELLS[message.cellIndex];
        if (!cell) {
            throw new Error(`Unknown payoff cell index ${message.cellIndex}`);
        }
        const record = playArchetypeGame(cell, options, message.game);
        parentPort!.postMessage({ type: "result", record });
    } catch (error) {
        parentPort!.postMessage({
            type: "error",
            error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
    }
});

parentPort.postMessage({ type: "ready" });
