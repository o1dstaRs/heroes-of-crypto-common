/** Offline complete-match evaluation of a source-bound learned correction. No production registration. */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
    existsSync,
    linkSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isMainThread, workerData } from "node:worker_threads";
import type { RankedDraftStrengthPolicyId } from "../../ai/setup/draft_strength_prior";
import { runMatch, type IMatchConfig, type IMatchResult } from "../battle_engine";
import { hashSimulationParts } from "../army";
import { exitCompletedWorkerCli } from "../completed_worker_cli";
import { PersistentWorkerPool, startPersistentWorker } from "../persistent_worker_pool";
import {
    playRankedDraftGame,
    rankedDraftStrengthCandidate,
    sanitizedRankedDraftEnvironment,
    type IRankedDraftGameRecord,
} from "../ranked_draft_eval";
import { withV09A19Correction } from "./a19_correction";
import { V09A19CpuModel } from "./a19_inference";
import { withV09PilotDriverAudit } from "./a19_pilot";
import { readV09PilotSource, v09PilotBoardStatistics, type IV09A19PilotManifest } from "./a19_pilot_protocol";
import { fingerprintV09 } from "./protocol";
import { assertV09OutputIsolation } from "./supervisor";
import {
    buildV09A19StudentManifest,
    buildV09StudentReadiness,
    validateV09A19StudentManifest,
    v09StudentFileSha256,
    v09StudentSeeds,
    V09_A19_STUDENT_STAGES,
    type IV09A19StudentManifest,
    type V09A19StudentStage,
} from "./a19_student_protocol";

interface IStudentGame {
    record: IRankedDraftGameRecord;
    trajectorySha256: string;
    statistics: { decisions: number; inferred: number; corrected: number; inferenceMs: number[]; fullTurnMs: number[] };
}
interface IStudentBoard {
    manifestSha256: string;
    stage: V09A19StudentStage;
    board: number;
    seed: number;
    map: number;
    games: IStudentGame[];
    score: number;
    boardSha256: string;
}
interface IStudentTask {
    directory: string;
    manifest: IV09A19StudentManifest;
    stage: V09A19StudentStage;
    board: number;
}

function atomicJson(path: string, value: unknown, exclusive = false): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
    writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
    if (exclusive) {
        try {
            linkSync(temporary, path);
        } finally {
            unlinkSync(temporary);
        }
    } else renameSync(temporary, path);
}

function readManifest(directory: string): IV09A19StudentManifest {
    const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) as IV09A19StudentManifest;
    validateV09A19StudentManifest(manifest);
    return manifest;
}

function checkArtifacts(directory: string, repository: string, manifest: IV09A19StudentManifest): void {
    if (
        Bun.version !== manifest.runtime ||
        readV09PilotSource(repository).sha256 !== manifest.source.sha256 ||
        v09StudentFileSha256(readFileSync(join(directory, "model.json"), "utf8")) !== manifest.modelFileSha256 ||
        (manifest.acceptedFitReceiptSha256 &&
            v09StudentFileSha256(readFileSync(join(directory, "fit-receipt.json"), "utf8")) !==
                manifest.acceptedFitReceiptSha256)
    )
        throw new Error("Student source, model, receipt or runtime changed");
}

let cachedModel: { sha: string; model: V09A19CpuModel } | undefined;
function studentModel(directory: string, manifest: IV09A19StudentManifest): V09A19CpuModel {
    if (cachedModel?.sha !== manifest.modelFileSha256) {
        const bytes = readFileSync(join(directory, "model.json"), "utf8");
        if (v09StudentFileSha256(bytes) !== manifest.modelFileSha256) throw new Error("Student model bytes changed");
        cachedModel = {
            sha: manifest.modelFileSha256,
            model: new V09A19CpuModel(JSON.parse(bytes), {
                manifestSha256: manifest.parent.manifestSha256,
                sourceSha256: manifest.parent.source.sha256,
            }),
        };
    }
    return cachedModel.model;
}

const score = (record: IRankedDraftGameRecord) =>
    record.candidateResult === "win" ? 1 : record.candidateResult === "draw" ? 0.5 : 0;

export function runV09StudentBoard(task: IStudentTask): IStudentBoard {
    const { manifest, stage, board, directory } = task;
    validateV09A19StudentManifest(manifest);
    const seeds = v09StudentSeeds(manifest, stage);
    if (!Number.isSafeInteger(board) || board < 0 || board >= seeds.length)
        throw new Error("Student board outside the registered bank");
    const seed = seeds[board],
        map = [1, 3, 4][board % 3];
    const candidate = manifest.parent.baseline;
    const opponent =
        stage === "secondary_r4" ? { ...candidate, SEARCH_ROLLOUTS: "4", SEARCH_A19_COMPLEMENTARY_R2: "0" } : candidate;
    const genome = rankedDraftStrengthCandidate(manifest.parent.profile.draft as RankedDraftStrengthPolicyId);
    const model = studentModel(directory, manifest);
    const play = (caseIndex: number, enabled: boolean): IStudentGame => {
        const trajectory = createHash("sha256");
        let statistics: IStudentGame["statistics"] | undefined;
        const record = playRankedDraftGame(
            genome,
            genome,
            {
                gamesPerOpponent: 8,
                baseSeed: seed,
                mapTypes: [map],
                fightProfile: "a19",
                maxLaps: 256,
                liveDraftRules: true,
                sideBoard: true,
                deterministicSearch: true,
                liveSynergyVariants: true,
                tacticalSplits: true,
                candidateSearchEnvOverrides: candidate,
                candidateSetupPolicySpec: manifest.parent.profile.setup,
                opponentSetupPolicySpec: manifest.parent.profile.setup,
                candidateDoctrinePolicy: "see-none",
                opponentDoctrinePolicy: "see-none",
            },
            caseIndex,
            0,
            {
                matchRunner: (config: IMatchConfig): IMatchResult => {
                    const team = config.searchEnvOverrideTeams?.[0];
                    if (team === undefined) throw new Error("Student candidate lacks its physical seat");
                    const result = withV09PilotDriverAudit(team, opponent, candidate, () =>
                        withV09A19Correction(
                            {
                                team,
                                model: enabled && manifest.mode === "correction" ? model : null,
                                minimumLogitGain: manifest.minimumLogitGain,
                            },
                            () =>
                                runMatch({
                                    ...config,
                                    headlessEvents: true,
                                    researchA19BaseSearchEnvironment: opponent,
                                    turnExecutionObserver: (turn) =>
                                        trajectory.update(
                                            JSON.stringify([turn.side, turn.unitId, turn.chosenDecision]),
                                        ),
                                }),
                        ),
                    );
                    if (result.counts.baseline < 1 || result.counts.candidate < 1)
                        throw new Error("Student comparison did not exercise both profiles");
                    statistics = result.value.statistics;
                    return result.value.value;
                },
            },
        );
        if (!statistics || record.rejectedCandidate || record.rejectedOpponent || record.endReason !== "elimination")
            throw new Error("Student game did not complete with legal terminal actions");
        return { record, statistics, trajectorySha256: trajectory.digest("hex") };
    };
    const games = Array.from({ length: 4 }, (_, caseIndex) => {
        const control = manifest.diagnosticOnly ? play(caseIndex, false) : undefined;
        const game = play(caseIndex, true);
        if (
            control &&
            (game.trajectorySha256 !== control.trajectorySha256 ||
                fingerprintV09(game.record) !== fingerprintV09(control.record) ||
                game.statistics.corrected !== 0)
        )
            throw new Error("Abstaining student changed a complete canonical ranked match");
        return game;
    });
    for (const [a, b] of [
        [0, 1],
        [2, 3],
    ])
        if (
            games[a].record.setupFingerprint !== games[b].record.setupFingerprint ||
            games[a].record.battleSeed !== games[b].record.battleSeed ||
            games[a].record.candidateSide === games[b].record.candidateSide
        )
            throw new Error("Student battle-seat pair changed its scenario");
    const body = {
        manifestSha256: manifest.manifestSha256,
        stage,
        board,
        seed,
        map,
        games,
        score: games.reduce((sum, game) => sum + score(game.record), 0) / 4,
    };
    return { ...body, boardSha256: fingerprintV09(body) };
}

function validateBoard(row: IStudentBoard, task: IStudentTask): void {
    const { boardSha256, ...body } = row;
    if (
        fingerprintV09(body) !== boardSha256 ||
        row.manifestSha256 !== task.manifest.manifestSha256 ||
        row.stage !== task.stage ||
        row.board !== task.board ||
        row.seed !== v09StudentSeeds(task.manifest, task.stage)[task.board] ||
        row.map !== [1, 3, 4][task.board % 3] ||
        row.games.length !== 4 ||
        row.score !== row.games.reduce((sum, game) => sum + score(game.record), 0) / 4 ||
        row.games.some(
            (game, index) =>
                game.record.game !== index ||
                game.record.gridType !== row.map ||
                game.record.candidateResult !==
                    (game.record.winner === "draw"
                        ? "draw"
                        : game.record.winner === game.record.candidateSide
                          ? "win"
                          : "loss") ||
                game.record.rejectedCandidate ||
                game.record.rejectedOpponent ||
                game.record.endReason !== "elimination",
        )
    )
        throw new Error("Invalid student board receipt");
}

const boardPath = (directory: string, stage: string, board: number) =>
    join(directory, stage, `board-${board.toString().padStart(6, "0")}.json`);

function summaryOf(directory: string, manifest: IV09A19StudentManifest, stage: V09A19StudentStage) {
    const rows = v09StudentSeeds(manifest, stage).map((_, board) => {
        const row = JSON.parse(readFileSync(boardPath(directory, stage, board), "utf8")) as IStudentBoard;
        validateBoard(row, { directory, manifest, stage, board });
        return row;
    });
    const games = rows.flatMap((row) => row.games);
    const statistics = v09PilotBoardStatistics(
        rows.map((row) => row.score),
        hashSimulationParts("v09-student-ci", 2026102663, stage),
    );
    const times = (key: "inferenceMs" | "fullTurnMs") => {
        const values = games.flatMap((game) => game.statistics[key]).sort((a, b) => a - b);
        return {
            count: values.length,
            p50Ms: values.length ? values[Math.floor(values.length * 0.5)] : null,
            p99Ms: values.length ? values[Math.min(values.length - 1, Math.floor(values.length * 0.99))] : null,
            maxMs: values.at(-1) ?? null,
        };
    };
    return {
        schema: "hoc.ai.v0_9_a19_student_summary.v1",
        manifestSha256: manifest.manifestSha256,
        stage,
        complete: true,
        promoted: false,
        diagnosticOnly: manifest.diagnosticOnly || stage === "smoke",
        statistics,
        wins: games.filter((game) => game.record.candidateResult === "win").length,
        losses: games.filter((game) => game.record.candidateResult === "loss").length,
        draws: games.filter((game) => game.record.candidateResult === "draw").length,
        decisions: games.reduce((n, game) => n + game.statistics.decisions, 0),
        inferred: games.reduce((n, game) => n + game.statistics.inferred, 0),
        corrected: games.reduce((n, game) => n + game.statistics.corrected, 0),
        rejectedActions: 0,
        featureAndInference: times("inferenceMs"),
        operationBoundedFullTurn: times("fullTurnMs"),
        latencyScope: "Loaded-host offline operation-bounded diagnostics; these are not live-budget qualification",
        diagnosticControlGames: manifest.diagnosticOnly ? games.length : 0,
        primaryStrengthGatePassed:
            !manifest.diagnosticOnly &&
            stage === "confirmation_r2" &&
            statistics.score >= 0.55 &&
            statistics.lower95 !== null &&
            statistics.lower95 > 0.5,
        boardHashes: rows.map((row) => row.boardSha256),
    };
}

function verifySummary(directory: string, manifest: IV09A19StudentManifest, stage: V09A19StudentStage) {
    const saved = JSON.parse(readFileSync(join(directory, stage, "summary.json"), "utf8"));
    const { summarySha256, ...body } = saved;
    const expected = summaryOf(directory, manifest, stage);
    if (fingerprintV09(body) !== summarySha256 || fingerprintV09(expected) !== summarySha256)
        throw new Error("Student summary does not match its raw registered boards");
    return saved;
}

function finalistPath(directory: string): string {
    const paths = JSON.parse(readFileSync(join(directory, "local-paths.json"), "utf8"));
    return join(dirname(paths.registration), "student-finalist-lock.json");
}

function verifyReadiness(directory: string, manifest: IV09A19StudentManifest) {
    const saved = JSON.parse(readFileSync(join(directory, "readiness.json"), "utf8"));
    const expected = buildV09StudentReadiness(manifest, {
        cpuParity: readFileSync(join(directory, "evidence-cpu-parity.json"), "utf8"),
        disabledParity: readFileSync(join(directory, "evidence-disabled-parity.json"), "utf8"),
        liveLatency: readFileSync(join(directory, "evidence-live-latency.json"), "utf8"),
    });
    if (fingerprintV09(saved) !== fingerprintV09(expected))
        throw new Error("Student readiness changed after qualification");
    return expected;
}

function checkStageGate(directory: string, manifest: IV09A19StudentManifest, stage: V09A19StudentStage): void {
    v09StudentSeeds(manifest, stage);
    if (stage === "smoke") return;
    verifySummary(directory, manifest, "smoke");
    if (stage === "confirmation_r2" || stage === "secondary_r4") {
        const readiness = verifyReadiness(directory, manifest);
        const lock = JSON.parse(readFileSync(finalistPath(directory), "utf8"));
        const { lockSha256, ...body } = lock;
        if (
            fingerprintV09(body) !== lockSha256 ||
            lock.manifestSha256 !== manifest.manifestSha256 ||
            lock.modelFileSha256 !== manifest.modelFileSha256 ||
            lock.readinessSha256 !== readiness.readinessSha256 ||
            lock.registrationSha256 !== manifest.registration.registrationSha256
        )
            throw new Error("Untouched confirmation requires this exact locked finalist");
        if (stage === "secondary_r4") verifySummary(directory, manifest, "confirmation_r2");
    }
}

async function runStage(
    directory: string,
    repository: string,
    stage: V09A19StudentStage,
    workers: number,
    first: number,
    count?: number,
) {
    const manifest = readManifest(directory);
    checkArtifacts(directory, repository, manifest);
    checkStageGate(directory, manifest, stage);
    const seeds = v09StudentSeeds(manifest, stage),
        end = count === undefined ? seeds.length : first + count;
    if (
        !Number.isSafeInteger(workers) ||
        workers < 1 ||
        workers > (process.platform === "darwin" ? 12 : 24) ||
        !Number.isSafeInteger(first) ||
        !Number.isSafeInteger(end) ||
        first < 0 ||
        end <= first ||
        end > seeds.length
    )
        throw new Error("Invalid bounded student worker/shard allocation");
    if (existsSync(join(directory, stage, "summary.json"))) return verifySummary(directory, manifest, stage);
    const lease = join(directory, `student-lease-${stage}-${first}-${end}.json`);
    writeFileSync(lease, JSON.stringify({ pid: process.pid, manifestSha256: manifest.manifestSha256 }), { flag: "wx" });
    const pool = new PersistentWorkerPool<IStudentTask, IStudentBoard>({
        concurrency: workers,
        workerUrl: new URL(import.meta.url),
        workerOptions: {
            workerData: { v09A19Student: true },
            env: { ...sanitizedRankedDraftEnvironment(process.env, "a19"), LIVETWIN: "1" },
        },
    });
    try {
        const todo: IStudentTask[] = [];
        for (let board = first; board < end; board++) {
            const task = { directory, manifest, stage, board };
            if (existsSync(boardPath(directory, stage, board)))
                validateBoard(JSON.parse(readFileSync(boardPath(directory, stage, board), "utf8")), task);
            else todo.push(task);
        }
        for (let offset = 0; offset < todo.length; offset += workers) {
            checkArtifacts(directory, repository, manifest);
            const tasks = todo.slice(offset, offset + workers),
                rows = await pool.runBatch(tasks);
            for (const [index, row] of rows.entries()) {
                validateBoard(row, tasks[index]);
                atomicJson(boardPath(directory, stage, row.board), row, true);
            }
            process.stdout.write(
                JSON.stringify({
                    stage,
                    completedInShard: Math.min(offset + workers, todo.length),
                    queuedInShard: todo.length,
                }) + "\n",
            );
        }
        checkArtifacts(directory, repository, manifest);
        if (first !== 0 || end !== seeds.length)
            return { completeShard: true, first, end, manifestSha256: manifest.manifestSha256 };
        const body = summaryOf(directory, manifest, stage),
            summary = { ...body, summarySha256: fingerprintV09(body) };
        atomicJson(join(directory, stage, "summary.json"), summary, true);
        return summary;
    } finally {
        await pool.close();
        unlinkSync(lease);
    }
}

function verifyFitEvidence(
    actorCampaign: string,
    actorSource: string,
    modelPath: string,
    receiptPath: string,
    parent: IV09A19PilotManifest,
): void {
    for (const stage of ["corpus_train", "corpus_validation"])
        execFileSync(
            process.execPath,
            [
                join(actorSource, "src/simulation/v0_9/a19_pilot.ts"),
                "verify",
                "--out",
                actorCampaign,
                "--repository",
                actorSource,
                "--stage",
                stage,
            ],
            { stdio: "pipe", maxBuffer: 8 * 1024 * 1024 },
        );
    const folder = dirname(receiptPath);
    if (resolve(modelPath) !== join(folder, "research-model.json"))
        throw new Error("Use the model paired with its accepted fit receipt");
    const reports = readdirSync(folder)
        .filter((name) => name.startsWith("hardware-"))
        .flatMap((name) => {
            const path = join(folder, name, "preflight.log");
            if (!existsSync(path)) return [];
            return readFileSync(path, "utf8")
                .split("\n")
                .flatMap((line) => {
                    try {
                        return [JSON.parse(line)];
                    } catch {
                        return [];
                    }
                });
        });
    if (
        !reports.some(
            (report) =>
                report.ok === true &&
                report.gpu?.uuid === "GPU-5126d018-ec86-be8b-1bf5-b5ac323d3350" &&
                report.featureSchemaSha256 === parent.observationSha256 &&
                report.torchDevice?.computeCapability === "12.0",
        )
    )
        throw new Error("Accepted model lacks the matching approved 5090 hardware preflight");
}

async function main(): Promise<void> {
    const { positionals, values } = parseArgs({
        args: Bun.argv.slice(2),
        allowPositionals: true,
        strict: true,
        options: {
            out: { type: "string" },
            repository: { type: "string", default: process.cwd() },
            registration: { type: "string" },
            "actor-campaign": { type: "string" },
            "actor-source": { type: "string" },
            model: { type: "string" },
            "fit-receipt": { type: "string" },
            "cpu-parity": { type: "string" },
            "disabled-parity": { type: "string" },
            "live-latency": { type: "string" },
            diagnostic: { type: "boolean" },
            disabled: { type: "boolean" },
            "minimum-logit-gain": { type: "string" },
            stage: { type: "string", default: "smoke" },
            workers: { type: "string", default: "1" },
            "first-board": { type: "string", default: "0" },
            "board-count": { type: "string" },
            "protect-v08-root": { type: "string", multiple: true },
        },
    });
    if (!values.out) throw new Error("Required: --out <isolated student trial>");
    const directory = resolve(values.out),
        repository = resolve(values.repository);
    if (positionals[0] === "init") {
        if (!values.registration || !values["actor-campaign"] || !values.model || !values["protect-v08-root"]?.length)
            throw new Error("Required: --registration --actor-campaign --model --protect-v08-root");
        assertV09OutputIsolation(directory, values["protect-v08-root"]);
        if (existsSync(directory)) throw new Error("Student initialization requires a fresh output directory");
        const parent = JSON.parse(
            readFileSync(join(resolve(values["actor-campaign"]), "manifest.json"), "utf8"),
        ) as IV09A19PilotManifest;
        if (!values.diagnostic) {
            if (!values["actor-source"] || !values["fit-receipt"])
                throw new Error("Trained evaluation requires --actor-source and --fit-receipt");
            verifyFitEvidence(
                resolve(values["actor-campaign"]),
                resolve(values["actor-source"]),
                resolve(values.model),
                resolve(values["fit-receipt"]),
                parent,
            );
        }
        const bytes = readFileSync(resolve(values.model), "utf8"),
            receipt = values["fit-receipt"] ? readFileSync(resolve(values["fit-receipt"]), "utf8") : undefined;
        const manifest = buildV09A19StudentManifest({
            parent,
            registration: JSON.parse(readFileSync(resolve(values.registration), "utf8")),
            source: readV09PilotSource(repository),
            runtime: Bun.version,
            modelBytes: bytes,
            fitReceiptBytes: receipt,
            diagnosticOnly: values.diagnostic === true,
            mode: values.disabled ? "disabled" : "correction",
            minimumLogitGain: Number(values["minimum-logit-gain"] ?? (values.diagnostic ? 1_000_000 : 1)),
        });
        atomicJson(join(directory, "manifest.json"), manifest, true);
        writeFileSync(join(directory, "model.json"), bytes, { flag: "wx" });
        if (receipt) writeFileSync(join(directory, "fit-receipt.json"), receipt, { flag: "wx" });
        atomicJson(join(directory, "local-paths.json"), { registration: resolve(values.registration) }, true);
        process.stdout.write(
            JSON.stringify({
                directory,
                manifestSha256: manifest.manifestSha256,
                diagnosticOnly: manifest.diagnosticOnly,
            }) + "\n",
        );
        return;
    }
    if (!Object.hasOwn(V09_A19_STUDENT_STAGES, values.stage)) throw new Error("Unknown registered student stage");
    const stage = values.stage as V09A19StudentStage,
        manifest = readManifest(directory);
    checkArtifacts(directory, repository, manifest);
    if (positionals[0] === "qualify") {
        if (!values["cpu-parity"] || !values["disabled-parity"] || !values["live-latency"])
            throw new Error("Required: --cpu-parity --disabled-parity --live-latency");
        const evidence = {
            cpuParity: readFileSync(resolve(values["cpu-parity"]), "utf8"),
            disabledParity: readFileSync(resolve(values["disabled-parity"]), "utf8"),
            liveLatency: readFileSync(resolve(values["live-latency"]), "utf8"),
        };
        const readiness = buildV09StudentReadiness(manifest, evidence);
        for (const [key, name] of [
            ["cpuParity", "evidence-cpu-parity.json"],
            ["disabledParity", "evidence-disabled-parity.json"],
            ["liveLatency", "evidence-live-latency.json"],
        ] as const)
            writeFileSync(join(directory, name), evidence[key], { flag: "wx" });
        atomicJson(join(directory, "readiness.json"), readiness, true);
        process.stdout.write(JSON.stringify(readiness) + "\n");
    } else if (positionals[0] === "lock") {
        if (manifest.diagnosticOnly || manifest.mode === "disabled")
            throw new Error("Diagnostic/disabled models cannot become a finalist");
        verifySummary(directory, manifest, "smoke");
        const development = verifySummary(directory, manifest, "development");
        if (development.statistics.score <= 0.5) throw new Error("Student development showed no positive score signal");
        const readiness = verifyReadiness(directory, manifest);
        const body = {
            manifestSha256: manifest.manifestSha256,
            registrationSha256: manifest.registration.registrationSha256,
            modelFileSha256: manifest.modelFileSha256,
            developmentSummarySha256: development.summarySha256,
            readinessSha256: readiness.readinessSha256,
            lockedAtUtc: new Date().toISOString(),
            promoted: false,
        };
        atomicJson(finalistPath(directory), { ...body, lockSha256: fingerprintV09(body) }, true);
        process.stdout.write(JSON.stringify(body) + "\n");
    } else if (positionals[0] === "verify") {
        checkStageGate(directory, manifest, stage);
        process.stdout.write(JSON.stringify(verifySummary(directory, manifest, stage)) + "\n");
    } else if (positionals[0] === "finalize") {
        checkStageGate(directory, manifest, stage);
        const body = summaryOf(directory, manifest, stage),
            summary = { ...body, summarySha256: fingerprintV09(body) };
        atomicJson(join(directory, stage, "summary.json"), summary, true);
        process.stdout.write(JSON.stringify(summary) + "\n");
    } else if (positionals[0] === "run") {
        const result = await runStage(
            directory,
            repository,
            stage,
            Number(values.workers),
            Number(values["first-board"]),
            values["board-count"] === undefined ? undefined : Number(values["board-count"]),
        );
        process.stdout.write(JSON.stringify(result) + "\n");
    } else throw new Error("Usage: a19_student_eval.ts init|run|verify|qualify|lock|finalize --out <trial>");
}

if (!isMainThread && workerData?.v09A19Student === true) startPersistentWorker(runV09StudentBoard);
else if (import.meta.main) {
    await main();
    await exitCompletedWorkerCli();
}
