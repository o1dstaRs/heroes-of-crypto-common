import { describe, expect, it } from "bun:test";
import { LIVE_TIER1_ARTIFACT_IDS } from "../../src/picks/pick_sim";
import { normalizeRankedDraftGenome, rankedDraftStrengthCandidate } from "../../src/simulation/ranked_draft_eval";
import {
    resolveSetupPolicy,
    V07_NONFIGHT_AUGMENT_OVERRIDE_PREFIX,
    V07_NONFIGHT_SETUP_SPEC,
    parseAugmentOverridePlan,
} from "../../src/ai/setup/setup_ship";

describe("research instruments for the Tier-1 table and the augment head", () => {
    it("the augment-override spec keeps every other head of the frozen live policy", () => {
        const live = resolveSetupPolicy(V07_NONFIGHT_SETUP_SPEC);
        const identity = resolveSetupPolicy(`${V07_NONFIGHT_AUGMENT_OVERRIDE_PREFIX}0-2-2-3-0`);
        const armour3 = resolveSetupPolicy(`${V07_NONFIGHT_AUGMENT_OVERRIDE_PREFIX}0-3-1-3-0`);
        const roster = [1, 2, 3, 4, 5, 6];
        // The identity plan reproduces the live spend exactly, so an A/B against it measures nothing.
        expect(identity.pickAugments(7, roster)).toEqual(live.pickAugments(7, roster));
        // The candidate differs only by the Armor/Might point.
        expect(armour3.pickAugments(7, roster)).toEqual([
            { kind: "Armor", value: 3 },
            { kind: "Might", value: 1 },
            { kind: "Sniper", value: 3 },
        ]);
        // Every other head is untouched.
        for (const other of [identity, armour3]) {
            expect(other.placement).toBe(live.placement);
            expect(other.placementAugmentTiming).toBe(live.placementAugmentTiming);
            expect(other.pickArtifactT2([1, 2, 3], roster)).toBe(live.pickArtifactT2([1, 2, 3], roster));
            expect(other.pickSynergies(roster)).toEqual(live.pickSynergies(roster));
        }
    });

    it("an augment override must spend the whole budget and stay inside the caps", () => {
        expect(parseAugmentOverridePlan("0-3-1-3-0")).toEqual({
            placement: 0,
            armor: 3,
            might: 1,
            sniper: 3,
            movement: 0,
        });
        expect(() => parseAugmentOverridePlan("0-3-3-3-0")).toThrow(); // overspends
        expect(() => parseAugmentOverridePlan("0-1-1-3-0")).toThrow(); // underspends
        expect(() => parseAugmentOverridePlan("0-4-0-3-0")).toThrow(); // above the Armor cap
        expect(() => parseAugmentOverridePlan("0-3-1-3")).toThrow(); // not five levels
    });

    it("a Tier-1 override is accepted only for a live artifact id", () => {
        const candidate = rankedDraftStrengthCandidate("ranked-unit-strength-a19-side-v4-w8-r4");
        expect(normalizeRankedDraftGenome(candidate).id).toBe("ranked-unit-strength-a19-side-v4-w8-r4");
        expect(LIVE_TIER1_ARTIFACT_IDS).toContain(10);
        expect(LIVE_TIER1_ARTIFACT_IDS).toContain(13);
        expect(LIVE_TIER1_ARTIFACT_IDS).not.toContain(0);
    });
});
