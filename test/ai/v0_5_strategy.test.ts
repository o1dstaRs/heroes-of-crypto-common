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

    it("ships the trained vector (53 dims; tail [51..52] target-caster untrained/no-op)", () => {
        // Full 51-dim CEM (gem run, pass 1): panel 61.80%, gems trained [49..50]. Two new BROAD dims [51..52]
        // (meleeTargetCaster / shotTargetCaster — kill the enemy Healer/caster) are UNTRAINED (0), a strict
        // no-op until the next CEM pass searches them.
        expect(DEFAULT_V05_W).toEqual([
            1.878, -0.9581, -0.1678, 1.3365, 1.0323, 4.9159, 1.5845, 0.3526, -1.1937, 1.0574, 0.2617, 2.2306, 3.1763,
            2.6777, -0.0014, 0.4104, 3.9821, 5.1322, -0.7937, 0.2533, -1.7702, 0.2244, -2.6472, -2.2222, -1.3665,
            2.6387, 0.6218, -0.9772, 0.1456, -1.601, -0.4014, 0.2955, 0.1458, 2.0687, -1.1211, 0.6944, -0.0405, 2.4438,
            -0.3691, -0.7115, 3.8785, 1.9894, -2.6533, 1.37, 0.5252, 0.0925, 1.0413, 0.3189, 1.7069, 0.4515, -0.9098,
            0.265, 1.5186,
        ]);
        expect(DEFAULT_V05_W.length).toBe(V05_WEIGHT_KEYS.length);
        expect(DEFAULT_V05_W.length).toBe(53);
    });

    it("loadV05Weights honours a well-formed process.env.V05_WEIGHTS override", () => {
        const trained = [
            1.2, 0.5, 0.8, 0.1, 0.05, 1.0, 0.4, -0.2, -0.6, 1.0, 0.3, -0.5, 0.7, 0.2, 0.9, 0.6, 0.3, 0.1, -0.4, 1.5,
            -0.7, 0.4, 0.3, -0.2, -0.5, -0.8, 0.2, -0.3, 0.1, 0.4, -0.1, 0.6, -0.2, 0.9, -0.4, 1.1, -0.7, 0.2, -0.9,
            0.5, 0.3, 0.15, -0.25, 0.35, -0.15, 0.45, -0.55, 0.65, -0.35, 0.2, -0.4, 0.6, -0.1,
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
