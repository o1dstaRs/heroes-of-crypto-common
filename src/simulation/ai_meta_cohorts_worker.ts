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

import { type IAiMetaPairRecord, type IAiMetaRunOptions } from "./ai_meta_cohorts_core";
import { playMetaPair } from "./ai_meta_cohorts_pair";
import { type AiMetaStrategyProfileId } from "./ai_meta_strategy_profile";

interface IAiMetaWorkerData {
    options: IAiMetaRunOptions;
    strategyProfileId: AiMetaStrategyProfileId;
}

type WorkerRequest = { type: "pair"; pair: number } | { type: "stop" };
type WorkerResponse =
    { type: "ready" } | { type: "result"; record: IAiMetaPairRecord } | { type: "error"; error: string };

// Freeze the behavioral environment inside the isolate. Ambient experiment flags must not silently change a
// million-game balance run. SIM_NO_ACTIONS keeps worker messages small; all requested aggregate outcomes remain.
// The parent passes a sanitized Worker `env`, which takes effect before these static imports execute.
// Reassert the three fixed runtime controls as defense in depth.
process.env.SIM_NO_ACTIONS = "1";
process.env.LIVETWIN = "1";
process.env.FIGHT_MELEE_ROSTERS = "0";

if (!parentPort) throw new Error("ai_meta_cohorts_worker must run in a worker thread");
const { options, strategyProfileId } = workerData as IAiMetaWorkerData;

parentPort.on("message", (message: WorkerRequest) => {
    if (message.type === "stop") {
        parentPort!.close();
        return;
    }
    try {
        parentPort!.postMessage({
            type: "result",
            record: playMetaPair(options, message.pair, strategyProfileId),
        } satisfies WorkerResponse);
    } catch (error) {
        parentPort!.postMessage({
            type: "error",
            error: error instanceof Error ? `${error.stack ?? error.message}` : String(error),
        } satisfies WorkerResponse);
    }
});

parentPort.postMessage({ type: "ready" } satisfies WorkerResponse);
