/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
    appendFileSync,
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    renameSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import type { ITournamentSummary } from "./tournament";
import {
    buildV08AlignedV1ProductionCandidateCatalog,
    buildV08AlignedV1ProductionCatalogIdentity,
} from "./optimizer/v0_8_aligned_96h_v1_catalog";
import {
    bindV08AlignedV1Candidate,
    fingerprintV08AlignedV1,
    fingerprintV08AlignedV1CandidateGenome,
    normalizeV08AlignedV1CandidateGenome,
    validateV08AlignedV1CandidateBinding,
    type IV08AlignedV1CandidateGenome,
    type IV08AlignedV1CandidateBinding,
} from "./optimizer/v0_8_aligned_96h_v1_protocol";
import {
    V07_ALIGNED_V2_AURA_CASTER_MODES,
    V07_ALIGNED_V2_FORBIDDEN_RUNTIME_ENV,
    V07_ALIGNED_V2_LATE_RANGED_FINISH_WEIGHTS,
    V07_ALIGNED_V2_MELEE_RANGED_TARGET_WEIGHTS,
    V07_ALIGNED_V2_PURE_RANGED_TERMINAL_WEIGHTS,
    isV07AlignedV2BehaviorEnvironmentKey,
} from "./optimizer/v0_7_aligned_96h_v2_protocol";

/**
 * Research-only, resumable v0.8s aggressive-policy campaign.
 *
 * It deliberately invokes the canonical CLIs instead of a lightweight evaluator so every tournament keeps
 * complete action logs. It never edits policy weights, bakes a candidate, deploys, or changes a default.
 *
 * Usage:
 *   bun src/simulation/v0_8_aggressive_12h.ts --output sim-out/v08-aggressive-night \
 *     --hours 8 --concurrency 16 --lanes 3 --unbounded-search
 */

const SCHEMA = "hoc.v0_8_aggressive_campaign.v3" as const;
const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");
const TOURNAMENT_RUNNER = join(REPOSITORY_ROOT, "src/simulation/run_tournament.ts");
const LEVEL4_RUNNER = join(REPOSITORY_ROOT, "src/simulation/v0_8_l4_coverage.ts");
const LIVE_MAPS = "normal,lava,block";
// At screen/validation sizes this effectively requires zero Armageddon-decided games; pooled long-run
// promotion evidence may tolerate at most one per thousand.
const ARMAGEDDON_RATE_GATE = 0.001;
const ARMAGEDDON_SCORE_PENALTY = 2;
const BASE_CANDIDATE_COUNT = 48;
const ADAPTIVE_GENERATOR_VERSION = 1;
const ADAPTIVE_PARENT_COUNT = 4;
const ADAPTIVE_CHILD_TARGET = 24;
// Children reuse the base screen's common-random panel so ranking does not confound candidate and seed.
// Repeated validation below uses untouched seeds to detect panel overfitting.
const ADAPTIVE_SCREEN_SEED = 20_260_719;
const ADAPTIVE_GATE_STEP = 0.005;
const ADAPTIVE_LEAF_BLEND_ALPHAS = [0.15, 0.25] as const;
const LEVEL4_RESERVE_MULTIPLIER = 3;
export const V08_CAMPAIGN_DEFAULT_LANES = 3;

interface ICli {
    output: string;
    hours: number;
    /** Total worker budget across every simultaneously active lane. */
    concurrency: number;
    lanes: number;
    workersPerJob: number;
    maxWorkers: number;
    screenGames: number;
    validationGames: number;
    topCandidates: number;
    level4PairsPerLane: number;
    screenSeed: number;
    level4Seed: number;
    validationSeed: number;
    unboundedSearch: boolean;
}

interface IManifest {
    schema: typeof SCHEMA;
    kind: "manifest";
    researchOnly: true;
    automaticBake: false;
    automaticDeploy: false;
    startedAt: string;
    startedAtMs: number;
    deadlineAt: string;
    deadlineAtMs: number;
    output: string;
    repositoryRoot: string;
    bun: string;
    config: Omit<ICli, "output">;
    liveMaps: typeof LIVE_MAPS;
    armageddonRateGate: typeof ARMAGEDDON_RATE_GATE;
    armageddonScorePenalty: typeof ARMAGEDDON_SCORE_PENALTY;
    adaptive: {
        generatorVersion: typeof ADAPTIVE_GENERATOR_VERSION;
        parentCount: typeof ADAPTIVE_PARENT_COUNT;
        childTarget: typeof ADAPTIVE_CHILD_TARGET;
        screenSeed: number;
        screenGames: number;
        gateStep: typeof ADAPTIVE_GATE_STEP;
        leafBlendAlphas: readonly [0.15, 0.25];
        computeExpansionAllowed: false;
        level4ReserveMultiplier: typeof LEVEL4_RESERVE_MULTIPLIER;
    };
    catalogIdentity: ReturnType<typeof buildV08AlignedV1ProductionCatalogIdentity>;
    candidates: Array<{
        index: number;
        id: string;
        label: string | null;
        genomeSha256: string;
        bindingSha256: string;
        effectiveBehaviorEnvironmentSha256: string;
    }>;
    fingerprint: string;
}

export type JobKind = "screen" | "adaptive" | "level4" | "validation";
const JOB_KINDS: ReadonlySet<JobKind> = new Set(["screen", "adaptive", "level4", "validation"]);

interface IAdaptiveMutation {
    kind: "gate" | "control" | "leaf-blend";
    field: string;
    from: unknown;
    to: unknown;
    donorCandidateId?: string;
    donorGenomeSha256?: string;
    alpha?: number;
}

interface IAdaptiveChild {
    index: number;
    id: string;
    label: string;
    parentCandidateId: string;
    parentCandidateIndex: number;
    parentGenomeSha256: string;
    mutation: IAdaptiveMutation;
    genome: IV08AlignedV1CandidateGenome;
    genomeSha256: string;
    bindingSha256: string;
    behaviorEnvironmentSha256: string;
    effectiveBehaviorEnvironmentSha256: string;
}

interface IAdaptiveCatalog {
    schema: typeof SCHEMA;
    kind: "adaptive-catalog";
    researchOnly: true;
    automaticBake: false;
    automaticDeploy: false;
    manifestFingerprint: string;
    generatorVersion: typeof ADAPTIVE_GENERATOR_VERSION;
    sourceCatalogSha256: string;
    screenEvidenceSha256: string;
    parentCandidateIds: string[];
    parentGenomeSha256: string[];
    childTarget: typeof ADAPTIVE_CHILD_TARGET;
    children: IAdaptiveChild[];
    createdAt: string;
    fingerprint: string;
}

interface IAdaptiveCheckpoint {
    path: string;
    fingerprint: string;
    screenEvidenceSha256: string;
    children: number;
}

export interface ICompletedJob {
    id: string;
    kind: JobKind;
    candidateId: string;
    candidateIndex: number;
    games?: number;
    pairsPerLane?: number;
    baseSeed: number;
    genomeSha256: string;
    bindingSha256: string;
    summaryPath: string;
    manifestFingerprint: string;
    startedAt: string;
    startedAtMs: number;
    completedAt: string;
    durationMs: number;
}

export type IJobSpec = Omit<
    ICompletedJob,
    | "genomeSha256"
    | "bindingSha256"
    | "summaryPath"
    | "manifestFingerprint"
    | "startedAt"
    | "startedAtMs"
    | "completedAt"
    | "durationMs"
>;

interface IActiveJob {
    spec: IJobSpec;
    startedAt: string;
    startedAtMs: number;
    pid: number | null;
}

interface ICheckpoint {
    schema: typeof SCHEMA;
    kind: "checkpoint";
    manifestFingerprint: string;
    phase: "screen" | "adaptive" | "level4" | "validation" | "complete";
    validationRound: number;
    completed: ICompletedJob[];
    adaptiveCatalog: IAdaptiveCheckpoint | null;
    validationCandidateIds: string[];
    activeJobs: Record<string, IActiveJob>;
    updatedAt: string;
}

interface IResultFile {
    schema: typeof SCHEMA;
    kind: "job-result";
    manifestFingerprint: string;
    job: ICompletedJob;
    summary: unknown;
}

const ADMISSION_MIN_DURATION_SAMPLES = 3;
const ADMISSION_FALLBACK_CPU_MS_PER_GAME = 2_000;
const ADMISSION_SAFETY_MARGIN_MS = 30_000;

interface ITournamentSummaryWithReached extends ITournamentSummary {
    armageddonReached: number;
}

interface IRankedCandidate {
    rank: number;
    candidateId: string;
    candidateIndex: number;
    label: string | null;
    genomeSha256: string;
    tournamentRuns: number;
    validationRuns: number;
    validationGames: number;
    hasValidationEvidence: boolean;
    games: number;
    winsA: number;
    winsB: number;
    draws: number;
    decisiveWinRate: number;
    armageddonReached: number;
    armageddonDecided: number;
    armageddonRate: number;
    level4Games: number;
    level4ArmageddonReached: number;
    level4ArmageddonRate: number;
    level4CoveragePassed: boolean;
    passesArmageddonGate: boolean;
    promotionEligible: boolean;
    score: number;
    level4SummaryPaths: string[];
}

interface ICandidateMetadata {
    index: number;
    id: string;
    label: string | null;
    genomeSha256: string;
    bindingSha256: string;
}

interface ICandidateRuntime extends ICandidateMetadata {
    binding: IV08AlignedV1CandidateBinding;
    bindingSha256: string;
}

type CandidateRegistry = Map<string, ICandidateRuntime>;

const flagValue = (argv: readonly string[], name: string): string | undefined => {
    const inline = argv.find((argument) => argument.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
};

const positiveNumber = (raw: string | undefined, fallback: number, name: string): number => {
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
    return value;
};

const positiveInteger = (raw: string | undefined, fallback: number, name: string): number => {
    const value = positiveNumber(raw, fallback, name);
    if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`);
    return value;
};

const uint32Integer = (raw: string | undefined, fallback: number, name: string): number => {
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
        throw new Error(`${name} must be an integer in [0, 2^32-1]`);
    }
    return value;
};

export interface IWorkerPlan {
    coreBudget: number;
    lanes: number;
    workersPerJob: number;
    maxWorkers: number;
}

/** Divide one host-wide worker budget across fixed lanes without oversubscribing partial or full batches. */
export function buildWorkerPlan(coreBudget: number, lanes: number): IWorkerPlan {
    if (!Number.isSafeInteger(coreBudget) || coreBudget < 1) throw new Error("coreBudget must be a positive integer");
    if (!Number.isSafeInteger(lanes) || lanes < 1) throw new Error("lanes must be a positive integer");
    if (lanes > coreBudget) throw new Error("lanes cannot exceed the total worker budget");
    const workersPerJob = Math.floor(coreBudget / lanes);
    return { coreBudget, lanes, workersPerJob, maxWorkers: workersPerJob * lanes };
}

export interface IJobDurationSample {
    kind: JobKind;
    games?: number;
    pairsPerLane?: number;
    durationMs: number;
}

type JobWork = Pick<IJobSpec, "kind" | "games" | "pairsPerLane">;

/** Convert every runner shape to actual simulated games so duration samples are comparable. */
export function jobWorkUnits(job: JobWork): number {
    if (job.kind === "level4") {
        if (!Number.isSafeInteger(job.pairsPerLane) || (job.pairsPerLane ?? 0) < 1 || job.games !== undefined) {
            throw new Error("A level-4 job must specify only a positive pairsPerLane count");
        }
        return job.pairsPerLane! * 16;
    }
    if (!Number.isSafeInteger(job.games) || (job.games ?? 0) < 1 || job.pairsPerLane !== undefined) {
        throw new Error("A tournament job must specify only a positive games count");
    }
    return job.games!;
}

function percentile95(values: readonly number[]): number {
    if (!values.length) throw new Error("Cannot calculate a percentile without samples");
    const ordered = [...values].sort((left, right) => left - right);
    return ordered[Math.ceil(ordered.length * 0.95) - 1]!;
}

function estimatedMillisecondsPerWorkUnit(
    kind: JobKind,
    completed: readonly IJobDurationSample[],
    workersPerJob: number,
): number {
    if (!Number.isSafeInteger(workersPerJob) || workersPerJob < 1) {
        throw new Error("workersPerJob must be a positive integer");
    }
    const fallback = ADMISSION_FALLBACK_CPU_MS_PER_GAME / workersPerJob;
    const rates = completed
        .filter((job) => job.kind === kind && Number.isFinite(job.durationMs) && job.durationMs >= 0)
        .map((job) => job.durationMs / jobWorkUnits(job));
    if (!rates.length) return fallback;
    // Until there is enough history for a meaningful percentile, retain the slowest observation. Once the
    // cohort is populated, p95 avoids one pathological interruption making every later batch inadmissible.
    const observed = rates.length < ADMISSION_MIN_DURATION_SAMPLES ? Math.max(...rates) : percentile95(rates);
    return Math.max(fallback, observed);
}

/** Estimate a parallel batch: its wall duration is governed by its slowest lane. */
export function estimateBatchDurationMs(
    jobs: readonly JobWork[],
    completed: readonly IJobDurationSample[],
    workersPerJob: number,
): number {
    if (!jobs.length) return 0;
    return Math.ceil(
        Math.max(
            ...jobs.map(
                (job) => jobWorkUnits(job) * estimatedMillisecondsPerWorkUnit(job.kind, completed, workersPerJob),
            ),
        ),
    );
}

/** Sequential batches compose one indivisible admission unit (notably a complete validation round). */
export function estimateJobBatchesDurationMs(
    batches: readonly (readonly JobWork[])[],
    completed: readonly IJobDurationSample[],
    workersPerJob: number,
): number {
    return batches.reduce((duration, batch) => duration + estimateBatchDurationMs(batch, completed, workersPerJob), 0);
}

export interface IJobBatchesAdmission {
    batches: readonly (readonly JobWork[])[];
    completed: readonly IJobDurationSample[];
    workersPerJob: number;
    nowMs: number;
    deadlineAtMs: number;
    safetyMarginMs?: number;
}

/** Admit work only when its p95/fallback estimate plus shutdown margin fits before the hard wall deadline. */
export function canAdmitJobBatches(options: IJobBatchesAdmission): boolean {
    if (!Number.isFinite(options.nowMs) || !Number.isFinite(options.deadlineAtMs)) {
        throw new Error("Admission timestamps must be finite");
    }
    const safetyMarginMs = options.safetyMarginMs ?? ADMISSION_SAFETY_MARGIN_MS;
    if (!Number.isFinite(safetyMarginMs) || safetyMarginMs < 0) {
        throw new Error("safetyMarginMs must be non-negative");
    }
    const duration = estimateJobBatchesDurationMs(options.batches, options.completed, options.workersPerJob);
    return options.nowMs + duration + safetyMarginMs <= options.deadlineAtMs;
}

function parseCli(argv: readonly string[]): ICli {
    if (argv.includes("--help") || argv.includes("-h")) {
        console.log(
            "Usage: bun src/simulation/v0_8_aggressive_12h.ts [--output DIR] [--hours 12] " +
                "[--concurrency TOTAL_WORKERS] [--screen-games 256] [--validation-games 1024] " +
                `[--lanes ${V08_CAMPAIGN_DEFAULT_LANES}] [--top 4] [--l4-pairs 16] [--screen-seed N] ` +
                "[--level4-seed N] " +
                "[--validation-seed N] [--unbounded-search]",
        );
        process.exit(0);
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const output = resolve(
        flagValue(argv, "--output") ?? join(REPOSITORY_ROOT, "sim-out", `v08-aggressive-12h-${stamp}`),
    );
    const concurrency = positiveInteger(flagValue(argv, "--concurrency"), 16, "--concurrency");
    const screenGames = positiveInteger(flagValue(argv, "--screen-games"), 256, "--screen-games");
    const validationGames = positiveInteger(flagValue(argv, "--validation-games"), 1024, "--validation-games");
    if (screenGames % 2 || validationGames % 2) throw new Error("Tournament game counts must be even for seat pairs");
    const lanes = positiveInteger(flagValue(argv, "--lanes"), V08_CAMPAIGN_DEFAULT_LANES, "--lanes");
    const workerPlan = buildWorkerPlan(concurrency, lanes);
    return {
        output,
        hours: positiveNumber(flagValue(argv, "--hours"), 12, "--hours"),
        concurrency,
        lanes,
        workersPerJob: workerPlan.workersPerJob,
        maxWorkers: workerPlan.maxWorkers,
        screenGames,
        validationGames,
        topCandidates: positiveInteger(flagValue(argv, "--top"), 4, "--top"),
        level4PairsPerLane: positiveInteger(flagValue(argv, "--l4-pairs"), 16, "--l4-pairs"),
        screenSeed: uint32Integer(flagValue(argv, "--screen-seed"), ADAPTIVE_SCREEN_SEED, "--screen-seed"),
        level4Seed: uint32Integer(flagValue(argv, "--level4-seed"), 30_260_719, "--level4-seed"),
        validationSeed: uint32Integer(flagValue(argv, "--validation-seed"), 40_260_719, "--validation-seed"),
        unboundedSearch: argv.includes("--unbounded-search"),
    };
}

function atomicJson(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    renameSync(temporary, path);
}

function readJson<T>(path: string): T {
    return JSON.parse(readFileSync(path, "utf8")) as T;
}

function candidateId(index: number): string {
    return `c${String(index).padStart(2, "0")}`;
}

export function effectiveBehaviorEnvironment(
    binding: IV08AlignedV1CandidateBinding,
    auditPath: string,
    unboundedSearch = false,
): Record<string, string> {
    const environment: Record<string, string> = {
        ...binding.behaviorEnvironment,
        SEARCH_AUDIT: auditPath,
        V08_AGGRESSIVE: "1",
        LIVETWIN: "1",
    };
    if (unboundedSearch) {
        // Fitness must be reproducible across hosts. Wall-clock fallbacks are validated later as an operational
        // envelope; they must not silently turn CPU contention into a different policy during model selection.
        environment.SEARCH_DECISION_DEADLINE_MS = "";
        environment.SEARCH_CIRCUIT_BREAKER_MS = "";
    }
    return environment;
}

function childEnvironment(
    binding: IV08AlignedV1CandidateBinding,
    auditPath: string,
    unboundedSearch: boolean,
): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(environment)) {
        if (
            isV07AlignedV2BehaviorEnvironmentKey(key) ||
            key.startsWith("V08_") ||
            key.includes("LIGHTWEIGHT") ||
            V07_ALIGNED_V2_FORBIDDEN_RUNTIME_ENV.includes(key as (typeof V07_ALIGNED_V2_FORBIDDEN_RUNTIME_ENV)[number])
        ) {
            delete environment[key];
        }
    }
    delete environment.SIM_NO_ACTIONS;
    Object.assign(environment, effectiveBehaviorEnvironment(binding, auditPath, unboundedSearch));
    environment.V08_AGGRESSIVE = "1";
    environment.LIVETWIN = "1";
    delete environment.SIM_NO_ACTIONS;
    return environment;
}

function latestSummary(directory: string): string {
    const summaries = readdirSync(directory)
        .filter((name) => name.endsWith(".summary.json"))
        .map((name) => join(directory, name))
        .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
    if (!summaries[0]) throw new Error(`Runner produced no summary in ${directory}`);
    return summaries[0];
}

function tournamentJsonl(directory: string): string {
    const files = readdirSync(directory)
        .filter((name) => name.startsWith("v0.8s_vs_v0.7_") && name.endsWith(".jsonl"))
        .map((name) => join(directory, name))
        .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
    if (!files[0]) throw new Error(`Runner produced no tournament JSONL in ${directory}`);
    return files[0];
}

function countArmageddonReached(path: string): number {
    let reached = 0;
    for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line) continue;
        const record = JSON.parse(line) as { result?: { attrition?: { reachedArmageddon?: unknown } } };
        reached += Number(record.result?.attrition?.reachedArmageddon === true);
    }
    return reached;
}

interface IAdaptiveProposal {
    genome: IV08AlignedV1CandidateGenome;
    mutation: IAdaptiveMutation;
}

function adaptiveCandidateId(index: number): string {
    return `a${String(index).padStart(2, "0")}`;
}

function controlProposal<K extends keyof IV08AlignedV1CandidateGenome["controls"]>(
    parent: IV08AlignedV1CandidateGenome,
    field: K,
    to: IV08AlignedV1CandidateGenome["controls"][K],
): IAdaptiveProposal {
    const genome = structuredClone(parent);
    const from = genome.controls[field];
    genome.controls[field] = to;
    return { genome, mutation: { kind: "control", field: `controls.${field}`, from, to } };
}

function adaptiveProposals(
    parent: { row: IRankedCandidate; genome: IV08AlignedV1CandidateGenome },
    parents: readonly { row: IRankedCandidate; genome: IV08AlignedV1CandidateGenome }[],
): IAdaptiveProposal[] {
    const proposals: IAdaptiveProposal[] = [];
    const leafProposals: IAdaptiveProposal[] = [];
    for (const delta of [-ADAPTIVE_GATE_STEP, ADAPTIVE_GATE_STEP]) {
        const genome = structuredClone(parent.genome);
        const from = genome.search.gate;
        genome.search.gate = Number(Math.max(0, Math.min(0.05, from + delta)).toFixed(6));
        proposals.push({
            genome,
            mutation: { kind: "gate", field: "search.gate", from, to: genome.search.gate },
        });
    }

    for (const donor of parents) {
        if (donor.row.candidateId === parent.row.candidateId) continue;
        if (
            parent.genome.search.leafMode !== "model" ||
            donor.genome.search.leafMode !== "model" ||
            !parent.genome.search.leaf ||
            !donor.genome.search.leaf ||
            parent.genome.search.leaf.w.length !== donor.genome.search.leaf.w.length
        ) {
            continue;
        }
        for (const alpha of ADAPTIVE_LEAF_BLEND_ALPHAS) {
            const genome = structuredClone(parent.genome);
            const source = parent.genome.search.leaf;
            const donorLeaf = donor.genome.search.leaf;
            genome.search.leaf = {
                b: source.b * (1 - alpha) + donorLeaf.b * alpha,
                w: source.w.map((weight, index) => weight * (1 - alpha) + donorLeaf.w[index]! * alpha),
            };
            leafProposals.push({
                genome,
                mutation: {
                    kind: "leaf-blend",
                    field: "search.leaf",
                    from: fingerprintV08AlignedV1(source),
                    to: fingerprintV08AlignedV1(genome.search.leaf),
                    donorCandidateId: donor.row.candidateId,
                    donorGenomeSha256: donor.row.genomeSha256,
                    alpha,
                },
            });
        }
    }

    proposals.push(controlProposal(parent.genome, "placementReveal", !parent.genome.controls.placementReveal));
    proposals.push(
        controlProposal(parent.genome, "denseMeleeMagicIsolation", !parent.genome.controls.denseMeleeMagicIsolation),
    );
    for (const value of V07_ALIGNED_V2_AURA_CASTER_MODES) {
        if (value !== parent.genome.controls.auraCasterMode) {
            proposals.push(controlProposal(parent.genome, "auraCasterMode", value));
        }
    }
    for (const value of V07_ALIGNED_V2_MELEE_RANGED_TARGET_WEIGHTS) {
        if (value !== parent.genome.controls.meleeRangedTargetWeight) {
            proposals.push(controlProposal(parent.genome, "meleeRangedTargetWeight", value));
        }
    }
    if (parent.genome.controls.pureRangedTerminalWeight === 0) {
        for (const value of V07_ALIGNED_V2_LATE_RANGED_FINISH_WEIGHTS) {
            if (value !== parent.genome.controls.lateRangedFinishWeight) {
                proposals.push(controlProposal(parent.genome, "lateRangedFinishWeight", value));
            }
        }
    }
    if (parent.genome.controls.lateRangedFinishWeight === 0) {
        for (const value of V07_ALIGNED_V2_PURE_RANGED_TERMINAL_WEIGHTS) {
            if (value !== parent.genome.controls.pureRangedTerminalWeight) {
                proposals.push(controlProposal(parent.genome, "pureRangedTerminalWeight", value));
            }
        }
    }
    return [...proposals.slice(0, 2), ...leafProposals.slice(0, 2), ...proposals.slice(2), ...leafProposals.slice(2)];
}

function assertAdaptiveComputeEnvelope(
    parent: IV08AlignedV1CandidateGenome,
    child: IV08AlignedV1CandidateGenome,
): void {
    const parentCompute = {
        leafMode: parent.search.leafMode,
        horizon: parent.search.horizon,
        rollouts: parent.search.rollouts,
        includeMoves: parent.search.includeMoves,
        maxMelee: parent.search.maxMelee,
        maxShots: parent.search.maxShots,
        maxThrows: parent.search.maxThrows,
        decisionDeadlineMs: parent.controls.decisionDeadlineMs,
    };
    const childCompute = {
        leafMode: child.search.leafMode,
        horizon: child.search.horizon,
        rollouts: child.search.rollouts,
        includeMoves: child.search.includeMoves,
        maxMelee: child.search.maxMelee,
        maxShots: child.search.maxShots,
        maxThrows: child.search.maxThrows,
        decisionDeadlineMs: child.controls.decisionDeadlineMs,
    };
    if (
        fingerprintV08AlignedV1(parentCompute) !== fingerprintV08AlignedV1(childCompute) ||
        child.search.includeMoves !== true
    ) {
        throw new Error("Adaptive child expanded or changed its reviewed search workload");
    }
}

function assertAdaptiveMutationScope(
    parent: IV08AlignedV1CandidateGenome,
    child: IV08AlignedV1CandidateGenome,
    mutation: IAdaptiveMutation,
): void {
    const parentSearch = { ...parent.search, label: undefined };
    const childSearch = { ...child.search, label: undefined };
    if (mutation.kind === "gate") {
        const expected = Number(child.search.gate) - Number(parent.search.gate);
        if (
            mutation.field !== "search.gate" ||
            Math.abs(Math.abs(expected) - ADAPTIVE_GATE_STEP) > 1e-9 ||
            fingerprintV08AlignedV1(mutation.from) !== fingerprintV08AlignedV1(parent.search.gate) ||
            fingerprintV08AlignedV1(mutation.to) !== fingerprintV08AlignedV1(child.search.gate) ||
            fingerprintV08AlignedV1(parent.controls) !== fingerprintV08AlignedV1(child.controls) ||
            fingerprintV08AlignedV1({ ...parentSearch, gate: child.search.gate }) !==
                fingerprintV08AlignedV1(childSearch)
        ) {
            throw new Error("Adaptive gate mutation changed more than its reviewed field");
        }
        return;
    }
    if (mutation.kind === "leaf-blend") {
        if (
            mutation.field !== "search.leaf" ||
            !ADAPTIVE_LEAF_BLEND_ALPHAS.includes(mutation.alpha as (typeof ADAPTIVE_LEAF_BLEND_ALPHAS)[number]) ||
            mutation.from !== fingerprintV08AlignedV1(parent.search.leaf) ||
            mutation.to !== fingerprintV08AlignedV1(child.search.leaf) ||
            fingerprintV08AlignedV1(parent.controls) !== fingerprintV08AlignedV1(child.controls) ||
            fingerprintV08AlignedV1({ ...parentSearch, leaf: child.search.leaf }) !==
                fingerprintV08AlignedV1(childSearch)
        ) {
            throw new Error("Adaptive leaf blend changed more than its reviewed field");
        }
        return;
    }
    const field = mutation.field.replace(/^controls\./, "") as keyof IV08AlignedV1CandidateGenome["controls"];
    const allowedControlFields = new Set<keyof IV08AlignedV1CandidateGenome["controls"]>([
        "lateRangedFinishWeight",
        "pureRangedTerminalWeight",
        "meleeRangedTargetWeight",
        "placementReveal",
        "denseMeleeMagicIsolation",
        "auraCasterMode",
    ]);
    const expectedControls = { ...parent.controls, [field]: child.controls[field] };
    if (
        !mutation.field.startsWith("controls.") ||
        !allowedControlFields.has(field) ||
        fingerprintV08AlignedV1(parentSearch) !== fingerprintV08AlignedV1(childSearch) ||
        fingerprintV08AlignedV1(expectedControls) !== fingerprintV08AlignedV1(child.controls) ||
        fingerprintV08AlignedV1(mutation.from) !== fingerprintV08AlignedV1(parent.controls[field]) ||
        fingerprintV08AlignedV1(mutation.to) !== fingerprintV08AlignedV1(child.controls[field])
    ) {
        throw new Error("Adaptive control mutation changed more than one reviewed field");
    }
}

function candidateMetadata(manifest: IManifest, adaptive: IAdaptiveCatalog | null): Map<string, ICandidateMetadata> {
    const entries: ICandidateMetadata[] = manifest.candidates.map(
        ({ index, id, label, genomeSha256, bindingSha256 }) => ({
            index,
            id,
            label,
            genomeSha256,
            bindingSha256,
        }),
    );
    if (adaptive) {
        entries.push(
            ...adaptive.children.map(({ index, id, label, genomeSha256, bindingSha256 }) => ({
                index,
                id,
                label,
                genomeSha256,
                bindingSha256,
            })),
        );
    }
    const registry = new Map(entries.map((entry) => [entry.id, entry]));
    if (registry.size !== entries.length) throw new Error("Candidate ids are not unique");
    return registry;
}

export function selectValidationCandidateIds(
    rows: readonly Pick<IRankedCandidate, "candidateId" | "level4CoveragePassed">[],
    count: number,
): string[] {
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("validation candidate count must be positive");
    return rows
        .filter((row) => row.level4CoveragePassed)
        .slice(0, count)
        .map((row) => row.candidateId);
}

export interface IV08CampaignPromotionEvidence {
    unboundedSearch: boolean;
    hasValidationEvidence: boolean;
    level4CoveragePassed: boolean;
    armageddonRate: number;
    level4ArmageddonRate: number;
}

/** Research fitness is never deployable until replayed inside the reviewed bounded operational envelope. */
export function isV08CampaignPromotionEligible(evidence: IV08CampaignPromotionEvidence): boolean {
    return (
        !evidence.unboundedSearch &&
        evidence.hasValidationEvidence &&
        evidence.level4CoveragePassed &&
        evidence.armageddonRate <= ARMAGEDDON_RATE_GATE &&
        evidence.level4ArmageddonRate <= ARMAGEDDON_RATE_GATE
    );
}

const activeChildren = new Set<ChildProcess>();
let stopRequested = false;

async function runChild(
    args: string[],
    environment: NodeJS.ProcessEnv,
    logPath: string,
    deadlineAtMs: number,
    onSpawn: (pid: number | null) => void,
): Promise<"completed" | "deadline"> {
    if (Date.now() >= deadlineAtMs || stopRequested) return "deadline";
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `\n[${new Date().toISOString()}] ${process.execPath} ${args.join(" ")}\n`);
    const logFd = openSync(logPath, "a");
    const child = spawn(process.execPath, args, {
        cwd: REPOSITORY_ROOT,
        env: environment,
        stdio: ["ignore", logFd, logFd],
    });
    closeSync(logFd);
    activeChildren.add(child);
    try {
        onSpawn(child.pid ?? null);
    } catch (error) {
        activeChildren.delete(child);
        child.kill("SIGTERM");
        throw error;
    }
    let deadlineKilled = false;
    const timer = setTimeout(
        () => {
            deadlineKilled = true;
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
        },
        Math.max(1, deadlineAtMs - Date.now()),
    );
    timer.unref();
    let result: { code: number | null; signal: NodeJS.Signals | null };
    try {
        result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((accept, reject) => {
            child.once("error", reject);
            child.once("exit", (code, signal) => accept({ code, signal }));
        });
    } finally {
        clearTimeout(timer);
        activeChildren.delete(child);
    }
    if (deadlineKilled || stopRequested) return "deadline";
    if (result.code !== 0) {
        throw new Error(`Child failed (${result.code ?? result.signal ?? "unknown"}); see ${logPath}`);
    }
    return "completed";
}

function tournamentSummary(value: unknown, path: string): ITournamentSummaryWithReached {
    const summary = value as Partial<ITournamentSummaryWithReached>;
    if (
        summary.versionA !== "v0.8s" ||
        summary.versionB !== "v0.7" ||
        !Number.isSafeInteger(summary.games) ||
        !summary.a ||
        !summary.b ||
        typeof summary.winRateA !== "number" ||
        !Number.isSafeInteger(summary.armageddonDecided) ||
        !Number.isSafeInteger(summary.armageddonReached)
    ) {
        throw new Error(`Invalid tournament summary: ${path}`);
    }
    return summary as ITournamentSummaryWithReached;
}

function buildManifest(cli: ICli, bindings: IV08AlignedV1CandidateBinding[]): IManifest {
    const startedAtMs = Date.now();
    const config = {
        hours: cli.hours,
        concurrency: cli.concurrency,
        lanes: cli.lanes,
        screenGames: cli.screenGames,
        validationGames: cli.validationGames,
        topCandidates: Math.min(cli.topCandidates, bindings.length),
        level4PairsPerLane: cli.level4PairsPerLane,
        screenSeed: cli.screenSeed,
        level4Seed: cli.level4Seed,
        validationSeed: cli.validationSeed,
        workersPerJob: cli.workersPerJob,
        maxWorkers: cli.maxWorkers,
        unboundedSearch: cli.unboundedSearch,
    };
    const unsigned = {
        schema: SCHEMA,
        kind: "manifest" as const,
        researchOnly: true as const,
        automaticBake: false as const,
        automaticDeploy: false as const,
        startedAt: new Date(startedAtMs).toISOString(),
        startedAtMs,
        deadlineAt: new Date(startedAtMs + cli.hours * 60 * 60 * 1000).toISOString(),
        deadlineAtMs: startedAtMs + cli.hours * 60 * 60 * 1000,
        output: cli.output,
        repositoryRoot: REPOSITORY_ROOT,
        bun: process.execPath,
        config,
        liveMaps: LIVE_MAPS as typeof LIVE_MAPS,
        armageddonRateGate: ARMAGEDDON_RATE_GATE as typeof ARMAGEDDON_RATE_GATE,
        armageddonScorePenalty: ARMAGEDDON_SCORE_PENALTY as typeof ARMAGEDDON_SCORE_PENALTY,
        adaptive: {
            generatorVersion: ADAPTIVE_GENERATOR_VERSION as typeof ADAPTIVE_GENERATOR_VERSION,
            parentCount: ADAPTIVE_PARENT_COUNT as typeof ADAPTIVE_PARENT_COUNT,
            childTarget: ADAPTIVE_CHILD_TARGET as typeof ADAPTIVE_CHILD_TARGET,
            screenSeed: cli.screenSeed,
            screenGames: cli.screenGames,
            gateStep: ADAPTIVE_GATE_STEP as typeof ADAPTIVE_GATE_STEP,
            leafBlendAlphas: ADAPTIVE_LEAF_BLEND_ALPHAS,
            computeExpansionAllowed: false as const,
            level4ReserveMultiplier: LEVEL4_RESERVE_MULTIPLIER as typeof LEVEL4_RESERVE_MULTIPLIER,
        },
        catalogIdentity: buildV08AlignedV1ProductionCatalogIdentity(),
        candidates: bindings.map((binding, index) => {
            const environment = effectiveBehaviorEnvironment(binding, "<job-audit-path>", cli.unboundedSearch);
            return {
                index,
                id: candidateId(index),
                label: binding.genome.search.label ?? null,
                genomeSha256: binding.genomeSha256,
                bindingSha256: fingerprintV08AlignedV1(binding),
                effectiveBehaviorEnvironmentSha256: fingerprintV08AlignedV1(environment),
            };
        }),
    };
    return { ...unsigned, fingerprint: fingerprintV08AlignedV1(unsigned) };
}

function loadOrCreateManifest(cli: ICli, bindings: IV08AlignedV1CandidateBinding[]): IManifest {
    const path = join(cli.output, "manifest.json");
    if (!existsSync(path)) {
        mkdirSync(cli.output, { recursive: true });
        const manifest = buildManifest(cli, bindings);
        atomicJson(path, manifest);
        return manifest;
    }
    const manifest = readJson<IManifest>(path);
    const requested = {
        hours: cli.hours,
        concurrency: cli.concurrency,
        lanes: cli.lanes,
        screenGames: cli.screenGames,
        validationGames: cli.validationGames,
        topCandidates: Math.min(cli.topCandidates, bindings.length),
        level4PairsPerLane: cli.level4PairsPerLane,
        screenSeed: cli.screenSeed,
        level4Seed: cli.level4Seed,
        validationSeed: cli.validationSeed,
        workersPerJob: cli.workersPerJob,
        maxWorkers: cli.maxWorkers,
        unboundedSearch: cli.unboundedSearch,
    };
    const expectedCatalog = buildV08AlignedV1ProductionCatalogIdentity();
    if (
        manifest.schema !== SCHEMA ||
        manifest.kind !== "manifest" ||
        manifest.fingerprint !== fingerprintV08AlignedV1({ ...manifest, fingerprint: undefined }) ||
        JSON.stringify(manifest.config) !== JSON.stringify(requested) ||
        manifest.catalogIdentity.catalogSha256 !== expectedCatalog.catalogSha256 ||
        manifest.adaptive?.generatorVersion !== ADAPTIVE_GENERATOR_VERSION ||
        manifest.adaptive.parentCount !== ADAPTIVE_PARENT_COUNT ||
        manifest.adaptive.childTarget !== ADAPTIVE_CHILD_TARGET ||
        manifest.adaptive.screenSeed !== cli.screenSeed ||
        manifest.adaptive.screenGames !== cli.screenGames ||
        manifest.adaptive.computeExpansionAllowed !== false ||
        manifest.adaptive.level4ReserveMultiplier !== LEVEL4_RESERVE_MULTIPLIER ||
        manifest.candidates.length !== bindings.length ||
        manifest.candidates.some((candidate, index) => candidate.genomeSha256 !== bindings[index]?.genomeSha256)
    ) {
        throw new Error(`Existing campaign manifest is incompatible or corrupt: ${path}`);
    }
    return manifest;
}

function normalizedJobSpec(job: IJobSpec): Record<string, unknown> {
    return {
        id: job.id,
        kind: job.kind,
        candidateId: job.candidateId,
        candidateIndex: job.candidateIndex,
        games: job.games ?? null,
        pairsPerLane: job.pairsPerLane ?? null,
        baseSeed: job.baseSeed,
    };
}

function completedJobSpec(job: ICompletedJob): IJobSpec {
    return {
        id: job.id,
        kind: job.kind,
        candidateId: job.candidateId,
        candidateIndex: job.candidateIndex,
        ...(job.games === undefined ? {} : { games: job.games }),
        ...(job.pairsPerLane === undefined ? {} : { pairsPerLane: job.pairsPerLane }),
        baseSeed: job.baseSeed,
    };
}

function assertJobSpec(spec: IJobSpec, context: string): void {
    if (
        typeof spec.id !== "string" ||
        !spec.id ||
        !/^[a-z0-9][a-z0-9._-]*$/i.test(spec.id) ||
        !JOB_KINDS.has(spec.kind) ||
        typeof spec.candidateId !== "string" ||
        !spec.candidateId ||
        !/^[a-z0-9][a-z0-9._-]*$/i.test(spec.candidateId) ||
        !Number.isSafeInteger(spec.candidateIndex) ||
        spec.candidateIndex < 0 ||
        !Number.isSafeInteger(spec.baseSeed) ||
        spec.baseSeed < 0 ||
        spec.baseSeed > 0xffffffff
    ) {
        throw new Error(`${context} has an invalid job specification`);
    }
    jobWorkUnits(spec);
}

function assertCompletedJob(job: ICompletedJob, manifest: IManifest, context: string): void {
    const spec = completedJobSpec(job);
    assertJobSpec(spec, context);
    const completedAtMs = Date.parse(job.completedAt);
    if (
        job.manifestFingerprint !== manifest.fingerprint ||
        typeof job.genomeSha256 !== "string" ||
        !job.genomeSha256 ||
        typeof job.bindingSha256 !== "string" ||
        !job.bindingSha256 ||
        typeof job.summaryPath !== "string" ||
        !job.summaryPath ||
        !Number.isSafeInteger(job.startedAtMs) ||
        Date.parse(job.startedAt) !== job.startedAtMs ||
        !Number.isSafeInteger(completedAtMs) ||
        completedAtMs < job.startedAtMs ||
        !Number.isSafeInteger(job.durationMs) ||
        job.durationMs !== completedAtMs - job.startedAtMs
    ) {
        throw new Error(`${context} has invalid completion provenance`);
    }
}

function assertJobMatchesSpec(
    job: ICompletedJob,
    spec: IJobSpec,
    candidate: Pick<ICandidateRuntime, "id" | "index" | "genomeSha256" | "bindingSha256">,
    manifest: IManifest,
    context: string,
): void {
    assertJobSpec(spec, context);
    assertCompletedJob(job, manifest, context);
    if (
        fingerprintV08AlignedV1(normalizedJobSpec(completedJobSpec(job))) !==
            fingerprintV08AlignedV1(normalizedJobSpec(spec)) ||
        job.candidateId !== candidate.id ||
        job.candidateIndex !== candidate.index ||
        job.genomeSha256 !== candidate.genomeSha256 ||
        job.bindingSha256 !== candidate.bindingSha256
    ) {
        throw new Error(`${context} does not exactly match its job and candidate provenance`);
    }
}

function jobArtifactPaths(manifest: IManifest, job: ICompletedJob): { resultPath: string; summaryPath: string } {
    const jobsRoot = resolve(manifest.output, "jobs");
    const directory = resolve(jobsRoot, job.id);
    const summaryPath = resolve(manifest.output, job.summaryPath);
    if (dirname(directory) !== jobsRoot || dirname(summaryPath) !== directory) {
        throw new Error(`Job ${job.id} contains a non-canonical artifact path`);
    }
    return { resultPath: join(directory, "result.json"), summaryPath };
}

function validateResultArtifact(manifest: IManifest, job: ICompletedJob, verifySource: boolean): IResultFile {
    assertCompletedJob(job, manifest, `Completed job ${job.id}`);
    const paths = jobArtifactPaths(manifest, job);
    if (!existsSync(paths.resultPath) || !existsSync(paths.summaryPath)) {
        throw new Error(`Completed job ${job.id} is missing a committed artifact`);
    }
    const result = readJson<IResultFile>(paths.resultPath);
    if (
        result.schema !== SCHEMA ||
        result.kind !== "job-result" ||
        result.manifestFingerprint !== manifest.fingerprint ||
        fingerprintV08AlignedV1(result.job) !== fingerprintV08AlignedV1(job)
    ) {
        throw new Error(`Result ${job.id} is not exactly bound to its checkpoint provenance`);
    }
    if (job.kind === "level4") {
        const summary = result.summary as {
            schema?: unknown;
            candidateVersion?: unknown;
            opponentVersion?: unknown;
            baseSeed?: unknown;
            pairsPerLane?: unknown;
            games?: unknown;
            lanes?: unknown;
        };
        if (
            summary.schema !== "hoc.v0_8_l4_coverage.v1" ||
            summary.candidateVersion !== "v0.8s" ||
            summary.opponentVersion !== "v0.7" ||
            summary.baseSeed !== job.baseSeed ||
            summary.pairsPerLane !== job.pairsPerLane ||
            summary.games !== jobWorkUnits(job) ||
            !Array.isArray(summary.lanes) ||
            summary.lanes.length !== 8
        ) {
            throw new Error(`Invalid level-4 result summary: ${job.summaryPath}`);
        }
        if (
            verifySource &&
            fingerprintV08AlignedV1(readJson<unknown>(paths.summaryPath)) !== fingerprintV08AlignedV1(result.summary)
        ) {
            throw new Error(`Level-4 result ${job.id} does not match its source summary`);
        }
        return result;
    }
    const summary = tournamentSummary(result.summary, job.summaryPath);
    if (summary.games !== job.games || summary.baseSeed !== job.baseSeed) {
        throw new Error(`Tournament result ${job.id} has the wrong game count or seed`);
    }
    if (verifySource) {
        const source = {
            ...(readJson<ITournamentSummary>(paths.summaryPath) as ITournamentSummary),
            armageddonReached: countArmageddonReached(tournamentJsonl(dirname(paths.summaryPath))),
        };
        if (fingerprintV08AlignedV1(source) !== fingerprintV08AlignedV1(result.summary)) {
            throw new Error(`Tournament result ${job.id} does not match its source artifacts`);
        }
    }
    return result;
}

function loadCheckpoint(manifest: IManifest): ICheckpoint {
    const path = join(manifest.output, "checkpoint.json");
    if (!existsSync(path)) {
        return {
            schema: SCHEMA,
            kind: "checkpoint",
            manifestFingerprint: manifest.fingerprint,
            phase: "screen",
            validationRound: 0,
            completed: [],
            adaptiveCatalog: null,
            validationCandidateIds: [],
            activeJobs: {},
            updatedAt: new Date().toISOString(),
        };
    }
    const checkpoint = readJson<ICheckpoint>(path);
    if (
        checkpoint.schema !== SCHEMA ||
        checkpoint.kind !== "checkpoint" ||
        checkpoint.manifestFingerprint !== manifest.fingerprint ||
        !Array.isArray(checkpoint.completed) ||
        !(checkpoint.adaptiveCatalog === null || typeof checkpoint.adaptiveCatalog === "object") ||
        !Array.isArray(checkpoint.validationCandidateIds) ||
        checkpoint.validationCandidateIds.some((id) => typeof id !== "string") ||
        new Set(checkpoint.validationCandidateIds).size !== checkpoint.validationCandidateIds.length ||
        !checkpoint.activeJobs ||
        typeof checkpoint.activeJobs !== "object" ||
        Array.isArray(checkpoint.activeJobs)
    ) {
        throw new Error(`Invalid checkpoint: ${path}`);
    }
    const completedIds = new Set<string>();
    for (const job of checkpoint.completed) {
        if (completedIds.has(job.id)) throw new Error(`Checkpoint contains duplicate completed job ${job.id}`);
        completedIds.add(job.id);
        validateResultArtifact(manifest, job, false);
    }
    for (const [id, active] of Object.entries(checkpoint.activeJobs)) {
        if (
            !active ||
            typeof active !== "object" ||
            id !== active.spec?.id ||
            !Number.isSafeInteger(active.startedAtMs) ||
            Date.parse(active.startedAt) !== active.startedAtMs ||
            !(active.pid === null || (Number.isSafeInteger(active.pid) && active.pid > 0))
        ) {
            throw new Error(`Checkpoint contains invalid active job ${id}`);
        }
        assertJobSpec(active.spec, `Active job ${id}`);
    }
    // A resumed orchestrator cannot own children from the prior process. The result artifact, not stale PID state,
    // is the recovery commit point; runJobBatch reconciles any result written just before interruption.
    checkpoint.activeJobs = {};
    return checkpoint;
}

function saveCheckpoint(manifest: IManifest, checkpoint: ICheckpoint): void {
    checkpoint.updatedAt = new Date().toISOString();
    atomicJson(join(manifest.output, "checkpoint.json"), checkpoint);
}

function collectLeaderboard(
    manifest: IManifest,
    checkpoint: ICheckpoint,
    adaptive: IAdaptiveCatalog | null,
    options: { kinds?: ReadonlySet<JobKind>; outputName?: string } = {},
): IRankedCandidate[] {
    const metadata = candidateMetadata(manifest, adaptive);
    const byCandidate = new Map<string, ITournamentSummaryWithReached[]>();
    const validationByCandidate = new Map<string, ITournamentSummaryWithReached[]>();
    const level4ByCandidate = new Map<string, string[]>();
    for (const job of checkpoint.completed) {
        if (options.kinds && !options.kinds.has(job.kind)) continue;
        const candidate = metadata.get(job.candidateId);
        if (
            !candidate ||
            candidate.index !== job.candidateIndex ||
            candidate.genomeSha256 !== job.genomeSha256 ||
            candidate.bindingSha256 !== job.bindingSha256
        ) {
            throw new Error(`Completed job ${job.id} has invalid candidate provenance`);
        }
        const result = validateResultArtifact(manifest, job, false);
        if (job.kind === "level4") {
            const paths = level4ByCandidate.get(job.candidateId) ?? [];
            paths.push(job.summaryPath);
            level4ByCandidate.set(job.candidateId, paths);
            continue;
        }
        const summary = tournamentSummary(result.summary, job.summaryPath);
        const summaries = byCandidate.get(job.candidateId) ?? [];
        summaries.push(summary);
        byCandidate.set(job.candidateId, summaries);
        if (job.kind === "validation") {
            const validationSummaries = validationByCandidate.get(job.candidateId) ?? [];
            validationSummaries.push(summary);
            validationByCandidate.set(job.candidateId, validationSummaries);
        }
    }
    const rows = [...byCandidate.entries()].map(([id, summaries]) => {
        const candidate = metadata.get(id);
        if (!candidate) throw new Error(`Leaderboard candidate ${id} is not registered`);
        const games = summaries.reduce((sum, summary) => sum + summary.games, 0);
        const winsA = summaries.reduce((sum, summary) => sum + summary.a.wins, 0);
        const winsB = summaries.reduce((sum, summary) => sum + summary.b.wins, 0);
        const draws = summaries.reduce((sum, summary) => sum + summary.draws, 0);
        const armageddonReached = summaries.reduce((sum, summary) => sum + summary.armageddonReached, 0);
        const armageddonDecided = summaries.reduce((sum, summary) => sum + summary.armageddonDecided, 0);
        const validationSummaries = validationByCandidate.get(id) ?? [];
        const validationRuns = validationSummaries.length;
        const validationGames = validationSummaries.reduce((sum, summary) => sum + summary.games, 0);
        const hasValidationEvidence = validationRuns > 0;
        const decisiveWinRate = winsA + winsB ? winsA / (winsA + winsB) : 0.5;
        const armageddonRate = games ? armageddonReached / games : 1;
        const level4Summaries = (level4ByCandidate.get(id) ?? []).map((path) =>
            readJson<{
                games: number;
                lanes: Array<{
                    lane: { owner: "candidate" | "opponent" };
                    games: number;
                    appearances: number;
                    actingTurns: number;
                    rejectedCandidate: number;
                    rawEndTurnDecisions: number;
                    armageddonReached: number;
                }>;
            }>(resolve(manifest.output, path)),
        );
        const level4Games = level4Summaries.reduce((sum, summary) => sum + summary.games, 0);
        const level4ArmageddonReached = level4Summaries.reduce(
            (sum, summary) => sum + summary.lanes.reduce((laneSum, lane) => laneSum + lane.armageddonReached, 0),
            0,
        );
        const level4ArmageddonRate = level4Games ? level4ArmageddonReached / level4Games : 1;
        const level4CoveragePassed =
            level4Summaries.length > 0 &&
            level4Summaries.every(
                (summary) =>
                    summary.lanes.length === 8 &&
                    summary.lanes.every(
                        (lane) =>
                            lane.games > 0 &&
                            lane.appearances === lane.games &&
                            lane.actingTurns > 0 &&
                            (lane.lane.owner !== "candidate" ||
                                (lane.rejectedCandidate === 0 && lane.rawEndTurnDecisions === 0)),
                    ),
            );
        const passesArmageddonGate =
            armageddonRate <= ARMAGEDDON_RATE_GATE &&
            level4ArmageddonRate <= ARMAGEDDON_RATE_GATE &&
            level4CoveragePassed;
        const promotionEligible = isV08CampaignPromotionEligible({
            unboundedSearch: manifest.config.unboundedSearch,
            hasValidationEvidence,
            level4CoveragePassed,
            armageddonRate,
            level4ArmageddonRate,
        });
        return {
            rank: 0,
            candidateId: id,
            candidateIndex: candidate.index,
            label: candidate.label,
            genomeSha256: candidate.genomeSha256,
            tournamentRuns: summaries.length,
            validationRuns,
            validationGames,
            hasValidationEvidence,
            games,
            winsA,
            winsB,
            draws,
            decisiveWinRate,
            armageddonReached,
            armageddonDecided,
            armageddonRate,
            level4Games,
            level4ArmageddonReached,
            level4ArmageddonRate,
            level4CoveragePassed,
            passesArmageddonGate,
            promotionEligible,
            score: decisiveWinRate - ARMAGEDDON_SCORE_PENALTY * armageddonRate,
            level4SummaryPaths: level4ByCandidate.get(id) ?? [],
        };
    });
    rows.sort(
        (left, right) =>
            Number(right.promotionEligible) - Number(left.promotionEligible) ||
            Number(right.hasValidationEvidence) - Number(left.hasValidationEvidence) ||
            Number(right.passesArmageddonGate) - Number(left.passesArmageddonGate) ||
            right.score - left.score ||
            right.decisiveWinRate - left.decisiveWinRate ||
            left.candidateIndex - right.candidateIndex,
    );
    rows.forEach((row, index) => (row.rank = index + 1));
    atomicJson(join(manifest.output, options.outputName ?? "leaderboard.json"), {
        schema: SCHEMA,
        kind: "leaderboard",
        researchOnly: true,
        generatedAt: new Date().toISOString(),
        armageddonRateGate: ARMAGEDDON_RATE_GATE,
        armageddonScorePenalty: ARMAGEDDON_SCORE_PENALTY,
        unboundedSearch: manifest.config.unboundedSearch,
        operationalReplayRequired: manifest.config.unboundedSearch,
        promotionCandidateId: rows.find((row) => row.promotionEligible)?.candidateId ?? null,
        rows,
    });
    return rows;
}

function baseScreenEvidenceSha256(manifest: IManifest, checkpoint: ICheckpoint): string {
    const jobs = checkpoint.completed
        .filter((job) => job.kind === "screen")
        .sort((left, right) => left.candidateId.localeCompare(right.candidateId));
    if (jobs.length !== BASE_CANDIDATE_COUNT) {
        throw new Error(`Adaptive generation requires all ${BASE_CANDIDATE_COUNT} base screens`);
    }
    const rows = jobs.map((job) => {
        const candidate = manifest.candidates.find(({ id }) => id === job.candidateId);
        if (
            !candidate ||
            candidate.index !== job.candidateIndex ||
            candidate.genomeSha256 !== job.genomeSha256 ||
            candidate.bindingSha256 !== job.bindingSha256
        ) {
            throw new Error(`Base screen ${job.id} has invalid candidate provenance`);
        }
        const result = validateResultArtifact(manifest, job, false);
        tournamentSummary(result.summary, job.summaryPath);
        return {
            candidateId: job.candidateId,
            candidateIndex: job.candidateIndex,
            genomeSha256: job.genomeSha256,
            bindingSha256: job.bindingSha256,
            games: job.games,
            baseSeed: job.baseSeed,
            summary: result.summary,
        };
    });
    return fingerprintV08AlignedV1({
        kind: "adaptive-base-screen-evidence",
        manifestFingerprint: manifest.fingerprint,
        rows,
    });
}

function buildAdaptiveCatalog(
    manifest: IManifest,
    checkpoint: ICheckpoint,
    baseGenomes: readonly IV08AlignedV1CandidateGenome[],
): IAdaptiveCatalog {
    const screenEvidenceSha256 = baseScreenEvidenceSha256(manifest, checkpoint);
    const baseRows = collectLeaderboard(manifest, checkpoint, null, {
        kinds: new Set<JobKind>(["screen"]),
        outputName: "base-screen-leaderboard.json",
    });
    const parentRows = baseRows.slice(0, ADAPTIVE_PARENT_COUNT);
    if (parentRows.length !== ADAPTIVE_PARENT_COUNT) {
        throw new Error(`Adaptive generation requires ${ADAPTIVE_PARENT_COUNT} ranked parents`);
    }
    const parents = parentRows.map((row) => {
        const genome = baseGenomes[row.candidateIndex];
        if (!genome || fingerprintV08AlignedV1CandidateGenome(genome) !== row.genomeSha256) {
            throw new Error(`Adaptive parent ${row.candidateId} does not match the base catalog`);
        }
        return { row, genome };
    });
    const seen = new Set(baseGenomes.map(fingerprintV08AlignedV1CandidateGenome));
    const children: IAdaptiveChild[] = [];
    const childrenPerParent = ADAPTIVE_CHILD_TARGET / ADAPTIVE_PARENT_COUNT;
    if (!Number.isSafeInteger(childrenPerParent)) throw new Error("Adaptive child target must divide parent count");

    for (const parent of parents) {
        let accepted = 0;
        for (const proposal of adaptiveProposals(parent, parents)) {
            if (accepted >= childrenPerParent) break;
            let normalized: IV08AlignedV1CandidateGenome;
            try {
                normalized = normalizeV08AlignedV1CandidateGenome(proposal.genome);
            } catch {
                continue;
            }
            assertAdaptiveComputeEnvelope(parent.genome, normalized);
            assertAdaptiveMutationScope(parent.genome, normalized, proposal.mutation);
            const genomeSha256 = fingerprintV08AlignedV1CandidateGenome(normalized);
            if (seen.has(genomeSha256)) continue;

            const childOffset = children.length;
            const id = adaptiveCandidateId(childOffset);
            const label = `adaptive-${id}-from-${parent.row.candidateId}-${proposal.mutation.kind}-${proposal.mutation.field.replace(/[^a-zA-Z0-9]+/g, "-")}`;
            normalized.search.label = label;
            const binding = validateV08AlignedV1CandidateBinding(bindV08AlignedV1Candidate(normalized));
            const child: IAdaptiveChild = {
                index: BASE_CANDIDATE_COUNT + childOffset,
                id,
                label,
                parentCandidateId: parent.row.candidateId,
                parentCandidateIndex: parent.row.candidateIndex,
                parentGenomeSha256: parent.row.genomeSha256,
                mutation: proposal.mutation,
                genome: normalized,
                genomeSha256,
                bindingSha256: fingerprintV08AlignedV1(binding),
                behaviorEnvironmentSha256: binding.behaviorEnvironmentSha256,
                effectiveBehaviorEnvironmentSha256: fingerprintV08AlignedV1(
                    effectiveBehaviorEnvironment(binding, "<adaptive-job-audit-path>", manifest.config.unboundedSearch),
                ),
            };
            children.push(child);
            seen.add(genomeSha256);
            accepted += 1;
        }
        if (accepted !== childrenPerParent) {
            throw new Error(`Adaptive parent ${parent.row.candidateId} produced only ${accepted} unique safe children`);
        }
    }
    if (children.length !== ADAPTIVE_CHILD_TARGET) {
        throw new Error(`Adaptive generator produced ${children.length}/${ADAPTIVE_CHILD_TARGET} children`);
    }
    const unsigned = {
        schema: SCHEMA,
        kind: "adaptive-catalog" as const,
        researchOnly: true as const,
        automaticBake: false as const,
        automaticDeploy: false as const,
        manifestFingerprint: manifest.fingerprint,
        generatorVersion: ADAPTIVE_GENERATOR_VERSION as typeof ADAPTIVE_GENERATOR_VERSION,
        sourceCatalogSha256: manifest.catalogIdentity.catalogSha256,
        screenEvidenceSha256,
        parentCandidateIds: parents.map(({ row }) => row.candidateId),
        parentGenomeSha256: parents.map(({ row }) => row.genomeSha256),
        childTarget: ADAPTIVE_CHILD_TARGET as typeof ADAPTIVE_CHILD_TARGET,
        children,
        createdAt: new Date().toISOString(),
    };
    return { ...unsigned, fingerprint: fingerprintV08AlignedV1(unsigned) };
}

function validateAdaptiveCatalog(
    manifest: IManifest,
    checkpoint: ICheckpoint,
    adaptive: IAdaptiveCatalog,
    baseGenomes: readonly IV08AlignedV1CandidateGenome[],
): IAdaptiveCatalog {
    const expectedEvidence = baseScreenEvidenceSha256(manifest, checkpoint);
    if (
        adaptive.schema !== SCHEMA ||
        adaptive.kind !== "adaptive-catalog" ||
        adaptive.researchOnly !== true ||
        adaptive.automaticBake !== false ||
        adaptive.automaticDeploy !== false ||
        adaptive.manifestFingerprint !== manifest.fingerprint ||
        adaptive.generatorVersion !== ADAPTIVE_GENERATOR_VERSION ||
        adaptive.sourceCatalogSha256 !== manifest.catalogIdentity.catalogSha256 ||
        adaptive.screenEvidenceSha256 !== expectedEvidence ||
        adaptive.childTarget !== ADAPTIVE_CHILD_TARGET ||
        adaptive.children.length !== ADAPTIVE_CHILD_TARGET ||
        adaptive.parentCandidateIds.length !== ADAPTIVE_PARENT_COUNT ||
        adaptive.parentGenomeSha256.length !== ADAPTIVE_PARENT_COUNT ||
        adaptive.fingerprint !== fingerprintV08AlignedV1({ ...adaptive, fingerprint: undefined })
    ) {
        throw new Error("Adaptive catalog header, evidence, or fingerprint is invalid");
    }
    const expectedParents = collectLeaderboard(manifest, checkpoint, null, {
        kinds: new Set<JobKind>(["screen"]),
        outputName: "base-screen-leaderboard.json",
    }).slice(0, ADAPTIVE_PARENT_COUNT);
    if (
        fingerprintV08AlignedV1(expectedParents.map(({ candidateId }) => candidateId)) !==
            fingerprintV08AlignedV1(adaptive.parentCandidateIds) ||
        fingerprintV08AlignedV1(expectedParents.map(({ genomeSha256 }) => genomeSha256)) !==
            fingerprintV08AlignedV1(adaptive.parentGenomeSha256)
    ) {
        throw new Error("Adaptive catalog parents do not match the committed base-screen ranking");
    }
    const baseHashes = new Set(baseGenomes.map(fingerprintV08AlignedV1CandidateGenome));
    const seen = new Set(baseHashes);
    for (const [offset, child] of adaptive.children.entries()) {
        const parent = manifest.candidates.find(({ id }) => id === child.parentCandidateId);
        const parentGenome = parent ? baseGenomes[parent.index] : undefined;
        if (
            !parent ||
            !parentGenome ||
            !adaptive.parentCandidateIds.includes(parent.id) ||
            child.index !== BASE_CANDIDATE_COUNT + offset ||
            child.id !== adaptiveCandidateId(offset) ||
            child.parentCandidateIndex !== parent.index ||
            child.parentGenomeSha256 !== parent.genomeSha256 ||
            fingerprintV08AlignedV1CandidateGenome(parentGenome) !== parent.genomeSha256
        ) {
            throw new Error(`Adaptive child ${child.id} has invalid parent or identity`);
        }
        const normalized = normalizeV08AlignedV1CandidateGenome(child.genome);
        assertAdaptiveComputeEnvelope(parentGenome, normalized);
        assertAdaptiveMutationScope(parentGenome, normalized, child.mutation);
        if (child.mutation.kind === "leaf-blend") {
            const donor = manifest.candidates.find(({ id }) => id === child.mutation.donorCandidateId);
            const donorGenome = donor ? baseGenomes[donor.index] : undefined;
            const alpha = child.mutation.alpha;
            if (
                !donor ||
                !donorGenome ||
                !adaptive.parentCandidateIds.includes(donor.id) ||
                donor.genomeSha256 !== child.mutation.donorGenomeSha256 ||
                alpha === undefined ||
                !parentGenome.search.leaf ||
                !donorGenome.search.leaf ||
                !normalized.search.leaf
            ) {
                throw new Error(`Adaptive child ${child.id} has invalid leaf-blend provenance`);
            }
            const expectedLeaf = {
                b: parentGenome.search.leaf.b * (1 - alpha) + donorGenome.search.leaf.b * alpha,
                w: parentGenome.search.leaf.w.map(
                    (weight, index) => weight * (1 - alpha) + donorGenome.search.leaf!.w[index]! * alpha,
                ),
            };
            if (fingerprintV08AlignedV1(expectedLeaf) !== fingerprintV08AlignedV1(normalized.search.leaf)) {
                throw new Error(`Adaptive child ${child.id} leaf blend does not match its donor and alpha`);
            }
        }
        const genomeSha256 = fingerprintV08AlignedV1CandidateGenome(normalized);
        const binding = validateV08AlignedV1CandidateBinding(bindV08AlignedV1Candidate(normalized));
        if (
            genomeSha256 !== child.genomeSha256 ||
            seen.has(genomeSha256) ||
            child.label !== normalized.search.label ||
            child.bindingSha256 !== fingerprintV08AlignedV1(binding) ||
            child.behaviorEnvironmentSha256 !== binding.behaviorEnvironmentSha256 ||
            child.effectiveBehaviorEnvironmentSha256 !==
                fingerprintV08AlignedV1(
                    effectiveBehaviorEnvironment(binding, "<adaptive-job-audit-path>", manifest.config.unboundedSearch),
                )
        ) {
            throw new Error(`Adaptive child ${child.id} binding or genome fingerprint is invalid`);
        }
        seen.add(genomeSha256);
    }
    return adaptive;
}

function loadOrCreateAdaptiveCatalog(
    manifest: IManifest,
    checkpoint: ICheckpoint,
    baseGenomes: readonly IV08AlignedV1CandidateGenome[],
): IAdaptiveCatalog {
    const path = join(manifest.output, "adaptive-catalog.json");
    let adaptive: IAdaptiveCatalog;
    if (checkpoint.adaptiveCatalog === null) {
        if (existsSync(path)) {
            adaptive = readJson<IAdaptiveCatalog>(path);
        } else {
            adaptive = buildAdaptiveCatalog(manifest, checkpoint, baseGenomes);
            atomicJson(path, adaptive);
        }
        validateAdaptiveCatalog(manifest, checkpoint, adaptive, baseGenomes);
        checkpoint.adaptiveCatalog = {
            path: relative(manifest.output, path),
            fingerprint: adaptive.fingerprint,
            screenEvidenceSha256: adaptive.screenEvidenceSha256,
            children: adaptive.children.length,
        };
        saveCheckpoint(manifest, checkpoint);
        return adaptive;
    }
    const checkpointPath = resolve(manifest.output, checkpoint.adaptiveCatalog.path);
    if (checkpointPath !== path || !existsSync(checkpointPath)) {
        throw new Error("Checkpoint adaptive catalog path is missing or not canonical");
    }
    adaptive = readJson<IAdaptiveCatalog>(checkpointPath);
    validateAdaptiveCatalog(manifest, checkpoint, adaptive, baseGenomes);
    if (
        checkpoint.adaptiveCatalog.fingerprint !== adaptive.fingerprint ||
        checkpoint.adaptiveCatalog.screenEvidenceSha256 !== adaptive.screenEvidenceSha256 ||
        checkpoint.adaptiveCatalog.children !== adaptive.children.length
    ) {
        throw new Error("Checkpoint adaptive catalog commitment does not match its artifact");
    }
    return adaptive;
}

function buildCandidateRegistry(
    manifest: IManifest,
    baseBindings: readonly IV08AlignedV1CandidateBinding[],
    adaptive: IAdaptiveCatalog | null,
): CandidateRegistry {
    const registry: CandidateRegistry = new Map();
    for (const descriptor of manifest.candidates) {
        const binding = baseBindings[descriptor.index];
        if (
            !binding ||
            binding.genomeSha256 !== descriptor.genomeSha256 ||
            fingerprintV08AlignedV1(binding) !== descriptor.bindingSha256
        ) {
            throw new Error(`Base candidate ${descriptor.id} binding does not match the manifest`);
        }
        registry.set(descriptor.id, { ...descriptor, binding, bindingSha256: descriptor.bindingSha256 });
    }
    for (const child of adaptive?.children ?? []) {
        const binding = validateV08AlignedV1CandidateBinding(bindV08AlignedV1Candidate(child.genome));
        if (
            binding.genomeSha256 !== child.genomeSha256 ||
            fingerprintV08AlignedV1(binding) !== child.bindingSha256 ||
            registry.has(child.id)
        ) {
            throw new Error(`Adaptive candidate ${child.id} binding is invalid or duplicated`);
        }
        registry.set(child.id, {
            index: child.index,
            id: child.id,
            label: child.label,
            genomeSha256: child.genomeSha256,
            binding,
            bindingSha256: child.bindingSha256,
        });
    }
    return registry;
}

function reconcileJobResult(
    manifest: IManifest,
    checkpoint: ICheckpoint,
    registry: CandidateRegistry,
    spec: IJobSpec,
): boolean {
    assertJobSpec(spec, `Job ${spec.id}`);
    const candidate = registry.get(spec.candidateId);
    if (!candidate || candidate.index !== spec.candidateIndex) {
        throw new Error(`Job ${spec.id} references an unregistered candidate`);
    }
    const committed = checkpoint.completed.find(({ id }) => id === spec.id);
    if (committed) {
        assertJobMatchesSpec(committed, spec, candidate, manifest, `Completed job ${spec.id}`);
        validateResultArtifact(manifest, committed, false);
        return true;
    }
    const directory = join(manifest.output, "jobs", spec.id);
    const resultPath = join(directory, "result.json");
    if (!existsSync(resultPath)) return false;
    const recovered = readJson<IResultFile>(resultPath);
    if (recovered.schema !== SCHEMA || recovered.kind !== "job-result") {
        throw new Error(`Recovered result ${spec.id} has an invalid schema`);
    }
    assertJobMatchesSpec(recovered.job, spec, candidate, manifest, `Recovered result ${spec.id}`);
    validateResultArtifact(manifest, recovered.job, true);
    checkpoint.completed.push(recovered.job);
    saveCheckpoint(manifest, checkpoint);
    appendFileSync(
        join(manifest.output, "logs", "orchestrator.jsonl"),
        `${JSON.stringify({ at: new Date().toISOString(), event: "recover", ...recovered.job })}\n`,
    );
    console.log(`[recover] ${spec.id} -> ${recovered.job.summaryPath}`);
    return true;
}

async function runJob(
    manifest: IManifest,
    checkpoint: ICheckpoint,
    registry: CandidateRegistry,
    adaptive: IAdaptiveCatalog | null,
    spec: IJobSpec,
): Promise<boolean> {
    if (reconcileJobResult(manifest, checkpoint, registry, spec)) return true;
    const candidate = registry.get(spec.candidateId);
    if (!candidate || candidate.index !== spec.candidateIndex) {
        throw new Error(`Job ${spec.id} references an unregistered candidate`);
    }
    const directory = join(manifest.output, "jobs", spec.id);
    const resultPath = join(directory, "result.json");
    mkdirSync(directory, { recursive: true });
    const auditPath = join(directory, "search-audit.jsonl");
    const environment = childEnvironment(candidate.binding, auditPath, manifest.config.unboundedSearch);
    const logPath = join(manifest.output, "logs", `${spec.id}.log`);
    const runner = spec.kind === "level4" ? LEVEL4_RUNNER : TOURNAMENT_RUNNER;
    const args =
        spec.kind === "level4"
            ? [
                  runner,
                  "v0.8s",
                  "v0.7",
                  String(spec.pairsPerLane),
                  String(spec.baseSeed),
                  directory,
                  String(manifest.config.workersPerJob),
              ]
            : [
                  runner,
                  "v0.8s",
                  "v0.7",
                  String(spec.games),
                  String(spec.baseSeed),
                  directory,
                  String(manifest.config.workersPerJob),
                  `--maps=${LIVE_MAPS}`,
                  "--livetwin",
              ];
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    checkpoint.activeJobs[spec.id] = { spec, startedAt, startedAtMs, pid: null };
    saveCheckpoint(manifest, checkpoint);
    appendFileSync(
        join(manifest.output, "logs", "orchestrator.jsonl"),
        `${JSON.stringify({
            at: startedAt,
            event: "start",
            ...spec,
            genomeSha256: candidate.genomeSha256,
            bindingSha256: candidate.bindingSha256,
        })}\n`,
    );
    console.log(`[start] ${spec.id}`);
    let status: "completed" | "deadline";
    try {
        status = await runChild(args, environment, logPath, manifest.deadlineAtMs, (pid) => {
            const active = checkpoint.activeJobs[spec.id];
            if (active?.startedAtMs === startedAtMs) {
                active.pid = pid;
                saveCheckpoint(manifest, checkpoint);
            }
        });
    } finally {
        delete checkpoint.activeJobs[spec.id];
        saveCheckpoint(manifest, checkpoint);
    }
    if (status === "deadline") {
        return false;
    }
    const absoluteSummary = latestSummary(directory);
    const rawSummary = readJson<unknown>(absoluteSummary);
    const summary =
        spec.kind === "level4"
            ? rawSummary
            : {
                  ...(rawSummary as ITournamentSummary),
                  armageddonReached: countArmageddonReached(tournamentJsonl(directory)),
              };
    if (spec.kind !== "level4") tournamentSummary(summary, absoluteSummary);
    const completedAtMs = Date.now();
    const job: ICompletedJob = {
        ...spec,
        genomeSha256: candidate.genomeSha256,
        bindingSha256: candidate.bindingSha256,
        summaryPath: relative(manifest.output, absoluteSummary),
        manifestFingerprint: manifest.fingerprint,
        startedAt,
        startedAtMs,
        completedAt: new Date(completedAtMs).toISOString(),
        durationMs: completedAtMs - startedAtMs,
    };
    atomicJson(resultPath, {
        schema: SCHEMA,
        kind: "job-result",
        manifestFingerprint: manifest.fingerprint,
        job,
        summary,
    } satisfies IResultFile);
    validateResultArtifact(manifest, job, true);
    checkpoint.completed.push(job);
    saveCheckpoint(manifest, checkpoint);
    appendFileSync(
        join(manifest.output, "logs", "orchestrator.jsonl"),
        `${JSON.stringify({ at: new Date().toISOString(), event: "complete", ...job })}\n`,
    );
    console.log(`[complete] ${spec.id} -> ${job.summaryPath}`);
    if (spec.kind !== "level4") collectLeaderboard(manifest, checkpoint, adaptive);
    return true;
}

async function runJobBatch(
    manifest: IManifest,
    checkpoint: ICheckpoint,
    registry: CandidateRegistry,
    adaptive: IAdaptiveCatalog | null,
    specs: IJobSpec[],
    options: { admissionReserved?: boolean } = {},
): Promise<boolean> {
    if (specs.length > manifest.config.lanes) {
        throw new Error(`Batch has ${specs.length} jobs but only ${manifest.config.lanes} lanes`);
    }
    if (specs.length * manifest.config.workersPerJob > manifest.config.concurrency) {
        throw new Error("Batch exceeds the manifest's total worker budget");
    }
    for (const spec of specs) reconcileJobResult(manifest, checkpoint, registry, spec);
    const completedIds = new Set(checkpoint.completed.map(({ id }) => id));
    const pending = specs.filter(({ id }) => !completedIds.has(id));
    if (!pending.length) return true;
    if (
        !options.admissionReserved &&
        !canAdmitJobBatches({
            batches: [pending],
            completed: checkpoint.completed,
            workersPerJob: manifest.config.workersPerJob,
            nowMs: Date.now(),
            deadlineAtMs: manifest.deadlineAtMs,
        })
    ) {
        const estimatedDurationMs = estimateBatchDurationMs(
            pending,
            checkpoint.completed,
            manifest.config.workersPerJob,
        );
        appendFileSync(
            join(manifest.output, "logs", "orchestrator.jsonl"),
            `${JSON.stringify({
                at: new Date().toISOString(),
                event: "admission-deferred",
                jobIds: pending.map(({ id }) => id),
                estimatedDurationMs,
                safetyMarginMs: ADMISSION_SAFETY_MARGIN_MS,
                deadlineAtMs: manifest.deadlineAtMs,
            })}\n`,
        );
        console.log(
            `[defer] ${pending.map(({ id }) => id).join(", ")} needs about ${Math.ceil(estimatedDurationMs / 1_000)}s`,
        );
        return false;
    }
    const results = await Promise.all(pending.map((spec) => runJob(manifest, checkpoint, registry, adaptive, spec)));
    return results.every(Boolean);
}

async function main(): Promise<void> {
    const cli = parseCli(process.argv.slice(2));
    const baseGenomes = buildV08AlignedV1ProductionCandidateCatalog();
    const baseBindings = baseGenomes.map((genome) =>
        validateV08AlignedV1CandidateBinding(bindV08AlignedV1Candidate(genome)),
    );
    if (baseBindings.length !== BASE_CANDIDATE_COUNT) {
        throw new Error(`Expected exact ${BASE_CANDIDATE_COUNT}-candidate catalog, got ${baseBindings.length}`);
    }
    const manifest = loadOrCreateManifest(cli, baseBindings);
    const checkpoint = loadCheckpoint(manifest);
    mkdirSync(join(manifest.output, "logs"), { recursive: true });
    saveCheckpoint(manifest, checkpoint);
    let adaptive =
        checkpoint.adaptiveCatalog === null ? null : loadOrCreateAdaptiveCatalog(manifest, checkpoint, baseGenomes);
    let registry = buildCandidateRegistry(manifest, baseBindings, adaptive);

    console.log(
        `Research-only v0.8 aggressive campaign: ${manifest.output}\n` +
            `deadline ${manifest.deadlineAt}, total workers ${manifest.config.concurrency}, lanes ${manifest.config.lanes}, ` +
            `workers/job ${manifest.config.workersPerJob}, max active ${manifest.config.maxWorkers}, ` +
            `timing ${manifest.config.unboundedSearch ? "unbounded deterministic fitness" : "bound operational"}, ` +
            `catalog ${manifest.catalogIdentity.catalogSha256}`,
    );
    if (Date.now() >= manifest.deadlineAtMs) {
        console.log("Campaign wall deadline already reached; checkpoint left resumable.");
        return;
    }

    checkpoint.phase = "screen";
    saveCheckpoint(manifest, checkpoint);
    for (let start = 0; start < baseBindings.length; start += manifest.config.lanes) {
        const specs: IJobSpec[] = baseBindings.slice(start, start + manifest.config.lanes).map((_binding, offset) => {
            const index = start + offset;
            return {
                id: `screen-${candidateId(index)}`,
                kind: "screen" as const,
                candidateId: candidateId(index),
                candidateIndex: index,
                games: manifest.config.screenGames,
                baseSeed: manifest.config.screenSeed,
            };
        });
        const ok = await runJobBatch(manifest, checkpoint, registry, adaptive, specs);
        if (!ok) return;
    }

    adaptive = loadOrCreateAdaptiveCatalog(manifest, checkpoint, baseGenomes);
    registry = buildCandidateRegistry(manifest, baseBindings, adaptive);
    checkpoint.phase = "adaptive";
    saveCheckpoint(manifest, checkpoint);
    for (let start = 0; start < adaptive.children.length; start += manifest.config.lanes) {
        const specs: IJobSpec[] = adaptive.children.slice(start, start + manifest.config.lanes).map((child) => ({
            id: `adaptive-${child.id}`,
            kind: "adaptive" as const,
            candidateId: child.id,
            candidateIndex: child.index,
            games: manifest.adaptive.screenGames,
            baseSeed: manifest.adaptive.screenSeed,
        }));
        const ok = await runJobBatch(manifest, checkpoint, registry, adaptive, specs);
        if (!ok) return;
    }

    const preLevel4 = collectLeaderboard(manifest, checkpoint, adaptive, {
        kinds: new Set<JobKind>(["screen", "adaptive"]),
        outputName: "pre-level4-leaderboard.json",
    });
    const level4ReserveTarget = Math.min(
        preLevel4.length,
        manifest.config.topCandidates * manifest.adaptive.level4ReserveMultiplier,
    );
    // A zero count in a 256-game screen cannot establish the 0.1% target. Cover a fixed score-ranked reserve,
    // then let repeated fresh validation determine Armageddon safety without lucky-zero admission bias.
    const level4Queue = preLevel4.slice(0, level4ReserveTarget);
    let leaderboard = collectLeaderboard(manifest, checkpoint, adaptive);
    checkpoint.phase = "level4";
    saveCheckpoint(manifest, checkpoint);
    const alreadyCovered = new Set(
        checkpoint.completed.filter((job) => job.kind === "level4").map((job) => job.candidateId),
    );
    let level4Cursor = 0;
    while (level4Cursor < level4Queue.length && Date.now() < manifest.deadlineAtMs && !stopRequested) {
        const batch: IRankedCandidate[] = [];
        while (level4Cursor < level4Queue.length && batch.length < manifest.config.lanes) {
            const row = level4Queue[level4Cursor++]!;
            if (!alreadyCovered.has(row.candidateId)) batch.push(row);
        }
        if (!batch.length) continue;
        const specs: IJobSpec[] = batch.map((row) => ({
            id: `level4-${row.candidateId}`,
            kind: "level4" as const,
            candidateId: row.candidateId,
            candidateIndex: row.candidateIndex,
            pairsPerLane: manifest.config.level4PairsPerLane,
            baseSeed: manifest.config.level4Seed,
        }));
        const ok = await runJobBatch(manifest, checkpoint, registry, adaptive, specs);
        if (!ok) return;
        batch.forEach((row) => alreadyCovered.add(row.candidateId));
    }
    collectLeaderboard(manifest, checkpoint, adaptive);

    checkpoint.phase = "validation";
    saveCheckpoint(manifest, checkpoint);
    leaderboard = collectLeaderboard(manifest, checkpoint, adaptive);
    if (!checkpoint.validationCandidateIds.length) {
        checkpoint.validationCandidateIds = selectValidationCandidateIds(leaderboard, manifest.config.topCandidates);
        saveCheckpoint(manifest, checkpoint);
    }
    if (!checkpoint.validationCandidateIds.length) {
        checkpoint.phase = "complete";
        saveCheckpoint(manifest, checkpoint);
        console.log("No candidate completed forced level-4 coverage; campaign ended without a promotion candidate.");
        return;
    }
    while (Date.now() < manifest.deadlineAtMs && !stopRequested) {
        leaderboard = collectLeaderboard(manifest, checkpoint, adaptive);
        const rowsById = new Map(leaderboard.map((row) => [row.candidateId, row]));
        const top = checkpoint.validationCandidateIds.map((id) => rowsById.get(id)).filter((row) => row !== undefined);
        if (top.length !== checkpoint.validationCandidateIds.length) {
            throw new Error("Persisted validation shortlist does not match the candidate registry");
        }
        const round = checkpoint.validationRound;
        const roundBatches: IJobSpec[][] = [];
        for (let start = 0; start < top.length; start += manifest.config.lanes) {
            const specs: IJobSpec[] = top.slice(start, start + manifest.config.lanes).map((row) => ({
                id: `validation-r${String(round).padStart(3, "0")}-${row.candidateId}`,
                kind: "validation" as const,
                candidateId: row.candidateId,
                candidateIndex: row.candidateIndex,
                games: manifest.config.validationGames,
                baseSeed: (manifest.config.validationSeed + round * 1_000_003) >>> 0,
            }));
            roundBatches.push(specs);
        }
        // Reconcile every batch before admission so an interrupted result is not charged twice. The remaining
        // batches form one reservation: never knowingly start the first half of a round without budget for all.
        for (const specs of roundBatches) {
            for (const spec of specs) reconcileJobResult(manifest, checkpoint, registry, spec);
        }
        const completedIds = new Set(checkpoint.completed.map(({ id }) => id));
        const pendingBatches = roundBatches
            .map((specs) => specs.filter(({ id }) => !completedIds.has(id)))
            .filter((specs) => specs.length > 0);
        if (
            pendingBatches.length > 0 &&
            !canAdmitJobBatches({
                batches: pendingBatches,
                completed: checkpoint.completed,
                workersPerJob: manifest.config.workersPerJob,
                nowMs: Date.now(),
                deadlineAtMs: manifest.deadlineAtMs,
            })
        ) {
            const estimatedDurationMs = estimateJobBatchesDurationMs(
                pendingBatches,
                checkpoint.completed,
                manifest.config.workersPerJob,
            );
            appendFileSync(
                join(manifest.output, "logs", "orchestrator.jsonl"),
                `${JSON.stringify({
                    at: new Date().toISOString(),
                    event: "validation-round-admission-deferred",
                    round,
                    jobIds: pendingBatches.flatMap((specs) => specs.map(({ id }) => id)),
                    estimatedDurationMs,
                    safetyMarginMs: ADMISSION_SAFETY_MARGIN_MS,
                    deadlineAtMs: manifest.deadlineAtMs,
                })}\n`,
            );
            console.log(`[defer] validation round ${round} needs about ${Math.ceil(estimatedDurationMs / 1_000)}s`);
            return;
        }
        for (const specs of roundBatches) {
            const ok = await runJobBatch(manifest, checkpoint, registry, adaptive, specs, {
                admissionReserved: true,
            });
            if (!ok) return;
        }
        checkpoint.validationRound += 1;
        saveCheckpoint(manifest, checkpoint);
    }
    checkpoint.phase = "complete";
    saveCheckpoint(manifest, checkpoint);
    console.log(`Wall deadline reached. Final leaderboard: ${join(manifest.output, "leaderboard.json")}`);
}

if ((import.meta as unknown as { main?: boolean }).main) {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.on(signal, () => {
            stopRequested = true;
            for (const child of activeChildren) child.kill("SIGTERM");
        });
    }
    void main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

export { main };
