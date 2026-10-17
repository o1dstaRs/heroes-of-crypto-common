/* Offline model selection only. Imports never patch the live driver. */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isMainThread, workerData } from "node:worker_threads";
import type { IDecisionContext } from "../ai/ai_strategy";
import type { IEnumeratedCandidate } from "../ai/candidates";
import type { GameAction } from "../engine/actions";
import type { TeamType } from "../generated/protobuf/v1/types_gen";
import type { Unit } from "../units/unit";
import { captureDeterministicRandomState, restoreDeterministicRandomState } from "../utils/lib";
import { buildRoster, hashSimulationParts, makeRng } from "./army";
import { GREEN_TEAM, RED_TEAM, runMatch } from "./battle_engine";
import { restoreBattle, snapshotBattle } from "./battle_snapshot";
import { liveTwinSetup } from "./livetwin";
import type { ILookaheadDeps } from "./lookahead";
import { PersistentWorkerPool, startPersistentWorker } from "./persistent_worker_pool";
import { SearchDriver } from "./search_driver";
import {
    predictReplyResidual,
    replyResidualFeatures,
    selectReplyResidualSwitch,
    validateReplyResidualModel,
    type IReplyResidualModel,
} from "./search_reply_residual";

interface IProbe {
    policy: string;
    means: number[];
    materials: number[];
    samples: number[][];
    selected: number;
}
interface IPosition {
    seed: number;
    grid: number;
    ordinal: number;
    stateDigest: string;
    features: number[][];
    catalog: { kind: string; actions: GameAction[] }[];
    probes: IProbe[];
}
interface IDriver {
    chooseDecision(unit: Unit, version: string, incumbent: GameAction[], context?: IDecisionContext): GameAction[];
    scoreCandidates(
        unit: Unit,
        candidates: readonly IEnumeratedCandidate[],
        seed: number,
        mode: string,
        rollouts?: number,
        deadline?: number | null,
        horizon?: number,
        ...options: unknown[]
    ): number[];
    deps: ILookaheadDeps;
    counters: Record<string, unknown>;
    captureA19Material: boolean;
    a19MaterialEvidence?: {
        unitId: string;
        candidates: readonly IEnumeratedCandidate[];
        means: number[];
        materials: number[];
        rolloutCount: number;
    };
    finishedSim: boolean;
    finishedWinningTeam: TeamType | null;
    rolloutEnemyTeam: TeamType | null;
}
interface IVariant {
    id: string;
    file: string;
    model: IReplyResidualModel;
    minimumSwitchGain?: number;
}
type Task = { seed: number; grid: number; output: string };
const digest = (value: unknown) =>
    createHash("sha256")
        .update(JSON.stringify(value, (_, v) => (v instanceof Map ? [...v] : v instanceof Set ? [...v] : v)))
        .digest("hex");
const signature = (value: unknown) => JSON.stringify(value);
const p = SearchDriver.prototype as unknown as IDriver;
const originalChoose = p.chooseDecision,
    originalScore = p.scoreCandidates;
let inputRows = new Map<number, Map<number, IPosition>>(),
    variants: IVariant[] = [];
let task: Task,
    ordinal = 0,
    trajectory: unknown[] = [];
let active: {
    owner: IDriver;
    row: IPosition;
    variant: IVariant;
    context: IDecisionContext;
    used: boolean;
    corrected?: number[];
    leafScores: Map<string, number>;
} | null = null;

function install(): void {
    p.scoreCandidates = function (this: IDriver, ...args: Parameters<IDriver["scoreCandidates"]>) {
        const scope = active;
        if (!scope || scope.owner !== this) return originalScore.apply(this, args);
        if (args[3] !== "turns") {
            const values = originalScore.apply(this, args);
            if (args[3] === "leaf")
                args[1].forEach((c, i) => {
                    if (Number.isFinite(values[i])) scope.leafScores.set(signature(c.actions), values[i]);
                });
            return values;
        }
        if (signature(args[1].map((c) => c.actions)) !== signature(scope.row.catalog.map((c) => c.actions)))
            throw new Error("Replay changed the original shortlist");
        const native = scope.row.probes.find((x) => x.policy === "native-four");
        if (!native) throw new Error("Replay has no complete native R4 evidence");
        const features = replyResidualFeatures(args[0], scope.context, args[1], {
            ...native,
            leafScores: scope.leafScores,
        });
        if (signature(features) !== signature(scope.row.features))
            throw new Error("Replay root features differ from collection");
        const means = predictReplyResidual(scope.variant.model, features, native.means);
        this.a19MaterialEvidence = {
            unitId: args[0].getId(),
            candidates: args[1],
            means,
            materials: [...native.materials],
            rolloutCount: 4,
        };
        scope.used = true;
        scope.corrected = means;
        return means;
    };
    p.chooseDecision = function (this: IDriver, ...args: Parameters<IDriver["chooseDecision"]>) {
        const chosen = originalChoose.apply(this, args),
            unit = args[0],
            deps = this.deps;
        ordinal++;
        trajectory.push(
            structuredClone({
                unit: unit.getId(),
                team: unit.getTeam(),
                lap: deps.fightProperties.getCurrentLap(),
                actions: chosen,
            }),
        );
        const row = inputRows.get(task.seed)?.get(ordinal);
        if (!row) return chosen;
        if (!args[3]) throw new Error("Replay requires the real root context");
        const snap = snapshotBattle(deps.unitsHolder, deps.grid, deps.fightProperties);
        const stateDigest = digest({ ...snap, unitRefs: undefined });
        if (stateDigest !== row.stateDigest) throw new Error("Replay root state differs from the dataset");
        const native = row.probes.find((x) => x.policy === "native-four"),
            teacher = row.probes.find((x) => x.policy === "search-two");
        if (!native || !teacher || signature(row.catalog[native.selected].actions) !== signature(chosen))
            throw new Error("Replay baseline final action differs from collection");
        const rng = captureDeterministicRandomState(),
            stats = deps.captureDamageStats(),
            activeId = deps.getActiveUnitId();
        const restoreAux = deps.captureAuxiliaryState?.(),
            counters = structuredClone(this.counters);
        const evidence = this.a19MaterialEvidence,
            capture = this.captureA19Material;
        const nativeDifferenceMse =
            teacher.means
                .slice(1)
                .reduce((sum, q, i) => sum + (native.means[i + 1] - native.means[0] - (q - teacher.means[0])) ** 2, 0) /
            (teacher.means.length - 1);
        try {
            for (const variant of variants) {
                active = { owner: this, row, variant, context: args[3], used: false, leafScores: new Map() };
                const result = originalChoose.apply(this, args),
                    scope = active;
                if (!scope.used || !scope.corrected)
                    throw new Error("Replay did not reach the intended scored selector");
                const proposedSelected = row.catalog.findIndex((c) => signature(c.actions) === signature(result));
                const selected = selectReplyResidualSwitch(
                    proposedSelected,
                    native.selected,
                    scope.corrected,
                    variant.minimumSwitchGain,
                );
                const differenceMse =
                    teacher.means
                        .slice(1)
                        .reduce(
                            (sum, q, i) =>
                                sum + (scope.corrected![i + 1] - scope.corrected![0] - (q - teacher.means[0])) ** 2,
                            0,
                        ) /
                    (teacher.means.length - 1);
                appendFileSync(
                    task.output + ".predictions.jsonl",
                    JSON.stringify({
                        seed: task.seed,
                        grid: task.grid,
                        ordinal,
                        variant: variant.id,
                        selected,
                        proposedSelected,
                        abstained: selected !== proposedSelected,
                        nativeSelected: native.selected,
                        nativeDifferenceMse,
                        differenceMse,
                        nativeReferenceValue: teacher.means[native.selected],
                        selectedReferenceValue: selected < 0 ? null : teacher.means[selected],
                        gain: selected < 0 ? null : teacher.means[selected] - teacher.means[native.selected],
                        correctedMeans: scope.corrected,
                        stateDigest,
                    }) + "\n",
                );
                if (
                    digest({
                        ...snapshotBattle(deps.unitsHolder, deps.grid, deps.fightProperties),
                        unitRefs: undefined,
                    }) !== stateDigest
                )
                    throw new Error("Replay leaked speculative battle state");
            }
        } finally {
            active = null;
            restoreBattle(snap, deps.unitsHolder, deps.grid, deps.fightProperties);
            deps.restoreDamageStats(stats);
            restoreAux?.();
            restoreDeterministicRandomState(rng);
            deps.setActiveUnitId(activeId);
            Object.assign(this.counters, counters);
            this.a19MaterialEvidence = evidence;
            this.captureA19Material = capture;
            this.finishedSim = false;
            this.finishedWinningTeam = null;
            this.rolloutEnemyTeam = null;
        }
        return chosen;
    };
}
function oneGame(input: Task) {
    task = input;
    ordinal = 0;
    trajectory = [];
    active = null;
    const rng = makeRng(hashSimulationParts("a19-intellect-roster-v1", input.seed));
    const roster = buildRoster(rng, undefined, undefined, undefined, "expBudget");
    const redRoster = buildRoster(rng, undefined, undefined, undefined, "expBudget"),
        setup = liveTwinSetup();
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
        fingerprint: digest(trajectory),
        ms: performance.now() - start,
    };
    appendFileSync(input.output + ".games.jsonl", JSON.stringify(row) + "\n");
    return row;
}
function loadInputs(dataset: string, manifest: string): void {
    inputRows = new Map();
    for (const line of readFileSync(dataset + ".positions.jsonl", "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)) {
        const row = JSON.parse(line) as IPosition;
        let byOrdinal = inputRows.get(row.seed);
        if (!byOrdinal) inputRows.set(row.seed, (byOrdinal = new Map()));
        if (byOrdinal.has(row.ordinal)) throw new Error("Duplicate dataset root");
        byOrdinal.set(row.ordinal, row);
    }
    const list = JSON.parse(readFileSync(manifest, "utf8")) as {
        variants: { id: string; file: string; minimumSwitchGain?: number }[];
    };
    const summary = JSON.parse(readFileSync(dataset + ".summary.json", "utf8")) as { sourceCommit: string };
    variants = list.variants.map((item) => {
        const model = JSON.parse(readFileSync(resolve(dirname(manifest), item.file), "utf8")) as IReplyResidualModel;
        validateReplyResidualModel(model);
        if (model.sourceCommit !== summary.sourceCommit) throw new Error("Model and dataset source differ");
        if (
            item.minimumSwitchGain !== undefined &&
            (!Number.isFinite(item.minimumSwitchGain) || item.minimumSwitchGain < 0 || item.minimumSwitchGain > 1)
        )
            throw new Error("Invalid reply residual minimum switch gain");
        return { ...item, model };
    });
    if (!variants.length || new Set(variants.map((x) => x.id)).size !== variants.length)
        throw new Error("Invalid variant manifest");
}
if (!isMainThread && workerData?.replyResidualReplay === true) {
    loadInputs(workerData.dataset, workerData.manifest);
    install();
    startPersistentWorker<Task, ReturnType<typeof oneGame>>(oneGame);
} else if (import.meta.main) {
    const [
        datasetArg,
        manifestArg,
        gamesArg = "64",
        seedArg = "14450128",
        workersArg = "12",
        outputArg = "sim-out/reply-residual-replay/validation",
    ] = process.argv.slice(2);
    if (!datasetArg || !manifestArg) throw new Error("Expected dataset prefix and model-variant manifest");
    const dataset = resolve(datasetArg),
        manifest = resolve(manifestArg),
        output = resolve(outputArg);
    const games = Number(gamesArg),
        seed = Number(seedArg),
        workers = Number(workersArg);
    if (
        ![games, seed, workers].every(Number.isSafeInteger) ||
        games < 1 ||
        workers < 1 ||
        seed < 0 ||
        seed + games > 2 ** 32
    )
        throw new Error("Invalid numeric arguments");
    const source = JSON.parse(readFileSync(dataset + ".summary.json", "utf8")) as {
        sourceCommit: string;
        games: { seed: number; grid: number }[];
    };
    const grids = new Map(source.games.map((x) => [x.seed, x.grid]));
    const tasks = Array.from({ length: games }, (_, i) => ({ seed: seed + i, grid: grids.get(seed + i), output }));
    if (tasks.some((x) => x.grid === undefined)) throw new Error("Replay seed is outside the dataset");
    for (const suffix of [".predictions.jsonl", ".games.jsonl", ".summary.json"])
        if (existsSync(output + suffix)) throw new Error("Choose a fresh replay output prefix");
    mkdirSync(dirname(output), { recursive: true });
    for (const suffix of [".predictions.jsonl", ".games.jsonl"]) writeFileSync(output + suffix, "", { flag: "wx" });
    const pool = new PersistentWorkerPool<Task, ReturnType<typeof oneGame>>({
        concurrency: Math.min(workers, games),
        workerUrl: new URL(import.meta.url),
        workerOptions: { workerData: { replyResidualReplay: true, dataset, manifest } },
    });
    const start = Date.now();
    try {
        const results = await pool.runBatch(tasks as Task[], ({ completed, total }) =>
            console.log(JSON.stringify({ completed, total, seconds: (Date.now() - start) / 1000 })),
        );
        writeFileSync(
            output + ".summary.json",
            JSON.stringify(
                {
                    sourceCommit: source.sourceCommit,
                    games: results,
                    replaySha256: createHash("sha256")
                        .update(readFileSync(new URL(import.meta.url)))
                        .digest("hex"),
                    modelManifestSha256: createHash("sha256").update(readFileSync(manifest)).digest("hex"),
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
