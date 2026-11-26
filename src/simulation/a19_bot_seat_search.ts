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

import { buildV08A19SearchEnvironment } from "../ai/versions/v0_8_a19_profile";
import type { IMatchConfig } from "./battle_engine";
import { createV08A19DeepFitSearchDriver, V08_A19_DEEP_FIT } from "./v0_8_a19_deep_fit";
import { withScopedAIEnvironment } from "./v0_8_a13_search";

/**
 * The production bot seat's search, for research runners (owner, 2026-11-26: newly sealed research plans default to
 * the production bot-seat driver; sealed and frozen studies keep their recorded driver). It is the server's
 * createBotSeatSearchDriver with deepFit (heroes-of-crypto-server src/api/game/v1/bot_search.ts): the deep-fit driver
 * (V08_A19_DEEP_FIT: stock search at 2,500 / 3,750 ms, deep search where it fits 4,000 rollout turns) inside the
 * server's bot-search environment, scoped around its construction and every decision as the server scopes it. The
 * neural correction is attached as the server attaches it and never engages on that budget (a19_neural.ts), so the
 * seat plays neural off, as live bot seats do since profile v30. Offline deterministic work (operation-bounded): the
 * deep-fit driver's think deadline does not apply, every search runs to its rollout-turn budget.
 */
export const A19_BOT_SEAT_SEARCH_DRIVER_ID = "a19-bot-seat-deep-fit-v1" as const;
export type A19BotSeatSearchDriverId = typeof A19_BOT_SEAT_SEARCH_DRIVER_ID;

/** The server's bot-search environment for the A19 profile (bot_search.ts BOT_SEARCH_ENVIRONMENTS.a19). */
export const A19_BOT_SEAT_SEARCH_ENVIRONMENT: Readonly<Record<string, string | undefined>> = withScopedAIEnvironment(
    { V08_A19_SEARCH_ENV_OVERRIDES: undefined },
    () =>
        Object.freeze({
            ...buildV08A19SearchEnvironment(),
            SEARCH_A19_MATERIAL_ARBITRATION: "ties",
            SEARCH_A19_CERTIFIED_SELECTION_BOUNDS: "1",
            SEARCH_A19_CERTIFIED_TIGHT_BOUNDS: "1",
            SEARCH_A19_ROLLOUT_ALLOCATION: "uniform",
            SEARCH_V08_RANKED_REPLAY_TIEBREAK_EPSILON: "0",
            V08_FLYER_BACKLINE_PRIORITY_LEFT: "0",
            V08_FLYER_BACKLINE_PRIORITY_RIGHT: "0",
            V08_A19_SEARCH_ENV_OVERRIDES: undefined,
        }),
);

/** What a report records for this driver. */
export const A19_BOT_SEAT_SEARCH_DRIVER = Object.freeze({
    id: A19_BOT_SEAT_SEARCH_DRIVER_ID,
    source: "heroes-of-crypto-server src/api/game/v1/bot_search.ts createBotSeatSearchDriver(deepFit)",
    driver: V08_A19_DEEP_FIT.id,
    stockBudget: V08_A19_DEEP_FIT.stockBudget,
    deepBudget: V08_A19_DEEP_FIT.deepBudget,
    waitBudget: V08_A19_DEEP_FIT.waitBudget,
    rolloutTurnBudget: V08_A19_DEEP_FIT.rolloutTurnBudget,
    neural: "off: attached as on the server, never engages on the 2,500 / 3,750 ms stock budget",
    work: "offline-deterministic-work",
    environment: "server bot-search environment (A19 profile + material ties, certified tight bounds, uniform)",
});

/**
 * runMatch's searchDriverFactory for the bot seat's search. The match must run with searchOfflineDeterministicWork
 * (the factory refuses a live-timed match: research runners measure the bot seat's operation-bounded semantics).
 */
export function createA19BotSeatSearchDriverFactory(): NonNullable<IMatchConfig["searchDriverFactory"]> {
    return (deps, match) => {
        if (match.offlineDeterministicWork !== true)
            throw new Error(`${A19_BOT_SEAT_SEARCH_DRIVER_ID} research runs need offline deterministic work`);
        const driver = withScopedAIEnvironment(A19_BOT_SEAT_SEARCH_ENVIRONMENT, () =>
            createV08A19DeepFitSearchDriver(deps, match),
        );
        return {
            chooseDecision: (unit, version, incumbent, context) =>
                withScopedAIEnvironment(A19_BOT_SEAT_SEARCH_ENVIRONMENT, () =>
                    driver.chooseDecision(unit, version, incumbent, context),
                ),
            onFightReady: () => driver.onFightReady(),
            onMatchEnd: (winner, endReason) => driver.onMatchEnd(winner, endReason),
        };
    };
}
