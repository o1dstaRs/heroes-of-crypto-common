import { expect, it } from "bun:test";
import { renderAiMetaReport } from "../../src/simulation/render_ai_meta_report";

it("separates cached outcomes from newly executed recovery work", () => {
    const html = renderAiMetaReport({
        provenance: {
            executionRecovery: { recoveredPairsFromOriginalExecution: 1962, missingPairsRequiringExecution: 54 },
            timing: { wallSeconds: 60 },
        },
        cohorts: [{ cohort: "ranked-draft", games: 4032 }],
        rankings: {},
    });
    expect(html).toContain("1,962 original families (3,924 fights) were reused unchanged");
    expect(html).toContain("54 missing fixed families (108 fights)");
    expect(html).toContain("Recovery wall time");
    expect(html).toContain("Executed this pass");
    expect(html).not.toContain("67.200 fights/s");
    expect(html).not.toContain("Total throughput");
});

it("does not label the learning collector as unchanged combined-default play", () => {
    const html = renderAiMetaReport({
        provenance: {
            fightVersion: "v0.8",
            fightProfile: { studyProfile: "premium-ranked-v4", draftModelId: "locked-v3" },
        },
        rankings: {},
    });
    expect(html).toContain("exploration enabled");
    expect(html).toContain("registered draft and formation exploration");
    expect(html).not.toContain("these games measure the user's selected combined default");
});
