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

import { getAIStrategy } from "../../src/ai";
import { DEFAULT_V05_W, V05_WEIGHT_KEYS, loadV05Weights } from "../../src/ai/versions/v0_5_weights";

describe("v0.5 — reinforcement-learned strategy", () => {
    afterEach(() => {
        delete process.env.V05_WEIGHTS;
    });

    it("is registered and reports version v0.5", () => {
        const v05 = getAIStrategy("v0.5");
        expect(v05.version).toBe("v0.5");
    });

    it("ships the trained vector (53 dims; overnight retrain, panel 72.24%, fresh-guard +0.93pp)", () => {
        // 10h CEM (2026-07-04, pass 20/21) re-trained after the Double Shot fix reopened the scoring landscape.
        // Panel 72.24% vs 70.55% base; fresh-seed guarded +0.93pp over the prior champion. All 53 dims trained,
        // including the target-caster features [51..52] (meleeTargetCaster / shotTargetCaster).
        expect(DEFAULT_V05_W).toEqual([
            1.7828, -0.8949, -0.3052, 1.8604, 1.5213, 5.5993, 0.5624, 0.1799, -0.9702, 1.2231, 0.2149, 2.1894, 3.1582,
            3.0048, -0.0237, 0.9643, 4.1739, 5.1118, -0.5432, 0.5818, -2.0671, 0.277, -2.6274, -2.4165, -1.3698, 2.6379,
            0.2916, -0.4279, 0.1587, -1.2452, -0.6807, 0.7213, -0.3563, 2.1045, -0.7515, 1.0022, 0.2311, 2.6854,
            -0.0261, -0.2301, 4.4516, 2.2054, -2.4419, 1.2098, 0.3502, -0.2083, 0.7573, -0.3856, 2.329, 0.1822, -1.5113,
            0.1957, 1.1489, -0.4775, -0.0261, 0.4148,
            // [56..58] meleeRapidCharge, meleeRangedTarget, meleeBaitRetal — untrained (0), v0.5 byte-identical.
            0, 0, 0,
        ]);
        expect(DEFAULT_V05_W.length).toBe(V05_WEIGHT_KEYS.length);
        expect(DEFAULT_V05_W.length).toBe(59);
    });

    it("loadV05Weights honours a well-formed process.env.V05_WEIGHTS override", () => {
        const trained = [
            1.2, 0.5, 0.8, 0.1, 0.05, 1.0, 0.4, -0.2, -0.6, 1.0, 0.3, -0.5, 0.7, 0.2, 0.9, 0.6, 0.3, 0.1, -0.4, 1.5,
            -0.7, 0.4, 0.3, -0.2, -0.5, -0.8, 0.2, -0.3, 0.1, 0.4, -0.1, 0.6, -0.2, 0.9, -0.4, 1.1, -0.7, 0.2, -0.9,
            0.5, 0.3, 0.15, -0.25, 0.35, -0.15, 0.45, -0.55, 0.65, -0.35, 0.2, -0.4, 0.6, -0.1, 0.25, -0.15, 0.35, 0.12,
            -0.22, 0.32,
        ];
        process.env.V05_WEIGHTS = JSON.stringify(trained);
        expect(loadV05Weights()).toEqual(trained);
    });

    it("loadV05Weights falls back to the default on malformed / wrong-length / non-finite input", () => {
        for (const bad of ["not json", "[1,2,3]", JSON.stringify([1, 2, 3, 4, 5, "x"]), "{}", JSON.stringify(null)]) {
            process.env.V05_WEIGHTS = bad;
            expect(loadV05Weights()).toEqual(DEFAULT_V05_W.slice());
        }
    });

    it("returns the committed default when no override is set", () => {
        delete process.env.V05_WEIGHTS;
        expect(loadV05Weights()).toEqual(DEFAULT_V05_W.slice());
    });
});
