/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import {
    assertV08CampaignCommittedValidationRoundCensus,
    buildV08CampaignBaseGenomes,
    buildWorkerPlan,
    canAdmitJobBatches,
    effectiveBehaviorEnvironment,
    estimateBatchDurationMs,
    estimateDynamicQueueDurationMs,
    estimateJobBatchesDurationMs,
    isV08CampaignAdaptiveCatalogProvenanceCurrent,
    isV08CampaignManifestProvenanceCurrent,
    isV08CampaignPromotionEligible,
    isV08CampaignPromotionStrengthQualified,
    isV08CampaignReserveEligible,
    isV08CampaignValidationEvidenceCommitted,
    isV08CampaignValidationSelectionSourceJob,
    jobWorkUnits,
    rankV08CampaignResearchCandidates,
    runV08CampaignDynamicQueue,
    selectV08CampaignAdaptiveParents,
    selectV08CampaignAdaptiveChildProposals,
    selectV08CampaignInactiveControl,
    selectV08CampaignLevel4CandidateIds,
    selectValidationCandidateIds,
    summarizeV08CampaignArmageddonJsonl,
    type IJobDurationSample,
    V08_CAMPAIGN_ADAPTIVE_GENERATOR_VERSION,
    V08_CAMPAIGN_DEFAULT_LANES,
    V08_CAMPAIGN_DEFAULT_TOP_CANDIDATES,
    V08_CAMPAIGN_EXACT_ANCHOR_ID,
    V08_CAMPAIGN_EXACT_ANCHOR_INDEX,
    V08_CAMPAIGN_EXACT_ANCHOR_REQUIRED_FINISH_MUTATIONS,
    V08_CAMPAIGN_INACTIVE_CONTROL_IDS,
    V08_CAMPAIGN_PROMOTION_COMPARISON_VERSION,
    V08_CAMPAIGN_SCHEMA,
    V08_CAMPAIGN_SCHEDULER_VERSION,
    V08_CAMPAIGN_SELECTION_VERSION,
    V08_CAMPAIGN_VALIDATION_SELECTION_SOURCE_KINDS,
} from "../../src/simulation/v0_8_aggressive_12h";
import { V08_TEST_CANDIDATE_GENOME_SHA256 } from "../../src/ai/versions/v0_8_candidate_profile";
import { buildV08AlignedV1ProductionCandidateCatalog } from "../../src/simulation/optimizer/v0_8_aligned_96h_v1_catalog";
import {
    fingerprintV08AlignedV1CandidateGenome,
    type IV08AlignedV1CandidateBinding,
} from "../../src/simulation/optimizer/v0_8_aligned_96h_v1_protocol";

const flushMicrotasks = async (): Promise<void> => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
};

const researchRow = ({
    candidateId,
    candidateIndex,
    candidateWinRate,
    decisiveWinRate = candidateWinRate,
    drawRate = 0,
    armageddonRate = 0,
    hasLevel4Evidence = true,
    level4CoveragePassed = true,
}: {
    candidateId: string;
    candidateIndex: number;
    candidateWinRate: number;
    decisiveWinRate?: number;
    drawRate?: number;
    armageddonRate?: number;
    hasLevel4Evidence?: boolean;
    level4CoveragePassed?: boolean;
}) => ({
    candidateId,
    candidateIndex,
    candidateWinRate,
    decisiveWinRate,
    drawRate,
    armageddonRate,
    nonLossArmageddonRate: armageddonRate,
    hasLevel4Evidence,
    level4CoveragePassed,
});

const validationStrength = ({
    candidateWinRate,
    decisiveWinRate,
    evidenceSha256 = "a".repeat(64),
    runs = 2,
    games = 2_048,
}: {
    candidateWinRate: number;
    decisiveWinRate: number;
    evidenceSha256?: string | null;
    runs?: number;
    games?: number;
}) => ({
    validationRuns: runs,
    validationGames: games,
    validationCandidateWinRate: candidateWinRate,
    validationDecisiveWinRate: decisiveWinRate,
    validationEvidenceSha256: evidenceSha256,
});

describe("v0.8 aggressive campaign orchestration", () => {
    it("treats concurrency as one host-wide worker budget", () => {
        expect(V08_CAMPAIGN_DEFAULT_LANES).toBe(3);
        expect(V08_CAMPAIGN_DEFAULT_TOP_CANDIDATES).toBe(8);
        expect(buildWorkerPlan(12, 3)).toEqual({ coreBudget: 12, lanes: 3, workersPerJob: 4, maxWorkers: 12 });
        expect(buildWorkerPlan(16, 3)).toEqual({ coreBudget: 16, lanes: 3, workersPerJob: 5, maxWorkers: 15 });
        expect(buildWorkerPlan(12, 1)).toEqual({ coreBudget: 12, lanes: 1, workersPerJob: 12, maxWorkers: 12 });
        expect(() => buildWorkerPlan(2, 3)).toThrow("lanes cannot exceed");
    });

    it("extends the unchanged production 48 with the immutable exact profile as c48", () => {
        const production = buildV08AlignedV1ProductionCandidateCatalog();
        const campaign = buildV08CampaignBaseGenomes();
        const productionHashes = production.map(fingerprintV08AlignedV1CandidateGenome);
        const campaignHashes = campaign.map(fingerprintV08AlignedV1CandidateGenome);

        expect(production).toHaveLength(48);
        expect(campaign).toHaveLength(49);
        expect(V08_CAMPAIGN_EXACT_ANCHOR_INDEX).toBe(48);
        expect(V08_CAMPAIGN_EXACT_ANCHOR_ID).toBe("c48");
        expect(campaignHashes.slice(0, 48)).toEqual(productionHashes);
        expect(campaignHashes[48]).toBe(V08_TEST_CANDIDATE_GENOME_SHA256);
        expect(new Set(campaignHashes).size).toBe(49);
    });

    it("forces c48 plus the top three screened leaders into adaptive generation", () => {
        const rows = [
            researchRow({ candidateId: "c48", candidateIndex: 48, candidateWinRate: 0.51 }),
            researchRow({ candidateId: "c37", candidateIndex: 37, candidateWinRate: 0.62 }),
            researchRow({ candidateId: "c38", candidateIndex: 38, candidateWinRate: 0.64 }),
            researchRow({ candidateId: "leader", candidateIndex: 10, candidateWinRate: 0.75 }),
            researchRow({ candidateId: "runner-up", candidateIndex: 11, candidateWinRate: 0.7 }),
        ];

        expect(selectV08CampaignAdaptiveParents(rows).map(({ candidateId }) => candidateId)).toEqual([
            "c48",
            "leader",
            "runner-up",
            "c38",
        ]);
        expect(() => selectV08CampaignAdaptiveParents(rows.filter(({ candidateId }) => candidateId !== "c48"))).toThrow(
            "exact c48",
        );
    });

    it("reserves c48 child slots for all finish controls while retaining gate and leaf exploration", () => {
        const campaign = buildV08CampaignBaseGenomes();
        const parentIndices = [48, 39, 37, 31] as const;
        const parents = parentIndices.map((candidateIndex) => {
            const genome = campaign[candidateIndex]!;
            return {
                candidateId: `c${candidateIndex}`,
                candidateIndex,
                genomeSha256: fingerprintV08AlignedV1CandidateGenome(genome),
                genome,
            };
        });
        const proposals = selectV08CampaignAdaptiveChildProposals(
            parents[0]!,
            parents,
            campaign.map(fingerprintV08AlignedV1CandidateGenome),
            6,
        );

        expect(proposals.slice(0, 3).map(({ mutation }) => ({ field: mutation.field, to: mutation.to }))).toEqual([
            ...V08_CAMPAIGN_EXACT_ANCHOR_REQUIRED_FINISH_MUTATIONS,
        ]);
        expect(proposals.map(({ mutation }) => mutation.field)).toEqual([
            "controls.meleeRangedTargetWeight",
            "controls.lateRangedFinishWeight",
            "controls.pureRangedTerminalWeight",
            "search.gate",
            "search.leaf",
            "search.leaf",
        ]);
        expect(proposals[3]?.mutation.to).toBe(0.015);
        expect(proposals.slice(4).map(({ mutation }) => mutation.alpha)).toEqual([0.15, 0.25]);
        expect(proposals.slice(4).map(({ mutation }) => mutation.donorCandidateId)).toEqual(["c39", "c39"]);
    });

    it("forces c48 and the stronger inactive control through level-4 even when top is one", () => {
        const rows = [
            researchRow({ candidateId: "c48", candidateIndex: 48, candidateWinRate: 0.4 }),
            researchRow({ candidateId: "c37", candidateIndex: 37, candidateWinRate: 0.55 }),
            researchRow({ candidateId: "c38", candidateIndex: 38, candidateWinRate: 0.6 }),
            researchRow({ candidateId: "leader", candidateIndex: 1, candidateWinRate: 0.9 }),
        ];

        expect(selectV08CampaignInactiveControl(rows).candidateId).toBe("c38");
        expect(selectV08CampaignLevel4CandidateIds(rows, 1)).toEqual(["c48", "c38"]);
        expect(() => selectV08CampaignInactiveControl(rows.filter(({ candidateId }) => candidateId !== "c37"))).toThrow(
            "c37/c38",
        );
    });

    it("stratifies top-eight validation across anchor, control, strength, and lowest total Armageddon", () => {
        const rows = [
            researchRow({
                candidateId: "c48",
                candidateIndex: 48,
                candidateWinRate: 0.5,
                decisiveWinRate: 0.5,
                armageddonRate: 0.3,
            }),
            researchRow({ candidateId: "c37", candidateIndex: 37, candidateWinRate: 0.51, armageddonRate: 0.5 }),
            researchRow({ candidateId: "c38", candidateIndex: 38, candidateWinRate: 0.52, armageddonRate: 0.4 }),
            researchRow({ candidateId: "strength-1", candidateIndex: 1, candidateWinRate: 0.9, armageddonRate: 0.2 }),
            researchRow({ candidateId: "strength-2", candidateIndex: 2, candidateWinRate: 0.85, armageddonRate: 0.18 }),
            researchRow({ candidateId: "strength-3", candidateIndex: 3, candidateWinRate: 0.8, armageddonRate: 0.16 }),
            researchRow({ candidateId: "low-arm-1", candidateIndex: 4, candidateWinRate: 0.6, armageddonRate: 0.001 }),
            researchRow({ candidateId: "low-arm-2", candidateIndex: 5, candidateWinRate: 0.59, armageddonRate: 0.002 }),
            researchRow({ candidateId: "low-arm-3", candidateIndex: 6, candidateWinRate: 0.58, armageddonRate: 0.003 }),
            researchRow({
                candidateId: "ineligible-lucky-zero",
                candidateIndex: 7,
                candidateWinRate: 0.49,
                decisiveWinRate: 0.9,
                armageddonRate: 0,
            }),
            researchRow({
                candidateId: "uncovered-superstar",
                candidateIndex: 8,
                candidateWinRate: 1,
                armageddonRate: 0,
                level4CoveragePassed: false,
            }),
        ];
        const expected = [
            "c48",
            "c38",
            "strength-1",
            "strength-2",
            "strength-3",
            "low-arm-1",
            "low-arm-2",
            "low-arm-3",
        ];

        expect(
            selectV08CampaignLevel4CandidateIds(
                rows.filter(({ candidateId }) => candidateId !== "uncovered-superstar"),
                8,
            ),
        ).toEqual(expected);
        expect(selectValidationCandidateIds(rows, 8)).toEqual(expected);
        expect(selectValidationCandidateIds(rows, 8)).toEqual(expected);
        expect(selectValidationCandidateIds(rows, 1)).toEqual(["c48", "c38"]);
        expect(expected.every((id) => rows.find(({ candidateId }) => candidateId === id)?.hasLevel4Evidence)).toBe(
            true,
        );
        expect(isV08CampaignReserveEligible(rows.find(({ candidateId }) => candidateId === "low-arm-1")!)).toBe(true);
        expect(
            isV08CampaignReserveEligible(rows.find(({ candidateId }) => candidateId === "ineligible-lucky-zero")!),
        ).toBe(false);
        expect(() => selectValidationCandidateIds(rows, 0)).toThrow("must be positive");
        const failedForcedCoverage = rows.map((row) =>
            row.candidateId === "c48" || row.candidateId === "c38" ? { ...row, level4CoveragePassed: false } : row,
        );
        expect(selectValidationCandidateIds(failedForcedCoverage, 8)).toEqual(expected);
        expect(() =>
            selectValidationCandidateIds(
                rows.map((row) => (row.candidateId === "c48" ? { ...row, hasLevel4Evidence: false } : row)),
                8,
            ),
        ).toThrow("c48 anchor");
        expect(() =>
            selectValidationCandidateIds(
                rows.map((row) => (row.candidateId === "c38" ? { ...row, hasLevel4Evidence: false } : row)),
                8,
            ),
        ).toThrow("inactive-challenger control");
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

    it("uses 0.5 only as Armageddon-reserve eligibility", () => {
        expect(isV08CampaignReserveEligible({ candidateWinRate: 0.5, decisiveWinRate: 0.5 })).toBe(true);
        expect(isV08CampaignReserveEligible({ candidateWinRate: 0.499, decisiveWinRate: 0.9 })).toBe(false);
        expect(isV08CampaignReserveEligible({ candidateWinRate: 0.9, decisiveWinRate: 0.499 })).toBe(false);
        expect(isV08CampaignReserveEligible({ candidateWinRate: 1.01, decisiveWinRate: 0.9 })).toBe(false);
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

    it("compares promotion strength only on identical committed validation rounds and seeds", () => {
        const anchor = validationStrength({ candidateWinRate: 0.48, decisiveWinRate: 0.49 });
        const nonRegressing = validationStrength({ candidateWinRate: 0.48, decisiveWinRate: 0.49 });

        expect(isV08CampaignPromotionStrengthQualified(nonRegressing, anchor)).toBe(true);
        expect(
            isV08CampaignPromotionStrengthQualified(
                validationStrength({ candidateWinRate: 0.479, decisiveWinRate: 0.9 }),
                anchor,
            ),
        ).toBe(false);
        expect(
            isV08CampaignPromotionStrengthQualified(
                validationStrength({ candidateWinRate: 0.9, decisiveWinRate: 0.489 }),
                anchor,
            ),
        ).toBe(false);
        expect(
            isV08CampaignPromotionStrengthQualified(
                validationStrength({ candidateWinRate: 0.9, decisiveWinRate: 0.9, evidenceSha256: "b".repeat(64) }),
                anchor,
            ),
        ).toBe(false);
        expect(
            isV08CampaignPromotionStrengthQualified(
                validationStrength({ candidateWinRate: 0.9, decisiveWinRate: 0.9, runs: 1, games: 1_024 }),
                anchor,
            ),
        ).toBe(false);
        expect(() =>
            isV08CampaignPromotionStrengthQualified(
                validationStrength({ candidateWinRate: 1.01, decisiveWinRate: 0.9 }),
                anchor,
            ),
        ).toThrow("Invalid");
    });

    it("never promotes the anchor and blocks unbounded, partial, or Armageddon-unsafe evidence", () => {
        const anchor = validationStrength({ candidateWinRate: 0.48, decisiveWinRate: 0.49 });
        const cleanBounded = {
            ...validationStrength({ candidateWinRate: 0.5, decisiveWinRate: 0.51 }),
            isExactAnchor: false,
            unboundedSearch: false,
            hasValidationEvidence: true,
            level4CoveragePassed: true,
            armageddonRate: 0,
            level4ArmageddonRate: 0,
        };

        expect(isV08CampaignPromotionEligible(cleanBounded, anchor)).toBe(true);
        expect(isV08CampaignPromotionEligible({ ...cleanBounded, isExactAnchor: true }, anchor)).toBe(false);
        expect(isV08CampaignPromotionEligible({ ...cleanBounded, unboundedSearch: true }, anchor)).toBe(false);
        expect(isV08CampaignPromotionEligible({ ...cleanBounded, level4ArmageddonRate: 0.01 }, anchor)).toBe(false);
        expect(isV08CampaignPromotionEligible({ ...cleanBounded, armageddonRate: 0.01 }, anchor)).toBe(false);
        expect(isV08CampaignPromotionEligible({ ...cleanBounded, armageddonRate: -0.01 }, anchor)).toBe(false);
        expect(isV08CampaignPromotionEligible({ ...cleanBounded, hasValidationEvidence: false }, anchor)).toBe(false);
        expect(isV08CampaignPromotionEligible({ ...cleanBounded, level4CoveragePassed: false }, anchor)).toBe(false);
        expect(
            isV08CampaignPromotionEligible({ ...cleanBounded, validationEvidenceSha256: "b".repeat(64) }, anchor),
        ).toBe(false);
    });

    it("accepts only schema-v6/generator-v4 anchor and selection provenance", () => {
        const current = {
            schema: V08_CAMPAIGN_SCHEMA,
            kind: "manifest",
            adaptive: { generatorVersion: V08_CAMPAIGN_ADAPTIVE_GENERATOR_VERSION },
            scheduler: { version: V08_CAMPAIGN_SCHEDULER_VERSION },
            campaignBaseIdentity: {
                campaignCandidateCount: 49,
                exactAnchor: { id: V08_CAMPAIGN_EXACT_ANCHOR_ID, genomeSha256: V08_TEST_CANDIDATE_GENOME_SHA256 },
                inactiveControls: V08_CAMPAIGN_INACTIVE_CONTROL_IDS.map((id) => ({ id })),
            },
            selection: {
                version: V08_CAMPAIGN_SELECTION_VERSION,
                exactAnchorCandidateId: V08_CAMPAIGN_EXACT_ANCHOR_ID,
            },
            promotionComparison: {
                version: V08_CAMPAIGN_PROMOTION_COMPARISON_VERSION,
                exactAnchorCandidateId: V08_CAMPAIGN_EXACT_ANCHOR_ID,
            },
        };

        expect(V08_CAMPAIGN_SCHEMA).toBe("hoc.v0_8_aggressive_campaign.v6");
        expect(V08_CAMPAIGN_ADAPTIVE_GENERATOR_VERSION).toBe(4);
        expect(V08_CAMPAIGN_SCHEDULER_VERSION).toBe(1);
        expect(isV08CampaignManifestProvenanceCurrent(current)).toBe(true);
        expect(isV08CampaignManifestProvenanceCurrent({ ...current, schema: "hoc.v0_8_aggressive_campaign.v5" })).toBe(
            false,
        );
        expect(isV08CampaignManifestProvenanceCurrent({ ...current, adaptive: { generatorVersion: 3 } })).toBe(false);
        expect(isV08CampaignManifestProvenanceCurrent({ ...current, scheduler: { version: 0 } })).toBe(false);
        expect(
            isV08CampaignManifestProvenanceCurrent({
                ...current,
                campaignBaseIdentity: {
                    ...current.campaignBaseIdentity,
                    exactAnchor: { id: "c48", genomeSha256: "drifted" },
                },
            }),
        ).toBe(false);
    });

    it("fails resumed adaptive catalogs closed unless they bind the full 49-arm campaign base", () => {
        const expected = {
            manifestFingerprint: "a".repeat(64),
            campaignBaseIdentitySha256: "b".repeat(64),
        };
        const persisted = {
            schema: V08_CAMPAIGN_SCHEMA,
            kind: "adaptive-catalog",
            manifestFingerprint: expected.manifestFingerprint,
            generatorVersion: V08_CAMPAIGN_ADAPTIVE_GENERATOR_VERSION,
            sourceCampaignBaseIdentitySha256: expected.campaignBaseIdentitySha256,
            exactAnchorGenomeSha256: V08_TEST_CANDIDATE_GENOME_SHA256,
        };

        expect(isV08CampaignAdaptiveCatalogProvenanceCurrent(persisted, expected)).toBe(true);
        expect(
            isV08CampaignAdaptiveCatalogProvenanceCurrent(
                { ...persisted, sourceCampaignBaseIdentitySha256: "c".repeat(64) },
                expected,
            ),
        ).toBe(false);
        expect(
            isV08CampaignAdaptiveCatalogProvenanceCurrent(
                {
                    ...persisted,
                    sourceCampaignBaseIdentitySha256: undefined,
                    sourceCatalogSha256: expected.campaignBaseIdentitySha256,
                },
                expected,
            ),
        ).toBe(false);
        expect(
            isV08CampaignAdaptiveCatalogProvenanceCurrent(
                { ...persisted, exactAnchorGenomeSha256: "d".repeat(64) },
                expected,
            ),
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

    it("rejects a round counter unless every shortlisted candidate committed the common panel", () => {
        const candidateIds = ["c48", "c38"];
        const job = (candidateId: string) => ({
            id: `validation-r000-${candidateId}`,
            kind: "validation" as const,
            candidateId,
            games: 1_024,
            baseSeed: 42,
        });
        const input = {
            completed: candidateIds.map(job),
            nextValidationRound: 1,
            candidateIds,
            validationGames: 1_024,
            validationSeed: 42,
        };

        expect(() => assertV08CampaignCommittedValidationRoundCensus(input)).not.toThrow();
        expect(() => assertV08CampaignCommittedValidationRoundCensus({ ...input, completed: [job("c48")] })).toThrow(
            "missing candidate c38",
        );
        expect(() =>
            assertV08CampaignCommittedValidationRoundCensus({
                ...input,
                completed: [{ ...job("c38"), baseSeed: 43 }, job("c48")],
            }),
        ).toThrow("common-random round plan");
        expect(() =>
            assertV08CampaignCommittedValidationRoundCensus({
                ...input,
                completed: [job("c48")],
                nextValidationRound: 0,
            }),
        ).not.toThrow();
    });

    it("keeps the persisted selection source stable after a completed validation round and resume", () => {
        const preValidation = [
            { id: "screen-c48", kind: "screen" as const },
            { id: "adaptive-a00", kind: "adaptive" as const },
            { id: "level4-c48", kind: "level4" as const },
        ];
        const resumedAfterRound = [
            ...preValidation,
            { id: "validation-r000-c48", kind: "validation" as const },
            { id: "validation-r000-c38", kind: "validation" as const },
        ];

        expect(V08_CAMPAIGN_VALIDATION_SELECTION_SOURCE_KINDS).toEqual(["screen", "adaptive", "level4"]);
        expect(resumedAfterRound.filter(isV08CampaignValidationSelectionSourceJob)).toEqual(preValidation);
    });
});
