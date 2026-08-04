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

import { parentPort } from "node:worker_threads";

import {
    playV08A19F184HumanPlacementAbCluster,
    type IV08A19F184HumanPlacementAbWorkerRequest,
    type IV08A19F184HumanPlacementAbWorkerResponse,
} from "./v0_8_a19_f184_human_placement_ab";

if (!parentPort) throw new Error("v0_8_a19_f184_human_placement_ab_worker must run in a worker thread");

parentPort.on("message", (message: IV08A19F184HumanPlacementAbWorkerRequest) => {
    if (message.type === "stop") {
        parentPort!.close();
        return;
    }
    try {
        parentPort!.postMessage({
            type: "result",
            record: playV08A19F184HumanPlacementAbCluster(message.options, message.cluster),
        } satisfies IV08A19F184HumanPlacementAbWorkerResponse);
    } catch (error) {
        parentPort!.postMessage({
            type: "error",
            error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        } satisfies IV08A19F184HumanPlacementAbWorkerResponse);
    }
});

parentPort.postMessage({ type: "ready" } satisfies IV08A19F184HumanPlacementAbWorkerResponse);
