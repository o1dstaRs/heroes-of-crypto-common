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

import { creatureInfo } from "../../src/ai/setup/creature_score";
import { parseDraftGenome } from "../../src/ai/setup/draft_ship";
import {
    rankedDraftRangedFloor,
    rankedDraftStrengthLiftPp,
    rankedDraftStrengthScore,
    rankedDraftStrengthV4LiftPp,
    rankedDraftStrengthV4PriorSource,
} from "../../src/ai/setup/draft_strength_prior";
import { PBTypes } from "../../src/generated/protobuf/v1/types";

const CATALOG = Object.values(PBTypes.CreatureVals).filter(
    (value): value is number => typeof value === "number" && value > 0 && creatureInfo(value) !== undefined,
);

describe("ranked draft unit-strength prior v4 (current balance, floor-4 armies)", () => {
    it("scores v4 policies by the v4 fit at their weight, with r4's shooter floor, and leaves v1 on the v1 fit", () => {
        for (const id of CATALOG) {
            expect(rankedDraftStrengthScore(id, "ranked-unit-strength-a19-side-v4-w4-r4")).toBeCloseTo(
                (4 * rankedDraftStrengthV4LiftPp(id)) / 100,
                12,
            );
            expect(rankedDraftStrengthScore(id, "ranked-unit-strength-a19-side-v4-w8-r4")).toBeCloseTo(
                (8 * rankedDraftStrengthV4LiftPp(id)) / 100,
                12,
            );
            expect(rankedDraftStrengthScore(id, "ranked-unit-strength-a19-side-v4-w16-r4")).toBeCloseTo(
                (16 * rankedDraftStrengthV4LiftPp(id)) / 100,
                12,
            );
            expect(rankedDraftStrengthScore(id, "ranked-unit-strength-a19-side-v1-w4-r4")).toBeCloseTo(
                (4 * rankedDraftStrengthLiftPp(id)) / 100,
                12,
            );
        }
        expect(rankedDraftRangedFloor("ranked-unit-strength-a19-side-v4-w4-r4")).toBe(4);
        expect(rankedDraftRangedFloor("ranked-unit-strength-a19-side-v4-w8-r4")).toBe(4);
        expect(rankedDraftRangedFloor("ranked-unit-strength-a19-side-v4-w16-r4")).toBe(4);
        expect(parseDraftGenome("ranked-unit-strength-a19-side-v4-w4-r4").draftStrengthPolicy).toBe(
            "ranked-unit-strength-a19-side-v4-w4-r4",
        );
        expect(CATALOG.some((id) => rankedDraftStrengthV4LiftPp(id) !== rankedDraftStrengthLiftPp(id))).toBeTrue();
    });

    it("ships the prior fitted on the preregistered current-balance panel", () => {
        const source = rankedDraftStrengthV4PriorSource();
        expect(source.file).toBe("v4_train.jsonl");
        expect(source.sha256).toBe("5a616526d30b3259b9953488afc711e4682f9140d9c17676ef1ec39af5927a3a");
        expect(source.records).toBe(8000);
        expect(source.decisiveGames).toBe(7927);
        expect(source.boards).toBe(3999);
        expect(source.harnessCommit).toBe("6f67b22");
    });
});
