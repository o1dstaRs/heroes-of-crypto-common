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

export const SIDE_CEM_STATE_SCHEMA_VERSION = 2;

export const JOINT_LEAF_DIMENSIONS = 61;
export const JOINT_WAIT_DIMENSIONS = 42;
export const JOINT_VECTOR_DIMENSIONS = JOINT_LEAF_DIMENSIONS + JOINT_WAIT_DIMENSIONS;

export type JointBlock = "all" | "leaf" | "wait";
export type JointBlockMode = JointBlock | "alternate";

export interface JointBlockOptions {
    mode: JointBlockMode;
    generationsPerBlock: number;
    firstBlock: Exclude<JointBlock, "all">;
}

export interface BinomialObservation {
    wins: number;
    decisive: number;
}

export interface RaceCandidate {
    index: number;
    observations: readonly BinomialObservation[];
}

export interface WilsonScore extends BinomialObservation {
    rate: number;
    lo: number;
    hi: number;
}

export interface RankedRaceCandidate<T extends RaceCandidate> {
    candidate: T;
    score: WilsonScore;
}

export interface DiagonalDistribution {
    mean: readonly number[];
    sigma: readonly number[];
}

export interface DiagonalRefitOptions {
    active: readonly boolean[];
    sigmaFloor: number;
    sigmaDecay: number;
    eliteVarianceAlpha: number;
}

function requireNonNegativeInteger(value: number, label: string): void {
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`${label} must be a non-negative integer, got ${value}`);
    }
}

/** Wilson score interval for a binomial result. A zero-sample candidate remains maximally uncertain. */
export function wilsonScore(wins: number, decisive: number, z = 1.96): WilsonScore {
    requireNonNegativeInteger(wins, "wins");
    requireNonNegativeInteger(decisive, "decisive");
    if (wins > decisive) {
        throw new Error(`wins (${wins}) cannot exceed decisive games (${decisive})`);
    }
    if (!Number.isFinite(z) || z < 0) {
        throw new Error(`z must be a finite non-negative number, got ${z}`);
    }
    if (decisive === 0) {
        return { wins, decisive, rate: 0, lo: 0, hi: 1 };
    }
    const rate = wins / decisive;
    const z2 = z * z;
    const denominator = 1 + z2 / decisive;
    const center = (rate + z2 / (2 * decisive)) / denominator;
    const radius = (z * Math.sqrt((rate * (1 - rate) + z2 / (4 * decisive)) / decisive)) / denominator;
    return {
        wins,
        decisive,
        rate,
        lo: Math.max(0, center - radius),
        hi: Math.min(1, center + radius),
    };
}

/** Pool independent panels by their decisive game counts; never average panel percentages. */
export function aggregateRaceObservations(observations: readonly BinomialObservation[], z = 1.96): WilsonScore {
    let wins = 0;
    let decisive = 0;
    for (const observation of observations) {
        requireNonNegativeInteger(observation.wins, "observation wins");
        requireNonNegativeInteger(observation.decisive, "observation decisive");
        if (observation.wins > observation.decisive) {
            throw new Error(
                `observation wins (${observation.wins}) cannot exceed decisive games (${observation.decisive})`,
            );
        }
        wins += observation.wins;
        decisive += observation.decisive;
    }
    return wilsonScore(wins, decisive, z);
}

/**
 * Deterministic confidence-bound ranking used at every successive-halving boundary.
 * Wilson lower bound is primary; empirical rate, sample count, then original population index break ties.
 */
export function rankRaceCandidates<T extends RaceCandidate>(
    candidates: readonly T[],
    z = 1.96,
): RankedRaceCandidate<T>[] {
    return candidates
        .map((candidate) => ({ candidate, score: aggregateRaceObservations(candidate.observations, z) }))
        .sort(
            (left, right) =>
                right.score.lo - left.score.lo ||
                right.score.rate - left.score.rate ||
                right.score.decisive - left.score.decisive ||
                left.candidate.index - right.candidate.index,
        );
}

/** Build one survivor target after every racing round except the final scoring round. */
export function buildRaceKeepSchedule(
    population: number,
    elite: number,
    rounds: number,
    requested: readonly number[] = [],
): number[] {
    requireNonNegativeInteger(population, "population");
    requireNonNegativeInteger(elite, "elite");
    requireNonNegativeInteger(rounds, "rounds");
    if (population < 1 || elite < 1 || elite > population) {
        throw new Error(`expected 1 <= elite (${elite}) <= population (${population})`);
    }
    if (rounds < 1) {
        throw new Error("racing needs at least one round");
    }
    if (requested.length > Math.max(0, rounds - 1)) {
        throw new Error(`CEM_RACE_KEEP has ${requested.length} entries for ${rounds} rounds`);
    }

    const schedule: number[] = [];
    let survivors = population;
    for (let round = 0; round < rounds - 1; round += 1) {
        const explicit = requested[round];
        const next = explicit ?? Math.max(elite, Math.ceil(survivors / 2));
        requireNonNegativeInteger(next, `round ${round} survivor target`);
        if (next < elite || next > survivors) {
            throw new Error(
                `round ${round} survivor target ${next} must be between elite ${elite} and prior survivors ${survivors}`,
            );
        }
        schedule.push(next);
        survivors = next;
    }
    return schedule;
}

export function parsePositiveIntegerList(raw: string | undefined, label: string): number[] {
    if (!raw?.trim()) return [];
    return raw.split(",").map((part, index) => {
        const value = Number(part.trim());
        if (!Number.isInteger(value) || value < 1) {
            throw new Error(`${label}[${index}] must be a positive integer, got ${part}`);
        }
        return value;
    });
}

export function parseJointBlockOptions(
    modeRaw: string | undefined,
    generationsRaw: string | undefined,
    firstRaw: string | undefined,
): JointBlockOptions {
    const mode = (modeRaw ?? "all") as JointBlockMode;
    if (!(["all", "alternate", "leaf", "wait"] as const).includes(mode)) {
        throw new Error(`CEM_JOINT_BLOCKS must be all, alternate, leaf, or wait; got ${mode}`);
    }
    const generationsPerBlock = Number(generationsRaw ?? 1);
    if (!Number.isInteger(generationsPerBlock) || generationsPerBlock < 1) {
        throw new Error(`CEM_JOINT_BLOCK_GENERATIONS must be a positive integer, got ${generationsRaw}`);
    }
    const firstBlock = (firstRaw ?? "leaf") as Exclude<JointBlock, "all">;
    if (firstBlock !== "leaf" && firstBlock !== "wait") {
        throw new Error(`CEM_JOINT_FIRST_BLOCK must be leaf or wait; got ${firstBlock}`);
    }
    return { mode, generationsPerBlock, firstBlock };
}

export function jointBlockForGeneration(options: JointBlockOptions, generation: number): JointBlock {
    requireNonNegativeInteger(generation, "generation");
    if (options.mode !== "alternate") return options.mode;
    const phase = Math.floor(generation / options.generationsPerBlock) % 2;
    if (phase === 0) return options.firstBlock;
    return options.firstBlock === "leaf" ? "wait" : "leaf";
}

/** Joint vector layout: leaf b+w occupy [0, 61), wait b+w occupy [61, 103). */
export function jointCoordinateIsActive(block: JointBlock, vectorIndex: number): boolean {
    requireNonNegativeInteger(vectorIndex, "joint vector index");
    if (vectorIndex >= JOINT_VECTOR_DIMENSIONS) {
        throw new Error(`joint vector index ${vectorIndex} exceeds ${JOINT_VECTOR_DIMENSIONS - 1}`);
    }
    if (block === "all") return true;
    return block === "leaf" ? vectorIndex < JOINT_LEAF_DIMENSIONS : vectorIndex >= JOINT_LEAF_DIMENSIONS;
}

/**
 * Refit a diagonal CEM distribution. Alpha zero is the legacy mean+decay update. Positive alpha
 * blends the observed elite variance with the decayed prior variance, while inactive coordinates
 * are copied exactly for separable/block optimization.
 */
export function refitDiagonalDistribution(
    distribution: DiagonalDistribution,
    elites: readonly (readonly number[])[],
    options: DiagonalRefitOptions,
): { mean: number[]; sigma: number[] } {
    const dimensions = distribution.mean.length;
    if (
        distribution.sigma.length !== dimensions ||
        options.active.length !== dimensions ||
        elites.length < 1 ||
        elites.some((elite) => elite.length !== dimensions)
    ) {
        throw new Error("diagonal CEM refit received inconsistent dimensions or no elites");
    }
    if (!Number.isFinite(options.sigmaFloor) || options.sigmaFloor < 0) {
        throw new Error(`sigmaFloor must be finite and non-negative, got ${options.sigmaFloor}`);
    }
    if (!Number.isFinite(options.sigmaDecay) || options.sigmaDecay < 0) {
        throw new Error(`sigmaDecay must be finite and non-negative, got ${options.sigmaDecay}`);
    }
    if (
        !Number.isFinite(options.eliteVarianceAlpha) ||
        options.eliteVarianceAlpha < 0 ||
        options.eliteVarianceAlpha > 1
    ) {
        throw new Error(`eliteVarianceAlpha must be in [0, 1], got ${options.eliteVarianceAlpha}`);
    }

    const mean = [...distribution.mean];
    const sigma = [...distribution.sigma];
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
        if (!options.active[dimension]) continue;
        const eliteMean = elites.reduce((sum, elite) => sum + elite[dimension], 0) / elites.length;
        const eliteVariance =
            elites.reduce((sum, elite) => sum + (elite[dimension] - eliteMean) ** 2, 0) / elites.length;
        const decayedSigma = distribution.sigma[dimension] * options.sigmaDecay;
        const blendedVariance =
            (1 - options.eliteVarianceAlpha) * decayedSigma ** 2 + options.eliteVarianceAlpha * eliteVariance;
        mean[dimension] = eliteMean;
        sigma[dimension] = Math.max(options.sigmaFloor, Math.sqrt(blendedVariance));
    }
    return { mean, sigma };
}
