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

import { buildV08A13SearchEnvironment, V08_A13_PRODUCTION_VERSION } from "../ai/versions/v0_8_a13_profile";
import type { ILookaheadDeps } from "./lookahead";
import { SearchDriver, type ISearchMatchInfo } from "./search_driver";

export const V08_A13_SEARCH_OVERRIDE_ENV = "V08_A13_SEARCH" as const;

const SEARCH_MODE_ENVIRONMENT_KEYS = ["V07_SEARCH", "Q2_WAIT_ABLATION", "Q2_ORACLE"] as const;

/**
 * Run a synchronous constructor under an exact environment and restore every
 * process variable before returning. SearchDriver snapshots all behavior-bearing
 * search settings in its constructor; StrategyV0_8 independently bakes the a13
 * controls that are consulted later during decideTurn/placement.
 */
export function withScopedAIEnvironment<T>(environment: Readonly<Record<string, string | undefined>>, run: () => T): T {
    const saved = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(environment)) {
        saved.set(key, process.env[key]);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try {
        return run();
    } finally {
        for (const [key, value] of saved) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

/**
 * Plain `v0.8` means the promoted composite policy in ordinary simulations.
 * Any explicit research mode preserves the caller's requested SearchDriver
 * configuration. `V08_A13_SEARCH=0/1` is the explicit rollback/force switch.
 */
export function shouldUseDefaultV08A13Search(match: ISearchMatchInfo): boolean {
    const hasProductionSeat =
        match.greenVersion === V08_A13_PRODUCTION_VERSION || match.redVersion === V08_A13_PRODUCTION_VERSION;
    if (!hasProductionSeat) return false;
    const override = process.env[V08_A13_SEARCH_OVERRIDE_ENV];
    if (override === "0") return false;
    if (override === "1") return true;
    return SEARCH_MODE_ENVIRONMENT_KEYS.every((key) => process.env[key] === undefined);
}

/** Construct the exact bounded a13 SearchDriver rebound to production v0.8. */
export function createV08A13SearchDriver(deps: ILookaheadDeps, match: ISearchMatchInfo): SearchDriver {
    return withScopedAIEnvironment(buildV08A13SearchEnvironment(), () => new SearchDriver(deps, match));
}
