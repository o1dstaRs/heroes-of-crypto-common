import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { isMainThread, workerData } from "node:worker_threads";
import { buildRoster, makeRng, hashSimulationParts } from "./army";
import { runMatch, GREEN_TEAM, RED_TEAM } from "./battle_engine";
import type { IEnumeratedCandidate } from "../ai/candidates";
import type { IDecisionContext } from "../ai/ai_strategy";
import type { GameAction } from "../engine/actions";
import type { Unit } from "../units/unit";
import type { TeamType } from "../generated/protobuf/v1/types_gen";
import type { ILookaheadDeps } from "./lookahead";
import { SearchDriver } from "./search_driver";
import { snapshotBattle, restoreBattle } from "./battle_snapshot";
import { captureDeterministicRandomState, restoreDeterministicRandomState } from "../utils/lib";
import { liveTwinSetup } from "./livetwin";
import { PersistentWorkerPool, startPersistentWorker } from "./persistent_worker_pool";

/**
 * Offline shortlist coverage diagnostic. Run from the common package:
 * bun src/simulation/measure_search_shortlist.ts [games=64] [seed=14320000] [workers=12] [output]
 * Writes position evidence, live decision trajectories, game results and a summary outside Git.
 * A wider reference and an independent eight-sample bank are diagnostic estimates; fresh strength
 * matches are still required before changing the production shortlist.
 */

// Offline, observational diagnostic. The live trajectory always uses the qualified baseline.
// The wide reference uses the same legal catalog, horizon, four chance seeds and final selection rules.
// A separately seeded eight-sample comparison is evaluated AFTER wide discovery; it never changes play.
interface IMaterialEvidence {
    unitId: string;
    candidates: readonly IEnumeratedCandidate[];
    means: number[];
    materials: number[];
    rolloutCount: number;
}
// Narrow private-field view: instrumentation exists only inside this diagnostic worker.
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
        mode: "leaf" | "turns" | "reply" | "lap",
        rollouts?: number,
        deadline?: number | null,
        horizon?: number,
        ...options: unknown[]
    ): number[];
    deps: ILookaheadDeps;
    counters: Record<string, unknown>;
    a19MaterialEvidence?: IMaterialEvidence;
    certifiedSelectionBounds: boolean;
    captureA19Material: boolean;
    finishedSim: boolean;
    finishedWinningTeam: TeamType | null;
    rolloutEnemyTeam: TeamType | null;
}
interface IValidation {
    seed: number;
    rollouts: number;
    means: number[];
    materials: number[];
    gain: number;
}
const p = SearchDriver.prototype as unknown as IResearchDriver;
const originalChoose = p.chooseDecision,
    originalShortlist = p.shortlistCandidates;
const originalScore = p.scoreCandidates;
const signature = (actions: unknown) => JSON.stringify(actions);
const digest = (value: unknown) =>
    createHash("sha256")
        .update(JSON.stringify(value, (_, v) => (v instanceof Map ? [...v] : v instanceof Set ? [...v] : v)))
        .digest("hex");
type Frame = {
    full?: IEnumeratedCandidate[];
    shortlist?: IEnumeratedCandidate[];
    leaves?: number[];
    means?: number[];
    materials?: number[];
    seedBase?: number;
    horizon?: number;
    rolloutCount?: number;
};
let frame: Frame | null = null,
    wide = false,
    eligible = 0,
    ordinal = 0;
let task: Task,
    positions = 0,
    trajectory: unknown[] = [];
const sampleOrdinals = [6, 18, 36, 60, 90, 135];

function installDiagnostic(): void {
    p.shortlistCandidates = function (
        this: IResearchDriver,
        ...args: Parameters<IResearchDriver["shortlistCandidates"]>
    ) {
        if (wide) {
            if (frame) frame.full = [...args[1]];
            return args[1];
        }
        const selected = originalShortlist.apply(this, args);
        if (frame) {
            frame.full = [...args[1]];
            frame.shortlist = [...selected];
        }
        return selected;
    };
    p.scoreCandidates = function (this: IResearchDriver, ...args: Parameters<IResearchDriver["scoreCandidates"]>) {
        const result = originalScore.apply(this, args);
        if (frame) {
            if (args[3] === "leaf") frame.leaves = [...result];
            else if (args[3] === "turns") {
                frame.means = [...result];
                frame.seedBase = args[2];
                frame.horizon = args[6];
                frame.rolloutCount = args[4];
                frame.materials = this.a19MaterialEvidence?.materials
                    ? [...this.a19MaterialEvidence.materials]
                    : undefined;
            }
        }
        return result;
    };
    p.chooseDecision = function (
        this: IResearchDriver,
        unit: Unit,
        ...args: [string, GameAction[], IDecisionContext?]
    ) {
        const previous = frame;
        frame = {};
        const baseline = originalChoose.call(this, unit, ...args),
            captured = frame;
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
        if (
            !captured.full ||
            !captured.shortlist ||
            !captured.means ||
            captured.full.length <= captured.shortlist.length
        )
            return baseline;
        eligible++;
        if (process.env.A19_DIAGNOSTIC_DISABLED === "1" || !sampleOrdinals.includes(eligible)) return baseline;

        const deps = this.deps;
        const snap = snapshotBattle(deps.unitsHolder, deps.grid, deps.fightProperties);
        const frozen = { ...snap, unitRefs: undefined };
        const stateDigest = digest(frozen);
        const rng = captureDeterministicRandomState(),
            stats = deps.captureDamageStats(),
            active = deps.getActiveUnitId();
        const restoreAuxiliaryState = deps.captureAuxiliaryState?.();
        const counters = structuredClone(this.counters),
            evidence = this.a19MaterialEvidence;
        const savedBounds = this.certifiedSelectionBounds;
        const start = performance.now();
        try {
            wide = true;
            frame = {};
            this.certifiedSelectionBounds = false;
            const chosen = originalChoose.call(this, unit, ...args),
                teacher = frame;
            frame = null;
            wide = false;
            if (!teacher.full || !teacher.means || teacher.means.length !== teacher.full.length)
                throw new Error("Incomplete wide reference");
            const catalog = teacher.full;
            const baselineIndex = catalog.findIndex((c) => signature(c.actions) === signature(baseline));
            const wideIndex = catalog.findIndex((c) => signature(c.actions) === signature(chosen));
            const shortlistIndices = captured.shortlist.map((c) =>
                catalog.findIndex((w) => signature(c.actions) === signature(w.actions)),
            );
            if (baselineIndex < 0 || wideIndex < 0 || shortlistIndices.includes(-1))
                throw new Error("Catalog changed during counterfactual replay");
            const shortlistSet = new Set(shortlistIndices);
            const finite = catalog.map((_, i) => i).filter((i) => Number.isFinite(teacher.means![i]));
            if (!finite.length) throw new Error("Wide reference has no legal scored candidate");
            const best = finite.reduce((a, b) => (teacher.means![b] > teacher.means![a] ? b : a), finite[0]);
            const bestShort = shortlistIndices
                .filter((i) => Number.isFinite(teacher.means![i]))
                .reduce((a, b) => (teacher.means![b] > teacher.means![a] ? b : a));
            let validation: IValidation | null = null;
            if (baselineIndex !== wideIndex) {
                this.captureA19Material = true;
                const validationSeed = hashSimulationParts("a19-shortlist-validation-v1", teacher.seedBase!);
                const means = originalScore.call(
                    this,
                    unit,
                    [catalog[baselineIndex], catalog[wideIndex]],
                    validationSeed,
                    "turns",
                    8,
                    null,
                    teacher.horizon,
                    false,
                );
                validation = {
                    seed: validationSeed,
                    rollouts: 8,
                    means,
                    materials: [...this.a19MaterialEvidence!.materials],
                    gain: means[1] - means[0],
                };
                this.captureA19Material = false;
            }
            const after = snapshotBattle(deps.unitsHolder, deps.grid, deps.fightProperties);
            if (digest({ ...after, unitRefs: undefined }) !== stateDigest)
                throw new Error("Counterfactual mutated live battle state");
            const name = (id: string | undefined) =>
                id ? deps.unitsHolder.getAllUnits().get(id)?.getName() : undefined;
            const row = {
                schema: "hoc.a19-shortlist-position.v1",
                seed: task.seed,
                grid: task.grid,
                ordinal,
                eligibleOrdinal: eligible,
                lap: deps.fightProperties.getCurrentLap(),
                unit: unit.getName(),
                team: unit.getTeam(),
                stateDigest,
                seedBase: teacher.seedBase,
                horizon: teacher.horizon,
                rollouts: teacher.rolloutCount,
                baselineIndex,
                wideIndex,
                bestIndex: best,
                bestShortlistIndex: bestShort,
                shortlisted: shortlistIndices,
                candidateCount: catalog.length,
                shortlistCount: shortlistIndices.length,
                rawCoverageGap: teacher.means[best] - teacher.means[bestShort],
                selectedGain: teacher.means[wideIndex] - teacher.means[baselineIndex],
                wideOutsideShortlist: !shortlistSet.has(wideIndex),
                validation,
                ms: performance.now() - start,
                candidates: catalog.map((c, i) => ({
                    index: i,
                    kind: c.kind,
                    target: name(c.targetId),
                    targetId: c.targetId,
                    pressureTargetId: c.pressureTargetId,
                    spellName: c.spellName,
                    targetCell: c.targetCell,
                    standCell: c.standCell,
                    actions: c.actions,
                    features: c.features,
                    leaf: captured.leaves?.[i] ?? null,
                    mean: teacher.means![i],
                    material: teacher.materials?.[i] ?? null,
                })),
            };
            positions++;
            appendFileSync(task.output + ".positions.jsonl", JSON.stringify(row) + "\n");
            appendFileSync(
                task.output + ".states.jsonl",
                JSON.stringify({ seed: task.seed, ordinal, stateDigest, state: frozen }, (_, value) =>
                    value instanceof Map ? [...value] : value instanceof Set ? [...value] : value,
                ) + "\n",
            );
        } finally {
            restoreBattle(snap, deps.unitsHolder, deps.grid, deps.fightProperties);
            deps.restoreDamageStats(stats);
            restoreAuxiliaryState?.();
            restoreDeterministicRandomState(rng);
            deps.setActiveUnitId(active);
            Object.assign(this.counters, counters);
            this.a19MaterialEvidence = evidence;
            this.captureA19Material = false;
            this.certifiedSelectionBounds = savedBounds;
            this.finishedSim = false;
            this.finishedWinningTeam = null;
            this.rolloutEnemyTeam = null;
            wide = false;
            frame = previous;
        }
        return baseline;
    };
}

type Task = { seed: number; grid: number; output: string };
function oneGame(t: Task) {
    task = t;
    positions = 0;
    trajectory = [];
    eligible = 0;
    ordinal = 0;
    wide = false;
    frame = null;
    const rng = makeRng(hashSimulationParts("a19-intellect-roster-v1", t.seed));
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
        seed: t.seed,
        gridType: t.grid,
        searchOfflineDeterministicWork: true,
        searchEnvOverrideTeams: [GREEN_TEAM, RED_TEAM],
        headlessEvents: true,
        greenDoctrine: setup.doctrine,
        redDoctrine: setup.doctrine,
        greenAugments: setup.augments,
        redAugments: setup.augments,
    });
    const row = {
        ...t,
        winner: result.winner,
        endReason: result.endReason,
        laps: result.laps,
        rootDecisions: trajectory.length,
        rejected: (result.rejectedGreen ?? 0) + (result.rejectedRed ?? 0),
        fingerprint: digest(trajectory),
        decisions: ordinal,
        eligible,
        positions,
        ms: performance.now() - start,
    };
    appendFileSync(t.output + ".trajectory.jsonl", JSON.stringify({ seed: t.seed, trajectory }) + "\n");
    appendFileSync(t.output + ".games.jsonl", JSON.stringify(row) + "\n");
    return row;
}
if (!isMainThread && workerData?.a19Shortlist) {
    installDiagnostic();
    startPersistentWorker<Task, ReturnType<typeof oneGame>>(oneGame);
} else if (import.meta.main) {
    const [gamesArg = "64", seedArg = "14320000", workersArg = "12", outArg = "sim-out/search-shortlist/diagnostic"] =
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
    )
        throw new Error("Expected positive game/worker counts and a uint32 seed range");
    const suffixes = [".positions.jsonl", ".games.jsonl", ".trajectory.jsonl", ".states.jsonl", ".summary.json"];
    if (suffixes.some((suffix) => existsSync(output + suffix)))
        throw new Error("Choose a fresh diagnostic output prefix");
    mkdirSync(dirname(output), { recursive: true });
    for (const suffix of suffixes.slice(0, -1)) writeFileSync(output + suffix, "", { flag: "wx" });
    const tasks = Array.from({ length: games }, (_, i) => ({ seed: seed + i, grid: [1, 3, 4, 2][i % 4], output }));
    const pool = new PersistentWorkerPool<Task, ReturnType<typeof oneGame>>({
        concurrency: workers,
        workerUrl: new URL(import.meta.url),
        workerOptions: { workerData: { a19Shortlist: true } },
    });
    const start = Date.now();
    try {
        const games = await pool.runBatch(tasks, ({ completed, total }) =>
            console.log(JSON.stringify({ completed, total, seconds: (Date.now() - start) / 1000 })),
        );
        writeFileSync(
            output + ".summary.json",
            JSON.stringify(
                {
                    schema: "hoc.a19-shortlist-diagnostic.v1",
                    diagnosticSha256: createHash("sha256")
                        .update(readFileSync(new URL(import.meta.url)))
                        .digest("hex"),
                    seed,
                    games,
                    sampleOrdinals,
                    baselineOverrides: {
                        SEARCH_A19_MATERIAL_ARBITRATION: "ties",
                        SEARCH_A19_CERTIFIED_SELECTION_BOUNDS: "1",
                        SEARCH_A19_ROLLOUT_ALLOCATION: "uniform",
                    },
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
