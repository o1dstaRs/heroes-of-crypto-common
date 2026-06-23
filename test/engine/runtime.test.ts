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

import { describe, expect, it } from "bun:test";

import { createDefaultGameRuntime, createSequenceGameRuntime, shuffleWithRng } from "../../src/engine/runtime";

describe("game runtime", () => {
    it("creates a secure default runtime for randoms, time, and ids", () => {
        const runtime = createDefaultGameRuntime();

        expect(runtime.rng.int(5, 5)).toBe(5);
        expect(runtime.clock.nowMillis()).toBeGreaterThanOrEqual(0);
        expect(runtime.ids.nextId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it("replays queued deterministic values and shuffles with injected randoms", () => {
        const runtime = createSequenceGameRuntime({
            ints: [7, 1, 0],
            nowMillis: [100, 200],
            ids: ["first-id"],
            defaultNowMillis: 300,
        });

        expect(runtime.rng.int(0, 10)).toBe(7);
        expect(runtime.clock.nowMillis()).toBe(100);
        expect(runtime.clock.nowMillis()).toBe(200);
        expect(runtime.clock.nowMillis()).toBe(300);
        expect(runtime.ids.nextId()).toBe("first-id");
        expect(shuffleWithRng(["a", "b", "c"], runtime.rng)).toEqual(["c", "a", "b"]);
    });

    it("fails fast when deterministic queues are exhausted or invalid", () => {
        expect(() => createSequenceGameRuntime({}).rng.int(0, 1)).toThrow("No deterministic random integer queued");
        expect(() => createSequenceGameRuntime({ ints: [2] }).rng.int(0, 2)).toThrow(
            "Queued random integer 2 is outside [0, 2)",
        );
        expect(() => createSequenceGameRuntime({ ids: [] }).ids.nextId()).toThrow("No deterministic id queued");
    });
});
