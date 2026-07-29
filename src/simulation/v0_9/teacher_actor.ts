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

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import type { IAIStrategy } from "../../ai";
import { createV09OfflineResearchStrategy } from "../../ai/versions/v0_9";
import { V08_A13_VALUE_LEAF, buildV08A13SearchEnvironment } from "../../ai/versions/v0_8_a13_profile";
import type { IV09ModelArtifact } from "../../ai/versions/v0_9_model";
import { PBTypes } from "../../generated/protobuf/v1/types";
import { FightStateManager } from "../../fights/fight_state_manager";
import { DEFAULT_AMOUNT_BY_LEVEL, creaturesByLevel, resolveStackAmount, type IArmyUnitSpec } from "../army";
import { AI_META_COHORTS, prepareMetaPair, type AiMetaCohort, type IAiMetaArmy } from "../ai_meta_cohorts_core";
import { runMatch, type IMatchConfig, type IMatchResult } from "../battle_engine";
import { buildMirrorRoster, type MirrorCohortName } from "../measure_mirror_cohorts";
import {
    validateV09CampaignManifest,
    validateV09SeedLedger,
    type IV09CampaignManifest,
    type IV09SeedLedger,
} from "./campaign";
import { verifyV09ResearchArtifact } from "./parity";
import {
    V09_DAGGER_TRAJECTORY_PATTERNS,
    V09_TEACHER_COHORTS as V09_PROTOCOL_TEACHER_COHORTS,
    V09_TEACHER_MAP_NAMES,
    type V09CorpusPhase,
    type V09CorpusSplit,
    type V09Map,
} from "./protocol";
import { V09GameRecorder, validateV09GameShard } from "./recorder";
import { v09TeacherWorkerIndices } from "./teacher_schedule";
import { createV09TeacherObserver } from "./teacher_observer";

export const V09_TEACHER_COHORTS = V09_PROTOCOL_TEACHER_COHORTS;
export type V09TeacherCohort = (typeof V09_TEACHER_COHORTS)[number];

const TRAINING_PURPOSES = [
    "wide_teacher_train",
    "wide_teacher_validation",
    "dagger_1_train",
    "dagger_1_validation",
    "dagger_2_train",
    "dagger_2_validation",
] as const;

type TrainingPurpose = (typeof TRAINING_PURPOSES)[number];

const V09_TEACHER_MAP_VALUES = {
    normal: PBTypes.GridVals.NORMAL,
    water: PBTypes.GridVals.WATER_CENTER,
    lava: PBTypes.GridVals.LAVA_CENTER,
    block: PBTypes.GridVals.BLOCK_CENTER,
} as const satisfies Record<V09Map, number>;

export const V09_TEACHER_MAPS: ReadonlyArray<{ name: V09Map; value: number }> = V09_TEACHER_MAP_NAMES.map((name) => ({
    name,
    value: V09_TEACHER_MAP_VALUES[name],
}));

export interface IV09TeacherActorArgs {
    campaignDirectory: string;
    purpose: TrainingPurpose;
    workerIndex: number;
    workers: number;
    limit: number | null;
    studentArtifact: string | null;
    /** Test-only bounded actor pass; production campaign actors leave this false. */
    smoke?: boolean;
}

export function v09TeacherRejectedActionsMessage(
    gameId: string,
    result: Pick<IMatchResult, "rejectedGreen" | "rejectedRed" | "rejectedDetails">,
): string | null {
    const rejectedGreen = result.rejectedGreen ?? 0;
    const rejectedRed = result.rejectedRed ?? 0;
    if (rejectedGreen === 0 && rejectedRed === 0) return null;
    return (
        `teacher game ${gameId} emitted rejected actions: ` +
        `rejectedGreen=${rejectedGreen}, rejectedRed=${rejectedRed}, ` +
        `rejectedDetails=${JSON.stringify(result.rejectedDetails ?? [])}`
    );
}

function atomicJson(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, path);
}

function phaseForPurpose(purpose: TrainingPurpose): V09CorpusPhase {
    if (purpose.startsWith("wide_teacher")) return "wide_teacher";
    if (purpose.startsWith("dagger_1")) return "dagger_1";
    return "dagger_2";
}

const splitForPurpose = (purpose: TrainingPurpose): V09CorpusSplit =>
    purpose.endsWith("_validation") ? "validation" : "train";

function configureTeacherSearch(phase: V09CorpusPhase, smoke: boolean): () => void {
    const baseEnvironment = buildV08A13SearchEnvironment();
    const keys = new Set([
        ...Object.keys(baseEnvironment),
        "V07_SEARCH",
        "SEARCH_VERSIONS",
        "SEARCH_GATE",
        "SEARCH_HORIZON",
        "SEARCH_ROLLOUTS",
        "SEARCH_INCLUDE_MOVES",
        "SEARCH_ACTIVE_CHALLENGERS",
        "SEARCH_MAX_MOVES",
        "SEARCH_MAX_MELEE",
        "SEARCH_MAX_SHOTS",
        "SEARCH_MAX_THROWS",
        "SEARCH_MAX_MOVE_SHOTS",
        "SEARCH_MOVE_SHOT_VERSIONS",
        "SEARCH_OBSERVE_ONLY",
        "V08_AGGRESSIVE",
        "V07_VALUE_WEIGHTS_V2",
        "SIM_NO_ACTIONS",
        "SEARCH_SHORTLIST",
        "SEARCH_DECISION_DEADLINE_MS",
        "SEARCH_CIRCUIT_BREAKER_MS",
        "SEARCH_VALIDATION_ROLLOUTS",
        "SEARCH_IL_DATASET",
    ]);
    const previous = new Map([...keys].map((key) => [key, process.env[key]]));
    for (const [key, value] of Object.entries(baseEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    process.env.V07_SEARCH = "1";
    process.env.SEARCH_VERSIONS = "v0.8";
    process.env.SEARCH_GATE = "0";
    process.env.SEARCH_HORIZON = smoke ? "1" : phase === "dagger_2" ? "24" : "16";
    process.env.SEARCH_ROLLOUTS = smoke ? "1" : phase === "dagger_2" ? "16" : "8";
    process.env.SEARCH_INCLUDE_MOVES = "1";
    // Runtime v0.9 sees tactical wait/defend classes. The teacher must score them so the student learns when
    // they lose; hiding them here would create an action-space mismatch.
    delete process.env.SEARCH_ACTIVE_CHALLENGERS;
    process.env.SEARCH_MAX_MOVES = smoke ? "2" : "8";
    process.env.SEARCH_MAX_MELEE = smoke ? "2" : "16";
    process.env.SEARCH_MAX_SHOTS = smoke ? "2" : "16";
    process.env.SEARCH_MAX_THROWS = smoke ? "2" : "8";
    process.env.SEARCH_MAX_MOVE_SHOTS = "2";
    process.env.SEARCH_MOVE_SHOT_VERSIONS = "v0.8";
    process.env.SEARCH_OBSERVE_ONLY = "1";
    process.env.V08_AGGRESSIVE = "1";
    process.env.V07_VALUE_WEIGHTS_V2 = JSON.stringify(V08_A13_VALUE_LEAF);
    process.env.SIM_NO_ACTIONS = "1";
    delete process.env.SEARCH_SHORTLIST;
    delete process.env.SEARCH_DECISION_DEADLINE_MS;
    delete process.env.SEARCH_CIRCUIT_BREAKER_MS;
    delete process.env.SEARCH_VALIDATION_ROLLOUTS;
    delete process.env.SEARCH_IL_DATASET;
    return () => {
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    };
}

function newLevel4Roster(): IArmyUnitSpec[] {
    const names = ["Champion", "Arachna Queen", "Abomination", "Frenzied Boar"];
    const support = [
        { level: 2, name: "Pikeman" },
        { level: 2, name: "Elf" },
    ];
    return [...names.map((name) => ({ level: 4, name })), ...support].map(({ level, name }) => {
        const entry = creaturesByLevel(level).find((candidate) => candidate.creatureName === name);
        if (!entry) throw new Error(`v0.9 level-4 panel cannot find ${name}`);
        return {
            faction: entry.faction,
            creatureName: entry.creatureName,
            level: entry.level,
            size: entry.size,
            amount: resolveStackAmount(entry.creatureName, entry.level, DEFAULT_AMOUNT_BY_LEVEL, "expBudget"),
        };
    });
}

const fixedMirrorName = (cohort: V09TeacherCohort): MirrorCohortName => {
    switch (cohort) {
        case "mirror-anchor":
            return "anchor";
        case "mirror-melee":
            return "melee_coevo";
        case "pure-ranged":
            return "pure_ranged";
        case "mixed-cyclops-tsar":
            return "mixed_cyclops_tsar";
        default:
            throw new Error(`${cohort} is not a fixed mirror cohort`);
    }
};

function setupForArmies(
    green: IAiMetaArmy,
    red: IAiMetaArmy,
): Pick<
    IMatchConfig,
    | "greenPerk"
    | "redPerk"
    | "greenAugments"
    | "redAugments"
    | "greenArtifactT1"
    | "redArtifactT1"
    | "greenArtifactT2"
    | "redArtifactT2"
    | "greenSynergies"
    | "redSynergies"
    | "placementAugmentTiming"
> {
    return {
        greenPerk: green.perk,
        redPerk: red.perk,
        greenAugments: green.augment.augments,
        redAugments: red.augment.augments,
        greenArtifactT1: green.artifactT1.id,
        redArtifactT1: red.artifactT1.id,
        greenArtifactT2: green.artifactT2.id,
        redArtifactT2: red.artifactT2.id,
        greenSynergies: green.synergies,
        redSynergies: red.synergies,
        placementAugmentTiming: "setup-before-placement",
    };
}

export function buildV09TeacherMatchBase(
    cohort: V09TeacherCohort,
    seed: number,
    index: number,
    map: number,
): Pick<IMatchConfig, "roster" | "redRoster" | "gridType"> & Partial<IMatchConfig> {
    if ((AI_META_COHORTS as readonly string[]).includes(cohort)) {
        const prepared = prepareMetaPair({ cohort: cohort as AiMetaCohort, games: 2, baseSeed: seed }, 0);
        const swap = index % 2 === 1;
        const green = swap ? prepared.armyB : prepared.armyA;
        const red = swap ? prepared.armyA : prepared.armyB;
        return {
            roster: green.roster,
            redRoster: red.roster,
            gridType: map,
            ...setupForArmies(green, red),
        };
    }
    const roster =
        cohort === "new-level4" ? newLevel4Roster() : buildMirrorRoster(fixedMirrorName(cohort), seed, "expBudget");
    return { roster, redRoster: roster.map((unit) => ({ ...unit })), gridType: map };
}

interface IV09ResearchPolicy {
    artifact: IV09ModelArtifact;
    strategy: IAIStrategy;
    modelSha256: string;
}

function researchStrategy(path: string | null): IV09ResearchPolicy | undefined {
    if (!path) return undefined;
    const artifact = JSON.parse(readFileSync(path, "utf8")) as IV09ModelArtifact;
    verifyV09ResearchArtifact(artifact);
    const research = createV09OfflineResearchStrategy(artifact);
    // SearchDriver's v0.8-only action-space/safety controls remain the teacher wrapper. The delegated policy is
    // still the exact research v0.9 model and its own telemetry/version never enters production.
    return {
        artifact,
        modelSha256: artifact.modelSha256!,
        strategy: {
            version: "v0.8",
            placeArmy: (units, context) => research.placeArmy(units, context),
            decideTurn: (unit, context) => research.decideTurn(unit, context),
        },
    };
}

type V09TrajectoryPattern = "anchor-mirror" | "student-green" | "student-red" | "student-self-a" | "student-self-b";

function trajectoryStrategies(
    index: number,
    student: IV09ResearchPolicy | undefined,
): {
    pattern: V09TrajectoryPattern;
    greenVersion: string;
    redVersion: string;
    overrides: Pick<IMatchConfig, "greenStrategyOverride" | "redStrategyOverride">;
    v08A13TrajectoryTeams: readonly number[];
    studentTeams: readonly number[];
} {
    if (!student) {
        return {
            pattern: "anchor-mirror",
            greenVersion: "v0.8+a13",
            redVersion: "v0.8+a13",
            overrides: {},
            v08A13TrajectoryTeams: [PBTypes.TeamVals.LOWER, PBTypes.TeamVals.UPPER],
            studentTeams: [],
        };
    }
    const version = `v0.9-research:${student.modelSha256}`;
    const pattern = V09_DAGGER_TRAJECTORY_PATTERNS[index % V09_DAGGER_TRAJECTORY_PATTERNS.length]!;
    switch (pattern) {
        case "student-green":
            return {
                pattern,
                greenVersion: version,
                redVersion: "v0.8+a13",
                overrides: { greenStrategyOverride: student.strategy },
                v08A13TrajectoryTeams: [PBTypes.TeamVals.UPPER],
                studentTeams: [PBTypes.TeamVals.LOWER],
            };
        case "student-red":
            return {
                pattern,
                greenVersion: "v0.8+a13",
                redVersion: version,
                overrides: { redStrategyOverride: student.strategy },
                v08A13TrajectoryTeams: [PBTypes.TeamVals.LOWER],
                studentTeams: [PBTypes.TeamVals.UPPER],
            };
        case "student-self-a":
            return {
                pattern,
                greenVersion: version,
                redVersion: version,
                overrides: { greenStrategyOverride: student.strategy, redStrategyOverride: student.strategy },
                v08A13TrajectoryTeams: [],
                studentTeams: [PBTypes.TeamVals.LOWER, PBTypes.TeamVals.UPPER],
            };
        case "student-self-b":
            return {
                pattern,
                greenVersion: version,
                redVersion: version,
                overrides: { greenStrategyOverride: student.strategy, redStrategyOverride: student.strategy },
                v08A13TrajectoryTeams: [],
                studentTeams: [PBTypes.TeamVals.LOWER, PBTypes.TeamVals.UPPER],
            };
    }
}

export function runV09TeacherActor(args: IV09TeacherActorArgs): {
    completed: number;
    resumed: number;
    decisions: number;
} {
    const manifest = JSON.parse(
        readFileSync(resolve(args.campaignDirectory, "manifest.json"), "utf8"),
    ) as IV09CampaignManifest;
    const ledger = JSON.parse(
        readFileSync(resolve(args.campaignDirectory, "seed-ledger.json"), "utf8"),
    ) as IV09SeedLedger;
    validateV09CampaignManifest(manifest, args.campaignDirectory);
    validateV09SeedLedger(ledger);
    if (
        manifest.runFingerprint !== ledger.runFingerprint ||
        manifest.seedLedgerSha256 !== ledger.ledgerSha256 ||
        args.workerIndex < 0 ||
        args.workerIndex >= args.workers
    ) {
        throw new Error("v0.9 teacher actor received incompatible campaign/worker identity");
    }
    const stream = ledger.streams.find((candidate) => candidate.purpose === args.purpose);
    if (!stream) throw new Error(`seed ledger does not contain ${args.purpose}`);
    const phase = phaseForPurpose(args.purpose);
    if (phase !== "wide_teacher" && !args.studentArtifact) {
        throw new Error(`${phase} requires --student-artifact so trajectories come from the current student`);
    }
    const student = researchStrategy(args.studentArtifact);
    if (
        student &&
        (student.artifact.source.trainingRunId !== manifest.runFingerprint ||
            student.artifact.source.commonCommit !== manifest.identity.sourceCommit ||
            student.artifact.source.rulesSha256 !== manifest.identity.rulesFingerprint ||
            student.artifact.source.rosterSha256 !== manifest.identity.rosterFingerprint)
    ) {
        throw new Error("v0.9 DAgger student provenance does not match the immutable campaign identity");
    }
    const restoreSearchEnvironment = configureTeacherSearch(phase, args.smoke === true);
    try {
        FightStateManager.getInstance();
        let completed = 0;
        let resumed = 0;
        let decisions = 0;
        let attempted = 0;
        for (const index of v09TeacherWorkerIndices(stream.seeds.length, args.workerIndex, args.workers)) {
            if (args.limit !== null && attempted >= args.limit) break;
            attempted += 1;
            const seed = stream.seeds[index]!;
            const cohort = V09_TEACHER_COHORTS[index % V09_TEACHER_COHORTS.length]!;
            const map = V09_TEACHER_MAPS[Math.floor(index / V09_TEACHER_COHORTS.length) % V09_TEACHER_MAPS.length]!;
            const trajectory = trajectoryStrategies(index, student);
            const studentBinding = student?.modelSha256 ?? "v0.8-a13";
            const gameId = `${args.purpose}:${index}:${seed}:${studentBinding}:${trajectory.pattern}`;
            const shard = resolve(
                args.campaignDirectory,
                args.smoke ? "il-smoke" : "il",
                args.purpose,
                studentBinding,
                `${String(index).padStart(6, "0")}-${seed}.jsonl`,
            );
            if (existsSync(shard)) {
                const footer = validateV09GameShard(shard);
                if (
                    footer.gameId !== gameId ||
                    footer.seed !== seed ||
                    footer.runFingerprint !== manifest.runFingerprint ||
                    footer.sourceCommit !== manifest.identity.sourceCommit ||
                    footer.rulesFingerprint !== manifest.identity.rulesFingerprint ||
                    footer.anchorFingerprint !== manifest.identity.anchorFingerprint ||
                    footer.phase !== phase ||
                    footer.split !== splitForPurpose(args.purpose) ||
                    footer.cohort !== cohort ||
                    footer.map !== map.name ||
                    footer.greenVersion !== trajectory.greenVersion ||
                    footer.redVersion !== trajectory.redVersion
                ) {
                    throw new Error(`incompatible resumed shard ${shard}`);
                }
                resumed += 1;
                decisions += footer.decisions;
                continue;
            }
            const common = {
                sourceCommit: manifest.identity.sourceCommit,
                rulesFingerprint: manifest.identity.rulesFingerprint,
                anchorFingerprint: manifest.identity.anchorFingerprint,
                phase,
                split: splitForPurpose(args.purpose),
                cohort,
                map: map.name,
                seed,
                gameId,
            };
            const recorder = new V09GameRecorder(
                {
                    runFingerprint: manifest.runFingerprint,
                    sourceCommit: manifest.identity.sourceCommit,
                    rulesFingerprint: manifest.identity.rulesFingerprint,
                    anchorFingerprint: manifest.identity.anchorFingerprint,
                },
                {
                    ...common,
                    greenVersion: trajectory.greenVersion,
                    redVersion: trajectory.redVersion,
                    winner: "draw",
                    endReason: "stuck",
                },
            );
            const observer = createV09TeacherObserver(recorder, common);
            let studentEvaluations = 0;
            let studentActivationFailures = 0;
            const result = runMatch({
                greenVersion: "v0.8",
                redVersion: "v0.8",
                seed,
                maxLaps: args.smoke ? 2 : 60,
                ...buildV09TeacherMatchBase(cohort, seed, index, map.value),
                searchScoredDecisionObserver: observer,
                searchShadowOnly: true,
                searchV08A13TrajectoryTeams: trajectory.v08A13TrajectoryTeams,
                ...(student
                    ? {
                          policyEventObserver: (event): void => {
                              if (event.kind !== "v0.9_decision") return;
                              studentEvaluations += 1;
                              if (
                                  !trajectory.studentTeams.includes(event.team) ||
                                  event.details.artifactStatus !== "trained" ||
                                  event.details.modelId !== student.artifact.modelId ||
                                  event.details.modelSha256 !== student.modelSha256 ||
                                  event.details.circuitBreakerRecommended ||
                                  event.details.selectedCandidateIndex < 0 ||
                                  event.details.selectedCandidateIndex >= event.details.candidateCount ||
                                  event.unitId.length === 0 ||
                                  event.creatureName.length === 0 ||
                                  !Number.isSafeInteger(event.lap) ||
                                  event.lap < 1
                              ) {
                                  studentActivationFailures += 1;
                              }
                          },
                      }
                    : {}),
                ...trajectory.overrides,
            });
            if (student && (studentEvaluations === 0 || studentActivationFailures !== 0)) {
                throw new Error(
                    `teacher game ${gameId} did not execute the offline student model ` +
                        `(evaluations=${studentEvaluations}, activationFailures=${studentActivationFailures})`,
                );
            }
            const rejectedActionsMessage = v09TeacherRejectedActionsMessage(gameId, result);
            if (rejectedActionsMessage) throw new Error(rejectedActionsMessage);
            const footer = recorder.finalize(shard, { winner: result.winner, endReason: result.endReason });
            completed += 1;
            decisions += footer.decisions;
            if ((completed + resumed) % 10 === 0) {
                process.stdout.write(
                    `${JSON.stringify({ worker: args.workerIndex, purpose: args.purpose, completed, resumed, decisions })}\n`,
                );
            }
        }
        const summary = { completed, resumed, decisions };
        atomicJson(
            resolve(
                args.campaignDirectory,
                args.smoke ? "actor-status-smoke" : "actor-status",
                `${args.purpose}.worker-${args.workerIndex}.json`,
            ),
            {
                schema: "hoc.ai.v0_9_teacher_actor_status.v1",
                runFingerprint: manifest.runFingerprint,
                purpose: args.purpose,
                workerIndex: args.workerIndex,
                workers: args.workers,
                smoke: args.smoke === true,
                ...summary,
            },
        );
        return summary;
    } finally {
        restoreSearchEnvironment();
    }
}

function cliArgs(): IV09TeacherActorArgs {
    const { values } = parseArgs({
        args: Bun.argv.slice(2),
        options: {
            campaign: { type: "string" },
            purpose: { type: "string" },
            "worker-index": { type: "string" },
            workers: { type: "string" },
            limit: { type: "string" },
            "student-artifact": { type: "string" },
            smoke: { type: "boolean", default: false },
        },
        strict: true,
    });
    if (!values.campaign || !values.purpose || !values["worker-index"] || !values.workers) {
        throw new Error(
            "usage: bun teacher_actor.ts --campaign <dir> --purpose <stream> --worker-index <n> --workers <n>",
        );
    }
    if (!(TRAINING_PURPOSES as readonly string[]).includes(values.purpose)) {
        throw new Error(`purpose must be one of ${TRAINING_PURPOSES.join(", ")}`);
    }
    const workerIndex = Number(values["worker-index"]);
    const workers = Number(values.workers);
    const limit = values.limit === undefined ? null : Number(values.limit);
    if (
        !Number.isSafeInteger(workerIndex) ||
        !Number.isSafeInteger(workers) ||
        workers < 1 ||
        workerIndex < 0 ||
        workerIndex >= workers ||
        (limit !== null && (!Number.isSafeInteger(limit) || limit < 1))
    ) {
        throw new Error("invalid worker lane or limit");
    }
    return {
        campaignDirectory: resolve(values.campaign),
        purpose: values.purpose as TrainingPurpose,
        workerIndex,
        workers,
        limit,
        studentArtifact: values["student-artifact"] ? resolve(values["student-artifact"]) : null,
        smoke: values.smoke,
    };
}

if (import.meta.main) {
    process.stdout.write(`${JSON.stringify(runV09TeacherActor(cliArgs()))}\n`);
}
