/*
 * This file is part of the common code of the Heroes of Crypto.
 * Licensed under the MIT license in the root directory of this source tree.
 */

/**
 * Offline mechanism diagnostic: compare native continuations with A19 search on the first TWO future
 * turns, then native continuations thereafter. Both use identical root catalogs and private world banks.
 * The separate child SearchDriver stays nonrecursive. This is not a production optimization or a true
 * full-searched-policy reference. Actual play always returns the ordinary baseline's FINAL action.
 *
 * bun src/simulation/measure_search_future_policy.ts [games=8] [seed=14440000] [workers=8] [rollouts=16] [output]
 * FUTURE_POLICY_DISABLED=1 records control trajectories without counterfactual scoring.
 * Imports are inert; instrumentation is confined to this CLI's dedicated diagnostic workers.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isMainThread, workerData } from "node:worker_threads";
import { captureAITargetMemory } from "../ai/ai";
import type { IAIStrategy, IDecisionContext } from "../ai/ai_strategy";
import type { IEnumeratedCandidate } from "../ai/candidates";
import { commitV09TargetMemoryOverride } from "../ai/versions/v0_9";
import type { GameAction } from "../engine/actions";
import type { TeamType } from "../generated/protobuf/v1/types_gen";
import type { Unit } from "../units/unit";
import { captureDeterministicRandomState, restoreDeterministicRandomState } from "../utils/lib";
import { buildRoster, hashSimulationParts, makeRng } from "./army";
import { GREEN_TEAM, RED_TEAM, runMatch } from "./battle_engine";
import { snapshotBattle, restoreBattle } from "./battle_snapshot";
import { liveTwinSetup } from "./livetwin";
import type { ILookaheadDeps } from "./lookahead";
import { PersistentWorkerPool, startPersistentWorker } from "./persistent_worker_pool";
import { SearchDriver } from "./search_driver";
import { createV08A19SearchDriver } from "./v0_8_a19_search";

type Horizon = "leaf" | "turns" | "reply" | "lap";
interface IDriver {
    chooseDecision(unit: Unit, version: string, incumbent: GameAction[], context?: IDecisionContext): GameAction[];
    shortlistCandidates(
        unit: Unit,
        candidates: readonly IEnumeratedCandidate[],
        seed: number,
        deadline: number | null,
        version: string,
        ...priorities: boolean[]
    ): readonly IEnumeratedCandidate[];
    scoreCandidates(
        unit: Unit,
        candidates: readonly IEnumeratedCandidate[],
        seed: number,
        mode: Horizon,
        rollouts?: number,
        deadline?: number | null,
        horizon?: number,
        ...options: unknown[]
    ): number[];
    rollout(
        unit: Unit,
        candidate: IEnumeratedCandidate,
        seed: number,
        rollout: number,
        mode: Horizon,
        deadline?: number | null,
        horizon?: number,
    ): number;
    simPlayTurn(unit: Unit): void;
    deps: ILookaheadDeps;
    counters: Record<string, unknown>;
    a19MaterialEvidence?: {
        unitId: string;
        candidates: readonly IEnumeratedCandidate[];
        means: number[];
        materials: number[];
        rolloutCount: number;
    };
    captureA19Material: boolean;
    finishedSim: boolean;
    finishedWinningTeam: TeamType | null;
    rolloutEnemyTeam: TeamType | null;
    rollbackStrategy: "checkpoint" | "snapshot";
    finishPressureState: unknown;
    pureRangedTerminalState: unknown;
}
interface IFrame {
    catalog?: readonly IEnumeratedCandidate[];
    means?: number[];
    materials?: number[];
    samples?: number[][];
    seed?: number;
    horizon?: number;
}
type Task = { seed: number; grid: number; output: string; rollouts: number };
type Policy = "native" | "search-two";
const signature = (value: unknown) => JSON.stringify(value);
const digest = (value: unknown) =>
    createHash("sha256")
        .update(JSON.stringify(value, (_, v) => (v instanceof Map ? [...v] : v instanceof Set ? [...v] : v)))
        .digest("hex");
const p = SearchDriver.prototype as unknown as IDriver;
const originalChoose = p.chooseDecision,
    originalShortlist = p.shortlistCandidates;
const originalScore = p.scoreCandidates,
    originalRollout = p.rollout,
    originalSimPlay = p.simPlayTurn;
let frame: IFrame | null = null,
    probeDriver: IDriver | null = null,
    policy: Policy | null = null;
let worldSeed = 0,
    futureTurn = 0,
    nested = false;
let task: Task,
    ordinal = 0,
    eligible = 0,
    positions = 0;
let trajectory: unknown[] = [];
let nestedChoices = 0,
    changedNestedChoices = 0;
let changedExamples: unknown[] = [];

function install(): void {
    p.shortlistCandidates = function (this: IDriver, ...args: Parameters<IDriver["shortlistCandidates"]>) {
        const selected = originalShortlist.apply(this, args);
        if (frame && (!probeDriver || this === probeDriver)) frame.catalog = [...selected];
        return selected;
    };
    p.scoreCandidates = function (this: IDriver, ...args: Parameters<IDriver["scoreCandidates"]>) {
        const recording = frame && (!probeDriver || this === probeDriver) && args[3] === "turns";
        if (this === probeDriver && policy && args[3] === "turns") {
            args[2] = worldSeed;
            args[4] = task.rollouts;
            args[7] = false;
            if (frame) frame.samples = args[1].map(() => []);
        }
        const values = originalScore.apply(this, args);
        if (recording && frame) {
            frame.means = [...values];
            frame.seed = args[2];
            frame.horizon = args[6];
            frame.materials = this.a19MaterialEvidence ? [...this.a19MaterialEvidence.materials] : undefined;
        }
        return values;
    };
    p.rollout = function (this: IDriver, ...args: Parameters<IDriver["rollout"]>) {
        if (this !== probeDriver || !policy || args[4] !== "turns") return originalRollout.apply(this, args);
        futureTurn = 0;
        const value = originalRollout.apply(this, args);
        const index = frame?.catalog?.findIndex((c) => signature(c.actions) === signature(args[1].actions));
        if (index === undefined || index < 0 || !frame?.samples) throw new Error("Missing rollout sample slot");
        frame.samples[index][args[3]] = value;
        return value;
    };
    p.simPlayTurn = function (this: IDriver, unit: Unit) {
        if (this === probeDriver && policy) futureTurn++;
        return originalSimPlay.call(this, unit);
    };
    p.chooseDecision = observe;
}

function observe(this: IDriver, ...args: Parameters<IDriver["chooseDecision"]>): GameAction[] {
    const [unit] = args;
    const previous = frame;
    frame = {};
    const baseline = originalChoose.apply(this, args),
        base = frame;
    frame = previous;
    ordinal++;
    trajectory.push(
        structuredClone({
            unit: unit.getId(),
            team: unit.getTeam(),
            lap: this.deps.fightProperties.getCurrentLap(),
            actions: baseline,
        }),
    );
    if (!base.catalog || base.catalog.length < 2 || !base.means || !(base.means[0] > 0 && base.means[0] < 1))
        return baseline;
    eligible++;
    if (eligible > 1 || process.env.FUTURE_POLICY_DISABLED === "1") return baseline;
    const deps = this.deps,
        snap = snapshotBattle(deps.unitsHolder, deps.grid, deps.fightProperties);
    const stateDigest = digest({ ...snap, unitRefs: undefined });
    const rng = captureDeterministicRandomState(),
        stats = deps.captureDamageStats(),
        active = deps.getActiveUnitId();
    const restoreAux = deps.captureAuxiliaryState?.(),
        counters = structuredClone(this.counters);
    const evidence = this.a19MaterialEvidence,
        capture = this.captureA19Material,
        rollback = this.rollbackStrategy;
    const strategyForTeam = deps.strategyForTeam;
    const catalog = base.catalog;
    if (base.seed === undefined) throw new Error("Missing baseline seed");
    worldSeed = hashSimulationParts("a19-future-policy-world-v1", base.seed);
    const child = createV08A19SearchDriver(deps, {
        seed: task.seed,
        greenVersion: "v0.8",
        redVersion: "v0.8",
        offlineDeterministicWork: true,
    }) as unknown as IDriver;
    child.finishPressureState = this.finishPressureState;
    child.pureRangedTerminalState = this.pureRangedTerminalState;
    const wrappers = new Map<IAIStrategy, IAIStrategy>();
    deps.strategyForTeam = (team) => {
        const strategy = strategyForTeam(team);
        let wrapper = wrappers.get(strategy);
        if (!wrapper) {
            wrapper = Object.create(strategy) as IAIStrategy;
            wrapper.decideTurn = (actor, context) => {
                if (policy !== "search-two" || nested || futureTurn > 2) return strategy.decideTurn(actor, context);
                const liveContext: IDecisionContext = { ...context, decisionOrigin: "root" };
                const before = captureAITargetMemory(deps.unitsHolder);
                const incumbent = strategy.decideTurn(actor, liveContext);
                let chosen: GameAction[];
                nested = true;
                const savedRng = captureDeterministicRandomState();
                const savedState = digest({
                    ...snapshotBattle(deps.unitsHolder, deps.grid, deps.fightProperties),
                    unitRefs: undefined,
                });
                try {
                    chosen = originalChoose.call(child, actor, strategy.version, incumbent, liveContext);
                } finally {
                    nested = false;
                }
                // Child search must not consume the actual world's future chance or mutate its epoch.
                if (
                    digest({
                        ...snapshotBattle(deps.unitsHolder, deps.grid, deps.fightProperties),
                        unitRefs: undefined,
                    }) !== savedState
                )
                    throw new Error("Nested search leaked speculative battle state");
                // A stateful random generator cannot be compared by object identity; restore explicitly.
                restoreDeterministicRandomState(savedRng);
                if (chosen !== incumbent)
                    commitV09TargetMemoryOverride(deps.unitsHolder, actor.getId(), before, chosen);
                nestedChoices++;
                if (signature(chosen) !== signature(incumbent)) {
                    changedNestedChoices++;
                    if (changedExamples.length < 24)
                        changedExamples.push({
                            actor: actor.getName(),
                            lap: deps.fightProperties.getCurrentLap(),
                            futureTurn,
                            incumbent: structuredClone(incumbent),
                            chosen: structuredClone(chosen),
                        });
                }
                return chosen;
            };
            wrappers.set(strategy, wrapper);
        }
        return wrapper;
    };
    const probes: unknown[] = [];
    const started = performance.now();
    try {
        // The prototype hooks identify this outer scorer; the separate child keeps its native rollouts.
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        probeDriver = this;
        this.rollbackStrategy = "snapshot";
        for (const selectedPolicy of ["native", "search-two"] as const) {
            restoreDeterministicRandomState(rng);
            deps.setActiveUnitId(active);
            this.finishedSim = false;
            this.finishedWinningTeam = null;
            frame = {};
            policy = selectedPolicy;
            nestedChoices = 0;
            changedNestedChoices = 0;
            changedExamples = [];
            const start = performance.now();
            const chosen = originalChoose.apply(this, args),
                measured = frame;
            const selected = catalog.findIndex((c) => signature(c.actions) === signature(chosen));
            if (
                selected < 0 ||
                !measured.means ||
                !measured.materials ||
                !measured.samples ||
                signature(measured.catalog?.map((c) => c.actions)) !== signature(catalog.map((c) => c.actions))
            )
                throw new Error("Counterfactual changed catalog or missed final action");
            for (let i = 0; i < catalog.length; i++) {
                const samples = measured.samples[i];
                if (
                    samples.length !== task.rollouts ||
                    samples.some((v) => !Number.isFinite(v)) ||
                    Math.abs(samples.reduce((sum, v) => sum + v, 0) / task.rollouts - measured.means[i]) > 1e-12
                )
                    throw new Error("Incomplete or rejected rollout samples");
            }
            if (
                digest({
                    ...snapshotBattle(deps.unitsHolder, deps.grid, deps.fightProperties),
                    unitRefs: undefined,
                }) !== stateDigest
            )
                throw new Error("Counterfactual leaked live battle state");
            probes.push({
                policy,
                means: measured.means,
                materials: measured.materials,
                selected,
                samples: measured.samples,
                nestedChoices,
                changedNestedChoices,
                changedExamples,
                ms: performance.now() - start,
            });
        }
        positions++;
        appendFileSync(
            task.output + ".positions.jsonl",
            JSON.stringify({
                schema: "hoc.a19-future-policy-position.v1",
                seed: task.seed,
                grid: task.grid,
                ordinal,
                unit: unit.getName(),
                lap: deps.fightProperties.getCurrentLap(),
                stateDigest,
                worldSeed,
                rollouts: task.rollouts,
                searchedFutureTurns: 2,
                horizon: base.horizon,
                catalog: catalog.map((c) => ({ kind: c.kind, actions: c.actions })),
                probes,
                ms: performance.now() - started,
            }) + "\n",
        );
    } finally {
        deps.strategyForTeam = strategyForTeam;
        restoreBattle(snap, deps.unitsHolder, deps.grid, deps.fightProperties);
        deps.restoreDamageStats(stats);
        restoreAux?.();
        restoreDeterministicRandomState(rng);
        deps.setActiveUnitId(active);
        Object.assign(this.counters, counters);
        this.a19MaterialEvidence = evidence;
        this.captureA19Material = capture;
        this.rollbackStrategy = rollback;
        this.finishedSim = false;
        this.finishedWinningTeam = null;
        this.rolloutEnemyTeam = null;
        probeDriver = null;
        policy = null;
        frame = previous;
        nested = false;
    }
    return baseline;
}

function oneGame(input: Task) {
    task = input;
    ordinal = 0;
    eligible = 0;
    positions = 0;
    trajectory = [];
    const rng = makeRng(hashSimulationParts("a19-intellect-roster-v1", input.seed));
    const roster = buildRoster(rng, undefined, undefined, undefined, "expBudget");
    const redRoster = buildRoster(rng, undefined, undefined, undefined, "expBudget");
    const setup = liveTwinSetup();
    process.env.V08_A19_SEARCH_ENV_OVERRIDES = JSON.stringify({
        SEARCH_A19_MATERIAL_ARBITRATION: "ties",
        SEARCH_A19_CERTIFIED_SELECTION_BOUNDS: "1",
        SEARCH_A19_ROLLOUT_ALLOCATION: "uniform",
    });
    const start = performance.now();
    const result = runMatch({
        greenVersion: "v0.8",
        redVersion: "v0.8",
        roster,
        redRoster,
        seed: input.seed,
        gridType: input.grid,
        searchOfflineDeterministicWork: true,
        searchEnvOverrideTeams: [GREEN_TEAM, RED_TEAM],
        headlessEvents: true,
        greenDoctrine: setup.doctrine,
        redDoctrine: setup.doctrine,
        greenAugments: setup.augments,
        redAugments: setup.augments,
    });
    const row = {
        ...input,
        winner: result.winner,
        endReason: result.endReason,
        laps: result.laps,
        rejected: (result.rejectedGreen ?? 0) + (result.rejectedRed ?? 0),
        decisions: ordinal,
        positions,
        fingerprint: digest(trajectory),
        ms: performance.now() - start,
    };
    appendFileSync(input.output + ".trajectory.jsonl", JSON.stringify({ seed: input.seed, trajectory }) + "\n");
    appendFileSync(input.output + ".games.jsonl", JSON.stringify(row) + "\n");
    return row;
}

if (!isMainThread && workerData?.futurePolicyDiagnostic === true) {
    install();
    startPersistentWorker<Task, ReturnType<typeof oneGame>>(oneGame);
} else if (import.meta.main) {
    const [
        gamesArg = "8",
        seedArg = "14440000",
        workersArg = "8",
        rolloutsArg = "16",
        outputArg = "sim-out/future-policy/diagnostic",
    ] = process.argv.slice(2);
    const games = Number(gamesArg),
        seed = Number(seedArg),
        workers = Number(workersArg),
        rollouts = Number(rolloutsArg),
        output = resolve(outputArg);
    if (
        ![games, seed, workers, rollouts].every(Number.isSafeInteger) ||
        games < 1 ||
        workers < 1 ||
        rollouts < 1 ||
        seed < 0 ||
        seed + games > 2 ** 32
    )
        throw new Error("Invalid numeric arguments");
    const suffixes = [".positions.jsonl", ".games.jsonl", ".trajectory.jsonl", ".summary.json"];
    if (suffixes.some((s) => existsSync(output + s))) throw new Error("Choose a fresh output prefix");
    mkdirSync(dirname(output), { recursive: true });
    for (const s of suffixes.slice(0, -1)) writeFileSync(output + s, "", { flag: "wx" });
    const pool = new PersistentWorkerPool<Task, ReturnType<typeof oneGame>>({
        concurrency: Math.min(games, workers),
        workerUrl: new URL(import.meta.url),
        workerOptions: { workerData: { futurePolicyDiagnostic: true } },
    });
    const start = Date.now();
    try {
        const results = await pool.runBatch(
            Array.from({ length: games }, (_, i) => ({ seed: seed + i, grid: [1, 3, 4, 2][i % 4], rollouts, output })),
            ({ completed, total }) =>
                console.log(JSON.stringify({ completed, total, seconds: (Date.now() - start) / 1000 })),
        );
        writeFileSync(
            output + ".summary.json",
            JSON.stringify(
                {
                    schema: "hoc.a19-future-policy-study.v1",
                    sourceCommit: process.env.SEARCH_CHANCE_SOURCE_COMMIT ?? null,
                    diagnosticSha256: createHash("sha256")
                        .update(readFileSync(new URL(import.meta.url)))
                        .digest("hex"),
                    disabled: process.env.FUTURE_POLICY_DISABLED === "1",
                    searchedFutureTurns: 2,
                    rollouts,
                    games: results,
                    seconds: (Date.now() - start) / 1000,
                },
                null,
                2,
            ) + "\n",
        );
    } finally {
        await pool.close();
    }
}
