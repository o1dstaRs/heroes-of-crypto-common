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
import { resolve } from "node:path";

export const MAX_TEST_WORKERS = 12;
export const MAX_CI_TEST_WORKERS = 2;
export const DEFAULT_TEST_TIMINGS_PATH = resolve(import.meta.dir, "test_timings.json");

/** Let Bun start the historically slow files first while still allowing callers to benchmark another profile. */
export function defaultTestTimingArgs(args: readonly string[]): string[] {
    const hasExplicitTimings = args.some((arg) => arg === "--timings" || arg.startsWith("--timings="));
    return hasExplicitTimings ? [] : ["--timings", DEFAULT_TEST_TIMINGS_PATH];
}

export function testWorkerCount(availableWorkers: number, isCi = false): number {
    if (!Number.isSafeInteger(availableWorkers) || availableWorkers < 1) {
        throw new Error(`Available test workers must be a positive safe integer; got ${availableWorkers}`);
    }
    // Several simulation files spawn their own Bun processes. Four-way file parallelism on GitHub's
    // four-core runner therefore oversubscribes the machine and intermittently starves those children
    // until their 30s/120s watchdogs fire. Two files at a time keeps those watchdogs meaningful while
    // local development still uses every performance core up to the workstation cap.
    return Math.min(isCi ? MAX_CI_TEST_WORKERS : MAX_TEST_WORKERS, availableWorkers);
}

if (import.meta.main) {
    const repositoryRoot = resolve(import.meta.dir, "..");
    const workers = testWorkerCount(availableParallelism(), process.env.CI === "true");
    const forwardedArgs = process.argv.slice(2);
    const result = Bun.spawnSync({
        cmd: [
            process.execPath,
            "test",
            `--parallel=${workers}`,
            "--timeout",
            "90000",
            "--reporter=dots",
            ...defaultTestTimingArgs(forwardedArgs),
            ...forwardedArgs,
        ],
        cwd: repositoryRoot,
        env: { ...process.env },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
    });
    process.exit(result.exitCode);
}
