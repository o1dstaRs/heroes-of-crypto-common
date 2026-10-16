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
    rankedFactionDiversityTaxUnits,
} from "../../src/ai/setup/draft_ship";
import {
    isRankedDraftStrengthPolicy,
    RANKED_DRAFT_RELAXED_FACTION_TAX_FREE_STACKS,
    RANKED_DRAFT_STRENGTH_POLICY_WEIGHTS,
    rankedDraftStrengthLiftPp,
    rankedDraftStrengthPriorSource,
    rankedDraftStrengthRelaxesFactionTax,
    rankedDraftStrengthScore,
    rankedDraftSynergyMarginalPp,
    rankedDraftUnitSynergyLiftPp,
    rankedDraftUnitSynergyPriorSource,
} from "../../src/ai/setup/draft_strength_prior";
import unitSynergyPrior from "../../src/ai/setup/draft_strength_priors/ranked_unit_synergy_a19_side_v2.json";
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

    it("ships priors fitted on the preregistered training panel", () => {
        for (const source of [rankedDraftStrengthPriorSource(), rankedDraftUnitSynergyPriorSource()]) {
            expect(source.file).toBe("train_seed97100001.jsonl");
            expect(source.decisiveGames).toBeGreaterThanOrEqual(7000);
            expect(source.harnessCommit).toMatch(/^[0-9a-f]{7,40}$/);
        }
    });
});

describe("ranked draft unit + synergy + map prior (v2)", () => {
    const V2 = "ranked-unit-synergy-a19-side-v2-w2" as const;
    const tier1 = unitSynergyPrior.synergyTiers.tier1.conservativeLiftPp;
    const tier2 = unitSynergyPrior.synergyTiers.tier2.conservativeLiftPp;
    const factionOf = (id: number): number => creatureInfo(id)?.faction ?? 0;
    const sameFaction = (() => {
        const byFaction = new Map<number, number[]>();
        for (const id of CATALOG) byFaction.set(factionOf(id), [...(byFaction.get(factionOf(id)) ?? []), id]);
        return [...byFaction.values()].find((ids) => ids.length >= 6)!;
    })();
    const otherFaction = CATALOG.filter((id) => factionOf(id) && factionOf(id) !== factionOf(sameFaction[0]));

    it("values reaching a synergy tier, and the pick before it by the chance to complete it", () => {
        const [a, b, c, d, e] = sameFaction;
        expect(rankedDraftSynergyMarginalPp(b, [a])).toBeCloseTo(tier1, 12);
        expect(rankedDraftSynergyMarginalPp(d, [a, b, c])).toBeCloseTo(tier2, 12);
        // Two on the roster, three picks left after this one.
        expect(rankedDraftSynergyMarginalPp(c, [a, b])).toBeCloseTo((1 - 0.5 ** 3) * tier2, 12);
        // Empty roster, five picks left.
        expect(rankedDraftSynergyMarginalPp(a, [])).toBeCloseTo((1 - 0.5 ** 5) * tier1, 12);
        expect(rankedDraftSynergyMarginalPp(e, [a, b, c, d])).toBe(0);
        expect(rankedDraftSynergyMarginalPp(a, [a, otherFaction[0]])).toBe(0);
    });

    it("reads level-3/4 lifts for the revealed map and averages them before the reveal", () => {
        const byMap = unitSynergyPrior.creatures.filter((entry) => entry.gridType !== undefined);
        const creatureId = byMap[0].creatureId;
        const lifts = byMap.filter((entry) => entry.creatureId === creatureId);
        for (const entry of lifts) {
            expect(rankedDraftUnitSynergyLiftPp(creatureId, entry.gridType)).toBe(entry.conservativeLiftPp);
        }
        const mean = lifts.reduce((sum, entry) => sum + entry.conservativeLiftPp, 0) / lifts.length;
        expect(rankedDraftUnitSynergyLiftPp(creatureId)).toBeCloseTo(mean, 12);
        const own = [otherFaction[0]];
        expect(
            rankedDraftStrengthScore(creatureId, V2, { ownCreatureIds: own, revealedGridType: lifts[0].gridType }),
        ).toBeCloseTo((2 * (lifts[0].conservativeLiftPp + rankedDraftSynergyMarginalPp(creatureId, own))) / 100, 12);
    });

    it("keeps v1 scores map- and roster-blind, and relaxes the faction tax only under v2", () => {
        const [a, b, c, d] = sameFaction;
        const v1 = "ranked-unit-strength-a19-side-v1-w2" as const;
        expect(rankedDraftStrengthScore(a, v1, { ownCreatureIds: [b, c], revealedGridType: 4 })).toBe(
            rankedDraftStrengthScore(a, v1),
        );
        expect(rankedDraftStrengthRelaxesFactionTax(V2)).toBeTrue();
        expect(rankedDraftStrengthRelaxesFactionTax(v1)).toBeFalse();
        expect(rankedDraftStrengthRelaxesFactionTax(undefined)).toBeFalse();
        expect(rankedFactionDiversityTaxUnits(a, [b, c])).toBe(1);
        expect(rankedFactionDiversityTaxUnits(a, [b, c, d], RANKED_DRAFT_RELAXED_FACTION_TAX_FREE_STACKS)).toBe(0);
        expect(
            rankedFactionDiversityTaxUnits(a, [b, c, d, sameFaction[4]], RANKED_DRAFT_RELAXED_FACTION_TAX_FREE_STACKS),
        ).toBe(1);
    });
});
