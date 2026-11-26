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

import { buildV08A19SearchEnvironment, V08_A19_PRODUCTION_VERSION } from "../ai/versions/v0_8_a19_profile";
import type { ILookaheadDeps } from "./lookahead";
import { attachA19SupportDecision } from "./a19_support";
import {
    SearchDriver,
    withSearchEnvironment,
    type ISearchMatchInfo,
    type SearchPassiveProductiveProbeObserver,
} from "./search_driver";
import { V08_A13_SEARCH_OVERRIDE_ENV, withScopedAIEnvironment } from "./v0_8_a13_search";

export const V08_A19_SEARCH_OVERRIDE_ENV = "V08_A19_SEARCH" as const;

const SEARCH_MODE_ENVIRONMENT_KEYS = ["V07_SEARCH", "Q2_WAIT_ABLATION", "Q2_ORACLE"] as const;

/**
 * Plain v0.8 matches use the promoted A19 profile. Explicit research modes keep their own SearchDriver
 * configuration; `V08_A19_SEARCH=0/1` disables or forces A19, and `V08_A13_SEARCH=1` selects the a13 rollback.
 */
export function shouldUseDefaultV08A19Search(match: ISearchMatchInfo): boolean {
    const hasProductionSeat =
        match.greenVersion === V08_A19_PRODUCTION_VERSION || match.redVersion === V08_A19_PRODUCTION_VERSION;
    if (!hasProductionSeat) return false;

    // A13 is the explicit rollback and therefore wins even when a stale/merged environment also forces A19.
    // battle_engine resolves the rollback before consulting this gate; keeping the precedence here too makes
    // direct callers and every other runtime select the same profile for the conflicting configuration.
    const a13Override = process.env[V08_A13_SEARCH_OVERRIDE_ENV];
    if (a13Override === "1") return false;

    const override = process.env[V08_A19_SEARCH_OVERRIDE_ENV];
    if (override === "0") return false;
    if (override === "1") return true;

    // Preserve the old operational switch: 0 disables automatic v0.8 search and 1 selects the a13 rollback.
    if (a13Override !== undefined) return false;
    return SEARCH_MODE_ENVIRONMENT_KEYS.every((key) => process.env[key] === undefined);
}

const A19_SEARCH_DRIVERS = new WeakSet<object>();

/** Whether `driver` is an A19 search driver of createV08A19SearchDriver (its support step times the decision). */
export const isV08A19SearchDriver = (driver: object | undefined): boolean =>
    driver !== undefined && A19_SEARCH_DRIVERS.has(driver);

/**
 * Construct the exact bounded A19 SearchDriver rebound to the stable production version v0.8. The A19 neural
 * primary-tie correction (adopted 2026-11-01) was removed on 2026-11-26 by owner decision: bot seats (deep fit) and
 * Premium never ran it, its one live use was the browser sandbox, and the sandbox and offline stock-driver play now
 * take the native choice. This is a removal, not a strength claim.
 */
export function createV08A19SearchDriver(
    deps: ILookaheadDeps,
    match: ISearchMatchInfo,
    passiveProductiveProbeObserver?: SearchPassiveProductiveProbeObserver,
    options: {
        /** Budget keys merged over the sealed environment (the deep-fit driver's deep search). */
        budgetOverrides?: Readonly<Record<string, string>>;
        /** The Satyr support step's deadline from the start of the decision. */
        supportDeadlineMs?: number;
    } = {},
): SearchDriver {
    const environment = options.budgetOverrides
        ? Object.freeze({ ...buildV08A19SearchEnvironment(), ...options.budgetOverrides })
        : buildV08A19SearchEnvironment();
    const support = environment.SEARCH_A19_SATYR_CONTACT_SUPPORT;
    if (support !== "0" && support !== "1") throw new Error("SEARCH_A19_SATYR_CONTACT_SUPPORT must be 0 or 1");
    // The overlay is what the browser can actually see. The process.env scope stays so Node, which has no
    // overlay, constructs the same driver it did before.
    return withSearchEnvironment(environment, () =>
        withScopedAIEnvironment(environment, () => {
            const driver = new SearchDriver(deps, match, undefined, passiveProductiveProbeObserver);
            const built =
                support === "1"
                    ? attachA19SupportDecision(
                          driver,
                          deps,
                          match.offlineDeterministicWork === true,
                          options.supportDeadlineMs,
                      )
                    : driver;
            A19_SEARCH_DRIVERS.add(built);
            return built;
        }),
    );
}
