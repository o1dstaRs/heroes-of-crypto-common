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

import {
    installRolloutSampleCapture,
    replayStoppingRule,
    type IRolloutSampleRow,
} from "../../src/simulation/measure_search_rollout_samples";
import { SearchDriver } from "../../src/simulation/search_driver";

const row = (overrides: Partial<IRolloutSampleRow> = {}): IRolloutSampleRow => ({
    g: 0,
    d: 0,
    unit: "Peasant",
    level: 1,
    k: 3,
    r: 4,
    kinds: ["incumbent", "melee", "move"],
    // Candidate 1 wins overall but trails after round 1; candidate 2 is a consistent loser.
    samples: [
        [0.5, 0.5, 0.5, 0.5],
        [0.1, 0.9, 0.9, 0.9],
        [0.0, 0.0, 0.0, 0.0],
    ],
    means: [0.5, 0.7, 0.0],
    chosen: 1,
    ...overrides,
});

describe("search rollout-sample capture", () => {
    it("restores every wrapped driver method", () => {
        const prototype = SearchDriver.prototype as unknown as Record<string, unknown>;
        const before = {
            search: prototype.search,
            scoreCandidates: prototype.scoreCandidates,
            rollout: prototype.rollout,
        };

        const restore = installRolloutSampleCapture(() => {});
        expect(prototype.search).not.toBe(before.search);
        expect(prototype.scoreCandidates).not.toBe(before.scoreCandidates);
        expect(prototype.rollout).not.toBe(before.rollout);

        restore();
        expect(prototype.search).toBe(before.search);
        expect(prototype.scoreCandidates).toBe(before.scoreCandidates);
        expect(prototype.rollout).toBe(before.rollout);
    });
});

describe("stopping-rule replay", () => {
    it("charges the full budget when nothing is dropped", () => {
        const result = replayStoppingRule([row()], { firstRounds: 1, margin: 1 });
        expect(result.executed).toBe(12);
        expect(result.used).toBe(12);
        expect(result.savedFraction).toBe(0);
        expect(result.changed).toBe(0);
    });

    it("bills a dropped candidate only for the rounds it ran, and books the decision it would change", () => {
        // Margin 0 after one round: candidate 1 (0.1) and candidate 2 (0.0) both trail the incumbent (0.5),
        // so only the incumbent survives — and the search's actual pick, candidate 1, is lost.
        const result = replayStoppingRule([row()], { firstRounds: 1, margin: 0 });
        expect(result.used).toBe(4 + 1 + 1);
        expect(result.savedFraction).toBeCloseTo(0.5, 10);
        expect(result.changed).toBe(1);
        expect(result.changedFraction).toBe(1);
        // Stake = the chosen candidate's real mean minus the best surviving one.
        expect(result.medianStake).toBeCloseTo(0.2, 10);
    });

    it("keeps the partial-mean leader even when the margin would drop it", () => {
        const leaderRow = row({
            samples: [
                [0.1, 0.1, 0.1, 0.1],
                [0.9, 0.9, 0.9, 0.9],
                [0.0, 0.0, 0.0, 0.0],
            ],
            means: [0.1, 0.9, 0.0],
        });
        const result = replayStoppingRule([leaderRow], { firstRounds: 1, margin: 0 });
        expect(result.changed).toBe(0);
        expect(result.used).toBe(4 + 4 + 1);
    });

    it("keepTop bounds how many trailing challengers survive", () => {
        const wide = row({
            k: 4,
            kinds: ["incumbent", "melee", "melee", "move"],
            samples: [
                [0.5, 0.5, 0.5, 0.5],
                [0.6, 0.6, 0.6, 0.6],
                [0.55, 0.55, 0.55, 0.55],
                [0.52, 0.52, 0.52, 0.52],
            ],
            means: [0.5, 0.6, 0.55, 0.52],
            chosen: 1,
        });
        const all = replayStoppingRule([wide], { firstRounds: 1, margin: 1 });
        const capped = replayStoppingRule([wide], { firstRounds: 1, margin: 1, keepTop: 1 });
        expect(all.used).toBe(16);
        // Only the incumbent and the single best challenger keep their full budget.
        expect(capped.used).toBe(4 + 4 + 1 + 1);
        expect(capped.changed).toBe(0);
    });
});
