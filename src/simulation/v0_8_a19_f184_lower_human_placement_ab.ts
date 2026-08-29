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
    createV08A19H18F184LowerHumanPlacementStrategy,
    V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_PROFILE,
} from "../ai/versions/v0_8_a19_h18_f184_lower_human_placement_profile";
import type {
    IV08A19F184LowerHumanPlacementAudit,
    V08A19F184LowerHumanOpeningId,
    V08A19F184LowerHumanPlacementStrategy,
} from "../ai/versions/v0_8_a19_f184_lower_human_placement";
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

export const V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SCHEMA =
    "hoc.v0_8_a19_f184_lower_human_placement_deterministic_causal_ab.v15" as const;
export const V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_CLUSTER_SIZE = 4 as const;
export const V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_EXECUTIONS_PER_CLUSTER = 4 as const;
export const V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_MAP = PBTypes.GridVals.NORMAL;
export const V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_RAW_FILE =
    "v0-8-a19-f184-lower-human-placement-ab-v15.records.jsonl" as const;
export const V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SUMMARY_FILE =
    "v0-8-a19-f184-lower-human-placement-ab-v15.summary.json" as const;
export const V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_STARTED_FILE =
    "v0-8-a19-f184-lower-human-placement-ab-v15.started.json" as const;
export const V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_BOOTSTRAP_ITERATIONS = 100_000 as const;
export const V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_BOOTSTRAP_SEED = 1_758_619_397 as const;

export type V08A19F184LowerHumanPlacementAbStage = "smoke" | "development" | "validation";
export type V08A19F184LowerHumanPlacementAbRoster = "a" | "b";
export type V08A19F184LowerHumanPlacementAbCell = "a-green" | "b-green";

export const V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_CLUSTERS_BY_STAGE: Readonly<
    Record<V08A19F184LowerHumanPlacementAbStage, number>
> = Object.freeze({
    smoke: 8,
    development: 360,
    validation: 1_440,
});

export const V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SEEDS: Readonly<
    Record<V08A19F184LowerHumanPlacementAbStage, number>
> = Object.freeze({
    smoke: 76_047_795,
    development: 3_970_129_719,
    validation: 2_821_051_359,
});

/**
 * Placement efficacy is estimated without host-speed-dependent search exits. The A19/H18 horizon, shortlist,
 * rollout count, model, and seeded combat remain exact; only the two real-time fallbacks are disabled. Ranked
 * latency and circuit behavior are a separate runtime qualification and are not allowed to alter causal labels.
 */
export const V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_TIMING = Object.freeze({
    estimand: "deterministic-policy-efficacy" as const,
    decisionDeadlineMs: null,
    circuitBreakerMs: null,
    workerIsolation: "fresh-one-shot-worker-per-scheduled-game" as const,
    physicalOrder: "balanced-four-position-rotation-independent-of-logical-schedule" as const,
});

export const V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_CELLS = Object.freeze(["a-green", "b-green"] as const);

export interface IV08A19F184LowerHumanPlacementAbScheduleEntry {
    readonly id: "ab-control" | "ab-a-green-treated" | "ba-control" | "ba-b-green-treated";
    readonly greenRoster: V08A19F184LowerHumanPlacementAbRoster;
    readonly redRoster: V08A19F184LowerHumanPlacementAbRoster;
    readonly treatedRoster: V08A19F184LowerHumanPlacementAbRoster | null;
    readonly treatedSide: Side | null;
    readonly cell: V08A19F184LowerHumanPlacementAbCell | null;
}

/**
 * Four unique fights identify both LOWER-side direct effects. Each production roster is treated once while
 * LOWER, against the same-orientation plain-v0.8 control; UPPER is never decorated.
 */
export const V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SCHEDULE = Object.freeze([
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
] as const satisfies readonly IV08A19F184LowerHumanPlacementAbScheduleEntry[]);

export type V08A19F184LowerHumanPlacementAbExecutionId =
    (typeof V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SCHEDULE)[number]["id"];

/** Deliberately scrambled from the logical record order; four-cluster rotation balances every physical slot. */
const V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_BALANCED_PHYSICAL_ORDER = Object.freeze([
    "ba-b-green-treated",
    "ab-control",
    "ba-control",
    "ab-a-green-treated",
] as const satisfies readonly V08A19F184LowerHumanPlacementAbExecutionId[]);

const V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SCHEDULE_BY_ID = new Map(
    V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SCHEDULE.map((entry) => [entry.id, entry]),
);

export const V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_BINDING = Object.freeze({
    fixtureId: V08_A19_PROD_F184_FIXTURE_ID,
    matchId: V08_A19_PROD_F184_MATCH_ID,
    sha256: V08_A19_PROD_F184_FIXTURE_SHA256,
});

export const V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SOURCE_FILES = Object.freeze([
    "src/ai/versions/v0_8_a19_f184_human_placement.ts",
    "src/ai/versions/v0_8_a19_f184_lower_human_placement.ts",
    "src/ai/versions/v0_8_a19_h18_f184_human_placement_profile.ts",
    "src/ai/versions/v0_8_a19_h18_f184_lower_human_placement_profile.ts",
    "src/simulation/v0_8_a19_prod_f184_anchor.ts",
    "src/simulation/v0_8_a19_f184_lower_human_placement_ab.ts",
    "src/simulation/v0_8_a19_f184_lower_human_placement_ab_worker.ts",
] as const);

export const V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_GATES = Object.freeze({
    primaryNormalCiLowExclusive: 0,
    primaryBootstrapCiLowExclusive: 0,
    rosterNoninferiorityMargin: 0.01,
    rosterBonferroniOneSidedAlpha: 0.025,
    rosterPointDeltaExclusive: 0,
});

export interface IV08A19F184LowerHumanPlacementAbRunnerOptions {
    readonly stage: V08A19F184LowerHumanPlacementAbStage;
    readonly clusters: number;
    readonly baseSeed: number;
    readonly concurrency: 12;
    readonly maxLaps: 60;
    readonly output: string;
}

export interface IV08A19F184LowerHumanPlacementAbClusterOptions {
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

export interface IV08A19F184LowerHumanPlacementAbGameOutcome {
    readonly scheduleId: (typeof V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SCHEDULE)[number]["id"];
    readonly greenRoster: V08A19F184LowerHumanPlacementAbRoster;
    readonly redRoster: V08A19F184LowerHumanPlacementAbRoster;
    readonly treatedRoster: V08A19F184LowerHumanPlacementAbRoster | null;
    readonly treatedSide: Side | null;
    readonly cell: V08A19F184LowerHumanPlacementAbCell | null;
    readonly winner: Side | "draw";
    readonly scoreByRoster: Readonly<Record<V08A19F184LowerHumanPlacementAbRoster, number>>;
    readonly laps: number;
    readonly endReason: IMatchResult["endReason"];
    readonly armageddonDecided: boolean;
    readonly rejectedGreen: number;
    readonly rejectedRed: number;
    readonly setupFingerprint: string;
    readonly candidateAudit: IV08A19F184LowerHumanPlacementAudit | null;
    readonly candidateCanonicalPlacement: readonly IV08A19F184CanonicalPlacementRow[] | null;
}

export interface IV08A19F184LowerHumanPlacementAbClusterRecord {
    readonly schema: typeof V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SCHEMA;
    readonly productionAnchor: typeof V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_BINDING;
    readonly candidateIdentity: typeof V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_CANDIDATE_IDENTITY;
    readonly cluster: number;
    readonly setupSeed: number;
    readonly combatSeed: number;
    readonly map: typeof V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_MAP;
    readonly armyFingerprints: Readonly<Record<V08A19F184LowerHumanPlacementAbRoster, string>>;
    readonly physicalExecutionOrder: readonly V08A19F184LowerHumanPlacementAbExecutionId[];
    readonly isolateIds: Readonly<Record<V08A19F184LowerHumanPlacementAbExecutionId, string>>;
    readonly games: readonly [
        IV08A19F184LowerHumanPlacementAbGameOutcome,
        IV08A19F184LowerHumanPlacementAbGameOutcome,
        IV08A19F184LowerHumanPlacementAbGameOutcome,
        IV08A19F184LowerHumanPlacementAbGameOutcome,
    ];
}

export interface IV08A19F184LowerHumanPlacementAbCellEffect {
    readonly cluster: number;
    readonly cell: V08A19F184LowerHumanPlacementAbCell;
    readonly roster: V08A19F184LowerHumanPlacementAbRoster;
    readonly side: Side;
    readonly baselineScore: number;
    readonly candidateScore: number;
    readonly delta: number;
    readonly outcomeChanged: boolean;
}

export interface IV08A19F184LowerHumanPlacementAbMetric {
    readonly key: string;
    readonly clusters: number;
    readonly meanDelta: number;
    readonly meanDeltaPp: number;
    readonly clusteredStandardError: number | null;
    readonly normal95: { readonly low: number; readonly high: number };
    readonly bootstrap95: { readonly low: number; readonly high: number };
    /** One-sided lower bound at alpha=.025, Bonferroni-adjusted for the two-roster family. */
    readonly bootstrapBonferroniLower: number;
    readonly outcomeChanges: number;
}

export interface IV08A19F184LowerHumanPlacementAbSummaryRows {
    readonly estimand: "mean direct draw-aware LOWER score delta across the two exact production rosters";
    readonly clusters: number;
    readonly games: number;
    readonly bootstrapIterations: number;
    readonly primary: IV08A19F184LowerHumanPlacementAbMetric;
    readonly cells: Readonly<Record<V08A19F184LowerHumanPlacementAbCell, IV08A19F184LowerHumanPlacementAbMetric>>;
    readonly rosters: Readonly<Record<V08A19F184LowerHumanPlacementAbRoster, IV08A19F184LowerHumanPlacementAbMetric>>;
}

export interface IV08A19F184LowerHumanPlacementAbQuality {
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
    readonly implementationBytesVerified: boolean;
}

export interface IV08A19F184LowerHumanPlacementAbWorkerGameRequest {
    readonly options: IV08A19F184LowerHumanPlacementAbClusterOptions;
    readonly cluster: number;
    readonly executionId: V08A19F184LowerHumanPlacementAbExecutionId;
}

export type IV08A19F184LowerHumanPlacementAbWorkerRequest =
    | { readonly type: "game"; readonly game: IV08A19F184LowerHumanPlacementAbWorkerGameRequest }
    | { readonly type: "probe"; readonly probeId: string };

export type IV08A19F184LowerHumanPlacementAbWorkerResponse =
    | {
          readonly type: "result";
          readonly executionId: V08A19F184LowerHumanPlacementAbExecutionId;
          readonly isolateId: string;
          readonly outcome: IV08A19F184LowerHumanPlacementAbGameOutcome;
      }
    | {
          readonly type: "probe";
          readonly probeId: string;
          readonly isolateId: string;
          readonly environmentSha256: string;
      }
    | { readonly type: "error"; readonly error: string };

export type V08A19F184LowerHumanPlacementAbGameExecutor = (
    request: IV08A19F184LowerHumanPlacementAbWorkerGameRequest,
) => Promise<Extract<IV08A19F184LowerHumanPlacementAbWorkerResponse, { type: "result" }>>;

const positiveInteger = (raw: string | undefined, label: string, fallback: number): number => {
    const value = Number(raw ?? fallback);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
    return value;
};

export function parseV08A19F184LowerHumanPlacementAbOptions(
    argv: readonly string[],
): IV08A19F184LowerHumanPlacementAbRunnerOptions {
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
    const stage = (values.stage ?? "smoke") as V08A19F184LowerHumanPlacementAbStage;
    if (stage !== "smoke" && stage !== "development" && stage !== "validation") {
        throw new Error("stage must be smoke, development, or validation");
    }
    if (!values.output) throw new Error("--output is required and must name a fresh directory");
    const concurrency = positiveInteger(values.concurrency, "concurrency", 12);
    if (concurrency !== 12) throw new Error("f184 lower-only human-placement A/B requires concurrency 12");
    return {
        stage,
        clusters: V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_CLUSTERS_BY_STAGE[stage],
        baseSeed: V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SEEDS[stage],
        concurrency: 12,
        maxLaps: 60,
        output: resolve(values.output),
    };
}

/** Exact dual-seat A19/H18 policy environment; only host-speed-dependent exits are removed. */
export function buildV08A19F184LowerHumanPlacementAbEnvironment(): Record<string, string> {
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
    environment.SEARCH_DECISION_DEADLINE_MS = "";
    environment.SEARCH_CIRCUIT_BREAKER_MS = "";
    if (environment.V07_SEARCH !== "1" || environment.SEARCH_HORIZON !== "18" || environment.SEARCH_SHORTLIST !== "3") {
        throw new Error("f184 lower-only human-placement A/B requires the exact A19/H18 shortlist-3 search profile");
    }
    if (environment.SEARCH_DECISION_DEADLINE_MS !== "" || environment.SEARCH_CIRCUIT_BREAKER_MS !== "") {
        throw new Error("f184 placement efficacy must be independent of wall-clock search exits");
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
    return Object.assign(environment, buildV08A19F184LowerHumanPlacementAbEnvironment());
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

export const V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_PROFILE_SHA256 = sha256(
    V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_PROFILE,
);
export const V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_POLICY_BINDING_SHA256 = sha256(
    V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_PROFILE.placementPolicy,
);
export const V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_CANDIDATE_IDENTITY = Object.freeze({
    candidateId: V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_PROFILE.candidateId,
    profileSchema: V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_PROFILE.schema,
    profileSha256: V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_PROFILE_SHA256,
    policyBindingSha256: V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_POLICY_BINDING_SHA256,
    implementationSource: V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_PROFILE.placementPolicy.implementationSource,
    implementationSha256: V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_PROFILE.placementPolicy.implementationSha256,
    upstreamImplementation: V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_PROFILE.placementPolicy.upstreamImplementation,
});

export const fingerprintV08A19F184LowerHumanPlacementArmy = (army: IAiMetaArmy): string => sha256(armySetup(army));

export const fingerprintV08A19F184LowerHumanPlacementSetup = (
    green: IAiMetaArmy,
    red: IAiMetaArmy,
    map: number,
): string => sha256({ green: armySetup(green), red: armySetup(red), map });

const sourceSideForRoster = (roster: V08A19F184LowerHumanPlacementAbRoster): Side => (roster === "a" ? "green" : "red");

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
    roster: V08A19F184LowerHumanPlacementAbRoster,
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
    entry: IV08A19F184LowerHumanPlacementAbScheduleEntry,
): Readonly<Record<V08A19F184LowerHumanPlacementAbRoster, number>> =>
    ({
        [entry.greenRoster]: scoreForSide(winner, "green"),
        [entry.redRoster]: scoreForSide(winner, "red"),
    }) as Readonly<Record<V08A19F184LowerHumanPlacementAbRoster, number>>;

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
    gridType: V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_MAP,
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
    entry: IV08A19F184LowerHumanPlacementAbScheduleEntry,
    armies: Readonly<Record<V08A19F184LowerHumanPlacementAbRoster, IAiMetaArmy>>,
    combatSeed: number,
    maxLaps: 60,
): IV08A19F184LowerHumanPlacementAbGameOutcome => {
    const green = armies[entry.greenRoster];
    const red = armies[entry.redRoster];
    let greenStrategy: IAIStrategy = strategyForControl();
    let redStrategy: IAIStrategy = strategyForControl();
    let candidateStrategy: V08A19F184LowerHumanPlacementStrategy | undefined;
    if (entry.treatedSide !== null) {
        if (entry.treatedSide !== "green") throw new Error("lower-only f184 treatment must be green/LOWER");
        candidateStrategy = createV08A19H18F184LowerHumanPlacementStrategy();
        greenStrategy = candidateStrategy;
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
        setupFingerprint: fingerprintV08A19F184LowerHumanPlacementSetup(
            green,
            red,
            V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_MAP,
        ),
        candidateAudit,
        candidateCanonicalPlacement,
    };
};

const assertClusterCoordinates = (options: IV08A19F184LowerHumanPlacementAbClusterOptions, cluster: number): void => {
    if (!Number.isSafeInteger(options.clusters) || options.clusters <= 0) {
        throw new RangeError("clusters must be a positive integer");
    }
    if (!Number.isSafeInteger(cluster) || cluster < 0 || cluster >= options.clusters) {
        throw new RangeError(`cluster ${cluster} is outside [0, ${options.clusters})`);
    }
};

export function planV08A19F184LowerHumanPlacementPhysicalOrder(
    options: Pick<IV08A19F184LowerHumanPlacementAbClusterOptions, "baseSeed">,
    cluster: number,
): readonly V08A19F184LowerHumanPlacementAbExecutionId[] {
    if (!Number.isSafeInteger(cluster) || cluster < 0) throw new RangeError("cluster must be a nonnegative integer");
    const width = V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_EXECUTIONS_PER_CLUSTER;
    const base =
        Math.floor(cluster / width) % 2
            ? [...V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_BALANCED_PHYSICAL_ORDER].reverse()
            : [...V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_BALANCED_PHYSICAL_ORDER];
    const offset = (cluster + (options.baseSeed >>> 0)) % width;
    return Object.freeze([...base.slice(offset), ...base.slice(0, offset)]);
}

/** Synchronous one-game core. Benchmark callers enter it through one disposable worker per invocation. */
export function playV08A19F184LowerHumanPlacementAbGame(
    request: IV08A19F184LowerHumanPlacementAbWorkerGameRequest,
): IV08A19F184LowerHumanPlacementAbGameOutcome {
    assertClusterCoordinates(request.options, request.cluster);
    const entry = V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SCHEDULE_BY_ID.get(request.executionId);
    if (!entry) throw new Error(`Unknown f184 lower-only v15 execution ${request.executionId}`);
    const prepared = prepareV08A19ProdF184Pair(request.options.baseSeed, request.cluster);
    return playScheduledGame(
        entry,
        { a: prepared.armyA, b: prepared.armyB },
        prepared.combatSeed,
        request.options.maxLaps,
    );
}

export async function runV08A19F184LowerHumanPlacementWorkerRequestInFreshIsolate(
    request: IV08A19F184LowerHumanPlacementAbWorkerRequest,
): Promise<Exclude<IV08A19F184LowerHumanPlacementAbWorkerResponse, { type: "error" }>> {
    const worker = new Worker(new URL("./v0_8_a19_f184_lower_human_placement_ab_worker.ts", import.meta.url), {
        env: minimalWorkerEnvironment(),
        workerData: request,
    });
    return new Promise((resolvePromise, rejectPromise) => {
        let settled = false;
        const fail = (error: unknown): void => {
            if (settled) return;
            settled = true;
            void worker.terminate();
            rejectPromise(error instanceof Error ? error : new Error(String(error)));
        };
        worker.once("message", (response: IV08A19F184LowerHumanPlacementAbWorkerResponse) => {
            if (settled) return;
            if (response.type === "error") {
                fail(new Error(response.error));
                return;
            }
            settled = true;
            void worker.terminate().then(() => resolvePromise(response), rejectPromise);
        });
        worker.once("error", fail);
        worker.once("exit", (code) => {
            if (!settled)
                fail(new Error(`f184 lower-only v15 fresh worker exited before responding with code ${code}`));
        });
    });
}

const freshGameExecutor: V08A19F184LowerHumanPlacementAbGameExecutor = async (request) => {
    const response = await runV08A19F184LowerHumanPlacementWorkerRequestInFreshIsolate({ type: "game", game: request });
    if (response.type !== "result") throw new Error("f184 lower-only v15 game worker returned a probe response");
    return response;
};

/** Root-side assembly of four logical games whose physical executions each occupy a fresh isolate. */
export async function playV08A19F184LowerHumanPlacementAbCluster(
    options: IV08A19F184LowerHumanPlacementAbClusterOptions,
    cluster: number,
    execute: V08A19F184LowerHumanPlacementAbGameExecutor = freshGameExecutor,
): Promise<IV08A19F184LowerHumanPlacementAbClusterRecord> {
    assertClusterCoordinates(options, cluster);
    const prepared = prepareV08A19ProdF184Pair(options.baseSeed, cluster);
    const physicalExecutionOrder = planV08A19F184LowerHumanPlacementPhysicalOrder(options, cluster);
    const responses = new Map<
        V08A19F184LowerHumanPlacementAbExecutionId,
        Extract<IV08A19F184LowerHumanPlacementAbWorkerResponse, { type: "result" }>
    >();
    for (const executionId of physicalExecutionOrder) {
        const response = await execute({ options, cluster, executionId });
        if (response.executionId !== executionId || response.outcome.scheduleId !== executionId) {
            throw new Error(`f184 lower-only v15 worker response identity drifted for ${executionId}`);
        }
        if (responses.has(executionId)) throw new Error(`Duplicate f184 lower-only v15 execution ${executionId}`);
        responses.set(executionId, response);
    }
    if (responses.size !== V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_EXECUTIONS_PER_CLUSTER) {
        throw new Error("f184 lower-only v15 cluster did not execute all four scheduled games");
    }
    const isolateIds = Object.fromEntries(
        [...responses].map(([executionId, response]) => [executionId, response.isolateId]),
    ) as Record<V08A19F184LowerHumanPlacementAbExecutionId, string>;
    if (new Set(Object.values(isolateIds)).size !== V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_EXECUTIONS_PER_CLUSTER) {
        throw new Error("f184 lower-only v15 cluster reused a game isolate");
    }
    const games = V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SCHEDULE.map((entry) => {
        const response = responses.get(entry.id);
        if (!response) throw new Error(`Missing f184 lower-only v15 game ${entry.id}`);
        const expectedSetup = fingerprintV08A19F184LowerHumanPlacementSetup(
            entry.greenRoster === "a" ? prepared.armyA : prepared.armyB,
            entry.redRoster === "a" ? prepared.armyA : prepared.armyB,
            V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_MAP,
        );
        if (response.outcome.setupFingerprint !== expectedSetup) {
            throw new Error(`f184 lower-only v15 setup drifted for ${entry.id}`);
        }
        return response.outcome;
    }) as unknown as IV08A19F184LowerHumanPlacementAbClusterRecord["games"];
    return {
        schema: V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SCHEMA,
        productionAnchor: V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_BINDING,
        candidateIdentity: V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_CANDIDATE_IDENTITY,
        cluster,
        setupSeed: prepared.setupSeed,
        combatSeed: prepared.combatSeed,
        map: V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_MAP,
        armyFingerprints: {
            a: fingerprintV08A19F184LowerHumanPlacementArmy(prepared.armyA),
            b: fingerprintV08A19F184LowerHumanPlacementArmy(prepared.armyB),
        },
        physicalExecutionOrder,
        isolateIds,
        games,
    };
}

const effect = (
    record: IV08A19F184LowerHumanPlacementAbClusterRecord,
    cell: V08A19F184LowerHumanPlacementAbCell,
    baselineIndex: 0 | 2,
    candidateIndex: 1 | 3,
): IV08A19F184LowerHumanPlacementAbCellEffect => {
    const [roster, side] = cell.split("-") as [V08A19F184LowerHumanPlacementAbRoster, Side];
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
export function causalV08A19F184LowerHumanPlacementEffects(
    record: IV08A19F184LowerHumanPlacementAbClusterRecord,
): Readonly<Record<V08A19F184LowerHumanPlacementAbCell, IV08A19F184LowerHumanPlacementAbCellEffect>> {
    return {
        "a-green": effect(record, "a-green", 0, 1),
        "b-green": effect(record, "b-green", 2, 3),
    };
}

interface IBootstrapBounds {
    readonly low: number;
    readonly high: number;
    readonly bonferroniLower: number;
}

type MetricKey = "primary" | V08A19F184LowerHumanPlacementAbCell | "roster-a" | "roster-b";

const METRIC_KEYS: readonly MetricKey[] = [
    "primary",
    ...V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_CELLS,
    "roster-a",
    "roster-b",
];

const quantile = (sorted: readonly number[], probability: number): number => {
    if (!sorted.length) return 0;
    const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(probability * sorted.length) - 1));
    return sorted[index];
};

const bootstrapBounds = (
    vectors: readonly (readonly [number, number])[],
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
    let state = V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_BOOTSTRAP_SEED;
    const random = (): number => {
        state = (state + 0x6d2b_79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
    };
    for (let iteration = 0; iteration < iterations; iteration += 1) {
        let ag = 0;
        let bg = 0;
        for (let draw = 0; draw < vectors.length; draw += 1) {
            const sampled = vectors[Math.floor(random() * vectors.length)];
            ag += sampled[0];
            bg += sampled[1];
        }
        const denominator = vectors.length;
        ag /= denominator;
        bg /= denominator;
        samples["a-green"][iteration] = ag;
        samples["b-green"][iteration] = bg;
        samples["roster-a"][iteration] = ag;
        samples["roster-b"][iteration] = bg;
        samples.primary[iteration] = (ag + bg) / 2;
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
                        V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_GATES.rosterBonferroniOneSidedAlpha,
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
): IV08A19F184LowerHumanPlacementAbMetric => {
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

export function summarizeV08A19F184LowerHumanPlacementAbRecords(
    records: readonly IV08A19F184LowerHumanPlacementAbClusterRecord[],
    bootstrapIterations: number = V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_BOOTSTRAP_ITERATIONS,
): IV08A19F184LowerHumanPlacementAbSummaryRows {
    const effects = records.map(causalV08A19F184LowerHumanPlacementEffects);
    const vectors = effects.map((entry) => [entry["a-green"].delta, entry["b-green"].delta] as const);
    const bounds = bootstrapBounds(vectors, bootstrapIterations);
    const valuesFor = (cell: V08A19F184LowerHumanPlacementAbCell): number[] =>
        effects.map((entry) => entry[cell].delta);
    const changesFor = (cells: readonly V08A19F184LowerHumanPlacementAbCell[]): number =>
        effects.reduce(
            (sum, entry) => sum + cells.reduce((inner, cell) => inner + Number(entry[cell].outcomeChanged), 0),
            0,
        );
    const primaryValues = effects.map((entry) => (entry["a-green"].delta + entry["b-green"].delta) / 2);
    const cells = Object.fromEntries(
        V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_CELLS.map((cell) => [
            cell,
            metric(cell, valuesFor(cell), bounds[cell], changesFor([cell])),
        ]),
    ) as unknown as Readonly<Record<V08A19F184LowerHumanPlacementAbCell, IV08A19F184LowerHumanPlacementAbMetric>>;
    return {
        estimand: "mean direct draw-aware LOWER score delta across the two exact production rosters",
        clusters: records.length,
        games: records.length * V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_CLUSTER_SIZE,
        bootstrapIterations,
        primary: metric(
            "primary",
            primaryValues,
            bounds.primary,
            changesFor(V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_CELLS),
        ),
        cells,
        rosters: {
            a: metric("roster-a", valuesFor("a-green"), bounds["roster-a"], changesFor(["a-green"])),
            b: metric("roster-b", valuesFor("b-green"), bounds["roster-b"], changesFor(["b-green"])),
        },
    };
}

const expectedOpeningId = (roster: V08A19F184LowerHumanPlacementAbRoster): V08A19F184LowerHumanOpeningId =>
    roster === "a" ? "prod-f184-lower-roster" : "prod-f184-upper-roster";

const objectsEqual = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

export function validateV08A19F184LowerHumanPlacementAbRecords(
    records: readonly IV08A19F184LowerHumanPlacementAbClusterRecord[],
    options: Pick<IV08A19F184LowerHumanPlacementAbRunnerOptions, "clusters" | "baseSeed">,
    rawLines: number,
    sourceUnchanged: boolean,
): IV08A19F184LowerHumanPlacementAbQuality {
    let implementationBytesVerified = false;
    try {
        inspectV08A19F184LowerHumanPlacementPinnedImplementationBytes();
        implementationBytesVerified = true;
    } catch {
        implementationBytesVerified = false;
    }
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
                  a: fingerprintV08A19F184LowerHumanPlacementArmy(prepared.armyA),
                  b: fingerprintV08A19F184LowerHumanPlacementArmy(prepared.armyB),
              }
            : undefined;
        const expectedPhysicalOrder =
            Number.isSafeInteger(record.cluster) && record.cluster >= 0
                ? planV08A19F184LowerHumanPlacementPhysicalOrder({ baseSeed: options.baseSeed }, record.cluster)
                : undefined;
        const recordedIsolateIds =
            record.isolateIds && typeof record.isolateIds === "object" ? Object.values(record.isolateIds) : [];
        if (
            record.schema !== V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SCHEMA ||
            !objectsEqual(record.productionAnchor, V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_BINDING) ||
            !objectsEqual(record.candidateIdentity, V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_CANDIDATE_IDENTITY) ||
            record.map !== V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_MAP ||
            !prepared ||
            record.setupSeed !== prepared.setupSeed ||
            record.combatSeed !== prepared.combatSeed ||
            !objectsEqual(record.armyFingerprints, expectedFingerprints) ||
            !objectsEqual(record.physicalExecutionOrder, expectedPhysicalOrder) ||
            recordedIsolateIds.length !== V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_EXECUTIONS_PER_CLUSTER ||
            new Set(recordedIsolateIds).size !== V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_EXECUTIONS_PER_CLUSTER ||
            recordedIsolateIds.some((isolateId) => typeof isolateId !== "string" || isolateId.length === 0) ||
            !objectsEqual(
                Object.keys(record.isolateIds ?? {}).sort(),
                V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SCHEDULE.map((entry) => entry.id).sort(),
            ) ||
            record.games.length !== V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_CLUSTER_SIZE
        ) {
            malformed = true;
        }
        const armies = prepared ? ({ a: prepared.armyA, b: prepared.armyB } as const) : undefined;
        for (let index = 0; index < record.games.length; index += 1) {
            const game = record.games[index];
            const scheduled = V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SCHEDULE[index];
            if (!scheduled) {
                malformed = true;
                continue;
            }
            const expectedScores = scoreByRoster(game.winner, scheduled);
            const expectedSetupFingerprint = armies
                ? fingerprintV08A19F184LowerHumanPlacementSetup(
                      armies[scheduled.greenRoster],
                      armies[scheduled.redRoster],
                      V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_MAP,
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
        games: records.length * V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_CLUSTER_SIZE,
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
        implementationBytesVerified,
    };
}

export function completeV08A19F184LowerHumanPlacementAbQuality(
    quality: IV08A19F184LowerHumanPlacementAbQuality,
): boolean {
    return (
        quality.clusters === quality.expectedClusters &&
        quality.games === quality.expectedClusters * V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_CLUSTER_SIZE &&
        quality.rawLines === quality.expectedClusters &&
        quality.malformedClusters === 0 &&
        quality.duplicateClusters === 0 &&
        quality.missingClusters === 0 &&
        quality.auditMismatches === 0 &&
        quality.coordinateMismatches === 0 &&
        quality.rejectedActions === 0 &&
        quality.stuckGames === 0 &&
        quality.treatmentGames === quality.expectedClusters * 2 &&
        quality.validTreatmentAudits === quality.expectedClusters * 2 &&
        quality.sourceUnchanged &&
        quality.implementationBytesVerified
    );
}

export function evaluateV08A19F184LowerHumanPlacementAbGates(
    summary: IV08A19F184LowerHumanPlacementAbSummaryRows,
    options: Pick<IV08A19F184LowerHumanPlacementAbRunnerOptions, "stage" | "clusters">,
    completeQuality: boolean,
): Readonly<Record<string, boolean>> {
    return {
        preregisteredValidationStage: options.stage === "validation",
        fixedValidationGeometry:
            options.clusters === V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_CLUSTERS_BY_STAGE.validation &&
            summary.clusters === options.clusters &&
            summary.games === options.clusters * V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_CLUSTER_SIZE &&
            summary.bootstrapIterations === V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_BOOTSTRAP_ITERATIONS,
        completeQuality,
        outcomeSensitivity: summary.primary.outcomeChanges > 0,
        positivePrimaryPoint: summary.primary.meanDelta > 0,
        primaryClusteredNormal:
            summary.primary.normal95.low > V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_GATES.primaryNormalCiLowExclusive,
        primaryClusterBootstrap:
            summary.primary.bootstrap95.low >
            V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_GATES.primaryBootstrapCiLowExclusive,
        bothRostersPositive: Object.values(summary.rosters).every(
            (row) => row.meanDelta > V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_GATES.rosterPointDeltaExclusive,
        ),
        bothRostersBonferroniNoninferior: Object.values(summary.rosters).every(
            (row) =>
                row.bootstrapBonferroniLower > -V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_GATES.rosterNoninferiorityMargin,
        ),
    };
}

export interface IV08A19F184LowerHumanPlacementPinnedImplementationBytes {
    readonly wrapper: { readonly source: string; readonly expectedSha256: string; readonly actualSha256: string };
    readonly upstream: { readonly source: string; readonly expectedSha256: string; readonly actualSha256: string };
}

export function inspectV08A19F184LowerHumanPlacementPinnedImplementationBytes(): IV08A19F184LowerHumanPlacementPinnedImplementationBytes {
    const root = resolve(import.meta.dir, "../..");
    const wrapper = V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_PROFILE.placementPolicy;
    const upstream = wrapper.upstreamImplementation;
    const actualSha256 = (source: string): string =>
        createHash("sha256")
            .update(readFileSync(join(root, source)))
            .digest("hex");
    const inspection = {
        wrapper: {
            source: wrapper.implementationSource,
            expectedSha256: wrapper.implementationSha256,
            actualSha256: actualSha256(wrapper.implementationSource),
        },
        upstream: {
            source: upstream.source,
            expectedSha256: upstream.sha256,
            actualSha256: actualSha256(upstream.source),
        },
    } as const;
    if (inspection.wrapper.actualSha256 !== inspection.wrapper.expectedSha256) {
        throw new Error("f184 lower-only v15 wrapper implementation SHA does not match its source bytes");
    }
    if (inspection.upstream.actualSha256 !== inspection.upstream.expectedSha256) {
        throw new Error("f184 lower-only v15 upstream implementation SHA does not match its source bytes");
    }
    return inspection;
}

interface IV08A19F184LowerHumanPlacementSourceIdentity {
    readonly commit: string;
    readonly sha256: string;
    readonly files: number;
    readonly pinnedImplementationBytes: IV08A19F184LowerHumanPlacementPinnedImplementationBytes;
}

const sourceIdentity = (): IV08A19F184LowerHumanPlacementSourceIdentity => {
    const root = resolve(import.meta.dir, "../..");
    const pinnedImplementationBytes = inspectV08A19F184LowerHumanPlacementPinnedImplementationBytes();
    const walk = (directory: string): string[] =>
        readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
            const path = join(directory, entry.name);
            return entry.isDirectory() ? walk(path) : entry.isFile() ? [relative(root, path)] : [];
        });
    const files = [
        ...new Set([
            ...walk(join(root, "src")),
            ...V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SOURCE_FILES,
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
        pinnedImplementationBytes,
    };
};

export const v08A19F184LeftHumanPlacementEnvironmentSha256 = (): string =>
    sha256(
        Object.entries(buildV08A19F184LowerHumanPlacementAbEnvironment()).sort(([left], [right]) =>
            left.localeCompare(right),
        ),
    );

export function assertV08A19F184LowerHumanPlacementWorkerEnvironment(): void {
    const expected = buildV08A19F184LowerHumanPlacementAbEnvironment();
    for (const [key, value] of Object.entries(expected)) {
        if (process.env[key] !== value) {
            throw new Error(`f184 lower-only v15 worker environment drifted at ${key}`);
        }
    }
    if (process.env.SEARCH_DECISION_DEADLINE_MS !== "" || process.env.SEARCH_CIRCUIT_BREAKER_MS !== "") {
        throw new Error("f184 lower-only v15 efficacy worker requires blank deadline and circuit breaker");
    }
}

interface IWorkerTask {
    readonly cluster: number;
}

async function runTasks(
    options: IV08A19F184LowerHumanPlacementAbRunnerOptions,
    rawPath: string,
): Promise<IV08A19F184LowerHumanPlacementAbClusterRecord[]> {
    const tasks: IWorkerTask[] = Array.from({ length: options.clusters }, (_, cluster) => ({ cluster }));
    const records: IV08A19F184LowerHumanPlacementAbClusterRecord[] = [];
    let dispatched = 0;
    let completed = 0;
    let lastProgress = Date.now();
    const lane = async (): Promise<void> => {
        while (true) {
            const task = tasks[dispatched++];
            if (!task) return;
            const record = await playV08A19F184LowerHumanPlacementAbCluster(
                { clusters: options.clusters, baseSeed: options.baseSeed, maxLaps: options.maxLaps },
                task.cluster,
            );
            records.push(record);
            appendFileSync(rawPath, `${JSON.stringify(record)}\n`);
            completed += 1;
            const now = Date.now();
            if (now - lastProgress >= 5_000 || completed === tasks.length) {
                lastProgress = now;
                console.error(
                    `[a19-f184-lower-human-placement-ab] ${completed}/${tasks.length} clusters ` +
                        `(${completed * V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_CLUSTER_SIZE} fresh-isolate fights)`,
                );
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(options.concurrency, tasks.length) }, lane));
    return records.sort((left, right) => left.cluster - right.cluster);
}

export async function runV08A19F184LowerHumanPlacementAb(
    options: IV08A19F184LowerHumanPlacementAbRunnerOptions,
): Promise<Record<string, unknown>> {
    if (
        options.clusters !== V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_CLUSTERS_BY_STAGE[options.stage] ||
        options.baseSeed !== V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SEEDS[options.stage] ||
        options.concurrency !== 12 ||
        options.maxLaps !== 60
    ) {
        throw new Error("f184 lower-only human-placement A/B options escaped the fixed stage contract");
    }
    if (existsSync(options.output)) {
        throw new Error(
            `Refusing to resume or overwrite existing f184 lower-only human-placement output ${options.output}`,
        );
    }
    mkdirSync(options.output, { recursive: false });
    const rawPath = join(options.output, V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_RAW_FILE);
    writeFileSync(rawPath, "");
    const sourceBefore = sourceIdentity();
    const startedAt = new Date();
    const startedMs = Date.now();
    writeFileSync(
        join(options.output, V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_STARTED_FILE),
        `${JSON.stringify(
            {
                schema: V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SCHEMA,
                stage: options.stage,
                options,
                schedule: V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SCHEDULE,
                candidateProfile: V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_PROFILE,
                candidateIdentity: V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_CANDIDATE_IDENTITY,
                productionAnchor: {
                    binding: V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_BINDING,
                    fixture: V08_A19_PROD_F184_ANCHOR,
                },
                sourceBefore,
                environmentSha256: v08A19F184LeftHumanPlacementEnvironmentSha256(),
                timing: V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_TIMING,
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
    const quality = validateV08A19F184LowerHumanPlacementAbRecords(records, options, rawLines, sourceUnchanged);
    const complete = completeV08A19F184LowerHumanPlacementAbQuality(quality);
    const rankings = summarizeV08A19F184LowerHumanPlacementAbRecords(records);
    const gateResults = evaluateV08A19F184LowerHumanPlacementAbGates(rankings, options, complete);
    const validationPassed = Object.values(gateResults).every(Boolean);
    const summary = {
        schema: V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SCHEMA,
        complete,
        stage: options.stage,
        generatedAt: new Date().toISOString(),
        seconds: (Date.now() - startedMs) / 1_000,
        options: {
            ...options,
            clusterSize: V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_CLUSTER_SIZE,
            executionsPerCluster: V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_EXECUTIONS_PER_CLUSTER,
            totalGames: options.clusters * V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_CLUSTER_SIZE,
        },
        estimand: {
            primary: rankings.estimand,
            treatment: V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_PROFILE.candidateId,
            control: `${V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_PROFILE.derivesFrom.candidateId} with plain StrategyV0_8 placement`,
            pairing: "same exact setup and combat seed; opposing army remains plain v0.8 in each direct contrast",
            weighting: "the two LOWER roster effects weighted equally within combat-seed cluster",
            draws: "0.5 score",
            inference:
                "normal cluster interval plus deterministic percentile bootstrap resampled by combat-seed cluster",
            timing: "A19/H18 policy efficacy with decision deadline and match circuit disabled; one fresh one-shot worker per scheduled game",
            excludedGate: "raw roster candidate win rates are descriptive army strength and are not promotion gates",
        },
        rankings,
        quality,
        validation: {
            gates: V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_GATES,
            results: gateResults,
            passed: validationPassed,
            rule: "validation passes only when every causal-efficacy, cell-safety, audit, coordinate, and provenance gate passes",
        },
        provenance: {
            candidateProfile: V08_A19_H18_F184_LOWER_HUMAN_PLACEMENT_PROFILE,
            candidateIdentity: V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_CANDIDATE_IDENTITY,
            productionAnchor: {
                binding: V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_BINDING,
                fixture: V08_A19_PROD_F184_ANCHOR,
            },
            schedule: V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SCHEDULE,
            physicalOrder: "balanced four-position rotation independent of logical record order",
            sourceBefore,
            sourceAfter,
            environmentSha256: v08A19F184LeftHumanPlacementEnvironmentSha256(),
            timing: V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_TIMING,
            startedAt: startedAt.toISOString(),
            runtime: { bun: Bun.version, platform: platform(), arch: arch() },
        },
    };
    writeFileSync(
        join(options.output, V08_A19_F184_LOWER_HUMAN_PLACEMENT_AB_SUMMARY_FILE),
        `${JSON.stringify(summary, null, 2)}\n`,
    );
    return summary;
}

async function main(): Promise<void> {
    const options = parseV08A19F184LowerHumanPlacementAbOptions(process.argv.slice(2));
    const summary = await runV08A19F184LowerHumanPlacementAb(options);
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
