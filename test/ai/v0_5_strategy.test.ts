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

    it("ships the long-run-trained vector (41 dims, all learned incl. mining + AOE; ~61.2% vs v0.4 fresh)", () => {
        // Concurrent CEM over all 41 dims (10h, RNG-fixed sim, pass 17): panel 61.56%, fresh held-out avg
        // ~61.2% (61.8/61.1/60.7, 4k games each) — panel≈fresh, robust not overfit; +2.4pp over the pass-8
        // bake (58.8% same fresh seeds). This pass co-trained the mountain-mining [26..32] and AOE-melee
        // positioning [33..40] blocks, both now non-zero (e.g. aoeExposure [37] +3.21 — a Hydra surrounds).
        expect(DEFAULT_V05_W).toEqual([
            1.5071, -0.2441, 0.3461, 0.8641, 3.5716, 4.5685, 0.9699, 0.1516, -0.5075, 1.2347, -0.2059, 1.9369, 1.3947,
            2.5332, -0.0088, 0.1119, 3.9592, 3.232, -0.4417, 0.29, -0.7771, 0.5521, -1.7815, -2.3662, -0.655, 0.6914,
            1.0091, -0.5941, -1.4454, -0.3316, 0.681, 0.2878, 0.1747, 2.6464, -0.3006, 1.3421, -0.9998, 3.2068, -0.0927,
            -0.9579, 0.734,
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
