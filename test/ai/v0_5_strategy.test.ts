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

    it("ships the trained vector (51 dims: mining + spin/directional AOE trained; 2 untrained hidden-gem dims)", () => {
        // Concurrent CEM over 49 dims (7h, pass 12): panel 61.74%, fresh ~61.6% (61.5/61.6/61.7). The two new
        // tail dims [49..50] — warAngerSurround (Valkyrie seeks surround) and punishMeleeAvoid (don't trade into
        // Fire Shield / Dulling Defense) — are UNTRAINED (0), a strict no-op until the next CEM pass searches them.
        expect(DEFAULT_V05_W).toEqual([
            1.6989, -0.5351, 0.1209, -0.0394, 3.1819, 4.4191, 0.8675, 0.5428, -0.3078, 0.8065, -0.737, 1.5808, 1.7297,
            2.8292, -0.0376, 1.0486, 3.4951, 2.9443, -0.666, -0.0077, -2.0195, 0.6111, -1.8996, -2.5474, -0.9852,
            1.7509, 1.4942, -0.4027, -0.501, -0.7806, 0.5115, 0.1852, -0.1876, 2.5639, -0.758, 0.9309, -0.6723, 3.1302,
            -0.5766, -0.9204, 1.6919, 0.0288, 0.0292, -1.0115, 0.1992, 0.2565, 0.2656, 0.1276, 0.7142, 0, 0,
        ]);
        expect(DEFAULT_V05_W.length).toBe(V05_WEIGHT_KEYS.length);
        expect(DEFAULT_V05_W.length).toBe(51);
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
