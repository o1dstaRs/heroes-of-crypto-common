/** Inactive follow-up: retain ordinary alternatives and optionally require evidence for a new move. */
import { V08_A19_SCORED_ARBITRATION_POLICY } from "../ai/versions/v0_8_a19_scored_arbitration";

export const BACKLINE_APPROACH_PRESERVATION_RESEARCH_ID = "backline-approach-preservation-v1";

/** The ordinary shortlist has already passed every native cap, role filter and special reservation. */
export function appendBacklineApproachAlternative<T>(ordinary: readonly T[], proposal: T | undefined): readonly T[] {
    return proposal === undefined || ordinary.includes(proposal) ? ordinary : [...ordinary, proposal];
}

export interface IApproachScoreEvidence {
    readonly eligible: boolean;
    readonly bestOrdinary: number;
    readonly proposed: number;
    readonly gain: number;
    readonly requiredGain: number;
}

/**
 * Use the existing A19 one-point value margin, not a fitted cutoff. A tie, invalid score or missing
 * ordinary comparator cannot justify a new advance. Callers mask a rejected proposal in BOTH the
 * primary score and material-arbitration evidence; otherwise the later tie breaker can revive it.
 * This consumes already computed paired-rollout values, never actual future outcomes.
 */
export function backlineApproachScoreEvidence(means: readonly number[], proposedIndex: number): IApproachScoreEvidence {
    const requiredGain = V08_A19_SCORED_ARBITRATION_POLICY.valueGain;
    const proposed = means[proposedIndex] ?? Number.NEGATIVE_INFINITY;
    let bestOrdinary = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < means.length; i++) {
        if (i !== proposedIndex && Number.isFinite(means[i])) bestOrdinary = Math.max(bestOrdinary, means[i]);
    }
    const gain = proposed - bestOrdinary;
    return {
        eligible:
            proposedIndex >= 0 &&
            proposedIndex < means.length &&
            Number.isFinite(proposed) &&
            Number.isFinite(bestOrdinary) &&
            gain >= requiredGain,
        bestOrdinary,
        proposed,
        gain,
        requiredGain,
    };
}
