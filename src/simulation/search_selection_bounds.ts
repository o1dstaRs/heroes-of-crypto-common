/*
 * This file is part of the common code of the Heroes of Crypto.
 * Licensed under the MIT license in the root directory of this source tree.
 */

/**
 * Candidates in one pool have identical membership in every value-maximizing selection tier. Keep the
 * exact maximum of EACH pool, rather than assuming that the global maximum is the policy's choice.
 * Deterministic preferences and the incumbent need exact scores even when another action scores higher.
 */
export interface ISearchSelectionBoundPlan {
    readonly pools: readonly number[];
    readonly directCombat: readonly boolean[];
    readonly protectedIndices: ReadonlySet<number>;
    /** Until these preferences are proven legal, an unscored combat action might become their fallback. */
    readonly preferredIndices: ReadonlySet<number>;
}

/** Decision-local proof state. It never changes candidate order, seeds, or a completed candidate's mean. */
export class SearchSelectionBounds {
    private readonly bestByPool: number[];
    private readonly completedPreferred = new Set<number>();
    public constructor(private readonly plan: ISearchSelectionBoundPlan) {
        if (plan.pools.length !== plan.directCombat.length) {
            throw new Error("Search selection bound plan has inconsistent candidate lengths");
        }
        if (plan.pools.some((pool) => !Number.isSafeInteger(pool) || pool < 0 || pool > 7)) {
            throw new Error("Search selection bound pools must be integers from 0 to 7");
        }
        for (const index of [...plan.protectedIndices, ...plan.preferredIndices]) {
            if (!Number.isSafeInteger(index) || index < 0 || index >= plan.pools.length) {
                throw new Error("Search selection bound plan has an invalid protected candidate");
            }
        }
        this.bestByPool = new Array<number>(8).fill(Number.NEGATIVE_INFINITY);
    }
    /** A missing/unsafe reference forces the caller to complete this candidate. */
    public referenceMean(index: number): number {
        if (
            index === 0 ||
            this.plan.protectedIndices.has(index) ||
            this.plan.preferredIndices.has(index) ||
            (this.plan.directCombat[index] && this.completedPreferred.size !== this.plan.preferredIndices.size)
        ) {
            return Number.NEGATIVE_INFINITY;
        }
        return this.bestByPool[this.plan.pools[index]] ?? Number.NEGATIVE_INFINITY;
    }
    /** Only a complete, legal, bounded mean can certify another candidate's redundant tail. */
    public recordFinished(index: number, mean: number): void {
        if (!Number.isFinite(mean) || mean < 0 || mean > 1) return;
        const pool = this.plan.pools[index];
        this.bestByPool[pool] = Math.max(this.bestByPool[pool], mean);
        if (this.plan.preferredIndices.has(index)) this.completedPreferred.add(index);
    }
}
