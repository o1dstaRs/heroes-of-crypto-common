/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import {
    aggregateV07AlignedV2,
    assessV07AlignedV2Final,
    assessV07AlignedV2Promotion,
    defaultV07AlignedV2DryRunConfig,
    evaluateV07AlignedV2OperationalEligibility,
    pairedV07AlignedV2DecisiveGain,
    validateV07AlignedV2DryRunConfig,
    V07_ALIGNED_96H_V2_CELLS,
    V07_ALIGNED_96H_V2_SEATS,
    V07_ALIGNED_V2_FINAL_HYPOTHESES,
    V07_ALIGNED_V2_FINAL_POLICY,
    V07_ALIGNED_V2_PROMOTION_POLICY,
    type IV07AlignedV2ConfirmPair,
    type IV07AlignedV2GameObservation,
    type IV07AlignedV2SearchAudit,
    type V07AlignedV2CandidateSeat,
    type V07AlignedV2CellId,
    type V07AlignedV2Outcome,
} from "../../src/simulation/optimizer/v0_7_aligned_96h_v2_core";

const cleanAudit = (overrides: Partial<IV07AlignedV2SearchAudit> = {}): IV07AlignedV2SearchAudit => ({
    decisions: 10,
    searchedDecisions: 10,
    deadlineFallbacks: 0,
    illegalIncumbents: 0,
    circuitOpened: false,
    circuitSkippedDecisions: 0,
    msTotal: 1000,
    ...overrides,
});

interface IPanelOutcome {
    outcome: V07AlignedV2Outcome;
    reachedArmageddon?: boolean;
    candidateRejections?: number;
    opponentRejections?: number;
    searchAudit?: IV07AlignedV2SearchAudit | null;
}

const panel = (
    gamesPerCellSeat: number,
    outcome: (cellId: V07AlignedV2CellId, seat: V07AlignedV2CandidateSeat, game: number) => IPanelOutcome,
): IV07AlignedV2GameObservation[] =>
    V07_ALIGNED_96H_V2_CELLS.flatMap((cell) =>
        V07_ALIGNED_96H_V2_SEATS.flatMap((seat) =>
            Array.from({ length: gamesPerCellSeat }, (_, game) => {
                const entry = outcome(cell.id, seat, game);
                return {
                    cellId: cell.id,
                    candidateSeat: seat,
                    scenarioId: `scenario-${game}`,
                    outcome: entry.outcome,
                    reachedArmageddon: entry.reachedArmageddon ?? false,
                    ...("candidateRejections" in entry
                        ? { candidateRejections: entry.candidateRejections }
                        : { candidateRejections: 0 }),
                    ...("opponentRejections" in entry
                        ? { opponentRejections: entry.opponentRejections }
                        : { opponentRejections: 0 }),
                    ...(entry.searchAudit === null ? {} : { searchAudit: entry.searchAudit ?? cleanAudit() }),
                };
            }),
        ),
    );

const outcomeByCounts = (game: number, wins: number, losses: number): V07AlignedV2Outcome => {
    if (game < wins) return "candidate_win";
    if (game < wins + losses) return "opponent_win";
    return "draw";
};

const pairedPanels = (
    gamesPerCellSeat: number,
    challengerOutcome: Parameters<typeof panel>[1],
    incumbentOutcome: Parameters<typeof panel>[1],
): IV07AlignedV2ConfirmPair[] => {
    const challenger = panel(gamesPerCellSeat, challengerOutcome);
    const incumbent = panel(gamesPerCellSeat, incumbentOutcome);
    return challenger.map((observation, index) => ({ challenger: observation, incumbent: incumbent[index] }));
};

describe("v0.7 aligned 96-hour v2 core", () => {
    it("registers exactly twelve cells, two seats, and twenty-four formal claims", () => {
        expect(V07_ALIGNED_96H_V2_CELLS).toHaveLength(12);
        expect(V07_ALIGNED_96H_V2_SEATS).toEqual(["candidate_green", "candidate_red"]);
        expect(V07_ALIGNED_V2_FINAL_HYPOTHESES).toBe(24);
        expect(new Set(V07_ALIGNED_96H_V2_CELLS.map((cell) => cell.id)).size).toBe(12);
        expect(V07_ALIGNED_96H_V2_CELLS.filter((cell) => cell.distribution === "ranked_taxonomy")).toHaveLength(4);
        expect(V07_ALIGNED_96H_V2_CELLS.filter((cell) => cell.distribution === "fixed_template")).toHaveLength(8);
    });

    it("exposes the observed 94 percent green / 81 percent red pooled trap", () => {
        const observations = panel(100, (_cellId, seat, game) => ({
            outcome: outcomeByCounts(game, seat === "candidate_green" ? 94 : 81, seat === "candidate_green" ? 6 : 19),
        }));
        const result = aggregateV07AlignedV2(observations, { expectedGamesPerCellSeat: 100 });

        expect(result.complete).toBe(true);
        expect(result.pooled.decisiveWinRate).toBeCloseTo(0.875, 12);
        expect(result.objective).toMatchObject({
            minimumCellSeatDecisiveWinRate: 0.81,
            limitingCandidateSeat: "candidate_red",
        });
        expect(
            result.cellSeats
                .filter((entry) => entry.candidateSeat === "candidate_green")
                .every((entry) => Object.is(entry.decisiveWinRate, 0.94)),
        ).toBe(true);
        expect(
            result.cellSeats
                .filter((entry) => entry.candidateSeat === "candidate_red")
                .every((entry) => Object.is(entry.decisiveWinRate, 0.81)),
        ).toBe(true);
    });

    it("keeps draw-or-Armageddon, integrity, and latency evidence per cell and seat", () => {
        const observations = panel(4, (cellId, seat, game) => ({
            outcome: game === 3 ? "draw" : "candidate_win",
            reachedArmageddon: game === 2,
            candidateRejections: cellId === "ranked_mage" && seat === "candidate_red" && game === 0 ? 1 : 0,
            opponentRejections: 0,
            searchAudit:
                cellId === "ranked_mage" && seat === "candidate_red" && game === 1
                    ? cleanAudit({
                          deadlineFallbacks: 2,
                          illegalIncumbents: 1,
                          circuitOpened: true,
                          circuitSkippedDecisions: 1,
                      })
                    : cleanAudit(),
        }));
        const result = aggregateV07AlignedV2(observations, { expectedGamesPerCellSeat: 4 });
        const affected = result.cellSeats.find(
            (entry) => entry.cellId === "ranked_mage" && entry.candidateSeat === "candidate_red",
        )!;

        expect(affected).toMatchObject({
            games: 4,
            wins: 3,
            draws: 1,
            drawOrArmageddon: 2,
            drawOrArmageddonRate: 0.5,
            candidateRejections: 1,
        });
        expect(affected.latency).toMatchObject({
            deadlineFallbacks: 2,
            illegalIncumbents: 1,
            circuitOpenedGames: 1,
            circuitSkippedDecisions: 1,
            gameMs: { p95: 1000, max: 1000 },
        });
        expect(result.integrity.passed).toBe(false);
        expect(evaluateV07AlignedV2OperationalEligibility(result).passed).toBe(false);
    });

    it("rejects malformed and duplicate raw observations instead of silently pooling them", () => {
        const valid = panel(2, (_cellId, _seat, game) => ({
            outcome: game === 0 ? "candidate_win" : "opponent_win",
        }));
        expect(() => aggregateV07AlignedV2([...valid, valid[0]])).toThrow("duplicate scenario observation");
        expect(() =>
            aggregateV07AlignedV2([
                {
                    ...valid[0],
                    opponentRejections: undefined,
                },
            ]),
        ).toThrow("both rejection counts or neither");
        expect(() =>
            aggregateV07AlignedV2([
                {
                    ...valid[0],
                    searchAudit: cleanAudit({ searchedDecisions: 11 }),
                },
            ]),
        ).toThrow("must not exceed decisions");
        expect(() =>
            aggregateV07AlignedV2([
                {
                    ...valid[0],
                    searchAudit: cleanAudit({ circuitSkippedDecisions: 1 }),
                },
            ]),
        ).toThrow("before the circuit opens");
    });

    it("uses paired decisive-rate influence intervals for confirm gains", () => {
        const pairs = pairedPanels(
            100,
            (_cellId, _seat, game) => ({ outcome: outcomeByCounts(game, 90, 10) }),
            (_cellId, _seat, game) => ({ outcome: outcomeByCounts(game, 80, 20) }),
        ).slice(0, 100);
        const estimate = pairedV07AlignedV2DecisiveGain(pairs)!;

        expect(estimate).toMatchObject({
            pairs: 100,
            challengerDecisive: 100,
            incumbentDecisive: 100,
            challengerRate: 0.9,
            incumbentRate: 0.8,
        });
        expect(estimate.gain).toBeCloseTo(0.1, 12);
        expect(estimate.standardError).toBeGreaterThan(0);
        expect(estimate.confidence.low).toBeGreaterThan(0);
    });

    it("promotes a clean fresh-panel max-min win and certifies every paired stratum", () => {
        const pairs = pairedPanels(
            1000,
            (_cellId, _seat, game) => ({ outcome: outcomeByCounts(game, 900, 100) }),
            (_cellId, _seat, game) => ({ outcome: outcomeByCounts(game, 800, 200) }),
        );
        const result = assessV07AlignedV2Promotion(pairs);

        expect(result.verdict).toBe("PROMOTE");
        expect(result.maxMinGain).toBeCloseTo(0.1, 12);
        expect(result.cellSeatPairedGains).toHaveLength(24);
        expect(result.checks).toMatchObject({
            freshPanelShapePassed: true,
            challengerOperationalPassed: true,
            incumbentOperationalPassed: true,
            pooledGainPassed: true,
            everyCellSeatNoninferior: true,
            maxMinGainPassed: true,
            winLanePassed: true,
        });
    });

    it("treats incumbent search-policy failures as diagnostic while requiring clean incumbent integrity", () => {
        const pairs = pairedPanels(
            1000,
            (_cellId, _seat, game) => ({ outcome: outcomeByCounts(game, 900, 100) }),
            (_cellId, _seat, game) => ({
                outcome: outcomeByCounts(game, 800, 200),
                searchAudit: cleanAudit({
                    deadlineFallbacks: 10,
                    circuitOpened: true,
                    circuitSkippedDecisions: 1,
                }),
            }),
        );
        const result = assessV07AlignedV2Promotion(pairs);

        expect(result.checks).toMatchObject({
            challengerOperationalPassed: true,
            incumbentOperationalPassed: false,
            winLanePassed: true,
        });
        expect(result.verdict).toBe("PROMOTE");
        expect(result.reasons).toEqual([]);

        const corrupted = structuredClone(pairs);
        corrupted[0].incumbent.candidateRejections = 1;
        expect(assessV07AlignedV2Promotion(corrupted).verdict).toBe("HOLD");
    });

    it("holds a pooled improvement when one candidate seat regresses", () => {
        const pairs = pairedPanels(
            1000,
            (cellId, seat, game) => ({
                outcome: outcomeByCounts(
                    game,
                    cellId === "ranked_ranged" && seat === "candidate_red" ? 600 : 900,
                    cellId === "ranked_ranged" && seat === "candidate_red" ? 400 : 100,
                ),
            }),
            (_cellId, _seat, game) => ({ outcome: outcomeByCounts(game, 800, 200) }),
        );
        const result = assessV07AlignedV2Promotion(pairs);

        expect(result.pooledPairedGain?.gain).toBeGreaterThan(0);
        expect(result.verdict).toBe("HOLD");
        expect(result.checks.everyCellSeatNoninferior).toBe(false);
        expect(result.checks.maxMinGainPassed).toBe(false);
        expect(
            result.cellSeatPairedGains.find(
                (entry) => entry.cellId === "ranked_ranged" && entry.candidateSeat === "candidate_red",
            )?.noninferiorityPassed,
        ).toBe(false);
    });

    it("allows the integrity lane to ratchet Armageddon attrition without win regression", () => {
        const pairs = pairedPanels(
            1000,
            (_cellId, _seat, game) => ({ outcome: outcomeByCounts(game, 900, 100), reachedArmageddon: false }),
            (_cellId, _seat, game) => ({
                outcome: outcomeByCounts(game, 900, 100),
                reachedArmageddon: game < 500,
            }),
        );
        const result = assessV07AlignedV2Promotion(pairs);

        expect(result.maxMinGain).toBe(0);
        expect(result.maximumDrawOrArmageddonReduction).toBe(0.5);
        expect(result.checks).toMatchObject({
            winLanePassed: false,
            integrityReductionPassed: true,
            everyCellSeatNoninferior: true,
            integrityLanePassed: true,
        });
        expect(result.verdict).toBe("PROMOTE");
    });

    it("emits a simultaneous 24-claim research-only PASS with no bake or deploy", () => {
        const observations = panel(2000, () => ({ outcome: "candidate_win" }));
        const terminal = assessV07AlignedV2Final(observations);

        expect(terminal).toMatchObject({
            status: "research_only_no_bake",
            candidate: "v0.7s",
            opponent: "v0.6",
            automaticBake: false,
            automaticDeploy: false,
            hypotheses: 24,
            verdict: "PASS",
            checks: {
                exactRegisteredFamily: true,
                integrityPassed: true,
                operationalPassed: true,
                everyCellSeatPassed: true,
            },
        });
        expect(terminal.claims).toHaveLength(24);
        expect(terminal.claims.every((claim) => claim.wilson!.low >= 0.9)).toBe(true);
    });

    it("fails final qualification on a weak red seat even when green is strong", () => {
        const observations = panel(2000, (cellId, seat, game) => ({
            outcome: outcomeByCounts(
                game,
                cellId === "fixed_ranged_control" && seat === "candidate_red" ? 1620 : 2000,
                cellId === "fixed_ranged_control" && seat === "candidate_red" ? 380 : 0,
            ),
        }));
        const terminal = assessV07AlignedV2Final(observations);
        const weak = terminal.claims.find(
            (claim) => claim.cellId === "fixed_ranged_control" && claim.candidateSeat === "candidate_red",
        )!;

        expect(terminal.verdict).toBe("FAIL");
        expect(weak.decisiveWinRate).toBe(0.81);
        expect(weak.checks.decisiveWilsonLowPassed).toBe(false);
        expect(weak.passed).toBe(false);
    });

    it("fails final qualification on incomplete telemetry, attrition, or latency", () => {
        const observations = panel(2000, (cellId, seat, game) => ({
            outcome: "candidate_win",
            reachedArmageddon: cellId === "ranked_aura" && seat === "candidate_red" && game < 201,
            searchAudit:
                cellId === "ranked_mage" && seat === "candidate_green" && game === 0
                    ? cleanAudit({ deadlineFallbacks: 10 })
                    : cellId === "ranked_ranged" && seat === "candidate_red" && game === 0
                      ? null
                      : cleanAudit(),
        }));
        const terminal = assessV07AlignedV2Final(observations);

        expect(terminal.verdict).toBe("FAIL");
        expect(terminal.checks.operationalPassed).toBe(false);
        expect(
            terminal.claims.find((claim) => claim.cellId === "ranked_aura" && claim.candidateSeat === "candidate_red")
                ?.checks.drawOrArmageddonPassed,
        ).toBe(false);
    });

    it("validates an inert Zinc-sized dry run and rejects unsafe mutations", () => {
        const config = defaultV07AlignedV2DryRunConfig();
        expect(validateV07AlignedV2DryRunConfig(config)).toEqual({ valid: true, errors: [] });
        expect(validateV07AlignedV2DryRunConfig(null)).toEqual({ valid: false, errors: ["config must be an object"] });
        expect(validateV07AlignedV2DryRunConfig({})).toMatchObject({ valid: false });

        const unsafe = structuredClone(config);
        Reflect.set(unsafe, "automaticDeploy", true);
        Reflect.set(unsafe, "unexpected", true);
        unsafe.compute.workers = 48;
        unsafe.cells = unsafe.cells.slice(1);
        unsafe.profile.decisionDeadlineMs = 201 as 200;
        const result = validateV07AlignedV2DryRunConfig(unsafe);
        expect(result.valid).toBe(false);
        expect(result.errors).toEqual(
            expect.arrayContaining([
                "cells must be the exact canonical twelve-cell registry",
                "config must contain exactly the registered top-level fields",
                "aligned v2 is research-only and must disable automatic bake/deploy",
                "profile must bind the conservative 200ms deadline and 275ms circuit breaker",
                "workers plus reservedLogicalCpus exceed hostLogicalCpus",
            ]),
        );
    });

    it("rejects caller attempts to weaken preregistered statistical policies", () => {
        expect(() =>
            assessV07AlignedV2Promotion([], {
                ...V07_ALIGNED_V2_PROMOTION_POLICY,
                requiredPairsPerCellSeat: 999,
            }),
        ).toThrow("requiredPairsPerCellSeat must be an integer >= 1000");
        expect(() =>
            assessV07AlignedV2Final([], {
                ...V07_ALIGNED_V2_FINAL_POLICY,
                formalZ: 1.96,
            }),
        ).toThrow("formalZ cannot weaken");
    });
});
