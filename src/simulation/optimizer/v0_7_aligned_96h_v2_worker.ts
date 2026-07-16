/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parentPort, workerData } from "node:worker_threads";

/** Keep this bootstrap free of game/policy imports until the environment is scrubbed and attested. */

interface IWorkerEnvelope {
    marker: "v0_7_aligned_96h_v2_worker";
    workerIndex: number;
    runFingerprint: string;
    auditPath: string;
    binding: unknown;
    environment: Record<string, string>;
    environmentSha256: string;
}

const data = workerData as IWorkerEnvelope;
if (!parentPort) throw new Error("aligned v2 worker must run in a worker thread");
if (data.marker !== "v0_7_aligned_96h_v2_worker") throw new Error("aligned v2 worker marker mismatch");
if (process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH !== "0") {
    throw new Error("aligned v2 worker requires BUN_RUNTIME_TRANSPILER_CACHE_PATH=0");
}

const forbiddenRuntimeEnvironment = [
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
] as const;
for (const key of forbiddenRuntimeEnvironment) {
    if (process.env[key]) throw new Error(`aligned v2 worker inherited forbidden runtime environment ${key}`);
}

const behaviorPrefixes = ["V04_", "V05_", "V06_", "V07_", "SEARCH_", "Q2_", "CEM_"] as const;
const behaviorExact = new Set([
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
const isBehaviorKey = (key: string): boolean =>
    behaviorExact.has(key) || behaviorPrefixes.some((prefix) => key.startsWith(prefix));
const removedEnvironmentKeys = Object.keys(process.env).filter(isBehaviorKey).sort();
for (const key of removedEnvironmentKeys) delete process.env[key];
for (const [key, value] of Object.entries(data.environment)) {
    if (!isBehaviorKey(key)) throw new Error(`aligned v2 worker envelope contains non-behavior key ${key}`);
    process.env[key] = value;
}

const effective = Object.fromEntries(
    Object.entries(process.env)
        .filter((entry): entry is [string, string] => entry[1] !== undefined && isBehaviorKey(entry[0]))
        .sort(([left], [right]) => left.localeCompare(right)),
);
const environmentSha256 = createHash("sha256").update(JSON.stringify(effective)).digest("hex");
if (environmentSha256 !== data.environmentSha256 || JSON.stringify(effective) !== JSON.stringify(data.environment)) {
    throw new Error("aligned v2 worker environment fingerprint mismatch");
}

mkdirSync(dirname(data.auditPath), { recursive: true });
writeFileSync(data.auditPath, "");

const protocol = await import("./v0_7_aligned_96h_v2_protocol");
const binding = protocol.validateV07AlignedV2CandidateBinding(
    data.binding as Parameters<typeof protocol.validateV07AlignedV2CandidateBinding>[0],
);
const gameAdapter = await import("./v0_7_aligned_96h_v2_game_adapter");

let auditByteOffset = 0;
let busy = false;
parentPort.on("message", (message: { type: "evaluate"; task: unknown } | { type: "stop" }) => {
    if (message.type === "stop") {
        parentPort!.postMessage({ type: "stopped" });
        parentPort!.close();
        process.exit(0);
        return;
    }
    if (busy) {
        parentPort!.postMessage({ type: "error", error: "aligned v2 worker received overlapping tasks" });
        return;
    }
    busy = true;
    try {
        const task = message.task as Parameters<typeof gameAdapter.playV07AlignedV2Task>[0];
        const record = gameAdapter.playV07AlignedV2Task(task);
        const appended = gameAdapter.readV07AlignedV2AuditAppend(data.auditPath, auditByteOffset);
        auditByteOffset = appended.nextByteOffset;
        const expectedRows = binding.searchEnabled ? 1 : 0;
        if (appended.rows.length !== expectedRows) {
            throw new Error(
                `${protocol.v07AlignedV2TaskKey(task)}: expected ${expectedRows} exact audit rows, received ${appended.rows.length}`,
            );
        }
        const observation = gameAdapter.compactV07AlignedV2Observation(record, binding, appended.rows[0]);
        parentPort!.postMessage({
            type: "result",
            taskKey: protocol.v07AlignedV2TaskKey(task),
            record,
            observation,
        });
    } catch (error) {
        parentPort!.postMessage({
            type: "error",
            error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
    } finally {
        busy = false;
    }
});

parentPort.postMessage({
    type: "ready",
    attestation: {
        workerIndex: data.workerIndex,
        runFingerprint: data.runFingerprint,
        genomeSha256: binding.genomeSha256,
        behaviorEnvironmentSha256: binding.behaviorEnvironmentSha256,
        environmentSha256,
        removedEnvironmentKeys,
        transpilerCacheDisabled: "0",
        auditPath: data.auditPath,
    },
});
