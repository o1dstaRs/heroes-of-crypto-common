/** CPU-only pipeline rehearsal on actor smoke boards. Never consumes a student strength bank. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isMainThread, workerData } from "node:worker_threads";
import type { RankedDraftStrengthPolicyId } from "../../ai/setup/draft_strength_prior";
import { runMatch, type IMatchConfig } from "../battle_engine";
import { exitCompletedWorkerCli } from "../completed_worker_cli";
import { PersistentWorkerPool, startPersistentWorker } from "../persistent_worker_pool";
import {
    playRankedDraftGame,
    rankedDraftStrengthCandidate,
    sanitizedRankedDraftEnvironment,
} from "../ranked_draft_eval";
import { withV09A19Correction } from "./a19_correction";
import { V09A19CpuModel } from "./a19_inference";
import { withV09PilotDriverAudit } from "./a19_pilot";
import { readV09PilotSource, validateV09A19PilotManifest, type IV09A19PilotManifest } from "./a19_pilot_protocol";
import { assertV09StudentSource, v09StudentFileSha256 } from "./a19_student_protocol";
import { fingerprintV09 } from "./protocol";

interface ITask {
    parent: IV09A19PilotManifest;
    model: string;
    board: number;
}

export function runV09ModelSmokeBoard({ parent, model: modelBytes, board }: ITask) {
    validateV09A19PilotManifest(parent);
    if (!Number.isInteger(board) || board < 0 || board >= 3) throw new Error("Rehearsal uses only actor smoke boards");
    const model = new V09A19CpuModel(JSON.parse(modelBytes), {
        manifestSha256: parent.manifestSha256,
        sourceSha256: parent.source.sha256,
    });
    const genome = rankedDraftStrengthCandidate(parent.profile.draft as RankedDraftStrengthPolicyId);
    const games = [];
    for (let index = 0; index < 4; index++) {
        const play = (mode: "stock" | "abstaining" | "active") => {
            const trace = createHash("sha256");
            let statistics: ReturnType<typeof withV09A19Correction>["statistics"] | undefined;
            const record = playRankedDraftGame(
                genome,
                genome,
                {
                    gamesPerOpponent: 8,
                    baseSeed: parent.stages.smoke[board],
                    mapTypes: [[1, 3, 4][board]],
                    fightProfile: "a19",
                    maxLaps: 256,
                    liveDraftRules: true,
                    sideBoard: true,
                    deterministicSearch: true,
                    liveSynergyVariants: true,
                    tacticalSplits: true,
                    candidateSearchEnvOverrides: parent.baseline,
                    candidateSetupPolicySpec: parent.profile.setup,
                    opponentSetupPolicySpec: parent.profile.setup,
                    candidateDoctrinePolicy: "see-none",
                    opponentDoctrinePolicy: "see-none",
                },
                index,
                0,
                {
                    matchRunner: (config: IMatchConfig) => {
                        const team = config.searchEnvOverrideTeams?.[0];
                        if (team === undefined) throw new Error("Rehearsal has no actual candidate seat");
                        const audited = withV09PilotDriverAudit(team, parent.baseline, parent.baseline, () => {
                            const corrected = withV09A19Correction(
                                {
                                    team,
                                    model: mode === "stock" ? null : model,
                                    minimumLogitGain: mode === "active" ? 0.000001 : 1_000_000,
                                },
                                () =>
                                    runMatch({
                                        ...config,
                                        headlessEvents: true,
                                        researchA19BaseSearchEnvironment: parent.baseline,
                                        turnExecutionObserver: (turn) => {
                                            trace.update(JSON.stringify([turn.side, turn.unitId, turn.chosenDecision]));
                                        },
                                    }),
                            );
                            statistics = corrected.statistics;
                            return corrected.value;
                        });
                        return audited.value;
                    },
                },
            );
            if (
                record.rejectedCandidate ||
                record.rejectedOpponent ||
                record.endReason !== "elimination" ||
                !statistics
            )
                throw new Error("Neural pipeline rehearsal produced a rejected or incomplete match");
            return { mode, record, trajectorySha256: trace.digest("hex"), statistics };
        };
        const stock = play("stock"),
            abstaining = play("abstaining"),
            active = play("active");
        if (
            fingerprintV09(stock.record) !== fingerprintV09(abstaining.record) ||
            stock.trajectorySha256 !== abstaining.trajectorySha256 ||
            abstaining.statistics.corrected !== 0
        )
            throw new Error("CPU-trained model changed an abstaining complete match");
        games.push({ stock, abstaining, active });
    }
    return { board, games };
}

async function main() {
    const { values } = parseArgs({
        args: Bun.argv.slice(2),
        strict: true,
        options: {
            manifest: { type: "string" },
            model: { type: "string" },
            repository: { type: "string", default: process.cwd() },
            out: { type: "string" },
            workers: { type: "string", default: "2" },
        },
    });
    if (!values.manifest || !values.model || !values.out) throw new Error("Required: --manifest --model --out");
    const repository = resolve(values.repository),
        parent = JSON.parse(readFileSync(values.manifest, "utf8")) as IV09A19PilotManifest,
        model = readFileSync(values.model, "utf8"),
        source = readV09PilotSource(repository),
        workers = Number(values.workers);
    if (
        Bun.version !== parent.runtime ||
        resolve(import.meta.path) !== join(repository, "src/simulation/v0_9/a19_model_smoke.ts") ||
        !Number.isInteger(workers) ||
        workers < 1 ||
        workers > 2
    )
        throw new Error("Use the frozen matching source/runtime and at most two rehearsal workers");
    assertV09StudentSource(parent, source);
    const pool = new PersistentWorkerPool<ITask, ReturnType<typeof runV09ModelSmokeBoard>>({
        concurrency: workers,
        workerUrl: new URL(import.meta.url),
        workerOptions: {
            workerData: { v09A19ModelSmoke: true },
            env: { ...sanitizedRankedDraftEnvironment(process.env, "a19"), LIVETWIN: "1" },
        },
    });
    try {
        const boards = await pool.runBatch([0, 1, 2].map((board) => ({ parent, model, board })));
        const games = boards.flatMap((board) => board.games);
        const inferred = games.reduce((n, game) => n + game.active.statistics.inferred, 0),
            corrected = games.reduce((n, game) => n + game.active.statistics.corrected, 0);
        if (!inferred || !corrected) throw new Error("Readiness smoke did not exercise actual neural corrections");
        const report = {
            schema: "hoc.ai.v0_9_a19_model_smoke.v1",
            diagnosticOnly: true,
            strengthClaim: false,
            promoted: false,
            manifestSha256: parent.manifestSha256,
            actorSourceSha256: parent.source.sha256,
            evaluationSourceSha256: source.sha256,
            modelFileSha256: v09StudentFileSha256(model),
            boardBank: "actor smoke only",
            games: games.length * 3,
            activeGames: games.length,
            exactAbstainingMatches: games.length,
            inferred,
            corrected,
            rejectedActions: 0,
            activeConfidenceMargin: 0.000001,
            note: "Low diagnostic margin exercises the full pipeline; it is not the registered student policy",
            boards,
        };
        writeFileSync(values.out, JSON.stringify(report) + "\n", { flag: "wx" });
        const { boards: _boards, ...summary } = report;
        process.stdout.write(JSON.stringify({ ...summary, boards: _boards.length }) + "\n");
    } finally {
        await pool.close();
    }
}

if (!isMainThread && workerData?.v09A19ModelSmoke === true) startPersistentWorker(runV09ModelSmokeBoard);
else if (import.meta.main) {
    await main();
    await exitCompletedWorkerCli();
}
