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

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import { reduceSearchAuditJsonl, type ISearchAuditTurnRow } from "./search_audit_reducer";
import { V07_ARCHETYPE_TEMPLATE_NAMES, type V07ArchetypeTemplateName } from "./v0_7_archetype_battery";
import {
    buildV07SelfplayPassiveAuditSeedPlan,
    buildV07SelfplayPassiveAuditShardSpecs,
    fingerprintV07SelfplayPassiveAudit,
    V07_SELFPLAY_PASSIVE_AUDIT_DEFAULT_SEED_KEY,
    v07SelfplayPassiveAuditRunFingerprint,
    type IV07SelfplayPassiveAuditEnvironmentContract,
    type IV07SelfplayPassiveAuditFormalGitAttestation,
    type IV07SelfplayPassiveAuditSeedPlan,
} from "./run_v0_7_selfplay_passive_audit";
import type { IRevisionProvenance } from "./v0_7_acceptance";

const CENSUS_GAMES_PER_TEMPLATE = 12_500;
export const V07_PASSIVE_SHADOW_GAMES_PER_TEMPLATE = 500;
export const V07_PASSIVE_SHADOW_BOOTSTRAP_REPLICATES = 1_000;
const EXPECTED_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const EXPECTED_SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const V07_PASSIVE_SHADOW_METRICS = [
    "validationPositiveRate",
    "validationAtLeastPoint01Rate",
    "meanValidationDelta",
] as const;
export type V07PassiveShadowMetric = (typeof V07_PASSIVE_SHADOW_METRICS)[number];

export interface IV07PassiveShadowGameCluster {
    template: V07ArchetypeTemplateName;
    seed: number;
    validationDeltas: number[];
}

interface IShadowAccumulator {
    games: number;
    gamesWithComparisons: number;
    comparisons: number;
    validationPositive: number;
    validationAtLeastPoint01: number;
    validationDeltaSum: number;
}

export interface IV07PassiveShadowMetricInterval {
    point: number | null;
    confidence95: { low: number; high: number } | null;
}

export interface IV07PassiveShadowBootstrapCohort {
    key: string;
    games: number;
    gamesWithComparisons: number;
    comparisons: number;
    validationPositive: number;
    validationAtLeastPoint01: number;
    metrics: Record<V07PassiveShadowMetric, IV07PassiveShadowMetricInterval>;
}

export interface IV07PassiveShadowBootstrapReport {
    method: "stratified nonparametric whole-game cluster percentile bootstrap";
    samplingUnit: "complete game; all modeled turns from a sampled game move together";
    confidenceLevel: 0.95;
    replicates: number;
    deterministicSeedSha256: string;
    aggregate: IV07PassiveShadowBootstrapCohort;
    byTemplate: IV07PassiveShadowBootstrapCohort[];
}

interface ICensusDimension {
    key: string;
    decisions: number;
    skipTurns: number;
    shieldTurns: number;
    passiveTurns: number;
    skipShare: number;
    shieldShare: number;
    attackAlternativeTurns: number;
    attackAlternativeShareOfPassive: number | null;
    positiveExpectedDamageTurns: number;
    positiveExpectedDamageShareOfPassive: number | null;
    expectedKillTurns: number;
    expectedKillShareOfPassive: number | null;
    directMeleeAlternativeTurns: number;
    moveAssistedMeleeAlternativeTurns: number;
}

export interface IV07PassiveEvidenceReport {
    schemaVersion: 1;
    status: "v0.7_passive_evidence_complete";
    evidenceSemantics: {
        census: string;
        shadow: string;
        conclusionBoundary: string;
    };
    inputs: {
        revisionCommit: string;
        sourceSha256: string;
        censusSummary: { path: string; sha256: string; runFingerprint: string; planSha256: string };
        shadowSummary: { path: string; sha256: string; runFingerprint: string; planSha256: string };
        shadowAudit: { path: string; sha256: string };
    };
    coverage: {
        censusGames: number;
        shadowGames: number;
        shadowComparisons: number;
        duplicateShadowTurnRows: number;
        duplicateShadowGameRows: number;
    };
    legalExpectedValueCensus: {
        aggregate: ICensusDimension;
        byTemplate: ICensusDimension[];
    };
    modelBasedRolloutShadow: {
        protocol: {
            discoveryRollouts: number;
            validationRollouts: number;
            horizon: number;
            discoveryGate: number;
            incumbentKinds: string[];
            challengerKinds: string[];
        };
        observedIncumbentKinds: Record<string, number>;
        selectedAttackKinds: Record<string, number>;
        selectedMeleeRoutes: Record<string, number>;
        discoveryWouldOverride: { yes: number; no: number };
        bootstrap: IV07PassiveShadowBootstrapReport;
    };
    limitations: string[];
}

export interface IV07PassiveEvidenceInput {
    censusSummary: unknown;
    censusSummaryText: string;
    censusPath: string;
    shadowSummary: unknown;
    shadowSummaryText: string;
    shadowSummaryPath: string;
    shadowAuditJsonl: string;
    shadowAuditPath: string;
    bootstrapReplicates?: number;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, context: string): UnknownRecord {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${context} must be an object`);
    }
    return value as UnknownRecord;
}

function child(parent: UnknownRecord, key: string, context: string): UnknownRecord {
    return record(parent[key], `${context}.${key}`);
}

function array(parent: UnknownRecord, key: string, context: string): unknown[] {
    const value = parent[key];
    if (!Array.isArray(value)) throw new Error(`${context}.${key} must be an array`);
    return value;
}

function text(parent: UnknownRecord, key: string, context: string): string {
    const value = parent[key];
    if (typeof value !== "string" || !value) throw new Error(`${context}.${key} must be a non-empty string`);
    return value;
}

function finite(parent: UnknownRecord, key: string, context: string): number {
    const value = parent[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${context}.${key} must be finite`);
    }
    return value;
}

function count(parent: UnknownRecord, key: string, context: string): number {
    const value = finite(parent, key, context);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${context}.${key} must be a non-negative integer`);
    return value;
}

function expectEqual(actual: unknown, expected: unknown, context: string): void {
    if (fingerprintV07SelfplayPassiveAudit(actual) !== fingerprintV07SelfplayPassiveAudit(expected)) {
        throw new Error(`${context} does not match the committed evidence protocol`);
    }
}

function sha256(raw: string): string {
    return createHash("sha256").update(raw).digest("hex");
}

function portablePath(path: string): string {
    const absolute = resolve(path);
    const local = relative(process.cwd(), absolute);
    return local && !local.startsWith("..") ? local : absolute;
}

function validateRevision(summary: UnknownRecord, context: string): { commit: string; sourceSha256: string } {
    if (summary.schemaVersion !== 1 || summary.status !== "v0.7_selfplay_passive_audit_complete") {
        throw new Error(`${context} is not a completed v0.7 self-play passive audit`);
    }
    const revision = child(summary, "revision", context);
    const commit = text(revision, "commit", `${context}.revision`);
    if (!EXPECTED_COMMIT_PATTERN.test(commit)) throw new Error(`${context}.revision.commit is not a full commit hash`);
    if (revision.branch !== "main" || revision.trackedClean !== true || revision.trackedDiffSha256 !== null) {
        throw new Error(`${context} revision must attest a clean main checkout`);
    }
    const sourceSha256 = text(summary, "sourceSha256", context);
    const runFingerprint = text(summary, "runFingerprint", context);
    if (!EXPECTED_SHA256_PATTERN.test(sourceSha256) || !EXPECTED_SHA256_PATTERN.test(runFingerprint)) {
        throw new Error(`${context} source/run fingerprints must be SHA-256 digests`);
    }
    return { commit, sourceSha256 };
}

function validateIntegrity(summary: UnknownRecord, context: string): void {
    const gate = child(summary, "integrityGate", context);
    if (
        gate.status !== "pass" ||
        count(gate, "rejectedActions", `${context}.integrityGate`) !== 0 ||
        count(gate, "recoveryTurns", `${context}.integrityGate`) !== 0 ||
        count(gate, "recoveryDefendTurns", `${context}.integrityGate`) !== 0 ||
        count(gate, "recoveryAdvanceTurns", `${context}.integrityGate`) !== 0 ||
        count(gate, "recoveryFailedTurns", `${context}.integrityGate`) !== 0 ||
        array(gate, "reproSamples", `${context}.integrityGate`).length !== 0
    ) {
        throw new Error(`${context} failed the zero-rejection, zero-recovery integrity gate`);
    }
}

function validateCoverage(summary: UnknownRecord, gamesPerTemplate: number, context: string): void {
    const expectedGames = gamesPerTemplate * V07_ARCHETYPE_TEMPLATE_NAMES.length;
    const coverage = child(summary, "coverage", context);
    if (
        count(coverage, "expectedGames", `${context}.coverage`) !== expectedGames ||
        count(coverage, "reducedGames", `${context}.coverage`) !== expectedGames ||
        count(coverage, "uniqueSeeds", `${context}.coverage`) !== expectedGames ||
        count(coverage, "duplicateSeeds", `${context}.coverage`) !== 0
    ) {
        throw new Error(`${context} does not have exact ${expectedGames}-game unique coverage`);
    }
    const templates = child(coverage, "templates", `${context}.coverage`);
    for (const template of V07_ARCHETYPE_TEMPLATE_NAMES) {
        if (count(templates, template, `${context}.coverage.templates`) !== gamesPerTemplate) {
            throw new Error(`${context} does not cover ${gamesPerTemplate} games for ${template}`);
        }
    }
}

function validateSeedPlan(summary: UnknownRecord, gamesPerTemplate: number, context: string) {
    const actual = child(summary, "seedPlan", context);
    if (actual.seedKey !== V07_SELFPLAY_PASSIVE_AUDIT_DEFAULT_SEED_KEY) {
        throw new Error(`${context} does not use the committed passive-audit seed key`);
    }
    const expected = buildV07SelfplayPassiveAuditSeedPlan({
        gamesPerTemplate,
        seedKey: V07_SELFPLAY_PASSIVE_AUDIT_DEFAULT_SEED_KEY,
    });
    const projection = {
        construction: expected.construction,
        domain: expected.domain,
        seedKey: expected.seedKey,
        seedKeySha256: expected.seedKeySha256,
        gamesPerTemplate: expected.gamesPerTemplate,
        totalGames: expected.totalGames,
        collisionAudit: expected.collisionAudit,
        sortedSeedSetSha256: expected.sortedSeedSetSha256,
        freshness: expected.freshness,
        planSha256: expected.planSha256,
        templates: expected.templates.map(({ template, seeds, seedsSha256 }) => ({
            template,
            games: seeds.length,
            seedsSha256,
        })),
    };
    expectEqual(actual, projection, `${context}.seedPlan`);
    return expected;
}

function validateBoundRun(
    summary: UnknownRecord,
    plan: IV07SelfplayPassiveAuditSeedPlan,
    expectedShardGames: number,
    context: string,
): void {
    const checkpoints = child(summary, "checkpoints", context);
    const shardGames = count(checkpoints, "shardGames", `${context}.checkpoints`);
    if (shardGames !== expectedShardGames) {
        throw new Error(`${context} checkpoint shard size is not the completed evidence protocol`);
    }
    const specs = buildV07SelfplayPassiveAuditShardSpecs(plan, shardGames);
    if (
        count(checkpoints, "shards", `${context}.checkpoints`) !== specs.length ||
        count(checkpoints, "resumedShards", `${context}.checkpoints`) +
            count(checkpoints, "computedShards", `${context}.checkpoints`) !==
            specs.length
    ) {
        throw new Error(`${context} checkpoint shard coverage is incomplete`);
    }
    const index = array(checkpoints, "index", `${context}.checkpoints`);
    if (index.length !== specs.length) throw new Error(`${context} checkpoint index coverage is incomplete`);
    for (let position = 0; position < specs.length; position += 1) {
        const entry = record(index[position], `${context}.checkpoints.index[${position}]`);
        const spec = specs[position];
        expectEqual(
            {
                id: entry.id,
                template: entry.template,
                gameStart: entry.gameStart,
                gameEndExclusive: entry.gameEndExclusive,
                seedsSha256: entry.seedsSha256,
                shardSha256: entry.shardSha256,
            },
            {
                id: spec.id,
                template: spec.template,
                gameStart: spec.gameStart,
                gameEndExclusive: spec.gameEndExclusive,
                seedsSha256: spec.seedsSha256,
                shardSha256: spec.shardSha256,
            },
            `${context} checkpoint index entry ${position}`,
        );
        if (typeof entry.payloadSha256 !== "string" || !EXPECTED_SHA256_PATTERN.test(entry.payloadSha256)) {
            throw new Error(`${context} checkpoint index entry ${position} has an invalid payload hash`);
        }
    }
    if (checkpoints.indexSha256 !== fingerprintV07SelfplayPassiveAudit(index)) {
        throw new Error(`${context} checkpoint index hash is invalid`);
    }
    const expectedRunFingerprint = v07SelfplayPassiveAuditRunFingerprint({
        planSha256: plan.planSha256,
        shardGames,
        maxLaps: null,
        revision: child(summary, "revision", context) as unknown as IRevisionProvenance,
        sourceSha256: text(summary, "sourceSha256", context),
        environment: child(summary, "environment", context) as unknown as IV07SelfplayPassiveAuditEnvironmentContract,
        formalGitAttestation:
            summary.formalGitAttestation === null
                ? null
                : (child(
                      summary,
                      "formalGitAttestation",
                      context,
                  ) as unknown as IV07SelfplayPassiveAuditFormalGitAttestation),
    });
    if (summary.runFingerprint !== expectedRunFingerprint) {
        throw new Error(`${context} run fingerprint is invalid`);
    }
}

function validateFormalCensus(summary: UnknownRecord): void {
    const environment = child(summary, "environment", "census");
    if (environment.mode !== "strict") throw new Error("census environment must be strict");
    expectEqual(environment.variables, {}, "census environment variables");
    const unsignedEnvironment = { schemaVersion: 1, mode: "strict", variables: {} };
    if (environment.environmentSha256 !== fingerprintV07SelfplayPassiveAudit(unsignedEnvironment)) {
        throw new Error("census environment hash is invalid");
    }
    const attestation = child(summary, "formalGitAttestation", "census");
    const revision = child(summary, "revision", "census");
    if (
        attestation.originMain !== revision.commit ||
        attestation.liveOriginMain !== revision.commit ||
        attestation.cleanIncludingUntracked !== true ||
        attestation.statusPorcelainSha256 !== null
    ) {
        throw new Error("census formal git attestation is not clean origin/main at the audited commit");
    }
    expectEqual(attestation.revision, revision, "census formal git revision");
}

const EXPECTED_SHADOW_VARIABLES = {
    SEARCH_ACTIVE_CHALLENGERS: "1",
    SEARCH_AUDIT_TURNS: "1",
    SEARCH_CHALLENGER_KINDS: "melee,shot,area_throw",
    SEARCH_GATE: "0.01",
    SEARCH_HORIZON: "12",
    SEARCH_INCUMBENT_KINDS: "idle,defend",
    SEARCH_OBSERVE_ONLY: "1",
    SEARCH_ROLLOUTS: "3",
    SEARCH_VALIDATION_ROLLOUTS: "16",
    SEARCH_VERSIONS: "v0.7",
    V07_SEARCH: "1",
} as const;

function validateShadowEnvironment(summary: UnknownRecord): void {
    if (summary.formalGitAttestation !== null) {
        throw new Error("shadow summary must remain explicitly observational, not formally attested policy evidence");
    }
    const environment = child(summary, "environment", "shadow");
    if (environment.mode !== "observational-shadow") throw new Error("shadow environment mode is invalid");
    const variables = child(environment, "variables", "shadow.environment");
    if (typeof variables.SEARCH_AUDIT !== "string" || !variables.SEARCH_AUDIT) {
        throw new Error("shadow SEARCH_AUDIT path is missing");
    }
    const withoutPath = { ...variables };
    delete withoutPath.SEARCH_AUDIT;
    expectEqual(withoutPath, EXPECTED_SHADOW_VARIABLES, "shadow environment variables");
    const unsigned = { schemaVersion: 1, mode: "observational-shadow", variables };
    if (environment.environmentSha256 !== fingerprintV07SelfplayPassiveAudit(unsigned)) {
        throw new Error("shadow environment hash is invalid");
    }
}

function passiveCounter(dimension: UnknownRecord, key: "skip" | "shield", context: string): UnknownRecord {
    const counter = child(dimension, key, context);
    if (count(counter, "truncatedTurns", `${context}.${key}`) !== 0) {
        throw new Error(`${context}.${key} candidate enumeration was truncated`);
    }
    if (Object.keys(child(counter, "truncatedClasses", `${context}.${key}`)).length !== 0) {
        throw new Error(`${context}.${key} contains truncated candidate classes`);
    }
    return counter;
}

function censusDimension(value: unknown, context: string): ICensusDimension {
    const dimension = record(value, context);
    const key = text(dimension, "key", context);
    const decisions = count(dimension, "decisions", context);
    const intents = child(dimension, "intents", context);
    const skipTurns = count(intents, "skip", `${context}.intents`);
    const shieldTurns = count(intents, "shield", `${context}.intents`);
    const skip = passiveCounter(dimension, "skip", context);
    const shield = passiveCounter(dimension, "shield", context);
    if (
        count(skip, "passiveTurns", `${context}.skip`) !== skipTurns ||
        count(shield, "passiveTurns", `${context}.shield`) !== shieldTurns
    ) {
        throw new Error(`${context} passive counters do not match decision intents`);
    }
    const passiveTurns = skipTurns + shieldTurns;
    const summed = (field: string): number =>
        count(skip, field, `${context}.skip`) + count(shield, field, `${context}.shield`);
    const meleeRoute = (counter: UnknownRecord, route: string): UnknownRecord =>
        child(child(counter, "byMeleeRoute", context), route, `${context}.byMeleeRoute`);
    const directMeleeAlternativeTurns =
        count(meleeRoute(skip, "direct"), "turnsWithCandidate", `${context}.skip.byMeleeRoute.direct`) +
        count(meleeRoute(shield, "direct"), "turnsWithCandidate", `${context}.shield.byMeleeRoute.direct`);
    const moveAssistedMeleeAlternativeTurns =
        count(meleeRoute(skip, "move_assisted"), "turnsWithCandidate", `${context}.skip.byMeleeRoute.move_assisted`) +
        count(
            meleeRoute(shield, "move_assisted"),
            "turnsWithCandidate",
            `${context}.shield.byMeleeRoute.move_assisted`,
        );
    const attackAlternativeTurns = summed("turnsWithCandidate");
    const positiveExpectedDamageTurns = summed("turnsWithPositiveExpectedDamage");
    const expectedKillTurns = summed("turnsWithExpectedKill");
    if (positiveExpectedDamageTurns > attackAlternativeTurns || expectedKillTurns > attackAlternativeTurns) {
        throw new Error(`${context} alternative counts are internally inconsistent`);
    }
    const divide = (numerator: number, denominator: number): number | null =>
        denominator ? numerator / denominator : null;
    return {
        key,
        decisions,
        skipTurns,
        shieldTurns,
        passiveTurns,
        skipShare: divide(skipTurns, decisions) ?? 0,
        shieldShare: divide(shieldTurns, decisions) ?? 0,
        attackAlternativeTurns,
        attackAlternativeShareOfPassive: divide(attackAlternativeTurns, passiveTurns),
        positiveExpectedDamageTurns,
        positiveExpectedDamageShareOfPassive: divide(positiveExpectedDamageTurns, passiveTurns),
        expectedKillTurns,
        expectedKillShareOfPassive: divide(expectedKillTurns, passiveTurns),
        directMeleeAlternativeTurns,
        moveAssistedMeleeAlternativeTurns,
    };
}

function validateCensusDiagnostic(summary: UnknownRecord): {
    aggregate: ICensusDimension;
    byTemplate: ICensusDimension[];
} {
    const diagnostic = child(summary, "diagnostic", "census");
    if (count(diagnostic, "games", "census.diagnostic") !== CENSUS_GAMES_PER_TEMPLATE * 8) {
        throw new Error("census diagnostic game coverage is invalid");
    }
    const aggregate = censusDimension(diagnostic.aggregate, "census.diagnostic.aggregate");
    if (aggregate.key !== "aggregate") throw new Error("census aggregate key is invalid");
    const indexed = new Map(
        array(diagnostic, "byTemplate", "census.diagnostic").map((entry, index) => {
            const dimension = censusDimension(entry, `census.diagnostic.byTemplate[${index}]`);
            return [dimension.key, dimension] as const;
        }),
    );
    if (indexed.size !== V07_ARCHETYPE_TEMPLATE_NAMES.length)
        throw new Error("census template diagnostics are incomplete");
    const byTemplate = V07_ARCHETYPE_TEMPLATE_NAMES.map((template) => {
        const dimension = indexed.get(template);
        if (!dimension) throw new Error(`census is missing diagnostic template ${template}`);
        return dimension;
    });
    for (const field of [
        "decisions",
        "skipTurns",
        "shieldTurns",
        "passiveTurns",
        "attackAlternativeTurns",
        "positiveExpectedDamageTurns",
        "expectedKillTurns",
        "directMeleeAlternativeTurns",
        "moveAssistedMeleeAlternativeTurns",
    ] as const) {
        const total = byTemplate.reduce((sum, entry) => sum + entry[field], 0);
        if (total !== aggregate[field]) throw new Error(`census aggregate ${field} does not equal template totals`);
    }
    return { aggregate, byTemplate };
}

function emptyAccumulator(): IShadowAccumulator {
    return {
        games: 0,
        gamesWithComparisons: 0,
        comparisons: 0,
        validationPositive: 0,
        validationAtLeastPoint01: 0,
        validationDeltaSum: 0,
    };
}

function addCluster(target: IShadowAccumulator, cluster: IV07PassiveShadowGameCluster): void {
    target.games += 1;
    if (cluster.validationDeltas.length) target.gamesWithComparisons += 1;
    for (const delta of cluster.validationDeltas) {
        if (!Number.isFinite(delta)) throw new Error(`Shadow game ${cluster.seed} has a non-finite validation delta`);
        target.comparisons += 1;
        if (delta > 0) target.validationPositive += 1;
        if (delta >= 0.01) target.validationAtLeastPoint01 += 1;
        target.validationDeltaSum += delta;
    }
}

function mergeAccumulator(target: IShadowAccumulator, source: IShadowAccumulator): void {
    target.games += source.games;
    target.gamesWithComparisons += source.gamesWithComparisons;
    target.comparisons += source.comparisons;
    target.validationPositive += source.validationPositive;
    target.validationAtLeastPoint01 += source.validationAtLeastPoint01;
    target.validationDeltaSum += source.validationDeltaSum;
}

function shadowMetrics(tally: IShadowAccumulator): Record<V07PassiveShadowMetric, number | null> {
    const divide = (numerator: number): number | null => (tally.comparisons ? numerator / tally.comparisons : null);
    return {
        validationPositiveRate: divide(tally.validationPositive),
        validationAtLeastPoint01Rate: divide(tally.validationAtLeastPoint01),
        meanValidationDelta: divide(tally.validationDeltaSum),
    };
}

function quantile(sorted: readonly number[], probability: number): number {
    const position = (sorted.length - 1) * probability;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return sorted[lower];
    return sorted[lower] * (upper - position) + sorted[upper] * (position - lower);
}

function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
    };
}

function cohort(
    key: string,
    point: IShadowAccumulator,
    samples: Record<V07PassiveShadowMetric, number[]>,
): IV07PassiveShadowBootstrapCohort {
    const points = shadowMetrics(point);
    const metrics = Object.fromEntries(
        V07_PASSIVE_SHADOW_METRICS.map((metric) => {
            const values = samples[metric].sort((left, right) => left - right);
            return [
                metric,
                {
                    point: points[metric],
                    confidence95: values.length
                        ? { low: quantile(values, 0.025), high: quantile(values, 0.975) }
                        : null,
                },
            ];
        }),
    ) as Record<V07PassiveShadowMetric, IV07PassiveShadowMetricInterval>;
    return {
        key,
        games: point.games,
        gamesWithComparisons: point.gamesWithComparisons,
        comparisons: point.comparisons,
        validationPositive: point.validationPositive,
        validationAtLeastPoint01: point.validationAtLeastPoint01,
        metrics,
    };
}

function emptySamples(): Record<V07PassiveShadowMetric, number[]> {
    return Object.fromEntries(V07_PASSIVE_SHADOW_METRICS.map((metric) => [metric, []])) as unknown as Record<
        V07PassiveShadowMetric,
        number[]
    >;
}

function appendSample(samples: Record<V07PassiveShadowMetric, number[]>, tally: IShadowAccumulator): void {
    const metrics = shadowMetrics(tally);
    for (const metric of V07_PASSIVE_SHADOW_METRICS) {
        const value = metrics[metric];
        if (value !== null) samples[metric].push(value);
    }
}

/** Resample complete games within each template; modeled turns are never independent bootstrap rows. */
export function bootstrapV07PassiveShadowGames(
    clusters: readonly IV07PassiveShadowGameCluster[],
    replicates: number,
    evidenceFingerprint: string,
): IV07PassiveShadowBootstrapReport {
    if (!Number.isSafeInteger(replicates) || replicates < 1) throw new Error("bootstrap replicates must be positive");
    const groups = new Map<V07ArchetypeTemplateName, IV07PassiveShadowGameCluster[]>(
        V07_ARCHETYPE_TEMPLATE_NAMES.map((template) => [template, []]),
    );
    const seenSeeds = new Set<number>();
    for (const cluster of clusters) {
        const group = groups.get(cluster.template);
        if (!group) throw new Error(`Shadow bootstrap encountered unknown template ${cluster.template}`);
        if (seenSeeds.has(cluster.seed)) throw new Error(`Shadow bootstrap encountered duplicate seed ${cluster.seed}`);
        seenSeeds.add(cluster.seed);
        group.push(cluster);
    }
    const seedSha256 = fingerprintV07SelfplayPassiveAudit({
        domain: "hoc/v0.7/passive-evidence/shadow-game-cluster-bootstrap/v1",
        evidenceFingerprint,
        replicates,
    });
    const random = mulberry32(Number.parseInt(seedSha256.slice(0, 8), 16));
    const aggregatePoint = emptyAccumulator();
    const templatePoints = new Map<V07ArchetypeTemplateName, IShadowAccumulator>();
    const aggregateSamples = emptySamples();
    const templateSamples = new Map(V07_ARCHETYPE_TEMPLATE_NAMES.map((template) => [template, emptySamples()]));
    for (const template of V07_ARCHETYPE_TEMPLATE_NAMES) {
        const group = groups.get(template)!;
        if (!group.length) throw new Error(`Shadow bootstrap has no games for ${template}`);
        const point = emptyAccumulator();
        for (const cluster of group) addCluster(point, cluster);
        templatePoints.set(template, point);
        mergeAccumulator(aggregatePoint, point);
    }
    for (let replicate = 0; replicate < replicates; replicate += 1) {
        const aggregate = emptyAccumulator();
        for (const template of V07_ARCHETYPE_TEMPLATE_NAMES) {
            const group = groups.get(template)!;
            const sample = emptyAccumulator();
            for (let draw = 0; draw < group.length; draw += 1) {
                addCluster(sample, group[Math.floor(random() * group.length)]);
            }
            appendSample(templateSamples.get(template)!, sample);
            mergeAccumulator(aggregate, sample);
        }
        appendSample(aggregateSamples, aggregate);
    }
    return {
        method: "stratified nonparametric whole-game cluster percentile bootstrap",
        samplingUnit: "complete game; all modeled turns from a sampled game move together",
        confidenceLevel: 0.95,
        replicates,
        deterministicSeedSha256: seedSha256,
        aggregate: cohort("aggregate", aggregatePoint, aggregateSamples),
        byTemplate: V07_ARCHETYPE_TEMPLATE_NAMES.map((template) =>
            cohort(template, templatePoints.get(template)!, templateSamples.get(template)!),
        ),
    };
}

function increment(counter: Record<string, number>, key: string): void {
    counter[key] = (counter[key] ?? 0) + 1;
}

function validateGameRow(row: UnknownRecord): void {
    const exact = {
        mode: "search",
        green: "v0.7",
        red: "v0.7",
        gate: 0.01,
        horizon: 12,
        rollouts: 3,
        leaf: "learned",
        observeOnly: true,
        validationRollouts: 16,
        illegalIncumbent: 0,
        deadlineFallbacks: 0,
        circuitOpened: false,
    } as const;
    for (const [key, expected] of Object.entries(exact)) {
        if (row[key] !== expected) throw new Error(`Search game ${String(row.seed)} has unexpected ${key}`);
    }
    expectEqual(row.incumbentKinds, ["idle", "defend"], `Search game ${String(row.seed)} incumbentKinds`);
    expectEqual(
        row.challengerKinds,
        ["melee", "shot", "area_throw"],
        `Search game ${String(row.seed)} challengerKinds`,
    );
}

function validateTurnRow(row: ISearchAuditTurnRow): number {
    const value = row as UnknownRecord;
    if (
        (value.inc !== "idle" && value.inc !== "defend") ||
        value.chosen !== value.inc ||
        value.ov !== 0 ||
        value.observeOnly !== 1 ||
        (value.wouldOverride !== 0 && value.wouldOverride !== 1) ||
        (value.selectedKind !== "melee" && value.selectedKind !== "shot" && value.selectedKind !== "area_throw") ||
        value.validationRollouts !== 16 ||
        typeof value.selectedSignature !== "string" ||
        !value.selectedSignature
    ) {
        throw new Error(`Search turn ${row.seed}/${row.decisionOrdinal} violates observe-only shadow semantics`);
    }
    finite(value, "discoveryDelta", `Search turn ${row.seed}/${row.decisionOrdinal}`);
    return finite(value, "validationDelta", `Search turn ${row.seed}/${row.decisionOrdinal}`);
}

export function analyzeV07PassiveEvidence(input: IV07PassiveEvidenceInput): IV07PassiveEvidenceReport {
    const census = record(input.censusSummary, "census");
    const shadow = record(input.shadowSummary, "shadow");
    const censusRevision = validateRevision(census, "census");
    const shadowRevision = validateRevision(shadow, "shadow");
    if (
        censusRevision.commit !== shadowRevision.commit ||
        censusRevision.sourceSha256 !== shadowRevision.sourceSha256
    ) {
        throw new Error("Census and shadow evidence do not bind the same code revision and audited source");
    }
    validateIntegrity(census, "census");
    validateIntegrity(shadow, "shadow");
    validateCoverage(census, CENSUS_GAMES_PER_TEMPLATE, "census");
    validateCoverage(shadow, V07_PASSIVE_SHADOW_GAMES_PER_TEMPLATE, "shadow");
    const censusPlan = validateSeedPlan(census, CENSUS_GAMES_PER_TEMPLATE, "census");
    const shadowPlan = validateSeedPlan(shadow, V07_PASSIVE_SHADOW_GAMES_PER_TEMPLATE, "shadow");
    validateFormalCensus(census);
    validateShadowEnvironment(shadow);
    validateBoundRun(census, censusPlan, 500, "census");
    validateBoundRun(shadow, shadowPlan, 50, "shadow");
    const censusDiagnostic = validateCensusDiagnostic(census);

    const plannedSeeds = shadowPlan.templates.flatMap((entry) => entry.seeds);
    const templateBySeed = new Map(
        shadowPlan.templates.flatMap((entry) => entry.seeds.map((seed) => [seed, entry.template] as const)),
    );
    const reduced = reduceSearchAuditJsonl(input.shadowAuditJsonl, plannedSeeds, {
        requireCompleteSearchTurns: true,
    });
    for (const game of reduced.gameRows) validateGameRow(game);
    const deltasBySeed = new Map<number, number[]>(plannedSeeds.map((seed) => [seed, []]));
    const observedIncumbentKinds: Record<string, number> = {};
    const selectedAttackKinds: Record<string, number> = {};
    const selectedMeleeRoutes: Record<string, number> = { direct: 0, move_assisted: 0, unknown: 0 };
    const discoveryWouldOverride = { yes: 0, no: 0 };
    for (const row of reduced.turnRows) {
        if (row.t !== "turn") throw new Error(`Shadow evidence contains unsupported ${row.t} turn evidence`);
        const delta = validateTurnRow(row);
        deltasBySeed.get(row.seed)!.push(delta);
        increment(observedIncumbentKinds, String(row.inc));
        increment(selectedAttackKinds, String(row.selectedKind));
        discoveryWouldOverride[row.wouldOverride === 1 ? "yes" : "no"] += 1;
        if (row.selectedKind === "melee") {
            const signature = String(row.selectedSignature);
            if (signature.startsWith("ml:")) selectedMeleeRoutes.direct += 1;
            else if (signature.startsWith("mv:") && signature.includes("|ml:")) selectedMeleeRoutes.move_assisted += 1;
            else selectedMeleeRoutes.unknown += 1;
        }
    }
    const clusters: IV07PassiveShadowGameCluster[] = plannedSeeds.map((seed) => ({
        template: templateBySeed.get(seed)!,
        seed,
        validationDeltas: deltasBySeed.get(seed)!,
    }));
    const evidenceFingerprint = fingerprintV07SelfplayPassiveAudit({
        censusRunFingerprint: census.runFingerprint,
        shadowRunFingerprint: shadow.runFingerprint,
        censusInputSha256: sha256(input.censusSummaryText),
        shadowSummaryInputSha256: sha256(input.shadowSummaryText),
        shadowAuditInputSha256: sha256(input.shadowAuditJsonl),
    });
    const bootstrap = bootstrapV07PassiveShadowGames(
        clusters,
        input.bootstrapReplicates ?? V07_PASSIVE_SHADOW_BOOTSTRAP_REPLICATES,
        evidenceFingerprint,
    );
    return {
        schemaVersion: 1,
        status: "v0.7_passive_evidence_complete",
        evidenceSemantics: {
            census: "Complete engine-legal candidate enumeration on skip/shield decisions; expected damage and expected kill are heuristic EV diagnostics.",
            shadow: "Observe-only search compares the shipped incumbent with a discovery-selected attack using a separate paired validation rollout bank.",
            conclusionBoundary:
                "Legal/positive-EV alternatives and model-based rollout deltas are evidence of opportunities, not terminal proof that an attack is strategically optimal.",
        },
        inputs: {
            revisionCommit: censusRevision.commit,
            sourceSha256: censusRevision.sourceSha256,
            censusSummary: {
                path: portablePath(input.censusPath),
                sha256: sha256(input.censusSummaryText),
                runFingerprint: String(census.runFingerprint),
                planSha256: censusPlan.planSha256,
            },
            shadowSummary: {
                path: portablePath(input.shadowSummaryPath),
                sha256: sha256(input.shadowSummaryText),
                runFingerprint: String(shadow.runFingerprint),
                planSha256: shadowPlan.planSha256,
            },
            shadowAudit: { path: portablePath(input.shadowAuditPath), sha256: sha256(input.shadowAuditJsonl) },
        },
        coverage: {
            censusGames: censusPlan.totalGames,
            shadowGames: shadowPlan.totalGames,
            shadowComparisons: reduced.turnRows.length,
            duplicateShadowTurnRows: reduced.duplicateTurnRows,
            duplicateShadowGameRows: reduced.duplicateGameRows,
        },
        legalExpectedValueCensus: censusDiagnostic,
        modelBasedRolloutShadow: {
            protocol: {
                discoveryRollouts: 3,
                validationRollouts: 16,
                horizon: 12,
                discoveryGate: 0.01,
                incumbentKinds: ["idle", "defend"],
                challengerKinds: ["melee", "shot", "area_throw"],
            },
            observedIncumbentKinds,
            selectedAttackKinds,
            selectedMeleeRoutes,
            discoveryWouldOverride,
            bootstrap,
        },
        limitations: [
            "The shadow panel reuses the first 500 seeds per template from the census seed protocol; no cross-corpus freshness claim is made.",
            "Validation is independent of discovery rollouts but uses the same learned finite-horizon evaluator, so it is model-based rather than a terminal outcome oracle.",
            "A null template metric means that template produced no modeled incumbent-versus-attack comparisons; it is not evidence of a zero opportunity rate.",
            "Confidence intervals resample complete games within template and preserve all within-game turn dependence.",
        ],
    };
}

function readJson(path: string, context: string): { raw: string; value: unknown } {
    const raw = readFileSync(path, "utf8");
    try {
        return { raw, value: JSON.parse(raw) };
    } catch {
        throw new Error(`${context} is not valid JSON: ${path}`);
    }
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        options: {
            "census-summary": { type: "string" },
            "shadow-audit": { type: "string" },
            "shadow-summary": { type: "string" },
            "bootstrap-replicates": { type: "string", default: String(V07_PASSIVE_SHADOW_BOOTSTRAP_REPLICATES) },
            output: { type: "string", short: "o", default: "-" },
            help: { type: "boolean", short: "h", default: false },
        },
        strict: true,
        allowPositionals: false,
    });
    if (values.help) {
        console.log(
            "bun src/simulation/analyze_v0_7_passive_evidence.ts --census-summary FILE --shadow-audit FILE " +
                "[--shadow-summary FILE] [--bootstrap-replicates 1000] [--output FILE|-]",
        );
        return;
    }
    if (!values["census-summary"] || !values["shadow-audit"]) {
        throw new Error("--census-summary and --shadow-audit are required");
    }
    const censusPath = resolve(values["census-summary"]);
    const shadowAuditPath = resolve(values["shadow-audit"]);
    const shadowSummaryPath = resolve(values["shadow-summary"] ?? `${dirname(shadowAuditPath)}/summary.json`);
    const replicates = Number(values["bootstrap-replicates"]);
    const census = readJson(censusPath, "census summary");
    const shadow = readJson(shadowSummaryPath, "shadow summary");
    const shadowAuditJsonl = readFileSync(shadowAuditPath, "utf8");
    const report = analyzeV07PassiveEvidence({
        censusSummary: census.value,
        censusSummaryText: census.raw,
        censusPath,
        shadowSummary: shadow.value,
        shadowSummaryText: shadow.raw,
        shadowSummaryPath,
        shadowAuditJsonl,
        shadowAuditPath,
        bootstrapReplicates: replicates,
    });
    const encoded = `${JSON.stringify(report, null, 2)}\n`;
    if (values.output === "-") process.stdout.write(encoded);
    else writeFileSync(resolve(values.output), encoded);
}

if (import.meta.main) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
