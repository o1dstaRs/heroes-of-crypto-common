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
import { SearchDriver, type ISearchMatchInfo, type SearchPassiveProductiveProbeObserver } from "./search_driver";
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

/** Construct the exact bounded A19 SearchDriver rebound to the stable production version v0.8. */
export function createV08A19SearchDriver(
    deps: ILookaheadDeps,
    match: ISearchMatchInfo,
    passiveProductiveProbeObserver?: SearchPassiveProductiveProbeObserver,
): SearchDriver {
    return withScopedAIEnvironment(
        buildV08A19SearchEnvironment(),
        () => new SearchDriver(deps, match, undefined, passiveProductiveProbeObserver),
    );
}
