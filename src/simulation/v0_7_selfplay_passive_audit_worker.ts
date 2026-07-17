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
import type {
    IV07SelfplayPassiveAuditShardPayload,
    IV07SelfplayPassiveAuditShardSpec,
} from "./run_v0_7_selfplay_passive_audit";
import {
    createV07SelfplayPassiveAuditTally,
    mergeV07SelfplayPassiveAuditTallies,
    playV07SelfplayPassiveAuditGame,
} from "./v0_7_selfplay_passive_audit";

if (!parentPort) throw new Error("v0_7_selfplay_passive_audit_worker must run in a worker thread");

const options = (workerData ?? {}) as { maxLaps?: number };
process.env.SIM_NO_ACTIONS = "1";
FightStateManager.getInstance();

parentPort.on("message", (message: { type: "run"; shard: IV07SelfplayPassiveAuditShardSpec } | { type: "stop" }) => {
    if (message.type === "stop") {
        parentPort!.close();
        return;
    }
    try {
        const tally = createV07SelfplayPassiveAuditTally();
        const clusters: IV07SelfplayPassiveAuditShardPayload["clusters"] = [];
        for (let index = 0; index < message.shard.seeds.length; index += 1) {
            const game = message.shard.gameStart + index;
            const result = playV07SelfplayPassiveAuditGame({
                template: message.shard.template,
                game,
                seed: message.shard.seeds[index],
                maxLaps: options.maxLaps,
            });
            mergeV07SelfplayPassiveAuditTallies(tally, result.tally);
            clusters.push(result.cluster);
        }
        const payload: IV07SelfplayPassiveAuditShardPayload = {
            schemaVersion: 1,
            shardId: message.shard.id,
            shardSha256: message.shard.shardSha256,
            games: message.shard.seeds.length,
            tally,
            clusters,
        };
        parentPort!.postMessage({ type: "result", shardId: message.shard.id, payload });
    } catch (error) {
        parentPort!.postMessage({
            type: "error",
            shardId: message.shard.id,
            error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
    }
});

parentPort.postMessage({ type: "ready" });
