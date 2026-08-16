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
import { scoreCreature } from "./setup/creature_score";
import {
    SETUP_POLICY_V0_RESOLVED,
    type ISetupAugmentChoice,
    type IResolvedSetupPolicy,
    type ISetupSynergyChoice,
} from "./setup/setup_ship";
import type { IPlacementSetupDecisionContext, ITier2ArtifactDecisionContext } from "./setup/setup_strategy";
import { SETUP_POLICY_V0 } from "./setup/setup_v0";
import { StrategyV0_1 } from "./versions/v0_1";
import { StrategyV0_2 } from "./versions/v0_2";
import { StrategyV0_3 } from "./versions/v0_3";
import { StrategyV0_4 } from "./versions/v0_4";
import { StrategyV0_5 } from "./versions/v0_5";
import { StrategyV0_6 } from "./versions/v0_6";
import { StrategyV0_6S } from "./versions/v0_6s";
import { StrategyV0_7 } from "./versions/v0_7";
import { StrategyV0_7S } from "./versions/v0_7s";
import { StrategyV0_8S } from "./versions/v0_8s";
import { createV08A19Strategy } from "./versions/v0_8_a19_profile";
import { StrategyV0_9 } from "./versions/v0_9";

export interface IRankedAISetupPolicy extends IResolvedSetupPolicy {
    /** Stable setup-policy identity for persisted seats, telemetry and future per-strength tuning. */
    readonly version: string;
    pickDoctrine(): number;
    /** Optional pre-game ban. Undefined means there is no legal proposal to submit. */
    pickBan(bannableCreatureIds: readonly number[]): number | undefined;
    /** Index of a legal [level-1, level-2, Tier-1 artifact] starting bundle. */
    pickBundle(bundles: readonly (readonly [number, number, number])[]): number;
    pickCreature(
        level: number,
        available: readonly number[],
        ownCreatureIds: readonly number[],
        knownOpponentCreatureIds: readonly number[],
        tier1ArtifactId?: number,
    ): number;
    pickArtifactT2(
        offered: readonly number[],
        ownCreatureIds: readonly number[],
        context?: Readonly<ITier2ArtifactDecisionContext>,
    ): number;
    pickAugments(
        budget: number,
        ownCreatureIds: readonly number[],
        context?: Readonly<IPlacementSetupDecisionContext>,
    ): ISetupAugmentChoice[];
    pickSynergies(
        ownCreatureStackIds: readonly number[],
        context?: Readonly<IPlacementSetupDecisionContext>,
    ): ISetupSynergyChoice[];
    bestSynergyForFaction(faction: number): number;
}

/**
 * Portable full-lifecycle capability for every ranked AI version. Authoritative hosts may bind a deployed
 * draft/setup overlay (for example a server-qualified genome), while this browser-safe baseline guarantees
 * that every registered version can make every required decision without Node-only policy dependencies.
 * Setup policy and combat strategy remain separate identities so future strengths can replace either half.
 */
export interface IRankedAIProfile {
    readonly version: string;
    readonly setupPolicyVersion: string;
    readonly setupPolicy: Readonly<IRankedAISetupPolicy>;
    /** Strategies may contain match-local memory. A caller must create one for each match/seat. */
    createStrategy(): IAIStrategy;
}

const bestBan = (bannableCreatureIds: readonly number[]): number | undefined => {
    let best: number | undefined;
    let bestScore = -Infinity;
    for (const creatureId of bannableCreatureIds) {
        const candidateScore = scoreCreature(creatureId);
        if (candidateScore > bestScore) {
            best = creatureId;
            bestScore = candidateScore;
        }
    }
    return best;
};

/** Full-ranked adapter for the original setup policy, including the newer fair-information contexts. */
export const RANKED_SETUP_POLICY_V0: Readonly<IRankedAISetupPolicy> = Object.freeze({
    ...SETUP_POLICY_V0_RESOLVED,
    version: SETUP_POLICY_V0.version,
    pickDoctrine: (): number => SETUP_POLICY_V0.pickDoctrine(),
    pickBan: bestBan,
    pickBundle: (bundles: readonly (readonly [number, number, number])[]): number =>
        SETUP_POLICY_V0.pickBundle(bundles),
    pickCreature: (
        level: number,
        available: readonly number[],
        ownCreatureIds: readonly number[],
        knownOpponentCreatureIds: readonly number[],
        tier1ArtifactId?: number,
    ): number =>
        SETUP_POLICY_V0.pickCreature(level, available, ownCreatureIds, knownOpponentCreatureIds, tier1ArtifactId),
    pickArtifactT2: (
        offered: readonly number[],
        ownCreatureIds: readonly number[],
        context?: Readonly<ITier2ArtifactDecisionContext>,
    ): number => SETUP_POLICY_V0_RESOLVED.pickArtifactT2(offered, ownCreatureIds, context),
    pickAugments: (
        budget: number,
        ownCreatureIds: readonly number[],
        context?: Readonly<IPlacementSetupDecisionContext>,
    ): ISetupAugmentChoice[] => SETUP_POLICY_V0_RESOLVED.pickAugments(budget, ownCreatureIds, context),
    pickSynergies: (
        ownCreatureStackIds: readonly number[],
        context?: Readonly<IPlacementSetupDecisionContext>,
    ): ISetupSynergyChoice[] => SETUP_POLICY_V0_RESOLVED.pickSynergies(ownCreatureStackIds, context),
    bestSynergyForFaction: (faction: number): number => SETUP_POLICY_V0.bestSynergyForFaction(faction),
});

type StrategyFactory = () => IAIStrategy;

const checkedFactory =
    (version: string, factory: StrategyFactory): StrategyFactory =>
    (): IAIStrategy => {
        const strategy = factory();
        if (strategy.version !== version) {
            throw new Error(`AI strategy factory for "${version}" created "${strategy.version}"`);
        }
        return strategy;
    };

const rankedProfile = (version: string, factory: StrategyFactory): Readonly<IRankedAIProfile> => {
    const createStrategy = checkedFactory(version, factory);
    return Object.freeze({
        version,
        setupPolicyVersion: RANKED_SETUP_POLICY_V0.version,
        setupPolicy: RANKED_SETUP_POLICY_V0,
        createStrategy,
    });
};

/**
 * Explicit ordered bindings are intentional. Adding a battle version is incomplete until its complete ranked
 * profile is registered here, which prevents a mocked player from reaching draft/setup with no policy.
 */
export const RANKED_AI_PROFILES: readonly Readonly<IRankedAIProfile>[] = Object.freeze([
    rankedProfile("v0.1", () => new StrategyV0_1()),
    rankedProfile("v0.2", () => new StrategyV0_2()),
    rankedProfile("v0.3", () => new StrategyV0_3()),
    rankedProfile("v0.4", () => new StrategyV0_4()),
    rankedProfile("v0.5", () => new StrategyV0_5()),
    rankedProfile("v0.6s", () => new StrategyV0_6S()),
    rankedProfile("v0.6", () => new StrategyV0_6()),
    rankedProfile("v0.7s", () => new StrategyV0_7S()),
    rankedProfile("v0.7", () => new StrategyV0_7()),
    rankedProfile("v0.9", () => new StrategyV0_9()),
    rankedProfile("v0.8s", () => new StrategyV0_8S()),
    rankedProfile("v0.8", () => createV08A19Strategy()),
]);

const PROFILE_BY_VERSION: ReadonlyMap<string, Readonly<IRankedAIProfile>> = new Map(
    RANKED_AI_PROFILES.map((profile) => [profile.version, profile]),
);

export const AI_VERSIONS: readonly string[] = Object.freeze(RANKED_AI_PROFILES.map((profile) => profile.version));

const unknownVersion = (version: string): Error =>
    new Error(`Unknown AI version "${version}". Known versions: ${AI_VERSIONS.join(", ")}`);

export function getRankedAIProfile(version: string): Readonly<IRankedAIProfile> {
    const profile = PROFILE_BY_VERSION.get(version);
    if (!profile) throw unknownVersion(version);
    return profile;
}

/** Create a fresh match-local instance of the exact registered version. Never falls back to another AI. */
export function createAIStrategy(version: string): IAIStrategy {
    return getRankedAIProfile(version).createStrategy();
}
