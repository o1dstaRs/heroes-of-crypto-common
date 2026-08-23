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

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

import { MULTICOHORT_WAIT_WEIGHTS_V2_2026_07_11 } from "../ai/versions/wait_scorer";
import { FightStateManager } from "../fights/fight_state_manager";
import { PBTypes } from "../generated/protobuf/v1/types";
import {
    buildArchetypeRoster,
    buildSharedArchetypeOffers,
    setupForArchetype,
    type ArchetypeName,
} from "./archetype_payoff";
import { creaturesByLevel, DEFAULT_AMOUNT_BY_LEVEL, makeRng, resolveStackAmount, type IArmyUnitSpec } from "./army";
import { runMatch, type IMatchResult } from "./battle_engine";
import { playGame, type IGameRecord, type ITournamentOptions } from "./tournament";
import { readRevisionProvenance, type IRevisionProvenance } from "./v0_7_acceptance";

export const WAIT_V2_POWERED_MANIFEST_PATH = fileURLToPath(
    new URL("./manifests/v0_7_wait_v2_powered_20260715.json", import.meta.url),
);
export const WAIT_V2_PAIR_SEED_STEP = 0x9e3779b1;
export const WAIT_V2_WEIGHT_JSON = JSON.stringify(MULTICOHORT_WAIT_WEIGHTS_V2_2026_07_11);

export type WaitV2Arm = "control" | "v2";
export type WaitV2MirrorCohort = "melee_coevo" | "hybrid" | "ranged_max_sniper3" | "pure_ranged";

export interface IWaitV2Cell {
    id: string;
    kind: "mirror" | "draft";
    cohort: WaitV2MirrorCohort | "melee" | "mixed" | "random";
    baseSeed: number;
    primaryPool: boolean;
    meleeDraftFraction?: number;
}

export interface IWaitV2ProtocolManifest {
    schemaVersion: 1;
    manifestId: string;
    createdAt: string;
    candidate: "v0.7";
    opponent: "v0.6";
    gamesPerArm: number;
    arms: Record<WaitV2Arm, string>;
    v2WeightsSha256: string;
    cells: IWaitV2Cell[];
    scoring: string;
    pairing: string;
    gates: {
        pooledPrimaryDelta95Lcb: number;
        eachCellPointDeltaMin: number;
        eachCellDelta95LcbMin: number;
        pooledDrawOrArmageddonDelta95UcbMax: number;
        eachCellDrawOrArmageddonPointDeltaMax: number;
        rangedMirrorV2ScoreMin: number;
        candidateAndOpponentRejections: number;
        releaseCellDrawOrArmageddonRateMax: number;
    };
    freshSeedsDeclared: boolean;
    promotionEvidenceNotCollectedByThisHarness: string[];
    declaration: string;
}

export interface IWaitV2ProtocolProvenance {
    sourcePath: string;
    sha256: string;
}

export const WAIT_V2_PROTOCOL_CELLS: readonly IWaitV2Cell[] = [
    {
        id: "mirror_melee_coevo",
        kind: "mirror",
        cohort: "melee_coevo",
        baseSeed: 819_284_410,
        primaryPool: false,
    },
    {
        id: "mirror_hybrid",
        kind: "mirror",
        cohort: "hybrid",
        baseSeed: 2_881_327_399,
        primaryPool: true,
    },
    {
        id: "mirror_ranged_max_sniper3",
        kind: "mirror",
        cohort: "ranged_max_sniper3",
        baseSeed: 903_810_739,
        primaryPool: true,
    },
    {
        id: "mirror_pure_ranged",
        kind: "mirror",
        cohort: "pure_ranged",
        baseSeed: 1_535_948_976,
        primaryPool: true,
    },
    {
        id: "draft_melee",
        kind: "draft",
        cohort: "melee",
        meleeDraftFraction: 1,
        baseSeed: 3_175_082_463,
        primaryPool: false,
    },
    {
        id: "draft_mixed",
        kind: "draft",
        cohort: "mixed",
        meleeDraftFraction: 0.5,
        baseSeed: 413_096_782,
        primaryPool: true,
    },
    {
        id: "draft_random",
        kind: "draft",
        cohort: "random",
        meleeDraftFraction: 0,
        baseSeed: 455_875_959,
        primaryPool: true,
    },
];

const WAIT_V2_PROTOCOL_GATES: IWaitV2ProtocolManifest["gates"] = {
    pooledPrimaryDelta95Lcb: 0,
    eachCellPointDeltaMin: 0,
    eachCellDelta95LcbMin: -0.005,
    pooledDrawOrArmageddonDelta95UcbMax: 0.0025,
    eachCellDrawOrArmageddonPointDeltaMax: 0.005,
    rangedMirrorV2ScoreMin: 0.5,
    candidateAndOpponentRejections: 0,
    releaseCellDrawOrArmageddonRateMax: 0.01,
};

export interface IWaitV2Observation {
    game: number;
    seed: number;
    score: 0 | 0.5 | 1;
    draw: boolean;
    armageddon: boolean;
    candidateRejections: number | null;
    opponentRejections: number | null;
}

export interface IWaitV2Estimate {
    clusters: number;
    mean: number;
    standardError: number | null;
    confidence95: { low: number; high: number } | null;
}

export interface IWaitV2ArmAnalysis {
    games: number;
    candidateWins: number;
    draws: number;
    candidateLosses: number;
    scoreRate: number;
    drawOrArmageddonRate: number;
    candidateRejections: number;
    opponentRejections: number;
}

export interface IWaitV2CellAnalysis {
    cell: IWaitV2Cell;
    control: IWaitV2ArmAnalysis;
    v2: IWaitV2ArmAnalysis;
    matchedScoreDelta: IWaitV2Estimate;
    matchedDrawOrArmageddonDelta: IWaitV2Estimate;
}

export interface IWaitV2Gate {
    name: string;
    threshold: string;
    observed: string;
    passed: boolean;
    tier: "research" | "release";
}

interface IRunIdentity {
    protocol: IWaitV2ProtocolProvenance;
    harnessSourceSha256: string;
    revision: IRevisionProvenance;
    gamesPerArm: number;
    candidate: string;
    opponent: string;
    cells: IWaitV2Cell[];
    v2WeightsSha256: string;
    effectiveEnvironment: {
        common: Record<string, string>;
        controlV07WaitWeightsV2: "absent";
        v2V07WaitWeightsV2: string;
    };
}

export interface IWaitV2RunManifest {
    schemaVersion: 1;
    createdAt: string;
    runFingerprint: string;
    identity: IRunIdentity;
}

export interface IWaitV2Assessment {
    evidenceVerdict: "PASS" | "FAIL" | "INCONCLUSIVE";
    verdictScope: "POWERED_RESEARCH_AB_ONLY";
    protocolPowered: boolean;
    completenessReasons: string[];
    pooledPrimaryScoreDelta: IWaitV2Estimate;
    pooledDrawOrArmageddonDelta: IWaitV2Estimate;
    gates: IWaitV2Gate[];
    releaseEligibleOnResearchMetrics: boolean;
    promotionEvidenceComplete: false;
    promotionCompletenessReasons: string[];
    releaseInstruction: "RESEARCH_ONLY_NO_BAKE";
}

export interface IWaitV2RunReport {
    schemaVersion: 1;
    generatedAt: string;
    completedAt: string;
    runManifest: IWaitV2RunManifest;
    revisionAtCompletion: IRevisionProvenance;
    revisionStable: boolean;
    resumedCells: number;
    cells: IWaitV2CellAnalysis[];
    assessment: IWaitV2Assessment;
}

interface IArmArtifact {
    schemaVersion: 1;
    runFingerprint: string;
    cell: IWaitV2Cell;
    arm: WaitV2Arm;
    games: number;
    observationsSha256: string;
    observations: IWaitV2Observation[];
}

interface ICellCheckpoint {
    schemaVersion: 1;
    runFingerprint: string;
    payloadSha256: string;
    payload: {
        cell: IWaitV2Cell;
        control: IWaitV2Observation[];
        v2: IWaitV2Observation[];
        analysis: IWaitV2CellAnalysis;
    };
}

interface IInternalArmSpec {
    marker: "v0.7-wait-v2-powered";
    runFingerprint: string;
    cell: IWaitV2Cell;
    arm: WaitV2Arm;
    candidate: string;
    opponent: string;
    games: number;
    concurrency: number;
}

const PURE_RANGED: readonly { level: number; creatureName: string }[] = [
    { level: 1, creatureName: "Arbalester" },
    { level: 1, creatureName: "Orc" },
    { level: 2, creatureName: "Elf" },
    { level: 2, creatureName: "Medusa" },
    { level: 3, creatureName: "Cyclops" },
    { level: 4, creatureName: "Tsar Cannon" },
];

const BEHAVIOR_ENV_PREFIXES = ["V04_", "V05_", "V06_", "V07_", "SEARCH_", "Q2_", "CEM_"] as const;
const BEHAVIOR_ENV_EXACT = new Set([
    "AUGCA_NOVISION",
    "FIGHT_MELEE_ROSTERS",
    "FORCE_CREATURES",
    "LIVETWIN",
    "ROSTER_RANGED_MAX",
    "ROSTER_RANGED_MIN",
    "SIM_NO_ACTIONS",
    "VALUE_DATA",
    "VALUE_DATA_FEATURES",
]);

function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (value !== null && typeof value === "object") {
        return `{${Object.entries(value as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
}

function atomicWrite(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temporary, path);
}

function validateUint32(label: string, value: number): void {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
        throw new Error(`${label} must be a uint32; got ${value}`);
    }
}

function validateGames(games: number): void {
    if (!Number.isSafeInteger(games) || games < 2 || games % 2 !== 0) {
        throw new Error(`games must be an even integer >= 2; got ${games}`);
    }
}

export function readWaitV2ProtocolManifest(path: string = WAIT_V2_POWERED_MANIFEST_PATH): {
    manifest: IWaitV2ProtocolManifest;
    provenance: IWaitV2ProtocolProvenance;
} {
    const sourcePath = resolve(path);
    const raw = readFileSync(sourcePath, "utf8");
    const manifest = JSON.parse(raw) as IWaitV2ProtocolManifest;
    validateWaitV2ProtocolManifest(manifest);
    return { manifest, provenance: { sourcePath, sha256: sha256(raw) } };
}

export function validateWaitV2ProtocolManifest(manifest: IWaitV2ProtocolManifest): void {
    if (manifest.schemaVersion !== 1 || !manifest.manifestId || !Number.isFinite(Date.parse(manifest.createdAt))) {
        throw new Error("Invalid V2 powered protocol identity");
    }
    if (manifest.candidate !== "v0.7" || manifest.opponent !== "v0.6") {
        throw new Error("The V2 powered protocol is frozen to v0.7 versus v0.6");
    }
    if (manifest.gamesPerArm !== 12_000) {
        throw new Error(`The V2 powered protocol requires 12000 games per arm; got ${manifest.gamesPerArm}`);
    }
    if (stableJson(manifest.cells) !== stableJson(WAIT_V2_PROTOCOL_CELLS)) {
        throw new Error("The V2 powered protocol cells or seeds differ from the frozen seven-cell panel");
    }
    if (stableJson(manifest.gates) !== stableJson(WAIT_V2_PROTOCOL_GATES)) {
        throw new Error("The V2 powered protocol gates differ from the frozen research contract");
    }
    if (
        !manifest.freshSeedsDeclared ||
        !manifest.declaration.trim() ||
        manifest.promotionEvidenceNotCollectedByThisHarness.length !== 3
    ) {
        throw new Error("The V2 powered protocol requires an explicit fresh-seed declaration");
    }
    const actualWeightHash = sha256(WAIT_V2_WEIGHT_JSON);
    if (manifest.v2WeightsSha256 !== actualWeightHash) {
        throw new Error(`V2 weight hash mismatch: manifest ${manifest.v2WeightsSha256}, code ${actualWeightHash}`);
    }
    const seen = new Map<number, string>();
    for (const cell of manifest.cells) {
        validateUint32(`${cell.id}.baseSeed`, cell.baseSeed);
        if (cell.kind === "draft" && ![0, 0.5, 1].includes(cell.meleeDraftFraction ?? Number.NaN)) {
            throw new Error(`${cell.id} requires a frozen meleeDraftFraction of 0, 0.5, or 1`);
        }
        for (let pair = 0; pair < manifest.gamesPerArm / 2; pair += 1) {
            const seed = (cell.baseSeed + pair * WAIT_V2_PAIR_SEED_STEP) >>> 0;
            const previous = seen.get(seed);
            if (previous) throw new Error(`Scenario seed collision ${seed}: ${previous} and ${cell.id}`);
            seen.set(seed, cell.id);
        }
    }
    if (seen.size !== (manifest.cells.length * manifest.gamesPerArm) / 2) {
        throw new Error("Scenario seed accounting is incomplete");
    }
}

function isBehaviorKey(key: string): boolean {
    return BEHAVIOR_ENV_EXACT.has(key) || BEHAVIOR_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Build a fresh child-process environment. The control arm deliberately leaves V07_WAIT_WEIGHTS_V2 absent. */
export function waitV2ArmEnvironment(source: NodeJS.ProcessEnv, cell: IWaitV2Cell, arm: WaitV2Arm): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(source)) {
        if (!isBehaviorKey(key) && value !== undefined) environment[key] = value;
    }
    environment.LIVETWIN = "1";
    environment.SIM_NO_ACTIONS = "1";
    if (cell.kind === "draft") environment.FIGHT_MELEE_ROSTERS = String(cell.meleeDraftFraction);
    if (arm === "v2") environment.V07_WAIT_WEIGHTS_V2 = WAIT_V2_WEIGHT_JSON;
    return environment;
}

function expectedSeed(cell: IWaitV2Cell, game: number): number {
    return (cell.baseSeed + Math.floor(game / 2) * WAIT_V2_PAIR_SEED_STEP) >>> 0;
}

function exactMirrorRoster(cell: IWaitV2Cell, seed: number): IArmyUnitSpec[] {
    const names =
        cell.cohort === "pure_ranged"
            ? PURE_RANGED
            : buildArchetypeRoster(cell.cohort as ArchetypeName, buildSharedArchetypeOffers(makeRng(seed))).roster;
    return names.map((unit) => {
        const catalog = creaturesByLevel(unit.level).find((entry) => entry.creatureName === unit.creatureName);
        if (!catalog) throw new Error(`Missing mirror creature ${unit.creatureName}`);
        return {
            faction: catalog.faction,
            creatureName: catalog.creatureName,
            level: catalog.level,
            size: catalog.size,
            amount: resolveStackAmount(catalog.creatureName, catalog.level, DEFAULT_AMOUNT_BY_LEVEL, "expBudget"),
        };
    });
}

function scoreForWinner(winner: IMatchResult["winner"], candidateIsGreen: boolean): 0 | 0.5 | 1 {
    if (winner === "draw") return 0.5;
    return (winner === "green") === candidateIsGreen ? 1 : 0;
}

function observationFromResult(
    cell: IWaitV2Cell,
    game: number,
    result: IMatchResult,
    candidateIsGreen: boolean,
): IWaitV2Observation {
    return {
        game,
        seed: result.seed,
        score: scoreForWinner(result.winner, candidateIsGreen),
        draw: result.winner === "draw",
        armageddon: result.attrition.decidedByArmageddon,
        candidateRejections: candidateIsGreen ? (result.rejectedGreen ?? null) : (result.rejectedRed ?? null),
        opponentRejections: candidateIsGreen ? (result.rejectedRed ?? null) : (result.rejectedGreen ?? null),
    };
}

function playMirrorObservation(spec: IInternalArmSpec, game: number): IWaitV2Observation {
    const seed = expectedSeed(spec.cell, game);
    const roster = exactMirrorRoster(spec.cell, seed);
    const setup = setupForArchetype(
        spec.cell.cohort === "pure_ranged" ? "melee_coevo" : (spec.cell.cohort as ArchetypeName),
    );
    const candidateIsGreen = game % 2 === 0;
    FightStateManager.getInstance();
    const result = runMatch({
        greenVersion: candidateIsGreen ? spec.candidate : spec.opponent,
        redVersion: candidateIsGreen ? spec.opponent : spec.candidate,
        roster: roster.map((unit) => ({ ...unit })),
        redRoster: roster.map((unit) => ({ ...unit })),
        seed,
        gridType: PBTypes.GridVals.NORMAL,
        greenPerk: setup.perk,
        redPerk: setup.perk,
        greenAugments: setup.augments.map((augment) => ({ ...augment })),
        redAugments: setup.augments.map((augment) => ({ ...augment })),
    });
    return observationFromResult(spec.cell, game, result, candidateIsGreen);
}

function playDraftObservation(spec: IInternalArmSpec, game: number): IWaitV2Observation {
    const options: ITournamentOptions = {
        versionA: spec.candidate,
        versionB: spec.opponent,
        games: spec.games,
        baseSeed: spec.cell.baseSeed,
        amountMode: "expBudget",
        randomizePicks: true,
        lightweight: true,
    };
    const record: IGameRecord = playGame(options, game);
    return observationFromResult(spec.cell, game, record.result, record.greenEntrant === "a");
}

function playObservation(spec: IInternalArmSpec, game: number): IWaitV2Observation {
    return spec.cell.kind === "mirror" ? playMirrorObservation(spec, game) : playDraftObservation(spec, game);
}

interface IWorkerEnvelope {
    marker: "v0.7-wait-v2-powered-worker";
    spec: IInternalArmSpec;
}

if (!isMainThread && parentPort) {
    const envelope = workerData as IWorkerEnvelope;
    if (envelope.marker === "v0.7-wait-v2-powered-worker") {
        const port = parentPort;
        port.on("message", (message: { type: "game"; game: number } | { type: "stop" }) => {
            if (message.type === "stop") {
                port.close();
                return;
            }
            try {
                port.postMessage({ type: "result", observation: playObservation(envelope.spec, message.game) });
            } catch (error) {
                port.postMessage({
                    type: "error",
                    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
                });
            }
        });
        port.postMessage({ type: "ready" });
    }
}

async function executeInternalArm(spec: IInternalArmSpec): Promise<IWaitV2Observation[]> {
    validateGames(spec.games);
    if (!Number.isSafeInteger(spec.concurrency) || spec.concurrency < 1) {
        throw new Error(`concurrency must be a positive integer; got ${spec.concurrency}`);
    }
    const expectedEnv = waitV2ArmEnvironment({}, spec.cell, spec.arm);
    const behaviorKeys = new Set([
        ...Object.keys(process.env).filter(isBehaviorKey),
        ...Object.keys(expectedEnv).filter(isBehaviorKey),
    ]);
    for (const key of behaviorKeys) {
        if (process.env[key] !== expectedEnv[key]) {
            throw new Error(`${spec.arm} arm has an invalid ${key} environment`);
        }
    }
    const observations: IWaitV2Observation[] = [];
    const poolSize = Math.max(1, Math.min(spec.concurrency, spec.games));
    await new Promise<void>((resolvePromise, rejectPromise) => {
        const workers: Worker[] = [];
        let dispatched = 0;
        let completed = 0;
        let settled = false;
        const cleanup = (): void => {
            for (const worker of workers) void worker.terminate();
        };
        const fail = (error: unknown): void => {
            if (settled) return;
            settled = true;
            cleanup();
            rejectPromise(error instanceof Error ? error : new Error(String(error)));
        };
        const dispatch = (worker: Worker): void => {
            if (dispatched >= spec.games) {
                worker.postMessage({ type: "stop" });
                return;
            }
            worker.postMessage({ type: "game", game: dispatched++ });
        };
        for (let index = 0; index < poolSize; index += 1) {
            const worker = new Worker(new URL(import.meta.url), {
                workerData: { marker: "v0.7-wait-v2-powered-worker", spec } satisfies IWorkerEnvelope,
            });
            workers.push(worker);
            worker.on(
                "message",
                (
                    message:
                        | { type: "ready" }
                        | { type: "result"; observation: IWaitV2Observation }
                        | { type: "error"; error: string },
                ) => {
                    if (settled) return;
                    if (message.type === "error") {
                        fail(new Error(message.error));
                        return;
                    }
                    if (message.type === "ready") {
                        dispatch(worker);
                        return;
                    }
                    observations.push(message.observation);
                    completed += 1;
                    if (completed >= spec.games) {
                        settled = true;
                        cleanup();
                        resolvePromise();
                    } else {
                        dispatch(worker);
                    }
                },
            );
            worker.on("error", fail);
        }
    });
    observations.sort((a, b) => a.game - b.game);
    return observations;
}

function validateObservations(
    cell: IWaitV2Cell,
    observations: readonly IWaitV2Observation[],
    games: number,
    label: string,
): void {
    if (observations.length !== games) throw new Error(`${label} has ${observations.length}/${games} games`);
    for (let game = 0; game < games; game += 1) {
        const record = observations[game];
        if (record.game !== game) throw new Error(`${label} game index ${game} is missing or duplicated`);
        const seed = expectedSeed(cell, game);
        if (record.seed !== seed) throw new Error(`${label} game ${game} seed ${record.seed} != ${seed}`);
        if (![0, 0.5, 1].includes(record.score)) throw new Error(`${label} game ${game} has invalid score`);
        if (record.candidateRejections === null || record.opponentRejections === null) {
            throw new Error(`${label} game ${game} is missing engine rejection counts`);
        }
        if (record.candidateRejections < 0 || record.opponentRejections < 0) {
            throw new Error(`${label} game ${game} has invalid engine rejection counts`);
        }
    }
}

function estimate(values: readonly number[]): IWaitV2Estimate {
    const clusters = values.length;
    const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, clusters);
    if (clusters < 2) return { clusters, mean, standardError: null, confidence95: null };
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (clusters - 1);
    const standardError = Math.sqrt(variance / clusters);
    return {
        clusters,
        mean,
        standardError,
        confidence95: { low: mean - 1.96 * standardError, high: mean + 1.96 * standardError },
    };
}

function pairMeans(observations: readonly IWaitV2Observation[], value: (row: IWaitV2Observation) => number): number[] {
    const result: number[] = [];
    for (let game = 0; game < observations.length; game += 2) {
        result.push((value(observations[game]) + value(observations[game + 1])) / 2);
    }
    return result;
}

function armAnalysis(rows: readonly IWaitV2Observation[]): IWaitV2ArmAnalysis {
    return {
        games: rows.length,
        candidateWins: rows.filter((row) => row.score === 1).length,
        draws: rows.filter((row) => row.score === 0.5).length,
        candidateLosses: rows.filter((row) => row.score === 0).length,
        scoreRate: rows.reduce((sum, row) => sum + row.score, 0) / rows.length,
        drawOrArmageddonRate: rows.filter((row) => row.draw || row.armageddon).length / rows.length,
        candidateRejections: rows.reduce((sum, row) => sum + (row.candidateRejections ?? 0), 0),
        opponentRejections: rows.reduce((sum, row) => sum + (row.opponentRejections ?? 0), 0),
    };
}

export function analyzeWaitV2Cell(
    cell: IWaitV2Cell,
    control: readonly IWaitV2Observation[],
    v2: readonly IWaitV2Observation[],
    games: number,
): IWaitV2CellAnalysis {
    validateObservations(cell, control, games, `${cell.id}/control`);
    validateObservations(cell, v2, games, `${cell.id}/v2`);
    for (let game = 0; game < games; game += 1) {
        if (control[game].seed !== v2[game].seed) {
            throw new Error(`${cell.id} arm seed mismatch at game ${game}`);
        }
    }
    const controlScore = pairMeans(control, (row) => row.score);
    const v2Score = pairMeans(v2, (row) => row.score);
    const controlAttrition = pairMeans(control, (row) => Number(row.draw || row.armageddon));
    const v2Attrition = pairMeans(v2, (row) => Number(row.draw || row.armageddon));
    return {
        cell,
        control: armAnalysis(control),
        v2: armAnalysis(v2),
        matchedScoreDelta: estimate(v2Score.map((value, index) => value - controlScore[index])),
        matchedDrawOrArmageddonDelta: estimate(v2Attrition.map((value, index) => value - controlAttrition[index])),
    };
}

function poolEstimate(cells: readonly IWaitV2CellAnalysis[], field: "score" | "attrition"): IWaitV2Estimate {
    // Cell estimates expose the exact N, mean, and standard error of their matched pair deltas. Pool those
    // sufficient moments here, including both within-cell and between-cell sums of squares.
    const totalN = cells.reduce(
        (sum, cell) =>
            sum + (field === "score" ? cell.matchedScoreDelta.clusters : cell.matchedDrawOrArmageddonDelta.clusters),
        0,
    );
    if (totalN === 0) return estimate([]);
    const mean =
        cells.reduce((sum, cell) => {
            const selected = field === "score" ? cell.matchedScoreDelta : cell.matchedDrawOrArmageddonDelta;
            return sum + selected.mean * selected.clusters;
        }, 0) / totalN;
    let sumSquares = 0;
    for (const cell of cells) {
        const selected = field === "score" ? cell.matchedScoreDelta : cell.matchedDrawOrArmageddonDelta;
        if (selected.clusters < 2 || selected.standardError === null) continue;
        sumSquares += selected.standardError ** 2 * selected.clusters * (selected.clusters - 1);
        sumSquares += selected.clusters * (selected.mean - mean) ** 2;
    }
    const standardError = totalN > 1 ? Math.sqrt(sumSquares / (totalN - 1) / totalN) : null;
    return {
        clusters: totalN,
        mean,
        standardError,
        confidence95:
            standardError === null ? null : { low: mean - 1.96 * standardError, high: mean + 1.96 * standardError },
    };
}

export function assessWaitV2Run(
    protocol: IWaitV2ProtocolManifest,
    cells: readonly IWaitV2CellAnalysis[],
    gamesPerArm: number,
    revision: IRevisionProvenance,
    revisionStable: boolean,
): IWaitV2Assessment {
    const reasons: string[] = [];
    if (gamesPerArm !== protocol.gamesPerArm)
        reasons.push(`gamesPerArm=${gamesPerArm}, expected ${protocol.gamesPerArm}`);
    if (cells.length !== protocol.cells.length)
        reasons.push(`cells=${cells.length}, expected ${protocol.cells.length}`);
    if (revision.branch !== "main") reasons.push(`revision branch is ${revision.branch}, expected main`);
    if (!revision.trackedClean) reasons.push("revision has tracked changes");
    if (!revisionStable) reasons.push("revision changed while the run was executing");
    if (stableJson(cells.map((cell) => cell.cell)) !== stableJson(protocol.cells)) {
        reasons.push("cell identities/order differ from the frozen panel");
    }
    for (const cell of cells) {
        if (
            cell.control.games !== gamesPerArm ||
            cell.v2.games !== gamesPerArm ||
            cell.matchedScoreDelta.clusters !== gamesPerArm / 2 ||
            cell.matchedDrawOrArmageddonDelta.clusters !== gamesPerArm / 2
        ) {
            reasons.push(`${cell.cell.id} is incomplete for ${gamesPerArm} games/arm`);
        }
    }
    const primary = cells.filter((cell) => cell.cell.primaryPool);
    const pooledScore = poolEstimate(primary, "score");
    const pooledAttrition = poolEstimate(primary, "attrition");
    const gate = protocol.gates;
    const gates: IWaitV2Gate[] = [
        {
            name: "pooled-primary-score-delta",
            threshold: "matched 95% LCB > 0",
            observed: `${((pooledScore.confidence95?.low ?? Number.NaN) * 100).toFixed(3)}pp LCB`,
            passed: (pooledScore.confidence95?.low ?? Number.NEGATIVE_INFINITY) > gate.pooledPrimaryDelta95Lcb,
            tier: "research",
        },
        {
            name: "every-cell-point-non-regression",
            threshold: "each matched score delta >= 0",
            observed: `${(Math.min(...cells.map((cell) => cell.matchedScoreDelta.mean)) * 100).toFixed(3)}pp minimum`,
            passed: cells.every((cell) => cell.matchedScoreDelta.mean >= gate.eachCellPointDeltaMin),
            tier: "research",
        },
        {
            name: "every-cell-confidence-non-regression",
            threshold: "each matched score 95% LCB >= -0.50pp",
            observed: `${(
                Math.min(...cells.map((cell) => cell.matchedScoreDelta.confidence95?.low ?? Number.NEGATIVE_INFINITY)) *
                100
            ).toFixed(3)}pp minimum LCB`,
            passed: cells.every(
                (cell) =>
                    (cell.matchedScoreDelta.confidence95?.low ?? Number.NEGATIVE_INFINITY) >=
                    gate.eachCellDelta95LcbMin,
            ),
            tier: "research",
        },
        {
            name: "pooled-draw-or-armageddon-non-regression",
            threshold: "matched 95% UCB <= +0.25pp",
            observed: `${((pooledAttrition.confidence95?.high ?? Number.NaN) * 100).toFixed(3)}pp UCB`,
            passed:
                (pooledAttrition.confidence95?.high ?? Number.POSITIVE_INFINITY) <=
                gate.pooledDrawOrArmageddonDelta95UcbMax,
            tier: "research",
        },
        {
            name: "every-cell-draw-or-armageddon-point-non-regression",
            threshold: "each matched point increase <= +0.50pp",
            observed: `${(Math.max(...cells.map((cell) => cell.matchedDrawOrArmageddonDelta.mean)) * 100).toFixed(
                3,
            )}pp maximum`,
            passed: cells.every(
                (cell) => cell.matchedDrawOrArmageddonDelta.mean <= gate.eachCellDrawOrArmageddonPointDeltaMax,
            ),
            tier: "research",
        },
        {
            name: "ranged-mirror-score-floor",
            threshold: "V2 score >= 50% in ranged_max_sniper3 and pure_ranged",
            observed: `${(
                Math.min(
                    ...cells
                        .filter((cell) => ["mirror_ranged_max_sniper3", "mirror_pure_ranged"].includes(cell.cell.id))
                        .map((cell) => cell.v2.scoreRate),
                ) * 100
            ).toFixed(3)}% minimum`,
            passed: ["mirror_ranged_max_sniper3", "mirror_pure_ranged"].every(
                (id) =>
                    (cells.find((cell) => cell.cell.id === id)?.v2.scoreRate ?? Number.NEGATIVE_INFINITY) >=
                    gate.rangedMirrorV2ScoreMin,
            ),
            tier: "research",
        },
        {
            name: "engine-rejections",
            threshold: "0 candidate and opponent rejections in both arms",
            observed: `${cells.reduce(
                (sum, cell) =>
                    sum +
                    cell.control.candidateRejections +
                    cell.control.opponentRejections +
                    cell.v2.candidateRejections +
                    cell.v2.opponentRejections,
                0,
            )} total`,
            passed: cells.every(
                (cell) =>
                    cell.control.candidateRejections === gate.candidateAndOpponentRejections &&
                    cell.control.opponentRejections === gate.candidateAndOpponentRejections &&
                    cell.v2.candidateRejections === gate.candidateAndOpponentRejections &&
                    cell.v2.opponentRejections === gate.candidateAndOpponentRejections,
            ),
            tier: "research",
        },
        {
            name: "release-cell-draw-or-armageddon",
            threshold: "each V2 cell <= 1.00% (release battery only)",
            observed: `${(Math.max(...cells.map((cell) => cell.v2.drawOrArmageddonRate)) * 100).toFixed(3)}% maximum`,
            passed: cells.every((cell) => cell.v2.drawOrArmageddonRate <= gate.releaseCellDrawOrArmageddonRateMax),
            tier: "release",
        },
    ];
    const protocolPowered = reasons.length === 0;
    const researchPassed = gates.filter((entry) => entry.tier === "research").every((entry) => entry.passed);
    return {
        evidenceVerdict: protocolPowered ? (researchPassed ? "PASS" : "FAIL") : "INCONCLUSIVE",
        verdictScope: "POWERED_RESEARCH_AB_ONLY",
        protocolPowered,
        completenessReasons: reasons,
        pooledPrimaryScoreDelta: pooledScore,
        pooledDrawOrArmageddonDelta: pooledAttrition,
        gates,
        releaseEligibleOnResearchMetrics: false,
        promotionEvidenceComplete: false,
        promotionCompletenessReasons: [...protocol.promotionEvidenceNotCollectedByThisHarness],
        releaseInstruction: "RESEARCH_ONLY_NO_BAKE",
    };
}

function buildRunManifest(
    protocol: IWaitV2ProtocolManifest,
    provenance: IWaitV2ProtocolProvenance,
    revision: IRevisionProvenance,
    gamesPerArm: number,
): IWaitV2RunManifest {
    const identity: IRunIdentity = {
        protocol: provenance,
        harnessSourceSha256: sha256(readFileSync(fileURLToPath(import.meta.url), "utf8")),
        revision,
        gamesPerArm,
        candidate: protocol.candidate,
        opponent: protocol.opponent,
        cells: protocol.cells,
        v2WeightsSha256: protocol.v2WeightsSha256,
        effectiveEnvironment: {
            common: { LIVETWIN: "1", SIM_NO_ACTIONS: "1" },
            controlV07WaitWeightsV2: "absent",
            v2V07WaitWeightsV2: WAIT_V2_WEIGHT_JSON,
        },
    };
    return {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        runFingerprint: sha256(stableJson(identity)),
        identity,
    };
}

function initializeRunManifest(outputDir: string, proposed: IWaitV2RunManifest): IWaitV2RunManifest {
    const path = join(outputDir, "run-manifest.json");
    if (!existsSync(path)) {
        atomicWrite(path, proposed);
        return proposed;
    }
    const existing = JSON.parse(readFileSync(path, "utf8")) as IWaitV2RunManifest;
    if (
        existing.runFingerprint !== proposed.runFingerprint ||
        stableJson(existing.identity) !== stableJson(proposed.identity)
    ) {
        throw new Error(`Output directory is bound to a different run: ${path}`);
    }
    return existing;
}

function safeName(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function loadArmArtifact(path: string, spec: IInternalArmSpec): IWaitV2Observation[] | undefined {
    if (!existsSync(path)) return undefined;
    const artifact = JSON.parse(readFileSync(path, "utf8")) as IArmArtifact;
    if (
        artifact.schemaVersion !== 1 ||
        artifact.runFingerprint !== spec.runFingerprint ||
        artifact.arm !== spec.arm ||
        artifact.games !== spec.games ||
        stableJson(artifact.cell) !== stableJson(spec.cell)
    ) {
        return undefined;
    }
    if (artifact.observationsSha256 !== sha256(JSON.stringify(artifact.observations))) {
        throw new Error(`Corrupt arm artifact: ${path}`);
    }
    validateObservations(spec.cell, artifact.observations, spec.games, `${spec.cell.id}/${spec.arm}`);
    return artifact.observations;
}

async function runArmSubprocess(spec: IInternalArmSpec, path: string): Promise<IWaitV2Observation[]> {
    const resumed = loadArmArtifact(path, spec);
    if (resumed) return resumed;
    const encoded = Buffer.from(JSON.stringify(spec)).toString("base64url");
    const environment = waitV2ArmEnvironment(process.env, spec.cell, spec.arm);
    await new Promise<void>((resolvePromise, rejectPromise) => {
        const child = spawn(
            process.execPath,
            [fileURLToPath(import.meta.url), "--internal-arm", encoded, "--internal-output", path],
            {
                cwd: process.cwd(),
                env: environment,
                stdio: ["ignore", "inherit", "inherit"],
            },
        );
        child.once("error", rejectPromise);
        child.once("exit", (code, signal) => {
            if (code === 0) resolvePromise();
            else rejectPromise(new Error(`Arm process failed with code ${code ?? "null"}, signal ${signal ?? "none"}`));
        });
    });
    const completed = loadArmArtifact(path, spec);
    if (!completed) throw new Error(`Arm process did not write a valid artifact: ${path}`);
    return completed;
}

function loadCellCheckpoint(
    path: string,
    fingerprint: string,
    cell: IWaitV2Cell,
    games: number,
): ICellCheckpoint["payload"] | undefined {
    if (!existsSync(path)) return undefined;
    const checkpoint = JSON.parse(readFileSync(path, "utf8")) as ICellCheckpoint;
    if (
        checkpoint.schemaVersion !== 1 ||
        checkpoint.runFingerprint !== fingerprint ||
        stableJson(checkpoint.payload.cell) !== stableJson(cell)
    ) {
        return undefined;
    }
    if (checkpoint.payloadSha256 !== sha256(JSON.stringify(checkpoint.payload))) {
        throw new Error(`Corrupt cell checkpoint: ${path}`);
    }
    validateObservations(cell, checkpoint.payload.control, games, `${cell.id}/control checkpoint`);
    validateObservations(cell, checkpoint.payload.v2, games, `${cell.id}/v2 checkpoint`);
    return checkpoint.payload;
}

export interface IWaitV2RunOptions {
    protocolPath: string;
    outputDir: string;
    gamesPerArm: number;
    concurrency: number;
    dryRun: boolean;
}

export async function runWaitV2Powered(options: IWaitV2RunOptions): Promise<IWaitV2RunReport | IWaitV2RunManifest> {
    validateGames(options.gamesPerArm);
    if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
        throw new Error(`concurrency must be a positive integer; got ${options.concurrency}`);
    }
    const { manifest: protocol, provenance } = readWaitV2ProtocolManifest(options.protocolPath);
    const revision = readRevisionProvenance();
    if (options.gamesPerArm === protocol.gamesPerArm && (revision.branch !== "main" || !revision.trackedClean)) {
        throw new Error("A powered run requires a clean main revision; use a reduced --games value for smoke tests");
    }
    mkdirSync(options.outputDir, { recursive: true });
    const proposed = buildRunManifest(protocol, provenance, revision, options.gamesPerArm);
    const runManifest = initializeRunManifest(options.outputDir, proposed);
    if (options.dryRun) return runManifest;

    const startedAt = new Date();
    const analyses: IWaitV2CellAnalysis[] = [];
    let resumedCells = 0;
    for (const [index, cell] of protocol.cells.entries()) {
        const checkpointPath = join(options.outputDir, "checkpoints", `${safeName(cell.id)}.json`);
        const checkpoint = loadCellCheckpoint(checkpointPath, runManifest.runFingerprint, cell, options.gamesPerArm);
        if (checkpoint) {
            resumedCells += 1;
            analyses.push(checkpoint.analysis);
            console.error(`[wait-v2] ${index + 1}/${protocol.cells.length} ${cell.id}: resumed`);
            continue;
        }
        const arms = {} as Record<WaitV2Arm, IWaitV2Observation[]>;
        for (const arm of ["control", "v2"] as const) {
            const spec: IInternalArmSpec = {
                marker: "v0.7-wait-v2-powered",
                runFingerprint: runManifest.runFingerprint,
                cell,
                arm,
                candidate: protocol.candidate,
                opponent: protocol.opponent,
                games: options.gamesPerArm,
                concurrency: options.concurrency,
            };
            const armPath = join(options.outputDir, "arms", `${safeName(cell.id)}.${arm}.json`);
            console.error(`[wait-v2] ${index + 1}/${protocol.cells.length} ${cell.id}/${arm}`);
            arms[arm] = await runArmSubprocess(spec, armPath);
        }
        const analysis = analyzeWaitV2Cell(cell, arms.control, arms.v2, options.gamesPerArm);
        const payload: ICellCheckpoint["payload"] = { cell, control: arms.control, v2: arms.v2, analysis };
        atomicWrite(checkpointPath, {
            schemaVersion: 1,
            runFingerprint: runManifest.runFingerprint,
            payloadSha256: sha256(JSON.stringify(payload)),
            payload,
        } satisfies ICellCheckpoint);
        analyses.push(analysis);
    }
    const revisionAtCompletion = readRevisionProvenance();
    const revisionStable = stableJson(revisionAtCompletion) === stableJson(revision);
    const report: IWaitV2RunReport = {
        schemaVersion: 1,
        generatedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        runManifest,
        revisionAtCompletion,
        revisionStable,
        resumedCells,
        cells: analyses,
        assessment: assessWaitV2Run(protocol, analyses, options.gamesPerArm, revision, revisionStable),
    };
    atomicWrite(join(options.outputDir, "report.json"), report);
    return report;
}

function parseCli(argv: string[]): IWaitV2RunOptions {
    const { values } = parseArgs({
        args: argv,
        strict: true,
        allowPositionals: false,
        options: {
            output: { type: "string", default: "sim-out/v07_v2_powered_20260715" },
            manifest: { type: "string", default: WAIT_V2_POWERED_MANIFEST_PATH },
            games: { type: "string", default: "12000" },
            concurrency: {
                type: "string",
                default: String(Math.min(12, Math.max(1, availableParallelism()))),
            },
            "dry-run": { type: "boolean", default: false },
        },
    });
    return {
        protocolPath: resolve(values.manifest!),
        outputDir: resolve(values.output!),
        gamesPerArm: Number(values.games),
        concurrency: Number(values.concurrency),
        dryRun: values["dry-run"]!,
    };
}

async function internalArmMain(argv: string[]): Promise<void> {
    const marker = argv.indexOf("--internal-arm");
    const outputMarker = argv.indexOf("--internal-output");
    if (marker < 0 || outputMarker < 0 || !argv[marker + 1] || !argv[outputMarker + 1]) {
        throw new Error("Invalid internal arm invocation");
    }
    const spec = JSON.parse(Buffer.from(argv[marker + 1], "base64url").toString("utf8")) as IInternalArmSpec;
    if (spec.marker !== "v0.7-wait-v2-powered") throw new Error("Invalid internal arm marker");
    const observations = await executeInternalArm(spec);
    validateObservations(spec.cell, observations, spec.games, `${spec.cell.id}/${spec.arm}`);
    atomicWrite(argv[outputMarker + 1], {
        schemaVersion: 1,
        runFingerprint: spec.runFingerprint,
        cell: spec.cell,
        arm: spec.arm,
        games: spec.games,
        observationsSha256: sha256(JSON.stringify(observations)),
        observations,
    } satisfies IArmArtifact);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
    if (argv.includes("--internal-arm")) {
        await internalArmMain(argv);
        return;
    }
    const options = parseCli(argv);
    const result = await runWaitV2Powered(options);
    if ("assessment" in result) {
        console.log(JSON.stringify(result.assessment, null, 2));
        if (result.assessment.evidenceVerdict === "FAIL") process.exitCode = 1;
    } else {
        console.log(`dry-run fingerprint ${result.runFingerprint}`);
    }
}

if (isMainThread && (import.meta as unknown as { main?: boolean }).main) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
