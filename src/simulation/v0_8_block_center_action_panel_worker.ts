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

import {
    runV08BlockCenterActionPanelGame,
    type IV08BlockCenterActionPanelOptions,
} from "./v0_8_block_center_action_panel";

if (!parentPort) throw new Error("v0_8_block_center_action_panel_worker must run as a worker thread");

const options = (workerData as { options: IV08BlockCenterActionPanelOptions }).options;

parentPort.on("message", (message: { type: "game"; game: number } | { type: "stop" }) => {
    if (message.type === "stop") {
        parentPort!.close();
        process.exit(0);
    }
    parentPort!.postMessage({ type: "result", record: runV08BlockCenterActionPanelGame(options, message.game) });
});

parentPort.postMessage({ type: "ready" });
