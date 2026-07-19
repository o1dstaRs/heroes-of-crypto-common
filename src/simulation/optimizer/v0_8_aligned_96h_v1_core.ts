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
import { PBTypes } from "../../generated/protobuf/v1/types";

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

export const V08_ALIGNED_V1_GRID_TYPES = Object.freeze([
    PBTypes.GridVals.NORMAL,
    PBTypes.GridVals.WATER_CENTER,
    PBTypes.GridVals.LAVA_CENTER,
    PBTypes.GridVals.BLOCK_CENTER,
] as const);

export type V08AlignedV1GridType = (typeof V08_ALIGNED_V1_GRID_TYPES)[number];

export function gridTypeV08AlignedV1(scenarioOrdinal: number): V08AlignedV1GridType {
    if (!Number.isSafeInteger(scenarioOrdinal) || scenarioOrdinal < 0) {
        throw new RangeError("scenarioOrdinal must be a nonnegative integer");
    }
    return V08_ALIGNED_V1_GRID_TYPES[scenarioOrdinal % V08_ALIGNED_V1_GRID_TYPES.length];
}

export function exactGridCountsV08AlignedV1(scenariosPerCell: number): Record<V08AlignedV1GridType, number> {
    if (!Number.isSafeInteger(scenariosPerCell) || scenariosPerCell < 1) {
        throw new RangeError("scenariosPerCell must be a positive integer");
    }
    if (scenariosPerCell % V08_ALIGNED_V1_GRID_TYPES.length !== 0) {
        throw new Error("v0.8 aligned panel scenariosPerCell must divide equally across all four grid types");
    }
    const perGrid = scenariosPerCell / V08_ALIGNED_V1_GRID_TYPES.length;
    return Object.fromEntries(V08_ALIGNED_V1_GRID_TYPES.map((gridType) => [gridType, perGrid])) as Record<
        V08AlignedV1GridType,
        number
    >;
}

export interface IV08AlignedV1SideExecutionAudit {
    observedTurns: number;
    strategyNoOpTurns: number;
    recoveryTurns: number;
    recoveryAdvanceTurns: number;
    recoveryDefendTurns: number;
    recoveryFailedTurns: number;
    rejectedTurns: number;
    rejectedActions: number;
    explicitWaits: number;
    explicitDefends: number;
    completedMoves: number;
    completedAttacksOrSpells: number;
    completedObstacleAttacks: number;
}

export interface IV08AlignedV1PassiveAlternativeAudit {
    turns: number;
    withLegalAttackOrSpell: number;
    withLegalMove: number;
    withLegalObstacleAttack: number;
}

export interface IV08AlignedV1CandidatePassiveAlternatives {
    explicitWait: IV08AlignedV1PassiveAlternativeAudit;
    explicitDefend: IV08AlignedV1PassiveAlternativeAudit;
    recovery: IV08AlignedV1PassiveAlternativeAudit;
    strategyNoOp: IV08AlignedV1PassiveAlternativeAudit;
}

export interface IV08AlignedV1ExecutionAudit {
    candidate: IV08AlignedV1SideExecutionAudit;
    opponent: IV08AlignedV1SideExecutionAudit;
    candidatePassiveAlternatives: IV08AlignedV1CandidatePassiveAlternatives;
}

export interface IV08AlignedV1GameObservation extends IV07AlignedV2GameObservation {
    scenarioOrdinal: number;
    gridType: V08AlignedV1GridType;
    execution: IV08AlignedV1ExecutionAudit;
}

export interface IV08AlignedV1CellSeatExecutionAudit extends IV08AlignedV1ExecutionAudit {
    cellId: V08AlignedV1CellId;
    candidateSeat: V08AlignedV1CandidateSeat;
}

export interface IV08AlignedV1MapCoverageEntry {
    cellId: V08AlignedV1CellId;
    candidateSeat: V08AlignedV1CandidateSeat;
    counts: Record<V08AlignedV1GridType, number>;
    expectedPerGridType: number | null;
    passed: boolean;
}

export interface IV08AlignedV1Aggregate extends Omit<
    IV07AlignedV2Aggregate,
    "complete" | "completenessErrors" | "integrity"
> {
    complete: boolean;
    completenessErrors: string[];
    mapCoverage: {
        gridTypes: V08AlignedV1GridType[];
        cellSeats: IV08AlignedV1MapCoverageEntry[];
        passed: boolean;
    };
    execution: {
        pooled: IV08AlignedV1ExecutionAudit;
        cellSeats: IV08AlignedV1CellSeatExecutionAudit[];
    };
    integrity: IV07AlignedV2Aggregate["integrity"] & {
        candidateStrategyNoOpTurns: number;
        candidateRecoveryTurns: number;
        candidateRecoveryFailedTurns: number;
        candidateRejectedActions: number;
        mapCoveragePassed: boolean;
        executionPassed: boolean;
    };
}
export interface IV08AlignedV1AggregateOptions extends IV07AlignedV2AggregateOptions {
    /** Synthetic one-row process preflights derive a map but do not claim four-map balance. */
    requireExactGridCoverage?: boolean;
}
export type IV08AlignedV1ConfirmPair = IV07AlignedV2ConfirmPair;
export type IV08AlignedV1PairedEstimate = IV07AlignedV2PairedEstimate;
export type IV08AlignedV1OperationalPolicy = IV07AlignedV2OperationalPolicy;
export type IV08AlignedV1OperationalVerdict = IV07AlignedV2OperationalVerdict;
export type IV08AlignedV1PromotionPolicy = IV07AlignedV2PromotionPolicy;
export interface IV08AlignedV1PromotionVerdict extends Omit<IV07AlignedV2PromotionVerdict, "challenger" | "incumbent"> {
    challenger: IV08AlignedV1Aggregate;
    incumbent: IV08AlignedV1Aggregate;
}
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

export const pairedV08AlignedV1DecisiveGain = pairedV07AlignedV2DecisiveGain;
export const wilsonV08AlignedV1 = wilsonV07AlignedV2;

const SIDE_EXECUTION_KEYS = [
    "observedTurns",
    "strategyNoOpTurns",
    "recoveryTurns",
    "recoveryAdvanceTurns",
    "recoveryDefendTurns",
    "recoveryFailedTurns",
    "rejectedTurns",
    "rejectedActions",
    "explicitWaits",
    "explicitDefends",
    "completedMoves",
    "completedAttacksOrSpells",
    "completedObstacleAttacks",
] as const;

const PASSIVE_ALTERNATIVE_KEYS = [
    "turns",
    "withLegalAttackOrSpell",
    "withLegalMove",
    "withLegalObstacleAttack",
] as const;

function requireV08Count(value: unknown, label: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new RangeError(`${label} must be a nonnegative integer`);
    }
    return value as number;
}

function validateSideExecutionAudit(value: IV08AlignedV1SideExecutionAudit, label: string): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...SIDE_EXECUTION_KEYS].sort())) {
        throw new Error(`${label} fields are not exact`);
    }
    for (const key of SIDE_EXECUTION_KEYS) requireV08Count(value[key], `${label}.${key}`);
    if (
        value.strategyNoOpTurns > value.observedTurns ||
        value.recoveryTurns > value.strategyNoOpTurns ||
        value.recoveryAdvanceTurns > value.recoveryTurns ||
        value.recoveryDefendTurns > value.recoveryTurns ||
        value.recoveryFailedTurns > value.recoveryTurns ||
        value.rejectedTurns > value.observedTurns ||
        value.rejectedActions < value.rejectedTurns ||
        value.explicitWaits > value.observedTurns ||
        value.explicitDefends > value.observedTurns
    ) {
        throw new Error(`${label} counter totals are inconsistent`);
    }
}

function validatePassiveAlternativeAudit(value: IV08AlignedV1PassiveAlternativeAudit, label: string): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...PASSIVE_ALTERNATIVE_KEYS].sort())) {
        throw new Error(`${label} fields are not exact`);
    }
    for (const key of PASSIVE_ALTERNATIVE_KEYS) requireV08Count(value[key], `${label}.${key}`);
    if (
        value.withLegalAttackOrSpell > value.turns ||
        value.withLegalMove > value.turns ||
        value.withLegalObstacleAttack > value.turns
    ) {
        throw new Error(`${label} alternative counts exceed its passive turns`);
    }
}

export function validateV08AlignedV1GameObservation(
    observation: IV08AlignedV1GameObservation,
    label = "v0.8 observation",
): IV08AlignedV1GameObservation {
    if (!Number.isSafeInteger(observation.scenarioOrdinal) || observation.scenarioOrdinal < 0) {
        throw new RangeError(`${label}.scenarioOrdinal must be a nonnegative integer`);
    }
    if (!(V08_ALIGNED_V1_GRID_TYPES as readonly number[]).includes(observation.gridType)) {
        throw new Error(`${label}.gridType is not registered`);
    }
    if (observation.gridType !== gridTypeV08AlignedV1(observation.scenarioOrdinal)) {
        throw new Error(`${label}.gridType does not match its scenarioOrdinal`);
    }
    if (!observation.execution || typeof observation.execution !== "object") {
        throw new Error(`${label}.execution is missing`);
    }
    if (
        JSON.stringify(Object.keys(observation.execution).sort()) !==
        JSON.stringify(["candidate", "candidatePassiveAlternatives", "opponent"].sort())
    ) {
        throw new Error(`${label}.execution fields are not exact`);
    }
    validateSideExecutionAudit(observation.execution.candidate, `${label}.execution.candidate`);
    validateSideExecutionAudit(observation.execution.opponent, `${label}.execution.opponent`);
    const alternatives = observation.execution.candidatePassiveAlternatives;
    if (
        !alternatives ||
        typeof alternatives !== "object" ||
        JSON.stringify(Object.keys(alternatives).sort()) !==
            JSON.stringify(["explicitDefend", "explicitWait", "recovery", "strategyNoOp"].sort())
    ) {
        throw new Error(`${label}.execution.candidatePassiveAlternatives fields are not exact`);
    }
    validatePassiveAlternativeAudit(alternatives.explicitWait, `${label}.candidatePassiveAlternatives.explicitWait`);
    validatePassiveAlternativeAudit(
        alternatives.explicitDefend,
        `${label}.candidatePassiveAlternatives.explicitDefend`,
    );
    validatePassiveAlternativeAudit(alternatives.recovery, `${label}.candidatePassiveAlternatives.recovery`);
    validatePassiveAlternativeAudit(alternatives.strategyNoOp, `${label}.candidatePassiveAlternatives.strategyNoOp`);
    if (
        alternatives.explicitWait.turns !== observation.execution.candidate.explicitWaits ||
        alternatives.explicitDefend.turns !== observation.execution.candidate.explicitDefends ||
        alternatives.recovery.turns !== observation.execution.candidate.recoveryTurns ||
        alternatives.strategyNoOp.turns !== observation.execution.candidate.strategyNoOpTurns
    ) {
        throw new Error(`${label}.execution candidate passive-turn totals are inconsistent`);
    }
    if (observation.execution.candidate.observedTurns + observation.execution.opponent.observedTurns < 1) {
        throw new Error(`${label}.execution did not observe any turns`);
    }
    if (
        observation.candidateRejections !== observation.execution.candidate.rejectedActions ||
        observation.opponentRejections !== observation.execution.opponent.rejectedActions
    ) {
        throw new Error(`${label}.execution rejected-action counts do not match the engine result`);
    }
    return observation;
}

const emptySideExecutionAudit = (): IV08AlignedV1SideExecutionAudit =>
    Object.fromEntries(SIDE_EXECUTION_KEYS.map((key) => [key, 0])) as unknown as IV08AlignedV1SideExecutionAudit;

const emptyPassiveAlternativeAudit = (): IV08AlignedV1PassiveAlternativeAudit => ({
    turns: 0,
    withLegalAttackOrSpell: 0,
    withLegalMove: 0,
    withLegalObstacleAttack: 0,
});

export function emptyV08AlignedV1ExecutionAudit(): IV08AlignedV1ExecutionAudit {
    return {
        candidate: emptySideExecutionAudit(),
        opponent: emptySideExecutionAudit(),
        candidatePassiveAlternatives: {
            explicitWait: emptyPassiveAlternativeAudit(),
            explicitDefend: emptyPassiveAlternativeAudit(),
            recovery: emptyPassiveAlternativeAudit(),
            strategyNoOp: emptyPassiveAlternativeAudit(),
        },
    };
}

function addExecutionAudit(target: IV08AlignedV1ExecutionAudit, source: IV08AlignedV1ExecutionAudit): void {
    for (const side of ["candidate", "opponent"] as const) {
        for (const key of SIDE_EXECUTION_KEYS) target[side][key] += source[side][key];
    }
    for (const kind of ["explicitWait", "explicitDefend", "recovery", "strategyNoOp"] as const) {
        for (const key of PASSIVE_ALTERNATIVE_KEYS) {
            target.candidatePassiveAlternatives[kind][key] += source.candidatePassiveAlternatives[kind][key];
        }
    }
}

const emptyGridCounts = (): Record<V08AlignedV1GridType, number> =>
    Object.fromEntries(V08_ALIGNED_V1_GRID_TYPES.map((gridType) => [gridType, 0])) as Record<
        V08AlignedV1GridType,
        number
    >;

export function aggregateV08AlignedV1(
    observations: readonly IV08AlignedV1GameObservation[],
    options: IV08AlignedV1AggregateOptions = {},
): IV08AlignedV1Aggregate {
    observations.forEach((observation, index) =>
        validateV08AlignedV1GameObservation(observation, `observation[${index}]`),
    );
    const base = aggregateV07AlignedV2(observations, options);
    let expectedGridCounts: Record<V08AlignedV1GridType, number> | null = null;
    let expectedGridError: string | null = null;
    const requireExactGridCoverage = options.requireExactGridCoverage ?? true;
    if (requireExactGridCoverage && options.expectedGamesPerCellSeat !== undefined) {
        try {
            expectedGridCounts = exactGridCountsV08AlignedV1(options.expectedGamesPerCellSeat);
        } catch (error) {
            expectedGridError = error instanceof Error ? error.message : String(error);
        }
    }
    const executionCellSeats: IV08AlignedV1CellSeatExecutionAudit[] = [];
    const mapCellSeats: IV08AlignedV1MapCoverageEntry[] = [];
    const mapErrors: string[] = expectedGridError ? [expectedGridError] : [];
    for (const cell of V08_ALIGNED_96H_V1_CELLS) {
        for (const candidateSeat of V08_ALIGNED_96H_V1_SEATS) {
            const rows = observations.filter((row) => row.cellId === cell.id && row.candidateSeat === candidateSeat);
            const execution = emptyV08AlignedV1ExecutionAudit();
            const counts = emptyGridCounts();
            for (const row of rows) {
                addExecutionAudit(execution, row.execution);
                counts[row.gridType] += 1;
            }
            executionCellSeats.push({ cellId: cell.id, candidateSeat, ...execution });
            const values = V08_ALIGNED_V1_GRID_TYPES.map((gridType) => counts[gridType]);
            const expectedPerGridType = expectedGridCounts?.[V08_ALIGNED_V1_GRID_TYPES[0]] ?? null;
            const ordinalsPassed =
                options.expectedGamesPerCellSeat === undefined ||
                [...rows]
                    .sort((left, right) => left.scenarioOrdinal - right.scenarioOrdinal)
                    .every((row, index) => row.scenarioOrdinal === index);
            const passed =
                ordinalsPassed &&
                (!requireExactGridCoverage
                    ? rows.length > 0
                    : expectedGridCounts
                      ? V08_ALIGNED_V1_GRID_TYPES.every(
                            (gridType) => counts[gridType] === expectedGridCounts![gridType],
                        )
                      : rows.length > 0 && values.every((count) => count === values[0]));
            mapCellSeats.push({ cellId: cell.id, candidateSeat, counts, expectedPerGridType, passed });
            if (!passed) {
                mapErrors.push(`${cell.id}/${candidateSeat}: scenario ordinals or grid coverage are not exact`);
            }
        }
    }
    const pooledExecution = emptyV08AlignedV1ExecutionAudit();
    for (const entry of executionCellSeats) addExecutionAudit(pooledExecution, entry);
    const mapCoveragePassed = mapErrors.length === 0 && mapCellSeats.every((entry) => entry.passed);
    const candidate = pooledExecution.candidate;
    const executionPassed =
        candidate.strategyNoOpTurns === 0 && candidate.recoveryTurns === 0 && candidate.rejectedActions === 0;
    const completenessErrors = [...base.completenessErrors, ...mapErrors];
    return {
        ...base,
        complete: base.complete && mapCoveragePassed,
        completenessErrors,
        mapCoverage: {
            gridTypes: [...V08_ALIGNED_V1_GRID_TYPES],
            cellSeats: mapCellSeats,
            passed: mapCoveragePassed,
        },
        execution: { pooled: pooledExecution, cellSeats: executionCellSeats },
        integrity: {
            ...base.integrity,
            candidateStrategyNoOpTurns: candidate.strategyNoOpTurns,
            candidateRecoveryTurns: candidate.recoveryTurns,
            candidateRecoveryFailedTurns: candidate.recoveryFailedTurns,
            candidateRejectedActions: candidate.rejectedActions,
            mapCoveragePassed,
            executionPassed,
            passed: base.integrity.passed && mapCoveragePassed && executionPassed,
        },
    };
}

export function evaluateV08AlignedV1OperationalEligibility(
    aggregate: IV08AlignedV1Aggregate,
    policy: Readonly<IV08AlignedV1OperationalPolicy> = V08_ALIGNED_V1_OPERATIONAL_POLICY,
): IV08AlignedV1OperationalVerdict {
    const base = evaluateV07AlignedV2OperationalEligibility(aggregate, policy);
    const errors = [...base.errors];
    if (!aggregate.mapCoverage.passed) errors.push("v0.8 grid coverage is not exactly balanced");
    if (!aggregate.integrity.executionPassed) {
        errors.push("candidate execution contains a rejected action, recovery, or strategy no-op");
    }
    return { passed: errors.length === 0, errors: [...new Set(errors)] };
}

export function assessV08AlignedV1Promotion(
    pairs: readonly IV08AlignedV1ConfirmPair[],
    policy: Readonly<IV08AlignedV1PromotionPolicy> = V08_ALIGNED_V1_PROMOTION_POLICY,
): IV08AlignedV1PromotionVerdict {
    const base = assessV07AlignedV2Promotion(pairs, policy);
    const challenger = aggregateV08AlignedV1(
        pairs.map((pair) => pair.challenger as IV08AlignedV1GameObservation),
        { expectedGamesPerCellSeat: policy.requiredPairsPerCellSeat },
    );
    const incumbent = aggregateV08AlignedV1(
        pairs.map((pair) => pair.incumbent as IV08AlignedV1GameObservation),
        { expectedGamesPerCellSeat: policy.requiredPairsPerCellSeat },
    );
    const challengerOperational = evaluateV08AlignedV1OperationalEligibility(challenger, policy.operational);
    const incumbentOperational = evaluateV08AlignedV1OperationalEligibility(incumbent, policy.operational);
    const challengerExecutionPassed = challenger.integrity.executionPassed;
    const checks = {
        ...base.checks,
        freshPanelShapePassed: base.checks.freshPanelShapePassed && challenger.complete && incumbent.complete,
        challengerOperationalPassed: challengerOperational.passed,
        incumbentOperationalPassed: incumbentOperational.passed,
        winLanePassed: base.checks.winLanePassed && challengerOperational.passed && challengerExecutionPassed,
        integrityLanePassed:
            base.checks.integrityLanePassed && challengerOperational.passed && challengerExecutionPassed,
    };
    const passed = checks.winLanePassed || checks.integrityLanePassed;
    const reasons = passed
        ? []
        : [
              ...base.reasons,
              ...challengerOperational.errors.map((error) => `challenger: ${error}`),
              ...incumbentOperational.errors.map((error) => `incumbent: ${error}`),
          ];
    return {
        ...base,
        challenger,
        incumbent,
        checks,
        verdict: passed ? "PROMOTE" : "HOLD",
        reasons: [...new Set(reasons)],
    };
}

export interface IV08AlignedV1ResearchTerminal extends Omit<
    IV07AlignedV2ResearchTerminal,
    "aggregate" | "candidate" | "opponent"
> {
    artifactKind: "v0_8_aligned_96h_v1_research_terminal";
    versionProfile: typeof V08_ALIGNED_96H_V1_VERSION_PROFILE;
    candidate: "v0.8s";
    opponent: "v0.7";
    aggregate: IV08AlignedV1Aggregate;
}

export function assessV08AlignedV1Final(
    observations: readonly IV08AlignedV1GameObservation[],
    policy: Readonly<IV08AlignedV1FinalPolicy> = V08_ALIGNED_V1_FINAL_POLICY,
): IV08AlignedV1ResearchTerminal {
    const terminal = assessV07AlignedV2Final(observations, policy);
    const aggregate = aggregateV08AlignedV1(observations, {
        expectedGamesPerCellSeat: policy.requiredGamesPerCellSeat,
    });
    const operational = evaluateV08AlignedV1OperationalEligibility(aggregate, policy.operational);
    const claims = terminal.claims.map((claim) => {
        const execution = aggregate.execution.cellSeats.find(
            (entry) => entry.cellId === claim.cellId && entry.candidateSeat === claim.candidateSeat,
        )!;
        const map = aggregate.mapCoverage.cellSeats.find(
            (entry) => entry.cellId === claim.cellId && entry.candidateSeat === claim.candidateSeat,
        )!;
        const executionPassed =
            execution.candidate.strategyNoOpTurns === 0 &&
            execution.candidate.recoveryTurns === 0 &&
            execution.candidate.rejectedActions === 0;
        const checks = {
            ...claim.checks,
            operationalPassed: claim.checks.operationalPassed && map.passed && executionPassed,
        };
        return { ...claim, checks, passed: Object.values(checks).every(Boolean) };
    });
    const checks = {
        exactRegisteredFamily: terminal.checks.exactRegisteredFamily && aggregate.complete,
        integrityPassed: aggregate.integrity.passed,
        operationalPassed: operational.passed,
        everyCellSeatPassed: claims.length === V08_ALIGNED_V1_FINAL_HYPOTHESES && claims.every((claim) => claim.passed),
    };
    const passed = Object.values(checks).every(Boolean);
    const reasons = passed
        ? []
        : [
              ...terminal.reasons,
              ...aggregate.completenessErrors,
              ...operational.errors,
              ...claims
                  .filter((claim) => !claim.passed)
                  .map((claim) => `${claim.cellId}/${claim.candidateSeat}: final cell-seat gate failed`),
          ];
    return {
        ...terminal,
        artifactKind: "v0_8_aligned_96h_v1_research_terminal",
        versionProfile: cloneAligned96hVersionProfile(V08_ALIGNED_96H_V1_VERSION_PROFILE),
        candidate: "v0.8s",
        opponent: "v0.7",
        aggregate,
        claims,
        checks,
        verdict: passed ? "PASS" : "FAIL",
        reasons: [...new Set(reasons)],
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
