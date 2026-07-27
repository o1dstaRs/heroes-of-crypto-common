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

import { runV08PassiveTurnPanelGame, type IV08PassiveTurnPanelOptions } from "./v0_8_passive_turn_panel";

if (!parentPort) {
    throw new Error("v0_8_passive_turn_panel_worker must run as a worker thread");
}

process.env.SIM_NO_ACTIONS = "1";
const options = (workerData as { options: IV08PassiveTurnPanelOptions }).options;

parentPort.on("message", (message: { type: "game"; game: number } | { type: "stop" }) => {
    if (message.type === "stop") {
        parentPort!.close();
        return;
    }
    parentPort!.postMessage({ type: "result", record: runV08PassiveTurnPanelGame(options, message.game) });
});

parentPort.postMessage({ type: "ready" });
