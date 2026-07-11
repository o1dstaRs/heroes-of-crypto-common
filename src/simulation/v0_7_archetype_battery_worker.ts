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

import { playV07ArchetypeGame, type IV07ArchetypeCellSpec } from "./v0_7_archetype_battery";

if (!parentPort) throw new Error("v0_7_archetype_battery_worker must run as a worker thread");

const spec = (workerData as { spec: IV07ArchetypeCellSpec }).spec;

parentPort.on("message", (message: { type: "game"; game: number } | { type: "stop" }) => {
    if (message.type === "stop") {
        parentPort!.close();
        return;
    }
    try {
        parentPort!.postMessage({ type: "result", record: playV07ArchetypeGame(spec, message.game) });
    } catch (error) {
        parentPort!.postMessage({
            type: "error",
            error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
    }
});

parentPort.postMessage({ type: "ready" });
