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
                searchScoredDecisionObserver: (decision) => {
                    if (decision.unit.getName() === "Trent") {
                        scored.push(decision.candidates);
                    }
                },
            }),
        );

        expect(scored).toHaveLength(1);
        expect(scored[0][0].kind).toBe("incumbent");
        expect(scored[0][0].actions.some((action) => action.type === "melee_attack")).toBe(true);
        expect(scored[0].some((candidate) => candidate.kind === "move")).toBe(true);
        expect(scored[0].some((candidate) => candidate.kind === "spell" && candidate.spellName === "Vine Throw")).toBe(
            true,
        );
        // shortlist=3 normally means incumbent + two challengers. The reserved Vine is additive so the best
        // ordinary challengers are not silently displaced. The exact move-melee duplicate is now enriched into
        // the incumbent rather than repeated as a separate melee candidate.
        expect(scored[0]).toHaveLength(4);
    });
});
