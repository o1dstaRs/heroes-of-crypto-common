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
import { SearchDriver, type ISearchMatchInfo, type SearchPassiveProductiveProbeObserver } from "./search_driver";

export const V08_A13_SEARCH_OVERRIDE_ENV = "V08_A13_SEARCH" as const;

/**
 * Run a synchronous constructor under an exact environment and restore every
 * process variable before returning. SearchDriver snapshots its settings in its
 * constructor, while inherited strategy experiment switches remain dynamic; a
 * caller sealing an entire match must therefore keep this scope around the match,
 * as the standalone qualification panels do. Module-import-time legacy switches
 * still require the panel worker/process to start from a clean environment.
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
 * a13 remains the explicit v0.8 rollback profile after A19 promotion. The legacy switch is retained for
 * operators and historical studies: only `V08_A13_SEARCH=1` selects it.
 */
export function shouldUseDefaultV08A13Search(match: ISearchMatchInfo): boolean {
    const hasProductionSeat =
        match.greenVersion === V08_A13_PRODUCTION_VERSION || match.redVersion === V08_A13_PRODUCTION_VERSION;
    if (!hasProductionSeat) return false;
    return process.env[V08_A13_SEARCH_OVERRIDE_ENV] === "1";
}

/** Construct the exact bounded a13 SearchDriver rebound to v0.8 for rollback and historical comparisons. */
export function createV08A13SearchDriver(
    deps: ILookaheadDeps,
    match: ISearchMatchInfo,
    passiveProductiveProbeObserver?: SearchPassiveProductiveProbeObserver,
): SearchDriver {
    return withScopedAIEnvironment(
        buildV08A13SearchEnvironment(),
        () => new SearchDriver(deps, match, undefined, passiveProductiveProbeObserver),
    );
}
