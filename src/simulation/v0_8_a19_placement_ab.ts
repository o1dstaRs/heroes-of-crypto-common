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

import { StrategyV0_8 } from "../ai/versions/v0_8";
import { buildV08A19H18SearchEnvironment } from "../ai/versions/v0_8_a19_h18_profile";
import {
    createV08A19H18RankedPlacementStrategy,
    V08_A19_H18_RANKED_PLACEMENT_PROFILE,
} from "../ai/versions/v0_8_a19_h18_ranked_placement_profile";
import {
    type IV08A19RankedPlacementAudit,
    type V08A19RankedPlacementFallbackReason,
    type V08A19RankedPlacementStrategy,
} from "../ai/versions/v0_8_a19_ranked_placement";
import { PBTypes } from "../generated/protobuf/v1/types";
import {
    AI_META_COHORTS,
    AI_META_COHORT_DESCRIPTIONS,
    prepareMetaPair,
    rosterSignature,
    rostersAreStrictlyDistinct,
    type AiMetaCohort,
    type IAiMetaArmy,
} from "./ai_meta_cohorts_core";
import { hashSimulationParts } from "./army";
import { runMatch, type IMatchConfig, type IMatchResult, type Side } from "./battle_engine";
import {
    prepareV08A19ProdF184Pair,
    V08_A19_PROD_F184_ANCHOR,
    V08_A19_PROD_F184_COHORT,
    V08_A19_PROD_F184_FIXTURE_ID,
    V08_A19_PROD_F184_FIXTURE_SHA256,
    V08_A19_PROD_F184_MATCH_ID,
} from "./v0_8_a19_prod_f184_anchor";

export const V08_A19_PLACEMENT_AB_SCHEMA = "hoc.v0_8_a19_ranked_placement_ab.v9" as const;
export const V08_A19_PLACEMENT_AB_CLUSTER_SIZE = 4 as const;
export const V08_A19_PLACEMENT_AB_RAW_FILE = "v0-8-a19-placement-ab-v9.records.jsonl";
export const V08_A19_PLACEMENT_AB_SUMMARY_FILE = "v0-8-a19-placement-ab-v9.summary.json";
export const V08_A19_PLACEMENT_AB_STARTED_FILE = "v0-8-a19-placement-ab-v9.started.json";
export const V08_A19_PLACEMENT_AB_MAP = PBTypes.GridVals.NORMAL;
export const V08_A19_PLACEMENT_AB_BOOTSTRAP_SEED = 381_055_320;

/** Broad deploy population plus one separately analyzed exact production-ranked anchor. */
export const V08_A19_PLACEMENT_AB_COHORTS = Object.freeze([...AI_META_COHORTS, V08_A19_PROD_F184_COHORT] as const);
export type V08A19PlacementAbCohort = (typeof V08_A19_PLACEMENT_AB_COHORTS)[number];
const isBroadCohort = (cohort: V08A19PlacementAbCohort): cohort is AiMetaCohort =>
    (AI_META_COHORTS as readonly string[]).includes(cohort);
export const V08_A19_PROD_F184_RECORD_BINDING = Object.freeze({
    fixtureId: V08_A19_PROD_F184_FIXTURE_ID,
    matchId: V08_A19_PROD_F184_MATCH_ID,
    sha256: V08_A19_PROD_F184_FIXTURE_SHA256,
});

export const V08_A19_PLACEMENT_AB_ARMS = Object.freeze({
    candidate: Object.freeze({
        profile: V08_A19_H18_RANKED_PLACEMENT_PROFILE,
        placementStrategyFactory: "createV08A19H18RankedPlacementStrategy" as const,
    }),
    control: Object.freeze({
        profile: V08_A19_H18_RANKED_PLACEMENT_PROFILE.derivesFrom,
        placementStrategyFactory: "plain StrategyV0_8" as const,
    }),
});

export const V08_A19_PLACEMENT_AB_EXPLICIT_SOURCE_FILES = Object.freeze([
    "src/ai/setup/creature_score.ts",
    "src/ai/versions/v0_7_placement_reveal.ts",
    "src/ai/versions/v0_8_a19_h18_ranked_placement_profile.ts",
    "src/ai/versions/v0_8_a19_ranked_placement.ts",
    "src/simulation/v0_8_a19_prod_f184_anchor.ts",
    "src/simulation/v0_8_a19_placement_ab.ts",
    "src/simulation/v0_8_a19_placement_ab_worker.ts",
] as const);

export type V08A19PlacementAbStage = "smoke" | "validation";

export const V08_A19_PLACEMENT_AB_CLUSTERS_BY_STAGE: Readonly<Record<V08A19PlacementAbStage, number>> = Object.freeze({
    smoke: 36,
    validation: 1_440,
});

export const V08_A19_PLACEMENT_AB_SEEDS: Readonly<Record<V08A19PlacementAbStage, number>> = Object.freeze({
    smoke: 3_555_269_397,
    validation: 360_193_635,
});

export const V08_A19_PLACEMENT_VALIDATION_GATES = Object.freeze({
    minimumEligibleOrientationPairs: 60,
    minimumEligibleMatchupClusters: 45,
    primaryCiLowExclusive: 0.5,
    bootstrapCiLowExclusive: 0.5,
    exactClusterSignFlipTwoSidedPExclusive: 0.05,
    greenScoreRateExclusive: 0.5,
    redScoreRateExclusive: 0.5,
    prodRankedAnchorScoreRateInclusive: 0.5,
    prodRankedAnchorGreenScoreRateInclusive: 0.5,
    prodRankedAnchorRedScoreRateInclusive: 0.5,
    prodRankedAnchorRosterAScoreRateInclusive: 0.5,
    prodRankedAnchorRosterBScoreRateInclusive: 0.5,
    leaveOneCohortOutScoreRateExclusive: 0.5,
} as const);

export const V08_A19_PLACEMENT_CROSSOVER = Object.freeze([
    { assignment: 0, candidateRoster: "a", controlRoster: "b", candidateSide: "green" },
    { assignment: 0, candidateRoster: "a", controlRoster: "b", candidateSide: "red" },
    { assignment: 1, candidateRoster: "b", controlRoster: "a", candidateSide: "green" },
    { assignment: 1, candidateRoster: "b", controlRoster: "a", candidateSide: "red" },
] as const);

export const V08_A19_PLACEMENT_FALLBACK_REASONS = Object.freeze([
    "unsupported-map",
    "unauthorized-or-missing-public-roster",
    "opponent-unknown-or-not-double-flyer",
    "opponent-splash",
    "partial-army",
    "unknown-own-identity",
    "split-summoned-or-duplicate-army",
    "special-topology",
    "not-incumbent-shooter-screen",
    "not-reviewed-two-two-two-formation",
    "no-physical-melee-magic-correction",
    "candidate-incomplete-or-illegal",
    "unchanged",
] as const satisfies readonly V08A19RankedPlacementFallbackReason[]);

export type V08A19PlacementFallbackCounts = Record<V08A19RankedPlacementFallbackReason, number>;

const emptyFallbackCounts = (): V08A19PlacementFallbackCounts =>
    Object.fromEntries(
        V08_A19_PLACEMENT_FALLBACK_REASONS.map((reason) => [reason, 0]),
    ) as V08A19PlacementFallbackCounts;

export interface IV08A19PlacementAbRunnerOptions {
    stage: V08A19PlacementAbStage;
    clustersPerCohort: number;
    baseSeed: number;
    concurrency: 12;
    maxLaps: 60;
    output: string;
    cohorts: V08A19PlacementAbCohort[];
}

export interface IV08A19PlacementAbClusterOptions {
    cohort: V08A19PlacementAbCohort;
    clustersPerCohort: number;
    baseSeed: number;
    maxLaps: 60;
}

export interface IV08A19PlacementAbGameOutcome {
    assignment: 0 | 1;
    candidateRoster: "a" | "b";
    controlRoster: "a" | "b";
    candidateSide: Side;
    winner: Side | "draw";
    candidateResult: "win" | "loss" | "draw";
    candidateScore: number;
    laps: number;
    endReason: IMatchResult["endReason"];
    armageddonDecided: boolean;
    rejectedCandidate: number;
    rejectedControl: number;
    candidateHpMargin: number;
    candidateSurvivorMargin: number;
    candidateRosterSignature: string;
    controlRosterSignature: string;
    candidateArmyFingerprint: string;
    controlArmyFingerprint: string;
    setupFingerprint: string;
    treatmentApplied: boolean;
    placementChanged: boolean;
    horizontalDisplacement: number;
    correctedPhysicalUnits: number;
    correctedForwardPhysicals: number;
    correctedGroundScreens: number;
    nativeSpellbookBackliners: number;
    fallbackReason: V08A19RankedPlacementFallbackReason | null;
    incumbentPlacementFingerprint: string;
    selectedPlacementFingerprint: string;
}

export interface IV08A19PlacementAbClusterRecord {
    schema: typeof V08_A19_PLACEMENT_AB_SCHEMA;
    cohort: V08A19PlacementAbCohort;
    productionAnchor: {
        fixtureId: typeof V08_A19_PROD_F184_FIXTURE_ID;
        matchId: typeof V08_A19_PROD_F184_MATCH_ID;
        sha256: typeof V08_A19_PROD_F184_FIXTURE_SHA256;
    } | null;
    cluster: number;
    setupSeed: number;
    combatSeed: number;
    map: number;
    games: [
        IV08A19PlacementAbGameOutcome,
        IV08A19PlacementAbGameOutcome,
        IV08A19PlacementAbGameOutcome,
        IV08A19PlacementAbGameOutcome,
    ];
}

export interface IV08A19PlacementAbMetricRow {
    key: string;
    clusters: number;
    games: number;
    wins: number;
    losses: number;
    draws: number;
    drawAwareScoreRate: number;
    liftPp: number;
    standardErrorPp: number | null;
    ciLow: number;
    ciHigh: number;
    treatmentApplied: number;
    placementChanged: number;
    fallbackReasons: V08A19PlacementFallbackCounts;
}

export interface IV08A19PlacementAbSummaryRows {
    overall: IV08A19PlacementAbMetricRow;
    eligible: IV08A19PlacementAbOrientationMetric;
    noExposureNegativeControl: IV08A19PlacementAbOrientationMetric;
    prodRankedF184: IV08A19PlacementAbOrientationMetric;
    cohorts: IV08A19PlacementAbMetricRow[];
    maps: IV08A19PlacementAbMetricRow[];
    cohortMaps: IV08A19PlacementAbMetricRow[];
    eligibleCohorts: IV08A19PlacementAbOrientationMetric[];
    eligibleMaps: IV08A19PlacementAbOrientationMetric[];
    seats: IV08A19PlacementAbMetricRow[];
    rosters: IV08A19PlacementAbMetricRow[];
    policyITT: IV08A19PlacementAbPolicyITT;
    confirmatoryInference: IV08A19PlacementAbConfirmatoryInference;
}

export interface IV08A19PlacementAbOrientationMetric extends IV08A19PlacementAbMetricRow {
    orientationPairs: number;
}

export interface IV08A19PlacementAbConfirmatoryInference {
    estimand: "broad mean two-game physical-orientation crossover score, clustered by matchup; production anchor excluded";
    eligibleOrientationPairs: number;
    eligibleMatchupClusters: number;
    clusterBootstrapIterations: 100_000;
    clusterBootstrapCiLow: number;
    clusterBootstrapCiHigh: number;
    exactClusterSignFlipTwoSidedP: number;
    greenScoreRate: number;
    redScoreRate: number;
    rankedDraftScoreRate: number | null;
    prodRankedF184ScoreRate: number | null;
    prodRankedF184GreenScoreRate: number | null;
    prodRankedF184RedScoreRate: number | null;
    prodRankedF184RosterAScoreRate: number | null;
    prodRankedF184RosterBScoreRate: number | null;
    prodRankedF184OrientationPairs: number;
    prodRankedF184ExposedOrientationPairs: number;
    prodRankedF184Clusters: number;
    prodRankedF184TreatmentGames: number;
    leaveOneCohortOutScoreRates: Record<string, number | null>;
}

export interface IV08A19PlacementAbPolicyITT {
    estimand: "deploy-wide physical-orientation lift with no-exposure pair effects fixed at zero";
    totalOrientationPairs: number;
    eligibleOrientationPairs: number;
    noExposureOrientationPairs: number;
    exposureRate: number;
    eligibleLiftPp: number | null;
    eligibleStandardErrorPp: number | null;
    scaledDeployWideLiftPp: number;
    scaledStandardErrorPp: number | null;
    scaledCiLowPp: number | null;
    scaledCiHighPp: number | null;
}

export interface IV08A19PlacementAbQuality {
    expectedClusters: number;
    clusters: number;
    games: number;
    rawLines: number;
    malformedClusters: number;
    duplicateClusters: number;
    missingClusters: number;
    overlappingRosterAssignments: number;
    rejectedCandidate: number;
    rejectedControl: number;
    armageddonDecided: number;
    stuck: number;
    cohortClusters: Record<string, number>;
    mapClusters: Record<string, number>;
    sourceUnchanged: boolean;
    treatmentApplied: number;
    placementChanged: number;
    fallbackReasons: V08A19PlacementFallbackCounts;
}

interface IWorkerTask {
    cohort: V08A19PlacementAbCohort;
    cluster: number;
}

type WorkerResponse =
    { type: "ready" } | { type: "result"; record: IV08A19PlacementAbClusterRecord } | { type: "error"; error: string };

const positiveInteger = (raw: string | undefined, label: string, fallback: number): number => {
    const value = Number(raw ?? fallback);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
    return value;
};

/** Parse only the two preregistered geometries; ad-hoc seed and cohort selection are deliberately absent. */
export function parseV08A19PlacementAbOptions(argv: readonly string[]): IV08A19PlacementAbRunnerOptions {
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
    const stage = (values.stage ?? "smoke") as V08A19PlacementAbStage;
    if (stage !== "smoke" && stage !== "validation") {
        throw new Error("stage must be smoke or validation");
    }
    if (!values.output) throw new Error("--output is required and must name a fresh directory");
    const concurrency = positiveInteger(values.concurrency, "concurrency", 12);
    if (concurrency !== 12) throw new Error("A19 placement A/B requires concurrency 12");
    return {
        stage,
        clustersPerCohort: V08_A19_PLACEMENT_AB_CLUSTERS_BY_STAGE[stage],
        baseSeed: V08_A19_PLACEMENT_AB_SEEDS[stage],
        concurrency: 12,
        maxLaps: 60,
        output: resolve(values.output),
        cohorts: [...V08_A19_PLACEMENT_AB_COHORTS],
    };
}

/** Exact dual-seat A19/H18 combat environment. Candidate and control differ only in root placement. */
export function buildV08A19PlacementAbEnvironment(): Record<string, string> {
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
        throw new Error("A19 placement A/B requires the exact A19/H18 shortlist-3 search profile");
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
    return Object.assign(environment, buildV08A19PlacementAbEnvironment());
};

const armySetup = (army: IAiMetaArmy) => ({
    roster: army.roster,
    creatureIds: army.creatureIds,
    perk: army.perk,
    artifactT1: army.artifactT1.id,
    artifactT2: army.artifactT2.id,
    augments: army.augment.augments,
    synergies: army.synergies,
});

const armyFingerprint = (army: IAiMetaArmy): string =>
    createHash("sha256")
        .update(JSON.stringify(armySetup(army)))
        .digest("hex");

const setupFingerprint = (candidate: IAiMetaArmy, control: IAiMetaArmy, map: number): string =>
    createHash("sha256")
        .update(JSON.stringify({ candidate: armySetup(candidate), control: armySetup(control), map }))
        .digest("hex");

const controlStrategy = (): StrategyV0_8 => new StrategyV0_8();

interface IPreparedPlacementMatch {
    config: IMatchConfig;
    candidateStrategy: V08A19RankedPlacementStrategy;
}

const prepareMatch = (
    candidate: IAiMetaArmy,
    control: IAiMetaArmy,
    candidateSide: Side,
    combatSeed: number,
    map: number,
    maxLaps: 60,
): IPreparedPlacementMatch => {
    const candidateIsGreen = candidateSide === "green";
    const green = candidateIsGreen ? candidate : control;
    const red = candidateIsGreen ? control : candidate;
    const candidateStrategy = createV08A19H18RankedPlacementStrategy();
    return {
        candidateStrategy,
        config: {
            greenVersion: "v0.8",
            redVersion: "v0.8",
            greenStrategyOverride: candidateIsGreen ? candidateStrategy : controlStrategy(),
            redStrategyOverride: candidateIsGreen ? controlStrategy() : candidateStrategy,
            roster: green.roster,
            redRoster: red.roster,
            seed: combatSeed,
            gridType: map,
            maxLaps,
            greenPerk: green.perk,
            redPerk: red.perk,
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
        },
    };
};

const outcome = (
    result: IMatchResult,
    assignment: 0 | 1,
    candidateRoster: "a" | "b",
    controlRoster: "a" | "b",
    candidateSide: Side,
    candidate: IAiMetaArmy,
    control: IAiMetaArmy,
    fingerprint: string,
    audit: IV08A19RankedPlacementAudit,
): IV08A19PlacementAbGameOutcome => {
    const candidateResult = result.winner === "draw" ? "draw" : result.winner === candidateSide ? "win" : "loss";
    const own = candidateSide === "green" ? result.outcome.green : result.outcome.red;
    const opposing = candidateSide === "green" ? result.outcome.red : result.outcome.green;
    return {
        assignment,
        candidateRoster,
        controlRoster,
        candidateSide,
        winner: result.winner,
        candidateResult,
        candidateScore: candidateResult === "win" ? 1 : candidateResult === "draw" ? 0.5 : 0,
        laps: result.laps,
        endReason: result.endReason,
        armageddonDecided: result.attrition.decidedByArmageddon,
        rejectedCandidate: (candidateSide === "green" ? result.rejectedGreen : result.rejectedRed) ?? 0,
        rejectedControl: (candidateSide === "green" ? result.rejectedRed : result.rejectedGreen) ?? 0,
        candidateHpMargin: own.hpRemaining - opposing.hpRemaining,
        candidateSurvivorMargin: own.unitsAlive - opposing.unitsAlive,
        candidateRosterSignature: rosterSignature(candidate.roster),
        controlRosterSignature: rosterSignature(control.roster),
        candidateArmyFingerprint: armyFingerprint(candidate),
        controlArmyFingerprint: armyFingerprint(control),
        setupFingerprint: fingerprint,
        treatmentApplied: audit.treatmentApplied,
        placementChanged: audit.placementChanged,
        horizontalDisplacement: audit.horizontalDisplacement,
        correctedPhysicalUnits: audit.correctedPhysicalUnits,
        correctedForwardPhysicals: audit.correctedForwardPhysicals,
        correctedGroundScreens: audit.correctedGroundScreens,
        nativeSpellbookBackliners: audit.nativeSpellbookBackliners,
        fallbackReason: audit.fallbackReason,
        incumbentPlacementFingerprint: audit.incumbentFingerprint,
        selectedPlacementFingerprint: audit.selectedFingerprint,
    };
};

/** Run one four-game paired crossover: each roster receives each arm and the candidate receives both seats. */
export function playV08A19PlacementAbCluster(
    options: IV08A19PlacementAbClusterOptions,
    cluster: number,
): IV08A19PlacementAbClusterRecord {
    if (!(V08_A19_PLACEMENT_AB_COHORTS as readonly string[]).includes(options.cohort)) {
        throw new Error(`Unknown A19 placement cohort ${options.cohort}`);
    }
    if (!Number.isInteger(options.clustersPerCohort) || options.clustersPerCohort <= 0) {
        throw new RangeError("clustersPerCohort must be positive");
    }
    if (!Number.isInteger(cluster) || cluster < 0 || cluster >= options.clustersPerCohort) {
        throw new RangeError(`cluster ${cluster} is outside [0, ${options.clustersPerCohort})`);
    }
    const prepared = isBroadCohort(options.cohort)
        ? prepareMetaPair(
              { cohort: options.cohort, games: options.clustersPerCohort * 2, baseSeed: options.baseSeed },
              cluster,
              V08_A19_PLACEMENT_AB_MAP,
          )
        : prepareV08A19ProdF184Pair(options.baseSeed, cluster);
    if (!rostersAreStrictlyDistinct(prepared.armyA.roster, prepared.armyB.roster)) {
        throw new Error(`A19 placement cluster ${options.cohort}:${cluster} has overlapping rosters`);
    }
    const armyByRoster = { a: prepared.armyA, b: prepared.armyB } as const;
    const games = V08_A19_PLACEMENT_CROSSOVER.map((game) => {
        const candidate = armyByRoster[game.candidateRoster];
        const control = armyByRoster[game.controlRoster];
        const fingerprint = setupFingerprint(candidate, control, V08_A19_PLACEMENT_AB_MAP);
        const match = prepareMatch(
            candidate,
            control,
            game.candidateSide,
            prepared.combatSeed,
            V08_A19_PLACEMENT_AB_MAP,
            options.maxLaps,
        );
        const result = runMatch(match.config);
        const audit = match.candidateStrategy.getLastPlacementAudit();
        if (!audit) throw new Error(`A19 placement audit missing for ${options.cohort}:${cluster}:${game.assignment}`);
        return outcome(
            result,
            game.assignment,
            game.candidateRoster,
            game.controlRoster,
            game.candidateSide,
            candidate,
            control,
            fingerprint,
            audit,
        );
    }) as IV08A19PlacementAbClusterRecord["games"];
    return {
        schema: V08_A19_PLACEMENT_AB_SCHEMA,
        cohort: options.cohort,
        productionAnchor: options.cohort === V08_A19_PROD_F184_COHORT ? V08_A19_PROD_F184_RECORD_BINDING : null,
        cluster,
        setupSeed: prepared.setupSeed,
        combatSeed: prepared.combatSeed,
        map: V08_A19_PLACEMENT_AB_MAP,
        games,
    };
}

const metricRow = (
    key: string,
    clusters: readonly (readonly IV08A19PlacementAbGameOutcome[])[],
): IV08A19PlacementAbMetricRow => {
    const populated = clusters.filter((games) => games.length > 0);
    const games = populated.flatMap((cluster) => cluster);
    const drawAwareScoreRate = games.length
        ? games.reduce((sum, game) => sum + game.candidateScore, 0) / games.length
        : 0.5;
    let standardError: number | null = null;
    if (populated.length >= 2) {
        const clusterMeans = populated.map(
            (cluster) => cluster.reduce((sum, game) => sum + game.candidateScore, 0) / cluster.length,
        );
        const variance =
            clusterMeans.reduce((sum, mean) => sum + (mean - drawAwareScoreRate) ** 2, 0) / (clusterMeans.length - 1);
        standardError = Math.sqrt(variance / clusterMeans.length);
    }
    const margin = standardError === null ? 0.5 : 1.959963984540054 * standardError;
    const fallbackReasons = emptyFallbackCounts();
    for (const game of games) {
        if (game.fallbackReason !== null) {
            fallbackReasons[game.fallbackReason] = (fallbackReasons[game.fallbackReason] ?? 0) + 1;
        }
    }
    return {
        key,
        clusters: populated.length,
        games: games.length,
        wins: games.filter((game) => game.candidateResult === "win").length,
        losses: games.filter((game) => game.candidateResult === "loss").length,
        draws: games.filter((game) => game.candidateResult === "draw").length,
        drawAwareScoreRate,
        liftPp: (drawAwareScoreRate - 0.5) * 100,
        standardErrorPp: standardError === null ? null : standardError * 100,
        ciLow: Math.max(0, drawAwareScoreRate - margin),
        ciHigh: Math.min(1, drawAwareScoreRate + margin),
        treatmentApplied: games.filter((game) => game.treatmentApplied).length,
        placementChanged: games.filter((game) => game.placementChanged).length,
        fallbackReasons,
    };
};

const groupedRows = (
    records: readonly IV08A19PlacementAbClusterRecord[],
    keys: readonly string[],
    gamesFor: (record: IV08A19PlacementAbClusterRecord, key: string) => readonly IV08A19PlacementAbGameOutcome[],
): IV08A19PlacementAbMetricRow[] =>
    keys.map((key) =>
        metricRow(
            key,
            records.map((record) => gamesFor(record, key)),
        ),
    );

interface IOrientationPair {
    readonly clusterKey: string;
    readonly cohort: V08A19PlacementAbCohort;
    readonly map: number;
    readonly games: readonly [IV08A19PlacementAbGameOutcome, IV08A19PlacementAbGameOutcome];
}

const orientationPairs = (records: readonly IV08A19PlacementAbClusterRecord[]): IOrientationPair[] =>
    records.flatMap((record) =>
        (
            [
                [0, 3],
                [1, 2],
            ] as const
        ).map(([first, second]) => ({
            clusterKey: `${record.cohort}:${record.cluster}`,
            cohort: record.cohort,
            map: record.map,
            games: [record.games[first], record.games[second]],
        })),
    );

const pairScore = (pair: IOrientationPair): number => (pair.games[0].candidateScore + pair.games[1].candidateScore) / 2;
const pairWasExposed = (pair: IOrientationPair): boolean => pair.games.some((game) => game.treatmentApplied);

const orientationMetric = (key: string, pairs: readonly IOrientationPair[]): IV08A19PlacementAbOrientationMetric => {
    const games = pairs.flatMap((pair) => pair.games);
    const drawAwareScoreRate = pairs.length
        ? pairs.reduce((sum, pair) => sum + pairScore(pair), 0) / pairs.length
        : 0.5;
    const grouped = new Map<string, IOrientationPair[]>();
    for (const pair of pairs) {
        const current = grouped.get(pair.clusterKey) ?? [];
        current.push(pair);
        grouped.set(pair.clusterKey, current);
    }
    let standardError: number | null = null;
    if (grouped.size >= 2 && pairs.length) {
        const squaredClusterResidualSums = [...grouped.values()].reduce((sum, clusterPairs) => {
            const residualSum = clusterPairs.reduce(
                (clusterSum, pair) => clusterSum + pairScore(pair) - drawAwareScoreRate,
                0,
            );
            return sum + residualSum ** 2;
        }, 0);
        standardError = Math.sqrt(
            (grouped.size / (grouped.size - 1)) * (squaredClusterResidualSums / pairs.length ** 2),
        );
    }
    const margin = standardError === null ? 0.5 : 1.959963984540054 * standardError;
    const fallbackReasons = emptyFallbackCounts();
    for (const game of games) {
        if (game.fallbackReason !== null) fallbackReasons[game.fallbackReason] += 1;
    }
    return {
        key,
        clusters: grouped.size,
        orientationPairs: pairs.length,
        games: games.length,
        wins: games.filter((game) => game.candidateResult === "win").length,
        losses: games.filter((game) => game.candidateResult === "loss").length,
        draws: games.filter((game) => game.candidateResult === "draw").length,
        drawAwareScoreRate,
        liftPp: (drawAwareScoreRate - 0.5) * 100,
        standardErrorPp: standardError === null ? null : standardError * 100,
        ciLow: Math.max(0, drawAwareScoreRate - margin),
        ciHigh: Math.min(1, drawAwareScoreRate + margin),
        treatmentApplied: games.filter((game) => game.treatmentApplied).length,
        placementChanged: games.filter((game) => game.placementChanged).length,
        fallbackReasons,
    };
};

const exactClusterSignFlipTwoSidedP = (pairs: readonly IOrientationPair[]): number => {
    const effectsByCluster = new Map<string, number>();
    for (const pair of pairs) {
        effectsByCluster.set(pair.clusterKey, (effectsByCluster.get(pair.clusterKey) ?? 0) + pairScore(pair) - 0.5);
    }
    const effects4 = [...effectsByCluster.values()].map((effect) => Math.round(effect * 4)).filter(Boolean);
    if (!effects4.length) return 1;
    const observed = Math.abs(effects4.reduce((sum, effect) => sum + effect, 0));
    let distribution = new Map<number, bigint>([[0, 1n]]);
    for (const effect of effects4) {
        const next = new Map<number, bigint>();
        for (const [sum, count] of distribution) {
            next.set(sum + effect, (next.get(sum + effect) ?? 0n) + count);
            next.set(sum - effect, (next.get(sum - effect) ?? 0n) + count);
        }
        distribution = next;
    }
    let extreme = 0n;
    let total = 0n;
    for (const [sum, count] of distribution) {
        total += count;
        if (Math.abs(sum) >= observed) extreme += count;
    }
    // Divide in bigint space so an unexpectedly broad exposure cannot turn both counts into Infinity.
    const probabilityScale = 1_000_000_000_000_000n;
    return Number((extreme * probabilityScale) / total) / Number(probabilityScale);
};

const clusterBootstrapInterval = (pairs: readonly IOrientationPair[]): readonly [number, number] => {
    if (!pairs.length) return [0.5, 0.5];
    const grouped = new Map<string, number[]>();
    for (const pair of pairs) {
        const current = grouped.get(pair.clusterKey) ?? [];
        current.push(pairScore(pair));
        grouped.set(pair.clusterKey, current);
    }
    const clusters = [...grouped.values()];
    let state = V08_A19_PLACEMENT_AB_BOOTSTRAP_SEED;
    const random = (): number => {
        state = (state + 0x6d2b_79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
    };
    const estimates = new Array<number>(100_000);
    for (let iteration = 0; iteration < estimates.length; iteration += 1) {
        let score = 0;
        let sampledPairs = 0;
        for (let draw = 0; draw < clusters.length; draw += 1) {
            const sampled = clusters[Math.floor(random() * clusters.length)];
            score += sampled.reduce((sum, value) => sum + value, 0);
            sampledPairs += sampled.length;
        }
        estimates[iteration] = score / sampledPairs;
    }
    estimates.sort((left, right) => left - right);
    return [estimates[2_499], estimates[97_499]];
};

const policyITT = (
    pairs: readonly IOrientationPair[],
    eligible: IV08A19PlacementAbOrientationMetric,
): IV08A19PlacementAbPolicyITT => {
    const totalOrientationPairs = pairs.length;
    const eligibleOrientationPairs = pairs.filter(pairWasExposed).length;
    const noExposureOrientationPairs = totalOrientationPairs - eligibleOrientationPairs;
    const exposureRate = totalOrientationPairs ? eligibleOrientationPairs / totalOrientationPairs : 0;
    if (!totalOrientationPairs) {
        return {
            estimand: "deploy-wide physical-orientation lift with no-exposure pair effects fixed at zero",
            totalOrientationPairs,
            eligibleOrientationPairs,
            noExposureOrientationPairs,
            exposureRate,
            eligibleLiftPp: null,
            eligibleStandardErrorPp: null,
            scaledDeployWideLiftPp: 0,
            scaledStandardErrorPp: null,
            scaledCiLowPp: null,
            scaledCiHighPp: null,
        };
    }
    if (!eligibleOrientationPairs) {
        return {
            estimand: "deploy-wide physical-orientation lift with no-exposure pair effects fixed at zero",
            totalOrientationPairs,
            eligibleOrientationPairs,
            noExposureOrientationPairs,
            exposureRate,
            eligibleLiftPp: null,
            eligibleStandardErrorPp: null,
            scaledDeployWideLiftPp: 0,
            scaledStandardErrorPp: 0,
            scaledCiLowPp: 0,
            scaledCiHighPp: 0,
        };
    }
    const scaledDeployWideLiftPp = eligible.liftPp * exposureRate;
    const scaledStandardErrorPp = eligible.standardErrorPp === null ? null : eligible.standardErrorPp * exposureRate;
    const scaledMargin = scaledStandardErrorPp === null ? null : 1.959963984540054 * scaledStandardErrorPp;
    return {
        estimand: "deploy-wide physical-orientation lift with no-exposure pair effects fixed at zero",
        totalOrientationPairs,
        eligibleOrientationPairs,
        noExposureOrientationPairs,
        exposureRate,
        eligibleLiftPp: eligible.liftPp,
        eligibleStandardErrorPp: eligible.standardErrorPp,
        scaledDeployWideLiftPp,
        scaledStandardErrorPp,
        scaledCiLowPp: scaledMargin === null ? null : scaledDeployWideLiftPp - scaledMargin,
        scaledCiHighPp: scaledMargin === null ? null : scaledDeployWideLiftPp + scaledMargin,
    };
};

export function summarizeV08A19PlacementAbRecords(
    records: readonly IV08A19PlacementAbClusterRecord[],
): IV08A19PlacementAbSummaryRows {
    const maps = [String(V08_A19_PLACEMENT_AB_MAP)];
    const pairs = orientationPairs(records);
    const broadPairs = pairs.filter((pair) => isBroadCohort(pair.cohort));
    const eligiblePairs = broadPairs.filter(pairWasExposed);
    const noExposurePairs = broadPairs.filter((pair) => !pairWasExposed(pair));
    const prodRankedF184Pairs = pairs.filter((pair) => pair.cohort === V08_A19_PROD_F184_COHORT);
    const eligible = orientationMetric("eligible-physical-orientations", eligiblePairs);
    const [clusterBootstrapCiLow, clusterBootstrapCiHigh] = clusterBootstrapInterval(eligiblePairs);
    const scoreRateForGames = (games: readonly IV08A19PlacementAbGameOutcome[]): number =>
        games.length ? games.reduce((sum, game) => sum + game.candidateScore, 0) / games.length : 0.5;
    const nullableScoreRateForGames = (games: readonly IV08A19PlacementAbGameOutcome[]): number | null =>
        games.length ? scoreRateForGames(games) : null;
    const scoreRateForPairs = (selected: readonly IOrientationPair[]): number | null =>
        selected.length ? selected.reduce((sum, pair) => sum + pairScore(pair), 0) / selected.length : null;
    const prodRankedF184Games = prodRankedF184Pairs.flatMap((pair) => pair.games);
    return {
        overall: metricRow(
            "overall",
            records.map((record) => record.games),
        ),
        eligible,
        noExposureNegativeControl: orientationMetric("no-exposure-physical-orientations", noExposurePairs),
        prodRankedF184: orientationMetric(V08_A19_PROD_F184_COHORT, prodRankedF184Pairs),
        cohorts: groupedRows(records, V08_A19_PLACEMENT_AB_COHORTS, (record, key) =>
            record.cohort === key ? record.games : [],
        ),
        maps: groupedRows(records, maps, (record, key) => (String(record.map) === key ? record.games : [])),
        cohortMaps: groupedRows(
            records,
            V08_A19_PLACEMENT_AB_COHORTS.flatMap((cohort) => maps.map((map) => `${cohort}:${map}`)),
            (record, key) => (key === `${record.cohort}:${record.map}` ? record.games : []),
        ),
        eligibleCohorts: V08_A19_PLACEMENT_AB_COHORTS.map((cohort) =>
            orientationMetric(
                cohort,
                pairs.filter((pair) => pair.cohort === cohort && pairWasExposed(pair)),
            ),
        ),
        eligibleMaps: maps.map((map) =>
            orientationMetric(
                map,
                eligiblePairs.filter((pair) => String(pair.map) === map),
            ),
        ),
        seats: groupedRows(records, ["green", "red"], (record, key) =>
            record.games.filter((game) => game.candidateSide === key),
        ),
        rosters: groupedRows(records, ["a", "b"], (record, key) =>
            record.games.filter((game) => game.candidateRoster === key),
        ),
        policyITT: policyITT(broadPairs, eligible),
        confirmatoryInference: {
            estimand:
                "broad mean two-game physical-orientation crossover score, clustered by matchup; production anchor excluded",
            eligibleOrientationPairs: eligiblePairs.length,
            eligibleMatchupClusters: new Set(eligiblePairs.map((pair) => pair.clusterKey)).size,
            clusterBootstrapIterations: 100_000,
            clusterBootstrapCiLow,
            clusterBootstrapCiHigh,
            exactClusterSignFlipTwoSidedP: exactClusterSignFlipTwoSidedP(eligiblePairs),
            greenScoreRate: scoreRateForGames(
                eligiblePairs.flatMap((pair) => pair.games.filter((game) => game.candidateSide === "green")),
            ),
            redScoreRate: scoreRateForGames(
                eligiblePairs.flatMap((pair) => pair.games.filter((game) => game.candidateSide === "red")),
            ),
            rankedDraftScoreRate: scoreRateForPairs(eligiblePairs.filter((pair) => pair.cohort === "ranked-draft")),
            prodRankedF184ScoreRate: scoreRateForPairs(prodRankedF184Pairs),
            prodRankedF184GreenScoreRate: nullableScoreRateForGames(
                prodRankedF184Games.filter((game) => game.candidateSide === "green"),
            ),
            prodRankedF184RedScoreRate: nullableScoreRateForGames(
                prodRankedF184Games.filter((game) => game.candidateSide === "red"),
            ),
            prodRankedF184RosterAScoreRate: nullableScoreRateForGames(
                prodRankedF184Games.filter((game) => game.candidateRoster === "a"),
            ),
            prodRankedF184RosterBScoreRate: nullableScoreRateForGames(
                prodRankedF184Games.filter((game) => game.candidateRoster === "b"),
            ),
            prodRankedF184OrientationPairs: prodRankedF184Pairs.length,
            prodRankedF184ExposedOrientationPairs: prodRankedF184Pairs.filter(pairWasExposed).length,
            prodRankedF184Clusters: new Set(prodRankedF184Pairs.map((pair) => pair.clusterKey)).size,
            prodRankedF184TreatmentGames: prodRankedF184Games.filter((game) => game.treatmentApplied).length,
            leaveOneCohortOutScoreRates: Object.fromEntries(
                AI_META_COHORTS.map((cohort) => [
                    cohort,
                    scoreRateForPairs(eligiblePairs.filter((pair) => pair.cohort !== cohort)),
                ]),
            ),
        },
    };
}

export function validateV08A19PlacementAbRecords(
    records: readonly IV08A19PlacementAbClusterRecord[],
    options: Pick<IV08A19PlacementAbRunnerOptions, "clustersPerCohort" | "baseSeed" | "cohorts">,
    rawLines: number,
    sourceUnchanged: boolean,
): IV08A19PlacementAbQuality {
    const expectedClusters = options.clustersPerCohort * options.cohorts.length;
    const expected = new Set(
        options.cohorts.flatMap((cohort) =>
            Array.from({ length: options.clustersPerCohort }, (_, cluster) => `${cohort}:${cluster}`),
        ),
    );
    const seen = new Set<string>();
    let malformedClusters = 0;
    let duplicateClusters = 0;
    let overlappingRosterAssignments = 0;
    let rejectedCandidate = 0;
    let rejectedControl = 0;
    let armageddonDecided = 0;
    let stuck = 0;
    let treatmentApplied = 0;
    let placementChanged = 0;
    const fallbackReasons = emptyFallbackCounts();
    const legalFallbackReasons = new Set<string>(V08_A19_PLACEMENT_FALLBACK_REASONS);
    const cohortClusters: Record<string, number> = {};
    const mapClusters: Record<string, number> = {};
    for (const record of records) {
        const identity = `${record.cohort}:${record.cluster}`;
        if (seen.has(identity)) duplicateClusters += 1;
        seen.add(identity);
        expected.delete(identity);
        cohortClusters[record.cohort] = (cohortClusters[record.cohort] ?? 0) + 1;
        mapClusters[String(record.map)] = (mapClusters[String(record.map)] ?? 0) + 1;
        const expectedSetupSeed = hashSimulationParts("ai-meta-setup", options.baseSeed, record.cohort, record.cluster);
        const expectedCombatSeed = hashSimulationParts(
            "ai-meta-combat",
            options.baseSeed,
            record.cohort,
            record.cluster,
        );
        const productionAnchorBindingValid =
            record.cohort === V08_A19_PROD_F184_COHORT
                ? JSON.stringify(record.productionAnchor) === JSON.stringify(V08_A19_PROD_F184_RECORD_BINDING)
                : record.productionAnchor === null;
        if (
            record.schema !== V08_A19_PLACEMENT_AB_SCHEMA ||
            !options.cohorts.includes(record.cohort) ||
            !Number.isInteger(record.cluster) ||
            record.cluster < 0 ||
            record.cluster >= options.clustersPerCohort ||
            record.map !== V08_A19_PLACEMENT_AB_MAP ||
            record.setupSeed !== expectedSetupSeed ||
            record.combatSeed !== expectedCombatSeed ||
            !productionAnchorBindingValid ||
            record.games.length !== V08_A19_PLACEMENT_AB_CLUSTER_SIZE
        ) {
            malformedClusters += 1;
            continue;
        }
        for (let index = 0; index < record.games.length; index += 1) {
            const game = record.games[index];
            const planned = V08_A19_PLACEMENT_CROSSOVER[index];
            const expectedResult =
                game.winner === "draw" ? "draw" : game.winner === planned.candidateSide ? "win" : "loss";
            const expectedScore = expectedResult === "win" ? 1 : expectedResult === "draw" ? 0.5 : 0;
            const auditShapeValid =
                typeof game.treatmentApplied === "boolean" &&
                typeof game.placementChanged === "boolean" &&
                Number.isFinite(game.horizontalDisplacement) &&
                game.horizontalDisplacement >= 0 &&
                Number.isInteger(game.correctedPhysicalUnits) &&
                game.correctedPhysicalUnits >= 0 &&
                game.correctedPhysicalUnits <= 6 &&
                Number.isInteger(game.correctedForwardPhysicals) &&
                game.correctedForwardPhysicals >= 0 &&
                Number.isInteger(game.correctedGroundScreens) &&
                game.correctedGroundScreens >= 0 &&
                game.correctedForwardPhysicals + game.correctedGroundScreens <= game.correctedPhysicalUnits &&
                Number.isInteger(game.nativeSpellbookBackliners) &&
                game.nativeSpellbookBackliners >= 0 &&
                game.nativeSpellbookBackliners <= 6 &&
                (game.fallbackReason === null || legalFallbackReasons.has(game.fallbackReason)) &&
                typeof game.incumbentPlacementFingerprint === "string" &&
                game.incumbentPlacementFingerprint.length > 0 &&
                typeof game.selectedPlacementFingerprint === "string" &&
                game.selectedPlacementFingerprint.length > 0;
            const fallbackConsistent = game.treatmentApplied === (game.fallbackReason === null);
            const fallbackFingerprintConsistent =
                game.fallbackReason === null ||
                game.incumbentPlacementFingerprint === game.selectedPlacementFingerprint;
            const changedConsistent =
                game.placementChanged === (game.incumbentPlacementFingerprint !== game.selectedPlacementFingerprint) &&
                game.placementChanged === game.treatmentApplied;
            const treatmentPredicateValid =
                !game.treatmentApplied ||
                (game.correctedPhysicalUnits >= 1 && game.correctedForwardPhysicals + game.correctedGroundScreens >= 1);
            if (
                game.assignment !== planned.assignment ||
                game.candidateRoster !== planned.candidateRoster ||
                game.controlRoster !== planned.controlRoster ||
                game.candidateSide !== planned.candidateSide ||
                game.candidateResult !== expectedResult ||
                game.candidateScore !== expectedScore ||
                !auditShapeValid ||
                !fallbackConsistent ||
                !fallbackFingerprintConsistent ||
                !changedConsistent ||
                !treatmentPredicateValid
            ) {
                malformedClusters += 1;
                break;
            }
        }
        if (
            record.games[0].setupFingerprint !== record.games[1].setupFingerprint ||
            record.games[2].setupFingerprint !== record.games[3].setupFingerprint ||
            record.games[0].candidateRosterSignature !== record.games[1].candidateRosterSignature ||
            record.games[2].candidateRosterSignature !== record.games[3].candidateRosterSignature ||
            record.games[0].candidateRosterSignature !== record.games[2].controlRosterSignature ||
            record.games[0].controlRosterSignature !== record.games[2].candidateRosterSignature ||
            record.games[0].candidateArmyFingerprint !== record.games[1].candidateArmyFingerprint ||
            record.games[0].controlArmyFingerprint !== record.games[1].controlArmyFingerprint ||
            record.games[2].candidateArmyFingerprint !== record.games[3].candidateArmyFingerprint ||
            record.games[2].controlArmyFingerprint !== record.games[3].controlArmyFingerprint ||
            record.games[0].candidateArmyFingerprint !== record.games[2].controlArmyFingerprint ||
            record.games[0].controlArmyFingerprint !== record.games[2].candidateArmyFingerprint
        ) {
            malformedClusters += 1;
        }
        if (record.cohort === V08_A19_PROD_F184_COHORT) {
            const expectedAnchor = prepareV08A19ProdF184Pair(options.baseSeed, record.cluster);
            const expectedArmies = { a: expectedAnchor.armyA, b: expectedAnchor.armyB } as const;
            const anchorGamesValid = record.games.every((game) => {
                const candidate = expectedArmies[game.candidateRoster];
                const control = expectedArmies[game.controlRoster];
                return (
                    game.candidateRosterSignature === rosterSignature(candidate.roster) &&
                    game.controlRosterSignature === rosterSignature(control.roster) &&
                    game.candidateArmyFingerprint === armyFingerprint(candidate) &&
                    game.controlArmyFingerprint === armyFingerprint(control) &&
                    game.setupFingerprint === setupFingerprint(candidate, control, V08_A19_PLACEMENT_AB_MAP) &&
                    game.treatmentApplied &&
                    game.placementChanged
                );
            });
            if (!anchorGamesValid) malformedClusters += 1;
        }
        for (const game of [record.games[0], record.games[2]]) {
            const candidateNames = new Set(game.candidateRosterSignature.split("|").filter(Boolean));
            if (game.controlRosterSignature.split("|").some((name) => candidateNames.has(name))) {
                overlappingRosterAssignments += 1;
            }
        }
        for (const game of record.games) {
            rejectedCandidate += game.rejectedCandidate;
            rejectedControl += game.rejectedControl;
            armageddonDecided += Number(game.armageddonDecided);
            stuck += Number(game.endReason === "stuck");
            treatmentApplied += Number(game.treatmentApplied === true);
            placementChanged += Number(game.placementChanged === true);
            if (game.fallbackReason !== null && legalFallbackReasons.has(game.fallbackReason)) {
                fallbackReasons[game.fallbackReason] += 1;
            }
        }
    }
    for (const cohort of options.cohorts) {
        if (cohortClusters[cohort] !== options.clustersPerCohort) malformedClusters += 1;
        const normalCount = records.filter(
            (record) => record.cohort === cohort && record.map === V08_A19_PLACEMENT_AB_MAP,
        ).length;
        if (normalCount !== options.clustersPerCohort) malformedClusters += 1;
    }
    if (records.length !== expectedClusters || rawLines !== expectedClusters) malformedClusters += 1;
    return {
        expectedClusters,
        clusters: records.length,
        games: records.length * V08_A19_PLACEMENT_AB_CLUSTER_SIZE,
        rawLines,
        malformedClusters,
        duplicateClusters,
        missingClusters: expected.size,
        overlappingRosterAssignments,
        rejectedCandidate,
        rejectedControl,
        armageddonDecided,
        stuck,
        cohortClusters,
        mapClusters,
        sourceUnchanged,
        treatmentApplied,
        placementChanged,
        fallbackReasons,
    };
}

export function evaluateV08A19PlacementValidationGates(
    rankings: IV08A19PlacementAbSummaryRows,
    options: Pick<IV08A19PlacementAbRunnerOptions, "stage" | "clustersPerCohort">,
    completeQuality: boolean,
): Record<string, boolean> {
    const inference = rankings.confirmatoryInference;
    const prodRankedF184ExposureIntegrity =
        inference.prodRankedF184Clusters === options.clustersPerCohort &&
        inference.prodRankedF184OrientationPairs === options.clustersPerCohort * 2 &&
        inference.prodRankedF184ExposedOrientationPairs === options.clustersPerCohort * 2 &&
        inference.prodRankedF184TreatmentGames === options.clustersPerCohort * V08_A19_PLACEMENT_AB_CLUSTER_SIZE;
    const prodRankedF184NoHarm =
        inference.prodRankedF184ScoreRate !== null &&
        inference.prodRankedF184ScoreRate >= V08_A19_PLACEMENT_VALIDATION_GATES.prodRankedAnchorScoreRateInclusive;
    const prodRankedF184BothSeats =
        inference.prodRankedF184GreenScoreRate !== null &&
        inference.prodRankedF184GreenScoreRate >=
            V08_A19_PLACEMENT_VALIDATION_GATES.prodRankedAnchorGreenScoreRateInclusive &&
        inference.prodRankedF184RedScoreRate !== null &&
        inference.prodRankedF184RedScoreRate >=
            V08_A19_PLACEMENT_VALIDATION_GATES.prodRankedAnchorRedScoreRateInclusive;
    const prodRankedF184BothRosters =
        inference.prodRankedF184RosterAScoreRate !== null &&
        inference.prodRankedF184RosterAScoreRate >=
            V08_A19_PLACEMENT_VALIDATION_GATES.prodRankedAnchorRosterAScoreRateInclusive &&
        inference.prodRankedF184RosterBScoreRate !== null &&
        inference.prodRankedF184RosterBScoreRate >=
            V08_A19_PLACEMENT_VALIDATION_GATES.prodRankedAnchorRosterBScoreRateInclusive;
    const leaveOneCohortOutPass = Object.values(inference.leaveOneCohortOutScoreRates).every(
        (score) => score !== null && score > V08_A19_PLACEMENT_VALIDATION_GATES.leaveOneCohortOutScoreRateExclusive,
    );
    return {
        preregisteredForStage: options.stage === "validation",
        completeQuality,
        exposureAdequacy:
            inference.eligibleOrientationPairs >= V08_A19_PLACEMENT_VALIDATION_GATES.minimumEligibleOrientationPairs &&
            inference.eligibleMatchupClusters >= V08_A19_PLACEMENT_VALIDATION_GATES.minimumEligibleMatchupClusters,
        primaryClusteredCi: rankings.eligible.ciLow > V08_A19_PLACEMENT_VALIDATION_GATES.primaryCiLowExclusive,
        clusterBootstrapCi:
            inference.clusterBootstrapCiLow > V08_A19_PLACEMENT_VALIDATION_GATES.bootstrapCiLowExclusive,
        exactClusterSignFlip:
            inference.exactClusterSignFlipTwoSidedP <
            V08_A19_PLACEMENT_VALIDATION_GATES.exactClusterSignFlipTwoSidedPExclusive,
        bothSeats:
            inference.greenScoreRate > V08_A19_PLACEMENT_VALIDATION_GATES.greenScoreRateExclusive &&
            inference.redScoreRate > V08_A19_PLACEMENT_VALIDATION_GATES.redScoreRateExclusive,
        prodRankedF184ExposureIntegrity,
        prodRankedF184NoHarm,
        prodRankedF184BothSeats,
        prodRankedF184BothRosters,
        leaveOneCohortOut: leaveOneCohortOutPass,
        noExposureNegativeControl:
            rankings.noExposureNegativeControl.ciLow <= 0.5 && rankings.noExposureNegativeControl.ciHigh >= 0.5,
        positiveScaledPolicyITT: rankings.policyITT.scaledDeployWideLiftPp > 0,
    };
}

const sourceIdentity = (): { commit: string; sha256: string; files: number } => {
    const root = resolve(import.meta.dir, "../..");
    // Hash every actual source/catalog byte, including untracked transitive research modules. Placement, setup,
    // search, unit catalogs and battle execution have wide dependency graphs, so a git-only manifest can miss
    // a runtime file in a frozen dirty-tree experiment.
    const walk = (directory: string): string[] =>
        readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
            const path = join(directory, entry.name);
            return entry.isDirectory() ? walk(path) : entry.isFile() ? [relative(root, path)] : [];
        });
    const files = [
        ...new Set([
            ...walk(join(root, "src")),
            ...V08_A19_PLACEMENT_AB_EXPLICIT_SOURCE_FILES,
            ...["package.json", "bun.lock", "bunfig.toml"].filter((file) => existsSync(join(root, file))),
        ]),
    ].sort();
    const hash = createHash("sha256");
    for (const file of files) {
        hash.update(relative(root, join(root, file)));
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
    createHash("sha256")
        .update(
            JSON.stringify(
                Object.entries(buildV08A19PlacementAbEnvironment()).sort(([left], [right]) =>
                    left.localeCompare(right),
                ),
            ),
        )
        .digest("hex");

async function runTasks(
    options: IV08A19PlacementAbRunnerOptions,
    rawPath: string,
): Promise<IV08A19PlacementAbClusterRecord[]> {
    const tasks: IWorkerTask[] = options.cohorts.flatMap((cohort) =>
        Array.from({ length: options.clustersPerCohort }, (_, cluster) => ({ cohort, cluster })),
    );
    const records: IV08A19PlacementAbClusterRecord[] = [];
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
                worker.postMessage({ type: "stop" });
                return;
            }
            worker.postMessage({
                type: "cluster",
                options: {
                    cohort: task.cohort,
                    clustersPerCohort: options.clustersPerCohort,
                    baseSeed: options.baseSeed,
                    maxLaps: options.maxLaps,
                } satisfies IV08A19PlacementAbClusterOptions,
                cluster: task.cluster,
            });
        };
        for (let index = 0; index < Math.min(options.concurrency, tasks.length); index += 1) {
            const worker = new Worker(new URL("./v0_8_a19_placement_ab_worker.ts", import.meta.url), {
                env: environment,
            });
            workers.push(worker);
            worker.on("message", (message: WorkerResponse) => {
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
                        `[a19-placement-ab] ${completed}/${tasks.length} clusters (${completed * V08_A19_PLACEMENT_AB_CLUSTER_SIZE} fights)`,
                    );
                }
                if (completed === tasks.length) {
                    settled = true;
                    cleanup();
                    records.sort(
                        (left, right) => left.cohort.localeCompare(right.cohort) || left.cluster - right.cluster,
                    );
                    resolvePromise(records);
                    return;
                }
                dispatch(worker);
            });
            worker.on("error", fail);
            worker.on("exit", (code) => {
                if (!settled && (!draining.has(worker) || code !== 0)) {
                    fail(new Error(`A19 placement A/B worker exited unexpectedly with code ${code}`));
                }
            });
        }
    });
}

export async function runV08A19PlacementAb(options: IV08A19PlacementAbRunnerOptions): Promise<Record<string, unknown>> {
    const expectedCohorts = JSON.stringify(V08_A19_PLACEMENT_AB_COHORTS);
    if (
        (options.stage !== "smoke" && options.stage !== "validation") ||
        options.clustersPerCohort !== V08_A19_PLACEMENT_AB_CLUSTERS_BY_STAGE[options.stage] ||
        options.baseSeed !== V08_A19_PLACEMENT_AB_SEEDS[options.stage] ||
        options.concurrency !== 12 ||
        options.maxLaps !== 60 ||
        JSON.stringify(options.cohorts) !== expectedCohorts
    ) {
        throw new Error("A19 placement A/B options escaped the fixed all-cohort stage contract");
    }
    if (existsSync(options.output)) {
        throw new Error(`Refusing to resume or overwrite existing A19 placement output ${options.output}`);
    }
    mkdirSync(options.output, { recursive: false });
    const rawPath = join(options.output, V08_A19_PLACEMENT_AB_RAW_FILE);
    writeFileSync(rawPath, "");
    const sourceBefore = sourceIdentity();
    const startedAt = new Date();
    const startedMs = Date.now();
    writeFileSync(
        join(options.output, V08_A19_PLACEMENT_AB_STARTED_FILE),
        `${JSON.stringify(
            {
                schema: V08_A19_PLACEMENT_AB_SCHEMA,
                stage: options.stage,
                options,
                arms: V08_A19_PLACEMENT_AB_ARMS,
                productionAnchor: {
                    binding: V08_A19_PROD_F184_RECORD_BINDING,
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
    const quality = validateV08A19PlacementAbRecords(records, options, rawLines, sourceUnchanged);
    const rankings = summarizeV08A19PlacementAbRecords(records);
    const complete =
        quality.malformedClusters === 0 &&
        quality.duplicateClusters === 0 &&
        quality.missingClusters === 0 &&
        quality.overlappingRosterAssignments === 0 &&
        quality.rejectedCandidate === 0 &&
        quality.rejectedControl === 0 &&
        quality.stuck === 0 &&
        quality.sourceUnchanged;
    const validationGates = evaluateV08A19PlacementValidationGates(rankings, options, complete);
    const validationPassed = Object.values(validationGates).every(Boolean);
    const summary = {
        schema: V08_A19_PLACEMENT_AB_SCHEMA,
        complete,
        stage: options.stage,
        generatedAt: new Date().toISOString(),
        seconds: (Date.now() - startedMs) / 1_000,
        options: {
            ...options,
            clusterSize: V08_A19_PLACEMENT_AB_CLUSTER_SIZE,
            totalClusters: options.clustersPerCohort * options.cohorts.length,
            totalGames: options.clustersPerCohort * options.cohorts.length * V08_A19_PLACEMENT_AB_CLUSTER_SIZE,
        },
        estimand: {
            descriptiveOverall: "draw-aware candidate score over all eight cohorts, including the production anchor",
            eligible:
                "broad seven-cohort mean two-game crossover score for exposed physical orientations; production anchor excluded",
            noExposureNegativeControl:
                "broad seven-cohort crossover where neither placement received treatment; production anchor excluded",
            policyITT: "broad seven-cohort eligible lift scaled by natural exposure; production anchor excluded",
            productionAnchor:
                "separate exact conditional replay of prod f184 setup; required no-harm check, not a ranked-draft distribution estimate",
            confidenceInterval: "two-sided normal 95% with matchup-cluster robust standard error",
            treatment: V08_A19_PLACEMENT_AB_ARMS.candidate.profile.candidateId,
            control: `${V08_A19_PLACEMENT_AB_ARMS.control.profile.candidateId} with plain StrategyV0_8 placement`,
            combat: "identical v0.8+A19/H18 on both seats",
            placementVisibility: "complete public opponent creature identities only",
            setupTiming: "setup-before-placement",
        },
        cohortDescriptions: Object.fromEntries(
            options.cohorts.map((cohort) => [
                cohort,
                cohort === V08_A19_PROD_F184_COHORT
                    ? `Exact conditional production anchor ${V08_A19_PROD_F184_MATCH_ID}; not a ranked-draft distribution sample.`
                    : AI_META_COHORT_DESCRIPTIONS[cohort],
            ]),
        ),
        rankings,
        quality,
        validation: {
            gates: V08_A19_PLACEMENT_VALIDATION_GATES,
            results: validationGates,
            passed: validationPassed,
            rule: "reject v9 evidence if any preregistered broad-efficacy, production-anchor, provenance, or safety gate fails",
        },
        provenance: {
            arms: V08_A19_PLACEMENT_AB_ARMS,
            productionAnchor: {
                binding: V08_A19_PROD_F184_RECORD_BINDING,
                fixture: V08_A19_PROD_F184_ANCHOR,
            },
            sourceBefore,
            sourceAfter,
            environmentSha256: environmentSha256(),
            startedAt: startedAt.toISOString(),
            runtime: { bun: Bun.version, platform: platform(), arch: arch() },
        },
    };
    writeFileSync(join(options.output, V08_A19_PLACEMENT_AB_SUMMARY_FILE), `${JSON.stringify(summary, null, 2)}\n`);
    return summary;
}

async function main(): Promise<void> {
    const options = parseV08A19PlacementAbOptions(process.argv.slice(2));
    const summary = await runV08A19PlacementAb(options);
    console.log(JSON.stringify(summary, null, 2));
    const validationPassed = (summary.validation as { passed?: boolean } | undefined)?.passed === true;
    if (summary.complete !== true || (options.stage === "validation" && !validationPassed)) process.exitCode = 1;
}

if (import.meta.main) {
    void main().catch((error) => {
        console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
        process.exitCode = 1;
    });
}
