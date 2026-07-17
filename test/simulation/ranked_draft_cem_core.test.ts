/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import { LEAGUE_ANCHOR_GENOME, LEAGUE_GENOME_LAYOUT } from "../../src/simulation/league_genome";
import {
    RANKED_DRAFT_CURRENT_INCUMBENT_ID,
    rankedDraftCurrentIncumbent,
    type IRankedDraftEvaluationReport,
    type IRankedDraftGameRecord,
    type RankedDraftCohort,
} from "../../src/simulation/ranked_draft_eval";
import {
    assertDisjointRankedDraftSeedRanges,
    createRankedDraftCandidateGenome,
    createRankedDraftCemDistribution,
    evaluateRankedDraftGuard,
    evaluateRankedDraftTargetedGuard,
    rankedDraftPanelSeedRange,
    refitRankedDraftCemDistribution,
    sampleRankedDraftCemPopulation,
} from "../../src/simulation/optimizer/ranked_draft_cem_core";

const report = (
    candidateId: string,
    directLow: number,
    worst: number,
    rejected: number,
    drawOrArmageddon: number,
): IRankedDraftEvaluationReport =>
    ({
        schemaVersion: 1,
        status: "research_only_no_bake",
        candidateId,
        totalGames: 4_000,
        options: {
            gamesPerOpponent: 1_000,
            baseSeed: 0xc0000000,
            concurrency: 6,
            fightVersion: "v0.7",
            maxLaps: 60,
            mapTypes: [1, 3, 4],
            setupRules: "all",
            draftDimensions: { offset: 0, length: 15 },
            clusterSize: 4,
            seedAllocation: "indexed-bijective-v1",
            seedChannelsPerBoard: 3,
            commonBattleSeed: true,
            behaviorTrace: "canonical-sha256-v1",
            executedActionsRecorded: true,
        },
        opponents: [
            {
                opponentId: RANKED_DRAFT_CURRENT_INCUMBENT_ID,
                games: 1_000,
                offerBoards: 250,
                wins: candidateId === "incumbent" ? 500 : 550,
                losses: candidateId === "incumbent" ? 500 : 450,
                draws: 0,
                decisiveGames: 1_000,
                decisiveWinRate: candidateId === "incumbent" ? 0.5 : 0.55,
                confidence95: { low: directLow, high: 0.58 },
                clusteredLowerBound: directLow,
                drawOrArmageddonRate: drawOrArmageddon,
                rejectedCandidate: rejected,
                rejectedOpponent: 0,
            },
        ],
        maps: [1, 3, 4].map((mapType) => ({
            mapType,
            games: 1_000,
            offerBoards: 250,
            wins: 500,
            losses: 500,
            draws: 0,
            decisiveGames: 1_000,
            decisiveWinRate: 0.5,
            confidence95: { low: 0.48, high: 0.52 },
            clusteredLowerBound: 0.48,
            drawOrArmageddonRate: drawOrArmageddon,
            rejectedCandidate: rejected,
            rejectedOpponent: 0,
            avgLaps: 7,
            endReasons: { elimination: 1_000, turn_cap: 0, stuck: 0 },
        })),
        cohortDefinitions: {
            ranged: "candidate roster contains at least one RANGE creature",
            mage: "candidate roster contains at least one MAGIC creature",
            melee_magic: "candidate roster contains at least one MELEE_MAGIC creature",
            aura_heavy: "candidate roster contains at least one creature carrying an aura",
        },
        cohorts: (["ranged", "mage", "melee_magic", "aura_heavy"] as const).map((cohort) => ({
            cohort,
            games: 1_000,
            wins: 510,
            losses: 490,
            draws: 0,
            decisiveGames: 1_000,
            decisiveWinRate: 0.51,
            confidence95: { low: 0.48, high: 0.54 },
        })),
        aggregate: {
            fitness: worst,
            worstCaseLowerBound: worst,
            worstCaseOpponent: RANKED_DRAFT_CURRENT_INCUMBENT_ID,
            rejectedCandidate: rejected,
            rejectedOpponent: 0,
            drawOrArmageddonRate: drawOrArmageddon,
            avgLaps: 7,
            endReasons: { elimination: 4_000, turn_cap: 0, stuck: 0 },
            behaviorTraceSetSha256: "a".repeat(64),
        },
        qualification: "fixture",
    }) as IRankedDraftEvaluationReport;

describe("ranked draft CEM core", () => {
    it("samples deterministically in exactly 15 dimensions and projects every tail", () => {
        const incumbent = rankedDraftCurrentIncumbent();
        const distribution = createRankedDraftCemDistribution(incumbent, 0.25, 2.5, 0.2);
        expect(distribution.mean).toHaveLength(LEAGUE_GENOME_LAYOUT.draftIntrinsic.length);
        expect(distribution.sigma).toHaveLength(LEAGUE_GENOME_LAYOUT.draftIntrinsic.length);
        const first = sampleRankedDraftCemPopulation(distribution.mean, distribution.sigma, 6, 17, 4);
        const second = sampleRankedDraftCemPopulation(distribution.mean, distribution.sigma, 6, 17, 4);
        expect(first).toEqual(second);
        expect(first[0]).toEqual(distribution.mean);
        expect(first[1]).not.toEqual(distribution.mean);

        const candidate = createRankedDraftCandidateGenome("candidate", first[1]);
        expect(candidate.weights.slice(0, 15)).toEqual(first[1]);
        expect(candidate.weights.slice(15)).toEqual(LEAGUE_ANCHOR_GENOME.slice(15));
    });

    it("refits elites without expanding the trainable surface", () => {
        const distribution = createRankedDraftCemDistribution(rankedDraftCurrentIncumbent(), 0.25, 2.5, 0.2);
        const left = distribution.mean.map((value) => value - 1);
        const right = distribution.mean.map((value) => value + 1);
        const refit = refitRankedDraftCemDistribution(
            [
                { intrinsic: left, fitness: 0.6, candidateId: "left" },
                { intrinsic: right, fitness: 0.7, candidateId: "right" },
            ],
            distribution,
            0.9,
        );
        refit.mean.forEach((value, index) => expect(value).toBeCloseTo(distribution.mean[index], 12));
        expect(refit.mean).toHaveLength(15);
        expect(refit.sigma.every((value, index) => value >= distribution.sigmaFloor[index])).toBeTrue();
    });

    it("allocates disjoint training, selection, and untouched guard seed ranges", () => {
        const training = rankedDraftPanelSeedRange("training", 0x01000000, 600 * 1_000, 4);
        const selection = rankedDraftPanelSeedRange("selection", 0x60000000, 1_600, 4);
        const guard = rankedDraftPanelSeedRange("guard", 0xc0000000, 8_000, 4);
        expect(() => assertDisjointRankedDraftSeedRanges([guard, training, selection])).not.toThrow();
        expect(training.seedChannels).toBe((600 * 1_000 * 4 * 3) / 4);

        const overlap = rankedDraftPanelSeedRange("overlap", training.endSeedExclusive - 1, 8, 1);
        expect(() => assertDisjointRankedDraftSeedRanges([training, overlap])).toThrow("overlaps");
    });

    it("requires a decisive clustered guard win, zero rejections, and robust non-regression", () => {
        const incumbent = report("incumbent", 0.45, 0.48, 0, 0.05);
        const passing = evaluateRankedDraftGuard(report("candidate", 0.52, 0.479, 0, 0.055), incumbent);
        expect(passing.eligibleForManualReview).toBeTrue();
        expect(passing.checks.candidateVsIncumbentLower95AboveEven).toBeTrue();

        const rejected = evaluateRankedDraftGuard(report("candidate", 0.52, 0.479, 1, 0.055), incumbent);
        expect(rejected.eligibleForManualReview).toBeFalse();
        expect(rejected.checks.candidateRejectedActionsZero).toBeFalse();

        const underCovered = report("candidate", 0.52, 0.479, 0, 0.055);
        underCovered.cohorts[0] = { ...underCovered.cohorts[0], games: 199, decisiveGames: 199 };
        const coverageFailure = evaluateRankedDraftGuard(underCovered, incumbent);
        expect(coverageFailure.eligibleForManualReview).toBeTrue();
        expect(coverageFailure.cohortCoverage.cohorts[0].covered).toBeFalse();

        const weakMap = report("candidate", 0.52, 0.479, 0, 0.055);
        weakMap.maps[1] = {
            ...weakMap.maps[1],
            confidence95: { low: 0.479, high: 0.52 },
            clusteredLowerBound: 0.479,
        };
        const mapFailure = evaluateRankedDraftGuard(weakMap, incumbent);
        expect(mapFailure.eligibleForManualReview).toBeFalse();
        expect(mapFailure.checks.allLiveMapsClusteredLower95AtLeast48).toBeFalse();

        const waterPanel = report("candidate", 0.52, 0.479, 0, 0.055);
        waterPanel.options.mapTypes = [1, 2, 3, 4];
        const waterFailure = evaluateRankedDraftGuard(waterPanel, incumbent);
        expect(waterFailure.eligibleForManualReview).toBeFalse();
        expect(waterFailure.checks.exactLiveMapPanel).toBeFalse();
    });

    it("fails each targeted named cohort closed below its preregistered point, LCB, or coverage floor", () => {
        const names: RankedDraftCohort[] = ["ranged", "mage", "melee_magic", "aura_heavy"];
        const inputs = names.map((cohort, cohortIndex) => {
            const records: IRankedDraftGameRecord[] = [];
            for (let board = 0; board < 2_500; board += 1) {
                const pairSeed = cohortIndex * 1_000_000 + board + 1;
                for (let mirror = 0; mirror < 2; mirror += 1) {
                    records.push({
                        opponentId: "opponent",
                        game: board * 4 + mirror,
                        offerBoard: board,
                        pickSeat: "candidate-lower",
                        battleMirror: mirror as 0 | 1,
                        setupFingerprint: "setup",
                        behaviorTraceSha256: "b".repeat(64),
                        pairSeed,
                        pickSeed: pairSeed + 100_000,
                        battleSeed: pairSeed + 200_000,
                        gridType: 1,
                        candidateSide: mirror ? "red" : "green",
                        winner: "green",
                        candidateResult: mirror ? "loss" : "win",
                        laps: 7,
                        endReason: "elimination",
                        collisions: 0,
                        candidateCohorts: [cohort],
                        decidedByArmageddon: false,
                        rejectedCandidate: 0,
                        rejectedOpponent: 0,
                    });
                }
            }
            return {
                cohort,
                requiredOfferBoards: 2_500,
                scannedOfferBoards: 3_000,
                exhausted: false,
                records,
            };
        });
        const passing = evaluateRankedDraftTargetedGuard(inputs);
        expect(passing.eligibleForManualReview).toBeTrue();
        expect(passing.cohorts.every((cohort) => cohort.confidence95.low >= 0.48)).toBeTrue();

        const underCovered = structuredClone(inputs);
        underCovered[0].records.splice(-2);
        const failure = evaluateRankedDraftTargetedGuard(underCovered);
        expect(failure.eligibleForManualReview).toBeFalse();
        expect(failure.cohorts[0].checks.enoughQualifiedOfferBoards).toBeFalse();
    });
});
