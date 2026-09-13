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

import strengthPriorJson from "./draft_strength_priors/ranked_unit_strength_a19_side_v1.json";

/**
 * Battle-fitted unit strength for the ranked draft: how much each creature moves the live a19 bot's win rate on
 * the side board (fit_ranked_draft_unit_strength over collect_ranked_draft_strength_data). The genome's intrinsic
 * score is a linear model over creature features and cannot express "this unit underperforms in our hands"; this
 * overlay adds that evidence without touching the genome's bytes.
 *
 * A policy id carries its weight, so every evaluated or shipped variant is immutable: the creature's normalized
 * draft score gains weight x conservative lift (percentage points / 100).
 */

interface IRawStrengthCreature {
    creatureId: number;
    name: string;
    level: number;
    support: number;
    liftPp: number;
    standardErrorPp: number;
    conservativeLiftPp: number;
}

interface IRawStrengthPrior {
    schemaVersion: number;
    id: string;
    source: {
        file: string;
        sha256: string;
        records: number;
        decisiveGames: number;
        boards: number;
        harnessCommit: string;
    };
    creatures: IRawStrengthCreature[];
}

export const RANKED_DRAFT_STRENGTH_PRIOR_ID = "ranked-unit-strength-a19-side-v1" as const;

export const RANKED_DRAFT_STRENGTH_POLICY_WEIGHTS = {
    "ranked-unit-strength-a19-side-v1-w1": 1,
    "ranked-unit-strength-a19-side-v1-w2": 2,
    "ranked-unit-strength-a19-side-v1-w4": 4,
} as const;

export type RankedDraftStrengthPolicyId = keyof typeof RANKED_DRAFT_STRENGTH_POLICY_WEIGHTS;

const PRIOR = strengthPriorJson as IRawStrengthPrior;
if (PRIOR.schemaVersion !== 1 || PRIOR.id !== RANKED_DRAFT_STRENGTH_PRIOR_ID) {
    throw new Error(
        `Unexpected ranked draft strength prior ${String(PRIOR.id)} (schema ${String(PRIOR.schemaVersion)})`,
    );
}

const CONSERVATIVE_LIFT_BY_CREATURE: ReadonlyMap<number, number> = new Map(
    PRIOR.creatures.map((creature) => [creature.creatureId, creature.conservativeLiftPp]),
);

export function isRankedDraftStrengthPolicy(value: unknown): value is RankedDraftStrengthPolicyId {
    return (
        typeof value === "string" && Object.prototype.hasOwnProperty.call(RANKED_DRAFT_STRENGTH_POLICY_WEIGHTS, value)
    );
}

export function rankedDraftStrengthPriorSource(): Readonly<IRawStrengthPrior["source"]> {
    return { ...PRIOR.source };
}

/** Conservative fitted lift in percentage points; creatures the fit never saw are neutral. */
export function rankedDraftStrengthLiftPp(creatureId: number): number {
    return CONSERVATIVE_LIFT_BY_CREATURE.get(creatureId) ?? 0;
}

/** Normalized draft-score contribution of one creature. Exactly 0 without a strength policy. */
export function rankedDraftStrengthScore(creatureId: number, policy: RankedDraftStrengthPolicyId | undefined): number {
    if (!isRankedDraftStrengthPolicy(policy)) return 0;
    return (RANKED_DRAFT_STRENGTH_POLICY_WEIGHTS[policy] * rankedDraftStrengthLiftPp(creatureId)) / 100;
}
