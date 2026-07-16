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

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parentPort, workerData } from "node:worker_threads";

/**
 * Keep this bootstrap free of game/policy imports. Several historical strategies read experiment knobs at
 * module initialization, so sanitization must complete before the dynamic ladder import below.
 */

interface IWorkerData {
    manifestId: string;
    cell: {
        id: string;
        games: number;
    };
    worker: number;
    environment: Record<string, string>;
    environmentSha256: string;
    auditPath: string;
}

const data = workerData as IWorkerData;
if (!parentPort) throw new Error("v0_7_composed_ranked_ladder_worker must run as a worker thread");
const transpilerCacheDisabled = process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH;
if (transpilerCacheDisabled !== "0") {
    throw new Error("Worker requires inherited BUN_RUNTIME_TRANSPILER_CACHE_PATH=0");
}
for (const key of [
    "BUN_CONFIG",
    "BUN_OPTIONS",
    "BUN_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "LD_PRELOAD",
    "NODE_OPTIONS",
    "NODE_PATH",
    "TS_NODE_PROJECT",
    "TS_NODE_TRANSPILE_ONLY",
]) {
    if (process.env[key]) throw new Error(`Worker inherited forbidden runtime injection environment ${key}`);
}

const prefixes = ["V04_", "V05_", "V06_", "V07_", "SEARCH_", "Q2_", "CEM_"] as const;
const exact = new Set([
    "AUGCA_NOVISION",
    "BASE_VERSION",
    "FIGHT_MELEE_ROSTERS",
    "FORCE_CREATURES",
    "LEAGUE_INITIAL_POOL",
    "LEAGUE_MATRIX_FIGHT_VERSION",
    "LEAGUE_MATRIX_MAPS",
    "LIVETWIN",
    "MAPS",
    "OPT_VERSION",
    "OPT_WEIGHTS_ENV",
    "PHASE_B_RUN_FINGERPRINT",
    "RANDOM",
    "ROSTER_RANGED_MAX",
    "ROSTER_RANGED_MIN",
    "SIM_NO_ACTIONS",
    "SYNERGY_DUMP",
    "TEAM_WR_RANDOM",
    "VALUE_DATA",
    "VALUE_DATA_FEATURES",
]);
const isBehaviorKey = (key: string): boolean => exact.has(key) || prefixes.some((prefix) => key.startsWith(prefix));
const removedEnvironmentKeys = Object.keys(process.env).filter(isBehaviorKey).sort();
for (const key of removedEnvironmentKeys) delete process.env[key];
for (const [key, value] of Object.entries(data.environment)) process.env[key] = value;

if ("SIM_NO_ACTIONS" in process.env) throw new Error("SIM_NO_ACTIONS must be absent so executed actions are retained");
const effective = Object.fromEntries(
    Object.entries(process.env)
        .filter(([key]) => isBehaviorKey(key))
        .map(([key, value]) => [key, value!])
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
);
const fingerprint = createHash("sha256").update(JSON.stringify(effective)).digest("hex");
if (fingerprint !== data.environmentSha256) {
    throw new Error(`Worker environment fingerprint ${fingerprint} != ${data.environmentSha256}`);
}

mkdirSync(dirname(data.auditPath), { recursive: true });
writeFileSync(data.auditPath, "");

const ladder = await import("./v0_7_composed_ranked_ladder");

parentPort.on("message", (message: { type: "game"; game: number }) => {
    try {
        parentPort!.postMessage({
            type: "result",
            record: ladder.playV07ComposedGame(
                data.manifestId,
                data.cell as Parameters<typeof ladder.playV07ComposedGame>[1],
                message.game,
            ),
        });
    } catch (error) {
        parentPort!.postMessage({
            type: "error",
            error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
    }
});

parentPort.postMessage({
    type: "ready",
    attestation: {
        worker: data.worker,
        environmentSha256: fingerprint,
        removedEnvironmentKeys,
        transpilerCacheDisabled,
        auditFile: data.auditPath,
    },
});
