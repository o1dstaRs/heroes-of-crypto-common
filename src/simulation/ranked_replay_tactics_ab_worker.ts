/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import { parentPort } from "node:worker_threads";

import {
    playRankedReplayAbCluster,
    type IRankedReplayAbClusterRecord,
    type IRankedReplayAbOptions,
} from "./ranked_replay_tactics_ab_core";

type WorkerRequest = { type: "cluster"; options: IRankedReplayAbOptions; pair: number } | { type: "stop" };
type WorkerResponse =
    { type: "ready" } | { type: "result"; record: IRankedReplayAbClusterRecord } | { type: "error"; error: string };

if (!parentPort) throw new Error("ranked_replay_tactics_ab_worker must run in a worker thread");

parentPort.on("message", (message: WorkerRequest) => {
    if (message.type === "stop") {
        parentPort!.close();
        return;
    }
    try {
        parentPort!.postMessage({
            type: "result",
            record: playRankedReplayAbCluster(message.options, message.pair),
        } satisfies WorkerResponse);
    } catch (error) {
        parentPort!.postMessage({
            type: "error",
            error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        } satisfies WorkerResponse);
    }
});

parentPort.postMessage({ type: "ready" } satisfies WorkerResponse);
