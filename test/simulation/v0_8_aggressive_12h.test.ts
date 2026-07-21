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
    estimateDynamicQueueDurationMs,
    estimateJobBatchesDurationMs,
    isV08CampaignValidationEvidenceCommitted,
    isV08CampaignManifestProvenanceCurrent,
    isV08CampaignPromotionEligible,
    isV08CampaignPromotionStrengthQualified,
    jobWorkUnits,
    rankV08CampaignResearchCandidates,
    runV08CampaignDynamicQueue,
    selectValidationCandidateIds,
    summarizeV08CampaignArmageddonJsonl,
    type IJobDurationSample,
    V08_CAMPAIGN_ADAPTIVE_GENERATOR_VERSION,
    V08_CAMPAIGN_DEFAULT_LANES,
    V08_CAMPAIGN_SCHEMA,
    V08_CAMPAIGN_SCHEDULER_VERSION,
} from "../../src/simulation/v0_8_aggressive_12h";
import type { IV08AlignedV1CandidateBinding } from "../../src/simulation/optimizer/v0_8_aligned_96h_v1_protocol";

const flushMicrotasks = async (): Promise<void> => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
};

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
                candidateWinRate: 0.9,
                drawRate: 0,
                nonLossArmageddonRate: 0,
                level4CoveragePassed: false,
            },
            {
                candidateId: "covered-a",
                candidateIndex: 1,
                candidateWinRate: 0.7,
                drawRate: 0,
                nonLossArmageddonRate: 0,
                level4CoveragePassed: true,
            },
            {
                candidateId: "covered-b",
                candidateIndex: 2,
                candidateWinRate: 0.6,
                drawRate: 0,
                nonLossArmageddonRate: 0,
                level4CoveragePassed: true,
            },
            {
                candidateId: "covered-c",
                candidateIndex: 3,
                candidateWinRate: 0.5,
                drawRate: 0,
                nonLossArmageddonRate: 0,
                level4CoveragePassed: true,
            },
        ];
        expect(selectValidationCandidateIds(rows, 2)).toEqual(["covered-a", "covered-b"]);
        expect(selectValidationCandidateIds(rows, 2)).toEqual(["covered-a", "covered-b"]);
        expect(() => selectValidationCandidateIds(rows, 0)).toThrow("must be positive");
    });

    it("ranks the exact c31 outcome above c39 instead of inflating decisive rate with draws", () => {
        const games = 256;
        const c39 = {
            candidateId: "c39",
            candidateIndex: 39,
            candidateWinRate: 143 / games,
            drawRate: 5 / games,
            nonLossArmageddonRate: 4 / games,
        };
        const c31 = {
            candidateId: "c31",
            candidateIndex: 31,
            candidateWinRate: 145 / games,
            drawRate: 1 / games,
            nonLossArmageddonRate: 1 / games,
        };
        expect(rankV08CampaignResearchCandidates([c39, c31])[0]?.candidateId).toBe("c31");
    });

    it("keeps an Armageddon win above a loss", () => {
        const armWin = {
            candidateId: "arm-win",
            candidateIndex: 1,
            candidateWinRate: 1,
            drawRate: 0,
            nonLossArmageddonRate: 1,
        };
        const loss = {
            candidateId: "loss",
            candidateIndex: 0,
            candidateWinRate: 0,
            drawRate: 0,
            nonLossArmageddonRate: 0,
        };
        expect(rankV08CampaignResearchCandidates([loss, armWin])[0]?.candidateId).toBe("arm-win");
    });

    it("keeps an Armageddon draw above a loss", () => {
        const armDraw = {
            candidateId: "arm-draw",
            candidateIndex: 1,
            candidateWinRate: 0,
            drawRate: 1,
            nonLossArmageddonRate: 1,
        };
        const loss = {
            candidateId: "loss",
            candidateIndex: 0,
            candidateWinRate: 0,
            drawRate: 0,
            nonLossArmageddonRate: 0,
        };
        expect(rankV08CampaignResearchCandidates([loss, armDraw])[0]?.candidateId).toBe("arm-draw");
    });

    it("uses non-loss Armageddon only after equal all-game win and draw outcomes", () => {
        const clean = {
            candidateId: "clean",
            candidateIndex: 2,
            candidateWinRate: 0.6,
            drawRate: 0.1,
            nonLossArmageddonRate: 0,
        };
        const arm = { ...clean, candidateId: "arm", candidateIndex: 1, nonLossArmageddonRate: 1 / 256 };
        expect(rankV08CampaignResearchCandidates([arm, clean])[0]?.candidateId).toBe("clean");
    });

    it("does not reward an earlier loss by counting Armageddon losses in research rank", () => {
        const survivedToArmageddon = {
            candidateId: "survived",
            candidateIndex: 0,
            candidateWinRate: 0.6,
            drawRate: 0.1,
            nonLossArmageddonRate: 0,
            armageddonReachedCandidateLosses: 4,
        };
        const lostEarlier = {
            candidateId: "lost-earlier",
            candidateIndex: 1,
            candidateWinRate: 0.6,
            drawRate: 0.1,
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
            candidateWinRate: 0.55,
            drawRate: 0,
            nonLossArmageddonRate: 0,
            level4CoveragePassed: true,
            passesArmageddonGate: true,
        };
        const stronger = {
            candidateId: "stronger",
            candidateIndex: 1,
            candidateWinRate: 0.6,
            drawRate: 0,
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
            candidateWinRate: 0.6,
            decisiveWinRate: 0.6,
            armageddonRate: 0,
            level4ArmageddonRate: 0,
        };
        expect(isV08CampaignPromotionEligible(cleanBounded)).toBe(true);
        expect(isV08CampaignPromotionEligible({ ...cleanBounded, unboundedSearch: true })).toBe(false);
        expect(isV08CampaignPromotionEligible({ ...cleanBounded, level4ArmageddonRate: 0.01 })).toBe(false);
        expect(isV08CampaignPromotionEligible({ ...cleanBounded, armageddonRate: 0.01 })).toBe(false);
        expect(isV08CampaignPromotionEligible({ ...cleanBounded, hasValidationEvidence: false })).toBe(false);
        expect(isV08CampaignPromotionEligible({ ...cleanBounded, candidateWinRate: 0.49, decisiveWinRate: 0.99 })).toBe(
            false,
        );
    });

    it("requires explicit incumbent-relative strength evidence for promotion", () => {
        expect(isV08CampaignPromotionStrengthQualified(0.5, 0.5)).toBe(true);
        expect(isV08CampaignPromotionStrengthQualified(0.499, 0.9)).toBe(false);
        expect(
            isV08CampaignPromotionStrengthQualified(0.63, 0.62, {
                incumbentCandidateWinRate: 0.6,
                minimumCandidateWinRateDelta: 0.02,
                incumbentDecisiveWinRate: 0.6,
                minimumDecisiveWinRateDelta: 0.02,
            }),
        ).toBe(true);
        expect(
            isV08CampaignPromotionStrengthQualified(0.63, 0.619, {
                incumbentCandidateWinRate: 0.6,
                minimumCandidateWinRateDelta: 0.02,
                incumbentDecisiveWinRate: 0.6,
                minimumDecisiveWinRateDelta: 0.02,
            }),
        ).toBe(false);
        expect(() =>
            isV08CampaignPromotionStrengthQualified(0.7, 0.7, {
                incumbentCandidateWinRate: 0.5,
                minimumCandidateWinRateDelta: -0.01,
                incumbentDecisiveWinRate: 0.5,
                minimumDecisiveWinRateDelta: 0,
            }),
        ).toThrow("Invalid");
    });

    it("fails v4 campaign manifests closed after the scheduler and ranking provenance bump", () => {
        expect(V08_CAMPAIGN_SCHEMA).toBe("hoc.v0_8_aggressive_campaign.v5");
        expect(V08_CAMPAIGN_ADAPTIVE_GENERATOR_VERSION).toBe(3);
        expect(V08_CAMPAIGN_SCHEDULER_VERSION).toBe(1);
        expect(
            isV08CampaignManifestProvenanceCurrent({
                schema: V08_CAMPAIGN_SCHEMA,
                kind: "manifest",
                adaptive: { generatorVersion: V08_CAMPAIGN_ADAPTIVE_GENERATOR_VERSION },
                scheduler: { version: V08_CAMPAIGN_SCHEDULER_VERSION },
            }),
        ).toBe(true);
        expect(
            isV08CampaignManifestProvenanceCurrent({
                schema: "hoc.v0_8_aggressive_campaign.v4",
                kind: "manifest",
                adaptive: { generatorVersion: 2 },
                scheduler: { version: V08_CAMPAIGN_SCHEDULER_VERSION },
            }),
        ).toBe(false);
        expect(
            isV08CampaignManifestProvenanceCurrent({
                schema: V08_CAMPAIGN_SCHEMA,
                kind: "manifest",
                adaptive: { generatorVersion: V08_CAMPAIGN_ADAPTIVE_GENERATOR_VERSION },
                scheduler: { version: 0 },
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

    it("estimates the work-conserving validation queue without fixed-batch idle", () => {
        const jobs = [200, 100, 100, 100].map((games) => ({ kind: "validation" as const, games }));
        expect(estimateDynamicQueueDurationMs(jobs, [], 4, 3)).toBe(100_000);
        expect(estimateJobBatchesDurationMs([jobs.slice(0, 3), jobs.slice(3)], [], 4)).toBe(150_000);
    });

    it("backfills a freed lane while a slow sibling is still running", async () => {
        const started: string[] = [];
        const finish = new Map<string, (ok: boolean) => void>();
        const queue = runV08CampaignDynamicQueue({
            jobs: ["slow", "fast", "next", "last"].map((id) => ({ id })),
            lanes: 2,
            workersPerJob: 4,
            maxWorkers: 8,
            deadlineAtMs: 10_000,
            nowMs: () => 0,
            execute: async (job) => {
                started.push(job.id);
                return await new Promise<boolean>((resolve) => finish.set(job.id, resolve));
            },
        });
        await flushMicrotasks();
        expect(started).toEqual(["slow", "fast"]);

        finish.get("fast")!(true);
        await flushMicrotasks();
        expect(started).toEqual(["slow", "fast", "next"]);

        finish.get("next")!(true);
        await flushMicrotasks();
        expect(started).toEqual(["slow", "fast", "next", "last"]);

        finish.get("last")!(true);
        finish.get("slow")!(true);
        const result = await queue;
        expect(result).toMatchObject({
            status: "completed",
            launchedJobs: 4,
            completedJobs: 4,
            peakActiveLanes: 2,
            peakActiveWorkers: 8,
        });
    });

    it("never exceeds either the lane cap or maxWorkers", async () => {
        let active = 0;
        let peakActive = 0;
        const result = await runV08CampaignDynamicQueue({
            jobs: Array.from({ length: 12 }, (_, index) => ({ id: `job-${index}` })),
            lanes: 4,
            workersPerJob: 3,
            maxWorkers: 12,
            deadlineAtMs: 10_000,
            nowMs: () => 0,
            execute: async () => {
                active += 1;
                peakActive = Math.max(peakActive, active);
                await Promise.resolve();
                active -= 1;
                return true;
            },
        });
        expect(result.status).toBe("completed");
        expect(peakActive).toBeLessThanOrEqual(4);
        expect(result.peakActiveLanes).toBe(4);
        expect(result.peakActiveWorkers).toBe(12);
    });

    it("stops admitting work after a stop request or hard deadline", async () => {
        const stoppedStarts: string[] = [];
        let stopped = false;
        const stopResult = await runV08CampaignDynamicQueue({
            jobs: ["a", "b"].map((id) => ({ id })),
            lanes: 1,
            workersPerJob: 1,
            maxWorkers: 1,
            deadlineAtMs: 10,
            nowMs: () => 0,
            shouldStop: () => stopped,
            execute: async (job) => {
                stoppedStarts.push(job.id);
                stopped = true;
                return true;
            },
        });
        expect(stopResult.status).toBe("stopped");
        expect(stoppedStarts).toEqual(["a"]);

        const deadlineStarts: string[] = [];
        let nowMs = 0;
        const deadlineResult = await runV08CampaignDynamicQueue({
            jobs: ["a", "b"].map((id) => ({ id })),
            lanes: 1,
            workersPerJob: 1,
            maxWorkers: 1,
            deadlineAtMs: 10,
            nowMs: () => nowMs,
            execute: async (job) => {
                deadlineStarts.push(job.id);
                nowMs = 10;
                return true;
            },
        });
        expect(deadlineResult.status).toBe("deadline");
        expect(deadlineStarts).toEqual(["a"]);
    });

    it("drains admitted work without jumping past a deadline-deferred FIFO job", async () => {
        const started: string[] = [];
        const result = await runV08CampaignDynamicQueue({
            jobs: ["admitted", "deferred", "later"].map((id) => ({ id })),
            lanes: 2,
            workersPerJob: 2,
            maxWorkers: 4,
            deadlineAtMs: 10,
            nowMs: () => 0,
            canAdmit: (job) => job.id !== "deferred",
            execute: async (job) => {
                started.push(job.id);
                return true;
            },
        });
        expect(result).toMatchObject({
            status: "admission-deferred",
            launchedJobs: 1,
            completedJobs: 1,
            deferredJobId: "deferred",
        });
        expect(started).toEqual(["admitted"]);
    });

    it("keeps partial validation rounds out of committed leaderboard evidence", () => {
        const job = {
            id: "validation-r000-candidate-7",
            kind: "validation" as const,
            candidateId: "candidate-7",
        };
        expect(isV08CampaignValidationEvidenceCommitted(job, 0)).toBe(false);
        expect(isV08CampaignValidationEvidenceCommitted(job, 1)).toBe(true);
        expect(() => isV08CampaignValidationEvidenceCommitted({ ...job, candidateId: "candidate-8" }, 1)).toThrow(
            "non-canonical",
        );
    });
});
