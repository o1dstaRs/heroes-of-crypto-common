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

import { afterEach, describe, expect, it } from "bun:test";

import { DEFAULT_V06_W, meleeDimsOverlay, StrategyV0_6 } from "../../src/ai/versions/v0_6";
import { StrategyV0_7 } from "../../src/ai/versions/v0_7";
import { StrategyV0_7S } from "../../src/ai/versions/v0_7s";

/** Test-only access to the protected weight vector / overlay hook. */
interface IWeightPeek {
    w: number[];
    applyMeleeDims(): void;
}

const peek = (strategy: object): IWeightPeek => strategy as unknown as IWeightPeek;

afterEach(() => {
    delete process.env.V06_MELEE_DIMS;
    delete process.env.V06_MELEE_DIMS_VERSIONS;
    delete process.env.V06_WEIGHTS;
});

describe("V06_MELEE_DIMS overlay (W16 gap-#1, env-gated default-OFF)", () => {
    it("is OFF by default: unset env yields no overlay and a byte-identical vector", () => {
        expect(meleeDimsOverlay("v0.6")).toBeUndefined();
        expect(meleeDimsOverlay("v0.7")).toBeUndefined();
        const strategy = new StrategyV0_6();
        peek(strategy).applyMeleeDims();
        expect(peek(strategy).w).toEqual([...DEFAULT_V06_W]);
        expect(peek(strategy).w[56]).toBe(0);
        expect(peek(strategy).w[57]).toBe(0);
    });

    it("parses V06_MELEE_DIMS and fails closed on malformed input", () => {
        process.env.V06_MELEE_DIMS = "1.25,-0.5";
        expect(meleeDimsOverlay("v0.6")).toEqual([1.25, -0.5]);
        for (const malformed of ["", "1.25", "1,2,3", "a,b", "1,NaN", "1,"]) {
            process.env.V06_MELEE_DIMS = malformed;
            expect(meleeDimsOverlay("v0.6")).toBeUndefined();
        }
    });

    it("scopes by strategy version when V06_MELEE_DIMS_VERSIONS is set, and applies to all when unset", () => {
        process.env.V06_MELEE_DIMS = "2,1";
        expect(meleeDimsOverlay("v0.6")).toEqual([2, 1]);
        expect(meleeDimsOverlay("v0.7s")).toEqual([2, 1]);
        process.env.V06_MELEE_DIMS_VERSIONS = "v0.7s";
        expect(meleeDimsOverlay("v0.6")).toBeUndefined();
        expect(meleeDimsOverlay("v0.7")).toBeUndefined();
        expect(meleeDimsOverlay("v0.7s")).toEqual([2, 1]);
        process.env.V06_MELEE_DIMS_VERSIONS = "v0.7, v0.7s";
        expect(meleeDimsOverlay("v0.7")).toEqual([2, 1]);
    });

    it("writes the dims onto the instance vector only for in-scope seats (the mirror A/B contract)", () => {
        process.env.V06_MELEE_DIMS = "1.5,0.75";
        process.env.V06_MELEE_DIMS_VERSIONS = "v0.7s";
        const scoped = new StrategyV0_7S();
        const unscoped = new StrategyV0_7();
        peek(scoped).applyMeleeDims();
        peek(unscoped).applyMeleeDims();
        expect(peek(scoped).w[56]).toBe(1.5);
        expect(peek(scoped).w[57]).toBe(0.75);
        expect(peek(unscoped).w[56]).toBe(0);
        expect(peek(unscoped).w[57]).toBe(0);
        // Every other dim stays untouched on both seats.
        expect(peek(scoped).w.slice(0, 56)).toEqual([...DEFAULT_V06_W].slice(0, 56));
        expect(peek(unscoped).w).toEqual([...DEFAULT_V06_W]);
    });

    it("restores the as-loaded values when the gate turns off (no state leak across toggles)", () => {
        // The pristine anchor is whatever the vector was constructed with — incl. a V06_WEIGHTS candidate
        // whose dims [56..57] are nonzero (the CEM training path must never be clobbered by the overlay).
        const candidate = [...DEFAULT_V06_W];
        candidate[56] = 0.33;
        candidate[57] = -0.25;
        process.env.V06_WEIGHTS = JSON.stringify(candidate);
        const strategy = new StrategyV0_6();
        process.env.V06_MELEE_DIMS = "4,4";
        peek(strategy).applyMeleeDims();
        expect(peek(strategy).w[56]).toBe(4);
        expect(peek(strategy).w[57]).toBe(4);
        delete process.env.V06_MELEE_DIMS;
        peek(strategy).applyMeleeDims();
        expect(peek(strategy).w[56]).toBe(0.33);
        expect(peek(strategy).w[57]).toBe(-0.25);
    });
});
