#!/usr/bin/env bun

/**
 * External exact-source latency/circuit panel for production a13 shortlist 3 versus shortlist 2.
 *
 * This evidence runner never patches the source root. Workers dynamically import one explicit root,
 * instrument SearchDriver/StrategyV0_8 in memory, and execute the same prepared matchup twice per arm and
 * physical side. S3 takes battle_engine's untouched automatic production factory. S2 runs the same canonical
 * a13 environment with only SEARCH_SHORTLIST changed to 2.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { arch, availableParallelism, cpus, platform, release, totalmem } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parentPort, Worker } from "node:worker_threads";

const SCHEMA = "hoc.v0_8_s3_vs_s2_latency_circuit_panel.v1" as const;
const SOURCE_VERSION = "v0.8" as const;
const ANCHOR_VERSION = "v0.7" as const;
const S3_SHORTLIST = 3 as const;
const S2_SHORTLIST = 2 as const;
const DECISION_DEADLINE_MS = 175 as const;
const COMMON_CIRCUIT_MS = 275 as const;
const RANKED_OUTER_CIRCUIT_MS = 300 as const;
const MAX_LAPS = 60 as const;
const PAIRS_PER_COHORT = 3 as const;
const REPEATS = 2 as const;
const BASE_SEED = 928_203_517 as const;
const DEFAULT_SOURCE_ROOT = "/tmp/hoc-common-s3-exact.puVp0M";
const RAW_FILE = "s3-vs-s2-latency.records.jsonl";
const SUMMARY_FILE = "s3-vs-s2-latency.summary.json";
const SCRIPT_PATH = fileURLToPath(import.meta.url);

const COHORTS = [
    "ranked-draft",
    "uniform-mixed",
    "ranged-heavy",
    "ground-melee",
    "flyer-heavy",
    "caster-support",
    "cross-archetype",
] as const;
const MAPS = [1, 3, 4] as const;

type Cohort = (typeof COHORTS)[number];
type Arm = "s3" | "s2";
type Side = "green" | "red";
type OuterCircuitState = "closed" | "timing_open" | "hard_open";

interface IOptions {
    sourceRoot: string;
    expectedSourceSha256: string;
    output: string;
    concurrency: Array<1 | 6>;
}

interface ISourceRuntime {
    profile: Record<string, any>;
    battle: Record<string, any>;
    cohorts: Record<string, any>;
    searchScope: Record<string, any>;
    searchDriver: Record<string, any>;
    ai: Record<string, any>;
}

interface ISourceSeal {
    root: string;
    gitCommit: string;
    gitTree: string;
    gitDirty: boolean;
    gitStatusSha256: string;
    sourceSha256: string;
    files: number;
    bytes: number;
    selectedFiles: Record<string, string>;
    runnerSha256: string;
}

interface IEnvironmentSeal {
    candidateEnvironmentSha256: string;
    controlEnvironmentSha256: string;
    productionBehaviorEnvironmentSha256: string;
    genomeSha256: string;
    delta: Array<{ key: string; s3: string | null; s2: string | null }>;
    expectedDriver: Record<string, unknown>;
}

interface ITask {
    cohort: Cohort;
    pair: number;
}

interface ISearchCounters {
    decisions: number;
    searched: number;
    overrides: number;
    illegalIncumbent: number;
    singleCandidate: number;
    candidatesTotal: number;
    scoredCandidatesTotal: number;
    rolloutTurnsTotal: number;
    deadlineFallbacks: number;
    circuitWaitArbitrations: number;
    circuitSkipped: number;
}

interface IDecisionTiming {
    ordinal: number;
    unitId: string;
    creatureName: string;
    lap: number;
    team: number;
    policyMs: number;
    searchMs: number;
    totalDecisionMs: number;
    postDecisionExecutionMs: number;
    fullTurnMs: number;
    arbitrationOverheadMs: number;
    searchInvoked: boolean;
    counters: ISearchCounters;
    commonCircuitOpenBefore: boolean;
    commonCircuitOpenAfter: boolean;
    projectedOuterStateBefore: OuterCircuitState;
    projectedOuterStateAfter: OuterCircuitState;
    searchException: string | null;
    driverProfileSha256: string | null;
    rawActionTypes: string[];
    chosenActionTypes: string[];
    executedActionTypes: string[];
    rejectedActionReasons: Array<string | null>;
    recoveryAttempts: number;
    recoveryCompleted: boolean;
    recoverySource: string;
}

interface IGameRecord {
    arm: Arm;
    candidateSide: Side;
    repeat: number;
    elapsedMs: number;
    elapsedPerAcceptedActionMs: number | null;
    winner: Side | "draw";
    endReason: string;
    laps: number;
    totalActions: number;
    rejectedCandidate: number;
    rejectedAnchor: number;
    actionDigest: string;
    outcomeDigest: string;
    placementDigest: string;
    resultDigest: string;
    setupDigest: string;
    candidateRosterSignature: string;
    anchorRosterSignature: string;
    decisions: IDecisionTiming[];
}

interface IClusterRecord {
    schema: typeof SCHEMA;
    cohort: Cohort;
    pair: number;
    setupSeed: number;
    combatSeed: number;
    map: number;
    preparedDigest: string;
    schedule: string[];
    games: IGameRecord[];
}

interface IWorkerReady {
    type: "ready";
    workerIndex: number;
    environment: IEnvironmentSeal;
    behaviorEnvironmentSha256: string;
    warmup: null | { games: number; decisions: number; elapsedMs: number; digest: string };
}

type WorkerResponse = IWorkerReady | { type: "result"; record: IClusterRecord } | { type: "error"; error: string };
type WorkerRequest = { type: "cluster"; task: ITask } | { type: "stop" };

interface IPendingDecision {
    ordinal: number;
    unitId: string;
    creatureName: string;
    lap: number;
    team: number;
    startedAt: number;
    policyEndedAt: number;
    decisionEndedAt: number;
    policyMs: number;
    searchMs: number;
    searchInvoked: boolean;
    counters: ISearchCounters;
    commonCircuitOpenBefore: boolean;
    commonCircuitOpenAfter: boolean;
    projectedOuterStateBefore: OuterCircuitState;
    projectedOuterStateAfter: OuterCircuitState;
    searchException: string | null;
    driverProfileSha256: string | null;
}

interface IActiveMatch {
    arm: Arm;
    outerState: OuterCircuitState;
    nextOrdinal: number;
    pending: IPendingDecision | null;
    decisions: IDecisionTiming[];
}

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

function canonicalize(value: unknown): unknown {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
        if (Number.isNaN(value)) return "__NaN__";
        if (value === Number.POSITIVE_INFINITY) return "__Infinity__";
        if (value === Number.NEGATIVE_INFINITY) return "__-Infinity__";
        return Object.is(value, -0) ? 0 : value;
    }
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value instanceof Set) return [...value].map(canonicalize).sort();
    if (value instanceof Map) {
        return [...value.entries()]
            .map(([key, item]) => [canonicalize(key), canonicalize(item)])
            .sort((left, right) => JSON.stringify(left[0]).localeCompare(JSON.stringify(right[0])));
    }
    if (typeof value === "object") {
        const output: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) {
            const item = (value as Record<string, unknown>)[key];
            if (item !== undefined) output[key] = canonicalize(item);
        }
        return output;
    }
    return String(value);
}

const canonicalJson = (value: unknown): string => JSON.stringify(canonicalize(value));
const digest = (value: unknown): string => sha256(canonicalJson(value));
const fileSha256 = (path: string): string => sha256(readFileSync(path));

function listFiles(root: string): string[] {
    const output: string[] = [];
    const visit = (directory: string): void => {
        for (const name of readdirSync(directory).sort()) {
            const path = join(directory, name);
            const stat = statSync(path);
            if (stat.isDirectory()) visit(path);
            else if (stat.isFile()) output.push(path);
        }
    };
    visit(root);
    return output;
}

function requireSourceRoot(input: string): string {
    const root = resolve(input);
    for (const path of [
        "src/ai/versions/v0_8_a13_profile.ts",
        "src/simulation/v0_8_a13_search.ts",
        "src/simulation/search_driver.ts",
        "src/simulation/battle_engine.ts",
        "src/simulation/ai_meta_cohorts_core.ts",
    ]) {
        if (!existsSync(join(root, path))) throw new Error(`source root is missing ${path}: ${root}`);
    }
    return root;
}

function sourceSeal(input: string): ISourceSeal {
    const root = requireSourceRoot(input);
    const support = ["package.json", "bun.lock", "bunfig.toml"].map((name) => join(root, name)).filter(existsSync);
    const files = [...listFiles(join(root, "src")), ...support].sort();
    const hash = createHash("sha256");
    let bytes = 0;
    for (const path of files) {
        const contents = readFileSync(path);
        const name = relative(root, path);
        bytes += contents.byteLength;
        hash.update(`${Buffer.byteLength(name)}:${name}:${contents.byteLength}:`);
        hash.update(contents);
    }
    const git = (args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    const status = execFileSync("git", ["status", "--porcelain=v1", "-z", "--", "src", "package.json", "bun.lock"], {
        cwd: root,
    });
    const selected = [
        "src/ai/versions/v0_8_a13_profile.ts",
        "src/simulation/v0_8_a13_search.ts",
        "src/simulation/search_driver.ts",
        "src/simulation/battle_engine.ts",
        "src/simulation/ai_meta_cohorts_core.ts",
        "package.json",
        "bun.lock",
    ];
    return {
        root,
        gitCommit: git(["rev-parse", "HEAD"]),
        gitTree: git(["rev-parse", "HEAD^{tree}"]),
        gitDirty: status.byteLength > 0,
        gitStatusSha256: sha256(status),
        sourceSha256: hash.digest("hex"),
        files: files.length,
        bytes,
        selectedFiles: Object.fromEntries(
            selected.filter((path) => existsSync(join(root, path))).map((path) => [path, fileSha256(join(root, path))]),
        ),
        runnerSha256: fileSha256(SCRIPT_PATH),
    };
}

async function loadRuntime(sourceRoot: string): Promise<ISourceRuntime> {
    const source = (path: string): string => pathToFileURL(join(sourceRoot, "src", path)).href;
    const [profile, battle, cohorts, searchScope, searchDriver, ai] = await Promise.all([
        import(source("ai/versions/v0_8_a13_profile.ts")),
        import(source("simulation/battle_engine.ts")),
        import(source("simulation/ai_meta_cohorts_core.ts")),
        import(source("simulation/v0_8_a13_search.ts")),
        import(source("simulation/search_driver.ts")),
        import(source("ai/index.ts")),
    ]);
    return { profile, battle, cohorts, searchScope, searchDriver, ai };
}

const stableEnvironment = (value: Readonly<Record<string, string | undefined>>): Array<[string, string | null]> =>
    Object.entries(value)
        .map(([key, item]) => [key, item ?? null] as [string, string | null])
        .sort(([left], [right]) => left.localeCompare(right));

function candidateEnvironment(runtime: ISourceRuntime): Readonly<Record<string, string | undefined>> {
    return runtime.profile.buildV08A13SearchEnvironment(SOURCE_VERSION);
}

function controlEnvironment(runtime: ISourceRuntime): Readonly<Record<string, string | undefined>> {
    return { ...candidateEnvironment(runtime), SEARCH_SHORTLIST: String(S2_SHORTLIST) };
}

function environmentDelta(runtime: ISourceRuntime): IEnvironmentSeal["delta"] {
    const s3 = new Map(stableEnvironment(candidateEnvironment(runtime)));
    const s2 = new Map(stableEnvironment(controlEnvironment(runtime)));
    return [...new Set([...s3.keys(), ...s2.keys()])].sort().flatMap((key) => {
        const candidate = s3.get(key) ?? null;
        const control = s2.get(key) ?? null;
        return candidate === control ? [] : [{ key, s3: candidate, s2: control }];
    });
}

function assertEnvironment(runtime: ISourceRuntime): IEnvironmentSeal {
    const s3 = candidateEnvironment(runtime);
    const s2 = controlEnvironment(runtime);
    const delta = environmentDelta(runtime);
    if (runtime.profile.V08_A13_PRODUCTION_VERSION !== SOURCE_VERSION)
        throw new Error("a13 production version drifted");
    if (runtime.profile.V08_A13_SEARCH.shortlist !== S3_SHORTLIST) throw new Error("source is not production S3");
    if (
        runtime.profile.V08_A13_SEARCH.decisionDeadlineMs !== DECISION_DEADLINE_MS ||
        runtime.profile.V08_A13_SEARCH.circuitBreakerMs !== COMMON_CIRCUIT_MS
    ) {
        throw new Error("a13 deadline/circuit profile drifted");
    }
    if (s3.V07_SEARCH !== "1" || s3.SEARCH_SHORTLIST !== String(S3_SHORTLIST)) {
        throw new Error("canonical a13 environment is not search-enabled S3");
    }
    if (
        delta.length !== 1 ||
        delta[0].key !== "SEARCH_SHORTLIST" ||
        delta[0].s3 !== String(S3_SHORTLIST) ||
        delta[0].s2 !== String(S2_SHORTLIST)
    ) {
        throw new Error(`control escaped the one-key shortlist ablation: ${JSON.stringify(delta)}`);
    }
    if (canonicalJson(runtime.cohorts.AI_META_COHORTS) !== canonicalJson(COHORTS)) {
        throw new Error("cohort catalog drifted");
    }
    if (canonicalJson(runtime.cohorts.AI_META_MAPS) !== canonicalJson(MAPS)) throw new Error("live maps drifted");
    return {
        candidateEnvironmentSha256: digest(stableEnvironment(s3)),
        controlEnvironmentSha256: digest(stableEnvironment(s2)),
        productionBehaviorEnvironmentSha256: String(runtime.profile.V08_A13_PRODUCTION_BEHAVIOR_ENVIRONMENT_SHA256),
        genomeSha256: String(runtime.profile.V08_A13_GENOME_SHA256),
        delta,
        expectedDriver: {
            version: SOURCE_VERSION,
            horizon: runtime.profile.V08_A13_SEARCH.horizon,
            rollouts: runtime.profile.V08_A13_SEARCH.rollouts,
            deadlineMs: DECISION_DEADLINE_MS,
            waitDeadlinePolicy: runtime.profile.V08_A13_SEARCH.waitDeadlinePolicy,
            circuitBreakerMs: COMMON_CIRCUIT_MS,
            s3Shortlist: S3_SHORTLIST,
            s2Shortlist: S2_SHORTLIST,
        },
    };
}

function numericCounters(driver: unknown): ISearchCounters {
    const counters = (driver as { counters?: Record<string, unknown> }).counters ?? {};
    const number = (key: keyof ISearchCounters): number => Number(counters[key] ?? 0);
    return {
        decisions: number("decisions"),
        searched: number("searched"),
        overrides: number("overrides"),
        illegalIncumbent: number("illegalIncumbent"),
        singleCandidate: number("singleCandidate"),
        candidatesTotal: number("candidatesTotal"),
        scoredCandidatesTotal: number("scoredCandidatesTotal"),
        rolloutTurnsTotal: number("rolloutTurnsTotal"),
        deadlineFallbacks: number("deadlineFallbacks"),
        circuitWaitArbitrations: number("circuitWaitArbitrations"),
        circuitSkipped: number("circuitSkipped"),
    };
}

function subtractCounters(after: ISearchCounters, before: ISearchCounters): ISearchCounters {
    return Object.fromEntries(
        Object.keys(after).map((key) => [
            key,
            after[key as keyof ISearchCounters] - before[key as keyof ISearchCounters],
        ]),
    ) as unknown as ISearchCounters;
}

function driverProfile(driver: unknown): Record<string, unknown> {
    const value = driver as Record<string, any>;
    return {
        enabled: value.enabled === true,
        mode: value.mode,
        versions: value.versions instanceof Set ? [...value.versions].sort() : value.versions,
        gate: value.gate,
        horizon: value.horizon,
        rollouts: value.rollouts,
        shortlist: value.shortlist,
        decisionDeadlineMs: value.decisionDeadlineMs,
        waitDeadlinePolicy: value.waitDeadlinePolicy,
        circuitBreakerMs: value.circuitBreakerMs,
        rollbackStrategy: value.rollbackStrategy,
        includeMoves: value.includeMoves,
        activeChallengers: value.activeChallengers,
        aggressiveV08: value.aggressiveV08,
    };
}

function assertDriverProfile(profile: Record<string, unknown>, arm: Arm): void {
    const expectedShortlist = arm === "s3" ? S3_SHORTLIST : S2_SHORTLIST;
    if (
        profile.enabled !== true ||
        profile.mode !== "search" ||
        !Array.isArray(profile.versions) ||
        !profile.versions.includes(SOURCE_VERSION) ||
        profile.shortlist !== expectedShortlist ||
        profile.horizon !== 12 ||
        profile.rollouts !== 2 ||
        profile.decisionDeadlineMs !== DECISION_DEADLINE_MS ||
        profile.waitDeadlinePolicy !== "operation_bounded" ||
        profile.circuitBreakerMs !== COMMON_CIRCUIT_MS
    ) {
        throw new Error(`${arm} constructed the wrong SearchDriver: ${canonicalJson(profile)}`);
    }
}

function errorLabel(error: unknown): string {
    if (error instanceof Error) return `${error.name}:${error.message}`;
    return String(error);
}

function actionTypes(actions: readonly unknown[]): string[] {
    return actions.map((action) => String((action as { type?: unknown }).type ?? "unknown"));
}

function installInstrumentation(runtime: ISourceRuntime): {
    beginMatch: (arm: Arm) => void;
    observeExecution: (observation: unknown) => void;
    endMatch: () => IDecisionTiming[];
    abortMatch: () => void;
} {
    const SearchDriver = runtime.searchDriver.SearchDriver as {
        prototype: {
            chooseDecision: (
                unit: unknown,
                version: string,
                incumbent: readonly unknown[],
                context?: unknown,
            ) => unknown[];
        };
    };
    const strategy = runtime.ai.getAIStrategy(SOURCE_VERSION) as {
        decideTurn: (unit: unknown, context: unknown) => unknown[];
    };
    const originalChoose = SearchDriver.prototype.chooseDecision;
    const originalDecide = strategy.decideTurn;
    let active: IActiveMatch | null = null;
    let searchDepth = 0;

    strategy.decideTurn = function instrumentedDecide(unitValue: unknown, contextValue: unknown): unknown[] {
        if (!active || searchDepth > 0) return originalDecide.call(this, unitValue, contextValue);
        if (active.pending) throw new Error(`decision overlap before ${active.pending.unitId} was observed`);
        const unit = unitValue as { getId: () => string; getName: () => string; getTeam: () => number };
        const context = contextValue as { fightProperties?: { getCurrentLap: () => number } };
        const startedAt = performance.now();
        try {
            return originalDecide.call(this, unitValue, contextValue);
        } finally {
            const endedAt = performance.now();
            active.pending = {
                ordinal: active.nextOrdinal++,
                unitId: unit.getId(),
                creatureName: unit.getName(),
                lap: Number(context.fightProperties?.getCurrentLap() ?? -1),
                team: unit.getTeam(),
                startedAt,
                policyEndedAt: endedAt,
                decisionEndedAt: endedAt,
                policyMs: endedAt - startedAt,
                searchMs: 0,
                searchInvoked: false,
                counters: subtractCounters(numericCounters({}), numericCounters({})),
                commonCircuitOpenBefore: false,
                commonCircuitOpenAfter: false,
                projectedOuterStateBefore: active.outerState,
                projectedOuterStateAfter: active.outerState,
                searchException: null,
                driverProfileSha256: null,
            };
        }
    };

    SearchDriver.prototype.chooseDecision = function instrumentedChoose(
        unitValue: unknown,
        version: string,
        incumbent: readonly unknown[],
        context?: unknown,
    ): unknown[] {
        const tracked = active?.pending ?? null;
        const before = numericCounters(this);
        const commonOpenBefore = (this as { circuitOpen?: boolean }).circuitOpen === true;
        const profile = driverProfile(this);
        if (active) assertDriverProfile(profile, active.arm);
        const outerBefore = active?.outerState ?? "closed";
        const startedAt = performance.now();
        let thrown: unknown = null;
        searchDepth += 1;
        try {
            return originalChoose.call(this, unitValue, version, incumbent, context);
        } catch (error) {
            thrown = error;
            throw error;
        } finally {
            searchDepth -= 1;
            const endedAt = performance.now();
            const searchMs = endedAt - startedAt;
            const after = numericCounters(this);
            const commonOpenAfter = (this as { circuitOpen?: boolean }).circuitOpen === true;
            let outerAfter = outerBefore;
            if (thrown) outerAfter = "hard_open";
            else if (outerBefore === "closed" && searchMs > RANKED_OUTER_CIRCUIT_MS) outerAfter = "timing_open";
            if (active) active.outerState = outerAfter;
            if (tracked && active?.pending === tracked) {
                tracked.searchInvoked = true;
                tracked.searchMs = searchMs;
                tracked.decisionEndedAt = endedAt;
                tracked.counters = subtractCounters(after, before);
                tracked.commonCircuitOpenBefore = commonOpenBefore;
                tracked.commonCircuitOpenAfter = commonOpenAfter;
                tracked.projectedOuterStateBefore = outerBefore;
                tracked.projectedOuterStateAfter = outerAfter;
                tracked.searchException = thrown ? errorLabel(thrown) : null;
                tracked.driverProfileSha256 = digest(profile);
            }
        }
    };

    return {
        beginMatch(arm): void {
            if (active) throw new Error("instrumentation match overlap");
            active = { arm, outerState: "closed", nextOrdinal: 0, pending: null, decisions: [] };
        },
        observeExecution(observationValue): void {
            const observation = observationValue as {
                unitId: string;
                strategyVersion: string;
                rawIncumbent: readonly unknown[];
                chosenDecision: readonly unknown[];
                strategyActions: ReadonlyArray<{ action: unknown; completed: boolean; rejectionReason?: string }>;
                recoveryAttempts: readonly unknown[];
                recovery: { source: string; completed: boolean };
            };
            if (!active) throw new Error("turn execution arrived outside an instrumented match");
            // The observer sees the fixed v0.7 anchor too, plus candidate-owned MINDLESS units that are
            // intentionally pinned to v0.1. Neither is searched by the candidate a13 driver.
            if (!active.pending && observation.strategyVersion !== SOURCE_VERSION) return;
            if (!active.pending) throw new Error("v0.8 turn execution arrived without a timed decision");
            const pending = active.pending;
            if (observation.unitId !== pending.unitId) {
                throw new Error(`decision/execution identity mismatch ${pending.unitId} != ${observation.unitId}`);
            }
            const observedAt = performance.now();
            active.decisions.push({
                ordinal: pending.ordinal,
                unitId: pending.unitId,
                creatureName: pending.creatureName,
                lap: pending.lap,
                team: pending.team,
                policyMs: pending.policyMs,
                searchMs: pending.searchMs,
                totalDecisionMs: pending.decisionEndedAt - pending.startedAt,
                postDecisionExecutionMs: observedAt - pending.decisionEndedAt,
                fullTurnMs: observedAt - pending.startedAt,
                arbitrationOverheadMs: pending.decisionEndedAt - pending.policyEndedAt - pending.searchMs,
                searchInvoked: pending.searchInvoked,
                counters: pending.counters,
                commonCircuitOpenBefore: pending.commonCircuitOpenBefore,
                commonCircuitOpenAfter: pending.commonCircuitOpenAfter,
                projectedOuterStateBefore: pending.projectedOuterStateBefore,
                projectedOuterStateAfter: pending.projectedOuterStateAfter,
                searchException: pending.searchException,
                driverProfileSha256: pending.driverProfileSha256,
                rawActionTypes: actionTypes(observation.rawIncumbent),
                chosenActionTypes: actionTypes(observation.chosenDecision),
                executedActionTypes: observation.strategyActions
                    .filter((entry) => entry.completed)
                    .map((entry) => String((entry.action as { type?: unknown }).type ?? "unknown")),
                rejectedActionReasons: observation.strategyActions
                    .filter((entry) => !entry.completed)
                    .map((entry) => entry.rejectionReason ?? null),
                recoveryAttempts: observation.recoveryAttempts.length,
                recoveryCompleted: observation.recovery.completed,
                recoverySource: observation.recovery.source,
            });
            active.pending = null;
        },
        endMatch(): IDecisionTiming[] {
            if (!active) throw new Error("cannot end inactive instrumentation");
            if (active.pending) throw new Error(`unobserved decision ${active.pending.unitId}`);
            const decisions = active.decisions;
            active = null;
            return decisions;
        },
        abortMatch(): void {
            active = null;
        },
    };
}

function setupDigest(army: any, anchor: any, map: number): string {
    const sealArmy = (value: any): unknown => ({
        roster: value.roster,
        perk: value.perk,
        augments: value.augment.augments,
        artifactT1: value.artifactT1.id,
        artifactT2: value.artifactT2.id,
        synergies: value.synergies,
    });
    return digest({ candidate: sealArmy(army), anchor: sealArmy(anchor), map });
}

function matchConfig(
    candidate: any,
    anchor: any,
    candidateSide: Side,
    prepared: any,
    maxLaps: number,
): Record<string, unknown> {
    const candidateGreen = candidateSide === "green";
    const green = candidateGreen ? candidate : anchor;
    const red = candidateGreen ? anchor : candidate;
    return {
        greenVersion: candidateGreen ? SOURCE_VERSION : ANCHOR_VERSION,
        redVersion: candidateGreen ? ANCHOR_VERSION : SOURCE_VERSION,
        roster: green.roster,
        redRoster: red.roster,
        seed: prepared.combatSeed,
        gridType: prepared.map,
        maxLaps,
        headlessEvents: true,
        greenPerk: green.perk,
        redPerk: red.perk,
        greenAugments: green.augment.augments,
        redAugments: red.augment.augments,
        greenArtifactT1: green.artifactT1.id,
        redArtifactT1: red.artifactT1.id,
        greenArtifactT2: green.artifactT2.id,
        redArtifactT2: red.artifactT2.id,
        greenSynergies: green.synergies,
        redSynergies: red.synergies,
        placementAugmentTiming: "setup-before-placement",
    };
}

function playGame(
    runtime: ISourceRuntime,
    tracker: ReturnType<typeof installInstrumentation>,
    prepared: any,
    arm: Arm,
    candidateSide: Side,
    repeat: number,
    maxLaps: number = MAX_LAPS,
): IGameRecord {
    const candidate = prepared.armyA;
    const anchor = prepared.armyB;
    const config = matchConfig(candidate, anchor, candidateSide, prepared, maxLaps);
    config.turnExecutionObserver = (observation: unknown): void => tracker.observeExecution(observation);
    tracker.beginMatch(arm);
    const startedAt = performance.now();
    let result: any;
    try {
        result =
            arm === "s3"
                ? runtime.battle.runMatch(config)
                : runtime.searchScope.withScopedAIEnvironment(controlEnvironment(runtime), () =>
                      runtime.battle.runMatch(config),
                  );
    } catch (error) {
        tracker.abortMatch();
        throw error;
    }
    const elapsedMs = performance.now() - startedAt;
    const decisions = tracker.endMatch();
    const candidateGreen = candidateSide === "green";
    const rejectedCandidate = Number(candidateGreen ? result.rejectedGreen : result.rejectedRed) || 0;
    const rejectedAnchor = Number(candidateGreen ? result.rejectedRed : result.rejectedGreen) || 0;
    const actionDigest = digest(result.actions);
    const outcomeDigest = digest({
        winner: result.winner,
        endReason: result.endReason,
        laps: result.laps,
        outcome: result.outcome,
        attrition: result.attrition,
    });
    const placementDigest = digest(result.placements);
    return {
        arm,
        candidateSide,
        repeat,
        elapsedMs,
        elapsedPerAcceptedActionMs: result.totalActions > 0 ? elapsedMs / result.totalActions : null,
        winner: result.winner,
        endReason: result.endReason,
        laps: result.laps,
        totalActions: result.totalActions,
        rejectedCandidate,
        rejectedAnchor,
        actionDigest,
        outcomeDigest,
        placementDigest,
        resultDigest: digest({ actionDigest, outcomeDigest, placementDigest, totalActions: result.totalActions }),
        setupDigest: setupDigest(candidate, anchor, prepared.map),
        candidateRosterSignature: runtime.cohorts.rosterSignature(candidate.roster),
        anchorRosterSignature: runtime.cohorts.rosterSignature(anchor.roster),
        decisions,
    };
}

function gameSchedule(cohort: Cohort, pair: number): Array<{ arm: Arm; side: Side; repeat: number }> {
    const parity = (COHORTS.indexOf(cohort) + pair) % 2;
    const first: Arm = parity === 0 ? "s3" : "s2";
    const second: Arm = first === "s3" ? "s2" : "s3";
    return [
        { arm: first, side: "green", repeat: 0 },
        { arm: second, side: "green", repeat: 0 },
        { arm: second, side: "green", repeat: 1 },
        { arm: first, side: "green", repeat: 1 },
        { arm: second, side: "red", repeat: 0 },
        { arm: first, side: "red", repeat: 0 },
        { arm: first, side: "red", repeat: 1 },
        { arm: second, side: "red", repeat: 1 },
    ];
}

function playCluster(
    runtime: ISourceRuntime,
    tracker: ReturnType<typeof installInstrumentation>,
    task: ITask,
): IClusterRecord {
    const prepared = runtime.cohorts.prepareMetaPair(
        { cohort: task.cohort, games: PAIRS_PER_COHORT * 2, baseSeed: BASE_SEED },
        task.pair,
    );
    if (!runtime.cohorts.rostersAreStrictlyDistinct(prepared.armyA.roster, prepared.armyB.roster)) {
        throw new Error(`${task.cohort}:${task.pair} has overlapping rosters`);
    }
    const schedule = gameSchedule(task.cohort, task.pair);
    return {
        schema: SCHEMA,
        cohort: task.cohort,
        pair: task.pair,
        setupSeed: prepared.setupSeed,
        combatSeed: prepared.combatSeed,
        map: prepared.map,
        preparedDigest: digest(prepared),
        schedule: schedule.map((entry) => `${entry.arm}:${entry.side}:r${entry.repeat}`),
        games: schedule.map((entry) => playGame(runtime, tracker, prepared, entry.arm, entry.side, entry.repeat)),
    };
}

function behaviorEnvironment(): Record<string, string | undefined> {
    const prefixes = ["SEARCH_", "V04_", "V05_", "V06_", "V07_", "V08_", "V09_", "Q2_"];
    const exact = new Set(["NODE_ENV", "SIM_NO_ACTIONS", "LIVETWIN", "FIGHT_MELEE_ROSTERS"]);
    return Object.fromEntries(
        Object.entries(process.env)
            .filter(([key]) => exact.has(key) || prefixes.some((prefix) => key.startsWith(prefix)))
            .sort(([left], [right]) => left.localeCompare(right)),
    );
}

function workerEnvironment(sourceRoot: string, workerIndex: number, mode: "preflight" | "run"): Record<string, string> {
    const output: Record<string, string> = {
        NODE_ENV: "production",
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        LIVETWIN: "1",
        FIGHT_MELEE_ROSTERS: "0",
        HOC_S3_LATENCY_SOURCE_ROOT: sourceRoot,
        HOC_S3_LATENCY_WORKER_INDEX: String(workerIndex),
        HOC_S3_LATENCY_WORKER_MODE: mode,
    };
    for (const key of ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ"]) {
        const value = process.env[key];
        if (value !== undefined) output[key] = value;
    }
    return output;
}

async function workerMain(port: NonNullable<typeof parentPort>): Promise<void> {
    const sourceRoot = process.env.HOC_S3_LATENCY_SOURCE_ROOT;
    if (!sourceRoot) throw new Error("worker has no HOC_S3_LATENCY_SOURCE_ROOT");
    delete process.env.SIM_NO_ACTIONS;
    const workerIndex = Number(process.env.HOC_S3_LATENCY_WORKER_INDEX ?? -1);
    const runtime = await loadRuntime(sourceRoot);
    const environment = assertEnvironment(runtime);
    const tracker = installInstrumentation(runtime);
    let warmup: IWorkerReady["warmup"] = null;
    if (process.env.HOC_S3_LATENCY_WORKER_MODE === "run") {
        const prepared = runtime.cohorts.prepareMetaPair(
            { cohort: "ranked-draft", games: PAIRS_PER_COHORT * 2, baseSeed: BASE_SEED ^ (workerIndex + 1) },
            0,
        );
        const order: Arm[] = workerIndex % 2 === 0 ? ["s3", "s2"] : ["s2", "s3"];
        const startedAt = performance.now();
        const records = order.map((arm, repeat) => playGame(runtime, tracker, prepared, arm, "green", repeat, 2));
        warmup = {
            games: records.length,
            decisions: records.reduce((sum, record) => sum + record.decisions.length, 0),
            elapsedMs: performance.now() - startedAt,
            digest: digest(records.map((record) => record.resultDigest)),
        };
    }
    port.on("message", (message: WorkerRequest) => {
        if (message.type === "stop") {
            port.close();
            return;
        }
        try {
            port.postMessage({
                type: "result",
                record: playCluster(runtime, tracker, message.task),
            } satisfies WorkerResponse);
        } catch (error) {
            port.postMessage({
                type: "error",
                error: error instanceof Error ? (error.stack ?? error.message) : String(error),
            } satisfies WorkerResponse);
        }
    });
    port.postMessage({
        type: "ready",
        workerIndex,
        environment,
        behaviorEnvironmentSha256: digest(stableEnvironment(behaviorEnvironment())),
        warmup,
    } satisfies IWorkerReady);
}

function quantiles(values: readonly number[]): Record<string, number | null> {
    if (!values.length) return { p50: null, p95: null, p99: null, max: null, mean: null, total: 0 };
    const sorted = [...values].sort((left, right) => left - right);
    const at = (probability: number): number => sorted[Math.max(0, Math.ceil(probability * sorted.length) - 1)];
    return {
        p50: at(0.5),
        p95: at(0.95),
        p99: at(0.99),
        max: sorted[sorted.length - 1],
        mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
        total: sorted.reduce((sum, value) => sum + value, 0),
    };
}

function sumCounters(decisions: readonly IDecisionTiming[]): ISearchCounters {
    return decisions.reduce(
        (sum, decision) => {
            for (const key of Object.keys(sum) as Array<keyof ISearchCounters>) sum[key] += decision.counters[key];
            return sum;
        },
        {
            decisions: 0,
            searched: 0,
            overrides: 0,
            illegalIncumbent: 0,
            singleCandidate: 0,
            candidatesTotal: 0,
            scoredCandidatesTotal: 0,
            rolloutTurnsTotal: 0,
            deadlineFallbacks: 0,
            circuitWaitArbitrations: 0,
            circuitSkipped: 0,
        },
    );
}

function armSummary(games: readonly IGameRecord[], arm: Arm): Record<string, unknown> {
    const selected = games.filter((game) => game.arm === arm);
    const decisions = selected.flatMap((game) => game.decisions);
    const searched = decisions.filter((decision) => decision.searchInvoked);
    const counters = sumCounters(decisions);
    return {
        arm,
        matches: selected.length,
        acceptedActions: selected.reduce((sum, game) => sum + game.totalActions, 0),
        rejectedCandidate: selected.reduce((sum, game) => sum + game.rejectedCandidate, 0),
        rejectedAnchor: selected.reduce((sum, game) => sum + game.rejectedAnchor, 0),
        decisions: decisions.length,
        searchedDecisions: searched.length,
        counters,
        timing: {
            matchMs: quantiles(selected.map((game) => game.elapsedMs)),
            matchMsPerAcceptedAction: quantiles(
                selected.flatMap((game) =>
                    game.elapsedPerAcceptedActionMs === null ? [] : [game.elapsedPerAcceptedActionMs],
                ),
            ),
            policyMs: quantiles(decisions.map((decision) => decision.policyMs)),
            searchMs: quantiles(searched.map((decision) => decision.searchMs)),
            totalDecisionMs: quantiles(decisions.map((decision) => decision.totalDecisionMs)),
            postDecisionExecutionMs: quantiles(decisions.map((decision) => decision.postDecisionExecutionMs)),
            fullTurnMs: quantiles(decisions.map((decision) => decision.fullTurnMs)),
        },
        thresholds: {
            totalDecisionAbove175: decisions.filter((decision) => decision.totalDecisionMs > DECISION_DEADLINE_MS)
                .length,
            totalDecisionAbove275: decisions.filter((decision) => decision.totalDecisionMs > COMMON_CIRCUIT_MS).length,
            totalDecisionAbove300: decisions.filter((decision) => decision.totalDecisionMs > RANKED_OUTER_CIRCUIT_MS)
                .length,
            searchAbove175: searched.filter((decision) => decision.searchMs > DECISION_DEADLINE_MS).length,
            searchAbove275: searched.filter((decision) => decision.searchMs > COMMON_CIRCUIT_MS).length,
            searchAbove300: searched.filter((decision) => decision.searchMs > RANKED_OUTER_CIRCUIT_MS).length,
        },
        circuit: {
            commonOpens: decisions.filter(
                (decision) => !decision.commonCircuitOpenBefore && decision.commonCircuitOpenAfter,
            ).length,
            commonOpenDecisions: decisions.filter((decision) => decision.commonCircuitOpenBefore).length,
            projectedOuterTimingOpens: decisions.filter(
                (decision) =>
                    decision.projectedOuterStateBefore === "closed" &&
                    decision.projectedOuterStateAfter === "timing_open",
            ).length,
            projectedOuterHardOpens: decisions.filter((decision) => decision.projectedOuterStateAfter === "hard_open")
                .length,
            projectedOuterTimingDelegations: decisions.filter(
                (decision) => decision.projectedOuterStateBefore === "timing_open",
            ).length,
            exceptions: decisions.filter((decision) => decision.searchException !== null).length,
        },
        driverProfileSha256: [...new Set(decisions.flatMap((decision) => decision.driverProfileSha256 ?? []))].sort(),
    };
}

function cleanTiming(game: IGameRecord): boolean {
    const counters = sumCounters(game.decisions);
    return (
        counters.deadlineFallbacks === 0 &&
        counters.circuitSkipped === 0 &&
        counters.circuitWaitArbitrations === 0 &&
        game.decisions.every(
            (decision) =>
                !decision.commonCircuitOpenBefore &&
                !decision.commonCircuitOpenAfter &&
                decision.projectedOuterStateBefore === "closed" &&
                decision.projectedOuterStateAfter === "closed" &&
                decision.searchException === null,
        )
    );
}

function repeatParity(records: readonly IClusterRecord[]): Record<string, unknown> {
    let cells = 0;
    let timingEligible = 0;
    let timingIneligible = 0;
    let cleanActionDigestMismatches = 0;
    let cleanOutcomeDigestMismatches = 0;
    let cleanPlacementDigestMismatches = 0;
    let cleanResultDigestMismatches = 0;
    let cleanActionCountMismatches = 0;
    const mismatches: string[] = [];
    for (const record of records) {
        for (const arm of ["s3", "s2"] as const) {
            for (const side of ["green", "red"] as const) {
                cells += 1;
                const pair = record.games.filter((game) => game.arm === arm && game.candidateSide === side);
                if (pair.length !== REPEATS)
                    throw new Error(`repeat cell malformed: ${record.cohort}:${record.pair}:${arm}:${side}`);
                if (!pair.every(cleanTiming)) {
                    timingIneligible += 1;
                    continue;
                }
                timingEligible += 1;
                const label = `${record.cohort}:${record.pair}:${arm}:${side}`;
                const compare = (key: keyof IGameRecord): boolean => pair[0][key] === pair[1][key];
                cleanActionDigestMismatches += Number(!compare("actionDigest"));
                cleanOutcomeDigestMismatches += Number(!compare("outcomeDigest"));
                cleanPlacementDigestMismatches += Number(!compare("placementDigest"));
                cleanResultDigestMismatches += Number(!compare("resultDigest"));
                cleanActionCountMismatches += Number(!compare("totalActions"));
                if (!compare("resultDigest") && mismatches.length < 20) mismatches.push(label);
            }
        }
    }
    return {
        cells,
        timingEligible,
        timingIneligible,
        cleanActionDigestMismatches,
        cleanOutcomeDigestMismatches,
        cleanPlacementDigestMismatches,
        cleanResultDigestMismatches,
        cleanActionCountMismatches,
        mismatchExamples: mismatches,
    };
}

function pairedComparison(records: readonly IClusterRecord[]): Record<string, unknown> {
    const pairs: Array<{ s3: IGameRecord; s2: IGameRecord }> = [];
    for (const record of records) {
        for (const side of ["green", "red"] as const) {
            for (let repeat = 0; repeat < REPEATS; repeat += 1) {
                const s3 = record.games.find(
                    (game) => game.arm === "s3" && game.candidateSide === side && game.repeat === repeat,
                );
                const s2 = record.games.find(
                    (game) => game.arm === "s2" && game.candidateSide === side && game.repeat === repeat,
                );
                if (!s3 || !s2 || s3.setupDigest !== s2.setupDigest) throw new Error("matched arm cell is malformed");
                pairs.push({ s3, s2 });
            }
        }
    }
    const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
    const decisionMean = (game: IGameRecord): number =>
        game.decisions.length
            ? game.decisions.reduce((sum, decision) => sum + decision.totalDecisionMs, 0) / game.decisions.length
            : 0;
    const safeRatio = (numerator: number, denominator: number): number | null =>
        denominator > 0 ? numerator / denominator : null;
    return {
        matchedGames: pairs.length,
        matchWallDeltaMs: quantiles(pairs.map(({ s3, s2 }) => s3.elapsedMs - s2.elapsedMs)),
        meanMatchWallRatio: safeRatio(
            mean(pairs.map((pair) => pair.s3.elapsedMs)),
            mean(pairs.map((pair) => pair.s2.elapsedMs)),
        ),
        meanDecisionDeltaMs: quantiles(pairs.map(({ s3, s2 }) => decisionMean(s3) - decisionMean(s2))),
        crossArmActionDigestEqual: pairs.filter(({ s3, s2 }) => s3.actionDigest === s2.actionDigest).length,
        crossArmOutcomeDigestEqual: pairs.filter(({ s3, s2 }) => s3.outcomeDigest === s2.outcomeDigest).length,
        crossArmResultDigestEqual: pairs.filter(({ s3, s2 }) => s3.resultDigest === s2.resultDigest).length,
        note: "Cross-arm digest equality is diagnostic, not a gate: shortlist 3 intentionally admits one additional challenger.",
    };
}

function numericPath(value: Record<string, unknown>, path: string): number {
    let current: unknown = value;
    for (const key of path.split(".")) current = (current as Record<string, unknown>)[key];
    return Number(current);
}

function validateCondition(
    records: readonly IClusterRecord[],
    sourceUnchanged: boolean,
    runnerUnchanged: boolean,
    workerSeals: readonly IWorkerReady[],
    concurrency: 1 | 6,
    environment: IEnvironmentSeal,
): Record<string, unknown> {
    const expected = new Set(
        COHORTS.flatMap((cohort) => Array.from({ length: PAIRS_PER_COHORT }, (_, pair) => `${cohort}:${pair}`)),
    );
    let malformed = 0;
    for (const record of records) {
        if (!expected.delete(`${record.cohort}:${record.pair}`)) malformed += 1;
        if (
            record.schema !== SCHEMA ||
            record.games.length !== 8 ||
            record.map !== MAPS[record.pair % MAPS.length] ||
            new Set(record.games.map((game) => game.setupDigest)).size !== 1
        )
            malformed += 1;
        for (const arm of ["s3", "s2"] as const) {
            for (const side of ["green", "red"] as const) {
                const games = record.games.filter((game) => game.arm === arm && game.candidateSide === side);
                if (games.length !== REPEATS || new Set(games.map((game) => game.repeat)).size !== REPEATS)
                    malformed += 1;
            }
        }
    }
    if (expected.size || records.length !== COHORTS.length * PAIRS_PER_COHORT) malformed += 1;
    const expectedWorkers = Math.min(concurrency, records.length);
    const workerEnvironmentMismatch = workerSeals.filter(
        (seal) => canonicalJson(seal.environment) !== canonicalJson(environment),
    ).length;
    const missingWarmups = workerSeals.filter((seal) => !seal.warmup || seal.warmup.games !== 2).length;
    return {
        expectedClusters: COHORTS.length * PAIRS_PER_COHORT,
        clusters: records.length,
        expectedGames: COHORTS.length * PAIRS_PER_COHORT * 8,
        games: records.reduce((sum, record) => sum + record.games.length, 0),
        malformed,
        expectedWorkers,
        workerSeals: workerSeals.length,
        workerEnvironmentMismatch,
        missingWarmups,
        behaviorEnvironmentHashes: [...new Set(workerSeals.map((seal) => seal.behaviorEnvironmentSha256))],
        sourceUnchanged,
        runnerUnchanged,
    };
}

function conditionSummary(
    records: readonly IClusterRecord[],
    quality: Record<string, unknown>,
): Record<string, unknown> {
    const games = records.flatMap((record) => record.games);
    const s3 = armSummary(games, "s3");
    const s2 = armSummary(games, "s2");
    const parity = repeatParity(records);
    const candidateOnlyFields = [
        "counters.deadlineFallbacks",
        "counters.circuitWaitArbitrations",
        "counters.circuitSkipped",
        "circuit.commonOpens",
        "circuit.projectedOuterTimingOpens",
        "circuit.projectedOuterHardOpens",
        "circuit.exceptions",
        "rejectedCandidate",
    ];
    const candidateOnly = Object.fromEntries(
        candidateOnlyFields.map((path) => {
            const s3Value = numericPath(s3, path);
            const s2Value = numericPath(s2, path);
            return [path, { s3: s3Value, s2: s2Value, positiveS3Delta: Math.max(0, s3Value - s2Value) }];
        }),
    );
    const candidateOnlyTotal = Object.values(candidateOnly).reduce(
        (sum, value) => sum + Number((value as { positiveS3Delta: number }).positiveS3Delta),
        0,
    );
    const absoluteS3Faults = [
        "counters.deadlineFallbacks",
        "counters.circuitSkipped",
        "circuit.commonOpens",
        "circuit.projectedOuterTimingOpens",
        "circuit.projectedOuterHardOpens",
        "circuit.exceptions",
        "rejectedCandidate",
    ].reduce((sum, path) => sum + numericPath(s3, path), 0);
    const qualityPassed =
        quality.malformed === 0 &&
        quality.workerSeals === quality.expectedWorkers &&
        quality.workerEnvironmentMismatch === 0 &&
        quality.missingWarmups === 0 &&
        quality.sourceUnchanged === true &&
        quality.runnerUnchanged === true;
    const repeatParityPassed =
        parity.cleanActionDigestMismatches === 0 &&
        parity.cleanOutcomeDigestMismatches === 0 &&
        parity.cleanPlacementDigestMismatches === 0 &&
        parity.cleanResultDigestMismatches === 0 &&
        parity.cleanActionCountMismatches === 0;
    return {
        s3,
        s2,
        paired: pairedComparison(records),
        repeatParity: parity,
        candidateOnly,
        gates: {
            quality: {
                passed: qualityPassed,
                observed: quality,
                requirement: "complete fixed corpus, identical worker contract, unchanged source and runner",
            },
            candidateOnlySafety: {
                passed: candidateOnlyTotal === 0,
                observedPositiveS3Delta: candidateOnlyTotal,
                requirement: "zero positive S3-minus-S2 fallback/circuit/exception/rejection events",
            },
            absoluteProductionSafety: {
                passed: absoluteS3Faults === 0,
                observedS3Faults: absoluteS3Faults,
                requirement: "zero S3 fallback, circuit-open, exception, and rejected-action events",
            },
            cleanRepeatParity: {
                passed: repeatParityPassed,
                observed: parity,
                requirement: "identical repeated action/state digests whenever neither repeat crossed a timing path",
            },
        },
    };
}

function conditionTasks(): ITask[] {
    return COHORTS.flatMap((cohort) => Array.from({ length: PAIRS_PER_COHORT }, (_, pair) => ({ cohort, pair })));
}

async function runWorkers(
    sourceRoot: string,
    concurrency: 1 | 6,
    rawPath: string,
): Promise<{ records: IClusterRecord[]; workerSeals: IWorkerReady[] }> {
    const tasks = conditionTasks();
    const records: IClusterRecord[] = [];
    const workerSeals: IWorkerReady[] = [];
    const workers: Worker[] = [];
    const count = Math.min(concurrency, tasks.length);
    let dispatched = 0;
    let completed = 0;
    return new Promise((resolvePromise, rejectPromise) => {
        let settled = false;
        const stop = (): void => workers.forEach((worker) => void worker.terminate());
        const fail = (error: unknown): void => {
            if (settled) return;
            settled = true;
            stop();
            rejectPromise(error instanceof Error ? error : new Error(String(error)));
        };
        const dispatch = (worker: Worker): void => {
            const task = tasks[dispatched++];
            worker.postMessage(
                task ? ({ type: "cluster", task } satisfies WorkerRequest) : ({ type: "stop" } satisfies WorkerRequest),
            );
        };
        for (let index = 0; index < count; index += 1) {
            const worker = new Worker(new URL(import.meta.url), { env: workerEnvironment(sourceRoot, index, "run") });
            workers.push(worker);
            worker.on("message", (message: WorkerResponse) => {
                if (settled) return;
                if (message.type === "error") return fail(new Error(message.error));
                if (message.type === "ready") {
                    workerSeals.push(message);
                    dispatch(worker);
                    return;
                }
                records.push(message.record);
                appendFileSync(rawPath, `${JSON.stringify(message.record)}\n`);
                completed += 1;
                console.error(
                    `[s3-latency:c${concurrency}] ${completed}/${tasks.length} clusters (${completed * 8} matches)`,
                );
                if (completed === tasks.length) {
                    settled = true;
                    stop();
                    resolvePromise({ records, workerSeals });
                    return;
                }
                dispatch(worker);
            });
            worker.on("error", fail);
            worker.on("exit", (code) => {
                if (!settled && code !== 0) fail(new Error(`worker ${index} exited with code ${code}`));
            });
        }
    });
}

async function workerPreflight(sourceRoot: string, environment: IEnvironmentSeal): Promise<IWorkerReady> {
    return new Promise((resolvePromise, rejectPromise) => {
        const worker = new Worker(new URL(import.meta.url), { env: workerEnvironment(sourceRoot, 0, "preflight") });
        let settled = false;
        const fail = (error: unknown): void => {
            if (settled) return;
            settled = true;
            void worker.terminate();
            rejectPromise(error instanceof Error ? error : new Error(String(error)));
        };
        worker.on("message", (message: WorkerResponse) => {
            if (message.type === "error") return fail(new Error(message.error));
            if (message.type !== "ready") return fail(new Error("preflight worker executed a cluster"));
            if (message.warmup !== null) return fail(new Error("preflight worker executed a warmup fight"));
            if (canonicalJson(message.environment) !== canonicalJson(environment)) {
                return fail(new Error("preflight worker environment seal differs"));
            }
            settled = true;
            void worker.terminate();
            resolvePromise(message);
        });
        worker.on("error", fail);
        worker.on("exit", (code) => {
            if (!settled && code !== 0) fail(new Error(`preflight worker exited with code ${code}`));
        });
    });
}

function parseConcurrency(raw: string | undefined): Array<1 | 6> {
    const values = (raw ?? "1,6").split(",").map((value) => Number(value.trim()));
    if (
        !values.length ||
        values.some((value) => value !== 1 && value !== 6) ||
        new Set(values).size !== values.length
    ) {
        throw new Error("--concurrency must be 1, 6, or 1,6");
    }
    return values as Array<1 | 6>;
}

function parseOptions(argv: readonly string[]): IOptions {
    const { values } = parseArgs({
        args: [...argv],
        options: {
            "source-root": { type: "string" },
            "expected-source-sha256": { type: "string" },
            output: { type: "string" },
            concurrency: { type: "string" },
        },
        strict: true,
        allowPositionals: false,
    });
    if (!values.output) throw new Error("--output is required and must be a new directory");
    if (!values["expected-source-sha256"]?.trim()) throw new Error("--expected-source-sha256 is required");
    return {
        sourceRoot: requireSourceRoot(values["source-root"] ?? DEFAULT_SOURCE_ROOT),
        expectedSourceSha256: values["expected-source-sha256"].trim(),
        output: resolve(values.output),
        concurrency: parseConcurrency(values.concurrency),
    };
}

function utilitySourceRoot(argv: readonly string[]): string {
    const index = argv.indexOf("--source-root");
    if (index === -1) return requireSourceRoot(DEFAULT_SOURCE_ROOT);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("--source-root requires a path");
    return requireSourceRoot(value);
}

async function selfTest(sourceRoot: string): Promise<void> {
    const runtime = await loadRuntime(sourceRoot);
    const environment = assertEnvironment(runtime);
    const sample = quantiles([9, 1, 7, 3, 5]);
    if (sample.p50 !== 5 || sample.p95 !== 9 || sample.p99 !== 9 || sample.max !== 9) {
        throw new Error(`nearest-rank percentile self-test failed: ${JSON.stringify(sample)}`);
    }
    const before: ISearchCounters = {
        decisions: 1,
        searched: 1,
        overrides: 0,
        illegalIncumbent: 0,
        singleCandidate: 0,
        candidatesTotal: 4,
        scoredCandidatesTotal: 2,
        rolloutTurnsTotal: 24,
        deadlineFallbacks: 0,
        circuitWaitArbitrations: 0,
        circuitSkipped: 0,
    };
    const delta = subtractCounters({ ...before, decisions: 2, candidatesTotal: 9 }, before);
    if (delta.decisions !== 1 || delta.candidatesTotal !== 5 || delta.rolloutTurnsTotal !== 0) {
        throw new Error("counter-delta self-test failed");
    }
    if (
        gameSchedule("ranked-draft", 0).length !== 8 ||
        new Set(gameSchedule("ranked-draft", 0).map((entry) => `${entry.arm}:${entry.side}:${entry.repeat}`)).size !== 8
    ) {
        throw new Error("ABBA/BAAB schedule self-test failed");
    }
    const tracker = installInstrumentation(runtime);
    tracker.beginMatch("s3");
    tracker.observeExecution({ unitId: "anchor", strategyVersion: ANCHOR_VERSION });
    if (tracker.endMatch().length !== 0) throw new Error("anchor-observer filter self-test failed");
    console.log(JSON.stringify({ ok: true, schema: SCHEMA, fightsExecuted: 0, environment, sample, delta }, null, 2));
}

async function preflight(sourceRoot: string): Promise<void> {
    const runtime = await loadRuntime(sourceRoot);
    const environment = assertEnvironment(runtime);
    const source = sourceSeal(sourceRoot);
    const worker = await workerPreflight(sourceRoot, environment);
    console.log(
        JSON.stringify(
            {
                ok: true,
                schema: SCHEMA,
                fightsExecuted: 0,
                source,
                environment,
                worker: {
                    environment: worker.environment,
                    behaviorEnvironmentSha256: worker.behaviorEnvironmentSha256,
                    warmup: worker.warmup,
                },
                frozenWorkload: {
                    seed: BASE_SEED,
                    cohorts: COHORTS,
                    maps: MAPS,
                    pairsPerCohort: PAIRS_PER_COHORT,
                    repeatsPerArmSide: REPEATS,
                    matchesPerCondition: COHORTS.length * PAIRS_PER_COHORT * 8,
                    conditions: [1, 6],
                    totalMatches: COHORTS.length * PAIRS_PER_COHORT * 8 * 2,
                    maxLaps: MAX_LAPS,
                },
            },
            null,
            2,
        ),
    );
}

async function run(options: IOptions): Promise<Record<string, unknown>> {
    if (existsSync(options.output)) throw new Error(`refusing to reuse output directory ${options.output}`);
    mkdirSync(options.output, { recursive: false });
    const runtime = await loadRuntime(options.sourceRoot);
    const environment = assertEnvironment(runtime);
    const sourceBefore = sourceSeal(options.sourceRoot);
    if (sourceBefore.sourceSha256 !== options.expectedSourceSha256) {
        throw new Error(
            `source seal mismatch: expected ${options.expectedSourceSha256}, got ${sourceBefore.sourceSha256}`,
        );
    }
    writeFileSync(
        join(options.output, "s3-vs-s2-latency.started.json"),
        `${JSON.stringify({ schema: SCHEMA, startedAt: new Date().toISOString(), options, sourceBefore, environment }, null, 2)}\n`,
    );
    const startedAt = performance.now();
    const conditions: Record<string, unknown>[] = [];
    for (const concurrency of options.concurrency) {
        const directory = join(options.output, `c${concurrency}`);
        mkdirSync(directory);
        const rawPath = join(directory, RAW_FILE);
        writeFileSync(rawPath, "");
        const conditionSourceBefore = sourceSeal(options.sourceRoot);
        const conditionRunnerBefore = fileSha256(SCRIPT_PATH);
        const conditionStartedAt = performance.now();
        const { records, workerSeals } = await runWorkers(options.sourceRoot, concurrency, rawPath);
        records.sort((left, right) =>
            left.cohort === right.cohort
                ? left.pair - right.pair
                : COHORTS.indexOf(left.cohort) - COHORTS.indexOf(right.cohort),
        );
        writeFileSync(rawPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
        const conditionSourceAfter = sourceSeal(options.sourceRoot);
        const conditionRunnerAfter = fileSha256(SCRIPT_PATH);
        const sourceUnchanged = conditionSourceBefore.sourceSha256 === conditionSourceAfter.sourceSha256;
        const runnerUnchanged = conditionRunnerBefore === conditionRunnerAfter;
        const quality = validateCondition(
            records,
            sourceUnchanged,
            runnerUnchanged,
            workerSeals,
            concurrency,
            environment,
        );
        const summary = {
            schema: SCHEMA,
            concurrency,
            elapsedMs: performance.now() - conditionStartedAt,
            workload: {
                seed: BASE_SEED,
                pairsPerCohort: PAIRS_PER_COHORT,
                repeatsPerArmSide: REPEATS,
                maxLaps: MAX_LAPS,
            },
            sourceBefore: conditionSourceBefore,
            sourceAfter: conditionSourceAfter,
            workerSeals,
            quality,
            ...conditionSummary(records, quality),
        };
        writeFileSync(join(directory, SUMMARY_FILE), `${JSON.stringify(summary, null, 2)}\n`);
        conditions.push(summary);
    }
    const sourceAfter = sourceSeal(options.sourceRoot);
    const invocationIntegrity = {
        sourceUnchanged: sourceBefore.sourceSha256 === sourceAfter.sourceSha256,
        runnerUnchanged: sourceBefore.runnerSha256 === sourceAfter.runnerSha256,
    };
    const allGatesPassed =
        invocationIntegrity.sourceUnchanged &&
        invocationIntegrity.runnerUnchanged &&
        conditions.every((condition) =>
            Object.values(condition.gates as Record<string, { passed: boolean }>).every((gate) => gate.passed),
        );
    const summary = {
        schema: SCHEMA,
        complete: true,
        verdict: allGatesPassed ? "latency_circuit_qualified" : "latency_circuit_rejected",
        generatedAt: new Date().toISOString(),
        elapsedMs: performance.now() - startedAt,
        options,
        protocol: {
            purpose: "exact-source S3/S2 latency and ranked/common circuit safety",
            s3: "untouched automatic production v0.8+a13 factory",
            s2: "canonical production a13 environment with only SEARCH_SHORTLIST=2",
            anchor: ANCHOR_VERSION,
            decisionDeadlineMs: DECISION_DEADLINE_MS,
            commonCircuitMs: COMMON_CIRCUIT_MS,
            rankedOuterCircuitProjectionMs: RANKED_OUTER_CIRCUIT_MS,
            percentileMethod: "nearest rank: sorted[max(0, ceil(p*n)-1)]",
            digestPolicy:
                "same-arm exact repeats must match when both are free of deadline/circuit paths; cross-arm equality is diagnostic",
        },
        provenance: {
            sourceBefore,
            sourceAfter,
            environment,
            invocationIntegrity,
            runtime: {
                bun: Bun.version,
                platform: platform(),
                arch: arch(),
                release: release(),
                cpu: cpus()[0]?.model ?? "unknown",
                logicalCpus: cpus().length,
                availableParallelism: availableParallelism(),
                memory: totalmem(),
            },
        },
        conditions,
    };
    writeFileSync(join(options.output, SUMMARY_FILE), `${JSON.stringify(summary, null, 2)}\n`);
    return summary;
}

function usage(): string {
    return [
        "Usage:",
        `  bun ${relative(process.cwd(), SCRIPT_PATH)} --self-test [--source-root ${DEFAULT_SOURCE_ROOT}]`,
        `  bun ${relative(process.cwd(), SCRIPT_PATH)} --preflight [--source-root ${DEFAULT_SOURCE_ROOT}]`,
        `  bun ${relative(process.cwd(), SCRIPT_PATH)} --source-root ROOT --expected-source-sha256 SHA --output NEW_DIR [--concurrency 1,6]`,
    ].join("\n");
}

if (parentPort) {
    void workerMain(parentPort).catch((error) => {
        parentPort!.postMessage({
            type: "error",
            error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        } satisfies WorkerResponse);
    });
} else if (import.meta.main) {
    const args = process.argv.slice(2);
    const operation = args.includes("--self-test") ? "self-test" : args.includes("--preflight") ? "preflight" : "run";
    const utilityArgs = args.filter((argument) => argument !== "--self-test" && argument !== "--preflight");
    const promise =
        operation === "self-test"
            ? selfTest(utilitySourceRoot(utilityArgs))
            : operation === "preflight"
              ? preflight(utilitySourceRoot(utilityArgs))
              : run(parseOptions(args)).then((summary) => {
                    console.log(
                        JSON.stringify(
                            {
                                verdict: summary.verdict,
                                elapsedMs: summary.elapsedMs,
                                output: (summary.options as IOptions).output,
                            },
                            null,
                            2,
                        ),
                    );
                });
    void promise.catch((error) => {
        console.error(error instanceof Error ? (error.stack ?? error.message) : error);
        console.error(usage());
        process.exitCode = 1;
    });
}

export {
    SCHEMA as V08_S3_VS_S2_LATENCY_CIRCUIT_SCHEMA,
    parseOptions as parseV08S3VsS2LatencyOptions,
    quantiles as summarizeV08S3VsS2LatencyQuantiles,
};
