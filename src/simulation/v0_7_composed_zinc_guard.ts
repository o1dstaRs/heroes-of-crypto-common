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

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

const UINT32_MAX = 0xffffffff;
export const V07_COMPOSED_ZINC_FINAL_WINDOW_MS = 5 * 60 * 1000;
export const V07_COMPOSED_ZINC_FORBIDDEN_RUNTIME_ENVIRONMENT = [
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

export interface IV07ComposedZincGuardContract {
    schemaVersion: 1;
    guardId: string;
    sealBefore: string;
    remote: { host: string; user: string; port: 2222 };
    limits: {
        maxIteration: 64;
        maxPass: 8;
        maxGeneration: 12;
        seed0Base: 970000;
        iterationStep: 911;
        trainingPassStep: 1000003;
        trainingGenerationStep: 7919;
        trainingGames: 3000;
        validationOffsets: [11, 17, 19, 23, 29];
        validationGames: 2500;
    };
    paths: {
        commonRoot: string;
        keepaliveScript: string;
        cemScript: string;
        concurrentTournament: string;
        runTournament: string;
        tournament: string;
        tournamentWorker: string;
        log: string;
        state: string;
    };
    requiredFileSha256: Record<string, string>;
    approvedReadOnlyScanner: {
        cwd: string;
        sourcePath: string;
        configPath: string;
        cutoff: string;
        seedSetOutput: string;
        summaryOutput: string;
        excluded: string[];
        excludedPathPrefixes: string[];
        excludedRelativeSuffixes: [
            "src/simulation/manifests/v0_7_composed_ranked_ladder_20260716.json",
            "src/simulation/v0_7_composed_ranked_ladder.ts",
        ];
    };
    requiredCemEnvironment: Record<string, string>;
    forbiddenCemEnvironment: ["CEM_GENS", "CEM_MAPS"];
    initialObservation: {
        capturedAt: string;
        keepalivePid: number;
        cemPid: number;
        keepaliveStartTicks: string;
        cemStartTicks: string;
        snapshotSha256: string;
    };
}

export interface IV07ComposedZincProcessSnapshot {
    pid: number;
    ppid: number;
    startTicks: string;
    cwd: string;
    argv: string[];
    environment: Record<string, string>;
}

export interface IV07ComposedZincSnapshot {
    schemaVersion: 1;
    capturedAt: string;
    files: Record<string, string>;
    logText: string;
    stateText: string | null;
    processes: IV07ComposedZincProcessSnapshot[];
    processScanErrors: string[];
    readOnlyScannerConfig: {
        cutoff: string;
        seedSetOutput: string;
        summaryOutput: string;
        excluded: string[];
        excludedPathPrefixes: string[];
        excludedRelativeSuffixes: string[];
    };
}

export interface IV07ComposedZincGuardResult {
    schemaVersion: 1;
    guardId: string;
    contractSha256: string;
    snapshotSha256: string;
    checkedAt: string;
    sealBefore: string;
    maxObservedIteration: number;
    maxObservedPass: number;
    activeKeepalivePids: number[];
    activeCemPids: number[];
    activeTournamentSeeds: number[];
    activeReadOnlyScannerPids: number[];
    passed: true;
}

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

export const v07ComposedZincSnapshotSha256 = (snapshot: IV07ComposedZincSnapshot): string =>
    sha256(`${JSON.stringify(snapshot, null, 2)}\n`);

function isCanonicalInstant(value: string): boolean {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString().replace(".000Z", "Z") === value;
}

function isUint32(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0 && value <= UINT32_MAX;
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

export function validateV07ComposedZincGuardContract(contract: IV07ComposedZincGuardContract): void {
    if (
        contract.schemaVersion !== 1 ||
        !contract.guardId.trim() ||
        !isCanonicalInstant(contract.sealBefore) ||
        !contract.remote.host.trim() ||
        !contract.remote.user.trim() ||
        contract.remote.port !== 2222 ||
        JSON.stringify(contract.limits) !==
            JSON.stringify({
                maxIteration: 64,
                maxPass: 8,
                maxGeneration: 12,
                seed0Base: 970000,
                iterationStep: 911,
                trainingPassStep: 1000003,
                trainingGenerationStep: 7919,
                trainingGames: 3000,
                validationOffsets: [11, 17, 19, 23, 29],
                validationGames: 2500,
            })
    ) {
        throw new Error("Zinc guard contract changed the frozen remote schedule or deadline contract");
    }
    const requiredPaths = [
        "commonRoot",
        "keepaliveScript",
        "cemScript",
        "concurrentTournament",
        "runTournament",
        "tournament",
        "tournamentWorker",
        "log",
        "state",
    ] as const;
    if (requiredPaths.some((key) => !contract.paths[key].startsWith("/"))) {
        throw new Error("Zinc guard paths must be absolute");
    }
    const sourcePaths = requiredPaths
        .filter((key) => key !== "commonRoot" && key !== "log" && key !== "state")
        .map((key) => contract.paths[key]);
    const scanner = contract.approvedReadOnlyScanner;
    if (
        !scanner ||
        !scanner.cwd.startsWith("/") ||
        !scanner.sourcePath.startsWith("/") ||
        !scanner.configPath.startsWith("/") ||
        !isCanonicalInstant(scanner.cutoff) ||
        !scanner.seedSetOutput.startsWith("/") ||
        !scanner.summaryOutput.startsWith("/") ||
        scanner.seedSetOutput === scanner.summaryOutput ||
        !Array.isArray(scanner.excluded) ||
        scanner.excluded.length === 0 ||
        scanner.excluded.some((path) => !path.startsWith("/") || resolve(path) !== path) ||
        new Set(scanner.excluded).size !== scanner.excluded.length ||
        JSON.stringify(scanner.excluded) !== JSON.stringify([...scanner.excluded].sort()) ||
        !Array.isArray(scanner.excludedPathPrefixes) ||
        scanner.excludedPathPrefixes.some(
            (prefix) =>
                !prefix.startsWith("/") ||
                resolve(prefix) !== prefix ||
                dirname(prefix) === prefix ||
                !/[._a-zA-Z0-9][_-]$/.test(basename(prefix)),
        ) ||
        new Set(scanner.excludedPathPrefixes).size !== scanner.excludedPathPrefixes.length ||
        JSON.stringify(scanner.excludedPathPrefixes) !== JSON.stringify([...scanner.excludedPathPrefixes].sort()) ||
        JSON.stringify(scanner.excludedRelativeSuffixes) !==
            JSON.stringify([
                "src/simulation/manifests/v0_7_composed_ranked_ladder_20260716.json",
                "src/simulation/v0_7_composed_ranked_ladder.ts",
            ]) ||
        !sameMembers(Object.keys(contract.requiredFileSha256), [
            ...sourcePaths,
            scanner.sourcePath,
            scanner.configPath,
        ]) ||
        Object.values(contract.requiredFileSha256).some((hash) => !/^[0-9a-f]{64}$/.test(hash))
    ) {
        throw new Error("Zinc guard must bind every executable source/config file and read-only scanner output");
    }
    const requiredEnvironment = {
        BASE_VERSION: "v0.4",
        CEM_BATCH: "44",
        CEM_CORES: "44",
        CEM_DIM: "58",
        CEM_EVAL_TIMEOUT_MS: "1200000",
        CEM_GAMES: "3000",
        CEM_HOURS: "6",
        CEM_POP: "40",
        CEM_ELITE: "8",
        CEM_VAL_GAMES: "2500",
        FIGHT_MELEE_ROSTERS: "0.5",
        OPT_VERSION: "v0.6",
        OPT_WEIGHTS_ENV: "V06_WEIGHTS",
    };
    for (const [key, value] of Object.entries(requiredEnvironment)) {
        if (contract.requiredCemEnvironment[key] !== value) {
            throw new Error(`Zinc guard CEM environment changed ${key}`);
        }
    }
    if (JSON.stringify(contract.forbiddenCemEnvironment) !== JSON.stringify(["CEM_GENS", "CEM_MAPS"])) {
        throw new Error("Zinc guard optional seed/protocol environment exclusions changed");
    }
    if (
        !isCanonicalInstant(contract.initialObservation.capturedAt) ||
        !Number.isSafeInteger(contract.initialObservation.keepalivePid) ||
        !Number.isSafeInteger(contract.initialObservation.cemPid) ||
        !/^\d+$/.test(contract.initialObservation.keepaliveStartTicks) ||
        !/^\d+$/.test(contract.initialObservation.cemStartTicks) ||
        !/^[0-9a-f]{64}$/.test(contract.initialObservation.snapshotSha256)
    ) {
        throw new Error("Zinc guard initial process observation is incomplete");
    }
}

export function v07ComposedZincReservedTournamentSeeds(contract: IV07ComposedZincGuardContract): Set<number> {
    return new Set(v07ComposedZincReservedTournamentGames(contract).keys());
}

function v07ComposedZincReservedTournamentGames(contract: IV07ComposedZincGuardContract): Map<number, number> {
    validateV07ComposedZincGuardContract(contract);
    const result = new Map<number, number>();
    const limits = contract.limits;
    const add = (seed: number, games: number): void => {
        const previous = result.get(seed);
        if (previous !== undefined && previous !== games) {
            throw new Error(`Zinc reserved tournament seed ${seed} has conflicting game counts`);
        }
        result.set(seed, games);
    };
    for (let iteration = 1; iteration <= limits.maxIteration; iteration += 1) {
        const seed0 = (limits.seed0Base + Math.imul(iteration, limits.iterationStep)) >>> 0;
        for (const offset of limits.validationOffsets) add((seed0 + offset) >>> 0, limits.validationGames);
        for (let pass = 1; pass <= limits.maxPass; pass += 1) {
            for (let generation = 1; generation <= limits.maxGeneration; generation += 1) {
                add(
                    (seed0 +
                        Math.imul(pass, limits.trainingPassStep) +
                        Math.imul(generation, limits.trainingGenerationStep)) >>>
                        0,
                    limits.trainingGames,
                );
            }
        }
    }
    return result;
}

function parseLog(
    contract: IV07ComposedZincGuardContract,
    text: string,
): { maxIteration: number; maxPass: number; maxGeneration: number } {
    let maxIteration = 0;
    let maxPass = 0;
    let maxGeneration = 0;
    let iterationMarkers = 0;
    let passMarkers = 0;
    for (const line of text.split("\n")) {
        if (line.includes("f58b iter") && line.includes("START")) {
            iterationMarkers += 1;
            const match = /\bf58b iter (\d+) seed (\d+) START\b/.exec(line);
            if (!match) throw new Error(`Malformed Zinc iteration marker: ${line}`);
            const iteration = Number(match[1]);
            const seed = Number(match[2]);
            if (!Number.isSafeInteger(iteration) || iteration < 1 || !isUint32(seed)) {
                throw new Error(`Invalid Zinc iteration marker: ${line}`);
            }
            const expected = (contract.limits.seed0Base + Math.imul(iteration, contract.limits.iterationStep)) >>> 0;
            if (seed !== expected) throw new Error(`Zinc iteration ${iteration} seed ${seed} != ${expected}`);
            maxIteration = Math.max(maxIteration, iteration);
        }
        if (line.includes("[cem] pass ")) {
            passMarkers += 1;
            const match = /\[cem\] pass (\d+)\b/.exec(line);
            if (!match) throw new Error(`Malformed Zinc pass marker: ${line}`);
            const pass = Number(match[1]);
            if (!Number.isSafeInteger(pass) || pass < 1) throw new Error(`Invalid Zinc pass marker: ${line}`);
            maxPass = Math.max(maxPass, pass);
            if (line.includes(" gen ")) {
                const generationMatch = /\bgen (\d+)\/(\d+)\b/.exec(line);
                if (!generationMatch) throw new Error(`Malformed Zinc generation marker: ${line}`);
                const generation = Number(generationMatch[1]);
                const total = Number(generationMatch[2]);
                if (
                    !Number.isSafeInteger(generation) ||
                    generation < 1 ||
                    generation > contract.limits.maxGeneration ||
                    total !== contract.limits.maxGeneration
                ) {
                    throw new Error(`Zinc generation marker crossed the reserved closure: ${line}`);
                }
                maxGeneration = Math.max(maxGeneration, generation);
            }
        }
    }
    if (iterationMarkers === 0 || passMarkers === 0) throw new Error("Zinc log lacks iteration or pass evidence");
    return { maxIteration, maxPass, maxGeneration };
}

function parseState(contract: IV07ComposedZincGuardContract, stateText: string | null): void {
    if (stateText === null) return;
    let state: unknown;
    try {
        state = JSON.parse(stateText);
    } catch (error) {
        throw new Error(`Malformed Zinc CEM state: ${String(error)}`);
    }
    if (state === null || typeof state !== "object") throw new Error("Zinc CEM state must be an object");
    const record = state as Record<string, unknown>;
    if (
        !Number.isSafeInteger(record.pass) ||
        (record.pass as number) < 1 ||
        (record.pass as number) > contract.limits.maxPass ||
        !Number.isSafeInteger(record.gen) ||
        (record.gen as number) < 1 ||
        (record.gen as number) > contract.limits.maxGeneration
    ) {
        throw new Error("Zinc CEM state is outside the reserved pass/generation closure");
    }
}

function processHasArg(process: IV07ComposedZincProcessSnapshot, expected: string): boolean {
    return process.argv.includes(expected) || process.argv.some((arg) => arg.endsWith(`/${expected}`));
}

export function validateV07ComposedZincSnapshot(
    contract: IV07ComposedZincGuardContract,
    snapshot: IV07ComposedZincSnapshot,
    contractBytes = `${JSON.stringify(contract, null, 2)}\n`,
): IV07ComposedZincGuardResult {
    validateV07ComposedZincGuardContract(contract);
    if (snapshot.schemaVersion !== 1 || !isCanonicalInstant(snapshot.capturedAt)) {
        throw new Error("Zinc guard snapshot is malformed");
    }
    if (Date.parse(snapshot.capturedAt) > Date.parse(contract.sealBefore)) {
        throw new Error(
            `Zinc guard snapshot ${snapshot.capturedAt} is after the sealing deadline ${contract.sealBefore}`,
        );
    }
    if (
        !sameMembers(Object.keys(snapshot.files), Object.keys(contract.requiredFileSha256)) ||
        Object.entries(contract.requiredFileSha256).some(([path, hash]) => snapshot.files[path] !== hash)
    ) {
        throw new Error("Zinc executable source hashes drifted from the frozen contract");
    }
    if (
        JSON.stringify(snapshot.readOnlyScannerConfig) !==
        JSON.stringify({
            cutoff: contract.approvedReadOnlyScanner.cutoff,
            seedSetOutput: contract.approvedReadOnlyScanner.seedSetOutput,
            summaryOutput: contract.approvedReadOnlyScanner.summaryOutput,
            excluded: contract.approvedReadOnlyScanner.excluded,
            excludedPathPrefixes: contract.approvedReadOnlyScanner.excludedPathPrefixes,
            excludedRelativeSuffixes: contract.approvedReadOnlyScanner.excludedRelativeSuffixes,
        })
    ) {
        throw new Error("Zinc read-only scanner config projection drifted from the frozen contract");
    }
    if (!Array.isArray(snapshot.processScanErrors) || snapshot.processScanErrors.length !== 0) {
        throw new Error(`Zinc /proc inventory failed closed: ${snapshot.processScanErrors?.join("; ")}`);
    }
    const log = parseLog(contract, snapshot.logText);
    if (log.maxIteration > contract.limits.maxIteration || log.maxPass > contract.limits.maxPass) {
        throw new Error("Zinc log crossed the reserved iteration/pass closure");
    }
    parseState(contract, snapshot.stateText);

    const reservedTournamentGames = v07ComposedZincReservedTournamentGames(contract);
    const keepalive: IV07ComposedZincProcessSnapshot[] = [];
    const cem: IV07ComposedZincProcessSnapshot[] = [];
    const tournaments: IV07ComposedZincProcessSnapshot[] = [];
    const readOnlyScanners: IV07ComposedZincProcessSnapshot[] = [];
    const activeTournamentSeeds: number[] = [];
    for (const process of snapshot.processes) {
        if (
            !Number.isSafeInteger(process.pid) ||
            process.pid < 1 ||
            !Number.isSafeInteger(process.ppid) ||
            process.ppid < 0 ||
            !/^\d+$/.test(process.startTicks) ||
            !Array.isArray(process.argv) ||
            process.argv.length < 2
        ) {
            throw new Error("Zinc process snapshot has invalid pid/parent/start/cwd/argv evidence");
        }
        for (const key of V07_COMPOSED_ZINC_FORBIDDEN_RUNTIME_ENVIRONMENT) {
            if (key in process.environment) {
                throw new Error(`Zinc process ${process.pid} inherited forbidden runtime injection ${key}`);
            }
        }
        if (process.argv.includes(contract.approvedReadOnlyScanner.sourcePath)) {
            if (
                process.cwd !== contract.approvedReadOnlyScanner.cwd ||
                process.argv.length !== 3 ||
                !(process.argv[0] === "bun" || process.argv[0].endsWith("/bun")) ||
                process.argv[1] !== contract.approvedReadOnlyScanner.sourcePath ||
                process.argv[2] !== contract.approvedReadOnlyScanner.configPath
            ) {
                throw new Error(`Zinc read-only scanner process ${process.pid} changed its exact cwd/argv`);
            }
            readOnlyScanners.push(process);
            continue;
        }
        if (process.cwd !== contract.paths.commonRoot) {
            throw new Error(`Zinc experiment process ${process.pid} changed its approved cwd`);
        }
        if (processHasArg(process, contract.paths.keepaliveScript)) {
            if (
                process.argv.length !== 2 ||
                !process.argv[0].endsWith("bash") ||
                process.argv[1] !== contract.paths.keepaliveScript
            ) {
                throw new Error(`Zinc keepalive process ${process.pid} changed its exact argv`);
            }
            keepalive.push(process);
            continue;
        }
        if (processHasArg(process, "src/simulation/optimizer/cem.mjs")) {
            if (
                process.argv.length !== 2 ||
                !(process.argv[0] === "bun" || process.argv[0].endsWith("/bun")) ||
                process.argv[1] !== "src/simulation/optimizer/cem.mjs"
            ) {
                throw new Error(`Zinc CEM process ${process.pid} changed its exact argv`);
            }
            cem.push(process);
            for (const [key, value] of Object.entries(contract.requiredCemEnvironment)) {
                if (process.environment[key] !== value)
                    throw new Error(`Zinc CEM process ${process.pid} changed ${key}`);
            }
            for (const key of contract.forbiddenCemEnvironment) {
                if (key in process.environment) throw new Error(`Zinc CEM process ${process.pid} injected ${key}`);
            }
            const seed0 = Number(process.environment.CEM_SEED);
            if (!isUint32(seed0)) throw new Error(`Zinc CEM process ${process.pid} lacks a uint32 CEM_SEED`);
            const iteration = (seed0 - contract.limits.seed0Base) / contract.limits.iterationStep;
            if (!Number.isSafeInteger(iteration) || iteration < 1 || iteration > contract.limits.maxIteration) {
                throw new Error(`Zinc CEM process ${process.pid} seed ${seed0} is outside iterations 1..64`);
            }
            const expectedValidation = contract.limits.validationOffsets
                .map((offset) => (seed0 + offset) >>> 0)
                .join(",");
            if (process.environment.CEM_VAL_SEEDS !== expectedValidation) {
                throw new Error(`Zinc CEM process ${process.pid} changed CEM_VAL_SEEDS`);
            }
            continue;
        }
        const tournamentIndex = process.argv.findIndex((arg) => arg.endsWith("src/simulation/run_tournament.ts"));
        if (tournamentIndex >= 0) {
            const seed = Number(process.argv[tournamentIndex + 4]);
            const expectedGames = reservedTournamentGames.get(seed);
            if (!isUint32(seed) || expectedGames === undefined) {
                throw new Error(
                    `Active Zinc tournament seed ${String(process.argv[tournamentIndex + 4])} is unreserved`,
                );
            }
            if (
                tournamentIndex !== 1 ||
                process.argv.length !== 9 ||
                !(process.argv[0] === "bun" || process.argv[0].endsWith("/bun")) ||
                process.argv[1] !== "src/simulation/run_tournament.ts" ||
                process.argv[2] !== "v0.6" ||
                process.argv[3] !== "v0.4" ||
                process.argv[4] !== String(expectedGames) ||
                !process.argv[6].startsWith(`${contract.paths.commonRoot}/sim-out/cem/eval_`) ||
                process.argv[7] !== "1" ||
                process.argv[8] !== "--maps"
            ) {
                throw new Error(`Active Zinc tournament ${process.pid} changed its exact protocol argv`);
            }
            tournaments.push(process);
            activeTournamentSeeds.push(seed);
            continue;
        }
        throw new Error(`Unclassified Zinc experiment process ${process.pid}: ${process.argv.join(" ")}`);
    }
    if (keepalive.length > 1 || cem.length > 1 || readOnlyScanners.length > 1) {
        throw new Error("Zinc guard found duplicate keepalive, CEM, or read-only scanner processes");
    }
    if (cem.some((process) => keepalive.length !== 1 || process.ppid !== keepalive[0].pid)) {
        throw new Error("Zinc CEM coordinator is not an exact child of the approved keepalive");
    }
    if (tournaments.some((process) => cem.length !== 1 || process.ppid !== cem[0].pid)) {
        throw new Error("Zinc tournament is not an exact child of the approved CEM coordinator");
    }
    return {
        schemaVersion: 1,
        guardId: contract.guardId,
        contractSha256: sha256(contractBytes),
        snapshotSha256: v07ComposedZincSnapshotSha256(snapshot),
        checkedAt: snapshot.capturedAt,
        sealBefore: contract.sealBefore,
        maxObservedIteration: log.maxIteration,
        maxObservedPass: log.maxPass,
        activeKeepalivePids: keepalive.map((process) => process.pid).sort((left, right) => left - right),
        activeCemPids: cem.map((process) => process.pid).sort((left, right) => left - right),
        activeTournamentSeeds: activeTournamentSeeds.sort((left, right) => left - right),
        activeReadOnlyScannerPids: readOnlyScanners.map((process) => process.pid).sort((left, right) => left - right),
        passed: true,
    };
}

export function validateV07ComposedZincInitialSnapshot(
    contract: IV07ComposedZincGuardContract,
    snapshot: IV07ComposedZincSnapshot,
    contractBytes?: string,
): IV07ComposedZincGuardResult {
    const result = validateV07ComposedZincSnapshot(contract, snapshot, contractBytes);
    const keepalive = snapshot.processes.find((process) => process.pid === contract.initialObservation.keepalivePid);
    const cem = snapshot.processes.find((process) => process.pid === contract.initialObservation.cemPid);
    if (
        snapshot.capturedAt !== contract.initialObservation.capturedAt ||
        result.snapshotSha256 !== contract.initialObservation.snapshotSha256 ||
        !result.activeKeepalivePids.includes(contract.initialObservation.keepalivePid) ||
        !result.activeCemPids.includes(contract.initialObservation.cemPid) ||
        keepalive?.startTicks !== contract.initialObservation.keepaliveStartTicks ||
        cem?.startTicks !== contract.initialObservation.cemStartTicks
    ) {
        throw new Error("Zinc initial snapshot does not match the frozen process anchor");
    }
    return result;
}

export function validateV07ComposedZincFinalSnapshot(
    contract: IV07ComposedZincGuardContract,
    snapshot: IV07ComposedZincSnapshot,
    runCompletedAt: string,
    contractBytes?: string,
): IV07ComposedZincGuardResult {
    const result = validateV07ComposedZincSnapshot(contract, snapshot, contractBytes);
    if (!isCanonicalInstant(runCompletedAt))
        throw new Error("Zinc final guard requires a canonical run completion time");
    const lag = Date.parse(snapshot.capturedAt) - Date.parse(runCompletedAt);
    if (lag < 0 || lag > V07_COMPOSED_ZINC_FINAL_WINDOW_MS) {
        throw new Error(
            `Zinc final snapshot must follow combat completion by at most ${V07_COMPOSED_ZINC_FINAL_WINDOW_MS}ms`,
        );
    }
    return result;
}

function remoteSnapshotProgram(contract: IV07ComposedZincGuardContract): string {
    const config = JSON.stringify({
        files: Object.keys(contract.requiredFileSha256),
        log: contract.paths.log,
        state: contract.paths.state,
        commonRoot: contract.paths.commonRoot,
        commonPrefix: contract.paths.commonRoot.replace(/\/?$/, "").replace(/\/hoc-common$/, "/hoc-common"),
        keepaliveScript: contract.paths.keepaliveScript,
        readOnlyScanner: contract.approvedReadOnlyScanner.sourcePath,
        readOnlyScannerConfig: contract.approvedReadOnlyScanner.configPath,
    });
    return `
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
const config = ${config};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const files = Object.fromEntries(config.files.map((path) => [path, sha256(readFileSync(path))]));
const scannerConfig = JSON.parse(readFileSync(config.readOnlyScannerConfig, "utf8"));
const readOnlyScannerConfig = {
  cutoff: scannerConfig.cutoff,
  seedSetOutput: scannerConfig.seedSetOutput,
  summaryOutput: scannerConfig.summaryOutput,
  excluded: scannerConfig.excluded,
  excludedPathPrefixes: scannerConfig.excludedPathPrefixes ?? [],
  excludedRelativeSuffixes: scannerConfig.excludedRelativeSuffixes,
};
const processes = [];
const processScanErrors = [];
for (const name of readdirSync("/proc")) {
  if (!/^\\d+$/.test(name)) continue;
  try {
    const argv = readFileSync(\`/proc/\${name}/cmdline\`, "utf8").split("\\0").filter(Boolean);
    const bunProcess = argv[0] === "bun" || argv[0]?.endsWith("/bun");
    const cwd = readlinkSync(\`/proc/\${name}/cwd\`);
    const relevant = argv.includes(config.keepaliveScript) ||
      argv.includes(config.readOnlyScanner) ||
      (bunProcess && cwd.startsWith(config.commonPrefix)) ||
      (bunProcess && argv.some((arg) => /(?:^|\\/)src\\/simulation\\/|(?:^|\\/)optimizer\\//.test(arg)));
    if (!relevant) continue;
    const stat = readFileSync(\`/proc/\${name}/stat\`, "utf8");
    const close = stat.lastIndexOf(")");
    const statFields = stat.slice(close + 2).split(" ");
    const ppid = Number(statFields[1]);
    const startTicks = statFields[19];
    const environment = Object.fromEntries(
      readFileSync(\`/proc/\${name}/environ\`, "utf8").split("\\0").filter(Boolean).map((entry) => {
        const index = entry.indexOf("=");
        return [entry.slice(0, index), entry.slice(index + 1)];
      }),
    );
    processes.push({ pid: Number(name), ppid, startTicks, cwd, argv, environment });
  } catch (error) {
    if (error?.code !== "ENOENT") processScanErrors.push(\`/proc/\${name}: \${String(error)}\`);
  }
}
const snapshot = {
  schemaVersion: 1,
  capturedAt: new Date().toISOString().replace(".000Z", "Z"),
  files,
  logText: readFileSync(config.log, "utf8"),
  stateText: existsSync(config.state) ? readFileSync(config.state, "utf8") : null,
  processes: processes.sort((left, right) => left.pid - right.pid),
  processScanErrors,
  readOnlyScannerConfig,
};
process.stdout.write(JSON.stringify(snapshot));
`;
}

export function captureV07ComposedZincSnapshot(
    contract: IV07ComposedZincGuardContract,
    identityFile: string,
): IV07ComposedZincSnapshot {
    validateV07ComposedZincGuardContract(contract);
    const destination = `${contract.remote.user}@${contract.remote.host}`;
    const sshArguments = [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=12",
        "-o",
        "IdentitiesOnly=yes",
        "-i",
        resolve(identityFile.replace(/^~(?=\/)/, homedir())),
        "-p",
        String(contract.remote.port),
        destination,
        "bun",
        "run",
        "-",
    ];
    let stdout: string | undefined;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
            stdout = execFileSync("ssh", sshArguments, {
                encoding: "utf8",
                input: remoteSnapshotProgram(contract),
                maxBuffer: 16 * 1024 * 1024,
                timeout: 30_000,
            });
            break;
        } catch (error) {
            const status = (error as { status?: number }).status;
            if (status !== 255 || attempt === 3) throw error;
            execFileSync("sleep", ["2"]);
        }
    }
    if (stdout === undefined) throw new Error("Zinc snapshot command exhausted retries without output");
    try {
        return JSON.parse(stdout) as IV07ComposedZincSnapshot;
    } catch (error) {
        throw new Error(`Zinc snapshot command returned malformed JSON: ${String(error)}`);
    }
}

function atomicWrite(path: string, contents: string): void {
    const resolved = resolve(path);
    const temporary = `${resolved}.tmp-${process.pid}`;
    writeFileSync(temporary, contents);
    renameSync(temporary, resolved);
}

interface ICliOptions {
    contractPath: string;
    identityFile: string;
    phase: "initial" | "periodic" | "final";
    notBefore?: string;
    snapshotPath?: string;
    outputPath?: string;
}

function parseCli(argv: string[]): ICliOptions {
    const parsed = parseArgs({
        args: argv,
        allowPositionals: false,
        strict: true,
        options: {
            contract: { type: "string" },
            identity: { type: "string", default: "~/.ssh/id_ed25519_agent-zinc" },
            phase: { type: "string", default: "periodic" },
            "not-before": { type: "string" },
            snapshot: { type: "string" },
            output: { type: "string" },
        },
    });
    if (!parsed.values.contract) throw new Error("--contract is required");
    if (!(["initial", "periodic", "final"] as const).includes(parsed.values.phase as never)) {
        throw new Error("--phase must be initial, periodic, or final");
    }
    const phase = parsed.values.phase as ICliOptions["phase"];
    if (phase === "final" && !parsed.values["not-before"]) {
        throw new Error("--not-before is required for the final guard");
    }
    return {
        contractPath: resolve(parsed.values.contract),
        identityFile: parsed.values.identity!,
        phase,
        ...(parsed.values["not-before"] ? { notBefore: parsed.values["not-before"] } : {}),
        ...(parsed.values.snapshot ? { snapshotPath: resolve(parsed.values.snapshot) } : {}),
        ...(parsed.values.output ? { outputPath: resolve(parsed.values.output) } : {}),
    };
}

if (import.meta.main) {
    const options = parseCli(process.argv.slice(2));
    const contractBytes = readFileSync(options.contractPath, "utf8");
    const contract = JSON.parse(contractBytes) as IV07ComposedZincGuardContract;
    const snapshotArtifact = options.snapshotPath
        ? (JSON.parse(readFileSync(options.snapshotPath, "utf8")) as
              IV07ComposedZincSnapshot | { snapshot: IV07ComposedZincSnapshot })
        : undefined;
    const snapshot = snapshotArtifact
        ? "snapshot" in snapshotArtifact
            ? snapshotArtifact.snapshot
            : snapshotArtifact
        : captureV07ComposedZincSnapshot(contract, options.identityFile);
    const result =
        options.phase === "initial"
            ? validateV07ComposedZincInitialSnapshot(contract, snapshot, contractBytes)
            : options.phase === "final"
              ? validateV07ComposedZincFinalSnapshot(contract, snapshot, options.notBefore!, contractBytes)
              : validateV07ComposedZincSnapshot(contract, snapshot, contractBytes);
    const output = `${JSON.stringify({ result, snapshot }, null, 2)}\n`;
    if (options.outputPath) {
        if (dirname(options.outputPath) === resolve(process.cwd())) {
            throw new Error("Zinc guard output must not be written at the repository root");
        }
        atomicWrite(options.outputPath, output);
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
}
