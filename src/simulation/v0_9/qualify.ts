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

import { createHash, randomUUID } from "node:crypto";
import {
    chmodSync,
    closeSync,
    existsSync,
    fsyncSync,
    linkSync,
    mkdirSync,
    openSync,
    readFileSync,
    truncateSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { availableParallelism, cpus, hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

import { enumerateCandidates } from "../../ai/candidates";
import type { IAIPolicyEvent } from "../../ai/ai_strategy";
import { isV08StrongerRangedPostureWait } from "../../ai/versions/v0_8";
import {
    V08_A13_GENOME_SHA256,
    V08_A13_SOURCE_BINDING_SHA256,
    buildV08A13SearchEnvironment,
} from "../../ai/versions/v0_8_a13_profile";
import { createV09OfflineResearchStrategy } from "../../ai/versions/v0_9";
import { v09CandidateIsProductive } from "../../ai/versions/v0_9_features";
import { scoreV09FixedPoint, type IV09ModelArtifact } from "../../ai/versions/v0_9_model";
import { PBTypes } from "../../generated/protobuf/v1/types";
import { DEFAULT_AMOUNT_BY_LEVEL, creaturesByLevel, makeRng, resolveStackAmount, type IArmyUnitSpec } from "../army";
import { AI_META_COHORTS, prepareMetaPair, type AiMetaCohort, type IAiMetaArmy } from "../ai_meta_cohorts_core";
import { buildArchetypeRoster, buildSharedArchetypeOffers, type ArchetypeName } from "../archetype_payoff";
import { runMatch, type IDecisionObservation, type IMatchConfig, type IMatchResult, type Side } from "../battle_engine";
import {
    V09_CAMPAIGN_SCHEMA,
    V09_DEFAULT_SEED_COUNTS,
    V09_SEED_LEDGER_SCHEMA,
    validateV09SeedLedger,
    v09CampaignRunFingerprint,
    type IV09CampaignManifest,
    type IV09SeedLedger,
} from "./campaign";
import { verifyV09ResearchArtifact } from "./parity";
import { fingerprintV09, V09_FEATURE_FINGERPRINTS, type V09Map } from "./protocol";
import { computeV09SourceIdentity, type IV09SourceIdentityReceipt } from "./source_identity";
import { validateV09QualificationMetrics, v09QualificationFailures, type IV09QualificationMetrics } from "./supervisor";

export const V09_QUALIFICATION_SCHEMA = "hoc.ai.v0_9_qualification.v2" as const;
export const V09_QUALIFICATION_JOURNAL_SCHEMA = "hoc.ai.v0_9_qualification_journal.v2" as const;
export const V09_QUALIFICATION_PAIR_SCHEMA = "hoc.ai.v0_9_qualification_pair.v2" as const;
export const V09_QUALIFICATION_SHARD_RECEIPT_SCHEMA = "hoc.ai.v0_9_qualification_shard_receipt.v2" as const;
export const V09_QUALIFICATION_PURPOSES = ["confirmation", "qualification"] as const;
export const V09_QUALIFICATION_NODE_ROLES = ["development_smoke", "training_host", "production_cpu"] as const;

export type V09QualificationPurpose = (typeof V09_QUALIFICATION_PURPOSES)[number];
export type V09QualificationNodeRole = (typeof V09_QUALIFICATION_NODE_ROLES)[number];
const V09_FIXED_QUALIFICATION_COHORTS = [
    "mirror-anchor",
    "mirror-melee",
    "pure-ranged",
    "mixed-cyclops-tsar",
    "new-level4",
] as const;
export type V09TeacherCohort = AiMetaCohort | (typeof V09_FIXED_QUALIFICATION_COHORTS)[number];

export const V09_QUALIFICATION_MAPS: ReadonlyArray<{ readonly name: V09Map; readonly value: number }> = Object.freeze([
    Object.freeze({ name: "normal", value: PBTypes.GridVals.NORMAL }),
    Object.freeze({ name: "water", value: PBTypes.GridVals.WATER_CENTER }),
    Object.freeze({ name: "lava", value: PBTypes.GridVals.LAVA_CENTER }),
    Object.freeze({ name: "block", value: PBTypes.GridVals.BLOCK_CENTER }),
]);

/** Exact teacher cohort order, duplicated here to keep qualification workers free of executable actor imports. */
export const V09_QUALIFICATION_COHORTS: readonly V09TeacherCohort[] = Object.freeze([
    ...AI_META_COHORTS,
    ...V09_FIXED_QUALIFICATION_COHORTS,
]);

export interface IV09QualificationPlanPair {
    readonly id: string;
    readonly purpose: V09QualificationPurpose;
    readonly pairIndex: number;
    /** First exact ledger seed: deterministic roster/setup material. */
    readonly scenarioSeed: number;
    /** Second exact ledger seed: deterministic combat RNG for both mirrored games. */
    readonly combatSeed: number;
    readonly cohort: V09TeacherCohort;
    readonly map: V09Map;
    readonly mapValue: number;
}

export interface IV09QualificationGameOutcome {
    readonly v09Seat: Side;
    readonly winner: "v0.9" | "v0.8" | "draw";
    readonly scoreV09: 0 | 0.5 | 1;
    readonly laps: number;
    readonly endReason: IMatchResult["endReason"];
    /** True as soon as the battle enters an Armageddon lap, even when the wave itself kills nothing. */
    readonly reachedArmageddon: boolean;
    /** Diagnostic subset: Armageddon was reached and its damage killed at least one unit. */
    readonly armageddonDecided: boolean;
    readonly rejectedV09: number;
    readonly rejectedV08: number;
}

export interface IV09QualificationControlOutcome {
    readonly winnerSide: Side | "draw";
    readonly laps: number;
    readonly endReason: IMatchResult["endReason"];
    /** True as soon as the battle enters an Armageddon lap, even when the wave itself kills nothing. */
    readonly reachedArmageddon: boolean;
    /** Diagnostic subset: Armageddon was reached and its damage killed at least one unit. */
    readonly armageddonDecided: boolean;
    readonly rejectedGreen: number;
    readonly rejectedRed: number;
}

export interface IV09QualificationPairRecord {
    readonly schema: typeof V09_QUALIFICATION_PAIR_SCHEMA;
    readonly runFingerprint: string;
    readonly manifestSha256: string;
    readonly modelSha256: string;
    readonly id: string;
    readonly purpose: V09QualificationPurpose;
    readonly pairIndex: number;
    readonly scenarioSeed: number;
    readonly combatSeed: number;
    readonly cohort: V09TeacherCohort;
    readonly map: V09Map;
    readonly games: readonly [IV09QualificationGameOutcome, IV09QualificationGameOutcome];
    /** Same scenario/seed under v0.8+a13 on both seats; the actual Armageddon baseline control. */
    readonly v08ControlGame: IV09QualificationControlOutcome;
    readonly v09PolicyDecisions: number;
    readonly v09PolicyEvents: number;
    /** Exact decision + common-engine preflight/rollback timing records for the deployed v0.9 path. */
    readonly v09ServerPreflightTimings: number;
    /** Missing or duplicate v0.9 events after exact team/unit/lap correlation, never an aggregate delta. */
    readonly telemetryMismatches: number;
    readonly invalidModelTelemetryEvents: number;
    readonly runtimeFallbacks: number;
    readonly instrumentationFailures: number;
    readonly avoidablePassiveActions: number;
    /** Exact integer-microsecond histogram, sorted ascending. */
    readonly turnLatencyMicros: ReadonlyArray<readonly [number, number]>;
    readonly recordSha256: string;
}

export interface IV09QualificationCellSummary {
    readonly key: string;
    readonly purpose: V09QualificationPurpose;
    readonly cohort: V09TeacherCohort;
    readonly map: V09Map;
    readonly games: number;
    readonly v09Wins: number;
    readonly v08Wins: number;
    readonly draws: number;
    readonly score: number;
}

export interface IV09QualificationStageSummary {
    readonly purpose: V09QualificationPurpose;
    readonly games: number;
    readonly v09Wins: number;
    readonly v08Wins: number;
    readonly draws: number;
    readonly score: number;
}

export interface IV09QualificationJournalHeader {
    readonly schema: typeof V09_QUALIFICATION_JOURNAL_SCHEMA;
    readonly runFingerprint: string;
    readonly manifestSha256: string;
    readonly seedLedgerSha256: string;
    readonly modelSha256: string;
    readonly artifactFileSha256: string;
    readonly planSha256: string;
    readonly shardPlanSha256: string;
    readonly shardCount: number;
    readonly shardIndex: number;
    readonly expectedPairs: number;
    readonly expectedGames: number;
    readonly expectedV08ControlGames: number;
    readonly expectedTotalSimulations: number;
    readonly expectedShardPairs: number;
    readonly expectedShardSimulations: number;
    readonly runnerSourceSha256: string;
    readonly behaviorEnvironmentSha256: string;
    readonly executionFingerprint: string;
    readonly nodeRole: V09QualificationNodeRole;
    readonly sourceIdentityReceiptSha256: string;
    readonly modelP99Ms: number;
    readonly rssIncreaseMiB: number;
    readonly headerSha256: string;
}

export interface IV09QualificationShardReceipt {
    readonly schema: typeof V09_QUALIFICATION_SHARD_RECEIPT_SCHEMA;
    readonly promoted: false;
    readonly status: "complete_nonpromoting_shard";
    readonly runFingerprint: string;
    readonly manifestSha256: string;
    readonly seedLedgerSha256: string;
    readonly modelSha256: string;
    readonly researchArtifactSha256: string;
    readonly planSha256: string;
    readonly shardPlanSha256: string;
    readonly shardCount: number;
    readonly shardIndex: number;
    readonly expectedPairs: number;
    readonly completedPairs: number;
    readonly expectedSimulations: number;
    readonly completedSimulations: number;
    readonly journalSha256: string;
    readonly journalHeaderSha256: string;
    readonly runnerSourceSha256: string;
    readonly sourceIdentityReceiptSha256: string;
    readonly behaviorEnvironmentSha256: string;
    readonly executionFingerprint: string;
    readonly nodeRole: V09QualificationNodeRole;
    readonly modelP99Ms: number;
    readonly turnP99Ms: number;
    readonly rssIncreaseMiB: number;
    readonly completedAt: string;
    readonly receiptSha256: string;
}

export interface IV09QualificationSummary {
    readonly schema: typeof V09_QUALIFICATION_SCHEMA;
    readonly status: "qualified_offline" | "failed";
    /** Qualification never mutates or installs a production artifact. */
    readonly promoted: false;
    readonly runFingerprint: string;
    readonly manifestSha256: string;
    readonly seedLedgerSha256: string;
    readonly modelId: string;
    readonly modelSha256: string;
    readonly artifactFileSha256: string;
    /** SHA-256 of the exact unpromoted research artifact bytes selected by the operator. */
    readonly researchArtifactSha256: string;
    readonly trainingRunId: string;
    readonly commonCommit: string;
    readonly rulesSha256: string;
    readonly rosterSha256: string;
    readonly combinedGames: number;
    readonly confirmationGames: number;
    readonly qualificationGames: number;
    readonly source: IV09ModelArtifact["source"];
    readonly baseline: {
        readonly version: "v0.8";
        readonly profile: "a13";
        readonly searchOnly: true;
        readonly genomeSha256: string;
        readonly sourceBindingSha256: string;
        readonly behaviorEnvironmentSha256: string;
    };
    readonly policy: {
        readonly version: "v0.9";
        readonly pureCpu: true;
        readonly searchApplied: false;
        readonly offlineResearchActivationOnly: true;
    };
    readonly plan: {
        readonly purposes: readonly V09QualificationPurpose[];
        readonly cohorts: readonly V09TeacherCohort[];
        readonly maps: readonly V09Map[];
        readonly cellsPerPurpose: number;
        readonly seedPairing: "adjacent_scenario_then_combat";
        readonly expectedPairs: number;
        readonly expectedGames: number;
        readonly expectedV08ControlGames: number;
        readonly expectedTotalSimulations: number;
        readonly planSha256: string;
    };
    /** Direct input contract for supervisor.v09QualificationFailures. */
    readonly metrics: IV09QualificationMetrics;
    readonly baselineMetrics: {
        readonly invalidActions: number;
    };
    readonly failures: readonly string[];
    readonly stages: readonly IV09QualificationStageSummary[];
    readonly cells: readonly IV09QualificationCellSummary[];
    readonly totals: {
        readonly v09Wins: number;
        readonly v08Wins: number;
        readonly draws: number;
        /** All head-to-head games that reached Armageddon; this is the numerator gated by armageddonRate. */
        readonly armageddonGames: number;
        readonly armageddonWhenV09Green: number;
        readonly armageddonWhenV09Red: number;
        /** Diagnostic subset of armageddonGames in which Armageddon damage killed a unit. */
        readonly armageddonDecidedGames: number;
        readonly armageddonV09Wins: number;
        readonly armageddonV08Wins: number;
        readonly v08ControlGames: number;
        /** All v0.8 control games that reached Armageddon; numerator for v08ArmageddonRate. */
        readonly v08ControlArmageddonGames: number;
        /** Diagnostic subset of v08ControlArmageddonGames in which Armageddon damage killed a unit. */
        readonly v08ControlArmageddonDecidedGames: number;
        readonly rejectedV08Control: number;
        readonly rejectedV09: number;
        readonly rejectedV08: number;
        readonly runtimeFallbacks: number;
        readonly telemetryMismatches: number;
        readonly invalidModelTelemetryEvents: number;
        readonly instrumentationFailures: number;
        readonly avoidablePassiveActions: number;
        readonly v09PolicyDecisions: number;
        readonly v09PolicyEvents: number;
        readonly v09ServerPreflightTimings: number;
        readonly latencySamples: number;
    };
    readonly execution: {
        /** Performance values are valid only for this machine/process fingerprint. */
        readonly measurementScope: "node_local";
        readonly runnerSourceSha256: string;
        readonly sourceIdentityReceiptSha256: string;
        readonly p99ModelMs: number;
        readonly p99TurnMs: number;
        readonly rssIncreaseMiB: number;
        readonly nodes: readonly {
            readonly shardCount: number;
            readonly shardIndex: number;
            readonly nodeRole: V09QualificationNodeRole;
            readonly executionFingerprint: string;
            readonly modelP99Ms: number;
            readonly turnP99Ms: number;
            readonly rssIncreaseMiB: number;
            readonly journalSha256: string;
            readonly shardReceiptSha256: string;
        }[];
        readonly productionCpuQualification: {
            readonly required: true;
            readonly satisfied: boolean;
            readonly p99TurnMs: number | null;
            readonly thresholdExclusiveMs: 20;
            readonly command: string;
        };
    };
    /** Canonical, self-hashed inputs a separate promotion tool may embed; this runner never promotes. */
    readonly promotionReceiptInputs: {
        readonly schema: "hoc.ai.v0_9_qualification_receipt_inputs.v2";
        readonly qualificationSummarySchema: typeof V09_QUALIFICATION_SCHEMA;
        readonly armageddonMetric: "reached_armageddon_lap";
        readonly eligible: boolean;
        readonly qualificationStatus: "qualified_offline" | "failed";
        readonly modelId: string;
        readonly modelSha256: string;
        readonly researchArtifactSha256: string;
        readonly trainingRunId: string;
        readonly commonCommit: string;
        readonly rulesSha256: string;
        readonly rosterSha256: string;
        readonly runFingerprint: string;
        readonly sourceCommit: string;
        readonly sourceStatusSha256: string;
        readonly rulesFingerprint: string;
        readonly rosterFingerprint: string;
        readonly anchorFingerprint: string;
        readonly manifestSha256: string;
        readonly seedLedgerSha256: string;
        readonly journalSha256: string;
        readonly planSha256: string;
        readonly runnerSourceSha256: string;
        readonly sourceIdentityReceiptSha256: string;
        readonly confirmationGames: number;
        readonly qualificationGames: number;
        readonly combinedGames: number;
        readonly v08ControlGames: number;
        readonly expectedTotalSimulations: number;
        readonly completedTotalSimulations: number;
        readonly nodeRoles: readonly V09QualificationNodeRole[];
        readonly metricsSha256: string;
        readonly baselineMetricsSha256: string;
        readonly productionCpuP99TurnMs: number | null;
        readonly failures: readonly string[];
        readonly failuresSha256: string;
        readonly qualifiedAt: string | null;
        readonly receiptInputsSha256: string;
    };
    readonly journalSha256: string;
    readonly failuresSha256: string;
    readonly qualifiedAt: string | null;
    readonly completedAt: string;
    readonly summarySha256: string;
}

interface IWorkerData {
    readonly kind: "v0.9-qualification-worker";
    readonly artifact: IV09ModelArtifact;
    readonly runFingerprint: string;
    readonly manifestSha256: string;
}

type WorkerRequest = { readonly type: "pair"; readonly pair: IV09QualificationPlanPair } | { readonly type: "stop" };
type WorkerResponse =
    | { readonly type: "ready" }
    | { readonly type: "result"; readonly record: IV09QualificationPairRecord }
    | { readonly type: "error"; readonly pairId: string | null; readonly error: string };

interface IGameDiagnostics {
    v09PolicyDecisions: number;
    v09PolicyEvents: number;
    v09ServerPreflightTimings: number;
    telemetryMismatches: number;
    pendingTelemetryByDecision: Map<string, number>;
    pendingPreflightByDecision: Map<string, number>;
    invalidModelTelemetryEvents: number;
    runtimeFallbacks: number;
    instrumentationFailures: number;
    avoidablePassiveActions: number;
    turnLatencyMicros: Map<number, number>;
}

interface IQualificationAggregate {
    metrics: IV09QualificationMetrics;
    baselineMetrics: IV09QualificationSummary["baselineMetrics"];
    stages: IV09QualificationStageSummary[];
    cells: IV09QualificationCellSummary[];
    totals: IV09QualificationSummary["totals"];
}

const SHA256 = /^[0-9a-f]{64}$/;
const QUALIFICATION_PREFIXES = [
    "AUGCA_",
    "CEM_",
    "FIGHT_",
    "LIVETWIN",
    "Q2_",
    "SEARCH_",
    "SIM_",
    "V05_",
    "V06_",
    "V07_",
    "V08_",
] as const;

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

const requireSha = (value: unknown, context: string): string => {
    if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${context} must be a lowercase SHA-256`);
    return value;
};

const finite = (value: number, context: string): number => {
    if (!Number.isFinite(value)) throw new Error(`${context} must be finite`);
    return value;
};

const integer = (value: number, context: string, minimum = 0): number => {
    if (!Number.isSafeInteger(value) || value < minimum) {
        throw new Error(`${context} must be an integer >= ${minimum}`);
    }
    return value;
};

const requireIsoInstant = (value: unknown, context: string): string => {
    if (typeof value !== "string" || !value.length || Number.isNaN(Date.parse(value))) {
        throw new Error(`${context} must be an ISO timestamp`);
    }
    if (new Date(value).toISOString() !== value) throw new Error(`${context} must be a canonical ISO timestamp`);
    return value;
};

const roundMetric = (value: number): number => Number(value.toFixed(9));

const unsignedPairRecord = (
    record: Omit<IV09QualificationPairRecord, "recordSha256"> | IV09QualificationPairRecord,
): Omit<IV09QualificationPairRecord, "recordSha256"> => {
    const { recordSha256, ...unsigned } = record as IV09QualificationPairRecord;
    void recordSha256;
    return unsigned;
};

const hashPairRecord = (
    record: Omit<IV09QualificationPairRecord, "recordSha256"> | IV09QualificationPairRecord,
): string => fingerprintV09(unsignedPairRecord(record));

const histogramEntries = (histogram: ReadonlyMap<number, number>): Array<readonly [number, number]> =>
    [...histogram.entries()].sort(([left], [right]) => left - right).map(([micros, count]) => [micros, count] as const);

const bumpHistogram = (histogram: Map<number, number>, value: number, count = 1): void => {
    const key = Math.max(0, Math.round(value));
    histogram.set(key, (histogram.get(key) ?? 0) + count);
};

const mergeHistogram = (
    target: Map<number, number>,
    source: ReadonlyArray<readonly [number, number]>,
    context: string,
): void => {
    for (const [value, count] of source) {
        integer(value, `${context}.value`);
        integer(count, `${context}.count`, 1);
        bumpHistogram(target, value, count);
    }
};

export function histogramQuantile(
    histogram: ReadonlyMap<number, number>,
    quantile: number,
    context = "histogram",
): number {
    if (!Number.isFinite(quantile) || quantile <= 0 || quantile > 1) {
        throw new Error(`${context} quantile must be in (0,1]`);
    }
    const sorted = [...histogram.entries()].sort(([left], [right]) => left - right);
    const total = sorted.reduce((sum, [, count]) => sum + integer(count, `${context}.count`, 1), 0);
    if (!total) throw new Error(`${context} has no samples`);
    const rank = Math.ceil(total * quantile);
    let cumulative = 0;
    for (const [value, count] of sorted) {
        finite(value, `${context}.value`);
        cumulative += count;
        if (cumulative >= rank) return value;
    }
    throw new Error(`${context} quantile accounting failed`);
}

/** Wilson lower confidence bound, treating a draw as half a successful game. */
export function v09WilsonLower95(wins: number, draws: number, games: number): number {
    integer(wins, "wins");
    integer(draws, "draws");
    integer(games, "games", 1);
    if (wins + draws > games) throw new Error("wins + draws cannot exceed games");
    const z = 1.959963984540054;
    const successes = wins + 0.5 * draws;
    const proportion = successes / games;
    const z2 = z * z;
    const denominator = 1 + z2 / games;
    const center = proportion + z2 / (2 * games);
    const radius = z * Math.sqrt((proportion * (1 - proportion) + z2 / (4 * games)) / games);
    return (center - radius) / denominator;
}

export const v09QualificationCellKey = (
    purpose: V09QualificationPurpose,
    cohort: V09TeacherCohort,
    map: V09Map,
): string => `${purpose}:${cohort}:${map}`;

/**
 * Two adjacent exact ledger values form one mirrored pair. The first controls scenario construction, the
 * second controls combat RNG, and both games reuse both values while swapping only the two policies' seats.
 */
export function buildV09QualificationPlan(ledger: IV09SeedLedger): IV09QualificationPlanPair[] {
    validateV09SeedLedger(ledger);
    const plan: IV09QualificationPlanPair[] = [];
    const cellsPerPurpose = V09_QUALIFICATION_COHORTS.length * V09_QUALIFICATION_MAPS.length;
    for (const purpose of V09_QUALIFICATION_PURPOSES) {
        const matches = ledger.streams.filter((stream) => stream.purpose === purpose);
        if (matches.length !== 1) throw new Error(`seed ledger must contain exactly one ${purpose} stream`);
        const stream = matches[0]!;
        if (stream.seeds.length % 2 !== 0) throw new Error(`${purpose} seed stream must contain an even count`);
        for (let pairIndex = 0; pairIndex < stream.seeds.length / 2; pairIndex += 1) {
            const cellIndex = pairIndex % cellsPerPurpose;
            const cohort = V09_QUALIFICATION_COHORTS[cellIndex % V09_QUALIFICATION_COHORTS.length]!;
            const map =
                V09_QUALIFICATION_MAPS[
                    Math.floor(cellIndex / V09_QUALIFICATION_COHORTS.length) % V09_QUALIFICATION_MAPS.length
                ]!;
            const scenarioSeed = stream.seeds[pairIndex * 2]!;
            const combatSeed = stream.seeds[pairIndex * 2 + 1]!;
            plan.push({
                id: `${purpose}:${String(pairIndex).padStart(5, "0")}:${scenarioSeed}:${combatSeed}`,
                purpose,
                pairIndex,
                scenarioSeed,
                combatSeed,
                cohort,
                map: map.name,
                mapValue: map.value,
            });
        }
    }
    return plan;
}

export function partitionV09QualificationPlan(
    plan: readonly IV09QualificationPlanPair[],
    shardIndex: number,
    shardCount: number,
): IV09QualificationPlanPair[] {
    integer(shardCount, "shardCount", 1);
    integer(shardIndex, "shardIndex");
    if (shardCount > 256 || shardIndex >= shardCount) {
        throw new Error("qualification shardIndex must be within shardCount 1..256");
    }
    return plan.filter((_pair, ordinal) => ordinal % shardCount === shardIndex);
}

function validateCampaignManifest(manifest: IV09CampaignManifest, campaignDirectory: string): void {
    const { manifestSha256, ...unsigned } = manifest;
    if (
        manifest.schema !== V09_CAMPAIGN_SCHEMA ||
        manifest.promoted !== false ||
        fingerprintV09(unsigned) !== requireSha(manifestSha256, "manifest.manifestSha256")
    ) {
        throw new Error("v0.9 qualification campaign manifest identity mismatch");
    }
    if (v09CampaignRunFingerprint(manifest.identity) !== manifest.runFingerprint) {
        throw new Error("v0.9 qualification campaign run fingerprint mismatch");
    }
    if (manifest.identity.sourceDirty !== false || manifest.identity.anchorVersion !== "v0.8") {
        throw new Error("v0.9 qualification requires a clean v0.8-anchored campaign");
    }
    if (
        resolve(manifest.outputDirectory) !== manifest.outputDirectory ||
        resolve(campaignDirectory) !== campaignDirectory
    ) {
        throw new Error("v0.9 qualification campaign paths must be absolute");
    }
    if (
        manifest.schemas.il !== "hoc.ai.v0_9_il.v4" ||
        manifest.schemas.features !== "hoc.ai.v0_9_features.il_v4.v1" ||
        manifest.schemas.model !== "hoc.ai.v0_9_model.v1" ||
        fingerprintV09(manifest.featureFingerprints) !== fingerprintV09(V09_FEATURE_FINGERPRINTS)
    ) {
        throw new Error("v0.9 qualification campaign schemas do not match this runtime");
    }
}

export function validateV09QualificationCheckout(
    manifest: IV09CampaignManifest,
    checkout: IV09SourceIdentityReceipt,
): void {
    const expected = manifest.identity;
    if (
        checkout.sourceDirty !== false ||
        checkout.sourceCommit !== expected.sourceCommit ||
        checkout.sourceStatusSha256 !== expected.sourceStatusSha256 ||
        checkout.rulesFingerprint !== expected.rulesFingerprint ||
        checkout.rosterFingerprint !== expected.rosterFingerprint ||
        checkout.anchorVersion !== expected.anchorVersion ||
        checkout.anchorFingerprint !== expected.anchorFingerprint
    ) {
        throw new Error("v0.9 qualification current clean checkout does not match the campaign source identity");
    }
}

function verifyCurrentQualificationCheckout(
    manifest: IV09CampaignManifest,
    repositoryRoot: string,
): IV09SourceIdentityReceipt {
    const checkout = computeV09SourceIdentity(repositoryRoot);
    validateV09QualificationCheckout(manifest, checkout);
    return checkout;
}

export function verifyV09QualificationInputs(
    manifest: IV09CampaignManifest,
    ledger: IV09SeedLedger,
    artifact: IV09ModelArtifact,
    expectedModelSha256: string,
    campaignDirectory = manifest.outputDirectory,
    requireFullStreams = false,
): void {
    validateCampaignManifest(manifest, campaignDirectory);
    validateV09SeedLedger(ledger);
    if (
        ledger.schema !== V09_SEED_LEDGER_SCHEMA ||
        ledger.runFingerprint !== manifest.runFingerprint ||
        ledger.ledgerSha256 !== manifest.seedLedgerSha256
    ) {
        throw new Error("v0.9 qualification manifest and seed ledger disagree");
    }
    verifyV09ResearchArtifact(artifact);
    const expected = requireSha(expectedModelSha256, "expectedModelSha256");
    if (artifact.modelSha256 !== expected || artifact.modelId !== `v0.9-research-${expected.slice(0, 12)}`) {
        throw new Error("v0.9 qualification selected-model identity mismatch");
    }
    if (
        artifact.source.commonCommit !== manifest.identity.sourceCommit ||
        artifact.source.rulesSha256 !== manifest.identity.rulesFingerprint ||
        artifact.source.rosterSha256 !== manifest.identity.rosterFingerprint ||
        artifact.source.trainingRunId !== manifest.runFingerprint
    ) {
        throw new Error("v0.9 qualification artifact provenance does not match the campaign");
    }
    if (requireFullStreams) {
        for (const purpose of V09_QUALIFICATION_PURPOSES) {
            const streams = ledger.streams.filter((stream) => stream.purpose === purpose);
            if (streams.length !== 1 || streams[0]!.count !== V09_DEFAULT_SEED_COUNTS[purpose]) {
                throw new Error(`${purpose} must contain exactly ${V09_DEFAULT_SEED_COUNTS[purpose]} seeds`);
            }
        }
    }
}

function newLevel4Roster(): IArmyUnitSpec[] {
    const names = ["Champion", "Arachna Queen", "Abomination", "Frenzied Boar"];
    const support = [
        { level: 2, name: "Pikeman" },
        { level: 2, name: "Elf" },
    ];
    return [...names.map((name) => ({ level: 4, name })), ...support].map(({ level, name }) => {
        const entry = creaturesByLevel(level).find((candidate) => candidate.creatureName === name);
        if (!entry) throw new Error(`v0.9 qualification cannot find ${name} at level ${level}`);
        return {
            faction: entry.faction,
            creatureName: entry.creatureName,
            level: entry.level,
            size: entry.size,
            amount: resolveStackAmount(entry.creatureName, entry.level, DEFAULT_AMOUNT_BY_LEVEL, "expBudget"),
        };
    });
}

type QualificationMirrorCohort = ArchetypeName | "pure_ranged" | "mixed_cyclops_tsar";

const PURE_RANGED_ROSTER_NAMES = [
    { level: 1, creatureName: "Arbalester" },
    { level: 1, creatureName: "Orc" },
    { level: 2, creatureName: "Elf" },
    { level: 2, creatureName: "Medusa" },
    { level: 3, creatureName: "Cyclops" },
    { level: 4, creatureName: "Tsar Cannon" },
] as const;

const MIXED_CYCLOPS_TSAR_ROSTER_NAMES = [
    { level: 1, creatureName: "Squire" },
    { level: 1, creatureName: "Arbalester" },
    { level: 2, creatureName: "Pikeman" },
    { level: 2, creatureName: "Elf" },
    { level: 3, creatureName: "Cyclops" },
    { level: 4, creatureName: "Tsar Cannon" },
] as const;

/**
 * Side-effect-free copy of the roster construction contract used by measure_mirror_cohorts. Importing that
 * executable module from a qualification Worker would install its unrelated workerData message handler.
 */
function buildQualificationMirrorRoster(cohort: QualificationMirrorCohort, seed: number): IArmyUnitSpec[] {
    let base: IArmyUnitSpec[];
    if (cohort === "pure_ranged" || cohort === "mixed_cyclops_tsar") {
        const names = cohort === "pure_ranged" ? PURE_RANGED_ROSTER_NAMES : MIXED_CYCLOPS_TSAR_ROSTER_NAMES;
        base = names.map(({ level, creatureName }) => {
            const spec = creaturesByLevel(level).find((candidate) => candidate.creatureName === creatureName);
            if (!spec) throw new Error(`v0.9 qualification catalog is missing ${creatureName} at level ${level}`);
            return {
                faction: spec.faction,
                creatureName: spec.creatureName,
                level: spec.level,
                size: spec.size,
                amount: 0,
            };
        });
    } else {
        base = buildArchetypeRoster(cohort, buildSharedArchetypeOffers(makeRng(seed))).roster;
    }
    return base.map((unit) => ({
        ...unit,
        amount: resolveStackAmount(unit.creatureName, unit.level, DEFAULT_AMOUNT_BY_LEVEL, "expBudget"),
    }));
}

const fixedMirrorName = (cohort: V09TeacherCohort): QualificationMirrorCohort => {
    switch (cohort) {
        case "mirror-anchor":
            return "anchor";
        case "mirror-melee":
            return "melee_coevo";
        case "pure-ranged":
            return "pure_ranged";
        case "mixed-cyclops-tsar":
            return "mixed_cyclops_tsar";
        default:
            throw new Error(`${cohort} is not a fixed v0.9 qualification cohort`);
    }
};

function setupForArmies(
    green: IAiMetaArmy,
    red: IAiMetaArmy,
): Pick<
    IMatchConfig,
    | "greenDoctrine"
    | "redDoctrine"
    | "greenAugments"
    | "redAugments"
    | "greenArtifactT1"
    | "redArtifactT1"
    | "greenArtifactT2"
    | "redArtifactT2"
    | "greenSynergies"
    | "redSynergies"
    | "placementAugmentTiming"
> {
    return {
        greenDoctrine: green.doctrine,
        redDoctrine: red.doctrine,
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

function qualificationMatchBase(
    pair: IV09QualificationPlanPair,
): Pick<IMatchConfig, "roster" | "redRoster" | "gridType"> & Partial<IMatchConfig> {
    if ((AI_META_COHORTS as readonly string[]).includes(pair.cohort)) {
        const prepared = prepareMetaPair(
            { cohort: pair.cohort as AiMetaCohort, games: 2, baseSeed: pair.scenarioSeed },
            0,
        );
        return {
            roster: prepared.armyA.roster,
            redRoster: prepared.armyB.roster,
            gridType: pair.mapValue,
            ...setupForArmies(prepared.armyA, prepared.armyB),
        };
    }
    const roster =
        pair.cohort === "new-level4"
            ? newLevel4Roster()
            : buildQualificationMirrorRoster(fixedMirrorName(pair.cohort), pair.scenarioSeed);
    return {
        roster,
        redRoster: roster.map((unit) => ({ ...unit })),
        gridType: pair.mapValue,
    };
}

const productiveActions = (actions: IDecisionObservation["incumbent"]): boolean =>
    actions.some(
        (action) =>
            action.type === "move_unit" ||
            action.type === "melee_attack" ||
            action.type === "range_attack" ||
            action.type === "area_throw_attack" ||
            action.type === "cast_spell",
    ) && !actions.some((action) => action.type === "obstacle_attack");

function observeAvoidablePassive(observation: IDecisionObservation): boolean {
    if (observation.strategyVersion !== "v0.9" || productiveActions(observation.incumbent)) return false;
    const hasWait = observation.incumbent.some((action) => action.type === "wait_turn");
    if (
        hasWait &&
        isV08StrongerRangedPostureWait(
            observation.unit,
            observation.context.unitsHolder,
            observation.context.fightProperties?.getCurrentLap() ?? 0,
            observation.incumbent,
        )
    ) {
        return false;
    }
    const candidates = enumerateCandidates(observation.unit, observation.context, [...observation.incumbent], {
        maxMoveDestinations: 8,
        preserveMovePostureDiversity: true,
        maxMeleePairs: 16,
        maxShotAims: 16,
        maxMoveShotComposites: 2,
        maxAreaThrowCells: 8,
        preserveAttackTargetCoverage: true,
        includeMountainAttacks: true,
        enrichIncumbentMetadata: true,
    }).candidates.slice(0, 96);
    return candidates.some(v09CandidateIsProductive);
}

const newDiagnostics = (): IGameDiagnostics => ({
    v09PolicyDecisions: 0,
    v09PolicyEvents: 0,
    v09ServerPreflightTimings: 0,
    telemetryMismatches: 0,
    pendingTelemetryByDecision: new Map(),
    pendingPreflightByDecision: new Map(),
    invalidModelTelemetryEvents: 0,
    runtimeFallbacks: 0,
    instrumentationFailures: 0,
    avoidablePassiveActions: 0,
    turnLatencyMicros: new Map(),
});

const telemetryKey = (team: number, unitId: string, lap: number): string => `${team}:${unitId}:${lap}`;

const balanceTelemetry = (pending: Map<string, number>, key: string, delta: 1 | -1): void => {
    const balance = (pending.get(key) ?? 0) + delta;
    if (balance === 0) pending.delete(key);
    else pending.set(key, balance);
};

const finalizeTelemetryDiagnostics = (diagnostics: IGameDiagnostics): void => {
    diagnostics.telemetryMismatches += [...diagnostics.pendingTelemetryByDecision.values()].reduce(
        (sum, count) => sum + Math.abs(count),
        0,
    );
    diagnostics.telemetryMismatches += [...diagnostics.pendingPreflightByDecision.values()].reduce(
        (sum, count) => sum + Math.abs(count),
        0,
    );
    diagnostics.pendingTelemetryByDecision.clear();
    diagnostics.pendingPreflightByDecision.clear();
};

function qualificationObservers(
    diagnostics: IGameDiagnostics,
    artifact: IV09ModelArtifact,
): Pick<IMatchConfig, "decisionObserver" | "policyEventObserver" | "v09ServerPreflightObserver"> {
    return {
        decisionObserver: (observation): void => {
            if (observation.strategyVersion !== "v0.9") return;
            diagnostics.v09PolicyDecisions += 1;
            const key = telemetryKey(
                observation.unit.getTeam(),
                observation.unit.getId(),
                observation.context.fightProperties?.getCurrentLap() ?? 0,
            );
            balanceTelemetry(diagnostics.pendingTelemetryByDecision, key, 1);
            balanceTelemetry(diagnostics.pendingPreflightByDecision, key, 1);
            try {
                if (observeAvoidablePassive(observation)) diagnostics.avoidablePassiveActions += 1;
            } catch {
                diagnostics.instrumentationFailures += 1;
            }
        },
        v09ServerPreflightObserver: (observation): void => {
            diagnostics.v09ServerPreflightTimings += 1;
            const key = telemetryKey(observation.team, observation.unitId, observation.lap);
            balanceTelemetry(diagnostics.pendingPreflightByDecision, key, -1);
            if (
                !Number.isSafeInteger(observation.decisionMicros) ||
                observation.decisionMicros < 0 ||
                !Number.isSafeInteger(observation.preflightMicros) ||
                observation.preflightMicros < 0 ||
                !Number.isSafeInteger(observation.totalMicros) ||
                observation.totalMicros < observation.decisionMicros ||
                observation.failure !== null
            ) {
                diagnostics.instrumentationFailures += 1;
            }
            bumpHistogram(diagnostics.turnLatencyMicros, observation.totalMicros);
        },
        policyEventObserver: (event: IAIPolicyEvent): void => {
            if (event.kind !== "v0.9_decision") return;
            diagnostics.v09PolicyEvents += 1;
            const key = telemetryKey(event.team, event.unitId, event.lap);
            balanceTelemetry(diagnostics.pendingTelemetryByDecision, key, -1);
            if (
                event.details.artifactStatus !== "trained" ||
                event.details.modelId !== artifact.modelId ||
                event.details.modelSha256 !== artifact.modelSha256 ||
                event.details.fallbackReason === "invalid_artifact" ||
                event.details.fallbackReason === "unpromoted_model" ||
                event.details.fallbackReason === "untrained_anchor"
            ) {
                diagnostics.invalidModelTelemetryEvents += 1;
            }
            if (event.details.circuitBreakerRecommended) diagnostics.runtimeFallbacks += 1;
        },
    };
}

function gameOutcome(result: IMatchResult, v09Seat: Side): IV09QualificationGameOutcome {
    const rejectedV09 = v09Seat === "green" ? (result.rejectedGreen ?? 0) : (result.rejectedRed ?? 0);
    const rejectedV08 = v09Seat === "green" ? (result.rejectedRed ?? 0) : (result.rejectedGreen ?? 0);
    const winner =
        result.winner === "draw" ? "draw" : result.winner === v09Seat ? ("v0.9" as const) : ("v0.8" as const);
    return {
        v09Seat,
        winner,
        scoreV09: winner === "v0.9" ? 1 : winner === "draw" ? 0.5 : 0,
        laps: result.laps,
        endReason: result.endReason,
        reachedArmageddon: result.attrition.reachedArmageddon,
        armageddonDecided: result.attrition.decidedByArmageddon,
        rejectedV09,
        rejectedV08,
    };
}

function controlOutcome(result: IMatchResult): IV09QualificationControlOutcome {
    return {
        winnerSide: result.winner,
        laps: result.laps,
        endReason: result.endReason,
        reachedArmageddon: result.attrition.reachedArmageddon,
        armageddonDecided: result.attrition.decidedByArmageddon,
        rejectedGreen: result.rejectedGreen ?? 0,
        rejectedRed: result.rejectedRed ?? 0,
    };
}

export function runV09QualificationPair(
    pair: IV09QualificationPlanPair,
    artifact: IV09ModelArtifact,
    runFingerprint: string,
    manifestSha256: string,
): IV09QualificationPairRecord {
    verifyV09ResearchArtifact(artifact);
    const modelSha256 = requireSha(artifact.modelSha256, "artifact.modelSha256");
    const outcomes: IV09QualificationGameOutcome[] = [];
    const combined = newDiagnostics();
    for (const v09Seat of ["green", "red"] as const) {
        const diagnostics = newDiagnostics();
        // This explicit simulation-only activation accepts the original unpromoted research object. It never
        // mutates or forges a qualification receipt and cannot affect the registered production singleton.
        const researchStrategy = createV09OfflineResearchStrategy(artifact);
        const result = runMatch({
            greenVersion: v09Seat === "green" ? "v0.9" : "v0.8",
            redVersion: v09Seat === "red" ? "v0.9" : "v0.8",
            seed: pair.combatSeed,
            maxLaps: 60,
            ...qualificationMatchBase(pair),
            ...(v09Seat === "green"
                ? { greenStrategyOverride: researchStrategy }
                : { redStrategyOverride: researchStrategy }),
            ...qualificationObservers(diagnostics, artifact),
        });
        finalizeTelemetryDiagnostics(diagnostics);
        outcomes.push(gameOutcome(result, v09Seat));
        combined.v09PolicyDecisions += diagnostics.v09PolicyDecisions;
        combined.v09PolicyEvents += diagnostics.v09PolicyEvents;
        combined.v09ServerPreflightTimings += diagnostics.v09ServerPreflightTimings;
        combined.telemetryMismatches += diagnostics.telemetryMismatches;
        combined.invalidModelTelemetryEvents += diagnostics.invalidModelTelemetryEvents;
        combined.runtimeFallbacks += diagnostics.runtimeFallbacks;
        combined.instrumentationFailures += diagnostics.instrumentationFailures;
        combined.avoidablePassiveActions += diagnostics.avoidablePassiveActions;
        mergeHistogram(combined.turnLatencyMicros, histogramEntries(diagnostics.turnLatencyMicros), pair.id);
    }
    const v08ControlGame = controlOutcome(
        runMatch({
            greenVersion: "v0.8",
            redVersion: "v0.8",
            seed: pair.combatSeed,
            maxLaps: 60,
            ...qualificationMatchBase(pair),
        }),
    );
    const unsigned: Omit<IV09QualificationPairRecord, "recordSha256"> = {
        schema: V09_QUALIFICATION_PAIR_SCHEMA,
        runFingerprint,
        manifestSha256,
        modelSha256,
        id: pair.id,
        purpose: pair.purpose,
        pairIndex: pair.pairIndex,
        scenarioSeed: pair.scenarioSeed,
        combatSeed: pair.combatSeed,
        cohort: pair.cohort,
        map: pair.map,
        games: outcomes as [IV09QualificationGameOutcome, IV09QualificationGameOutcome],
        v08ControlGame,
        v09PolicyDecisions: combined.v09PolicyDecisions,
        v09PolicyEvents: combined.v09PolicyEvents,
        v09ServerPreflightTimings: combined.v09ServerPreflightTimings,
        telemetryMismatches: combined.telemetryMismatches,
        invalidModelTelemetryEvents: combined.invalidModelTelemetryEvents,
        runtimeFallbacks: combined.runtimeFallbacks,
        instrumentationFailures: combined.instrumentationFailures,
        avoidablePassiveActions: combined.avoidablePassiveActions,
        turnLatencyMicros: histogramEntries(combined.turnLatencyMicros),
    };
    return { ...unsigned, recordSha256: hashPairRecord(unsigned) };
}

function validatePairRecord(
    record: IV09QualificationPairRecord,
    plan: IV09QualificationPlanPair,
    manifest: IV09CampaignManifest,
    modelSha256: string,
): void {
    if (
        record.schema !== V09_QUALIFICATION_PAIR_SCHEMA ||
        record.runFingerprint !== manifest.runFingerprint ||
        record.manifestSha256 !== manifest.manifestSha256 ||
        record.modelSha256 !== modelSha256 ||
        hashPairRecord(record) !== requireSha(record.recordSha256, `${plan.id}.recordSha256`)
    ) {
        throw new Error(`qualification pair ${plan.id} identity/hash mismatch`);
    }
    for (const key of ["id", "purpose", "pairIndex", "scenarioSeed", "combatSeed", "cohort", "map"] as const) {
        if (record[key] !== plan[key]) throw new Error(`qualification pair ${plan.id} ${key} mismatch`);
    }
    if (!Array.isArray(record.games) || record.games.length !== 2) {
        throw new Error(`qualification pair ${plan.id} must contain two mirrored games`);
    }
    if (record.games[0].v09Seat !== "green" || record.games[1].v09Seat !== "red") {
        throw new Error(`qualification pair ${plan.id} did not mirror v0.9 across both seats`);
    }
    for (const [index, game] of record.games.entries()) {
        if (
            !["v0.9", "v0.8", "draw"].includes(game.winner) ||
            ![0, 0.5, 1].includes(game.scoreV09) ||
            game.scoreV09 !== (game.winner === "v0.9" ? 1 : game.winner === "draw" ? 0.5 : 0)
        ) {
            throw new Error(`qualification pair ${plan.id} game ${index} outcome mismatch`);
        }
        if (
            typeof game.reachedArmageddon !== "boolean" ||
            typeof game.armageddonDecided !== "boolean" ||
            (game.armageddonDecided && !game.reachedArmageddon)
        ) {
            throw new Error(`qualification pair ${plan.id} game ${index} Armageddon telemetry mismatch`);
        }
        integer(game.laps, `${plan.id}.games[${index}].laps`);
        integer(game.rejectedV09, `${plan.id}.games[${index}].rejectedV09`);
        integer(game.rejectedV08, `${plan.id}.games[${index}].rejectedV08`);
    }
    if (!["green", "red", "draw"].includes(record.v08ControlGame.winnerSide)) {
        throw new Error(`qualification pair ${plan.id} v0.8 control outcome mismatch`);
    }
    if (
        typeof record.v08ControlGame.reachedArmageddon !== "boolean" ||
        typeof record.v08ControlGame.armageddonDecided !== "boolean" ||
        (record.v08ControlGame.armageddonDecided && !record.v08ControlGame.reachedArmageddon)
    ) {
        throw new Error(`qualification pair ${plan.id} v0.8 control Armageddon telemetry mismatch`);
    }
    integer(record.v08ControlGame.laps, `${plan.id}.v08ControlGame.laps`);
    integer(record.v08ControlGame.rejectedGreen, `${plan.id}.v08ControlGame.rejectedGreen`);
    integer(record.v08ControlGame.rejectedRed, `${plan.id}.v08ControlGame.rejectedRed`);
    integer(record.v09PolicyDecisions, `${plan.id}.v09PolicyDecisions`);
    integer(record.v09PolicyEvents, `${plan.id}.v09PolicyEvents`);
    integer(record.v09ServerPreflightTimings, `${plan.id}.v09ServerPreflightTimings`);
    integer(record.telemetryMismatches, `${plan.id}.telemetryMismatches`);
    integer(record.invalidModelTelemetryEvents, `${plan.id}.invalidModelTelemetryEvents`);
    integer(record.runtimeFallbacks, `${plan.id}.runtimeFallbacks`);
    integer(record.instrumentationFailures, `${plan.id}.instrumentationFailures`);
    integer(record.avoidablePassiveActions, `${plan.id}.avoidablePassiveActions`);
    const latency = new Map<number, number>();
    mergeHistogram(latency, record.turnLatencyMicros, `${plan.id}.turnLatencyMicros`);
    const latencySamples = [...latency.values()].reduce((sum, count) => sum + count, 0);
    if (
        record.v09ServerPreflightTimings !== record.v09PolicyDecisions ||
        latencySamples !== record.v09ServerPreflightTimings
    ) {
        throw new Error(`${plan.id} deployable timing count does not match v0.9 policy decisions`);
    }
}

interface IMutableTally {
    purpose: V09QualificationPurpose;
    cohort?: V09TeacherCohort;
    map?: V09Map;
    games: number;
    v09Wins: number;
    v08Wins: number;
    draws: number;
}

const newTally = (purpose: V09QualificationPurpose, cohort?: V09TeacherCohort, map?: V09Map): IMutableTally => ({
    purpose,
    cohort,
    map,
    games: 0,
    v09Wins: 0,
    v08Wins: 0,
    draws: 0,
});

const tallyScore = (tally: IMutableTally): number =>
    tally.games ? (tally.v09Wins + 0.5 * tally.draws) / tally.games : 0;

export function aggregateV09Qualification(
    records: readonly IV09QualificationPairRecord[],
    modelP99Ms: number,
    rssIncreaseMiB: number,
): IQualificationAggregate {
    const stages = new Map<V09QualificationPurpose, IMutableTally>(
        V09_QUALIFICATION_PURPOSES.map((purpose) => [purpose, newTally(purpose)]),
    );
    const cells = new Map<string, IMutableTally>();
    const latency = new Map<number, number>();
    let v09Wins = 0;
    let v08Wins = 0;
    let draws = 0;
    let armageddonGames = 0;
    let armageddonWhenV09Green = 0;
    let armageddonWhenV09Red = 0;
    let armageddonDecidedGames = 0;
    let armageddonV09Wins = 0;
    let armageddonV08Wins = 0;
    let v08ControlGames = 0;
    let v08ControlArmageddonGames = 0;
    let v08ControlArmageddonDecidedGames = 0;
    let rejectedV08Control = 0;
    let rejectedV09 = 0;
    let rejectedV08 = 0;
    let runtimeFallbacks = 0;
    let telemetryMismatches = 0;
    let invalidModelTelemetryEvents = 0;
    let instrumentationFailures = 0;
    let avoidablePassiveActions = 0;
    let v09PolicyDecisions = 0;
    let v09PolicyEvents = 0;
    let v09ServerPreflightTimings = 0;
    for (const record of records) {
        const stage = stages.get(record.purpose)!;
        const cellKey = v09QualificationCellKey(record.purpose, record.cohort, record.map);
        const cell = cells.get(cellKey) ?? newTally(record.purpose, record.cohort, record.map);
        cells.set(cellKey, cell);
        for (const game of record.games) {
            stage.games += 1;
            cell.games += 1;
            if (game.winner === "v0.9") {
                stage.v09Wins += 1;
                cell.v09Wins += 1;
                v09Wins += 1;
                if (game.armageddonDecided) armageddonV09Wins += 1;
            } else if (game.winner === "v0.8") {
                stage.v08Wins += 1;
                cell.v08Wins += 1;
                v08Wins += 1;
                if (game.armageddonDecided) armageddonV08Wins += 1;
            } else {
                stage.draws += 1;
                cell.draws += 1;
                draws += 1;
            }
            if (game.reachedArmageddon) {
                armageddonGames += 1;
                if (game.v09Seat === "green") armageddonWhenV09Green += 1;
                else armageddonWhenV09Red += 1;
            }
            if (game.armageddonDecided) armageddonDecidedGames += 1;
            rejectedV09 += game.rejectedV09;
            rejectedV08 += game.rejectedV08;
        }
        v08ControlGames += 1;
        if (record.v08ControlGame.reachedArmageddon) v08ControlArmageddonGames += 1;
        if (record.v08ControlGame.armageddonDecided) v08ControlArmageddonDecidedGames += 1;
        rejectedV08Control += record.v08ControlGame.rejectedGreen + record.v08ControlGame.rejectedRed;
        v09PolicyDecisions += record.v09PolicyDecisions;
        v09PolicyEvents += record.v09PolicyEvents;
        v09ServerPreflightTimings += record.v09ServerPreflightTimings;
        telemetryMismatches += record.telemetryMismatches;
        invalidModelTelemetryEvents += record.invalidModelTelemetryEvents;
        runtimeFallbacks += record.runtimeFallbacks;
        instrumentationFailures += record.instrumentationFailures;
        avoidablePassiveActions += record.avoidablePassiveActions;
        mergeHistogram(latency, record.turnLatencyMicros, record.id);
    }
    const stageSummaries = [...stages.values()].map((stage) => ({
        purpose: stage.purpose,
        games: stage.games,
        v09Wins: stage.v09Wins,
        v08Wins: stage.v08Wins,
        draws: stage.draws,
        score: roundMetric(tallyScore(stage)),
    }));
    const cellSummaries = [...cells.entries()]
        .map(([key, cell]) => ({
            key,
            purpose: cell.purpose,
            cohort: cell.cohort!,
            map: cell.map!,
            games: cell.games,
            v09Wins: cell.v09Wins,
            v08Wins: cell.v08Wins,
            draws: cell.draws,
            score: roundMetric(tallyScore(cell)),
        }))
        .sort((left, right) => left.key.localeCompare(right.key));
    const combinedGames = v09Wins + v08Wins + draws;
    if (!combinedGames) throw new Error("v0.9 qualification aggregation has no games");
    if (!latency.size) throw new Error("v0.9 qualification emitted no policy latency samples");
    const confirmation = stageSummaries.find((stage) => stage.purpose === "confirmation")!;
    const qualification = stageSummaries.find((stage) => stage.purpose === "qualification")!;
    const combinedScore = (v09Wins + 0.5 * draws) / combinedGames;
    const metrics: IV09QualificationMetrics = {
        combinedGames,
        confirmationGames: confirmation.games,
        qualificationGames: qualification.games,
        combinedScore: roundMetric(combinedScore),
        confirmationScore: confirmation.score,
        qualificationScore: qualification.score,
        lower95: roundMetric(v09WilsonLower95(v09Wins, draws, combinedGames)),
        minimumCellScore: roundMetric(Math.min(...cellSummaries.map((cell) => cell.score))),
        armageddonRate: roundMetric(armageddonGames / combinedGames),
        v08ArmageddonRate: roundMetric(v08ControlArmageddonGames / v08ControlGames),
        invalidActions:
            rejectedV09 +
            runtimeFallbacks +
            telemetryMismatches +
            invalidModelTelemetryEvents +
            instrumentationFailures,
        avoidablePassiveActions,
        p99ModelMs: roundMetric(finite(modelP99Ms, "modelP99Ms")),
        p99TurnMs: roundMetric(histogramQuantile(latency, 0.99, "turn latency") / 1000),
        rssIncreaseMiB: roundMetric(finite(rssIncreaseMiB, "rssIncreaseMiB")),
    };
    return {
        metrics,
        baselineMetrics: {
            invalidActions: rejectedV08 + rejectedV08Control,
        },
        stages: stageSummaries,
        cells: cellSummaries,
        totals: {
            v09Wins,
            v08Wins,
            draws,
            armageddonGames,
            armageddonWhenV09Green,
            armageddonWhenV09Red,
            armageddonDecidedGames,
            armageddonV09Wins,
            armageddonV08Wins,
            v08ControlGames,
            v08ControlArmageddonGames,
            v08ControlArmageddonDecidedGames,
            rejectedV08Control,
            rejectedV09,
            rejectedV08,
            runtimeFallbacks,
            telemetryMismatches,
            invalidModelTelemetryEvents,
            instrumentationFailures,
            avoidablePassiveActions,
            v09PolicyDecisions,
            v09PolicyEvents,
            v09ServerPreflightTimings,
            latencySamples: [...latency.values()].reduce((sum, count) => sum + count, 0),
        },
    };
}

function qualificationBehaviorEnvironment(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(buildV08A13SearchEnvironment("v0.8"))) {
        if (value !== undefined) result[key] = value;
    }
    result.SIM_NO_ACTIONS = "1";
    result.LIVETWIN = "1";
    result.FIGHT_MELEE_ROSTERS = "0";
    if (result.SEARCH_VERSIONS !== "v0.8" || result.V07_SEARCH !== "1") {
        throw new Error("v0.9 qualification baseline is not exact v0.8+a13 search");
    }
    return result;
}

function qualificationWorkerEnvironment(): Record<string, string> {
    const result = Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    for (const key of Object.keys(result)) {
        if (QUALIFICATION_PREFIXES.some((prefix) => key === prefix || key.startsWith(prefix))) delete result[key];
    }
    Object.assign(result, qualificationBehaviorEnvironment());
    return result;
}

function executionFingerprint(): string {
    return fingerprintV09({
        hostname: hostname(),
        platform: process.platform,
        architecture: process.arch,
        bun: Bun.version,
        cpu: cpus()[0]?.model ?? "unknown",
    });
}

function benchmarkModelP99(artifact: IV09ModelArtifact): number {
    const features = new Array<number>(artifact.architecture.inputSize).fill(0);
    for (let index = 0; index < 128; index += 1) scoreV09FixedPoint(artifact, features);
    const histogram = new Map<number, number>();
    for (let index = 0; index < 2_048; index += 1) {
        features[index % features.length] = (index % 17) / 16;
        const started = performance.now();
        scoreV09FixedPoint(artifact, features);
        bumpHistogram(histogram, (performance.now() - started) * 1000);
    }
    return roundMetric(histogramQuantile(histogram, 0.99, "model benchmark") / 1000);
}

const runnerSourceSha256 = (): string => sha256(readFileSync(fileURLToPath(import.meta.url)));

function buildJournalHeader(
    manifest: IV09CampaignManifest,
    ledger: IV09SeedLedger,
    artifact: IV09ModelArtifact,
    artifactFileSha256: string,
    plan: readonly IV09QualificationPlanPair[],
    shardPlan: readonly IV09QualificationPlanPair[],
    shardIndex: number,
    shardCount: number,
    rssBeforeArtifact: number,
    nodeRole: V09QualificationNodeRole,
    sourceIdentityReceiptSha256: string,
): IV09QualificationJournalHeader {
    const unsigned: Omit<IV09QualificationJournalHeader, "headerSha256"> = {
        schema: V09_QUALIFICATION_JOURNAL_SCHEMA,
        runFingerprint: manifest.runFingerprint,
        manifestSha256: manifest.manifestSha256,
        seedLedgerSha256: ledger.ledgerSha256,
        modelSha256: artifact.modelSha256!,
        artifactFileSha256,
        planSha256: fingerprintV09(plan),
        shardPlanSha256: fingerprintV09(shardPlan),
        shardCount,
        shardIndex,
        expectedPairs: plan.length,
        expectedGames: plan.length * 2,
        expectedV08ControlGames: plan.length,
        expectedTotalSimulations: plan.length * 3,
        expectedShardPairs: shardPlan.length,
        expectedShardSimulations: shardPlan.length * 3,
        runnerSourceSha256: runnerSourceSha256(),
        behaviorEnvironmentSha256: fingerprintV09(qualificationBehaviorEnvironment()),
        executionFingerprint: executionFingerprint(),
        nodeRole,
        sourceIdentityReceiptSha256,
        modelP99Ms: benchmarkModelP99(artifact),
        rssIncreaseMiB: roundMetric(Math.max(0, process.memoryUsage().rss - rssBeforeArtifact) / 2 ** 20),
    };
    return { ...unsigned, headerSha256: fingerprintV09(unsigned) };
}

function validateJournalHeader(
    header: IV09QualificationJournalHeader,
    manifest: IV09CampaignManifest,
    ledger: IV09SeedLedger,
    artifact: IV09ModelArtifact,
    artifactFileSha256: string,
    plan: readonly IV09QualificationPlanPair[],
    shardPlan: readonly IV09QualificationPlanPair[],
    shardIndex: number,
    shardCount: number,
    nodeRole: V09QualificationNodeRole | null,
    sourceIdentityReceiptSha256: string,
    requireCurrentExecution: boolean,
): void {
    const { headerSha256, ...unsigned } = header;
    if (
        header.schema !== V09_QUALIFICATION_JOURNAL_SCHEMA ||
        fingerprintV09(unsigned) !== requireSha(headerSha256, "journal.headerSha256") ||
        header.runFingerprint !== manifest.runFingerprint ||
        header.manifestSha256 !== manifest.manifestSha256 ||
        header.seedLedgerSha256 !== ledger.ledgerSha256 ||
        header.modelSha256 !== artifact.modelSha256 ||
        header.artifactFileSha256 !== artifactFileSha256 ||
        header.planSha256 !== fingerprintV09(plan) ||
        header.shardPlanSha256 !== fingerprintV09(shardPlan) ||
        header.shardCount !== shardCount ||
        header.shardIndex !== shardIndex ||
        header.expectedPairs !== plan.length ||
        header.expectedGames !== plan.length * 2 ||
        header.expectedV08ControlGames !== plan.length ||
        header.expectedTotalSimulations !== plan.length * 3 ||
        header.expectedShardPairs !== shardPlan.length ||
        header.expectedShardSimulations !== shardPlan.length * 3 ||
        header.runnerSourceSha256 !== runnerSourceSha256() ||
        header.behaviorEnvironmentSha256 !== fingerprintV09(qualificationBehaviorEnvironment()) ||
        (requireCurrentExecution && header.executionFingerprint !== executionFingerprint()) ||
        (nodeRole !== null && header.nodeRole !== nodeRole) ||
        header.sourceIdentityReceiptSha256 !== sourceIdentityReceiptSha256
    ) {
        throw new Error("v0.9 qualification journal header identity mismatch");
    }
}

function fsyncFile(path: string): void {
    const descriptor = openSync(path, "r+");
    try {
        fsyncSync(descriptor);
    } finally {
        closeSync(descriptor);
    }
}

/**
 * A durable journal record ends in LF. A crash can leave only the final append incomplete: valid JSON missing
 * its LF is completed, invalid JSON is truncated back to the prior LF, and corruption anywhere else fails.
 */
export function recoverV09QualificationJournalTail(path: string): string[] {
    let bytes = readFileSync(path);
    if (!bytes.length) throw new Error("v0.9 qualification journal is empty");
    if (bytes[bytes.length - 1] !== 0x0a) {
        const lastLf = bytes.lastIndexOf(0x0a);
        const finalBytes = bytes.subarray(lastLf + 1);
        let finalJsonIsComplete = false;
        try {
            JSON.parse(finalBytes.toString("utf8"));
            finalJsonIsComplete = true;
        } catch {
            finalJsonIsComplete = false;
        }
        if (finalJsonIsComplete) {
            const descriptor = openSync(path, "a");
            try {
                writeFileSync(descriptor, "\n");
                fsyncSync(descriptor);
            } finally {
                closeSync(descriptor);
            }
        } else {
            if (lastLf < 0) throw new Error("v0.9 qualification journal has no durable header");
            truncateSync(path, lastLf + 1);
            fsyncFile(path);
        }
        bytes = readFileSync(path);
    }
    return bytes.toString("utf8").split(/\r?\n/);
}

function appendDurableJournalRecord(path: string, record: IV09QualificationPairRecord): void {
    const descriptor = openSync(path, "a");
    try {
        writeFileSync(descriptor, `${JSON.stringify(record)}\n`);
        fsyncSync(descriptor);
    } finally {
        closeSync(descriptor);
    }
}

function loadJournal(
    path: string,
    manifest: IV09CampaignManifest,
    ledger: IV09SeedLedger,
    artifact: IV09ModelArtifact,
    artifactFileSha256: string,
    plan: readonly IV09QualificationPlanPair[],
    shardPlan: readonly IV09QualificationPlanPair[],
    shardIndex: number,
    shardCount: number,
    rssBeforeArtifact: number,
    nodeRole: V09QualificationNodeRole | null,
    sourceIdentityReceiptSha256: string,
    createIfMissing = true,
    requireCurrentExecution = true,
    recoverTail = true,
): { header: IV09QualificationJournalHeader; records: Map<string, IV09QualificationPairRecord> } {
    const planById = new Map(shardPlan.map((pair) => [pair.id, pair]));
    if (!existsSync(path)) {
        if (!createIfMissing || nodeRole === null)
            throw new Error(`required qualification shard journal is missing: ${path}`);
        mkdirSync(dirname(path), { recursive: true });
        const header = buildJournalHeader(
            manifest,
            ledger,
            artifact,
            artifactFileSha256,
            plan,
            shardPlan,
            shardIndex,
            shardCount,
            rssBeforeArtifact,
            nodeRole,
            sourceIdentityReceiptSha256,
        );
        writeFileSync(path, `${JSON.stringify(header)}\n`, { encoding: "utf8", flag: "wx" });
        fsyncFile(path);
        return { header, records: new Map() };
    }
    const lines = recoverTail
        ? recoverV09QualificationJournalTail(path)
        : (() => {
              const bytes = readFileSync(path);
              if (!bytes.length || bytes[bytes.length - 1] !== 0x0a) {
                  throw new Error("sealed v0.9 qualification journal must end in LF");
              }
              return bytes.toString("utf8").split(/\r?\n/);
          })();
    if (!lines[0]?.trim()) throw new Error("v0.9 qualification journal is missing its header");
    const header = JSON.parse(lines[0]) as IV09QualificationJournalHeader;
    validateJournalHeader(
        header,
        manifest,
        ledger,
        artifact,
        artifactFileSha256,
        plan,
        shardPlan,
        shardIndex,
        shardCount,
        nodeRole,
        sourceIdentityReceiptSha256,
        requireCurrentExecution,
    );
    const records = new Map<string, IV09QualificationPairRecord>();
    for (let index = 1; index < lines.length; index += 1) {
        const line = lines[index]!;
        if (!line.trim()) continue;
        let record: IV09QualificationPairRecord;
        try {
            record = JSON.parse(line) as IV09QualificationPairRecord;
        } catch {
            throw new Error(`v0.9 qualification journal line ${index + 1} is incomplete or invalid JSON`);
        }
        const expected = planById.get(record.id);
        if (!expected) throw new Error(`journal line ${index + 1} references an unregistered pair`);
        validatePairRecord(record, expected, manifest, artifact.modelSha256!);
        if (records.has(record.id)) throw new Error(`journal contains duplicate pair ${record.id}`);
        records.set(record.id, record);
    }
    return { header, records };
}

function atomicImmutableJson(path: string, value: unknown): void {
    if (existsSync(path)) throw new Error(`refusing to replace immutable v0.9 qualification summary ${path}`);
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o444 });
    try {
        linkSync(temporary, path);
        chmodSync(path, 0o444);
    } finally {
        unlinkSync(temporary);
    }
}

function buildShardReceipt(
    manifest: IV09CampaignManifest,
    ledger: IV09SeedLedger,
    artifact: IV09ModelArtifact,
    artifactFileSha256: string,
    header: IV09QualificationJournalHeader,
    records: readonly IV09QualificationPairRecord[],
    journalPath: string,
    completedAt = new Date().toISOString(),
): IV09QualificationShardReceipt {
    if (records.length !== header.expectedShardPairs) {
        throw new Error("cannot seal an incomplete v0.9 qualification shard");
    }
    const shardAggregate = aggregateV09Qualification(records, header.modelP99Ms, header.rssIncreaseMiB);
    const unsigned: Omit<IV09QualificationShardReceipt, "receiptSha256"> = {
        schema: V09_QUALIFICATION_SHARD_RECEIPT_SCHEMA,
        promoted: false,
        status: "complete_nonpromoting_shard",
        runFingerprint: manifest.runFingerprint,
        manifestSha256: manifest.manifestSha256,
        seedLedgerSha256: ledger.ledgerSha256,
        modelSha256: artifact.modelSha256!,
        researchArtifactSha256: artifactFileSha256,
        planSha256: header.planSha256,
        shardPlanSha256: header.shardPlanSha256,
        shardCount: header.shardCount,
        shardIndex: header.shardIndex,
        expectedPairs: header.expectedShardPairs,
        completedPairs: header.expectedShardPairs,
        expectedSimulations: header.expectedShardSimulations,
        completedSimulations: header.expectedShardSimulations,
        journalSha256: sha256(readFileSync(journalPath)),
        journalHeaderSha256: header.headerSha256,
        runnerSourceSha256: header.runnerSourceSha256,
        sourceIdentityReceiptSha256: header.sourceIdentityReceiptSha256,
        behaviorEnvironmentSha256: header.behaviorEnvironmentSha256,
        executionFingerprint: header.executionFingerprint,
        nodeRole: header.nodeRole,
        modelP99Ms: header.modelP99Ms,
        turnP99Ms: shardAggregate.metrics.p99TurnMs,
        rssIncreaseMiB: header.rssIncreaseMiB,
        completedAt,
    };
    return { ...unsigned, receiptSha256: fingerprintV09(unsigned) };
}

export function validateV09QualificationShardReceipt(receipt: IV09QualificationShardReceipt): void {
    if (!receipt || typeof receipt !== "object") {
        throw new Error("v0.9 qualification shard receipt is missing");
    }
    const { receiptSha256, ...unsigned } = receipt;
    integer(receipt.shardCount, "qualification shard receipt.shardCount", 1);
    integer(receipt.shardIndex, "qualification shard receipt.shardIndex");
    integer(receipt.expectedPairs, "qualification shard receipt.expectedPairs", 1);
    integer(receipt.completedPairs, "qualification shard receipt.completedPairs", 1);
    integer(receipt.expectedSimulations, "qualification shard receipt.expectedSimulations", 1);
    integer(receipt.completedSimulations, "qualification shard receipt.completedSimulations", 1);
    finite(receipt.modelP99Ms, "qualification shard receipt.modelP99Ms");
    finite(receipt.turnP99Ms, "qualification shard receipt.turnP99Ms");
    finite(receipt.rssIncreaseMiB, "qualification shard receipt.rssIncreaseMiB");
    requireIsoInstant(receipt.completedAt, "qualification shard receipt.completedAt");
    for (const [name, value] of [
        ["runFingerprint", receipt.runFingerprint],
        ["manifestSha256", receipt.manifestSha256],
        ["seedLedgerSha256", receipt.seedLedgerSha256],
        ["modelSha256", receipt.modelSha256],
        ["researchArtifactSha256", receipt.researchArtifactSha256],
        ["planSha256", receipt.planSha256],
        ["shardPlanSha256", receipt.shardPlanSha256],
        ["journalSha256", receipt.journalSha256],
        ["journalHeaderSha256", receipt.journalHeaderSha256],
        ["runnerSourceSha256", receipt.runnerSourceSha256],
        ["sourceIdentityReceiptSha256", receipt.sourceIdentityReceiptSha256],
        ["behaviorEnvironmentSha256", receipt.behaviorEnvironmentSha256],
        ["executionFingerprint", receipt.executionFingerprint],
    ] as const) {
        requireSha(value, `qualification shard receipt.${name}`);
    }
    if (
        receipt.schema !== V09_QUALIFICATION_SHARD_RECEIPT_SCHEMA ||
        receipt.promoted !== false ||
        receipt.status !== "complete_nonpromoting_shard" ||
        !V09_QUALIFICATION_NODE_ROLES.includes(receipt.nodeRole) ||
        receipt.shardCount > 256 ||
        receipt.shardIndex >= receipt.shardCount ||
        receipt.modelP99Ms < 0 ||
        receipt.turnP99Ms < 0 ||
        receipt.rssIncreaseMiB < 0 ||
        fingerprintV09(unsigned) !== requireSha(receiptSha256, "qualification shard receiptSha256") ||
        receipt.completedPairs !== receipt.expectedPairs ||
        receipt.completedSimulations !== receipt.expectedSimulations ||
        receipt.completedSimulations !== receipt.completedPairs * 3 ||
        receipt.expectedSimulations !== receipt.expectedPairs * 3
    ) {
        throw new Error("v0.9 qualification shard receipt identity/completion mismatch");
    }
}

const PRODUCTION_CPU_QUALIFICATION_COMMAND =
    "bun src/simulation/v0_9/qualify.ts --campaign <campaign-dir> --artifact <research.json> " +
    "--expected-model-sha256 <sha256> --out <fresh-prod-cpu-output-dir> --node-role production_cpu " +
    "--concurrency <physical-core-count>";

export function v09ProductionTurnLatencyFailure(p99TurnMs: number | null): string | null {
    if (p99TurnMs === null) return "a separate production-CPU qualification result is required";
    if (!Number.isFinite(p99TurnMs) || p99TurnMs >= 20) {
        return "production-CPU turn p99 is not below 20ms";
    }
    return null;
}

export function v09BaselineInvalidActionFailure(invalidActions: number): string | null {
    integer(invalidActions, "baseline invalidActions");
    return invalidActions === 0 ? null : "v0.8 baseline/control rejected or invalid action count is non-zero";
}

const finalQualificationFailures = (
    metrics: IV09QualificationMetrics,
    productionCpuP99TurnMs: number | null,
    baselineInvalidActions: number,
): string[] => {
    const failures = v09QualificationFailures(metrics);
    const baselineFailure = v09BaselineInvalidActionFailure(baselineInvalidActions);
    if (baselineFailure) failures.push(baselineFailure);
    const productionLatencyFailure = v09ProductionTurnLatencyFailure(productionCpuP99TurnMs);
    if (productionLatencyFailure) failures.push(productionLatencyFailure);
    return failures;
};

const mergedJournalSha256 = (receipts: readonly IV09QualificationShardReceipt[]): string =>
    fingerprintV09({
        schema: "hoc.ai.v0_9_qualification_journal_set.v1",
        shards: [...receipts]
            .sort((left, right) => left.shardIndex - right.shardIndex)
            .map(({ shardCount, shardIndex, journalSha256, receiptSha256 }) => ({
                shardCount,
                shardIndex,
                journalSha256,
                receiptSha256,
            })),
    });

function buildSummary(
    manifest: IV09CampaignManifest,
    ledger: IV09SeedLedger,
    artifact: IV09ModelArtifact,
    artifactFileSha256: string,
    plan: readonly IV09QualificationPlanPair[],
    shardReceipts: readonly IV09QualificationShardReceipt[],
    records: readonly IV09QualificationPairRecord[],
    allowSmokeCoverage = false,
): IV09QualificationSummary {
    if (records.length !== plan.length) throw new Error("cannot summarize an incomplete v0.9 qualification");
    if (!shardReceipts.length) throw new Error("cannot summarize v0.9 qualification without shard receipts");
    const firstReceipt = shardReceipts[0]!;
    const productionReceipts = shardReceipts.filter((receipt) => receipt.nodeRole === "production_cpu");
    const mergedModelP99Ms = Math.max(...shardReceipts.map((receipt) => receipt.modelP99Ms));
    const mergedRssIncreaseMiB = Math.max(...shardReceipts.map((receipt) => receipt.rssIncreaseMiB));
    const aggregate = aggregateV09Qualification(records, mergedModelP99Ms, mergedRssIncreaseMiB);
    if (aggregate.metrics.combinedGames !== plan.length * 2 || aggregate.totals.v08ControlGames !== plan.length) {
        throw new Error("qualification summary is missing head-to-head or v0.8 control simulations");
    }
    const mergedTurnP99Ms = aggregate.metrics.p99TurnMs;
    const recordById = new Map(records.map((record) => [record.id, record]));
    const productionRecords = productionReceipts.flatMap((receipt) =>
        partitionV09QualificationPlan(plan, receipt.shardIndex, receipt.shardCount).map((pair) => {
            const record = recordById.get(pair.id);
            if (!record) throw new Error(`production-CPU shard is missing pair ${pair.id}`);
            return record;
        }),
    );
    const productionCpuP99TurnMs = productionRecords.length
        ? aggregateV09Qualification(productionRecords, 0, 0).metrics.p99TurnMs
        : null;
    if (productionCpuP99TurnMs !== null) {
        // Supervisor's generic p99 field is the promotion-gating production CPU measurement. The exact
        // all-node merged histogram remains execution.p99TurnMs for informational cross-host comparison.
        aggregate.metrics = {
            ...aggregate.metrics,
            p99ModelMs: Math.max(...productionReceipts.map((receipt) => receipt.modelP99Ms)),
            p99TurnMs: productionCpuP99TurnMs,
            rssIncreaseMiB: Math.max(...productionReceipts.map((receipt) => receipt.rssIncreaseMiB)),
        };
    }
    const expectedCells =
        V09_QUALIFICATION_PURPOSES.length * V09_QUALIFICATION_COHORTS.length * V09_QUALIFICATION_MAPS.length;
    if (
        !allowSmokeCoverage &&
        (aggregate.cells.length !== expectedCells || aggregate.cells.some((cell) => cell.games < 1))
    ) {
        throw new Error("v0.9 qualification did not cover every preregistered cell");
    }
    const failures = finalQualificationFailures(
        aggregate.metrics,
        productionCpuP99TurnMs,
        aggregate.baselineMetrics.invalidActions,
    );
    const status: IV09QualificationSummary["status"] = failures.length ? "failed" : "qualified_offline";
    const journalSha256 = mergedJournalSha256(shardReceipts);
    const failuresSha256 = fingerprintV09(failures);
    const completedAt = [...shardReceipts]
        .map((receipt) => receipt.completedAt)
        .sort((left, right) => left.localeCompare(right))
        .at(-1)!;
    const qualifiedAt = status === "qualified_offline" ? completedAt : null;
    const receiptUnsigned: Omit<IV09QualificationSummary["promotionReceiptInputs"], "receiptInputsSha256"> = {
        schema: "hoc.ai.v0_9_qualification_receipt_inputs.v2" as const,
        qualificationSummarySchema: V09_QUALIFICATION_SCHEMA,
        armageddonMetric: "reached_armageddon_lap",
        eligible: status === "qualified_offline",
        qualificationStatus: status,
        modelId: artifact.modelId,
        modelSha256: artifact.modelSha256!,
        researchArtifactSha256: artifactFileSha256,
        trainingRunId: manifest.runFingerprint,
        commonCommit: manifest.identity.sourceCommit,
        rulesSha256: manifest.identity.rulesFingerprint,
        rosterSha256: manifest.identity.rosterFingerprint,
        runFingerprint: manifest.runFingerprint,
        sourceCommit: manifest.identity.sourceCommit,
        sourceStatusSha256: manifest.identity.sourceStatusSha256,
        rulesFingerprint: manifest.identity.rulesFingerprint,
        rosterFingerprint: manifest.identity.rosterFingerprint,
        anchorFingerprint: manifest.identity.anchorFingerprint,
        manifestSha256: manifest.manifestSha256,
        seedLedgerSha256: ledger.ledgerSha256,
        journalSha256,
        planSha256: firstReceipt.planSha256,
        runnerSourceSha256: firstReceipt.runnerSourceSha256,
        sourceIdentityReceiptSha256: firstReceipt.sourceIdentityReceiptSha256,
        confirmationGames: aggregate.metrics.confirmationGames,
        qualificationGames: aggregate.metrics.qualificationGames,
        combinedGames: aggregate.metrics.combinedGames,
        v08ControlGames: aggregate.totals.v08ControlGames,
        expectedTotalSimulations: plan.length * 3,
        completedTotalSimulations: aggregate.metrics.combinedGames + aggregate.totals.v08ControlGames,
        nodeRoles: [...new Set(shardReceipts.map((receipt) => receipt.nodeRole))].sort(),
        metricsSha256: fingerprintV09(aggregate.metrics),
        baselineMetricsSha256: fingerprintV09(aggregate.baselineMetrics),
        productionCpuP99TurnMs,
        failures,
        failuresSha256,
        qualifiedAt,
    };
    const unsigned: Omit<IV09QualificationSummary, "summarySha256"> = {
        schema: V09_QUALIFICATION_SCHEMA,
        status,
        promoted: false,
        runFingerprint: manifest.runFingerprint,
        manifestSha256: manifest.manifestSha256,
        seedLedgerSha256: ledger.ledgerSha256,
        modelId: artifact.modelId,
        modelSha256: artifact.modelSha256!,
        artifactFileSha256,
        researchArtifactSha256: artifactFileSha256,
        trainingRunId: manifest.runFingerprint,
        commonCommit: manifest.identity.sourceCommit,
        rulesSha256: manifest.identity.rulesFingerprint,
        rosterSha256: manifest.identity.rosterFingerprint,
        combinedGames: aggregate.metrics.combinedGames,
        confirmationGames: aggregate.metrics.confirmationGames,
        qualificationGames: aggregate.metrics.qualificationGames,
        source: artifact.source,
        baseline: {
            version: "v0.8",
            profile: "a13",
            searchOnly: true,
            genomeSha256: V08_A13_GENOME_SHA256,
            sourceBindingSha256: V08_A13_SOURCE_BINDING_SHA256,
            behaviorEnvironmentSha256: firstReceipt.behaviorEnvironmentSha256,
        },
        policy: {
            version: "v0.9",
            pureCpu: true,
            searchApplied: false,
            offlineResearchActivationOnly: true,
        },
        plan: {
            purposes: V09_QUALIFICATION_PURPOSES,
            cohorts: V09_QUALIFICATION_COHORTS,
            maps: V09_QUALIFICATION_MAPS.map((map) => map.name),
            cellsPerPurpose: V09_QUALIFICATION_COHORTS.length * V09_QUALIFICATION_MAPS.length,
            seedPairing: "adjacent_scenario_then_combat",
            expectedPairs: plan.length,
            expectedGames: plan.length * 2,
            expectedV08ControlGames: plan.length,
            expectedTotalSimulations: plan.length * 3,
            planSha256: firstReceipt.planSha256,
        },
        metrics: aggregate.metrics,
        baselineMetrics: aggregate.baselineMetrics,
        failures,
        stages: aggregate.stages,
        cells: aggregate.cells,
        totals: aggregate.totals,
        execution: {
            measurementScope: "node_local",
            runnerSourceSha256: firstReceipt.runnerSourceSha256,
            sourceIdentityReceiptSha256: firstReceipt.sourceIdentityReceiptSha256,
            p99ModelMs: mergedModelP99Ms,
            p99TurnMs: mergedTurnP99Ms,
            rssIncreaseMiB: mergedRssIncreaseMiB,
            nodes: [...shardReceipts]
                .sort((left, right) => left.shardIndex - right.shardIndex)
                .map((receipt) => ({
                    shardCount: receipt.shardCount,
                    shardIndex: receipt.shardIndex,
                    nodeRole: receipt.nodeRole,
                    executionFingerprint: receipt.executionFingerprint,
                    modelP99Ms: receipt.modelP99Ms,
                    turnP99Ms: receipt.turnP99Ms,
                    rssIncreaseMiB: receipt.rssIncreaseMiB,
                    journalSha256: receipt.journalSha256,
                    shardReceiptSha256: receipt.receiptSha256,
                })),
            productionCpuQualification: {
                required: true,
                satisfied: productionCpuP99TurnMs !== null,
                p99TurnMs: productionCpuP99TurnMs,
                thresholdExclusiveMs: 20,
                command: PRODUCTION_CPU_QUALIFICATION_COMMAND,
            },
        },
        promotionReceiptInputs: {
            ...receiptUnsigned,
            receiptInputsSha256: fingerprintV09(receiptUnsigned),
        },
        journalSha256,
        failuresSha256,
        qualifiedAt,
        completedAt,
    };
    return { ...unsigned, summarySha256: fingerprintV09(unsigned) };
}

export function validateV09QualificationSummary(summary: IV09QualificationSummary): void {
    if (
        !summary ||
        typeof summary !== "object" ||
        !summary.source ||
        typeof summary.source !== "object" ||
        !summary.plan ||
        typeof summary.plan !== "object" ||
        !summary.baselineMetrics ||
        typeof summary.baselineMetrics !== "object" ||
        !summary.totals ||
        typeof summary.totals !== "object" ||
        !summary.execution ||
        typeof summary.execution !== "object" ||
        !summary.execution.productionCpuQualification ||
        typeof summary.execution.productionCpuQualification !== "object" ||
        !summary.promotionReceiptInputs ||
        typeof summary.promotionReceiptInputs !== "object" ||
        !Array.isArray(summary.failures) ||
        !Array.isArray(summary.stages) ||
        !Array.isArray(summary.cells) ||
        !Array.isArray(summary.execution.nodes) ||
        !Array.isArray(summary.promotionReceiptInputs.failures) ||
        !Array.isArray(summary.promotionReceiptInputs.nodeRoles)
    ) {
        throw new Error("v0.9 qualification summary is missing required structure");
    }
    validateV09QualificationMetrics(summary.metrics);
    integer(summary.baselineMetrics.invalidActions, "qualification.baselineMetrics.invalidActions");
    integer(summary.combinedGames, "qualification.combinedGames", 1);
    integer(summary.confirmationGames, "qualification.confirmationGames", 1);
    integer(summary.qualificationGames, "qualification.qualificationGames", 1);
    integer(summary.plan.expectedPairs, "qualification.plan.expectedPairs", 1);
    integer(summary.plan.expectedGames, "qualification.plan.expectedGames", 1);
    integer(summary.plan.expectedV08ControlGames, "qualification.plan.expectedV08ControlGames", 1);
    integer(summary.plan.expectedTotalSimulations, "qualification.plan.expectedTotalSimulations", 1);
    integer(summary.plan.cellsPerPurpose, "qualification.plan.cellsPerPurpose", 1);
    for (const [name, value] of Object.entries(summary.totals)) {
        integer(value, `qualification.totals.${name}`);
    }
    for (const [name, value] of [
        ["execution.p99ModelMs", summary.execution.p99ModelMs],
        ["execution.p99TurnMs", summary.execution.p99TurnMs],
        ["execution.rssIncreaseMiB", summary.execution.rssIncreaseMiB],
    ] as const) {
        if (!Number.isFinite(value) || value < 0) throw new Error(`qualification.${name} must be non-negative`);
    }
    const productionP99 = summary.execution.productionCpuQualification.p99TurnMs;
    if (productionP99 !== null && (!Number.isFinite(productionP99) || productionP99 < 0)) {
        throw new Error("qualification production CPU p99 must be null or finite and non-negative");
    }
    requireIsoInstant(summary.completedAt, "qualification.completedAt");
    if (summary.qualifiedAt !== null) requireIsoInstant(summary.qualifiedAt, "qualification.qualifiedAt");
    const summaryHashes = [
        ["runFingerprint", summary.runFingerprint],
        ["manifestSha256", summary.manifestSha256],
        ["seedLedgerSha256", summary.seedLedgerSha256],
        ["modelSha256", summary.modelSha256],
        ["artifactFileSha256", summary.artifactFileSha256],
        ["researchArtifactSha256", summary.researchArtifactSha256],
        ["rulesSha256", summary.rulesSha256],
        ["rosterSha256", summary.rosterSha256],
        ["plan.planSha256", summary.plan.planSha256],
        ["execution.runnerSourceSha256", summary.execution.runnerSourceSha256],
        ["execution.sourceIdentityReceiptSha256", summary.execution.sourceIdentityReceiptSha256],
        ["journalSha256", summary.journalSha256],
        ["failuresSha256", summary.failuresSha256],
    ] as const;
    for (const [name, value] of summaryHashes) requireSha(value, `qualification.${name}`);
    if (!/^[0-9a-f]{7,64}$/.test(summary.commonCommit)) {
        throw new Error("qualification.commonCommit must be a lowercase Git commit");
    }
    const nodeIndices = new Set<number>();
    for (const [index, node] of summary.execution.nodes.entries()) {
        if (!node || typeof node !== "object") throw new Error(`qualification execution node ${index} is malformed`);
        integer(node.shardCount, `qualification.execution.nodes[${index}].shardCount`, 1);
        integer(node.shardIndex, `qualification.execution.nodes[${index}].shardIndex`);
        if (
            node.shardCount !== summary.execution.nodes.length ||
            node.shardIndex >= node.shardCount ||
            nodeIndices.has(node.shardIndex) ||
            !V09_QUALIFICATION_NODE_ROLES.includes(node.nodeRole)
        ) {
            throw new Error("qualification execution nodes are incomplete, duplicated, or malformed");
        }
        nodeIndices.add(node.shardIndex);
        for (const [name, value] of [
            ["modelP99Ms", node.modelP99Ms],
            ["turnP99Ms", node.turnP99Ms],
            ["rssIncreaseMiB", node.rssIncreaseMiB],
        ] as const) {
            if (!Number.isFinite(value) || value < 0) {
                throw new Error(`qualification.execution.nodes[${index}].${name} must be non-negative`);
            }
        }
        requireSha(node.executionFingerprint, `qualification.execution.nodes[${index}].executionFingerprint`);
        requireSha(node.journalSha256, `qualification.execution.nodes[${index}].journalSha256`);
        requireSha(node.shardReceiptSha256, `qualification.execution.nodes[${index}].shardReceiptSha256`);
    }
    if (!summary.execution.nodes.length) throw new Error("qualification summary has no execution nodes");
    const { summarySha256, ...unsigned } = summary;
    const { receiptInputsSha256, ...receiptUnsigned } = summary.promotionReceiptInputs;
    const productionNodes = summary.execution.nodes.filter((node) => node.nodeRole === "production_cpu");
    const nodeRoles = [...new Set(summary.execution.nodes.map((node) => node.nodeRole))].sort();
    const stageByPurpose = new Map(summary.stages.map((stage) => [stage.purpose, stage]));
    const confirmation = stageByPurpose.get("confirmation");
    const qualification = stageByPurpose.get("qualification");
    const tallyIsValid = (tally: IV09QualificationStageSummary | IV09QualificationCellSummary): boolean =>
        Number.isSafeInteger(tally.games) &&
        tally.games >= 0 &&
        Number.isSafeInteger(tally.v09Wins) &&
        tally.v09Wins >= 0 &&
        Number.isSafeInteger(tally.v08Wins) &&
        tally.v08Wins >= 0 &&
        Number.isSafeInteger(tally.draws) &&
        tally.draws >= 0 &&
        tally.games === tally.v09Wins + tally.v08Wins + tally.draws &&
        Number.isFinite(tally.score) &&
        tally.score === roundMetric((tally.v09Wins + 0.5 * tally.draws) / Math.max(1, tally.games));
    const totals = summary.totals;
    const expectedFailures = finalQualificationFailures(
        summary.metrics,
        summary.execution.productionCpuQualification.p99TurnMs,
        summary.baselineMetrics.invalidActions,
    );
    const productionModelP99 = productionNodes.length
        ? Math.max(...productionNodes.map((node) => node.modelP99Ms))
        : null;
    const productionRss = productionNodes.length
        ? Math.max(...productionNodes.map((node) => node.rssIncreaseMiB))
        : null;
    if (
        summary.schema !== V09_QUALIFICATION_SCHEMA ||
        !["qualified_offline", "failed"].includes(summary.status) ||
        summary.promoted !== false ||
        fingerprintV09(unsigned) !== requireSha(summarySha256, "qualification.summarySha256") ||
        summary.failures.join("\n") !== expectedFailures.join("\n") ||
        fingerprintV09(receiptUnsigned) !== requireSha(receiptInputsSha256, "qualification.receiptInputsSha256") ||
        summary.failuresSha256 !== fingerprintV09(summary.failures) ||
        summary.status !== (expectedFailures.length ? "failed" : "qualified_offline") ||
        summary.researchArtifactSha256 !== summary.artifactFileSha256 ||
        summary.trainingRunId !== summary.source.trainingRunId ||
        summary.commonCommit !== summary.source.commonCommit ||
        summary.rulesSha256 !== summary.source.rulesSha256 ||
        summary.rosterSha256 !== summary.source.rosterSha256 ||
        summary.combinedGames !== summary.metrics.combinedGames ||
        summary.confirmationGames !== summary.metrics.confirmationGames ||
        summary.qualificationGames !== summary.metrics.qualificationGames ||
        summary.combinedGames !== summary.confirmationGames + summary.qualificationGames ||
        summary.combinedGames !== totals.v09Wins + totals.v08Wins + totals.draws ||
        summary.metrics.combinedScore !==
            roundMetric((totals.v09Wins + 0.5 * totals.draws) / Math.max(1, summary.combinedGames)) ||
        summary.metrics.lower95 !==
            roundMetric(v09WilsonLower95(totals.v09Wins, totals.draws, summary.combinedGames)) ||
        summary.metrics.armageddonRate !== roundMetric(totals.armageddonGames / Math.max(1, summary.combinedGames)) ||
        summary.metrics.v08ArmageddonRate !==
            roundMetric(totals.v08ControlArmageddonGames / Math.max(1, totals.v08ControlGames)) ||
        summary.metrics.invalidActions !==
            totals.rejectedV09 +
                totals.runtimeFallbacks +
                totals.telemetryMismatches +
                totals.invalidModelTelemetryEvents +
                totals.instrumentationFailures ||
        summary.metrics.avoidablePassiveActions !== totals.avoidablePassiveActions ||
        summary.baselineMetrics.invalidActions !== totals.rejectedV08 + totals.rejectedV08Control ||
        totals.armageddonWhenV09Green + totals.armageddonWhenV09Red !== totals.armageddonGames ||
        totals.armageddonGames > summary.combinedGames ||
        totals.armageddonDecidedGames > totals.armageddonGames ||
        totals.v08ControlArmageddonGames > totals.v08ControlGames ||
        totals.v08ControlArmageddonDecidedGames > totals.v08ControlArmageddonGames ||
        totals.v09PolicyDecisions !== totals.v09PolicyEvents ||
        totals.v09PolicyDecisions !== totals.v09ServerPreflightTimings ||
        totals.v09PolicyDecisions !== totals.latencySamples ||
        summary.plan.expectedPairs * 2 !== summary.plan.expectedGames ||
        summary.plan.expectedPairs !== summary.plan.expectedV08ControlGames ||
        summary.plan.expectedPairs * 3 !== summary.plan.expectedTotalSimulations ||
        summary.plan.expectedGames !== summary.combinedGames ||
        summary.plan.expectedV08ControlGames !== totals.v08ControlGames ||
        !confirmation ||
        !qualification ||
        stageByPurpose.size !== V09_QUALIFICATION_PURPOSES.length ||
        !summary.stages.every(tallyIsValid) ||
        !summary.cells.length ||
        !summary.cells.every(tallyIsValid) ||
        confirmation.games !== summary.confirmationGames ||
        qualification.games !== summary.qualificationGames ||
        confirmation.score !== summary.metrics.confirmationScore ||
        qualification.score !== summary.metrics.qualificationScore ||
        roundMetric(Math.min(...summary.cells.map((cell) => cell.score))) !== summary.metrics.minimumCellScore ||
        summary.qualifiedAt !== (summary.status === "qualified_offline" ? summary.completedAt : null) ||
        summary.execution.measurementScope !== "node_local" ||
        summary.execution.p99ModelMs !== Math.max(...summary.execution.nodes.map((node) => node.modelP99Ms)) ||
        summary.execution.rssIncreaseMiB !== Math.max(...summary.execution.nodes.map((node) => node.rssIncreaseMiB)) ||
        summary.execution.productionCpuQualification.satisfied !== productionNodes.length > 0 ||
        summary.execution.productionCpuQualification.required !== true ||
        summary.execution.productionCpuQualification.thresholdExclusiveMs !== 20 ||
        summary.execution.productionCpuQualification.command !== PRODUCTION_CPU_QUALIFICATION_COMMAND ||
        (productionNodes.length > 0 &&
            summary.execution.productionCpuQualification.p99TurnMs !== summary.metrics.p99TurnMs) ||
        (productionNodes.length > 0 && summary.metrics.p99ModelMs !== productionModelP99) ||
        (productionNodes.length > 0 && summary.metrics.rssIncreaseMiB !== productionRss) ||
        (productionNodes.length === 0 && summary.execution.productionCpuQualification.p99TurnMs !== null) ||
        summary.promotionReceiptInputs.schema !== "hoc.ai.v0_9_qualification_receipt_inputs.v2" ||
        summary.promotionReceiptInputs.qualificationSummarySchema !== V09_QUALIFICATION_SCHEMA ||
        summary.promotionReceiptInputs.armageddonMetric !== "reached_armageddon_lap" ||
        summary.promotionReceiptInputs.qualificationStatus !== summary.status ||
        summary.promotionReceiptInputs.eligible !== (summary.status === "qualified_offline") ||
        summary.promotionReceiptInputs.modelId !== summary.modelId ||
        summary.promotionReceiptInputs.modelSha256 !== summary.modelSha256 ||
        summary.promotionReceiptInputs.researchArtifactSha256 !== summary.researchArtifactSha256 ||
        summary.promotionReceiptInputs.trainingRunId !== summary.trainingRunId ||
        summary.promotionReceiptInputs.commonCommit !== summary.commonCommit ||
        summary.promotionReceiptInputs.rulesSha256 !== summary.rulesSha256 ||
        summary.promotionReceiptInputs.rosterSha256 !== summary.rosterSha256 ||
        summary.promotionReceiptInputs.runFingerprint !== summary.runFingerprint ||
        summary.promotionReceiptInputs.sourceCommit !== summary.commonCommit ||
        summary.promotionReceiptInputs.rulesFingerprint !== summary.rulesSha256 ||
        summary.promotionReceiptInputs.rosterFingerprint !== summary.rosterSha256 ||
        summary.promotionReceiptInputs.manifestSha256 !== summary.manifestSha256 ||
        summary.promotionReceiptInputs.seedLedgerSha256 !== summary.seedLedgerSha256 ||
        summary.promotionReceiptInputs.journalSha256 !== summary.journalSha256 ||
        summary.promotionReceiptInputs.planSha256 !== summary.plan.planSha256 ||
        summary.promotionReceiptInputs.runnerSourceSha256 !== summary.execution.runnerSourceSha256 ||
        summary.promotionReceiptInputs.sourceIdentityReceiptSha256 !== summary.execution.sourceIdentityReceiptSha256 ||
        summary.promotionReceiptInputs.confirmationGames !== summary.confirmationGames ||
        summary.promotionReceiptInputs.qualificationGames !== summary.qualificationGames ||
        summary.promotionReceiptInputs.combinedGames !== summary.combinedGames ||
        summary.promotionReceiptInputs.v08ControlGames !== summary.totals.v08ControlGames ||
        summary.promotionReceiptInputs.expectedTotalSimulations !== summary.plan.expectedTotalSimulations ||
        summary.promotionReceiptInputs.completedTotalSimulations !==
            summary.combinedGames + summary.totals.v08ControlGames ||
        summary.promotionReceiptInputs.metricsSha256 !== fingerprintV09(summary.metrics) ||
        summary.promotionReceiptInputs.baselineMetricsSha256 !== fingerprintV09(summary.baselineMetrics) ||
        summary.promotionReceiptInputs.productionCpuP99TurnMs !==
            summary.execution.productionCpuQualification.p99TurnMs ||
        fingerprintV09(summary.promotionReceiptInputs.failures) !== fingerprintV09(summary.failures) ||
        summary.promotionReceiptInputs.failuresSha256 !== summary.failuresSha256 ||
        summary.promotionReceiptInputs.qualifiedAt !== summary.qualifiedAt ||
        fingerprintV09(summary.promotionReceiptInputs.nodeRoles) !== fingerprintV09(nodeRoles)
    ) {
        throw new Error("v0.9 qualification summary identity or gate verdict mismatch");
    }
}

async function runWorkerPool(
    pending: readonly IV09QualificationPlanPair[],
    concurrency: number,
    workerIdentity: IWorkerData,
    onRecord: (record: IV09QualificationPairRecord) => void,
): Promise<void> {
    if (!pending.length) return;
    const poolSize = Math.min(pending.length, Math.max(1, Math.floor(concurrency)));
    const workers: Worker[] = [];
    let dispatched = 0;
    let completed = 0;
    let settled = false;
    await new Promise<void>((resolvePromise, rejectPromise) => {
        const cleanup = (): void => {
            for (const worker of workers) void worker.terminate();
        };
        const fail = (error: unknown): void => {
            if (settled) return;
            settled = true;
            cleanup();
            rejectPromise(error instanceof Error ? error : new Error(String(error)));
        };
        const dispatch = (worker: Worker): void => {
            const pair = pending[dispatched++];
            if (!pair) {
                worker.postMessage({ type: "stop" } satisfies WorkerRequest);
                return;
            }
            worker.postMessage({ type: "pair", pair } satisfies WorkerRequest);
        };
        for (let index = 0; index < poolSize; index += 1) {
            const worker = new Worker(new URL("./qualify.ts", import.meta.url), {
                workerData: workerIdentity,
                env: qualificationWorkerEnvironment(),
            });
            workers.push(worker);
            worker.on("message", (message: WorkerResponse) => {
                if (settled) return;
                if (message.type === "ready") {
                    dispatch(worker);
                    return;
                }
                if (message.type === "error") {
                    fail(new Error(`${message.pairId ?? "worker startup"}: ${message.error}`));
                    return;
                }
                try {
                    onRecord(message.record);
                } catch (error) {
                    fail(error);
                    return;
                }
                completed += 1;
                if (completed === pending.length) {
                    settled = true;
                    cleanup();
                    resolvePromise();
                    return;
                }
                dispatch(worker);
            });
            worker.on("error", fail);
            worker.on("exit", (code) => {
                if (!settled && code !== 0) fail(new Error(`v0.9 qualification worker exited with code ${code}`));
            });
        }
    });
}

function startQualificationWorker(data: IWorkerData): void {
    if (!parentPort) throw new Error("v0.9 qualification worker requires parentPort");
    try {
        verifyV09ResearchArtifact(data.artifact);
        requireSha(data.runFingerprint, "worker.runFingerprint");
        requireSha(data.manifestSha256, "worker.manifestSha256");
    } catch (error) {
        parentPort.postMessage({
            type: "error",
            pairId: null,
            error: error instanceof Error ? error.message : String(error),
        } satisfies WorkerResponse);
        return;
    }
    parentPort.on("message", (message: WorkerRequest) => {
        if (message.type === "stop") {
            parentPort!.close();
            return;
        }
        try {
            parentPort!.postMessage({
                type: "result",
                record: runV09QualificationPair(message.pair, data.artifact, data.runFingerprint, data.manifestSha256),
            } satisfies WorkerResponse);
        } catch (error) {
            parentPort!.postMessage({
                type: "error",
                pairId: message.pair.id,
                error: error instanceof Error ? `${error.stack ?? error.message}` : String(error),
            } satisfies WorkerResponse);
        }
    });
    parentPort.postMessage({ type: "ready" } satisfies WorkerResponse);
}

interface ICliArgs {
    mode: "run" | "merge";
    campaignDirectory: string;
    artifactPath: string;
    expectedModelSha256: string;
    outputDirectory: string;
    nodeRole: V09QualificationNodeRole | null;
    concurrency: number;
    limitPairs: number | null;
    shardCount: number;
    shardIndex: number;
    mergeShardDirectories: string[];
    smoke: boolean;
}

function cliArgs(): ICliArgs {
    const { values } = parseArgs({
        args: Bun.argv.slice(2),
        options: {
            campaign: { type: "string" },
            artifact: { type: "string" },
            "expected-model-sha256": { type: "string" },
            out: { type: "string" },
            "node-role": { type: "string" },
            concurrency: { type: "string" },
            "limit-pairs": { type: "string" },
            "shard-count": { type: "string" },
            "shard-index": { type: "string" },
            "merge-shard-dir": { type: "string", multiple: true },
            smoke: { type: "boolean", default: false },
        },
        strict: true,
    });
    if (!values.campaign || !values.artifact || !values["expected-model-sha256"] || !values.out) {
        throw new Error(
            "usage: bun qualify.ts --campaign <dir> --artifact <research.json> " +
                "--expected-model-sha256 <sha256> --out <dir> --node-role " +
                "development_smoke|training_host|production_cpu [--shard-count <n> --shard-index <i>] " +
                "[--concurrency <n>] [--limit-pairs <n>] | --merge-shard-dir <dir> ...",
        );
    }
    const mergeShardDirectories = (values["merge-shard-dir"] ?? []).map((path) => resolve(path));
    const mode = mergeShardDirectories.length ? "merge" : "run";
    if (
        mode === "run" &&
        (!values["node-role"] || !(V09_QUALIFICATION_NODE_ROLES as readonly string[]).includes(values["node-role"]))
    ) {
        throw new Error(`node-role must be one of ${V09_QUALIFICATION_NODE_ROLES.join(", ")}`);
    }
    const concurrency = Number(values.concurrency ?? Math.min(20, availableParallelism()));
    const limitPairs = values["limit-pairs"] === undefined ? null : Number(values["limit-pairs"]);
    const shardCount = Number(values["shard-count"] ?? 1);
    const shardIndex = Number(values["shard-index"] ?? 0);
    if (
        !Number.isSafeInteger(concurrency) ||
        concurrency < 1 ||
        concurrency > 64 ||
        (limitPairs !== null && (!Number.isSafeInteger(limitPairs) || limitPairs < 1)) ||
        !Number.isSafeInteger(shardCount) ||
        shardCount < 1 ||
        shardCount > 256 ||
        !Number.isSafeInteger(shardIndex) ||
        shardIndex < 0 ||
        shardIndex >= shardCount
    ) {
        throw new Error("concurrency must be 1..64 and limit-pairs must be a positive integer");
    }
    if (
        mode === "merge" &&
        (values["node-role"] || values["limit-pairs"] || values["shard-count"] || values["shard-index"])
    ) {
        throw new Error("merge does not accept run-only options");
    }
    return {
        mode,
        campaignDirectory: resolve(values.campaign),
        artifactPath: resolve(values.artifact),
        expectedModelSha256: requireSha(values["expected-model-sha256"], "expected-model-sha256"),
        outputDirectory: resolve(values.out),
        nodeRole: mode === "run" ? (values["node-role"] as V09QualificationNodeRole) : null,
        concurrency,
        limitPairs,
        shardCount,
        shardIndex,
        mergeShardDirectories,
        smoke: values.smoke,
    };
}

interface IQualificationInputs {
    manifest: IV09CampaignManifest;
    ledger: IV09SeedLedger;
    artifact: IV09ModelArtifact;
    artifactFileSha256: string;
    checkout: IV09SourceIdentityReceipt;
    plan: IV09QualificationPlanPair[];
}

function loadQualificationInputs(args: ICliArgs): IQualificationInputs {
    const manifest = JSON.parse(
        readFileSync(resolve(args.campaignDirectory, "manifest.json"), "utf8"),
    ) as IV09CampaignManifest;
    const ledger = JSON.parse(
        readFileSync(resolve(args.campaignDirectory, "seed-ledger.json"), "utf8"),
    ) as IV09SeedLedger;
    const artifactBytes = readFileSync(args.artifactPath);
    const artifactFileSha256 = sha256(artifactBytes);
    const artifact = JSON.parse(artifactBytes.toString("utf8")) as IV09ModelArtifact;
    verifyV09QualificationInputs(
        manifest,
        ledger,
        artifact,
        args.expectedModelSha256,
        args.campaignDirectory,
        !args.smoke,
    );
    const checkout = verifyCurrentQualificationCheckout(
        manifest,
        resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."),
    );
    createV09OfflineResearchStrategy(artifact);
    return {
        manifest,
        ledger,
        artifact,
        artifactFileSha256,
        checkout,
        plan: buildV09QualificationPlan(ledger),
    };
}

export function validateV09QualificationShardCoverage(
    plan: readonly IV09QualificationPlanPair[],
    receipts: readonly IV09QualificationShardReceipt[],
): void {
    if (!receipts.length) throw new Error("qualification merge requires at least one shard receipt");
    const shardCount = receipts[0]!.shardCount;
    if (shardCount !== receipts.length) {
        throw new Error(`qualification merge requires exactly ${shardCount} shard receipts`);
    }
    const seen = new Set<number>();
    for (const receipt of receipts) {
        validateV09QualificationShardReceipt(receipt);
        if (receipt.shardCount !== shardCount || seen.has(receipt.shardIndex)) {
            throw new Error("qualification shard receipts overlap or disagree on shardCount");
        }
        seen.add(receipt.shardIndex);
        const shardPlan = partitionV09QualificationPlan(plan, receipt.shardIndex, shardCount);
        if (
            receipt.planSha256 !== fingerprintV09(plan) ||
            receipt.shardPlanSha256 !== fingerprintV09(shardPlan) ||
            receipt.expectedPairs !== shardPlan.length
        ) {
            throw new Error(`qualification shard ${receipt.shardIndex} does not match its exact ordinal plan`);
        }
    }
    for (let shardIndex = 0; shardIndex < shardCount; shardIndex += 1) {
        if (!seen.has(shardIndex)) throw new Error(`qualification merge is missing shard ${shardIndex}`);
    }
}

function validateExactShardReceipt(
    receipt: IV09QualificationShardReceipt,
    inputs: Pick<IQualificationInputs, "manifest" | "ledger" | "artifact" | "artifactFileSha256">,
    header: IV09QualificationJournalHeader,
    records: readonly IV09QualificationPairRecord[],
    journalPath: string,
): void {
    validateV09QualificationShardReceipt(receipt);
    const expected = buildShardReceipt(
        inputs.manifest,
        inputs.ledger,
        inputs.artifact,
        inputs.artifactFileSha256,
        header,
        records,
        journalPath,
        receipt.completedAt,
    );
    if (fingerprintV09(expected) !== fingerprintV09(receipt)) {
        throw new Error(`qualification shard ${receipt.shardIndex} receipt does not match its raw journal`);
    }
}

export interface IV09QualificationEvidenceValidationInputs {
    readonly summary: IV09QualificationSummary;
    readonly shardDirectories: readonly string[];
    readonly manifest: IV09CampaignManifest;
    readonly ledger: IV09SeedLedger;
    readonly artifact: IV09ModelArtifact;
    readonly artifactFileSha256: string;
    readonly sourceIdentityReceiptSha256: string;
    /** Test-only smoke evidence may use reduced streams/cell coverage; promotion must leave this false. */
    readonly allowSmokeCoverage?: boolean;
}

export interface IV09QualificationRawSummaryInputs {
    readonly manifest: IV09CampaignManifest;
    readonly ledger: IV09SeedLedger;
    readonly artifact: IV09ModelArtifact;
    readonly artifactFileSha256: string;
    readonly shardReceipts: readonly IV09QualificationShardReceipt[];
    readonly records: readonly IV09QualificationPairRecord[];
    readonly allowSmokeCoverage?: boolean;
}

/**
 * Deterministically rebuild a summary from already-authenticated raw records and receipts. Callers that
 * make a trust decision must use validateV09QualificationEvidence, which authenticates the journal bytes
 * first; this pure seam exists so merge tooling and tests can independently verify canonical aggregation.
 */
export function rebuildV09QualificationSummaryFromRawRecords(
    inputs: IV09QualificationRawSummaryInputs,
): IV09QualificationSummary {
    const artifactFileSha256 = requireSha(inputs.artifactFileSha256, "qualification artifactFileSha256");
    verifyV09QualificationInputs(
        inputs.manifest,
        inputs.ledger,
        inputs.artifact,
        inputs.artifact.modelSha256!,
        inputs.manifest.outputDirectory,
        !inputs.allowSmokeCoverage,
    );
    const plan = buildV09QualificationPlan(inputs.ledger);
    validateV09QualificationShardCoverage(plan, inputs.shardReceipts);
    const firstReceipt = inputs.shardReceipts[0]!;
    for (const receipt of inputs.shardReceipts) {
        if (
            receipt.runFingerprint !== inputs.manifest.runFingerprint ||
            receipt.manifestSha256 !== inputs.manifest.manifestSha256 ||
            receipt.seedLedgerSha256 !== inputs.ledger.ledgerSha256 ||
            receipt.modelSha256 !== inputs.artifact.modelSha256 ||
            receipt.researchArtifactSha256 !== artifactFileSha256 ||
            receipt.runnerSourceSha256 !== firstReceipt.runnerSourceSha256 ||
            receipt.sourceIdentityReceiptSha256 !== firstReceipt.sourceIdentityReceiptSha256 ||
            receipt.behaviorEnvironmentSha256 !== firstReceipt.behaviorEnvironmentSha256
        ) {
            throw new Error(`qualification shard ${receipt.shardIndex} has inconsistent campaign identity`);
        }
    }
    const recordById = new Map<string, IV09QualificationPairRecord>();
    for (const record of inputs.records) {
        const pair = plan.find((candidate) => candidate.id === record.id);
        if (!pair) throw new Error(`qualification raw records contain unregistered pair ${record.id}`);
        validatePairRecord(record, pair, inputs.manifest, inputs.artifact.modelSha256!);
        if (recordById.has(record.id)) throw new Error(`qualification raw records duplicate pair ${record.id}`);
        recordById.set(record.id, record);
    }
    if (recordById.size !== plan.length || plan.some((pair) => !recordById.has(pair.id))) {
        throw new Error("qualification raw records do not exactly cover the registered plan");
    }
    return buildSummary(
        inputs.manifest,
        inputs.ledger,
        inputs.artifact,
        artifactFileSha256,
        plan,
        inputs.shardReceipts,
        plan.map((pair) => recordById.get(pair.id)!),
        inputs.allowSmokeCoverage ?? false,
    );
}

export function validateV09QualificationSummaryAgainstRawRecords(
    summary: IV09QualificationSummary,
    inputs: IV09QualificationRawSummaryInputs,
): IV09QualificationSummary {
    const canonical = rebuildV09QualificationSummaryFromRawRecords(inputs);
    validateV09QualificationSummary(canonical);
    validateV09QualificationSummary(summary);
    if (fingerprintV09(summary) !== fingerprintV09(canonical)) {
        throw new Error("qualification summary does not equal the verdict recomputed from raw v2 journals");
    }
    return canonical;
}

/**
 * Rebuild the entire qualification verdict from immutable v2 journals and shard receipts. A self-consistent
 * summary hash is not evidence: every gate input, production timing, node statistic, and receipt-input field
 * must exactly equal the canonical summary derived here from raw pair records.
 */
export function validateV09QualificationEvidence(
    inputs: IV09QualificationEvidenceValidationInputs,
): IV09QualificationSummary {
    const artifactFileSha256 = requireSha(inputs.artifactFileSha256, "qualification artifactFileSha256");
    const sourceIdentityReceiptSha256 = requireSha(
        inputs.sourceIdentityReceiptSha256,
        "qualification sourceIdentityReceiptSha256",
    );
    verifyV09QualificationInputs(
        inputs.manifest,
        inputs.ledger,
        inputs.artifact,
        inputs.artifact.modelSha256!,
        inputs.manifest.outputDirectory,
        !inputs.allowSmokeCoverage,
    );
    const plan = buildV09QualificationPlan(inputs.ledger);
    const entries = inputs.shardDirectories.map((directory) => {
        const resolvedDirectory = resolve(directory);
        const receiptPath = resolve(resolvedDirectory, "qualification-shard-receipt.json");
        const journalPath = resolve(resolvedDirectory, "qualification-pairs.jsonl");
        if (!existsSync(receiptPath) || !existsSync(journalPath)) {
            throw new Error(`qualification evidence is missing a receipt or journal in ${resolvedDirectory}`);
        }
        const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as IV09QualificationShardReceipt;
        validateV09QualificationShardReceipt(receipt);
        if (receipt.journalSha256 !== sha256(readFileSync(journalPath))) {
            throw new Error(`qualification shard ${receipt.shardIndex} journal bytes do not match its receipt`);
        }
        return { receipt, journalPath };
    });
    validateV09QualificationShardCoverage(
        plan,
        entries.map(({ receipt }) => receipt),
    );
    const byIndex = new Map(entries.map((entry) => [entry.receipt.shardIndex, entry]));
    const records = new Map<string, IV09QualificationPairRecord>();
    const receipts: IV09QualificationShardReceipt[] = [];
    for (let shardIndex = 0; shardIndex < entries.length; shardIndex += 1) {
        const entry = byIndex.get(shardIndex);
        if (!entry) throw new Error(`qualification evidence is missing shard ${shardIndex}`);
        const shardPlan = partitionV09QualificationPlan(plan, shardIndex, entries.length);
        const journal = loadJournal(
            entry.journalPath,
            inputs.manifest,
            inputs.ledger,
            inputs.artifact,
            artifactFileSha256,
            plan,
            shardPlan,
            shardIndex,
            entries.length,
            0,
            null,
            sourceIdentityReceiptSha256,
            false,
            false,
            false,
        );
        if (journal.records.size !== shardPlan.length) {
            throw new Error(`qualification evidence shard ${shardIndex} is missing raw pair records`);
        }
        const orderedShardRecords = shardPlan.map((pair) => journal.records.get(pair.id)!);
        validateExactShardReceipt(
            entry.receipt,
            {
                manifest: inputs.manifest,
                ledger: inputs.ledger,
                artifact: inputs.artifact,
                artifactFileSha256,
            },
            journal.header,
            orderedShardRecords,
            entry.journalPath,
        );
        receipts.push(entry.receipt);
        for (const record of orderedShardRecords) {
            if (records.has(record.id)) throw new Error(`qualification evidence duplicates pair ${record.id}`);
            records.set(record.id, record);
        }
    }
    if (records.size !== plan.length || plan.some((pair) => !records.has(pair.id))) {
        throw new Error("qualification evidence has missing or overlapping global pair ordinals");
    }
    return validateV09QualificationSummaryAgainstRawRecords(inputs.summary, {
        manifest: inputs.manifest,
        ledger: inputs.ledger,
        artifact: inputs.artifact,
        artifactFileSha256,
        shardReceipts: receipts,
        records: plan.map((pair) => records.get(pair.id)!),
        allowSmokeCoverage: inputs.allowSmokeCoverage,
    });
}

function writeOrValidateSummary(path: string, candidate: IV09QualificationSummary): IV09QualificationSummary {
    if (!existsSync(path)) {
        atomicImmutableJson(path, candidate);
        return candidate;
    }
    const existing = JSON.parse(readFileSync(path, "utf8")) as IV09QualificationSummary;
    validateV09QualificationSummary(existing);
    if (fingerprintV09(existing) !== fingerprintV09(candidate)) {
        throw new Error("existing immutable qualification summary does not match exact merged inputs");
    }
    return existing;
}

async function runQualificationShard(
    args: ICliArgs,
    inputs: IQualificationInputs,
    rssBeforeArtifact: number,
): Promise<void> {
    const nodeRole = args.nodeRole!;
    const shardPlan = partitionV09QualificationPlan(inputs.plan, args.shardIndex, args.shardCount);
    if (!shardPlan.length) throw new Error("qualification shard has no registered pair ordinals");
    const journalPath = resolve(args.outputDirectory, "qualification-pairs.jsonl");
    const receiptPath = resolve(args.outputDirectory, "qualification-shard-receipt.json");
    const journal = loadJournal(
        journalPath,
        inputs.manifest,
        inputs.ledger,
        inputs.artifact,
        inputs.artifactFileSha256,
        inputs.plan,
        shardPlan,
        args.shardIndex,
        args.shardCount,
        rssBeforeArtifact,
        nodeRole,
        inputs.checkout.receiptSha256,
    );
    const planById = new Map(shardPlan.map((pair) => [pair.id, pair]));
    const allPending = shardPlan.filter((pair) => !journal.records.has(pair.id));
    const pending = args.limitPairs === null ? allPending : allPending.slice(0, args.limitPairs);
    let newlyCompleted = 0;
    const workStartedAt = performance.now();
    await runWorkerPool(
        pending,
        args.concurrency,
        {
            kind: "v0.9-qualification-worker",
            artifact: inputs.artifact,
            runFingerprint: inputs.manifest.runFingerprint,
            manifestSha256: inputs.manifest.manifestSha256,
        },
        (record) => {
            const expected = planById.get(record.id);
            if (!expected) throw new Error(`worker emitted unregistered pair ${record.id}`);
            validatePairRecord(record, expected, inputs.manifest, inputs.artifact.modelSha256!);
            if (journal.records.has(record.id)) throw new Error(`worker duplicated completed pair ${record.id}`);
            appendDurableJournalRecord(journalPath, record);
            journal.records.set(record.id, record);
            newlyCompleted += 1;
            if (newlyCompleted % 100 === 0) {
                const elapsedSeconds = Math.max(0.001, (performance.now() - workStartedAt) / 1000);
                const simulationsPerSecond = (newlyCompleted * 3) / elapsedSeconds;
                const completedSimulations = journal.records.size * 3;
                process.stdout.write(
                    `${JSON.stringify({
                        status: "running-shard",
                        shardIndex: args.shardIndex,
                        shardCount: args.shardCount,
                        completedPairs: journal.records.size,
                        expectedShardPairs: shardPlan.length,
                        completedSimulations,
                        expectedShardSimulations: shardPlan.length * 3,
                        expectedGlobalSimulations: inputs.plan.length * 3,
                        simulationsPerSecond: roundMetric(simulationsPerSecond),
                        estimatedRemainingSeconds: Math.ceil(
                            (shardPlan.length * 3 - completedSimulations) / simulationsPerSecond,
                        ),
                    })}\n`,
                );
            }
        },
    );
    if (journal.records.size !== shardPlan.length) {
        process.stdout.write(
            `${JSON.stringify({
                status: "resumable-incomplete-shard",
                shardIndex: args.shardIndex,
                shardCount: args.shardCount,
                newlyCompletedPairs: newlyCompleted,
                completedPairs: journal.records.size,
                expectedShardPairs: shardPlan.length,
                newlyCompletedSimulations: newlyCompleted * 3,
                completedSimulations: journal.records.size * 3,
                expectedShardSimulations: shardPlan.length * 3,
                expectedGlobalSimulations: inputs.plan.length * 3,
                journal: journalPath,
            })}\n`,
        );
        return;
    }
    const orderedRecords = shardPlan.map((pair) => journal.records.get(pair.id)!);
    let receipt: IV09QualificationShardReceipt;
    if (existsSync(receiptPath)) {
        receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as IV09QualificationShardReceipt;
        validateExactShardReceipt(receipt, inputs, journal.header, orderedRecords, journalPath);
    } else {
        receipt = buildShardReceipt(
            inputs.manifest,
            inputs.ledger,
            inputs.artifact,
            inputs.artifactFileSha256,
            journal.header,
            orderedRecords,
            journalPath,
        );
        atomicImmutableJson(receiptPath, receipt);
    }
    if (args.shardCount > 1) {
        process.stdout.write(
            `${JSON.stringify({
                status: "complete-nonpromoting-shard",
                shardIndex: args.shardIndex,
                shardCount: args.shardCount,
                pairs: orderedRecords.length,
                simulations: orderedRecords.length * 3,
                receipt: receiptPath,
                merge: "copy each shard directory, then pass every directory via --merge-shard-dir",
            })}\n`,
        );
        return;
    }
    const summaryPath = resolve(args.outputDirectory, "qualification-summary.json");
    const summary = writeOrValidateSummary(
        summaryPath,
        buildSummary(
            inputs.manifest,
            inputs.ledger,
            inputs.artifact,
            inputs.artifactFileSha256,
            inputs.plan,
            [receipt],
            orderedRecords,
            args.smoke,
        ),
    );
    process.stdout.write(
        `${JSON.stringify({
            status: summary.status,
            passed: summary.failures.length === 0,
            metrics: summary.metrics,
            baselineMetrics: summary.baselineMetrics,
            totalSimulations: summary.metrics.combinedGames + summary.totals.v08ControlGames,
            failures: summary.failures,
            summary: summaryPath,
        })}\n`,
    );
}

function mergeQualificationShards(args: ICliArgs, inputs: IQualificationInputs): void {
    const entries = args.mergeShardDirectories.map((directory) => {
        const receiptPath = resolve(directory, "qualification-shard-receipt.json");
        if (!existsSync(receiptPath)) throw new Error(`qualification merge is missing receipt ${receiptPath}`);
        return {
            directory,
            receipt: JSON.parse(readFileSync(receiptPath, "utf8")) as IV09QualificationShardReceipt,
        };
    });
    validateV09QualificationShardCoverage(
        inputs.plan,
        entries.map(({ receipt }) => receipt),
    );
    const byIndex = new Map(entries.map((entry) => [entry.receipt.shardIndex, entry]));
    const records = new Map<string, IV09QualificationPairRecord>();
    const receipts: IV09QualificationShardReceipt[] = [];
    for (let shardIndex = 0; shardIndex < entries.length; shardIndex += 1) {
        const entry = byIndex.get(shardIndex)!;
        const shardPlan = partitionV09QualificationPlan(inputs.plan, shardIndex, entries.length);
        const journalPath = resolve(entry.directory, "qualification-pairs.jsonl");
        const journal = loadJournal(
            journalPath,
            inputs.manifest,
            inputs.ledger,
            inputs.artifact,
            inputs.artifactFileSha256,
            inputs.plan,
            shardPlan,
            shardIndex,
            entries.length,
            process.memoryUsage().rss,
            null,
            inputs.checkout.receiptSha256,
            false,
            false,
        );
        if (journal.records.size !== shardPlan.length) {
            throw new Error(`qualification merge shard ${shardIndex} is missing raw pair records`);
        }
        const orderedShardRecords = shardPlan.map((pair) => journal.records.get(pair.id)!);
        validateExactShardReceipt(entry.receipt, inputs, journal.header, orderedShardRecords, journalPath);
        receipts.push(entry.receipt);
        for (const record of orderedShardRecords) {
            if (records.has(record.id)) throw new Error(`qualification merge has duplicate pair ${record.id}`);
            records.set(record.id, record);
        }
    }
    if (records.size !== inputs.plan.length || inputs.plan.some((pair) => !records.has(pair.id))) {
        throw new Error("qualification merge has missing or overlapping global pair ordinals");
    }
    const orderedRecords = inputs.plan.map((pair) => records.get(pair.id)!);
    const summaryPath = resolve(args.outputDirectory, "qualification-summary.json");
    const summary = writeOrValidateSummary(
        summaryPath,
        buildSummary(
            inputs.manifest,
            inputs.ledger,
            inputs.artifact,
            inputs.artifactFileSha256,
            inputs.plan,
            receipts,
            orderedRecords,
            args.smoke,
        ),
    );
    process.stdout.write(
        `${JSON.stringify({
            status: summary.status,
            passed: summary.failures.length === 0,
            shards: receipts.length,
            combinedGames: summary.combinedGames,
            v08ControlGames: summary.totals.v08ControlGames,
            totalSimulations: summary.combinedGames + summary.totals.v08ControlGames,
            metrics: summary.metrics,
            baselineMetrics: summary.baselineMetrics,
            failures: summary.failures,
            summary: summaryPath,
        })}\n`,
    );
}

async function main(): Promise<void> {
    const args = cliArgs();
    const rssBeforeArtifact = process.memoryUsage().rss;
    const inputs = loadQualificationInputs(args);
    if (args.mode === "merge") {
        mergeQualificationShards(args, inputs);
        return;
    }
    await runQualificationShard(args, inputs, rssBeforeArtifact);
}

if (!isMainThread && (workerData as Partial<IWorkerData> | undefined)?.kind === "v0.9-qualification-worker") {
    startQualificationWorker(workerData as IWorkerData);
}

if (isMainThread && import.meta.main) {
    main().catch((error) => {
        process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
        process.exitCode = 1;
    });
}
