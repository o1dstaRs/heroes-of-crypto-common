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

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";

import type { IAIStrategy } from "../ai/ai_strategy";
import { StrategyV0_8 } from "../ai/versions/v0_8";
import { buildV08A19H18SearchEnvironment } from "../ai/versions/v0_8_a19_h18_profile";
import {
    createV08A19H18F184HumanPlacementStrategy,
    V08_A19_H18_F184_HUMAN_PLACEMENT_PROFILE,
} from "../ai/versions/v0_8_a19_h18_f184_human_placement_profile";
import type {
    IV08A19F184HumanPlacementAudit,
    V08A19F184HumanOpeningId,
    V08A19F184HumanPlacementStrategy,
} from "../ai/versions/v0_8_a19_f184_human_placement";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { IAiMetaArmy } from "./ai_meta_cohorts_core";
import { runMatch, type IMatchConfig, type IMatchResult, type IPlacementRecord, type Side } from "./battle_engine";
import {
    prepareV08A19ProdF184Pair,
    V08_A19_PROD_F184_ANCHOR,
    V08_A19_PROD_F184_FIXTURE_ID,
    V08_A19_PROD_F184_FIXTURE_SHA256,
    V08_A19_PROD_F184_MATCH_ID,
} from "./v0_8_a19_prod_f184_anchor";

export const V08_A19_F184_HUMAN_PLACEMENT_AB_SCHEMA = "hoc.v0_8_a19_f184_human_placement_causal_ab.v10" as const;
export const V08_A19_F184_HUMAN_PLACEMENT_AB_CLUSTER_SIZE = 6 as const;
export const V08_A19_F184_HUMAN_PLACEMENT_AB_MAP = PBTypes.GridVals.NORMAL;
export const V08_A19_F184_HUMAN_PLACEMENT_AB_RAW_FILE = "v0-8-a19-f184-human-placement-ab-v10.records.jsonl" as const;
export const V08_A19_F184_HUMAN_PLACEMENT_AB_SUMMARY_FILE =
    "v0-8-a19-f184-human-placement-ab-v10.summary.json" as const;
export const V08_A19_F184_HUMAN_PLACEMENT_AB_STARTED_FILE =
    "v0-8-a19-f184-human-placement-ab-v10.started.json" as const;
export const V08_A19_F184_HUMAN_PLACEMENT_AB_BOOTSTRAP_ITERATIONS = 100_000 as const;
export const V08_A19_F184_HUMAN_PLACEMENT_AB_BOOTSTRAP_SEED = 1_966_612_100 as const;

export type V08A19F184HumanPlacementAbStage = "smoke" | "development" | "validation";
export type V08A19F184HumanPlacementAbRoster = "a" | "b";
export type V08A19F184HumanPlacementAbCell = "a-green" | "a-red" | "b-green" | "b-red";

export const V08_A19_F184_HUMAN_PLACEMENT_AB_CLUSTERS_BY_STAGE: Readonly<
    Record<V08A19F184HumanPlacementAbStage, number>
> = Object.freeze({
    smoke: 8,
    development: 360,
    validation: 1_440,
});

export const V08_A19_F184_HUMAN_PLACEMENT_AB_SEEDS: Readonly<Record<V08A19F184HumanPlacementAbStage, number>> =
    Object.freeze({
        smoke: 438_067_678,
        development: 1_143_159_338,
        validation: 4_273_392_186,
    });

export const V08_A19_F184_HUMAN_PLACEMENT_AB_CELLS = Object.freeze(["a-green", "a-red", "b-green", "b-red"] as const);

export interface IV08A19F184HumanPlacementAbScheduleEntry {
    readonly id:
        | "ab-control"
        | "ab-a-green-treated"
        | "ab-b-red-treated"
        | "ba-control"
        | "ba-b-green-treated"
        | "ba-a-red-treated";
    readonly greenRoster: V08A19F184HumanPlacementAbRoster;
    readonly redRoster: V08A19F184HumanPlacementAbRoster;
    readonly treatedRoster: V08A19F184HumanPlacementAbRoster | null;
    readonly treatedSide: Side | null;
    readonly cell: V08A19F184HumanPlacementAbCell | null;
}

/**
 * Six unique fights identify all four direct effects while holding the opposing army on plain v0.8.
 * An eight-fight candidate/control panel would rerun each deterministic control orientation twice.
 */
export const V08_A19_F184_HUMAN_PLACEMENT_AB_SCHEDULE = Object.freeze([
    {
        id: "ab-control",
        greenRoster: "a",
        redRoster: "b",
        treatedRoster: null,
        treatedSide: null,
        cell: null,
    },
    {
        id: "ab-a-green-treated",
        greenRoster: "a",
        redRoster: "b",
        treatedRoster: "a",
        treatedSide: "green",
        cell: "a-green",
    },
    {
        id: "ab-b-red-treated",
        greenRoster: "a",
        redRoster: "b",
        treatedRoster: "b",
        treatedSide: "red",
        cell: "b-red",
    },
    {
        id: "ba-control",
        greenRoster: "b",
        redRoster: "a",
        treatedRoster: null,
        treatedSide: null,
        cell: null,
    },
    {
        id: "ba-b-green-treated",
        greenRoster: "b",
        redRoster: "a",
        treatedRoster: "b",
        treatedSide: "green",
        cell: "b-green",
    },
    {
        id: "ba-a-red-treated",
        greenRoster: "b",
        redRoster: "a",
        treatedRoster: "a",
        treatedSide: "red",
        cell: "a-red",
    },
] as const satisfies readonly IV08A19F184HumanPlacementAbScheduleEntry[]);

export const V08_A19_F184_HUMAN_PLACEMENT_AB_BINDING = Object.freeze({
    fixtureId: V08_A19_PROD_F184_FIXTURE_ID,
    matchId: V08_A19_PROD_F184_MATCH_ID,
    sha256: V08_A19_PROD_F184_FIXTURE_SHA256,
});

export const V08_A19_F184_HUMAN_PLACEMENT_AB_GATES = Object.freeze({
    primaryNormalCiLowExclusive: 0,
    primaryBootstrapCiLowExclusive: 0,
    cellPointDeltaInclusive: 0,
    cellNoninferiorityMargin: 0.01,
    cellBonferroniOneSidedAlpha: 0.0125,
    rosterPointDeltaExclusive: 0,
    seatPointDeltaExclusive: 0,
});

export interface IV08A19F184HumanPlacementAbRunnerOptions {
    readonly stage: V08A19F184HumanPlacementAbStage;
    readonly clusters: number;
    readonly baseSeed: number;
    readonly concurrency: 12;
    readonly maxLaps: 60;
    readonly output: string;
}

export interface IV08A19F184HumanPlacementAbClusterOptions {
    readonly clusters: number;
    readonly baseSeed: number;
    readonly maxLaps: 60;
}

export interface IV08A19F184CanonicalPlacementRow {
    readonly creatureName: string;
    readonly level: number;
    readonly size: number;
    readonly amount: number;
    readonly x: number;
    /** Base-cell Y normalized to LOWER. */
    readonly y: number;
}

export interface IV08A19F184HumanPlacementAbGameOutcome {
    readonly scheduleId: (typeof V08_A19_F184_HUMAN_PLACEMENT_AB_SCHEDULE)[number]["id"];
    readonly greenRoster: V08A19F184HumanPlacementAbRoster;
    readonly redRoster: V08A19F184HumanPlacementAbRoster;
    readonly treatedRoster: V08A19F184HumanPlacementAbRoster | null;
    readonly treatedSide: Side | null;
    readonly cell: V08A19F184HumanPlacementAbCell | null;
    readonly winner: Side | "draw";
    readonly scoreByRoster: Readonly<Record<V08A19F184HumanPlacementAbRoster, number>>;
    readonly laps: number;
    readonly endReason: IMatchResult["endReason"];
    readonly armageddonDecided: boolean;
    readonly rejectedGreen: number;
    readonly rejectedRed: number;
    readonly setupFingerprint: string;
    readonly candidateAudit: IV08A19F184HumanPlacementAudit | null;
    readonly candidateCanonicalPlacement: readonly IV08A19F184CanonicalPlacementRow[] | null;
}

export interface IV08A19F184HumanPlacementAbClusterRecord {
    readonly schema: typeof V08_A19_F184_HUMAN_PLACEMENT_AB_SCHEMA;
    readonly productionAnchor: typeof V08_A19_F184_HUMAN_PLACEMENT_AB_BINDING;
    readonly cluster: number;
    readonly setupSeed: number;
    readonly combatSeed: number;
    readonly map: typeof V08_A19_F184_HUMAN_PLACEMENT_AB_MAP;
    readonly armyFingerprints: Readonly<Record<V08A19F184HumanPlacementAbRoster, string>>;
    readonly games: readonly [
        IV08A19F184HumanPlacementAbGameOutcome,
        IV08A19F184HumanPlacementAbGameOutcome,
        IV08A19F184HumanPlacementAbGameOutcome,
        IV08A19F184HumanPlacementAbGameOutcome,
        IV08A19F184HumanPlacementAbGameOutcome,
        IV08A19F184HumanPlacementAbGameOutcome,
    ];
}

export interface IV08A19F184HumanPlacementAbCellEffect {
    readonly cluster: number;
    readonly cell: V08A19F184HumanPlacementAbCell;
    readonly roster: V08A19F184HumanPlacementAbRoster;
    readonly side: Side;
    readonly baselineScore: number;
    readonly candidateScore: number;
    readonly delta: number;
    readonly outcomeChanged: boolean;
}

export interface IV08A19F184HumanPlacementAbMetric {
    readonly key: string;
    readonly clusters: number;
    readonly meanDelta: number;
    readonly meanDeltaPp: number;
    readonly clusteredStandardError: number | null;
    readonly normal95: { readonly low: number; readonly high: number };
    readonly bootstrap95: { readonly low: number; readonly high: number };
    /** One-sided lower bound at alpha=.0125, used for the four-cell noninferiority family. */
    readonly bootstrapBonferroniLower: number;
    readonly outcomeChanges: number;
}

export interface IV08A19F184HumanPlacementAbSummaryRows {
    readonly estimand: "mean direct draw-aware score delta across the four exact roster-by-seat cells";
    readonly clusters: number;
    readonly games: number;
    readonly bootstrapIterations: number;
    readonly primary: IV08A19F184HumanPlacementAbMetric;
    readonly cells: Readonly<Record<V08A19F184HumanPlacementAbCell, IV08A19F184HumanPlacementAbMetric>>;
    readonly rosters: Readonly<Record<V08A19F184HumanPlacementAbRoster, IV08A19F184HumanPlacementAbMetric>>;
    readonly seats: Readonly<Record<Side, IV08A19F184HumanPlacementAbMetric>>;
}

export interface IV08A19F184HumanPlacementAbQuality {
    readonly expectedClusters: number;
    readonly clusters: number;
    readonly games: number;
    readonly rawLines: number;
    readonly malformedClusters: number;
    readonly duplicateClusters: number;
    readonly missingClusters: number;
    readonly auditMismatches: number;
    readonly coordinateMismatches: number;
    readonly rejectedActions: number;
    readonly stuckGames: number;
    readonly armageddonDecided: number;
    readonly treatmentGames: number;
    readonly validTreatmentAudits: number;
    readonly sourceUnchanged: boolean;
}

export type IV08A19F184HumanPlacementAbWorkerRequest =
    | {
          readonly type: "cluster";
          readonly options: IV08A19F184HumanPlacementAbClusterOptions;
          readonly cluster: number;
      }
    | { readonly type: "stop" };

export type IV08A19F184HumanPlacementAbWorkerResponse =
    | { readonly type: "ready" }
    | { readonly type: "result"; readonly record: IV08A19F184HumanPlacementAbClusterRecord }
    | { readonly type: "error"; readonly error: string };

const positiveInteger = (raw: string | undefined, label: string, fallback: number): number => {
    const value = Number(raw ?? fallback);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
    return value;
};

export function parseV08A19F184HumanPlacementAbOptions(
    argv: readonly string[],
): IV08A19F184HumanPlacementAbRunnerOptions {
    const { values } = parseArgs({
        args: [...argv],
        options: {
            stage: { type: "string" },
            output: { type: "string" },
            concurrency: { type: "string" },
        },
        strict: true,
        allowPositionals: false,
    });
    const stage = (values.stage ?? "smoke") as V08A19F184HumanPlacementAbStage;
    if (stage !== "smoke" && stage !== "development" && stage !== "validation") {
        throw new Error("stage must be smoke, development, or validation");
    }
    if (!values.output) throw new Error("--output is required and must name a fresh directory");
    const concurrency = positiveInteger(values.concurrency, "concurrency", 12);
    if (concurrency !== 12) throw new Error("f184 human-placement A/B requires concurrency 12");
    return {
        stage,
        clusters: V08_A19_F184_HUMAN_PLACEMENT_AB_CLUSTERS_BY_STAGE[stage],
        baseSeed: V08_A19_F184_HUMAN_PLACEMENT_AB_SEEDS[stage],
        concurrency: 12,
        maxLaps: 60,
        output: resolve(values.output),
    };
}

/** Exact dual-seat A19/H18 environment; the six matches differ only in the declared placement arm. */
export function buildV08A19F184HumanPlacementAbEnvironment(): Record<string, string> {
    const environment: Record<string, string> = {};
    for (const [key, value] of Object.entries(buildV08A19H18SearchEnvironment("v0.8"))) {
        if (value !== undefined) environment[key] = value;
    }
    environment.SEARCH_VERSIONS = "v0.8";
    environment.V08_A13_SEARCH = "0";
    environment.LIVETWIN = "1";
    environment.SIM_NO_ACTIONS = "1";
    environment.FIGHT_MELEE_ROSTERS = "0";
    environment.BUN_RUNTIME_TRANSPILER_CACHE_PATH = "0";
    if (environment.V07_SEARCH !== "1" || environment.SEARCH_HORIZON !== "18" || environment.SEARCH_SHORTLIST !== "3") {
        throw new Error("f184 human-placement A/B requires the exact A19/H18 shortlist-3 search profile");
    }
    return environment;
}

const minimalWorkerEnvironment = (): Record<string, string> => {
    const environment: Record<string, string> = {};
    for (const key of [
        "PATH",
        "TMPDIR",
        "TMP",
        "TEMP",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "SystemRoot",
        "WINDIR",
        "ComSpec",
        "PATHEXT",
    ]) {
        const value = process.env[key];
        if (value !== undefined) environment[key] = value;
    }
    return Object.assign(environment, buildV08A19F184HumanPlacementAbEnvironment());
};

const armySetup = (army: IAiMetaArmy) => ({
    roster: army.roster,
    creatureIds: army.creatureIds,
    doctrine: army.doctrine,
    artifactT1: army.artifactT1.id,
    artifactT2: army.artifactT2.id,
    augments: army.augment.augments,
    synergies: army.synergies,
});

const sha256 = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const fingerprintV08A19F184HumanPlacementArmy = (army: IAiMetaArmy): string => sha256(armySetup(army));

export const fingerprintV08A19F184HumanPlacementSetup = (green: IAiMetaArmy, red: IAiMetaArmy, map: number): string =>
    sha256({ green: armySetup(green), red: armySetup(red), map });

const sourceSideForRoster = (roster: V08A19F184HumanPlacementAbRoster): Side => (roster === "a" ? "green" : "red");

const canonicalY = (side: Side, size: number, y: number): number => {
    if (side === "green") return y;
    return size === PBTypes.UnitSizeVals.SMALL ? 15 - y : 16 - y;
};

const canonicalPlacementRows = (
    placement: readonly IPlacementRecord[],
    side: Side,
): IV08A19F184CanonicalPlacementRow[] =>
    placement
        .map((entry) => ({
            creatureName: entry.creatureName,
            level: entry.level,
            size: entry.size,
            amount: entry.amount,
            x: entry.cell.x,
            y: canonicalY(side, entry.size, entry.cell.y),
        }))
        .sort((left, right) => left.creatureName.localeCompare(right.creatureName));

export function expectedV08A19F184CanonicalPlacement(
    roster: V08A19F184HumanPlacementAbRoster,
): IV08A19F184CanonicalPlacementRow[] {
    const setup = roster === "a" ? V08_A19_PROD_F184_ANCHOR.left : V08_A19_PROD_F184_ANCHOR.right;
    const observed =
        roster === "a"
            ? V08_A19_PROD_F184_ANCHOR.observedPlacement.left
            : V08_A19_PROD_F184_ANCHOR.observedPlacement.right;
    const sourceSide = sourceSideForRoster(roster);
    return setup.roster
        .map((unit) => {
            const cell = observed.find((entry) => entry.creatureName === unit.creatureName);
            if (!cell) throw new Error(`f184 fixture has no placement for ${unit.creatureName}`);
            return {
                creatureName: unit.creatureName,
                level: unit.level,
                size: unit.size,
                amount: unit.amount,
                x: cell.x,
                y: canonicalY(sourceSide, unit.size, cell.y),
            };
        })
        .sort((left, right) => left.creatureName.localeCompare(right.creatureName));
}

const scoreForSide = (winner: Side | "draw", side: Side): number => (winner === "draw" ? 0.5 : winner === side ? 1 : 0);

const scoreByRoster = (
    winner: Side | "draw",
    entry: IV08A19F184HumanPlacementAbScheduleEntry,
): Readonly<Record<V08A19F184HumanPlacementAbRoster, number>> =>
    ({
        [entry.greenRoster]: scoreForSide(winner, "green"),
        [entry.redRoster]: scoreForSide(winner, "red"),
    }) as Readonly<Record<V08A19F184HumanPlacementAbRoster, number>>;

const strategyForControl = (): StrategyV0_8 => new StrategyV0_8();

const matchConfig = (
    green: IAiMetaArmy,
    red: IAiMetaArmy,
    greenStrategy: IAIStrategy,
    redStrategy: IAIStrategy,
    combatSeed: number,
    maxLaps: 60,
): IMatchConfig => ({
    greenVersion: "v0.8",
    redVersion: "v0.8",
    greenStrategyOverride: greenStrategy,
    redStrategyOverride: redStrategy,
    roster: green.roster,
    redRoster: red.roster,
    seed: combatSeed,
    gridType: V08_A19_F184_HUMAN_PLACEMENT_AB_MAP,
    maxLaps,
    greenDoctrine: green.doctrine,
    redDoctrine: red.doctrine,
    greenArtifactT1: green.artifactT1.id,
    redArtifactT1: red.artifactT1.id,
    greenArtifactT2: green.artifactT2.id,
    redArtifactT2: red.artifactT2.id,
    greenAugments: green.augment.augments,
    redAugments: red.augment.augments,
    greenSynergies: green.synergies,
    redSynergies: red.synergies,
    placementAugmentTiming: "setup-before-placement",
    greenSetupPlacementPolicy: "public-roster",
    redSetupPlacementPolicy: "public-roster",
    greenPublicOpponentCreatures: red.creatureIds,
    redPublicOpponentCreatures: green.creatureIds,
});

const playScheduledGame = (
    entry: IV08A19F184HumanPlacementAbScheduleEntry,
    armies: Readonly<Record<V08A19F184HumanPlacementAbRoster, IAiMetaArmy>>,
    combatSeed: number,
    maxLaps: 60,
): IV08A19F184HumanPlacementAbGameOutcome => {
    const green = armies[entry.greenRoster];
    const red = armies[entry.redRoster];
    let greenStrategy: IAIStrategy = strategyForControl();
    let redStrategy: IAIStrategy = strategyForControl();
    let candidateStrategy: V08A19F184HumanPlacementStrategy | undefined;
    if (entry.treatedSide !== null) {
        candidateStrategy = createV08A19H18F184HumanPlacementStrategy();
        if (entry.treatedSide === "green") greenStrategy = candidateStrategy;
        else redStrategy = candidateStrategy;
    }
    const result = runMatch(matchConfig(green, red, greenStrategy, redStrategy, combatSeed, maxLaps));
    const candidateAudit = candidateStrategy?.getLastPlacementAudit() ?? null;
    const candidateCanonicalPlacement =
        entry.treatedSide === null
            ? null
            : canonicalPlacementRows(result.placements[entry.treatedSide], entry.treatedSide);
    return {
        scheduleId: entry.id,
        greenRoster: entry.greenRoster,
        redRoster: entry.redRoster,
        treatedRoster: entry.treatedRoster,
        treatedSide: entry.treatedSide,
        cell: entry.cell,
        winner: result.winner,
        scoreByRoster: scoreByRoster(result.winner, entry),
        laps: result.laps,
        endReason: result.endReason,
        armageddonDecided: result.attrition.decidedByArmageddon,
        rejectedGreen: result.rejectedGreen ?? 0,
        rejectedRed: result.rejectedRed ?? 0,
        setupFingerprint: fingerprintV08A19F184HumanPlacementSetup(green, red, V08_A19_F184_HUMAN_PLACEMENT_AB_MAP),
        candidateAudit,
        candidateCanonicalPlacement,
    };
};

export function playV08A19F184HumanPlacementAbCluster(
    options: IV08A19F184HumanPlacementAbClusterOptions,
    cluster: number,
): IV08A19F184HumanPlacementAbClusterRecord {
    if (!Number.isSafeInteger(options.clusters) || options.clusters <= 0) {
        throw new RangeError("clusters must be a positive integer");
    }
    if (!Number.isSafeInteger(cluster) || cluster < 0 || cluster >= options.clusters) {
        throw new RangeError(`cluster ${cluster} is outside [0, ${options.clusters})`);
    }
    const prepared = prepareV08A19ProdF184Pair(options.baseSeed, cluster);
    const armies = { a: prepared.armyA, b: prepared.armyB } as const;
    const games = V08_A19_F184_HUMAN_PLACEMENT_AB_SCHEDULE.map((entry) =>
        playScheduledGame(entry, armies, prepared.combatSeed, options.maxLaps),
    ) as unknown as IV08A19F184HumanPlacementAbClusterRecord["games"];
    return {
        schema: V08_A19_F184_HUMAN_PLACEMENT_AB_SCHEMA,
        productionAnchor: V08_A19_F184_HUMAN_PLACEMENT_AB_BINDING,
        cluster,
        setupSeed: prepared.setupSeed,
        combatSeed: prepared.combatSeed,
        map: V08_A19_F184_HUMAN_PLACEMENT_AB_MAP,
        armyFingerprints: {
            a: fingerprintV08A19F184HumanPlacementArmy(prepared.armyA),
            b: fingerprintV08A19F184HumanPlacementArmy(prepared.armyB),
        },
        games,
    };
}

const effect = (
    record: IV08A19F184HumanPlacementAbClusterRecord,
    cell: V08A19F184HumanPlacementAbCell,
    baselineIndex: 0 | 3,
    candidateIndex: 1 | 2 | 4 | 5,
): IV08A19F184HumanPlacementAbCellEffect => {
    const [roster, side] = cell.split("-") as [V08A19F184HumanPlacementAbRoster, Side];
    const baselineScore = record.games[baselineIndex].scoreByRoster[roster];
    const candidateScore = record.games[candidateIndex].scoreByRoster[roster];
    return {
        cluster: record.cluster,
        cell,
        roster,
        side,
        baselineScore,
        candidateScore,
        delta: candidateScore - baselineScore,
        outcomeChanged: candidateScore !== baselineScore,
    };
};

/** Direct potential-outcome contrasts; the opponent remains plain v0.8 in every candidate match. */
export function causalV08A19F184HumanPlacementEffects(
    record: IV08A19F184HumanPlacementAbClusterRecord,
): Readonly<Record<V08A19F184HumanPlacementAbCell, IV08A19F184HumanPlacementAbCellEffect>> {
    return {
        "a-green": effect(record, "a-green", 0, 1),
        "a-red": effect(record, "a-red", 3, 5),
        "b-green": effect(record, "b-green", 3, 4),
        "b-red": effect(record, "b-red", 0, 2),
    };
}

interface IBootstrapBounds {
    readonly low: number;
    readonly high: number;
    readonly bonferroniLower: number;
}

type MetricKey = "primary" | V08A19F184HumanPlacementAbCell | "roster-a" | "roster-b" | "seat-green" | "seat-red";

const METRIC_KEYS: readonly MetricKey[] = [
    "primary",
    ...V08_A19_F184_HUMAN_PLACEMENT_AB_CELLS,
    "roster-a",
    "roster-b",
    "seat-green",
    "seat-red",
];

const quantile = (sorted: readonly number[], probability: number): number => {
    if (!sorted.length) return 0;
    const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(probability * sorted.length) - 1));
    return sorted[index];
};

const bootstrapBounds = (
    vectors: readonly (readonly [number, number, number, number])[],
    iterations: number,
): Readonly<Record<MetricKey, IBootstrapBounds>> => {
    if (!Number.isSafeInteger(iterations) || iterations <= 0)
        throw new RangeError("bootstrap iterations must be positive");
    const samples = Object.fromEntries(METRIC_KEYS.map((key) => [key, new Float64Array(iterations)])) as Record<
        MetricKey,
        Float64Array
    >;
    if (!vectors.length) {
        return Object.fromEntries(
            METRIC_KEYS.map((key) => [key, { low: 0, high: 0, bonferroniLower: 0 }]),
        ) as unknown as Readonly<Record<MetricKey, IBootstrapBounds>>;
    }
    let state = V08_A19_F184_HUMAN_PLACEMENT_AB_BOOTSTRAP_SEED;
    const random = (): number => {
        state = (state + 0x6d2b_79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
    };
    for (let iteration = 0; iteration < iterations; iteration += 1) {
        let ag = 0;
        let ar = 0;
        let bg = 0;
        let br = 0;
        for (let draw = 0; draw < vectors.length; draw += 1) {
            const sampled = vectors[Math.floor(random() * vectors.length)];
            ag += sampled[0];
            ar += sampled[1];
            bg += sampled[2];
            br += sampled[3];
        }
        const denominator = vectors.length;
        ag /= denominator;
        ar /= denominator;
        bg /= denominator;
        br /= denominator;
        samples["a-green"][iteration] = ag;
        samples["a-red"][iteration] = ar;
        samples["b-green"][iteration] = bg;
        samples["b-red"][iteration] = br;
        samples["roster-a"][iteration] = (ag + ar) / 2;
        samples["roster-b"][iteration] = (bg + br) / 2;
        samples["seat-green"][iteration] = (ag + bg) / 2;
        samples["seat-red"][iteration] = (ar + br) / 2;
        samples.primary[iteration] = (ag + ar + bg + br) / 4;
    }
    return Object.fromEntries(
        METRIC_KEYS.map((key) => {
            const sorted = [...samples[key]].sort((left, right) => left - right);
            return [
                key,
                {
                    low: quantile(sorted, 0.025),
                    high: quantile(sorted, 0.975),
                    bonferroniLower: quantile(
                        sorted,
                        V08_A19_F184_HUMAN_PLACEMENT_AB_GATES.cellBonferroniOneSidedAlpha,
                    ),
                },
            ];
        }),
    ) as unknown as Readonly<Record<MetricKey, IBootstrapBounds>>;
};

const metric = (
    key: string,
    values: readonly number[],
    bounds: IBootstrapBounds,
    outcomeChanges: number,
): IV08A19F184HumanPlacementAbMetric => {
    const meanDelta = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
    let clusteredStandardError: number | null = null;
    if (values.length >= 2) {
        const variance = values.reduce((sum, value) => sum + (value - meanDelta) ** 2, 0) / (values.length - 1);
        clusteredStandardError = Math.sqrt(variance / values.length);
    }
    const margin = clusteredStandardError === null ? 1 : 1.959963984540054 * clusteredStandardError;
    return {
        key,
        clusters: values.length,
        meanDelta,
        meanDeltaPp: meanDelta * 100,
        clusteredStandardError,
        normal95: { low: meanDelta - margin, high: meanDelta + margin },
        bootstrap95: { low: bounds.low, high: bounds.high },
        bootstrapBonferroniLower: bounds.bonferroniLower,
        outcomeChanges,
    };
};

export function summarizeV08A19F184HumanPlacementAbRecords(
    records: readonly IV08A19F184HumanPlacementAbClusterRecord[],
    bootstrapIterations: number = V08_A19_F184_HUMAN_PLACEMENT_AB_BOOTSTRAP_ITERATIONS,
): IV08A19F184HumanPlacementAbSummaryRows {
    const effects = records.map(causalV08A19F184HumanPlacementEffects);
    const vectors = effects.map(
        (entry) =>
            [entry["a-green"].delta, entry["a-red"].delta, entry["b-green"].delta, entry["b-red"].delta] as const,
    );
    const bounds = bootstrapBounds(vectors, bootstrapIterations);
    const valuesFor = (cell: V08A19F184HumanPlacementAbCell): number[] => effects.map((entry) => entry[cell].delta);
    const changesFor = (cells: readonly V08A19F184HumanPlacementAbCell[]): number =>
        effects.reduce(
            (sum, entry) => sum + cells.reduce((inner, cell) => inner + Number(entry[cell].outcomeChanged), 0),
            0,
        );
    const combined = (cells: readonly V08A19F184HumanPlacementAbCell[]): number[] =>
        effects.map((entry) => cells.reduce((sum, cell) => sum + entry[cell].delta, 0) / cells.length);
    const primaryValues = combined(V08_A19_F184_HUMAN_PLACEMENT_AB_CELLS);
    const cells = Object.fromEntries(
        V08_A19_F184_HUMAN_PLACEMENT_AB_CELLS.map((cell) => [
            cell,
            metric(cell, valuesFor(cell), bounds[cell], changesFor([cell])),
        ]),
    ) as unknown as Readonly<Record<V08A19F184HumanPlacementAbCell, IV08A19F184HumanPlacementAbMetric>>;
    return {
        estimand: "mean direct draw-aware score delta across the four exact roster-by-seat cells",
        clusters: records.length,
        games: records.length * V08_A19_F184_HUMAN_PLACEMENT_AB_CLUSTER_SIZE,
        bootstrapIterations,
        primary: metric("primary", primaryValues, bounds.primary, changesFor(V08_A19_F184_HUMAN_PLACEMENT_AB_CELLS)),
        cells,
        rosters: {
            a: metric("roster-a", combined(["a-green", "a-red"]), bounds["roster-a"], changesFor(["a-green", "a-red"])),
            b: metric("roster-b", combined(["b-green", "b-red"]), bounds["roster-b"], changesFor(["b-green", "b-red"])),
        },
        seats: {
            green: metric(
                "seat-green",
                combined(["a-green", "b-green"]),
                bounds["seat-green"],
                changesFor(["a-green", "b-green"]),
            ),
            red: metric("seat-red", combined(["a-red", "b-red"]), bounds["seat-red"], changesFor(["a-red", "b-red"])),
        },
    };
}

const expectedOpeningId = (roster: V08A19F184HumanPlacementAbRoster): V08A19F184HumanOpeningId =>
    roster === "a" ? "prod-f184-lower-roster" : "prod-f184-upper-roster";

const objectsEqual = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

export function validateV08A19F184HumanPlacementAbRecords(
    records: readonly IV08A19F184HumanPlacementAbClusterRecord[],
    options: Pick<IV08A19F184HumanPlacementAbRunnerOptions, "clusters" | "baseSeed">,
    rawLines: number,
    sourceUnchanged: boolean,
): IV08A19F184HumanPlacementAbQuality {
    const expected = new Set(Array.from({ length: options.clusters }, (_, cluster) => cluster));
    const seen = new Set<number>();
    let malformedClusters = 0;
    let duplicateClusters = 0;
    let auditMismatches = 0;
    let coordinateMismatches = 0;
    let rejectedActions = 0;
    let stuckGames = 0;
    let armageddonDecided = 0;
    let treatmentGames = 0;
    let validTreatmentAudits = 0;
    for (const record of records) {
        let malformed = false;
        if (seen.has(record.cluster)) duplicateClusters += 1;
        seen.add(record.cluster);
        expected.delete(record.cluster);
        if (!Number.isSafeInteger(record.cluster) || record.cluster < 0 || record.cluster >= options.clusters) {
            malformed = true;
        }
        const prepared =
            Number.isSafeInteger(record.cluster) && record.cluster >= 0
                ? prepareV08A19ProdF184Pair(options.baseSeed, record.cluster)
                : undefined;
        const expectedFingerprints = prepared
            ? {
                  a: fingerprintV08A19F184HumanPlacementArmy(prepared.armyA),
                  b: fingerprintV08A19F184HumanPlacementArmy(prepared.armyB),
              }
            : undefined;
        if (
            record.schema !== V08_A19_F184_HUMAN_PLACEMENT_AB_SCHEMA ||
            !objectsEqual(record.productionAnchor, V08_A19_F184_HUMAN_PLACEMENT_AB_BINDING) ||
            record.map !== V08_A19_F184_HUMAN_PLACEMENT_AB_MAP ||
            !prepared ||
            record.setupSeed !== prepared.setupSeed ||
            record.combatSeed !== prepared.combatSeed ||
            !objectsEqual(record.armyFingerprints, expectedFingerprints) ||
            record.games.length !== V08_A19_F184_HUMAN_PLACEMENT_AB_CLUSTER_SIZE
        ) {
            malformed = true;
        }
        const armies = prepared ? ({ a: prepared.armyA, b: prepared.armyB } as const) : undefined;
        for (let index = 0; index < record.games.length; index += 1) {
            const game = record.games[index];
            const scheduled = V08_A19_F184_HUMAN_PLACEMENT_AB_SCHEDULE[index];
            if (!scheduled) {
                malformed = true;
                continue;
            }
            const expectedScores = scoreByRoster(game.winner, scheduled);
            const expectedSetupFingerprint = armies
                ? fingerprintV08A19F184HumanPlacementSetup(
                      armies[scheduled.greenRoster],
                      armies[scheduled.redRoster],
                      V08_A19_F184_HUMAN_PLACEMENT_AB_MAP,
                  )
                : undefined;
            if (
                game.scheduleId !== scheduled.id ||
                game.greenRoster !== scheduled.greenRoster ||
                game.redRoster !== scheduled.redRoster ||
                game.treatedRoster !== scheduled.treatedRoster ||
                game.treatedSide !== scheduled.treatedSide ||
                game.cell !== scheduled.cell ||
                !objectsEqual(game.scoreByRoster, expectedScores) ||
                game.setupFingerprint !== expectedSetupFingerprint ||
                !Number.isSafeInteger(game.laps) ||
                game.laps < 0 ||
                !["elimination", "turn_cap", "stuck"].includes(game.endReason) ||
                !Number.isSafeInteger(game.rejectedGreen) ||
                game.rejectedGreen < 0 ||
                !Number.isSafeInteger(game.rejectedRed) ||
                game.rejectedRed < 0
            ) {
                malformed = true;
            }
            rejectedActions += game.rejectedGreen + game.rejectedRed;
            stuckGames += Number(game.endReason === "stuck");
            armageddonDecided += Number(game.armageddonDecided);
            if (scheduled.treatedRoster === null || scheduled.treatedSide === null) {
                if (game.candidateAudit !== null || game.candidateCanonicalPlacement !== null) {
                    auditMismatches += 1;
                    malformed = true;
                }
                continue;
            }
            treatmentGames += 1;
            const audit = game.candidateAudit;
            const auditValid =
                audit !== null &&
                audit.treatmentApplied === true &&
                audit.placementChanged === true &&
                audit.openingId === expectedOpeningId(scheduled.treatedRoster) &&
                audit.templateUnitsMoved === 6 &&
                audit.fallbackReason === null &&
                Number.isFinite(audit.horizontalDisplacement) &&
                audit.horizontalDisplacement >= 0 &&
                audit.incumbentFingerprint.length > 0 &&
                audit.selectedFingerprint.length > 0 &&
                audit.incumbentFingerprint !== audit.selectedFingerprint;
            if (!auditValid) {
                auditMismatches += 1;
                malformed = true;
            } else {
                validTreatmentAudits += 1;
            }
            if (
                !objectsEqual(
                    game.candidateCanonicalPlacement,
                    expectedV08A19F184CanonicalPlacement(scheduled.treatedRoster),
                )
            ) {
                coordinateMismatches += 1;
                malformed = true;
            }
        }
        if (malformed) malformedClusters += 1;
    }
    if (records.length !== options.clusters || rawLines !== options.clusters) malformedClusters += 1;
    return {
        expectedClusters: options.clusters,
        clusters: records.length,
        games: records.length * V08_A19_F184_HUMAN_PLACEMENT_AB_CLUSTER_SIZE,
        rawLines,
        malformedClusters,
        duplicateClusters,
        missingClusters: expected.size,
        auditMismatches,
        coordinateMismatches,
        rejectedActions,
        stuckGames,
        armageddonDecided,
        treatmentGames,
        validTreatmentAudits,
        sourceUnchanged,
    };
}

export function completeV08A19F184HumanPlacementAbQuality(quality: IV08A19F184HumanPlacementAbQuality): boolean {
    return (
        quality.clusters === quality.expectedClusters &&
        quality.games === quality.expectedClusters * V08_A19_F184_HUMAN_PLACEMENT_AB_CLUSTER_SIZE &&
        quality.rawLines === quality.expectedClusters &&
        quality.malformedClusters === 0 &&
        quality.duplicateClusters === 0 &&
        quality.missingClusters === 0 &&
        quality.auditMismatches === 0 &&
        quality.coordinateMismatches === 0 &&
        quality.rejectedActions === 0 &&
        quality.stuckGames === 0 &&
        quality.treatmentGames === quality.expectedClusters * 4 &&
        quality.validTreatmentAudits === quality.expectedClusters * 4 &&
        quality.sourceUnchanged
    );
}

export function evaluateV08A19F184HumanPlacementAbGates(
    summary: IV08A19F184HumanPlacementAbSummaryRows,
    options: Pick<IV08A19F184HumanPlacementAbRunnerOptions, "stage" | "clusters">,
    completeQuality: boolean,
): Readonly<Record<string, boolean>> {
    return {
        preregisteredValidationStage: options.stage === "validation",
        fixedValidationGeometry:
            options.clusters === V08_A19_F184_HUMAN_PLACEMENT_AB_CLUSTERS_BY_STAGE.validation &&
            summary.clusters === options.clusters &&
            summary.games === options.clusters * V08_A19_F184_HUMAN_PLACEMENT_AB_CLUSTER_SIZE &&
            summary.bootstrapIterations === V08_A19_F184_HUMAN_PLACEMENT_AB_BOOTSTRAP_ITERATIONS,
        completeQuality,
        outcomeSensitivity: summary.primary.outcomeChanges > 0,
        positivePrimaryPoint: summary.primary.meanDelta > 0,
        primaryClusteredNormal:
            summary.primary.normal95.low > V08_A19_F184_HUMAN_PLACEMENT_AB_GATES.primaryNormalCiLowExclusive,
        primaryClusterBootstrap:
            summary.primary.bootstrap95.low > V08_A19_F184_HUMAN_PLACEMENT_AB_GATES.primaryBootstrapCiLowExclusive,
        everyCellObservedNonnegative: Object.values(summary.cells).every(
            (row) => row.meanDelta >= V08_A19_F184_HUMAN_PLACEMENT_AB_GATES.cellPointDeltaInclusive,
        ),
        everyCellBonferroniNoninferior: Object.values(summary.cells).every(
            (row) => row.bootstrapBonferroniLower > -V08_A19_F184_HUMAN_PLACEMENT_AB_GATES.cellNoninferiorityMargin,
        ),
        bothRostersPositive: Object.values(summary.rosters).every(
            (row) => row.meanDelta > V08_A19_F184_HUMAN_PLACEMENT_AB_GATES.rosterPointDeltaExclusive,
        ),
        bothSeatsPositive: Object.values(summary.seats).every(
            (row) => row.meanDelta > V08_A19_F184_HUMAN_PLACEMENT_AB_GATES.seatPointDeltaExclusive,
        ),
    };
}

const sourceIdentity = (): { readonly commit: string; readonly sha256: string; readonly files: number } => {
    const root = resolve(import.meta.dir, "../..");
    const walk = (directory: string): string[] =>
        readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
            const path = join(directory, entry.name);
            return entry.isDirectory() ? walk(path) : entry.isFile() ? [relative(root, path)] : [];
        });
    const files = [
        ...new Set([
            ...walk(join(root, "src")),
            ...["package.json", "bun.lock", "bunfig.toml"].filter((file) => existsSync(join(root, file))),
        ]),
    ].sort();
    const hash = createHash("sha256");
    for (const file of files) {
        hash.update(file);
        hash.update("\0");
        hash.update(readFileSync(join(root, file)));
        hash.update("\0");
    }
    return {
        commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
        sha256: hash.digest("hex"),
        files: files.length,
    };
};

const environmentSha256 = (): string =>
    sha256(
        Object.entries(buildV08A19F184HumanPlacementAbEnvironment()).sort(([left], [right]) =>
            left.localeCompare(right),
        ),
    );

interface IWorkerTask {
    readonly cluster: number;
}

async function runTasks(
    options: IV08A19F184HumanPlacementAbRunnerOptions,
    rawPath: string,
): Promise<IV08A19F184HumanPlacementAbClusterRecord[]> {
    const tasks: IWorkerTask[] = Array.from({ length: options.clusters }, (_, cluster) => ({ cluster }));
    const records: IV08A19F184HumanPlacementAbClusterRecord[] = [];
    const environment = minimalWorkerEnvironment();
    let dispatched = 0;
    let completed = 0;
    let lastProgress = Date.now();
    return new Promise((resolvePromise, rejectPromise) => {
        const workers: Worker[] = [];
        const draining = new WeakSet<Worker>();
        let settled = false;
        const cleanup = (): void => workers.forEach((worker) => void worker.terminate());
        const fail = (error: unknown): void => {
            if (settled) return;
            settled = true;
            cleanup();
            rejectPromise(error instanceof Error ? error : new Error(String(error)));
        };
        const dispatch = (worker: Worker): void => {
            const task = tasks[dispatched++];
            if (!task) {
                draining.add(worker);
                worker.postMessage({ type: "stop" } satisfies IV08A19F184HumanPlacementAbWorkerRequest);
                return;
            }
            worker.postMessage({
                type: "cluster",
                options: { clusters: options.clusters, baseSeed: options.baseSeed, maxLaps: options.maxLaps },
                cluster: task.cluster,
            } satisfies IV08A19F184HumanPlacementAbWorkerRequest);
        };
        for (let index = 0; index < Math.min(options.concurrency, tasks.length); index += 1) {
            const worker = new Worker(new URL("./v0_8_a19_f184_human_placement_ab_worker.ts", import.meta.url), {
                env: environment,
            });
            workers.push(worker);
            worker.on("message", (message: IV08A19F184HumanPlacementAbWorkerResponse) => {
                if (settled) return;
                if (message.type === "error") {
                    fail(new Error(message.error));
                    return;
                }
                if (message.type === "ready") {
                    dispatch(worker);
                    return;
                }
                records.push(message.record);
                appendFileSync(rawPath, `${JSON.stringify(message.record)}\n`);
                completed += 1;
                const now = Date.now();
                if (now - lastProgress >= 5_000 || completed === tasks.length) {
                    lastProgress = now;
                    console.error(
                        `[a19-f184-human-placement-ab] ${completed}/${tasks.length} clusters ` +
                            `(${completed * V08_A19_F184_HUMAN_PLACEMENT_AB_CLUSTER_SIZE} fights)`,
                    );
                }
                if (completed === tasks.length) {
                    settled = true;
                    cleanup();
                    records.sort((left, right) => left.cluster - right.cluster);
                    resolvePromise(records);
                    return;
                }
                dispatch(worker);
            });
            worker.on("error", fail);
            worker.on("exit", (code) => {
                if (!settled && (!draining.has(worker) || code !== 0)) {
                    fail(new Error(`f184 human-placement A/B worker exited unexpectedly with code ${code}`));
                }
            });
        }
    });
}

export async function runV08A19F184HumanPlacementAb(
    options: IV08A19F184HumanPlacementAbRunnerOptions,
): Promise<Record<string, unknown>> {
    if (
        options.clusters !== V08_A19_F184_HUMAN_PLACEMENT_AB_CLUSTERS_BY_STAGE[options.stage] ||
        options.baseSeed !== V08_A19_F184_HUMAN_PLACEMENT_AB_SEEDS[options.stage] ||
        options.concurrency !== 12 ||
        options.maxLaps !== 60
    ) {
        throw new Error("f184 human-placement A/B options escaped the fixed stage contract");
    }
    if (existsSync(options.output)) {
        throw new Error(`Refusing to resume or overwrite existing f184 human-placement output ${options.output}`);
    }
    mkdirSync(options.output, { recursive: false });
    const rawPath = join(options.output, V08_A19_F184_HUMAN_PLACEMENT_AB_RAW_FILE);
    writeFileSync(rawPath, "");
    const sourceBefore = sourceIdentity();
    const startedAt = new Date();
    const startedMs = Date.now();
    writeFileSync(
        join(options.output, V08_A19_F184_HUMAN_PLACEMENT_AB_STARTED_FILE),
        `${JSON.stringify(
            {
                schema: V08_A19_F184_HUMAN_PLACEMENT_AB_SCHEMA,
                stage: options.stage,
                options,
                schedule: V08_A19_F184_HUMAN_PLACEMENT_AB_SCHEDULE,
                candidateProfile: V08_A19_H18_F184_HUMAN_PLACEMENT_PROFILE,
                productionAnchor: {
                    binding: V08_A19_F184_HUMAN_PLACEMENT_AB_BINDING,
                    fixture: V08_A19_PROD_F184_ANCHOR,
                },
                sourceBefore,
                environmentSha256: environmentSha256(),
                startedAt: startedAt.toISOString(),
            },
            null,
            2,
        )}\n`,
    );
    const records = await runTasks(options, rawPath);
    const sourceAfter = sourceIdentity();
    const sourceUnchanged = sourceBefore.sha256 === sourceAfter.sha256;
    writeFileSync(rawPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    const rawLines = readFileSync(rawPath, "utf8").split("\n").filter(Boolean).length;
    const quality = validateV08A19F184HumanPlacementAbRecords(records, options, rawLines, sourceUnchanged);
    const complete = completeV08A19F184HumanPlacementAbQuality(quality);
    const rankings = summarizeV08A19F184HumanPlacementAbRecords(records);
    const gateResults = evaluateV08A19F184HumanPlacementAbGates(rankings, options, complete);
    const validationPassed = Object.values(gateResults).every(Boolean);
    const summary = {
        schema: V08_A19_F184_HUMAN_PLACEMENT_AB_SCHEMA,
        complete,
        stage: options.stage,
        generatedAt: new Date().toISOString(),
        seconds: (Date.now() - startedMs) / 1_000,
        options: {
            ...options,
            clusterSize: V08_A19_F184_HUMAN_PLACEMENT_AB_CLUSTER_SIZE,
            totalGames: options.clusters * V08_A19_F184_HUMAN_PLACEMENT_AB_CLUSTER_SIZE,
        },
        estimand: {
            primary: rankings.estimand,
            treatment: V08_A19_H18_F184_HUMAN_PLACEMENT_PROFILE.candidateId,
            control: `${V08_A19_H18_F184_HUMAN_PLACEMENT_PROFILE.derivesFrom.candidateId} with plain StrategyV0_8 placement`,
            pairing: "same exact setup and combat seed; opposing army remains plain v0.8 in each direct contrast",
            weighting: "four roster-by-seat cells weighted equally within combat-seed cluster",
            draws: "0.5 score",
            inference:
                "normal cluster interval plus deterministic percentile bootstrap resampled by combat-seed cluster",
            excludedGate: "raw roster candidate win rates are descriptive army strength and are not promotion gates",
        },
        rankings,
        quality,
        validation: {
            gates: V08_A19_F184_HUMAN_PLACEMENT_AB_GATES,
            results: gateResults,
            passed: validationPassed,
            rule: "validation passes only when every causal-efficacy, cell-safety, audit, coordinate, and provenance gate passes",
        },
        provenance: {
            candidateProfile: V08_A19_H18_F184_HUMAN_PLACEMENT_PROFILE,
            productionAnchor: {
                binding: V08_A19_F184_HUMAN_PLACEMENT_AB_BINDING,
                fixture: V08_A19_PROD_F184_ANCHOR,
            },
            schedule: V08_A19_F184_HUMAN_PLACEMENT_AB_SCHEDULE,
            sourceBefore,
            sourceAfter,
            environmentSha256: environmentSha256(),
            startedAt: startedAt.toISOString(),
            runtime: { bun: Bun.version, platform: platform(), arch: arch() },
        },
    };
    writeFileSync(
        join(options.output, V08_A19_F184_HUMAN_PLACEMENT_AB_SUMMARY_FILE),
        `${JSON.stringify(summary, null, 2)}\n`,
    );
    return summary;
}

async function main(): Promise<void> {
    const options = parseV08A19F184HumanPlacementAbOptions(process.argv.slice(2));
    const summary = await runV08A19F184HumanPlacementAb(options);
    console.log(JSON.stringify(summary, null, 2));
    const validationPassed = (summary.validation as { readonly passed?: boolean } | undefined)?.passed === true;
    if (summary.complete !== true || (options.stage === "validation" && !validationPassed)) process.exitCode = 1;
}

if (import.meta.main) {
    void main().catch((error) => {
        console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
        process.exitCode = 1;
    });
}
