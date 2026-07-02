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
            1.4841, -0.5083, 0.0391, 0.0198, 3.2615, 4.4136, 1.2554, 0.5997, 0.0358, 0.537, -1.1739, 1.8861, 1.573,
            2.818, -0.0254, 0.8456, 3.5469, 2.8459, -0.8899, -0.125, -1.6446, 0.8041, -1.8285, -2.6859, -0.5414, 1.753,
            1.4356, -0.6464, 0.3672, -0.8436, 0.492, 0.2973, 0.1443, 2.7736, -0.422, 0.6162, -0.6053, 2.9583, -0.6088,
            -1.3999, 1.8541, 0.071, 0.0973, -0.5594, 0.6612, 0.3472, 0.0802, -0.5049, 0.9476, 0.8073, -0.1741, 0, 0,
        ]);
        expect(DEFAULT_V05_W.length).toBe(V05_WEIGHT_KEYS.length);
        expect(DEFAULT_V05_W.length).toBe(53);
    });

    it("loadV05Weights honours a well-formed process.env.V05_WEIGHTS override", () => {
        const trained = [
            1.2, 0.5, 0.8, 0.1, 0.05, 1.0, 0.4, -0.2, -0.6, 1.0, 0.3, -0.5, 0.7, 0.2, 0.9, 0.6, 0.3, 0.1, -0.4, 1.5,
            -0.7, 0.4, 0.3, -0.2, -0.5, -0.8, 0.2, -0.3, 0.1, 0.4, -0.1, 0.6, -0.2, 0.9, -0.4, 1.1, -0.7, 0.2, -0.9,
            0.5, 0.3, 0.15, -0.25, 0.35, -0.15, 0.45, -0.55, 0.65, -0.35,
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
