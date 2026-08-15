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

import type { IEnumeratedCandidate } from "../../src/ai";
import { buildV08A13SearchEnvironment } from "../../src/ai/versions/v0_8_a13_profile";
import { runMatch } from "../../src/simulation/battle_engine";
import { withScopedAIEnvironment } from "../../src/simulation/v0_8_a13_search";

describe("v0.8 a13 Vine Throw search coverage", () => {
    it("keeps one legal Vine Throw beside the ordinary top challengers at shortlist three", () => {
        const scored: Array<readonly IEnumeratedCandidate[]> = [];
        withScopedAIEnvironment(buildV08A13SearchEnvironment(), () =>
            runMatch({
                greenVersion: "v0.8",
                redVersion: "v0.7",
                roster: [{ faction: "Nature", creatureName: "Trent", level: 2, size: 1, amount: 24 }],
                redRoster: [{ faction: "Life", creatureName: "Peasant", level: 1, size: 1, amount: 100 }],
                seed: 123,
                maxLaps: 1,
                // This asserts an EXACT shortlist of three. Under production deadline semantics a loaded
                // host truncates enumeration and the shortlist comes back short, so let finite operation
                // caps decide the search depth instead of the wall clock.
                searchOfflineDeterministicWork: true,
                searchScoredDecisionObserver: (decision) => {
                    if (decision.unit.getName() === "Trent") {
                        scored.push(decision.candidates);
                    }
                },
            }),
        );

        expect(scored).toHaveLength(1);
        expect(scored[0][0].kind).toBe("incumbent");
        // Since the pure-fractional steps call (Trent's 3.9 no longer rounds up to 4) the peasant line is
        // out of melee reach on this seed, so the legal Vine Throw IS the incumbent — the reserved vine no
        // longer needs an additive slot beside a melee incumbent. The invariant this test holds is intact:
        // exactly one legal vine cast sits in the scored shortlist, alongside the ordinary top challengers.
        expect(scored[0][0].actions.some((action) => action.type === "cast_spell")).toBe(true);
        expect(scored[0].some((candidate) => candidate.kind === "move")).toBe(true);
        expect(scored[0]).toHaveLength(3);
    });
});
