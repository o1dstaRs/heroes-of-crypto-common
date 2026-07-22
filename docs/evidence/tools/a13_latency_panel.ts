#!/usr/bin/env bun

/*
 * Reproducible Workstream-1 latency/tail panel for the a13 ranged-ray optimization.
 *
 * This is evidence tooling, not production code. It deliberately loads each source variant from an
 * explicit root and instruments the live v0.8 strategy/SearchDriver at runtime. Input trees remain
 * byte-for-byte untouched, which keeps the source hashes used by the differential evidence meaningful.
 */

import { createHash } from "node:crypto";
import {
    appendFileSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { cpus, freemem, loadavg, platform, release, totalmem } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

const SCHEMA = "hoc.a13-ray-latency-panel.v1" as const;
const BASE_SEED = 85_000_717;
const MAX_LAPS = 60;
const PAIRS_PER_COHORT = 30;
const PHYSICAL_SIDE_SWAPS = 2;
const MATCHES_PER_COHORT = PAIRS_PER_COHORT * PHYSICAL_SIDE_SWAPS;
const BOOTSTRAP_REPLICATES = 10_000;
const BOOTSTRAP_SEED = 0xa13dd001;
const EXPECTED_DECISION_DEADLINE_MS = 175;
const EXPECTED_CIRCUIT_BREAKER_MS = 275;
const EXPECTED_VERSION = "v0.8";
const GIB = 1024 ** 3;
const EXPECTED_CANDIDATE_ATTACK_HANDLER_SHA256 = "d4f0342487cc6cc8497d997e09a8a65c57f1fcebb02f945117a710cab42c5233";
const EXPECTED_CANDIDATE_RAY_TRAVERSAL_SHA256 = "18d4f31971e593d1222bf24f71484dc5ba8a3cb52451eb2ed0d1498a53f97eba";
const EXPECTED_BASELINE_SRC_TREE_MANIFEST_SHA256 = "34a1149ae1717e05255c77c630004cb6bdb11bcfa2a701a8acfc500a9bc098eb";
const EXPECTED_CANDIDATE_SRC_TREE_MANIFEST_SHA256 = "a24700ba7694697346e440faf97b0531c330f5b1ff2aaabe611b47eb19c580de";
const PROFILE_SEEDS = [1, 42, 43, 44, 45, 46] as const;
const PROFILE_WARMUP_SEED = 9001;
const PROFILE_MAX_LAPS = 4;
const PROFILE_ACTIONS_PER_REPEAT = 361;
const PROFILE_DIGEST_PER_REPEAT = "5362e41ce4d18381bc680b71da30618148bd01b92cc93fe826d0bae926dcdfbe";
const RUNNER_PATH = fileURLToPath(import.meta.url);

const COHORTS = [
    "ranked-draft",
    "uniform-mixed",
    "ranged-heavy",
    "ground-melee",
    "flyer-heavy",
    "caster-support",
    "cross-archetype",
] as const;

const LIVE_MAPS = [
    { id: 1, name: "NORMAL" },
    { id: 3, name: "LAVA_CENTER" },
    { id: 4, name: "BLOCK_CENTER" },
] as const;

type Cohort = (typeof COHORTS)[number];
type Variant = "baseline" | "candidate";
type SideSwap = "a-green" | "b-green";

interface IProtocol {
    schema: typeof SCHEMA;
    purpose: string;
    baseSeed: number;
    cohorts: readonly Cohort[];
    maps: typeof LIVE_MAPS;
    pairIdentitiesPerCohort: number;
    pairIdentitiesPerCohortMap: number;
    physicalSideSwapsPerPair: number;
    matchesPerVariant: number;
    matchedBaselineCandidateObservations: number;
    totalExecutionsPerConcurrencyCondition: number;
    maxLaps: number;
    aiVersion: string;
    searchProfile: { decisionDeadlineMs: number; circuitBreakerMs: number };
    concurrencyConditions: readonly number[];
    schedule: string;
    workerAssignment: string;
    workerTopology: string;
    activeWallDefinition: string;
    warmup: {
        matchesPerWorker: number;
        minimumDecisionsPerWorker: number;
        cohort: Cohort;
        pair: number;
        sideSwap: SideSwap;
        maxLaps: number;
        measured: false;
    };
    percentiles: { method: string; probabilities: readonly number[]; searchSample: string };
    bootstrap: {
        method: string;
        cluster: string;
        strata: string;
        replicates: number;
        seedHex: string;
        statistic: string;
        interval: string;
    };
    gates: {
        host: {
            requirements: readonly string[];
            invalidation: string;
            runnerQualification: string;
        };
        correctness: readonly string[];
        serialAttribution: readonly string[];
        saturation: readonly string[];
        boundedDigestPolicy: string;
    };
    cpuProfile: {
        seeds: readonly number[];
        warmupSeed: number;
        maxLaps: number;
        repeats: number;
        actionsPerRepeat: number;
        digestPerRepeat: string;
        measuredMatchesPerVariant: number;
        capturesPerVariant: number;
        concurrency: 1;
        profilerIntervalMicroseconds: number;
    };
}

const PROTOCOL: Readonly<IProtocol> = Object.freeze({
    schema: SCHEMA,
    purpose: "Workstream-1 exact-raster traversal latency and tail qualification",
    baseSeed: BASE_SEED,
    cohorts: COHORTS,
    maps: LIVE_MAPS,
    pairIdentitiesPerCohort: PAIRS_PER_COHORT,
    pairIdentitiesPerCohortMap: 10,
    physicalSideSwapsPerPair: PHYSICAL_SIDE_SWAPS,
    matchesPerVariant: COHORTS.length * MATCHES_PER_COHORT,
    matchedBaselineCandidateObservations: COHORTS.length * MATCHES_PER_COHORT,
    totalExecutionsPerConcurrencyCondition: COHORTS.length * MATCHES_PER_COHORT * 2,
    maxLaps: MAX_LAPS,
    aiVersion: EXPECTED_VERSION,
    searchProfile: {
        decisionDeadlineMs: EXPECTED_DECISION_DEADLINE_MS,
        circuitBreakerMs: EXPECTED_CIRCUIT_BREAKER_MS,
    },
    concurrencyConditions: [1, 4, 12],
    schedule:
        "21 stable cohort/map blocks; every block contains 10 pair identities x 2 side swaps. Even blocks run baseline then candidate (AB), odd blocks candidate then baseline (BA). This is alternating AB/BA block order for gross order balance, not within-block ABBA replication.",
    workerAssignment:
        "Within every variant/block phase, stable task order is round-robin sharded by task ordinal across persistent, identically warmed workers.",
    workerTopology:
        "Two persistent variant-isolated pools are resident per condition. Each has concurrency workers, so c12 creates and warms 24 workers total while only one 12-worker variant pool is active in a block phase.",
    activeWallDefinition:
        "Per-variant sum of runBlock wall durations after warmup; includes parent scheduling, worker execution, result structured-clone serialization, worker-to-parent IPC, and Promise aggregation, and excludes opposite-arm idle time and worker warmup.",
    warmup: {
        matchesPerWorker: 1,
        minimumDecisionsPerWorker: 20,
        cohort: "ranged-heavy",
        pair: 0,
        sideSwap: "a-green",
        maxLaps: 2,
        measured: false,
    },
    percentiles: {
        method: "nearest-rank: sorted[max(0, ceil(p*n)-1)]",
        probabilities: [0.5, 0.95, 0.99, 0.999, 1],
        searchSample:
            "searched decisions only (searched counter delta > 0); circuit-skipped decisions are excluded rather than inserted as zero-time search samples",
    },
    bootstrap: {
        method: "paired stratified nonparametric pair-cluster bootstrap",
        cluster: "one roster/map pair identity containing both physical side swaps and both code variants",
        strata: "the 21 exact cohort x map cells; sample 10 clusters with replacement inside every stratum",
        replicates: BOOTSTRAP_REPLICATES,
        seedHex: `0x${BOOTSTRAP_SEED.toString(16)}`,
        statistic:
            "100 * (1 - sum(candidate duration) / sum(baseline duration)); totals retain every decision in each sampled cluster",
        interval: "nearest-rank percentile interval [2.5%, 97.5%] with median also reported",
    },
    gates: {
        host: {
            requirements: [
                "AC power throughout",
                "nominal thermal state throughout",
                "normal memory pressure throughout",
                "no overlapping build, simulation, or profile process",
                "external process <=100% peak of one core and <=20% for fewer than five consecutive 1-second samples",
            ],
            invalidation: "invalidate and rerun the complete block; never selectively discard observed samples",
            runnerQualification:
                "hard false unless a separate continuous host attestation satisfying every requirement is joined to the result",
        },
        correctness: [
            "candidate engine-rejected strategy-action count is zero",
            "candidate-only exceptions, rejected actions, deadline fallbacks, circuit opens, and per-task illegal-incumbent increases are all zero",
            "accepted actions and SearchDriver logical-work counters match task-by-task unless the same task has an explicitly counted bounded fallback/circuit divergence",
            "frozen baseline/candidate full-source identities and current runner bytes are unchanged before/after each concurrency condition and across the full panel invocation",
        ],
        serialAttribution: [
            "c1 total-decision bootstrap 95% lower bound is > 0% reduction",
            "c1 search bootstrap 95% lower bound is > 0% reduction",
            "upper 95% pair-cluster bootstrap bounds for candidate/baseline all-decision p95 and p99 ratios are <= 1.05",
        ],
        saturation: [
            "upper 95% pair-cluster bootstrap bounds for candidate/baseline all-decision p95 and p99 ratios are <= 1.05",
            "candidate active-phase wall time is <= 1.05 x baseline active-phase wall time at c4 and c12",
        ],
        boundedDigestPolicy:
            "Digests are always compared and reported, but are diagnostic rather than a bounded-profile gate: crossing the fixed 175ms deadline can intentionally choose a different fallback. Exact semantic equivalence belongs to the separate unbounded event/state differential gate.",
    },
    cpuProfile: {
        seeds: PROFILE_SEEDS,
        warmupSeed: PROFILE_WARMUP_SEED,
        maxLaps: PROFILE_MAX_LAPS,
        repeats: 9,
        actionsPerRepeat: PROFILE_ACTIONS_PER_REPEAT,
        digestPerRepeat: PROFILE_DIGEST_PER_REPEAT,
        measuredMatchesPerVariant: PROFILE_SEEDS.length * 9,
        capturesPerVariant: 3,
        concurrency: 1,
        profilerIntervalMicroseconds: 500,
    },
} as const);

interface IPreparedPair {
    schemaVersion: number;
    cohort: Cohort;
    pair: number;
    setupSeed: number;
    combatSeed: number;
    map: number;
    armyA: IPreparedArmy;
    armyB: IPreparedArmy;
}

interface IPreparedArmy {
    roster: unknown[];
    perk: number;
    augment: { augments: unknown[] };
    artifactT1: { id: number };
    artifactT2: { id: number };
    synergies: unknown[];
    [key: string]: unknown;
}

interface IPlanCluster {
    clusterId: string;
    stratum: string;
    blockIndex: number;
    cohort: Cohort;
    pair: number;
    map: number;
    mapName: string;
    setupSeed: number;
    combatSeed: number;
    preparedSha256: string;
    prepared: IPreparedPair;
}

interface IPanelTask {
    taskId: string;
    clusterId: string;
    stratum: string;
    blockIndex: number;
    cohort: Cohort;
    pair: number;
    map: number;
    mapName: string;
    sideSwap: SideSwap;
    aIsGreen: boolean;
    setupSeed: number;
    combatSeed: number;
    preparedSha256: string;
    maxLaps: number;
}

interface IFrozenPlan {
    schema: typeof SCHEMA;
    protocolSha256: string;
    planSha256?: string;
    clusters: IPlanCluster[];
    tasks: IPanelTask[];
}

interface IDecisionTiming {
    taskId: string;
    variant: Variant;
    workerIndex: number;
    decisionOrdinal: number;
    unitId: string;
    creatureName: string;
    side: "green" | "red";
    lap: number;
    policyMs: number;
    searchMs: number;
    totalDecisionMs: number;
    arbitrationOverheadMs: number;
    searchInvoked: boolean;
    deadlineFallbacks: number;
    circuitSkipped: number;
    circuitOpenBefore: boolean;
    circuitOpenAfter: boolean;
    searchDecisions: number;
    searched: number;
    candidatesTotal: number;
    scoredCandidatesTotal: number;
    rolloutTurnsTotal: number;
    illegalIncumbent: number;
    overrides: number;
    singleCandidate: number;
    searchMsPer1000RolloutTurns: number | null;
    rawActionTypes: string[];
    chosenActionTypes: string[];
    strategyActionTypes: string[];
    strategyCompleted: boolean[];
    strategyRejectionReasons: Array<string | null>;
    recoverySources: string[];
    recoveryCompleted: boolean;
    recoverySource: string;
    eventTypes: string[];
}

interface IMatchRecord {
    schema: typeof SCHEMA;
    task: IPanelTask;
    variant: Variant;
    workerIndex: number;
    preparedSha256: string;
    matchWallMs: number;
    winner: string;
    winnerForA: "a" | "b" | "draw";
    endReason: string;
    laps: number;
    totalActions: number;
    rejectedGreen: number;
    rejectedRed: number;
    engineRejectedActions: number;
    recordedIncompleteActions: number;
    decisionCount: number;
    deadlineFallbacks: number;
    circuitSkipped: number;
    circuitOpenedDecisions: number;
    recoveryAttempts: number;
    searchDecisions: number;
    searched: number;
    candidatesTotal: number;
    scoredCandidatesTotal: number;
    rolloutTurnsTotal: number;
    illegalIncumbent: number;
    overrides: number;
    singleCandidate: number;
    searchMsPer1000RolloutTurns: number | null;
    policyMs: number;
    searchMs: number;
    totalDecisionMs: number;
    resultDigest: string;
    actionDigest: string;
    outcomeDigest: string;
    placementsDigest: string;
    decisions: IDecisionTiming[];
}

interface IWorkerInit {
    kind: "panel-worker";
    root: string;
    variant: Variant;
    workerIndex: number;
    outputDir: string;
    skipWarmup: boolean;
}

interface IWorkerWarmup {
    wallMs: number;
    decisions: number;
    actions: number;
    digest: string;
}

interface IWorkerRequest {
    type: "batch" | "stop";
    requestId?: number;
    condition?: number;
    tasks?: IPanelTask[];
}

interface IWorkerResponse {
    type: "ready" | "batch-result" | "error";
    requestId?: number;
    warmup?: IWorkerWarmup | null;
    records?: IMatchRecord[];
    error?: string;
}

interface ISourceSeal {
    root: string;
    realRoot: string;
    srcFileCount: number;
    srcBytes: number;
    srcTreeManifestSha256: string;
    packageJsonSha256: string | null;
    dependencyRoot: string | null;
    selectedFiles: Record<string, string | null>;
}

interface IPendingDecision {
    taskId: string;
    variant: Variant;
    workerIndex: number;
    decisionOrdinal: number;
    unitId: string;
    creatureName: string;
    side: "green" | "red";
    lap: number;
    startMs: number;
    policyMs: number;
    searchMs: number;
    totalDecisionMs: number;
    searchInvoked: boolean;
    deadlineFallbacks: number;
    circuitSkipped: number;
    circuitOpenBefore: boolean;
    circuitOpenAfter: boolean;
    searchDecisions: number;
    searched: number;
    candidatesTotal: number;
    scoredCandidatesTotal: number;
    rolloutTurnsTotal: number;
    illegalIncumbent: number;
    overrides: number;
    singleCandidate: number;
}

interface IActiveTracking {
    taskId: string;
    variant: Variant;
    workerIndex: number;
    nextDecisionOrdinal: number;
    pending: IPendingDecision | null;
    ready: IPendingDecision[];
    decisions: IDecisionTiming[];
}

const sha256 = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function canonicalize(value: unknown): unknown {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
        if (Number.isNaN(value)) return "__NaN__";
        if (value === Number.POSITIVE_INFINITY) return "__Infinity__";
        if (value === Number.NEGATIVE_INFINITY) return "__-Infinity__";
        if (Object.is(value, -0)) return 0;
        return value;
    }
    if (typeof value === "bigint") return `${value}n`;
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value instanceof Map) {
        return [...value.entries()]
            .map(([key, item]) => [canonicalize(key), canonicalize(item)])
            .sort((a, b) => JSON.stringify(a[0]).localeCompare(JSON.stringify(b[0])));
    }
    if (value instanceof Set) {
        return [...value.values()].map(canonicalize).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
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

function writeJson(path: string, value: unknown): void {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function ensureFreshDirectory(path: string): void {
    if (existsSync(path)) {
        if (!statSync(path).isDirectory()) throw new Error(`Output path is not a directory: ${path}`);
        if (readdirSync(path).length > 0) throw new Error(`Refusing non-empty output directory: ${path}`);
    } else {
        mkdirSync(path, { recursive: true });
    }
}

function requireRoot(path: string): string {
    const root = resolve(path);
    for (const required of [
        "src/simulation/ai_meta_cohorts_core.ts",
        "src/simulation/battle_engine.ts",
        "src/simulation/search_driver.ts",
        "src/ai/versions/v0_8_a13_profile.ts",
    ]) {
        const candidate = join(root, required);
        if (!existsSync(candidate) || !statSync(candidate).isFile()) {
            throw new Error(`Variant root is missing ${required}: ${root}`);
        }
    }
    return root;
}

async function importFrom<T = Record<string, unknown>>(root: string, relativePath: string): Promise<T> {
    return (await import(pathToFileURL(join(root, relativePath)).href)) as T;
}

function sourceSeal(rootInput: string): ISourceSeal {
    const root = requireRoot(rootInput);
    const realRoot = realpathSync(root);
    const src = join(root, "src");
    const entries: Array<{ path: string; bytes: number; sha256: string }> = [];
    const visit = (directory: string): void => {
        for (const name of readdirSync(directory).sort()) {
            const path = join(directory, name);
            const stat = lstatSync(path);
            if (stat.isDirectory()) visit(path);
            else if (stat.isFile()) {
                const bytes = readFileSync(path);
                entries.push({ path: relative(src, path), bytes: bytes.byteLength, sha256: sha256(bytes) });
            }
        }
    };
    visit(src);
    const fileHash = (path: string): string | null => (existsSync(path) ? sha256(readFileSync(path)) : null);
    let dependencyRoot: string | null = null;
    const nodeModules = join(root, "node_modules");
    if (existsSync(nodeModules)) {
        try {
            dependencyRoot = realpathSync(nodeModules);
        } catch {
            dependencyRoot = null;
        }
    }
    const selected = [
        "src/handlers/attack_handler.ts",
        "src/grid/ray_traversal.ts",
        "src/simulation/battle_engine.ts",
        "src/simulation/search_driver.ts",
        "src/simulation/ai_meta_cohorts_core.ts",
        "src/ai/versions/v0_8_a13_profile.ts",
    ];
    return {
        root,
        realRoot,
        srcFileCount: entries.length,
        srcBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
        srcTreeManifestSha256: digest(entries),
        packageJsonSha256: fileHash(join(root, "package.json")),
        dependencyRoot,
        selectedFiles: Object.fromEntries(selected.map((path) => [path, fileHash(join(root, path))])),
    };
}

function runnerSeal(): { path: string; bytes: number; sha256: string } {
    const bytes = readFileSync(RUNNER_PATH);
    return { path: RUNNER_PATH, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

function sourceSealIdentity(seal: ISourceSeal): Record<string, unknown> {
    return {
        realRoot: seal.realRoot,
        srcFileCount: seal.srcFileCount,
        srcBytes: seal.srcBytes,
        srcTreeManifestSha256: seal.srcTreeManifestSha256,
        packageJsonSha256: seal.packageJsonSha256,
        dependencyRoot: seal.dependencyRoot,
        selectedFiles: seal.selectedFiles,
    };
}

function expectedSourceTreeManifest(variant: Variant): string {
    return variant === "baseline"
        ? EXPECTED_BASELINE_SRC_TREE_MANIFEST_SHA256
        : EXPECTED_CANDIDATE_SRC_TREE_MANIFEST_SHA256;
}

function assertVariantSourceSeal(seal: ISourceSeal, variant: Variant, context: string): void {
    const expected = expectedSourceTreeManifest(variant);
    if (seal.srcTreeManifestSha256 !== expected) {
        throw new Error(
            `${context}: ${variant} source identity mismatch; expected src tree ${expected}, got ${seal.srcTreeManifestSha256}`,
        );
    }
    if (
        variant === "candidate" &&
        (seal.selectedFiles["src/handlers/attack_handler.ts"] !== EXPECTED_CANDIDATE_ATTACK_HANDLER_SHA256 ||
            seal.selectedFiles["src/grid/ray_traversal.ts"] !== EXPECTED_CANDIDATE_RAY_TRAVERSAL_SHA256)
    ) {
        throw new Error(`${context}: candidate label does not contain the frozen two-file runtime overlay`);
    }
    if (variant === "baseline" && seal.selectedFiles["src/grid/ray_traversal.ts"] !== null) {
        throw new Error(`${context}: baseline label unexpectedly contains ray_traversal.ts`);
    }
}

function integrityComparison(options: {
    baselineBefore: ISourceSeal;
    baselineAfter: ISourceSeal;
    candidateBefore: ISourceSeal;
    candidateAfter: ISourceSeal;
    runnerBefore: ReturnType<typeof runnerSeal>;
    runnerAfter: ReturnType<typeof runnerSeal>;
}): Record<string, unknown> {
    const baselineUnchanged =
        digest(sourceSealIdentity(options.baselineBefore)) === digest(sourceSealIdentity(options.baselineAfter));
    const candidateUnchanged =
        digest(sourceSealIdentity(options.candidateBefore)) === digest(sourceSealIdentity(options.candidateAfter));
    const runnerUnchanged = options.runnerBefore.sha256 === options.runnerAfter.sha256;
    return {
        baselineUnchanged,
        candidateUnchanged,
        runnerUnchanged,
        exact: baselineUnchanged && candidateUnchanged && runnerUnchanged,
        baselineBefore: sourceSealIdentity(options.baselineBefore),
        baselineAfter: sourceSealIdentity(options.baselineAfter),
        candidateBefore: sourceSealIdentity(options.candidateBefore),
        candidateAfter: sourceSealIdentity(options.candidateAfter),
        runnerBefore: options.runnerBefore,
        runnerAfter: options.runnerAfter,
        dependencySeal: {
            sealed: false,
            limitation:
                "node_modules is identified only by its resolved path; installed dependency and dependency-lock contents are not hashed and remain outside this before/after source invariant",
        },
    };
}

function sourceHashes(rootInput: string): Map<string, string> {
    const root = requireRoot(rootInput);
    const src = join(root, "src");
    const hashes = new Map<string, string>();
    const visit = (directory: string): void => {
        for (const name of readdirSync(directory).sort()) {
            const path = join(directory, name);
            const stat = lstatSync(path);
            if (stat.isDirectory()) visit(path);
            else if (stat.isFile()) hashes.set(relative(root, path), sha256(readFileSync(path)));
        }
    };
    visit(src);
    return hashes;
}

function sourceIsolation(baselineRoot: string, candidateRoot: string): Record<string, unknown> {
    const baseline = sourceHashes(baselineRoot);
    const candidate = sourceHashes(candidateRoot);
    const paths = [...new Set([...baseline.keys(), ...candidate.keys()])].sort();
    const differences = paths
        .filter((path) => baseline.get(path) !== candidate.get(path))
        .map((path) => ({
            path,
            baselineSha256: baseline.get(path) ?? null,
            candidateSha256: candidate.get(path) ?? null,
            change:
                !baseline.has(path) && candidate.has(path)
                    ? "added"
                    : baseline.has(path) && !candidate.has(path)
                      ? "deleted"
                      : "modified",
        }));
    const expected = [
        {
            path: "src/grid/ray_traversal.ts",
            change: "added",
            candidateSha256: EXPECTED_CANDIDATE_RAY_TRAVERSAL_SHA256,
        },
        {
            path: "src/handlers/attack_handler.ts",
            change: "modified",
            candidateSha256: EXPECTED_CANDIDATE_ATTACK_HANDLER_SHA256,
        },
    ];
    const exact =
        differences.length === expected.length &&
        expected.every((wanted) =>
            differences.some(
                (actual) =>
                    actual.path === wanted.path &&
                    actual.change === wanted.change &&
                    actual.candidateSha256 === wanted.candidateSha256,
            ),
        );
    return {
        exactExpectedTwoFileOverlay: exact,
        expected,
        differences,
        policy: "baseline and candidate src trees must differ only by modified attack_handler.ts plus candidate-added ray_traversal.ts, with both candidate hashes frozen",
    };
}

function scrubExperimentEnvironment(): void {
    for (const key of Object.keys(process.env)) {
        if (/^(SEARCH_|V0[5-8]_|Q2_|SIM_|FIGHT_MELEE_ROSTERS$|LIVETWIN$)/.test(key)) delete process.env[key];
    }
    process.env.V08_A13_SEARCH = "1";
    // battle_engine treats any present SIM_NO_ACTIONS value (including "0") as enabled.
    delete process.env.SIM_NO_ACTIONS;
    process.env.LIVETWIN = "1";
    process.env.FIGHT_MELEE_ROSTERS = "0";
}

function actionTypes(actions: readonly unknown[]): string[] {
    return actions.map((action) => String((action as { type?: unknown }).type ?? "unknown"));
}

function eventTypes(events: readonly unknown[]): string[] {
    return events.map((event) => String((event as { type?: unknown }).type ?? "unknown"));
}

function searchCounters(driver: unknown): {
    deadlineFallbacks: number;
    circuitSkipped: number;
    circuitOpen: boolean;
    decisions: number;
    searched: number;
    candidatesTotal: number;
    scoredCandidatesTotal: number;
    rolloutTurnsTotal: number;
    illegalIncumbent: number;
    overrides: number;
    singleCandidate: number;
} {
    const value = driver as {
        counters?: {
            deadlineFallbacks?: number;
            circuitSkipped?: number;
            decisions?: number;
            searched?: number;
            candidatesTotal?: number;
            scoredCandidatesTotal?: number;
            rolloutTurnsTotal?: number;
            illegalIncumbent?: number;
            overrides?: number;
            singleCandidate?: number;
        };
        circuitOpen?: boolean;
    };
    return {
        deadlineFallbacks: Number(value.counters?.deadlineFallbacks ?? 0),
        circuitSkipped: Number(value.counters?.circuitSkipped ?? 0),
        circuitOpen: value.circuitOpen === true,
        decisions: Number(value.counters?.decisions ?? 0),
        searched: Number(value.counters?.searched ?? 0),
        candidatesTotal: Number(value.counters?.candidatesTotal ?? 0),
        scoredCandidatesTotal: Number(value.counters?.scoredCandidatesTotal ?? 0),
        rolloutTurnsTotal: Number(value.counters?.rolloutTurnsTotal ?? 0),
        illegalIncumbent: Number(value.counters?.illegalIncumbent ?? 0),
        overrides: Number(value.counters?.overrides ?? 0),
        singleCandidate: Number(value.counters?.singleCandidate ?? 0),
    };
}

function installDecisionInstrumentation(
    SearchDriver: {
        prototype: {
            chooseDecision: (unit: unknown, version: string, incumbent: readonly unknown[]) => unknown[];
        };
    },
    strategy: {
        decideTurn: (unit: unknown, context: unknown) => unknown[];
    },
    lowerTeam: number,
): {
    beginMatch: (taskId: string, variant: Variant, workerIndex: number) => void;
    observeExecution: (observation: unknown) => void;
    endMatch: () => IDecisionTiming[];
} {
    let active: IActiveTracking | null = null;
    let searchDepth = 0;
    const originalDecideTurn = strategy.decideTurn;
    const originalChooseDecision = SearchDriver.prototype.chooseDecision;

    strategy.decideTurn = function instrumentedDecideTurn(unitValue: unknown, contextValue: unknown): unknown[] {
        if (!active || searchDepth > 0) return originalDecideTurn.call(this, unitValue, contextValue);
        if (active.pending) throw new Error(`Live decision overlap before ${active.pending.unitId} was finalized`);
        const unit = unitValue as {
            getId: () => string;
            getName: () => string;
            getTeam: () => number;
        };
        const context = contextValue as { fightProperties?: { getCurrentLap: () => number } };
        const started = performance.now();
        try {
            return originalDecideTurn.call(this, unitValue, contextValue);
        } finally {
            const ended = performance.now();
            active.pending = {
                taskId: active.taskId,
                variant: active.variant,
                workerIndex: active.workerIndex,
                decisionOrdinal: active.nextDecisionOrdinal++,
                unitId: unit.getId(),
                creatureName: unit.getName(),
                side: unit.getTeam() === lowerTeam ? "green" : "red",
                lap: Number(context.fightProperties?.getCurrentLap() ?? -1),
                startMs: started,
                policyMs: ended - started,
                searchMs: 0,
                totalDecisionMs: ended - started,
                searchInvoked: false,
                deadlineFallbacks: 0,
                circuitSkipped: 0,
                circuitOpenBefore: false,
                circuitOpenAfter: false,
                searchDecisions: 0,
                searched: 0,
                candidatesTotal: 0,
                scoredCandidatesTotal: 0,
                rolloutTurnsTotal: 0,
                illegalIncumbent: 0,
                overrides: 0,
                singleCandidate: 0,
            };
        }
    };

    SearchDriver.prototype.chooseDecision = function instrumentedChooseDecision(
        unitValue: unknown,
        version: string,
        incumbent: readonly unknown[],
    ): unknown[] {
        const tracked = active?.pending ?? null;
        const before = searchCounters(this);
        const started = performance.now();
        searchDepth += 1;
        try {
            return originalChooseDecision.call(this, unitValue, version, incumbent);
        } finally {
            searchDepth -= 1;
            const ended = performance.now();
            const after = searchCounters(this);
            if (tracked && active?.pending === tracked) {
                tracked.searchInvoked = true;
                tracked.searchMs = ended - started;
                tracked.totalDecisionMs = ended - tracked.startMs;
                tracked.deadlineFallbacks = after.deadlineFallbacks - before.deadlineFallbacks;
                tracked.circuitSkipped = after.circuitSkipped - before.circuitSkipped;
                tracked.circuitOpenBefore = before.circuitOpen;
                tracked.circuitOpenAfter = after.circuitOpen;
                tracked.searchDecisions = after.decisions - before.decisions;
                tracked.searched = after.searched - before.searched;
                tracked.candidatesTotal = after.candidatesTotal - before.candidatesTotal;
                tracked.scoredCandidatesTotal = after.scoredCandidatesTotal - before.scoredCandidatesTotal;
                tracked.rolloutTurnsTotal = after.rolloutTurnsTotal - before.rolloutTurnsTotal;
                tracked.illegalIncumbent = after.illegalIncumbent - before.illegalIncumbent;
                tracked.overrides = after.overrides - before.overrides;
                tracked.singleCandidate = after.singleCandidate - before.singleCandidate;
                active.ready.push(tracked);
                active.pending = null;
            }
        }
    };

    return {
        beginMatch(taskId, variant, workerIndex): void {
            if (active) throw new Error(`Decision instrumentation still active for ${active.taskId}`);
            active = {
                taskId,
                variant,
                workerIndex,
                nextDecisionOrdinal: 0,
                pending: null,
                ready: [],
                decisions: [],
            };
        },
        observeExecution(observationValue): void {
            if (!active) throw new Error("Turn execution arrived without an active match");
            if (active.pending) {
                const ended = performance.now();
                active.pending.totalDecisionMs = ended - active.pending.startMs;
                active.ready.push(active.pending);
                active.pending = null;
            }
            const observation = observationValue as {
                unitId: string;
                rawIncumbent: readonly unknown[];
                chosenDecision: readonly unknown[];
                strategyActions: ReadonlyArray<{
                    action: unknown;
                    completed: boolean;
                    rejectionReason?: string;
                }>;
                recoveryAttempts: ReadonlyArray<{ source: string }>;
                recovery: { source: string; completed: boolean };
                events: readonly unknown[];
            };
            const pending = active.ready.shift();
            if (!pending) throw new Error(`Missing timing record for execution of ${observation.unitId}`);
            if (pending.unitId !== observation.unitId) {
                throw new Error(`Decision/execution mismatch: timed ${pending.unitId}, executed ${observation.unitId}`);
            }
            active.decisions.push({
                taskId: pending.taskId,
                variant: pending.variant,
                workerIndex: pending.workerIndex,
                decisionOrdinal: pending.decisionOrdinal,
                unitId: pending.unitId,
                creatureName: pending.creatureName,
                side: pending.side,
                lap: pending.lap,
                policyMs: pending.policyMs,
                searchMs: pending.searchMs,
                totalDecisionMs: pending.totalDecisionMs,
                arbitrationOverheadMs: pending.totalDecisionMs - pending.policyMs - pending.searchMs,
                searchInvoked: pending.searchInvoked,
                deadlineFallbacks: pending.deadlineFallbacks,
                circuitSkipped: pending.circuitSkipped,
                circuitOpenBefore: pending.circuitOpenBefore,
                circuitOpenAfter: pending.circuitOpenAfter,
                searchDecisions: pending.searchDecisions,
                searched: pending.searched,
                candidatesTotal: pending.candidatesTotal,
                scoredCandidatesTotal: pending.scoredCandidatesTotal,
                rolloutTurnsTotal: pending.rolloutTurnsTotal,
                illegalIncumbent: pending.illegalIncumbent,
                overrides: pending.overrides,
                singleCandidate: pending.singleCandidate,
                searchMsPer1000RolloutTurns:
                    pending.rolloutTurnsTotal > 0 ? (1000 * pending.searchMs) / pending.rolloutTurnsTotal : null,
                rawActionTypes: actionTypes(observation.rawIncumbent),
                chosenActionTypes: actionTypes(observation.chosenDecision),
                strategyActionTypes: observation.strategyActions.map((entry) =>
                    String((entry.action as { type?: unknown }).type ?? "unknown"),
                ),
                strategyCompleted: observation.strategyActions.map((entry) => entry.completed),
                strategyRejectionReasons: observation.strategyActions.map((entry) => entry.rejectionReason ?? null),
                recoverySources: observation.recoveryAttempts.map((entry) => entry.source),
                recoveryCompleted: observation.recovery.completed,
                recoverySource: observation.recovery.source,
                eventTypes: eventTypes(observation.events),
            });
        },
        endMatch(): IDecisionTiming[] {
            if (!active) throw new Error("Cannot end inactive decision instrumentation");
            if (active.pending || active.ready.length) {
                throw new Error(
                    `Unconsumed decision timing at ${active.taskId}: pending=${Boolean(active.pending)} ready=${active.ready.length}`,
                );
            }
            const decisions = active.decisions;
            active = null;
            return decisions;
        },
    };
}

interface ILoadedVariant {
    prepareMetaPair: (options: { cohort: Cohort; games: number; baseSeed: number }, pair: number) => IPreparedPair;
    runMatch: (config: Record<string, unknown>) => Record<string, unknown>;
    tracker: ReturnType<typeof installDecisionInstrumentation> | null;
    play: (task: IPanelTask, variant: Variant, workerIndex: number, instrument: boolean) => IMatchRecord;
}

async function loadVariant(rootInput: string, instrument: boolean): Promise<ILoadedVariant> {
    const root = requireRoot(rootInput);
    scrubExperimentEnvironment();
    const profile = await importFrom<{
        V08_A13_PRODUCTION_VERSION: string;
        V08_A13_SEARCH: { decisionDeadlineMs: number; circuitBreakerMs: number };
    }>(root, "src/ai/versions/v0_8_a13_profile.ts");
    if (
        profile.V08_A13_PRODUCTION_VERSION !== EXPECTED_VERSION ||
        profile.V08_A13_SEARCH.decisionDeadlineMs !== EXPECTED_DECISION_DEADLINE_MS ||
        profile.V08_A13_SEARCH.circuitBreakerMs !== EXPECTED_CIRCUIT_BREAKER_MS
    ) {
        throw new Error(
            `Variant ${root} is not the frozen v0.8 175/275 profile: ${canonicalJson({
                version: profile.V08_A13_PRODUCTION_VERSION,
                search: profile.V08_A13_SEARCH,
            })}`,
        );
    }
    const core = await importFrom<{
        AI_META_COHORTS: readonly string[];
        AI_META_MAPS: readonly number[];
        prepareMetaPair: ILoadedVariant["prepareMetaPair"];
    }>(root, "src/simulation/ai_meta_cohorts_core.ts");
    if (canonicalJson(core.AI_META_COHORTS) !== canonicalJson(COHORTS)) {
        throw new Error(`AI_META_COHORTS drifted in ${root}: ${canonicalJson(core.AI_META_COHORTS)}`);
    }
    if (canonicalJson(core.AI_META_MAPS) !== canonicalJson(LIVE_MAPS.map((map) => map.id))) {
        throw new Error(`AI_META_MAPS drifted in ${root}: ${canonicalJson(core.AI_META_MAPS)}`);
    }

    let tracker: ReturnType<typeof installDecisionInstrumentation> | null = null;
    if (instrument) {
        const [{ SearchDriver }, ai, types] = await Promise.all([
            importFrom<{ SearchDriver: Parameters<typeof installDecisionInstrumentation>[0] }>(
                root,
                "src/simulation/search_driver.ts",
            ),
            importFrom<{ getAIStrategy: (version: string) => Parameters<typeof installDecisionInstrumentation>[1] }>(
                root,
                "src/ai/index.ts",
            ),
            importFrom<{ PBTypes: { TeamVals: { LOWER: number } } }>(root, "src/generated/protobuf/v1/types.ts"),
        ]);
        tracker = installDecisionInstrumentation(
            SearchDriver,
            ai.getAIStrategy(EXPECTED_VERSION),
            types.PBTypes.TeamVals.LOWER,
        );
    }
    const battle = await importFrom<{
        runMatch: ILoadedVariant["runMatch"];
    }>(root, "src/simulation/battle_engine.ts");

    const play = (
        task: IPanelTask,
        variant: Variant,
        workerIndex: number,
        useInstrumentation: boolean,
    ): IMatchRecord => {
        const prepared = core.prepareMetaPair(
            { cohort: task.cohort, games: MATCHES_PER_COHORT, baseSeed: BASE_SEED },
            task.pair,
        );
        const preparedSha256 = digest(prepared);
        if (preparedSha256 !== task.preparedSha256) {
            throw new Error(
                `Prepared-pair drift for ${task.taskId} in ${variant}: expected ${task.preparedSha256}, got ${preparedSha256}`,
            );
        }
        if (
            prepared.map !== task.map ||
            prepared.combatSeed !== task.combatSeed ||
            prepared.setupSeed !== task.setupSeed
        ) {
            throw new Error(`Prepared-pair identity drift for ${task.taskId} in ${variant}`);
        }
        const green = task.aIsGreen ? prepared.armyA : prepared.armyB;
        const red = task.aIsGreen ? prepared.armyB : prepared.armyA;
        const config: Record<string, unknown> = {
            greenVersion: EXPECTED_VERSION,
            redVersion: EXPECTED_VERSION,
            roster: green.roster,
            redRoster: red.roster,
            seed: prepared.combatSeed,
            maxLaps: task.maxLaps,
            gridType: prepared.map,
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
        if (useInstrumentation) {
            if (!tracker) throw new Error("Decision instrumentation was not installed");
            tracker.beginMatch(task.taskId, variant, workerIndex);
            config.turnExecutionObserver = (observation: unknown): void => tracker!.observeExecution(observation);
        }
        const started = performance.now();
        const result = battle.runMatch(config) as {
            winner: "green" | "red" | "draw";
            endReason: string;
            laps: number;
            totalActions: number;
            actions: Array<{ completed?: boolean }>;
            placements: unknown;
            outcome: unknown;
            attrition: unknown;
            rejectedGreen?: number;
            rejectedRed?: number;
            [key: string]: unknown;
        };
        const matchWallMs = performance.now() - started;
        const decisions = useInstrumentation ? tracker!.endMatch() : [];
        const winnerForA =
            result.winner === "draw" ? "draw" : (result.winner === "green") === task.aIsGreen ? "a" : "b";
        const rejectedGreen = Number(result.rejectedGreen ?? 0);
        const rejectedRed = Number(result.rejectedRed ?? 0);
        const rolloutTurnsTotal = decisions.reduce((sum, decision) => sum + decision.rolloutTurnsTotal, 0);
        const searchMs = decisions.reduce((sum, decision) => sum + decision.searchMs, 0);
        const record: IMatchRecord = {
            schema: SCHEMA,
            task,
            variant,
            workerIndex,
            preparedSha256,
            matchWallMs,
            winner: result.winner,
            winnerForA,
            endReason: result.endReason,
            laps: result.laps,
            totalActions: result.totalActions,
            rejectedGreen,
            rejectedRed,
            // IMatchResult.actions is the accepted-action log. Rejections live in the explicit result counters
            // and rejectedDetails; filtering actions for completed=false silently undercounts them.
            engineRejectedActions: rejectedGreen + rejectedRed,
            recordedIncompleteActions: result.actions.filter((action) => action.completed === false).length,
            decisionCount: decisions.length,
            deadlineFallbacks: decisions.reduce((sum, decision) => sum + decision.deadlineFallbacks, 0),
            circuitSkipped: decisions.reduce((sum, decision) => sum + decision.circuitSkipped, 0),
            circuitOpenedDecisions: decisions.filter(
                (decision) => !decision.circuitOpenBefore && decision.circuitOpenAfter,
            ).length,
            recoveryAttempts: decisions.reduce((sum, decision) => sum + decision.recoverySources.length, 0),
            searchDecisions: decisions.reduce((sum, decision) => sum + decision.searchDecisions, 0),
            searched: decisions.reduce((sum, decision) => sum + decision.searched, 0),
            candidatesTotal: decisions.reduce((sum, decision) => sum + decision.candidatesTotal, 0),
            scoredCandidatesTotal: decisions.reduce((sum, decision) => sum + decision.scoredCandidatesTotal, 0),
            rolloutTurnsTotal,
            illegalIncumbent: decisions.reduce((sum, decision) => sum + decision.illegalIncumbent, 0),
            overrides: decisions.reduce((sum, decision) => sum + decision.overrides, 0),
            singleCandidate: decisions.reduce((sum, decision) => sum + decision.singleCandidate, 0),
            searchMsPer1000RolloutTurns: rolloutTurnsTotal > 0 ? (1000 * searchMs) / rolloutTurnsTotal : null,
            policyMs: decisions.reduce((sum, decision) => sum + decision.policyMs, 0),
            searchMs,
            totalDecisionMs: decisions.reduce((sum, decision) => sum + decision.totalDecisionMs, 0),
            resultDigest: digest(result),
            actionDigest: digest(result.actions),
            outcomeDigest: digest({
                winner: result.winner,
                endReason: result.endReason,
                laps: result.laps,
                outcome: result.outcome,
                attrition: result.attrition,
            }),
            placementsDigest: digest(result.placements),
            decisions,
        };
        (record as IMatchRecord & { __rawResult?: unknown }).__rawResult = result;
        return record;
    };
    return { prepareMetaPair: core.prepareMetaPair, runMatch: battle.runMatch, tracker, play };
}

function warmupTask(prepared: IPreparedPair): IPanelTask {
    const map = LIVE_MAPS.find((entry) => entry.id === prepared.map);
    if (!map) throw new Error(`Warmup produced non-live map ${prepared.map}`);
    return {
        taskId: "warmup/ranged-heavy/pair-0/a-green",
        clusterId: "warmup/ranged-heavy/pair-0",
        stratum: `ranged-heavy/${map.name}`,
        blockIndex: -1,
        cohort: "ranged-heavy",
        pair: 0,
        map: prepared.map,
        mapName: map.name,
        sideSwap: "a-green",
        aIsGreen: true,
        setupSeed: prepared.setupSeed,
        combatSeed: prepared.combatSeed,
        preparedSha256: digest(prepared),
        maxLaps: PROTOCOL.warmup.maxLaps,
    };
}

async function workerMain(init: IWorkerInit): Promise<void> {
    if (!parentPort) throw new Error("Panel worker has no parent port");
    try {
        mkdirSync(init.outputDir, { recursive: true });
        const matchesPath = join(init.outputDir, `w${String(init.workerIndex).padStart(2, "0")}.matches.jsonl`);
        const decisionsPath = join(init.outputDir, `w${String(init.workerIndex).padStart(2, "0")}.decisions.jsonl`);
        if (existsSync(matchesPath) || existsSync(decisionsPath)) {
            throw new Error(`Refusing to overwrite worker output for ${init.variant} worker ${init.workerIndex}`);
        }
        const loaded = await loadVariant(init.root, true);
        let warmup: IWorkerWarmup | null = null;
        if (!init.skipWarmup) {
            const prepared = loaded.prepareMetaPair(
                { cohort: PROTOCOL.warmup.cohort, games: MATCHES_PER_COHORT, baseSeed: BASE_SEED },
                PROTOCOL.warmup.pair,
            );
            const record = loaded.play(warmupTask(prepared), init.variant, init.workerIndex, true);
            if (record.decisionCount < PROTOCOL.warmup.minimumDecisionsPerWorker) {
                throw new Error(
                    `Warmup produced ${record.decisionCount} decisions; protocol requires at least ${PROTOCOL.warmup.minimumDecisionsPerWorker}`,
                );
            }
            warmup = {
                wallMs: record.matchWallMs,
                decisions: record.decisionCount,
                actions: record.totalActions,
                digest: record.resultDigest,
            };
        }
        parentPort.postMessage({ type: "ready", warmup } satisfies IWorkerResponse);
        parentPort.on("message", (message: IWorkerRequest) => {
            if (message.type === "stop") {
                parentPort!.close();
                return;
            }
            try {
                const records = (message.tasks ?? []).map((task) => {
                    const record = loaded.play(task, init.variant, init.workerIndex, true);
                    const rawResult = (record as IMatchRecord & { __rawResult?: unknown }).__rawResult;
                    delete (record as IMatchRecord & { __rawResult?: unknown }).__rawResult;
                    const { decisions, ...matchSummary } = record;
                    appendFileSync(matchesPath, `${JSON.stringify({ ...matchSummary, result: rawResult })}\n`);
                    if (decisions.length) {
                        appendFileSync(
                            decisionsPath,
                            `${decisions.map((decision) => JSON.stringify(decision)).join("\n")}\n`,
                        );
                    }
                    return record;
                });
                parentPort!.postMessage({
                    type: "batch-result",
                    requestId: message.requestId,
                    records,
                } satisfies IWorkerResponse);
            } catch (error) {
                parentPort!.postMessage({
                    type: "error",
                    requestId: message.requestId,
                    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
                } satisfies IWorkerResponse);
            }
        });
    } catch (error) {
        parentPort.postMessage({
            type: "error",
            error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        } satisfies IWorkerResponse);
    }
}

class PoolMember {
    readonly worker: Worker;
    readonly ready: Promise<IWorkerWarmup | null>;
    private readyResolve!: (warmup: IWorkerWarmup | null) => void;
    private readyReject!: (error: Error) => void;
    private readySettled = false;
    private stopping = false;
    private exited = false;
    private readonly pending = new Map<
        number,
        { resolve: (records: IMatchRecord[]) => void; reject: (error: Error) => void }
    >();

    public constructor(init: IWorkerInit) {
        this.ready = new Promise<IWorkerWarmup | null>((resolveReady, rejectReady) => {
            this.readyResolve = resolveReady;
            this.readyReject = rejectReady;
        });
        this.worker = new Worker(new URL(import.meta.url), { workerData: init });
        this.worker.on("message", (message: IWorkerResponse) => {
            if (message.type === "ready") {
                if (this.readySettled) return;
                this.readySettled = true;
                this.readyResolve(message.warmup ?? null);
                return;
            }
            if (message.type === "error") {
                const error = new Error(
                    `${init.variant} worker ${init.workerIndex}: ${message.error ?? "unknown panel-worker error"}`,
                );
                if (message.requestId !== undefined) {
                    const request = this.pending.get(message.requestId);
                    this.pending.delete(message.requestId);
                    request?.reject(error);
                } else {
                    this.rejectAll(error);
                }
                return;
            }
            if (message.requestId === undefined) return;
            const request = this.pending.get(message.requestId);
            this.pending.delete(message.requestId);
            request?.resolve(message.records ?? []);
        });
        this.worker.on("error", (error) => {
            this.rejectAll(error);
        });
        this.worker.on("exit", (code) => {
            this.exited = true;
            if (!this.stopping) {
                this.rejectAll(
                    new Error(`${init.variant} worker ${init.workerIndex} exited unexpectedly with code ${code}`),
                );
            }
        });
    }

    private rejectAll(error: Error): void {
        if (!this.readySettled) {
            this.readySettled = true;
            this.readyReject(error);
        }
        for (const request of this.pending.values()) request.reject(error);
        this.pending.clear();
    }

    public run(requestId: number, condition: number, tasks: IPanelTask[]): Promise<IMatchRecord[]> {
        return new Promise<IMatchRecord[]>((resolveRequest, rejectRequest) => {
            if (this.exited || this.stopping) {
                rejectRequest(new Error("Cannot dispatch work to a stopped panel worker"));
                return;
            }
            this.pending.set(requestId, { resolve: resolveRequest, reject: rejectRequest });
            this.worker.postMessage({ type: "batch", requestId, condition, tasks } satisfies IWorkerRequest);
        });
    }

    public async stop(): Promise<void> {
        // The work is already durably flushed before stop(). Explicit termination avoids a Bun worker-thread
        // liveness bug where closing parentPort leaves an otherwise idle imported simulation isolate resident.
        if (this.exited) return;
        this.stopping = true;
        this.rejectAll(new Error("Panel worker stopped before completing outstanding work"));
        await this.worker.terminate();
    }
}

class VariantPool {
    private nextRequestId = 1;
    public constructor(
        public readonly variant: Variant,
        private readonly members: PoolMember[],
        public readonly warmups: Array<IWorkerWarmup | null>,
    ) {}

    public static async create(options: {
        variant: Variant;
        root: string;
        concurrency: number;
        outputDir: string;
        skipWarmup: boolean;
    }): Promise<VariantPool> {
        const members: PoolMember[] = [];
        try {
            for (let workerIndex = 0; workerIndex < options.concurrency; workerIndex += 1) {
                members.push(
                    new PoolMember({
                        kind: "panel-worker",
                        root: options.root,
                        variant: options.variant,
                        workerIndex,
                        outputDir: options.outputDir,
                        skipWarmup: options.skipWarmup,
                    }),
                );
            }
            const warmups = await Promise.all(members.map((member) => member.ready));
            return new VariantPool(options.variant, members, warmups);
        } catch (error) {
            await Promise.allSettled(members.map((member) => member.stop()));
            throw error;
        }
    }

    public async runBlock(
        condition: number,
        tasks: IPanelTask[],
    ): Promise<{ records: IMatchRecord[]; wallMs: number }> {
        const shards = this.members.map(() => [] as IPanelTask[]);
        tasks.forEach((task, index) => shards[index % shards.length].push(task));
        const started = performance.now();
        const batches = await Promise.all(
            this.members.map((member, index) => member.run(this.nextRequestId++, condition, shards[index])),
        );
        return { records: batches.flat(), wallMs: performance.now() - started };
    }

    public async stop(): Promise<void> {
        await Promise.all(this.members.map((member) => member.stop()));
    }
}

async function buildPlan(planRootInput: string): Promise<IFrozenPlan> {
    const planRoot = requireRoot(planRootInput);
    scrubExperimentEnvironment();
    const core = await importFrom<{
        AI_META_COHORTS: readonly string[];
        AI_META_MAPS: readonly number[];
        prepareMetaPair: ILoadedVariant["prepareMetaPair"];
    }>(planRoot, "src/simulation/ai_meta_cohorts_core.ts");
    if (canonicalJson(core.AI_META_COHORTS) !== canonicalJson(COHORTS)) throw new Error("Plan-root cohorts drifted");
    if (canonicalJson(core.AI_META_MAPS) !== canonicalJson(LIVE_MAPS.map((map) => map.id))) {
        throw new Error("Plan-root live maps drifted");
    }
    const clusters: IPlanCluster[] = [];
    for (const [cohortIndex, cohort] of COHORTS.entries()) {
        for (let pair = 0; pair < PAIRS_PER_COHORT; pair += 1) {
            const prepared = core.prepareMetaPair({ cohort, games: MATCHES_PER_COHORT, baseSeed: BASE_SEED }, pair);
            const mapIndex = LIVE_MAPS.findIndex((entry) => entry.id === prepared.map);
            if (mapIndex < 0) throw new Error(`${cohort} pair ${pair} produced non-live map ${prepared.map}`);
            const mapName = LIVE_MAPS[mapIndex].name;
            clusters.push({
                clusterId: `${cohort}/pair-${String(pair).padStart(2, "0")}`,
                stratum: `${cohort}/${mapName}`,
                blockIndex: cohortIndex * LIVE_MAPS.length + mapIndex,
                cohort,
                pair,
                map: prepared.map,
                mapName,
                setupSeed: prepared.setupSeed,
                combatSeed: prepared.combatSeed,
                preparedSha256: digest(prepared),
                prepared,
            });
        }
    }
    const tasks = clusters.flatMap((cluster) => {
        const swaps: SideSwap[] = cluster.pair % 2 === 0 ? ["a-green", "b-green"] : ["b-green", "a-green"];
        return swaps.map((sideSwap): IPanelTask => ({
            taskId: `${cluster.clusterId}/${sideSwap}`,
            clusterId: cluster.clusterId,
            stratum: cluster.stratum,
            blockIndex: cluster.blockIndex,
            cohort: cluster.cohort,
            pair: cluster.pair,
            map: cluster.map,
            mapName: cluster.mapName,
            sideSwap,
            aIsGreen: sideSwap === "a-green",
            setupSeed: cluster.setupSeed,
            combatSeed: cluster.combatSeed,
            preparedSha256: cluster.preparedSha256,
            maxLaps: MAX_LAPS,
        }));
    });
    for (const cohort of COHORTS) {
        for (const map of LIVE_MAPS) {
            const count = clusters.filter((cluster) => cluster.cohort === cohort && cluster.map === map.id).length;
            if (count !== 10) throw new Error(`Expected 10 clusters in ${cohort}/${map.name}, got ${count}`);
        }
    }
    if (clusters.length !== 210 || tasks.length !== PROTOCOL.matchesPerVariant) {
        throw new Error(`Plan cardinality drift: clusters=${clusters.length}, tasks=${tasks.length}`);
    }
    const plan: IFrozenPlan = {
        schema: SCHEMA,
        protocolSha256: digest(PROTOCOL),
        clusters,
        tasks,
    };
    plan.planSha256 = digest(plan);
    return plan;
}

function nearestRank(sorted: readonly number[], probability: number): number {
    if (!sorted.length) throw new Error("Cannot calculate a percentile without samples");
    return sorted[Math.max(0, Math.ceil(probability * sorted.length) - 1)];
}

function sampleSummary(values: readonly number[]): Record<string, number> {
    if (!values.length) throw new Error("Cannot summarize an empty sample");
    const sorted = [...values].sort((left, right) => left - right);
    return {
        count: sorted.length,
        sum: sorted.reduce((sum, value) => sum + value, 0),
        mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
        min: sorted[0],
        p50: nearestRank(sorted, 0.5),
        p95: nearestRank(sorted, 0.95),
        p99: nearestRank(sorted, 0.99),
        p99_9: nearestRank(sorted, 0.999),
        max: nearestRank(sorted, 1),
    };
}

function variantSummary(records: readonly IMatchRecord[]): Record<string, unknown> {
    const decisions = records.flatMap((record) => record.decisions);
    const searchedDecisions = decisions.filter((decision) => decision.searched > 0 && decision.circuitSkipped === 0);
    const rolloutTurnsTotal = records.reduce((sum, record) => sum + record.rolloutTurnsTotal, 0);
    const searchMsTotal = records.reduce((sum, record) => sum + record.searchMs, 0);
    return {
        matches: records.length,
        decisions: decisions.length,
        actions: records.reduce((sum, record) => sum + record.totalActions, 0),
        engineRejectedActions: records.reduce((sum, record) => sum + record.engineRejectedActions, 0),
        resultRejectedActions: records.reduce((sum, record) => sum + record.rejectedGreen + record.rejectedRed, 0),
        deadlineFallbacks: records.reduce((sum, record) => sum + record.deadlineFallbacks, 0),
        circuitSkipped: records.reduce((sum, record) => sum + record.circuitSkipped, 0),
        circuitOpenedDecisions: records.reduce((sum, record) => sum + record.circuitOpenedDecisions, 0),
        recoveryAttempts: records.reduce((sum, record) => sum + record.recoveryAttempts, 0),
        searchDecisions: records.reduce((sum, record) => sum + record.searchDecisions, 0),
        searched: records.reduce((sum, record) => sum + record.searched, 0),
        candidatesTotal: records.reduce((sum, record) => sum + record.candidatesTotal, 0),
        scoredCandidatesTotal: records.reduce((sum, record) => sum + record.scoredCandidatesTotal, 0),
        rolloutTurnsTotal,
        illegalIncumbent: records.reduce((sum, record) => sum + record.illegalIncumbent, 0),
        overrides: records.reduce((sum, record) => sum + record.overrides, 0),
        singleCandidate: records.reduce((sum, record) => sum + record.singleCandidate, 0),
        searchMsPer1000RolloutTurns: rolloutTurnsTotal > 0 ? (1000 * searchMsTotal) / rolloutTurnsTotal : null,
        matchWallMs: sampleSummary(records.map((record) => record.matchWallMs)),
        matchDecisionTotalMs: sampleSummary(records.map((record) => record.totalDecisionMs)),
        decisionTotalMs: sampleSummary(decisions.map((decision) => decision.totalDecisionMs)),
        policyMs: sampleSummary(decisions.map((decision) => decision.policyMs)),
        searchMs: sampleSummary(decisions.map((decision) => decision.searchMs)),
        searchedDecisionCount: searchedDecisions.length,
        searchedDecisionTotalMs: sampleSummary(searchedDecisions.map((decision) => decision.totalDecisionMs)),
        searchedDecisionSearchMs: sampleSummary(searchedDecisions.map((decision) => decision.searchMs)),
        arbitrationOverheadMs: sampleSummary(decisions.map((decision) => decision.arbitrationOverheadMs)),
    };
}

interface IClusterDurations {
    clusterId: string;
    stratum: string;
    baseline: {
        totalDecisionMs: number;
        searchMs: number;
        matchWallMs: number;
        decisionSamples: number[];
        searchedDecisionSamples: number[];
    };
    candidate: {
        totalDecisionMs: number;
        searchMs: number;
        matchWallMs: number;
        decisionSamples: number[];
        searchedDecisionSamples: number[];
    };
}

function clusterDurations(baseline: readonly IMatchRecord[], candidate: readonly IMatchRecord[]): IClusterDurations[] {
    const byVariant = (records: readonly IMatchRecord[]): Map<string, IMatchRecord[]> => {
        const output = new Map<string, IMatchRecord[]>();
        for (const record of records) {
            const rows = output.get(record.task.clusterId) ?? [];
            rows.push(record);
            output.set(record.task.clusterId, rows);
        }
        return output;
    };
    const baselineByCluster = byVariant(baseline);
    const candidateByCluster = byVariant(candidate);
    return [...baselineByCluster.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([clusterId, baselineRows]) => {
            const candidateRows = candidateByCluster.get(clusterId) ?? [];
            if (baselineRows.length !== 2 || candidateRows.length !== 2) {
                throw new Error(
                    `Bootstrap cluster ${clusterId} must contain two side swaps per variant; got ${baselineRows.length}/${candidateRows.length}`,
                );
            }
            const sum = (rows: readonly IMatchRecord[]) => ({
                totalDecisionMs: rows.reduce((value, row) => value + row.totalDecisionMs, 0),
                searchMs: rows.reduce((value, row) => value + row.searchMs, 0),
                matchWallMs: rows.reduce((value, row) => value + row.matchWallMs, 0),
                decisionSamples: rows.flatMap((row) => row.decisions.map((decision) => decision.totalDecisionMs)),
                searchedDecisionSamples: rows.flatMap((row) =>
                    row.decisions
                        .filter((decision) => decision.searched > 0 && decision.circuitSkipped === 0)
                        .map((decision) => decision.totalDecisionMs),
                ),
            });
            return {
                clusterId,
                stratum: baselineRows[0].task.stratum,
                baseline: sum(baselineRows),
                candidate: sum(candidateRows),
            };
        });
}

function makeRng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
    };
}

function reduction(baseline: number, candidate: number): number {
    return baseline === 0 ? 0 : 100 * (1 - candidate / baseline);
}

function bootstrap(clusters: readonly IClusterDurations[]): Record<string, unknown> {
    const byStratum = new Map<string, IClusterDurations[]>();
    for (const cluster of clusters) {
        const rows = byStratum.get(cluster.stratum) ?? [];
        rows.push(cluster);
        byStratum.set(cluster.stratum, rows);
    }
    if (byStratum.size !== 21 || [...byStratum.values()].some((rows) => rows.length !== 10)) {
        throw new Error("Bootstrap requires exactly 21 strata with 10 pair clusters each");
    }
    const metrics = ["totalDecisionMs", "searchMs", "matchWallMs"] as const;
    const rng = makeRng(BOOTSTRAP_SEED);
    const samples: Record<(typeof metrics)[number], number[]> = {
        totalDecisionMs: [],
        searchMs: [],
        matchWallMs: [],
    };
    const tailKinds = ["allDecisions", "searchedDecisions"] as const;
    const tailSamples: Record<(typeof tailKinds)[number], { p95: number[]; p99: number[] }> = {
        allDecisions: { p95: [], p99: [] },
        searchedDecisions: { p95: [], p99: [] },
    };
    const clusterIndex = new Map(clusters.map((cluster, index) => [cluster.clusterId, index]));
    const observations = (
        variant: Variant,
        kind: (typeof tailKinds)[number],
    ): Array<{ value: number; clusterIndex: number }> =>
        clusters
            .flatMap((cluster, index) =>
                (kind === "allDecisions"
                    ? cluster[variant].decisionSamples
                    : cluster[variant].searchedDecisionSamples
                ).map((value) => ({ value, clusterIndex: index })),
            )
            .sort((left, right) => left.value - right.value);
    const sortedObservations = Object.fromEntries(
        tailKinds.map((kind) => [
            kind,
            { baseline: observations("baseline", kind), candidate: observations("candidate", kind) },
        ]),
    ) as Record<(typeof tailKinds)[number], Record<Variant, Array<{ value: number; clusterIndex: number }>>>;
    const weightedTails = (
        sorted: ReadonlyArray<{ value: number; clusterIndex: number }>,
        weights: Uint16Array,
    ): { p95: number; p99: number } => {
        let total = 0;
        for (const observation of sorted) total += weights[observation.clusterIndex];
        if (total === 0) throw new Error("Bootstrap tail sample is empty");
        const target95 = Math.ceil(0.95 * total);
        const target99 = Math.ceil(0.99 * total);
        let cumulative = 0;
        let p95: number | undefined;
        let p99: number | undefined;
        for (const observation of sorted) {
            cumulative += weights[observation.clusterIndex];
            if (p95 === undefined && cumulative >= target95) p95 = observation.value;
            if (cumulative >= target99) {
                p99 = observation.value;
                break;
            }
        }
        if (p95 === undefined || p99 === undefined) throw new Error("Weighted nearest-rank scan did not terminate");
        return { p95, p99 };
    };
    for (let replicate = 0; replicate < BOOTSTRAP_REPLICATES; replicate += 1) {
        const totals = Object.fromEntries(metrics.map((metric) => [metric, { baseline: 0, candidate: 0 }])) as Record<
            (typeof metrics)[number],
            { baseline: number; candidate: number }
        >;
        const weights = new Uint16Array(clusters.length);
        for (const stratum of [...byStratum.keys()].sort()) {
            const rows = byStratum.get(stratum)!;
            for (let draw = 0; draw < rows.length; draw += 1) {
                const sampled = rows[Math.floor(rng() * rows.length)];
                weights[clusterIndex.get(sampled.clusterId)!] += 1;
                for (const metric of metrics) {
                    totals[metric].baseline += sampled.baseline[metric];
                    totals[metric].candidate += sampled.candidate[metric];
                }
            }
        }
        for (const metric of metrics) {
            samples[metric].push(reduction(totals[metric].baseline, totals[metric].candidate));
        }
        for (const kind of tailKinds) {
            const baselineTails = weightedTails(sortedObservations[kind].baseline, weights);
            const candidateTails = weightedTails(sortedObservations[kind].candidate, weights);
            tailSamples[kind].p95.push(candidateTails.p95 / baselineTails.p95);
            tailSamples[kind].p99.push(candidateTails.p99 / baselineTails.p99);
        }
    }
    const allTotals = (metric: (typeof metrics)[number]): { baseline: number; candidate: number } => ({
        baseline: clusters.reduce((sum, cluster) => sum + cluster.baseline[metric], 0),
        candidate: clusters.reduce((sum, cluster) => sum + cluster.candidate[metric], 0),
    });
    const durationReductions = Object.fromEntries(
        metrics.map((metric) => {
            const sorted = samples[metric].sort((left, right) => left - right);
            const point = allTotals(metric);
            return [
                metric,
                {
                    pointReductionPercent: reduction(point.baseline, point.candidate),
                    baselineTotalMs: point.baseline,
                    candidateTotalMs: point.candidate,
                    lower95ReductionPercent: nearestRank(sorted, 0.025),
                    medianReductionPercent: nearestRank(sorted, 0.5),
                    upper95ReductionPercent: nearestRank(sorted, 0.975),
                },
            ];
        }),
    );
    const tailRatios = Object.fromEntries(
        tailKinds.map((kind) => {
            const pointBaseline = sortedObservations[kind].baseline.map((entry) => entry.value);
            const pointCandidate = sortedObservations[kind].candidate.map((entry) => entry.value);
            return [
                kind,
                Object.fromEntries(
                    (["p95", "p99"] as const).map((percentile) => {
                        const probability = percentile === "p95" ? 0.95 : 0.99;
                        const ratios = tailSamples[kind][percentile].sort((left, right) => left - right);
                        return [
                            percentile,
                            {
                                pointRatio:
                                    nearestRank(pointCandidate, probability) / nearestRank(pointBaseline, probability),
                                lower95Ratio: nearestRank(ratios, 0.025),
                                medianRatio: nearestRank(ratios, 0.5),
                                upper95Ratio: nearestRank(ratios, 0.975),
                            },
                        ];
                    }),
                ),
            ];
        }),
    );
    return { durationReductions, tailRatios };
}

function hostSnapshot(concurrency: number): Record<string, unknown> {
    const loads = loadavg();
    const free = freemem();
    return {
        capturedAt: new Date().toISOString(),
        load1: loads[0],
        load5: loads[1],
        load15: loads[2],
        freeMemoryBytes: free,
        totalMemoryBytes: totalmem(),
        concurrency,
        continuousHostAttestationJoined: false,
        qualified: false,
        qualificationReason:
            "load/free-memory snapshots do not prove continuous AC, thermal, memory-pressure, or external-process requirements",
    };
}

function compareRecords(
    baseline: readonly IMatchRecord[],
    candidate: readonly IMatchRecord[],
): Record<string, unknown> {
    const candidateByTask = new Map(candidate.map((record) => [record.task.taskId, record]));
    let resultDigestMatches = 0;
    let actionDigestMatches = 0;
    let outcomeDigestMatches = 0;
    let placementDigestMatches = 0;
    let candidateWorseRejectionTasks = 0;
    let candidateOnlyRejectedActions = 0;
    let candidateOnlyDeadlineFallbacks = 0;
    let candidateOnlyCircuitOpens = 0;
    let candidateWorseIllegalIncumbentTasks = 0;
    let candidateOnlyIllegalIncumbentIncrease = 0;
    const candidateWorseIllegalIncumbentTaskIds: string[] = [];
    let deadlineFallbackMismatchTasks = 0;
    let circuitOpenMismatchTasks = 0;
    let circuitSkipMismatchTasks = 0;
    const boundedDivergenceTaskIds = new Set<string>();
    const logicalMismatchTaskIds = new Set<string>();
    let missing = 0;
    const logicalFields = [
        "totalActions",
        "decisionCount",
        "searchDecisions",
        "searched",
        "candidatesTotal",
        "scoredCandidatesTotal",
        "rolloutTurnsTotal",
        "illegalIncumbent",
        "overrides",
        "singleCandidate",
    ] as const;
    for (const baselineRecord of baseline) {
        const candidateRecord = candidateByTask.get(baselineRecord.task.taskId);
        if (!candidateRecord) {
            missing += 1;
            continue;
        }
        if (baselineRecord.resultDigest === candidateRecord.resultDigest) resultDigestMatches += 1;
        if (baselineRecord.actionDigest === candidateRecord.actionDigest) actionDigestMatches += 1;
        if (baselineRecord.outcomeDigest === candidateRecord.outcomeDigest) outcomeDigestMatches += 1;
        if (baselineRecord.placementsDigest === candidateRecord.placementsDigest) placementDigestMatches += 1;
        if (candidateRecord.engineRejectedActions > baselineRecord.engineRejectedActions) {
            candidateWorseRejectionTasks += 1;
        }
        candidateOnlyRejectedActions += Math.max(
            0,
            candidateRecord.engineRejectedActions - baselineRecord.engineRejectedActions,
        );
        candidateOnlyDeadlineFallbacks += Math.max(
            0,
            candidateRecord.deadlineFallbacks - baselineRecord.deadlineFallbacks,
        );
        candidateOnlyCircuitOpens += Math.max(
            0,
            candidateRecord.circuitOpenedDecisions - baselineRecord.circuitOpenedDecisions,
        );
        const illegalIncumbentIncrease = candidateRecord.illegalIncumbent - baselineRecord.illegalIncumbent;
        if (illegalIncumbentIncrease > 0) {
            candidateWorseIllegalIncumbentTasks += 1;
            candidateWorseIllegalIncumbentTaskIds.push(baselineRecord.task.taskId);
        }
        candidateOnlyIllegalIncumbentIncrease += Math.max(0, illegalIncumbentIncrease);
        if (candidateRecord.deadlineFallbacks !== baselineRecord.deadlineFallbacks) {
            deadlineFallbackMismatchTasks += 1;
            boundedDivergenceTaskIds.add(baselineRecord.task.taskId);
        }
        if (candidateRecord.circuitOpenedDecisions !== baselineRecord.circuitOpenedDecisions) {
            circuitOpenMismatchTasks += 1;
            boundedDivergenceTaskIds.add(baselineRecord.task.taskId);
        }
        if (candidateRecord.circuitSkipped !== baselineRecord.circuitSkipped) {
            circuitSkipMismatchTasks += 1;
            boundedDivergenceTaskIds.add(baselineRecord.task.taskId);
        }
        if (logicalFields.some((field) => candidateRecord[field] !== baselineRecord[field])) {
            logicalMismatchTaskIds.add(baselineRecord.task.taskId);
        }
    }
    const logicalWork = Object.fromEntries(
        logicalFields.map((field) => {
            const baselineTotal = baseline.reduce((sum, record) => sum + record[field], 0);
            const candidateTotal = candidate.reduce((sum, record) => sum + record[field], 0);
            return [
                field,
                {
                    baseline: baselineTotal,
                    candidate: candidateTotal,
                    delta: candidateTotal - baselineTotal,
                    equal: baselineTotal === candidateTotal,
                },
            ];
        }),
    ) as Record<(typeof logicalFields)[number], { baseline: number; candidate: number; delta: number; equal: boolean }>;
    const aggregateFieldsEqual = logicalFields.every((field) => logicalWork[field].equal);
    const attributedLogicalMismatchTaskIds = [...logicalMismatchTaskIds].filter((taskId) =>
        boundedDivergenceTaskIds.has(taskId),
    );
    const unattributedLogicalMismatchTaskIds = [...logicalMismatchTaskIds].filter(
        (taskId) => !boundedDivergenceTaskIds.has(taskId),
    );
    const baselineRolloutTurns = logicalWork.rolloutTurnsTotal.baseline;
    const candidateRolloutTurns = logicalWork.rolloutTurnsTotal.candidate;
    const baselineSearchMs = baseline.reduce((sum, record) => sum + record.searchMs, 0);
    const candidateSearchMs = candidate.reduce((sum, record) => sum + record.searchMs, 0);
    const baselineNormalized = baselineRolloutTurns > 0 ? (1000 * baselineSearchMs) / baselineRolloutTurns : null;
    const candidateNormalized = candidateRolloutTurns > 0 ? (1000 * candidateSearchMs) / candidateRolloutTurns : null;
    return {
        matchedTasks: baseline.length - missing,
        missingCandidateTasks: missing,
        resultDigestMatches,
        resultDigestMismatches: baseline.length - missing - resultDigestMatches,
        actionDigestMatches,
        actionDigestMismatches: baseline.length - missing - actionDigestMatches,
        outcomeDigestMatches,
        outcomeDigestMismatches: baseline.length - missing - outcomeDigestMatches,
        placementDigestMatches,
        placementDigestMismatches: baseline.length - missing - placementDigestMatches,
        candidateWorseRejectionTasks,
        candidateOnlyExceptions: 0,
        candidateOnlyRejectedActions,
        candidateOnlyDeadlineFallbacks,
        candidateOnlyCircuitOpens,
        candidateWorseIllegalIncumbentTasks,
        candidateOnlyIllegalIncumbentIncrease,
        illegalIncumbentSafety: {
            baseline: logicalWork.illegalIncumbent.baseline,
            candidate: logicalWork.illegalIncumbent.candidate,
            delta: logicalWork.illegalIncumbent.delta,
            candidateWorseTasks: candidateWorseIllegalIncumbentTasks,
            candidateWorseTaskIds: candidateWorseIllegalIncumbentTaskIds.sort(),
            candidateOnlyIncrease: candidateOnlyIllegalIncumbentIncrease,
            qualificationPass: candidateOnlyIllegalIncumbentIncrease === 0,
            policy: "Sum max(0, candidate illegalIncumbent - baseline illegalIncumbent) independently per matched task; require zero so cross-task decreases cannot mask candidate-only increases.",
        },
        boundedTimingDivergence: {
            deadlineFallbackMismatchTasks,
            circuitOpenMismatchTasks,
            circuitSkipMismatchTasks,
            taskIds: [...boundedDivergenceTaskIds].sort(),
        },
        logicalWork: {
            fieldCount: logicalFields.length,
            fieldNames: logicalFields,
            fields: logicalWork,
            aggregateFieldsEqual,
            allEqual: logicalMismatchTaskIds.size === 0,
            logicalMismatchTasks: logicalMismatchTaskIds.size,
            attributedLogicalMismatchTasks: attributedLogicalMismatchTaskIds.length,
            unattributedLogicalMismatchTasks: unattributedLogicalMismatchTaskIds.length,
            logicalMismatchTaskIds: [...logicalMismatchTaskIds].sort(),
            attributedLogicalMismatchTaskIds: attributedLogicalMismatchTaskIds.sort(),
            unattributedLogicalMismatchTaskIds: unattributedLogicalMismatchTaskIds.sort(),
            qualificationPass: unattributedLogicalMismatchTaskIds.length === 0,
            normalizedSearchCost: {
                unit: "search milliseconds per 1,000 rollout turns",
                baseline: baselineNormalized,
                candidate: candidateNormalized,
                candidateOverBaseline:
                    baselineNormalized !== null && candidateNormalized !== null
                        ? candidateNormalized / baselineNormalized
                        : null,
            },
            policy: "Accepted actions and SearchDriver logical work must match task-by-task. A mismatched task is allowed only when that same task has an explicitly counted bounded deadline-fallback, circuit-open, or circuit-skip divergence.",
        },
    };
}

function numericAt(value: Record<string, unknown>, key: string): number {
    const result = value[key];
    if (typeof result !== "number") throw new Error(`Expected numeric summary field ${key}`);
    return result;
}

function gateSummary(
    concurrency: number,
    host: Record<string, unknown>,
    baselineSummary: Record<string, unknown>,
    candidateSummary: Record<string, unknown>,
    comparison: Record<string, unknown>,
    bootstrapSummary: Record<string, unknown>,
    activeWallMs: Record<Variant, number>,
): Record<string, unknown> {
    const reductions = bootstrapSummary.durationReductions as Record<string, Record<string, unknown>>;
    const totalBootstrap = reductions.totalDecisionMs;
    const searchBootstrap = reductions.searchMs;
    const tailRatios = bootstrapSummary.tailRatios as Record<string, Record<string, Record<string, unknown>>>;
    const allDecisionTails = tailRatios.allDecisions;
    const logicalWork = comparison.logicalWork as { qualificationPass?: boolean };
    const activeWallRatioCandidateOverBaseline = activeWallMs.candidate / activeWallMs.baseline;
    const checks: Record<string, boolean> = {
        hostQualified: host.qualified === true,
        matchedTaskSetComplete:
            numericAt(comparison, "missingCandidateTasks") === 0 &&
            numericAt(comparison, "matchedTasks") === numericAt(baselineSummary, "matches"),
        candidateOnlyExceptionsZero: numericAt(comparison, "candidateOnlyExceptions") === 0,
        candidateEngineRejectionsZero: numericAt(candidateSummary, "engineRejectedActions") === 0,
        candidateOnlyRejectedActionsZero: numericAt(comparison, "candidateOnlyRejectedActions") === 0,
        candidateOnlyDeadlineFallbacksZero: numericAt(comparison, "candidateOnlyDeadlineFallbacks") === 0,
        candidateOnlyCircuitOpensZero: numericAt(comparison, "candidateOnlyCircuitOpens") === 0,
        candidateOnlyIllegalIncumbentIncreaseZero: numericAt(comparison, "candidateOnlyIllegalIncumbentIncrease") === 0,
        logicalWorkEqualOrExplicitlyAttributed: logicalWork.qualificationPass === true,
        allDecisionP95RatioUpper95WithinFivePercent: numericAt(allDecisionTails.p95, "upper95Ratio") <= 1.05,
        allDecisionP99RatioUpper95WithinFivePercent: numericAt(allDecisionTails.p99, "upper95Ratio") <= 1.05,
    };
    if (concurrency === 1) {
        checks.totalDecisionBootstrapLowerBoundPositive = numericAt(totalBootstrap, "lower95ReductionPercent") > 0;
        checks.searchBootstrapLowerBoundPositive = numericAt(searchBootstrap, "lower95ReductionPercent") > 0;
    } else {
        checks.candidateActiveWallWithinFivePercent = activeWallRatioCandidateOverBaseline <= 1.05;
    }
    return {
        activeWallRatioCandidateOverBaseline,
        checks,
        qualified: Object.values(checks).every(Boolean),
    };
}

async function runConditionCore(options: {
    concurrency: number;
    baselineRoot: string;
    candidateRoot: string;
    outputDir: string;
    plan: IFrozenPlan;
    tasks: IPanelTask[];
    skipWarmup: boolean;
}): Promise<Record<string, unknown>> {
    const conditionName = `c${options.concurrency}`;
    const conditionDir = join(options.outputDir, conditionName);
    mkdirSync(conditionDir, { recursive: true });
    const hostBefore = hostSnapshot(options.concurrency);
    console.log(
        `[${conditionName}] host load1=${String(hostBefore.load1)} freeGiB=${(
            Number(hostBefore.freeMemoryBytes) / GIB
        ).toFixed(2)} qualified=${String(hostBefore.qualified)}`,
    );
    const poolSettled = await Promise.allSettled([
        VariantPool.create({
            variant: "baseline",
            root: options.baselineRoot,
            concurrency: options.concurrency,
            outputDir: join(conditionDir, "baseline"),
            skipWarmup: options.skipWarmup,
        }),
        VariantPool.create({
            variant: "candidate",
            root: options.candidateRoot,
            concurrency: options.concurrency,
            outputDir: join(conditionDir, "candidate"),
            skipWarmup: options.skipWarmup,
        }),
    ]);
    const createdPools = poolSettled
        .filter((result): result is PromiseFulfilledResult<VariantPool> => result.status === "fulfilled")
        .map((result) => result.value);
    const poolFailure = poolSettled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (poolFailure) {
        await Promise.allSettled(createdPools.map((pool) => pool.stop()));
        throw poolFailure.reason;
    }
    const [baselinePool, candidatePool] = createdPools;
    if (!baselinePool || !candidatePool) {
        await Promise.allSettled(createdPools.map((pool) => pool.stop()));
        throw new Error(`Failed to create both ${conditionName} variant pools`);
    }
    const pools: Record<Variant, VariantPool> = { baseline: baselinePool, candidate: candidatePool };
    const records: Record<Variant, IMatchRecord[]> = { baseline: [], candidate: [] };
    const activeWallMs: Record<Variant, number> = { baseline: 0, candidate: 0 };
    const phases: Array<Record<string, unknown>> = [];
    const blockIndices = [...new Set(options.tasks.map((task) => task.blockIndex))].sort((left, right) => left - right);
    const conditionStarted = performance.now();
    try {
        for (const blockIndex of blockIndices) {
            const blockTasks = options.tasks.filter((task) => task.blockIndex === blockIndex);
            const order: Variant[] = blockIndex % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
            for (const variant of order) {
                const phaseStartedAt = new Date().toISOString();
                const phase = await pools[variant].runBlock(options.concurrency, blockTasks);
                activeWallMs[variant] += phase.wallMs;
                records[variant].push(...phase.records);
                phases.push({
                    blockIndex,
                    variant,
                    matches: phase.records.length,
                    wallMs: phase.wallMs,
                    phaseStartedAt,
                });
                console.log(
                    `[${conditionName}] block=${String(blockIndex).padStart(2, "0")} ${variant} matches=${phase.records.length} wallMs=${phase.wallMs.toFixed(3)}`,
                );
            }
        }
    } finally {
        await Promise.all([baselinePool.stop(), candidatePool.stop()]);
    }
    const conditionWallMs = performance.now() - conditionStarted;
    for (const variant of ["baseline", "candidate"] as const) {
        const expected = options.tasks.length;
        if (records[variant].length !== expected) {
            throw new Error(
                `${conditionName}/${variant} produced ${records[variant].length} matches, expected ${expected}`,
            );
        }
        const identities = new Set(records[variant].map((record) => record.task.taskId));
        if (identities.size !== expected)
            throw new Error(`${conditionName}/${variant} produced duplicate task identities`);
    }
    const baselineSummary = variantSummary(records.baseline);
    const candidateSummary = variantSummary(records.candidate);
    const comparison = compareRecords(records.baseline, records.candidate);
    const bootstrapSummary =
        options.tasks.length === PROTOCOL.matchesPerVariant
            ? bootstrap(clusterDurations(records.baseline, records.candidate))
            : { omitted: "smoke mode does not contain all 21 x 10 strata" };
    const gates =
        options.tasks.length === PROTOCOL.matchesPerVariant
            ? gateSummary(
                  options.concurrency,
                  hostBefore,
                  baselineSummary,
                  candidateSummary,
                  comparison,
                  bootstrapSummary,
                  activeWallMs,
              )
            : { qualified: false, reason: "smoke mode is never qualifying" };
    const report = {
        schema: SCHEMA,
        condition: conditionName,
        concurrency: options.concurrency,
        qualifyingWorkload: options.tasks.length === PROTOCOL.matchesPerVariant,
        planSha256: options.plan.planSha256,
        taskCountPerVariant: options.tasks.length,
        totalExecutions: options.tasks.length * 2,
        hostBefore,
        hostAfter: hostSnapshot(options.concurrency),
        warmup: {
            protocol: PROTOCOL.warmup,
            baseline: baselinePool.warmups,
            candidate: candidatePool.warmups,
        },
        schedule: PROTOCOL.schedule,
        workerTopology: {
            workersPerVariant: options.concurrency,
            residentWorkers: options.concurrency * 2,
            warmupExecutions: options.skipWarmup ? 0 : options.concurrency * 2,
            definition: PROTOCOL.workerTopology,
        },
        activeWallDefinition: PROTOCOL.activeWallDefinition,
        phases,
        activeWallMs,
        activeWallRatioCandidateOverBaseline: activeWallMs.candidate / activeWallMs.baseline,
        conditionWallMs,
        baseline: baselineSummary,
        candidate: candidateSummary,
        comparison,
        bootstrap: bootstrapSummary,
        gates,
    };
    return report;
}

async function runCondition(options: Parameters<typeof runConditionCore>[0]): Promise<Record<string, unknown>> {
    const conditionDir = join(options.outputDir, `c${options.concurrency}`);
    mkdirSync(conditionDir, { recursive: true });
    const baselineBefore = sourceSeal(options.baselineRoot);
    const candidateBefore = sourceSeal(options.candidateRoot);
    const runnerBefore = runnerSeal();
    assertVariantSourceSeal(baselineBefore, "baseline", `c${options.concurrency} preflight`);
    assertVariantSourceSeal(candidateBefore, "candidate", `c${options.concurrency} preflight`);

    let report: Record<string, unknown> | undefined;
    let executionError: unknown;
    try {
        report = await runConditionCore(options);
    } catch (error) {
        executionError = error;
    }

    const baselineAfter = sourceSeal(options.baselineRoot);
    const candidateAfter = sourceSeal(options.candidateRoot);
    const runnerAfter = runnerSeal();
    const integrity = integrityComparison({
        baselineBefore,
        baselineAfter,
        candidateBefore,
        candidateAfter,
        runnerBefore,
        runnerAfter,
    });
    writeJson(join(conditionDir, "integrity-final.json"), integrity);

    let integrityError: unknown;
    try {
        assertVariantSourceSeal(baselineAfter, "baseline", `c${options.concurrency} postflight`);
        assertVariantSourceSeal(candidateAfter, "candidate", `c${options.concurrency} postflight`);
        if (integrity.exact !== true) throw new Error(`c${options.concurrency} source/runner integrity changed`);
    } catch (error) {
        integrityError = error;
    }
    if (executionError !== undefined && integrityError !== undefined) {
        throw new AggregateError(
            [executionError, integrityError],
            `c${options.concurrency} execution and source/runner integrity both failed`,
        );
    }
    if (integrityError !== undefined) throw integrityError;
    if (executionError !== undefined) throw executionError;
    if (!report) throw new Error(`c${options.concurrency} completed without a report`);

    const finalized = { ...report, integrity };
    writeJson(join(conditionDir, "summary.json"), finalized);
    return finalized;
}

function runtimeSeal(): Record<string, unknown> {
    return {
        bunVersion: Bun.version,
        platform: platform(),
        osRelease: release(),
        cpuModel: cpus()[0]?.model ?? "unknown",
        logicalCpuCount: cpus().length,
        totalMemoryBytes: totalmem(),
        argv: process.argv,
    };
}

function parseConcurrency(value: string): number[] {
    const values = value.split(",").map((entry) => Number(entry.trim()));
    if (!values.length || values.some((entry) => ![1, 4, 12].includes(entry))) {
        throw new Error("--concurrency must be one or more of 1,4,12");
    }
    return [...new Set(values)];
}

async function runPanel(args: string[]): Promise<void> {
    const { values } = parseArgs({
        args,
        options: {
            "baseline-root": { type: "string" },
            "candidate-root": { type: "string" },
            out: { type: "string" },
            concurrency: { type: "string", default: "1,4,12" },
            smoke: { type: "boolean", default: false },
            "skip-warmup": { type: "boolean", default: false },
        },
        strict: true,
        allowPositionals: false,
    });
    if (!values["baseline-root"] || !values["candidate-root"] || !values.out) {
        throw new Error("run requires --baseline-root, --candidate-root, and --out");
    }
    const baselineRoot = requireRoot(values["baseline-root"]);
    const candidateRoot = requireRoot(values["candidate-root"]);
    const smoke = values.smoke === true;
    const skipWarmup = values["skip-warmup"] === true;
    if (skipWarmup && !smoke) {
        throw new Error("--skip-warmup is smoke-only; every full-evidence run must execute the frozen warmup");
    }
    const outputDir = resolve(values.out);
    ensureFreshDirectory(outputDir);
    const runnerBefore = runnerSeal();
    const protocolSha256 = digest(PROTOCOL);
    writeJson(join(outputDir, "protocol.json"), { ...PROTOCOL, protocolSha256 });
    const [baselineSealBefore, candidateSealBefore] = await Promise.all([
        Promise.resolve(sourceSeal(baselineRoot)),
        Promise.resolve(sourceSeal(candidateRoot)),
    ]);
    assertVariantSourceSeal(baselineSealBefore, "baseline", "panel preflight");
    assertVariantSourceSeal(candidateSealBefore, "candidate", "panel preflight");
    const isolation = sourceIsolation(baselineRoot, candidateRoot);
    const sourceTreeIdentity = {
        expectedBaselineSrcTreeManifestSha256: EXPECTED_BASELINE_SRC_TREE_MANIFEST_SHA256,
        actualBaselineSrcTreeManifestSha256: baselineSealBefore.srcTreeManifestSha256,
        expectedCandidateSrcTreeManifestSha256: EXPECTED_CANDIDATE_SRC_TREE_MANIFEST_SHA256,
        actualCandidateSrcTreeManifestSha256: candidateSealBefore.srcTreeManifestSha256,
        exact:
            baselineSealBefore.srcTreeManifestSha256 === EXPECTED_BASELINE_SRC_TREE_MANIFEST_SHA256 &&
            candidateSealBefore.srcTreeManifestSha256 === EXPECTED_CANDIDATE_SRC_TREE_MANIFEST_SHA256,
    };
    if (isolation.exactExpectedTwoFileOverlay !== true || !sourceTreeIdentity.exact) {
        throw new Error(
            `Source isolation failed; expected the frozen f02e source trees and exact two-file overlay: ${canonicalJson({ isolation, sourceTreeIdentity })}`,
        );
    }
    const plan = await buildPlan(candidateRoot);
    writeJson(join(outputDir, "plan.json"), plan);
    const tasks = smoke ? plan.tasks.slice(0, 2) : plan.tasks;
    const concurrencies = smoke ? [1] : parseConcurrency(values.concurrency);
    const manifest = {
        schema: SCHEMA,
        createdAt: new Date().toISOString(),
        mode: smoke ? "smoke" : "full-evidence",
        protocolSha256,
        planSha256: plan.planSha256,
        source: {
            baseline: baselineSealBefore,
            candidate: candidateSealBefore,
            isolation,
            sourceTreeIdentity,
            runnerBefore,
            dependencySeal: {
                sealed: false,
                limitation: "node_modules and dependency-lock contents are not hashed",
            },
        },
        runtime: runtimeSeal(),
        selectedConcurrencies: concurrencies,
        selectedTasksPerVariant: tasks.length,
        skipWarmup,
    };
    writeJson(join(outputDir, "manifest.json"), manifest);
    const reports: Record<string, unknown>[] = [];
    let executionError: unknown;
    try {
        for (const concurrency of concurrencies) {
            reports.push(
                await runCondition({
                    concurrency,
                    baselineRoot,
                    candidateRoot,
                    outputDir,
                    plan,
                    tasks,
                    skipWarmup,
                }),
            );
        }
    } catch (error) {
        executionError = error;
    }
    const [baselineSealAfter, candidateSealAfter] = await Promise.all([
        Promise.resolve(sourceSeal(baselineRoot)),
        Promise.resolve(sourceSeal(candidateRoot)),
    ]);
    const runnerAfter = runnerSeal();
    const integrity = integrityComparison({
        baselineBefore: baselineSealBefore,
        baselineAfter: baselineSealAfter,
        candidateBefore: candidateSealBefore,
        candidateAfter: candidateSealAfter,
        runnerBefore,
        runnerAfter,
    });
    writeJson(join(outputDir, "integrity-final.json"), integrity);
    assertVariantSourceSeal(baselineSealAfter, "baseline", "panel postflight");
    assertVariantSourceSeal(candidateSealAfter, "candidate", "panel postflight");
    if (integrity.exact !== true) throw new Error(`Panel source/runner integrity changed during execution`);
    if (executionError !== undefined) throw executionError;
    const summary = {
        schema: SCHEMA,
        completedAt: new Date().toISOString(),
        mode: smoke ? "smoke" : "full-evidence",
        protocolSha256,
        planSha256: plan.planSha256,
        integrity,
        reports,
        allConditionsQualified:
            !smoke && reports.every((report) => (report.gates as { qualified?: boolean }).qualified),
    };
    writeJson(join(outputDir, "summary.json"), summary);
    console.log(`wrote ${join(outputDir, "summary.json")}`);
}

async function planOnly(args: string[]): Promise<void> {
    const { values } = parseArgs({
        args,
        options: { root: { type: "string" }, out: { type: "string" } },
        strict: true,
        allowPositionals: false,
    });
    if (!values.root || !values.out) throw new Error("plan requires --root and --out");
    const path = resolve(values.out);
    if (existsSync(path)) throw new Error(`Refusing to overwrite plan: ${path}`);
    mkdirSync(dirname(path), { recursive: true });
    const sourceBefore = sourceSeal(values.root);
    const runnerBefore = runnerSeal();
    assertVariantSourceSeal(sourceBefore, "candidate", "plan preflight");
    const plan = await buildPlan(values.root);
    const sourceAfter = sourceSeal(values.root);
    const runnerAfter = runnerSeal();
    assertVariantSourceSeal(sourceAfter, "candidate", "plan postflight");
    if (
        digest(sourceSealIdentity(sourceBefore)) !== digest(sourceSealIdentity(sourceAfter)) ||
        runnerBefore.sha256 !== runnerAfter.sha256
    ) {
        throw new Error("Plan source/runner integrity changed during generation");
    }
    writeJson(path, plan);
    console.log(`plan clusters=${plan.clusters.length} tasks=${plan.tasks.length} sha256=${plan.planSha256}`);
}

async function profileVariant(args: string[]): Promise<void> {
    const { values } = parseArgs({
        args,
        options: {
            root: { type: "string" },
            variant: { type: "string" },
            out: { type: "string" },
            capture: { type: "string" },
        },
        strict: true,
        allowPositionals: false,
    });
    if (!values.root || !values.variant || !values.out || !values.capture) {
        throw new Error("profile-variant requires --root, --variant baseline|candidate, --capture 1|2|3, and --out");
    }
    if (values.variant !== "baseline" && values.variant !== "candidate") {
        throw new Error("--variant must be baseline or candidate");
    }
    const capture = Number(values.capture);
    if (!Number.isInteger(capture) || capture < 1 || capture > PROTOCOL.cpuProfile.capturesPerVariant) {
        throw new Error(`--capture must be 1..${PROTOCOL.cpuProfile.capturesPerVariant}`);
    }
    const variant = values.variant;
    const root = requireRoot(values.root);
    const output = resolve(values.out);
    if (existsSync(output)) throw new Error(`Refusing to overwrite profile result: ${output}`);
    mkdirSync(dirname(output), { recursive: true });
    const sourceBefore = sourceSeal(root);
    const runnerBefore = runnerSeal();
    assertVariantSourceSeal(sourceBefore, variant, "profile preflight");
    const loaded = await loadVariant(root, false);
    const army = await importFrom<{
        buildRoster: (rng: () => number) => unknown[];
        makeRng: (seed: number) => () => number;
    }>(root, "src/simulation/army.ts");
    const runSeed = (seed: number, maxLaps: number): Record<string, unknown> =>
        loaded.runMatch({
            greenVersion: EXPECTED_VERSION,
            redVersion: EXPECTED_VERSION,
            roster: army.buildRoster(army.makeRng(seed)),
            seed,
            maxLaps,
        });
    const warmupStarted = performance.now();
    const warmupResult = runSeed(PROFILE_WARMUP_SEED, 2);
    const warmupWallMs = performance.now() - warmupStarted;
    const started = performance.now();
    const repeats: Array<Record<string, unknown>> = [];
    const allResults: Record<string, unknown>[] = [];
    for (let repeat = 0; repeat < PROTOCOL.cpuProfile.repeats; repeat += 1) {
        const results = PROFILE_SEEDS.map((seed) => runSeed(seed, PROFILE_MAX_LAPS));
        const actions = results.reduce((sum, result) => sum + Number(result.totalActions ?? 0), 0);
        const rejected = results.reduce(
            (sum, result) => sum + Number(result.rejectedGreen ?? 0) + Number(result.rejectedRed ?? 0),
            0,
        );
        const repeatDigest = sha256(JSON.stringify(results));
        if (actions !== PROFILE_ACTIONS_PER_REPEAT || rejected !== 0 || repeatDigest !== PROFILE_DIGEST_PER_REPEAT) {
            throw new Error(
                `Profile corpus drift at repeat ${repeat}: actions=${actions}, rejected=${rejected}, digest=${repeatDigest}`,
            );
        }
        repeats.push({ repeat, actions, rejected, digest: repeatDigest });
        allResults.push(...results);
    }
    const wallMs = performance.now() - started;
    const measuredActions = allResults.reduce((sum, result) => sum + Number(result.totalActions ?? 0), 0);
    if (measuredActions !== PROFILE_ACTIONS_PER_REPEAT * PROTOCOL.cpuProfile.repeats) {
        throw new Error(`Profile accepted-action total drifted: ${measuredActions}`);
    }
    const sourceAfter = sourceSeal(root);
    const runnerAfter = runnerSeal();
    assertVariantSourceSeal(sourceAfter, variant, "profile postflight");
    const sourceUnchanged = digest(sourceSealIdentity(sourceBefore)) === digest(sourceSealIdentity(sourceAfter));
    const runnerUnchanged = runnerBefore.sha256 === runnerAfter.sha256;
    if (!sourceUnchanged || !runnerUnchanged) {
        throw new Error("Profile source/runner integrity changed during execution");
    }
    const report = {
        schema: SCHEMA,
        profileProtocol: PROTOCOL.cpuProfile,
        capture,
        variant,
        source: {
            expectedVariant: variant,
            expectedSrcTreeManifestSha256: expectedSourceTreeManifest(variant),
            before: sourceBefore,
            after: sourceAfter,
            sourceUnchanged,
            runnerBefore,
            runnerAfter,
            runnerUnchanged,
            dependencySeal: {
                sealed: false,
                limitation: "node_modules and dependency-lock contents are not hashed",
            },
        },
        runtime: runtimeSeal(),
        warmup: {
            seed: PROFILE_WARMUP_SEED,
            maxLaps: 2,
            wallMs: warmupWallMs,
            actions: Number(warmupResult.totalActions ?? 0),
            digest: sha256(JSON.stringify(warmupResult)),
        },
        measuredMatches: allResults.length,
        measuredActions,
        wallMs,
        workloadDigest: sha256(JSON.stringify(allResults)),
        repeats,
    };
    writeJson(output, report);
    console.log(
        `profile workload variant=${variant} matches=${allResults.length} actions=${report.measuredActions} wallMs=${wallMs}`,
    );
}

function usage(): string {
    return [
        "Usage:",
        "  bun docs/evidence/tools/a13_latency_panel.ts plan --root ROOT --out plan.json",
        "  bun docs/evidence/tools/a13_latency_panel.ts run --baseline-root ROOT --candidate-root ROOT --out DIR [--concurrency 1,4,12] [--smoke [--skip-warmup]]",
        "  bun [--cpu-prof flags] docs/evidence/tools/a13_latency_panel.ts profile-variant --root ROOT --variant baseline|candidate --capture 1|2|3 --out result.json",
    ].join("\n");
}

async function cliMain(): Promise<void> {
    const [command, ...args] = process.argv.slice(2);
    if (command === "plan") return planOnly(args);
    if (command === "run") return runPanel(args);
    if (command === "profile-variant") return profileVariant(args);
    console.error(usage());
    process.exitCode = command === "--help" || command === "-h" ? 0 : 2;
}

if (!isMainThread) {
    const init = workerData as IWorkerInit;
    if (init?.kind !== "panel-worker") throw new Error("Unknown a13 latency-panel worker payload");
    await workerMain(init);
} else {
    await cliMain();
}
