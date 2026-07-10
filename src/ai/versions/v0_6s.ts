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
import { StrategyV0_6 } from "./v0_6";

/**
 * v0.6s — v0.6 with a DISTINCT VERSION STRING, for the B2/RAWS rollout-search A/B (v0.7 roadmap).
 *
 * The SearchDriver (simulation/search_driver.ts, env V07_SEARCH=1) re-decides turns only for strategy
 * versions listed in SEARCH_VERSIONS (default "v0.6s"). Gating by version string is what lets a
 * `run_tournament v0.6s v0.6` mirror measure exactly "v0.6 + search vs plain v0.6": both seats run the
 * identical policy, but only the v0.6s seat is searched — a version-blind gate would search BOTH sides
 * of the mirror and measure nothing. With V07_SEARCH unset, v0.6s IS v0.6 byte-for-byte (this class
 * overrides nothing but the version string), so registering it changes no default behaviour anywhere
 * (DEFAULT_AI_VERSION and LATEST_AI_VERSION both stay "v0.6").
 */
export class StrategyV0_6S extends StrategyV0_6 {
    public override readonly version: string = "v0.6s";
}

export const STRATEGY_V0_6S: IAIStrategy = new StrategyV0_6S();
