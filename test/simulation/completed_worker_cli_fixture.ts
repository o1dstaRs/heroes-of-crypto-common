import { writeFileSync } from "node:fs";

import { exitCompletedWorkerCli } from "../../src/simulation/completed_worker_cli";
import { PersistentWorkerPool } from "../../src/simulation/persistent_worker_pool";
import type { IPoolFixtureRequest, IPoolFixtureResult } from "./persistent_worker_pool_worker";

const pool = new PersistentWorkerPool<IPoolFixtureRequest, IPoolFixtureResult>({
    concurrency: 2,
    workerUrl: new URL("./persistent_worker_pool_worker.ts", import.meta.url),
});

async function main(): Promise<void> {
    try {
        const results = await pool.runBatch(
            Array.from({ length: 8 }, (_, value) => ({
                value,
                delayMs: 5 + value,
                fail: process.argv[3] === "task-error" && value === 3,
            })),
        );
        const output = process.argv[3] === "write-error" ? `${process.argv[2]}/missing.json` : process.argv[2]!;
        writeFileSync(output, JSON.stringify(results));
        process.stdout.write("o".repeat(1024 * 1024) + "\ncomplete\n");
        process.stderr.write("e".repeat(1024 * 1024) + "\nreceipt\n");
        await exitCompletedWorkerCli();
    } finally {
        await pool.close();
    }
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
