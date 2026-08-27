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

import { afterEach, expect, test } from "bun:test";

import { PersistentWorkerPool } from "../../src/simulation/persistent_worker_pool";
import type { IProtocolFixtureRequest } from "./persistent_worker_pool_protocol_worker";
import type { IPoolFixtureRequest, IPoolFixtureResult } from "./persistent_worker_pool_worker";

const pools: { terminate: () => Promise<void> }[] = [];

const pool = (
    concurrency = 1,
    maxQueuedTasks = concurrency,
): PersistentWorkerPool<IPoolFixtureRequest, IPoolFixtureResult> => {
    const instance = new PersistentWorkerPool<IPoolFixtureRequest, IPoolFixtureResult>({
        concurrency,
        maxQueuedTasks,
        workerUrl: new URL("./persistent_worker_pool_worker.ts", import.meta.url),
    });
    pools.push(instance);
    return instance;
};

afterEach(async () => {
    await Promise.all(pools.splice(0).map((instance) => instance.terminate()));
});

test("reuses the same initialized worker across consecutive batches", async () => {
    const instance = pool();

    const first = await instance.runBatch([{ value: 1 }, { value: 2 }]);
    const second = await instance.runBatch([{ value: 3 }]);

    expect(first.map((result) => result.value)).toEqual([1, 2]);
    expect(first.map((result) => result.calls)).toEqual([1, 2]);
    expect(second[0].calls).toBe(3);
    expect(new Set([...first, ...second].map((result) => result.processId)).size).toBe(1);
    expect(new Set([...first, ...second].map((result) => result.threadId)).size).toBe(1);
    expect(new Set([...first, ...second].map((result) => result.initializationToken)).size).toBe(1);

    await instance.close();
    expect(instance.workerCount).toBe(0);
    await expect(instance.run({ value: 4 })).rejects.toThrow("closing");
});

test("honors its worker and waiting-queue bounds while preserving result order", async () => {
    const instance = pool(2, 1);
    const results = await instance.runBatch(Array.from({ length: 8 }, (_, value) => ({ value, delayMs: 10 })));

    expect(results.map((result) => result.value)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(new Set(results.map((result) => result.threadId)).size).toBe(2);
    expect(instance.workerCount).toBe(2);
    expect(instance.maxQueuedTasks).toBe(1);
});

test("rejects direct submissions beyond the bounded waiting queue", async () => {
    const instance = pool(1, 1);
    const accepted = instance.run({ value: 1, delayMs: 10 });
    await expect(instance.run({ value: 2 })).rejects.toThrow("queue is full (1)");
    expect((await accepted).value).toBe(1);
});

test("fails a batch immediately without discarding the reusable worker", async () => {
    const instance = pool();
    await expect(instance.runBatch([{ value: 1 }, { value: 2, fail: true }, { value: 3 }])).rejects.toThrow(
        "fixture failure 2",
    );

    const recovered = await instance.runBatch([{ value: 4 }]);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].calls).toBe(3);
});

test("respawns after a worker crash and settles already-queued work", async () => {
    const instance = pool(1, 2);
    const crashed = instance.run({ value: 1, crash: true });
    const queued = instance.run({ value: 2 });

    await expect(crashed).rejects.toThrow("exited 17");
    const recovered = await queued;
    expect(recovered.value).toBe(2);
    expect(recovered.calls).toBe(1);
    expect(instance.workerCount).toBe(1);

    await instance.close();
    expect(instance.workerCount).toBe(0);
});

test("replaces a worker after a protocol violation and drains queued work", async () => {
    const instance = new PersistentWorkerPool<IProtocolFixtureRequest, number>({
        concurrency: 1,
        maxQueuedTasks: 2,
        workerUrl: new URL("./persistent_worker_pool_protocol_worker.ts", import.meta.url),
    });
    pools.push(instance);
    const malformed = instance.run({ value: 1, wrongTaskId: true });
    const queued = instance.run({ value: 2 });

    await expect(malformed).rejects.toThrow("unexpected task");
    expect(await queued).toBe(2);

    await instance.close();
    expect(instance.workerCount).toBe(0);
});

test("fails queued work deterministically when a worker cannot initialize", async () => {
    const instance = new PersistentWorkerPool<number, number>({
        concurrency: 1,
        workerUrl: new URL("./persistent_worker_pool_startup_failure_worker.ts", import.meta.url),
    });
    pools.push(instance);

    await expect(instance.run(1)).rejects.toThrow("fixture startup failure");
    expect(instance.workerCount).toBe(0);
    await instance.close();
});
