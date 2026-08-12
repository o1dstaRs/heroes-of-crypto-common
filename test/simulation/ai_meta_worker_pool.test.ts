import { expect, it } from "bun:test";

import type { IAiMetaRunOptions } from "../../src/simulation/ai_meta_cohorts_core";
import { resolveAiMetaFightProfile, runAiMetaWorkerPool } from "../../src/simulation/measure_ai_meta_cohorts";

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
