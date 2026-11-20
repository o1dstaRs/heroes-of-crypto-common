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
import type { ISetupAugmentChoice } from "./setup_ship";

/**
 * An army without a ranged creature gets nothing from Sniper: the upgrade only changes ranged attacks. The anchor
 * upgrade spend does not look at the army, so every seven-point seat bought Armor 3, Might 3 and Sniper 1, and a
 * melee army threw that last point away. Here the point goes to Movement instead.
 *
 * Read docs/shooterless_movement_adoption.md before changing the order: Armor 3 and Might 3 still come first.
 * One Movement level in place of the last Might or Armor level measured worse, and so did Placement.
 */
export { A19_SHOOTERLESS_MOVEMENT_POLICY } from "./a19_shooterless_setup_identity";

/** The order the rush plan and the research runner emit, so a bot applies the same purchases in the same order. */
const KINDS = ["Placement", "Movement", "Armor", "Might", "Sniper", "Empower"] as const;
const MOVEMENT_CAP = 2;
const PLACEMENT_CAP = 2;

/** No drafted creature attacks at range. An empty or unknown roster is not shooterless: nothing is assumed. */
export function isA19ShooterlessArmy(ownIds: readonly number[]): boolean {
    const units = [...new Set(ownIds)].map((id) => creatureInfo(id));
    return units.length > 0 && units.every((unit) => !!unit && !unit.ranged);
}

/**
 * The plan with its Sniper levels moved to Movement, and to Placement once Movement is full.
 *
 * Only a plan that buys neither Placement nor Movement is touched. That is the anchor spend; a funded delivery
 * plan or a rush plan carries its own formation, which checks the levels that were bought, and stays as it is.
 * An untouched plan is returned in its own order.
 */
export function a19ShooterlessAugments(
    plan: readonly ISetupAugmentChoice[],
    ownIds: readonly number[],
): ISetupAugmentChoice[] {
    const levels = Object.fromEntries(
        KINDS.map((kind) => [kind, plan.find((entry) => entry.kind === kind)?.value ?? 0]),
    ) as Record<(typeof KINDS)[number], number>;
    if (!levels.Sniper || levels.Placement || levels.Movement || !isA19ShooterlessArmy(ownIds))
        return plan.map((entry) => ({ ...entry }));
    levels.Movement = Math.min(MOVEMENT_CAP, levels.Sniper);
    levels.Placement = Math.min(PLACEMENT_CAP, levels.Sniper - levels.Movement);
    levels.Sniper = 0;
    return KINDS.filter((kind) => levels[kind] > 0).map((kind) => ({ kind, value: levels[kind] }));
}
