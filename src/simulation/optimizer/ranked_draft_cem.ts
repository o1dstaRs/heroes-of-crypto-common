/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 * Deadline-bounded, research-only CEM over the exact 15-dimensional ranked draft surface.
 * Population candidates run serially; each evaluator owns at most --workers worker threads.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    existsSync,
    linkSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { type ILeagueGenome } from "../league_genome";
import {
    defaultRankedDraftPool,
    evaluateRankedDraftCandidate,
    evaluateRankedDraftTasks,
    inspectRankedDraftBoard,
    loadRankedDraftPool,
    normalizeRankedDraftGenome,
    rankedDraftCurrentIncumbent,
    rankedDraftBehaviorTraceSetSha256,
    RANKED_DRAFT_COHORT_DEFINITIONS,
    RANKED_DRAFT_LIVE_MAP_TYPES,
    summarizeRankedDraftRecords,
    type IRankedDraftEvaluationReport,
    type IRankedDraftEvaluationTask,
    type IRankedDraftGameRecord,
    type IRankedDraftPoolEntry,
    type RankedDraftCohort,
} from "../ranked_draft_eval";
import {
    assertDisjointRankedDraftSeedRanges,
    createRankedDraftCandidateGenome,
    createRankedDraftCemDistribution,
    evaluateRankedDraftGuard,
    evaluateRankedDraftTargetedGuard,
    fingerprintRankedDraftArtifact,
    rankedDraftPanelSeedRange,
    refitRankedDraftCemDistribution,
    sampleRankedDraftCemPopulation,
    type IRankedDraftCemDistribution,
    type IRankedDraftCemScore,
    type IRankedDraftSeedRange,
    type IRankedDraftTargetedCohortInput,
} from "./ranked_draft_cem_core";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "../../..");
const UINT32_SPACE = 0x1_0000_0000;
const DEFAULT_TRAIN_BASE_SEED = 0x01000000;
const DEFAULT_VALIDATION_BASE_SEED = 0x60000000;
const DEFAULT_GUARD_BASE_SEED = 0xc0000000;
const DEFAULT_COHORT_GUARD_BASE_SEED = 0xd0000000;
const DEFAULT_REPLAY_BASE_SEED = 0xf0000000;

interface IOptions {
    outputDirectory: string;
    workers: number;
    deadlineAtMs: number;
    runId: string;
    poolSource: string;
    population: number;
    elite: number;
    trainGamesPerOpponent: number;
    validationGamesPerOpponent: number;
    guardGamesPerOpponent: number;
    maxGenerations: number;
    maxLaps: number;
    mapTypes: number[];
    cemSeed: number;
    trainBaseSeed: number;
    validationBaseSeed: number;
    guardBaseSeed: number;
    cohortGuardBaseSeed: number;
    replayBaseSeed: number;
    cohortBoardsPerOpponent: number;
    cohortScanMaxBoards: number;
    replayGamesPerOpponent: number;
    relativeSigma: number;
    zeroSigma: number;
    sigmaDecay: number;
    sigmaFloorRatio: number;
    guardReserveMs: number;
}

interface IEvaluationEnvelope {
    schemaVersion: 1;
    status: "research_only_no_bake";
    runFingerprint: string;
    purpose: "training" | "validation" | "final_guard_candidate" | "final_guard_incumbent";
    generation: number | null;
    candidateFingerprint: string;
    panel: IRankedDraftSeedRange & { gamesPerOpponent: number; mapTypes: number[] };
    report: IRankedDraftEvaluationReport;
    artifactSha256: string;
}

interface IBestCandidate {
    generation: number;
    candidateId: string;
    intrinsic: number[];
    validationFitness: number;
    validationReportPath: string;
    candidateFingerprint: string;
}

interface IState {
    schemaVersion: 1;
    status: "optimizing" | "final_guard" | "complete";
    runFingerprint: string;
    completedGeneration: number;
    distribution: IRankedDraftCemDistribution;
    best: IBestCandidate;
    observedWorkerCeiling: number;
    finalizedAt?: string;
    updatedAt: string;
}

interface ICohortScanCell {
    cohort: RankedDraftCohort;
    opponentIndex: number;
    opponentId: string;
    seedLaneIndex: number;
    scannedOfferBoards: number;
    acceptedOfferBoards: number[];
    exhausted: boolean;
}

interface ICohortScanManifest {
    schemaVersion: 1;
    status: "research_only_no_bake";
    runFingerprint: string;
    candidateFingerprint: string;
    selectionRule: "candidate_pick_roster_only_no_fight_outcomes";
    cohortDefinitions: Record<RankedDraftCohort, string>;
    panel: IRankedDraftSeedRange & {
        scanMaxBoardsPerCell: number;
        requiredBoardsPerOpponent: number;
        mapTypes: number[];
    };
    cells: ICohortScanCell[];
    tasks: IRankedDraftEvaluationTask[];
    manifestSha256: string;
}

interface ICohortEvidenceEnvelope {
    schemaVersion: 1;
    status: "research_only_no_bake";
    runFingerprint: string;
    candidateFingerprint: string;
    cohort: RankedDraftCohort;
    cohortDefinition: string;
    scanManifestSha256: string;
    records: IRankedDraftGameRecord[];
    recordsSha256: string;
}

interface IReplayEvidence {
    schemaVersion: 1;
    status: "research_only_no_bake";
    runFingerprint: string;
    candidateFingerprint: string;
    panel: IRankedDraftSeedRange & { gamesPerOpponent: number; mapTypes: number[] };
    first: { recordsSha256: string; reportSha256: string; behaviorTraceSetSha256: string };
    second: { recordsSha256: string; reportSha256: string; behaviorTraceSetSha256: string };
    byteIdentical: boolean;
    behaviorTraceIdentical: boolean;
    qualification: string;
}

interface IReplayRunArtifact {
    schemaVersion: 1;
    status: "research_only_no_bake";
    runFingerprint: string;
    candidateFingerprint: string;
    label: "first" | "second";
    panel: IRankedDraftSeedRange & { gamesPerOpponent: number; mapTypes: number[] };
    records: IRankedDraftGameRecord[];
    report: IRankedDraftEvaluationReport;
    recordsSha256: string;
    reportSha256: string;
    behaviorTraceSetSha256: string;
}

function integer(value: string | undefined, fallback: number, label: string, minimum: number): number {
    const parsed = Number(value ?? fallback);
    if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new RangeError(`${label} must be >= ${minimum}`);
    return parsed;
}

function positive(value: string | undefined, fallback: number, label: string): number {
    const parsed = Number(value ?? fallback);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new RangeError(`${label} must be positive`);
    return parsed;
}

function uint32(value: string | undefined, fallback: number, label: string): number {
    const parsed = integer(value, fallback, label, 0);
    if (parsed >= UINT32_SPACE) throw new RangeError(`${label} must be a uint32`);
    return parsed;
}

function parseOptions(argv: readonly string[]): IOptions {
    const parsed = parseArgs({
        args: [...argv],
        strict: true,
        allowPositionals: false,
        options: {
            out: { type: "string" },
            workers: { type: "string" },
            "deadline-ms": { type: "string" },
            "run-id": { type: "string" },
            pool: { type: "string", default: "default" },
            population: { type: "string", default: "10" },
            elite: { type: "string", default: "3" },
            "train-games": { type: "string", default: "600" },
            "validation-games": { type: "string", default: "1600" },
            "guard-games": { type: "string", default: "8000" },
            "max-generations": { type: "string", default: "1000" },
            "max-laps": { type: "string", default: "60" },
            maps: { type: "string", default: RANKED_DRAFT_LIVE_MAP_TYPES.join(",") },
            "cem-seed": { type: "string" },
            "train-seed": { type: "string" },
            "validation-seed": { type: "string" },
            "guard-seed": { type: "string" },
            "cohort-guard-seed": { type: "string" },
            "replay-seed": { type: "string" },
            "cohort-boards-per-opponent": { type: "string", default: "625" },
            "cohort-scan-max-boards": { type: "string", default: "1000000" },
            "replay-games": { type: "string", default: "8" },
            "relative-sigma": { type: "string", default: "0.25" },
            "zero-sigma": { type: "string", default: "2.5" },
            "sigma-decay": { type: "string", default: "0.9" },
            "sigma-floor-ratio": { type: "string", default: "0.2" },
            "guard-reserve-ms": { type: "string", default: String(30 * 60 * 1000) },
        },
    });
    if (!parsed.values.out || !parsed.values.workers || !parsed.values["deadline-ms"] || !parsed.values["run-id"]) {
        throw new Error("--out, --workers, --deadline-ms, and --run-id are required");
    }
    const runId = parsed.values["run-id"].trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
        throw new Error("--run-id must be 1..128 filesystem-safe characters");
    }
    const population = integer(parsed.values.population, 10, "--population", 2);
    const elite = integer(parsed.values.elite, 3, "--elite", 1);
    if (elite > population) throw new RangeError("--elite cannot exceed --population");
    const games = {
        train: integer(parsed.values["train-games"], 600, "--train-games", 8),
        validation: integer(parsed.values["validation-games"], 1600, "--validation-games", 8),
        guard: integer(parsed.values["guard-games"], 8000, "--guard-games", 8),
    };
    for (const [label, value] of Object.entries(games)) {
        if (value % 4) throw new RangeError(`${label} games must be a multiple of four`);
    }
    const mapTypes = parsed.values.maps.split(",").map(Number);
    const liveMaps = new Set<number>(RANKED_DRAFT_LIVE_MAP_TYPES);
    if (
        !mapTypes.length ||
        !mapTypes.every((map) => Number.isInteger(map) && liveMaps.has(map)) ||
        new Set(mapTypes).size !== mapTypes.length
    ) {
        throw new RangeError("--maps must contain unique live GridVals ids from [1, 3, 4]; WATER (2) is excluded");
    }
    const deadlineAtMs = integer(parsed.values["deadline-ms"], 0, "--deadline-ms", 1);
    const guardReserveMs = integer(parsed.values["guard-reserve-ms"], 30 * 60 * 1000, "--guard-reserve-ms", 1);
    const resolved: IOptions = {
        outputDirectory: resolve(parsed.values.out),
        workers: integer(parsed.values.workers, 1, "--workers", 1),
        deadlineAtMs,
        runId,
        poolSource: parsed.values.pool,
        population,
        elite,
        trainGamesPerOpponent: games.train,
        validationGamesPerOpponent: games.validation,
        guardGamesPerOpponent: games.guard,
        maxGenerations: integer(parsed.values["max-generations"], 1000, "--max-generations", 1),
        maxLaps: integer(parsed.values["max-laps"], 60, "--max-laps", 1),
        mapTypes,
        cemSeed: uint32(
            parsed.values["cem-seed"],
            Number.parseInt(fingerprintRankedDraftArtifact(runId).slice(0, 8), 16),
            "--cem-seed",
        ),
        trainBaseSeed: uint32(parsed.values["train-seed"], DEFAULT_TRAIN_BASE_SEED, "--train-seed"),
        validationBaseSeed: uint32(parsed.values["validation-seed"], DEFAULT_VALIDATION_BASE_SEED, "--validation-seed"),
        guardBaseSeed: uint32(parsed.values["guard-seed"], DEFAULT_GUARD_BASE_SEED, "--guard-seed"),
        cohortGuardBaseSeed: uint32(
            parsed.values["cohort-guard-seed"],
            DEFAULT_COHORT_GUARD_BASE_SEED,
            "--cohort-guard-seed",
        ),
        replayBaseSeed: uint32(parsed.values["replay-seed"], DEFAULT_REPLAY_BASE_SEED, "--replay-seed"),
        cohortBoardsPerOpponent: integer(
            parsed.values["cohort-boards-per-opponent"],
            625,
            "--cohort-boards-per-opponent",
            1,
        ),
        cohortScanMaxBoards: integer(parsed.values["cohort-scan-max-boards"], 1_000_000, "--cohort-scan-max-boards", 1),
        replayGamesPerOpponent: integer(parsed.values["replay-games"], 8, "--replay-games", 8),
        relativeSigma: positive(parsed.values["relative-sigma"], 0.25, "--relative-sigma"),
        zeroSigma: positive(parsed.values["zero-sigma"], 2.5, "--zero-sigma"),
        sigmaDecay: positive(parsed.values["sigma-decay"], 0.9, "--sigma-decay"),
        sigmaFloorRatio: positive(parsed.values["sigma-floor-ratio"], 0.2, "--sigma-floor-ratio"),
        guardReserveMs,
    };
    if (resolved.replayGamesPerOpponent % 4) throw new RangeError("--replay-games must be a multiple of four");
    if (resolved.cohortBoardsPerOpponent > resolved.cohortScanMaxBoards) {
        throw new RangeError("--cohort-boards-per-opponent cannot exceed --cohort-scan-max-boards");
    }
    return resolved;
}

function atomicJson(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp.${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temporary, path);
}

function immutableJson(path: string, value: unknown): void {
    const content = `${JSON.stringify(value, null, 2)}\n`;
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp.${process.pid}`;
    try {
        try {
            unlinkSync(temporary);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        writeFileSync(temporary, content, { flag: "wx" });
        try {
            // A hard link publishes only the fully written inode and fails rather than replacing prior evidence.
            linkSync(temporary, path);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            if (readFileSync(path, "utf8") !== content) throw new Error(`Immutable artifact conflicts at ${path}`);
        }
    } finally {
        try {
            unlinkSync(temporary);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
    }
    try {
        if (readFileSync(path, "utf8") !== content) throw new Error(`Immutable artifact conflicts at ${path}`);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new Error(`Immutable artifact was not published at ${path}`);
        }
        throw error;
    }
}

function json<T>(path: string): T {
    return JSON.parse(readFileSync(path, "utf8")) as T;
}

function gitText(args: string[]): string {
    try {
        return execFileSync("git", args, { cwd: PACKAGE_ROOT, encoding: "utf8" }).trim();
    } catch {
        return "unknown";
    }
}

function sourceFingerprint(): string {
    const sources: string[] = [];
    const visit = (directory: string): void => {
        for (const name of readdirSync(directory).sort()) {
            const path = join(directory, name);
            const metadata = statSync(path);
            if (metadata.isDirectory()) visit(path);
            else if (/\.(?:json|mjs|proto|ts|tsx)$/.test(name)) sources.push(path);
        }
    };
    visit(join(PACKAGE_ROOT, "src"));
    const hash = createHash("sha256");
    for (const source of sources) {
        hash.update(relative(PACKAGE_ROOT, source));
        hash.update("\0");
        hash.update(readFileSync(source));
        hash.update("\0");
    }
    return hash.digest("hex");
}

function candidateFingerprint(candidate: ILeagueGenome): string {
    return fingerprintRankedDraftArtifact({ schemaVersion: candidate.schemaVersion, weights: candidate.weights });
}

function normalizePool(pool: readonly IRankedDraftPoolEntry[]): IRankedDraftPoolEntry[] {
    return pool.map((opponent) => ({ ...normalizeRankedDraftGenome(opponent), prior: opponent.prior ?? 1 }));
}

function evaluationEnvelopeFingerprint(envelope: Omit<IEvaluationEnvelope, "artifactSha256">): string {
    return fingerprintRankedDraftArtifact(envelope);
}

function validateEnvelope(
    envelope: IEvaluationEnvelope,
    expected: Omit<IEvaluationEnvelope, "report" | "artifactSha256">,
): IEvaluationEnvelope {
    const { artifactSha256, ...unsigned } = envelope;
    if (
        envelope.schemaVersion !== 1 ||
        envelope.status !== "research_only_no_bake" ||
        envelope.runFingerprint !== expected.runFingerprint ||
        envelope.purpose !== expected.purpose ||
        envelope.generation !== expected.generation ||
        envelope.candidateFingerprint !== expected.candidateFingerprint ||
        fingerprintRankedDraftArtifact(envelope.panel) !== fingerprintRankedDraftArtifact(expected.panel) ||
        artifactSha256 !== evaluationEnvelopeFingerprint(unsigned) ||
        envelope.report.status !== "research_only_no_bake" ||
        envelope.report.options.baseSeed !== expected.panel.baseSeed ||
        envelope.report.options.gamesPerOpponent !== expected.panel.gamesPerOpponent ||
        envelope.report.aggregate.rejectedCandidate < 0
    ) {
        throw new Error(`Evaluation checkpoint failed identity validation for ${expected.purpose}`);
    }
    return envelope;
}

async function evaluateCheckpoint(
    path: string,
    runFingerprint: string,
    purpose: IEvaluationEnvelope["purpose"],
    generation: number | null,
    candidate: ILeagueGenome,
    pool: readonly IRankedDraftPoolEntry[],
    panel: IRankedDraftSeedRange & { gamesPerOpponent: number; mapTypes: number[] },
    options: IOptions,
    heartbeat: (phase: string, detail?: Record<string, unknown>) => void,
): Promise<IEvaluationEnvelope> {
    const expected = {
        schemaVersion: 1 as const,
        status: "research_only_no_bake" as const,
        runFingerprint,
        purpose,
        generation,
        candidateFingerprint: candidateFingerprint(candidate),
        panel,
    };
    if (existsSync(path)) return validateEnvelope(json<IEvaluationEnvelope>(path), expected);
    heartbeat(purpose, { generation, candidateId: candidate.id, checkpoint: relative(options.outputDirectory, path) });
    const report = await evaluateRankedDraftCandidate(candidate, pool, {
        gamesPerOpponent: panel.gamesPerOpponent,
        baseSeed: panel.baseSeed,
        concurrency: options.workers,
        mapTypes: panel.mapTypes,
        maxLaps: options.maxLaps,
    });
    const unsigned: Omit<IEvaluationEnvelope, "artifactSha256"> = { ...expected, report };
    const envelope: IEvaluationEnvelope = {
        ...unsigned,
        artifactSha256: evaluationEnvelopeFingerprint(unsigned),
    };
    immutableJson(path, envelope);
    return envelope;
}

function panelWithOptions(
    range: IRankedDraftSeedRange,
    gamesPerOpponent: number,
    mapTypes: readonly number[],
): IRankedDraftSeedRange & { gamesPerOpponent: number; mapTypes: number[] } {
    return { ...range, gamesPerOpponent, mapTypes: [...mapTypes] };
}

function relativePath(outputDirectory: string, path: string): string {
    return relative(outputDirectory, path) || ".";
}

function bytesSha256(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function cohortTasks(cells: readonly ICohortScanCell[], cohort: RankedDraftCohort): IRankedDraftEvaluationTask[] {
    return cells
        .filter((cell) => cell.cohort === cohort)
        .flatMap((cell) =>
            cell.acceptedOfferBoards.flatMap((offerBoard) =>
                [0, 1, 2, 3].map((offset) => ({
                    opponentIndex: cell.opponentIndex,
                    seedLaneIndex: cell.seedLaneIndex,
                    game: offerBoard * 4 + offset,
                })),
            ),
        );
}

function loadOrBuildCohortScan(
    path: string,
    runFingerprint: string,
    candidate: ILeagueGenome,
    pool: readonly IRankedDraftPoolEntry[],
    range: IRankedDraftSeedRange,
    options: IOptions,
    heartbeat: (phase: string, detail?: Record<string, unknown>) => void,
): ICohortScanManifest {
    const candidateHash = candidateFingerprint(candidate);
    if (existsSync(path)) {
        const manifest = json<ICohortScanManifest>(path);
        const { manifestSha256, ...unsigned } = manifest;
        if (
            manifest.runFingerprint !== runFingerprint ||
            manifest.candidateFingerprint !== candidateHash ||
            manifestSha256 !== fingerprintRankedDraftArtifact(unsigned)
        ) {
            throw new Error("Targeted cohort scan manifest failed resume validation");
        }
        return manifest;
    }
    const cohortNames: RankedDraftCohort[] = ["ranged", "mage", "melee_magic", "aura_heavy"];
    const scanOptions = {
        gamesPerOpponent: options.cohortScanMaxBoards * 4,
        baseSeed: range.baseSeed,
        mapTypes: options.mapTypes,
        maxLaps: options.maxLaps,
    };
    const cells: ICohortScanCell[] = [];
    for (let cohortIndex = 0; cohortIndex < cohortNames.length; cohortIndex += 1) {
        const cohort = cohortNames[cohortIndex];
        for (let opponentIndex = 0; opponentIndex < pool.length; opponentIndex += 1) {
            const seedLaneIndex = cohortIndex * pool.length + opponentIndex;
            const acceptedOfferBoards: number[] = [];
            let scannedOfferBoards = 0;
            for (
                let offerBoard = 0;
                offerBoard < options.cohortScanMaxBoards &&
                acceptedOfferBoards.length < options.cohortBoardsPerOpponent;
                offerBoard += 1
            ) {
                const inspection = inspectRankedDraftBoard(
                    candidate,
                    pool[opponentIndex],
                    scanOptions,
                    offerBoard,
                    seedLaneIndex,
                );
                scannedOfferBoards = offerBoard + 1;
                if (inspection.assignments.some((assignment) => assignment.candidateCohorts.includes(cohort))) {
                    acceptedOfferBoards.push(offerBoard);
                }
                if (scannedOfferBoards % 50_000 === 0) {
                    heartbeat("targeted_cohort_seed_scan", {
                        cohort,
                        opponentId: pool[opponentIndex].id,
                        scannedOfferBoards,
                        acceptedOfferBoards: acceptedOfferBoards.length,
                    });
                }
            }
            cells.push({
                cohort,
                opponentIndex,
                opponentId: pool[opponentIndex].id,
                seedLaneIndex,
                scannedOfferBoards,
                acceptedOfferBoards,
                exhausted: acceptedOfferBoards.length < options.cohortBoardsPerOpponent,
            });
        }
    }
    const tasks = cohortNames.flatMap((cohort) => cohortTasks(cells, cohort));
    const unsigned = {
        schemaVersion: 1 as const,
        status: "research_only_no_bake" as const,
        runFingerprint,
        candidateFingerprint: candidateHash,
        selectionRule: "candidate_pick_roster_only_no_fight_outcomes" as const,
        cohortDefinitions: { ...RANKED_DRAFT_COHORT_DEFINITIONS },
        panel: {
            ...range,
            scanMaxBoardsPerCell: options.cohortScanMaxBoards,
            requiredBoardsPerOpponent: options.cohortBoardsPerOpponent,
            mapTypes: [...options.mapTypes],
        },
        cells,
        tasks,
    };
    const manifest: ICohortScanManifest = {
        ...unsigned,
        manifestSha256: fingerprintRankedDraftArtifact(unsigned),
    };
    immutableJson(path, manifest);
    return manifest;
}

async function loadOrRunCohortEvidence(
    path: string,
    runFingerprint: string,
    candidate: ILeagueGenome,
    pool: readonly IRankedDraftPoolEntry[],
    cohort: RankedDraftCohort,
    scan: ICohortScanManifest,
    options: IOptions,
    heartbeat: (phase: string, detail?: Record<string, unknown>) => void,
): Promise<ICohortEvidenceEnvelope> {
    const candidateHash = candidateFingerprint(candidate);
    if (existsSync(path)) {
        const envelope = json<ICohortEvidenceEnvelope>(path);
        if (
            envelope.runFingerprint !== runFingerprint ||
            envelope.candidateFingerprint !== candidateHash ||
            envelope.cohort !== cohort ||
            envelope.cohortDefinition !== RANKED_DRAFT_COHORT_DEFINITIONS[cohort] ||
            envelope.scanManifestSha256 !== scan.manifestSha256 ||
            envelope.recordsSha256 !== bytesSha256(envelope.records)
        ) {
            throw new Error(`${cohort} targeted evidence failed resume validation`);
        }
        return envelope;
    }
    const tasks = cohortTasks(scan.cells, cohort);
    heartbeat("targeted_cohort_fights", { cohort, games: tasks.length });
    const records = await evaluateRankedDraftTasks(
        candidate,
        pool,
        {
            gamesPerOpponent: options.cohortScanMaxBoards * 4,
            baseSeed: scan.panel.baseSeed,
            concurrency: options.workers,
            mapTypes: options.mapTypes,
            maxLaps: options.maxLaps,
        },
        tasks,
    );
    const envelope: ICohortEvidenceEnvelope = {
        schemaVersion: 1,
        status: "research_only_no_bake",
        runFingerprint,
        candidateFingerprint: candidateHash,
        cohort,
        cohortDefinition: RANKED_DRAFT_COHORT_DEFINITIONS[cohort],
        scanManifestSha256: scan.manifestSha256,
        records,
        recordsSha256: bytesSha256(records),
    };
    immutableJson(path, envelope);
    return envelope;
}

async function loadOrRunReplay(
    directory: string,
    runFingerprint: string,
    candidate: ILeagueGenome,
    pool: readonly IRankedDraftPoolEntry[],
    range: IRankedDraftSeedRange,
    options: IOptions,
    heartbeat: (phase: string, detail?: Record<string, unknown>) => void,
): Promise<IReplayEvidence> {
    const summaryPath = join(directory, "summary.json");
    if (existsSync(summaryPath)) {
        const evidence = json<IReplayEvidence>(summaryPath);
        const first = json<IReplayRunArtifact>(join(directory, "first.json"));
        const second = json<IReplayRunArtifact>(join(directory, "second.json"));
        if (
            evidence.runFingerprint !== runFingerprint ||
            evidence.candidateFingerprint !== candidateFingerprint(candidate) ||
            first.runFingerprint !== runFingerprint ||
            second.runFingerprint !== runFingerprint ||
            first.candidateFingerprint !== evidence.candidateFingerprint ||
            second.candidateFingerprint !== evidence.candidateFingerprint ||
            first.label !== "first" ||
            second.label !== "second" ||
            first.recordsSha256 !== bytesSha256(first.records) ||
            second.recordsSha256 !== bytesSha256(second.records) ||
            first.reportSha256 !== bytesSha256(first.report) ||
            second.reportSha256 !== bytesSha256(second.report) ||
            first.behaviorTraceSetSha256 !== rankedDraftBehaviorTraceSetSha256(first.records) ||
            second.behaviorTraceSetSha256 !== rankedDraftBehaviorTraceSetSha256(second.records) ||
            evidence.first.recordsSha256 !== first.recordsSha256 ||
            evidence.second.recordsSha256 !== second.recordsSha256 ||
            evidence.first.reportSha256 !== first.reportSha256 ||
            evidence.second.reportSha256 !== second.reportSha256 ||
            evidence.first.behaviorTraceSetSha256 !== first.behaviorTraceSetSha256 ||
            evidence.second.behaviorTraceSetSha256 !== second.behaviorTraceSetSha256 ||
            evidence.behaviorTraceIdentical !== (first.behaviorTraceSetSha256 === second.behaviorTraceSetSha256) ||
            evidence.byteIdentical !==
                (JSON.stringify(first.records) === JSON.stringify(second.records) &&
                    JSON.stringify(first.report) === JSON.stringify(second.report))
        ) {
            throw new Error("Deterministic replay evidence failed resume validation");
        }
        return evidence;
    }
    const replayPool = pool.slice(0, Math.min(2, pool.length));
    const panel = panelWithOptions(range, options.replayGamesPerOpponent, options.mapTypes);
    const tasks = Array.from({ length: options.replayGamesPerOpponent * replayPool.length }, (_, index) => ({
        opponentIndex: Math.floor(index / options.replayGamesPerOpponent),
        game: index % options.replayGamesPerOpponent,
    }));
    const runs: { records: IRankedDraftGameRecord[]; report: IRankedDraftEvaluationReport }[] = [];
    for (const label of ["first", "second"] as const) {
        heartbeat("deterministic_replay", { label, games: tasks.length });
        const records = await evaluateRankedDraftTasks(
            candidate,
            replayPool,
            {
                gamesPerOpponent: options.replayGamesPerOpponent,
                baseSeed: range.baseSeed,
                concurrency: options.workers,
                mapTypes: options.mapTypes,
                maxLaps: options.maxLaps,
            },
            tasks,
        );
        const report = summarizeRankedDraftRecords(
            candidate,
            replayPool,
            {
                gamesPerOpponent: options.replayGamesPerOpponent,
                baseSeed: range.baseSeed,
                concurrency: options.workers,
                mapTypes: options.mapTypes,
                maxLaps: options.maxLaps,
            },
            records,
        );
        const artifact: IReplayRunArtifact = {
            schemaVersion: 1,
            status: "research_only_no_bake",
            runFingerprint,
            candidateFingerprint: candidateFingerprint(candidate),
            label,
            panel,
            records,
            report,
            recordsSha256: bytesSha256(records),
            reportSha256: bytesSha256(report),
            behaviorTraceSetSha256: rankedDraftBehaviorTraceSetSha256(records),
        };
        immutableJson(join(directory, `${label}.json`), artifact);
        runs.push({ records, report });
    }
    const evidence: IReplayEvidence = {
        schemaVersion: 1,
        status: "research_only_no_bake",
        runFingerprint,
        candidateFingerprint: candidateFingerprint(candidate),
        panel,
        first: {
            recordsSha256: bytesSha256(runs[0].records),
            reportSha256: bytesSha256(runs[0].report),
            behaviorTraceSetSha256: rankedDraftBehaviorTraceSetSha256(runs[0].records),
        },
        second: {
            recordsSha256: bytesSha256(runs[1].records),
            reportSha256: bytesSha256(runs[1].report),
            behaviorTraceSetSha256: rankedDraftBehaviorTraceSetSha256(runs[1].records),
        },
        byteIdentical:
            JSON.stringify(runs[0].records) === JSON.stringify(runs[1].records) &&
            JSON.stringify(runs[0].report) === JSON.stringify(runs[1].report),
        behaviorTraceIdentical:
            rankedDraftBehaviorTraceSetSha256(runs[0].records) === rankedDraftBehaviorTraceSetSha256(runs[1].records),
        qualification: "Exact repeated replay on one dedicated guard subrange; no acceptance data are reused.",
    };
    immutableJson(summaryPath, evidence);
    return evidence;
}

let stopRequested = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
        stopRequested = true;
        process.stderr.write(`${signal}: finish current evaluation, then enter the reserved final guard\n`);
    });
}

async function main(): Promise<void> {
    const options = parseOptions(process.argv.slice(2));
    mkdirSync(options.outputDirectory, { recursive: true });
    const heartbeatPath = join(options.outputDirectory, "heartbeat.json");
    const heartbeat = (phase: string, detail: Record<string, unknown> = {}): void =>
        atomicJson(heartbeatPath, {
            schemaVersion: 1,
            status: "research_only_no_bake",
            pid: process.pid,
            runId: options.runId,
            phase,
            at: new Date().toISOString(),
            deadlineAtMs: options.deadlineAtMs,
            ...detail,
        });

    const incumbent = rankedDraftCurrentIncumbent();
    const pool = normalizePool(
        options.poolSource === "default" ? defaultRankedDraftPool() : loadRankedDraftPool(options.poolSource),
    );
    const trainReserve = rankedDraftPanelSeedRange(
        "all-rotating-training-generations",
        options.trainBaseSeed,
        options.trainGamesPerOpponent * options.maxGenerations,
        pool.length,
    );
    const validationRange = rankedDraftPanelSeedRange(
        "fixed-selection-panel",
        options.validationBaseSeed,
        options.validationGamesPerOpponent,
        pool.length,
    );
    const guardRange = rankedDraftPanelSeedRange(
        "untouched-final-guard",
        options.guardBaseSeed,
        options.guardGamesPerOpponent,
        pool.length,
    );
    const cohortGuardRange = rankedDraftPanelSeedRange(
        "untouched-targeted-cohort-scan-and-guard",
        options.cohortGuardBaseSeed,
        options.cohortScanMaxBoards * 4,
        pool.length * 4,
    );
    const replayRange = rankedDraftPanelSeedRange(
        "untouched-deterministic-replay",
        options.replayBaseSeed,
        options.replayGamesPerOpponent,
        Math.min(2, pool.length),
    );
    assertDisjointRankedDraftSeedRanges([trainReserve, validationRange, guardRange, cohortGuardRange, replayRange]);
    if (options.sigmaDecay > 1) throw new RangeError("--sigma-decay must not exceed one");
    if (options.deadlineAtMs <= Date.now()) throw new RangeError("--deadline-ms is already in the past");

    const code = {
        revision: gitText(["rev-parse", "HEAD"]),
        branch: gitText(["branch", "--show-current"]),
        originMain: gitText(["rev-parse", "origin/main"]),
        sourceFingerprint: sourceFingerprint(),
    };
    const protocol = {
        schemaVersion: 1,
        status: "research_only_no_bake" as const,
        runId: options.runId,
        deadlineAtMs: options.deadlineAtMs,
        code,
        execution: {
            candidateEvaluation: "serial" as const,
            populationParallelism: 1,
            evaluatorWorkers: options.workers,
            promisedWorkerCeiling: options.workers,
        },
        draftSurface: { offset: 0, length: 15, tail: "projected-to-current-anchor" as const },
        setup: {
            perk: "setup-v0 SEE_NONE",
            tier2: "conditional-setup-v1 at live phase sequence 8",
            augments: "conditional-setup-v1 all",
            synergies: "fixed setup-v0 table",
            placementCombat: "current v0.7",
            persistedPickOrder: true,
        },
        pool,
        options: {
            population: options.population,
            elite: options.elite,
            trainGamesPerOpponent: options.trainGamesPerOpponent,
            validationGamesPerOpponent: options.validationGamesPerOpponent,
            guardGamesPerOpponent: options.guardGamesPerOpponent,
            maxGenerations: options.maxGenerations,
            maxLaps: options.maxLaps,
            mapTypes: options.mapTypes,
            cemSeed: options.cemSeed,
            relativeSigma: options.relativeSigma,
            zeroSigma: options.zeroSigma,
            sigmaDecay: options.sigmaDecay,
            sigmaFloorRatio: options.sigmaFloorRatio,
            guardReserveMs: options.guardReserveMs,
            cohortBoardsPerOpponent: options.cohortBoardsPerOpponent,
            cohortScanMaxBoards: options.cohortScanMaxBoards,
            replayGamesPerOpponent: options.replayGamesPerOpponent,
        },
        seedRanges: { trainReserve, validationRange, guardRange, cohortGuardRange, replayRange },
        qualification: "Autonomous research and final eligibility guard only; no policy is baked or promoted.",
    };
    const runFingerprint = fingerprintRankedDraftArtifact(protocol);
    const runArtifact = { ...protocol, runFingerprint };
    const runPath = join(options.outputDirectory, "run.json");
    if (existsSync(runPath)) {
        const existing = json<typeof runArtifact>(runPath);
        if (
            existing.runFingerprint !== runFingerprint ||
            fingerprintRankedDraftArtifact(existing) !== fingerprintRankedDraftArtifact(runArtifact)
        ) {
            throw new Error("Existing ranked draft run has a different immutable protocol");
        }
    } else {
        immutableJson(runPath, runArtifact);
        immutableJson(join(options.outputDirectory, "pool.json"), {
            schemaVersion: 1,
            status: "research_only_no_bake",
            runFingerprint,
            entries: pool,
        });
    }

    const statePath = join(options.outputDirectory, "state.json");
    const initialDistribution = createRankedDraftCemDistribution(
        incumbent,
        options.relativeSigma,
        options.zeroSigma,
        options.sigmaFloorRatio,
    );
    const incumbentIntrinsic = incumbent.weights.slice(0, 15);
    let state: IState;
    if (existsSync(statePath)) {
        state = json<IState>(statePath);
        if (state.schemaVersion !== 1 || state.runFingerprint !== runFingerprint) {
            throw new Error("Ranked draft state does not belong to this run");
        }
    } else {
        const selectionPanel = panelWithOptions(validationRange, options.validationGamesPerOpponent, options.mapTypes);
        const incumbentValidationPath = join(options.outputDirectory, "validation", "incumbent.json");
        const incumbentValidation = await evaluateCheckpoint(
            incumbentValidationPath,
            runFingerprint,
            "validation",
            -1,
            incumbent,
            pool,
            selectionPanel,
            options,
            heartbeat,
        );
        state = {
            schemaVersion: 1,
            status: "optimizing",
            runFingerprint,
            completedGeneration: -1,
            distribution: initialDistribution,
            best: {
                generation: -1,
                candidateId: incumbent.id,
                intrinsic: incumbentIntrinsic,
                validationFitness: incumbentValidation.report.aggregate.fitness,
                validationReportPath: relativePath(options.outputDirectory, incumbentValidationPath),
                candidateFingerprint: candidateFingerprint(incumbent),
            },
            observedWorkerCeiling: Math.min(options.workers, options.validationGamesPerOpponent * pool.length),
            updatedAt: new Date().toISOString(),
        };
        atomicJson(statePath, state);
        atomicJson(join(options.outputDirectory, "best.json"), {
            schemaVersion: 1,
            status: "research_only_no_bake",
            runFingerprint,
            ...state.best,
            qualification: "Accepted round-1 incumbent seeded as the fixed-selection baseline; final guards untouched.",
        });
    }

    if (state.status === "complete") {
        process.stdout.write(readFileSync(join(options.outputDirectory, "outcome.json"), "utf8"));
        return;
    }

    const trainingStopAtMs = options.deadlineAtMs - options.guardReserveMs;
    if (state.status === "optimizing") {
        for (let generation = state.completedGeneration + 1; generation < options.maxGenerations; generation += 1) {
            if (stopRequested || Date.now() >= trainingStopAtMs) break;
            const generationDirectory = join(
                options.outputDirectory,
                "generations",
                String(generation).padStart(4, "0"),
            );
            const generationBaseSeed =
                options.trainBaseSeed +
                generation *
                    rankedDraftPanelSeedRange(
                        "one-training-generation",
                        options.trainBaseSeed,
                        options.trainGamesPerOpponent,
                        pool.length,
                    ).seedChannels;
            const trainingRange = rankedDraftPanelSeedRange(
                `training-generation-${generation}`,
                generationBaseSeed,
                options.trainGamesPerOpponent,
                pool.length,
            );
            const trainingPanel = panelWithOptions(trainingRange, options.trainGamesPerOpponent, options.mapTypes);
            const population = sampleRankedDraftCemPopulation(
                state.distribution.mean,
                state.distribution.sigma,
                options.population,
                options.cemSeed,
                generation,
            );
            const scores: IRankedDraftCemScore[] = [];
            let generationComplete = true;
            for (let index = 0; index < population.length; index += 1) {
                if (stopRequested || Date.now() >= trainingStopAtMs) {
                    generationComplete = false;
                    break;
                }
                const intrinsic = population[index];
                const intrinsicFingerprint = fingerprintRankedDraftArtifact(intrinsic);
                const candidate = createRankedDraftCandidateGenome(
                    `draft-g${String(generation).padStart(4, "0")}-c${String(index).padStart(3, "0")}-${intrinsicFingerprint.slice(0, 10)}`,
                    intrinsic,
                );
                const checkpoint = join(
                    generationDirectory,
                    "train",
                    `candidate-${String(index).padStart(3, "0")}.json`,
                );
                const envelope = await evaluateCheckpoint(
                    checkpoint,
                    runFingerprint,
                    "training",
                    generation,
                    candidate,
                    pool,
                    trainingPanel,
                    options,
                    heartbeat,
                );
                scores.push({
                    intrinsic: [...intrinsic],
                    candidateId: candidate.id,
                    fitness: envelope.report.aggregate.fitness,
                });
            }
            if (!generationComplete) break;
            scores.sort(
                (left, right) => right.fitness - left.fitness || left.candidateId.localeCompare(right.candidateId),
            );
            const elite = scores.slice(0, options.elite);
            const winner = createRankedDraftCandidateGenome(scores[0].candidateId, scores[0].intrinsic);
            const selectionPanel = panelWithOptions(
                validationRange,
                options.validationGamesPerOpponent,
                options.mapTypes,
            );
            const validationPath = join(generationDirectory, "validation.json");
            const validation = await evaluateCheckpoint(
                validationPath,
                runFingerprint,
                "validation",
                generation,
                winner,
                pool,
                selectionPanel,
                options,
                heartbeat,
            );
            const nextDistribution = refitRankedDraftCemDistribution(elite, state.distribution, options.sigmaDecay);
            const generationSummary = {
                schemaVersion: 1,
                status: "research_only_no_bake",
                runFingerprint,
                generation,
                trainingPanel,
                training: scores.map((score) => ({ candidateId: score.candidateId, fitness: score.fitness })),
                elite: elite.map((score) => ({ candidateId: score.candidateId, fitness: score.fitness })),
                validation: {
                    candidateId: winner.id,
                    fitness: validation.report.aggregate.fitness,
                    worstCaseOpponent: validation.report.aggregate.worstCaseOpponent,
                    rejectedCandidate: validation.report.aggregate.rejectedCandidate,
                    checkpoint: relativePath(options.outputDirectory, validationPath),
                },
                distributionBefore: state.distribution,
                distributionAfter: nextDistribution,
                qualification: "Training and fixed-panel selection evidence only; not the untouched final guard.",
            };
            immutableJson(join(generationDirectory, "summary.json"), generationSummary);
            if (validation.report.aggregate.fitness > state.best.validationFitness) {
                state.best = {
                    generation,
                    candidateId: winner.id,
                    intrinsic: [...scores[0].intrinsic],
                    validationFitness: validation.report.aggregate.fitness,
                    validationReportPath: relativePath(options.outputDirectory, validationPath),
                    candidateFingerprint: candidateFingerprint(winner),
                };
                atomicJson(join(options.outputDirectory, "best.json"), {
                    schemaVersion: 1,
                    status: "research_only_no_bake",
                    runFingerprint,
                    ...state.best,
                    qualification: "Best fixed-selection-panel candidate only; final guard remains untouched.",
                });
            }
            state.distribution = nextDistribution;
            state.completedGeneration = generation;
            state.observedWorkerCeiling = Math.max(
                state.observedWorkerCeiling,
                Math.min(options.workers, options.trainGamesPerOpponent * pool.length),
            );
            state.updatedAt = new Date().toISOString();
            atomicJson(statePath, state);
            heartbeat("generation_complete", {
                generation,
                bestCandidateId: state.best.candidateId,
                bestValidationFitness: state.best.validationFitness,
            });
        }
        state.status = "final_guard";
        state.updatedAt = new Date().toISOString();
        atomicJson(statePath, state);
    }

    if (Date.now() >= options.deadlineAtMs) {
        throw new Error("Deadline reached before the reserved final guard could start");
    }
    heartbeat("final_guard_start", {
        bestCandidateId: state.best.candidateId,
        completedGeneration: state.completedGeneration,
    });
    const bestCandidate = createRankedDraftCandidateGenome(state.best.candidateId, state.best.intrinsic);
    if (candidateFingerprint(bestCandidate) !== state.best.candidateFingerprint) {
        throw new Error("Serialized 15-dimensional best candidate failed reconstruction validation");
    }
    const guardPanel = panelWithOptions(guardRange, options.guardGamesPerOpponent, options.mapTypes);
    const guardCandidatePath = join(options.outputDirectory, "guard", "candidate.json");
    const guardIncumbentPath = join(options.outputDirectory, "guard", "incumbent.json");
    const guardCandidate = await evaluateCheckpoint(
        guardCandidatePath,
        runFingerprint,
        "final_guard_candidate",
        state.best.generation,
        bestCandidate,
        pool,
        guardPanel,
        options,
        heartbeat,
    );
    const guardIncumbent = await evaluateCheckpoint(
        guardIncumbentPath,
        runFingerprint,
        "final_guard_incumbent",
        -1,
        incumbent,
        pool,
        guardPanel,
        options,
        heartbeat,
    );
    const naturalDecision = evaluateRankedDraftGuard(guardCandidate.report, guardIncumbent.report);
    const replay = await loadOrRunReplay(
        join(options.outputDirectory, "guard", "replay"),
        runFingerprint,
        bestCandidate,
        pool,
        replayRange,
        options,
        heartbeat,
    );
    const scanPath = join(options.outputDirectory, "guard", "cohorts", "scan.json");
    const cohortScan = loadOrBuildCohortScan(
        scanPath,
        runFingerprint,
        bestCandidate,
        pool,
        cohortGuardRange,
        options,
        heartbeat,
    );
    const cohortNames: RankedDraftCohort[] = ["ranged", "mage", "melee_magic", "aura_heavy"];
    const targetedInputs: IRankedDraftTargetedCohortInput[] = [];
    for (const cohort of cohortNames) {
        const evidence = await loadOrRunCohortEvidence(
            join(options.outputDirectory, "guard", "cohorts", `${cohort}.json`),
            runFingerprint,
            bestCandidate,
            pool,
            cohort,
            cohortScan,
            options,
            heartbeat,
        );
        const cells = cohortScan.cells.filter((cell) => cell.cohort === cohort);
        targetedInputs.push({
            cohort,
            requiredOfferBoards: options.cohortBoardsPerOpponent * pool.length,
            scannedOfferBoards: cells.reduce((sum, cell) => sum + cell.scannedOfferBoards, 0),
            exhausted: cells.some((cell) => cell.exhausted),
            records: evidence.records,
        });
    }
    const targetedDecision = evaluateRankedDraftTargetedGuard(targetedInputs);
    const eligibleForManualReview =
        naturalDecision.eligibleForManualReview &&
        targetedDecision.eligibleForManualReview &&
        replay.byteIdentical &&
        replay.behaviorTraceIdentical;
    if (!state.finalizedAt) {
        state.finalizedAt = new Date().toISOString();
        state.updatedAt = state.finalizedAt;
        atomicJson(statePath, state);
    }
    const verdict = {
        schemaVersion: 1,
        status: "research_only_no_bake",
        runFingerprint,
        runId: options.runId,
        completedGeneration: state.completedGeneration,
        eligibleForManualReview,
        checks: {
            naturalGuardPassed: naturalDecision.eligibleForManualReview,
            targetedCohortGuardPassed: targetedDecision.eligibleForManualReview,
            deterministicReplayByteIdentical: replay.byteIdentical,
            deterministicReplayBehaviorTraceIdentical: replay.behaviorTraceIdentical,
        },
        naturalGuard: naturalDecision,
        targetedCohortGuard: targetedDecision,
        deterministicReplay: {
            ...replay,
            summaryPath: relativePath(
                options.outputDirectory,
                join(options.outputDirectory, "guard", "replay", "summary.json"),
            ),
        },
        candidate: {
            ...state.best,
            serializedHeads: ["draftIntrinsic"] as const,
            draftDimensions: { offset: 0, length: state.best.intrinsic.length },
            guardReportPath: relativePath(options.outputDirectory, guardCandidatePath),
        },
        incumbent: {
            candidateId: incumbent.id,
            candidateFingerprint: candidateFingerprint(incumbent),
            guardReportPath: relativePath(options.outputDirectory, guardIncumbentPath),
        },
        naturalCohortDiagnostics: guardCandidate.report.cohorts,
        cohortScan: {
            path: relativePath(options.outputDirectory, scanPath),
            manifestSha256: cohortScan.manifestSha256,
            selectionRule: cohortScan.selectionRule,
            cohortDefinitions: cohortScan.cohortDefinitions,
        },
        finishedAt: state.finalizedAt,
        qualification:
            "Fresh natural, targeted-cohort, and deterministic-replay eligibility only. Passing permits manual review; this autonomous job cannot bake or promote a policy.",
    };
    immutableJson(join(options.outputDirectory, "guard", "verdict.json"), verdict);
    const outcome = {
        schemaVersion: 1,
        status: "research_only_no_bake",
        runFingerprint,
        runId: options.runId,
        completedGenerations: state.completedGeneration + 1,
        observedWorkerCeiling: state.observedWorkerCeiling,
        promisedWorkerCeiling: options.workers,
        populationParallelism: 1,
        finalGuardUntouchedDuringOptimization: true,
        eligibleForManualReview,
        verdictPath: "guard/verdict.json",
        qualification: verdict.qualification,
    };
    immutableJson(join(options.outputDirectory, "outcome.json"), outcome);
    state.status = "complete";
    state.updatedAt = new Date().toISOString();
    atomicJson(statePath, state);
    heartbeat("complete", { eligibleForManualReview });
    process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
}

if (import.meta.main) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 2;
    });
}
