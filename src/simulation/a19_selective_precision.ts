/** Research-only selective R8 scoring; importing this module never changes a driver. */
import type { IEnumeratedCandidate } from "../ai/candidates";
import type { Unit } from "../units/unit";
import { SearchDriver } from "./search_driver";

export function hasR2MidpointTie(means: readonly number[]): boolean {
    if (means.some((mean) => Number.isNaN(mean) || mean === Infinity)) throw new Error("Invalid R2 scores");
    return Math.max(...means) === 0.5 && means.filter((mean) => mean === 0.5).length >= 2;
}

type RootArguments = [
    Unit,
    readonly IEnumeratedCandidate[],
    number,
    string,
    number,
    number | null,
    number,
    unknown,
    string,
];
interface IPrecisionDriver {
    horizon: number;
    rollouts: number;
    shortlist: number | null;
    complementaryR2: boolean;
    match: { offlineDeterministicWork?: boolean };
    scoredDecisionObserver: unknown;
    auditPath: unknown;
    ilPath: unknown;
    scoreSearchCandidates(...args: RootArguments): number[];
    scoreCandidates(
        ...args: [Unit, readonly IEnumeratedCandidate[], number, string, number, number | null, number, unknown]
    ): number[];
}

export function withA19SelectivePrecision<T>(
    options: { team: number; mode: "observe" | "tie-r8" | "always-r8" },
    run: () => T,
): { value: T; statistics: { roots: number; midpointTies: number; refined: number; extraSamples: number } } {
    const prototype = SearchDriver.prototype as unknown as IPrecisionDriver;
    const original = prototype.scoreSearchCandidates;
    const score = prototype.scoreCandidates;
    const statistics = { roots: 0, midpointTies: 0, refined: 0, extraSamples: 0 };
    prototype.scoreSearchCandidates = function (...args) {
        const means = original.apply(this, args);
        if (args[0].getTeam() !== options.team) return means;
        if (
            this.horizon !== 64 ||
            this.rollouts !== 2 ||
            this.shortlist !== 6 ||
            !this.complementaryR2 ||
            this.match.offlineDeterministicWork !== true ||
            args[3] !== "turns" ||
            args[4] !== 2 ||
            args[5] !== null ||
            args[6] !== 64 ||
            args[8] !== "v0.8" ||
            this.scoredDecisionObserver ||
            this.auditPath ||
            this.ilPath
        )
            throw new Error("Selective precision requires the frozen offline R2 profile without score observers");
        statistics.roots++;
        const tied = hasR2MidpointTie(means);
        if (tied) statistics.midpointTies++;
        if (options.mode === "observe" || (options.mode === "tie-r8" && !tied)) return means;
        statistics.refined++;
        statistics.extraSamples += 8 * args[1].length;
        // The driver's count>2 reference path uses independent streams and discards the complementary prefix.
        // Its ordinary transaction restores battle, damage and auxiliary state; the enclosing root restores RNG.
        return score.call(this, args[0], args[1], args[2], "turns", 8, null, 64, false);
    };
    try {
        return { value: run(), statistics };
    } finally {
        prototype.scoreSearchCandidates = original;
    }
}
