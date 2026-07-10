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
import { STRATEGY_V0_6 } from "./versions/v0_6";

export type { IAIStrategy, IDecisionContext, IPlacementContext } from "./ai_strategy";

// F4 — the shared enumerated candidate generator (./candidates.ts): every engine-legal candidate turn
// for the acting unit (moves, melee target x stand-cell, shot aims, area throws, all castable spells,
// defend, wait) with candidate 0 always the incumbent decision, per-candidate morale/luck-economy +
// initiative-order featurization stubs, and opt-in per-class caps reported via `truncated`. Consumed by
// the Q1 tactical modules, B2/RAWS rollout search, and any future learned policy.
export { enumerateCandidates, getEnemiesCellsWithinMovementRange } from "./candidates";
export type {
    CandidateKind,
    ICandidateFeatures,
    ICandidateSet,
    IEnumeratedCandidate,
    IEnumerateOptions,
} from "./candidates";

/**
 * Registry of every in-game AI version. Add the next generation here — the battle engine and
 * tournament runner discover versions through this map, so a new version is comparable against the
 * baseline the moment it is registered. The latest entry is the default.
 */
const STRATEGIES: readonly IAIStrategy[] = [
    STRATEGY_V0_1,
    STRATEGY_V0_2,
    STRATEGY_V0_3,
    STRATEGY_V0_4,
    STRATEGY_V0_5,
    STRATEGY_V0_6,
];

const STRATEGY_BY_VERSION: ReadonlyMap<string, IAIStrategy> = new Map(STRATEGIES.map((s) => [s.version, s]));

export const AI_VERSIONS: readonly string[] = STRATEGIES.map((s) => s.version);

export const LATEST_AI_VERSION: string = STRATEGIES[STRATEGIES.length - 1].version;

/**
 * The AI version the GAME uses by default — when the AI toggle is enabled, or when a player picks the
 * (non-LLM) AI opponent. Kept separate from LATEST_AI_VERSION so in-development versions (e.g. v0.4)
 * can be registered and tournament-tested without shipping them to live games.
 *
 * Promoted to v0.6 — the shipped default for in-game AI (was v0.5). v0.6 starts byte-for-byte identical to
 * v0.5 (extends it with no overrides); v0.5 is now PARKED as the frozen baseline that future v0.6 improvements
 * are measured against (the same role v0.4 played for v0.5).
 */
export const DEFAULT_AI_VERSION = "v0.6";

export function getAIStrategy(version: string): IAIStrategy {
    const strategy = STRATEGY_BY_VERSION.get(version);
    if (!strategy) {
        throw new Error(`Unknown AI version "${version}". Known versions: ${AI_VERSIONS.join(", ")}`);
    }
    return strategy;
}
