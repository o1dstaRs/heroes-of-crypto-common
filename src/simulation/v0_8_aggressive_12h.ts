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

import { V08_TEST_CANDIDATE_GENOME, V08_TEST_CANDIDATE_GENOME_SHA256 } from "../ai/versions/v0_8_candidate_profile";
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

export const V08_CAMPAIGN_SCHEMA = "hoc.v0_8_aggressive_campaign.v6" as const;
const SCHEMA = V08_CAMPAIGN_SCHEMA;
const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");
const TOURNAMENT_RUNNER = join(REPOSITORY_ROOT, "src/simulation/run_tournament.ts");
const LEVEL4_RUNNER = join(REPOSITORY_ROOT, "src/simulation/v0_8_l4_coverage.ts");
const LIVE_MAPS = "normal,lava,block";
// At screen/validation sizes this effectively requires zero Armageddon-reached games; pooled long-run
// promotion evidence may tolerate at most one per thousand.
const ARMAGEDDON_RATE_GATE = 0.001;
const PRODUCTION_CANDIDATE_COUNT = 48;
const BASE_CANDIDATE_COUNT = 49;
export const V08_CAMPAIGN_EXACT_ANCHOR_INDEX = 48 as const;
export const V08_CAMPAIGN_EXACT_ANCHOR_ID = "c48" as const;
export const V08_CAMPAIGN_INACTIVE_CONTROL_IDS = ["c37", "c38"] as const;
export const V08_CAMPAIGN_VALIDATION_SELECTION_SOURCE_KINDS = ["screen", "adaptive", "level4"] as const;
export const V08_CAMPAIGN_ADAPTIVE_GENERATOR_VERSION = 4;
const ADAPTIVE_GENERATOR_VERSION = V08_CAMPAIGN_ADAPTIVE_GENERATOR_VERSION;
const ADAPTIVE_PARENT_COUNT = 4;
const ADAPTIVE_CHILD_TARGET = 24;
// Children reuse the base screen's common-random panel so ranking does not confound candidate and seed.
// Repeated validation below uses untouched seeds to detect panel overfitting.
const ADAPTIVE_SCREEN_SEED = 20_260_719;
const ADAPTIVE_GATE_STEP = 0.005;
const ADAPTIVE_LEAF_BLEND_ALPHAS = [0.15, 0.25] as const;
const LEVEL4_RESERVE_MULTIPLIER = 3;
export const V08_CAMPAIGN_DEFAULT_LANES = 3;
export const V08_CAMPAIGN_DEFAULT_TOP_CANDIDATES = 8;
export const V08_CAMPAIGN_SCHEDULER_VERSION = 1;
export const V08_CAMPAIGN_RESEARCH_RANKING = "candidate-win-rate_then_draw-rate_then_non-loss-armageddon-rate" as const;
export const V08_CAMPAIGN_RESERVE_ELIGIBILITY = Object.freeze({
    minimumCandidateWinRate: 0.5,
    minimumDecisiveWinRate: 0.5,
});
export const V08_CAMPAIGN_SELECTION_VERSION = 1 as const;
export const V08_CAMPAIGN_PROMOTION_COMPARISON_VERSION = 1 as const;

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

interface IManifestCandidate {
    index: number;
    id: string;
    label: string | null;
    genomeSha256: string;
    bindingSha256: string;
    effectiveBehaviorEnvironmentSha256: string;
}

interface ICampaignBaseIdentity {
    schemaVersion: 1;
    productionCatalogSha256: string;
    productionCandidateCount: typeof PRODUCTION_CANDIDATE_COUNT;
    campaignCandidateCount: typeof BASE_CANDIDATE_COUNT;
    orderedCandidateGenomeSha256: string[];
    exactAnchor: IManifestCandidate;
    inactiveControls: [IManifestCandidate, IManifestCandidate];
    identitySha256: string;
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
    researchRanking: typeof V08_CAMPAIGN_RESEARCH_RANKING;
    reserveEligibility: typeof V08_CAMPAIGN_RESERVE_ELIGIBILITY;
    selection: {
        version: typeof V08_CAMPAIGN_SELECTION_VERSION;
        exactAnchorCandidateId: typeof V08_CAMPAIGN_EXACT_ANCHOR_ID;
        inactiveControlCandidateIds: typeof V08_CAMPAIGN_INACTIVE_CONTROL_IDS;
        minimumValidationCandidates: 2;
        strategy: "exact-anchor_then_inactive-control_then_strength_then_total-arm-reserve";
    };
    promotionComparison: {
        version: typeof V08_CAMPAIGN_PROMOTION_COMPARISON_VERSION;
        exactAnchorCandidateId: typeof V08_CAMPAIGN_EXACT_ANCHOR_ID;
        evidence: "fully-committed-common-random-validation-rounds";
        minimumCandidateWinRateDelta: 0;
        minimumDecisiveWinRateDelta: 0;
    };
    scheduler: {
        version: typeof V08_CAMPAIGN_SCHEDULER_VERSION;
        discipline: "work-conserving-fifo";
        validationEvidenceCommit: "complete-round-only";
        validationRoundPipelining: false;
    };
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
    campaignBaseIdentity: ICampaignBaseIdentity;
    candidates: IManifestCandidate[];
    fingerprint: string;
}

export type JobKind = "screen" | "adaptive" | "level4" | "validation";
const JOB_KINDS: ReadonlySet<JobKind> = new Set(["screen", "adaptive", "level4", "validation"]);
const VALIDATION_SELECTION_SOURCE_KINDS: ReadonlySet<JobKind> = new Set(V08_CAMPAIGN_VALIDATION_SELECTION_SOURCE_KINDS);

/** The immutable pre-validation evidence scope used to create and verify a resumable shortlist. */
export function isV08CampaignValidationSelectionSourceJob(job: { kind: JobKind }): boolean {
    return VALIDATION_SELECTION_SOURCE_KINDS.has(job.kind);
}

export interface IV08CampaignAdaptiveMutation {
    kind: "gate" | "control" | "leaf-blend";
    field: string;
    from: unknown;
    to: unknown;
    donorCandidateId?: string;
    donorGenomeSha256?: string;
    alpha?: number;
}

export interface IV08CampaignAdaptiveProposalParent {
    candidateId: string;
    candidateIndex: number;
    genomeSha256: string;
    genome: IV08AlignedV1CandidateGenome;
}

export interface IV08CampaignAdaptiveProposal {
    genome: IV08AlignedV1CandidateGenome;
    mutation: IV08CampaignAdaptiveMutation;
}

export const V08_CAMPAIGN_EXACT_ANCHOR_REQUIRED_FINISH_MUTATIONS = Object.freeze([
    Object.freeze({ field: "controls.meleeRangedTargetWeight", to: 2 as const }),
    Object.freeze({ field: "controls.lateRangedFinishWeight", to: 4 as const }),
    Object.freeze({ field: "controls.pureRangedTerminalWeight", to: 1 as const }),
]);

interface IAdaptiveChild {
    index: number;
    id: string;
    label: string;
    parentCandidateId: string;
    parentCandidateIndex: number;
    parentGenomeSha256: string;
    mutation: IV08CampaignAdaptiveMutation;
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
    sourceCampaignBaseIdentitySha256: string;
    exactAnchorGenomeSha256: typeof V08_TEST_CANDIDATE_GENOME_SHA256;
    exactAnchorMutationFields: string[];
    exactAnchorMutationPlanSha256: string;
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

interface IValidationSelection {
    schema: "hoc.v0_8_aggressive_validation_selection.v1";
    version: typeof V08_CAMPAIGN_SELECTION_VERSION;
    manifestFingerprint: string;
    sourceEvidenceSha256: string;
    exactAnchorCandidateId: typeof V08_CAMPAIGN_EXACT_ANCHOR_ID;
    exactAnchorGenomeSha256: typeof V08_TEST_CANDIDATE_GENOME_SHA256;
    inactiveControlCandidateId: (typeof V08_CAMPAIGN_INACTIVE_CONTROL_IDS)[number];
    inactiveControlGenomeSha256: string;
    candidateIds: string[];
    candidateGenomeSha256: string[];
    createdAt: string;
    fingerprint: string;
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
    validationSelection: IValidationSelection | null;
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

export interface IV08CampaignArmageddonOutcomeBuckets {
    total: number;
    candidateWins: number;
    draws: number;
    candidateLosses: number;
}

interface ITournamentSummaryWithReached extends ITournamentSummary {
    armageddonReached: number;
    armageddonReachedByOutcome: IV08CampaignArmageddonOutcomeBuckets;
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
    validationWinsA: number;
    validationWinsB: number;
    validationDraws: number;
    validationCandidateWinRate: number;
    validationDecisiveWinRate: number;
    validationEvidenceSha256: string | null;
    games: number;
    winsA: number;
    winsB: number;
    draws: number;
    candidateWinRate: number;
    drawRate: number;
    decisiveWinRate: number;
    armageddonReached: number;
    armageddonDecided: number;
    armageddonRate: number;
    nonLossArmageddonReached: number;
    nonLossArmageddonRate: number;
    armageddonReachedCandidateWins: number;
    armageddonReachedDraws: number;
    armageddonReachedCandidateLosses: number;
    level4Games: number;
    level4ArmageddonReached: number;
    level4ArmageddonRate: number;
    hasLevel4Evidence: boolean;
    level4CoveragePassed: boolean;
    passesArmageddonGate: boolean;
    passesStrengthGate: boolean;
    promotionEligible: boolean;
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

function estimateJobDurationMs(job: JobWork, completed: readonly IJobDurationSample[], workersPerJob: number): number {
    return Math.ceil(jobWorkUnits(job) * estimatedMillisecondsPerWorkUnit(job.kind, completed, workersPerJob));
}

/** Estimate a parallel batch: its wall duration is governed by its slowest lane. */
export function estimateBatchDurationMs(
    jobs: readonly JobWork[],
    completed: readonly IJobDurationSample[],
    workersPerJob: number,
): number {
    if (!jobs.length) return 0;
    return Math.ceil(Math.max(...jobs.map((job) => estimateJobDurationMs(job, completed, workersPerJob))));
}

/** Estimate the FIFO list-scheduling makespan used by the dynamic lane scheduler. */
export function estimateDynamicQueueDurationMs(
    jobs: readonly JobWork[],
    completed: readonly IJobDurationSample[],
    workersPerJob: number,
    lanes: number,
): number {
    if (!Number.isSafeInteger(lanes) || lanes < 1) throw new Error("lanes must be a positive integer");
    if (!jobs.length) return 0;
    const laneReadyAt = Array.from({ length: Math.min(lanes, jobs.length) }, () => 0);
    for (const job of jobs) {
        let earliestLane = 0;
        for (let lane = 1; lane < laneReadyAt.length; lane += 1) {
            if (laneReadyAt[lane]! < laneReadyAt[earliestLane]!) earliestLane = lane;
        }
        laneReadyAt[earliestLane] = laneReadyAt[earliestLane]! + estimateJobDurationMs(job, completed, workersPerJob);
    }
    return Math.max(...laneReadyAt);
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

export interface IV08CampaignDynamicQueueItem {
    id: string;
}

export type V08CampaignDynamicQueueStatus =
    "completed" | "admission-deferred" | "deadline" | "stopped" | "job-incomplete";

export interface IV08CampaignDynamicQueueResult {
    status: V08CampaignDynamicQueueStatus;
    launchedJobs: number;
    completedJobs: number;
    remainingJobs: number;
    peakActiveLanes: number;
    peakActiveWorkers: number;
    deferredJobId: string | null;
}

export interface IV08CampaignDynamicQueueOptions<T extends IV08CampaignDynamicQueueItem> {
    jobs: readonly T[];
    lanes: number;
    workersPerJob: number;
    maxWorkers: number;
    deadlineAtMs: number;
    execute: (job: T) => Promise<boolean>;
    canAdmit?: (job: T, nowMs: number) => boolean;
    nowMs?: () => number;
    shouldStop?: () => boolean;
}

/**
 * Work-conserving FIFO lane scheduler. A completed lane immediately takes the next admitted job; no sibling
 * lane forms a batch barrier. Failed/stopped work halts new admission while already-running executors drain.
 */
export async function runV08CampaignDynamicQueue<T extends IV08CampaignDynamicQueueItem>(
    options: IV08CampaignDynamicQueueOptions<T>,
): Promise<IV08CampaignDynamicQueueResult> {
    if (!Number.isSafeInteger(options.lanes) || options.lanes < 1) {
        throw new Error("lanes must be a positive integer");
    }
    if (!Number.isSafeInteger(options.workersPerJob) || options.workersPerJob < 1) {
        throw new Error("workersPerJob must be a positive integer");
    }
    if (!Number.isSafeInteger(options.maxWorkers) || options.maxWorkers < options.workersPerJob) {
        throw new Error("maxWorkers must fit at least one job");
    }
    if (!Number.isFinite(options.deadlineAtMs)) throw new Error("deadlineAtMs must be finite");
    if (new Set(options.jobs.map(({ id }) => id)).size !== options.jobs.length) {
        throw new Error("Dynamic queue job IDs must be unique");
    }

    const nowMs = options.nowMs ?? Date.now;
    const shouldStop = options.shouldStop ?? (() => false);
    const laneCapacity = Math.min(options.lanes, Math.floor(options.maxWorkers / options.workersPerJob));
    type Settlement = { token: number; ok: boolean; error?: never } | { token: number; ok?: never; error: unknown };
    const active = new Map<number, Promise<Settlement>>();
    let activeWorkers = 0;
    let cursor = 0;
    let token = 0;
    let launchedJobs = 0;
    let completedJobs = 0;
    let peakActiveLanes = 0;
    let peakActiveWorkers = 0;
    let status: V08CampaignDynamicQueueStatus | "running" = "running";
    let deferredJobId: string | null = null;
    let firstError: unknown;

    const haltForCurrentState = (): boolean => {
        if (shouldStop()) {
            status = "stopped";
            return true;
        }
        if (nowMs() >= options.deadlineAtMs) {
            status = "deadline";
            return true;
        }
        return false;
    };

    const fillFreedLanes = (): void => {
        while (status === "running" && cursor < options.jobs.length && active.size < laneCapacity) {
            if (haltForCurrentState()) return;
            const job = options.jobs[cursor]!;
            const admissionNowMs = nowMs();
            if (options.canAdmit && !options.canAdmit(job, admissionNowMs)) {
                status = "admission-deferred";
                deferredJobId = job.id;
                return;
            }
            cursor += 1;
            launchedJobs += 1;
            activeWorkers += options.workersPerJob;
            if (activeWorkers > options.maxWorkers) throw new Error("Dynamic queue exceeded maxWorkers");
            const currentToken = token++;
            const execution: Promise<Settlement> = Promise.resolve()
                .then(() => options.execute(job))
                .then(
                    (ok): Settlement => ({ token: currentToken, ok }),
                    (error: unknown): Settlement => ({ token: currentToken, error }),
                );
            active.set(currentToken, execution);
            peakActiveLanes = Math.max(peakActiveLanes, active.size);
            peakActiveWorkers = Math.max(peakActiveWorkers, activeWorkers);
        }
    };

    fillFreedLanes();
    while (active.size > 0) {
        const settled = await Promise.race(active.values());
        active.delete(settled.token);
        activeWorkers -= options.workersPerJob;
        if ("error" in settled) {
            firstError ??= settled.error;
            status = "job-incomplete";
        } else if (settled.ok) {
            completedJobs += 1;
        } else if (status === "running") {
            status = shouldStop() ? "stopped" : nowMs() >= options.deadlineAtMs ? "deadline" : "job-incomplete";
        }
        if (status === "running") fillFreedLanes();
    }

    if (firstError !== undefined) throw firstError;
    if (status === "running") {
        status = cursor === options.jobs.length ? "completed" : "job-incomplete";
    }
    return {
        status,
        launchedJobs,
        completedJobs,
        remainingJobs: options.jobs.length - completedJobs,
        peakActiveLanes,
        peakActiveWorkers,
        deferredJobId,
    };
}

function parseCli(argv: readonly string[]): ICli {
    if (argv.includes("--help") || argv.includes("-h")) {
        console.log(
            "Usage: bun src/simulation/v0_8_aggressive_12h.ts [--output DIR] [--hours 12] " +
                "[--concurrency TOTAL_WORKERS] [--screen-games 256] [--validation-games 1024] " +
                `[--lanes ${V08_CAMPAIGN_DEFAULT_LANES}] [--top ${V08_CAMPAIGN_DEFAULT_TOP_CANDIDATES}] ` +
                "[--l4-pairs 16] [--screen-seed N] " +
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
        topCandidates: positiveInteger(flagValue(argv, "--top"), V08_CAMPAIGN_DEFAULT_TOP_CANDIDATES, "--top"),
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

/** The pinned production-48 catalog plus the immutable, independently qualified r3 profile as c48. */
export function buildV08CampaignBaseGenomes(): IV08AlignedV1CandidateGenome[] {
    const production = buildV08AlignedV1ProductionCandidateCatalog();
    if (production.length !== PRODUCTION_CANDIDATE_COUNT) {
        throw new Error(`Expected exact ${PRODUCTION_CANDIDATE_COUNT}-candidate production catalog`);
    }
    const exactAnchor = normalizeV08AlignedV1CandidateGenome(
        structuredClone(V08_TEST_CANDIDATE_GENOME) as IV08AlignedV1CandidateGenome,
    );
    const exactAnchorHash = fingerprintV08AlignedV1CandidateGenome(exactAnchor);
    const productionHashes = production.map(fingerprintV08AlignedV1CandidateGenome);
    if (exactAnchorHash !== V08_TEST_CANDIDATE_GENOME_SHA256 || productionHashes.includes(exactAnchorHash)) {
        throw new Error("Exact v0.8 r3 anchor identity drifted or duplicates the production catalog");
    }
    const campaign = [...production, exactAnchor];
    if (
        campaign.length !== BASE_CANDIDATE_COUNT ||
        candidateId(V08_CAMPAIGN_EXACT_ANCHOR_INDEX) !== V08_CAMPAIGN_EXACT_ANCHOR_ID ||
        new Set(campaign.map(fingerprintV08AlignedV1CandidateGenome)).size !== BASE_CANDIDATE_COUNT
    ) {
        throw new Error("v0.8 campaign base catalog census or uniqueness drifted");
    }
    return campaign.map((genome) => structuredClone(genome));
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

/**
 * Attribute every Armageddon-reached tournament record to the candidate's final outcome.
 *
 * Research ranking deliberately ignores candidate-loss Armageddons: preferring an earlier loss would make the
 * AI weaker. The absolute total remains available for the shipping gate.
 */
export function summarizeV08CampaignArmageddonJsonl(contents: string): IV08CampaignArmageddonOutcomeBuckets {
    const buckets: IV08CampaignArmageddonOutcomeBuckets = {
        total: 0,
        candidateWins: 0,
        draws: 0,
        candidateLosses: 0,
    };
    for (const line of contents.split("\n")) {
        if (!line.trim()) continue;
        const record = JSON.parse(line) as {
            winnerVersion?: unknown;
            result?: { attrition?: { reachedArmageddon?: unknown } };
        };
        if (record.result?.attrition?.reachedArmageddon !== true) continue;
        buckets.total += 1;
        if (record.winnerVersion === "v0.8s") buckets.candidateWins += 1;
        else if (record.winnerVersion === "draw") buckets.draws += 1;
        else if (record.winnerVersion === "v0.7") buckets.candidateLosses += 1;
        else throw new Error("Armageddon-reached tournament record has an unknown winnerVersion");
    }
    return buckets;
}

function armageddonEvidence(
    path: string,
): Pick<ITournamentSummaryWithReached, "armageddonReached" | "armageddonReachedByOutcome"> {
    const armageddonReachedByOutcome = summarizeV08CampaignArmageddonJsonl(readFileSync(path, "utf8"));
    return { armageddonReached: armageddonReachedByOutcome.total, armageddonReachedByOutcome };
}

function adaptiveCandidateId(index: number): string {
    return `a${String(index).padStart(2, "0")}`;
}

function controlProposal<K extends keyof IV08AlignedV1CandidateGenome["controls"]>(
    parent: IV08AlignedV1CandidateGenome,
    field: K,
    to: IV08AlignedV1CandidateGenome["controls"][K],
): IV08CampaignAdaptiveProposal {
    const genome = structuredClone(parent);
    const from = genome.controls[field];
    genome.controls[field] = to;
    return { genome, mutation: { kind: "control", field: `controls.${field}`, from, to } };
}

function adaptiveProposals(
    parent: IV08CampaignAdaptiveProposalParent,
    parents: readonly IV08CampaignAdaptiveProposalParent[],
): IV08CampaignAdaptiveProposal[] {
    const proposals: IV08CampaignAdaptiveProposal[] = [];
    const leafProposals: IV08CampaignAdaptiveProposal[] = [];
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
        if (donor.candidateId === parent.candidateId) continue;
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
                    donorCandidateId: donor.candidateId,
                    donorGenomeSha256: donor.genomeSha256,
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
    const defaultOrder = [
        ...proposals.slice(0, 2),
        ...leafProposals.slice(0, 2),
        ...proposals.slice(2),
        ...leafProposals.slice(2),
    ];
    if (parent.candidateId !== V08_CAMPAIGN_EXACT_ANCHOR_ID) return defaultOrder;

    const requiredFinish = V08_CAMPAIGN_EXACT_ANCHOR_REQUIRED_FINISH_MUTATIONS.map(({ field, to }) =>
        proposals.find((proposal) => proposal.mutation.field === field && proposal.mutation.to === to),
    );
    const lowerGate = proposals.find(
        (proposal) =>
            proposal.mutation.field === "search.gate" && Number(proposal.mutation.to) < Number(proposal.mutation.from),
    );
    const usefulLeaf = leafProposals.filter(
        ({ mutation }) => mutation.field === "search.leaf" && mutation.from !== mutation.to,
    );
    if (requiredFinish.some((proposal) => proposal === undefined) || !lowerGate || !usefulLeaf.length) {
        throw new Error("Exact c48 adaptive plan cannot cover finish, gate, and leaf mutations");
    }
    const priority = [...requiredFinish, lowerGate, ...usefulLeaf] as IV08CampaignAdaptiveProposal[];
    const prioritized = new Set(priority);
    return [...priority, ...defaultOrder.filter((proposal) => !prioritized.has(proposal))];
}

function assertExactAnchorMutationCoverage(proposals: readonly IV08CampaignAdaptiveProposal[]): void {
    const required = V08_CAMPAIGN_EXACT_ANCHOR_REQUIRED_FINISH_MUTATIONS;
    if (
        proposals.length < required.length + 2 ||
        required.some(
            ({ field, to }, index) =>
                proposals[index]?.mutation.field !== field || proposals[index]?.mutation.to !== to,
        ) ||
        !proposals.some(({ mutation }) => mutation.field === "search.gate") ||
        !proposals.some(({ mutation }) => mutation.field === "search.leaf")
    ) {
        throw new Error("Exact c48 children lost required finish, gate, or leaf mutation coverage");
    }
}

/** Select the exact unique child mutations used by generator v4, including c48's reserved finish coverage. */
export function selectV08CampaignAdaptiveChildProposals(
    parent: IV08CampaignAdaptiveProposalParent,
    parents: readonly IV08CampaignAdaptiveProposalParent[],
    existingGenomeSha256: readonly string[],
    count: number,
): IV08CampaignAdaptiveProposal[] {
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("adaptive child count must be positive");
    if (
        new Set(parents.map(({ candidateId }) => candidateId)).size !== parents.length ||
        fingerprintV08AlignedV1CandidateGenome(parent.genome) !== parent.genomeSha256 ||
        !parents.some(
            ({ candidateId, candidateIndex, genomeSha256 }) =>
                candidateId === parent.candidateId &&
                candidateIndex === parent.candidateIndex &&
                genomeSha256 === parent.genomeSha256,
        ) ||
        parents.some(({ genome, genomeSha256 }) => fingerprintV08AlignedV1CandidateGenome(genome) !== genomeSha256)
    ) {
        throw new Error("Adaptive proposal parents have invalid or duplicate identities");
    }
    if (
        parent.candidateId === V08_CAMPAIGN_EXACT_ANCHOR_ID &&
        (parent.candidateIndex !== V08_CAMPAIGN_EXACT_ANCHOR_INDEX ||
            parent.genomeSha256 !== V08_TEST_CANDIDATE_GENOME_SHA256)
    ) {
        throw new Error("Exact c48 adaptive parent identity drifted");
    }
    const seen = new Set(existingGenomeSha256);
    const selected: IV08CampaignAdaptiveProposal[] = [];
    for (const proposal of adaptiveProposals(parent, parents)) {
        if (selected.length >= count) break;
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
        selected.push({ genome: normalized, mutation: structuredClone(proposal.mutation) });
        seen.add(genomeSha256);
    }
    if (selected.length !== count) {
        throw new Error(`Adaptive parent ${parent.candidateId} produced only ${selected.length} unique safe children`);
    }
    if (parent.candidateId === V08_CAMPAIGN_EXACT_ANCHOR_ID) assertExactAnchorMutationCoverage(selected);
    return selected;
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
    mutation: IV08CampaignAdaptiveMutation,
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

export interface IV08CampaignResearchCandidate {
    candidateId: string;
    candidateIndex: number;
    candidateWinRate: number;
    drawRate: number;
    nonLossArmageddonRate: number;
}

/** All-game outcomes are lexicographically primary; Armageddon can only break an exact W/D outcome tie. */
export function compareV08CampaignResearchCandidates(
    left: IV08CampaignResearchCandidate,
    right: IV08CampaignResearchCandidate,
): number {
    return (
        right.candidateWinRate - left.candidateWinRate ||
        right.drawRate - left.drawRate ||
        left.nonLossArmageddonRate - right.nonLossArmageddonRate ||
        left.candidateIndex - right.candidateIndex ||
        left.candidateId.localeCompare(right.candidateId)
    );
}

export function rankV08CampaignResearchCandidates<T extends IV08CampaignResearchCandidate>(rows: readonly T[]): T[] {
    return [...rows].sort(compareV08CampaignResearchCandidates);
}

export function selectV08CampaignAdaptiveParents<T extends IV08CampaignResearchCandidate>(rows: readonly T[]): T[] {
    const exactAnchor = rows.find(({ candidateId }) => candidateId === V08_CAMPAIGN_EXACT_ANCHOR_ID);
    if (!exactAnchor) throw new Error("Adaptive generation requires the exact c48 anchor");
    const leaders = rankV08CampaignResearchCandidates(
        rows.filter(({ candidateId }) => candidateId !== V08_CAMPAIGN_EXACT_ANCHOR_ID),
    ).slice(0, ADAPTIVE_PARENT_COUNT - 1);
    if (leaders.length !== ADAPTIVE_PARENT_COUNT - 1) {
        throw new Error(`Adaptive generation requires ${ADAPTIVE_PARENT_COUNT - 1} non-anchor leaders`);
    }
    return [exactAnchor, ...leaders];
}

export function selectV08CampaignInactiveControl<T extends IV08CampaignResearchCandidate>(rows: readonly T[]): T {
    const c37 = rows.find((row) => row.candidateId === V08_CAMPAIGN_INACTIVE_CONTROL_IDS[0]);
    const c38 = rows.find((row) => row.candidateId === V08_CAMPAIGN_INACTIVE_CONTROL_IDS[1]);
    if (!c37 || !c38) {
        throw new Error("Both inactive-challenger controls c37/c38 are required");
    }
    return rankV08CampaignResearchCandidates([c37, c38])[0]!;
}

export function isV08CampaignReserveEligible(
    row: Pick<IRankedCandidate, "candidateWinRate" | "decisiveWinRate">,
): boolean {
    return (
        Number.isFinite(row.candidateWinRate) &&
        row.candidateWinRate >= V08_CAMPAIGN_RESERVE_ELIGIBILITY.minimumCandidateWinRate &&
        row.candidateWinRate <= 1 &&
        Number.isFinite(row.decisiveWinRate) &&
        row.decisiveWinRate >= V08_CAMPAIGN_RESERVE_ELIGIBILITY.minimumDecisiveWinRate &&
        row.decisiveWinRate <= 1
    );
}

export function selectV08CampaignLevel4CandidateIds<
    T extends IV08CampaignResearchCandidate & Pick<IRankedCandidate, "armageddonRate" | "decisiveWinRate">,
>(rows: readonly T[], count: number): string[] {
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("level-4 reserve count must be positive");
    const targetCount = Math.min(rows.length, Math.max(2, count));
    const anchor = rows.find(({ candidateId }) => candidateId === V08_CAMPAIGN_EXACT_ANCHOR_ID);
    if (!anchor) throw new Error("Level-4 reserve requires the exact c48 anchor");
    const inactiveControl = selectV08CampaignInactiveControl(rows);
    const selected: T[] = [];
    const seen = new Set<string>();
    const add = (row: T): void => {
        if (selected.length >= targetCount || seen.has(row.candidateId)) return;
        selected.push(row);
        seen.add(row.candidateId);
    };
    add(anchor);
    add(inactiveControl);

    const remainingSlots = Math.max(0, targetCount - selected.length);
    const strengthSlots = Math.ceil(remainingSlots / 2);
    const strength = rankV08CampaignResearchCandidates(rows);
    for (const row of strength) {
        if (selected.length >= 2 + strengthSlots) break;
        add(row);
    }
    const armReserve = rows
        .filter(isV08CampaignReserveEligible)
        .sort(
            (left, right) =>
                left.armageddonRate - right.armageddonRate || compareV08CampaignResearchCandidates(left, right),
        );
    for (const row of armReserve) add(row);
    for (const row of strength) add(row);
    if (selected.length !== targetCount) throw new Error("Level-4 reserve could not fill its requested census");
    return selected.map(({ candidateId }) => candidateId);
}

export function selectValidationCandidateIds(
    rows: readonly (IV08CampaignResearchCandidate &
        Pick<IRankedCandidate, "armageddonRate" | "decisiveWinRate" | "hasLevel4Evidence" | "level4CoveragePassed">)[],
    count: number,
): string[] {
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("validation candidate count must be positive");
    const targetCount = Math.max(2, count);
    const covered = rows.filter((row) => row.level4CoveragePassed);
    const anchor = rows.find(({ candidateId }) => candidateId === V08_CAMPAIGN_EXACT_ANCHOR_ID);
    if (!anchor?.hasLevel4Evidence) throw new Error("Exact c48 anchor must complete its level-4 job before validation");
    const screenedInactiveControl = selectV08CampaignInactiveControl(rows);
    if (!screenedInactiveControl.hasLevel4Evidence) {
        throw new Error("Best screened inactive-challenger control must complete its level-4 job");
    }
    const inactiveControl = screenedInactiveControl;
    const selected: Array<(typeof rows)[number]> = [];
    const seen = new Set<string>();
    const add = (row: (typeof covered)[number]): void => {
        if (selected.length >= targetCount || seen.has(row.candidateId)) return;
        selected.push(row);
        seen.add(row.candidateId);
    };
    add(anchor);
    add(inactiveControl);

    const remainingSlots = Math.max(0, targetCount - selected.length);
    const strengthSlots = Math.ceil(remainingSlots / 2);
    const strength = rankV08CampaignResearchCandidates(covered);
    for (const row of strength) {
        if (selected.length >= 2 + strengthSlots) break;
        add(row);
    }

    const armReserve = covered
        .filter(isV08CampaignReserveEligible)
        .sort(
            (left, right) =>
                left.armageddonRate - right.armageddonRate || compareV08CampaignResearchCandidates(left, right),
        );
    for (const row of armReserve) add(row);
    for (const row of strength) add(row);
    if (selected.length !== targetCount) {
        throw new Error(`Validation selection requires ${targetCount} covered candidates, found ${selected.length}`);
    }
    return selected.map(({ candidateId }) => candidateId);
}

export interface IV08CampaignValidationStrengthEvidence {
    validationRuns: number;
    validationGames: number;
    validationCandidateWinRate: number;
    validationDecisiveWinRate: number;
    validationEvidenceSha256: string | null;
}

export interface IV08CampaignPromotionEvidence extends IV08CampaignValidationStrengthEvidence {
    isExactAnchor: boolean;
    unboundedSearch: boolean;
    hasValidationEvidence: boolean;
    level4CoveragePassed: boolean;
    armageddonRate: number;
    level4ArmageddonRate: number;
}

export function isV08CampaignPromotionStrengthQualified(
    candidate: IV08CampaignValidationStrengthEvidence,
    exactAnchor: IV08CampaignValidationStrengthEvidence,
): boolean {
    if (
        !Number.isSafeInteger(candidate.validationRuns) ||
        !Number.isSafeInteger(exactAnchor.validationRuns) ||
        !Number.isSafeInteger(candidate.validationGames) ||
        !Number.isSafeInteger(exactAnchor.validationGames) ||
        candidate.validationRuns < 0 ||
        exactAnchor.validationRuns < 0 ||
        candidate.validationGames < 0 ||
        exactAnchor.validationGames < 0 ||
        !Number.isFinite(candidate.validationCandidateWinRate) ||
        !Number.isFinite(exactAnchor.validationCandidateWinRate) ||
        !Number.isFinite(candidate.validationDecisiveWinRate) ||
        !Number.isFinite(exactAnchor.validationDecisiveWinRate) ||
        candidate.validationCandidateWinRate < 0 ||
        candidate.validationCandidateWinRate > 1 ||
        exactAnchor.validationCandidateWinRate < 0 ||
        exactAnchor.validationCandidateWinRate > 1 ||
        candidate.validationDecisiveWinRate < 0 ||
        candidate.validationDecisiveWinRate > 1 ||
        exactAnchor.validationDecisiveWinRate < 0 ||
        exactAnchor.validationDecisiveWinRate > 1 ||
        (candidate.validationEvidenceSha256 !== null && !/^[a-f0-9]{64}$/.test(candidate.validationEvidenceSha256)) ||
        (exactAnchor.validationEvidenceSha256 !== null && !/^[a-f0-9]{64}$/.test(exactAnchor.validationEvidenceSha256))
    ) {
        throw new Error("Invalid v0.8 campaign validation strength evidence");
    }
    return (
        candidate.validationRuns > 0 &&
        candidate.validationRuns === exactAnchor.validationRuns &&
        candidate.validationGames > 0 &&
        candidate.validationGames === exactAnchor.validationGames &&
        candidate.validationEvidenceSha256 !== null &&
        candidate.validationEvidenceSha256 === exactAnchor.validationEvidenceSha256 &&
        candidate.validationCandidateWinRate >= exactAnchor.validationCandidateWinRate &&
        candidate.validationDecisiveWinRate >= exactAnchor.validationDecisiveWinRate
    );
}

/** Research fitness is never deployable until replayed inside the reviewed bounded operational envelope. */
export function isV08CampaignPromotionEligible(
    evidence: IV08CampaignPromotionEvidence,
    exactAnchor: IV08CampaignValidationStrengthEvidence,
): boolean {
    return (
        !evidence.isExactAnchor &&
        !evidence.unboundedSearch &&
        evidence.hasValidationEvidence &&
        evidence.level4CoveragePassed &&
        isV08CampaignPromotionStrengthQualified(evidence, exactAnchor) &&
        Number.isFinite(evidence.armageddonRate) &&
        evidence.armageddonRate >= 0 &&
        evidence.armageddonRate <= ARMAGEDDON_RATE_GATE &&
        Number.isFinite(evidence.level4ArmageddonRate) &&
        evidence.level4ArmageddonRate >= 0 &&
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
    const armageddon = summary.armageddonReachedByOutcome;
    if (
        summary.versionA !== "v0.8s" ||
        summary.versionB !== "v0.7" ||
        !Number.isSafeInteger(summary.games) ||
        !summary.a ||
        !summary.b ||
        typeof summary.winRateA !== "number" ||
        !Number.isSafeInteger(summary.armageddonDecided) ||
        !Number.isSafeInteger(summary.armageddonReached) ||
        !armageddon ||
        !Number.isSafeInteger(armageddon.total) ||
        !Number.isSafeInteger(armageddon.candidateWins) ||
        !Number.isSafeInteger(armageddon.draws) ||
        !Number.isSafeInteger(armageddon.candidateLosses) ||
        armageddon.total < 0 ||
        armageddon.candidateWins < 0 ||
        armageddon.draws < 0 ||
        armageddon.candidateLosses < 0 ||
        armageddon.total !== summary.armageddonReached ||
        armageddon.candidateWins + armageddon.draws + armageddon.candidateLosses !== armageddon.total ||
        armageddon.total > (summary.games ?? -1)
    ) {
        throw new Error(`Invalid tournament summary: ${path}`);
    }
    return summary as ITournamentSummaryWithReached;
}

/** Minimal version header check used before accepting any resumable manifest. */
export function isV08CampaignManifestProvenanceCurrent(value: unknown): boolean {
    const manifest = value as {
        schema?: unknown;
        kind?: unknown;
        adaptive?: { generatorVersion?: unknown };
        scheduler?: { version?: unknown };
        campaignBaseIdentity?: {
            campaignCandidateCount?: unknown;
            exactAnchor?: { id?: unknown; genomeSha256?: unknown };
            inactiveControls?: Array<{ id?: unknown }>;
        };
        selection?: { version?: unknown; exactAnchorCandidateId?: unknown };
        promotionComparison?: { version?: unknown; exactAnchorCandidateId?: unknown };
    };
    return (
        manifest?.schema === V08_CAMPAIGN_SCHEMA &&
        manifest.kind === "manifest" &&
        manifest.adaptive?.generatorVersion === V08_CAMPAIGN_ADAPTIVE_GENERATOR_VERSION &&
        manifest.scheduler?.version === V08_CAMPAIGN_SCHEDULER_VERSION &&
        manifest.campaignBaseIdentity?.campaignCandidateCount === BASE_CANDIDATE_COUNT &&
        manifest.campaignBaseIdentity.exactAnchor?.id === V08_CAMPAIGN_EXACT_ANCHOR_ID &&
        manifest.campaignBaseIdentity.exactAnchor.genomeSha256 === V08_TEST_CANDIDATE_GENOME_SHA256 &&
        Array.isArray(manifest.campaignBaseIdentity.inactiveControls) &&
        fingerprintV08AlignedV1(manifest.campaignBaseIdentity.inactiveControls.map(({ id }) => id)) ===
            fingerprintV08AlignedV1(V08_CAMPAIGN_INACTIVE_CONTROL_IDS) &&
        manifest.selection?.version === V08_CAMPAIGN_SELECTION_VERSION &&
        manifest.selection.exactAnchorCandidateId === V08_CAMPAIGN_EXACT_ANCHOR_ID &&
        manifest.promotionComparison?.version === V08_CAMPAIGN_PROMOTION_COMPARISON_VERSION &&
        manifest.promotionComparison.exactAnchorCandidateId === V08_CAMPAIGN_EXACT_ANCHOR_ID
    );
}

export interface IV08CampaignAdaptiveCatalogProvenanceExpectation {
    manifestFingerprint: string;
    campaignBaseIdentitySha256: string;
}

/** Minimal resume header check binding generator v4 to the full production-48-plus-c48 campaign base. */
export function isV08CampaignAdaptiveCatalogProvenanceCurrent(
    value: unknown,
    expected: IV08CampaignAdaptiveCatalogProvenanceExpectation,
): boolean {
    const catalog = value as {
        schema?: unknown;
        kind?: unknown;
        manifestFingerprint?: unknown;
        generatorVersion?: unknown;
        sourceCampaignBaseIdentitySha256?: unknown;
        exactAnchorGenomeSha256?: unknown;
    };
    return (
        /^[a-f0-9]{64}$/.test(expected.manifestFingerprint) &&
        /^[a-f0-9]{64}$/.test(expected.campaignBaseIdentitySha256) &&
        catalog?.schema === V08_CAMPAIGN_SCHEMA &&
        catalog.kind === "adaptive-catalog" &&
        catalog.manifestFingerprint === expected.manifestFingerprint &&
        catalog.generatorVersion === V08_CAMPAIGN_ADAPTIVE_GENERATOR_VERSION &&
        catalog.sourceCampaignBaseIdentitySha256 === expected.campaignBaseIdentitySha256 &&
        catalog.exactAnchorGenomeSha256 === V08_TEST_CANDIDATE_GENOME_SHA256
    );
}

function campaignCandidateDescriptors(
    bindings: readonly IV08AlignedV1CandidateBinding[],
    unboundedSearch: boolean,
): IManifestCandidate[] {
    return bindings.map((binding, index) => {
        const environment = effectiveBehaviorEnvironment(binding, "<job-audit-path>", unboundedSearch);
        return {
            index,
            id: candidateId(index),
            label: binding.genome.search.label ?? null,
            genomeSha256: binding.genomeSha256,
            bindingSha256: fingerprintV08AlignedV1(binding),
            effectiveBehaviorEnvironmentSha256: fingerprintV08AlignedV1(environment),
        };
    });
}

function buildCampaignBaseIdentity(candidates: readonly IManifestCandidate[]): ICampaignBaseIdentity {
    const productionIdentity = buildV08AlignedV1ProductionCatalogIdentity();
    const exactAnchor = candidates[V08_CAMPAIGN_EXACT_ANCHOR_INDEX];
    const inactiveControls = V08_CAMPAIGN_INACTIVE_CONTROL_IDS.map((id) =>
        candidates.find((candidate) => candidate.id === id),
    );
    if (
        candidates.length !== BASE_CANDIDATE_COUNT ||
        !exactAnchor ||
        exactAnchor.id !== V08_CAMPAIGN_EXACT_ANCHOR_ID ||
        exactAnchor.genomeSha256 !== V08_TEST_CANDIDATE_GENOME_SHA256 ||
        inactiveControls.some((candidate) => candidate === undefined)
    ) {
        throw new Error("Campaign base candidates do not contain the pinned anchor/control identities");
    }
    const unsigned = {
        schemaVersion: 1 as const,
        productionCatalogSha256: productionIdentity.catalogSha256,
        productionCandidateCount: PRODUCTION_CANDIDATE_COUNT as typeof PRODUCTION_CANDIDATE_COUNT,
        campaignCandidateCount: BASE_CANDIDATE_COUNT as typeof BASE_CANDIDATE_COUNT,
        orderedCandidateGenomeSha256: candidates.map(({ genomeSha256 }) => genomeSha256),
        exactAnchor: structuredClone(exactAnchor),
        inactiveControls: inactiveControls.map((candidate) => structuredClone(candidate!)) as [
            IManifestCandidate,
            IManifestCandidate,
        ],
    };
    return { ...unsigned, identitySha256: fingerprintV08AlignedV1(unsigned) };
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
    const candidates = campaignCandidateDescriptors(bindings, cli.unboundedSearch);
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
        researchRanking: V08_CAMPAIGN_RESEARCH_RANKING,
        reserveEligibility: V08_CAMPAIGN_RESERVE_ELIGIBILITY,
        selection: {
            version: V08_CAMPAIGN_SELECTION_VERSION as typeof V08_CAMPAIGN_SELECTION_VERSION,
            exactAnchorCandidateId: V08_CAMPAIGN_EXACT_ANCHOR_ID,
            inactiveControlCandidateIds: V08_CAMPAIGN_INACTIVE_CONTROL_IDS,
            minimumValidationCandidates: 2 as const,
            strategy: "exact-anchor_then_inactive-control_then_strength_then_total-arm-reserve" as const,
        },
        promotionComparison: {
            version: V08_CAMPAIGN_PROMOTION_COMPARISON_VERSION as typeof V08_CAMPAIGN_PROMOTION_COMPARISON_VERSION,
            exactAnchorCandidateId: V08_CAMPAIGN_EXACT_ANCHOR_ID,
            evidence: "fully-committed-common-random-validation-rounds" as const,
            minimumCandidateWinRateDelta: 0 as const,
            minimumDecisiveWinRateDelta: 0 as const,
        },
        scheduler: {
            version: V08_CAMPAIGN_SCHEDULER_VERSION as typeof V08_CAMPAIGN_SCHEDULER_VERSION,
            discipline: "work-conserving-fifo" as const,
            validationEvidenceCommit: "complete-round-only" as const,
            validationRoundPipelining: false as const,
        },
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
        campaignBaseIdentity: buildCampaignBaseIdentity(candidates),
        candidates,
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
    const expectedCandidates = campaignCandidateDescriptors(bindings, cli.unboundedSearch);
    const expectedCampaignBaseIdentity = buildCampaignBaseIdentity(expectedCandidates);
    if (
        !isV08CampaignManifestProvenanceCurrent(manifest) ||
        manifest.fingerprint !== fingerprintV08AlignedV1({ ...manifest, fingerprint: undefined }) ||
        JSON.stringify(manifest.config) !== JSON.stringify(requested) ||
        manifest.catalogIdentity.catalogSha256 !== expectedCatalog.catalogSha256 ||
        fingerprintV08AlignedV1(manifest.campaignBaseIdentity) !==
            fingerprintV08AlignedV1(expectedCampaignBaseIdentity) ||
        manifest.researchRanking !== V08_CAMPAIGN_RESEARCH_RANKING ||
        fingerprintV08AlignedV1(manifest.reserveEligibility) !==
            fingerprintV08AlignedV1(V08_CAMPAIGN_RESERVE_ELIGIBILITY) ||
        manifest.selection.strategy !== "exact-anchor_then_inactive-control_then_strength_then_total-arm-reserve" ||
        manifest.selection.minimumValidationCandidates !== 2 ||
        fingerprintV08AlignedV1(manifest.selection.inactiveControlCandidateIds) !==
            fingerprintV08AlignedV1(V08_CAMPAIGN_INACTIVE_CONTROL_IDS) ||
        manifest.promotionComparison.evidence !== "fully-committed-common-random-validation-rounds" ||
        manifest.promotionComparison.minimumCandidateWinRateDelta !== 0 ||
        manifest.promotionComparison.minimumDecisiveWinRateDelta !== 0 ||
        manifest.scheduler.discipline !== "work-conserving-fifo" ||
        manifest.scheduler.validationEvidenceCommit !== "complete-round-only" ||
        manifest.scheduler.validationRoundPipelining !== false ||
        manifest.adaptive.parentCount !== ADAPTIVE_PARENT_COUNT ||
        manifest.adaptive.childTarget !== ADAPTIVE_CHILD_TARGET ||
        manifest.adaptive.screenSeed !== cli.screenSeed ||
        manifest.adaptive.screenGames !== cli.screenGames ||
        manifest.adaptive.computeExpansionAllowed !== false ||
        manifest.adaptive.level4ReserveMultiplier !== LEVEL4_RESERVE_MULTIPLIER ||
        manifest.candidates.length !== bindings.length ||
        fingerprintV08AlignedV1(manifest.candidates) !== fingerprintV08AlignedV1(expectedCandidates)
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

export interface IV08CampaignValidationRoundCensusInput {
    completed: readonly Pick<ICompletedJob, "id" | "kind" | "candidateId" | "games" | "baseSeed">[];
    nextValidationRound: number;
    candidateIds: readonly string[];
    validationGames: number;
    validationSeed: number;
}

/** Fail closed unless every committed round contains the exact persisted shortlist on one common seed panel. */
export function assertV08CampaignCommittedValidationRoundCensus({
    completed,
    nextValidationRound,
    candidateIds,
    validationGames,
    validationSeed,
}: IV08CampaignValidationRoundCensusInput): void {
    if (
        !Number.isSafeInteger(nextValidationRound) ||
        nextValidationRound < 0 ||
        !Number.isSafeInteger(validationGames) ||
        validationGames < 1 ||
        !Number.isSafeInteger(validationSeed) ||
        validationSeed < 0 ||
        validationSeed > 0xffffffff ||
        new Set(candidateIds).size !== candidateIds.length ||
        candidateIds.some((id) => typeof id !== "string" || !id)
    ) {
        throw new Error("Invalid committed validation-round census input");
    }
    const candidateSet = new Set(candidateIds);
    const committed = new Set<string>();
    const seenValidation = new Set<string>();
    let validationJobs = 0;
    for (const job of completed) {
        if (job.kind !== "validation") continue;
        validationJobs += 1;
        const match = /^validation-r(\d+)-(.+)$/.exec(job.id);
        if (!match || match[2] !== job.candidateId) {
            throw new Error(`Validation job ${job.id} has a non-canonical round identity`);
        }
        const round = Number(match[1]);
        const expectedId = `validation-r${String(round).padStart(3, "0")}-${job.candidateId}`;
        if (
            !Number.isSafeInteger(round) ||
            round > nextValidationRound ||
            job.id !== expectedId ||
            !candidateSet.has(job.candidateId) ||
            job.games !== validationGames ||
            job.baseSeed !== (validationSeed + round * 1_000_003) >>> 0
        ) {
            throw new Error(`Validation job ${job.id} is outside the persisted common-random round plan`);
        }
        const key = `${round}:${job.candidateId}`;
        if (seenValidation.has(key)) throw new Error(`Validation round contains duplicate ${key}`);
        seenValidation.add(key);
        if (round < nextValidationRound) {
            committed.add(key);
        }
    }
    if ((nextValidationRound > 0 || validationJobs > 0) && candidateIds.length < 2) {
        throw new Error("Committed validation evidence requires a persisted shortlist");
    }
    for (let round = 0; round < nextValidationRound; round += 1) {
        for (const candidateId of candidateIds) {
            if (!committed.has(`${round}:${candidateId}`)) {
                throw new Error(`Committed validation round ${round} is missing candidate ${candidateId}`);
            }
        }
    }
}

/** Validation artifacts are evidence only after every shortlisted candidate in their round has committed. */
export function isV08CampaignValidationEvidenceCommitted(
    job: Pick<IJobSpec, "id" | "kind" | "candidateId">,
    nextValidationRound: number,
): boolean {
    if (!Number.isSafeInteger(nextValidationRound) || nextValidationRound < 0) {
        throw new Error("nextValidationRound must be a non-negative integer");
    }
    if (job.kind !== "validation") return true;
    const match = /^validation-r(\d+)-(.+)$/.exec(job.id);
    if (!match || match[2] !== job.candidateId) {
        throw new Error(`Validation job ${job.id} has a non-canonical round identity`);
    }
    const round = Number(match[1]);
    if (!Number.isSafeInteger(round)) throw new Error(`Validation job ${job.id} has an invalid round`);
    return round < nextValidationRound;
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
            ...armageddonEvidence(tournamentJsonl(dirname(paths.summaryPath))),
        };
        if (fingerprintV08AlignedV1(source) !== fingerprintV08AlignedV1(result.summary)) {
            throw new Error(`Tournament result ${job.id} does not match its source artifacts`);
        }
    }
    return result;
}

function assertValidationSelectionHeader(selection: IValidationSelection, manifest: IManifest): void {
    const inactive = manifest.campaignBaseIdentity.inactiveControls.find(
        ({ id }) => id === selection.inactiveControlCandidateId,
    );
    if (
        selection.schema !== "hoc.v0_8_aggressive_validation_selection.v1" ||
        selection.version !== V08_CAMPAIGN_SELECTION_VERSION ||
        selection.manifestFingerprint !== manifest.fingerprint ||
        selection.exactAnchorCandidateId !== V08_CAMPAIGN_EXACT_ANCHOR_ID ||
        selection.exactAnchorGenomeSha256 !== V08_TEST_CANDIDATE_GENOME_SHA256 ||
        !V08_CAMPAIGN_INACTIVE_CONTROL_IDS.includes(selection.inactiveControlCandidateId) ||
        !inactive ||
        selection.inactiveControlGenomeSha256 !== inactive.genomeSha256 ||
        !Array.isArray(selection.candidateIds) ||
        !Array.isArray(selection.candidateGenomeSha256) ||
        selection.candidateIds.length < 2 ||
        selection.candidateIds.length !== selection.candidateGenomeSha256.length ||
        selection.candidateIds.some((id) => typeof id !== "string" || !/^[a-z][a-z0-9]*$/i.test(id)) ||
        selection.candidateGenomeSha256.some(
            (genomeSha256) => typeof genomeSha256 !== "string" || !/^[a-f0-9]{64}$/.test(genomeSha256),
        ) ||
        selection.candidateIds[0] !== V08_CAMPAIGN_EXACT_ANCHOR_ID ||
        selection.candidateGenomeSha256[0] !== V08_TEST_CANDIDATE_GENOME_SHA256 ||
        selection.candidateIds[1] !== selection.inactiveControlCandidateId ||
        selection.candidateGenomeSha256[1] !== selection.inactiveControlGenomeSha256 ||
        !selection.candidateIds.includes(V08_CAMPAIGN_EXACT_ANCHOR_ID) ||
        !selection.candidateIds.includes(selection.inactiveControlCandidateId) ||
        new Set(selection.candidateIds).size !== selection.candidateIds.length ||
        typeof selection.sourceEvidenceSha256 !== "string" ||
        !selection.sourceEvidenceSha256 ||
        typeof selection.createdAt !== "string" ||
        !Number.isFinite(Date.parse(selection.createdAt)) ||
        selection.fingerprint !== fingerprintV08AlignedV1({ ...selection, fingerprint: undefined })
    ) {
        throw new Error("Checkpoint validation selection identity is invalid");
    }
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
            validationSelection: null,
            activeJobs: {},
            updatedAt: new Date().toISOString(),
        };
    }
    const checkpoint = readJson<ICheckpoint>(path);
    if (
        checkpoint.schema !== SCHEMA ||
        checkpoint.kind !== "checkpoint" ||
        checkpoint.manifestFingerprint !== manifest.fingerprint ||
        !["screen", "adaptive", "level4", "validation", "complete"].includes(checkpoint.phase) ||
        !Number.isSafeInteger(checkpoint.validationRound) ||
        checkpoint.validationRound < 0 ||
        !Array.isArray(checkpoint.completed) ||
        !(checkpoint.adaptiveCatalog === null || typeof checkpoint.adaptiveCatalog === "object") ||
        !(checkpoint.validationSelection === null || typeof checkpoint.validationSelection === "object") ||
        !checkpoint.activeJobs ||
        typeof checkpoint.activeJobs !== "object" ||
        Array.isArray(checkpoint.activeJobs)
    ) {
        throw new Error(`Invalid checkpoint: ${path}`);
    }
    if (checkpoint.validationSelection !== null) {
        assertValidationSelectionHeader(checkpoint.validationSelection, manifest);
    }
    const completedIds = new Set<string>();
    for (const job of checkpoint.completed) {
        if (completedIds.has(job.id)) throw new Error(`Checkpoint contains duplicate completed job ${job.id}`);
        completedIds.add(job.id);
        validateResultArtifact(manifest, job, false);
    }
    assertV08CampaignCommittedValidationRoundCensus({
        completed: checkpoint.completed,
        nextValidationRound: checkpoint.validationRound,
        candidateIds: checkpoint.validationSelection?.candidateIds ?? [],
        validationGames: manifest.config.validationGames,
        validationSeed: manifest.config.validationSeed,
    });
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
    // is the recovery commit point; runJobQueue reconciles any result written just before interruption.
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
    assertV08CampaignCommittedValidationRoundCensus({
        completed: checkpoint.completed,
        nextValidationRound: checkpoint.validationRound,
        candidateIds: checkpoint.validationSelection?.candidateIds ?? [],
        validationGames: manifest.config.validationGames,
        validationSeed: manifest.config.validationSeed,
    });
    const metadata = candidateMetadata(manifest, adaptive);
    const byCandidate = new Map<string, ITournamentSummaryWithReached[]>();
    const validationByCandidate = new Map<string, ITournamentSummaryWithReached[]>();
    const validationEvidenceByCandidate = new Map<string, Array<{ round: number; games: number; baseSeed: number }>>();
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
        if (!isV08CampaignValidationEvidenceCommitted(job, checkpoint.validationRound)) continue;
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
            const match = /^validation-r(\d+)-/.exec(job.id);
            if (!match || job.games === undefined) throw new Error(`Validation job ${job.id} has invalid evidence`);
            const evidence = validationEvidenceByCandidate.get(job.candidateId) ?? [];
            evidence.push({ round: Number(match[1]), games: job.games, baseSeed: job.baseSeed });
            validationEvidenceByCandidate.set(job.candidateId, evidence);
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
        const armageddonReachedCandidateWins = summaries.reduce(
            (sum, summary) => sum + summary.armageddonReachedByOutcome.candidateWins,
            0,
        );
        const armageddonReachedDraws = summaries.reduce(
            (sum, summary) => sum + summary.armageddonReachedByOutcome.draws,
            0,
        );
        const armageddonReachedCandidateLosses = summaries.reduce(
            (sum, summary) => sum + summary.armageddonReachedByOutcome.candidateLosses,
            0,
        );
        const validationSummaries = validationByCandidate.get(id) ?? [];
        const validationRuns = validationSummaries.length;
        const validationGames = validationSummaries.reduce((sum, summary) => sum + summary.games, 0);
        const hasValidationEvidence = validationRuns > 0;
        const validationWinsA = validationSummaries.reduce((sum, summary) => sum + summary.a.wins, 0);
        const validationWinsB = validationSummaries.reduce((sum, summary) => sum + summary.b.wins, 0);
        const validationDraws = validationSummaries.reduce((sum, summary) => sum + summary.draws, 0);
        const validationCandidateWinRate = validationGames ? validationWinsA / validationGames : 0;
        const validationDecisiveWinRate =
            validationWinsA + validationWinsB ? validationWinsA / (validationWinsA + validationWinsB) : 0.5;
        const validationEvidence = (validationEvidenceByCandidate.get(id) ?? []).sort(
            (left, right) => left.round - right.round,
        );
        const validationEvidenceSha256 = validationEvidence.length ? fingerprintV08AlignedV1(validationEvidence) : null;
        const candidateWinRate = games ? winsA / games : 0;
        const drawRate = games ? draws / games : 0;
        const decisiveWinRate = winsA + winsB ? winsA / (winsA + winsB) : 0.5;
        const armageddonRate = games ? armageddonReached / games : 1;
        const nonLossArmageddonReached = armageddonReachedCandidateWins + armageddonReachedDraws;
        const nonLossArmageddonRate = games ? nonLossArmageddonReached / games : 1;
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
        const hasLevel4Evidence = level4Summaries.length > 0;
        const level4CoveragePassed =
            hasLevel4Evidence &&
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
            validationWinsA,
            validationWinsB,
            validationDraws,
            validationCandidateWinRate,
            validationDecisiveWinRate,
            validationEvidenceSha256,
            games,
            winsA,
            winsB,
            draws,
            candidateWinRate,
            drawRate,
            decisiveWinRate,
            armageddonReached,
            armageddonDecided,
            armageddonRate,
            nonLossArmageddonReached,
            nonLossArmageddonRate,
            armageddonReachedCandidateWins,
            armageddonReachedDraws,
            armageddonReachedCandidateLosses,
            level4Games,
            level4ArmageddonReached,
            level4ArmageddonRate,
            hasLevel4Evidence,
            level4CoveragePassed,
            passesArmageddonGate,
            passesStrengthGate: false,
            promotionEligible: false,
            level4SummaryPaths: level4ByCandidate.get(id) ?? [],
        };
    });
    const exactAnchor = rows.find(
        ({ candidateId }) => candidateId === manifest.promotionComparison.exactAnchorCandidateId,
    );
    if (exactAnchor) {
        for (const row of rows) {
            row.passesStrengthGate =
                row.candidateId !== V08_CAMPAIGN_EXACT_ANCHOR_ID &&
                isV08CampaignPromotionStrengthQualified(row, exactAnchor);
            row.promotionEligible = isV08CampaignPromotionEligible(
                {
                    ...row,
                    isExactAnchor: row.candidateId === V08_CAMPAIGN_EXACT_ANCHOR_ID,
                    unboundedSearch: manifest.config.unboundedSearch,
                },
                exactAnchor,
            );
        }
    }
    rows.sort(
        (left, right) =>
            Number(right.promotionEligible) - Number(left.promotionEligible) ||
            Number(right.hasValidationEvidence) - Number(left.hasValidationEvidence) ||
            compareV08CampaignResearchCandidates(left, right),
    );
    rows.forEach((row, index) => (row.rank = index + 1));
    atomicJson(join(manifest.output, options.outputName ?? "leaderboard.json"), {
        schema: SCHEMA,
        kind: "leaderboard",
        researchOnly: true,
        generatedAt: new Date().toISOString(),
        armageddonRateGate: ARMAGEDDON_RATE_GATE,
        researchRanking: V08_CAMPAIGN_RESEARCH_RANKING,
        reserveEligibility: manifest.reserveEligibility,
        promotionComparison: manifest.promotionComparison,
        unboundedSearch: manifest.config.unboundedSearch,
        operationalReplayRequired: manifest.config.unboundedSearch,
        promotionCandidateId: rows.find((row) => row.promotionEligible)?.candidateId ?? null,
        rows,
    });
    return rows;
}

function validationSelectionEvidenceSha256(rows: readonly IRankedCandidate[]): string {
    return fingerprintV08AlignedV1(
        [...rows]
            .sort((left, right) => left.candidateIndex - right.candidateIndex)
            .map((row) => ({
                candidateId: row.candidateId,
                candidateIndex: row.candidateIndex,
                genomeSha256: row.genomeSha256,
                games: row.games,
                winsA: row.winsA,
                winsB: row.winsB,
                draws: row.draws,
                armageddonReached: row.armageddonReached,
                nonLossArmageddonReached: row.nonLossArmageddonReached,
                armageddonReachedCandidateWins: row.armageddonReachedCandidateWins,
                armageddonReachedDraws: row.armageddonReachedDraws,
                armageddonReachedCandidateLosses: row.armageddonReachedCandidateLosses,
                candidateWinRate: row.candidateWinRate,
                decisiveWinRate: row.decisiveWinRate,
                level4Games: row.level4Games,
                level4ArmageddonReached: row.level4ArmageddonReached,
                hasLevel4Evidence: row.hasLevel4Evidence,
                level4CoveragePassed: row.level4CoveragePassed,
            })),
    );
}

function buildValidationSelection(
    manifest: IManifest,
    rows: readonly IRankedCandidate[],
    count: number,
): IValidationSelection {
    const candidateIds = selectValidationCandidateIds(rows, count);
    const rowsById = new Map(rows.map((row) => [row.candidateId, row]));
    const selected = candidateIds.map((id) => rowsById.get(id));
    if (selected.some((row) => row === undefined)) throw new Error("Validation selection references a missing row");
    const inactiveControlCandidateId = candidateIds[1];
    if (!V08_CAMPAIGN_INACTIVE_CONTROL_IDS.some((id) => id === inactiveControlCandidateId)) {
        throw new Error("Validation selection did not retain the inactive-challenger control in slot 2");
    }
    const unsigned = {
        schema: "hoc.v0_8_aggressive_validation_selection.v1" as const,
        version: V08_CAMPAIGN_SELECTION_VERSION as typeof V08_CAMPAIGN_SELECTION_VERSION,
        manifestFingerprint: manifest.fingerprint,
        sourceEvidenceSha256: validationSelectionEvidenceSha256(rows),
        exactAnchorCandidateId: V08_CAMPAIGN_EXACT_ANCHOR_ID,
        exactAnchorGenomeSha256: V08_TEST_CANDIDATE_GENOME_SHA256,
        inactiveControlCandidateId: inactiveControlCandidateId as IValidationSelection["inactiveControlCandidateId"],
        inactiveControlGenomeSha256: selected[1]!.genomeSha256,
        candidateIds,
        candidateGenomeSha256: selected.map((row) => row!.genomeSha256),
        createdAt: new Date().toISOString(),
    };
    const selection = { ...unsigned, fingerprint: fingerprintV08AlignedV1(unsigned) };
    assertValidationSelectionHeader(selection, manifest);
    return selection;
}

function validateValidationSelection(
    selection: IValidationSelection,
    manifest: IManifest,
    rows: readonly IRankedCandidate[],
): void {
    assertValidationSelectionHeader(selection, manifest);
    const expectedIds = selectValidationCandidateIds(rows, manifest.config.topCandidates);
    const rowsById = new Map(rows.map((row) => [row.candidateId, row]));
    const expectedHashes = selection.candidateIds.map((id) => rowsById.get(id)?.genomeSha256);
    if (
        selection.sourceEvidenceSha256 !== validationSelectionEvidenceSha256(rows) ||
        fingerprintV08AlignedV1(selection.candidateIds) !== fingerprintV08AlignedV1(expectedIds) ||
        expectedHashes.some((hash) => hash === undefined) ||
        fingerprintV08AlignedV1(selection.candidateGenomeSha256) !== fingerprintV08AlignedV1(expectedHashes) ||
        selection.candidateIds.some((id, index) => {
            const row = rowsById.get(id);
            return !row?.hasLevel4Evidence || (index >= 2 && !row.level4CoveragePassed);
        })
    ) {
        throw new Error("Persisted validation selection no longer matches its committed source evidence");
    }
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
    const parentRows = selectV08CampaignAdaptiveParents(baseRows);
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
    const proposalParents: IV08CampaignAdaptiveProposalParent[] = parents.map(({ row, genome }) => ({
        candidateId: row.candidateId,
        candidateIndex: row.candidateIndex,
        genomeSha256: row.genomeSha256,
        genome,
    }));

    for (const [parentOffset, parent] of parents.entries()) {
        const proposalParent = proposalParents[parentOffset]!;
        const selectedProposals = selectV08CampaignAdaptiveChildProposals(
            proposalParent,
            proposalParents,
            [...seen],
            childrenPerParent,
        );
        for (const proposal of selectedProposals) {
            const normalized = proposal.genome;
            const genomeSha256 = fingerprintV08AlignedV1CandidateGenome(normalized);

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
        }
    }
    if (children.length !== ADAPTIVE_CHILD_TARGET) {
        throw new Error(`Adaptive generator produced ${children.length}/${ADAPTIVE_CHILD_TARGET} children`);
    }
    const exactAnchorChildren = children.filter(
        ({ parentCandidateId }) => parentCandidateId === V08_CAMPAIGN_EXACT_ANCHOR_ID,
    );
    const exactAnchorProposals = exactAnchorChildren.map(({ genome, mutation }) => ({ genome, mutation }));
    assertExactAnchorMutationCoverage(exactAnchorProposals);
    const exactAnchorMutationFields = exactAnchorChildren.map(({ mutation }) => mutation.field);
    const exactAnchorMutationPlanSha256 = fingerprintV08AlignedV1(
        exactAnchorChildren.map(({ id, mutation, genomeSha256 }) => ({ id, mutation, genomeSha256 })),
    );
    const unsigned = {
        schema: SCHEMA,
        kind: "adaptive-catalog" as const,
        researchOnly: true as const,
        automaticBake: false as const,
        automaticDeploy: false as const,
        manifestFingerprint: manifest.fingerprint,
        generatorVersion: ADAPTIVE_GENERATOR_VERSION as typeof ADAPTIVE_GENERATOR_VERSION,
        sourceCampaignBaseIdentitySha256: manifest.campaignBaseIdentity.identitySha256,
        exactAnchorGenomeSha256: V08_TEST_CANDIDATE_GENOME_SHA256,
        exactAnchorMutationFields,
        exactAnchorMutationPlanSha256,
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
        !isV08CampaignAdaptiveCatalogProvenanceCurrent(adaptive, {
            manifestFingerprint: manifest.fingerprint,
            campaignBaseIdentitySha256: manifest.campaignBaseIdentity.identitySha256,
        }) ||
        adaptive.schema !== SCHEMA ||
        adaptive.kind !== "adaptive-catalog" ||
        adaptive.researchOnly !== true ||
        adaptive.automaticBake !== false ||
        adaptive.automaticDeploy !== false ||
        adaptive.manifestFingerprint !== manifest.fingerprint ||
        adaptive.generatorVersion !== ADAPTIVE_GENERATOR_VERSION ||
        adaptive.exactAnchorGenomeSha256 !== V08_TEST_CANDIDATE_GENOME_SHA256 ||
        !Array.isArray(adaptive.exactAnchorMutationFields) ||
        adaptive.exactAnchorMutationFields.some((field) => typeof field !== "string" || !field) ||
        !/^[a-f0-9]{64}$/.test(adaptive.exactAnchorMutationPlanSha256) ||
        adaptive.screenEvidenceSha256 !== expectedEvidence ||
        adaptive.childTarget !== ADAPTIVE_CHILD_TARGET ||
        adaptive.children.length !== ADAPTIVE_CHILD_TARGET ||
        adaptive.parentCandidateIds.length !== ADAPTIVE_PARENT_COUNT ||
        adaptive.parentGenomeSha256.length !== ADAPTIVE_PARENT_COUNT ||
        adaptive.fingerprint !== fingerprintV08AlignedV1({ ...adaptive, fingerprint: undefined })
    ) {
        throw new Error("Adaptive catalog header, evidence, or fingerprint is invalid");
    }
    const expectedParents = selectV08CampaignAdaptiveParents(
        collectLeaderboard(manifest, checkpoint, null, {
            kinds: new Set<JobKind>(["screen"]),
            outputName: "base-screen-leaderboard.json",
        }),
    );
    if (
        fingerprintV08AlignedV1(expectedParents.map(({ candidateId }) => candidateId)) !==
            fingerprintV08AlignedV1(adaptive.parentCandidateIds) ||
        fingerprintV08AlignedV1(expectedParents.map(({ genomeSha256 }) => genomeSha256)) !==
            fingerprintV08AlignedV1(adaptive.parentGenomeSha256)
    ) {
        throw new Error("Adaptive catalog parents do not match the committed base-screen ranking");
    }
    const baseHashes = new Set(baseGenomes.map(fingerprintV08AlignedV1CandidateGenome));
    const expectedProposalParents: IV08CampaignAdaptiveProposalParent[] = expectedParents.map((row) => ({
        candidateId: row.candidateId,
        candidateIndex: row.candidateIndex,
        genomeSha256: row.genomeSha256,
        genome: baseGenomes[row.candidateIndex]!,
    }));
    const expectedSeen = new Set(baseHashes);
    const expectedChildren = expectedProposalParents.flatMap((parent) => {
        const proposals = selectV08CampaignAdaptiveChildProposals(
            parent,
            expectedProposalParents,
            [...expectedSeen],
            ADAPTIVE_CHILD_TARGET / ADAPTIVE_PARENT_COUNT,
        );
        for (const { genome } of proposals) expectedSeen.add(fingerprintV08AlignedV1CandidateGenome(genome));
        return proposals.map(({ genome, mutation }) => ({
            parentCandidateId: parent.candidateId,
            mutation,
            genomeSha256: fingerprintV08AlignedV1CandidateGenome(genome),
        }));
    });
    if (
        fingerprintV08AlignedV1(
            adaptive.children.map(({ parentCandidateId, mutation, genomeSha256 }) => ({
                parentCandidateId,
                mutation,
                genomeSha256,
            })),
        ) !== fingerprintV08AlignedV1(expectedChildren)
    ) {
        throw new Error("Adaptive catalog children do not match generator v4's deterministic mutation plan");
    }
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
    const exactAnchorChildren = adaptive.children.filter(
        ({ parentCandidateId }) => parentCandidateId === V08_CAMPAIGN_EXACT_ANCHOR_ID,
    );
    assertExactAnchorMutationCoverage(exactAnchorChildren.map(({ genome, mutation }) => ({ genome, mutation })));
    const exactAnchorMutationFields = exactAnchorChildren.map(({ mutation }) => mutation.field);
    const exactAnchorMutationPlanSha256 = fingerprintV08AlignedV1(
        exactAnchorChildren.map(({ id, mutation, genomeSha256 }) => ({ id, mutation, genomeSha256 })),
    );
    if (
        fingerprintV08AlignedV1(adaptive.exactAnchorMutationFields) !==
            fingerprintV08AlignedV1(exactAnchorMutationFields) ||
        adaptive.exactAnchorMutationPlanSha256 !== exactAnchorMutationPlanSha256
    ) {
        throw new Error("Adaptive catalog lost its persisted exact-anchor mutation identity");
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
                  ...armageddonEvidence(tournamentJsonl(directory)),
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

async function runJobQueue(
    manifest: IManifest,
    checkpoint: ICheckpoint,
    registry: CandidateRegistry,
    adaptive: IAdaptiveCatalog | null,
    specs: IJobSpec[],
    options: { admissionReserved?: boolean } = {},
): Promise<boolean> {
    if (
        manifest.config.lanes * manifest.config.workersPerJob !== manifest.config.maxWorkers ||
        manifest.config.maxWorkers > manifest.config.concurrency
    ) {
        throw new Error("Manifest scheduler worker budget is inconsistent");
    }
    for (const spec of specs) reconcileJobResult(manifest, checkpoint, registry, spec);
    const completedIds = new Set(checkpoint.completed.map(({ id }) => id));
    const pending = specs.filter(({ id }) => !completedIds.has(id));
    if (!pending.length) return true;
    const result = await runV08CampaignDynamicQueue({
        jobs: pending,
        lanes: manifest.config.lanes,
        workersPerJob: manifest.config.workersPerJob,
        maxWorkers: manifest.config.maxWorkers,
        deadlineAtMs: manifest.deadlineAtMs,
        shouldStop: () => stopRequested,
        canAdmit: options.admissionReserved
            ? undefined
            : (spec, nowMs) =>
                  canAdmitJobBatches({
                      batches: [[spec]],
                      completed: checkpoint.completed,
                      workersPerJob: manifest.config.workersPerJob,
                      nowMs,
                      deadlineAtMs: manifest.deadlineAtMs,
                  }),
        execute: (spec) => runJob(manifest, checkpoint, registry, adaptive, spec),
    });
    if (result.status === "admission-deferred") {
        const deferred = pending.find(({ id }) => id === result.deferredJobId);
        if (!deferred) throw new Error("Dynamic queue deferred an unknown job");
        const estimatedDurationMs = estimateJobDurationMs(
            deferred,
            checkpoint.completed,
            manifest.config.workersPerJob,
        );
        appendFileSync(
            join(manifest.output, "logs", "orchestrator.jsonl"),
            `${JSON.stringify({
                at: new Date().toISOString(),
                event: "admission-deferred",
                schedulerVersion: V08_CAMPAIGN_SCHEDULER_VERSION,
                jobIds: [deferred.id],
                estimatedDurationMs,
                safetyMarginMs: ADMISSION_SAFETY_MARGIN_MS,
                deadlineAtMs: manifest.deadlineAtMs,
            })}\n`,
        );
        console.log(`[defer] ${deferred.id} needs about ${Math.ceil(estimatedDurationMs / 1_000)}s`);
    }
    return result.status === "completed";
}

async function main(): Promise<void> {
    const cli = parseCli(process.argv.slice(2));
    const baseGenomes = buildV08CampaignBaseGenomes();
    const baseBindings = baseGenomes.map((genome) =>
        validateV08AlignedV1CandidateBinding(bindV08AlignedV1Candidate(genome)),
    );
    if (baseBindings.length !== BASE_CANDIDATE_COUNT) {
        throw new Error(`Expected exact ${BASE_CANDIDATE_COUNT}-candidate campaign base, got ${baseBindings.length}`);
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
            `scheduler v${manifest.scheduler.version} ${manifest.scheduler.discipline}, ` +
            `timing ${manifest.config.unboundedSearch ? "unbounded deterministic fitness" : "bound operational"}, ` +
            `catalog ${manifest.catalogIdentity.catalogSha256}`,
    );
    if (Date.now() >= manifest.deadlineAtMs) {
        console.log("Campaign wall deadline already reached; checkpoint left resumable.");
        return;
    }

    checkpoint.phase = "screen";
    saveCheckpoint(manifest, checkpoint);
    {
        const specs: IJobSpec[] = baseBindings.map((_binding, index) => {
            return {
                id: `screen-${candidateId(index)}`,
                kind: "screen" as const,
                candidateId: candidateId(index),
                candidateIndex: index,
                games: manifest.config.screenGames,
                baseSeed: manifest.config.screenSeed,
            };
        });
        const ok = await runJobQueue(manifest, checkpoint, registry, adaptive, specs);
        if (!ok) return;
    }

    adaptive = loadOrCreateAdaptiveCatalog(manifest, checkpoint, baseGenomes);
    registry = buildCandidateRegistry(manifest, baseBindings, adaptive);
    checkpoint.phase = "adaptive";
    saveCheckpoint(manifest, checkpoint);
    {
        const specs: IJobSpec[] = adaptive.children.map((child) => ({
            id: `adaptive-${child.id}`,
            kind: "adaptive" as const,
            candidateId: child.id,
            candidateIndex: child.index,
            games: manifest.adaptive.screenGames,
            baseSeed: manifest.adaptive.screenSeed,
        }));
        const ok = await runJobQueue(manifest, checkpoint, registry, adaptive, specs);
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
    // A zero count in a 256-game screen cannot establish the 0.1% target. Cover a fixed research-ranked reserve,
    // then let repeated fresh validation determine Armageddon safety without lucky-zero admission bias.
    const preLevel4ById = new Map(preLevel4.map((row) => [row.candidateId, row]));
    const level4Queue = selectV08CampaignLevel4CandidateIds(preLevel4, level4ReserveTarget).map((id) => {
        const row = preLevel4ById.get(id);
        if (!row) throw new Error(`Level-4 reserve candidate ${id} is missing from the leaderboard`);
        return row;
    });
    let leaderboard = collectLeaderboard(manifest, checkpoint, adaptive);
    checkpoint.phase = "level4";
    saveCheckpoint(manifest, checkpoint);
    const alreadyCovered = new Set(
        checkpoint.completed.filter((job) => job.kind === "level4").map((job) => job.candidateId),
    );
    {
        const specs: IJobSpec[] = level4Queue
            .filter((row) => !alreadyCovered.has(row.candidateId))
            .map((row) => ({
                id: `level4-${row.candidateId}`,
                kind: "level4" as const,
                candidateId: row.candidateId,
                candidateIndex: row.candidateIndex,
                pairsPerLane: manifest.config.level4PairsPerLane,
                baseSeed: manifest.config.level4Seed,
            }));
        const ok = await runJobQueue(manifest, checkpoint, registry, adaptive, specs);
        if (!ok) return;
    }
    const validationSelectionSource = collectLeaderboard(manifest, checkpoint, adaptive, {
        kinds: VALIDATION_SELECTION_SOURCE_KINDS,
        outputName: "validation-selection-source-leaderboard.json",
    });

    checkpoint.phase = "validation";
    saveCheckpoint(manifest, checkpoint);
    leaderboard = collectLeaderboard(manifest, checkpoint, adaptive);
    if (checkpoint.validationSelection === null) {
        checkpoint.validationSelection = buildValidationSelection(
            manifest,
            validationSelectionSource,
            manifest.config.topCandidates,
        );
        saveCheckpoint(manifest, checkpoint);
    } else {
        validateValidationSelection(checkpoint.validationSelection, manifest, validationSelectionSource);
    }
    const validationSelection = checkpoint.validationSelection;
    if (validationSelection === null) throw new Error("Validation selection was not persisted");
    while (Date.now() < manifest.deadlineAtMs && !stopRequested) {
        leaderboard = collectLeaderboard(manifest, checkpoint, adaptive);
        const rowsById = new Map(leaderboard.map((row) => [row.candidateId, row]));
        const top = validationSelection.candidateIds.map((id) => rowsById.get(id)).filter((row) => row !== undefined);
        if (top.length !== validationSelection.candidateIds.length) {
            throw new Error("Persisted validation shortlist does not match the candidate registry");
        }
        const round = checkpoint.validationRound;
        const roundSpecs: IJobSpec[] = top.map((row) => ({
            id: `validation-r${String(round).padStart(3, "0")}-${row.candidateId}`,
            kind: "validation" as const,
            candidateId: row.candidateId,
            candidateIndex: row.candidateIndex,
            games: manifest.config.validationGames,
            baseSeed: (manifest.config.validationSeed + round * 1_000_003) >>> 0,
        }));
        // Reconcile the whole round before admission so an interrupted result is not charged twice. The remaining
        // jobs form one reservation: never knowingly start a partial round without budget for every candidate.
        for (const spec of roundSpecs) reconcileJobResult(manifest, checkpoint, registry, spec);
        const completedIds = new Set(checkpoint.completed.map(({ id }) => id));
        const pending = roundSpecs.filter(({ id }) => !completedIds.has(id));
        if (
            pending.length > 0 &&
            Date.now() +
                estimateDynamicQueueDurationMs(
                    pending,
                    checkpoint.completed,
                    manifest.config.workersPerJob,
                    manifest.config.lanes,
                ) +
                ADMISSION_SAFETY_MARGIN_MS >
                manifest.deadlineAtMs
        ) {
            const estimatedDurationMs = estimateDynamicQueueDurationMs(
                pending,
                checkpoint.completed,
                manifest.config.workersPerJob,
                manifest.config.lanes,
            );
            appendFileSync(
                join(manifest.output, "logs", "orchestrator.jsonl"),
                `${JSON.stringify({
                    at: new Date().toISOString(),
                    event: "validation-round-admission-deferred",
                    schedulerVersion: V08_CAMPAIGN_SCHEDULER_VERSION,
                    round,
                    jobIds: pending.map(({ id }) => id),
                    estimatedDurationMs,
                    safetyMarginMs: ADMISSION_SAFETY_MARGIN_MS,
                    deadlineAtMs: manifest.deadlineAtMs,
                })}\n`,
            );
            console.log(`[defer] validation round ${round} needs about ${Math.ceil(estimatedDurationMs / 1_000)}s`);
            return;
        }
        const ok = await runJobQueue(manifest, checkpoint, registry, adaptive, roundSpecs, {
            admissionReserved: true,
        });
        if (!ok) return;
        // This atomic checkpoint advance is the evidence barrier. Until it succeeds, collectLeaderboard excludes
        // every result in this round, so completion skew, shutdown, or resume cannot favor one shortlisted arm.
        checkpoint.validationRound += 1;
        saveCheckpoint(manifest, checkpoint);
        collectLeaderboard(manifest, checkpoint, adaptive);
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
