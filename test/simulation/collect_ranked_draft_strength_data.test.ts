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

import { describe, expect, test } from "bun:test";

import { RANKED_VERSATILE_DRAFT_SPEC } from "../../src/ai/setup/draft_ship";
import {
    rankedDraftStrengthDataDrafter,
    rankedDraftStrengthTasks,
} from "../../src/simulation/collect_ranked_draft_strength_data";
import { rankedDraftLiveIncumbent, rankedDraftStrengthCandidate } from "../../src/simulation/ranked_draft_eval";

describe("ranked draft strength data collector", () => {
    test("drafts with the deployed versatile draft unless a strength policy is named", () => {
        expect(rankedDraftStrengthDataDrafter()).toEqual(rankedDraftLiveIncumbent());
        expect(rankedDraftStrengthDataDrafter(RANKED_VERSATILE_DRAFT_SPEC)).toEqual(rankedDraftLiveIncumbent());
        expect(rankedDraftStrengthDataDrafter("ranked-unit-strength-a19-side-v1-w4")).toEqual(
            rankedDraftStrengthCandidate("ranked-unit-strength-a19-side-v1-w4"),
        );
    });

    test("refuses a policy it cannot draft with", () => {
        expect(() => rankedDraftStrengthDataDrafter("ranked-unit-strength-a19-side-v1-w5")).toThrow("--policy");
    });

    test("plays the first pick-seat assignment of each board in both mirrors, from any starting board", () => {
        expect(rankedDraftStrengthTasks(3, 5)).toEqual([
            { opponentIndex: 0, game: 12 },
            { opponentIndex: 0, game: 13 },
            { opponentIndex: 0, game: 16 },
            { opponentIndex: 0, game: 17 },
        ]);
    });
});
