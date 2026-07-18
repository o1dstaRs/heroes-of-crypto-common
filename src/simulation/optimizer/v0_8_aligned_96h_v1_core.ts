/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 * Strict v0.8 identity wrapper around the audited aligned-v2 statistical core.
 * The cell geometry and statistical policy are intentionally unchanged.
 */

import {
    V07_ALIGNED_96H_V2_CELLS,
    V07_ALIGNED_96H_V2_SEATS,
    V07_ALIGNED_V2_FINAL_HYPOTHESES,
    V07_ALIGNED_V2_FINAL_POLICY,
    V07_ALIGNED_V2_OPERATIONAL_POLICY,
    V07_ALIGNED_V2_PROMOTION_POLICY,
    aggregateV07AlignedV2,
    assessV07AlignedV2Final,
    assessV07AlignedV2Promotion,
    evaluateV07AlignedV2OperationalEligibility,
    pairedV07AlignedV2DecisiveGain,
    wilsonV07AlignedV2,
    type IV07AlignedV2Aggregate,
    type IV07AlignedV2AggregateOptions,
    type IV07AlignedV2ConfirmPair,
    type IV07AlignedV2FinalPolicy,
    type IV07AlignedV2GameObservation,
    type IV07AlignedV2OperationalPolicy,
    type IV07AlignedV2OperationalVerdict,
    type IV07AlignedV2PairedEstimate,
    type IV07AlignedV2PromotionPolicy,
    type IV07AlignedV2PromotionVerdict,
    type IV07AlignedV2ResearchTerminal,
} from "./v0_7_aligned_96h_v2_core";
import {
    V08_ALIGNED_96H_V1_VERSION_PROFILE,
    assertAligned96hVersionProfile,
    cloneAligned96hVersionProfile,
} from "./aligned_96h_version_profile";

export const V08_ALIGNED_96H_V1_CELLS = Object.freeze(
    V07_ALIGNED_96H_V2_CELLS.map((cell) => Object.freeze({ ...cell })),
) as unknown as typeof V07_ALIGNED_96H_V2_CELLS;
export const V08_ALIGNED_96H_V1_SEATS = Object.freeze([
    ...V07_ALIGNED_96H_V2_SEATS,
]) as unknown as typeof V07_ALIGNED_96H_V2_SEATS;

export type V08AlignedV1CellId = (typeof V08_ALIGNED_96H_V1_CELLS)[number]["id"];
export type V08AlignedV1Cohort = (typeof V08_ALIGNED_96H_V1_CELLS)[number]["cohort"];
export type V08AlignedV1CandidateSeat = (typeof V08_ALIGNED_96H_V1_SEATS)[number];
export type V08AlignedV1Outcome = "candidate_win" | "opponent_win" | "draw";

export type IV08AlignedV1GameObservation = IV07AlignedV2GameObservation;
export type IV08AlignedV1Aggregate = IV07AlignedV2Aggregate;
export type IV08AlignedV1AggregateOptions = IV07AlignedV2AggregateOptions;
export type IV08AlignedV1ConfirmPair = IV07AlignedV2ConfirmPair;
export type IV08AlignedV1PairedEstimate = IV07AlignedV2PairedEstimate;
export type IV08AlignedV1OperationalPolicy = IV07AlignedV2OperationalPolicy;
export type IV08AlignedV1OperationalVerdict = IV07AlignedV2OperationalVerdict;
export type IV08AlignedV1PromotionPolicy = IV07AlignedV2PromotionPolicy;
export type IV08AlignedV1PromotionVerdict = IV07AlignedV2PromotionVerdict;
export type IV08AlignedV1FinalPolicy = IV07AlignedV2FinalPolicy;

export const V08_ALIGNED_V1_OPERATIONAL_POLICY = V07_ALIGNED_V2_OPERATIONAL_POLICY;
export const V08_ALIGNED_V1_PROMOTION_POLICY = V07_ALIGNED_V2_PROMOTION_POLICY;
export const V08_ALIGNED_V1_FINAL_POLICY = V07_ALIGNED_V2_FINAL_POLICY;
export const V08_ALIGNED_V1_FINAL_HYPOTHESES = V07_ALIGNED_V2_FINAL_HYPOTHESES;

export const V08_ALIGNED_V1_PRODUCTION_CANDIDATE_COUNT = 48 as const;
export const V08_ALIGNED_V1_TRAIN_SCENARIOS_PER_CELL = 256 as const;
export const V08_ALIGNED_V1_CONFIRM_SCENARIOS_PER_CELL_SEAT = 1000 as const;
export const V08_ALIGNED_V1_FINAL_GAMES_PER_CELL_SEAT = 2000 as const;
export const V08_ALIGNED_V1_WORKERS = 40 as const;

export const V08_ALIGNED_V1_GAME_BUDGET = Object.freeze({
    train:
        V08_ALIGNED_V1_PRODUCTION_CANDIDATE_COUNT *
        V08_ALIGNED_V1_TRAIN_SCENARIOS_PER_CELL *
        V08_ALIGNED_96H_V1_CELLS.length *
        V08_ALIGNED_96H_V1_SEATS.length,
    confirm:
        2 *
        V08_ALIGNED_V1_CONFIRM_SCENARIOS_PER_CELL_SEAT *
        V08_ALIGNED_96H_V1_CELLS.length *
        V08_ALIGNED_96H_V1_SEATS.length,
    final: V08_ALIGNED_V1_FINAL_GAMES_PER_CELL_SEAT * V08_ALIGNED_96H_V1_CELLS.length * V08_ALIGNED_96H_V1_SEATS.length,
    total: 390_912,
});

if (
    V08_ALIGNED_96H_V1_CELLS.length !== 12 ||
    V08_ALIGNED_96H_V1_SEATS.length !== 2 ||
    V08_ALIGNED_96H_V1_CELLS.length * V08_ALIGNED_96H_V1_SEATS.length !== V08_ALIGNED_V1_FINAL_HYPOTHESES ||
    V08_ALIGNED_V1_GAME_BUDGET.train !== 294_912 ||
    V08_ALIGNED_V1_GAME_BUDGET.confirm !== 48_000 ||
    V08_ALIGNED_V1_GAME_BUDGET.final !== 48_000 ||
    V08_ALIGNED_V1_GAME_BUDGET.train + V08_ALIGNED_V1_GAME_BUDGET.confirm + V08_ALIGNED_V1_GAME_BUDGET.final !==
        V08_ALIGNED_V1_GAME_BUDGET.total
) {
    throw new Error("v0.8 aligned v1 geometry or production game budget drifted");
}

export const aggregateV08AlignedV1 = aggregateV07AlignedV2;
export const evaluateV08AlignedV1OperationalEligibility = evaluateV07AlignedV2OperationalEligibility;
export const pairedV08AlignedV1DecisiveGain = pairedV07AlignedV2DecisiveGain;
export const assessV08AlignedV1Promotion = assessV07AlignedV2Promotion;
export const wilsonV08AlignedV1 = wilsonV07AlignedV2;

export interface IV08AlignedV1ResearchTerminal extends Omit<IV07AlignedV2ResearchTerminal, "candidate" | "opponent"> {
    artifactKind: "v0_8_aligned_96h_v1_research_terminal";
    versionProfile: typeof V08_ALIGNED_96H_V1_VERSION_PROFILE;
    candidate: "v0.8s";
    opponent: "v0.7";
}

export function assessV08AlignedV1Final(
    observations: readonly IV08AlignedV1GameObservation[],
    policy: Readonly<IV08AlignedV1FinalPolicy> = V08_ALIGNED_V1_FINAL_POLICY,
): IV08AlignedV1ResearchTerminal {
    const terminal = assessV07AlignedV2Final(observations, policy);
    return {
        ...terminal,
        artifactKind: "v0_8_aligned_96h_v1_research_terminal",
        versionProfile: cloneAligned96hVersionProfile(V08_ALIGNED_96H_V1_VERSION_PROFILE),
        candidate: "v0.8s",
        opponent: "v0.7",
    };
}

export interface IV08AlignedV1DryRunConfig {
    schemaVersion: 1;
    artifactKind: "v0_8_aligned_96h_v1_dry_run";
    status: "research_only_no_bake";
    versionProfile: typeof V08_ALIGNED_96H_V1_VERSION_PROFILE;
    cells: V08AlignedV1CellId[];
    seats: V08AlignedV1CandidateSeat[];
    compute: {
        totalHours: 96;
        finalReserveHours: 36;
        hostLogicalCpus: 48;
        workers: 40;
        reservedLogicalCpus: 4;
        evaluationParallelism: 10;
        workersPerTrial: 4;
    };
    panels: {
        trainScenariosPerCell: 256;
        confirmScenariosPerCellSeat: 1000;
        finalGamesPerCellSeat: 2000;
    };
    candidateCount: 48;
    objective: "equal_cell_equal_seat_max_min";
    finalHypotheses: 24;
    automaticBake: false;
    automaticDeploy: false;
}

export function defaultV08AlignedV1DryRunConfig(): IV08AlignedV1DryRunConfig {
    return {
        schemaVersion: 1,
        artifactKind: "v0_8_aligned_96h_v1_dry_run",
        status: "research_only_no_bake",
        versionProfile: cloneAligned96hVersionProfile(V08_ALIGNED_96H_V1_VERSION_PROFILE),
        cells: V08_ALIGNED_96H_V1_CELLS.map((cell) => cell.id),
        seats: [...V08_ALIGNED_96H_V1_SEATS],
        compute: {
            totalHours: 96,
            finalReserveHours: 36,
            hostLogicalCpus: 48,
            workers: V08_ALIGNED_V1_WORKERS,
            reservedLogicalCpus: 4,
            evaluationParallelism: 10,
            workersPerTrial: 4,
        },
        panels: {
            trainScenariosPerCell: V08_ALIGNED_V1_TRAIN_SCENARIOS_PER_CELL,
            confirmScenariosPerCellSeat: V08_ALIGNED_V1_CONFIRM_SCENARIOS_PER_CELL_SEAT,
            finalGamesPerCellSeat: V08_ALIGNED_V1_FINAL_GAMES_PER_CELL_SEAT,
        },
        candidateCount: V08_ALIGNED_V1_PRODUCTION_CANDIDATE_COUNT,
        objective: "equal_cell_equal_seat_max_min",
        finalHypotheses: V08_ALIGNED_V1_FINAL_HYPOTHESES,
        automaticBake: false,
        automaticDeploy: false,
    };
}

export function validateV08AlignedV1DryRunConfig(value: unknown): IV08AlignedV1DryRunConfig {
    const expected = defaultV08AlignedV1DryRunConfig();
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("v0.8 aligned v1 dry-run config must be an object");
    }
    const config = value as Record<string, unknown>;
    assertAligned96hVersionProfile(config.versionProfile, V08_ALIGNED_96H_V1_VERSION_PROFILE);
    if (JSON.stringify(config) !== JSON.stringify(expected)) {
        throw new Error("v0.8 aligned v1 dry-run config must match the exact production geometry");
    }
    return structuredClone(expected);
}
