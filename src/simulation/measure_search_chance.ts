/*
 * This file is part of the common code of the Heroes of Crypto.
 * Licensed under the MIT license in the root directory of this source tree.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isMainThread, workerData } from "node:worker_threads";
import type { IDecisionContext } from "../ai/ai_strategy";
import type { IEnumeratedCandidate } from "../ai/candidates";
import type { GameAction } from "../engine/actions";
import type { TeamType } from "../generated/protobuf/v1/types_gen";
import type { Unit } from "../units/unit";
import {
    captureDeterministicRandomState,
    restoreDeterministicRandomState,
    setDeterministicRandomSource,
} from "../utils/lib";
import { buildRoster, hashSimulationParts, makeRng } from "./army";
import { GREEN_TEAM, RED_TEAM, runMatch } from "./battle_engine";
import { restoreBattle, snapshotBattle } from "./battle_snapshot";
import { liveTwinSetup } from "./livetwin";
import type { ILookaheadDeps } from "./lookahead";
import { PersistentWorkerPool, startPersistentWorker } from "./persistent_worker_pool";
import { makeSearchChanceStream, type ISearchChanceHashCache, type SearchChanceBank } from "./search_chance_sampling";
import { SearchDriver } from "./search_driver";

/**
 * Observational chance-bank calibration. Actual play always returns the unchanged baseline's FINAL action.
 * At the first two contested decisions/game, compare eight fresh R4 banks against an independent R128
 * reference on the SAME shortlist. References are finite estimates, not optimal values or match scores.
 *
 * bun src/simulation/measure_search_chance.ts [games=64] [seed=14430000] [workers=12] [output]
 * SEARCH_CHANCE_DIAGNOSTIC_DISABLED=1 records control trajectories without any counterfactual search.
 * Importing this module never installs instrumentation or changes a SearchDriver prototype.
 */

type Horizon = "leaf" | "turns" | "reply" | "lap";
interface IMaterialEvidence {
    unitId: string;
    candidates: readonly IEnumeratedCandidate[];
    means: number[];
    materials: number[];
    rolloutCount: number;
}
interface IResearchDriver {
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
    deps: ILookaheadDeps;
    counters: Record<string, unknown>;
    a19MaterialEvidence?: IMaterialEvidence;
    captureA19Material: boolean;
    finishedSim: boolean;
    finishedWinningTeam: TeamType | null;
    rolloutEnemyTeam: TeamType | null;
}
interface IFrame {
    shortlist?: readonly IEnumeratedCandidate[];
    means?: number[];
    seed?: number;
    horizon?: number;
}
type Bank = "control" | SearchChanceBank;
interface IReplicate {
    rep: number;
    bank: Bank;
    seed: number;
    means: number[];
    selected: number;
    mse: number;
    differenceMse: number;
    bias: number;
    referenceValue: number;
    regret: number;
}
const BANKS: readonly Bank[] = ["control", "antithetic", "actor", "actor-antithetic"];
const REFERENCE_ROLLOUTS = 128;
const REPLICATES = 8;
type Task = { seed: number; grid: number; output: string };
const digest = (value: unknown): string =>
    createHash("sha256")
        .update(JSON.stringify(value, (_, v) => (v instanceof Map ? [...v] : v instanceof Set ? [...v] : v)))
        .digest("hex");
const signature = (actions: unknown): string => JSON.stringify(actions);
const p = SearchDriver.prototype as unknown as IResearchDriver;
const originalChoose = p.chooseDecision,
    originalShortlist = p.shortlistCandidates;
const originalScore = p.scoreCandidates,
    originalRollout = p.rollout;
let frame: IFrame | null = null,
    bank: Bank = "control",
    overrideSeed: number | null = null;
let task: Task,
    eligible = 0,
    ordinal = 0,
    positions = 0;
let trajectory: unknown[] = [];

function installDiagnostic(): void {
    const caches = new WeakMap<object, ISearchChanceHashCache>();
    p.rollout = function (this: IResearchDriver, ...args: Parameters<IResearchDriver["rollout"]>) {
        const engine = this.deps.engine,
            apply = engine.apply;
        let first = true;
        const selectedBank = bank;
        if (selectedBank !== "control" && args[4] === "turns") {
            engine.apply = (...actions: Parameters<typeof apply>) => {
                if (first) {
                    first = false;
                    let cache = caches.get(engine);
                    if (!cache) {
                        cache = { hashes: new Map() };
                        caches.set(engine, cache);
                    }
                    setDeterministicRandomSource(
                        makeSearchChanceStream(args[2], args[3], selectedBank, this.deps, cache),
                    );
                }
                return apply.apply(engine, actions);
            };
        }
        try {
            return originalRollout.apply(this, args);
        } finally {
            engine.apply = apply;
        }
    };
    p.shortlistCandidates = function (
        this: IResearchDriver,
        ...args: Parameters<IResearchDriver["shortlistCandidates"]>
    ) {
        const selected = originalShortlist.apply(this, args);
        if (frame) frame.shortlist = [...selected];
        return selected;
    };
    p.scoreCandidates = function (this: IResearchDriver, ...args: Parameters<IResearchDriver["scoreCandidates"]>) {
        if (args[3] === "turns" && overrideSeed !== null) {
            args[2] = overrideSeed;
            args[7] = false;
        }
        const values = originalScore.apply(this, args);
        if (frame && args[3] === "turns") {
            frame.means = [...values];
            frame.seed = args[2];
            frame.horizon = args[6];
        }
        return values;
    };
    installChooseObserver();
}

function installChooseObserver(): void {
    p.chooseDecision = function (this: IResearchDriver, unit, ...args) {
        const previous = frame;
        frame = {};
        bank = "control";
        overrideSeed = null;
        const baseline = originalChoose.call(this, unit, ...args),
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
        if (!base.shortlist || base.shortlist.length < 2 || !base.means || !(base.means[0] > 0 && base.means[0] < 1))
            return baseline;
        eligible++;
        if (eligible > 2 || process.env.SEARCH_CHANCE_DIAGNOSTIC_DISABLED === "1") return baseline;
        const deps = this.deps,
            snap = snapshotBattle(deps.unitsHolder, deps.grid, deps.fightProperties);
        const stateDigest = digest({ ...snap, unitRefs: undefined });
        const rng = captureDeterministicRandomState(),
            damage = deps.captureDamageStats(),
            active = deps.getActiveUnitId();
        const restoreAux = deps.captureAuxiliaryState?.(),
            counters = structuredClone(this.counters);
        const evidence = this.a19MaterialEvidence,
            savedCapture = this.captureA19Material;
        const catalog = base.shortlist,
            seedBase = base.seed;
        if (seedBase === undefined) throw new Error("Missing reference seed");
        try {
            frame = null;
            this.captureA19Material = true;
            const referenceSeed = hashSimulationParts("semantic-chance-reference-128-v1", seedBase);
            const reference = originalScore.call(
                this,
                unit,
                catalog,
                referenceSeed,
                "turns",
                REFERENCE_ROLLOUTS,
                null,
                base.horizon,
                false,
            );
            const materials = this.a19MaterialEvidence ? [...this.a19MaterialEvidence.materials] : undefined;
            this.captureA19Material = false;
            if (!materials || reference.some((value) => !Number.isFinite(value)))
                throw new Error("Reference contains an engine-rejected candidate");
            const maximum = Math.max(...reference);
            const replicates: IReplicate[] = [];
            for (let rep = 0; rep < REPLICATES; rep++)
                for (const candidateBank of BANKS) {
                    restoreDeterministicRandomState(rng);
                    deps.setActiveUnitId(active);
                    this.finishedSim = false;
                    this.finishedWinningTeam = null;
                    this.rolloutEnemyTeam = null;
                    frame = {};
                    bank = candidateBank;
                    overrideSeed = hashSimulationParts("semantic-chance-four-replicate-v1", seedBase, rep);
                    const chosen = originalChoose.call(this, unit, ...args),
                        scored = frame;
                    if (
                        !scored.shortlist ||
                        !scored.means ||
                        signature(scored.shortlist.map((c) => c.actions)) !== signature(catalog.map((c) => c.actions))
                    ) {
                        throw new Error("Counterfactual changed the frozen shortlist");
                    }
                    const selected = catalog.findIndex((c) => signature(c.actions) === signature(chosen));
                    if (selected < 0 || scored.means.some((value) => !Number.isFinite(value)))
                        throw new Error("Counterfactual has an invalid action or value");
                    const mse =
                        reference.reduce((sum, value, i) => sum + (scored.means![i] - value) ** 2, 0) /
                        reference.length;
                    const differenceMse =
                        reference
                            .slice(1)
                            .reduce(
                                (sum, value, offset) =>
                                    sum + (scored.means![offset + 1] - scored.means![0] - (value - reference[0])) ** 2,
                                0,
                            ) /
                        (reference.length - 1);
                    const bias =
                        reference.reduce((sum, value, i) => sum + scored.means![i] - value, 0) / reference.length;
                    replicates.push({
                        rep,
                        bank: candidateBank,
                        seed: overrideSeed,
                        means: [...scored.means],
                        selected,
                        mse,
                        differenceMse,
                        bias,
                        referenceValue: reference[selected],
                        regret: maximum - reference[selected],
                    });
                }
            frame = null;
            bank = "control";
            overrideSeed = null;
            const after = snapshotBattle(deps.unitsHolder, deps.grid, deps.fightProperties);
            if (digest({ ...after, unitRefs: undefined }) !== stateDigest)
                throw new Error("Chance calibration mutated live battle state");
            const banks = Object.fromEntries(
                BANKS.map((name) => {
                    const selected = replicates.filter((rep) => rep.bank === name);
                    const mean = (key: "mse" | "differenceMse" | "bias" | "referenceValue" | "regret") =>
                        selected.reduce((sum, row) => sum + row[key], 0) / selected.length;
                    return [
                        name,
                        {
                            mse: mean("mse"),
                            differenceMse: mean("differenceMse"),
                            bias: mean("bias"),
                            referenceValue: mean("referenceValue"),
                            regret: mean("regret"),
                        },
                    ];
                }),
            );
            const row = {
                schema: "hoc.a19-semantic-chance-position.v1",
                seed: task.seed,
                grid: task.grid,
                ordinal,
                eligibleOrdinal: eligible,
                unit: unit.getName(),
                lap: deps.fightProperties.getCurrentLap(),
                stateDigest,
                referenceSeed,
                referenceRollouts: REFERENCE_ROLLOUTS,
                replicateCount: REPLICATES,
                reference,
                materials,
                banks,
                replicates,
                candidates: catalog.map((candidate) => ({ kind: candidate.kind, actions: candidate.actions })),
            };
            positions++;
            appendFileSync(task.output + ".positions.jsonl", JSON.stringify(row) + "\n");
        } finally {
            restoreBattle(snap, deps.unitsHolder, deps.grid, deps.fightProperties);
            deps.restoreDamageStats(damage);
            restoreAux?.();
            restoreDeterministicRandomState(rng);
            deps.setActiveUnitId(active);
            Object.assign(this.counters, counters);
            this.a19MaterialEvidence = evidence;
            this.captureA19Material = savedCapture;
            this.finishedSim = false;
            this.finishedWinningTeam = null;
            this.rolloutEnemyTeam = null;
            frame = previous;
            bank = "control";
            overrideSeed = null;
        }
        return baseline;
    };
}

function oneGame(input: Task) {
    task = input;
    trajectory = [];
    positions = 0;
    eligible = 0;
    ordinal = 0;
    frame = null;
    bank = "control";
    overrideSeed = null;
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
        fingerprint: digest(trajectory),
        decisions: ordinal,
        eligible,
        positions,
        ms: performance.now() - start,
    };
    appendFileSync(input.output + ".trajectory.jsonl", JSON.stringify({ seed: input.seed, trajectory }) + "\n");
    appendFileSync(input.output + ".games.jsonl", JSON.stringify(row) + "\n");
    return row;
}

if (!isMainThread && workerData?.searchChanceDiagnostic === true) {
    installDiagnostic();
    startPersistentWorker<Task, ReturnType<typeof oneGame>>(oneGame);
} else if (import.meta.main) {
    const [gamesArg = "64", seedArg = "14430000", workersArg = "12", outArg = "sim-out/search-chance/diagnostic"] =
        process.argv.slice(2);
    const games = Number(gamesArg),
        seed = Number(seedArg),
        workers = Number(workersArg),
        output = resolve(outArg);
    if (
        ![games, seed, workers].every(Number.isSafeInteger) ||
        games < 1 ||
        workers < 1 ||
        seed < 0 ||
        seed + games > 0x100000000
    ) {
        throw new Error("Expected positive game/worker counts and a uint32 seed range");
    }
    const suffixes = [".positions.jsonl", ".games.jsonl", ".trajectory.jsonl", ".summary.json"];
    if (suffixes.some((suffix) => existsSync(output + suffix))) throw new Error("Choose a fresh output prefix");
    mkdirSync(dirname(output), { recursive: true });
    for (const suffix of suffixes.slice(0, -1)) writeFileSync(output + suffix, "", { flag: "wx" });
    const pool = new PersistentWorkerPool<Task, ReturnType<typeof oneGame>>({
        concurrency: Math.min(workers, games),
        workerUrl: new URL(import.meta.url),
        workerOptions: { workerData: { searchChanceDiagnostic: true } },
    });
    const start = Date.now();
    try {
        const results = await pool.runBatch(
            Array.from({ length: games }, (_, index) => ({
                seed: seed + index,
                grid: [1, 3, 4, 2][index % 4],
                output,
            })),
            ({ completed, total }) =>
                console.log(JSON.stringify({ completed, total, seconds: (Date.now() - start) / 1000 })),
        );
        const summary = {
            schema: "hoc.a19-semantic-chance-diagnostic.v1",
            seed,
            banks: BANKS,
            referenceRollouts: REFERENCE_ROLLOUTS,
            replicates: REPLICATES,
            games: results,
            sourceCommit: process.env.SEARCH_CHANCE_SOURCE_COMMIT ?? null,
            diagnosticSha256: createHash("sha256")
                .update(readFileSync(new URL(import.meta.url)))
                .digest("hex"),
            samplerSha256: createHash("sha256")
                .update(readFileSync(new URL("./search_chance_sampling.ts", import.meta.url)))
                .digest("hex"),
            disabled: process.env.SEARCH_CHANCE_DIAGNOSTIC_DISABLED === "1",
            seconds: (Date.now() - start) / 1000,
        };
        writeFileSync(output + ".summary.json", JSON.stringify(summary, null, 2) + "\n");
    } finally {
        await pool.close();
    }
}
