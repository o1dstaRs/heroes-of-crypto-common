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
import {
    applyDraftCoherenceOverlay,
    draftBundleCoherenceAffinity,
    pickCoherentDraftBundle,
    pickCoherentDraftCreature,
    type DraftBundle,
} from "../../src/ai/setup/draft_coherence";
import {
    draftGenomeCreatureScore,
    parseDraftGenome,
    pickRankedLiveDraftBundle,
    projectDraftGenomeForShipping,
    RANKED_VERSATILE_DRAFT_SPEC,
} from "../../src/ai/setup/draft_ship";
import {
    isRankedDraftStrengthPolicy,
    RANKED_DRAFT_STRENGTH_POLICY_WEIGHTS,
    rankedDraftStrengthLiftPp,
    rankedDraftStrengthPriorSource,
    rankedDraftStrengthScore,
} from "../../src/ai/setup/draft_strength_prior";
import { TIER1_ARTIFACT_WINRATE } from "../../src/ai/setup/setup_strategy";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { createLeagueGenome, LEAGUE_ANCHOR_GENOME } from "../../src/simulation/league_genome";
import { normalizeRankedDraftGenome, rankedDraftStrengthCandidate } from "../../src/simulation/ranked_draft_eval";

const POLICY = "ranked-unit-strength-a19-side-v1-w4" as const;

const CATALOG = Object.values(PBTypes.CreatureVals).filter(
    (value): value is number => typeof value === "number" && value > 0 && creatureInfo(value) !== undefined,
);
const atLevel = (level: number): number[] => CATALOG.filter((id) => creatureInfo(id)?.level === level);

const argmax = (scores: readonly number[]): number =>
    scores.reduce((best, score, index) => (score > scores[best] ? index : best), 0);

describe("ranked draft unit-strength prior", () => {
    it("is a closed set of weighted policies and contributes exactly nothing without one", () => {
        expect(Object.keys(RANKED_DRAFT_STRENGTH_POLICY_WEIGHTS).every(isRankedDraftStrengthPolicy)).toBeTrue();
        expect(isRankedDraftStrengthPolicy("ranked-unit-strength-a19-side-v1-w3")).toBeFalse();
        for (const id of CATALOG) {
            expect(rankedDraftStrengthScore(id, undefined)).toBe(0);
            expect(rankedDraftStrengthScore(id, POLICY)).toBeCloseTo((4 * rankedDraftStrengthLiftPp(id)) / 100, 12);
        }
        expect(() =>
            createLeagueGenome("bad-strength", LEAGUE_ANCHOR_GENOME, false, { draftStrengthPolicy: "nope" as never }),
        ).toThrow("strength policy");
    });

    it("breaks otherwise equal creature offers by fitted strength", () => {
        const offer = atLevel(1);
        const strongest = offer.reduce((best, id) =>
            rankedDraftStrengthLiftPp(id) > rankedDraftStrengthLiftPp(best) ? id : best,
        );
        expect(pickCoherentDraftCreature(offer, () => 1, { ownCreatureIds: [], draftStrengthPolicy: POLICY })).toBe(
            strongest,
        );
        expect(pickCoherentDraftCreature(offer, () => 1, { ownCreatureIds: [] })).toBe(offer[0]);
    });

    it("counts both bundle creatures and keeps the server's bundle rule when no policy is set", () => {
        const live = parseDraftGenome(RANKED_VERSATILE_DRAFT_SPEC);
        const level1 = atLevel(1);
        const level2 = atLevel(2);
        const bundles: DraftBundle[] = level1.slice(0, 4).map((id, index) => [id, level2[index], 1]);
        expect(pickRankedLiveDraftBundle(live, bundles)).toBe(
            pickCoherentDraftBundle(
                bundles,
                (creatureId) => draftGenomeCreatureScore(live, creatureId),
                (artifactId) => TIER1_ARTIFACT_WINRATE[artifactId] ?? 50,
            ),
        );
        const flat = bundles.map(() => 52);
        const expected = applyDraftCoherenceOverlay(
            flat,
            bundles.map((bundle) => draftBundleCoherenceAffinity(bundle)),
        ).map((score, index) => {
            const [first, second] = bundles[index];
            return score + (4 * (rankedDraftStrengthLiftPp(first) + rankedDraftStrengthLiftPp(second))) / 100;
        });
        expect(
            pickCoherentDraftBundle(
                bundles,
                () => 1,
                () => 50,
                { draftStrengthPolicy: POLICY },
            ),
        ).toBe(argmax(expected));
    });

    it("round-trips through parsing, ship projection and panel normalization", () => {
        const versatile = parseDraftGenome(RANKED_VERSATILE_DRAFT_SPEC);
        const parsed = parseDraftGenome(POLICY);
        expect(parsed.id).toBe(POLICY);
        expect(parsed.weights).toEqual(versatile.weights);
        expect(parsed.draftInteractionPrior).toBe(versatile.draftInteractionPrior);
        expect(parsed.draftVarietyPolicy).toBe(versatile.draftVarietyPolicy);
        expect(parsed.draftStrengthPolicy).toBe(POLICY);
        expect(projectDraftGenomeForShipping(parsed).draftStrengthPolicy).toBe(POLICY);
        expect(normalizeRankedDraftGenome(parsed).draftStrengthPolicy).toBe(POLICY);
        expect(rankedDraftStrengthCandidate(POLICY).draftStrengthPolicy).toBe(POLICY);
        expect(
            parseDraftGenome(JSON.stringify({ weights: versatile.weights, draftStrengthPolicy: POLICY }))
                .draftStrengthPolicy,
        ).toBe(POLICY);
    });

    it("ships a prior fitted on the preregistered training panel", () => {
        const source = rankedDraftStrengthPriorSource();
        expect(source.file).toBe("train_seed97100001.jsonl");
        expect(source.decisiveGames).toBeGreaterThanOrEqual(7000);
        expect(source.harnessCommit).toMatch(/^[0-9a-f]{7,40}$/);
    });
});
