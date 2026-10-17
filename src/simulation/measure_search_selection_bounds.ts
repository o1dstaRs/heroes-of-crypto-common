/** Matched offline games: verify the complete trajectory before comparing certified-bound runtimes. */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isMainThread, workerData } from "node:worker_threads";
import type { IDecisionContext } from "../ai/ai_strategy";
import type { IEnumeratedCandidate } from "../ai/candidates";
import type { GameAction } from "../engine/actions";
import type { Unit } from "../units/unit";
import { buildRoster, hashSimulationParts, makeRng } from "./army";
import { GREEN_TEAM, RED_TEAM, runMatch } from "./battle_engine";
import { liveTwinSetup } from "./livetwin";
import { PersistentWorkerPool, startPersistentWorker } from "./persistent_worker_pool";
import { SearchDriver } from "./search_driver";
import type { ISearchSelectionBoundPlan } from "./search_selection_bounds";

interface IResearchDriver {
    chooseDecision(unit: Unit, version: string, incumbent: GameAction[], context?: IDecisionContext): GameAction[];
    rollout(
        unit: Unit,
        candidate: IEnumeratedCandidate,
        seed: number,
        index: number,
        mode: string,
        ...rest: unknown[]
    ): number;
    certifiedSelectionBoundPlan(
        unit: Unit,
        candidates: readonly IEnumeratedCandidate[],
        version: string,
        ...flags: boolean[]
    ): ISearchSelectionBoundPlan | false;
    deps: { fightProperties: { getCurrentLap(): number } };
}
interface IMeasure {
    choices: unknown[];
    choiceMs: number;
    turns: number;
    leaf: number;
    boundPlans: number;
    tightPlans: number;
}
type Task = { seed: number; grid: number; output: string };
const p = SearchDriver.prototype as unknown as IResearchDriver;
const choose = p.chooseDecision,
    rollout = p.rollout,
    plan = p.certifiedSelectionBoundPlan;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const threadCpuUsage = Reflect.get(process, "threadCpuUsage") as
    ((previous?: ReturnType<typeof process.cpuUsage>) => ReturnType<typeof process.cpuUsage>) | undefined;
let active: IMeasure | null = null;

function install(): void {
    p.chooseDecision = function (this: IResearchDriver, ...args: Parameters<IResearchDriver["chooseDecision"]>) {
        const start = performance.now();
        const result = choose.apply(this, args);
        if (active) {
            active.choiceMs += performance.now() - start;
            active.choices.push(
                structuredClone({
                    unit: args[0].getId(),
                    team: args[0].getTeam(),
                    lap: this.deps.fightProperties.getCurrentLap(),
                    actions: result,
                }),
            );
        }
        return result;
    };
    p.rollout = function (this: IResearchDriver, ...args: Parameters<IResearchDriver["rollout"]>) {
        if (active) {
            if (args[4] === "turns") active.turns++;
            if (args[4] === "leaf") active.leaf++;
        }
        return rollout.apply(this, args);
    };
    p.certifiedSelectionBoundPlan = function (
        this: IResearchDriver,
        ...args: Parameters<IResearchDriver["certifiedSelectionBoundPlan"]>
    ) {
        const result = plan.apply(this, args);
        if (active && result) {
            active.boundPlans++;
            if (result.tailMargin !== undefined) active.tightPlans++;
        }
        return result;
    };
}

function oneGame(task: Task, tight: boolean) {
    if (!threadCpuUsage) throw new Error("This benchmark requires per-thread CPU accounting");
    const rng = makeRng(hashSimulationParts("a19-intellect-roster-v1", task.seed));
    const roster = buildRoster(rng, undefined, undefined, undefined, "expBudget");
    const redRoster = buildRoster(rng, undefined, undefined, undefined, "expBudget");
    const setup = liveTwinSetup();
    process.env.V08_A19_SEARCH_ENV_OVERRIDES = JSON.stringify({
        SEARCH_A19_MATERIAL_ARBITRATION: "ties",
        SEARCH_A19_CERTIFIED_SELECTION_BOUNDS: "1",
        SEARCH_A19_ROLLOUT_ALLOCATION: "uniform",
        SEARCH_A19_CERTIFIED_TIGHT_BOUNDS: tight ? "1" : "0",
    });
    active = { choices: [], choiceMs: 0, turns: 0, leaf: 0, boundPlans: 0, tightPlans: 0 };
    const start = performance.now(),
        cpuStart = threadCpuUsage();
    const result = runMatch({
        greenVersion: "v0.8",
        redVersion: "v0.8",
        roster,
        redRoster,
        seed: task.seed,
        gridType: task.grid,
        searchOfflineDeterministicWork: true,
        searchEnvOverrideTeams: [GREEN_TEAM, RED_TEAM],
        headlessEvents: true,
        greenDoctrine: setup.doctrine,
        redDoctrine: setup.doctrine,
        greenAugments: setup.augments,
        redAugments: setup.augments,
    });
    const ms = performance.now() - start,
        cpu = threadCpuUsage(cpuStart),
        measure = active;
    active = null;
    return {
        winner: result.winner,
        endReason: result.endReason,
        laps: result.laps,
        rejected: (result.rejectedGreen ?? 0) + (result.rejectedRed ?? 0),
        decisions: measure.choices.length,
        fingerprint: digest(measure.choices),
        wallMs: ms,
        cpuMs: (cpu.user + cpu.system) / 1000,
        cpuScope: "thread",
        choiceMs: measure.choiceMs,
        turnRollouts: measure.turns,
        leafRollouts: measure.leaf,
        boundPlans: measure.boundPlans,
        tightPlans: measure.tightPlans,
        trajectory: measure.choices,
    };
}

function onePair(task: Task) {
    // Alternate order by seed, so cold caches and within-worker warmup do not always favor one mode.
    const tightFirst = task.seed % 2 === 1;
    const first = oneGame(task, tightFirst),
        second = oneGame(task, !tightFirst);
    const control = tightFirst ? second : first,
        tight = tightFirst ? first : second;
    const same = ["fingerprint", "winner", "endReason", "laps", "decisions", "rejected"] as const;
    const exact =
        same.every((key) => control[key] === tight[key]) &&
        JSON.stringify(control.trajectory) === JSON.stringify(tight.trajectory);
    appendFileSync(
        task.output + ".trajectories.jsonl",
        JSON.stringify({ seed: task.seed, control: control.trajectory, tight: tight.trajectory, exact }) + "\n",
    );
    const controlStats = { ...control, trajectory: undefined };
    const tightStats = { ...tight, trajectory: undefined };
    const row = {
        ...task,
        tightFirst,
        exact,
        control: controlStats,
        tight: tightStats,
        savedTurnRollouts: control.turnRollouts - tight.turnRollouts,
    };
    appendFileSync(task.output + ".pairs.jsonl", JSON.stringify(row) + "\n");
    if (!exact) throw new Error("Certified tight bounds changed the complete trajectory for seed " + task.seed);
    if (control.rejected || tight.rejected) throw new Error("Rejected actions in bound comparison");
    if (control.leafRollouts !== tight.leafRollouts || row.savedTurnRollouts < 0)
        throw new Error("Bounds unexpectedly changed leaf work or increased turn-rollout count");
    return row;
}

if (!isMainThread && workerData?.selectionBoundsStudy === true) {
    install();
    startPersistentWorker<Task, ReturnType<typeof onePair>>(onePair);
} else if (import.meta.main) {
    const [gamesArg = "64", seedArg = "14602000", workersArg = "12", outputArg = "sim-out/selection-bounds/screen"] =
        process.argv.slice(2);
    const games = Number(gamesArg),
        seed = Number(seedArg),
        workers = Number(workersArg),
        output = resolve(outputArg);
    const sourceCommit = process.env.SEARCH_BOUNDS_SOURCE_COMMIT;
    if (
        ![games, seed, workers].every(Number.isSafeInteger) ||
        games < 1 ||
        workers < 1 ||
        seed < 0 ||
        seed + games > 2 ** 32
    )
        throw new Error("Invalid selection-bounds study arguments");
    if (!sourceCommit || !/^[a-f0-9]{40}$/.test(sourceCommit))
        throw new Error("Set SEARCH_BOUNDS_SOURCE_COMMIT to the frozen source commit");
    for (const suffix of [".pairs.jsonl", ".trajectories.jsonl", ".summary.json"])
        if (existsSync(output + suffix)) throw new Error("Choose a fresh selection-bounds output prefix");
    mkdirSync(dirname(output), { recursive: true });
    for (const suffix of [".pairs.jsonl", ".trajectories.jsonl"]) writeFileSync(output + suffix, "", { flag: "wx" });
    const grids = [1, 3, 4, 2];
    const tasks = Array.from({ length: games }, (_, i) => ({ seed: seed + i, grid: grids[i % grids.length], output }));
    const pool = new PersistentWorkerPool<Task, ReturnType<typeof onePair>>({
        concurrency: Math.min(workers, games),
        workerUrl: new URL(import.meta.url),
        workerOptions: { workerData: { selectionBoundsStudy: true } },
    });
    const started = Date.now();
    try {
        const rows = await pool.runBatch(tasks, ({ completed, total }) =>
            console.log(JSON.stringify({ completed, total, seconds: (Date.now() - started) / 1000 })),
        );
        writeFileSync(
            output + ".summary.json",
            JSON.stringify(
                {
                    sourceCommit,
                    runnerSha256: createHash("sha256")
                        .update(readFileSync(new URL(import.meta.url)))
                        .digest("hex"),
                    games,
                    seed,
                    workers,
                    exact: rows.every((row) => row.exact),
                    unchangedDecisions: rows.reduce((sum, row) => sum + row.control.decisions, 0),
                    savedTurnRollouts: rows.reduce((sum, row) => sum + row.savedTurnRollouts, 0),
                    controlTurnRollouts: rows.reduce((sum, row) => sum + row.control.turnRollouts, 0),
                    wallRatio:
                        rows.reduce((sum, row) => sum + row.tight.wallMs, 0) /
                        rows.reduce((sum, row) => sum + row.control.wallMs, 0),
                    cpuRatio:
                        rows.reduce((sum, row) => sum + row.tight.cpuMs, 0) /
                        rows.reduce((sum, row) => sum + row.control.cpuMs, 0),
                    seconds: (Date.now() - started) / 1000,
                    rows,
                },
                null,
                2,
            ) + "\n",
        );
    } finally {
        await pool.close();
    }
}
