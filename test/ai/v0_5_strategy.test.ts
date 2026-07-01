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

    it("ships the long-run-trained vector (41 dims: 26 learned + 7 untrained mining + 8 untrained AOE; ~59.1% vs v0.4 fresh)", () => {
        // Concurrent CEM pass-8 best (8h, RNG-fixed sim): panel 59.44%, fresh held-out avg 59.12%
        // (59.7/59.7/58.1/58.9) — panel≈fresh, so robust not overfit; +0.5pp over the pass-7 bake and
        // +3.4pp over the original ~55.7%. Tail [26..32] is center-mountain mining and [33..40] is AOE-melee
        // positioning, both UNTRAINED (all 0) so v0.5 keeps v0.4's fixed heuristics until a frozen CEM retrain.
        expect(DEFAULT_V05_W).toEqual([
            1.0301, -0.2669, 0.2212, 0.7464, 4.1193, 5.3065, 0.4172, 0.536, -0.4642, 2.4397, -0.1963, 0.9927, 0.8947,
            1.7654, -0.0329, -0.5002, 2.9235, 2.5296, -0.4112, 1.0424, -1.5771, 0.9101, -0.7753, -2.7806, -1.5444,
            0.2624, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ]);
        expect(DEFAULT_V05_W.length).toBe(V05_WEIGHT_KEYS.length);
        expect(DEFAULT_V05_W.length).toBe(41);
    });

    it("loadV05Weights honours a well-formed process.env.V05_WEIGHTS override", () => {
        const trained = [
            1.2, 0.5, 0.8, 0.1, 0.05, 1.0, 0.4, -0.2, -0.6, 1.0, 0.3, -0.5, 0.7, 0.2, 0.9, 0.6, 0.3, 0.1, -0.4, 1.5,
            -0.7, 0.4, 0.3, -0.2, -0.5, -0.8, 0.2, -0.3, 0.1, 0.4, -0.1, 0.6, -0.2,
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
