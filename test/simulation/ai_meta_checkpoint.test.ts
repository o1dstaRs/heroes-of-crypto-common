import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiMetaPairCheckpoints, openAiMetaRun } from "../../src/simulation/ai_meta_checkpoint";
import { prepareMetaPair, type IAiMetaPairRecord } from "../../src/simulation/ai_meta_cohorts_core";
import { resolveAiMetaFightProfile, runAiMetaWorkerPool } from "../../src/simulation/measure_ai_meta_cohorts";

test("fixed checkpoints survive interruption, preserve exact records, and reject changed inputs and corruption", () => {
    const dir = mkdtempSync(join(tmpdir(), "meta-checkpoint-"));
    const options = { cohort: "uniform-mixed" as const, games: 6, baseSeed: 381701 };
    try {
        const first = openAiMetaRun(dir, { options, source: "fixture" }, false);
        expect(() => openAiMetaRun(dir, { options, source: "fixture" }, true)).toThrow("active");
        const record = {
            ...prepareMetaPair(options, 1),
            games: [
                { aIsGreen: true, winner: "a" },
                { aIsGreen: false, winner: "b" },
            ],
        } as IAiMetaPairRecord;
        new AiMetaPairCheckpoints(dir, first.registration.identitySha256, options).save(record);
        first.close();
        expect(() => openAiMetaRun(dir, { options, source: "changed" }, true)).toThrow("changed");
        const resumed = openAiMetaRun(dir, { options, source: "fixture" }, true);
        const store = new AiMetaPairCheckpoints(dir, resumed.registration.identitySha256, options);
        expect(store.read(0)).toBeUndefined();
        expect(store.read(1)).toEqual(record);
        store.save(record);
        expect(() => store.save({ ...record, map: 4 })).toThrow("overwrite");
        const path = join(dir, "pairs/uniform-mixed/1.json.gz");
        const bytes = readFileSync(path);
        bytes[25] ^= 255;
        writeFileSync(path, bytes);
        expect(() => store.read(1)).toThrow();
        resumed.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("only missing original indexes run, and the pool waits for durable asynchronous output", async () => {
    const seen: number[] = [];
    let writes = 0;
    const options = { cohort: "uniform-mixed" as const, games: 12, baseSeed: 381701 };
    const result = await runAiMetaWorkerPool(
        options,
        2,
        resolveAiMetaFightProfile("a13"),
        async (record) => {
            await new Promise<void>((resolve) => setTimeout(resolve, record.pair === 2 ? 15 : 1));
            seen.push(record.pair);
            writes++;
        },
        { pairIndexes: [2, 5], workerUrl: new URL("../fixtures/ai_meta_worker_pool_fixture.ts", import.meta.url) },
    );
    expect(seen.sort()).toEqual([2, 5]);
    expect(writes).toBe(2);
    expect(result.workersStarted).toBe(2);
    expect(
        await runAiMetaWorkerPool(
            options,
            2,
            resolveAiMetaFightProfile("a13"),
            () => {
                throw Error("No work");
            },
            { pairIndexes: [] },
        ),
    ).toEqual({ workersStarted: 0, workersRecycled: 0 });
    expect(
        runAiMetaWorkerPool(options, 1, resolveAiMetaFightProfile("a13"), () => {}, { pairIndexes: [2, 2] }),
    ).rejects.toThrow("duplicate");
});
