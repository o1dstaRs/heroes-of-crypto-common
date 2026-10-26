/** Explicit offline CLI; importing this module never installs a policy or changes SearchDriver. */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isMainThread, workerData } from "node:worker_threads";

import type { IDecisionContext } from "../../ai/ai_strategy";
import type { RankedDraftStrengthPolicyId } from "../../ai/setup/draft_strength_prior";
import type { GameAction } from "../../engine/actions";
import type { Unit } from "../../units/unit";
import { readA19AuditProfile } from "../a19_decision_audit";
import { hashSimulationParts } from "../army";
import { runMatch, type IMatchConfig, type IMatchResult } from "../battle_engine";
import { exitCompletedWorkerCli } from "../completed_worker_cli";
import { PersistentWorkerPool, startPersistentWorker } from "../persistent_worker_pool";
import { playRankedDraftGame, rankedDraftStrengthCandidate, type IRankedDraftGameRecord } from "../ranked_draft_eval";
import { SearchDriver } from "../search_driver";
import { fingerprintV09 } from "./protocol";
import { withV09A19Recording, type IV09A19TrainingDecision } from "./a19_pilot_recording";
import { V09_A19_OBSERVATION_CONTRACT, V09_A19_OBSERVATION_SHA256 } from "./a19_observation";
import { assertV09OutputIsolation } from "./supervisor";
import {
    buildV09A19PilotManifest,
    readV09PilotSource,
    validateV09A19PilotManifest,
    v09PilotBoardStatistics,
    V09_A19_PILOT_STAGES,
    type IV09A19PilotManifest,
    type V09A19PilotStage,
    type V09A19TeacherPreset,
} from "./a19_pilot_protocol";

interface IPilotDriver {
    horizon: number;
    rollouts: number;
    shortlist: number | null;
    complementaryR2: boolean;
    certifiedSelectionBounds: boolean;
    certifiedTightBounds: boolean;
    a19MaterialArbitration: string | undefined;
    match: { offlineDeterministicWork?: boolean };
    chooseDecision(unit: Unit, version: string, incumbent: GameAction[], context?: IDecisionContext): GameAction[];
}

export interface IV09PilotDriverCounts {
    baseline: number;
    candidate: number;
}

/** Observe real instantiated budgets, not merely the requested env. Scope and exceptions restore the prototype. */
export function withV09PilotDriverAudit<T>(
    candidateTeam: number,
    baseline: Readonly<Record<string, string | undefined>>,
    candidate: Readonly<Record<string, string | undefined>>,
    run: () => T,
): { value: T; counts: IV09PilotDriverCounts } {
    const prototype = SearchDriver.prototype as unknown as IPilotDriver;
    const original = prototype.chooseDecision;
    const counts = { baseline: 0, candidate: 0 };
    prototype.chooseDecision = function (...args) {
        const treatment = args[0].getTeam() === candidateTeam;
        const expected = treatment ? candidate : baseline;
        if (
            !this.match.offlineDeterministicWork ||
            this.horizon !== Number(expected.SEARCH_HORIZON) ||
            this.rollouts !== Number(expected.SEARCH_ROLLOUTS) ||
            this.shortlist !== Number(expected.SEARCH_SHORTLIST) ||
            this.complementaryR2 !== (expected.SEARCH_A19_COMPLEMENTARY_R2 === "1") ||
            this.certifiedSelectionBounds !== (expected.SEARCH_A19_CERTIFIED_SELECTION_BOUNDS === "1") ||
            this.certifiedTightBounds !== (expected.SEARCH_A19_CERTIFIED_TIGHT_BOUNDS === "1") ||
            this.a19MaterialArbitration !== expected.SEARCH_A19_MATERIAL_ARBITRATION
        )
            throw new Error("Actual pilot search differs from the frozen A19 seat profile");
        counts[treatment ? "candidate" : "baseline"]++;
        return original.apply(this, args);
    };
    try {
        return { value: run(), counts };
    } finally {
        prototype.chooseDecision = original;
    }
}

interface IPilotGame {
    record: IRankedDraftGameRecord;
    trajectorySha256: string;
    driverCounts: IV09PilotDriverCounts;
    training?: { decisions: IV09A19TrainingDecision[]; sampledWithoutCompleteEvidence: number };
}

export interface IV09PilotBoard {
    schema: "hoc.ai.v0_9_a19_pilot_board.v1";
    manifestSha256: string;
    stage: V09A19PilotStage;
    board: number;
    scenarioSeed: number;
    map: number;
    games: IPilotGame[];
    score: number;
    elapsedMs: number;
    boardSha256: string;
}

interface IPilotTask {
    manifest: IV09A19PilotManifest;
    stage: V09A19PilotStage;
    board: number;
}

const score = (record: IRankedDraftGameRecord) =>
    record.candidateResult === "win" ? 1 : record.candidateResult === "draw" ? 0.5 : 0;

export function runV09PilotBoard(task: IPilotTask): IV09PilotBoard {
    validateV09A19PilotManifest(task.manifest);
    const { manifest, stage, board } = task;
    if (!Number.isSafeInteger(board) || board < 0 || board >= manifest.stages[stage].length)
        throw new Error("Board outside the reserved pilot schedule");
    const scenarioSeed = manifest.stages[stage][board];
    const map = [1, 3, 4][board % 3];
    const candidate = stage === "aa" ? manifest.baseline : manifest.teacher;
    const recording = stage === "smoke" || stage.startsWith("corpus_");
    const genome = rankedDraftStrengthCandidate(manifest.profile.draft as RankedDraftStrengthPolicyId);
    const games: IPilotGame[] = [];
    const started = performance.now();
    for (let caseIndex = 0; caseIndex < 4; caseIndex++) {
        const trajectory = createHash("sha256");
        let driverCounts: IV09PilotDriverCounts | undefined;
        let training: IPilotGame["training"];
        const record = playRankedDraftGame(
            genome,
            genome,
            {
                gamesPerOpponent: 8,
                baseSeed: scenarioSeed,
                mapTypes: [map],
                fightProfile: "a19",
                maxLaps: 256,
                liveDraftRules: true,
                sideBoard: true,
                deterministicSearch: true,
                liveSynergyVariants: true,
                tacticalSplits: true,
                candidateSearchEnvOverrides: candidate,
                candidateSetupPolicySpec: manifest.profile.setup,
                opponentSetupPolicySpec: manifest.profile.setup,
                candidateDoctrinePolicy: "see-none",
                opponentDoctrinePolicy: "see-none",
            },
            caseIndex,
            0,
            {
                matchRunner: (config: IMatchConfig): IMatchResult => {
                    const candidateTeam = config.searchEnvOverrideTeams?.[0];
                    if (candidateTeam === undefined) throw new Error("Pilot candidate has no physical seat");
                    const execute = () =>
                        runMatch({
                            ...config,
                            headlessEvents: true,
                            researchA19BaseSearchEnvironment: manifest.baseline,
                            turnExecutionObserver: (turn) => {
                                trajectory.update(JSON.stringify([turn.side, turn.unitId, turn.chosenDecision]));
                            },
                        });
                    const checked = withV09PilotDriverAudit(candidateTeam, manifest.baseline, candidate, () => {
                        if (!recording) return execute();
                        const collected = withV09A19Recording(candidateTeam, config.seed, execute);
                        training = {
                            decisions: collected.decisions,
                            sampledWithoutCompleteEvidence: collected.sampledWithoutCompleteEvidence,
                        };
                        return collected.value;
                    });
                    driverCounts = checked.counts;
                    return checked.value;
                },
            },
        );
        if (record.rejectedCandidate || record.rejectedOpponent || record.endReason !== "elimination")
            throw new Error(`Pilot requires completed legal games: ${JSON.stringify(record)}`);
        if (!driverCounts || driverCounts.baseline === 0 || driverCounts.candidate === 0)
            throw new Error("Pilot did not exercise both search profiles");
        if (training) for (const decision of training.decisions) decision.outcome = score(record);
        games.push({
            record,
            driverCounts,
            trajectorySha256: trajectory.digest("hex"),
            ...(training ? { training } : {}),
        });
    }
    // Each pick seat is played in both battle seats with exactly the same scenario and setup.
    for (const [left, right] of [
        [0, 1],
        [2, 3],
    ]) {
        if (
            games[left].record.setupFingerprint !== games[right].record.setupFingerprint ||
            games[left].record.battleSeed !== games[right].record.battleSeed ||
            games[left].record.candidateSide === games[right].record.candidateSide
        )
            throw new Error("Pilot draft/battle seat pair changed its scenario");
    }
    const value = {
        schema: "hoc.ai.v0_9_a19_pilot_board.v1" as const,
        manifestSha256: manifest.manifestSha256,
        stage,
        board,
        scenarioSeed,
        map,
        games,
        score: games.reduce((sum, game) => sum + score(game.record), 0) / 4,
        elapsedMs: performance.now() - started,
    };
    if (stage === "aa" && value.score !== 0.5) throw new Error("A/A board did not reproduce the paired null");
    return { ...value, boardSha256: fingerprintV09(value) };
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

export function validateV09PilotBoard(row: IV09PilotBoard, task: IPilotTask): void {
    const { boardSha256, ...unsigned } = row;
    if (
        row.schema !== "hoc.ai.v0_9_a19_pilot_board.v1" ||
        fingerprintV09(unsigned) !== boardSha256 ||
        row.manifestSha256 !== task.manifest.manifestSha256 ||
        row.stage !== task.stage ||
        row.board !== task.board ||
        row.scenarioSeed !== task.manifest.stages[task.stage][task.board] ||
        row.map !== [1, 3, 4][task.board % 3] ||
        row.games.length !== 4 ||
        row.score !== row.games.reduce((sum, game) => sum + score(game.record), 0) / 4 ||
        row.games.some(
            (game, index) =>
                game.record.rejectedCandidate ||
                game.record.rejectedOpponent ||
                game.record.endReason !== "elimination" ||
                game.record.game !== index ||
                game.record.gridType !== row.map ||
                game.record.candidateResult !==
                    (game.record.winner === "draw"
                        ? "draw"
                        : game.record.winner === game.record.candidateSide
                          ? "win"
                          : "loss") ||
                game.driverCounts.baseline < 1 ||
                game.driverCounts.candidate < 1,
        )
    )
        throw new Error("Pilot board receipt is invalid or belongs to another scenario");
}

function completedStage(directory: string, manifest: IV09A19PilotManifest, stage: V09A19PilotStage) {
    const folder = join(directory, stage);
    const summary = JSON.parse(readFileSync(join(folder, "summary.json"), "utf8"));
    const { summarySha256, ...unsigned } = summary;
    if (
        summary.manifestSha256 !== manifest.manifestSha256 ||
        summary.stage !== stage ||
        summary.complete !== true ||
        fingerprintV09(unsigned) !== summarySha256
    )
        throw new Error("Pilot stage summary has no valid completion receipt");
    const rows = manifest.stages[stage].map((_, board) => {
        const row = JSON.parse(
            readFileSync(join(folder, `board-${board.toString().padStart(6, "0")}.json`), "utf8"),
        ) as IV09PilotBoard;
        validateV09PilotBoard(row, { manifest, stage, board });
        return row;
    });
    const statistics = v09PilotBoardStatistics(
        rows.map((row) => row.score),
        hashSimulationParts("v09-pilot-ci", manifest.seed, stage),
    );
    if (
        fingerprintV09(statistics) !== fingerprintV09(summary.statistics) ||
        fingerprintV09(rows.map((row) => row.boardSha256)) !== fingerprintV09(summary.boardHashes)
    )
        throw new Error("Pilot stage summary does not match its raw independent boards");
    return summary;
}

export async function runV09A19PilotStage(
    directory: string,
    repository: string,
    stage: V09A19PilotStage,
    workers: number,
    firstBoard = 0,
    boardCount?: number,
) {
    const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) as IV09A19PilotManifest;
    validateV09A19PilotManifest(manifest);
    if (Bun.version !== manifest.runtime || readV09PilotSource(repository).sha256 !== manifest.source.sha256)
        throw new Error("Pilot source/runtime changed; use the frozen source");
    if (!Number.isSafeInteger(workers) || workers < 1 || workers > (process.platform === "darwin" ? 12 : 24))
        throw new Error("Pilot worker budget exceeds this host's supported limit");
    const endBoard = firstBoard + (boardCount ?? manifest.stages[stage].length - firstBoard);
    if (
        !Number.isSafeInteger(firstBoard) ||
        !Number.isSafeInteger(endBoard) ||
        firstBoard < 0 ||
        endBoard <= firstBoard ||
        endBoard > manifest.stages[stage].length
    )
        throw new Error("Pilot shard is outside the reserved board schedule");
    if (stage.startsWith("corpus_") && (process.platform !== "linux" || process.arch !== "x64"))
        throw new Error(
            "This pilot admits only Linux x64 corpus actors; architecture parity is required before expanding it",
        );
    const resultPath = join(directory, stage);
    mkdirSync(resultPath, { recursive: true });
    if (existsSync(join(resultPath, "summary.json"))) return completedStage(directory, manifest, stage);
    if (stage === "teacher_screen" || stage === "teacher_confirmation") {
        const aa = completedStage(directory, manifest, "aa");
        if (aa.statistics.score !== 0.5 || aa.rejectedActions !== 0) throw new Error("A/A parity stage has not passed");
    }
    if (["teacher_confirmation", "corpus_train", "corpus_validation"].includes(stage)) {
        const screen = completedStage(directory, manifest, "teacher_screen");
        if (screen.teacherPassedScreen !== true || screen.statistics.lower95 <= 0.5 || screen.statistics.score < 0.52)
            throw new Error("Teacher has not passed its registered independent-board screen");
    }
    if (stage.startsWith("corpus_")) {
        const confirmation = completedStage(directory, manifest, "teacher_confirmation");
        if (confirmation.statistics.lower95 <= 0.5)
            throw new Error("Teacher has not passed fresh strength confirmation");
    }
    const rows: IV09PilotBoard[] = [];
    const todo: IPilotTask[] = [];
    for (let board = firstBoard; board < endBoard; board++) {
        const task = { manifest, stage, board };
        const path = join(resultPath, `board-${board.toString().padStart(6, "0")}.json`);
        if (existsSync(path)) {
            const row = JSON.parse(readFileSync(path, "utf8")) as IV09PilotBoard;
            validateV09PilotBoard(row, task);
            rows.push(row);
        } else todo.push(task);
    }
    const lease = join(directory, `pilot-lease-${firstBoard}-${endBoard}.json`);
    // An abandoned lease needs inspection; there is no automatic takeover or accepted-output replacement.
    writeFileSync(lease, JSON.stringify({ pid: process.pid, stage, startedAt: new Date().toISOString() }), {
        flag: "wx",
    });
    const pool = new PersistentWorkerPool<IPilotTask, IV09PilotBoard>({
        concurrency: workers,
        workerUrl: new URL(import.meta.url),
        workerOptions: { workerData: { v09A19Pilot: true } },
    });
    const started = performance.now();
    try {
        for (let first = 0; first < todo.length; first += workers) {
            if (readV09PilotSource(repository).sha256 !== manifest.source.sha256)
                throw new Error("Pilot source changed during collection");
            const tasks = todo.slice(first, first + workers);
            const batch = await pool.runBatch(tasks);
            batch.forEach((row, index) => {
                validateV09PilotBoard(row, tasks[index]);
                const target = join(resultPath, `board-${row.board.toString().padStart(6, "0")}.json`);
                if (existsSync(target)) throw new Error("Refusing to overwrite an accepted pilot board");
                atomicJson(target, row, true);
                rows.push(row);
            });
            const progress = {
                stage,
                completedBoards: rows.length,
                targetBoards: manifest.stages[stage].length,
                invocationWallSeconds: (performance.now() - started) / 1000,
            };
            atomicJson(join(directory, `status-${firstBoard}-${endBoard}.json`), progress);
            process.stdout.write(JSON.stringify(progress) + "\n");
        }
        if (readV09PilotSource(repository).sha256 !== manifest.source.sha256)
            throw new Error("Pilot source changed before completion");
        rows.sort((a, b) => a.board - b.board);
        if (firstBoard !== 0 || endBoard !== manifest.stages[stage].length) {
            const part = {
                manifestSha256: manifest.manifestSha256,
                stage,
                firstBoard,
                endBoard,
                complete: true,
                boardHashes: rows.map((row) => row.boardSha256),
            };
            atomicJson(join(resultPath, `part-${firstBoard}-${endBoard}.json`), part);
            return part;
        }
        const statistics = v09PilotBoardStatistics(
            rows.map((row) => row.score),
            hashSimulationParts("v09-pilot-ci", manifest.seed, stage),
        );
        const summary = {
            schema: "hoc.ai.v0_9_a19_pilot_summary.v1",
            manifestSha256: manifest.manifestSha256,
            stage,
            complete: true,
            promoted: false,
            statistics,
            teacherPassedScreen:
                stage === "teacher_screen" &&
                statistics.lower95 !== null &&
                statistics.lower95 > 0.5 &&
                statistics.score >= 0.52,
            games: rows.length * 4,
            rejectedActions: 0,
            trainingDecisions: rows.reduce(
                (sum, row) =>
                    sum + row.games.reduce((total, game) => total + (game.training?.decisions.length ?? 0), 0),
                0,
            ),
            teacherPreset: manifest.teacherPreset,
            teacherRollouts: Number(manifest.teacher.SEARCH_ROLLOUTS),
            invocationWallSeconds: (performance.now() - started) / 1000,
            hostPlatform: process.platform,
            hostArchitecture: process.arch,
            diagnosticOnly: stage === "smoke" || stage === "aa",
            boardHashes: rows.map((row) => row.boardSha256),
            completedAt: new Date().toISOString(),
        };
        atomicJson(join(resultPath, "summary.json"), { ...summary, summarySha256: fingerprintV09(summary) }, true);
        process.stdout.write(JSON.stringify(summary) + "\n");
        return summary;
    } finally {
        await pool.close();
        // Delete only this process's successfully acquired lease, never another campaign owner's file.
        unlinkSync(lease);
    }
}

async function main(): Promise<void> {
    const { positionals, values } = parseArgs({
        args: Bun.argv.slice(2),
        allowPositionals: true,
        options: {
            out: { type: "string" },
            repository: { type: "string", default: process.cwd() },
            "server-root": { type: "string" },
            "source-commit": { type: "string" },
            "teacher-preset": { type: "string", default: "wide-r4" },
            seed: { type: "string", default: "2026102561" },
            workers: { type: "string", default: "1" },
            stage: { type: "string", default: "smoke" },
            "first-board": { type: "string", default: "0" },
            "board-count": { type: "string" },
            "protect-v08-root": { type: "string", multiple: true },
        },
        strict: true,
    });
    if (!values.out) throw new Error("Required: --out <fresh pilot directory>");
    const repository = resolve(values.repository);
    const directory = resolve(values.out);
    if (positionals[0] === "init") {
        if (!values["protect-v08-root"]?.length) throw new Error("Required: --protect-v08-root");
        assertV09OutputIsolation(directory, values["protect-v08-root"]);
        if (existsSync(directory)) throw new Error("Pilot initialization requires a fresh directory");
        const server = resolve(
            values["server-root"] ??
                process.env.HOC_SERVER_LOC ??
                join(repository, "../../..", "heroes-of-crypto-server"),
        );
        const profile = readA19AuditProfile({
            search: readFileSync(join(server, "src/api/game/v1/bot_search.ts"), "utf8"),
            draft: readFileSync(join(server, "src/api/game/v1/draft_policy.ts"), "utf8"),
            setup: readFileSync(join(server, "src/api/game/v1/setup_policy.ts"), "utf8"),
        });
        const manifest = buildV09A19PilotManifest({
            source: readV09PilotSource(repository),
            profile,
            seed: Number(values.seed),
            sourceCommit:
                values["source-commit"] ??
                execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(),
            runtime: Bun.version,
            protectedV08Roots: values["protect-v08-root"].map((root) => resolve(root)),
            teacherPreset: values["teacher-preset"] as V09A19TeacherPreset,
        });
        atomicJson(join(directory, "manifest.json"), manifest);
        process.stdout.write(JSON.stringify({ manifestSha256: manifest.manifestSha256, directory }) + "\n");
        atomicJson(join(directory, "feature-contract.json"), {
            ...V09_A19_OBSERVATION_CONTRACT,
            contractSha256: V09_A19_OBSERVATION_SHA256,
        });
    } else if (positionals[0] === "run" || positionals[0] === "verify" || positionals[0] === "finalize") {
        if (!Object.hasOwn(V09_A19_PILOT_STAGES, values.stage)) throw new Error("Unknown pilot stage");
        if (positionals[0] === "run")
            await runV09A19PilotStage(
                directory,
                repository,
                values.stage as V09A19PilotStage,
                Number(values.workers),
                Number(values["first-board"]),
                values["board-count"] === undefined ? undefined : Number(values["board-count"]),
            );
        else if (positionals[0] === "finalize") {
            const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) as IV09A19PilotManifest;
            validateV09A19PilotManifest(manifest);
            for (let board = 0; board < manifest.stages[values.stage as V09A19PilotStage].length; board++)
                if (!existsSync(join(directory, values.stage, `board-${board.toString().padStart(6, "0")}.json`)))
                    throw new Error("Cannot finalize an incomplete pilot stage");
            // With all boards already present the ordinary runner does no simulation and validates the merge.
            await runV09A19PilotStage(directory, repository, values.stage as V09A19PilotStage, 1);
        } else {
            const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) as IV09A19PilotManifest;
            validateV09A19PilotManifest(manifest);
            if (readV09PilotSource(repository).sha256 !== manifest.source.sha256)
                throw new Error("Pilot verification source changed");
            const { contractSha256, ...contract } = JSON.parse(
                readFileSync(join(directory, "feature-contract.json"), "utf8"),
            );
            if (contractSha256 !== manifest.observationSha256 || fingerprintV09(contract) !== contractSha256)
                throw new Error("Pilot observation contract changed");
            const stage = values.stage as V09A19PilotStage;
            const summary = completedStage(directory, manifest, stage);
            const files = manifest.stages[stage].map((_, board) => {
                const path = join(directory, stage, `board-${board.toString().padStart(6, "0")}.json`);
                return { path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
            });
            process.stdout.write(
                JSON.stringify({
                    manifestSha256: manifest.manifestSha256,
                    sourceSha256: manifest.source.sha256,
                    observationSha256: manifest.observationSha256,
                    stage,
                    summary,
                    files,
                }) + "\n",
            );
        }
    } else throw new Error("Usage: bun a19_pilot.ts init|run --out <directory> [--stage aa|smoke|teacher_screen]");
}

if (!isMainThread && workerData?.v09A19Pilot === true) startPersistentWorker(runV09PilotBoard);
else if (import.meta.main) {
    await main();
    await exitCompletedWorkerCli();
}
