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

/**
 * The worker assignment is intentionally independent from the immutable game schedule. A game keeps its
 * original seed/index, cohort, map, trajectory pattern, id, and shard filename; only the worker that computes
 * it changes.
 *
 * The legacy `workerIndex + n * workers` lanes permanently coupled workers to index residues. With 20
 * workers, that meant one DAgger pattern and only three of the twelve teacher cohorts per worker. Rotating
 * ownership by one lane after every complete worker round preserves exact one-game-per-worker load balance
 * while exposing every long-running worker to the complete schedule.
 *
 * Round zero deliberately matches the legacy assignment. Consequently, `--limit 1` smoke runs still produce
 * the contiguous shard prefix `0..min(workers, games)-1`.
 */
export const V09_TEACHER_WORK_ASSIGNMENT = "rotating-round-robin-v1" as const;

function validateWorkerCount(workers: number): void {
    if (!Number.isSafeInteger(workers) || workers < 1) {
        throw new RangeError("v0.9 teacher workers must be a positive safe integer");
    }
}

function validateGameIndex(index: number): void {
    if (!Number.isSafeInteger(index) || index < 0) {
        throw new RangeError("v0.9 teacher game index must be a non-negative safe integer");
    }
}

function addModulo(left: number, right: number, modulus: number): number {
    const wrapAt = modulus - right;
    return left >= wrapAt ? left - wrapAt : left + right;
}

/** Return the deterministic worker owner for one immutable game index. */
export function v09TeacherWorkerForIndex(index: number, workers: number): number {
    validateGameIndex(index);
    validateWorkerCount(workers);
    const round = Math.floor(index / workers);
    const slot = index % workers;
    return addModulo(slot, round % workers, workers);
}

/**
 * Iterate one worker's immutable game indices in ascending order.
 *
 * Scanning the seed ledger is negligible next to teacher search and avoids materializing a second schedule
 * whose ordering could diverge from the ledger. It also makes resume behavior straightforward: the actor
 * validates or creates the exact same shard path for every yielded index.
 */
export function* v09TeacherWorkerIndices(
    totalGames: number,
    workerIndex: number,
    workers: number,
): Generator<number, void> {
    if (!Number.isSafeInteger(totalGames) || totalGames < 0) {
        throw new RangeError("v0.9 teacher game count must be a non-negative safe integer");
    }
    validateWorkerCount(workers);
    if (!Number.isSafeInteger(workerIndex) || workerIndex < 0 || workerIndex >= workers) {
        throw new RangeError("v0.9 teacher worker index is outside the worker pool");
    }
    for (let index = 0; index < totalGames; index += 1) {
        if (v09TeacherWorkerForIndex(index, workers) === workerIndex) yield index;
    }
}
