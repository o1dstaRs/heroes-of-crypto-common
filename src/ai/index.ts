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
import { STRATEGY_V0_7S } from "./versions/v0_7s";
import { STRATEGY_V0_8 } from "./versions/v0_8";
import { STRATEGY_V0_8S } from "./versions/v0_8s";

export type {
    AIPolicyEventKind,
    IAIPolicyEvent,
    IAIStrategy,
    IDecisionContext,
    IPlacementContext,
    IV08ProtectedAdvanceGuardrailDetails,
    IV08SupportedBandAdvanceDetails,
    IV08SupportedPrepinEgressDetails,
    V08ProtectedAdvanceGuardrailReason,
} from "./ai_strategy";

// Browser-safe identity and immutable configuration for the promoted v0.8+a13
// composite. The Node-only SearchDriver factory is exported separately from
// `src/simulation` so importing the shared game API never pulls in node:fs/path.
export {
    buildV08A13SearchEnvironment,
    V08_A13_CANDIDATE_ID,
    V08_A13_GENOME,
    V08_A13_GENOME_SHA256,
    V08_A13_OPPONENT_VERSION,
    V08_A13_POLICY,
    V08_A13_PRODUCTION_VERSION,
    V08_A13_PROFILE,
    V08_A13_PROFILE_SCHEMA,
    V08_A13_SEARCH,
    V08_A13_SOURCE_BEHAVIOR_ENVIRONMENT_SHA256,
    V08_A13_SOURCE_BINDING_SHA256,
    V08_A13_SOURCE_COMMIT,
    V08_A13_SOURCE_TREE,
    V08_A13_SOURCE_VERSION,
    V08_A13_VALUE_LEAF,
} from "./versions/v0_8_a13_profile";

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
    IShotCandidateFeatures,
} from "./candidates";

/**
 * Registry of every in-game AI version. Add the next generation here — the battle engine and
 * tournament runner discover versions through this map, so a new version is comparable against the
 * baseline the moment it is registered. The latest entry identifies the newest candidate; the shipped
 * default is selected independently below.
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
    // v0.7s is the equivalent measurement alias for seat-scoped rollout-search A/Bs. Keep it before v0.7
    // so registering the alias cannot change LATEST_AI_VERSION; DEFAULT_AI_VERSION is explicit below.
    STRATEGY_V0_7S,
    // v0.7 = v0.6 + the distilled wait-scorer baked in (S1 sign-off; see versions/v0_7.ts).
    // It remains registered as the frozen incumbent now that v0.8 is the shipped default below.
    STRATEGY_V0_7,
    // v0.8s is the compatibility alias used to replay the frozen a13 training/validation seat. Its native
    // strategy is now identical to v0.8; the distinct version string remains useful for historical artifacts
    // and seat-scoped research. Keep it before v0.8 so it can never become LATEST/DEFAULT by registration.
    STRATEGY_V0_8S,
    // v0.8 is the promoted a13 composite's native strategy. Search-capable simulation/server runtimes pair it
    // with the exact bounded a13 SearchDriver exported from `src/simulation`; browser-only callers retain every
    // baked native policy advancement without importing Node-only simulation dependencies.
    STRATEGY_V0_8,
];

const STRATEGY_BY_VERSION: ReadonlyMap<string, IAIStrategy> = new Map(STRATEGIES.map((s) => [s.version, s]));

export const AI_VERSIONS: readonly string[] = STRATEGIES.map((s) => s.version);

export const LATEST_AI_VERSION: string = STRATEGIES[STRATEGIES.length - 1].version;

/**
 * The AI version the GAME uses by default — when the AI toggle is enabled, or when a player picks the
 * (non-LLM) AI opponent. Kept separate from LATEST_AI_VERSION so in-development versions (e.g. v0.4)
 * can be registered and tournament-tested without shipping them to live games.
 *
 * Promoted to v0.8+a13 — the shipped default for in-game AI (was v0.7). The registered strategy contains the
 * a13 native policy: productive legal-action recovery, target pressure, dominant/urgent finishing, learned
 * melee targeting and reveal placement, while preserving intentional waits when its ranged army is stronger.
 * Search-capable runtimes complete the composite with the exact bounded a13 SearchDriver from `src/simulation`.
 */
export const DEFAULT_AI_VERSION = "v0.8";

export function getAIStrategy(version: string): IAIStrategy {
    const strategy = STRATEGY_BY_VERSION.get(version);
    if (!strategy) {
        throw new Error(`Unknown AI version "${version}". Known versions: ${AI_VERSIONS.join(", ")}`);
    }
    return strategy;
}
