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
import { parentPort, threadId, workerData } from "node:worker_threads";

import {
    assertV08A19F184LowerHumanPlacementWorkerEnvironment,
    playV08A19F184LowerHumanPlacementAbGame,
    v08A19F184LowerHumanPlacementEnvironmentSha256,
    type IV08A19F184LowerHumanPlacementAbWorkerRequest,
    type IV08A19F184LowerHumanPlacementAbWorkerResponse,
} from "./v0_8_a19_f184_lower_human_placement_ab";

if (!parentPort) throw new Error("v0_8_a19_f184_lower_human_placement_ab_worker must run in a worker thread");

const request = workerData as IV08A19F184LowerHumanPlacementAbWorkerRequest;
const isolateId = `${threadId}:${randomUUID()}`;

try {
    assertV08A19F184LowerHumanPlacementWorkerEnvironment();
    if (request.type === "probe") {
        parentPort!.postMessage({
            type: "probe",
            probeId: request.probeId,
            isolateId,
            environmentSha256: v08A19F184LowerHumanPlacementEnvironmentSha256(),
        } satisfies IV08A19F184LowerHumanPlacementAbWorkerResponse);
    } else {
        parentPort!.postMessage({
            type: "result",
            executionId: request.game.executionId,
            isolateId,
            outcome: playV08A19F184LowerHumanPlacementAbGame(request.game),
        } satisfies IV08A19F184LowerHumanPlacementAbWorkerResponse);
    }
} catch (error) {
    parentPort!.postMessage({
        type: "error",
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    } satisfies IV08A19F184LowerHumanPlacementAbWorkerResponse);
}

// workerData is one command: close immediately so no strategy/JIT state can flow into another scheduled game.
parentPort.close();
