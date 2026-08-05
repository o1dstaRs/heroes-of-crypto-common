/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */

import type { IRankedDraftEvaluationReport } from "./ranked_draft_eval";

export interface IRankedDraftDirectGates {
    minimumDrawAwareScore: number;
    minimumClusteredLowerBound: number;
    maximumCandidateRejections: number;
}

export const DEFAULT_RANKED_DRAFT_DIRECT_GATES: IRankedDraftDirectGates = {
    minimumDrawAwareScore: 0.5,
    minimumClusteredLowerBound: 0.5,
    maximumCandidateRejections: 0,
};

export interface IRankedDraftDirectGateResult {
    name: "draw_aware_head_to_head" | "clustered_lower_bound" | "candidate_rejections";
    actual: number;
    threshold: number;
    passed: boolean;
}

export interface IRankedDraftDirectHeadToHead {
    games: number;
    wins: number;
    losses: number;
    draws: number;
    drawAwareScore: number;
    decisiveWinRate: number;
    clusteredLowerBound: number;
}

export interface IRankedDraftDirectGateEvaluation {
    verdict: "PASS" | "FAIL";
    gates: IRankedDraftDirectGateResult[];
    headToHead: IRankedDraftDirectHeadToHead;
}

const assertGates = (gates: IRankedDraftDirectGates): void => {
    if (
        !Number.isFinite(gates.minimumDrawAwareScore) ||
        gates.minimumDrawAwareScore < 0 ||
        gates.minimumDrawAwareScore > 1 ||
        !Number.isFinite(gates.minimumClusteredLowerBound) ||
        gates.minimumClusteredLowerBound < 0 ||
        gates.minimumClusteredLowerBound > 1 ||
        !Number.isInteger(gates.maximumCandidateRejections) ||
        gates.maximumCandidateRejections < 0
    ) {
        throw new RangeError("Ranked draft gates must be valid probabilities and a non-negative rejection count");
    }
};

/**
 * Apply the predeclared direct-incumbent gate. A multi-opponent pool cannot promote a ranked candidate:
 * every accepted result must have exactly one live-path incumbent and balanced four-game offer-board mirrors.
 */
export function evaluateRankedDraftDirectGates(
    report: IRankedDraftEvaluationReport,
    candidateId: string,
    incumbentId: string,
    gates: IRankedDraftDirectGates = DEFAULT_RANKED_DRAFT_DIRECT_GATES,
): IRankedDraftDirectGateEvaluation {
    assertGates(gates);
    if (report.candidateId !== candidateId) {
        throw new Error(`Ranked draft report candidate ${report.candidateId} is not ${candidateId}`);
    }
    const headToHead = report.opponents.find((opponent) => opponent.opponentId === incumbentId);
    if (!headToHead) throw new Error(`Ranked draft report omitted incumbent ${incumbentId}`);
    if (report.opponents.length !== 1 || report.totalGames !== headToHead.games) {
        throw new Error("Ranked draft acceptance must be a direct one-incumbent panel");
    }
    const drawAwareScore = (headToHead.wins + 0.5 * headToHead.draws) / headToHead.games;
    const results: IRankedDraftDirectGateResult[] = [
        {
            name: "draw_aware_head_to_head",
            actual: drawAwareScore,
            threshold: gates.minimumDrawAwareScore,
            passed: drawAwareScore > gates.minimumDrawAwareScore,
        },
        {
            name: "clustered_lower_bound",
            actual: headToHead.clusteredLowerBound,
            threshold: gates.minimumClusteredLowerBound,
            passed: headToHead.clusteredLowerBound > gates.minimumClusteredLowerBound,
        },
        {
            name: "candidate_rejections",
            actual: report.aggregate.rejectedCandidate,
            threshold: gates.maximumCandidateRejections,
            passed: report.aggregate.rejectedCandidate <= gates.maximumCandidateRejections,
        },
    ];
    return {
        verdict: results.every((result) => result.passed) ? "PASS" : "FAIL",
        gates: results,
        headToHead: {
            games: headToHead.games,
            wins: headToHead.wins,
            losses: headToHead.losses,
            draws: headToHead.draws,
            drawAwareScore,
            decisiveWinRate: headToHead.decisiveWinRate,
            clusteredLowerBound: headToHead.clusteredLowerBound,
        },
    };
}
