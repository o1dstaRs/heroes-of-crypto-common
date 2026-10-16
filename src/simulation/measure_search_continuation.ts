/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isMainThread, workerData } from "node:worker_threads";
import type { IDecisionContext } from "../ai/ai_strategy";
import { enumerateCandidates, type IEnumeratedCandidate } from "../ai/candidates";
import { createDecisionPathCatalog } from "../ai/decision_path_catalog";
import { throughShotLineEnabled } from "../ai/through_shot_line";
import { V08_A19_SEARCH } from "../ai/versions/v0_8_a19_profile";
import { v09CandidateSignature } from "../ai/versions/v0_9";
import { V09_INPUT_FEATURE_NAMES, v09CandidateFeatureVector } from "../ai/versions/v0_9_features";
import spells from "../configuration/spells.json";
import type { GameAction } from "../engine/actions";
import type { Unit } from "../units/unit";
import { captureDeterministicRandomState, restoreDeterministicRandomState } from "../utils/lib";
import { buildRoster, hashSimulationParts, makeRng } from "./army";
import { GREEN_TEAM, RED_TEAM, runMatch } from "./battle_engine";
import { liveTwinSetup } from "./livetwin";
import type { ILookaheadDeps } from "./lookahead";
import { PersistentWorkerPool, startPersistentWorker } from "./persistent_worker_pool";
import { SearchDriver } from "./search_driver";

/**
 * Observational A19 continuation-policy corpus. Labels are the FINAL returned actions, after all outer
 * arbitration. The inner scored-decision observer is intentionally not used: its selectedIndex precedes
 * material arbitration. No second search or counterfactual branch is run, and the live choice is preserved.
 *
 * bun src/simulation/measure_search_continuation.ts [games=256] [seed=14410000] [workers=12] [output]
 * A19_CONTINUATION_DISABLED=1 emits control trajectories without enumerating or extracting examples.
 * Importing this module never patches a driver; instrumentation is installed only in its own workers.
 */

const SPELL_NAMES = Object.values(spells)
    .filter((group): group is Exclude<typeof group, number> => typeof group === "object")
    .flatMap((group) => Object.keys(group))
    .sort();

export const CONTINUATION_FEATURE_NAMES: readonly string[] = Object.freeze([
    ...V09_INPUT_FEATURE_NAMES,
    "isNativeIncumbent",
    "damageRelativeToCatalog",
    "signedLogDamage",
    "targetIsAlly",
    "damageFractionOfTargetHp",
    ...SPELL_NAMES.map((name) => `spell_${name}`),
]);

/** The same RNG-free bounded action catalog is used for collection and research inference. */
export function continuationCandidates(
    unit: Unit,
    context: IDecisionContext,
    incumbent: GameAction[],
): readonly IEnumeratedCandidate[] {
    return enumerateCandidates(unit, context, incumbent, {
        maxMoveDestinations: V08_A19_SEARCH.maxMoves,
        maxMeleePairs: V08_A19_SEARCH.maxMelee,
        maxShotAims: V08_A19_SEARCH.maxShots,
        maxAreaThrowCells: V08_A19_SEARCH.maxThrows,
        includeMountainAttacks: true,
        includeArtifactBarrelAttackCoverage: true,
        enrichIncumbentMetadata: true,
        throughShotFreeAim: throughShotLineEnabled(unit),
    }).candidates;
}

/** Public pre-decision features only; no rollout means, chosen index, identifiers, or game outcome. */
export function continuationFeatures(
    unit: Unit,
    context: IDecisionContext,
    candidates: readonly IEnumeratedCandidate[],
): number[][] {
    const maxDamage = Math.max(1, ...candidates.map((candidate) => Math.abs(candidate.features.expectedDamage)));
    return candidates.map((candidate, index) => {
        const spell = candidate.actions.find((action) => action.type === "cast_spell");
        const targetAction = candidate.actions.find(
            (action) =>
                action.type === "melee_attack" || action.type === "range_attack" || action.type === "cast_spell",
        );
        const targetId = targetAction && "targetId" in targetAction ? targetAction.targetId : candidate.targetId;
        const target = targetId ? context.unitsHolder.getAllUnits().get(targetId) : undefined;
        const damage = candidate.features.expectedDamage;
        const vector = [
            ...v09CandidateFeatureVector(candidate, unit, context, candidates),
            index === 0 ? 1 : 0,
            damage / maxDamage,
            Math.sign(damage) * Math.log1p(Math.abs(damage)),
            target?.getTeam() === unit.getTeam() ? 1 : 0,
            target ? Math.max(-2, Math.min(2, damage / Math.max(1, target.getCumulativeHp()))) : 0,
            ...SPELL_NAMES.map((name) => (spell?.spellName === name ? 1 : 0)),
        ];
        if (vector.length !== CONTINUATION_FEATURE_NAMES.length || vector.some((value) => !Number.isFinite(value))) {
            throw new Error("Invalid continuation feature vector");
        }
        return vector;
    });
}

interface IResearchDriver {
    chooseDecision(unit: Unit, version: string, incumbent: GameAction[], context?: IDecisionContext): GameAction[];
    deps: ILookaheadDeps;
}
type Task = { seed: number; grid: number; output: string };
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const prototype = SearchDriver.prototype as unknown as IResearchDriver;
const originalChoose = prototype.chooseDecision;
let task: Task;
let trajectory: unknown[] = [];
let examples: unknown[] = [];
let absentLabels = 0;
let featureMs = 0;

function installCollector(): void {
    prototype.chooseDecision = function (this: IResearchDriver, unit, version, incumbent, rootContext) {
        const chosen = originalChoose.call(this, unit, version, incumbent, rootContext);
        const ordinal = trajectory.length;
        trajectory.push({ unit: unit.getId(), team: unit.getTeam(), actions: structuredClone(chosen) });
        if (process.env.A19_CONTINUATION_DISABLED === "1") return chosen;
        const randomState = captureDeterministicRandomState();
        const startedAt = performance.now();
        try {
            const deps = this.deps;
            const matrix = deps.grid.getMatrix();
            const context: IDecisionContext = {
                grid: deps.grid,
                matrix,
                unitsHolder: deps.unitsHolder,
                pathHelper: deps.pathHelper,
                decisionPathCatalog: createDecisionPathCatalog(deps.grid, deps.pathHelper, unit, matrix),
                attackHandler: deps.attackHandler,
                fightProperties: deps.fightProperties,
                decisionOrigin: "root",
            };
            const candidates = continuationCandidates(unit, context, incumbent);
            const signature = v09CandidateSignature(chosen);
            const signatures = candidates.map((candidate) => v09CandidateSignature(candidate.actions));
            const teacher = signatures.indexOf(signature);
            if (teacher === -1) {
                absentLabels++;
            }
            examples.push({
                schema: "hoc.a19-continuation-decision.v1",
                seed: task.seed,
                grid: task.grid,
                ordinal,
                lap: deps.fightProperties.getCurrentLap(),
                actor: unit.getName(),
                team: unit.getTeam(),
                teacher,
                teacherSignature: signature,
                signatures,
                features: continuationFeatures(unit, context, candidates),
                families: candidates.map((candidate) => candidate.kind),
            });
        } finally {
            restoreDeterministicRandomState(randomState);
            featureMs += performance.now() - startedAt;
        }
        return chosen;
    };
}

function oneGame(input: Task) {
    task = input;
    trajectory = [];
    examples = [];
    absentLabels = 0;
    featureMs = 0;
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
        decisions: trajectory.length,
        examples: examples.length,
        absentLabels,
        featureMs,
        ms: performance.now() - start,
    };
    if (examples.length) {
        appendFileSync(
            input.output + ".decisions.jsonl",
            examples.map((example) => JSON.stringify(example)).join("\n") + "\n",
        );
    }
    appendFileSync(input.output + ".trajectories.jsonl", JSON.stringify({ seed: input.seed, trajectory }) + "\n");
    appendFileSync(input.output + ".games.jsonl", JSON.stringify(row) + "\n");
    return row;
}

if (!isMainThread && workerData?.a19ContinuationCollector) {
    installCollector();
    startPersistentWorker<Task, ReturnType<typeof oneGame>>(oneGame);
} else if (import.meta.main) {
    const [gamesArg = "256", seedArg = "14410000", workersArg = "12", outArg = "sim-out/search-continuation/corpus"] =
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
    const suffixes = [".decisions.jsonl", ".trajectories.jsonl", ".games.jsonl", ".summary.json"];
    if (suffixes.some((suffix) => existsSync(output + suffix))) throw new Error("Choose a fresh output prefix");
    mkdirSync(dirname(output), { recursive: true });
    for (const suffix of suffixes.slice(0, -1)) writeFileSync(output + suffix, "", { flag: "wx" });
    const pool = new PersistentWorkerPool<Task, ReturnType<typeof oneGame>>({
        concurrency: workers,
        workerUrl: new URL(import.meta.url),
        workerOptions: { workerData: { a19ContinuationCollector: true } },
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
            schema: "hoc.a19-continuation-corpus.v1",
            collectorSha256: createHash("sha256")
                .update(readFileSync(new URL(import.meta.url)))
                .digest("hex"),
            featureNames: CONTINUATION_FEATURE_NAMES,
            featureNamesSha256: digest(CONTINUATION_FEATURE_NAMES),
            disabled: process.env.A19_CONTINUATION_DISABLED === "1",
            seed,
            games: results,
            seconds: (Date.now() - start) / 1000,
        };
        writeFileSync(output + ".summary.json", JSON.stringify(summary, null, 2) + "\n");
    } finally {
        await pool.close();
    }
}
