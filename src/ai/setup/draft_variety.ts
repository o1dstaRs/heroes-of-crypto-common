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
import { creatureInfo } from "./creature_score";

/**
 * A versioned, public-information-only policy that makes close-ranked offers produce different viable army
 * shapes. It is deliberately metadata rather than a trained weight so established genomes keep exact bytes.
 */
export const RANKED_DRAFT_VARIETY_POLICY_ID = "ranked-versatile-a19-v3" as const;
export type RankedDraftVarietyPolicyId = typeof RANKED_DRAFT_VARIETY_POLICY_ID;

/** Alternatives may never trail the post-score argmax by more than this normalized score. */
export const RANKED_DRAFT_VARIETY_MAX_SCORE_REGRET = 0.02;

/** The third added creature is the one deliberate flex slot; starters and the final anchor keep the argmax. */
export const RANKED_DRAFT_VARIETY_OWN_CREATURE_COUNT = 4;

export type RankedDraftArchetype = "ranged" | "mobile" | "caster" | "frontline";

export interface IRankedDraftVarietyContext {
    /** The drafting seat's public picks. */
    ownCreatureIds: readonly number[];
    /** Only opponent creatures the live reveal rules have exposed. */
    knownOpponentCreatureIds?: readonly number[];
    /** The selected Tier-1 artifact anchors a build plan when it has a natural beneficiary. */
    tier1ArtifactId?: number;
}

export interface IRankedDraftVarietyDecision {
    creatureId: number | undefined;
    argmaxCreatureId: number | undefined;
    changedFromArgmax: boolean;
    desiredArchetype?: RankedDraftArchetype;
    eligibleCreatureIds: readonly number[];
}

const ARCHETYPES: readonly RankedDraftArchetype[] = ["ranged", "mobile", "caster", "frontline"];

const isFiniteScoreArray = (scores: readonly number[]): boolean => scores.every((score) => Number.isFinite(score));

const canonicalIds = (ids: readonly number[]): number[] =>
    [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))].sort((left, right) => left - right);

/** FNV-1a-style uint32 mixer; it is a stable choice salt, not an entropy or security primitive. */
const mixHash = (hash: number, value: number): number => Math.imul((hash ^ (value >>> 0)) >>> 0, 0x01000193) >>> 0;

const contextHash = (available: readonly number[], context: IRankedDraftVarietyContext): number => {
    let hash = 0x811c9dc5;
    const addSection = (marker: number, ids: readonly number[]): void => {
        hash = mixHash(hash, marker);
        for (const id of canonicalIds(ids)) hash = mixHash(hash, id);
    };
    hash = mixHash(hash, context.tier1ArtifactId ?? 0);
    addSection(0x9e3779b9, available);
    addSection(0x85ebca6b, context.ownCreatureIds);
    addSection(0xc2b2ae35, context.knownOpponentCreatureIds ?? []);
    return hash >>> 0;
};

const creatureArchetypes = (creatureId: number): RankedDraftArchetype[] => {
    const info = creatureInfo(creatureId);
    if (!info) return [];
    const archetypes: RankedDraftArchetype[] = [];
    if (info.ranged) archetypes.push("ranged");
    if (info.canFly || info.initiative >= 7) archetypes.push("mobile");
    if (info.mage || info.caster) archetypes.push("caster");
    if (info.melee && !info.ranged) archetypes.push("frontline");
    return archetypes;
};

const artifactArchetype = (tier1ArtifactId: number | undefined): RankedDraftArchetype | undefined => {
    if (tier1ArtifactId === Tier1Artifact.HUNTERS_LONGBOW) return "ranged";
    if (tier1ArtifactId === Tier1Artifact.WINGED_BOOTS) return "mobile";
    if (tier1ArtifactId === Tier1Artifact.WOUNDING_CHARM) return "frontline";
    return undefined;
};

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

const bestArchetypeCandidate = (
    eligible: readonly { creatureId: number; score: number }[],
    archetype: RankedDraftArchetype,
): { creatureId: number; score: number } | undefined => {
    let best: { creatureId: number; score: number } | undefined;
    for (const candidate of eligible) {
        if (!creatureArchetypes(candidate.creatureId).includes(archetype)) continue;
        if (
            !best ||
            candidate.score > best.score ||
            (candidate.score === best.score && candidate.creatureId < best.creatureId)
        ) {
            best = candidate;
        }
    }
    return best;
};

export const isRankedDraftVarietyPolicy = (value: unknown): value is RankedDraftVarietyPolicyId =>
    value === RANKED_DRAFT_VARIETY_POLICY_ID;

/**
 * Pick a close alternative that completes a public build shape. The hash rotates viable novel archetypes
 * between distinct offer/roster states, while a named artifact takes precedence when it has a beneficiary.
 * The function intentionally remains deterministic for a given public draft state, so retries and replays
 * cannot drift.
 */
export function decideRankedDraftVariety(
    available: readonly number[],
    postScoreValues: readonly number[],
    context: IRankedDraftVarietyContext,
): IRankedDraftVarietyDecision {
    if (available.length !== postScoreValues.length) {
        throw new RangeError("Draft variety offer and post-score arrays must have the same length");
    }
    if (!isFiniteScoreArray(postScoreValues)) {
        throw new TypeError("Draft variety post-score values must all be finite numbers");
    }
    if (!available.length) {
        return {
            creatureId: undefined,
            argmaxCreatureId: undefined,
            changedFromArgmax: false,
            eligibleCreatureIds: [],
        };
    }

    const argmaxIndex = bestScoreIndex(postScoreValues);
    const argmaxCreatureId = available[argmaxIndex];
    const bestScore = postScoreValues[argmaxIndex];
    if (context.ownCreatureIds.length !== RANKED_DRAFT_VARIETY_OWN_CREATURE_COUNT) {
        return {
            creatureId: argmaxCreatureId,
            argmaxCreatureId,
            changedFromArgmax: false,
            eligibleCreatureIds: [argmaxCreatureId],
        };
    }
    const eligible = available
        .map((creatureId, index) => ({ creatureId, score: postScoreValues[index] }))
        .filter((candidate) => candidate.score >= bestScore - RANKED_DRAFT_VARIETY_MAX_SCORE_REGRET);
    const eligibleCreatureIds = eligible.map((candidate) => candidate.creatureId);
    const viableArchetypes = ARCHETYPES.filter((archetype) => bestArchetypeCandidate(eligible, archetype));
    if (!viableArchetypes.length) {
        return { creatureId: argmaxCreatureId, argmaxCreatureId, changedFromArgmax: false, eligibleCreatureIds };
    }

    const artifactPlan = artifactArchetype(context.tier1ArtifactId);
    const ownArchetypes = new Set(context.ownCreatureIds.flatMap(creatureArchetypes));
    const novelArchetypes = viableArchetypes.filter((archetype) => !ownArchetypes.has(archetype));
    const planCandidates =
        artifactPlan && viableArchetypes.includes(artifactPlan)
            ? [artifactPlan]
            : novelArchetypes.length
              ? novelArchetypes
              : viableArchetypes;
    const desiredArchetype = planCandidates[contextHash(available, context) % planCandidates.length];
    const chosen = bestArchetypeCandidate(eligible, desiredArchetype) ?? {
        creatureId: argmaxCreatureId,
        score: bestScore,
    };
    return {
        creatureId: chosen.creatureId,
        argmaxCreatureId,
        changedFromArgmax: chosen.creatureId !== argmaxCreatureId,
        desiredArchetype,
        eligibleCreatureIds,
    };
}

export const pickRankedDraftVarietyCreature = (
    available: readonly number[],
    postScoreValues: readonly number[],
    context: IRankedDraftVarietyContext,
): number | undefined => decideRankedDraftVariety(available, postScoreValues, context).creatureId;
