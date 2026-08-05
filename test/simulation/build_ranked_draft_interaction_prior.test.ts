import { expect, test } from "bun:test";

import { buildRankedDraftInteractionPrior } from "../../src/simulation/build_ranked_draft_interaction_prior";

const source = {
    generatedAt: "2026-08-04T09:42:30.768Z",
    interactions: {
        schema: "cross-fitted-ridge-unit-interactions-v1",
        scope: { pairs: 35_028, games: 70_056, cohorts: ["ranked-draft"], maps: [1, 3, 4] },
        allyPairs: [
            {
                units: ["Alpha", "Bravo"],
                pairs: 150,
                adjustedCiLowPp: 2.1,
                adjustedCiHighPp: 7.4,
            },
            {
                units: ["Alpha", "Cinder"],
                pairs: 150,
                adjustedCiLowPp: -7.4,
                adjustedCiHighPp: -2.2,
            },
            {
                units: ["Alpha", "Drake"],
                pairs: 49,
                adjustedCiLowPp: 9,
                adjustedCiHighPp: 12,
            },
        ],
        counters: [
            {
                units: ["Alpha", "Nemesis"],
                unit: "Alpha",
                enemyUnit: "Nemesis",
                pairs: 150,
                adjustedCiLowPp: 2.5,
                adjustedCiHighPp: 8,
            },
            {
                units: ["Bravo", "Nemesis"],
                unit: "Bravo",
                enemyUnit: "Nemesis",
                pairs: 150,
                adjustedCiLowPp: -8,
                adjustedCiHighPp: -2.4,
            },
        ],
        allyTrios: [
            {
                units: ["Alpha", "Bravo", "Cinder"],
                pairs: 150,
                adjustedCiLowPp: 4.1,
                adjustedCiHighPp: 9,
            },
            {
                units: ["Alpha", "Bravo", "Drake"],
                pairs: 149,
                adjustedCiLowPp: 12,
                adjustedCiHighPp: 18,
            },
        ],
    },
};

test("builds a deterministic conservative interaction artifact from an AI-meta summary", () => {
    const metadata = {
        sourceSha256: "d5103ace4861f857aa6e08fa1bea2e9f10256125335acc875b7d7dfe3a5ed1db",
        sourceRelativePath: "sim-out/example/ranked-draft.pairs.jsonl.gz",
    };
    const first = buildRankedDraftInteractionPrior(source, metadata);
    const second = buildRankedDraftInteractionPrior(structuredClone(source), metadata);

    expect(second).toEqual(first);
    expect(first.source).toMatchObject({ games: 70_056, matchupPairs: 35_028, maps: [1, 3, 4] });
    expect(first.allyPairs).toEqual([
        { units: ["Alpha", "Bravo"], support: 150, conservativeLiftPp: 2.1 },
        { units: ["Alpha", "Cinder"], support: 150, conservativeLiftPp: -2.2 },
    ]);
    expect(first.counters).toHaveLength(2);
    expect(first.allyTrios).toEqual([{ units: ["Alpha", "Bravo", "Cinder"], support: 150, conservativeLiftPp: 4.1 }]);
});
