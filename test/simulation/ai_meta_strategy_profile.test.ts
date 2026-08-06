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

import { describe, expect, it } from "bun:test";

import { StrategyV0_8 } from "../../src/ai/versions/v0_8";
import { V08A19RankedPlacementStrategy } from "../../src/ai/versions/v0_8_a19_ranked_placement";
import {
    AI_META_A19_H18_RANKED_PLACEMENT_STRATEGY_PROFILE,
    AI_META_NATIVE_V08_STRATEGY_PROFILE,
    AI_META_REGISTERED_VERSION_STRATEGY_PROFILE,
    createAiMetaMatchStrategyOverrides,
    type AiMetaStrategyProfileId,
} from "../../src/simulation/ai_meta_strategy_profile";

const publicOpponents = {
    greenOpponentCreatureIds: [4, 5, 5, 6],
    redOpponentCreatureIds: [11, 12, 11, 13],
} as const;

describe("AI-meta match strategy profiles", () => {
    it("leaves registered version lookup completely unchanged", () => {
        const overrides = createAiMetaMatchStrategyOverrides(
            AI_META_REGISTERED_VERSION_STRATEGY_PROFILE,
            publicOpponents,
        );

        expect(overrides).toEqual({});
        expect(Object.keys(overrides)).toHaveLength(0);
    });

    it("creates independent native v0.8 controls without promoted A19 placement decorators", () => {
        const first = createAiMetaMatchStrategyOverrides(AI_META_NATIVE_V08_STRATEGY_PROFILE, publicOpponents);
        const second = createAiMetaMatchStrategyOverrides(AI_META_NATIVE_V08_STRATEGY_PROFILE, publicOpponents);

        expect(first.greenStrategyOverride).toBeInstanceOf(StrategyV0_8);
        expect(first.redStrategyOverride).toBeInstanceOf(StrategyV0_8);
        expect(first.greenStrategyOverride).not.toBeInstanceOf(V08A19RankedPlacementStrategy);
        expect(first.redStrategyOverride).not.toBeInstanceOf(V08A19RankedPlacementStrategy);
        expect(first.greenStrategyOverride).not.toBe(first.redStrategyOverride);
        expect(second.greenStrategyOverride).not.toBe(first.greenStrategyOverride);
        expect(second.redStrategyOverride).not.toBe(first.redStrategyOverride);
        expect(first.greenStrategyOverride?.version).toBe("v0.8");
        expect(first.redStrategyOverride?.version).toBe("v0.8");
        expect(first.greenSetupPlacementPolicy).toBeUndefined();
        expect(first.redSetupPlacementPolicy).toBeUndefined();
    });

    it("creates independent A19 placement decorators and complete public-roster contexts per match", () => {
        const first = createAiMetaMatchStrategyOverrides(
            AI_META_A19_H18_RANKED_PLACEMENT_STRATEGY_PROFILE,
            publicOpponents,
        );
        const second = createAiMetaMatchStrategyOverrides(
            AI_META_A19_H18_RANKED_PLACEMENT_STRATEGY_PROFILE,
            publicOpponents,
        );

        expect(first.greenStrategyOverride).toBeInstanceOf(V08A19RankedPlacementStrategy);
        expect(first.redStrategyOverride).toBeInstanceOf(V08A19RankedPlacementStrategy);
        expect(first.greenStrategyOverride).not.toBe(first.redStrategyOverride);
        expect(second.greenStrategyOverride).not.toBe(first.greenStrategyOverride);
        expect(second.redStrategyOverride).not.toBe(first.redStrategyOverride);
        expect(first.greenStrategyOverride?.version).toBe("v0.8");
        expect(first.redStrategyOverride?.version).toBe("v0.8");
        expect(first.greenSetupPlacementPolicy).toBe("public-roster");
        expect(first.redSetupPlacementPolicy).toBe("public-roster");
        expect(first.greenPublicOpponentCreatures).toEqual([4, 5, 6]);
        expect(first.redPublicOpponentCreatures).toEqual([11, 12, 13]);
        expect(first.greenPublicOpponentCreatures).not.toBe(publicOpponents.greenOpponentCreatureIds);
        expect(first.redPublicOpponentCreatures).not.toBe(publicOpponents.redOpponentCreatureIds);
    });

    it("fails closed for an unknown serialized profile id", () => {
        expect(() => createAiMetaMatchStrategyOverrides("unknown" as AiMetaStrategyProfileId, publicOpponents)).toThrow(
            "Unknown AI-meta strategy profile unknown",
        );
    });
});
