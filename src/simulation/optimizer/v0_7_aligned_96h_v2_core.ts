/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

/**
 * Pure policy core for the aligned v0.7 96-hour research harness.
 *
 * This module deliberately owns no workers, seeds, files, source mutation, bake,
 * deployment, or process lifecycle. The eventual runner must convert its raw rows
 * into these observations and persist the returned evidence without weakening it.
 */

export const V07_ALIGNED_96H_V2_CELLS = [
    { id: "ranked_mage", cohort: "mage", distribution: "ranked_taxonomy" },
    { id: "ranked_melee_mage", cohort: "melee_mage", distribution: "ranked_taxonomy" },
    { id: "ranked_aura", cohort: "aura", distribution: "ranked_taxonomy" },
    { id: "ranked_ranged", cohort: "ranged", distribution: "ranked_taxonomy" },
    { id: "fixed_mage_frontline", cohort: "mage", distribution: "fixed_template" },
    { id: "fixed_mage_fireline", cohort: "mage", distribution: "fixed_template" },
    { id: "fixed_melee_magic_utility", cohort: "melee_mage", distribution: "fixed_template" },
    { id: "fixed_melee_magic_brawler", cohort: "melee_mage", distribution: "fixed_template" },
    { id: "fixed_aura_support", cohort: "aura", distribution: "fixed_template" },
    { id: "fixed_aura_offense", cohort: "aura", distribution: "fixed_template" },
    { id: "fixed_ranged_precision", cohort: "ranged", distribution: "fixed_template" },
    { id: "fixed_ranged_control", cohort: "ranged", distribution: "fixed_template" },
] as const;

export const V07_ALIGNED_96H_V2_SEATS = ["candidate_green", "candidate_red"] as const;

export type V07AlignedV2CellId = (typeof V07_ALIGNED_96H_V2_CELLS)[number]["id"];
export type V07AlignedV2Cohort = (typeof V07_ALIGNED_96H_V2_CELLS)[number]["cohort"];
export type V07AlignedV2CandidateSeat = (typeof V07_ALIGNED_96H_V2_SEATS)[number];
export type V07AlignedV2Outcome = "candidate_win" | "opponent_win" | "draw";

export const V07_ALIGNED_V2_FINAL_HYPOTHESES = 24 as const;
export const V07_ALIGNED_V2_FINAL_Z = 3.0780880728421605;
export const V07_ALIGNED_V2_PROMOTION_HYPOTHESES = 25 as const;
export const V07_ALIGNED_V2_PROMOTION_Z = 3.090232306167813;

if (V07_ALIGNED_96H_V2_CELLS.length * V07_ALIGNED_96H_V2_SEATS.length !== V07_ALIGNED_V2_FINAL_HYPOTHESES) {
    throw new Error("aligned v2 cell-seat registry must contain exactly 24 hypotheses");
}

export interface IV07AlignedV2SearchAudit {
    decisions: number;
    searchedDecisions: number;
    deadlineFallbacks: number;
    illegalIncumbents: number;
    circuitOpened: boolean;
    circuitSkippedDecisions: number;
    msTotal: number;
}

export interface IV07AlignedV2GameObservation {
    cellId: V07AlignedV2CellId;
    candidateSeat: V07AlignedV2CandidateSeat;
    /** Stable within a panel. A repeated id in the same cell and seat is rejected. */
    scenarioId: string;
    outcome: V07AlignedV2Outcome;
    reachedArmageddon: boolean;
    candidateRejections?: number;
    opponentRejections?: number;
    searchAudit?: IV07AlignedV2SearchAudit;
}

export interface IV07AlignedV2LatencyEvidence {
    auditRows: number;
    missingAuditRows: number;
    decisions: number;
    searchedDecisions: number;
    deadlineFallbacks: number;
    deadlineFallbackRate: number | null;
    illegalIncumbents: number;
    circuitOpenedGames: number;
    circuitSkippedDecisions: number;
    msTotal: number;
    msPerSearchedDecision: number | null;
    gameMs: { p50: number; p95: number; p99: number; max: number } | null;
}

export interface IV07AlignedV2CellSeatEvidence {
    cellId: V07AlignedV2CellId;
    cohort: V07AlignedV2Cohort;
    candidateSeat: V07AlignedV2CandidateSeat;
    games: number;
    wins: number;
    losses: number;
    draws: number;
    decisive: number;
    decisiveFraction: number;
    decisiveWinRate: number | null;
    scoreRate: number | null;
    drawOrArmageddon: number;
    drawOrArmageddonRate: number;
    candidateRejections: number;
    opponentRejections: number;
    missingRejectionCounts: number;
    latency: IV07AlignedV2LatencyEvidence;
}

export interface IV07AlignedV2Aggregate {
    schemaVersion: 1;
    cells: 12;
    seats: 2;
    hypotheses: 24;
    observations: number;
    complete: boolean;
    completenessErrors: string[];
    cellSeats: IV07AlignedV2CellSeatEvidence[];
    pooled: {
        games: number;
        wins: number;
        losses: number;
        draws: number;
        decisive: number;
        decisiveFraction: number;
        decisiveWinRate: number | null;
        scoreRate: number | null;
        drawOrArmageddon: number;
        drawOrArmageddonRate: number;
    };
    objective: {
        method: "max_min_decisive_win_rate_by_cell_and_candidate_seat";
        minimumCellSeatDecisiveWinRate: number | null;
        limitingCellId: V07AlignedV2CellId | null;
        limitingCandidateSeat: V07AlignedV2CandidateSeat | null;
    };
    integrity: {
        candidateRejections: number;
        opponentRejections: number;
        missingRejectionCounts: number;
        missingAuditRows: number;
        illegalIncumbents: number;
        passed: boolean;
    };
    latency: IV07AlignedV2LatencyEvidence;
}

export interface IV07AlignedV2AggregateOptions {
    /** When set, any over- or under-filled stratum makes the aggregate incomplete. */
    expectedGamesPerCellSeat?: number;
}

export interface IV07AlignedV2OperationalPolicy {
    maxDeadlineFallbackRate: number;
    maxCircuitOpenedGames: number;
    maxCircuitSkippedDecisions: number;
    maxMeanMsPerSearchedDecision: number;
}

export const V07_ALIGNED_V2_OPERATIONAL_POLICY: Readonly<IV07AlignedV2OperationalPolicy> = {
    maxDeadlineFallbackRate: 0.05,
    maxCircuitOpenedGames: 0,
    maxCircuitSkippedDecisions: 0,
    maxMeanMsPerSearchedDecision: 200,
};

export interface IV07AlignedV2OperationalVerdict {
    passed: boolean;
    errors: string[];
}

function validateOperationalPolicy(policy: Readonly<IV07AlignedV2OperationalPolicy>): void {
    validateRate(policy.maxDeadlineFallbackRate, "maxDeadlineFallbackRate");
    requireCount(policy.maxCircuitOpenedGames, "maxCircuitOpenedGames");
    requireCount(policy.maxCircuitSkippedDecisions, "maxCircuitSkippedDecisions");
    if (!Number.isFinite(policy.maxMeanMsPerSearchedDecision) || policy.maxMeanMsPerSearchedDecision <= 0) {
        throw new RangeError("maxMeanMsPerSearchedDecision must be finite and positive");
    }
    if (policy.maxDeadlineFallbackRate > V07_ALIGNED_V2_OPERATIONAL_POLICY.maxDeadlineFallbackRate) {
        throw new RangeError("maxDeadlineFallbackRate cannot weaken the aligned v2 policy");
    }
    if (policy.maxCircuitOpenedGames > V07_ALIGNED_V2_OPERATIONAL_POLICY.maxCircuitOpenedGames) {
        throw new RangeError("maxCircuitOpenedGames cannot weaken the aligned v2 policy");
    }
    if (policy.maxCircuitSkippedDecisions > V07_ALIGNED_V2_OPERATIONAL_POLICY.maxCircuitSkippedDecisions) {
        throw new RangeError("maxCircuitSkippedDecisions cannot weaken the aligned v2 policy");
    }
    if (policy.maxMeanMsPerSearchedDecision > V07_ALIGNED_V2_OPERATIONAL_POLICY.maxMeanMsPerSearchedDecision) {
        throw new RangeError("maxMeanMsPerSearchedDecision cannot weaken the aligned v2 policy");
    }
}

interface IMutableBucket {
    cellId: V07AlignedV2CellId;
    cohort: V07AlignedV2Cohort;
    candidateSeat: V07AlignedV2CandidateSeat;
    games: number;
    wins: number;
    losses: number;
    draws: number;
    drawOrArmageddon: number;
    candidateRejections: number;
    opponentRejections: number;
    missingRejectionCounts: number;
    missingAuditRows: number;
    audits: IV07AlignedV2SearchAudit[];
}

const CELL_BY_ID = new Map(V07_ALIGNED_96H_V2_CELLS.map((cell) => [cell.id, cell]));
const SEAT_SET = new Set<string>(V07_ALIGNED_96H_V2_SEATS);

function stratumKey(cellId: V07AlignedV2CellId, seat: V07AlignedV2CandidateSeat): string {
    return `${cellId}|${seat}`;
}

function requireCount(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a nonnegative integer`);
}

function validateRate(value: number, label: string): void {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`${label} must be in [0, 1]`);
}

function validateSearchAudit(audit: IV07AlignedV2SearchAudit, label: string): void {
    requireCount(audit.decisions, `${label}.decisions`);
    requireCount(audit.searchedDecisions, `${label}.searchedDecisions`);
    requireCount(audit.deadlineFallbacks, `${label}.deadlineFallbacks`);
    requireCount(audit.illegalIncumbents, `${label}.illegalIncumbents`);
    requireCount(audit.circuitSkippedDecisions, `${label}.circuitSkippedDecisions`);
    if (audit.searchedDecisions > audit.decisions) {
        throw new RangeError(`${label}.searchedDecisions must not exceed decisions`);
    }
    if (audit.deadlineFallbacks > audit.searchedDecisions) {
        throw new RangeError(`${label}.deadlineFallbacks must not exceed searchedDecisions`);
    }
    if (!audit.circuitOpened && audit.circuitSkippedDecisions !== 0) {
        throw new Error(`${label} cannot skip circuit decisions before the circuit opens`);
    }
    if (!Number.isFinite(audit.msTotal) || audit.msTotal < 0) {
        throw new RangeError(`${label}.msTotal must be finite and nonnegative`);
    }
}

function nearestRank(sorted: readonly number[], percentile: number): number {
    return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
}

function summarizeLatency(
    audits: readonly IV07AlignedV2SearchAudit[],
    missingAuditRows: number,
): IV07AlignedV2LatencyEvidence {
    const decisions = audits.reduce((sum, audit) => sum + audit.decisions, 0);
    const searchedDecisions = audits.reduce((sum, audit) => sum + audit.searchedDecisions, 0);
    const deadlineFallbacks = audits.reduce((sum, audit) => sum + audit.deadlineFallbacks, 0);
    const msTotal = audits.reduce((sum, audit) => sum + audit.msTotal, 0);
    const sortedMs = audits.map((audit) => audit.msTotal).sort((left, right) => left - right);
    return {
        auditRows: audits.length,
        missingAuditRows,
        decisions,
        searchedDecisions,
        deadlineFallbacks,
        deadlineFallbackRate: searchedDecisions ? deadlineFallbacks / searchedDecisions : null,
        illegalIncumbents: audits.reduce((sum, audit) => sum + audit.illegalIncumbents, 0),
        circuitOpenedGames: audits.reduce((sum, audit) => sum + Number(audit.circuitOpened), 0),
        circuitSkippedDecisions: audits.reduce((sum, audit) => sum + audit.circuitSkippedDecisions, 0),
        msTotal,
        msPerSearchedDecision: searchedDecisions ? msTotal / searchedDecisions : null,
        gameMs: sortedMs.length
            ? {
                  p50: nearestRank(sortedMs, 0.5),
                  p95: nearestRank(sortedMs, 0.95),
                  p99: nearestRank(sortedMs, 0.99),
                  max: sortedMs[sortedMs.length - 1],
              }
            : null,
    };
}

function cellSeatOrder(): Array<{
    cellId: V07AlignedV2CellId;
    cohort: V07AlignedV2Cohort;
    candidateSeat: V07AlignedV2CandidateSeat;
}> {
    return V07_ALIGNED_96H_V2_CELLS.flatMap((cell) =>
        V07_ALIGNED_96H_V2_SEATS.map((candidateSeat) => ({
            cellId: cell.id,
            cohort: cell.cohort,
            candidateSeat,
        })),
    );
}

function summarizeBucket(bucket: IMutableBucket): IV07AlignedV2CellSeatEvidence {
    const decisive = bucket.wins + bucket.losses;
    const latency = summarizeLatency(bucket.audits, bucket.missingAuditRows);
    return {
        cellId: bucket.cellId,
        cohort: bucket.cohort,
        candidateSeat: bucket.candidateSeat,
        games: bucket.games,
        wins: bucket.wins,
        losses: bucket.losses,
        draws: bucket.draws,
        decisive,
        decisiveFraction: bucket.games ? decisive / bucket.games : 0,
        decisiveWinRate: decisive ? bucket.wins / decisive : null,
        scoreRate: bucket.games ? (bucket.wins + 0.5 * bucket.draws) / bucket.games : null,
        drawOrArmageddon: bucket.drawOrArmageddon,
        drawOrArmageddonRate: bucket.games ? bucket.drawOrArmageddon / bucket.games : 0,
        candidateRejections: bucket.candidateRejections,
        opponentRejections: bucket.opponentRejections,
        missingRejectionCounts: bucket.missingRejectionCounts,
        latency,
    };
}

export function aggregateV07AlignedV2(
    observations: readonly IV07AlignedV2GameObservation[],
    options: IV07AlignedV2AggregateOptions = {},
): IV07AlignedV2Aggregate {
    if (
        options.expectedGamesPerCellSeat !== undefined &&
        (!Number.isSafeInteger(options.expectedGamesPerCellSeat) || options.expectedGamesPerCellSeat < 1)
    ) {
        throw new RangeError("expectedGamesPerCellSeat must be a positive integer");
    }
    const buckets = new Map<string, IMutableBucket>();
    for (const stratum of cellSeatOrder()) {
        buckets.set(stratumKey(stratum.cellId, stratum.candidateSeat), {
            ...stratum,
            games: 0,
            wins: 0,
            losses: 0,
            draws: 0,
            drawOrArmageddon: 0,
            candidateRejections: 0,
            opponentRejections: 0,
            missingRejectionCounts: 0,
            missingAuditRows: 0,
            audits: [],
        });
    }

    const seen = new Set<string>();
    for (const [index, observation] of observations.entries()) {
        const label = `observation[${index}]`;
        if (!CELL_BY_ID.has(observation.cellId)) throw new Error(`${label}.cellId is not registered`);
        if (!SEAT_SET.has(observation.candidateSeat)) throw new Error(`${label}.candidateSeat is not registered`);
        if (!observation.scenarioId.trim()) throw new Error(`${label}.scenarioId must not be empty`);
        if (!(["candidate_win", "opponent_win", "draw"] as const).includes(observation.outcome)) {
            throw new Error(`${label}.outcome is invalid`);
        }
        if (typeof observation.reachedArmageddon !== "boolean") {
            throw new Error(`${label}.reachedArmageddon must be boolean`);
        }
        const observationKey = `${stratumKey(observation.cellId, observation.candidateSeat)}|${observation.scenarioId}`;
        if (seen.has(observationKey)) throw new Error(`duplicate scenario observation ${observationKey}`);
        seen.add(observationKey);

        const oneRejectionCountMissing =
            (observation.candidateRejections === undefined) !== (observation.opponentRejections === undefined);
        if (oneRejectionCountMissing) throw new Error(`${label} must provide both rejection counts or neither`);
        if (observation.candidateRejections !== undefined && observation.opponentRejections !== undefined) {
            requireCount(observation.candidateRejections, `${label}.candidateRejections`);
            requireCount(observation.opponentRejections, `${label}.opponentRejections`);
        }
        if (observation.searchAudit) validateSearchAudit(observation.searchAudit, `${label}.searchAudit`);

        const bucket = buckets.get(stratumKey(observation.cellId, observation.candidateSeat))!;
        bucket.games += 1;
        bucket.wins += Number(observation.outcome === "candidate_win");
        bucket.losses += Number(observation.outcome === "opponent_win");
        bucket.draws += Number(observation.outcome === "draw");
        bucket.drawOrArmageddon += Number(observation.outcome === "draw" || observation.reachedArmageddon);
        if (observation.candidateRejections === undefined || observation.opponentRejections === undefined) {
            bucket.missingRejectionCounts += 1;
        } else {
            bucket.candidateRejections += observation.candidateRejections;
            bucket.opponentRejections += observation.opponentRejections;
        }
        if (observation.searchAudit) bucket.audits.push(observation.searchAudit);
        else bucket.missingAuditRows += 1;
    }

    const cellSeats = [...buckets.values()].map(summarizeBucket);
    const completenessErrors = cellSeats.flatMap((evidence) => {
        const expected = options.expectedGamesPerCellSeat;
        if (expected !== undefined && evidence.games !== expected) {
            return [
                `${evidence.cellId}/${evidence.candidateSeat}: expected ${expected} games, received ${evidence.games}`,
            ];
        }
        if (expected === undefined && evidence.games === 0) {
            return [`${evidence.cellId}/${evidence.candidateSeat}: no games`];
        }
        return [];
    });
    const wins = cellSeats.reduce((sum, entry) => sum + entry.wins, 0);
    const losses = cellSeats.reduce((sum, entry) => sum + entry.losses, 0);
    const draws = cellSeats.reduce((sum, entry) => sum + entry.draws, 0);
    const games = wins + losses + draws;
    const decisive = wins + losses;
    const drawOrArmageddon = cellSeats.reduce((sum, entry) => sum + entry.drawOrArmageddon, 0);
    const eligibleForObjective = cellSeats.filter(
        (entry): entry is IV07AlignedV2CellSeatEvidence & { decisiveWinRate: number } => entry.decisiveWinRate !== null,
    );
    const limiting = eligibleForObjective.reduce<(typeof eligibleForObjective)[number] | null>(
        (minimum, entry) => (minimum === null || entry.decisiveWinRate < minimum.decisiveWinRate ? entry : minimum),
        null,
    );
    const allAudits = [...buckets.values()].flatMap((bucket) => bucket.audits);
    const missingAuditRows = cellSeats.reduce((sum, entry) => sum + entry.latency.missingAuditRows, 0);
    const candidateRejections = cellSeats.reduce((sum, entry) => sum + entry.candidateRejections, 0);
    const opponentRejections = cellSeats.reduce((sum, entry) => sum + entry.opponentRejections, 0);
    const missingRejectionCounts = cellSeats.reduce((sum, entry) => sum + entry.missingRejectionCounts, 0);
    const illegalIncumbents = cellSeats.reduce((sum, entry) => sum + entry.latency.illegalIncumbents, 0);
    return {
        schemaVersion: 1,
        cells: 12,
        seats: 2,
        hypotheses: V07_ALIGNED_V2_FINAL_HYPOTHESES,
        observations: observations.length,
        complete: completenessErrors.length === 0,
        completenessErrors,
        cellSeats,
        pooled: {
            games,
            wins,
            losses,
            draws,
            decisive,
            decisiveFraction: games ? decisive / games : 0,
            decisiveWinRate: decisive ? wins / decisive : null,
            scoreRate: games ? (wins + 0.5 * draws) / games : null,
            drawOrArmageddon,
            drawOrArmageddonRate: games ? drawOrArmageddon / games : 0,
        },
        objective: {
            method: "max_min_decisive_win_rate_by_cell_and_candidate_seat",
            minimumCellSeatDecisiveWinRate:
                limiting && eligibleForObjective.length === V07_ALIGNED_V2_FINAL_HYPOTHESES
                    ? limiting.decisiveWinRate
                    : null,
            limitingCellId:
                limiting && eligibleForObjective.length === V07_ALIGNED_V2_FINAL_HYPOTHESES ? limiting.cellId : null,
            limitingCandidateSeat:
                limiting && eligibleForObjective.length === V07_ALIGNED_V2_FINAL_HYPOTHESES
                    ? limiting.candidateSeat
                    : null,
        },
        integrity: {
            candidateRejections,
            opponentRejections,
            missingRejectionCounts,
            missingAuditRows,
            illegalIncumbents,
            passed:
                candidateRejections === 0 &&
                opponentRejections === 0 &&
                missingRejectionCounts === 0 &&
                missingAuditRows === 0 &&
                illegalIncumbents === 0,
        },
        latency: summarizeLatency(allAudits, missingAuditRows),
    };
}

export function evaluateV07AlignedV2OperationalEligibility(
    aggregate: IV07AlignedV2Aggregate,
    policy: Readonly<IV07AlignedV2OperationalPolicy> = V07_ALIGNED_V2_OPERATIONAL_POLICY,
): IV07AlignedV2OperationalVerdict {
    validateOperationalPolicy(policy);
    const errors = [...aggregate.completenessErrors];
    if (!aggregate.integrity.passed) errors.push("engine/search integrity counts are not clean");
    for (const entry of aggregate.cellSeats) {
        const prefix = `${entry.cellId}/${entry.candidateSeat}`;
        if (entry.latency.auditRows !== entry.games || entry.latency.missingAuditRows !== 0) {
            errors.push(`${prefix}: search audit is incomplete`);
        }
        if (entry.latency.searchedDecisions === 0) errors.push(`${prefix}: no searched decisions`);
        if (
            entry.latency.deadlineFallbackRate === null ||
            entry.latency.deadlineFallbackRate > policy.maxDeadlineFallbackRate
        ) {
            errors.push(`${prefix}: deadline fallback rate exceeds policy`);
        }
        if (entry.latency.circuitOpenedGames > policy.maxCircuitOpenedGames) {
            errors.push(`${prefix}: circuit-open games exceed policy`);
        }
        if (entry.latency.circuitSkippedDecisions > policy.maxCircuitSkippedDecisions) {
            errors.push(`${prefix}: circuit-skipped decisions exceed policy`);
        }
        if (
            entry.latency.msPerSearchedDecision === null ||
            entry.latency.msPerSearchedDecision > policy.maxMeanMsPerSearchedDecision
        ) {
            errors.push(`${prefix}: mean search latency exceeds policy`);
        }
    }
    return { passed: errors.length === 0, errors };
}

export interface IV07AlignedV2ConfirmPair {
    challenger: IV07AlignedV2GameObservation;
    incumbent: IV07AlignedV2GameObservation;
}

export interface IV07AlignedV2PairedEstimate {
    pairs: number;
    challengerDecisive: number;
    incumbentDecisive: number;
    challengerRate: number;
    incumbentRate: number;
    gain: number;
    standardError: number;
    z: number;
    confidence: { low: number; high: number };
}

export interface IV07AlignedV2PromotionPolicy {
    requiredPairsPerCellSeat: number;
    minimumMaxMinGain: number;
    cellSeatNoninferiorityMargin: number;
    minimumOverallGain: number;
    maximumDrawOrArmageddonRegression: number;
    integrityLaneMinimumDrawOrArmageddonReduction: number;
    promotionZ: number;
    operational: IV07AlignedV2OperationalPolicy;
}

export const V07_ALIGNED_V2_PROMOTION_POLICY: Readonly<IV07AlignedV2PromotionPolicy> = {
    requiredPairsPerCellSeat: 1000,
    minimumMaxMinGain: 0.015,
    cellSeatNoninferiorityMargin: 0.01,
    minimumOverallGain: 0,
    maximumDrawOrArmageddonRegression: 0.01,
    integrityLaneMinimumDrawOrArmageddonReduction: 0.05,
    promotionZ: V07_ALIGNED_V2_PROMOTION_Z,
    operational: V07_ALIGNED_V2_OPERATIONAL_POLICY,
};

export interface IV07AlignedV2PromotionVerdict {
    schemaVersion: 1;
    method: "fresh_paired_confirm_decisive_rate_delta_method";
    hypothesisFamily: 25;
    policy: IV07AlignedV2PromotionPolicy;
    challenger: IV07AlignedV2Aggregate;
    incumbent: IV07AlignedV2Aggregate;
    pooledPairedGain: IV07AlignedV2PairedEstimate | null;
    cellSeatPairedGains: Array<
        IV07AlignedV2PairedEstimate & {
            cellId: V07AlignedV2CellId;
            candidateSeat: V07AlignedV2CandidateSeat;
            noninferiorityPassed: boolean;
        }
    >;
    maxMinGain: number | null;
    maximumDrawOrArmageddonReduction: number;
    checks: {
        freshPanelShapePassed: boolean;
        challengerOperationalPassed: boolean;
        incumbentOperationalPassed: boolean;
        pooledGainPassed: boolean;
        everyCellSeatNoninferior: boolean;
        maxMinGainPassed: boolean;
        drawOrArmageddonRegressionPassed: boolean;
        integrityReductionPassed: boolean;
        winLanePassed: boolean;
        integrityLanePassed: boolean;
    };
    verdict: "PROMOTE" | "HOLD";
    reasons: string[];
}

function decisiveIndicators(outcome: V07AlignedV2Outcome): { win: number; decisive: number } {
    return { win: Number(outcome === "candidate_win"), decisive: Number(outcome !== "draw") };
}

/** Paired delta-method interval for a difference between two decisive-only win-rate ratios. */
export function pairedV07AlignedV2DecisiveGain(
    pairs: readonly IV07AlignedV2ConfirmPair[],
    z = V07_ALIGNED_V2_PROMOTION_Z,
): IV07AlignedV2PairedEstimate | null {
    if (!Number.isFinite(z) || z <= 0) throw new RangeError("z must be finite and positive");
    if (pairs.length < 2) return null;
    const seen = new Set<string>();
    for (const [index, pair] of pairs.entries()) {
        const key = validateConfirmPair(pair, index);
        if (seen.has(key)) throw new Error(`duplicate confirm pair ${key}`);
        seen.add(key);
    }
    const rows = pairs.map((pair) => ({
        challenger: decisiveIndicators(pair.challenger.outcome),
        incumbent: decisiveIndicators(pair.incumbent.outcome),
    }));
    const challengerWins = rows.reduce((sum, row) => sum + row.challenger.win, 0);
    const challengerDecisive = rows.reduce((sum, row) => sum + row.challenger.decisive, 0);
    const incumbentWins = rows.reduce((sum, row) => sum + row.incumbent.win, 0);
    const incumbentDecisive = rows.reduce((sum, row) => sum + row.incumbent.decisive, 0);
    if (challengerDecisive === 0 || incumbentDecisive === 0) return null;
    const challengerRate = challengerWins / challengerDecisive;
    const incumbentRate = incumbentWins / incumbentDecisive;
    const challengerDecisiveFraction = challengerDecisive / rows.length;
    const incumbentDecisiveFraction = incumbentDecisive / rows.length;
    const influence = rows.map(
        (row) =>
            (row.challenger.win - challengerRate * row.challenger.decisive) / challengerDecisiveFraction -
            (row.incumbent.win - incumbentRate * row.incumbent.decisive) / incumbentDecisiveFraction,
    );
    const influenceMean = influence.reduce((sum, value) => sum + value, 0) / influence.length;
    const variance = influence.reduce((sum, value) => sum + (value - influenceMean) ** 2, 0) / (influence.length - 1);
    const standardError = Math.sqrt(variance / influence.length);
    const gain = challengerRate - incumbentRate;
    return {
        pairs: pairs.length,
        challengerDecisive,
        incumbentDecisive,
        challengerRate,
        incumbentRate,
        gain,
        standardError,
        z,
        confidence: { low: gain - z * standardError, high: gain + z * standardError },
    };
}

function validateConfirmPair(pair: IV07AlignedV2ConfirmPair, index: number): string {
    const challenger = pair.challenger;
    const incumbent = pair.incumbent;
    if (
        challenger.cellId !== incumbent.cellId ||
        challenger.candidateSeat !== incumbent.candidateSeat ||
        challenger.scenarioId !== incumbent.scenarioId
    ) {
        throw new Error(`confirm pair ${index} does not join the same cell, seat, and scenario`);
    }
    return `${stratumKey(challenger.cellId, challenger.candidateSeat)}|${challenger.scenarioId}`;
}

function validatePromotionPolicy(policy: Readonly<IV07AlignedV2PromotionPolicy>): void {
    if (
        !Number.isSafeInteger(policy.requiredPairsPerCellSeat) ||
        policy.requiredPairsPerCellSeat < V07_ALIGNED_V2_PROMOTION_POLICY.requiredPairsPerCellSeat
    ) {
        throw new RangeError(
            `requiredPairsPerCellSeat must be an integer >= ${V07_ALIGNED_V2_PROMOTION_POLICY.requiredPairsPerCellSeat}`,
        );
    }
    validateRate(policy.minimumMaxMinGain, "minimumMaxMinGain");
    validateRate(policy.cellSeatNoninferiorityMargin, "cellSeatNoninferiorityMargin");
    validateRate(policy.minimumOverallGain, "minimumOverallGain");
    validateRate(policy.maximumDrawOrArmageddonRegression, "maximumDrawOrArmageddonRegression");
    validateRate(policy.integrityLaneMinimumDrawOrArmageddonReduction, "integrityLaneMinimumDrawOrArmageddonReduction");
    if (!Number.isFinite(policy.promotionZ) || policy.promotionZ <= 0) {
        throw new RangeError("promotionZ must be finite and positive");
    }
    if (policy.minimumMaxMinGain < V07_ALIGNED_V2_PROMOTION_POLICY.minimumMaxMinGain) {
        throw new RangeError("minimumMaxMinGain cannot weaken the aligned v2 policy");
    }
    if (policy.cellSeatNoninferiorityMargin > V07_ALIGNED_V2_PROMOTION_POLICY.cellSeatNoninferiorityMargin) {
        throw new RangeError("cellSeatNoninferiorityMargin cannot weaken the aligned v2 policy");
    }
    if (policy.minimumOverallGain < V07_ALIGNED_V2_PROMOTION_POLICY.minimumOverallGain) {
        throw new RangeError("minimumOverallGain cannot weaken the aligned v2 policy");
    }
    if (policy.maximumDrawOrArmageddonRegression > V07_ALIGNED_V2_PROMOTION_POLICY.maximumDrawOrArmageddonRegression) {
        throw new RangeError("maximumDrawOrArmageddonRegression cannot weaken the aligned v2 policy");
    }
    if (
        policy.integrityLaneMinimumDrawOrArmageddonReduction <
        V07_ALIGNED_V2_PROMOTION_POLICY.integrityLaneMinimumDrawOrArmageddonReduction
    ) {
        throw new RangeError("integrityLaneMinimumDrawOrArmageddonReduction cannot weaken the aligned v2 policy");
    }
    if (policy.promotionZ < V07_ALIGNED_V2_PROMOTION_Z) {
        throw new RangeError("promotionZ cannot weaken the simultaneous 25-interval family");
    }
    validateOperationalPolicy(policy.operational);
}

export function assessV07AlignedV2Promotion(
    pairs: readonly IV07AlignedV2ConfirmPair[],
    policy: Readonly<IV07AlignedV2PromotionPolicy> = V07_ALIGNED_V2_PROMOTION_POLICY,
): IV07AlignedV2PromotionVerdict {
    validatePromotionPolicy(policy);
    const seen = new Set<string>();
    for (const [index, pair] of pairs.entries()) {
        const key = validateConfirmPair(pair, index);
        if (seen.has(key)) throw new Error(`duplicate confirm pair ${key}`);
        seen.add(key);
    }
    const challenger = aggregateV07AlignedV2(
        pairs.map((pair) => pair.challenger),
        { expectedGamesPerCellSeat: policy.requiredPairsPerCellSeat },
    );
    const incumbent = aggregateV07AlignedV2(
        pairs.map((pair) => pair.incumbent),
        { expectedGamesPerCellSeat: policy.requiredPairsPerCellSeat },
    );
    const grouped = new Map<string, IV07AlignedV2ConfirmPair[]>();
    for (const pair of pairs) {
        const key = stratumKey(pair.challenger.cellId, pair.challenger.candidateSeat);
        const entries = grouped.get(key) ?? [];
        entries.push(pair);
        grouped.set(key, entries);
    }
    const cellSeatPairedGains = cellSeatOrder().flatMap((stratum) => {
        const estimate = pairedV07AlignedV2DecisiveGain(
            grouped.get(stratumKey(stratum.cellId, stratum.candidateSeat)) ?? [],
            policy.promotionZ,
        );
        return estimate
            ? [
                  {
                      ...estimate,
                      cellId: stratum.cellId,
                      candidateSeat: stratum.candidateSeat,
                      noninferiorityPassed: estimate.confidence.low >= -policy.cellSeatNoninferiorityMargin,
                  },
              ]
            : [];
    });
    const pooledPairedGain = pairedV07AlignedV2DecisiveGain(pairs, policy.promotionZ);
    const challengerMinimum = challenger.objective.minimumCellSeatDecisiveWinRate;
    const incumbentMinimum = incumbent.objective.minimumCellSeatDecisiveWinRate;
    const maxMinGain =
        challengerMinimum === null || incumbentMinimum === null ? null : challengerMinimum - incumbentMinimum;
    const maximumDrawOrArmageddonReduction =
        Math.max(...incumbent.cellSeats.map((entry) => entry.drawOrArmageddonRate)) -
        Math.max(...challenger.cellSeats.map((entry) => entry.drawOrArmageddonRate));
    const challengerOperational = evaluateV07AlignedV2OperationalEligibility(challenger, policy.operational);
    const incumbentOperational = evaluateV07AlignedV2OperationalEligibility(incumbent, policy.operational);
    const freshPanelShapePassed =
        challenger.complete && incumbent.complete && cellSeatPairedGains.length === V07_ALIGNED_V2_FINAL_HYPOTHESES;
    const pooledGainPassed = pooledPairedGain !== null && pooledPairedGain.confidence.low > policy.minimumOverallGain;
    const everyCellSeatNoninferior =
        cellSeatPairedGains.length === V07_ALIGNED_V2_FINAL_HYPOTHESES &&
        cellSeatPairedGains.every((entry) => entry.noninferiorityPassed);
    const maxMinGainPassed = maxMinGain !== null && maxMinGain >= policy.minimumMaxMinGain;
    const drawOrArmageddonRegressionPassed = challenger.cellSeats.every((entry) => {
        const prior = incumbent.cellSeats.find(
            (candidate) => candidate.cellId === entry.cellId && candidate.candidateSeat === entry.candidateSeat,
        )!;
        return entry.drawOrArmageddonRate <= prior.drawOrArmageddonRate + policy.maximumDrawOrArmageddonRegression;
    });
    const integrityReductionPassed =
        maximumDrawOrArmageddonReduction >= policy.integrityLaneMinimumDrawOrArmageddonReduction;
    const sharedPrerequisites =
        freshPanelShapePassed && challengerOperational.passed && incumbent.integrity.passed && everyCellSeatNoninferior;
    const winLanePassed =
        sharedPrerequisites && pooledGainPassed && maxMinGainPassed && drawOrArmageddonRegressionPassed;
    const integrityLanePassed =
        sharedPrerequisites &&
        integrityReductionPassed &&
        drawOrArmageddonRegressionPassed &&
        maxMinGain !== null &&
        maxMinGain >= -policy.cellSeatNoninferiorityMargin &&
        pooledPairedGain !== null &&
        pooledPairedGain.confidence.low >= -policy.cellSeatNoninferiorityMargin;
    const checks = {
        freshPanelShapePassed,
        challengerOperationalPassed: challengerOperational.passed,
        incumbentOperationalPassed: incumbentOperational.passed,
        pooledGainPassed,
        everyCellSeatNoninferior,
        maxMinGainPassed,
        drawOrArmageddonRegressionPassed,
        integrityReductionPassed,
        winLanePassed,
        integrityLanePassed,
    };
    const reasons = [
        ...(!freshPanelShapePassed ? ["confirm panel does not contain the exact registered cell-seat shape"] : []),
        ...challengerOperational.errors.map((error) => `challenger: ${error}`),
        ...incumbentOperational.errors.map((error) => `incumbent: ${error}`),
        ...(!pooledGainPassed ? ["paired pooled gain lower bound does not clear the win-lane threshold"] : []),
        ...(!everyCellSeatNoninferior ? ["at least one cell-seat fails paired noninferiority"] : []),
        ...(!maxMinGainPassed ? ["max-min objective gain does not clear the win-lane threshold"] : []),
        ...(!drawOrArmageddonRegressionPassed ? ["draw-or-Armageddon regression exceeds policy"] : []),
        ...(!integrityReductionPassed ? ["draw-or-Armageddon reduction does not clear the integrity lane"] : []),
    ];
    return {
        schemaVersion: 1,
        method: "fresh_paired_confirm_decisive_rate_delta_method",
        hypothesisFamily: V07_ALIGNED_V2_PROMOTION_HYPOTHESES,
        policy: { ...policy, operational: { ...policy.operational } },
        challenger,
        incumbent,
        pooledPairedGain,
        cellSeatPairedGains,
        maxMinGain,
        maximumDrawOrArmageddonReduction,
        checks,
        verdict: winLanePassed || integrityLanePassed ? "PROMOTE" : "HOLD",
        reasons: winLanePassed || integrityLanePassed ? [] : reasons,
    };
}

export function wilsonV07AlignedV2(
    wins: number,
    losses: number,
    z = V07_ALIGNED_V2_FINAL_Z,
): { low: number; high: number } | null {
    requireCount(wins, "wins");
    requireCount(losses, "losses");
    if (!Number.isFinite(z) || z <= 0) throw new RangeError("z must be finite and positive");
    const n = wins + losses;
    if (!n) return null;
    const p = wins / n;
    const z2 = z * z;
    const denominator = 1 + z2 / n;
    const center = p + z2 / (2 * n);
    const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
    return {
        low: Math.max(0, (center - margin) / denominator),
        high: Math.min(1, (center + margin) / denominator),
    };
}

export interface IV07AlignedV2FinalPolicy {
    requiredGamesPerCellSeat: number;
    targetDecisiveWinRate: number;
    minimumDecisiveFraction: number;
    maximumDrawOrArmageddonRate: number;
    formalZ: number;
    operational: IV07AlignedV2OperationalPolicy;
}

export const V07_ALIGNED_V2_FINAL_POLICY: Readonly<IV07AlignedV2FinalPolicy> = {
    requiredGamesPerCellSeat: 2000,
    targetDecisiveWinRate: 0.9,
    minimumDecisiveFraction: 0.9,
    maximumDrawOrArmageddonRate: 0.1,
    formalZ: V07_ALIGNED_V2_FINAL_Z,
    operational: V07_ALIGNED_V2_OPERATIONAL_POLICY,
};

export interface IV07AlignedV2FinalClaim {
    cellId: V07AlignedV2CellId;
    cohort: V07AlignedV2Cohort;
    candidateSeat: V07AlignedV2CandidateSeat;
    games: number;
    decisive: number;
    decisiveFraction: number;
    decisiveWinRate: number | null;
    drawOrArmageddonRate: number;
    wilson: { low: number; high: number } | null;
    checks: {
        exactSampleSizePassed: boolean;
        decisiveFractionPassed: boolean;
        decisiveWilsonLowPassed: boolean;
        drawOrArmageddonPassed: boolean;
        operationalPassed: boolean;
    };
    passed: boolean;
}

export interface IV07AlignedV2ResearchTerminal {
    schemaVersion: 1;
    status: "research_only_no_bake";
    candidate: "v0.7s";
    opponent: "v0.6";
    automaticBake: false;
    automaticDeploy: false;
    formalMethod: "bonferroni_two_sided_wilson_by_cell_and_candidate_seat";
    hypotheses: 24;
    nominalFamilywiseConfidence: 0.95;
    formalZ: number;
    thresholds: IV07AlignedV2FinalPolicy;
    aggregate: IV07AlignedV2Aggregate;
    claims: IV07AlignedV2FinalClaim[];
    checks: {
        exactRegisteredFamily: boolean;
        integrityPassed: boolean;
        operationalPassed: boolean;
        everyCellSeatPassed: boolean;
    };
    verdict: "PASS" | "FAIL";
    reasons: string[];
}

function validateFinalPolicy(policy: Readonly<IV07AlignedV2FinalPolicy>): void {
    if (
        !Number.isSafeInteger(policy.requiredGamesPerCellSeat) ||
        policy.requiredGamesPerCellSeat < V07_ALIGNED_V2_FINAL_POLICY.requiredGamesPerCellSeat
    ) {
        throw new RangeError(
            `requiredGamesPerCellSeat must be an integer >= ${V07_ALIGNED_V2_FINAL_POLICY.requiredGamesPerCellSeat}`,
        );
    }
    validateRate(policy.targetDecisiveWinRate, "targetDecisiveWinRate");
    validateRate(policy.minimumDecisiveFraction, "minimumDecisiveFraction");
    validateRate(policy.maximumDrawOrArmageddonRate, "maximumDrawOrArmageddonRate");
    if (!Number.isFinite(policy.formalZ) || policy.formalZ <= 0) {
        throw new RangeError("formalZ must be finite and positive");
    }
    if (policy.targetDecisiveWinRate < V07_ALIGNED_V2_FINAL_POLICY.targetDecisiveWinRate) {
        throw new RangeError("targetDecisiveWinRate cannot weaken the aligned v2 policy");
    }
    if (policy.minimumDecisiveFraction < V07_ALIGNED_V2_FINAL_POLICY.minimumDecisiveFraction) {
        throw new RangeError("minimumDecisiveFraction cannot weaken the aligned v2 policy");
    }
    if (policy.maximumDrawOrArmageddonRate > V07_ALIGNED_V2_FINAL_POLICY.maximumDrawOrArmageddonRate) {
        throw new RangeError("maximumDrawOrArmageddonRate cannot weaken the aligned v2 policy");
    }
    if (policy.formalZ < V07_ALIGNED_V2_FINAL_Z) {
        throw new RangeError("formalZ cannot weaken the simultaneous 24-claim family");
    }
    validateOperationalPolicy(policy.operational);
}

export function assessV07AlignedV2Final(
    observations: readonly IV07AlignedV2GameObservation[],
    policy: Readonly<IV07AlignedV2FinalPolicy> = V07_ALIGNED_V2_FINAL_POLICY,
): IV07AlignedV2ResearchTerminal {
    validateFinalPolicy(policy);
    const aggregate = aggregateV07AlignedV2(observations, {
        expectedGamesPerCellSeat: policy.requiredGamesPerCellSeat,
    });
    const operational = evaluateV07AlignedV2OperationalEligibility(aggregate, policy.operational);
    const claims = aggregate.cellSeats.map((entry): IV07AlignedV2FinalClaim => {
        const wilson = wilsonV07AlignedV2(entry.wins, entry.losses, policy.formalZ);
        const checks = {
            exactSampleSizePassed: entry.games === policy.requiredGamesPerCellSeat,
            decisiveFractionPassed: entry.decisiveFraction >= policy.minimumDecisiveFraction,
            decisiveWilsonLowPassed: wilson !== null && wilson.low >= policy.targetDecisiveWinRate,
            drawOrArmageddonPassed: entry.drawOrArmageddonRate <= policy.maximumDrawOrArmageddonRate,
            operationalPassed:
                entry.latency.auditRows === entry.games &&
                entry.latency.missingAuditRows === 0 &&
                entry.latency.searchedDecisions > 0 &&
                entry.latency.deadlineFallbackRate !== null &&
                entry.latency.deadlineFallbackRate <= policy.operational.maxDeadlineFallbackRate &&
                entry.latency.circuitOpenedGames <= policy.operational.maxCircuitOpenedGames &&
                entry.latency.circuitSkippedDecisions <= policy.operational.maxCircuitSkippedDecisions &&
                entry.latency.msPerSearchedDecision !== null &&
                entry.latency.msPerSearchedDecision <= policy.operational.maxMeanMsPerSearchedDecision,
        };
        return {
            cellId: entry.cellId,
            cohort: entry.cohort,
            candidateSeat: entry.candidateSeat,
            games: entry.games,
            decisive: entry.decisive,
            decisiveFraction: entry.decisiveFraction,
            decisiveWinRate: entry.decisiveWinRate,
            drawOrArmageddonRate: entry.drawOrArmageddonRate,
            wilson,
            checks,
            passed: Object.values(checks).every(Boolean),
        };
    });
    const checks = {
        exactRegisteredFamily:
            aggregate.complete && claims.length === V07_ALIGNED_V2_FINAL_HYPOTHESES && aggregate.hypotheses === 24,
        integrityPassed: aggregate.integrity.passed,
        operationalPassed: operational.passed,
        everyCellSeatPassed: claims.length === V07_ALIGNED_V2_FINAL_HYPOTHESES && claims.every((claim) => claim.passed),
    };
    const reasons = [
        ...aggregate.completenessErrors,
        ...(!aggregate.integrity.passed ? ["engine/search integrity evidence is not clean"] : []),
        ...operational.errors,
        ...claims
            .filter((claim) => !claim.passed)
            .map((claim) => `${claim.cellId}/${claim.candidateSeat}: final cell-seat gate failed`),
    ];
    return {
        schemaVersion: 1,
        status: "research_only_no_bake",
        candidate: "v0.7s",
        opponent: "v0.6",
        automaticBake: false,
        automaticDeploy: false,
        formalMethod: "bonferroni_two_sided_wilson_by_cell_and_candidate_seat",
        hypotheses: V07_ALIGNED_V2_FINAL_HYPOTHESES,
        nominalFamilywiseConfidence: 0.95,
        formalZ: policy.formalZ,
        thresholds: { ...policy, operational: { ...policy.operational } },
        aggregate,
        claims,
        checks,
        verdict: Object.values(checks).every(Boolean) ? "PASS" : "FAIL",
        reasons: Object.values(checks).every(Boolean) ? [] : [...new Set(reasons)],
    };
}

export interface IV07AlignedV2DryRunConfig {
    schemaVersion: 1;
    status: "research_only_no_bake";
    candidate: "v0.7s";
    candidateBase: "v0.7";
    opponent: "v0.6";
    cells: V07AlignedV2CellId[];
    seats: V07AlignedV2CandidateSeat[];
    profile: { decisionDeadlineMs: 200; circuitBreakerMs: 275 };
    compute: {
        totalHours: 96;
        finalReserveHours: number;
        hostLogicalCpus: number;
        workers: number;
        reservedLogicalCpus: number;
        evaluationParallelism: number;
        workersPerTrial: number;
    };
    panels: { confirmGamesPerCellSeat: number; finalGamesPerCellSeat: number };
    objective: "equal_cell_equal_seat_max_min";
    finalHypotheses: 24;
    automaticBake: false;
    automaticDeploy: false;
    seedPolicy: {
        state: "unallocated_dry_run";
        externalDenysetRequired: true;
        finalRevealOnlyAfterImmutableFreeze: true;
    };
}

export function defaultV07AlignedV2DryRunConfig(): IV07AlignedV2DryRunConfig {
    return {
        schemaVersion: 1,
        status: "research_only_no_bake",
        candidate: "v0.7s",
        candidateBase: "v0.7",
        opponent: "v0.6",
        cells: V07_ALIGNED_96H_V2_CELLS.map((cell) => cell.id),
        seats: [...V07_ALIGNED_96H_V2_SEATS],
        profile: { decisionDeadlineMs: 200, circuitBreakerMs: 275 },
        compute: {
            totalHours: 96,
            finalReserveHours: 36,
            hostLogicalCpus: 48,
            workers: 40,
            reservedLogicalCpus: 4,
            evaluationParallelism: 10,
            workersPerTrial: 4,
        },
        panels: { confirmGamesPerCellSeat: 1000, finalGamesPerCellSeat: 2000 },
        objective: "equal_cell_equal_seat_max_min",
        finalHypotheses: V07_ALIGNED_V2_FINAL_HYPOTHESES,
        automaticBake: false,
        automaticDeploy: false,
        seedPolicy: {
            state: "unallocated_dry_run",
            externalDenysetRequired: true,
            finalRevealOnlyAfterImmutableFreeze: true,
        },
    };
}

export interface IV07AlignedV2DryRunValidation {
    valid: boolean;
    errors: string[];
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    const actual = Object.keys(value).sort();
    return JSON.stringify(actual) === JSON.stringify([...expected].sort());
}

export function validateV07AlignedV2DryRunConfig(value: unknown): IV07AlignedV2DryRunValidation {
    const errors: string[] = [];
    if (!isObjectRecord(value)) return { valid: false, errors: ["config must be an object"] };
    const config = value;
    const profile = isObjectRecord(config.profile) ? config.profile : {};
    const compute = isObjectRecord(config.compute) ? config.compute : {};
    const panels = isObjectRecord(config.panels) ? config.panels : {};
    const seedPolicy = isObjectRecord(config.seedPolicy) ? config.seedPolicy : {};
    const expectedCells = V07_ALIGNED_96H_V2_CELLS.map((cell) => cell.id);
    if (
        !hasExactKeys(config, [
            "schemaVersion",
            "status",
            "candidate",
            "candidateBase",
            "opponent",
            "cells",
            "seats",
            "profile",
            "compute",
            "panels",
            "objective",
            "finalHypotheses",
            "automaticBake",
            "automaticDeploy",
            "seedPolicy",
        ])
    ) {
        errors.push("config must contain exactly the registered top-level fields");
    }
    if (!hasExactKeys(profile, ["decisionDeadlineMs", "circuitBreakerMs"])) {
        errors.push("profile must contain exactly the deadline and circuit fields");
    }
    if (
        !hasExactKeys(compute, [
            "totalHours",
            "finalReserveHours",
            "hostLogicalCpus",
            "workers",
            "reservedLogicalCpus",
            "evaluationParallelism",
            "workersPerTrial",
        ])
    ) {
        errors.push("compute must contain exactly the registered resource fields");
    }
    if (!hasExactKeys(panels, ["confirmGamesPerCellSeat", "finalGamesPerCellSeat"])) {
        errors.push("panels must contain exactly the confirm and final sizes");
    }
    if (!hasExactKeys(seedPolicy, ["state", "externalDenysetRequired", "finalRevealOnlyAfterImmutableFreeze"])) {
        errors.push("seedPolicy must contain exactly the registered dry-run fields");
    }
    if (config.schemaVersion !== 1) errors.push("schemaVersion must equal 1");
    if (JSON.stringify(config.cells) !== JSON.stringify(expectedCells)) {
        errors.push("cells must be the exact canonical twelve-cell registry");
    }
    if (JSON.stringify(config.seats) !== JSON.stringify(V07_ALIGNED_96H_V2_SEATS)) {
        errors.push("seats must include candidate_green and candidate_red in canonical order");
    }
    if (config.candidate !== "v0.7s" || config.candidateBase !== "v0.7" || config.opponent !== "v0.6") {
        errors.push("versions must isolate candidate v0.7s/v0.7 from opponent v0.6");
    }
    if (
        config.status !== "research_only_no_bake" ||
        config.automaticBake !== false ||
        config.automaticDeploy !== false
    ) {
        errors.push("aligned v2 is research-only and must disable automatic bake/deploy");
    }
    if (profile.decisionDeadlineMs !== 200 || profile.circuitBreakerMs !== 275) {
        errors.push("profile must bind the conservative 200ms deadline and 275ms circuit breaker");
    }
    if (compute.totalHours !== 96) errors.push("totalHours must equal 96");
    if (
        !Number.isSafeInteger(compute.finalReserveHours) ||
        (compute.finalReserveHours as number) < 24 ||
        (compute.finalReserveHours as number) >= (compute.totalHours as number)
    ) {
        errors.push("finalReserveHours must be an integer in [24, 95]");
    }
    for (const key of [
        "hostLogicalCpus",
        "workers",
        "reservedLogicalCpus",
        "evaluationParallelism",
        "workersPerTrial",
    ] as const) {
        if (!Number.isSafeInteger(compute[key]) || (compute[key] as number) < 1) {
            errors.push(`compute.${key} must be a positive integer`);
        }
    }
    if (
        Number.isSafeInteger(compute.workers) &&
        Number.isSafeInteger(compute.reservedLogicalCpus) &&
        Number.isSafeInteger(compute.hostLogicalCpus) &&
        (compute.workers as number) + (compute.reservedLogicalCpus as number) > (compute.hostLogicalCpus as number)
    ) {
        errors.push("workers plus reservedLogicalCpus exceed hostLogicalCpus");
    }
    if (
        Number.isSafeInteger(compute.evaluationParallelism) &&
        Number.isSafeInteger(compute.workersPerTrial) &&
        Number.isSafeInteger(compute.workers) &&
        (compute.evaluationParallelism as number) * (compute.workersPerTrial as number) > (compute.workers as number)
    ) {
        errors.push("parallel trials oversubscribe configured workers");
    }
    if (
        !Number.isSafeInteger(panels.confirmGamesPerCellSeat) ||
        (panels.confirmGamesPerCellSeat as number) < V07_ALIGNED_V2_PROMOTION_POLICY.requiredPairsPerCellSeat
    ) {
        errors.push("confirm panel is smaller than the promotion policy minimum");
    }
    if (
        !Number.isSafeInteger(panels.finalGamesPerCellSeat) ||
        (panels.finalGamesPerCellSeat as number) < V07_ALIGNED_V2_FINAL_POLICY.requiredGamesPerCellSeat
    ) {
        errors.push("final panel is smaller than the formal gate minimum");
    }
    if (config.objective !== "equal_cell_equal_seat_max_min") errors.push("objective must be equal-cell max-min");
    if (config.finalHypotheses !== V07_ALIGNED_V2_FINAL_HYPOTHESES) {
        errors.push("finalHypotheses must bind all 24 cell-seat claims");
    }
    if (
        seedPolicy.state !== "unallocated_dry_run" ||
        seedPolicy.externalDenysetRequired !== true ||
        seedPolicy.finalRevealOnlyAfterImmutableFreeze !== true
    ) {
        errors.push("dry-run seed policy must remain unallocated, denyset-bound, and reveal-after-freeze");
    }
    return { valid: errors.length === 0, errors };
}
