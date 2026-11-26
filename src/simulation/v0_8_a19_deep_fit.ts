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

import type { IDecisionContext } from "../ai";
import type { GameAction } from "../engine/actions";
import type { Unit } from "../units/unit";
import type { ILookaheadDeps } from "./lookahead";
import type { ISearchMatchInfo, SearchDriver } from "./search_driver";
import { createV08A19SearchDriver } from "./v0_8_a19_search";

/**
 * a19-deep-fit-v1: play the deep A19 search (8 rollouts, shortlist 10, max melee 16) on the decisions where it fits
 * a think budget of rollout turns. The stock search runs first and stays the answer everywhere else. The deep search
 * starts only when the stock search's own rollout turns predict it can finish (deep work is about 4.07 times the
 * stock work) and is played only when both together stayed within the budget; under live timing it also stops at the
 * think deadline, counted from the start of the decision. Profile v29 (a19-deep-fit-4000-v1) raised the budget from
 * 2,800 to 4,000 turns: live, 2,800 turns took at most about 2.7 s on the 2-vCPU test host and 3.3 s on the production
 * host, so 4,000 turns spend the owner-approved 4 s, and the 4,000 ms deadline still stops a search a slower host cannot
 * finish (registered confirmation U, docs/deep_fit_4000_adoption.md). Profile v30 (a19-stock-deadline-v1) gives the
 * stock search a live deadline of 2,500 ms and a circuit breaker of 3,750 ms instead of the profile's 1,000 / 1,500 ms:
 * on the production host the 1,000 ms deadline cut the stock search on about one decision in eight, which then played
 * the native move after a doomed deep search (registered confirmation SD, docs/stock_deadline_adoption.md). Profile v31
 * (a19-wait-clock-v1) puts the WAIT comparisons of both searches under the same wall clock as every other comparison
 * (SEARCH_WAIT_DEADLINE_POLICY profile instead of operation_bounded): at production speed 8-12% of the bot's moves took
 * over 4.5 s, the longest 14-21 s (registered confirmation WC, docs/wait_clock_adoption.md). Offline deterministic work
 * has no clock, so it is unchanged.
 */
export const V08_A19_DEEP_FIT = Object.freeze({
    id: "a19-deep-fit-v1",
    deepBudget: Object.freeze({ SEARCH_ROLLOUTS: "8", SEARCH_SHORTLIST: "10", SEARCH_MAX_MELEE: "16" }),
    /** The stock search's live deadline and circuit breaker (profile v30, a19-stock-deadline-v1). */
    stockBudget: Object.freeze({ SEARCH_DECISION_DEADLINE_MS: "2500", SEARCH_CIRCUIT_BREAKER_MS: "3750" }),
    /** WAIT comparisons of both searches stop at their search's deadline (profile v31, a19-wait-clock-v1). */
    waitBudget: Object.freeze({ SEARCH_WAIT_DEADLINE_POLICY: "profile" }),
    rolloutTurnBudget: 4000,
    predictedDeepToStockRatio: 4.07,
    thinkMs: 4000,
});

export interface IV08A19DeepFitStatistics {
    decisions: number;
    attempted: number;
    played: number;
    overran: number;
}

type BudgetedSearchDriver = Pick<SearchDriver, "chooseDecisionWithinBudget" | "onFightReady" | "onMatchEnd">;

export class V08A19DeepFitSearchDriver {
    public readonly statistics: IV08A19DeepFitStatistics = { decisions: 0, attempted: 0, played: 0, overran: 0 };
    private readonly stock: BudgetedSearchDriver;
    private readonly deep: BudgetedSearchDriver;
    private readonly offline: boolean;
    private readonly now: () => number;
    public constructor(
        stock: BudgetedSearchDriver,
        deep: BudgetedSearchDriver,
        offline: boolean,
        now: () => number = () => performance.now(),
    ) {
        this.stock = stock;
        this.deep = deep;
        this.offline = offline;
        this.now = now;
    }
    public chooseDecision(
        unit: Unit,
        version: string,
        incumbent: GameAction[],
        rootDecisionContext?: IDecisionContext,
    ): GameAction[] {
        const startedAt = this.now();
        const stock = this.stock.chooseDecisionWithinBudget(unit, version, incumbent, rootDecisionContext, {});
        this.statistics.decisions += 1;
        const budget = V08_A19_DEEP_FIT.rolloutTurnBudget;
        if (stock.rolloutTurns * (1 + V08_A19_DEEP_FIT.predictedDeepToStockRatio) > budget) return stock.actions;
        const remainingMs = V08_A19_DEEP_FIT.thinkMs - (this.now() - startedAt);
        if (!this.offline && remainingMs <= 0) return stock.actions;
        this.statistics.attempted += 1;
        const deep = this.deep.chooseDecisionWithinBudget(unit, version, incumbent, rootDecisionContext, {
            rolloutTurns: budget - stock.rolloutTurns,
            ...(this.offline ? {} : { deadlineMs: remainingMs }),
        });
        if (!deep.withinBudget) {
            this.statistics.overran += 1;
            return stock.actions;
        }
        this.statistics.played += 1;
        return deep.actions;
    }
    public onFightReady(): void {
        this.stock.onFightReady();
        this.deep.onFightReady();
    }
    public onMatchEnd(winner?: string, endReason?: string): void {
        this.stock.onMatchEnd(winner, endReason);
        this.deep.onMatchEnd(winner, endReason);
    }
}

/** The bot seat's A19 search with the deep search where it fits; the stock driver is the production one with the bot seat's live limits. */
export function createV08A19DeepFitSearchDriver(
    deps: ILookaheadDeps,
    match: ISearchMatchInfo,
): V08A19DeepFitSearchDriver {
    const stock = createV08A19SearchDriver(deps, match, undefined, {
        budgetOverrides: { ...V08_A19_DEEP_FIT.stockBudget, ...V08_A19_DEEP_FIT.waitBudget },
    });
    const deep = createV08A19SearchDriver(deps, match, undefined, {
        budgetOverrides: {
            ...V08_A19_DEEP_FIT.deepBudget,
            SEARCH_DECISION_DEADLINE_MS: String(V08_A19_DEEP_FIT.thinkMs),
            SEARCH_CIRCUIT_BREAKER_MS: String(V08_A19_DEEP_FIT.thinkMs * 30),
            ...V08_A19_DEEP_FIT.waitBudget,
        },
        supportDeadlineMs: V08_A19_DEEP_FIT.thinkMs,
    });
    return new V08A19DeepFitSearchDriver(stock, deep, match.offlineDeterministicWork === true);
}
