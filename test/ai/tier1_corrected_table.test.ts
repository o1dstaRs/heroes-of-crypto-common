import { describe, expect, it } from "bun:test";
import { Tier1Artifact } from "../../src/artifacts/artifact_properties";
import { parseDraftGenome } from "../../src/ai/setup/draft_ship";
import { rankedDraftUsesCorrectedTier1Table } from "../../src/ai/setup/draft_strength_prior";
import {
    TIER1_ARTIFACT_WINRATE,
    TIER1_ARTIFACT_WINRATE_COMPOSITION_CORRECTED,
} from "../../src/ai/setup/setup_strategy";

describe("the composition-corrected Tier-1 table (research, default off)", () => {
    it("changes exactly the two entries this program measured and nothing else", () => {
        const changed = Object.keys(TIER1_ARTIFACT_WINRATE_COMPOSITION_CORRECTED)
            .map(Number)
            .filter((id) => TIER1_ARTIFACT_WINRATE_COMPOSITION_CORRECTED[id] !== TIER1_ARTIFACT_WINRATE[id]);
        expect(changed.sort()).toEqual([Tier1Artifact.CURSED_WARD, Tier1Artifact.HUNTERS_LONGBOW].sort());
        // Measured with the artifact forced on one seat, 2000 games per arm, control exactly 50.00%.
        expect(TIER1_ARTIFACT_WINRATE_COMPOSITION_CORRECTED[Tier1Artifact.CURSED_WARD]).toBe(46.3);
        expect(TIER1_ARTIFACT_WINRATE_COMPOSITION_CORRECTED[Tier1Artifact.HUNTERS_LONGBOW]).toBe(53.5);
        // The shipped table is untouched, and its Cursed Ward entry is the one the measurement contradicts.
        expect(TIER1_ARTIFACT_WINRATE[Tier1Artifact.CURSED_WARD]).toBe(79.8);
        // Mage's Ring stays absent: forcing it measured 47.25%, so the 50 fallback is fair.
        expect(TIER1_ARTIFACT_WINRATE_COMPOSITION_CORRECTED[Tier1Artifact.MAGES_RING]).toBeUndefined();
    });

    it("only the -t1 policy ids opt in, and they draft like the id they correct", () => {
        expect(rankedDraftUsesCorrectedTier1Table("ranked-unit-strength-a19-side-v4-w8-r4-t1")).toBe(true);
        expect(rankedDraftUsesCorrectedTier1Table("ranked-unit-strength-a19-side-v4-w16-r4-t1")).toBe(true);
        expect(rankedDraftUsesCorrectedTier1Table("ranked-unit-strength-a19-side-v4-w8-r4")).toBe(false);
        expect(rankedDraftUsesCorrectedTier1Table(undefined)).toBe(false);
        // Same prior, same weight, same shooter floor as the base id: only the artifact table differs.
        const base = parseDraftGenome("ranked-unit-strength-a19-side-v4-w8-r4");
        const corrected = parseDraftGenome("ranked-unit-strength-a19-side-v4-w8-r4-t1");
        expect(corrected.weights).toEqual(base.weights);
        expect(corrected.draftVarietyPolicy).toBe(base.draftVarietyPolicy);
        expect(corrected.draftInteractionPrior).toBe(base.draftInteractionPrior);
    });
});
