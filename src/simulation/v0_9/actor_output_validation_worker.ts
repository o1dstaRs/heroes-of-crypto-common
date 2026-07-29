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

import type { IV09ActorShardValidationWorkerData, V09ActorShardValidationResult } from "./actor_output_validation";
import { validateV09GameShard } from "./recorder";

if (!parentPort) {
    throw new Error("v0.9 actor shard validation worker requires a parent port");
}

const { tasks } = workerData as IV09ActorShardValidationWorkerData;
const results: V09ActorShardValidationResult[] = tasks.map(({ index, path }) => {
    try {
        return { index, ok: true, footer: validateV09GameShard(path) };
    } catch (error) {
        return {
            index,
            ok: false,
            error:
                error instanceof Error
                    ? { name: error.name, message: error.message }
                    : { name: "Error", message: String(error) },
        };
    }
});
parentPort.postMessage(results);
