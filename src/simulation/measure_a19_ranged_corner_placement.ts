import { mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isMainThread, parentPort, workerData, Worker } from "node:worker_threads";

import { createV08A19Strategy } from "../ai/versions/v0_8_a19_profile";
import {
    withV08A19RangedCornerPlacement,
    type IV08A19RangedCornerPlacementAudit,
} from "../ai/versions/v0_8_a19_ranged_corner_placement";
import { PBTypes } from "../generated/protobuf/v1/types";
import { Doctrine } from "../doctrines/doctrine_properties";
import {
    creaturesByLevel,
    hashSimulationParts,
    resolveStackAmount,
    DEFAULT_AMOUNT_BY_LEVEL,
    type IArmyUnitSpec,
} from "./army";
import { runMatch, type IMatchResult, type IPlacementRecord, type ISetupAugment, type Side } from "./battle_engine";

export const V08_A19_RANGED_CORNER_PLACEMENT_AB_SCHEMA = "hoc.v0_8_a19_ranged_corner_placement_ab.v3" as const;
export const V08_A19_RANGED_CORNER_PLACEMENT_AB_MAP = PBTypes.GridVals.NORMAL;
export const V08_A19_RANGED_CORNER_PLACEMENT_AB_CLUSTER_SIZE = 4 as const;
export const V08_A19_RANGED_CORNER_PLACEMENT_AB_SETUP = Object.freeze({
    doctrine: Doctrine.SEE_NONE,
    placementAugmentTiming: "setup-before-placement" as const,
    augments: Object.freeze([Object.freeze({ kind: "Placement" as const, value: 2 })]),
});

interface IRosterCreature {
    readonly level: number;
    readonly creatureName: string;
}

export const V08_A19_RANGED_CORNER_SUPPORT_ROSTER = Object.freeze([
    Object.freeze({ level: 1, creatureName: "Troglodyte" }),
    Object.freeze({ level: 1, creatureName: "Arbalester" }),
    Object.freeze({ level: 2, creatureName: "Beholder" }),
    Object.freeze({ level: 2, creatureName: "Troll" }),
    Object.freeze({ level: 3, creatureName: "Ogre Mage" }),
    Object.freeze({ level: 4, creatureName: "Behemoth" }),
] satisfies readonly IRosterCreature[]);

export const V08_A19_RANGED_CORNER_SCENARIOS = Object.freeze({
    "ground-control": Object.freeze([
        Object.freeze({ level: 1, creatureName: "Peasant" }),
        Object.freeze({ level: 1, creatureName: "Squire" }),
        Object.freeze({ level: 2, creatureName: "Medusa" }),
        Object.freeze({ level: 2, creatureName: "Troll" }),
        Object.freeze({ level: 3, creatureName: "Ogre Mage" }),
        Object.freeze({ level: 4, creatureName: "Frenzied Boar" }),
    ] satisfies readonly IRosterCreature[]),
    "charger-pressure": Object.freeze([
        Object.freeze({ level: 1, creatureName: "Wolf Rider" }),
        Object.freeze({ level: 1, creatureName: "Arbalester" }),
        Object.freeze({ level: 2, creatureName: "Nomad" }),
        Object.freeze({ level: 2, creatureName: "Pikeman" }),
        Object.freeze({ level: 3, creatureName: "Crusader" }),
        Object.freeze({ level: 4, creatureName: "Hydra" }),
    ] satisfies readonly IRosterCreature[]),
});

export const V08_A19_RANGED_CORNER_SCENARIO_NAMES = Object.freeze(
    Object.keys(V08_A19_RANGED_CORNER_SCENARIOS) as (keyof typeof V08_A19_RANGED_CORNER_SCENARIOS)[],
);
export type V08A19RangedCornerScenario = (typeof V08_A19_RANGED_CORNER_SCENARIO_NAMES)[number];
export type V08A19RangedCornerPlacementArm = "candidate" | "control";

export const V08_A19_RANGED_CORNER_PLACEMENT_AB_SCHEDULE = Object.freeze([
    Object.freeze({ id: "green-control", supportSide: "green", arm: "control" }),
    Object.freeze({ id: "green-candidate", supportSide: "green", arm: "candidate" }),
    Object.freeze({ id: "red-control", supportSide: "red", arm: "control" }),
    Object.freeze({ id: "red-candidate", supportSide: "red", arm: "candidate" }),
] as const);

type V08A19RangedCornerPlacementScheduleEntry = (typeof V08_A19_RANGED_CORNER_PLACEMENT_AB_SCHEDULE)[number];

export interface IV08A19RangedCornerPlacementGameRecord {
    readonly id: V08A19RangedCornerPlacementScheduleEntry["id"];
    readonly scenario: V08A19RangedCornerScenario;
    readonly cluster: number;
    readonly arm: V08A19RangedCornerPlacementArm;
    readonly supportSide: Side;
    readonly seed: number;
    readonly winner: Side | "draw";
    readonly supportResult: "win" | "loss" | "draw";
    readonly supportScore: number;
    readonly laps: number;
    readonly endReason: IMatchResult["endReason"];
    readonly supportRejectedActions: number;
    readonly opponentRejectedActions: number;
    readonly supportFirelineSpan: number;
    readonly behemothAdjacentToFireline: boolean;
    readonly candidateAudit: IV08A19RangedCornerPlacementAudit | null;
}

export interface IV08A19RangedCornerPlacementClusterRecord {
    readonly schema: typeof V08_A19_RANGED_CORNER_PLACEMENT_AB_SCHEMA;
    readonly scenario: V08A19RangedCornerScenario;
    readonly cluster: number;
    readonly seed: number;
    readonly physicalExecutionOrder: readonly V08A19RangedCornerPlacementScheduleEntry["id"][];
    readonly games: readonly [
        IV08A19RangedCornerPlacementGameRecord,
        IV08A19RangedCornerPlacementGameRecord,
        IV08A19RangedCornerPlacementGameRecord,
        IV08A19RangedCornerPlacementGameRecord,
    ];
}

export interface IV08A19RangedCornerPlacementEffect {
    readonly clusters: number;
    readonly games: number;
    readonly candidateMeanScore: number;
    readonly controlMeanScore: number;
    readonly scoreDeltaPp: number;
    readonly clusteredStandardErrorPp: number | null;
    readonly normal95Pp: { readonly low: number; readonly high: number } | null;
    readonly outcomeChanges: number;
    readonly candidateApplied: number;
    readonly candidateChanged: number;
    readonly candidateMeanFirelineSpan: number;
    readonly controlMeanFirelineSpan: number;
    readonly candidateRejectedActions: number;
    readonly controlRejectedActions: number;
}

export interface IV08A19RangedCornerPlacementSummary {
    readonly schema: typeof V08_A19_RANGED_CORNER_PLACEMENT_AB_SCHEMA;
    readonly estimand: "paired draw-aware expanded-placement support-roster score delta versus A19";
    readonly clusters: number;
    readonly games: number;
    readonly overall: IV08A19RangedCornerPlacementEffect;
    readonly byScenario: Readonly<Record<V08A19RangedCornerScenario, IV08A19RangedCornerPlacementEffect>>;
}

export interface IV08A19RangedCornerPlacementRunOptions {
    readonly scenarios: readonly V08A19RangedCornerScenario[];
    readonly clusters: number;
    readonly startCluster?: number;
    readonly baseSeed: number;
    readonly maxLaps: number;
    readonly concurrency: number;
}

interface IWorkerJob {
    readonly scenario: V08A19RangedCornerScenario;
    readonly cluster: number;
    readonly baseSeed: number;
    readonly maxLaps: number;
}

type IWorkerMessage =
    | { readonly type: "ready" }
    | { readonly type: "result"; readonly record: IV08A19RangedCornerPlacementClusterRecord }
    | { readonly type: "error"; readonly error: string };

const rosterFromSelection = (selection: readonly IRosterCreature[]): IArmyUnitSpec[] =>
    selection.map(({ level, creatureName }) => {
        const creature = creaturesByLevel(level).find((candidate) => candidate.creatureName === creatureName);
        if (!creature) {
            throw new Error(`Unknown ranked roster creature ${creatureName} at level ${level}`);
        }
        return {
            faction: creature.faction,
            creatureName: creature.creatureName,
            level: creature.level,
            size: creature.size,
            amount: resolveStackAmount(creature.creatureName, creature.level, DEFAULT_AMOUNT_BY_LEVEL, "expBudget"),
        };
    });

const setupAugments = (): ISetupAugment[] =>
    V08_A19_RANGED_CORNER_PLACEMENT_AB_SETUP.augments.map((augment) => ({ ...augment }));

export const v08A19RangedCornerSupportRoster = (): IArmyUnitSpec[] =>
    rosterFromSelection(V08_A19_RANGED_CORNER_SUPPORT_ROSTER);

export const v08A19RangedCornerOpponentRoster = (scenario: V08A19RangedCornerScenario): IArmyUnitSpec[] =>
    rosterFromSelection(V08_A19_RANGED_CORNER_SCENARIOS[scenario]);

const scoreForSide = (result: IMatchResult, side: Side): number =>
    result.winner === "draw" ? 0.5 : result.winner === side ? 1 : 0;

const resultForScore = (score: number): "win" | "loss" | "draw" =>
    score === 1 ? "win" : score === 0 ? "loss" : "draw";

const footprintFor = (record: IPlacementRecord): { x: number; y: number }[] =>
    record.size === 1
        ? [record.cell]
        : [
              record.cell,
              { x: record.cell.x - 1, y: record.cell.y },
              { x: record.cell.x, y: record.cell.y - 1 },
              { x: record.cell.x - 1, y: record.cell.y - 1 },
          ];

const cellsAdjacent = (
    left: readonly { x: number; y: number }[],
    right: readonly { x: number; y: number }[],
): boolean =>
    left.some((leftCell) =>
        right.some((rightCell) => {
            const dx = Math.abs(leftCell.x - rightCell.x);
            const dy = Math.abs(leftCell.y - rightCell.y);
            return (dx === 1 && dy === 0) || (dx === 0 && dy === 1) || (dx === 1 && dy === 1);
        }),
    );

const supportFireline = (placements: readonly IPlacementRecord[]): IPlacementRecord[] =>
    placements.filter((placement) => ["Arbalester", "Beholder", "Ogre Mage"].includes(placement.creatureName));

const firelineSpan = (placements: readonly IPlacementRecord[]): number => {
    const fireline = supportFireline(placements);
    if (fireline.length !== 3) {
        throw new Error(
            `Expected full support fireline, got ${fireline.map((placement) => placement.creatureName).join(", ")}`,
        );
    }
    const xs = fireline.map((placement) => placement.cell.x);
    return Math.max(...xs) - Math.min(...xs);
};

const behemothGuardsFireline = (placements: readonly IPlacementRecord[]): boolean => {
    const behemoth = placements.find((placement) => placement.creatureName === "Behemoth");
    if (!behemoth) {
        throw new Error("Support roster placement omitted Behemoth");
    }
    return supportFireline(placements).some((placement) =>
        cellsAdjacent(footprintFor(behemoth), footprintFor(placement)),
    );
};

const executionOrderFor = (cluster: number): V08A19RangedCornerPlacementScheduleEntry[] => {
    const rotation = cluster % V08_A19_RANGED_CORNER_PLACEMENT_AB_SCHEDULE.length;
    return [
        ...V08_A19_RANGED_CORNER_PLACEMENT_AB_SCHEDULE.slice(rotation),
        ...V08_A19_RANGED_CORNER_PLACEMENT_AB_SCHEDULE.slice(0, rotation),
    ];
};

export function playV08A19RangedCornerPlacementGame(
    scenario: V08A19RangedCornerScenario,
    cluster: number,
    baseSeed: number,
    maxLaps: number,
    schedule: V08A19RangedCornerPlacementScheduleEntry,
): IV08A19RangedCornerPlacementGameRecord {
    const supportRoster = v08A19RangedCornerSupportRoster();
    const opponentRoster = v08A19RangedCornerOpponentRoster(scenario);
    const supportIsGreen = schedule.supportSide === "green";
    const treatment = schedule.arm === "candidate";
    const candidateStrategy = treatment ? withV08A19RangedCornerPlacement(createV08A19Strategy()) : undefined;
    const result = runMatch({
        greenVersion: "v0.8",
        redVersion: "v0.8",
        roster: supportIsGreen ? supportRoster : opponentRoster,
        redRoster: supportIsGreen ? opponentRoster : supportRoster,
        seed: hashSimulationParts(V08_A19_RANGED_CORNER_PLACEMENT_AB_SCHEMA, baseSeed, scenario, cluster),
        gridType: V08_A19_RANGED_CORNER_PLACEMENT_AB_MAP,
        maxLaps,
        headlessEvents: true,
        searchOfflineDeterministicWork: true,
        greenDoctrine: V08_A19_RANGED_CORNER_PLACEMENT_AB_SETUP.doctrine,
        redDoctrine: V08_A19_RANGED_CORNER_PLACEMENT_AB_SETUP.doctrine,
        greenAugments: setupAugments(),
        redAugments: setupAugments(),
        placementAugmentTiming: V08_A19_RANGED_CORNER_PLACEMENT_AB_SETUP.placementAugmentTiming,
        greenSetupPlacementPolicy: "public-roster",
        redSetupPlacementPolicy: "public-roster",
        greenStrategyOverride: treatment && supportIsGreen ? candidateStrategy : createV08A19Strategy(),
        redStrategyOverride: treatment && !supportIsGreen ? candidateStrategy : createV08A19Strategy(),
    });
    if (result.rejectedGreen === undefined || result.rejectedRed === undefined) {
        throw new Error(`Ranged-corner A/B game ${scenario}/${cluster}/${schedule.id} omitted rejection telemetry`);
    }
    const audit = candidateStrategy?.getLastPlacementAudit() ?? null;
    if (treatment && (!audit?.treatmentApplied || !audit.placementChanged)) {
        throw new Error(`Ranged-corner candidate did not apply for ${scenario}/${cluster}/${schedule.id}`);
    }
    const supportPlacements = supportIsGreen ? result.placements.green : result.placements.red;
    const supportScore = scoreForSide(result, schedule.supportSide);
    return {
        id: schedule.id,
        scenario,
        cluster,
        arm: schedule.arm,
        supportSide: schedule.supportSide,
        seed: result.seed,
        winner: result.winner,
        supportResult: resultForScore(supportScore),
        supportScore,
        laps: result.laps,
        endReason: result.endReason,
        supportRejectedActions: supportIsGreen ? result.rejectedGreen : result.rejectedRed,
        opponentRejectedActions: supportIsGreen ? result.rejectedRed : result.rejectedGreen,
        supportFirelineSpan: firelineSpan(supportPlacements),
        behemothAdjacentToFireline: behemothGuardsFireline(supportPlacements),
        candidateAudit: audit,
    };
}

export function evaluateV08A19RangedCornerPlacementCluster(
    scenario: V08A19RangedCornerScenario,
    cluster: number,
    baseSeed: number,
    maxLaps: number = 60,
): IV08A19RangedCornerPlacementClusterRecord {
    const byId = new Map<V08A19RangedCornerPlacementScheduleEntry["id"], IV08A19RangedCornerPlacementGameRecord>();
    const physicalExecutionOrder = executionOrderFor(cluster);
    for (const schedule of physicalExecutionOrder) {
        byId.set(schedule.id, playV08A19RangedCornerPlacementGame(scenario, cluster, baseSeed, maxLaps, schedule));
    }
    const games = V08_A19_RANGED_CORNER_PLACEMENT_AB_SCHEDULE.map((schedule) => {
        const game = byId.get(schedule.id);
        if (!game) {
            throw new Error(`Missing scheduled ranged-corner A/B game ${schedule.id}`);
        }
        return game;
    });
    if (games.length !== V08_A19_RANGED_CORNER_PLACEMENT_AB_CLUSTER_SIZE) {
        throw new Error(
            `Expected ${V08_A19_RANGED_CORNER_PLACEMENT_AB_CLUSTER_SIZE} scheduled ranged-corner A/B games`,
        );
    }
    return {
        schema: V08_A19_RANGED_CORNER_PLACEMENT_AB_SCHEMA,
        scenario,
        cluster,
        seed: hashSimulationParts(V08_A19_RANGED_CORNER_PLACEMENT_AB_SCHEMA, baseSeed, scenario, cluster),
        physicalExecutionOrder: physicalExecutionOrder.map((schedule) => schedule.id),
        games: [games[0]!, games[1]!, games[2]!, games[3]!],
    };
}

const average = (values: readonly number[]): number =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

const summarizeEffect = (
    records: readonly IV08A19RangedCornerPlacementGameRecord[],
): IV08A19RangedCornerPlacementEffect => {
    const controls = new Map(
        records
            .filter((record) => record.arm === "control")
            .map((record) => [`${record.scenario}/${record.cluster}/${record.supportSide}`, record]),
    );
    const candidates = records.filter((record) => record.arm === "candidate");
    const deltasByCluster = new Map<string, number[]>();
    let outcomeChanges = 0;
    for (const candidate of candidates) {
        const control = controls.get(`${candidate.scenario}/${candidate.cluster}/${candidate.supportSide}`);
        if (!control) {
            throw new Error(
                `Missing matched control for ${candidate.scenario}/${candidate.cluster}/${candidate.supportSide}`,
            );
        }
        if (candidate.seed !== control.seed) {
            throw new Error(`Seed mismatch for ${candidate.scenario}/${candidate.cluster}/${candidate.supportSide}`);
        }
        const clusterKey = `${candidate.scenario}/${candidate.cluster}`;
        const values = deltasByCluster.get(clusterKey) ?? [];
        values.push(candidate.supportScore - control.supportScore);
        deltasByCluster.set(clusterKey, values);
        outcomeChanges += Number(candidate.supportResult !== control.supportResult);
    }
    const clusterMeans = [...deltasByCluster.values()].map(average);
    const meanDelta = average(clusterMeans);
    const variance =
        clusterMeans.length < 2
            ? null
            : clusterMeans.reduce((sum, value) => sum + (value - meanDelta) ** 2, 0) / (clusterMeans.length - 1);
    const standardError = variance === null ? null : Math.sqrt(variance / clusterMeans.length);
    const candidateApplied = candidates.filter((record) => record.candidateAudit?.treatmentApplied).length;
    const candidateChanged = candidates.filter((record) => record.candidateAudit?.placementChanged).length;
    return {
        clusters: clusterMeans.length,
        games: candidates.length,
        candidateMeanScore: average(candidates.map((record) => record.supportScore)),
        controlMeanScore: average([...controls.values()].map((record) => record.supportScore)),
        scoreDeltaPp: meanDelta * 100,
        clusteredStandardErrorPp: standardError === null ? null : standardError * 100,
        normal95Pp:
            standardError === null
                ? null
                : {
                      low: (meanDelta - 1.959963984540054 * standardError) * 100,
                      high: (meanDelta + 1.959963984540054 * standardError) * 100,
                  },
        outcomeChanges,
        candidateApplied,
        candidateChanged,
        candidateMeanFirelineSpan: average(candidates.map((record) => record.supportFirelineSpan)),
        controlMeanFirelineSpan: average([...controls.values()].map((record) => record.supportFirelineSpan)),
        candidateRejectedActions: candidates.reduce((sum, record) => sum + record.supportRejectedActions, 0),
        controlRejectedActions: [...controls.values()].reduce((sum, record) => sum + record.supportRejectedActions, 0),
    };
};

export function summarizeV08A19RangedCornerPlacement(
    clusters: readonly IV08A19RangedCornerPlacementClusterRecord[],
): IV08A19RangedCornerPlacementSummary {
    const records = clusters.flatMap((cluster) => cluster.games);
    return {
        schema: V08_A19_RANGED_CORNER_PLACEMENT_AB_SCHEMA,
        estimand: "paired draw-aware expanded-placement support-roster score delta versus A19",
        clusters: clusters.length,
        games: records.length,
        overall: summarizeEffect(records),
        byScenario: Object.fromEntries(
            V08_A19_RANGED_CORNER_SCENARIO_NAMES.map((scenario) => [
                scenario,
                summarizeEffect(records.filter((record) => record.scenario === scenario)),
            ]),
        ) as IV08A19RangedCornerPlacementSummary["byScenario"],
    };
}

const runJobs = async (
    jobs: readonly IWorkerJob[],
    concurrency: number,
    onProgress?: (completed: number, total: number) => void,
): Promise<IV08A19RangedCornerPlacementClusterRecord[]> => {
    if (!jobs.length) {
        return [];
    }
    return new Promise((resolvePromise, rejectPromise) => {
        const workers = new Set<Worker>();
        const records: IV08A19RangedCornerPlacementClusterRecord[] = [];
        let cursor = 0;
        let settled = false;
        const stop = (): void => workers.forEach((worker) => void worker.terminate());
        const fail = (error: unknown): void => {
            if (settled) {
                return;
            }
            settled = true;
            stop();
            rejectPromise(error instanceof Error ? error : new Error(String(error)));
        };
        const launch = (): void => {
            const job = jobs[cursor++];
            if (!job || settled) {
                return;
            }
            const worker = new Worker(new URL(import.meta.url), {
                workerData: { v08A19RangedCornerPlacementWorker: true },
            });
            workers.add(worker);
            worker.on("message", (message: IWorkerMessage) => {
                if (message.type === "error") {
                    fail(new Error(message.error));
                    return;
                }
                if (message.type === "ready") {
                    worker.postMessage({ type: "job", job });
                    return;
                }
                records.push(message.record);
                onProgress?.(records.length, jobs.length);
                void worker.terminate().then(() => {
                    workers.delete(worker);
                    if (settled) {
                        return;
                    }
                    if (records.length === jobs.length) {
                        settled = true;
                        resolvePromise(records);
                        return;
                    }
                    launch();
                }, fail);
            });
            worker.on("error", fail);
        };
        const workerCount = Math.max(1, Math.min(concurrency, jobs.length));
        for (let index = 0; index < workerCount; index += 1) {
            launch();
        }
    });
};

export async function runV08A19RangedCornerPlacementAb(
    options: IV08A19RangedCornerPlacementRunOptions,
    onProgress?: (completed: number, total: number) => void,
): Promise<IV08A19RangedCornerPlacementClusterRecord[]> {
    const jobs: IWorkerJob[] = [];
    const startCluster = options.startCluster ?? 0;
    if (!Number.isSafeInteger(startCluster) || startCluster < 0) {
        throw new Error(`startCluster must be a non-negative safe integer; got ${startCluster}`);
    }
    for (const scenario of options.scenarios) {
        for (let offset = 0; offset < options.clusters; offset += 1) {
            jobs.push({
                scenario,
                cluster: startCluster + offset,
                baseSeed: options.baseSeed,
                maxLaps: options.maxLaps,
            });
        }
    }
    const records = await runJobs(jobs, options.concurrency, onProgress);
    return records.sort((left, right) => left.scenario.localeCompare(right.scenario) || left.cluster - right.cluster);
}

const parsePositiveInteger = (name: string, value: string): number => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`${name} must be a positive integer; got ${value}`);
    }
    return parsed;
};

const parseNonNegativeInteger = (name: string, value: string): number => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error(`${name} must be a non-negative integer; got ${value}`);
    }
    return parsed;
};

const parseScenarios = (value: string): V08A19RangedCornerScenario[] => {
    const scenarios = value === "all" ? [...V08_A19_RANGED_CORNER_SCENARIO_NAMES] : value.split(",");
    for (const scenario of scenarios) {
        if (!V08_A19_RANGED_CORNER_SCENARIO_NAMES.includes(scenario as V08A19RangedCornerScenario)) {
            throw new Error(`Unknown ranged-corner scenario ${scenario}`);
        }
    }
    return scenarios as V08A19RangedCornerScenario[];
};

export async function main(): Promise<void> {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            clusters: { type: "string", default: "24" },
            "start-cluster": { type: "string", default: "0" },
            "base-seed": { type: "string", default: "819024611" },
            scenarios: { type: "string", default: "all" },
            workers: { type: "string", default: String(Math.min(12, availableParallelism())) },
            "max-laps": { type: "string", default: "60" },
            output: { type: "string", default: "sim-out/a19-ranged-corner-placement-ab.json" },
            help: { type: "boolean", short: "h", default: false },
        },
        strict: true,
        allowPositionals: false,
    });
    if (values.help) {
        console.log(
            "usage: bun src/simulation/measure_a19_ranged_corner_placement.ts " +
                "[--clusters 24] [--start-cluster 0] [--base-seed 819024611] [--scenarios all|ground-control,charger-pressure] " +
                "[--workers 12] [--max-laps 60] [--output sim-out/a19-ranged-corner-placement-ab.json]",
        );
        return;
    }
    const clusters = parsePositiveInteger("clusters", values.clusters);
    const startCluster = parseNonNegativeInteger("start-cluster", values["start-cluster"]);
    const baseSeed = parsePositiveInteger("base-seed", values["base-seed"]);
    const concurrency = parsePositiveInteger("workers", values.workers);
    const maxLaps = parsePositiveInteger("max-laps", values["max-laps"]);
    const scenarios = parseScenarios(values.scenarios);
    const startedAt = Date.now();
    let lastProgress = 0;
    const clusterRecords = await runV08A19RangedCornerPlacementAb(
        { scenarios, clusters, startCluster, baseSeed, maxLaps, concurrency },
        (completed, total) => {
            if (completed - lastProgress >= Math.max(1, Math.floor(total / 20)) || completed === total) {
                lastProgress = completed;
                const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
                console.error(
                    `  ${completed}/${total} clusters (${((completed * 4) / elapsedSeconds).toFixed(2)} games/s)`,
                );
            }
        },
    );
    const summary = summarizeV08A19RangedCornerPlacement(clusterRecords);
    const report = {
        ...summary,
        baseSeed,
        startCluster,
        maxLaps,
        concurrency,
        deterministicSearchWork: true,
        workerIsolation: "fresh-worker-per-cluster",
        setup: V08_A19_RANGED_CORNER_PLACEMENT_AB_SETUP,
        elapsedSeconds: (Date.now() - startedAt) / 1000,
        records: clusterRecords,
    };
    const output = resolve(values.output);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    console.error(`Report: ${output}`);
    console.error(
        `A19 ranged corner: ${summary.overall.scoreDeltaPp >= 0 ? "+" : ""}${summary.overall.scoreDeltaPp.toFixed(2)}pp ` +
            `(95% ${summary.overall.normal95Pp ? `${summary.overall.normal95Pp.low.toFixed(2)} to ${summary.overall.normal95Pp.high.toFixed(2)}pp` : "n/a"}; ` +
            `candidate span ${summary.overall.candidateMeanFirelineSpan.toFixed(2)} vs control ${summary.overall.controlMeanFirelineSpan.toFixed(2)}; ` +
            `rejections ${summary.overall.candidateRejectedActions}/${summary.overall.controlRejectedActions})`,
    );
}

const port = parentPort;

if (
    !isMainThread &&
    port &&
    (workerData as { v08A19RangedCornerPlacementWorker?: boolean }).v08A19RangedCornerPlacementWorker
) {
    port.on("message", (message: { readonly type: "job"; readonly job: IWorkerJob } | { readonly type: "stop" }) => {
        if (message.type === "stop") {
            port.close();
            return;
        }
        try {
            port.postMessage({
                type: "result",
                record: evaluateV08A19RangedCornerPlacementCluster(
                    message.job.scenario,
                    message.job.cluster,
                    message.job.baseSeed,
                    message.job.maxLaps,
                ),
            } satisfies IWorkerMessage);
        } catch (error) {
            port.postMessage({
                type: "error",
                error: error instanceof Error ? (error.stack ?? error.message) : String(error),
            } satisfies IWorkerMessage);
        }
    });
    port.postMessage({ type: "ready" } satisfies IWorkerMessage);
}

if (isMainThread && import.meta.main) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
