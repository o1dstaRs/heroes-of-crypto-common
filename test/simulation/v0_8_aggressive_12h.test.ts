/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PBTypes } from "../../src/generated/protobuf/v1/types";
import {
    assertV08CampaignCommittedValidationRoundCensus,
    assertV08CampaignDecisionQualityPrecedesValidation,
    assertV08CampaignResumeHasNoLiveJobs,
    acquireV08CampaignOutputLease,
    buildV08CampaignBaseGenomes,
    buildV08CampaignChildEnvironment,
    buildV08CampaignChildEnvironmentPolicy,
    buildWorkerPlan,
    canAdmitJobBatches,
    classifyV08CampaignValidationRoundState,
    effectiveBehaviorEnvironment,
    estimateBatchDurationMs,
    estimateDynamicQueueDurationMs,
    estimateJobBatchesDurationMs,
    isV08CampaignAdaptiveCatalogProvenanceCurrent,
    isV08CampaignChildEnvironmentPolicyValid,
    isV08CampaignManifestProvenanceCurrent,
    isV08CampaignPostA13LaneBehaviorQualified,
    isV08CampaignPostA13SelectionEligible,
    isV08CampaignPostA13SpellExerciseQualified,
    isV08CampaignPostA13StrengthQualified,
    isV08CampaignPromotionEligible,
    isV08CampaignPromotionStrengthQualified,
    isV08CampaignReserveEligible,
    isV08CampaignSourceIdentityCurrent,
    isV08CampaignValidationEvidenceCommitted,
    isV08CampaignValidationSelectionSourceJob,
    jobWorkUnits,
    parseV08CampaignCli,
    rankV08CampaignResearchCandidates,
    runV08CampaignDynamicQueue,
    selectV08CampaignAdaptiveParents,
    selectV08CampaignAdaptiveChildProposals,
    selectV08CampaignInactiveControl,
    selectV08CampaignLevel4CandidateIds,
    selectValidationCandidateIds,
    summarizeV08CampaignArmageddonJsonl,
    validateV08CampaignPostA13CoverageSummary,
    validateV08CampaignBlockCenterQualificationSummary,
    validateV08CampaignPassiveQualificationSummary,
    type IJobDurationSample,
    V08_CAMPAIGN_ADAPTIVE_GENERATOR_VERSION,
    V08_CAMPAIGN_BLOCK_CENTER_QUALIFICATION_DEFAULT_GAMES,
    V08_CAMPAIGN_BLOCK_CENTER_QUALIFICATION_REQUIRED_GATES,
    V08_CAMPAIGN_CHILD_ENVIRONMENT_POLICY_VERSION,
    V08_CAMPAIGN_CHILD_ENVIRONMENT_STRATEGY,
    V08_CAMPAIGN_DEFAULT_LANES,
    V08_CAMPAIGN_DEFAULT_TOP_CANDIDATES,
    V08_CAMPAIGN_EXACT_ANCHOR_GENOME_SHA256,
    V08_CAMPAIGN_EXACT_ANCHOR_ID,
    V08_CAMPAIGN_EXACT_ANCHOR_INDEX,
    V08_CAMPAIGN_EXACT_ANCHOR_REQUIRED_FINISH_MUTATIONS,
    V08_CAMPAIGN_INACTIVE_CONTROL_IDS,
    V08_CAMPAIGN_PASSIVE_QUALIFICATION_DEFAULT_GAMES,
    V08_CAMPAIGN_PASSIVE_QUALIFICATION_DEFAULT_MIN_CREATURE_APPEARANCES,
    V08_CAMPAIGN_PASSIVE_QUALIFICATION_REQUIRED_GATES,
    V08_CAMPAIGN_PROMOTION_COMPARISON_VERSION,
    V08_CAMPAIGN_POST_A13_COVERAGE_LANE_COUNT,
    V08_CAMPAIGN_POST_A13_COVERAGE_LANES,
    V08_CAMPAIGN_POST_A13_COVERAGE_SCHEMA,
    V08_CAMPAIGN_POST_A13_SPELL_EXERCISE_KITS,
    V08_CAMPAIGN_SCHEMA,
    V08_CAMPAIGN_SCHEDULER_VERSION,
    V08_CAMPAIGN_SELECTION_VERSION,
    V08_CAMPAIGN_VALIDATION_SELECTION_SOURCE_KINDS,
} from "../../src/simulation/v0_8_aggressive_12h";
import { V08_A13_GENOME, V08_A13_GENOME_SHA256 } from "../../src/ai/versions/v0_8_a13_profile";
import { buildV08AlignedV1ProductionCandidateCatalog } from "../../src/simulation/optimizer/v0_8_aligned_96h_v1_catalog";
import {
    fingerprintV08AlignedV1,
    fingerprintV08AlignedV1CandidateGenome,
    type IV08AlignedV1CandidateBinding,
} from "../../src/simulation/optimizer/v0_8_aligned_96h_v1_protocol";
import { fingerprintV08PostA13CoveragePlan, V08_POST_A13_LIVE_MAPS } from "../../src/simulation/v0_8_post_a13_coverage";
import {
    emptyV08PassiveTurnMetrics,
    fingerprintV08PassiveTurnPanelPlan,
    planV08PassiveTurnPanelGame,
    summarizeV08PassiveTurnPanel,
    V08_PASSIVE_TURN_PANEL_SCHEMA,
    type IV08PassiveTurnPanelOptions,
    type IV08PassiveTurnPanelRecord,
} from "../../src/simulation/v0_8_passive_turn_panel";
import {
    emptyV08BlockCenterMetrics,
    fingerprintV08BlockCenterActionPlan,
    planV08BlockCenterActionGame,
    summarizeV08BlockCenterActionPanel,
    V08_BLOCK_CENTER_ACTION_PANEL_SCHEMA,
    type IV08BlockCenterActionPanelOptions,
    type IV08BlockCenterActionRecord,
} from "../../src/simulation/v0_8_block_center_action_panel";

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
    hasPostA13CoverageEvidence = true,
    postA13CoveragePassed = true,
    postA13SpellExercisePassed = true,
    hasAllUnitCoverageEvidence = true,
    allUnitCoveragePassed = true,
    hasAllUnitQualificationEvidence = true,
    allUnitQualificationPassed = true,
}: {
    candidateId: string;
    candidateIndex: number;
    candidateWinRate: number;
    decisiveWinRate?: number;
    drawRate?: number;
    armageddonRate?: number;
    hasLevel4Evidence?: boolean;
    level4CoveragePassed?: boolean;
    hasPostA13CoverageEvidence?: boolean;
    postA13CoveragePassed?: boolean;
    postA13SpellExercisePassed?: boolean;
    hasAllUnitCoverageEvidence?: boolean;
    allUnitCoveragePassed?: boolean;
    hasAllUnitQualificationEvidence?: boolean;
    allUnitQualificationPassed?: boolean;
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
    hasPostA13CoverageEvidence,
    postA13CoveragePassed,
    postA13SpellExercisePassed,
    hasAllUnitCoverageEvidence,
    allUnitCoveragePassed,
    hasAllUnitQualificationEvidence,
    allUnitQualificationPassed,
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

const postA13Strength = ({
    candidateWinRate,
    decisiveWinRate,
    games = 144,
    evidenceSha256 = "c".repeat(64),
    armageddonRate = 0.2,
}: {
    candidateWinRate: number;
    decisiveWinRate: number;
    games?: number;
    evidenceSha256?: string | null;
    armageddonRate?: number;
}) => ({
    postA13CoverageGames: games,
    postA13CandidateWinRate: candidateWinRate,
    postA13DecisiveWinRate: decisiveWinRate,
    postA13CoverageEvidenceSha256: evidenceSha256,
    postA13ArmageddonRate: armageddonRate,
});

const QUALIFICATION_SOURCE = "1".repeat(40);

const passiveQualificationFixture = () => {
    const options: IV08PassiveTurnPanelOptions = {
        candidateVersion: "v0.8s",
        opponentVersion: "v0.7",
        games: 2,
        baseSeed: 101,
        minCreatureAppearances: 0,
        sourceCommit: QUALIFICATION_SOURCE,
        sourceDirty: false,
        inheritCandidateEnvironment: true,
    };
    const records: IV08PassiveTurnPanelRecord[] = [0, 1].map((game) => {
        const plan = planV08PassiveTurnPanelGame(options, game);
        const candidateRoster = plan.candidateSide === "green" ? plan.greenRoster : plan.redRoster;
        const opponentRoster = plan.candidateSide === "green" ? plan.redRoster : plan.greenRoster;
        return {
            schema: V08_PASSIVE_TURN_PANEL_SCHEMA,
            sourceCommit: options.sourceCommit ?? null,
            sourceDirty: false,
            game,
            pair: plan.pair,
            seed: plan.seed,
            mapType: plan.mapType,
            candidateVersion: options.candidateVersion,
            opponentVersion: options.opponentVersion,
            inheritCandidateEnvironment: true,
            candidateSide: plan.candidateSide,
            candidateRoster: candidateRoster.map(({ creatureName }) => creatureName),
            opponentRoster: opponentRoster.map(({ creatureName }) => creatureName),
            winner: "draw",
            laps: 1,
            endReason: "elimination",
            candidateEngineRejections: 0,
            metrics: emptyV08PassiveTurnMetrics(),
            byCreature: {},
            passiveFailureSamples: [],
        };
    });
    return { options, summary: summarizeV08PassiveTurnPanel(options, records) };
};

const blockCenterQualificationFixture = () => {
    const options: IV08BlockCenterActionPanelOptions = {
        candidateVersion: "v0.8s",
        opponentVersion: "v0.7",
        games: 2,
        baseSeed: 202,
        sourceCommit: QUALIFICATION_SOURCE,
        sourceDirty: false,
        inheritCandidateEnvironment: true,
    };
    const records: IV08BlockCenterActionRecord[] = [0, 1].map((game) => {
        const plan = planV08BlockCenterActionGame(options, game);
        const candidateRoster = plan.candidateSide === "green" ? plan.greenRoster : plan.redRoster;
        const opponentRoster = plan.candidateSide === "green" ? plan.redRoster : plan.greenRoster;
        return {
            schema: V08_BLOCK_CENTER_ACTION_PANEL_SCHEMA,
            sourceCommit: options.sourceCommit ?? null,
            sourceDirty: options.sourceDirty === true,
            game,
            pair: plan.pair,
            seed: plan.seed,
            mapType: plan.mapType,
            candidateVersion: options.candidateVersion,
            opponentVersion: options.opponentVersion,
            inheritCandidateEnvironment: true,
            candidateSide: plan.candidateSide,
            candidateRoster: candidateRoster.map(({ creatureName }) => creatureName),
            opponentRoster: opponentRoster.map(({ creatureName }) => creatureName),
            winner: "draw",
            laps: 1,
            endReason: "elimination",
            candidateEngineRejections: 0,
            metrics: emptyV08BlockCenterMetrics(),
            byCreature: {},
            mountainStates: { both_intact: 0, left_only: 0, right_only: 0, cleared: 0 },
            failureSamples: [],
        };
    });
    return { options, summary: summarizeV08BlockCenterActionPanel(options, records) };
};

describe("v0.8 aggressive campaign orchestration", () => {
    it("treats concurrency as one host-wide worker budget", () => {
        expect(V08_CAMPAIGN_DEFAULT_LANES).toBe(3);
        expect(V08_CAMPAIGN_DEFAULT_TOP_CANDIDATES).toBe(8);
        expect(buildWorkerPlan(12, 3)).toEqual({ coreBudget: 12, lanes: 3, workersPerJob: 4, maxWorkers: 12 });
        expect(buildWorkerPlan(16, 3)).toEqual({ coreBudget: 16, lanes: 3, workersPerJob: 5, maxWorkers: 15 });
        expect(buildWorkerPlan(12, 1)).toEqual({ coreBudget: 12, lanes: 1, workersPerJob: 12, maxWorkers: 12 });
        expect(() => buildWorkerPlan(2, 3)).toThrow("lanes cannot exceed");
    });

    it("extends the unchanged production 48 with generator v7's historical A13 anchor as c48", () => {
        const production = buildV08AlignedV1ProductionCandidateCatalog();
        const campaign = buildV08CampaignBaseGenomes();
        const productionHashes = production.map(fingerprintV08AlignedV1CandidateGenome);
        const campaignHashes = campaign.map(fingerprintV08AlignedV1CandidateGenome);

        expect(production).toHaveLength(48);
        expect(campaign).toHaveLength(49);
        expect(V08_CAMPAIGN_EXACT_ANCHOR_INDEX).toBe(48);
        expect(V08_CAMPAIGN_EXACT_ANCHOR_ID).toBe("c48");
        expect(campaignHashes.slice(0, 48)).toEqual(productionHashes);
        expect(campaignHashes[48]).toBe(V08_CAMPAIGN_EXACT_ANCHOR_GENOME_SHA256);
        expect(campaign[48]!.controls.shortlist).toBe(2);
        expect(V08_A13_GENOME.controls.shortlist).toBe(3);
        expect(V08_CAMPAIGN_EXACT_ANCHOR_GENOME_SHA256).not.toBe(V08_A13_GENOME_SHA256);
        expect(new Set(campaignHashes).size).toBe(49);
    });

    it("forces c48 plus the top three screened leaders into adaptive generation", () => {
        const rows = [
            researchRow({ candidateId: "c48", candidateIndex: 48, candidateWinRate: 0.51 }),
            researchRow({ candidateId: "c37", candidateIndex: 37, candidateWinRate: 0.62 }),
            researchRow({ candidateId: "c38", candidateIndex: 38, candidateWinRate: 0.64 }),
            researchRow({ candidateId: "leader", candidateIndex: 10, candidateWinRate: 0.75 }),
            researchRow({ candidateId: "runner-up", candidateIndex: 11, candidateWinRate: 0.7 }),
            researchRow({
                candidateId: "failed-behavior",
                candidateIndex: 12,
                candidateWinRate: 1,
                postA13CoveragePassed: false,
            }),
            researchRow({
                candidateId: "failed-spells",
                candidateIndex: 13,
                candidateWinRate: 0.99,
                postA13SpellExercisePassed: false,
            }),
            researchRow({
                candidateId: "failed-all-unit",
                candidateIndex: 14,
                candidateWinRate: 0.98,
                allUnitCoveragePassed: false,
            }),
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
        expect(() =>
            selectV08CampaignAdaptiveParents(
                rows.map((row) => (row.candidateId === "c48" ? { ...row, postA13CoveragePassed: false } : row)),
            ),
        ).toThrow("post-A13 behavior coverage");
        expect(() =>
            selectV08CampaignAdaptiveParents(
                rows.map((row) => (row.candidateId === "c48" ? { ...row, postA13SpellExercisePassed: false } : row)),
            ),
        ).toThrow("every intrinsic post-A13 spell kit");
        expect(() =>
            selectV08CampaignAdaptiveParents(
                rows.map((row) => (row.candidateId === "c48" ? { ...row, allUnitCoveragePassed: false } : row)),
            ),
        ).toThrow("all-unit coverage");
    });

    it("excludes failed post-A13 behavior, spell exercise, or exact all-unit coverage before research selection", () => {
        expect(
            isV08CampaignPostA13SelectionEligible(
                researchRow({
                    candidateId: "candidate",
                    candidateIndex: 1,
                    candidateWinRate: 1,
                    postA13CoveragePassed: false,
                }),
            ),
        ).toBe(false);
        expect(
            isV08CampaignPostA13SelectionEligible(
                researchRow({
                    candidateId: "candidate",
                    candidateIndex: 1,
                    candidateWinRate: 1,
                    allUnitCoveragePassed: false,
                }),
            ),
        ).toBe(false);
        expect(
            isV08CampaignPostA13SelectionEligible(
                researchRow({
                    candidateId: "candidate",
                    candidateIndex: 1,
                    candidateWinRate: 1,
                    postA13SpellExercisePassed: false,
                }),
            ),
        ).toBe(false);
        for (const candidateIndex of [37, 38]) {
            expect(
                isV08CampaignPostA13SelectionEligible(
                    researchRow({
                        candidateId: `c${candidateIndex}`,
                        candidateIndex,
                        candidateWinRate: 0,
                        postA13SpellExercisePassed: false,
                    }),
                ),
            ).toBe(true);
        }
    });

    it("produces six unique A13 children with control, lower-gate, and leaf-blend coverage", () => {
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
        expect(proposals[3]?.mutation.to).toBe(0.025);
        expect(proposals.slice(4).map(({ mutation }) => mutation.alpha)).toEqual([0.15, 0.15]);
        expect(proposals.slice(4).map(({ mutation }) => mutation.donorCandidateId)).toEqual(["c39", "c31"]);
        expect(new Set(proposals.map(({ genome }) => fingerprintV08AlignedV1CandidateGenome(genome))).size).toBe(6);
    });

    it("forces c48 and both inactive controls through level-4 even when top is one", () => {
        const rows = [
            researchRow({ candidateId: "c48", candidateIndex: 48, candidateWinRate: 0.4 }),
            researchRow({ candidateId: "c37", candidateIndex: 37, candidateWinRate: 0.55 }),
            researchRow({ candidateId: "c38", candidateIndex: 38, candidateWinRate: 0.6 }),
            researchRow({ candidateId: "leader", candidateIndex: 1, candidateWinRate: 0.9 }),
        ];

        expect(selectV08CampaignInactiveControl(rows).candidateId).toBe("c38");
        expect(selectV08CampaignLevel4CandidateIds(rows, 1)).toEqual(["c48", "c38", "c37"]);
        expect(() => selectV08CampaignInactiveControl(rows.filter(({ candidateId }) => candidateId !== "c37"))).toThrow(
            "c37/c38",
        );
    });

    it("keeps failed post-A13 arms out of the finite level-4 reserve", () => {
        const rows = [
            researchRow({ candidateId: "c48", candidateIndex: 48, candidateWinRate: 0.4 }),
            researchRow({
                candidateId: "c37",
                candidateIndex: 37,
                candidateWinRate: 0.55,
                postA13SpellExercisePassed: false,
            }),
            researchRow({
                candidateId: "c38",
                candidateIndex: 38,
                candidateWinRate: 0.6,
                postA13SpellExercisePassed: false,
            }),
            researchRow({
                candidateId: "failed-behavior",
                candidateIndex: 1,
                candidateWinRate: 1,
                postA13CoveragePassed: false,
            }),
            researchRow({
                candidateId: "failed-spells",
                candidateIndex: 2,
                candidateWinRate: 0.99,
                postA13SpellExercisePassed: false,
            }),
            researchRow({ candidateId: "eligible", candidateIndex: 3, candidateWinRate: 0.9 }),
        ];

        expect(selectV08CampaignLevel4CandidateIds(rows, 4)).toEqual(["c48", "c38", "c37", "eligible"]);
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
        const level4Expected = [
            "c48",
            "c38",
            "c37",
            "strength-1",
            "strength-2",
            "strength-3",
            "low-arm-1",
            "low-arm-2",
        ];
        const validationExpected = [
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
        ).toEqual(level4Expected);
        expect(selectValidationCandidateIds(rows, 8)).toEqual(validationExpected);
        expect(selectValidationCandidateIds(rows, 8)).toEqual(validationExpected);
        expect(selectValidationCandidateIds(rows, 1)).toEqual(["c48", "c38"]);
        expect(
            validationExpected.every((id) => rows.find(({ candidateId }) => candidateId === id)?.hasLevel4Evidence),
        ).toBe(true);
        expect(isV08CampaignReserveEligible(rows.find(({ candidateId }) => candidateId === "low-arm-1")!)).toBe(true);
        expect(
            isV08CampaignReserveEligible(rows.find(({ candidateId }) => candidateId === "ineligible-lucky-zero")!),
        ).toBe(false);
        expect(() => selectValidationCandidateIds(rows, 0)).toThrow("must be positive");
        const failedForcedCoverage = rows.map((row) =>
            row.candidateId === "c48" || row.candidateId === "c38" ? { ...row, level4CoveragePassed: false } : row,
        );
        expect(() => selectValidationCandidateIds(failedForcedCoverage, 8)).toThrow("level-4");
        expect(() =>
            selectValidationCandidateIds(
                rows.map((row) => (row.candidateId === "c48" ? { ...row, postA13CoveragePassed: false } : row)),
                8,
            ),
        ).toThrow("post-A13");
        expect(() =>
            selectValidationCandidateIds(
                rows.map((row) => (row.candidateId === "c48" ? { ...row, postA13SpellExercisePassed: false } : row)),
                8,
            ),
        ).toThrow("spell kit");
        expect(() =>
            selectValidationCandidateIds(
                rows.map((row) => (row.candidateId === "c48" ? { ...row, hasLevel4Evidence: false } : row)),
                8,
            ),
        ).toThrow("c48 anchor");
        expect(
            selectValidationCandidateIds(
                rows.map((row) => (row.candidateId === "c38" ? { ...row, hasLevel4Evidence: false } : row)),
                8,
            )[1],
        ).toBe("c37");
        expect(() =>
            selectValidationCandidateIds(
                rows.map((row) =>
                    row.candidateId === "c37" || row.candidateId === "c38"
                        ? { ...row, allUnitQualificationPassed: false }
                        : row,
                ),
                8,
            ),
        ).toThrow("inactive-challenger control");
        expect(() =>
            selectValidationCandidateIds(
                rows.map((row) => (row.candidateId === "c48" ? { ...row, allUnitCoveragePassed: false } : row)),
                8,
            ),
        ).toThrow("all-unit coverage");
        expect(() =>
            selectValidationCandidateIds(
                rows.map((row) => (row.candidateId === "c48" ? { ...row, allUnitQualificationPassed: false } : row)),
                8,
            ),
        ).toThrow("all-unit qualification");
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

        const exactAnchor = {
            ...binding,
            genomeSha256: V08_CAMPAIGN_EXACT_ANCHOR_GENOME_SHA256,
        } as IV08AlignedV1CandidateBinding;
        expect(effectiveBehaviorEnvironment(exactAnchor, "audit.jsonl", false).SEARCH_WAIT_DEADLINE_POLICY).toBe(
            "operation_bounded",
        );
        expect(bounded.SEARCH_WAIT_DEADLINE_POLICY).toBe("operation_bounded");

        const adaptiveChild = {
            ...binding,
            genomeSha256: "1".repeat(64),
            behaviorEnvironment: {
                ...binding.behaviorEnvironment,
                SEARCH_WAIT_DEADLINE_POLICY: "profile",
            },
        } as IV08AlignedV1CandidateBinding;
        expect(effectiveBehaviorEnvironment(adaptiveChild, "audit.jsonl", false).SEARCH_WAIT_DEADLINE_POLICY).toBe(
            "operation_bounded",
        );
    });

    it("denies hostile ambient roster and experiment variables and binds the exact child base environment", () => {
        const hostileAmbient = {
            HOME: "/safe-home",
            FIGHT_MELEE_ROSTERS: "1",
            COHORT: "melee_only",
            FORCE_CREATURES: "Zombie",
            ROSTER_RANGED_MIN: "99",
            ROSTER_FLYER_MAX: "0",
            SIM_NO_ACTIONS: "1",
            AI_VERSION: "v0.1",
            V08_AGGRESSIVE: "hostile",
            SEARCH_GATE: "0.99",
            NODE_OPTIONS: "--inspect",
            BUN_OPTIONS: "--smol",
        };
        const policy = buildV08CampaignChildEnvironmentPolicy(hostileAmbient, "/opt/bun/bin/bun");
        const binding = {
            behaviorEnvironment: {
                SEARCH_GATE: "0.025",
                SEARCH_DECISION_DEADLINE_MS: "150",
                SEARCH_CIRCUIT_BREAKER_MS: "275",
            },
        } as unknown as IV08AlignedV1CandidateBinding;
        const child = buildV08CampaignChildEnvironment(policy, binding, "/evidence/search-audit.jsonl", true);

        expect(policy).toEqual({
            version: V08_CAMPAIGN_CHILD_ENVIRONMENT_POLICY_VERSION,
            strategy: V08_CAMPAIGN_CHILD_ENVIRONMENT_STRATEGY,
            inheritedKeys: ["HOME"],
            baseEnvironment: {
                HOME: "/safe-home",
                PATH: "/opt/bun/bin:/usr/bin:/bin",
                TMPDIR: "/tmp",
                LANG: "C",
                LC_ALL: "C",
                TZ: "UTC",
            },
            baseEnvironmentSha256: fingerprintV08AlignedV1({
                HOME: "/safe-home",
                PATH: "/opt/bun/bin:/usr/bin:/bin",
                TMPDIR: "/tmp",
                LANG: "C",
                LC_ALL: "C",
                TZ: "UTC",
            }),
        });
        expect(isV08CampaignChildEnvironmentPolicyValid(policy)).toBe(true);
        expect(
            isV08CampaignChildEnvironmentPolicyValid({
                ...policy,
                baseEnvironment: { ...policy.baseEnvironment, COHORT: "contaminated" },
            }),
        ).toBe(false);
        for (const key of [
            "FIGHT_MELEE_ROSTERS",
            "COHORT",
            "FORCE_CREATURES",
            "ROSTER_RANGED_MIN",
            "ROSTER_FLYER_MAX",
            "SIM_NO_ACTIONS",
            "AI_VERSION",
            "NODE_OPTIONS",
            "BUN_OPTIONS",
        ]) {
            expect(child[key]).toBeUndefined();
        }
        expect(child.HOME).toBe("/safe-home");
        expect(child.SEARCH_GATE).toBe("0.025");
        expect(child.SEARCH_DECISION_DEADLINE_MS).toBe("");
        expect(child.SEARCH_CIRCUIT_BREAKER_MS).toBe("");
        expect(child.SEARCH_AUDIT).toBe("/evidence/search-audit.jsonl");
        expect(child.V08_AGGRESSIVE).toBe("1");
        expect(child.LIVETWIN).toBe("1");
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
        const anchor = {
            ...validationStrength({ candidateWinRate: 0.48, decisiveWinRate: 0.49 }),
            ...postA13Strength({ candidateWinRate: 0.5, decisiveWinRate: 0.51 }),
        };
        const cleanBounded = {
            ...validationStrength({ candidateWinRate: 0.5, decisiveWinRate: 0.51 }),
            ...postA13Strength({ candidateWinRate: 0.51, decisiveWinRate: 0.52 }),
            isExactAnchor: false,
            unboundedSearch: false,
            hasValidationEvidence: true,
            level4CoveragePassed: true,
            postA13CoveragePassed: true,
            postA13SpellExercisePassed: true,
            hasAllUnitCoverageEvidence: true,
            allUnitCoveragePassed: true,
            hasAllUnitQualificationEvidence: true,
            allUnitQualificationPassed: true,
            hasPassiveQualificationEvidence: true,
            passiveQualificationPassed: true,
            hasBlockCenterQualificationEvidence: true,
            blockCenterQualificationPassed: true,
            armageddonRate: 0,
            level4ArmageddonRate: 0,
            postA13ArmageddonRate: 0,
        };

        expect(isV08CampaignPromotionEligible(cleanBounded, anchor)).toBe(true);
        expect(isV08CampaignPromotionEligible({ ...cleanBounded, isExactAnchor: true }, anchor)).toBe(false);
        expect(isV08CampaignPromotionEligible({ ...cleanBounded, unboundedSearch: true }, anchor)).toBe(false);
        expect(isV08CampaignPromotionEligible({ ...cleanBounded, level4ArmageddonRate: 0.01 }, anchor)).toBe(false);
        expect(isV08CampaignPromotionEligible({ ...cleanBounded, armageddonRate: 0.01 }, anchor)).toBe(false);
        expect(isV08CampaignPromotionEligible({ ...cleanBounded, postA13ArmageddonRate: 0.21 }, anchor)).toBe(false);
        expect(isV08CampaignPromotionEligible({ ...cleanBounded, armageddonRate: -0.01 }, anchor)).toBe(false);
        expect(isV08CampaignPromotionEligible({ ...cleanBounded, hasValidationEvidence: false }, anchor)).toBe(false);
        expect(isV08CampaignPromotionEligible({ ...cleanBounded, level4CoveragePassed: false }, anchor)).toBe(false);
        expect(isV08CampaignPromotionEligible({ ...cleanBounded, postA13CoveragePassed: false }, anchor)).toBe(false);
        expect(isV08CampaignPromotionEligible({ ...cleanBounded, postA13SpellExercisePassed: false }, anchor)).toBe(
            false,
        );
        expect(isV08CampaignPromotionEligible({ ...cleanBounded, hasAllUnitCoverageEvidence: false }, anchor)).toBe(
            false,
        );
        expect(isV08CampaignPromotionEligible({ ...cleanBounded, allUnitCoveragePassed: false }, anchor)).toBe(false);
        expect(
            isV08CampaignPromotionEligible({ ...cleanBounded, hasAllUnitQualificationEvidence: false }, anchor),
        ).toBe(false);
        expect(isV08CampaignPromotionEligible({ ...cleanBounded, allUnitQualificationPassed: false }, anchor)).toBe(
            false,
        );
        expect(
            isV08CampaignPromotionEligible({ ...cleanBounded, hasPassiveQualificationEvidence: false }, anchor),
        ).toBe(false);
        expect(isV08CampaignPromotionEligible({ ...cleanBounded, passiveQualificationPassed: false }, anchor)).toBe(
            false,
        );
        expect(
            isV08CampaignPromotionEligible({ ...cleanBounded, hasBlockCenterQualificationEvidence: false }, anchor),
        ).toBe(false);
        expect(isV08CampaignPromotionEligible({ ...cleanBounded, blockCenterQualificationPassed: false }, anchor)).toBe(
            false,
        );
        expect(isV08CampaignPromotionEligible({ ...cleanBounded, postA13CandidateWinRate: 0.49 }, anchor)).toBe(false);
        expect(
            isV08CampaignPromotionEligible({ ...cleanBounded, postA13CoverageEvidenceSha256: "d".repeat(64) }, anchor),
        ).toBe(false);
        expect(
            isV08CampaignPromotionEligible({ ...cleanBounded, validationEvidenceSha256: "b".repeat(64) }, anchor),
        ).toBe(false);
    });

    it("compares equal-size post-A13 panels against the exact A13 anchor", () => {
        const anchor = postA13Strength({ candidateWinRate: 0.5, decisiveWinRate: 0.51 });
        expect(
            isV08CampaignPostA13StrengthQualified(
                postA13Strength({ candidateWinRate: 0.5, decisiveWinRate: 0.51 }),
                anchor,
            ),
        ).toBe(true);
        expect(
            isV08CampaignPostA13StrengthQualified(
                postA13Strength({ candidateWinRate: 0.49, decisiveWinRate: 0.8 }),
                anchor,
            ),
        ).toBe(false);
        expect(
            isV08CampaignPostA13StrengthQualified(
                postA13Strength({ candidateWinRate: 0.8, decisiveWinRate: 0.8, games: 96 }),
                anchor,
            ),
        ).toBe(false);
        expect(
            isV08CampaignPostA13StrengthQualified(
                postA13Strength({
                    candidateWinRate: 0.8,
                    decisiveWinRate: 0.8,
                    evidenceSha256: "d".repeat(64),
                }),
                anchor,
            ),
        ).toBe(false);
        expect(
            isV08CampaignPostA13StrengthQualified(
                postA13Strength({ candidateWinRate: 0.8, decisiveWinRate: 0.8, armageddonRate: 0.21 }),
                anchor,
            ),
        ).toBe(false);
    });

    it("accepts only schema-v12/generator-v7 A13, decision-quality gates, and immutable-source provenance", () => {
        const sourceUnsigned = {
            branch: "main" as const,
            gitHead: "1".repeat(40),
            gitTree: "2".repeat(40),
            originMain: "1".repeat(40),
            clean: true as const,
            bunVersion: "1.2.3",
        };
        const sourceIdentity = {
            ...sourceUnsigned,
            identitySha256: fingerprintV08AlignedV1(sourceUnsigned),
        };
        const current = {
            schema: V08_CAMPAIGN_SCHEMA,
            kind: "manifest",
            sourceIdentity,
            childEnvironmentPolicy: buildV08CampaignChildEnvironmentPolicy(
                { HOME: "/campaign-home" },
                "/campaign/bin/bun",
            ),
            adaptive: { generatorVersion: V08_CAMPAIGN_ADAPTIVE_GENERATOR_VERSION },
            scheduler: { version: V08_CAMPAIGN_SCHEDULER_VERSION },
            campaignBaseIdentity: {
                campaignCandidateCount: 49,
                exactAnchor: {
                    id: V08_CAMPAIGN_EXACT_ANCHOR_ID,
                    genomeSha256: V08_CAMPAIGN_EXACT_ANCHOR_GENOME_SHA256,
                },
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

        expect(V08_CAMPAIGN_SCHEMA).toBe("hoc.v0_8_aggressive_campaign.v12");
        expect(V08_CAMPAIGN_ADAPTIVE_GENERATOR_VERSION).toBe(7);
        expect(V08_CAMPAIGN_SCHEDULER_VERSION).toBe(1);
        expect(V08_CAMPAIGN_SELECTION_VERSION).toBe(3);
        expect(V08_CAMPAIGN_PROMOTION_COMPARISON_VERSION).toBe(2);
        expect(isV08CampaignSourceIdentityCurrent(sourceIdentity)).toBe(true);
        expect(isV08CampaignManifestProvenanceCurrent(current)).toBe(true);
        expect(isV08CampaignManifestProvenanceCurrent({ ...current, childEnvironmentPolicy: undefined })).toBe(false);
        expect(isV08CampaignManifestProvenanceCurrent({ ...current, schema: "hoc.v0_8_aggressive_campaign.v8" })).toBe(
            false,
        );
        expect(isV08CampaignManifestProvenanceCurrent({ ...current, adaptive: { generatorVersion: 3 } })).toBe(false);
        expect(isV08CampaignManifestProvenanceCurrent({ ...current, scheduler: { version: 0 } })).toBe(false);
        expect(
            isV08CampaignManifestProvenanceCurrent({
                ...current,
                selection: { ...current.selection, version: 1 },
            }),
        ).toBe(false);
        expect(
            isV08CampaignManifestProvenanceCurrent({
                ...current,
                sourceIdentity: { ...sourceIdentity, gitTree: "3".repeat(40) },
            }),
        ).toBe(false);
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
            exactAnchorGenomeSha256: V08_CAMPAIGN_EXACT_ANCHOR_GENOME_SHA256,
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
        expect(jobWorkUnits({ kind: "post_a13_coverage", pairsPerLane: 3 })).toBe(144);
        expect(jobWorkUnits({ kind: "all_unit_coverage", pairsPerMap: 4 })).toBe(2_688);
        expect(jobWorkUnits({ kind: "all_unit_qualification", pairsPerMap: 8 })).toBe(5_376);
        expect(jobWorkUnits({ kind: "passive_qualification", games: 4_096 })).toBe(4_096);
        expect(jobWorkUnits({ kind: "block_center_qualification", games: 50_000 })).toBe(50_000);
        expect(() => jobWorkUnits({ kind: "level4", games: 16 })).toThrow("pairsPerLane");
        expect(() => jobWorkUnits({ kind: "post_a13_coverage", games: 144 })).toThrow("pairsPerLane");
        expect(() => jobWorkUnits({ kind: "all_unit_coverage", games: 2_688 })).toThrow("pairsPerMap");
        expect(() => jobWorkUnits({ kind: "all_unit_qualification", pairsPerLane: 8 })).toThrow("pairsPerMap");
        expect(() => jobWorkUnits({ kind: "passive_qualification", pairsPerMap: 8 })).toThrow("games");
        expect(() => jobWorkUnits({ kind: "block_center_qualification", pairsPerLane: 8 })).toThrow("games");
        expect(() => jobWorkUnits({ kind: "adaptive", pairsPerLane: 2 })).toThrow("games");
    });

    it("refuses resume while a prior child is live or its spawn state is uncertain", () => {
        expect(() =>
            assertV08CampaignResumeHasNoLiveJobs(
                {
                    dead: { pid: 101 },
                    alsoDead: { pid: 102 },
                },
                () => false,
            ),
        ).not.toThrow();
        expect(() =>
            assertV08CampaignResumeHasNoLiveJobs(
                {
                    dead: { pid: 101 },
                    live: { pid: 102 },
                },
                (pid) => pid === 102,
            ),
        ).toThrow("still running: live (pid 102)");
        expect(() =>
            assertV08CampaignResumeHasNoLiveJobs(
                {
                    uncertain: { pid: null },
                },
                () => false,
            ),
        ).toThrow("spawn state is unknown: uncertain");
    });

    it("holds an exclusive writer lease across manifest and checkpoint access", () => {
        const output = mkdtempSync(join(tmpdir(), "hoc-v08-output-lease-"));
        const lease = acquireV08CampaignOutputLease(output);
        try {
            expect(() => acquireV08CampaignOutputLease(output)).toThrow("already leased");
            lease.release();
            expect(() => {
                const reacquired = acquireV08CampaignOutputLease(output);
                reacquired.release();
            }).not.toThrow();
        } finally {
            lease.release();
            rmSync(output, { recursive: true, force: true });
        }
    });

    it("keeps coverage, decision-quality, and validation CLI controls distinct", () => {
        const defaults = parseV08CampaignCli([]);
        expect(defaults.level4PairsPerLane).toBe(16);
        expect(defaults.coveragePairsPerLane).toBe(3);
        expect(defaults.allUnitPairsPerMap).toBe(4);
        expect(defaults.allUnitQualificationPairsPerMap).toBe(8);
        expect(defaults.passiveQualificationGames).toBe(V08_CAMPAIGN_PASSIVE_QUALIFICATION_DEFAULT_GAMES);
        expect(defaults.passiveQualificationMinCreatureAppearances).toBe(
            V08_CAMPAIGN_PASSIVE_QUALIFICATION_DEFAULT_MIN_CREATURE_APPEARANCES,
        );
        expect(defaults.blockCenterQualificationGames).toBe(V08_CAMPAIGN_BLOCK_CENTER_QUALIFICATION_DEFAULT_GAMES);
        expect(defaults.level4Seed).toBe(30_260_719);
        expect(defaults.coverageSeed).toBe(35_260_719);
        expect(defaults.allUnitSeed).toBe(37_260_731);
        expect(defaults.allUnitQualificationSeed).toBe(38_260_724);
        expect(defaults.passiveQualificationSeed).toBe(39_260_719);
        expect(defaults.blockCenterQualificationSeed).toBe(39_760_719);

        const configured = parseV08CampaignCli([
            "--l4-pairs=7",
            "--coverage-pairs=5",
            "--all-unit-pairs=3",
            "--all-unit-qualification-pairs=9",
            "--passive-qualification-games=12",
            "--passive-min-appearances=0",
            "--block-center-qualification-games=14",
            "--level4-seed=11",
            "--coverage-seed=13",
            "--all-unit-seed=17",
            "--all-unit-qualification-seed=19",
            "--passive-qualification-seed=23",
            "--block-center-qualification-seed=29",
        ]);
        expect(configured.level4PairsPerLane).toBe(7);
        expect(configured.coveragePairsPerLane).toBe(5);
        expect(configured.allUnitPairsPerMap).toBe(3);
        expect(configured.allUnitQualificationPairsPerMap).toBe(9);
        expect(configured.passiveQualificationGames).toBe(12);
        expect(configured.passiveQualificationMinCreatureAppearances).toBe(0);
        expect(configured.blockCenterQualificationGames).toBe(14);
        expect(configured.level4Seed).toBe(11);
        expect(configured.coverageSeed).toBe(13);
        expect(configured.allUnitSeed).toBe(17);
        expect(configured.allUnitQualificationSeed).toBe(19);
        expect(configured.passiveQualificationSeed).toBe(23);
        expect(configured.blockCenterQualificationSeed).toBe(29);
    });

    it("binds both decision-quality artifacts to the exact source, schedule, and complete gate schema", () => {
        const passive = passiveQualificationFixture();
        expect(Object.keys(passive.summary.gates.checks)).toEqual([
            ...V08_CAMPAIGN_PASSIVE_QUALIFICATION_REQUIRED_GATES,
        ]);
        expect(() =>
            validateV08CampaignPassiveQualificationSummary(passive.summary, {
                sourceCommit: QUALIFICATION_SOURCE,
                baseSeed: passive.options.baseSeed,
                games: passive.options.games,
                minCreatureAppearances: passive.options.minCreatureAppearances!,
            }),
        ).not.toThrow();
        expect(() =>
            validateV08CampaignPassiveQualificationSummary(
                { ...passive.summary, schema: "hoc.v0_8_passive_turn_panel.v5" },
                {
                    sourceCommit: QUALIFICATION_SOURCE,
                    baseSeed: passive.options.baseSeed,
                    games: passive.options.games,
                    minCreatureAppearances: passive.options.minCreatureAppearances!,
                },
            ),
        ).toThrow("Invalid passive qualification");
        for (const missingGate of [
            "observed_turns_positive",
            "passive_evidence_turns_positive",
            "every_game_observed_turns",
            "turn_totals_consistent",
        ]) {
            const checks = { ...passive.summary.gates.checks };
            delete checks[missingGate];
            expect(() =>
                validateV08CampaignPassiveQualificationSummary(
                    { ...passive.summary, gates: { ...passive.summary.gates, checks } },
                    {
                        sourceCommit: QUALIFICATION_SOURCE,
                        baseSeed: passive.options.baseSeed,
                        games: passive.options.games,
                        minCreatureAppearances: passive.options.minCreatureAppearances!,
                    },
                ),
            ).toThrow("Invalid passive qualification");
        }
        expect(() =>
            validateV08CampaignPassiveQualificationSummary(
                { ...passive.summary, sourceCommit: "2".repeat(40) },
                {
                    sourceCommit: QUALIFICATION_SOURCE,
                    baseSeed: passive.options.baseSeed,
                    games: passive.options.games,
                    minCreatureAppearances: passive.options.minCreatureAppearances!,
                },
            ),
        ).toThrow("Invalid passive qualification");
        const sealedPassiveOptions = {
            ...passive.options,
            inheritCandidateEnvironment: false,
        } satisfies IV08PassiveTurnPanelOptions;
        expect(() =>
            validateV08CampaignPassiveQualificationSummary(
                {
                    ...passive.summary,
                    options: {
                        ...passive.summary.options,
                        inheritCandidateEnvironment: false,
                    },
                    planSha256: fingerprintV08PassiveTurnPanelPlan(sealedPassiveOptions),
                },
                {
                    sourceCommit: QUALIFICATION_SOURCE,
                    baseSeed: passive.options.baseSeed,
                    games: passive.options.games,
                    minCreatureAppearances: passive.options.minCreatureAppearances!,
                },
            ),
        ).toThrow("Invalid passive qualification");

        const block = blockCenterQualificationFixture();
        expect(Object.keys(block.summary.gates.checks)).toEqual([
            ...V08_CAMPAIGN_BLOCK_CENTER_QUALIFICATION_REQUIRED_GATES,
        ]);
        expect(() =>
            validateV08CampaignBlockCenterQualificationSummary(block.summary, {
                sourceCommit: QUALIFICATION_SOURCE,
                baseSeed: block.options.baseSeed,
                games: block.options.games,
            }),
        ).not.toThrow();
        for (const staleSchema of ["hoc.v0_8_block_center_action_panel.v1", "hoc.v0_8_block_center_action_panel.v2"]) {
            expect(() =>
                validateV08CampaignBlockCenterQualificationSummary(
                    { ...block.summary, schema: staleSchema },
                    {
                        sourceCommit: QUALIFICATION_SOURCE,
                        baseSeed: block.options.baseSeed,
                        games: block.options.games,
                    },
                ),
            ).toThrow("Invalid BLOCK_CENTER qualification");
        }
        for (const missingGate of [
            "observed_turns_positive",
            "every_record_has_observations",
            "mountain_state_turn_integrity",
            "creature_turn_integrity",
            "creature_metric_integrity",
            "counter_domain_integrity",
            "failure_sample_integrity",
            "record_result_integrity",
            "metric_semantic_integrity",
            "oracle_direct_exposure_positive",
            "mountain_adjacent_direct_exposure_positive",
            "late_direct_exposure_positive",
            "eliminations_only",
            "strategy_rejections_zero",
            "strategy_engine_rejection_parity",
            "recovery_turns_zero",
            "urgent_mountain_terminal_jitter_zero",
        ]) {
            const checks = { ...block.summary.gates.checks };
            delete checks[missingGate];
            expect(() =>
                validateV08CampaignBlockCenterQualificationSummary(
                    { ...block.summary, gates: { ...block.summary.gates, checks } },
                    {
                        sourceCommit: QUALIFICATION_SOURCE,
                        baseSeed: block.options.baseSeed,
                        games: block.options.games,
                    },
                ),
            ).toThrow("Invalid BLOCK_CENTER qualification");
        }
        expect(() =>
            validateV08CampaignBlockCenterQualificationSummary(
                { ...block.summary, sourceDirty: true },
                {
                    sourceCommit: QUALIFICATION_SOURCE,
                    baseSeed: block.options.baseSeed,
                    games: block.options.games,
                },
            ),
        ).toThrow("Invalid BLOCK_CENTER qualification");
        const sealedBlockOptions = {
            ...block.options,
            inheritCandidateEnvironment: false,
        } satisfies IV08BlockCenterActionPanelOptions;
        expect(() =>
            validateV08CampaignBlockCenterQualificationSummary(
                {
                    ...block.summary,
                    options: {
                        ...block.summary.options,
                        inheritCandidateEnvironment: false,
                    },
                    planSha256: fingerprintV08BlockCenterActionPlan(sealedBlockOptions),
                },
                {
                    sourceCommit: QUALIFICATION_SOURCE,
                    baseSeed: block.options.baseSeed,
                    games: block.options.games,
                },
            ),
        ).toThrow("Invalid BLOCK_CENTER qualification");
    });

    it("accepts only the exact 12-unit, 24-lane post-A13 census", () => {
        const lanes = V08_CAMPAIGN_POST_A13_COVERAGE_LANES.map((lane) => {
            const intrinsicSpell =
                V08_CAMPAIGN_POST_A13_SPELL_EXERCISE_KITS[
                    lane.unit as keyof typeof V08_CAMPAIGN_POST_A13_SPELL_EXERCISE_KITS
                ]?.[0] ?? "Example";
            return {
                lane,
                games: 6,
                candidateGreenGames: 3,
                candidateRedGames: 3,
                mapCensus: V08_POST_A13_LIVE_MAPS.map((mapType) => ({
                    mapType,
                    games: 2,
                    candidateGreenGames: 1,
                    candidateRedGames: 1,
                })),
                candidateWins: 3,
                opponentWins: 2,
                draws: 1,
                appearances: 6,
                actingTurns: 8,
                completedActions: 4,
                completedStrategyActions: 4,
                completedRecoveryActions: 0,
                rejectedStrategyActions: 0,
                rejectedRecoveryActions: 0,
                productiveActions: 4,
                turnsWithoutProductiveAction: 4,
                rejectedCandidate: 0,
                rejectedOpponent: 0,
                rawEndTurnDecisions: 0,
                actionTypes: { move_unit: 3, cast_spell: 1 },
                rejectionReasons: {},
                spellDecisionTurns: 8,
                activeSpellTurns: 3,
                activeSpellChargesObserved: 6,
                activeSpellsObserved: { [intrinsicSpell]: 3 },
                activeSpellChargesByName: { [intrinsicSpell]: 6 },
                spellCasts: { [intrinsicSpell]: 1 },
                armageddonReached: 0,
                armageddonDecided: 0,
            };
        });
        const coverageOptions = {
            candidateVersion: "v0.8s",
            opponentVersion: "v0.7",
            baseSeed: 13,
            pairsPerLane: 3,
        };
        const summary = {
            schema: V08_CAMPAIGN_POST_A13_COVERAGE_SCHEMA,
            ...coverageOptions,
            maps: V08_POST_A13_LIVE_MAPS,
            planSha256: fingerprintV08PostA13CoveragePlan(coverageOptions),
            games: 144,
            lanes,
        };

        expect(V08_CAMPAIGN_POST_A13_COVERAGE_LANE_COUNT).toBe(24);
        expect(() =>
            validateV08CampaignPostA13CoverageSummary(summary, {
                baseSeed: 13,
                pairsPerLane: 3,
                games: 144,
            }),
        ).not.toThrow();
        expect(() =>
            validateV08CampaignPostA13CoverageSummary({
                ...summary,
                lanes: [...lanes.slice(0, -1), lanes[0]],
            }),
        ).toThrow("Duplicate");
        expect(() =>
            validateV08CampaignPostA13CoverageSummary({ ...summary, schema: "hoc.v0_8_l4_coverage.v1" }),
        ).toThrow("Invalid post-A13");
        expect(() =>
            validateV08CampaignPostA13CoverageSummary({
                ...summary,
                lanes: [{ ...lanes[0]!, lane: { ...lanes[0]!.lane, unit: "Fake" } }, ...lanes.slice(1)],
            }),
        ).toThrow("Invalid post-A13");
        expect(() =>
            validateV08CampaignPostA13CoverageSummary({
                ...summary,
                maps: [PBTypes.GridVals.WATER_CENTER],
            }),
        ).toThrow("Invalid post-A13");
        expect(() =>
            validateV08CampaignPostA13CoverageSummary({
                ...summary,
                lanes: [{ ...lanes[0]!, spellDecisionTurns: 7 }, ...lanes.slice(1)],
            }),
        ).toThrow("Invalid post-A13");
        expect(() =>
            validateV08CampaignPostA13CoverageSummary({
                ...summary,
                lanes: [{ ...lanes[0]!, armageddonDecided: 1 }, ...lanes.slice(1)],
            }),
        ).toThrow("Invalid post-A13");
        expect(() =>
            validateV08CampaignPostA13CoverageSummary({
                ...summary,
                lanes: [
                    {
                        ...lanes[0]!,
                        actionTypes: { ...lanes[0]!.actionTypes, cast_spell: 2 },
                    },
                    ...lanes.slice(1),
                ],
            }),
        ).toThrow("Invalid post-A13");
        expect(() =>
            validateV08CampaignPostA13CoverageSummary({
                ...summary,
                lanes: [
                    {
                        ...lanes[0]!,
                        spellCasts: { Unobserved: 1 },
                    },
                    ...lanes.slice(1),
                ],
            }),
        ).toThrow("Invalid post-A13");

        const candidateSpellLane = lanes.find(
            ({ lane }) => lane.unit === "Magic Dragon" && lane.owner === "candidate",
        )!;
        const candidateIncidentalSpellLane = lanes.find(
            ({ lane }) => lane.unit === "Mermaid" && lane.owner === "candidate",
        )!;
        const opponentSpellLane = lanes.find(({ lane }) => lane.unit === "Magic Dragon" && lane.owner === "opponent")!;
        expect(Object.keys(V08_CAMPAIGN_POST_A13_SPELL_EXERCISE_KITS)).toEqual([
            "Blacksmith",
            "Ash Moth",
            "Trent",
            "Battle Mage",
            "Nightmare",
            "Magic Dragon",
        ]);
        expect(isV08CampaignPostA13LaneBehaviorQualified(candidateSpellLane)).toBe(true);
        expect(isV08CampaignPostA13LaneBehaviorQualified({ ...candidateSpellLane, spellCasts: {} })).toBe(true);
        expect(isV08CampaignPostA13SpellExerciseQualified(lanes)).toBe(true);
        expect(
            isV08CampaignPostA13SpellExerciseQualified(
                lanes.map((lane) => (lane === candidateIncidentalSpellLane ? { ...lane, spellCasts: {} } : lane)),
            ),
        ).toBe(true);
        expect(
            isV08CampaignPostA13SpellExerciseQualified(
                lanes.map((lane) => (lane === candidateSpellLane ? { ...lane, spellCasts: {} } : lane)),
            ),
        ).toBe(false);
        for (const unit of Object.keys(V08_CAMPAIGN_POST_A13_SPELL_EXERCISE_KITS)) {
            expect(
                isV08CampaignPostA13SpellExerciseQualified(
                    lanes.map((lane) =>
                        lane.lane.owner === "candidate" && lane.lane.unit === unit ? { ...lane, spellCasts: {} } : lane,
                    ),
                ),
            ).toBe(false);
        }
        expect(
            isV08CampaignPostA13SpellExerciseQualified(
                lanes.map((lane) =>
                    lane === candidateSpellLane
                        ? {
                              ...lane,
                              spellCasts: { "Wild Regeneration": 1 },
                          }
                        : lane,
                ),
            ),
        ).toBe(false);
        expect(isV08CampaignPostA13LaneBehaviorQualified({ ...candidateSpellLane, rejectedStrategyActions: 1 })).toBe(
            false,
        );
        expect(
            isV08CampaignPostA13LaneBehaviorQualified({
                ...opponentSpellLane,
                rejectedOpponent: 1,
                rejectedStrategyActions: 1,
                rawEndTurnDecisions: 1,
                spellCasts: {},
            }),
        ).toBe(true);
        expect(isV08CampaignPostA13LaneBehaviorQualified({ ...opponentSpellLane, rejectedCandidate: 1 })).toBe(false);
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

        const deepAllUnit = { kind: "all_unit_qualification" as const, pairsPerMap: 1 };
        const shallowAllUnit: IJobDurationSample[] = [10, 12, 11].map((millisecondsPerGame) => ({
            kind: "all_unit_coverage" as const,
            pairsPerMap: 1,
            durationMs: 672 * millisecondsPerGame,
        }));
        expect(estimateBatchDurationMs([deepAllUnit], [], 4)).toBe(336_000);
        expect(estimateBatchDurationMs([deepAllUnit], shallowAllUnit, 4)).toBe(8_064);
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

    it("commits a reconciled full validation round after deadline but never launches pending work", () => {
        const state = (pendingJobs: number, nowMs: number, stop = false, launchesAllowed = true) =>
            classifyV08CampaignValidationRoundState({
                pendingJobs,
                nowMs,
                deadlineAtMs: 100,
                stop,
                launchesAllowed,
            });

        expect(state(0, 100)).toBe("commit");
        expect(state(0, 101, true, false)).toBe("commit");
        expect(state(1, 99)).toBe("launch");
        expect(state(1, 100)).toBe("stop");
        expect(state(1, 99, true)).toBe("stop");
        expect(state(1, 99, false, false)).toBe("stop");
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

    it("requires the exact decision-quality census to finish before any validation evidence", () => {
        const candidateIds = ["c48", "c38"];
        const completedAt = new Date(4_000).toISOString();
        const quality = candidateIds.flatMap((candidateId) => [
            {
                id: `passive-qualification-${candidateId}`,
                kind: "passive_qualification" as const,
                candidateId,
                games: 1_024,
                baseSeed: 11,
                startedAtMs: 1_000,
                completedAt,
            },
            {
                id: `block-center-qualification-${candidateId}`,
                kind: "block_center_qualification" as const,
                candidateId,
                games: 1_024,
                baseSeed: 13,
                startedAtMs: 2_000,
                completedAt,
            },
        ]);
        const validation = {
            id: "validation-r000-c48",
            kind: "validation" as const,
            candidateId: "c48",
            games: 1_024,
            baseSeed: 17,
            startedAtMs: 5_000,
            completedAt: new Date(6_000).toISOString(),
        };
        const input = {
            candidateIds,
            passiveGames: 1_024,
            passiveSeed: 11,
            blockCenterGames: 1_024,
            blockCenterSeed: 13,
        };

        expect(() =>
            assertV08CampaignDecisionQualityPrecedesValidation({ ...input, completed: quality }),
        ).not.toThrow();
        expect(() =>
            assertV08CampaignDecisionQualityPrecedesValidation({
                ...input,
                completed: [...quality, validation],
            }),
        ).not.toThrow();
        expect(() =>
            assertV08CampaignDecisionQualityPrecedesValidation({
                ...input,
                completed: [...quality.slice(1), validation],
            }),
        ).toThrow("missing passive_qualification");
        expect(() =>
            assertV08CampaignDecisionQualityPrecedesValidation({
                ...input,
                completed: [{ ...quality[0]!, baseSeed: 99 }, ...quality.slice(1), validation],
            }),
        ).toThrow("immutable qualification plan");
        expect(() =>
            assertV08CampaignDecisionQualityPrecedesValidation({
                ...input,
                completed: [
                    { ...quality[0]!, completedAt: new Date(7_000).toISOString() },
                    ...quality.slice(1),
                    validation,
                ],
            }),
        ).toThrow("did not precede validation");
    });

    it("keeps the persisted selection source stable after a completed validation round and resume", () => {
        const preValidation = [
            { id: "screen-c48", kind: "screen" as const },
            { id: "adaptive-a00", kind: "adaptive" as const },
            { id: "level4-c48", kind: "level4" as const },
            { id: "post-a13-coverage-c48", kind: "post_a13_coverage" as const },
            { id: "all-unit-coverage-c48", kind: "all_unit_coverage" as const },
            { id: "all-unit-qualification-c48", kind: "all_unit_qualification" as const },
        ];
        const resumedAfterRound = [
            ...preValidation,
            { id: "passive-qualification-c48", kind: "passive_qualification" as const },
            { id: "block-center-qualification-c48", kind: "block_center_qualification" as const },
            { id: "validation-r000-c48", kind: "validation" as const },
            { id: "validation-r000-c38", kind: "validation" as const },
        ];

        expect(V08_CAMPAIGN_VALIDATION_SELECTION_SOURCE_KINDS).toEqual([
            "screen",
            "adaptive",
            "level4",
            "post_a13_coverage",
            "all_unit_coverage",
            "all_unit_qualification",
        ]);
        expect(resumedAfterRound.filter(isV08CampaignValidationSelectionSourceJob)).toEqual(preValidation);
    });
});
