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
    rankedDraftStrengthLiftPp,
    rankedDraftStrengthRelaxesFactionTax,
    rankedDraftStrengthScore,
    rankedDraftStrengthV3LiftPp,
    rankedDraftStrengthV3PriorSource,
} from "../../src/ai/setup/draft_strength_prior";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { rankedDraftStrengthCandidate } from "../../src/simulation/ranked_draft_eval";

const CATALOG = Object.values(PBTypes.CreatureVals).filter(
    (value): value is number => typeof value === "number" && value > 0 && creatureInfo(value) !== undefined,
);

describe("ranked draft unit-strength prior v3 (on-policy refit)", () => {
    it("scores v3 policies by the v3 fit at their weight and leaves v1 policies on the v1 fit", () => {
        for (const id of CATALOG) {
            for (const [policy, weight] of [
                ["ranked-unit-strength-a19-side-v3-w2", 2],
                ["ranked-unit-strength-a19-side-v3-w4", 4],
                ["ranked-unit-strength-a19-side-v3-w8", 8],
            ] as const) {
                expect(rankedDraftStrengthScore(id, policy)).toBeCloseTo(
                    (weight * rankedDraftStrengthV3LiftPp(id)) / 100,
                    12,
                );
            }
            expect(rankedDraftStrengthScore(id, "ranked-unit-strength-a19-side-v1-w4")).toBeCloseTo(
                (4 * rankedDraftStrengthLiftPp(id)) / 100,
                12,
            );
        }
        expect(rankedDraftStrengthRelaxesFactionTax("ranked-unit-strength-a19-side-v3-w4")).toBeFalse();
        expect(CATALOG.some((id) => rankedDraftStrengthV3LiftPp(id) !== rankedDraftStrengthLiftPp(id))).toBeTrue();
    });

    it("ships the prior fitted on the preregistered on-policy panel", () => {
        const source = rankedDraftStrengthV3PriorSource();
        expect(source.file).toBe("v3_train.jsonl");
        expect(source.records).toBe(8000);
        expect(source.boards).toBe(4000);
        expect(source.decisiveGames).toBeGreaterThanOrEqual(7000);
        expect(source.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(source.harnessCommit).toMatch(/^[0-9a-f]{7,40}$/);
    });

    it("drafts with a v3 policy through the same genome path as the harness", () => {
        const policy = "ranked-unit-strength-a19-side-v3-w4" as const;
        expect(parseDraftGenome(policy).draftStrengthPolicy).toBe(policy);
        expect(rankedDraftStrengthCandidate(policy).draftStrengthPolicy).toBe(policy);
    });
});
