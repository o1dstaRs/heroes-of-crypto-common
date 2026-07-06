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

import { scoreCreatureWeighted } from "../ai/setup/creature_score";
import { PBTypes } from "../generated/protobuf/v1/types";
import { creaturesByLevel, makeRng, type IArmyUnitSpec, type IRosterComposition } from "./army";

/**
 * DRAFTED roster construction for self-play draft training. Instead of `buildRoster`'s uniform-random pick,
 * each level slot is filled by a weighted DRAFT POLICY choosing from an OFFERED SUBSET of the level pool —
 * mirroring the real pick phase (you pick the best of a few offered creatures, not the whole pool). Both
 * sides of a cemDraft game are offered the SAME subset (shared offerSeed), so the outcome isolates which
 * policy picks the better army from identical choices. Deterministic given (weights, offerSeed).
 */

const creatureEnum = PBTypes.CreatureVals as unknown as Record<string, number>;
/** Map a roster creatureName to its CreatureVals enum id (0 if unknown). Shared with the synergy application. */
export const creatureIdForName = (name: string): number => creatureEnum[name.toUpperCase().replace(/ /g, "_")] ?? 0;
const idForName = creatureIdForName;

/** Number of creatures offered per level slot-group (the "reveal" size). Capped by the pool. */
const DEFAULT_OFFER_K = 6;

/** A seeded partial shuffle: return `k` distinct entries of `arr` (Fisher–Yates prefix). */
function sample<T>(arr: readonly T[], k: number, rng: () => number): T[] {
    const a = arr.slice();
    const n = Math.min(k, a.length);
    for (let i = 0; i < n; i += 1) {
        const j = i + Math.floor(rng() * (a.length - i));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a.slice(0, n);
}

/**
 * Build a roster by drafting with `weights`. For each composition level: reveal an offered subset (seeded so
 * both sides share it), rank it by the weighted creature score, and take the top-`count` DISTINCT creatures
 * (falling back to repeats only if the offer is smaller than `count`).
 */
export function draftRoster(
    weights: readonly number[],
    offerSeed: number,
    composition: readonly IRosterComposition[],
    amountByLevel: Readonly<Record<number, number>>,
    offerK: number = DEFAULT_OFFER_K,
): IArmyUnitSpec[] {
    const roster: IArmyUnitSpec[] = [];
    const rng = makeRng(offerSeed);
    for (const { level, count } of composition) {
        const pool = creaturesByLevel(level);
        if (!pool.length) {
            throw new Error(`No creatures found for level ${level}`);
        }
        // Draw the same offered subset both sides will see; give it room for `count` distinct picks.
        const offer = sample(pool, Math.max(offerK, count), rng);
        const ranked = offer
            .map((e) => ({ e, s: scoreCreatureWeighted(idForName(e.creatureName), weights) }))
            .sort((x, y) => y.s - x.s);
        for (let i = 0; i < count; i += 1) {
            const pick = ranked[i % ranked.length].e;
            roster.push({
                faction: pick.faction,
                creatureName: pick.creatureName,
                level: pick.level,
                size: pick.size,
                amount: amountByLevel[level] ?? 1,
            });
        }
    }
    return roster;
}
