/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import { LEAGUE_GENOME_DIM, LEAGUE_GENOME_LAYOUT } from "../league_genome";

export interface ILeagueCemScore {
    weights: number[];
    fitness: number;
    worstCase: number;
    softmin: number;
}

export interface ILeagueCemBest extends ILeagueCemScore {
    foundGeneration: number;
    selectionSeed: number;
    selectionPanelFingerprint: string;
}

const createGaussian = (seed: number): (() => number) => {
    let state = seed >>> 0 || 1;
    const random = (): number => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x100000000;
    };
    return () => {
        let u = 0;
        let v = 0;
        while (!u) u = random();
        while (!v) v = random();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
};

export const leagueCemDimensionIsTrainable = (dimension: number, freezePerk: boolean): boolean =>
    !freezePerk ||
    dimension < LEAGUE_GENOME_LAYOUT.perks.offset ||
    dimension >= LEAGUE_GENOME_LAYOUT.perks.offset + LEAGUE_GENOME_LAYOUT.perks.length;

export function createLeagueCemSigma(
    anchor: readonly number[],
    relativeSigma: number,
    zeroSigma: number,
    freezePerk: boolean,
): number[] {
    if (anchor.length !== LEAGUE_GENOME_DIM) throw new RangeError("League CEM anchor dimension mismatch");
    return anchor.map((coefficient, dimension) => {
        if (!leagueCemDimensionIsTrainable(dimension, freezePerk)) return 0;
        return coefficient === 0 ? zeroSigma : relativeSigma * (Math.abs(coefficient) + 0.5);
    });
}

export function sampleLeagueCemPopulation(
    mean: readonly number[],
    sigma: readonly number[],
    population: number,
    baseSeed: number,
    generation: number,
    freezePerk: boolean,
): number[][] {
    if (mean.length !== LEAGUE_GENOME_DIM || sigma.length !== LEAGUE_GENOME_DIM) {
        throw new RangeError("League CEM distribution dimension mismatch");
    }
    const gaussian = createGaussian((baseSeed + Math.imul(generation + 1, 0x9e3779b1)) >>> 0);
    const candidates: number[][] = [mean.slice()];
    for (let candidate = 1; candidate < population; candidate += 1) {
        candidates.push(
            mean.map((value, dimension) =>
                leagueCemDimensionIsTrainable(dimension, freezePerk) ? value + sigma[dimension] * gaussian() : value,
            ),
        );
    }
    return candidates;
}

export function refitLeagueCemDistribution(
    elite: readonly ILeagueCemScore[],
    mean: number[],
    sigma: number[],
    sigmaFloor: readonly number[],
    sigmaDecay: number,
    freezePerk: boolean,
): void {
    for (let dimension = 0; dimension < LEAGUE_GENOME_DIM; dimension += 1) {
        if (!leagueCemDimensionIsTrainable(dimension, freezePerk)) {
            sigma[dimension] = 0;
            continue;
        }
        const values = elite.map((candidate) => candidate.weights[dimension]);
        const average = values.reduce((sum, value) => sum + value, 0) / values.length;
        const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length;
        mean[dimension] = average;
        sigma[dimension] = Math.max(sigmaFloor[dimension], Math.sqrt(variance), sigma[dimension] * sigmaDecay);
    }
}

/** Candidates compared here must all have been scored on the same fully fingerprinted selection panel. */
export function retainComparableLeagueBest(
    current: ILeagueCemBest | undefined,
    contender: ILeagueCemScore,
    generation: number,
    selectionSeed: number,
    selectionPanelFingerprint: string,
): ILeagueCemBest {
    if (!selectionPanelFingerprint) throw new Error("League CEM selection panel fingerprint must not be empty");
    if (
        current &&
        (current.selectionSeed !== selectionSeed >>> 0 ||
            current.selectionPanelFingerprint !== selectionPanelFingerprint)
    ) {
        throw new Error("Cannot compare league CEM champions scored on different selection panels");
    }
    if (current && current.fitness >= contender.fitness) return current;
    return {
        ...contender,
        weights: [...contender.weights],
        foundGeneration: generation,
        selectionSeed: selectionSeed >>> 0,
        selectionPanelFingerprint,
    };
}
