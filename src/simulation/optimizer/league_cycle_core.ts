/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import { createHash } from "node:crypto";

import { assertLeagueWeights, type ILeagueGenome } from "../league_genome";

export interface ILeaguePayoffObservation {
    candidateId: string;
    opponentId: string;
    wins: number;
    losses: number;
    draws: number;
}

export interface IEmpiricalLeaguePayoff {
    entrantIds: string[];
    games: number[][];
    /** Point score with a draw worth one half, before zero-sum projection. */
    directionalScores: number[][];
    /** Antisymmetric, centered payoff: a win is +1, a loss is -1, and a draw is 0. */
    payoffs: number[][];
    directionalResiduals: number[][];
    maxDirectionalResidual: number;
}

export interface ILeagueMixtureEntry {
    entrantId: string;
    weight: number;
}

export interface IApproximateZeroSumSolution {
    method: "simultaneous_multiplicative_weights";
    iterations: number;
    learningRate: number;
    rowMixture: ILeagueMixtureEntry[];
    adversarialMixture: ILeagueMixtureEntry[];
    symmetricMixture: ILeagueMixtureEntry[];
    lowerValueBound: number;
    upperValueBound: number;
    midpointValue: number;
    dualityGap: number;
    symmetricExploitability: number;
    averagePlayPayoff: number;
    rowExternalRegret: number;
    adversaryExternalRegret: number;
}

function canonicalValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalValue);
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, entry]) => [key, canonicalValue(entry)]),
        );
    }
    return value;
}

export function canonicalJson(value: unknown): string {
    return JSON.stringify(canonicalValue(value));
}

export function leagueFingerprint(value: unknown): string {
    return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Accept either signed-int32 or uint32 seed serialization and return the canonical uint32 value. */
export function normalizeLeagueSeed(value: number): number {
    if (!Number.isInteger(value) || value < -0x80000000 || value > 0xffffffff) {
        throw new RangeError("League seed must be a signed int32 or uint32 integer");
    }
    return value >>> 0;
}

export function leagueGenomeFingerprint(genome: Pick<ILeagueGenome, "weights" | "omniscientDraft">): string {
    assertLeagueWeights(genome.weights);
    return leagueFingerprint({
        omniscientDraft: !!genome.omniscientDraft,
        weights: genome.weights,
    });
}

function assertCount(value: number, name: string): void {
    if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
}

/**
 * Project independently measured directional cells onto an antisymmetric zero-sum matrix. Keeping the
 * pre-projection residual makes evaluator asymmetry visible instead of hiding it in the solver.
 */
export function buildEmpiricalLeaguePayoff(
    entrantIds: readonly string[],
    observations: readonly ILeaguePayoffObservation[],
): IEmpiricalLeaguePayoff {
    if (!entrantIds.length) throw new RangeError("A payoff matrix needs at least one entrant");
    if (new Set(entrantIds).size !== entrantIds.length || entrantIds.some((id) => !id.trim())) {
        throw new Error("Payoff entrant ids must be non-empty and unique");
    }
    const indexById = new Map(entrantIds.map((id, index) => [id, index]));
    const size = entrantIds.length;
    const games = Array.from({ length: size }, () => new Array<number>(size).fill(0));
    const directionalScores = Array.from({ length: size }, () => new Array<number>(size).fill(Number.NaN));
    for (const observation of observations) {
        const row = indexById.get(observation.candidateId);
        const column = indexById.get(observation.opponentId);
        if (row === undefined || column === undefined) {
            throw new Error(
                `Payoff observation names an unknown cell ${observation.candidateId}/${observation.opponentId}`,
            );
        }
        assertCount(observation.wins, "wins");
        assertCount(observation.losses, "losses");
        assertCount(observation.draws, "draws");
        const total = observation.wins + observation.losses + observation.draws;
        if (!total) throw new RangeError(`Payoff cell ${observation.candidateId}/${observation.opponentId} is empty`);
        if (Number.isFinite(directionalScores[row][column])) {
            throw new Error(`Duplicate payoff cell ${observation.candidateId}/${observation.opponentId}`);
        }
        games[row][column] = total;
        directionalScores[row][column] = (observation.wins + observation.draws * 0.5) / total;
    }
    for (let row = 0; row < size; row += 1) {
        for (let column = 0; column < size; column += 1) {
            if (!Number.isFinite(directionalScores[row][column])) {
                throw new Error(`Missing payoff cell ${entrantIds[row]}/${entrantIds[column]}`);
            }
        }
    }

    const centered = directionalScores.map((row) => row.map((score) => score * 2 - 1));
    const payoffs = Array.from({ length: size }, () => new Array<number>(size).fill(0));
    const directionalResiduals = Array.from({ length: size }, () => new Array<number>(size).fill(0));
    let maxDirectionalResidual = 0;
    for (let row = 0; row < size; row += 1) {
        for (let column = 0; column < size; column += 1) {
            if (row === column) {
                directionalResiduals[row][column] = Math.abs(centered[row][column] * 2);
                maxDirectionalResidual = Math.max(maxDirectionalResidual, directionalResiduals[row][column]);
                continue;
            }
            payoffs[row][column] = (centered[row][column] - centered[column][row]) / 2;
            directionalResiduals[row][column] = Math.abs(centered[row][column] + centered[column][row]);
            maxDirectionalResidual = Math.max(maxDirectionalResidual, directionalResiduals[row][column]);
        }
    }
    return {
        entrantIds: [...entrantIds],
        games,
        directionalScores,
        payoffs,
        directionalResiduals,
        maxDirectionalResidual,
    };
}

function distribution(logWeights: readonly number[]): number[] {
    const maximum = Math.max(...logWeights);
    const weights = logWeights.map((weight) => Math.exp(weight - maximum));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    return weights.map((weight) => weight / total);
}

function matrixVector(payoffs: readonly (readonly number[])[], vector: readonly number[]): number[] {
    return payoffs.map((row) => row.reduce((sum, payoff, index) => sum + payoff * vector[index], 0));
}

function rowMatrix(vector: readonly number[], payoffs: readonly (readonly number[])[]): number[] {
    return payoffs.map((_, column) => vector.reduce((sum, weight, row) => sum + weight * payoffs[row][column], 0));
}

function mixture(entrantIds: readonly string[], weights: readonly number[]): ILeagueMixtureEntry[] {
    return entrantIds.map((entrantId, index) => ({ entrantId, weight: weights[index] }));
}

/** Finite-iteration no-regret solution of the empirical zero-sum game. */
export function solveApproximateZeroSumLeague(
    entrantIds: readonly string[],
    payoffs: readonly (readonly number[])[],
    iterations: number = 50_000,
    learningRate?: number,
): IApproximateZeroSumSolution {
    const size = entrantIds.length;
    if (!size || payoffs.length !== size || payoffs.some((row) => row.length !== size)) {
        throw new RangeError("Payoff matrix dimensions must match the entrant ids");
    }
    if (!payoffs.every((row) => row.every((payoff) => Number.isFinite(payoff) && Math.abs(payoff) <= 1 + 1e-12))) {
        throw new RangeError("Zero-sum payoffs must be finite and in [-1, 1]");
    }
    for (let row = 0; row < size; row += 1) {
        if (Math.abs(payoffs[row][row]) > 1e-12) throw new Error("Zero-sum payoff diagonal must be zero");
        for (let column = row + 1; column < size; column += 1) {
            if (Math.abs(payoffs[row][column] + payoffs[column][row]) > 1e-10) {
                throw new Error("League payoff matrix must be antisymmetric");
            }
        }
    }
    if (!Number.isInteger(iterations) || iterations < 1) throw new RangeError("iterations must be positive");
    const eta = learningRate ?? (size === 1 ? 0 : Math.sqrt((2 * Math.log(size)) / iterations));
    if (!Number.isFinite(eta) || eta < 0) throw new RangeError("learningRate must be finite and non-negative");

    const rowLogWeights = new Array<number>(size).fill(0);
    const columnLogWeights = new Array<number>(size).fill(0);
    const averageRow = new Array<number>(size).fill(0);
    const averageColumn = new Array<number>(size).fill(0);
    let cumulativePlayPayoff = 0;
    for (let iteration = 0; iteration < iterations; iteration += 1) {
        const rowStrategy = distribution(rowLogWeights);
        const columnStrategy = distribution(columnLogWeights);
        const rowValues = matrixVector(payoffs, columnStrategy);
        const columnValues = rowMatrix(rowStrategy, payoffs);
        cumulativePlayPayoff += rowStrategy.reduce((sum, weight, row) => sum + weight * rowValues[row], 0);
        for (let index = 0; index < size; index += 1) {
            averageRow[index] += rowStrategy[index] / iterations;
            averageColumn[index] += columnStrategy[index] / iterations;
            rowLogWeights[index] += eta * rowValues[index];
            columnLogWeights[index] -= eta * columnValues[index];
        }
        if (iteration % 1024 === 1023) {
            const rowMaximum = Math.max(...rowLogWeights);
            const columnMaximum = Math.max(...columnLogWeights);
            for (let index = 0; index < size; index += 1) {
                rowLogWeights[index] -= rowMaximum;
                columnLogWeights[index] -= columnMaximum;
            }
        }
    }

    const lowerValueBound = Math.min(...rowMatrix(averageRow, payoffs));
    const upperValueBound = Math.max(...matrixVector(payoffs, averageColumn));
    const averagePlayPayoff = cumulativePlayPayoff / iterations;
    const symmetricWeights = averageRow.map((weight, index) => (weight + averageColumn[index]) / 2);
    const symmetricExploitability = Math.max(0, ...matrixVector(payoffs, symmetricWeights));
    return {
        method: "simultaneous_multiplicative_weights",
        iterations,
        learningRate: eta,
        rowMixture: mixture(entrantIds, averageRow),
        adversarialMixture: mixture(entrantIds, averageColumn),
        symmetricMixture: mixture(entrantIds, symmetricWeights),
        lowerValueBound,
        upperValueBound,
        midpointValue: (lowerValueBound + upperValueBound) / 2,
        dualityGap: Math.max(0, upperValueBound - lowerValueBound),
        symmetricExploitability,
        averagePlayPayoff,
        rowExternalRegret: Math.max(0, upperValueBound - averagePlayPayoff),
        adversaryExternalRegret: Math.max(0, averagePlayPayoff - lowerValueBound),
    };
}
