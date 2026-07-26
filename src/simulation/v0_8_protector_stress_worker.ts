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
import { runV08ProtectorStressGame, type IV08ProtectorStressOptions } from "./v0_8_protector_stress";

if (!parentPort) throw new Error("v0_8_protector_stress_worker must run in a worker thread");
const options = (workerData as { options?: IV08ProtectorStressOptions } | undefined)?.options;
if (!options) throw new Error("v0_8_protector_stress_worker is missing options");

process.env.SIM_NO_ACTIONS = "1";
FightStateManager.getInstance();

parentPort.on("message", (message: { type: "game"; game: number } | { type: "stop" }) => {
    if (message.type === "stop") {
        parentPort!.close();
        return;
    }
    try {
        parentPort!.postMessage({
            type: "result",
            record: runV08ProtectorStressGame(options, message.game),
        });
    } catch (error) {
        parentPort!.postMessage({
            type: "fatal",
            error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
    }
});

parentPort.postMessage({ type: "ready" });
