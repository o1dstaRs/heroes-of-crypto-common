#!/usr/bin/env bun

/**
 * Sealed two-source-root exactness and paired macro benchmark for A13 decision-scoped path reuse.
 *
 * The default `a13-unbounded` mode applies each root's complete frozen A13 environment but removes the
 * 175/275 ms wall-clock cutoffs. It is therefore the deterministic semantic/performance qualification mode.
 * `production-bounded` retains the exact production cutoffs; semantic drift is reported rather than gated
 * because deadline crossings are intentionally timing-sensitive. Rejections and stuck matches always fail.
 *
 * Example:
 *   bun docs/evidence/tools/a13_decision_path_pair.ts \
 *     --baseline-root=/tmp/common-baseline \
 *     --candidate-root=/tmp/common-candidate \
 *     --seeds=1-20 --grid-types=1,2,3,4 --max-laps=2 \
 *     --out=/tmp/a13-decision-path-pair.json
 */

import { createHash } from "node:crypto";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readlinkSync,
    readdirSync,
    realpathSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { arch, cpus, platform, release } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const SCHEMA = "heroes-of-crypto/a13-decision-path-pair/v2" as const;
const UINT32_MAX = 0xffff_ffff;
const DEFAULT_BOOTSTRAP_SEED = 0xa13c_ace;
const DEFAULT_BOOTSTRAP_SAMPLES = 20_000;
const EXPECTED_PROFILE_SCHEMA = "hoc.v0_8_a13_production_profile.v1";
const EXPECTED_CANDIDATE_ID = "a13";
const EXPECTED_SOURCE_VERSION = "v0.8s";
const EXPECTED_PRODUCTION_VERSION = "v0.8";
const EXPECTED_OPPONENT_VERSION = "v0.7";
const EXPECTED_SOURCE_COMMIT = "80059c9f34d918285eeb996589c9e3335efc240a";
const EXPECTED_SOURCE_TREE = "b72339469be9b2b5a950e0844da31805d4da3a23";
const EXPECTED_GENOME_SHA256 = "a46ac7ef0c18da1f3fb3b82a3fc1cd53e5565747d4d1673ac5340af5bf92ba49";
const EXPECTED_SOURCE_BINDING_SHA256 = "e68485b177e98f4fb98228a6595e29b08c50726ef4882ee44ea53652a4613459";
const EXPECTED_SOURCE_BEHAVIOR_ENVIRONMENT_SHA256 = "0f2489977d6c3a2dcefeebc82199e6e67ce16055ec6aa56451dd756b50b9ebbf";
const EXPECTED_PROFILE_ENVIRONMENT_SHA256 = "14869c0c5f9791034ac86165b12fd73c6a78b3164336a1f0dfddd1fb7fc894ad";
const EXPECTED_SEARCH = Object.freeze({
    gate: 0.03,
    horizon: 12,
    rollouts: 2,
    includeMoves: true,
    maxMoves: 1,
    maxMelee: 6,
    maxShots: 4,
    maxThrows: 2,
    activeChallengers: true,
    shortlist: 3,
    decisionDeadlineMs: 175,
    circuitBreakerMs: 275,
    lateRangedFinishWeight: 0,
    pureRangedTerminalWeight: 0,
});
const EXPECTED_POLICY = Object.freeze({
    meleeRapidChargeWeight: 0,
    meleeRangedTargetWeight: 2,
    placementReveal: true,
    denseMeleeMagicIsolation: false,
    auraCasterMode: "off",
    aggressive: true,
});
const SOURCE_FILES = [
    "src/ai/decision_path_catalog.ts",
    "src/ai/ai.ts",
    "src/ai/ai_strategy.ts",
    "src/ai/candidates.ts",
    "src/ai/versions/v0_1.ts",
    "src/ai/versions/v0_2.ts",
    "src/ai/versions/v0_3.ts",
    "src/ai/versions/v0_4.ts",
    "src/ai/versions/v0_5.ts",
    "src/ai/versions/v0_6.ts",
    "src/ai/versions/v0_8_ranged_positioning.ts",
    "src/ai/versions/v0_8_a13_profile.ts",
    "src/grid/path_definitions.ts",
    "src/grid/path_helper.ts",
    "src/simulation/army.ts",
    "src/simulation/battle_engine.ts",
    "src/simulation/optimizer/v0_8_aligned_96h_v1_protocol.ts",
    "src/simulation/search_driver.ts",
] as const;
const EXPECTED_SOURCE_DELTA = Object.freeze([
    { path: "ai/ai.ts", change: "modified" },
    { path: "ai/ai_strategy.ts", change: "modified" },
    { path: "ai/candidates.ts", change: "modified" },
    { path: "ai/decision_path_catalog.ts", change: "added" },
    { path: "ai/versions/v0_1.ts", change: "modified" },
    { path: "ai/versions/v0_2.ts", change: "modified" },
    { path: "ai/versions/v0_3.ts", change: "modified" },
    { path: "ai/versions/v0_4.ts", change: "modified" },
    { path: "ai/versions/v0_5.ts", change: "modified" },
    { path: "ai/versions/v0_6.ts", change: "modified" },
    { path: "ai/versions/v0_8_ranged_positioning.ts", change: "modified" },
    { path: "grid/path_definitions.ts", change: "modified" },
    { path: "simulation/battle_engine.ts", change: "modified" },
    { path: "simulation/search_driver.ts", change: "modified" },
]);
const RUNNER_PATH = fileURLToPath(import.meta.url);

type RunMode = "a13-unbounded" | "production-bounded";

interface ICliOptions {
    baselineRoot: string;
    candidateRoot: string;
    seeds: number[];
    gridTypes: number[];
    maxLaps: number;
    warmupSeed: number;
    mode: RunMode;
    bootstrapSeed: number;
    bootstrapSamples: number;
    out: string;
}

interface IArmyModule {
    buildRoster(rng: () => number): unknown[];
    makeRng(seed: number): () => number;
}

interface IBattleModule {
    runMatch(config: Record<string, unknown>): Record<string, unknown>;
}

interface IProfileModule {
    V08_A13_PROFILE_SCHEMA: string;
    V08_A13_CANDIDATE_ID: string;
    V08_A13_SOURCE_VERSION: string;
    V08_A13_PRODUCTION_VERSION: string;
    V08_A13_OPPONENT_VERSION: string;
    V08_A13_SOURCE_COMMIT: string;
    V08_A13_SOURCE_TREE: string;
    V08_A13_GENOME_SHA256: string;
    V08_A13_SOURCE_BINDING_SHA256: string;
    V08_A13_SOURCE_BEHAVIOR_ENVIRONMENT_SHA256: string;
    V08_A13_GENOME: unknown;
    V08_A13_SEARCH: unknown;
    V08_A13_POLICY: unknown;
    V08_A13_PROFILE: unknown;
    buildV08A13SearchEnvironment(version?: string): Readonly<Record<string, string | undefined>>;
}

interface IProtocolModule {
    fingerprintV08AlignedV1CandidateGenome(genome: never): string;
}

interface IProductionSearchModule {
    shouldUseDefaultV08A13Search(match: { greenVersion: string; redVersion: string }): boolean;
}

interface IEnvironmentEntry {
    key: string;
    value: string | null;
}

interface IProfileSeal {
    passed: true;
    schema: string;
    candidateId: string;
    sourceVersion: string;
    productionVersion: string;
    opponentVersion: string;
    sourceCommit: string;
    sourceTree: string;
    exportedGenomeSha256: string;
    computedGenomeSha256: string;
    genomeCanonicalSha256: string;
    sourceBindingSha256: string;
    sourceBehaviorEnvironmentSha256: string;
    fullProfileCanonicalSha256: string;
    profileEnvironmentSha256: string;
    activeEnvironmentSha256: string;
    profileEnvironment: IEnvironmentEntry[];
    activeEnvironment: IEnvironmentEntry[];
}

interface IVariant {
    label: "baseline" | "candidate";
    root: string;
    army: IArmyModule;
    battle: IBattleModule;
    environment: Readonly<Record<string, string | undefined>>;
    profile: IProfileSeal;
}

interface IPathStats {
    decisionsObserved: number;
    catalogsObserved: number;
    catalogsMissing: number;
    requests: number;
    hits: number;
    misses: number;
    bypasses: number;
    decisionsWithHits: number;
}

interface IRun {
    elapsedNs: number;
    resultSha256: string;
    actionsSha256: string;
    placementsSha256: string;
    rosterSha256: string;
    endReason: string;
    rejected: number;
    path: IPathStats;
}

interface ITaskRow {
    ordinal: number;
    order: "AB" | "BA";
    seed: number;
    gridType: number;
    baselineNs: number;
    candidateNs: number;
    ratio: number;
    semanticEqual: boolean;
    resultSha256: string;
    candidateResultSha256: string;
    actionsSha256: string;
    candidateActionsSha256: string;
    placementsSha256: string;
    candidatePlacementsSha256: string;
    rosterSha256: string;
    endReason: string;
    candidateEndReason: string;
    path: IPathStats;
    instrumentedSemanticEqual: boolean;
}

interface ITreeEntry {
    path: string;
    kind: "file" | "symlink";
    bytes: number;
    sha256: string;
}

interface ISourceSealReport {
    root: string;
    realRoot: string;
    dependencyRoot: string | null;
    srcEntryCount: number;
    srcBytes: number;
    srcTreeManifestSha256: string;
    packageJsonSha256: string | null;
    selectedFiles: Record<string, string | null>;
}

interface ISourceSeal {
    report: ISourceSealReport;
    entries: ITreeEntry[];
}

interface IBootstrapIntervals {
    totalRatio95: [number, number];
    geometricMeanPairedRatio95: [number, number];
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

function printHelp(): void {
    console.log(`A13 decision-path paired qualification

Usage:
  bun docs/evidence/tools/a13_decision_path_pair.ts \\
    --baseline-root=ROOT --candidate-root=ROOT --out=REPORT.json [options]

Options:
  --mode=a13-unbounded|production-bounded  Default: a13-unbounded
  --seeds=1-20                            Default: 1-20
  --grid-types=1,2,3,4                    Default: 1,2,3,4
  --max-laps=2                            Default: 2
  --warmup-seed=4294967295                Warm up both roots on every requested map
  --bootstrap-seed=169069262              Seed-cluster bootstrap PRNG seed
  --bootstrap-samples=20000               Seed-cluster bootstrap replicates
  --help

The unbounded mode is the exact semantic gate. Production-bounded mode preserves the frozen 175/275 ms
cutoffs and reports timing-sensitive semantic differences without failing them. Both modes fail immediately
on an engine-rejected action, a stuck match, source mutation, profile drift, or roster drift.`);
}

function parseIntegerList(value: string, name: string, min: number, max: number): number[] {
    const values: number[] = [];
    for (const rawToken of value.split(",")) {
        const token = rawToken.trim();
        const range = /^(\d+)-(\d+)$/.exec(token);
        if (range) {
            const first = Number(range[1]);
            const last = Number(range[2]);
            if (first > last || first < min || last > max) {
                throw new Error(`${name} contains invalid range ${token}`);
            }
            for (let current = first; current <= last; current++) values.push(current);
            continue;
        }
        const parsed = Number(token);
        if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
            throw new Error(`${name} contains invalid value ${token}`);
        }
        values.push(parsed);
    }
    if (!values.length || new Set(values).size !== values.length) {
        throw new Error(`${name} must be a non-empty list without duplicates`);
    }
    return values;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
    return parsed;
}

function commandLine(): ICliOptions | undefined {
    const values = parseArgs({
        args: process.argv.slice(2),
        strict: true,
        allowPositionals: false,
        options: {
            help: { type: "boolean", default: false },
            "baseline-root": { type: "string" },
            "candidate-root": { type: "string" },
            seeds: { type: "string", default: "1-20" },
            "grid-types": { type: "string", default: "1,2,3,4" },
            "max-laps": { type: "string", default: "2" },
            "warmup-seed": { type: "string", default: String(UINT32_MAX) },
            mode: { type: "string", default: "a13-unbounded" },
            "bootstrap-seed": { type: "string", default: String(DEFAULT_BOOTSTRAP_SEED) },
            "bootstrap-samples": { type: "string", default: String(DEFAULT_BOOTSTRAP_SAMPLES) },
            out: { type: "string" },
        },
    }).values;
    if (values.help) {
        printHelp();
        return undefined;
    }
    if (values.mode !== "a13-unbounded" && values.mode !== "production-bounded") {
        throw new Error("--mode must be a13-unbounded or production-bounded");
    }
    if (!values["baseline-root"]?.trim()) throw new Error("--baseline-root is required");
    if (!values["candidate-root"]?.trim()) throw new Error("--candidate-root is required");
    if (!values.out?.trim()) throw new Error("--out is required");
    const baselineRoot = requireRoot(values["baseline-root"]);
    const candidateRoot = requireRoot(values["candidate-root"]);
    if (realpathSync(baselineRoot) === realpathSync(candidateRoot)) {
        throw new Error("baseline and candidate roots must be distinct");
    }
    const out = resolve(values.out);
    if (existsSync(out)) throw new Error(`Refusing to overwrite existing output: ${out}`);
    return {
        baselineRoot,
        candidateRoot,
        seeds: parseIntegerList(values.seeds ?? "1-20", "--seeds", 0, UINT32_MAX),
        gridTypes: parseIntegerList(values["grid-types"] ?? "1,2,3,4", "--grid-types", 1, 4),
        maxLaps: positiveInteger(values["max-laps"], 2, "--max-laps"),
        warmupSeed: parseIntegerList(values["warmup-seed"] ?? String(UINT32_MAX), "--warmup-seed", 0, UINT32_MAX)[0],
        mode: values.mode,
        bootstrapSeed: parseIntegerList(
            values["bootstrap-seed"] ?? String(DEFAULT_BOOTSTRAP_SEED),
            "--bootstrap-seed",
            0,
            UINT32_MAX,
        )[0],
        bootstrapSamples: positiveInteger(
            values["bootstrap-samples"],
            DEFAULT_BOOTSTRAP_SAMPLES,
            "--bootstrap-samples",
        ),
        out,
    };
}

function requireRoot(input: string): string {
    const root = resolve(input);
    for (const file of [
        "src/simulation/army.ts",
        "src/simulation/battle_engine.ts",
        "src/simulation/optimizer/v0_8_aligned_96h_v1_protocol.ts",
        "src/ai/versions/v0_8_a13_profile.ts",
    ]) {
        const path = join(root, file);
        if (!existsSync(path) || !statSync(path).isFile()) {
            throw new Error(`source root ${root} is missing ${file}`);
        }
    }
    return root;
}

function environmentEntries(environment: Readonly<Record<string, string | undefined>>): IEnvironmentEntry[] {
    return Object.entries(environment)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => ({ key, value: value ?? null }));
}

function activeEnvironment(
    profileEnvironment: Readonly<Record<string, string | undefined>>,
    mode: RunMode,
): Readonly<Record<string, string | undefined>> {
    if (mode === "production-bounded") {
        return Object.freeze({
            ...profileEnvironment,
            Q2_ORACLE: undefined,
            Q2_WAIT_ABLATION: undefined,
            V07_SEARCH: undefined,
            V08_A13_SEARCH: "1",
        });
    }
    return Object.freeze({
        ...profileEnvironment,
        SEARCH_DECISION_DEADLINE_MS: undefined,
        SEARCH_CIRCUIT_BREAKER_MS: undefined,
        V08_A13_SEARCH: "0",
    });
}

function validateProfile(
    root: string,
    profile: IProfileModule,
    protocol: IProtocolModule,
    mode: RunMode,
): { seal: IProfileSeal; environment: Readonly<Record<string, string | undefined>> } {
    const identity = {
        schema: profile.V08_A13_PROFILE_SCHEMA,
        candidateId: profile.V08_A13_CANDIDATE_ID,
        sourceVersion: profile.V08_A13_SOURCE_VERSION,
        productionVersion: profile.V08_A13_PRODUCTION_VERSION,
        opponentVersion: profile.V08_A13_OPPONENT_VERSION,
        sourceCommit: profile.V08_A13_SOURCE_COMMIT,
        sourceTree: profile.V08_A13_SOURCE_TREE,
        genomeSha256: profile.V08_A13_GENOME_SHA256,
        sourceBindingSha256: profile.V08_A13_SOURCE_BINDING_SHA256,
        sourceBehaviorEnvironmentSha256: profile.V08_A13_SOURCE_BEHAVIOR_ENVIRONMENT_SHA256,
    };
    const expectedIdentity = {
        schema: EXPECTED_PROFILE_SCHEMA,
        candidateId: EXPECTED_CANDIDATE_ID,
        sourceVersion: EXPECTED_SOURCE_VERSION,
        productionVersion: EXPECTED_PRODUCTION_VERSION,
        opponentVersion: EXPECTED_OPPONENT_VERSION,
        sourceCommit: EXPECTED_SOURCE_COMMIT,
        sourceTree: EXPECTED_SOURCE_TREE,
        genomeSha256: EXPECTED_GENOME_SHA256,
        sourceBindingSha256: EXPECTED_SOURCE_BINDING_SHA256,
        sourceBehaviorEnvironmentSha256: EXPECTED_SOURCE_BEHAVIOR_ENVIRONMENT_SHA256,
    };
    if (canonicalJson(identity) !== canonicalJson(expectedIdentity)) {
        throw new Error(`A13 profile identity drift in ${root}: ${canonicalJson(identity)}`);
    }
    if (canonicalJson(profile.V08_A13_SEARCH) !== canonicalJson(EXPECTED_SEARCH)) {
        throw new Error(`A13 search profile drift in ${root}: ${canonicalJson(profile.V08_A13_SEARCH)}`);
    }
    if (canonicalJson(profile.V08_A13_POLICY) !== canonicalJson(EXPECTED_POLICY)) {
        throw new Error(`A13 policy profile drift in ${root}: ${canonicalJson(profile.V08_A13_POLICY)}`);
    }
    const computedGenomeSha256 = protocol.fingerprintV08AlignedV1CandidateGenome(profile.V08_A13_GENOME as never);
    if (computedGenomeSha256 !== EXPECTED_GENOME_SHA256 || computedGenomeSha256 !== profile.V08_A13_GENOME_SHA256) {
        throw new Error(
            `A13 genome fingerprint drift in ${root}: exported=${profile.V08_A13_GENOME_SHA256} computed=${computedGenomeSha256}`,
        );
    }
    const profileRecord = profile.V08_A13_PROFILE as Record<string, unknown>;
    if (
        profileRecord.schema !== EXPECTED_PROFILE_SCHEMA ||
        profileRecord.candidateId !== EXPECTED_CANDIDATE_ID ||
        profileRecord.genomeSha256 !== EXPECTED_GENOME_SHA256 ||
        canonicalJson(profileRecord.genome) !== canonicalJson(profile.V08_A13_GENOME) ||
        canonicalJson(profileRecord.search) !== canonicalJson(EXPECTED_SEARCH) ||
        canonicalJson(profileRecord.policy) !== canonicalJson(EXPECTED_POLICY)
    ) {
        throw new Error(`V08_A13_PROFILE aggregate drift in ${root}`);
    }
    const fullEnvironment = profile.buildV08A13SearchEnvironment(EXPECTED_PRODUCTION_VERSION);
    const profileEnvironment = environmentEntries(fullEnvironment);
    const profileEnvironmentSha256 = digest(profileEnvironment);
    if (profileEnvironmentSha256 !== EXPECTED_PROFILE_ENVIRONMENT_SHA256) {
        throw new Error(
            `A13 full environment drift in ${root}: expected=${EXPECTED_PROFILE_ENVIRONMENT_SHA256} actual=${profileEnvironmentSha256}`,
        );
    }
    const environment = activeEnvironment(fullEnvironment, mode);
    const activeEntries = environmentEntries(environment);
    return {
        environment,
        seal: {
            passed: true,
            schema: identity.schema,
            candidateId: identity.candidateId,
            sourceVersion: identity.sourceVersion,
            productionVersion: identity.productionVersion,
            opponentVersion: identity.opponentVersion,
            sourceCommit: identity.sourceCommit,
            sourceTree: identity.sourceTree,
            exportedGenomeSha256: profile.V08_A13_GENOME_SHA256,
            computedGenomeSha256,
            genomeCanonicalSha256: digest(profile.V08_A13_GENOME),
            sourceBindingSha256: profile.V08_A13_SOURCE_BINDING_SHA256,
            sourceBehaviorEnvironmentSha256: profile.V08_A13_SOURCE_BEHAVIOR_ENVIRONMENT_SHA256,
            fullProfileCanonicalSha256: digest(profile.V08_A13_PROFILE),
            profileEnvironmentSha256,
            activeEnvironmentSha256: digest(activeEntries),
            profileEnvironment,
            activeEnvironment: activeEntries,
        },
    };
}

async function loadVariant(label: "baseline" | "candidate", root: string, mode: RunMode): Promise<IVariant> {
    const [army, battle, profile, protocol, productionSearch] = await Promise.all([
        import(pathToFileURL(join(root, "src/simulation/army.ts")).href) as Promise<IArmyModule>,
        import(pathToFileURL(join(root, "src/simulation/battle_engine.ts")).href) as Promise<IBattleModule>,
        import(pathToFileURL(join(root, "src/ai/versions/v0_8_a13_profile.ts")).href) as Promise<IProfileModule>,
        import(
            pathToFileURL(join(root, "src/simulation/optimizer/v0_8_aligned_96h_v1_protocol.ts")).href
        ) as Promise<IProtocolModule>,
        import(pathToFileURL(join(root, "src/simulation/v0_8_a13_search.ts")).href) as Promise<IProductionSearchModule>,
    ]);
    const validated = validateProfile(root, profile, protocol, mode);
    const usesPromotedProductionPath = withEnvironment(validated.environment, () =>
        productionSearch.shouldUseDefaultV08A13Search({
            greenVersion: EXPECTED_PRODUCTION_VERSION,
            redVersion: EXPECTED_PRODUCTION_VERSION,
        }),
    );
    if (usesPromotedProductionPath !== (mode === "production-bounded")) {
        throw new Error(
            `${root} resolved the wrong search construction path for ${mode}: promoted=${usesPromotedProductionPath}`,
        );
    }
    return { label, root, army, battle, environment: validated.environment, profile: validated.seal };
}

function isExperimentEnvironmentKey(key: string): boolean {
    return (
        /^(SEARCH_|V0\d_|Q2_|SIM_|FIGHT_|ROSTER_|A13_|VALUE_DATA$)/.test(key) ||
        key === "COHORT" ||
        key === "FORCE_CREATURES" ||
        key === "LIVETWIN" ||
        key === "SKIP_AUDIT"
    );
}

function scrubExperimentEnvironment(): () => void {
    const saved = new Map<string, string>();
    for (const key of Object.keys(process.env)) {
        if (!isExperimentEnvironmentKey(key)) continue;
        const value = process.env[key];
        if (value !== undefined) saved.set(key, value);
        delete process.env[key];
    }
    return (): void => {
        for (const key of Object.keys(process.env)) {
            if (isExperimentEnvironmentKey(key)) delete process.env[key];
        }
        for (const [key, value] of saved) process.env[key] = value;
    };
}

function withEnvironment<T>(environment: Readonly<Record<string, string | undefined>>, callback: () => T): T {
    const saved = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(environment)) {
        saved.set(key, process.env[key]);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try {
        return callback();
    } finally {
        for (const [key, value] of saved) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

function nonnegativeInteger(value: unknown, name: string): number {
    const number = value === undefined ? 0 : Number(value);
    if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${name} must be a non-negative integer`);
    return number;
}

function addPathStats(target: IPathStats, source: IPathStats): void {
    target.decisionsObserved += source.decisionsObserved;
    target.catalogsObserved += source.catalogsObserved;
    target.catalogsMissing += source.catalogsMissing;
    target.requests += source.requests;
    target.hits += source.hits;
    target.misses += source.misses;
    target.bypasses += source.bypasses;
    target.decisionsWithHits += source.decisionsWithHits;
}

function emptyPathStats(): IPathStats {
    return {
        decisionsObserved: 0,
        catalogsObserved: 0,
        catalogsMissing: 0,
        requests: 0,
        hits: 0,
        misses: 0,
        bypasses: 0,
        decisionsWithHits: 0,
    };
}

function run(
    variant: IVariant,
    seed: number,
    gridType: number,
    maxLaps: number,
    phase: string,
    observePath = false,
): IRun {
    const roster = variant.army.buildRoster(variant.army.makeRng(seed));
    const catalogs: Array<{ getStats: () => unknown }> = [];
    let decisionsObserved = 0;
    const config: Record<string, unknown> = {
        greenVersion: EXPECTED_PRODUCTION_VERSION,
        redVersion: EXPECTED_PRODUCTION_VERSION,
        roster,
        seed,
        gridType,
        maxLaps,
    };
    if (observePath) {
        config.decisionObserver = (observation: unknown): void => {
            decisionsObserved++;
            if (!observation || typeof observation !== "object") return;
            const context = (observation as { context?: { decisionPathCatalog?: unknown } }).context;
            const catalog = context?.decisionPathCatalog;
            if (
                catalog &&
                typeof catalog === "object" &&
                "getStats" in catalog &&
                typeof (catalog as { getStats?: unknown }).getStats === "function"
            ) {
                catalogs.push(catalog as { getStats: () => unknown });
            }
        };
    }
    const started = process.hrtime.bigint();
    const result = withEnvironment(variant.environment, () => variant.battle.runMatch(config));
    const elapsedNs = Number(process.hrtime.bigint() - started);
    if (!Number.isSafeInteger(elapsedNs) || elapsedNs <= 0) {
        throw new Error(`Invalid elapsed time for ${variant.label} ${phase} seed=${seed} gridType=${gridType}`);
    }
    const rejectedGreen = nonnegativeInteger(result.rejectedGreen, "rejectedGreen");
    const rejectedRed = nonnegativeInteger(result.rejectedRed, "rejectedRed");
    const rejected = rejectedGreen + rejectedRed;
    const endReason = String(result.endReason ?? "");
    if (rejected !== 0) {
        throw new Error(
            `Rejected action in ${variant.label} ${phase} seed=${seed} gridType=${gridType}: green=${rejectedGreen} red=${rejectedRed}`,
        );
    }
    if (endReason === "stuck") {
        throw new Error(`Stuck match in ${variant.label} ${phase} seed=${seed} gridType=${gridType}`);
    }
    if (endReason !== "elimination" && endReason !== "turn_cap") {
        throw new Error(
            `Invalid end reason in ${variant.label} ${phase} seed=${seed} gridType=${gridType}: ${endReason}`,
        );
    }
    if (!Array.isArray(result.actions) || !result.placements || typeof result.placements !== "object") {
        throw new Error(`Incomplete match record in ${variant.label} ${phase} seed=${seed} gridType=${gridType}`);
    }
    const path = emptyPathStats();
    path.decisionsObserved = decisionsObserved;
    path.catalogsObserved = catalogs.length;
    path.catalogsMissing = decisionsObserved - catalogs.length;
    for (const catalog of catalogs) {
        const stats = catalog.getStats() as Record<string, unknown>;
        const requests = nonnegativeInteger(stats.requests, "catalog requests");
        const hits = nonnegativeInteger(stats.hits, "catalog hits");
        const misses = nonnegativeInteger(stats.misses, "catalog misses");
        const bypasses = nonnegativeInteger(stats.bypasses, "catalog bypasses");
        if (requests !== hits + misses + bypasses) {
            throw new Error(
                `Catalog accounting mismatch in ${variant.label} ${phase} seed=${seed} gridType=${gridType}`,
            );
        }
        path.requests += requests;
        path.hits += hits;
        path.misses += misses;
        path.bypasses += bypasses;
        if (hits > 0) path.decisionsWithHits++;
    }
    if (observePath && (decisionsObserved === 0 || path.catalogsMissing !== 0)) {
        throw new Error(
            `Root catalog observation gap in ${variant.label} ${phase} seed=${seed} gridType=${gridType}: decisions=${decisionsObserved} catalogs=${catalogs.length}`,
        );
    }
    if (observePath && new Set(catalogs).size !== catalogs.length) {
        throw new Error(
            `Root catalog object survived across decisions in ${variant.label} ${phase} seed=${seed} gridType=${gridType}`,
        );
    }
    return {
        elapsedNs,
        resultSha256: digest(result),
        actionsSha256: digest(result.actions),
        placementsSha256: digest(result.placements),
        rosterSha256: digest(roster),
        endReason,
        rejected,
        path,
    };
}

function semanticPairEqual(baseline: IRun, candidate: IRun): boolean {
    return (
        baseline.resultSha256 === candidate.resultSha256 &&
        baseline.actionsSha256 === candidate.actionsSha256 &&
        baseline.placementsSha256 === candidate.placementsSha256 &&
        baseline.rosterSha256 === candidate.rosterSha256
    );
}

function assertPair(
    baseline: IRun,
    candidate: IRun,
    seed: number,
    gridType: number,
    mode: RunMode,
    phase: string,
): boolean {
    if (baseline.rosterSha256 !== candidate.rosterSha256) {
        throw new Error(`Roster mismatch in ${phase} at seed=${seed} gridType=${gridType}`);
    }
    const equal = semanticPairEqual(baseline, candidate);
    if (mode === "a13-unbounded" && !equal) {
        throw new Error(
            `Unbounded semantic mismatch in ${phase} at seed=${seed} gridType=${gridType}: ${canonicalJson({
                baseline: {
                    result: baseline.resultSha256,
                    actions: baseline.actionsSha256,
                    placements: baseline.placementsSha256,
                },
                candidate: {
                    result: candidate.resultSha256,
                    actions: candidate.actionsSha256,
                    placements: candidate.placementsSha256,
                },
            })}`,
        );
    }
    return equal;
}

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

function quantile(values: readonly number[], probability: number): number {
    if (!values.length) return Number.NaN;
    const sorted = [...values].sort((left, right) => left - right);
    const position = (sorted.length - 1) * probability;
    const lower = Math.floor(position);
    const fraction = position - lower;
    return sorted[lower] + (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]) * fraction;
}

function seedClusterBootstrap(
    rows: readonly ITaskRow[],
    seeds: readonly number[],
    bootstrapSeed: number,
    samples: number,
): IBootstrapIntervals {
    const clusters = seeds.map((seed) => rows.filter((row) => row.seed === seed));
    if (clusters.some((cluster) => cluster.length === 0)) throw new Error("Bootstrap seed cluster is empty");
    let state = bootstrapSeed >>> 0;
    const random = (): number => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
    };
    const totalRatios: number[] = [];
    const geometricRatios: number[] = [];
    for (let sample = 0; sample < samples; sample++) {
        let baselineNs = 0;
        let candidateNs = 0;
        let logRatio = 0;
        let rowCount = 0;
        for (let clusterIndex = 0; clusterIndex < clusters.length; clusterIndex++) {
            const cluster = clusters[Math.floor(random() * clusters.length)];
            for (const row of cluster) {
                baselineNs += row.baselineNs;
                candidateNs += row.candidateNs;
                logRatio += Math.log(row.ratio);
                rowCount++;
            }
        }
        totalRatios.push(candidateNs / baselineNs);
        geometricRatios.push(Math.exp(logRatio / rowCount));
    }
    return {
        totalRatio95: [quantile(totalRatios, 0.025), quantile(totalRatios, 0.975)],
        geometricMeanPairedRatio95: [quantile(geometricRatios, 0.025), quantile(geometricRatios, 0.975)],
    };
}

function sourceSeal(rootInput: string): ISourceSeal {
    const root = requireRoot(rootInput);
    const realRoot = realpathSync(root);
    const src = join(root, "src");
    const entries: ITreeEntry[] = [];
    const visit = (directory: string): void => {
        for (const name of readdirSync(directory).sort()) {
            const path = join(directory, name);
            const stat = lstatSync(path);
            if (stat.isDirectory()) {
                visit(path);
            } else if (stat.isFile()) {
                const bytes = readFileSync(path);
                entries.push({
                    path: relative(src, path),
                    kind: "file",
                    bytes: bytes.byteLength,
                    sha256: sha256(bytes),
                });
            } else if (stat.isSymbolicLink()) {
                const target = readlinkSync(path);
                entries.push({
                    path: relative(src, path),
                    kind: "symlink",
                    bytes: Buffer.byteLength(target),
                    sha256: sha256(target),
                });
            }
        }
    };
    visit(src);
    const fileHash = (path: string): string | null =>
        existsSync(path) && statSync(path).isFile() ? sha256(readFileSync(path)) : null;
    let dependencyRoot: string | null = null;
    const nodeModules = join(root, "node_modules");
    if (existsSync(nodeModules)) {
        try {
            dependencyRoot = realpathSync(nodeModules);
        } catch {
            dependencyRoot = null;
        }
    }
    return {
        entries,
        report: {
            root,
            realRoot,
            dependencyRoot,
            srcEntryCount: entries.length,
            srcBytes: sum(entries.map((entry) => entry.bytes)),
            srcTreeManifestSha256: digest(entries),
            packageJsonSha256: fileHash(join(root, "package.json")),
            selectedFiles: Object.fromEntries(
                SOURCE_FILES.map((relativePath) => [relativePath, fileHash(join(root, relativePath))]),
            ),
        },
    };
}

function sourceIdentity(seal: ISourceSeal): unknown {
    return {
        ...seal.report,
        entriesSha256: digest(seal.entries),
    };
}

function assertSourceUnchanged(before: ISourceSeal, after: ISourceSeal, label: string): void {
    if (canonicalJson(sourceIdentity(before)) !== canonicalJson(sourceIdentity(after))) {
        throw new Error(`${label} source changed during qualification`);
    }
}

function deltaSeal(baseline: ISourceSeal, candidate: ISourceSeal): Record<string, unknown> {
    const baselineEntries = new Map(baseline.entries.map((entry) => [entry.path, entry]));
    const candidateEntries = new Map(candidate.entries.map((entry) => [entry.path, entry]));
    const paths = [...new Set([...baselineEntries.keys(), ...candidateEntries.keys()])].sort();
    const differences = paths
        .filter((path) => canonicalJson(baselineEntries.get(path)) !== canonicalJson(candidateEntries.get(path)))
        .map((path) => {
            const left = baselineEntries.get(path);
            const right = candidateEntries.get(path);
            return {
                path,
                change: !left ? "added" : !right ? "deleted" : "modified",
                baselineKind: left?.kind ?? null,
                candidateKind: right?.kind ?? null,
                baselineBytes: left?.bytes ?? null,
                candidateBytes: right?.bytes ?? null,
                baselineSha256: left?.sha256 ?? null,
                candidateSha256: right?.sha256 ?? null,
            };
        });
    const actualShape = differences.map(({ path, change }) => ({ path, change }));
    const exactExpected = canonicalJson(actualShape) === canonicalJson(EXPECTED_SOURCE_DELTA);
    return {
        exactExpected,
        expected: EXPECTED_SOURCE_DELTA,
        changedEntryCount: differences.length,
        manifestSha256: digest(differences),
        differences,
    };
}

function runnerSeal(): { path: string; bytes: number; sha256: string } {
    const bytes = readFileSync(RUNNER_PATH);
    return { path: RUNNER_PATH, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

async function main(): Promise<void> {
    const options = commandLine();
    if (!options) return;
    const restoreEnvironment = scrubExperimentEnvironment();
    const runnerBefore = runnerSeal();
    try {
        const baselineSourceBefore = sourceSeal(options.baselineRoot);
        const candidateSourceBefore = sourceSeal(options.candidateRoot);
        if (
            baselineSourceBefore.report.packageJsonSha256 === null ||
            baselineSourceBefore.report.packageJsonSha256 !== candidateSourceBefore.report.packageJsonSha256
        ) {
            throw new Error("baseline and candidate package.json are not identical");
        }
        if (
            baselineSourceBefore.report.dependencyRoot === null ||
            baselineSourceBefore.report.dependencyRoot !== candidateSourceBefore.report.dependencyRoot
        ) {
            throw new Error("baseline and candidate must resolve the exact same dependency tree");
        }
        if (baselineSourceBefore.report.srcTreeManifestSha256 === candidateSourceBefore.report.srcTreeManifestSha256) {
            throw new Error("baseline and candidate src trees are identical; no optimization delta to qualify");
        }
        const sourceDelta = deltaSeal(baselineSourceBefore, candidateSourceBefore);
        if (sourceDelta.exactExpected !== true) {
            throw new Error(
                `Unexpected runtime source delta: ${canonicalJson({
                    expected: sourceDelta.expected,
                    actual: (sourceDelta.differences as Array<{ path: string; change: string }>).map(
                        ({ path, change }) => ({ path, change }),
                    ),
                })}`,
            );
        }
        const [baseline, candidate] = await Promise.all([
            loadVariant("baseline", options.baselineRoot, options.mode),
            loadVariant("candidate", options.candidateRoot, options.mode),
        ]);
        if (
            baseline.profile.profileEnvironmentSha256 !== candidate.profile.profileEnvironmentSha256 ||
            baseline.profile.activeEnvironmentSha256 !== candidate.profile.activeEnvironmentSha256 ||
            baseline.profile.computedGenomeSha256 !== candidate.profile.computedGenomeSha256
        ) {
            throw new Error("baseline and candidate A13 profiles are not identical");
        }

        const warmupRows: Array<Record<string, unknown>> = [];
        for (let index = 0; index < options.gridTypes.length; index++) {
            const gridType = options.gridTypes[index];
            const order = index % 2 === 0 ? "AB" : "BA";
            const first =
                order === "AB"
                    ? run(baseline, options.warmupSeed, gridType, 1, "warmup")
                    : run(candidate, options.warmupSeed, gridType, 1, "warmup");
            const second =
                order === "AB"
                    ? run(candidate, options.warmupSeed, gridType, 1, "warmup")
                    : run(baseline, options.warmupSeed, gridType, 1, "warmup");
            const baselineRun = order === "AB" ? first : second;
            const candidateRun = order === "AB" ? second : first;
            warmupRows.push({
                gridType,
                order,
                semanticEqual: assertPair(
                    baselineRun,
                    candidateRun,
                    options.warmupSeed,
                    gridType,
                    options.mode,
                    "warmup",
                ),
                baselineResultSha256: baselineRun.resultSha256,
                candidateResultSha256: candidateRun.resultSha256,
                baselinePlacementsSha256: baselineRun.placementsSha256,
                candidatePlacementsSha256: candidateRun.placementsSha256,
            });
        }

        const tasks = options.seeds.flatMap((seed, seedIndex) =>
            options.gridTypes.map((gridType, gridIndex) => ({ seed, seedIndex, gridType, gridIndex })),
        );
        const rows: ITaskRow[] = [];
        for (let ordinal = 0; ordinal < tasks.length; ordinal++) {
            const task = tasks[ordinal];
            const order = (task.seedIndex + task.gridIndex) % 2 === 0 ? "AB" : "BA";
            const first =
                order === "AB"
                    ? run(baseline, task.seed, task.gridType, options.maxLaps, "timed")
                    : run(candidate, task.seed, task.gridType, options.maxLaps, "timed");
            const second =
                order === "AB"
                    ? run(candidate, task.seed, task.gridType, options.maxLaps, "timed")
                    : run(baseline, task.seed, task.gridType, options.maxLaps, "timed");
            const baselineRun = order === "AB" ? first : second;
            const candidateRun = order === "AB" ? second : first;
            rows.push({
                ordinal,
                order,
                seed: task.seed,
                gridType: task.gridType,
                baselineNs: baselineRun.elapsedNs,
                candidateNs: candidateRun.elapsedNs,
                ratio: candidateRun.elapsedNs / baselineRun.elapsedNs,
                semanticEqual: assertPair(baselineRun, candidateRun, task.seed, task.gridType, options.mode, "timed"),
                resultSha256: baselineRun.resultSha256,
                candidateResultSha256: candidateRun.resultSha256,
                actionsSha256: baselineRun.actionsSha256,
                candidateActionsSha256: candidateRun.actionsSha256,
                placementsSha256: baselineRun.placementsSha256,
                candidatePlacementsSha256: candidateRun.placementsSha256,
                rosterSha256: baselineRun.rosterSha256,
                endReason: baselineRun.endReason,
                candidateEndReason: candidateRun.endReason,
                path: emptyPathStats(),
                instrumentedSemanticEqual: false,
            });
        }

        const pathTotals = emptyPathStats();
        for (const row of rows) {
            const instrumented = run(
                candidate,
                row.seed,
                row.gridType,
                options.maxLaps,
                "root-catalog-instrumentation",
                true,
            );
            row.instrumentedSemanticEqual =
                instrumented.resultSha256 === row.candidateResultSha256 &&
                instrumented.actionsSha256 === row.candidateActionsSha256 &&
                instrumented.placementsSha256 === row.candidatePlacementsSha256 &&
                instrumented.rosterSha256 === row.rosterSha256;
            if (options.mode === "a13-unbounded" && !row.instrumentedSemanticEqual) {
                throw new Error(
                    `Unbounded instrumentation semantic mismatch at seed=${row.seed} gridType=${row.gridType}`,
                );
            }
            row.path = instrumented.path;
            addPathStats(pathTotals, instrumented.path);
        }
        if (pathTotals.catalogsObserved === 0) {
            throw new Error("Candidate root catalog instrumentation observed no catalogs");
        }
        if (pathTotals.hits === 0 || pathTotals.decisionsWithHits === 0) {
            throw new Error("Candidate root catalog instrumentation observed no reused canonical paths");
        }

        const baselineNs = rows.map((row) => row.baselineNs);
        const candidateNs = rows.map((row) => row.candidateNs);
        const ratios = rows.map((row) => row.ratio);
        const geometricRatio = Math.exp(sum(ratios.map(Math.log)) / ratios.length);
        const bootstrap = seedClusterBootstrap(rows, options.seeds, options.bootstrapSeed, options.bootstrapSamples);
        const exactRows = rows.map((row) => ({
            seed: row.seed,
            gridType: row.gridType,
            resultSha256: row.resultSha256,
            candidateResultSha256: row.candidateResultSha256,
            actionsSha256: row.actionsSha256,
            candidateActionsSha256: row.candidateActionsSha256,
            placementsSha256: row.placementsSha256,
            candidatePlacementsSha256: row.candidatePlacementsSha256,
            rosterSha256: row.rosterSha256,
            semanticEqual: row.semanticEqual,
            instrumentedSemanticEqual: row.instrumentedSemanticEqual,
        }));

        const baselineSourceAfter = sourceSeal(options.baselineRoot);
        const candidateSourceAfter = sourceSeal(options.candidateRoot);
        assertSourceUnchanged(baselineSourceBefore, baselineSourceAfter, "baseline");
        assertSourceUnchanged(candidateSourceBefore, candidateSourceAfter, "candidate");
        const runnerAfter = runnerSeal();
        if (canonicalJson(runnerBefore) !== canonicalJson(runnerAfter)) {
            throw new Error("runner changed during qualification");
        }

        const semanticMismatchCount = rows.filter((row) => !row.semanticEqual).length;
        const instrumentationMismatchCount = rows.filter((row) => !row.instrumentedSemanticEqual).length;
        const warmupMismatchCount = warmupRows.filter((row) => row.semanticEqual !== true).length;
        const report = {
            schema: SCHEMA,
            generatedAt: new Date().toISOString(),
            command: {
                mode: options.mode,
                semanticGate: options.mode === "a13-unbounded" ? "required" : "diagnostic",
                seeds: options.seeds,
                gridTypes: options.gridTypes,
                maxLaps: options.maxLaps,
                warmupSeed: options.warmupSeed,
                warmupMaps: options.gridTypes,
                taskCount: rows.length,
                bootstrapSeed: options.bootstrapSeed,
                bootstrapSamples: options.bootstrapSamples,
                bootstrapUnit: "seed (all requested maps retained as one cluster)",
            },
            host: {
                platform: platform(),
                release: release(),
                arch: arch(),
                cpuModel: cpus()[0]?.model ?? "unknown",
                logicalCpus: cpus().length,
                bunVersion: Bun.version,
            },
            profile: {
                passed: true,
                expectedGenomeSha256: EXPECTED_GENOME_SHA256,
                expectedProfileEnvironmentSha256: EXPECTED_PROFILE_ENVIRONMENT_SHA256,
                baseline: baseline.profile,
                candidate: candidate.profile,
                crossRootExact: true,
                deadlinePolicy:
                    options.mode === "a13-unbounded"
                        ? "generic A13 SearchDriver forced with V08_A13_SEARCH=0 and both wall-clock cutoffs unset"
                        : "promoted production A13 constructor forced with V08_A13_SEARCH=1 and 175/275 ms cutoffs",
                searchConstruction:
                    options.mode === "a13-unbounded"
                        ? "generic-unbounded-explicit-rollback"
                        : "promoted-production-bounded-explicit-force",
            },
            source: {
                runner: runnerBefore,
                baseline: baselineSourceBefore.report,
                candidate: candidateSourceBefore.report,
                delta: sourceDelta,
                postflightUnchanged: true,
            },
            warmup: {
                passed: options.mode === "a13-unbounded" ? warmupMismatchCount === 0 : true,
                semanticMismatchCount: warmupMismatchCount,
                rows: warmupRows,
            },
            exactness: {
                required: options.mode === "a13-unbounded",
                passed: semanticMismatchCount === 0 && instrumentationMismatchCount === 0 && warmupMismatchCount === 0,
                taskCount: rows.length,
                rejected: 0,
                stuck: 0,
                semanticMismatchCount,
                instrumentationMismatchCount,
                rowsSha256: digest(exactRows),
                resultsSha256: digest(exactRows.map((row) => row.resultSha256)),
                actionsSha256: digest(exactRows.map((row) => row.actionsSha256)),
                placementsSha256: digest(exactRows.map((row) => row.placementsSha256)),
                rostersSha256: digest(exactRows.map((row) => row.rosterSha256)),
            },
            performance: {
                baselineTotalMs: sum(baselineNs) / 1_000_000,
                candidateTotalMs: sum(candidateNs) / 1_000_000,
                totalRatio: sum(candidateNs) / sum(baselineNs),
                totalRatioSeedClusterBootstrap95: bootstrap.totalRatio95,
                geometricMeanPairedRatio: geometricRatio,
                geometricMeanPairedRatioSeedClusterBootstrap95: bootstrap.geometricMeanPairedRatio95,
                medianPairedRatio: quantile(ratios, 0.5),
                p05PairedRatio: quantile(ratios, 0.05),
                p95PairedRatio: quantile(ratios, 0.95),
                candidateFasterTasks: ratios.filter((ratio) => ratio < 1).length,
                tiedTasks: ratios.filter((ratio) => ratio === 1).length,
                abTasks: rows.filter((row) => row.order === "AB").length,
                baTasks: rows.filter((row) => row.order === "BA").length,
            },
            rootCatalogReuse: {
                ...pathTotals,
                requestHitRate: pathTotals.requests ? pathTotals.hits / pathTotals.requests : 0,
                canonicalHitRate:
                    pathTotals.hits + pathTotals.misses ? pathTotals.hits / (pathTotals.hits + pathTotals.misses) : 0,
                scope: "candidate live-root decision catalogs; rollout catalogs intentionally omit counters",
            },
            rows,
        };
        mkdirSync(dirname(options.out), { recursive: true });
        writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
        console.log(
            JSON.stringify(
                {
                    out: options.out,
                    mode: options.mode,
                    exactness: report.exactness,
                    performance: report.performance,
                    rootCatalogReuse: report.rootCatalogReuse,
                },
                null,
                2,
            ),
        );
    } finally {
        restoreEnvironment();
    }
}

await main();
