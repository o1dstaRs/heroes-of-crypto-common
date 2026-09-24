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

import { ToFactionName } from "../../factions/faction_type";
import type { SpecificSynergy } from "../../synergies/synergy_properties";
import { creatureInfo } from "./creature_score";

/** The four synergies a ranked game fields, one per faction, drawn from the game id (synergyVariantsForSeed). */
export type RankedDraftSynergyVariants = { readonly [factionName: string]: SpecificSynergy };

/**
 * What a faction's synergy is worth to the a19 bot under each live variant, in percentage points of win rate,
 * BEYOND what the v4 prior's creature lifts already credit (the v4 prior was fitted in a harness that always
 * fielded the default variants). Key `${factionName}:${variant}`; value = the residual at synergy levels 1, 2, 3.
 * An absent key is worth nothing, so an empty table drafts exactly like the policy without it.
 */
export const RANKED_DRAFT_SYNERGY_VARIANT_RESIDUAL_PP: Readonly<Record<string, readonly [number, number, number]>> = {};

/** The chance each remaining pick adds another creature of the faction being built (the v2 option-value rule). */
export const RANKED_DRAFT_SYNERGY_VARIANT_PICK_SUCCESS = 0.5;

const ARMY_SIZE = 6;
const MAX_LEVEL = 3;

const levelFor = (distinct: number): number => Math.min(Math.floor(distinct / 2), MAX_LEVEL);

/**
 * Residual value of adding one creature under the board's variants: reaching a synergy level earns that level's
 * increment; a pick that leaves the faction one creature short earns the next increment times the chance the
 * remaining picks complete it. Zero without variants, for creatures outside the four synergy factions, and for any
 * faction/variant the table does not list.
 */
export function rankedDraftSynergyVariantMarginalPp(
    creatureId: number,
    ownCreatureIds: readonly number[],
    variants: RankedDraftSynergyVariants | undefined,
    table: Readonly<Record<string, readonly [number, number, number]>> = RANKED_DRAFT_SYNERGY_VARIANT_RESIDUAL_PP,
): number {
    if (!variants) return 0;
    const faction = creatureInfo(creatureId)?.faction;
    if (!faction) return 0;
    const factionName = ToFactionName[faction];
    const variant = factionName ? variants[factionName] : undefined;
    const levels = variant === undefined ? undefined : table[`${factionName}:${variant}`];
    if (!levels) return 0;
    const roster = new Set(ownCreatureIds);
    if (roster.has(creatureId)) return 0;
    let sameFaction = 0;
    for (const ownCreatureId of roster) {
        if (creatureInfo(ownCreatureId)?.faction === faction) sameFaction += 1;
    }
    const valueAt = (level: number): number => (level <= 0 ? 0 : levels[Math.min(level, MAX_LEVEL) - 1]);
    const before = levelFor(sameFaction);
    const after = levelFor(sameFaction + 1);
    if (after > before) return valueAt(after) - valueAt(before);
    if (after >= MAX_LEVEL) return 0;
    const remainingPicks = Math.max(0, ARMY_SIZE - roster.size - 1);
    const completionChance = 1 - (1 - RANKED_DRAFT_SYNERGY_VARIANT_PICK_SUCCESS) ** remainingPicks;
    return completionChance * (valueAt(after + 1) - valueAt(after));
}
