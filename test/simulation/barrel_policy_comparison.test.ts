import { describe, expect, test } from "bun:test";
import {
    barrelArtifactValuePlan,
    barrelComparisonPlan,
    summarizeBarrelArtifactValue,
    summarizeBarrelComparison,
} from "../../src/simulation/barrel_policy_comparison";
import { Tier1Artifact, TIER1_ARTIFACT_LIST } from "../../src/artifacts/artifact_properties";
import type { BarrelFightResult } from "../../src/simulation/measure_barrel_use_worker";

describe("barrel policy paired measurement", () => {
    test("artifact calibration balances every live alternative across cohorts, maps, seats and assignments", () => {
        const clusters = 7 * 3 * TIER1_ARTIFACT_LIST.length;
        const plan = barrelArtifactValuePlan(clusters, 123, "work");
        expect(plan).toHaveLength(clusters * 4);
        const cells = new Map<string, number>();
        for (const request of plan) {
            const e = request.experiment!;
            expect(e.study).toBe("artifact-value");
            expect(e.ownership).toBe("value-swap");
            expect(e.map).not.toBe(2);
            const key = `${request.cohort}:${e.map}:${e.competitorArtifact}:${request.greenIsArmyA}:${e.treatment}`;
            cells.set(key, (cells.get(key) ?? 0) + 1);
        }
        expect(cells.size).toBe(plan.length);
        expect([...cells.values()].every((n) => n === 1)).toBe(true);
    });
    test("covers the full matrix without confounding treatment with seat, seed or army", () => {
        const plan = barrelComparisonPlan(112, 42, "work");
        expect(plan).toHaveLength(448);
        expect(new Set(plan.map((request) => request.experiment!.id)).size).toBe(448);
        const conditions = new Set<string>();
        for (let cluster = 0; cluster < 112; cluster++) {
            const games = plan.filter((request) => request.experiment!.cluster === cluster);
            conditions.add(`${games[0].cohort}:${games[0].experiment!.map}:${games[0].experiment!.ownership}`);
            expect(
                new Set(
                    games.map(
                        (request) => `${request.pair}:${request.baseSeed}:${request.matchupGames}:${request.cohort}`,
                    ),
                ).size,
            ).toBe(1);
            expect(
                new Set(games.map((request) => `${request.greenIsArmyA}:${request.experiment!.treatment}`)).size,
            ).toBe(4);
            expect(games[0].experiment!.treatment).not.toBe(games[2].experiment!.treatment);
        }
        expect(conditions.size).toBe(112);
    });

    test("records the narrower candidate separately from full shot projection", () => {
        expect(
            barrelComparisonPlan(1, 42, "work", "own").every((request) => request.experiment!.policy === "own"),
        ).toBe(true);
    });

    const results = () =>
        barrelComparisonPlan(2, 42, "work").map((request): BarrelFightResult => ({
            cohort: request.cohort,
            pair: request.pair,
            map: request.experiment!.map,
            experiment: request.experiment,
            candidateSide: request.greenIsArmyA ? "green" : "red",
            candidateScore: request.experiment!.treatment ? (request.pair === 0 ? 1 : 0) : 0.5,
            winner: "draw",
            elapsedMs: 100,
            ownBarrelStrikesBySide: { green: 1, red: 2 },
            placed: 4,
            placedGreen: 2,
            placedRed: 2,
            greenRanged: 1,
            redRanged: 1,
            barrelStrikes: 3,
            ownBarrelStrikes: 3,
            enemyBarrelStrikes: 0,
            barrelRejections: 0,
            otherObstacleStrikes: 0,
            otherObstacleRejections: 0,
            otherRejections: 0,
            engineRejections: 0,
            unclassifiedRejections: 0,
            endReason: "elimination",
            laps: 10,
            barrelRejectionCounts: {},
            otherRejectionCounts: {},
            barrelRejectionSamples: [],
        }));

    test("draw-aware delta and uncertainty count roster clusters, not correlated games", () => {
        const summary = summarizeBarrelComparison(results());
        expect(summary.overall.clusters).toBe(2);
        expect(summary.overall.control.score).toBe(0.5);
        expect(summary.overall.treatment.score).toBe(0.5);
        expect(summary.overall.scoreDelta).toBe(0);
        expect(summary.overall.approximate95CI).toEqual([-0.98, 0.98]);
        expect(summary.overall.treatment.candidateOwnBarrelStrikes).toBe(6);
    });

    test("artifact scores invert the non-barrel arm and exclude self-controls from the estimate", () => {
        const games = results().map((game) => ({
            ...game,
            candidateScore: game.experiment!.treatment ? 1 : 0,
            experiment: {
                ...game.experiment!,
                study: "artifact-value" as const,
                competitorArtifact: game.pair === 0 ? Tier1Artifact.IRON_PLATE : Tier1Artifact.BARREL_BARRICADE,
            },
        }));
        const summary = summarizeBarrelArtifactValue(games);
        expect(summary.againstLiveAlternatives.score).toBe(1);
        expect(summary.againstLiveAlternatives.clusters).toBe(1);
        expect(summary.selfControl.clusters).toBe(1);
        expect(summary.byArtifact[Tier1Artifact.IRON_PLATE].score).toBe(1);
    });

    test("an all-equal pilot does not report a zero-width confidence interval", () => {
        const games = results().map((game) => ({ ...game, candidateScore: 0.5 }));
        const summary = summarizeBarrelComparison(games);
        expect(summary.overall.scoreDelta).toBe(0);
        expect(summary.overall.approximate95CI).toBeNull();
        expect(summary.noBarrelTracePairsChecked).toBe(0);
    });

    test("partial clusters never bias the interim result and duplicates are rejected", () => {
        const games = results();
        const summary = summarizeBarrelComparison(games.slice(0, 7));
        expect(summary.incompleteClusters).toBe(1);
        expect(summary.overall.clusters).toBe(1);
        expect(summary.overall.scoreDelta).toBe(0.5);
        expect(summary.overall.approximate95CI).toBeNull();
        expect(() => summarizeBarrelComparison([...games, games[0]])).toThrow("Duplicate");
        expect(() => barrelComparisonPlan(0, 1, "work")).toThrow();
        expect(() => barrelComparisonPlan(1, NaN, "work")).toThrow();
    });
});
