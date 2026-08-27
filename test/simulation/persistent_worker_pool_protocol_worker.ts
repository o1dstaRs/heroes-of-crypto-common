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

import type { PersistentWorkerRequest, PersistentWorkerResponse } from "../../src/simulation/persistent_worker_pool";

export interface IProtocolFixtureRequest {
    readonly value: number;
    readonly wrongTaskId?: boolean;
}

if (!parentPort) throw new Error("persistent_worker_pool_protocol_worker must run in a worker thread");

parentPort.on("message", (message: PersistentWorkerRequest<IProtocolFixtureRequest>) => {
    if (message.type === "stop") {
        parentPort!.close();
        return;
    }
    parentPort!.postMessage({
        type: "result",
        taskId: message.taskId + (message.payload.wrongTaskId ? 1 : 0),
        result: message.payload.value,
    } satisfies PersistentWorkerResponse<number>);
});
parentPort.postMessage({ type: "ready" } satisfies PersistentWorkerResponse<number>);
