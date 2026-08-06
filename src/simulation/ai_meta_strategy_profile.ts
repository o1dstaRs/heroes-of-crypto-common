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

import type { IAIStrategy } from "../ai/ai_strategy";
import type { PlacementPolicyVariant } from "../ai/setup/setup_ship";
import { StrategyV0_8 } from "../ai/versions/v0_8";
import { createV08A19H18RankedPlacementStrategy } from "../ai/versions/v0_8_a19_h18_ranked_placement_profile";

export const AI_META_REGISTERED_VERSION_STRATEGY_PROFILE = "registered-version" as const;
export const AI_META_NATIVE_V08_STRATEGY_PROFILE = "native-v0.8" as const;
export const AI_META_A19_H18_RANKED_PLACEMENT_STRATEGY_PROFILE = "a19-h18-ranked-placement-v8" as const;

/** Serializable strategy selection passed from the AI-meta coordinator into each worker isolate. */
export type AiMetaStrategyProfileId =
    | typeof AI_META_REGISTERED_VERSION_STRATEGY_PROFILE
    | typeof AI_META_NATIVE_V08_STRATEGY_PROFILE
    | typeof AI_META_A19_H18_RANKED_PLACEMENT_STRATEGY_PROFILE;

export interface IAiMetaPublicOpponentRosters {
    /** RED creature identities visible to GREEN during placement. */
    readonly greenOpponentCreatureIds: readonly number[];
    /** GREEN creature identities visible to RED during placement. */
    readonly redOpponentCreatureIds: readonly number[];
}

export interface IAiMetaMatchStrategyOverrides {
    readonly greenStrategyOverride?: IAIStrategy;
    readonly redStrategyOverride?: IAIStrategy;
    readonly greenSetupPlacementPolicy?: PlacementPolicyVariant;
    readonly redSetupPlacementPolicy?: PlacementPolicyVariant;
    readonly greenPublicOpponentCreatures?: readonly number[];
    readonly redPublicOpponentCreatures?: readonly number[];
}

const publicCreatureIds = (ids: readonly number[]): readonly number[] => Object.freeze([...new Set(ids)]);

/**
 * Materialize match-local strategy state. The registered-version arm deliberately returns no override fields,
 * preserving the version registry's existing behavior. Historical native-v0.8 and placement arms receive two
 * independent strategies because placement audits and any future strategy-local state must never leak between
 * seats or matches.
 */
export function createAiMetaMatchStrategyOverrides(
    profileId: AiMetaStrategyProfileId,
    publicOpponents: IAiMetaPublicOpponentRosters,
): IAiMetaMatchStrategyOverrides {
    if (profileId === AI_META_REGISTERED_VERSION_STRATEGY_PROFILE) return Object.freeze({});
    if (profileId === AI_META_NATIVE_V08_STRATEGY_PROFILE) {
        return Object.freeze({
            greenStrategyOverride: new StrategyV0_8(),
            redStrategyOverride: new StrategyV0_8(),
        });
    }
    if (profileId === AI_META_A19_H18_RANKED_PLACEMENT_STRATEGY_PROFILE) {
        return Object.freeze({
            greenStrategyOverride: createV08A19H18RankedPlacementStrategy(),
            redStrategyOverride: createV08A19H18RankedPlacementStrategy(),
            greenSetupPlacementPolicy: "public-roster" as const,
            redSetupPlacementPolicy: "public-roster" as const,
            greenPublicOpponentCreatures: publicCreatureIds(publicOpponents.greenOpponentCreatureIds),
            redPublicOpponentCreatures: publicCreatureIds(publicOpponents.redOpponentCreatureIds),
        });
    }
    throw new Error(`Unknown AI-meta strategy profile ${String(profileId)}`);
}
