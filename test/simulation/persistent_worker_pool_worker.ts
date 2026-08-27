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

import { randomUUID } from "node:crypto";
import { threadId } from "node:worker_threads";

import { startPersistentWorker } from "../../src/simulation/persistent_worker_pool";

export interface IPoolFixtureRequest {
    readonly value: number;
    readonly delayMs?: number;
    readonly fail?: boolean;
    readonly crash?: boolean;
}

export interface IPoolFixtureResult {
    readonly value: number;
    readonly processId: number;
    readonly threadId: number;
    readonly initializationToken: string;
    readonly calls: number;
}

const initializationToken = randomUUID();
let calls = 0;

startPersistentWorker<IPoolFixtureRequest, IPoolFixtureResult>(async (request) => {
    calls += 1;
    if (request.delayMs) await Bun.sleep(request.delayMs);
    if (request.crash) process.exit(17);
    if (request.fail) throw new Error(`fixture failure ${request.value}`);
    return {
        value: request.value,
        processId: process.pid,
        threadId,
        initializationToken,
        calls,
    };
});
