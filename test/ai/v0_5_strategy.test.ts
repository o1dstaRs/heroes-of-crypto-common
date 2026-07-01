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

    it("ships the long-run-trained vector (26 dims, ~56.7% vs v0.4 on fresh seeds; all dims learned)", () => {
        // Concurrent CEM pass-6 best (8h, RNG-fixed sim): panel 57.31%, fresh held-out avg 56.74%
        // (56.4/57.5/56.1/57.0) — a robust +1.0pp over the prior ~55.7% vector. The former neutral anchors
        // ([22] support, [23] wounded, [24] posAdvanceFM, [25] meleeRetalCostFM) are now learned non-zero.
        expect(DEFAULT_V05_W).toEqual([
            0.9096, -0.3032, 0.1114, 0.3173, 3.6201, 4.6948, 1.0045, 0.1257, -0.5688, 2.3661, -0.0032, 1.4, 0.5115,
            1.1915, -0.0109, 0.4945, 3.5584, 1.6964, -0.4485, 1.7589, -1.9332, 0.9368, -0.7713, -1.8652, -1.5258,
            0.3406,
        ]);
        expect(DEFAULT_V05_W.length).toBe(V05_WEIGHT_KEYS.length);
        expect(DEFAULT_V05_W.length).toBe(26);
    });

    it("loadV05Weights honours a well-formed process.env.V05_WEIGHTS override", () => {
        const trained = [
            1.2, 0.5, 0.8, 0.1, 0.05, 1.0, 0.4, -0.2, -0.6, 1.0, 0.3, -0.5, 0.7, 0.2, 0.9, 0.6, 0.3, 0.1, -0.4, 1.5,
            -0.7, 0.4, 0.3, -0.2, -0.5, -0.8,
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
