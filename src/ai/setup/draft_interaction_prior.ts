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

import interactionPriorJson from "./draft_interaction_priors/ai_meta_a19_ranked_draft_10008_v1.json";
import { creatureIdForName } from "./creature_score";

interface IRawInteractionRow {
    units: string[];
    support: number;
    conservativeLiftPp: number;
}

interface IRawCounterRow {
    unit: string;
    enemyUnit: string;
    support: number;
    conservativeLiftPp: number;
}

interface IRawInteractionPrior {
    schemaVersion: number;
    id: string;
    source: {
        sourceSha256: string;
        sourceRelativePath: string;
        generatedAt: string;
        matchupPairs: number;
        games: number;
        cohorts: string[];
        maps: number[];
    };
    selection: {
        allyPair: { minimumSupport: number; minimumAbsoluteConfidencePp: number };
        counter: { minimumSupport: number; minimumAbsoluteConfidencePp: number };
        allyTrio: { minimumSupport: number; minimumConfidencePp: number };
    };
    allyPairs: IRawInteractionRow[];
    counters: IRawCounterRow[];
    allyTrios: IRawInteractionRow[];
}

export interface IRankedDraftInteractionPriorSource {
    sourceSha256: string;
    sourceRelativePath: string;
    generatedAt: string;
    matchupPairs: number;
    games: number;
    cohorts: readonly string[];
    maps: readonly number[];
}

export interface IRankedDraftInteractionEvidence {
    creatureIds: readonly number[];
    support: number;
    conservativeLiftPp: number;
}

export interface IRankedDraftCounterEvidence {
    creatureId: number;
    enemyCreatureId: number;
    support: number;
    conservativeLiftPp: number;
}

export interface IRankedDraftInteractionContext {
    /** Public roster of the drafting seat. */
    ownCreatureIds: readonly number[];
    /** Only creatures that ranked reveal rules have made visible to this seat. */
    knownOpponentCreatureIds?: readonly number[];
}

export interface IRankedDraftInteractionBreakdown {
    allyPair: number;
    counter: number;
    allyTrio: number;
    optionValue: number;
    total: number;
}

const interactionPrior = interactionPriorJson as IRawInteractionPrior;

export const RANKED_DRAFT_INTERACTION_PRIOR_ID = "ai-meta-a19-ranked-draft-10008-v1" as const;
export type RankedDraftInteractionPriorId = typeof RANKED_DRAFT_INTERACTION_PRIOR_ID;

/** Deliberately smaller than the existing artifact/role coherence overlay; the genome remains the primary scorer. */
export const RANKED_DRAFT_INTERACTION_PRIOR_WEIGHT = 0.18;

/** Stable source audit for the live-ranked slice of the frozen seven-cohort meta study. */
export const RANKED_DRAFT_INTERACTION_PRIOR_SOURCE: IRankedDraftInteractionPriorSource = interactionPrior.source;

const PAIR_LIFT_SCALE_PP = 10;
const COUNTER_LIFT_SCALE_PP = 12;
const TRIO_LIFT_SCALE_PP = 20;
const PAIR_AFFINITY_CAP = 0.75;
const COUNTER_AFFINITY_CAP = 0.65;
const TRIO_AFFINITY_CAP = 0.25;
const OPTION_AFFINITY_CAP = 0.12;
const TOTAL_AFFINITY_CAP = 0.9;

const clamp = (value: number, lower: number, upper: number): number => Math.min(upper, Math.max(lower, value));

const uniqueCreatureIds = (creatureIds: readonly number[]): number[] => [
    ...new Set(creatureIds.filter((creatureId) => Number.isInteger(creatureId) && creatureId > 0)),
];

const creatureKey = (creatureIds: readonly number[]): string =>
    [...creatureIds].sort((left, right) => left - right).join("|");

const counterKey = (creatureId: number, enemyCreatureId: number): string => `${creatureId}>${enemyCreatureId}`;

const requireCreatureIds = (names: readonly string[], expectedLength: number, label: string): number[] => {
    if (names.length !== expectedLength) {
        throw new Error(
            `Ranked draft interaction prior ${label} has ${names.length} creatures; expected ${expectedLength}`,
        );
    }
    const creatureIds = names.map((name) => creatureIdForName(name));
    if (creatureIds.some((creatureId) => creatureId === undefined)) {
        throw new Error(`Ranked draft interaction prior ${label} references an unknown creature`);
    }
    const resolved = creatureIds as number[];
    if (new Set(resolved).size !== expectedLength) {
        throw new Error(`Ranked draft interaction prior ${label} repeats a creature`);
    }
    return resolved;
};

const assertEvidence = (support: number, conservativeLiftPp: number, label: string): void => {
    if (!Number.isInteger(support) || support < 1 || !Number.isFinite(conservativeLiftPp)) {
        throw new Error(`Ranked draft interaction prior ${label} has invalid evidence`);
    }
};

if (interactionPrior.schemaVersion !== 1 || interactionPrior.id !== RANKED_DRAFT_INTERACTION_PRIOR_ID) {
    throw new Error("Unsupported ranked draft interaction prior artifact");
}

const pairEvidence: IRankedDraftInteractionEvidence[] = [];
const pairLiftByKey = new Map<string, number>();
const positivePartnersByCreature = new Map<number, number[]>();
for (const row of interactionPrior.allyPairs) {
    assertEvidence(row.support, row.conservativeLiftPp, "ally pair");
    const creatureIds = requireCreatureIds(row.units, 2, "ally pair");
    const key = creatureKey(creatureIds);
    if (pairLiftByKey.has(key)) throw new Error(`Ranked draft interaction prior duplicates ally pair ${key}`);
    pairLiftByKey.set(key, row.conservativeLiftPp);
    pairEvidence.push({ creatureIds, support: row.support, conservativeLiftPp: row.conservativeLiftPp });
    if (row.conservativeLiftPp > 0) {
        for (const [creatureId, partnerId] of [
            [creatureIds[0], creatureIds[1]],
            [creatureIds[1], creatureIds[0]],
        ] as const) {
            const partners = positivePartnersByCreature.get(creatureId) ?? [];
            partners.push(partnerId);
            positivePartnersByCreature.set(creatureId, partners);
        }
    }
}

const counterEvidence: IRankedDraftCounterEvidence[] = [];
const counterLiftByKey = new Map<string, number>();
for (const row of interactionPrior.counters) {
    assertEvidence(row.support, row.conservativeLiftPp, "counter");
    const creatureId = requireCreatureIds([row.unit], 1, "counter")[0];
    const enemyCreatureId = requireCreatureIds([row.enemyUnit], 1, "counter")[0];
    const key = counterKey(creatureId, enemyCreatureId);
    if (counterLiftByKey.has(key)) throw new Error(`Ranked draft interaction prior duplicates counter ${key}`);
    counterLiftByKey.set(key, row.conservativeLiftPp);
    counterEvidence.push({
        creatureId,
        enemyCreatureId,
        support: row.support,
        conservativeLiftPp: row.conservativeLiftPp,
    });
}

const trioEvidence: IRankedDraftInteractionEvidence[] = [];
const trioLiftByKey = new Map<string, number>();
for (const row of interactionPrior.allyTrios) {
    assertEvidence(row.support, row.conservativeLiftPp, "ally trio");
    const creatureIds = requireCreatureIds(row.units, 3, "ally trio");
    const key = creatureKey(creatureIds);
    if (trioLiftByKey.has(key)) throw new Error(`Ranked draft interaction prior duplicates ally trio ${key}`);
    trioLiftByKey.set(key, row.conservativeLiftPp);
    trioEvidence.push({ creatureIds, support: row.support, conservativeLiftPp: row.conservativeLiftPp });
}

export const RANKED_DRAFT_INTERACTION_EVIDENCE = {
    allyPairs: pairEvidence as readonly IRankedDraftInteractionEvidence[],
    counters: counterEvidence as readonly IRankedDraftCounterEvidence[],
    allyTrios: trioEvidence as readonly IRankedDraftInteractionEvidence[],
} as const;

export const isRankedDraftInteractionPrior = (value: unknown): value is RankedDraftInteractionPriorId =>
    value === RANKED_DRAFT_INTERACTION_PRIOR_ID;

const interactionOptionValue = (
    addedCreatureIds: readonly number[],
    rosterCreatureIds: ReadonlySet<number>,
): number => {
    let value = 0;
    for (const creatureId of addedCreatureIds) {
        const futurePartners = (positivePartnersByCreature.get(creatureId) ?? []).filter(
            (partnerId) => !rosterCreatureIds.has(partnerId),
        );
        if (futurePartners.length < 2) continue;
        const secondStrongestPartnerLift = futurePartners
            .map((partnerId) => pairLiftByKey.get(creatureKey([creatureId, partnerId])) ?? 0)
            .sort((left, right) => right - left)[1];
        value += 0.04 + 0.06 * clamp(secondStrongestPartnerLift / PAIR_LIFT_SCALE_PP, 0, 1);
    }
    return clamp(value, 0, OPTION_AFFINITY_CAP);
};

const interactionBreakdown = (
    addedCreatureIdsInput: readonly number[],
    context: IRankedDraftInteractionContext,
): IRankedDraftInteractionBreakdown => {
    const ownCreatureIds = uniqueCreatureIds(context.ownCreatureIds);
    const ownCreatureSet = new Set(ownCreatureIds);
    const addedCreatureIds = uniqueCreatureIds(addedCreatureIdsInput).filter(
        (creatureId) => !ownCreatureSet.has(creatureId),
    );
    if (!addedCreatureIds.length) {
        return { allyPair: 0, counter: 0, allyTrio: 0, optionValue: 0, total: 0 };
    }

    const addedCreatureSet = new Set(addedCreatureIds);
    const rosterCreatureSet = new Set([...ownCreatureIds, ...addedCreatureIds]);
    const knownOpponentCreatureIds = uniqueCreatureIds(context.knownOpponentCreatureIds ?? []);

    let pairLiftPp = 0;
    for (const row of pairEvidence) {
        if (
            row.creatureIds.every((creatureId) => rosterCreatureSet.has(creatureId)) &&
            row.creatureIds.some((creatureId) => addedCreatureSet.has(creatureId))
        ) {
            pairLiftPp += row.conservativeLiftPp;
        }
    }

    let counterLiftPp = 0;
    for (const creatureId of addedCreatureIds) {
        for (const enemyCreatureId of knownOpponentCreatureIds) {
            counterLiftPp += counterLiftByKey.get(counterKey(creatureId, enemyCreatureId)) ?? 0;
        }
    }

    let strongestTrioLiftPp = 0;
    for (const row of trioEvidence) {
        if (
            row.creatureIds.every((creatureId) => rosterCreatureSet.has(creatureId)) &&
            row.creatureIds.some((creatureId) => addedCreatureSet.has(creatureId))
        ) {
            strongestTrioLiftPp = Math.max(strongestTrioLiftPp, row.conservativeLiftPp);
        }
    }

    const allyPair = clamp(pairLiftPp / PAIR_LIFT_SCALE_PP, -PAIR_AFFINITY_CAP, PAIR_AFFINITY_CAP);
    const counter = clamp(counterLiftPp / COUNTER_LIFT_SCALE_PP, -COUNTER_AFFINITY_CAP, COUNTER_AFFINITY_CAP);
    const allyTrio = clamp(strongestTrioLiftPp / TRIO_LIFT_SCALE_PP, 0, TRIO_AFFINITY_CAP);
    const optionValue = interactionOptionValue(addedCreatureIds, rosterCreatureSet);
    return {
        allyPair,
        counter,
        allyTrio,
        optionValue,
        total: clamp(allyPair + counter + allyTrio + optionValue, -TOTAL_AFFINITY_CAP, TOTAL_AFFINITY_CAP),
    };
};

/** Conservative, dimensionless reward for one offered creature under fair draft information. */
export const rankedDraftInteractionBreakdown = (
    creatureId: number,
    context: IRankedDraftInteractionContext,
): IRankedDraftInteractionBreakdown => interactionBreakdown([creatureId], context);

export const rankedDraftInteractionAffinity = (creatureId: number, context: IRankedDraftInteractionContext): number =>
    rankedDraftInteractionBreakdown(creatureId, context).total;

/** Bundle-time version accounts for the two starters together without double-counting their co-play row. */
export const rankedDraftBundleInteractionAffinity = (
    creatureIds: readonly [number, number],
    context: IRankedDraftInteractionContext,
): number => interactionBreakdown(creatureIds, context).total;

/** Normalize only the offer's baseline, then make interaction evidence a bounded near-tie resolver. */
export function applyRankedDraftInteractionOverlay(
    baseScores: readonly number[],
    interactionAffinities: readonly number[],
): number[] {
    if (baseScores.length !== interactionAffinities.length) {
        throw new RangeError("Draft interaction base-score and affinity arrays must have the same length");
    }
    if (!baseScores.every(Number.isFinite) || !interactionAffinities.every(Number.isFinite)) {
        throw new TypeError("Draft interaction inputs must all be finite numbers");
    }
    if (!baseScores.length) return [];

    const scale = Math.max(1, ...baseScores.map((score) => Math.abs(score)));
    return baseScores.map(
        (baseScore, index) => baseScore / scale + interactionAffinities[index] * RANKED_DRAFT_INTERACTION_PRIOR_WEIGHT,
    );
}
