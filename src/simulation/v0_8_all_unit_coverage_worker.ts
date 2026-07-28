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

import { runV08AllUnitCoverageGame, type IV08AllUnitCoverageOptions } from "./v0_8_all_unit_coverage";

if (!parentPort) {
    throw new Error("v0_8_all_unit_coverage_worker must run as a worker thread");
}

const options = (workerData as { options: IV08AllUnitCoverageOptions }).options;

parentPort.on("message", (message: { type: "game"; game: number } | { type: "stop" }) => {
    if (message.type === "stop") {
        parentPort!.close();
        // Bun 1.3 can retain the registered parent-port listener after close(), leaving an otherwise idle
        // worker alive indefinitely. The parent sends stop only after this worker returned its last result,
        // so an explicit worker-local exit cannot truncate a game or a postMessage.
        process.exit(0);
    }
    parentPort!.postMessage({ type: "result", record: runV08AllUnitCoverageGame(options, message.game) });
});

parentPort.postMessage({ type: "ready" });
