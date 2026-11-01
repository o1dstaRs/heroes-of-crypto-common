/** Compare checkpoint rollback with full snapshots, including shared-reference topology at every root. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { isMainThread, workerData } from "node:worker_threads";
import type { RankedDraftStrengthPolicyId } from "../../ai/setup/draft_strength_prior";
import { creatureInfo } from "../../ai/setup/creature_score";
import type { GameAction } from "../../engine/actions";
import type { FightProperties } from "../../fights/fight_properties";
import type { Grid } from "../../grid/grid";
import type { Unit } from "../../units/unit";
import type { UnitsHolder } from "../../units/units_holder";
import { captureDeterministicRandomState } from "../../utils/lib";
import { runMatch, type IMatchConfig } from "../battle_engine";
import { snapshotBattle } from "../battle_snapshot";
import { exitCompletedWorkerCli } from "../completed_worker_cli";
import { PersistentWorkerPool, startPersistentWorker } from "../persistent_worker_pool";
import {
    playRankedDraftGame,
    rankedDraftStrengthCandidate,
    sanitizedRankedDraftEnvironment,
} from "../ranked_draft_eval";
import { SearchDriver } from "../search_driver";
import { readV09PilotSource, type IV09A19PilotManifest } from "./a19_pilot_protocol";
import { assertV09StudentSource } from "./a19_student_protocol";
import { fingerprintV09 } from "./protocol";

interface IDriver {
    rollbackStrategy: string;
    horizon: number;
    rollouts: number;
    shortlist: number;
    complementaryR2: boolean;
    certifiedSelectionBounds: boolean;
    certifiedTightBounds: boolean;
    deps: { unitsHolder: UnitsHolder; grid: Grid; fightProperties: FightProperties; captureDamageStats(): unknown };
    chooseDecision(unit: Unit, ...rest: unknown[]): GameAction[];
}

/** IDs describe graph topology, not memory addresses. Wall-clock fields are outside offline behavior. */
function stateGraph(driver: IDriver): string {
    const snapshot = snapshotBattle(driver.deps.unitsHolder, driver.deps.grid, driver.deps.fightProperties);
    const { unitRefs: _refs, ...battle } = snapshot;
    void _refs;
    const seen = new Map<object, number>();
    const clocks = new Set(["currentTurnStart", "currentTurnEnd", "currentLapTotalTimePerTeam"]);
    const visit = (value: unknown): unknown => {
        if (value === undefined) return ["undefined"];
        if (typeof value === "function") return ["function", value.name];
        if (typeof value === "bigint" || typeof value === "symbol") return [typeof value, String(value)];
        if (typeof value === "number" && !Number.isFinite(value)) return ["number", String(value)];
        if (value === null || typeof value !== "object") return value;
        if (seen.has(value)) return ["ref", seen.get(value)];
        const id = seen.size;
        seen.set(value, id);
        if (value instanceof Map) return ["map", id, [...value].map(([key, item]) => [visit(key), visit(item)])];
        if (value instanceof Set) return ["set", id, [...value].map(visit)];
        if (ArrayBuffer.isView(value))
            return [value.constructor.name, id, Array.from(value as unknown as ArrayLike<number>)];
        if (Array.isArray(value))
            return [
                "array",
                id,
                Array.from({ length: value.length }, (_, index) => (index in value ? visit(value[index]) : ["hole"])),
            ];
        return [
            Object.getPrototypeOf(value)?.constructor?.name ?? "null",
            id,
            Object.keys(value)
                .sort()
                .filter((key) => !clocks.has(key))
                .map((key) => [key, visit((value as Record<string, unknown>)[key])]),
        ];
    };
    return fingerprintV09(visit({ ...battle, damageStats: driver.deps.captureDamageStats() }));
}

interface ITask {
    parent: IV09A19PilotManifest;
    board: number;
    profile: "baseline" | "teacher";
}
function checkBoard({ parent, board, profile }: ITask) {
    creatureInfo(1);
    const genome = rankedDraftStrengthCandidate(parent.profile.draft as RankedDraftStrengthPolicyId);
    const games = [];
    for (let index = 0; index < 4; index++) {
        const play = (backend: "checkpoint" | "snapshot") => {
            const environment: Record<string, string> = { ...parent[profile], SEARCH_ROLLBACK_STRATEGY: backend };
            const roots: { unitId: string; before: string; after: string }[] = [];
            const trace = createHash("sha256");
            const record = playRankedDraftGame(
                genome,
                genome,
                {
                    gamesPerOpponent: 8,
                    baseSeed: parent.stages.aa[board],
                    mapTypes: [[1, 3, 4][board % 3]],
                    fightProfile: "a19",
                    maxLaps: 256,
                    liveDraftRules: true,
                    sideBoard: true,
                    deterministicSearch: true,
                    liveSynergyVariants: true,
                    tacticalSplits: true,
                    candidateSearchEnvOverrides: environment,
                    candidateSetupPolicySpec: parent.profile.setup,
                    opponentSetupPolicySpec: parent.profile.setup,
                    candidateDoctrinePolicy: "see-none",
                    opponentDoctrinePolicy: "see-none",
                },
                index,
                0,
                {
                    matchRunner: (config: IMatchConfig) => {
                        const prototype = SearchDriver.prototype as unknown as IDriver;
                        const native = prototype.chooseDecision;
                        prototype.chooseDecision = function (...args) {
                            if (
                                this.rollbackStrategy !== backend ||
                                this.horizon !== Number(environment.SEARCH_HORIZON) ||
                                this.rollouts !== Number(environment.SEARCH_ROLLOUTS) ||
                                this.shortlist !== Number(environment.SEARCH_SHORTLIST) ||
                                this.complementaryR2 !== (environment.SEARCH_A19_COMPLEMENTARY_R2 === "1") ||
                                this.certifiedSelectionBounds !==
                                    (environment.SEARCH_A19_CERTIFIED_SELECTION_BOUNDS === "1") ||
                                this.certifiedTightBounds !== (environment.SEARCH_A19_CERTIFIED_TIGHT_BOUNDS === "1")
                            )
                                throw new Error(
                                    "Actual rollback backend or R2/R8 budget differs from the requested profile",
                                );
                            const random = captureDeterministicRandomState();
                            const before = stateGraph(this);
                            const chosen = native.apply(this, args);
                            const afterRandom = captureDeterministicRandomState();
                            if (
                                random.source !== afterRandom.source ||
                                random.uuidSequence !== afterRandom.uuidSequence
                            )
                                throw new Error("Root search leaked its RNG source or UUID counter");
                            roots.push({ unitId: args[0].getId(), before, after: stateGraph(this) });
                            return chosen;
                        };
                        try {
                            return runMatch({
                                ...config,
                                headlessEvents: true,
                                researchA19BaseSearchEnvironment: environment,
                                turnExecutionObserver: (turn) => {
                                    trace.update(JSON.stringify([turn.side, turn.unitId, turn.chosenDecision]));
                                },
                            });
                        } finally {
                            prototype.chooseDecision = native;
                        }
                    },
                },
            );
            if (record.rejectedCandidate || record.rejectedOpponent || record.endReason !== "elimination")
                throw new Error("Rollback preflight requires complete legal games");
            return { record, roots, trajectorySha256: trace.digest("hex") };
        };
        const checkpoint = play("checkpoint"),
            reference = play("snapshot");
        const equalRecords = fingerprintV09(checkpoint.record) === fingerprintV09(reference.record);
        const equalRoots = fingerprintV09(checkpoint.roots) === fingerprintV09(reference.roots);
        games.push({
            index,
            equalRecords,
            equalRoots,
            equalTrajectory: checkpoint.trajectorySha256 === reference.trajectorySha256,
            checkpoint,
            reference,
        });
    }
    return { board, profile, games };
}

async function main() {
    const { values } = parseArgs({
        args: Bun.argv.slice(2),
        strict: true,
        options: {
            manifest: { type: "string" },
            out: { type: "string" },
            workers: { type: "string", default: "2" },
            boards: { type: "string", default: "6" },
        },
    });
    if (!values.manifest || !values.out) throw new Error("Required: --manifest --out");
    const parent = JSON.parse(readFileSync(values.manifest, "utf8")) as IV09A19PilotManifest;
    assertV09StudentSource(parent, readV09PilotSource(process.cwd()));
    if (Bun.version !== parent.runtime) throw new Error("Use the frozen Bun runtime for rollback qualification");
    const count = Number(values.boards),
        workers = Number(values.workers);
    if (
        !Number.isInteger(count) ||
        count < 3 ||
        count > 12 ||
        count % 3 ||
        !Number.isInteger(workers) ||
        workers < 1 ||
        workers > 12
    )
        throw new Error("Use 3/6/9/12 diagnostic boards and at most twelve CPU workers");
    const pool = new PersistentWorkerPool<ITask, ReturnType<typeof checkBoard>>({
        concurrency: workers,
        workerUrl: new URL(import.meta.url),
        workerOptions: {
            workerData: { a19RollbackPreflight: true },
            env: { ...sanitizedRankedDraftEnvironment(process.env, "a19"), LIVETWIN: "1" },
        },
    });
    try {
        const tasks = Array.from({ length: count }, (_, board) =>
            (["baseline", "teacher"] as const).map((profile) => ({ parent, board, profile })),
        ).flat();
        const rows = await pool.runBatch(tasks, (progress) => {
            process.stdout.write(JSON.stringify({ rollbackPreflightProgress: progress }) + "\n");
        });
        const games = rows.flatMap((row) => row.games);
        const report = {
            schema: "hoc.ai.v0_9_a19_rollback_preflight.v1",
            promoted: false,
            strengthClaim: false,
            sourceSha256: parent.source.sha256,
            snapshotSourceSha256: parent.source.files["src/simulation/battle_snapshot.ts"],
            profiles: ["baseline", "teacher"],
            actualProfileAssertionsPassed: true,
            boards: count,
            games: games.length * 2,
            rootWitnesses: games.reduce((n, game) => n + game.checkpoint.roots.length, 0),
            completeRecordMismatches: games.filter((game) => !game.equalRecords).length,
            stateOrAliasWitnessMismatches: games.filter((game) => !game.equalRoots).length,
            trajectoryMismatches: games.filter((game) => !game.equalTrajectory).length,
            rejectedActions: 0,
            excludedClocks: ["currentTurnStart", "currentTurnEnd", "currentLapTotalTimePerTeam"],
            rows,
        };
        writeFileSync(values.out, JSON.stringify(report) + "\n", { flag: "wx" });
        const { rows: _rows, ...summary } = report;
        process.stdout.write(JSON.stringify({ ...summary, rows: _rows.length }) + "\n");
        if (report.completeRecordMismatches || report.stateOrAliasWitnessMismatches || report.trajectoryMismatches)
            throw new Error(
                "Checkpoint rollback differs from the full-snapshot reference; GPU admission stays blocked",
            );
    } finally {
        await pool.close();
    }
}

if (!isMainThread && workerData?.a19RollbackPreflight === true) startPersistentWorker(checkBoard);
else if (import.meta.main) {
    await main();
    await exitCompletedWorkerCli();
}
