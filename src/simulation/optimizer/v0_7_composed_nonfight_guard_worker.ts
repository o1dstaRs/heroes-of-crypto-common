/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 * Import-free runtime seal for composed non-fight evaluation workers.
 */

import { createHash } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";

interface IWorkerData {
    v07ComposedNonfightGuardWorker: true;
    candidate: unknown;
    baseline: unknown;
    environmentSha256: string;
    runtimeControlsSha256: string;
}

const data = workerData as IWorkerData;
if (!parentPort || data.v07ComposedNonfightGuardWorker !== true) {
    throw new Error("v0_7_composed_nonfight_guard_worker must run as a sealed worker thread");
}

const runtimeInjectionKeys = new Set([
    "BUN_CONFIG",
    "BUN_OPTIONS",
    "BUN_PRELOAD",
    "LD_LIBRARY_PATH",
    "LD_PRELOAD",
    "NODE_OPTIONS",
    "NODE_PATH",
    "TS_NODE_PROJECT",
    "TS_NODE_TRANSPILE_ONLY",
]);
const behaviorPattern = /^(?:V\d+_|SEARCH_|Q\d+_|CEM_|FIGHT_|ROSTER_|AUGCA_)/;
const behaviorExact = new Set([
    "AUGCA_NOVISION",
    "BASE_VERSION",
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
    "SIM_NO_ACTIONS",
    "SYNERGY_DUMP",
    "TEAM_WR_RANDOM",
    "VALUE_DATA",
    "VALUE_DATA_FEATURES",
]);
const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, entry]) => [key, canonical(entry)]),
        );
    }
    return value;
};
const fingerprint = (value: unknown): string =>
    createHash("sha256")
        .update(JSON.stringify(canonical(value)))
        .digest("hex");

const injected = Object.keys(process.env).filter(
    (key) => runtimeInjectionKeys.has(key) || key.startsWith("DYLD_") || key.startsWith("BUN_PRELOAD_"),
);
if (injected.length) throw new Error(`sealed worker inherited runtime injection: ${injected.sort().join(", ")}`);
if (process.execArgv.length) throw new Error(`sealed worker inherited execArgv: ${process.execArgv.join(", ")}`);
if (process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH !== "0") {
    throw new Error("sealed worker requires BUN_RUNTIME_TRANSPILER_CACHE_PATH=0");
}

const effectiveEnvironment = Object.fromEntries(
    Object.entries(process.env)
        .filter(([key, value]) => value !== undefined && (behaviorPattern.test(key) || behaviorExact.has(key)))
        .map(([key, value]) => [key, value!])
        .sort(([left], [right]) => left.localeCompare(right)),
);
const expectedEnvironment = { LIVETWIN: "1", V07_PLACEMENT_REVEAL: "on", V07_SEARCH: "0" };
if (
    fingerprint(effectiveEnvironment) !== data.environmentSha256 ||
    fingerprint(expectedEnvironment) !== data.environmentSha256
) {
    throw new Error("sealed worker behavior environment differs from the manifest contract");
}
const runtimeControls = {
    bunRuntimeTranspilerCachePath: "0",
    workerExecArgv: [],
    fightVersion: "v0.7",
    maxLaps: 60,
    maps: [1, 3, 4],
};
if (fingerprint(runtimeControls) !== data.runtimeControlsSha256) {
    throw new Error("sealed worker runtime controls differ from the manifest contract");
}

const guard = await import("./v0_7_composed_nonfight_guard");
type WorkerRequest =
    | { type: "job"; board: Parameters<typeof guard.evaluateV07ComposedCluster>[2] }
    | { type: "inspect"; board: Parameters<typeof guard.inspectV07ComposedBoardCohorts>[2] }
    | { type: "stop" };

parentPort.on("message", (message: WorkerRequest) => {
    if (message.type === "stop") {
        parentPort!.close();
        return;
    }
    try {
        if (message.type === "inspect") {
            parentPort!.postMessage({
                type: "inspection",
                board: message.board,
                cohorts: guard.inspectV07ComposedBoardCohorts(
                    data.candidate as Parameters<typeof guard.inspectV07ComposedBoardCohorts>[0],
                    data.baseline as Parameters<typeof guard.inspectV07ComposedBoardCohorts>[1],
                    message.board,
                ),
            });
        } else {
            parentPort!.postMessage({
                type: "result",
                cluster: guard.evaluateV07ComposedCluster(
                    data.candidate as Parameters<typeof guard.evaluateV07ComposedCluster>[0],
                    data.baseline as Parameters<typeof guard.evaluateV07ComposedCluster>[1],
                    message.board,
                ),
            });
        }
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
        environmentSha256: fingerprint(effectiveEnvironment),
        runtimeControlsSha256: fingerprint(runtimeControls),
        execArgv: [...process.execArgv],
    },
});
