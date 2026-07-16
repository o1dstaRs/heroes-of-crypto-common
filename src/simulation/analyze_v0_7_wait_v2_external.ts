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
    createReadStream,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import type { IRevisionProvenance } from "./v0_7_acceptance";
import {
    WAIT_V2_WEIGHT_JSON,
    analyzeWaitV2Cell,
    assessWaitV2Run,
    readWaitV2ProtocolManifest,
    type IWaitV2Assessment,
    type IWaitV2Cell,
    type IWaitV2CellAnalysis,
    type IWaitV2Observation,
    type IWaitV2ProtocolProvenance,
} from "./v0_7_wait_v2_powered";

export const EXTERNAL_WAIT_V2_FROZEN_COMMIT = "1859e4de2e150cbc59c8116d2c2e6f7b9bceccf7";
export const EXTERNAL_WAIT_V2_RUNNER_SHA256 = "1af63f155fc4f9fa33fdca3c40a5fb1355710ee2fb2f0b14f5f872ceb87e9b03";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const POWERED_DIAGNOSTIC_GAMES = 512;
const POWERED_CONCURRENCY = 12;
const MIRROR_COHORTS = ["melee_coevo", "hybrid", "ranged_max_sniper3", "pure_ranged"] as const;

type ExternalArm = "control" | "v2";

interface IExternalRunIdentity {
    schemaVersion: 1;
    status: "research_only";
    frozenCommit: string;
    branch: "main";
    gamesPerPrimaryCellPerArm: number;
    diagGamesPerMirrorCellPerArm: number;
    concurrency: number;
    v2WeightsSha256: string;
    pairedSideSwap: true;
    scoreMetric: "W=1,D=0.5,L=0";
    automaticBake: false;
    automaticDeploy: false;
}

export interface IExternalWaitV2Artifact {
    role: string;
    path: string;
    bytes: number;
    sha256: string;
}

export interface IExternalWaitV2Diagnostic {
    cellId: string;
    gamesPerArm: number;
    controlGames: number;
    v2Games: number;
}

export interface IExternalWaitV2AnalysisReport {
    schemaVersion: 1;
    kind: "v0.7_wait_v2_external_analysis";
    generatedAt: string;
    sourceRunDir: string;
    protocol: IWaitV2ProtocolProvenance;
    executionRevision: IRevisionProvenance;
    analyzerRevision: IRevisionProvenance;
    adapterSourceSha256: string;
    analyzerSourceSha256: string;
    runnerSha256: string;
    run: IExternalRunIdentity;
    revisionStable: boolean;
    artifacts: IExternalWaitV2Artifact[];
    cells: IWaitV2CellAnalysis[];
    diagnostics: IExternalWaitV2Diagnostic[];
    assessment: IWaitV2Assessment;
}

export interface IAnalyzeExternalWaitV2Options {
    runDir: string;
    executionRepo: string;
    outputPath?: string;
    allowUnderpowered?: boolean;
    expectedFrozenCommit?: string;
    expectedRunnerSha256?: string;
    expectedDiagnosticGames?: number;
    expectedConcurrency?: number;
}

interface IParsedArtifact<T> {
    value: T;
    artifact: IExternalWaitV2Artifact;
}

interface IParsedArm {
    observations: IWaitV2Observation[];
    artifacts: IExternalWaitV2Artifact[];
}

function sha256(value: string | Buffer): string {
    return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (!isRecord(value)) throw new Error(`${label} must be a JSON object`);
    return value;
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${label} keys differ: expected ${expected.join(",")}; got ${actual.join(",")}`);
    }
}

function requireString(value: unknown, label: string): string {
    if (typeof value !== "string") throw new Error(`${label} must be a string`);
    return value;
}

function requireBoolean(value: unknown, label: string): boolean {
    if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
    return value;
}

function requireInteger(value: unknown, label: string, minimum = 0): number {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) {
        throw new Error(`${label} must be an integer >= ${minimum}`);
    }
    return value as number;
}

function requireEvenInteger(value: unknown, label: string): number {
    const result = requireInteger(value, label, 2);
    if (result % 2 !== 0) throw new Error(`${label} must be even`);
    return result;
}

function requireOneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
    if (typeof value !== "string" || !allowed.includes(value as T)) {
        throw new Error(`${label} must be one of ${allowed.join(",")}`);
    }
    return value as T;
}

function readTextArtifact(path: string, role: string): IParsedArtifact<string> {
    if (!existsSync(path)) throw new Error(`Missing ${role}: ${path}`);
    const value = readFileSync(path, "utf8");
    return {
        value,
        artifact: { role, path: resolve(path), bytes: Buffer.byteLength(value), sha256: sha256(value) },
    };
}

function readJsonArtifact(path: string, role: string): IParsedArtifact<unknown> {
    const text = readTextArtifact(path, role);
    let value: unknown;
    try {
        value = JSON.parse(text.value);
    } catch (error) {
        throw new Error(`Invalid JSON in ${role} ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { value, artifact: text.artifact };
}

function atomicWrite(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temporary, path);
}

function gitText(repo: string, args: string[]): string {
    try {
        return execFileSync("git", ["-C", repo, ...args], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        }).trim();
    } catch (error) {
        throw new Error(
            `Cannot read git provenance from ${repo}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

function readGitRevision(repo: string, requireCompletelyClean: boolean): IRevisionProvenance {
    const status = gitText(repo, ["status", "--porcelain"]);
    if (requireCompletelyClean && status) throw new Error(`Execution repository is not clean: ${repo}`);
    const diff = execFileSync("git", ["-C", repo, "diff", "--binary", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
    return {
        commit: gitText(repo, ["rev-parse", "HEAD"]),
        commitDate: gitText(repo, ["show", "-s", "--format=%cI", "HEAD"]),
        branch: gitText(repo, ["rev-parse", "--abbrev-ref", "HEAD"]),
        remote: (() => {
            try {
                return execFileSync("git", ["-C", repo, "remote", "get-url", "origin"], {
                    encoding: "utf8",
                    stdio: ["ignore", "pipe", "ignore"],
                }).trim();
            } catch {
                return null;
            }
        })(),
        trackedClean: diff.length === 0,
        trackedDiffSha256: diff.length === 0 ? null : sha256(diff),
    };
}

function sameRevision(left: IRevisionProvenance, right: IRevisionProvenance): boolean {
    return (
        left.commit === right.commit &&
        left.branch === right.branch &&
        left.trackedClean === right.trackedClean &&
        left.trackedDiffSha256 === right.trackedDiffSha256
    );
}

function parseRunIdentity(
    value: unknown,
    expectedCommit: string,
    expectedWeightHash: string,
    expectedGames: number,
    expectedDiagnosticGames: number,
    expectedConcurrency: number,
    allowUnderpowered: boolean,
): IExternalRunIdentity {
    const row = requireRecord(value, "run.json");
    requireExactKeys(
        row,
        [
            "schemaVersion",
            "status",
            "frozenCommit",
            "branch",
            "gamesPerPrimaryCellPerArm",
            "diagGamesPerMirrorCellPerArm",
            "concurrency",
            "v2WeightsSha256",
            "pairedSideSwap",
            "scoreMetric",
            "automaticBake",
            "automaticDeploy",
        ],
        "run.json",
    );
    if (row.schemaVersion !== 1 || row.status !== "research_only")
        throw new Error("Invalid external run schema/status");
    if (row.frozenCommit !== expectedCommit || row.branch !== "main") {
        throw new Error(`External run revision must be clean main at ${expectedCommit}`);
    }
    const games = requireEvenInteger(row.gamesPerPrimaryCellPerArm, "run gamesPerPrimaryCellPerArm");
    const diagnosticGames = requireEvenInteger(row.diagGamesPerMirrorCellPerArm, "run diagGamesPerMirrorCellPerArm");
    const concurrency = requireInteger(row.concurrency, "run concurrency", 1);
    if (!allowUnderpowered && games !== expectedGames) {
        throw new Error(`External powered run requires ${expectedGames} primary games/arm; got ${games}`);
    }
    if (!allowUnderpowered && diagnosticGames !== expectedDiagnosticGames) {
        throw new Error(
            `External powered run requires ${expectedDiagnosticGames} diagnostic games/arm; got ${diagnosticGames}`,
        );
    }
    if (concurrency !== expectedConcurrency) {
        throw new Error(`External run concurrency ${concurrency} != ${expectedConcurrency}`);
    }
    if (
        row.v2WeightsSha256 !== expectedWeightHash ||
        row.pairedSideSwap !== true ||
        row.scoreMetric !== "W=1,D=0.5,L=0" ||
        row.automaticBake !== false ||
        row.automaticDeploy !== false
    ) {
        throw new Error("External run behavior/scoring identity differs from the frozen protocol");
    }
    return {
        schemaVersion: 1,
        status: "research_only",
        frozenCommit: expectedCommit,
        branch: "main",
        gamesPerPrimaryCellPerArm: games,
        diagGamesPerMirrorCellPerArm: diagnosticGames,
        concurrency,
        v2WeightsSha256: expectedWeightHash,
        pairedSideSwap: true,
        scoreMetric: "W=1,D=0.5,L=0",
        automaticBake: false,
        automaticDeploy: false,
    };
}

function parseMarker(value: string, label: string): Record<string, string> {
    if (!value.endsWith("\n") || value.slice(0, -1).includes("\n")) {
        throw new Error(`${label} must contain exactly one newline-terminated record`);
    }
    const result: Record<string, string> = {};
    for (const token of value.slice(0, -1).split(" ")) {
        const delimiter = token.indexOf("=");
        if (delimiter <= 0 || delimiter === token.length - 1) throw new Error(`Invalid ${label} token: ${token}`);
        const key = token.slice(0, delimiter);
        if (result[key] !== undefined) throw new Error(`Duplicate ${label} key: ${key}`);
        result[key] = token.slice(delimiter + 1);
    }
    return result;
}

function validateRawComplete(value: string, run: IExternalRunIdentity): void {
    const marker = parseMarker(value, "RAW_COMPLETE");
    requireExactKeys(marker, ["schema", "status", "time", "epoch", "commit", "v2sha"], "RAW_COMPLETE");
    if (
        marker.schema !== "1" ||
        marker.status !== "raw_complete" ||
        marker.commit !== run.frozenCommit ||
        marker.v2sha !== run.v2WeightsSha256
    ) {
        throw new Error("RAW_COMPLETE identity differs from run.json");
    }
    const timestamp = Date.parse(marker.time);
    const epoch = Number(marker.epoch);
    const canonicalTime = Number.isFinite(timestamp) ? new Date(timestamp).toISOString().replace(".000Z", "Z") : "";
    const timestampEpoch = timestamp / 1000;
    const epochSkewSeconds = epoch - timestampEpoch;
    // The frozen runner reads ISO time before epoch time, so a boundary crossing can only produce +1 second.
    if (
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(marker.time) ||
        canonicalTime !== marker.time ||
        !/^(0|[1-9]\d*)$/.test(marker.epoch) ||
        !Number.isSafeInteger(timestampEpoch) ||
        !Number.isSafeInteger(epoch) ||
        (epochSkewSeconds !== 0 && epochSkewSeconds !== 1)
    ) {
        throw new Error("RAW_COMPLETE timestamp/epoch is invalid");
    }
}

function validateDone(
    value: string,
    run: IExternalRunIdentity,
    arm: ExternalArm,
    phase: "mirror" | "draft" | "diag",
    cell: IWaitV2Cell,
    games: number,
): void {
    const marker = parseMarker(value, `${arm}/${phase}/${cell.cohort}/DONE`);
    const expectedKeys = ["schema", "arm", "phase", "cohort", "games", "seed", "commit"];
    if (phase === "draft") expectedKeys.push("fmr");
    requireExactKeys(marker, expectedKeys, `${arm}/${phase}/${cell.cohort}/DONE`);
    if (
        marker.schema !== "1" ||
        marker.arm !== arm ||
        marker.phase !== phase ||
        marker.cohort !== cell.cohort ||
        marker.games !== String(games) ||
        marker.seed !== String(cell.baseSeed) ||
        marker.commit !== run.frozenCommit
    ) {
        throw new Error(`${arm}/${phase}/${cell.cohort}/DONE identity mismatch`);
    }
    if (phase === "draft" && marker.fmr !== String(cell.meleeDraftFraction)) {
        throw new Error(`${arm}/draft/${cell.cohort}/DONE melee fraction mismatch`);
    }
}

function expectedVersions(game: number, candidate: string, opponent: string): { green: string; red: string } {
    return game % 2 === 0 ? { green: candidate, red: opponent } : { green: opponent, red: candidate };
}

/** Convert a forced-mirror JSONL row without trusting its precomputed summary. */
export function externalMirrorObservation(value: unknown, candidate = "v0.7", opponent = "v0.6"): IWaitV2Observation {
    const row = requireRecord(value, "mirror record");
    const game = requireInteger(row.game, "mirror record.game");
    const seed = requireInteger(row.seed, `mirror game ${game}.seed`);
    const versions = expectedVersions(game, candidate, opponent);
    const greenVersion = requireString(row.greenVersion, `mirror game ${game}.greenVersion`);
    if (greenVersion !== versions.green) throw new Error(`mirror game ${game} has invalid side-swap versions`);
    const winnerVersion = requireOneOf(
        row.winnerVersion,
        [candidate, opponent, "draw"],
        `mirror game ${game}.winnerVersion`,
    );
    const armageddon = requireBoolean(row.armageddon, `mirror game ${game}.armageddon`);
    const rejectedGreen = requireInteger(row.rejectedGreen, `mirror game ${game}.rejectedGreen`);
    const rejectedRed = requireInteger(row.rejectedRed, `mirror game ${game}.rejectedRed`);
    const candidateIsGreen = greenVersion === candidate;
    return {
        game,
        seed,
        score: winnerVersion === "draw" ? 0.5 : winnerVersion === candidate ? 1 : 0,
        draw: winnerVersion === "draw",
        armageddon,
        candidateRejections: candidateIsGreen ? rejectedGreen : rejectedRed,
        opponentRejections: candidateIsGreen ? rejectedRed : rejectedGreen,
    };
}

/** Convert a draft JSONL row and cross-check entrant, side, and winner identities. */
export function externalDraftObservation(value: unknown, candidate = "v0.7", opponent = "v0.6"): IWaitV2Observation {
    const row = requireRecord(value, "draft record");
    const game = requireInteger(row.game, "draft record.game");
    const greenEntrant = requireOneOf(row.greenEntrant, ["a", "b"], `draft game ${game}.greenEntrant`);
    const expectedEntrant = game % 2 === 0 ? "a" : "b";
    if (greenEntrant !== expectedEntrant) throw new Error(`draft game ${game} has invalid entrant side swap`);
    const versions = expectedVersions(game, candidate, opponent);
    const greenVersion = requireString(row.greenVersion, `draft game ${game}.greenVersion`);
    const redVersion = requireString(row.redVersion, `draft game ${game}.redVersion`);
    if (greenVersion !== versions.green || redVersion !== versions.red) {
        throw new Error(`draft game ${game} has invalid side-swap versions`);
    }
    const result = requireRecord(row.result, `draft game ${game}.result`);
    const seed = requireInteger(result.seed, `draft game ${game}.result.seed`);
    const winner = requireOneOf(result.winner, ["green", "red", "draw"], `draft game ${game}.result.winner`);
    const winnerVersion = requireOneOf(
        row.winnerVersion,
        [candidate, opponent, "draw"],
        `draft game ${game}.winnerVersion`,
    );
    const expectedWinnerVersion = winner === "draw" ? "draw" : winner === "green" ? greenVersion : redVersion;
    if (winnerVersion !== expectedWinnerVersion) throw new Error(`draft game ${game} winner version/side mismatch`);
    const attrition = requireRecord(result.attrition, `draft game ${game}.result.attrition`);
    const armageddon = requireBoolean(
        attrition.decidedByArmageddon,
        `draft game ${game}.result.attrition.decidedByArmageddon`,
    );
    const rejectedGreen = requireInteger(result.rejectedGreen, `draft game ${game}.result.rejectedGreen`);
    const rejectedRed = requireInteger(result.rejectedRed, `draft game ${game}.result.rejectedRed`);
    const candidateIsGreen = greenEntrant === "a";
    const score = winner === "draw" ? 0.5 : (winner === "green") === candidateIsGreen ? 1 : 0;
    return {
        game,
        seed,
        score,
        draw: winner === "draw",
        armageddon,
        candidateRejections: candidateIsGreen ? rejectedGreen : rejectedRed,
        opponentRejections: candidateIsGreen ? rejectedRed : rejectedGreen,
    };
}

async function readJsonLines(
    path: string,
    role: string,
    convert: (value: unknown) => IWaitV2Observation,
): Promise<IParsedArtifact<IWaitV2Observation[]>> {
    if (!existsSync(path)) throw new Error(`Missing ${role}: ${path}`);
    const before = statSync(path);
    if (!before.isFile()) throw new Error(`${role} is not a file: ${path}`);
    const hash = createHash("sha256");
    let bytes = 0;
    const input = createReadStream(path);
    input.on("data", (chunk: Buffer | string) => {
        hash.update(chunk);
        bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
    });
    const lines = createInterface({ input, crlfDelay: Infinity });
    const observations: IWaitV2Observation[] = [];
    let lineNumber = 0;
    try {
        for await (const line of lines) {
            lineNumber += 1;
            if (!line) throw new Error(`${role} has an empty line at ${lineNumber}`);
            let value: unknown;
            try {
                value = JSON.parse(line);
            } catch (error) {
                throw new Error(
                    `${role} has invalid JSON at line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
            observations.push(convert(value));
        }
    } finally {
        lines.close();
    }
    const after = statSync(path);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes !== after.size) {
        throw new Error(`${role} changed while it was being read`);
    }
    observations.sort((left, right) => left.game - right.game);
    return {
        value: observations,
        artifact: { role, path: resolve(path), bytes, sha256: hash.digest("hex") },
    };
}

function requireNumber(value: unknown, label: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
    return value;
}

function requireEqual(actual: unknown, expected: unknown, label: string): void {
    if (actual !== expected) throw new Error(`${label} mismatch: expected ${String(expected)}, got ${String(actual)}`);
}

function validateMirrorSummary(
    value: unknown,
    cell: IWaitV2Cell,
    observations: readonly IWaitV2Observation[],
    games: number,
): void {
    const summary = requireRecord(value, `${cell.id} mirror summary`);
    const versions = requireRecord(summary.versions, `${cell.id} mirror summary.versions`);
    const wins = observations.filter((row) => row.score === 1).length;
    const losses = observations.filter((row) => row.score === 0).length;
    const draws = observations.filter((row) => row.score === 0.5).length;
    requireEqual(summary.kind, "mirror_cohort_ab", `${cell.id} summary.kind`);
    requireEqual(summary.cohort, cell.cohort, `${cell.id} summary.cohort`);
    requireEqual(versions.A, "v0.7", `${cell.id} summary version A`);
    requireEqual(versions.B, "v0.6", `${cell.id} summary version B`);
    requireEqual(summary.games, games, `${cell.id} summary.games`);
    requireEqual(summary.baseSeed, cell.baseSeed, `${cell.id} summary.baseSeed`);
    requireEqual(summary.amountMode, "expBudget", `${cell.id} summary.amountMode`);
    requireEqual(summary.livetwin, true, `${cell.id} summary.livetwin`);
    requireEqual(summary.zeroScorer, false, `${cell.id} summary.zeroScorer`);
    requireEqual(summary.guard, "default(support)", `${cell.id} summary.guard`);
    requireEqual(summary.pairedSideSwap, true, `${cell.id} summary.pairedSideSwap`);
    requireEqual(summary.symmetricRosters, true, `${cell.id} summary.symmetricRosters`);
    requireEqual(summary.winsA, wins, `${cell.id} summary.winsA`);
    requireEqual(summary.winsB, losses, `${cell.id} summary.winsB`);
    requireEqual(summary.draws, draws, `${cell.id} summary.draws`);
    requireEqual(
        summary.armageddonDecided,
        observations.filter((row) => row.armageddon).length,
        `${cell.id} summary Armageddon`,
    );
    requireEqual(
        summary.rejectedActions,
        observations.reduce((sum, row) => sum + (row.candidateRejections ?? 0) + (row.opponentRejections ?? 0), 0),
        `${cell.id} summary rejectedActions`,
    );
    const decisiveRate = wins + losses === 0 ? 0.5 : wins / (wins + losses);
    requireEqual(
        requireNumber(summary.winRateA, `${cell.id} summary.winRateA`),
        decisiveRate,
        `${cell.id} summary.winRateA`,
    );
}

function validateDraftSummary(
    value: unknown,
    cell: IWaitV2Cell,
    observations: readonly IWaitV2Observation[],
    games: number,
): void {
    const summary = requireRecord(value, `${cell.id} draft summary`);
    const a = requireRecord(summary.a, `${cell.id} draft summary.a`);
    const b = requireRecord(summary.b, `${cell.id} draft summary.b`);
    const wins = observations.filter((row) => row.score === 1).length;
    const losses = observations.filter((row) => row.score === 0).length;
    const draws = observations.filter((row) => row.score === 0.5).length;
    requireEqual(summary.versionA, "v0.7", `${cell.id} summary.versionA`);
    requireEqual(summary.versionB, "v0.6", `${cell.id} summary.versionB`);
    requireEqual(summary.games, games, `${cell.id} summary.games`);
    requireEqual(summary.baseSeed, cell.baseSeed, `${cell.id} summary.baseSeed`);
    requireEqual(a.version, "v0.7", `${cell.id} summary.a.version`);
    requireEqual(b.version, "v0.6", `${cell.id} summary.b.version`);
    requireEqual(a.wins, wins, `${cell.id} summary.a.wins`);
    requireEqual(b.wins, losses, `${cell.id} summary.b.wins`);
    requireEqual(summary.draws, draws, `${cell.id} summary.draws`);
    requireEqual(
        summary.armageddonDecided,
        observations.filter((row) => row.armageddon).length,
        `${cell.id} summary Armageddon`,
    );
    const decisiveRate = wins + losses === 0 ? 0.5 : wins / (wins + losses);
    requireEqual(
        requireNumber(summary.winRateA, `${cell.id} summary.winRateA`),
        decisiveRate,
        `${cell.id} summary.winRateA`,
    );
}

function armPaths(
    runDir: string,
    arm: ExternalArm,
    phase: "mirror" | "draft" | "diag",
    cell: IWaitV2Cell,
): {
    directory: string;
    jsonl: string;
    summary: string;
    done: string;
} {
    const directory = join(runDir, arm, phase, String(cell.cohort));
    if (!existsSync(directory)) throw new Error(`Missing external arm directory: ${directory}`);
    if (phase !== "draft") {
        return {
            directory,
            jsonl: join(directory, "result.records.jsonl"),
            summary: join(directory, "result.summary.json"),
            done: join(directory, "DONE"),
        };
    }
    const entries = readdirSync(directory);
    const jsonl = entries.filter((entry) => /^v0\.7_vs_v0\.6_.+\.jsonl$/.test(entry));
    const summaries = entries.filter((entry) => /^v0\.7_vs_v0\.6_.+\.summary\.json$/.test(entry));
    if (jsonl.length !== 1 || summaries.length !== 1) {
        throw new Error(`${arm}/draft/${cell.cohort} must contain exactly one JSONL and one summary`);
    }
    const jsonlStem = jsonl[0].slice(0, -".jsonl".length);
    const summaryStem = summaries[0].slice(0, -".summary.json".length);
    if (jsonlStem !== summaryStem) throw new Error(`${arm}/draft/${cell.cohort} raw and summary names differ`);
    return {
        directory,
        jsonl: join(directory, jsonl[0]),
        summary: join(directory, summaries[0]),
        done: join(directory, "DONE"),
    };
}

async function readArm(
    runDir: string,
    run: IExternalRunIdentity,
    cell: IWaitV2Cell,
    arm: ExternalArm,
    phase: "mirror" | "draft" | "diag",
    games: number,
): Promise<IParsedArm> {
    const paths = armPaths(runDir, arm, phase, cell);
    const rolePrefix = `${arm}/${phase}/${cell.cohort}`;
    const done = readTextArtifact(paths.done, `${rolePrefix}/DONE`);
    validateDone(done.value, run, arm, phase, cell, games);
    const rows = await readJsonLines(
        paths.jsonl,
        `${rolePrefix}/records`,
        phase === "draft" ? externalDraftObservation : externalMirrorObservation,
    );
    if (rows.value.length !== games) throw new Error(`${rolePrefix} has ${rows.value.length}/${games} records`);
    const summary = readJsonArtifact(paths.summary, `${rolePrefix}/summary`);
    if (phase === "draft") validateDraftSummary(summary.value, cell, rows.value, games);
    else validateMirrorSummary(summary.value, cell, rows.value, games);
    return { observations: rows.value, artifacts: [done.artifact, rows.artifact, summary.artifact] };
}

function validateRunner(runDir: string, expectedHash: string): IExternalWaitV2Artifact[] {
    const script = readTextArtifact(join(runDir, "run_powered_v2.sh"), "runner/script");
    const declaration = readTextArtifact(join(runDir, "runner.sha256"), "runner/sha256-declaration");
    if (script.artifact.sha256 !== expectedHash) {
        throw new Error(`External runner hash ${script.artifact.sha256} != ${expectedHash}`);
    }
    if (declaration.value !== `${expectedHash}  run_powered_v2.sh\n`) {
        throw new Error("runner.sha256 does not exactly bind run_powered_v2.sh");
    }
    return [script.artifact, declaration.artifact];
}

export async function analyzeExternalWaitV2Run(
    options: IAnalyzeExternalWaitV2Options,
): Promise<IExternalWaitV2AnalysisReport> {
    const runDir = resolve(options.runDir);
    const executionRepo = resolve(options.executionRepo);
    const expectedCommit = options.expectedFrozenCommit ?? EXTERNAL_WAIT_V2_FROZEN_COMMIT;
    const expectedRunnerHash = options.expectedRunnerSha256 ?? EXTERNAL_WAIT_V2_RUNNER_SHA256;
    const expectedDiagnosticGames = options.expectedDiagnosticGames ?? POWERED_DIAGNOSTIC_GAMES;
    const expectedConcurrency = options.expectedConcurrency ?? POWERED_CONCURRENCY;
    const allowUnderpowered = options.allowUnderpowered ?? false;
    const { manifest: protocol, provenance } = readWaitV2ProtocolManifest();
    const executionStart = readGitRevision(executionRepo, true);
    if (executionStart.commit !== expectedCommit || executionStart.branch !== "main" || !executionStart.trackedClean) {
        throw new Error(`Execution repository must be clean main at ${expectedCommit}`);
    }

    const artifacts: IExternalWaitV2Artifact[] = [];
    artifacts.push(...validateRunner(runDir, expectedRunnerHash));
    const runArtifact = readJsonArtifact(join(runDir, "run.json"), "run/identity");
    const run = parseRunIdentity(
        runArtifact.value,
        expectedCommit,
        protocol.v2WeightsSha256,
        protocol.gamesPerArm,
        expectedDiagnosticGames,
        expectedConcurrency,
        allowUnderpowered,
    );
    artifacts.push(runArtifact.artifact);

    const weights = readTextArtifact(join(runDir, "v2_weights.json"), "run/v2-weights");
    if (weights.value !== `${WAIT_V2_WEIGHT_JSON}\n` || sha256(weights.value.slice(0, -1)) !== run.v2WeightsSha256) {
        throw new Error("v2_weights.json differs from the frozen V2 vector");
    }
    artifacts.push(weights.artifact);
    const rawComplete = readTextArtifact(join(runDir, "RAW_COMPLETE"), "run/RAW_COMPLETE");
    validateRawComplete(rawComplete.value, run);
    artifacts.push(rawComplete.artifact);

    const analyses: IWaitV2CellAnalysis[] = [];
    for (const cell of protocol.cells) {
        const phase = cell.kind;
        const control = await readArm(runDir, run, cell, "control", phase, run.gamesPerPrimaryCellPerArm);
        const v2 = await readArm(runDir, run, cell, "v2", phase, run.gamesPerPrimaryCellPerArm);
        artifacts.push(...control.artifacts, ...v2.artifacts);
        analyses.push(analyzeWaitV2Cell(cell, control.observations, v2.observations, run.gamesPerPrimaryCellPerArm));
    }

    const diagnostics: IExternalWaitV2Diagnostic[] = [];
    for (const cohort of MIRROR_COHORTS) {
        const cell = protocol.cells.find((entry) => entry.kind === "mirror" && entry.cohort === cohort);
        if (!cell) throw new Error(`Protocol is missing diagnostic mirror ${cohort}`);
        const control = await readArm(runDir, run, cell, "control", "diag", run.diagGamesPerMirrorCellPerArm);
        const v2 = await readArm(runDir, run, cell, "v2", "diag", run.diagGamesPerMirrorCellPerArm);
        artifacts.push(...control.artifacts, ...v2.artifacts);
        analyzeWaitV2Cell(cell, control.observations, v2.observations, run.diagGamesPerMirrorCellPerArm);
        diagnostics.push({
            cellId: cell.id,
            gamesPerArm: run.diagGamesPerMirrorCellPerArm,
            controlGames: control.observations.length,
            v2Games: v2.observations.length,
        });
    }

    const executionEnd = readGitRevision(executionRepo, true);
    const revisionStable = sameRevision(executionStart, executionEnd);
    if (!revisionStable) throw new Error("Execution repository changed while external raws were analyzed");
    const analyzerRevision = readGitRevision(PROJECT_ROOT, false);
    const adapterSource = readTextArtifact(fileURLToPath(import.meta.url), "analyzer/external-adapter-source");
    const analyzerSource = readTextArtifact(
        join(PROJECT_ROOT, "src/simulation/v0_7_wait_v2_powered.ts"),
        "analyzer/powered-source",
    );
    artifacts.push(adapterSource.artifact, analyzerSource.artifact);
    const assessment = assessWaitV2Run(protocol, analyses, run.gamesPerPrimaryCellPerArm, executionEnd, revisionStable);
    const report: IExternalWaitV2AnalysisReport = {
        schemaVersion: 1,
        kind: "v0.7_wait_v2_external_analysis",
        generatedAt: new Date().toISOString(),
        sourceRunDir: runDir,
        protocol: provenance,
        executionRevision: executionEnd,
        analyzerRevision,
        adapterSourceSha256: adapterSource.artifact.sha256,
        analyzerSourceSha256: analyzerSource.artifact.sha256,
        runnerSha256: expectedRunnerHash,
        run,
        revisionStable,
        artifacts,
        cells: analyses,
        diagnostics,
        assessment,
    };
    if (options.outputPath) atomicWrite(resolve(options.outputPath), report);
    return report;
}

function parseCli(argv: string[]): IAnalyzeExternalWaitV2Options {
    const { values } = parseArgs({
        args: argv,
        options: {
            "run-dir": { type: "string" },
            "execution-repo": { type: "string" },
            out: { type: "string" },
            "allow-underpowered": { type: "boolean", default: false },
        },
        strict: true,
        allowPositionals: false,
    });
    if (!values["run-dir"] || !values["execution-repo"]) {
        throw new Error("Usage: --run-dir <external output> --execution-repo <frozen common clone> [--out <report>]");
    }
    return {
        runDir: values["run-dir"],
        executionRepo: values["execution-repo"],
        outputPath: values.out ?? join(values["run-dir"], "analysis.json"),
        allowUnderpowered: values["allow-underpowered"],
    };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
    const report = await analyzeExternalWaitV2Run(parseCli(argv));
    console.log(JSON.stringify(report, null, 2));
    if (report.assessment.evidenceVerdict === "FAIL") process.exitCode = 1;
    else if (report.assessment.evidenceVerdict === "INCONCLUSIVE") process.exitCode = 2;
}

if ((import.meta as unknown as { main?: boolean }).main) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
