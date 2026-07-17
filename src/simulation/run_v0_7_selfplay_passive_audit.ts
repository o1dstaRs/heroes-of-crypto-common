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
import { createHash, createHmac } from "node:crypto";
import {
    closeSync,
    existsSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { parseArgs } from "node:util";

import {
    V07_ARCHETYPES,
    V07_ARCHETYPE_TEMPLATE_NAMES,
    v07ArchetypeTemplate,
    type V07Archetype,
    type V07ArchetypeTemplateName,
} from "./v0_7_archetype_battery";
import type { IRevisionProvenance } from "./v0_7_acceptance";
import {
    createV07SelfplayPassiveAuditTally,
    finalizeV07SelfplayPassiveAudit,
    mergeV07SelfplayPassiveAuditTallies,
    V07_PASSIVE_DECISION_INTENTS,
    V07_PASSIVE_LAP_BANDS,
    V07_SELFPLAY_PASSIVE_AUDIT_VERSION,
    type IV07SelfplayPassiveAuditCluster,
    type IV07SelfplayPassiveAuditReport,
    type IV07SelfplayPassiveAuditSeedSchedule,
    type IV07SelfplayPassiveAuditTally,
} from "./v0_7_selfplay_passive_audit";

export const V07_SELFPLAY_PASSIVE_AUDIT_SEED_DOMAIN = "hoc/v0.7/selfplay-passive-audit/seeds/v1" as const;
export const V07_SELFPLAY_PASSIVE_AUDIT_SEED_CONSTRUCTION =
    "hmac_sha256_domain_separated_uint32_internal_rejection_v1" as const;
export const V07_SELFPLAY_PASSIVE_AUDIT_DEFAULT_SEED_KEY = "hoc-v0.7-selfplay-passive-audit-100k-20260716-v1" as const;
export const V07_SELFPLAY_PASSIVE_AUDIT_REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const V07_SELFPLAY_PASSIVE_AUDIT_RUNNER_PROTOCOL = Object.freeze({
    schemaVersion: 1,
    auditedVersion: "v0.7",
    gamesPerTemplate: 12_500,
    shardGames: 500,
    templates: V07_ARCHETYPE_TEMPLATE_NAMES,
    totalGames: 100_000,
    shardsPerTemplate: 25,
    totalShards: 200,
    defaultConcurrency: 12,
    seedFreshnessClaim: "NOT_CLAIMED_PRIOR_CORPORA_NOT_SCANNED",
    checkpointPolicy: "one atomic checkpoint per complete template-local shard",
} as const);

export interface IV07SelfplayPassiveAuditCollisionAudit {
    candidatesExamined: number;
    acceptedSeeds: number;
    rejectedCandidates: number;
    withinPlanCollisions: number;
    maxAttempt: number;
}

export interface IV07SelfplayPassiveAuditTemplateSeedPlan {
    template: V07ArchetypeTemplateName;
    seeds: number[];
    seedsSha256: string;
}

export interface IV07SelfplayPassiveAuditSeedPlan {
    schemaVersion: 1;
    construction: typeof V07_SELFPLAY_PASSIVE_AUDIT_SEED_CONSTRUCTION;
    domain: typeof V07_SELFPLAY_PASSIVE_AUDIT_SEED_DOMAIN;
    seedKey: string;
    seedKeySha256: string;
    gamesPerTemplate: number;
    totalGames: number;
    templates: IV07SelfplayPassiveAuditTemplateSeedPlan[];
    collisionAudit: IV07SelfplayPassiveAuditCollisionAudit;
    sortedSeedSetSha256: string;
    freshness: {
        internalUniqueness: true;
        priorCorpusScanned: false;
        claim: typeof V07_SELFPLAY_PASSIVE_AUDIT_RUNNER_PROTOCOL.seedFreshnessClaim;
    };
    planSha256: string;
}

export interface IV07SelfplayPassiveAuditSeedPlanOptions {
    gamesPerTemplate?: number;
    seedKey?: string;
}

export interface IV07SelfplayPassiveAuditShardSpec {
    id: string;
    template: V07ArchetypeTemplateName;
    templateShard: number;
    gameStart: number;
    gameEndExclusive: number;
    seeds: number[];
    seedsSha256: string;
    planSha256: string;
    shardSha256: string;
}

export interface IV07SelfplayPassiveAuditShardPayload {
    schemaVersion: 1;
    shardId: string;
    shardSha256: string;
    games: number;
    tally: IV07SelfplayPassiveAuditTally;
    clusters: IV07SelfplayPassiveAuditCluster[];
}

export const V07_SELFPLAY_PASSIVE_AUDIT_BOOTSTRAP_METRICS = [
    "skipShare",
    "shieldShare",
    "passiveShare",
    "attackCandidateShareOfPassive",
    "positiveExpectedDamageShareOfPassive",
    "actualUnitSkippedShare",
    "explicitUnitDefendedShare",
    "greenWinRate",
] as const;

export type V07SelfplayPassiveAuditBootstrapMetric = (typeof V07_SELFPLAY_PASSIVE_AUDIT_BOOTSTRAP_METRICS)[number];

export interface IV07SelfplayPassiveAuditBootstrapInterval {
    point: number | null;
    confidence95: { low: number; high: number } | null;
}

export interface IV07SelfplayPassiveAuditBootstrapCohort {
    key: string;
    games: number;
    metrics: Record<V07SelfplayPassiveAuditBootstrapMetric, IV07SelfplayPassiveAuditBootstrapInterval>;
}

export interface IV07SelfplayPassiveAuditBootstrapReport {
    method: "stratified nonparametric game-cluster percentile bootstrap";
    confidenceLevel: 0.95;
    replicates: number;
    deterministicSeedSha256: string;
    aggregate: IV07SelfplayPassiveAuditBootstrapCohort;
    byArchetypeCohort: IV07SelfplayPassiveAuditBootstrapCohort[];
    byTemplate: IV07SelfplayPassiveAuditBootstrapCohort[];
}

export interface IV07SelfplayPassiveAuditIntegrityGate {
    status: "pass" | "fail";
    policy: "zero rejected strategy actions and zero simulator recovery turns";
    rejectedActions: number;
    recoveryTurns: number;
    recoveryDefendTurns: number;
    recoveryAdvanceTurns: number;
    recoveryFailedTurns: number;
    reproSamples: IV07SelfplayPassiveAuditTally["integrity"]["reproSamples"];
    note: "recovery is diagnostic only and excluded from policy skip/shield ratios";
}

export type V07SelfplayPassiveAuditEnvironmentMode = "strict" | "observational-shadow";

export interface IV07SelfplayPassiveAuditEnvironmentContract {
    schemaVersion: 1;
    mode: V07SelfplayPassiveAuditEnvironmentMode;
    variables: Record<string, string>;
    environmentSha256: string;
}

export interface IV07SelfplayPassiveAuditFormalGitAttestation {
    schemaVersion: 1;
    repositoryRoot: string;
    revision: IRevisionProvenance;
    originMain: string;
    liveOriginMain: string;
    cleanIncludingUntracked: boolean;
    statusPorcelainSha256: string | null;
}

export interface IV07SelfplayPassiveAuditRunSummary {
    schemaVersion: 1;
    status: "v0.7_selfplay_passive_audit_complete";
    runFingerprint: string;
    sourceSha256: string;
    revision: IRevisionProvenance;
    environment: IV07SelfplayPassiveAuditEnvironmentContract;
    formalGitAttestation: IV07SelfplayPassiveAuditFormalGitAttestation | null;
    runnerProtocol: typeof V07_SELFPLAY_PASSIVE_AUDIT_RUNNER_PROTOCOL;
    seedPlan: {
        construction: typeof V07_SELFPLAY_PASSIVE_AUDIT_SEED_CONSTRUCTION;
        domain: typeof V07_SELFPLAY_PASSIVE_AUDIT_SEED_DOMAIN;
        seedKey: string;
        seedKeySha256: string;
        gamesPerTemplate: number;
        totalGames: number;
        collisionAudit: IV07SelfplayPassiveAuditCollisionAudit;
        sortedSeedSetSha256: string;
        freshness: IV07SelfplayPassiveAuditSeedPlan["freshness"];
        planSha256: string;
        templates: Array<{
            template: V07ArchetypeTemplateName;
            games: number;
            seedsSha256: string;
        }>;
    };
    checkpoints: {
        directory: string;
        shardGames: number;
        shards: number;
        resumedShards: number;
        computedShards: number;
        indexSha256: string;
        index: Array<{
            id: string;
            template: V07ArchetypeTemplateName;
            gameStart: number;
            gameEndExclusive: number;
            seedsSha256: string;
            shardSha256: string;
            payloadSha256: string;
        }>;
    };
    coverage: {
        expectedGames: number;
        reducedGames: number;
        uniqueSeeds: number;
        duplicateSeeds: 0;
        templates: Record<V07ArchetypeTemplateName, number>;
    };
    integrityGate: IV07SelfplayPassiveAuditIntegrityGate;
    gameClusterBootstrap: IV07SelfplayPassiveAuditBootstrapReport;
    diagnostic: IV07SelfplayPassiveAuditReport;
}

interface IV07SelfplayPassiveAuditCheckpoint<T> {
    schemaVersion: 1;
    artifactKind: "v0.7_selfplay_passive_audit_shard_checkpoint";
    runFingerprint: string;
    planSha256: string;
    shard: IV07SelfplayPassiveAuditShardSpec;
    payloadSha256: string;
    payload: T;
    checkpointSha256: string;
}

function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== "object") {
        if (typeof value === "number" && !Number.isFinite(value)) {
            throw new Error(`Cannot canonicalize non-finite number ${value}`);
        }
        const encoded = JSON.stringify(value);
        if (encoded === undefined) throw new Error("Cannot canonicalize undefined");
        return encoded;
    }
    if (Array.isArray(value)) {
        return `[${value.map((entry) => (entry === undefined ? "null" : canonicalJson(entry))).join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
        .join(",")}}`;
}

export function fingerprintV07SelfplayPassiveAudit(value: unknown): string {
    return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function positiveInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer; got ${value}`);
    return value;
}

function requireSha256(value: string, name: string): void {
    if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${name} must be a lowercase SHA-256 digest`);
}

function seedCandidate(key: Buffer, template: V07ArchetypeTemplateName, game: number, attempt: number): number {
    const digest = createHmac("sha256", key)
        .update(
            canonicalJson({
                construction: V07_SELFPLAY_PASSIVE_AUDIT_SEED_CONSTRUCTION,
                domain: V07_SELFPLAY_PASSIVE_AUDIT_SEED_DOMAIN,
                template,
                game,
                attempt,
            }),
        )
        .digest();
    return digest.readUInt32BE(0);
}

function unsignedSeedPlan(
    plan: IV07SelfplayPassiveAuditSeedPlan,
): Omit<IV07SelfplayPassiveAuditSeedPlan, "planSha256"> {
    const unsigned: Partial<IV07SelfplayPassiveAuditSeedPlan> = { ...plan };
    delete unsigned.planSha256;
    return unsigned as Omit<IV07SelfplayPassiveAuditSeedPlan, "planSha256">;
}

export function validateV07SelfplayPassiveAuditSeedPlan(
    plan: IV07SelfplayPassiveAuditSeedPlan,
): IV07SelfplayPassiveAuditSeedPlan {
    if (plan.schemaVersion !== 1) throw new Error("Seed plan schemaVersion must be 1");
    if (plan.construction !== V07_SELFPLAY_PASSIVE_AUDIT_SEED_CONSTRUCTION) {
        throw new Error("Seed plan construction does not match the runner protocol");
    }
    if (plan.domain !== V07_SELFPLAY_PASSIVE_AUDIT_SEED_DOMAIN) {
        throw new Error("Seed plan domain does not match the runner protocol");
    }
    positiveInteger(plan.gamesPerTemplate, "seed plan gamesPerTemplate");
    if (plan.templates.length !== V07_ARCHETYPE_TEMPLATE_NAMES.length) {
        throw new Error(`Seed plan must contain ${V07_ARCHETYPE_TEMPLATE_NAMES.length} templates`);
    }
    const seenTemplates = new Set<string>();
    const seenSeeds = new Set<number>();
    for (let index = 0; index < plan.templates.length; index += 1) {
        const expectedTemplate = V07_ARCHETYPE_TEMPLATE_NAMES[index];
        const entry = plan.templates[index];
        if (entry.template !== expectedTemplate) {
            throw new Error(`Seed plan template ${index} must be ${expectedTemplate}; got ${entry.template}`);
        }
        if (seenTemplates.has(entry.template)) throw new Error(`Seed plan repeats template ${entry.template}`);
        seenTemplates.add(entry.template);
        if (entry.seeds.length !== plan.gamesPerTemplate) {
            throw new Error(`${entry.template} has ${entry.seeds.length} seeds; expected ${plan.gamesPerTemplate}`);
        }
        for (const seed of entry.seeds) {
            if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
                throw new Error(`${entry.template} contains an invalid uint32 seed: ${seed}`);
            }
            if (seenSeeds.has(seed)) throw new Error(`Seed plan contains duplicate seed ${seed}`);
            seenSeeds.add(seed);
        }
        if (fingerprintV07SelfplayPassiveAudit(entry.seeds) !== entry.seedsSha256) {
            throw new Error(`${entry.template} seedsSha256 does not match its seeds`);
        }
    }
    if (plan.totalGames !== plan.gamesPerTemplate * V07_ARCHETYPE_TEMPLATE_NAMES.length) {
        throw new Error(`Seed plan totalGames ${plan.totalGames} does not match its template coverage`);
    }
    if (seenSeeds.size !== plan.totalGames)
        throw new Error("Seed plan does not contain exactly totalGames unique seeds");
    const sortedSeeds = [...seenSeeds].sort((a, b) => a - b);
    if (fingerprintV07SelfplayPassiveAudit(sortedSeeds) !== plan.sortedSeedSetSha256) {
        throw new Error("Seed plan sortedSeedSetSha256 does not match its seeds");
    }
    if (
        !plan.freshness.internalUniqueness ||
        plan.freshness.priorCorpusScanned ||
        plan.freshness.claim !== V07_SELFPLAY_PASSIVE_AUDIT_RUNNER_PROTOCOL.seedFreshnessClaim
    ) {
        throw new Error("Seed plan freshness statement must claim internal uniqueness only");
    }
    if (plan.collisionAudit.acceptedSeeds !== plan.totalGames) {
        throw new Error("Seed plan collision audit acceptedSeeds does not match totalGames");
    }
    if (
        plan.collisionAudit.rejectedCandidates !== plan.collisionAudit.withinPlanCollisions ||
        plan.collisionAudit.candidatesExamined !==
            plan.collisionAudit.acceptedSeeds + plan.collisionAudit.rejectedCandidates
    ) {
        throw new Error("Seed plan collision audit is internally inconsistent");
    }
    requireSha256(plan.seedKeySha256, "seed plan seedKeySha256");
    if (fingerprintV07SelfplayPassiveAudit({ domain: plan.domain, seedKey: plan.seedKey }) !== plan.seedKeySha256) {
        throw new Error("Seed plan seedKeySha256 does not match seedKey");
    }
    requireSha256(plan.planSha256, "seed plan planSha256");
    if (fingerprintV07SelfplayPassiveAudit(unsignedSeedPlan(plan)) !== plan.planSha256) {
        throw new Error("Seed plan planSha256 does not match its content");
    }
    return plan;
}

export function buildV07SelfplayPassiveAuditSeedPlan(
    options: IV07SelfplayPassiveAuditSeedPlanOptions = {},
): IV07SelfplayPassiveAuditSeedPlan {
    const gamesPerTemplate = positiveInteger(
        options.gamesPerTemplate ?? V07_SELFPLAY_PASSIVE_AUDIT_RUNNER_PROTOCOL.gamesPerTemplate,
        "gamesPerTemplate",
    );
    const seedKey = options.seedKey ?? V07_SELFPLAY_PASSIVE_AUDIT_DEFAULT_SEED_KEY;
    if (!seedKey.trim()) throw new Error("seedKey must not be empty");
    const key = createHash("sha256").update(`${V07_SELFPLAY_PASSIVE_AUDIT_SEED_DOMAIN}\0hmac-key\0${seedKey}`).digest();
    const used = new Set<number>();
    const collisionAudit: IV07SelfplayPassiveAuditCollisionAudit = {
        candidatesExamined: 0,
        acceptedSeeds: 0,
        rejectedCandidates: 0,
        withinPlanCollisions: 0,
        maxAttempt: 0,
    };
    const templates = V07_ARCHETYPE_TEMPLATE_NAMES.map((template): IV07SelfplayPassiveAuditTemplateSeedPlan => {
        const seeds: number[] = [];
        for (let game = 0; game < gamesPerTemplate; game += 1) {
            let attempt = 0;
            let seed: number;
            do {
                seed = seedCandidate(key, template, game, attempt);
                collisionAudit.candidatesExamined += 1;
                if (!used.has(seed)) break;
                collisionAudit.rejectedCandidates += 1;
                collisionAudit.withinPlanCollisions += 1;
                attempt += 1;
            } while (true);
            collisionAudit.maxAttempt = Math.max(collisionAudit.maxAttempt, attempt);
            collisionAudit.acceptedSeeds += 1;
            used.add(seed);
            seeds.push(seed);
        }
        return { template, seeds, seedsSha256: fingerprintV07SelfplayPassiveAudit(seeds) };
    });
    const unsigned: Omit<IV07SelfplayPassiveAuditSeedPlan, "planSha256"> = {
        schemaVersion: 1,
        construction: V07_SELFPLAY_PASSIVE_AUDIT_SEED_CONSTRUCTION,
        domain: V07_SELFPLAY_PASSIVE_AUDIT_SEED_DOMAIN,
        seedKey,
        seedKeySha256: fingerprintV07SelfplayPassiveAudit({
            domain: V07_SELFPLAY_PASSIVE_AUDIT_SEED_DOMAIN,
            seedKey,
        }),
        gamesPerTemplate,
        totalGames: gamesPerTemplate * V07_ARCHETYPE_TEMPLATE_NAMES.length,
        templates,
        collisionAudit,
        sortedSeedSetSha256: fingerprintV07SelfplayPassiveAudit([...used].sort((a, b) => a - b)),
        freshness: {
            internalUniqueness: true,
            priorCorpusScanned: false,
            claim: V07_SELFPLAY_PASSIVE_AUDIT_RUNNER_PROTOCOL.seedFreshnessClaim,
        },
    };
    return validateV07SelfplayPassiveAuditSeedPlan({
        ...unsigned,
        planSha256: fingerprintV07SelfplayPassiveAudit(unsigned),
    });
}

function unsignedShardSpec(
    shard: IV07SelfplayPassiveAuditShardSpec,
): Omit<IV07SelfplayPassiveAuditShardSpec, "shardSha256"> {
    const unsigned: Partial<IV07SelfplayPassiveAuditShardSpec> = { ...shard };
    delete unsigned.shardSha256;
    return unsigned as Omit<IV07SelfplayPassiveAuditShardSpec, "shardSha256">;
}

function validateShardSpecAgainstPlan(
    raw: IV07SelfplayPassiveAuditShardSpec,
    plan: IV07SelfplayPassiveAuditSeedPlan,
    shardGames: number,
): IV07SelfplayPassiveAuditShardSpec {
    const spec = raw;
    positiveInteger(shardGames, "shardGames");
    const templatePlan = plan.templates.find(({ template }) => template === spec.template);
    if (!templatePlan) throw new Error(`Shard ${spec.id} has unknown template ${spec.template}`);
    if (!Number.isSafeInteger(spec.templateShard) || spec.templateShard < 0) {
        throw new Error(`Shard ${spec.id} has invalid templateShard`);
    }
    if (spec.gameStart !== spec.templateShard * shardGames) {
        throw new Error(`Shard ${spec.id} gameStart does not match templateShard`);
    }
    if (
        spec.gameEndExclusive !== Math.min(spec.gameStart + shardGames, plan.gamesPerTemplate) ||
        spec.gameStart < 0 ||
        spec.gameStart >= plan.gamesPerTemplate
    ) {
        throw new Error(`Shard ${spec.id} has an invalid game range`);
    }
    const expectedSeeds = templatePlan.seeds.slice(spec.gameStart, spec.gameEndExclusive);
    if (canonicalJson(spec.seeds) !== canonicalJson(expectedSeeds)) {
        throw new Error(`Shard ${spec.id} seeds do not match its template range`);
    }
    if (fingerprintV07SelfplayPassiveAudit(spec.seeds) !== spec.seedsSha256) {
        throw new Error(`Shard ${spec.id} seedsSha256 does not match its seeds`);
    }
    if (spec.planSha256 !== plan.planSha256) throw new Error(`Shard ${spec.id} planSha256 does not match the plan`);
    const expectedId = `${spec.template}-${String(spec.gameStart).padStart(5, "0")}-${String(spec.gameEndExclusive).padStart(5, "0")}`;
    if (spec.id !== expectedId) throw new Error(`Shard id ${spec.id} does not match ${expectedId}`);
    requireSha256(spec.shardSha256, `shard ${spec.id} shardSha256`);
    if (fingerprintV07SelfplayPassiveAudit(unsignedShardSpec(spec)) !== spec.shardSha256) {
        throw new Error(`Shard ${spec.id} shardSha256 does not match its content`);
    }
    return spec;
}

export function validateV07SelfplayPassiveAuditShardSpec(
    raw: IV07SelfplayPassiveAuditShardSpec,
    plan: IV07SelfplayPassiveAuditSeedPlan,
    shardGames: number,
): IV07SelfplayPassiveAuditShardSpec {
    validateV07SelfplayPassiveAuditSeedPlan(plan);
    return validateShardSpecAgainstPlan(raw, plan, shardGames);
}

export function buildV07SelfplayPassiveAuditShardSpecs(
    plan: IV07SelfplayPassiveAuditSeedPlan,
    shardGames: number = V07_SELFPLAY_PASSIVE_AUDIT_RUNNER_PROTOCOL.shardGames,
): IV07SelfplayPassiveAuditShardSpec[] {
    validateV07SelfplayPassiveAuditSeedPlan(plan);
    positiveInteger(shardGames, "shardGames");
    const shards: IV07SelfplayPassiveAuditShardSpec[] = [];
    for (const templatePlan of plan.templates) {
        for (
            let gameStart = 0, templateShard = 0;
            gameStart < plan.gamesPerTemplate;
            gameStart += shardGames, templateShard += 1
        ) {
            const gameEndExclusive = Math.min(gameStart + shardGames, plan.gamesPerTemplate);
            const seeds = templatePlan.seeds.slice(gameStart, gameEndExclusive);
            const id = `${templatePlan.template}-${String(gameStart).padStart(5, "0")}-${String(gameEndExclusive).padStart(5, "0")}`;
            const unsigned: Omit<IV07SelfplayPassiveAuditShardSpec, "shardSha256"> = {
                id,
                template: templatePlan.template,
                templateShard,
                gameStart,
                gameEndExclusive,
                seeds,
                seedsSha256: fingerprintV07SelfplayPassiveAudit(seeds),
                planSha256: plan.planSha256,
            };
            shards.push(
                validateShardSpecAgainstPlan(
                    { ...unsigned, shardSha256: fingerprintV07SelfplayPassiveAudit(unsigned) },
                    plan,
                    shardGames,
                ),
            );
        }
    }
    return shards;
}

function checkpointPath(checkpointDir: string, spec: IV07SelfplayPassiveAuditShardSpec): string {
    return join(checkpointDir, `${spec.id}.json`);
}

function unsignedCheckpoint<T>(
    checkpoint: IV07SelfplayPassiveAuditCheckpoint<T>,
): Omit<IV07SelfplayPassiveAuditCheckpoint<T>, "checkpointSha256"> {
    const unsigned: Partial<IV07SelfplayPassiveAuditCheckpoint<T>> = { ...checkpoint };
    delete unsigned.checkpointSha256;
    return unsigned as Omit<IV07SelfplayPassiveAuditCheckpoint<T>, "checkpointSha256">;
}

function writeAtomic(path: string, bytes: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${process.pid}-${process.hrtime.bigint()}`;
    const handle = openSync(temporary, "wx", 0o600);
    try {
        writeFileSync(handle, bytes);
        fsyncSync(handle);
    } finally {
        closeSync(handle);
    }
    renameSync(temporary, path);
    const directory = openSync(dirname(path), "r");
    try {
        fsyncSync(directory);
    } finally {
        closeSync(directory);
    }
}

export function saveV07SelfplayPassiveAuditCheckpoint<T>(
    checkpointDir: string,
    spec: IV07SelfplayPassiveAuditShardSpec,
    runFingerprint: string,
    payload: T,
): void {
    requireSha256(runFingerprint, "runFingerprint");
    const unsigned: Omit<IV07SelfplayPassiveAuditCheckpoint<T>, "checkpointSha256"> = {
        schemaVersion: 1,
        artifactKind: "v0.7_selfplay_passive_audit_shard_checkpoint",
        runFingerprint,
        planSha256: spec.planSha256,
        shard: spec,
        payloadSha256: fingerprintV07SelfplayPassiveAudit(payload),
        payload,
    };
    const checkpoint: IV07SelfplayPassiveAuditCheckpoint<T> = {
        ...unsigned,
        checkpointSha256: fingerprintV07SelfplayPassiveAudit(unsigned),
    };
    writeAtomic(checkpointPath(checkpointDir, spec), `${JSON.stringify(checkpoint)}\n`);
}

function corruptCheckpoint(path: string, detail: string): never {
    throw new Error(`Corrupt v0.7 self-play passive-audit checkpoint ${path}: ${detail}`);
}

export function loadV07SelfplayPassiveAuditCheckpoint<T>(
    checkpointDir: string,
    expectedSpec: IV07SelfplayPassiveAuditShardSpec,
    expectedRunFingerprint: string,
): T | undefined {
    const path = checkpointPath(checkpointDir, expectedSpec);
    if (!existsSync(path)) return undefined;
    let parsed: IV07SelfplayPassiveAuditCheckpoint<T>;
    try {
        parsed = JSON.parse(readFileSync(path, "utf8")) as IV07SelfplayPassiveAuditCheckpoint<T>;
    } catch (error) {
        corruptCheckpoint(path, error instanceof Error ? error.message : String(error));
    }
    if (parsed.schemaVersion !== 1 || parsed.artifactKind !== "v0.7_selfplay_passive_audit_shard_checkpoint") {
        corruptCheckpoint(path, "schema or artifact kind mismatch");
    }
    if (parsed.runFingerprint !== expectedRunFingerprint) corruptCheckpoint(path, "run fingerprint mismatch");
    if (parsed.planSha256 !== expectedSpec.planSha256) corruptCheckpoint(path, "plan fingerprint mismatch");
    if (canonicalJson(parsed.shard) !== canonicalJson(expectedSpec)) {
        corruptCheckpoint(path, "template, range, seeds, or shard fingerprint mismatch");
    }
    if (fingerprintV07SelfplayPassiveAudit(parsed.payload) !== parsed.payloadSha256) {
        corruptCheckpoint(path, "payload fingerprint mismatch");
    }
    if (fingerprintV07SelfplayPassiveAudit(unsignedCheckpoint(parsed)) !== parsed.checkpointSha256) {
        corruptCheckpoint(path, "checkpoint fingerprint mismatch");
    }
    return parsed.payload;
}

const V07_SELFPLAY_PASSIVE_AUDIT_BEHAVIOR_ENV_PREFIXES = [
    "V04_",
    "V05_",
    "V06_",
    "V07_",
    "SEARCH_",
    "Q2_",
    "CEM_",
] as const;
const V07_SELFPLAY_PASSIVE_AUDIT_BEHAVIOR_ENV_EXACT = new Set([
    "AUGCA_NOVISION",
    "FIGHT_MELEE_ROSTERS",
    "FORCE_CREATURES",
    "HOC_DRAFT_WEIGHTS",
    "LIVETWIN",
    "PHASE_B_RUN_FINGERPRINT",
    "ROSTER_RANGED_MAX",
    "ROSTER_RANGED_MIN",
    "VALUE_DATA",
    "VALUE_DATA_FEATURES",
]);
const V07_SELFPLAY_PASSIVE_AUDIT_SHADOW_REQUIRED = Object.freeze({
    V07_SEARCH: "1",
    SEARCH_ACTIVE_CHALLENGERS: "1",
    SEARCH_AUDIT_TURNS: "1",
    SEARCH_OBSERVE_ONLY: "1",
} as const);

function behaviorEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
    return Object.fromEntries(
        Object.keys(environment)
            .filter(
                (name) =>
                    V07_SELFPLAY_PASSIVE_AUDIT_BEHAVIOR_ENV_EXACT.has(name) ||
                    V07_SELFPLAY_PASSIVE_AUDIT_BEHAVIOR_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)),
            )
            .filter((name) => environment[name] !== undefined)
            .sort()
            .map((name) => [name, environment[name]!]),
    );
}

function environmentContract(
    mode: V07SelfplayPassiveAuditEnvironmentMode,
    variables: Record<string, string>,
): IV07SelfplayPassiveAuditEnvironmentContract {
    const unsigned = { schemaVersion: 1 as const, mode, variables };
    return {
        ...unsigned,
        environmentSha256: fingerprintV07SelfplayPassiveAudit(unsigned),
    };
}

function parseShadowKindSet(value: string | undefined, name: string, allowed: ReadonlySet<string>): void {
    const entries = (value ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    if (!entries.length || entries.some((entry) => !allowed.has(entry)) || new Set(entries).size !== entries.length) {
        throw new Error(`${name} must be a non-empty unique subset of ${[...allowed].join(",")}`);
    }
}

/**
 * Resolve and bind every environment input that can affect the audited policy or its observational search.
 * `strict` is committed-default evidence. `observational-shadow` is research-only and must return the incumbent.
 */
export function resolveV07SelfplayPassiveAuditEnvironment(
    mode: V07SelfplayPassiveAuditEnvironmentMode = "strict",
    environment: NodeJS.ProcessEnv = process.env,
): IV07SelfplayPassiveAuditEnvironmentContract {
    const variables = behaviorEnvironment(environment);
    if (mode === "strict") {
        const forbidden = Object.keys(variables);
        if (forbidden.length) {
            throw new Error(
                `Behavior-changing AI environment variables are forbidden for this audit: ${forbidden.join(", ")}`,
            );
        }
        return environmentContract(mode, variables);
    }

    const disallowed = Object.keys(variables).filter((name) => name !== "V07_SEARCH" && !name.startsWith("SEARCH_"));
    if (disallowed.length) {
        throw new Error(`Observational shadow forbids policy-changing environment variables: ${disallowed.join(", ")}`);
    }
    for (const [name, expected] of Object.entries(V07_SELFPLAY_PASSIVE_AUDIT_SHADOW_REQUIRED)) {
        if (variables[name] !== expected) {
            throw new Error(`Observational shadow requires ${name}=${expected}`);
        }
    }
    if (variables.SEARCH_VERSIONS !== "v0.7") {
        throw new Error("Observational shadow requires SEARCH_VERSIONS=v0.7");
    }
    parseShadowKindSet(variables.SEARCH_INCUMBENT_KINDS, "SEARCH_INCUMBENT_KINDS", new Set(["idle", "defend"]));
    parseShadowKindSet(
        variables.SEARCH_CHALLENGER_KINDS,
        "SEARCH_CHALLENGER_KINDS",
        new Set(["melee", "shot", "area_throw"]),
    );
    const validationRollouts = Number(variables.SEARCH_VALIDATION_ROLLOUTS);
    if (!Number.isSafeInteger(validationRollouts) || validationRollouts < 1) {
        throw new Error("Observational shadow requires a positive SEARCH_VALIDATION_ROLLOUTS");
    }
    if (!variables.SEARCH_AUDIT || !isAbsolute(variables.SEARCH_AUDIT) || variables.SEARCH_AUDIT === "1") {
        throw new Error("Observational shadow requires SEARCH_AUDIT to be an absolute JSONL path");
    }
    if (variables.SEARCH_IL_DATASET || variables.SEARCH_IL_RUN_FINGERPRINT || variables.SEARCH_IL_COHORT) {
        throw new Error("Observational shadow cannot emit an imitation-learning dataset");
    }
    return environmentContract(mode, variables);
}

export function assertV07SelfplayPassiveAuditEnvironment(environment: NodeJS.ProcessEnv = process.env): void {
    resolveV07SelfplayPassiveAuditEnvironment("strict", environment);
}

export type V07SelfplayPassiveAuditGitTextReader = (repositoryRoot: string, args: readonly string[]) => string;

function readGitText(repositoryRoot: string, args: readonly string[]): string {
    try {
        return execFileSync("git", ["-C", repositoryRoot, ...args], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        }).trim();
    } catch (error) {
        throw new Error(
            `Cannot read v0.7 passive-audit git provenance from ${repositoryRoot}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

/** Read common's revision explicitly; this never depends on the process caller's working directory. */
export function readV07SelfplayPassiveAuditRevisionProvenance(
    repositoryRoot: string = V07_SELFPLAY_PASSIVE_AUDIT_REPOSITORY_ROOT,
    readGit: V07SelfplayPassiveAuditGitTextReader = readGitText,
): IRevisionProvenance {
    const commit = readGit(repositoryRoot, ["rev-parse", "HEAD"]);
    if (!/^[0-9a-f]{40,64}$/i.test(commit)) {
        throw new Error(`Passive-audit provenance found an invalid HEAD in ${repositoryRoot}`);
    }
    const diff = readGit(repositoryRoot, ["diff", "--binary", "HEAD"]);
    let remote: string | null;
    try {
        remote = readGit(repositoryRoot, ["remote", "get-url", "origin"]) || null;
    } catch {
        remote = null;
    }
    return {
        commit: commit.toLowerCase(),
        commitDate: readGit(repositoryRoot, ["show", "-s", "--format=%cI", "HEAD"]),
        branch: readGit(repositoryRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
        remote,
        trackedClean: diff.length === 0,
        trackedDiffSha256: diff.length === 0 ? null : createHash("sha256").update(diff).digest("hex"),
    };
}

function parseLiveOriginMain(value: string): string {
    const match = /^([0-9a-f]{40,64})\s+refs\/heads\/main$/i.exec(value.trim());
    if (!match) throw new Error("The formal passive audit could not resolve exactly one live origin/main revision");
    return match[1].toLowerCase();
}

/** Capture and enforce a clean, pushed common/main checkout, including a live remote reachability check. */
export function readV07SelfplayPassiveAuditFormalGitAttestation(
    repositoryRoot: string = V07_SELFPLAY_PASSIVE_AUDIT_REPOSITORY_ROOT,
    readGit: V07SelfplayPassiveAuditGitTextReader = readGitText,
): IV07SelfplayPassiveAuditFormalGitAttestation {
    const revision = readV07SelfplayPassiveAuditRevisionProvenance(repositoryRoot, readGit);
    const status = readGit(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const attestation: IV07SelfplayPassiveAuditFormalGitAttestation = {
        schemaVersion: 1,
        repositoryRoot: resolve(repositoryRoot),
        revision,
        originMain: readGit(repositoryRoot, ["rev-parse", "origin/main"]).toLowerCase(),
        liveOriginMain: parseLiveOriginMain(
            readGit(repositoryRoot, ["ls-remote", "--exit-code", "origin", "refs/heads/main"]),
        ),
        cleanIncludingUntracked: status.length === 0,
        statusPorcelainSha256: status.length === 0 ? null : createHash("sha256").update(status).digest("hex"),
    };
    return assertV07SelfplayPassiveAuditFormalGitAttestation(attestation);
}

export function assertV07SelfplayPassiveAuditFormalGitAttestation(
    attestation: IV07SelfplayPassiveAuditFormalGitAttestation,
): IV07SelfplayPassiveAuditFormalGitAttestation {
    const { revision } = attestation;
    if (revision.branch !== "main") {
        throw new Error(`The formal 100k audit requires common branch main; got ${revision.branch}`);
    }
    if (!revision.trackedClean || !attestation.cleanIncludingUntracked) {
        throw new Error(
            `The formal 100k audit requires a completely clean common repository, including untracked files: ${attestation.repositoryRoot}`,
        );
    }
    if (revision.commit !== attestation.originMain) {
        throw new Error(
            `The formal 100k audit requires common HEAD == origin/main; got ${revision.commit}/${attestation.originMain}`,
        );
    }
    if (revision.commit !== attestation.liveOriginMain) {
        throw new Error(
            `The formal 100k audit requires common HEAD == live origin/main; got ${revision.commit}/${attestation.liveOriginMain}`,
        );
    }
    return attestation;
}

export function v07SelfplayPassiveAuditSourceSha256(): string {
    const hash = createHash("sha256");
    for (const name of [
        "battle_engine.ts",
        "v0_7_selfplay_passive_audit.ts",
        "v0_7_selfplay_passive_audit_worker.ts",
        "run_v0_7_selfplay_passive_audit.ts",
    ]) {
        hash.update(name)
            .update("\0")
            .update(readFileSync(new URL(`./${name}`, import.meta.url)))
            .update("\0");
    }
    return hash.digest("hex");
}

export function v07SelfplayPassiveAuditRunFingerprint(input: {
    planSha256: string;
    shardGames: number;
    maxLaps: number | null;
    revision?: IRevisionProvenance;
    sourceSha256?: string;
    environment?: IV07SelfplayPassiveAuditEnvironmentContract;
    formalGitAttestation?: IV07SelfplayPassiveAuditFormalGitAttestation | null;
}): string {
    const revision = input.revision ?? readV07SelfplayPassiveAuditRevisionProvenance();
    const sourceSha256 = input.sourceSha256 ?? v07SelfplayPassiveAuditSourceSha256();
    const environment = input.environment ?? environmentContract("strict", {});
    const formalGitAttestation = input.formalGitAttestation
        ? {
              schemaVersion: input.formalGitAttestation.schemaVersion,
              revision: input.formalGitAttestation.revision,
              originMain: input.formalGitAttestation.originMain,
              liveOriginMain: input.formalGitAttestation.liveOriginMain,
              cleanIncludingUntracked: input.formalGitAttestation.cleanIncludingUntracked,
              statusPorcelainSha256: input.formalGitAttestation.statusPorcelainSha256,
          }
        : null;
    return fingerprintV07SelfplayPassiveAudit({
        runnerProtocol: V07_SELFPLAY_PASSIVE_AUDIT_RUNNER_PROTOCOL,
        auditCore: {
            version: V07_SELFPLAY_PASSIVE_AUDIT_VERSION,
            decisionIntents: V07_PASSIVE_DECISION_INTENTS,
            lapBands: V07_PASSIVE_LAP_BANDS,
        },
        planSha256: input.planSha256,
        shardGames: input.shardGames,
        maxLaps: input.maxLaps,
        revision,
        sourceSha256,
        environment,
        formalGitAttestation,
    });
}

function requireCount(value: number, name: string): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
}

export function validateV07SelfplayPassiveAuditShardPayload(
    payload: IV07SelfplayPassiveAuditShardPayload,
    spec: IV07SelfplayPassiveAuditShardSpec,
): IV07SelfplayPassiveAuditShardPayload {
    if (payload.schemaVersion !== 1) throw new Error(`Shard ${spec.id} payload schemaVersion must be 1`);
    if (payload.shardId !== spec.id || payload.shardSha256 !== spec.shardSha256) {
        throw new Error(`Shard ${spec.id} payload identity does not match its spec`);
    }
    const expectedGames = spec.gameEndExclusive - spec.gameStart;
    if (payload.games !== expectedGames || payload.tally.games !== expectedGames) {
        throw new Error(`Shard ${spec.id} payload game count does not match its range`);
    }
    if (payload.clusters.length !== expectedGames) {
        throw new Error(`Shard ${spec.id} has ${payload.clusters.length} clusters; expected ${expectedGames}`);
    }
    let decisions = 0;
    let skips = 0;
    let shields = 0;
    let rejectedActions = 0;
    let recoveryTurns = 0;
    for (let index = 0; index < payload.clusters.length; index += 1) {
        const cluster = payload.clusters[index];
        const expectedGame = spec.gameStart + index;
        const expectedSeed = spec.seeds[index];
        if (cluster.template !== spec.template || cluster.game !== expectedGame || cluster.seed !== expectedSeed) {
            throw new Error(
                `Shard ${spec.id} cluster ${index} does not match template/game/seed ${spec.template}/${expectedGame}/${expectedSeed}`,
            );
        }
        for (const [name, value] of Object.entries({
            decisions: cluster.decisions,
            skipIntents: cluster.skipIntents,
            shieldIntents: cluster.shieldIntents,
            passiveTurnsWithAttackCandidate: cluster.passiveTurnsWithAttackCandidate,
            passiveTurnsWithPositiveExpectedDamage: cluster.passiveTurnsWithPositiveExpectedDamage,
            actualUnitSkippedTurns: cluster.actualUnitSkippedTurns,
            explicitUnitDefendedTurns: cluster.explicitUnitDefendedTurns,
            recoveryTurns: cluster.recoveryTurns,
            recoveryDefendTurns: cluster.recoveryDefendTurns,
            recoveryAdvanceTurns: cluster.recoveryAdvanceTurns,
            recoveryFailedTurns: cluster.recoveryFailedTurns,
            rejectedTurns: cluster.rejectedTurns,
            rejectedActions: cluster.rejectedActions,
        })) {
            requireCount(value, `shard ${spec.id} cluster ${index} ${name}`);
        }
        if (cluster.skipIntents + cluster.shieldIntents > cluster.decisions) {
            throw new Error(`Shard ${spec.id} cluster ${index} has more passive intents than decisions`);
        }
        const passive = cluster.skipIntents + cluster.shieldIntents;
        if (
            cluster.passiveTurnsWithAttackCandidate > passive ||
            cluster.passiveTurnsWithPositiveExpectedDamage > cluster.passiveTurnsWithAttackCandidate
        ) {
            throw new Error(`Shard ${spec.id} cluster ${index} has impossible attack-opportunity counts`);
        }
        decisions += cluster.decisions;
        skips += cluster.skipIntents;
        shields += cluster.shieldIntents;
        rejectedActions += cluster.rejectedActions;
        recoveryTurns += cluster.recoveryTurns;
    }
    if (
        payload.tally.global.decisions !== decisions ||
        payload.tally.global.intents.skip !== skips ||
        payload.tally.global.intents.shield !== shields
    ) {
        throw new Error(`Shard ${spec.id} cluster policy counts do not reproduce its tally`);
    }
    if (
        payload.tally.integrity.rejectedActions !== rejectedActions ||
        payload.tally.integrity.recoveryTurns !== recoveryTurns
    ) {
        throw new Error(`Shard ${spec.id} cluster execution counts do not reproduce its integrity tally`);
    }
    for (const repro of payload.tally.integrity.reproSamples) {
        const index = repro.game - spec.gameStart;
        if (
            repro.template !== spec.template ||
            index < 0 ||
            index >= spec.seeds.length ||
            spec.seeds[index] !== repro.seed
        ) {
            throw new Error(`Shard ${spec.id} contains an integrity repro outside its template/range/seed`);
        }
    }
    return payload;
}

interface IBootstrapAccumulator {
    games: number;
    greenWins: number;
    decisions: number;
    skips: number;
    shields: number;
    attackCandidates: number;
    positiveExpectedDamage: number;
    actualSkipped: number;
    explicitDefended: number;
}

function emptyBootstrapAccumulator(): IBootstrapAccumulator {
    return {
        games: 0,
        greenWins: 0,
        decisions: 0,
        skips: 0,
        shields: 0,
        attackCandidates: 0,
        positiveExpectedDamage: 0,
        actualSkipped: 0,
        explicitDefended: 0,
    };
}

function addCluster(target: IBootstrapAccumulator, cluster: IV07SelfplayPassiveAuditCluster): void {
    target.games += 1;
    if (cluster.winner === "green") target.greenWins += 1;
    target.decisions += cluster.decisions;
    target.skips += cluster.skipIntents;
    target.shields += cluster.shieldIntents;
    target.attackCandidates += cluster.passiveTurnsWithAttackCandidate;
    target.positiveExpectedDamage += cluster.passiveTurnsWithPositiveExpectedDamage;
    target.actualSkipped += cluster.actualUnitSkippedTurns;
    target.explicitDefended += cluster.explicitUnitDefendedTurns;
}

function mergeBootstrapAccumulator(target: IBootstrapAccumulator, source: IBootstrapAccumulator): void {
    target.games += source.games;
    target.greenWins += source.greenWins;
    target.decisions += source.decisions;
    target.skips += source.skips;
    target.shields += source.shields;
    target.attackCandidates += source.attackCandidates;
    target.positiveExpectedDamage += source.positiveExpectedDamage;
    target.actualSkipped += source.actualSkipped;
    target.explicitDefended += source.explicitDefended;
}

function divide(numerator: number, denominator: number): number | null {
    return denominator ? numerator / denominator : null;
}

function bootstrapMetrics(tally: IBootstrapAccumulator): Record<V07SelfplayPassiveAuditBootstrapMetric, number | null> {
    const passive = tally.skips + tally.shields;
    return {
        skipShare: divide(tally.skips, tally.decisions),
        shieldShare: divide(tally.shields, tally.decisions),
        passiveShare: divide(passive, tally.decisions),
        attackCandidateShareOfPassive: divide(tally.attackCandidates, passive),
        positiveExpectedDamageShareOfPassive: divide(tally.positiveExpectedDamage, passive),
        actualUnitSkippedShare: divide(tally.actualSkipped, tally.decisions),
        explicitUnitDefendedShare: divide(tally.explicitDefended, tally.decisions),
        greenWinRate: divide(tally.greenWins, tally.games),
    };
}

function quantile(sorted: readonly number[], probability: number): number {
    if (!sorted.length) throw new Error("Cannot take a quantile of an empty sample");
    const position = (sorted.length - 1) * probability;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return sorted[lower];
    const weight = position - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
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

function bootstrapCohort(
    key: string,
    point: IBootstrapAccumulator,
    samples: Record<V07SelfplayPassiveAuditBootstrapMetric, number[]>,
): IV07SelfplayPassiveAuditBootstrapCohort {
    const pointMetrics = bootstrapMetrics(point);
    const metrics = Object.fromEntries(
        V07_SELFPLAY_PASSIVE_AUDIT_BOOTSTRAP_METRICS.map((metric) => {
            const values = samples[metric].sort((a, b) => a - b);
            return [
                metric,
                {
                    point: pointMetrics[metric],
                    confidence95: values.length
                        ? { low: quantile(values, 0.025), high: quantile(values, 0.975) }
                        : null,
                },
            ];
        }),
    ) as Record<V07SelfplayPassiveAuditBootstrapMetric, IV07SelfplayPassiveAuditBootstrapInterval>;
    return { key, games: point.games, metrics };
}

function emptyBootstrapSamples(): Record<V07SelfplayPassiveAuditBootstrapMetric, number[]> {
    return Object.fromEntries(
        V07_SELFPLAY_PASSIVE_AUDIT_BOOTSTRAP_METRICS.map((metric) => [metric, [] as number[]]),
    ) as unknown as Record<V07SelfplayPassiveAuditBootstrapMetric, number[]>;
}

function appendBootstrapSample(
    samples: Record<V07SelfplayPassiveAuditBootstrapMetric, number[]>,
    accumulator: IBootstrapAccumulator,
): void {
    const metrics = bootstrapMetrics(accumulator);
    for (const metric of V07_SELFPLAY_PASSIVE_AUDIT_BOOTSTRAP_METRICS) {
        const value = metrics[metric];
        if (value !== null) samples[metric].push(value);
    }
}

/** Resample complete games within each fixed-template cohort; turns are never treated as independent rows. */
export function bootstrapV07SelfplayPassiveAuditClusters(
    clusters: readonly IV07SelfplayPassiveAuditCluster[],
    replicates: number,
    runFingerprint: string,
): IV07SelfplayPassiveAuditBootstrapReport {
    positiveInteger(replicates, "bootstrap replicates");
    const seedSha256 = fingerprintV07SelfplayPassiveAudit({
        domain: "hoc/v0.7/selfplay-passive-audit/game-cluster-bootstrap/v1",
        runFingerprint,
        replicates,
    });
    const random = mulberry32(Number.parseInt(seedSha256.slice(0, 8), 16));
    const groups = new Map<V07ArchetypeTemplateName, IV07SelfplayPassiveAuditCluster[]>();
    for (const template of V07_ARCHETYPE_TEMPLATE_NAMES) groups.set(template, []);
    for (const cluster of clusters) {
        const group = groups.get(cluster.template);
        if (!group) throw new Error(`Bootstrap encountered unknown template ${cluster.template}`);
        if (cluster.archetype !== v07ArchetypeTemplate(cluster.template).archetype) {
            throw new Error(`Bootstrap cluster ${cluster.template}/${cluster.game} has the wrong archetype`);
        }
        group.push(cluster);
    }
    const aggregatePoint = emptyBootstrapAccumulator();
    const templatePoints = new Map<V07ArchetypeTemplateName, IBootstrapAccumulator>();
    const archetypePoints = new Map<V07Archetype, IBootstrapAccumulator>();
    const aggregateSamples = emptyBootstrapSamples();
    const templateSamples = new Map<V07ArchetypeTemplateName, ReturnType<typeof emptyBootstrapSamples>>();
    const archetypeSamples = new Map<V07Archetype, ReturnType<typeof emptyBootstrapSamples>>();
    for (const archetype of V07_ARCHETYPES) {
        archetypePoints.set(archetype, emptyBootstrapAccumulator());
        archetypeSamples.set(archetype, emptyBootstrapSamples());
    }
    for (const template of V07_ARCHETYPE_TEMPLATE_NAMES) {
        const group = groups.get(template)!;
        if (!group.length) throw new Error(`Bootstrap has no games for ${template}`);
        const point = emptyBootstrapAccumulator();
        for (const cluster of group) addCluster(point, cluster);
        templatePoints.set(template, point);
        templateSamples.set(template, emptyBootstrapSamples());
        mergeBootstrapAccumulator(archetypePoints.get(v07ArchetypeTemplate(template).archetype)!, point);
        mergeBootstrapAccumulator(aggregatePoint, point);
    }
    for (let replicate = 0; replicate < replicates; replicate += 1) {
        const aggregate = emptyBootstrapAccumulator();
        const archetypes = new Map<V07Archetype, IBootstrapAccumulator>(
            V07_ARCHETYPES.map((archetype) => [archetype, emptyBootstrapAccumulator()]),
        );
        for (const template of V07_ARCHETYPE_TEMPLATE_NAMES) {
            const group = groups.get(template)!;
            const sample = emptyBootstrapAccumulator();
            for (let draw = 0; draw < group.length; draw += 1) {
                addCluster(sample, group[Math.floor(random() * group.length)]);
            }
            appendBootstrapSample(templateSamples.get(template)!, sample);
            mergeBootstrapAccumulator(archetypes.get(v07ArchetypeTemplate(template).archetype)!, sample);
            mergeBootstrapAccumulator(aggregate, sample);
        }
        for (const archetype of V07_ARCHETYPES) {
            appendBootstrapSample(archetypeSamples.get(archetype)!, archetypes.get(archetype)!);
        }
        appendBootstrapSample(aggregateSamples, aggregate);
    }
    return {
        method: "stratified nonparametric game-cluster percentile bootstrap",
        confidenceLevel: 0.95,
        replicates,
        deterministicSeedSha256: seedSha256,
        aggregate: bootstrapCohort("aggregate", aggregatePoint, aggregateSamples),
        byArchetypeCohort: V07_ARCHETYPES.map((archetype) =>
            bootstrapCohort(archetype, archetypePoints.get(archetype)!, archetypeSamples.get(archetype)!),
        ),
        byTemplate: V07_ARCHETYPE_TEMPLATE_NAMES.map((template) =>
            bootstrapCohort(template, templatePoints.get(template)!, templateSamples.get(template)!),
        ),
    };
}

export interface IV07SelfplayPassiveAuditRunOptions {
    plan: IV07SelfplayPassiveAuditSeedPlan;
    checkpointDir: string;
    shardGames?: number;
    concurrency?: number;
    maxLaps?: number;
    bootstrapReplicates?: number;
    revision?: IRevisionProvenance;
    sourceSha256?: string;
    environmentMode?: V07SelfplayPassiveAuditEnvironmentMode;
    formalGitAttestation?: IV07SelfplayPassiveAuditFormalGitAttestation;
    onShard?: (completed: number, total: number, resumed: boolean, spec: IV07SelfplayPassiveAuditShardSpec) => void;
}

interface IWorkerResultMessage {
    type: "result";
    shardId: string;
    payload: IV07SelfplayPassiveAuditShardPayload;
}

interface IWorkerErrorMessage {
    type: "error";
    shardId: string;
    error: string;
}

async function computeMissingShards(
    specs: readonly IV07SelfplayPassiveAuditShardSpec[],
    payloads: Map<string, IV07SelfplayPassiveAuditShardPayload>,
    options: {
        concurrency: number;
        maxLaps?: number;
        checkpointDir: string;
        runFingerprint: string;
        onShard?: IV07SelfplayPassiveAuditRunOptions["onShard"];
    },
): Promise<void> {
    const pending = specs.filter((spec) => !payloads.has(spec.id));
    if (!pending.length) return;
    const poolSize = Math.min(options.concurrency, pending.length);
    await new Promise<void>((resolvePromise, rejectPromise) => {
        const workers: Worker[] = [];
        const assignments = new Map<Worker, IV07SelfplayPassiveAuditShardSpec>();
        let next = 0;
        let computed = 0;
        let settled = false;
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
            if (next >= pending.length) {
                assignments.delete(worker);
                worker.postMessage({ type: "stop" });
                return;
            }
            const spec = pending[next++];
            assignments.set(worker, spec);
            worker.postMessage({ type: "run", shard: spec });
        };
        const workerUrl = new URL("./v0_7_selfplay_passive_audit_worker.ts", import.meta.url);
        for (let index = 0; index < poolSize; index += 1) {
            let worker: Worker;
            try {
                worker = new Worker(workerUrl, { workerData: { maxLaps: options.maxLaps } });
            } catch (error) {
                fail(error);
                return;
            }
            workers.push(worker);
            worker.on("message", (message: { type: "ready" } | IWorkerResultMessage | IWorkerErrorMessage) => {
                if (settled) return;
                if (message.type === "error") {
                    fail(new Error(`Shard ${message.shardId} worker failed:\n${message.error}`));
                    return;
                }
                if (message.type === "ready") {
                    dispatch(worker);
                    return;
                }
                const expected = assignments.get(worker);
                if (!expected || message.shardId !== expected.id) {
                    fail(new Error(`Worker returned unexpected shard ${message.shardId}`));
                    return;
                }
                try {
                    const payload = validateV07SelfplayPassiveAuditShardPayload(message.payload, expected);
                    saveV07SelfplayPassiveAuditCheckpoint(
                        options.checkpointDir,
                        expected,
                        options.runFingerprint,
                        payload,
                    );
                    payloads.set(expected.id, payload);
                    computed += 1;
                    options.onShard?.(payloads.size, specs.length, false, expected);
                } catch (error) {
                    fail(error);
                    return;
                }
                if (computed === pending.length) {
                    settled = true;
                    cleanup();
                    resolvePromise();
                    return;
                }
                dispatch(worker);
            });
            worker.on("error", fail);
            worker.on("exit", (code) => {
                if (!settled && code !== 0 && assignments.has(worker)) {
                    fail(new Error(`Passive-audit worker exited with code ${code}`));
                }
            });
        }
    });
}

function externalSeedSchedule(
    plan: IV07SelfplayPassiveAuditSeedPlan,
    maxLaps: number | undefined,
): IV07SelfplayPassiveAuditSeedSchedule {
    return {
        schemaVersion: 1,
        algorithm: V07_SELFPLAY_PASSIVE_AUDIT_SEED_CONSTRUCTION,
        domain: V07_SELFPLAY_PASSIVE_AUDIT_SEED_DOMAIN,
        gamesPerTemplate: plan.gamesPerTemplate,
        totalGames: plan.totalGames,
        collisionRejections: plan.collisionAudit.rejectedCandidates,
        deniedSeedCount: 0,
        freshnessClaim: "unique_within_run_only",
        corpusLabel: "HMAC-derived deterministic v0.7 self-play panel, unique in-run; prior corpora were not scanned",
        specs: plan.templates.flatMap(({ template, seeds }) =>
            seeds.map((seed, game) => ({ template, game, seed, maxLaps })),
        ),
    };
}

function reduceV07SelfplayPassiveAudit(
    plan: IV07SelfplayPassiveAuditSeedPlan,
    specs: readonly IV07SelfplayPassiveAuditShardSpec[],
    payloads: ReadonlyMap<string, IV07SelfplayPassiveAuditShardPayload>,
    input: {
        checkpointDir: string;
        shardGames: number;
        resumedShards: number;
        maxLaps?: number;
        bootstrapReplicates: number;
        runFingerprint: string;
        sourceSha256: string;
        revision: IRevisionProvenance;
        environment: IV07SelfplayPassiveAuditEnvironmentContract;
        formalGitAttestation: IV07SelfplayPassiveAuditFormalGitAttestation | null;
    },
): IV07SelfplayPassiveAuditRunSummary {
    if (payloads.size !== specs.length) {
        throw new Error(`Reducer has ${payloads.size} shard payloads; expected ${specs.length}`);
    }
    const tally = createV07SelfplayPassiveAuditTally();
    const clusters: IV07SelfplayPassiveAuditCluster[] = [];
    const seenSeeds = new Set<number>();
    const coverage = Object.fromEntries(V07_ARCHETYPE_TEMPLATE_NAMES.map((template) => [template, 0])) as Record<
        V07ArchetypeTemplateName,
        number
    >;
    const index = specs.map((spec) => {
        const rawPayload = payloads.get(spec.id);
        if (!rawPayload) throw new Error(`Reducer is missing shard ${spec.id}`);
        const payload = validateV07SelfplayPassiveAuditShardPayload(rawPayload, spec);
        mergeV07SelfplayPassiveAuditTallies(tally, payload.tally);
        for (const cluster of payload.clusters) {
            if (seenSeeds.has(cluster.seed)) throw new Error(`Reducer encountered duplicate seed ${cluster.seed}`);
            seenSeeds.add(cluster.seed);
            coverage[cluster.template] += 1;
            clusters.push(cluster);
        }
        return {
            id: spec.id,
            template: spec.template,
            gameStart: spec.gameStart,
            gameEndExclusive: spec.gameEndExclusive,
            seedsSha256: spec.seedsSha256,
            shardSha256: spec.shardSha256,
            payloadSha256: fingerprintV07SelfplayPassiveAudit(payload),
        };
    });
    if (tally.games !== plan.totalGames || clusters.length !== plan.totalGames || seenSeeds.size !== plan.totalGames) {
        throw new Error(
            `Reducer coverage mismatch: tally=${tally.games}, clusters=${clusters.length}, uniqueSeeds=${seenSeeds.size}, expected=${plan.totalGames}`,
        );
    }
    for (const template of V07_ARCHETYPE_TEMPLATE_NAMES) {
        if (coverage[template] !== plan.gamesPerTemplate) {
            throw new Error(
                `Reducer coverage for ${template} is ${coverage[template]}; expected ${plan.gamesPerTemplate}`,
            );
        }
    }
    if (tally.ignoredStrategyTurns) {
        throw new Error(`Reducer observed ${tally.ignoredStrategyTurns} non-v0.7 strategy turns`);
    }
    const clusterRejectedActions = clusters.reduce((sum, cluster) => sum + cluster.rejectedActions, 0);
    const clusterRecoveryTurns = clusters.reduce((sum, cluster) => sum + cluster.recoveryTurns, 0);
    if (
        clusterRejectedActions !== tally.integrity.rejectedActions ||
        clusterRecoveryTurns !== tally.integrity.recoveryTurns
    ) {
        throw new Error("Reducer cluster execution counts do not match the merged integrity tally");
    }
    const recoveryDefendTurns = clusters.reduce((sum, cluster) => sum + cluster.recoveryDefendTurns, 0);
    const recoveryAdvanceTurns = clusters.reduce((sum, cluster) => sum + cluster.recoveryAdvanceTurns, 0);
    const recoveryFailedTurns = clusters.reduce((sum, cluster) => sum + cluster.recoveryFailedTurns, 0);
    const integrityGate: IV07SelfplayPassiveAuditIntegrityGate = {
        status: tally.integrity.rejectedActions === 0 && tally.integrity.recoveryTurns === 0 ? "pass" : "fail",
        policy: "zero rejected strategy actions and zero simulator recovery turns",
        rejectedActions: tally.integrity.rejectedActions,
        recoveryTurns: tally.integrity.recoveryTurns,
        recoveryDefendTurns,
        recoveryAdvanceTurns,
        recoveryFailedTurns,
        reproSamples: tally.integrity.reproSamples,
        note: "recovery is diagnostic only and excluded from policy skip/shield ratios",
    };
    const diagnostic = finalizeV07SelfplayPassiveAudit(
        {
            gamesPerTemplate: plan.gamesPerTemplate,
            seedDomain: V07_SELFPLAY_PASSIVE_AUDIT_SEED_DOMAIN,
            maxLaps: input.maxLaps,
        },
        tally,
        externalSeedSchedule(plan, input.maxLaps),
    );
    const gameClusterBootstrap = bootstrapV07SelfplayPassiveAuditClusters(
        clusters,
        input.bootstrapReplicates,
        input.runFingerprint,
    );
    return {
        schemaVersion: 1,
        status: "v0.7_selfplay_passive_audit_complete",
        runFingerprint: input.runFingerprint,
        sourceSha256: input.sourceSha256,
        revision: input.revision,
        environment: input.environment,
        formalGitAttestation: input.formalGitAttestation,
        runnerProtocol: V07_SELFPLAY_PASSIVE_AUDIT_RUNNER_PROTOCOL,
        seedPlan: {
            construction: plan.construction,
            domain: plan.domain,
            seedKey: plan.seedKey,
            seedKeySha256: plan.seedKeySha256,
            gamesPerTemplate: plan.gamesPerTemplate,
            totalGames: plan.totalGames,
            collisionAudit: plan.collisionAudit,
            sortedSeedSetSha256: plan.sortedSeedSetSha256,
            freshness: plan.freshness,
            planSha256: plan.planSha256,
            templates: plan.templates.map(({ template, seeds, seedsSha256 }) => ({
                template,
                games: seeds.length,
                seedsSha256,
            })),
        },
        checkpoints: {
            directory: input.checkpointDir,
            shardGames: input.shardGames,
            shards: specs.length,
            resumedShards: input.resumedShards,
            computedShards: specs.length - input.resumedShards,
            indexSha256: fingerprintV07SelfplayPassiveAudit(index),
            index,
        },
        coverage: {
            expectedGames: plan.totalGames,
            reducedGames: tally.games,
            uniqueSeeds: seenSeeds.size,
            duplicateSeeds: 0,
            templates: coverage,
        },
        integrityGate,
        gameClusterBootstrap,
        diagnostic,
    };
}

export async function runV07SelfplayPassiveAudit(
    options: IV07SelfplayPassiveAuditRunOptions,
): Promise<IV07SelfplayPassiveAuditRunSummary> {
    const environment = resolveV07SelfplayPassiveAuditEnvironment(options.environmentMode ?? "strict");
    const plan = validateV07SelfplayPassiveAuditSeedPlan(options.plan);
    const shardGames = positiveInteger(
        options.shardGames ?? V07_SELFPLAY_PASSIVE_AUDIT_RUNNER_PROTOCOL.shardGames,
        "shardGames",
    );
    const concurrency = positiveInteger(
        options.concurrency ?? V07_SELFPLAY_PASSIVE_AUDIT_RUNNER_PROTOCOL.defaultConcurrency,
        "concurrency",
    );
    const bootstrapReplicates = positiveInteger(options.bootstrapReplicates ?? 1000, "bootstrapReplicates");
    if (options.maxLaps !== undefined) positiveInteger(options.maxLaps, "maxLaps");
    const formalGitAttestation = options.formalGitAttestation
        ? assertV07SelfplayPassiveAuditFormalGitAttestation(options.formalGitAttestation)
        : null;
    const revision =
        options.revision ?? formalGitAttestation?.revision ?? readV07SelfplayPassiveAuditRevisionProvenance();
    if (formalGitAttestation && revision.commit !== formalGitAttestation.revision.commit) {
        throw new Error("Explicit revision does not match the formal common git attestation");
    }
    const sourceSha256 = options.sourceSha256 ?? v07SelfplayPassiveAuditSourceSha256();
    const specs = buildV07SelfplayPassiveAuditShardSpecs(plan, shardGames);
    const runFingerprint = v07SelfplayPassiveAuditRunFingerprint({
        planSha256: plan.planSha256,
        shardGames,
        maxLaps: options.maxLaps ?? null,
        revision,
        sourceSha256,
        environment,
        formalGitAttestation,
    });
    const payloads = new Map<string, IV07SelfplayPassiveAuditShardPayload>();
    for (const spec of specs) {
        const payload = loadV07SelfplayPassiveAuditCheckpoint<IV07SelfplayPassiveAuditShardPayload>(
            options.checkpointDir,
            spec,
            runFingerprint,
        );
        if (!payload) continue;
        payloads.set(spec.id, validateV07SelfplayPassiveAuditShardPayload(payload, spec));
        options.onShard?.(payloads.size, specs.length, true, spec);
    }
    const resumedShards = payloads.size;
    await computeMissingShards(specs, payloads, {
        concurrency,
        maxLaps: options.maxLaps,
        checkpointDir: options.checkpointDir,
        runFingerprint,
        onShard: options.onShard,
    });
    return reduceV07SelfplayPassiveAudit(plan, specs, payloads, {
        checkpointDir: options.checkpointDir,
        shardGames,
        resumedShards,
        maxLaps: options.maxLaps,
        bootstrapReplicates,
        runFingerprint,
        sourceSha256,
        revision,
        environment,
        formalGitAttestation,
    });
}

function printUsage(): void {
    console.log(
        "usage: bun src/simulation/run_v0_7_selfplay_passive_audit.ts " +
            "[--output sim-out/v0_7_selfplay_passive_audit_100k.summary.json] " +
            "[--checkpoint-dir sim-out/v0_7_selfplay_passive_audit_100k.checkpoints] " +
            "[--concurrency 12] [--bootstrap-replicates 1000] [--seed-key KEY]",
    );
}

function percent(value: number): string {
    return `${(value * 100).toFixed(3)}%`;
}

function printHumanSummary(summary: IV07SelfplayPassiveAuditRunSummary): void {
    const aggregate = summary.diagnostic.aggregate;
    const skipToShield =
        aggregate.skipToShieldRatio === null
            ? "n/a (no shield intents)"
            : `${aggregate.skipToShieldRatio.toFixed(3)}:1`;
    console.error(
        `Policy turns: ${aggregate.decisions.toLocaleString()}; skip ${percent(aggregate.skipShare)}, ` +
            `shield ${percent(aggregate.shieldShare)}; skip:shield ${skipToShield}.`,
    );
    const passive = aggregate.intents.skip + aggregate.intents.shield;
    const attacks = aggregate.skip.turnsWithCandidate + aggregate.shield.turnsWithCandidate;
    const positive = aggregate.skip.turnsWithPositiveExpectedDamage + aggregate.shield.turnsWithPositiveExpectedDamage;
    console.error(
        `Passive turns: ${passive.toLocaleString()}; legal attack candidate ${percent(passive ? attacks / passive : 0)}, ` +
            `positive expected damage ${percent(passive ? positive / passive : 0)}.`,
    );
    for (const cohort of summary.diagnostic.byTemplate) {
        const cohortPassive = cohort.intents.skip + cohort.intents.shield;
        const cohortAttacks = cohort.skip.turnsWithCandidate + cohort.shield.turnsWithCandidate;
        console.error(
            `  ${cohort.key}: skip ${percent(cohort.skipShare)}, shield ${percent(cohort.shieldShare)}, ` +
                `attack on passive ${percent(cohortPassive ? cohortAttacks / cohortPassive : 0)}`,
        );
    }
    console.error(
        `Integrity ${summary.integrityGate.status.toUpperCase()}: ${summary.integrityGate.rejectedActions} rejected actions, ` +
            `${summary.integrityGate.recoveryTurns} recovery turns.`,
    );
}

export async function main(): Promise<void> {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            output: { type: "string" },
            "checkpoint-dir": { type: "string" },
            "games-per-template": {
                type: "string",
                default: String(V07_SELFPLAY_PASSIVE_AUDIT_RUNNER_PROTOCOL.gamesPerTemplate),
            },
            "shard-games": { type: "string", default: String(V07_SELFPLAY_PASSIVE_AUDIT_RUNNER_PROTOCOL.shardGames) },
            concurrency: {
                type: "string",
                default: String(
                    Math.min(
                        V07_SELFPLAY_PASSIVE_AUDIT_RUNNER_PROTOCOL.defaultConcurrency,
                        Math.max(1, availableParallelism()),
                    ),
                ),
            },
            "seed-key": { type: "string", default: V07_SELFPLAY_PASSIVE_AUDIT_DEFAULT_SEED_KEY },
            "max-laps": { type: "string" },
            "bootstrap-replicates": { type: "string", default: "1000" },
            help: { type: "boolean", short: "h", default: false },
        },
        strict: true,
        allowPositionals: false,
    });
    if (values.help) {
        printUsage();
        return;
    }
    assertV07SelfplayPassiveAuditEnvironment();
    const gamesPerTemplate = positiveInteger(Number(values["games-per-template"]), "--games-per-template");
    const shardGames = positiveInteger(Number(values["shard-games"]), "--shard-games");
    const concurrency = positiveInteger(Number(values.concurrency), "--concurrency");
    const bootstrapReplicates = positiveInteger(Number(values["bootstrap-replicates"]), "--bootstrap-replicates");
    if (values["max-laps"] !== undefined) {
        throw new Error("The formal 100k CLI does not allow --max-laps; use the programmatic API for small tests");
    }
    if (
        gamesPerTemplate !== V07_SELFPLAY_PASSIVE_AUDIT_RUNNER_PROTOCOL.gamesPerTemplate ||
        shardGames !== V07_SELFPLAY_PASSIVE_AUDIT_RUNNER_PROTOCOL.shardGames
    ) {
        throw new Error(
            "The formal CLI requires --games-per-template 12500 and --shard-games 500; use runV07SelfplayPassiveAudit for small tests",
        );
    }
    const formalGitAttestation = readV07SelfplayPassiveAuditFormalGitAttestation();
    const revision = formalGitAttestation.revision;
    const plan = buildV07SelfplayPassiveAuditSeedPlan({ gamesPerTemplate, seedKey: values["seed-key"] });
    const shards = buildV07SelfplayPassiveAuditShardSpecs(plan, shardGames);
    const defaultOutput = join(process.cwd(), "sim-out", "v0_7_selfplay_passive_audit_100k.summary.json");
    const outputPath = values.output === "-" ? "-" : resolve(values.output ?? defaultOutput);
    const checkpointDir = resolve(
        values["checkpoint-dir"] ??
            (outputPath === "-"
                ? join(process.cwd(), "sim-out", "v0_7_selfplay_passive_audit_100k.checkpoints")
                : `${outputPath}.checkpoints`),
    );
    process.env.SIM_NO_ACTIONS = "1";
    console.error(
        `Prepared ${plan.totalGames.toLocaleString()} v0.7 self-play games in ${shards.length} shards ` +
            `(${concurrency} workers; plan ${plan.planSha256.slice(0, 12)}...).`,
    );
    console.error(`Checkpoints: ${checkpointDir}`);
    console.error(
        "Seed attestation covers internal uniqueness only; these seeds were not checked against prior experiment corpora.",
    );
    let lastReported = -1;
    const summary = await runV07SelfplayPassiveAudit({
        plan,
        checkpointDir,
        shardGames,
        concurrency,
        bootstrapReplicates,
        revision,
        formalGitAttestation,
        onShard: (completed, total, resumed) => {
            if (completed === total || completed - lastReported >= 10) {
                console.error(`  ${completed}/${total} shards${resumed ? " (resuming checkpoints)" : ""}`);
                lastReported = completed;
            }
        },
    });
    const completedGitAttestation = readV07SelfplayPassiveAuditFormalGitAttestation();
    if (
        fingerprintV07SelfplayPassiveAudit(completedGitAttestation) !==
        fingerprintV07SelfplayPassiveAudit(formalGitAttestation)
    ) {
        throw new Error("The common repository provenance changed during the formal 100k audit");
    }
    const encoded = `${JSON.stringify(summary, null, 2)}\n`;
    if (outputPath === "-") process.stdout.write(encoded);
    else writeAtomic(outputPath, encoded);
    printHumanSummary(summary);
    if (outputPath !== "-") console.error(`Summary: ${outputPath}`);
    if (summary.integrityGate.status === "fail") {
        throw new Error(
            `Integrity gate failed: ${summary.integrityGate.rejectedActions} rejected strategy action(s), ` +
                `${summary.integrityGate.recoveryTurns} simulator recovery turn(s); summary was preserved`,
        );
    }
}

if ((import.meta as unknown as { main?: boolean }).main) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
