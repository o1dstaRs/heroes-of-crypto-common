import { describe, expect, test } from "bun:test";

import { evaluateRankedDraftVarietyGates, varietyEntrants } from "../../src/simulation/measure_ranked_draft_variety";
import type { IRankedDraftEvaluationReport } from "../../src/simulation/ranked_draft_eval";

const report = (wins: number, losses: number, draws: number, lowerBound: number): IRankedDraftEvaluationReport => {
    const { candidate, incumbent } = varietyEntrants();
    const games = wins + losses + draws;
    return {
        schemaVersion: 1,
        status: "research_only_no_bake",
        candidateId: candidate.id,
        totalGames: games,
        options: {} as IRankedDraftEvaluationReport["options"],
        opponents: [
            {
                opponentId: incumbent.id,
                games,
                offerBoards: games / 4,
                wins,
                losses,
                draws,
                decisiveGames: wins + losses,
                decisiveWinRate: wins / (wins + losses),
                confidence95: { low: lowerBound, high: 1 },
                clusteredLowerBound: lowerBound,
                drawOrArmageddonRate: draws / games,
                rejectedCandidate: 0,
                rejectedOpponent: 0,
                avgLaps: 1,
                endReasons: { elimination: games, turn_cap: 0, stuck: 0 },
            },
        ],
        maps: [],
        cohortDefinitions: {} as IRankedDraftEvaluationReport["cohortDefinitions"],
        cohorts: [],
        aggregate: {
            fitness: lowerBound,
            worstCaseLowerBound: lowerBound,
            worstCaseOpponent: incumbent.id,
            rejectedCandidate: 0,
            rejectedOpponent: 0,
            drawOrArmageddonRate: draws / games,
            avgLaps: 1,
            endReasons: { elimination: games, turn_cap: 0, stuck: 0 },
            behaviorTraceSetSha256: "0".repeat(64),
        },
        qualification: "test",
    };
};

describe("ranked draft variety acceptance gate", () => {
    test("requires a strictly winning draw-aware average and confidence support", () => {
        const pass = evaluateRankedDraftVarietyGates(report(5, 3, 0, 0.51));
        expect(pass.verdict).toBe("PASS");
        expect(pass.policy).toBe("public-context-archetype-flex-v3");

        const weakConfidence = evaluateRankedDraftVarietyGates(report(5, 3, 0, 0.5));
        expect(weakConfidence.verdict).toBe("FAIL");
        expect(weakConfidence.gates.find((gate) => gate.name === "clustered_lower_bound")?.passed).toBe(false);
    });
});
