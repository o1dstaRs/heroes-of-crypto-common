/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
    appendFileSync,
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmdirSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { V08_A13_GENOME, V08_A13_GENOME_SHA256, V08_A13_SEARCH } from "../ai/versions/v0_8_a13_profile";
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
    V07_ALIGNED_V2_LATE_RANGED_FINISH_WEIGHTS,
    V07_ALIGNED_V2_MELEE_RANGED_TARGET_WEIGHTS,
    V07_ALIGNED_V2_PURE_RANGED_TERMINAL_WEIGHTS,
} from "./optimizer/v0_7_aligned_96h_v2_protocol";
import {
    fingerprintV08PostA13CoveragePlan,
    V08_POST_A13_COVERAGE_LANES,
    V08_POST_A13_COVERAGE_SCHEMA,
    V08_POST_A13_COVERAGE_UNITS,
    V08_POST_A13_LIVE_MAPS,
} from "./v0_8_post_a13_coverage";
import {
    fingerprintV08AllUnitCoveragePlan,
    summarizeV08AllUnitCoverage,
    V08_ALL_UNIT_CATALOG,
    V08_ALL_UNIT_CATALOG_SHA256,
    V08_ALL_UNIT_COVERAGE_DEFAULT_PAIRS_PER_MAP,
    V08_ALL_UNIT_COVERAGE_LANES,
    V08_ALL_UNIT_COVERAGE_SCHEMA,
    V08_ALL_UNIT_EXPECTED_CATALOG_SHA256,
    V08_ALL_UNIT_LIVE_MAPS,
    type IV08AllUnitCoverageOptions,
    type IV08AllUnitCoverageRecord,
    type IV08AllUnitCoverageSummary,
} from "./v0_8_all_unit_coverage";
import {
    fingerprintV08PassiveTurnPanelPlan,
    summarizeV08PassiveTurnPanel,
    V08_PASSIVE_TURN_PANEL_SCHEMA,
    type IV08PassiveTurnPanelOptions,
    type IV08PassiveTurnPanelRecord,
    type IV08PassiveTurnPanelSummary,
} from "./v0_8_passive_turn_panel";
import {
    fingerprintV08BlockCenterActionPlan,
    summarizeV08BlockCenterActionPanel,
    V08_BLOCK_CENTER_ACTION_PANEL_SCHEMA,
    type IV08BlockCenterActionPanelOptions,
    type IV08BlockCenterActionRecord,
    type IV08BlockCenterActionSummary,
} from "./v0_8_block_center_action_panel";

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

export const V08_CAMPAIGN_SCHEMA = "hoc.v0_8_aggressive_campaign.v12" as const;
const SCHEMA = V08_CAMPAIGN_SCHEMA;
const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");
const TOURNAMENT_RUNNER = join(REPOSITORY_ROOT, "src/simulation/run_tournament.ts");
const LEVEL4_RUNNER = join(REPOSITORY_ROOT, "src/simulation/v0_8_l4_coverage.ts");
const POST_A13_COVERAGE_RUNNER = join(REPOSITORY_ROOT, "src/simulation/v0_8_post_a13_coverage.ts");
const ALL_UNIT_COVERAGE_RUNNER = join(REPOSITORY_ROOT, "src/simulation/v0_8_all_unit_coverage.ts");
const PASSIVE_TURN_QUALIFICATION_RUNNER = join(REPOSITORY_ROOT, "src/simulation/v0_8_passive_turn_panel.ts");
const BLOCK_CENTER_QUALIFICATION_RUNNER = join(REPOSITORY_ROOT, "src/simulation/v0_8_block_center_action_panel.ts");
export const V08_CAMPAIGN_POST_A13_COVERAGE_SCHEMA = V08_POST_A13_COVERAGE_SCHEMA;
export const V08_CAMPAIGN_POST_A13_COVERAGE_LANE_COUNT = 24 as const;
export const V08_CAMPAIGN_POST_A13_COVERAGE_LANES = V08_POST_A13_COVERAGE_LANES;
export const V08_CAMPAIGN_POST_A13_COVERAGE_UNITS = V08_POST_A13_COVERAGE_UNITS;
export const V08_CAMPAIGN_ALL_UNIT_COVERAGE_SCHEMA = V08_ALL_UNIT_COVERAGE_SCHEMA;
export const V08_CAMPAIGN_ALL_UNIT_COVERAGE_LANE_COUNT = V08_ALL_UNIT_COVERAGE_LANES.length;
export const V08_CAMPAIGN_ALL_UNIT_COVERAGE_DEFAULT_PAIRS_PER_MAP = V08_ALL_UNIT_COVERAGE_DEFAULT_PAIRS_PER_MAP;
export const V08_CAMPAIGN_ALL_UNIT_QUALIFICATION_DEFAULT_PAIRS_PER_MAP =
    V08_ALL_UNIT_COVERAGE_DEFAULT_PAIRS_PER_MAP * 2;
// The promotion shortlist gets a broad, all-creature qualification without consuming the campaign's final
// validation window. Standalone release evidence remains deeper: 4,096 passive games and 50,000 BLOCK_CENTER
// games with their panel-native defaults.
export const V08_CAMPAIGN_PASSIVE_QUALIFICATION_DEFAULT_GAMES = 1_024;
export const V08_CAMPAIGN_PASSIVE_QUALIFICATION_DEFAULT_MIN_CREATURE_APPEARANCES = 50;
export const V08_CAMPAIGN_BLOCK_CENTER_QUALIFICATION_DEFAULT_GAMES = 1_024;
/**
 * Intrinsic spell kits introduced after the A13 source boundary.
 *
 * The live-twin setup can grant unrelated spells to other stacks (for example, Wild Regeneration to Mermaid).
 * Those incidental grants are useful gameplay telemetry, but they must neither satisfy nor fail this kit census.
 */
export const V08_CAMPAIGN_POST_A13_SPELL_EXERCISE_KITS = Object.freeze({
    Blacksmith: Object.freeze(["Craft", "Armor Rune", "Weapon Rune"]),
    "Ash Moth": Object.freeze(["Smoke", "Misfortune", "Fireforged Sword"]),
    Trent: Object.freeze(["Vine Throw"]),
    "Battle Mage": Object.freeze(["Fire Strike", "Meteorite"]),
    Nightmare: Object.freeze(["Fire Wall"]),
    "Magic Dragon": Object.freeze(["Whirlpool", "Lightning Strike", "Ring of Fire", "Meteor Shower"]),
} as const);
const LIVE_MAPS = "normal,lava,block";
// At screen/validation sizes this effectively requires zero Armageddon-reached games; pooled long-run
// promotion evidence may tolerate at most one per thousand.
const ARMAGEDDON_RATE_GATE = 0.001;
const PRODUCTION_CANDIDATE_COUNT = 48;
const BASE_CANDIDATE_COUNT = 49;
export const V08_CAMPAIGN_EXACT_ANCHOR_INDEX = 48 as const;
export const V08_CAMPAIGN_EXACT_ANCHOR_ID = "c48" as const;
export const V08_CAMPAIGN_INACTIVE_CONTROL_IDS = ["c37", "c38"] as const;
export const V08_CAMPAIGN_VALIDATION_SELECTION_SOURCE_KINDS = [
    "screen",
    "adaptive",
    "level4",
    "post_a13_coverage",
    "all_unit_coverage",
    "all_unit_qualification",
] as const;
export const V08_CAMPAIGN_ADAPTIVE_GENERATOR_VERSION = 7;
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
export const V08_CAMPAIGN_SELECTION_VERSION = 3 as const;
export const V08_CAMPAIGN_PROMOTION_COMPARISON_VERSION = 2 as const;
export const V08_CAMPAIGN_CHILD_ENVIRONMENT_POLICY_VERSION = 1 as const;
export const V08_CAMPAIGN_CHILD_ENVIRONMENT_STRATEGY = "deny-by-default-exact-base-plus-candidate" as const;

export interface IV08CampaignChildEnvironmentPolicy {
    version: typeof V08_CAMPAIGN_CHILD_ENVIRONMENT_POLICY_VERSION;
    strategy: typeof V08_CAMPAIGN_CHILD_ENVIRONMENT_STRATEGY;
    inheritedKeys: readonly ["HOME"];
    baseEnvironment: Record<string, string>;
    baseEnvironmentSha256: string;
}

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
    coveragePairsPerLane: number;
    allUnitPairsPerMap: number;
    allUnitQualificationPairsPerMap: number;
    passiveQualificationGames: number;
    passiveQualificationMinCreatureAppearances: number;
    blockCenterQualificationGames: number;
    screenSeed: number;
    level4Seed: number;
    coverageSeed: number;
    allUnitSeed: number;
    allUnitQualificationSeed: number;
    passiveQualificationSeed: number;
    blockCenterQualificationSeed: number;
    validationSeed: number;
    unboundedSearch: boolean;
}

export interface IV08CampaignSourceIdentity {
    branch: "main";
    gitHead: string;
    gitTree: string;
    originMain: string;
    clean: true;
    bunVersion: string;
    identitySha256: string;
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
    sourceIdentity: IV08CampaignSourceIdentity;
    childEnvironmentPolicy: IV08CampaignChildEnvironmentPolicy;
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
        evidence: "fully-committed-validation-plus-decision-quality-qualification";
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

export type JobKind =
    | "screen"
    | "adaptive"
    | "level4"
    | "post_a13_coverage"
    | "all_unit_coverage"
    | "all_unit_qualification"
    | "passive_qualification"
    | "block_center_qualification"
    | "validation";
const JOB_KINDS: ReadonlySet<JobKind> = new Set([
    "screen",
    "adaptive",
    "level4",
    "post_a13_coverage",
    "all_unit_coverage",
    "all_unit_qualification",
    "passive_qualification",
    "block_center_qualification",
    "validation",
]);
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
    Object.freeze({ field: "controls.meleeRangedTargetWeight", to: 0 as const }),
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
    exactAnchorGenomeSha256: typeof V08_A13_GENOME_SHA256;
    exactAnchorMutationFields: string[];
    exactAnchorMutationPlanSha256: string;
    parentEvidenceSha256: string;
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
    parentEvidenceSha256: string;
    children: number;
}

interface IValidationSelection {
    schema: "hoc.v0_8_aggressive_validation_selection.v3";
    version: typeof V08_CAMPAIGN_SELECTION_VERSION;
    manifestFingerprint: string;
    sourceEvidenceSha256: string;
    exactAnchorCandidateId: typeof V08_CAMPAIGN_EXACT_ANCHOR_ID;
    exactAnchorGenomeSha256: typeof V08_A13_GENOME_SHA256;
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
    pairsPerMap?: number;
    baseSeed: number;
    genomeSha256: string;
    bindingSha256: string;
    summaryPath: string;
    summarySha256: string;
    sourceSummarySha256: string;
    recordsPath: string;
    recordsSha256: string;
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
    | "summarySha256"
    | "sourceSummarySha256"
    | "recordsPath"
    | "recordsSha256"
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

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ESRCH") return false;
        if (code === "EPERM") return true;
        throw error;
    }
}

export function assertV08CampaignResumeHasNoLiveJobs(
    activeJobs: Readonly<Record<string, { pid: number | null }>>,
    processIsAlive: (pid: number) => boolean = isProcessAlive,
): void {
    const uncertain: string[] = [];
    const live: string[] = [];
    for (const [id, { pid }] of Object.entries(activeJobs)) {
        if (pid === null) {
            uncertain.push(id);
        } else if (processIsAlive(pid)) {
            live.push(`${id} (pid ${pid})`);
        }
    }
    if (uncertain.length || live.length) {
        const details = [
            live.length ? `still running: ${live.join(", ")}` : null,
            uncertain.length ? `spawn state is unknown: ${uncertain.join(", ")}` : null,
        ].filter((detail): detail is string => detail !== null);
        throw new Error(
            `Cannot safely resume while prior active jobs may still write campaign artifacts (${details.join("; ")})`,
        );
    }
}

interface ICheckpoint {
    schema: typeof SCHEMA;
    kind: "checkpoint";
    manifestFingerprint: string;
    phase:
        | "screen"
        | "adaptive"
        | "level4"
        | "post_a13_coverage"
        | "all_unit_coverage"
        | "all_unit_qualification"
        | "decision_quality_qualification"
        | "validation"
        | "complete";
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

export interface IV08CampaignPostA13UnitOutcome {
    unit: string;
    games: number;
    candidateWins: number;
    opponentWins: number;
    draws: number;
    candidateWinRate: number;
    decisiveWinRate: number;
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
    tournamentGames: number;
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
    postA13CoverageGames: number;
    postA13CandidateWins: number;
    postA13OpponentWins: number;
    postA13Draws: number;
    postA13CandidateWinRate: number;
    postA13DecisiveWinRate: number;
    postA13CoverageEvidenceSha256: string | null;
    postA13ArmageddonReached: number;
    postA13ArmageddonDecided: number;
    postA13ArmageddonRate: number;
    hasPostA13CoverageEvidence: boolean;
    postA13CoveragePassed: boolean;
    postA13SpellExercisePassed: boolean;
    allUnitCoverageGames: number;
    hasAllUnitCoverageEvidence: boolean;
    allUnitCoveragePassed: boolean;
    allUnitCoverageEvidenceSha256: string | null;
    allUnitCoverageSummaryPaths: string[];
    allUnitQualificationGames: number;
    hasAllUnitQualificationEvidence: boolean;
    allUnitQualificationPassed: boolean;
    allUnitQualificationEvidenceSha256: string | null;
    allUnitQualificationSummaryPaths: string[];
    passiveQualificationGames: number;
    hasPassiveQualificationEvidence: boolean;
    passiveQualificationPassed: boolean;
    passiveQualificationEvidenceSha256: string | null;
    passiveQualificationSummaryPaths: string[];
    blockCenterQualificationGames: number;
    hasBlockCenterQualificationEvidence: boolean;
    blockCenterQualificationPassed: boolean;
    blockCenterQualificationEvidenceSha256: string | null;
    blockCenterQualificationSummaryPaths: string[];
    passesPostA13StrengthGate: boolean;
    postA13UnitOutcomes: IV08CampaignPostA13UnitOutcome[];
    passesArmageddonGate: boolean;
    passesStrengthGate: boolean;
    promotionEligible: boolean;
    level4SummaryPaths: string[];
    postA13CoverageSummaryPaths: string[];
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

const nonnegativeInteger = (raw: string | undefined, fallback: number, name: string): number => {
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative integer`);
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
    pairsPerMap?: number;
    durationMs: number;
}

type JobWork = Pick<IJobSpec, "kind" | "games" | "pairsPerLane" | "pairsPerMap">;

/** Convert every runner shape to actual simulated games so duration samples are comparable. */
export function jobWorkUnits(job: JobWork): number {
    if (job.kind === "level4") {
        if (
            !Number.isSafeInteger(job.pairsPerLane) ||
            (job.pairsPerLane ?? 0) < 1 ||
            job.games !== undefined ||
            job.pairsPerMap !== undefined
        ) {
            throw new Error("A level-4 job must specify only a positive pairsPerLane count");
        }
        return job.pairsPerLane! * 16;
    }
    if (job.kind === "post_a13_coverage") {
        if (
            !Number.isSafeInteger(job.pairsPerLane) ||
            (job.pairsPerLane ?? 0) < 1 ||
            job.games !== undefined ||
            job.pairsPerMap !== undefined
        ) {
            throw new Error("A post-A13 coverage job must specify only a positive pairsPerLane count");
        }
        return job.pairsPerLane! * V08_CAMPAIGN_POST_A13_COVERAGE_LANE_COUNT * 2;
    }
    if (job.kind === "all_unit_coverage" || job.kind === "all_unit_qualification") {
        if (
            !Number.isSafeInteger(job.pairsPerMap) ||
            (job.pairsPerMap ?? 0) < 1 ||
            job.games !== undefined ||
            job.pairsPerLane !== undefined
        ) {
            throw new Error("An all-unit job must specify only a positive pairsPerMap count");
        }
        return job.pairsPerMap! * V08_CAMPAIGN_ALL_UNIT_COVERAGE_LANE_COUNT * V08_ALL_UNIT_LIVE_MAPS.length * 2;
    }
    if (
        !Number.isSafeInteger(job.games) ||
        (job.games ?? 0) < 1 ||
        job.pairsPerLane !== undefined ||
        job.pairsPerMap !== undefined
    ) {
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
    const durationFamily = (jobKind: JobKind): string =>
        jobKind === "all_unit_coverage" || jobKind === "all_unit_qualification" ? "all_unit" : jobKind;
    const rates = completed
        .filter(
            (job) =>
                durationFamily(job.kind) === durationFamily(kind) &&
                Number.isFinite(job.durationMs) &&
                job.durationMs >= 0,
        )
        .map((job) => job.durationMs / jobWorkUnits(job));
    if (!rates.length) return fallback;
    if (durationFamily(kind) === "all_unit" && rates.length >= ADMISSION_MIN_DURATION_SAMPLES) {
        // The deterministic all-unit runner produces thousands of homogeneous games per sample. Once three
        // same-family jobs have completed, their p95 is substantially stronger evidence than the generic
        // cold-start floor; retaining that floor would reserve roughly nine hours for a fast deep panel and
        // incorrectly defer it near the end of a bounded campaign.
        return Math.max(1, percentile95(rates));
    }
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

export function parseV08CampaignCli(argv: readonly string[]): ICli {
    if (argv.includes("--help") || argv.includes("-h")) {
        console.log(
            "Usage: bun src/simulation/v0_8_aggressive_12h.ts [--output DIR] [--hours 12] " +
                "[--concurrency TOTAL_WORKERS] [--screen-games 256] [--validation-games 1024] " +
                `[--lanes ${V08_CAMPAIGN_DEFAULT_LANES}] [--top ${V08_CAMPAIGN_DEFAULT_TOP_CANDIDATES}] ` +
                `[--l4-pairs 16] [--coverage-pairs 3] [--all-unit-pairs ${V08_CAMPAIGN_ALL_UNIT_COVERAGE_DEFAULT_PAIRS_PER_MAP}] ` +
                `[--all-unit-qualification-pairs ${V08_CAMPAIGN_ALL_UNIT_QUALIFICATION_DEFAULT_PAIRS_PER_MAP}] ` +
                `[--passive-qualification-games ${V08_CAMPAIGN_PASSIVE_QUALIFICATION_DEFAULT_GAMES}] ` +
                `[--passive-min-appearances ${V08_CAMPAIGN_PASSIVE_QUALIFICATION_DEFAULT_MIN_CREATURE_APPEARANCES}] ` +
                `[--block-center-qualification-games ${V08_CAMPAIGN_BLOCK_CENTER_QUALIFICATION_DEFAULT_GAMES}] ` +
                "[--screen-seed N] [--level4-seed N] [--coverage-seed N] " +
                "[--all-unit-seed N] [--all-unit-qualification-seed N] " +
                "[--passive-qualification-seed N] [--block-center-qualification-seed N] " +
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
    const passiveQualificationGames = positiveInteger(
        flagValue(argv, "--passive-qualification-games"),
        V08_CAMPAIGN_PASSIVE_QUALIFICATION_DEFAULT_GAMES,
        "--passive-qualification-games",
    );
    const blockCenterQualificationGames = positiveInteger(
        flagValue(argv, "--block-center-qualification-games"),
        V08_CAMPAIGN_BLOCK_CENTER_QUALIFICATION_DEFAULT_GAMES,
        "--block-center-qualification-games",
    );
    if (screenGames % 2 || validationGames % 2 || passiveQualificationGames % 2 || blockCenterQualificationGames % 2) {
        throw new Error("Tournament and qualification game counts must be even for seat pairs");
    }
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
        coveragePairsPerLane: positiveInteger(flagValue(argv, "--coverage-pairs"), 3, "--coverage-pairs"),
        allUnitPairsPerMap: positiveInteger(
            flagValue(argv, "--all-unit-pairs"),
            V08_CAMPAIGN_ALL_UNIT_COVERAGE_DEFAULT_PAIRS_PER_MAP,
            "--all-unit-pairs",
        ),
        allUnitQualificationPairsPerMap: positiveInteger(
            flagValue(argv, "--all-unit-qualification-pairs"),
            V08_CAMPAIGN_ALL_UNIT_QUALIFICATION_DEFAULT_PAIRS_PER_MAP,
            "--all-unit-qualification-pairs",
        ),
        passiveQualificationGames,
        passiveQualificationMinCreatureAppearances: nonnegativeInteger(
            flagValue(argv, "--passive-min-appearances"),
            V08_CAMPAIGN_PASSIVE_QUALIFICATION_DEFAULT_MIN_CREATURE_APPEARANCES,
            "--passive-min-appearances",
        ),
        blockCenterQualificationGames,
        screenSeed: uint32Integer(flagValue(argv, "--screen-seed"), ADAPTIVE_SCREEN_SEED, "--screen-seed"),
        level4Seed: uint32Integer(flagValue(argv, "--level4-seed"), 30_260_719, "--level4-seed"),
        coverageSeed: uint32Integer(flagValue(argv, "--coverage-seed"), 35_260_719, "--coverage-seed"),
        // These deterministic coverage seeds retain the broad random roster panel while guaranteeing at least
        // one naturally legal, conservative Harpy Castling turn under the exact c48 environment. That makes the
        // 14/14 remaining-native-caster gate executable instead of silently exempting a conditional spell.
        allUnitSeed: uint32Integer(flagValue(argv, "--all-unit-seed"), 37_260_731, "--all-unit-seed"),
        allUnitQualificationSeed: uint32Integer(
            flagValue(argv, "--all-unit-qualification-seed"),
            38_260_724,
            "--all-unit-qualification-seed",
        ),
        passiveQualificationSeed: uint32Integer(
            flagValue(argv, "--passive-qualification-seed"),
            39_260_719,
            "--passive-qualification-seed",
        ),
        blockCenterQualificationSeed: uint32Integer(
            flagValue(argv, "--block-center-qualification-seed"),
            39_760_719,
            "--block-center-qualification-seed",
        ),
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

function readJsonl<T>(path: string): T[] {
    return readFileSync(path, "utf8")
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as T);
}

const OUTPUT_LEASE_SCHEMA = "hoc.v0_8_aggressive_output_lease.v1" as const;

export interface IV08CampaignOutputLeaseOwner {
    schema: typeof OUTPUT_LEASE_SCHEMA;
    pid: number;
    leaseId: string;
    acquiredAt: string;
}

export interface IV08CampaignOutputLease {
    lockDirectory: string;
    owner: IV08CampaignOutputLeaseOwner;
    release(): void;
}

function readOutputLeaseOwner(ownerPath: string): IV08CampaignOutputLeaseOwner {
    if (!existsSync(ownerPath)) {
        throw new Error(`Campaign output lock has no owner record: ${ownerPath}`);
    }
    const owner = readJson<Partial<IV08CampaignOutputLeaseOwner>>(ownerPath);
    if (
        owner.schema !== OUTPUT_LEASE_SCHEMA ||
        !Number.isSafeInteger(owner.pid) ||
        (owner.pid ?? 0) < 1 ||
        typeof owner.leaseId !== "string" ||
        !/^[a-f0-9-]{16,}$/i.test(owner.leaseId) ||
        typeof owner.acquiredAt !== "string" ||
        !Number.isFinite(Date.parse(owner.acquiredAt))
    ) {
        throw new Error(`Campaign output lock has an invalid owner record: ${ownerPath}`);
    }
    return owner as IV08CampaignOutputLeaseOwner;
}

/**
 * Acquire one host-wide writer lease before reading the manifest/checkpoint.
 *
 * mkdir is the atomic exclusion point. A dead owner's directory is atomically renamed out of the way before a
 * retry; a live or ownerless lock fails closed. The lease stays present until the orchestrator's main promise
 * settles, preventing two in-memory checkpoints from launching the same job into shared artifact paths.
 */
export function acquireV08CampaignOutputLease(
    output: string,
    processIsAlive: (pid: number) => boolean = isProcessAlive,
): IV08CampaignOutputLease {
    mkdirSync(output, { recursive: true });
    const lockDirectory = join(resolve(output), ".v08-aggressive-orchestrator.lock");
    const ownerPath = join(lockDirectory, "owner.json");
    for (;;) {
        try {
            mkdirSync(lockDirectory);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            const existing = readOutputLeaseOwner(ownerPath);
            if (processIsAlive(existing.pid)) {
                throw new Error(
                    `Campaign output is already leased by pid ${existing.pid} since ${existing.acquiredAt}: ${lockDirectory}`,
                );
            }
            const staleDirectory = `${lockDirectory}.stale.${process.pid}.${randomUUID()}`;
            try {
                renameSync(lockDirectory, staleDirectory);
            } catch (renameError) {
                if ((renameError as NodeJS.ErrnoException).code === "ENOENT") continue;
                throw renameError;
            }
            const staleEntries = readdirSync(staleDirectory);
            if (staleEntries.length !== 1 || staleEntries[0] !== "owner.json") {
                throw new Error(`Refusing to remove non-canonical stale campaign lock: ${staleDirectory}`);
            }
            unlinkSync(join(staleDirectory, "owner.json"));
            rmdirSync(staleDirectory);
            continue;
        }

        const owner: IV08CampaignOutputLeaseOwner = {
            schema: OUTPUT_LEASE_SCHEMA,
            pid: process.pid,
            leaseId: randomUUID(),
            acquiredAt: new Date().toISOString(),
        };
        try {
            writeFileSync(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, { flag: "wx" });
        } catch (error) {
            rmdirSync(lockDirectory);
            throw error;
        }
        let released = false;
        return {
            lockDirectory,
            owner,
            release: () => {
                if (released) return;
                const persisted = readOutputLeaseOwner(ownerPath);
                if (persisted.pid !== owner.pid || persisted.leaseId !== owner.leaseId) {
                    throw new Error(`Campaign output lease ownership changed unexpectedly: ${lockDirectory}`);
                }
                unlinkSync(ownerPath);
                rmdirSync(lockDirectory);
                released = true;
            },
        };
    }
}

function candidateId(index: number): string {
    return `c${String(index).padStart(2, "0")}`;
}

/** The pinned production-48 catalog plus the exact currently shipped A13 genome as c48. */
export function buildV08CampaignBaseGenomes(): IV08AlignedV1CandidateGenome[] {
    const production = buildV08AlignedV1ProductionCandidateCatalog();
    if (production.length !== PRODUCTION_CANDIDATE_COUNT) {
        throw new Error(`Expected exact ${PRODUCTION_CANDIDATE_COUNT}-candidate production catalog`);
    }
    const exactAnchor = normalizeV08AlignedV1CandidateGenome(
        structuredClone(V08_A13_GENOME) as unknown as IV08AlignedV1CandidateGenome,
    );
    const exactAnchorHash = fingerprintV08AlignedV1CandidateGenome(exactAnchor);
    const productionHashes = production.map(fingerprintV08AlignedV1CandidateGenome);
    if (exactAnchorHash !== V08_A13_GENOME_SHA256 || productionHashes.includes(exactAnchorHash)) {
        throw new Error("Exact v0.8 A13 anchor identity drifted or duplicates the production catalog");
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
        // This is the campaign-wide operational timing policy, not a genome gene. Keeping it constant makes
        // base candidates, adaptive children, and the exact production anchor comparable under contention.
        SEARCH_WAIT_DEADLINE_POLICY: V08_A13_SEARCH.waitDeadlinePolicy,
    };
    if (unboundedSearch) {
        // Fitness must be reproducible across hosts. Wall-clock fallbacks are validated later as an operational
        // envelope; they must not silently turn CPU contention into a different policy during model selection.
        environment.SEARCH_DECISION_DEADLINE_MS = "";
        environment.SEARCH_CIRCUIT_BREAKER_MS = "";
    }
    return environment;
}

/**
 * Build the only ambient environment admitted to campaign children.
 *
 * HOME is retained because Bun and operating-system facilities may use it for runtime lookup. Every other
 * value is fixed from campaign/runtime identity. In particular, roster, cohort, simulation, AI, Node, Bun,
 * and experiment variables from the launching shell are denied by construction instead of being maintained
 * in an inevitably incomplete blocklist.
 */
export function buildV08CampaignChildEnvironmentPolicy(
    sourceEnvironment: NodeJS.ProcessEnv = process.env,
    bunPath = process.execPath,
): IV08CampaignChildEnvironmentPolicy {
    const home = sourceEnvironment.HOME;
    if (!home) throw new Error("Campaign child environment requires HOME");
    const baseEnvironment = {
        HOME: home,
        PATH: `${dirname(bunPath)}:/usr/bin:/bin`,
        TMPDIR: "/tmp",
        LANG: "C",
        LC_ALL: "C",
        TZ: "UTC",
    };
    return {
        version: V08_CAMPAIGN_CHILD_ENVIRONMENT_POLICY_VERSION,
        strategy: V08_CAMPAIGN_CHILD_ENVIRONMENT_STRATEGY,
        inheritedKeys: ["HOME"],
        baseEnvironment,
        baseEnvironmentSha256: fingerprintV08AlignedV1(baseEnvironment),
    };
}

/** Validate a persisted policy without consulting ambient process state. */
export function isV08CampaignChildEnvironmentPolicyValid(value: unknown): value is IV08CampaignChildEnvironmentPolicy {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const policy = value as Partial<IV08CampaignChildEnvironmentPolicy>;
    const base = policy?.baseEnvironment;
    return (
        policy.version === V08_CAMPAIGN_CHILD_ENVIRONMENT_POLICY_VERSION &&
        policy.strategy === V08_CAMPAIGN_CHILD_ENVIRONMENT_STRATEGY &&
        Array.isArray(policy.inheritedKeys) &&
        policy.inheritedKeys.length === 1 &&
        policy.inheritedKeys[0] === "HOME" &&
        !!base &&
        typeof base === "object" &&
        !Array.isArray(base) &&
        Object.keys(base).sort().join(",") === "HOME,LANG,LC_ALL,PATH,TMPDIR,TZ" &&
        Object.values(base).every((entry) => typeof entry === "string" && entry.length > 0) &&
        typeof policy.baseEnvironmentSha256 === "string" &&
        policy.baseEnvironmentSha256 === fingerprintV08AlignedV1(base)
    );
}

export function buildV08CampaignChildEnvironment(
    policy: IV08CampaignChildEnvironmentPolicy,
    binding: IV08AlignedV1CandidateBinding,
    auditPath: string,
    unboundedSearch: boolean,
): NodeJS.ProcessEnv {
    if (!isV08CampaignChildEnvironmentPolicyValid(policy)) {
        throw new Error("Campaign child environment policy is invalid");
    }
    const environment: NodeJS.ProcessEnv = { ...policy.baseEnvironment };
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

function latestJobRecords(directory: string, kind: JobKind): string {
    const prefix =
        kind === "level4"
            ? "v08_l4_v0.8s_vs_v0.7_"
            : kind === "post_a13_coverage"
              ? "v08_post_a13_v0.8s_vs_v0.7_"
              : kind === "all_unit_coverage" || kind === "all_unit_qualification"
                ? "v08_all_unit_v0.8s_vs_v0.7_"
                : kind === "passive_qualification"
                  ? "v08_passive_v0.8s_vs_v0.7_"
                  : kind === "block_center_qualification"
                    ? "v08_block_center_v0.8s_vs_v0.7_"
                    : "v0.8s_vs_v0.7_";
    const files = readdirSync(directory)
        .filter((name) => name.startsWith(prefix) && name.endsWith(".jsonl"))
        .map((name) => join(directory, name))
        .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
    if (!files[0]) throw new Error(`Runner produced no ${kind} records JSONL in ${directory}`);
    return files[0];
}

interface IArtifactHashCacheEntry {
    size: number;
    mtimeMs: number;
    ctimeMs: number;
    ino: number;
    sha256: string;
}

const artifactHashCache = new Map<string, IArtifactHashCacheEntry>();

function artifactSha256(path: string): string {
    const stat = statSync(path);
    const cached = artifactHashCache.get(path);
    if (
        cached &&
        cached.size === stat.size &&
        cached.mtimeMs === stat.mtimeMs &&
        cached.ctimeMs === stat.ctimeMs &&
        cached.ino === stat.ino
    ) {
        return cached.sha256;
    }
    const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
    artifactHashCache.set(path, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        ino: stat.ino,
        sha256,
    });
    return sha256;
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

/** Select the exact unique child mutations used by generator v7, including c48's reserved finish coverage. */
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
        (parent.candidateIndex !== V08_CAMPAIGN_EXACT_ANCHOR_INDEX || parent.genomeSha256 !== V08_A13_GENOME_SHA256)
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

export function selectV08CampaignAdaptiveParents<
    T extends IV08CampaignResearchCandidate &
        Pick<IRankedCandidate, "postA13CoveragePassed" | "postA13SpellExercisePassed" | "allUnitCoveragePassed">,
>(rows: readonly T[]): T[] {
    const exactAnchor = rows.find(({ candidateId }) => candidateId === V08_CAMPAIGN_EXACT_ANCHOR_ID);
    if (!exactAnchor) throw new Error("Adaptive generation requires the exact c48 anchor");
    if (!exactAnchor.postA13CoveragePassed) {
        throw new Error("Exact c48 anchor must pass post-A13 behavior coverage before adaptive generation");
    }
    if (!exactAnchor.postA13SpellExercisePassed) {
        throw new Error("Exact c48 anchor must exercise every intrinsic post-A13 spell kit before adaptive generation");
    }
    if (!exactAnchor.allUnitCoveragePassed) {
        throw new Error("Exact c48 anchor must pass exact all-unit coverage before adaptive generation");
    }
    const eligible = rows.filter(isV08CampaignPostA13SelectionEligible);
    const leaders = rankV08CampaignResearchCandidates(
        eligible.filter(({ candidateId }) => candidateId !== V08_CAMPAIGN_EXACT_ANCHOR_ID),
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

export function isV08CampaignPostA13SelectionEligible(row: {
    candidateId: string;
    postA13CoveragePassed: boolean;
    postA13SpellExercisePassed: boolean;
    allUnitCoveragePassed: boolean;
}): boolean {
    return (
        row.postA13CoveragePassed &&
        row.allUnitCoveragePassed &&
        (V08_CAMPAIGN_INACTIVE_CONTROL_IDS.some((id) => id === row.candidateId) || row.postA13SpellExercisePassed)
    );
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
    T extends IV08CampaignResearchCandidate &
        Pick<
            IRankedCandidate,
            | "armageddonRate"
            | "decisiveWinRate"
            | "postA13CoveragePassed"
            | "postA13SpellExercisePassed"
            | "allUnitCoveragePassed"
        >,
>(rows: readonly T[], count: number): string[] {
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("level-4 reserve count must be positive");
    const eligible = rows.filter(isV08CampaignPostA13SelectionEligible);
    const targetCount = Math.min(eligible.length, Math.max(3, count));
    const anchor = eligible.find(({ candidateId }) => candidateId === V08_CAMPAIGN_EXACT_ANCHOR_ID);
    if (!anchor) throw new Error("Level-4 reserve requires the exact c48 anchor");
    const inactiveControl = selectV08CampaignInactiveControl(eligible);
    const alternateInactiveControl = eligible.find(
        ({ candidateId }) =>
            V08_CAMPAIGN_INACTIVE_CONTROL_IDS.some((id) => id === candidateId) &&
            candidateId !== inactiveControl.candidateId,
    );
    if (!alternateInactiveControl) {
        throw new Error("Level-4 reserve requires both inactive-challenger controls c37/c38");
    }
    const selected: T[] = [];
    const seen = new Set<string>();
    const add = (row: T): void => {
        if (selected.length >= targetCount || seen.has(row.candidateId)) return;
        selected.push(row);
        seen.add(row.candidateId);
    };
    add(anchor);
    add(inactiveControl);
    add(alternateInactiveControl);

    const remainingSlots = Math.max(0, targetCount - selected.length);
    const strengthSlots = Math.ceil(remainingSlots / 2);
    const strength = rankV08CampaignResearchCandidates(eligible);
    for (const row of strength) {
        if (selected.length >= 3 + strengthSlots) break;
        add(row);
    }
    const armReserve = eligible
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
        Pick<
            IRankedCandidate,
            | "armageddonRate"
            | "decisiveWinRate"
            | "hasLevel4Evidence"
            | "level4CoveragePassed"
            | "hasPostA13CoverageEvidence"
            | "postA13CoveragePassed"
            | "postA13SpellExercisePassed"
            | "hasAllUnitCoverageEvidence"
            | "allUnitCoveragePassed"
            | "hasAllUnitQualificationEvidence"
            | "allUnitQualificationPassed"
        >)[],
    count: number,
): string[] {
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("validation candidate count must be positive");
    const targetCount = Math.max(2, count);
    const covered = rows.filter(
        (row) =>
            row.hasLevel4Evidence &&
            row.level4CoveragePassed &&
            row.hasPostA13CoverageEvidence &&
            row.postA13CoveragePassed &&
            row.hasAllUnitCoverageEvidence &&
            row.allUnitCoveragePassed &&
            row.hasAllUnitQualificationEvidence &&
            row.allUnitQualificationPassed &&
            (V08_CAMPAIGN_INACTIVE_CONTROL_IDS.some((id) => id === row.candidateId) || row.postA13SpellExercisePassed),
    );
    const anchor = rows.find(({ candidateId }) => candidateId === V08_CAMPAIGN_EXACT_ANCHOR_ID);
    if (!anchor?.hasLevel4Evidence || !anchor.level4CoveragePassed) {
        throw new Error("Exact c48 anchor must pass its level-4 job before validation");
    }
    if (!anchor.hasPostA13CoverageEvidence || !anchor.postA13CoveragePassed) {
        throw new Error("Exact c48 anchor must pass its post-A13 coverage job before validation");
    }
    if (!anchor.postA13SpellExercisePassed) {
        throw new Error("Exact c48 anchor must exercise every candidate-owned post-A13 spell kit");
    }
    if (!anchor.hasAllUnitCoverageEvidence || !anchor.allUnitCoveragePassed) {
        throw new Error("Exact c48 anchor must pass its exact all-unit coverage job before validation");
    }
    if (!anchor.hasAllUnitQualificationEvidence || !anchor.allUnitQualificationPassed) {
        throw new Error("Exact c48 anchor must pass its deep all-unit qualification job before validation");
    }
    selectV08CampaignInactiveControl(rows);
    const qualifiedInactiveControls = rankV08CampaignResearchCandidates(
        covered.filter(({ candidateId }) => V08_CAMPAIGN_INACTIVE_CONTROL_IDS.some((id) => id === candidateId)),
    );
    const inactiveControl = qualifiedInactiveControls[0];
    if (!inactiveControl) {
        throw new Error("At least one inactive-challenger control must pass level-4 and all-unit qualification");
    }
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

export interface IV08CampaignPostA13StrengthEvidence {
    postA13CoverageGames: number;
    postA13CandidateWinRate: number;
    postA13DecisiveWinRate: number;
    postA13CoverageEvidenceSha256: string | null;
    postA13ArmageddonRate: number;
}

export interface IV08CampaignPromotionEvidence
    extends IV08CampaignValidationStrengthEvidence, IV08CampaignPostA13StrengthEvidence {
    isExactAnchor: boolean;
    unboundedSearch: boolean;
    hasValidationEvidence: boolean;
    level4CoveragePassed: boolean;
    postA13CoveragePassed: boolean;
    postA13SpellExercisePassed: boolean;
    hasAllUnitCoverageEvidence: boolean;
    allUnitCoveragePassed: boolean;
    hasAllUnitQualificationEvidence: boolean;
    allUnitQualificationPassed: boolean;
    hasPassiveQualificationEvidence: boolean;
    passiveQualificationPassed: boolean;
    hasBlockCenterQualificationEvidence: boolean;
    blockCenterQualificationPassed: boolean;
    armageddonRate: number;
    level4ArmageddonRate: number;
}

/** Common-random post-A13 evidence must not regress against the exact shipped A13 anchor. */
export function isV08CampaignPostA13StrengthQualified(
    candidate: IV08CampaignPostA13StrengthEvidence,
    exactAnchor: IV08CampaignPostA13StrengthEvidence,
): boolean {
    for (const evidence of [candidate, exactAnchor]) {
        if (
            !Number.isSafeInteger(evidence.postA13CoverageGames) ||
            evidence.postA13CoverageGames < 0 ||
            !Number.isFinite(evidence.postA13CandidateWinRate) ||
            evidence.postA13CandidateWinRate < 0 ||
            evidence.postA13CandidateWinRate > 1 ||
            !Number.isFinite(evidence.postA13DecisiveWinRate) ||
            evidence.postA13DecisiveWinRate < 0 ||
            evidence.postA13DecisiveWinRate > 1 ||
            !Number.isFinite(evidence.postA13ArmageddonRate) ||
            evidence.postA13ArmageddonRate < 0 ||
            evidence.postA13ArmageddonRate > 1 ||
            (evidence.postA13CoverageEvidenceSha256 !== null &&
                !/^[a-f0-9]{64}$/.test(evidence.postA13CoverageEvidenceSha256))
        ) {
            throw new Error("Invalid v0.8 campaign post-A13 strength evidence");
        }
    }
    return (
        candidate.postA13CoverageGames > 0 &&
        candidate.postA13CoverageGames === exactAnchor.postA13CoverageGames &&
        candidate.postA13CoverageEvidenceSha256 !== null &&
        candidate.postA13CoverageEvidenceSha256 === exactAnchor.postA13CoverageEvidenceSha256 &&
        candidate.postA13CandidateWinRate >= exactAnchor.postA13CandidateWinRate &&
        candidate.postA13DecisiveWinRate >= exactAnchor.postA13DecisiveWinRate &&
        candidate.postA13ArmageddonRate <= exactAnchor.postA13ArmageddonRate
    );
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
    exactAnchor: IV08CampaignValidationStrengthEvidence & IV08CampaignPostA13StrengthEvidence,
): boolean {
    return (
        !evidence.isExactAnchor &&
        !evidence.unboundedSearch &&
        evidence.hasValidationEvidence &&
        evidence.level4CoveragePassed &&
        evidence.postA13CoveragePassed &&
        evidence.postA13SpellExercisePassed &&
        evidence.hasAllUnitCoverageEvidence &&
        evidence.allUnitCoveragePassed &&
        evidence.hasAllUnitQualificationEvidence &&
        evidence.allUnitQualificationPassed &&
        evidence.hasPassiveQualificationEvidence &&
        evidence.passiveQualificationPassed &&
        evidence.hasBlockCenterQualificationEvidence &&
        evidence.blockCenterQualificationPassed &&
        isV08CampaignPostA13StrengthQualified(evidence, exactAnchor) &&
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
    allowQualificationFailure = false,
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
    if (result.code !== 0 && !(allowQualificationFailure && result.code === 1)) {
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

export interface IPostA13CoverageLaneSummary {
    lane: {
        unit: string;
        level: number;
        controlUnit: string;
        owner: "candidate" | "opponent";
    };
    games: number;
    candidateGreenGames: number;
    candidateRedGames: number;
    mapCensus: Array<{
        mapType: number;
        games: number;
        candidateGreenGames: number;
        candidateRedGames: number;
    }>;
    candidateWins: number;
    opponentWins: number;
    draws: number;
    appearances: number;
    actingTurns: number;
    completedActions: number;
    completedStrategyActions: number;
    completedRecoveryActions: number;
    rejectedStrategyActions: number;
    rejectedRecoveryActions: number;
    productiveActions: number;
    turnsWithoutProductiveAction: number;
    rejectedCandidate: number;
    rejectedOpponent: number;
    rawEndTurnDecisions: number;
    actionTypes: Record<string, number>;
    rejectionReasons: Record<string, number>;
    spellDecisionTurns: number;
    activeSpellTurns: number;
    activeSpellChargesObserved: number;
    activeSpellsObserved: Record<string, number>;
    activeSpellChargesByName: Record<string, number>;
    spellCasts: Record<string, number>;
    armageddonReached: number;
    armageddonDecided: number;
}

/** Candidate behavior must execute cleanly; fixed-opponent target decisions remain telemetry, not candidate gates. */
export function isV08CampaignPostA13LaneBehaviorQualified(lane: IPostA13CoverageLaneSummary): boolean {
    return (
        lane.games > 0 &&
        lane.appearances === lane.games &&
        lane.actingTurns > 0 &&
        lane.rejectedCandidate === 0 &&
        (lane.lane.owner !== "candidate" ||
            (lane.rejectedStrategyActions === 0 &&
                lane.rejectedRecoveryActions === 0 &&
                lane.rawEndTurnDecisions === 0))
    );
}

/** A searched arm must cast from every intrinsic post-A13 spell kit somewhere in its common panel. */
export function isV08CampaignPostA13SpellExerciseQualified(lanes: readonly IPostA13CoverageLaneSummary[]): boolean {
    const candidateLanesByUnit = new Map(
        lanes.filter(({ lane }) => lane.owner === "candidate").map((lane) => [lane.lane.unit, lane]),
    );
    return Object.entries(V08_CAMPAIGN_POST_A13_SPELL_EXERCISE_KITS).every(([unit, intrinsicSpells]) => {
        const lane = candidateLanesByUnit.get(unit);
        return (
            lane !== undefined &&
            lane.activeSpellTurns > 0 &&
            intrinsicSpells.reduce((sum, spellName) => sum + (lane.spellCasts[spellName] ?? 0), 0) > 0
        );
    });
}

interface IPostA13CoverageSummary {
    schema: typeof V08_CAMPAIGN_POST_A13_COVERAGE_SCHEMA;
    candidateVersion: "v0.8s";
    opponentVersion: "v0.7";
    baseSeed: number;
    pairsPerLane: number;
    maps: readonly number[];
    planSha256: string;
    games: number;
    lanes: IPostA13CoverageLaneSummary[];
}

interface ILevel4CoverageSummary {
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
}

function isNonNegativeSafeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validatedCountEntries(value: unknown): Array<[string, number]> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const entries = Object.entries(value);
    return entries.every(([key, count]) => key.length > 0 && isNonNegativeSafeInteger(count))
        ? (entries as Array<[string, number]>)
        : null;
}

function expectedPostA13MapCensus(pairsPerLane: number): IPostA13CoverageLaneSummary["mapCensus"] {
    const census = V08_POST_A13_LIVE_MAPS.map((mapType) => ({
        mapType,
        games: 0,
        candidateGreenGames: 0,
        candidateRedGames: 0,
    }));
    for (let pair = 0; pair < pairsPerLane; pair += 1) {
        const cell = census[pair % census.length]!;
        cell.games += 2;
        cell.candidateGreenGames += 1;
        cell.candidateRedGames += 1;
    }
    return census;
}

/** Validate the exact 12-unit/two-owner census before coverage can affect fitness or promotion. */
export function validateV08CampaignPostA13CoverageSummary(
    value: unknown,
    expected?: { baseSeed: number; pairsPerLane: number; games: number },
    path = "<post-A13-coverage-summary>",
): IPostA13CoverageSummary {
    const summary = value as Partial<IPostA13CoverageSummary>;
    if (
        summary.schema !== V08_CAMPAIGN_POST_A13_COVERAGE_SCHEMA ||
        summary.candidateVersion !== "v0.8s" ||
        summary.opponentVersion !== "v0.7" ||
        !Number.isSafeInteger(summary.baseSeed) ||
        (summary.baseSeed ?? -1) < 0 ||
        (summary.baseSeed ?? 0x1_0000_0000) > 0xffffffff ||
        !Number.isSafeInteger(summary.pairsPerLane) ||
        (summary.pairsPerLane ?? 0) < 1 ||
        !Array.isArray(summary.maps) ||
        fingerprintV08AlignedV1(summary.maps) !== fingerprintV08AlignedV1(V08_POST_A13_LIVE_MAPS) ||
        typeof summary.planSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(summary.planSha256) ||
        summary.planSha256 !==
            fingerprintV08PostA13CoveragePlan({
                candidateVersion: "v0.8s",
                opponentVersion: "v0.7",
                baseSeed: summary.baseSeed!,
                pairsPerLane: summary.pairsPerLane!,
            }) ||
        !Number.isSafeInteger(summary.games) ||
        summary.games !== summary.pairsPerLane! * V08_CAMPAIGN_POST_A13_COVERAGE_LANE_COUNT * 2 ||
        !Array.isArray(summary.lanes) ||
        summary.lanes.length !== V08_CAMPAIGN_POST_A13_COVERAGE_LANE_COUNT ||
        (expected !== undefined &&
            (summary.baseSeed !== expected.baseSeed ||
                summary.pairsPerLane !== expected.pairsPerLane ||
                summary.games !== expected.games))
    ) {
        throw new Error(`Invalid post-A13 coverage result summary: ${path}`);
    }
    const laneKeys = new Set<string>();
    const ownersByUnit = new Map<string, Set<string>>();
    const expectedLanes = new Map(V08_POST_A13_COVERAGE_LANES.map((lane) => [`${lane.unit}:${lane.owner}`, lane]));
    const expectedMapCensus = expectedPostA13MapCensus(summary.pairsPerLane!);
    let games = 0;
    for (const lane of summary.lanes) {
        const owner = lane?.lane?.owner;
        const unit = lane?.lane?.unit;
        const laneGames = lane?.games;
        const key = `${unit}:${owner}`;
        const expectedLane = expectedLanes.get(key);
        const actionTypes = validatedCountEntries(lane?.actionTypes);
        const rejectionReasons = validatedCountEntries(lane?.rejectionReasons);
        const activeSpellsObserved = validatedCountEntries(lane?.activeSpellsObserved);
        const activeSpellChargesByName = validatedCountEntries(lane?.activeSpellChargesByName);
        const spellCasts = validatedCountEntries(lane?.spellCasts);
        const mapCensus = Array.isArray(lane?.mapCensus) ? lane.mapCensus : [];
        const mapCensusByType = new Map(mapCensus.map((cell) => [cell?.mapType, cell]));
        const completedActionCount = actionTypes?.reduce((sum, [, count]) => sum + count, 0) ?? -1;
        const rejectedActionCount = rejectionReasons?.reduce((sum, [, count]) => sum + count, 0) ?? -1;
        const productiveActionCount =
            actionTypes
                ?.filter(([type]) => ["move_unit", "melee_attack", "range_attack", "cast_spell"].includes(type))
                .reduce((sum, [, count]) => sum + count, 0) ?? -1;
        const observedSpellCount = activeSpellsObserved?.reduce((sum, [, count]) => sum + count, 0) ?? -1;
        const observedChargeCount = activeSpellChargesByName?.reduce((sum, [, count]) => sum + count, 0) ?? -1;
        const castCount = spellCasts?.reduce((sum, [, count]) => sum + count, 0) ?? -1;
        if (
            typeof unit !== "string" ||
            !unit ||
            (owner !== "candidate" && owner !== "opponent") ||
            !expectedLane ||
            lane.lane.level !== expectedLane.level ||
            lane.lane.controlUnit !== expectedLane.controlUnit ||
            !Number.isSafeInteger(laneGames) ||
            laneGames !== summary.pairsPerLane! * 2 ||
            lane.candidateGreenGames !== summary.pairsPerLane ||
            lane.candidateRedGames !== summary.pairsPerLane ||
            mapCensus.length !== V08_POST_A13_LIVE_MAPS.length ||
            mapCensusByType.size !== V08_POST_A13_LIVE_MAPS.length ||
            expectedMapCensus.some((expectedCell) => {
                const actual = mapCensusByType.get(expectedCell.mapType);
                return (
                    !actual ||
                    actual.games !== expectedCell.games ||
                    actual.candidateGreenGames !== expectedCell.candidateGreenGames ||
                    actual.candidateRedGames !== expectedCell.candidateRedGames
                );
            }) ||
            !Number.isSafeInteger(lane.candidateWins) ||
            !Number.isSafeInteger(lane.opponentWins) ||
            !Number.isSafeInteger(lane.draws) ||
            lane.candidateWins < 0 ||
            lane.opponentWins < 0 ||
            lane.draws < 0 ||
            lane.candidateWins + lane.opponentWins + lane.draws !== laneGames ||
            !Number.isSafeInteger(lane.appearances) ||
            lane.appearances !== laneGames ||
            !Number.isSafeInteger(lane.actingTurns) ||
            lane.actingTurns < 0 ||
            !isNonNegativeSafeInteger(lane.completedActions) ||
            !isNonNegativeSafeInteger(lane.completedStrategyActions) ||
            !isNonNegativeSafeInteger(lane.completedRecoveryActions) ||
            lane.completedActions !== lane.completedStrategyActions + lane.completedRecoveryActions ||
            !isNonNegativeSafeInteger(lane.rejectedStrategyActions) ||
            !isNonNegativeSafeInteger(lane.rejectedRecoveryActions) ||
            !isNonNegativeSafeInteger(lane.productiveActions) ||
            !isNonNegativeSafeInteger(lane.turnsWithoutProductiveAction) ||
            lane.turnsWithoutProductiveAction > lane.actingTurns ||
            !Number.isSafeInteger(lane.rejectedCandidate) ||
            lane.rejectedCandidate < 0 ||
            !Number.isSafeInteger(lane.rejectedOpponent) ||
            lane.rejectedOpponent < 0 ||
            !Number.isSafeInteger(lane.rawEndTurnDecisions) ||
            lane.rawEndTurnDecisions < 0 ||
            lane.rawEndTurnDecisions > lane.actingTurns ||
            actionTypes === null ||
            completedActionCount !== lane.completedActions ||
            productiveActionCount !== lane.productiveActions ||
            rejectionReasons === null ||
            rejectedActionCount !== lane.rejectedStrategyActions + lane.rejectedRecoveryActions ||
            !isNonNegativeSafeInteger(lane.spellDecisionTurns) ||
            lane.spellDecisionTurns !== lane.actingTurns ||
            !isNonNegativeSafeInteger(lane.activeSpellTurns) ||
            lane.activeSpellTurns > lane.spellDecisionTurns ||
            !isNonNegativeSafeInteger(lane.activeSpellChargesObserved) ||
            activeSpellsObserved === null ||
            activeSpellChargesByName === null ||
            observedSpellCount < lane.activeSpellTurns ||
            observedChargeCount !== lane.activeSpellChargesObserved ||
            activeSpellsObserved.some(
                ([spell, observations]) =>
                    !activeSpellChargesByName.some(
                        ([chargeSpell, charges]) => chargeSpell === spell && charges >= observations,
                    ),
            ) ||
            spellCasts === null ||
            castCount !== (lane.actionTypes.cast_spell ?? 0) ||
            spellCasts.some(
                ([spell, casts]) =>
                    casts < 1 ||
                    !activeSpellsObserved.some(
                        ([observedSpell, observations]) => observedSpell === spell && observations >= casts,
                    ) ||
                    !activeSpellChargesByName.some(
                        ([chargeSpell, charges]) => chargeSpell === spell && charges >= casts,
                    ),
            ) ||
            !Number.isSafeInteger(lane.armageddonReached) ||
            lane.armageddonReached < 0 ||
            lane.armageddonReached > laneGames ||
            !Number.isSafeInteger(lane.armageddonDecided) ||
            lane.armageddonDecided < 0 ||
            lane.armageddonDecided > lane.armageddonReached
        ) {
            throw new Error(`Invalid post-A13 coverage lane in ${path}`);
        }
        if (laneKeys.has(key)) throw new Error(`Duplicate post-A13 coverage lane ${key} in ${path}`);
        laneKeys.add(key);
        const owners = ownersByUnit.get(unit) ?? new Set<string>();
        owners.add(owner);
        ownersByUnit.set(unit, owners);
        games += laneGames;
    }
    if (
        V08_POST_A13_COVERAGE_UNITS.length !== V08_CAMPAIGN_POST_A13_COVERAGE_LANE_COUNT / 2 ||
        expectedLanes.size !== V08_CAMPAIGN_POST_A13_COVERAGE_LANE_COUNT ||
        ownersByUnit.size !== V08_POST_A13_COVERAGE_UNITS.length ||
        [...expectedLanes.keys()].some((key) => !laneKeys.has(key)) ||
        [...ownersByUnit.values()].some(
            (owners) => owners.size !== 2 || !owners.has("candidate") || !owners.has("opponent"),
        ) ||
        games !== summary.games
    ) {
        throw new Error(`Post-A13 coverage summary has an incomplete unit/owner census: ${path}`);
    }
    return summary as IPostA13CoverageSummary;
}

const V08_CAMPAIGN_ALL_UNIT_REQUIRED_GATES = Object.freeze([
    "exact_catalog",
    "exact_schedule_count",
    "exact_lane_census",
    "exact_map_census",
    "balanced_physical_seats",
    "exact_target_appearances",
    "crashes_zero",
    "stuck_zero",
    "turn_caps_zero",
    "candidate_engine_rejections_zero",
    "candidate_target_strategy_rejections_zero",
    "candidate_target_recovery_zero",
    "candidate_target_raw_no_op_zero",
    "candidate_target_incomplete_turns_zero",
    "candidate_target_productivity",
    "remaining_intrinsic_casters_exercised",
] as const);

export function validateV08CampaignAllUnitCoverageSummary(
    value: unknown,
    expected: {
        sourceCommit: string;
        baseSeed: number;
        pairsPerMap: number;
        games: number;
    },
    path = "<all-unit-coverage-summary>",
): IV08AllUnitCoverageSummary {
    const summary = value as Partial<IV08AllUnitCoverageSummary>;
    const options: IV08AllUnitCoverageOptions = {
        candidateVersion: "v0.8s",
        opponentVersion: "v0.7",
        pairsPerMap: expected.pairsPerMap,
        baseSeed: expected.baseSeed,
        amountMode: "expBudget",
        liveSetup: true,
        maxLaps: 60,
        sourceCommit: expected.sourceCommit,
    };
    if (
        summary.schema !== V08_CAMPAIGN_ALL_UNIT_COVERAGE_SCHEMA ||
        summary.sourceCommit !== expected.sourceCommit ||
        summary.catalogSha256 !== V08_ALL_UNIT_CATALOG_SHA256 ||
        summary.expectedCatalogSha256 !== V08_ALL_UNIT_EXPECTED_CATALOG_SHA256 ||
        fingerprintV08AlignedV1(summary.catalog) !== fingerprintV08AlignedV1(V08_ALL_UNIT_CATALOG) ||
        summary.candidateVersion !== "v0.8s" ||
        summary.opponentVersion !== "v0.7" ||
        summary.options?.pairsPerMap !== expected.pairsPerMap ||
        summary.options?.baseSeed !== expected.baseSeed ||
        summary.options?.amountMode !== "expBudget" ||
        summary.options?.liveSetup !== true ||
        summary.options?.maxLaps !== 60 ||
        fingerprintV08AlignedV1(summary.maps) !== fingerprintV08AlignedV1(V08_ALL_UNIT_LIVE_MAPS) ||
        summary.planSha256 !== fingerprintV08AllUnitCoveragePlan(options) ||
        summary.games !== expected.games ||
        !Array.isArray(summary.lanes) ||
        summary.lanes.length !== V08_CAMPAIGN_ALL_UNIT_COVERAGE_LANE_COUNT ||
        typeof summary.gates?.pass !== "boolean" ||
        !Array.isArray(summary.gates.failed) ||
        !summary.gates.checks ||
        V08_CAMPAIGN_ALL_UNIT_REQUIRED_GATES.some((name) => {
            const check = summary.gates!.checks[name];
            return (
                !check ||
                typeof check.pass !== "boolean" ||
                (typeof check.actual !== "number" && typeof check.actual !== "string") ||
                typeof check.expected !== "string"
            );
        })
    ) {
        throw new Error(`Invalid all-unit coverage result summary: ${path}`);
    }
    const failedGates = V08_CAMPAIGN_ALL_UNIT_REQUIRED_GATES.filter(
        (name) => summary.gates!.checks[name]!.pass === false,
    );
    if (
        summary.gates.pass !== (failedGates.length === 0) ||
        fingerprintV08AlignedV1(summary.gates.failed) !== fingerprintV08AlignedV1(failedGates)
    ) {
        throw new Error(`All-unit coverage result has inconsistent qualification gates: ${path}`);
    }
    const expectedLanes = new Map(V08_ALL_UNIT_COVERAGE_LANES.map((lane) => [`${lane.unit}:${lane.owner}`, lane]));
    const seen = new Set<string>();
    const expectedLaneGames = expected.pairsPerMap * V08_ALL_UNIT_LIVE_MAPS.length * 2;
    for (const lane of summary.lanes) {
        const key = `${lane?.lane?.unit}:${lane?.lane?.owner}`;
        const expectedLane = expectedLanes.get(key);
        if (
            !expectedLane ||
            seen.has(key) ||
            fingerprintV08AlignedV1(lane.lane) !== fingerprintV08AlignedV1(expectedLane) ||
            lane.games !== expectedLaneGames ||
            lane.candidateGreenGames !== expectedLaneGames / 2 ||
            lane.candidateRedGames !== expectedLaneGames / 2 ||
            lane.appearances !== lane.games ||
            !Number.isSafeInteger(lane.actingTurns) ||
            lane.actingTurns < 1 ||
            !Array.isArray(lane.mapCensus) ||
            lane.mapCensus.length !== V08_ALL_UNIT_LIVE_MAPS.length
        ) {
            throw new Error(`Invalid all-unit coverage lane ${key}: ${path}`);
        }
        const byMap = new Map(lane.mapCensus.map((cell) => [cell.mapType, cell]));
        if (
            V08_ALL_UNIT_LIVE_MAPS.some((mapType) => {
                const cell = byMap.get(mapType);
                return (
                    !cell ||
                    cell.games !== expected.pairsPerMap * 2 ||
                    cell.candidateGreenGames !== expected.pairsPerMap ||
                    cell.candidateRedGames !== expected.pairsPerMap
                );
            })
        ) {
            throw new Error(`Invalid all-unit map census for ${key}: ${path}`);
        }
        seen.add(key);
    }
    if (seen.size !== expectedLanes.size) {
        throw new Error(`All-unit coverage summary has an incomplete lane census: ${path}`);
    }
    return summary as IV08AllUnitCoverageSummary;
}

export const V08_CAMPAIGN_PASSIVE_QUALIFICATION_REQUIRED_GATES = Object.freeze([
    "source_commit_bound",
    "exact_game_count",
    "unique_games",
    "observed_turns_positive",
    "passive_evidence_turns_positive",
    "every_game_observed_turns",
    "turn_totals_consistent",
    "balanced_candidate_seats",
    "all_live_maps_present",
    "crashes_zero",
    "stuck_zero",
    "turn_caps_zero",
    "engine_rejections_zero",
    "raw_end_turn_zero",
    "chosen_end_turn_zero",
    "strategy_rejections_zero",
    "recovery_turns_zero",
    "recovery_attempts_zero",
    "recovery_rejections_zero",
    "incomplete_turns_zero",
    "observer_pairing_faults_zero",
    "candidate_enumeration_uncapped",
    "introduced_defends_zero",
    "avoidable_defends_zero",
    "raw_avoidable_defends_repaired",
    "final_defend_share",
    "missed_wait_reactivations_zero",
    "repeated_same_lap_waits_zero",
    "retained_passive_with_better_shortlisted_productive_action_zero",
    "retained_passive_better_shortlisted_action_accounted",
    "avoidable_waits_zero",
    "avoidable_luck_shields_zero",
    "avoidable_mountain_turns_zero",
    "wait_deadline_fallbacks_zero",
    "retained_passive_evidence_complete",
    "terminal_avoidable_passive_streaks_zero",
    "eligible_wait_reactivation_rate",
    "enabled_creature_appearances",
    "abomination_faults_zero",
    "arachna_queen_faults_zero",
] as const);

export function validateV08CampaignPassiveQualificationSummary(
    value: unknown,
    expected: {
        sourceCommit: string;
        baseSeed: number;
        games: number;
        minCreatureAppearances: number;
    },
    path = "<passive-qualification-summary>",
): IV08PassiveTurnPanelSummary {
    const summary = value as Partial<IV08PassiveTurnPanelSummary>;
    const options: IV08PassiveTurnPanelOptions = {
        candidateVersion: "v0.8s",
        opponentVersion: "v0.7",
        games: expected.games,
        baseSeed: expected.baseSeed,
        amountMode: "expBudget",
        liveSetup: true,
        maxLaps: 60,
        minCreatureAppearances: expected.minCreatureAppearances,
        sourceCommit: expected.sourceCommit,
        sourceDirty: false,
        inheritCandidateEnvironment: true,
    };
    const checks = summary.gates?.checks;
    if (
        summary.schema !== V08_PASSIVE_TURN_PANEL_SCHEMA ||
        summary.sourceCommit !== expected.sourceCommit ||
        summary.sourceDirty !== false ||
        summary.candidateVersion !== "v0.8s" ||
        summary.opponentVersion !== "v0.7" ||
        summary.options?.games !== expected.games ||
        summary.options?.baseSeed !== expected.baseSeed ||
        summary.options?.amountMode !== "expBudget" ||
        summary.options?.liveSetup !== true ||
        summary.options?.maxLaps !== 60 ||
        summary.options?.minCreatureAppearances !== expected.minCreatureAppearances ||
        summary.options?.inheritCandidateEnvironment !== true ||
        summary.planSha256 !== fingerprintV08PassiveTurnPanelPlan(options) ||
        summary.games !== expected.games ||
        summary.candidateSeats?.green !== expected.games / 2 ||
        summary.candidateSeats?.red !== expected.games / 2 ||
        typeof summary.gates?.pass !== "boolean" ||
        !Array.isArray(summary.gates.failed) ||
        !checks ||
        fingerprintV08AlignedV1(Object.keys(checks)) !==
            fingerprintV08AlignedV1(V08_CAMPAIGN_PASSIVE_QUALIFICATION_REQUIRED_GATES) ||
        V08_CAMPAIGN_PASSIVE_QUALIFICATION_REQUIRED_GATES.some((name) => {
            const check = checks[name];
            return (
                !check ||
                typeof check.pass !== "boolean" ||
                (typeof check.actual !== "number" && typeof check.actual !== "string") ||
                typeof check.expected !== "string"
            );
        })
    ) {
        throw new Error(`Invalid passive qualification result summary: ${path}`);
    }
    const failed = Object.entries(checks)
        .filter(([, check]) => !check.pass)
        .map(([name]) => name);
    if (
        summary.gates.pass !== (failed.length === 0) ||
        fingerprintV08AlignedV1(summary.gates.failed) !== fingerprintV08AlignedV1(failed)
    ) {
        throw new Error(`Passive qualification result has inconsistent qualification gates: ${path}`);
    }
    return summary as IV08PassiveTurnPanelSummary;
}

export const V08_CAMPAIGN_BLOCK_CENTER_QUALIFICATION_REQUIRED_GATES = Object.freeze([
    "source_commit_bound",
    "exact_game_count",
    "unique_games",
    "balanced_candidate_seats",
    "block_center_only",
    "observed_turns_positive",
    "every_record_has_observations",
    "mountain_state_turn_integrity",
    "creature_turn_integrity",
    "mountain_state_coverage",
    "oracle_direct_exposure_positive",
    "mountain_adjacent_direct_exposure_positive",
    "late_direct_exposure_positive",
    "crashes_zero",
    "stuck_zero",
    "turn_caps_zero",
    "engine_rejections_zero",
    "observer_pairing_faults_zero",
    "shared_catalog_enumeration_not_truncated",
    "oracle_probe_rejections_zero",
    "catalog_probe_rejections_zero",
    "urgent_catalog_misses_zero",
    "urgent_direct_action_misses_zero",
    "urgent_mountain_adjacent_misses_zero",
    "urgent_repeated_non_progress_with_direct_option_zero",
    "urgent_mountain_terminal_jitter_zero",
    "urgent_combat_droughts_zero",
] as const);

export function validateV08CampaignBlockCenterQualificationSummary(
    value: unknown,
    expected: {
        sourceCommit: string;
        baseSeed: number;
        games: number;
    },
    path = "<block-center-qualification-summary>",
): IV08BlockCenterActionSummary {
    const summary = value as Partial<IV08BlockCenterActionSummary>;
    const options: IV08BlockCenterActionPanelOptions = {
        candidateVersion: "v0.8s",
        opponentVersion: "v0.7",
        games: expected.games,
        baseSeed: expected.baseSeed,
        amountMode: "expBudget",
        liveSetup: true,
        maxLaps: 60,
        sourceCommit: expected.sourceCommit,
        sourceDirty: false,
        inheritCandidateEnvironment: true,
    };
    const checks = summary.gates?.checks;
    if (
        summary.schema !== V08_BLOCK_CENTER_ACTION_PANEL_SCHEMA ||
        summary.sourceCommit !== expected.sourceCommit ||
        summary.sourceDirty !== false ||
        summary.candidateVersion !== "v0.8s" ||
        summary.opponentVersion !== "v0.7" ||
        summary.options?.games !== expected.games ||
        summary.options?.baseSeed !== expected.baseSeed ||
        summary.options?.amountMode !== "expBudget" ||
        summary.options?.liveSetup !== true ||
        summary.options?.maxLaps !== 60 ||
        summary.options?.inheritCandidateEnvironment !== true ||
        summary.planSha256 !== fingerprintV08BlockCenterActionPlan(options) ||
        summary.games !== expected.games ||
        summary.candidateSeats?.green !== expected.games / 2 ||
        summary.candidateSeats?.red !== expected.games / 2 ||
        typeof summary.gates?.pass !== "boolean" ||
        !Array.isArray(summary.gates.failed) ||
        !checks ||
        fingerprintV08AlignedV1(Object.keys(checks)) !==
            fingerprintV08AlignedV1(V08_CAMPAIGN_BLOCK_CENTER_QUALIFICATION_REQUIRED_GATES) ||
        V08_CAMPAIGN_BLOCK_CENTER_QUALIFICATION_REQUIRED_GATES.some((name) => {
            const check = checks[name];
            return (
                !check ||
                typeof check.pass !== "boolean" ||
                (typeof check.actual !== "number" && typeof check.actual !== "string") ||
                typeof check.expected !== "string"
            );
        })
    ) {
        throw new Error(`Invalid BLOCK_CENTER qualification result summary: ${path}`);
    }
    const failed = Object.entries(checks)
        .filter(([, check]) => !check.pass)
        .map(([name]) => name);
    if (
        summary.gates.pass !== (failed.length === 0) ||
        fingerprintV08AlignedV1(summary.gates.failed) !== fingerprintV08AlignedV1(failed)
    ) {
        throw new Error(`BLOCK_CENTER qualification result has inconsistent qualification gates: ${path}`);
    }
    return summary as IV08BlockCenterActionSummary;
}

/** Minimal version header check used before accepting any resumable manifest. */
export function isV08CampaignManifestProvenanceCurrent(value: unknown): boolean {
    const manifest = value as {
        schema?: unknown;
        kind?: unknown;
        sourceIdentity?: unknown;
        childEnvironmentPolicy?: unknown;
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
        isV08CampaignSourceIdentityCurrent(manifest.sourceIdentity) &&
        isV08CampaignChildEnvironmentPolicyValid(manifest.childEnvironmentPolicy) &&
        manifest.adaptive?.generatorVersion === V08_CAMPAIGN_ADAPTIVE_GENERATOR_VERSION &&
        manifest.scheduler?.version === V08_CAMPAIGN_SCHEDULER_VERSION &&
        manifest.campaignBaseIdentity?.campaignCandidateCount === BASE_CANDIDATE_COUNT &&
        manifest.campaignBaseIdentity.exactAnchor?.id === V08_CAMPAIGN_EXACT_ANCHOR_ID &&
        manifest.campaignBaseIdentity.exactAnchor.genomeSha256 === V08_A13_GENOME_SHA256 &&
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

/** Minimal resume header check binding generator v7 to the full production-48-plus-A13 campaign base. */
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
        catalog.exactAnchorGenomeSha256 === V08_A13_GENOME_SHA256
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
        exactAnchor.genomeSha256 !== V08_A13_GENOME_SHA256 ||
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

const GIT_OBJECT_ID = /^[a-f0-9]{40,64}$/;

function gitOutput(args: readonly string[]): string {
    return execFileSync("git", [...args], {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    }).trim();
}

/** Validate the immutable source header without consulting the filesystem, so resume headers fail closed. */
export function isV08CampaignSourceIdentityCurrent(value: unknown): value is IV08CampaignSourceIdentity {
    const source = value as Partial<IV08CampaignSourceIdentity>;
    if (
        source?.branch !== "main" ||
        !GIT_OBJECT_ID.test(source.gitHead ?? "") ||
        !GIT_OBJECT_ID.test(source.gitTree ?? "") ||
        source.originMain !== source.gitHead ||
        source.clean !== true ||
        typeof source.bunVersion !== "string" ||
        !source.bunVersion ||
        typeof source.identitySha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(source.identitySha256)
    ) {
        return false;
    }
    return (
        source.identitySha256 ===
        fingerprintV08AlignedV1({
            branch: source.branch,
            gitHead: source.gitHead,
            gitTree: source.gitTree,
            originMain: source.originMain,
            clean: source.clean,
            bunVersion: source.bunVersion,
        })
    );
}

/**
 * Capture a source state suitable for durable research evidence.
 *
 * Every run starts and continues only from a clean main exactly matching the locally fetched origin/main.
 * Ignored campaign output does not dirty this check, while source edits, untracked inputs, commits, rebases,
 * branch changes, or a Bun runtime change invalidate it.
 */
export function captureV08CampaignSourceIdentity(): IV08CampaignSourceIdentity {
    const branch = gitOutput(["rev-parse", "--abbrev-ref", "HEAD"]);
    const gitHead = gitOutput(["rev-parse", "--verify", "HEAD"]);
    const gitTree = gitOutput(["rev-parse", "--verify", "HEAD^{tree}"]);
    const originMain = gitOutput(["rev-parse", "--verify", "origin/main"]);
    const status = gitOutput(["status", "--porcelain=v1", "--untracked-files=all"]);
    const bunVersion = (process.versions as Record<string, string | undefined>).bun ?? "";
    if (
        branch !== "main" ||
        gitHead !== originMain ||
        status !== "" ||
        !GIT_OBJECT_ID.test(gitHead) ||
        !GIT_OBJECT_ID.test(gitTree) ||
        !bunVersion
    ) {
        const reasons = [
            branch === "main" ? null : `branch=${branch || "<detached>"}`,
            gitHead === originMain ? null : `HEAD=${gitHead} origin/main=${originMain}`,
            status === "" ? null : "working tree is not clean",
            bunVersion ? null : "Bun version is unavailable",
        ].filter((reason): reason is string => reason !== null);
        throw new Error(`Campaign source must be clean main exactly at origin/main: ${reasons.join("; ")}`);
    }
    const unsigned = {
        branch: "main" as const,
        gitHead,
        gitTree,
        originMain,
        clean: true as const,
        bunVersion,
    };
    return { ...unsigned, identitySha256: fingerprintV08AlignedV1(unsigned) };
}

function assertManifestSourceIdentityCurrent(manifest: IManifest): void {
    const current = captureV08CampaignSourceIdentity();
    if (
        manifest.repositoryRoot !== REPOSITORY_ROOT ||
        manifest.bun !== process.execPath ||
        !isV08CampaignSourceIdentityCurrent(manifest.sourceIdentity) ||
        current.identitySha256 !== manifest.sourceIdentity.identitySha256
    ) {
        throw new Error(
            `Campaign source identity drifted from ${manifest.sourceIdentity.gitHead}/${manifest.sourceIdentity.gitTree}`,
        );
    }
}

function buildManifest(
    cli: ICli,
    bindings: IV08AlignedV1CandidateBinding[],
    sourceIdentity: IV08CampaignSourceIdentity,
): IManifest {
    const startedAtMs = Date.now();
    const config = {
        hours: cli.hours,
        concurrency: cli.concurrency,
        lanes: cli.lanes,
        screenGames: cli.screenGames,
        validationGames: cli.validationGames,
        topCandidates: Math.min(cli.topCandidates, bindings.length),
        level4PairsPerLane: cli.level4PairsPerLane,
        coveragePairsPerLane: cli.coveragePairsPerLane,
        allUnitPairsPerMap: cli.allUnitPairsPerMap,
        allUnitQualificationPairsPerMap: cli.allUnitQualificationPairsPerMap,
        passiveQualificationGames: cli.passiveQualificationGames,
        passiveQualificationMinCreatureAppearances: cli.passiveQualificationMinCreatureAppearances,
        blockCenterQualificationGames: cli.blockCenterQualificationGames,
        screenSeed: cli.screenSeed,
        level4Seed: cli.level4Seed,
        coverageSeed: cli.coverageSeed,
        allUnitSeed: cli.allUnitSeed,
        allUnitQualificationSeed: cli.allUnitQualificationSeed,
        passiveQualificationSeed: cli.passiveQualificationSeed,
        blockCenterQualificationSeed: cli.blockCenterQualificationSeed,
        validationSeed: cli.validationSeed,
        workersPerJob: cli.workersPerJob,
        maxWorkers: cli.maxWorkers,
        unboundedSearch: cli.unboundedSearch,
    };
    const candidates = campaignCandidateDescriptors(bindings, cli.unboundedSearch);
    const childEnvironmentPolicy = buildV08CampaignChildEnvironmentPolicy();
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
        sourceIdentity,
        childEnvironmentPolicy,
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
            evidence: "fully-committed-validation-plus-decision-quality-qualification" as const,
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
        const sourceIdentity = captureV08CampaignSourceIdentity();
        mkdirSync(cli.output, { recursive: true });
        const manifest = buildManifest(cli, bindings, sourceIdentity);
        atomicJson(path, manifest);
        return manifest;
    }
    const manifest = readJson<IManifest>(path);
    assertManifestSourceIdentityCurrent(manifest);
    const requested = {
        hours: cli.hours,
        concurrency: cli.concurrency,
        lanes: cli.lanes,
        screenGames: cli.screenGames,
        validationGames: cli.validationGames,
        topCandidates: Math.min(cli.topCandidates, bindings.length),
        level4PairsPerLane: cli.level4PairsPerLane,
        coveragePairsPerLane: cli.coveragePairsPerLane,
        allUnitPairsPerMap: cli.allUnitPairsPerMap,
        allUnitQualificationPairsPerMap: cli.allUnitQualificationPairsPerMap,
        passiveQualificationGames: cli.passiveQualificationGames,
        passiveQualificationMinCreatureAppearances: cli.passiveQualificationMinCreatureAppearances,
        blockCenterQualificationGames: cli.blockCenterQualificationGames,
        screenSeed: cli.screenSeed,
        level4Seed: cli.level4Seed,
        coverageSeed: cli.coverageSeed,
        allUnitSeed: cli.allUnitSeed,
        allUnitQualificationSeed: cli.allUnitQualificationSeed,
        passiveQualificationSeed: cli.passiveQualificationSeed,
        blockCenterQualificationSeed: cli.blockCenterQualificationSeed,
        validationSeed: cli.validationSeed,
        workersPerJob: cli.workersPerJob,
        maxWorkers: cli.maxWorkers,
        unboundedSearch: cli.unboundedSearch,
    };
    const expectedCatalog = buildV08AlignedV1ProductionCatalogIdentity();
    const expectedCandidates = campaignCandidateDescriptors(bindings, cli.unboundedSearch);
    const expectedCampaignBaseIdentity = buildCampaignBaseIdentity(expectedCandidates);
    const expectedChildEnvironmentPolicy = buildV08CampaignChildEnvironmentPolicy();
    if (
        !isV08CampaignManifestProvenanceCurrent(manifest) ||
        manifest.fingerprint !== fingerprintV08AlignedV1({ ...manifest, fingerprint: undefined }) ||
        JSON.stringify(manifest.config) !== JSON.stringify(requested) ||
        manifest.catalogIdentity.catalogSha256 !== expectedCatalog.catalogSha256 ||
        fingerprintV08AlignedV1(manifest.campaignBaseIdentity) !==
            fingerprintV08AlignedV1(expectedCampaignBaseIdentity) ||
        fingerprintV08AlignedV1(manifest.childEnvironmentPolicy) !==
            fingerprintV08AlignedV1(expectedChildEnvironmentPolicy) ||
        manifest.researchRanking !== V08_CAMPAIGN_RESEARCH_RANKING ||
        fingerprintV08AlignedV1(manifest.reserveEligibility) !==
            fingerprintV08AlignedV1(V08_CAMPAIGN_RESERVE_ELIGIBILITY) ||
        manifest.selection.strategy !== "exact-anchor_then_inactive-control_then_strength_then_total-arm-reserve" ||
        manifest.selection.minimumValidationCandidates !== 2 ||
        fingerprintV08AlignedV1(manifest.selection.inactiveControlCandidateIds) !==
            fingerprintV08AlignedV1(V08_CAMPAIGN_INACTIVE_CONTROL_IDS) ||
        manifest.promotionComparison.evidence !== "fully-committed-validation-plus-decision-quality-qualification" ||
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
        pairsPerMap: job.pairsPerMap ?? null,
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
        ...(job.pairsPerMap === undefined ? {} : { pairsPerMap: job.pairsPerMap }),
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

export interface IV08CampaignDecisionQualityCensusInput {
    completed: readonly Pick<
        ICompletedJob,
        "id" | "kind" | "candidateId" | "games" | "baseSeed" | "startedAtMs" | "completedAt"
    >[];
    candidateIds: readonly string[];
    passiveGames: number;
    passiveSeed: number;
    blockCenterGames: number;
    blockCenterSeed: number;
}

/**
 * A validation result is meaningful only if its exact persisted shortlist had already completed both immutable
 * decision-quality panels. This also prevents a resumed/edited checkpoint from backfilling diagnostics after
 * seeing validation outcomes.
 */
export function assertV08CampaignDecisionQualityPrecedesValidation({
    completed,
    candidateIds,
    passiveGames,
    passiveSeed,
    blockCenterGames,
    blockCenterSeed,
}: IV08CampaignDecisionQualityCensusInput): void {
    const candidateSet = new Set(candidateIds);
    const seen = new Map<string, (typeof completed)[number]>();
    const qualityKinds = new Set<JobKind>(["passive_qualification", "block_center_qualification"]);
    const validations = completed.filter(({ kind }) => kind === "validation");
    for (const job of completed) {
        if (!qualityKinds.has(job.kind)) continue;
        if (!candidateSet.has(job.candidateId)) {
            throw new Error(`Decision-quality job ${job.id} is outside the persisted validation shortlist`);
        }
        const passive = job.kind === "passive_qualification";
        const expectedId = `${passive ? "passive-qualification" : "block-center-qualification"}-${job.candidateId}`;
        const expectedGames = passive ? passiveGames : blockCenterGames;
        const expectedSeed = passive ? passiveSeed : blockCenterSeed;
        const key = `${job.kind}:${job.candidateId}`;
        if (job.id !== expectedId || job.games !== expectedGames || job.baseSeed !== expectedSeed || seen.has(key)) {
            throw new Error(`Decision-quality job ${job.id} is outside the immutable qualification plan`);
        }
        seen.set(key, job);
    }
    if (!validations.length) return;
    if (candidateIds.length < 2) {
        throw new Error("Validation evidence requires a persisted decision-quality shortlist");
    }
    const firstValidationStart = Math.min(...validations.map(({ startedAtMs }) => startedAtMs));
    if (!Number.isSafeInteger(firstValidationStart)) {
        throw new Error("Validation evidence has an invalid start timestamp");
    }
    for (const candidateId of candidateIds) {
        for (const kind of ["passive_qualification", "block_center_qualification"] as const) {
            const quality = seen.get(`${kind}:${candidateId}`);
            if (!quality) {
                throw new Error(`Validation evidence is missing ${kind} for ${candidateId}`);
            }
            const completedAtMs = Date.parse(quality.completedAt);
            if (!Number.isSafeInteger(completedAtMs) || completedAtMs > firstValidationStart) {
                throw new Error(`Decision-quality job ${quality.id} did not precede validation`);
            }
        }
    }
}

export function classifyV08CampaignValidationRoundState({
    pendingJobs,
    nowMs,
    deadlineAtMs,
    stop,
    launchesAllowed,
}: {
    pendingJobs: number;
    nowMs: number;
    deadlineAtMs: number;
    stop: boolean;
    launchesAllowed: boolean;
}): "commit" | "launch" | "stop" {
    if (
        !Number.isSafeInteger(pendingJobs) ||
        pendingJobs < 0 ||
        !Number.isFinite(nowMs) ||
        !Number.isFinite(deadlineAtMs)
    ) {
        throw new Error("Invalid validation round state");
    }
    // A complete common-random round commits even after the launch deadline or a stop request. Only pending
    // work is prohibited; already-produced evidence must not be stranded behind an unadvanced barrier.
    if (pendingJobs === 0) return "commit";
    if (!launchesAllowed || nowMs >= deadlineAtMs || stop) return "stop";
    return "launch";
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
        typeof job.summarySha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(job.summarySha256) ||
        typeof job.sourceSummarySha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(job.sourceSummarySha256) ||
        typeof job.recordsPath !== "string" ||
        !job.recordsPath ||
        typeof job.recordsSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(job.recordsSha256) ||
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

function jobArtifactPaths(
    manifest: IManifest,
    job: ICompletedJob,
): { resultPath: string; summaryPath: string; recordsPath: string } {
    const jobsRoot = resolve(manifest.output, "jobs");
    const directory = resolve(jobsRoot, job.id);
    const summaryPath = resolve(manifest.output, job.summaryPath);
    const recordsPath = resolve(manifest.output, job.recordsPath);
    if (
        dirname(directory) !== jobsRoot ||
        dirname(summaryPath) !== directory ||
        dirname(recordsPath) !== directory ||
        summaryPath === recordsPath
    ) {
        throw new Error(`Job ${job.id} contains a non-canonical artifact path`);
    }
    return { resultPath: join(directory, "result.json"), summaryPath, recordsPath };
}

function validateResultArtifact(manifest: IManifest, job: ICompletedJob, verifySource: boolean): IResultFile {
    assertCompletedJob(job, manifest, `Completed job ${job.id}`);
    const paths = jobArtifactPaths(manifest, job);
    if (!existsSync(paths.resultPath) || !existsSync(paths.summaryPath) || !existsSync(paths.recordsPath)) {
        throw new Error(`Completed job ${job.id} is missing a committed artifact`);
    }
    const result = readJson<IResultFile>(paths.resultPath);
    if (
        result.schema !== SCHEMA ||
        result.kind !== "job-result" ||
        result.manifestFingerprint !== manifest.fingerprint ||
        fingerprintV08AlignedV1(result.job) !== fingerprintV08AlignedV1(job) ||
        fingerprintV08AlignedV1(result.summary) !== job.summarySha256
    ) {
        throw new Error(`Result ${job.id} is not exactly bound to its checkpoint provenance`);
    }
    if (
        artifactSha256(paths.summaryPath) !== job.sourceSummarySha256 ||
        artifactSha256(paths.recordsPath) !== job.recordsSha256
    ) {
        throw new Error(`Result ${job.id} source artifacts no longer match their committed hashes`);
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
    if (job.kind === "post_a13_coverage") {
        validateV08CampaignPostA13CoverageSummary(
            result.summary,
            {
                baseSeed: job.baseSeed,
                pairsPerLane: job.pairsPerLane!,
                games: jobWorkUnits(job),
            },
            job.summaryPath,
        );
        if (
            verifySource &&
            fingerprintV08AlignedV1(readJson<unknown>(paths.summaryPath)) !== fingerprintV08AlignedV1(result.summary)
        ) {
            throw new Error(`Post-A13 coverage result ${job.id} does not match its source summary`);
        }
        return result;
    }
    if (job.kind === "all_unit_coverage" || job.kind === "all_unit_qualification") {
        const expected = {
            sourceCommit: manifest.sourceIdentity.gitHead,
            baseSeed: job.baseSeed,
            pairsPerMap: job.pairsPerMap!,
            games: jobWorkUnits(job),
        };
        validateV08CampaignAllUnitCoverageSummary(result.summary, expected, job.summaryPath);
        if (verifySource) {
            const options: IV08AllUnitCoverageOptions = {
                candidateVersion: "v0.8s",
                opponentVersion: "v0.7",
                pairsPerMap: job.pairsPerMap!,
                baseSeed: job.baseSeed,
                amountMode: "expBudget",
                liveSetup: true,
                maxLaps: 60,
                sourceCommit: manifest.sourceIdentity.gitHead,
            };
            const records = readJsonl<IV08AllUnitCoverageRecord>(paths.recordsPath);
            const recomputed = summarizeV08AllUnitCoverage(options, records);
            if (
                fingerprintV08AlignedV1(readJson<unknown>(paths.summaryPath)) !==
                    fingerprintV08AlignedV1(result.summary) ||
                fingerprintV08AlignedV1(recomputed) !== fingerprintV08AlignedV1(result.summary)
            ) {
                throw new Error(`All-unit result ${job.id} does not match its source records and summary`);
            }
        }
        return result;
    }
    if (job.kind === "passive_qualification") {
        const expected = {
            sourceCommit: manifest.sourceIdentity.gitHead,
            baseSeed: job.baseSeed,
            games: job.games!,
            minCreatureAppearances: manifest.config.passiveQualificationMinCreatureAppearances,
        };
        validateV08CampaignPassiveQualificationSummary(result.summary, expected, job.summaryPath);
        if (verifySource) {
            const options: IV08PassiveTurnPanelOptions = {
                candidateVersion: "v0.8s",
                opponentVersion: "v0.7",
                games: job.games!,
                baseSeed: job.baseSeed,
                amountMode: "expBudget",
                liveSetup: true,
                maxLaps: 60,
                minCreatureAppearances: manifest.config.passiveQualificationMinCreatureAppearances,
                sourceCommit: manifest.sourceIdentity.gitHead,
                inheritCandidateEnvironment: true,
            };
            const records = readJsonl<IV08PassiveTurnPanelRecord>(paths.recordsPath);
            const recomputed = summarizeV08PassiveTurnPanel(options, records);
            if (
                fingerprintV08AlignedV1(readJson<unknown>(paths.summaryPath)) !==
                    fingerprintV08AlignedV1(result.summary) ||
                fingerprintV08AlignedV1(recomputed) !== fingerprintV08AlignedV1(result.summary)
            ) {
                throw new Error(`Passive qualification result ${job.id} does not match its source artifacts`);
            }
        }
        return result;
    }
    if (job.kind === "block_center_qualification") {
        const expected = {
            sourceCommit: manifest.sourceIdentity.gitHead,
            baseSeed: job.baseSeed,
            games: job.games!,
        };
        validateV08CampaignBlockCenterQualificationSummary(result.summary, expected, job.summaryPath);
        if (verifySource) {
            const options: IV08BlockCenterActionPanelOptions = {
                candidateVersion: "v0.8s",
                opponentVersion: "v0.7",
                games: job.games!,
                baseSeed: job.baseSeed,
                amountMode: "expBudget",
                liveSetup: true,
                maxLaps: 60,
                sourceCommit: manifest.sourceIdentity.gitHead,
                sourceDirty: false,
                inheritCandidateEnvironment: true,
            };
            const records = readJsonl<IV08BlockCenterActionRecord>(paths.recordsPath);
            const recomputed = summarizeV08BlockCenterActionPanel(options, records);
            if (
                fingerprintV08AlignedV1(readJson<unknown>(paths.summaryPath)) !==
                    fingerprintV08AlignedV1(result.summary) ||
                fingerprintV08AlignedV1(recomputed) !== fingerprintV08AlignedV1(result.summary)
            ) {
                throw new Error(`BLOCK_CENTER qualification result ${job.id} does not match its source artifacts`);
            }
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
            ...armageddonEvidence(paths.recordsPath),
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
        selection.schema !== "hoc.v0_8_aggressive_validation_selection.v3" ||
        selection.version !== V08_CAMPAIGN_SELECTION_VERSION ||
        selection.manifestFingerprint !== manifest.fingerprint ||
        selection.exactAnchorCandidateId !== V08_CAMPAIGN_EXACT_ANCHOR_ID ||
        selection.exactAnchorGenomeSha256 !== V08_A13_GENOME_SHA256 ||
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
        selection.candidateGenomeSha256[0] !== V08_A13_GENOME_SHA256 ||
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
        ![
            "screen",
            "adaptive",
            "level4",
            "post_a13_coverage",
            "all_unit_coverage",
            "all_unit_qualification",
            "decision_quality_qualification",
            "validation",
            "complete",
        ].includes(checkpoint.phase) ||
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
    assertV08CampaignDecisionQualityPrecedesValidation({
        completed: checkpoint.completed,
        candidateIds: checkpoint.validationSelection?.candidateIds ?? [],
        passiveGames: manifest.config.passiveQualificationGames,
        passiveSeed: manifest.config.passiveQualificationSeed,
        blockCenterGames: manifest.config.blockCenterQualificationGames,
        blockCenterSeed: manifest.config.blockCenterQualificationSeed,
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
    // A resumed orchestrator cannot adopt children from the prior process. Never clear a live/uncertain writer
    // and relaunch its spec into the same directory: that would oversubscribe the host and race JSONL/summary
    // artifacts. Dead recorded processes are safe to retry; result.json remains the only recovery commit point.
    assertV08CampaignResumeHasNoLiveJobs(checkpoint.activeJobs);
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
    assertV08CampaignDecisionQualityPrecedesValidation({
        completed: checkpoint.completed,
        candidateIds: checkpoint.validationSelection?.candidateIds ?? [],
        passiveGames: manifest.config.passiveQualificationGames,
        passiveSeed: manifest.config.passiveQualificationSeed,
        blockCenterGames: manifest.config.blockCenterQualificationGames,
        blockCenterSeed: manifest.config.blockCenterQualificationSeed,
    });
    const metadata = candidateMetadata(manifest, adaptive);
    const byCandidate = new Map<string, ITournamentSummaryWithReached[]>();
    const validationByCandidate = new Map<string, ITournamentSummaryWithReached[]>();
    const validationEvidenceByCandidate = new Map<string, Array<{ round: number; games: number; baseSeed: number }>>();
    const level4ByCandidate = new Map<string, Array<{ path: string; summary: ILevel4CoverageSummary }>>();
    const postA13CoverageByCandidate = new Map<string, Array<{ path: string; summary: IPostA13CoverageSummary }>>();
    const allUnitCoverageByCandidate = new Map<
        string,
        Array<{ path: string; summary: IV08AllUnitCoverageSummary; job: ICompletedJob }>
    >();
    const allUnitQualificationByCandidate = new Map<
        string,
        Array<{ path: string; summary: IV08AllUnitCoverageSummary; job: ICompletedJob }>
    >();
    const passiveQualificationByCandidate = new Map<
        string,
        Array<{ path: string; summary: IV08PassiveTurnPanelSummary; job: ICompletedJob }>
    >();
    const blockCenterQualificationByCandidate = new Map<
        string,
        Array<{ path: string; summary: IV08BlockCenterActionSummary; job: ICompletedJob }>
    >();
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
            const summaries = level4ByCandidate.get(job.candidateId) ?? [];
            summaries.push({ path: job.summaryPath, summary: result.summary as ILevel4CoverageSummary });
            level4ByCandidate.set(job.candidateId, summaries);
            continue;
        }
        if (job.kind === "post_a13_coverage") {
            const summaries = postA13CoverageByCandidate.get(job.candidateId) ?? [];
            summaries.push({
                path: job.summaryPath,
                summary: validateV08CampaignPostA13CoverageSummary(
                    result.summary,
                    {
                        baseSeed: job.baseSeed,
                        pairsPerLane: job.pairsPerLane!,
                        games: jobWorkUnits(job),
                    },
                    job.summaryPath,
                ),
            });
            postA13CoverageByCandidate.set(job.candidateId, summaries);
            continue;
        }
        if (job.kind === "all_unit_coverage" || job.kind === "all_unit_qualification") {
            const target =
                job.kind === "all_unit_coverage" ? allUnitCoverageByCandidate : allUnitQualificationByCandidate;
            const summaries = target.get(job.candidateId) ?? [];
            summaries.push({
                path: job.summaryPath,
                summary: validateV08CampaignAllUnitCoverageSummary(
                    result.summary,
                    {
                        sourceCommit: manifest.sourceIdentity.gitHead,
                        baseSeed: job.baseSeed,
                        pairsPerMap: job.pairsPerMap!,
                        games: jobWorkUnits(job),
                    },
                    job.summaryPath,
                ),
                job,
            });
            target.set(job.candidateId, summaries);
            continue;
        }
        if (job.kind === "passive_qualification") {
            const summaries = passiveQualificationByCandidate.get(job.candidateId) ?? [];
            summaries.push({
                path: job.summaryPath,
                summary: validateV08CampaignPassiveQualificationSummary(
                    result.summary,
                    {
                        sourceCommit: manifest.sourceIdentity.gitHead,
                        baseSeed: job.baseSeed,
                        games: job.games!,
                        minCreatureAppearances: manifest.config.passiveQualificationMinCreatureAppearances,
                    },
                    job.summaryPath,
                ),
                job,
            });
            passiveQualificationByCandidate.set(job.candidateId, summaries);
            continue;
        }
        if (job.kind === "block_center_qualification") {
            const summaries = blockCenterQualificationByCandidate.get(job.candidateId) ?? [];
            summaries.push({
                path: job.summaryPath,
                summary: validateV08CampaignBlockCenterQualificationSummary(
                    result.summary,
                    {
                        sourceCommit: manifest.sourceIdentity.gitHead,
                        baseSeed: job.baseSeed,
                        games: job.games!,
                    },
                    job.summaryPath,
                ),
                job,
            });
            blockCenterQualificationByCandidate.set(job.candidateId, summaries);
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
        const tournamentGames = summaries.reduce((sum, summary) => sum + summary.games, 0);
        const tournamentWinsA = summaries.reduce((sum, summary) => sum + summary.a.wins, 0);
        const tournamentWinsB = summaries.reduce((sum, summary) => sum + summary.b.wins, 0);
        const tournamentDraws = summaries.reduce((sum, summary) => sum + summary.draws, 0);
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
        const level4Entries = level4ByCandidate.get(id) ?? [];
        const level4Summaries = level4Entries.map(({ summary }) => summary);
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
        const postA13CoverageEntries = postA13CoverageByCandidate.get(id) ?? [];
        const postA13CoverageSummaries = postA13CoverageEntries.map(({ summary }) => summary);
        const postA13CoverageGames = postA13CoverageSummaries.reduce((sum, summary) => sum + summary.games, 0);
        const postA13CandidateWins = postA13CoverageSummaries.reduce(
            (sum, summary) => sum + summary.lanes.reduce((laneSum, lane) => laneSum + lane.candidateWins, 0),
            0,
        );
        const postA13OpponentWins = postA13CoverageSummaries.reduce(
            (sum, summary) => sum + summary.lanes.reduce((laneSum, lane) => laneSum + lane.opponentWins, 0),
            0,
        );
        const postA13Draws = postA13CoverageSummaries.reduce(
            (sum, summary) => sum + summary.lanes.reduce((laneSum, lane) => laneSum + lane.draws, 0),
            0,
        );
        const postA13CandidateWinRate = postA13CoverageGames ? postA13CandidateWins / postA13CoverageGames : 0;
        const postA13DecisiveWinRate =
            postA13CandidateWins + postA13OpponentWins
                ? postA13CandidateWins / (postA13CandidateWins + postA13OpponentWins)
                : 0.5;
        const postA13CoverageEvidence = postA13CoverageSummaries
            .map((summary) => ({
                baseSeed: summary.baseSeed,
                pairsPerLane: summary.pairsPerLane,
                games: summary.games,
                planSha256: summary.planSha256,
            }))
            .sort((left, right) => left.baseSeed - right.baseSeed);
        const postA13CoverageEvidenceSha256 = postA13CoverageEvidence.length
            ? fingerprintV08AlignedV1(postA13CoverageEvidence)
            : null;
        const postA13ArmageddonReached = postA13CoverageSummaries.reduce(
            (sum, summary) => sum + summary.lanes.reduce((laneSum, lane) => laneSum + lane.armageddonReached, 0),
            0,
        );
        const postA13ArmageddonDecided = postA13CoverageSummaries.reduce(
            (sum, summary) => sum + summary.lanes.reduce((laneSum, lane) => laneSum + lane.armageddonDecided, 0),
            0,
        );
        const postA13ArmageddonRate = postA13CoverageGames ? postA13ArmageddonReached / postA13CoverageGames : 1;
        const hasPostA13CoverageEvidence = postA13CoverageSummaries.length > 0;
        const postA13CoveragePassed =
            hasPostA13CoverageEvidence &&
            postA13CoverageSummaries.every((summary) => summary.lanes.every(isV08CampaignPostA13LaneBehaviorQualified));
        const postA13SpellExercisePassed =
            hasPostA13CoverageEvidence &&
            postA13CoverageSummaries.every((summary) => isV08CampaignPostA13SpellExerciseQualified(summary.lanes));
        const postA13UnitOutcomesByUnit = new Map<
            string,
            Pick<IV08CampaignPostA13UnitOutcome, "unit" | "games" | "candidateWins" | "opponentWins" | "draws">
        >();
        for (const summary of postA13CoverageSummaries) {
            for (const lane of summary.lanes) {
                const outcome = postA13UnitOutcomesByUnit.get(lane.lane.unit) ?? {
                    unit: lane.lane.unit,
                    games: 0,
                    candidateWins: 0,
                    opponentWins: 0,
                    draws: 0,
                };
                outcome.games += lane.games;
                outcome.candidateWins += lane.candidateWins;
                outcome.opponentWins += lane.opponentWins;
                outcome.draws += lane.draws;
                postA13UnitOutcomesByUnit.set(lane.lane.unit, outcome);
            }
        }
        const postA13UnitOutcomes = [...postA13UnitOutcomesByUnit.values()]
            .sort((left, right) => left.unit.localeCompare(right.unit))
            .map((outcome): IV08CampaignPostA13UnitOutcome => ({
                ...outcome,
                candidateWinRate: outcome.games ? outcome.candidateWins / outcome.games : 0,
                decisiveWinRate:
                    outcome.candidateWins + outcome.opponentWins
                        ? outcome.candidateWins / (outcome.candidateWins + outcome.opponentWins)
                        : 0.5,
            }));
        const allUnitCoverageEntries = allUnitCoverageByCandidate.get(id) ?? [];
        const allUnitCoverageGames = allUnitCoverageEntries.reduce((sum, { summary }) => sum + summary.games, 0);
        const hasAllUnitCoverageEvidence = allUnitCoverageEntries.length === 1;
        const allUnitCoveragePassed =
            hasAllUnitCoverageEvidence && allUnitCoverageEntries.every(({ summary }) => summary.gates.pass);
        const allUnitCoverageEvidenceSha256 = allUnitCoverageEntries.length
            ? fingerprintV08AlignedV1(
                  allUnitCoverageEntries
                      .map(({ summary, job }) => ({
                          jobId: job.id,
                          baseSeed: summary.options.baseSeed,
                          pairsPerMap: summary.options.pairsPerMap,
                          games: summary.games,
                          planSha256: summary.planSha256,
                          summarySha256: job.summarySha256,
                      }))
                      .sort((left, right) => left.jobId.localeCompare(right.jobId)),
              )
            : null;
        const allUnitQualificationEntries = allUnitQualificationByCandidate.get(id) ?? [];
        const allUnitQualificationGames = allUnitQualificationEntries.reduce(
            (sum, { summary }) => sum + summary.games,
            0,
        );
        const hasAllUnitQualificationEvidence = allUnitQualificationEntries.length === 1;
        const allUnitQualificationPassed =
            hasAllUnitQualificationEvidence && allUnitQualificationEntries.every(({ summary }) => summary.gates.pass);
        const allUnitQualificationEvidenceSha256 = allUnitQualificationEntries.length
            ? fingerprintV08AlignedV1(
                  allUnitQualificationEntries
                      .map(({ summary, job }) => ({
                          jobId: job.id,
                          baseSeed: summary.options.baseSeed,
                          pairsPerMap: summary.options.pairsPerMap,
                          games: summary.games,
                          planSha256: summary.planSha256,
                          summarySha256: job.summarySha256,
                      }))
                      .sort((left, right) => left.jobId.localeCompare(right.jobId)),
              )
            : null;
        const passiveQualificationEntries = passiveQualificationByCandidate.get(id) ?? [];
        const passiveQualificationGames = passiveQualificationEntries.reduce(
            (sum, { summary }) => sum + summary.games,
            0,
        );
        const hasPassiveQualificationEvidence = passiveQualificationEntries.length === 1;
        const passiveQualificationPassed =
            hasPassiveQualificationEvidence && passiveQualificationEntries.every(({ summary }) => summary.gates.pass);
        const passiveQualificationEvidenceSha256 = passiveQualificationEntries.length
            ? fingerprintV08AlignedV1(
                  passiveQualificationEntries
                      .map(({ summary, job }) => ({
                          jobId: job.id,
                          baseSeed: summary.options.baseSeed,
                          games: summary.games,
                          minCreatureAppearances: summary.options.minCreatureAppearances,
                          planSha256: summary.planSha256,
                          summarySha256: job.summarySha256,
                      }))
                      .sort((left, right) => left.jobId.localeCompare(right.jobId)),
              )
            : null;
        const blockCenterQualificationEntries = blockCenterQualificationByCandidate.get(id) ?? [];
        const blockCenterQualificationGames = blockCenterQualificationEntries.reduce(
            (sum, { summary }) => sum + summary.games,
            0,
        );
        const hasBlockCenterQualificationEvidence = blockCenterQualificationEntries.length === 1;
        const blockCenterQualificationPassed =
            hasBlockCenterQualificationEvidence &&
            blockCenterQualificationEntries.every(({ summary }) => summary.gates.pass);
        const blockCenterQualificationEvidenceSha256 = blockCenterQualificationEntries.length
            ? fingerprintV08AlignedV1(
                  blockCenterQualificationEntries
                      .map(({ summary, job }) => ({
                          jobId: job.id,
                          baseSeed: summary.options.baseSeed,
                          games: summary.games,
                          planSha256: summary.planSha256,
                          summarySha256: job.summarySha256,
                      }))
                      .sort((left, right) => left.jobId.localeCompare(right.jobId)),
              )
            : null;
        const games = tournamentGames + postA13CoverageGames;
        const winsA = tournamentWinsA + postA13CandidateWins;
        const winsB = tournamentWinsB + postA13OpponentWins;
        const draws = tournamentDraws + postA13Draws;
        const candidateWinRate = games ? winsA / games : 0;
        const drawRate = games ? draws / games : 0;
        const decisiveWinRate = winsA + winsB ? winsA / (winsA + winsB) : 0.5;
        const armageddonRate = tournamentGames ? armageddonReached / tournamentGames : 1;
        const nonLossArmageddonReached = armageddonReachedCandidateWins + armageddonReachedDraws;
        const nonLossArmageddonRate = tournamentGames ? nonLossArmageddonReached / tournamentGames : 1;
        const passesArmageddonGate =
            armageddonRate <= ARMAGEDDON_RATE_GATE &&
            level4ArmageddonRate <= ARMAGEDDON_RATE_GATE &&
            level4CoveragePassed &&
            postA13CoveragePassed;
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
            tournamentGames,
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
            postA13CoverageGames,
            postA13CandidateWins,
            postA13OpponentWins,
            postA13Draws,
            postA13CandidateWinRate,
            postA13DecisiveWinRate,
            postA13CoverageEvidenceSha256,
            postA13ArmageddonReached,
            postA13ArmageddonDecided,
            postA13ArmageddonRate,
            hasPostA13CoverageEvidence,
            postA13CoveragePassed,
            postA13SpellExercisePassed,
            allUnitCoverageGames,
            hasAllUnitCoverageEvidence,
            allUnitCoveragePassed,
            allUnitCoverageEvidenceSha256,
            allUnitCoverageSummaryPaths: allUnitCoverageEntries.map(({ path }) => path),
            allUnitQualificationGames,
            hasAllUnitQualificationEvidence,
            allUnitQualificationPassed,
            allUnitQualificationEvidenceSha256,
            allUnitQualificationSummaryPaths: allUnitQualificationEntries.map(({ path }) => path),
            passiveQualificationGames,
            hasPassiveQualificationEvidence,
            passiveQualificationPassed,
            passiveQualificationEvidenceSha256,
            passiveQualificationSummaryPaths: passiveQualificationEntries.map(({ path }) => path),
            blockCenterQualificationGames,
            hasBlockCenterQualificationEvidence,
            blockCenterQualificationPassed,
            blockCenterQualificationEvidenceSha256,
            blockCenterQualificationSummaryPaths: blockCenterQualificationEntries.map(({ path }) => path),
            passesPostA13StrengthGate: false,
            postA13UnitOutcomes,
            passesArmageddonGate,
            passesStrengthGate: false,
            promotionEligible: false,
            level4SummaryPaths: level4Entries.map(({ path }) => path),
            postA13CoverageSummaryPaths: postA13CoverageEntries.map(({ path }) => path),
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
            row.passesPostA13StrengthGate =
                row.candidateId !== V08_CAMPAIGN_EXACT_ANCHOR_ID &&
                isV08CampaignPostA13StrengthQualified(row, exactAnchor);
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

function validationSelectionEvidenceSha256(
    manifest: IManifest,
    checkpoint: ICheckpoint,
    rows: readonly IRankedCandidate[],
): string {
    const sourceJobs = checkpoint.completed
        .filter(isV08CampaignValidationSelectionSourceJob)
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((job) => {
            validateResultArtifact(manifest, job, false);
            return {
                spec: normalizedJobSpec(job),
                genomeSha256: job.genomeSha256,
                bindingSha256: job.bindingSha256,
                summarySha256: job.summarySha256,
                sourceSummarySha256: job.sourceSummarySha256,
                recordsSha256: job.recordsSha256,
            };
        });
    const rankedEvidence = [...rows]
        .sort((left, right) => left.candidateIndex - right.candidateIndex)
        .map((row) => ({
            candidateId: row.candidateId,
            candidateIndex: row.candidateIndex,
            genomeSha256: row.genomeSha256,
            tournamentGames: row.tournamentGames,
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
            postA13CoverageGames: row.postA13CoverageGames,
            postA13CandidateWins: row.postA13CandidateWins,
            postA13OpponentWins: row.postA13OpponentWins,
            postA13Draws: row.postA13Draws,
            postA13CoverageEvidenceSha256: row.postA13CoverageEvidenceSha256,
            postA13ArmageddonReached: row.postA13ArmageddonReached,
            postA13ArmageddonDecided: row.postA13ArmageddonDecided,
            hasPostA13CoverageEvidence: row.hasPostA13CoverageEvidence,
            postA13CoveragePassed: row.postA13CoveragePassed,
            postA13SpellExercisePassed: row.postA13SpellExercisePassed,
            allUnitCoverageGames: row.allUnitCoverageGames,
            hasAllUnitCoverageEvidence: row.hasAllUnitCoverageEvidence,
            allUnitCoveragePassed: row.allUnitCoveragePassed,
            allUnitCoverageEvidenceSha256: row.allUnitCoverageEvidenceSha256,
            allUnitQualificationGames: row.allUnitQualificationGames,
            hasAllUnitQualificationEvidence: row.hasAllUnitQualificationEvidence,
            allUnitQualificationPassed: row.allUnitQualificationPassed,
            allUnitQualificationEvidenceSha256: row.allUnitQualificationEvidenceSha256,
            postA13UnitOutcomes: row.postA13UnitOutcomes,
        }));
    return fingerprintV08AlignedV1({
        version: V08_CAMPAIGN_SELECTION_VERSION,
        manifestFingerprint: manifest.fingerprint,
        sourceJobs,
        rankedEvidence,
    });
}

function buildValidationSelection(
    manifest: IManifest,
    checkpoint: ICheckpoint,
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
        schema: "hoc.v0_8_aggressive_validation_selection.v3" as const,
        version: V08_CAMPAIGN_SELECTION_VERSION as typeof V08_CAMPAIGN_SELECTION_VERSION,
        manifestFingerprint: manifest.fingerprint,
        sourceEvidenceSha256: validationSelectionEvidenceSha256(manifest, checkpoint, rows),
        exactAnchorCandidateId: V08_CAMPAIGN_EXACT_ANCHOR_ID,
        exactAnchorGenomeSha256: V08_A13_GENOME_SHA256,
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
    checkpoint: ICheckpoint,
    rows: readonly IRankedCandidate[],
): void {
    assertValidationSelectionHeader(selection, manifest);
    const expectedIds = selectValidationCandidateIds(rows, manifest.config.topCandidates);
    const rowsById = new Map(rows.map((row) => [row.candidateId, row]));
    const expectedHashes = selection.candidateIds.map((id) => rowsById.get(id)?.genomeSha256);
    if (
        selection.sourceEvidenceSha256 !== validationSelectionEvidenceSha256(manifest, checkpoint, rows) ||
        fingerprintV08AlignedV1(selection.candidateIds) !== fingerprintV08AlignedV1(expectedIds) ||
        expectedHashes.some((hash) => hash === undefined) ||
        fingerprintV08AlignedV1(selection.candidateGenomeSha256) !== fingerprintV08AlignedV1(expectedHashes) ||
        selection.candidateIds.some((id) => {
            const row = rowsById.get(id);
            return (
                !row?.hasLevel4Evidence ||
                !row.level4CoveragePassed ||
                !row.hasPostA13CoverageEvidence ||
                !row.postA13CoveragePassed ||
                !row.hasAllUnitCoverageEvidence ||
                !row.allUnitCoveragePassed ||
                !row.hasAllUnitQualificationEvidence ||
                !row.allUnitQualificationPassed ||
                (!V08_CAMPAIGN_INACTIVE_CONTROL_IDS.some((controlId) => controlId === id) &&
                    !row.postA13SpellExercisePassed)
            );
        })
    ) {
        throw new Error("Persisted validation selection no longer matches its committed source evidence");
    }
}

function baseParentEvidenceSha256(manifest: IManifest, checkpoint: ICheckpoint): string {
    const relevant = checkpoint.completed.filter(
        (job) =>
            job.candidateIndex < BASE_CANDIDATE_COUNT &&
            (job.kind === "screen" || job.kind === "post_a13_coverage" || job.kind === "all_unit_coverage"),
    );
    if (relevant.length !== BASE_CANDIDATE_COUNT * 3) {
        throw new Error(
            `Adaptive generation requires screen, post-A13, and exact all-unit evidence for all ${BASE_CANDIDATE_COUNT} base candidates`,
        );
    }
    const byCandidate = new Map<
        string,
        { screen?: ICompletedJob; coverage?: ICompletedJob; allUnitCoverage?: ICompletedJob }
    >();
    for (const job of relevant) {
        const pair = byCandidate.get(job.candidateId) ?? {};
        if (job.kind === "screen") {
            if (pair.screen) throw new Error(`Duplicate base screen evidence for ${job.candidateId}`);
            pair.screen = job;
        } else if (job.kind === "post_a13_coverage") {
            if (pair.coverage) throw new Error(`Duplicate base post-A13 evidence for ${job.candidateId}`);
            pair.coverage = job;
        } else {
            if (pair.allUnitCoverage) throw new Error(`Duplicate base all-unit evidence for ${job.candidateId}`);
            pair.allUnitCoverage = job;
        }
        byCandidate.set(job.candidateId, pair);
    }
    const rows = manifest.candidates.map((candidate) => {
        const pair = byCandidate.get(candidate.id);
        const screen = pair?.screen;
        const coverage = pair?.coverage;
        const allUnitCoverage = pair?.allUnitCoverage;
        if (
            !screen ||
            !coverage ||
            !allUnitCoverage ||
            screen.id !== `screen-${candidate.id}` ||
            coverage.id !== `post-a13-coverage-${candidate.id}` ||
            allUnitCoverage.id !== `all-unit-coverage-${candidate.id}` ||
            screen.candidateIndex !== candidate.index ||
            coverage.candidateIndex !== candidate.index ||
            allUnitCoverage.candidateIndex !== candidate.index ||
            screen.genomeSha256 !== candidate.genomeSha256 ||
            coverage.genomeSha256 !== candidate.genomeSha256 ||
            allUnitCoverage.genomeSha256 !== candidate.genomeSha256 ||
            screen.bindingSha256 !== candidate.bindingSha256 ||
            coverage.bindingSha256 !== candidate.bindingSha256 ||
            allUnitCoverage.bindingSha256 !== candidate.bindingSha256 ||
            screen.games !== manifest.config.screenGames ||
            screen.baseSeed !== manifest.config.screenSeed ||
            coverage.pairsPerLane !== manifest.config.coveragePairsPerLane ||
            coverage.baseSeed !== manifest.config.coverageSeed ||
            allUnitCoverage.pairsPerMap !== manifest.config.allUnitPairsPerMap ||
            allUnitCoverage.baseSeed !== manifest.config.allUnitSeed
        ) {
            throw new Error(`Base parent evidence for ${candidate.id} has invalid provenance`);
        }
        validateResultArtifact(manifest, screen, false);
        validateResultArtifact(manifest, coverage, false);
        validateResultArtifact(manifest, allUnitCoverage, false);
        return {
            candidateId: candidate.id,
            candidateIndex: candidate.index,
            genomeSha256: candidate.genomeSha256,
            bindingSha256: candidate.bindingSha256,
            screen: {
                games: screen.games,
                baseSeed: screen.baseSeed,
                summarySha256: screen.summarySha256,
            },
            postA13Coverage: {
                pairsPerLane: coverage.pairsPerLane,
                games: jobWorkUnits(coverage),
                baseSeed: coverage.baseSeed,
                summarySha256: coverage.summarySha256,
            },
            allUnitCoverage: {
                pairsPerMap: allUnitCoverage.pairsPerMap,
                games: jobWorkUnits(allUnitCoverage),
                baseSeed: allUnitCoverage.baseSeed,
                summarySha256: allUnitCoverage.summarySha256,
            },
        };
    });
    return fingerprintV08AlignedV1({
        kind: "adaptive-base-parent-evidence",
        manifestFingerprint: manifest.fingerprint,
        rows,
    });
}

function selectBaseAdaptiveParents(manifest: IManifest, checkpoint: ICheckpoint): IRankedCandidate[] {
    const baseRows = collectLeaderboard(manifest, checkpoint, null, {
        kinds: new Set<JobKind>(["screen", "post_a13_coverage", "all_unit_coverage"]),
        outputName: "base-parent-leaderboard.json",
    });
    if (baseRows.length !== BASE_CANDIDATE_COUNT) {
        throw new Error(`Adaptive generation requires ${BASE_CANDIDATE_COUNT} complete base candidates`);
    }
    const parentRows = selectV08CampaignAdaptiveParents(baseRows);
    if (parentRows.length !== ADAPTIVE_PARENT_COUNT) {
        throw new Error(`Adaptive generation requires ${ADAPTIVE_PARENT_COUNT} ranked parents`);
    }
    return parentRows;
}

function buildAdaptiveCatalog(
    manifest: IManifest,
    checkpoint: ICheckpoint,
    baseGenomes: readonly IV08AlignedV1CandidateGenome[],
): IAdaptiveCatalog {
    const parentEvidenceSha256 = baseParentEvidenceSha256(manifest, checkpoint);
    const parentRows = selectBaseAdaptiveParents(manifest, checkpoint);
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
        exactAnchorGenomeSha256: V08_A13_GENOME_SHA256,
        exactAnchorMutationFields,
        exactAnchorMutationPlanSha256,
        parentEvidenceSha256,
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
    const expectedEvidence = baseParentEvidenceSha256(manifest, checkpoint);
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
        adaptive.exactAnchorGenomeSha256 !== V08_A13_GENOME_SHA256 ||
        !Array.isArray(adaptive.exactAnchorMutationFields) ||
        adaptive.exactAnchorMutationFields.some((field) => typeof field !== "string" || !field) ||
        !/^[a-f0-9]{64}$/.test(adaptive.exactAnchorMutationPlanSha256) ||
        adaptive.parentEvidenceSha256 !== expectedEvidence ||
        adaptive.childTarget !== ADAPTIVE_CHILD_TARGET ||
        adaptive.children.length !== ADAPTIVE_CHILD_TARGET ||
        adaptive.parentCandidateIds.length !== ADAPTIVE_PARENT_COUNT ||
        adaptive.parentGenomeSha256.length !== ADAPTIVE_PARENT_COUNT ||
        adaptive.fingerprint !== fingerprintV08AlignedV1({ ...adaptive, fingerprint: undefined })
    ) {
        throw new Error("Adaptive catalog header, evidence, or fingerprint is invalid");
    }
    const expectedParents = selectBaseAdaptiveParents(manifest, checkpoint);
    if (
        fingerprintV08AlignedV1(expectedParents.map(({ candidateId }) => candidateId)) !==
            fingerprintV08AlignedV1(adaptive.parentCandidateIds) ||
        fingerprintV08AlignedV1(expectedParents.map(({ genomeSha256 }) => genomeSha256)) !==
            fingerprintV08AlignedV1(adaptive.parentGenomeSha256)
    ) {
        throw new Error("Adaptive catalog parents do not match the committed base parent evidence");
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
        throw new Error("Adaptive catalog children do not match generator v7's deterministic mutation plan");
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
            parentEvidenceSha256: adaptive.parentEvidenceSha256,
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
        checkpoint.adaptiveCatalog.parentEvidenceSha256 !== adaptive.parentEvidenceSha256 ||
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
    assertManifestSourceIdentityCurrent(manifest);
    const directory = join(manifest.output, "jobs", spec.id);
    const resultPath = join(directory, "result.json");
    mkdirSync(directory, { recursive: true });
    const auditPath = join(directory, "search-audit.jsonl");
    const environment = buildV08CampaignChildEnvironment(
        manifest.childEnvironmentPolicy,
        candidate.binding,
        auditPath,
        manifest.config.unboundedSearch,
    );
    const logPath = join(manifest.output, "logs", `${spec.id}.log`);
    const isAllUnitJob = spec.kind === "all_unit_coverage" || spec.kind === "all_unit_qualification";
    const isDecisionQualityJob = spec.kind === "passive_qualification" || spec.kind === "block_center_qualification";
    const isCoverageJob =
        spec.kind === "level4" || spec.kind === "post_a13_coverage" || isAllUnitJob || isDecisionQualityJob;
    const runner =
        spec.kind === "level4"
            ? LEVEL4_RUNNER
            : spec.kind === "post_a13_coverage"
              ? POST_A13_COVERAGE_RUNNER
              : isAllUnitJob
                ? ALL_UNIT_COVERAGE_RUNNER
                : spec.kind === "passive_qualification"
                  ? PASSIVE_TURN_QUALIFICATION_RUNNER
                  : spec.kind === "block_center_qualification"
                    ? BLOCK_CENTER_QUALIFICATION_RUNNER
                    : TOURNAMENT_RUNNER;
    const args =
        spec.kind === "passive_qualification"
            ? [
                  runner,
                  "--candidate",
                  "v0.8s",
                  "--opponent",
                  "v0.7",
                  "--games",
                  String(spec.games),
                  "--seed",
                  String(spec.baseSeed),
                  "--concurrency",
                  String(manifest.config.workersPerJob),
                  "--out-dir",
                  directory,
                  "--min-appearances",
                  String(manifest.config.passiveQualificationMinCreatureAppearances),
                  "--source-commit",
                  manifest.sourceIdentity.gitHead,
                  "--inherit-candidate-environment",
              ]
            : spec.kind === "block_center_qualification"
              ? [
                    runner,
                    "--candidate",
                    "v0.8s",
                    "--opponent",
                    "v0.7",
                    "--games",
                    String(spec.games),
                    "--seed",
                    String(spec.baseSeed),
                    "--concurrency",
                    String(manifest.config.workersPerJob),
                    "--out-dir",
                    directory,
                    "--source-commit",
                    manifest.sourceIdentity.gitHead,
                    "--inherit-candidate-environment",
                ]
              : isAllUnitJob
                ? [
                      runner,
                      "v0.8s",
                      "v0.7",
                      String(spec.pairsPerMap),
                      String(spec.baseSeed),
                      directory,
                      String(manifest.config.workersPerJob),
                      manifest.sourceIdentity.gitHead,
                  ]
                : isCoverageJob
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
        status = await runChild(
            args,
            environment,
            logPath,
            manifest.deadlineAtMs,
            (pid) => {
                const active = checkpoint.activeJobs[spec.id];
                if (active?.startedAtMs === startedAtMs) {
                    active.pid = pid;
                    saveCheckpoint(manifest, checkpoint);
                }
            },
            isAllUnitJob || isDecisionQualityJob,
        );
    } finally {
        delete checkpoint.activeJobs[spec.id];
        saveCheckpoint(manifest, checkpoint);
    }
    if (status === "deadline") {
        return false;
    }
    // A pre-spawn check prevents mixed revisions between jobs; the matching post-exit check also rejects a
    // child whose source tree or Bun runtime changed while it was executing.
    assertManifestSourceIdentityCurrent(manifest);
    const absoluteSummary = latestSummary(directory);
    const absoluteRecords = latestJobRecords(directory, spec.kind);
    const rawSummary = readJson<unknown>(absoluteSummary);
    const summary = isCoverageJob
        ? rawSummary
        : {
              ...(rawSummary as ITournamentSummary),
              ...armageddonEvidence(absoluteRecords),
          };
    if (!isCoverageJob) tournamentSummary(summary, absoluteSummary);
    const completedAtMs = Date.now();
    const job: ICompletedJob = {
        ...spec,
        genomeSha256: candidate.genomeSha256,
        bindingSha256: candidate.bindingSha256,
        summaryPath: relative(manifest.output, absoluteSummary),
        summarySha256: fingerprintV08AlignedV1(summary),
        sourceSummarySha256: artifactSha256(absoluteSummary),
        recordsPath: relative(manifest.output, absoluteRecords),
        recordsSha256: artifactSha256(absoluteRecords),
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

async function runCampaign(cli: ICli): Promise<void> {
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
    const publishFinalEvidence = (): void => {
        checkpoint.phase = "complete";
        saveCheckpoint(manifest, checkpoint);
        collectLeaderboard(manifest, checkpoint, adaptive);
        console.log(`Final leaderboard: ${join(manifest.output, "leaderboard.json")}`);
    };
    const finishIncompletePhase = (): void => {
        if (Date.now() >= manifest.deadlineAtMs || !stopRequested) publishFinalEvidence();
    };
    if (Date.now() >= manifest.deadlineAtMs) {
        console.log("Campaign wall deadline already reached; reconciling completed artifacts without new launches.");
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
        if (!ok) {
            finishIncompletePhase();
            return;
        }
    }

    // Every base arm sees every post-A13 creature before adaptive parents are chosen. Otherwise a parent can win
    // the random screen while never exercising Dryad, Zena, Monk, Magic Dragon, or their new spell semantics.
    checkpoint.phase = "post_a13_coverage";
    saveCheckpoint(manifest, checkpoint);
    {
        const specs: IJobSpec[] = baseBindings.map((_binding, index) => ({
            id: `post-a13-coverage-${candidateId(index)}`,
            kind: "post_a13_coverage" as const,
            candidateId: candidateId(index),
            candidateIndex: index,
            pairsPerLane: manifest.config.coveragePairsPerLane,
            baseSeed: manifest.config.coverageSeed,
        }));
        const ok = await runJobQueue(manifest, checkpoint, registry, adaptive, specs);
        if (!ok) {
            finishIncompletePhase();
            return;
        }
    }

    // The post-A13 panel exercises new spell kits deeply; this orthogonal deterministic panel fails closed
    // unless every enabled creature is productive and rejection-free on both ownership sides, all live maps,
    // and both physical seats. Its outcomes are qualification evidence only and never enter research fitness.
    checkpoint.phase = "all_unit_coverage";
    saveCheckpoint(manifest, checkpoint);
    {
        const specs: IJobSpec[] = baseBindings.map((_binding, index) => ({
            id: `all-unit-coverage-${candidateId(index)}`,
            kind: "all_unit_coverage" as const,
            candidateId: candidateId(index),
            candidateIndex: index,
            pairsPerMap: manifest.config.allUnitPairsPerMap,
            baseSeed: manifest.config.allUnitSeed,
        }));
        const ok = await runJobQueue(manifest, checkpoint, registry, adaptive, specs);
        if (!ok) {
            finishIncompletePhase();
            return;
        }
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
        if (!ok) {
            finishIncompletePhase();
            return;
        }
    }

    // Adaptive children receive the identical common-random creature panel before any reserve is selected.
    checkpoint.phase = "post_a13_coverage";
    saveCheckpoint(manifest, checkpoint);
    {
        const specs: IJobSpec[] = adaptive.children.map((child) => ({
            id: `post-a13-coverage-${child.id}`,
            kind: "post_a13_coverage" as const,
            candidateId: child.id,
            candidateIndex: child.index,
            pairsPerLane: manifest.config.coveragePairsPerLane,
            baseSeed: manifest.config.coverageSeed,
        }));
        const ok = await runJobQueue(manifest, checkpoint, registry, adaptive, specs);
        if (!ok) {
            finishIncompletePhase();
            return;
        }
    }

    checkpoint.phase = "all_unit_coverage";
    saveCheckpoint(manifest, checkpoint);
    {
        const specs: IJobSpec[] = adaptive.children.map((child) => ({
            id: `all-unit-coverage-${child.id}`,
            kind: "all_unit_coverage" as const,
            candidateId: child.id,
            candidateIndex: child.index,
            pairsPerMap: manifest.config.allUnitPairsPerMap,
            baseSeed: manifest.config.allUnitSeed,
        }));
        const ok = await runJobQueue(manifest, checkpoint, registry, adaptive, specs);
        if (!ok) {
            finishIncompletePhase();
            return;
        }
    }

    const preLevel4 = collectLeaderboard(manifest, checkpoint, adaptive, {
        kinds: new Set<JobKind>(["screen", "adaptive", "post_a13_coverage", "all_unit_coverage"]),
        outputName: "pre-level4-leaderboard.json",
    });
    const preLevel4Eligible = preLevel4.filter(isV08CampaignPostA13SelectionEligible);
    const level4ReserveTarget = Math.min(
        preLevel4Eligible.length,
        manifest.config.topCandidates * manifest.adaptive.level4ReserveMultiplier,
    );
    // A zero count in a 256-game screen cannot establish the 0.1% target. Cover a fixed research-ranked reserve,
    // then let repeated fresh validation determine Armageddon safety without lucky-zero admission bias.
    const preLevel4ById = new Map(preLevel4Eligible.map((row) => [row.candidateId, row]));
    const level4Queue = selectV08CampaignLevel4CandidateIds(preLevel4Eligible, level4ReserveTarget).map((id) => {
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
        if (!ok) {
            finishIncompletePhase();
            return;
        }
    }

    // Persist the complete deep reserve through the deterministic level-4 selection, then reserve enough
    // makespan for every pending all-unit qualification job before launching any of them. A deadline cannot
    // leave a selectively qualified shortlist whose membership depends on queue order.
    checkpoint.phase = "all_unit_qualification";
    saveCheckpoint(manifest, checkpoint);
    {
        const specs: IJobSpec[] = level4Queue.map((row) => ({
            id: `all-unit-qualification-${row.candidateId}`,
            kind: "all_unit_qualification" as const,
            candidateId: row.candidateId,
            candidateIndex: row.candidateIndex,
            pairsPerMap: manifest.config.allUnitQualificationPairsPerMap,
            baseSeed: manifest.config.allUnitQualificationSeed,
        }));
        for (const spec of specs) reconcileJobResult(manifest, checkpoint, registry, spec);
        const completedIds = new Set(checkpoint.completed.map(({ id }) => id));
        const pending = specs.filter(({ id }) => !completedIds.has(id));
        const estimatedDurationMs = estimateDynamicQueueDurationMs(
            pending,
            checkpoint.completed,
            manifest.config.workersPerJob,
            manifest.config.lanes,
        );
        if (
            pending.length > 0 &&
            Date.now() + estimatedDurationMs + ADMISSION_SAFETY_MARGIN_MS > manifest.deadlineAtMs
        ) {
            appendFileSync(
                join(manifest.output, "logs", "orchestrator.jsonl"),
                `${JSON.stringify({
                    at: new Date().toISOString(),
                    event: "all-unit-qualification-admission-deferred",
                    schedulerVersion: V08_CAMPAIGN_SCHEDULER_VERSION,
                    jobIds: pending.map(({ id }) => id),
                    estimatedDurationMs,
                    safetyMarginMs: ADMISSION_SAFETY_MARGIN_MS,
                    deadlineAtMs: manifest.deadlineAtMs,
                })}\n`,
            );
            console.log(
                `[defer] complete all-unit qualification reserve needs about ${Math.ceil(estimatedDurationMs / 1_000)}s`,
            );
            finishIncompletePhase();
            return;
        }
        const ok = await runJobQueue(manifest, checkpoint, registry, adaptive, specs, {
            admissionReserved: true,
        });
        if (!ok) {
            finishIncompletePhase();
            return;
        }
    }

    const validationSelectionSource = collectLeaderboard(manifest, checkpoint, adaptive, {
        kinds: VALIDATION_SELECTION_SOURCE_KINDS,
        outputName: "validation-selection-source-leaderboard.json",
    });

    leaderboard = collectLeaderboard(manifest, checkpoint, adaptive);
    if (checkpoint.validationSelection === null) {
        checkpoint.validationSelection = buildValidationSelection(
            manifest,
            checkpoint,
            validationSelectionSource,
            manifest.config.topCandidates,
        );
        saveCheckpoint(manifest, checkpoint);
    } else {
        validateValidationSelection(checkpoint.validationSelection, manifest, checkpoint, validationSelectionSource);
    }
    const validationSelection = checkpoint.validationSelection;
    if (validationSelection === null) throw new Error("Validation selection was not persisted");

    // Strength selection is frozen before this phase, so these diagnostics cannot improve research rank or
    // change shortlist membership. Every finalist must nevertheless complete both source-bound panels before
    // validation starts: the passive counterfactual proves that retained waits/Luck Shields/mountain turns did
    // not hide a better productive action, while the independent BLOCK_CENTER oracle detects legal combat that
    // the production candidate catalog or pathing policy omitted. Failed gates remain committed evidence and
    // block promotion; they do not disappear merely because the child exits with its qualification status.
    checkpoint.phase = "decision_quality_qualification";
    saveCheckpoint(manifest, checkpoint);
    {
        const selectedRows = new Map(leaderboard.map((row) => [row.candidateId, row]));
        const specs: IJobSpec[] = validationSelection.candidateIds.flatMap((candidateId) => {
            const row = selectedRows.get(candidateId);
            if (!row) throw new Error(`Decision-quality candidate ${candidateId} is missing from the leaderboard`);
            return [
                {
                    id: `passive-qualification-${candidateId}`,
                    kind: "passive_qualification" as const,
                    candidateId,
                    candidateIndex: row.candidateIndex,
                    games: manifest.config.passiveQualificationGames,
                    baseSeed: manifest.config.passiveQualificationSeed,
                },
                {
                    id: `block-center-qualification-${candidateId}`,
                    kind: "block_center_qualification" as const,
                    candidateId,
                    candidateIndex: row.candidateIndex,
                    games: manifest.config.blockCenterQualificationGames,
                    baseSeed: manifest.config.blockCenterQualificationSeed,
                },
            ];
        });
        for (const spec of specs) reconcileJobResult(manifest, checkpoint, registry, spec);
        const completedIds = new Set(checkpoint.completed.map(({ id }) => id));
        const pending = specs.filter(({ id }) => !completedIds.has(id));
        const estimatedDurationMs = estimateDynamicQueueDurationMs(
            pending,
            checkpoint.completed,
            manifest.config.workersPerJob,
            manifest.config.lanes,
        );
        if (
            pending.length > 0 &&
            Date.now() + estimatedDurationMs + ADMISSION_SAFETY_MARGIN_MS > manifest.deadlineAtMs
        ) {
            appendFileSync(
                join(manifest.output, "logs", "orchestrator.jsonl"),
                `${JSON.stringify({
                    at: new Date().toISOString(),
                    event: "decision-quality-qualification-admission-deferred",
                    schedulerVersion: V08_CAMPAIGN_SCHEDULER_VERSION,
                    jobIds: pending.map(({ id }) => id),
                    estimatedDurationMs,
                    safetyMarginMs: ADMISSION_SAFETY_MARGIN_MS,
                    deadlineAtMs: manifest.deadlineAtMs,
                })}\n`,
            );
            console.log(
                `[defer] complete decision-quality qualification needs about ${Math.ceil(estimatedDurationMs / 1_000)}s`,
            );
            finishIncompletePhase();
            return;
        }
        const ok = await runJobQueue(manifest, checkpoint, registry, adaptive, specs, {
            admissionReserved: true,
        });
        if (!ok) {
            finishIncompletePhase();
            return;
        }
    }

    checkpoint.phase = "validation";
    saveCheckpoint(manifest, checkpoint);
    let validationLaunchesAllowed = true;
    for (;;) {
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
        const roundState = classifyV08CampaignValidationRoundState({
            pendingJobs: pending.length,
            nowMs: Date.now(),
            deadlineAtMs: manifest.deadlineAtMs,
            stop: stopRequested,
            launchesAllowed: validationLaunchesAllowed,
        });
        if (roundState === "commit") {
            // This atomic checkpoint advance is the evidence barrier. Until it succeeds, collectLeaderboard
            // excludes every result in this round, so completion skew, shutdown, or resume cannot favor one arm.
            checkpoint.validationRound += 1;
            saveCheckpoint(manifest, checkpoint);
            collectLeaderboard(manifest, checkpoint, adaptive);
            if (Date.now() >= manifest.deadlineAtMs || stopRequested || !validationLaunchesAllowed) break;
            continue;
        }
        if (roundState === "stop") break;
        if (
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
            validationLaunchesAllowed = false;
            continue;
        }
        const ok = await runJobQueue(manifest, checkpoint, registry, adaptive, roundSpecs, {
            admissionReserved: true,
        });
        if (!ok) validationLaunchesAllowed = false;
    }
    if (Date.now() >= manifest.deadlineAtMs || !stopRequested) publishFinalEvidence();
}

async function main(): Promise<void> {
    const cli = parseV08CampaignCli(process.argv.slice(2));
    const lease = acquireV08CampaignOutputLease(cli.output);
    try {
        await runCampaign(cli);
    } finally {
        lease.release();
    }
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
