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
    playV08A19PlacementAbCluster,
    type IV08A19PlacementAbClusterOptions,
    type IV08A19PlacementAbClusterRecord,
} from "./v0_8_a19_placement_ab";

type WorkerRequest = { type: "cluster"; options: IV08A19PlacementAbClusterOptions; cluster: number } | { type: "stop" };
type WorkerResponse =
    { type: "ready" } | { type: "result"; record: IV08A19PlacementAbClusterRecord } | { type: "error"; error: string };

if (!parentPort) throw new Error("v0_8_a19_placement_ab_worker must run in a worker thread");

parentPort.on("message", (message: WorkerRequest) => {
    if (message.type === "stop") {
        parentPort!.close();
        return;
    }
    try {
        parentPort!.postMessage({
            type: "result",
            record: playV08A19PlacementAbCluster(message.options, message.cluster),
        } satisfies WorkerResponse);
    } catch (error) {
        parentPort!.postMessage({
            type: "error",
            error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        } satisfies WorkerResponse);
    }
});

parentPort.postMessage({ type: "ready" } satisfies WorkerResponse);
