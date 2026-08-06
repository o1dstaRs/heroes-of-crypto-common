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
import { STRATEGY_V0_8S } from "./versions/v0_8s";
import { createV08A19Strategy, V08_A19_PRODUCTION_VERSION } from "./versions/v0_8_a19_profile";
import { STRATEGY_V0_9 } from "./versions/v0_9";

export type {
    AIPolicyEventKind,
    IAIPolicyEvent,
    IAIStrategy,
    IDecisionContext,
    IPlacementContext,
    IV08ProtectedAdvanceGuardrailDetails,
    IV08SupportedBandAdvanceDetails,
    IV08SupportedBandDominanceComparisonDetails,
    IV08SupportedBandScreenedCloserComparisonDetails,
    IV08SupportedBandDuelDecisionSummary,
    IV08SupportedBandDuelDetails,
    IV08SupportedPrepinEgressDetails,
    IV09DecisionTelemetryDetails,
    V08ProtectedAdvanceGuardrailMode,
    V08ProtectedAdvanceGuardrailReason,
    V08SupportedBandDominanceReason,
    V08SupportedBandScreenedCloserReason,
    V08SupportedBandDuelDifference,
    V09ArtifactStatus,
    V09DecisionFallbackReason,
} from "./ai_strategy";

// Browser-safe identities and immutable configuration for the promoted v0.8+A19 composite and its a13
// rollback. Node-only SearchDriver factories are exported separately from `src/simulation` so importing the
// shared game API never pulls in node:fs/path.
export {
    buildV08A13SearchEnvironment,
    V08_A13_CANDIDATE_ID,
    V08_A13_GENOME,
    V08_A13_GENOME_SHA256,
    V08_A13_OPPONENT_VERSION,
    V08_A13_POLICY,
    V08_A13_PRODUCTION_BEHAVIOR_ENVIRONMENT_SHA256,
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
export {
    buildV08A19SearchEnvironment,
    createV08A19Strategy,
    V08_A19_CANDIDATE_ID,
    V08_A19_PRODUCTION_VERSION,
    V08_A19_PROFILE,
    V08_A19_PROFILE_SCHEMA,
    V08_A19_PRODUCTION_ROUTING_SOURCE_LEDGER,
} from "./versions/v0_8_a19_profile";

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

// Browser-safe v0.9 artifact identity, feature contract and deterministic fixed-point inference. The embedded
// bootstrap is explicitly anchor-only/unpromoted; server allocation must require V09_MODEL_PROMOTED.
export {
    V09_MODEL_ARTIFACT,
    V09_MODEL_ID,
    V09_MODEL_PROMOTED,
    V09_MODEL_SHA256,
    V09_MODEL_STATUS,
} from "./versions/v0_9_artifact";
export {
    V09_CANDIDATE_FEATURE_NAMES,
    V09_FEATURE_SCHEMA,
    V09_FEATURE_SCHEMA_SHA256,
    V09_INPUT_FEATURE_NAMES,
    V09_RICH_FEATURE_NAMES,
    v09CandidateFeatureVector,
    v09HasResolvedVisibleShot,
    v09RangeObservation,
} from "./versions/v0_9_features";
export {
    V09_FEATURE_BLOCKS,
    V09_EMPTY_FAILURES_SHA256,
    V09_MODEL_HASH_ALGORITHM,
    V09_MODEL_SCHEMA,
    V09_QUALIFICATION_RECEIPT_SCHEMA,
    isV09ModelRunnable,
    scoreV09FixedPoint,
    serializeV09ModelHashPayload,
    serializeV09QualificationReceiptPayload,
    validateV09ModelArtifact,
} from "./versions/v0_9_model";
export type {
    IV09Architecture,
    IV09DenseLayer,
    IV09FeatureBlock,
    IV09FeatureContract,
    IV09FixedPointContract,
    IV09ModelArtifact,
    IV09ModelSource,
    IV09Normalization,
    IV09QualificationReceipt,
} from "./versions/v0_9_model";

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
    // v0.9 is registered for explicit research/canary seats, but its embedded artifact is an intentionally
    // untrained, unpromoted candidate-zero anchor. Keep it before the v0.8s/v0.8 pair until a separately reviewed
    // qualification commit promotes a real model; this preserves LATEST/DEFAULT and alias adjacency invariants.
    STRATEGY_V0_9,
    // v0.8s is the compatibility alias used to replay the frozen a13 training/validation seat. Its native
    // strategy is now identical to v0.8; the distinct version string remains useful for historical artifacts
    // and seat-scoped research. Keep it before v0.8 so it can never become LATEST/DEFAULT by registration.
    STRATEGY_V0_8S,
    // v0.8 now resolves to the qualified A19 finalist: exact/far-flank/compact/ranked placement layered over
    // the native v0.8 combat strategy. Search-capable runtimes add the matching H64 A19 SearchDriver; browser-only
    // callers retain the native combat policy without importing Node-only simulation dependencies.
    createV08A19Strategy(),
];

// Mindless-unit AI pin ("AI Driven" -> v0.1). Re-exported here so the simulation engine and the client
// controller resolve a unit's brain through one rule.
export {
    MINDLESS_AI_ABILITY,
    MINDLESS_AI_VERSION,
    aiVersionForUnit,
    isMindlessAiUnit,
    type IAiOverrideUnit,
} from "./unit_ai_overrides";

const STRATEGY_BY_VERSION: ReadonlyMap<string, IAIStrategy> = new Map(STRATEGIES.map((s) => [s.version, s]));

export const AI_VERSIONS: readonly string[] = STRATEGIES.map((s) => s.version);

export const LATEST_AI_VERSION: string = STRATEGIES[STRATEGIES.length - 1].version;

/**
 * The AI version the GAME uses by default — when the AI toggle is enabled, or when a player picks the
 * (non-LLM) AI opponent. Kept separate from LATEST_AI_VERSION so in-development versions (e.g. v0.4)
 * can be registered and tournament-tested without shipping them to live games.
 *
 * v0.8+A19 is the shipped default. Its registered strategy adds the qualified A19 placement composition around
 * the native v0.8 combat policy, while search-capable runtimes complete it with the matching H64 A19 profile.
 * The public version remains v0.8 so persisted AI seats and replays remain compatible.
 */
export const DEFAULT_AI_VERSION = V08_A19_PRODUCTION_VERSION;

export function getAIStrategy(version: string): IAIStrategy {
    const strategy = STRATEGY_BY_VERSION.get(version);
    if (!strategy) {
        throw new Error(`Unknown AI version "${version}". Known versions: ${AI_VERSIONS.join(", ")}`);
    }
    return strategy;
}
