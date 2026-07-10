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
import { STRATEGY_V0_6S } from "./versions/v0_6s";
import { STRATEGY_V0_7 } from "./versions/v0_7";

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
    // v0.6s = v0.6 under a distinct version string, so the env-gated rollout SearchDriver can be applied to
    // exactly one seat of a mirror (see versions/v0_6s.ts). Registered before v0.6 on purpose: it is an
    // experiment alias, never a LATEST/DEFAULT candidate.
    STRATEGY_V0_6S,
    STRATEGY_V0_6,
    // v0.7 = v0.6 + the distilled wait-scorer baked in (S1 sign-off; see versions/v0_7.ts). Registered LAST:
    // LATEST_AI_VERSION resolves to v0.7.
    STRATEGY_V0_7,
];

const STRATEGY_BY_VERSION: ReadonlyMap<string, IAIStrategy> = new Map(STRATEGIES.map((s) => [s.version, s]));

export const AI_VERSIONS: readonly string[] = STRATEGIES.map((s) => s.version);

export const LATEST_AI_VERSION: string = STRATEGIES[STRATEGIES.length - 1].version;

/**
 * The AI version the GAME uses by default — when the AI toggle is enabled, or when a player picks the
 * (non-LLM) AI opponent. Kept separate from LATEST_AI_VERSION so in-development versions (e.g. v0.4)
 * can be registered and tournament-tested without shipping them to live games.
 *
 * Promoted to v0.7 — the shipped default for in-game AI (was v0.6): v0.6 + the distilled wait-scorer baked
 * in (S1 sign-off). Bake battery 2026-07-10 (fresh seeds 1000700..1080708 + 1090709/1091700/1092701, LIVETWIN):
 * v0.7 vs v0.6 pooled 68.83% ± 0.24 (+18.83pp >= the +4pp §0 bar; 9/9 seeds positive), v0.7 vs v0.4 80.59%
 * (plain v0.6's anchor was 73.17%), cohorts vs v0.6 all non-negative (melee 70.09 / mixed 62.67 / random
 * 57.53), default-amount config 55.10% (seed 1093702), integrity <= 0.36% draws+armageddon, 0 rejections.
 * v0.6 is now PARKED as the frozen baseline that future v0.7 improvements are measured against (the same
 * role v0.5 played for v0.6).
 */
export const DEFAULT_AI_VERSION = "v0.7";

export function getAIStrategy(version: string): IAIStrategy {
    const strategy = STRATEGY_BY_VERSION.get(version);
    if (!strategy) {
        throw new Error(`Unknown AI version "${version}". Known versions: ${AI_VERSIONS.join(", ")}`);
    }
    return strategy;
}
