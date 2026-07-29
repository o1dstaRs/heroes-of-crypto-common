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

import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";

import type { IV09GameRow } from "./protocol";
import { validateV09GameShard } from "./recorder";

export interface IV09ActorShardNameValidation {
    files: readonly string[];
    seeds: readonly number[];
    expected: number;
    purpose: string;
    binding: string;
}

export interface IV09ActorShardValidationError {
    name: string;
    message: string;
}

export type V09ActorShardValidationResult =
    | {
          index: number;
          ok: true;
          footer: IV09GameRow;
      }
    | {
          index: number;
          ok: false;
          error: IV09ActorShardValidationError;
      };

export interface IV09ActorShardValidationWorkerData {
    tasks: ReadonlyArray<{ index: number; path: string }>;
}

const V09_ACTOR_VALIDATION_WORKERS = 8;
const V09_ACTOR_PARALLEL_VALIDATION_MIN_SHARDS = 64;

/**
 * Prove exact actor shard-name coverage and return the canonical seed-lane order used for footer validation.
 *
 * Directory enumeration order is intentionally ignored. A Set keeps the coverage proof linear in the number of
 * shards; the former `files.includes(file)` loop compared up to every directory entry for every seed lane.
 */
export function validateV09ActorShardNames({
    files,
    seeds,
    expected,
    purpose,
    binding,
}: IV09ActorShardNameValidation): string[] {
    if (files.length !== expected) {
        throw new Error(`${purpose}/${binding} has ${files.length} complete shards; expected ${expected}`);
    }

    const fileSet = new Set(files);
    const orderedFiles: string[] = [];
    for (let index = 0; index < expected; index += 1) {
        const file = `${String(index).padStart(6, "0")}-${seeds[index]}.jsonl`;
        if (!fileSet.has(file)) {
            throw new Error(`${purpose}/${binding} is missing exact seed lane ${index}`);
        }
        orderedFiles.push(file);
    }
    return orderedFiles;
}

function validationFailure(error: unknown): IV09ActorShardValidationError {
    return error instanceof Error
        ? { name: error.name, message: error.message }
        : { name: "Error", message: String(error) };
}

function validateShard(index: number, path: string): V09ActorShardValidationResult {
    try {
        return { index, ok: true, footer: validateV09GameShard(path) };
    } catch (error) {
        return { index, ok: false, error: validationFailure(error) };
    }
}

function actorValidationWorkerUrl(): URL {
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    return new URL(`./actor_output_validation_worker.${extension}`, import.meta.url);
}

function runValidationWorker(
    tasks: IV09ActorShardValidationWorkerData["tasks"],
): Promise<V09ActorShardValidationResult[]> {
    const worker = new Worker(actorValidationWorkerUrl(), {
        workerData: { tasks } satisfies IV09ActorShardValidationWorkerData,
    });
    return new Promise((accept, reject) => {
        let results: V09ActorShardValidationResult[] | undefined;
        let workerError: Error | undefined;
        worker.once("message", (message: V09ActorShardValidationResult[]) => {
            results = message;
        });
        worker.once("error", (error) => {
            workerError = error;
        });
        worker.once("exit", (code) => {
            if (workerError) {
                reject(workerError);
            } else if (code !== 0) {
                reject(new Error(`v0.9 actor shard validation worker exited with code ${code}`));
            } else if (!results) {
                reject(new Error("v0.9 actor shard validation worker exited without results"));
            } else {
                accept(results);
            }
        });
    });
}

/**
 * Fully validate shard contents in deterministic seed-lane order.
 *
 * Large corpora use bounded worker threads for the independent read/parse/hash work. Results are assembled by
 * canonical index and callers still perform each footer/provenance check in that order, preserving the original
 * lowest-index failure semantics. Small smoke corpora stay synchronous to avoid worker startup overhead.
 */
export async function validateV09ActorGameShards(
    orderedPaths: readonly string[],
    maximumWorkers = Math.min(V09_ACTOR_VALIDATION_WORKERS, availableParallelism()),
): Promise<V09ActorShardValidationResult[]> {
    if (!Number.isSafeInteger(maximumWorkers) || maximumWorkers < 1) {
        throw new Error("v0.9 actor shard validation workers must be a positive integer");
    }
    if (orderedPaths.length < V09_ACTOR_PARALLEL_VALIDATION_MIN_SHARDS || maximumWorkers === 1) {
        return orderedPaths.map((path, index) => validateShard(index, path));
    }

    const workerCount = Math.min(
        maximumWorkers,
        V09_ACTOR_VALIDATION_WORKERS,
        availableParallelism(),
        orderedPaths.length,
    );
    const launches: Array<Promise<V09ActorShardValidationResult[]>> = [];
    for (let workerIndex = 0; workerIndex < workerCount; workerIndex += 1) {
        const start = Math.floor((orderedPaths.length * workerIndex) / workerCount);
        const end = Math.floor((orderedPaths.length * (workerIndex + 1)) / workerCount);
        const tasks = orderedPaths.slice(start, end).map((path, offset) => ({
            index: start + offset,
            path,
        }));
        launches.push(runValidationWorker(tasks));
    }

    const orderedResults: Array<V09ActorShardValidationResult | undefined> = Array(orderedPaths.length);
    for (const workerResults of await Promise.all(launches)) {
        for (const result of workerResults) {
            if (
                !Number.isSafeInteger(result.index) ||
                result.index < 0 ||
                result.index >= orderedResults.length ||
                orderedResults[result.index] !== undefined
            ) {
                throw new Error("v0.9 actor shard validation worker returned an invalid seed lane");
            }
            orderedResults[result.index] = result;
        }
    }
    if (orderedResults.some((result) => result === undefined)) {
        throw new Error("v0.9 actor shard validation workers returned incomplete seed-lane coverage");
    }
    return orderedResults as V09ActorShardValidationResult[];
}

export function v09ActorShardValidationError(result: Extract<V09ActorShardValidationResult, { ok: false }>): Error {
    const error = new Error(result.error.message);
    error.name = result.error.name;
    return error;
}
