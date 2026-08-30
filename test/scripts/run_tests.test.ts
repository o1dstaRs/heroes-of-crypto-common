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

import { describe, expect, test } from "bun:test";

import {
    DEFAULT_TEST_TIMINGS_PATH,
    MAX_CI_TEST_WORKERS,
    MAX_TEST_WORKERS,
    defaultTestTimingArgs,
    testWorkerCount,
} from "../../scripts/run_tests";

describe("common test worker selection", () => {
    test("uses the host capacity up to the performance-core cap", () => {
        expect(testWorkerCount(1)).toBe(1);
        expect(testWorkerCount(4)).toBe(4);
        expect(testWorkerCount(MAX_TEST_WORKERS)).toBe(MAX_TEST_WORKERS);
        expect(testWorkerCount(16)).toBe(MAX_TEST_WORKERS);
    });

    test("leaves capacity for child-process simulations on CI", () => {
        expect(testWorkerCount(1, true)).toBe(1);
        expect(testWorkerCount(4, true)).toBe(MAX_CI_TEST_WORKERS);
        expect(testWorkerCount(16, true)).toBe(MAX_CI_TEST_WORKERS);
    });

    test("uses the repository timing profile unless the caller supplies one", () => {
        expect(defaultTestTimingArgs([])).toEqual(["--timings", DEFAULT_TEST_TIMINGS_PATH]);
        expect(defaultTestTimingArgs(["--update-timings"])).toEqual(["--timings", DEFAULT_TEST_TIMINGS_PATH]);
        expect(defaultTestTimingArgs(["--timings", "/tmp/custom.json"])).toEqual([]);
        expect(defaultTestTimingArgs(["--timings=/tmp/custom.json"])).toEqual([]);
    });

    test("rejects invalid host capacity instead of silently disabling tests", () => {
        for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(() => testWorkerCount(invalid)).toThrow("Available test workers must be a positive safe integer");
        }
    });
});
