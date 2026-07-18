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
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

import { LEAGUE_ROUND1_DRAFT_SPEC, parseDraftGenome, projectDraftGenomeForShipping } from "../../ai/setup/draft_ship";
import { parseConditionalRules } from "../../ai/setup/setup_conditional";
import { FightStateManager } from "../../fights/fight_state_manager";
import { PBTypes } from "../../generated/protobuf/v1/types";
import { runMatch, type IMatchConfig, type IMatchResult, type Side } from "../battle_engine";
import { runRankedConditionalPickGame, type IConditionalArmy } from "../measure_setup_conditional";
import {
    augmentPlanId,
    cloneNonFightPolicy,
    compileNonFightSetupPolicy,
    enumerateFullBudgetAugmentPlans,
    pairedSetupEstimate,
    SETUP_COHORTS,
    SETUP_DIAGNOSTIC_TAGS,
    SETUP_GUARD_THRESHOLDS,
    SETUP_LIVE_GRID_TYPES,
    SETUP_NAMED_GUARD_TAGS,
    setupCohort,
    setupDiagnosticTags,
    setupGuardPromotable,
    setupLiveGridType,
    setupPanelSeed,
    shippedNonFightPolicy,
    SYNERGY_POLICY_VARIANTS,
    T2_POLICY_VARIANTS,
    V07_SETUP_CONDITIONAL_SPEC,
    V07_SETUP_BUDGET,
    V07_SETUP_DRAFT_SPEC,
    V07_SETUP_FIGHT_VERSION,
    V07_SETUP_OVERNIGHT_SCHEMA_VERSION,
    type INonFightCandidatePolicy,
    type IPairedSetupEstimate,
    type ISetupEvaluatedGame,
    type ISetupEvaluatedPair,
    type SetupCohort,
    type SetupDiagnosticTag,
    type SetupLiveGridType,
    type SetupSeedPanel,
} from "./v0_7_setup_overnight_core";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const CONDITIONAL_ALL = parseConditionalRules(V07_SETUP_CONDITIONAL_SPEC);
const CONTROL_SYMMETRY_PAIRS = 4;
const LIVE_GRID_LABELS: Record<SetupLiveGridType, "NORMAL" | "LAVA_CENTER" | "BLOCK_CENTER"> = {
    [PBTypes.GridVals.NORMAL]: "NORMAL",
    [PBTypes.GridVals.LAVA_CENTER]: "LAVA_CENTER",
    [PBTypes.GridVals.BLOCK_CENTER]: "BLOCK_CENTER",
};

export type SetupSearchFamily = "augment" | "tier2" | "synergy" | "placement-reveal";

export interface ISetupSearchLane {
    id: string;
    family: SetupSearchFamily;
    cohort?: SetupCohort;
    /** False means evidence is diagnostic only and cannot update the promotable incumbent. */
    eligible: boolean;
}

export function setupSearchLanes(): ISetupSearchLane[] {
    return [
        ...SETUP_COHORTS.map((cohort) => ({
            id: `augment/${cohort}`,
            family: "augment" as const,
            cohort,
            eligible: true,
        })),
        ...SETUP_COHORTS.map((cohort) => ({ id: `tier2/${cohort}`, family: "tier2" as const, cohort, eligible: true })),
        { id: "synergy/situational", family: "synergy", eligible: true },
        { id: "placement/legitimate-reveal", family: "placement-reveal", eligible: true },
        { id: "placement/public-roster", family: "placement-reveal", eligible: true },
    ];
}

export interface ILaneCandidate {
    policy: INonFightCandidatePolicy;
    control: boolean;
}

export function candidatesForLane(
    lane: ISetupSearchLane,
    incumbent: INonFightCandidatePolicy,
    candidateLimit: number,
): ILaneCandidate[] {
    const control = cloneNonFightPolicy(incumbent);
    control.id = `${lane.id}/control`;
    const candidates: ILaneCandidate[] = [{ policy: control, control: true }];
    if (lane.family === "augment") {
        const cohort = lane.cohort!;
        for (const plan of enumerateFullBudgetAugmentPlans()) {
            if (augmentPlanId(plan) === augmentPlanId(incumbent.augmentsByCohort[cohort])) {
                continue;
            }
            const policy = cloneNonFightPolicy(incumbent);
            policy.id = `${lane.id}/${augmentPlanId(plan)}`;
            policy.augmentsByCohort[cohort] = { ...plan };
            candidates.push({ policy, control: false });
        }
    } else if (lane.family === "tier2") {
        const cohort = lane.cohort!;
        for (const variant of T2_POLICY_VARIANTS) {
            if (variant === incumbent.tier2ByCohort[cohort]) continue;
            const policy = cloneNonFightPolicy(incumbent);
            policy.id = `${lane.id}/${variant}`;
            policy.tier2ByCohort[cohort] = variant;
            candidates.push({ policy, control: false });
        }
    } else if (lane.family === "synergy") {
        for (const variant of SYNERGY_POLICY_VARIANTS) {
            if (variant === incumbent.synergy) continue;
            const policy = cloneNonFightPolicy(incumbent);
            policy.id = `${lane.id}/${variant}`;
            policy.synergy = variant;
            candidates.push({ policy, control: false });
        }
    } else {
        const policy = cloneNonFightPolicy(incumbent);
        policy.id = `${lane.id}/on`;
        policy.placement = lane.id === "placement/public-roster" ? "public-roster" : "legitimate-reveal";
        candidates.push({ policy, control: false });
    }
    if (candidateLimit > 0 && candidates.length > candidateLimit) {
        return [candidates[0], ...candidates.slice(1, candidateLimit)];
    }
    return candidates;
}

interface ISetupEvaluationJob {
    candidate: INonFightCandidatePolicy;
    seed: number;
}

interface ISetupEvaluationJobResult {
    candidateId: string;
    pair: ISetupEvaluatedPair;
}

type SetupWorkerReply =
    { type: "ready" } | { type: "result"; result: ISetupEvaluationJobResult } | { type: "error"; error: string };

if (LEAGUE_ROUND1_DRAFT_SPEC !== V07_SETUP_DRAFT_SPEC) {
    throw new Error(
        `setup campaign draft pin ${V07_SETUP_DRAFT_SPEC} does not match shipped ${LEAGUE_ROUND1_DRAFT_SPEC}`,
    );
}
const shippedGenome = projectDraftGenomeForShipping(parseDraftGenome(LEAGUE_ROUND1_DRAFT_SPEC));

interface ICollectedSetupSeeds {
    seeds: number[];
    nextCursor: number;
    scanned: number;
}

type CohortTiming = "final-roster" | "artifact-2";

function seedMatchesSetupSurface(
    seed: number,
    cohort?: SetupCohort,
    tag?: SetupDiagnosticTag,
    cohortTiming: CohortTiming = "final-roster",
): boolean {
    if (!cohort && (!tag || tag === "aggregate")) return true;
    const tier2Cohorts = new Set<SetupCohort>();
    const pick = runRankedConditionalPickGame(
        seed,
        CONDITIONAL_ALL,
        shippedGenome,
        cohortTiming === "artifact-2"
            ? {
                  pickArtifactT2: (_team, _offered, ownCreatureIdsAtTier2) => {
                      tier2Cohorts.add(setupCohort(ownCreatureIdsAtTier2));
                      return undefined;
                  },
              }
            : {},
    );
    const armies = [pick.lower, pick.upper];
    if (
        cohort &&
        (cohortTiming === "artifact-2"
            ? tier2Cohorts.has(cohort)
            : armies.some((army) => setupCohort(army.creatureIds) === cohort))
    ) {
        return true;
    }
    return !!tag && tag !== "aggregate" && armies.some((army) => setupDiagnosticTags(army.creatureIds).includes(tag));
}

/** Select deterministic real-pick seeds; skipped seeds are burned so panels remain disjoint after restart. */
function collectSetupSeeds(
    baseSeed: number,
    panel: SetupSeedPanel,
    cursor: number,
    count: number,
    cohort?: SetupCohort,
    tag?: SetupDiagnosticTag,
    cohortTiming: CohortTiming = "final-roster",
): ICollectedSetupSeeds {
    const seeds: number[] = [];
    const maximumScans = Math.max(20_000, count * 2_000);
    let scanned = 0;
    while (seeds.length < count && scanned < maximumScans) {
        const seed = setupPanelSeed(baseSeed, panel, cursor + scanned);
        scanned += 1;
        if (seedMatchesSetupSurface(seed, cohort, tag, cohortTiming)) seeds.push(seed);
    }
    return { seeds, nextCursor: cursor + scanned, scanned };
}

function candidateArmySetup(policy: INonFightCandidatePolicy, army: IConditionalArmy) {
    const resolved = compileNonFightSetupPolicy(policy, policy.id);
    return {
        augments: resolved.pickAugments(V07_SETUP_BUDGET, army.creatureIds),
        synergies: resolved.pickSynergies(army.creatureIds),
        placement: resolved.placement,
    };
}

function resultForCandidateSide(result: IMatchResult, side: Side): ISetupEvaluatedGame["candidateResult"] {
    if (result.winner === "draw") return "draw";
    return result.winner === side ? "win" : "loss";
}

function matchTraceSha256(result: IMatchResult): string {
    return sha256(
        JSON.stringify({
            seed: result.seed,
            gridType: result.gridType,
            winner: result.winner,
            endReason: result.endReason,
            laps: result.laps,
            totalActions: result.totalActions,
            placements: result.placements,
            actions: result.actions,
            outcome: result.outcome,
            attrition: result.attrition,
            rejectedGreen: result.rejectedGreen,
            rejectedRed: result.rejectedRed,
            rejectedDetails: result.rejectedDetails,
        }),
    );
}

function playCandidateSide(
    policy: INonFightCandidatePolicy,
    seed: number,
    candidateSide: Side,
    gridType: SetupLiveGridType,
): ISetupEvaluatedGame {
    const candidateTeam = candidateSide === "green" ? LOWER : UPPER;
    const resolved = compileNonFightSetupPolicy(policy, policy.id);
    const pick = runRankedConditionalPickGame(seed, CONDITIONAL_ALL, shippedGenome, {
        pickArtifactT2: (team, offered, ownCreatureIdsAtTier2) => {
            if (team !== candidateTeam) return undefined;
            return resolved.pickArtifactT2(offered, ownCreatureIdsAtTier2);
        },
    });
    const candidateArmy = candidateTeam === LOWER ? pick.lower : pick.upper;
    const opponentArmy = candidateTeam === LOWER ? pick.upper : pick.lower;
    const setup = candidateArmySetup(policy, candidateArmy);
    const candidateReveals =
        policy.placement === "legitimate-reveal" || policy.placement === "public-roster"
            ? candidateArmy.revealedOpponentCreatures
            : [];
    const candidatePublicOpponentCreatures =
        policy.placement === "public-roster" ? [...new Set(opponentArmy.creatureIds)] : undefined;
    const candidateIsLower = candidateTeam === LOWER;
    const config: IMatchConfig = {
        greenVersion: V07_SETUP_FIGHT_VERSION,
        redVersion: V07_SETUP_FIGHT_VERSION,
        roster: pick.lower.roster,
        redRoster: pick.upper.roster,
        seed,
        gridType,
        greenPerk: pick.lower.perk,
        redPerk: pick.upper.perk,
        greenAugments: candidateIsLower ? setup.augments : pick.lower.augments,
        redAugments: candidateIsLower ? pick.upper.augments : setup.augments,
        greenArtifactT1: pick.lower.tier1Artifact,
        redArtifactT1: pick.upper.tier1Artifact,
        greenArtifactT2: pick.lower.tier2Artifact,
        redArtifactT2: pick.upper.tier2Artifact,
        greenSynergies: candidateIsLower ? setup.synergies : pick.lower.synergies,
        redSynergies: candidateIsLower ? pick.upper.synergies : setup.synergies,
        greenRevealedCreatures: candidateIsLower ? candidateReveals : undefined,
        redRevealedCreatures: candidateIsLower ? undefined : candidateReveals,
        ...(candidateIsLower && candidatePublicOpponentCreatures
            ? { greenPublicOpponentCreatures: candidatePublicOpponentCreatures }
            : {}),
        ...(!candidateIsLower && candidatePublicOpponentCreatures
            ? { redPublicOpponentCreatures: candidatePublicOpponentCreatures }
            : {}),
        greenSetupPlacementPolicy: candidateIsLower ? setup.placement : "baseline",
        redSetupPlacementPolicy: candidateIsLower ? "baseline" : setup.placement,
        placementAugmentTiming: policy.placementAugmentTiming,
    };
    FightStateManager.getInstance();
    const result = runMatch(config);
    if (result.gridType !== gridType) {
        throw new Error(`match grid mismatch for seed ${seed}: expected ${gridType}, received ${result.gridType}`);
    }
    const candidateRejections = candidateIsLower ? result.rejectedGreen : result.rejectedRed;
    const baselineRejections = candidateIsLower ? result.rejectedRed : result.rejectedGreen;
    if (candidateRejections === undefined || baselineRejections === undefined) {
        throw new Error(`missing setup rejection telemetry for seed ${seed} candidateSide=${candidateSide}`);
    }
    return {
        candidateSide,
        candidateResult: resultForCandidateSide(result, candidateSide),
        candidateRejections,
        baselineRejections,
        laps: result.laps,
        endReason: result.endReason,
        decidedByArmageddon: result.attrition.decidedByArmageddon,
        traceSha256: matchTraceSha256(result),
        tags: setupDiagnosticTags(candidateArmy.creatureIds),
    };
}

/** One cluster is the same pick/combat seed with the candidate assigned to each battle side exactly once. */
export function evaluateSetupPair(candidate: INonFightCandidatePolicy, seed: number): ISetupEvaluatedPair {
    const gridType = setupLiveGridType(seed);
    return {
        seed,
        gridType,
        games: [
            playCandidateSide(candidate, seed, "green", gridType),
            playCandidateSide(candidate, seed, "red", gridType),
        ],
    };
}

async function evaluateBatch(
    candidates: readonly INonFightCandidatePolicy[],
    seeds: readonly number[],
    workers: number,
    deadlineMs: number,
    onProgress?: (completed: number, total: number) => void,
): Promise<{ complete: boolean; pairsByCandidate: Map<string, ISetupEvaluatedPair[]> }> {
    const ids = candidates.map((candidate) => candidate.id);
    if (new Set(ids).size !== ids.length) throw new Error("evaluation candidate ids must be unique");
    if (new Set(seeds).size !== seeds.length) throw new Error("evaluation seeds must be unique");
    const pairsByCandidate = new Map(candidates.map((candidate) => [candidate.id, [] as ISetupEvaluatedPair[]]));
    const jobs: ISetupEvaluationJob[] = seeds.flatMap((seed) => candidates.map((candidate) => ({ candidate, seed })));
    if (!jobs.length) return { complete: true, pairsByCandidate };
    const poolSize = Math.max(1, Math.min(Math.floor(workers), jobs.length));
    if (poolSize === 1) {
        let completed = 0;
        for (const job of jobs) {
            if (Date.now() >= deadlineMs) return { complete: false, pairsByCandidate };
            pairsByCandidate.get(job.candidate.id)!.push(evaluateSetupPair(job.candidate, job.seed));
            completed += 1;
            onProgress?.(completed, jobs.length);
        }
        return { complete: true, pairsByCandidate };
    }
    return await new Promise((resolvePromise, rejectPromise) => {
        const active = new Set<Worker>();
        let next = 0;
        let completed = 0;
        let stopped = false;
        let settled = false;
        const intentionallyStopping = new WeakSet<Worker>();
        const cleanup = (): void => {
            for (const worker of active) void worker.terminate();
            active.clear();
        };
        const finish = (complete: boolean): void => {
            if (settled) return;
            settled = true;
            cleanup();
            resolvePromise({ complete, pairsByCandidate });
        };
        const fail = (error: unknown): void => {
            if (settled) return;
            settled = true;
            cleanup();
            rejectPromise(error instanceof Error ? error : new Error(String(error)));
        };
        const dispatch = (worker: Worker): void => {
            if (Date.now() >= deadlineMs) stopped = true;
            if (stopped || next >= jobs.length) {
                intentionallyStopping.add(worker);
                worker.postMessage({ type: "stop" });
                if (completed >= next && (stopped || next >= jobs.length))
                    finish(!stopped && completed === jobs.length);
                return;
            }
            worker.postMessage({ type: "job", job: jobs[next++] });
        };
        for (let index = 0; index < poolSize; index += 1) {
            const worker = new Worker(new URL(import.meta.url), { workerData: { v07SetupOvernightWorker: true } });
            active.add(worker);
            worker.on("message", (message: SetupWorkerReply) => {
                if (settled) return;
                if (message.type === "error") {
                    fail(new Error(message.error));
                    return;
                }
                if (message.type === "ready") {
                    dispatch(worker);
                    return;
                }
                pairsByCandidate.get(message.result.candidateId)!.push(message.result.pair);
                completed += 1;
                onProgress?.(completed, jobs.length);
                if (completed === jobs.length) {
                    finish(true);
                    return;
                }
                dispatch(worker);
            });
            worker.on("error", fail);
            worker.on("exit", (code) => {
                active.delete(worker);
                if (settled) return;
                if (code !== 0) {
                    fail(new Error(`setup evaluation worker exited with code ${code}`));
                    return;
                }
                if (!intentionallyStopping.has(worker)) {
                    fail(new Error("setup evaluation worker exited before receiving a stop command"));
                    return;
                }
                if (active.size === 0 && completed < jobs.length) {
                    if (stopped) finish(false);
                    else fail(new Error(`all setup workers exited after ${completed}/${jobs.length} jobs`));
                }
            });
        }
    });
}

interface ICandidateEvidence {
    candidateId: string;
    control: boolean;
    estimate: IPairedSetupEstimate;
}

interface ILaneEvidence {
    pass: number;
    lane: ISetupSearchLane;
    trainSeedStart: number;
    trainPairs: number;
    candidates: ICandidateEvidence[];
    selectedCandidateId?: string;
    selectionSeedStart?: number;
    selection?: { candidate: IPairedSetupEstimate; incumbent: IPairedSetupEstimate; adopted: boolean };
}

interface IByteIdenticalReplay {
    samplePairs: number;
    seeds: number[];
    serialization: "JSON.stringify pairs sorted by uint32 seed";
    originalSha256: string;
    replaySha256: string;
    byteIdentical: boolean;
    completedAt: string;
}

interface ISetupCheckpoint {
    schemaVersion: typeof V07_SETUP_OVERNIGHT_SCHEMA_VERSION;
    status: "running" | "complete";
    runId: string;
    seed: number;
    startedAt: string;
    updatedAt: string;
    completedAt?: string;
    deadlineMs: number;
    searchDeadlineMs: number;
    config: IRunnerOptions;
    /** Guard evidence can never feed back into search, including after a crash/restart. */
    phase: "search" | "guard-current" | "guard-intended" | "complete";
    pass: number;
    laneIndex: number;
    trainCursor: number;
    selectionCursor: number;
    guardCursor: number;
    incumbent: INonFightCandidatePolicy;
    intendedChampion?: INonFightCandidatePolicy;
    intendedChampionSelection?: IPairedSetupEstimate;
    laneEvidence: ILaneEvidence[];
    intendedOnlyEvidence: ILaneEvidence[];
    guardPairs: ISetupEvaluatedPair[];
    guardDiagnosticIndex: number;
    diagnosticGuardPairs: Record<(typeof SETUP_NAMED_GUARD_TAGS)[number], ISetupEvaluatedPair[]>;
    symmetryControlPairs: ISetupEvaluatedPair[];
    intendedGuardPairs: ISetupEvaluatedPair[];
    replay?: IByteIdenticalReplay;
}

interface IRunnerOptions {
    out: string;
    workers: number;
    deadlineMs: number;
    runId: string;
    seed: number;
    trainPairs: number;
    selectionPairs: number;
    guardPairs: number;
    diagnosticGuardPairs: number;
    guardChunkPairs: number;
    candidateLimit: number;
    maxPasses: number;
    smoke: boolean;
}

const RESUME_IDENTITY_KEYS = [
    "out",
    "workers",
    "runId",
    "seed",
    "trainPairs",
    "selectionPairs",
    "guardPairs",
    "diagnosticGuardPairs",
    "guardChunkPairs",
    "candidateLimit",
    "maxPasses",
    "smoke",
] as const satisfies readonly (keyof IRunnerOptions)[];

function atomicJson(path: string, value: unknown): void {
    const temporary = `${path}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temporary, path);
}

function replayJson(pairs: readonly ISetupEvaluatedPair[]): string {
    return JSON.stringify([...pairs].sort((left, right) => left.seed - right.seed));
}

function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

function assertCheckpointGuardSeedIntegrity(checkpoint: Readonly<ISetupCheckpoint>): void {
    const sources: Array<readonly [string, readonly ISetupEvaluatedPair[]]> = [
        ["aggregate", checkpoint.guardPairs],
        ...SETUP_NAMED_GUARD_TAGS.map((tag) => [`diagnostic/${tag}`, checkpoint.diagnosticGuardPairs[tag]] as const),
        ["symmetry-control", checkpoint.symmetryControlPairs],
        ["legacy-diagnostic", checkpoint.intendedGuardPairs],
    ];
    const ownerBySeed = new Map<number, string>();
    for (const [source, pairs] of sources) {
        pairedSetupEstimate(pairs);
        for (const pair of pairs) {
            if (pair.seed >>> 30 !== 2) throw new Error(`${source} seed ${pair.seed} is outside the guard panel`);
            const prior = ownerBySeed.get(pair.seed);
            if (prior) throw new Error(`guard seed ${pair.seed} is reused by ${prior} and ${source}`);
            ownerBySeed.set(pair.seed, source);
        }
    }
    if (checkpoint.replay) {
        if (
            checkpoint.replay.samplePairs !== checkpoint.replay.seeds.length ||
            new Set(checkpoint.replay.seeds).size !== checkpoint.replay.seeds.length
        ) {
            throw new Error("deterministic replay seed record is incomplete or duplicated");
        }
        const aggregateSeeds = new Set(checkpoint.guardPairs.map((pair) => pair.seed));
        for (const seed of checkpoint.replay.seeds) {
            if (!aggregateSeeds.has(seed))
                throw new Error(`deterministic replay seed ${seed} is not in aggregate guard`);
        }
    }
}

function rankEvidence(
    candidates: readonly ILaneCandidate[],
    pairsByCandidate: ReadonlyMap<string, ISetupEvaluatedPair[]>,
): ICandidateEvidence[] {
    return candidates
        .map(({ policy, control }) => ({
            candidateId: policy.id,
            control,
            estimate: pairedSetupEstimate(pairsByCandidate.get(policy.id) ?? []),
        }))
        .sort(
            (left, right) =>
                (right.estimate.confidence95LowGainPp ?? -Infinity) -
                    (left.estimate.confidence95LowGainPp ?? -Infinity) ||
                right.estimate.decisiveWinRate - left.estimate.decisiveWinRate ||
                left.candidateId.localeCompare(right.candidateId),
        );
}

function reportForCheckpoint(checkpoint: ISetupCheckpoint, completedAt: string) {
    const diagnostics = Object.fromEntries(
        SETUP_DIAGNOSTIC_TAGS.map((tag) => [
            tag,
            pairedSetupEstimate(
                tag === "aggregate" ? checkpoint.guardPairs : checkpoint.diagnosticGuardPairs[tag],
                tag,
            ),
        ]),
    ) as Record<SetupDiagnosticTag, IPairedSetupEstimate>;
    const aggregate = diagnostics.aggregate;
    const liveMapDiagnostics = Object.fromEntries(
        SETUP_LIVE_GRID_TYPES.map((gridType) => [
            gridType,
            pairedSetupEstimate(checkpoint.guardPairs, "aggregate", gridType),
        ]),
    ) as Record<SetupLiveGridType, IPairedSetupEstimate>;
    const intendedDiagnostics = checkpoint.intendedChampion
        ? (Object.fromEntries(
              SETUP_DIAGNOSTIC_TAGS.map((tag) => [tag, pairedSetupEstimate(checkpoint.intendedGuardPairs, tag)]),
          ) as Record<SetupDiagnosticTag, IPairedSetupEstimate>)
        : undefined;
    const currentGuardComplete =
        checkpoint.guardPairs.length >= checkpoint.config.guardPairs &&
        SETUP_NAMED_GUARD_TAGS.every(
            (tag) => checkpoint.diagnosticGuardPairs[tag].length >= checkpoint.config.diagnosticGuardPairs,
        );
    const symmetryControlTarget = checkpoint.config.smoke ? 1 : CONTROL_SYMMETRY_PAIRS;
    const symmetryControl = pairedSetupEstimate(checkpoint.symmetryControlPairs);
    const controlSymmetryPassed =
        checkpoint.symmetryControlPairs.length >= symmetryControlTarget &&
        symmetryControl.wins + symmetryControl.losses > 0 &&
        symmetryControl.wins === symmetryControl.losses &&
        symmetryControl.decisiveWinRate === 0.5 &&
        symmetryControl.candidateRejections === 0 &&
        symmetryControl.baselineRejections === 0;
    const promotable = setupGuardPromotable(
        checkpoint.incumbent.placementAugmentTiming,
        aggregate,
        diagnostics,
        liveMapDiagnostics,
        currentGuardComplete,
        controlSymmetryPassed,
        checkpoint.replay?.byteIdentical === true,
    );
    return {
        schemaVersion: V07_SETUP_OVERNIGHT_SCHEMA_VERSION,
        status: "measurement_only",
        autoBaked: false,
        campaignPhase: checkpoint.phase,
        runId: checkpoint.runId,
        startedAt: checkpoint.startedAt,
        completedAt,
        policy: checkpoint.incumbent,
        decision: {
            promotable,
            currentGuardComplete,
            controlSymmetryPassed,
            byteIdenticalReplay: checkpoint.replay?.byteIdentical === true,
            thresholds: SETUP_GUARD_THRESHOLDS,
            reason: promotable
                ? "Untouched guard clears aggregate paired-cluster LCB, named-cohort floors, and rejection integrity. Owner review is still required."
                : "Untouched guard or server-main placement integrity did not clear the fail-closed promotion bar.",
        },
        panels: {
            train: {
                cursor: checkpoint.trainCursor,
                absoluteSearchDeadlineMs: checkpoint.searchDeadlineMs,
                searchDeadlineExtendedOnResume: false,
                reusedForSelection: false,
            },
            selection: { cursor: checkpoint.selectionCursor, reusedForGuard: false },
            guard: {
                cursor: checkpoint.guardCursor,
                pairs: checkpoint.guardPairs.length,
                intendedPairs: checkpoint.intendedGuardPairs.length,
                symmetryControlPairs: checkpoint.symmetryControlPairs.length,
                diagnosticPairs: Object.fromEntries(
                    SETUP_NAMED_GUARD_TAGS.map((tag) => [tag, checkpoint.diagnosticGuardPairs[tag].length]),
                ),
                untouchedUntilSearchEnded: true,
            },
        },
        guard: diagnostics,
        liveMapGuard: Object.fromEntries(
            SETUP_LIVE_GRID_TYPES.map((gridType) => [LIVE_GRID_LABELS[gridType], liveMapDiagnostics[gridType]]),
        ),
        controlSymmetry: {
            targetPairs: symmetryControlTarget,
            passed: controlSymmetryPassed,
            seeds: checkpoint.symmetryControlPairs.map((pair) => pair.seed),
            sha256: sha256(replayJson(checkpoint.symmetryControlPairs)),
            estimate: symmetryControl,
        },
        deterministicReplay: checkpoint.replay ?? null,
        legacyPreFixDiagnosticGuard: checkpoint.intendedChampion
            ? {
                  status: "legacy_pre_fix_not_promotable",
                  policy: checkpoint.intendedChampion,
                  selection: checkpoint.intendedChampionSelection,
                  guard: intendedDiagnostics,
              }
            : null,
        laneEvidence: checkpoint.laneEvidence,
        legacyPreFixEvidence: checkpoint.intendedOnlyEvidence,
        provenance: {
            draft: V07_SETUP_DRAFT_SPEC,
            conditionalSetup: V07_SETUP_CONDITIONAL_SPEC,
            tier2Timing: "ARTIFACT_2 phase sequence 8 with five own creatures",
            fightVersion: V07_SETUP_FIGHT_VERSION,
            requiredServerCommit: "a03dece30b05852694d569a0c5c17aa993e54c2d",
            maps: SETUP_LIVE_GRID_TYPES.map((gridType) => LIVE_GRID_LABELS[gridType]),
            mapAssignment:
                "deterministic seed modulo 3 over NORMAL/LAVA_CENTER/BLOCK_CENTER; paired arms share one map",
            stackAmounts: "LiveTwin expBudget",
            pairing: "same pick/combat seed; candidate occupies green and red once per cluster",
            replay: "frozen guard pairs are re-evaluated with the same policy and seeds; seed-sorted reduced records include SHA-256 digests of full placements/actions/outcomes and must be byte-identical",
            controlSymmetry:
                "shipped policy versus itself uses later disjoint guard seeds; exact 50% decisive rate and zero setup rejections are mandatory",
            uncertainty:
                "paired-cluster sandwich interval conservatively widened by an effective-cluster Wilson interval",
            guardSampling:
                "aggregate uses the first natural guard stream; named diagnostics scan only later guard indices with one persisted monotone cursor, permanently burning skipped and selected seeds",
            namedGuardDefinitions: {
                ranged: "at least one ranged own creature",
                mage: "at least one MAGIC attack-type own creature",
                "melee-magic": "at least one MELEE_MAGIC attack-type own creature",
                "aura-heavy": "compatibility label; at least one own creature carrying one or more auras",
            },
            placementServerMain:
                "setup-before-placement models the effective final strategy re-placement in the expanded zone after a successful Placement augment",
            placementLegacy:
                "current-live is retained only as the historical pre-fix 3-wide simulation mode and is never promotable",
        },
        limitations: [
            "This runner never edits or auto-bakes a production policy.",
            "Selection-panel evidence is optimization data; only the final guard is untouched evaluation data.",
            "A promoted policy still requires a manual coordinated deploy with server commit a03dece30b05852694d569a0c5c17aa993e54c2d or a descendant containing it.",
            "The policy uses only own roster and legitimately revealed opponent creatures; hidden opponent composition is unavailable.",
        ],
    };
}

function integer(value: string, flag: string, minimum: number = 0): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${flag} must be an integer >= ${minimum}`);
    return parsed;
}

function parseRunnerOptions(): IRunnerOptions {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            out: { type: "string" },
            workers: { type: "string", default: String(Math.min(12, Math.max(1, availableParallelism()))) },
            "deadline-ms": { type: "string" },
            hours: { type: "string" },
            "run-id": { type: "string" },
            seed: { type: "string" },
            "train-pairs": { type: "string", default: "64" },
            "selection-pairs": { type: "string", default: "1024" },
            "guard-pairs": { type: "string", default: "4096" },
            "diagnostic-guard-pairs": { type: "string", default: "512" },
            "guard-chunk-pairs": { type: "string", default: "4096" },
            "candidate-limit": { type: "string", default: "0" },
            "max-passes": { type: "string", default: "1000000" },
            smoke: { type: "boolean", default: false },
            help: { type: "boolean", short: "h", default: false },
        },
        strict: true,
        allowPositionals: false,
    });
    if (values.help) {
        console.log(
            "usage: bun src/simulation/optimizer/v0_7_setup_overnight.ts --out <dir> --workers 12 " +
                "--deadline-ms <epoch-ms> [--run-id id] [--seed n] [--smoke]",
        );
        process.exit(0);
    }
    if (values["deadline-ms"] && values.hours) throw new Error("use only one of --deadline-ms or --hours");
    const now = Date.now();
    const deadlineMs = values["deadline-ms"]
        ? integer(values["deadline-ms"], "--deadline-ms", now + 1)
        : now + Number(values.hours ?? "11") * 3_600_000;
    if (!Number.isFinite(deadlineMs) || deadlineMs <= now) throw new Error("deadline must be in the future");
    const runId = values["run-id"]?.trim() || `v07-setup-${new Date(now).toISOString().replace(/[:.]/g, "-")}`;
    const seed = values.seed ? integer(values.seed, "--seed") : now >>> 0;
    const smoke = values.smoke;
    if (!values.out) throw new Error("--out is required and must point outside the source checkout");
    const out = resolve(values.out);
    const sourceRoot = resolve(process.cwd());
    if (out === sourceRoot || out.startsWith(`${sourceRoot}${sep}`)) {
        throw new Error("--out must point outside the source checkout");
    }
    return {
        out,
        workers: integer(values.workers, "--workers", 1),
        deadlineMs,
        runId,
        seed,
        trainPairs: smoke ? 2 : integer(values["train-pairs"], "--train-pairs", 2),
        selectionPairs: smoke ? 2 : integer(values["selection-pairs"], "--selection-pairs", 2),
        guardPairs: smoke ? 2 : integer(values["guard-pairs"], "--guard-pairs", 2),
        diagnosticGuardPairs: smoke ? 2 : integer(values["diagnostic-guard-pairs"], "--diagnostic-guard-pairs", 2),
        guardChunkPairs: smoke ? 2 : integer(values["guard-chunk-pairs"], "--guard-chunk-pairs", 2),
        candidateLimit: smoke ? 3 : integer(values["candidate-limit"], "--candidate-limit"),
        maxPasses: smoke ? 1 : integer(values["max-passes"], "--max-passes", 1),
        smoke,
    };
}

function configureResearchEnvironment(): void {
    const prefixes = ["V04_", "V05_", "V06_", "V07_", "SEARCH_", "Q2_", "CEM_"];
    const exact = new Set([
        "FIGHT_MELEE_ROSTERS",
        "FORCE_CREATURES",
        "MAPS",
        "RANDOM",
        "ROSTER_RANGED_MAX",
        "ROSTER_RANGED_MIN",
        "SIM_NO_ACTIONS",
        "VALUE_DATA",
        "VALUE_DATA_FEATURES",
    ]);
    for (const key of Object.keys(process.env)) {
        if (exact.has(key) || prefixes.some((prefix) => key.startsWith(prefix))) delete process.env[key];
    }
    process.env.LIVETWIN = "1";
    process.env.V07_SEARCH = "0";
    // The gate is process-global, but only the candidate side receives legitimate reveals in each game.
    process.env.V07_PLACEMENT_REVEAL = "on";
}

async function main(): Promise<void> {
    const options = parseRunnerOptions();
    configureResearchEnvironment();
    mkdirSync(options.out, { recursive: true });
    const checkpointPath = join(options.out, "checkpoint.json");
    const finalPath = join(options.out, "final.json");
    const logPath = join(options.out, "trace.log");
    const log = (message: string): void => {
        const line = `${new Date().toISOString()} ${message}`;
        console.error(line);
        appendFileSync(logPath, `${line}\n`);
    };
    let checkpoint: ISetupCheckpoint;
    if (existsSync(checkpointPath)) {
        checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8")) as ISetupCheckpoint;
        if (checkpoint.schemaVersion !== V07_SETUP_OVERNIGHT_SCHEMA_VERSION)
            throw new Error("checkpoint schema mismatch");
        if (checkpoint.runId !== options.runId || checkpoint.seed !== options.seed) {
            throw new Error("checkpoint run-id/seed does not match this invocation");
        }
        for (const key of RESUME_IDENTITY_KEYS) {
            if (checkpoint.config[key] !== options[key]) {
                throw new Error(
                    `checkpoint option ${key}=${JSON.stringify(checkpoint.config[key])} does not match ` +
                        `invocation value ${JSON.stringify(options[key])}; only --deadline-ms may change on resume`,
                );
            }
        }
        checkpoint.searchDeadlineMs ??= options.smoke
            ? checkpoint.config.deadlineMs
            : Date.parse(checkpoint.startedAt) +
              Math.floor((checkpoint.config.deadlineMs - Date.parse(checkpoint.startedAt)) * 0.78);
        if (
            !Number.isSafeInteger(checkpoint.searchDeadlineMs) ||
            checkpoint.searchDeadlineMs < Date.parse(checkpoint.startedAt) ||
            checkpoint.searchDeadlineMs > checkpoint.config.deadlineMs
        ) {
            throw new Error("checkpoint has an invalid persisted search deadline");
        }
        checkpoint.guardDiagnosticIndex ??= 0;
        checkpoint.diagnosticGuardPairs ??= { ranged: [], mage: [], "melee-magic": [], "aura-heavy": [] };
        checkpoint.symmetryControlPairs ??= [];
        checkpoint.intendedGuardPairs ??= [];
        const firstIncompleteDiagnostic = SETUP_NAMED_GUARD_TAGS.findIndex(
            (tag) => checkpoint.diagnosticGuardPairs[tag].length < options.diagnosticGuardPairs,
        );
        checkpoint.guardDiagnosticIndex =
            firstIncompleteDiagnostic < 0 ? SETUP_NAMED_GUARD_TAGS.length : firstIncompleteDiagnostic;
        checkpoint.phase ??=
            checkpoint.status === "complete"
                ? "complete"
                : checkpoint.intendedGuardPairs?.length
                  ? "guard-intended"
                  : checkpoint.guardPairs.length
                    ? "guard-current"
                    : "search";
        const symmetryControlTarget = options.smoke ? 1 : CONTROL_SYMMETRY_PAIRS;
        const currentGuardCoverageComplete =
            checkpoint.guardPairs.length >= options.guardPairs &&
            SETUP_NAMED_GUARD_TAGS.every(
                (tag) => checkpoint.diagnosticGuardPairs[tag].length >= options.diagnosticGuardPairs,
            ) &&
            checkpoint.symmetryControlPairs.length >= symmetryControlTarget &&
            checkpoint.replay !== undefined;
        if (
            !currentGuardCoverageComplete &&
            (checkpoint.phase === "guard-intended" || checkpoint.phase === "complete")
        ) {
            checkpoint.phase = "guard-current";
        } else if (
            checkpoint.phase === "complete" &&
            checkpoint.intendedChampion &&
            checkpoint.intendedGuardPairs.length < options.guardPairs
        ) {
            checkpoint.phase = "guard-intended";
        }
        checkpoint.status = checkpoint.phase === "complete" ? "complete" : "running";
        checkpoint.deadlineMs = options.deadlineMs;
        checkpoint.config.deadlineMs = options.deadlineMs;
        log(`resuming pass=${checkpoint.pass} lane=${checkpoint.laneIndex} guardPairs=${checkpoint.guardPairs.length}`);
    } else {
        const startedAtMs = Date.now();
        checkpoint = {
            schemaVersion: V07_SETUP_OVERNIGHT_SCHEMA_VERSION,
            status: "running",
            runId: options.runId,
            seed: options.seed,
            startedAt: new Date(startedAtMs).toISOString(),
            updatedAt: new Date(startedAtMs).toISOString(),
            deadlineMs: options.deadlineMs,
            searchDeadlineMs: options.smoke
                ? options.deadlineMs
                : startedAtMs + Math.floor((options.deadlineMs - startedAtMs) * 0.78),
            config: options,
            phase: "search",
            pass: 0,
            laneIndex: 0,
            trainCursor: 0,
            selectionCursor: 0,
            guardCursor: 0,
            incumbent: shippedNonFightPolicy(),
            laneEvidence: [],
            intendedOnlyEvidence: [],
            guardPairs: [],
            guardDiagnosticIndex: 0,
            diagnosticGuardPairs: { ranged: [], mage: [], "melee-magic": [], "aura-heavy": [] },
            symmetryControlPairs: [],
            intendedGuardPairs: [],
        };
        writeFileSync(logPath, "");
    }
    const save = (): void => {
        checkpoint.updatedAt = new Date().toISOString();
        atomicJson(checkpointPath, checkpoint);
    };
    assertCheckpointGuardSeedIntegrity(checkpoint);
    save();
    const searchDeadline = Math.min(checkpoint.searchDeadlineMs, options.deadlineMs);
    const lanes = setupSearchLanes();
    let searchComplete = false;
    while (checkpoint.phase === "search" && Date.now() < searchDeadline && checkpoint.pass < options.maxPasses) {
        if (checkpoint.laneIndex >= lanes.length) {
            checkpoint.pass += 1;
            checkpoint.laneIndex = 0;
            save();
            continue;
        }
        const lane = lanes[checkpoint.laneIndex];
        const candidates = candidatesForLane(lane, checkpoint.incumbent, options.candidateLimit);
        const trainStart = checkpoint.trainCursor;
        const collectedTrain = collectSetupSeeds(
            options.seed,
            "train",
            trainStart,
            options.trainPairs,
            lane.cohort,
            undefined,
            lane.family === "tier2" ? "artifact-2" : "final-roster",
        );
        const trainSeeds = collectedTrain.seeds;
        checkpoint.trainCursor = collectedTrain.nextCursor;
        save();
        log(
            `pass=${checkpoint.pass} lane=${lane.id} candidates=${candidates.length} ` +
                `trainPairs=${trainSeeds.length} scanned=${collectedTrain.scanned}`,
        );
        if (trainSeeds.length < 2) {
            const laneEvidence: ILaneEvidence = {
                pass: checkpoint.pass,
                lane,
                trainSeedStart: trainStart,
                trainPairs: trainSeeds.length,
                candidates: [],
            };
            if (lane.eligible) checkpoint.laneEvidence.push(laneEvidence);
            else checkpoint.intendedOnlyEvidence.push(laneEvidence);
            checkpoint.laneIndex += 1;
            log(`  insufficient real-pick coverage for ${lane.cohort ?? lane.id}; lane recorded without a winner`);
            save();
            continue;
        }
        let lastProgress = 0;
        const train = await evaluateBatch(
            candidates.map((candidate) => candidate.policy),
            trainSeeds,
            options.workers,
            searchDeadline,
            (completed, total) => {
                if (completed - lastProgress >= Math.max(100, Math.floor(total / 10)) || completed === total) {
                    lastProgress = completed;
                    log(`  train ${completed}/${total}`);
                }
            },
        );
        if (!train.complete) {
            log(`lane=${lane.id} stopped at search deadline; partial batch discarded from selection`);
            save();
            searchComplete = true;
            break;
        }
        const ranked = rankEvidence(candidates, train.pairsByCandidate);
        const laneEvidence: ILaneEvidence = {
            pass: checkpoint.pass,
            lane,
            trainSeedStart: trainStart,
            trainPairs: trainSeeds.length,
            candidates: ranked,
            selectedCandidateId: ranked[0]?.candidateId,
        };
        const selected = candidates.find((candidate) => candidate.policy.id === ranked[0]?.candidateId);
        const control = candidates[0];
        if (selected && !selected.control && Date.now() < searchDeadline) {
            const selectionStart = checkpoint.selectionCursor;
            const collectedSelection = collectSetupSeeds(
                options.seed,
                "selection",
                selectionStart,
                options.selectionPairs,
                lane.cohort,
                undefined,
                lane.family === "tier2" ? "artifact-2" : "final-roster",
            );
            const selectionSeeds = collectedSelection.seeds;
            checkpoint.selectionCursor = collectedSelection.nextCursor;
            save();
            if (selectionSeeds.length < 2) {
                log(`  insufficient independent selection coverage; no adoption`);
            } else {
                const selection = await evaluateBatch(
                    [control.policy, selected.policy],
                    selectionSeeds,
                    options.workers,
                    searchDeadline,
                );
                if (selection.complete) {
                    const incumbentEstimate = pairedSetupEstimate(selection.pairsByCandidate.get(control.policy.id)!);
                    const candidateEstimate = pairedSetupEstimate(selection.pairsByCandidate.get(selected.policy.id)!);
                    const adopted =
                        lane.eligible &&
                        candidateEstimate.candidateRejections === 0 &&
                        candidateEstimate.gainPp > incumbentEstimate.gainPp &&
                        (candidateEstimate.confidence95LowGainPp ?? -Infinity) >=
                            (incumbentEstimate.confidence95LowGainPp ?? -Infinity);
                    laneEvidence.selectionSeedStart = selectionStart;
                    laneEvidence.selection = { candidate: candidateEstimate, incumbent: incumbentEstimate, adopted };
                    if (adopted) {
                        checkpoint.incumbent = cloneNonFightPolicy(selected.policy);
                        checkpoint.incumbent.id = `${options.runId}/pass-${checkpoint.pass}/${lane.id}`;
                        log(
                            `  ADOPT ${selected.policy.id}: ${(candidateEstimate.decisiveWinRate * 100).toFixed(2)}% ` +
                                `vs incumbent panel ${(incumbentEstimate.decisiveWinRate * 100).toFixed(2)}%`,
                        );
                    } else {
                        log(`  no adoption: selected=${selected.policy.id} eligible=${lane.eligible}`);
                    }
                    if (
                        !lane.eligible &&
                        candidateEstimate.candidateRejections === 0 &&
                        candidateEstimate.gainPp > incumbentEstimate.gainPp &&
                        (checkpoint.intendedChampionSelection === undefined ||
                            (candidateEstimate.confidence95LowGainPp ?? -Infinity) >
                                (checkpoint.intendedChampionSelection.confidence95LowGainPp ?? -Infinity))
                    ) {
                        checkpoint.intendedChampion = cloneNonFightPolicy(selected.policy);
                        checkpoint.intendedChampionSelection = candidateEstimate;
                        log(`  legacy pre-fix diagnostic leader=${selected.policy.id} (incumbent unchanged)`);
                    }
                } else {
                    log(`  selection stopped at deadline; no adoption`);
                }
            }
        }
        if (lane.eligible) checkpoint.laneEvidence.push(laneEvidence);
        else checkpoint.intendedOnlyEvidence.push(laneEvidence);
        checkpoint.laneIndex += 1;
        save();
        if (options.smoke && checkpoint.laneIndex >= Math.min(4, lanes.length)) {
            searchComplete = true;
            break;
        }
    }
    if (!searchComplete) {
        searchComplete = Date.now() >= searchDeadline || checkpoint.pass >= options.maxPasses;
    }
    log(
        `search frozen: pass=${checkpoint.pass} lane=${checkpoint.laneIndex} incumbent=${checkpoint.incumbent.id}; ` +
            `starting untouched guard`,
    );
    if (checkpoint.phase === "search") {
        checkpoint.phase = "guard-current";
        save();
    }
    checkpoint.intendedGuardPairs ??= [];
    const guardDeadline = options.smoke ? Math.min(options.deadlineMs, Date.now() + 120_000) : options.deadlineMs;
    const serverMainGuardDeadline =
        !options.smoke && checkpoint.intendedChampion
            ? Date.now() + Math.floor((guardDeadline - Date.now()) * 0.72)
            : guardDeadline;
    while (
        checkpoint.phase === "guard-current" &&
        Date.now() < serverMainGuardDeadline &&
        checkpoint.guardPairs.length < options.guardPairs
    ) {
        const remainingMinimum = Math.max(0, options.guardPairs - checkpoint.guardPairs.length);
        const count = Math.min(options.guardChunkPairs, remainingMinimum);
        if (count <= 0) break;
        const start = checkpoint.guardCursor;
        const seeds = Array.from({ length: count }, (_, index) => setupPanelSeed(options.seed, "guard", start + index));
        checkpoint.guardCursor += seeds.length;
        save(); // burn guard seeds and freeze the candidate before workers can observe an outcome
        const guard = await evaluateBatch([checkpoint.incumbent], seeds, options.workers, serverMainGuardDeadline);
        checkpoint.guardPairs.push(...(guard.pairsByCandidate.get(checkpoint.incumbent.id) ?? []));
        save();
        const estimate = pairedSetupEstimate(checkpoint.guardPairs);
        log(
            `guard pairs=${checkpoint.guardPairs.length} rate=${(estimate.decisiveWinRate * 100).toFixed(2)}% ` +
                `lowGain=${estimate.confidence95LowGainPp?.toFixed(2) ?? "n/a"}pp complete=${guard.complete}`,
        );
        if (!guard.complete) break;
    }
    while (
        checkpoint.phase === "guard-current" &&
        checkpoint.guardPairs.length >= options.guardPairs &&
        checkpoint.guardDiagnosticIndex < SETUP_NAMED_GUARD_TAGS.length &&
        Date.now() < serverMainGuardDeadline
    ) {
        const tag = SETUP_NAMED_GUARD_TAGS[checkpoint.guardDiagnosticIndex];
        const records = checkpoint.diagnosticGuardPairs[tag];
        const needed = options.diagnosticGuardPairs - records.length;
        if (needed <= 0) {
            checkpoint.guardDiagnosticIndex += 1;
            save();
            continue;
        }
        const count = Math.min(options.guardChunkPairs, needed);
        const start = checkpoint.guardCursor;
        const collected = collectSetupSeeds(options.seed, "guard", start, count, undefined, tag);
        checkpoint.guardCursor = collected.nextCursor;
        save(); // skipped and selected guard seeds are both permanently burned
        if (collected.seeds.length === 0) {
            log(
                `diagnostic guard ${tag}: no real-pick seeds found for ${count} requested after ` +
                    `${collected.scanned} scans; fail-closed as insufficient`,
            );
            save();
            break;
        }
        const guard = await evaluateBatch(
            [checkpoint.incumbent],
            collected.seeds,
            options.workers,
            serverMainGuardDeadline,
        );
        records.push(...(guard.pairsByCandidate.get(checkpoint.incumbent.id) ?? []));
        if (records.length >= options.diagnosticGuardPairs) checkpoint.guardDiagnosticIndex += 1;
        save();
        const estimate = pairedSetupEstimate(records, tag);
        log(
            `diagnostic guard ${tag}: pairs=${records.length} games=${estimate.games} ` +
                `rate=${(estimate.decisiveWinRate * 100).toFixed(2)}% ` +
                `lowGain=${estimate.confidence95LowGainPp?.toFixed(2) ?? "n/a"}pp complete=${guard.complete}`,
        );
        if (!guard.complete) break;
    }
    const primaryGuardSamplesComplete =
        checkpoint.guardPairs.length >= options.guardPairs &&
        SETUP_NAMED_GUARD_TAGS.every(
            (tag) => checkpoint.diagnosticGuardPairs[tag].length >= options.diagnosticGuardPairs,
        );
    const symmetryControlTarget = options.smoke ? 1 : CONTROL_SYMMETRY_PAIRS;
    while (
        checkpoint.phase === "guard-current" &&
        primaryGuardSamplesComplete &&
        checkpoint.symmetryControlPairs.length < symmetryControlTarget &&
        Date.now() < serverMainGuardDeadline
    ) {
        const count = symmetryControlTarget - checkpoint.symmetryControlPairs.length;
        const start = checkpoint.guardCursor;
        const seeds = Array.from({ length: count }, (_, index) => setupPanelSeed(options.seed, "guard", start + index));
        checkpoint.guardCursor += seeds.length;
        save();
        const controlPolicy = shippedNonFightPolicy("shipped-symmetry-control");
        const control = await evaluateBatch([controlPolicy], seeds, options.workers, serverMainGuardDeadline);
        checkpoint.symmetryControlPairs.push(...(control.pairsByCandidate.get(controlPolicy.id) ?? []));
        save();
        const estimate = pairedSetupEstimate(checkpoint.symmetryControlPairs);
        log(
            `symmetry control pairs=${checkpoint.symmetryControlPairs.length} ` +
                `wins=${estimate.wins} losses=${estimate.losses} draws=${estimate.draws} ` +
                `rate=${(estimate.decisiveWinRate * 100).toFixed(2)}% complete=${control.complete}`,
        );
        if (!control.complete) break;
    }
    const currentGuardSamplesComplete =
        primaryGuardSamplesComplete && checkpoint.symmetryControlPairs.length >= symmetryControlTarget;
    if (
        checkpoint.phase === "guard-current" &&
        currentGuardSamplesComplete &&
        !checkpoint.replay &&
        Date.now() < serverMainGuardDeadline
    ) {
        const samplePairs = Math.min(options.smoke ? 1 : 4, checkpoint.guardPairs.length);
        const originals = [...checkpoint.guardPairs]
            .sort((left, right) => left.seed - right.seed)
            .slice(0, samplePairs);
        const seeds = originals.map((pair) => pair.seed);
        const replay = await evaluateBatch(
            [checkpoint.incumbent],
            seeds,
            Math.min(options.workers, samplePairs),
            serverMainGuardDeadline,
        );
        if (replay.complete) {
            const replayed = replay.pairsByCandidate.get(checkpoint.incumbent.id) ?? [];
            const originalJson = replayJson(originals);
            const repeatedJson = replayJson(replayed);
            checkpoint.replay = {
                samplePairs,
                seeds: [...seeds].sort((left, right) => left - right),
                serialization: "JSON.stringify pairs sorted by uint32 seed",
                originalSha256: sha256(originalJson),
                replaySha256: sha256(repeatedJson),
                byteIdentical: originalJson === repeatedJson,
                completedAt: new Date().toISOString(),
            };
            save();
            log(
                `deterministic replay pairs=${samplePairs} byteIdentical=${checkpoint.replay.byteIdentical} ` +
                    `sha256=${checkpoint.replay.replaySha256}`,
            );
        } else {
            log("deterministic replay did not finish before the server-main guard deadline");
        }
    }
    if (checkpoint.phase === "guard-current" && currentGuardSamplesComplete && checkpoint.replay) {
        checkpoint.phase = checkpoint.intendedChampion ? "guard-intended" : "complete";
        save();
    }
    if (
        checkpoint.phase === "guard-intended" &&
        checkpoint.intendedChampion &&
        checkpoint.guardPairs.length >= options.guardPairs &&
        Date.now() < guardDeadline
    ) {
        log(`starting separate legacy pre-fix diagnostic guard for ${checkpoint.intendedChampion.id}`);
        while (
            checkpoint.phase === "guard-intended" &&
            Date.now() < guardDeadline &&
            checkpoint.intendedGuardPairs.length < options.guardPairs
        ) {
            const remainingMinimum = Math.max(0, options.guardPairs - checkpoint.intendedGuardPairs.length);
            const count = Math.min(options.guardChunkPairs, remainingMinimum);
            if (count <= 0) break;
            const start = checkpoint.guardCursor;
            const seeds = Array.from({ length: count }, (_, index) =>
                setupPanelSeed(options.seed, "guard", start + index),
            );
            checkpoint.guardCursor += seeds.length;
            save();
            const guard = await evaluateBatch([checkpoint.intendedChampion], seeds, options.workers, guardDeadline);
            checkpoint.intendedGuardPairs.push(...(guard.pairsByCandidate.get(checkpoint.intendedChampion.id) ?? []));
            save();
            const estimate = pairedSetupEstimate(checkpoint.intendedGuardPairs);
            log(
                `intended guard pairs=${checkpoint.intendedGuardPairs.length} ` +
                    `rate=${(estimate.decisiveWinRate * 100).toFixed(2)}% ` +
                    `lowGain=${estimate.confidence95LowGainPp?.toFixed(2) ?? "n/a"}pp complete=${guard.complete}`,
            );
            if (!guard.complete) break;
        }
    }
    if (checkpoint.phase === "guard-intended" && checkpoint.intendedGuardPairs.length >= options.guardPairs) {
        checkpoint.phase = "complete";
    }
    checkpoint.status = checkpoint.phase === "complete" ? "complete" : "running";
    if (checkpoint.phase === "complete") checkpoint.completedAt ??= new Date().toISOString();
    assertCheckpointGuardSeedIntegrity(checkpoint);
    save();
    const report = reportForCheckpoint(checkpoint, checkpoint.completedAt ?? new Date().toISOString());
    atomicJson(finalPath, report);
    log(`report written: ${finalPath} phase=${checkpoint.phase}`);
    if (checkpoint.phase !== "complete") {
        log("campaign ended before all guard phases completed; exiting 2 so a supervisor can resume it");
        process.exitCode = 2;
    }
}

if (!isMainThread && parentPort && (workerData as { v07SetupOvernightWorker?: boolean })?.v07SetupOvernightWorker) {
    configureResearchEnvironment();
    const port = parentPort;
    port.on("message", (message: { type: "job"; job: ISetupEvaluationJob } | { type: "stop" }) => {
        if (message.type === "stop") {
            port.close();
            return;
        }
        try {
            port.postMessage({
                type: "result",
                result: {
                    candidateId: message.job.candidate.id,
                    pair: evaluateSetupPair(message.job.candidate, message.job.seed),
                },
            } satisfies SetupWorkerReply);
        } catch (error) {
            port.postMessage({
                type: "error",
                error: error instanceof Error ? (error.stack ?? error.message) : String(error),
            } satisfies SetupWorkerReply);
        }
    });
    port.postMessage({ type: "ready" } satisfies SetupWorkerReply);
}

if (isMainThread && (import.meta as unknown as { main?: boolean }).main) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
