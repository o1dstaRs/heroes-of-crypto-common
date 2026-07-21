/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { arch, availableParallelism, hostname, platform, release } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";

import {
    buildV08TestCandidateEnvironment,
    V08_TEST_CANDIDATE_OPERATIONAL_ENVIRONMENT_SHA256,
    V08_TEST_CANDIDATE_OPERATIONAL_POLICY_BINDING,
    V08_TEST_CANDIDATE_OPERATIONAL_POLICY_SHA256,
    V08_TEST_CANDIDATE_OPERATIONAL_SOURCE_BUNDLE_SHA256,
    V08_TEST_CANDIDATE_OPERATIONAL_SOURCE_FILES,
    V08_TEST_CANDIDATE_PROFILE,
    V08_TEST_CANDIDATE_SOURCE_AUDIT_PATH,
    type V08TestCandidateTimingMode,
} from "../ai/versions/v0_8_candidate_profile";
import { fingerprintV08AlignedV1 } from "./optimizer/v0_8_aligned_96h_v1_protocol";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");
const TOURNAMENT_RUNNER = join(REPOSITORY_ROOT, "src/simulation/run_tournament.ts");
const LEVEL4_RUNNER = join(REPOSITORY_ROOT, "src/simulation/v0_8_l4_coverage.ts");

export const V08_CANDIDATE_RUN_MANIFEST_SCHEMA = "hoc.v0_8_candidate_run.v1" as const;
export const V08_CANDIDATE_ARMAGEDDON_RATE_GATE = 0.001 as const;
export const V08_CANDIDATE_DECISIVE_WIN_RATE_GATE = 0.54 as const;
export const V08_CANDIDATE_MINIMUM_QUALIFICATION_GAMES = 6000 as const;

const RUN_MANIFEST_NAME = "v0.8-candidate.run-manifest.json";
const SEARCH_AUDIT_NAME = "v0.8-candidate.search-audit.jsonl";
const ALLOWED_MAPS = ["normal", "water", "lava", "block"] as const;
const ALLOWED_MAP_SET: ReadonlySet<string> = new Set(ALLOWED_MAPS);
const LEVEL4_MAP_TYPES = [1, 2, 3, 4] as const;
const LEVEL4_UNITS = ["Champion", "Arachna Queen", "Abomination", "Frenzied Boar"] as const;
const LEVEL4_LANES = LEVEL4_UNITS.flatMap((unit) => [
    { unit, owner: "candidate" as const },
    { unit, owner: "opponent" as const },
]);

/** Only execution essentials survive. No inherited experiment, roster, preload, or unknown behavior knob can. */
const INHERITED_OS_ENVIRONMENT_KEYS = [
    "PATH",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
] as const;

export interface IV08CandidateTournamentOptions {
    games: number;
    baseSeed: number;
    output: string;
    concurrency: number;
    timingMode: V08TestCandidateTimingMode;
    maps: string;
}

export interface IV08CandidateLevel4Options {
    pairsPerLane: number;
    baseSeed: number;
    output: string;
    concurrency: number;
    timingMode: V08TestCandidateTimingMode;
}

export interface IV08CandidateInvocation {
    args: string[];
    environment: NodeJS.ProcessEnv;
    candidateEnvironment: Readonly<Record<string, string>>;
    candidateEnvironmentSha256: string;
    auditPath: string;
    output: string;
    maps: readonly string[];
}

export interface IV08CandidateOperationalIdentity {
    sourceFiles: Readonly<Record<string, string>>;
    sourceBundleSha256: string;
    operationalEnvironmentSha256: string;
    policySha256: string;
}

export interface IV08CandidateQualificationGate {
    passed: boolean | null;
    observed: unknown;
    requirement: string;
}

export interface IV08CandidateQualificationVerdict {
    status: "passed" | "failed" | "incomplete";
    operationalQualificationPassed: boolean;
    /** This runner can validate evidence, but the immutable test-only profile can never self-promote. */
    promotionEligible: false;
    nonPromotableReasons: readonly string[];
    gates: Readonly<Record<string, IV08CandidateQualificationGate>>;
}

export interface IV08CandidateTournamentRawEvidence {
    games: number;
    uniqueGames: number;
    armageddonReached: number;
    rejectedCandidate: number;
}

export interface IV08CandidateTournamentSummaryEvidence {
    versionA: string;
    versionB: string;
    games: number;
    baseSeed: number;
    a: { version: string; wins: number };
    b: { version: string; wins: number };
    draws: number;
    winRateA: number;
    endReasons: Record<string, number>;
    armageddonDecided: number;
}

export interface IV08CandidateLevel4RecordEvidence {
    schema: string;
    game: number;
    cycle: number;
    seed: number;
    mapType: number;
    lane: { unit: string; owner: string };
    candidateVersion: string;
    opponentVersion: string;
    candidateSide: string;
    targetSide: string;
    endReason: string;
    rejectedCandidate: number;
    target: {
        appearances: number;
        actingTurns: number;
        rawEndTurnDecisions: number;
    };
    armageddon: { reached: boolean };
}

export interface IV08CandidateLevel4SummaryEvidence {
    schema: string;
    candidateVersion: string;
    opponentVersion: string;
    baseSeed: number;
    pairsPerLane: number;
    games: number;
    lanes: Array<{
        lane: { unit: string; owner: string };
        games: number;
        appearances: number;
        actingTurns: number;
        rejectedCandidate: number;
        rawEndTurnDecisions: number;
        armageddonReached: number;
    }>;
}

export type V08CandidateRunGeometry =
    | {
          kind: "tournament";
          games: number;
          baseSeed: number;
          concurrency: number;
          maps: readonly string[];
      }
    | {
          kind: "level4";
          pairsPerLane: number;
          games: number;
          baseSeed: number;
          concurrency: number;
          maps: readonly string[];
      };

const positiveInteger = (value: number, name: string): number => {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
    return value;
};

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

async function sha256File(path: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk as Uint8Array);
    return hash.digest("hex");
}

export function normalizeV08CandidateMaps(raw: string): string {
    const maps = raw
        .split(",")
        .map((map) => map.trim().toLowerCase())
        .filter(Boolean);
    if (!maps.length) throw new Error("maps must contain at least one live map");
    const seen = new Set<string>();
    for (const map of maps) {
        if (!ALLOWED_MAP_SET.has(map)) {
            throw new Error(`unknown map \"${map}\"; allowed maps: ${ALLOWED_MAPS.join(",")}`);
        }
        if (seen.has(map)) throw new Error(`duplicate map \"${map}\"`);
        seen.add(map);
    }
    return maps.join(",");
}

function minimalChildEnvironment(sourceEnvironment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    for (const key of INHERITED_OS_ENVIRONMENT_KEYS) {
        const value = sourceEnvironment[key];
        if (value !== undefined) environment[key] = value;
    }
    // Avoid stale transpiler-cache artifacts while keeping the setting independent of policy identity.
    environment.BUN_RUNTIME_TRANSPILER_CACHE_PATH = "0";
    return environment;
}

/**
 * Fail closed if a reviewed policy source, the plain-v0.8 environment, or the composite identity drifted.
 * The error deliberately says repin: changing an Armageddon/ranged policy without a new revision must not run.
 */
export function verifyV08CandidateOperationalIdentity(
    repositoryRoot: string = REPOSITORY_ROOT,
    readSourceFile: (path: string) => Uint8Array = (path) => readFileSync(path),
): IV08CandidateOperationalIdentity {
    const actualSourceFiles = Object.fromEntries(
        Object.keys(V08_TEST_CANDIDATE_OPERATIONAL_SOURCE_FILES).map((relativePath) => [
            relativePath,
            sha256(readSourceFile(resolve(repositoryRoot, relativePath))),
        ]),
    );
    for (const [relativePath, expected] of Object.entries(V08_TEST_CANDIDATE_OPERATIONAL_SOURCE_FILES)) {
        const actual = actualSourceFiles[relativePath];
        if (actual !== expected) {
            throw new Error(
                `v0.8 operational source drifted at ${relativePath}: expected ${expected}, got ${actual}; ` +
                    "review the behavior, bump the operational revision, and repin",
            );
        }
    }
    const sourceBundleSha256 = fingerprintV08AlignedV1(actualSourceFiles);
    if (sourceBundleSha256 !== V08_TEST_CANDIDATE_OPERATIONAL_SOURCE_BUNDLE_SHA256) {
        throw new Error("v0.8 operational source bundle fingerprint drifted; reviewed revision repin required");
    }
    const operationalEnvironmentSha256 = fingerprintV08AlignedV1(
        buildV08TestCandidateEnvironment({
            auditPath: V08_TEST_CANDIDATE_SOURCE_AUDIT_PATH,
            timingMode: "operational_bounded",
            candidateVersion: V08_TEST_CANDIDATE_PROFILE.operationalCandidateVersion,
        }),
    );
    if (operationalEnvironmentSha256 !== V08_TEST_CANDIDATE_OPERATIONAL_ENVIRONMENT_SHA256) {
        throw new Error("v0.8 plain operational environment fingerprint drifted; reviewed revision repin required");
    }
    const policySha256 = fingerprintV08AlignedV1(V08_TEST_CANDIDATE_OPERATIONAL_POLICY_BINDING);
    if (policySha256 !== V08_TEST_CANDIDATE_OPERATIONAL_POLICY_SHA256) {
        throw new Error("v0.8 operational policy fingerprint drifted; reviewed revision repin required");
    }
    return {
        sourceFiles: Object.freeze(actualSourceFiles),
        sourceBundleSha256,
        operationalEnvironmentSha256,
        policySha256,
    };
}

/** Reject evidence contamination without deleting or overwriting anything. */
export function prepareV08CandidateOutputDirectory(output: string): string {
    const resolved = resolve(output);
    if (existsSync(resolved)) {
        if (!statSync(resolved).isDirectory()) throw new Error(`v0.8 candidate output is not a directory: ${resolved}`);
        const existing = readdirSync(resolved);
        if (existing.length) {
            throw new Error(`v0.8 candidate output must be empty; found ${existing.length} entries in ${resolved}`);
        }
    } else {
        mkdirSync(resolved, { recursive: true });
    }
    return resolved;
}

/** Build an exact child invocation without mutating this process or inheriting stale behavior knobs. */
export function buildV08CandidateTournamentInvocation(
    options: IV08CandidateTournamentOptions,
    sourceEnvironment: NodeJS.ProcessEnv = process.env,
): IV08CandidateInvocation {
    positiveInteger(options.games, "games");
    positiveInteger(options.concurrency, "concurrency");
    if (!Number.isSafeInteger(options.baseSeed) || options.baseSeed < 0 || options.baseSeed > 0xffffffff) {
        throw new Error("baseSeed must be a uint32");
    }
    const maps = normalizeV08CandidateMaps(options.maps);
    const output = resolve(options.output);
    const auditPath = join(output, SEARCH_AUDIT_NAME);
    const candidateEnvironment = buildV08TestCandidateEnvironment({
        auditPath,
        timingMode: options.timingMode,
        candidateVersion: V08_TEST_CANDIDATE_PROFILE.operationalCandidateVersion,
    });
    const environment = minimalChildEnvironment(sourceEnvironment);
    Object.assign(environment, candidateEnvironment);

    return {
        args: [
            TOURNAMENT_RUNNER,
            V08_TEST_CANDIDATE_PROFILE.operationalCandidateVersion,
            V08_TEST_CANDIDATE_PROFILE.opponentVersion,
            String(options.games),
            String(options.baseSeed),
            output,
            String(Math.min(options.concurrency, options.games)),
            `--maps=${maps}`,
            "--livetwin",
        ],
        environment,
        candidateEnvironment,
        candidateEnvironmentSha256: fingerprintV08AlignedV1(candidateEnvironment),
        auditPath,
        output,
        maps: maps.split(","),
    };
}

/** Build the same pinned policy for all four new L4 units, both owners, and both physical seats. */
export function buildV08CandidateLevel4Invocation(
    options: IV08CandidateLevel4Options,
    sourceEnvironment: NodeJS.ProcessEnv = process.env,
): IV08CandidateInvocation {
    positiveInteger(options.pairsPerLane, "pairsPerLane");
    const tournament = buildV08CandidateTournamentInvocation(
        {
            games: options.pairsPerLane * 16,
            baseSeed: options.baseSeed,
            output: options.output,
            concurrency: options.concurrency,
            timingMode: options.timingMode,
            maps: "normal,water,lava,block",
        },
        sourceEnvironment,
    );
    return {
        ...tournament,
        args: [
            LEVEL4_RUNNER,
            V08_TEST_CANDIDATE_PROFILE.operationalCandidateVersion,
            V08_TEST_CANDIDATE_PROFILE.opponentVersion,
            String(options.pairsPerLane),
            String(options.baseSeed),
            tournament.output,
            String(Math.min(options.concurrency, options.pairsPerLane * 16)),
        ],
    };
}

const gate = (passed: boolean | null, observed: unknown, requirement: string): IV08CandidateQualificationGate => ({
    passed,
    observed,
    requirement,
});

function qualificationVerdict(
    gates: Readonly<Record<string, IV08CandidateQualificationGate>>,
): IV08CandidateQualificationVerdict {
    const values = Object.values(gates);
    const status = values.some(({ passed }) => passed === false)
        ? "failed"
        : values.some(({ passed }) => passed === null)
          ? "incomplete"
          : "passed";
    return {
        status,
        operationalQualificationPassed: status === "passed",
        promotionEligible: false,
        nonPromotableReasons: [
            "immutable profile is test-only",
            "automatic bake and deployment are disabled",
            ...(status === "passed" ? ["promotion requires a separate reviewed release decision"] : []),
        ],
        gates,
    };
}

export function evaluateV08CandidateTournamentQualification(input: {
    timingMode: V08TestCandidateTimingMode;
    expectedGames: number;
    expectedBaseSeed: number;
    summary: IV08CandidateTournamentSummaryEvidence;
    raw?: IV08CandidateTournamentRawEvidence;
}): IV08CandidateQualificationVerdict {
    const { summary, raw } = input;
    const decisive = summary.a.wins + summary.b.wins;
    const armageddonDecidedRate = summary.games > 0 ? summary.armageddonDecided / summary.games : 1;
    const armageddonReachedRate = raw && raw.games > 0 ? raw.armageddonReached / raw.games : null;
    return qualificationVerdict({
        boundedOperationalTiming: gate(
            input.timingMode === "operational_bounded",
            input.timingMode,
            "operational_bounded",
        ),
        exactIdentity: gate(
            summary.versionA === V08_TEST_CANDIDATE_PROFILE.operationalCandidateVersion &&
                summary.versionB === V08_TEST_CANDIDATE_PROFILE.opponentVersion &&
                summary.a.version === V08_TEST_CANDIDATE_PROFILE.operationalCandidateVersion &&
                summary.b.version === V08_TEST_CANDIDATE_PROFILE.opponentVersion,
            { versionA: summary.versionA, versionB: summary.versionB },
            "plain v0.8 candidate versus v0.7",
        ),
        exactGeometry: gate(
            summary.games === input.expectedGames && summary.baseSeed === input.expectedBaseSeed,
            { games: summary.games, baseSeed: summary.baseSeed },
            `games=${input.expectedGames}, baseSeed=${input.expectedBaseSeed}`,
        ),
        minimumQualificationGames: gate(
            summary.games >= V08_CANDIDATE_MINIMUM_QUALIFICATION_GAMES,
            summary.games,
            `>= ${V08_CANDIDATE_MINIMUM_QUALIFICATION_GAMES}`,
        ),
        decisiveWinRate: gate(
            decisive > 0 && summary.winRateA >= V08_CANDIDATE_DECISIVE_WIN_RATE_GATE,
            summary.winRateA,
            `>= ${V08_CANDIDATE_DECISIVE_WIN_RATE_GATE}`,
        ),
        noStuckGames: gate((summary.endReasons.stuck ?? 0) === 0, summary.endReasons.stuck ?? 0, "0"),
        armageddonDecidedRate: gate(
            armageddonDecidedRate <= V08_CANDIDATE_ARMAGEDDON_RATE_GATE,
            armageddonDecidedRate,
            `<= ${V08_CANDIDATE_ARMAGEDDON_RATE_GATE}`,
        ),
        armageddonReachedRate: gate(
            armageddonReachedRate === null ? null : armageddonReachedRate <= V08_CANDIDATE_ARMAGEDDON_RATE_GATE,
            armageddonReachedRate,
            `<= ${V08_CANDIDATE_ARMAGEDDON_RATE_GATE}; requires raw-game census`,
        ),
        exactRawGameCensus: gate(
            raw === undefined ? null : raw.games === input.expectedGames && raw.uniqueGames === input.expectedGames,
            raw ? { games: raw.games, uniqueGames: raw.uniqueGames } : null,
            `exactly ${input.expectedGames} unique raw games`,
        ),
        zeroCandidateRejections: gate(
            raw === undefined ? null : raw.rejectedCandidate === 0,
            raw?.rejectedCandidate ?? null,
            "0; requires raw-game census",
        ),
    });
}

const laneKey = (lane: { unit: string; owner: string }): string => `${lane.unit}:${lane.owner}`;

/** Rigorous L4 evidence validator: exact deterministic census, no duplicates, no candidate skips/rejections. */
export function evaluateV08CandidateLevel4Qualification(input: {
    timingMode: V08TestCandidateTimingMode;
    pairsPerLane: number;
    baseSeed: number;
    summary: IV08CandidateLevel4SummaryEvidence;
    records: readonly IV08CandidateLevel4RecordEvidence[];
}): IV08CandidateQualificationVerdict {
    const expectedTotal = input.pairsPerLane * LEVEL4_LANES.length * 2;
    const expectedLaneGames = input.pairsPerLane * 2;
    const expectedLaneByKey = new Map(LEVEL4_LANES.map((lane) => [laneKey(lane), lane]));
    const counts = new Map(LEVEL4_LANES.map((lane) => [laneKey(lane), 0]));
    const actingTurns = new Map(LEVEL4_LANES.map((lane) => [laneKey(lane), 0]));
    const seenGames = new Set<number>();
    const recordErrors: string[] = [];
    let candidateRejections = 0;
    let candidateRawEndTurns = 0;
    let armageddonReached = 0;
    let appearances = 0;
    let stuck = 0;

    for (const record of input.records) {
        const key = laneKey(record.lane);
        if (!Number.isSafeInteger(record.game) || record.game < 0 || record.game >= expectedTotal) {
            recordErrors.push(`out-of-range game ${record.game}`);
            continue;
        }
        if (seenGames.has(record.game)) recordErrors.push(`duplicate game ${record.game}`);
        seenGames.add(record.game);
        const pair = Math.floor(record.game / 2);
        const lane = LEVEL4_LANES[pair % LEVEL4_LANES.length];
        const cycle = Math.floor(pair / LEVEL4_LANES.length);
        const candidateSide = record.game % 2 === 0 ? "green" : "red";
        const targetSide = lane.owner === "candidate" ? candidateSide : candidateSide === "green" ? "red" : "green";
        const expectedSeed = (input.baseSeed + cycle * 0x9e3779b1) >>> 0;
        const expectedMapType = LEVEL4_MAP_TYPES[cycle % LEVEL4_MAP_TYPES.length];
        if (
            record.schema !== "hoc.v0_8_l4_coverage.v1" ||
            key !== laneKey(lane) ||
            !expectedLaneByKey.has(key) ||
            record.cycle !== cycle ||
            record.seed !== expectedSeed ||
            record.mapType !== expectedMapType ||
            record.candidateVersion !== V08_TEST_CANDIDATE_PROFILE.operationalCandidateVersion ||
            record.opponentVersion !== V08_TEST_CANDIDATE_PROFILE.opponentVersion ||
            record.candidateSide !== candidateSide ||
            record.targetSide !== targetSide ||
            record.target.appearances !== 1
        ) {
            recordErrors.push(`game ${record.game} deterministic binding drifted`);
        }
        counts.set(key, (counts.get(key) ?? 0) + 1);
        actingTurns.set(key, (actingTurns.get(key) ?? 0) + record.target.actingTurns);
        appearances += record.target.appearances;
        candidateRejections += record.rejectedCandidate;
        if (record.lane.owner === "candidate") candidateRawEndTurns += record.target.rawEndTurnDecisions;
        armageddonReached += Number(record.armageddon.reached);
        stuck += Number(record.endReason === "stuck");
    }

    const summaryLaneKeys = new Set<string>();
    let summaryValid =
        input.summary.schema === "hoc.v0_8_l4_coverage.v1" &&
        input.summary.candidateVersion === V08_TEST_CANDIDATE_PROFILE.operationalCandidateVersion &&
        input.summary.opponentVersion === V08_TEST_CANDIDATE_PROFILE.opponentVersion &&
        input.summary.baseSeed === input.baseSeed &&
        input.summary.pairsPerLane === input.pairsPerLane &&
        input.summary.games === expectedTotal &&
        input.summary.lanes.length === LEVEL4_LANES.length;
    for (const cell of input.summary.lanes) {
        const key = laneKey(cell.lane);
        if (summaryLaneKeys.has(key)) summaryValid = false;
        summaryLaneKeys.add(key);
        if (
            !expectedLaneByKey.has(key) ||
            cell.games !== expectedLaneGames ||
            cell.appearances !== expectedLaneGames ||
            cell.actingTurns <= 0 ||
            cell.rejectedCandidate !== 0 ||
            (cell.lane.owner === "candidate" && cell.rawEndTurnDecisions !== 0) ||
            cell.armageddonReached !==
                input.records.filter((record) => laneKey(record.lane) === key && record.armageddon.reached).length
        ) {
            summaryValid = false;
        }
    }
    const exactLaneCensus = LEVEL4_LANES.every(
        (lane) => counts.get(laneKey(lane)) === expectedLaneGames && (actingTurns.get(laneKey(lane)) ?? 0) > 0,
    );
    const armageddonRate = expectedTotal ? armageddonReached / expectedTotal : 1;

    return qualificationVerdict({
        boundedOperationalTiming: gate(
            input.timingMode === "operational_bounded",
            input.timingMode,
            "operational_bounded",
        ),
        exactRecordCensus: gate(
            input.records.length === expectedTotal && seenGames.size === expectedTotal && recordErrors.length === 0,
            { records: input.records.length, uniqueGames: seenGames.size, errors: recordErrors.slice(0, 8) },
            `${expectedTotal} deterministic, unique records`,
        ),
        exactLaneCoverage: gate(
            exactLaneCensus && summaryValid,
            { expectedLaneGames, summaryValid, laneCounts: Object.fromEntries(counts) },
            "all 8 lanes, both seats, exact summary and deterministic map/seed binding",
        ),
        exactAppearances: gate(appearances === expectedTotal, appearances, `${expectedTotal}`),
        zeroCandidateRejections: gate(candidateRejections === 0, candidateRejections, "0"),
        zeroCandidateRawEndTurns: gate(candidateRawEndTurns === 0, candidateRawEndTurns, "0"),
        noStuckGames: gate(stuck === 0, stuck, "0"),
        armageddonReachedRate: gate(
            armageddonRate <= V08_CANDIDATE_ARMAGEDDON_RATE_GATE,
            armageddonRate,
            `<= ${V08_CANDIDATE_ARMAGEDDON_RATE_GATE}`,
        ),
    });
}

/** Pure manifest builder so identity/geometry binding is reviewable without spawning a tournament. */
export function buildV08CandidateInitialRunManifest(input: {
    identity: IV08CandidateOperationalIdentity;
    invocation: IV08CandidateInvocation;
    timingMode: V08TestCandidateTimingMode;
    geometry: V08CandidateRunGeometry;
    startedAt: string;
    host?: { hostname: string; platform: string; release: string; arch: string; bun: string };
}): Record<string, unknown> {
    return {
        schema: V08_CANDIDATE_RUN_MANIFEST_SCHEMA,
        status: "running" as const,
        testOnly: true as const,
        automaticBake: false as const,
        automaticDeploy: false as const,
        identity: {
            operationalPolicyId: V08_TEST_CANDIDATE_PROFILE.id,
            operationalPolicyRevision: V08_TEST_CANDIDATE_PROFILE.operationalPolicy.revision,
            operationalPolicySha256: input.identity.policySha256,
            sourceCandidateId: V08_TEST_CANDIDATE_PROFILE.sourceCandidateId,
            genomeSha256: V08_TEST_CANDIDATE_PROFILE.hashes.genomeSha256,
            candidateVersion: V08_TEST_CANDIDATE_PROFILE.operationalCandidateVersion,
            opponentVersion: V08_TEST_CANDIDATE_PROFILE.opponentVersion,
        },
        environment: {
            operationalIdentitySha256: input.identity.operationalEnvironmentSha256,
            executionSha256: input.invocation.candidateEnvironmentSha256,
            timingMode: input.timingMode,
            auditPath: input.invocation.auditPath,
        },
        source: input.identity,
        geometry: input.geometry,
        host: input.host ?? {
            hostname: hostname(),
            platform: platform(),
            release: release(),
            arch: arch(),
            bun: process.versions.bun ?? process.version,
        },
        timestamps: { startedAt: input.startedAt, completedAt: null },
        artifacts: null,
        qualification: null,
    };
}

function writeManifest(path: string, manifest: unknown): void {
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function findSingleOutput(output: string, predicate: (name: string) => boolean, label: string): string {
    const matches = readdirSync(output).filter(predicate);
    if (matches.length !== 1) throw new Error(`expected exactly one ${label} in ${output}; found ${matches.length}`);
    return join(output, matches[0]);
}

function parseJson<T>(path: string): T {
    return JSON.parse(readFileSync(path, "utf8")) as T;
}

function parseJsonLines<T>(path: string): T[] {
    return readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as T);
}

const requireObject = (value: unknown, label: string): Record<string, unknown> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
};

const requireNonNegativeInteger = (value: unknown, label: string): number => {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new Error(`${label} must be a non-negative integer`);
    }
    return value as number;
};

/**
 * Stream the authoritative tournament records without retaining action logs in memory. Every game index and
 * side swap is validated before its Armageddon/rejection evidence is admitted to the qualification verdict.
 */
export async function scanV08CandidateTournamentRawEvidence(
    path: string,
    expectedGames: number,
): Promise<IV08CandidateTournamentRawEvidence> {
    positiveInteger(expectedGames, "expectedGames");
    const seenGames = new Set<number>();
    let games = 0;
    let armageddonReached = 0;
    let rejectedCandidate = 0;
    let lineNumber = 0;
    const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });

    for await (const line of lines) {
        lineNumber += 1;
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
            parsed = JSON.parse(line) as unknown;
        } catch {
            throw new Error(`tournament records line ${lineNumber} is not valid JSON`);
        }
        const record = requireObject(parsed, `tournament records line ${lineNumber}`);
        const game = requireNonNegativeInteger(record.game, `tournament records line ${lineNumber}.game`);
        if (game >= expectedGames) {
            throw new Error(`tournament records line ${lineNumber} has out-of-range game ${game}`);
        }
        if (seenGames.has(game)) throw new Error(`tournament records contain duplicate game ${game}`);
        seenGames.add(game);

        const candidateIsGreen = game % 2 === 0;
        const expectedGreenEntrant = candidateIsGreen ? "a" : "b";
        const expectedGreenVersion = candidateIsGreen
            ? V08_TEST_CANDIDATE_PROFILE.operationalCandidateVersion
            : V08_TEST_CANDIDATE_PROFILE.opponentVersion;
        const expectedRedVersion = candidateIsGreen
            ? V08_TEST_CANDIDATE_PROFILE.opponentVersion
            : V08_TEST_CANDIDATE_PROFILE.operationalCandidateVersion;
        if (
            record.greenEntrant !== expectedGreenEntrant ||
            record.greenVersion !== expectedGreenVersion ||
            record.redVersion !== expectedRedVersion
        ) {
            throw new Error(`tournament records game ${game} candidate side/version binding drifted`);
        }

        const result = requireObject(record.result, `tournament records game ${game}.result`);
        const attrition = requireObject(result.attrition, `tournament records game ${game}.result.attrition`);
        if (typeof attrition.reachedArmageddon !== "boolean") {
            throw new Error(`tournament records game ${game}.result.attrition.reachedArmageddon must be boolean`);
        }
        const rejectedGreen = requireNonNegativeInteger(
            result.rejectedGreen,
            `tournament records game ${game}.result.rejectedGreen`,
        );
        const rejectedRed = requireNonNegativeInteger(
            result.rejectedRed,
            `tournament records game ${game}.result.rejectedRed`,
        );
        armageddonReached += Number(attrition.reachedArmageddon);
        rejectedCandidate += candidateIsGreen ? rejectedGreen : rejectedRed;
        games += 1;
    }

    if (seenGames.size !== expectedGames) {
        throw new Error(`tournament records contain ${seenGames.size}/${expectedGames} unique games`);
    }
    return { games, uniqueGames: seenGames.size, armageddonReached, rejectedCandidate };
}

async function runChild(invocation: IV08CandidateInvocation): Promise<number> {
    return new Promise<number>((resolveCode, reject) => {
        const child = spawn(process.execPath, invocation.args, {
            cwd: REPOSITORY_ROOT,
            env: invocation.environment,
            stdio: "inherit",
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            if (signal) reject(new Error(`v0.8 candidate tournament exited on ${signal}`));
            else resolveCode(code ?? 1);
        });
    });
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    if (argv.includes("--help") || argv.includes("-h")) {
        console.log(
            "Usage: bun src/simulation/run_v0_8_candidate.ts [games|pairsPerL4Lane] [seed] [outDir] " +
                "[concurrency] [--research-unbounded] [--maps=normal,lava,block] [--level4]",
        );
        return;
    }
    const flags = argv.filter((argument) => argument.startsWith("--"));
    const [gamesArg, seedArg, outputArg, concurrencyArg] = argv.filter((argument) => !argument.startsWith("--"));
    const maps = flags.find((flag) => flag.startsWith("--maps="))?.slice("--maps=".length) ?? "normal,lava,block";
    const level4 = flags.includes("--level4");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const timingMode = flags.includes("--research-unbounded") ? "research_unbounded" : "operational_bounded";
    const options: IV08CandidateTournamentOptions = {
        games: Number(gamesArg ?? (level4 ? 32 : 6000)),
        baseSeed: Number(seedArg ?? 82_608_001),
        output: outputArg ?? join(REPOSITORY_ROOT, "sim-out", `v08-candidate-${stamp}`),
        concurrency: Number(concurrencyArg ?? Math.min(12, Math.max(1, availableParallelism()))),
        timingMode,
        maps,
    };

    const identity = verifyV08CandidateOperationalIdentity();
    const output = prepareV08CandidateOutputDirectory(options.output);
    options.output = output;
    const invocation = level4
        ? buildV08CandidateLevel4Invocation({
              pairsPerLane: options.games,
              baseSeed: options.baseSeed,
              output,
              concurrency: options.concurrency,
              timingMode,
          })
        : buildV08CandidateTournamentInvocation(options);
    const manifestPath = join(output, RUN_MANIFEST_NAME);
    const startedAt = new Date().toISOString();
    const geometry: V08CandidateRunGeometry = level4
        ? {
              kind: "level4" as const,
              pairsPerLane: options.games,
              games: options.games * LEVEL4_LANES.length * 2,
              baseSeed: options.baseSeed,
              concurrency: Math.min(options.concurrency, options.games * LEVEL4_LANES.length * 2),
              maps: [...ALLOWED_MAPS],
          }
        : {
              kind: "tournament" as const,
              games: options.games,
              baseSeed: options.baseSeed,
              concurrency: Math.min(options.concurrency, options.games),
              maps: invocation.maps,
          };
    const initialManifest = buildV08CandidateInitialRunManifest({
        identity,
        invocation,
        timingMode,
        geometry,
        startedAt,
    });
    writeManifest(manifestPath, initialManifest);
    console.log(
        `Pinned ${V08_TEST_CANDIDATE_PROFILE.id}: ${options.timingMode}, ${level4 ? "forced L4" : "v0.8 vs v0.7"}, ` +
            `audit ${invocation.auditPath}`,
    );

    try {
        const exitCode = await runChild(invocation);
        if (exitCode !== 0) throw new Error(`v0.8 candidate tournament exited ${exitCode}`);
        const summaryPath = findSingleOutput(output, (name) => name.endsWith(".summary.json"), "summary");
        const auditExists = existsSync(invocation.auditPath);
        const artifacts: Record<string, unknown> = {
            summary: {
                path: basename(summaryPath),
                bytes: statSync(summaryPath).size,
                sha256: await sha256File(summaryPath),
            },
            searchAudit: auditExists
                ? {
                      path: basename(invocation.auditPath),
                      bytes: statSync(invocation.auditPath).size,
                      sha256: await sha256File(invocation.auditPath),
                  }
                : { path: basename(invocation.auditPath), bytes: null, sha256: null },
        };
        let qualification: IV08CandidateQualificationVerdict;
        if (level4) {
            const recordsPath = findSingleOutput(
                output,
                (name) => name.endsWith(".jsonl") && name !== SEARCH_AUDIT_NAME,
                "L4 records JSONL",
            );
            artifacts.level4Records = {
                path: basename(recordsPath),
                bytes: statSync(recordsPath).size,
                sha256: await sha256File(recordsPath),
            };
            qualification = evaluateV08CandidateLevel4Qualification({
                timingMode,
                pairsPerLane: options.games,
                baseSeed: options.baseSeed,
                summary: parseJson<IV08CandidateLevel4SummaryEvidence>(summaryPath),
                records: parseJsonLines<IV08CandidateLevel4RecordEvidence>(recordsPath),
            });
        } else {
            const recordsPath = findSingleOutput(
                output,
                (name) => name.endsWith(".jsonl") && name !== SEARCH_AUDIT_NAME,
                "tournament records JSONL",
            );
            artifacts.tournamentRecords = {
                path: basename(recordsPath),
                bytes: statSync(recordsPath).size,
                sha256: await sha256File(recordsPath),
            };
            qualification = evaluateV08CandidateTournamentQualification({
                timingMode,
                expectedGames: options.games,
                expectedBaseSeed: options.baseSeed,
                summary: parseJson<IV08CandidateTournamentSummaryEvidence>(summaryPath),
                raw: await scanV08CandidateTournamentRawEvidence(recordsPath, options.games),
            });
        }
        writeManifest(manifestPath, {
            ...initialManifest,
            status: "completed",
            timestamps: { startedAt, completedAt: new Date().toISOString() },
            artifacts,
            qualification,
        });
        console.log(
            `Candidate evidence manifest -> ${manifestPath} (${qualification.status}; promotionEligible=false)`,
        );
    } catch (error) {
        writeManifest(manifestPath, {
            ...initialManifest,
            status: "failed",
            timestamps: { startedAt, completedAt: new Date().toISOString() },
            failure: error instanceof Error ? error.message : String(error),
        });
        throw error;
    }
}

if ((import.meta as unknown as { main?: boolean }).main) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}

export { main };
