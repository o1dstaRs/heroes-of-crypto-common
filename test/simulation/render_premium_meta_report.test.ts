import { expect, it } from "bun:test";
import { renderAiMetaReport } from "../../src/simulation/render_ai_meta_report";

it("labels the Premium pilot without misrepresenting retained draft artifacts as randomized evidence", () => {
    const html = renderAiMetaReport({
        complete: true,
        provenance: { fightProfile: { studyProfile: "premium-ranked-v1" } },
        rankings: {
            units: [
                {
                    key: "test-unit",
                    name: "Test unit",
                    pairs: 2,
                    games: 4,
                    wins: 0,
                    losses: 4,
                    draws: 0,
                    scoreRate: 0,
                    ciLow: 0,
                    ciHigh: 0,
                },
            ],
        },
    });
    expect(html).toContain("Premium coverage study · exploratory evidence");
    expect(html).toContain("must not be read as zero strength");
    expect(html).toContain("does not match current ranked public-roster Setup");
    expect(html).toContain("5/6/7-point doctrine budgets");
    expect(html).not.toContain("compares 96 candidates");
    expect(html).not.toContain("Augment plans are the causal unit");
    expect(html).toContain(`"ciHigh":${Math.sqrt(Math.log(40) / 4)}`);
});

it("labels current public Setup independently of historical private Setup", () => {
    const html = renderAiMetaReport({
        complete: true,
        provenance: { fightProfile: { studyProfile: "premium-ranked-v2" } },
        rankings: {},
    });
    expect(html).toContain("Augment setup uses the public opponent roster");
    expect(html).not.toContain("does not match current ranked public-roster Setup");
});
