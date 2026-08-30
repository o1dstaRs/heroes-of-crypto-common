import { expect, it } from "bun:test";

import type { IAiMetaRunOptions } from "../../src/simulation/ai_meta_cohorts_core";
import type { IAiMetaProcessTask } from "../../src/simulation/ai_meta_cohorts_process_protocol";
import {
    resolveAiMetaFightProfile,
    runAiMetaProcessPool,
    runAiMetaWorkerPool,
} from "../../src/simulation/measure_ai_meta_cohorts";

const options: IAiMetaRunOptions = {
    cohort: "ranked-draft",
    games: 4,
    baseSeed: 85_000_717,
};

it("recycles long-lived AI-meta workers without losing pair records", async () => {
    const pairs: number[] = [];
    const totals: number[] = [];
    let workerStarts = 0;
    const stats = await runAiMetaWorkerPool(
        options,
        1,
        resolveAiMetaFightProfile("a13"),
        (record, completed, total) => {
            pairs.push(record.pair);
            totals.push(completed === total ? total : 0);
        },
        {
            beforeWorkerStart: () => {
                workerStarts += 1;
            },
            recycleAfterPairs: 1,
            // Pool scheduling/recycling is the behavior under test. The real AI-meta worker already runs a
            // complete two-battle regression in ai_meta_cohorts.test.ts; repeating four full search battles
            // here hid a millisecond-scale lifecycle check behind several seconds of unrelated simulation.
            workerUrl: new URL("../fixtures/ai_meta_worker_pool_fixture.ts", import.meta.url),
        },
    );

    expect(pairs.sort((left, right) => left - right)).toEqual([0, 1]);
    expect(totals).toContain(2);
    expect(stats).toEqual({ workersStarted: 2, workersRecycled: 1 });
    expect(workerStarts).toBe(2);
}, 60_000);

it("dispatches a disjoint global pair window without renumbering seeds", async () => {
    const windowOptions: IAiMetaRunOptions = { ...options, games: 12 };
    const pairs: number[] = [];
    await runAiMetaWorkerPool(windowOptions, 2, resolveAiMetaFightProfile("a13"), (record) => pairs.push(record.pair), {
        pairStart: 2,
        pairCount: 3,
        workerUrl: new URL("../fixtures/ai_meta_worker_pool_fixture.ts", import.meta.url),
    });

    expect(pairs.sort((left, right) => left - right)).toEqual([2, 3, 4]);
}, 60_000);

it("recycles isolated AI-meta processes while preserving a global task queue", async () => {
    const tasks: IAiMetaProcessTask[] = Array.from({ length: 4 }, (_, pair) => ({
        options,
        pair,
        strategyProfileId: "registered-version",
    }));
    const pairs: number[] = [];
    const processIds = new Set<number>();
    let processStarts = 0;
    const stats = await runAiMetaProcessPool(
        tasks,
        1,
        resolveAiMetaFightProfile("a13"),
        (record) => {
            pairs.push(record.pair);
            processIds.add((record as typeof record & { processId: number }).processId);
        },
        {
            beforeProcessStart: () => {
                processStarts += 1;
            },
            recycleAfterPairs: 1,
            processUrl: new URL("../fixtures/ai_meta_process_pool_fixture.ts", import.meta.url),
        },
    );

    expect(pairs).toEqual([0, 1, 2, 3]);
    expect(processIds.size).toBe(4);
    expect(stats).toEqual({ workersStarted: 4, workersRecycled: 3 });
    expect(processStarts).toBe(4);
}, 60_000);
