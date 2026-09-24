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

import { creatureInfo } from "./creature_score";
import { rankedDraftSynergyVariantMarginalPp, type RankedDraftSynergyVariants } from "./draft_synergy_variants";
import strengthPriorJson from "./draft_strength_priors/ranked_unit_strength_a19_side_v1.json";
import strengthPriorV3Json from "./draft_strength_priors/ranked_unit_strength_a19_side_v3.json";
import strengthPriorV4Json from "./draft_strength_priors/ranked_unit_strength_a19_side_v4.json";
import unitSynergyPriorJson from "./draft_strength_priors/ranked_unit_synergy_a19_side_v2.json";

/**
 * Battle-fitted evidence for the ranked draft: how much a pick moves the live a19 bot's win rate on the side board.
 * The genome's intrinsic score is a linear model over creature features and cannot express "this unit
 * underperforms in our hands" or "this pick completes a synergy tier"; these overlays add that evidence without
 * touching the genome's bytes.
 *
 * - v1 (fit_ranked_draft_unit_strength): one map-independent lift per creature.
 * - v2 (fit_ranked_draft_unit_synergy): level-1/2 creatures map-independent, level-3/4 creatures per map (the live
 *   pick phase reveals the map right before the level-3 picks), plus the value of faction synergy tiers, and the
 *   faction-diversity tax relaxed so a tier-2 army is reachable.
 * - v3 (fit_ranked_draft_unit_strength, on-policy): the v1 model refitted on armies drafted by the shipped v1-w4
 *   policy with 50% exploration (PREREGISTRATION_V3_REFIT.md).
 *
 * A policy id carries its prior and weight, so every evaluated or shipped variant is immutable: a pick's normalized
 * draft score gains weight x (percentage points / 100).
 */

interface IRawSource {
    file: string;
    sha256: string;
    records: number;
    decisiveGames: number;
    boards: number;
    harnessCommit: string;
}

interface IRawEffect {
    liftPp: number;
    standardErrorPp: number;
    conservativeLiftPp: number;
}

interface IRawStrengthPrior {
    schemaVersion: number;
    id: string;
    source: IRawSource;
    creatures: (IRawEffect & { creatureId: number })[];
}

interface IRawUnitSynergyPrior {
    schemaVersion: number;
    id: string;
    source: IRawSource;
    synergyTiers: { tier1: IRawEffect; tier2: IRawEffect };
    creatures: (IRawEffect & { creatureId: number; gridType?: number })[];
}

export const RANKED_DRAFT_STRENGTH_PRIOR_ID = "ranked-unit-strength-a19-side-v1" as const;
export const RANKED_DRAFT_UNIT_SYNERGY_PRIOR_ID = "ranked-unit-synergy-a19-side-v2" as const;
export const RANKED_DRAFT_STRENGTH_V3_PRIOR_ID = "ranked-unit-strength-a19-side-v3" as const;
/**
 * v4: the v1 model refitted on current balance and current armies — both seats drafting with the shipped floor-4
 * policy (…-v1-w4-r4) at 50% exploration, common 6f67b22 (PREREGISTRATION_STRENGTH_V4.md in
 * docs/evidence/a19_live_program_20260921).
 */
export const RANKED_DRAFT_STRENGTH_V4_PRIOR_ID = "ranked-unit-strength-a19-side-v4" as const;

export const RANKED_DRAFT_STRENGTH_POLICY_WEIGHTS = {
    "ranked-unit-strength-a19-side-v1-w1": 1,
    "ranked-unit-strength-a19-side-v1-w2": 2,
    "ranked-unit-strength-a19-side-v1-w4": 4,
    "ranked-unit-strength-a19-side-v1-w6": 6,
    "ranked-unit-strength-a19-side-v1-w8": 8,
    "ranked-unit-strength-a19-side-v1-w12": 12,
    "ranked-unit-synergy-a19-side-v2-w1": 1,
    "ranked-unit-synergy-a19-side-v2-w2": 2,
    "ranked-unit-synergy-a19-side-v2-w4": 4,
    "ranked-unit-strength-a19-side-v3-w2": 2,
    "ranked-unit-strength-a19-side-v3-w4": 4,
    "ranked-unit-strength-a19-side-v3-w8": 8,
    // v1 strength at the staging weight plus a shooter floor (see RANKED_DRAFT_RANGED_FLOOR).
    "ranked-unit-strength-a19-side-v1-w4-r2": 4,
    "ranked-unit-strength-a19-side-v1-w4-r3": 4,
    "ranked-unit-strength-a19-side-v1-w4-r4": 4,
    // Floors 5 and 6, kept for the record: both realise ~3.14 shooters and r5 failed against r4. Not shipping.
    "ranked-unit-strength-a19-side-v1-w4-r5": 4,
    "ranked-unit-strength-a19-side-v1-w4-r6": 4,
    // v4 prior with r4's shooter floor, at r4's weight, twice it and four times it.
    "ranked-unit-strength-a19-side-v4-w4-r4": 4,
    "ranked-unit-strength-a19-side-v4-w8-r4": 8,
    "ranked-unit-strength-a19-side-v4-w16-r4": 16,
    // Same drafts as the two ids above, but the bundle pick scores Tier-1 artifacts with the
    // composition-corrected table (see TIER1_ARTIFACT_WINRATE_COMPOSITION_CORRECTED). Research-only.
    "ranked-unit-strength-a19-side-v4-w8-r4-t1": 8,
    "ranked-unit-strength-a19-side-v4-w16-r4-t1": 16,
    // The shipped v4-w16-r4 plus the live synergy variants' residual value (draft_synergy_variants.ts), once and
    // twice over. Research-only (P16); without variants in the context they draft exactly like v4-w16-r4.
    "ranked-unit-strength-a19-side-v4-w16-r4-sv": 16,
    "ranked-unit-strength-a19-side-v4-w16-r4-sv2": 16,
} as const;

export type RankedDraftStrengthPolicyId = keyof typeof RANKED_DRAFT_STRENGTH_POLICY_WEIGHTS;

/**
 * Shooter floor: the fewest natively ranged creatures a finished army must hold. Test-server replays (2026-09-21,
 * 27 decisive human-vs-AI fights) showed the bot fielding zero shooters in 22 and losing 16; on live draft rules the
 * staging policy v1-w4 still drafts zero or one shooter 72% of the time (mean 1.0) while humans bring 2-5. A floor
 * only ever narrows the eligible offers when the remaining picks could no longer reach it otherwise, so every pick
 * that is not forced keeps the exact policy order of the un-floored id.
 */
export const RANKED_DRAFT_RANGED_FLOOR: Partial<Record<RankedDraftStrengthPolicyId, number>> = {
    "ranked-unit-strength-a19-side-v1-w4-r2": 2,
    "ranked-unit-strength-a19-side-v1-w4-r3": 3,
    "ranked-unit-strength-a19-side-v1-w4-r4": 4,
    "ranked-unit-strength-a19-side-v1-w4-r5": 5,
    "ranked-unit-strength-a19-side-v1-w4-r6": 6,
    "ranked-unit-strength-a19-side-v4-w4-r4": 4,
    "ranked-unit-strength-a19-side-v4-w8-r4": 4,
    "ranked-unit-strength-a19-side-v4-w16-r4": 4,
    "ranked-unit-strength-a19-side-v4-w8-r4-t1": 4,
    "ranked-unit-strength-a19-side-v4-w16-r4-t1": 4,
    "ranked-unit-strength-a19-side-v4-w16-r4-sv": 4,
    "ranked-unit-strength-a19-side-v4-w16-r4-sv2": 4,
};

/** Shooter floor of a policy (0 = none). */
export function rankedDraftRangedFloor(policy: RankedDraftStrengthPolicyId | undefined): number {
    return isRankedDraftStrengthPolicy(policy) ? (RANKED_DRAFT_RANGED_FLOOR[policy] ?? 0) : 0;
}

/**
 * Apply a policy's shooter floor to one creature pick: when the army's ranged count plus every remaining pick after
 * this one could not reach the floor, keep only the ranged offers (if any exist). Otherwise the offers are returned
 * untouched, by reference.
 */
export function applyRankedDraftRangedFloor(
    policy: RankedDraftStrengthPolicyId | undefined,
    available: readonly number[],
    ownCreatureIds: readonly number[],
): readonly number[] {
    const floor = rankedDraftRangedFloor(policy);
    if (floor <= 0) return available;
    const isRanged = (creatureId: number): boolean => creatureInfo(creatureId)?.ranged === true;
    const ownRanged = ownCreatureIds.filter(isRanged).length;
    const picksAfterThis = Math.max(0, RANKED_DRAFT_ARMY_SIZE - ownCreatureIds.length - 1);
    if (ownRanged + picksAfterThis >= floor) return available;
    const ranged = available.filter(isRanged);
    return ranged.length ? ranged : available;
}

/** What a strength policy may read about the pick: the acting seat's roster and, once revealed, the map. */
export interface IDraftStrengthContext {
    ownCreatureIds: readonly number[];
    revealedGridType?: number;
    /** The game's four synergy variants, public from the first draft screen. Read only by the `-sv` policies. */
    synergyVariants?: RankedDraftSynergyVariants;
}

/** Synergy-variant multiplier of a `-sv` policy id (0 for every other policy). */
export function rankedDraftSynergyVariantScale(policy: RankedDraftStrengthPolicyId | undefined): number {
    if (!isRankedDraftStrengthPolicy(policy)) return 0;
    const match = /-sv(\d?)(?:-|$)/.exec(policy);
    return match ? Number(match[1] || 1) : 0;
}

/** A ranked army: two level-1, two level-2, one level-3 and one level-4 creature. */
export const RANKED_DRAFT_ARMY_SIZE = 6;
/** v2 option value: the chance each remaining pick adds another creature of the faction being built. */
export const RANKED_DRAFT_SYNERGY_PICK_SUCCESS = 0.5;
/** v2 starts the faction-diversity tax at the 5th same-faction creature, so a tier-2 army is reachable. */
export const RANKED_DRAFT_RELAXED_FACTION_TAX_FREE_STACKS = 3;

const V1 = strengthPriorJson as IRawStrengthPrior;
const V2 = unitSynergyPriorJson as IRawUnitSynergyPrior;
const V3 = strengthPriorV3Json as IRawStrengthPrior;
const V4 = strengthPriorV4Json as IRawStrengthPrior;
if (V1.schemaVersion !== 1 || V1.id !== RANKED_DRAFT_STRENGTH_PRIOR_ID) {
    throw new Error(`Unexpected ranked draft strength prior ${String(V1.id)} (schema ${String(V1.schemaVersion)})`);
}
if (V2.schemaVersion !== 2 || V2.id !== RANKED_DRAFT_UNIT_SYNERGY_PRIOR_ID) {
    throw new Error(`Unexpected ranked draft unit-synergy prior ${String(V2.id)} (schema ${String(V2.schemaVersion)})`);
}
if (V3.schemaVersion !== 1 || V3.id !== RANKED_DRAFT_STRENGTH_V3_PRIOR_ID) {
    throw new Error(`Unexpected ranked draft v3 strength prior ${String(V3.id)} (schema ${String(V3.schemaVersion)})`);
}
if (V4.schemaVersion !== 1 || V4.id !== RANKED_DRAFT_STRENGTH_V4_PRIOR_ID) {
    throw new Error(`Unexpected ranked draft v4 strength prior ${String(V4.id)} (schema ${String(V4.schemaVersion)})`);
}

const V1_LIFT: ReadonlyMap<number, number> = new Map(
    V1.creatures.map((creature) => [creature.creatureId, creature.conservativeLiftPp]),
);
const V3_LIFT: ReadonlyMap<number, number> = new Map(
    V3.creatures.map((creature) => [creature.creatureId, creature.conservativeLiftPp]),
);
const V4_LIFT: ReadonlyMap<number, number> = new Map(
    V4.creatures.map((creature) => [creature.creatureId, creature.conservativeLiftPp]),
);
const V2_GLOBAL_LIFT = new Map<number, number>();
const V2_MAP_LIFT = new Map<number, Map<number, number>>();
for (const creature of V2.creatures) {
    if (creature.gridType === undefined) {
        V2_GLOBAL_LIFT.set(creature.creatureId, creature.conservativeLiftPp);
    } else {
        const byMap = V2_MAP_LIFT.get(creature.creatureId) ?? new Map<number, number>();
        byMap.set(creature.gridType, creature.conservativeLiftPp);
        V2_MAP_LIFT.set(creature.creatureId, byMap);
    }
}
const V2_TIER1_PP = V2.synergyTiers.tier1.conservativeLiftPp;
const V2_TIER2_PP = V2.synergyTiers.tier2.conservativeLiftPp;

export function isRankedDraftStrengthPolicy(value: unknown): value is RankedDraftStrengthPolicyId {
    return (
        typeof value === "string" && Object.prototype.hasOwnProperty.call(RANKED_DRAFT_STRENGTH_POLICY_WEIGHTS, value)
    );
}

const isUnitSynergyPolicy = (policy: RankedDraftStrengthPolicyId): boolean =>
    policy.startsWith(`${RANKED_DRAFT_UNIT_SYNERGY_PRIOR_ID}-`);

const isV3StrengthPolicy = (policy: RankedDraftStrengthPolicyId): boolean =>
    policy.startsWith(`${RANKED_DRAFT_STRENGTH_V3_PRIOR_ID}-`);

const isV4StrengthPolicy = (policy: RankedDraftStrengthPolicyId): boolean =>
    policy.startsWith(`${RANKED_DRAFT_STRENGTH_V4_PRIOR_ID}-`);

export function rankedDraftStrengthPriorSource(): Readonly<IRawSource> {
    return { ...V1.source };
}

export function rankedDraftUnitSynergyPriorSource(): Readonly<IRawSource> {
    return { ...V2.source };
}

export function rankedDraftStrengthV3PriorSource(): Readonly<IRawSource> {
    return { ...V3.source };
}

export function rankedDraftStrengthV4PriorSource(): Readonly<IRawSource> {
    return { ...V4.source };
}

/** v1 conservative fitted lift in percentage points; creatures the fit never saw are neutral. */
export function rankedDraftStrengthLiftPp(creatureId: number): number {
    return V1_LIFT.get(creatureId) ?? 0;
}

/** v3 (on-policy refit) conservative fitted lift in percentage points; creatures the fit never saw are neutral. */
export function rankedDraftStrengthV3LiftPp(creatureId: number): number {
    return V3_LIFT.get(creatureId) ?? 0;
}

/** v4 (current balance, current armies) conservative fitted lift in percentage points; unseen creatures are neutral. */
export function rankedDraftStrengthV4LiftPp(creatureId: number): number {
    return V4_LIFT.get(creatureId) ?? 0;
}

/**
 * v2 conservative unit lift. A per-map creature uses the revealed map; before the reveal (or for a map the fit never
 * saw) it uses the average of its per-map lifts.
 */
export function rankedDraftUnitSynergyLiftPp(creatureId: number, revealedGridType?: number): number {
    const byMap = V2_MAP_LIFT.get(creatureId);
    if (!byMap) return V2_GLOBAL_LIFT.get(creatureId) ?? 0;
    const onMap = revealedGridType === undefined ? undefined : byMap.get(revealedGridType);
    if (onMap !== undefined) return onMap;
    const lifts = [...byMap.values()];
    return lifts.reduce((sum, lift) => sum + lift, 0) / lifts.length;
}

/**
 * v2 synergy value of adding a creature to the roster, in percentage points. Tiers count DISTINCT creatures of a
 * faction (2 -> tier 1, 4 -> tier 2). Reaching a tier earns its value; the pick before a tier earns the next tier's
 * value times the chance the remaining picks complete it.
 */
export function rankedDraftSynergyMarginalPp(creatureId: number, ownCreatureIds: readonly number[]): number {
    const faction = creatureInfo(creatureId)?.faction ?? 0;
    const roster = new Set(ownCreatureIds);
    if (!faction || roster.has(creatureId)) return 0;
    let sameFaction = 0;
    for (const ownCreatureId of roster) {
        if (creatureInfo(ownCreatureId)?.faction === faction) sameFaction += 1;
    }
    const remainingPicks = Math.max(0, RANKED_DRAFT_ARMY_SIZE - roster.size - 1);
    const completionChance = 1 - (1 - RANKED_DRAFT_SYNERGY_PICK_SUCCESS) ** remainingPicks;
    switch (sameFaction) {
        case 0:
            return completionChance * V2_TIER1_PP;
        case 1:
            return V2_TIER1_PP;
        case 2:
            return completionChance * V2_TIER2_PP;
        case 3:
            return V2_TIER2_PP;
        default:
            return 0;
    }
}

/** Normalized draft-score contribution of one pick. Exactly 0 without a strength policy. */
export function rankedDraftStrengthScore(
    creatureId: number,
    policy: RankedDraftStrengthPolicyId | undefined,
    context?: IDraftStrengthContext,
): number {
    if (!isRankedDraftStrengthPolicy(policy)) return 0;
    const weight = RANKED_DRAFT_STRENGTH_POLICY_WEIGHTS[policy];
    if (isV3StrengthPolicy(policy)) {
        return (weight * rankedDraftStrengthV3LiftPp(creatureId)) / 100;
    }
    if (isV4StrengthPolicy(policy)) {
        const variantScale = rankedDraftSynergyVariantScale(policy);
        const synergyPp =
            variantScale && context
                ? variantScale *
                  rankedDraftSynergyVariantMarginalPp(creatureId, context.ownCreatureIds, context.synergyVariants)
                : 0;
        return (weight * (rankedDraftStrengthV4LiftPp(creatureId) + synergyPp)) / 100;
    }
    if (!isUnitSynergyPolicy(policy)) {
        return (weight * rankedDraftStrengthLiftPp(creatureId)) / 100;
    }
    const unitPp = rankedDraftUnitSynergyLiftPp(creatureId, context?.revealedGridType);
    const synergyPp = context ? rankedDraftSynergyMarginalPp(creatureId, context.ownCreatureIds) : 0;
    return (weight * (unitPp + synergyPp)) / 100;
}

/** Policy ids that score Tier-1 artifacts with the composition-corrected table at bundle time. */
export function rankedDraftUsesCorrectedTier1Table(policy: RankedDraftStrengthPolicyId | undefined): boolean {
    return isRankedDraftStrengthPolicy(policy) && policy.endsWith("-t1");
}

/** Whether a policy moves the faction-diversity tax to the 5th same-faction creature. */
export function rankedDraftStrengthRelaxesFactionTax(policy: RankedDraftStrengthPolicyId | undefined): boolean {
    return isRankedDraftStrengthPolicy(policy) && isUnitSynergyPolicy(policy);
}
