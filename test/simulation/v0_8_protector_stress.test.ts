import { describe, expect, test } from "bun:test";

import {
    V08_PROTECTOR_STRESS_MATRIX_GAMES,
    V08_PROTECTOR_STRESS_SCHEMA,
    emptyV08ProtectorStressMetrics,
    percentileMs,
    planV08ProtectorStressGame,
    runV08ProtectorStressGame,
    summarizeV08ProtectorStress,
    type IV08ProtectorStressOptions,
    type IV08ProtectorStressRecord,
} from "../../src/simulation/v0_8_protector_stress";

const options: IV08ProtectorStressOptions = {
    games: V08_PROTECTOR_STRESS_MATRIX_GAMES,
    baseSeed: 12345,
    concurrency: 4,
    maxLaps: 60,
};

describe("v0.8 protector stress mapping", () => {
    test("pairs identical scenarios and combat seeds across physical seats", () => {
        for (let game = 0; game < 20; game += 2) {
            const green = planV08ProtectorStressGame(options, game);
            const red = planV08ProtectorStressGame(options, game + 1);
            expect(red).toMatchObject({
                seed: green.seed,
                mapType: green.mapType,
                protector: green.protector,
                ward: green.ward,
                threat: green.threat,
                selectedProtectorName: green.selectedProtectorName,
                protectorSide: "red",
            });
            expect(green.protectorSide).toBe("green");
            expect(green.greenRoster.map((unit) => unit.creatureName)).toEqual(
                red.redRoster.map((unit) => unit.creatureName),
            );
            expect(green.redRoster.map((unit) => unit.creatureName)).toEqual(
                red.greenRoster.map((unit) => unit.creatureName),
            );
        }
    });

    test("one 144-game cycle covers every protector/ward/threat/map/seat cell exactly once", () => {
        const cells = new Set<string>();
        for (let game = 0; game < V08_PROTECTOR_STRESS_MATRIX_GAMES; game += 1) {
            const plan = planV08ProtectorStressGame(options, game);
            cells.add([plan.protector, plan.ward, plan.threat, plan.mapType, plan.protectorSide].join(":"));
        }
        expect(cells.size).toBe(144);
    });

    test("production draft takes Queen only when the public opponent includes flyer pressure", () => {
        for (let game = 0; game < V08_PROTECTOR_STRESS_MATRIX_GAMES; game += 2) {
            const plan = planV08ProtectorStressGame(options, game);
            if (plan.protector !== "arachna_queen") continue;
            expect(plan.queenDrafted).toBe(plan.threat !== "rusher");
            expect(plan.selectedProtectorName).toBe(plan.threat === "rusher" ? "Champion" : "Arachna Queen");
        }
    });
});

describe("v0.8 protector stress summary", () => {
    const record = (game: number, patch: Partial<IV08ProtectorStressRecord> = {}): IV08ProtectorStressRecord => {
        const plan = planV08ProtectorStressGame(options, game);
        return {
            schema: V08_PROTECTOR_STRESS_SCHEMA,
            game,
            seed: plan.seed,
            mapType: plan.mapType,
            matrixCycle: plan.matrixCycle,
            matrixCombination: plan.matrixCombination,
            protector: plan.protector,
            ward: plan.ward,
            threat: plan.threat,
            protectorSide: plan.protectorSide,
            selectedProtectorName: plan.selectedProtectorName,
            queenDraftExpected: plan.queenDraftExpected,
            queenDrafted: plan.queenDrafted,
            draftMismatch: 0,
            winner: "green",
            endReason: "elimination",
            laps: 4,
            rejectedActions: 0,
            protectedSideRejectedActions: 0,
            rejectionsByCause: {},
            metrics: emptyV08ProtectorStressMetrics(),
            ...patch,
        };
    };

    test("uses deterministic nearest-rank decision latency percentiles", () => {
        expect(percentileMs([], 0.95)).toBeNull();
        expect(percentileMs([1_000, 2_000, 3_000, 4_000, 100_000], 0.5)).toBe(3);
        expect(percentileMs([1_000, 2_000, 3_000, 4_000, 100_000], 0.95)).toBe(100);
        expect(() => percentileMs([1], 2)).toThrow("Quantile");
    });

    test("folds rejection causes, safety invariants, and timing samples without losing games", () => {
        const first = record(0);
        first.metrics.protectorTurns = 2;
        first.metrics.constrainedTurns = 2;
        first.metrics.coveredAfterAction = 2;
        first.metrics.abominationCoverageGapTurns = 1;
        first.metrics.blockedCatchUpTurns = 1;
        first.metrics.allDecisionLatencyMicros = [1_000, 2_000];
        first.metrics.protectorDecisionLatencyMicros = [2_000];
        const second = record(1, {
            rejectedActions: 1,
            protectedSideRejectedActions: 1,
            rejectionsByCause: { terrifying_gaze: 1 },
        });
        second.metrics.guardBreakingFinalActions = 1;
        second.metrics.rushViolations = 1;
        second.metrics.wardGuardBreakingFinalActions = 1;
        second.metrics.wardRushViolations = 1;
        second.metrics.allDecisionLatencyMicros = [10_000];
        const summary = summarizeV08ProtectorStress({ ...options, games: 2 }, [second, first]);

        expect(summary.games).toBe(2);
        expect(summary.rejectedActions).toBe(1);
        expect(summary.rejectionsByCause).toEqual({ terrifying_gaze: 1 });
        expect(summary.metrics.protectorTurns).toBe(2);
        expect(summary.metrics.guardBreakingFinalActions).toBe(1);
        expect(summary.decisionLatencyMs).toMatchObject({
            samples: 3,
            p50: 2,
            p95: 10,
            protectorSamples: 1,
            protectorP95: 2,
        });
        expect(summary.gates.pass).toBe(false);
        expect(summary.gates.failed).toContain("zeroRejections");
        expect(summary.gates.failed).toContain("noGuardBreaks");
        expect(summary.gates.failed).toContain("noRushViolations");
        expect(summary.gates.failed).toContain("noWardGuardBreaks");
        expect(summary.gates.failed).toContain("noWardRushViolations");
        expect(summary.gates.exactAbominationRange).toBe(true);
        expect(summary.metrics.abominationCoverageGapTurns).toBe(1);
        expect(summary.metrics.blockedCatchUpTurns).toBe(1);
        expect(summary.failureSamples).toHaveLength(1);
    });
});

describe("v0.8 protector production regressions", () => {
    test("keeps a live Centaur and Battle Mage from melee-rushing out of Flesh Shield", () => {
        for (const game of [60, 72]) {
            const record = runV08ProtectorStressGame({ baseSeed: 80_813_441, maxLaps: 60 }, game);
            expect(record.endReason).not.toBe("crash");
            expect(record.rejectedActions).toBe(0);
            expect(record.metrics.wardGuardBreakingFinalActions).toBe(0);
            expect(record.metrics.wardRushViolations).toBe(0);
            expect(record.metrics.abominationCoverageGapTurns).toBe(0);
            expect(record.metrics.abominationExactRangeViolations).toBe(0);
        }
    });

    test("reports forced narrowing as a blocked gap without mislabeling it as an AI rush", () => {
        const record = runV08ProtectorStressGame({ baseSeed: 80_813_441, maxLaps: 60 }, 36);
        expect(record.rejectedActions).toBe(0);
        expect(record.metrics.abominationCoverageGapTurns).toBeGreaterThan(0);
        expect(record.metrics.blockedCatchUpTurns).toBeGreaterThan(0);
        expect(record.metrics.abominationExactRangeViolations).toBe(0);
        expect(record.metrics.guardBreakingFinalActions).toBe(0);
        expect(record.metrics.rushViolations).toBe(0);
    });
});
