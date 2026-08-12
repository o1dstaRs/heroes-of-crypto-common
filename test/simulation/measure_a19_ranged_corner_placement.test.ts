import { describe, expect, test } from "bun:test";

import {
    V08_A19_RANGED_CORNER_PLACEMENT_AB_SCHEDULE,
    V08_A19_RANGED_CORNER_SCENARIO_NAMES,
    evaluateV08A19RangedCornerPlacementCluster,
    summarizeV08A19RangedCornerPlacement,
    v08A19RangedCornerOpponentRoster,
    v08A19RangedCornerSupportRoster,
} from "../../src/simulation/measure_a19_ranged_corner_placement";

describe("A19 Ogre Mage and Behemoth ranged-corner A/B", () => {
    test("builds complete live-ranked roster fixtures", () => {
        const support = v08A19RangedCornerSupportRoster();
        expect(support.map((unit) => unit.creatureName)).toEqual([
            "Troglodyte",
            "Arbalester",
            "Beholder",
            "Troll",
            "Ogre Mage",
            "Behemoth",
        ]);
        expect(support.map((unit) => unit.amount).every((amount) => amount > 0)).toBe(true);
        for (const scenario of V08_A19_RANGED_CORNER_SCENARIO_NAMES) {
            expect(v08A19RangedCornerOpponentRoster(scenario)).toHaveLength(6);
        }
    });

    test("assembles and summarizes the complete two-seat candidate/control shape", () => {
        // The two file-level shards below own the four full max-lap-20 fights. A zero-lap cluster still runs
        // the identical setup/placement path and covers the production cluster assembler and summarizer
        // without serializing a second copy of those fights in this file.
        const cluster = evaluateV08A19RangedCornerPlacementCluster("ground-control", 0, 819_024_611, 0);
        expect(cluster.games.map((game) => game.id)).toEqual(
            V08_A19_RANGED_CORNER_PLACEMENT_AB_SCHEDULE.map((schedule) => schedule.id),
        );
        expect([...new Set(cluster.games.map((game) => game.seed))]).toHaveLength(1);
        expect(
            cluster.games.every((game) => game.supportRejectedActions === 0 && game.opponentRejectedActions === 0),
        ).toBe(true);
        const controls = new Map(
            cluster.games.filter((game) => game.arm === "control").map((game) => [game.supportSide, game]),
        );
        const candidates = cluster.games.filter((game) => game.arm === "candidate");
        expect(candidates).toHaveLength(2);
        for (const candidate of candidates) {
            expect(candidate.candidateAudit).toMatchObject({ treatmentApplied: true, placementChanged: true });
            expect(candidate.behemothAdjacentToFireline).toBe(true);
            expect(candidate.supportFirelineSpan).toBeLessThan(
                controls.get(candidate.supportSide)!.supportFirelineSpan,
            );
        }
        const summary = summarizeV08A19RangedCornerPlacement([cluster]);
        expect(summary.overall.games).toBe(2);
        expect(summary.overall.candidateApplied).toBe(2);
        expect(summary.overall.candidateChanged).toBe(2);
    });
});
