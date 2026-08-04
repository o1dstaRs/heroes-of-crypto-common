/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { arch, availableParallelism, cpus, platform, release, totalmem } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";

import { AI_META_COHORTS, AI_META_COHORT_DESCRIPTIONS, cohortMap, type AiMetaCohort } from "./ai_meta_cohorts_core";
import { hashSimulationParts } from "./army";
import { LEAGUE_ROUND1_DRAFT_SPEC } from "../ai/setup/draft_ship";
import { RANKED_REPLAY_TACTICS_SETUP_SPEC } from "../ai/setup/setup_replay_tactics";
import { V07_NONFIGHT_SETUP_SPEC } from "../ai/setup/setup_ship";
import {
    RANKED_REPLAY_TACTICS_AB_CLUSTER_SIZE,
    RANKED_REPLAY_TACTICS_AB_CONTROL,
    RANKED_REPLAY_TACTICS_AB_LIVE_MAPS,
    RANKED_REPLAY_TACTICS_AB_SCHEMA,
    buildRankedReplayAbEnvironment,
    parseRankedReplayAbComponents,
    parseRankedReplayAbCombatCandidate,
    parseRankedReplayAbCombatScope,
    rankedReplayCombatClusterEligible,
    rankedReplayAbEnvironmentSha256,
    summarizeRankedReplayAbRecords,
    type IRankedReplayAbClusterRecord,
    type IRankedReplayAbOptions,
    type RankedReplayAbCombatCandidate,
    type RankedReplayAbCombatScope,
    type RankedReplayAbComponents,
} from "./ranked_replay_tactics_ab_core";

export const RANKED_REPLAY_AB_DEVELOPMENT_SEED = 1391574133;
export const RANKED_REPLAY_AB_RANGED_BATTERY_DEVELOPMENT_SEED = 271828183;
export const RANKED_REPLAY_AB_VALIDATION_SEED = 386914648;
export const RANKED_REPLAY_AB_REPLICATION_SEED = 1278621871;
export const RANKED_REPLAY_AB_RAW_FILE = "ranked-replay-tactics-ab.records.jsonl";
export const RANKED_REPLAY_AB_SUMMARY_FILE = "ranked-replay-tactics-ab.summary.json";
export const RANKED_REPLAY_AB_STARTED_FILE = "ranked-replay-tactics-ab.started.json";

export type RankedReplayAbStage = "smoke" | "direction" | "development" | "validation" | "replication";

export const RANKED_REPLAY_AB_PAIRS_BY_STAGE: Readonly<Record<RankedReplayAbStage, number>> = Object.freeze({
    smoke: 36,
    direction: 360,
    development: 1_800,
    validation: 3_600,
    replication: 3_600,
});

export interface IRankedReplayAbRunnerOptions {
    pairs: number;
    baseSeed: number;
    output: string;
    concurrency: number;
    cohorts: AiMetaCohort[];
    components: RankedReplayAbComponents;
    combatScope: RankedReplayAbCombatScope;
    combatCandidate: RankedReplayAbCombatCandidate;
    combatEpsilon: number;
    maxLaps: number;
    stage: RankedReplayAbStage;
}

interface ITask {
    cohort: AiMetaCohort;
    pair: number;
}

interface ISourceIdentity {
    commonCommit: string;
    dirty: boolean;
    sourceSha256: string;
    files: number;
}

interface IQuality {
    expectedClusters: number;
    clusters: number;
    games: number;
    rejectedCandidate: number;
    rejectedControl: number;
    armageddonDecided: number;
    malformedClusters: number;
    overlappingRosterAssignments: number;
    mapClusters: Record<string, number>;
    cohortClusters: Record<string, number>;
    rawLines: number;
    sourceUnchanged: boolean;
    sourceDirty: boolean;
}

const safeInteger = (raw: string | undefined, label: string, fallback?: number): number => {
    const value = raw === undefined && fallback !== undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
    return value;
};

const parseCohorts = (raw: string | undefined): AiMetaCohort[] => {
    const values = raw
        ? raw
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean)
        : [...AI_META_COHORTS];
    const legal = new Set<string>(AI_META_COHORTS);
    if (!values.length || values.some((value) => !legal.has(value)) || new Set(values).size !== values.length) {
        throw new Error(`cohorts must be unique values from ${AI_META_COHORTS.join(",")}`);
    }
    return values as AiMetaCohort[];
};

const defaultSeedFor = (stage: RankedReplayAbStage, combatScope: RankedReplayAbCombatScope): number =>
    stage === "validation"
        ? RANKED_REPLAY_AB_VALIDATION_SEED
        : stage === "replication"
          ? RANKED_REPLAY_AB_REPLICATION_SEED
          : combatScope === "ranged-battery"
            ? RANKED_REPLAY_AB_RANGED_BATTERY_DEVELOPMENT_SEED
            : RANKED_REPLAY_AB_DEVELOPMENT_SEED;

export function parseRankedReplayAbRunnerOptions(argv: readonly string[]): IRankedReplayAbRunnerOptions {
    const { values } = parseArgs({
        args: [...argv],
        options: {
            pairs: { type: "string" },
            seed: { type: "string" },
            output: { type: "string" },
            concurrency: { type: "string" },
            cohorts: { type: "string" },
            components: { type: "string" },
            "combat-candidate": { type: "string" },
            "combat-scope": { type: "string" },
            "combat-epsilon": { type: "string" },
            "max-laps": { type: "string" },
            stage: { type: "string" },
        },
        strict: true,
        allowPositionals: false,
    });
    const stage = (values.stage ?? "development") as RankedReplayAbStage;
    if (!["smoke", "direction", "development", "validation", "replication"].includes(stage)) {
        throw new Error("stage must be smoke, direction, development, validation, or replication");
    }
    const combatScope = parseRankedReplayAbCombatScope(values["combat-scope"]);
    const combatCandidate = parseRankedReplayAbCombatCandidate(values["combat-candidate"]);
    const expectedPairs = RANKED_REPLAY_AB_PAIRS_BY_STAGE[stage];
    const pairs = safeInteger(values.pairs, "pairs", expectedPairs);
    if (pairs % 36 !== 0) {
        throw new Error("pairs must be divisible by 36 for exact live-map and cross-archetype balance");
    }
    if (pairs !== expectedPairs) {
        throw new Error(`${stage} stage requires exactly ${expectedPairs} pairs per cohort`);
    }
    const baseSeed = values.seed === undefined ? defaultSeedFor(stage, combatScope) : Number(values.seed);
    if (!Number.isSafeInteger(baseSeed) || baseSeed < 0 || baseSeed > 0xffffffff) {
        throw new Error("seed must be a uint32 integer");
    }
    if (baseSeed !== defaultSeedFor(stage, combatScope)) {
        throw new Error(`${stage} stage requires its preregistered seed ${defaultSeedFor(stage, combatScope)}`);
    }
    if (!values.output) throw new Error("--output is required and must name a new directory");
    const cohorts = parseCohorts(values.cohorts);
    const requiredConcurrency = combatScope === "ranged-battery" ? 6 : 12;
    const concurrency = safeInteger(values.concurrency, "concurrency", requiredConcurrency);
    if (combatScope === "ranged-battery" && concurrency !== requiredConcurrency) {
        throw new Error("ranged-battery combat scope requires concurrency 6");
    }
    const maxLaps = safeInteger(values["max-laps"], "max-laps", 60);
    if (stage === "validation" || stage === "replication") {
        if (cohorts.length !== AI_META_COHORTS.length || AI_META_COHORTS.some((cohort) => !cohorts.includes(cohort))) {
            throw new Error(`${stage} stage requires all preregistered cohorts`);
        }
        if (concurrency !== requiredConcurrency) {
            throw new Error(`${stage} stage requires concurrency ${requiredConcurrency}`);
        }
        if (maxLaps !== 60) throw new Error(`${stage} stage requires max-laps 60`);
    }
    const components = parseRankedReplayAbComponents(values.components);
    if (!components.combat && values["combat-candidate"] !== undefined) {
        throw new Error("--combat-candidate requires the combat component");
    }
    if (components.combat && combatScope === "ranged-battery" && combatCandidate === "shortlist-3") {
        throw new Error("shortlist-3 requires --combat-scope all");
    }
    const combatEpsilon = Number(values["combat-epsilon"] ?? "0.002");
    if (![0.002, 0.005].includes(combatEpsilon)) {
        throw new Error("combat-epsilon must be one of the preregistered development values 0.002 or 0.005");
    }
    return {
        pairs,
        baseSeed,
        output: resolve(values.output),
        concurrency,
        cohorts,
        components,
        combatScope,
        combatCandidate,
        combatEpsilon,
        maxLaps,
        stage,
    };
}

const walkFiles = (root: string): string[] => {
    const files: string[] = [];
    const visit = (directory: string): void => {
        for (const name of readdirSync(directory).sort()) {
            const path = join(directory, name);
            const stat = statSync(path);
            if (stat.isDirectory()) visit(path);
            else if (stat.isFile()) files.push(path);
        }
    };
    visit(root);
    return files;
};

export function rankedReplayAbSourceIdentity(commonRoot: string = resolve(import.meta.dir, "../..")): ISourceIdentity {
    const files = [
        ...walkFiles(join(commonRoot, "src")),
        join(commonRoot, "package.json"),
        ...["bun.lock", "bunfig.toml"].map((name) => join(commonRoot, name)).filter(existsSync),
    ].sort();
    const hash = createHash("sha256");
    for (const path of files) {
        hash.update(relative(commonRoot, path));
        hash.update("\0");
        hash.update(readFileSync(path));
        hash.update("\0");
    }
    const git = (args: string[]): string => execFileSync("git", args, { cwd: commonRoot, encoding: "utf8" }).trim();
    return {
        commonCommit: git(["rev-parse", "HEAD"]),
        dirty: git(["status", "--porcelain", "--", "src", "package.json"]).length > 0,
        sourceSha256: hash.digest("hex"),
        files: files.length,
    };
}

const minimalWorkerEnvironment = (
    components: RankedReplayAbComponents,
    combatEpsilon: number,
    combatScope: RankedReplayAbCombatScope,
    combatCandidate: RankedReplayAbCombatCandidate,
): Record<string, string> => {
    const environment: Record<string, string> = {};
    for (const key of ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE"]) {
        const value = process.env[key];
        if (value !== undefined) environment[key] = value;
    }
    Object.assign(environment, buildRankedReplayAbEnvironment(components, combatEpsilon, combatScope, combatCandidate));
    environment.BUN_RUNTIME_TRANSPILER_CACHE_PATH = "0";
    return environment;
};

type WorkerMessage =
    { type: "ready" } | { type: "result"; record: IRankedReplayAbClusterRecord } | { type: "error"; error: string };

async function runTasks(
    options: IRankedReplayAbRunnerOptions,
    rawPath: string,
): Promise<IRankedReplayAbClusterRecord[]> {
    const tasks: ITask[] = options.cohorts.flatMap((cohort) =>
        Array.from({ length: options.pairs }, (_, pair) => ({ cohort, pair })),
    );
    const records: IRankedReplayAbClusterRecord[] = [];
    const workerCount = Math.min(options.concurrency, tasks.length);
    const environment = minimalWorkerEnvironment(
        options.components,
        options.combatEpsilon,
        options.combatScope,
        options.combatCandidate,
    );
    let dispatched = 0;
    let completed = 0;
    let lastProgress = Date.now();
    return new Promise((resolvePromise, rejectPromise) => {
        const workers: Worker[] = [];
        const draining = new WeakSet<Worker>();
        let settled = false;
        const cleanup = (): void => workers.forEach((worker) => void worker.terminate());
        const fail = (error: unknown): void => {
            if (settled) return;
            settled = true;
            cleanup();
            rejectPromise(error instanceof Error ? error : new Error(String(error)));
        };
        const dispatch = (worker: Worker): void => {
            const task = tasks[dispatched++];
            if (!task) {
                draining.add(worker);
                worker.postMessage({ type: "stop" });
                return;
            }
            worker.postMessage({
                type: "cluster",
                options: {
                    cohort: task.cohort,
                    pairs: options.pairs,
                    baseSeed: options.baseSeed,
                    components: options.components,
                    combatScope: options.combatScope,
                    combatCandidate: options.combatCandidate,
                    maxLaps: options.maxLaps,
                } satisfies IRankedReplayAbOptions,
                pair: task.pair,
            });
        };
        for (let index = 0; index < workerCount; index += 1) {
            const worker = new Worker(new URL("./ranked_replay_tactics_ab_worker.ts", import.meta.url), {
                env: environment,
            });
            workers.push(worker);
            worker.on("message", (message: WorkerMessage) => {
                if (settled) return;
                if (message.type === "error") {
                    fail(new Error(message.error));
                    return;
                }
                if (message.type === "ready") {
                    dispatch(worker);
                    return;
                }
                records.push(message.record);
                appendFileSync(rawPath, `${JSON.stringify(message.record)}\n`);
                completed += 1;
                const now = Date.now();
                if (now - lastProgress >= 5000 || completed === tasks.length) {
                    lastProgress = now;
                    console.error(
                        `[replay-ab] ${completed}/${tasks.length} clusters (${completed * RANKED_REPLAY_TACTICS_AB_CLUSTER_SIZE} fights)`,
                    );
                }
                if (completed === tasks.length) {
                    settled = true;
                    cleanup();
                    records.sort((left, right) => left.cohort.localeCompare(right.cohort) || left.pair - right.pair);
                    resolvePromise(records);
                    return;
                }
                dispatch(worker);
            });
            worker.on("error", fail);
            worker.on("exit", (code) => {
                if (!settled && (!draining.has(worker) || code !== 0)) {
                    fail(new Error(`Replay A/B worker exited unexpectedly with code ${code}`));
                }
            });
        }
    });
}

export function validateRankedReplayAbRecords(
    records: readonly IRankedReplayAbClusterRecord[],
    options: Pick<
        IRankedReplayAbRunnerOptions,
        "pairs" | "cohorts" | "baseSeed" | "components" | "combatScope" | "combatCandidate"
    >,
    rawLines: number,
    sourceUnchanged: boolean,
    sourceDirty: boolean,
): IQuality {
    const expectedClusters = options.pairs * options.cohorts.length;
    let malformedClusters = 0;
    const identities = new Set<string>();
    const expectedIdentities = new Set(
        options.cohorts.flatMap((cohort) => Array.from({ length: options.pairs }, (_, pair) => `${cohort}:${pair}`)),
    );
    const mapClusters: Record<string, number> = {};
    const cohortClusters: Record<string, number> = {};
    let rejectedCandidate = 0;
    let rejectedControl = 0;
    let armageddonDecided = 0;
    let overlappingRosterAssignments = 0;
    const expectedComponents = JSON.stringify(options.components);
    for (const record of records) {
        const identity = `${record.cohort}:${record.pair}`;
        if (identities.has(identity) || !expectedIdentities.delete(identity)) malformedClusters += 1;
        identities.add(identity);
        const expectedPairSeed = hashSimulationParts(
            "ranked-replay-ab-pair",
            options.baseSeed,
            record.cohort,
            record.pair,
        );
        const expectedPickSeed = hashSimulationParts(
            "ranked-replay-ab-pick",
            options.baseSeed,
            record.cohort,
            record.pair,
        );
        const expectedCombatSeed = hashSimulationParts(
            "ranked-replay-ab-combat",
            options.baseSeed,
            record.cohort,
            record.pair,
        );
        if (
            record.schema !== RANKED_REPLAY_TACTICS_AB_SCHEMA ||
            !options.cohorts.includes(record.cohort) ||
            !Number.isInteger(record.pair) ||
            record.pair < 0 ||
            record.pair >= options.pairs ||
            record.map !== cohortMap(record.cohort, record.pair) ||
            record.pairSeed !== expectedPairSeed ||
            record.pickSeed !== expectedPickSeed ||
            record.combatSeed !== expectedCombatSeed ||
            JSON.stringify(record.components) !== expectedComponents ||
            record.combatScope !== options.combatScope ||
            record.combatCandidate !== options.combatCandidate ||
            record.games.length !== RANKED_REPLAY_TACTICS_AB_CLUSTER_SIZE ||
            record.games[0].setupFingerprint !== record.games[1].setupFingerprint ||
            record.games[2].setupFingerprint !== record.games[3].setupFingerprint ||
            record.games[0].candidateRosterSignature !== record.games[1].candidateRosterSignature ||
            record.games[0].controlRosterSignature !== record.games[1].controlRosterSignature ||
            record.games[2].candidateRosterSignature !== record.games[3].candidateRosterSignature ||
            record.games[2].controlRosterSignature !== record.games[3].controlRosterSignature ||
            record.games[0].candidateRosterSignature === record.games[0].controlRosterSignature ||
            record.games[2].candidateRosterSignature === record.games[2].controlRosterSignature
        ) {
            malformedClusters += 1;
        }
        const expectedSeats =
            record.cohort === "ranked-draft"
                ? (["candidate-lower", "candidate-upper"] as const)
                : (["candidate-roster-a", "candidate-roster-b"] as const);
        const expectedCombatMatchupEligible = rankedReplayCombatClusterEligible(
            options.components,
            options.combatScope,
            record.games.map((game) => game.candidateSetupIdentity),
        );
        for (let gameIndex = 0; gameIndex < record.games.length; gameIndex += 1) {
            const game = record.games[gameIndex];
            const assignment = gameIndex < 2 ? 0 : 1;
            const battleMirror = (gameIndex % 2) as 0 | 1;
            const candidateSide = battleMirror === 0 ? "green" : "red";
            const candidateResult = game.winner === "draw" ? "draw" : game.winner === candidateSide ? "win" : "loss";
            const candidateScore = candidateResult === "win" ? 1 : candidateResult === "draw" ? 0.5 : 0;
            if (
                game.assignment !== assignment ||
                game.battleMirror !== battleMirror ||
                game.candidateSide !== candidateSide ||
                game.draftSeat !== expectedSeats[assignment] ||
                game.candidateResult !== candidateResult ||
                game.candidateScore !== candidateScore ||
                game.combatMatchupEligible !== expectedCombatMatchupEligible
            ) {
                malformedClusters += 1;
                break;
            }
        }
        for (const game of [record.games[0], record.games[2]]) {
            const candidateNames = new Set(game.candidateRosterSignature.split("|").filter(Boolean));
            if (game.controlRosterSignature.split("|").some((name) => candidateNames.has(name))) {
                overlappingRosterAssignments += 1;
            }
        }
        mapClusters[String(record.map)] = (mapClusters[String(record.map)] ?? 0) + 1;
        cohortClusters[record.cohort] = (cohortClusters[record.cohort] ?? 0) + 1;
        for (const game of record.games) {
            rejectedCandidate += game.rejectedCandidate;
            rejectedControl += game.rejectedControl;
            armageddonDecided += Number(game.armageddonDecided);
        }
    }
    if (records.length !== expectedClusters || rawLines !== expectedClusters || expectedIdentities.size > 0) {
        malformedClusters += 1;
    }
    for (const cohort of options.cohorts) {
        if (cohortClusters[cohort] !== options.pairs) malformedClusters += 1;
        for (const map of RANKED_REPLAY_TACTICS_AB_LIVE_MAPS) {
            const count = records.filter((record) => record.cohort === cohort && record.map === map).length;
            if (count !== options.pairs / RANKED_REPLAY_TACTICS_AB_LIVE_MAPS.length) malformedClusters += 1;
        }
    }
    return {
        expectedClusters,
        clusters: records.length,
        games: records.length * RANKED_REPLAY_TACTICS_AB_CLUSTER_SIZE,
        rejectedCandidate,
        rejectedControl,
        armageddonDecided,
        malformedClusters,
        overlappingRosterAssignments,
        mapClusters,
        cohortClusters,
        rawLines,
        sourceUnchanged,
        sourceDirty,
    };
}

const validationGate = (
    rows: ReturnType<typeof summarizeRankedReplayAbRecords>,
    quality: IQuality,
    components: RankedReplayAbComponents,
): Record<string, { passed: boolean; observed: unknown; requirement: string }> => {
    const supported = <T extends { clusters: number }>(values: readonly T[]): T[] =>
        values.filter((value) => value.clusters > 0);
    const noMaterialRegression = (values: readonly { liftPp: number }[], floor: number): boolean =>
        values.every((value) => value.liftPp >= floor - 1e-9);
    const noClearRegression = (values: readonly { ciHigh: number }[]): boolean =>
        values.every((value) => value.ciHigh >= 0.5);
    return {
        practicalUplift: {
            passed: rows.overall.liftPp >= 1,
            observed: rows.overall.liftPp,
            requirement: "overall draw-aware lift >= +1.0pp",
        },
        measurableUplift: {
            passed: rows.overall.ciLow >= 0.5025,
            observed: rows.overall.ciLow,
            requirement: "overall two-sided clustered 95% lower bound >= 50.25%",
        },
        cohortSafety: {
            passed: noMaterialRegression(supported(rows.cohorts), -2) && noClearRegression(supported(rows.cohorts)),
            observed: rows.cohorts,
            requirement: "no cohort below -2pp or statistically clearly harmful",
        },
        mapSafety: {
            passed: noMaterialRegression(supported(rows.maps), -2) && noClearRegression(supported(rows.maps)),
            observed: rows.maps,
            requirement: "no live map below -2pp or statistically clearly harmful",
        },
        sliceSafety: {
            passed:
                noMaterialRegression(
                    supported([
                        ...rows.cohortMaps,
                        ...(components.combat ? rows.combatEligibility : []),
                        ...(components.setup ? rows.setupIdentities : []),
                        ...(components.splits ? rows.splitTrigger : []),
                    ]),
                    -2,
                ) &&
                noClearRegression(
                    supported([
                        ...rows.cohortMaps,
                        ...(components.combat ? rows.combatEligibility : []),
                        ...(components.setup ? rows.setupIdentities : []),
                        ...(components.splits ? rows.splitTrigger : []),
                    ]),
                ),
            observed: {
                cohortMaps: rows.cohortMaps,
                setupIdentities: rows.setupIdentities,
                splitTrigger: rows.splitTrigger,
                combatEligibility: rows.combatEligibility,
            },
            requirement: "no active-component full-cluster slice below -2pp or statistically clearly harmful",
        },
        quality: {
            passed:
                quality.rejectedCandidate === 0 &&
                quality.rejectedControl === 0 &&
                quality.malformedClusters === 0 &&
                quality.overlappingRosterAssignments === 0 &&
                quality.sourceUnchanged,
            observed: quality,
            requirement: "zero rejections/malformed or overlapping rosters and an unchanged source fingerprint",
        },
    };
};

export async function runRankedReplayAb(options: IRankedReplayAbRunnerOptions): Promise<Record<string, unknown>> {
    if (existsSync(options.output)) {
        throw new Error(`Refusing to resume or overwrite existing replay A/B output ${options.output}`);
    }
    mkdirSync(options.output, { recursive: false });
    const rawPath = join(options.output, RANKED_REPLAY_AB_RAW_FILE);
    writeFileSync(rawPath, "");
    const sourceBefore = rankedReplayAbSourceIdentity();
    const startedAt = new Date();
    const startedMs = Date.now();
    writeFileSync(
        join(options.output, RANKED_REPLAY_AB_STARTED_FILE),
        `${JSON.stringify(
            {
                schema: RANKED_REPLAY_TACTICS_AB_SCHEMA,
                stage: options.stage,
                options,
                sourceBefore,
                environmentSha256: rankedReplayAbEnvironmentSha256(
                    options.components,
                    options.combatEpsilon,
                    options.combatScope,
                    options.combatCandidate,
                ),
                startedAt: startedAt.toISOString(),
            },
            null,
            2,
        )}\n`,
    );
    const records = await runTasks(options, rawPath);
    const sourceAfter = rankedReplayAbSourceIdentity();
    const sourceUnchanged = sourceBefore.sourceSha256 === sourceAfter.sourceSha256;
    // Workers finish out of order; canonicalize completed output without sacrificing append-only crash recovery.
    writeFileSync(rawPath, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    const rawLines = readFileSync(rawPath, "utf8").split("\n").filter(Boolean).length;
    const quality = validateRankedReplayAbRecords(
        records,
        options,
        rawLines,
        sourceUnchanged,
        sourceBefore.dirty || sourceAfter.dirty,
    );
    const rankings = summarizeRankedReplayAbRecords(records);
    const promotionStage = options.stage === "validation" || options.stage === "replication";
    const gates = validationGate(rankings, quality, options.components);
    const allGatesPassed = Object.values(gates).every((gate) => gate.passed);
    const complete =
        quality.malformedClusters === 0 &&
        quality.overlappingRosterAssignments === 0 &&
        quality.rejectedCandidate === 0 &&
        quality.rejectedControl === 0 &&
        sourceUnchanged;
    const summary = {
        schema: RANKED_REPLAY_TACTICS_AB_SCHEMA,
        complete,
        stage: options.stage,
        promotionEvidence: promotionStage,
        verdict: promotionStage ? (allGatesPassed ? "measurably_better" : "rejected") : "development_only",
        generatedAt: new Date().toISOString(),
        seconds: (Date.now() - startedMs) / 1000,
        options: {
            ...options,
            clusterSize: RANKED_REPLAY_TACTICS_AB_CLUSTER_SIZE,
            totalGames: options.pairs * options.cohorts.length * RANKED_REPLAY_TACTICS_AB_CLUSTER_SIZE,
        },
        preregistration: {
            developmentSeed: RANKED_REPLAY_AB_DEVELOPMENT_SEED,
            rangedBatteryDevelopmentSeed: RANKED_REPLAY_AB_RANGED_BATTERY_DEVELOPMENT_SEED,
            selectedDevelopmentSeed: defaultSeedFor("development", options.combatScope),
            concurrency: {
                broad: 12,
                rangedBattery: 6,
                selected: options.concurrency,
            },
            validationSeed: RANKED_REPLAY_AB_VALIDATION_SEED,
            replicationSeed: RANKED_REPLAY_AB_REPLICATION_SEED,
            primaryEstimand: "draw-aware candidate score over four-game offer-board clusters",
            practicalLiftPp: 1,
            validationCiLow: 0.5025,
            optionalStopping: "validation is one-shot and must complete before inspection",
        },
        arms: {
            control: RANKED_REPLAY_TACTICS_AB_CONTROL,
            candidate: {
                draft: options.components.draft ? LEAGUE_ROUND1_DRAFT_SPEC : RANKED_REPLAY_TACTICS_AB_CONTROL.draft,
                setup: options.components.setup ? RANKED_REPLAY_TACTICS_SETUP_SPEC : V07_NONFIGHT_SETUP_SPEC,
                splits: options.components.splits,
                searchTreatment: options.components.combat
                    ? options.combatCandidate === "shortlist-3"
                        ? { controlShortlist: 2, candidateShortlist: 3, horizon: 12, scope: options.combatScope }
                        : {
                              controlHorizon: 12,
                              candidateHorizon: Number(options.combatCandidate.slice("horizon-".length)),
                              shortlist: 2,
                              scope: options.combatScope,
                              ...(options.combatScope === "ranged-battery" ? { minDistinctNativeRangedTypes: 2 } : {}),
                          }
                    : "none",
                waitScorerV2: options.components.wait,
            },
            splitSimulation:
                "post-action state reconstructed before placement; authoritative split acceptance/events/journal are server-tested separately",
        },
        cohortDescriptions: Object.fromEntries(
            options.cohorts.map((cohort) => [cohort, AI_META_COHORT_DESCRIPTIONS[cohort]]),
        ),
        provenance: {
            sourceBefore,
            sourceAfter,
            environmentSha256: rankedReplayAbEnvironmentSha256(
                options.components,
                options.combatEpsilon,
                options.combatScope,
                options.combatCandidate,
            ),
            combatCandidate: options.combatCandidate,
            combatScope: options.combatScope,
            combatScopePredicate:
                options.combatScope === "ranged-battery"
                    ? ">=2 distinct living, non-summoned initial creature names with base attack_type RANGE"
                    : "all acting candidate teams",
            startedAt: startedAt.toISOString(),
            runtime: {
                bun: Bun.version,
                platform: platform(),
                arch: arch(),
                release: release(),
                cpu: cpus()[0]?.model ?? "unknown",
                logicalCpus: cpus().length,
                availableParallelism: availableParallelism(),
                workerConcurrency: options.concurrency,
                memory: totalmem(),
            },
        },
        quality,
        rankings,
        gates,
    };
    writeFileSync(join(options.output, RANKED_REPLAY_AB_SUMMARY_FILE), `${JSON.stringify(summary, null, 2)}\n`);
    return summary;
}

if (import.meta.main) {
    runRankedReplayAb(parseRankedReplayAbRunnerOptions(process.argv.slice(2)))
        .then((summary) => {
            const overall = (summary.rankings as ReturnType<typeof summarizeRankedReplayAbRecords>).overall;
            console.log(
                JSON.stringify(
                    {
                        verdict: summary.verdict,
                        complete: summary.complete,
                        games: (summary.quality as IQuality).games,
                        scoreRate: overall.scoreRate,
                        liftPp: overall.liftPp,
                        ci: [overall.ciLow, overall.ciHigh],
                        output: (summary.options as IRankedReplayAbRunnerOptions).output,
                    },
                    null,
                    2,
                ),
            );
        })
        .catch((error) => {
            console.error(error instanceof Error ? (error.stack ?? error.message) : error);
            process.exitCode = 1;
        });
}
