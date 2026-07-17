/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import { createHash } from "node:crypto";

import { createLeagueGenome, LEAGUE_ANCHOR_GENOME, LEAGUE_GENOME_LAYOUT, type ILeagueGenome } from "../league_genome";
import {
    clusteredRankedDraftConfidence95,
    normalizeRankedDraftGenome,
    RANKED_DRAFT_COHORT_DEFINITIONS,
    RANKED_DRAFT_CURRENT_INCUMBENT_ID,
    RANKED_DRAFT_LIVE_MAP_TYPES,
    type IRankedDraftEvaluationReport,
    type IRankedDraftGameRecord,
    type RankedDraftCohort,
} from "../ranked_draft_eval";

const UINT32_SPACE = 0x1_0000_0000;
const SEED_CHANNELS_PER_BOARD = 3;

export interface IRankedDraftCemScore {
    intrinsic: number[];
    fitness: number;
    candidateId: string;
}

export interface IRankedDraftCemDistribution {
    mean: number[];
    sigma: number[];
    sigmaFloor: number[];
}

export interface IRankedDraftSeedRange {
    purpose: string;
    baseSeed: number;
    endSeedExclusive: number;
    seedChannels: number;
}

export interface IRankedDraftGuardDecision {
    schemaVersion: 1;
    status: "research_only_no_bake";
    eligibleForManualReview: boolean;
    checks: {
        candidateVsIncumbentLower95AboveEven: boolean;
        candidateRejectedActionsZero: boolean;
        robustPoolNonRegression: boolean;
        drawOrArmageddonNonRegression: boolean;
        incumbentSelfPlayExactSymmetry: boolean;
        incumbentRejectedActionsZero: boolean;
        exactLiveMapPanel: boolean;
        allLiveMapsPointEstimateAtLeast49_5: boolean;
        allLiveMapsClusteredLower95AtLeast48: boolean;
        allLiveMapsCandidateRejectedActionsZero: boolean;
        comparableGuardPanel: boolean;
    };
    candidateVsIncumbent: {
        decisiveWinRate: number;
        confidence95: { low: number; high: number };
        decisiveGames: number;
    };
    incumbentSymmetryControl: {
        wins: number;
        losses: number;
        draws: number;
        decisiveGames: number;
        decisiveWinRate: number | null;
        rejectedCandidate: number;
    };
    thresholds: {
        candidateVsIncumbentLower95: 0.5;
        robustPoolTolerance: 0.005;
        drawOrArmageddonTolerance: 0.01;
        liveMapDecisiveWinRate: 0.495;
        liveMapClusteredLower95: 0.48;
        rejectedCandidate: 0;
    };
    liveMapGuard: {
        mapType: number;
        games: number;
        decisiveGames: number;
        decisiveWinRate: number;
        confidence95: { low: number; high: number };
        rejectedCandidate: number;
        avgLaps: number;
        endReasons: Record<"elimination" | "turn_cap" | "stuck", number>;
        checks: {
            pointEstimateAtLeast49_5: boolean;
            clusteredLower95AtLeast48: boolean;
            candidateRejectedActionsZero: boolean;
        };
    }[];
    cohortCoverage: {
        minimumGames: number;
        minimumDecisiveGames: number;
        cohorts: {
            cohort: "ranged" | "mage" | "melee_magic" | "aura_heavy";
            candidateGames: number;
            candidateDecisiveGames: number;
            incumbentGames: number;
            incumbentDecisiveGames: number;
            candidateDecisiveWinRate: number;
            incumbentDecisiveWinRate: number;
            covered: boolean;
            pointEstimateNonRegression: boolean;
        }[];
    };
    qualification: string;
}

export interface IRankedDraftTargetedCohortInput {
    cohort: RankedDraftCohort;
    requiredOfferBoards: number;
    scannedOfferBoards: number;
    exhausted: boolean;
    records: IRankedDraftGameRecord[];
}

export interface IRankedDraftTargetedCohortSummary {
    cohort: RankedDraftCohort;
    requiredOfferBoards: number;
    qualifiedOfferBoards: number;
    scannedOfferBoards: number;
    exhausted: boolean;
    games: number;
    decisiveGames: number;
    wins: number;
    losses: number;
    draws: number;
    decisiveWinRate: number;
    confidence95: { low: number; high: number };
    rejectedCandidate: number;
    rejectedOpponent: number;
    opponentBreakdown: {
        opponentId: string;
        qualifiedOfferBoards: number;
        games: number;
        decisiveWinRate: number;
    }[];
    checks: {
        enoughQualifiedOfferBoards: boolean;
        pointEstimateAtLeast49_5: boolean;
        clusteredLower95AtLeast48: boolean;
        candidateRejectedActionsZero: boolean;
    };
    passed: boolean;
}

export interface IRankedDraftTargetedGuardDecision {
    schemaVersion: 1;
    status: "research_only_no_bake";
    eligibleForManualReview: boolean;
    thresholds: {
        decisiveWinRate: 0.495;
        clusteredLower95: 0.48;
        rejectedCandidate: 0;
    };
    cohortDefinitions: Record<RankedDraftCohort, string>;
    cohorts: IRankedDraftTargetedCohortSummary[];
    qualification: string;
}

function canonicalValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalValue);
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, entry]) => [key, canonicalValue(entry)]),
        );
    }
    return value;
}

export function fingerprintRankedDraftArtifact(value: unknown): string {
    return createHash("sha256")
        .update(JSON.stringify(canonicalValue(value)))
        .digest("hex");
}

function assertIntrinsic(values: readonly number[], label: string): void {
    if (values.length !== LEAGUE_GENOME_LAYOUT.draftIntrinsic.length) {
        throw new RangeError(
            `${label} has ${values.length} dimensions; expected ${LEAGUE_GENOME_LAYOUT.draftIntrinsic.length}`,
        );
    }
    if (!values.every((value) => Number.isFinite(value))) throw new TypeError(`${label} must contain finite numbers`);
}

const createGaussian = (seed: number): (() => number) => {
    let state = seed >>> 0 || 1;
    const random = (): number => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / UINT32_SPACE;
    };
    return () => {
        let u = 0;
        let v = 0;
        while (!u) u = random();
        while (!v) v = random();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
};

export function createRankedDraftCemDistribution(
    incumbent: ILeagueGenome,
    relativeSigma: number,
    zeroSigma: number,
    sigmaFloorRatio: number,
): IRankedDraftCemDistribution {
    for (const [label, value] of [
        ["relativeSigma", relativeSigma],
        ["zeroSigma", zeroSigma],
        ["sigmaFloorRatio", sigmaFloorRatio],
    ] as const) {
        if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be positive`);
    }
    const projected = normalizeRankedDraftGenome(incumbent);
    const { offset, length } = LEAGUE_GENOME_LAYOUT.draftIntrinsic;
    const mean = projected.weights.slice(offset, offset + length);
    const sigma = mean.map((coefficient) =>
        coefficient === 0 ? zeroSigma : relativeSigma * (Math.abs(coefficient) + 0.5),
    );
    return { mean, sigma, sigmaFloor: sigma.map((value) => value * sigmaFloorRatio) };
}

export function sampleRankedDraftCemPopulation(
    mean: readonly number[],
    sigma: readonly number[],
    population: number,
    baseSeed: number,
    generation: number,
): number[][] {
    assertIntrinsic(mean, "Ranked draft CEM mean");
    assertIntrinsic(sigma, "Ranked draft CEM sigma");
    if (!Number.isInteger(population) || population < 2) throw new RangeError("population must be at least two");
    if (!Number.isInteger(generation) || generation < 0) throw new RangeError("generation must be non-negative");
    const gaussian = createGaussian((baseSeed + Math.imul(generation + 1, 0x9e3779b1)) >>> 0);
    const candidates: number[][] = [[...mean]];
    for (let candidate = 1; candidate < population; candidate += 1) {
        candidates.push(mean.map((value, dimension) => value + sigma[dimension] * gaussian()));
    }
    return candidates;
}

export function refitRankedDraftCemDistribution(
    elite: readonly IRankedDraftCemScore[],
    distribution: IRankedDraftCemDistribution,
    sigmaDecay: number,
): IRankedDraftCemDistribution {
    if (!elite.length) throw new RangeError("Ranked draft CEM elite must not be empty");
    if (!Number.isFinite(sigmaDecay) || sigmaDecay <= 0 || sigmaDecay > 1) {
        throw new RangeError("sigmaDecay must be in (0, 1]");
    }
    assertIntrinsic(distribution.mean, "Ranked draft CEM mean");
    assertIntrinsic(distribution.sigma, "Ranked draft CEM sigma");
    assertIntrinsic(distribution.sigmaFloor, "Ranked draft CEM sigma floor");
    elite.forEach((candidate) => assertIntrinsic(candidate.intrinsic, `Elite ${candidate.candidateId}`));
    const mean: number[] = [];
    const sigma: number[] = [];
    for (let dimension = 0; dimension < distribution.mean.length; dimension += 1) {
        const values = elite.map((candidate) => candidate.intrinsic[dimension]);
        const average = values.reduce((sum, value) => sum + value, 0) / values.length;
        const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length;
        mean.push(average);
        sigma.push(
            Math.max(
                distribution.sigmaFloor[dimension],
                Math.sqrt(variance),
                distribution.sigma[dimension] * sigmaDecay,
            ),
        );
    }
    return { mean, sigma, sigmaFloor: [...distribution.sigmaFloor] };
}

export function createRankedDraftCandidateGenome(id: string, intrinsic: readonly number[]): ILeagueGenome {
    assertIntrinsic(intrinsic, "Ranked draft intrinsic candidate");
    const weights = [...LEAGUE_ANCHOR_GENOME];
    weights.splice(LEAGUE_GENOME_LAYOUT.draftIntrinsic.offset, intrinsic.length, ...intrinsic);
    return normalizeRankedDraftGenome(createLeagueGenome(id, weights), id);
}

export function rankedDraftPanelSeedRange(
    purpose: string,
    baseSeed: number,
    gamesPerOpponent: number,
    opponentCount: number,
): IRankedDraftSeedRange {
    if (!purpose.trim()) throw new TypeError("Seed range purpose must not be empty");
    if (!Number.isSafeInteger(baseSeed) || baseSeed < 0 || baseSeed >= UINT32_SPACE) {
        throw new RangeError("Seed range baseSeed must be a uint32");
    }
    if (!Number.isInteger(gamesPerOpponent) || gamesPerOpponent < 8 || gamesPerOpponent % 4) {
        throw new RangeError("gamesPerOpponent must be a multiple of four and at least eight");
    }
    if (!Number.isInteger(opponentCount) || opponentCount < 1) throw new RangeError("opponentCount must be positive");
    const seedChannels = (gamesPerOpponent / 4) * opponentCount * SEED_CHANNELS_PER_BOARD;
    const endSeedExclusive = baseSeed + seedChannels;
    if (!Number.isSafeInteger(endSeedExclusive) || endSeedExclusive > UINT32_SPACE) {
        throw new RangeError(`${purpose} seed range exceeds uint32 space`);
    }
    return { purpose, baseSeed, endSeedExclusive, seedChannels };
}

export function assertDisjointRankedDraftSeedRanges(ranges: readonly IRankedDraftSeedRange[]): void {
    const ordered = [...ranges].sort((left, right) => left.baseSeed - right.baseSeed);
    for (let index = 1; index < ordered.length; index += 1) {
        if (ordered[index].baseSeed < ordered[index - 1].endSeedExclusive) {
            throw new Error(`${ordered[index - 1].purpose} overlaps ${ordered[index].purpose}`);
        }
    }
}

export function evaluateRankedDraftGuard(
    candidate: IRankedDraftEvaluationReport,
    incumbent: IRankedDraftEvaluationReport,
): IRankedDraftGuardDecision {
    const candidateDirect = candidate.opponents.find(
        (opponent) => opponent.opponentId === RANKED_DRAFT_CURRENT_INCUMBENT_ID,
    );
    if (!candidateDirect) throw new Error("Guard candidate report omitted the current ranked draft incumbent");
    const incumbentDirect = incumbent.opponents.find(
        (opponent) => opponent.opponentId === RANKED_DRAFT_CURRENT_INCUMBENT_ID,
    );
    if (!incumbentDirect) throw new Error("Guard incumbent report omitted its direct self-play control");
    const comparableGuardPanel =
        candidate.options.baseSeed === incumbent.options.baseSeed &&
        candidate.options.gamesPerOpponent === incumbent.options.gamesPerOpponent &&
        JSON.stringify(candidate.options.mapTypes) === JSON.stringify(incumbent.options.mapTypes) &&
        JSON.stringify(candidate.opponents.map(({ opponentId }) => opponentId)) ===
            JSON.stringify(incumbent.opponents.map(({ opponentId }) => opponentId));
    const exactLiveMapPanel =
        JSON.stringify(candidate.options.mapTypes) === JSON.stringify(RANKED_DRAFT_LIVE_MAP_TYPES) &&
        JSON.stringify(incumbent.options.mapTypes) === JSON.stringify(RANKED_DRAFT_LIVE_MAP_TYPES) &&
        JSON.stringify(candidate.maps.map(({ mapType }) => mapType)) === JSON.stringify(RANKED_DRAFT_LIVE_MAP_TYPES) &&
        JSON.stringify(incumbent.maps.map(({ mapType }) => mapType)) === JSON.stringify(RANKED_DRAFT_LIVE_MAP_TYPES);
    const liveMapGuard = RANKED_DRAFT_LIVE_MAP_TYPES.map((mapType) => {
        const summary = candidate.maps.find((entry) => entry.mapType === mapType);
        const checks = {
            pointEstimateAtLeast49_5: !!summary && summary.decisiveGames > 0 && summary.decisiveWinRate >= 0.495,
            clusteredLower95AtLeast48: !!summary && summary.confidence95.low >= 0.48,
            candidateRejectedActionsZero: !!summary && summary.rejectedCandidate === 0,
        };
        return {
            mapType,
            games: summary?.games ?? 0,
            decisiveGames: summary?.decisiveGames ?? 0,
            decisiveWinRate: summary?.decisiveWinRate ?? 0.5,
            confidence95: summary?.confidence95 ?? { low: 0, high: 1 },
            rejectedCandidate: summary?.rejectedCandidate ?? 0,
            avgLaps: summary?.avgLaps ?? 0,
            endReasons: summary?.endReasons ?? { elimination: 0, turn_cap: 0, stuck: 0 },
            checks,
        };
    });
    const minimumCohortGames = Math.max(200, Math.ceil(candidate.totalGames * 0.01));
    const minimumCohortDecisiveGames = Math.ceil(minimumCohortGames / 2);
    const cohortNames = ["ranged", "mage", "melee_magic", "aura_heavy"] as const;
    const cohorts = cohortNames.map((cohort) => {
        const candidateCohort = candidate.cohorts.find((entry) => entry.cohort === cohort);
        const incumbentCohort = incumbent.cohorts.find((entry) => entry.cohort === cohort);
        const covered =
            !!candidateCohort?.confidence95 &&
            !!incumbentCohort?.confidence95 &&
            candidateCohort.games >= minimumCohortGames &&
            incumbentCohort.games >= minimumCohortGames &&
            candidateCohort.decisiveGames >= minimumCohortDecisiveGames &&
            incumbentCohort.decisiveGames >= minimumCohortDecisiveGames;
        return {
            cohort,
            candidateGames: candidateCohort?.games ?? 0,
            candidateDecisiveGames: candidateCohort?.decisiveGames ?? 0,
            incumbentGames: incumbentCohort?.games ?? 0,
            incumbentDecisiveGames: incumbentCohort?.decisiveGames ?? 0,
            candidateDecisiveWinRate: candidateCohort?.decisiveWinRate ?? 0,
            incumbentDecisiveWinRate: incumbentCohort?.decisiveWinRate ?? 0,
            covered,
            pointEstimateNonRegression:
                covered && candidateCohort!.decisiveWinRate >= incumbentCohort!.decisiveWinRate - 0.02,
        };
    });
    const checks = {
        candidateVsIncumbentLower95AboveEven: candidateDirect.confidence95.low > 0.5,
        candidateRejectedActionsZero: candidate.aggregate.rejectedCandidate === 0,
        robustPoolNonRegression:
            candidate.aggregate.worstCaseLowerBound >= incumbent.aggregate.worstCaseLowerBound - 0.005,
        drawOrArmageddonNonRegression:
            candidate.aggregate.drawOrArmageddonRate <= incumbent.aggregate.drawOrArmageddonRate + 0.01,
        incumbentSelfPlayExactSymmetry:
            incumbentDirect.decisiveGames > 0 && incumbentDirect.wins === incumbentDirect.losses,
        incumbentRejectedActionsZero: incumbentDirect.rejectedCandidate === 0,
        exactLiveMapPanel,
        allLiveMapsPointEstimateAtLeast49_5: liveMapGuard.every((map) => map.checks.pointEstimateAtLeast49_5),
        allLiveMapsClusteredLower95AtLeast48: liveMapGuard.every((map) => map.checks.clusteredLower95AtLeast48),
        allLiveMapsCandidateRejectedActionsZero: liveMapGuard.every((map) => map.checks.candidateRejectedActionsZero),
        comparableGuardPanel,
    };
    return {
        schemaVersion: 1,
        status: "research_only_no_bake",
        eligibleForManualReview: Object.values(checks).every(Boolean),
        checks,
        candidateVsIncumbent: {
            decisiveWinRate: candidateDirect.decisiveWinRate,
            confidence95: candidateDirect.confidence95,
            decisiveGames: candidateDirect.decisiveGames,
        },
        incumbentSymmetryControl: {
            wins: incumbentDirect.wins,
            losses: incumbentDirect.losses,
            draws: incumbentDirect.draws,
            decisiveGames: incumbentDirect.decisiveGames,
            decisiveWinRate: incumbentDirect.decisiveGames ? incumbentDirect.decisiveWinRate : null,
            rejectedCandidate: incumbentDirect.rejectedCandidate,
        },
        thresholds: {
            candidateVsIncumbentLower95: 0.5,
            robustPoolTolerance: 0.005,
            drawOrArmageddonTolerance: 0.01,
            liveMapDecisiveWinRate: 0.495,
            liveMapClusteredLower95: 0.48,
            rejectedCandidate: 0,
        },
        liveMapGuard,
        cohortCoverage: {
            minimumGames: minimumCohortGames,
            minimumDecisiveGames: minimumCohortDecisiveGames,
            cohorts,
        },
        qualification:
            "Fresh natural-distribution guard only. Natural cohort comparisons are diagnostic and may be indeterminate; targeted cohort guard evidence is separately required for final manual-review eligibility.",
    };
}

export function evaluateRankedDraftTargetedGuard(
    inputs: readonly IRankedDraftTargetedCohortInput[],
): IRankedDraftTargetedGuardDecision {
    const expected = ["ranged", "mage", "melee_magic", "aura_heavy"] as const;
    if (
        inputs.length !== expected.length ||
        expected.some((cohort) => inputs.filter((input) => input.cohort === cohort).length !== 1)
    ) {
        throw new Error("Targeted guard requires exactly one input for each named cohort");
    }
    const usedPairSeeds = new Set<number>();
    const cohorts = expected.map((cohort): IRankedDraftTargetedCohortSummary => {
        const input = inputs.find((entry) => entry.cohort === cohort)!;
        if (!Number.isInteger(input.requiredOfferBoards) || input.requiredOfferBoards < 1) {
            throw new RangeError(`${cohort} requiredOfferBoards must be positive`);
        }
        const qualified = input.records.filter((record) => record.candidateCohorts.includes(cohort));
        const pairSeeds = new Set(qualified.map((record) => record.pairSeed));
        for (const pairSeed of new Set(input.records.map((record) => record.pairSeed))) {
            if (usedPairSeeds.has(pairSeed)) throw new Error(`Targeted cohort guard reused pair seed ${pairSeed}`);
            usedPairSeeds.add(pairSeed);
        }
        const wins = qualified.filter((record) => record.candidateResult === "win").length;
        const losses = qualified.filter((record) => record.candidateResult === "loss").length;
        const decisiveGames = wins + losses;
        const confidence95 = clusteredRankedDraftConfidence95(qualified);
        const opponentIds = [...new Set(input.records.map((record) => record.opponentId))].sort();
        const opponentBreakdown = opponentIds.map((opponentId) => {
            const own = qualified.filter((record) => record.opponentId === opponentId);
            const ownWins = own.filter((record) => record.candidateResult === "win").length;
            const ownLosses = own.filter((record) => record.candidateResult === "loss").length;
            return {
                opponentId,
                qualifiedOfferBoards: new Set(own.map((record) => record.pairSeed)).size,
                games: own.length,
                decisiveWinRate: ownWins + ownLosses ? ownWins / (ownWins + ownLosses) : 0.5,
            };
        });
        const decisiveWinRate = decisiveGames ? wins / decisiveGames : 0.5;
        const rejectedCandidate = input.records.reduce((sum, record) => sum + record.rejectedCandidate, 0);
        const checks = {
            enoughQualifiedOfferBoards: pairSeeds.size >= input.requiredOfferBoards,
            pointEstimateAtLeast49_5: decisiveWinRate >= 0.495,
            clusteredLower95AtLeast48: confidence95.low >= 0.48,
            candidateRejectedActionsZero: rejectedCandidate === 0,
        };
        return {
            cohort,
            requiredOfferBoards: input.requiredOfferBoards,
            qualifiedOfferBoards: pairSeeds.size,
            scannedOfferBoards: input.scannedOfferBoards,
            exhausted: input.exhausted,
            games: qualified.length,
            decisiveGames,
            wins,
            losses,
            draws: qualified.length - decisiveGames,
            decisiveWinRate,
            confidence95,
            rejectedCandidate,
            rejectedOpponent: input.records.reduce((sum, record) => sum + record.rejectedOpponent, 0),
            opponentBreakdown,
            checks,
            passed: Object.values(checks).every(Boolean),
        };
    });
    return {
        schemaVersion: 1,
        status: "research_only_no_bake",
        eligibleForManualReview: cohorts.every((cohort) => cohort.passed),
        thresholds: { decisiveWinRate: 0.495, clusteredLower95: 0.48, rejectedCandidate: 0 },
        cohortDefinitions: { ...RANKED_DRAFT_COHORT_DEFINITIONS },
        cohorts,
        qualification:
            "Frozen-candidate targeted roster guard. Offer-board selection uses candidate pick composition only; fight outcomes never enter seed selection. Passing permits manual review only.",
    };
}
