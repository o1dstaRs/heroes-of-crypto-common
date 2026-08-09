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

import { Tier1Artifact } from "../../artifacts/artifact_properties";
import {
    backlineProtectionBeneficiaryCount,
    creatureInfo,
    isRankedSpellRangedDraftPolicy,
    rankedSpellRangedCoPlayAffinity,
    type RankedSpellRangedDraftPolicyId,
} from "./creature_score";
import {
    isRankedDraftInteractionPrior,
    rankedDraftInteractionAffinity,
    RANKED_DRAFT_INTERACTION_PRIOR_WEIGHT,
    type RankedDraftInteractionPriorId,
} from "./draft_interaction_prior";
import {
    isRankedDraftVarietyPolicy,
    pickRankedDraftVarietyCreature,
    type RankedDraftVarietyPolicyId,
} from "./draft_variety";

export type DraftBundle = readonly [number, number, number];

export interface IDraftCoherenceContext {
    /** The acting seat's own public roster. Opponent-private draft information never enters this overlay. */
    ownCreatureIds: readonly number[];
    /** The acting seat's selected Tier-1 artifact, when the bundle phase has already resolved. */
    tier1ArtifactId?: number;
    /** Only public enemy picks. Required when an interaction-prior candidate uses counter evidence. */
    knownOpponentCreatureIds?: readonly number[];
    /** Candidate-only evidence overlay; omitted preserves the existing coherence policy exactly. */
    draftInteractionPrior?: RankedDraftInteractionPriorId;
    /** Candidate-only close-offer selector; omitted preserves the existing coherence policy exactly. */
    draftVarietyPolicy?: RankedDraftVarietyPolicyId;
    /** Candidate-only offensive-spell co-play selector; omitted preserves the existing coherence policy exactly. */
    draftSpellRangedPolicy?: RankedSpellRangedDraftPolicyId;
}

/** Keep replay-derived build fit influential without making it lexicographically stronger than the genome. */
export const DRAFT_COHERENCE_WEIGHT = 0.35;

const INTERACTION_TO_COHERENCE_SCALE = RANKED_DRAFT_INTERACTION_PRIOR_WEIGHT / DRAFT_COHERENCE_WEIGHT;

const MULTI_HIT_MELEE_ABILITIES = [
    "Double Punch",
    "Lightning Spin",
    "Skewer Strike",
    "Fire Breath",
    "Chain Lightning",
] as const;

const hasMultiHitMeleePressure = (creatureId: number): boolean => {
    const info = creatureInfo(creatureId);
    return !!info?.melee && MULTI_HIT_MELEE_ABILITIES.some((ability) => info.abilities.includes(ability));
};

const hasMobilePressure = (creatureId: number): boolean => {
    const info = creatureInfo(creatureId);
    return (
        !!info &&
        (info.canFly ||
            info.speed >= 7 ||
            info.abilities.includes("Rapid Charge") ||
            info.abilities.includes("Sky Runner"))
    );
};

/**
 * Dimensionless, fair-information fit of one creature with the acting seat's emerging build. Build-defining
 * artifacts carry the strongest signal; own-roster role and faction continuity are intentionally smaller.
 */
export function draftCreatureCoherenceAffinity(creatureId: number, context: IDraftCoherenceContext): number {
    const info = creatureInfo(creatureId);
    if (!info) return 0;

    let affinity = 0;
    if (context.tier1ArtifactId === Tier1Artifact.HUNTERS_LONGBOW && info.ranged) {
        affinity += 1.2;
    } else if (context.tier1ArtifactId === Tier1Artifact.WINGED_BOOTS && info.canFly) {
        affinity += 1.2 + (hasMobilePressure(creatureId) ? 0.15 : 0);
    } else if (context.tier1ArtifactId === Tier1Artifact.WOUNDING_CHARM && info.melee) {
        affinity += 0.45;
        if (hasMultiHitMeleePressure(creatureId)) affinity += 0.75;
        if (hasMobilePressure(creatureId)) affinity += 0.15;
    }

    const ownInfos = context.ownCreatureIds.flatMap((id) => {
        const ownInfo = creatureInfo(id);
        return ownInfo ? [ownInfo] : [];
    });
    const ownRanged = ownInfos.filter((own) => own.ranged).length;
    const ownMobile = context.ownCreatureIds.filter(hasMobilePressure).length;
    const ownMelee = ownInfos.filter((own) => own.melee).length;
    const ownFaction = ownInfos.filter((own) => own.faction === info.faction).length;

    if (info.ranged && ownRanged > 0) affinity += ownRanged >= 2 ? 0.3 : 0.12;
    if (hasMobilePressure(creatureId) && ownMobile > 0) affinity += ownMobile >= 2 ? 0.25 : 0.1;
    if (info.melee && ownMelee >= 2) affinity += ownMelee >= 3 ? 0.18 : 0.12;
    if (info.name === "Abomination" && backlineProtectionBeneficiaryCount(context.ownCreatureIds) >= 2) {
        affinity += 0.4;
    }
    if (isRankedSpellRangedDraftPolicy(context.draftSpellRangedPolicy)) {
        affinity += rankedSpellRangedCoPlayAffinity(creatureId, context.ownCreatureIds);
    }
    // The second unit activates a faction synergy; later matches retain a smaller continuity preference.
    if (info.faction && ownFaction > 0) affinity += ownFaction === 1 ? 0.12 : 0.07;

    return affinity;
}

/**
 * Scale the baseline by its largest absolute offer score, then add a bounded coherence blend. Unlike min/max
 * offer ranking, this preserves the difference between a near-tie and a several-fold learned-score gap while
 * still letting build fit decide genuinely comparable options. It also works for all-negative score heads.
 */
export function applyDraftCoherenceOverlay(
    baseScores: readonly number[],
    coherenceAffinities: readonly number[],
): number[] {
    if (baseScores.length !== coherenceAffinities.length) {
        throw new RangeError("Draft coherence base-score and affinity arrays must have the same length");
    }
    if (!baseScores.every(Number.isFinite) || !coherenceAffinities.every(Number.isFinite)) {
        throw new TypeError("Draft coherence inputs must all be finite numbers");
    }
    if (!baseScores.length) return [];

    const scale = Math.max(1, ...baseScores.map((score) => Math.abs(score)));
    return baseScores.map(
        (baseScore, index) => baseScore / scale + coherenceAffinities[index] * DRAFT_COHERENCE_WEIGHT,
    );
}

const bestScoreIndex = (scores: readonly number[]): number => {
    let bestIndex = 0;
    let bestScore = -Infinity;
    scores.forEach((score, index) => {
        if (score > bestScore) {
            bestIndex = index;
            bestScore = score;
        }
    });
    return bestIndex;
};

export function pickCoherentDraftCreature(
    available: readonly number[],
    baseScore: (creatureId: number) => number,
    context: IDraftCoherenceContext,
): number | undefined {
    if (!available.length) return undefined;
    const baseScores = available.map(baseScore);
    const affinities = available.map(
        (creatureId) =>
            draftCreatureCoherenceAffinity(creatureId, context) +
            (isRankedDraftInteractionPrior(context.draftInteractionPrior)
                ? rankedDraftInteractionAffinity(creatureId, context) * INTERACTION_TO_COHERENCE_SCALE
                : 0),
    );
    const scores = applyDraftCoherenceOverlay(baseScores, affinities);
    if (isRankedDraftVarietyPolicy(context.draftVarietyPolicy)) {
        return pickRankedDraftVarietyCreature(available, scores, context);
    }
    return available[bestScoreIndex(scores)];
}

/** Build-plan fit available at bundle time, before later creature offers have resolved. */
export function draftBundleCoherenceAffinity(
    [level1, level2, artifactId]: DraftBundle,
    options: Pick<IDraftCoherenceContext, "draftSpellRangedPolicy"> = {},
): number {
    const creatures = [level1, level2] as const;
    const planSeed =
        artifactId === Tier1Artifact.HUNTERS_LONGBOW ||
        artifactId === Tier1Artifact.WINGED_BOOTS ||
        artifactId === Tier1Artifact.WOUNDING_CHARM
            ? 0.12
            : 0;
    const creatureFit = creatures.reduce(
        (sum, creatureId, index) =>
            sum +
            draftCreatureCoherenceAffinity(creatureId, {
                ownCreatureIds: [creatures[index === 0 ? 1 : 0]],
                tier1ArtifactId: artifactId,
                ...options,
            }),
        0,
    );
    return planSeed + creatureFit / creatures.length;
}

export function pickCoherentDraftBundle(
    bundles: readonly DraftBundle[],
    creatureScore: (creatureId: number) => number,
    artifactScore: (artifactId: number) => number,
    options: Pick<IDraftCoherenceContext, "draftSpellRangedPolicy"> = {},
): number {
    if (!bundles.length) return 0;
    const baseScores = bundles.map(
        ([level1, level2, artifactId]) => creatureScore(level1) + creatureScore(level2) + artifactScore(artifactId),
    );
    const affinities = bundles.map((bundle) => draftBundleCoherenceAffinity(bundle, options));
    return bestScoreIndex(applyDraftCoherenceOverlay(baseScores, affinities));
}
