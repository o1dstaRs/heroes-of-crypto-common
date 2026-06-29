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

    it("default weight vector reproduces v0.4 shot scoring exactly", () => {
        // shotDamage=1, shotRange=1 (=> 2x on enemy range, matching v0.3/v0.4's ENEMY_RANGE_DAMAGE_WEIGHT),
        // shotKill/shotFirepower/shotLevel=0 (new biases off), shotFriendlyFire=1. An untrained v0.5 == v0.4.
        expect(DEFAULT_V05_W).toEqual([1.0, 0.0, 1.0, 0.0, 0.0, 1.0]);
        expect(DEFAULT_V05_W.length).toBe(V05_WEIGHT_KEYS.length);
    });

    it("loadV05Weights honours a well-formed process.env.V05_WEIGHTS override", () => {
        const trained = [1.2, 0.5, 0.8, 0.1, 0.05, 1.0];
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
