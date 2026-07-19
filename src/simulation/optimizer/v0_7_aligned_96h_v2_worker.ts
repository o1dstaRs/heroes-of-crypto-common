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

/** Keep this bootstrap free of game/policy imports until the environment is scrubbed and attested. */

interface IWorkerEnvelope {
    marker: "v0_7_aligned_96h_v2_worker" | "v0_8_aligned_96h_v1_worker";
    workerIndex: number;
    runFingerprint: string;
    auditPath: string;
    binding: unknown;
    environment: Record<string, string>;
    environmentSha256: string;
}

interface IInitializeMessage {
    type: "initialize";
    data: IWorkerEnvelope;
}

if (!process.send || !process.connected) throw new Error("aligned v2 worker requires an authenticated IPC parent");
const data = await new Promise<IWorkerEnvelope>((resolveData, rejectData) => {
    const timeout = setTimeout(() => rejectData(new Error("aligned v2 worker initialization timed out")), 30_000);
    const onDisconnect = (): void => {
        clearTimeout(timeout);
        rejectData(new Error("aligned v2 worker parent disconnected before initialization"));
    };
    process.once("disconnect", onDisconnect);
    process.once("message", (message: unknown) => {
        clearTimeout(timeout);
        process.off("disconnect", onDisconnect);
        if (
            typeof message !== "object" ||
            message === null ||
            (message as Partial<IInitializeMessage>).type !== "initialize" ||
            typeof (message as Partial<IInitializeMessage>).data !== "object" ||
            (message as Partial<IInitializeMessage>).data === null
        ) {
            rejectData(new Error("aligned v2 worker received an invalid initialization envelope"));
            return;
        }
        resolveData((message as IInitializeMessage).data);
    });
});
if (data.marker !== "v0_7_aligned_96h_v2_worker" && data.marker !== "v0_8_aligned_96h_v1_worker") {
    throw new Error("aligned worker marker mismatch");
}
const isV08 = data.marker === "v0_8_aligned_96h_v1_worker";
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

const behaviorPrefixes = ["V04_", "V05_", "V06_", "V07_", "V08_", "SEARCH_", "Q2_", "CEM_"] as const;
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
    "V07_AURA_CASTER_ROUTER_VERSIONS",
    "V07_DENSE_MM_SALVAGE_ISOLATION_VERSIONS",
    "V07_PLACEMENT_REVEAL_VERSIONS",
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

interface IWorkerBinding {
    genomeSha256: string;
    behaviorEnvironmentSha256: string;
    nonfightBindingSha256?: string;
    searchEnabled: boolean;
    versionProfile?: unknown;
}

let binding: IWorkerBinding;
let taskKey: (task: unknown) => string;
let playTask: (task: unknown) => unknown;
let compactObservation: (record: unknown, audit: unknown) => unknown;
let readAuditAppend: (path: string, byteOffset: number) => { nextByteOffset: number; rows: unknown[] };

if (isV08) {
    const protocol = await import("./v0_8_aligned_96h_v1_protocol");
    const validated = protocol.validateV08AlignedV1CandidateBinding(
        data.binding as Parameters<typeof protocol.validateV08AlignedV1CandidateBinding>[0],
    );
    const v08GameAdapter = await import("./v0_8_aligned_96h_v1_game_adapter");
    binding = validated;
    const upgradeTask = (task: unknown) =>
        protocol.upgradeV08AlignedV1ExecutionTask(
            task as Parameters<typeof protocol.upgradeV08AlignedV1ExecutionTask>[0],
        );
    taskKey = (task) => protocol.v08AlignedV1TaskKey(upgradeTask(task));
    playTask = (task) => v08GameAdapter.playV08AlignedV1Task(upgradeTask(task), validated);
    compactObservation = (record, audit) =>
        v08GameAdapter.compactV08AlignedV1Observation(
            record as Parameters<typeof v08GameAdapter.compactV08AlignedV1Observation>[0],
            validated,
            audit as Parameters<typeof v08GameAdapter.compactV08AlignedV1Observation>[2],
        );
    readAuditAppend = v08GameAdapter.readV08AlignedV1AuditAppend;
} else {
    const protocol = await import("./v0_7_aligned_96h_v2_protocol");
    const validated = protocol.validateV07AlignedV2CandidateBinding(
        data.binding as Parameters<typeof protocol.validateV07AlignedV2CandidateBinding>[0],
    );
    const gameAdapter = await import("./v0_7_aligned_96h_v2_game_adapter");
    binding = validated;
    taskKey = (task) => protocol.v07AlignedV2TaskKey(task as Parameters<typeof protocol.v07AlignedV2TaskKey>[0]);
    playTask = (task) =>
        gameAdapter.playV07AlignedV2Task(task as Parameters<typeof gameAdapter.playV07AlignedV2Task>[0]);
    compactObservation = (record, audit) =>
        gameAdapter.compactV07AlignedV2Observation(
            record as Parameters<typeof gameAdapter.compactV07AlignedV2Observation>[0],
            validated,
            audit as Parameters<typeof gameAdapter.compactV07AlignedV2Observation>[2],
        );
    readAuditAppend = gameAdapter.readV07AlignedV2AuditAppend;
}

const send = (message: unknown): void => {
    if (!process.send || !process.connected) throw new Error("aligned v2 worker IPC parent is unavailable");
    process.send!(message);
};

const onParentDisconnect = (): never => process.exit(1);
process.once("disconnect", onParentDisconnect);

let auditByteOffset = 0;
let busy = false;
process.on("message", (message: { type: "evaluate"; task: unknown } | { type: "stop" }) => {
    if (message.type === "stop") {
        if (!process.send || !process.connected) process.exit(0);
        process.send!({ type: "stopped" }, undefined, undefined, (error: Error | null) => {
            if (error) process.exit(1);
            process.off("disconnect", onParentDisconnect);
            process.disconnect?.();
            process.exit(0);
        });
        return;
    }
    if (busy) {
        send({ type: "error", error: "aligned v2 worker received overlapping tasks" });
        return;
    }
    busy = true;
    try {
        const task = message.task;
        const record = playTask(task);
        const appended = readAuditAppend(data.auditPath, auditByteOffset);
        auditByteOffset = appended.nextByteOffset;
        const expectedRows = binding.searchEnabled ? 1 : 0;
        if (appended.rows.length !== expectedRows) {
            throw new Error(
                `${taskKey(task)}: expected ${expectedRows} exact audit rows, received ${appended.rows.length}`,
            );
        }
        const observation = compactObservation(record, appended.rows[0]);
        send({
            type: "result",
            taskKey: taskKey(task),
            record,
            observation,
        });
    } catch (error) {
        send({
            type: "error",
            error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
    } finally {
        busy = false;
    }
});

send({
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
        ...(isV08
            ? {
                  artifactKind: "v0_8_aligned_96h_v1_worker_attestation",
                  versionProfile: binding.versionProfile,
                  nonfightBindingSha256: binding.nonfightBindingSha256,
              }
            : {}),
    },
});
