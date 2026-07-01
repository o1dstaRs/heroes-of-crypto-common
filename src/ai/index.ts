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

import type { IAIStrategy } from "./ai_strategy";
import { STRATEGY_V0_1 } from "./versions/v0_1";
import { STRATEGY_V0_2 } from "./versions/v0_2";
import { STRATEGY_V0_3 } from "./versions/v0_3";
import { STRATEGY_V0_4 } from "./versions/v0_4";
import { STRATEGY_V0_5 } from "./versions/v0_5";

export type { IAIStrategy, IDecisionContext, IPlacementContext } from "./ai_strategy";

/**
 * Registry of every in-game AI version. Add the next generation here — the battle engine and
 * tournament runner discover versions through this map, so a new version is comparable against the
 * baseline the moment it is registered. The latest entry is the default.
 */
const STRATEGIES: readonly IAIStrategy[] = [STRATEGY_V0_1, STRATEGY_V0_2, STRATEGY_V0_3, STRATEGY_V0_4, STRATEGY_V0_5];

const STRATEGY_BY_VERSION: ReadonlyMap<string, IAIStrategy> = new Map(STRATEGIES.map((s) => [s.version, s]));

export const AI_VERSIONS: readonly string[] = STRATEGIES.map((s) => s.version);

export const LATEST_AI_VERSION: string = STRATEGIES[STRATEGIES.length - 1].version;

/**
 * The AI version the GAME uses by default — when the AI toggle is enabled, or when a player picks the
 * (non-LLM) AI opponent. Kept separate from LATEST_AI_VERSION so in-development versions (e.g. v0.4)
 * can be registered and tournament-tested without shipping them to live games.
 *
 * Promoted to v0.5 — now the shipped default for in-game AI (was v0.4).
 */
export const DEFAULT_AI_VERSION = "v0.5";

export function getAIStrategy(version: string): IAIStrategy {
    const strategy = STRATEGY_BY_VERSION.get(version);
    if (!strategy) {
        throw new Error(`Unknown AI version "${version}". Known versions: ${AI_VERSIONS.join(", ")}`);
    }
    return strategy;
}
