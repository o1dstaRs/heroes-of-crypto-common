/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import {
    buildWorkerPlan,
    canAdmitJobBatches,
    effectiveBehaviorEnvironment,
    estimateBatchDurationMs,
    estimateJobBatchesDurationMs,
    isV08CampaignManifestProvenanceCurrent,
    isV08CampaignPromotionEligible,
    isV08CampaignPromotionStrengthQualified,
    jobWorkUnits,
    rankV08CampaignResearchCandidates,
    selectValidationCandidateIds,
    summarizeV08CampaignArmageddonJsonl,
    type IJobDurationSample,
    V08_CAMPAIGN_ADAPTIVE_GENERATOR_VERSION,
    V08_CAMPAIGN_DEFAULT_LANES,
    V08_CAMPAIGN_SCHEMA,
} from "../../src/simulation/v0_8_aggressive_12h";
import type { IV08AlignedV1CandidateBinding } from "../../src/simulation/optimizer/v0_8_aligned_96h_v1_protocol";

describe("v0.8 aggressive campaign orchestration", () => {
    it("treats concurrency as one host-wide worker budget", () => {
        expect(V08_CAMPAIGN_DEFAULT_LANES).toBe(3);
        expect(buildWorkerPlan(12, 3)).toEqual({ coreBudget: 12, lanes: 3, workersPerJob: 4, maxWorkers: 12 });
        expect(buildWorkerPlan(16, 3)).toEqual({ coreBudget: 16, lanes: 3, workersPerJob: 5, maxWorkers: 15 });
        expect(buildWorkerPlan(12, 1)).toEqual({ coreBudget: 12, lanes: 1, workersPerJob: 12, maxWorkers: 12 });
        expect(() => buildWorkerPlan(2, 3)).toThrow("lanes cannot exceed");
    });

    it("freezes validation around covered candidates even when none currently passes Armageddon", () => {
        const rows = [
            {
                candidateId: "screen-only",
                candidateIndex: 0,
                decisiveWinRate: 0.9,
                nonLossArmageddonRate: 0,
                level4CoveragePassed: false,
            },
            {
                candidateId: "covered-a",
                candidateIndex: 1,
                decisiveWinRate: 0.7,
                nonLossArmageddonRate: 0,
                level4CoveragePassed: true,
            },
            {
                candidateId: "covered-b",
                candidateIndex: 2,
                decisiveWinRate: 0.6,
                nonLossArmageddonRate: 0,
                level4CoveragePassed: true,
            },
            {
                candidateId: "covered-c",
                candidateIndex: 3,
                decisiveWinRate: 0.5,
                nonLossArmageddonRate: 0,
                level4CoveragePassed: true,
            },
        ];
        expect(selectValidationCandidateIds(rows, 2)).toEqual(["covered-a", "covered-b"]);
        expect(selectValidationCandidateIds(rows, 2)).toEqual(["covered-a", "covered-b"]);
        expect(() => selectValidationCandidateIds(rows, 0)).toThrow("must be positive");
    });

    it("keeps a measured win improvement ahead of flat Armageddon avoidance", () => {
        const games = 256;
        const armWin = {
            candidateId: "arm-win",
            candidateIndex: 1,
            decisiveWinRate: 151 / games,
            nonLossArmageddonRate: 1 / games,
        };
        const earlierLoss = {
            candidateId: "earlier-loss",
            candidateIndex: 0,
            decisiveWinRate: 150 / games,
            nonLossArmageddonRate: 0,
        };

        expect(armWin.decisiveWinRate - 2 * armWin.nonLossArmageddonRate).toBeLessThan(earlierLoss.decisiveWinRate);
        expect(rankV08CampaignResearchCandidates([earlierLoss, armWin])[0]?.candidateId).toBe("arm-win");
    });

    it("uses non-loss Armageddon only after equal decisive outcomes", () => {
        const clean = {
            candidateId: "clean",
            candidateIndex: 2,
            decisiveWinRate: 0.6,
            nonLossArmageddonRate: 0,
        };
        const arm = { ...clean, candidateId: "arm", candidateIndex: 1, nonLossArmageddonRate: 1 / 256 };
        expect(rankV08CampaignResearchCandidates([arm, clean])[0]?.candidateId).toBe("clean");
    });

    it("does not reward an earlier loss by counting Armageddon losses in research rank", () => {
        const survivedToArmageddon = {
            candidateId: "survived",
            candidateIndex: 0,
            decisiveWinRate: 0.6,
            nonLossArmageddonRate: 0,
            armageddonReachedCandidateLosses: 4,
        };
        const lostEarlier = {
            candidateId: "lost-earlier",
            candidateIndex: 1,
            decisiveWinRate: 0.6,
            nonLossArmageddonRate: 0,
            armageddonReachedCandidateLosses: 0,
        };
        expect(rankV08CampaignResearchCandidates([lostEarlier, survivedToArmageddon])[0]?.candidateId).toBe("survived");
    });

    it("attributes retained Armageddon records by candidate outcome", () => {
        const row = (winnerVersion: string, reachedArmageddon: boolean): string =>
            JSON.stringify({ winnerVersion, result: { attrition: { reachedArmageddon } } });
        const buckets = summarizeV08CampaignArmageddonJsonl(
            [row("v0.8s", true), row("draw", true), row("v0.7", true), row("unknown", false)].join("\n"),
        );
        expect(buckets).toEqual({ total: 3, candidateWins: 1, draws: 1, candidateLosses: 1 });
        expect(() => summarizeV08CampaignArmageddonJsonl(row("unknown", true))).toThrow("unknown winnerVersion");
    });

    it("does not let a lucky-zero Armageddon gate pre-empt validation strength", () => {
        const luckyZero = {
            candidateId: "lucky-zero",
            candidateIndex: 0,
            decisiveWinRate: 0.55,
            nonLossArmageddonRate: 0,
            level4CoveragePassed: true,
            passesArmageddonGate: true,
        };
        const stronger = {
            candidateId: "stronger",
            candidateIndex: 1,
            decisiveWinRate: 0.6,
            nonLossArmageddonRate: 1 / 256,
            level4CoveragePassed: true,
            passesArmageddonGate: false,
        };
        expect(selectValidationCandidateIds([luckyZero, stronger], 1)).toEqual(["stronger"]);
    });

    it("records an explicit unbounded timing profile instead of inheriting wall-clock policy changes", () => {
        const binding = {
            behaviorEnvironment: {
                SEARCH_DECISION_DEADLINE_MS: "150",
                SEARCH_CIRCUIT_BREAKER_MS: "275",
                SEARCH_GATE: "0.025",
            },
        } as unknown as IV08AlignedV1CandidateBinding;
        const bounded = effectiveBehaviorEnvironment(binding, "audit.jsonl", false);
        const unbounded = effectiveBehaviorEnvironment(binding, "audit.jsonl", true);

        expect(bounded.SEARCH_DECISION_DEADLINE_MS).toBe("150");
        expect(bounded.SEARCH_CIRCUIT_BREAKER_MS).toBe("275");
        expect(unbounded.SEARCH_DECISION_DEADLINE_MS).toBe("");
        expect(unbounded.SEARCH_CIRCUIT_BREAKER_MS).toBe("");
        expect(unbounded.SEARCH_GATE).toBe("0.025");
        expect(unbounded.V08_AGGRESSIVE).toBe("1");
    });

    it("blocks promotion for unbounded fitness and for Armageddon in forced level-4 coverage", () => {
        const cleanBounded = {
            unboundedSearch: false,
            hasValidationEvidence: true,
            level4CoveragePassed: true,
            decisiveWinRate: 0.6,
            armageddonRate: 0,
            level4ArmageddonRate: 0,
        };
        expect(isV08CampaignPromotionEligible(cleanBounded)).toBe(true);
        expect(isV08CampaignPromotionEligible({ ...cleanBounded, unboundedSearch: true })).toBe(false);
        expect(isV08CampaignPromotionEligible({ ...cleanBounded, level4ArmageddonRate: 0.01 })).toBe(false);
        expect(isV08CampaignPromotionEligible({ ...cleanBounded, armageddonRate: 0.01 })).toBe(false);
        expect(isV08CampaignPromotionEligible({ ...cleanBounded, hasValidationEvidence: false })).toBe(false);
    });

    it("requires explicit incumbent-relative strength evidence for promotion", () => {
        expect(isV08CampaignPromotionStrengthQualified(0.5)).toBe(true);
        expect(isV08CampaignPromotionStrengthQualified(0.499)).toBe(false);
        expect(
            isV08CampaignPromotionStrengthQualified(0.62, {
                incumbentDecisiveWinRate: 0.6,
                minimumCandidateDelta: 0.02,
            }),
        ).toBe(true);
        expect(
            isV08CampaignPromotionStrengthQualified(0.619, {
                incumbentDecisiveWinRate: 0.6,
                minimumCandidateDelta: 0.02,
            }),
        ).toBe(false);
        expect(() =>
            isV08CampaignPromotionStrengthQualified(0.7, {
                incumbentDecisiveWinRate: 0.5,
                minimumCandidateDelta: -0.01,
            }),
        ).toThrow("Invalid");
    });

    it("fails old campaign manifests closed after the ranking provenance bump", () => {
        expect(V08_CAMPAIGN_SCHEMA).toBe("hoc.v0_8_aggressive_campaign.v4");
        expect(V08_CAMPAIGN_ADAPTIVE_GENERATOR_VERSION).toBe(2);
        expect(
            isV08CampaignManifestProvenanceCurrent({
                schema: V08_CAMPAIGN_SCHEMA,
                kind: "manifest",
                adaptive: { generatorVersion: V08_CAMPAIGN_ADAPTIVE_GENERATOR_VERSION },
            }),
        ).toBe(true);
        expect(
            isV08CampaignManifestProvenanceCurrent({
                schema: "hoc.v0_8_aggressive_campaign.v3",
                kind: "manifest",
                adaptive: { generatorVersion: 1 },
            }),
        ).toBe(false);
        expect(
            isV08CampaignManifestProvenanceCurrent({
                schema: V08_CAMPAIGN_SCHEMA,
                kind: "manifest",
                adaptive: { generatorVersion: 1 },
            }),
        ).toBe(false);
    });

    it("normalizes tournament and forced level-4 work to simulated games", () => {
        expect(jobWorkUnits({ kind: "screen", games: 256 })).toBe(256);
        expect(jobWorkUnits({ kind: "validation", games: 1_024 })).toBe(1_024);
        expect(jobWorkUnits({ kind: "level4", pairsPerLane: 16 })).toBe(256);
        expect(() => jobWorkUnits({ kind: "level4", games: 16 })).toThrow("pairsPerLane");
        expect(() => jobWorkUnits({ kind: "adaptive", pairsPerLane: 2 })).toThrow("games");
    });

    it("uses conservative fallback and matching-kind p95 duration history", () => {
        const validation = { kind: "validation" as const, games: 100 };
        expect(estimateBatchDurationMs([validation, validation], [], 4)).toBe(50_000);

        const sparse: IJobDurationSample[] = [
            { ...validation, durationMs: 40_000 },
            { ...validation, durationMs: 75_000 },
            { kind: "screen", games: 100, durationMs: 900_000 },
        ];
        expect(estimateBatchDurationMs([validation], sparse, 4)).toBe(75_000);

        const populated: IJobDurationSample[] = Array.from({ length: 19 }, () => ({
            ...validation,
            durationMs: 60_000,
        }));
        populated.push({ ...validation, durationMs: 500_000 });
        expect(estimateBatchDurationMs([validation], populated, 4)).toBe(60_000);
    });

    it("admits an entire validation round, not merely its first parallel batch", () => {
        const batch = [
            { kind: "validation" as const, games: 100 },
            { kind: "validation" as const, games: 100 },
            { kind: "validation" as const, games: 100 },
        ];
        const round = [batch, [{ kind: "validation" as const, games: 100 }]];
        expect(estimateJobBatchesDurationMs(round, [], 4)).toBe(100_000);
        expect(
            canAdmitJobBatches({
                batches: round,
                completed: [],
                workersPerJob: 4,
                nowMs: 1_000,
                deadlineAtMs: 130_999,
            }),
        ).toBe(false);
        expect(
            canAdmitJobBatches({
                batches: round,
                completed: [],
                workersPerJob: 4,
                nowMs: 1_000,
                deadlineAtMs: 131_000,
            }),
        ).toBe(true);
        expect(
            canAdmitJobBatches({
                batches: [batch],
                completed: [],
                workersPerJob: 4,
                nowMs: 1_000,
                deadlineAtMs: 90_000,
            }),
        ).toBe(true);
    });
});
