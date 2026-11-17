import { describe, expect, spyOn, test } from "bun:test";

import { SearchDriver } from "../../src/simulation/search_driver";

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

    test("assembles both seats, executes their openings and summarizes the same four games", () => {
        // Share a real opening for formation checks; complete-fight legality has separate combat regressions.
        const searched: number[] = [];
        const onMatchEnd = SearchDriver.prototype.onMatchEnd;
        const observer = spyOn(SearchDriver.prototype, "onMatchEnd").mockImplementation(function (
            this: SearchDriver,
            ...args: Parameters<SearchDriver["onMatchEnd"]>
        ) {
            searched.push(this.counters.searched);
            onMatchEnd.apply(this, args);
        });
        let cluster: ReturnType<typeof evaluateV08A19RangedCornerPlacementCluster>;
        try {
            cluster = evaluateV08A19RangedCornerPlacementCluster("ground-control", 0, 819_024_611, 1);
        } finally {
            observer.mockRestore();
        }
        expect(searched.filter((count) => count > 0)).toHaveLength(4);
        expect(cluster.games.every((game) => game.laps >= 1 && game.endReason === "turn_cap")).toBe(true);
        expect(cluster.games.map((game) => game.id)).toEqual(
            V08_A19_RANGED_CORNER_PLACEMENT_AB_SCHEDULE.map((schedule) => schedule.id),
        );
        expect(new Set(cluster.games.map((game) => game.seed))).toEqual(new Set([4_173_708_502]));
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
