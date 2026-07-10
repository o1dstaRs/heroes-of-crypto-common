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

import { FightStateManager } from "../fights/fight_state_manager";
import { playMisplayAuditGame, type INormalizedMisplayAuditOptions } from "./misplay_audit";

if (!parentPort) throw new Error("misplay_audit_worker must be run as a worker thread");

const options = (workerData as { options: INormalizedMisplayAuditOptions }).options;
process.env.SIM_NO_ACTIONS = "1";
FightStateManager.getInstance();

parentPort.on("message", (message: { type: "game"; game: number } | { type: "stop" }) => {
    if (message.type === "stop") {
        parentPort!.close();
        return;
    }
    try {
        parentPort!.postMessage({ type: "result", tally: playMisplayAuditGame(options, message.game) });
    } catch (error) {
        parentPort!.postMessage({
            type: "error",
            error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
    }
});

parentPort.postMessage({ type: "ready" });
