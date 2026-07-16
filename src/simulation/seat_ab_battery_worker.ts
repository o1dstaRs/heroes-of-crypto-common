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

import { FightStateManager } from "../fights/fight_state_manager";
import { runMatch, type IMatchConfig } from "./battle_engine";

/**
 * Worker half of seat_ab_battery.ts. Same two-file split as kit_omission_census_worker.ts and for the same
 * reason: the orchestrator resolves round-1 pick_sim drafts via league_eval.ts in the MAIN thread only (that
 * module's top-level `if (!isMainThread)` side effect would double-register a message handler on any worker
 * that imports it); workers receive fully-resolved plain-JSON IMatchConfigs and only run the fight. Env
 * gates (V06_RIDER_EV / V06_MELEE_DIMS / ... scoped to the candidate alias version) arrive via the
 * per-thread env copy worker_threads makes from the parent.
 */

if (!parentPort) throw new Error("seat_ab_battery_worker must be run as a worker thread");

FightStateManager.getInstance();

parentPort.on("message", (message: { type: "game"; game: number; config: IMatchConfig } | { type: "stop" }) => {
    if (message.type === "stop") {
        parentPort!.close();
        return;
    }
    try {
        const result = runMatch(message.config);
        parentPort!.postMessage({
            type: "result",
            game: message.game,
            winner: result.winner === "green" || result.winner === "red" ? result.winner : "draw",
            laps: result.laps,
            endReason: result.endReason,
        });
    } catch (error) {
        parentPort!.postMessage({
            type: "error",
            error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
    }
});

parentPort.postMessage({ type: "ready" });
