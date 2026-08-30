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

import { playMetaPair } from "./ai_meta_cohorts_pair";
import { type AiMetaProcessRequest, type AiMetaProcessResponse } from "./ai_meta_cohorts_process_protocol";

// Match the worker-thread transport's defense-in-depth controls. The parent also launches this process with a
// sanitized, exact-profile environment so static fight-policy imports observe the frozen study configuration.
process.env.SIM_NO_ACTIONS = "1";
process.env.LIVETWIN = "1";
process.env.FIGHT_MELEE_ROSTERS = "0";

if (!process.send) throw new Error("ai_meta_cohorts_process_worker requires Bun IPC");

let busy = false;
process.on("message", (message: AiMetaProcessRequest) => {
    if (message.type === "stop") {
        if (busy) throw new Error("AI meta process worker received stop while busy");
        process.disconnect?.();
        return;
    }
    if (busy) {
        process.send?.({
            type: "error",
            taskId: message.taskId,
            error: "AI meta process worker received overlapping tasks",
        } satisfies AiMetaProcessResponse);
        return;
    }
    busy = true;
    try {
        process.send?.({
            type: "result",
            taskId: message.taskId,
            record: playMetaPair(message.task.options, message.task.pair, message.task.strategyProfileId),
        } satisfies AiMetaProcessResponse);
    } catch (error) {
        process.send?.({
            type: "error",
            taskId: message.taskId,
            error: error instanceof Error ? `${error.stack ?? error.message}` : String(error),
        } satisfies AiMetaProcessResponse);
    } finally {
        busy = false;
    }
});

process.send({ type: "ready" } satisfies AiMetaProcessResponse);
