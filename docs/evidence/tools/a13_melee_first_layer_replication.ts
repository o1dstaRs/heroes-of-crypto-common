#!/usr/bin/env bun

/**
 * Strict six-capture aggregation gate for the A13 melee first-layer elision optimization.
 *
 * This runner never executes a match. It accepts exactly the six independently sealed pair reports
 * preregistered in ../a13_melee_first_layer_replication_protocol_2026-07-23.json, verifies every source,
 * runner, profile, schedule, semantic, and fixed-work invariant, then evaluates the order-balanced
 * robust estimator and deterministic crossed capture/seed bootstrap.
 *
 * Example:
 *   bun docs/evidence/tools/a13_melee_first_layer_replication.ts \
 *     --r0=/tmp/r0.json --r1=/tmp/r1.json --r2=/tmp/r2.json \
 *     --r3=/tmp/r3.json --r4=/tmp/r4.json --r5=/tmp/r5.json \
 *     --out=/tmp/a13-melee-first-layer-replication.json
 */

import { createHash } from "node:crypto";
import {
    existsSync,
    linkSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const SCHEMA = "heroes-of-crypto/a13-melee-first-layer-replication/v1" as const;
const CAPTURE_SCHEMA = "heroes-of-crypto/a13-melee-first-layer-pair/v1" as const;
const PROTOCOL_SCHEMA = "heroes-of-crypto/a13-melee-first-layer-replication-protocol/v1" as const;
const PROTOCOL_DATE = "2026-07-23" as const;
const BASELINE_COMMIT = "188452cad6ec718540b7c452a579ac3cea73a67f";
const CANDIDATE_COMMIT = "ce6719c37f2c6e56b95abdf9cbc2a966db5169a4";
const BASELINE_SRC_MANIFEST_SHA256 = "73f78af822eace14fbe63c22115922732e0255b431a24403bc8ec794aaf98369";
const BASELINE_AI_SHA256 = "02f56c80806b28b29e393c07d77a83ebeb532b780440bc59897673b8268efe7d";
const BASELINE_DECISION_PATH_CATALOG_SHA256 = "03ca1f30bde3cf2177b1e6d0a5c86036fd08878f444b90fc497885c685096c7d";
const BASELINE_MODULE_SHA256 = "18114a5eb7205de721b2cd6788445b0c8ac352759d017b112813e177a9ebe069";
const CANDIDATE_SRC_MANIFEST_SHA256 = "1d6d25cf78d6c415b2492d3a8a7dcb033b920bb9a42030c588b785a94af1c15f";
const CANDIDATE_AI_SHA256 = "84b1dee9f7178c195ac25cbc5f01b62b093cce3981883f1543fec99165dbc9c4";
const CANDIDATE_DECISION_PATH_CATALOG_SHA256 = "f10673fddaf8f09485aed7e272ec894bdb5f50261957895f4d4eb9072a3d502d";
const CANDIDATE_MODULE_SHA256 = "5235aed52cecce8f6c3d9be89dcbc38f76dc46cdb4b34f9042270f05245ed99e";
const PACKAGE_JSON_SHA256 = "990a779e01b64fab88bdb72cb7fd6fa790eabc66a2f550d1e3481d620e1cf001";
const WORKSPACE_LOCK_SHA256 = "227ac3cc87c8488dea87841311baf509e361c22610ffc0ee21c553245e58ab54";
const PREDECESSOR_REPORT_SHA256 = "12a271c5cb190b1e2d7e8c36a7a14e7f09b14740ded08336020c7f3c92c20b9d";
const BOOTSTRAP_SEED = 0xa135_1a9e;
const BOOTSTRAP_SAMPLES = 20_000;
const MAX_LAPS = 2;
const WARMUP_SEED = 0xffff_ffff;
const TASKS_PER_CAPTURE = 80;
const CAPTURE_IDS = ["r0", "r1", "r2", "r3", "r4", "r5"] as const;
const ORIGINAL_CAPTURE_IDS = ["r0", "r2", "r4"] as const;
const INVERTED_CAPTURE_IDS = ["r1", "r3", "r5"] as const;
const NATURAL_SEEDS = Object.freeze(Array.from({ length: 20 }, (_, index) => index + 1));
const NATURAL_GRID_TYPES = Object.freeze([1, 2, 3, 4]);
const RUNNER_PATH = fileURLToPath(import.meta.url);
const PROTOCOL_PATH = resolve(dirname(RUNNER_PATH), "../a13_melee_first_layer_replication_protocol_2026-07-23.json");
const EXPECTED_SCRUBBED_ENVIRONMENT_PREFIXES = Object.freeze([
    "SEARCH_",
    "V04_",
    "V05_",
    "V06_",
    "V07_",
    "V08_",
    "Q2_",
    "SIM_",
]);
const EXPECTED_EXACT_GOVERNED_ENVIRONMENT_KEYS = Object.freeze([
    "LIVETWIN",
    "FIGHT_MELEE_ROSTERS",
    "FORCE_CREATURES",
    "COHORT",
    "ROSTER_RANGED_MIN",
    "ROSTER_RANGED_MAX",
    "ROSTER_FLYER_MIN",
    "ROSTER_FLYER_MAX",
    "ROSTER_CASTER_MIN",
    "ROSTER_CASTER_MAX",
    "VALUE_DATA",
    "VALUE_DATA_FEATURES",
    "PHASE_B_RUN_FINGERPRINT",
]);
const EXPECTED_FIXED_ENVIRONMENT_OVERRIDES = Object.freeze(
    Object.entries({
        V08_A13_SEARCH: "0",
        V07_SEARCH: "1",
        Q2_ORACLE: null,
        Q2_WAIT_ABLATION: null,
        SEARCH_DECISION_DEADLINE_MS: null,
        SEARCH_CIRCUIT_BREAKER_MS: null,
        LIVETWIN: "1",
        FIGHT_MELEE_ROSTERS: "0",
        V04_BOXHOLD: null,
        V04_FRONTLINE: null,
        V04_FRONTMOVE: null,
        V04_BUFFWAIT: null,
        V04_BEHESELF: null,
        V04_OGRESELF: null,
        V04_MVGUARD: null,
        V04_FHUNT2: null,
        V04_TROLL: null,
        FORCE_CREATURES: null,
        COHORT: null,
        ROSTER_RANGED_MIN: null,
        ROSTER_RANGED_MAX: null,
        ROSTER_FLYER_MIN: null,
        ROSTER_FLYER_MAX: null,
        ROSTER_CASTER_MIN: null,
        ROSTER_CASTER_MAX: null,
        VALUE_DATA: null,
        VALUE_DATA_FEATURES: null,
        PHASE_B_RUN_FINGERPRINT: null,
    })
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => ({ key, value })),
);
const EXPECTED_ENVIRONMENT_ISOLATION = Object.freeze({
    scrubbedPrefixes: EXPECTED_SCRUBBED_ENVIRONMENT_PREFIXES,
    exactGovernedKeys: EXPECTED_EXACT_GOVERNED_ENVIRONMENT_KEYS,
    fixedOverrides: EXPECTED_FIXED_ENVIRONMENT_OVERRIDES,
    startupScrubVerified: true,
    entryAndExitVerified: true,
    inheritedValuesAbsentOrOverriddenAtEveryBoundary: true,
    scopedCallbacks: {
        moduleLoads: 2,
        searchSelectionChecks: 2,
        rosterBuilds: (TASKS_PER_CAPTURE + NATURAL_GRID_TYPES.length) * 2,
        matches: (TASKS_PER_CAPTURE + NATURAL_GRID_TYPES.length) * 2,
    },
    boundaryAssertions: (2 + 2 + (TASKS_PER_CAPTURE + NATURAL_GRID_TYPES.length) * 4) * 2,
});

type CaptureId = (typeof CAPTURE_IDS)[number];
type TaskOrder = "AB" | "BA";

interface ICaptureSchedule {
    id: CaptureId;
    seeds: number[];
    gridTypes: number[];
    invertOrder: boolean;
}

const CAPTURE_SCHEDULES: readonly ICaptureSchedule[] = Object.freeze([
    {
        id: "r0",
        seeds: [...NATURAL_SEEDS],
        gridTypes: [1, 2, 3, 4],
        invertOrder: false,
    },
    {
        id: "r1",
        seeds: [...NATURAL_SEEDS].reverse(),
        gridTypes: [4, 3, 2, 1],
        invertOrder: true,
    },
    {
        id: "r2",
        seeds: [...NATURAL_SEEDS.slice(5), ...NATURAL_SEEDS.slice(0, 5)],
        gridTypes: [2, 3, 4, 1],
        invertOrder: false,
    },
    {
        id: "r3",
        seeds: [...NATURAL_SEEDS.slice(0, 5)].reverse().concat([...NATURAL_SEEDS.slice(5)].reverse()),
        gridTypes: [1, 4, 3, 2],
        invertOrder: true,
    },
    {
        id: "r4",
        seeds: [...NATURAL_SEEDS.slice(10), ...NATURAL_SEEDS.slice(0, 10)],
        gridTypes: [3, 4, 1, 2],
        invertOrder: false,
    },
    {
        id: "r5",
        seeds: [...NATURAL_SEEDS.slice(0, 10)].reverse().concat([...NATURAL_SEEDS.slice(10)].reverse()),
        gridTypes: [2, 1, 4, 3],
        invertOrder: true,
    },
]);

const EXPECTED_RUNTIME_DELTA = Object.freeze([
    {
        path: "ai/ai.ts",
        change: "modified",
        baselineSha256: BASELINE_AI_SHA256,
        candidateSha256: CANDIDATE_AI_SHA256,
    },
    {
        path: "ai/decision_path_catalog.ts",
        change: "modified",
        baselineSha256: BASELINE_DECISION_PATH_CATALOG_SHA256,
        candidateSha256: CANDIDATE_DECISION_PATH_CATALOG_SHA256,
    },
    {
        path: "ai/internal/melee_target_layers.ts",
        change: "modified",
        baselineSha256: BASELINE_MODULE_SHA256,
        candidateSha256: CANDIDATE_MODULE_SHA256,
    },
]);

const EXPECTED_GATES = Object.freeze({
    exactTaskPairs: 480,
    semanticMismatches: 0,
    rejectedActions: 0,
    stuckMatches: 0,
    exceptions: 0,
    totalRatioBootstrapUpper95Maximum: 0.99,
    geometricRatioBootstrapUpper95MaximumExclusive: 1,
    robustP50MaximumExclusive: 1,
    robustP99MaximumExclusive: 1,
    robustP99BootstrapUpper95Maximum: 1.05,
    minimumRobustFasterTasks: 79,
    robustMaximumRatio: 1.05,
    orderTotalBootstrapUpper95MaximumExclusive: 1,
    perMapTotalRatioMaximum: 1.05,
    minimumFasterCaptures: 5,
    captureTotalRatioMaximum: 1.05,
});

const EXPECTED_BOOTSTRAP_UNIT =
    "crossed resampling of three original-order captures, three inverse-order captures, and twenty seed clusters; all four maps retained";

const EXPECTED_SCHEDULE_RULE = Object.freeze({
    defaultOrder: "AB when (seed-list index + grid-list index) is even, otherwise BA",
    inversion: "--invert-order flips every measured and warmup AB/BA pair",
    balance:
        "Every (seed,map) task has exactly three AB and three BA observations. Traversal pairs r0/r1, r2/r3, and r4/r5 are exact reversals.",
});

const EXPECTED_ESTIMATOR = Object.freeze({
    perTask: "sqrt(median(three AB candidate/baseline ratios) * median(three BA candidate/baseline ratios))",
    quantile: "Type-7 linear interpolation at p50, p95, and p99",
    bootstrap:
        "20,000 deterministic replicates. Resample three captures with replacement inside each inversion stratum and twenty seeds with replacement; retain all four maps.",
    interval: "Type-7 percentile interval [2.5%, 97.5%]",
    rawDataPolicy: "Retain every observation. Do not trim, winsorize, selectively rerun, or remove the slowest rows.",
});

const EXPECTED_STOPPING_RULE = Object.freeze({
    validCaptures: "Run exactly r0 through r5; do not add captures after inspecting performance.",
    hostInvalidation:
        "Only an independently recorded, predeclared host-attestation failure may invalidate a complete capture. Retain the invalid artifact and permit at most one full-capture replacement attempt.",
    semanticOrSourceFailure:
        "A source, runner, profile, semantic, rejection, stuck, or exception failure ends the protocol; it is not replaceable.",
    performanceFailure:
        "Any failed performance gate after r5 leaves the optimization unqualified. Never rerun only a slow task.",
    r0ExitHandling:
        "R0 may exit nonzero after atomically writing a valid report when its legacy standalone performance gate fails. Continue only if that report exists and passes this aggregator; any pre-report failure stops the protocol.",
    operatorAttestation:
        "This offline aggregator cannot prove the absence of shadow attempts or establish chronology. Commit the protocol and runners before R0 and retain an external append-only attempt ledger with every artifact hash.",
});

interface IFileSeal {
    path: string;
    realPath: string;
    bytes: number;
    sha256: string;
}

interface IProtocol {
    schema: typeof PROTOCOL_SCHEMA;
    protocolDate: typeof PROTOCOL_DATE;
    status: string;
    baseline: {
        commit: string;
        srcTreeManifestSha256: string;
        aiSha256: string;
        decisionPathCatalogSha256: string;
        meleeTargetLayersSha256: string;
    };
    candidate: {
        commit: string;
        srcTreeManifestSha256: string;
        aiSha256: string;
        decisionPathCatalogSha256: string;
        meleeTargetLayersSha256: string;
    };
    runtimeDelta: typeof EXPECTED_RUNTIME_DELTA;
    dependencyInputs: {
        packageJsonSha256: string;
        workspaceLockSha256: string;
        installedDependencyContentsSealed: false;
        limitation: string;
    };
    predecessorEvidence: {
        reportSha256: string;
        disposition: string;
        relationship: string;
    };
    captureRunner: {
        schema: typeof CAPTURE_SCHEMA;
        sha256: string;
    };
    aggregationRunner: {
        schema: typeof SCHEMA;
        sha256: string;
    };
    fixedWork: {
        aiVersion: string;
        captureCount: number;
        tasksPerCapture: number;
        totalTaskPairs: number;
        maxLaps: number;
        warmupSeed: number;
        bootstrapSeed: number;
        bootstrapSamples: number;
        bootstrapUnit: string;
    };
    captures: ICaptureSchedule[];
    scheduleRule: typeof EXPECTED_SCHEDULE_RULE;
    estimator: typeof EXPECTED_ESTIMATOR;
    gates: typeof EXPECTED_GATES;
    stoppingRule: typeof EXPECTED_STOPPING_RULE;
}

interface ICaptureRow {
    ordinal: number;
    order: TaskOrder;
    seed: number;
    gridType: number;
    baselineNs: number;
    candidateNs: number;
    ratio: number;
    baselineTotalActions: number;
    candidateTotalActions: number;
    resultSha256: string;
    candidateResultSha256: string;
    actionsSha256: string;
    candidateActionsSha256: string;
    placementsSha256: string;
    candidatePlacementsSha256: string;
    rosterSha256: string;
    candidateRosterSha256: string;
    endReason: string;
    candidateEndReason: string;
    exact: true;
}

interface IValidatedCapture {
    id: CaptureId;
    schedule: ICaptureSchedule;
    file: IFileSeal;
    report: Record<string, unknown>;
    rows: ICaptureRow[];
    rowsByTask: Map<string, ICaptureRow>;
    sourceIdentity: unknown;
    profileIdentity: unknown;
    hostIdentity: unknown;
    semanticIdentityByTask: Map<string, unknown>;
}

interface IRobustTask {
    seed: number;
    gridType: number;
    abRatios: [number, number, number];
    baRatios: [number, number, number];
    medianAbRatio: number;
    medianBaRatio: number;
    robustRatio: number;
}

interface IBootstrapDistribution {
    totalRatio: number[];
    geometricRatio: number[];
    robustP99: number[];
    abTotalRatio: number[];
    baTotalRatio: number[];
}

interface ISearchCounters {
    decisionsObserved: number;
    catalogsObserved: number;
    requests: number;
    hits: number;
    misses: number;
    bypasses: number;
}

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

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
            .sort((left, right) => JSON.stringify(left[0]).localeCompare(JSON.stringify(right[0])));
    }
    if (value instanceof Set) {
        return [...value.values()]
            .map(canonicalize)
            .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
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
const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
const taskKey = (seed: number, gridType: number): string => `${seed}:${gridType}`;

function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
    if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
    return value;
}

function requireString(value: unknown, label: string): string {
    if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
    return value;
}

function requireBoolean(value: unknown, label: string): boolean {
    if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
    return value;
}

function requireFiniteNumber(value: unknown, label: string, minimum?: number): number {
    if (typeof value !== "number" || !Number.isFinite(value) || (minimum !== undefined && value < minimum)) {
        throw new Error(`${label} must be a finite number${minimum === undefined ? "" : ` >= ${minimum}`}`);
    }
    return value;
}

function requireInteger(value: unknown, label: string, minimum = 0): number {
    const parsed = requireFiniteNumber(value, label, minimum);
    if (!Number.isSafeInteger(parsed)) throw new Error(`${label} must be a safe integer`);
    return parsed;
}

function requireSha256(value: unknown, label: string): string {
    const parsed = requireString(value, label);
    if (!/^[0-9a-f]{64}$/.test(parsed)) throw new Error(`${label} must be a lowercase SHA-256`);
    return parsed;
}

function requireEndReason(value: unknown, label: string): "elimination" | "turn_cap" {
    const parsed = requireString(value, label);
    if (parsed !== "elimination" && parsed !== "turn_cap") {
        throw new Error(`${label} must be elimination or turn_cap`);
    }
    return parsed;
}

function validateSearchCounters(value: unknown, label: string): ISearchCounters {
    const raw = requireRecord(value, label);
    const counters = {
        decisionsObserved: requireInteger(raw.decisionsObserved, `${label}.decisionsObserved`, 1),
        catalogsObserved: requireInteger(raw.catalogsObserved, `${label}.catalogsObserved`, 1),
        requests: requireInteger(raw.requests, `${label}.requests`, 1),
        hits: requireInteger(raw.hits, `${label}.hits`),
        misses: requireInteger(raw.misses, `${label}.misses`),
        bypasses: requireInteger(raw.bypasses, `${label}.bypasses`),
    };
    if (counters.decisionsObserved !== counters.catalogsObserved) {
        throw new Error(`${label} decision/catalog counts differ`);
    }
    if (counters.requests !== counters.hits + counters.misses + counters.bypasses) {
        throw new Error(`${label} request accounting is inconsistent`);
    }
    return counters;
}

function sumSearchCounters(values: readonly ISearchCounters[]): ISearchCounters {
    return values.reduce<ISearchCounters>(
        (total, value) => ({
            decisionsObserved: total.decisionsObserved + value.decisionsObserved,
            catalogsObserved: total.catalogsObserved + value.catalogsObserved,
            requests: total.requests + value.requests,
            hits: total.hits + value.hits,
            misses: total.misses + value.misses,
            bypasses: total.bypasses + value.bypasses,
        }),
        {
            decisionsObserved: 0,
            catalogsObserved: 0,
            requests: 0,
            hits: 0,
            misses: 0,
            bypasses: 0,
        },
    );
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
    if (canonicalJson(actual) !== canonicalJson(expected)) {
        throw new Error(`${label} mismatch: expected=${canonicalJson(expected)} actual=${canonicalJson(actual)}`);
    }
}

function fileSeal(pathInput: string): IFileSeal {
    const path = resolve(pathInput);
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Missing input file: ${path}`);
    const bytes = readFileSync(path);
    return {
        path,
        realPath: realpathSync(path),
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
    };
}

function writeJsonAtomicExclusive(pathInput: string, value: unknown): void {
    const path = resolve(pathInput);
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) throw new Error(`Refusing to overwrite output: ${path}`);
    const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    try {
        linkSync(temporary, path);
    } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
    }
}

function expectedOrder(seedIndex: number, gridIndex: number, invertOrder: boolean): TaskOrder {
    const normal: TaskOrder = (seedIndex + gridIndex) % 2 === 0 ? "AB" : "BA";
    return invertOrder ? (normal === "AB" ? "BA" : "AB") : normal;
}

function expectedWarmupOrder(gridIndex: number, invertOrder: boolean): TaskOrder {
    const normal: TaskOrder = gridIndex % 2 === 0 ? "AB" : "BA";
    return invertOrder ? (normal === "AB" ? "BA" : "AB") : normal;
}

function printHelp(): void {
    console.log(`A13 canonical melee first-layer six-capture replication gate

Usage:
  bun docs/evidence/tools/a13_melee_first_layer_replication.ts \\
    --r0=REPORT --r1=REPORT --r2=REPORT --r3=REPORT --r4=REPORT --r5=REPORT \\
    --out=AGGREGATE.json

Exactly six reports are accepted. Their schedules, source delta, runner/profile seals, semantic traces,
fixed work, bootstrap, and all qualification gates are frozen by the dated protocol manifest.`);
}

function commandLine(): { captures: Record<CaptureId, string>; out: string } | undefined {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        strict: true,
        allowPositionals: false,
        options: {
            help: { type: "boolean", default: false },
            r0: { type: "string" },
            r1: { type: "string" },
            r2: { type: "string" },
            r3: { type: "string" },
            r4: { type: "string" },
            r5: { type: "string" },
            out: { type: "string" },
        },
    });
    if (values.help) {
        printHelp();
        return undefined;
    }
    if (!values.out?.trim()) throw new Error("--out is required");
    const captures = {} as Record<CaptureId, string>;
    for (const id of CAPTURE_IDS) {
        const path = values[id];
        if (!path?.trim()) throw new Error(`--${id} is required`);
        captures[id] = resolve(path);
    }
    const realPaths = CAPTURE_IDS.map((id) => fileSeal(captures[id]).realPath);
    if (new Set(realPaths).size !== CAPTURE_IDS.length) {
        throw new Error("The six capture paths must resolve to six distinct files");
    }
    const out = resolve(values.out);
    if (existsSync(out)) throw new Error(`Refusing to overwrite output: ${out}`);
    return { captures, out };
}

function loadProtocol(): { protocol: IProtocol; seal: IFileSeal } {
    const seal = fileSeal(PROTOCOL_PATH);
    const raw = requireRecord(JSON.parse(readFileSync(PROTOCOL_PATH, "utf8")), "protocol");
    assertEqual(raw.schema, PROTOCOL_SCHEMA, "protocol.schema");
    assertEqual(raw.protocolDate, PROTOCOL_DATE, "protocol.protocolDate");
    assertEqual(raw.status, "preregistered-before-six-capture-replication", "protocol.status");
    const baseline = requireRecord(raw.baseline, "protocol.baseline");
    assertEqual(baseline.commit, BASELINE_COMMIT, "protocol baseline commit");
    assertEqual(baseline.srcTreeManifestSha256, BASELINE_SRC_MANIFEST_SHA256, "protocol baseline src manifest");
    assertEqual(baseline.aiSha256, BASELINE_AI_SHA256, "protocol baseline ai hash");
    assertEqual(
        baseline.decisionPathCatalogSha256,
        BASELINE_DECISION_PATH_CATALOG_SHA256,
        "protocol baseline catalog hash",
    );
    assertEqual(baseline.meleeTargetLayersSha256, BASELINE_MODULE_SHA256, "protocol baseline melee-target module hash");
    const candidate = requireRecord(raw.candidate, "protocol.candidate");
    assertEqual(candidate.commit, CANDIDATE_COMMIT, "protocol candidate commit");
    assertEqual(candidate.srcTreeManifestSha256, CANDIDATE_SRC_MANIFEST_SHA256, "protocol candidate src manifest");
    assertEqual(candidate.aiSha256, CANDIDATE_AI_SHA256, "protocol candidate ai hash");
    assertEqual(
        candidate.decisionPathCatalogSha256,
        CANDIDATE_DECISION_PATH_CATALOG_SHA256,
        "protocol candidate catalog hash",
    );
    assertEqual(candidate.meleeTargetLayersSha256, CANDIDATE_MODULE_SHA256, "protocol candidate module hash");
    assertEqual(raw.runtimeDelta, EXPECTED_RUNTIME_DELTA, "protocol runtime delta");
    const dependencyInputs = requireRecord(raw.dependencyInputs, "protocol.dependencyInputs");
    assertEqual(dependencyInputs.packageJsonSha256, PACKAGE_JSON_SHA256, "protocol package hash");
    assertEqual(dependencyInputs.workspaceLockSha256, WORKSPACE_LOCK_SHA256, "protocol workspace lock hash");
    assertEqual(dependencyInputs.installedDependencyContentsSealed, false, "protocol installed-dependency seal policy");
    requireString(dependencyInputs.limitation, "protocol dependency limitation");
    const predecessor = requireRecord(raw.predecessorEvidence, "protocol.predecessorEvidence");
    assertEqual(predecessor.reportSha256, PREDECESSOR_REPORT_SHA256, "predecessor report hash");
    assertEqual(predecessor.disposition, "qualified-predecessor-baseline-not-pooled", "predecessor report disposition");
    assertEqual(
        predecessor.relationship,
        "Qualified fused-layer evidence for the baseline runtime; retained as provenance and never pooled into this first-layer replication.",
        "predecessor report relationship",
    );
    const captureRunner = requireRecord(raw.captureRunner, "protocol.captureRunner");
    assertEqual(captureRunner.schema, CAPTURE_SCHEMA, "capture runner schema");
    requireSha256(captureRunner.sha256, "protocol.captureRunner.sha256");
    const aggregationRunner = requireRecord(raw.aggregationRunner, "protocol.aggregationRunner");
    assertEqual(aggregationRunner.schema, SCHEMA, "aggregation runner schema");
    requireSha256(aggregationRunner.sha256, "protocol.aggregationRunner.sha256");
    const fixedWork = requireRecord(raw.fixedWork, "protocol.fixedWork");
    assertEqual(
        {
            aiVersion: fixedWork.aiVersion,
            captureCount: fixedWork.captureCount,
            tasksPerCapture: fixedWork.tasksPerCapture,
            totalTaskPairs: fixedWork.totalTaskPairs,
            maxLaps: fixedWork.maxLaps,
            warmupSeed: fixedWork.warmupSeed,
            bootstrapSeed: fixedWork.bootstrapSeed,
            bootstrapSamples: fixedWork.bootstrapSamples,
            bootstrapUnit: fixedWork.bootstrapUnit,
        },
        {
            aiVersion: "v0.8",
            captureCount: 6,
            tasksPerCapture: TASKS_PER_CAPTURE,
            totalTaskPairs: TASKS_PER_CAPTURE * 6,
            maxLaps: MAX_LAPS,
            warmupSeed: WARMUP_SEED,
            bootstrapSeed: BOOTSTRAP_SEED,
            bootstrapSamples: BOOTSTRAP_SAMPLES,
            bootstrapUnit: EXPECTED_BOOTSTRAP_UNIT,
        },
        "protocol fixed work",
    );
    assertEqual(raw.captures, CAPTURE_SCHEDULES, "protocol capture schedules");
    assertEqual(raw.scheduleRule, EXPECTED_SCHEDULE_RULE, "protocol schedule rule");
    assertEqual(raw.estimator, EXPECTED_ESTIMATOR, "protocol estimator");
    assertEqual(raw.gates, EXPECTED_GATES, "protocol gates");
    assertEqual(raw.stoppingRule, EXPECTED_STOPPING_RULE, "protocol stopping rule");
    return { protocol: raw as unknown as IProtocol, seal };
}

function readSemanticRow(row: ICaptureRow): unknown {
    return {
        resultSha256: row.resultSha256,
        actionsSha256: row.actionsSha256,
        placementsSha256: row.placementsSha256,
        rosterSha256: row.rosterSha256,
        endReason: row.endReason,
        totalActions: row.baselineTotalActions,
    };
}

function validateCaptureRow(
    rawValue: unknown,
    captureId: CaptureId,
    ordinal: number,
    seed: number,
    gridType: number,
    order: TaskOrder,
): ICaptureRow {
    const raw = requireRecord(rawValue, `${captureId}.rows[${ordinal}]`);
    assertEqual(raw.ordinal, ordinal, `${captureId} row ordinal`);
    assertEqual(raw.seed, seed, `${captureId} row seed`);
    assertEqual(raw.gridType, gridType, `${captureId} row gridType`);
    assertEqual(raw.order, order, `${captureId} row order`);
    assertEqual(raw.exact, true, `${captureId} row exact`);
    const baselineNs = requireInteger(raw.baselineNs, `${captureId} row baselineNs`, 1);
    const candidateNs = requireInteger(raw.candidateNs, `${captureId} row candidateNs`, 1);
    const ratio = requireFiniteNumber(raw.ratio, `${captureId} row ratio`, 0);
    if (ratio !== candidateNs / baselineNs) {
        throw new Error(`${captureId} row ${ordinal} ratio does not equal candidateNs / baselineNs`);
    }
    const baselineTotalActions = requireInteger(raw.baselineTotalActions, `${captureId} row baselineTotalActions`);
    const candidateTotalActions = requireInteger(raw.candidateTotalActions, `${captureId} row candidateTotalActions`);
    if (baselineTotalActions !== candidateTotalActions) {
        throw new Error(`${captureId} row ${ordinal} action counts differ`);
    }
    const row: ICaptureRow = {
        ordinal,
        order,
        seed,
        gridType,
        baselineNs,
        candidateNs,
        ratio,
        baselineTotalActions,
        candidateTotalActions,
        resultSha256: requireSha256(raw.resultSha256, `${captureId} row resultSha256`),
        candidateResultSha256: requireSha256(raw.candidateResultSha256, `${captureId} row candidateResultSha256`),
        actionsSha256: requireSha256(raw.actionsSha256, `${captureId} row actionsSha256`),
        candidateActionsSha256: requireSha256(raw.candidateActionsSha256, `${captureId} row candidateActionsSha256`),
        placementsSha256: requireSha256(raw.placementsSha256, `${captureId} row placementsSha256`),
        candidatePlacementsSha256: requireSha256(
            raw.candidatePlacementsSha256,
            `${captureId} row candidatePlacementsSha256`,
        ),
        rosterSha256: requireSha256(raw.rosterSha256, `${captureId} row rosterSha256`),
        candidateRosterSha256: requireSha256(raw.candidateRosterSha256, `${captureId} row candidateRosterSha256`),
        endReason: requireEndReason(raw.endReason, `${captureId} row endReason`),
        candidateEndReason: requireEndReason(raw.candidateEndReason, `${captureId} row candidateEndReason`),
        exact: true,
    };
    assertEqual(
        {
            result: row.candidateResultSha256,
            actions: row.candidateActionsSha256,
            placements: row.candidatePlacementsSha256,
            roster: row.candidateRosterSha256,
            endReason: row.candidateEndReason,
        },
        {
            result: row.resultSha256,
            actions: row.actionsSha256,
            placements: row.placementsSha256,
            roster: row.rosterSha256,
            endReason: row.endReason,
        },
        `${captureId} row ${ordinal} baseline/candidate semantics`,
    );
    return row;
}

function validateSource(
    sourceValue: unknown,
    captureId: CaptureId,
    protocol: IProtocol,
): { identity: unknown; candidateSrcManifestSha256: string } {
    const source = requireRecord(sourceValue, `${captureId}.source`);
    assertEqual(source.postflightUnchanged, true, `${captureId} source postflight`);
    const runnerBefore = requireRecord(source.runnerBefore, `${captureId}.source.runnerBefore`);
    const runnerAfter = requireRecord(source.runnerAfter, `${captureId}.source.runnerAfter`);
    assertEqual(runnerBefore.sha256, protocol.captureRunner.sha256, `${captureId} runnerBefore hash`);
    assertEqual(runnerAfter, runnerBefore, `${captureId} runner pre/post seal`);
    const baselineBefore = requireRecord(source.baselineBefore, `${captureId} baselineBefore`);
    const baselineAfter = requireRecord(source.baselineAfter, `${captureId} baselineAfter`);
    const candidateBefore = requireRecord(source.candidateBefore, `${captureId} candidateBefore`);
    const candidateAfter = requireRecord(source.candidateAfter, `${captureId} candidateAfter`);
    assertEqual(baselineAfter, baselineBefore, `${captureId} baseline pre/post identity`);
    assertEqual(candidateAfter, candidateBefore, `${captureId} candidate pre/post identity`);
    assertEqual(
        baselineBefore.srcTreeManifestSha256,
        BASELINE_SRC_MANIFEST_SHA256,
        `${captureId} baseline src manifest`,
    );
    const candidateSrcManifestSha256 = requireSha256(
        candidateBefore.srcTreeManifestSha256,
        `${captureId} candidate src manifest`,
    );
    assertEqual(candidateSrcManifestSha256, CANDIDATE_SRC_MANIFEST_SHA256, `${captureId} candidate src manifest`);
    const baselinePackage = requireRecord(baselineBefore.packageJson, `${captureId} baseline package`);
    const candidatePackage = requireRecord(candidateBefore.packageJson, `${captureId} candidate package`);
    const baselineLock = requireRecord(baselineBefore.workspaceLock, `${captureId} baseline lock`);
    const candidateLock = requireRecord(candidateBefore.workspaceLock, `${captureId} candidate lock`);
    requireSha256(baselinePackage.sha256, `${captureId} baseline package hash`);
    requireSha256(candidatePackage.sha256, `${captureId} candidate package hash`);
    requireSha256(baselineLock.sha256, `${captureId} baseline workspace lock hash`);
    requireSha256(candidateLock.sha256, `${captureId} candidate workspace lock hash`);
    assertEqual(baselinePackage.sha256, PACKAGE_JSON_SHA256, `${captureId} pinned package hash`);
    assertEqual(baselineLock.sha256, WORKSPACE_LOCK_SHA256, `${captureId} pinned workspace lock hash`);
    assertEqual(candidatePackage.sha256, baselinePackage.sha256, `${captureId} package hashes`);
    assertEqual(candidateLock.sha256, baselineLock.sha256, `${captureId} workspace lock hashes`);
    assertEqual(
        candidateBefore.dependencyRealpaths,
        baselineBefore.dependencyRealpaths,
        `${captureId} dependency realpaths`,
    );
    const delta = requireRecord(source.delta, `${captureId}.source.delta`);
    assertEqual(delta.exactExpected, true, `${captureId} exact source delta`);
    assertEqual(
        delta.expected,
        EXPECTED_RUNTIME_DELTA.map(({ path, change }) => ({ path, change })),
        `${captureId} expected source delta`,
    );
    assertEqual(
        delta.actual,
        EXPECTED_RUNTIME_DELTA.map(({ path, change }) => ({ path, change })),
        `${captureId} source delta shape`,
    );
    const differences = requireArray(delta.differences, `${captureId} source delta differences`);
    if (differences.length !== EXPECTED_RUNTIME_DELTA.length) {
        throw new Error(`${captureId} must contain exactly three source differences`);
    }
    const normalizedDifferences = differences.map((differenceValue, index) => {
        const difference = requireRecord(differenceValue, `${captureId} delta difference ${index}`);
        return {
            path: difference.path,
            change: difference.change,
            baselineSha256: difference.baselineSha256 ?? null,
            candidateSha256: difference.candidateSha256 ?? null,
        };
    });
    assertEqual(normalizedDifferences, EXPECTED_RUNTIME_DELTA, `${captureId} source delta hashes`);
    assertEqual(delta.manifestSha256, digest(differences), `${captureId} source delta manifest`);
    return {
        candidateSrcManifestSha256,
        identity: {
            baselineSrcManifestSha256: baselineBefore.srcTreeManifestSha256,
            candidateSrcManifestSha256,
            baselinePackageSha256: baselinePackage.sha256,
            candidatePackageSha256: candidatePackage.sha256,
            baselineWorkspaceLockSha256: baselineLock.sha256,
            candidateWorkspaceLockSha256: candidateLock.sha256,
            dependencyRealpaths: baselineBefore.dependencyRealpaths,
            deltaManifestSha256: delta.manifestSha256,
            differences: normalizedDifferences,
        },
    };
}

function validateProfile(profileValue: unknown, captureId: CaptureId): unknown {
    const profile = requireRecord(profileValue, `${captureId}.profile`);
    assertEqual(profile.crossRootExact, true, `${captureId} profile cross-root exactness`);
    assertEqual(profile.genericSearchExercised, true, `${captureId} generic search exercised`);
    const baseline = requireRecord(profile.baseline, `${captureId} baseline profile`);
    const candidate = requireRecord(profile.candidate, `${captureId} candidate profile`);
    assertEqual(candidate, baseline, `${captureId} baseline/candidate profile`);
    assertEqual(baseline.genericSearchDriverSelected, true, `${captureId} generic SearchDriver`);
    assertEqual(baseline.deadlineFree, true, `${captureId} deadline-free profile`);
    for (const key of [
        "profileSha256",
        "genomeSha256",
        "searchSha256",
        "policySha256",
        "fullEnvironmentSha256",
        "activeEnvironmentSha256",
    ]) {
        requireSha256(baseline[key], `${captureId} profile ${key}`);
    }
    const fullEnvironment = requireArray(baseline.fullEnvironment, `${captureId} full profile environment`);
    const activeEnvironment = requireArray(baseline.activeEnvironment, `${captureId} active profile environment`);
    assertEqual(baseline.fullEnvironmentSha256, digest(fullEnvironment), `${captureId} full environment digest`);
    assertEqual(baseline.activeEnvironmentSha256, digest(activeEnvironment), `${captureId} active environment digest`);
    const environmentIsolation = requireRecord(
        profile.environmentIsolation,
        `${captureId} profile environment isolation`,
    );
    assertEqual(environmentIsolation, EXPECTED_ENVIRONMENT_ISOLATION, `${captureId} environment isolation policy`);
    const activeEntries = new Map(
        activeEnvironment.map((entryValue, index) => {
            const entry = requireRecord(entryValue, `${captureId} active environment ${index}`);
            return [requireString(entry.key, `${captureId} active environment key ${index}`), entry.value ?? null];
        }),
    );
    if (activeEntries.size !== activeEnvironment.length) {
        throw new Error(`${captureId} active profile environment contains duplicate keys`);
    }
    assertEqual(
        Object.fromEntries(
            [
                "V08_A13_SEARCH",
                "V07_SEARCH",
                "Q2_ORACLE",
                "Q2_WAIT_ABLATION",
                "SEARCH_DECISION_DEADLINE_MS",
                "SEARCH_CIRCUIT_BREAKER_MS",
                "LIVETWIN",
                "FIGHT_MELEE_ROSTERS",
                "V04_BOXHOLD",
                "V04_FRONTLINE",
                "V04_FRONTMOVE",
                "V04_BUFFWAIT",
                "V04_BEHESELF",
                "V04_OGRESELF",
                "V04_MVGUARD",
                "V04_FHUNT2",
                "V04_TROLL",
                "FORCE_CREATURES",
                "COHORT",
                "ROSTER_RANGED_MIN",
                "ROSTER_RANGED_MAX",
                "ROSTER_FLYER_MIN",
                "ROSTER_FLYER_MAX",
                "ROSTER_CASTER_MIN",
                "ROSTER_CASTER_MAX",
                "VALUE_DATA",
                "VALUE_DATA_FEATURES",
                "PHASE_B_RUN_FINGERPRINT",
            ].map((key) => [key, activeEntries.get(key) ?? null]),
        ),
        {
            V08_A13_SEARCH: "0",
            V07_SEARCH: "1",
            Q2_ORACLE: null,
            Q2_WAIT_ABLATION: null,
            SEARCH_DECISION_DEADLINE_MS: null,
            SEARCH_CIRCUIT_BREAKER_MS: null,
            LIVETWIN: "1",
            FIGHT_MELEE_ROSTERS: "0",
            V04_BOXHOLD: null,
            V04_FRONTLINE: null,
            V04_FRONTMOVE: null,
            V04_BUFFWAIT: null,
            V04_BEHESELF: null,
            V04_OGRESELF: null,
            V04_MVGUARD: null,
            V04_FHUNT2: null,
            V04_TROLL: null,
            FORCE_CREATURES: null,
            COHORT: null,
            ROSTER_RANGED_MIN: null,
            ROSTER_RANGED_MAX: null,
            ROSTER_FLYER_MIN: null,
            ROSTER_FLYER_MAX: null,
            ROSTER_CASTER_MIN: null,
            ROSTER_CASTER_MAX: null,
            VALUE_DATA: null,
            VALUE_DATA_FEATURES: null,
            PHASE_B_RUN_FINGERPRINT: null,
        },
        `${captureId} active search environment`,
    );
    return { profile: baseline, environmentIsolation };
}

function validateWarmup(warmupValue: unknown, captureId: CaptureId, schedule: ICaptureSchedule): void {
    const warmup = requireRecord(warmupValue, `${captureId}.warmup`);
    assertEqual(warmup.passed, true, `${captureId} warmup passed`);
    assertEqual(warmup.discarded, true, `${captureId} warmup discarded`);
    const rows = requireArray(warmup.rows, `${captureId} warmup rows`);
    if (rows.length !== schedule.gridTypes.length) throw new Error(`${captureId} must have four warmup rows`);
    const baselineRowSearch: ISearchCounters[] = [];
    const candidateRowSearch: ISearchCounters[] = [];
    const orders: TaskOrder[] = [];
    for (let index = 0; index < rows.length; index++) {
        const row = requireRecord(rows[index], `${captureId} warmup row ${index}`);
        assertEqual(row.gridType, schedule.gridTypes[index], `${captureId} warmup gridType ${index}`);
        const order = expectedWarmupOrder(index, schedule.invertOrder);
        assertEqual(row.order, order, `${captureId} warmup order ${index}`);
        orders.push(order);
        assertEqual(row.exact, true, `${captureId} warmup exact ${index}`);
        assertEqual(row.timingDiscarded, true, `${captureId} warmup timing discarded ${index}`);
        const baselineActions = requireInteger(row.baselineActions, `${captureId} warmup baseline actions ${index}`, 1);
        const candidateActions = requireInteger(
            row.candidateActions,
            `${captureId} warmup candidate actions ${index}`,
            1,
        );
        assertEqual(candidateActions, baselineActions, `${captureId} warmup action equality ${index}`);
        requireSha256(row.resultSha256, `${captureId} warmup result hash ${index}`);
        const baselineSearch = validateSearchCounters(
            row.baselineSearch,
            `${captureId} warmup baseline search ${index}`,
        );
        const candidateSearch = validateSearchCounters(
            row.candidateSearch,
            `${captureId} warmup candidate search ${index}`,
        );
        assertEqual(candidateSearch, baselineSearch, `${captureId} warmup search equality ${index}`);
        baselineRowSearch.push(baselineSearch);
        candidateRowSearch.push(candidateSearch);
    }
    const balancedOrders = requireRecord(warmup.balancedOrders, `${captureId} warmup balanced orders`);
    assertEqual(
        balancedOrders,
        {
            ab: orders.filter((order) => order === "AB").length,
            ba: orders.filter((order) => order === "BA").length,
        },
        `${captureId} warmup balanced orders`,
    );
    const search = requireRecord(warmup.searchVerification, `${captureId} warmup search verification`);
    assertEqual(search.passed, true, `${captureId} warmup search passed`);
    assertEqual(search.crossRootCountersExact, true, `${captureId} warmup search cross-root exact`);
    requireString(search.scope, `${captureId} warmup search scope`);
    requireString(search.signal, `${captureId} warmup search signal`);
    const baseline = validateSearchCounters(search.baseline, `${captureId} warmup baseline search`);
    const candidate = validateSearchCounters(search.candidate, `${captureId} warmup candidate search`);
    assertEqual(candidate, baseline, `${captureId} warmup search counters`);
    assertEqual(baseline, sumSearchCounters(baselineRowSearch), `${captureId} warmup baseline search sum`);
    assertEqual(candidate, sumSearchCounters(candidateRowSearch), `${captureId} warmup candidate search sum`);
}

function validateCapture(
    id: CaptureId,
    path: string,
    schedule: ICaptureSchedule,
    protocol: IProtocol,
): IValidatedCapture {
    const file = fileSeal(path);
    const report = requireRecord(JSON.parse(readFileSync(file.path, "utf8")), `${id} report`);
    assertEqual(report.schema, CAPTURE_SCHEMA, `${id} schema`);
    const command = requireRecord(report.command, `${id}.command`);
    assertEqual(command.smoke, false, `${id} smoke`);
    assertEqual(command.invertOrder, schedule.invertOrder, `${id} invert order`);
    assertEqual(command.seeds, schedule.seeds, `${id} seeds`);
    assertEqual(command.gridTypes, schedule.gridTypes, `${id} grid types`);
    assertEqual(command.maxLaps, MAX_LAPS, `${id} max laps`);
    assertEqual(command.warmupSeed, WARMUP_SEED, `${id} warmup seed`);
    assertEqual(command.bootstrapSeed, BOOTSTRAP_SEED, `${id} bootstrap seed`);
    assertEqual(command.bootstrapSamples, BOOTSTRAP_SAMPLES, `${id} bootstrap samples`);
    const source = validateSource(report.source, id, protocol);
    const profileIdentity = validateProfile(report.profile, id);
    validateWarmup(report.warmup, id, schedule);

    const expectedTasks = schedule.seeds.flatMap((seed, seedIndex) =>
        schedule.gridTypes.map((gridType, gridIndex) => ({
            seed,
            gridType,
            order: expectedOrder(seedIndex, gridIndex, schedule.invertOrder),
        })),
    );
    const rawRows = requireArray(report.rows, `${id}.rows`);
    if (rawRows.length !== TASKS_PER_CAPTURE || expectedTasks.length !== TASKS_PER_CAPTURE) {
        throw new Error(`${id} must contain exactly ${TASKS_PER_CAPTURE} measured rows`);
    }
    const rows = rawRows.map((row, ordinal) =>
        validateCaptureRow(
            row,
            id,
            ordinal,
            expectedTasks[ordinal].seed,
            expectedTasks[ordinal].gridType,
            expectedTasks[ordinal].order,
        ),
    );
    const rowsByTask = new Map(rows.map((row) => [taskKey(row.seed, row.gridType), row]));
    if (rowsByTask.size !== TASKS_PER_CAPTURE) throw new Error(`${id} contains duplicate tasks`);

    const exactness = requireRecord(report.exactness, `${id}.exactness`);
    assertEqual(
        {
            passed: exactness.passed,
            taskCount: exactness.taskCount,
            semanticMismatchCount: exactness.semanticMismatchCount,
            rejectedActions: exactness.rejectedActions,
            stuckMatches: exactness.stuckMatches,
            exceptions: exactness.exceptions,
        },
        {
            passed: true,
            taskCount: TASKS_PER_CAPTURE,
            semanticMismatchCount: 0,
            rejectedActions: 0,
            stuckMatches: 0,
            exceptions: 0,
        },
        `${id} exactness counters`,
    );
    const exactRows = rows.map((row) => ({
        seed: row.seed,
        gridType: row.gridType,
        resultSha256: row.resultSha256,
        actionsSha256: row.actionsSha256,
        placementsSha256: row.placementsSha256,
        rosterSha256: row.rosterSha256,
        endReason: row.endReason,
        totalActions: row.baselineTotalActions,
    }));
    assertEqual(exactness.resultsSha256, digest(exactRows.map((row) => row.resultSha256)), `${id} result digest`);
    assertEqual(exactness.actionsSha256, digest(exactRows.map((row) => row.actionsSha256)), `${id} action digest`);
    assertEqual(
        exactness.placementsSha256,
        digest(exactRows.map((row) => row.placementsSha256)),
        `${id} placement digest`,
    );
    assertEqual(exactness.rostersSha256, digest(exactRows.map((row) => row.rosterSha256)), `${id} roster digest`);
    assertEqual(exactness.endReasonsSha256, digest(exactRows.map((row) => row.endReason)), `${id} end-reason digest`);
    assertEqual(
        exactness.totalActionsSha256,
        digest(exactRows.map((row) => row.totalActions)),
        `${id} total-action digest`,
    );
    assertEqual(exactness.rowsSha256, digest(exactRows), `${id} exact-row digest`);

    const work = requireRecord(report.work, `${id}.work`);
    const fixed = requireRecord(work.fixed, `${id}.work.fixed`);
    assertEqual(
        {
            serial: fixed.serial,
            measuredTasks: fixed.measuredTasks,
            measuredMatchesPerVariant: fixed.measuredMatchesPerVariant,
            measuredMatchesTotal: fixed.measuredMatchesTotal,
            warmupMatchesPerVariant: fixed.warmupMatchesPerVariant,
            warmupMatchesTotal: fixed.warmupMatchesTotal,
            configuredMaxLapsPerMeasuredMatch: fixed.configuredMaxLapsPerMeasuredMatch,
            abTasks: fixed.abTasks,
            baTasks: fixed.baTasks,
        },
        {
            serial: true,
            measuredTasks: 80,
            measuredMatchesPerVariant: 80,
            measuredMatchesTotal: 160,
            warmupMatchesPerVariant: 4,
            warmupMatchesTotal: 8,
            configuredMaxLapsPerMeasuredMatch: MAX_LAPS,
            abTasks: 40,
            baTasks: 40,
        },
        `${id} fixed work`,
    );
    const logical = requireRecord(work.logical, `${id}.work.logical`);
    const acceptedActions = sum(rows.map((row) => row.baselineTotalActions));
    assertEqual(logical.taskByTaskExact, true, `${id} task logical work`);
    assertEqual(logical.targetLayerTelemetryAvailable, false, `${id} target telemetry policy`);
    assertEqual(logical.baselineAcceptedActions, acceptedActions, `${id} baseline accepted actions`);
    assertEqual(logical.candidateAcceptedActions, acceptedActions, `${id} candidate accepted actions`);

    const host = requireRecord(report.host, `${id}.host`);
    const hostIdentity = {
        platform: requireString(host.platform, `${id} host platform`),
        release: requireString(host.release, `${id} host release`),
        arch: requireString(host.arch, `${id} host arch`),
        cpuModel: requireString(host.cpuModel, `${id} host cpuModel`),
        logicalCpus: requireInteger(host.logicalCpus, `${id} host logicalCpus`, 1),
        bunVersion: requireString(host.bunVersion, `${id} host bunVersion`),
    };
    return {
        id,
        schedule,
        file,
        report,
        rows,
        rowsByTask,
        sourceIdentity: source.identity,
        profileIdentity,
        hostIdentity,
        semanticIdentityByTask: new Map(rows.map((row) => [taskKey(row.seed, row.gridType), readSemanticRow(row)])),
    };
}

function quantile(values: readonly number[], probability: number): number {
    if (values.length === 0) throw new Error("Cannot calculate a quantile of an empty sample");
    const sorted = [...values].sort((left, right) => left - right);
    const position = (sorted.length - 1) * probability;
    const lower = Math.floor(position);
    const fraction = position - lower;
    return sorted[lower] + (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]) * fraction;
}

function medianThree(values: readonly number[], label: string): number {
    if (values.length !== 3 || values.some((value) => !Number.isFinite(value) || value <= 0)) {
        throw new Error(`${label} must contain exactly three positive finite ratios`);
    }
    return [...values].sort((left, right) => left - right)[1];
}

function buildRobustTasks(captures: readonly IValidatedCapture[]): IRobustTask[] {
    return NATURAL_SEEDS.flatMap((seed) =>
        NATURAL_GRID_TYPES.map((gridType) => {
            const rows = captures.map((capture) => capture.rowsByTask.get(taskKey(seed, gridType))!);
            const abRatios = rows.filter((row) => row.order === "AB").map((row) => row.ratio);
            const baRatios = rows.filter((row) => row.order === "BA").map((row) => row.ratio);
            const medianAbRatio = medianThree(abRatios, `seed=${seed} map=${gridType} AB`);
            const medianBaRatio = medianThree(baRatios, `seed=${seed} map=${gridType} BA`);
            return {
                seed,
                gridType,
                abRatios: abRatios as [number, number, number],
                baRatios: baRatios as [number, number, number],
                medianAbRatio,
                medianBaRatio,
                robustRatio: Math.sqrt(medianAbRatio * medianBaRatio),
            };
        }),
    );
}

function crossedBootstrap(captures: readonly IValidatedCapture[]): IBootstrapDistribution {
    const byId = new Map(captures.map((capture) => [capture.id, capture]));
    const original = ORIGINAL_CAPTURE_IDS.map((id) => byId.get(id)!);
    const inverted = INVERTED_CAPTURE_IDS.map((id) => byId.get(id)!);
    let state = BOOTSTRAP_SEED >>> 0;
    const random = (): number => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
    };
    const output: IBootstrapDistribution = {
        totalRatio: [],
        geometricRatio: [],
        robustP99: [],
        abTotalRatio: [],
        baTotalRatio: [],
    };
    for (let sample = 0; sample < BOOTSTRAP_SAMPLES; sample++) {
        const sampledCaptures = [
            ...Array.from({ length: 3 }, () => original[Math.floor(random() * original.length)]),
            ...Array.from({ length: 3 }, () => inverted[Math.floor(random() * inverted.length)]),
        ];
        const sampledSeeds = Array.from(
            { length: NATURAL_SEEDS.length },
            () => NATURAL_SEEDS[Math.floor(random() * NATURAL_SEEDS.length)],
        );
        let baselineNs = 0;
        let candidateNs = 0;
        let logRatio = 0;
        let count = 0;
        let abBaselineNs = 0;
        let abCandidateNs = 0;
        let baBaselineNs = 0;
        let baCandidateNs = 0;
        const robustRatios: number[] = [];
        for (const seed of sampledSeeds) {
            for (const gridType of NATURAL_GRID_TYPES) {
                const taskRows = sampledCaptures.map((capture) => capture.rowsByTask.get(taskKey(seed, gridType))!);
                const abRatios: number[] = [];
                const baRatios: number[] = [];
                for (const row of taskRows) {
                    baselineNs += row.baselineNs;
                    candidateNs += row.candidateNs;
                    logRatio += Math.log(row.ratio);
                    count++;
                    if (row.order === "AB") {
                        abBaselineNs += row.baselineNs;
                        abCandidateNs += row.candidateNs;
                        abRatios.push(row.ratio);
                    } else {
                        baBaselineNs += row.baselineNs;
                        baCandidateNs += row.candidateNs;
                        baRatios.push(row.ratio);
                    }
                }
                robustRatios.push(
                    Math.sqrt(
                        medianThree(abRatios, "bootstrap AB ratios") * medianThree(baRatios, "bootstrap BA ratios"),
                    ),
                );
            }
        }
        output.totalRatio.push(candidateNs / baselineNs);
        output.geometricRatio.push(Math.exp(logRatio / count));
        output.robustP99.push(quantile(robustRatios, 0.99));
        output.abTotalRatio.push(abCandidateNs / abBaselineNs);
        output.baTotalRatio.push(baCandidateNs / baBaselineNs);
    }
    return output;
}

function interval(values: readonly number[]): { lower95: number; median: number; upper95: number } {
    return {
        lower95: quantile(values, 0.025),
        median: quantile(values, 0.5),
        upper95: quantile(values, 0.975),
    };
}

async function main(): Promise<void> {
    const cli = commandLine();
    if (!cli) return;
    const runnerBefore = fileSeal(RUNNER_PATH);
    const loadedProtocol = loadProtocol();
    assertEqual(
        runnerBefore.sha256,
        loadedProtocol.protocol.aggregationRunner.sha256,
        "preregistered aggregation runner hash",
    );
    const captures = CAPTURE_SCHEDULES.map((schedule) =>
        validateCapture(schedule.id, cli.captures[schedule.id], schedule, loadedProtocol.protocol),
    );

    const reference = captures[0];
    for (const capture of captures.slice(1)) {
        assertEqual(capture.sourceIdentity, reference.sourceIdentity, `${capture.id} common source seal`);
        assertEqual(capture.profileIdentity, reference.profileIdentity, `${capture.id} common profile seal`);
        assertEqual(capture.hostIdentity, reference.hostIdentity, `${capture.id} common host identity`);
        for (const seed of NATURAL_SEEDS) {
            for (const gridType of NATURAL_GRID_TYPES) {
                const key = taskKey(seed, gridType);
                assertEqual(
                    capture.semanticIdentityByTask.get(key),
                    reference.semanticIdentityByTask.get(key),
                    `${capture.id} semantic trace ${key}`,
                );
            }
        }
    }

    const allRows = captures.flatMap((capture) => capture.rows);
    if (allRows.length !== EXPECTED_GATES.exactTaskPairs) {
        throw new Error(`Expected exactly ${EXPECTED_GATES.exactTaskPairs} pooled task pairs`);
    }
    const robustTasks = buildRobustTasks(captures);
    if (robustTasks.length !== TASKS_PER_CAPTURE) throw new Error("Robust task census must contain 80 tasks");
    const robustRatios = robustTasks.map((task) => task.robustRatio);
    const bootstrapDistribution = crossedBootstrap(captures);
    const bootstrap = {
        samples: BOOTSTRAP_SAMPLES,
        seed: BOOTSTRAP_SEED,
        totalRatio: interval(bootstrapDistribution.totalRatio),
        geometricRatio: interval(bootstrapDistribution.geometricRatio),
        robustP99: interval(bootstrapDistribution.robustP99),
        abTotalRatio: interval(bootstrapDistribution.abTotalRatio),
        baTotalRatio: interval(bootstrapDistribution.baTotalRatio),
    };

    const pooledBaselineNs = sum(allRows.map((row) => row.baselineNs));
    const pooledCandidateNs = sum(allRows.map((row) => row.candidateNs));
    const captureTotals = captures.map((capture) => ({
        id: capture.id,
        invertOrder: capture.schedule.invertOrder,
        baselineTotalMs: sum(capture.rows.map((row) => row.baselineNs)) / 1_000_000,
        candidateTotalMs: sum(capture.rows.map((row) => row.candidateNs)) / 1_000_000,
        totalRatio: sum(capture.rows.map((row) => row.candidateNs)) / sum(capture.rows.map((row) => row.baselineNs)),
    }));
    const orderTotals = (["AB", "BA"] as const).map((order) => {
        const rows = allRows.filter((row) => row.order === order);
        return {
            order,
            observations: rows.length,
            baselineTotalMs: sum(rows.map((row) => row.baselineNs)) / 1_000_000,
            candidateTotalMs: sum(rows.map((row) => row.candidateNs)) / 1_000_000,
            totalRatio: sum(rows.map((row) => row.candidateNs)) / sum(rows.map((row) => row.baselineNs)),
        };
    });
    const perMap = NATURAL_GRID_TYPES.map((gridType) => {
        const rows = allRows.filter((row) => row.gridType === gridType);
        return {
            gridType,
            observations: rows.length,
            baselineTotalMs: sum(rows.map((row) => row.baselineNs)) / 1_000_000,
            candidateTotalMs: sum(rows.map((row) => row.candidateNs)) / 1_000_000,
            totalRatio: sum(rows.map((row) => row.candidateNs)) / sum(rows.map((row) => row.baselineNs)),
        };
    });

    const performanceGates = {
        totalRatioBootstrapUpper95: {
            comparator: "<=",
            threshold: EXPECTED_GATES.totalRatioBootstrapUpper95Maximum,
            observed: bootstrap.totalRatio.upper95,
            passed: bootstrap.totalRatio.upper95 <= EXPECTED_GATES.totalRatioBootstrapUpper95Maximum,
        },
        geometricRatioBootstrapUpper95: {
            comparator: "<",
            threshold: EXPECTED_GATES.geometricRatioBootstrapUpper95MaximumExclusive,
            observed: bootstrap.geometricRatio.upper95,
            passed: bootstrap.geometricRatio.upper95 < EXPECTED_GATES.geometricRatioBootstrapUpper95MaximumExclusive,
        },
        robustP50: {
            comparator: "<",
            threshold: EXPECTED_GATES.robustP50MaximumExclusive,
            observed: quantile(robustRatios, 0.5),
            passed: quantile(robustRatios, 0.5) < EXPECTED_GATES.robustP50MaximumExclusive,
        },
        robustP99: {
            comparator: "<",
            threshold: EXPECTED_GATES.robustP99MaximumExclusive,
            observed: quantile(robustRatios, 0.99),
            passed: quantile(robustRatios, 0.99) < EXPECTED_GATES.robustP99MaximumExclusive,
        },
        robustP99BootstrapUpper95: {
            comparator: "<=",
            threshold: EXPECTED_GATES.robustP99BootstrapUpper95Maximum,
            observed: bootstrap.robustP99.upper95,
            passed: bootstrap.robustP99.upper95 <= EXPECTED_GATES.robustP99BootstrapUpper95Maximum,
        },
        robustFasterTasks: {
            comparator: ">=",
            threshold: EXPECTED_GATES.minimumRobustFasterTasks,
            observed: robustRatios.filter((ratio) => ratio < 1).length,
            passed: robustRatios.filter((ratio) => ratio < 1).length >= EXPECTED_GATES.minimumRobustFasterTasks,
        },
        robustMaximumRatio: {
            comparator: "<=",
            threshold: EXPECTED_GATES.robustMaximumRatio,
            observed: Math.max(...robustRatios),
            passed: Math.max(...robustRatios) <= EXPECTED_GATES.robustMaximumRatio,
        },
        abTotalRatioBootstrapUpper95: {
            comparator: "<",
            threshold: EXPECTED_GATES.orderTotalBootstrapUpper95MaximumExclusive,
            observed: bootstrap.abTotalRatio.upper95,
            passed: bootstrap.abTotalRatio.upper95 < EXPECTED_GATES.orderTotalBootstrapUpper95MaximumExclusive,
        },
        baTotalRatioBootstrapUpper95: {
            comparator: "<",
            threshold: EXPECTED_GATES.orderTotalBootstrapUpper95MaximumExclusive,
            observed: bootstrap.baTotalRatio.upper95,
            passed: bootstrap.baTotalRatio.upper95 < EXPECTED_GATES.orderTotalBootstrapUpper95MaximumExclusive,
        },
        perMapTotalRatio: {
            comparator: "<=",
            threshold: EXPECTED_GATES.perMapTotalRatioMaximum,
            observedMaximum: Math.max(...perMap.map((row) => row.totalRatio)),
            passed: perMap.every((row) => row.totalRatio <= EXPECTED_GATES.perMapTotalRatioMaximum),
        },
        fasterCaptures: {
            comparator: ">=",
            threshold: EXPECTED_GATES.minimumFasterCaptures,
            observed: captureTotals.filter((capture) => capture.totalRatio < 1).length,
            passed:
                captureTotals.filter((capture) => capture.totalRatio < 1).length >=
                EXPECTED_GATES.minimumFasterCaptures,
        },
        captureTotalRatioMaximum: {
            comparator: "<=",
            threshold: EXPECTED_GATES.captureTotalRatioMaximum,
            observed: Math.max(...captureTotals.map((capture) => capture.totalRatio)),
            passed: captureTotals.every((capture) => capture.totalRatio <= EXPECTED_GATES.captureTotalRatioMaximum),
        },
    };
    const performancePassed = Object.values(performanceGates).every((gate) => gate.passed);

    const runnerAfter = fileSeal(RUNNER_PATH);
    const protocolAfter = fileSeal(PROTOCOL_PATH);
    assertEqual(runnerAfter, runnerBefore, "aggregation runner pre/post seal");
    assertEqual(protocolAfter, loadedProtocol.seal, "protocol pre/post seal");
    for (const capture of captures) {
        assertEqual(fileSeal(capture.file.path), capture.file, `${capture.id} capture pre/post seal`);
    }

    const report = {
        schema: SCHEMA,
        generatedAt: new Date().toISOString(),
        protocol: {
            ...loadedProtocol.seal,
            schema: loadedProtocol.protocol.schema,
            protocolDate: loadedProtocol.protocol.protocolDate,
            predecessorEvidence: loadedProtocol.protocol.predecessorEvidence,
        },
        aggregationRunner: {
            before: runnerBefore,
            after: runnerAfter,
            unchanged: true,
        },
        captures: captures.map((capture) => ({
            id: capture.id,
            schedule: capture.schedule,
            file: capture.file,
            totalRatio: captureTotals.find((row) => row.id === capture.id)!.totalRatio,
        })),
        seals: {
            passed: true,
            commonCaptureRunnerSha256: loadedProtocol.protocol.captureRunner.sha256,
            commonSource: reference.sourceIdentity,
            commonProfile: reference.profileIdentity,
            commonHost: reference.hostIdentity,
            sourcePackageLockAndInputFilesUnchanged: true,
            installedDependencyContentsSealed: false,
            dependencySealLimitation: loadedProtocol.protocol.dependencyInputs.limitation,
        },
        exactness: {
            required: true,
            passed: true,
            captures: captures.length,
            taskPairs: allRows.length,
            robustTasks: robustTasks.length,
            semanticMismatchCount: 0,
            rejectedActions: 0,
            stuckMatches: 0,
            exceptions: 0,
            semanticIdentitySha256: digest(
                NATURAL_SEEDS.flatMap((seed) =>
                    NATURAL_GRID_TYPES.map((gridType) => reference.semanticIdentityByTask.get(taskKey(seed, gridType))),
                ),
            ),
        },
        work: {
            measuredTaskPairs: allRows.length,
            measuredMatches: allRows.length * 2,
            acceptedActionsPerCapture: captures.map((capture) => ({
                id: capture.id,
                actions: sum(capture.rows.map((row) => row.baselineTotalActions)),
            })),
            targetLayerTelemetryAvailable: false,
            targetLayerTelemetryNote:
                "No target-layer counter exists. The protocol uses fixed matches, exact accepted actions, " +
                "and exact semantic traces without inventing target telemetry.",
        },
        performance: {
            passed: performancePassed,
            pooledBaselineTotalMs: pooledBaselineNs / 1_000_000,
            pooledCandidateTotalMs: pooledCandidateNs / 1_000_000,
            pooledTotalRatio: pooledCandidateNs / pooledBaselineNs,
            pooledGeometricMeanRatio: Math.exp(sum(allRows.map((row) => Math.log(row.ratio))) / allRows.length),
            captureTotals,
            orderTotals,
            perMap,
            robust: {
                method: "sqrt(median(three AB ratios) * median(three BA ratios)) per seed/map task",
                p50: quantile(robustRatios, 0.5),
                p95: quantile(robustRatios, 0.95),
                p99: quantile(robustRatios, 0.99),
                maximum: Math.max(...robustRatios),
                fasterTasks: robustRatios.filter((ratio) => ratio < 1).length,
                tiedTasks: robustRatios.filter((ratio) => ratio === 1).length,
                slowerTasks: robustRatios.filter((ratio) => ratio > 1).length,
                tasks: robustTasks,
            },
            bootstrap,
            gates: performanceGates,
        },
        qualification: {
            eligible: true,
            passed: performancePassed,
            stoppingRule:
                "Exactly six valid captures; no extra capture or selective task rerun is permitted after this result.",
        },
    };
    writeJsonAtomicExclusive(cli.out, report);
    console.log(
        JSON.stringify(
            {
                out: cli.out,
                exactness: report.exactness,
                performance: {
                    passed: report.performance.passed,
                    pooledTotalRatio: report.performance.pooledTotalRatio,
                    robust: {
                        p50: report.performance.robust.p50,
                        p99: report.performance.robust.p99,
                        maximum: report.performance.robust.maximum,
                        fasterTasks: report.performance.robust.fasterTasks,
                    },
                    bootstrap: report.performance.bootstrap,
                    gates: report.performance.gates,
                },
                qualification: report.qualification,
            },
            null,
            2,
        ),
    );
    if (!report.qualification.passed) {
        throw new Error(`Six-capture replication gates failed; report retained at ${cli.out}`);
    }
}

await main();
