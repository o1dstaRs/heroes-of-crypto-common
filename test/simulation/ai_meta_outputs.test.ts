import { describe, expect, it } from "bun:test";
import { aiMetaOutputContract } from "../../src/simulation/ai_meta_outputs";

describe("AI meta CLI output contract", () => {
    it("captures the full Premium study by default for both deterministic A19 profiles", () => {
        for (const profile of ["a19-work", "v09-draft-a19-work"])
            expect(aiMetaOutputContract(profile, {})).toEqual({
                mode: "premium",
                studyProfile: "premium-ranked-v3",
                collectEvidence: true,
            });
    });

    it("preserves an explicitly registered older Premium study", () => {
        expect(aiMetaOutputContract("a19-work", { AI_META_STUDY_PROFILE: "premium-ranked-v2" }).studyProfile).toBe(
            "premium-ranked-v2",
        );
    });

    it("requires an explicit legacy opt-out and never silently drops requested capture", () => {
        expect(aiMetaOutputContract("a13", { AI_META_OUTPUT_MODE: "legacy-oracle" })).toEqual({
            mode: "legacy-oracle",
            studyProfile: undefined,
            collectEvidence: false,
        });
        expect(() => aiMetaOutputContract("a19", {})).toThrow("Automatic Premium snapshots require");
        expect(() => aiMetaOutputContract("v09-native", {})).toThrow("Automatic Premium snapshots require");
        expect(() => aiMetaOutputContract("a19-work", { AI_META_COLLECT_EVIDENCE: "0" })).toThrow("capture");
        expect(() =>
            aiMetaOutputContract("a19-work", {
                AI_META_OUTPUT_MODE: "legacy-oracle",
                AI_META_STUDY_PROFILE: "premium-ranked-v3",
            }),
        ).toThrow("conflicts");
        expect(() => aiMetaOutputContract("a19-work", { AI_META_OUTPUT_MODE: "typo" })).toThrow("OUTPUT_MODE");
        expect(() => aiMetaOutputContract("a19-work", { AI_META_STUDY_PROFILE: "typo" })).toThrow("STUDY_PROFILE");
        expect(() => aiMetaOutputContract("a19-work", { AI_META_ARTIFACT_UNIFORM: "1" })).toThrow("exploration");
    });
});
