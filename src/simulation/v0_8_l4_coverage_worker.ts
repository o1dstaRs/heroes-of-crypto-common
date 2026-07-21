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

import { runV08Level4CoverageGame, type IV08Level4CoverageOptions } from "./v0_8_l4_coverage";

if (!parentPort) {
    throw new Error("v0_8_l4_coverage_worker must run as a worker thread");
}

const options = (workerData as { options: IV08Level4CoverageOptions }).options;

parentPort.on("message", (message: { type: "game"; game: number } | { type: "stop" }) => {
    if (message.type === "stop") {
        parentPort!.close();
        return;
    }
    parentPort!.postMessage({ type: "result", record: runV08Level4CoverageGame(options, message.game) });
});

parentPort.postMessage({ type: "ready" });
