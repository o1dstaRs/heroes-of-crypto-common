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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { arch, availableParallelism, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { AI_VERSIONS } from "../ai";
import { DEFAULT_ROSTER_COMPOSITION, STACK_EXPERIENCE_BUDGET } from "./army";
import { runTournamentConcurrent } from "./concurrent_tournament";
import { liveTwinSetup } from "./livetwin";
import type { IGameRecord, ITournamentOptions, ITournamentSummary } from "./tournament";

/**
 * The ratified v0.7 evidence protocol. This harness evaluates evidence only: owner sign-off and journal replay
 * are deliberately outside its authority, so it never emits a bake/release decision.
 */
export const V07_ACCEPTANCE_PROTOCOL = {
    schemaVersion: 1,
    headlineSeeds: 9,
    gamesPerHeadlineSeed: 3000,
    opponents: ["v0.6", "v0.4"] as const,
    champion: "v0.6",
    championWinRate: 0.54,
    transitivityOpponent: "v0.4",
    transitivityMinWinRate: 0.5,
    gamesPerCohortSeed: 3000,
    cohortMinWinRate: 0.5,
    maxHeadlineDrawOrArmageddonRate: 0.01,
    candidateRejectionLimit: 0,
    confidenceLevel: 0.95,
} as const;

export const V07_ACCEPTANCE_COHORTS = ["melee", "mixed", "random"] as const;
export type V07AcceptanceCohort = (typeof V07_ACCEPTANCE_COHORTS)[number];

export interface IV07AcceptanceOptions {
    candidate: string;
    opponents: readonly string[];
    /** Nine caller-preregistered base seeds in a powered run. Each expands into paired side-swap games. */
    headlineSeeds: readonly number[];
    gamesPerHeadlineSeed: number;
    /** Separate, mutually disjoint seeds for the non-regression battery. All three cohorts are mandatory. */
    cohortSeeds: Readonly<Record<V07AcceptanceCohort, readonly number[]>>;
    gamesPerCohortSeed: number;
    concurrency: number;
    /** The harness cannot discover prior seed use. The caller must explicitly attest freshness. */
    seedsDeclaredFresh: boolean;
    /** A powered run must come from a persisted preregistration manifest, not only ad-hoc CLI seed flags. */
    seedManifest: IAcceptanceSeedManifestProvenance | null;
}

export interface IV07AcceptanceCliOptions extends IV07AcceptanceOptions {
    outputPath: string;
    checkpointDir: string;
}

export interface IAcceptanceSeedManifest {
    schemaVersion: 1;
    manifestId: string;
    createdAt: string;
    candidate: string;
    opponents: string[];
    headline: { seeds: number[]; gamesPerSeed: number };
    cohorts: {
        gamesPerSeed: number;
        seeds: Record<V07AcceptanceCohort, number[]>;
    };
    freshSeedsDeclared: boolean;
    declaration: string;
}

export interface IAcceptanceSeedManifestProvenance {
    manifestId: string;
    createdAt: string;
    sourcePath: string;
    sha256: string;
    declaration: string;
}

export interface IRevisionProvenance {
    commit: string;
    commitDate: string;
    branch: string;
    remote: string | null;
    trackedClean: boolean;
    trackedDiffSha256: string | null;
}

export interface IClusterMoments {
    clusters: number;
    sumWinSquared: number;
    sumWinDecisive: number;
    sumDecisiveSquared: number;
}

export interface IPairClusterStats {
    method: "paired-side-swap cluster sandwich";
    confidenceLevel: 0.95;
    games: number;
    pairClusters: number;
    decisiveGames: number;
    candidateWins: number;
    opponentWins: number;
    draws: number;
    candidateWinRate: number;
    deltaFromParityPp: number;
    standardErrorPp: number | null;
    confidence95: { low: number; high: number } | null;
    moments: IClusterMoments;
}

export interface IIntegrityStats {
    games: number;
    draws: number;
    armageddonDecided: number;
    drawOrArmageddon: number;
    drawOrArmageddonRate: number;
    candidateRejections: number;
    opponentRejections: number;
    recordsMissingRejectionCounts: number;
    candidateGamesAsGreen: number;
    candidateGamesAsRed: number;
    candidateWinsAsGreen: number;
    candidateWinsAsRed: number;
    endReasons: Record<string, number>;
}

export interface IAcceptanceCellSpec {
    kind: "headline" | "cohort";
    cohort: V07AcceptanceCohort;
    candidate: string;
    opponent: string;
    baseSeed: number;
    games: number;
}

export interface IAcceptanceCellReport {
    spec: IAcceptanceCellSpec;
    tournament: ITournamentSummary;
    outcomes: IPairClusterStats;
    integrity: IIntegrityStats;
}

export interface IAcceptanceAggregate {
    cells: number;
    outcomes: IPairClusterStats;
    integrity: IIntegrityStats;
}

export interface IAcceptanceGate {
    name: string;
    threshold: string;
    observed: string;
    passed: boolean;
}

export type AcceptanceEvidenceVerdict = "INCONCLUSIVE" | "PASS" | "FAIL";

export interface IV07AcceptanceAssessment {
    evidenceVerdict: AcceptanceEvidenceVerdict;
    protocolPowered: boolean;
    protocolCompletenessReasons: string[];
    gates: IAcceptanceGate[];
    /** Deliberately never inferred by simulation output. */
    bakeDecision: "NOT_EVALUATED";
    ownerSignOff: "NOT_EVALUATED";
    journalReplayDecisionDivergence: "NOT_EVALUATED";
    releaseInstruction: "NO_BAKE_FROM_THIS_REPORT";
}

export interface IV07AcceptanceReport {
    schemaVersion: 1;
    generatedAt: string;
    completedAt: string;
    elapsedSeconds: number;
    provenance: {
        revision: IRevisionProvenance;
        revisionAtCompletion: IRevisionProvenance;
        revisionStable: boolean;
        command: string[];
        cwd: string;
        runtime: { bun: string | null; node: string; platform: string; release: string; arch: string };
        runFingerprint: string;
        resumedCells: number;
    };
    protocol: typeof V07_ACCEPTANCE_PROTOCOL;
    requested: IV07AcceptanceOptions;
    effectiveConfig: {
        preset: "LiveTwin";
        amountMode: "expBudget";
        stackExperienceBudget: number;
        composition: typeof DEFAULT_ROSTER_COMPOSITION;
        setup: ReturnType<typeof liveTwinSetup> & { noVision: true };
        independentTeamRosters: true;
        pairedSideSwap: true;
        map: "NORMAL";
        headline: { cohort: "melee"; meleeDraftFraction: 1 };
        cohorts: Record<V07AcceptanceCohort, { meleeDraftFraction: number }>;
        cohortProtocolNote: string;
        rangeSpecialistCohortIncluded: false;
        environmentPolicy: "sanitized-defaults-only";
        deniedBehaviorEnvironment: { prefixes: readonly string[]; exact: readonly string[] };
    };
    headline: {
        cells: IAcceptanceCellReport[];
        byOpponent: Record<string, IAcceptanceAggregate>;
        combined: IAcceptanceAggregate;
    };
    cohortNonRegression: {
        cells: IAcceptanceCellReport[];
        byOpponent: Record<string, Record<V07AcceptanceCohort, IAcceptanceAggregate>>;
        allPassedPointEstimate: boolean;
    };
    assessment: IV07AcceptanceAssessment;
}

export interface IV07AcceptanceDependencies {
    runTournament: (
        options: ITournamentOptions,
        concurrency: number,
        onGame: (record: IGameRecord) => void,
    ) => Promise<ITournamentSummary> | ITournamentSummary;
    now: () => Date;
    revision: () => IRevisionProvenance;
    command: () => string[];
    cwd: () => string;
    loadCheckpoint: (spec: IAcceptanceCellSpec, runFingerprint: string) => IAcceptanceCellReport | undefined;
    saveCheckpoint: (cell: IAcceptanceCellReport, runFingerprint: string) => void;
    onCellComplete: (cell: IAcceptanceCellReport, completed: number, total: number, resumed: boolean) => void;
}

const DEFAULT_DEPENDENCIES: IV07AcceptanceDependencies = {
    runTournament: runTournamentConcurrent,
    now: () => new Date(),
    revision: readRevisionProvenance,
    command: () => process.argv.slice(),
    cwd: () => process.cwd(),
    loadCheckpoint: () => undefined,
    saveCheckpoint: () => undefined,
    onCellComplete: () => undefined,
};

const COHORT_FRACTION: Readonly<Record<V07AcceptanceCohort, number>> = {
    melee: 1,
    mixed: 0.5,
    random: 0,
};

const FIXED_ENV_KEYS = [
    "LIVETWIN",
    "FIGHT_MELEE_ROSTERS",
    "ROSTER_RANGED_MIN",
    "ROSTER_RANGED_MAX",
    "AUGCA_NOVISION",
    "FORCE_CREATURES",
    "SIM_NO_ACTIONS",
    "VALUE_DATA",
    "V05_SKIP_AUDIT",
] as const;

const BEHAVIOR_ENV_PREFIXES = ["V04_", "V05_", "V06_", "V07_", "SEARCH_", "Q2_", "CEM_"] as const;
const BEHAVIOR_ENV_EXACT_KEYS = [
    "AUGCA_NOVISION",
    "FIGHT_MELEE_ROSTERS",
    "FORCE_CREATURES",
    "LIVETWIN",
    "ROSTER_RANGED_MAX",
    "ROSTER_RANGED_MIN",
] as const;
const BEHAVIOR_ENV_EXACT = new Set<string>(BEHAVIOR_ENV_EXACT_KEYS);

function shellText(args: string[]): string {
    try {
        return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
        return "";
    }
}

export function readRevisionProvenance(): IRevisionProvenance {
    const commit = shellText(["rev-parse", "HEAD"]);
    if (!commit) {
        throw new Error("Acceptance provenance requires a git checkout with a readable HEAD");
    }
    const diff = execFileSync("git", ["diff", "--binary", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
    });
    return {
        commit,
        commitDate: shellText(["show", "-s", "--format=%cI", "HEAD"]),
        branch: shellText(["rev-parse", "--abbrev-ref", "HEAD"]),
        remote: shellText(["remote", "get-url", "origin"]) || null,
        trackedClean: diff.length === 0,
        trackedDiffSha256: diff.length === 0 ? null : createHash("sha256").update(diff).digest("hex"),
    };
}

function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

function runFingerprint(options: IV07AcceptanceOptions, revision: IRevisionProvenance): string {
    return sha256(
        JSON.stringify({
            schemaVersion: V07_ACCEPTANCE_PROTOCOL.schemaVersion,
            candidate: options.candidate,
            opponents: options.opponents,
            headlineSeeds: options.headlineSeeds,
            gamesPerHeadlineSeed: options.gamesPerHeadlineSeed,
            cohortSeeds: options.cohortSeeds,
            gamesPerCohortSeed: options.gamesPerCohortSeed,
            revision: {
                commit: revision.commit,
                trackedClean: revision.trackedClean,
                trackedDiffSha256: revision.trackedDiffSha256,
            },
            effective: {
                preset: "LiveTwin",
                headlineMeleeDraftFraction: 1,
                cohortFractions: COHORT_FRACTION,
                amountMode: "expBudget",
                pairedSideSwap: true,
            },
        }),
    );
}

interface ICellCheckpoint {
    schemaVersion: 1;
    runFingerprint: string;
    cellSha256: string;
    cell: IAcceptanceCellReport;
}

function safeCellName(spec: IAcceptanceCellSpec): string {
    return `${spec.kind}_${spec.cohort}_${spec.opponent}_seed${spec.baseSeed}`.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function loadAcceptanceCheckpoint(
    checkpointDir: string,
    spec: IAcceptanceCellSpec,
    expectedFingerprint: string,
): IAcceptanceCellReport | undefined {
    const path = join(checkpointDir, `${safeCellName(spec)}.json`);
    if (!existsSync(path)) return undefined;
    const checkpoint = JSON.parse(readFileSync(path, "utf8")) as ICellCheckpoint;
    if (checkpoint.schemaVersion !== 1 || checkpoint.runFingerprint !== expectedFingerprint) return undefined;
    const encodedCell = JSON.stringify(checkpoint.cell);
    if (sha256(encodedCell) !== checkpoint.cellSha256) {
        throw new Error(`Corrupt acceptance checkpoint: ${path}`);
    }
    if (JSON.stringify(checkpoint.cell.spec) !== JSON.stringify(spec)) return undefined;
    return checkpoint.cell;
}

export function saveAcceptanceCheckpoint(
    checkpointDir: string,
    cell: IAcceptanceCellReport,
    fingerprint: string,
): void {
    mkdirSync(checkpointDir, { recursive: true });
    const path = join(checkpointDir, `${safeCellName(cell.spec)}.json`);
    const temporary = `${path}.tmp-${process.pid}`;
    const cellJson = JSON.stringify(cell);
    const checkpoint: ICellCheckpoint = {
        schemaVersion: 1,
        runFingerprint: fingerprint,
        cellSha256: sha256(cellJson),
        cell,
    };
    writeFileSync(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`);
    renameSync(temporary, path);
}

function behaviorEnvironment(source: NodeJS.ProcessEnv = process.env): string[] {
    return Object.keys(source)
        .filter((key) => BEHAVIOR_ENV_EXACT.has(key) || BEHAVIOR_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)))
        .filter((key) => source[key] !== undefined)
        .sort();
}

async function withAcceptanceEnvironment<T>(meleeDraftFraction: number, operation: () => Promise<T>): Promise<T> {
    const dynamicKeys = behaviorEnvironment();
    const keys = new Set<string>([...FIXED_ENV_KEYS, ...dynamicKeys]);
    const saved = new Map([...keys].map((key) => [key, process.env[key]]));
    for (const key of keys) {
        delete process.env[key];
    }
    process.env.LIVETWIN = "1";
    process.env.FIGHT_MELEE_ROSTERS = String(meleeDraftFraction);
    process.env.AUGCA_NOVISION = "1";
    process.env.SIM_NO_ACTIONS = "1";
    try {
        return await operation();
    } finally {
        for (const [key, value] of saved) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }
}

function validateUint32(name: string, value: number): void {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
        throw new Error(`${name} must be an integer in [0, 2^32-1]; got ${value}`);
    }
}

function validateGames(name: string, value: number): void {
    if (!Number.isSafeInteger(value) || value < 2 || value % 2 !== 0) {
        throw new Error(`${name} must be an even integer >= 2 so every game has its side-swapped partner`);
    }
}

function seedContexts(options: IV07AcceptanceOptions): Array<{ label: string; seed: number; games: number }> {
    const contexts = options.headlineSeeds.map((seed, index) => ({
        label: `headline[${index}]`,
        seed,
        games: options.gamesPerHeadlineSeed,
    }));
    for (const cohort of V07_ACCEPTANCE_COHORTS) {
        options.cohortSeeds[cohort].forEach((seed, index) => {
            contexts.push({ label: `${cohort}[${index}]`, seed, games: options.gamesPerCohortSeed });
        });
    }
    return contexts;
}

/** Reject base-seed reuse and less-obvious overlap between the derived pair-seed streams. */
function validateDisjointSeedStreams(options: IV07AcceptanceOptions): void {
    const seen = new Map<number, string>();
    for (const context of seedContexts(options)) {
        validateUint32(`${context.label} seed`, context.seed);
        for (let pair = 0; pair < context.games / 2; pair += 1) {
            const derived = (context.seed + pair * 0x9e3779b1) >>> 0;
            const previous = seen.get(derived);
            if (previous) {
                throw new Error(
                    `Seed streams overlap at derived seed ${derived}: ${previous} and ${context.label}; ` +
                        "headline and cohort evidence must use disjoint scenarios",
                );
            }
            seen.set(derived, context.label);
        }
    }
}

export function validateV07AcceptanceOptions(options: IV07AcceptanceOptions): void {
    if (!AI_VERSIONS.includes(options.candidate)) {
        throw new Error(
            `Unknown candidate version "${options.candidate}". Register it first; known versions: ${AI_VERSIONS.join(", ")}`,
        );
    }
    if (options.opponents.length === 0 || new Set(options.opponents).size !== options.opponents.length) {
        throw new Error("opponents must be a non-empty list of unique registered versions");
    }
    for (const opponent of options.opponents) {
        if (!AI_VERSIONS.includes(opponent)) {
            throw new Error(`Unknown opponent version "${opponent}". Known versions: ${AI_VERSIONS.join(", ")}`);
        }
        if (opponent === options.candidate) {
            throw new Error(`Candidate ${options.candidate} cannot also be an opponent`);
        }
    }
    validateGames("gamesPerHeadlineSeed", options.gamesPerHeadlineSeed);
    validateGames("gamesPerCohortSeed", options.gamesPerCohortSeed);
    if (options.headlineSeeds.length === 0) {
        throw new Error("headlineSeeds must contain at least one seed");
    }
    for (const cohort of V07_ACCEPTANCE_COHORTS) {
        if (!Array.isArray(options.cohortSeeds[cohort]) || options.cohortSeeds[cohort].length === 0) {
            throw new Error(`cohortSeeds.${cohort} must contain at least one disjoint seed`);
        }
    }
    if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
        throw new Error("concurrency must be a positive integer");
    }
    validateDisjointSeedStreams(options);
}

function candidateWon(record: IGameRecord): boolean {
    if (record.result.winner === "draw") return false;
    return record.result.winner === "green" ? record.greenEntrant === "a" : record.greenEntrant === "b";
}

function emptyIntegrity(): IIntegrityStats {
    return {
        games: 0,
        draws: 0,
        armageddonDecided: 0,
        drawOrArmageddon: 0,
        drawOrArmageddonRate: 0,
        candidateRejections: 0,
        opponentRejections: 0,
        recordsMissingRejectionCounts: 0,
        candidateGamesAsGreen: 0,
        candidateGamesAsRed: 0,
        candidateWinsAsGreen: 0,
        candidateWinsAsRed: 0,
        endReasons: {},
    };
}

function clusteredStats(
    candidateWins: number,
    opponentWins: number,
    draws: number,
    moments: IClusterMoments,
): IPairClusterStats {
    const decisiveGames = candidateWins + opponentWins;
    const games = decisiveGames + draws;
    const candidateWinRate = decisiveGames > 0 ? candidateWins / decisiveGames : 0.5;
    let standardError: number | null = null;
    let confidence95: { low: number; high: number } | null = null;
    if (moments.clusters >= 2 && decisiveGames > 0) {
        const residualSquares =
            moments.sumWinSquared -
            2 * candidateWinRate * moments.sumWinDecisive +
            candidateWinRate * candidateWinRate * moments.sumDecisiveSquared;
        const finiteSample = moments.clusters / (moments.clusters - 1);
        standardError = Math.sqrt(Math.max(0, (finiteSample * residualSquares) / (decisiveGames * decisiveGames)));
        const z = 1.959963984540054;
        confidence95 = {
            low: Math.max(0, candidateWinRate - z * standardError),
            high: Math.min(1, candidateWinRate + z * standardError),
        };
    }
    return {
        method: "paired-side-swap cluster sandwich",
        confidenceLevel: 0.95,
        games,
        pairClusters: moments.clusters,
        decisiveGames,
        candidateWins,
        opponentWins,
        draws,
        candidateWinRate,
        deltaFromParityPp: (candidateWinRate - 0.5) * 100,
        standardErrorPp: standardError === null ? null : standardError * 100,
        confidence95,
        moments,
    };
}

export function summarizeAcceptanceCell(
    spec: IAcceptanceCellSpec,
    records: readonly IGameRecord[],
    tournament: ITournamentSummary,
): IAcceptanceCellReport {
    const byGame = new Map<number, IGameRecord>();
    for (const record of records) {
        if (!Number.isSafeInteger(record.game) || record.game < 0 || record.game >= spec.games) {
            throw new Error(`${spec.kind} ${spec.opponent} seed ${spec.baseSeed}: out-of-range game ${record.game}`);
        }
        if (byGame.has(record.game)) {
            throw new Error(`${spec.kind} ${spec.opponent} seed ${spec.baseSeed}: duplicate game ${record.game}`);
        }
        byGame.set(record.game, record);
    }
    if (byGame.size !== spec.games) {
        throw new Error(
            `${spec.kind} ${spec.opponent} seed ${spec.baseSeed}: collected ${byGame.size}/${spec.games} game records`,
        );
    }

    let candidateWins = 0;
    let opponentWins = 0;
    let draws = 0;
    const moments: IClusterMoments = {
        clusters: spec.games / 2,
        sumWinSquared: 0,
        sumWinDecisive: 0,
        sumDecisiveSquared: 0,
    };
    const integrity = emptyIntegrity();

    for (let pair = 0; pair < spec.games / 2; pair += 1) {
        let pairWins = 0;
        let pairDecisive = 0;
        for (const game of [pair * 2, pair * 2 + 1]) {
            const record = byGame.get(game)!;
            const expectedEntrant = game % 2 === 0 ? "a" : "b";
            if (record.greenEntrant !== expectedEntrant) {
                throw new Error(
                    `${spec.kind} ${spec.opponent} seed ${spec.baseSeed}: game ${game} did not side-swap entrant A`,
                );
            }
            if (record.greenVersion !== (expectedEntrant === "a" ? spec.candidate : spec.opponent)) {
                throw new Error(`${spec.kind} ${spec.opponent} seed ${spec.baseSeed}: game ${game} version mismatch`);
            }
            if (record.redVersion !== (expectedEntrant === "a" ? spec.opponent : spec.candidate)) {
                throw new Error(`${spec.kind} ${spec.opponent} seed ${spec.baseSeed}: game ${game} version mismatch`);
            }

            const candidateIsGreen = record.greenEntrant === "a";
            const won = candidateWon(record);
            if (record.result.winner === "draw") {
                draws += 1;
                integrity.draws += 1;
            } else {
                pairDecisive += 1;
                if (won) {
                    candidateWins += 1;
                    pairWins += 1;
                    if (candidateIsGreen) integrity.candidateWinsAsGreen += 1;
                    else integrity.candidateWinsAsRed += 1;
                } else {
                    opponentWins += 1;
                }
            }
            integrity.games += 1;
            if (candidateIsGreen) integrity.candidateGamesAsGreen += 1;
            else integrity.candidateGamesAsRed += 1;
            const armageddon = record.result.attrition.decidedByArmageddon;
            if (armageddon) integrity.armageddonDecided += 1;
            if (armageddon || record.result.winner === "draw") integrity.drawOrArmageddon += 1;
            if (record.result.rejectedGreen === undefined || record.result.rejectedRed === undefined) {
                integrity.recordsMissingRejectionCounts += 1;
            } else if (candidateIsGreen) {
                integrity.candidateRejections += record.result.rejectedGreen;
                integrity.opponentRejections += record.result.rejectedRed;
            } else {
                integrity.candidateRejections += record.result.rejectedRed;
                integrity.opponentRejections += record.result.rejectedGreen;
            }
            integrity.endReasons[record.result.endReason] = (integrity.endReasons[record.result.endReason] ?? 0) + 1;
        }
        moments.sumWinSquared += pairWins * pairWins;
        moments.sumWinDecisive += pairWins * pairDecisive;
        moments.sumDecisiveSquared += pairDecisive * pairDecisive;
    }
    integrity.drawOrArmageddonRate = integrity.games > 0 ? integrity.drawOrArmageddon / integrity.games : 0;

    if (
        tournament.games !== spec.games ||
        tournament.a.wins !== candidateWins ||
        tournament.b.wins !== opponentWins ||
        tournament.draws !== draws ||
        tournament.armageddonDecided !== integrity.armageddonDecided
    ) {
        throw new Error(`${spec.kind} ${spec.opponent} seed ${spec.baseSeed}: summary disagrees with game records`);
    }
    return {
        spec,
        tournament,
        outcomes: clusteredStats(candidateWins, opponentWins, draws, moments),
        integrity,
    };
}

function addIntegrity(target: IIntegrityStats, source: IIntegrityStats): void {
    for (const key of [
        "games",
        "draws",
        "armageddonDecided",
        "drawOrArmageddon",
        "candidateRejections",
        "opponentRejections",
        "recordsMissingRejectionCounts",
        "candidateGamesAsGreen",
        "candidateGamesAsRed",
        "candidateWinsAsGreen",
        "candidateWinsAsRed",
    ] as const) {
        target[key] += source[key];
    }
    for (const [reason, count] of Object.entries(source.endReasons)) {
        target.endReasons[reason] = (target.endReasons[reason] ?? 0) + count;
    }
}

export function aggregateAcceptanceCells(cells: readonly IAcceptanceCellReport[]): IAcceptanceAggregate {
    let candidateWins = 0;
    let opponentWins = 0;
    let draws = 0;
    const moments: IClusterMoments = {
        clusters: 0,
        sumWinSquared: 0,
        sumWinDecisive: 0,
        sumDecisiveSquared: 0,
    };
    const integrity = emptyIntegrity();
    for (const cell of cells) {
        candidateWins += cell.outcomes.candidateWins;
        opponentWins += cell.outcomes.opponentWins;
        draws += cell.outcomes.draws;
        moments.clusters += cell.outcomes.moments.clusters;
        moments.sumWinSquared += cell.outcomes.moments.sumWinSquared;
        moments.sumWinDecisive += cell.outcomes.moments.sumWinDecisive;
        moments.sumDecisiveSquared += cell.outcomes.moments.sumDecisiveSquared;
        addIntegrity(integrity, cell.integrity);
    }
    integrity.drawOrArmageddonRate = integrity.games > 0 ? integrity.drawOrArmageddon / integrity.games : 0;
    return {
        cells: cells.length,
        outcomes: clusteredStats(candidateWins, opponentWins, draws, moments),
        integrity,
    };
}

function sameMembers(actual: readonly string[], expected: readonly string[]): boolean {
    return actual.length === expected.length && expected.every((value) => actual.includes(value));
}

export function assessV07Acceptance(
    options: IV07AcceptanceOptions,
    revision: IRevisionProvenance,
    headlineByOpponent: Readonly<Record<string, IAcceptanceAggregate>>,
    cohortsByOpponent: Readonly<Record<string, Readonly<Record<V07AcceptanceCohort, IAcceptanceAggregate>>>>,
    revisionStable: boolean = true,
): IV07AcceptanceAssessment {
    const reasons: string[] = [];
    if (options.headlineSeeds.length !== V07_ACCEPTANCE_PROTOCOL.headlineSeeds) {
        reasons.push(
            `headline seed count is ${options.headlineSeeds.length}; protocol requires ${V07_ACCEPTANCE_PROTOCOL.headlineSeeds}`,
        );
    }
    if (options.gamesPerHeadlineSeed !== V07_ACCEPTANCE_PROTOCOL.gamesPerHeadlineSeed) {
        reasons.push(
            `headline games/seed is ${options.gamesPerHeadlineSeed}; protocol requires ${V07_ACCEPTANCE_PROTOCOL.gamesPerHeadlineSeed}`,
        );
    }
    if (!sameMembers(options.opponents, V07_ACCEPTANCE_PROTOCOL.opponents)) {
        reasons.push(`opponents are ${options.opponents.join(",")}; protocol requires v0.6 and v0.4`);
    }
    if (options.gamesPerCohortSeed !== V07_ACCEPTANCE_PROTOCOL.gamesPerCohortSeed) {
        reasons.push(
            `cohort games/seed is ${options.gamesPerCohortSeed}; protocol requires ${V07_ACCEPTANCE_PROTOCOL.gamesPerCohortSeed}`,
        );
    }
    for (const cohort of V07_ACCEPTANCE_COHORTS) {
        if (options.cohortSeeds[cohort].length === 0) {
            reasons.push(`${cohort} non-regression cohort is missing`);
        }
    }
    if (!options.seedsDeclaredFresh) reasons.push("seed freshness was not declared by the caller");
    if (!options.seedManifest) reasons.push("seed panel was not loaded from a persisted preregistration manifest");
    if (!revision.trackedClean) reasons.push("tracked working tree was dirty at evaluation time");
    if (!revisionStable) reasons.push("Git revision or tracked diff changed while the evaluation was running");

    const gates: IAcceptanceGate[] = [];
    const champion = headlineByOpponent[V07_ACCEPTANCE_PROTOCOL.champion];
    gates.push({
        name: "headline-vs-v0.6",
        threshold: ">=54.00% decisive win rate (+4.00pp)",
        observed: champion ? `${(champion.outcomes.candidateWinRate * 100).toFixed(3)}%` : "missing",
        passed: !!champion && champion.outcomes.candidateWinRate >= V07_ACCEPTANCE_PROTOCOL.championWinRate,
    });
    const transitivity = headlineByOpponent[V07_ACCEPTANCE_PROTOCOL.transitivityOpponent];
    gates.push({
        name: "round-robin-vs-v0.4",
        threshold: ">=50.00% decisive win rate",
        observed: transitivity ? `${(transitivity.outcomes.candidateWinRate * 100).toFixed(3)}%` : "missing",
        passed:
            !!transitivity && transitivity.outcomes.candidateWinRate >= V07_ACCEPTANCE_PROTOCOL.transitivityMinWinRate,
    });

    for (const opponent of V07_ACCEPTANCE_PROTOCOL.opponents) {
        for (const cohort of V07_ACCEPTANCE_COHORTS) {
            const aggregate = cohortsByOpponent[opponent]?.[cohort];
            gates.push({
                name: `non-regression-${cohort}-vs-${opponent}`,
                threshold: ">=50.00% decisive win rate",
                observed: aggregate ? `${(aggregate.outcomes.candidateWinRate * 100).toFixed(3)}%` : "missing",
                passed: !!aggregate && aggregate.outcomes.candidateWinRate >= V07_ACCEPTANCE_PROTOCOL.cohortMinWinRate,
            });
        }
    }

    const headlineAggregates = Object.values(headlineByOpponent);
    const allAggregates = [
        ...headlineAggregates,
        ...Object.values(cohortsByOpponent).flatMap((byCohort) =>
            V07_ACCEPTANCE_COHORTS.map((cohort) => byCohort[cohort]).filter(
                (aggregate): aggregate is IAcceptanceAggregate => aggregate !== undefined,
            ),
        ),
    ];
    const maxHeadlineIntegrity = headlineAggregates.reduce(
        (max, aggregate) => Math.max(max, aggregate.integrity.drawOrArmageddonRate),
        0,
    );
    gates.push({
        name: "headline-integrity",
        threshold: "draw OR armageddon <=1.00% for each opponent",
        observed: `${(maxHeadlineIntegrity * 100).toFixed(3)}% maximum`,
        passed:
            headlineAggregates.length === V07_ACCEPTANCE_PROTOCOL.opponents.length &&
            headlineAggregates.every(
                (aggregate) =>
                    aggregate.integrity.drawOrArmageddonRate <= V07_ACCEPTANCE_PROTOCOL.maxHeadlineDrawOrArmageddonRate,
            ),
    });
    const candidateRejections = allAggregates.reduce(
        (total, aggregate) => total + aggregate.integrity.candidateRejections,
        0,
    );
    const missingRejectionCounts = allAggregates.reduce(
        (total, aggregate) => total + aggregate.integrity.recordsMissingRejectionCounts,
        0,
    );
    gates.push({
        name: "candidate-engine-rejections",
        threshold: "0 candidate rejections; rejection counts present on every game",
        observed: `${candidateRejections} rejections; ${missingRejectionCounts} records missing counts`,
        passed: candidateRejections <= V07_ACCEPTANCE_PROTOCOL.candidateRejectionLimit && missingRejectionCounts === 0,
    });

    const protocolPowered = reasons.length === 0;
    return {
        evidenceVerdict: protocolPowered ? (gates.every((gate) => gate.passed) ? "PASS" : "FAIL") : "INCONCLUSIVE",
        protocolPowered,
        protocolCompletenessReasons: reasons,
        gates,
        bakeDecision: "NOT_EVALUATED",
        ownerSignOff: "NOT_EVALUATED",
        journalReplayDecisionDivergence: "NOT_EVALUATED",
        releaseInstruction: "NO_BAKE_FROM_THIS_REPORT",
    };
}

function buildCellSpecs(options: IV07AcceptanceOptions): IAcceptanceCellSpec[] {
    const cells: IAcceptanceCellSpec[] = [];
    for (const opponent of options.opponents) {
        for (const baseSeed of options.headlineSeeds) {
            cells.push({
                kind: "headline",
                cohort: "melee",
                candidate: options.candidate,
                opponent,
                baseSeed,
                games: options.gamesPerHeadlineSeed,
            });
        }
        for (const cohort of V07_ACCEPTANCE_COHORTS) {
            for (const baseSeed of options.cohortSeeds[cohort]) {
                cells.push({
                    kind: "cohort",
                    cohort,
                    candidate: options.candidate,
                    opponent,
                    baseSeed,
                    games: options.gamesPerCohortSeed,
                });
            }
        }
    }
    return cells;
}

async function runCell(
    spec: IAcceptanceCellSpec,
    concurrency: number,
    runTournament: IV07AcceptanceDependencies["runTournament"],
): Promise<IAcceptanceCellReport> {
    const records: IGameRecord[] = [];
    const fraction = spec.kind === "headline" ? 1 : COHORT_FRACTION[spec.cohort];
    const tournament = await withAcceptanceEnvironment(fraction, () =>
        Promise.resolve(
            runTournament(
                {
                    versionA: spec.candidate,
                    versionB: spec.opponent,
                    games: spec.games,
                    baseSeed: spec.baseSeed,
                    amountMode: "expBudget",
                    randomizePicks: true,
                    lightweight: true,
                },
                Math.min(concurrency, spec.games),
                (record) => records.push(record),
            ),
        ),
    );
    return summarizeAcceptanceCell(spec, records, tournament);
}

export async function runV07Acceptance(
    options: IV07AcceptanceOptions,
    dependencies: Partial<IV07AcceptanceDependencies> = {},
): Promise<IV07AcceptanceReport> {
    validateV07AcceptanceOptions(options);
    const ambient = behaviorEnvironment();
    if (ambient.length > 0) {
        throw new Error(
            `Refusing acceptance under behavior-changing environment: ${ambient.join(", ")}. ` +
                "Unset these variables; the harness evaluates committed defaults only.",
        );
    }
    const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
    const revision = deps.revision();
    const fingerprint = runFingerprint(options, revision);
    const started = deps.now();
    const specs = buildCellSpecs(options);
    const cells: IAcceptanceCellReport[] = [];
    let resumedCells = 0;
    for (const spec of specs) {
        const checkpoint = deps.loadCheckpoint(spec, fingerprint);
        const resumed = checkpoint !== undefined;
        const cell = checkpoint ?? (await runCell(spec, options.concurrency, deps.runTournament));
        if (resumed) resumedCells += 1;
        else deps.saveCheckpoint(cell, fingerprint);
        cells.push(cell);
        deps.onCellComplete(cell, cells.length, specs.length, resumed);
    }
    const revisionAtCompletion = deps.revision();
    const revisionStable =
        revision.commit === revisionAtCompletion.commit &&
        revision.trackedClean === revisionAtCompletion.trackedClean &&
        revision.trackedDiffSha256 === revisionAtCompletion.trackedDiffSha256;
    const completed = deps.now();
    const headlineCells = cells.filter((cell) => cell.spec.kind === "headline");
    const cohortCells = cells.filter((cell) => cell.spec.kind === "cohort");
    const headlineByOpponent: Record<string, IAcceptanceAggregate> = {};
    const cohortsByOpponent: Record<string, Record<V07AcceptanceCohort, IAcceptanceAggregate>> = {};
    for (const opponent of options.opponents) {
        headlineByOpponent[opponent] = aggregateAcceptanceCells(
            headlineCells.filter((cell) => cell.spec.opponent === opponent),
        );
        cohortsByOpponent[opponent] = {} as Record<V07AcceptanceCohort, IAcceptanceAggregate>;
        for (const cohort of V07_ACCEPTANCE_COHORTS) {
            cohortsByOpponent[opponent][cohort] = aggregateAcceptanceCells(
                cohortCells.filter((cell) => cell.spec.opponent === opponent && cell.spec.cohort === cohort),
            );
        }
    }
    const assessment = assessV07Acceptance(options, revision, headlineByOpponent, cohortsByOpponent, revisionStable);
    const setup = liveTwinSetup();
    return {
        schemaVersion: 1,
        generatedAt: started.toISOString(),
        completedAt: completed.toISOString(),
        elapsedSeconds: Math.max(0, (completed.getTime() - started.getTime()) / 1000),
        provenance: {
            revision,
            revisionAtCompletion,
            revisionStable,
            command: deps.command(),
            cwd: deps.cwd(),
            runtime: {
                bun: process.versions.bun ?? null,
                node: process.version,
                platform: platform(),
                release: release(),
                arch: arch(),
            },
            runFingerprint: fingerprint,
            resumedCells,
        },
        protocol: V07_ACCEPTANCE_PROTOCOL,
        requested: options,
        effectiveConfig: {
            preset: "LiveTwin",
            amountMode: "expBudget",
            stackExperienceBudget: STACK_EXPERIENCE_BUDGET,
            composition: DEFAULT_ROSTER_COMPOSITION,
            setup: { ...setup, noVision: true },
            independentTeamRosters: true,
            pairedSideSwap: true,
            map: "NORMAL",
            headline: { cohort: "melee", meleeDraftFraction: 1 },
            cohorts: {
                melee: { meleeDraftFraction: 1 },
                mixed: { meleeDraftFraction: 0.5 },
                random: { meleeDraftFraction: 0 },
            },
            cohortProtocolNote:
                "Acceptance uses melee/mixed50/random. The mixed cohort is a deterministic 50% pair-level " +
                "mixture of melee-drafted and random rosters; it is not the legacy range-specialist cohort.",
            rangeSpecialistCohortIncluded: false,
            environmentPolicy: "sanitized-defaults-only",
            deniedBehaviorEnvironment: {
                prefixes: BEHAVIOR_ENV_PREFIXES,
                exact: BEHAVIOR_ENV_EXACT_KEYS,
            },
        },
        headline: {
            cells: headlineCells,
            byOpponent: headlineByOpponent,
            combined: aggregateAcceptanceCells(headlineCells),
        },
        cohortNonRegression: {
            cells: cohortCells,
            byOpponent: cohortsByOpponent,
            allPassedPointEstimate: options.opponents.every((opponent) =>
                V07_ACCEPTANCE_COHORTS.every(
                    (cohort) =>
                        cohortsByOpponent[opponent][cohort].outcomes.candidateWinRate >=
                        V07_ACCEPTANCE_PROTOCOL.cohortMinWinRate,
                ),
            ),
        },
        assessment,
    };
}

function parseSeedList(name: string, raw: string | undefined): number[] {
    if (!raw?.trim()) throw new Error(`--${name} is required`);
    const seeds = raw.split(",").map((value) => Number(value.trim()));
    seeds.forEach((seed, index) => validateUint32(`${name}[${index}]`, seed));
    return seeds;
}

export function readAcceptanceSeedManifest(manifestPath: string): {
    manifest: IAcceptanceSeedManifest;
    provenance: IAcceptanceSeedManifestProvenance;
} {
    const sourcePath = resolve(manifestPath);
    const raw = readFileSync(sourcePath, "utf8");
    const parsed = JSON.parse(raw) as IAcceptanceSeedManifest;
    if (parsed.schemaVersion !== 1) throw new Error(`Unsupported acceptance seed manifest schema in ${sourcePath}`);
    if (!parsed.manifestId?.trim()) throw new Error(`Seed manifest ${sourcePath} requires a non-empty manifestId`);
    if (!parsed.createdAt || !Number.isFinite(Date.parse(parsed.createdAt))) {
        throw new Error(`Seed manifest ${sourcePath} requires an ISO createdAt timestamp`);
    }
    if (!parsed.candidate || !Array.isArray(parsed.opponents)) {
        throw new Error(`Seed manifest ${sourcePath} requires candidate and opponents`);
    }
    if (!parsed.headline || !Array.isArray(parsed.headline.seeds) || !parsed.cohorts?.seeds) {
        throw new Error(`Seed manifest ${sourcePath} requires headline and cohort seed panels`);
    }
    if (!parsed.declaration?.trim()) {
        throw new Error(`Seed manifest ${sourcePath} requires an explicit freshness declaration`);
    }
    return {
        manifest: parsed,
        provenance: {
            manifestId: parsed.manifestId,
            createdAt: parsed.createdAt,
            sourcePath,
            sha256: sha256(raw),
            declaration: parsed.declaration,
        },
    };
}

export function parseV07AcceptanceArgs(argv: string[], cwd: string = process.cwd()): IV07AcceptanceCliOptions {
    const parsed = parseArgs({
        args: argv,
        allowPositionals: true,
        strict: true,
        options: {
            opponents: { type: "string", default: V07_ACCEPTANCE_PROTOCOL.opponents.join(",") },
            "headline-seeds": { type: "string" },
            "melee-seeds": { type: "string" },
            "mixed-seeds": { type: "string" },
            "random-seeds": { type: "string" },
            games: { type: "string", default: String(V07_ACCEPTANCE_PROTOCOL.gamesPerHeadlineSeed) },
            "cohort-games": { type: "string", default: String(V07_ACCEPTANCE_PROTOCOL.gamesPerCohortSeed) },
            concurrency: {
                type: "string",
                default: String(Math.min(12, Math.max(1, availableParallelism()))),
            },
            output: { type: "string" },
            manifest: { type: "string" },
            "checkpoint-dir": { type: "string" },
            "fresh-seeds-confirmed": { type: "boolean", default: false },
        },
    });
    if (parsed.positionals.length !== 1) {
        throw new Error(
            "usage: v0_7_acceptance <candidate> --manifest=seeds.json " +
                "(or smoke-only: --headline-seeds=a,... --melee-seeds=j " +
                "--mixed-seeds=k --random-seeds=l [--games=3000] [--cohort-games=3000] " +
                "[--opponents=v0.6,v0.4] [--fresh-seeds-confirmed]) " +
                "[--concurrency=12] [--checkpoint-dir=dir] [--output=report.json]",
        );
    }
    const candidate = parsed.positionals[0];
    const loadedManifest = parsed.values.manifest
        ? readAcceptanceSeedManifest(resolve(cwd, parsed.values.manifest))
        : undefined;
    if (loadedManifest) {
        const inlineConfigFlags = [
            "--opponents",
            "--headline-seeds",
            "--melee-seeds",
            "--mixed-seeds",
            "--random-seeds",
            "--games",
            "--cohort-games",
            "--fresh-seeds-confirmed",
        ];
        const conflict = argv.find((arg) =>
            inlineConfigFlags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)),
        );
        if (conflict) throw new Error(`${conflict} cannot override the preregistered --manifest`);
    }
    if (loadedManifest && loadedManifest.manifest.candidate !== candidate) {
        throw new Error(
            `CLI candidate ${candidate} does not match manifest candidate ${loadedManifest.manifest.candidate}`,
        );
    }
    const opponents = loadedManifest
        ? loadedManifest.manifest.opponents
        : parsed.values.opponents!.split(",").map((value) => value.trim());
    const headlineSeeds = loadedManifest
        ? loadedManifest.manifest.headline.seeds
        : parseSeedList("headline-seeds", parsed.values["headline-seeds"]);
    const cohortSeeds = loadedManifest
        ? loadedManifest.manifest.cohorts.seeds
        : {
              melee: parseSeedList("melee-seeds", parsed.values["melee-seeds"]),
              mixed: parseSeedList("mixed-seeds", parsed.values["mixed-seeds"]),
              random: parseSeedList("random-seeds", parsed.values["random-seeds"]),
          };
    const gamesPerHeadlineSeed = loadedManifest
        ? loadedManifest.manifest.headline.gamesPerSeed
        : Number(parsed.values.games);
    const gamesPerCohortSeed = loadedManifest
        ? loadedManifest.manifest.cohorts.gamesPerSeed
        : Number(parsed.values["cohort-games"]);
    const outputPath = resolve(
        cwd,
        parsed.values.output ?? join("sim-out", "v0_7_acceptance", `${candidate}.acceptance.json`),
    );
    const options: IV07AcceptanceCliOptions = {
        candidate,
        opponents,
        headlineSeeds,
        gamesPerHeadlineSeed,
        cohortSeeds,
        gamesPerCohortSeed,
        concurrency: Number(parsed.values.concurrency),
        seedsDeclaredFresh: loadedManifest
            ? loadedManifest.manifest.freshSeedsDeclared
            : (parsed.values["fresh-seeds-confirmed"] ?? false),
        seedManifest: loadedManifest?.provenance ?? null,
        outputPath,
        checkpointDir: resolve(cwd, parsed.values["checkpoint-dir"] ?? `${outputPath}.cells`),
    };
    validateV07AcceptanceOptions(options);
    return options;
}

export function writeV07AcceptanceReport(report: IV07AcceptanceReport, outputPath: string): void {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
}

export function writeV07AcceptanceGates(report: IV07AcceptanceReport, outputPath: string): void {
    const gatePath = `${outputPath}.gates.json`;
    const artifact = {
        schemaVersion: 1,
        candidate: report.requested.candidate,
        revision: report.provenance.revision.commit,
        revisionAtCompletion: report.provenance.revisionAtCompletion.commit,
        revisionStable: report.provenance.revisionStable,
        runFingerprint: report.provenance.runFingerprint,
        evidenceVerdict: report.assessment.evidenceVerdict,
        protocolPowered: report.assessment.protocolPowered,
        protocolCompletenessReasons: report.assessment.protocolCompletenessReasons,
        gates: report.assessment.gates,
        bakeDecision: report.assessment.bakeDecision,
        ownerSignOff: report.assessment.ownerSignOff,
        journalReplayDecisionDivergence: report.assessment.journalReplayDecisionDivergence,
        releaseInstruction: report.assessment.releaseInstruction,
    };
    writeFileSync(gatePath, `${JSON.stringify(artifact, null, 2)}\n`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
    const cli = parseV07AcceptanceArgs(argv);
    const { outputPath, checkpointDir, ...options } = cli;
    const totalCells =
        options.opponents.length *
        (options.headlineSeeds.length +
            V07_ACCEPTANCE_COHORTS.reduce((total, cohort) => total + options.cohortSeeds[cohort].length, 0));
    console.log(
        `v0.7 acceptance evidence: ${options.candidate} vs ${options.opponents.join("/")}; ${totalCells} cells; ` +
            `${options.gamesPerHeadlineSeed} headline and ${options.gamesPerCohortSeed} cohort games/cell`,
    );
    const report = await runV07Acceptance(options, {
        loadCheckpoint: (spec, fingerprint) => loadAcceptanceCheckpoint(checkpointDir, spec, fingerprint),
        saveCheckpoint: (cell, fingerprint) => saveAcceptanceCheckpoint(checkpointDir, cell, fingerprint),
        onCellComplete: (cell, completed, total, resumed) => {
            console.log(
                `[${completed}/${total}]${resumed ? " [resumed]" : ""} ${cell.spec.kind}:${cell.spec.cohort} ` +
                    `${cell.spec.candidate} vs ` +
                    `${cell.spec.opponent} seed=${cell.spec.baseSeed} ` +
                    `${(cell.outcomes.candidateWinRate * 100).toFixed(2)}%`,
            );
        },
    });
    writeV07AcceptanceReport(report, outputPath);
    writeV07AcceptanceGates(report, outputPath);
    console.log(`evidence=${report.assessment.evidenceVerdict}; bake=${report.assessment.bakeDecision}`);
    console.log(`summary -> ${outputPath}`);
    console.log(`gates -> ${outputPath}.gates.json`);
}

if ((import.meta as unknown as { main?: boolean }).main) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}
