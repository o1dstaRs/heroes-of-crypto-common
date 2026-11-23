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

import { isA19DeliveryMelee } from "./a19_revealed_ranged_draft";
import { creatureInfo } from "./creature_score";

/**
 * a19-valkyrie-striker-v1 (owner, game b02a58ce, 2026-11-22: "weird it puts valkyrie at the backline"). Valkyrie casts
 * Wind Flow, an amplifiable buff, so the striker test (`isA19DeliveryMelee`) leaves it out and the striker-rush formation
 * kept a Valkyrie stack in its native back cell, out of reach on the first turn. The formation now moves a melee flyer
 * with no ranged attack and no ranged spell damage (Valkyrie) with the strikers; the formation itself and the rush
 * eligibility are unchanged. Confirmation P, which also put flyers in the middle rows, failed; this narrower rule is
 * the half that gained. See docs/valkyrie_striker_adoption.md.
 */
export const A19_VALKYRIE_STRIKER_POLICY = "a19-valkyrie-striker-v1" as const;

/** A stack the rush formation moves to the front: a striker, or a melee flyer without ranged attack or spell damage. */
export function isA19FormationStriker(creatureId: number): boolean {
    if (isA19DeliveryMelee(creatureId)) return true;
    const unit = creatureInfo(creatureId);
    return !!unit && unit.melee && unit.canFly && !unit.ranged && !unit.rangedSpellDamage;
}
