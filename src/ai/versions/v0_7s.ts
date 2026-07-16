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

import type { IAIStrategy } from "../ai_strategy";
import { StrategyV0_7 } from "./v0_7";

/**
 * Measurement-only v0.7 alias with a distinct version identity. SearchDriver scopes rollout search by
 * strategy.version, so `SEARCH_VERSIONS=v0.7s` can search one seat of a v0.7 mirror without changing the
 * other seat. With search disabled this class is exactly v0.7; it overrides no policy behavior.
 *
 * The alias measures the simulator's configured search profile. Ranked "brutal" also has a server-owned
 * wall-clock circuit breaker, so an uncapped alias tournament is not by itself exact live-runtime evidence.
 */
export class StrategyV0_7S extends StrategyV0_7 {
    public override readonly version: string = "v0.7s";
}

export const STRATEGY_V0_7S: IAIStrategy = new StrategyV0_7S();
