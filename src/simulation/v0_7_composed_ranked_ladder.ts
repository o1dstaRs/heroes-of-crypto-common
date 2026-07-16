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
import {
    closeSync,
    existsSync,
    fsyncSync,
    lstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    statSync,
    unlinkSync,
    writeSync,
    writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { arch, availableParallelism, cpus, homedir, hostname, platform, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";

import { LEAGUE_ROUND1_DRAFT_SPEC } from "../ai/setup/draft_ship";
import { conditionalAugments, conditionalSynergies, parseConditionalRules } from "../ai/setup/setup_conditional";
import { SETUP_POLICY_V0 } from "../ai/setup/setup_v0";
import { FightStateManager } from "../fights/fight_state_manager";
import { PBTypes } from "../generated/protobuf/v1/types";
import { getUpgradePoints } from "../perks/perk_properties";
import type { Side } from "./battle_engine";
import { runMatch, type IMatchConfig, type IMatchResult, type IRecordedAction } from "./battle_engine";
import { creatureIdForName } from "./draft";
import {
    pairedClusterEstimate,
    runRankedConditionalPickGame,
    shippedLeagueGenome,
    type IConditionalArmy,
    type ISetupConditionalPairMoments,
} from "./measure_setup_conditional";
import {
    V07_ARCHETYPES,
    V07_ARCHETYPE_TAXONOMY,
    V07_ARCHETYPE_TEMPLATE_NAMES,
    rosterSignature,
    v07ArchetypeTemplate,
    type V07Archetype,
    type V07ArchetypeTemplateName,
} from "./v0_7_archetype_battery";
import {
    expandV07ComposedDerivedProtocolSchedules,
    expandV07ComposedDerivedTournamentSchedules,
    fingerprintV07ComposedDerivedProtocolSchedules,
    fingerprintV07ComposedDerivedTournamentSchedules,
    fingerprintV07ComposedSeedSet,
    V07_COMPOSED_SEED_SCAN_POLICY,
    type IV07ComposedDerivedProtocolSchedule,
    type IV07ComposedDerivedTournamentSchedule,
} from "./v0_7_composed_seed_scan";

/**
 * Frozen, composed-ranked v0.7s qualification battery.
 *
 * This is measurement-only: v0.7s is a byte-policy alias for v0.7 whose version string lets SearchDriver
 * target only the candidate seat. One pick is generated per pair. Even games put the candidate on LOWER /
 * green and odd games put it on UPPER / red; the physical armies are never swapped or re-drafted.
 */

export type V07ComposedProfileId = "off" | "uncapped" | "server_300" | "conservative_200_275";
export type V07ComposedDistribution = "ranked_round1" | "ranked_taxonomy" | "fixed_template";
export type V07ComposedScenarioProtocol = "fixed_physical_side_swap" | "independent_seat_conditioned";
export type V07ComposedCandidateSeat = "candidate_green" | "candidate_red";

export const V07_COMPOSED_MAX_CELL_ELAPSED_MS = 6 * 60 * 60 * 1000;
export const V07_COMPOSED_MAX_RUN_ELAPSED_MS = 24 * 60 * 60 * 1000;

export interface IV07ComposedTaxonomySeatPlanSummary {
    streams: number;
    totalAttempts: number;
    meanAttempt: number;
    totalProposals: number;
    meanProposals: number;
    maxAttempt: number;
    acceptedAttemptHistogram: Record<string, number>;
}

export interface IV07ComposedTaxonomyPlanSummary {
    rows: 8000;
    sha256: string;
    cells: Record<
        string,
        {
            pairs: 1000;
            candidate_green: IV07ComposedTaxonomySeatPlanSummary;
            candidate_red: IV07ComposedTaxonomySeatPlanSummary;
        }
    >;
}

export interface IV07ComposedSeedCollisionResolution {
    label: string;
    kind: "protected" | "setup_proposal";
    mainOrdinal: number;
    originalSeed: number;
    inLocal: boolean;
    inZinc: boolean;
    remapOrdinal: number;
    remappedSeed: number;
}

export interface IV07ComposedSearchProfile {
    id: V07ComposedProfileId;
    search: boolean;
    gate: number;
    horizon: number;
    rollouts: number;
    includeMoves: false;
    maxMoves: 1;
    maxMelee: 8;
    maxShots: 6;
    maxThrows: 4;
    activeChallengers: false;
    shortlist: null;
    decisionDeadlineMs: number | null;
    circuitBreakerMs: number | null;
    leaf: "learned";
    opponentModel: null;
    lateRangedFinishWeight: 0;
    pureRangedTerminalWeight: 0;
    qualification: boolean;
    parityNote: string;
}

export interface IV07ComposedCell {
    id: string;
    stage: number;
    distribution: V07ComposedDistribution;
    scenarioProtocol: V07ComposedScenarioProtocol;
    archetype?: V07Archetype;
    template?: V07ArchetypeTemplateName;
    profile: V07ComposedProfileId;
    candidate: "v0.7s";
    opponent: "v0.6" | "v0.7";
    games: number;
    pairScenarios: number;
    baseSeed: number;
    qualification: boolean;
    purpose: string;
}

export interface IV07ComposedConcurrentGuardBinding {
    guardId: string;
    contractPath: string;
    contractSha256: string;
    initialSnapshotPath: string;
    initialSnapshotSha256: string;
    prelaunchCheckpoint: {
        ledgerPath: string;
        ledgerSha256: string;
        entries: number;
        firstCapturedAt: string;
        lastCapturedAt: string;
    };
    activeCemClosure: {
        scheduleId: "zinc-active-fight58b-preregistered-reservation-envelope-iterations-1-through-64-passes-1-through-8";
        scheduleSha256: "31adcb7ecea9eece8d863271365d22bf5fbe235172263d5078f11593705caa32";
        uniqueSeeds: 9616000;
        seedSetSha256: "28a48d2012d95d17c38884f0ce0ee20ed6470ca83fa6e0838a167aa61aff988d";
    };
    remote: { host: "puffalo.tailbe7bef.ts.net"; user: "agent-zinc"; port: 2222 };
    sealBefore: string;
    guardIntervalMs: 60000;
    maxGuardGapMs: 90000;
    finalWindowMs: 300000;
}

export interface IV07ComposedManifest {
    schemaVersion: 1;
    manifestId: string;
    createdAt: string;
    status: "research_only_no_bake";
    estimand: string;
    candidate: "v0.7s";
    rankedOpponent: "v0.6";
    seedPermutation: {
        domain: string;
        nonce: number;
        construction: "sha256_parameterized_affine_uint32_bijection_with_collision_remaps";
        offset: number;
        oddStep: number;
    };
    draft: {
        spec: string;
        setupRules: "all";
        setupAppliedTo: "both_teams";
        persistedPickOrder: true;
        fixedCellsOnePickPerScenario: true;
        fixedCellsPhysicalArmiesFixedWithinSideSwap: true;
        taxonomyCellsIndependentSeatConditioned: true;
        taxonomyCandidateTraitMinimum: 1;
        taxonomyMaxSetupAttemptsPerSeat: 128;
        taxonomySha256: string;
        taxonomyPlan: IV07ComposedTaxonomyPlanSummary;
        candidateSide: "even_lower_green_odd_upper_red";
        seedDerivation: "sha256_parameterized_affine_uint32_bijection_distinct_slots_no_independence_claim";
        setupAndCombatSubSeedsSeparated: true;
    };
    searchProfiles: Record<V07ComposedProfileId, IV07ComposedSearchProfile>;
    cells: IV07ComposedCell[];
    execution: {
        pairScenarios: number;
        games: number;
        searchGames: number;
        offControlGames: number;
        requiredConcurrency: 12;
        staging: "one_cell_per_invocation_then_fail_closed_assembly";
        stagePolicy: "fixed_full_battery_chronology_not_outcome_adaptive";
        allCellsRequiredAfterOutcomeFailure: true;
        priorIntegrityOrControlFailureBlocks: true;
        maxCellElapsedMs: number;
        maxRunElapsedMs: number;
        estimatedRuntime: { m4Max: string; zinc: string; basis: string };
    };
    gates: {
        qualificationSeatWilsonLow: number;
        minimumSeatDecisiveFraction: number;
        maxSeatDrawOrArmageddonFraction: number;
        formalFamily: "thirteen_qualification_cells_by_two_candidate_seats";
        formalMethod: "bonferroni_two_sided_wilson_by_candidate_seat";
        formalCellCount: 13;
        formalHypotheses: 26;
        nominalFamilywiseConfidence: 0.95;
        coverageCaveat: "wilson_bonferroni_is_nominal_not_exact_finite_sample_coverage";
        formalZ: number;
        engineRejections: 0;
        searchIllegalIncumbents: 0;
        maxQualificationDeadlineFallbackRate: number;
        maxQualificationCircuitOpenedGames: 0;
        maxQualificationCircuitSkippedDecisions: 0;
        rawAndAuditCompleteness: true;
        offControlExactSymmetry: true;
        automaticBake: false;
    };
    serverReference: {
        serverCommit: string;
        lockedCommonCommit: string;
        lockfilePath: "bun.lock";
        lockfileSha256: string;
        exactLiveParity: false;
        explanation: string;
        sourceSha256: Record<string, string>;
    };
    sourceProvenance: {
        originIdentity: "github.com/o1dstars/heroes-of-crypto-common";
        preregisteredCommonBaseCommit: string;
        packageJsonSha256: string;
        requiredSha256: Record<string, string>;
        runtimeTree: {
            root: "src";
            excludedPrefixes: ["src/simulation/manifests/", "src/simulation/results/"];
            files: number;
            sha256: string;
        };
    };
    runtimeProvenance: {
        bunLockPolicy: "intentionally_absent_bind_exact_installed_manifests";
        cleanOrdinaryUntrackedRequired: true;
        outputOutsideRepositoryRequired: true;
        forbiddenConfigPaths: ["bunfig.toml", "bunfig.local.toml", ".bunfig.toml"];
        forbiddenHomeConfigPaths: [".bunfig.toml", ".config/bunfig.toml", ".config/bun/bunfig.toml"];
        forbiddenEnvironmentKeys: string[];
        requiredEnvironment: { BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0"; V07_COMPOSED_HOST_IDLE_ATTESTATION: "1" };
        bun: { version: string; revision: string; executableSha256: string };
        dependencies: Record<
            "denque" | "google-protobuf",
            {
                version: string;
                packageJsonPath: string;
                packageJsonSha256: string;
                entryPath: string;
                entrySha256: string;
                treeFiles: number;
                treeSha256: string;
            }
        >;
    };
    seedAudit: {
        derivation: string;
        permutationNonce: number;
        logicalSlotLayout: string;
        ordinalOverrides: Record<string, number>;
        collisionResolutions: IV07ComposedSeedCollisionResolution[];
        performedAt: string;
        plannedPairScenarios: number;
        reservedDerivedSeedTokens: number;
        reservedEnvelopeSha256: string;
        internalCollisions: 0;
        externalFreshnessScope: "all_registered_scenario_setup_and_combat_seeds";
        scanPolicy: typeof V07_COMPOSED_SEED_SCAN_POLICY;
        excludedRelativePaths: string[];
        knownReservedSeedsVerified: [386585164, 1955955948];
        local: {
            scannerSourcePath: string;
            scannerSourceSha256: string;
            scannerConfigPath: string;
            scannerConfigSha256: string;
            seedSetOutputPath: string;
            scannerSummaryOutputPath: string;
            commonRoot: string;
            priorManifestExpanderPath: string;
            priorManifestExpanderSha256: string;
            roots: string[];
            rootDiscovery: Array<{ parent: string; namePrefix: string }>;
            excluded: string[];
            excludedPathPrefixes: string[];
            excludedRelativeSuffixes: string[];
            cutoff: string;
            files: number;
            textFiles: number;
            structuredFiles: number;
            expandedManifests: number;
            tournamentSeries: Array<{
                id: string;
                baseSeed: number;
                streams: number;
                streamStride: number;
                gamesPerStream: number;
                pairSeedStep: number;
            }>;
            derivedTournamentSchedules: IV07ComposedDerivedTournamentSchedule[];
            derivedTournamentSchedulesSha256: string;
            derivedProtocolSchedules: IV07ComposedDerivedProtocolSchedule[];
            derivedProtocolSchedulesSha256: string;
            derivedProtocolSeedSetSha256: string;
            expandedInlineTournamentPanels: number;
            expandedInlineLeaguePanels: number;
            expandedRecoveredLedgerStreams: number;
            expandedTournamentSeeds: number;
            expandedDerivedScheduleSeeds: number;
            expandedDerivedProtocolSeeds: number;
            expandedInlineLeagueSeeds: number;
            expandedRecoveredLedgerSeeds: number;
            matchedSeedTokens: number;
            uniqueSeeds: number;
            originalCollisionLogicalSlots: number;
            collisionsAfterRemap: 0;
            corpusFileSnapshotSha256: string;
            corpusSeedSetSha256: string;
            scannerSummarySha256: string;
        };
        zinc: {
            scannerSourcePath: string;
            scannerSourceSha256: string;
            scannerConfigPath: string;
            scannerConfigSha256: string;
            seedSetOutputPath: string;
            scannerSummaryOutputPath: string;
            commonRoot: string;
            priorManifestExpanderPath: string;
            priorManifestExpanderSha256: string;
            roots: string[];
            rootDiscovery: Array<{ parent: string; namePrefix: string }>;
            excluded: string[];
            excludedPathPrefixes: string[];
            excludedRelativeSuffixes: string[];
            cutoff: string;
            files: number;
            textFiles: number;
            structuredFiles: number;
            expandedManifests: number;
            tournamentSeries: Array<{
                id: string;
                baseSeed: number;
                streams: number;
                streamStride: number;
                gamesPerStream: number;
                pairSeedStep: number;
            }>;
            derivedTournamentSchedules: IV07ComposedDerivedTournamentSchedule[];
            derivedTournamentSchedulesSha256: string;
            derivedProtocolSchedules: IV07ComposedDerivedProtocolSchedule[];
            derivedProtocolSchedulesSha256: string;
            derivedProtocolSeedSetSha256: string;
            expandedInlineTournamentPanels: number;
            expandedInlineLeaguePanels: number;
            expandedRecoveredLedgerStreams: number;
            expandedTournamentSeeds: number;
            expandedDerivedScheduleSeeds: number;
            expandedDerivedProtocolSeeds: number;
            expandedInlineLeagueSeeds: number;
            expandedRecoveredLedgerSeeds: number;
            matchedSeedTokens: number;
            uniqueSeeds: number;
            originalCollisionLogicalSlots: number;
            collisionsAfterRemap: 0;
            corpusFileSnapshotSha256: string;
            corpusSeedSetSha256: string;
            scannerSummarySha256: string;
            concurrentGuard: IV07ComposedConcurrentGuardBinding;
        };
        observedBenchmark: {
            evidencePurpose: "seed_schedule_recovery_only_reported_outcome_runtime_not_attested";
            userReported: true;
            originalExecutionPath: "src/simulation/winrate_v07_v06_tmp.ts";
            scriptEvidencePath: string;
            scriptSha256: string;
            concurrentTournamentSourcePath: "src/simulation/concurrent_tournament.ts";
            concurrentTournamentSourceSha256: string;
            tournamentWorkerSourcePath: "src/simulation/tournament_worker.ts";
            tournamentWorkerSourceSha256: string;
            tournamentSourcePath: string;
            tournamentSourceSha256: string;
            versions: ["v0.7", "v0.6"];
            cohorts: 4;
            gamesPerCohort: 25000;
            baseSeed: 100000;
            streamStride: 1000000;
            pairSeedStep: 2654435761;
            expandedPairSeeds: 50000;
            outcome: { candidateWins: 53456; opponentWins: 39487; draws: 7057 };
        };
        declaration: string;
    };
}

export interface IV07ComposedManifestProvenance {
    path: string;
    sha256: string;
}

export interface IV07ComposedActionTelemetry {
    actions: number;
    completed: number;
    byType: Record<string, number>;
}

export interface IV07ComposedGameRecord {
    schemaVersion: 1;
    manifestId: string;
    cellId: string;
    profile: V07ComposedProfileId;
    distribution: V07ComposedDistribution;
    scenarioProtocol: V07ComposedScenarioProtocol;
    archetype?: V07Archetype;
    template?: V07ArchetypeTemplateName;
    game: number;
    pair: number;
    scenarioRoot: number;
    candidateSeatStream: V07ComposedCandidateSeat;
    setupSeed: number;
    setupAttempt: number;
    combatSeed: number;
    taxonomyTraitCounts?: {
        lower: number;
        upper: number;
        candidate: number;
        opponent: number;
        lowerMembers: string[];
        upperMembers: string[];
    };
    candidateIsGreen: boolean;
    greenVersion: string;
    redVersion: string;
    physicalSetupSha256: string;
    lowerRoster: string;
    upperRoster: string;
    winner: Side | "draw";
    winnerSlot: "candidate" | "opponent" | "draw";
    laps: number;
    endReason: IMatchResult["endReason"];
    decidedByArmageddon: boolean;
    reachedArmageddon: boolean;
    rejectedGreen?: number;
    rejectedRed?: number;
    resultFingerprint: string;
    candidateActions: IV07ComposedActionTelemetry;
    opponentActions: IV07ComposedActionTelemetry;
}

export interface IV07ComposedAuditRow {
    t: "game";
    mode: "search";
    seed: number;
    green: string;
    red: string;
    winner: Side | "draw";
    endReason: IMatchResult["endReason"];
    gate: number;
    horizon: number;
    rollouts: number;
    leaf: string;
    oppModel?: string;
    decisions: number;
    searched: number;
    overrides: number;
    illegalIncumbent: number;
    shortlist: number | null;
    decisionDeadlineMs: number | null;
    deadlineFallbacks: number;
    lateRangedFinishWeight: number;
    pureRangedTerminalWeight: number;
    msTotal: number;
    circuitBreakerMs: number | null;
    circuitOpened: boolean;
    circuitSkipped: number;
}

export interface IV07ComposedCellReport {
    cell: IV07ComposedCell;
    games: number;
    pairScenarios: number;
    decisive: number;
    candidateWins: number;
    opponentWins: number;
    draws: number;
    candidateWinRate: number;
    clusteredSePp: number | null;
    confidence95: { low: number; high: number } | null;
    pairedDiagnosticApplicable: boolean;
    formalSeatEvidence: Record<V07ComposedCandidateSeat, IV07ComposedSeatEvidence>;
    pairMoments: ISetupConditionalPairMoments;
    drawOrArmageddon: number;
    drawOrArmageddonRate: number;
    endReasons: Record<string, number>;
    candidateRejections: number;
    opponentRejections: number;
    missingRejectionCounts: number;
    candidateWinsAsGreen: number;
    candidateWinsAsRed: number;
    search: {
        auditRows: number;
        decisions: number;
        searched: number;
        overrides: number;
        illegalIncumbent: number;
        deadlineFallbacks: number;
        circuitOpenedGames: number;
        circuitSkipped: number;
        deadlineFallbackRate: number;
        msTotal: number;
        msPerSearchedDecision: number | null;
        gameMs: { p50: number; p95: number; p99: number; max: number } | null;
    };
    integrity: {
        complete: boolean;
        fixedPhysicalSideSwapExact: boolean | null;
        independentSeatStreamsExact: boolean | null;
        seatConditioningExact: boolean | null;
        auditJoinedExactly: boolean;
        offControlExact: boolean;
        zeroEngineRejections: boolean;
        zeroIllegalIncumbents: boolean;
    };
    gate: {
        applicable: boolean;
        seatWilsonThreshold: number;
        minimumSeatDecisiveFraction: number;
        everySeatDecisiveFractionPassed: boolean;
        everySeatWilsonLowPassed: boolean;
        everySeatDrawOrArmageddonPassed: boolean;
        outcomePassed: boolean;
        latencyAttritionPassed: boolean;
        passed: boolean;
    };
}

export interface IV07ComposedSeatEvidence {
    games: number;
    decisive: number;
    wins: number;
    losses: number;
    draws: number;
    drawOrArmageddon: number;
    drawOrArmageddonFraction: number;
    decisiveFraction: number;
    decisiveWinRate: number | null;
    wilson: {
        method: "bonferroni_two_sided_wilson";
        hypotheses: 26;
        nominalFamilywiseConfidence: 0.95;
        z: number;
        low: number;
        high: number;
    } | null;
    decisiveFractionPassed: boolean;
    wilsonLowPassed: boolean;
    drawOrArmageddonPassed: boolean;
    passed: boolean;
}

export interface IV07ComposedWorkerAttestation {
    worker: number;
    environmentSha256: string;
    removedEnvironmentKeys: string[];
    transpilerCacheDisabled: "0";
    auditFile: string;
}

export interface IV07ComposedCellCompletion {
    schemaVersion: 1;
    manifestId: string;
    manifestSha256: string;
    cellId: string;
    startedAt: string;
    completedAt: string;
    git: ReturnType<typeof gitProvenance>;
    sourceHashesVerified: true;
    runtimeProvenanceVerified: true;
    taxonomyPlanVerified: true;
    taxonomyPlanSha256: string;
    hostLock: IV07ComposedHostLockMetadata;
    priorStageCompletions: Array<{ cellId: string; completionSha256: string }>;
    host: {
        hostname: string;
        platform: string;
        arch: string;
        cpuModel: string;
        availableParallelism: number;
        bunVersion: string;
        bunRevision: string;
        bunExecutableSha256: string;
    };
    concurrency: { requested: number; workers: number };
    profileEnvironmentSha256: string;
    raw: { path: string; sha256: string; bytes: number; rows: number };
    audits: Array<{ path: string; sha256: string; bytes: number; rows: number }>;
    workers: IV07ComposedWorkerAttestation[];
    report: IV07ComposedCellReport;
}

export function assertV07ComposedUniformExecutionEnvelope(
    completions: readonly Pick<IV07ComposedCellCompletion, "cellId" | "host" | "concurrency">[],
): void {
    if (!completions.length) throw new Error("Composed-ranked execution envelope requires completed cells");
    const expected = JSON.stringify({ host: completions[0].host, concurrency: completions[0].concurrency });
    for (const completion of completions.slice(1)) {
        const actual = JSON.stringify({ host: completion.host, concurrency: completion.concurrency });
        if (actual !== expected) {
            throw new Error(`${completion.cellId}: mixed host/runtime/concurrency execution envelope`);
        }
    }
}

export function assertV07ComposedElapsedWithin(
    startedAt: string,
    completedAt: string,
    maximumMs: number,
    label: string,
): number {
    const started = Date.parse(startedAt);
    const completed = Date.parse(completedAt);
    const elapsed = completed - started;
    if (
        !Number.isFinite(started) ||
        !Number.isFinite(completed) ||
        !Number.isSafeInteger(maximumMs) ||
        maximumMs < 1 ||
        elapsed < 0 ||
        elapsed > maximumMs
    ) {
        throw new Error(`${label}: elapsed time ${elapsed}ms exceeds the frozen ${maximumMs}ms limit`);
    }
    return elapsed;
}

/** Outcome failure never changes the battery; only corrupt/incomplete prior evidence blocks chronology. */
export function assertV07ComposedPriorStageIntegrity(
    completions: readonly Pick<IV07ComposedCellCompletion, "cellId" | "report">[],
): void {
    for (const completion of completions) {
        const { cell, integrity } = completion.report;
        const protocolIntegrity =
            cell.scenarioProtocol === "fixed_physical_side_swap"
                ? integrity.fixedPhysicalSideSwapExact === true &&
                  integrity.independentSeatStreamsExact === null &&
                  integrity.seatConditioningExact === null
                : integrity.fixedPhysicalSideSwapExact === null &&
                  integrity.independentSeatStreamsExact === true &&
                  integrity.seatConditioningExact === true;
        if (
            !integrity.complete ||
            !protocolIntegrity ||
            !integrity.auditJoinedExactly ||
            !integrity.offControlExact ||
            !integrity.zeroEngineRejections ||
            !integrity.zeroIllegalIncumbents
        ) {
            throw new Error(`${completion.cellId}: prior-stage integrity/control failure blocks the fixed battery`);
        }
    }
}

export const V07_COMPOSED_BEHAVIOR_ENV_PREFIXES = ["V04_", "V05_", "V06_", "V07_", "SEARCH_", "Q2_", "CEM_"] as const;

export const V07_COMPOSED_BEHAVIOR_ENV_EXACT = [
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
    "VALUE_DATA",
    "VALUE_DATA_FEATURES",
] as const;

const PROFILE_IDS: readonly V07ComposedProfileId[] = ["off", "uncapped", "server_300", "conservative_200_275"];

export const V07_COMPOSED_SEED_DOMAIN = "hoc-v07-composed-ranked-prereg-20260716-v2";
/** Frozen after scanning all registered root/setup/combat slots against both prior-corpus sets. */
export const V07_COMPOSED_PERMUTATION_NONCE = 0;
export const V07_COMPOSED_REMAP_ORDINAL_BASE = 1081000;
export const V07_COMPOSED_COLLIDING_MAIN_ORDINALS: readonly number[] = Object.freeze([
    41, 456, 977, 1244, 1659, 2098, 2447, 3235, 3470, 3885, 4673, 5088, 5876, 6175, 6291, 6664, 7079, 8166, 8282, 8509,
    8517, 8977, 9369, 9485, 9712, 9720, 10508, 10923, 11384, 11495, 11703, 11711, 12176, 12914, 13141, 13257, 13294,
    13297, 13543, 14344, 14759, 14849, 15547, 15685, 15909, 15962, 16335, 16750, 17538, 17546, 17673, 17773, 17953,
    18188, 18976, 19209, 19391, 19764, 20179, 20967, 21382, 21935, 22469, 22585, 22812, 23074, 24015, 24023, 24472,
    24803, 24811, 24907, 25218, 26006, 26014, 26241, 26357, 27209, 27217, 27444, 27560, 28647, 28763, 29062, 29098,
    29435, 29551, 29850, 30638, 31053, 31841, 32076, 32256, 32491, 33279, 34067, 34482, 35270, 35685, 37115, 37903,
    38318, 39106, 39350, 39521, 40309, 40317, 40544, 40647, 40660, 40724, 41512, 41747, 41863, 42520, 42535, 42651,
    42950, 43066, 43738, 43854, 44089, 44153, 44373, 44941, 45057, 45356, 46144, 47582, 48626, 48785, 49039, 49573,
    50645, 51003, 51119, 51418, 52206, 52322, 52621, 52886, 53409, 53824, 54197, 54313, 54612, 54847, 54963, 55751,
    55815, 56050, 56166, 56838, 56954, 57018, 57253, 57369, 57403, 58041, 58157, 58392, 58456, 59180, 59244, 59360,
    59709, 59825, 60447, 63442, 64219, 65422, 65721, 65837, 66509, 66625, 66924, 67297, 67413, 67712, 67828, 68500,
    68616, 68851, 68915, 69266, 70054, 70118, 70353, 70469, 70908, 71257, 71556, 71672, 72045, 72344, 72460, 72672,
    73547, 73663, 73890, 74750, 75093, 76533, 77319, 78522, 79725, 79789, 80024, 80140, 80513, 80812, 80928, 81131,
    81600, 81716, 81951, 82015, 82131, 82803, 82919, 83154, 83218, 83569, 83800, 84357, 84772, 85145, 85560, 86348,
    86647, 86763, 87850, 87966, 88193, 89396, 90184, 91387, 91622, 92825, 93613, 94028, 94302, 94816, 95115, 95231,
    95903, 96019, 96196, 96318, 96434, 96459, 97106, 97222, 97457, 97872, 98652, 98660, 99448, 99863, 100651, 101066,
    102496, 103284, 103699, 104487, 104902, 105690, 105925, 106713, 106893, 107128, 107358, 107916, 108331, 108450,
    109119, 109418, 109534, 110215, 110322, 110875, 111091, 111409, 111525, 111752, 112955, 112961, 112963, 113751,
    114158, 114166, 114946, 114954, 116384, 116500, 116799, 117320, 117587, 118002, 118285, 118416, 118441, 118557,
    118790, 119068, 119205, 119578, 119993, 120228, 120280, 121016, 121196, 121431, 122219, 122399, 122634, 123007,
    123422, 124625, 124852, 125712, 125828, 126055, 126667, 127258, 127266, 127532, 127643, 127673, 128046, 128461,
    129249, 129257, 129484, 129600, 129640, 129664, 130452, 130687, 130803, 131102, 131218, 131890, 132006, 132305,
    132638, 132678, 132794, 133093, 133881, 134296, 134354, 134531, 135499, 135697, 135734, 136522, 137725, 137979,
    138928, 139155, 139271, 139678, 140358, 141074, 141146, 141262, 141561, 142349, 142700, 142764, 143552, 143787,
    143903, 143967, 144153, 144755, 144990, 145106, 145405, 145521, 145778, 145894, 146193, 146309, 146374, 146981,
    147097, 147396, 147502, 148184, 148300, 148599, 148758, 149264, 152028, 152853, 153458, 153574, 154031, 154246,
    154362, 154661, 154777, 155449, 155565, 155747, 155864, 156652, 156768, 157003, 157067, 157855, 158206, 158994,
    159058, 159293, 159409, 160081, 160197, 160496, 160612, 161284, 161400, 161635, 161699, 162467, 162487, 162603,
    164033, 164148, 164969, 165546, 166090, 167462, 167761, 167877, 168549, 168665, 168729, 168964, 169080, 169752,
    169868, 170167, 170283, 170540, 170656, 170657, 170955, 171071, 171306, 172094, 172158, 172509, 173297, 173361,
    173649, 173712, 174500, 174799, 174915, 174946, 175424, 175587, 175703, 175917, 176168, 176790, 176906, 177133,
    177289, 178336, 180327, 180562, 180619, 181694, 181765, 182064, 182180, 182968, 183032, 183267, 183383, 183756,
    183860, 184055, 184171, 184307, 184309, 184843, 184959, 185258, 185374, 185609, 186397, 186461, 186577, 186812,
    187600, 188010, 188015, 188388, 188803, 190006, 190233, 191093, 191209, 191436, 192639, 193427, 193662, 193842,
    194630, 194865, 195042, 195833, 196068, 196367, 196483, 196817, 196856, 197271, 197659, 198059, 198358, 198474,
    199262, 199561, 199677, 199912, 200423, 201079, 201107, 201115, 201895, 201903, 202691, 203098, 203106, 204189,
    204309, 204536, 204652, 205739, 206527, 206942, 207730, 207906, 208145, 208933, 209168, 209348, 209956, 210136,
    210371, 211159, 211574, 212362, 212486, 212777, 213565, 214995, 215410, 216198, 216206, 216613, 217401, 217409,
    218189, 218210, 218831, 218839, 218955, 219235, 219627, 219743, 220042, 220264, 220830, 220946, 221245, 221816,
    222033, 222291, 222448, 222472, 223223, 223236, 223471, 223701, 223806, 224439, 224674, 224822, 225462, 225877,
    226665, 227434, 227868, 228095, 228211, 229298, 229713, 230501, 230916, 231289, 231704, 232492, 232727, 232843,
    232907, 233142, 233258, 233779, 233827, 233930, 234046, 234345, 234461, 234900, 235133, 235249, 235548, 235921,
    236037, 236336, 237539, 238742, 238977, 239603, 240224, 240243, 240434, 240968, 241311, 242171, 242398, 242514,
    243209, 243601, 243717, 243865, 244003, 244016, 244389, 244505, 244804, 245592, 245943, 246007, 246795, 247146,
    247210, 247445, 247561, 248233, 248349, 248648, 248764, 249021, 249137, 249436, 249552, 250224, 250340, 250639,
    251842, 255271, 255493, 255614, 256701, 256817, 257489, 257605, 257669, 257904, 258020, 258639, 258692, 258808,
    259043, 259107, 259223, 259750, 259895, 260011, 260246, 260310, 260996, 261098, 261449, 261617, 261748, 261864,
    262237, 262536, 262652, 262945, 263440, 263739, 263855, 264527, 264643, 264942, 266488, 267276, 269711, 269917,
    270070, 270481, 270705, 271004, 271107, 271120, 271792, 271908, 271972, 272207, 272323, 272995, 273111, 273249,
    273346, 273410, 273526, 274198, 274314, 274549, 275337, 275401, 275517, 275752, 276540, 276955, 277743, 277756,
    278042, 278158, 278946, 279499, 279850, 280032, 280376, 280791, 281312, 281579, 282389, 282433, 282782, 283010,
    283570, 283805, 284220, 285008, 285307, 285423, 286211, 286275, 286510, 286626, 286999, 287298, 287414, 288501,
    288617, 288844, 288852, 289640, 289704, 289820, 290047, 290055, 290843, 291258, 292038, 292046, 292511, 293249,
    293476, 293592, 293632, 294679, 295094, 295882, 296244, 296297, 296670, 296905, 297085, 297873, 298108, 298288,
    298523, 299311, 299726, 300099, 300514, 301302, 301717, 302804, 302920, 303147, 303782, 304350, 304358, 304396,
    304403, 305138, 305146, 305476, 305553, 306341, 306349, 306576, 306692, 307552, 307779, 307895, 308982, 309397,
    309770, 310185, 310973, 311388, 312176, 312411, 312591, 312826, 313614, 313868, 314402, 314817, 315605, 316020,
    317450, 318238, 318653, 319441, 319856, 320644, 320652, 320879, 320995, 321847, 322082, 322198, 322870, 322986,
    323285, 324073, 324189, 324488, 325175, 325276, 325691, 325796, 326479, 327917, 328961, 329120, 329908, 331338,
    331454, 331753, 332541, 332657, 332956, 333744, 334159, 334532, 334947, 335011, 335182, 335298, 335399, 336086,
    336150, 336385, 336501, 337173, 337289, 337353, 337588, 338376, 338492, 338791, 339579, 340044, 340782, 341165,
    341335, 343777, 344211, 344554, 344618, 345641, 345757, 346056, 346172, 346306, 346568, 346844, 346960, 347259,
    347632, 347748, 347762, 348047, 348835, 348951, 349186, 349250, 349601, 350389, 350453, 350688, 350804, 351243,
    351476, 351592, 351739, 351891, 352007, 352380, 352679, 352795, 353882, 354225, 355085, 357654, 358857, 358921,
    359310, 359944, 360060, 360124, 360359, 360475, 360732, 360848, 361147, 361263, 361935, 362051, 362286, 362350,
    362466, 363138, 363254, 363489, 363553, 363904, 364692, 364991, 365107, 365480, 365895, 366683, 366982, 367098,
    367961, 368185, 368471, 368528, 369144, 369155, 369731, 370519, 371423, 371722, 371957, 373160, 373314, 373562,
    373948, 374247, 374363, 375151, 375450, 375566, 375704, 376238, 376354, 376653, 376769, 377441, 377557, 377792,
    378207, 378580, 378761, 378987, 378995, 379627, 379783, 379876, 380198, 380986, 381401, 382831, 383479, 383619,
    384034, 384822, 385237, 386025, 386260, 387048, 387228, 387463, 387693, 388251, 388666, 389354, 389454, 389753,
    389864, 389869, 390541, 390548, 390657, 391323, 391426, 391744, 391860, 391979, 392087, 392095, 393290, 393298,
    394086, 394493, 394501, 395281, 395289, 396719, 396835, 397134, 397611, 397655, 397922, 398337, 398458, 398776,
    398892, 399125, 399540, 399913, 400328, 400563, 401020, 401222, 401351, 401531, 401766, 402554, 402808, 402969,
    403342, 403757, 404960, 405187, 406047, 406163, 406377, 406390, 407593, 407601, 408008, 408381, 408796, 409584,
    409592, 409819, 409935, 409975, 410747, 410787, 411022, 411138, 411257, 411437, 412225, 412640, 413013, 413428,
    414216, 414631, 414769, 414866, 415834, 416069, 416857, 417645, 418060, 419263, 419490, 419606, 420693, 421481,
    421503, 421597, 421896, 422684, 423035, 423099, 423887, 424122, 424238, 424302, 424928, 425090, 425325, 425422,
    425441, 425740, 426113, 426229, 426528, 427267, 427316, 427432, 427677, 427731, 428519, 428934, 432140, 432363,
    433001, 433558, 433793, 433909, 434581, 434697, 434996, 435112, 435784, 435900, 436199, 436987, 437338, 437402,
    438190, 438541, 438959, 439329, 439393, 439628, 439744, 440416, 440532, 440831, 441619, 441735, 442034, 442237,
    442822, 445304, 446425, 447073, 447681, 447797, 447861, 448096, 448212, 448884, 448895, 449000, 449299, 449415,
    450087, 450203, 450502, 450875, 450991, 451290, 451329, 451406, 451641, 452429, 452493, 452844, 453533, 453632,
    453696, 453931, 454047, 454835, 455134, 455706, 455922, 456038, 456387, 456503, 457125, 457468, 457624, 458671,
    459598, 460662, 460897, 462100, 462164, 462399, 462515, 463106, 463187, 463238, 463303, 463367, 463602, 463718,
    463955, 463997, 464091, 464390, 464506, 465178, 465294, 465593, 465709, 465944, 466732, 466796, 466912, 467147,
    467935, 468350, 468633, 468723, 469138, 470341, 470568, 470894, 471428, 471771, 472974, 473762, 473997, 474177,
    474295, 474926, 474965, 475200, 476403, 476467, 476702, 476818, 476995, 477191, 477606, 478394, 478693, 478809,
    479481, 479597, 479896, 480012, 480247, 481035, 481442, 481450, 482230, 482238, 483026, 483441, 484570, 484644,
    484871, 485986, 486074, 486862, 487277, 488065, 488300, 488480, 489268, 489503, 489683, 490025, 490291, 490471,
    490706, 491494, 491909, 492697, 492996, 493112, 493900, 494550, 494848, 495330, 495745, 496319, 496533, 496541,
    496948, 497736, 497744, 498388, 498524, 498630, 499174, 499962, 500078, 500377, 501165, 501580, 502368, 502783,
    503571, 503806, 504036, 504774, 505009, 505157, 505797, 506212, 507000, 507227, 507769, 508203, 508430, 508546,
    508832, 508963, 509633, 510048, 510132, 510836, 511251, 511624, 512039, 512827, 513062, 513178, 513242, 513477,
    514265, 514381, 514680, 515235, 515468, 515592, 515883, 516256, 516671, 517224, 517712, 517874, 519077, 519312,
    519781, 520100, 520507, 521303, 521530, 521646, 522498, 522506, 522733, 522849, 523936, 524052, 524351, 524724,
    524840, 525139, 525927, 526278, 526342, 527130, 527365, 527481, 527545, 527780, 527896, 528568, 528620, 528684,
    528983, 529356, 529472, 529771, 530559, 530657, 530974, 531460, 532177, 535606, 535833, 535936, 535949, 536013,
    536211, 536801, 536985, 537036, 537152, 537824, 537940, 538239, 538355, 539027, 539105, 539143, 539378, 539442,
    540230, 540346, 540581, 540645, 541433, 541784, 541854, 542083, 542199, 542572, 542871, 542987, 543775, 544074,
    544328, 544830, 544862, 544978, 545277, 546249, 547611, 548620, 550013, 550136, 550252, 550316, 550502, 551040,
    551104, 551339, 551455, 552036, 552127, 552243, 552307, 552542, 552658, 553330, 553446, 553681, 553745, 553861,
    554533, 554649, 554884, 555672, 555736, 555852, 556087, 556875, 557290, 558078, 558377, 559281, 560498, 560711,
    561126, 561647, 561914, 562290, 562768, 563117, 563905, 564140, 564555, 565343, 565407, 565642, 565758, 566546,
    566610, 566845, 566961, 567334, 567633, 567749, 568836, 568952, 569179, 569187, 569975, 570039, 570155, 570382,
    570390, 571178, 571406, 571593, 572381, 572846, 573584, 573811, 573967, 575014, 575429, 576217, 576632, 576857,
    577005, 577240, 577420, 577936, 578208, 578443, 578444, 578858, 579646, 579710, 580061, 580434, 580849, 581637,
    581891, 581936, 582052, 583139, 583255, 583482, 583490, 584685, 584693, 585473, 585481, 586676, 586684, 586911,
    587027, 587887, 588114, 589317, 589732, 590105, 590520, 591308, 591723, 592511, 592746, 592799, 592926, 593124,
    593161, 593949, 594737, 595152, 595940, 596355, 597785, 598137, 598573, 598988, 599613, 599776, 600191, 600979,
    600987, 601214, 601330, 602182, 602417, 603205, 603321, 603620, 604408, 604823, 605611, 606026, 606164, 606814,
    608252, 608509, 609040, 609296, 609447, 609455, 610079, 610243, 611673, 611789, 612088, 612876, 613291, 614079,
    614192, 614494, 614517, 614746, 614867, 615282, 615517, 615633, 616004, 616305, 616421, 616485, 616720, 617508,
    617624, 617688, 617923, 618711, 619126, 619914, 620379, 621117, 621500, 622555, 622962, 623662, 623750, 624112,
    624546, 624773, 624889, 624953, 625741, 625835, 625976, 626092, 626391, 626507, 627179, 627295, 627594, 627967,
    628083, 628382, 629170, 629286, 629521, 629585, 629820, 629936, 630724, 630788, 631023, 631132, 631578, 631811,
    631889, 631927, 632226, 632365, 632715, 633014, 633268, 633800, 634217, 634560, 635420, 635910, 636182, 637265,
    637989, 638053, 638947, 639076, 639192, 639256, 640044, 640279, 640395, 640694, 640810, 641067, 641183, 641482,
    641598, 642270, 642346, 642386, 642621, 642685, 642801, 643097, 643473, 643589, 643824, 643888, 644224, 644239,
    644949, 645027, 645326, 645442, 645815, 646230, 647018, 647317, 648520, 648863, 649475, 649494, 650066, 650854,
    651009, 652057, 652292, 653495, 653559, 654283, 654347, 654458, 654582, 654698, 655370, 655486, 655785, 655901,
    656573, 656689, 656924, 656988, 657104, 657776, 657892, 658127, 658542, 658915, 659322, 659330, 660118, 660533,
    661321, 662439, 663166, 663726, 663954, 664369, 665157, 665572, 666360, 666595, 667383, 667798, 668028, 668334,
    668586, 668650, 669001, 669789, 670088, 670204, 670876, 670992, 671761, 672079, 672195, 672422, 672430, 673079,
    673625, 673633, 674421, 674466, 674836, 675212, 675616, 675624, 677054, 677469, 677990, 678257, 678672, 679111,
    679227, 679460, 679598, 679875, 680248, 680663, 680819, 680898, 681686, 681866, 682101, 682889, 682953, 683304,
    683677, 684092, 685295, 685522, 686382, 686498, 686725, 687928, 687936, 688716, 688996, 689131, 689919, 689927,
    690154, 690270, 690310, 690681, 691122, 691357, 691772, 692560, 692975, 693008, 693348, 693763, 694551, 694966,
    695201, 696169, 696396, 696404, 696605, 697192, 697980, 698387, 698395, 699598, 699825, 699941, 700315, 701028,
    701816, 702231, 703019, 703370, 703434, 704222, 704230, 704457, 704573, 704637, 705425, 705660, 706075, 706448,
    706517, 706863, 707651, 708066, 708116, 708854, 709269, 711495, 711704, 711902, 712690, 712698, 714128, 714244,
    714916, 715032, 715331, 716119, 716141, 716235, 716534, 717322, 717673, 717737, 717998, 718188, 718525, 718760,
    718876, 719664, 719728, 719963, 719997, 720751, 720867, 721166, 721954, 722369, 723157, 723676, 725602, 725639,
    726205, 726760, 726993, 727408, 728016, 728132, 728196, 728431, 728547, 729219, 729335, 729634, 729750, 730422,
    730538, 730837, 731020, 731210, 731326, 731625, 731741, 731976, 732405, 732631, 732764, 732828, 733179, 733967,
    734031, 734131, 734213, 734266, 735170, 735469, 735716, 735723, 736257, 736722, 737460, 737803, 737843, 737959,
    739006, 739292, 740508, 741232, 741296, 742435, 742499, 742734, 742850, 743522, 743638, 743702, 743937, 744053,
    744310, 744426, 744725, 744841, 745513, 745629, 745864, 745928, 746044, 746279, 747067, 747131, 747247, 747482,
    748270, 748685, 749058, 749473, 750560, 750903, 751763, 752106, 753309, 754097, 754332, 754512, 755039, 755300,
    755535, 755599, 756533, 756738, 756802, 757037, 757153, 757526, 757791, 757825, 757941, 758397, 758729, 759028,
    759144, 759816, 759932, 760231, 760347, 760582, 761370, 761777, 761785, 762565, 762573, 763361, 763776, 765206,
    766072, 766396, 766409, 767197, 767612, 768400, 768506, 768635, 768815, 769603, 769838, 770626, 770806, 771041,
    771829, 772244, 773032, 773172, 773331, 773447, 774235, 774788, 774885, 775665, 776080, 776868, 776876, 777664,
    778071, 778079, 778859, 779509, 780297, 780712, 781071, 781500, 781915, 781923, 782703, 783118, 783672, 783906,
    784141, 784371, 784929, 785109, 785336, 785344, 785492, 786132, 786547, 787335, 788104, 788527, 788538, 788765,
    788881, 789968, 790383, 791171, 791342, 791586, 791959, 792374, 793162, 793397, 793513, 793577, 793812, 794600,
    795015, 795454, 795570, 795668, 795803, 796218, 796591, 797006, 798209, 799412, 799639, 799647, 800435, 800842,
    801630, 801638, 801865, 801981, 802841, 803068, 803184, 804271, 804484, 804686, 805059, 805175, 805474, 806262,
    806613, 806677, 806929, 807465, 807700, 807816, 807880, 808115, 808903, 808934, 809157, 809318, 809691, 810106,
    810894, 811309, 812512, 813942, 814052, 815145, 815933, 815941, 816168, 816284, 817016, 817136, 817371, 817487,
    818053, 818159, 818275, 818574, 818690, 819362, 819478, 819713, 819777, 820420, 820565, 820681, 820916, 820980,
    821768, 822119, 822167, 822418, 822907, 823206, 824110, 824409, 824814, 825197, 825271, 825612, 825877, 827946,
    828010, 828322, 829448, 830236, 830471, 830587, 830651, 830915, 831375, 831439, 831486, 831674, 831790, 832462,
    832578, 832642, 832877, 832993, 833665, 833781, 834016, 834080, 834196, 834375, 834868, 834984, 835219, 835637,
    836007, 836071, 836422, 836624, 837210, 838409, 838413, 838712, 839500, 840420, 841046, 841461, 841982, 842249,
    843103, 843332, 843751, 844240, 844475, 844539, 844890, 845084, 845359, 845678, 845742, 845977, 846093, 846244,
    846358, 846765, 846881, 846945, 847180, 847296, 847669, 847968, 848084, 848319, 849171, 849287, 849514, 849522,
    850310, 850374, 850490, 850725, 851513, 852308, 852716, 853181, 854146, 854302, 855349, 855764, 856552, 856967,
    857340, 857575, 857755, 858543, 858778, 858842, 859193, 859802, 859981, 860045, 860243, 860280, 860396, 860769,
    861184, 861972, 862271, 862387, 863474, 863590, 863817, 863825, 865020, 865028, 865808, 865816, 866144, 867011,
    867019, 867246, 868449, 868580, 868714, 868851, 869652, 870067, 870440, 870855, 870993, 871358, 871643, 872058,
    872846, 872898, 873081, 873145, 873261, 873496, 873869, 874038, 874284, 875072, 875487, 876275, 876690, 877280,
    878120, 878908, 879323, 879491, 880111, 880119, 880526, 881195, 881314, 881322, 881549, 882517, 882752, 883540,
    883955, 884743, 885158, 885946, 886361, 887149, 887384, 887998, 888579, 888587, 889375, 889782, 889790, 890578,
    890995, 892008, 892124, 892233, 892423, 893211, 893626, 893802, 894414, 894829, 895202, 895490, 895617, 895852,
    895954, 896640, 896756, 896820, 897055, 897843, 898258, 899046, 899461, 900249, 900714, 901357, 901452, 901666,
    901835, 902588, 902882, 902890, 903297, 903517, 904085, 904442, 904447, 904873, 904881, 905108, 905224, 906039,
    906076, 906311, 906427, 906726, 907514, 907630, 907929, 908302, 908418, 908717, 908879, 909505, 909621, 909856,
    909920, 910058, 910155, 910256, 911059, 911123, 911358, 911913, 912146, 912561, 912934, 913349, 914552, 914895,
    915336, 915342, 915755, 917185, 917600, 918324, 918388, 919176, 919411, 919527, 919591, 920379, 920614, 920730,
    921029, 921145, 921402, 921518, 921817, 921933, 922605, 922721, 922956, 923020, 923136, 923808, 923924, 924159,
    924223, 924316, 924574, 925362, 925661, 926150, 927652, 928855, 929198, 930401, 931189, 932627, 932691, 933076,
    933479, 933830, 933894, 934618, 934682, 934917, 935033, 935705, 935821, 936120, 936236, 936908, 937024, 937259,
    937323, 937439, 938111, 938227, 938462, 938838, 938877, 939250, 939665, 940453, 941577, 941656, 941955, 943494,
    943501, 944289, 944704, 945188, 945492, 946695, 946930, 946994, 947462, 947718, 947782, 948133, 948348, 948363,
    948921, 948985, 949220, 949336, 949766, 950124, 950423, 950539, 951211, 951327, 952096, 952414, 952530, 952757,
    952765, 953960, 953968, 954756, 955951, 955959, 957389, 957804, 958275, 958325, 958427, 958592, 959007, 959446,
    959795, 960210, 960231, 960583, 960998, 961233, 962021, 962085, 962201, 962436, 963224, 963268, 963288, 963639,
    964012, 964427, 965630, 965857, 966183, 966717, 966833, 967060, 968250, 968263, 968271, 968855, 969051, 969059,
    969409, 969466, 970254, 970262, 970489, 970645, 971159, 971692, 972107, 972895, 973310, 973683, 974098, 974886,
    975301, 975536, 976324, 976388, 976504, 976604, 976731, 976739, 977405, 977527, 978315, 978730, 979933, 980160,
    981363, 981624, 981938, 982151, 982566, 983354, 983589, 983705, 983769, 984557, 984565, 984792, 984925, 984972,
    985760, 985995, 986407, 986410, 986783, 987198, 987986, 988401, 989189, 989453, 989604, 989839, 990248, 991034,
    991822, 991830, 992237, 992552, 993025, 993033, 993750, 994463, 994579, 995251, 995367, 995666, 996454, 996570,
    996869, 997657, 998008, 998072, 998860, 999095, 999999, 1000063, 1000298, 1001086, 1001501, 1002289, 1002704,
    1003017, 1003246, 1003492, 1004121, 1005337, 1005974, 1006125, 1006231, 1006318, 1006425, 1006540, 1007095, 1007328,
    1008116, 1008351, 1008467, 1008531, 1008766, 1008882, 1009057, 1009554, 1009670, 1009969, 1010085, 1010757, 1010873,
    1011172, 1011545, 1011661, 1011960, 1012076, 1012311, 1012513, 1013099, 1013163, 1013533, 1014088, 1014302, 1014366,
    1014601, 1015389, 1015804, 1016592, 1016695, 1017057, 1017795, 1018138, 1018178, 1018294, 1019341, 1019640, 1020428,
    1020738, 1020790, 1020827, 1020843, 1021567, 1021631, 1022419, 1022654, 1022770, 1022834, 1023069, 1023185, 1023857,
    1023973, 1024037, 1024272, 1024388, 1024410, 1024639, 1024645, 1024761, 1025060, 1025176, 1025848, 1025964, 1026199,
    1026263, 1026379, 1026614, 1027402, 1027466, 1027711, 1027956, 1028605, 1028689, 1029257, 1029393, 1030450, 1030748,
    1030895, 1031225, 1031238, 1032098, 1032441, 1033644, 1033943, 1034432, 1034667, 1034731, 1035635, 1035870, 1035934,
    1036190, 1036722, 1037016, 1037073, 1037137, 1037372, 1037488, 1037861, 1038105, 1038160, 1038276, 1039064, 1039097,
    1039363, 1039479, 1039617, 1040151, 1040267, 1040469, 1040566, 1040682, 1040917, 1041016, 1041705, 1042120, 1042131,
    1042493, 1042900, 1042908, 1043696, 1045541, 1045803, 1046032, 1046744, 1047532, 1047947, 1048735, 1048970, 1049104,
    1049150, 1049349, 1049938, 1050173, 1050237, 1050961, 1051025, 1051141, 1051376, 1051843, 1052164, 1052579, 1053367,
    1053507, 1053666, 1053782, 1054570, 1055144, 1055220, 1056000, 1056415, 1057203, 1057211, 1057999, 1058406, 1059194,
    1059826, 1059844, 1060632, 1061047, 1061835, 1062250, 1063038, 1063453, 1064241, 1064476, 1064482, 1064706, 1065264,
    1065328, 1065444, 1065671, 1065679, 1065827, 1065917, 1066467, 1066882, 1067196, 1067670, 1068439, 1068873, 1069100,
    1069353, 1070087, 1070303, 1070497, 1070718, 1071172, 1071458, 1071506, 1071514, 1071921, 1072152, 1072294, 1072709,
    1073497, 1073667, 1073732, 1074147, 1074935, 1075350, 1075789, 1075905, 1076138, 1076537, 1076553, 1076926, 1077189,
    1077341, 1078544, 1078771, 1078779, 1079631, 1079747, 1079974, 1079982, 1080770,
]);
/** Generated from the audited corpus union. Gaps are intentional when a spare seed is itself already reserved. */
export const V07_COMPOSED_REMAP_ORDINALS: readonly number[] = Object.freeze([
    1081000, 1081001, 1081002, 1081003, 1081004, 1081005, 1081006, 1081007, 1081008, 1081009, 1081010, 1081011, 1081012,
    1081013, 1081014, 1081015, 1081016, 1081017, 1081018, 1081019, 1081020, 1081021, 1081022, 1081023, 1081024, 1081025,
    1081026, 1081027, 1081028, 1081029, 1081030, 1081031, 1081032, 1081033, 1081034, 1081035, 1081036, 1081037, 1081038,
    1081039, 1081040, 1081041, 1081042, 1081043, 1081044, 1081045, 1081046, 1081047, 1081048, 1081049, 1081050, 1081051,
    1081052, 1081053, 1081054, 1081055, 1081056, 1081057, 1081058, 1081059, 1081060, 1081061, 1081062, 1081063, 1081064,
    1081065, 1081066, 1081067, 1081068, 1081069, 1081070, 1081071, 1081072, 1081073, 1081074, 1081075, 1081076, 1081077,
    1081078, 1081079, 1081080, 1081081, 1081082, 1081083, 1081084, 1081085, 1081086, 1081087, 1081088, 1081089, 1081090,
    1081091, 1081092, 1081093, 1081094, 1081095, 1081096, 1081097, 1081098, 1081099, 1081100, 1081101, 1081102, 1081103,
    1081104, 1081105, 1081106, 1081107, 1081108, 1081109, 1081110, 1081111, 1081112, 1081113, 1081114, 1081115, 1081116,
    1081117, 1081118, 1081119, 1081120, 1081121, 1081122, 1081123, 1081124, 1081125, 1081126, 1081127, 1081128, 1081129,
    1081130, 1081131, 1081132, 1081133, 1081134, 1081135, 1081136, 1081137, 1081138, 1081139, 1081140, 1081141, 1081142,
    1081143, 1081144, 1081145, 1081146, 1081147, 1081148, 1081149, 1081150, 1081151, 1081152, 1081153, 1081154, 1081155,
    1081156, 1081157, 1081158, 1081159, 1081160, 1081161, 1081162, 1081163, 1081164, 1081165, 1081166, 1081167, 1081168,
    1081169, 1081170, 1081171, 1081172, 1081173, 1081174, 1081175, 1081176, 1081177, 1081178, 1081179, 1081180, 1081181,
    1081182, 1081183, 1081184, 1081185, 1081186, 1081187, 1081188, 1081189, 1081190, 1081191, 1081192, 1081193, 1081194,
    1081195, 1081196, 1081197, 1081198, 1081199, 1081200, 1081201, 1081202, 1081203, 1081204, 1081205, 1081206, 1081207,
    1081208, 1081209, 1081210, 1081211, 1081212, 1081213, 1081214, 1081215, 1081216, 1081217, 1081218, 1081219, 1081220,
    1081221, 1081222, 1081223, 1081224, 1081225, 1081226, 1081227, 1081228, 1081229, 1081230, 1081231, 1081232, 1081233,
    1081234, 1081235, 1081236, 1081237, 1081238, 1081239, 1081240, 1081241, 1081242, 1081243, 1081244, 1081245, 1081246,
    1081247, 1081248, 1081249, 1081250, 1081251, 1081252, 1081253, 1081254, 1081255, 1081256, 1081257, 1081258, 1081259,
    1081260, 1081261, 1081262, 1081263, 1081264, 1081265, 1081266, 1081267, 1081268, 1081269, 1081270, 1081271, 1081272,
    1081273, 1081274, 1081275, 1081276, 1081277, 1081278, 1081279, 1081280, 1081281, 1081282, 1081283, 1081284, 1081285,
    1081286, 1081287, 1081288, 1081289, 1081290, 1081291, 1081292, 1081293, 1081294, 1081295, 1081296, 1081297, 1081298,
    1081299, 1081300, 1081301, 1081302, 1081303, 1081304, 1081305, 1081306, 1081307, 1081308, 1081309, 1081310, 1081311,
    1081312, 1081313, 1081314, 1081315, 1081316, 1081317, 1081318, 1081319, 1081320, 1081321, 1081322, 1081323, 1081324,
    1081325, 1081326, 1081327, 1081328, 1081329, 1081330, 1081331, 1081332, 1081333, 1081334, 1081335, 1081336, 1081337,
    1081338, 1081339, 1081340, 1081341, 1081342, 1081343, 1081344, 1081345, 1081346, 1081347, 1081348, 1081349, 1081350,
    1081351, 1081352, 1081353, 1081354, 1081355, 1081356, 1081357, 1081358, 1081359, 1081360, 1081361, 1081362, 1081363,
    1081364, 1081365, 1081366, 1081367, 1081368, 1081369, 1081370, 1081371, 1081372, 1081373, 1081374, 1081375, 1081376,
    1081377, 1081378, 1081379, 1081380, 1081381, 1081382, 1081383, 1081384, 1081385, 1081386, 1081387, 1081388, 1081389,
    1081390, 1081391, 1081392, 1081393, 1081394, 1081395, 1081396, 1081397, 1081398, 1081399, 1081400, 1081401, 1081402,
    1081403, 1081404, 1081405, 1081406, 1081407, 1081408, 1081409, 1081410, 1081411, 1081412, 1081413, 1081414, 1081415,
    1081416, 1081417, 1081418, 1081419, 1081420, 1081421, 1081422, 1081423, 1081424, 1081425, 1081426, 1081427, 1081428,
    1081429, 1081430, 1081431, 1081432, 1081433, 1081434, 1081435, 1081436, 1081437, 1081438, 1081439, 1081440, 1081441,
    1081442, 1081443, 1081444, 1081445, 1081446, 1081447, 1081448, 1081449, 1081450, 1081451, 1081452, 1081453, 1081454,
    1081455, 1081456, 1081457, 1081458, 1081459, 1081460, 1081461, 1081462, 1081463, 1081464, 1081465, 1081466, 1081467,
    1081468, 1081469, 1081470, 1081471, 1081472, 1081473, 1081474, 1081475, 1081476, 1081477, 1081478, 1081479, 1081480,
    1081481, 1081482, 1081483, 1081484, 1081485, 1081486, 1081487, 1081488, 1081489, 1081490, 1081491, 1081492, 1081493,
    1081494, 1081495, 1081496, 1081497, 1081498, 1081499, 1081500, 1081501, 1081502, 1081503, 1081504, 1081505, 1081506,
    1081507, 1081508, 1081509, 1081510, 1081511, 1081512, 1081513, 1081514, 1081515, 1081516, 1081517, 1081518, 1081519,
    1081520, 1081521, 1081522, 1081523, 1081524, 1081525, 1081526, 1081527, 1081528, 1081529, 1081530, 1081531, 1081532,
    1081533, 1081534, 1081535, 1081536, 1081537, 1081538, 1081539, 1081540, 1081541, 1081542, 1081543, 1081544, 1081545,
    1081546, 1081547, 1081548, 1081549, 1081550, 1081551, 1081552, 1081553, 1081554, 1081555, 1081556, 1081557, 1081558,
    1081559, 1081560, 1081561, 1081562, 1081563, 1081564, 1081565, 1081566, 1081567, 1081568, 1081569, 1081570, 1081571,
    1081572, 1081573, 1081574, 1081575, 1081576, 1081577, 1081578, 1081579, 1081580, 1081581, 1081582, 1081583, 1081584,
    1081585, 1081586, 1081587, 1081588, 1081589, 1081590, 1081591, 1081592, 1081593, 1081594, 1081595, 1081596, 1081597,
    1081598, 1081599, 1081600, 1081601, 1081602, 1081603, 1081604, 1081605, 1081606, 1081607, 1081608, 1081609, 1081610,
    1081611, 1081612, 1081613, 1081614, 1081615, 1081616, 1081617, 1081618, 1081619, 1081620, 1081621, 1081622, 1081623,
    1081624, 1081625, 1081626, 1081627, 1081628, 1081629, 1081630, 1081631, 1081632, 1081633, 1081634, 1081635, 1081636,
    1081637, 1081638, 1081639, 1081640, 1081641, 1081642, 1081643, 1081644, 1081645, 1081646, 1081647, 1081648, 1081649,
    1081650, 1081651, 1081652, 1081653, 1081654, 1081655, 1081656, 1081657, 1081658, 1081659, 1081660, 1081661, 1081662,
    1081663, 1081664, 1081665, 1081666, 1081667, 1081668, 1081669, 1081670, 1081671, 1081672, 1081673, 1081674, 1081675,
    1081676, 1081677, 1081678, 1081679, 1081680, 1081681, 1081682, 1081683, 1081684, 1081685, 1081686, 1081687, 1081688,
    1081689, 1081690, 1081691, 1081692, 1081693, 1081694, 1081695, 1081696, 1081697, 1081698, 1081699, 1081700, 1081701,
    1081702, 1081703, 1081704, 1081705, 1081706, 1081707, 1081708, 1081709, 1081710, 1081711, 1081712, 1081713, 1081714,
    1081715, 1081716, 1081717, 1081718, 1081719, 1081720, 1081721, 1081722, 1081723, 1081724, 1081725, 1081726, 1081727,
    1081728, 1081729, 1081730, 1081731, 1081732, 1081733, 1081734, 1081735, 1081736, 1081737, 1081738, 1081739, 1081740,
    1081741, 1081742, 1081743, 1081744, 1081745, 1081746, 1081747, 1081748, 1081749, 1081750, 1081751, 1081752, 1081753,
    1081754, 1081755, 1081756, 1081757, 1081758, 1081759, 1081760, 1081761, 1081762, 1081763, 1081764, 1081765, 1081766,
    1081767, 1081768, 1081769, 1081770, 1081771, 1081772, 1081773, 1081774, 1081775, 1081776, 1081777, 1081778, 1081779,
    1081780, 1081781, 1081782, 1081783, 1081784, 1081785, 1081786, 1081787, 1081788, 1081789, 1081790, 1081791, 1081792,
    1081793, 1081794, 1081795, 1081796, 1081797, 1081798, 1081799, 1081800, 1081801, 1081802, 1081803, 1081804, 1081805,
    1081806, 1081807, 1081808, 1081809, 1081810, 1081811, 1081812, 1081813, 1081814, 1081815, 1081816, 1081817, 1081818,
    1081819, 1081820, 1081821, 1081822, 1081823, 1081824, 1081825, 1081826, 1081827, 1081828, 1081829, 1081830, 1081831,
    1081832, 1081833, 1081834, 1081835, 1081836, 1081837, 1081838, 1081839, 1081840, 1081841, 1081842, 1081843, 1081844,
    1081845, 1081846, 1081847, 1081848, 1081849, 1081850, 1081851, 1081852, 1081853, 1081854, 1081855, 1081856, 1081857,
    1081858, 1081859, 1081860, 1081861, 1081862, 1081863, 1081864, 1081865, 1081866, 1081867, 1081868, 1081869, 1081870,
    1081871, 1081872, 1081873, 1081874, 1081875, 1081876, 1081877, 1081878, 1081879, 1081880, 1081881, 1081882, 1081883,
    1081884, 1081885, 1081886, 1081887, 1081888, 1081889, 1081890, 1081891, 1081892, 1081893, 1081894, 1081895, 1081896,
    1081897, 1081898, 1081899, 1081900, 1081901, 1081902, 1081903, 1081904, 1081905, 1081906, 1081907, 1081908, 1081909,
    1081910, 1081911, 1081912, 1081913, 1081914, 1081915, 1081916, 1081917, 1081918, 1081919, 1081920, 1081921, 1081922,
    1081923, 1081924, 1081925, 1081926, 1081927, 1081928, 1081929, 1081930, 1081931, 1081932, 1081933, 1081934, 1081935,
    1081936, 1081937, 1081938, 1081939, 1081940, 1081941, 1081942, 1081943, 1081944, 1081945, 1081946, 1081947, 1081948,
    1081949, 1081950, 1081951, 1081952, 1081953, 1081954, 1081955, 1081956, 1081957, 1081958, 1081959, 1081960, 1081961,
    1081962, 1081963, 1081964, 1081966, 1081967, 1081968, 1081969, 1081970, 1081971, 1081972, 1081974, 1081975, 1081976,
    1081977, 1081978, 1081979, 1081980, 1081981, 1081982, 1081983, 1081984, 1081985, 1081986, 1081987, 1081988, 1081989,
    1081990, 1081991, 1081992, 1081993, 1081994, 1081995, 1081996, 1081997, 1081998, 1081999, 1082000, 1082001, 1082002,
    1082003, 1082004, 1082005, 1082006, 1082007, 1082008, 1082009, 1082010, 1082011, 1082012, 1082013, 1082014, 1082015,
    1082016, 1082017, 1082018, 1082019, 1082020, 1082021, 1082022, 1082023, 1082024, 1082025, 1082026, 1082027, 1082028,
    1082029, 1082030, 1082031, 1082032, 1082033, 1082034, 1082035, 1082036, 1082037, 1082038, 1082039, 1082040, 1082041,
    1082042, 1082043, 1082044, 1082045, 1082046, 1082047, 1082048, 1082049, 1082050, 1082051, 1082052, 1082053, 1082054,
    1082055, 1082056, 1082057, 1082058, 1082059, 1082060, 1082061, 1082062, 1082063, 1082064, 1082065, 1082066, 1082067,
    1082068, 1082069, 1082070, 1082071, 1082072, 1082073, 1082074, 1082075, 1082076, 1082077, 1082078, 1082079, 1082080,
    1082081, 1082082, 1082083, 1082084, 1082085, 1082086, 1082087, 1082088, 1082089, 1082090, 1082091, 1082092, 1082093,
    1082094, 1082095, 1082096, 1082097, 1082098, 1082099, 1082100, 1082101, 1082102, 1082103, 1082104, 1082105, 1082106,
    1082107, 1082108, 1082109, 1082110, 1082111, 1082112, 1082113, 1082114, 1082115, 1082116, 1082117, 1082118, 1082119,
    1082120, 1082121, 1082122, 1082123, 1082124, 1082125, 1082126, 1082127, 1082128, 1082129, 1082130, 1082131, 1082132,
    1082133, 1082134, 1082135, 1082136, 1082137, 1082138, 1082139, 1082140, 1082141, 1082142, 1082143, 1082144, 1082145,
    1082146, 1082147, 1082148, 1082149, 1082150, 1082151, 1082152, 1082153, 1082154, 1082155, 1082156, 1082157, 1082158,
    1082159, 1082160, 1082161, 1082162, 1082163, 1082164, 1082165, 1082166, 1082167, 1082168, 1082169, 1082170, 1082171,
    1082172, 1082173, 1082174, 1082175, 1082176, 1082177, 1082178, 1082179, 1082180, 1082181, 1082182, 1082183, 1082184,
    1082185, 1082186, 1082187, 1082188, 1082189, 1082190, 1082191, 1082192, 1082193, 1082194, 1082195, 1082196, 1082197,
    1082198, 1082199, 1082201, 1082202, 1082203, 1082204, 1082205, 1082206, 1082207, 1082208, 1082209, 1082210, 1082211,
    1082212, 1082213, 1082214, 1082215, 1082216, 1082217, 1082218, 1082219, 1082220, 1082221, 1082222, 1082223, 1082224,
    1082225, 1082226, 1082227, 1082228, 1082229, 1082230, 1082231, 1082232, 1082233, 1082234, 1082235, 1082236, 1082237,
    1082238, 1082239, 1082240, 1082241, 1082242, 1082243, 1082244, 1082245, 1082246, 1082247, 1082248, 1082249, 1082250,
    1082251, 1082252, 1082253, 1082254, 1082255, 1082256, 1082257, 1082258, 1082259, 1082260, 1082261, 1082262, 1082263,
    1082264, 1082265, 1082266, 1082267, 1082268, 1082269, 1082270, 1082271, 1082272, 1082273, 1082274, 1082275, 1082276,
    1082277, 1082278, 1082279, 1082280, 1082281, 1082282, 1082283, 1082284, 1082285, 1082286, 1082287, 1082288, 1082289,
    1082290, 1082291, 1082292, 1082293, 1082294, 1082295, 1082296, 1082297, 1082298, 1082299, 1082300, 1082301, 1082302,
    1082303, 1082304, 1082305, 1082306, 1082307, 1082308, 1082309, 1082310, 1082311, 1082312, 1082313, 1082314, 1082315,
    1082317, 1082318, 1082319, 1082320, 1082321, 1082322, 1082323, 1082324, 1082325, 1082326, 1082327, 1082328, 1082329,
    1082330, 1082331, 1082332, 1082333, 1082334, 1082335, 1082336, 1082337, 1082338, 1082339, 1082340, 1082341, 1082342,
    1082343, 1082344, 1082345, 1082346, 1082347, 1082348, 1082349, 1082350, 1082351, 1082352, 1082353, 1082354, 1082355,
    1082356, 1082357, 1082358, 1082359, 1082360, 1082361, 1082362, 1082363, 1082364, 1082365, 1082366, 1082367, 1082368,
    1082369, 1082370, 1082371, 1082372, 1082373, 1082374, 1082375, 1082376, 1082377, 1082378, 1082379, 1082380, 1082381,
    1082382, 1082383, 1082384, 1082385, 1082386, 1082387, 1082388, 1082389, 1082390, 1082391, 1082392, 1082393, 1082394,
    1082395, 1082396, 1082397, 1082398, 1082399, 1082400, 1082401, 1082402, 1082403, 1082404, 1082405, 1082406, 1082407,
    1082408, 1082409, 1082410, 1082411, 1082412, 1082413, 1082414, 1082415, 1082416, 1082417, 1082418, 1082419, 1082420,
    1082421, 1082422, 1082423, 1082424, 1082425, 1082426, 1082427, 1082428, 1082429, 1082430, 1082431, 1082432, 1082433,
    1082434, 1082435, 1082436, 1082437, 1082438, 1082439, 1082440, 1082441, 1082442, 1082443, 1082444, 1082445, 1082446,
    1082447, 1082448, 1082449, 1082450, 1082451, 1082452, 1082453, 1082454, 1082455, 1082456, 1082457, 1082458, 1082459,
    1082460, 1082461, 1082462, 1082463, 1082464, 1082465, 1082466, 1082467, 1082468, 1082469, 1082470, 1082471, 1082472,
    1082473, 1082474, 1082475, 1082476, 1082477, 1082478, 1082479, 1082480, 1082481, 1082482, 1082483, 1082484, 1082485,
    1082486, 1082487, 1082488, 1082489, 1082490, 1082491, 1082492, 1082493, 1082494, 1082495, 1082496, 1082497, 1082498,
    1082499, 1082500, 1082501, 1082502, 1082503, 1082504, 1082505, 1082506, 1082507, 1082508, 1082509, 1082510, 1082511,
    1082512, 1082513, 1082514, 1082515, 1082516, 1082517, 1082518, 1082519, 1082520, 1082521, 1082522, 1082523, 1082524,
    1082525, 1082526, 1082527, 1082528, 1082529, 1082530, 1082531, 1082532, 1082533, 1082534, 1082535, 1082536, 1082537,
    1082538, 1082539, 1082540, 1082541, 1082542, 1082543, 1082544, 1082545, 1082546, 1082547, 1082548, 1082549, 1082550,
    1082551, 1082552, 1082553, 1082554, 1082555, 1082556, 1082557, 1082558, 1082559, 1082560, 1082561, 1082562, 1082563,
    1082564, 1082565, 1082566, 1082567, 1082568, 1082569, 1082570, 1082571, 1082572, 1082573, 1082574, 1082575, 1082576,
    1082577, 1082578, 1082579, 1082580, 1082581, 1082582, 1082583, 1082584, 1082585, 1082586, 1082587, 1082588, 1082589,
    1082590, 1082591, 1082592, 1082593, 1082594, 1082595, 1082596, 1082597, 1082598, 1082599, 1082600, 1082601, 1082602,
    1082603, 1082604, 1082605, 1082606, 1082607, 1082608, 1082609, 1082610, 1082611, 1082612, 1082613, 1082614, 1082615,
    1082616, 1082617, 1082618, 1082619, 1082620, 1082621, 1082622, 1082623, 1082624, 1082625, 1082626, 1082627, 1082628,
    1082629, 1082630, 1082631, 1082632, 1082633, 1082634, 1082635, 1082636, 1082637, 1082638, 1082639, 1082640, 1082641,
    1082642, 1082643, 1082644, 1082645, 1082646, 1082647, 1082648, 1082649, 1082650, 1082651, 1082652, 1082653, 1082654,
    1082655, 1082656, 1082657, 1082658, 1082659, 1082660, 1082661, 1082662, 1082663, 1082664, 1082665, 1082666, 1082667,
    1082668, 1082669, 1082670, 1082671, 1082672, 1082673, 1082674, 1082675, 1082676, 1082677, 1082678, 1082679, 1082680,
    1082681, 1082682, 1082683, 1082684, 1082685, 1082686, 1082687, 1082688, 1082689, 1082690, 1082691, 1082692, 1082693,
    1082694, 1082695, 1082696, 1082697, 1082698, 1082699, 1082700, 1082701, 1082702, 1082703, 1082704, 1082705, 1082706,
    1082707, 1082708, 1082709, 1082710, 1082711, 1082712, 1082713, 1082714, 1082715, 1082716, 1082717, 1082718, 1082719,
    1082720, 1082721, 1082722, 1082723, 1082724, 1082725, 1082726, 1082727, 1082728, 1082729, 1082730, 1082731, 1082732,
    1082733, 1082734, 1082735, 1082736, 1082737, 1082738, 1082739, 1082740, 1082741, 1082742, 1082743, 1082744, 1082745,
    1082746, 1082747, 1082748, 1082749, 1082750, 1082751, 1082752, 1082753, 1082754, 1082755, 1082756, 1082757, 1082758,
    1082759, 1082760, 1082761, 1082762, 1082763, 1082764, 1082765, 1082766, 1082767, 1082768, 1082769, 1082770, 1082771,
    1082772, 1082773, 1082774, 1082775, 1082776, 1082777, 1082778, 1082779, 1082780, 1082781, 1082782, 1082783, 1082784,
    1082785, 1082786, 1082787, 1082788, 1082789, 1082790, 1082791, 1082792, 1082793, 1082794, 1082795, 1082796, 1082797,
    1082798, 1082799, 1082800, 1082801, 1082802, 1082803, 1082804, 1082805, 1082806, 1082807, 1082808, 1082809, 1082810,
    1082811, 1082812, 1082813, 1082814, 1082815, 1082816, 1082817, 1082818, 1082819, 1082820, 1082821, 1082822, 1082823,
    1082824, 1082825, 1082826, 1082827, 1082828, 1082829, 1082830, 1082831, 1082832, 1082833, 1082834, 1082835, 1082836,
    1082837, 1082838, 1082839, 1082840, 1082841, 1082842, 1082843, 1082844, 1082845, 1082846, 1082847, 1082848, 1082849,
    1082850, 1082851, 1082852, 1082853, 1082854, 1082855, 1082856, 1082857, 1082858, 1082859, 1082860, 1082861, 1082862,
    1082863, 1082864, 1082865, 1082866, 1082867, 1082868, 1082869, 1082870, 1082871, 1082872, 1082873, 1082874, 1082875,
    1082876, 1082877, 1082878, 1082879, 1082880, 1082881, 1082882, 1082883, 1082884, 1082885, 1082886, 1082887, 1082888,
    1082889, 1082890, 1082891, 1082892, 1082893, 1082894, 1082895, 1082896, 1082897, 1082898, 1082899, 1082900, 1082901,
    1082902, 1082903, 1082904, 1082905, 1082906, 1082907, 1082908, 1082909, 1082910, 1082911, 1082912, 1082913, 1082914,
    1082915, 1082916, 1082917, 1082918, 1082919, 1082920, 1082921, 1082922, 1082923, 1082924, 1082925, 1082926, 1082927,
    1082928, 1082929, 1082930, 1082931, 1082932, 1082933, 1082934, 1082935, 1082936, 1082937, 1082938, 1082939, 1082940,
    1082941, 1082942, 1082943, 1082944, 1082945, 1082946, 1082947, 1082948, 1082949, 1082950, 1082951, 1082952, 1082953,
    1082954, 1082955, 1082956, 1082957, 1082958, 1082959, 1082960, 1082961, 1082962, 1082963, 1082964, 1082965, 1082966,
    1082967, 1082968, 1082969, 1082970, 1082971, 1082972, 1082973, 1082974, 1082975, 1082976, 1082977, 1082978, 1082979,
    1082980, 1082981, 1082982, 1082983, 1082984, 1082985, 1082986, 1082987, 1082988, 1082989, 1082990, 1082991, 1082992,
    1082993, 1082994, 1082995, 1082996, 1082997, 1082998, 1082999, 1083000, 1083001, 1083002, 1083003, 1083004, 1083005,
    1083006, 1083007, 1083008, 1083009, 1083010, 1083011, 1083012, 1083013, 1083014, 1083015, 1083016, 1083017, 1083018,
    1083019, 1083020, 1083021, 1083022, 1083023, 1083024, 1083025, 1083026, 1083027, 1083028, 1083029, 1083030, 1083031,
    1083032, 1083033, 1083034, 1083035, 1083036, 1083037, 1083038, 1083039, 1083040, 1083041, 1083042, 1083043, 1083044,
    1083045, 1083046, 1083047, 1083048, 1083049, 1083050, 1083051, 1083052, 1083053, 1083054, 1083055, 1083056, 1083057,
    1083058, 1083059, 1083060, 1083061, 1083062, 1083063, 1083064, 1083065, 1083066, 1083067, 1083068, 1083069, 1083070,
    1083071, 1083072, 1083073, 1083074, 1083075, 1083076, 1083077, 1083078, 1083079, 1083080, 1083081, 1083082, 1083083,
    1083084, 1083085, 1083086, 1083087, 1083088, 1083089, 1083090, 1083091, 1083092, 1083093, 1083094, 1083095, 1083096,
    1083097, 1083098, 1083099, 1083100, 1083101, 1083102, 1083103, 1083104, 1083105, 1083106, 1083107, 1083108, 1083109,
    1083110, 1083111, 1083112, 1083113, 1083114, 1083115, 1083116, 1083117, 1083118, 1083119, 1083120, 1083121, 1083122,
    1083123, 1083124, 1083125, 1083126, 1083127, 1083128, 1083129, 1083130, 1083131, 1083132, 1083133, 1083134, 1083135,
    1083136, 1083137, 1083138, 1083139, 1083140, 1083141, 1083142, 1083143, 1083144, 1083145, 1083146, 1083147, 1083148,
    1083149, 1083150, 1083151, 1083152, 1083153, 1083154, 1083155, 1083156, 1083157, 1083158, 1083159, 1083160, 1083161,
    1083162, 1083163, 1083164, 1083165, 1083166, 1083167, 1083168, 1083169, 1083170, 1083171, 1083172, 1083173, 1083174,
    1083175, 1083177, 1083178, 1083179, 1083180, 1083181, 1083182, 1083183, 1083184, 1083185, 1083186, 1083187, 1083188,
    1083189, 1083190, 1083191, 1083192, 1083193, 1083194, 1083195, 1083196, 1083197, 1083198, 1083199, 1083200, 1083201,
    1083202, 1083203, 1083204, 1083205, 1083206, 1083207, 1083208, 1083209, 1083210, 1083211, 1083212, 1083213, 1083214,
    1083215, 1083216, 1083217, 1083218, 1083219, 1083220, 1083221, 1083222, 1083223, 1083224, 1083225, 1083226, 1083227,
    1083228, 1083229, 1083230, 1083231, 1083232, 1083233, 1083234, 1083235, 1083236, 1083237, 1083238, 1083239, 1083240,
    1083241, 1083242, 1083243, 1083244, 1083245, 1083246, 1083247, 1083248, 1083249, 1083250, 1083251, 1083252, 1083253,
    1083254, 1083255, 1083256, 1083257, 1083258, 1083259, 1083260, 1083261, 1083262, 1083263, 1083264, 1083265, 1083266,
    1083267, 1083268, 1083269, 1083270, 1083271, 1083272, 1083273, 1083274, 1083275, 1083276, 1083277, 1083278, 1083279,
    1083280, 1083281, 1083282, 1083283, 1083284, 1083285, 1083286, 1083287, 1083288, 1083289, 1083290, 1083291, 1083292,
    1083293, 1083294, 1083295, 1083296, 1083297, 1083298, 1083299, 1083300, 1083301, 1083302, 1083303, 1083304, 1083305,
    1083306, 1083307, 1083308, 1083309, 1083310, 1083311, 1083312, 1083313, 1083314, 1083315, 1083316, 1083317, 1083318,
    1083319, 1083320, 1083321, 1083322, 1083323, 1083324, 1083325, 1083326, 1083327, 1083328, 1083329, 1083330, 1083331,
    1083332, 1083333, 1083334, 1083335, 1083336, 1083337, 1083338, 1083339, 1083340, 1083341, 1083342, 1083343, 1083344,
    1083345, 1083346, 1083347, 1083348, 1083349, 1083350, 1083351, 1083352, 1083353, 1083354, 1083355, 1083356, 1083357,
    1083358, 1083359, 1083360, 1083361, 1083362, 1083363, 1083364, 1083365, 1083366, 1083367, 1083368, 1083369, 1083370,
    1083371, 1083372, 1083373, 1083374, 1083375, 1083376, 1083377, 1083378, 1083379, 1083380, 1083381, 1083382, 1083383,
    1083384, 1083385, 1083386, 1083387, 1083388, 1083389, 1083390, 1083391, 1083392, 1083393, 1083394, 1083395, 1083396,
    1083397, 1083398, 1083399, 1083400, 1083401, 1083402, 1083404, 1083405, 1083406, 1083407, 1083408, 1083409, 1083410,
    1083411, 1083412, 1083413, 1083414, 1083415, 1083416, 1083417, 1083418, 1083419, 1083420, 1083421, 1083422, 1083423,
    1083424, 1083425, 1083426, 1083427, 1083428, 1083429, 1083430, 1083431, 1083432, 1083433, 1083434, 1083435, 1083436,
    1083437, 1083438, 1083439, 1083440, 1083441, 1083442, 1083443, 1083444, 1083445, 1083446, 1083447, 1083448, 1083449,
    1083450, 1083451, 1083452, 1083453, 1083454, 1083455, 1083456, 1083457, 1083458, 1083459, 1083460, 1083461, 1083462,
    1083463, 1083464, 1083465, 1083466, 1083467, 1083468, 1083469, 1083470, 1083471, 1083472, 1083473, 1083474, 1083475,
    1083476, 1083477, 1083478, 1083479, 1083480, 1083481, 1083482, 1083483, 1083484, 1083485, 1083486, 1083487, 1083488,
    1083489, 1083490, 1083491, 1083492, 1083493, 1083494, 1083495, 1083496, 1083497, 1083498, 1083499, 1083500, 1083501,
    1083502, 1083503, 1083504, 1083505, 1083506, 1083507, 1083508, 1083509, 1083510, 1083511, 1083512, 1083513, 1083514,
    1083515, 1083516, 1083517, 1083518, 1083520, 1083521, 1083522, 1083523, 1083524, 1083525, 1083526, 1083527, 1083528,
    1083529, 1083530, 1083531, 1083532, 1083533, 1083534, 1083535, 1083536, 1083537, 1083538, 1083539, 1083540, 1083541,
    1083542, 1083543, 1083544, 1083545, 1083546, 1083547, 1083548, 1083549, 1083550, 1083551, 1083552, 1083553, 1083554,
    1083555, 1083556, 1083557, 1083558, 1083559, 1083560, 1083561, 1083562, 1083563, 1083564, 1083565, 1083566, 1083567,
    1083568, 1083569, 1083570, 1083571, 1083572, 1083573, 1083574, 1083575, 1083576, 1083577, 1083578, 1083579, 1083580,
    1083581, 1083582, 1083583, 1083584, 1083585, 1083586, 1083587, 1083588, 1083589, 1083590, 1083591, 1083592, 1083593,
    1083594, 1083595, 1083596, 1083597, 1083598, 1083599, 1083600, 1083601, 1083602, 1083603, 1083604, 1083605, 1083606,
    1083607, 1083608, 1083609, 1083610, 1083611, 1083612, 1083613, 1083614, 1083615, 1083616, 1083617, 1083618, 1083619,
    1083620, 1083621, 1083622, 1083623, 1083624, 1083625, 1083626, 1083627, 1083628, 1083629, 1083630, 1083631, 1083632,
    1083633, 1083634, 1083635, 1083636, 1083637, 1083638, 1083639, 1083640, 1083641, 1083642, 1083643, 1083644, 1083645,
    1083646, 1083647, 1083648, 1083649, 1083650, 1083651, 1083652, 1083653, 1083654, 1083655, 1083656, 1083657, 1083658,
    1083659, 1083660, 1083661, 1083662, 1083663, 1083664, 1083665, 1083666, 1083667, 1083668, 1083669, 1083670, 1083671,
    1083672, 1083673, 1083674, 1083675, 1083676, 1083677, 1083678, 1083679, 1083680, 1083681, 1083682, 1083683, 1083684,
    1083685, 1083686, 1083687, 1083688, 1083689, 1083690, 1083691, 1083692, 1083693, 1083694, 1083695, 1083696, 1083697,
    1083698, 1083699, 1083700, 1083701, 1083702, 1083703, 1083704, 1083705, 1083706, 1083707, 1083708, 1083709, 1083710,
    1083711, 1083712, 1083713, 1083714, 1083715, 1083716, 1083717, 1083718, 1083719, 1083720, 1083721, 1083722, 1083723,
    1083724, 1083725, 1083726, 1083727, 1083728, 1083729, 1083730, 1083731, 1083732, 1083733, 1083734, 1083735, 1083736,
    1083737, 1083738, 1083739, 1083740, 1083741, 1083742, 1083743, 1083744, 1083745, 1083746, 1083747, 1083748, 1083749,
    1083750, 1083751, 1083752, 1083753, 1083754, 1083755, 1083756, 1083757, 1083758, 1083759, 1083760, 1083761, 1083762,
    1083763, 1083764, 1083765, 1083766, 1083767, 1083768, 1083769, 1083770, 1083771, 1083772, 1083773, 1083774, 1083775,
    1083776, 1083777, 1083778, 1083779, 1083780, 1083781, 1083782, 1083783, 1083784, 1083785, 1083786, 1083787, 1083788,
    1083789, 1083790, 1083791, 1083792, 1083793, 1083794, 1083795, 1083796, 1083797, 1083798, 1083799, 1083800, 1083801,
    1083802, 1083803, 1083804, 1083805, 1083806, 1083807, 1083808, 1083809, 1083810, 1083811, 1083812, 1083813, 1083814,
    1083815, 1083816, 1083817, 1083818, 1083819, 1083820, 1083821, 1083822, 1083823, 1083824, 1083825, 1083826, 1083827,
    1083828, 1083829, 1083830, 1083831, 1083832, 1083833, 1083834, 1083835, 1083836, 1083837, 1083838, 1083839, 1083840,
    1083841, 1083842, 1083843, 1083844, 1083845, 1083846, 1083847, 1083848,
]);
if (V07_COMPOSED_REMAP_ORDINALS.length !== V07_COMPOSED_COLLIDING_MAIN_ORDINALS.length) {
    throw new Error("Composed-ranked collision and remap ordinal lists differ in length");
}
const V07_COMPOSED_ORDINAL_OVERRIDE_BY_MAIN = new Map(
    V07_COMPOSED_COLLIDING_MAIN_ORDINALS.map((ordinal, index) => [ordinal, V07_COMPOSED_REMAP_ORDINALS[index]]),
);
export const V07_COMPOSED_TAXONOMY_MAX_ATTEMPTS = 128;
export const V07_COMPOSED_FORMAL_Z = 3.1018618337400956;
export const V07_COMPOSED_TAXONOMY_CELL_IDS: Readonly<Record<V07Archetype, string>> = {
    mage: "ranked_mage_conservative200_275",
    meleeMage: "ranked_melee_mage_conservative200_275",
    aura: "ranked_aura_conservative200_275",
    ranged: "ranked_ranged_conservative200_275",
};

export const V07_COMPOSED_CELL_IDS = [
    "round1_search_off_symmetry",
    "round1_search_uncapped",
    "round1_search_server300",
    "round1_search_conservative200_275",
    ...V07_ARCHETYPES.map((archetype) => V07_COMPOSED_TAXONOMY_CELL_IDS[archetype]),
    ...V07_ARCHETYPE_TEMPLATE_NAMES.map((name) => `${name}_conservative200_275`),
] as const;

const permutationWord = (label: string): number =>
    Number.parseInt(
        createHash("sha256")
            .update(`${V07_COMPOSED_SEED_DOMAIN}|${V07_COMPOSED_PERMUTATION_NONCE}|${label}`)
            .digest("hex")
            .slice(0, 8),
        16,
    );
export const V07_COMPOSED_PERMUTATION_OFFSET = permutationWord("permutation-offset");
export const V07_COMPOSED_PERMUTATION_ODD_STEP = (permutationWord("permutation-odd-step") | 1) >>> 0;

const V07_COMPOSED_SERVER_SOURCE_PATHS = [
    "src/api/game/v1/draft_policy.ts",
    "src/api/game/v1/setup_policy.ts",
    "src/api/game/v1/bot_search.ts",
    "src/api/game/v1/play_session.ts",
] as const;
const V07_COMPOSED_SERVER_REFERENCE = {
    serverCommit: "2495acaac8a166d5d95ab37d5cf896edcb79dc82",
    lockedCommonCommit: "ded20c9b9ae526caea8aa1f86ed0227e08060156",
    lockfileSha256: "791adf672790e189bd26726ddddc3ae19430020483c40158a4fb4ec0fab40264",
    sourceSha256: {
        "src/api/game/v1/draft_policy.ts": "ac91b60180a0e4a1ef6833a3614eae5840078d9f4b9a1fa04485ac7ad48c9fda",
        "src/api/game/v1/setup_policy.ts": "4910752c0e44d38415150198c6aae240371fb5b0939f8fc88880c7a1ab98c055",
        "src/api/game/v1/bot_search.ts": "e78ab509960c693fb8ba9605e05acbe2554909c3c25c8215dfd9a9d97178761b",
        "src/api/game/v1/play_session.ts": "9fc97d71e18ed2e22ad69e628c428837ff03be5ad61f47347bdf577ce8ef5c0e",
    },
} as const;

const V07_COMPOSED_OBSERVED_BENCHMARK = {
    evidencePurpose: "seed_schedule_recovery_only_reported_outcome_runtime_not_attested",
    userReported: true,
    originalExecutionPath: "src/simulation/winrate_v07_v06_tmp.ts",
    scriptEvidencePath: "docs/evidence/v0_7_v0_6_100k_driver_20260715.ts",
    scriptSha256: "61901fb9c26420f15747a1855b770930da23bf47ed509ac1e515a7411d65a409",
    concurrentTournamentSourcePath: "src/simulation/concurrent_tournament.ts",
    concurrentTournamentSourceSha256: "396030e57c91b056770dd6565c02953d9acdb7f428cc2a047a06c96f5f4de35e",
    tournamentWorkerSourcePath: "src/simulation/tournament_worker.ts",
    tournamentWorkerSourceSha256: "56ae0c1d735622dfeeb6c53e3c492370b596669466285d2ec0b16c1e25dff3ba",
    tournamentSourcePath: "src/simulation/tournament.ts",
    tournamentSourceSha256: "f879a423261182a26bc69623d10e032d4a074a824ec4fa6c2239cef09d4afe58",
    versions: ["v0.7", "v0.6"],
    cohorts: 4,
    gamesPerCohort: 25000,
    baseSeed: 100000,
    streamStride: 1000000,
    pairSeedStep: 2654435761,
    expandedPairSeeds: 50000,
    outcome: { candidateWins: 53456, opponentWins: 39487, draws: 7057 },
} as const;

const V07_COMPOSED_FORBIDDEN_RUNTIME_ENVIRONMENT_KEYS = [
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

const V07_COMPOSED_RUNTIME_DEPENDENCIES = ["denque", "google-protobuf"] as const;

export const V07_COMPOSED_ORIGIN_IDENTITY = "github.com/o1dstars/heroes-of-crypto-common" as const;

export const V07_COMPOSED_REQUIRED_SOURCE_PATHS = [
    "tsconfig.json",
    "src/ai/index.ts",
    "src/ai/setup/draft_ship.ts",
    "src/ai/setup/setup_conditional.ts",
    "src/ai/versions/v0_7.ts",
    "src/ai/versions/v0_7s.ts",
    "src/picks/pick_sim.ts",
    "src/simulation/battle_engine.ts",
    "src/simulation/league_genome.ts",
    "src/simulation/measure_setup_conditional.ts",
    "src/simulation/search_driver.ts",
    "src/simulation/v0_7_archetype_battery.ts",
    "src/simulation/v0_7_composed_ranked_ladder.ts",
    "src/simulation/v0_7_composed_ranked_ladder_worker.ts",
    "src/simulation/v0_7_composed_seed_scan.ts",
] as const;

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

const stableEnvironment = (environment: Readonly<Record<string, string>>): Record<string, string> =>
    Object.fromEntries(Object.entries(environment).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

export const environmentFingerprint = (environment: Readonly<Record<string, string>>): string =>
    sha256(JSON.stringify(stableEnvironment(environment)));

export function preregisteredV07ComposedBaseSeed(cellId: string): number {
    const ordinal = v07ComposedCellBaseOrdinal(cellId);
    return v07ComposedSeedForLogicalSlot(`${cellId}/0/scenario_root`, ordinal);
}

export function isV07ComposedBehaviorEnvironmentKey(key: string): boolean {
    return (
        V07_COMPOSED_BEHAVIOR_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
        (V07_COMPOSED_BEHAVIOR_ENV_EXACT as readonly string[]).includes(key)
    );
}

/** Canonical server-profile knobs. SEARCH_AUDIT is supplied per worker and intentionally not inherited. */
export function canonicalV07ComposedEnvironment(
    profile: IV07ComposedSearchProfile,
    auditPath: string,
): Record<string, string> {
    return stableEnvironment({
        V07_SEARCH: profile.search ? "1" : "0",
        SEARCH_VERSIONS: "v0.7s",
        SEARCH_GATE: String(profile.gate),
        SEARCH_HORIZON: String(profile.horizon),
        SEARCH_ROLLOUTS: String(profile.rollouts),
        SEARCH_INCLUDE_MOVES: "0",
        SEARCH_MAX_MOVES: String(profile.maxMoves),
        SEARCH_MAX_MELEE: String(profile.maxMelee),
        SEARCH_MAX_SHOTS: String(profile.maxShots),
        SEARCH_MAX_THROWS: String(profile.maxThrows),
        SEARCH_ACTIVE_CHALLENGERS: "0",
        SEARCH_SHORTLIST: "",
        SEARCH_DECISION_DEADLINE_MS: profile.decisionDeadlineMs === null ? "" : String(profile.decisionDeadlineMs),
        SEARCH_CIRCUIT_BREAKER_MS: profile.circuitBreakerMs === null ? "0" : String(profile.circuitBreakerMs),
        SEARCH_OPP_MODEL: "",
        SEARCH_AUDIT: auditPath,
        SEARCH_AUDIT_TURNS: "0",
        SEARCH_LATE_RANGED_FINISH_WEIGHT: "0",
        SEARCH_PURE_RANGED_TERMINAL_WEIGHT: "0",
        V07_VALUE_WEIGHTS: "",
        V07_VALUE_WEIGHTS_V2: "",
        Q2_ORACLE: "0",
        Q2_WAIT_ABLATION: "0",
    });
}

function fileSha256(path: string): string {
    return sha256(readFileSync(path));
}

export function v07ComposedRuntimeTreeFingerprint(commonRoot = process.cwd()): { files: number; sha256: string } {
    const sourceRoot = resolve(commonRoot, "src");
    const excluded = ["src/simulation/manifests/", "src/simulation/results/"] as const;
    const files: string[] = [];
    const walk = (directory: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            const relativePath = relative(commonRoot, path).replaceAll("\\", "/");
            if (excluded.some((prefix) => relativePath.startsWith(prefix))) continue;
            if (entry.isDirectory()) walk(path);
            else if (entry.isFile()) files.push(relativePath);
            else throw new Error(`Runtime source tree contains unsupported entry ${relativePath}`);
        }
    };
    walk(sourceRoot);
    files.sort();
    const hash = createHash("sha256");
    for (const path of files) {
        hash.update(path);
        hash.update("\0");
        hash.update(readFileSync(resolve(commonRoot, path)));
        hash.update("\0");
    }
    return { files: files.length, sha256: hash.digest("hex") };
}

export function v07ComposedDirectoryFingerprint(directory: string): { files: number; sha256: string } {
    const root = resolve(directory);
    const files: string[] = [];
    const walk = (current: string): void => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const path = join(current, entry.name);
            if (entry.isDirectory()) walk(path);
            else if (entry.isFile()) files.push(relative(root, path).replaceAll("\\", "/"));
            else throw new Error(`Runtime dependency tree contains unsupported entry ${path}`);
        }
    };
    walk(root);
    files.sort();
    const hash = createHash("sha256");
    for (const path of files) {
        hash.update(path);
        hash.update("\0");
        hash.update(readFileSync(resolve(root, path)));
        hash.update("\0");
    }
    return { files: files.length, sha256: hash.digest("hex") };
}

function assertSafeId(value: string, label: string): void {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(value)) throw new Error(`${label} is not a safe id: ${value}`);
}

function sameMembers(actual: readonly string[], expected: readonly string[]): boolean {
    return actual.length === expected.length && expected.every((value) => actual.includes(value));
}

export function validateV07ComposedManifest(manifest: IV07ComposedManifest): void {
    if (manifest.schemaVersion !== 1) throw new Error("Composed-ranked manifest schemaVersion must be 1");
    assertSafeId(manifest.manifestId, "manifestId");
    const createdAt = Date.parse(manifest.createdAt);
    if (
        !Number.isFinite(createdAt) ||
        new Date(createdAt).toISOString().replace(".000Z", "Z") !== manifest.createdAt ||
        createdAt > Date.now() ||
        createdAt < Date.parse(manifest.seedAudit.performedAt)
    ) {
        throw new Error("Manifest createdAt must be an actual post-audit ISO-8601 freeze time");
    }
    if (manifest.status !== "research_only_no_bake") throw new Error("Manifest must remain research-only");
    if (manifest.candidate !== "v0.7s" || manifest.rankedOpponent !== "v0.6") {
        throw new Error("Manifest must compare v0.7s with v0.6");
    }
    if (
        manifest.seedPermutation.domain !== V07_COMPOSED_SEED_DOMAIN ||
        manifest.seedPermutation.nonce !== V07_COMPOSED_PERMUTATION_NONCE ||
        manifest.seedPermutation.construction !==
            "sha256_parameterized_affine_uint32_bijection_with_collision_remaps" ||
        manifest.seedPermutation.offset !== V07_COMPOSED_PERMUTATION_OFFSET ||
        manifest.seedPermutation.oddStep !== V07_COMPOSED_PERMUTATION_ODD_STEP ||
        (manifest.seedPermutation.oddStep & 1) !== 1 ||
        manifest.draft.spec !== LEAGUE_ROUND1_DRAFT_SPEC ||
        manifest.draft.setupRules !== "all" ||
        manifest.draft.setupAppliedTo !== "both_teams" ||
        manifest.draft.persistedPickOrder !== true ||
        manifest.draft.fixedCellsOnePickPerScenario !== true ||
        manifest.draft.fixedCellsPhysicalArmiesFixedWithinSideSwap !== true ||
        manifest.draft.taxonomyCellsIndependentSeatConditioned !== true ||
        manifest.draft.taxonomyCandidateTraitMinimum !== 1 ||
        manifest.draft.taxonomyMaxSetupAttemptsPerSeat !== V07_COMPOSED_TAXONOMY_MAX_ATTEMPTS ||
        manifest.draft.taxonomySha256 !== sha256(JSON.stringify(V07_ARCHETYPE_TAXONOMY)) ||
        manifest.draft.candidateSide !== "even_lower_green_odd_upper_red" ||
        manifest.draft.seedDerivation !==
            "sha256_parameterized_affine_uint32_bijection_distinct_slots_no_independence_claim" ||
        manifest.draft.setupAndCombatSubSeedsSeparated !== true
    ) {
        throw new Error("Manifest changed the frozen composed-ranked draft/setup/pair protocol");
    }
    if (
        manifest.draft.taxonomyPlan.rows !== 8000 ||
        !/^[0-9a-f]{64}$/.test(manifest.draft.taxonomyPlan.sha256) ||
        !sameMembers(Object.keys(manifest.draft.taxonomyPlan.cells), Object.values(V07_COMPOSED_TAXONOMY_CELL_IDS))
    ) {
        throw new Error("Manifest exact registered taxonomy plan is incomplete");
    }
    for (const [cellId, plan] of Object.entries(manifest.draft.taxonomyPlan.cells)) {
        if (plan.pairs !== 1000) throw new Error(`${cellId}: taxonomy plan must cover exactly 1,000 pairs`);
        for (const seat of ["candidate_green", "candidate_red"] as const) {
            const summary = plan[seat];
            const histogram = Object.entries(summary.acceptedAttemptHistogram);
            if (
                summary.streams !== 1000 ||
                !Number.isSafeInteger(summary.totalAttempts) ||
                summary.totalAttempts < 0 ||
                summary.meanAttempt !== summary.totalAttempts / summary.streams ||
                summary.totalProposals !== summary.totalAttempts + summary.streams ||
                summary.meanProposals !== summary.totalProposals / summary.streams ||
                !Number.isSafeInteger(summary.maxAttempt) ||
                summary.maxAttempt < 0 ||
                summary.maxAttempt >= V07_COMPOSED_TAXONOMY_MAX_ATTEMPTS ||
                histogram.reduce((sum, [, count]) => sum + count, 0) !== summary.streams ||
                histogram.some(
                    ([attempt, count]) =>
                        !/^(?:0|[1-9][0-9]*)$/.test(attempt) ||
                        Number(attempt) > summary.maxAttempt ||
                        !Number.isSafeInteger(count) ||
                        count < 1,
                )
            ) {
                throw new Error(`${cellId}/${seat}: taxonomy plan summary is inconsistent`);
            }
        }
    }
    if (!sameMembers(Object.keys(manifest.searchProfiles), PROFILE_IDS)) {
        throw new Error("Manifest must define exactly the four frozen search profiles");
    }
    for (const id of PROFILE_IDS) {
        const profile = manifest.searchProfiles[id];
        if (
            profile.id !== id ||
            profile.gate !== 0.01 ||
            profile.horizon !== 12 ||
            profile.rollouts !== 3 ||
            profile.includeMoves !== false ||
            profile.maxMoves !== 1 ||
            profile.maxMelee !== 8 ||
            profile.maxShots !== 6 ||
            profile.maxThrows !== 4 ||
            profile.activeChallengers !== false ||
            profile.shortlist !== null ||
            profile.leaf !== "learned" ||
            profile.opponentModel !== null ||
            profile.lateRangedFinishWeight !== 0 ||
            profile.pureRangedTerminalWeight !== 0
        ) {
            throw new Error(`Profile ${id} changed a frozen server search knob`);
        }
    }
    const expectedProfileShape: Record<
        V07ComposedProfileId,
        readonly [boolean, number | null, number | null, boolean]
    > = {
        off: [false, null, null, false],
        uncapped: [true, null, null, false],
        server_300: [true, null, 300, false],
        conservative_200_275: [true, 200, 275, true],
    };
    for (const id of PROFILE_IDS) {
        const profile = manifest.searchProfiles[id];
        const expected = expectedProfileShape[id];
        if (
            profile.search !== expected[0] ||
            profile.decisionDeadlineMs !== expected[1] ||
            profile.circuitBreakerMs !== expected[2] ||
            profile.qualification !== expected[3] ||
            !profile.parityNote.trim()
        ) {
            throw new Error(`Profile ${id} changed its deadline/circuit definition`);
        }
    }
    const expectedCellIds = V07_COMPOSED_CELL_IDS;
    if (JSON.stringify(manifest.cells.map((cell) => cell.id)) !== JSON.stringify(expectedCellIds)) {
        throw new Error("Manifest must define exactly four ranked, four taxonomy, and eight fixed-template cells");
    }
    type ExpectedCell = Omit<IV07ComposedCell, "id" | "candidate" | "baseSeed" | "pairScenarios" | "purpose">;
    const expectedCell = (id: string): ExpectedCell => {
        const ranked: Record<string, ExpectedCell> = {
            round1_search_off_symmetry: {
                stage: 0,
                distribution: "ranked_round1",
                scenarioProtocol: "fixed_physical_side_swap",
                profile: "off",
                opponent: "v0.7",
                games: 2000,
                qualification: false,
            },
            round1_search_uncapped: {
                stage: 1,
                distribution: "ranked_round1",
                scenarioProtocol: "fixed_physical_side_swap",
                profile: "uncapped",
                opponent: "v0.6",
                games: 4000,
                qualification: false,
            },
            round1_search_server300: {
                stage: 1,
                distribution: "ranked_round1",
                scenarioProtocol: "fixed_physical_side_swap",
                profile: "server_300",
                opponent: "v0.6",
                games: 4000,
                qualification: false,
            },
            round1_search_conservative200_275: {
                stage: 1,
                distribution: "ranked_round1",
                scenarioProtocol: "fixed_physical_side_swap",
                profile: "conservative_200_275",
                opponent: "v0.6",
                games: 4000,
                qualification: true,
            },
        };
        if (ranked[id]) return ranked[id];
        const taxonomy = V07_ARCHETYPES.find((archetype) => V07_COMPOSED_TAXONOMY_CELL_IDS[archetype] === id);
        if (taxonomy) {
            return {
                stage: 2,
                distribution: "ranked_taxonomy",
                scenarioProtocol: "independent_seat_conditioned",
                archetype: taxonomy,
                profile: "conservative_200_275",
                opponent: "v0.6",
                games: 2000,
                qualification: true,
            };
        }
        const suffix = "_conservative200_275";
        const template = id.endsWith(suffix) ? id.slice(0, -suffix.length) : "";
        if (!V07_ARCHETYPE_TEMPLATE_NAMES.includes(template as V07ArchetypeTemplateName)) {
            throw new Error(`Unknown composed-ranked cell ${id}`);
        }
        return {
            stage: 3,
            distribution: "fixed_template",
            scenarioProtocol: "fixed_physical_side_swap",
            archetype: v07ArchetypeTemplate(template as V07ArchetypeTemplateName).archetype,
            template: template as V07ArchetypeTemplateName,
            profile: "conservative_200_275",
            opponent: "v0.6",
            games: 2000,
            qualification: true,
        };
    };
    const seenSeeds = new Map<number, string>();
    for (const cell of manifest.cells) {
        assertSafeId(cell.id, "cell id");
        if (!Number.isSafeInteger(cell.games) || cell.games < 2 || cell.games % 2 !== 0) {
            throw new Error(`${cell.id}: games must be a positive even integer`);
        }
        if (cell.pairScenarios !== cell.games / 2) throw new Error(`${cell.id}: pairScenarios mismatch`);
        if (!Number.isSafeInteger(cell.baseSeed) || cell.baseSeed < 0 || cell.baseSeed > 0xffffffff) {
            throw new Error(`${cell.id}: baseSeed must be uint32`);
        }
        if (cell.candidate !== "v0.7s") throw new Error(`${cell.id}: candidate must be v0.7s`);
        const expected = expectedCell(cell.id);
        if (
            cell.stage !== expected.stage ||
            cell.distribution !== expected.distribution ||
            cell.scenarioProtocol !== expected.scenarioProtocol ||
            cell.archetype !== expected.archetype ||
            cell.template !== expected.template ||
            cell.profile !== expected.profile ||
            cell.opponent !== expected.opponent ||
            cell.games !== expected.games ||
            cell.qualification !== expected.qualification ||
            cell.baseSeed !== preregisteredV07ComposedBaseSeed(cell.id) ||
            !cell.purpose.trim()
        ) {
            throw new Error(`${cell.id}: cell differs from the frozen preregistration`);
        }
        if (cell.distribution === "ranked_round1") {
            if (cell.template !== undefined || cell.archetype !== undefined) {
                throw new Error(`${cell.id}: unconditioned ranked cell cannot name a template/archetype/plan`);
            }
        } else if (cell.distribution === "ranked_taxonomy") {
            if (!cell.archetype || cell.template !== undefined) {
                throw new Error(`${cell.id}: taxonomy cell requires exactly one archetype`);
            }
        } else if (!cell.template || !V07_ARCHETYPE_TEMPLATE_NAMES.includes(cell.template)) {
            throw new Error(`${cell.id}: fixed cell requires an established template`);
        }
        if (cell.distribution === "fixed_template" && cell.profile !== "conservative_200_275") {
            throw new Error(`${cell.id}: fixed templates are frozen to conservative_200_275`);
        }
        if (cell.profile === "off" ? cell.opponent !== "v0.7" : cell.opponent !== "v0.6") {
            throw new Error(`${cell.id}: opponent is inconsistent with its profile`);
        }
        if (cell.qualification !== manifest.searchProfiles[cell.profile].qualification) {
            throw new Error(`${cell.id}: qualification marker disagrees with profile`);
        }
        for (let pair = 0; pair < cell.pairScenarios; pair += 1) {
            const seed = scenarioSeed(cell, pair);
            const previous = seenSeeds.get(seed);
            if (previous) throw new Error(`Seed ${seed} overlaps ${previous} and ${cell.id}/${pair}`);
            seenSeeds.set(seed, `${cell.id}/${pair}`);
        }
    }
    const pairScenarios = manifest.cells.reduce((sum, cell) => sum + cell.pairScenarios, 0);
    const games = manifest.cells.reduce((sum, cell) => sum + cell.games, 0);
    const searchGames = manifest.cells
        .filter((cell) => manifest.searchProfiles[cell.profile].search)
        .reduce((sum, cell) => sum + cell.games, 0);
    const reservedEnvelope = v07ComposedReservedSeedEnvelope(manifest);
    if (
        manifest.execution.pairScenarios !== pairScenarios ||
        manifest.execution.games !== games ||
        manifest.execution.searchGames !== searchGames ||
        manifest.execution.offControlGames !== games - searchGames ||
        manifest.execution.requiredConcurrency !== 12 ||
        manifest.execution.staging !== "one_cell_per_invocation_then_fail_closed_assembly" ||
        manifest.execution.stagePolicy !== "fixed_full_battery_chronology_not_outcome_adaptive" ||
        manifest.execution.allCellsRequiredAfterOutcomeFailure !== true ||
        manifest.execution.priorIntegrityOrControlFailureBlocks !== true ||
        manifest.execution.maxCellElapsedMs !== V07_COMPOSED_MAX_CELL_ELAPSED_MS ||
        manifest.execution.maxRunElapsedMs !== V07_COMPOSED_MAX_RUN_ELAPSED_MS ||
        !manifest.execution.estimatedRuntime.m4Max.trim() ||
        !manifest.execution.estimatedRuntime.zinc.trim() ||
        !manifest.execution.estimatedRuntime.basis.trim() ||
        manifest.seedAudit.plannedPairScenarios !== pairScenarios ||
        manifest.seedAudit.reservedDerivedSeedTokens !== reservedEnvelope.tokens ||
        manifest.seedAudit.reservedEnvelopeSha256 !== reservedEnvelope.sha256 ||
        reservedEnvelope.internalCollisions !== 0 ||
        manifest.seedAudit.internalCollisions !== 0 ||
        manifest.seedAudit.permutationNonce !== V07_COMPOSED_PERMUTATION_NONCE ||
        manifest.seedAudit.externalFreshnessScope !== "all_registered_scenario_setup_and_combat_seeds" ||
        manifest.seedAudit.scanPolicy !== V07_COMPOSED_SEED_SCAN_POLICY ||
        JSON.stringify(manifest.seedAudit.excludedRelativePaths) !==
            JSON.stringify(V07_COMPOSED_SEED_SCAN_EXCLUDED_RELATIVE_PATHS) ||
        JSON.stringify(manifest.seedAudit.knownReservedSeedsVerified) !== JSON.stringify([386585164, 1955955948]) ||
        manifest.seedAudit.local.collisionsAfterRemap !== 0 ||
        manifest.seedAudit.zinc.collisionsAfterRemap !== 0 ||
        !Number.isFinite(Date.parse(manifest.seedAudit.local.cutoff)) ||
        !Number.isFinite(Date.parse(manifest.seedAudit.zinc.cutoff)) ||
        Date.parse(manifest.seedAudit.local.cutoff) > Date.parse(manifest.seedAudit.performedAt) ||
        Date.parse(manifest.seedAudit.zinc.cutoff) > Date.parse(manifest.seedAudit.performedAt) ||
        [manifest.seedAudit.local, manifest.seedAudit.zinc].some(
            (corpus) =>
                resolve(corpus.scannerSourcePath) !== corpus.scannerSourcePath ||
                !/^[0-9a-f]{64}$/.test(corpus.scannerSourceSha256) ||
                resolve(corpus.scannerConfigPath) !== corpus.scannerConfigPath ||
                !/^[0-9a-f]{64}$/.test(corpus.scannerConfigSha256) ||
                resolve(corpus.seedSetOutputPath) !== corpus.seedSetOutputPath ||
                resolve(corpus.scannerSummaryOutputPath) !== corpus.scannerSummaryOutputPath ||
                corpus.seedSetOutputPath === corpus.scannerSummaryOutputPath ||
                !corpus.commonRoot.trim() ||
                !corpus.priorManifestExpanderPath.trim() ||
                corpus.priorManifestExpanderPath !==
                    resolve(corpus.commonRoot, "src/simulation/optimizer/v0_7_96h_core.ts") ||
                !/^[0-9a-f]{64}$/.test(corpus.priorManifestExpanderSha256) ||
                !Array.isArray(corpus.roots) ||
                corpus.roots.length < 1 ||
                corpus.roots.some((root) => !root.trim()) ||
                !Array.isArray(corpus.rootDiscovery) ||
                corpus.rootDiscovery.some((entry) => !entry.parent.trim() || !entry.namePrefix.trim()) ||
                !Array.isArray(corpus.excluded) ||
                corpus.excluded.some((path) => !path.trim()) ||
                !Array.isArray(corpus.excludedPathPrefixes) ||
                new Set(corpus.excludedPathPrefixes).size !== corpus.excludedPathPrefixes.length ||
                corpus.excludedPathPrefixes.some(
                    (prefix) => !prefix.startsWith("/") || !/[._a-zA-Z0-9][_-]$/.test(prefix),
                ) ||
                JSON.stringify(corpus.excludedPathPrefixes) !==
                    JSON.stringify([...corpus.excludedPathPrefixes].sort()) ||
                JSON.stringify(corpus.excludedRelativeSuffixes) !==
                    JSON.stringify(V07_COMPOSED_SEED_SCAN_EXCLUDED_RELATIVE_PATHS) ||
                !Number.isSafeInteger(corpus.files) ||
                corpus.files < 1 ||
                !Number.isSafeInteger(corpus.textFiles) ||
                corpus.textFiles < 1 ||
                !Number.isSafeInteger(corpus.structuredFiles) ||
                corpus.structuredFiles < 1 ||
                !Number.isSafeInteger(corpus.expandedManifests) ||
                corpus.expandedManifests < 1 ||
                !Array.isArray(corpus.tournamentSeries) ||
                !Array.isArray(corpus.derivedTournamentSchedules) ||
                corpus.derivedTournamentSchedulesSha256 !==
                    fingerprintV07ComposedDerivedTournamentSchedules(corpus.derivedTournamentSchedules) ||
                !Array.isArray(corpus.derivedProtocolSchedules) ||
                corpus.derivedProtocolSchedulesSha256 !==
                    fingerprintV07ComposedDerivedProtocolSchedules(corpus.derivedProtocolSchedules) ||
                corpus.derivedProtocolSeedSetSha256 !==
                    fingerprintV07ComposedSeedSet(
                        expandV07ComposedDerivedProtocolSchedules(corpus.derivedProtocolSchedules),
                    ) ||
                !Number.isSafeInteger(corpus.expandedInlineTournamentPanels) ||
                corpus.expandedInlineTournamentPanels < 0 ||
                !Number.isSafeInteger(corpus.expandedInlineLeaguePanels) ||
                corpus.expandedInlineLeaguePanels < 0 ||
                !Number.isSafeInteger(corpus.expandedRecoveredLedgerStreams) ||
                corpus.expandedRecoveredLedgerStreams < 0 ||
                !Number.isSafeInteger(corpus.expandedTournamentSeeds) ||
                corpus.expandedTournamentSeeds < 0 ||
                !Number.isSafeInteger(corpus.expandedDerivedScheduleSeeds) ||
                corpus.expandedDerivedScheduleSeeds < 0 ||
                expandV07ComposedDerivedTournamentSchedules(corpus.derivedTournamentSchedules).length !==
                    corpus.expandedDerivedScheduleSeeds ||
                !Number.isSafeInteger(corpus.expandedDerivedProtocolSeeds) ||
                corpus.expandedDerivedProtocolSeeds < 0 ||
                expandV07ComposedDerivedProtocolSchedules(corpus.derivedProtocolSchedules).length !==
                    corpus.expandedDerivedProtocolSeeds ||
                !Number.isSafeInteger(corpus.expandedInlineLeagueSeeds) ||
                corpus.expandedInlineLeagueSeeds < 0 ||
                !Number.isSafeInteger(corpus.expandedRecoveredLedgerSeeds) ||
                corpus.expandedRecoveredLedgerSeeds < 0 ||
                !Number.isSafeInteger(corpus.matchedSeedTokens) ||
                corpus.matchedSeedTokens < corpus.uniqueSeeds ||
                !Number.isSafeInteger(corpus.uniqueSeeds) ||
                corpus.uniqueSeeds < 1 ||
                !Number.isSafeInteger(corpus.originalCollisionLogicalSlots) ||
                corpus.originalCollisionLogicalSlots < 0 ||
                !/^[0-9a-f]{64}$/.test(corpus.corpusFileSnapshotSha256) ||
                !/^[0-9a-f]{64}$/.test(corpus.corpusSeedSetSha256) ||
                !/^[0-9a-f]{64}$/.test(corpus.scannerSummarySha256),
        ) ||
        JSON.stringify(manifest.seedAudit.local.excludedPathPrefixes) !== "[]" ||
        JSON.stringify(manifest.seedAudit.zinc.excludedPathPrefixes) !==
            JSON.stringify(V07_COMPOSED_ZINC_GENERATED_PATH_PREFIX_EXCLUSIONS) ||
        JSON.stringify(manifest.seedAudit.zinc.excluded) !== JSON.stringify(V07_COMPOSED_ZINC_CORPUS_EXCLUSIONS) ||
        manifest.seedAudit.local.scannerSourceSha256 !== manifest.seedAudit.zinc.scannerSourceSha256 ||
        manifest.seedAudit.local.scannerSourceSha256 !==
            manifest.sourceProvenance.requiredSha256["src/simulation/v0_7_composed_seed_scan.ts"] ||
        !/^[0-9a-f]{64}$/.test(manifest.seedAudit.local.corpusSeedSetSha256) ||
        !/^[0-9a-f]{64}$/.test(manifest.seedAudit.zinc.corpusSeedSetSha256) ||
        manifest.seedAudit.local.corpusSeedSetSha256 === "0".repeat(64) ||
        manifest.seedAudit.zinc.corpusSeedSetSha256 === "0".repeat(64) ||
        !Number.isFinite(Date.parse(manifest.seedAudit.performedAt)) ||
        Date.parse(manifest.seedAudit.performedAt) > Date.now() ||
        !manifest.seedAudit.derivation.trim() ||
        !manifest.seedAudit.logicalSlotLayout.trim() ||
        !manifest.seedAudit.declaration.trim() ||
        /\b(?:draft|pending)\b/i.test(manifest.seedAudit.declaration)
    ) {
        throw new Error("Manifest execution or seed-audit totals are inconsistent");
    }
    const concurrentGuard = manifest.seedAudit.zinc.concurrentGuard;
    if (!concurrentGuard?.activeCemClosure || !concurrentGuard.prelaunchCheckpoint) {
        throw new Error("Manifest lacks the Zinc concurrent guard or active CEM closure binding");
    }
    const activeCemSchedule = manifest.seedAudit.zinc.derivedTournamentSchedules.find(
        (schedule) => schedule.id === concurrentGuard.activeCemClosure.scheduleId,
    );
    const checkpointFirst = Date.parse(concurrentGuard.prelaunchCheckpoint.firstCapturedAt);
    const checkpointLast = Date.parse(concurrentGuard.prelaunchCheckpoint.lastCapturedAt);
    const zincCutoff = Date.parse(manifest.seedAudit.zinc.cutoff);
    const sealBefore = Date.parse(concurrentGuard.sealBefore);
    if (
        !concurrentGuard.guardId.trim() ||
        resolve(concurrentGuard.contractPath) !== concurrentGuard.contractPath ||
        !/^[0-9a-f]{64}$/.test(concurrentGuard.contractSha256) ||
        resolve(concurrentGuard.initialSnapshotPath) !== concurrentGuard.initialSnapshotPath ||
        !/^[0-9a-f]{64}$/.test(concurrentGuard.initialSnapshotSha256) ||
        resolve(concurrentGuard.prelaunchCheckpoint.ledgerPath) !== concurrentGuard.prelaunchCheckpoint.ledgerPath ||
        !/^[0-9a-f]{64}$/.test(concurrentGuard.prelaunchCheckpoint.ledgerSha256) ||
        !Number.isSafeInteger(concurrentGuard.prelaunchCheckpoint.entries) ||
        concurrentGuard.prelaunchCheckpoint.entries < 2 ||
        !Number.isFinite(checkpointFirst) ||
        !Number.isFinite(checkpointLast) ||
        new Date(checkpointFirst).toISOString().replace(".000Z", "Z") !==
            concurrentGuard.prelaunchCheckpoint.firstCapturedAt ||
        new Date(checkpointLast).toISOString().replace(".000Z", "Z") !==
            concurrentGuard.prelaunchCheckpoint.lastCapturedAt ||
        checkpointFirst > zincCutoff ||
        zincCutoff > checkpointLast ||
        checkpointLast > sealBefore ||
        JSON.stringify(concurrentGuard.remote) !==
            JSON.stringify({ host: "puffalo.tailbe7bef.ts.net", user: "agent-zinc", port: 2222 }) ||
        !Number.isFinite(sealBefore) ||
        new Date(sealBefore).toISOString().replace(".000Z", "Z") !== concurrentGuard.sealBefore ||
        concurrentGuard.guardIntervalMs !== 60000 ||
        concurrentGuard.maxGuardGapMs !== 90000 ||
        concurrentGuard.finalWindowMs !== 300000 ||
        !activeCemSchedule ||
        fingerprintV07ComposedDerivedTournamentSchedules([activeCemSchedule]) !==
            concurrentGuard.activeCemClosure.scheduleSha256 ||
        JSON.stringify(concurrentGuard.activeCemClosure) !==
            JSON.stringify({
                scheduleId:
                    "zinc-active-fight58b-preregistered-reservation-envelope-iterations-1-through-64-passes-1-through-8",
                scheduleSha256: "31adcb7ecea9eece8d863271365d22bf5fbe235172263d5078f11593705caa32",
                uniqueSeeds: 9616000,
                seedSetSha256: "28a48d2012d95d17c38884f0ce0ee20ed6470ca83fa6e0838a167aa61aff988d",
            })
    ) {
        throw new Error("Manifest Zinc concurrent guard or active CEM closure binding is inconsistent");
    }
    validateV07ComposedCollisionLedger(manifest);
    if (JSON.stringify(manifest.seedAudit.observedBenchmark) !== JSON.stringify(V07_COMPOSED_OBSERVED_BENCHMARK)) {
        throw new Error("Observed 100k benchmark seed reservation/provenance drifted");
    }
    if (
        manifest.gates.qualificationSeatWilsonLow !== 0.9 ||
        manifest.gates.minimumSeatDecisiveFraction !== 0.9 ||
        manifest.gates.maxSeatDrawOrArmageddonFraction !== 0.1 ||
        manifest.gates.formalFamily !== "thirteen_qualification_cells_by_two_candidate_seats" ||
        manifest.gates.formalMethod !== "bonferroni_two_sided_wilson_by_candidate_seat" ||
        manifest.gates.formalCellCount !== 13 ||
        manifest.gates.formalHypotheses !== 26 ||
        manifest.gates.nominalFamilywiseConfidence !== 0.95 ||
        manifest.gates.coverageCaveat !== "wilson_bonferroni_is_nominal_not_exact_finite_sample_coverage" ||
        manifest.gates.formalZ !== V07_COMPOSED_FORMAL_Z ||
        manifest.gates.engineRejections !== 0 ||
        manifest.gates.searchIllegalIncumbents !== 0 ||
        manifest.gates.maxQualificationDeadlineFallbackRate !== 0.05 ||
        manifest.gates.maxQualificationCircuitOpenedGames !== 0 ||
        manifest.gates.maxQualificationCircuitSkippedDecisions !== 0 ||
        manifest.gates.rawAndAuditCompleteness !== true ||
        manifest.gates.offControlExactSymmetry !== true ||
        manifest.gates.automaticBake !== false
    ) {
        throw new Error("Manifest changed the frozen evidence gates");
    }
    if (manifest.cells.filter((cell) => cell.qualification).length !== manifest.gates.formalCellCount) {
        throw new Error("Manifest formal family does not contain exactly thirteen qualification cells");
    }
    if (
        !sameMembers(Object.keys(manifest.sourceProvenance.requiredSha256), V07_COMPOSED_REQUIRED_SOURCE_PATHS) ||
        Object.values(manifest.sourceProvenance.requiredSha256).some((hash) => !/^[0-9a-f]{64}$/.test(hash))
    ) {
        throw new Error("Manifest must hash exactly every required composed-ranked source");
    }
    if (
        manifest.sourceProvenance.originIdentity !== V07_COMPOSED_ORIGIN_IDENTITY ||
        !/^[0-9a-f]{40}$/.test(manifest.sourceProvenance.preregisteredCommonBaseCommit) ||
        !/^[0-9a-f]{64}$/.test(manifest.sourceProvenance.packageJsonSha256) ||
        manifest.sourceProvenance.runtimeTree.root !== "src" ||
        JSON.stringify(manifest.sourceProvenance.runtimeTree.excludedPrefixes) !==
            JSON.stringify(["src/simulation/manifests/", "src/simulation/results/"]) ||
        !Number.isSafeInteger(manifest.sourceProvenance.runtimeTree.files) ||
        manifest.sourceProvenance.runtimeTree.files < 1 ||
        !/^[0-9a-f]{64}$/.test(manifest.sourceProvenance.runtimeTree.sha256)
    ) {
        throw new Error("Manifest runtime source-tree provenance is incomplete");
    }
    if (
        manifest.runtimeProvenance.bunLockPolicy !== "intentionally_absent_bind_exact_installed_manifests" ||
        manifest.runtimeProvenance.cleanOrdinaryUntrackedRequired !== true ||
        manifest.runtimeProvenance.outputOutsideRepositoryRequired !== true ||
        JSON.stringify(manifest.runtimeProvenance.forbiddenConfigPaths) !==
            JSON.stringify(["bunfig.toml", "bunfig.local.toml", ".bunfig.toml"]) ||
        JSON.stringify(manifest.runtimeProvenance.forbiddenHomeConfigPaths) !==
            JSON.stringify([".bunfig.toml", ".config/bunfig.toml", ".config/bun/bunfig.toml"]) ||
        !sameMembers(
            manifest.runtimeProvenance.forbiddenEnvironmentKeys,
            V07_COMPOSED_FORBIDDEN_RUNTIME_ENVIRONMENT_KEYS,
        ) ||
        manifest.runtimeProvenance.requiredEnvironment.BUN_RUNTIME_TRANSPILER_CACHE_PATH !== "0" ||
        manifest.runtimeProvenance.requiredEnvironment.V07_COMPOSED_HOST_IDLE_ATTESTATION !== "1" ||
        !sameMembers(Object.keys(manifest.runtimeProvenance.requiredEnvironment), [
            "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
            "V07_COMPOSED_HOST_IDLE_ATTESTATION",
        ]) ||
        !manifest.runtimeProvenance.bun.version.trim() ||
        !/^[0-9a-f]{40}$/.test(manifest.runtimeProvenance.bun.revision) ||
        !/^[0-9a-f]{64}$/.test(manifest.runtimeProvenance.bun.executableSha256) ||
        !sameMembers(Object.keys(manifest.runtimeProvenance.dependencies), V07_COMPOSED_RUNTIME_DEPENDENCIES)
    ) {
        throw new Error("Manifest runtime provenance contract is incomplete");
    }
    for (const dependency of V07_COMPOSED_RUNTIME_DEPENDENCIES) {
        const binding = manifest.runtimeProvenance.dependencies[dependency];
        if (
            !binding.version.trim() ||
            !binding.packageJsonPath.startsWith("node_modules/") ||
            !binding.entryPath.startsWith("node_modules/") ||
            !/^[0-9a-f]{64}$/.test(binding.packageJsonSha256) ||
            !/^[0-9a-f]{64}$/.test(binding.entrySha256) ||
            !Number.isSafeInteger(binding.treeFiles) ||
            binding.treeFiles < 1 ||
            !/^[0-9a-f]{64}$/.test(binding.treeSha256)
        ) {
            throw new Error(`Manifest runtime dependency binding is incomplete for ${dependency}`);
        }
    }
    if (
        manifest.serverReference.exactLiveParity !== false ||
        !/^[0-9a-f]{40}$/.test(manifest.serverReference.serverCommit) ||
        manifest.serverReference.serverCommit !== V07_COMPOSED_SERVER_REFERENCE.serverCommit ||
        !/^[0-9a-f]{40}$/.test(manifest.serverReference.lockedCommonCommit) ||
        manifest.serverReference.lockedCommonCommit !== V07_COMPOSED_SERVER_REFERENCE.lockedCommonCommit ||
        manifest.serverReference.lockfilePath !== "bun.lock" ||
        !/^[0-9a-f]{64}$/.test(manifest.serverReference.lockfileSha256) ||
        manifest.serverReference.lockfileSha256 !== V07_COMPOSED_SERVER_REFERENCE.lockfileSha256 ||
        !manifest.serverReference.explanation.trim() ||
        !sameMembers(Object.keys(manifest.serverReference.sourceSha256), V07_COMPOSED_SERVER_SOURCE_PATHS) ||
        JSON.stringify(manifest.serverReference.sourceSha256) !==
            JSON.stringify(V07_COMPOSED_SERVER_REFERENCE.sourceSha256) ||
        Object.values(manifest.serverReference.sourceSha256).some((hash) => !/^[0-9a-f]{64}$/.test(hash))
    ) {
        throw new Error("Manifest server provenance is incomplete");
    }
}

export function readV07ComposedManifest(path: string): {
    manifest: IV07ComposedManifest;
    provenance: IV07ComposedManifestProvenance;
} {
    const resolved = resolve(path);
    const raw = readFileSync(resolved, "utf8");
    const manifest = JSON.parse(raw) as IV07ComposedManifest;
    validateV07ComposedManifest(manifest);
    return { manifest, provenance: { path: resolved, sha256: sha256(raw) } };
}

const v07ComposedRegisteredScenarioRoots = (cellId: string): number => {
    if (cellId === "round1_search_off_symmetry") return 1000;
    if (
        cellId === "round1_search_uncapped" ||
        cellId === "round1_search_server300" ||
        cellId === "round1_search_conservative200_275"
    ) {
        return 2000;
    }
    if ((V07_COMPOSED_CELL_IDS as readonly string[]).includes(cellId)) return 1000;
    throw new Error(`Unknown composed-ranked cell ${cellId}`);
};

const v07ComposedSlotsPerScenario = (cellId: string): number =>
    Object.values(V07_COMPOSED_TAXONOMY_CELL_IDS).includes(cellId) ? 259 : 3;

export function v07ComposedCellBaseOrdinal(cellId: string): number {
    let ordinal = 0;
    for (const id of V07_COMPOSED_CELL_IDS) {
        if (id === cellId) return ordinal;
        ordinal += v07ComposedRegisteredScenarioRoots(id) * v07ComposedSlotsPerScenario(id);
    }
    throw new Error(`Unknown composed-ranked cell ${cellId}`);
}

export const V07_COMPOSED_MAIN_LOGICAL_SLOTS = V07_COMPOSED_CELL_IDS.reduce(
    (sum, cellId) => sum + v07ComposedRegisteredScenarioRoots(cellId) * v07ComposedSlotsPerScenario(cellId),
    0,
);

export function v07ComposedPermutedSeed(ordinal: number): number {
    if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal > 0xffffffff) {
        throw new Error(`Composed-ranked logical seed ordinal must be uint32; got ${ordinal}`);
    }
    return (V07_COMPOSED_PERMUTATION_OFFSET + Math.imul(ordinal, V07_COMPOSED_PERMUTATION_ODD_STEP)) >>> 0;
}

function v07ComposedSeedForLogicalSlot(_label: string, ordinal: number): number {
    const override = V07_COMPOSED_ORDINAL_OVERRIDE_BY_MAIN.get(ordinal);
    return v07ComposedPermutedSeed(override ?? ordinal);
}

function v07ComposedScenarioOrdinal(cell: Pick<IV07ComposedCell, "id">, pair: number): number {
    if (!Number.isSafeInteger(pair) || pair < 0 || pair >= v07ComposedRegisteredScenarioRoots(cell.id)) {
        throw new Error(`${cell.id}: pair must be a registered scenario root; got ${pair}`);
    }
    return v07ComposedCellBaseOrdinal(cell.id) + pair * v07ComposedSlotsPerScenario(cell.id);
}

export function scenarioSeed(cell: Pick<IV07ComposedCell, "id">, pair: number): number {
    return v07ComposedSeedForLogicalSlot(`${cell.id}/${pair}/scenario_root`, v07ComposedScenarioOrdinal(cell, pair));
}

export function v07ComposedSetupSeed(
    cell: Pick<IV07ComposedCell, "id" | "scenarioProtocol">,
    pair: number,
    seat: V07ComposedCandidateSeat,
    attempt: number,
): number {
    if (!Number.isSafeInteger(attempt) || attempt < 0) throw new Error(`setup attempt must be non-negative`);
    const root = v07ComposedScenarioOrdinal(cell, pair);
    if (cell.scenarioProtocol === "fixed_physical_side_swap") {
        if (attempt !== 0) throw new Error(`${cell.id}: fixed side-swap cells reserve only setup attempt zero`);
        return v07ComposedSeedForLogicalSlot(`${cell.id}/${pair}/setup/shared/0`, root + 1);
    }
    if (attempt >= V07_COMPOSED_TAXONOMY_MAX_ATTEMPTS) {
        throw new Error(`${cell.id}: setup attempt ${attempt} exceeds the frozen taxonomy cap`);
    }
    const seatOffset = seat === "candidate_green" ? 1 : 130;
    return v07ComposedSeedForLogicalSlot(`${cell.id}/${pair}/setup/${seat}/${attempt}`, root + seatOffset + attempt);
}

export function v07ComposedCombatSeed(
    cell: Pick<IV07ComposedCell, "id" | "scenarioProtocol">,
    pair: number,
    seat: V07ComposedCandidateSeat,
): number {
    const root = v07ComposedScenarioOrdinal(cell, pair);
    if (cell.scenarioProtocol === "fixed_physical_side_swap") {
        return v07ComposedSeedForLogicalSlot(`${cell.id}/${pair}/combat/shared`, root + 2);
    }
    const offset = seat === "candidate_green" ? 129 : 258;
    return v07ComposedSeedForLogicalSlot(`${cell.id}/${pair}/combat/${seat}`, root + offset);
}

export interface IV07ComposedReservedSeedEnvelope {
    tokens: number;
    protectedTokens: number;
    setupProposalTokens: number;
    internalCollisions: number;
    sha256: string;
}

export const V07_COMPOSED_SEED_SCAN_EXCLUDED_RELATIVE_PATHS = [
    "src/simulation/manifests/v0_7_composed_ranked_ladder_20260716.json",
    "src/simulation/v0_7_composed_ranked_ladder.ts",
] as const;

export const V07_COMPOSED_ZINC_MUTABLE_CORPUS_EXCLUSIONS = [
    "/home/agent-zinc/hoc-common/rl_state/fight58_keepalive.log",
    "/home/agent-zinc/hoc-common/sim-out/cem/best.json",
    "/home/agent-zinc/hoc-common/sim-out/cem/log.md",
    "/home/agent-zinc/hoc-common/sim-out/cem/state.json",
] as const;

export const V07_COMPOSED_ZINC_CORPUS_EXCLUSIONS = [
    "/home/agent-zinc/hoc-common-v07-overnight/src/simulation/manifests/v0_7_composed_ranked_ladder_20260716.json",
    "/home/agent-zinc/hoc-common-v07-overnight/src/simulation/v0_7_composed_ranked_ladder.ts",
    "/home/agent-zinc/hoc-common/rl_state/fight58_keepalive.log",
    "/home/agent-zinc/hoc-common/sim-out/cem/best.json",
    "/home/agent-zinc/hoc-common/sim-out/cem/log.md",
    "/home/agent-zinc/hoc-common/sim-out/cem/state.json",
    "/home/agent-zinc/hoc-common/src/simulation/manifests/v0_7_composed_ranked_ladder_20260716.json",
    "/home/agent-zinc/hoc-common/src/simulation/v0_7_composed_ranked_ladder.ts",
] as const;

export const V07_COMPOSED_ZINC_GENERATED_PATH_PREFIX_EXCLUSIONS = [
    "/home/agent-zinc/hoc-common/sim-out/cem/best-",
    "/home/agent-zinc/hoc-common/sim-out/cem/eval_3550186_",
] as const;

export interface IV07ComposedReservedSeedSlot {
    label: string;
    mainOrdinal: number;
    ordinal: number;
    seed: number;
    kind: "protected" | "setup_proposal";
}

export function* v07ComposedReservedSeedSlots(
    manifest: Pick<IV07ComposedManifest, "cells">,
): Generator<IV07ComposedReservedSeedSlot> {
    const slot = (
        label: string,
        mainOrdinal: number,
        kind: IV07ComposedReservedSeedSlot["kind"],
    ): IV07ComposedReservedSeedSlot => {
        const ordinal = V07_COMPOSED_ORDINAL_OVERRIDE_BY_MAIN.get(mainOrdinal) ?? mainOrdinal;
        return { label, mainOrdinal, ordinal, seed: v07ComposedPermutedSeed(ordinal), kind };
    };
    for (const cell of manifest.cells) {
        for (let pair = 0; pair < cell.pairScenarios; pair += 1) {
            const root = v07ComposedScenarioOrdinal(cell, pair);
            yield slot(`${cell.id}/${pair}/scenario_root`, root, "protected");
            if (cell.scenarioProtocol === "independent_seat_conditioned") {
                for (const [seat, setupOffset, combatOffset] of [
                    ["candidate_green", 1, 129],
                    ["candidate_red", 130, 258],
                ] as const) {
                    for (let attempt = 0; attempt < V07_COMPOSED_TAXONOMY_MAX_ATTEMPTS; attempt += 1) {
                        yield slot(
                            `${cell.id}/${pair}/setup/${seat}/${attempt}`,
                            root + setupOffset + attempt,
                            "setup_proposal",
                        );
                    }
                    yield slot(`${cell.id}/${pair}/combat/${seat}`, root + combatOffset, "protected");
                }
            } else {
                yield slot(`${cell.id}/${pair}/setup/shared/0`, root + 1, "setup_proposal");
                yield slot(`${cell.id}/${pair}/combat/shared`, root + 2, "protected");
            }
        }
    }
}

export function v07ComposedReservedSeedEnvelope(
    manifest: Pick<IV07ComposedManifest, "cells">,
): IV07ComposedReservedSeedEnvelope {
    const hash = createHash("sha256");
    const usedOrdinals = new Set<number>();
    const logicalLabels = new Set<string>();
    const remappedMainOrdinals = new Set<number>();
    let tokens = 0;
    let protectedTokens = 0;
    let setupProposalTokens = 0;
    let internalCollisions = 0;
    const register = (label: string, mainOrdinal: number, kind: "protected" | "setup_proposal"): void => {
        const ordinal = V07_COMPOSED_ORDINAL_OVERRIDE_BY_MAIN.get(mainOrdinal) ?? mainOrdinal;
        if (logicalLabels.has(label)) throw new Error(`Duplicate logical seed label ${label}`);
        logicalLabels.add(label);
        if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal > 0xffffffff) {
            throw new Error(`Seed ordinal override for ${label} is outside uint32`);
        }
        if (ordinal !== mainOrdinal && ordinal < V07_COMPOSED_MAIN_LOGICAL_SLOTS) {
            throw new Error(`Colliding slot ${label} must remap beyond the main logical envelope`);
        }
        if (ordinal !== mainOrdinal) remappedMainOrdinals.add(mainOrdinal);
        internalCollisions += Number(usedOrdinals.has(ordinal));
        usedOrdinals.add(ordinal);
        if (kind === "protected") {
            protectedTokens += 1;
        } else setupProposalTokens += 1;
        tokens += 1;
        hash.update(`${label}\0${mainOrdinal}\0${ordinal}\0${v07ComposedPermutedSeed(ordinal)}\0${kind}\n`);
    };
    for (const cell of manifest.cells) {
        for (let pair = 0; pair < cell.pairScenarios; pair += 1) {
            const root = v07ComposedScenarioOrdinal(cell, pair);
            register(`${cell.id}/${pair}/scenario_root`, root, "protected");
            if (cell.scenarioProtocol === "independent_seat_conditioned") {
                for (const [seat, setupOffset, combatOffset] of [
                    ["candidate_green", 1, 129],
                    ["candidate_red", 130, 258],
                ] as const) {
                    for (let attempt = 0; attempt < V07_COMPOSED_TAXONOMY_MAX_ATTEMPTS; attempt += 1) {
                        register(
                            `${cell.id}/${pair}/setup/${seat}/${attempt}`,
                            root + setupOffset + attempt,
                            "setup_proposal",
                        );
                    }
                    register(`${cell.id}/${pair}/combat/${seat}`, root + combatOffset, "protected");
                }
            } else {
                register(`${cell.id}/${pair}/setup/shared/0`, root + 1, "setup_proposal");
                register(`${cell.id}/${pair}/combat/shared`, root + 2, "protected");
            }
        }
    }
    if (
        V07_COMPOSED_REMAP_ORDINAL_BASE !== V07_COMPOSED_MAIN_LOGICAL_SLOTS ||
        new Set(V07_COMPOSED_REMAP_ORDINALS).size !== V07_COMPOSED_REMAP_ORDINALS.length ||
        V07_COMPOSED_REMAP_ORDINALS.some(
            (ordinal) => !Number.isSafeInteger(ordinal) || ordinal < V07_COMPOSED_REMAP_ORDINAL_BASE,
        )
    ) {
        throw new Error("Collision-remap spare ordinals are malformed, duplicated, or inside the main envelope");
    }
    if (
        remappedMainOrdinals.size !== V07_COMPOSED_COLLIDING_MAIN_ORDINALS.length ||
        V07_COMPOSED_COLLIDING_MAIN_ORDINALS.some((ordinal) => !remappedMainOrdinals.has(ordinal))
    ) {
        throw new Error("Collision-remap ordinal names an unregistered logical slot");
    }
    for (const ordinal of remappedMainOrdinals) {
        if (usedOrdinals.has(ordinal)) throw new Error(`Remapped main ordinal ${ordinal} was reused`);
    }
    return { tokens, protectedTokens, setupProposalTokens, internalCollisions, sha256: hash.digest("hex") };
}

function validateV07ComposedCollisionLedger(manifest: IV07ComposedManifest): void {
    const remapped = [...v07ComposedReservedSeedSlots(manifest)].filter((slot) => slot.ordinal !== slot.mainOrdinal);
    const ledger = manifest.seedAudit.collisionResolutions;
    if (ledger.length !== remapped.length || ledger.length !== V07_COMPOSED_COLLIDING_MAIN_ORDINALS.length) {
        throw new Error("Seed-collision ledger length differs from the frozen remap set");
    }
    const labels = new Set<string>();
    for (let index = 0; index < ledger.length; index += 1) {
        const record = ledger[index];
        const slot = remapped[index];
        if (
            labels.has(record.label) ||
            record.label !== slot.label ||
            record.kind !== slot.kind ||
            record.mainOrdinal !== slot.mainOrdinal ||
            record.originalSeed !== v07ComposedPermutedSeed(slot.mainOrdinal) ||
            record.remapOrdinal !== slot.ordinal ||
            record.remappedSeed !== slot.seed ||
            (!record.inLocal && !record.inZinc)
        ) {
            throw new Error(`Seed-collision ledger drifted at record ${index}`);
        }
        labels.add(record.label);
    }
    const expectedOverrides = Object.fromEntries(ledger.map((record) => [record.label, record.remapOrdinal]));
    if (JSON.stringify(manifest.seedAudit.ordinalOverrides) !== JSON.stringify(expectedOverrides)) {
        throw new Error("Seed-collision ordinal overrides differ from the machine-readable ledger");
    }
    if (
        manifest.seedAudit.local.originalCollisionLogicalSlots !== ledger.filter((record) => record.inLocal).length ||
        manifest.seedAudit.zinc.originalCollisionLogicalSlots !== ledger.filter((record) => record.inZinc).length
    ) {
        throw new Error("Seed-corpus original-collision totals differ from the machine-readable ledger");
    }
}

interface IArmySetup {
    creatureIds: number[];
    revealedOpponentCreatures: number[];
    roster: IMatchConfig["roster"];
    perk: number;
    augments: NonNullable<IMatchConfig["greenAugments"]>;
    synergies: NonNullable<IMatchConfig["greenSynergies"]>;
    tier1Artifact: number;
    tier2Artifact: number;
}

function rankedArmy(army: IConditionalArmy): IArmySetup {
    return {
        creatureIds: [...army.creatureIds],
        revealedOpponentCreatures: [...army.revealedOpponentCreatures],
        roster: army.roster.map((unit) => ({ ...unit })),
        perk: army.perk,
        augments: army.augments.map((augment) => ({ ...augment })),
        synergies: army.synergies.map((synergy) => ({ ...synergy })),
        tier1Artifact: army.tier1Artifact,
        tier2Artifact: army.tier2Artifact,
    };
}

function fixedArmy(templateName: V07ArchetypeTemplateName): IArmySetup {
    const template = v07ArchetypeTemplate(templateName);
    const creatureIds = template.roster.map((unit) => creatureIdForName(unit.creatureName));
    const perk = SETUP_POLICY_V0.pickPerk();
    const rules = parseConditionalRules("all");
    return {
        creatureIds,
        revealedOpponentCreatures: [],
        roster: template.roster.map((unit) => ({ ...unit })),
        perk,
        augments: conditionalAugments(getUpgradePoints(perk), creatureIds, rules),
        synergies: conditionalSynergies(creatureIds),
        // Supplemental tactical cells are artifact-free. They are not literal ranked T1/T2 offer samples.
        tier1Artifact: 0,
        tier2Artifact: 0,
    };
}

function physicalSetupFingerprint(lower: IArmySetup, upper: IArmySetup): string {
    return sha256(JSON.stringify({ lower, upper, map: PBTypes.GridVals.NORMAL }));
}

function telemetry(actions: readonly IRecordedAction[], side: Side): IV07ComposedActionTelemetry {
    const result: IV07ComposedActionTelemetry = { actions: 0, completed: 0, byType: {} };
    for (const action of actions) {
        if (action.side !== side) continue;
        result.actions += 1;
        result.completed += Number(action.completed);
        result.byType[action.actionType] = (result.byType[action.actionType] ?? 0) + 1;
    }
    return result;
}

function normalizedResultFingerprint(result: IMatchResult): string {
    const outcomeWithoutVersion = (outcome: IMatchResult["outcome"]["green"]): Omit<typeof outcome, "version"> => ({
        unitsAlive: outcome.unitsAlive,
        creaturesAlive: outcome.creaturesAlive,
        hpRemaining: outcome.hpRemaining,
    });
    return sha256(
        JSON.stringify({
            seed: result.seed,
            gridType: result.gridType,
            winner: result.winner,
            endReason: result.endReason,
            laps: result.laps,
            totalActions: result.totalActions,
            placements: result.placements,
            actions: result.actions,
            outcome: {
                green: outcomeWithoutVersion(result.outcome.green),
                red: outcomeWithoutVersion(result.outcome.red),
            },
            attrition: result.attrition,
            rejectedGreen: result.rejectedGreen,
            rejectedRed: result.rejectedRed,
            rejectedDetails: result.rejectedDetails,
            greenArtifactT1: result.greenArtifactT1 ?? 0,
            redArtifactT1: result.redArtifactT1 ?? 0,
            greenArtifactT2: result.greenArtifactT2 ?? 0,
            redArtifactT2: result.redArtifactT2 ?? 0,
        }),
    );
}

export interface IV07ComposedGameDependencies {
    matchRunner?: (config: IMatchConfig) => IMatchResult;
    pickRunner?: (seed: number) => { lower: IConditionalArmy; upper: IConditionalArmy };
}

interface IV07ComposedSelectedSetup {
    lower: IArmySetup;
    upper: IArmySetup;
    setupSeed: number;
    setupAttempt: number;
    taxonomyTraitCounts?: NonNullable<IV07ComposedGameRecord["taxonomyTraitCounts"]>;
}

function taxonomyTraitCounts(
    archetype: V07Archetype,
    lower: IArmySetup,
    upper: IArmySetup,
    candidateIsGreen: boolean,
): NonNullable<IV07ComposedGameRecord["taxonomyTraitCounts"]> {
    const taxonomy = new Set(V07_ARCHETYPE_TAXONOMY[archetype]);
    const lowerMembers = lower.roster.map((unit) => unit.creatureName).filter((name) => taxonomy.has(name));
    const upperMembers = upper.roster.map((unit) => unit.creatureName).filter((name) => taxonomy.has(name));
    return {
        lower: lowerMembers.length,
        upper: upperMembers.length,
        candidate: candidateIsGreen ? lowerMembers.length : upperMembers.length,
        opponent: candidateIsGreen ? upperMembers.length : lowerMembers.length,
        lowerMembers,
        upperMembers,
    };
}

function selectV07ComposedSetup(
    cell: IV07ComposedCell,
    pair: number,
    seat: V07ComposedCandidateSeat,
    pickRunner: (seed: number) => { lower: IConditionalArmy; upper: IConditionalArmy },
): IV07ComposedSelectedSetup {
    const candidateIsGreen = seat === "candidate_green";
    if (cell.distribution === "fixed_template") {
        if (!cell.template) throw new Error(`${cell.id}: fixed-template cell omitted its template`);
        const setupSeed = v07ComposedSetupSeed(cell, pair, seat, 0);
        return {
            lower: fixedArmy(cell.template),
            upper: fixedArmy(cell.template),
            setupSeed,
            setupAttempt: 0,
        };
    }
    if (cell.distribution === "ranked_round1") {
        const setupSeed = v07ComposedSetupSeed(cell, pair, seat, 0);
        const pick = pickRunner(setupSeed);
        return {
            lower: rankedArmy(pick.lower),
            upper: rankedArmy(pick.upper),
            setupSeed,
            setupAttempt: 0,
        };
    }
    if (!cell.archetype) {
        throw new Error(`${cell.id}: taxonomy cell omitted its archetype`);
    }
    for (let attempt = 0; attempt < V07_COMPOSED_TAXONOMY_MAX_ATTEMPTS; attempt += 1) {
        const setupSeed = v07ComposedSetupSeed(cell, pair, seat, attempt);
        const pick = pickRunner(setupSeed);
        const lower = rankedArmy(pick.lower);
        const upper = rankedArmy(pick.upper);
        const counts = taxonomyTraitCounts(cell.archetype, lower, upper, candidateIsGreen);
        if (counts.candidate < 1) continue;
        return { lower, upper, setupSeed, setupAttempt: attempt, taxonomyTraitCounts: counts };
    }
    throw new Error(
        `${cell.id}/${pair}/${seat}: no candidate-side ${cell.archetype} setup within ${V07_COMPOSED_TAXONOMY_MAX_ATTEMPTS} attempts`,
    );
}

const defaultV07ComposedPickRunner = (): ((seed: number) => { lower: IConditionalArmy; upper: IConditionalArmy }) => {
    const rules = parseConditionalRules("all");
    const genome = shippedLeagueGenome(LEAGUE_ROUND1_DRAFT_SPEC);
    return (seed: number) => runRankedConditionalPickGame(seed, rules, genome);
};

interface IV07ComposedTaxonomyPlanAttempt {
    attempt: number;
    setupSeed: number;
    traitCounts: NonNullable<IV07ComposedGameRecord["taxonomyTraitCounts"]>;
    physicalSetupSha256: string;
    lowerRoster: string;
    upperRoster: string;
}

function v07ComposedTaxonomyAttempt(
    cell: IV07ComposedCell,
    pair: number,
    seat: V07ComposedCandidateSeat,
    attempt: number,
    pickRunner: (seed: number) => { lower: IConditionalArmy; upper: IConditionalArmy },
): { lower: IArmySetup; upper: IArmySetup; evidence: IV07ComposedTaxonomyPlanAttempt } {
    if (!cell.archetype) throw new Error(`${cell.id}: taxonomy plan omitted its archetype`);
    const setupSeed = v07ComposedSetupSeed(cell, pair, seat, attempt);
    const pick = pickRunner(setupSeed);
    const lower = rankedArmy(pick.lower);
    const upper = rankedArmy(pick.upper);
    return {
        lower,
        upper,
        evidence: {
            attempt,
            setupSeed,
            traitCounts: taxonomyTraitCounts(cell.archetype, lower, upper, seat === "candidate_green"),
            physicalSetupSha256: physicalSetupFingerprint(lower, upper),
            lowerRoster: rosterSignature(lower.roster),
            upperRoster: rosterSignature(upper.roster),
        },
    };
}

function emptyTaxonomySeatPlanSummary(): IV07ComposedTaxonomySeatPlanSummary {
    return {
        streams: 0,
        totalAttempts: 0,
        meanAttempt: 0,
        totalProposals: 0,
        meanProposals: 0,
        maxAttempt: 0,
        acceptedAttemptHistogram: {},
    };
}

/** Build the exact outcome-blind first-hit plan for all 8,000 registered taxonomy candidate-seat streams. */
export function buildV07ComposedTaxonomyPlan(
    manifest: Pick<IV07ComposedManifest, "cells">,
    pickRunner = defaultV07ComposedPickRunner(),
): IV07ComposedTaxonomyPlanSummary {
    const taxonomyCells = manifest.cells.filter((cell) => cell.distribution === "ranked_taxonomy");
    if (
        taxonomyCells.length !== V07_ARCHETYPES.length ||
        !sameMembers(
            taxonomyCells.map((cell) => cell.id),
            Object.values(V07_COMPOSED_TAXONOMY_CELL_IDS),
        )
    ) {
        throw new Error("Taxonomy plan requires exactly the four registered taxonomy cells");
    }
    const hash = createHash("sha256");
    const cells: IV07ComposedTaxonomyPlanSummary["cells"] = {};
    let rows = 0;
    for (const cell of taxonomyCells) {
        if (cell.pairScenarios !== 1000) throw new Error(`${cell.id}: taxonomy plan requires exactly 1,000 pairs`);
        const cellSummary = {
            pairs: 1000 as const,
            candidate_green: emptyTaxonomySeatPlanSummary(),
            candidate_red: emptyTaxonomySeatPlanSummary(),
        };
        const histograms: Record<V07ComposedCandidateSeat, Map<number, number>> = {
            candidate_green: new Map(),
            candidate_red: new Map(),
        };
        for (let pair = 0; pair < cell.pairScenarios; pair += 1) {
            for (const seat of ["candidate_green", "candidate_red"] as const) {
                const attempts: IV07ComposedTaxonomyPlanAttempt[] = [];
                let acceptedAttempt = -1;
                for (let attempt = 0; attempt < V07_COMPOSED_TAXONOMY_MAX_ATTEMPTS; attempt += 1) {
                    const planned = v07ComposedTaxonomyAttempt(cell, pair, seat, attempt, pickRunner);
                    attempts.push(planned.evidence);
                    if (planned.evidence.traitCounts.candidate > 0) {
                        acceptedAttempt = attempt;
                        break;
                    }
                }
                if (acceptedAttempt < 0) {
                    throw new Error(`${cell.id}/${pair}/${seat}: no first-hit setup in the registered taxonomy plan`);
                }
                hash.update(`${JSON.stringify({ cellId: cell.id, pair, seat, attempts })}\n`);
                const summary = cellSummary[seat];
                summary.streams += 1;
                summary.totalAttempts += acceptedAttempt;
                summary.totalProposals += acceptedAttempt + 1;
                summary.maxAttempt = Math.max(summary.maxAttempt, acceptedAttempt);
                histograms[seat].set(acceptedAttempt, (histograms[seat].get(acceptedAttempt) ?? 0) + 1);
                rows += 1;
            }
        }
        for (const seat of ["candidate_green", "candidate_red"] as const) {
            const summary = cellSummary[seat];
            summary.meanAttempt = summary.totalAttempts / summary.streams;
            summary.meanProposals = summary.totalProposals / summary.streams;
            summary.acceptedAttemptHistogram = Object.fromEntries(
                [...histograms[seat]]
                    .sort(([left], [right]) => left - right)
                    .map(([attempt, count]) => [attempt, count]),
            );
        }
        cells[cell.id] = cellSummary;
    }
    if (rows !== 8000) throw new Error(`Taxonomy plan produced ${rows} rows instead of 8,000`);
    return { rows: 8000, sha256: hash.digest("hex"), cells };
}

export function verifyV07ComposedTaxonomyPlan(
    manifest: Pick<IV07ComposedManifest, "cells" | "draft">,
    pickRunner = defaultV07ComposedPickRunner(),
): IV07ComposedTaxonomyPlanSummary {
    const actual = buildV07ComposedTaxonomyPlan(manifest, pickRunner);
    if (JSON.stringify(actual) !== JSON.stringify(manifest.draft.taxonomyPlan)) {
        throw new Error(`Exact registered taxonomy plan differs from ${manifest.draft.taxonomyPlan.sha256}`);
    }
    return actual;
}

/** Outcome-blind focused preflight retained for unit tests and one-cell diagnostics. */
export function verifyV07ComposedTaxonomyCellPlan(
    cell: IV07ComposedCell,
    pickRunner = defaultV07ComposedPickRunner(),
): void {
    if (cell.distribution !== "ranked_taxonomy") return;
    for (let pair = 0; pair < cell.pairScenarios; pair += 1) {
        selectV07ComposedSetup(cell, pair, "candidate_green", pickRunner);
        selectV07ComposedSetup(cell, pair, "candidate_red", pickRunner);
    }
}

/** Replay first-hit selection and physical setup for persisted taxonomy rows during artifact validation. */
export function replayV07ComposedTaxonomyRecords(
    cell: IV07ComposedCell,
    records: readonly IV07ComposedGameRecord[],
    pickRunner = defaultV07ComposedPickRunner(),
): void {
    if (cell.distribution !== "ranked_taxonomy") return;
    for (const record of records) {
        const selected = selectV07ComposedSetup(cell, record.pair, record.candidateSeatStream, pickRunner);
        if (
            record.setupAttempt !== selected.setupAttempt ||
            record.setupSeed !== selected.setupSeed ||
            JSON.stringify(record.taxonomyTraitCounts) !== JSON.stringify(selected.taxonomyTraitCounts) ||
            record.physicalSetupSha256 !== physicalSetupFingerprint(selected.lower, selected.upper) ||
            record.lowerRoster !== rosterSignature(selected.lower.roster) ||
            record.upperRoster !== rosterSignature(selected.upper.roster)
        ) {
            throw new Error(`${cell.id}/${record.game}: persisted taxonomy row differs from first-hit setup replay`);
        }
    }
}

export function playV07ComposedGame(
    manifestId: string,
    cell: IV07ComposedCell,
    game: number,
    dependencies: IV07ComposedGameDependencies = {},
): IV07ComposedGameRecord {
    if (!Number.isSafeInteger(game) || game < 0 || game >= cell.games) {
        throw new Error(`${cell.id}: game must be in [0, ${cell.games}); got ${game}`);
    }
    const pair = Math.floor(game / 2);
    const candidateIsGreen = game % 2 === 0;
    const candidateSeatStream: V07ComposedCandidateSeat = candidateIsGreen ? "candidate_green" : "candidate_red";
    const scenarioRoot = scenarioSeed(cell, pair);
    const pickRunner =
        dependencies.pickRunner ??
        ((setupSeed: number) =>
            runRankedConditionalPickGame(
                setupSeed,
                parseConditionalRules("all"),
                shippedLeagueGenome(LEAGUE_ROUND1_DRAFT_SPEC),
            ));
    const selected = selectV07ComposedSetup(cell, pair, candidateSeatStream, pickRunner);
    const { lower, upper } = selected;
    const combatSeed = v07ComposedCombatSeed(cell, pair, candidateSeatStream);
    const greenVersion = candidateIsGreen ? cell.candidate : cell.opponent;
    const redVersion = candidateIsGreen ? cell.opponent : cell.candidate;
    const matchRunner =
        dependencies.matchRunner ??
        ((config: IMatchConfig): IMatchResult => {
            FightStateManager.getInstance();
            return runMatch(config);
        });
    const result = matchRunner({
        greenVersion,
        redVersion,
        roster: lower.roster,
        redRoster: upper.roster,
        seed: combatSeed,
        gridType: PBTypes.GridVals.NORMAL,
        greenPerk: lower.perk,
        redPerk: upper.perk,
        greenAugments: lower.augments,
        redAugments: upper.augments,
        greenArtifactT1: lower.tier1Artifact,
        redArtifactT1: upper.tier1Artifact,
        greenArtifactT2: lower.tier2Artifact,
        redArtifactT2: upper.tier2Artifact,
        greenSynergies: lower.synergies,
        redSynergies: upper.synergies,
        greenRevealedCreatures: lower.revealedOpponentCreatures,
        redRevealedCreatures: upper.revealedOpponentCreatures,
    });
    const candidateSide: Side = candidateIsGreen ? "green" : "red";
    const opponentSide: Side = candidateIsGreen ? "red" : "green";
    return {
        schemaVersion: 1,
        manifestId,
        cellId: cell.id,
        profile: cell.profile,
        distribution: cell.distribution,
        scenarioProtocol: cell.scenarioProtocol,
        ...(cell.archetype ? { archetype: cell.archetype } : {}),
        ...(cell.template ? { template: cell.template } : {}),
        game,
        pair,
        scenarioRoot,
        candidateSeatStream,
        setupSeed: selected.setupSeed,
        setupAttempt: selected.setupAttempt,
        combatSeed,
        ...(selected.taxonomyTraitCounts ? { taxonomyTraitCounts: selected.taxonomyTraitCounts } : {}),
        candidateIsGreen,
        greenVersion,
        redVersion,
        physicalSetupSha256: physicalSetupFingerprint(lower, upper),
        lowerRoster: rosterSignature(lower.roster),
        upperRoster: rosterSignature(upper.roster),
        winner: result.winner,
        winnerSlot: result.winner === "draw" ? "draw" : result.winner === candidateSide ? "candidate" : "opponent",
        laps: result.laps,
        endReason: result.endReason,
        decidedByArmageddon: result.attrition.decidedByArmageddon,
        reachedArmageddon: result.attrition.reachedArmageddon,
        rejectedGreen: result.rejectedGreen,
        rejectedRed: result.rejectedRed,
        resultFingerprint: normalizedResultFingerprint(result),
        candidateActions: telemetry(result.actions, candidateSide),
        opponentActions: telemetry(result.actions, opponentSide),
    };
}

function auditKey(seed: number, green: string, red: string): string {
    return `${seed}|${green}|${red}`;
}

function parseJsonl<T>(path: string): T[] {
    if (!existsSync(path)) throw new Error(`Missing JSONL file ${path}`);
    const raw = readFileSync(path, "utf8");
    if (raw && !raw.endsWith("\n")) throw new Error(`JSONL file lacks terminal newline: ${path}`);
    const rows: T[] = [];
    raw.split("\n").forEach((line, index) => {
        if (!line) return;
        try {
            rows.push(JSON.parse(line) as T);
        } catch (error) {
            throw new Error(`${path}:${index + 1}: malformed JSON (${String(error)})`);
        }
    });
    return rows;
}

function requireFiniteCount(value: unknown, label: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative int`);
    return value as number;
}

function validateActionTelemetry(value: IV07ComposedActionTelemetry, label: string): void {
    const actions = requireFiniteCount(value?.actions, `${label}.actions`);
    const completed = requireFiniteCount(value?.completed, `${label}.completed`);
    if (completed > actions || !value.byType || typeof value.byType !== "object") {
        throw new Error(`${label}: malformed executed-action telemetry`);
    }
    let byType = 0;
    for (const [type, count] of Object.entries(value.byType)) {
        if (!type.trim()) throw new Error(`${label}: empty action type`);
        byType += requireFiniteCount(count, `${label}.byType.${type}`);
    }
    if (byType !== actions) throw new Error(`${label}: action-type total ${byType} != ${actions}`);
}

function validateAuditRow(
    row: IV07ComposedAuditRow,
    profile: IV07ComposedSearchProfile,
    record: IV07ComposedGameRecord,
): void {
    if (
        row.t !== "game" ||
        row.mode !== "search" ||
        row.seed !== record.combatSeed ||
        row.green !== record.greenVersion ||
        row.red !== record.redVersion ||
        row.winner !== record.winner ||
        row.endReason !== record.endReason ||
        row.gate !== profile.gate ||
        row.horizon !== profile.horizon ||
        row.rollouts !== profile.rollouts ||
        row.leaf !== profile.leaf ||
        row.oppModel !== undefined ||
        row.shortlist !== null ||
        row.decisionDeadlineMs !== profile.decisionDeadlineMs ||
        row.circuitBreakerMs !== profile.circuitBreakerMs ||
        row.lateRangedFinishWeight !== 0 ||
        row.pureRangedTerminalWeight !== 0
    ) {
        throw new Error(`${record.cellId}/${record.game}: search audit does not match the frozen profile`);
    }
    for (const [name, value] of Object.entries({
        decisions: row.decisions,
        searched: row.searched,
        overrides: row.overrides,
        illegalIncumbent: row.illegalIncumbent,
        deadlineFallbacks: row.deadlineFallbacks,
        circuitSkipped: row.circuitSkipped,
    })) {
        requireFiniteCount(value, `${record.cellId}/${record.game} audit ${name}`);
    }
    if (row.decisions < 1) throw new Error(`${record.cellId}/${record.game}: search produced no audited decisions`);
    if (
        row.searched > row.decisions ||
        row.overrides > row.searched ||
        row.illegalIncumbent > row.searched ||
        row.deadlineFallbacks > row.searched
    ) {
        throw new Error(`${record.cellId}/${record.game}: inconsistent search counter totals`);
    }
    if (typeof row.circuitOpened !== "boolean") {
        throw new Error(`${record.cellId}/${record.game}: circuitOpened must be boolean`);
    }
    if (!row.circuitOpened && row.circuitSkipped > 0) {
        throw new Error(`${record.cellId}/${record.game}: circuit skipped decisions without opening`);
    }
    if (typeof row.msTotal !== "number" || !Number.isFinite(row.msTotal) || row.msTotal < 0) {
        throw new Error(`${record.cellId}/${record.game}: msTotal must be finite and non-negative`);
    }
    if (profile.decisionDeadlineMs === null && row.deadlineFallbacks !== 0) {
        throw new Error(`${record.cellId}/${record.game}: deadline fallback in a no-deadline profile`);
    }
    if (profile.circuitBreakerMs === null && (row.circuitOpened || row.circuitSkipped !== 0)) {
        throw new Error(`${record.cellId}/${record.game}: circuit telemetry in an uncapped profile`);
    }
}

export function v07ComposedWilsonInterval(
    wins: number,
    losses: number,
    z = V07_COMPOSED_FORMAL_Z,
): { low: number; high: number } | null {
    const n = wins + losses;
    if (!Number.isSafeInteger(wins) || !Number.isSafeInteger(losses) || wins < 0 || losses < 0 || n === 0) {
        return null;
    }
    const p = wins / n;
    const z2 = z * z;
    const denominator = 1 + z2 / n;
    const center = p + z2 / (2 * n);
    const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
    return { low: Math.max(0, (center - margin) / denominator), high: Math.min(1, (center + margin) / denominator) };
}

export function summarizeV07ComposedCell(
    manifest: IV07ComposedManifest,
    cell: IV07ComposedCell,
    records: readonly IV07ComposedGameRecord[],
    auditRows: readonly IV07ComposedAuditRow[],
): IV07ComposedCellReport {
    const profile = manifest.searchProfiles[cell.profile];
    const byGame = new Map<number, IV07ComposedGameRecord>();
    for (const record of records) {
        if (!Number.isSafeInteger(record.game) || record.game < 0 || record.game >= cell.games) {
            throw new Error(`${cell.id}: out-of-range game ${record.game}`);
        }
        if (byGame.has(record.game)) throw new Error(`${cell.id}: duplicate raw game ${record.game}`);
        byGame.set(record.game, record);
    }
    if (byGame.size !== cell.games) throw new Error(`${cell.id}: collected ${byGame.size}/${cell.games} raw rows`);

    const auditByKey = new Map<string, IV07ComposedAuditRow>();
    for (const audit of auditRows) {
        if (audit.t !== "game") throw new Error(`${cell.id}: non-game row found with SEARCH_AUDIT_TURNS=0`);
        const key = auditKey(audit.seed, audit.green, audit.red);
        if (auditByKey.has(key)) throw new Error(`${cell.id}: duplicate search audit ${key}`);
        auditByKey.set(key, audit);
    }
    if (profile.search ? auditByKey.size !== cell.games : auditByKey.size !== 0) {
        throw new Error(`${cell.id}: audit row count ${auditByKey.size} does not match profile/games`);
    }

    let candidateWins = 0;
    let opponentWins = 0;
    let draws = 0;
    let drawOrArmageddon = 0;
    let candidateRejections = 0;
    let opponentRejections = 0;
    let missingRejectionCounts = 0;
    let candidateWinsAsGreen = 0;
    let candidateWinsAsRed = 0;
    const seatCounts: Record<
        V07ComposedCandidateSeat,
        { games: number; wins: number; losses: number; draws: number; drawOrArmageddon: number }
    > = {
        candidate_green: { games: 0, wins: 0, losses: 0, draws: 0, drawOrArmageddon: 0 },
        candidate_red: { games: 0, wins: 0, losses: 0, draws: 0, drawOrArmageddon: 0 },
    };
    const endReasons: Record<string, number> = {};
    const moments: ISetupConditionalPairMoments = {
        clusters: 0,
        sumWinSquared: 0,
        sumWinDecisive: 0,
        sumDecisiveSquared: 0,
    };
    const search = {
        auditRows: 0,
        decisions: 0,
        searched: 0,
        overrides: 0,
        illegalIncumbent: 0,
        deadlineFallbacks: 0,
        circuitOpenedGames: 0,
        circuitSkipped: 0,
        deadlineFallbackRate: 0,
        msTotal: 0,
        msPerSearchedDecision: null as number | null,
        gameMs: null as { p50: number; p95: number; p99: number; max: number } | null,
    };
    const searchGameMs: number[] = [];

    for (let pair = 0; pair < cell.pairScenarios; pair += 1) {
        const even = byGame.get(pair * 2)!;
        const odd = byGame.get(pair * 2 + 1)!;
        const expectedScenarioRoot = scenarioSeed(cell, pair);
        let pairWins = 0;
        let pairDecisive = 0;
        for (const record of [even, odd]) {
            const expectedCandidateGreen = record.game % 2 === 0;
            const expectedSeat: V07ComposedCandidateSeat = expectedCandidateGreen ? "candidate_green" : "candidate_red";
            const expectedAttempt = cell.scenarioProtocol === "independent_seat_conditioned" ? record.setupAttempt : 0;
            if (
                !Number.isSafeInteger(expectedAttempt) ||
                expectedAttempt < 0 ||
                expectedAttempt >=
                    (cell.scenarioProtocol === "independent_seat_conditioned" ? V07_COMPOSED_TAXONOMY_MAX_ATTEMPTS : 1)
            ) {
                throw new Error(`${cell.id}/${record.game}: setup attempt is outside the frozen protocol`);
            }
            const expectedSetupSeed = v07ComposedSetupSeed(cell, pair, expectedSeat, expectedAttempt ?? -1);
            const expectedCombatSeed = v07ComposedCombatSeed(cell, pair, expectedSeat);
            if (
                record.schemaVersion !== 1 ||
                record.manifestId !== manifest.manifestId ||
                record.cellId !== cell.id ||
                record.profile !== cell.profile ||
                record.distribution !== cell.distribution ||
                record.scenarioProtocol !== cell.scenarioProtocol ||
                record.archetype !== cell.archetype ||
                record.template !== cell.template ||
                record.pair !== pair ||
                record.scenarioRoot !== expectedScenarioRoot ||
                record.candidateSeatStream !== expectedSeat ||
                record.setupAttempt !== expectedAttempt ||
                record.setupSeed !== expectedSetupSeed ||
                record.combatSeed !== expectedCombatSeed ||
                record.candidateIsGreen !== expectedCandidateGreen ||
                record.greenVersion !== (expectedCandidateGreen ? cell.candidate : cell.opponent) ||
                record.redVersion !== (expectedCandidateGreen ? cell.opponent : cell.candidate)
            ) {
                throw new Error(`${cell.id}/${record.game}: raw row violates the frozen side-swap protocol`);
            }
            if (cell.distribution === "ranked_taxonomy") {
                const counts = record.taxonomyTraitCounts;
                const taxonomy = new Set(V07_ARCHETYPE_TAXONOMY[cell.archetype!]);
                if (
                    !counts ||
                    counts.lower !== counts.lowerMembers.length ||
                    counts.upper !== counts.upperMembers.length ||
                    counts.candidate !== (expectedCandidateGreen ? counts.lower : counts.upper) ||
                    counts.opponent !== (expectedCandidateGreen ? counts.upper : counts.lower) ||
                    counts.candidate < 1 ||
                    counts.lowerMembers.some((name) => !taxonomy.has(name)) ||
                    counts.upperMembers.some((name) => !taxonomy.has(name))
                ) {
                    throw new Error(`${cell.id}/${record.game}: candidate-side taxonomy conditioning is invalid`);
                }
            } else if (record.taxonomyTraitCounts !== undefined) {
                throw new Error(`${cell.id}/${record.game}: non-taxonomy row carries taxonomy evidence`);
            }
            if (
                !/^[0-9a-f]{64}$/.test(record.physicalSetupSha256) ||
                !/^[0-9a-f]{64}$/.test(record.resultFingerprint) ||
                !record.lowerRoster ||
                !record.upperRoster ||
                !Number.isSafeInteger(record.laps) ||
                record.laps < 0 ||
                !["green", "red", "draw"].includes(record.winner) ||
                !["elimination", "turn_cap", "stuck"].includes(record.endReason) ||
                typeof record.decidedByArmageddon !== "boolean" ||
                typeof record.reachedArmageddon !== "boolean" ||
                (record.decidedByArmageddon && !record.reachedArmageddon)
            ) {
                throw new Error(`${cell.id}/${record.game}: malformed outcome/integrity fields`);
            }
            validateActionTelemetry(record.candidateActions, `${cell.id}/${record.game}.candidateActions`);
            validateActionTelemetry(record.opponentActions, `${cell.id}/${record.game}.opponentActions`);
            const expectedWinnerSlot =
                record.winner === "draw"
                    ? "draw"
                    : record.winner === (expectedCandidateGreen ? "green" : "red")
                      ? "candidate"
                      : "opponent";
            if (record.winnerSlot !== expectedWinnerSlot) {
                throw new Error(`${cell.id}/${record.game}: winner attribution is inconsistent`);
            }
            const seatCount = seatCounts[expectedSeat];
            seatCount.games += 1;
            seatCount.drawOrArmageddon += Number(record.winner === "draw" || record.reachedArmageddon);
            if (record.rejectedGreen === undefined || record.rejectedRed === undefined) {
                missingRejectionCounts += 1;
            } else if (expectedCandidateGreen) {
                candidateRejections += requireFiniteCount(record.rejectedGreen, "rejectedGreen");
                opponentRejections += requireFiniteCount(record.rejectedRed, "rejectedRed");
            } else {
                candidateRejections += requireFiniteCount(record.rejectedRed, "rejectedRed");
                opponentRejections += requireFiniteCount(record.rejectedGreen, "rejectedGreen");
            }
            if (record.winnerSlot === "candidate") {
                candidateWins += 1;
                seatCount.wins += 1;
                pairWins += 1;
                pairDecisive += 1;
                if (expectedCandidateGreen) candidateWinsAsGreen += 1;
                else candidateWinsAsRed += 1;
            } else if (record.winnerSlot === "opponent") {
                opponentWins += 1;
                seatCount.losses += 1;
                pairDecisive += 1;
            } else {
                draws += 1;
                seatCount.draws += 1;
            }
            drawOrArmageddon += Number(record.winner === "draw" || record.reachedArmageddon);
            endReasons[record.endReason] = (endReasons[record.endReason] ?? 0) + 1;
            if (profile.search) {
                const key = auditKey(record.combatSeed, record.greenVersion, record.redVersion);
                const audit = auditByKey.get(key);
                if (!audit) throw new Error(`${cell.id}/${record.game}: no exact search-audit join`);
                validateAuditRow(audit, profile, record);
                auditByKey.delete(key);
                search.auditRows += 1;
                search.decisions += audit.decisions;
                search.searched += audit.searched;
                search.overrides += audit.overrides;
                search.illegalIncumbent += audit.illegalIncumbent;
                search.deadlineFallbacks += audit.deadlineFallbacks;
                search.circuitOpenedGames += Number(audit.circuitOpened);
                search.circuitSkipped += audit.circuitSkipped;
                search.msTotal += audit.msTotal;
                searchGameMs.push(audit.msTotal);
            }
        }
        if (cell.scenarioProtocol === "fixed_physical_side_swap") {
            if (
                even.setupSeed !== odd.setupSeed ||
                even.combatSeed !== odd.combatSeed ||
                even.physicalSetupSha256 !== odd.physicalSetupSha256 ||
                even.lowerRoster !== odd.lowerRoster ||
                even.upperRoster !== odd.upperRoster
            ) {
                throw new Error(`${cell.id}/${pair}: physical setup/combat changed within the side swap`);
            }
        } else if (even.setupSeed === odd.setupSeed || even.combatSeed === odd.combatSeed) {
            throw new Error(`${cell.id}/${pair}: taxonomy seat streams are not independently seeded`);
        }
        if (cell.profile === "off") {
            const symmetricWinner =
                (even.winnerSlot === "draw" && odd.winnerSlot === "draw") ||
                (even.winnerSlot !== "draw" && odd.winnerSlot !== "draw" && even.winnerSlot !== odd.winnerSlot);
            if (!symmetricWinner || even.resultFingerprint !== odd.resultFingerprint) {
                throw new Error(`${cell.id}/${pair}: v0.7s-v0.7 search-off control is not exact`);
            }
        }
        if (cell.scenarioProtocol === "fixed_physical_side_swap") {
            moments.clusters += 1;
            moments.sumWinSquared += pairWins * pairWins;
            moments.sumWinDecisive += pairWins * pairDecisive;
            moments.sumDecisiveSquared += pairDecisive * pairDecisive;
        }
    }
    if (auditByKey.size) throw new Error(`${cell.id}: ${auditByKey.size} search audits did not join raw rows`);
    search.deadlineFallbackRate = search.searched ? search.deadlineFallbacks / search.searched : 0;
    search.msPerSearchedDecision = search.searched ? search.msTotal / search.searched : null;
    if (searchGameMs.length) {
        const sorted = [...searchGameMs].sort((a, b) => a - b);
        const nearestRank = (percentile: number): number =>
            sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
        search.gameMs = {
            p50: nearestRank(0.5),
            p95: nearestRank(0.95),
            p99: nearestRank(0.99),
            max: sorted[sorted.length - 1],
        };
    }
    const pairedDiagnosticApplicable = cell.scenarioProtocol === "fixed_physical_side_swap";
    const estimate = pairedDiagnosticApplicable ? pairedClusterEstimate(candidateWins, opponentWins, moments) : null;
    const decisive = candidateWins + opponentWins;
    const candidateWinRate = decisive ? candidateWins / decisive : 0;
    const formalSeatEvidence = Object.fromEntries(
        (["candidate_green", "candidate_red"] as const).map((seat) => {
            const counts = seatCounts[seat];
            const seatDecisive = counts.wins + counts.losses;
            const decisiveFraction = counts.games ? seatDecisive / counts.games : 0;
            const drawOrArmageddonFraction = counts.games ? counts.drawOrArmageddon / counts.games : 0;
            const interval = v07ComposedWilsonInterval(counts.wins, counts.losses, manifest.gates.formalZ);
            const wilson = interval
                ? {
                      method: "bonferroni_two_sided_wilson" as const,
                      hypotheses: 26 as const,
                      nominalFamilywiseConfidence: 0.95 as const,
                      z: manifest.gates.formalZ,
                      ...interval,
                  }
                : null;
            const decisiveFractionPassed = decisiveFraction >= manifest.gates.minimumSeatDecisiveFraction;
            const wilsonLowPassed = wilson !== null && wilson.low >= manifest.gates.qualificationSeatWilsonLow;
            const drawOrArmageddonPassed = drawOrArmageddonFraction <= manifest.gates.maxSeatDrawOrArmageddonFraction;
            const evidence: IV07ComposedSeatEvidence = {
                games: counts.games,
                decisive: seatDecisive,
                wins: counts.wins,
                losses: counts.losses,
                draws: counts.draws,
                drawOrArmageddon: counts.drawOrArmageddon,
                drawOrArmageddonFraction,
                decisiveFraction,
                decisiveWinRate: seatDecisive ? counts.wins / seatDecisive : null,
                wilson,
                decisiveFractionPassed,
                wilsonLowPassed,
                drawOrArmageddonPassed,
                passed: decisiveFractionPassed && wilsonLowPassed && drawOrArmageddonPassed,
            };
            return [seat, evidence];
        }),
    ) as Record<V07ComposedCandidateSeat, IV07ComposedSeatEvidence>;
    const zeroEngineRejections = missingRejectionCounts === 0 && candidateRejections === 0 && opponentRejections === 0;
    const zeroIllegalIncumbents = search.illegalIncumbent === 0;
    const offControlExact = cell.profile !== "off" || candidateWins === opponentWins;
    const applicable = cell.qualification;
    const everySeatDecisiveFractionPassed = Object.values(formalSeatEvidence).every(
        (seat) => seat.decisiveFractionPassed,
    );
    const everySeatWilsonLowPassed = Object.values(formalSeatEvidence).every((seat) => seat.wilsonLowPassed);
    const everySeatDrawOrArmageddonPassed = Object.values(formalSeatEvidence).every(
        (seat) => seat.drawOrArmageddonPassed,
    );
    const outcomePassed =
        !applicable || (everySeatDecisiveFractionPassed && everySeatWilsonLowPassed && everySeatDrawOrArmageddonPassed);
    const latencyAttritionPassed =
        !applicable ||
        (search.searched > 0 &&
            search.deadlineFallbackRate <= manifest.gates.maxQualificationDeadlineFallbackRate &&
            search.circuitOpenedGames <= manifest.gates.maxQualificationCircuitOpenedGames &&
            search.circuitSkipped <= manifest.gates.maxQualificationCircuitSkippedDecisions);
    return {
        cell,
        games: cell.games,
        pairScenarios: cell.pairScenarios,
        decisive,
        candidateWins,
        opponentWins,
        draws,
        candidateWinRate,
        clusteredSePp: estimate?.standardErrorPp ?? null,
        confidence95: estimate?.confidence95 ?? null,
        pairedDiagnosticApplicable,
        formalSeatEvidence,
        pairMoments: { ...moments },
        drawOrArmageddon,
        drawOrArmageddonRate: drawOrArmageddon / cell.games,
        endReasons,
        candidateRejections,
        opponentRejections,
        missingRejectionCounts,
        candidateWinsAsGreen,
        candidateWinsAsRed,
        search,
        integrity: {
            complete: true,
            fixedPhysicalSideSwapExact: pairedDiagnosticApplicable ? true : null,
            independentSeatStreamsExact: pairedDiagnosticApplicable ? null : true,
            seatConditioningExact: pairedDiagnosticApplicable ? null : true,
            auditJoinedExactly: true,
            offControlExact,
            zeroEngineRejections,
            zeroIllegalIncumbents,
        },
        gate: {
            applicable,
            seatWilsonThreshold: manifest.gates.qualificationSeatWilsonLow,
            minimumSeatDecisiveFraction: manifest.gates.minimumSeatDecisiveFraction,
            everySeatDecisiveFractionPassed,
            everySeatWilsonLowPassed,
            everySeatDrawOrArmageddonPassed,
            outcomePassed,
            latencyAttritionPassed,
            passed: outcomePassed && latencyAttritionPassed && zeroEngineRejections && zeroIllegalIncumbents,
        },
    };
}

export function verifyV07ComposedSourceHashes(manifest: IV07ComposedManifest, commonRoot = process.cwd()): void {
    for (const [relativePath, expected] of Object.entries(manifest.sourceProvenance.requiredSha256)) {
        const path = resolve(commonRoot, relativePath);
        if (!existsSync(path)) throw new Error(`Missing frozen protocol source ${relativePath}`);
        const actual = fileSha256(path);
        if (actual !== expected)
            throw new Error(`Frozen protocol source changed: ${relativePath} ${actual} != ${expected}`);
    }
    const runtimeTree = v07ComposedRuntimeTreeFingerprint(commonRoot);
    if (
        runtimeTree.files !== manifest.sourceProvenance.runtimeTree.files ||
        runtimeTree.sha256 !== manifest.sourceProvenance.runtimeTree.sha256
    ) {
        throw new Error(
            `Frozen runtime source tree changed: ${runtimeTree.files}/${runtimeTree.sha256} != ` +
                `${manifest.sourceProvenance.runtimeTree.files}/${manifest.sourceProvenance.runtimeTree.sha256}`,
        );
    }
    if (fileSha256(resolve(commonRoot, "package.json")) !== manifest.sourceProvenance.packageJsonSha256) {
        throw new Error("Frozen package.json changed");
    }
    for (const [path, expected] of [
        [V07_COMPOSED_OBSERVED_BENCHMARK.scriptEvidencePath, V07_COMPOSED_OBSERVED_BENCHMARK.scriptSha256],
        [
            V07_COMPOSED_OBSERVED_BENCHMARK.concurrentTournamentSourcePath,
            V07_COMPOSED_OBSERVED_BENCHMARK.concurrentTournamentSourceSha256,
        ],
        [
            V07_COMPOSED_OBSERVED_BENCHMARK.tournamentWorkerSourcePath,
            V07_COMPOSED_OBSERVED_BENCHMARK.tournamentWorkerSourceSha256,
        ],
        [V07_COMPOSED_OBSERVED_BENCHMARK.tournamentSourcePath, V07_COMPOSED_OBSERVED_BENCHMARK.tournamentSourceSha256],
    ] as const) {
        const absolutePath = resolve(commonRoot, path);
        if (!existsSync(absolutePath) || fileSha256(absolutePath) !== expected) {
            throw new Error(`Observed benchmark seed-source provenance changed: ${path}`);
        }
    }
    if (existsSync(resolve(commonRoot, "bun.lock")) || existsSync(resolve(commonRoot, "bun.lockb"))) {
        throw new Error("Composed-ranked runtime requires the repository's intentional no-Bun-lock policy");
    }
    const requireFromCommon = createRequire(resolve(commonRoot, "package.json"));
    for (const dependency of V07_COMPOSED_RUNTIME_DEPENDENCIES) {
        const binding = manifest.runtimeProvenance.dependencies[dependency];
        const packageJsonPath = resolve(commonRoot, binding.packageJsonPath);
        const entryPath = resolve(commonRoot, binding.entryPath);
        if (
            fileSha256(packageJsonPath) !== binding.packageJsonSha256 ||
            fileSha256(entryPath) !== binding.entrySha256
        ) {
            throw new Error(`Frozen runtime bytes changed for ${dependency}`);
        }
        const metadata = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: string; version?: string };
        if (metadata.name !== dependency || metadata.version !== binding.version) {
            throw new Error(`Frozen runtime package metadata changed for ${dependency}`);
        }
        if (realpathSync(requireFromCommon.resolve(dependency)) !== realpathSync(entryPath)) {
            throw new Error(`Runtime resolution changed for ${dependency}`);
        }
        const tree = v07ComposedDirectoryFingerprint(dirname(packageJsonPath));
        if (tree.files !== binding.treeFiles || tree.sha256 !== binding.treeSha256) {
            throw new Error(`Frozen full dependency tree changed for ${dependency}`);
        }
    }
    if (
        Bun.version !== manifest.runtimeProvenance.bun.version ||
        Bun.revision !== manifest.runtimeProvenance.bun.revision ||
        fileSha256(process.execPath) !== manifest.runtimeProvenance.bun.executableSha256
    ) {
        throw new Error("Bun runtime binary/revision differs from the frozen execution runtime");
    }
}

export function assertV07ComposedExecutionEnvironment(
    manifest: IV07ComposedManifest,
    outputRoot: string,
    commonRoot = process.cwd(),
): void {
    const canonicalRoot = realpathSync(resolve(commonRoot));
    if (realpathSync(process.cwd()) !== canonicalRoot) {
        throw new Error("Composed-ranked parent must start with cwd equal to the common repository root");
    }
    const gitRoot = realpathSync(
        execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: canonicalRoot, encoding: "utf8" }).trim(),
    );
    if (gitRoot !== canonicalRoot) throw new Error("Composed-ranked commonRoot is not the Git worktree root");
    const requestedOutput = resolve(outputRoot);
    for (let cursor = requestedOutput; ; cursor = dirname(cursor)) {
        if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
            throw new Error(`Composed-ranked output path contains a symbolic-link component: ${cursor}`);
        }
        const parent = dirname(cursor);
        if (parent === cursor) break;
    }
    mkdirSync(requestedOutput, { recursive: true });
    const canonicalOutput = realpathSync(requestedOutput);
    if (canonicalOutput !== requestedOutput) {
        throw new Error("Composed-ranked output path must already be canonical and contain no aliases");
    }
    if (canonicalOutput === canonicalRoot || canonicalOutput.startsWith(`${canonicalRoot}/`)) {
        throw new Error("Composed-ranked output must live outside the repository");
    }
    for (const path of manifest.runtimeProvenance.forbiddenConfigPaths.map((path) => resolve(canonicalRoot, path))) {
        if (existsSync(path)) throw new Error(`Forbidden Bun project config exists: ${path}`);
    }
    for (const path of manifest.runtimeProvenance.forbiddenHomeConfigPaths.map((path) => resolve(homedir(), path))) {
        if (existsSync(path)) throw new Error(`Forbidden Bun home config exists: ${path}`);
    }
    for (const key of manifest.runtimeProvenance.forbiddenEnvironmentKeys) {
        if (process.env[key]) throw new Error(`Forbidden runtime injection environment is set: ${key}`);
    }
    if (process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH !== "0") {
        throw new Error("Parent must start with BUN_RUNTIME_TRANSPILER_CACHE_PATH=0");
    }
    if (process.env.V07_COMPOSED_HOST_IDLE_ATTESTATION !== "1") {
        throw new Error("Parent must explicitly attest that the execution host is otherwise idle");
    }
    if (process.execArgv.length !== 0) {
        throw new Error("Composed-ranked parent process must have an empty execArgv runtime envelope");
    }
    verifyV07ComposedSourceHashes(manifest, canonicalRoot);
}

export interface IV07ComposedHostLockMetadata {
    schemaVersion: 1;
    protocol: "v0.7-composed-ranked";
    manifestId: string;
    manifestSha256: string;
    gitCommit: string;
    hostname: string;
    pid: number;
    mode: "cell" | "assemble";
    cellId?: string;
    outputRoot: string;
    acquiredAt: string;
}

export const V07_COMPOSED_HOST_LOCK_PATH = join(tmpdir(), "heroes-of-crypto-v0.7-composed-ranked.lock");

/** Host-wide exclusive lock. Any stale lock is intentionally fail-closed and requires audited manual removal. */
export function acquireV07ComposedHostLock(
    binding: Pick<
        IV07ComposedHostLockMetadata,
        "manifestId" | "manifestSha256" | "gitCommit" | "mode" | "cellId" | "outputRoot"
    >,
    lockPath = V07_COMPOSED_HOST_LOCK_PATH,
): { metadata: IV07ComposedHostLockMetadata; release: () => void } {
    const metadata: IV07ComposedHostLockMetadata = {
        schemaVersion: 1,
        protocol: "v0.7-composed-ranked",
        manifestId: binding.manifestId,
        manifestSha256: binding.manifestSha256,
        gitCommit: binding.gitCommit,
        hostname: hostname(),
        pid: process.pid,
        mode: binding.mode,
        ...(binding.cellId ? { cellId: binding.cellId } : {}),
        outputRoot: resolve(binding.outputRoot),
        acquiredAt: new Date().toISOString(),
    };
    const bytes = `${JSON.stringify(metadata, null, 2)}\n`;
    let descriptor: number;
    try {
        descriptor = openSync(lockPath, "wx", 0o600);
        writeSync(descriptor, bytes);
        fsyncSync(descriptor);
    } catch (error) {
        throw new Error(
            `Composed-ranked host lock exists or cannot be acquired; never auto-clear stale locks: ${lockPath} (${String(error)})`,
        );
    }
    let released = false;
    return {
        metadata,
        release: () => {
            if (released) throw new Error(`Composed-ranked host lock was already released: ${lockPath}`);
            if (readFileSync(lockPath, "utf8") !== bytes) {
                closeSync(descriptor);
                released = true;
                throw new Error(`Composed-ranked host lock changed while held; leaving it fail-closed: ${lockPath}`);
            }
            closeSync(descriptor);
            unlinkSync(lockPath);
            released = true;
        },
    };
}

export function normalizeV07ComposedOriginIdentity(value: string): string {
    const trimmed = value.trim();
    const normalized = trimmed
        .replace(/^ssh:\/\/git@/i, "")
        .replace(/^git@/i, "")
        .replace(/^https?:\/\//i, "")
        .replace(/^github\.com:/i, "github.com/")
        .replace(/\.git\/?$/i, "")
        .replace(/\/$/, "");
    return normalized.toLowerCase().startsWith("github.com/") ? normalized.toLowerCase() : trimmed;
}

export function gitProvenance(
    commonRoot = process.cwd(),
    preregisteredBaseCommit?: string,
    expectedOriginIdentity: string = V07_COMPOSED_ORIGIN_IDENTITY,
): {
    commit: string;
    originMain: string;
    remoteOriginMain: string;
    originUrl: string;
    originIdentity: string;
    branch: string;
    cleanIncludingUntracked: boolean;
    statusPorcelainSha256: string | null;
    preregisteredBaseCommit: string | null;
    preregisteredBaseIsAncestor: boolean;
} {
    const git = (...args: string[]): string =>
        execFileSync("git", args, { cwd: commonRoot, encoding: "utf8" }).trimEnd();
    const branch = git("rev-parse", "--abbrev-ref", "HEAD");
    if (branch !== "main") throw new Error(`Composed-ranked ladder must run on main; current branch is ${branch}`);
    const originUrl = git("remote", "get-url", "origin");
    const originIdentity = normalizeV07ComposedOriginIdentity(originUrl);
    if (originIdentity !== normalizeV07ComposedOriginIdentity(expectedOriginIdentity)) {
        throw new Error(`Composed-ranked ladder requires origin ${expectedOriginIdentity}; got ${originUrl}`);
    }
    const commit = git("rev-parse", "HEAD");
    const originMain = git("rev-parse", "origin/main");
    if (commit !== originMain) {
        throw new Error(`Composed-ranked ladder requires pushed main: HEAD ${commit} != origin/main ${originMain}`);
    }
    const remoteLine = git("ls-remote", "origin", "refs/heads/main");
    const remoteMatch = /^([0-9a-f]{40})\s+refs\/heads\/main$/.exec(remoteLine);
    if (!remoteMatch) throw new Error("Composed-ranked ladder could not attest live origin main");
    const remoteOriginMain = remoteMatch[1];
    if (commit !== remoteOriginMain) {
        throw new Error(
            `Composed-ranked ladder requires live pushed main: HEAD ${commit} != remote ${remoteOriginMain}`,
        );
    }
    const status = git("status", "--porcelain=v1", "--untracked-files=all");
    let preregisteredBaseIsAncestor = false;
    if (preregisteredBaseCommit) {
        if (!/^[0-9a-f]{40}$/.test(preregisteredBaseCommit)) {
            throw new Error("Preregistered common base must be a 40-hex commit");
        }
        try {
            execFileSync("git", ["merge-base", "--is-ancestor", preregisteredBaseCommit, commit], {
                cwd: commonRoot,
                stdio: "ignore",
            });
            preregisteredBaseIsAncestor = true;
        } catch {
            throw new Error(`Preregistered common base ${preregisteredBaseCommit} is not an ancestor of ${commit}`);
        }
    }
    return {
        commit,
        originMain,
        remoteOriginMain,
        originUrl,
        originIdentity,
        branch,
        cleanIncludingUntracked: status.length === 0,
        statusPorcelainSha256: status ? sha256(status) : null,
        preregisteredBaseCommit: preregisteredBaseCommit ?? null,
        preregisteredBaseIsAncestor,
    };
}

interface IV07ComposedWorkerData {
    manifestId: string;
    cell: IV07ComposedCell;
    worker: number;
    environment: Record<string, string>;
    environmentSha256: string;
    auditPath: string;
}

type WorkerMessage =
    | { type: "ready"; attestation: IV07ComposedWorkerAttestation }
    | { type: "result"; record: IV07ComposedGameRecord }
    | { type: "error"; error: string };

async function runWorkerPool(
    manifestId: string,
    cell: IV07ComposedCell,
    profile: IV07ComposedSearchProfile,
    auditDir: string,
    concurrency: number,
    maximumElapsedMs: number,
): Promise<{ records: IV07ComposedGameRecord[]; workers: IV07ComposedWorkerAttestation[] }> {
    const poolSize = Math.min(concurrency, cell.games);
    const workers: Worker[] = [];
    const records: IV07ComposedGameRecord[] = [];
    const attestations: IV07ComposedWorkerAttestation[] = [];
    let nextGame = 0;
    let completed = 0;
    let settled = false;
    const started = Date.now();
    let lastProgress = started;

    return await new Promise((resolvePromise, rejectPromise) => {
        let hardDeadline: ReturnType<typeof setTimeout>;
        const inactivityWatchdog = setInterval(() => {
            if (!settled && Date.now() - lastProgress > 30 * 60 * 1000) {
                fail(new Error(`${cell.id}: worker pool made no progress for 30 minutes`));
            }
        }, 60_000);
        inactivityWatchdog.unref();
        const terminate = async (): Promise<void> => {
            await Promise.all(workers.map(async (worker) => void (await worker.terminate())));
        };
        const fail = (error: unknown): void => {
            if (settled) return;
            settled = true;
            clearInterval(inactivityWatchdog);
            clearTimeout(hardDeadline);
            void terminate().finally(() => rejectPromise(error instanceof Error ? error : new Error(String(error))));
        };
        const dispatch = (worker: Worker): void => {
            if (nextGame < cell.games) worker.postMessage({ type: "game", game: nextGame++ });
        };
        const finish = (): void => {
            if (settled) return;
            settled = true;
            clearInterval(inactivityWatchdog);
            clearTimeout(hardDeadline);
            void terminate().then(() => resolvePromise({ records, workers: attestations }), rejectPromise);
        };
        hardDeadline = setTimeout(
            () => fail(new Error(`${cell.id}: worker pool exceeded the frozen ${maximumElapsedMs}ms cell limit`)),
            maximumElapsedMs,
        );
        hardDeadline.unref();
        const workerUrl = new URL("./v0_7_composed_ranked_ladder_worker.ts", import.meta.url);
        for (let index = 0; index < poolSize; index += 1) {
            const auditPath = join(auditDir, `worker-${String(index).padStart(2, "0")}.jsonl`);
            const environment = canonicalV07ComposedEnvironment(profile, auditPath);
            const data: IV07ComposedWorkerData = {
                manifestId,
                cell,
                worker: index,
                environment,
                environmentSha256: environmentFingerprint(environment),
                auditPath,
            };
            const worker = new Worker(workerUrl, { workerData: data });
            workers.push(worker);
            worker.on("message", (message: WorkerMessage) => {
                if (settled) return;
                lastProgress = Date.now();
                if (message.type === "error") {
                    fail(new Error(message.error));
                    return;
                }
                if (message.type === "ready") {
                    attestations.push(message.attestation);
                    dispatch(worker);
                    return;
                }
                records.push(message.record);
                completed += 1;
                if (completed % 100 === 0 || completed === cell.games) {
                    const elapsed = Math.max(1, (Date.now() - started) / 1000);
                    console.log(
                        `[${cell.id}] ${completed}/${cell.games} (${(completed / elapsed).toFixed(1)} games/s)`,
                    );
                }
                if (completed === cell.games) finish();
                else dispatch(worker);
            });
            worker.on("error", fail);
            worker.on("exit", (code) => {
                if (!settled) fail(new Error(`${cell.id}: worker ${index} exited before pool completion (${code})`));
            });
        }
    });
}

function atomicWrite(path: string, contents: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${process.pid}`;
    writeFileSync(temporary, contents);
    renameSync(temporary, path);
}

function relativeArtifactPath(root: string, path: string): string {
    const normalizedRoot = resolve(root);
    const normalizedPath = resolve(path);
    if (!normalizedPath.startsWith(`${normalizedRoot}/`)) throw new Error(`${path} is outside ${root}`);
    return normalizedPath.slice(normalizedRoot.length + 1);
}

function resolveArtifactPath(root: string, relativePath: string): string {
    const normalizedRoot = resolve(root);
    const path = resolve(normalizedRoot, relativePath);
    if (!path.startsWith(`${normalizedRoot}/`)) throw new Error(`Artifact path escapes run root: ${relativePath}`);
    return path;
}

function collectAudits(auditDir: string): { rows: IV07ComposedAuditRow[]; files: string[] } {
    if (!existsSync(auditDir)) throw new Error(`Missing worker audit directory ${auditDir}`);
    const files = readdirSync(auditDir)
        .filter((name) => /^worker-[0-9]{2}\.jsonl$/.test(name))
        .map((name) => join(auditDir, name))
        .sort();
    return { files, rows: files.flatMap((path) => parseJsonl<IV07ComposedAuditRow>(path)) };
}

export async function runV07ComposedCell(
    manifest: IV07ComposedManifest,
    provenance: IV07ComposedManifestProvenance,
    cellId: string,
    outputRoot: string,
    concurrency: number,
): Promise<IV07ComposedCellCompletion> {
    validateV07ComposedManifest(manifest);
    if (concurrency !== manifest.execution.requiredConcurrency) {
        throw new Error(`Composed-ranked concurrency must equal ${manifest.execution.requiredConcurrency}`);
    }
    assertV07ComposedExecutionEnvironment(manifest, outputRoot);
    const git = gitProvenance(process.cwd(), manifest.sourceProvenance.preregisteredCommonBaseCommit);
    if (!git.cleanIncludingUntracked) {
        throw new Error("Composed-ranked cell requires a clean main checkout including ordinary untracked files");
    }
    const cell = manifest.cells.find((candidate) => candidate.id === cellId);
    if (!cell) throw new Error(`Unknown composed-ranked cell ${cellId}`);
    const hostLock = acquireV07ComposedHostLock({
        manifestId: manifest.manifestId,
        manifestSha256: provenance.sha256,
        gitCommit: git.commit,
        mode: "cell",
        cellId: cell.id,
        outputRoot,
    });
    try {
        const profile = manifest.searchProfiles[cell.profile];
        const runRoot = resolve(outputRoot, manifest.manifestId);
        const cellDir = join(runRoot, "cells", cell.id);
        if (existsSync(cellDir)) {
            throw new Error(`Refusing to mix or overwrite an existing cell directory: ${cellDir}`);
        }
        const currentHost: IV07ComposedCellCompletion["host"] = {
            hostname: hostname(),
            platform: platform(),
            arch: arch(),
            cpuModel: cpus()[0]?.model ?? "unknown",
            availableParallelism: availableParallelism(),
            bunVersion: Bun.version,
            bunRevision: Bun.revision,
            bunExecutableSha256: fileSha256(process.execPath),
        };
        const cellIndex = manifest.cells.findIndex((candidate) => candidate.id === cell.id);
        const priorCells = manifest.cells.slice(0, cellIndex);
        const validatedPriorCompletions = priorCells.map((priorCell) => {
            return validateV07ComposedCellArtifact(manifest, provenance, outputRoot, priorCell);
        });
        assertV07ComposedPriorStageIntegrity(validatedPriorCompletions);
        if (validatedPriorCompletions.length) {
            assertV07ComposedUniformExecutionEnvelope([
                ...validatedPriorCompletions,
                { cellId: cell.id, host: currentHost, concurrency: { requested: concurrency, workers: concurrency } },
            ]);
            if (validatedPriorCompletions.some((completion) => completion.git.commit !== git.commit)) {
                throw new Error(`${cell.id}: prior-stage commit differs from the current execution commit`);
            }
        }
        const priorStageCompletions = priorCells.map((priorCell) => {
            const completionPath = join(runRoot, "cells", priorCell.id, "complete.json");
            return { cellId: priorCell.id, completionSha256: fileSha256(completionPath) };
        });
        const taxonomyPlan = cell.stage === 0 ? verifyV07ComposedTaxonomyPlan(manifest) : manifest.draft.taxonomyPlan;
        const startedAt = new Date().toISOString();
        const auditDir = join(cellDir, "audit");
        mkdirSync(auditDir, { recursive: true });
        try {
            const pool = await runWorkerPool(
                manifest.manifestId,
                cell,
                profile,
                auditDir,
                concurrency,
                manifest.execution.maxCellElapsedMs,
            );
            verifyV07ComposedSourceHashes(manifest);
            const finalGit = gitProvenance(process.cwd(), manifest.sourceProvenance.preregisteredCommonBaseCommit);
            if (
                !finalGit.cleanIncludingUntracked ||
                finalGit.commit !== git.commit ||
                finalGit.statusPorcelainSha256 !== git.statusPorcelainSha256
            ) {
                throw new Error(`${cell.id}: source revision changed while the cell was running`);
            }
            const records = [...pool.records].sort((a, b) => a.game - b.game);
            const rawPath = join(cellDir, "raw.jsonl");
            atomicWrite(rawPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
            const reparsed = parseJsonl<IV07ComposedGameRecord>(rawPath);
            const audits = collectAudits(auditDir);
            const report = summarizeV07ComposedCell(manifest, cell, reparsed, audits.rows);
            const completedAt = new Date().toISOString();
            assertV07ComposedElapsedWithin(
                startedAt,
                completedAt,
                manifest.execution.maxCellElapsedMs,
                `${cell.id} cell`,
            );
            const completion: IV07ComposedCellCompletion = {
                schemaVersion: 1,
                manifestId: manifest.manifestId,
                manifestSha256: provenance.sha256,
                cellId: cell.id,
                startedAt,
                completedAt,
                git,
                sourceHashesVerified: true,
                runtimeProvenanceVerified: true,
                taxonomyPlanVerified: true,
                taxonomyPlanSha256: taxonomyPlan.sha256,
                hostLock: hostLock.metadata,
                priorStageCompletions,
                host: currentHost,
                concurrency: { requested: concurrency, workers: pool.workers.length },
                profileEnvironmentSha256: environmentFingerprint(
                    canonicalV07ComposedEnvironment(profile, "<worker-specific-audit-path>"),
                ),
                raw: {
                    path: relativeArtifactPath(runRoot, rawPath),
                    sha256: fileSha256(rawPath),
                    bytes: statSync(rawPath).size,
                    rows: reparsed.length,
                },
                audits: audits.files.map((path) => ({
                    path: relativeArtifactPath(runRoot, path),
                    sha256: fileSha256(path),
                    bytes: statSync(path).size,
                    rows: parseJsonl<IV07ComposedAuditRow>(path).length,
                })),
                workers: pool.workers
                    .map((attestation) => ({
                        ...attestation,
                        auditFile: relativeArtifactPath(runRoot, attestation.auditFile),
                    }))
                    .sort((a, b) => a.worker - b.worker),
                report,
            };
            atomicWrite(join(cellDir, "complete.json"), `${JSON.stringify(completion, null, 2)}\n`);
            return completion;
        } catch (error) {
            atomicWrite(
                join(cellDir, "FAILED.json"),
                `${JSON.stringify({ manifestId: manifest.manifestId, cellId, failedAt: new Date().toISOString(), error: String(error) }, null, 2)}\n`,
            );
            throw error;
        }
    } finally {
        hostLock.release();
    }
}

export function validateV07ComposedCellArtifact(
    manifest: IV07ComposedManifest,
    provenance: IV07ComposedManifestProvenance,
    outputRoot: string,
    cell: IV07ComposedCell,
): IV07ComposedCellCompletion {
    const runRoot = resolve(outputRoot, manifest.manifestId);
    const cellDir = join(runRoot, "cells", cell.id);
    const completionPath = join(cellDir, "complete.json");
    if (!existsSync(completionPath)) throw new Error(`Missing completion marker for ${cell.id}`);
    const cellEntries = readdirSync(cellDir, { withFileTypes: true });
    if (
        !sameMembers(
            cellEntries.map((entry) => entry.name),
            ["audit", "complete.json", "raw.jsonl"],
        ) ||
        !cellEntries.find((entry) => entry.name === "audit")?.isDirectory() ||
        !cellEntries.find((entry) => entry.name === "complete.json")?.isFile() ||
        !cellEntries.find((entry) => entry.name === "raw.jsonl")?.isFile()
    ) {
        throw new Error(`${cell.id}: cell directory contains missing, extra, or mistyped artifacts`);
    }
    const completion = JSON.parse(readFileSync(completionPath, "utf8")) as IV07ComposedCellCompletion;
    const profile = manifest.searchProfiles[cell.profile];
    const expectedProfileFingerprint = environmentFingerprint(
        canonicalV07ComposedEnvironment(profile, "<worker-specific-audit-path>"),
    );
    if (
        completion.schemaVersion !== 1 ||
        completion.manifestId !== manifest.manifestId ||
        completion.manifestSha256 !== provenance.sha256 ||
        completion.cellId !== cell.id ||
        completion.sourceHashesVerified !== true ||
        completion.runtimeProvenanceVerified !== true ||
        completion.taxonomyPlanVerified !== true ||
        completion.taxonomyPlanSha256 !== manifest.draft.taxonomyPlan.sha256 ||
        completion.hostLock.schemaVersion !== 1 ||
        completion.hostLock.protocol !== "v0.7-composed-ranked" ||
        completion.hostLock.manifestId !== manifest.manifestId ||
        completion.hostLock.manifestSha256 !== provenance.sha256 ||
        completion.hostLock.gitCommit !== completion.git.commit ||
        !Number.isSafeInteger(completion.hostLock.pid) ||
        completion.hostLock.pid < 1 ||
        completion.hostLock.mode !== "cell" ||
        completion.hostLock.cellId !== cell.id ||
        completion.hostLock.hostname !== completion.host.hostname ||
        completion.hostLock.outputRoot !== resolve(outputRoot) ||
        !Number.isFinite(Date.parse(completion.hostLock.acquiredAt)) ||
        !Number.isFinite(Date.parse(completion.startedAt)) ||
        !Number.isFinite(Date.parse(completion.completedAt)) ||
        Date.parse(completion.hostLock.acquiredAt) > Date.parse(completion.startedAt) ||
        Date.parse(completion.startedAt) > Date.parse(completion.completedAt) ||
        completion.git.branch !== "main" ||
        !/^[0-9a-f]{40}$/.test(completion.git.commit) ||
        completion.git.originMain !== completion.git.commit ||
        completion.git.remoteOriginMain !== completion.git.commit ||
        completion.git.originIdentity !== manifest.sourceProvenance.originIdentity ||
        !completion.git.originUrl.trim() ||
        completion.git.cleanIncludingUntracked !== true ||
        completion.git.statusPorcelainSha256 !== null ||
        completion.git.preregisteredBaseCommit !== manifest.sourceProvenance.preregisteredCommonBaseCommit ||
        completion.git.preregisteredBaseIsAncestor !== true ||
        !completion.host.hostname.trim() ||
        !completion.host.platform.trim() ||
        !completion.host.arch.trim() ||
        !completion.host.cpuModel.trim() ||
        !Number.isSafeInteger(completion.host.availableParallelism) ||
        completion.host.availableParallelism < 1 ||
        completion.host.bunVersion !== manifest.runtimeProvenance.bun.version ||
        completion.host.bunRevision !== manifest.runtimeProvenance.bun.revision ||
        completion.host.bunExecutableSha256 !== manifest.runtimeProvenance.bun.executableSha256 ||
        completion.concurrency.requested !== manifest.execution.requiredConcurrency ||
        completion.concurrency.workers !== Math.min(completion.concurrency.requested, cell.games) ||
        completion.profileEnvironmentSha256 !== expectedProfileFingerprint
    ) {
        throw new Error(`${cell.id}: completion marker is not bound to this manifest`);
    }
    assertV07ComposedElapsedWithin(
        completion.startedAt,
        completion.completedAt,
        manifest.execution.maxCellElapsedMs,
        `${cell.id} cell artifact`,
    );
    const cellIndex = manifest.cells.findIndex((candidate) => candidate.id === cell.id);
    const expectedPriorStageCompletions = manifest.cells.slice(0, cellIndex).map((priorCell) => {
        const priorCompletionPath = join(runRoot, "cells", priorCell.id, "complete.json");
        if (!existsSync(priorCompletionPath)) throw new Error(`${cell.id}: missing prior cell ${priorCell.id}`);
        const priorCompletion = JSON.parse(readFileSync(priorCompletionPath, "utf8")) as IV07ComposedCellCompletion;
        if (Date.parse(priorCompletion.completedAt) > Date.parse(completion.startedAt)) {
            throw new Error(`${cell.id}: prior cell ${priorCell.id} completed after this cell started`);
        }
        return { cellId: priorCell.id, completionSha256: fileSha256(priorCompletionPath) };
    });
    if (JSON.stringify(completion.priorStageCompletions) !== JSON.stringify(expectedPriorStageCompletions)) {
        throw new Error(`${cell.id}: prior-cell completion attestations are incomplete or changed`);
    }
    const rawPath = resolveArtifactPath(runRoot, completion.raw.path);
    if (rawPath !== join(cellDir, "raw.jsonl")) throw new Error(`${cell.id}: completion registered the wrong raw path`);
    if (fileSha256(rawPath) !== completion.raw.sha256 || statSync(rawPath).size !== completion.raw.bytes) {
        throw new Error(`${cell.id}: raw artifact hash/size mismatch`);
    }
    const auditRows: IV07ComposedAuditRow[] = [];
    const auditPaths = new Set(completion.audits.map((audit) => audit.path));
    const workerIds = new Set(completion.workers.map((worker) => worker.worker));
    const expectedWorkerIds = Array.from({ length: completion.concurrency.workers }, (_, index) => index);
    const auditDir = join(cellDir, "audit");
    const auditEntries = readdirSync(auditDir, { withFileTypes: true });
    const actualAuditPaths = auditEntries.map((entry) => relativeArtifactPath(runRoot, join(auditDir, entry.name)));
    if (
        completion.workers.length !== completion.audits.length ||
        completion.workers.length !== completion.concurrency.workers ||
        auditPaths.size !== completion.audits.length ||
        workerIds.size !== completion.workers.length ||
        !sameMembers([...workerIds].map(String), expectedWorkerIds.map(String)) ||
        !sameMembers(actualAuditPaths, [...auditPaths]) ||
        auditEntries.some((entry) => !entry.isFile())
    ) {
        throw new Error(`${cell.id}: worker attestation count does not match audit-file count`);
    }
    for (const worker of completion.workers) {
        const expectedAuditFile = relativeArtifactPath(
            runRoot,
            join(auditDir, `worker-${String(worker.worker).padStart(2, "0")}.jsonl`),
        );
        if (!auditPaths.has(worker.auditFile)) {
            throw new Error(`${cell.id}: worker ${worker.worker} attests an unregistered audit file`);
        }
        if (worker.auditFile !== expectedAuditFile) {
            throw new Error(`${cell.id}: worker ${worker.worker} audit filename drifted`);
        }
        const absoluteAuditPath = resolveArtifactPath(runRoot, worker.auditFile);
        const expectedWorkerFingerprint = environmentFingerprint(
            canonicalV07ComposedEnvironment(profile, absoluteAuditPath),
        );
        if (worker.environmentSha256 !== expectedWorkerFingerprint) {
            throw new Error(`${cell.id}: worker ${worker.worker} environment fingerprint mismatch`);
        }
        if (worker.transpilerCacheDisabled !== "0") {
            throw new Error(`${cell.id}: worker ${worker.worker} did not attest disabled transpiler cache`);
        }
    }
    for (const audit of completion.audits) {
        const auditPath = resolveArtifactPath(runRoot, audit.path);
        if (fileSha256(auditPath) !== audit.sha256 || statSync(auditPath).size !== audit.bytes) {
            throw new Error(`${cell.id}: audit artifact hash/size mismatch for ${audit.path}`);
        }
        const rows = parseJsonl<IV07ComposedAuditRow>(auditPath);
        if (rows.length !== audit.rows) throw new Error(`${cell.id}: audit row-count mismatch for ${audit.path}`);
        auditRows.push(...rows);
    }
    const records = parseJsonl<IV07ComposedGameRecord>(rawPath);
    if (records.length !== completion.raw.rows) throw new Error(`${cell.id}: raw row-count mismatch`);
    replayV07ComposedTaxonomyRecords(cell, records);
    const report = summarizeV07ComposedCell(manifest, cell, records, auditRows);
    if (JSON.stringify(report) !== JSON.stringify(completion.report)) {
        throw new Error(`${cell.id}: recomputed report differs from completion marker`);
    }
    return completion;
}

export interface IV07ComposedAggregateEvidence {
    cells: string[];
    scenarioProtocols: V07ComposedScenarioProtocol[];
    games: number;
    pairScenarios: number;
    candidateWins: number;
    opponentWins: number;
    draws: number;
    candidateWinRate: number;
    policy: "EQUAL_GAME_POOLED_DIAGNOSTIC_NOT_A_FORMAL_GATE";
}

export interface IV07ComposedFinalReport {
    schemaVersion: 1;
    manifestId: string;
    manifestSha256: string;
    assembledAt: string;
    authority: "UNSEALED_NON_AUTHORITATIVE_UNTIL_GUARD_SEAL";
    git: ReturnType<typeof gitProvenance>;
    hostLock: IV07ComposedHostLockMetadata;
    allCellsComplete: true;
    completionEvidence: {
        derivation: "sha256_manifest_ordered_completion_marker_paths_and_bytes";
        markers: number;
        sha256: string;
    };
    cells: IV07ComposedCellReport[];
    executionWindow: {
        startedAt: string;
        assembledAt: string;
        elapsedMs: number;
        maxRunElapsedMs: number;
    };
    executionProvenance: Record<
        string,
        Pick<IV07ComposedCellCompletion, "startedAt" | "completedAt" | "git" | "host" | "concurrency">
    >;
    qualification: {
        cells: number;
        hypotheses: 26;
        method: "bonferroni_two_sided_wilson_by_candidate_seat";
        nominalFamilywiseConfidence: 0.95;
        rankedCell: IV07ComposedCellReport;
        taxonomyCells: Record<V07Archetype, IV07ComposedCellReport>;
        templateCells: Record<V07ArchetypeTemplateName, IV07ComposedCellReport>;
        allSeatDecisiveFractionsAtLeast90: boolean;
        allSeatWilsonLowsAtLeast90: boolean;
        allSeatDrawOrArmageddonAtMost10: boolean;
        allLatencyAttritionPassed: boolean;
        allIntegrityGatesPassed: boolean;
        verdict: "PASS" | "FAIL";
    };
    aggregateCohortEvidence: Record<"ranked" | "mage" | "meleeMage" | "aura" | "ranged", IV07ComposedAggregateEvidence>;
    diagnostics: {
        uncapped: IV07ComposedCellReport;
        server300LowerBoundEmulation: IV07ComposedCellReport;
        offSymmetry: IV07ComposedCellReport;
    };
    releaseInstruction: "NO_AUTOMATIC_BAKE_OR_DEPLOY";
}

function aggregateV07ComposedEvidence(cells: readonly IV07ComposedCellReport[]): IV07ComposedAggregateEvidence {
    if (!cells.length) throw new Error("Cannot aggregate an empty composed-ranked cohort");
    let candidateWins = 0;
    let opponentWins = 0;
    let draws = 0;
    for (const cell of cells) {
        candidateWins += cell.candidateWins;
        opponentWins += cell.opponentWins;
        draws += cell.draws;
    }
    const decisive = candidateWins + opponentWins;
    return {
        cells: cells.map((cell) => cell.cell.id),
        scenarioProtocols: [...new Set(cells.map((cell) => cell.cell.scenarioProtocol))],
        games: candidateWins + opponentWins + draws,
        pairScenarios: cells.reduce((sum, cell) => sum + cell.pairScenarios, 0),
        candidateWins,
        opponentWins,
        draws,
        candidateWinRate: decisive ? candidateWins / decisive : 0,
        policy: "EQUAL_GAME_POOLED_DIAGNOSTIC_NOT_A_FORMAL_GATE",
    };
}

export function v07ComposedCompletionEvidenceRoot(
    manifest: IV07ComposedManifest,
    outputRoot: string,
): IV07ComposedFinalReport["completionEvidence"] {
    const runRoot = resolve(outputRoot, manifest.manifestId);
    const hash = createHash("sha256");
    for (const cell of manifest.cells) {
        const path = `cells/${cell.id}/complete.json`;
        hash.update(path);
        hash.update("\0");
        hash.update(readFileSync(resolveArtifactPath(runRoot, path)));
        hash.update("\0");
    }
    return {
        derivation: "sha256_manifest_ordered_completion_marker_paths_and_bytes",
        markers: manifest.cells.length,
        sha256: hash.digest("hex"),
    };
}

/** Validate the whole direct assembly. It remains non-authoritative until the guard sequencer seals it. */
export function validateV07ComposedFinalReport(
    manifest: IV07ComposedManifest,
    provenance: IV07ComposedManifestProvenance,
    outputRoot: string,
    report: IV07ComposedFinalReport,
    completions: readonly IV07ComposedCellCompletion[],
): void {
    if (
        JSON.stringify(completions.map((completion) => completion.cellId)) !==
        JSON.stringify(manifest.cells.map((cell) => cell.id))
    ) {
        throw new Error("Final report validation requires every completion in manifest order");
    }
    assertV07ComposedUniformExecutionEnvelope(completions);
    const assembledAtMs = Date.parse(report.assembledAt);
    const assembledAtCanonical = Number.isFinite(assembledAtMs) ? new Date(assembledAtMs).toISOString() : "";
    const latestCompletionMs = Math.max(...completions.map((completion) => Date.parse(completion.completedAt)));
    const hostLockAcquiredMs = Date.parse(report.hostLock.acquiredAt);
    const expectedGit = JSON.stringify(completions[0].git);
    if (
        assembledAtCanonical !== report.assembledAt ||
        assembledAtMs < latestCompletionMs ||
        completions.some((completion) => JSON.stringify(completion.git) !== expectedGit) ||
        JSON.stringify(report.git) !== expectedGit ||
        report.hostLock.schemaVersion !== 1 ||
        report.hostLock.protocol !== "v0.7-composed-ranked" ||
        report.hostLock.manifestId !== manifest.manifestId ||
        report.hostLock.manifestSha256 !== provenance.sha256 ||
        report.hostLock.gitCommit !== report.git.commit ||
        report.hostLock.hostname !== completions[0].host.hostname ||
        !Number.isSafeInteger(report.hostLock.pid) ||
        report.hostLock.pid < 1 ||
        report.hostLock.mode !== "assemble" ||
        report.hostLock.cellId !== undefined ||
        report.hostLock.outputRoot !== resolve(outputRoot) ||
        !Number.isFinite(hostLockAcquiredMs) ||
        new Date(hostLockAcquiredMs).toISOString() !== report.hostLock.acquiredAt ||
        hostLockAcquiredMs < latestCompletionMs ||
        hostLockAcquiredMs > assembledAtMs
    ) {
        throw new Error("Final report assembly time, git, or host-lock provenance is not canonical");
    }

    const cells = completions.map((completion) => completion.report);
    const qualificationCells = cells.filter((cell) => cell.cell.qualification);
    const allSeatDecisiveFractionsAtLeast90 = qualificationCells.every(
        (cell) => cell.gate.everySeatDecisiveFractionPassed,
    );
    const allSeatWilsonLowsAtLeast90 = qualificationCells.every((cell) => cell.gate.everySeatWilsonLowPassed);
    const allSeatDrawOrArmageddonAtMost10 = qualificationCells.every(
        (cell) => cell.gate.everySeatDrawOrArmageddonPassed,
    );
    const allLatencyAttritionPassed = qualificationCells.every((cell) => cell.gate.latencyAttritionPassed);
    const allIntegrityGatesPassed = cells.every(
        (cell) =>
            cell.integrity.complete &&
            (cell.cell.scenarioProtocol === "fixed_physical_side_swap"
                ? cell.integrity.fixedPhysicalSideSwapExact === true &&
                  cell.integrity.independentSeatStreamsExact === null &&
                  cell.integrity.seatConditioningExact === null
                : cell.integrity.fixedPhysicalSideSwapExact === null &&
                  cell.integrity.independentSeatStreamsExact === true &&
                  cell.integrity.seatConditioningExact === true) &&
            cell.integrity.auditJoinedExactly &&
            cell.integrity.offControlExact &&
            cell.integrity.zeroEngineRejections &&
            cell.integrity.zeroIllegalIncumbents,
    );
    const byId = new Map(cells.map((cell) => [cell.cell.id, cell]));
    const required = (id: string): IV07ComposedCellReport => {
        const cell = byId.get(id);
        if (!cell) throw new Error(`Final report validation is missing required cell ${id}`);
        return cell;
    };
    const rankedCell = required("round1_search_conservative200_275");
    const taxonomyCells = Object.fromEntries(
        V07_ARCHETYPES.map((archetype) => [archetype, required(V07_COMPOSED_TAXONOMY_CELL_IDS[archetype])]),
    ) as Record<V07Archetype, IV07ComposedCellReport>;
    const templateCells = Object.fromEntries(
        V07_ARCHETYPE_TEMPLATE_NAMES.map((template) => [template, required(`${template}_conservative200_275`)]),
    ) as Record<V07ArchetypeTemplateName, IV07ComposedCellReport>;
    const fixedByArchetype = (archetype: V07Archetype): IV07ComposedCellReport[] =>
        Object.values(templateCells).filter(
            (cell) => cell.cell.template && v07ArchetypeTemplate(cell.cell.template).archetype === archetype,
        );
    const startedAt = completions[0].startedAt;
    const elapsedMs = assembledAtMs - Date.parse(startedAt);
    const expected: IV07ComposedFinalReport = {
        schemaVersion: 1,
        manifestId: manifest.manifestId,
        manifestSha256: provenance.sha256,
        assembledAt: report.assembledAt,
        authority: "UNSEALED_NON_AUTHORITATIVE_UNTIL_GUARD_SEAL",
        git: completions[0].git,
        hostLock: {
            schemaVersion: 1,
            protocol: "v0.7-composed-ranked",
            manifestId: manifest.manifestId,
            manifestSha256: provenance.sha256,
            gitCommit: completions[0].git.commit,
            hostname: completions[0].host.hostname,
            pid: report.hostLock.pid,
            mode: "assemble",
            outputRoot: resolve(outputRoot),
            acquiredAt: report.hostLock.acquiredAt,
        },
        allCellsComplete: true,
        completionEvidence: v07ComposedCompletionEvidenceRoot(manifest, outputRoot),
        cells,
        executionWindow: {
            startedAt,
            assembledAt: report.assembledAt,
            elapsedMs,
            maxRunElapsedMs: manifest.execution.maxRunElapsedMs,
        },
        executionProvenance: Object.fromEntries(
            completions.map((completion) => [
                completion.cellId,
                {
                    startedAt: completion.startedAt,
                    completedAt: completion.completedAt,
                    git: completion.git,
                    host: completion.host,
                    concurrency: completion.concurrency,
                },
            ]),
        ),
        qualification: {
            cells: qualificationCells.length,
            hypotheses: manifest.gates.formalHypotheses,
            method: manifest.gates.formalMethod,
            nominalFamilywiseConfidence: manifest.gates.nominalFamilywiseConfidence,
            rankedCell,
            taxonomyCells,
            templateCells,
            allSeatDecisiveFractionsAtLeast90,
            allSeatWilsonLowsAtLeast90,
            allSeatDrawOrArmageddonAtMost10,
            allLatencyAttritionPassed,
            allIntegrityGatesPassed,
            verdict:
                allSeatDecisiveFractionsAtLeast90 &&
                allSeatWilsonLowsAtLeast90 &&
                allSeatDrawOrArmageddonAtMost10 &&
                allLatencyAttritionPassed &&
                allIntegrityGatesPassed
                    ? "PASS"
                    : "FAIL",
        },
        aggregateCohortEvidence: {
            ranked: aggregateV07ComposedEvidence([rankedCell]),
            mage: aggregateV07ComposedEvidence([taxonomyCells.mage, ...fixedByArchetype("mage")]),
            meleeMage: aggregateV07ComposedEvidence([taxonomyCells.meleeMage, ...fixedByArchetype("meleeMage")]),
            aura: aggregateV07ComposedEvidence([taxonomyCells.aura, ...fixedByArchetype("aura")]),
            ranged: aggregateV07ComposedEvidence([taxonomyCells.ranged, ...fixedByArchetype("ranged")]),
        },
        diagnostics: {
            uncapped: required("round1_search_uncapped"),
            server300LowerBoundEmulation: required("round1_search_server300"),
            offSymmetry: required("round1_search_off_symmetry"),
        },
        releaseInstruction: "NO_AUTOMATIC_BAKE_OR_DEPLOY",
    };
    if (
        !Number.isFinite(elapsedMs) ||
        elapsedMs < 0 ||
        elapsedMs > manifest.execution.maxRunElapsedMs ||
        JSON.stringify(report) !== JSON.stringify(expected)
    ) {
        throw new Error("Final report is not the canonical assembly of the validated completion evidence");
    }
}

export function assembleV07ComposedReport(
    manifest: IV07ComposedManifest,
    provenance: IV07ComposedManifestProvenance,
    outputRoot: string,
): IV07ComposedFinalReport {
    validateV07ComposedManifest(manifest);
    assertV07ComposedExecutionEnvironment(manifest, outputRoot);
    const assemblyGit = gitProvenance(process.cwd(), manifest.sourceProvenance.preregisteredCommonBaseCommit);
    if (!assemblyGit.cleanIncludingUntracked) {
        throw new Error("Composed-ranked assembly requires a clean main checkout including untracked files");
    }
    const hostLock = acquireV07ComposedHostLock({
        manifestId: manifest.manifestId,
        manifestSha256: provenance.sha256,
        gitCommit: assemblyGit.commit,
        mode: "assemble",
        outputRoot,
    });
    try {
        const runRoot = resolve(outputRoot, manifest.manifestId);
        const cellsRoot = join(runRoot, "cells");
        const cellEntries = existsSync(cellsRoot) ? readdirSync(cellsRoot, { withFileTypes: true }) : [];
        if (
            !sameMembers(
                cellEntries.map((entry) => entry.name),
                manifest.cells.map((cell) => cell.id),
            ) ||
            cellEntries.some((entry) => !entry.isDirectory())
        ) {
            throw new Error("Composed-ranked assembly requires exactly the sixteen registered cell directories");
        }
        const completions = manifest.cells.map((cell) =>
            validateV07ComposedCellArtifact(manifest, provenance, outputRoot, cell),
        );
        assertV07ComposedUniformExecutionEnvelope(completions);
        const executionCommits = new Set(completions.map((completion) => completion.git.commit));
        if (executionCommits.size !== 1 || !executionCommits.has(assemblyGit.commit)) {
            throw new Error("All composed-ranked cells and final assembly must use one exact main commit");
        }
        const assembledAt = new Date().toISOString();
        const runStartedAt = completions[0].startedAt;
        const runElapsedMs = assertV07ComposedElapsedWithin(
            runStartedAt,
            assembledAt,
            manifest.execution.maxRunElapsedMs,
            "composed-ranked run and assembly",
        );
        const cells = completions.map((completion) => completion.report);
        const qualificationCells = cells.filter((cell) => cell.cell.qualification);
        const allSeatDecisiveFractionsAtLeast90 = qualificationCells.every(
            (cell) => cell.gate.everySeatDecisiveFractionPassed,
        );
        const allSeatWilsonLowsAtLeast90 = qualificationCells.every((cell) => cell.gate.everySeatWilsonLowPassed);
        const allSeatDrawOrArmageddonAtMost10 = qualificationCells.every(
            (cell) => cell.gate.everySeatDrawOrArmageddonPassed,
        );
        const allLatencyAttritionPassed = qualificationCells.every((cell) => cell.gate.latencyAttritionPassed);
        const allIntegrityGatesPassed = cells.every(
            (cell) =>
                cell.integrity.complete &&
                (cell.cell.scenarioProtocol === "fixed_physical_side_swap"
                    ? cell.integrity.fixedPhysicalSideSwapExact === true &&
                      cell.integrity.independentSeatStreamsExact === null &&
                      cell.integrity.seatConditioningExact === null
                    : cell.integrity.fixedPhysicalSideSwapExact === null &&
                      cell.integrity.independentSeatStreamsExact === true &&
                      cell.integrity.seatConditioningExact === true) &&
                cell.integrity.auditJoinedExactly &&
                cell.integrity.offControlExact &&
                cell.integrity.zeroEngineRejections &&
                cell.integrity.zeroIllegalIncumbents,
        );
        const byId = new Map(cells.map((cell) => [cell.cell.id, cell]));
        const required = (id: string): IV07ComposedCellReport => {
            const cell = byId.get(id);
            if (!cell) throw new Error(`Assembly missing required diagnostic ${id}`);
            return cell;
        };
        const rankedCell = required("round1_search_conservative200_275");
        const taxonomyCells = Object.fromEntries(
            V07_ARCHETYPES.map((archetype) => {
                const cell = required(V07_COMPOSED_TAXONOMY_CELL_IDS[archetype]);
                if (cell.cell.archetype !== archetype || cell.cell.distribution !== "ranked_taxonomy") {
                    throw new Error(`${cell.cell.id}: taxonomy attribution mismatch`);
                }
                return [archetype, cell];
            }),
        ) as Record<V07Archetype, IV07ComposedCellReport>;
        const templateCells = Object.fromEntries(
            V07_ARCHETYPE_TEMPLATE_NAMES.map((template) => {
                const cell = required(`${template}_conservative200_275`);
                if (cell.cell.template !== template) throw new Error(`${cell.cell.id}: template attribution mismatch`);
                return [template, cell];
            }),
        ) as Record<V07ArchetypeTemplateName, IV07ComposedCellReport>;
        const fixedByArchetype = (archetype: V07Archetype) =>
            Object.values(templateCells).filter(
                (cell) => cell.cell.template && v07ArchetypeTemplate(cell.cell.template).archetype === archetype,
            );
        const report: IV07ComposedFinalReport = {
            schemaVersion: 1,
            manifestId: manifest.manifestId,
            manifestSha256: provenance.sha256,
            assembledAt,
            authority: "UNSEALED_NON_AUTHORITATIVE_UNTIL_GUARD_SEAL",
            git: assemblyGit,
            hostLock: hostLock.metadata,
            allCellsComplete: true,
            completionEvidence: v07ComposedCompletionEvidenceRoot(manifest, outputRoot),
            cells,
            executionWindow: {
                startedAt: runStartedAt,
                assembledAt,
                elapsedMs: runElapsedMs,
                maxRunElapsedMs: manifest.execution.maxRunElapsedMs,
            },
            executionProvenance: Object.fromEntries(
                completions.map((completion) => [
                    completion.cellId,
                    {
                        startedAt: completion.startedAt,
                        completedAt: completion.completedAt,
                        git: completion.git,
                        host: completion.host,
                        concurrency: completion.concurrency,
                    },
                ]),
            ),
            qualification: {
                cells: qualificationCells.length,
                hypotheses: manifest.gates.formalHypotheses,
                method: manifest.gates.formalMethod,
                nominalFamilywiseConfidence: manifest.gates.nominalFamilywiseConfidence,
                rankedCell,
                taxonomyCells,
                templateCells,
                allSeatDecisiveFractionsAtLeast90,
                allSeatWilsonLowsAtLeast90,
                allSeatDrawOrArmageddonAtMost10,
                allLatencyAttritionPassed,
                allIntegrityGatesPassed,
                verdict:
                    allSeatDecisiveFractionsAtLeast90 &&
                    allSeatWilsonLowsAtLeast90 &&
                    allSeatDrawOrArmageddonAtMost10 &&
                    allLatencyAttritionPassed &&
                    allIntegrityGatesPassed
                        ? "PASS"
                        : "FAIL",
            },
            aggregateCohortEvidence: {
                ranked: aggregateV07ComposedEvidence([rankedCell]),
                mage: aggregateV07ComposedEvidence([taxonomyCells.mage, ...fixedByArchetype("mage")]),
                meleeMage: aggregateV07ComposedEvidence([taxonomyCells.meleeMage, ...fixedByArchetype("meleeMage")]),
                aura: aggregateV07ComposedEvidence([taxonomyCells.aura, ...fixedByArchetype("aura")]),
                ranged: aggregateV07ComposedEvidence([taxonomyCells.ranged, ...fixedByArchetype("ranged")]),
            },
            diagnostics: {
                uncapped: required("round1_search_uncapped"),
                server300LowerBoundEmulation: required("round1_search_server300"),
                offSymmetry: required("round1_search_off_symmetry"),
            },
            releaseInstruction: "NO_AUTOMATIC_BAKE_OR_DEPLOY",
        };
        validateV07ComposedFinalReport(manifest, provenance, outputRoot, report, completions);
        atomicWrite(join(runRoot, "final-report.json"), `${JSON.stringify(report, null, 2)}\n`);
        return report;
    } finally {
        hostLock.release();
    }
}

interface ICliOptions {
    manifestPath: string;
    outputRoot: string;
    cell?: string;
    assemble: boolean;
    concurrency: number;
}

function parseCli(argv: string[], cwd = process.cwd()): ICliOptions {
    const parsed = parseArgs({
        args: argv,
        allowPositionals: false,
        strict: true,
        options: {
            manifest: {
                type: "string",
                default: join(cwd, "src/simulation/manifests/v0_7_composed_ranked_ladder_20260716.json"),
            },
            output: { type: "string", default: join(dirname(cwd), "hoc-v07-composed-ranked-output") },
            cell: { type: "string" },
            assemble: { type: "boolean", default: false },
            concurrency: {
                type: "string",
                default: "12",
            },
        },
    });
    const concurrency = Number(parsed.values.concurrency);
    if (concurrency !== 12) {
        throw new Error("--concurrency must equal the frozen value 12");
    }
    const assemble = parsed.values.assemble ?? false;
    const cell = parsed.values.cell;
    if (assemble === Boolean(cell)) {
        throw new Error("Specify exactly one of --cell <id> or --assemble");
    }
    return {
        manifestPath: resolve(parsed.values.manifest!),
        outputRoot: resolve(parsed.values.output!),
        ...(cell ? { cell } : {}),
        assemble,
        concurrency,
    };
}

async function main(): Promise<void> {
    const options = parseCli(process.argv.slice(2));
    const loaded = readV07ComposedManifest(options.manifestPath);
    if (options.assemble) {
        const report = assembleV07ComposedReport(loaded.manifest, loaded.provenance, options.outputRoot);
        console.log(
            `${report.manifestId}: UNSEALED ${report.qualification.verdict} ` +
                `(${report.qualification.cells} qualification cells, no automatic bake)`,
        );
        return;
    }
    const completion = await runV07ComposedCell(
        loaded.manifest,
        loaded.provenance,
        options.cell!,
        options.outputRoot,
        options.concurrency,
    );
    console.log(
        `${completion.cellId}: ${(completion.report.candidateWinRate * 100).toFixed(3)}% ` +
            `(paired 95% CI ${completion.report.confidence95 ? `${(completion.report.confidence95.low * 100).toFixed(3)}-${(completion.report.confidence95.high * 100).toFixed(3)}%` : "n/a"})`,
    );
}

if (import.meta.main) {
    await main();
}
